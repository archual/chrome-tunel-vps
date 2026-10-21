#!/usr/bin/env bash
# Add a proxy user with a random >=128-bit password and a CR:$3$ BLAKE2b hash.
#
# Usage:
#   add-user.sh [--connlim N] [--bandwidth BPS] [--output human|env] <login>
#
# The password is printed once and never stored in plaintext.
set -euo pipefail
# shellcheck source=lib.sh
source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

usage() {
  cat <<'EOF'
Usage: add-user.sh [--connlim N] [--bandwidth BPS] [--output human|env] <login>

  --connlim N        maximum parallel connections for this user (3proxy connlim)
  --bandwidth BPS    per-user bandwidth limit in bits per second (>=300)
  --output env       machine-readable PROXY_LOGIN/PROXY_PASSWORD on stdout
EOF
}

connlim=""
bandwidth=""
output_mode="human"
login=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --connlim)
      [[ $# -ge 2 ]] || die "--connlim requires a value"
      connlim="$2"
      shift 2
      ;;
    --bandwidth)
      [[ $# -ge 2 ]] || die "--bandwidth requires a value"
      bandwidth="$2"
      shift 2
      ;;
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
[[ -z "$connlim" ]] || validate_connlim "$connlim"
[[ -z "$bandwidth" ]] || validate_bandwidth "$bandwidth"

require_cmd openssl
ensure_user_file
if user_exists "$login"; then
  die "user '$login' already exists; use rotate-user.sh to change its password"
fi

password="$(generate_password)"
salt="$(generate_salt)"
hash="$(hash_password "$salt" "$password")"
[[ "$hash" == CR:\$3\$* ]] || die "refusing to write a non-BLAKE2b hash"

write_user "$login" "$hash"
if [[ -n "$connlim" || -n "$bandwidth" ]]; then
  set_user_limits "$login" "$connlim" "$bandwidth"
fi
restart_proxy

print_credentials "$login" "$password" "$output_mode"
