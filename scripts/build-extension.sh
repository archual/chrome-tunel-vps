#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"

npm run build

version="$(node -p "require('./extension/public/manifest.json').version")"
archive="dist/vps-tunnel-${version}.zip"

rm -f "$archive"
node scripts/zip-dist.mjs "$archive" dist

echo "Packaged $archive"
