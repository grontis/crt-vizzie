//! M2: register the libretro callbacks and bring the core up (`retro_init`).
//!
//! The environment callback is the core's only channel to the platform. We answer the handful
//! of commands the core needs to initialize and return `false` (unsupported) for the rest.
//!
//! Several callbacks are `extern "C"` with no user-data parameter, so the state they touch lives
//! in module statics (atomics / OnceLock — no `static mut`). The spike is single-threaded; the
//! atomics are for ergonomics and correctness, not contention.

use std::ffi::CString;
use std::os::raw::{c_char, c_uint, c_void};
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicUsize, Ordering};
use std::sync::{Mutex, OnceLock};

use crate::libretro::*;

// FBO the core renders into (set at M3). 0 until then.
static FBO: AtomicU32 = AtomicU32::new(0);
// Valid frame region reported by video_refresh (set from M4). 0 until then.
static CUR_W: AtomicU32 = AtomicU32::new(0);
static CUR_H: AtomicU32 = AtomicU32::new(0);
// Core's GL (re)init / teardown hooks captured from SET_HW_RENDER; called at M3. fn-ptr as usize.
static CONTEXT_RESET: AtomicUsize = AtomicUsize::new(0);
static CONTEXT_DESTROY: AtomicUsize = AtomicUsize::new(0);
// What the core asked for at SET_HW_RENDER (M3 diagnostic): context type + accept/reject.
static HW_CONTEXT_TYPE: AtomicU32 = AtomicU32::new(0);
static HW_ACCEPTED: AtomicBool = AtomicBool::new(false);

static SYS_DIR: OnceLock<CString> = OnceLock::new();
// The core reads the ROM throughout emulation, so the frontend must keep it alive for the whole
// game session (not just across load_game). Process-lifetime statics do that.
static ROM_DATA: OnceLock<Vec<u8>> = OnceLock::new();
static ROM_PATH: OnceLock<CString> = OnceLock::new();

// Software-render path: cores that deliver CPU pixel buffers via video_refresh (e.g. parallel_n64,
// and every 2D core) instead of rendering into our FBO.
static PIXEL_FORMAT: AtomicU32 = AtomicU32::new(1); // 0=0RGB1555, 1=XRGB8888, 2=RGB565
static SW_W: AtomicU32 = AtomicU32::new(0);
static SW_H: AtomicU32 = AtomicU32::new(0);
static SW_READY: AtomicBool = AtomicBool::new(false);
static SW_BUF: Mutex<Vec<u8>> = Mutex::new(Vec::new());

fn sys_dir_ptr() -> *const c_char {
    // The core may read/write system + save files here; "." (cwd) is fine for the spike.
    SYS_DIR.get_or_init(|| CString::new(".").unwrap()).as_ptr()
}

/// Register all callbacks and initialize the core.
///
/// # Safety
/// `core` must be a loaded libretro core; a current GL context should already exist (the core
/// may request a hardware-render context to share at M3, via the env callback).
pub unsafe fn init_core(core: &Core) {
    (core.set_environment)(env_callback);
    (core.set_video_refresh)(video_refresh);
    (core.set_audio_sample)(audio_sample);
    (core.set_audio_sample_batch)(audio_sample_batch);
    (core.set_input_poll)(input_poll);
    (core.set_input_state)(input_state);
    (core.init)();
}

/// M3a: load a ROM (need_fullpath=false → pass the bytes). The core calls SET_HW_RENDER from
/// inside this, so afterwards `hw_context_type()` / `hw_accepted()` report what it asked for.
///
/// # Safety
/// `core` must be an initialized libretro core.
pub unsafe fn load_game(core: &Core, rom_path: &Path) -> std::io::Result<bool> {
    // Keep the ROM bytes + path alive for the process lifetime — the core references them during
    // emulation, so freeing them after load_game is a use-after-free (heap corruption).
    let bytes = std::fs::read(rom_path)?;
    let _ = ROM_DATA.set(bytes);
    let data = ROM_DATA.get().expect("ROM_DATA just set");

    if let Ok(c) = CString::new(rom_path.to_string_lossy().as_bytes()) {
        let _ = ROM_PATH.set(c);
    }
    let path_ptr = ROM_PATH.get().map_or(std::ptr::null(), |c| c.as_ptr());

    let info = retro_game_info {
        path: path_ptr,
        data: data.as_ptr() as *const c_void,
        size: data.len(),
        meta: std::ptr::null(),
    };
    Ok((core.load_game)(&info))
}

pub fn hw_context_type() -> u32 {
    HW_CONTEXT_TYPE.load(Ordering::Acquire)
}
pub fn hw_accepted() -> bool {
    HW_ACCEPTED.load(Ordering::Acquire)
}
pub fn context_type_name(t: u32) -> &'static str {
    match t {
        0 => "none",
        1 => "OpenGL (desktop)",
        2 => "OpenGLES2",
        3 => "OpenGL_Core (desktop)",
        4 => "OpenGLES3",
        5 => "OpenGLES (versioned)",
        6 => "Vulkan",
        _ => "other",
    }
}

/// M3b: publish the raw GL name of the FBO the core renders into (get_current_framebuffer
/// returns this each frame).
pub fn set_fbo(name: u32) {
    FBO.store(name, Ordering::Release);
}

/// M4: the valid frame region the core last reported via video_refresh (0 until the first run).
pub fn cur_w() -> u32 {
    CUR_W.load(Ordering::Acquire)
}
pub fn cur_h() -> u32 {
    CUR_H.load(Ordering::Acquire)
}

// ── Software-render path accessors ───────────────────────────────────────────
pub fn pixel_format() -> u32 {
    PIXEL_FORMAT.load(Ordering::Acquire)
}
pub fn sw_ready() -> bool {
    SW_READY.load(Ordering::Acquire)
}
pub fn sw_dims() -> (u32, u32) {
    (SW_W.load(Ordering::Acquire), SW_H.load(Ordering::Acquire))
}
/// Run `f` with the latest tightly-packed software frame bytes, if any.
pub fn with_sw_frame<R>(f: impl FnOnce(&[u8]) -> R) -> Option<R> {
    let buf = SW_BUF.lock().ok()?;
    if buf.is_empty() {
        None
    } else {
        Some(f(&buf))
    }
}

/// M3b: invoke the core's captured context_reset so it (re)initializes its GL resources.
///
/// # Safety
/// A current GL context and a valid published FBO (`set_fbo`) must already be in place.
pub unsafe fn context_reset() {
    let p = CONTEXT_RESET.load(Ordering::Acquire);
    if p != 0 {
        let f: unsafe extern "C" fn() = std::mem::transmute(p);
        f();
    }
}

// ─── Environment callback ─────────────────────────────────────────────────────

unsafe extern "C" fn env_callback(cmd: c_uint, data: *mut c_void) -> bool {
    match cmd {
        RETRO_ENVIRONMENT_GET_CAN_DUPE => {
            if !data.is_null() {
                *(data as *mut bool) = true;
            }
            true
        }

        RETRO_ENVIRONMENT_SET_PIXEL_FORMAT => {
            if !data.is_null() {
                let fmt = *(data as *const c_uint);
                PIXEL_FORMAT.store(fmt, Ordering::Release);
                eprintln!("[spike] SET_PIXEL_FORMAT: {fmt} (0=0RGB1555, 1=XRGB8888, 2=RGB565)");
            }
            true
        }

        RETRO_ENVIRONMENT_GET_SYSTEM_DIRECTORY | RETRO_ENVIRONMENT_GET_SAVE_DIRECTORY => {
            if !data.is_null() {
                *(data as *mut *const c_char) = sys_dir_ptr();
            }
            true
        }

        RETRO_ENVIRONMENT_SET_PERFORMANCE_LEVEL => true,

        RETRO_ENVIRONMENT_GET_VARIABLE_UPDATE => {
            if !data.is_null() {
                *(data as *mut bool) = false;
            }
            true
        }

        RETRO_ENVIRONMENT_GET_VARIABLE => get_variable(data),

        RETRO_ENVIRONMENT_GET_LOG_INTERFACE => {
            // The C type is variadic; we hand the core a non-variadic fn and read only the fixed
            // args (level, fmt). On Win64/SysV those are register-passed identically, so ignoring
            // the varargs is safe in practice — enough to surface where the core dies.
            if !data.is_null() {
                *(data as *mut retro_log_callback) = retro_log_callback {
                    log: Some(core_log),
                };
            }
            true
        }

        RETRO_ENVIRONMENT_SET_HW_RENDER => set_hw_render(data),

        _ => false,
    }
}

/// Capture the core's hw-render request and install our GL hooks.
/// Not exercised until M3 (the core calls SET_HW_RENDER from inside retro_load_game).
unsafe fn set_hw_render(data: *mut c_void) -> bool {
    if data.is_null() {
        return false;
    }
    let hw = &mut *(data as *mut retro_hw_render_callback);
    HW_CONTEXT_TYPE.store(hw.context_type, Ordering::Release);

    // We can only share a GL/GLES context. Reject anything else (notably VULKAN) loudly so the
    // M3 failure mode is an obvious log line, not a silent black screen.
    let ok = matches!(
        hw.context_type,
        RETRO_HW_CONTEXT_OPENGLES3
            | RETRO_HW_CONTEXT_OPENGLES2
            | RETRO_HW_CONTEXT_OPENGL
            | RETRO_HW_CONTEXT_OPENGL_CORE
    );
    if !ok {
        HW_ACCEPTED.store(false, Ordering::Release);
        eprintln!(
            "[spike] core requested unsupported hw context_type={} (need GL/GLES). \
             Likely the Vulkan/ParaLLEl RDP default — force GLideN64 via a core option.",
            hw.context_type
        );
        return false;
    }

    CONTEXT_RESET.store(hw.context_reset.map_or(0, |f| f as usize), Ordering::Release);
    CONTEXT_DESTROY.store(hw.context_destroy.map_or(0, |f| f as usize), Ordering::Release);
    hw.get_current_framebuffer = Some(get_current_framebuffer);
    hw.get_proc_address = Some(get_proc_address);
    HW_ACCEPTED.store(true, Ordering::Release);

    eprintln!(
        "[spike] SET_HW_RENDER accepted: context_type={} depth={} stencil={} bottom_left_origin={} v{}.{}",
        hw.context_type, hw.depth, hw.stencil, hw.bottom_left_origin, hw.version_major, hw.version_minor
    );
    true
}

// ─── GL hooks handed to the core ──────────────────────────────────────────────

unsafe extern "C" fn get_current_framebuffer() -> usize {
    FBO.load(Ordering::Acquire) as usize
}

unsafe extern "C" fn get_proc_address(sym: *const c_char) -> RetroProcAddressT {
    // Resolve the core's GL entry points through SDL so it shares OUR context (ANGLE on Windows,
    // native GLES3 on the Pi). Requires a current GL context, which exists by M3.
    let p = sdl2::sys::SDL_GL_GetProcAddress(sym);
    // Pointer-sized -> fn-pointer Option; a null SDL result becomes None via the fn-ptr niche.
    std::mem::transmute(p)
}

// ─── Stub video/audio/input callbacks ─────────────────────────────────────────

unsafe extern "C" fn video_refresh(data: *const c_void, w: c_uint, h: c_uint, pitch: usize) {
    CUR_W.store(w, Ordering::Release);
    CUR_H.store(h, Ordering::Release);

    // Hardware frame (sentinel == (void*)-1) or duped frame (null): nothing to copy — the hw-FBO
    // path handles hardware frames. Otherwise the core delivered a CPU pixel buffer (software
    // renderer); repack it tightly (dropping pitch padding) for the loop to upload.
    if data.is_null() || data as usize == usize::MAX {
        return;
    }
    let fmt = PIXEL_FORMAT.load(Ordering::Acquire);
    let bpp = if fmt == 1 { 4usize } else { 2usize };
    let row_bytes = w as usize * bpp;
    if let Ok(mut buf) = SW_BUF.lock() {
        buf.clear();
        buf.reserve(row_bytes * h as usize);
        let src = data as *const u8;
        for row in 0..h as usize {
            let row_ptr = src.add(row * pitch);
            buf.extend_from_slice(std::slice::from_raw_parts(row_ptr, row_bytes));
        }
        SW_W.store(w, Ordering::Release);
        SW_H.store(h, Ordering::Release);
        SW_READY.store(true, Ordering::Release);
    }
}

// Audio is discarded — the game is visual-only (reactivity comes from live USB line-in later).
unsafe extern "C" fn audio_sample(_left: i16, _right: i16) {}
unsafe extern "C" fn audio_sample_batch(_data: *const i16, frames: usize) -> usize {
    frames
}

const FB_EMULATION_OFF: &[u8] = b"False\0";

/// Override specific core options; return false for everything else (core uses its default).
unsafe fn get_variable(data: *mut c_void) -> bool {
    if data.is_null() {
        return false;
    }
    let var = &mut *(data as *mut retro_variable);
    if var.key.is_null() {
        return false;
    }
    let key = std::ffi::CStr::from_ptr(var.key).to_string_lossy();
    // GLideN64 framebuffer emulation is the buggy path (heap corruption / glitches; broken on the
    // Pi GL driver too). Not needed for a visual-only background — force it off.
    if key == "mupen64plus-EnableFBEmulation" {
        var.value = FB_EMULATION_OFF.as_ptr() as *const c_char;
        return true;
    }
    false
}

// Non-variadic shim for the core's variadic log callback — prints just the (unexpanded) format
// string, which is enough to locate the failing step. See retro_log_callback in libretro.rs.
unsafe extern "C" fn core_log(level: c_uint, fmt: *const c_char) {
    if fmt.is_null() {
        return;
    }
    let s = std::ffi::CStr::from_ptr(fmt).to_string_lossy();
    eprint!("[core:{level}] {s}");
}

unsafe extern "C" fn input_poll() {}
unsafe extern "C" fn input_state(
    _port: c_uint,
    _device: c_uint,
    _index: c_uint,
    _id: c_uint,
) -> i16 {
    0
}
