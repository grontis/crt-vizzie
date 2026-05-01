#!/bin/bash
# pi-start.sh — Start HTTP server and hardware bridge for Pi deployment
#
# Usage:
#   ./pi-start.sh
#
# Starts:
#   1. Python HTTP file server on port 8080 (serves the visualizer from repo root)
#   2. bridge.py WebSocket bridge on port 9001 (reads MCP3008 ADC → V2_PARAMS)
#
# Open http://localhost:8080 in Chromium after starting.
#
# Dependencies (Raspberry Pi):
#   pip install websockets
#
# The HTTP server is killed automatically when bridge.py exits (Ctrl+C).

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
APP_DIR="$(dirname "$SCRIPT_DIR")"

python -m http.server 8080 --directory "$APP_DIR" &
HTTP_PID=$!
echo "[pi-start] HTTP server started (PID $HTTP_PID) on http://localhost:8080"

trap "echo '[pi-start] Stopping HTTP server...'; kill $HTTP_PID 2>/dev/null" EXIT

echo "[pi-start] Starting hardware bridge..."
python "$SCRIPT_DIR/bridge.py"
