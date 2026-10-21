#!/usr/bin/env bash
# Rotate a proxy user's password. The old password stops working when the
# proxy restarts.
#
# Usage: rotate-user.sh [--output human|env] <login>
set -euo pipefail
# shellcheck source=lib.sh
source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

usage() {
  cat <<'EOF'
Usage: rotate-user.sh [--output human|env] <login>

Prints the new password once. The old credential is removed atomically.
EOF
}

output_mode="human"
login=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --output)
      [[ $# -ge 2 ]] || die "--output requires a value"
      output_mode="$2"
      shift 2
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    -*)
      die "unknown option: $1"
      ;;
    *)
      [[ -z "$login" ]] || die "only one login may be given"
      login="$1"
      shift
      ;;
  esac
done

[[ -n "$login" ]] || { usage >&2; exit 2; }
validate_login "$login"
case "$output_mode" in env|human) ;; *) die "--output must be 'human' or 'env'" ;; esac
require_cmd openssl
ensure_user_file
user_exists "$login" || die "user '$login' does not exist"

password="$(generate_password)"
salt="$(generate_salt)"
hash="$(hash_password "$salt" "$password")"
[[ "$hash" == CR:\$3\$* ]] || die "refusing to write a non-BLAKE2b hash"

write_user "$login" "$hash"
restart_proxy

print_credentials "$login" "$password" "$output_mode"
