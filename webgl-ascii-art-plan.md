# WebGL ASCII Art Renderer — Technical Plan

## Overview

Translate any image into ASCII art in real time using WebGL. The approach keeps things simple: use a fragment shader to compute per-cell luminance on the GPU, then render the result by sampling from a pre-built font atlas texture — no CPU readback, no DOM text nodes. Everything stays on the GPU.

---

## Architecture

```
┌────────────┐     ┌──────────────┐     ┌──────────────┐     ┌────────────┐
│ Source      │ ──▶ │ WebGL        │ ──▶ │ Fragment     │ ──▶ │ Final      │
│ Image      │     │ Texture      │     │ Shader       │     │ Framebuffer│
└────────────┘     └──────────────┘     └──────────────┘     └────────────┘
                                              │
                                   ┌──────────┴──────────┐
                                   │ Font Atlas Texture   │
                                   │ (ASCII glyph tiles)  │
                                   └──────────────────────┘
```

The shader receives two textures: the source image and a font atlas. For each output pixel it determines which ASCII cell it belongs to, samples the source image to get the cell's average luminance, selects the matching glyph tile from the atlas, and outputs the glyph pixel.

---

## Step-by-Step Plan

### 1. Image Loading

- Accept an image via `<input type="file">` or drag-and-drop.
- Create an `Image` element, load the file as a data URL.
- Upload it to a WebGL `TEXTURE_2D` with `texImage2D`.
- Store the image's natural dimensions for aspect-ratio math.

### 2. Font Atlas Generation

Build the atlas at runtime using an offscreen `<canvas>`:

- **Character ramp:** A string of characters sorted by visual density, lightest to darkest. A good default ramp:

  ```
   .\'`^",:;Il!i><~+_-?][}{1)(|\/tfjrxnuvczXYUJCLQ0OZmwqpdbkhao*#MW&8%B@$
  ```

- **Cell dimensions:** Render a reference character (e.g., `M`) in a monospace font at a chosen size (e.g., 12px). Measure the bounding box to get `cellWidth` and `cellHeight`. Typical result: ~7×14 px.
- **Atlas layout:** Draw each ramp character into a single-row canvas of size `(rampLength × cellWidth) × cellHeight`.
- **Upload:** Send the atlas canvas to a second WebGL texture.

### 3. WebGL Setup

Standard fullscreen-quad pipeline:

- **Vertex shader:** Pass through a full-screen triangle or quad. Output UV coordinates ranging 0→1.
- **Uniforms:**
  - `u_image` — sampler for the source image texture.
  - `u_atlas` — sampler for the font atlas texture.
  - `u_resolution` — canvas size in pixels.
  - `u_cellSize` — `vec2(cellWidth, cellHeight)` in pixels.
  - `u_rampLength` — number of characters in the density ramp.
  - `u_imageSize` — source image dimensions (for aspect ratio).

### 4. Fragment Shader Logic

The shader runs per output pixel. Pseudocode:

```glsl
// 1. Figure out which ASCII cell this pixel belongs to
vec2 cellIndex = floor(gl_FragCoord.xy / u_cellSize);

// 2. Map cell to source image UV
vec2 imageUV = (cellIndex + 0.5) * u_cellSize / u_resolution;

// 3. Sample the source image at that point
vec4 color = texture2D(u_image, imageUV);

// 4. Compute perceptual luminance
float luma = dot(color.rgb, vec3(0.299, 0.587, 0.114));

// 5. Map luminance to a character index (invert so bright = sparse char)
int charIndex = int((1.0 - luma) * float(u_rampLength - 1));

// 6. Find this pixel's position within its cell
vec2 cellOffset = mod(gl_FragCoord.xy, u_cellSize) / u_cellSize;

// 7. Sample the atlas at the correct glyph tile
float atlasU = (float(charIndex) + cellOffset.x) / float(u_rampLength);
float atlasV = cellOffset.y;
vec4 glyph = texture2D(u_atlas, vec2(atlasU, atlasV));

// 8. Output
gl_FragColor = glyph;
```

### 5. Rendering

- Size the WebGL canvas to fill the viewport (or a container).
- On each frame (or once for a static image), bind both textures and draw the fullscreen quad.
- The output is the ASCII-art version of the image rendered entirely on the GPU.

### 6. User Controls

Expose a minimal UI alongside the canvas:

| Control             | Effect                                               |
|----------------------|------------------------------------------------------|
| File picker          | Load a new source image                              |
| Cell size slider     | Larger cells = blockier ASCII, fewer "characters"    |
| Ramp selector        | Switch between short/long density ramps              |
| Invert toggle        | Swap light/dark mapping (for dark backgrounds)       |
| Color toggle         | Tint each glyph with the source pixel's color        |

---

## Key Design Decisions

### Why fully GPU-based?

The alternative — using `readPixels` to pull luminance data back to the CPU and rendering text via the DOM or Canvas2D — creates a synchronization bottleneck. Even for a single static image the GPU→CPU transfer is measurably slow at high resolutions. The atlas approach avoids this entirely and also opens the door to real-time video/webcam input later with zero architectural changes.

### Character density ramp

Longer ramps produce more tonal detail but make the atlas texture wider. A 70-character ramp at 7px cell width is a 490px-wide texture — trivial. Even a 95-character printable-ASCII ramp fits comfortably.

### Cell aspect ratio

Monospace characters are taller than they are wide (roughly 1:2). The cell size must reflect this or the output will appear horizontally stretched. Using the actual measured glyph bounding box from the atlas canvas handles this automatically.

### Colored ASCII (optional)

To add color, multiply the glyph's alpha by the source pixel's RGB:

```glsl
gl_FragColor = vec4(color.rgb * glyph.a, 1.0);
```

This requires rendering the atlas glyphs as white-on-transparent so the alpha channel carries the shape.

---

## File Structure

```
webgl-ascii-art/
├── index.html          # Canvas, controls, script tags
├── ascii-renderer.js   # WebGL setup, atlas generation, render loop
├── shaders/
│   ├── vertex.glsl     # Fullscreen quad passthrough
│   └── fragment.glsl   # Luminance + atlas lookup
└── style.css           # Layout and control styling
```

For a single-file artifact version, inline the shaders as template strings and keep everything in one `.html` file.

---

## Performance Notes

- **Static image:** A single draw call after loading. Effectively instant.
- **Video/webcam:** One `texSubImage2D` + one draw call per frame. Easily 60fps for typical resolutions since the shader does minimal ALU work.
- **Bottleneck:** The only real cost is the texture upload when the source changes. The fragment shader is pure arithmetic and texture lookups — extremely fast on any GPU from the last decade.

---

## Next Steps

1. Scaffold the HTML with a canvas and file input.
2. Write the atlas generator in JS.
3. Write and compile the vertex + fragment shaders.
4. Wire up the render pipeline and test with a sample image.
5. Add UI controls (cell size, color mode, invert).
6. Optionally extend to webcam input.
