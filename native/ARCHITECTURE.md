# crt-vizzie native — architecture

A native **Rust libretro frontend** that runs an N64 emulator core and composites the
crt-vizzie audio-reactive ASCII visualizer over the live game frame, on a Raspberry Pi 5.

This document is the architectural entry point for the native app. For the visual-engine
behaviour being ported, the source of truth remains the `v2/` web app and the root
[`CLAUDE.md`](../CLAUDE.md).

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

The defining property of the design is that its three inputs are fully decoupled — none feeds another:

```
  N64 core ─────► game texture ───┐
  USB line-in ──► FFT/bands/beat ─┼─► fusion → composite shader ─► display
  pi/bridge.py ─► params ─────────┘
```

- **Game** = silent visual wallpaper. The core's audio batch is **discarded** (game is visual-only).
- **Live audio** from a USB audio interface drives reactivity (NOT game audio, NOT mic/file/demo).
- **Hardware bridge** (`pi/bridge.py`, unchanged) drives tunable params over WebSocket.

There is **no luma coupling and no game-audio coupling**. The bgAscii layer (which
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

## The visualization: edge-masked fusion

The app has one visualization: the **fusion animation (`fusion.rs`), masked by the game's edges
and dark/negative space**. Fusion fills the data textures every frame as always; the fragment
shader fetches each cell's glyph/brightness/color, then multiplies brightness by a mask derived
from the game frame:

- **Edge term** — a cell-scale Sobel on `u_gameTex` (sample offsets = `1/gridSize`, so the mask
  matches the glyph grid, not per-texel noise) → `clamp((mag - u_edgeThreshold) * u_edgeGain, 0, 1)`.
- **Dark term** — `u_darkLevel * smoothstep(u_darkThreshold, 0, cm)` on the cell-center luma `cm`,
  so darker cells fill with more animation.

The two combine via `max()`: the rain/wave/glitch/figure show along the on-screen shapes *and*
fill the dark background, carving the bright shapes out of an animated negative space. The result
is screen-blended over the live game (**B** toggles the underlay off for glyphs-on-black).
Audio-reactive: the `edge_beat_current` envelope (`main.rs`) bumps `edge_gain` on beats so more
of the animation breaks through, and bass drives the shared chroma aberration. **Zero GPU→CPU
readback** — the game frame is already a texture in our context. With no game frame bound,
`u_gamePresent = 0` → the mask is 0 (nothing shows).

(An earlier build had a second "full fusion" mode toggled by **G**; that toggle was removed once
this became the single mode. The fusion engine itself stays — it is what the mask reveals.)

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

Zero font code, pixel-identical glyphs. Add runtime rasterization later only if
font/size needs to change at runtime.

---

## Not ported from the web app

| Cut | Why |
|---|---|
| bgFx CSS filters | separable-gaussian blur is its own task; revisit as shader passes |
| bg-fx DOM panel | no DOM natively; params come from the bridge |
| bg-folder playlist | replaced by the game |
| startup terminal screen | static splash instead |
| bgAscii layer + luma readback | off by default; only path wanting GPU→CPU readback |
| demo / file / mic audio | USB line-in is the source |

---

## Known limitations & future work

These are the deferred items and rough edges, kept here (not as inline `TODO`s) so the code
stays feature-focused.

**Pi (GLES3) portability of the software-frame path.** `upload_sw_texture` in `main.rs` uploads
CPU frames with the `glow::BGRA` client format, which is desktop-GL-only. On the Pi's GLES3 this
path must upload `RGBA` and swap R↔B via texture swizzle (`TEXTURE_SWIZZLE_R/B`) under
`cfg(not(windows))`. The hardware-FBO path (GLideN64) is unaffected.

**FBO depth/stencil.** `build_game_fbo` attaches only `DEPTH24`, matching the cores tested so far
(`stencil=false`). A core that requests `hw.stencil=true` (GLideN64 can, for some N64 framebuffer
effects) would need `DEPTH24_STENCIL8` + `DEPTH_STENCIL_ATTACHMENT`.

**Audio input device selection.** `audio.rs` opens only cpal's default input device — no
enumeration, no CLI flag. Selecting a specific USB interface by name is future work.

**LED dimming.** The GPIO LED bank (`hw_input.rs`) is threshold on/off only; software-PWM
brightness is future work.

**Hardware bridge.** A `bridge.rs` WebSocket client (to `pi/bridge.py`, sending audio bands back
at ~16 Hz for the LEDs) is not yet implemented; live params currently come from the local GPIO
path and keyboard.

**Kiosk deployment.** Pi 5 autostart, overclock, and boot-to-fullscreen are not yet scripted.

## Cargo dependencies

Current: `sdl2`, `glow`, `libloading`, `cpal`, `rustfft`, `image`, `serde`, `serde_json`
(+ `rppal` on Linux/Pi for GPIO). The libretro ABI is transcribed by hand in `libretro.rs`
rather than via a generated-bindings crate. The hardware bridge, when built, will add
`tokio` + `tokio-tungstenite`.
