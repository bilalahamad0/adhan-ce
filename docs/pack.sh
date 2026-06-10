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
STAGE="$HERE/dist/extension"
rm -f "$OUT"

# Stage the runtime files (this also forces lib/buildinfo.js to DEV=false), then
# zip the STAGED tree — never the source — so the store ZIP can't carry the dev
# Test trigger. Same stageExtension() helper the CRX packer uses, so the ZIP and
# CRX can never disagree on contents or on the build flag. Zipping `.` from inside
# STAGE keeps the flat layout (manifest.json at the archive root).
( cd "$HERE" && node -e "import('./scripts/runtime-files.mjs').then(m=>m.stageExtension('$STAGE'))" )
( cd "$STAGE" && zip -rq "$OUT" . )

echo "✓ Qualified and packaged: $OUT"
