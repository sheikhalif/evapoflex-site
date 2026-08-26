# Getting the rig live — start to finish

Work through this in order. Steps 1–5 get it running on your Mac and prove it
works; 6–9 move it off your laptop and make the feed crisp. Every command below was run on this machine while writing it.

Nothing is running right now: the LaunchAgent is unloaded and no server is up.

---

## What you are deploying

Two halves, on two origins, because they need different things:

| | Where | Why |
|---|---|---|
| `evaporationengine.net` | Cloudflare Pages (as today) | static, edge-cached, nothing to keep alive |
| `rig.evaporationengine.net` | the Python server in `server/` | needs a live process, WebSockets, and a disk |

Only **`index.html`** changed on the static side. `live.html`, `console.html`,
`capture.html`, `runs.html` and `admin.html` are served by the rig — put them on
Pages and they will load and then fail every request, because there is no API
behind them there.

The pages:

| Page | Who | What |
|---|---|---|
| `live.html` | **public** | the visitor page: video, speed, 3-hour trend |
| `console.html` | operator | annotations, run control, algorithm switching |
| `capture.html` | the phone | camera uplink |
| `runs.html` | signed in | archive of every test run |
| `admin.html` | admin | accounts, and Claude-authored algorithms |

---

## 1. Install dependencies

```bash
cd ~/Documents/evapoflex-site
pip3 install -r server/requirements.txt
```

`anthropic` in that list is only for the admin "write a tracking algorithm"
feature. The rig runs fine without it — that one endpoint returns a 502 naming
the missing import.

---

## 2. Test locally before touching anything permanent

Run against a scratch directory so nothing can disturb your real run data:

```bash
EVAPOFLEX_DATA=/tmp/rig-test PORT=8099 python3 server/app.py
```

First start prints a generated admin password **once**:

```
  First run - created an admin account.
    username: admin
    password: M7QTtpySdZ2a6j03
```

It also imports your existing archive from the tools folder — expect
`archive import: {'added': 14, ...}`.

**You do not need the iPhone to test this.** `localhost` is a secure context, so
`capture.html` uses your Mac's webcam. Point it at something green — a sticky
note on a mug you turn by hand:

1. `localhost:8099/capture.html` → sign in → **Marker** tab → tap the green
   object to sample its real colour under real lighting
2. **Start streaming**, then **Record run**
3. `localhost:8099/live.html` — the public view
4. `localhost:8099/console.html` — the operator view, annotations and controls
5. **Stop & save** → it appears in `runs.html` with CSV, plot and stats

Two failure paths worth exercising deliberately, because they are the ones that
bite in the field:

- **Ctrl-C the server mid-run**, then start it again — the run rebuilds from
  samples already flushed to SQLite
- **Turn wifi off mid-run** — watch the buffer counter climb on the capture
  page, then the *Restoring buffered data* badge when it reconnects

`rm -rf /tmp/rig-test` afterwards and the test accounts and runs go with it.

---

## 3. Sort out the accounts

The real database (`~/Library/Application Support/evapoflex-rig`) currently has
five accounts left over from development, and **two of them are misleading**:

| Username | Role | Problem |
|---|---|---|
| `admin` | admin | still on a development password |
| `viewer` | **camera** | named "viewer" but can stream and drive runs |
| `camera` | camera | duplicate of `rig-camera` |
| `rig-camera` | camera | still on a development password |
| `watcher` | viewer | still on a development password |

`viewer` having the **camera** role is the one to fix first — anyone reading the
account list would assume it is read-only, and it is not.

The development passwords are deliberately not written down here, because this
file travels. If you no longer have them: delete the `admin` row from the
database and restart, and the server bootstraps a fresh admin and prints a
generated password once (`grep -A3 "created an admin" ~/Library/Logs/evapoflex-rig.log`).
Runs are untouched.

Start the server (step 2, but without `EVAPOFLEX_DATA` so it uses the real
database), open `/admin.html`, and:

- Delete `viewer` and `camera` — duplicates and mislabelled
- Set real passwords on `admin`, `rig-camera` and `watcher`

Roles, for reference:

| Role | Can |
|---|---|
| `viewer` | watch the live feed, read the run archive |
| `operator` | that, plus start/stop runs, calibrate, stream |
| `camera` | stream and drive runs, but **cannot** read the archive or manage accounts — this is what the mounted phone uses |
| `admin` | everything, including account management and algorithm authoring |

The camera role is deliberately narrow: if the mounted phone walks off, the
finder cannot read your test data.

---

## 4. Run it as a service

```bash
cp server/com.evapoflex.rig.plist ~/Library/LaunchAgents/
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.evapoflex.rig.plist
launchctl list | grep evapoflex          # a PID and a 0 = running
tail -f ~/Library/Logs/evapoflex-rig.log
```

The plist already sets `PORT=8099`, `EVAPOFLEX_HTTPS=1`, the data directory
(Application Support — deliberately **not** iCloud-synced) and the tools folder,
and wraps the process in `caffeinate -s` so the Mac does not sleep the rig.

**Once this is loaded it *is* your server.** Do not also run
`python3 server/app.py` by hand — the second copy cannot bind 8099 and exits
with `[Errno 48] address already in use`. That message means the service is
working, not that something is broken.

If `launchctl` says `Input/output error` (errno 5), that almost always means
"already loaded". Check `launchctl list | grep evapoflex` — a PID and a `0`
means it is fine. To genuinely reload:

```bash
launchctl bootout gui/$(id -u)/com.evapoflex.rig
sleep 5
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.evapoflex.rig.plist
```

The `sleep` matters — bootstrapping immediately after a bootout is what produces
the transient errno 5.

To stop it completely: `launchctl bootout gui/$(id -u)/com.evapoflex.rig`, and
delete `~/Library/LaunchAgents/com.evapoflex.rig.plist` if you do not want it
coming back at next login.

---

## 5. Let Claude write algorithms (optional)

You want this on your plan rather than an API key. The SDK resolves credentials
in this order, first match wins:

```
ANTHROPIC_API_KEY  →  ANTHROPIC_AUTH_TOKEN  →  OAuth profile from `ant auth login`  →  WIF  →  default profile
```

`authoring.py` constructs a bare `anthropic.Anthropic()`, so an OAuth profile is
picked up with **no code change**:

```bash
brew install anthropics/tap/ant
xattr -d com.apple.quarantine "$(brew --prefix)/bin/ant"
ant auth login          # opens a browser
ant auth status         # shows which credential source won
```

Three things specific to running this under launchd:

1. **Do not put `ANTHROPIC_API_KEY` in the plist.** A set key silently outranks
   the profile — even an empty string wins its slot. That is the single most
   common way this ends up billing somewhere you did not intend.
2. **The service needs `HOME`.** The profile lives at `~/.config/anthropic/`.
   A GUI LaunchAgent normally inherits `HOME`, but if authoring fails with "no
   credentials" while `ant auth status` looks fine in your shell, that is why —
   add `HOME` to the plist's `EnvironmentVariables`.
3. **Refresh tokens hard-expire** — they do not slide with use. On a 24/7 rig,
   authoring will eventually start failing auth after working for weeks.
   `ant auth login` again fixes it. Knowing this saves you debugging a code
   regression that is not one.

I could not verify from here which billing surface an OAuth profile draws on for
your account — plan limits versus API credits. `ant auth status` plus your
Console usage after the first generation will tell you. If it turns out to bill
as API usage, the fix is which credential you log in with, not the code.

**Using it:** admin.html → *Sample & write*. It takes frames from the live feed
(so the camera must be streaming), sends them with the current calibration, and
Claude writes a tracker for the markers it can actually see. It shows you what
it saw, why it chose that approach, and the full source.

**It does not switch the algorithm on.** It writes the file and stops. Read it,
then select it on the console. That is deliberate: the model is working from a
handful of JPEGs, and the code runs unsandboxed on the machine holding every
test result.

---

## 6. Move it to a server

### Why not the tunnel-to-laptop setup

That is what made the feed unwatchable. With `cloudflared` pointing at your Mac:

```
phone  → Cloudflare → your Mac      (down)
viewer → Cloudflare → your Mac      (UP — one full copy per viewer)
```

Your Mac's **uplink** carried a copy of the video for every watcher. And the Mac
was on USB tethering from the iPhone, so that uplink *was* the phone's cellular
— the same link carrying the stream up, back down, and up again. Measured
bitrate at the settings you were using (960×540, 8 fps, MJPEG) is **7 Mbps for
one copy**. Nothing you can set on the capture page fixes that.

A VPS has symmetric gigabit, so fan-out costs nothing. Combined with §7 (the
SFU), the video stops passing through the server entirely.

### Provision the box

Create a **Hetzner CPX11** (2 vCPU, 2 GB, 20 TB traffic, ~€4.35/mo), Debian 12.
Bandwidth is the deciding spec — DigitalOcean bills overage past 1 TB.

```bash
# on the VPS, as root
apt-get update && apt-get install -y git
git clone <your repo> /tmp/site   # or scp the folder up
bash /tmp/site/server/deploy/provision.sh
```

That installs Python, Caddy, a service account, a virtualenv, the systemd unit
and `/etc/evapoflex.env` (mode 600 — credentials never go in the unit file).

### Push the site and start it

```bash
# from your Mac
./server/deploy/push.sh root@<vps-ip>
```

`push.sh` rsyncs the working tree, installs dependencies, restarts the service
and **fails loudly with the last 30 log lines** if it does not come back up.

Point DNS at the box: an `A` record for `rig.evaporationengine.net`. Leave
Cloudflare's orange cloud **on** — it absorbs abuse on a public feed.

```bash
systemctl enable --now evapoflex caddy
journalctl -u evapoflex -f
```

Caddy gets a Let's Encrypt certificate automatically. That certificate is not
cosmetic: Safari refuses camera access to any origin that is not a secure
context, so without it the phone cannot publish at all.

Turn on Hetzner's daily snapshots (+20%). The rig's entire state is
`/var/lib/evapoflex`.

---

## 7. Turn on WebRTC video (this is the crispness fix)

MJPEG re-sends every frame whole. The rig scene is nearly static — only the
tapes move — which is exactly what inter-frame compression exploits. Encoding
the real scene both ways, 10 s at 15 fps, 960×540:

| | Bitrate |
|---|---|
| MJPEG (frames over our WebSocket) | 1.61 Mbps |
| H.264 (what WebRTC uses) | 0.05 Mbps |

**34× smaller.** A real camera's sensor noise narrows that to perhaps 10–20×,
still transformative. So: the phone publishes H.264 to an SFU, viewers subscribe
from the SFU, and the video never touches our server.

Create a project at **[LiveKit Cloud](https://cloud.livekit.io)** (free tier is
ample for one camera), then put the three values in `/etc/evapoflex.env`:

```
EVAPOFLEX_LIVEKIT_URL=wss://<project>.livekit.cloud
EVAPOFLEX_LIVEKIT_KEY=API...
EVAPOFLEX_LIVEKIT_SECRET=...
```

```bash
systemctl restart evapoflex
curl -s https://rig.evaporationengine.net/api/stream/config
# {"enabled":true,"url":"wss://...","room":"rig"}
```

**Nothing else changes.** The tracking path keeps sending JPEGs over the
WebSocket — it just drops to 2 fps, because tracking and viewing want opposite
things:

| | wants |
|---|---|
| viewing | frame rate, sharpness |
| tracking | marker geometry, a few frames a second |

At 0.8 RPM the wheel turns 2.4° between frames at 2 fps — far finer than the
tracker needs, and about 0.2 Mbps.

**If the SFU is not configured, or is unreachable, everything still works** —
the pages fall back to frames over the WebSocket exactly as before. That
fallback is what lets you run the rig before the SFU exists, and what it
degrades to rather than going dark.

Token safety: viewer tokens are handed out without a login (the feed is public)
but carry `canPublish: false`, so one cannot be replayed to push video into the
room. Only accounts with the `stream` permission get a publishing token.

---

## 8. Deploy the landing page

Publish the changed `index.html` to Cloudflare Pages the way you do now
(drag-and-drop, or `wrangler pages deploy .`).

The hero button says **Live Feed** and carries an absolute URL to
`rig.evaporationengine.net/live.html`. Its dot only pulses when the rig is
actually streaming — it reads `/api/live/overview` cross-origin, which is why
the server has a CORS allowlist for `evaporationengine.net`. If you ever change
the domain, update `EVAPOFLEX_ALLOWED_ORIGINS`.

---

## 9. Point the phone at it

Open **`https://rig.evaporationengine.net/capture.html`** and sign in as
`rig-camera`.

HTTPS is the whole point: Safari refuses camera access otherwise, and reports it
as a missing API rather than a permission error — there is an in-page
explanation for exactly that trap. The phone connects outbound, so this works
over a hotspot with no port forwarding.

Then:

1. **Marker** tab → tap a green tape to sample its real colour and lighting
2. **Aim** tab → only if the shaft marker is hidden; otherwise the centre and
   radius are found automatically every frame
3. **Start streaming**
4. Watch from `rig.evaporationengine.net/console.html` as an operator

**Leave the send-rate slider alone if the SFU is on.** The page switches the
JPEG path to 2 fps automatically once it is publishing, and the slider then only
affects the fallback. If you are running *without* the SFU, set it as high as
the link sustains and drop the frame width to 640 px — the tracker's accuracy
does not depend on resolution (blob areas are measured as a fraction of the
frame), so width buys you picture quality and nothing else.

---

## Before you announce it

- [ ] `viewer` and `camera` accounts deleted, real passwords on the rest
- [ ] Capture rate at 2 fps
- [ ] Marker colour sampled on the real wheel under real lighting — the default
      green range is generic and was last reset by me
- [ ] `https://rig.evaporationengine.net/live.html` loads signed out, in a
      private window
- [ ] `console.html` redirects to the login when signed out

---

## When something looks wrong

| Symptom | Cause |
|---|---|
| `[Errno 48] address already in use` | The service is already running. That is the healthy case — do not start a second copy. |
| `launchctl` → `Input/output error` | Almost always "already loaded". Check `launchctl list \| grep evapoflex`. |
| Phone says camera needs HTTPS | You reached it over `http://`. Use the tunnel hostname. |
| Landing-page dot never lights | The rig is down, or the domain is not in `EVAPOFLEX_ALLOWED_ORIGINS`. |
| Feed reconnects every ~90s | `originRequest` missing from the tunnel config. |
| Dashboard warns "shaft marker not visible" | The centre tape is out of frame or unlit. Readings drift while that persists — it is warned rather than silently wrong. |
| Authoring returns 502 | `pip3 install anthropic`, or no credential the service can see (§5). |

Logs: `tail -f ~/Library/Logs/evapoflex-rig.log`
