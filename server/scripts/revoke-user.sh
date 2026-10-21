#!/usr/bin/env bash
# Remove a proxy user and its per-user limits.
#
# Usage: revoke-user.sh <login>
set -euo pipefail
# shellcheck source=lib.sh
source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

login="${1:-}"
[[ -n "$login" ]] || { echo "Usage: revoke-user.sh <login>" >&2; exit 2; }
[[ $# -eq 1 ]] || die "unexpected arguments: ${*:2}"
validate_login "$login"
ensure_user_file
user_exists "$login" || die "user '$login' does not exist"

remove_user_line "$login"
set_user_limits "$login"

# An empty users file is a 3proxy parse error and would keep the container
# down. Keep a locked placeholder account instead: its password is random,
# discarded immediately and can never be used to authenticate.
if ! grep -q . "$PASSWD_FILE"; then
  placeholder_password="$(generate_password)"
  placeholder_salt="$(generate_salt)"
  placeholder_hash="$(hash_password "$placeholder_salt" "$placeholder_password")"
  write_user "__disabled__" "$placeholder_hash"
  warn "last user removed; added locked '__disabled__' placeholder so the config stays valid"
fi

restart_proxy

printf 'revoked user: %s\n' "$login"
