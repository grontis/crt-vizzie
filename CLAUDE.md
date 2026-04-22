# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Running locally

Browsers block audio access from `file:///`. Always serve over HTTP:

```bash
npx serve .
# or
python -m http.server 8080   # then open http://localhost:8080
```

No build step. No dependencies to install. All libraries loaded from CDN (`p5.js`, `p5.sound`).

## Architecture

This is a vanilla JS app — no bundler, no framework. Script load order in `index.html` is critical:

```
config.js → audio.js → background.js → ascii-art.js
  → fusion-params.js → background-fx.js
  → modes/*.js → modes/fusion.js
  → fusion-panel.js → fusion-automation.js
  → vj-sync.js → sketch.js (always last)
```

**`config.js`** — single `CONFIG` object. All tuneable constants live here. No logic.

**`audio.js` — `AudioManager`** — owns all audio state. Three sources: `'idle'` (zeroed data), `'demo'` (procedural synthesizer, no hardware), `'file'` (p5.SoundFile looping a loaded file). Exposes `getSpectrum()`, `getWaveform()`, `getBands()`, `beatActive`, `beatIntensity`. Called by `sketch.js` each frame via `audioManager.update()`.

**`sketch.js`** — p5 instance mode entry point. Owns the character grid (`grid[row][col] = { char, brightness }`), render loop, keyboard handling, and idle typewriter animation. Exposes `window.setCell` and `window.setString` so mode files can write to the grid directly. All UI control functions (`toggleDemo`, `cyclePhosphor`, etc.) are assigned to `window.*` in `p.setup`.

**`background.js` — `BackgroundLayer`** — manages an `<img>`/`<video>` DOM element and a hidden sampling canvas. Downsamples the media to grid resolution each frame so modes can call `bg.getLuma(col, row)` to bias rendering on background content. Exposes `get mediaElement()` and `get isVideo()` for use by `BackgroundFX`.

**`background-fx.js` — `BackgroundFX`** — pixel-pipeline FX canvas layered between the raw media element and the p5 canvas (z-index 1). Five audio-reactive effects: posterize → warp → scanline corruption → chromatic aberration → beat flash. **Only active in Fusion mode (index 9)** — `sketch.js` calls `backgroundFX.update()` when mode is 9, `backgroundFX.hide()` otherwise. Uses plain Canvas 2D API only — no p5 globals. All params read from `FUSION_PARAMS.bgFx`.

**`modes/*.js`** — each mode is a class with:
- `constructor(config)` — store reference, init state
- `reset()` — called on grid resize or mode activation
- `update(grid, cols, rows, audio, bg)` — called each frame; writes to grid via global `setCell(c, r, char, brightness)` and `setString(c, r, str, brightness)`

Modes never draw to the p5 canvas directly — they only write characters and brightness values to the grid. `sketch.js` renders the grid each frame using phosphor color mapping.

**`modes/fusion.js` — `FusionMode`** — the production performance mode (index 9, key `[0]`). Four composited layers: FIGURE (ASCII art figures that decay and reseed), RAIN (matrix-style falling columns that interact with the figure), GLITCH (beat-triggered corruption bursts), BG (kick-driven opacity pulse + treble stutter + luma sampling). All tuning reads from `window.FUSION_PARAMS` (not static constants). Each layer has an enable toggle. Rendering order: figure → rain → burst.

**`fusion-params.js`** — `window.FUSION_PARAMS` (live param store, plain object) and `window.FUSION_PARAM_RANGES` (min/max bounds for every driftable numeric param). Both are flat for the main layer params, with a nested `bgFx` sub-object for background FX params. This is the source of truth for all Fusion mode tuning — never read `FusionMode.STATIC_*` constants.

**`fusion-panel.js`** — self-contained DOM panel (`#fusion-panel`) for live parameter editing. Opened/closed with Tab when Fusion mode is active. Exposes `window.toggleFusionPanel()`, `window.hideFusionPanel()`, and `window.syncFusionPanelState()`. `syncFusionPanelState()` updates all slider `.value` DOM properties and toggle button states — must be called after any automated param change. The document-level Tab listener calls `e.preventDefault()` only (to stop browser focus cycling) — `sketch.js` owns the actual toggle call.

**`fusion-automation.js` — `FusionAutomation`** — VJ automation for Fusion mode. Three sub-features: (1) 4-slot parameter snapshots persisted to `localStorage` (`fusionSnap_0..3`), cycled with `[,]`/`[.]` keys with auto-save on switch; (2) drift LFO that slowly oscillates numeric params within their ranges; (3) beat-synced morph that lerps toward random nearby targets every N beats. Boolean enable params are excluded from all automation. Instantiates itself as `window.fusionAutomation` on load. `sketch.js` calls `fusionAutomation.update(audioManager)` only when Fusion mode is active.

**`vj-sync.js` — `VJSyncManager`** — automates VJ controls in sync with beat detection (mode switching, phosphor cycling, scanline toggle, background pulse/stutter). Independent of Fusion mode — runs on all modes when enabled with `[V]`.

## Key constraints

**AudioContext unlock**: `ctx.resume()` must be called synchronously inside a user gesture (click, file input change). Calling it inside an async callback (like `p5.SoundFile`'s success callback) is outside the gesture window and may not unlock audio. The primary resume call is in `_loadAudioFileFromObject()` in `sketch.js`, before the async `audioManager.loadAudioFile()` call.

**`getAudioContext()`**: p5.sound global — always guard with `typeof getAudioContext === 'function'` before calling. It is not present in all contexts.

**p5.FFT wiring**: `p5.FFT` without `setInput()` analyzes the p5.sound master output. Do NOT call `fft.setInput(soundFile)` — it disconnects the source from master output and breaks analysis.

**Instance mode**: p5 globals (`width`, `height`, `textWidth`, etc.) are only available as `p.*` inside `sketch.js`. All other files must not use bare p5 globals — `background-fx.js` and `fusion-automation.js` use plain JS only.

**Phosphor rendering**: brightness values in grid cells (0–1) map to three color stops (`dim` / `mid` / `bright`) from `CONFIG.PHOSPHORS[currentPhosphor]`. Thresholds: `> 0.66` → bright, `> 0.33` → mid, else dim.

**`FUSION_PARAMS` param store**: `fusion-params.js` must load before `background-fx.js` and all mode files. `background-fx.js` reads `FUSION_PARAMS.bgFx` inside `update()` at runtime (not at construction time) so a missing reference at load time is safe, but the load order must still be respected to avoid maintenance traps.

**`BackgroundFX` scope**: `background-fx.js` is only active in Fusion mode. `sketch.js` guards the update call with `currentModeIndex === 9`. Do not call `backgroundFX.update()` unconditionally — it will apply pixel effects to all modes.

**`syncFusionPanelState()`**: must be called after any code that writes to `FUSION_PARAMS` programmatically (automation, snapshot load) so sliders and toggle buttons stay in sync with actual values. `FusionAutomation.update()` calls it automatically on frames where it changes params.

## Keyboard shortcuts (Fusion mode extras)

| Key | Action |
|-----|--------|
| `[0]` button | Switch to Fusion mode |
| Tab | Open/close the Fusion params panel (when Fusion is active) |
| `,` | Previous snapshot slot (auto-saves current slot first) |
| `.` | Next snapshot slot (auto-saves current slot first) |

## Adding a new mode

1. Create `modes/yourmode.js` — class with `constructor(config)`, `reset()`, `update(grid, cols, rows, audio, bg)`
2. Add `<script src="modes/yourmode.js"></script>` in `index.html` (before `fusion-panel.js`)
3. Add a button in `#mode-buttons` in `index.html`
4. Push `new YourMode(CONFIG)` in `p.setup` in `sketch.js` (order = button index)
5. Add mode name to `modeNames` array in `updateStatusBar()` in `sketch.js`
6. Add mode index to `CONFIG.VJ_SYNC.MODE_LIST` in `config.js` if it should be eligible for VJ sync auto-switching
