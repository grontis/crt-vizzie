#version 300 es
// v2/shaders/frag.glsl — ASCII grid fragment shader
// SOURCE REFERENCE ONLY — the runtime version is inlined in renderer.js (FRAG_SRC).
// Reason: avoids fetch() CORS issues when serving from file:// or bare http.server.

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
uniform vec2  u_resolution;    // canvas width, height in pixels
uniform vec2  u_cellSize;      // cell width, height in pixels
uniform ivec2 u_gridSize;      // grid cols, rows
uniform vec2  u_atlasTileSize; // atlas tile width, height in pixels (includes padding)
uniform ivec2 u_atlasDims;     // atlas layout in tiles: (cols, rows)
uniform vec2  u_atlasTexSize;  // atlas texture pixel size

// ── Visual uniforms ─────────────────────────────────────────────────
uniform vec3  u_phosphorDim;
uniform vec3  u_phosphorMid;
uniform vec3  u_phosphorBright;
uniform float u_chromaOffset;    // pixel shift for R and B channels
uniform float u_scanline;        // scanline darkening (0 = off, 1 = full dark)
uniform vec3  u_cgaColors[16];   // CGA 16-color palette

in  vec2 v_uv;
out vec4 fragColor;

// ── Helpers ──────────────────────────────────────────────────────────

// Sample the glyph atlas at a given charIdx, offset by dxPixels from the
// natural fragment position within the cell.
// Each tile has 1px padding on left+top sides (drawn at offset +1,+1).
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

  ivec2 cellPos = ivec2(fragCoord / u_cellSize);

  if (cellPos.x >= u_gridSize.x || cellPos.y >= u_gridSize.y ||
      cellPos.x < 0 || cellPos.y < 0) {
    fragColor = vec4(0.0, 0.0, 0.0, 1.0);
    return;
  }

  uvec4 data    = texelFetch(u_cellData, cellPos, 0);
  int   charIdx = int(data.r);
  float bright  = float(data.g) / 65535.0;

  // Fetch CGA color index: R8 normalized float, scale back to integer index
  int cgaIdx = int(texelFetch(u_cellColor, cellPos, 0).r * 255.0 + 0.5);

  vec2 fragInCell = fragCoord - vec2(cellPos) * u_cellSize;

  float alphaG, alphaR, alphaB;
  if (bright < 0.01 || charIdx == 0) {
    alphaG = 0.0; alphaR = 0.0; alphaB = 0.0;
  } else {
    alphaG = sampleGlyph(charIdx, cellPos, fragInCell,  0.0);
    alphaR = sampleGlyph(charIdx, cellPos, fragInCell, -u_chromaOffset);
    alphaB = sampleGlyph(charIdx, cellPos, fragInCell,  u_chromaOffset);
  }

  vec3 baseColor;
  if (cgaIdx > 0) {
    baseColor = u_cgaColors[cgaIdx] * max(0.3, bright);
  } else {
    baseColor = phosphorColor(bright);
  }

  vec3 color = vec3(
    baseColor.r * alphaR,
    baseColor.g * alphaG,
    baseColor.b * alphaB
  );

  float scanFactor = 1.0;
  if (u_scanline > 0.0) {
    int pixRow = int(gl_FragCoord.y);
    if ((pixRow & 1) == 0) {
      scanFactor = 1.0 - u_scanline;
    }
  }
  color *= scanFactor;

  fragColor = vec4(color, 1.0);
}
