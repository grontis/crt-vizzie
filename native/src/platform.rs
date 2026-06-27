//! Small per-platform helpers so the same binary develops on Windows and deploys on the Pi.
//!
//! The frontend code is platform-agnostic; only two things differ at runtime: which core
//! binary to load (`.dll` / `.so` / `.dylib`) and — on Windows — that the GLES3 context comes
//! from ANGLE (`libEGL.dll` + `libGLESv2.dll`), which must be present next to the exe.

use std::path::PathBuf;

#[cfg(windows)]
pub const DEFAULT_CORE_FILE: &str = "mupen64plus_next_libretro.dll";
#[cfg(target_os = "macos")]
pub const DEFAULT_CORE_FILE: &str = "mupen64plus_next_libretro.dylib";
#[cfg(all(unix, not(target_os = "macos")))]
pub const DEFAULT_CORE_FILE: &str = "mupen64plus_next_libretro.so";

/// When `--core` is omitted, look for the platform-default core in `./cores/` next to the exe.
/// Lets the same launch command work on both platforms (just drop the right binary in `cores/`).
pub fn default_core_path() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let candidate = exe.parent()?.join("cores").join(DEFAULT_CORE_FILE);
    candidate.exists().then_some(candidate)
}

/// On Windows the GLES3 context is provided by ANGLE. If its DLLs aren't beside the exe (or on
/// PATH), context creation fails with an opaque error — so warn early and point at the guide.
#[cfg(windows)]
pub fn check_angle() {
    let dir = std::env::current_exe().ok().and_then(|e| e.parent().map(|p| p.to_path_buf()));
    let missing: Vec<&str> = ["libEGL.dll", "libGLESv2.dll"]
        .into_iter()
        .filter(|dll| dir.as_ref().map_or(true, |d| !d.join(dll).exists()))
        .collect();
    if !missing.is_empty() {
        eprintln!(
            "[spike] WARNING: ANGLE DLL(s) not found next to the exe: {}",
            missing.join(", ")
        );
        eprintln!("[spike]   GLES3 context creation will likely fail — see native/WINDOWS_DEV.md");
    }
}

#[cfg(not(windows))]
pub fn check_angle() {}
