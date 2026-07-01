use sdl2::video::{GLContext, GLProfile, SwapInterval, Window};
use sdl2::{EventPump, Sdl, VideoSubsystem};

pub struct Gfx {
    pub gl: glow::Context,
    pub window: Window,
    pub event_pump: EventPump,
    // Opened game controllers; polled each frame to feed the libretro core (crate::input).
    pub gamepads: crate::input::Gamepads,

    // Kept alive for the lifetime of the window. Declared after `window`/`gl` so they
    // drop first; SDL + the GL context tear down last.
    _gl_ctx: GLContext,
    _video: VideoSubsystem,
    _sdl: Sdl,
}

impl Gfx {
    pub fn new(title: &str, width: u32, height: u32) -> Result<Self, Box<dyn std::error::Error>> {
        let sdl = sdl2::init()?;
        let video = sdl.video()?;

        // The libretro core dictates the GL flavor, and it differs per platform: the prebuilt
        // Windows mupen64plus-next requests DESKTOP OpenGL (RETRO_HW_CONTEXT_OPENGL), while the
        // Pi's build requests native GLES3. We must hand the core a context of the API it asked
        // for — otherwise it resolves entry points absent from the other API (via
        // get_proc_address) and crashes. So: desktop GL on Windows, GLES3 on the Pi.
        let gl_attr = video.gl_attr();
        #[cfg(windows)]
        {
            gl_attr.set_context_profile(GLProfile::Compatibility);
            gl_attr.set_context_version(3, 3);
        }
        #[cfg(not(windows))]
        {
            gl_attr.set_context_profile(GLProfile::GLES);
            gl_attr.set_context_version(3, 0);
        }
        // The default framebuffer needs no depth/stencil — the core renders into the
        // frontend-owned FBO, which carries its own depth attachment.
        gl_attr.set_depth_size(0);

        let window = video
            .window(title, width, height)
            .opengl()
            .position_centered()
            .build()?;

        let gl_ctx = window.gl_create_context()?;
        window.gl_make_current(&gl_ctx)?;
        // Best-effort vsync; not fatal if the driver refuses it.
        let _ = video.gl_set_swap_interval(SwapInterval::VSync);

        // SAFETY: the context is current; SDL resolves GL/GLES entry points for it.
        let gl = unsafe {
            glow::Context::from_loader_function(|s| video.gl_get_proc_address(s) as *const _)
        };

        // Default UNPACK_ALIGNMENT is 4, which mis-strides any R8/16-bit texture whose row byte
        // width isn't a multiple of 4 (e.g. a 35-wide R8 cell-data row → sheared upload + OOB read).
        // Set it once globally to 1 so every tightly-packed upload is read correctly.
        unsafe {
            use glow::HasContext;
            gl.pixel_store_i32(glow::UNPACK_ALIGNMENT, 1);
        }

        let event_pump = sdl.event_pump()?;
        let gamepads = crate::input::Gamepads::new(&sdl)?;

        Ok(Gfx {
            gl,
            window,
            event_pump,
            gamepads,
            _gl_ctx: gl_ctx,
            _video: video,
            _sdl: sdl,
        })
    }

    pub fn gl_version(&self) -> String {
        use glow::HasContext;
        // SAFETY: a current GLES3 context exists.
        unsafe { self.gl.get_parameter_string(glow::VERSION) }
    }
}
