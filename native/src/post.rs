//! PostFx — full-screen glitch/warp post-process.
//!
//! The scene (game + ASCII animation) is rendered into an offscreen color texture; this pass then
//! samples that texture across the whole screen and applies momentary, destructive distortion —
//! horizontal slice tears, block jitter, sinusoidal warp, RGB channel split, and noise flicker —
//! scaled by a burst envelope driven from `main.rs`. At zero envelope it is a 1:1 passthrough.

use glow::HasContext;

#[cfg(windows)]
const SHADER_HEADER: &str = "#version 330 core\n";
#[cfg(not(windows))]
const SHADER_HEADER: &str = "#version 300 es\nprecision highp float;\n";

const VERT_BODY: &str = r#"
out vec2 v_uv;
void main() {
    // Full-screen triangle from gl_VertexID (no VBO).
    vec2 p = vec2(float((gl_VertexID & 1) << 2) - 1.0,
                  float((gl_VertexID & 2) << 1) - 1.0);
    v_uv = p * 0.5 + 0.5;
    gl_Position = vec4(p, 0.0, 1.0);
}
"#;

const FRAG_BODY: &str = r#"
uniform sampler2D u_scene;
uniform vec2  u_resolution;
uniform float u_time;
uniform float u_amount;     // burst envelope, 0..1 (0 = passthrough)
uniform float u_intensity;  // master displacement scale
uniform float u_seed;       // per-burst random seed

in  vec2 v_uv;
out vec4 fragColor;

float hash11(float p) {
  p = fract(p * 0.1031);
  p *= p + 33.33;
  p *= p + p;
  return fract(p);
}

void main() {
  float amt = clamp(u_amount, 0.0, 1.0);
  float k   = amt * u_intensity;
  vec2  uv  = v_uv;
  float t   = u_time;

  // Horizontal slice tear: some bands jump sideways for a frame.
  float band   = floor(uv.y * 24.0);
  float tearOn = step(0.6, hash11(band * 1.7 + u_seed + floor(t * 12.0)));
  uv.x += (hash11(band + u_seed) - 0.5) * 0.15 * k * tearOn;

  // Block jitter: occasional rectangular regions sample from an offset.
  vec2  blk     = floor(uv * vec2(18.0, 12.0));
  float bh      = hash11(blk.x * 3.7 + blk.y * 11.3 + u_seed + floor(t * 18.0));
  float bactive = step(1.0 - 0.3 * amt, bh);
  uv += (vec2(hash11(bh + 1.0), hash11(bh + 2.0)) - 0.5) * 0.12 * k * bactive;

  // Sinusoidal warp.
  uv.x += sin(uv.y * 32.0 + t * 9.0) * 0.008 * k;
  uv.y += cos(uv.x * 22.0 + t * 7.0) * 0.004 * k;

  // RGB channel split (chromatic shear).
  float split = 0.015 * k;
  vec3 col;
  col.r = texture(u_scene, uv + vec2(split, 0.0)).r;
  col.g = texture(u_scene, uv).g;
  col.b = texture(u_scene, uv - vec2(split, 0.0)).b;

  // Noise flicker.
  float n = hash11(dot(uv, vec2(127.1, 311.7)) + t * 60.0);
  col += (n - 0.5) * 0.18 * k;

  fragColor = vec4(col, 1.0);
}
"#;

pub struct PostFx {
    program: glow::NativeProgram,
    vao: glow::NativeVertexArray,
    fbo: glow::NativeFramebuffer,
    scene_tex: glow::NativeTexture,
    u_scene: Option<glow::NativeUniformLocation>,
    u_resolution: Option<glow::NativeUniformLocation>,
    u_time: Option<glow::NativeUniformLocation>,
    u_amount: Option<glow::NativeUniformLocation>,
    u_intensity: Option<glow::NativeUniformLocation>,
    u_seed: Option<glow::NativeUniformLocation>,
}

impl PostFx {
    /// # Safety: a current GL context must exist.
    pub unsafe fn new(gl: &glow::Context) -> Result<Self, String> {
        let program = link(gl, &format!("{SHADER_HEADER}{VERT_BODY}"),
                               &format!("{SHADER_HEADER}{FRAG_BODY}"))?;
        let u_scene = gl.get_uniform_location(program, "u_scene");
        let u_resolution = gl.get_uniform_location(program, "u_resolution");
        let u_time = gl.get_uniform_location(program, "u_time");
        let u_amount = gl.get_uniform_location(program, "u_amount");
        let u_intensity = gl.get_uniform_location(program, "u_intensity");
        let u_seed = gl.get_uniform_location(program, "u_seed");

        let vao = gl.create_vertex_array()?;

        // Scene color texture (sized in resize) + its FBO. LINEAR so warped sampling is smooth.
        let scene_tex = gl.create_texture()?;
        gl.bind_texture(glow::TEXTURE_2D, Some(scene_tex));
        gl.tex_parameter_i32(glow::TEXTURE_2D, glow::TEXTURE_WRAP_S, glow::CLAMP_TO_EDGE as i32);
        gl.tex_parameter_i32(glow::TEXTURE_2D, glow::TEXTURE_WRAP_T, glow::CLAMP_TO_EDGE as i32);
        gl.tex_parameter_i32(glow::TEXTURE_2D, glow::TEXTURE_MIN_FILTER, glow::LINEAR as i32);
        gl.tex_parameter_i32(glow::TEXTURE_2D, glow::TEXTURE_MAG_FILTER, glow::LINEAR as i32);
        gl.tex_image_2d(glow::TEXTURE_2D, 0, glow::RGBA8 as i32, 1, 1, 0,
            glow::RGBA, glow::UNSIGNED_BYTE, None);

        let fbo = gl.create_framebuffer()?;
        gl.bind_framebuffer(glow::FRAMEBUFFER, Some(fbo));
        gl.framebuffer_texture_2d(
            glow::FRAMEBUFFER, glow::COLOR_ATTACHMENT0, glow::TEXTURE_2D, Some(scene_tex), 0,
        );
        gl.bind_framebuffer(glow::FRAMEBUFFER, None);

        Ok(Self {
            program, vao, fbo, scene_tex,
            u_scene, u_resolution, u_time, u_amount, u_intensity, u_seed,
        })
    }

    /// (Re)allocate the scene texture to the window size. # Safety: a current GL context.
    pub unsafe fn resize(&self, gl: &glow::Context, w: u32, h: u32) {
        gl.bind_texture(glow::TEXTURE_2D, Some(self.scene_tex));
        gl.tex_image_2d(glow::TEXTURE_2D, 0, glow::RGBA8 as i32, w.max(1) as i32, h.max(1) as i32,
            0, glow::RGBA, glow::UNSIGNED_BYTE, None);
    }

    /// Bind the offscreen FBO and clear it; the ASCII pass renders the scene here.
    /// # Safety: a current GL context.
    pub unsafe fn bind_scene(&self, gl: &glow::Context, w: u32, h: u32) {
        gl.bind_framebuffer(glow::FRAMEBUFFER, Some(self.fbo));
        gl.viewport(0, 0, w as i32, h as i32);
        gl.clear_color(0.0, 0.0, 0.0, 1.0);
        gl.clear(glow::COLOR_BUFFER_BIT);
    }

    /// Sample the scene texture with the glitch distortion → default framebuffer.
    /// # Safety: a current GL context.
    pub unsafe fn render(&self, gl: &glow::Context, params: &crate::config::Params, time: f32, w: u32, h: u32) {
        gl.bind_framebuffer(glow::FRAMEBUFFER, None);
        gl.viewport(0, 0, w as i32, h as i32);
        gl.use_program(Some(self.program));

        gl.active_texture(glow::TEXTURE0);
        gl.bind_texture(glow::TEXTURE_2D, Some(self.scene_tex));
        gl.uniform_1_i32(self.u_scene.as_ref(), 0);
        gl.uniform_2_f32(self.u_resolution.as_ref(), w as f32, h as f32);
        gl.uniform_1_f32(self.u_time.as_ref(), time);
        gl.uniform_1_f32(self.u_amount.as_ref(), params.glitch_fx_env.clamp(0.0, 1.0));
        gl.uniform_1_f32(self.u_intensity.as_ref(), params.glitch_fx_intensity);
        gl.uniform_1_f32(self.u_seed.as_ref(), params.glitch_fx_seed);

        gl.disable(glow::DEPTH_TEST);
        gl.disable(glow::BLEND);
        gl.bind_vertex_array(Some(self.vao));
        gl.draw_arrays(glow::TRIANGLES, 0, 3);
        gl.bind_vertex_array(None);
        gl.use_program(None);
    }
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
        return Err(format!("post link error: {log}"));
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
        return Err(format!("post compile error: {log}"));
    }
    Ok(shader)
}
