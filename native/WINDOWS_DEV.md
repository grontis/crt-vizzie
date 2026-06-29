# Windows development setup

You can develop the native frontend on Windows and deploy to the Pi later — the Rust code is
cross-platform. Only two things differ at runtime: the GLES3 context comes from **ANGLE** on
Windows (native on the Pi), and the libretro **core binary** is a `.dll` here / `.so` there.

> **What Windows can and can't tell you.** It validates all the *logic* — the env callback, FBO
> creation, `get_current_framebuffer`, `context_reset`, the unbind discipline, the quad pass.
> It can **not** validate Pi performance or the v3d-specific black-screen quirks — the Pi stays
> the real acceptance gate.

---

## 1. Rust toolchain

Install [rustup](https://rustup.rs/). The default `x86_64-pc-windows-msvc` toolchain needs the
**MSVC linker**, so also install **Visual Studio Build Tools** with the "Desktop development with
C++" workload (gives `link.exe` + the Windows SDK).

```powershell
# after installing rustup + VS Build Tools:
rustc --version
cargo --version
```

## 2. SDL2

Two options — pick one:

**A. Bundled + static (least friction, recommended).** Builds SDL2 from source and links it
statically, so there's no `SDL2.dll` to ship. Requires `cmake` on PATH (plus the C++ build tools
from step 1). In `native/Cargo.toml`:

```toml
sdl2 = { version = "0.37", features = ["bundled", "static-link"] }
```

**B. Prebuilt VC libs.** Download `SDL2-devel-2.xx.x-VC.zip` from
[libsdl.org/releases](https://github.com/libsdl-org/SDL/releases). Copy `lib\x64\*.lib` into your
toolchain's lib dir (e.g.
`%USERPROFILE%\.rustup\toolchains\stable-x86_64-pc-windows-msvc\lib\rustlib\x86_64-pc-windows-msvc\lib\`),
and copy `lib\x64\SDL2.dll` next to the built exe (`native\target\debug\`).

## 3. ANGLE (GLES3 on Windows)

Windows has no native GLES3; ANGLE provides it by translating GLES→D3D11. You need two DLLs next
to the exe (`native\target\debug\` and `...\release\`):

- `libEGL.dll`
- `libGLESv2.dll`

Easiest source: copy them from an installed **Chrome or Edge** (they ship ANGLE), or grab a build
from the [ANGLE project](https://github.com/google/angle) / an Electron release. Keep both
together; a mismatched pair fails oddly.

Copy from Chrome (run after the first `cargo build` creates `target\debug\`):

```powershell
$dest = "$PSScriptRoot\target\debug"   # or the absolute path to native\target\debug
New-Item -ItemType Directory -Force -Path $dest | Out-Null
$verDir = @(
  "C:\Program Files\Google\Chrome\Application",
  "C:\Program Files (x86)\Google\Chrome\Application",
  "$env:LOCALAPPDATA\Google\Chrome\Application"
) | Where-Object { Test-Path $_ } |
    ForEach-Object { Get-ChildItem $_ -Directory -ErrorAction SilentlyContinue } |
    Where-Object { Test-Path (Join-Path $_.FullName 'libEGL.dll') } |
    Sort-Object Name -Descending | Select-Object -First 1
Copy-Item (Join-Path $verDir.FullName 'libEGL.dll')    $dest -Force
Copy-Item (Join-Path $verDir.FullName 'libGLESv2.dll') $dest -Force
```

Manual fallback: open `chrome://version`, note the **Executable Path**, and copy `libEGL.dll` +
`libGLESv2.dll` from that version folder into `native\target\debug\`. (Edge works too:
`C:\Program Files (x86)\Microsoft\Edge\Application\<version>\`.)

The frontend already forces SDL to use ANGLE for GLES contexts on Windows
(`SDL_OPENGL_ES_DRIVER=1`, set in `src/sdl_gl.rs`) and `src/platform.rs` warns at startup if the
DLLs are missing.

## 4. A libretro core

You need a **Windows x64** N64 core (e.g. `mupen64plus_next_libretro.dll` or
`parallel_n64_libretro.dll`). N64 needs no BIOS. Loading + printing the core's info doesn't need a
ROM — just the core.

The app auto-detects a core placed in a `cores\` folder next to the exe
(`target\debug\cores\`, via `platform::default_core_path`), so that's where we'll put it.

### Method A — download the core directly (recommended, no RetroArch)

The libretro buildbot ships each core as a `.dll.zip`. Download and extract it into `cores\`:

```powershell
$cores = "C:\Users\grontis\_dev\crt-vizzie\native\target\debug\cores"
New-Item -ItemType Directory -Force -Path $cores | Out-Null
$zip = "$env:TEMP\mupen64plus_next_libretro.dll.zip"
Invoke-WebRequest `
  -Uri "https://buildbot.libretro.com/nightly/windows/x86_64/latest/mupen64plus_next_libretro.dll.zip" `
  -OutFile $zip
Expand-Archive -Path $zip -DestinationPath $cores -Force
Remove-Item $zip
Get-ChildItem "$cores\mupen64plus_next_libretro.dll" | Select-Object Name,Length
```

A `mupen64plus_next_libretro.dll` (~15–25 MB) in the listing means it's in place. If Windows
SmartScreen or AV quarantines the download, allow it (libretro cores are unsigned).

### Method B — via RetroArch (GUI alternative)

```powershell
winget install Libretro.RetroArch
```
Open RetroArch → *Main Menu → Online Updater → Core Downloader →
"Nintendo - Nintendo 64 (Mupen64Plus-Next)"*. The DLL lands in `<RetroArch>\cores\`. Copy it into
`native\target\debug\cores\` (or pass its full path with `--core`).

### Run it

With the core in `target\debug\cores\`, no `--core` flag is needed:

```powershell
cd C:\Users\grontis\_dev\crt-vizzie\native
cargo run -- --rom .\path\to\game.z64
```

The startup log reports the core (values illustrative):

```
[crt] core: Mupen64Plus-Next <version>
[crt]   valid_extensions: n64|v64|z64...
[crt]   need_fullpath: <true|false>   block_extract: false
```

To point at a specific core instead of the `cores\` folder:
`cargo run -- --core C:\path\to\mupen64plus_next_libretro.dll`. Note that `target\debug\cores\`
(like the ANGLE DLLs) is wiped by `cargo clean` — re-run Method A if you clean.

> **ANGLE vs desktop-GL caveat.** The same `#version 300 es` shaders and
> `RETRO_HW_CONTEXT_OPENGLES3` request are intended to run on both platforms via ANGLE. If a
> Windows core build does hardware render only through desktop GL (not ANGLE GLES), the fallback
> is desktop GL on Windows + GLES3 on the Pi — a `#version` swap and a context-type `cfg` branch.
> (See the note at the top of this file: the current build may already use desktop GL on Windows.)

## 5. A ROM

Any N64 ROM you legally own (`.z64` / `.n64` / `.v64`). Not committed (see `.gitignore`).

## 6. Build & run

```powershell
cd native
cargo run -- --core .\path\to\core.dll --rom .\path\to\game.z64
cargo run -- --core .\path\to\core.dll --rom .\path\to\game.z64 --demo-mode  # synthetic audio
cargo test                                  # exercises the dev synthetic-audio source
```

On a successful launch the visualizer renders over the game; the startup log reports the GL
version and the loaded core's info.

---

## Deploying to the Pi later

Nothing in the source changes. On the Pi: install `libsdl2-dev`, drop the **aarch64 GLES3**
`mupen64plus_next_libretro.so` in `cores/` (or pass `--core`), and `cargo run`. GLES3 is native
there, so ANGLE is not involved.
