#![allow(dead_code, non_camel_case_types)]
//! crt-vizzie — Phase 0 spike (milestone scaffold)
//! ===============================================
//!
//! See `native/PHASE0_SPIKE.md` for the full plan and the go/no-go acceptance criteria.
//!
//! IMPLEMENTED here:
//!   M0  SDL2 window + GLES3 context + clear loop      (run with no args)
//!   M1  load libretro core + print system info        (run with `--core <path>`)
//!
//! NOT yet implemented (clearly marked TODO below, in build order):
//!   M2  environment callback (SET_HW_RENDER, GET_LOG_INTERFACE, dirs, pixel format, ...)
//!   M3  retro_load_game + hw-render FBO (color tex + depth RB) + context_reset
//!   M4  one retro_run(); capture the valid w/h from the video_refresh callback
//!   M5  textured-quad pass: sample the FBO color texture (sub-rect + v-flip) -> GAME VISIBLE
//!   M6  core-fps pacing; run 5 min; rolling frame-time readout
//!
//! Usage:
//!   crt-vizzie-spike                         # M0 only: a magenta window
//!   crt-vizzie-spike --core <core.so>        # M0 + M1: also load the core and log its info
//!   crt-vizzie-spike --core <core.so> --rom <game.z64>   # (--rom wired in at M3)

mod audio_dev;
mod config;
mod frontend;
mod libretro;
mod platform;
mod renderer;
mod sdl_gl;

use std::path::PathBuf;
use std::process::ExitCode;

struct Args {
    core: Option<PathBuf>,
    rom: Option<PathBuf>,
}

fn print_usage() {
    eprintln!("usage: crt-vizzie-spike [--core <libretro-core>] [--rom <rom>]");
    eprintln!("  no args  -> M0 (magenta window)");
    eprintln!("  --core   -> M0 + M1 (also load the core and print its system info)");
    eprintln!("  --rom    -> consumed starting at M3 (load_game)");
}

fn parse_args() -> Args {
    let mut core = None;
    let mut rom = None;
    let mut it = std::env::args().skip(1);
    while let Some(arg) = it.next() {
        match arg.as_str() {
            "--core" => core = it.next().map(PathBuf::from),
            "--rom" => rom = it.next().map(PathBuf::from),
            "-h" | "--help" => {
                print_usage();
                std::process::exit(0);
            }
            other => eprintln!("[spike] ignoring unknown arg: {other}"),
        }
    }
    Args { core, rom }
}

fn main() -> ExitCode {
    let args = parse_args();

    // Use --core if given, else fall back to ./cores/<platform-default> next to the exe.
    let core_path = args.core.clone().or_else(platform::default_core_path);

    // ── M1: load the core (optional) and print its identity ──────────────────
    let core = match &core_path {
        Some(path) => {
            // SAFETY: we trust the user-supplied path to be a real libretro core.
            match unsafe { libretro::Core::load(path) } {
                Ok(c) => {
                    c.print_system_info();
                    Some(c)
                }
                Err(e) => {
                    eprintln!("[spike] failed to load core {path:?}: {e}");
                    return ExitCode::FAILURE;
                }
            }
        }
        None => {
            eprintln!("[spike] no core (pass --core <path> or drop one in ./cores/); M0 window only");
            None
        }
    };

    // ── M0: window + GLES3 context + clear loop ──────────────────────────────
    if let Err(e) = run_window(core, args.rom) {
        eprintln!("[spike] fatal: {e}");
        return ExitCode::FAILURE;
    }
    ExitCode::SUCCESS
}

fn run_window(
    core: Option<libretro::Core>,
    rom: Option<PathBuf>,
) -> Result<(), Box<dyn std::error::Error>> {
    use glow::HasContext;

    let mut gfx = sdl_gl::Gfx::new("crt-vizzie spike", 1280, 720)?;
    println!("[spike] GL_VERSION: {}", gfx.gl_version());

    // ── M2: register callbacks + initialize the core ─────────────────────────
    // The GL context (created above) must exist first: at M3 the core requests a hardware-render
    // context to share via SET_HW_RENDER, and our get_proc_address hands it this ANGLE/GLES3 one.
    if let Some(c) = &core {
        unsafe { frontend::init_core(c) };
        println!("[spike] retro_init complete — core initialized");
    }

    // ── M3a: load the ROM and observe the core's hw-render request ────────────
    let mut game_loaded = false;
    if let (Some(c), Some(rom_path)) = (&core, &rom) {
        match unsafe { frontend::load_game(c, rom_path) } {
            Ok(true) => {
                game_loaded = true;
                println!("[spike] retro_load_game OK");
                let t = frontend::hw_context_type();
                println!(
                    "[spike] hw-render requested: {} (type={}), accepted={}",
                    frontend::context_type_name(t),
                    t,
                    frontend::hw_accepted()
                );
            }
            Ok(false) => println!("[spike] retro_load_game returned FALSE (core refused the ROM)"),
            Err(e) => println!("[spike] could not read ROM {rom_path:?}: {e}"),
        }
    } else if core.is_some() {
        println!("[spike] no --rom given; skipping load_game");
    }

    // ── M3b: build the game FBO and reset the core's GL context ───────────────
    let mut game: Option<GameFbo> = None;
    if let Some(c) = &core {
        if frontend::hw_accepted() {
            let mut av: libretro::retro_system_av_info = unsafe { std::mem::zeroed() };
            unsafe { (c.get_system_av_info)(&mut av) };
            let mut w = av.geometry.max_width as i32;
            let mut h = av.geometry.max_height as i32;
            if w <= 0 || h <= 0 {
                w = av.geometry.base_width as i32;
                h = av.geometry.base_height as i32;
            }
            if w <= 0 || h <= 0 {
                w = 640;
                h = 480;
            }
            println!(
                "[spike] av_info: base {}x{}, max {}x{}, fps {:.3}",
                av.geometry.base_width, av.geometry.base_height,
                av.geometry.max_width, av.geometry.max_height, av.timing.fps
            );

            match unsafe { build_game_fbo(&gfx.gl, w, h) } {
                Ok(g) => {
                    frontend::set_fbo(g.fbo.0.get());
                    println!("[spike] game FBO {w}x{h} complete (gl id={})", g.fbo.0.get());
                    // The core builds its GL resources here (GLideN64 init — the real test).
                    unsafe { frontend::context_reset() };
                    println!("[spike] context_reset done — core GL initialized");
                    // GLideN64 leaves its own FBO bound; restore the default for our clear.
                    unsafe { gfx.gl.bind_framebuffer(glow::FRAMEBUFFER, None) };
                    game = Some(g);
                }
                Err(e) => println!("[spike] FBO build FAILED: {e}"),
            }
        }
    }

    // ── Phase 1: the ASCII renderer (composites ASCII over the game texture) ──
    let mut params = config::Params::default();
    let mut ascii = match unsafe { renderer::AsciiRenderer::new(&gfx.gl) } {
        Ok(r) => r,
        Err(e) => {
            eprintln!("[renderer] init FAILED: {e}");
            std::process::exit(1);
        }
    };
    {
        let (iw, ih) = gfx.window.size();
        unsafe { ascii.resize(&gfx.gl, iw, ih) };
    }

    // Software-frame texture: used when the core renders on the CPU (delivers pixels via
    // video_refresh) instead of into our FBO — e.g. parallel_n64's software renderer.
    let sw_tex = unsafe {
        let t = gfx.gl.create_texture().ok();
        if let Some(t) = t {
            gfx.gl.bind_texture(glow::TEXTURE_2D, Some(t));
            gfx.gl.tex_parameter_i32(glow::TEXTURE_2D, glow::TEXTURE_MIN_FILTER, glow::NEAREST as i32);
            gfx.gl.tex_parameter_i32(glow::TEXTURE_2D, glow::TEXTURE_MAG_FILTER, glow::NEAREST as i32);
        }
        t
    };

    // Phase 1 static test pattern (fusion stand-in). Built ONCE — Phase 2 will fill these in-place
    // each frame; the renderer is architected for no per-frame allocations.
    let cell_count = ascii.cols() * ascii.rows();
    let mut char_idx = vec![0u16; cell_count];
    let mut bright16 = vec![0u16; cell_count];
    let mut cga_idx = vec![0u8; cell_count];
    fill_static(&mut char_idx, &mut bright16, &mut cga_idx, ascii.cols(), ascii.rows());

    // ── M4 + M5 loop: run the core, then display the hardware FBO or the software frame ──
    'main: loop {
        let events: Vec<_> = gfx.event_pump.poll_iter().collect();
        for event in events {
            use sdl2::event::Event;
            use sdl2::keyboard::Keycode;
            match event {
                Event::Quit { .. }
                | Event::KeyDown { keycode: Some(Keycode::Escape), .. } => break 'main,
                Event::KeyDown { keycode: Some(Keycode::P), .. } => {
                    params.phosphor_index = (params.phosphor_index + 1) % config::PHOSPHOR_ORDER.len();
                    eprintln!("[renderer] phosphor: {}", config::PHOSPHOR_ORDER[params.phosphor_index]);
                }
                Event::KeyDown { keycode: Some(Keycode::S), .. } => {
                    params.scanline_mode = (params.scanline_mode + 1) % 4;
                    eprintln!("[renderer] scanline mode: {}", params.scanline_mode);
                }
                Event::KeyDown { keycode: Some(Keycode::B), .. } => {
                    params.bg_enabled = !params.bg_enabled;
                    eprintln!("[renderer] bg_enabled: {}", params.bg_enabled);
                }
                _ => {}
            }
        }

        let (win_w, win_h) = gfx.window.size();

        // Run one core frame (only once a game is loaded — running a core with no game crashes).
        if let (Some(c), true) = (&core, game_loaded) {
            unsafe {
                gfx.gl.bind_vertex_array(None);
                gfx.gl.use_program(None);
                gfx.gl.bind_buffer(glow::ARRAY_BUFFER, None);
                gfx.gl.bind_buffer(glow::ELEMENT_ARRAY_BUFFER, None);
                gfx.gl.bind_framebuffer(glow::FRAMEBUFFER, None);
                gfx.gl.bind_texture(glow::TEXTURE_2D, None);
                gfx.gl.disable(glow::DEPTH_TEST);
                gfx.gl.disable(glow::SCISSOR_TEST);
                gfx.gl.disable(glow::BLEND);
                (c.run)();
            }
        }

        // Pick the game texture + sampling params for whichever video path is active.
        let (game_tex, game_sx, game_sy, game_flip) = if let Some(g) = &game {
            // Hardware FBO: bottom-left origin → no flip.
            let cw = frontend::cur_w();
            let ch = frontend::cur_h();
            let sx = if cw > 0 { cw as f32 / g.w as f32 } else { 1.0 };
            let sy = if ch > 0 { ch as f32 / g.h as f32 } else { 1.0 };
            (Some(g.color), sx, sy, 0.0_f32)
        } else if let Some(t) = sw_tex {
            // Software CPU frame: top-left origin → v-flip. Dims + bytes captured under one lock.
            let uploaded = frontend::with_sw_frame(|w, h, buf| unsafe {
                upload_sw_texture(&gfx.gl, t, w as i32, h as i32, frontend::pixel_format(), buf);
            });
            if uploaded.is_some() {
                (Some(t), 1.0, 1.0, 1.0_f32)
            } else {
                (None, 1.0, 1.0, 0.0_f32) // no software frame yet → ASCII on black
            }
        } else {
            (None, 1.0, 1.0, 0.0_f32) // no core / no frame yet → ASCII on black
        };

        unsafe {
            gfx.gl.bind_framebuffer(glow::FRAMEBUFFER, None);
            gfx.gl.viewport(0, 0, win_w as i32, win_h as i32);
            gfx.gl.clear_color(0.0, 0.0, 0.0, 1.0);
            gfx.gl.clear(glow::COLOR_BUFFER_BIT);
            ascii.upload(&gfx.gl, &char_idx, &bright16, &cga_idx);
            ascii.render(&gfx.gl, &params, game_tex, game_sx, game_sy, game_flip, win_w, win_h);
        }

        gfx.window.gl_swap_window();
    }

    // Stop the core on exit — parallel_n64 spawns worker threads that otherwise keep the process
    // alive after the window closes (the hang where Ctrl+C didn't work). Force-exit as a backstop
    // so any lingering core threads can't block teardown.
    if let Some(c) = &core {
        unsafe {
            (c.unload_game)();
            (c.deinit)();
        }
    }
    std::process::exit(0)
}

/// Phase 1 static test pattern — exercises every shader path (glyphs, phosphor ramp, CGA,
/// empty cells) before fusion exists (Phase 2 replaces this).
fn fill_static(char_idx: &mut [u16], bright16: &mut [u16], cga_idx: &mut [u8], cols: usize, rows: usize) {
    let n = cols * rows;
    // Default: mid-bright phosphor with a visible glyph.
    for i in 0..n {
        char_idx[i] = 3;
        bright16[i] = 32767;
        cga_idx[i] = 0;
    }
    // Row 0: fully bright, varied glyphs across the atlas.
    for c in 0..cols {
        char_idx[c] = (c % 30 + 10) as u16;
        bright16[c] = 65535;
        cga_idx[c] = 0;
    }
    // Rows 1-4, col 0: brightness ramp (tests the phosphor 3-stop).
    for r in 1..rows.min(5) {
        let i = r * cols;
        char_idx[i] = 5;
        bright16[i] = (r as f32 / 4.0 * 65535.0) as u16;
        cga_idx[i] = 0;
    }
    // Rows 5-8: CGA diagonal band (tests all 15 palette entries).
    for r in 5..rows.min(9) {
        for c in 0..cols {
            let i = r * cols + c;
            cga_idx[i] = ((r + c) % 15 + 1) as u8;
            bright16[i] = 49151;
            char_idx[i] = 5;
        }
    }
    // Col 0, rows 9+: empty cells (tests the empty-cell fast path).
    for r in 9..rows {
        char_idx[r * cols] = 0;
        bright16[r * cols] = 0;
    }
}

/// Upload a software (CPU) frame to `tex`, choosing the GL format from the libretro pixel format.
unsafe fn upload_sw_texture(
    gl: &glow::Context,
    tex: glow::NativeTexture,
    w: i32,
    h: i32,
    fmt: u32,
    buf: &[u8],
) {
    use glow::HasContext;
    // TODO(review,pi): glow::BGRA is NOT a valid client format on native GLES3 (the Pi). On GLES3,
    // upload as RGBA and swap R<->B via texture swizzle (TEXTURE_SWIZZLE_R/B) under cfg(not(windows)).
    // This path works on Windows desktop GL only.
    gl.bind_texture(glow::TEXTURE_2D, Some(tex));
    match fmt {
        // XRGB8888: native u32 0xFFRRGGBB → little-endian bytes B,G,R,X → BGRA8.
        1 => gl.tex_image_2d(
            glow::TEXTURE_2D, 0, glow::RGBA8 as i32, w, h, 0,
            glow::BGRA, glow::UNSIGNED_BYTE, Some(buf),
        ),
        // RGB565.
        2 => gl.tex_image_2d(
            glow::TEXTURE_2D, 0, glow::RGB as i32, w, h, 0,
            glow::RGB, glow::UNSIGNED_SHORT_5_6_5, Some(buf),
        ),
        // 0RGB1555 (best-effort).
        _ => gl.tex_image_2d(
            glow::TEXTURE_2D, 0, glow::RGB5_A1 as i32, w, h, 0,
            glow::BGRA, glow::UNSIGNED_SHORT_1_5_5_5_REV, Some(buf),
        ),
    }
}

/// Game framebuffer: the FBO the core renders into + its color texture (sampled at M5).
struct GameFbo {
    fbo: glow::NativeFramebuffer,
    color: glow::NativeTexture,
    w: i32,
    h: i32,
}

/// M3b: build the FBO the core renders into — an RGBA8 color texture + a DEPTH24 renderbuffer
/// (the core requested `depth=true`). Returns the framebuffer; the caller publishes its GL name.
///
/// # Safety
/// A current GL context must exist.
unsafe fn build_game_fbo(gl: &glow::Context, w: i32, h: i32) -> Result<GameFbo, String> {
    use glow::HasContext;

    let fbo = gl.create_framebuffer()?;
    gl.bind_framebuffer(glow::FRAMEBUFFER, Some(fbo));

    let color = gl.create_texture()?;
    gl.bind_texture(glow::TEXTURE_2D, Some(color));
    gl.tex_image_2d(
        glow::TEXTURE_2D, 0, glow::RGBA8 as i32, w, h, 0,
        glow::RGBA, glow::UNSIGNED_BYTE, None,
    );
    gl.tex_parameter_i32(glow::TEXTURE_2D, glow::TEXTURE_MIN_FILTER, glow::NEAREST as i32);
    gl.tex_parameter_i32(glow::TEXTURE_2D, glow::TEXTURE_MAG_FILTER, glow::NEAREST as i32);
    gl.framebuffer_texture_2d(
        glow::FRAMEBUFFER, glow::COLOR_ATTACHMENT0, glow::TEXTURE_2D, Some(color), 0,
    );

    // TODO(review,pi): only DEPTH24 is attached. If a core sets hw.stencil=true (GLideN64 can, for
    // some N64 framebuffer effects), switch to DEPTH24_STENCIL8 + DEPTH_STENCIL_ATTACHMENT.
    // mupen64plus ran with stencil=false, so this is latent.
    let depth = gl.create_renderbuffer()?;
    gl.bind_renderbuffer(glow::RENDERBUFFER, Some(depth));
    gl.renderbuffer_storage(glow::RENDERBUFFER, glow::DEPTH_COMPONENT24, w, h);
    gl.framebuffer_renderbuffer(
        glow::FRAMEBUFFER, glow::DEPTH_ATTACHMENT, glow::RENDERBUFFER, Some(depth),
    );

    let status = gl.check_framebuffer_status(glow::FRAMEBUFFER);
    if status != glow::FRAMEBUFFER_COMPLETE {
        gl.bind_framebuffer(glow::FRAMEBUFFER, None);
        return Err(format!("framebuffer incomplete: status=0x{status:X}"));
    }
    // Clear the new color texture so the first frames (before the core renders) show black, not
    // uninitialized garbage — cur_w/cur_h are 0 until the first video_refresh (full-FBO sample).
    gl.clear_color(0.0, 0.0, 0.0, 1.0);
    gl.clear(glow::COLOR_BUFFER_BIT);
    gl.bind_framebuffer(glow::FRAMEBUFFER, None);
    Ok(GameFbo { fbo, color, w, h })
}
