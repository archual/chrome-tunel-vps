#!/usr/bin/env bash
# Shared helpers for the server scripts. Source this file; do not execute it.

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
SERVER_DIR="$(cd -- "$SCRIPT_DIR/.." && pwd)"
ENV_FILE="${ENV_FILE:-$SERVER_DIR/.env}"

if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi

PASSWD_FILE="${PASSWD_FILE:-$SERVER_DIR/etc/passwd}"
LIMITS_FILE="${LIMITS_FILE:-$SERVER_DIR/etc/user-limits.cfg}"
COMPOSE_FILE="${COMPOSE_FILE:-$SERVER_DIR/docker-compose.yml}"
PROXY_DOMAIN="${PROXY_DOMAIN:-proxy.k1812.ru}"
PROXY_PORT="${PROXY_PORT:-${PUBLIC_PORT:-443}}"
PROXY_UID="${PROXY_UID:-1000}"
PROXY_GID="${PROXY_GID:-1000}"

umask 077

die() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

warn() {
  printf 'warning: %s\n' "$*" >&2
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "missing required command: $1"
}

validate_login() {
  local login="$1"
  [[ "$login" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$ ]] \
    || die "invalid login '$login' (1-32 chars: letters, digits, '.', '_', '-'; must start alphanumeric)"
}

validate_connlim() {
  local value="$1"
  [[ "$value" =~ ^[1-9][0-9]{0,5}$ ]] || die "connlim must be an integer from 1 to 999999"
}

validate_bandwidth() {
  local value="$1"
  [[ "$value" =~ ^[0-9]+$ ]] || die "bandwidth must be an integer in bits per second"
  (( value >= 300 )) || die "bandwidth must be at least 300 bit/s (3proxy limit)"
}

generate_password() {
  openssl rand -hex 16
}

generate_salt() {
  openssl rand -hex 8
}

hash_password() {
  local salt="$1" password="$2"
  if command -v python3 >/dev/null 2>&1; then
    printf '%s\n' "$password" \
      | python3 "$SCRIPT_DIR/3proxy-crypt.py" --password-stdin "$salt"
  elif command -v 3proxy_crypt >/dev/null 2>&1; then
    # Fallback for hosts without python3. Note: the password is briefly visible
    # in the process table, so prefer python3.
    3proxy_crypt "$salt" "$password"
  else
    die "python3 (recommended) or 3proxy_crypt is required to hash passwords"
  fi
}

user_exists() {
  local login="$1"
  [[ -f "$PASSWD_FILE" ]] && grep -q "^${login}:" "$PASSWD_FILE"
}

# The proxy container runs as PROXY_UID:PROXY_GID (default 1000:1000) and must
# be able to read the users file and certificates.
fix_ownership() {
  local path="$1"
  if [[ "$(id -u)" -eq 0 ]]; then
    chown "$PROXY_UID:$PROXY_GID" "$path"
  fi
}

ensure_user_file() {
  if [[ ! -f "$PASSWD_FILE" ]]; then
    mkdir -p "$(dirname -- "$PASSWD_FILE")"
    install -m 600 /dev/null "$PASSWD_FILE"
  fi
  chmod 600 "$PASSWD_FILE"
  fix_ownership "$PASSWD_FILE"
}

# Replace (or append) a single user line atomically.
write_user() {
  local login="$1" hash="$2"
  local tmp
  ensure_user_file
  tmp="$(mktemp "${PASSWD_FILE}.XXXXXX")"
  if [[ -s "$PASSWD_FILE" ]]; then
    grep -v "^${login}:" "$PASSWD_FILE" >"$tmp" || true
  fi
  printf '%s:%s\n' "$login" "$hash" >>"$tmp"
  chmod 600 "$tmp"
  fix_ownership "$tmp"
  mv "$tmp" "$PASSWD_FILE"
}

remove_user_line() {
  local login="$1"
  local tmp
  ensure_user_file
  tmp="$(mktemp "${PASSWD_FILE}.XXXXXX")"
  grep -v "^${login}:" "$PASSWD_FILE" >"$tmp" || true
  chmod 600 "$tmp"
  fix_ownership "$tmp"
  mv "$tmp" "$PASSWD_FILE"
}

ensure_limits_file() {
  if [[ ! -f "$LIMITS_FILE" ]]; then
    mkdir -p "$(dirname -- "$LIMITS_FILE")"
    printf '%s\n' \
      '# Per-user 3proxy limits. Maintained by add-user.sh / rotate-user.sh.' \
      '# Format: connlim <rate> <period> <user> <source> <target> <ports>' \
      '#         bandlimin/bandlimout <bps> <user> <source> <target> <ports>' \
      >"$LIMITS_FILE"
  fi
}

# set_user_limits <login> [connlim] [bandwidth] — an empty value removes that limit.
set_user_limits() {
  local login="$1" connlim="${2:-}" bandwidth="${3:-}"
  local tmp
  ensure_limits_file
  tmp="$(mktemp "${LIMITS_FILE}.XXXXXX")"
  grep -v -E "(^|[[:space:]])${login}([[:space:]]|$)" "$LIMITS_FILE" >"$tmp" || true
  if [[ -n "$connlim" ]]; then
    printf 'connlim %s 0 %s * * *\n' "$connlim" "$login" >>"$tmp"
  fi
  if [[ -n "$bandwidth" ]]; then
    printf 'bandlimin %s %s * * *\n' "$bandwidth" "$login" >>"$tmp"
    printf 'bandlimout %s %s * * *\n' "$bandwidth" "$login" >>"$tmp"
  fi
  chmod 644 "$tmp"
  fix_ownership "$tmp"
  mv "$tmp" "$LIMITS_FILE"
}

restart_proxy() {
  if [[ "${SKIP_RESTART:-0}" == "1" ]]; then
    warn "SKIP_RESTART=1: proxy not restarted; reload the config before testing"
    return 0
  fi
  require_cmd docker
  # A bind-mounted passwd/limits change does not make Compose recreate the
  # container, so an existing container must be restarted to re-read the files.
  # Before the first `docker compose up` there is no container: create it.
  if [[ -n "$(docker compose -f "$COMPOSE_FILE" ps -aq proxy)" ]]; then
    docker compose -f "$COMPOSE_FILE" restart proxy >/dev/null
  else
    docker compose -f "$COMPOSE_FILE" up -d proxy >/dev/null
  fi
}

# print_credentials <login> <password> <human|env>
print_credentials() {
  local login="$1" password="$2" mode="${3:-human}"
  if [[ "$mode" == "env" ]]; then
    printf 'PROXY_LOGIN=%s\nPROXY_PASSWORD=%s\n' "$login" "$password"
  else
    printf 'login: %s\npassword (shown once, store it now): %s\n' "$login" "$password"
    warn "the password is not stored in plaintext and will not be shown again"
  fi
}
