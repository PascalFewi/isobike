#!/usr/bin/env bash
#
# One-time setup of a fresh Hetzner server (Ubuntu 24.04) for isobike. Run as
# root, from a checkout of this repo, with the PUBLIC half of the GitHub deploy
# key as argument:
#
#   git clone https://github.com/PascalFewi/isobike.git && cd isobike
#   sudo bash deploy/setup-server.sh "ssh-ed25519 AAAA... github-deploy"
#
# Installs Node 22, Caddy and gdown; creates the `isobike` service user and the
# `deploy` user GitHub Actions logs in as (allowed to run exactly one sudo
# command: restarting the API); lays out /opt/isobike; opens ports 22/80/443;
# downloads the data from Google Drive. Safe to run again.

set -euo pipefail

DEPLOY_PUBKEY="${1:?usage: setup-server.sh '<deploy public key>'}"
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ROOT=/opt/isobike

log() { echo "== $*"; }

log "packages"
apt-get update -qq
apt-get install -y -qq curl ca-certificates gnupg debian-keyring debian-archive-keyring apt-transport-https ufw pipx

if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 22 ]; then
  log "Node 22"
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y -qq nodejs
fi

if ! command -v caddy >/dev/null; then
  log "Caddy"
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/gpg.key | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -qq
  apt-get install -y -qq caddy
fi

log "gdown (Google Drive downloads)"
PIPX_HOME=/opt/pipx PIPX_BIN_DIR=/usr/local/bin pipx install --force gdown >/dev/null

log "users"
id isobike >/dev/null 2>&1 || useradd --system --home "$ROOT" --shell /usr/sbin/nologin isobike
id deploy >/dev/null 2>&1 || useradd --create-home --shell /bin/bash deploy
install -d -m 0700 -o deploy -g deploy /home/deploy/.ssh
echo "$DEPLOY_PUBKEY" > /home/deploy/.ssh/authorized_keys
chown deploy:deploy /home/deploy/.ssh/authorized_keys
chmod 0600 /home/deploy/.ssh/authorized_keys
cat > /etc/sudoers.d/isobike-deploy <<'EOF'
deploy ALL=(root) NOPASSWD: /usr/bin/systemctl restart isobike
EOF
chmod 0440 /etc/sudoers.d/isobike-deploy
visudo -cf /etc/sudoers.d/isobike-deploy

log "layout $ROOT"
install -d -m 0755 "$ROOT" "$ROOT/bin" "$ROOT/data"
install -d -m 0755 -o deploy -g deploy "$ROOT/releases"
chown deploy:deploy "$ROOT"   # deploy switches the `current` symlink here
install -m 0755 "$REPO_DIR/deploy/activate.sh" "$ROOT/bin/activate.sh"
install -m 0755 "$REPO_DIR/deploy/fetch-data.sh" "$ROOT/bin/fetch-data.sh"
chown root:root "$ROOT/bin" "$ROOT/bin/"*

log "systemd + Caddy"
install -m 0644 "$REPO_DIR/deploy/isobike.service" /etc/systemd/system/isobike.service
install -d -m 0755 /var/log/caddy && chown caddy:caddy /var/log/caddy
install -m 0644 "$REPO_DIR/deploy/Caddyfile" /etc/caddy/Caddyfile
systemctl daemon-reload
systemctl enable isobike
systemctl reload caddy || systemctl restart caddy

log "firewall"
ufw allow OpenSSH >/dev/null
ufw allow 80/tcp >/dev/null
ufw allow 443/tcp >/dev/null
ufw --force enable >/dev/null

if [ ! -f "$ROOT/data/graph.bin" ]; then
  log "data from Google Drive"
  bash "$ROOT/bin/fetch-data.sh" "$ROOT/data"
fi

log "done. Next: publish a GitHub release from main -- the workflow deploys the app."
log "Until then $ROOT/current does not exist and the site answers 404."
