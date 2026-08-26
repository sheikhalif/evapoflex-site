#!/usr/bin/env bash
# Provision a fresh Debian/Ubuntu box to run the rig server.
# Run once, as root, on the VPS:  bash provision.sh
set -euo pipefail

DOMAIN="${DOMAIN:-rig.evaporationengine.net}"
APP=/opt/evapoflex
DATA=/var/lib/evapoflex

echo "==> packages"
apt-get update
apt-get install -y python3 python3-venv python3-pip git curl debian-keyring \
	debian-archive-keyring apt-transport-https

# Caddy is not in the base repos.
if ! command -v caddy >/dev/null; then
	curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
		| gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
	curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
		> /etc/apt/sources.list.d/caddy-stable.list
	apt-get update && apt-get install -y caddy
fi

echo "==> service account"
id -u evapoflex >/dev/null 2>&1 || adduser --system --group --home "$APP" evapoflex
mkdir -p "$APP/site" "$DATA"
chown -R evapoflex:evapoflex "$APP" "$DATA"

echo "==> python environment"
python3 -m venv "$APP/venv"
"$APP/venv/bin/pip" install --upgrade pip

echo "==> credentials file"
if [ ! -f /etc/evapoflex.env ]; then
	cat > /etc/evapoflex.env <<'ENVEOF'
PORT=8099
EVAPOFLEX_HTTPS=1
EVAPOFLEX_DATA=/var/lib/evapoflex
EVAPOFLEX_ALLOWED_ORIGINS=https://evaporationengine.net,https://www.evaporationengine.net

# --- SFU (LiveKit). Leave blank to run without WebRTC; the rig then falls
# --- back to sending frames over its own WebSocket, which works but is not
# --- crisp and costs this server bandwidth per viewer.
EVAPOFLEX_LIVEKIT_URL=
EVAPOFLEX_LIVEKIT_KEY=
EVAPOFLEX_LIVEKIT_SECRET=

# --- Only needed for the admin "write a tracking algorithm" feature.
# ANTHROPIC_API_KEY=
ENVEOF
	chmod 600 /etc/evapoflex.env
	echo "    wrote /etc/evapoflex.env — fill in the SFU keys before starting"
else
	echo "    /etc/evapoflex.env exists, leaving it alone"
fi

echo "==> caddy"
sed "s/rig\.evaporationengine\.net/$DOMAIN/" \
	"$(dirname "$0")/Caddyfile" > /etc/caddy/Caddyfile
mkdir -p /var/log/caddy && chown caddy:caddy /var/log/caddy

echo "==> systemd unit"
cp "$(dirname "$0")/evapoflex.service" /etc/systemd/system/
systemctl daemon-reload

cat <<EOF

Provisioned. Next:

  1. Copy the site up (from your Mac, not here):
       ./server/deploy/push.sh root@<this-host>

  2. Fill in /etc/evapoflex.env  (SFU keys, optionally the Anthropic key)

  3. Point DNS: an A record for $DOMAIN at this box's IP.
     Leave Cloudflare's proxy ON — it absorbs abuse on a public feed.

  4. Start it:
       systemctl enable --now evapoflex caddy
       journalctl -u evapoflex -f

EOF
