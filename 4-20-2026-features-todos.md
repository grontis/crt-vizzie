# GRONTIS.IO — Fusion Mode Feature Roadmap

**Goal**: Make Fusion the production-quality "main event" mode by adding runtime parameter control and artistic background modulation. The other modes stay intact as references; Fusion becomes the one you actually perform with.

---

## Current state (baseline)

- `modes/fusion.js` — FusionMode class with four layers: FIGURE (ASCII art), RAIN (matrix), GLITCH (corruption bursts), BG (opacity pulse + luma sampling). All tuning lives in `static` class constants at the top.
- `background.js` — BackgroundLayer manages a raw `<img>`/`<video>` DOM element. No per-pixel FX.
- `sketch.js` — p5 instance mode entry point. Grid render loop, keyboard handling, mode switching.
- `vj-sync.js` — VJSyncManager automates phosphor, mode switch, scanline toggle, BG pulse/stutter.
- No runtime UI for parameter tweaking — all changes require editing source.

---

## Phase 1 — Runtime parameter panel for Fusion

**Goal**: Every meaningful Fusion constant becomes a live slider or toggle, visible in a collapsible panel. No page reload needed to tweak feel.

### What to build

**1a. `fusion-params.js` — parameter store**

New file loaded before `modes/fusion.js`. Exports a single `window.FUSION_PARAMS` object that mirrors all FusionMode static constants with their defaults:

```js
window.FUSION_PARAMS = {
  // Layer enable toggles
  figureEnabled:  true,
  rainEnabled:    true,
  glitchEnabled:  true,
  bgEnabled:      true,

  // Figure
  figDecay:       0.007,
  figReseedFrames: 160,
  figBrightness:  0.65,
  figSmear:       0.025,

  // Rain
  rainSpeedMin:   0.15,
  rainSpeedMax:   0.90,
  rainBeatMult:   3.2,
  rainTrail:      14,
  rainInteract:   0.50,
  rainBurnBoost:  0.20,

  // Glitch
  glitchThreshold: 0.62,
  glitchChance:   0.55,
  glitchScatter:  0.045,
  glitchTear:     0.020,

  // Background
  bgKickSub:      0.50,
  bgKickBass:     0.40,
  bgPulseAmount:  0.18,
  bgPulseDecay:   0.04,
  bgTrebleThresh: 0.39,
  bgStutterFrames: 14,
  bgStutterChance: 0.45,
  bgLumaBoost:    0.35,
};
```

**1b. Update `modes/fusion.js`**

Replace all reads of `FusionMode.STATIC_CONST` with reads of `FUSION_PARAMS.camelCaseName`. Static constants stay as comments showing the defaults but are no longer the live source of truth. Layer enable toggles gate entire update blocks:

```js
// Figure update — gated by toggle
if (FUSION_PARAMS.figureEnabled) { /* ... decay, smear ... */ }

// Render figure
if (FUSION_PARAMS.figureEnabled) { /* ... setCell calls ... */ }
```

**1c. `fusion-panel.js` — UI panel**

New file. Builds a `<div id="fusion-panel">` injected into `<body>`. Toggle visibility with `[Tab]` key (added to sketch.js keyPressed). Panel is only shown when Fusion mode is active.

Panel layout (rows of controls, grouped by layer):

```
[FUSION PARAMS]                                [×]
────────────────────────────────────────────────
FIGURE   [ON/OFF]  DECAY ──●── BRIGHTNESS ──●──
RAIN     [ON/OFF]  SPEED ──●── TRAIL ──●── BEAT ──●──
GLITCH   [ON/OFF]  THRESH ──●── SCATTER ──●──
BG FX    [ON/OFF]  PULSE ──●── LUMA ──●──
```

Each slider uses `<input type="range">` and writes directly to `FUSION_PARAMS` on `input` event. No framework — plain DOM. Style it to match the existing CRT aesthetic (monospace font, phosphor green colors from CSS variables already in `index.html`).

**1d. Wire `[Tab]` key in `sketch.js`**

In the `keyPressed` handler, add:
```js
case 'Tab': if (currentModeIndex === 9) toggleFusionPanel(); break;
```
`toggleFusionPanel()` is exported on `window` from `fusion-panel.js`.

**1e. Script load order in `index.html`**

```
config.js → audio.js → background.js → ascii-art.js
  → fusion-params.js          ← new, before modes
  → modes/*.js
  → fusion-panel.js           ← new, after modes, before vj-sync
  → vj-sync.js → sketch.js
```

### Acceptance criteria
- Switching to mode [0] FUSION shows the panel toggle hint in the status bar
- Pressing Tab opens/closes the panel
- Moving any slider changes visual behavior in real time without a reload
- Toggling FIGURE OFF removes the ASCII art layer; toggling RAIN OFF freezes all columns
- Panel closes when switching away from Fusion mode

---

## Phase 2 — Artistic background FX canvas

**Goal**: Instead of a raw DOM image behind the ASCII grid, run the background through a p5.js-powered FX pipeline each frame — audio-reactive pixel manipulation that makes the background feel like part of the performance.

### Architecture

The existing `BackgroundLayer` displays a DOM `<img>`/`<video>`. To apply per-pixel FX we need a canvas we can draw into. The approach:

1. Add a new `<canvas id="bg-fx-canvas">` in `index.html` between the BG media element and the p5 canvas (z-index: 1, same positioning as the p5 canvas).
2. `BackgroundFX` class (new file `background-fx.js`) holds a 2D context for this canvas and exposes `update(audioManager)` called once per frame from `sketch.js`.
3. Each frame: draw the source media into the FX canvas (full res), then apply effects in sequence as pixel operations or canvas transforms.
4. The original `<img>`/`<video>` element gets `display: none` once a FX canvas is active — the FX canvas is the visible background.
5. `BackgroundLayer.getLuma()` continues sampling from its existing low-res `_sampleCanvas` — no change needed there.

### Effects to implement (all independently parameterized)

Each effect has an `enabled` toggle and an `intensity` (0–1) in `FUSION_PARAMS` (or a separate `BG_FX_PARAMS` sub-object).

**FX 1 — Pixel displacement / wave warp**
- Shift rows or columns of pixels by a sinusoidal offset driven by audio.
- `offsetX[row] = sin(row * freq + time) * amplitude * bassEnergy`
- Implemented via `getImageData` → pixel copy with shifted source coordinates → `putImageData`.
- Intensity knob controls amplitude (0 = no shift, 1 = severe warp).

**FX 2 — Chromatic aberration**
- Separate R, G, B channels by a small pixel offset.
- R shifted left by `N px`, B shifted right by `N px`, G unshifted.
- `N` driven by `bands.treble * intensity * maxOffset`.
- Implemented via three `drawImage` calls on an offscreen canvas with channel masking, or direct pixel manipulation.

**FX 3 — Scanline corruption**
- On beat, randomly select 1–3 horizontal strips of 3–8 rows and shift them horizontally by a random amount.
- Strips decay (shift returns to zero) over ~12 frames.
- Adds the "VHS glitch" look matching the ASCII glitch aesthetic.

**FX 4 — Color grade / posterize**
- Quantize pixel colors to N levels (default 8) for a retro flat-color look.
- `quantized = round(value / step) * step` per channel.
- N is a param (range 2–32); lower = more posterized.
- Optional hue shift: rotate all pixel hues by a fixed angle (dial in a color treatment).

**FX 5 — Beat flash / blowout**
- On kick, briefly raise the brightness/opacity of the BG canvas to near-white for 2–4 frames, then decay.
- Implemented by drawing a semi-transparent white rect over the FX canvas each frame during the flash.
- Separate from the opacity pulse in Phase 1 (that adjusts CSS opacity; this is a pixel-level overexposure).

### Parameterization

Add a `BG_FX` sub-object to `FUSION_PARAMS` (or a parallel `window.BG_FX_PARAMS`):

```js
BG_FX: {
  enabled:           false,    // master switch
  warpEnabled:       true,
  warpIntensity:     0.5,
  chromaEnabled:     true,
  chromaIntensity:   0.4,
  scanCorruptEnabled: true,
  scanCorruptIntensity: 0.6,
  posterizeEnabled:  false,
  posterizeLevels:   8,
  hueShift:          0,        // degrees
  beatFlashEnabled:  true,
  beatFlashIntensity: 0.5,
}
```

Add a BG FX section to the fusion panel UI from Phase 1.

### File changes

- New: `background-fx.js` (loaded after `background.js`, before `modes/`)
- `index.html`: add `<canvas id="bg-fx-canvas">` with same sizing CSS as p5 canvas
- `sketch.js`: call `backgroundFX.update(audioManager)` each frame (after `backgroundLayer.update()`)
- `fusion-panel.js`: add BG FX section to panel

### Acceptance criteria
- With no background loaded, BG FX is a no-op (no errors)
- With an image loaded and FX enabled, warp visibly distorts the image in response to bass
- Chromatic aberration splits colors on treble peaks
- Beat flash fires on kicks and decays within 4 frames
- All effects can be individually toggled from the panel with no reload

---

## Phase 3 — VJ automation improvements (post Phase 1+2)

These build on the param system from Phase 1.

**3a. Parameter snapshots**

- `[,]` and `[.]` keys (while Fusion is active) save/load from 4 param slots stored in `localStorage`.
- A small slot indicator appears in the status bar: `[SNAP: 1]`.
- Useful for switching between a "subtle" and "heavy" preset mid-set.

**3b. Auto-drift**

- An optional mode where params slowly oscillate between two extremes over a long period (e.g., 30–120 seconds), driven by a low-frequency oscillator.
- The oscillation rate is itself influenced by BPM (faster BPM = faster oscillation).
- Toggle with a button in the fusion panel.

**3c. Beat-synced param morphs**

- On every Nth beat (N configurable, default 16 = one measure at 4/4), smoothly interpolate from the current params to a randomly selected nearby variant.
- "Nearby" = each param drifts by ±10–25% of its range.
- Creates slow automated variation without being jarring.

---

## Implementation notes for agents

- **No bundler, no framework.** All new files are plain `<script>` tags in `index.html`. Load order matters — see CLAUDE.md.
- **p5 globals are `p.*` inside sketch.js only.** `background-fx.js` must use plain Canvas 2D API (`getContext('2d')`), not p5 methods.
- **`window.FUSION_PARAMS` is the live source of truth** after Phase 1. No code should read `FusionMode.STATIC_*` after that migration.
- **`setCell(c, r, char, brightness)` and `setString` are the only way modes write to the grid.** FX canvas is entirely separate from the ASCII grid.
- **BG FX canvas pixel operations are expensive.** Cap at a reasonable resolution — either native canvas size or a fixed max (e.g., 1280×720) and use CSS to scale up. Use `willReadFrequently: true` on the 2D context.
- **All UI elements** should use the existing CSS variables (`--phosphor-bright`, `--phosphor-dim`, `--bg-dark`) for visual consistency.
- **Phase 1 is a prerequisite for Phase 3.** Phase 2 is independent and can be built in parallel with Phase 1.
