# Running the rig for a multi-day test

Everything here is run **by you** — installing a background service, opening a
public tunnel and setting passwords are all actions I'm not permitted to take
on your machine.

Two terminal windows, both left open for the duration:

- **Terminal A** — the rig server (via `launchd`, so it survives crashes)
- **Terminal B** — the Cloudflare tunnel (gives the phone an HTTPS address)

---

## 1. Install the server as a background service

```bash
cd ~/Documents/evapoflex-site
cp server/com.evapoflex.rig.plist ~/Library/LaunchAgents/
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.evapoflex.rig.plist
```

Check it came up:

```bash
launchctl list | grep evapoflex          # a PID in the first column = running
tail -f ~/Library/Logs/evapoflex-rig.log
```

Expect `Application startup complete` and `Uvicorn running on http://0.0.0.0:8099`.

**Once this is loaded, it *is* your server.** Do not also run
`python3 server/app.py` by hand — the second copy cannot bind port 8099 and
exits with `[Errno 48] address already in use`. That message means the service
is working, not that something is broken.

### If `launchctl` complains

- **`Load failed: 5: Input/output error`** — almost always "already loaded".
  Confirm with `launchctl list | grep evapoflex`; a PID and a `0` means it is
  running fine and the error can be ignored. To genuinely reload:

  ```bash
  launchctl bootout gui/$(id -u)/com.evapoflex.rig 2>/dev/null
  launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.evapoflex.rig.plist
  ```

- **`Bootstrap failed: 5`** with nothing in `launchctl list` — a real failure.
  Check `~/Library/Logs/evapoflex-rig.log`; usually a wrong path in the plist.

`load`/`unload` still work on current macOS but are deprecated and report
errors poorly; `bootstrap`/`bootout` give usable messages.

What this gives you:

- **Restarts automatically** if the server crashes or you log out and back in.
  A run interrupted that way is rebuilt from the samples already flushed to
  SQLite, so a crash costs seconds rather than the run.
- **Keeps the Mac awake** — the server runs under `caffeinate -s`, which blocks
  idle sleep for as long as it is alive.
- **Stores data outside iCloud**, in
  `~/Library/Application Support/evapoflex-rig`. Your `~/Documents` folder is
  iCloud-synced, and a live SQLite database is exactly the wrong thing to hand
  to a sync daemon.

Stop it with:

```bash
launchctl bootout gui/$(id -u)/com.evapoflex.rig
```

## 2. Set up accounts

Open **http://localhost:8099/admin.html**.

### Which password?

The service reads `~/Library/Application Support/evapoflex-rig`, which is a
**different database** from any `EVAPOFLEX_DATA=/tmp/...` you used while
testing. Accounts do not carry across. Check which one you are talking to:

```bash
grep '^\[evapoflex\] data' ~/Library/Logs/evapoflex-rig.log | tail -1
```

An admin password is generated **only** when a database is created empty, and
printed once:

```bash
grep -A3 "created an admin" ~/Library/Logs/evapoflex-rig.log
```

No output means the database already had accounts. To list them (usernames
only — passwords are hashed and unrecoverable):

```bash
python3 -c "
import sqlite3
db = sqlite3.connect('$HOME/Library/Application Support/evapoflex-rig/evapoflex.db')
for u, r in db.execute('SELECT username, role FROM users ORDER BY username'):
    print(f'{u:<14}{r}')"
```

If you are locked out entirely, delete the `users` row for `admin` and restart
the service — it will bootstrap a fresh admin and print the password. Runs are
untouched.

Then create these, with real passwords:

| Username | Role | Used by |
|---|---|---|
| `rig-camera` | camera | the mounted phone |
| *(your name)* | admin | you, from the laptop |
| `viewer` | viewer | anyone who should watch but not touch |

Do this **before** step 3. The tunnel URL is reachable by anyone who has it, so
no weak passwords should exist by the time it opens.

`camera` deliberately cannot read the archive or manage users — the phone sits
unattended with its credentials saved in a browser, so a stolen handset should
cost you the camera, not the test history.

## 3. Open the tunnel

In **Terminal B**, and leave it running:

```bash
cloudflared tunnel --url http://localhost:8099
```

It prints a URL like `https://<random-words>.trycloudflare.com`. This is what
the phone uses. Camera access requires HTTPS — Safari refuses over plain
`http://` and reports it as a missing API rather than a permission problem.

**The URL changes every time you restart the tunnel.** For a multi-day run,
leave Terminal B open. If it does restart, re-open the new URL on the phone.

## 4. Set up the phone

1. Open `https://<tunnel-url>/capture.html`, sign in as `rig-camera`.
2. Allow camera access.
3. **Marker** tab → *Tap video to sample colour* → tap one of the green tapes.
   Do this under the lighting the run will actually happen in.
4. **Aim** tab → confirm the ring sits on the path the tapes travel. With the
   shaft tape visible this is usually already correct — the hub and radius are
   re-derived every frame.
5. **Start streaming**. Check the readout: *Lock* should be high and *Tapes*
   should show 4 (or 3 when one is behind the cover).
6. **Record run**.

Then leave the phone:

- **plugged into power**
- **screen on, this page in the foreground**

iOS suspends background tabs. The page holds a screen wake lock while
streaming, but switching apps or locking the phone stops capture entirely.
This is the single most likely way to lose data.

## 5. Watching from the laptop

**http://localhost:8099/live.html** — feed, annotations, live statistics.
**http://localhost:8099/runs.html** — the archive, including the run in progress.

You can close the laptop lid or shut it down; see below for what happens.
Nothing about viewing affects recording.

---

## What survives what

| Event | Result |
|---|---|
| You close the dashboard | Nothing. Viewing is passive. |
| Server crashes | `launchd` restarts it; run rebuilt from flushed samples. |
| Laptop loses network | Phone buffers locally, replays on reconnect. **No loss.** |
| Laptop sleeps or shuts down | Same — phone buffers up to **~13 hours**. |
| Outage longer than ~13 h | Oldest frames dropped, recorded as an explicit `data_loss` gap rather than guessed at. |
| **Phone locks or you switch apps** | **Capture stops.** Nothing is buffered — the page is suspended. |

Offline frames are stored at 480px and low quality — enough to locate green
tape, not to watch. That is what buys 13 hours instead of 1. The capture page
shows remaining headroom in hours.

## Daily checks

- **Capture page on the phone**: still streaming, *Lock* high, headroom healthy.
- **Dashboard**: the banner is empty. It calls out a lost camera, a marker it
  cannot find, dropped frames or an active pause.
- **Continuity score**: a sustained drop means the wheel is stalling *or* the
  tracker is struggling. The *Rejected* and *Fixtures* annotation layers show
  which.

## Maintenance mid-run

Press **Pause** (either page) before touching the rig. Video keeps flowing so
you can see what you are doing, but nothing is measured — so turning the wheel
by hand cannot enter the results. The paused interval is excluded from the
run's time and from the stall detector, and recorded with the reason you type.

Press **Resume** when done. **Stop & save** ends the run and writes the CSV,
summary and master plot in the same formats the offline tracker produces.

## If something looks wrong

```bash
tail -100 ~/Library/Logs/evapoflex-rig.log
```

- **Tapes not detected** — re-sample the colour on the phone; lighting drifts.
  Widen *Hue width* only if the lock keeps dropping.
- **Wheel reads slower than it turns** — a stationary green object is being
  matched. Turn on the *Fixtures* layer; it should be circled in amber and
  ignored. If it is not, take it out of frame.
- **Calibration wedged** — reset it:
  ```bash
  curl -X POST http://localhost:8099/api/live/calibrate \
       -H 'Content-Type: application/json' -d '{"mode":"reset"}' -b cookies.txt
  ```
  or just re-sample from the phone.
