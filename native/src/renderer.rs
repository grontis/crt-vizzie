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
    charset: Vec<String>, // Phase 2 (fusion char→index map): exposed via AsciiRenderer::charset().
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

in  vec2 v_uv;
out vec4 fragColor;

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

  uvec4 data = texelFetch(u_cellData, cellPos, 0);
  int   charIdx = int(data.r);
  float bright  = float(data.g) / 65535.0;
  int   cgaIdx  = int(texelFetch(u_cellColor, cellPos, 0).r * 255.0 + 0.5);

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

  // Game composite (replaces CSS mix-blend-mode: screen).
  float game_vy = mix(v_uv.y, 1.0 - v_uv.y, u_gameFlip);
  vec3  game = texture(u_gameTex, vec2(v_uv.x * u_gameUvScale.x, game_vy * u_gameUvScale.y)).rgb * u_bgOpacity;
  vec3  outc = (u_bgEnabled > 0.5) ? (1.0 - (1.0 - game) * (1.0 - color)) : color;
  fragColor = vec4(outc, 1.0);
}
"#;

pub struct AsciiRenderer {
    program: glow::NativeProgram,
    vao: glow::NativeVertexArray,
    atlas_tex: glow::NativeTexture,
    data_tex: glow::NativeTexture,  // RG16UI (charIdx, bright16)
    color_tex: glow::NativeTexture, // R8 normalized (CGA index)
    uniforms: HashMap<&'static str, glow::NativeUniformLocation>,
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
            "u_glyphAtlas", "u_cellData", "u_cellColor", "u_resolution", "u_cellSize", "u_gridSize",
            "u_atlasTileSize", "u_atlasDims", "u_atlasTexSize", "u_phosphorDim", "u_phosphorMid",
            "u_phosphorBright", "u_chromaOffset", "u_scanline", "u_scanlineMode", "u_cgaColors",
            "u_gameTex", "u_gameUvScale", "u_gameFlip", "u_bgEnabled", "u_bgOpacity",
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

        println!(
            "[renderer] atlas loaded: {}x{} tiles, cell {}x{}, texture {}x{}",
            m.atlas_cols, m.atlas_rows, m.cell_w, m.cell_h, aw, ah
        );

        Ok(Self {
            program, vao, atlas_tex, data_tex, color_tex, uniforms, m,
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
        gl.bind_texture(glow::TEXTURE_2D, Some(self.data_tex));
        gl.tex_image_2d(glow::TEXTURE_2D, 0, glow::RG16UI as i32, self.cols as i32, self.rows as i32,
            0, glow::RG_INTEGER, glow::UNSIGNED_SHORT, Some(&self.scratch));
        gl.bind_texture(glow::TEXTURE_2D, Some(self.color_tex));
        gl.tex_image_2d(glow::TEXTURE_2D, 0, glow::R8 as i32, self.cols as i32, self.rows as i32,
            0, glow::RED, glow::UNSIGNED_BYTE, Some(cga_idx));
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
