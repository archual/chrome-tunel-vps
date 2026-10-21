#!/usr/bin/env bash
# End-to-end smoke test for SRV-AC-2..5, SRV-AC-7, SRV-AC-9, SRV-AC-10.
#
# Requires a running proxy, a valid TLS certificate and one proxy user:
#   SMOKE_USER=... SMOKE_PASSWORD=... server/scripts/smoke-test.sh
#
# Optional (read from server/.env): PROXY_DOMAIN, PUBLIC_PORT/PROXY_PORT,
# PROXY_HEALTH_HOST, PROXY_CA_FILE, PROXY_PUBLIC_IP.
#
# Rotation (SRV-AC-6), connection limits (SRV-AC-8) and user lifecycle are
# covered by add-user.sh --connlim / rotate-user.sh / revoke-user.sh; see the
# runbook for the exact acceptance steps.
set -uo pipefail
# shellcheck source=lib.sh
source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

require_cmd curl

: "${SMOKE_USER:?set SMOKE_USER to a proxy login}"
: "${SMOKE_PASSWORD:?set SMOKE_PASSWORD to the password for that user}"

target_url="${SMOKE_TARGET_URL:-https://api.ipify.org}"
proxy_url="https://${PROXY_DOMAIN}:${PROXY_PORT}"
resolve_arg="${PROXY_DOMAIN}:${PROXY_PORT}:${PROXY_HEALTH_HOST:-127.0.0.1}"

common=(
  --silent --show-error --max-time 15
  --noproxy ''
  --proxy "$proxy_url"
  --resolve "$resolve_arg"
)
if [[ -n "${PROXY_CA_FILE:-}" ]]; then
  common+=(--proxy-cacert "$PROXY_CA_FILE")
fi

failures=0
pass() { printf 'ok   %s\n' "$*"; }
fail() { printf 'FAIL %s\n' "$*"; failures=$((failures + 1)); }

http_code() {
  curl "${common[@]}" "$@" --output /dev/null --write-out '%{http_code}' 2>/dev/null || true
}

# A rejected CONNECT makes curl exit non-zero, so %{http_code} may be 000 even
# though the proxy answered. Accept either the numeric code or the stderr line.
expect_auth_required() {
  local label="$1" code output
  shift
  code="$(http_code "$@")"
  if [[ "$code" == "407" ]]; then
    pass "${label}: rejected with 407"
    return
  fi
  output="$(curl "${common[@]}" "$@" --output /dev/null 2>&1 || true)"
  if grep -q 'response 407' <<<"$output"; then
    pass "${label}: rejected with 407"
  else
    fail "${label}: expected 407, got ${code:-<no response>} ${output//$'\n'/ }"
  fi
}

echo "== proxy: ${proxy_url} (resolve ${resolve_arg})"

# --- SRV-AC-2: anonymous CONNECT -> 407 -----------------------------------
expect_auth_required "anonymous CONNECT" --proxytunnel http://example.com:443/

# --- SRV-AC-3: wrong credentials -> 407 -----------------------------------
expect_auth_required "wrong credentials" \
  --proxy-user "${SMOKE_USER}:definitely-wrong" --proxytunnel http://example.com:443/

# --- SRV-AC-4: valid credentials -> tunnel + VPS exit IP ------------------
body="$(curl "${common[@]}" --proxy-user "${SMOKE_USER}:${SMOKE_PASSWORD}" "$target_url" 2>/dev/null || true)"
if [[ "$body" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]]; then
  pass "valid credentials: tunnel established, exit IP ${body}"
  if [[ -n "${PROXY_PUBLIC_IP:-}" && "$body" != "${PROXY_PUBLIC_IP}" ]]; then
    fail "exit IP ${body} differs from PROXY_PUBLIC_IP ${PROXY_PUBLIC_IP}"
  elif [[ -n "${PROXY_PUBLIC_IP:-}" ]]; then
    pass "exit IP matches VPS public IP ${PROXY_PUBLIC_IP}"
  fi
else
  fail "valid credentials did not return a public IP: ${body:-<no response>}"
fi

# --- SRV-AC-5: forbidden targets -> 403 -----------------------------------
expect_denied() {
  local label="$1" url="$2" output
  if output="$(curl "${common[@]}" --proxy-user "${SMOKE_USER}:${SMOKE_PASSWORD}" \
      --proxytunnel --output /dev/null "$url" 2>&1)"; then
    fail "${label}: request unexpectedly succeeded"
  elif grep -q 'response 403' <<<"$output"; then
    pass "${label}: denied with 403"
  else
    fail "${label}: expected 403, got: ${output//$'\n'/ }"
  fi
}

expect_denied "CONNECT to private 127.0.0.1:80" "http://127.0.0.1:80/"
expect_denied "CONNECT to metadata 169.254.169.254:80" "http://169.254.169.254/latest/meta-data/"
expect_denied "CONNECT to SMTP example.com:25" "http://example.com:25/"
expect_denied "CONNECT to non-web example.com:8080" "http://example.com:8080/"

# --- SRV-AC-9: healthcheck ------------------------------------------------
if "$SCRIPT_DIR/healthcheck.sh" >/dev/null 2>&1; then
  pass "healthcheck.sh reports ok"
else
  fail "healthcheck.sh failed"
fi

# --- SRV-AC-7 / SRV-AC-10: logs and repository secrets --------------------
sleep 1
logs=("$SERVER_DIR"/logs/3proxy.log.*)
if [[ ! -e "${logs[0]}" ]]; then
  fail "no proxy log found under $SERVER_DIR/logs/"
else
  latest="${logs[${#logs[@]}-1]}"
  if grep -Fq -- "$SMOKE_PASSWORD" "$latest"; then
    fail "password leaked into ${latest}"
  else
    pass "password absent from logs"
  fi
  if grep -Fq 'Proxy-Authorization' "$latest"; then
    fail "Proxy-Authorization leaked into ${latest}"
  else
    pass "Proxy-Authorization absent from logs"
  fi
  if grep -Eq 'https?://|\?' "$latest"; then
    fail "URL path/query leaked into ${latest}"
  else
    pass "no URL path/query in logs"
  fi
  if grep -q 'user=.* dst=.* method=.* status=.* in=.* out=' "$latest"; then
    pass "log format contains user/host/method/status/bytes"
  else
    fail "log format is missing required fields in ${latest}"
  fi
fi

if git -C "$SERVER_DIR/.." grep -nE '(-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----|CR:\$[13]\$[^ ]+\$[^ ]+)' -- \
    . ':!tests' ':!docs' ':!server/scripts/3proxy-crypt.py' >/dev/null 2>&1; then
  fail "git grep found a private key or password hash in the repository"
else
  pass "git grep found no private keys or password hashes"
fi

# --- SRV-AC-10: required secret paths are ignored -------------------------
ignored_all=true
for path in server/etc/passwd server/certs/fullchain.pem server/.env; do
  if ! git -C "$SERVER_DIR/.." check-ignore -q "$path"; then
    fail "${path} is not gitignored"
    ignored_all=false
  fi
done
if [[ "$ignored_all" == true ]]; then
  pass "passwd, certificates and .env are gitignored"
fi

echo
if (( failures > 0 )); then
  echo "smoke test: ${failures} failure(s)"
  exit 1
fi
echo "smoke test: all checks passed"
