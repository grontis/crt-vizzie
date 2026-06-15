# VIZZÍE

Audio-reactive ASCII visualizer for CRT TV. WebGL 2 renderer — runs at 30+ fps on Raspberry Pi 5.

---

## Running locally

```bash
cd v2
python3 -m http.server 8080
```

Then open **http://localhost:8080** in Chrome or Chromium. Press `D` to start demo mode.

### Startup screen

On load a retro terminal boot sequence appears with three audio source options:

| Option | Action |
|---|---|
| `1` | Demo mode — plays built-in synthesizer |
| `2` | Live input — uses microphone / line-in (`getUserMedia`) |
| `3` | Load file — opens a file picker (MP3/OGG/WAV) |

Arrow keys move the highlight; Enter confirms.

### Controls

| Key | Action |
|---|---|
| `D` | Toggle demo synthesizer |
| `A` | Load audio file (MP3/OGG/WAV) |
| `B` | Toggle background image layer on/off |
| `X` | Toggle audio-reactive bg FX (filter/transform) |
| `V` | Toggle background ASCII layer (luma → density ramp) |
| `L` | Load a single background image or video from file |
| `M` | Pick / re-pick the bg-media folder (FS Access API) |
| `←` / `→` | Cycle through background media playlist (see below) |
| `S` | Cycle scanline mode (OFF → PIXEL → CELL-GAP → SMOOTH) |
| `P` | Cycle phosphor color (green → amber → blue → red → white) |
| `Tab` | Toggle live bg-FX tuning panel |
| `F` | Toggle fullscreen (works during startup screen too) |
| `Escape` | Close bg-FX panel; otherwise exit fullscreen |
| `` ` `` | Show glyph atlas debug overlay (requires `#debug-atlas` in URL) |
| `~` | Toggle FPS / frame-time overlay |
| Drop audio file | Load and loop as audio source |

#### Scanline modes

| Mode | Description |
|---|---|
| OFF | No scanlines |
| PIXEL | Every other pixel row darkened (subtle texture) |
| CELL-GAP | Dark retrace band at the bottom of each character row (default) |
| SMOOTH | Sine falloff — bright at cell center, dim at top/bottom edges |

---

## Background media

The visualizer cycles through a folder of images and videos as the layer behind the ASCII grid. The playlist is read live from the local filesystem via the **File System Access API** — there is no manifest, no copy step, and media is streamed from disk on demand (no full-file buffering).

**Supported formats:** `.jpg .jpeg .png .gif .webp` (images) — `.mp4 .webm .mov .mkv .m4v` (video, looped + muted).

> **Codec note.** Container support varies by browser — Chromium plays MP4/H.264 and WebM/VP9 reliably; some MKV/HEVC/AV1 files won't decode. If a clip fails to load, the playlist auto-advances to the next file and shows the error briefly.

### Setup

1. Press `M`. A folder picker opens — choose any directory containing supported media. The browser remembers the granted handle in IndexedDB, so subsequent launches restore it silently.

2. Press `→` and `←` to cycle. The picked file plays from disk via the OS file handle — bytes are read on demand, never buffered into memory.

3. To use a different folder later, press `M` again.

> **Browser support.** The folder picker requires a Chromium-based browser (Chrome, Edge, Brave, Chromium). Firefox doesn't implement `showDirectoryPicker` yet — use `L` to load individual files instead.

### Usage

| Key | Action |
|---|---|
| `M` | Pick / re-pick the bg-media folder |
| `→` | Next file in the playlist (wraps to first at the end) |
| `←` | Previous file (wraps to last at the start) |
| `B` | Toggle the background layer on/off |
| `L` | Load a single file from outside the folder (clears playlist position) |

The current filename briefly flashes in the status bar on each cycle. If a file fails to load, the cycle skips to the next entry and shows the error in red.

---

## Running on Raspberry Pi 5

**Requirements:** Raspberry Pi OS Bookworm, Chromium installed (`chromium-browser`), Python 3.

### 1. Start the visualizer

```bash
chmod +x v2/kiosk.sh
./v2/kiosk.sh
```

This starts a local HTTP server on port 8080 and opens Chromium in kiosk mode with WebGL 2 hardware acceleration enabled. Press `Escape` to exit.

> **X11 instead of Wayland?** Edit `kiosk.sh` and change `--ozone-platform=wayland` to `--ozone-platform=x11`.

### 2. Start the hardware bridge (optional)

If you have physical knobs/sliders connected via MCP3008 ADC:

```bash
pip install websockets spidev gpiozero    # one-time
python3 pi/bridge.py
```

The bridge runs a WebSocket server on port 9001. The browser app connects automatically and reconnects if the bridge restarts. See `pi/HARDWARE_SETUP.md` for wiring; the knob → param mapping and button → action mapping live in the `CHANNELS` and `BUTTON_CONFIG` lists at the top of `pi/bridge.py`.

**No hardware?** Run `python3 pi/bridge.py --mock` — it skips SPI/GPIO and emits one test message so you can verify the WebSocket round-trip without a Pi attached.

### Autostart on boot

Use `pi/pi-start.sh` (starts both the HTTP server and the bridge) or, for kiosk mode, run them separately. For systemd, create a unit invoking:

```bash
cd /home/pi/crt-vizzie && ./v2/kiosk.sh &
python3 /home/pi/crt-vizzie/pi/bridge.py &
```

---

## Hardware controls (MCP3008)

The `pi/` directory contains a Python bridge that reads potentiometers and sliders via MCP3008 ADC(s) over SPI and pushes their values into the visualizer in real time. It also receives beat and frequency data from the browser to drive LEDs and reads pushbuttons that trigger browser actions.

- `pi/bridge.py` — single-file WebSocket bridge (ADC polling, LED PWM, button events)
- `pi/HARDWARE_SETUP.md` — wiring guide and `CHANNELS` / `BUTTON_CONFIG` reference
- `pi/pi-start.sh` — convenience launcher that brings up the HTTP server and the bridge together
