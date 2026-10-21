#!/usr/bin/env bash
# Host-side readiness check (SRV-8 / SRV-AC-9).
#
# Verifies that the proxy:
#   * accepts a TLS connection with a certificate valid for PROXY_DOMAIN,
#   * rejects an unauthenticated CONNECT with 407 (no open proxy).
#
# Prints "ok" and exits 0 on success; prints the reason and exits 1 otherwise.
set -euo pipefail
# shellcheck source=lib.sh
source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

require_cmd curl

host="${PROXY_HEALTH_HOST:-127.0.0.1}"
proxy_url="https://${PROXY_DOMAIN}:${PROXY_PORT}"

curl_args=(
  --silent --show-error --max-time 10
  --proxy "$proxy_url"
  --resolve "${PROXY_DOMAIN}:${PROXY_PORT}:${host}"
  --output /dev/null
  --write-out '%{http_code}'
)
if [[ -n "${PROXY_CA_FILE:-}" ]]; then
  curl_args+=(--proxy-cacert "$PROXY_CA_FILE")
fi

if ! code="$(curl "${curl_args[@]}" http://example.com/ 2>&1)"; then
  echo "healthcheck: proxy is not reachable at ${proxy_url} (host ${host}): ${code}" >&2
  exit 1
fi

case "$code" in
  407)
    echo "ok"
    ;;
  200)
    echo "healthcheck: proxy answered 200 without credentials — anonymous access is open" >&2
    exit 1
    ;;
  *)
    echo "healthcheck: expected 407, got ${code}" >&2
    exit 1
    ;;
esac
