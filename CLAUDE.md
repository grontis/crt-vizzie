# CLAUDE.md — crt-vizzie architecture guide

This file is the entry point for any AI agent or contributor starting a new session on this repo.
Read it before touching any code.

---

## Repository layout

```
crt-vizzie/
  v2/              active application (WebGL 2 ASCII visualizer)
  pi/              hardware bridge for Raspberry Pi (bridge.py, HARDWARE_SETUP.md, pi-start.sh)
  README.md        user-facing overview
```

There is no v1 directory on this branch. There is no `modes/` directory. There is no p5.js.

---

## v2 application — file layout and load order

Files inside `v2/` must be loaded in this order (enforced by `<script>` tags in `index.html`):

| # | File | Responsibility |
|---|------|----------------|
| 1 | `config.js` | Declares `V2_CONFIG`, `V2_PARAMS`, `V2_PARAM_RANGES` on `window` |
| 2 | `audio.js` | `V2AudioManager` — Web Audio pipeline |
| 3 | `ascii-art.js` | `AsciiArtLibrary` — static figure data |
| 4 | `renderer.js` | `V2Renderer` — WebGL 2, glyph atlas, single draw call |
| 5 | `fusion.js` | `V2FusionMode` — four-layer cell grid composer |
| 6 | `background.js` | `V2BackgroundLayer` — CSS background image/video layer |
| 7 | `bg-folder.js` | `V2BgFolder` — File System Access API + IndexedDB-persisted directory handle for streaming local bg media |
| 8 | `bg-fx.js` | `BgFxManager` — audio-reactive CSS filter/transform on bg layer |
| 9 | `bg-fx-panel.js` | `BgFxPanel` — DOM panel for live-tuning bg FX params |
| 10 | `startup.js` | `V2StartupScreen` — terminal boot screen, audio source selection |
| 11 | `hardware-bridge.js` | WebSocket listener, maps hardware param keys to `V2_PARAMS` |
| 12 | `sketch.js` | Main loop, init, input handlers, status bar |

Supporting assets: `fonts/`, `shaders/` (reference copies of GLSL).

`v2/bg-media/` — gitignored directory the user typically points the bg-folder picker at. Only `.gitkeep` is tracked; media files live there but are not committed. There is no manifest file — the file list is enumerated live via the FS Access API directory handle.

---

## Key global objects (all in `v2/config.js`)

**`window.V2_CONFIG`** — immutable runtime constants. Set once at startup; never mutated.
Includes font settings, canvas dimensions, atlas layout (`ATLAS_COLS`), audio analysis
parameters, phosphor preset definitions, and the CGA 16-color palette.

**`window.V2_PARAMS`** — live-tunable visual parameters. Written each frame by `fusion.js`
for internal state (e.g. `_chromaBeatCurrent`). Also mutated by `hardware-bridge.js` in
response to incoming WebSocket messages, and by key handlers in `sketch.js` in response
to keyboard input. This is the single source of truth for all tunable visual state.

**`window.V2_PARAM_RANGES`** — min/max bounds for every numeric param in `V2_PARAMS`.
Used by `hardware-bridge.js` to clamp incoming hardware values before writing them.

Do not add new tunable parameters to `V2_PARAMS` without also adding a corresponding entry
in `V2_PARAM_RANGES`.

---

## Module responsibilities

### `renderer.js` — V2Renderer

WebGL 2 renderer. Builds a glyph atlas (a single texture containing every character in the
charset, rendered at startup with the configured font). On each frame, accepts three typed
arrays from `fusion.js` (char index, brightness, CGA color index) and uploads them as a
pair of data textures. Issues a single `gl.drawArrays()` call over a full-screen quad.

The fragment shader looks up each cell's character from the atlas, applies chromatic
aberration (per-channel horizontal offsets), maps brightness to a three-stop phosphor color
or a CGA palette entry, and applies the scanline effect.

Shader precision: `highp float` in both vertex and fragment stages.

### `fusion.js` — V2FusionMode

Maintains four composited layers, all written into flat typed arrays each frame:

- **figure** — ascii-art stamp that fades over time and re-seeds periodically
- **rain** — per-column falling character streams (matrix rain style), audio-reactive speed
- **wave** — sine-field interference pattern using katakana characters
- **glitch** — beat-triggered scatter, pulse waves, hex dump seeds

Output: `Uint16Array charIdx`, `Uint16Array bright16`, `Uint8Array cgaIdx` — passed directly
to `renderer.upload()` each frame. No heap allocations during steady-state rendering.

Character-to-atlas-index lookup is via `_charMap` (a `Map` built once from the charset array).
Missing characters emit a `console.warn` once per unique missing char.

### `audio.js` — V2AudioManager

Manages the Web Audio API graph. No p5.sound, no external dependencies. Four source modes:

- `idle` — all data zeroed, no graph active
- `demo` — procedural CPU synthesizer + oscillator graph; self-sufficient (calls `resume()`
  internally if the AudioContext has not been created yet)
- `file` — `<audio>` element via `MediaElementSourceNode`; loaded via blob URL
- `live` — microphone via `MediaStreamSourceNode` and `getUserMedia`

`AudioContext` is created lazily on the first call to `resume()`, which must come from a
user-gesture handler. On kiosk Pi deployments, `--autoplay-policy=no-user-gesture-required`
removes this requirement.

### `background.js` — V2BackgroundLayer

Manages a CSS `background-image` on the fixed `#v2-bg-image` div. Handles loading from a
local file (`loadFromFile(file)`). Provides `resample()`
which samples the current background into a luma array for use by `fusion.js`
(background-influenced cell brightness).

The `_lumaData` Float32Array is pre-allocated by `resample()` and reused every frame in
`_drawSource()` to avoid per-frame GC churn (matters on Pi).

### `bg-folder.js` — V2BgFolder

Owns the playlist of background media files. Uses the **File System Access API**
(`window.showDirectoryPicker`) to acquire a `FileSystemDirectoryHandle` for a user-chosen
folder; the handle is persisted in IndexedDB (`crt-vizzie-bg`/`handles`/`dirHandle`) so
subsequent boots can restore it silently.

Three permission entry points:

- `tryRestoreSilent()` — reads handle from IDB, calls `queryPermission()`. Returns true
  only if permission is still `'granted'`. Never prompts. Sketch.js calls this in `init()`.
- `requestPermissionAndScan()` — asks the browser to upgrade a stored handle's permission
  back to `'granted'`. Must be invoked from a user gesture. Sketch.js calls this right
  after `applyChoice()` if `bgFolder.hasPendingHandle` is true (i.e. the handle exists
  but lapsed to `'prompt'`).
- `pickFolder()` — invokes `showDirectoryPicker()`. Used by the M key binding.

Each `getFile(idx)` returns a fresh `File` reference for the entry. The video element
streams from disk via the OS file handle — bytes are read on demand, never buffered into
memory. This is the same code path the L key uses, just over a whole directory.

Supported extensions: `jpg`, `jpeg`, `png`, `gif`, `webp`, `mp4`, `webm`, `mov`, `mkv`, `m4v`.

Browser support: Chromium-based browsers only. Firefox does not implement
`showDirectoryPicker` at this time. Use the L key to load individual files in unsupported
browsers.

### `bg-fx.js` — BgFxManager

Applies audio-reactive CSS `filter` and `transform` to `#v2-bg-image` each frame. Envelopes
for beat flash, invert flash, and scale pulse decay multiplicatively between frames. The GPU
compositor handles these properties — no pixel readback occurs at any point.

### `bg-fx-panel.js` — BgFxPanel

A DOM panel (`#bg-fx-panel`) constructed entirely in JavaScript. Provides sliders for all
`bgFx*` and `bgOpacity` params. Toggle with the Tab key. `syncState()` can be called by
external code to push updated `V2_PARAMS` values back into the slider controls.

### `startup.js` — V2StartupScreen

Terminal-style boot animation displayed before the main loop starts. Blocks `init()` until
the user selects an audio source (demo / file / live) or the 8-second kiosk timer fires.

### `hardware-bridge.js`

Opens a WebSocket connection to a companion server running on the Pi hardware. Receives
JSON messages mapping hardware knob/button IDs to `V2_PARAMS` keys, clamps values using
`V2_PARAM_RANGES`, and writes them into `V2_PARAMS`. The main loop in `sketch.js` picks up
changes automatically on the next frame.

### `sketch.js`

Top-level IIFE. Orchestrates startup (font load, atlas build, audio init, background load,
startup screen, input wiring) and runs the `requestAnimationFrame` loop gated at
`V2_CONFIG.TARGET_FPS` (default 30). Owns the keyboard input handlers and the status bar.

---

## Key bindings

| Key | Action |
|-----|--------|
| D | Toggle demo mode on/off |
| A | Open audio file picker |
| B | Toggle background image visibility |
| X | Toggle audio-reactive bg FX (filter/transform) |
| V | Toggle bgAscii layer (ASCII-art rendering of background luma) |
| S | Cycle scanline mode: OFF → PIXEL → CELL-GAP → SMOOTH → OFF |
| P | Cycle phosphor preset (green → amber → blue → red → white → ...) |
| L | Load a single background image or video from file (one-off, off-playlist) |
| M | Pick / re-pick the bg-media folder (FS Access API directory picker) |
| ArrowLeft / ArrowRight | Cycle backward/forward through the bg-folder playlist (wrap-around) |
| F | Toggle fullscreen |
| Tab | Toggle bg FX panel (when panel is open, Tab moves focus between controls) |
| Esc | Close bg FX panel if open; exit fullscreen otherwise |
| ` (backtick) | Show glyph atlas debug overlay (requires `#debug-atlas` in URL hash) |
| ~ (tilde) | Toggle FPS / frame-time performance overlay |

---

## Phosphor presets and scanline modes

Phosphor presets are defined in `V2_CONFIG.PHOSPHORS` and ordered by `V2_CONFIG.PHOSPHOR_ORDER`.
Each preset defines three `[r,g,b]` stops (`dim`, `mid`, `bright`) that the fragment shader
blends between based on per-cell brightness.

Scanline modes (controlled by `V2_PARAMS.scanlineMode`, valid range 0–3):

| Value | Name | Effect |
|-------|------|--------|
| 0 | OFF | No scanline darkening |
| 1 | PIXEL | Every other display pixel row darkened |
| 2 | CELL-GAP | Bottom ~20% of each character cell darkened |
| 3 | SMOOTH | Sine-based phosphor beam falloff within each cell row |

---

## Code comments & documentation conventions

Keep the codebase **feature-focused**, not timeline- or session-focused. Comments should explain
what the code does and why, as if it had always existed.

- **No development-phase or milestone framing** in code or comments — no "Phase 1/2…", "M0/M1…",
  "spike", "MVP", "deferred to Phase N", or "step 3 of the port". Describe the behavior, not the
  order it was built in.
- **No session-specific references** — no "FIX 1/2", "the bug where…", dates ("confirmed
  2026-06-28"), reviewer initials, or "interim" markers. State the invariant or rationale plainly.
- **TODOs, roadmaps, and known limitations live in docs, not inline.** Do not leave `TODO`/`FIXME`
  markers in source; record deferred work in the relevant doc (e.g. native/ARCHITECTURE.md's
  "Known limitations & future work"). An inline comment may *point* to that doc, but the item
  itself belongs in the doc.
- **Provenance references are fine** when they aid maintenance — e.g. "mirrors `sketch.js`" or
  "verbatim from `V2_CONFIG`", since the `v2/` web app is the behavioral source of truth.
- Match the surrounding comment density and style; don't narrate obvious code.

## Common pitfalls for agents and contributors

- There is no p5.js. Do not add it. Do not reference `p`, `p5`, `sketch`, `draw()`, `setup()`.
- There is no `modes/` directory.
- There is no `FUSION_PARAMS` or `fusion-params.js`. Params live in `window.V2_PARAMS` (config.js).
- There is no `setCell()` global. Cell data is written directly into typed arrays in `fusion.js`.
- `V2_CONFIG` is immutable. Do not assign to its properties at runtime.
- `V2_PARAMS` is the only object you should mutate to change visual behavior at runtime.
- The charset (glyph atlas) is built once at startup from `buildCharset()` in `sketch.js`.
  Any Unicode character not in the charset will silently render as a blank cell. A dev-mode
  warning is emitted at startup for any ascii-art figure characters absent from the charset.
- There is no `manifest.json`, no `gen-manifest.py`, and no `BG_MEDIA_FOLDER` config key.
  The bg playlist comes from a `FileSystemDirectoryHandle` via `bg-folder.js`. Do not
  reintroduce a manifest fetch — large/4K media played via HTTP without Range support
  thrashes the dev server and stutters audio/FPS, which is exactly why the FS Access
  API path replaced it.
- The `pi/bridge.py` knob/button → V2_PARAMS mapping lives in the `CHANNELS` and
  `BUTTON_CONFIG` lists at the top of that file. There is no `hw-mapping.json` and
  no `FUSION_PARAM_RANGES` — use `V2_PARAM_RANGES` from `v2/config.js`.

---

## Dev workflow

```sh
cd v2
python3 -m http.server 8080
```

Open `http://localhost:8080` in Chrome or Chromium.

There is no build step, no bundler, no `package.json`, no test runner. All files are plain
static JS and HTML served directly.

To inspect the glyph atlas, open the page with the URL hash `#debug-atlas`, then run
`renderer.debugAtlas()` in the browser DevTools console. A click-to-dismiss atlas image
will appear in the top-left corner.
