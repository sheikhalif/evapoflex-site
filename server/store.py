"""SQLite persistence for users, sessions, runs and tracked angle samples.

Two kinds of run land in the same `runs` table so one archive page can show
both:

  source='live'      recorded here from the phone feed, samples in `samples`
  source='imported'  produced offline by wheel_tracker_*.py, discovered by
                     scanning for *_summary.json; the CSV stays on disk

Imported rows are keyed by their summary `id` (e.g. EED01M_Test_10_2026-08-18)
so re-scanning is idempotent - a reprocessed test updates in place rather than
duplicating.
"""

import json
import re
import os
import sqlite3
import time

SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    username      TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    role          TEXT NOT NULL DEFAULT 'viewer',
    created_at    REAL NOT NULL,
    last_login    REAL
);

CREATE TABLE IF NOT EXISTS sessions (
    token      TEXT PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id),
    created_at REAL NOT NULL,
    expires_at REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS runs (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    run_key       TEXT UNIQUE NOT NULL,
    source        TEXT NOT NULL DEFAULT 'live',
    design        TEXT,
    test_n        INTEGER,
    label         TEXT,
    notes         TEXT,
    status        TEXT NOT NULL DEFAULT 'running',
    started_at    REAL NOT NULL,
    ended_at      REAL,
    date_iso      TEXT,
    started_by    TEXT,
    config_json   TEXT,
    summary_json  TEXT,
    asset_dir     TEXT,
    created_at    REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_runs_started ON runs(started_at DESC);
CREATE INDEX IF NOT EXISTS idx_runs_status  ON runs(status);

CREATE TABLE IF NOT EXISTS samples (
    run_id     INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    t          REAL NOT NULL,
    angle      REAL NOT NULL,
    unwrapped  REAL NOT NULL,
    frame_num  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_samples_run ON samples(run_id, t);

CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
"""


def connect(path: str) -> sqlite3.Connection:
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    # timeout: block on a contended write rather than raising immediately.
    # A second server process (or a stray one on the same data dir) holding
    # the write lock for a moment must not surface as a failed run.
    db = sqlite3.connect(path, check_same_thread=False, timeout=30.0)
    db.row_factory = sqlite3.Row
    # WAL lets the ingest loop append samples while the archive page reads.
    db.execute("PRAGMA journal_mode=WAL")
    db.execute("PRAGMA busy_timeout=30000")
    db.execute("PRAGMA synchronous=NORMAL")
    db.execute("PRAGMA foreign_keys=ON")
    db.executescript(SCHEMA)
    db.commit()
    return db


# ---------------------------------------------------------------------------
# Settings (tracker calibration survives restarts)
# ---------------------------------------------------------------------------
def get_setting(db, key, default=None):
    row = db.execute("SELECT value FROM settings WHERE key = ?",
                     (key,)).fetchone()
    if row is None:
        return default
    try:
        return json.loads(row["value"])
    except json.JSONDecodeError:
        return default


def set_setting(db, key, value) -> None:
    db.execute(
        "INSERT INTO settings (key, value) VALUES (?, ?) "
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        (key, json.dumps(value)))
    db.commit()


# ---------------------------------------------------------------------------
# Runs
# ---------------------------------------------------------------------------
def start_run(db, run_key, design, test_n, label, config, started_by) -> int:
    now = time.time()
    cur = db.execute(
        "INSERT INTO runs (run_key, source, design, test_n, label, status, "
        "started_at, date_iso, started_by, config_json, created_at) "
        "VALUES (?, 'live', ?, ?, ?, 'running', ?, ?, ?, ?, ?)",
        (run_key, design, test_n, label, now,
         time.strftime("%Y-%m-%d", time.localtime(now)),
         started_by, json.dumps(config), now))
    db.commit()
    return cur.lastrowid


def append_samples(db, run_id: int, rows: list[tuple]) -> None:
    """rows: (t, angle, unwrapped, frame_num) tuples."""
    if not rows:
        return
    db.executemany(
        "INSERT INTO samples (run_id, t, angle, unwrapped, frame_num) "
        "VALUES (?, ?, ?, ?, ?)",
        [(run_id, *r) for r in rows])
    db.commit()


def finish_run(db, run_id: int, summary: dict, asset_dir: str | None) -> None:
    db.execute(
        "UPDATE runs SET status = 'complete', ended_at = ?, summary_json = ?, "
        "asset_dir = ? WHERE id = ?",
        (time.time(), json.dumps(summary), asset_dir, run_id))
    db.commit()


def abort_run(db, run_id: int, reason: str) -> None:
    db.execute(
        "UPDATE runs SET status = 'aborted', ended_at = ?, notes = ? "
        "WHERE id = ?", (time.time(), reason, run_id))
    db.commit()


def active_run(db) -> dict | None:
    row = db.execute(
        "SELECT * FROM runs WHERE status = 'running' "
        "ORDER BY started_at DESC LIMIT 1").fetchone()
    return dict(row) if row else None


def get_run(db, run_key: str) -> dict | None:
    row = db.execute("SELECT * FROM runs WHERE run_key = ?",
                     (run_key,)).fetchone()
    return dict(row) if row else None


def list_runs(db, limit=500, offset=0, source=None, design=None) -> list[dict]:
    sql = "SELECT * FROM runs WHERE 1=1"
    params: list = []
    if source:
        sql += " AND source = ?"
        params.append(source)
    if design:
        sql += " AND design = ?"
        params.append(design)
    sql += " ORDER BY started_at DESC LIMIT ? OFFSET ?"
    params += [limit, offset]
    return [dict(r) for r in db.execute(sql, params).fetchall()]


def archive_totals(db) -> dict:
    """Headline figures over every completed run, for the public page."""
    rows = db.execute(
        "SELECT summary_json FROM runs WHERE status = 'complete' "
        "AND summary_json IS NOT NULL").fetchall()
    seconds, counted = 0.0, 0
    for row in rows:
        try:
            summary = json.loads(row["summary_json"])
        except (TypeError, ValueError):
            continue
        # Prefer the recorded duration; fall back to parsing the runtime text
        # so runs imported from the offline tracker still count.
        dur = summary.get("duration_s")
        if dur is None:
            dur = _parse_runtime(summary.get("metrics", {}).get("runtime"))
        if dur:
            seconds += float(dur)
            counted += 1
    return {
        "runs": len(rows),
        "total_runtime": _fmt_hours(seconds),
        "average_runtime": _fmt_hours(seconds / counted) if counted else "—",
        "total_seconds": round(seconds),
    }


def _parse_runtime(text) -> float | None:
    """'1h 12m 30s' / '18m 4s' -> seconds."""
    if not isinstance(text, str):
        return None
    total, found = 0.0, False
    for value, unit in re.findall(r"(\d+)\s*([dhms])", text):
        total += int(value) * {"d": 86400, "h": 3600, "m": 60, "s": 1}[unit]
        found = True
    return total if found else None


def _fmt_hours(seconds: float) -> str:
    total = int(round(max(seconds, 0.0)))
    h, rem = divmod(total, 3600)
    m, s = divmod(rem, 60)
    if h:
        return f"{h}h {m}m"
    if m:
        return f"{m}m {s}s"
    return f"{s}s"


def run_samples(db, run_id: int, max_points: int = 4000) -> list[tuple]:
    """Return (t, angle, unwrapped, frame_num), decimated to max_points.

    Decimation is a uniform stride rather than an average: the unwrapped angle
    is monotone-ish and the front end recomputes RPM from it, so averaging
    neighbours would smooth away real stalls.
    """
    n = db.execute("SELECT COUNT(*) AS n FROM samples WHERE run_id = ?",
                   (run_id,)).fetchone()["n"]
    if n == 0:
        return []
    stride = max(1, n // max_points)
    rows = db.execute(
        "SELECT t, angle, unwrapped, frame_num FROM ("
        "  SELECT t, angle, unwrapped, frame_num, "
        "         ROW_NUMBER() OVER (ORDER BY t) AS rn "
        "  FROM samples WHERE run_id = ?"
        ") WHERE rn % ? = 0 ORDER BY t", (run_id, stride)).fetchall()
    return [tuple(r) for r in rows]


def all_samples(db, run_id: int) -> list[tuple]:
    """Every sample for a run, undecimated - for rebuilding a run's artefacts."""
    rows = db.execute(
        "SELECT t, angle, unwrapped, frame_num FROM samples "
        "WHERE run_id = ? ORDER BY t", (run_id,)).fetchall()
    return [tuple(r) for r in rows]


def delete_run(db, run_key: str) -> bool:
    row = db.execute("SELECT id FROM runs WHERE run_key = ?",
                     (run_key,)).fetchone()
    if row is None:
        return False
    db.execute("DELETE FROM samples WHERE run_id = ?", (row["id"],))
    db.execute("DELETE FROM runs WHERE id = ?", (row["id"],))
    db.commit()
    return True


# ---------------------------------------------------------------------------
# Importing offline runs
# ---------------------------------------------------------------------------
def import_summaries(db, roots: list[str]) -> dict:
    """Scan roots for *_summary.json and upsert them as source='imported'.

    Files that cannot be read are counted and reported, never treated as
    deleted: on a cloud-synced or flaky volume an unreadable summary is almost
    always a temporary stall, and dropping its row would silently delete a run
    from the archive. The database stays authoritative until a file is
    successfully re-read.

    Returns {"added", "updated", "scanned", "failed", "failures"}.
    """
    added = updated = scanned = 0
    failures: list[str] = []
    for root in roots:
        if not os.path.isdir(root):
            continue
        for dirpath, _dirnames, filenames in os.walk(root):
            for fn in filenames:
                if not fn.endswith("_summary.json"):
                    continue
                path = os.path.join(dirpath, fn)
                try:
                    with open(path) as f:
                        summary = json.load(f)
                except (OSError, json.JSONDecodeError) as exc:
                    failures.append(f"{fn}: {exc}")
                    continue
                scanned += 1
                key = _run_key_for(fn)
                mtime = os.path.getmtime(path)
                started = _summary_start_time(summary, mtime)
                existing = db.execute(
                    "SELECT id, source FROM runs WHERE run_key = ?",
                    (key,)).fetchone()
                if existing and existing["source"] == "live":
                    # Live runs write their assets into RUNS_DIR, which this
                    # scan also walks. The database row is authoritative for
                    # them - re-importing would overwrite the true start time
                    # with one reconstructed from the summary.
                    continue
                if existing:
                    db.execute(
                        "UPDATE runs SET summary_json = ?, asset_dir = ?, "
                        "design = ?, test_n = ?, date_iso = ?, "
                        "started_at = ?, ended_at = ? WHERE id = ?",
                        (json.dumps(summary), dirpath, summary.get("design"),
                         summary.get("test"), summary.get("date_iso"),
                         started, started + summary.get("duration_s", 0.0),
                         existing["id"]))
                    updated += 1
                else:
                    db.execute(
                        "INSERT INTO runs (run_key, source, design, test_n, "
                        "label, status, started_at, ended_at, date_iso, "
                        "summary_json, asset_dir, created_at) "
                        "VALUES (?, 'imported', ?, ?, ?, 'complete', ?, ?, ?, "
                        "?, ?, ?)",
                        (key, summary.get("design"), summary.get("test"),
                         summary.get("video") or key, started,
                         started + summary.get("duration_s", 0.0),
                         summary.get("date_iso"), json.dumps(summary),
                         dirpath, time.time()))
                    added += 1
    db.commit()
    return {"added": added, "updated": updated, "scanned": scanned,
            "failed": len(failures), "failures": failures[:20]}


def _run_key_for(filename: str) -> str:
    """Stable, collision-free archive key for one summary file.

    The summary `id` is NOT unique: a re-analysis of the same test writes a
    variant alongside the original (EED01M_Test_1_..._active_summary.json next
    to EED01M_Test_1_..._summary.json) and both carry id
    "EED01M_Test_1_2026-07-28". Keying on `id` made whichever file os.walk
    reached last silently overwrite the other - so Test 1 showed 18m/0.123 RPM
    or 7m/0.300 RPM depending on directory order, with no sign the other
    existed.

    The filename stem distinguishes them and is stable across rescans, so it
    wins. Two different folders holding the same filename still collide and
    merge - that case means the same run was copied, and treating the copies
    as one row is the behaviour we want.
    """
    return filename[:-len("_summary.json")]


def _summary_start_time(summary: dict, fallback_mtime: float) -> float:
    """Best-effort wall-clock start for ordering the archive.

    `processed_at` is when the tracker ran, not when the wheel ran, so back off
    the video duration to approximate the real start. Falls back to date_iso
    midnight, then the file mtime.
    """
    processed = summary.get("processed_at")
    if processed:
        try:
            t = time.mktime(time.strptime(processed, "%Y-%m-%dT%H:%M:%S"))
            return t - summary.get("duration_s", 0.0)
        except (ValueError, OverflowError):
            pass
    date_iso = summary.get("date_iso")
    if date_iso:
        try:
            return time.mktime(time.strptime(date_iso, "%Y-%m-%d"))
        except (ValueError, OverflowError):
            pass
    return fallback_mtime
