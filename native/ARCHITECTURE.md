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
  GPIO panel ───► params ─────────┘
```

- **Game** = silent visual wallpaper. The core's audio batch is **discarded** (game is visual-only).
- **Live audio** from a USB audio interface drives reactivity (NOT game audio, NOT mic/file/demo).
- **Hardware panel** (MCP3008 knobs + GPIO buttons, read in-process by `hw_input.rs`) drives
  tunable params. See [HARDWARE_SETUP.md](HARDWARE_SETUP.md) for wiring and mapping.

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
| `renderer.rs` | `glow`: atlas tex, RG16UI + R8 data textures, edge-masked composite shader, 1 draw | `renderer.js` |
| `post.rs` | offscreen scene FBO + full-screen glitch/warp post-process pass | new |
| `ui.rs` | debug slider overlay for live param tuning (dev tool) | `bg-fx-panel.js` |
| `hw_input.rs` | MCP3008 SPI knobs + GPIO buttons/LEDs (Pi); no-op stub elsewhere | `hardware-bridge.js` |
| `input.rs` | SDL2 raw joystick → lock-free table → libretro `input_state` (game controls) | new |
| `config.rs` | consts + `Params` struct | `config.js` |
| `ascii_art.rs` | static figure data | `ascii-art.js` |

---

## Frame loop (with the glue that lives outside fusion)

```rust
loop {
    poll_events();                          // quit + key handlers (P/S/F/V…)

    accum += dt;                            // fixed-timestep LOGIC @ 30 Hz
    while accum >= 1.0 / 30.0 {
        audio.update();                     // cpal ring → FFT → spectrum/bands/beat
        hw.poll(&mut params, audio.bands());// knobs → params; buttons → actions; bands → LEDs
        // per-frame glue from sketch.js (NOT in fusion):
        params.chroma_beat_current =
            params.chroma_beat_current * 0.85
            + audio.beat_intensity * params.chroma_beat * 0.15;
        fusion.update(&audio, cols, rows);  // fills the three arrays
        accum -= 1.0 / 30.0;
    }

    core.retro_run();                       // emu at CORE fps; renders into our FBO; AUDIO BATCH DISCARDED

    renderer.upload(&fusion.char_idx, &fusion.bright16, &fusion.cga_idx);
    renderer.render(&params, game_tex);     // composite, single draw call
    swap();
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

## Full-screen glitch FX (post-process)

A second pass (`post.rs`) distorts the whole composited view. The renderer draws the scene
(game + ASCII) into an offscreen FBO instead of the screen; `PostFx::render` then samples that
texture full-screen and applies momentary, destructive distortion — horizontal slice tears, block
jitter, sinusoidal warp, RGB channel split, and noise flicker. The debug slider overlay (`ui.rs`)
is drawn *after* this pass so it stays readable.

The effect is driven by a **burst envelope** (`glitch_fx_env`) maintained in `main.rs`: it decays
each 30 Hz tick and is randomly kicked to a high value (more likely on a strong beat), with a fresh
random `glitch_fx_seed` per burst. At `env == 0` the pass is a 1:1 passthrough. Tunables:
`glitch_fx_intensity` (displacement scale), `glitch_fx_chance` (burst frequency), `glitch_fx_decay`
(burst length).

## Audio: cpal → rustfft, faithfully

To match the tuned feel of `bands`/`beat`, reproduce two details of the browser `AnalyserNode`:

1. **Blackman window** before the FFT.
2. **0.65 exponential smoothing on magnitudes**, applied *before* the dB conversion.

Pipeline: window → `rustfft`(1024) → `mag = 0.65*prev + 0.35*|FFT|` → `dB = 20·log10(mag)` →
normalize `(dB + 90) / 80` clamp [0,1] → 512 bins. Then `_computeBands` and `_detectBeat`
(43-frame bass history, threshold 1.25, 300 ms cooldown) port line-for-line. `cpal` enumerates
input devices; select the USB interface by name.

---

## Hardware panel: in-process GPIO, no bridge

The `v2/` web app needed a separate bridge process (`pi/bridge.py`, a WebSocket server)
because a browser cannot touch SPI or GPIO. The native binary has no such restriction, so
the bridge is gone entirely: `hw_input.rs` opens SPI0/CE0 and the GPIO pins itself via
`rppal` and is polled once per 30 Hz logic tick. A knob turn is an SPI read followed by a
plain field write into `Params` — no IPC, no JSON, no second process. (`pi/bridge.py` remains
in the repo only for the `v2/` browser app; the native binary never talks to it.)

What `poll()` does each tick:
- **Knobs** — read each mapped MCP3008 channel (~70 µs total at 1 MHz), gate through a
  dead-zone (Δ > 0.005 full-scale, mirroring bridge.py), smooth with a first-order low-pass
  (`Params::hw_knob_alpha`, default 0.35), clamp to the entry's range, write the field.
  Params keep their defaults until a knob physically moves — no slam at boot.
- **Buttons** — drain edge events from a background interrupt thread (mpsc), 50 ms software
  debounce, fire the mapped action on press.
- **LEDs** — set each of the six band LEDs high/low from the current audio band levels.

The two GPIO buttons are remapped from their v2 events (`next_bg` / `toggle_bg_ascii`, both
meaningless natively — the game *is* the background and bgAscii is deferred): GPIO 23 cycles
the phosphor preset (P-key analog), GPIO 24 toggles the game underlay (B-key analog).

Off-Pi (or on any GPIO init failure) the factory falls back to a no-op stub, same pattern as
the audio source — the app runs with keyboard control only. The mapping tables (`KNOBS`,
`BUTTONS`, `LEDS`) at the top of `hw_input.rs` are the single edit point for rewiring;
wiring, pinout, and remapping instructions live in [HARDWARE_SETUP.md](HARDWARE_SETUP.md).

---

## Controller input: raw joystick, not SDL GameController

The core polls input each frame through the frontend's `input_state` callback. `input.rs` answers
it from a lock-free table: the main thread reads SDL once per frame (`Gamepads::poll`) and publishes
into per-port atomics; the core's emu thread reads them back. Buttons are reported as a **RetroPad**
and mupen64plus-next applies its own RetroPad→N64 mapping on top.

We read the **raw `Joystick`**, not SDL's `GameController` abstraction. SDL's built-in mapping for
the low-cost N64 USB pads (`SWITCH CO.,LTD.` / kiwitata, VID:PID `0e6d:111d`) guesses the layout
wrong — dead Start, unmapped C-buttons, the analog stick on the wrong axes. Binding raw indices
gives an exact mapping. The indices for that pad are named constants at the top of `input.rs`; to
support a different pad, capture its indices with `cargo run --example input_probe` and edit them.

Mapping for the reference pad (raw index → N64 function → RetroPad id the core reads):

| N64 | raw | RetroPad |
|---|---|---|
| A | btn 2 | **B** (id 0) |
| B | btn 1 | **Y** (id 1) |
| Start | btn 12 | START |
| Z | btn 6 | L2 |
| L / R | btn 4 / 5 | L / R |
| C up/down/left/right | btn 9/3/0/8 | right analog stick (the core's default C source) |
| D-pad | hat 0 | UP/DOWN/LEFT/RIGHT |
| Analog stick | axes 0/1 | left analog |

mupen64plus-next's RetroPad→N64 map is non-standard: **N64 A ← RetroPad B, N64 B ← RetroPad Y**
(RetroPad A/X aren't read), C-buttons ← the right analog stick. That's why the physical N64 A/B
buttons must be reported on RetroPad B/Y, not A/B.

**Hot-plug:** controllers open/close only in `Gamepads::handle_event`, fed every SDL event by the
main loop. `JoyDeviceAdded` carries a *joystick index* (→ `open`); `JoyDeviceRemoved` carries an
*instance id* (→ matched against open pads) — distinct despite both being `u32`. SDL emits an ADDED
event for each already-connected pad on the first pump, so startup and hot-plug share one path.
Ports are stable (`[Option<Joystick>; 4]` indexed by port): another pad unplugging never shuffles a
player's port, and a disconnect clears that port's table so a button held at unplug can't latch.

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

## mupen64plus-next on Pi 5 — core configuration

On the Raspberry Pi 5 (Cortex-A76, GLES3 via Mesa/V3D), mupen64plus-next is built with
`platform=rpi5_64_mesa FORCE_GLES3=1` to get the correct CPU tuning (`-mcpu=cortex-a76`) and
Mesa GLES3 instead of the legacy VideoCore path. The resulting `.so` lives in `native/cores/`.

The `get_variable()` override in `frontend.rs` forces these core options (all others fall through
to the core's own default):

| Variable | Value | Reason |
|---|---|---|
| `mupen64plus-cpucore` | `dynamic_recompiler` | Aarch64 JIT — the default varies by build |
| `mupen64plus-ThreadedRenderer` | `False` | Would spawn a renderer thread that contends with our single GL context (FBO publish / `context_reset` run on the main thread) |
| `mupen64plus-rdp-plugin` | `angrylion` | Software RDP; see the GLideN64 note below |
| `mupen64plus-rsp-plugin` | `cxd4` | HLE RSP forces a paraLLEl-RSP fallback under Angrylion (core warns); paraLLEl-RSP's JIT `mprotect(PROT_EXEC)` fails on Debian Trixie, so cxd4 (pure interpreter) is the only LLE RSP that works here |
| `mupen64plus-angrylion-multithread` | `all threads` | Spread the software RDP across all 4 cores (3 idle single-threaded) |
| `mupen64plus-angrylion-sync` | `Low` | Relax inter-thread sync for speed; the game is a backdrop, so the small accuracy cost is acceptable |

The combination is aarch64 dynarec CPU + cxd4 software RSP + multithreaded Angrylion software RDP.
Frames arrive via `video_refresh` (software path) as XRGB8888 — the GPU does no emulation work.

**Why not the GPU path (GLideN64).** GLideN64 is the core's own "Performance" RDP and would offload
rasterization to the V3D GPU via the hw-render FBO (the zero-readback path this frontend was
designed around), reached with `rdp-plugin=gliden64` + `rsp-plugin=hle`. It was tested and **does
not work with the current prebuilt core (`2.8-GLES3 98c1b0d`)**: GLideN64 initializes cleanly —
hw-render context, the 640×480 FBO, HLE RSP, and `plugin_start_gfx` all succeed — but the **first
display list aborts** in `TextureCache::_addTexture` with `free(): invalid pointer` (confirmed by
backtrace: `drawTriangles → _updateTextures → TextureCache::update → _addTexture → free`). This is
a heap-corruption bug in this GLideN64 build on aarch64/GLES3 Mesa, on the very first texture add —
it is **not** option-tunable (`EnableTextureCache=False` does not prevent it; that flag controls the
hi-res disk cache, not the in-memory `TextureCache`). Re-enabling GPU rendering — the real unlock
for playable N64 performance — requires a **newer or rebuilt core**, not a frontend change. The
`parallel-rdp`/`parallel` Vulkan back-ends are not usable either — V3D exposes GLES, not Vulkan.

## Known limitations & future work

These are the deferred items and rough edges, kept here (not as inline `TODO`s) so the code
stays feature-focused.

**FBO depth/stencil.** `build_game_fbo` attaches only `DEPTH24`, matching the cores tested so far
(`stencil=false`). A core that requests `hw.stencil=true` (GLideN64 can, for some N64 framebuffer
effects) would need `DEPTH24_STENCIL8` + `DEPTH_STENCIL_ATTACHMENT`.

**Audio input device selection.** `audio.rs` opens only cpal's default input device — no
enumeration, no CLI flag. Selecting a specific USB interface by name is future work.

**LED dimming.** The GPIO LED bank (`hw_input.rs`) is threshold on/off only; the v2 bridge did
PWM brightness. rppal's software PWM (`OutputPin::set_pwm_frequency`) is the path to parity.

**Second MCP3008.** `hw_input.rs` opens SPI0/CE0 only; the `KnobEntry.chip` field exists for a
second chip on CE1 but is not yet read. Needed once more than 8 analog channels are wired.

**Unmapped knob channels.** MCP3008 CH2 and CH5 (v2's `bgFxHueShift` / `bgAsciiLevel`) have no
native param and are no-ops. Candidates for remap: `edge_gain` / `edge_threshold` /
`glitch_fx_master`.

**Knob soft-takeover.** A knob's first move past the dead-zone jumps the param to the knob's
absolute position, discarding any keyboard/UI-set value. A pickup mode (knob must cross the
current value before grabbing it) would avoid the jump.

**Kiosk deployment.** Pi 5 autostart, overclock, and boot-to-fullscreen are not yet scripted.

## Cargo dependencies

Current: `sdl2`, `glow`, `libloading`, `cpal`, `rustfft`, `image`, `serde`, `serde_json`
(+ `rppal` on Linux for the Pi's SPI/GPIO — `>= 0.19` required for the Pi 5's RP1 I/O
controller). The libretro ABI is transcribed by hand in `libretro.rs` rather than via a
generated-bindings crate.
