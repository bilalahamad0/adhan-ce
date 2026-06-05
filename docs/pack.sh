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

# Include only the files Chrome needs at runtime — sourced from the single
# source of truth (scripts/runtime-files.mjs) shared with the CRX packer, so the
# zip and CRX can never disagree on what ships.
FILES="$(cd "$HERE" && node -e "import('./scripts/runtime-files.mjs').then(m=>m.runtimeFiles()).then(f=>process.stdout.write(f.join('\n')))")"
( cd "$HERE" && printf '%s\n' "$FILES" | zip -rq "$OUT" -@ )

echo "✓ Qualified and packaged: $OUT"
