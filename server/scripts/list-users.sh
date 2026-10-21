#!/usr/bin/env bash
# List proxy logins only. Hashes and passwords are never printed.
set -euo pipefail
# shellcheck source=lib.sh
source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

if [[ ! -s "$PASSWD_FILE" ]]; then
  exit 0
fi

grep -v '^[[:space:]]*$' "$PASSWD_FILE" | cut -d: -f1 | grep -v -E '^(#|__disabled__)$' || true
