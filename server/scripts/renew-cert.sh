#!/usr/bin/env bash
# Renew the Let's Encrypt certificate and restart the proxy only when the
# certificate actually changed (SRV-2). Safe to run from cron.
set -euo pipefail
# shellcheck source=lib.sh
source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

: "${PROXY_DOMAIN:?set PROXY_DOMAIN in server/.env}"

CERTBOT_IMAGE="certbot/certbot:v5.8.0@sha256:f70ad0adbb7e117f0fe42a63c553f28ea451edabc0148757b6efcd9735acaa20"
CERTS_DIR="$SERVER_DIR/certs"
FULLCHAIN="$CERTS_DIR/live/${PROXY_DOMAIN}/fullchain.pem"
[[ -r "$FULLCHAIN" ]] || die "no certificate for ${PROXY_DOMAIN}; run issue-cert.sh first"

before="$(stat -c %Y "$FULLCHAIN" 2>/dev/null || echo 0)"

if command -v certbot >/dev/null 2>&1; then
  certbot renew --quiet \
    --config-dir "$CERTS_DIR" --work-dir "$CERTS_DIR/work" --logs-dir "$CERTS_DIR/logs"
else
  require_cmd docker
  docker run --rm -p 80:80 \
    -v "$CERTS_DIR:/etc/letsencrypt" \
    -v "$CERTS_DIR/work:/var/lib/letsencrypt" \
    -v "$CERTS_DIR/logs:/var/log/letsencrypt" \
    "$CERTBOT_IMAGE" renew --quiet
fi

after="$(stat -c %Y "$FULLCHAIN" 2>/dev/null || echo 0)"

ln -sfn "live/${PROXY_DOMAIN}/fullchain.pem" "$CERTS_DIR/fullchain.pem"
ln -sfn "live/${PROXY_DOMAIN}/privkey.pem" "$CERTS_DIR/privkey.pem"
chmod 644 "$FULLCHAIN"
chmod 600 "$CERTS_DIR/live/${PROXY_DOMAIN}/privkey.pem"

if [[ "$after" -gt "$before" ]]; then
  if [[ "$(id -u)" -eq 0 ]]; then
    chown -R "$PROXY_UID:$PROXY_GID" "$CERTS_DIR"
  fi
  if [[ -s "$SERVER_DIR/etc/passwd" ]]; then
    restart_proxy
    echo "certificate renewed for ${PROXY_DOMAIN}; proxy restarted"
  else
    echo "certificate renewed for ${PROXY_DOMAIN}; proxy is not configured yet"
  fi
else
  echo "certificate for ${PROXY_DOMAIN} is up to date; proxy not restarted"
fi
