#!/usr/bin/env bash
# Issue the first Let's Encrypt certificate for PROXY_DOMAIN (SRV-2).
#
# Port 80 must be free: certbot uses the standalone HTTP-01 challenge.
# Requires PROXY_DOMAIN and LETSENCRYPT_EMAIL in server/.env.
set -euo pipefail
# shellcheck source=lib.sh
source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

: "${PROXY_DOMAIN:?set PROXY_DOMAIN in server/.env}"
: "${LETSENCRYPT_EMAIL:?set LETSENCRYPT_EMAIL in server/.env}"

CERTBOT_IMAGE="certbot/certbot:v5.8.0@sha256:f70ad0adbb7e117f0fe42a63c553f28ea451edabc0148757b6efcd9735acaa20"
CERTS_DIR="$SERVER_DIR/certs"
install -d -m 700 "$CERTS_DIR"

certbot_args=(
  certonly --standalone --non-interactive --agree-tos
  --domain "$PROXY_DOMAIN"
  --email "$LETSENCRYPT_EMAIL"
)

if command -v certbot >/dev/null 2>&1; then
  certbot "${certbot_args[@]}" \
    --config-dir "$CERTS_DIR" --work-dir "$CERTS_DIR/work" --logs-dir "$CERTS_DIR/logs"
else
  require_cmd docker
  docker run --rm -p 80:80 \
    -v "$CERTS_DIR:/etc/letsencrypt" \
    -v "$CERTS_DIR/work:/var/lib/letsencrypt" \
    -v "$CERTS_DIR/logs:/var/log/letsencrypt" \
    "$CERTBOT_IMAGE" "${certbot_args[@]}"
fi

link_certificates() {
  ln -sfn "live/${PROXY_DOMAIN}/fullchain.pem" "$CERTS_DIR/fullchain.pem"
  ln -sfn "live/${PROXY_DOMAIN}/privkey.pem" "$CERTS_DIR/privkey.pem"
}

link_certificates
chmod 700 "$CERTS_DIR"
chmod 644 "$CERTS_DIR/live/${PROXY_DOMAIN}/fullchain.pem"
chmod 600 "$CERTS_DIR/live/${PROXY_DOMAIN}/privkey.pem"
# The proxy container runs as uid/gid 1000 and must be able to read the key.
if [[ "$(id -u)" -eq 0 ]]; then
  chown -R "$PROXY_UID:$PROXY_GID" "$CERTS_DIR"
else
  warn "run as root (or chown -R $PROXY_UID:$PROXY_GID $CERTS_DIR) so the container can read the key"
fi

if [[ -s "$SERVER_DIR/etc/passwd" ]]; then
  restart_proxy
  echo "certificate ready for ${PROXY_DOMAIN}; proxy restarted"
else
  echo "certificate ready for ${PROXY_DOMAIN}; add a user, then run docker compose up -d"
fi
