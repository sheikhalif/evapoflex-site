# Evapoflex — live rig monitoring

## What this is

Evapoflex builds **evaporation engines**: wheels that turn using energy released
as water evaporates from the air. This repository is the company website plus a
system for **watching a prototype wheel turn, in public, and measuring how fast
it goes**.

The measurement is the point. A wheel that turns at 0.8 RPM for six hours and
then stalls for twenty minutes is telling you something about the design, and
the whole system exists to catch that faithfully rather than to produce a
flattering number.

There was already an offline pipeline: record a video of a test, run a Python
tracker over it afterwards, get a CSV, a plot and a summary. That still exists
(`Evapoflex Tools/`, outside this repo). What was added here is the **live**
half — a phone bolted to the rig streaming continuously, tracked frame by frame
as it arrives, published on the public site.

The design constraint that shaped everything: **live numbers must mean exactly
what the offline numbers mean.** A run recorded live and a run processed offline
have to be comparable, or the live system is a toy.

---

## The shape of it

```
   iPhone at the rig
        │
        ├── WebRTC (H.264) ──→ LiveKit SFU ──→ viewers      crisp video, fan-out
        │                                                    never touches us
        └── JPEG @2fps over WebSocket ──→ rig server
                                              │
                                    ┌─────────┴─────────┐
                                    │  tracker           │  angle per frame
                                    │  rolling metrics   │  RPM, motion, stalls
                                    │  SQLite            │  runs + samples
                                    └─────────┬─────────┘
                                              │
                                    stats over WebSocket
                                              │
                        ┌─────────────────────┴──────────────┐
                        │                                    │
                   live.html                            console.html
                   (public)                             (operators)
```

Two origins, because the halves need different things:

| | Where | Why |
|---|---|---|
| `evaporationengine.net` | Cloudflare Pages | static, edge-cached, nothing to keep alive |
| `rig.evaporationengine.net` | the Python server | live process, WebSockets, a disk |

Only `index.html` belongs on Pages. `live.html`, `console.html`, `capture.html`,
`runs.html` and `admin.html` are served by the rig — on Pages they load and then
fail every request.

### Pages

| Page | Who | What |
|---|---|---|
| `live.html` | **public, no login** | the visitor view: video, current speed, 3-hour trend |
| `console.html` | operator | annotations, run control, algorithm switching, feed health |
| `capture.html` | the mounted phone | camera uplink, calibration, its own login |
| `runs.html` | signed in | every test run, live and offline, with CSV/plot/stats |
| `admin.html` | admin | accounts, and Claude-authored tracking algorithms |
| `index.html`, `archive.html` | public | the existing marketing site |

### Server modules

| File | Responsibility |
|---|---|
| `app.py` | HTTP + WebSocket routes, auth gating, page serving |
| `rig.py` | live state: one feed, one tracker, many viewers; run recording |
| `tracker.py` | shared metric definitions and `RollingMetrics` |
| `trackers/` | tracking algorithms, one per file, hot-swappable |
| `store.py` | SQLite: users, runs, samples, settings, archive import |
| `auth.py` | sessions, roles, password hashing |
| `stream.py` | SFU tokens (HS256 JWT, stdlib only) |
| `authoring.py` | asks Claude to write a tracker from sample frames |
| `deploy/` | systemd unit, Caddyfile, provision and push scripts |

---

## The tracking algorithm

This is the part where being wrong is expensive, so it deserves detail.

**The rig:** four green tapes spaced around the wheel's rim, plus one on the
shaft. A cover hides one rim tape at a time, so **three are visible at any
moment**.

**Why the obvious approach fails.** The original offline tracker followed a
single unique marker and unwrapped its angle mod 360°. Four identical tapes
break that outright — you cannot tell them apart, and unwrapping needs mod 90°.

**What it does instead** (ported from `wheel_tracker_constellation.py`): each
frame yields a *set* of marker bearings. The rotation between two frames is
whichever shift best superimposes this frame's set onto the last — RANSAC on a
circle. Only **one tape needs to be visible in both frames**, so a tape passing
behind the cover costs nothing.

**The shaft tape gives the centre — found temporally, not geometrically.** It is
the one green thing that does not move while the wheel turns. This matters more
than it sounds: with four tapes at 90°, every rim tape sees its two neighbours at
the same distance (R√2) and therefore scores just as well as the true centre on
any "which blob is equidistant from the others" test. Geometry alone repeatedly
picked a rim tape as the hub and threw the frame away.

**Stationary green objects are excluded.** A bracket or reflection sitting in the
rim band drags the frame-to-frame match toward zero rotation, and the wheel then
reads *slower than it turns* — measured 7.9% low with a single such blob in
shot. Blobs that stay put while the wheel turns are classified as fixtures and
ignored.

The critical guard: this only re-learns **while the wheel is demonstrably
moving**. On a stalled wheel every real tape looks static, and rejecting them
would erase exactly the stall the experiment exists to measure.

**Accuracy**, against a synthetic wheel at a known 6.000 RPM with a stray green
fixture in shot, over 160 s:

| Visible tapes | Error |
|---|---|
| 4 of 4 | 0.00% |
| **3 of 4, cover rotating (the rig)** | **0.02%** |
| 2 of 4 | 1.3–3.0% |
| 2 of 4, clean frame | 0.01% |
| 1 of 4 | refuses to track |

Two tapes is a genuine floor, not a compromise: on a clean frame two track as
well as four. What two *cannot* do is outvote a stray green object — at three or
more the real tapes carry the consensus. So the real dependency is frame
cleanliness, not marker count. One tape is refused outright: a lone bearing has
no consensus to check against, so a mis-detection would enter the results
unchallenged.

### Metrics

Copied exactly from `wheel_tracker_video.make_master_plot`, so a number shown
live means the same thing as the number in an archived summary:

- `avg_rpm` — net unwrapped degrees / elapsed
- `motion_pct` — % of samples that are not a backwards step
- `continuity_pct` — % not inside a stall run (3+ consecutive flat steps)
- `efficiency_pct` — % that are neither

Stall detection is retroactive in the original (hitting the third flat step
marks the two before it), so the live version holds flats in a pending queue
until the run either reaches the threshold or breaks. That costs at most two
samples of lag and keeps the percentages identical.

---

## Design decisions worth knowing

**The tracker runs whenever the feed is up, not only during a run.** "How has it
been running?" should never require someone to have remembered to press Record.
A *run* is a separate, explicit recording window that persists samples and, on
stop, writes the same CSV + summary.json + master plot the offline tracker
emits.

**Outages do not lose data.** The phone buffers frames to IndexedDB while
offline and replays them on reconnect. A mid-run reconnect does a `soft_reset` —
drops the marker lock but keeps cumulative rotation and metrics — because a full
reset would silently restart the run's rotation count at zero.

**Maintenance pauses are excluded from the metrics, and recorded.** Nudging the
wheel by hand during a pause must not land in the cumulative rotation, and a
ten-minute pause must not read as a ten-minute stall.

**Public means visible, not touchable.** `live.html` needs no login. Every
action — start/stop a run, calibrate, switch algorithm, read the archive — is
gated separately at the API. Verified by test: every control endpoint returns
401 to an anonymous caller.

**Video and tracking are separate paths.** They want opposite things: viewing
wants frame rate and sharpness, tracking wants marker geometry a few times a
second. At 0.8 RPM the wheel turns 2.4° between frames at 2 fps.

**Generated algorithms are never auto-activated.** `admin.html` can ask Claude
to write a tracker from sample frames; it writes the file and stops. The model
is working from a handful of JPEGs, and the code runs unsandboxed on the machine
holding every test result. A human reads it first.

**Runs record which code produced them** — algorithm name *and* a hash of its
source. With hot reloading the code gets edited while runs are in progress, so
the name alone does not identify a version.

---

## How it got here

Roughly chronological. The bugs are included because the reasoning behind the
fixes is the useful part.

**Data directory.** The first database lived under `~/Documents`, which on this
Mac is iCloud-synced. A live SQLite file with a WAL is the worst possible thing
to hand a sync daemon — it copies the pieces independently and can evict them.
Reads started timing out mid-run. Data moved to Application Support.

**Wrong algorithm entirely.** The first tracker was a port of the *single*-marker
offline tool. Only later did it emerge that the rig has four identical tapes
plus a hub — which that algorithm cannot handle at all. Rewritten around the
constellation matcher.

**The 7.9% slow reading.** A stationary green fixture in the rim band was
dragging the match toward zero rotation. The offline tool has a `--reject-static`
pre-scan for exactly this; a live feed cannot pre-scan, so fixtures are learned
continuously — gated on the wheel actually moving, so a stall does not erase
itself.

**Hub identification, three attempts.** Equidistance alone picked rim tapes
(they see their neighbours at R√2). Adding angular spread helped. What finally
worked was temporal: the hub is the green thing that does not move. Then a
follow-up — if the shaft tape is *absent*, the only stationary blob may be a
fixture, and adopting it as the centre put the whole rim off. Now guarded three
ways, and a lost shaft marker is **warned about** rather than silently biasing
results.

**A gate that fired once and never again.** The check for "has the wheel turned
enough to judge fixtures?" measured rotation since the *previous frame* (~3.6°)
instead of across the window. It sat permanently under the threshold, so
classification ran once, at frame 40, and never again. Any rig whose conditions
were not right at that instant got no fixture rejection for the entire run.

**Concurrency.** SQLite writes and `asyncio.Queue` fan-out were both happening
on a worker thread. A transient "database is locked" killed the phone's socket
mid-run and took the recording with it. Restructured so the worker thread does
only CPU work and the event loop owns SQLite and asyncio.

**A 15-second freeze on every run stop.** Rendering the matplotlib master plot
blocked the event loop, stalling the phone's uplink and every dashboard. Moved
off-loop and the module cached: 15.2 s → 2.0 s cold → 0.13 s warm, with the loop
staying responsive throughout (worst probe latency 8 ms).

**Archive imports silently overwrote each other.** Two summaries for the same
test (a full-run analysis and an "active window" one) share an `id`, so
whichever `os.walk` reached last won — non-deterministically. Keyed on filename
instead.

**The feed was unwatchable.** Diagnosed late and it was architectural, not a
setting. With `cloudflared` tunnelling to a laptop, viewers pull *through* that
laptop — so its uplink carried a full copy of the stream **per viewer**, on top
of receiving it. And the laptop was on USB tethering from the iPhone, so that
uplink *was* the phone's cellular: one link carrying the video up, back down,
and up again. MJPEG at the settings in use measured 7 Mbps for one copy.

Encoding the actual rig scene both ways settled the transport question — the
wheel is nearly static, only the tapes move, which is precisely what inter-frame
compression exploits:

| 10 s, 960×540, 15 fps | Bitrate |
|---|---|
| MJPEG | 1.61 Mbps |
| H.264 | 0.05 Mbps |

Hence WebRTC via an SFU, and a move off the laptop entirely.

**Two honesty bugs on the public page**, caught while verifying: the 3-hour trend
drew a straight line across a feed gap, inventing readings for minutes the
camera was down; and "Turning at 6.001 rpm" displayed under an OFFLINE badge. A
speed is a claim about *now* — the live figures now blank when the camera drops,
while the trend stays, because that is history and still true.

---

## State

**Verified** (all runnable, on this machine):

| | |
|---|---|
| Tracker accuracy across visibility levels | 6/7 — the failure is the documented shaft-occluded case |
| Plugin machinery (load, hot-reload, state carry-over, bad file) | 13/13 |
| Public/private boundary and CORS | 18/18 |
| SFU token signing and gating | 23/23 |
| No-SFU fallback | 5/5 |
| Fresh-install path | verified end to end |

**Not verified — needs hardware or accounts I do not have:**

- **WebRTC publish/subscribe end to end.** Token signing, endpoint gating and
  the fallback are tested; the actual handshake needs a real LiveKit project and
  the phone. This is the largest untested surface.
- **The real wheel.** Everything is measured against a synthetic rig. The green
  HSV range is generic and must be sampled on the real tapes under real
  lighting.
- **The Hetzner deployment scripts** are written but have not been run on a box.

**Known limitations:**

- Fixture classification needs ~40 frames of a turning wheel to engage. Costs
  ~7° on a 30 s run; negligible over hours.
- Everything green is a candidate. A green object that *moves* is not a fixture
  and will not be rejected.
- Four tapes at 90° means a rotation of exactly 90° between samples is
  indistinguishable from none. `max_step_deg` (25°) rules it out; only a concern
  if the frame rate collapses below ~1 fps.
- No video is stored. A changed algorithm cannot be re-run on past footage —
  new code applies going forward only. This was a deliberate choice.

**Outstanding before going live:** the accounts. Five remain from development
and one is a trap — `viewer` has the **camera** role, so despite the name it can
stream and drive runs. `camera` duplicates `rig-camera`. All passwords are
development ones.

---

## Where to start

1. `server/SETUP.md` — nine steps from nothing to live, tested on this machine
2. `server/README.md` — how the tracking works, in depth
3. `server/RUNNING.md` — running it as a service, troubleshooting
4. `server/DEPLOY.md` — the two-origin split and hosting options

Run it locally in one command:

```bash
pip3 install -r server/requirements.txt
EVAPOFLEX_DATA=/tmp/rig-test PORT=8099 python3 server/app.py
```

It prints a generated admin password once. `localhost` is a secure context, so
`capture.html` will use your laptop's webcam — point it at something green and
the whole system is exercisable without the rig.
