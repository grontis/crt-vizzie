# VIZZÍE

Audio-reactive ASCII visualizer for CRT TV. Built with p5.js — no install required.

---

## Running locally

Browsers block audio access when a page is opened from disk (`file:///`). Serve over HTTP:

```bash
npx serve .                    # Node.js (recommended)
python -m http.server 8080     # Python 3
py -m http.server 8080         # Python on Windows if `python` isn't recognised
```

Then open **http://localhost:8080** in any browser.

---

## Audio sources

On load, click the canvas to begin. The status bar shows the active source at all times.

| Source | Status bar | How to activate |
|---|---|---|
| Audio file | `[AUDIO FILE]` | Press `A` or drag an MP3/OGG/WAV onto the window |
| Microphone / audio interface | `[MIC INPUT]` | Press `D` — browser will ask for mic permission |
| System audio (Chrome only) | `[SYS AUDIO]` | Press `D` — select Entire Screen, check "Share system audio" |
| Demo synthesizer | `[DEMO]` | Default — always available, no hardware needed |

**Audio file is the recommended way to test during development.** Drop any MP3/OGG/WAV onto the browser window and it will loop and drive the visualizer immediately.

**For microphone or audio interface**: press `D`, grant permission. Any device that appears as a mic input in your OS works — including USB audio interfaces. The visualizer reacts to whatever is plugged in.

**For system audio on Firefox**: Firefox does not support system audio loopback. Press `D` to use mic input, or use a virtual audio cable ([VB-Audio](https://vb-audio.com/Cable/)) to route playback to a virtual mic device.

---

## Controls

| Key | Action |
|---|---|
| `1` – `9` | Switch to mode by number |
| `Tab` | Cycle to next mode |
| `A` | Load audio file (MP3/OGG/WAV) |
| `D` | Toggle mic/live audio (or back to demo) |
| `P` | Cycle phosphor color (green → amber → blue → red → white) |
| `L` | Load background image or video |
| `B` | Toggle background layer on/off |
| `[` / `]` | Decrease / increase background opacity |
| `S` | Toggle scanline overlay |
| `F` | Toggle fullscreen |
| `U` | Toggle UI chrome (title bar + button bar) |
| Drop audio file | Load and loop as audio source |
| Drop image/video | Load as background layer |

---

## Visual modes

| # | Mode | Description |
|---|---|---|
| 1 | Matrix | Digital rain — columns fall faster on bass hits |
| 2 | Spectrum | FFT bar chart with log frequency scale and peak hold |
| 3 | Waveform | Time-domain audio signal across the full width |
| 4 | VU Meter | Per-band level bars with peak needles and dB readout |
| 5 | Morph | ASCII figures (skull, globe, cityscape…) tweening on beats |
| 6 | Glitch | Self-corrupting frame buffer — tears apart on loud signals |
| 7 | Tunnel | Perspective ASCII tunnel — warp pulse on kick |
| 8 | Life | Conway's Game of Life seeded and disrupted by audio |
| 9 | Lissajous | X/Y oscilloscope figure from the audio waveform |

---

## Background layer (liminal spaces)

Load any image (JPG, PNG) or video (MP4, WebM) as a background — the ASCII grid acts as a halftone filter over the footage.

- Press `L` or click **LOAD BG**, or drag-and-drop an image/video onto the window
- `B` toggles the layer on/off
- `[` / `]` dials the opacity — start around 30–50%, push higher during breakdowns
- Video loops automatically and plays muted
- Drop a new file to swap live

---

## Font (offline / Raspberry Pi)

VT323 is loaded from `fonts/VT323-Regular.woff2` first (local, no internet needed). If that file is not present, it falls back to the Google Fonts CDN.

**To set up offline:**
1. Download VT323 from https://fonts.google.com/specimen/VT323 (click "Download family")
2. Extract `VT323-Regular.ttf` from the zip
3. Convert to woff2 (e.g. https://cloudconvert.com/ttf-to-woff2) **or** just copy the `.ttf` as-is — the `@font-face` in `index.html` includes a `.ttf` fallback
4. Place the file in the `fonts/` directory

---

## Raspberry Pi (permanent install)

The app runs well on Pi 4 in Chromium kiosk mode — this is a true standalone install (no window chrome, autostart on boot, no internet required if fonts are local).

**Audio input**: connect a USB audio interface. It will appear as a mic input. Press `D` in the app to grant permission and start reacting to it.

```bash
# Install and serve locally
npm install -g serve      # or use Python
serve /home/pi/crt-vizzie

# Autostart Chromium kiosk on boot (add to /etc/rc.local or a systemd unit)
chromium-browser \
  --kiosk \
  --disable-infobars \
  --disable-session-crashed-bubble \
  --noerrdialogs \
  http://localhost:3000
```

The Pi 3B/4's 3.5mm AV jack outputs composite directly — no HDMI adapter needed. Amber phosphor (`P` key) tends to read warmer through composite in a gallery space.

**Want a fully native app (no browser at all)?** Electron wraps the same web app into a standalone executable. It adds ~200 MB but removes the need for a separate server and browser process:

```bash
npm init -y
npm install electron
# then run with: npx electron .  (after adding a main.js that opens index.html)
```

For most Pi installs Chromium kiosk is simpler and works fine.

---

## CRT output

1. Connect HDMI to an **HDMI-to-composite adapter** (retro gaming adapters handle interlacing better than generic ones)
2. Run composite RCA to the CRT's video input
3. Set the CRT as a secondary display in OS display settings
4. Move the browser window to the CRT and press `F` to fullscreen

---

## File structure

```
crt-vizzie/
├── index.html        — entry point and UI chrome
├── config.js         — all tunable constants
├── audio.js          — AudioManager (file / mic / system / demo sources)
├── background.js     — BackgroundLayer (video/image bleed-through)
├── ascii-art.js      — ASCII figure library for morph mode
├── sketch.js         — p5.js core, grid, render loop, keyboard handling
├── fonts/            — place VT323-Regular.woff2 here for offline use
└── modes/
    ├── matrix.js
    ├── spectrum.js
    ├── waveform.js
    ├── vu.js
    ├── morph.js
    ├── glitch.js
    ├── tunnel.js
    ├── life.js
    └── lissajous.js
```

To add a new visual mode: create `modes/yourmode.js` with an `update(grid, cols, rows, audio, bg)` method, add a `<script>` tag in `index.html`, and instantiate it in `sketch.js`.
