#!/usr/bin/env bash
# Qualify, then package the extension for the Chrome Web Store.
# Runs the unit + manifest tests and only zips a clean build (runtime files
# only) if they pass.
set -euo pipefail

HERE="$(cd "$(dirname "$0")/.." && pwd)" # repo root (= extension root)

echo "▶ Qualification: unit + manifest tests"
( cd "$HERE" && node --experimental-vm-modules node_modules/jest/bin/jest.js )

VER="$(node -e "process.stdout.write(require('$HERE/manifest.json').version)")"
OUT="$HERE/adhan-caster-pro-$VER.zip"
rm -f "$OUT"

# Include only the files Chrome needs at runtime.
( cd "$HERE" && zip -rq "$OUT" \
  manifest.json background.js content.js content.css \
  popup.html popup.js popup.css \
  icons/icon16.png icons/icon48.png icons/icon128.png \
  lib )

echo "✓ Qualified and packaged: $OUT"
