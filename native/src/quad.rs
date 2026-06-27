//! Full-screen pass that samples a game texture onto the default framebuffer.
//!
//! Used by both video paths: the hardware FBO color texture (bottom-left origin → v-flip) and the
//! software-uploaded frame (top-left origin → no flip). A single covering triangle from
//! `gl_VertexID` (no vertex buffer); fragment shader scales UVs to the valid sub-rect and flips
//! per `u_flip`.
//!
//! GLSL is `#version 330 core` for the Windows desktop-GL context. The Pi (GLES3) will use a
//! `#version 300 es` variant with a `precision` line — swap the header by `cfg` when we get there.

use glow::HasContext;

const VERT: &str = r#"#version 330 core
out vec2 v_uv;
void main() {
    // Fullscreen triangle: vertex ids 0,1,2 -> (-1,-1), (3,-1), (-1,3)
    vec2 p = vec2(float((gl_VertexID & 1) << 2) - 1.0,
                  float((gl_VertexID & 2) << 1) - 1.0);
    v_uv = p * 0.5 + 0.5;
    gl_Position = vec4(p, 0.0, 1.0);
}
"#;

const FRAG: &str = r#"#version 330 core
in vec2 v_uv;
uniform sampler2D u_tex;
uniform vec2 u_uv_scale;   // valid sub-rect = (cur_w/tex_w, cur_h/tex_h)
uniform float u_flip;      // 1.0 = v-flip (hw FBO, bottom-left origin); 0.0 = software (top-left)
out vec4 frag;
void main() {
    float vy = mix(v_uv.y, 1.0 - v_uv.y, u_flip);
    vec2 uv = vec2(v_uv.x * u_uv_scale.x, vy * u_uv_scale.y);
    frag = vec4(texture(u_tex, uv).rgb, 1.0);
}
"#;

pub struct Quad {
    program: glow::NativeProgram,
    vao: glow::NativeVertexArray,
    u_tex: Option<glow::NativeUniformLocation>,
    u_uv_scale: Option<glow::NativeUniformLocation>,
    u_flip: Option<glow::NativeUniformLocation>,
}

impl Quad {
    /// # Safety
    /// A current GL context must exist.
    pub unsafe fn new(gl: &glow::Context) -> Result<Self, String> {
        let program = link(gl, VERT, FRAG)?;
        // Core profile requires a bound VAO even when drawing without vertex attributes.
        let vao = gl.create_vertex_array()?;
        let u_tex = gl.get_uniform_location(program, "u_tex");
        let u_uv_scale = gl.get_uniform_location(program, "u_uv_scale");
        let u_flip = gl.get_uniform_location(program, "u_flip");
        Ok(Self {
            program,
            vao,
            u_tex,
            u_uv_scale,
            u_flip,
        })
    }

    /// # Safety
    /// A current GL context must exist; `tex` must be a live RGBA texture.
    pub unsafe fn draw(
        &self,
        gl: &glow::Context,
        tex: glow::NativeTexture,
        sx: f32,
        sy: f32,
        flip: f32,
    ) {
        gl.disable(glow::DEPTH_TEST);
        gl.disable(glow::SCISSOR_TEST);
        gl.disable(glow::BLEND);

        gl.use_program(Some(self.program));
        gl.bind_vertex_array(Some(self.vao));

        gl.active_texture(glow::TEXTURE0);
        gl.bind_texture(glow::TEXTURE_2D, Some(tex));
        if let Some(l) = &self.u_tex {
            gl.uniform_1_i32(Some(l), 0);
        }
        if let Some(l) = &self.u_uv_scale {
            gl.uniform_2_f32(Some(l), sx, sy);
        }
        if let Some(l) = &self.u_flip {
            gl.uniform_1_f32(Some(l), flip);
        }

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
