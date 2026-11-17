#!/usr/bin/env bash
#
# Installs self-hosted Umami (usage statistics) on the isobike server. Run as
# root. Called by setup-server.sh; on a server that is already set up, copy
# this file and umami/docker-compose.yml over and run it on its own:
#
#   scp deploy/setup-umami.sh deploy/umami/docker-compose.yml root@<server>:/tmp/
#   ssh root@<server> bash /tmp/setup-umami.sh
#
# Installs Docker, puts the compose file and a .env with random secrets into
# /opt/umami, starts Umami on 127.0.0.1:3000, and adds the stats site to Caddy
# if it is not there yet. Safe to run again: secrets and data are kept.

set -euo pipefail

STATS_DOMAIN="${STATS_DOMAIN:-stats.isobike.ch}"
DIR=/opt/umami
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPOSE_SRC="$HERE/umami/docker-compose.yml"
[ -f "$COMPOSE_SRC" ] || COMPOSE_SRC="$HERE/docker-compose.yml"   # copied over on its own
[ -f "$COMPOSE_SRC" ] || { echo "docker-compose.yml not found next to this script" >&2; exit 1; }

echo "== Docker"
if ! docker compose version >/dev/null 2>&1; then
  apt-get update -qq
  apt-get install -y -qq docker.io docker-compose-v2
fi

echo "== $DIR"
install -d -m 0700 "$DIR"
install -m 0644 "$COMPOSE_SRC" "$DIR/docker-compose.yml"
if [ ! -f "$DIR/.env" ]; then
  (
    umask 077
    {
      echo "POSTGRES_PASSWORD=$(openssl rand -hex 24)"
      echo "APP_SECRET=$(openssl rand -hex 32)"
      echo "TWO_FACTOR_ENCRYPTION_KEY=$(openssl rand -hex 32)"
    } > "$DIR/.env"
  )
fi

echo "== start"
docker compose --project-directory "$DIR" up -d

if ! grep -q "^$STATS_DOMAIN" /etc/caddy/Caddyfile; then
  echo "== Caddy: $STATS_DOMAIN"
  cp /etc/caddy/Caddyfile /etc/caddy/Caddyfile.before-umami
  printf '\n# Umami (usage statistics): dashboard and tracking script.\n%s {\n\tencode zstd gzip\n\treverse_proxy 127.0.0.1:3000\n}\n' \
    "$STATS_DOMAIN" >> /etc/caddy/Caddyfile
  if ! caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null 2>&1; then
    cp /etc/caddy/Caddyfile.before-umami /etc/caddy/Caddyfile
    echo "Caddyfile did not validate with the stats site; restored it. Add the site by hand." >&2
    exit 1
  fi
  systemctl reload caddy
fi

echo "== done. Once DNS for $STATS_DOMAIN points here: https://$STATS_DOMAIN"
echo "   First login: admin / umami -- change the password right away."
