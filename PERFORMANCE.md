# Performance Analysis: p5.js Canvas 2D → WebGL 2

This document explains why the original p5.js implementation ran poorly on Raspberry Pi 5 and how the v2 WebGL 2 rewrite resolves each bottleneck.

---

## The problem: what made v1 slow

The Pi 5 has a VideoCore VII GPU that supports OpenGL ES 3.1 and Vulkan 1.2 — it is a capable piece of silicon. The original app almost never used it. Every frame was dominated by CPU work.

### Bottleneck 1: per-character `fillText()` calls (dominant)

The v1 render loop called `p.text()` — which maps to `ctx.fillText()` — up to **4 times per non-space cell** every frame:

- Once for the base character
- Once offset by 1px (simulating a bold/CRT bloom effect)
- Twice more with horizontal/vertical offsets for chromatic aberration fringe

At a typical grid of ~48 columns × ~24 rows = 1,152 cells, and assuming ~70% non-space density, a single frame could fire **3,000+ `fillText()` calls**.

Canvas 2D `fillText()` with a custom font (GlassTTY VT220) is not GPU-accelerated. Each call:
1. Looks up the glyph shape from the loaded font file (opentype.js path data)
2. Builds a CPU-side path from the vector outlines
3. Submits a rasterized draw command to the 2D compositing pipeline

On a modern desktop CPU this costs roughly 0.1–0.5 ms per character. On the Pi 5's ARM Cortex-A76 the same path runs **3–10× slower**. At 3,000 calls × ~1 ms each, a single frame takes several seconds. This is exactly the behavior observed on hardware.

### Bottleneck 2: p5.js method-call overhead

Every `p.fill()`, `p.text()`, `p.textSize()`, and `p.image()` call in v1 passes through p5's wrapper layer, which performs argument normalization, type checking, and color-object parsing on every invocation. These are small per-call costs (~0.01–0.05 ms each) but multiply across thousands of calls per frame. On a 3 GHz desktop CPU this is invisible; on a 2.4 GHz ARM core running thousands of calls per frame, it adds up.

### Bottleneck 3: the BackgroundFX pixel pipeline

The v1 `BackgroundFX` class applied five visual effects (posterize, warp, scanline corruption, chromatic aberration, beat flash) by calling `ctx.getImageData()` and `ctx.putImageData()` every frame. These calls:

1. **Read** the entire canvas pixel buffer from GPU VRAM into a CPU-side `Uint8ClampedArray`
2. Apply transformations in JS loops (the warp pass processed ~1.28 million pixels per frame on a 1280×720 canvas)
3. **Write** the modified buffer back to GPU VRAM

This GPU→CPU→GPU round-trip crosses the memory bus twice per frame. Even with loop optimizations, processing 1.28M pixels per frame in JavaScript on ARM is prohibitively slow.

### Why it worked fine on desktop

Desktop CPUs have single-core clock speeds 3–5× higher than the Pi's Cortex-A76. The same workload that takes 2–5 seconds per frame on Pi takes 100–200 ms on a desktop — still slow, but not visually broken. The bottleneck was always there; the Pi just exposed it.

---

## The solution: how v2 fixes each bottleneck

### Fix 1: GPU-side glyph rendering via a texture atlas

The core architectural change in v2 is moving all character rendering into a GLSL fragment shader that runs entirely on the VideoCore VII GPU.

**At startup (one time only):**

All ~275 characters in the charset (ASCII printable, Katakana, block/shade chars, glitch symbols) are rendered into a **glyph atlas texture** using a single offscreen Canvas 2D pass. The resulting bitmap is uploaded to the GPU as a `GL_R8` texture. This is the only time `fillText()` is ever called.

```
atlas texture: 20 columns × 14 rows of tiles
each tile:     ~42 × 48 px (GlassTTY VT220 at 40px, measured via measureText())
atlas size:    ~840 × 672 px — fits easily in VideoCore VII VRAM
```

**Every frame:**

The CPU writes two small typed arrays:
- `Uint16Array charIdx` — one 16-bit glyph index per cell (~512 cells at 1280×720)
- `Uint16Array bright16` — brightness × 65535 per cell
- `Uint8Array cgaIdx` — CGA color override per cell (0 = phosphor color)

These are uploaded to the GPU as tiny `RG16UI` and `R8` data textures via a single `gl.texSubImage2D()` call each. At a 32×16 grid, the upload is **~2 KB of data per frame** — negligible.

Then the entire grid is rendered with **one draw call:**

```javascript
gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
```

The GLSL fragment shader runs on all grid pixels in parallel on the VideoCore VII QPUs. For each fragment it:
1. Computes which grid cell it belongs to from `gl_FragCoord`
2. Fetches that cell's char index and brightness from the data texture
3. Computes the UV position within the correct glyph tile in the atlas
4. Samples the atlas texture to get the glyph alpha
5. Maps brightness through the three-stop phosphor color curve
6. Applies chromatic aberration by sampling the atlas at ±offset UV for R and B channels
7. Applies scanline darkening on every other row

All of this runs in parallel across the GPU's QPU cores — the cost is essentially fixed regardless of how many characters are active, how much glitch is firing, or how dense the rain is.

**Net result: the per-frame `fillText()` call count goes from 3,000+ to zero.**

### Fix 2: removing p5.js entirely

v2 uses no p5.js at all. The render loop is a plain `requestAnimationFrame` callback. All canvas interaction goes through the raw WebGL 2 API. There is no argument normalization, color parsing, or type-checking wrapper on any hot-path call.

The animation loop:

```javascript
function loop(timestamp) {
    audioManager.update();
    fusionMode.update(audio, cols, rows);
    renderer.upload(fusionMode.charIdx, fusionMode.bright16, fusionMode.cgaIdx);
    renderer.render(V2_PARAMS);
    requestAnimationFrame(loop);
}
```

Every call in this path is either a direct typed-array write, a WebGL API call, or a simple arithmetic loop.

### Fix 3: removing the BackgroundFX pixel pipeline

The v2 MVP does not include a background image/video layer. The `getImageData()` / `putImageData()` CPU pixel pipeline from v1 is gone entirely. The visual effects it provided — chromatic aberration, scanlines — are now implemented in the GLSL fragment shader at zero CPU cost.

#### Update — v2 today (2026-04-28)

A background image/video layer was subsequently reintroduced in `v2/background.js`, rendered as a CSS `background-image` on a fixed `<div>` below the WebGL canvas. Audio-reactive visual effects on that layer (hue rotation, saturation, brightness, scale pulse) are applied via CSS `filter` and `transform` properties in `v2/bg-fx.js`. These properties are resolved by the GPU compositor — no `getImageData()` or `putImageData()` is ever called. This is architecturally distinct from the v1 pixel pipeline described above, so the performance improvement of Fix 3 still holds in full. The key invariant is that the CPU never reads back pixel data from either the WebGL canvas or the background layer.

### Fix 4: typed arrays throughout, no per-frame GC

v1 represented the character grid as a 2D array of objects: `grid[row][col] = { char, brightness }`. Every frame, the render loop accessed thousands of these objects, generating pointer indirection and GC pressure.

v2 uses flat typed arrays for all state:

| Buffer | Type | Size (32×16 grid) | Purpose |
|---|---|---|---|
| `charIdx` | `Uint16Array` | 1,024 bytes | glyph index per cell |
| `bright16` | `Uint16Array` | 1,024 bytes | brightness per cell |
| `cgaIdx` | `Uint8Array` | 512 bytes | CGA color per cell |
| `_figureBright` | `Float32Array` | 2,048 bytes | figure layer state |
| `_figureChar` | `Uint16Array` | 1,024 bytes | figure layer chars |
| `_glitchBright` | `Float32Array` | 2,048 bytes | glitch layer state |
| `_glitchCgaIdx` | `Uint8Array` | 512 bytes | glitch CGA indices |
| `_glitchChar` | `Uint16Array` | 1,024 bytes | glitch layer chars |
| `_waveCharIdx` | `Uint16Array` | 1,024 bytes | wave layer chars |

All buffers are allocated once at init and reused every frame. **Zero heap allocations occur during steady-state rendering.**

### Fix 5: raw Web Audio API instead of p5.sound

v1 used p5.sound to manage the `AudioContext`, `FFT`, and sound file playback. p5.sound adds a lifecycle management layer and event abstractions on top of the Web Audio API.

v2 uses the Web Audio API directly: `AudioContext`, `AnalyserNode`, `GainNode`, `MediaElementSourceNode`. The `AnalyserNode.getFloatFrequencyData()` call runs in Chromium's native audio thread (C++, not JS) — the FFT is computed by the browser, not by any JavaScript code. This was true in v1 as well, but v2 removes the p5.sound wrapper overhead and simplifies the `AudioContext` unlock lifecycle.

---

## Frame budget comparison

At 1280×720, targeting 30 fps (33.3 ms budget):

| Work | v1 estimate (Pi 5) | v2 estimate (Pi 5) |
|---|---|---|
| `fillText()` calls (3,000+) | ~2,000–5,000 ms | 0 ms |
| p5.js method overhead | ~50–100 ms | 0 ms |
| BackgroundFX pixel pipeline | ~200–500 ms | 0 ms |
| Mode logic (JS loops) | ~10–20 ms | ~5–8 ms |
| Audio FFT + beat detection | ~2–5 ms | ~1–2 ms |
| GPU draw call | ~0 ms (Canvas 2D, CPU) | ~2–4 ms |
| Typed-array upload to GPU | — | ~0.5 ms |
| **Total** | **~2,000+ ms (< 1 fps)** | **~10–15 ms (~30–60 fps)** |

The v1 figures represent worst-case glitch-dense frames. Even in calm scenes, v1 on Pi 5 was well below 5 fps. v2 keeps all per-frame CPU work under ~10 ms, leaving the GPU to handle rendering in parallel.

---

## Why not go native (C++/Rust)?

A native OpenGL ES 3.1 or Vulkan application would use the same VideoCore VII hardware. The GPU draw call for a single full-screen quad with a fragment shader is identical whether the API caller is WebGL 2 in Chromium or a native C++ binary. The differences would be:

- **Mode logic JS vs C++**: JS loops are ~5–10× slower than equivalent C++ for tight numerical code. But v2's mode logic takes ~5–8 ms in JS — 10× faster would be ~0.5–0.8 ms. The frame budget is 33 ms; this gain is irrelevant.
- **Audio FFT**: Already runs in Chromium's native C++ audio thread. No JS involved.
- **Driver overhead**: Vulkan has lower CPU overhead than OpenGL ES for batched draw calls. v2 issues one draw call per frame — driver overhead is negligible either way.
- **GPIO access**: A native app could talk to GPIO directly, eliminating the Python bridge process. In practice the bridge adds ~1–2 ms of WebSocket round-trip latency, imperceptible for VJ use.

For this workload — one GPU draw call per frame, light JS mode logic, Web Audio API FFT — WebGL 2 in Chromium captures essentially all of the GPU performance benefit of a native app while retaining fast development iteration, no build toolchain, and the existing hardware bridge protocol unchanged.
