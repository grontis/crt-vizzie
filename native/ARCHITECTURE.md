# crt-vizzie native — MVP architecture

A native **Rust libretro frontend** that runs an N64 emulator core and composites the
crt-vizzie audio-reactive ASCII visualizer over the live game frame, on a Raspberry Pi 5.

This document is the architectural entry point for the native port. For the de-risking
spike that gates the whole effort, see [`PHASE0_SPIKE.md`](./PHASE0_SPIKE.md). For the
visual-engine behaviour being ported, the source of truth remains the `v2/` web app and
the root [`CLAUDE.md`](../CLAUDE.md).

---

## Why native (and why this shape)

The browser app can't run on a Pi: WASM N64 is too heavy and the visualizer sits on top of
it. Going native flips both problems:

- **Native N64 on a Pi 5 is full speed.** mupen64plus + GLideN64 runs most titles at their
  native cap (Mario 64 locked 30, GoldenEye/Conker playable when overclocked).
- **The frontend owns the GL context.** A libretro core renders the game into an FBO the
  frontend provides — so the game frame is a **GLES texture in our own context**. Screen-blend
  compositing and (later) luma sampling happen on-GPU with no readback tax.

RetroArch-shader-only was rejected: slang shaders have no audio-FFT input, which would kill
the audio reactivity that is the soul of the app.

---

## The mental model: three independent inputs

The MVP's defining property is that its three inputs are fully decoupled — none feeds another:

```
  N64 core ─────► game texture ───┐
  USB line-in ──► FFT/bands/beat ─┼─► fusion → composite shader ─► display
  pi/bridge.py ─► params ─────────┘
```

- **Game** = silent visual wallpaper. The core's audio batch is **discarded** (game is visual-only).
- **Live audio** from a USB audio interface drives reactivity (NOT game audio, NOT mic/file/demo).
- **Hardware bridge** (`pi/bridge.py`, unchanged) drives tunable params over WebSocket.

There is **no luma coupling and no game-audio coupling** in the MVP. The bgAscii layer (which
is the only consumer of game-frame luma) is off by default and deferred.

---

## Module map (Rust)

| Module | Responsibility | Ports from |
|---|---|---|
| `main.rs` | SDL2 GLES3 window, the frame loop, key handlers | `sketch.js` loop |
| `libretro.rs` | `libloading` + `rust-libretro-sys`; env callback; `SET_HW_RENDER`; owns the game-frame FBO; **discards audio** | new |
| `audio.rs` | `cpal` capture from the USB device → ring → `rustfft` → spectrum/bands/beat | analysis half of `audio.js` |
| `fusion.rs` | figure/rain/wave/glitch; fills `char_idx`/`bright16`/`cga_idx` | `fusion.js` (verbatim) |
| `renderer.rs` | `glow`: atlas tex, RG16UI + R8 data textures, composite shader, 1 draw | `renderer.js` |
| `bridge.rs` | tokio-tungstenite **client** → `ws://localhost:9001`; clamp+write params; send audio @16Hz | `hardware-bridge.js` |
| `config.rs` | consts + `Params` struct + `RANGES` | `config.js` |
| `ascii_art.rs` | static figure data | `ascii-art.js` |

---

## Frame loop (with the glue that lives outside fusion)

```rust
loop {
    poll_events();                          // quit + key handlers (P/S/F/V…)
    bridge.drain_into(&mut params);         // apply queued hw / hw_event messages

    core.retro_run();                       // emu at CORE fps; renders into our FBO; AUDIO BATCH DISCARDED

    accum += dt;                            // fixed-timestep LOGIC @ 30 Hz
    while accum >= 1.0 / 30.0 {
        audio.update();                     // cpal ring → FFT → spectrum/bands/beat
        // per-frame glue from sketch.js (NOT in fusion):
        params.chroma_beat_current =
            params.chroma_beat_current * 0.85
            + audio.beat_intensity * params.chroma_beat * 0.15;
        fusion.update(&audio, cols, rows);  // fills the three arrays
        accum -= 1.0 / 30.0;
    }

    renderer.upload(&fusion.char_idx, &fusion.bright16, &fusion.cga_idx);
    renderer.render(&params, game_tex);     // composite, single draw call
    swap();
    bridge.maybe_send_audio(&audio);        // {beatActive,beatIntensity,bands} @~16Hz → LEDs
}
```

**Timing model:** emulation + render run at the core's native fps (smooth game, correct
pacing); the **visual logic runs on a fixed 30 Hz tick**. This preserves every tuned constant
in `fusion.js` (decay rates, `figReseedFrames`, beat cooldowns, the `1/TARGET_FPS` step)
without retuning for 60 Hz. The `_chromaBeatCurrent` envelope is the one piece of per-frame
state that lives in `sketch.js` rather than fusion — it must ride along in the logic tick or
beat-reactive chroma dies.

---

## The composite (replaces the CSS `mix-blend-mode: screen`)

In the browser the "ASCII glows over the game" effect is done by the **compositor**: the canvas
has `mix-blend-mode: screen` over the `#v2-bg-image` div. Natively there is no compositor, so the
screen blend folds into the fragment shader — still one draw call:

```glsl
// after the ASCII `color` is computed (post-scanline):
vec3 game = texture(u_gameTex, vec2(v_uv.x, 1.0 - v_uv.y)).rgb; // GLideN64 = bottom-left origin → flip v
game *= u_bgOpacity;                                            // bgFx filters deferred
fragColor = vec4(u_bgEnabled
    ? 1.0 - (1.0 - game) * (1.0 - color)                       // screen blend
    : color, 1.0);                                             // B-key off → ASCII on black
```

The vertex + fragment shaders are already `#version 300 es` in `renderer.js`, so they port to
the Pi's GLES3 (v3d) near-verbatim.

---

## Visualization modes (the G key)

`Params::viz_mode` selects what fills the glyph grid; the **G** key cycles it. Both modes share
the entire CRT post chain (atlas sampling, chromatic aberration, scanline, phosphor) — only the
*source* of each cell's glyph + brightness differs, via a `u_mode` branch in the one fragment
shader.

- **0 — Fusion (default).** The figure/rain/wave/glitch engine (`fusion.rs`) fills the data
  textures, composited *over* the game via screen blend (above).
- **1 — Edge.** The **exact same fusion animation, masked by the game's edges**. Fusion still
  fills the data textures every frame; the shader fetches each cell's glyph/brightness/color as
  usual, then multiplies brightness by an edge factor: a cell-scale Sobel on `u_gameTex` (sample
  offsets = `1/gridSize`, so the mask matches the glyph grid, not per-texel noise) →
  `clamp((mag - u_edgeThreshold) * u_edgeGain, 0, 1)`. So the rain/wave/glitch/figure only show
  along the on-screen shapes, carving the game's contours out of the animation, screen-blended
  over the live game via the same composite as Fusion mode (**B** toggles the underlay off).
  Audio-reactive: the `edge_beat_current` envelope (`main.rs`) bumps `edge_gain` on beats so more
  of the animation breaks through, and bass drives the shared chroma aberration. **Zero GPU→CPU
  readback** — the game frame is already a texture in our context. With no game frame bound,
  `u_gamePresent = 0` → the mask is 0 (nothing shows).

## Audio: cpal → rustfft, faithfully

To match the tuned feel of `bands`/`beat`, reproduce two details of the browser `AnalyserNode`:

1. **Blackman window** before the FFT.
2. **0.65 exponential smoothing on magnitudes**, applied *before* the dB conversion.

Pipeline: window → `rustfft`(1024) → `mag = 0.65*prev + 0.35*|FFT|` → `dB = 20·log10(mag)` →
normalize `(dB + 90) / 80` clamp [0,1] → 512 bins. Then `_computeBands` and `_detectBeat`
(43-frame bass history, threshold 1.25, 300 ms cooldown) port line-for-line. `cpal` enumerates
input devices; select the USB interface by name.

---

## Hardware bridge: the direction wrinkle

`pi/bridge.py` is the WebSocket **server** (`ws://localhost:9001`); the browser was the client.
So `bridge.rs` is a **client** (`tokio-tungstenite`) and `pi/bridge.py` stays unchanged.

It must faithfully replicate `setV2Param`:
- clamp to `RANGES`;
- treat keys ending `Enabled` as booleans;
- reject NaN / ∞;
- round when both bounds are integers and span > 1;
- enforce `rainSpeedMin < rainSpeedMax − 0.05`.

And send `{type:"audio", beatActive, beatIntensity, bands}` back at ~16 Hz to drive the LEDs.

**Button remap needed:** the two GPIO buttons fire `next_bg` and `toggle_bg_ascii`. With the
playlist gone (the game *is* the background) and bgAscii deferred, `next_bg` is meaningless.
Repurpose both (e.g. cycle phosphor / toggle scanline) — one-line changes in `pi/bridge.py`'s
`BUTTON_CONFIG` and the `bridge.rs` event map.

---

## Glyph atlas: baked, not rasterized

Variable-font axis selection (Orbitron weight 800) is fiddly in Rust. Instead, bake from the
working web app:

- `renderer._atlasCanvas.toDataURL()` → **`atlas.png`** (load as the R8 texture);
- **`atlas.json`** = `{cellW, cellH, tileW, tileH, atlasCols, atlasRows, charset[]}` (feeds the
  shader uniforms + builds the `char→index` map).

Zero font code in the MVP, pixel-identical glyphs. Add runtime rasterization later only if
font/size needs to change at runtime.

---

## Cut / deferred from the MVP

| Cut | Why |
|---|---|
| bgFx CSS filters | separable-gaussian blur is its own task; revisit as shader passes |
| bg-fx DOM panel | no DOM natively; params come from the bridge |
| bg-folder playlist | replaced by the game |
| startup terminal screen | static splash instead |
| bgAscii layer + luma readback | off by default; only path wanting GPU→CPU readback |
| demo / file / mic audio | USB line-in is the source |

---

## Risk ranking

1. **HW-render / GLideN64 context handshake — high.** Concentrated entirely in Phase 0.
2. **cpal USB device selection + FFT-feel match — medium.**
3. **bridge clamp parity + fusion/renderer transcription — low.** Visually diffable against the
   live web app.

## Phased roadmap

- **Phase 0** — de-risk spike (see `PHASE0_SPIKE.md`). ROM → FBO texture → quad, full speed, on Pi 5.
- **Phase 1** — renderer port: baked atlas + data textures + composite shader over the game texture.
- **Phase 2** — fusion port: figure/rain/wave/glitch + the 30 Hz logic tick + chroma envelope.
- **Phase 3** — audio: cpal USB capture → rustfft → bands/beat.
- **Phase 4** — bridge: `bridge.rs` client + button remap.
- **Phase 5** — kiosk: Pi 5 autostart, overclock, fullscreen.

## Cargo dependencies (full MVP)

`sdl2`, `glow`, `libloading`, `rust-libretro-sys`, `cpal`, `rustfft`, `tokio`,
`tokio-tungstenite`, `serde`, `serde_json`. (The Phase 0 spike needs only the first four.)
