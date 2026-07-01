//! Game-controller input: bridges an SDL2 joystick to the libretro core.
//!
//! The core polls input every frame through the frontend's `input_state` callback (registered in
//! `frontend.rs`). That callback runs on the core's emu thread, so controller state lives in a
//! lock-free table here: the main thread reads SDL each frame via [`Gamepads::poll`] and publishes
//! into [`PADS`]; the emu thread reads it back through [`state`].
//!
//! We read the **raw joystick** rather than SDL's GameController abstraction: the low-cost N64 USB
//! pads report a layout SDL's built-in mapping guesses wrong (dead Start, unmapped C-buttons, an
//! analog stick on the wrong axes). Binding raw indices ourselves is exact. Buttons are reported to
//! the core as a RetroPad; mupen64plus-next applies its own RetroPad→N64 mapping on top.

use std::sync::atomic::{AtomicI32, AtomicU32, Ordering};
use std::sync::OnceLock;

use sdl2::event::Event;
use sdl2::joystick::{HatState, Joystick};
use sdl2::JoystickSubsystem;

// libretro device classes the core queries (retro_set_controller_port_device defaults to JOYPAD).
pub const RETRO_DEVICE_JOYPAD: u32 = 1;
pub const RETRO_DEVICE_ANALOG: u32 = 5;
pub const RETRO_DEVICE_INDEX_ANALOG_LEFT: u32 = 0;
pub const RETRO_DEVICE_INDEX_ANALOG_RIGHT: u32 = 1;

// RETRO_DEVICE_ID_JOYPAD_* — bit positions in the per-port button mask. mupen64plus-next's fixed
// RetroPad→N64 map is non-obvious: N64 A ← RetroPad B, N64 B ← RetroPad Y, N64 Z ← RetroPad L2,
// and the C-buttons ← the right analog stick (handled below). RetroPad A/X are not read at all.
const ID_B: u32 = 0; // → N64 A
const ID_Y: u32 = 1; // → N64 B
const ID_START: u32 = 3;
const ID_UP: u32 = 4;
const ID_DOWN: u32 = 5;
const ID_LEFT: u32 = 6;
const ID_RIGHT: u32 = 7;
const ID_L: u32 = 10;
const ID_R: u32 = 11;
const ID_L2: u32 = 12; // → N64 Z-trigger

// ── Physical layout of the kiwitata / "SWITCH CO.,LTD." N64 USB pad ───────────────────────────
// Raw indices captured with `cargo run --example input_probe`. Edit these to match a different pad.
const BTN_A: u32 = 2;
const BTN_B: u32 = 1;
const BTN_Z: u32 = 6;
const BTN_START: u32 = 12;
const BTN_L: u32 = 4;
const BTN_R: u32 = 5;
const BTN_C_UP: u32 = 9;
const BTN_C_DOWN: u32 = 3;
const BTN_C_LEFT: u32 = 0;
const BTN_C_RIGHT: u32 = 8;
// Analog stick axes (up/left read negative, matching the RetroPad convention the core expects).
const AXIS_X: u32 = 0;
const AXIS_Y: u32 = 1;

// Full deflection reported for a C-button (mupen64plus-next reads the N64 C-buttons from the right
// analog stick by default, so a pressed C maps to a hard right-stick push in that direction).
const AXIS_MAX: i32 = 32767;

const MAX_PORTS: usize = 4;

/// Shared per-port controller state, published by the main thread and read by the emu thread.
struct Pad {
    buttons: AtomicU32,     // bit N set = RETRO_DEVICE_ID_JOYPAD_N pressed
    analog: [AtomicI32; 4], // left X, left Y, right X, right Y  (each -32768..32767)
}

impl Pad {
    const fn new() -> Self {
        Pad {
            buttons: AtomicU32::new(0),
            analog: [AtomicI32::new(0), AtomicI32::new(0), AtomicI32::new(0), AtomicI32::new(0)],
        }
    }
}

static PADS: [Pad; MAX_PORTS] = [Pad::new(), Pad::new(), Pad::new(), Pad::new()];

/// Zero a port's shared state. Called when its controller is unplugged so a button held at the
/// moment of disconnect doesn't stay latched "down" in the table the core reads.
fn clear_pad(port: usize) {
    let pad = &PADS[port];
    pad.buttons.store(0, Ordering::Relaxed);
    for axis in &pad.analog {
        axis.store(0, Ordering::Relaxed);
    }
}

fn debug_enabled() -> bool {
    static ENABLED: OnceLock<bool> = OnceLock::new();
    *ENABLED.get_or_init(|| std::env::var_os("CRT_INPUT_DEBUG").is_some())
}

/// Edge-triggered value logging for `CRT_INPUT_DEBUG`: reports when a JOYPAD id transitions to
/// pressed and when an ANALOG slot swings to a large deflection — i.e. the exact values the core
/// receives for each slot. Dev diagnostic only.
fn debug_value(device: u32, index: u32, id: u32, value: i16) {
    if !debug_enabled() {
        return;
    }
    match device {
        RETRO_DEVICE_JOYPAD if id < 16 => {
            static PREV: AtomicU32 = AtomicU32::new(0);
            let bit = 1 << id;
            if value != 0 {
                if PREV.fetch_or(bit, Ordering::Relaxed) & bit == 0 {
                    eprintln!("[input-dbg] JOYPAD id={} -> PRESSED", id);
                }
            } else {
                PREV.fetch_and(!bit, Ordering::Relaxed);
            }
        }
        RETRO_DEVICE_ANALOG => {
            static BIG: AtomicU32 = AtomicU32::new(0);
            let slot = index * 2 + id; // 0=LX 1=LY 2=RX 3=RY
            let bit = 1 << slot;
            if (value as i32).abs() > 16000 {
                if BIG.fetch_or(bit, Ordering::Relaxed) & bit == 0 {
                    eprintln!("[input-dbg] ANALOG index={} id={} = {}", index, id, value);
                }
            } else {
                BIG.fetch_and(!bit, Ordering::Relaxed);
            }
        }
        _ => {}
    }
}

/// Answer a single core input query. Called from the frontend `input_state` callback on the core's
/// emu thread; must stay lock-free. Returns 0 for any device/port/id we don't model.
pub fn state(port: u32, device: u32, index: u32, id: u32) -> i16 {
    let port = port as usize;
    if port >= MAX_PORTS {
        return 0;
    }
    let pad = &PADS[port];
    // The core may OR a subclass into the high bits of `device`; only the low byte is the class.
    let device = device & 0xff;
    let value = match device {
        RETRO_DEVICE_JOYPAD => {
            if id >= 16 {
                return 0;
            }
            ((pad.buttons.load(Ordering::Relaxed) >> id) & 1) as i16
        }
        RETRO_DEVICE_ANALOG => {
            let axis = match (index, id) {
                (RETRO_DEVICE_INDEX_ANALOG_LEFT, 0) => 0,
                (RETRO_DEVICE_INDEX_ANALOG_LEFT, 1) => 1,
                (RETRO_DEVICE_INDEX_ANALOG_RIGHT, 0) => 2,
                (RETRO_DEVICE_INDEX_ANALOG_RIGHT, 1) => 3,
                _ => return 0,
            };
            pad.analog[axis].load(Ordering::Relaxed) as i16
        }
        _ => 0,
    };
    debug_value(device, index, id, value);
    value
}

/// Owns the opened SDL joysticks, one per port slot. Kept alive for the session; dropped before the
/// SDL subsystem it references.
///
/// Hot-plug: joysticks are opened and closed only in [`Gamepads::handle_event`], which the main
/// loop feeds every SDL event. SDL emits a `JoyDeviceAdded` for each already-connected device on the
/// first event pump, so pre-connected and hot-plugged pads take the same path.
pub struct Gamepads {
    subsys: JoystickSubsystem,
    // Index == libretro port. A pad keeps its port even if another is unplugged.
    pads: [Option<Joystick>; MAX_PORTS],
}

impl Gamepads {
    /// Create the subsystem with no pads open yet — they arrive via `JoyDeviceAdded` events
    /// (including one per pre-connected device on the first event pump).
    pub fn new(sdl: &sdl2::Sdl) -> Result<Self, String> {
        let subsys = sdl.joystick()?;
        Ok(Gamepads { subsys, pads: std::array::from_fn(|_| None) })
    }

    /// Route an SDL event: open/close pads on connect/disconnect. Call for every event.
    pub fn handle_event(&mut self, event: &Event) {
        match *event {
            // `which` here is a joystick index — the argument `open` expects.
            Event::JoyDeviceAdded { which, .. } => self.add(which),
            // `which` here is the instance id — matched against an open joystick.
            Event::JoyDeviceRemoved { which, .. } => self.remove(which),
            _ => {}
        }
    }

    /// Open a newly connected pad into the lowest free port. No-op for a device already held or when
    /// every port is occupied.
    fn add(&mut self, joystick_index: u32) {
        let joystick = match self.subsys.open(joystick_index) {
            Ok(j) => j,
            Err(e) => {
                eprintln!("[input] joystick open failed (index {}): {}", joystick_index, e);
                return;
            }
        };
        // SDL can surface the same device more than once (e.g. a startup ADDED event for a device
        // already open). Dropping this second handle here avoids a double open/close of one device.
        let iid = joystick.instance_id();
        if self.pads.iter().flatten().any(|j| j.instance_id() == iid) {
            return;
        }
        match self.pads.iter().position(Option::is_none) {
            Some(port) => {
                eprintln!(
                    "[input] gamepad connected → port {}: {} ({} buttons, {} axes, {} hats)",
                    port,
                    joystick.name(),
                    joystick.num_buttons(),
                    joystick.num_axes(),
                    joystick.num_hats()
                );
                self.pads[port] = Some(joystick);
            }
            None => eprintln!(
                "[input] gamepad '{}' ignored — all {} ports in use",
                joystick.name(),
                MAX_PORTS
            ),
        }
    }

    /// Close a disconnected pad and clear its port's latched input.
    fn remove(&mut self, instance_id: u32) {
        for port in 0..MAX_PORTS {
            let is_match = self.pads[port].as_ref().is_some_and(|j| j.instance_id() == instance_id);
            if is_match {
                let name = self.pads[port].as_ref().map(Joystick::name).unwrap_or_default();
                eprintln!("[input] gamepad disconnected ← port {}: {}", port, name);
                self.pads[port] = None;
                clear_pad(port);
                return;
            }
        }
    }

    /// Read live SDL joystick state into the shared table. Call once per frame, after the event pump
    /// (which is what refreshes SDL's internal joystick state), and before running the core.
    pub fn poll(&self) {
        for (port, slot) in self.pads.iter().enumerate() {
            let Some(j) = slot else { continue };
            let pressed = |idx: u32| j.button(idx).unwrap_or(false);

            let mut mask: u32 = 0;
            let mut set = |id: u32, on: bool| {
                if on {
                    mask |= 1 << id;
                }
            };
            set(ID_B, pressed(BTN_A)); // physical A → N64 A
            set(ID_Y, pressed(BTN_B)); // physical B → N64 B
            set(ID_START, pressed(BTN_START));
            set(ID_L2, pressed(BTN_Z)); // physical Z → N64 Z-trigger
            set(ID_L, pressed(BTN_L));
            set(ID_R, pressed(BTN_R));

            // D-pad lives on hat 0 (the analog stick is on the axes below).
            let hat = j.hat(0).unwrap_or(HatState::Centered);
            set(ID_UP, matches!(hat, HatState::Up | HatState::LeftUp | HatState::RightUp));
            set(ID_DOWN, matches!(hat, HatState::Down | HatState::LeftDown | HatState::RightDown));
            set(ID_LEFT, matches!(hat, HatState::Left | HatState::LeftUp | HatState::LeftDown));
            set(ID_RIGHT, matches!(hat, HatState::Right | HatState::RightUp | HatState::RightDown));

            // C-buttons → hard deflection of the right analog stick (the core's default C source).
            let mut right_x = 0;
            let mut right_y = 0;
            if pressed(BTN_C_LEFT) {
                right_x -= AXIS_MAX;
            }
            if pressed(BTN_C_RIGHT) {
                right_x += AXIS_MAX;
            }
            if pressed(BTN_C_UP) {
                right_y -= AXIS_MAX;
            }
            if pressed(BTN_C_DOWN) {
                right_y += AXIS_MAX;
            }

            let pad = &PADS[port];
            pad.buttons.store(mask, Ordering::Relaxed);
            pad.analog[0].store(j.axis(AXIS_X).unwrap_or(0) as i32, Ordering::Relaxed);
            pad.analog[1].store(j.axis(AXIS_Y).unwrap_or(0) as i32, Ordering::Relaxed);
            pad.analog[2].store(right_x, Ordering::Relaxed);
            pad.analog[3].store(right_y, Ordering::Relaxed);
        }
    }
}
