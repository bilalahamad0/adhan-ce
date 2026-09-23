#!/bin/bash
# scripts/launch-chrome-debug.sh
# Launches Google Chrome with remote debugging on port 9222 and disables origin checks
# so that browser automation agents can connect directly without requiring an "Allow" prompt.

echo "Launching Google Chrome with remote debugging on port 9222..."

/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
  --remote-debugging-port=9222 \
  --remote-allow-origins="*" \
  --restore-last-session >/dev/null 2>&1 &

echo "Chrome launched with remote debugging enabled (Port 9222, zero prompts required)."
