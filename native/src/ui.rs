//! Minimal immediate-mode debug overlay — draggable sliders for live-tuning params.
//!
//! This is a Windows dev tool for feeling out values while the app runs; it is not part of the
//! kiosk UX. It draws its own colored + textured quads via a tiny shader and reuses the baked
//! glyph atlas (same bytes as `renderer.rs`) for text. Mouse drag is fed in from the SDL event
//! pump in `main.rs`. Toggle visibility with the U key.

use glow::HasContext;
use serde::Deserialize;

const ATLAS_PNG: &[u8] = include_bytes!("../assets/atlas.png");
const ATLAS_JSON: &[u8] = include_bytes!("../assets/atlas.json");

#[cfg(windows)]
const SHADER_HEADER: &str = "#version 330 core\n";
#[cfg(not(windows))]
const SHADER_HEADER: &str = "#version 300 es\nprecision mediump float;\n";

const VERT_SRC: &str = r#"
layout(location = 0) in vec2 a_pos;   // pixels, top-left origin
layout(location = 1) in vec2 a_uv;
layout(location = 2) in vec4 a_color;
uniform vec2 u_viewport;
out vec2 v_uv;
out vec4 v_color;
void main() {
  vec2 ndc = vec2(a_pos.x / u_viewport.x * 2.0 - 1.0,
                  1.0 - a_pos.y / u_viewport.y * 2.0);
  gl_Position = vec4(ndc, 0.0, 1.0);
  v_uv = a_uv;
  v_color = a_color;
}
"#;

const FRAG_SRC: &str = r#"
uniform sampler2D u_tex;
uniform float u_useTex;
in vec2 v_uv;
in vec4 v_color;
out vec4 fragColor;
void main() {
  if (u_useTex > 0.5) {
    float a = texture(u_tex, v_uv).r;   // atlas is single-channel coverage
    fragColor = vec4(v_color.rgb, v_color.a * a);
  } else {
    fragColor = v_color;
  }
}
"#;

#[derive(Deserialize)]
struct AtlasMeta {
    cell_w: f32,
    tile_w: f32,
    tile_h: f32,
    atlas_cols: i32,
    atlas_tex_w: f32,
    atlas_tex_h: f32,
    charset: Vec<String>,
}

/// Which `Params` field a slider drives.
#[derive(Clone, Copy, PartialEq)]
enum SliderId {
    EdgeThreshold,
    EdgeGain,
    EdgeBeatBoost,
    EdgeDarkThreshold,
    EdgeDarkLevel,
}

struct SliderDef {
    id: SliderId,
    label: &'static str,
    min: f32,
    max: f32,
}

const SLIDERS: &[SliderDef] = &[
    SliderDef { id: SliderId::EdgeThreshold,     label: "edge_threshold",     min: 0.0, max: 0.5 },
    SliderDef { id: SliderId::EdgeGain,          label: "edge_gain",          min: 0.0, max: 16.0 },
    SliderDef { id: SliderId::EdgeBeatBoost,     label: "edge_beat_boost",    min: 0.0, max: 4.0 },
    SliderDef { id: SliderId::EdgeDarkThreshold, label: "edge_dark_threshold", min: 0.0, max: 1.0 },
    SliderDef { id: SliderId::EdgeDarkLevel,     label: "edge_dark_level",     min: 0.0, max: 1.0 },
];

// ── Panel layout (pixels) ───────────────────────────────────────────────────────
const PANEL_X: f32 = 20.0;
const PANEL_Y: f32 = 20.0;
const PANEL_W: f32 = 440.0;
const ROW_H: f32 = 52.0;
const PAD: f32 = 14.0;
const TRACK_X: f32 = PANEL_X + PAD;
const TRACK_W: f32 = PANEL_W - 2.0 * PAD;
const TRACK_H: f32 = 10.0;
const KNOB_W: f32 = 12.0;
const TEXT_PX: f32 = 16.0;

fn get_param(params: &crate::config::Params, id: SliderId) -> f32 {
    match id {
        SliderId::EdgeThreshold => params.edge_threshold,
        SliderId::EdgeGain => params.edge_gain,
        SliderId::EdgeBeatBoost => params.edge_beat_boost,
        SliderId::EdgeDarkThreshold => params.edge_dark_threshold,
        SliderId::EdgeDarkLevel => params.edge_dark_level,
    }
}

fn set_param(params: &mut crate::config::Params, id: SliderId, v: f32) {
    match id {
        SliderId::EdgeThreshold => params.edge_threshold = v,
        SliderId::EdgeGain => params.edge_gain = v,
        SliderId::EdgeBeatBoost => params.edge_beat_boost = v,
        SliderId::EdgeDarkThreshold => params.edge_dark_threshold = v,
        SliderId::EdgeDarkLevel => params.edge_dark_level = v,
    }
}

/// y of the top of slider `i`'s track.
fn track_y(i: usize) -> f32 {
    PANEL_Y + PAD + i as f32 * ROW_H + TEXT_PX + 6.0
}

pub struct DebugUi {
    program: glow::NativeProgram,
    vao: glow::NativeVertexArray,
    vbo: glow::NativeBuffer,
    atlas_tex: glow::NativeTexture,
    u_viewport: Option<glow::NativeUniformLocation>,
    u_tex: Option<glow::NativeUniformLocation>,
    u_use_tex: Option<glow::NativeUniformLocation>,
    m: AtlasMeta,
    char_map: std::collections::HashMap<char, i32>,
    verts: Vec<f32>, // scratch, rebuilt each frame
    pub visible: bool,
    dragging: Option<usize>, // index into SLIDERS
}

impl DebugUi {
    /// # Safety: a current GL context must exist.
    pub unsafe fn new(gl: &glow::Context) -> Result<Self, String> {
        let m: AtlasMeta = serde_json::from_slice(ATLAS_JSON).map_err(|e| e.to_string())?;
        let char_map = m
            .charset
            .iter()
            .enumerate()
            .filter_map(|(i, s)| s.chars().next().map(|c| (c, i as i32)))
            .collect();

        // Atlas texture (single red channel, LINEAR for smooth small text).
        let img = image::load_from_memory(ATLAS_PNG).map_err(|e| e.to_string())?.into_rgba8();
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

        let program = link(gl, &format!("{SHADER_HEADER}{VERT_SRC}"),
                               &format!("{SHADER_HEADER}{FRAG_SRC}"))?;
        let u_viewport = gl.get_uniform_location(program, "u_viewport");
        let u_tex = gl.get_uniform_location(program, "u_tex");
        let u_use_tex = gl.get_uniform_location(program, "u_useTex");

        let vao = gl.create_vertex_array()?;
        let vbo = gl.create_buffer()?;
        gl.bind_vertex_array(Some(vao));
        gl.bind_buffer(glow::ARRAY_BUFFER, Some(vbo));
        let stride = 8 * 4; // pos(2) + uv(2) + color(4), f32
        gl.enable_vertex_attrib_array(0);
        gl.vertex_attrib_pointer_f32(0, 2, glow::FLOAT, false, stride, 0);
        gl.enable_vertex_attrib_array(1);
        gl.vertex_attrib_pointer_f32(1, 2, glow::FLOAT, false, stride, 2 * 4);
        gl.enable_vertex_attrib_array(2);
        gl.vertex_attrib_pointer_f32(2, 4, glow::FLOAT, false, stride, 4 * 4);
        gl.bind_vertex_array(None);

        Ok(Self {
            program, vao, vbo, atlas_tex, u_viewport, u_tex, u_use_tex, m, char_map,
            verts: Vec::new(), visible: true, dragging: None,
        })
    }

    pub fn toggle(&mut self) {
        self.visible = !self.visible;
    }

    /// Feed an SDL event; updates `params` while dragging a slider. Returns true if the event
    /// was consumed by the UI (so the caller can skip other handling for it).
    pub fn handle_event(&mut self, event: &sdl2::event::Event, params: &mut crate::config::Params) -> bool {
        use sdl2::event::Event;
        use sdl2::mouse::MouseButton;
        if !self.visible {
            return false;
        }
        match event {
            Event::MouseButtonDown { mouse_btn: MouseButton::Left, x, y, .. } => {
                let (mx, my) = (*x as f32, *y as f32);
                for (i, s) in SLIDERS.iter().enumerate() {
                    let ty = track_y(i);
                    // Generous vertical hit area around the track.
                    if mx >= TRACK_X - KNOB_W && mx <= TRACK_X + TRACK_W + KNOB_W
                        && my >= ty - 8.0 && my <= ty + TRACK_H + 8.0
                    {
                        self.dragging = Some(i);
                        self.set_from_mouse(i, mx, s, params);
                        return true;
                    }
                }
                false
            }
            Event::MouseMotion { x, .. } if self.dragging.is_some() => {
                let i = self.dragging.unwrap();
                self.set_from_mouse(i, *x as f32, &SLIDERS[i], params);
                true
            }
            Event::MouseButtonUp { mouse_btn: MouseButton::Left, .. } if self.dragging.is_some() => {
                self.dragging = None;
                true
            }
            _ => false,
        }
    }

    fn set_from_mouse(&self, _i: usize, mx: f32, s: &SliderDef, params: &mut crate::config::Params) {
        let t = ((mx - TRACK_X) / TRACK_W).clamp(0.0, 1.0);
        set_param(params, s.id, s.min + t * (s.max - s.min));
    }

    /// Draw the panel. # Safety: a current GL context must exist.
    pub unsafe fn render(&mut self, gl: &glow::Context, params: &crate::config::Params, win_w: u32, win_h: u32) {
        if !self.visible {
            return;
        }
        self.verts.clear();

        // Panel background.
        let panel_h = PAD * 2.0 + SLIDERS.len() as f32 * ROW_H;
        push_rect(&mut self.verts, PANEL_X, PANEL_Y, PANEL_W, panel_h, [0.0, 0.0, 0.0, 0.62]);

        // Sliders (solid geometry only here; text is batched separately below).
        for (i, s) in SLIDERS.iter().enumerate() {
            let ty = track_y(i);
            let val = get_param(params, s.id);
            let t = ((val - s.min) / (s.max - s.min)).clamp(0.0, 1.0);
            // Track, fill, knob.
            push_rect(&mut self.verts, TRACK_X, ty, TRACK_W, TRACK_H, [0.18, 0.18, 0.18, 0.9]);
            push_rect(&mut self.verts, TRACK_X, ty, TRACK_W * t, TRACK_H, [0.0, 0.8, 0.32, 0.95]);
            let kx = TRACK_X + TRACK_W * t - KNOB_W * 0.5;
            push_rect(&mut self.verts, kx, ty - 4.0, KNOB_W, TRACK_H + 8.0, [0.85, 1.0, 0.88, 1.0]);
        }
        let solid_count = self.verts.len() / 8;

        // Text (label + value) batched after the solids.
        let scale = TEXT_PX / self.m.tile_h;
        let text_color = [0.65, 1.0, 0.72, 1.0];
        for (i, s) in SLIDERS.iter().enumerate() {
            let label_y = PANEL_Y + PAD + i as f32 * ROW_H;
            let val = get_param(params, s.id);
            let line = format!("{}: {:.3}", s.label, val);
            self.push_text(&line, PANEL_X + PAD, label_y, scale, text_color);
        }
        let text_count = self.verts.len() / 8 - solid_count;

        // Upload + draw.
        gl.use_program(Some(self.program));
        gl.bind_vertex_array(Some(self.vao));
        gl.bind_buffer(glow::ARRAY_BUFFER, Some(self.vbo));
        let bytes = std::slice::from_raw_parts(self.verts.as_ptr() as *const u8, self.verts.len() * 4);
        gl.buffer_data_u8_slice(glow::ARRAY_BUFFER, bytes, glow::DYNAMIC_DRAW);

        gl.uniform_2_f32(self.u_viewport.as_ref(), win_w as f32, win_h as f32);
        gl.active_texture(glow::TEXTURE0);
        gl.bind_texture(glow::TEXTURE_2D, Some(self.atlas_tex));
        gl.uniform_1_i32(self.u_tex.as_ref(), 0);

        gl.enable(glow::BLEND);
        gl.blend_func(glow::SRC_ALPHA, glow::ONE_MINUS_SRC_ALPHA);
        gl.disable(glow::DEPTH_TEST);

        // Pass 1: solids.
        gl.uniform_1_f32(self.u_use_tex.as_ref(), 0.0);
        gl.draw_arrays(glow::TRIANGLES, 0, solid_count as i32);
        // Pass 2: text.
        gl.uniform_1_f32(self.u_use_tex.as_ref(), 1.0);
        gl.draw_arrays(glow::TRIANGLES, solid_count as i32, text_count as i32);

        gl.disable(glow::BLEND);
        gl.bind_vertex_array(None);
        gl.use_program(None);
    }

    /// Append textured quads for `text` at pixel (x, y), top-left origin.
    fn push_text(&mut self, text: &str, x: f32, y: f32, scale: f32, color: [f32; 4]) {
        let gw = self.m.tile_w * scale;
        let gh = self.m.tile_h * scale;
        let adv = self.m.cell_w * scale;
        let mut cx = x;
        for ch in text.chars() {
            if ch != ' ' {
                if let Some(&idx) = self.char_map.get(&ch) {
                    let col = idx % self.m.atlas_cols;
                    let row = idx / self.m.atlas_cols;
                    let u0 = (col as f32 * self.m.tile_w) / self.m.atlas_tex_w;
                    let v0 = (row as f32 * self.m.tile_h) / self.m.atlas_tex_h;
                    let u1 = u0 + self.m.tile_w / self.m.atlas_tex_w;
                    let v1 = v0 + self.m.tile_h / self.m.atlas_tex_h;
                    push_glyph(&mut self.verts, cx, y, gw, gh, color, u0, v0, u1, v1);
                }
            }
            cx += adv;
        }
    }
}

/// Append a solid-color quad (uv unused). 2 triangles, 6 verts.
fn push_rect(v: &mut Vec<f32>, x: f32, y: f32, w: f32, h: f32, c: [f32; 4]) {
    push_glyph(v, x, y, w, h, c, 0.0, 0.0, 0.0, 0.0);
}

/// Append a quad with explicit uv rect. 2 triangles, 6 verts of [pos2, uv2, color4].
#[allow(clippy::too_many_arguments)]
fn push_glyph(v: &mut Vec<f32>, x: f32, y: f32, w: f32, h: f32, c: [f32; 4],
              u0: f32, v0: f32, u1: f32, v1: f32) {
    let (x0, y0, x1, y1) = (x, y, x + w, y + h);
    let mut vert = |px: f32, py: f32, u: f32, vv: f32| {
        v.extend_from_slice(&[px, py, u, vv, c[0], c[1], c[2], c[3]]);
    };
    vert(x0, y0, u0, v0);
    vert(x1, y0, u1, v0);
    vert(x1, y1, u1, v1);
    vert(x0, y0, u0, v0);
    vert(x1, y1, u1, v1);
    vert(x0, y1, u0, v1);
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
        return Err(format!("ui link error: {log}"));
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
        return Err(format!("ui compile error: {log}"));
    }
    Ok(shader)
}
