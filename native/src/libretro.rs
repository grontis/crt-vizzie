use std::error::Error;
use std::ffi::CStr;
use std::os::raw::{c_char, c_uint, c_void};
use std::path::Path;

use libloading::Library;

// ─── libretro.h structs (stable subset) ──────────────────────────────────────

#[repr(C)]
pub struct retro_system_info {
    pub library_name: *const c_char,
    pub library_version: *const c_char,
    pub valid_extensions: *const c_char,
    pub need_fullpath: bool,
    pub block_extract: bool,
}

#[repr(C)]
#[derive(Clone, Copy)]
pub struct retro_game_geometry {
    pub base_width: c_uint,
    pub base_height: c_uint,
    pub max_width: c_uint,
    pub max_height: c_uint,
    pub aspect_ratio: f32,
}

#[repr(C)]
#[derive(Clone, Copy)]
pub struct retro_system_timing {
    pub fps: f64,
    pub sample_rate: f64,
}

#[repr(C)]
#[derive(Clone, Copy)]
pub struct retro_system_av_info {
    pub geometry: retro_game_geometry,
    pub timing: retro_system_timing,
}

#[repr(C)]
pub struct retro_game_info {
    pub path: *const c_char,
    pub data: *const c_void,
    pub size: usize,
    pub meta: *const c_char,
}

// ─── Callback typedefs (frontend registers these with the core) ───────────────

pub type RetroEnvironmentT = unsafe extern "C" fn(c_uint, *mut c_void) -> bool;
pub type RetroVideoRefreshT = unsafe extern "C" fn(*const c_void, c_uint, c_uint, usize);
pub type RetroAudioSampleT = unsafe extern "C" fn(i16, i16);
pub type RetroAudioSampleBatchT = unsafe extern "C" fn(*const i16, usize) -> usize;
pub type RetroInputPollT = unsafe extern "C" fn();
pub type RetroInputStateT = unsafe extern "C" fn(c_uint, c_uint, c_uint, c_uint) -> i16;

// ─── Environment commands (verified against libretro.h) ───────────────────────
// Only the handful the env callback acts on. Everything else returns false.
pub const RETRO_ENVIRONMENT_GET_CAN_DUPE: c_uint = 3;
pub const RETRO_ENVIRONMENT_SET_PERFORMANCE_LEVEL: c_uint = 8;
pub const RETRO_ENVIRONMENT_GET_SYSTEM_DIRECTORY: c_uint = 9;
pub const RETRO_ENVIRONMENT_SET_PIXEL_FORMAT: c_uint = 10;
pub const RETRO_ENVIRONMENT_SET_HW_RENDER: c_uint = 14;
pub const RETRO_ENVIRONMENT_GET_VARIABLE: c_uint = 15;
pub const RETRO_ENVIRONMENT_GET_VARIABLE_UPDATE: c_uint = 17;
pub const RETRO_ENVIRONMENT_GET_LOG_INTERFACE: c_uint = 27;
pub const RETRO_ENVIRONMENT_GET_SAVE_DIRECTORY: c_uint = 31;

// ─── retro_hw_context_type ────────────────────────────────────────────────────
pub const RETRO_HW_CONTEXT_OPENGL: c_uint = 1;
pub const RETRO_HW_CONTEXT_OPENGLES2: c_uint = 2;
pub const RETRO_HW_CONTEXT_OPENGL_CORE: c_uint = 3;
pub const RETRO_HW_CONTEXT_OPENGLES3: c_uint = 4;
pub const RETRO_HW_CONTEXT_OPENGLES_VERSION: c_uint = 5;
pub const RETRO_HW_CONTEXT_VULKAN: c_uint = 6;

// ─── retro_hw_render_callback (field order is load-bearing — mirrors libretro.h) ──
// The core fills context_type/context_reset/depth/stencil/bottom_left_origin/version/
// context_destroy and calls SET_HW_RENDER; the FRONTEND writes get_current_framebuffer
// and get_proc_address into the same struct, then the core reads them back each frame.
pub type RetroProcAddressT = Option<unsafe extern "C" fn()>;

#[repr(C)]
pub struct retro_hw_render_callback {
    pub context_type: c_uint,
    pub context_reset: Option<unsafe extern "C" fn()>,
    pub get_current_framebuffer: Option<unsafe extern "C" fn() -> usize>,
    pub get_proc_address: Option<unsafe extern "C" fn(*const c_char) -> RetroProcAddressT>,
    pub depth: bool,
    pub stencil: bool,
    pub bottom_left_origin: bool,
    pub version_major: c_uint,
    pub version_minor: c_uint,
    pub cache_context: bool,
    pub context_destroy: Option<unsafe extern "C" fn()>,
    pub debug_context: bool,
}

// retro_log_callback. The C `log` is variadic: void (*)(enum retro_log_level, const char*, ...).
// We declare a NON-variadic pointer deliberately and read only the fixed args (see frontend.rs).
#[repr(C)]
pub struct retro_log_callback {
    pub log: Option<unsafe extern "C" fn(c_uint, *const c_char)>,
}

// retro_variable — for GET_VARIABLE, the frontend writes `value` to override a core option.
#[repr(C)]
pub struct retro_variable {
    pub key: *const c_char,
    pub value: *const c_char,
}

// ─── Core entry-point signatures ──────────────────────────────────────────────

type FnApiVersion = unsafe extern "C" fn() -> c_uint;
type FnVoid = unsafe extern "C" fn();
type FnGetSystemInfo = unsafe extern "C" fn(*mut retro_system_info);
type FnGetSystemAvInfo = unsafe extern "C" fn(*mut retro_system_av_info);
type FnSetEnvironment = unsafe extern "C" fn(RetroEnvironmentT);
type FnSetVideoRefresh = unsafe extern "C" fn(RetroVideoRefreshT);
type FnSetAudioSample = unsafe extern "C" fn(RetroAudioSampleT);
type FnSetAudioSampleBatch = unsafe extern "C" fn(RetroAudioSampleBatchT);
type FnSetInputPoll = unsafe extern "C" fn(RetroInputPollT);
type FnSetInputState = unsafe extern "C" fn(RetroInputStateT);
type FnLoadGame = unsafe extern "C" fn(*const retro_game_info) -> bool;

/// A loaded libretro core with its entry points resolved.
///
/// All `retro_*` symbols are resolved up front so the rest of the code can drive the core
/// without re-touching the dynamic loader.
pub struct Core {
    pub api_version: FnApiVersion,
    pub init: FnVoid,
    pub deinit: FnVoid,
    pub run: FnVoid,
    pub reset: FnVoid,
    pub unload_game: FnVoid,
    pub get_system_info: FnGetSystemInfo,
    pub get_system_av_info: FnGetSystemAvInfo,
    pub set_environment: FnSetEnvironment,
    pub set_video_refresh: FnSetVideoRefresh,
    pub set_audio_sample: FnSetAudioSample,
    pub set_audio_sample_batch: FnSetAudioSampleBatch,
    pub set_input_poll: FnSetInputPoll,
    pub set_input_state: FnSetInputState,
    pub load_game: FnLoadGame,

    // MUST remain the last field. The function pointers above point into the code
    // owned by this `Library`; struct fields drop in declaration order, so keeping the
    // library last guarantees it is unloaded only after every pointer is gone.
    _lib: Library,
}

impl Core {
    /// Open a libretro core and resolve its entry points.
    ///
    /// # Safety
    /// `path` must be a genuine libretro core for the running platform/ABI. The resolved
    /// symbols are trusted to match the signatures declared above.
    pub unsafe fn load(path: &Path) -> Result<Self, Box<dyn Error>> {
        let lib = Library::new(path)?;

        // Resolve a symbol and copy out the bare fn pointer (Copy), dropping the borrow.
        macro_rules! sym {
            ($name:literal) => {
                *lib.get($name)?
            };
        }

        let core = Core {
            api_version: sym!(b"retro_api_version\0"),
            init: sym!(b"retro_init\0"),
            deinit: sym!(b"retro_deinit\0"),
            run: sym!(b"retro_run\0"),
            reset: sym!(b"retro_reset\0"),
            unload_game: sym!(b"retro_unload_game\0"),
            get_system_info: sym!(b"retro_get_system_info\0"),
            get_system_av_info: sym!(b"retro_get_system_av_info\0"),
            set_environment: sym!(b"retro_set_environment\0"),
            set_video_refresh: sym!(b"retro_set_video_refresh\0"),
            set_audio_sample: sym!(b"retro_set_audio_sample\0"),
            set_audio_sample_batch: sym!(b"retro_set_audio_sample_batch\0"),
            set_input_poll: sym!(b"retro_set_input_poll\0"),
            set_input_state: sym!(b"retro_set_input_state\0"),
            load_game: sym!(b"retro_load_game\0"),
            _lib: lib,
        };

        let version = (core.api_version)();
        if version != 1 {
            return Err(format!("unexpected RETRO_API_VERSION {version} (expected 1)").into());
        }

        Ok(core)
    }

    /// Print the core's static identity (name, version, extensions, and `need_fullpath` —
    /// which decides whether load_game passes the ROM path or its bytes).
    pub fn print_system_info(&self) {
        // SAFETY: zeroed is a valid initial state — pointer fields become null (we null-check
        // below) and bool fields become false.
        let mut info: retro_system_info = unsafe { std::mem::zeroed() };
        unsafe { (self.get_system_info)(&mut info) };

        let s = |p: *const c_char| -> String {
            if p.is_null() {
                return "<null>".to_string();
            }
            // SAFETY: the core returns static, NUL-terminated C strings.
            unsafe { CStr::from_ptr(p) }.to_string_lossy().into_owned()
        };

        println!(
            "[crt] core: {} {}",
            s(info.library_name),
            s(info.library_version)
        );
        println!("[crt]   valid_extensions: {}", s(info.valid_extensions));
        println!(
            "[crt]   need_fullpath: {}   block_extract: {}",
            info.need_fullpath, info.block_extract
        );
    }
}
