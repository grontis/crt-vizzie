//! AsciiRenderer — native port of `v2/renderer.js`.
//!
//! Builds a glyph atlas (baked from the web app, loaded from `assets/`), uploads per-cell data
//! textures (`RG16UI` charIdx+brightness, `R8` CGA index) each frame, and runs a single draw over
//! a full-screen triangle. The fragment shader is `renderer.js`'s `FRAG_SRC` with the game texture
//! folded in as a screen-blend composite (replacing the browser's CSS `mix-blend-mode: screen`).
//!
//! Cross-platform shader header: `#version 330 core` on Windows (desktop GL), `#version 300 es`
//! + precision qualifiers on the Pi (GLES3). The body is identical.

use std::collections::HashMap;

use glow::HasContext;
use serde::Deserialize;

const ATLAS_PNG: &[u8] = include_bytes!("../assets/atlas.png");
const ATLAS_JSON: &[u8] = include_bytes!("../assets/atlas.json");

#[derive(Deserialize)]
struct AtlasMetrics {
    cell_w: f32,
    cell_h: f32,
    tile_w: f32,
    tile_h: f32,
    atlas_cols: i32,
    atlas_rows: i32,
    atlas_tex_w: f32,
    atlas_tex_h: f32,
    charset: Vec<String>, // fusion char→index map: exposed via AsciiRenderer::charset().
}

#[cfg(windows)]
const SHADER_HEADER: &str = "#version 330 core\n";
#[cfg(not(windows))]
const SHADER_HEADER: &str =
    "#version 300 es\nprecision highp float;\nprecision highp int;\nprecision highp usampler2D;\n";

const VERT_BODY: &str = r#"
out vec2 v_uv;
void main() {
    // Full-screen triangle from gl_VertexID (no VBO) — same trick as quad.rs.
    vec2 p = vec2(float((gl_VertexID & 1) << 2) - 1.0,
                  float((gl_VertexID & 2) << 1) - 1.0);
    v_uv = p * 0.5 + 0.5;
    gl_Position = vec4(p, 0.0, 1.0);
}
"#;

const FRAG_BODY: &str = r#"
uniform sampler2D  u_glyphAtlas;
uniform usampler2D u_cellData;
uniform sampler2D  u_cellColor;
uniform sampler2D  u_maskTex;    // per-cell game mask: rgb = cell-center color, a = Sobel magnitude

uniform vec2  u_resolution;
uniform vec2  u_cellSize;
uniform ivec2 u_gridSize;
uniform vec2  u_atlasTileSize;
uniform ivec2 u_atlasDims;
uniform vec2  u_atlasTexSize;

uniform vec3  u_phosphorDim;
uniform vec3  u_phosphorMid;
uniform vec3  u_phosphorBright;
uniform float u_chromaOffset;
uniform float u_scanline;
uniform int   u_scanlineMode;
uniform vec3  u_cgaColors[16];

uniform sampler2D u_gameTex;
uniform vec2  u_gameUvScale;
uniform float u_gameFlip;
uniform float u_bgEnabled;
uniform float u_bgOpacity;

// The fusion animation, masked by the game's edges AND its dark/negative space.
uniform float u_edgeThreshold;   // min Sobel magnitude before a cell shows through
uniform float u_edgeGain;        // magnitude to mask scale (incl. beat boost)
uniform float u_darkThreshold;   // cells darker than this become animation space
uniform float u_darkLevel;       // max intensity (0..1) of the dark-space animation
uniform float u_activity;        // audio activity 0..1 (calm-idle: low = quiet/minimal)
uniform float u_glyphTint;       // 0 = phosphor/CGA color, 1 = game-contrast color
uniform float u_gamePresent;     // 1.0 when a game frame is bound, else 0.0

in  vec2 v_uv;
out vec4 fragColor;

vec3 rgb2hsv(vec3 c) {
  vec4 K = vec4(0.0, -1.0 / 3.0, 2.0 / 3.0, -1.0);
  vec4 p = mix(vec4(c.bg, K.wz), vec4(c.gb, K.xy), step(c.b, c.g));
  vec4 q = mix(vec4(p.xyw, c.r), vec4(c.r, p.yzx), step(p.x, c.r));
  float d = q.x - min(q.w, q.y);
  float e = 1.0e-10;
  return vec3(abs(q.z + (q.w - q.y) / (6.0 * d + e)), d / (q.x + e), q.x);
}
vec3 hsv2rgb(vec3 c) {
  vec4 K = vec4(1.0, 2.0 / 3.0, 1.0 / 3.0, 3.0);
  vec3 p = abs(fract(c.xxx + K.xyz) * 6.0 - K.www);
  return c.z * mix(K.xxx, clamp(p - K.xxx, 0.0, 1.0), c.y);
}

// A vivid color that contrasts the underlying game color: complementary hue, boosted
// saturation, kept bright so it pops through the screen-blend composite.
vec3 contrastColor(vec3 g) {
  vec3 hsv = rgb2hsv(g);
  hsv.x = fract(hsv.x + 0.5);
  hsv.y = clamp(hsv.y + 0.3, 0.35, 1.0);
  hsv.z = mix(0.7, 1.0, hsv.z);
  return hsv2rgb(hsv);
}

float sampleGlyph(int charIdx, vec2 fragInCell, float dxPixels) {
  int atlasCol = charIdx % u_atlasDims.x;
  int atlasRow = charIdx / u_atlasDims.x;
  vec2 tileOrigin = vec2(atlasCol, atlasRow) * u_atlasTileSize;
  vec2 glyphSamplePos = fragInCell + vec2(dxPixels + 1.0, 1.0);
  glyphSamplePos.x = clamp(glyphSamplePos.x, 1.0, u_atlasTileSize.x - 1.0);
  glyphSamplePos.y = clamp(glyphSamplePos.y, 1.0, u_atlasTileSize.y - 1.0);
  vec2 atlasPixelPos = tileOrigin + glyphSamplePos;
  return texture(u_glyphAtlas, atlasPixelPos / u_atlasTexSize).r;
}

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
  vec2 fragCoord = vec2(gl_FragCoord.x, u_resolution.y - gl_FragCoord.y);
  ivec2 cellPos = ivec2(fragCoord / u_cellSize);

  if (cellPos.x >= u_gridSize.x || cellPos.y >= u_gridSize.y || cellPos.x < 0 || cellPos.y < 0) {
    fragColor = vec4(0.0, 0.0, 0.0, 1.0);
    return;
  }

  // The glyph, brightness and color come from the fusion engine; we then gate that
  // animation by the game's edge structure + dark/negative space so the characters only
  // show along the on-screen shapes and fill the dark background.
  uvec4 data = texelFetch(u_cellData, cellPos, 0);
  int   charIdx = int(data.r);
  float bright  = float(data.g) / 65535.0;
  int   cgaIdx  = int(texelFetch(u_cellColor, cellPos, 0).r * 255.0 + 0.5);

  // Per-cell game mask, precomputed once per cell in the mask pre-pass (the renderer's mask
  // program): .rgb = cell-center game color, .a = cell-scale Sobel magnitude. This replaces a
  // 9-tap Sobel that would otherwise run identically for every fragment inside the same cell.
  vec4  maskCell = texelFetch(u_maskTex, cellPos, 0);
  vec3  cellGame = maskCell.rgb;
  float mag      = maskCell.a;
  float edge = clamp((mag - u_edgeThreshold) * u_edgeGain, 0.0, 1.0);
  // Dark/negative space is also animation space: the darker the cell, the more the animation
  // fills it. cm is the cell-center luma (from the mask's rgb); smoothstep gives a gentle ramp
  // from the threshold down to black.
  float cm   = dot(cellGame, vec3(0.299, 0.587, 0.114));
  // Calm-idle: the dark/negative-space fill recedes toward a low floor when there's little audio
  // activity, so silence shows minimal characters (the edge outline still reads).
  float idle = 0.15 + 0.85 * clamp(u_activity, 0.0, 1.0);
  float dark = idle * u_darkLevel * smoothstep(u_darkThreshold, 0.0, cm);
  bright *= max(edge, dark) * u_gamePresent;

  vec2 fragInCell = fragCoord - vec2(cellPos) * u_cellSize;

  float alphaG, alphaR, alphaB;
  if (bright < 0.01 || charIdx == 0) {
    alphaG = 0.0; alphaR = 0.0; alphaB = 0.0;
  } else {
    alphaG = sampleGlyph(charIdx, fragInCell,  0.0);
    alphaR = sampleGlyph(charIdx, fragInCell, -u_chromaOffset);
    alphaB = sampleGlyph(charIdx, fragInCell,  u_chromaOffset);
  }

  vec3 baseColor;
  if (cgaIdx > 0) {
    baseColor = u_cgaColors[cgaIdx] * max(0.3, bright);
  } else {
    baseColor = phosphorColor(bright);
  }
  // Optionally tint the glyph toward a color that contrasts the game underneath it, scaled by
  // the cell brightness so dim cells stay dim. u_glyphTint = 0 keeps the phosphor/CGA color.
  if (u_glyphTint > 0.0 && u_gamePresent > 0.5) {
    vec3 tinted = contrastColor(cellGame) * bright;
    baseColor = mix(baseColor, tinted, u_glyphTint);
  }
  vec3 color = vec3(baseColor.r * alphaR, baseColor.g * alphaG, baseColor.b * alphaB);

  float scanFactor = 1.0;
  if (u_scanlineMode == 1) {
    int pixRow = int(gl_FragCoord.y);
    if ((pixRow & 1) == 0) { scanFactor = 1.0 - u_scanline; }
  } else if (u_scanlineMode == 2) {
    float cellH = u_cellSize.y;
    float gapPx = cellH * 0.20;
    if (fragInCell.y >= (cellH - gapPx)) {
      float t = (fragInCell.y - (cellH - gapPx)) / gapPx;
      scanFactor = 1.0 - u_scanline * t;
    }
  } else if (u_scanlineMode == 3) {
    float phase = fragInCell.y / u_cellSize.y;
    float beam  = sin(phase * 3.14159265);
    scanFactor  = 1.0 - u_scanline * (1.0 - beam);
  }
  color *= scanFactor;

  // Game composite (replaces CSS mix-blend-mode: screen). Both modes draw their
  // glyphs over the live game frame: Fusion's figure/rain/glitch, or Edge's
  // contours traced from that same frame. The B key (u_bgEnabled) still toggles
  // the underlay off to fall back to glyphs-on-black.
  float game_vy = mix(v_uv.y, 1.0 - v_uv.y, u_gameFlip);
  vec3  game = texture(u_gameTex, vec2(v_uv.x * u_gameUvScale.x, game_vy * u_gameUvScale.y)).rgb * u_bgOpacity;
  vec3  outc = (u_bgEnabled > 0.5) ? (1.0 - (1.0 - game) * (1.0 - color)) : color;
  fragColor = vec4(outc, 1.0);
}
"#;

// Mask pre-pass: renders one texel per glyph cell (viewport == grid size). Each texel computes
// the cell-scale Sobel edge magnitude + the cell-center game color once, so the composite pass
// reads it with a single texelFetch instead of re-running the 9-tap Sobel per fragment. Reuses
// VERT_BODY (same full-screen triangle). Output: rgb = cell color, a = min(Sobel magnitude, 1).
const MASK_FRAG_BODY: &str = r#"
uniform sampler2D u_gameTex;
uniform vec2  u_gameUvScale;
uniform float u_gameFlip;
uniform ivec2 u_gridSize;

out vec4 fragColor;

// Color of the game frame at a [0,1] cell-space UV, honoring the same flip + uv-scale as the
// composite path so the mask lines up with what the composite draws.
vec3 gameColor(vec2 uv) {
  float vy = mix(uv.y, 1.0 - uv.y, u_gameFlip);
  return texture(u_gameTex, vec2(uv.x * u_gameUvScale.x, vy * u_gameUvScale.y)).rgb;
}
float gameLuma(vec2 uv) {
  return dot(gameColor(uv), vec3(0.299, 0.587, 0.114));
}

void main() {
  // gl_FragCoord.xy = cellPos + 0.5, so cuv == (cellPos + 0.5)/grid — identical to the cuv the
  // composite pass would compute for this cell. texel row r maps to composite cellPos.y == r.
  vec2 g   = vec2(u_gridSize);
  vec2 cuv = gl_FragCoord.xy / g;
  vec2 o   = 1.0 / g;
  float tl = gameLuma(cuv + vec2(-o.x, -o.y));
  float tm = gameLuma(cuv + vec2( 0.0, -o.y));
  float tr = gameLuma(cuv + vec2( o.x, -o.y));
  float ml = gameLuma(cuv + vec2(-o.x,  0.0));
  float mr = gameLuma(cuv + vec2( o.x,  0.0));
  float bl = gameLuma(cuv + vec2(-o.x,  o.y));
  float bm = gameLuma(cuv + vec2( 0.0,  o.y));
  float br = gameLuma(cuv + vec2( o.x,  o.y));
  float gx = (tr + 2.0 * mr + br) - (tl + 2.0 * ml + bl);
  float gy = (bl + 2.0 * bm + br) - (tl + 2.0 * tm + tr);
  float mag = length(vec2(gx, gy));
  // Store min(mag, 1.0) in 8-bit alpha: the composite's edge = clamp((mag - thr)*gain, 0, 1)
  // already saturates well below mag == 1 at the default threshold/gain, so nothing is lost.
  fragColor = vec4(gameColor(cuv), min(mag, 1.0));
}
"#;

pub struct AsciiRenderer {
    program: glow::NativeProgram,
    vao: glow::NativeVertexArray,
    atlas_tex: glow::NativeTexture,
    data_tex: glow::NativeTexture,  // RG16UI (charIdx, bright16)
    color_tex: glow::NativeTexture, // R8 normalized (CGA index)
    uniforms: HashMap<&'static str, glow::NativeUniformLocation>,
    mask_program: glow::NativeProgram,
    mask_fbo: glow::NativeFramebuffer,
    mask_tex: glow::NativeTexture, // RGBA8 (cell color rgb, Sobel magnitude a), one texel per cell
    mask_uniforms: HashMap<&'static str, glow::NativeUniformLocation>,
    m: AtlasMetrics,
    cols: usize,
    rows: usize,
    scratch: Vec<u8>, // RG16UI interleave, little-endian (n * 4 bytes)
}

impl AsciiRenderer {
    /// # Safety
    /// A current GL context must exist.
    pub unsafe fn new(gl: &glow::Context) -> Result<Self, String> {
        let m: AtlasMetrics = serde_json::from_slice(ATLAS_JSON).map_err(|e| e.to_string())?;

        // ── Atlas texture: decode the baked PNG, keep the red channel, upload as R8/LINEAR ──
        let img = image::load_from_memory(ATLAS_PNG)
            .map_err(|e| e.to_string())?
            .into_rgba8();
        let (aw, ah) = (img.width() as i32, img.height() as i32);
        let r_data: Vec<u8> = img.pixels().map(|p| p.0[0]).collect();

        let atlas_tex = gl.create_texture()?;
        gl.bind_texture(glow::TEXTURE_2D, Some(atlas_tex));
        gl.tex_parameter_i32(glow::TEXTURE_2D, glow::TEXTURE_WRAP_S, glow::CLAMP_TO_EDGE as i32);
        gl.tex_parameter_i32(glow::TEXTURE_2D, glow::TEXTURE_WRAP_T, glow::CLAMP_TO_EDGE as i32);
        gl.tex_parameter_i32(glow::TEXTURE_2D, glow::TEXTURE_MIN_FILTER, glow::LINEAR as i32);
        gl.tex_parameter_i32(glow::TEXTURE_2D, glow::TEXTURE_MAG_FILTER, glow::LINEAR as i32);
        gl.tex_image_2d(glow::TEXTURE_2D, 0, glow::R8 as i32, aw, ah, 0,
            glow::RED, glow::UNSIGNED_BYTE, Some(&r_data));

        // ── Data textures: integer (RG16UI) and normalized (R8), both NEAREST ──
        let data_tex = make_data_tex(gl)?;
        let color_tex = make_data_tex(gl)?;

        // ── Program ──
        let vert = format!("{SHADER_HEADER}{VERT_BODY}");
        let frag = format!("{SHADER_HEADER}{FRAG_BODY}");
        let program = link(gl, &vert, &frag)?;

        let names = [
            "u_glyphAtlas", "u_cellData", "u_cellColor", "u_maskTex", "u_resolution", "u_cellSize", "u_gridSize",
            "u_atlasTileSize", "u_atlasDims", "u_atlasTexSize", "u_phosphorDim", "u_phosphorMid",
            "u_phosphorBright", "u_chromaOffset", "u_scanline", "u_scanlineMode", "u_cgaColors",
            "u_gameTex", "u_gameUvScale", "u_gameFlip", "u_bgEnabled", "u_bgOpacity",
            "u_edgeThreshold", "u_edgeGain", "u_darkThreshold", "u_darkLevel", "u_activity",
            "u_glyphTint", "u_gamePresent",
        ];
        let mut uniforms = HashMap::new();
        for n in names {
            if let Some(loc) = gl.get_uniform_location(program, n) {
                uniforms.insert(n, loc);
            }
        }

        // CGA palette is immutable — upload once (persists in the program object).
        let mut flat = [0.0f32; 48];
        for i in 0..16 {
            flat[i * 3] = crate::config::CGA_COLORS[i][0];
            flat[i * 3 + 1] = crate::config::CGA_COLORS[i][1];
            flat[i * 3 + 2] = crate::config::CGA_COLORS[i][2];
        }
        gl.use_program(Some(program));
        gl.uniform_3_f32_slice(uniforms.get("u_cgaColors"), &flat);
        gl.use_program(None);

        let vao = gl.create_vertex_array()?;

        // ── Mask pre-pass: program + per-cell RGBA8 texture + its FBO ──
        let mask_program = link(gl, &vert, &format!("{SHADER_HEADER}{MASK_FRAG_BODY}"))?;
        let mut mask_uniforms = HashMap::new();
        for n in ["u_gameTex", "u_gameUvScale", "u_gameFlip", "u_gridSize"] {
            if let Some(loc) = gl.get_uniform_location(mask_program, n) {
                mask_uniforms.insert(n, loc);
            }
        }
        let mask_tex = make_data_tex(gl)?; // NEAREST — sampled via texelFetch at cell resolution
        gl.bind_texture(glow::TEXTURE_2D, Some(mask_tex));
        gl.tex_image_2d(glow::TEXTURE_2D, 0, glow::RGBA8 as i32, 1, 1, 0,
            glow::RGBA, glow::UNSIGNED_BYTE, None);
        let mask_fbo = gl.create_framebuffer()?;
        gl.bind_framebuffer(glow::FRAMEBUFFER, Some(mask_fbo));
        gl.framebuffer_texture_2d(
            glow::FRAMEBUFFER, glow::COLOR_ATTACHMENT0, glow::TEXTURE_2D, Some(mask_tex), 0,
        );
        gl.bind_framebuffer(glow::FRAMEBUFFER, None);

        println!(
            "[renderer] atlas loaded: {}x{} tiles, cell {}x{}, texture {}x{}",
            m.atlas_cols, m.atlas_rows, m.cell_w, m.cell_h, aw, ah
        );

        Ok(Self {
            program, vao, atlas_tex, data_tex, color_tex, uniforms,
            mask_program, mask_fbo, mask_tex, mask_uniforms, m,
            cols: 0, rows: 0, scratch: Vec::new(),
        })
    }

    pub fn cols(&self) -> usize { self.cols }
    pub fn rows(&self) -> usize { self.rows }

    /// Return the ordered charset array from atlas.json.
    /// Each element is a single-character String; index = atlas glyph index.
    pub fn charset(&self) -> &[String] {
        &self.m.charset
    }

    /// Recompute grid from window size and (re)allocate the data textures + scratch buffer.
    /// # Safety: a current GL context must exist.
    pub unsafe fn resize(&mut self, gl: &glow::Context, win_w: u32, win_h: u32) {
        self.cols = (win_w as f32 / self.m.cell_w).floor() as usize;
        self.rows = (win_h as f32 / self.m.cell_h).floor() as usize;
        let n = self.cols * self.rows;
        self.scratch = vec![0u8; n * 4];

        gl.bind_texture(glow::TEXTURE_2D, Some(self.data_tex));
        gl.tex_image_2d(glow::TEXTURE_2D, 0, glow::RG16UI as i32, self.cols as i32, self.rows as i32,
            0, glow::RG_INTEGER, glow::UNSIGNED_SHORT, None);
        gl.bind_texture(glow::TEXTURE_2D, Some(self.color_tex));
        gl.tex_image_2d(glow::TEXTURE_2D, 0, glow::R8 as i32, self.cols as i32, self.rows as i32,
            0, glow::RED, glow::UNSIGNED_BYTE, None);
        // Mask texture is one texel per cell — same grid dimensions as the data textures.
        gl.bind_texture(glow::TEXTURE_2D, Some(self.mask_tex));
        gl.tex_image_2d(glow::TEXTURE_2D, 0, glow::RGBA8 as i32, self.cols as i32, self.rows as i32,
            0, glow::RGBA, glow::UNSIGNED_BYTE, None);

        println!("[renderer] grid {}x{} ({} cells)", self.cols, self.rows, n);
    }

    /// Upload the three per-cell arrays to the data textures.
    /// # Safety: a current GL context must exist; slices must be length cols*rows.
    pub unsafe fn upload(&mut self, gl: &glow::Context, char_idx: &[u16], bright16: &[u16], cga_idx: &[u8]) {
        let n = self.cols * self.rows;
        // Pack charIdx+bright16 as interleaved little-endian u16s (GL reads UNSIGNED_SHORT, native LE).
        for i in 0..n {
            let c = char_idx[i].to_le_bytes();
            let b = bright16[i].to_le_bytes();
            self.scratch[i * 4] = c[0];
            self.scratch[i * 4 + 1] = c[1];
            self.scratch[i * 4 + 2] = b[0];
            self.scratch[i * 4 + 3] = b[1];
        }
        // Storage is allocated once in resize(); update in place (tex_sub_image_2d) each frame —
        // the realloc form (tex_image_2d) can stall/re-validate on the V3D/Mesa driver.
        gl.bind_texture(glow::TEXTURE_2D, Some(self.data_tex));
        gl.tex_sub_image_2d(glow::TEXTURE_2D, 0, 0, 0, self.cols as i32, self.rows as i32,
            glow::RG_INTEGER, glow::UNSIGNED_SHORT, glow::PixelUnpackData::Slice(&self.scratch));
        gl.bind_texture(glow::TEXTURE_2D, Some(self.color_tex));
        gl.tex_sub_image_2d(glow::TEXTURE_2D, 0, 0, 0, self.cols as i32, self.rows as i32,
            glow::RED, glow::UNSIGNED_BYTE, glow::PixelUnpackData::Slice(cga_idx));
    }

    /// Mask pre-pass: compute the per-cell game edge/dark mask + cell color into `mask_tex`
    /// (one texel per cell), so `render`'s composite shader reads it with a single texelFetch
    /// instead of re-running the 9-tap Sobel per fragment. Only meaningful when a game frame is
    /// bound; callers skip it otherwise. Must run before `render` (which rebinds the scene FBO).
    /// # Safety: a current GL context must exist.
    pub unsafe fn render_mask(
        &self,
        gl: &glow::Context,
        game_tex: glow::NativeTexture,
        game_sx: f32,
        game_sy: f32,
        game_flip: f32,
    ) {
        gl.bind_framebuffer(glow::FRAMEBUFFER, Some(self.mask_fbo));
        gl.viewport(0, 0, self.cols as i32, self.rows as i32);
        gl.use_program(Some(self.mask_program));

        gl.active_texture(glow::TEXTURE0);
        gl.bind_texture(glow::TEXTURE_2D, Some(game_tex));
        gl.uniform_1_i32(self.mask_uniforms.get("u_gameTex"), 0);
        gl.uniform_2_f32(self.mask_uniforms.get("u_gameUvScale"), game_sx, game_sy);
        gl.uniform_1_f32(self.mask_uniforms.get("u_gameFlip"), game_flip);
        gl.uniform_2_i32(self.mask_uniforms.get("u_gridSize"), self.cols as i32, self.rows as i32);

        gl.disable(glow::DEPTH_TEST);
        gl.disable(glow::SCISSOR_TEST);
        gl.disable(glow::BLEND);
        gl.bind_vertex_array(Some(self.vao));
        gl.draw_arrays(glow::TRIANGLES, 0, 3);
        gl.bind_vertex_array(None);
        gl.use_program(None);
    }

    /// Set uniforms, bind textures, single draw. `game_tex=None` → ASCII on black.
    /// # Safety: a current GL context must exist.
    #[allow(clippy::too_many_arguments)]
    pub unsafe fn render(
        &self,
        gl: &glow::Context,
        params: &crate::config::Params,
        game_tex: Option<glow::NativeTexture>,
        game_sx: f32,
        game_sy: f32,
        game_flip: f32,
        win_w: u32,
        win_h: u32,
        activity: f32,
    ) {
        gl.use_program(Some(self.program));

        gl.active_texture(glow::TEXTURE0);
        gl.bind_texture(glow::TEXTURE_2D, Some(self.atlas_tex));
        gl.uniform_1_i32(self.u("u_glyphAtlas"), 0);
        gl.active_texture(glow::TEXTURE1);
        gl.bind_texture(glow::TEXTURE_2D, Some(self.data_tex));
        gl.uniform_1_i32(self.u("u_cellData"), 1);
        gl.active_texture(glow::TEXTURE2);
        gl.bind_texture(glow::TEXTURE_2D, Some(self.color_tex));
        gl.uniform_1_i32(self.u("u_cellColor"), 2);

        // Game on unit 3; bind atlas as a harmless fallback when there's no game frame.
        let bg_enabled = if game_tex.is_some() && params.bg_enabled { 1.0 } else { 0.0 };
        gl.active_texture(glow::TEXTURE3);
        gl.bind_texture(glow::TEXTURE_2D, Some(game_tex.unwrap_or(self.atlas_tex)));
        gl.uniform_1_i32(self.u("u_gameTex"), 3);

        // Per-cell game mask from render_mask(). When there's no game frame the mask is stale,
        // but u_gamePresent (0.0) zeroes its contribution, so its contents don't matter.
        gl.active_texture(glow::TEXTURE4);
        gl.bind_texture(glow::TEXTURE_2D, Some(self.mask_tex));
        gl.uniform_1_i32(self.u("u_maskTex"), 4);

        gl.uniform_2_f32(self.u("u_resolution"), win_w as f32, win_h as f32);
        gl.uniform_2_f32(self.u("u_cellSize"), self.m.cell_w, self.m.cell_h);
        gl.uniform_2_i32(self.u("u_gridSize"), self.cols as i32, self.rows as i32);
        gl.uniform_2_f32(self.u("u_atlasTileSize"), self.m.tile_w, self.m.tile_h);
        gl.uniform_2_i32(self.u("u_atlasDims"), self.m.atlas_cols, self.m.atlas_rows);
        gl.uniform_2_f32(self.u("u_atlasTexSize"), self.m.atlas_tex_w, self.m.atlas_tex_h);

        let ph = &crate::config::PHOSPHORS[params.phosphor_index % crate::config::PHOSPHORS.len()];
        gl.uniform_3_f32(self.u("u_phosphorDim"), ph.dim[0], ph.dim[1], ph.dim[2]);
        gl.uniform_3_f32(self.u("u_phosphorMid"), ph.mid[0], ph.mid[1], ph.mid[2]);
        gl.uniform_3_f32(self.u("u_phosphorBright"), ph.bright[0], ph.bright[1], ph.bright[2]);

        gl.uniform_1_f32(self.u("u_chromaOffset"), params.chroma_base + params.chroma_beat_current);
        gl.uniform_1_f32(self.u("u_scanline"), params.scanline_intensity);
        gl.uniform_1_i32(self.u("u_scanlineMode"), params.scanline_mode);

        gl.uniform_2_f32(self.u("u_gameUvScale"), game_sx, game_sy);
        gl.uniform_1_f32(self.u("u_gameFlip"), game_flip);
        gl.uniform_1_f32(self.u("u_bgEnabled"), bg_enabled);
        gl.uniform_1_f32(self.u("u_bgOpacity"), params.bg_opacity);

        // The shader gates fusion's brightness by the game's edges and its dark/negative space.
        gl.uniform_1_f32(self.u("u_edgeThreshold"), params.edge_threshold);
        gl.uniform_1_f32(self.u("u_edgeGain"), params.edge_gain + params.edge_beat_current);
        gl.uniform_1_f32(self.u("u_darkThreshold"), params.edge_dark_threshold);
        gl.uniform_1_f32(self.u("u_darkLevel"), params.edge_dark_level);
        gl.uniform_1_f32(self.u("u_activity"), activity);
        gl.uniform_1_f32(self.u("u_glyphTint"), params.glyph_tint);
        gl.uniform_1_f32(self.u("u_gamePresent"), if game_tex.is_some() { 1.0 } else { 0.0 });

        gl.disable(glow::DEPTH_TEST);
        gl.disable(glow::SCISSOR_TEST);
        gl.disable(glow::BLEND);
        gl.bind_vertex_array(Some(self.vao));
        gl.draw_arrays(glow::TRIANGLES, 0, 3);
        gl.bind_vertex_array(None);
        gl.use_program(None);
    }

    fn u(&self, name: &str) -> Option<&glow::NativeUniformLocation> {
        self.uniforms.get(name)
    }
}

unsafe fn make_data_tex(gl: &glow::Context) -> Result<glow::NativeTexture, String> {
    let t = gl.create_texture()?;
    gl.bind_texture(glow::TEXTURE_2D, Some(t));
    gl.tex_parameter_i32(glow::TEXTURE_2D, glow::TEXTURE_WRAP_S, glow::CLAMP_TO_EDGE as i32);
    gl.tex_parameter_i32(glow::TEXTURE_2D, glow::TEXTURE_WRAP_T, glow::CLAMP_TO_EDGE as i32);
    gl.tex_parameter_i32(glow::TEXTURE_2D, glow::TEXTURE_MIN_FILTER, glow::NEAREST as i32);
    gl.tex_parameter_i32(glow::TEXTURE_2D, glow::TEXTURE_MAG_FILTER, glow::NEAREST as i32);
    Ok(t)
}

unsafe fn link(gl: &glow::Context, vsrc: &str, fsrc: &str) -> Result<glow::NativeProgram, String> {
    let vs = compile(gl, glow::VERTEX_SHADER, vsrc)?;
    let fs = compile(gl, glow::FRAGMENT_SHADER, fsrc)?;
    let program = gl.create_program()?;
    gl.attach_shader(program, vs);
    gl.attach_shader(program, fs);
    gl.link_program(program);
    let ok = gl.get_program_link_status(program);
    let log = gl.get_program_info_log(program);
    gl.delete_shader(vs);
    gl.delete_shader(fs);
    if !ok {
        return Err(format!("link error: {log}"));
    }
    Ok(program)
}

unsafe fn compile(gl: &glow::Context, ty: u32, src: &str) -> Result<glow::NativeShader, String> {
    let shader = gl.create_shader(ty)?;
    gl.shader_source(shader, src);
    gl.compile_shader(shader);
    if !gl.get_shader_compile_status(shader) {
        let log = gl.get_shader_info_log(shader);
        gl.delete_shader(shader);
        return Err(format!("compile error: {log}"));
    }
    Ok(shader)
}
