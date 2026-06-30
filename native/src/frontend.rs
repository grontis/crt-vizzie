use std::ffi::CString;
use std::os::raw::{c_char, c_uint, c_void};
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicUsize, Ordering};
use std::sync::{Mutex, OnceLock};

use crate::libretro::*;

// FBO the core renders into (set once the hw-render context is established). 0 until then.
static FBO: AtomicU32 = AtomicU32::new(0);
// Valid frame region reported by video_refresh. 0 until the first frame.
static CUR_W: AtomicU32 = AtomicU32::new(0);
static CUR_H: AtomicU32 = AtomicU32::new(0);
// Core's GL (re)init / teardown hooks captured from SET_HW_RENDER. fn-ptr as usize.
static CONTEXT_RESET: AtomicUsize = AtomicUsize::new(0);
static CONTEXT_DESTROY: AtomicUsize = AtomicUsize::new(0);
// What the core asked for at SET_HW_RENDER (diagnostic): context type + accept/reject.
static HW_CONTEXT_TYPE: AtomicU32 = AtomicU32::new(0);
static HW_ACCEPTED: AtomicBool = AtomicBool::new(false);

static SYS_DIR: OnceLock<CString> = OnceLock::new();
// The core reads the ROM throughout emulation, so the frontend must keep it alive for the whole
// game session (not just across load_game). Process-lifetime statics do that.
// NOTE: OnceLock means a second load_game would silently keep the FIRST ROM — single-load only.
static ROM_DATA: OnceLock<Vec<u8>> = OnceLock::new();
static ROM_PATH: OnceLock<CString> = OnceLock::new();

// Software-render path: cores that deliver CPU pixel buffers via video_refresh (e.g. parallel_n64,
// and every 2D core) instead of rendering into our FBO.
// Default is 0RGB1555 — the libretro spec default before any SET_PIXEL_FORMAT (NOT XRGB8888).
static PIXEL_FORMAT: AtomicU32 = AtomicU32::new(0); // 0=0RGB1555, 1=XRGB8888, 2=RGB565
// Dims + bytes live under ONE lock so an off-thread resolution change can't tear them apart.
struct SwFrame {
    w: u32,
    h: u32,
    data: Vec<u8>,
}
static SW_FRAME: Mutex<SwFrame> = Mutex::new(SwFrame { w: 0, h: 0, data: Vec::new() });

fn sys_dir_ptr() -> *const c_char {
    // The core may read/write system + save files here; "." (cwd) is fine.
    SYS_DIR.get_or_init(|| CString::new(".").unwrap()).as_ptr()
}

/// Register all callbacks and initialize the core.
///
/// # Safety
/// `core` must be a loaded libretro core; a current GL context should already exist (the core
/// may request a hardware-render context to share, via the env callback).
pub unsafe fn init_core(core: &Core) {
    (core.set_environment)(env_callback);
    (core.set_video_refresh)(video_refresh);
    (core.set_audio_sample)(audio_sample);
    (core.set_audio_sample_batch)(audio_sample_batch);
    (core.set_input_poll)(input_poll);
    (core.set_input_state)(input_state);
    (core.init)();
}

/// Load a ROM (need_fullpath=false → pass the bytes). The core calls SET_HW_RENDER from
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

/// Publish the raw GL name of the FBO the core renders into (get_current_framebuffer
/// returns this each frame).
pub fn set_fbo(name: u32) {
    FBO.store(name, Ordering::Release);
}

/// The valid frame region the core last reported via video_refresh (0 until the first run).
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
/// Run `f` with the latest software frame — dimensions and tightly-packed bytes captured under one
/// lock so they can't disagree. Returns None if no software frame has arrived yet.
pub fn with_sw_frame<R>(f: impl FnOnce(u32, u32, &[u8]) -> R) -> Option<R> {
    let frame = SW_FRAME.lock().ok()?;
    if frame.data.is_empty() {
        None
    } else {
        Some(f(frame.w, frame.h, &frame.data))
    }
}

/// Invoke the core's captured context_reset so it (re)initializes its GL resources.
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

/// Invoke the core's captured context_destroy so it tears down its GL resources.
/// Call before destroying or resizing GL resources; follow with `set_fbo` + `context_reset`.
///
/// # Safety
/// Must be called from the same thread as the GL context.
pub unsafe fn context_destroy() {
    let p = CONTEXT_DESTROY.load(Ordering::Acquire);
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
                eprintln!("[crt] SET_PIXEL_FORMAT: {fmt} (0=0RGB1555, 1=XRGB8888, 2=RGB565)");
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
/// The core calls SET_HW_RENDER from inside retro_load_game.
unsafe fn set_hw_render(data: *mut c_void) -> bool {
    if data.is_null() {
        return false;
    }
    let hw = &mut *(data as *mut retro_hw_render_callback);
    HW_CONTEXT_TYPE.store(hw.context_type, Ordering::Release);

    // We can only share a GL/GLES context. Reject anything else (notably VULKAN) loudly so the
    // failure mode is an obvious log line, not a silent black screen.
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
            "[crt] core requested unsupported hw context_type={} (need GL/GLES). \
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
        "[crt] SET_HW_RENDER accepted: context_type={} depth={} stencil={} bottom_left_origin={} v{}.{}",
        hw.context_type, hw.depth, hw.stencil, hw.bottom_left_origin, hw.version_major, hw.version_minor
    );
    true
}

// ─── GL hooks handed to the core ──────────────────────────────────────────────

unsafe extern "C" fn get_current_framebuffer() -> usize {
    FBO.load(Ordering::Acquire) as usize
}

unsafe extern "C" fn get_proc_address(sym: *const c_char) -> RetroProcAddressT {
    // Resolve the core's GL entry points through SDL so it shares OUR context (desktop GL on
    // Windows, native GLES3 on the Pi). Requires a current GL context, which exists by this point.
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
    if let Ok(mut f) = SW_FRAME.lock() {
        f.w = w;
        f.h = h;
        f.data.clear();
        f.data.reserve(row_bytes * h as usize);
        let src = data as *const u8;
        for row in 0..h as usize {
            let row_ptr = src.add(row * pitch);
            f.data.extend_from_slice(std::slice::from_raw_parts(row_ptr, row_bytes));
        }
    }
}

// Audio is discarded — the game is visual-only (reactivity comes from live USB line-in later).
unsafe extern "C" fn audio_sample(_left: i16, _right: i16) {}
unsafe extern "C" fn audio_sample_batch(_data: *const i16, frames: usize) -> usize {
    frames
}

const FB_EMULATION_OFF: &[u8] = b"False\0";
const CPU_DYNAREC: &[u8] = b"dynamic_recompiler\0";
const RDP_ANGRYLION: &[u8] = b"angrylion\0";
const RSP_HLE: &[u8] = b"hle\0";
const THREADED_RENDERER_OFF: &[u8] = b"False\0";

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
    // Force the aarch64 dynamic recompiler — the core's built-in default may not pick it.
    if key == "mupen64plus-cpucore" {
        var.value = CPU_DYNAREC.as_ptr() as *const c_char;
        return true;
    }
    // Use Angrylion software RDP instead of GLideN64 — GLideN64's TextureCache has a
    // heap-corruption bug (free() on invalid pointer) in the GLES3/Mesa path on Pi 5.
    // Angrylion delivers CPU-rendered frames via video_refresh, matching parallel_n64's path.
    if key == "mupen64plus-rdp-plugin" {
        var.value = RDP_ANGRYLION.as_ptr() as *const c_char;
        return true;
    }
    // Use cxd4 software RSP interpreter — paraLLEl-RSP JIT fails mprotect(PROT_EXEC) on Pi 5.
    if key == "mupen64plus-rsp-plugin" || key == "mupen64plus-rspplugin" {
        var.value = b"cxd4\0".as_ptr() as *const c_char;
        return true;
    }
    // Disable threaded renderer — we don't need it for the software path.
    if key == "mupen64plus-ThreadedRenderer" {
        var.value = THREADED_RENDERER_OFF.as_ptr() as *const c_char;
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
