#!/bin/bash
# v2/kiosk.sh — Launch v2 WebGL ASCII visualizer in Chromium kiosk mode on Pi 5
#
# Usage:
#   chmod +x kiosk.sh
#   ./kiosk.sh
#
# Prerequisites (Pi OS Bookworm):
#   - Chromium browser installed (chromium-browser package)
#   - Python 3 available (python3 in PATH)
#   - Wayland compositor running (default on Bookworm with labwc or wayfire)
#   - pi-bridge.py running (optional — hardware controls; silent if absent)
#
# The script starts python3 http.server for the v2 app and Chromium in kiosk
# mode. When Chromium exits (e.g. from Escape or SIGTERM), the HTTP server is
# killed.

set -euo pipefail

# Resolve the directory this script lives in
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "[kiosk] Starting HTTP server for v2..."
cd "$SCRIPT_DIR"
python3 -m http.server 8080 --bind 127.0.0.1 &
HTTP_PID=$!

# Give the HTTP server a moment to bind
sleep 1

echo "[kiosk] Starting Chromium kiosk..."
chromium-browser \
  --kiosk \
  --ozone-platform=wayland \
  --ignore-gpu-blocklist \
  --enable-gpu-rasterization \
  --enable-features=CanvasOopRasterization \
  --no-first-run \
  --disable-infobars \
  --noerrdialogs \
  --disable-translate \
  --disable-features=TranslateUI \
  --autoplay-policy=no-user-gesture-required \
  --disable-session-crashed-bubble \
  --disable-restore-session-state \
  http://localhost:8080

echo "[kiosk] Chromium exited — stopping HTTP server (PID $HTTP_PID)"
kill "$HTTP_PID" 2>/dev/null || true
