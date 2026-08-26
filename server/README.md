# Evapoflex live rig

A 24/7 feed from the iPhone mounted at the rig, tracked frame-by-frame by the
same algorithm as `wheel_tracker_singlemarker.py`, with a live dashboard and an
archive that holds both live recordings and offline tracker output.

```
iPhone (capture.html)  ──WebSocket──▶  server  ──WebSocket──▶  live.html
   camera + controls        JPEG        tracker      frames       dashboard
                                           │         + stats
                                           ▼
                                    SQLite + CSV/PNG  ──▶  runs.html
```

## This is no longer a static site

`index.html` and `archive.html` are still plain files you could host anywhere.
`live.html`, `runs.html`, `capture.html` and `admin.html` are **not** — they
call `/api/...` and open `/ws/...`, so they do nothing without this server
running. Dropping them on static hosting produces pages that load and then fail
every request.

So the deployment shape changes:

**Serve the whole site from this server** (what the code assumes). One origin,
so session cookies and WebSockets work with no CORS or `SameSite=None`
juggling. The Python process needs to run continuously wherever the site lives.

The alternative — leave the marketing site on static hosting and put the rig on
a subdomain — means cross-origin cookies, a CORS allowlist and `SameSite=None;
Secure` on the session. It works, but it is materially more to get wrong for no
benefit while the rig is the only dynamic part.

## Setup

```bash
cd /path/to/evapoflex-site
pip3 install -r server/requirements.txt          # once
EVAPOFLEX_ADMIN_PASSWORD='pick-something' python3 server/app.py
```

Serves at `http://localhost:8000` (`PORT` to change it). The marketing pages
stay public; `live.html`, `runs.html` and `admin.html` redirect to the login.

On first run an `admin` account is created. Without
`EVAPOFLEX_ADMIN_PASSWORD` a password is generated and printed **once**.

## Testing locally before you deploy

Run against a scratch data directory so a test cannot touch real run data:

```bash
EVAPOFLEX_DATA=/tmp/rig-test \
EVAPOFLEX_ADMIN_PASSWORD='test1234' \
PORT=8099 python3 server/app.py
```

`localhost` counts as a secure context, so **capture.html will use the Mac's
own webcam** — the whole feature is testable without the phone. Point the
camera at anything green (a sticky note on a mug, rotated by hand) and:

1. `http://localhost:8099/capture.html` → sign in → **Marker** tab → tap the
   video on the green object to sample its real colour under real lighting.
2. **Start streaming**, then **Record run**.
3. `http://localhost:8099/live.html` in another tab → the feed, the annotation
   layers, and the live statistics.
4. **Pause** → confirm the video keeps flowing while tracking stops.
5. **Stop & save** → the run appears under *Test Runs* with CSV, plot and stats.

Worth exercising deliberately, because these are the paths that bite in the
field:

- **Kill the server mid-run** (Ctrl-C), then start it again. The run is rebuilt
  from the samples already flushed to SQLite rather than lost.
- **Turn wifi off mid-run.** Capture continues into the phone/browser's
  IndexedDB and replays on reconnect; watch the buffer counter on the capture
  page and the *Restoring buffered data* badge on the dashboard.

Delete `/tmp/rig-test` afterwards and the test accounts and runs go with it.

### Testing with the actual iPhone

Camera access needs HTTPS — Safari will not grant it over a plain `http://`
LAN address, and reports it as a missing API rather than a permission problem.
Get a real certificate the quick way:

```bash
cloudflared tunnel --url http://localhost:8099
```

Open the printed `https://….trycloudflare.com/capture.html` on the phone. The
phone connects **outbound**, so this works over a hotspot or cellular with no
port forwarding.

### Before it goes live

- Delete the test accounts in `admin.html` and set a real admin password.
- Set `EVAPOFLEX_HTTPS=1` so session cookies are marked `Secure`.
- Point `EVAPOFLEX_DATA` at persistent storage that is **not** cloud-synced.
- Decide what runs the process continuously — `launchd` on a always-on Mac, or
  `systemd` on a small VPS. It is a single Python process; the tracking is a
  colour threshold on a ~960px frame, about 6 ms per frame.

### Environment

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `8000` | Listen port |
| `EVAPOFLEX_DATA` | `~/Library/Application Support/evapoflex-rig` | SQLite DB + live run artefacts |
| `EVAPOFLEX_TOOLS` | `../Evapoflex Tools` | Scanned for `*_summary.json` |
| `EVAPOFLEX_ADMIN_USER` | `admin` | Bootstrap admin name |
| `EVAPOFLEX_ADMIN_PASSWORD` | *(generated)* | Bootstrap admin password |
| `EVAPOFLEX_HTTPS` | unset | Set when behind TLS, to mark cookies `Secure` |

### Keep run data off iCloud

Run data defaults to `~/Library/Application Support/evapoflex-rig`, **not** the
repo. On this machine macOS "Desktop & Documents Folders" sync is enabled, which
puts everything under `~/Documents` into iCloud — and handing a live SQLite
database with a WAL to a sync daemon risks corruption and stalled reads. Reads
of files under `~/Documents` were observed failing with `ETIMEDOUT`, including
6 of 13 archive summaries in one scan.

The server prints a warning at startup if its data directory is inside a synced
folder. The `Evapoflex Tools` archive folder is still under `~/Documents`, so
scans there can be slow or partial when the network is poor; the database
remains authoritative and unreadable files are reported, not dropped.

## Roles

| Role | View dashboard & archive | Run control & calibrate | Stream camera | Manage users |
|---|---|---|---|---|
| `viewer` | ✅ | | | |
| `operator` | ✅ | ✅ | ✅ | |
| `admin` | ✅ | ✅ | ✅ | ✅ |
| `camera` | | ✅ | ✅ | |

`camera` is a **device account** for the phone, deliberately not a superset of
`viewer`. The handset sits unattended with credentials saved in its browser, so
losing it should cost you the camera, not the test history.

## Putting the phone on the rig

1. As admin, open `admin.html` and create a `camera` account (e.g. `rig-camera`).
2. On the iPhone, open `https://<host>/capture.html` and sign in with it.
   The page has its own login — it never redirects to the main site login.
3. Allow camera access, then calibrate:
   - **Marker** tab → *Tap video to sample colour* → tap the marker.
   - **Aim** tab → drag to place the ring centre, pinch to size it, or let the
     wheel turn a quarter revolution and press *Auto-fit*.
4. Press **Start streaming**. Press **Record run** to persist a test.

Keep the phone plugged in and this page in the foreground — iOS suspends
capture for backgrounded tabs. The page holds a screen wake lock while
streaming and reconnects with backoff if wifi drops.

### Reaching it from outside the lab

The phone connects **outbound**, so it works from cellular or any NAT without
port forwarding. To reach the server from off-site, put a tunnel in front:

```bash
cloudflared tunnel --url http://localhost:8000
```

Set `EVAPOFLEX_HTTPS=1` so session cookies are marked `Secure`.

## Surviving a dropped connection

The phone is the only device at the rig, so when wifi goes it is the only place
data can survive. Losing the socket does **not** stop capture:

1. The page keeps capturing at the **offline rate** (default 1 fps) and writes
   frames to IndexedDB with their original capture timestamps. These wheels turn
   at well under 1 RPM, so 1 fps still oversamples the motion heavily — it is
   the frame rate, not the measurement, being traded away for outage length.
2. On reconnect the buffer is replayed oldest-first before live frames resume,
   so the angle series has no hole and the run's cumulative rotation is intact.
3. Frames captured *during* the replay join the back of the queue, so the server
   never sees timestamps out of order.

Roughly an hour of outage fits at 1 fps (3600 frames / 150 MB caps). Past that
the oldest frames are dropped, the count is reported, and the run is marked with
a `data_loss` gap rather than unwrapping across the hole and inventing rotation.

The buffer survives a page reload or a force-quit — it is replayed on the next
successful connection.

Other failure modes:

| Failure | Behaviour |
|---|---|
| Wifi drops mid-run | Capture continues on the phone; gap backfilled on reconnect |
| Server killed mid-run | Samples are flushed every ~5s; on restart the run is **rebuilt** from them (CSV, summary and plot written) rather than discarded |
| SQLite write fails | Samples stay buffered and retry; the feed is never dropped for a database error |
| Archive volume stalls | Unreadable summaries are counted and reported, never treated as deleted runs |

## Pausing for maintenance

Press **Pause** (dashboard or phone) before touching the rig. While paused the
video keeps flowing — you need to see what you are working on — but nothing is
tracked or recorded, so spinning the wheel by hand cannot enter the results.

On resume the tracker re-acquires the marker rather than extrapolating from a
velocity measured before the pause, and the paused interval is:

- excluded from the run's measured time, so `avg_rpm` is not diluted;
- excluded from the stall detector, so a pause does not read as a stalled wheel;
- recorded in the summary (`pauses`, `excluded_s`, `gaps`) with the reason you
  typed and who paused it.

Gap durations are measured from the **capture timestamps**, not the server
clock — the two are different clocks, and mixing them made `avg_rpm` read low
by however long the pause lasted.

## Metrics

`avg_rpm`, `motion_pct`, `continuity_pct` and `efficiency_pct` use the exact
definitions from `wheel_tracker_video.make_master_plot`, so a number on the live
dashboard means the same thing as the number in an archived summary. They are
computed incrementally (see `RollingMetrics`) so a feed running for weeks does
not accumulate an unbounded sample array.

`current_rpm` is a **trailing** 5s least-squares slope; the offline plot uses a
centred window, which live data cannot have.

Stopping a run writes `_angle.csv`, `_summary.json` and `_master_plot.png` in
the same formats the offline tracker emits, so downstream tools work unchanged.

## Archive import

Every `*_summary.json` under `EVAPOFLEX_TOOLS` is imported on startup and
whenever someone presses *Rescan folder*. Runs are keyed by **filename**, not by
the summary's `id` field — re-analyses share an `id`
(`EED01M_Test_1_..._active_summary.json` and `..._summary.json` both say
`EED01M_Test_1_2026-07-28`), and keying on it made one silently overwrite the
other depending on directory walk order.

## Swapping the algorithm while it runs

Algorithms live in `server/trackers/`, one file each. Drop in a file that
subclasses `TrackerBase` and it becomes selectable at runtime — no restart, no
edits anywhere else.

```
GET  /api/trackers          what is available, what is running, what failed to load
POST /api/trackers/select   {"name": "...", "force": false}
POST /api/trackers/reload   re-import every algorithm file from disk (admin)
```

Editing a tracker and calling `reload` swaps the running code without dropping
the feed. The run's accumulated rotation, sample count and metrics carry across;
only the algorithm's private state (previous frame, learned fixtures) is
cleared, and a gap is marked so the changeover is never read as a step.

A tracker implements one method:

```python
class MyTracker(TrackerBase):
    NAME = "mine"
    LABEL = "My algorithm"
    EXPECTS = "whatever markers it needs"
    DEFAULT_CALIBRATION = {...}

    def process(self, frame, t) -> dict:
        ...
        return {"locked": True, "angle": ..., "unwrapped": ...}
```

Anything else returned is passed through to the dashboard for drawing, so a new
algorithm ships its own annotations without the front end knowing about it.

A file that fails to import is reported through `/api/trackers` rather than
raised — a syntax error in one algorithm must not take down the rig, and the
message needs to reach whoever just saved the file.

### Why swapping mid-run is refused

`select` returns **409** while a run is recording. A run whose samples came from
two algorithms is not comparable with either, and the summary has a single
`tracker` field — so the result would look authoritative while silently being a
hybrid. `force` is allowed but stops the run first, so every recording has
exactly one algorithm behind it.

Each run records `tracker` **and** `tracker_hash`, a digest of the algorithm's
source. With hot reloading the code will be edited while runs are in progress,
and the name alone would not identify a version.

## How the rig is tracked

The rig carries **four green tapes spaced around the rim and one on the shaft**.
The live tracker is a streaming port of `wheel_tracker_constellation.py`:

- **The shaft tape gives the centre.** It is the one green thing that does not
  move while the wheel turns, so it is found temporally rather than
  geometrically. That matters — with four tapes at 90°, every rim tape sees its
  two neighbours at the same distance (R√2) and scores just as well as the true
  centre on any "which blob is equidistant from the others" test. It repeatedly
  won that contest and cost the frame. Nothing needs hand-calibrating, and a
  bumped camera re-fits itself on the next frame.
- **Rotation comes from consensus, not from following one tape.** Every pairing
  of a previous bearing with a current one proposes a rotation; the one most
  bearings agree on wins. Only *one* tape needs to be visible in both frames, so
  a tape passing behind the cover costs nothing.
- **Stationary green objects are excluded.** A bracket or reflection sitting in
  the rim band drags the match toward zero rotation and the wheel reads slower
  than it turns — measured **7.9% low** with a single such blob in shot. Blobs
  that stay put while the wheel turns are classified as fixtures and ignored.
  This only re-learns while the wheel is demonstrably moving: on a stalled
  wheel every real tape looks static, and rejecting them would erase the stall
  the experiment exists to measure.

### How many tapes are actually needed

The rig carries four with a cover over one, so three are in view at any moment
and the third is spare. Measured against a synthetic wheel at a known 6.000 RPM
over 160 s, with a stationary green decoy in shot throughout:

| Visible tapes | Error | Verdict |
|---|---|---|
| 4 of 4 | 0.00% | — |
| **3 of 4, cover rotating (the rig)** | **0.02%** | the operating point |
| 2 of 4 | 1.3–3.0% | works, no redundancy |
| 2 of 4, **clean frame** | **0.01%** | as good as four |
| 1 of 4 | refuses to track | below the floor |

**Two tapes is a genuine floor, not a compromise.** On a clean frame two track
to 0.01% — indistinguishable from four. What two cannot do is outvote a stray
green object: at three or more the real tapes carry the consensus, at two an
intruder is a third of it. So the dependency is not really marker count, it is
frame cleanliness — and the *Fixtures* annotation layer is how you check.

The 1.3–3.0% seen with two tapes plus a decoy is almost entirely the ~40-frame
window before fixture rejection engages (5 s at 8 fps): quadrupling the run
length quartered the error. Over a multi-hour test it is negligible.

One tape is refused outright. A lone bearing has no consensus to check against,
so a mis-detection would enter the results unchallenged.

`min_markers` (default 2) sets the floor; it will not go below 2.

Accuracy against a synthetic wheel at a known 6.000 RPM, with one tape occluded
on rotation and a stray green fixture in shot: **0.22% RPM error** over 90s,
100% motion / continuity / efficiency, ~6 ms of tracking per frame.

### Annotations

The live page draws what the tracker actually saw — hub crosshair, rim circle
and tolerance band, each accepted tape with its bearing, spokes, rejected
blobs, fixtures, and the per-frame Δ. Every layer toggles independently: the
full set is useful while aiming the camera, distracting once it is running.

## Latency

The point of tracking a live feed is that the numbers describe *now*, so
staleness is treated as a defect:

- The phone **drops** frames when the uplink is congested rather than queueing
  or buffering them. A held-back frame arrives describing the past, and the
  statistics would then be computed from a stale picture. At 8 fps on a sub-1
  RPM wheel a dropped frame costs nothing measurable; seconds of lag on the
  numbers costs a lot. Buffering happens only when genuinely offline.
- Frames carry the phone's capture timestamp, so the time axis is correct even
  when delivery is not.
- Round-trip latency is measured **on the phone's own clock** (the server
  echoes a stamp back), needing no clock sync, and is shown on both the phone
  and the dashboard. Server-side per-frame tracking time is shown alongside it.

## Known limitations

**Warm-up.** Fixture classification needs 40 frames of a turning wheel before it
takes effect, so the first few seconds of a run can include a stray green object
in the match. Measured cost: ~7° of rotation on a 30 s run, proportionally
negligible over a real multi-hour test.

**Everything green is a candidate.** The tracker keys on colour alone. A green
object that *moves* — a reflection sweeping across the rim, someone in a green
sleeve reaching in — is not a fixture and will not be rejected. Keep the frame
clean, and use the *Rejected* and *Fixtures* annotation layers to see what the
tracker is doing with anything questionable.

**Symmetry.** Four tapes at 90° means a rotation of exactly 90° between two
samples is indistinguishable from no rotation. `max_step_deg` (25° by default)
rules that out; at the rig's speeds the wheel turns well under 1° between
frames, so this is only a concern if the frame rate collapses to a fraction of
1 fps.

## Tests

`server/` has no unit tests; verification was done end-to-end against a
synthetic rotating marker at a known RPM (0.01% error over 45s), including role
enforcement, concurrent read load, and event-loop responsiveness during a run
stop.
