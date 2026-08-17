#!/usr/bin/env bash
# Render the Microsoft Edge promotional tiles from docs/promo-tiles.html using
# headless Chrome. Outputs docs/store/promo-small-440x280.png (small tile) and
# docs/store/promo-large-1400x560.png (large tile). Same 2x-then-downscale trick
# as make-store-shots.sh so the web fonts land crisp.
set -euo pipefail

HERE="$(cd "$(dirname "$0")/.." && pwd)"
CHROME="${CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
PORT="${PORT:-8756}"
UDD="/tmp/adhan_promo_cdp"
OUT="$HERE/docs/store"

pkill -f "$UDD" 2>/dev/null || true
sleep 0.3
rm -rf "$UDD" 2>/dev/null || true
mkdir -p "$UDD" "$OUT"

python3 -m http.server "$PORT" --directory "$HERE" >/tmp/adhan_promo_server.log 2>&1 &
SRV=$!
trap 'kill "$SRV" 2>/dev/null || true; pkill -f "$UDD" 2>/dev/null || true' EXIT
until curl -s -o /dev/null "http://localhost:$PORT/docs/promo-tiles.html"; do sleep 0.3; done

render() { # name w h
  local name="$1" w="$2" h="$3" out="$OUT/promo-$1-${2}x${3}.png"
  rm -f "$out" "$UDD"/Singleton* 2>/dev/null || true
  "$CHROME" --headless=new --disable-gpu --hide-scrollbars --force-device-scale-factor=2 --virtual-time-budget=6500 \
    --window-size="$w,$h" --user-data-dir="$UDD" --no-first-run --no-default-browser-check \
    --screenshot="$out" "http://localhost:$PORT/docs/promo-tiles.html?tile=$name" >/dev/null 2>&1 &
  local pid=$!
  for _ in $(seq 1 200); do [ -s "$out" ] && break; sleep 0.1; done
  sleep 0.4
  kill "$pid" 2>/dev/null || true
  wait "$pid" 2>/dev/null || true
  sips -z "$h" "$w" "$out" >/dev/null 2>&1 || true   # 2x capture -> exact tile size
  echo "wrote $out (${w}x${h})"
}

render small 440 280
render large 1400 560
