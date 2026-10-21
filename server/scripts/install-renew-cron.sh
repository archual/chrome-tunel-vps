#!/usr/bin/env bash
# Install (or refresh) the daily certificate renewal cron entry for this server
# directory. Idempotent: an existing renew-cert.sh line is replaced.
set -euo pipefail
# shellcheck source=lib.sh
source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

require_cmd crontab

line="0 3 * * * cd $(printf '%q' "$SERVER_DIR") && ./scripts/renew-cert.sh >> ./logs/renew.log 2>&1"

{
  crontab -l 2>/dev/null | grep -v 'scripts/renew-cert.sh' || true
  printf '%s\n' "$line"
} | crontab -

echo "installed cron entry:"
echo "  $line"
