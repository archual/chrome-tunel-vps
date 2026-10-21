#!/bin/sh
# Docker healthcheck: prove that the listener speaks TLS and still requires
# authentication. An unauthenticated CONNECT must be rejected with 407.
#
# ssl_client (busybox) does not verify the certificate chain; the host-side
# scripts/healthcheck.sh does that with curl for the readiness check.
set -eu

domain="${PROXY_DOMAIN:-proxy.k1812.ru}"
response="$(
    printf 'CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n\r\n' \
        | ssl_client -n "$domain" 127.0.0.1:3129 2>/dev/null \
        | head -n 1 || true
)"

case "$response" in
    *" 407 "*) exit 0 ;;
esac

echo "healthcheck: expected 407 from the TLS proxy, got: ${response:-<empty>}" >&2
exit 1
