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
config.js → audio.js → background.js → ascii-art.js → modes/*.js → sketch.js (last)
```

**`config.js`** — single `CONFIG` object. All tuneable constants live here. No logic.

**`audio.js` — `AudioManager`** — owns all audio state. Three sources: `'idle'` (zeroed data), `'demo'` (procedural synthesizer, no hardware), `'file'` (p5.SoundFile looping a loaded file). Exposes `getSpectrum()`, `getWaveform()`, `getBands()`, `beatActive`, `beatIntensity`. Called by `sketch.js` each frame via `audioManager.update()`.

**`sketch.js`** — p5 instance mode entry point. Owns the character grid (`grid[row][col] = { char, brightness }`), render loop, keyboard handling, and idle typewriter animation. Exposes `window.setCell` and `window.setString` so mode files can write to the grid directly. All UI control functions (`toggleDemo`, `cyclePhosphor`, etc.) are assigned to `window.*` in `p.setup`.

**`background.js` — `BackgroundLayer`** — manages an `<img>`/`<video>` DOM element and a hidden sampling canvas. Downsamples the media to grid resolution each frame so modes can call `bg.getLuma(col, row)` to bias rendering on background content.

**`modes/*.js`** — each mode is a class with:
- `constructor(config)` — store reference, init state
- `reset()` — called on grid resize or mode activation
- `update(grid, cols, rows, audio, bg)` — called each frame; writes to grid via global `setCell(c, r, char, brightness)` and `setString(c, r, str, brightness)`

Modes never draw to the p5 canvas directly — they only write characters and brightness values to the grid. `sketch.js` renders the grid each frame using phosphor color mapping.

## Key constraints

**AudioContext unlock**: `ctx.resume()` must be called synchronously inside a user gesture (click, file input change). Calling it inside an async callback (like `p5.SoundFile`'s success callback) is outside the gesture window and may not unlock audio. The primary resume call is in `_loadAudioFileFromObject()` in `sketch.js`, before the async `audioManager.loadAudioFile()` call.

**`getAudioContext()`**: p5.sound global — always guard with `typeof getAudioContext === 'function'` before calling. It is not present in all contexts.

**p5.FFT wiring**: `p5.FFT` without `setInput()` analyzes the p5.sound master output. Do NOT call `fft.setInput(soundFile)` — it disconnects the source from master output and breaks analysis.

**Instance mode**: p5 globals (`width`, `height`, `textWidth`, etc.) are only available as `p.*` inside `sketch.js`. Mode files must not use bare p5 globals — they receive everything they need through `update()` arguments.

**Phosphor rendering**: brightness values in grid cells (0–1) map to three color stops (`dim` / `mid` / `bright`) from `CONFIG.PHOSPHORS[currentPhosphor]`. Thresholds: `> 0.66` → bright, `> 0.33` → mid, else dim.

## Adding a new mode

1. Create `modes/yourmode.js` — class with `constructor(config)`, `reset()`, `update(grid, cols, rows, audio, bg)`
2. Add `<script src="modes/yourmode.js"></script>` in `index.html` (before `sketch.js`)
3. Add a button in `#mode-buttons` in `index.html`
4. Push `new YourMode(CONFIG)` in `p.setup` in `sketch.js` (order = button index)
5. Add mode name to `modeNames` array in `updateStatusBar()` in `sketch.js`
