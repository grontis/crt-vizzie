# native/

Planning and (eventually) source for the **native Rust libretro frontend** that composites the
crt-vizzie ASCII visualizer over a live N64 emulator on a Raspberry Pi 5. No code yet — this
directory currently holds the design.

- [`ARCHITECTURE.md`](./ARCHITECTURE.md) — the MVP architecture: module map, frame loop, timing
  model, composite shader, audio/bridge/atlas decisions, and what's cut.
- [`PHASE0_SPIKE.md`](./PHASE0_SPIKE.md) — the de-risking spike that gates the whole effort:
  get an N64 core to render into a frontend-owned GLES3 texture and onto a quad, at full speed,
  on the Pi 5. **Build this first.** Go/no-go for the project.

The visual engine being ported lives in [`../v2/`](../v2/); see [`../CLAUDE.md`](../CLAUDE.md)
for that architecture.

---

## Spike crate

A Cargo crate scaffolds the Phase 0 spike (`Cargo.toml` + `src/`). Status:

| Milestone | State |
|---|---|
| M0 — SDL2 GLES3 window + clear loop | **implemented** |
| M1 — load libretro core + print system info | **implemented** |
| M2 — environment callback | TODO (see `src/main.rs`) |
| M3 — load_game + hw-render FBO | TODO |
| M4–M6 — run, sample to quad, pace | TODO |

### Prerequisites
- Rust (stable) toolchain.
- **SDL2**: system lib by default — `libsdl2-dev` (Linux/Pi) or SDL2 dev libs on Windows.
  To build SDL2 from source instead, enable the `bundled` feature in `Cargo.toml` (needs a
  C toolchain + cmake).
- For M1+: a libretro core (`mupen64plus_next_libretro.so`, **GLES3 build** for the Pi) and an
  N64 ROM you legally own. Neither is committed (see `.gitignore`).

**Developing on Windows → deploying to Pi:** the code is cross-platform. On Windows the GLES3
context comes from ANGLE and the core is a `.dll`. Full setup (Rust + MSVC, SDL2, ANGLE DLLs,
getting a Windows core) is in [`WINDOWS_DEV.md`](./WINDOWS_DEV.md). A `cores/` folder next to the
exe is auto-scanned for the platform-default core when `--core` is omitted
(`src/platform.rs`). A dev-only synthetic audio source (`src/audio_dev.rs`, a port of the v2 demo
synth) lets you develop the visualizer with no audio hardware attached — it lands with Phase 3.

### Build & run
```sh
cd native
cargo run                                   # M0: a magenta window (Esc/close to quit)
cargo run -- --core /path/to/core.so        # M0 + M1: also logs the core's name/version/exts
cargo run -- --core /path/to/core.so --rom /path/to/game.z64   # --rom used from M3 on
```

> Not yet built/run anywhere — there was no Rust toolchain on the authoring machine. Expect to
> fix minor dependency-version or API drift on first `cargo build`; the logic is the point.

