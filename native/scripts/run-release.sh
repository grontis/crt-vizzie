#!/bin/bash
# run-release.sh — build and launch the native frontend optimized (Raspberry Pi deployment).
#
# Usage:
#   ./scripts/run-release.sh /path/to/game.z64 [extra args…]   # bare ROM → default core
#   ./scripts/run-release.sh --core ./cores/foo.so --rom game.z64 [--demo-mode …]
#
# Builds in release mode (LTO + single codegen unit + cortex-a76 tuning, see Cargo.toml and
# .cargo/config.toml) then runs ./target/release/crt-vizzie. All arguments are forwarded to the
# binary. If the first argument is a plain path (not a -flag), it is treated as the ROM and the
# default core in ./cores/ is used.
#
# For fast iteration during development use `cargo run -- …` (debug) instead — see README.md.

set -euo pipefail

NATIVE_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$NATIVE_DIR"

DEFAULT_CORE="$NATIVE_DIR/cores/mupen64plus_next_libretro.so"
BIN="$NATIVE_DIR/target/release/crt-vizzie"

echo "[run-release] building (release profile)…"
cargo build --release

# Convenience: a bare ROM path as the first arg fills in --core (default) and --rom.
if [[ $# -ge 1 && "${1:0:1}" != "-" ]]; then
    ROM="$1"; shift
    exec "$BIN" --core "$DEFAULT_CORE" --rom "$ROM" "$@"
fi

exec "$BIN" "$@"
