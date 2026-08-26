#!/usr/bin/env bash
# Push the site to the VPS and restart it.  ./push.sh root@1.2.3.4
#
# rsync rather than git so you can ship a working tree without committing, and
# --delete so a file you removed locally does not linger on the server serving
# a stale page.
set -euo pipefail

TARGET="${1:?usage: push.sh user@host}"
SITE="$(cd "$(dirname "$0")/../.." && pwd)"
APP=/opt/evapoflex

echo "==> pushing $SITE -> $TARGET:$APP/site"
rsync -az --delete \
	--exclude '.git' \
	--exclude '.claude' \
	--exclude '__pycache__' \
	--exclude '*.pyc' \
	--exclude 'server/data' \
	--exclude '.DS_Store' \
	"$SITE/" "$TARGET:$APP/site/"

echo "==> installing dependencies and restarting"
ssh "$TARGET" bash -euo pipefail <<'REMOTE'
	/opt/evapoflex/venv/bin/pip install -q -r /opt/evapoflex/site/server/requirements.txt
	chown -R evapoflex:evapoflex /opt/evapoflex/site
	systemctl restart evapoflex
	sleep 3
	systemctl is-active --quiet evapoflex \
		&& echo "    evapoflex: running" \
		|| { echo "    evapoflex FAILED — last log lines:"; \
		     journalctl -u evapoflex -n 30 --no-pager; exit 1; }
REMOTE

echo "==> done"
