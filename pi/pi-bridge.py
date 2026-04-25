#!/usr/bin/env python3
# pi-bridge.py — Hardware bridge for crt-vizzie
#
# Reads MCP3008 ADC channels via spidev, broadcasts param-update messages over
# WebSocket (ws://localhost:9001), and receives audio state from the browser to
# drive LEDs via led_output.py.
#
# Usage (Raspberry Pi):
#   pip install websockets
#   python pi-bridge.py
#
# Usage (dev machine, no hardware):
#   python pi-bridge.py          # spidev unavailable → falls back to mock sine mode
#
# Protocol:
#   Pi → Browser:  { "type": "hw",    "params": { "rainSpeed": 0.42, ... } }
#   Browser → Pi:  { "type": "audio", "beatActive": bool, "beatIntensity": float,
#                    "bands": { "sub": float, "bass": float, "lowMid": float,
#                               "mid": float, "highMid": float, "treble": float } }

import asyncio
import json
import math
import os
import threading
import time
import logging

import led_output

# ── Logging setup ─────────────────────────────────────────────────────────────
logging.basicConfig(
    level=logging.DEBUG,
    format='[bridge] %(levelname)s %(message)s',
)
log = logging.getLogger('bridge')

# ── SPI / Mock detection ──────────────────────────────────────────────────────
try:
    import spidev
    _SPI_AVAILABLE = True
    log.info('spidev loaded — hardware SPI mode')
except ImportError:
    _SPI_AVAILABLE = False
    log.info('spidev not available — running in mock (sine wave) mode')

try:
    import websockets
except ImportError as exc:
    raise SystemExit(
        '[bridge] ERROR: websockets package not found.\n'
        '  Install with:  pip install websockets'
    ) from exc

# ── Constants ─────────────────────────────────────────────────────────────────
DEAD_ZONE   = 0.005       # minimum change before emitting an update
WS_HOST     = 'localhost'
WS_PORT     = 9001
POLL_HZ     = 60          # ADC polling rate (Hz)

# ── Load channel mapping ──────────────────────────────────────────────────────
_script_dir  = os.path.dirname(os.path.abspath(__file__))
_mapping_path = os.path.join(_script_dir, 'hw-mapping.json')

with open(_mapping_path, 'r') as _f:
    _raw = json.load(_f)

# Support both { "channels": [...] } and bare array formats
if isinstance(_raw, dict) and 'channels' in _raw:
    MAPPING = _raw['channels']
else:
    MAPPING = _raw

log.info('Loaded %d channel mappings from hw-mapping.json', len(MAPPING))

# ── SPI init (hardware only) ──────────────────────────────────────────────────
_spi = None
if _SPI_AVAILABLE:
    try:
        _spi = spidev.SpiDev()
        _spi.open(0, 0)           # bus 0, device CE0
        _spi.max_speed_hz = 1_000_000
        _spi.mode = 0
        log.info('SPI opened on /dev/spidev0.0 at 1 MHz')
    except Exception as e:
        log.warning('SPI open failed (%s) — falling back to mock mode', e)
        _spi = None

def _read_mcp3008(channel: int) -> float:
    """
    Read one MCP3008 channel via spidev.
    Returns a float in 0.0–1.0.
    Standard 3-byte SPI transaction (single-ended, MCP3008 protocol).
    """
    if _spi is None:
        return 0.0
    rx = _spi.xfer2([0x01, (0x80 | (channel << 4)) & 0xFF, 0x00])
    raw = ((rx[1] & 0x03) << 8) | rx[2]  # 10-bit result (0–1023)
    return raw / 1023.0

def _scale(normalized: float, entry: dict) -> float:
    """Map a 0.0–1.0 normalized ADC value to the entry's [min, max] range."""
    lo = entry.get('min', 0.0)
    hi = entry.get('max', 1.0)
    return lo + normalized * (hi - lo)

# ── Shared state ──────────────────────────────────────────────────────────────
_adc_queue: asyncio.Queue  # created in main(), referenced by thread
_last_sent: dict = {}       # param → last emitted value (dead-zone tracking)
_mock_time: float = 0.0     # used by mock mode sine generator

# ── SPI polling thread ────────────────────────────────────────────────────────
def _spi_poll_thread(loop: asyncio.AbstractEventLoop) -> None:
    """
    Runs in a daemon threading.Thread.
    Polls all mapped channels at POLL_HZ and pushes changed values onto _adc_queue
    via asyncio.run_coroutine_threadsafe so the asyncio loop can relay them safely.
    """
    global _mock_time

    log.info('SPI poll thread started (mode: %s)', 'hardware' if (_spi is not None) else 'mock')

    while True:
        start = time.monotonic()

        updates: dict = {}

        for entry in MAPPING:
            ch    = entry['channel']
            param = entry['param']

            if _spi is not None:
                # Hardware: real ADC read
                normalized = _read_mcp3008(ch)
            else:
                # Mock: slowly-changing sine wave per channel, unique phase per channel
                phase = _mock_time + ch * (math.pi * 2 / max(len(MAPPING), 1))
                normalized = (math.sin(phase) + 1.0) / 2.0  # 0.0–1.0

            value = _scale(normalized, entry)
            last  = _last_sent.get(param, -99.0)

            if abs(value - last) > DEAD_ZONE:
                _last_sent[param] = value
                updates[param] = value
                log.debug('ch%d %s → %.4f', ch, param, value)

        if updates:
            asyncio.run_coroutine_threadsafe(_adc_queue.put(updates), loop)

        _mock_time += (1.0 / POLL_HZ) * 0.1  # mock advances slowly (~10s per cycle)

        elapsed = time.monotonic() - start
        sleep_s = max(0.0, (1.0 / POLL_HZ) - elapsed)
        time.sleep(sleep_s)

# ── WebSocket handlers ────────────────────────────────────────────────────────
async def _recv_loop(websocket) -> None:
    """Receive audio state from the browser and forward to led_output."""
    async for raw in websocket:
        try:
            msg = json.loads(raw)
        except json.JSONDecodeError:
            log.warning('Received non-JSON message — ignored')
            continue

        if msg.get('type') == 'audio':
            beat_active    = bool(msg.get('beatActive', False))
            beat_intensity = float(msg.get('beatIntensity', 0.0))
            bands          = msg.get('bands', {})
            log.debug('audio: beat=%s intensity=%.3f sub=%.2f bass=%.2f',
                      beat_active, beat_intensity,
                      bands.get('sub', 0), bands.get('bass', 0))
            try:
                led_output.update_leds(beat_active, beat_intensity, bands)
            except Exception as e:
                log.error('led_output.update_leds error: %s', e)


async def _send_loop(websocket) -> None:
    """Drain the ADC queue and send hw param-update messages to the browser."""
    while True:
        updates = await _adc_queue.get()
        msg     = json.dumps({'type': 'hw', 'params': updates})
        try:
            await websocket.send(msg)
        except Exception as e:
            log.warning('Send failed: %s', e)
            raise  # let handler cancel both tasks


async def _handler(websocket) -> None:
    """
    Handle a single client connection.
    Single-client model: each new connection replaces the previous one.
    Runs recv and send tasks concurrently; cancels the other when one finishes.
    """
    remote = getattr(websocket, 'remote_address', ('?', 0))
    log.info('Client connected from %s:%s', *remote[:2])

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

    log.info('Client disconnected from %s:%s', *remote[:2])


# ── Entry point ───────────────────────────────────────────────────────────────
async def _main() -> None:
    global _adc_queue

    _adc_queue = asyncio.Queue()

    loop = asyncio.get_event_loop()
    poll_thread = threading.Thread(
        target=_spi_poll_thread,
        args=(loop,),
        daemon=True,
        name='spi-poll',
    )
    poll_thread.start()

    log.info('WebSocket server starting on ws://%s:%d', WS_HOST, WS_PORT)
    async with websockets.serve(_handler, WS_HOST, WS_PORT):
        log.info('Listening — press Ctrl+C to stop')
        try:
            await asyncio.Future()   # run forever
        except asyncio.CancelledError:
            pass


if __name__ == '__main__':
    try:
        asyncio.run(_main())
    except KeyboardInterrupt:
        log.info('Shutting down')
