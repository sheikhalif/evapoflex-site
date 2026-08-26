"""Evapoflex live rig server.

Serves the static site, authenticates users, ingests the phone camera feed and
fans the tracked result out to dashboards.

    /                     the existing marketing site (public)
    /live.html            live feed + stats          (login: view)
    /runs.html            archive of every test run  (login: view)
    /capture.html         the phone's camera page    (login: control)
    /admin.html           user management            (login: admin)

    WS /ws/ingest         phone -> server, JPEG frames + control messages
    WS /ws/live           server -> dashboards, frames + stats

Run it with:  python3 server/app.py
"""

import asyncio
import json
import os
import secrets
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from fastapi import (Cookie, Depends, FastAPI, HTTPException, Query, Request,
                     Response, WebSocket, WebSocketDisconnect)
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
import uvicorn

import auth
import rig as rig_mod
import store
import stream

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
SITE_DIR = os.path.dirname(BASE_DIR)


def _default_data_dir() -> str:
    """Pick a data directory that a file-sync daemon will not touch.

    macOS "Desktop & Documents Folders" sync puts everything under ~/Documents
    into iCloud. A live SQLite database with a WAL is exactly the wrong thing
    to hand to a sync daemon: it copies the pieces independently, can evict
    them to the cloud, and reads then fail with ETIMEDOUT mid-run. Observed on
    this machine - reads of files under ~/Documents intermittently timed out.

    So unless told otherwise, keep run data in Application Support, which is
    never synced, and leave the repo holding only code.
    """
    override = os.environ.get("EVAPOFLEX_DATA")
    if override:
        return os.path.abspath(os.path.expanduser(override))
    if sys.platform == "darwin":
        return os.path.expanduser("~/Library/Application Support/evapoflex-rig")
    return os.path.join(BASE_DIR, "data")


def _is_cloud_synced(path: str) -> bool:
    home = os.path.expanduser("~")
    risky = [os.path.join(home, "Documents"), os.path.join(home, "Desktop"),
             os.path.join(home, "Library", "Mobile Documents")]
    real = os.path.realpath(path)
    if not any(real.startswith(os.path.realpath(r) + os.sep) for r in risky):
        return False
    # Only actually a problem when Desktop & Documents sync is switched on.
    return os.path.isdir(os.path.join(
        home, "Library", "Mobile Documents", "com~apple~CloudDocs"))


DATA_DIR = _default_data_dir()
DB_PATH = os.path.join(DATA_DIR, "evapoflex.db")
RUNS_DIR = os.path.join(DATA_DIR, "runs")

# Where the offline tracker writes its output; scanned to build the archive.
TOOLS_DIR = os.environ.get(
    "EVAPOFLEX_TOOLS",
    os.path.join(os.path.dirname(SITE_DIR), "Evapoflex Tools"))

# Pages that require a login, and the permission each one needs.
#
# live.html is deliberately absent: the feed is public, so anyone can watch the
# wheel turn and read the running metrics without an account. Being able to
# SEE the rig and being able to TOUCH it are separate concerns - every action
# (start/stop a run, recalibrate, change algorithm, read the archive) is gated
# at the API on its own permission, so a public viewer can do none of them.
#
# capture.html is absent for a different reason: it carries its own login form
# so the phone signs in as the camera account without bouncing through the main
# site login. Everything it can do is gated at the API too.
PROTECTED_PAGES = {
    # The operator console — annotations, run control, algorithm switching, all
    # the tracking internals. Split out of live.html so the public page can be
    # what a visitor wants (the wheel and how fast it is turning) without the
    # instrumentation a rig operator needs.
    "console.html": "control",
    "runs.html": "view",
    "admin.html": "admin",
}

# Endpoints a signed-out visitor may read. Strictly the live view: the current
# frame, the current numbers. Nothing historical, nothing that changes state.
PUBLIC_VIEW = True

# Concurrent anonymous viewers on the live socket. Signed-in users bypass it.
MAX_VIEWERS = int(os.environ.get("EVAPOFLEX_MAX_VIEWERS", "80"))

db = store.connect(DB_PATH)
rig = rig_mod.Rig(db, RUNS_DIR, TOOLS_DIR)

app = FastAPI(title="Evapoflex Rig", docs_url=None, redoc_url=None)

# The marketing site is a separate origin (static hosting) and needs to read
# the public status endpoint to light its "live" indicator. Deliberately an
# allowlist rather than "*", and deliberately WITHOUT credentials: nothing
# cross-origin should ever be able to ride on a logged-in session, so the
# browser will not attach cookies to these requests. Anything that changes the
# rig is same-origin only, reached from pages the rig itself serves.
ALLOWED_ORIGINS = [o for o in os.environ.get(
    "EVAPOFLEX_ALLOWED_ORIGINS",
    "https://evaporationengine.net,https://www.evaporationengine.net"
).split(",") if o]

app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_credentials=False,
    allow_methods=["GET"],
    allow_headers=["Content-Type"],
)


# ---------------------------------------------------------------------------
# Auth plumbing
# ---------------------------------------------------------------------------
def current_user(session: str | None = Cookie(default=None,
                                              alias=auth.SESSION_COOKIE)):
    return auth.user_for_token(db, session)


def require(permission: str):
    def dep(user=Depends(current_user)):
        if user is None:
            raise HTTPException(401, "login required")
        if not auth.has_permission(user, permission):
            raise HTTPException(403, f"requires '{permission}' permission")
        return user
    return dep


def ws_user(websocket: WebSocket, permission: str):
    token = websocket.cookies.get(auth.SESSION_COOKIE)
    user = auth.user_for_token(db, token)
    if user is None or not auth.has_permission(user, permission):
        return None
    return user


# ---------------------------------------------------------------------------
# Auth routes
# ---------------------------------------------------------------------------
@app.post("/api/auth/login")
async def api_login(request: Request, response: Response):
    body = await request.json()
    try:
        token = auth.login(db, body.get("username", ""),
                           body.get("password", ""))
    except auth.AuthError as exc:
        raise HTTPException(401, str(exc))
    user = auth.user_for_token(db, token)
    response = JSONResponse({"ok": True, "user": user})
    response.set_cookie(
        auth.SESSION_COOKIE, token,
        max_age=auth.SESSION_TTL_S, httponly=True, samesite="lax",
        # Secure only behind TLS: the rig is often reached over plain http on
        # the LAN during setup, and a Secure cookie would never be sent there.
        secure=bool(os.environ.get("EVAPOFLEX_HTTPS")),
        path="/")
    return response


@app.post("/api/auth/logout")
async def api_logout(session: str | None = Cookie(default=None,
                                                  alias=auth.SESSION_COOKIE)):
    if session:
        auth.logout(db, session)
    response = JSONResponse({"ok": True})
    response.delete_cookie(auth.SESSION_COOKIE, path="/")
    return response


@app.get("/api/auth/me")
async def api_me(user=Depends(current_user)):
    if user is None:
        raise HTTPException(401, "not logged in")
    return user


# ---------------------------------------------------------------------------
# User administration
# ---------------------------------------------------------------------------
@app.get("/api/users")
async def api_users(user=Depends(require("admin"))):
    return {"users": auth.list_users(db)}


@app.post("/api/users")
async def api_create_user(request: Request, user=Depends(require("admin"))):
    body = await request.json()
    try:
        created = auth.create_user(db, body.get("username", ""),
                                   body.get("password", ""),
                                   body.get("role", "viewer"))
    except auth.AuthError as exc:
        raise HTTPException(400, str(exc))
    return {"ok": True, "user": created}


@app.patch("/api/users/{username}")
async def api_update_user(username: str, request: Request,
                          user=Depends(require("admin"))):
    body = await request.json()
    try:
        if "role" in body:
            auth.set_role(db, username, body["role"])
        if body.get("password"):
            auth.set_password(db, username, body["password"])
    except auth.AuthError as exc:
        raise HTTPException(400, str(exc))
    return {"ok": True}


@app.delete("/api/users/{username}")
async def api_delete_user(username: str, user=Depends(require("admin"))):
    try:
        auth.delete_user(db, username)
    except auth.AuthError as exc:
        raise HTTPException(400, str(exc))
    return {"ok": True}


# ---------------------------------------------------------------------------
# Live status and control
# ---------------------------------------------------------------------------
@app.get("/api/live/status")
async def api_status():
    """Public: what the rig is doing right now."""
    return rig.status()


@app.get("/api/stream/config")
async def api_stream_config():
    """Public: where the video lives, so a viewer page knows how to connect."""
    return stream.public_config()


@app.post("/api/stream/token")
async def api_stream_token(user=Depends(current_user)):
    """Mint an SFU token. Publishing needs the camera account; watching does not.

    Viewer tokens are handed out without a login because the feed is public —
    but they carry canPublish=false, so one cannot be replayed to push video
    into the room. Watching and broadcasting stay separate.
    """
    if not stream.config()["enabled"]:
        raise HTTPException(503, "streaming is not configured on this server")
    can_publish = bool(user and auth.has_permission(user, "stream"))
    identity = (user["username"] if user
                else f"viewer-{secrets.token_hex(4)}")
    return {
        "token": stream.mint_token(identity, publish=can_publish),
        "url": stream.config()["url"],
        "room": stream.config()["room"],
        "publish": can_publish,
        "identity": identity,
    }


@app.get("/api/live/overview")
async def api_overview():
    """Public: everything the visitor-facing page shows, in one call.

    Deliberately a separate endpoint from /api/live/status rather than more
    fields on it: this one is shaped for the public page (headline numbers and
    a three-hour trend) and carries none of the tracking internals, so what a
    signed-out visitor can read stays obvious from the endpoint list.
    """
    s = rig.status()
    lifetime = store.archive_totals(db)
    return {
        "live": bool(s["feed"]["up"]),
        "rpm": s["metrics"]["current_rpm"],
        "average_rpm": s["metrics"]["avg_rpm"],
        "revolutions": s["metrics"]["revolutions"],
        "best_30s": s["metrics"]["best_30s_rpm"],
        "running_for": s["metrics"]["runtime"],
        "history": rig.history(),
        "totals": {
            "runs": lifetime["runs"],
            "average_runtime": lifetime["average_runtime"],
            "total_runtime": lifetime["total_runtime"],
        },
    }


@app.get("/api/live/snapshot")
async def api_snapshot():
    """Latest JPEG, for thumbnails and for browsers without WebSocket."""
    if rig.last_frame_jpeg is None:
        raise HTTPException(404, "no frame yet")
    return Response(rig.last_frame_jpeg, media_type="image/jpeg",
                    headers={"Cache-Control": "no-store"})


@app.get("/api/trackers")
async def api_trackers(user=Depends(require("view"))):
    """Algorithms available, which is running, and any that failed to load."""
    return rig.tracker_info()


@app.post("/api/trackers/select")
async def api_tracker_select(body: dict, user=Depends(require("control"))):
    name = (body or {}).get("name", "")
    try:
        return {"ok": True, **rig.set_tracker(name,
                                              force=bool(body.get("force")))}
    except KeyError as exc:
        raise HTTPException(404, str(exc)) from exc
    except ValueError as exc:
        # Refusing to splice two algorithms into one run - 409, not 400: the
        # request is valid, the rig is just in a state where it is unsafe.
        raise HTTPException(409, str(exc)) from exc


@app.post("/api/trackers/author")
async def api_tracker_author(body: dict, user=Depends(require("admin"))):
    """Sample the live feed and have Claude write a tracker for what it sees.

    Writes the file and returns it for review. Deliberately does NOT select it:
    generated code runs unsandboxed on the machine holding every test result,
    and the model is working from a handful of JPEGs. Activating it is a
    separate, deliberate call.
    """
    import authoring
    try:
        frames = await asyncio.to_thread(
            authoring.capture_samples, rig, int(body.get("frames", 5)))
    except ValueError as exc:
        raise HTTPException(409, str(exc)) from exc

    try:
        result = await asyncio.to_thread(
            authoring.generate_tracker, frames,
            rig.tracker.calibration, str(body.get("notes", "")),
            os.path.join(BASE_DIR, "trackers"))
    except Exception as exc:                           # noqa: BLE001
        # Surface the real reason - a missing API key and a model refusal are
        # very different problems and both look like "it didn't work".
        raise HTTPException(502, f"{type(exc).__name__}: {exc}") from exc

    import trackers as trackers_mod
    trackers_mod.reload()
    return {"ok": True, "generated": result,
            "available": trackers_mod.describe_all(),
            "errors": trackers_mod.last_errors()}


@app.post("/api/trackers/reload")
async def api_tracker_reload(user=Depends(require("admin"))):
    """Re-import algorithm files from disk without dropping the feed."""
    return {"ok": True, **await asyncio.to_thread(rig.reload_trackers)}


@app.post("/api/live/calibrate")
async def api_calibrate(request: Request, user=Depends(require("control"))):
    body = await request.json()
    mode = body.get("mode", "set")
    if mode == "reset":
        return {"ok": True, "calibration": rig.reset_calibration()}
    if mode == "auto":
        result = rig.auto_calibrate()
        if result is None:
            raise HTTPException(
                400, "not enough marker motion yet - let the wheel turn "
                     "through at least a quarter revolution and retry")
        return {"ok": True, "fit": result,
                "calibration": rig.tracker.calibration}
    if mode == "color":
        result = rig.sample_marker_color(float(body["x"]), float(body["y"]))
        if not result:
            raise HTTPException(400, "no frame available to sample")
        return {"ok": True, "sampled": result,
                "calibration": rig.tracker.calibration}
    return {"ok": True, "calibration": rig.update_calibration(body)}


@app.post("/api/run/start")
async def api_run_start(request: Request, user=Depends(require("control"))):
    body = await request.json()
    try:
        result = rig.start_run(
            design=body.get("design") or "EED01M",
            test_n=body.get("test"),
            label=body.get("label") or "",
            username=user["username"])
    except ValueError as exc:
        raise HTTPException(409, str(exc))
    await broadcast_event("run_started", result)
    return {"ok": True, **result}


@app.post("/api/run/pause")
async def api_run_pause(request: Request, user=Depends(require("control"))):
    body = await request.json() if await request.body() else {}
    try:
        result = rig.pause(body.get("reason", ""), user["username"])
    except ValueError as exc:
        raise HTTPException(409, str(exc))
    await broadcast_event("run_paused",
                          {"by": user["username"], **result})
    return {"ok": True, **result}


@app.post("/api/run/resume")
async def api_run_resume(user=Depends(require("control"))):
    try:
        result = rig.resume(user["username"])
    except ValueError as exc:
        raise HTTPException(409, str(exc))
    await broadcast_event("run_resumed", result)
    return {"ok": True, **result}


@app.post("/api/run/stop")
async def api_run_stop(user=Depends(require("control"))):
    try:
        summary = await rig.stop_run()
    except ValueError as exc:
        raise HTTPException(409, str(exc))
    await broadcast_event("run_stopped", {"summary": summary})
    return {"ok": True, "summary": summary}


# ---------------------------------------------------------------------------
# Run archive
# ---------------------------------------------------------------------------
@app.get("/api/runs")
async def api_runs(user=Depends(require("view")),
                   limit: int = Query(500, le=2000), offset: int = 0,
                   source: str | None = None, design: str | None = None):
    rows = store.list_runs(db, limit=limit, offset=offset, source=source,
                           design=design)
    out = []
    for r in rows:
        summary = json.loads(r["summary_json"]) if r["summary_json"] else {}
        metrics = summary.get("metrics", {})
        out.append({
            "run_key": r["run_key"],
            "source": r["source"],
            "design": r["design"],
            "test": r["test_n"],
            "label": r["label"],
            "status": r["status"],
            "date_iso": r["date_iso"],
            "date_pretty": summary.get("date_pretty"),
            "started_at": r["started_at"],
            "ended_at": r["ended_at"],
            "started_by": r["started_by"],
            "duration_s": summary.get("duration_s"),
            "records": summary.get("records"),
            "metrics": metrics,
            "best_window": summary.get("best_window"),
            "has_plot": bool(summary.get("outputs", {}).get("plot")),
            "has_clip": bool(summary.get("outputs", {}).get("clip")),
            "has_csv": bool(summary.get("outputs", {}).get("csv")),
        })
    designs = [r["design"] for r in db.execute(
        "SELECT DISTINCT design FROM runs WHERE design IS NOT NULL "
        "ORDER BY design").fetchall()]
    return {"runs": out, "designs": designs, "total": len(out)}


@app.get("/api/runs/{run_key}")
async def api_run_detail(run_key: str, user=Depends(require("view"))):
    row = store.get_run(db, run_key)
    if row is None:
        raise HTTPException(404, "no such run")
    row["summary"] = (json.loads(row.pop("summary_json"))
                      if row["summary_json"] else {})
    row["config"] = (json.loads(row.pop("config_json"))
                     if row["config_json"] else {})
    return row


@app.get("/api/runs/{run_key}/series")
async def api_run_series(run_key: str, user=Depends(require("view")),
                         max_points: int = Query(3000, le=20000)):
    """Angle series for charting - from SQLite for live runs, CSV for imports."""
    row = store.get_run(db, run_key)
    if row is None:
        raise HTTPException(404, "no such run")

    if row["source"] == "live":
        rows = store.run_samples(db, row["id"], max_points)
        return {"columns": ["t", "angle", "unwrapped"],
                "data": [[r[0], r[1], r[2]] for r in rows]}

    path = _asset_path(row, "csv")
    if path is None:
        raise HTTPException(404, "no angle CSV on disk for this run")
    # Hour-long runs produce CSVs of tens of thousands of rows; parsing them
    # on the loop would pause the live feed for every archive page view.
    try:
        data = await asyncio.to_thread(_read_series_csv, path, max_points)
    except OSError as exc:
        # The archive lives on whatever volume the tools folder is on, which
        # can stall or vanish (full disk, unplugged drive, cloud eviction).
        # The run's metrics and plot are already rendered from the summary, so
        # degrade to "no chart" instead of failing the whole detail view.
        raise HTTPException(503, f"could not read angle CSV: {exc}")
    return {"columns": ["t", "angle", "unwrapped"], "data": data}


def _read_series_csv(path: str, max_points: int) -> list[list[float]]:
    rows = []
    with open(path) as f:
        next(f, None)                       # header
        for line in f:
            parts = line.split(",")
            if len(parts) < 3:
                continue
            rows.append(parts)
    stride = max(1, len(rows) // max_points)
    return [[float(r[0]), float(r[1]), float(r[2])] for r in rows[::stride]]


def _asset_path(row: dict, kind: str) -> str | None:
    summary = json.loads(row["summary_json"]) if row["summary_json"] else {}
    name = summary.get("outputs", {}).get(kind)
    if not name or not row["asset_dir"]:
        return None
    # Reject anything that tries to escape the run's own directory.
    path = os.path.normpath(os.path.join(row["asset_dir"], name))
    if not path.startswith(os.path.normpath(row["asset_dir"]) + os.sep):
        return None
    return path if os.path.isfile(path) else None


@app.get("/api/runs/{run_key}/asset/{kind}")
async def api_run_asset(run_key: str, kind: str, user=Depends(require("view"))):
    if kind not in ("plot", "clip", "csv", "setup"):
        raise HTTPException(400, "unknown asset")
    row = store.get_run(db, run_key)
    if row is None:
        raise HTTPException(404, "no such run")
    path = _asset_path(row, kind)
    if path is None:
        raise HTTPException(404, "asset not available")
    return FileResponse(path, filename=os.path.basename(path))


@app.delete("/api/runs/{run_key}")
async def api_delete_run(run_key: str, user=Depends(require("admin"))):
    if not store.delete_run(db, run_key):
        raise HTTPException(404, "no such run")
    return {"ok": True}


@app.post("/api/runs/import")
async def api_import(user=Depends(require("control"))):
    """Rescan the tools folders and pull in any new offline results."""
    roots = [TOOLS_DIR, RUNS_DIR]
    # Walks every result folder and parses each summary - off-loop so a large
    # archive does not stall the live feed while someone presses Rescan.
    return {"ok": True, **await asyncio.to_thread(store.import_summaries,
                                                  db, roots)}


# ---------------------------------------------------------------------------
# WebSockets
# ---------------------------------------------------------------------------
async def broadcast_event(kind: str, payload: dict) -> None:
    for sub in list(rig.subscribers):
        sub.offer(("event", {"event": kind, **payload}, None))


@app.websocket("/ws/ingest")
async def ws_ingest(websocket: WebSocket):
    """The phone's uplink: binary JPEG frames plus JSON control messages."""
    user = ws_user(websocket, "stream")
    if user is None:
        await websocket.close(code=4401, reason="unauthorized")
        return
    await websocket.accept()

    if rig.feed_connected and (time.time() - rig.last_frame_at) < 5.0:
        # A second phone would interleave two viewpoints into one angle series.
        await websocket.close(code=4409, reason="a camera is already streaming")
        return

    rig.on_feed_open(user["username"])
    await websocket.send_json({"type": "hello",
                               "calibration": rig.tracker.calibration,
                               "user": user["username"]})
    pending_t: float | None = None
    pending_sent: float | None = None
    try:
        while True:
            message = await websocket.receive()
            if message.get("type") == "websocket.disconnect":
                break

            if (data := message.get("bytes")) is not None:
                # Decode + track off-loop; persist and fan out on-loop.
                t_proc = time.perf_counter()
                overlay = await asyncio.to_thread(rig.track_frame, data,
                                                  pending_t)
                proc_ms = (time.perf_counter() - t_proc) * 1000.0
                rig.note_processing(proc_ms)
                pending_t = None
                rig.publish(data, overlay)
                rig.flush_if_due()
                rig.note_history()
                # Echo a compact ack so the phone can show lock state and the
                # headline numbers without subscribing to the full dashboard
                # stream (which would send the phone its own video back).
                m = rig.tracker.metrics
                await websocket.send_json({
                    "type": "ack",
                    "locked": overlay.get("locked", False),
                    "blobs": overlay.get("blobs", 0),
                    "angle": overlay.get("angle"),
                    "fps": rig.fps(),
                    "rpm": m.current_rpm(),
                    "revolutions": round(
                        ((m.last_unwrapped - m.first_unwrapped) / 360.0)
                        if m.first_unwrapped is not None else 0.0, 2),
                    "lock_quality": rig.tracker.lock_quality(),
                    "recording": rig.run_id is not None,
                    "paused": rig.paused,
                    "backfilling": rig.backfilling,
                    "n_markers": overlay.get("n_markers", 0),
                    "proc_ms": round(proc_ms, 1),
                    # Echoed straight back so the phone can time the round trip
                    # against its own clock - no clock sync between the two.
                    "echo": pending_sent,
                })
                pending_sent = None
                continue

            if (text := message.get("text")) is not None:
                try:
                    msg = json.loads(text)
                except json.JSONDecodeError:
                    continue
                kind = msg.get("type")
                if kind == "meta":
                    # Capture timestamp for the frame that follows.
                    pending_t = msg.get("t")
                    pending_sent = msg.get("sent")
                elif kind == "calibrate":
                    rig.update_calibration(msg.get("calibration", {}))
                    await websocket.send_json(
                        {"type": "calibration",
                         "calibration": rig.tracker.calibration})
                elif kind == "backfill_start":
                    rig.begin_backfill(msg.get("count", 0),
                                       msg.get("dropped", 0))
                    await broadcast_event("backfill_started",
                                          {"count": msg.get("count", 0),
                                           "dropped": msg.get("dropped", 0)})
                elif kind == "backfill_end":
                    result = rig.end_backfill()
                    rig.flush_if_due()
                    await websocket.send_json({"type": "backfill_done",
                                               **result})
                    await broadcast_event("backfill_done", result)
                elif kind == "latency":
                    rig.latency_ms = msg.get("ms")
                elif kind == "ping":
                    await websocket.send_json({"type": "pong",
                                               "t": time.time()})
    except (WebSocketDisconnect, RuntimeError):
        pass
    except Exception as exc:                           # noqa: BLE001
        # The rig is unattended: log and close cleanly rather than letting an
        # unexpected error propagate as an opaque socket reset the phone will
        # spend the night reconnecting to.
        print(f"[ingest] closing after error: {exc!r}", flush=True)
    finally:
        try:
            rig._flush_samples()                       # keep partial run data
        except Exception:                              # noqa: BLE001
            pass
        rig.on_feed_close()


@app.websocket("/ws/live")
async def ws_live(websocket: WebSocket, video: int = 1):
    """Dashboard downlink: overlay JSON + binary frame, and periodic stats.

    Public - no login. The feed is meant to be watchable by anyone, and
    everything that changes the rig is gated separately at its own endpoint.
    """
    # A public socket is an open invitation to hold thousands of them, and each
    # one costs a queue plus a copy of every frame. Signed-in users are let in
    # past the cap so the rig never locks its own operators out of the feed
    # because strangers filled it.
    if len(rig.subscribers) >= MAX_VIEWERS and ws_user(websocket, "view") is None:
        await websocket.close(code=4429, reason="viewer limit reached")
        return
    await websocket.accept()

    sub = rig_mod.Subscriber(want_video=bool(video))
    rig.subscribers.add(sub)
    try:
        await websocket.send_json({"type": "stats", **rig.status()})
        if sub.want_video and rig.last_frame_jpeg is not None:
            await websocket.send_json({"type": "frame", **rig.last_overlay})
            await websocket.send_bytes(rig.last_frame_jpeg)

        while True:
            kind, payload, blob = await sub.queue.get()
            if kind == "frame":
                await websocket.send_json({"type": "frame", **payload})
                await websocket.send_bytes(blob)
            elif kind == "stats":
                await websocket.send_json({"type": "stats", **payload})
            elif kind == "event":
                await websocket.send_json({"type": "event", **payload})
    except (WebSocketDisconnect, RuntimeError):
        pass
    finally:
        rig.subscribers.discard(sub)


# ---------------------------------------------------------------------------
# Static site with page-level auth gating
# ---------------------------------------------------------------------------
@app.get("/{page}.html")
async def serve_page(page: str, user=Depends(current_user)):
    filename = f"{page}.html"
    path = os.path.normpath(os.path.join(SITE_DIR, filename))
    if not path.startswith(SITE_DIR + os.sep) or not os.path.isfile(path):
        raise HTTPException(404, "not found")

    needed = PROTECTED_PAGES.get(filename)
    if needed and not auth.has_permission(user, needed):
        target = "/login.html?next=" + filename
        return RedirectResponse(target, status_code=302)
    return FileResponse(path)


@app.get("/")
async def serve_index():
    return FileResponse(os.path.join(SITE_DIR, "index.html"))


app.mount("/assets", StaticFiles(directory=os.path.join(SITE_DIR, "assets")),
          name="assets")


# ---------------------------------------------------------------------------
# Startup
# ---------------------------------------------------------------------------
@app.on_event("startup")
async def on_startup():
    rig.recover_orphan_run()
    auth.purge_expired_sessions(db)
    created = auth.ensure_admin(db)
    if created:
        username, password = created
        print("\n" + "=" * 62)
        print("  First run - created an admin account.")
        print(f"    username: {username}")
        print(f"    password: {password}")
        print("  Change it after logging in. This is shown only once.")
        print("=" * 62 + "\n", flush=True)
    if _is_cloud_synced(DATA_DIR):
        print("\n" + "!" * 62)
        print("  WARNING: run data is inside an iCloud-synced folder:")
        print(f"    {DATA_DIR}")
        print("  Syncing a live SQLite database risks corruption and stalled")
        print("  reads. Set EVAPOFLEX_DATA to a path outside Documents and")
        print("  Desktop, or turn off Desktop & Documents Folders sync.")
        print("!" * 62 + "\n", flush=True)
    # Scanning the archive can take minutes when the tools folder lives on a
    # stalled cloud-synced volume (measured: 100s for 13 files). The rig must
    # not wait on that - the phone could be trying to reconnect right now - so
    # the import runs in the background and the server accepts traffic
    # immediately.
    asyncio.create_task(_startup_import())


async def _startup_import():
    try:
        result = await asyncio.to_thread(store.import_summaries, db,
                                         [TOOLS_DIR, RUNS_DIR])
    except Exception as exc:                           # noqa: BLE001
        print(f"[startup] archive import failed: {exc}", flush=True)
        return
    failures = result.pop("failures", [])
    print(f"[startup] archive import: {result}", flush=True)
    for f in failures:
        print(f"[startup]   unreadable: {f}", flush=True)


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "8000"))
    print(f"[evapoflex] site  : {SITE_DIR}")
    print(f"[evapoflex] data  : {DATA_DIR}")
    print(f"[evapoflex] tools : {TOOLS_DIR}")
    uvicorn.run(app, host="0.0.0.0", port=port, log_level="info")
