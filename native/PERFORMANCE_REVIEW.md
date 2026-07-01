# native — performance review (Raspberry Pi 5)

A review of the native libretro frontend (`native/src/`) for runtime efficiency on the Pi 5.
No code was changed; this is a findings + recommendations document, ordered roughly by impact.

Scope: the per-frame hot path (emulation, fusion logic, GL upload, composite + post shaders,
the software-frame blit) and the build configuration. Findings are grouped so the cheap,
high-impact wins are at the top.

---

## TL;DR — the five things that matter most

1. **Confirm the Pi runs a `--release` build.** The README documents `cargo run` (debug). A
   debug build runs the fusion CPU loops and FFT at `opt-level = 1`, several× slower than
   release. This is the single biggest, cheapest win. (§1)
2. **Add a tuned `[profile.release]` + `target-cpu=cortex-a76`.** No release profile or CPU
   tuning exists today; the frontend is not getting the `-mcpu=cortex-a76`/LTO treatment the
   core build gets. (§1)
3. **The N64 core config (Angrylion software RDP + cxd4 software RSP) is the dominant cost** and
   it leaves the GPU idle for emulation while the CPU does everything. This is a deliberate
   correctness fallback, but it is also the slowest possible N64 configuration. The long-term
   step-change is getting GPU rendering (GLideN64) and/or a JIT/HLE RSP working. (§2)
4. **The composite fragment shader recomputes an 8-tap Sobel per *fragment* when it is constant
   per *cell*.** Roughly 8 of the ~13 texture fetches per pixel are redundant — the biggest GPU
   waste in our own code. (§3.1)
5. **The post-process pass always runs as a full-screen extra pass, even when no glitch is
   active** (the common case at the default 5% glitch chance). Skipping the offscreen
   indirection when the burst envelope is zero removes a whole full-screen textured pass per
   frame. (§3.2)

---

## 1. Build configuration (highest ROI, lowest effort)

### 1.1 Debug vs release
`README.md` shows the run command as `cargo run -- ...` with no `--release`. `Cargo.toml`
sets:

```toml
[profile.dev]
opt-level = 1
```

`opt-level = 1` was chosen so the *core* is "usable" during development, but it also caps the
**frontend's** optimization. The fusion glitch decay suite is an `O(rows×cols)` double loop with
up to ~5 RNG calls per cell (`fusion.rs:810`), the wave field is 5 `sin()` + a `sqrt()` per cell
(`fusion.rs:914`), and the FFT runs every tick. None of that is auto-vectorized or fully inlined
at `opt-level 1`.

**Action:** deploy with `cargo build --release` (or `cargo run --release`) on the Pi, and update
`README.md` / any `pi-start` script to use the release binary. Verify which binary the kiosk
actually launches.

### 1.2 No `[profile.release]` tuning
There is no `[profile.release]` section, so release uses Cargo defaults
(`codegen-units = 16`, `lto = false`). For a single-binary kiosk where build time is irrelevant
at deploy, the standard wins apply:

```toml
[profile.release]
lto = "thin"          # or true
codegen-units = 1
panic = "abort"       # smaller, slightly faster; no unwinding needed for a kiosk
```

### 1.3 No CPU tuning for the frontend
`.cargo/config.toml` only sets a CMake env var. `ARCHITECTURE.md` notes the *core* is built with
`-mcpu=cortex-a76`, but the Rust frontend gets generic aarch64 codegen. Add (Pi-only — gate so
the Windows dev build is unaffected):

```toml
[target.aarch64-unknown-linux-gnu]
rustflags = ["-C", "target-cpu=cortex-a76"]
```

This lets the FFT, the per-cell trig in the wave layer, and the tight glitch/decay loops use the
A76's NEON/feature set. Measure both `target-cpu=cortex-a76` and `native`.

---

## 2. Emulator core configuration — the dominant cost

`frontend.rs:311` (`get_variable`) forces:

| Variable | Value | Effect |
|---|---|---|
| `mupen64plus-cpucore` | `dynamic_recompiler` | aarch64 JIT (good) |
| `mupen64plus-rdp-plugin` | `angrylion` | **full software RDP** |
| `mupen64plus-rsp-plugin` | `cxd4` | **pure software interpreter RSP** |
| `mupen64plus-ThreadedRenderer` | `False` | threaded renderer off |

**Observation:** this is the most accurate but slowest N64 configuration. Both the RDP and RSP
run entirely on the CPU; the Pi 5's GPU does *no* emulation work. As a side effect, the
architecture's headline advantage — "the game frame is a GLES texture in our own context, zero
GPU→CPU readback" (`ARCHITECTURE.md:21`) — does **not** apply in this config: Angrylion delivers
CPU pixel buffers via `video_refresh`, so the hardware-FBO path is never taken and we run the
software-blit path (`main.rs:453`) every frame instead.

This config exists for good reasons documented in `ARCHITECTURE.md:219` (GLideN64
`TextureCache` heap corruption on GLES3/Mesa, and paraLLEl-RSP's `mprotect(PROT_EXEC)` failure on
Debian Trixie). It is the safe fallback. But for performance it is worth tracking as the #1
ceiling:

- **Biggest potential win:** getting **GLideN64 (GPU RDP)** working would offload rasterization
  to the V3D GPU and engage the zero-readback FBO path the frontend was designed around. The
  `TextureCache` crash is the blocker to solve.
- **Second:** an **HLE or JIT RSP** (instead of cxd4 interpreter). `ARCHITECTURE.md:238` already
  notes the paraLLEl-RSP fix would need a `shm_open` dual-map JIT allocator or a rebuild without
  `HAVE_PARALLEL_RSP`. Note there is also a dead `RSP_HLE` constant (`frontend.rs:307`) that is
  never wired up.
- **Worth testing now (no code risk):** Angrylion in mupen64plus-next has a multithreaded mode.
  The Pi 5 has 4 cores; a single-threaded software RDP leaves 3 idle. Investigate the relevant
  core option (e.g. an `angrylion` multithread / worker-count variable) and benchmark it against
  the current single-threaded path. Also re-test whether `ThreadedRenderer` helps or hurts for
  the software path rather than leaving it hard-coded `False`.

Dead constants to clean up while here: `FB_EMULATION_OFF` (`frontend.rs:304`) and `RSP_HLE`
(`frontend.rs:307`) are defined but unused.

---

## 3. GPU / render pipeline

### 3.1 Per-fragment Sobel is constant per cell — ~8 redundant texture fetches/pixel
In the composite fragment shader (`renderer.rs:159-174`) the edge mask samples the game luma at 8
neighbours of the **cell center** (`cuv = (vec2(cellPos)+0.5)/g`). Because `cuv` and the offsets
depend only on `cellPos`, **every fragment inside a cell computes the identical 8-tap Sobel.** At
a 1280×720 render target with ~36×37 px cells, that's ~1300 fragments redundantly recomputing the
same 9 `gameLuma` fetches (8 Sobel + 1 cell-center). That's the bulk of the ~13 texture fetches
per fragment.

**Recommendation:** compute the edge + dark mask **once per cell**, not per fragment. Options:

- A tiny extra pass that renders the mask into the data texture grid (35×19), sampled once in the
  main shader — eliminates ~8 fetches/fragment.
- Or compute the mask on the CPU in `fusion`/`main` (the game frame is already a CPU buffer in the
  Angrylion path — luma is cheap there) and fold it into `bright16` before upload, removing the
  Sobel from the shader entirely.

This is the highest-impact GPU change in our own code and directly cuts V3D texture bandwidth,
which is the typical Pi GPU bottleneck.

### 3.2 Post-process pass always runs (even at zero glitch)
`main.rs:472-476` always renders the scene into the offscreen FBO (`post.bind_scene`) and then
always runs `post.render`, which samples that texture full-screen with a 3-tap RGB split
(`post.rs:67`). But the burst envelope `glitch_fx_env` is `0.0` most of the time (default
`glitch_fx_chance` is tiny and decays fast), and at `amt == 0` the post shader is a 1:1
passthrough (`post.rs:45`).

So in the steady state we pay for an **entire extra full-screen textured pass** (at *display*
resolution — up to 1080p/4K, not the capped render resolution) for a visual no-op.

**Recommendation:** when `glitch_fx_env` is ~0, bypass the offscreen FBO and render the ASCII
composite directly to the default framebuffer (skip `post` entirely). Only route through the
offscreen FBO when a burst is active. This removes one full-screen pass + one full-screen texture
read every idle frame.

### 3.3 `tex_image_2d` every frame instead of `tex_sub_image_2d`
The per-frame data uploads reallocate texture storage each call:

- `renderer.rs:365` and `:368` — cell data + CGA textures, every frame.
- `main.rs:511-544` (`upload_sw_texture`) — the game frame, every frame.

`tex_image_2d` with a non-null pointer re-specifies (reallocates) the texture each call;
`tex_sub_image_2d` updates in place. On the V3D/Mesa driver the realloc path can stall and
re-validate. Since the dimensions only change on resize, allocate once (in `resize` / on first
frame) and use `tex_sub_image_2d` for the per-frame data.

### 3.4 The game frame is sampled twice with full UV math
The shader samples the game texture for the edge/dark mask (`gameColor`/`gameLuma`, §3.1) **and**
again for the final screen-blend (`renderer.rs:234-235`), re-deriving the flip + uv-scale both
times. The cell-center color is already fetched as `cellGame` (`renderer.rs:179`); the final
composite could reuse a per-fragment game sample more carefully, and the duplicated
flip/uv-scale arithmetic can be hoisted. Minor next to §3.1 but in the same hot loop.

---

## 4. CPU / fusion per-tick work (30 Hz)

The logic grid is small (~35×19 ≈ 665 cells), so fusion is not the headline cost — but several
items are pure waste and trivial to fix.

### 4.1 `HashMap<char, u16>` glyph lookups in the hottest inner loops
`katakana_idx` / `gli_char_idx` (`fusion.rs:89-100`) do a `HashMap` lookup **per call**, and they
are called per-cell in the rain render (`fusion.rs:977`, `:984`), per-substitution in the glitch
decay loop (`fusion.rs:843`), and per wave-char refresh (`fusion.rs:935`). The pools are fixed at
construction.

**Recommendation:** precompute the katakana and GLI pools as `Vec<u16>` atlas indices **once** at
construction (resolve through `char_map` then), so the per-cell path is an array index + RNG, no
hashing. Eliminates thousands of hash lookups per tick.

### 4.2 `std::env::var(...)` called every tick
`fusion.rs:482` and `audio.rs:246` call `std::env::var("CRT_AUDIO_DEBUG")` **every 30 Hz tick**
(an allocation + env lookup each time). `hw_input.rs:501` already does the right thing — it caches
the result and re-checks only ~1×/sec. Apply that same pattern to the audio + fusion debug gates
(read once at startup, or gate behind the `now_ms % 1000` check *before* the `env::var` call).

### 4.3 `sample_buf.drain(0..excess)` each audio tick
`audio.rs:241` drains the front of a `Vec` every tick, which memmoves the remaining ~1024 floats
each time. A ring buffer (or `VecDeque`, or copying the trailing `FFT_SIZE` window) avoids the
shift. Small, but it's in the per-tick path.

### 4.4 Wave layer trig is unconditional per cell
`fusion.rs:914-927` evaluates 5 `sin()` + 1 `sqrt()` for **every** cell every tick, then discards
cells below `threshold` (`:930`). With the small grid this is ~3-4k transcendental calls/tick —
fine at release opt-level, but if profiling later shows fusion hot, the field can be evaluated
more cheaply (incremental phase accumulation, or lower-rate updates for the sub-threshold
majority). Low priority; noted for completeness.

---

## 5. Software-frame blit path

With Angrylion active (§2), every game frame goes through:

1. `video_refresh` (`frontend.rs:272`) repacks the core's buffer **row by row into a `Vec`**,
   dropping pitch padding — one full-framebuffer CPU copy (~1.2 MB at 640×480×4) per frame, under
   a mutex.
2. `upload_sw_texture` (`main.rs:497`) then uploads that with `tex_image_2d` (realloc, §3.3).

**Recommendation:** the repack in step 1 can be avoided by uploading directly from the core's
buffer using `GL_UNPACK_ROW_LENGTH = pitch/bpp` (then `tex_sub_image_2d`), letting GL skip the
padding instead of the CPU restriding it. That removes one ~1.2 MB/frame CPU copy. (Keep the lock
only around capturing the pointer/dims if you go this route, since the core owns the buffer only
during the call.)

This whole path disappears if GLideN64 (GPU RDP) is ever enabled (§2) — then the frame is an FBO
texture and there is no CPU copy or upload at all.

---

## 6. Things that are already good

- **Decoupled 30 Hz logic tick with a 4-tick catch-up cap** (`main.rs:375`) prevents a
  shader-compile stall from spiraling the simulation — and it's unit-tested.
- **No steady-state heap allocation in fusion** — all layer buffers are pre-allocated and reused;
  scratch buffers in the renderer and FFT are pre-sized.
- **Render resolution capped at 1280×720** (`main.rs:23`) with the post pass upscaling to the
  display — good instinct for keeping V3D fill-rate bounded; §3.1/§3.2 make that cap pay off more.
- **SPI knob reads (~70 µs) + interrupt-driven buttons on a background thread**
  (`hw_input.rs`) keep hardware polling off the critical path, and the debug-env check is already
  rate-limited.
- **`UNPACK_ALIGNMENT = 1` set once globally** (`sdl_gl.rs:62`) — correct for the tightly-packed
  R8/RG16UI uploads.
- **vtable dispatch for audio/hardware sources** is negligible at 30 Hz, as the comments note.

---

## Suggested order of work

1. **Verify + switch to a release build on the Pi; add `[profile.release]` + `target-cpu`** (§1).
   Cheapest, affects everything. Re-measure before doing anything else.
2. **Skip the post pass when idle** (§3.2) and **switch per-frame uploads to `tex_sub_image_2d`**
   (§3.3) — small, safe, measurable.
3. **Move the Sobel edge mask out of the per-fragment shader** (§3.1) — biggest GPU win in our
   code, more involved.
4. **Precompute glyph pools as `Vec<u16>`** + cache the debug env-var checks (§4.1, §4.2).
5. **Benchmark Angrylion multithreading / revisit the core plugin choice** (§2) — the real
   ceiling, highest effort/risk.

All numbers above are static-analysis estimates. Before and after each change, capture real
frame-time on the Pi (the `~` FPS overlay referenced in the v2 app, or add a frame-time log to the
loop) so the wins are measured, not assumed.
