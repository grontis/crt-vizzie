// v2/renderer.js — V2Renderer
// WebGL 2 renderer: glyph atlas (built once at startup) + per-cell data texture
// (uploaded every frame) → single gl.drawArrays() call.
//
// Requires WebGL 2. If webgl2 context is unavailable, throws an error.
//
// Load order: after config.js, before sketch.js

'use strict';

// ── GLSL source strings ──────────────────────────────────────────────────────
// These are also saved as shaders/vert.glsl and shaders/frag.glsl for reference.

const VERT_SRC = `#version 300 es
precision mediump float;

// Full-screen quad: clip-space positions passed in as attribute
in vec2 a_pos;
out vec2 v_uv;

void main() {
  // a_pos is in [-1..1] clip space; convert to [0..1] UV
  v_uv = a_pos * 0.5 + 0.5;
  gl_Position = vec4(a_pos, 0.0, 1.0);
}
`;

const FRAG_SRC = `#version 300 es
precision mediump float;
precision highp   int;
precision highp   usampler2D;

// ── Samplers ────────────────────────────────────────────────────────
// Glyph atlas: GL_R8 texture — one channel, white glyph on black background
uniform sampler2D    u_glyphAtlas;
// Per-cell data: RG16UI — .r = charIdx (0-255), .g = brightness * 65535
uniform usampler2D   u_cellData;
// Per-cell CGA color index: R8 (normalized float) — 0 = use phosphor, 1-15 = CGA palette index
uniform sampler2D    u_cellColor;

// ── Layout uniforms ─────────────────────────────────────────────────
uniform vec2  u_resolution;   // canvas width, height in pixels
uniform vec2  u_cellSize;     // cell width, height in pixels
uniform ivec2 u_gridSize;     // grid cols, rows
uniform vec2  u_atlasTileSize; // atlas tile width, height in pixels (includes padding)
uniform ivec2 u_atlasDims;    // atlas layout in tiles: (cols, rows)
uniform vec2  u_atlasTexSize; // atlas texture pixel size

// ── Visual uniforms ─────────────────────────────────────────────────
uniform vec3  u_phosphorDim;
uniform vec3  u_phosphorMid;
uniform vec3  u_phosphorBright;
uniform float u_chromaOffset;  // pixel shift for R and B channels
uniform float u_scanline;      // scanline darkening (0 = off, 1 = full dark)
uniform int   u_scanlineMode;  // 0=off 1=pixel 2=cell-gap 3=smooth
uniform vec3  u_cgaColors[16]; // CGA 16-color palette

in  vec2 v_uv;
out vec4 fragColor;

// ── Helpers ──────────────────────────────────────────────────────────

// Sample the glyph atlas at a given charIdx, offset by dxPixels from the
// natural fragment position within the cell.
// Each tile in the atlas has 1px padding on left+top sides (drawn at offset +1,+1).
// We compute glyphSamplePos in tile-local pixel space, clamp it, then add tileOrigin.
float sampleGlyph(int charIdx, ivec2 cellPos, vec2 fragInCell, float dxPixels) {
  int atlasCol = charIdx % u_atlasDims.x;
  int atlasRow = charIdx / u_atlasDims.x;

  // Top-left pixel of this char's tile in the atlas (in atlas pixel space)
  vec2 tileOrigin = vec2(atlasCol, atlasRow) * u_atlasTileSize;

  // fragInCell is in [0..cellSize] pixel coords within the tile.
  // Add +1.0 to skip the 1px left/top padding, plus dxPixels for chroma shift.
  // Clamp within [1, tileSize-1] to stay inside the glyph area of this tile.
  vec2 glyphSamplePos = fragInCell + vec2(dxPixels + 1.0, 1.0);
  glyphSamplePos.x = clamp(glyphSamplePos.x, 1.0, u_atlasTileSize.x - 1.0);
  glyphSamplePos.y = clamp(glyphSamplePos.y, 1.0, u_atlasTileSize.y - 1.0);

  // Add tile origin (in pixels) and convert to atlas UV
  vec2 atlasPixelPos = tileOrigin + glyphSamplePos;
  vec2 atlasUV = atlasPixelPos / u_atlasTexSize;
  return texture(u_glyphAtlas, atlasUV).r;
}

// Map brightness to phosphor three-stop color
vec3 phosphorColor(float bright) {
  if (bright > 0.66) {
    return mix(u_phosphorMid, u_phosphorBright, (bright - 0.66) / 0.34);
  } else if (bright > 0.33) {
    return mix(u_phosphorDim, u_phosphorMid, (bright - 0.33) / 0.33);
  } else {
    return u_phosphorDim * (bright / 0.33);
  }
}

void main() {
  // Flip Y: gl_FragCoord.y is bottom-up, we want top-down cell indices
  vec2 fragCoord = vec2(gl_FragCoord.x, u_resolution.y - gl_FragCoord.y);

  // Grid cell coordinates
  ivec2 cellPos = ivec2(fragCoord / u_cellSize);

  // Out-of-grid guard
  if (cellPos.x >= u_gridSize.x || cellPos.y >= u_gridSize.y ||
      cellPos.x < 0 || cellPos.y < 0) {
    fragColor = vec4(0.0, 0.0, 0.0, 1.0);
    return;
  }

  // Fetch cell data: charIdx and brightness
  uvec4 data = texelFetch(u_cellData, cellPos, 0);
  int   charIdx = int(data.r);
  float bright  = float(data.g) / 65535.0;

  // Fetch CGA color index: R8 normalized float, scale back to integer index
  int cgaIdx = int(texelFetch(u_cellColor, cellPos, 0).r * 255.0 + 0.5);

  // Fragment position within the cell (pixel offset from cell top-left)
  vec2 fragInCell = fragCoord - vec2(cellPos) * u_cellSize;

  // ── Glyph sampling with chromatic aberration ─────────────────────
  float alphaG, alphaR, alphaB;
  if (bright < 0.01 || charIdx == 0) {
    // Empty cell — no glyph sampling needed
    alphaG = 0.0; alphaR = 0.0; alphaB = 0.0;
  } else {
    alphaG = sampleGlyph(charIdx, cellPos, fragInCell,  0.0);
    alphaR = sampleGlyph(charIdx, cellPos, fragInCell, -u_chromaOffset);
    alphaB = sampleGlyph(charIdx, cellPos, fragInCell,  u_chromaOffset);
  }

  // ── Color mapping ────────────────────────────────────────────────
  vec3 baseColor;
  if (cgaIdx > 0) {
    // CGA override — use indexed palette color, scaled by brightness
    baseColor = u_cgaColors[cgaIdx] * max(0.3, bright);
  } else {
    baseColor = phosphorColor(bright);
  }

  // Apply per-channel glyph alpha (chromatic aberration gives R/B fringe)
  vec3 color = vec3(
    baseColor.r * alphaR,
    baseColor.g * alphaG,
    baseColor.b * alphaB
  );

  // ── Scanlines ────────────────────────────────────────────────────
  // u_scanlineMode: 0=off, 1=pixel (every other px row),
  //                 2=cell-gap (darken bottom of each cell row),
  //                 3=smooth (sine falloff within each cell row)
  float scanFactor = 1.0;
  if (u_scanlineMode == 1) {
    // PIXEL: darken every other display pixel row (original behaviour)
    int pixRow = int(gl_FragCoord.y);
    if ((pixRow & 1) == 0) {
      scanFactor = 1.0 - u_scanline;
    }
  } else if (u_scanlineMode == 2) {
    // CELL-GAP: darken the bottom ~20% of each character cell
    // gapFrac controls what fraction of the cell height is the dark band.
    // u_scanline scales its depth (0 = invisible, 1 = fully black).
    float gapFrac = 0.20;
    float cellH   = u_cellSize.y;
    float gapPx   = cellH * gapFrac;
    if (fragInCell.y >= (cellH - gapPx)) {
      // Linear ramp: fully dark at the very bottom, transitions at gapPx boundary
      float t = (fragInCell.y - (cellH - gapPx)) / gapPx;
      scanFactor = 1.0 - u_scanline * t;
    }
  } else if (u_scanlineMode == 3) {
    // SMOOTH: sine-based phosphor beam falloff within each cell row.
    // sin(0..PI) = 0..1..0; brightest at cell center, dark at top/bottom edges.
    // scanFactor approaches (1 - u_scanline) at the edges.
    float cellH = u_cellSize.y;
    float phase = fragInCell.y / cellH;          // 0..1 top to bottom
    float beam  = sin(phase * 3.14159265);       // 0..1..0
    scanFactor  = 1.0 - u_scanline * (1.0 - beam);
  }
  // mode 0 (OFF): scanFactor stays 1.0
  color *= scanFactor;

  fragColor = vec4(color, 1.0);
}
`;

// ── V2Renderer class ─────────────────────────────────────────────────────────

class V2Renderer {

  /**
   * @param {HTMLCanvasElement} canvas
   * @param {object} config  — V2_CONFIG
   */
  constructor(canvas, config) {
    this._canvas = canvas;
    this._config = config;

    const gl = canvas.getContext('webgl2', {
      alpha:              false,
      depth:              false,
      stencil:            false,
      antialias:          false,
      premultipliedAlpha: false,
      preserveDrawingBuffer: false,
    });

    if (!gl) {
      throw new Error('WebGL 2 is not available. Check chrome://gpu for details.');
    }
    this._gl = gl;

    // Grid dimensions — set by _computeGrid() and resize()
    this._cols = 0;
    this._rows = 0;
    this._cellW = 0;
    this._cellH = 0;

    // Atlas info
    this._atlasCols     = config.ATLAS_COLS;
    this._atlasRows     = 0;
    this._atlasTexW     = 0;
    this._atlasTexH     = 0;
    this._charset       = null;

    // WebGL objects
    this._program       = null;
    this._vao           = null;
    this._quadBuf       = null;
    this._atlasTexture  = null;
    this._dataTexture   = null;
    this._colorTexture  = null;
    this._uniforms      = {};

    // Pre-allocated buffers (avoid per-frame GC)
    this._cgaFlatBuf    = new Float32Array(48); // 16 × vec3

    // Typed arrays for cell data (allocated in resize())
    this._cellData  = null; // Uint16Array: [charIdx(u16), bright16(u16)] per cell
    this._cellColor = null; // Uint8Array:  [cgaIdx(u8)] per cell

    this._init();
  }

  // ── Public API ───────────────────────────────────────────────────────────────

  get cols()      { return this._cols; }
  get rows()      { return this._rows; }
  get cellW()     { return this._cellW; }
  get cellH()     { return this._cellH; }
  get glVersion() { return this._gl.getParameter(this._gl.VERSION); }

  /**
   * Build the glyph atlas from the loaded font.
   * Must be called after document.fonts.ready resolves.
   * @param {string[]} charset — array of single characters to include
   */
  buildAtlas(charset) {
    this._charset = charset;
    this._buildGlyphAtlas(charset);
    this._computeGrid(this._canvas.width, this._canvas.height);
    this._allocCellArrays();
  }

  /**
   * Resize the canvas and recompute grid dimensions.
   * Call this on window resize or fullscreen toggle.
   */
  resize(width, height) {
    this._canvas.width  = width;
    this._canvas.height = height;
    this._gl.viewport(0, 0, width, height);
    this._computeGrid(width, height);
    this._allocCellArrays(); // also calls _resizeDataTextures internally
  }

  /**
   * Upload typed arrays to data textures.
   * charIdx[]:  Uint16Array, one entry per cell (row-major)
   * bright16[]: Uint16Array, one entry per cell (0–65535)
   * cgaIdx[]:   Uint8Array,  one entry per cell (0 = phosphor, 1–15 = CGA)
   */
  upload(charIdx, bright16, cgaIdx) {
    const gl   = this._gl;
    const cols = this._cols;
    const rows = this._rows;
    const n    = cols * rows;

    // Pack charIdx + bright16 into interleaved RG16UI array
    const dataBuf = this._cellData;
    for (let i = 0; i < n; i++) {
      dataBuf[i * 2 + 0] = charIdx[i]  || 0;
      dataBuf[i * 2 + 1] = bright16[i] || 0;
    }

    gl.bindTexture(gl.TEXTURE_2D, this._dataTexture);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, cols, rows,
      gl.RG_INTEGER, gl.UNSIGNED_SHORT, dataBuf);

    // Upload CGA color index as R8 (normalized float, universally supported on Mesa/v3d)
    const colorBuf = cgaIdx || this._cellColor;
    gl.bindTexture(gl.TEXTURE_2D, this._colorTexture);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, cols, rows,
      gl.RED, gl.UNSIGNED_BYTE, colorBuf);
  }

  /**
   * Set uniforms and issue the single draw call.
   * @param {object} params  — V2_PARAMS
   */
  render(params) {
    const gl  = this._gl;
    const cfg = this._config;

    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);

    gl.useProgram(this._program);

    // Bind textures
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this._atlasTexture);
    gl.uniform1i(this._uniforms.u_glyphAtlas, 0);

    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this._dataTexture);
    gl.uniform1i(this._uniforms.u_cellData, 1);

    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this._colorTexture);
    gl.uniform1i(this._uniforms.u_cellColor, 2);

    // Layout uniforms
    gl.uniform2f(this._uniforms.u_resolution,    this._canvas.width, this._canvas.height);
    gl.uniform2f(this._uniforms.u_cellSize,       this._cellW, this._cellH);
    gl.uniform2i(this._uniforms.u_gridSize,       this._cols,  this._rows);
    // u_atlasTileSize = tile dimensions IN THE ATLAS TEXTURE (includes padding)
    gl.uniform2f(this._uniforms.u_atlasTileSize,  this._atlasTileW, this._atlasTileH);
    gl.uniform2i(this._uniforms.u_atlasDims,      this._atlasCols, this._atlasRows);
    gl.uniform2f(this._uniforms.u_atlasTexSize,   this._atlasTexW, this._atlasTexH);

    // Phosphor colors
    const phosphorKey = cfg.PHOSPHOR_ORDER[params.phosphorIndex % cfg.PHOSPHOR_ORDER.length];
    const ph = cfg.PHOSPHORS[phosphorKey];
    gl.uniform3fv(this._uniforms.u_phosphorDim,    ph.dim);
    gl.uniform3fv(this._uniforms.u_phosphorMid,    ph.mid);
    gl.uniform3fv(this._uniforms.u_phosphorBright, ph.bright);

    // Chroma offset — chromaBase is always-on; _chromaBeatCurrent is the beat-reactive add
    const chromaOffset = (params.chromaBase || 0) + (params._chromaBeatCurrent || 0);
    gl.uniform1f(this._uniforms.u_chromaOffset, chromaOffset);
    gl.uniform1f(this._uniforms.u_scanline,     params.scanlineIntensity || 0);
    gl.uniform1i(this._uniforms.u_scanlineMode, params.scanlineMode || 0);

    // CGA palette — flat vec3 array (16 × 3 = 48 floats, pre-allocated)
    const cgaFlat = this._cgaFlatBuf;
    for (let i = 0; i < 16; i++) {
      cgaFlat[i * 3 + 0] = cfg.CGA_COLORS[i][0];
      cgaFlat[i * 3 + 1] = cfg.CGA_COLORS[i][1];
      cgaFlat[i * 3 + 2] = cfg.CGA_COLORS[i][2];
    }
    gl.uniform3fv(this._uniforms.u_cgaColors, cgaFlat);

    // Draw
    gl.bindVertexArray(this._vao);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.bindVertexArray(null);
  }

  // ── Initialization ────────────────────────────────────────────────────────

  _init() {
    const gl = this._gl;

    // Compile shaders
    this._program = this._compileProgram(VERT_SRC, FRAG_SRC);

    // Cache uniform locations
    const uNames = [
      'u_glyphAtlas', 'u_cellData', 'u_cellColor',
      'u_resolution', 'u_cellSize', 'u_gridSize',
      'u_atlasTileSize', 'u_atlasDims', 'u_atlasTexSize',
      'u_phosphorDim', 'u_phosphorMid', 'u_phosphorBright',
      'u_chromaOffset', 'u_scanline', 'u_scanlineMode', 'u_cgaColors',
    ];
    for (const name of uNames) {
      this._uniforms[name] = gl.getUniformLocation(this._program, name);
    }

    // Full-screen quad VAO
    // Two triangles via TRIANGLE_STRIP: TL, BL, TR, BR (clip-space)
    const quadVerts = new Float32Array([
      -1, -1,   // bottom-left
       1, -1,   // bottom-right
      -1,  1,   // top-left
       1,  1,   // top-right
    ]);
    this._quadBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this._quadBuf);
    gl.bufferData(gl.ARRAY_BUFFER, quadVerts, gl.STATIC_DRAW);

    this._vao = gl.createVertexArray();
    gl.bindVertexArray(this._vao);
    const aPos = gl.getAttribLocation(this._program, 'a_pos');
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);

    // WebGL context version info
    console.log('[V2Renderer] WebGL version:', gl.getParameter(gl.VERSION));
    console.log('[V2Renderer] GLSL version:',  gl.getParameter(gl.SHADING_LANGUAGE_VERSION));
  }

  _compileProgram(vertSrc, fragSrc) {
    const gl = this._gl;

    const vert = this._compileShader(gl.VERTEX_SHADER,   vertSrc);
    const frag = this._compileShader(gl.FRAGMENT_SHADER, fragSrc);

    const prog = gl.createProgram();
    gl.attachShader(prog, vert);
    gl.attachShader(prog, frag);
    gl.linkProgram(prog);

    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      const info = gl.getProgramInfoLog(prog);
      gl.deleteProgram(prog);
      throw new Error('Shader program link error:\n' + info);
    }

    gl.deleteShader(vert);
    gl.deleteShader(frag);

    return prog;
  }

  _compileShader(type, src) {
    const gl     = this._gl;
    const shader = gl.createShader(type);
    gl.shaderSource(shader, src);
    gl.compileShader(shader);

    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      const info = gl.getShaderInfoLog(shader);
      gl.deleteShader(shader);
      const typeName = type === gl.VERTEX_SHADER ? 'vertex' : 'fragment';
      throw new Error(`GLSL ${typeName} compile error:\n${info}`);
    }
    return shader;
  }

  // ── Glyph atlas build ─────────────────────────────────────────────────────

  _buildGlyphAtlas(charset) {
    const cfg    = this._config;
    const gl     = this._gl;
    const ACOLS  = this._atlasCols;
    const AROWS  = Math.ceil(charset.length / ACOLS);
    this._atlasRows = AROWS;

    // Measure cell size from a representative character
    const probe  = document.createElement('canvas');
    probe.width  = 64;
    probe.height = 64;
    const pctx   = probe.getContext('2d');
    const font   = `${cfg.FONT_WEIGHT || 'normal'} ${cfg.FONT_SIZE}px "${cfg.FONT_FACE}", monospace`;
    pctx.font    = font;

    // Use 'M' advance width for cell width (works for monospace fonts)
    const m = pctx.measureText('M');
    const rawCellW = m.width > 0 ? m.width : cfg.FONT_SIZE * 0.6;
    const cellW = Math.ceil(rawCellW * cfg.CHAR_SPACING);
    const cellH = Math.ceil(cfg.FONT_SIZE * cfg.LINE_SPACING);

    this._cellW = cellW;
    this._cellH = cellH;

    // Build atlas canvas
    const PAD    = 2; // pixel padding between glyphs to avoid bleed
    const tileW  = cellW + PAD;
    const tileH  = cellH + PAD;
    const atlW   = ACOLS * tileW;
    const atlH   = AROWS * tileH;

    this._atlasTexW = atlW;
    this._atlasTexH = atlH;

    // Adjust cell size stored for shader (without padding)
    // The shader uses tileW/tileH to compute atlas UVs, so we store tileW/tileH
    // but use the actual render cellW/cellH for grid layout
    this._atlasTileW = tileW;
    this._atlasTileH = tileH;

    const ac  = document.createElement('canvas');
    ac.width  = atlW;
    ac.height = atlH;
    const ctx = ac.getContext('2d');

    ctx.fillStyle = 'black';
    ctx.fillRect(0, 0, atlW, atlH);

    ctx.font         = font;
    ctx.fillStyle    = 'white';
    ctx.textBaseline = 'top';
    ctx.imageSmoothingEnabled = false;
    console.log(`[V2Renderer] Atlas built with font: "${font}"`);

    for (let i = 0; i < charset.length; i++) {
      const col = i % ACOLS;
      const row = Math.floor(i / ACOLS);
      const x   = col * tileW + 1; // +1 for left padding
      const y   = row * tileH + 1; // +1 for top padding
      ctx.fillText(charset[i], x, y);
    }

    // Extract single-channel data from the atlas canvas RGBA pixels
    // Use the red channel (white text = R=255, black background = R=0)
    const rgbaData = ctx.getImageData(0, 0, atlW, atlH).data; // Uint8ClampedArray, RGBA
    const redData  = new Uint8Array(atlW * atlH);
    for (let px = 0; px < atlW * atlH; px++) {
      redData[px] = rgbaData[px * 4]; // R channel only
    }

    // Upload atlas as GL_R8 (single channel grayscale)
    const atlTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, atlTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S,     gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T,     gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, atlW, atlH, 0, gl.RED, gl.UNSIGNED_BYTE, redData);

    this._atlasTexture = atlTex;

    console.log(`[V2Renderer] Atlas: ${charset.length} chars, ${ACOLS}×${AROWS} tiles, ` +
                `cell ${cellW}×${cellH}px (tile ${tileW}×${tileH}), texture ${atlW}×${atlH}`);

    // Retain atlas canvas only for debug mode to avoid permanent memory overhead.
    // Activate by loading the page with #debug-atlas in the URL hash.
    this._atlasCanvas = (window.location.hash === '#debug-atlas') ? ac : null;
  }

  _computeGrid(width, height) {
    this._cols = Math.floor(width  / this._cellW);
    this._rows = Math.floor(height / this._cellH);
    console.log(`[V2Renderer] Grid: ${this._cols}×${this._rows} cells at ${width}×${height}px`);
  }

  _allocCellArrays() {
    const n = this._cols * this._rows;
    // RG16UI: 2 × Uint16 per cell
    this._cellData  = new Uint16Array(n * 2);
    // R8UI: 1 × Uint8 per cell
    this._cellColor = new Uint8Array(n);
    this._resizeDataTextures();
  }

  _resizeDataTextures() {
    const gl   = this._gl;
    const cols = this._cols;
    const rows = this._rows;

    // ── Cell data texture (RG16UI) ──────────────────────────────────
    if (this._dataTexture) gl.deleteTexture(this._dataTexture);
    const dataTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, dataTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S,     gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T,     gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RG16UI, cols, rows, 0,
      gl.RG_INTEGER, gl.UNSIGNED_SHORT, this._cellData);
    this._dataTexture = dataTex;

    // ── CGA color index texture (R8 normalized) ─────────────────────
    // Using R8 (normalized float) instead of R8UI for broad Mesa/v3d compatibility.
    // The shader reads: int cgaIdx = int(texelFetch(...).r * 255.0 + 0.5)
    if (this._colorTexture) gl.deleteTexture(this._colorTexture);
    const colorTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, colorTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S,     gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T,     gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, cols, rows, 0,
      gl.RED, gl.UNSIGNED_BYTE, this._cellColor);
    this._colorTexture = colorTex;
  }

  // ── Debug helpers ────────────────────────────────────────────────────────

  /**
   * Write the glyph atlas to a visible <img> for debugging.
   * Call from console: window.renderer.debugAtlas()
   */
  debugAtlas() {
    if (!this._atlasCanvas) {
      console.warn('[V2Renderer] Atlas canvas not available');
      return;
    }
    const img = document.createElement('img');
    img.src = this._atlasCanvas.toDataURL();
    img.style.cssText = 'position:fixed;top:0;left:0;z-index:9999;border:2px solid lime;background:black;';
    img.title = 'Click to remove';
    img.onclick = () => img.remove();
    document.body.appendChild(img);
    console.log('[V2Renderer] Atlas debug image added to DOM — click to remove');
  }
}
