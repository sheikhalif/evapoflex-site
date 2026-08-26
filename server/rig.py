"""Live rig state: one camera feed, one tracker, many viewers.

The phone pushes JPEG frames into `ingest_frame`. Each frame is tracked
synchronously (HSV threshold on a ~960px image is well under a millisecond of
budget at 10fps) and then fanned out to browser subscribers.

Two things are deliberately kept apart:

  * the tracker runs whenever the feed is up, so the dashboard always has live
    numbers - "how it has been running" should not require anyone to have
    remembered to press Record;
  * a *run* is an explicit recording window that persists samples and, on stop,
    writes the same CSV + summary.json + master plot the offline tracker emits,
    so a live run and an offline run are interchangeable downstream.

Slow viewers get frames dropped rather than backpressuring the feed. A phone on
hotel wifi must never stall because someone opened the dashboard on a laggy
laptop.
"""

import asyncio
import csv
import json
import os
import time

import cv2
import numpy as np

import trackers
from tracker import fmt_runtime, metrics_from_records
import store

# A viewer that falls this far behind loses frames instead of the rig stalling
VIEWER_QUEUE_MAX = 3
# Frames kept for algorithm authoring. Enough to show a model how the wheel
# moves; small enough that a 24/7 feed never grows memory.
RECENT_FRAMES = 40
# Long-run RPM history for the public page: one sample a minute, 3 hours.
HISTORY_INTERVAL_S = 60.0
HISTORY_WINDOW_S = 3 * 60 * 60
SAMPLE_FLUSH_INTERVAL_S = 5.0
SAMPLE_FLUSH_COUNT = 60
FEED_TIMEOUT_S = 12.0     # no frame for this long => feed considered down
STATS_INTERVAL_S = 0.5    # how often stats are pushed to viewers


class Subscriber:
    """One dashboard connection."""

    def __init__(self, want_video: bool = True):
        self.queue: asyncio.Queue = asyncio.Queue(maxsize=VIEWER_QUEUE_MAX)
        self.want_video = want_video
        self.dropped = 0

    def offer(self, message) -> None:
        """Non-blocking put; drops the oldest item when the viewer lags."""
        try:
            self.queue.put_nowait(message)
        except asyncio.QueueFull:
            try:
                self.queue.get_nowait()
                self.dropped += 1
                self.queue.put_nowait(message)
            except (asyncio.QueueEmpty, asyncio.QueueFull):
                pass


class Rig:
    def __init__(self, db, runs_dir: str, tools_dir: str | None = None):
        self.db = db
        self.runs_dir = runs_dir
        self.tools_dir = tools_dir
        self._wv = None          # cached wheel_tracker_video module
        os.makedirs(runs_dir, exist_ok=True)

        calibration = store.get_setting(db, "calibration") or {}
        name = store.get_setting(db, "tracker") or trackers.default_name()
        try:
            cls = trackers.get(name)
        except KeyError:
            # The selected algorithm was renamed or deleted between restarts.
            # Falling back beats refusing to start - an unattended rig that
            # will not come up is worse than one running the default.
            print(f"[rig] tracker {name!r} unavailable, using default",
                  flush=True)
            cls = trackers.get(trackers.default_name())
        self.tracker_name = cls.NAME
        self.tracker = cls(calibration)

        self.subscribers: set[Subscriber] = set()
        self.lock = asyncio.Lock()

        # Feed health
        self.feed_connected = False
        self.feed_source = None
        self.last_frame_at = 0.0
        self.first_frame_at = 0.0
        self.frame_count = 0
        self.resolution = None
        self._fps_window: list[float] = []
        self._proc_ms: list[float] = []
        self._last_stats_push = 0.0
        self.last_frame_jpeg: bytes | None = None
        self.last_overlay: dict = {}
        self._recent: list[bytes] = []   # ring buffer for algorithm authoring
        self._history: list[tuple[float, float | None]] = []
        self._history_at = 0.0

        # Recording state
        self.run_id: int | None = None
        self.run_key: str | None = None
        self.run_label: str | None = None
        self.run_started_at: float | None = None
        self.run_t0: float | None = None
        self.run_started_by: str | None = None
        self._pending_samples: list[tuple] = []
        self._last_flush = 0.0
        self._run_records: list[list] = []   # full-resolution, for the summary

        # Maintenance pause
        self.paused = False
        self.pause_reason = ""
        self.pause_started_at: float | None = None
        self.pause_started_by: str | None = None
        self.pauses: list[dict] = []

        # Backfill: the phone replaying frames it buffered while offline
        self.backfilling = False
        self.backfill_seen = 0
        self.backfill_expected = 0
        self.backfill_dropped = 0
        self.last_outage_s = 0.0
        # Round-trip latency the phone measured against its own clock.
        self.latency_ms = None

        # Lifetime counters, restored across restarts
        totals = store.get_setting(db, "totals") or {}
        self.total_tracked_s = float(totals.get("tracked_s", 0.0))
        self.total_revolutions = float(totals.get("revolutions", 0.0))
        self.total_runs = int(totals.get("runs", 0))

    # ------------------------------------------------------------------
    # Feed
    # ------------------------------------------------------------------
    def feed_up(self) -> bool:
        return (self.feed_connected
                and (time.time() - self.last_frame_at) < FEED_TIMEOUT_S)

    def on_feed_open(self, source: str) -> None:
        was_down_since = self.last_frame_at
        self.feed_connected = True
        self.feed_source = source
        self.frame_count = 0
        self._fps_window.clear()

        if self.run_id is None:
            # No run in flight: a reconnect is just a fresh session.
            self.first_frame_at = 0.0
            self.tracker.reset()
            return

        # A run IS recording. Keep its cumulative rotation, its samples and
        # its metrics - only the marker lock is stale. The phone replays what
        # it buffered while offline, so the gap is usually closed by backfill
        # and no exclusion is needed; anything it could not buffer is marked
        # when the backfill reports its shortfall.
        self.tracker.soft_reset()
        if was_down_since:
            self.last_outage_s = max(time.time() - was_down_since, 0.0)
        print(f"[rig] camera reconnected mid-run ({self.run_key}); "
              f"offline for {self.last_outage_s:.0f}s", flush=True)

    def on_feed_close(self) -> None:
        self.feed_connected = False
        self.last_frame_jpeg = None
        # NOT cleared here: the RPM history is the record of how the wheel has
        # behaved over the last three hours, and a camera dropping out for
        # thirty seconds does not erase that. The sample buffer likewise
        # survives, so an operator can still author against the last frames the
        # camera managed to send.
        if self.run_id is not None:
            print(f"[rig] camera lost while recording {self.run_key}; "
                  f"{len(self._pending_samples)} samples buffered", flush=True)

    def track_frame(self, jpeg: bytes, client_t: float | None) -> dict:
        """Decode and track one frame. Returns the overlay dict.

        Runs on a worker thread (JPEG decode plus the HSV pass is the only real
        CPU in the pipeline), so it must touch neither SQLite nor asyncio.
        Persisting samples and fanning out to viewers are the event loop's job
        - see flush_if_due() and publish(). An earlier version wrote samples
        from here and a transient 'database is locked' killed the phone's
        socket mid-run, taking the recording with it.
        """
        arr = np.frombuffer(jpeg, dtype=np.uint8)
        frame = cv2.imdecode(arr, cv2.IMREAD_COLOR)
        if frame is None:
            return {"locked": False, "error": "undecodable frame"}

        now = time.time()
        if not self.first_frame_at:
            self.first_frame_at = now
        # Prefer the phone's own capture clock: network jitter on the way here
        # would otherwise show up as fake angular acceleration.
        t = client_t if client_t is not None else (now - self.first_frame_at)

        self.last_frame_at = now
        self.frame_count += 1
        self.resolution = f"{frame.shape[1]}x{frame.shape[0]}"
        self._fps_window.append(now)
        cutoff = now - 5.0
        while self._fps_window and self._fps_window[0] < cutoff:
            self._fps_window.pop(0)

        self.last_frame_jpeg = jpeg
        self._recent.append(jpeg)
        if len(self._recent) > RECENT_FRAMES:
            self._recent.pop(0)
        if self.paused:
            # Keep the picture flowing so the operator can see the rig they
            # are working on, but measure nothing.
            overlay = {"locked": False, "paused": True,
                       "frame_num": self.tracker.frame_num}
            self.last_overlay = overlay
            return overlay

        if self.backfilling:
            self.backfill_seen += 1

        overlay = self.tracker.process(frame, t)
        self.last_overlay = overlay

        if self.run_id is not None and overlay.get("locked"):
            if self.run_t0 is None:
                self.run_t0 = t
            rel_t = t - self.run_t0
            row = (rel_t, overlay["angle"], overlay["unwrapped"],
                   overlay["frame_num"])
            self._pending_samples.append(row)
            self._run_records.append(list(row))

        return overlay

    def flush_if_due(self) -> None:
        """Persist buffered samples. Call from the event loop thread only.

        A failed write is logged and the buffer kept, so the samples land on
        the next attempt rather than being lost - and, more importantly, a
        database hiccup never propagates back into the phone's connection.
        """
        if self.run_id is None or not self._pending_samples:
            return
        now = time.time()
        if (len(self._pending_samples) < SAMPLE_FLUSH_COUNT
                and now - self._last_flush < SAMPLE_FLUSH_INTERVAL_S):
            return
        self._flush_samples()

    # ------------------------------------------------------------------
    # Maintenance pause
    # ------------------------------------------------------------------
    def pause(self, reason: str, username: str) -> dict:
        """Stop measuring without ending the run.

        The video keeps flowing - you need to see what you are doing while
        working on the rig - but nothing is tracked or recorded. Turning the
        wheel by hand during a pause therefore cannot enter the results.
        """
        if self.run_id is None:
            raise ValueError("no run is recording")
        if self.paused:
            raise ValueError("already paused")
        self.paused = True
        self.pause_reason = reason or "maintenance"
        self.pause_started_at = time.time()
        self.pause_started_by = username
        # Persist what we have now: a pause is often followed by someone
        # unplugging something.
        self._flush_samples()
        return {"paused_at": self.pause_started_at, "reason": self.pause_reason}

    def resume(self, username: str) -> dict:
        if not self.paused:
            raise ValueError("not paused")
        elapsed = time.time() - (self.pause_started_at or time.time())
        self.pauses.append({
            "start": self.pause_started_at, "end": time.time(),
            "seconds": round(elapsed, 1), "reason": self.pause_reason,
            "by": self.pause_started_by,
        })
        # The wheel may have been moved by hand; re-acquire rather than
        # extrapolating from a velocity measured before the pause.
        self.tracker.soft_reset()
        self.tracker.metrics.mark_gap("pause", self.pause_reason)
        self.paused = False
        self.pause_started_at = None
        self.pause_reason = ""
        self.pause_started_by = None
        return {"resumed_by": username, "paused_for_s": round(elapsed, 1)}

    def paused_total_s(self) -> float:
        total = sum(p["seconds"] for p in self.pauses)
        if self.paused and self.pause_started_at:
            total += time.time() - self.pause_started_at
        return total

    # ------------------------------------------------------------------
    # Backfill
    # ------------------------------------------------------------------
    def begin_backfill(self, expected: int, dropped: int) -> None:
        """The phone is about to replay frames buffered during an outage."""
        self.backfilling = True
        self.backfill_seen = 0
        self.backfill_expected = max(int(expected), 0)
        self.backfill_dropped = max(int(dropped), 0)
        if self.run_id is not None and self.backfill_dropped:
            # The phone's buffer overflowed, so part of the outage is simply
            # unknown. Say so in the data rather than unwrapping across it and
            # inventing rotation that may never have happened.
            self.tracker.soft_reset()
            self.tracker.metrics.mark_gap(
                "data_loss",
                f"{self.backfill_dropped} frames exceeded the phone's buffer")
        print(f"[rig] backfill starting: {self.backfill_expected} frames"
              + (f", {self.backfill_dropped} lost to buffer cap"
                 if self.backfill_dropped else ""), flush=True)

    def end_backfill(self) -> dict:
        result = {"replayed": self.backfill_seen,
                  "dropped": self.backfill_dropped}
        self.backfilling = False
        self.backfill_expected = 0
        # Re-acquire: the last backfilled frame may be seconds old.
        self.tracker.soft_reset()
        print(f"[rig] backfill complete: {result}", flush=True)
        return result

    def _flush_samples(self) -> None:
        if self.run_id is None or not self._pending_samples:
            return
        batch = list(self._pending_samples)
        try:
            store.append_samples(self.db, self.run_id, batch)
        except Exception as exc:                       # noqa: BLE001
            print(f"[rig] sample flush deferred ({len(batch)} rows): {exc}",
                  flush=True)
            return
        del self._pending_samples[:len(batch)]
        self._last_flush = time.time()

    def note_history(self) -> None:
        """Sample the current RPM into the long-run history, once a minute.

        The public page shows the last three hours, which at one point a minute
        is 180 numbers - small enough to send whole on every page load, long
        enough that a visitor sees the wheel's behaviour rather than a
        twitching instantaneous readout.
        """
        now = time.time()
        if now - self._history_at < HISTORY_INTERVAL_S:
            return
        self._history_at = now
        rpm = self.tracker.metrics.current_rpm()
        self._history.append((now, round(rpm, 4) if rpm is not None else None))
        cutoff = now - HISTORY_WINDOW_S
        while self._history and self._history[0][0] < cutoff:
            self._history.pop(0)

    def history(self) -> list[dict]:
        return [{"t": round(t), "rpm": v} for t, v in self._history]

    def recent_frames(self) -> list[bytes]:
        """The last few frames seen, for algorithm authoring.

        A short ring buffer rather than a growing list: this exists so Claude
        can be shown what the camera sees, not to archive the feed. Holding
        more than a handful of JPEGs of a 24/7 stream is memory spent on
        something nothing reads.
        """
        return list(self._recent)

    def publish(self, jpeg: bytes, overlay: dict) -> None:
        """Fan out to dashboard subscribers. Event loop thread only.

        asyncio.Queue is not thread-safe, so this cannot move back into
        track_frame however tempting the single-call-site is.
        """
        self._fanout(jpeg, overlay, time.time())

    def _fanout(self, jpeg: bytes, overlay: dict, now: float) -> None:
        push_stats = (now - self._last_stats_push) >= STATS_INTERVAL_S
        if push_stats:
            self._last_stats_push = now
            stats = self.status()
        # A backfill arrives as fast as the phone can upload; forwarding all of
        # it would swamp dashboards with minutes-old video. Show a sample so
        # the catch-up is visible, and let the stats carry the progress.
        send_video = not self.backfilling or (self.backfill_seen % 20 == 0)
        for sub in list(self.subscribers):
            if sub.want_video and send_video:
                sub.offer(("frame", overlay, jpeg))
            if push_stats:
                sub.offer(("stats", stats, None))

    # ------------------------------------------------------------------
    # Status
    # ------------------------------------------------------------------
    def note_processing(self, ms: float) -> None:
        """Record how long the tracker took on one frame.

        Watched because the whole point of tracking the live feed is that the
        numbers describe now. If processing ever approaches the frame interval
        the pipeline is the bottleneck and the readings start lagging reality.
        """
        self._proc_ms.append(ms)
        if len(self._proc_ms) > 60:
            self._proc_ms.pop(0)

    def proc_ms(self) -> float:
        return round(sum(self._proc_ms) / len(self._proc_ms), 1) if self._proc_ms else 0.0

    def fps(self) -> float:
        if len(self._fps_window) < 2:
            return 0.0
        span = self._fps_window[-1] - self._fps_window[0]
        return round((len(self._fps_window) - 1) / span, 1) if span > 0 else 0.0

    def status(self) -> dict:
        m = self.tracker.metrics.snapshot()
        up = self.feed_up()
        now = time.time()
        return {
            "feed": {
                "up": up,
                "source": self.feed_source,
                "fps": self.fps(),
                "resolution": self.resolution,
                "frames": self.frame_count,
                "age_s": (round(now - self.last_frame_at, 1)
                          if self.last_frame_at else None),
                "uptime": (fmt_runtime(now - self.first_frame_at)
                           if self.first_frame_at and up else "—"),
                "viewers": len(self.subscribers),
                "proc_ms": self.proc_ms(),
                "latency_ms": self.latency_ms,
            },
            "tracking": {
                "locked": bool(self.last_overlay.get("locked")),
                "lock_quality": self.tracker.lock_quality(),
                "seen": self.tracker.seen,
                "missed": self.tracker.missed,
                "unmatched": self.tracker.unmatched,
                "angle": self.last_overlay.get("angle"),
                "marker": self.last_overlay.get("marker"),
                "blobs": self.last_overlay.get("blobs", 0),
                "n_markers": self.last_overlay.get("n_markers", 0),
                "spare_markers": self.last_overlay.get("spare_markers", 0),
                "inliers": self.last_overlay.get("inliers", 0),
                "hub_source": self.last_overlay.get("hub_source"),
                "fixtures": len(self.last_overlay.get("static", []) or []),
            },
            "metrics": m,
            "run": {
                "active": self.run_id is not None,
                "key": self.run_key,
                "label": self.run_label,
                "started_at": self.run_started_at,
                "elapsed": (fmt_runtime(now - self.run_started_at
                                        - self.paused_total_s())
                            if self.run_started_at else None),
                "samples": len(self._run_records),
                "unsaved": len(self._pending_samples),
                "started_by": self.run_started_by,
                "paused": self.paused,
                "pause_reason": self.pause_reason,
                "paused_for": (fmt_runtime(now - self.pause_started_at)
                               if self.paused and self.pause_started_at
                               else None),
                "paused_by": self.pause_started_by,
                "pause_count": len(self.pauses),
                "paused_total": fmt_runtime(self.paused_total_s()),
            },
            "backfill": {
                "active": self.backfilling,
                "seen": self.backfill_seen,
                "expected": self.backfill_expected,
                "dropped": self.backfill_dropped,
                "last_outage": (fmt_runtime(self.last_outage_s)
                                if self.last_outage_s else None),
            },
            "totals": {
                "tracked": fmt_runtime(self.total_tracked_s),
                "revolutions": round(self.total_revolutions, 2),
                "runs": self.total_runs,
            },
            "calibration": self.tracker.calibration,
            "server_time": now,
        }

    # ------------------------------------------------------------------
    # Calibration
    # ------------------------------------------------------------------
    def update_calibration(self, patch: dict) -> dict:
        allowed = {"hsv_lo", "hsv_hi", "center", "radius", "band_frac",
                   "min_area_frac", "max_area_frac", "auto_hub",
                   "merge_tol_deg", "match_tol_deg", "max_step_deg"}
        clean = {k: v for k, v in patch.items() if k in allowed}
        self.tracker.set_calibration(clean)
        store.set_setting(self.db, "calibration", self.tracker.calibration)
        # Geometry or colour changed, so the constellation we matched against
        # may no longer mean the same thing - drop it and re-acquire.
        self.tracker.soft_reset()
        return self.tracker.calibration

    def set_tracker(self, name: str, force: bool = False) -> dict:
        """Switch algorithm, carrying the run's accumulated rotation across.

        Refused mid-recording unless forced. A run whose samples came from two
        algorithms is not comparable with either, and the summary has one
        `tracker` field - so the result would look authoritative while being
        silently a hybrid. Forcing is allowed, but it stops the run first so
        each recording has exactly one algorithm behind it.
        """
        cls = trackers.get(name)                    # raises KeyError if absent
        stopped = None
        if self.run_id is not None:
            if not force:
                raise ValueError(
                    f"a run is recording; switching to {name!r} would make its "
                    f"samples a mix of two algorithms. Stop the run first, or "
                    f"pass force to stop it automatically.")
            stopped = self.run_key

        if cls.NAME == self.tracker_name and type(self.tracker) is cls:
            return {"tracker": self.tracker_name, "changed": False,
                    "stopped_run": None}

        replacement = cls(self.tracker.calibration)
        self.tracker.carry_state_to(replacement)
        # The new algorithm has no previous frame and has learned nothing about
        # the scene, so the first sample after the swap must not be read as a
        # step across the changeover.
        self.tracker.metrics.mark_gap("tracker", f"switched to {cls.NAME}")
        self.tracker = replacement
        self.tracker_name = cls.NAME
        store.set_setting(self.db, "tracker", cls.NAME)
        return {"tracker": cls.NAME, "changed": True, "stopped_run": stopped}

    def tracker_info(self) -> dict:
        cls = type(self.tracker)
        return {"current": self.tracker_name,
                "hash": cls.source_hash(),
                "available": trackers.describe_all(),
                "errors": trackers.last_errors()}

    def reload_trackers(self) -> dict:
        """Re-import every algorithm from disk and re-instantiate the live one.

        Editing a tracker file and calling this swaps the running code without
        dropping the feed or the run's accumulated rotation.
        """
        result = trackers.reload()
        try:
            cls = trackers.get(self.tracker_name)
        except KeyError:
            cls = trackers.get(trackers.default_name())
            result["fell_back_to"] = cls.NAME
        replacement = cls(self.tracker.calibration)
        self.tracker.carry_state_to(replacement)
        if self.run_id is not None:
            self.tracker.metrics.mark_gap("tracker", "code reloaded")
        self.tracker = replacement
        self.tracker_name = cls.NAME
        result["current"] = cls.NAME
        result["hash"] = cls.source_hash()
        return result

    def reset_calibration(self) -> dict:
        """Restore the built-in defaults for the current rig.

        Stored calibration deliberately wins over defaults, which means a
        setting captured for an old marker scheme silently survives a change of
        rig. This is the escape hatch.
        """
        # Defaults belong to the algorithm, not to the rig: each tracker
        # declares the marker scheme it expects.
        self.tracker.calibration = dict(type(self.tracker).DEFAULT_CALIBRATION)
        store.set_setting(self.db, "calibration", self.tracker.calibration)
        self.tracker.soft_reset()
        return self.tracker.calibration

    def auto_calibrate(self) -> dict | None:
        result = self.tracker.auto_calibrate()
        if result:
            self.update_calibration({"center": result["center"],
                                     "radius": result["radius"]})
        return result

    def sample_marker_color(self, x: float, y: float) -> dict:
        if self.last_frame_jpeg is None:
            return {}
        arr = np.frombuffer(self.last_frame_jpeg, dtype=np.uint8)
        frame = cv2.imdecode(arr, cv2.IMREAD_COLOR)
        if frame is None:
            return {}
        result = self.tracker.sample_hsv(frame, x, y)
        if result:
            self.update_calibration({"hsv_lo": result["hsv_lo"],
                                     "hsv_hi": result["hsv_hi"]})
        return result

    # ------------------------------------------------------------------
    # Runs
    # ------------------------------------------------------------------
    def start_run(self, design: str, test_n: int | None, label: str,
                  username: str) -> dict:
        if self.run_id is not None:
            raise ValueError("a run is already recording")
        if test_n is None:
            test_n = self._next_test_number(design)
        date_iso = time.strftime("%Y-%m-%d")
        run_key = f"{design}_Test_{test_n}_{date_iso}"
        if store.get_run(self.db, run_key):
            run_key = f"{run_key}_{int(time.time()) % 100000}"

        self._run_records = []
        self._pending_samples = []
        self.run_t0 = None
        self.pauses = []
        self.paused = False
        self.pause_started_at = None
        # A run measures its own window, so metrics restart even though the
        # feed and the marker lock carry on uninterrupted.
        self.tracker.metrics = type(self.tracker.metrics)()
        self.run_id = store.start_run(
            self.db, run_key, design, test_n, label,
            self.tracker.calibration, username)
        self.run_key = run_key
        self.run_label = label
        self.run_started_at = time.time()
        self.run_started_by = username
        return {"run_key": run_key, "run_id": self.run_id,
                "design": design, "test": test_n}

    def _next_test_number(self, design: str) -> int:
        row = self.db.execute(
            "SELECT MAX(test_n) AS m FROM runs WHERE design = ?",
            (design,)).fetchone()
        return (row["m"] or 0) + 1

    async def stop_run(self) -> dict:
        """Close the run, write its artefacts and return the summary.

        Async because rendering the master plot costs seconds of matplotlib -
        long enough that doing it inline froze the event loop, stalling the
        phone's uplink and every dashboard until it finished. Only the render
        moves to a thread; the SQLite writes stay on the loop.
        """
        if self.run_id is None:
            raise ValueError("no run is recording")
        self._flush_samples()
        run_id, run_key = self.run_id, self.run_key
        records = self._run_records
        design = self.db.execute("SELECT design, test_n FROM runs WHERE id = ?",
                                 (run_id,)).fetchone()

        summary = self._build_summary(run_key, design["design"],
                                      design["test_n"], records)
        asset_dir = os.path.join(self.runs_dir, run_key)
        if records:
            os.makedirs(asset_dir, exist_ok=True)
            self._write_csv(asset_dir, run_key, records)
            await asyncio.to_thread(
                self._write_plot, asset_dir, run_key, design["design"],
                design["test_n"], records, summary)
            with open(os.path.join(asset_dir, f"{run_key}_summary.json"),
                      "w") as f:
                json.dump(summary, f, indent=2)
        else:
            asset_dir = None

        store.finish_run(self.db, run_id, summary, asset_dir)

        self.total_runs += 1
        self.total_tracked_s += summary["duration_s"]
        self.total_revolutions += abs(summary["metrics"].get("revolutions", 0))
        store.set_setting(self.db, "totals", {
            "tracked_s": self.total_tracked_s,
            "revolutions": self.total_revolutions,
            "runs": self.total_runs,
        })

        self.run_id = None
        self.run_key = None
        self.run_label = None
        self.run_started_at = None
        self.run_started_by = None
        self.run_t0 = None
        self._run_records = []
        return summary

    def _build_summary(self, run_key, design, test_n, records,
                       metrics=None) -> dict:
        m = metrics or self.tracker.metrics.snapshot()
        duration = records[-1][0] - records[0][0] if len(records) > 1 else 0.0
        return {
            "id": run_key,
            "design": design,
            "test": test_n,
            "date_iso": time.strftime("%Y-%m-%d"),
            "date_pretty": time.strftime("%b %-d, %Y"),
            "video": "live feed",
            "source": "live",
            "fps": self.fps(),
            "duration_s": round(duration, 2),
            "frames": self.frame_count,
            "records": len(records),
            # Which code produced these numbers. The hash matters because the
            # algorithm can be edited and reloaded while runs are in progress,
            # so the name alone does not identify a version.
            "tracker": f"live-{self.tracker_name}",
            "tracker_hash": type(self.tracker).source_hash(),
            "marker_config": (
                "green rim constellation + shaft hub marker, "
                f"hub {'auto' if self.tracker.calibration.get('auto_hub') else 'manual'}"
                f", r={self.tracker.radius_px:.0f}px"),
            "frames_missed": self.tracker.missed,
            "frames_unmatched": self.tracker.unmatched,
            "processed_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
            "metrics": {
                "runtime": m["runtime"],
                "avg_rpm": m["avg_rpm"],
                "motion_pct": m["motion_pct"],
                "continuity_pct": m["continuity_pct"],
                "efficiency_pct": m["efficiency_pct"],
                "revolutions": m["revolutions"],
                "peak_rpm": m["peak_rpm"],
                "excluded": m["excluded"],
            },
            "best_window": ({"rpm": m["best_30s_rpm"]}
                            if m["best_30s_rpm"] else None),
            # Provenance for anyone reading this months later: how much of the
            # wall clock was excluded, and why.
            "pauses": list(self.pauses),
            "paused_total_s": round(sum(p["seconds"] for p in self.pauses), 1),
            "excluded_s": m["excluded_s"],
            "gaps": list(self.tracker.metrics.gaps),
            "outputs": {"csv": f"{run_key}_angle.csv",
                        "plot": f"{run_key}_master_plot.png",
                        "clip": None},
        }

    @staticmethod
    def _write_csv(asset_dir, run_key, records) -> None:
        path = os.path.join(asset_dir, f"{run_key}_angle.csv")
        with open(path, "w", newline="") as f:
            w = csv.writer(f)
            w.writerow(["time_s", "angle_deg", "unwrapped_angle_deg",
                        "frame_num"])
            w.writerows(records)

    def _write_plot(self, asset_dir, run_key, design, test_n, records,
                    summary) -> None:
        """Render the same master plot the offline tracker produces.

        Imported lazily and best-effort: matplotlib is heavy, and a missing
        Evapoflex Tools checkout must not cost the operator their run data.
        """
        if not self.tools_dir or not os.path.isdir(self.tools_dir):
            return
        try:
            mod = self._load_plot_module()
            if mod is None:
                return
            best = mod.find_best_window(records, mod.BEST_CLIP_DURATION_S)
            png = os.path.join(asset_dir, f"{run_key}_master_plot.png")
            mod.make_master_plot(records, design, test_n,
                                 summary["date_pretty"], png,
                                 best_window=best)
            if best:
                summary["best_window"] = {
                    "rpm": round(best["rpm"], 3),
                    "start_t": round(best["start_t"], 1),
                    "end_t": round(best["end_t"], 1),
                }
        except Exception as exc:                       # noqa: BLE001
            print(f"[rig] master plot skipped: {exc}", flush=True)

    def _load_plot_module(self):
        """Load (once) the offline tracker's plotting helpers.

        Re-executing the module on every stop re-ran its import-time work and
        cost ~15s per run; cached, only the first stop after a restart pays it.
        """
        if self._wv is not None:
            return self._wv
        import importlib.util
        import sys
        spec = importlib.util.spec_from_file_location(
            "wheel_tracker_video",
            os.path.join(self.tools_dir, "wheel_tracker_video.py"))
        if spec is None or spec.loader is None:
            return None
        mod = importlib.util.module_from_spec(spec)
        sys.modules.setdefault("wheel_tracker_video", mod)
        spec.loader.exec_module(mod)
        self._wv = mod
        return mod

    def recover_orphan_run(self) -> None:
        """Salvage a run left 'running' by a server crash or restart.

        Samples are flushed to SQLite every few seconds, so a killed process
        still leaves almost the whole run on disk. Rebuilding the CSV, summary
        and plot from those rows turns a crash into a slightly short run rather
        than a lost night of data - previously this just stamped the row
        'aborted' and the samples sat there unreachable.
        """
        row = store.active_run(self.db)
        if row is None:
            return
        records = [list(r) for r in store.all_samples(self.db, row["id"])]
        if len(records) < 2:
            store.abort_run(self.db, row["id"],
                            "server restarted before any data was recorded")
            print("[rig] discarded empty orphan run", flush=True)
            return

        summary = self._build_summary(row["run_key"], row["design"],
                                      row["test_n"], records,
                                      metrics=metrics_from_records(records))
        summary["recovered"] = True
        summary["notes"] = ("Recovered after the server stopped mid-run; "
                            "data ends at the last saved sample.")
        asset_dir = os.path.join(self.runs_dir, row["run_key"])
        try:
            os.makedirs(asset_dir, exist_ok=True)
            self._write_csv(asset_dir, row["run_key"], records)
            self._write_plot(asset_dir, row["run_key"], row["design"],
                             row["test_n"], records, summary)
            with open(os.path.join(asset_dir,
                                   f"{row['run_key']}_summary.json"), "w") as f:
                json.dump(summary, f, indent=2)
        except OSError as exc:
            print(f"[rig] orphan artefacts failed: {exc}", flush=True)
            asset_dir = None
        store.finish_run(self.db, row["id"], summary, asset_dir)
        print(f"[rig] recovered orphan run {row['run_key']} "
              f"({len(records)} samples)", flush=True)
