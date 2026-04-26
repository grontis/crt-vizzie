#!/usr/bin/env python3
# pi-sim.py — Desktop simulator for crt-vizzie pi-bridge
#
# Replaces pi-bridge.py for development without Raspberry Pi hardware.
# Runs an asyncio WebSocket server on ws://localhost:9001 (same port as
# pi-bridge.py). Two clients connect simultaneously:
#
#   Tab A — main crt-vizzie app  (hardware-bridge.js connects here)
#   Tab B — pi/sim-ui.html       (drag sliders to send sim-set messages)
#
# Message routing:
#   sim-set  (from Tab B) → convert to hw, broadcast to all OTHER clients
#   audio    (from Tab A) → print LED summary to stdout, forward to all OTHER clients
#   anything else         → log and ignore
#
# Usage:
#   pip install websockets
#   python pi/pi-sim.py
#   python pi/pi-sim.py --debug    # verbose per-message logging
#
# Then open pi/sim-ui.html directly in a browser tab (drag-and-drop or File → Open).
# No HTTP server required — WebSocket connections from file:// are permitted in all
# major browsers (Chrome, Firefox). If your browser blocks them, serve with:
#   npx serve pi/   →  open http://localhost:3000/sim-ui.html

import asyncio
import json
import logging
import os
import sys

try:
    import websockets
except ImportError as exc:
    raise SystemExit(
        '[sim] ERROR: websockets package not found.\n'
        '  Install with:  pip install websockets'
    ) from exc

# ── Logging setup ──────────────────────────────────────────────────────────────
_debug = '--debug' in sys.argv
logging.basicConfig(
    level=logging.DEBUG if _debug else logging.INFO,
    format='[sim] %(levelname)s %(message)s',
)
log = logging.getLogger('sim')

# ── Constants ──────────────────────────────────────────────────────────────────
WS_HOST = 'localhost'
WS_PORT = 9001

# ── Multi-client registry ──────────────────────────────────────────────────────
_clients: set = set()


def _scale(normalized: float, entry: dict) -> float:
    """Map a 0.0–1.0 normalized value to the entry's [min, max] range.
    Included for future validation use; the main path receives pre-scaled values
    from sim-ui.html sliders.
    """
    lo = entry.get('min', 0.0)
    hi = entry.get('max', 1.0)
    return lo + normalized * (hi - lo)


async def _broadcast(message: str, exclude=None) -> None:
    """Send `message` to all connected clients except `exclude`.
    Catches and logs send errors without crashing the loop.
    """
    for client in list(_clients):
        if client is exclude:
            continue
        try:
            await client.send(message)
        except Exception as e:
            log.debug('Broadcast send error (client will disconnect): %s', e)


async def _handler(websocket) -> None:
    """Handle a single client connection."""
    remote = getattr(websocket, 'remote_address', ('?', 0))
    log.info('Client connected from %s:%s', *remote[:2])
    _clients.add(websocket)

    try:
        async for raw in websocket:
            try:
                msg = json.loads(raw)
            except json.JSONDecodeError:
                log.warning('Received non-JSON message — ignored')
                continue

            msg_type = msg.get('type')

            if msg_type == 'sim-set':
                param = msg.get('param', '')
                try:
                    value = float(msg.get('value', 0.0))
                except (ValueError, TypeError):
                    log.warning('Invalid value in sim-set — ignored')
                    continue
                hw_msg = json.dumps({'type': 'hw', 'params': {param: value}})
                await _broadcast(hw_msg, exclude=websocket)
                log.debug('sim-set %s → %.4f → broadcast to %d client(s)', param, value, len(_clients) - 1)

            elif msg_type == 'audio':
                beat    = msg.get('beatActive', False)
                intens  = float(msg.get('beatIntensity', 0.0))
                bands   = msg.get('bands', {})
                # Simulate led_output.update_leds — print to stdout
                beat_marker = '*' if beat else ' '
                print(
                    f'[led] beat={beat_marker} intensity={intens:.3f}'
                    f'  sub={bands.get("sub", 0):.2f}'
                    f'  bass={bands.get("bass", 0):.2f}'
                    f'  lowMid={bands.get("lowMid", 0):.2f}'
                    f'  mid={bands.get("mid", 0):.2f}'
                    f'  highMid={bands.get("highMid", 0):.2f}'
                    f'  treble={bands.get("treble", 0):.2f}'
                )
                log.debug(
                    'audio beat=%s intensity=%.3f bass=%.2f',
                    beat, intens, bands.get('bass', 0)
                )
                # Forward raw audio message to sim-ui for visual readout
                await _broadcast(raw, exclude=websocket)

            else:
                log.warning('Unknown message type: %s — ignored', msg_type)

    except websockets.exceptions.ConnectionClosed:
        pass
    finally:
        _clients.discard(websocket)
        log.info('Client disconnected from %s:%s', *remote[:2])


async def _main() -> None:
    _script_dir = os.path.dirname(os.path.abspath(__file__))
    sim_ui_path = os.path.join(_script_dir, 'sim-ui.html')

    log.info('WebSocket server listening on ws://%s:%d', WS_HOST, WS_PORT)
    log.info('Open sim-ui.html in a browser tab:')
    log.info('  file://%s', sim_ui_path)
    log.info('  (or: npx serve pi/ → http://localhost:3000/sim-ui.html)')
    log.info('Press Ctrl+C to stop')

    async with websockets.serve(_handler, WS_HOST, WS_PORT):
        try:
            await asyncio.Future()  # run forever
        except asyncio.CancelledError:
            pass


if __name__ == '__main__':
    try:
        asyncio.run(_main())
    except KeyboardInterrupt:
        log.info('Shutting down')
