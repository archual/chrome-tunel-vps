#!/usr/bin/env bash
# Prepare a fresh checkout for `docker compose up`.
#
# Creates the runtime files that are intentionally not tracked in git:
#   .env, etc/passwd, etc/user-limits.cfg, logs/, certs/
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
SERVER_DIR="$(cd -- "$SCRIPT_DIR/.." && pwd)"
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"
umask 027

install -d -m 700 "$SERVER_DIR/logs" "$SERVER_DIR/certs" "$SERVER_DIR/etc"
# The container runs as PROXY_UID:PROXY_GID and bind-mounts these directories;
# hand over each one so uid 1000 can traverse it when this runs as root.
fix_dir_ownership "$SERVER_DIR/logs"
fix_dir_ownership "$SERVER_DIR/certs"
fix_dir_ownership "$SERVER_DIR/etc"

if [[ ! -f "$SERVER_DIR/etc/passwd" ]]; then
  install -m 600 /dev/null "$SERVER_DIR/etc/passwd"
  fix_ownership "$SERVER_DIR/etc/passwd"
  echo "created server/etc/passwd (0600)"
fi

if [[ ! -f "$SERVER_DIR/etc/user-limits.cfg" ]]; then
  cat >"$SERVER_DIR/etc/user-limits.cfg" <<'EOF'
# Per-user 3proxy limits. Maintained by add-user.sh / rotate-user.sh.
# Format: connlim <rate> <period> <user> <source> <target> <ports>
#         bandlimin/bandlimout <bps> <user> <source> <target> <ports>
EOF
  chmod 644 "$SERVER_DIR/etc/user-limits.cfg"
  fix_ownership "$SERVER_DIR/etc/user-limits.cfg"
  echo "created server/etc/user-limits.cfg"
fi

if [[ ! -f "$SERVER_DIR/.env" ]]; then
  cp "$SERVER_DIR/.env.example" "$SERVER_DIR/.env"
  chmod 600 "$SERVER_DIR/.env"
  echo "created server/.env (0600) — fill PROXY_DOMAIN and LETSENCRYPT_EMAIL"
fi

echo "server directory initialized: $SERVER_DIR"
echo "next: edit .env, run scripts/issue-cert.sh, then scripts/add-user.sh <login>"
