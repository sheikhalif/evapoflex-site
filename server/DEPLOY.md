# Going live on evaporationengine.net

The site is split across two origins, because the two halves have genuinely
different needs:

| | Where | Why |
|---|---|---|
| `evaporationengine.net` | Cloudflare Pages (as today) | static, cached at the edge, free, nothing to keep alive |
| `rig.evaporationengine.net` | this Python server | needs a live process, WebSockets, and a disk |

The landing page button points at the rig subdomain with an absolute URL, so
the two deploy independently. Because the live feed is **public**, a viewer
never needs a cookie from the marketing site — which is what keeps this from
turning into a cross-origin session problem.

---

## Fastest path to live (today, free)

Your DNS is already on Cloudflare, so a named tunnel publishes the rig without
a VPS, a static IP, or any port forwarding. Traffic goes
`visitor → Cloudflare → tunnel → your machine`, and the machine makes only an
outbound connection.

```bash
cloudflared tunnel login                       # opens a browser, pick the domain
cloudflared tunnel create evapoflex-rig
cloudflared tunnel route dns evapoflex-rig rig.evaporationengine.net
```

Write `~/.cloudflared/config.yml`:

```yaml
tunnel: evapoflex-rig
credentials-file: /Users/sheikh.a/.cloudflared/<TUNNEL-UUID>.json

ingress:
  - hostname: rig.evaporationengine.net
    service: http://localhost:8099
    originRequest:
      # The dashboard and the phone both hold long-lived WebSockets. Without
      # these the connection is torn down on the default idle timeout and the
      # feed reconnects every ~90s.
      connectTimeout: 30s
      noHappyEyeballs: true
  - service: http_status:404
```

Run it as a service so it survives logout and reboot:

```bash
sudo cloudflared service install
```

Then point the server at its public origin so links and cookies are right:

```bash
launchctl bootout gui/$(id -u)/com.evapoflex.rig
# add to the plist's EnvironmentVariables:
#   EVAPOFLEX_HTTPS = 1
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.evapoflex.rig.plist
```

**This gets you live today**, but reliability is your laptop's reliability. Do
this to demo, then move to the box below.

---

## Reliable path (a small VPS, ~€5/month)

Nothing about the app changes — only where it runs.

**Hetzner CPX11** (2 vCPU, 2 GB, **20 TB traffic**). Bandwidth is the deciding
factor: ingest is ~0.19 TB/month at 2 fps and each concurrent viewer costs
about the same again. 20 TB covers roughly a hundred continuous viewers.
DigitalOcean bills overage past 1 TB; AWS egress would dominate the bill.

```bash
apt update && apt install -y python3-pip python3-venv caddy git
adduser --system --group --home /opt/evapoflex evapoflex
# copy the site to /opt/evapoflex/site, then:
python3 -m venv /opt/evapoflex/venv
/opt/evapoflex/venv/bin/pip install -r /opt/evapoflex/site/server/requirements.txt
```

`/etc/caddy/Caddyfile` — Caddy gets a Let's Encrypt certificate automatically,
and that certificate is what lets the iPhone use its camera at all:

```
rig.evaporationengine.net {
    encode zstd gzip
    reverse_proxy localhost:8099
}
```

`/etc/systemd/system/evapoflex.service`:

```ini
[Unit]
Description=Evapoflex rig server
After=network-online.target

[Service]
User=evapoflex
WorkingDirectory=/opt/evapoflex/site/server
Environment=PORT=8099
Environment=EVAPOFLEX_HTTPS=1
Environment=EVAPOFLEX_DATA=/var/lib/evapoflex
ExecStart=/opt/evapoflex/venv/bin/python app.py
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

```bash
mkdir -p /var/lib/evapoflex && chown evapoflex:evapoflex /var/lib/evapoflex
systemctl enable --now evapoflex caddy
```

In Cloudflare DNS, point `rig` at the VPS IP. Leave the orange cloud **on** —
Cloudflare proxies WebSockets and absorbs abuse, which matters once the feed is
public. Turn on Hetzner's daily snapshots (+20%).

---

## Deploying the static half

Cloudflare Pages already serves `evaporationengine.net` from these files.
Publish the changed landing page the same way you do now (drag-and-drop, or
`wrangler pages deploy .` if wired to a repo).

Only `index.html` changed. `live.html`, `capture.html`, `runs.html` and
`admin.html` are served by the rig, not by Pages — they will not work if Pages
serves them, because there is no API behind them there.

---

## Before you announce it

- **Change every password.** `admin`, `rig-camera` and `watcher` are still on
  the development ones.
- **Drop to 2 fps** on the capture page. At 0.8 RPM the wheel turns 2.4° per
  frame against a 25° step limit; 8 fps costs 4× the bandwidth and battery for
  nothing measurable.
- **Check `EVAPOFLEX_ALLOWED_ORIGINS`** if the domain ever changes — it gates
  which site may read the public status endpoint.
- **`EVAPOFLEX_MAX_VIEWERS`** (default 80) caps anonymous viewers. Signed-in
  users bypass it, so strangers cannot lock you out of your own feed.

## What a signed-out visitor can and cannot do

Public: the live video, the tracking overlay, the running metrics, feed health.

Requires a login: the run archive, starting and stopping runs, calibration,
switching or reloading the algorithm, user management, and the camera uplink.
Verified by test — every control endpoint returns 401 to an anonymous caller.
