# Desktop Simulator — pi/pi-sim.py

Replaces `pi-bridge.py` for development on machines without Raspberry Pi hardware.
Gives you interactive drag sliders for all 16 hw-mapping.json channels and a live
audio / LED output readout — no ADC, no SPI, no Pi required.

---

## Quickstart

```bash
pip install websockets     # one-time
python pi/pi-sim.py
```

Then open two browser tabs:

| Tab | URL | Role |
|---|---|---|
| A | `http://localhost:8080` | Main visualizer (serve with `npx serve .` or `python -m http.server 8080`) |
| B | Open `pi/sim-ui.html` directly (File → Open, or drag onto browser) | Slider control panel |

Drag any slider in Tab B — the corresponding `FUSION_PARAMS` value updates live in
the Fusion panel in Tab A. Audio data flowing back from Tab A appears in the readout
panel at the bottom of Tab B, and as LED output lines in the terminal.

---

## What the simulator does

```
Tab B (sim-ui.html)          pi-sim.py               Tab A (visualizer)
──────────────────────────────────────────────────────────────────────
drag slider  ──► sim-set ──► convert to hw ──► broadcast
                                                          ──► hardware-bridge.js
                                                              applies to FUSION_PARAMS
                                                              syncs Fusion panel

             ◄── audio  ◄── forward + print ◄── hardware-bridge.js sends audio state
update panel                [led] beat=* ...
```

`pi-sim.py` is a drop-in replacement for `pi-bridge.py` — both run on `ws://localhost:9001`
and speak the same protocol. `hardware-bridge.js` in the browser cannot tell the difference.

---

## Simulator UI

- **Two columns** — chip 0 channels (left) and chip 1 channels (right)
- **One row per channel** — label, live value readout, drag slider
- **Sliders initialize at midpoint** of each channel's `[min, max]` range
- **Audio panel** (bottom) — beat flash indicator, intensity %, six frequency band bars
- **Status indicator** (top-right) — shows CONNECTED / DISCONNECTED

---

## Verbose logging

```bash
python pi/pi-sim.py --debug
```

Logs every `sim-set` message with the param name, scaled value, and number of clients
it was broadcast to.

---

## Updating channel mappings

`sim-ui.html` inlines the channel list directly (so it works from `file://` without
a server). If you change `hw-mapping.json`, update the `const CHANNELS = [...]` array
in `sim-ui.html` to match. A comment at the top of the array points to the source file.

---

## Connecting order

Either tab can connect first — the server has no concept of "main app" vs "control page".
It routes purely by message type:

- `sim-set` → converted to `hw` and sent to all other connected clients
- `audio` → forwarded to all other connected clients + printed to stdout

If you close and reopen a tab, it reconnects automatically within 2 seconds.

---

## Running sim-ui.html over HTTP (if file:// is blocked)

Some browser configurations block WebSocket connections from `file://` pages. If the
status indicator stays DISCONNECTED after the server starts, serve the file instead:

```bash
npx serve pi/
# open http://localhost:3000/sim-ui.html
```
