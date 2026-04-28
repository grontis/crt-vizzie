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
| `S` | Cycle scanline mode (OFF → PIXEL → CELL-GAP → SMOOTH) |
| `P` | Cycle phosphor color (green → amber → blue → red → white) |
| `F` | Toggle fullscreen (works during startup screen too) |
| `Escape` | Exit fullscreen |
| Drop audio file | Load and loop as audio source |

#### Scanline modes

| Mode | Description |
|---|---|
| OFF | No scanlines |
| PIXEL | Every other pixel row darkened (subtle texture) |
| CELL-GAP | Dark retrace band at the bottom of each character row (default) |
| SMOOTH | Sine falloff — bright at cell center, dim at top/bottom edges |

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
pip install websockets    # one-time
python3 pi/pi-bridge.py
```

The bridge runs a WebSocket server on port 9001. The browser app connects automatically and reconnects if the bridge restarts. See `pi/HARDWARE_SETUP.md` for wiring and `pi/hw-mapping.json` to map ADC channels to visual parameters.

**No hardware?** Use the desktop simulator instead:

```bash
python3 pi/pi-sim.py      # starts the simulator WebSocket server
# then open pi/sim-ui.html in a browser for drag sliders
```

See `pi/SIM.md` for details.

### Autostart on boot

Add to `/etc/rc.local` (before `exit 0`), or create a systemd unit:

```bash
cd /home/pi/crt-vizzie && ./v2/kiosk.sh &
python3 /home/pi/crt-vizzie/pi/pi-bridge.py &
```

---

## Hardware controls (MCP3008)

The `pi/` directory contains a Python bridge that reads potentiometers and sliders via two MCP3008 ADCs over SPI and pushes their values into the visualizer in real time. It also receives beat and frequency data from the browser to drive LEDs via GPIO.

- `pi/hw-mapping.json` — maps each ADC channel to a visual parameter with min/max range
- `pi/led_output.py` — stub for LED/GPIO output; fill in your `rpi_ws281x` / `RPi.GPIO` calls here
- `pi/HARDWARE_SETUP.md` — full wiring guide
