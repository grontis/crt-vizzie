# CRT ASCII Visualizer — Implementation Plan

A p5.js audio-reactive visualizer for a CRT TV, designed for live DJ performance in a gallery context.

**Aesthetic target:** late-90s hacker terminal meets early internet. Think the Hackers (1995) UI fever dream — impossible 3D geometry rendered in ASCII, green phosphor on pitch black, Netscape chrome, blinking cursors, and the quiet dread of a liminal hallway playing underneath it all.

---

## Concept

A fullscreen browser application that reads live audio from a DJ mixer, analyzes it in real time, and renders audio-reactive ASCII art to a CRT TV via a composite video output. The CRT's natural phosphor glow, scan lines, and warm interlacing act as a free post-processing layer on top of the visuals.

A **background layer** can load a still image or looping video (liminal spaces: empty malls, pool corridors, fluorescent-lit stairwells) that bleeds through the ASCII grid at a configurable opacity. The ASCII characters act as a halftone filter over the footage — reality, but scrambled.

---

## Technical Stack

| Layer | Tool | Why |
|---|---|---|
| Visual / canvas | p5.js | Purpose-built for creative coding, handles the draw loop, font rendering, and canvas sizing |
| Audio analysis | p5.sound (FFT) | Wraps the Web Audio API — provides spectrum, waveform, and named band energy out of the box |
| Audio input | Browser `getUserMedia` | Captures the audio interface (mixer booth out) as if it were a microphone |
| Background layer | HTML `<video>` / `<img>` behind canvas | Video/image element sits underneath the p5 canvas; canvas uses a transparent/blended background |
| Video output | HDMI → composite adapter | Routes the browser window to the CRT |
| Runtime | Chrome or Firefox, fullscreen | No build tools or install required — open `index.html` and go |

---

## File Structure

```
crt-visualizer/
├── index.html            — entry point, retro browser chrome UI, script tags
├── config.js             — all tunable constants (colors, grid size, speeds, overlay)
├── audio.js              — AudioManager class: live input + demo data synthesizer
├── sketch.js             — p5.js lifecycle (setup / draw), grid system, rendering
├── background.js         — BackgroundLayer class: video/image loader, luma sampling
├── ascii-art.js          — AsciiArtLibrary: pre-built frames for morphing mode
└── modes/
    ├── matrix.js         — digital rain with beat reactivity
    ├── spectrum.js        — FFT bar chart with floating peak hold
    ├── waveform.js        — time-domain waveform plot
    ├── vu.js              — multi-band VU meter
    ├── morph.js           — morphing ASCII art figures, audio-driven transitions
    ├── glitch.js          — frame buffer corruption, datamosh, signal decay
    ├── tunnel.js          — ASCII 3D tunnel/flythrough (Hackers city aesthetic)
    ├── life.js            — Conway's Game of Life seeded and perturbed by audio
    └── lissajous.js       — oscilloscope X/Y Lissajous figures
```

Each file has a single, clear responsibility. Adding a new visual mode means adding one file to `modes/` — nothing else needs to change.

---

## Core Architecture

### The character grid

The canvas is divided into a 2D grid of fixed-width character cells (sized from the actual rendered monospace font). Every frame, the grid is wiped to empty space, the active mode writes characters and brightness values into it, and the renderer draws each cell to the canvas.

```
grid[row][col] = { char: '█', brightness: 0.85 }
```

Two global helpers let mode files write into the grid without knowing anything about pixels:

- `setCell(col, row, char, brightness)` — write one character
- `setString(col, row, string, brightness)` — write a string horizontally

Brightness (0–1) maps onto a three-stop phosphor palette: **dim → mid → bright**. This gives every mode a warm, graduated glow rather than a binary on/off look.

### Background layer (`background.js`)

A `BackgroundLayer` class manages an HTML `<video>` or `<img>` element that sits behind the p5 canvas. The canvas's background is drawn with `background(0, 0, 0, BG_OPACITY)` — a translucent black — so the layer bleeds through as a ghost image.

Each frame, `BackgroundLayer.getLuma(col, row)` samples the pixel brightness under a given character cell. Modes can optionally use this value to modulate character brightness, making the ASCII halftone respond to the image content underneath it.

Controls:
- Drop a file onto the window to load a background (image or video)
- `B` key toggles background on/off
- `[` / `]` adjusts bleed opacity (0 = pure black, 1 = full background)
- Video loops automatically and plays muted

### The phosphor palette

Five preset phosphor colors, each with three brightness stops:

| Preset | Dim | Mid | Bright | Vibe |
|---|---|---|---|---|
| Green | `#00460f` | `#00b428` | `#00ff41` | classic terminal |
| Amber | `#552d00` | `#c87800` | `#ffb200` | warm broadcast |
| Blue | `#0f2855` | `#2d69c8` | `#50aaff` | cold digital |
| Red | `#3d0000` | `#880000` | `#ff2200` | danger / alert |
| White | `#222222` | `#aaaaaa` | `#f0f0f0` | monochrome paper |

Cycle through with the `P` key. The CGA palette of 16 colors is also available as a mode-level override for the Glitch and Life modes, accessed from `CONFIG.CGA_COLORS`.

### Scanlines

A thin semi-transparent horizontal line is drawn every 3 pixels over the entire canvas each frame. Combined with the CRT's real interlacing, this creates a layered scanline density that feels analog rather than digital.

---

## Retro UI Chrome

The control bar is styled to look like a degraded Netscape Navigator or Windows 95 terminal window — a piece of the era, not a clean modern overlay.

### Visual details
- **Container:** dark gray `#1a1a1a` background, 2px inset bevel border (`#555` outer, `#000` inner), `Courier New` / `VT323` font
- **Title bar:** Windows 95-style gradient from `#000080` to `#1084d0`, white text reading `VIZZÍE v1.0 [AUDIO REACTIVE]`, fake minimize/maximize/close buttons (decorative `─ □ ✕`)
- **Status bar:** bottom strip showing `FREQ: 441Hz | BPM: ~128 | MODE: MATRIX | PHO: GREEN | [DEMO]` — values update live
- **Buttons:** beveled square buttons with active/depressed state; text in ALL CAPS; hover glows the active phosphor color
- **Blinking cursor:** an `█` cursor blinks at 1 Hz in the status bar when in demo mode; stops when live audio is detected

### Boot sequence
On first load, before any audio or mode is active, a scrolling boot log animates line by line into the grid (typewriter speed, ~40ms per line):

```
VIZZÍE AUDIO TERMINAL v1.0
(c) 1997 CRTLAB INDUSTRIES
INITIALIZING FFT SUBSYSTEM............... OK
LOADING PHOSPHOR PALETTE................. OK
CALIBRATING SCANLINE DENSITY............. OK
CHECKING AUDIO DEVICE.................... WAITING
> CLICK TO ENABLE MICROPHONE ACCESS
```

When mic permission is granted, a final line prints `AUDIO DEVICE LOCKED IN` and the active mode takes over. If denied, `SWITCHING TO DEMO MODE` and synthetic audio begins.

---

## Audio Pipeline

```
Mixer (booth out)
    └── Audio interface (USB, line-level in)
            └── Browser getUserMedia
                    └── p5.FFT (1024 bins, 0.8 smoothing)
                            ├── getSpectrum()      → log-scaled band array, 0–1
                            ├── getWaveform()      → time-domain array, -1 to 1
                            ├── getBands()         → named energy: sub/bass/lowMid/mid/highMid/treble
                            └── getBeatIntensity() → rolling bass average comparison, 0–1
```

**Demo mode:** if microphone access is denied or not yet granted, `AudioManager` synthesizes animated fake audio data (bass pulses, harmonic mid content, noise floor). Every mode renders identically whether the source is live or synthetic — useful for developing visuals without an audio setup nearby.

**Beat detection:** each frame, current bass energy is compared to a rolling 45-frame (~1 second) history. When current energy significantly exceeds the average, a beat is flagged. This value drives column speed in the matrix mode and can be used for any reactive behavior in future modes.

---

## Visual Modes

### Matrix rain (`modes/matrix.js`)

Each column is an independent raindrop: a head character falling at a randomized speed, trailing a fading sequence of characters behind it. Head characters render at full brightness (1.0), the trail steps down through brightness levels (0.7 → 0.35 → 0.12) before disappearing.

Character pool: Katakana block + ASCII symbols + digits. On hard beats, a column briefly switches to a random chunk of recognizable code (`if (`, `0x3F`, `ERR:`) before returning to the rain — a nod to the movie aesthetic.

Beat reactivity:
- Bass energy multiplies all column fall speeds in real time
- Head characters scramble to a new random character on hard beats (glitch effect)
- A single-row bass energy bar fills the bottom of the screen, pulsing with the kick

### Frequency spectrum (`modes/spectrum.js`)

A bar chart of frequency content drawn with Unicode block characters (`▁▂▃▄▅▆▇█`). Frequency bins are mapped logarithmically so bass frequencies aren't crammed into the first two columns. A floating peak dot holds for ~30 frames then decays at a configurable rate (`CONFIG.PEAK_DECAY`).

The bar chart is framed with box-drawing characters and labeled with a rough frequency axis (`SUB / BASS / LO-MID / MID / HI-MID / PRESENCE / AIR`).

### Waveform (`modes/waveform.js`)

Time-domain audio signal plotted across all columns. Each column's amplitude maps to a row position; adjacent samples are connected with vertical fill characters (`▓`) so the wave reads as a continuous curve rather than a scatter of points. Brightness scales with amplitude — loud transients glow hotter.

### VU meter (`modes/vu.js`)

Horizontal bar per frequency band (sub, bass, low-mid, mid, high-mid, treble) plus a master level row. Bars use three visual zones: full `█` for the normal range, `▓` for the yellow zone (~72–90% of bar width), and `!` for the red zone (>90%). A peak needle `│` holds and decays independently per band. dB values are calculated and displayed numerically at the right of each bar.

---

### Morphing ASCII art (`modes/morph.js`)

A library of pre-built multi-line ASCII figures (`ascii-art.js`) — skull, face, eye, geometric diamond, cityscape silhouette, server rack, globe. Frames are stored as arrays of strings.

Each frame in the library can be **tweened** to the next by interpolating character cells: cells that are shared between frames stay fixed; cells that differ cycle through a "glitch alphabet" (`░▒▓█▄▀▌▐`) before resolving to the target character.

Audio reactivity:
- Beat triggers a morph transition to the next figure in the queue
- High bass energy accelerates the tween speed
- High treble energy injects random noise characters into stable cells (shimmer)
- Background luma sampling (if a background is loaded) can bias which figure is selected — dark zones pull toward skulls/eyes, bright zones toward geometric shapes

The figures are defined in `ascii-art.js` as plain JS arrays of strings — easy to add new ones without touching any rendering code.

---

### Glitch / signal decay (`modes/glitch.js`)

Maintains a persistent character buffer (previous frame). Each frame:
1. Copy the buffer to the grid
2. Apply a set of randomized "decay" operations: horizontal smear (shift a row left/right by 1–3 cells), character substitution (swap a character for a CGA-palette block), vertical tear (duplicate a horizontal band), dropout (blank a row entirely)
3. The decay rate and operation weights are modulated by audio energy — quiet passages barely glitch, loud peaks tear the image apart
4. Every N frames (configurable), seed the buffer with a fresh "signal" — a scrolling block of hex dump text, a corrupted spectrum bar, or a still from the morph library

This gives the mode a self-consuming quality: it feeds on its own previous output, decaying it over time, seeding new content through audio. Combined with a liminal video background bleeding through, it reads as found footage from a collapsing network.

CGA color mode active in this mode: characters are drawn in one of the 16 CGA colors based on their position and the audio band energies, breaking the single-phosphor look deliberately.

---

### ASCII tunnel (`modes/tunnel.js`)

A faux-3D perspective tunnel rendered in ASCII — the Hackers "city flythrough" aesthetic translated to characters. Concentric rings of box-drawing and block characters (`╬`, `█`, `▓`, `░`, `+`, `·`) recede into a vanishing point at the center of the screen.

Each frame, the rings scroll toward the viewer at a speed proportional to bass energy. On beats, a "warp" effect compresses the rings suddenly and releases — the visual equivalent of a kick on the dancefloor.

The tunnel walls are textured with rotating character sets: one ring might be Katakana, the next a hex string, the next a fragment of ASCII art. High treble energy increases texture rotation speed.

---

### Conway's Game of Life (`modes/life.js`)

Standard Game of Life rules on the character grid. Dead cells render as ` ` (space), live cells render as `█` at a brightness proportional to how many neighbors they have (more neighbors = brighter = more connected).

Audio seeding:
- On load, the grid is randomly seeded at a density proportional to current audio energy
- On each beat, a random 5×5 block of cells is toggled — injecting chaos into stable patterns
- High bass energy increases the probability of random cell resurrection (raises the noise floor of the simulation)
- The character used for live cells shifts with the active phosphor: Green = `█`, Amber = `▓`, Blue = `▒`

The result is a system that tends toward equilibrium in silence, is constantly disrupted by the music, and never fully settles.

---

### Lissajous / oscilloscope (`modes/lissajous.js`)

Classic X/Y oscilloscope figure: the left audio channel drives horizontal position, the right channel drives vertical position. The resulting path is plotted as a trail of `·` characters with brightness fading along the trail length.

When only a mono source is available, a fixed 90° phase-shifted version of the signal is used for the second axis, producing a clean circle/ellipse that deforms with transients.

The phosphor glow on the CRT makes this mode look like actual analog scope footage — no post-processing needed.

---

## Configuration (`config.js`)

All tunable parameters live in one object. Nothing needs to be touched in mode files or sketch.js to change the look:

```js
// Grid
CONFIG.FONT_SIZE          // character cell size — larger = fewer columns/rows
CONFIG.FONT_FACE          // 'Courier New' | 'VT323' | 'Share Tech Mono'

// Modes
CONFIG.DEFAULT_MODE       // which mode starts active
CONFIG.MODE_ORDER         // array of mode names for keyboard cycling

// Phosphor
CONFIG.DEFAULT_PHOSPHOR   // starting color preset key
CONFIG.PHOSPHORS          // { green: {dim, mid, bright}, amber: {...}, ... }
CONFIG.CGA_COLORS         // array of 16 CGA hex values for glitch/life modes

// Audio
CONFIG.FFT_BINS           // 512 | 1024 | 2048
CONFIG.FFT_SMOOTHING      // 0–1, higher = more sluggish
CONFIG.BEAT_HISTORY       // frames to average for beat detection (~45)
CONFIG.BEAT_THRESHOLD     // multiplier above average to flag a beat (1.3–1.8)

// Spectrum
CONFIG.PEAK_DECAY         // how quickly spectrum peaks fall (0.005–0.03)

// Matrix
CONFIG.MATRIX_BASE_SPEED  // base fall speed for matrix columns
CONFIG.KATAKANA           // character pool for matrix rain

// Morph
CONFIG.MORPH_SPEED        // tween frames per transition (lower = faster)
CONFIG.MORPH_NOISE_CHARS  // glitch alphabet used during transitions

// Glitch
CONFIG.GLITCH_SEED_INTERVAL // frames between fresh content seeds
CONFIG.GLITCH_MAX_TEAR    // max row offset for vertical tear effect

// Background
CONFIG.BG_OPACITY         // canvas background alpha (lower = more bleed)
CONFIG.BG_DEFAULT_OPACITY // starting bleed level (0.0–1.0)
CONFIG.BG_LUMA_INFLUENCE  // how much background luma modulates cell brightness (0–1)

// Scanlines
CONFIG.SCANLINE_SPACING   // pixels between scanline overlays (default 3)
CONFIG.SCANLINE_ALPHA     // opacity of scanline overlay (0.05–0.2)

// UI
CONFIG.BOOT_SEQUENCE      // array of boot log strings
CONFIG.SHOW_STATUS_BAR    // bool — toggle status bar
CONFIG.SHOW_TITLE_BAR     // bool — toggle Windows-95 title chrome
```

---

## Keyboard Map

| Key | Action |
|---|---|
| `1`–`9` | Switch to mode by index |
| `Tab` | Cycle to next mode |
| `P` | Cycle phosphor preset |
| `B` | Toggle background layer on/off |
| `[` / `]` | Decrease / increase background bleed opacity |
| `S` | Toggle scanline overlay |
| `F` | Toggle fullscreen |
| `D` | Toggle demo mode (synthetic audio) |
| `U` | Toggle UI chrome (title bar + status bar) |
| `Drop file` | Load image or video as background |

---

## Extending the Project

### Adding a new visual mode

1. Create `modes/yourmode.js` with a class that has an `update(grid, audio, bg)` method
2. Inside `update()`, call `setCell()` and `setString()` to write into the grid
3. Optionally call `bg.getLuma(col, row)` to sample background brightness per cell
4. Add a `<script src="modes/yourmode.js">` tag in `index.html`
5. Instantiate it in `sketch.js` alongside the other modes
6. Add a button to the control bar in `index.html` and a key binding entry in `config.js`

The mode gets access to the full `AudioManager` API (`getSpectrum`, `getWaveform`, `getBands`, `getBeatIntensity`) — no audio code lives inside mode files.

### Adding ASCII art figures to the morph library

Each figure in `ascii-art.js` is an array of equal-length strings (one string per row). Add a new entry to the `AsciiArtLibrary.figures` array — the morph mode will automatically include it in its rotation. Keep all figures to the same bounding box size (`CONFIG.MORPH_WIDTH × CONFIG.MORPH_HEIGHT`) so the tween math stays simple.

---

## Background + Liminal Spaces Setup

The background layer is designed for liminal spaces media: empty architecture, fluorescent corridors, deserted parking structures, analog TV static. These images have specific qualities that interact well with the ASCII overlay:

- **Low contrast areas** — the ASCII halftone fills them with character noise; the eye reads texture without detail
- **Strong light sources** — bright windows, overhead fixtures — bloom through the ASCII grid as clusters of full-brightness characters
- **Repeating geometry** — tile floors, drop ceilings, corridor perspective — reinforce the tunnel/grid geometry of the ASCII layer

**Recommended workflow:**
1. Collect 3–5 looping video clips (15–60s each) from liminal space sources
2. Trim and encode to H.264 MP4 at 640×480 or 720×480 (matching CRT native resolution)
3. Drop them onto the browser window during performance to swap backgrounds live
4. Use `[` / `]` to dial the bleed level — start around 0.3, push higher during breakdowns

---

## CRT Output Setup

1. Connect your laptop's HDMI output to a **HDMI-to-composite adapter** (look for ones marketed for retro gaming — they handle interlacing better than generic converters)
2. Run a composite RCA cable from the adapter to the CRT's video input
3. Open `index.html` in Chrome, press `F` to go fullscreen
4. In Chrome display settings, set the CRT as a secondary display and drag the browser window to it, then fullscreen again

The CRT's native resolution (~640×480 at 480i) means bold, high-contrast characters read better than fine detail. Amber phosphor (`CONFIG.DEFAULT_PHOSPHOR = 'amber'`) tends to read warmer and more "art object" in a gallery space compared to green.

---

## Hardware Notes

**Laptop path** (simplest): laptop runs rekordbox + the visualizer simultaneously. Use your audio interface's booth out as the audio source. The browser treats it as a microphone input — no extra routing software needed.

**Raspberry Pi path** (cleaner for a permanent install): Pi receives audio from the mixer via a USB audio interface, runs the visualizer in Chromium kiosk mode, and outputs composite video directly via the Pi's 3.5mm AV jack (available on Pi 3B/4 — no adapter needed). Boot command: `chromium-browser --kiosk --disable-infobars file:///home/pi/crt-visualizer/index.html`.

---

## Aesthetic Reference

| Source | What to steal |
|---|---|
| *Hackers* (1995) | Impossible 3D geometry in ASCII, green-on-black, the idea that code is spatial |
| *The Matrix* (1999) | Digital rain character scramble, beat-sync column speeds |
| Windows 95 / NT 4.0 | Beveled UI chrome, modal dialog aesthetics, system font ALL CAPS |
| Netscape Navigator 2.0 | Grey toolbar buttons, status bar, URL-as-status-text |
| Zachtronics games (*SHENZHEN I/O*, *TIS-100*) | Monochrome terminal grids, hex dumps as texture |
| Liminal Spaces (subreddit / Aesthetic) | Empty architecture as emotional register — the uncanny behind the glitch |
| Analog TV static / VHS tracking error | Signal decay as aesthetic event, not as failure |
| Demo scene (PC 1993–1999) | Every pixel earned; the constraint is the art |
