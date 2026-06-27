//! Build script.
//!
//! Link Windows system libraries that the bundled static SDL2 depends on but that `sdl2-sys`
//! does not emit link directives for. SDL's `WIN_LookupAudioDeviceName` calls the registry API
//! (`RegOpenKeyExW` / `RegQueryValueExW` / `RegCloseKey`), which live in `advapi32` — without
//! this, the link fails with LNK2019 unresolved-external errors for those symbols.
//!
//! Gated on the *target* OS so it's a no-op on Linux/Pi (which use the system SDL2).

fn main() {
    let target_os = std::env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
    if target_os == "windows" {
        println!("cargo:rustc-link-lib=dylib=advapi32");
    }
}
