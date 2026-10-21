#!/bin/sh
# Container entrypoint for the 3proxy LTS image.
#
# The official image ships only /bin/3proxy; it has no shell-based config
# renderer. This script generates the operator-controlled part of the ACL from
# environment variables and then replaces itself with the proxy process.
set -eu

umask 077

extra_dir=/tmp/3proxy
extra_file="$extra_dir/acl-extra.cfg"
mkdir -p "$extra_dir"
: >"$extra_file"

is_ipv4() {
    printf '%s' "$1" | grep -Eq '^([0-9]{1,3}\.){3}[0-9]{1,3}$'
}

if [ -n "${PROXY_PUBLIC_IP:-}" ]; then
    if ! is_ipv4 "$PROXY_PUBLIC_IP"; then
        echo "entrypoint: PROXY_PUBLIC_IP must be an IPv4 address: $PROXY_PUBLIC_IP" >&2
        exit 1
    fi
    echo "deny * * $PROXY_PUBLIC_IP *" >>"$extra_file"
fi

if [ -n "${DENY_EXTRA_CIDRS:-}" ]; then
    case "$DENY_EXTRA_CIDRS" in
        *[!0-9a-fA-F:.,/]*)
            echo "entrypoint: DENY_EXTRA_CIDRS contains unsupported characters: $DENY_EXTRA_CIDRS" >&2
            exit 1
            ;;
    esac
    echo "deny * * $DENY_EXTRA_CIDRS *" >>"$extra_file"
fi

if [ ! -r /etc/3proxy/passwd ]; then
    echo "entrypoint: /etc/3proxy/passwd is missing; run server/scripts/init.sh and add a user" >&2
    exit 1
fi
if [ ! -r /etc/3proxy/certs/fullchain.pem ] || [ ! -r /etc/3proxy/certs/privkey.pem ]; then
    echo "entrypoint: TLS certificate is missing; run server/scripts/issue-cert.sh" >&2
    exit 1
fi
if [ ! -r /etc/3proxy/user-limits.cfg ]; then
    echo "entrypoint: /etc/3proxy/user-limits.cfg is missing; run server/scripts/init.sh" >&2
    exit 1
fi

exec "$@"
