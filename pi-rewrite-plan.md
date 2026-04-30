# pi/ Hardware Bridge — Rewrite Plan

**Date:** 2026-04-30
**Branch:** webgl-rewrite
**Status:** planning (no code written yet)

---

## 1. Goals and non-goals

**In scope**

- Replace `pi/pi-bridge.py` with a single minimal Python file `pi/bridge.py`.
- Keep the existing transport: asyncio WebSocket server on `ws://localhost:9001`, dual-MCP3008 via spidev, same message envelope (`{type:"hw", params:{...}}`).
- Phase 0 baseline: one pot wired, one param mapped, everything else deleted.
- Incremental phase plan to grow from one channel to a full 16-channel dual-chip setup.

**Out of scope — do not touch**

- `v2/hardware-bridge.js` and anything else in `v2/`. The browser side is correct.
- LED output. No `led_output.py`, no GPIO out, no return-path for audio data.
- Button inputs (GPIO in). Different code path; planned for a later phase.
- Multi-component abstractions, hot-reload, plugin systems. One knob first.
- JSON mapping file. Inline Python dict until channel count justifies otherwise (see Phase 5).

---

## 2. Files deleted up front

All existing `pi/` files except `HARDWARE_SETUP.md` and `pi-start.sh` are deleted before writing a single line of new code.

| File | Reason |
|---|---|
| `pi/pi-bridge.py` | Replaced by `pi/bridge.py`. Carries LED import, JSON-mapping load, stale bgFx dot-path logic, mock-sine fallback, broadcast-all-on-change pattern. |
| `pi/hw-mapping.json` | References stale params (`bgFx.warpAmount`, `bgFx.chromaOffset`, `bgFx.warpFreq`, `bgPulseAmount`). Source of config rot. Replaced by inline Python dict. |
| `pi/led_output.py` | LED output is out of scope. Nothing in the new bridge imports it. |
| `pi/pi-sim.py` | Old simulator; WS protocol reference no longer needed. |
| `pi/sim-ui.html` | Goes with pi-sim.py. |

**Keep (update in place)**

- `pi/HARDWARE_SETUP.md` — wiring is mostly accurate; update one line: replace `FUSION_PARAMS` with `V2_PARAMS`.
- `pi/pi-start.sh` — still fine; update the script name from `pi-bridge.py` to `bridge.py`.

---

## 3. Target architecture — Phase 0 baseline

A single file: `pi/bridge.py`. Approximately 80 lines in Phase 0.

### Structure

```
pi/bridge.py

  CHANNELS = [
    {"chip": 0, "ch": 0, "param": "chromaBase", "min": 0.0, "max": 8.0},
  ]

  _read_mcp3008(chip, channel) -> float 0-1
  _spi_poll_thread(loop)
      polls all CHANNELS at POLL_HZ
      dead-zone check per param
      pushes changed values onto asyncio.Queue
  _recv_loop(ws)
      async for raw in ws: pass   <- discard audio messages, no LED path
  _send_loop(ws)
      drain queue, json.dumps, ws.send
  _handler(ws)
      asyncio.wait([recv_task, send_task], FIRST_COMPLETED)
  _main()
      open SPI CE0 only (CE1 stays unwired)
      start poll thread
      websockets.serve(_handler, "localhost", 9001)
```

### Key decisions baked in

**No JSON mapping file.** The `CHANNELS` list lives at the top of `bridge.py`. Adding a channel is a one-line edit. A JSON file adds a parsing step, a file path dependency, and a place for keys to go stale — exactly what happened last time. Switch to JSON only if you want to edit mappings without touching Python and have more than ~4 channels (see Phase 5).

**No mock-sine fallback.** The old mock mode emitted continuous sine updates even with no hardware, making it hard to distinguish "is the WS plumbing working?" from "is the ADC actually reading?" The new bridge has an explicit `--mock` flag that emits a single test value on startup and then goes quiet. Unambiguous smoke test: one message arrives, param changes in browser, done.

**Discard audio messages silently.** The browser sends `{type:"audio",...}` at ~16 Hz. The `_recv_loop` does `async for raw in ws: pass`. No logging, no parsing, no error path.

**CE0 only in Phase 0.** `_spi[1]` is not opened. Opening both chips when only one is wired causes a silent `0.0` read on every CE1 channel, generating a flood of fake updates. Don't open what isn't wired.

**POLL_HZ = 50.** Was 60 in the old bridge; 50 gives a clean 20 ms interval and is indistinguishable to the eye.

**DEAD_ZONE = 0.005.** Kept from the original — proven adequate for MCP3008 noise floor.

**Log format:** `[bridge] chip0 ch0 chromaBase -> 4.32`

---

## 4. First-param recommendation

**Recommended: `chromaBase`**

Range: `min: 0.0, max: 8.0` (matches `V2_PARAM_RANGES.chromaBase` exactly)

Why this param:

- Controls the horizontal RGB channel split across the full render. At `0.0` it is invisible; at `8.0` it is dramatic. Effect is immediate, full-screen, and continuously variable.
- No layer needs to be enabled. No audio input required. Works in any visual state.
- Compared to alternatives: `scanlineIntensity` is subtler at the default mode; `figBrightness` only affects the figure layer and depends on the reseed cycle; `bgOpacity` requires a background image loaded. `chromaBase` has zero dependencies.

Pot scaling: full CCW = 0.0 (no aberration), full CW = 8.0 (heavy RGB split).

---

## 5. Incremental phase plan

### Phase 0 — scaffold + `--mock` flag, no hardware required

**Goal:** Prove the WS plumbing works end-to-end before touching any hardware.

**Code change:** Write `pi/bridge.py` with `CHANNELS = []`. Add `--mock` CLI flag: when set, put one hardcoded message `{"chromaBase": 4.0}` onto the queue at startup, then do nothing.

**Verification:**
1. Open the v2 app in Chrome (demo audio mode).
2. Run `python3 pi/bridge.py --mock` on the same machine.
3. `hardware-bridge.js` connects to `ws://localhost:9001`.
4. Single mock message fires. Chromatic aberration jumps visibly (default is 1.5 px; mock sends 4.0 — noticeable spread).
5. Log line: `[bridge] MOCK: sent chromaBase -> 4.0`.
6. No further messages. Value stays at 4.0 until page refresh.

### Phase 1 — real MCP3008, chip 0 channel 0, one pot -> `chromaBase`

**Wiring:** Pot wiper -> MCP3008 chip 0 CH0 (pin 1). See `HARDWARE_SETUP.md` for SPI pinout.

**Code change:** Populate `CHANNELS`:
```python
CHANNELS = [
    {"chip": 0, "ch": 0, "param": "chromaBase", "min": 0.0, "max": 8.0},
]
```
Open spidev CE0 in `_main()`.

**Verification:**
- Turn knob CCW to min. Log: `[bridge] chip0 ch0 chromaBase -> 0.00`. Canvas: no split.
- Turn knob CW to max. Log: `[bridge] chip0 ch0 chromaBase -> 8.00`. Canvas: heavy RGB spread.
- Slow micro-adjustment near center should not flood logs (dead-zone check).

### Phase 2 — second pot, chip 0 channel 1 -> second param

Suggested: `chromaBeat` (range `0.0–12.0`). Pairs with `chromaBase`; full aberration system under hardware control from one chip.

Alternative if you want layer-mix control instead: `rainOpacity` or `waveOpacity` (both `0.0–1.0`).

**Code change:** Add one entry to `CHANNELS`.

**Verification:** Same pattern. Turn each knob independently; confirm only its mapped param changes.

### Phase 3 — fill chip 0 (channels 2–7)

Add pots one at a time. Suggested order (visually obvious params first):

| CH | Param | Range | Why first |
|---|---|---|---|
| 2 | `rainOpacity` | 0–1 | Layer mix, instantly visible |
| 3 | `waveOpacity` | 0–1 | Layer mix, distinct from rain |
| 4 | `figBrightness` | 0.1–1.0 | Figure layer brightness |
| 5 | `bgOpacity` | 0–1 | BG blend (requires bg loaded) |
| 6 | `scanlineIntensity` | 0–1 | CRT feel |
| 7 | `glitchChance` | 0.05–1.0 | Glitch layer activity |

Stop whenever the panel feels complete. You do not have to use all 8 channels.

**Verification per channel:** Add one entry, restart bridge, turn knob, confirm log and canvas response. Then add the next.

### Phase 4 — wire chip 1 (CE1), first pot

**Wiring:** Second MCP3008 -> SPI0 CE1. See `HARDWARE_SETUP.md`.

**Code change:** Open spidev CE1 in `_main()`. Add one `CHANNELS` entry with `"chip": 1`.

Opening CE1 before it is physically wired produces a flood of 0.0 reads. Confirm CE1 is connected and reads cleanly before populating more channels from it.

**Verification:** Add `{"chip": 1, "ch": 0, "param": "waveSpeed", "min": 0.01, "max": 0.12}`. Log: `[bridge] chip1 ch0 waveSpeed -> X.XX`. Wave layer speed changes.

### Phase 5 — JSON mapping (optional, trigger: >4 channels)

If you want to tune ranges without editing Python, extract `CHANNELS` to `pi/hw-mapping.json`. Format: flat array, same keys as the Python dict. Load with `json.load` at startup.

If you are comfortable editing `bridge.py` directly, skip this phase entirely.

### Phase 6+ — buttons and LEDs (future, not planned here)

- **Buttons:** GPIO in, debouncing, send boolean params. Separate code path from ADC polling.
- **LEDs:** GPIO out / PWM. Requires parsing `{type:"audio",...}` in `_recv_loop` (currently discarded). Reintroduce `led_output.py` when ready.

Both are separate phases with their own design passes. Do not mix into the ADC polling code.

---

## 6. Mock / dev workflow

### Dev laptop (no Pi, no spidev)

Run `python3 pi/bridge.py --mock`. Fires one message, stays alive for WS connection. Use this to confirm `hardware-bridge.js` connects and writes the param.

In Phase 1+ (non-mock), the bridge detects `spidev` `ImportError` and exits with a clear error message. Do not silently return `0.0` for all channels — that was a debugging trap in the original bridge.

### On the Pi

No `--mock`. Run `python3 pi/bridge.py`. SPI opens CE0 (CE1 when wired). Knob turns produce log lines. Pipe through `grep bridge` if running under systemd to filter noise.

### Per-channel verification sequence (applies to every phase addition)

1. Edit `CHANNELS`, add new entry.
2. Restart bridge.
3. Turn new knob full CCW, confirm log shows near-`min` value and canvas responds (or is expectedly invisible).
4. Turn full CW, confirm log shows near-`max` value.
5. Verify no other params are affected (confirms correct SPI wiring).

---

## 7. Open questions for you

1. **Keep `--mock` permanently?** Recommend yes — costs 5 lines, saves setup time when testing on laptop. Or remove after Phase 1 if you prefer.

2. **Second param choice:** `chromaBeat` is the suggestion for Phase 2, but if you want layer-mix control immediately, `rainOpacity` or `waveOpacity` are better for demos. Decide before implementing Phase 2.

3. **JSON config:** Do you want the option of a JSON mapping from the start, or no JSON path until Phase 5? Cleaner to have no JSON path until it is needed — one less thing to maintain.

4. **Systemd unit:** `pi-start.sh` is a manual launcher. Do you want a `bridge.service` systemd unit for auto-start on boot added in a later phase?

---

## 8. First-step checklist (Phase 0)

In order:

1. Delete `pi/pi-bridge.py`, `pi/hw-mapping.json`, `pi/led_output.py`, `pi/pi-sim.py`, `pi/sim-ui.html`.
2. Edit `pi/HARDWARE_SETUP.md`: replace `FUSION_PARAMS` with `V2_PARAMS` wherever it appears.
3. Edit `pi/pi-start.sh`: change `pi-bridge.py` to `bridge.py` in the exec line.
4. Write `pi/bridge.py` — Phase 0 scaffold with empty `CHANNELS`, `--mock` flag, silent `_recv_loop`. Target: ~80 lines.
5. Run `python3 pi/bridge.py --mock` alongside the v2 app, confirm the single mock message lands and chromatic aberration jumps in the renderer.
