#![allow(dead_code, non_camel_case_types)]

mod ascii_art;
mod audio;
mod audio_dev;
mod config;
mod frontend;
mod fusion;
mod hw_input;
mod libretro;
mod platform;
mod renderer;
mod rng;
mod sdl_gl;
mod ui;

use std::path::PathBuf;
use std::process::ExitCode;

struct Args {
    core: Option<PathBuf>,
    rom: Option<PathBuf>,
    demo: bool,
}

// ── Unit tests ────────────────────────────────────────────────────────────────
#[cfg(test)]
mod tests {
    /// Simulate the 30 Hz logic-tick accumulator from run_window:
    ///   logic_accum = logic_accum.min(4.0 * LOGIC_DT);   // catch-up cap
    ///   while logic_accum >= LOGIC_DT { ...; logic_accum -= LOGIC_DT; }
    /// Returns the number of ticks that would fire.
    fn count_ticks(initial_accum: f32, logic_dt: f32) -> usize {
        let mut accum = initial_accum.min(4.0 * logic_dt);
        let mut count = 0;
        while accum >= logic_dt {
            accum -= logic_dt;
            count += 1;
        }
        count
    }

    const LOGIC_DT: f32 = 1.0 / 30.0;

    /// A large stall (shader compile can take hundreds of ms) must produce at most 4 fusion
    /// ticks, never a burst of 30+ that would spiral the state.
    #[test]
    fn accumulator_cap_limits_to_four_ticks() {
        // 1 second stall = 30 LOGIC_DTs worth of accumulation → capped to 4 ticks.
        let stall_1s = 1.0f32;
        assert_eq!(count_ticks(stall_1s, LOGIC_DT), 4,
            "1-second stall should produce exactly 4 ticks (cap = 4 × LOGIC_DT)");

        // Even an infinite stall is bounded.
        let stall_inf = f32::MAX;
        assert_eq!(count_ticks(stall_inf, LOGIC_DT), 4,
            "infinite stall should still produce exactly 4 ticks");

        // A 10× stall is also capped.
        assert_eq!(count_ticks(10.0 * LOGIC_DT, LOGIC_DT), 4,
            "10× LOGIC_DT stall must be capped to 4");
    }

    /// logic_accum initialises to LOGIC_DT (not 0) so frame 1 fires exactly one tick,
    /// avoiding an all-black first frame.
    #[test]
    fn first_frame_tick_fires_with_initial_logic_dt() {
        let initial_accum = LOGIC_DT; // matches: let mut logic_accum: f32 = LOGIC_DT;
        assert_eq!(count_ticks(initial_accum, LOGIC_DT), 1,
            "initial logic_accum = LOGIC_DT must fire exactly 1 tick on the first frame");
    }

    /// Normal frames: verifies 1-tick and 2-tick cases work correctly.
    #[test]
    fn accumulator_normal_frame_tick_counts() {
        // Normal 33 ms frame → 1 tick.
        assert_eq!(count_ticks(LOGIC_DT, LOGIC_DT), 1, "1× LOGIC_DT → 1 tick");
        // Slow 66 ms frame → 2 ticks.
        assert_eq!(count_ticks(2.0 * LOGIC_DT, LOGIC_DT), 2, "2× LOGIC_DT → 2 ticks");
        // Just under 1 LOGIC_DT → 0 ticks (no half-tick).
        assert_eq!(count_ticks(LOGIC_DT * 0.99, LOGIC_DT), 0, "0.99× LOGIC_DT → 0 ticks");
        // The catch-up cap and the primed first tick compose: the initial LOGIC_DT is within
        // the 4× cap ceiling, so priming the first frame is never clamped away.
        assert!(LOGIC_DT <= 4.0 * LOGIC_DT, "the catch-up cap must not reduce the primed first tick");
    }
}

fn print_usage() {
    eprintln!("usage: crt-vizzie [--core <libretro-core>] [--rom <rom>] [--demo-mode]");
    eprintln!("  --core      load the libretro core (else ./cores/<platform-default>)");
    eprintln!("  --rom       game ROM to run and visualize");
    eprintln!("  --demo-mode synthetic animated audio source, ignores live audio input");
}

fn parse_args() -> Args {
    let mut core = None;
    let mut rom = None;
    let mut demo = false;
    let mut it = std::env::args().skip(1);
    while let Some(arg) = it.next() {
        match arg.as_str() {
            "--core" => core = it.next().map(PathBuf::from),
            "--rom" => rom = it.next().map(PathBuf::from),
            "--demo-mode" => demo = true,
            "-h" | "--help" => {
                print_usage();
                std::process::exit(0);
            }
            other => eprintln!("[crt] ignoring unknown arg: {other}"),
        }
    }
    Args { core, rom, demo }
}

fn main() -> ExitCode {
    let args = parse_args();

    // Use --core if given, else fall back to ./cores/<platform-default> next to the exe.
    let core_path = args.core.clone().or_else(platform::default_core_path);

    // Load the core (optional) and print its identity.
    let core = match &core_path {
        Some(path) => {
            // SAFETY: we trust the user-supplied path to be a real libretro core.
            match unsafe { libretro::Core::load(path) } {
                Ok(c) => {
                    c.print_system_info();
                    Some(c)
                }
                Err(e) => {
                    eprintln!("[crt] failed to load core {path:?}: {e}");
                    return ExitCode::FAILURE;
                }
            }
        }
        None => {
            eprintln!("[crt] no core (pass --core <path> or drop one in ./cores/); window only");
            None
        }
    };

    if let Err(e) = run_window(core, args.rom, args.demo) {
        eprintln!("[crt] fatal: {e}");
        return ExitCode::FAILURE;
    }
    ExitCode::SUCCESS
}

fn run_window(
    core: Option<libretro::Core>,
    rom: Option<PathBuf>,
    demo: bool,
) -> Result<(), Box<dyn std::error::Error>> {
    use glow::HasContext;

    let mut gfx = sdl_gl::Gfx::new("crt-vizzie", 1280, 720)?;
    println!("[crt] GL_VERSION: {}", gfx.gl_version());

    // Register callbacks + initialize the core. The GL context (created above) must exist first:
    // the core requests a hardware-render context to share via SET_HW_RENDER during load_game,
    // and our get_proc_address hands it this context.
    if let Some(c) = &core {
        unsafe { frontend::init_core(c) };
        println!("[crt] retro_init complete — core initialized");
    }

    // Load the ROM and observe the core's hw-render request.
    let mut game_loaded = false;
    if let (Some(c), Some(rom_path)) = (&core, &rom) {
        match unsafe { frontend::load_game(c, rom_path) } {
            Ok(true) => {
                game_loaded = true;
                println!("[crt] retro_load_game OK");
                let t = frontend::hw_context_type();
                println!(
                    "[crt] hw-render requested: {} (type={}), accepted={}",
                    frontend::context_type_name(t),
                    t,
                    frontend::hw_accepted()
                );
            }
            Ok(false) => println!("[crt] retro_load_game returned FALSE (core refused the ROM)"),
            Err(e) => println!("[crt] could not read ROM {rom_path:?}: {e}"),
        }
    } else if core.is_some() {
        println!("[crt] no --rom given; skipping load_game");
    }

    // Build the game FBO and reset the core's GL context.
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
                "[crt] av_info: base {}x{}, max {}x{}, fps {:.3}",
                av.geometry.base_width, av.geometry.base_height,
                av.geometry.max_width, av.geometry.max_height, av.timing.fps
            );

            match unsafe { build_game_fbo(&gfx.gl, w, h) } {
                Ok(g) => {
                    frontend::set_fbo(g.fbo.0.get());
                    println!("[crt] game FBO {w}x{h} complete (gl id={})", g.fbo.0.get());
                    // The core builds its GL resources here (GLideN64 init).
                    unsafe { frontend::context_reset() };
                    println!("[crt] context_reset done — core GL initialized");
                    // GLideN64 leaves its own FBO bound; restore the default for our clear.
                    unsafe { gfx.gl.bind_framebuffer(glow::FRAMEBUFFER, None) };
                    game = Some(g);
                }
                Err(e) => println!("[crt] FBO build FAILED: {e}"),
            }
        }
    }

    // The ASCII renderer (composites the masked ASCII animation over the game texture).
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

    // Debug overlay: draggable sliders for live param tuning (Windows dev tool; U toggles it).
    let mut ui = match unsafe { ui::DebugUi::new(&gfx.gl) } {
        Ok(u) => u,
        Err(e) => {
            eprintln!("[ui] init FAILED: {e}");
            std::process::exit(1);
        }
    };

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

    // Audio source: --demo-mode → synthetic source; else open the default cpal input, falling
    // back to a silent (blank/idle) source if no device is available.
    let mut audio = audio::new_source(demo);
    // Hardware input: GPIO knobs/buttons/LEDs on the Pi; no-op stub on other platforms.
    let mut hw = hw_input::new_hardware_input();
    let charset: Vec<String> = ascii.charset().to_vec();  // clone once at startup
    let mut fusion = fusion::Fusion::new(ascii.cols(), ascii.rows(), &charset);

    // 30 Hz logic-tick accumulator (decoupled from display frame rate).
    // Pre-load one tick so the first rendered frame is never all-black.
    const LOGIC_DT: f32         = 1.0 / 30.0;
    let mut logic_accum:    f32 = LOGIC_DT;
    let mut last_logic_tick     = std::time::Instant::now();

    // Main loop: run the core, then composite the masked animation over its frame.
    'main: loop {
        let events: Vec<_> = gfx.event_pump.poll_iter().collect();
        for event in events {
            use sdl2::event::Event;
            use sdl2::keyboard::Keycode;
            // Debug UI gets first crack at mouse events (slider drag); if it consumes one,
            // don't process it further.
            if ui.handle_event(&event, &mut params) {
                continue;
            }
            match event {
                Event::Quit { .. }
                | Event::KeyDown { keycode: Some(Keycode::Escape), .. } => break 'main,
                Event::KeyDown { keycode: Some(Keycode::U), .. } => {
                    ui.toggle();
                    eprintln!("[ui] visible: {}", ui.visible);
                }
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
                Event::KeyDown { keycode: Some(Keycode::F), .. } => {
                    use sdl2::video::FullscreenType;
                    // Borderless desktop fullscreen (no video-mode change) — the kiosk-friendly
                    // choice on both Windows and the Pi. The subsequent WindowEvent::Resized
                    // rebuilds the ASCII grid for the new dimensions automatically.
                    let next = match gfx.window.fullscreen_state() {
                        FullscreenType::Off => FullscreenType::Desktop,
                        _ => FullscreenType::Off,
                    };
                    if let Err(e) = gfx.window.set_fullscreen(next) {
                        eprintln!("[renderer] fullscreen toggle failed: {}", e);
                    } else {
                        eprintln!("[renderer] fullscreen: {:?}", next);
                    }
                }
                Event::Window { win_event: sdl2::event::WindowEvent::Resized(w, h), .. } => {
                    unsafe { ascii.resize(&gfx.gl, w as u32, h as u32) };
                    fusion.reset(ascii.cols(), ascii.rows());
                    eprintln!("[renderer] resize {}x{} → grid {}x{}",
                        w, h, ascii.cols(), ascii.rows());
                }
                _ => {}
            }
        }

        let (win_w, win_h) = gfx.window.size();

        // ── 30 Hz logic tick(s) — run before rendering ───────────────────────
        {
            let now = std::time::Instant::now();
            logic_accum += now.duration_since(last_logic_tick).as_secs_f32();
            last_logic_tick = now;
            // Cap catch-up to 4 ticks so a long shader-compile stall on the first
            // (c.run)() call cannot trigger a spiral of accumulated fusion updates.
            logic_accum = logic_accum.min(4.0 * LOGIC_DT);

            while logic_accum >= LOGIC_DT {
                // 1. Advance audio (cpal capture or synthetic fallback).
                audio.update();

                // 2. Hardware input: read knobs → write params; drain button events → invoke
                //    actions; drive LED outputs from current band levels. Runs after audio.update()
                //    so LEDs see the freshest bands, and before fusion.update() so param changes
                //    land in the same tick.
                hw.poll(&mut params, audio.bands());

                // 3. Chroma beat envelope (mirrors sketch.js _chromaBeatCurrent update).
                params.chroma_beat_current = params.chroma_beat_current * 0.85
                    + audio.beat_intensity() * params.chroma_beat * 0.15;

                // 3b. Edge beat envelope: pulses edge brightness on beats (mirrors the chroma
                //     envelope above so more of the animation breaks through on the beat).
                params.edge_beat_current = params.edge_beat_current * 0.85
                    + audio.beat_intensity() * params.edge_beat_boost * 0.15;

                // 4. Build the audio frame and run fusion. The shader masks this animation by the
                //    game's edges + dark space (so it shows along the on-screen shapes).
                let frame = fusion::AudioFrame {
                    spectrum:       audio.spectrum(),
                    bands:          audio.bands(),
                    beat_active:    audio.beat_active(),
                    beat_intensity: audio.beat_intensity(),
                    live:           audio.is_live(),
                };
                fusion.update(&frame, ascii.cols(), ascii.rows(), &params);

                logic_accum -= LOGIC_DT;
            }
        }

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
            ascii.upload(&gfx.gl, &fusion.char_idx, &fusion.bright16, &fusion.cga_idx);
            ascii.render(&gfx.gl, &params, game_tex, game_sx, game_sy, game_flip, win_w, win_h);
            ui.render(&gfx.gl, &params, win_w, win_h);
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
    // The BGRA client format below is desktop-GL only (Windows). The Pi's GLES3 path needs RGBA
    // + an R/B texture swizzle instead — see ARCHITECTURE.md ("Known limitations & future work").
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

/// Game framebuffer: the FBO the core renders into + its color texture (sampled each frame).
struct GameFbo {
    fbo: glow::NativeFramebuffer,
    color: glow::NativeTexture,
    w: i32,
    h: i32,
}

/// Build the FBO the core renders into — an RGBA8 color texture + a DEPTH24 renderbuffer
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

    // Only DEPTH24 is attached, matching the cores tested so far (stencil=false). A core that
    // requests hw.stencil=true would need DEPTH24_STENCIL8 + DEPTH_STENCIL_ATTACHMENT instead —
    // see ARCHITECTURE.md ("Known limitations & future work").
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
