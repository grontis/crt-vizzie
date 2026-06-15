#!/usr/bin/env python3
# bridge.py — Hardware bridge for crt-vizzie v2
#
# Phase 1: MCP3008 potentiometers → V2_PARAMS, LEDs → audio band brightness,
#           pushbuttons → browser key events.
# Protocol:
#   Pi → Browser: { "type": "hw",       "params": { "chromaBase": 4.0, ... } }
#   Pi → Browser: { "type": "hw_event", "event": "next_bg" }
#   Browser → Pi: { "type": "audio", ... }  ← drives LED PWM
#
# Usage: python3 bridge.py [--mock]

import argparse
import asyncio
import json
import logging
import sys
import threading
import time

# ── Constants ─────────────────────────────────────────────────────────────────

POLL_HZ   = 50
DEAD_ZONE = 0.005
WS_HOST   = 'localhost'
WS_PORT   = 9001

# Note: chip 0 / ch 0 is intentionally shadowed by the first three entries.
# A single pot on ch 0 drives rainOpacity, rainBurnBoost, and rainSpeedMin
# simultaneously. Reassign to free channels (7+ on chip 0, or chip 1) once
# more pots are wired up.
CHANNELS = [
    {"chip": 0, "ch": 0, "param": "rainOpacity",   "min": 0.0, "max": 1.0},
    {"chip": 0, "ch": 0, "param": "rainBurnBoost", "min": 0.0, "max": 0.5},
    {"chip": 0, "ch": 0, "param": "rainSpeedMin", "min": 0.01, "max": 0.2},
    {"chip": 0, "ch": 1, "param": "bgOpacity",   "min": 0.0, "max": 1.0},
    {"chip": 0, "ch": 2, "param": "bgFxHueShift",   "min": 0.0, "max": 100.0},
    {"chip": 0, "ch": 3, "param": "glitchScatter",   "min": 0.045, "max": 0.15},
    {"chip": 0, "ch": 4, "param": "figBrightness",   "min": 0.5, "max": 1.0},
    {"chip": 0, "ch": 5, "param": "bgAsciiLevel",   "min": 0.0, "max": 1.0},
    {"chip": 0, "ch": 6, "param": "phosphorIndex", "min": 0, "max": 4},
]

# GPIO pins for LEDs, in band order. Matches HARDWARE_SETUP.md LED table.
LED_CONFIG = [
    {"gpio": 17, "band": "sub"},
    {"gpio": 27, "band": "bass"},
    {"gpio": 22, "band": "lowMid"},
    {"gpio": 5,  "band": "mid"},
    {"gpio": 6,  "band": "highMid"},
    {"gpio": 13, "band": "treble"},
]

# GPIO pins for pushbuttons. Each fires a named event to the browser.
BUTTON_CONFIG = [
    {"gpio": 23, "event": "next_bg"},
    {"gpio": 24, "event": "toggle_bg_ascii"},
]

# ── Logging ───────────────────────────────────────────────────────────────────

logging.basicConfig(level=logging.INFO, format='%(message)s')
log = logging.getLogger('bridge')

# ── spidev / websockets imports ───────────────────────────────────────────────
# Peek sys.argv before argparse so the guard runs at module load.

_MOCK_MODE = '--mock' in sys.argv

if not _MOCK_MODE:
    try:
        import spidev
    except ImportError:
        sys.exit(
            '[bridge] ERROR: spidev not found.\n'
            '  Install with:  pip install spidev  (SPI must be enabled via raspi-config)\n'
            '  To run without hardware:  python3 bridge.py --mock'
        )
    try:
        from gpiozero import PWMLED, Button
    except ImportError:
        sys.exit(
            '[bridge] ERROR: gpiozero not found.\n'
            '  Install with:  pip install gpiozero'
        )

try:
    import websockets
except ImportError:
    sys.exit('[bridge] ERROR: websockets not found.  Install with:  pip install websockets')

# ── Shared state ──────────────────────────────────────────────────────────────

_queue: asyncio.Queue          # assigned in _main() before poll thread starts
_last_sent: dict = {}
_spi: list  = [None, None]     # [CE0, CE1] — opened in _main() for each wired chip
_leds: list = []               # PWMLED instances, populated in _main()
_buttons: list = []            # Button instances, populated in _main()

# ── SPI read ──────────────────────────────────────────────────────────────────

def _read_mcp3008(chip: int, channel: int) -> float:
    dev = _spi[chip]
    if dev is None:
        return 0.0
    rx = dev.xfer2([0x01, (0x80 | (channel << 4)) & 0xFF, 0x00])
    return ((rx[1] & 0x03) << 8 | rx[2]) / 1023.0

# ── SPI polling thread ────────────────────────────────────────────────────────

def _spi_poll_thread(loop: asyncio.AbstractEventLoop) -> None:
    log.info('[bridge] SPI poll thread started')
    while True:
        start = time.monotonic()

        updates: dict = {}
        for entry in CHANNELS:
            chip  = entry['chip']
            ch    = entry['ch']
            param = entry['param']
            raw   = _read_mcp3008(chip, ch)
            value = entry['min'] + raw * (entry['max'] - entry['min'])
            last  = _last_sent.get(param, -99.0)
            if abs(value - last) > DEAD_ZONE:
                _last_sent[param] = value
                updates[param] = value
                log.info('[bridge] chip%d ch%d %s -> %.2f', chip, ch, param, value)

        if updates:
            asyncio.run_coroutine_threadsafe(_queue.put(updates), loop)

        time.sleep(max(0.0, 1.0 / POLL_HZ - (time.monotonic() - start)))

# ── WebSocket handlers ────────────────────────────────────────────────────────

def _update_leds(msg: dict) -> None:
    bands = msg.get('bands', {})
    for led, cfg in zip(_leds, LED_CONFIG):
        led.value = max(0.0, min(1.0, float(bands.get(cfg['band'], 0.0))))

async def _recv_loop(websocket) -> None:
    async for raw in websocket:
        try:
            msg = json.loads(raw)
        except json.JSONDecodeError:
            continue
        if msg.get('type') == 'audio' and _leds:
            try:
                _update_leds(msg)
            except Exception as exc:
                log.warning('[bridge] LED update error: %s', exc)

async def _send_loop(websocket) -> None:
    while True:
        item = await _queue.get()
        if '_event' in item:
            msg = json.dumps({'type': 'hw_event', 'event': item['_event']})
        else:
            msg = json.dumps({'type': 'hw', 'params': item})
        try:
            await websocket.send(msg)
        except Exception as exc:
            log.warning('[bridge] send failed: %s', exc)
            raise

async def _handler(websocket) -> None:
    addr = getattr(websocket, 'remote_address', ('?', 0))
    log.info('[bridge] client connected from %s:%s', *addr[:2])

    recv_task = asyncio.create_task(_recv_loop(websocket))
    send_task = asyncio.create_task(_send_loop(websocket))

    done, pending = await asyncio.wait(
        [recv_task, send_task],
        return_when=asyncio.FIRST_COMPLETED,
    )
    for task in pending:
        task.cancel()
        try:
            await task
        except (asyncio.CancelledError, Exception):
            pass

    log.info('[bridge] client disconnected from %s:%s', *addr[:2])

# ── Entry point ───────────────────────────────────────────────────────────────

async def _main(mock: bool) -> None:
    global _queue
    _queue = asyncio.Queue()  # MUST be assigned before poll thread starts

    loop = asyncio.get_running_loop()

    if not mock:
        dev = spidev.SpiDev()
        dev.open(0, 0)  # CE0
        dev.max_speed_hz = 1_000_000
        dev.mode = 0
        _spi[0] = dev
        log.info('[bridge] SPI CE0 opened at 1 MHz')

        for cfg in LED_CONFIG:
            _leds.append(PWMLED(cfg['gpio']))
        log.info('[bridge] %d LEDs initialized (GPIO %s)',
                 len(_leds), [c['gpio'] for c in LED_CONFIG])

        for cfg in BUTTON_CONFIG:
            event_name = cfg['event']
            btn = Button(cfg['gpio'], bounce_time=0.05)
            btn.when_pressed = lambda name=event_name: asyncio.run_coroutine_threadsafe(
                _queue.put({'_event': name}), loop
            )
            _buttons.append(btn)
        log.info('[bridge] %d buttons initialized (GPIO %s)',
                 len(_buttons), [c['gpio'] for c in BUTTON_CONFIG])

    if mock:
        await _queue.put({'chromaBase': 4.0})
        log.info('[bridge] MOCK: sent chromaBase -> 4.0')

    poll_thread = threading.Thread(
        target=_spi_poll_thread,
        args=(loop,),
        daemon=True,
        name='spi-poll',
    )
    poll_thread.start()

    log.info('[bridge] WebSocket server starting on ws://%s:%d', WS_HOST, WS_PORT)
    async with websockets.serve(_handler, WS_HOST, WS_PORT):
        log.info('[bridge] listening — Ctrl+C to stop')
        try:
            await asyncio.Future()
        except asyncio.CancelledError:
            pass


def _parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description='crt-vizzie hardware bridge')
    p.add_argument('--mock', action='store_true',
                   help='emit one hardcoded test message then go quiet')
    return p.parse_args()


if __name__ == '__main__':
    args = _parse_args()
    try:
        asyncio.run(_main(mock=args.mock))
    except KeyboardInterrupt:
        log.info('[bridge] shutting down')
