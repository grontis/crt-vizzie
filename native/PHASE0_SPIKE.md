# Phase 0 spike — N64 core → frontend-owned texture → screen, on a Pi 5

The native port has exactly one part with real unknowns: getting a hardware-rendered N64 core
(GLideN64) to render into an FBO **we** own, in a GLES3 context **we** created, on the Pi's v3d
driver — a path documented to produce black screens and segfaults when the handshake is wrong.

This spike proves that path and nothing else. If it goes green, the rest of the project is the
mechanical transcription of code already written and debugged once in `v2/`. If it can't be made
green on the Pi 5, we learn that *before* porting anything.

> Scope discipline: this spike contains **no** audio, **no** fusion/ASCII, **no** bridge, **no**
> baked atlas. Just: load core → run game → sample its frame to a full-screen quad.

---

## 1. Acceptance criteria (the go/no-go gate)

On the actual Raspberry Pi 5, in a fullscreen SDL2 GLES3 window:

- **A1 — Game visible.** A loaded N64 ROM renders and is visible as a textured full-screen quad,
  correct orientation (not upside-down), correct aspect, no tearing of the image content.
- **A2 — Full speed.** Sustained at the core's native fps (≈60 for NTSC) — measured mean
  `retro_run + render + swap` frame time **< 16.6 ms** over a 60-second window, no creeping growth.
- **A3 — Stable.** Runs ≥ 5 minutes with no crash, no GL error spam, no memory growth, no FBO
  re-allocation churn. Survives a context reset (alt-tab / VT switch if applicable).

A1 + A2 + A3 green ⇒ **GO** on the whole native direction.

**Explicit non-goals (do not implement in the spike):** ASCII rendering, audio capture/FFT,
WebSocket bridge, baked glyph atlas, scanlines/phosphor/chroma, input beyond quit + one debug key,
save states, multiple ROMs, resize handling beyond initial fullscreen.

---

## 2. Prerequisites

### Hardware / OS
- Raspberry Pi 5 (the acceptance target). Overclock to 3.0 GHz later for demanding titles; not
  needed for the spike if you test with a light game (e.g. Mario 64).
- 64-bit Raspberry Pi OS (Bookworm), desktop or console+KMS. Ensure the **v3d** GLES driver is
  active (`glxinfo`/`eglinfo` shows V3D; `vcgencmd` GPU mem reasonable).

### Toolchain
- Rust stable (`rustup`), aarch64.
- SDL2 dev libs: `sudo apt install libsdl2-dev`.
- GLES headers are provided by the system; `glow` loads entry points at runtime via SDL.

### The core (this is the part that bites)
- You need **`mupen64plus_next_libretro.so` built for aarch64 with a GLES3 GL profile** — a
  desktop-GL build will not match our GLES3 context and is a common cause of the black screen.
- Get it one of two ways:
  - **Build:** clone `libretro/mupen64plus-libretro-nx`, build with the Pi/GLES platform target
    (the makefile exposes `platform=` / `FORCE_GLES3=1`; produce a GLES3 GLideN64 build). Verify
    intent, not assumption — confirm the resulting `.so` is GLES3.
  - **Borrow:** copy the core from a working RetroArch install on the same Pi
    (`~/.config/retroarch/cores/` or `/usr/lib/libretro/`). If RetroArch runs N64 on this Pi, that
    `.so` already speaks the right GLES3 to v3d — the ideal spike core.
- N64 needs **no BIOS**. One less variable than PS2.

### A ROM
- Any N64 ROM you legally own; a small homebrew/intro ROM iterates fastest. **Do not commit ROMs.**
- Note `retro_get_system_info().need_fullpath`: mupen64plus-next typically wants the **bytes**
  loaded into `retro_game_info.data` (need_fullpath = false), but handle both — read the flag and
  either pass the path or `mmap`/read the file into `data`/`size`. Verify against the loaded core.

### Dev-machine shortcut (cross-platform — recommended)
Develop on a desktop and deploy to the Pi; only the GLES3 context source and the core binary
differ. The acceptance gate stays the Pi (perf + v3d quirks), but ~95% of the handshake logic can
be written and debugged off-Pi.

- **Linux desktop:** ES3 context (`SDL_GL_CONTEXT_PROFILE_ES`, 3.0) + a GLES3 core build. Mesa
  emulates GLES3 fine.
- **Windows:** GLES3 via **ANGLE** (ship `libEGL.dll` + `libGLESv2.dll`; set
  `SDL_OPENGL_ES_DRIVER=1`) so the same `#version 300 es` shaders + `RETRO_HW_CONTEXT_OPENGLES3`
  request run unchanged on the Pi. Full setup in [`WINDOWS_DEV.md`](./WINDOWS_DEV.md).

**ANGLE-vs-desktop-GL decision (bites at M3, not before):** target GLES3 everywhere via ANGLE for
a single shader/codepath. *If* the available Windows core only hardware-renders through desktop GL,
fall back to desktop GL on Windows + GLES3 on the Pi — a `#version` swap and a context-type `cfg`
branch. M0–M2 are identical either way; decide once you have the Windows core in hand.

---

## 3. Cargo.toml (spike only)

```toml
[package]
name = "crt-vizzie-spike"
version = "0.0.0"
edition = "2021"

[dependencies]
sdl2 = { version = "0.37", features = ["bundled"] }   # or system SDL2; drop "bundled" to use libsdl2-dev
glow = "0.13"
libloading = "0.8"
rust-libretro-sys = "*"   # pin once you see the version; provides the libretro FFI types/enums

[profile.dev]
opt-level = 1             # the core runs unbearably slow in a fully-unoptimized debug build
```

`rust-libretro-sys` gives you `retro_hw_render_callback`, the `RETRO_ENVIRONMENT_*` / `RETRO_HW_*`
constants, `retro_system_av_info`, `retro_game_info`, and the function-pointer typedefs — so you
don't hand-transcribe `libretro.h`. Treat its struct layouts as the source of truth and verify the
two or three sentinel values called out below against it.

---

## 4. The libretro symbols to load

Resolve these from the `.so` with `libloading` (all `extern "C"`):

```
retro_set_environment(cb)        retro_set_video_refresh(cb)
retro_set_audio_sample(cb)       retro_set_audio_sample_batch(cb)
retro_set_input_poll(cb)         retro_set_input_state(cb)
retro_init()                     retro_deinit()
retro_get_system_info(*info)     retro_get_system_av_info(*info)
retro_load_game(*game) -> bool   retro_unload_game()
retro_run()                      retro_reset()
retro_api_version() -> u32       // assert == 1
```

Call order (the dance that matters):

```
load .so → resolve symbols
retro_set_environment(env_cb)          // MUST be set before retro_init; core probes caps here
retro_set_video_refresh / audio_* / input_*   // set all five; audio/input can be near-no-ops
retro_init()
retro_get_system_info(&sysinfo)        // read need_fullpath
retro_load_game(&game)                 // core calls SET_HW_RENDER from in here
   → (env_cb handles SET_HW_RENDER: store struct, install get_current_framebuffer + get_proc_address)
retro_get_system_av_info(&avinfo)      // geometry.max_width/height, timing.fps, sample_rate
create FBO (color tex @ max_w×max_h + depth renderbuffer)
hw.context_reset()                     // NOW the core builds its GL resources
loop { retro_run(); sample FBO → quad; swap }
```

---

## 5. Environment callback — the must-handle commands

Most `RETRO_ENVIRONMENT_*` commands can return `false` (unsupported). These few must be handled or
mupen64plus-next won't boot or won't render. Match on `cmd`:

| Command | Action |
|---|---|
| `SET_HW_RENDER` | **Critical.** `data` is `*mut retro_hw_render_callback`. Copy it. Require `context_type == RETRO_HW_CONTEXT_OPENGLES3`; set `version_major=3, version_minor=0`. The core has filled `context_reset`, `context_destroy`, `depth`, `stencil`, `bottom_left_origin`, `cache_context`. **You** write `get_current_framebuffer` and `get_proc_address` into the struct. Return `true`. |
| `GET_HW_RENDER_INTERFACE` | return `false` (GLideN64 doesn't need it here). |
| `SET_PIXEL_FORMAT` | accept `XRGB8888`; return `true`. (HW path ignores it but the core asks.) |
| `GET_SYSTEM_DIRECTORY` | return `true`, write a pointer to a valid, readable dir string. |
| `GET_SAVE_DIRECTORY` | return `true`, a writable dir. (Core may scribble here on init.) |
| `GET_LOG_INTERFACE` | return `true`, hand back a `retro_log_callback` with a printf-style fn. **Wire this first — it's your only window into why the core is unhappy.** |
| `GET_CAN_DUPE` | write `true`; return `true`. |
| `SET_PERFORMANCE_LEVEL` | accept; return `true`. |
| `GET_VARIABLE` | return `false` (core uses option defaults — GLideN64 RDP). Fine for the spike. |
| `SET_VARIABLES` / `SET_CORE_OPTIONS*` | return `true`, ignore contents. |
| `GET_VARIABLE_UPDATE` | write `false`; return `true`. |
| `SET_GEOMETRY` / `SET_SYSTEM_AV_INFO` | re-read geometry if it changes; the spike can just log it. |
| everything else | return `false`. |

The two function pointers you install:

```rust
extern "C" fn get_current_framebuffer() -> usize { OUR_FBO.load(Ordering::Acquire) as usize }
extern "C" fn get_proc_address(sym: *const c_char) -> *const c_void {
    // SDL_GL_GetProcAddress(sym) — the core resolves its GL entry points through OUR loader,
    // so it shares our exact context.
}
```

`get_current_framebuffer` returns the GL name of our FBO and **may be called every frame** — the
core calls it inside `retro_run`, so it must always reflect the current FBO id.

---

## 6. The FBO (where black screens are born)

Create once, after `retro_get_system_av_info`, sized to `geometry.max_width × max_height`:

- **Color**: a `GL_RGBA8` texture (`NEAREST`/`CLAMP_TO_EDGE`) — this is what we sample for the quad.
- **Depth**: if `hw.depth`, attach a `GL_DEPTH_COMPONENT24` (or `GL_DEPTH24_STENCIL8` if
  `hw.stencil`) **renderbuffer**. GLideN64 needs depth — omitting it is a classic black screen.
- `glCheckFramebufferStatus(GL_FRAMEBUFFER) == GL_FRAMEBUFFER_COMPLETE` — assert this loudly.

The actual rendered region is the **bottom-left `width × height`** sub-rect reported by the
video-refresh callback (see §7), not the whole texture. Sample with that sub-rect + v-flip
(`bottom_left_origin`).

---

## 7. Per-frame: run, capture geometry, draw

`video_refresh` callback — for HW frames the core passes a sentinel, not pixels:

```rust
extern "C" fn video_refresh(data: *const c_void, w: u32, h: u32, _pitch: usize) {
    // data == RETRO_HW_FRAME_BUFFER_VALID (a sentinel ptr; verify its value in rust-libretro-sys).
    // We don't touch `data`; we only record the valid region the core just drew:
    CUR_W.store(w, Release); CUR_H.store(h, Release);
}
```

Each frame:

```
// 1. Hand the core a clean slate — REQUIRED or you get a black screen / corrupt state:
glBindVertexArray(0); glUseProgram(0);
glBindBuffer(ARRAY_BUFFER, 0); glBindBuffer(ELEMENT_ARRAY_BUFFER, 0);
glBindFramebuffer(FRAMEBUFFER, 0); glBindTexture(TEXTURE_2D, 0);
glDisable(DEPTH_TEST); glDisable(BLEND); /* reset what your quad pass enabled last frame */

core.retro_run();          // core binds OUR fbo via get_current_framebuffer() and renders N64 → it

// 2. Our pass: default framebuffer, sample the FBO color texture sub-rect with v-flip
glBindFramebuffer(FRAMEBUFFER, 0);
glViewport(0,0, win_w, win_h);
useProgram(quad_prog);
bindTexture(color_tex);
// uv sub-rect: u∈[0, CUR_W/max_w], v flipped over [0, CUR_H/max_h]
drawArrays(TRIANGLE_STRIP, 0, 4);

swapWindow();
```

The unbind step before `retro_run` is the single most common omission. The libretro contract is
explicit: leave no VAO/VBO/program/texture/FBO bound when you hand control to the core.

**Pacing (A2):** call `retro_run` once per `avinfo.timing.fps` period. If display refresh equals the
core fps (60 Hz on Pi, NTSC N64) just run once per swap with vsync on. Otherwise gate with an
accumulator. Print a rolling mean frame time on a debug key.

---

## 8. Build milestones (each independently verifiable)

Stop and confirm each before moving on — a green M0–M4 makes M5's black screen (if any) trivially
bisectable.

| # | Milestone | Pass check |
|---|---|---|
| **M0** | SDL2 GLES3 window; clear to magenta; swap | solid magenta fullscreen on the Pi |
| **M1** | `libloading` opens the `.so`; resolve all symbols; `retro_api_version()==1`; print `retro_get_system_info` | core name/version logged, no missing-symbol panic |
| **M2** | env callback handles §5; `GET_LOG_INTERFACE` wired; `retro_init()` | core init logs flow through your logger, no crash |
| **M3** | `retro_load_game(rom)`; `SET_HW_RENDER` handled; FBO+depth built; `glCheckFramebufferStatus` complete; `hw.context_reset()` called; print av_info | "FRAMEBUFFER_COMPLETE" + geometry/fps/sample_rate logged |
| **M4** | one `retro_run()` with the pre-unbind; capture `video_refresh` w/h | no crash; w/h are sane (e.g. 320×240 or upscaled); GL error log clean |
| **M5** | textured-quad pass sampling the FBO (sub-rect + v-flip) | **GAME VISIBLE, right-side-up** ← A1 |
| **M6** | core-fps loop + pacing; run 5 min; rolling frame-time readout | < 16.6 ms mean, stable ← A2 + A3 |

---

## 9. Failure playbook

**Black screen (the big one) — check in this order:**
1. Core is a **GLES3** build, not desktop GL. (Borrow RetroArch's working Pi core to isolate this.)
2. `SET_HW_RENDER` returned `true` and you set `context_type = OPENGLES3`, version 3.0.
3. `glCheckFramebufferStatus` is `COMPLETE`, and a **depth** renderbuffer is attached.
4. `hw.context_reset()` was actually invoked, *after* the FBO exists and the context is current.
5. You **unbind all GL state before `retro_run`** every frame.
6. `get_current_framebuffer` returns the real FBO id (not 0, not stale).
7. v-flip: you see content but upside-down ⇒ `bottom_left_origin` handling — flip the quad's v.

**Segfault on the Pi (known mupen64plus-nx territory):**
- Give `GET_SYSTEM_DIRECTORY` / `GET_SAVE_DIRECTORY` real, existing, writable paths.
- Confirm enough GPU memory; try the core option for FB emulation if you later enable options.
- Ensure single-threaded GL (don't drive `retro_run` off the main/GL thread).
- Rule out a debug build choking — use `opt-level >= 1`.

**Core won't load the ROM:** honor `need_fullpath` — pass the path *or* the loaded bytes
accordingly; pass an absolute path.

**Stutter but renders:** vsync/pacing mismatch; verify you run `retro_run` at `timing.fps`, not
display rate, and that swap isn't double-throttling.

---

## 10. What "done" unlocks

A green spike means the GL context is shared, the game frame is a sampleable texture in our
context, and the loop runs at speed on the target hardware. From there, Phase 1 swaps the
debug quad shader for the real composite shader (`renderer.js` port) and samples the *same*
`color_tex` as `u_gameTex` — no architectural change, just the visualizer dropped on top.

See [`ARCHITECTURE.md`](./ARCHITECTURE.md) for the full MVP shape.
