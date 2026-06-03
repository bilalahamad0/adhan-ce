#!/usr/bin/env bash
# Render the Chrome Web Store screenshots (1280x800) from docs/store-assets.html
# using headless Chrome. Outputs to docs/store/screenshot-{1..5}.png.
set -euo pipefail

HERE="$(cd "$(dirname "$0")/.." && pwd)" # -> chrome-extension/
CHROME="${CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
PORT="${PORT:-8755}"
UDD="/tmp/adhan_store_cdp"
OUT="$HERE/docs/store"

pkill -f "$UDD" 2>/dev/null || true
sleep 0.3
rm -rf "$UDD" 2>/dev/null || true
mkdir -p "$UDD" "$OUT"

python3 -m http.server "$PORT" --directory "$HERE" >/tmp/adhan_store_server.log 2>&1 &
SRV=$!
trap 'kill "$SRV" 2>/dev/null || true; pkill -f "$UDD" 2>/dev/null || true' EXIT
until curl -s -o /dev/null "http://localhost:$PORT/docs/store-assets.html"; do sleep 0.3; done

for n in 1 2 3 4 5 6; do
  out="$OUT/screenshot-$n.png"
  rm -f "$out" "$UDD"/Singleton* 2>/dev/null || true
  # Render at 2x (retina) with a virtual-time budget so web fonts load, then downscale.
  "$CHROME" --headless=new --disable-gpu --hide-scrollbars --force-device-scale-factor=2 --virtual-time-budget=4500 \
    --window-size=1280,800 --user-data-dir="$UDD" --no-first-run --no-default-browser-check \
    --screenshot="$out" "http://localhost:$PORT/docs/store-assets.html?slide=$n" >/dev/null 2>&1 &
  CPID=$!
  for _ in $(seq 1 200); do [ -s "$out" ] && break; sleep 0.1; done
  sleep 0.4
  kill "$CPID" 2>/dev/null || true
  wait "$CPID" 2>/dev/null || true
  sips -z 800 1280 "$out" >/dev/null 2>&1 || true   # downscale 2x capture -> crisp 1280x800
done
echo "wrote $OUT/screenshot-{1..6}.png (1280x800)"
