# native/

The **native Rust libretro frontend** that composites the crt-vizzie ASCII visualizer over a
live N64 emulator, targeting a Raspberry Pi 5 (and developed on Windows).

It runs an N64 core into a frontend-owned GL texture, runs the figure/rain/wave/glitch animation
engine, and renders that animation **masked by the game's edges and dark space** — the on-screen
shapes get carved out of an audio-reactive ASCII field. See
[`ARCHITECTURE.md`](./ARCHITECTURE.md) for the module map, frame loop, timing model, composite
shader, and the masking math.

The visual engine being ported lives in [`../v2/`](../v2/); see [`../CLAUDE.md`](../CLAUDE.md)
for that architecture and project-wide conventions.

---

## Prerequisites

- Rust (stable) toolchain.
- **SDL2**: built from source and static-linked on Windows (needs a C toolchain + cmake);
  the system `libsdl2-dev` on Linux/Pi.
- A libretro N64 core (e.g. `mupen64plus_next_libretro` / `parallel_n64_libretro`; a **GLES3
  build** for the Pi) and an N64 ROM you legally own. Neither is committed (see `.gitignore`).

A `cores/` folder next to the exe is auto-scanned for a platform-default core when `--core` is
omitted (`src/platform.rs`). A synthetic audio source (`src/audio_dev.rs`, a port of the v2 demo
synth) lets you develop with no audio hardware attached, via `--demo-mode`.

For the full Windows setup (Rust + MSVC, SDL2, getting a Windows core), see
[`WINDOWS_DEV.md`](./WINDOWS_DEV.md).

## Build & run

For development (fast incremental builds, unoptimized):

```sh
cd native
cargo run -- --core /path/to/core --rom /path/to/game.z64
cargo run -- --core /path/to/core --rom /path/to/game.z64 --demo-mode  # synthetic audio
cargo run -- --core /path/to/core --rom /path/to/game.z64 --fullscreen # launch fullscreen
```

Flags: `--demo-mode` uses the synthetic audio source, and `--fullscreen` starts in borderless
desktop fullscreen (equivalent to pressing F at runtime).

For Pi deployment, build optimized — the release profile (LTO + single codegen unit) and
`target-cpu=cortex-a76` tuning matter for the per-frame fusion loops and the FFT. Use the
helper, which builds `--release` and runs the resulting binary:

```sh
cd native
./scripts/run-release.sh /path/to/game.z64                      # bare ROM → default core in ./cores/
./scripts/run-release.sh --core ./cores/foo.so --rom game.z64   # explicit core, extra args forwarded
```

Equivalently, by hand:

```sh
cargo build --release
./target/release/crt-vizzie --core ./cores/mupen64plus_next_libretro.so --rom game.z64
```

The N64 render back-end is Angrylion software RDP (multithreaded) + cxd4 RSP — see
[`ARCHITECTURE.md`](./ARCHITECTURE.md) ("core configuration") for the option details and why the
GLideN64 GPU path is not currently usable.

## Controls

| Key | Action |
|-----|--------|
| P | Cycle phosphor preset (red → amber → green → blue → white) |
| S | Cycle scanline mode (off → pixel → cell-gap → smooth) |
| B | Toggle the game underlay (glyphs over the game vs. glyphs on black) |
| F | Toggle fullscreen |
| U | Toggle the debug slider panel (live param tuning; hidden at launch) |
| Esc | Quit |
