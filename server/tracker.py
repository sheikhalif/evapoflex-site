"""Shared foundation for every tracking algorithm.

The algorithms themselves live in `trackers/`, one file each, discovered and
hot-reloaded at runtime. What stays here is everything they must agree on, so
that swapping the algorithm changes *how* rotation is measured without changing
what any of the reported numbers mean.

The offline trackers own their loop: they open a video, walk every frame and
compute metrics once at the end over the full NumPy array. A 24/7 feed can do
neither - frames arrive one at a time from the phone, and the sample array would
grow without bound - so a live tracker is restructured as

    tracker.process(frame, t)   ->  one frame in, one sample out

with every headline metric computed incrementally in RollingMetrics. The metric
definitions are copied exactly from wheel_tracker_video.make_master_plot, so a
number shown live means the same thing as the number in an archived summary:

    avg_rpm         net unwrapped degrees / elapsed, converted to rev/min
    motion_pct      % of samples that are NOT a backwards step (< -0.001 deg)
    continuity_pct  % of samples that are NOT in a stall run (3+ steps < 0.05)
    efficiency_pct  % of samples that are neither

Calibration is stored in NORMALISED coordinates (fractions of frame width and
height). The phone may change capture resolution between sessions - or drop it
under thermal throttling - and a centre pinned at absolute pixel (889, 507)
would silently point at the wrong part of the wheel afterwards.
"""

import collections
import math
import time

import cv2
import numpy as np

KERNEL = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5))

# Metric thresholds - keep in sync with wheel_tracker_video.make_master_plot
STALL_DIFF_THRESHOLD = 0.05     # deg; below this a step counts as "flat"
STALL_MIN_CONSECUTIVE = 3       # flats in a row before the run counts as stall
REBOUND_THRESHOLD = -0.001      # deg; below this a step counts as backwards

ROLLING_WINDOW_S = 5.0          # window for the live RPM readout
BEST_WINDOW_S = 30.0            # matches BEST_CLIP_DURATION_S


def ang_diff(a: float, b: float) -> float:
    """Signed smallest difference a-b in degrees, wrapped to [-180, 180)."""
    return (a - b + 180.0) % 360.0 - 180.0


def fmt_runtime(seconds: float) -> str:
    total = int(round(max(seconds, 0.0)))
    h, rem = divmod(total, 3600)
    d, h = divmod(h, 24)
    m, s = divmod(rem, 60)
    if d:
        return f"{d}d {h}h {m}m"
    if h:
        return f"{h}h {m}m {s}s"
    return f"{m}m {s}s"


# ---------------------------------------------------------------------------
# Incremental metrics
# ---------------------------------------------------------------------------
class RollingMetrics:
    """Streaming equivalent of the offline metric block.

    Stall detection is retroactive in the original (hitting the 3rd flat step
    marks the two before it), so flats are held in `_pending` until the run
    either reaches the threshold - flush them all as stalled - or breaks, in
    which case they were never a stall. That keeps the live percentages
    identical to what the offline tracker would report on the same samples,
    at the cost of at most two samples of lag.
    """

    def __init__(self):
        self.n = 0
        self.first_t = None
        self.first_unwrapped = None
        self.last_t = None
        self.last_unwrapped = None

        # Time that must not count toward the run: maintenance pauses, and
        # outages long enough that we cannot honestly claim to know what the
        # wheel did. Without this a 10-minute pause reads as a 10-minute stall
        # and craters the continuity score for a run that was fine.
        self.excluded_s = 0.0
        self.gaps: list[dict] = []
        self._discontinuity = False

        self._prev_unwrapped = None
        self._stall_count = 0
        self._rebound_count = 0
        self._clean_count = 0          # neither stalled nor rebounding
        self._flat_run = 0
        self._pending = collections.deque()   # is_rebound flags, undecided

        # Trailing windows for the live readouts
        self._window = collections.deque()    # (t, unwrapped) within ROLLING
        self._best_window = collections.deque()
        self.best_rpm = 0.0
        self.best_rpm_at = None

        self.peak_rpm = 0.0

    def mark_gap(self, kind: str, note: str = "") -> None:
        """Break the sample chain: the next sample starts a fresh segment.

        Called when the wheel's behaviour between two samples is unknown or
        deliberately not measured (a pause, a dropped feed). The next add()
        contributes no step, so a manual nudge during maintenance never lands
        in the cumulative rotation, and the elapsed clock skips the interval.

        How long the gap lasted is measured from the sample timestamps, not
        from the server's wall clock. The two are different clocks - samples
        carry the phone's capture time - and subtracting a wall-clock duration
        from a capture-time span left the excluded interval still counted in
        elapsed, dragging avg_rpm down by however long the pause lasted.
        """
        self.gaps.append({"kind": kind, "seconds": None,
                          "at_t": round(self.last_t, 2) if self.last_t else 0.0,
                          "note": note})
        self._discontinuity = True

    def add(self, t: float, unwrapped: float) -> None:
        if self._discontinuity and self.first_t is not None:
            # Resume: no step across the break, and the rolling windows are
            # cleared so the first post-gap RPM is not a slope over the gap.
            self._discontinuity = False
            gap_s = max(t - self.last_t, 0.0) if self.last_t is not None else 0.0
            self.excluded_s += gap_s
            if self.gaps and self.gaps[-1]["seconds"] is None:
                self.gaps[-1]["seconds"] = round(gap_s, 2)
            self._flush_pending()
            self._flat_run = 0
            self._window.clear()
            self._best_window.clear()
            self._prev_unwrapped = unwrapped
            self.last_t = t
            self.last_unwrapped = unwrapped
            self.n += 1
            self._clean_count += 1
            self._window.append((t, unwrapped))
            self._best_window.append((t, unwrapped))
            return

        self.n += 1
        if self.first_t is None:
            self.first_t = t
            self.first_unwrapped = unwrapped
            # Index 0 has no preceding step, so it is neither stall nor
            # rebound - it counts as clean, matching the leading False in the
            # offline masks.
            self._clean_count += 1
        else:
            step = unwrapped - self._prev_unwrapped
            is_rebound = step < REBOUND_THRESHOLD
            is_flat = abs(step) < STALL_DIFF_THRESHOLD
            if is_rebound:
                self._rebound_count += 1

            if is_flat:
                self._flat_run += 1
                if self._flat_run >= STALL_MIN_CONSECUTIVE:
                    # Threshold reached: this sample and any held ones stall.
                    self._stall_count += 1
                    while self._pending:
                        self._pending.popleft()
                        self._stall_count += 1
                else:
                    self._pending.append(is_rebound)
            else:
                # Run broken - everything held was a short flat, not a stall.
                self._flush_pending()
                self._flat_run = 0
                if not is_rebound:
                    self._clean_count += 1

        self._prev_unwrapped = unwrapped
        self.last_t = t
        self.last_unwrapped = unwrapped

        self._window.append((t, unwrapped))
        while self._window and t - self._window[0][0] > ROLLING_WINDOW_S:
            self._window.popleft()

        self._best_window.append((t, unwrapped))
        while self._best_window and t - self._best_window[0][0] > BEST_WINDOW_S:
            self._best_window.popleft()
        self._update_best(t)

        rpm = self.current_rpm()
        if rpm is not None and abs(rpm) > abs(self.peak_rpm):
            self.peak_rpm = rpm

    def _flush_pending(self) -> None:
        while self._pending:
            was_rebound = self._pending.popleft()
            if not was_rebound:
                self._clean_count += 1

    def _update_best(self, t: float) -> None:
        w = self._best_window
        if len(w) < 3:
            return
        span = w[-1][0] - w[0][0]
        # Only score a full-length window, or the best RPM would be whatever
        # noisy 2-second slice happened to have the steepest slope.
        if span < BEST_WINDOW_S * 0.95:
            return
        rpm = abs((w[-1][1] - w[0][1]) / span) / 6.0
        if rpm > self.best_rpm:
            self.best_rpm = rpm
            self.best_rpm_at = t

    def current_rpm(self) -> float | None:
        """Least-squares slope over the trailing window, in RPM.

        Trailing rather than the offline centred window - live data has no
        future. Degenerate windows return None so the UI can show a dash
        instead of inventing a spike from two jittery neighbours.
        """
        w = self._window
        if len(w) < 3:
            return None
        ts = np.fromiter((p[0] for p in w), dtype=float, count=len(w))
        ys = np.fromiter((p[1] for p in w), dtype=float, count=len(w))
        if ts[-1] - ts[0] < 0.5 * ROLLING_WINDOW_S:
            return None
        tc = ts - ts.mean()
        denom = float((tc * tc).sum())
        if denom <= 0:
            return None
        slope_dps = float((tc * ys).sum()) / denom
        return slope_dps / 6.0

    def snapshot(self) -> dict:
        elapsed = 0.0
        avg_rpm = 0.0
        if self.first_t is not None and self.last_t is not None:
            elapsed = max(self.last_t - self.first_t - self.excluded_s, 0.0)
            if elapsed > 0:
                avg_dps = (self.last_unwrapped - self.first_unwrapped) / elapsed
                avg_rpm = (avg_dps / 360.0) * 60.0

        n = max(self.n, 1)
        # Percentages read against decided samples only; undecided flats are
        # still in flight and would otherwise dip the score for a frame or two.
        decided = max(n - len(self._pending), 1)
        net_deg = ((self.last_unwrapped - self.first_unwrapped)
                   if self.first_unwrapped is not None else 0.0)
        return {
            "samples": self.n,
            "elapsed_s": round(elapsed, 2),
            "runtime": fmt_runtime(elapsed),
            "net_deg": round(net_deg, 2),
            "revolutions": round(net_deg / 360.0, 3),
            "avg_rpm": round(avg_rpm, 4),
            "current_rpm": (round(self.current_rpm(), 4)
                            if self.current_rpm() is not None else None),
            "peak_rpm": round(self.peak_rpm, 4),
            "best_30s_rpm": round(self.best_rpm, 4),
            "motion_pct": round((1 - self._rebound_count / decided) * 100, 2),
            "continuity_pct": round((1 - self._stall_count / decided) * 100, 2),
            "efficiency_pct": round(self._clean_count / decided * 100, 2),
            "excluded_s": round(self.excluded_s, 2),
            "excluded": fmt_runtime(self.excluded_s),
            "gaps": len(self.gaps),
        }


# ---------------------------------------------------------------------------
# Calibration
# ---------------------------------------------------------------------------
# ---------------------------------------------------------------------------
# Tracking algorithms now live in the `trackers/` package, one file each, and
# are discovered and hot-reloaded at runtime. This module keeps only what they
# share: angle helpers, the rolling metrics, and the summary maths - so that
# every algorithm reports numbers computed identically and results stay
# comparable across a swap.
#
# `LiveTracker` is kept as an alias so older callers and saved runs referring
# to it still resolve.
# ---------------------------------------------------------------------------


def _default_tracker_class():
    from trackers import get, default_name
    return get(default_name())


def LiveTracker(calibration=None):          # noqa: N802  (kept for callers)
    return _default_tracker_class()(calibration)


def metrics_from_records(records) -> dict:
    """Replay stored samples through RollingMetrics to get a summary dict.

    Used when the live metrics object is unavailable - notably recovering a
    run after a crash, where the only surviving state is the sample rows.
    """
    m = RollingMetrics()
    for row in records:
        m.add(float(row[0]), float(row[2]))
    return m.snapshot()


def _angular_spread(angles: list[float]) -> float:
    """Largest arc covered by the angles, in radians (0 to 2pi)."""
    if not angles:
        return 0.0
    a = sorted(x % (2 * math.pi) for x in angles)
    gaps = [a[i + 1] - a[i] for i in range(len(a) - 1)]
    gaps.append(a[0] + 2 * math.pi - a[-1])
    return 2 * math.pi - max(gaps)
