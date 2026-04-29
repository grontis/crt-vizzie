# crt-vizzie — Repository Review

Review date: 2026-04-28
Branch reviewed: `webgl-rewrite`
Scope: `v2/` (browser-side WebGL ASCII visualizer) and `pi/` (Raspberry Pi hardware bridge & desktop simulator), plus top-level docs.

This report is a survey of gaps, bugs, inconsistencies, and concerns. No code was modified. Findings are grouped by severity. File:line references use the form `path:line`.

---

## Summary of severities

| Severity | Count |
|---|---|
| High (visible breakage) | 5 |
| Medium (correctness / staleness) | 9 |
| Low (polish / minor) | 8 |
| Informational / future work | 5 |

---

## High severity

### H1. ASCII-art figures render with ~40 missing characters (visual corruption)

`v2/sketch.js:36-68` builds the glyph atlas charset from:

- ASCII printable (`String.fromCharCode(32..126)`)
- Katakana (`U+30A0–U+30FF`)
- glitch chars: `!@#$%^&*[]{}|\/<>?~\`+=-_░▒▓█▄▀■□▪▫◘◙◄►▲▼◆◇○●`
- block/shade chars: `▁▂▃▄▅▆▇█`
- `·`

The 12 figures in `v2/ascii-art.js` use a much larger set of box-drawing and symbolic Unicode characters that are **not in the atlas**. Confirmed missing:

```
† ‡ ⌐ ⌘ ⌬ │ ┌ ┐ └ ┘ ├ ┤ ┬ ┴ ┼ ═ ║ ╔ ╗ ╚ ╝ ╞ ╠ ╣ ╤ ╥ ╧ ╨ ╩ ╪ ╫ ╱ ╲ ◈ ◉ ◊ ★ ☽ ☾ ✓ ✦ ✧ ⟲
```

In `v2/fusion.js:_stampFigure`, `_seedGlitchFigure`, and `setCell` callers, any unmapped char resolves to atlas index 0 (`this._charMap.get(ch) || 0`) — i.e. blank space. The result: every figure that uses box-drawing or occult-tech symbols (which is most of them — `cyber_skull`, `arcane_eye`, `rune_tower`, `portal_rift`, `summoning_circle`, `dragon_core`, `hex_dump`, `terminal_breach`, `circuit_board`, `packet_flow`) renders with major chunks blanked out — borders, eyes, sigils, etc. all become empty cells.

Fix: extend `buildCharset()` to include the box-drawing block (`U+2500–U+257F`), and a curated list of the symbolic chars listed above. Worth adding a unit/dev-mode check that warns when an art figure references a char missing from the atlas.

---

### H2. Hardware bridge can never write 4 of the 16 mapped ADC channels

`pi/hw-mapping.json` maps these 4 channels:

```
chip0 ch5 → bgFx.warpAmount
chip0 ch6 → bgFx.chromaOffset
chip0 ch7 → waveOpacity        (OK)
chip1 ch6 → bgPulseAmount
chip1 ch7 → bgFx.warpFreq
```

`v2/hardware-bridge.js:36` (`setV2Param`) uses flat keys only and explicitly documents at line 9-10: *"No bgFx nested-path handling (no bgFx in v2)"*. There are no `warpAmount`, `chromaOffset` (as a hw param), `warpFreq`, or `bgPulseAmount` keys in `V2_PARAMS` (`v2/config.js:91`) — these are leftover from the v1 / `BackgroundFX` design. When a `hw` message arrives for those keys, `setV2Param` falls through the `range` branch and silently writes the value to `V2_PARAMS['bgFx.warpAmount']` etc., which nothing reads.

Net result: 4/16 of the user's physical knobs do nothing at all. The matching sliders in `pi/sim-ui.html:259-277` are also dead.

Fix options:
1. Remap those 4 channels to actual `V2_PARAMS` keys (e.g. `bgFxBlur`, `chromaBeat`, `bgFxScalePulse`, `bgFxHueShift`).
2. Or implement nested `bgFx` in `V2_PARAMS` and a dot-path resolver in `setV2Param`. Note however that there is no warp/posterize/pixel-pipeline FX in v2 — those v1 effects do not exist any more, so a remap (option 1) is the right call.

Either way, `pi/hw-mapping.json`, `pi/sim-ui.html`'s inline `CHANNELS` array (which is hand-duplicated from the JSON, see L2), and the `pi/HARDWARE_SETUP.md` table all need to agree.

---

### H3. README claim "Cycle scanline mode (OFF → PIXEL → CELL-GAP → SMOOTH)" is false

`README.md:35` advertises 4 scanline modes cycling on `S`. Reality:

- The shader (`v2/renderer.js:155-181`) implements all 4 modes — good.
- `v2/sketch.js:286` only toggles between `0` and `1`: `V2_PARAMS.scanlineMode = V2_PARAMS.scanlineMode === 0 ? 1 : 0;`
- `v2/config.js:178` declares `scanlineMode: { min: 0, max: 1 }` — the range itself caps at 1, so even the hardware bridge can never reach modes 2 or 3.
- The status line (`v2/sketch.js:430`) prints `scanlineMode ? 'ON' : 'OFF'` — also doesn't reflect mode names.

Fix: change the toggle to `(scanlineMode + 1) % 4`, raise the param range to `max: 3`, and update the status renderer to print the mode name.

---

### H4. `pi-bridge.py` "single-client model" is broken — two clients split traffic

`pi/pi-bridge.py:198-221` (`_handler`) creates one `_send_loop` per connection. All `_send_loop` instances `await _adc_queue.get()` from a **single shared queue**. If two clients are connected at the same time (e.g. a forgotten browser tab, plus the kiosk page), each `put` is delivered to exactly one `get` — so each client sees only ~half of all parameter updates, and which half is non-deterministic.

The comment on line 200-202 says *"Single-client model: each new connection replaces the previous one"*, but no code replaces or rejects the previous connection. (The desktop sim `pi/pi-sim.py` is correctly broadcast-based; the production bridge is not.)

Fix options:
1. Track the active client websocket in a module-global; on new connection, close the old one before installing the new.
2. Or convert `_send_loop` to a true broadcast (mirroring `pi-sim.py:_broadcast`), with a single per-bridge poll loop and a fan-out send.

Option 2 is more robust and lets the sim-ui be connected at the same time as the visualizer.

---

### H5. `pi-start.sh` exposes the HTTP server on `0.0.0.0`

`pi/pi-start.sh:21` runs `python -m http.server 8080 --directory "$APP_DIR"` with no `--bind` flag. The default binding is all interfaces, so anyone on the local network can fetch the repo (including `pi/`, which contains nothing secret today but will likely contain user audio files, mapping data, etc. once dropped in). `v2/kiosk.sh:25` does this correctly with `--bind 127.0.0.1`.

Fix: add `--bind 127.0.0.1` to the `python -m http.server` call in `pi-start.sh`. If LAN exposure is desired, gate it behind a script flag.

---

## Medium severity

### M1. `CLAUDE.md` describes a codebase that no longer exists

`CLAUDE.md` documents a v1 architecture: p5.js instance mode, `modes/*.js`, `fusion-params.js`, `fusion-panel.js`, `fusion-automation.js`, `vj-sync.js`, `BackgroundFX` pixel pipeline, `FUSION_PARAMS`, mode keys 0-9, etc. None of that exists in this branch. The actual app lives in `v2/` and is a pure WebGL 2 + raw Web Audio rewrite with `V2_PARAMS`, no modes, no p5, no fusion-panel/automation.

Risk: any Claude Code (or human contributor) reading `CLAUDE.md` will immediately make wrong assumptions — try to edit `modes/fusion.js` (doesn't exist), look for `setCell` globals (don't exist), call `syncFusionPanelState()` (doesn't exist), use `getAudioContext()` (p5.sound, not present), etc.

Fix: rewrite `CLAUDE.md` to reflect the actual `v2/` architecture. Keep the v1 doc only if you intend to retain v1 alongside v2 (which the repo currently does not — there is no `v1/` directory).

---

### M2. `pi/HARDWARE_SETUP.md` and `pi/SIM.md` reference `FUSION_PARAMS` / `fusion-params.js`

`pi/HARDWARE_SETUP.md:3, 295, 309` and `pi/SIM.md:23, 36` say "FUSION_PARAMS". The actual store is `V2_PARAMS` (`v2/config.js:91`). The documented file `fusion-params.js` does not exist. `HARDWARE_SETUP.md:307` instructs users to use dot notation for nested params (`"bgFx.warpAmount"`), which is exactly the syntax the v2 bridge cannot resolve (see H2).

Fix: search-and-replace `FUSION_PARAMS → V2_PARAMS` and `fusion-params.js → v2/config.js` across `pi/*.md`, drop the dot-path section, list the real param keys.

---

### M3. `PERFORMANCE.md` is contradicted by current code

`PERFORMANCE.md:111-112` ("Fix 3: removing the BackgroundFX pixel pipeline") states: *"The v2 MVP does not include a background image/video layer."* That was true at MVP — but `v2/background.js`, `v2/bg-fx.js`, and `v2/bg-fx-panel.js` now exist and are wired into `index.html`. `v2/sketch.js:115-118` instantiates the bg layer and FX manager unconditionally, and the `B`/`L`/`X` keys interact with them.

The doc still has its educational value, but the present-tense framing is misleading. A short "v2 today" addendum noting that a CSS-filter-based bg FX layer was reintroduced (using the GPU compositor, not `getImageData`) would set expectations correctly.

---

### M4. `sketch.js` font-loaded check tests for the wrong font name

`v2/sketch.js:81-89`:

```js
const fontLoaded = [...document.fonts].some(f =>
  f.family.includes('GlassTTY') && f.status === 'loaded'
);
if (!fontLoaded) {
  console.warn('[sketch] GlassTTY font not loaded — atlas will use fallback font');
} else {
  console.log('[sketch] GlassTTY font loaded OK');
}
```

The actual font in use is Orbitron (`v2/config.js:15`, `v2/index.html:9-13`). This stale check will *always* warn — masking the case where Orbitron really did fail to load. Easy fix: use `V2_CONFIG.FONT_FACE` in the substring test.

---

### M5. Boot screen advertises specs that never get verified

`v2/startup.js:17-28` prints fixed strings:

```
CPU: ARM CORTEX-A76 x4  3.6GHz  [OK]
MEMORY: 8192MB LPDDR4X  [OK]
WebGL2: INITIALIZING... DONE  [OK]
GLYPH ATLAS: 275 chars  [OK]
```

Two concerns:
- This sets a Pi-5-specific banner even when running on a desktop, which is fine for theming but undermines the "boot diagnostics" framing.
- The `GLYPH ATLAS: 275 chars` line is a literal — but `buildCharset()` produces a charset whose size depends on the chars added; H1 above shows the count is *more* than 275 once the missing characters get added back. The line cosmetically lies even today and will drift further.

Fix: either keep these as pure flavor (call them out as fictional in a comment) or tie at least the atlas count to `charset.length` and the WebGL line to actual context status.

---

### M6. Tab-key `bgFxPanel` toggle clashes with browser focus traversal

`v2/sketch.js:241-246` swallows Tab globally with `e.preventDefault()` to toggle the BG FX panel. That works, but the panel itself has interactive controls (`<input type="range">`, `<input type="checkbox">`). Once the panel is open, the user cannot Tab between sliders — the listener will close the panel instead of focusing the next input.

Fix: only handle Tab when `document.activeElement` is `body` / outside the panel; or when the panel is hidden. Symmetric improvement: Esc closes the panel.

---

### M7. `bg-fx.js` reset doesn't fully unscale the bg layer

`v2/bg-fx.js:103-110` `reset()` clears `filter`, `transform`, `opacity` and the three internal envelopes. Good. But during normal operation the `transform` is only *written* when `scalePulse > 0.001` (`v2/bg-fx.js:91-94`). If the envelope decays *to* 0.001, the transform sticks at the last assigned value indefinitely until the next reset/disable. Practically this means a residual `scale(1.000x)` gets left in place forever — visually invisible (≈1.001× scale) but a small surprise.

Fix: also write `transform = ''` (or `scale(1)`) whenever the envelope crosses below the threshold, or always write the transform.

---

### M8. `_buildDemoGraph` is only called when an `AudioContext` already exists

`v2/audio.js:93-107` `enableDemoMode()` calls `_buildDemoGraph()` only `if (this._ctx)` is already created. If demo mode is selected from the startup screen *before* `resume()` has created the context (the kiosk auto-select path; see `sketch.js:166`), `enableDemoMode` returns without ever building the oscillator graph, so the demo synth is silent. Visualization still works (the `_updateDemo` path generates synthetic spectrum/waveform on the CPU), but the user hears nothing — even though "demo mode" implies an audible synthesizer.

In the current call ordering this is dodged because `applyChoice()` (`sketch.js:163-183`) calls `audioManager.resume()` *before* `enableDemoMode()`. But the contract is fragile: any future caller that reorders or forgets the resume call will silently drop the audio. Either always create the ctx inside `enableDemoMode`, or document the precondition with an assertion.

---

### M9. Audio file load: `URL.revokeObjectURL` happens twice

`v2/audio.js:124-167` `loadAudioFile`:

1. Calls `_cleanupFileAudio()` which revokes `_blobUrl` if present and clears it.
2. Then has its own `if (this._blobUrl)` guard to revoke (now always false).
3. Creates a new blob URL.
4. On the `error` listener, revokes again.

Step 4 is fine. Step 2 is dead code now (was needed before step 1 was added). Not a bug, just confusing. Worth pruning.

---

## Low severity

### L1. `v2/background_images/manifest.json` is unused

`v2/background_images/manifest.json` is a single-line JSON array `["lminalpool.jpg"]`. Nothing in `v2/` references it (verified with grep). Either wire it into a "cycle background" feature or delete the file.

### L2. `pi/sim-ui.html` re-defines `CHANNELS` — drift risk

`pi/sim-ui.html:259-277` inlines the channel definitions verbatim from `pi/hw-mapping.json` to avoid `fetch()` from `file://`. The comment at L258 acknowledges the duplication ("update both files if mapping changes"). When H2/M2 are fixed, both files will need to be updated in lockstep — a known smell. A small build step or a `<script>`-injected `hw-mapping.js` (`window.HW_MAPPING = [...]`) would eliminate the duplication. Not urgent.

### L3. `kiosk.sh` uses `chromium` not `chromium-browser`

`v2/kiosk.sh:32` runs `chromium`. Pi OS Bookworm provides both `chromium` and `chromium-browser` (former is the new name), but older Pi OS releases (and many Debian-derived distros) only have `chromium-browser`. `README.md:54` says "Chromium installed (`chromium-browser`)". The script will fail with "command not found" on those systems. Either:

- Use `command -v chromium || command -v chromium-browser` to pick whichever exists, or
- Document the supported versions and pin Bookworm.

### L4. `kiosk.sh` doesn't trap signals to clean up the HTTP server

`v2/kiosk.sh:25-49` starts `python3 -m http.server` in the background, then runs Chromium in the foreground. If the script is killed with SIGTERM/SIGINT *before* Chromium exits cleanly, the trap falls through and the HTTP server is leaked. `pi-start.sh:25` correctly uses `trap "kill $HTTP_PID..." EXIT`. Same fix should apply here.

### L5. `pi-bridge.py` logging defaults to DEBUG

`pi/pi-bridge.py:32-36` sets `level=logging.DEBUG`. This emits one line per knob change at 60 Hz polling and one line per audio frame at 16 Hz — that is ~76 lines/sec written to stdout in steady state, hot enough to noticeably slow the bridge process on a Pi if stdout is unbuffered. `pi/pi-sim.py:43` already gates DEBUG behind `--debug`. Apply the same pattern in `pi-bridge.py`.

### L6. `pi-bridge.py` deprecated asyncio call

`pi/pi-bridge.py:230` uses `asyncio.get_event_loop()`. Deprecated in Python 3.10+, removed in 3.14. Use `asyncio.get_running_loop()` (already inside an async function) or capture the loop via `loop = asyncio.get_running_loop()` once `_main()` starts.

### L7. `setV2Param` rejects boolean writes when range is missing

`v2/hardware-bridge.js:42-45` returns early if `typeof params[key] === 'boolean'` and writes `Boolean(value)`. Fine for known booleans like `figureEnabled`. But if hw-mapping ever sends an unknown boolean key (typo or not-yet-defined param), it gets silently coerced and stored on `V2_PARAMS`, possibly overwriting nothing useful. Low risk — currently no boolean keys are mapped — but worth a `console.debug` for unknown keys to make typos visible.

### L8. WebGL `precision mediump float` may produce visible banding in phosphor blends

`v2/renderer.js:14, 28-29` declares `precision mediump float`. On Pi 5 / VideoCore VII with mediump = 16-bit float, the three-stop phosphor blend (`v2/renderer.js:88-96`) is fine but the chromaOffset interpolation (and the smooth scanline `sin(phase * π)`) can show stepping. Not a bug — just something to test on actual hardware. Bumping to `highp float` everywhere costs little on this GPU.

---

## Informational / future work

### I1. No automated tests anywhere

There is no test runner, no `package.json`, no CI. For a vanilla-JS app this is reasonable — but the `V2_PARAM_RANGES` ↔ `V2_PARAMS` ↔ `pi/hw-mapping.json` consistency invariant is exactly the kind of thing a one-off "did all keys round-trip" sanity script would catch (and would have caught H2).

Suggested: a small Node script that loads `v2/config.js` (via Function/eval or a tiny shim), reads `pi/hw-mapping.json`, and asserts every `param` exists in `V2_PARAMS` and has a matching `V2_PARAM_RANGES` entry. Run from `pi-start.sh` / `kiosk.sh`, or from a one-line `npm test`.

### I2. `led_output.update_leds` is a stub

`pi/led_output.py:29` is `pass`. The README and HARDWARE_SETUP imply the LEDs are part of the system but the actual driver code is unwritten. This is acknowledged in the file's docstring but not in the README's "Hardware controls (MCP3008)" section. A reader copying from README → HARDWARE_SETUP → led_output is going to find nothing actually drives LEDs.

### I3. No fps / perf overlay

`PERFORMANCE.md` makes specific claims (~10–15 ms/frame on Pi 5). There is no in-app way to verify them. A `~`-keyed FPS / frame-time overlay (like the existing `\`` debug-atlas hotkey) would make regressions self-evident during VJ sets and make the perf doc falsifiable.

### I4. Status bar truncation on small screens

`v2/index.html:54-70` applies `text-overflow: ellipsis` to the bottom status bar. The string is long (`"[SOURCE] phosphor:X | scanline:ON | bg:ON | bgfx:ON | WebGL... | B=bg X=bgfx S=scanline P=phosphor L=load-bg F=full"`). On a CRT TV running at low effective resolution, the help string gets clipped first. Consider hiding the help half (everything after the last `|`) or showing it only for the first N seconds after a key press.

### I5. Resize uses `screen.width/height` for fullscreen

`v2/sketch.js:354-356` reads `window.screen.width/height` when `document.fullscreenElement` is set. On multi-monitor setups, this is the *primary* monitor's dimensions, not the monitor the page actually occupies. Use `window.innerWidth/innerHeight` instead (they are correct in fullscreen) for portability. Probably irrelevant for the Pi-kiosk target, but worth noting for the desktop dev path.

---

## Cross-check matrix (params reachable from hardware)

Done by walking `pi/hw-mapping.json` → checking key in `V2_PARAMS`/`V2_PARAM_RANGES`:

| chip.ch | param | exists in V2_PARAMS? | range? | works? |
|---|---|---|---|---|
| 0.0 | `rainSpeedMax` | ✓ | ✓ | ✓ |
| 0.1 | `glitchChance` | ✓ | ✓ | ✓ |
| 0.2 | `figBrightness` | ✓ | ✓ | ✓ |
| 0.3 | `figDecay` | ✓ | ✓ | ✓ |
| 0.4 | `rainBeatMult` | ✓ | ✓ | ✓ |
| 0.5 | `bgFx.warpAmount` | ✗ | ✗ | **dead** (H2) |
| 0.6 | `bgFx.chromaOffset` | ✗ | ✗ | **dead** (H2) |
| 0.7 | `waveOpacity` | ✓ | ✓ | ✓ |
| 1.0 | `rainSpeedMin` | ✓ | ✓ | ✓ |
| 1.1 | `rainTrail` | ✓ | ✓ | ✓ |
| 1.2 | `glitchScatter` | ✓ | ✓ | ✓ |
| 1.3 | `glitchThreshold` | ✓ | ✓ | ✓ |
| 1.4 | `waveSpeed` | ✓ | ✓ | ✓ |
| 1.5 | `waveBeatBoost` | ✓ | ✓ | ✓ |
| 1.6 | `bgPulseAmount` | ✗ | ✗ | **dead** (H2) |
| 1.7 | `bgFx.warpFreq` | ✗ | ✗ | **dead** (H2) |

12/16 channels work. 4 are dead.

---

## Suggested order of operations

If addressing this list, the highest-value first passes are roughly:

1. **H1** (charset) — biggest visual gain for one-line fix.
2. **H2** + **L2** (hw-mapping) — restores 25% of physical controls.
3. **M1**, **M2**, **M3** — kill stale docs that will misdirect every future contributor (human or LLM).
4. **H3** — implement the scanline cycle promised by README.
5. **H4** — pi-bridge multi-client. Worth a small refactor to broadcast.
6. **H5**, **L3-L7** — security & polish in the Pi scripts.
7. **M4–M9, L1, L8** — small JS hygiene fixes.
8. **I-series** — process work (tests, perf overlay, LED driver).
