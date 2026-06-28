//! Phase 4 — Hardware Input: MCP3008 SPI ADC knobs + GPIO pushbuttons + GPIO LED bank.
//!
//! Architecture mirrors Phase 3 `AudioSource` pattern:
//!   - `pub trait HardwareInput` — uniform interface polled once per 30 Hz tick
//!   - `DevHardwareInput` — no-op stub (all platforms, zero new dependencies)
//!   - `GpioHardwareInput` — `#[cfg(target_os = "linux")]` only (rppal >= 0.19 required
//!     for Pi 5's RP1 GPIO controller via the character-device API)
//!   - `pub fn new_hardware_input()` — cfg-selected factory with fallback
//!
//! Set `CRT_HW_DEBUG=1` to enable per-tick diagnostic prints (mirrors `CRT_AUDIO_DEBUG`).

use std::time::Instant;

use crate::audio_dev::Bands;
use crate::config::{Params, PHOSPHOR_ORDER};
// HW_KNOB_ALPHA_MIN/MAX are only consumed inside the Linux-gated GpioHardwareInput::poll.
#[cfg(target_os = "linux")]
use crate::config::{HW_KNOB_ALPHA_MAX, HW_KNOB_ALPHA_MIN};

// ── Constants ─────────────────────────────────────────────────────────────────

/// ADC dead-zone: a channel's raw value must change by more than this to be forwarded.
/// Mirrors bridge.py `DEAD_ZONE = 0.005`.
const DEAD_ZONE: f32 = 0.005;

/// LED on/off threshold for Phase 4 (threshold-based, not PWM).
/// Band level > LED_THRESHOLD → pin high; else pin low.
/// Software-PWM dimming is explicitly deferred to Phase 5.
const LED_THRESHOLD: f32 = 0.5;

/// Software debounce window in milliseconds. Mirrors bridge.py `bounce_time=0.05`.
const DEBOUNCE_MS: u64 = 50;

// ── Knob mapping table ────────────────────────────────────────────────────────

/// Action to apply when a knob value is written to `Params`.
pub(crate) enum ParamWrite {
    /// Linear-interpolate raw ADC [0, 1] to [min, max] and write to the named field.
    Float {
        field: fn(&mut Params) -> &mut f32,
        min: f32,
        max: f32,
    },
    /// Scale raw ADC [0, 1] → truncated index in 0..PHOSPHOR_ORDER.len().
    /// Discrete cycling via a continuous knob (bridge.py phosphorIndex mapping).
    PhosphorIndex,
    /// Physical channel exists but has no native `Params` equivalent in Phase 4.
    /// Reactivate when bgFxHueShift (ch 2) or bgAsciiLevel (ch 5) land natively.
    Unmapped,
}

pub(crate) struct KnobEntry {
    /// Reserved for future multi-chip expansion (e.g., a second MCP3008 on CE1).
    /// `read_adc` currently always uses `Bus::Spi0` and ignores this field.
    pub chip: u8,
    pub ch: u8,
    pub write: ParamWrite,
}

/// Knob mapping table — mirrors bridge.py `CHANNELS`.
///
/// ch 0 intentionally drives three params from one pot (bridge.py comment:
/// "shadowed, reassign once more pots are wired"). ch 2 and ch 5 have physical
/// hardware channels but no native `Params` fields in Phase 4 (Unmapped).
static KNOBS: &[KnobEntry] = &[
    // chip 0, ch 0 — single pot simultaneously drives three rain params
    KnobEntry { chip: 0, ch: 0, write: ParamWrite::Float { field: |p| &mut p.rain_opacity,   min: 0.0,   max: 1.0  } },
    KnobEntry { chip: 0, ch: 0, write: ParamWrite::Float { field: |p| &mut p.rain_burn_boost, min: 0.0,   max: 0.5  } },
    KnobEntry { chip: 0, ch: 0, write: ParamWrite::Float { field: |p| &mut p.rain_speed_min,  min: 0.01,  max: 0.2  } },
    // chip 0, ch 1 — bg_opacity
    KnobEntry { chip: 0, ch: 1, write: ParamWrite::Float { field: |p| &mut p.bg_opacity,      min: 0.0,   max: 1.0  } },
    // chip 0, ch 2 — bgFxHueShift (CSS hue-rotate filter — no native equivalent; Phase 4 no-op)
    KnobEntry { chip: 0, ch: 2, write: ParamWrite::Unmapped },
    // chip 0, ch 3 — glitch_scatter
    KnobEntry { chip: 0, ch: 3, write: ParamWrite::Float { field: |p| &mut p.glitch_scatter,  min: 0.045, max: 0.15 } },
    // chip 0, ch 4 — fig_brightness
    KnobEntry { chip: 0, ch: 4, write: ParamWrite::Float { field: |p| &mut p.fig_brightness,  min: 0.5,   max: 1.0  } },
    // chip 0, ch 5 — bgAsciiLevel (background-as-ASCII luma layer — no native equivalent; Phase 4 no-op)
    KnobEntry { chip: 0, ch: 5, write: ParamWrite::Unmapped },
    // chip 0, ch 6 — phosphor_index (discrete cycling via continuous knob)
    KnobEntry { chip: 0, ch: 6, write: ParamWrite::PhosphorIndex },
];

// ── Button mapping table ──────────────────────────────────────────────────────

/// Action to invoke when a confirmed button press is detected.
pub(crate) enum ButtonAction {
    /// Advance `phosphor_index` by one, wrapping. Phase 4 remap for GPIO 23 (was `next_bg`).
    /// Mirrors the P key behavior in sketch.js.
    CyclePhosphor,
    /// Toggle a boolean `Params` field. Phase 4 remap for GPIO 24 (was `toggle_bg_ascii`).
    /// GPIO 24 → `bg_enabled`, mirroring the B key.
    ToggleBool(fn(&mut Params) -> &mut bool),
    /// No action — reserved for future remapping.
    #[allow(dead_code)]
    NoOp,
}

pub(crate) struct ButtonEntry {
    pub gpio: u8,
    pub action: ButtonAction,
}

/// Button mapping table — mirrors bridge.py `BUTTON_CONFIG` with interim action remaps.
///
/// Original bridge.py events (`next_bg`, `toggle_bg_ascii`) had no native equivalent in
/// Phase 4. Interim remaps confirmed by user 2026-06-28:
///   GPIO 23 → CyclePhosphor (P-key analog)
///   GPIO 24 → ToggleBool(bg_enabled) (B-key analog)
static BUTTONS: &[ButtonEntry] = &[
    ButtonEntry { gpio: 23, action: ButtonAction::CyclePhosphor },
    ButtonEntry { gpio: 24, action: ButtonAction::ToggleBool(|p| &mut p.bg_enabled) },
];

// ── LED mapping table ─────────────────────────────────────────────────────────

pub(crate) enum LedBand { Sub, Bass, LowMid, Mid, HighMid, Treble }

pub(crate) struct LedEntry {
    pub gpio: u8,
    pub band: LedBand,
}

/// LED mapping table — mirrors bridge.py `LED_CONFIG`.
/// Six GPIO outputs driven by audio band levels. Phase 4: threshold on/off only.
/// Software-PWM dimming deferred to Phase 5.
static LEDS: &[LedEntry] = &[
    LedEntry { gpio: 17, band: LedBand::Sub },
    LedEntry { gpio: 27, band: LedBand::Bass },
    LedEntry { gpio: 22, band: LedBand::LowMid },
    LedEntry { gpio: 5,  band: LedBand::Mid },
    LedEntry { gpio: 6,  band: LedBand::HighMid },
    LedEntry { gpio: 13, band: LedBand::Treble },
];

// ── Host-testable processing functions ────────────────────────────────────────
//
// These functions contain no GPIO/SPI imports and compile on all platforms.
// Unit tests call them directly without hardware.

/// Returns `true` if the raw ADC value has changed more than `DEAD_ZONE` from `last`.
/// Mirrors bridge.py: `if abs(value - last) > DEAD_ZONE`.
pub(crate) fn passes_dead_zone(raw: f32, last: f32) -> bool {
    (raw - last).abs() > DEAD_ZONE
}

/// One step of the first-order low-pass (exponential smoothing) filter.
/// `smoothed = alpha * raw + (1.0 - alpha) * prev`
/// - `alpha = 1.0` → pass-through (no smoothing)
/// - `alpha = 0.0` → frozen at `prev`
pub(crate) fn low_pass(raw: f32, prev: f32, alpha: f32) -> f32 {
    alpha * raw + (1.0 - alpha) * prev
}

/// Apply a `KnobEntry`'s `ParamWrite` to `params` given a normalized smoothed ADC value
/// in [0, 1].
///
/// - `Float`: linearly maps [0, 1] → [min, max] and clamps.
/// - `PhosphorIndex`: truncates to a valid index in `0..PHOSPHOR_ORDER.len()`.
/// - `Unmapped`: no-op.
pub(crate) fn apply_knob(entry: &KnobEntry, smoothed: f32, params: &mut Params) {
    match &entry.write {
        ParamWrite::Float { field, min, max } => {
            let value = (min + smoothed * (max - min)).clamp(*min, *max);
            *field(params) = value;
        }
        ParamWrite::PhosphorIndex => {
            let count = PHOSPHOR_ORDER.len(); // 5
            // Scale [0, 1] → [0, count). Clamp to count-1 so smoothed=1.0 doesn't overflow.
            let idx = (smoothed * count as f32) as usize;
            params.phosphor_index = idx.min(count - 1);
        }
        ParamWrite::Unmapped => {} // physical channel has no native param in Phase 4
    }
}

/// Apply a `ButtonAction` to `params` on a confirmed press.
pub(crate) fn apply_button(action: &ButtonAction, params: &mut Params) {
    match action {
        ButtonAction::CyclePhosphor => {
            params.phosphor_index = (params.phosphor_index + 1) % PHOSPHOR_ORDER.len();
        }
        ButtonAction::ToggleBool(field) => {
            let b = field(params);
            *b = !*b;
        }
        ButtonAction::NoOp => {}
    }
}

/// Returns `true` if enough time has elapsed since `last_change` to accept a new edge.
/// 50 ms software debounce — mirrors bridge.py `bounce_time=0.05`.
pub(crate) fn debounce_ok(now: Instant, last_change: Instant) -> bool {
    now.duration_since(last_change).as_millis() as u64 >= DEBOUNCE_MS
}

/// Select a band level from `Bands` by `LedBand` variant.
pub(crate) fn band_level(bands: &Bands, which: &LedBand) -> f32 {
    match which {
        LedBand::Sub     => bands.sub,
        LedBand::Bass    => bands.bass,
        LedBand::LowMid  => bands.low_mid,
        LedBand::Mid     => bands.mid,
        LedBand::HighMid => bands.high_mid,
        LedBand::Treble  => bands.treble,
    }
}

/// Core knob dispatch: given a snapshot of raw ADC channel readings (`ch_raw[0..7]`),
/// run the dead-zone gate **once per unique physical channel**, update `last_adc` for
/// channels that passed, then apply every `KNOBS` entry whose channel is active.
///
/// This is a pure function (no SPI/GPIO calls) — all channel reads have already occurred.
/// `GpioHardwareInput::poll()` reads the SPI bus into `ch_raw`, then delegates here,
/// making this the host-testable unit of the knob pipeline.
///
/// Unmapped channels are never checked against the dead-zone and never update `last_adc`.
/// The low-pass `smoothed` slice is indexed by `KNOBS` entry position (one slot per entry,
/// including Unmapped slots, which are never written — see `try_new()` comment).
pub(crate) fn dispatch_knob_readings(
    ch_raw:   &[f32; 8],
    last_adc: &mut [f32; 8],
    smoothed: &mut [f32],
    alpha:    f32,
    hw_dbg:   bool,
    params:   &mut Params,
) {
    // Pre-pass: run dead-zone gate once per unique mapped physical channel.
    // `ch_checked[ch]` prevents re-testing a channel that shares multiple KNOBS entries.
    let mut ch_active  = [false; 8];
    let mut ch_checked = [false; 8];
    for entry in KNOBS.iter() {
        if matches!(entry.write, ParamWrite::Unmapped) { continue; }
        let ch = entry.ch as usize;
        if !ch_checked[ch] {
            ch_checked[ch] = true;
            if passes_dead_zone(ch_raw[ch], last_adc[ch]) {
                ch_active[ch] = true;
                last_adc[ch]  = ch_raw[ch]; // update last_adc exactly once per channel
            }
        }
    }

    // Apply-pass: advance the low-pass filter and write params for every entry whose
    // channel is active. Entries on inactive channels are skipped entirely.
    for (entry_idx, entry) in KNOBS.iter().enumerate() {
        if matches!(entry.write, ParamWrite::Unmapped) { continue; }
        let ch = entry.ch as usize;
        if !ch_active[ch] { continue; }

        let raw       = ch_raw[ch];
        let new_smooth = low_pass(raw, smoothed[entry_idx], alpha);
        smoothed[entry_idx] = new_smooth;

        if hw_dbg {
            // `entry.chip` is reserved for future multi-chip expansion; currently always 0.
            eprintln!("[hwdbg] knob chip{} ch{} raw={:.3} smoothed={:.3}",
                entry.chip, entry.ch, raw, new_smooth);
        }

        apply_knob(entry, new_smooth, params);
    }
}

/// Returns `true` and sets `warned` the first time the button thread disconnects;
/// returns `false` on every subsequent call.  Keeps the one-time warning logic
/// host-testable and out of the `#[cfg(target_os = "linux")]` block.
pub(crate) fn should_warn_disconnect(warned: &mut bool) -> bool {
    if !*warned {
        *warned = true;
        true
    } else {
        false
    }
}

// ── HardwareInput trait ───────────────────────────────────────────────────────

/// Uniform interface over hardware input sources.
///
/// Called once per 30 Hz logic tick in `main.rs` **after** `audio.update()` and
/// **before** `fusion.update()`, so LED writes see the current `audio.bands()` and
/// param changes take effect in the same tick.
///
/// Dispatch is via vtable through `Box<dyn HardwareInput>`; overhead is negligible
/// at 30 Hz.
pub trait HardwareInput {
    /// Read hardware state, write clamped values into `params`, and drive LED outputs
    /// from `bands`. Must not block; called from the main render thread.
    fn poll(&mut self, params: &mut Params, bands: Bands);

    /// `true` when real GPIO hardware is active (for debug prints / status bar).
    fn is_live(&self) -> bool;
}

// ── DevHardwareInput — no-op stub, all platforms ──────────────────────────────

/// No-op hardware input stub. Zero dependencies beyond the trait definition.
/// Returned by `new_hardware_input()` on non-Linux platforms or when GPIO init fails.
pub struct DevHardwareInput;

impl HardwareInput for DevHardwareInput {
    #[inline]
    fn poll(&mut self, _params: &mut Params, _bands: Bands) {}

    #[inline]
    fn is_live(&self) -> bool { false }
}

// ── GpioHardwareInput — Linux only ────────────────────────────────────────────

#[cfg(target_os = "linux")]
use std::sync::{
    atomic::{AtomicBool, Ordering},
    mpsc, Arc,
};
#[cfg(target_os = "linux")]
use std::time::Duration;
#[cfg(target_os = "linux")]
use rppal::gpio::{Gpio, InputPin, Level, OutputPin, Trigger};
#[cfg(target_os = "linux")]
use rppal::spi::{Bus, Mode, SlaveSelect, Spi};

/// Per-button software debounce state.
#[cfg(target_os = "linux")]
struct ButtonDebounce {
    /// Last confirmed state: `true` = pressed (Low with pull-up).
    last_state: bool,
    /// Time of the last confirmed state change.
    last_change: Instant,
}

/// Real hardware input: MCP3008 SPI ADC knobs + GPIO pushbuttons + GPIO LED bank.
///
/// Linux only; requires `rppal >= 0.19` for Pi 5's RP1 controller
/// (character-device GPIO API at `/dev/gpiochip4`).
///
/// SPI is read synchronously in-tick (~70 µs for 7 active channels at 1 MHz — negligible
/// at 30 Hz). Button edges are detected on a background thread via blocking
/// `InputPin::poll_interrupt` calls, delivered to `poll()` through an `mpsc` channel.
#[cfg(target_os = "linux")]
pub struct GpioHardwareInput {
    spi: Spi,

    /// Per-MCP3008-channel last raw ADC value [0..8] for dead-zone comparison.
    last_adc: [f32; 8],

    /// Per-`KNOBS`-entry smoothed value for the low-pass filter.
    smoothed: Vec<f32>,

    /// Button edge events from the background thread: `(button_index, is_pressed)`.
    btn_rx: mpsc::Receiver<(usize, bool)>,

    /// Per-button software debounce state.
    btn_debounce: Vec<ButtonDebounce>,

    /// GPIO LED output pins, ordered to match the `LEDS` table.
    led_pins: Vec<OutputPin>,

    /// Signals the background button-poll thread to exit when `GpioHardwareInput` is dropped.
    _stop: Arc<AtomicBool>,

    /// Set to `true` the first time `btn_rx` returns `Disconnected`; suppresses repeat
    /// warnings on every subsequent tick after the button thread has exited.
    btn_disconnected: bool,

    /// Incremented each `poll()` call; used to gate the `CRT_HW_DEBUG` env-var check
    /// to ~1 Hz instead of every 30 Hz tick (matches the Phase 3 `audio.rs` pattern).
    dbg_tick: u32,

    /// Cached result of the last `CRT_HW_DEBUG` env-var check.
    dbg_check: bool,
}

#[cfg(target_os = "linux")]
impl GpioHardwareInput {
    /// Try to open SPI0/CE0, configure GPIO LEDs and buttons, and start the button-poll thread.
    ///
    /// Returns `Err` if any GPIO or SPI resource cannot be acquired (e.g., running on a
    /// non-Pi Linux machine without `/dev/gpiochip4`). The factory falls back to
    /// `DevHardwareInput` in that case.
    pub fn try_new() -> Result<Self, Box<dyn std::error::Error>> {
        // ── SPI (MCP3008 ADC) ─────────────────────────────────────────────────
        // Bus 0, CE0, 1 MHz, SPI Mode 0 — matches bridge.py spidev settings.
        let spi = Spi::new(Bus::Spi0, SlaveSelect::Ss0, 1_000_000, Mode::Mode0)?;
        eprintln!("[hw] SPI0 CE0 opened at 1 MHz (MCP3008)");

        let gpio = Gpio::new()?;

        // ── LED output pins ───────────────────────────────────────────────────
        let mut led_pins: Vec<OutputPin> = Vec::with_capacity(LEDS.len());
        for entry in LEDS.iter() {
            let pin = gpio.get(entry.gpio)?.into_output_low();
            led_pins.push(pin);
        }
        eprintln!("[hw] {} LED outputs initialized (GPIO {:?})",
            led_pins.len(),
            LEDS.iter().map(|e| e.gpio).collect::<Vec<_>>());

        // ── Button input pins ─────────────────────────────────────────────────
        let mut button_pins: Vec<InputPin> = Vec::with_capacity(BUTTONS.len());
        for entry in BUTTONS.iter() {
            let mut pin = gpio.get(entry.gpio)?.into_input_pullup();
            pin.set_interrupt(Trigger::Both)?;
            button_pins.push(pin);
        }
        eprintln!("[hw] {} button inputs initialized (GPIO {:?})",
            button_pins.len(),
            BUTTONS.iter().map(|e| e.gpio).collect::<Vec<_>>());

        // ── Background button-poll thread ─────────────────────────────────────
        // Polls each pin with a 5 ms timeout so all pins are checked within ~10 ms per
        // cycle — well within the 50 ms debounce window and the 33 ms frame period.
        // Sends `(button_index, is_pressed)` to the main thread via mpsc.
        let stop = Arc::new(AtomicBool::new(false));
        let stop_thread = stop.clone();
        let (tx, btn_rx) = mpsc::channel::<(usize, bool)>();

        std::thread::Builder::new()
            .name("hw-buttons".to_string())
            .spawn(move || {
                // Move gpio into the thread to keep it alive alongside the InputPins.
                let _gpio = gpio;
                let mut pins = button_pins;
                while !stop_thread.load(Ordering::Relaxed) {
                    for (idx, pin) in pins.iter_mut().enumerate() {
                        match pin.poll_interrupt(false, Some(Duration::from_millis(5))) {
                            Ok(Some(level)) => {
                                let pressed = level == Level::Low; // pull-up: Low = pressed
                                if tx.send((idx, pressed)).is_err() {
                                    return; // receiver dropped — GpioHardwareInput was dropped
                                }
                                if std::env::var("CRT_HW_DEBUG").is_ok() {
                                    eprintln!("[hwdbg] button {} {:?}", idx, level);
                                }
                            }
                            Ok(None) => {} // timeout — check next pin
                            Err(e) => {
                                eprintln!("[hw] button poll error on index {idx}: {e}");
                                return;
                            }
                        }
                    }
                }
            })?;

        // Initialize debounce state with an artificially old timestamp so the first
        // real press is not suppressed by the debounce window.
        let btn_debounce = BUTTONS
            .iter()
            .map(|_| ButtonDebounce {
                last_state: false,
                last_change: Instant::now()
                    .checked_sub(Duration::from_millis(200))
                    .unwrap_or_else(Instant::now),
            })
            .collect();

        Ok(Self {
            spi,
            last_adc: [0.0_f32; 8],
            // One slot per KNOBS entry. Unmapped entries (ch 2 at index 4, ch 5 at index 7)
            // occupy slots that are never written by dispatch_knob_readings — the simple
            // entry-index scheme is cleaner than a tighter active-entry-index mapping.
            // Initialized to 0.5 (mid-range) so knobs start neutral rather than slamming
            // params to their minimum on the first tick.
            smoothed: vec![0.5_f32; KNOBS.len()],
            btn_rx,
            btn_debounce,
            led_pins,
            _stop: stop,
            btn_disconnected: false,
            dbg_tick: 0,
            dbg_check: false,
        })
    }

    /// Read one MCP3008 channel via SPI. Returns a normalized value in [0.0, 1.0].
    ///
    /// Reproduces the bridge.py 3-byte transfer exactly:
    /// ```python
    /// rx = dev.xfer2([0x01, (0x80 | (channel << 4)) & 0xFF, 0x00])
    /// value = ((rx[1] & 0x03) << 8 | rx[2]) / 1023.0
    /// ```
    fn read_adc(&mut self, channel: u8) -> Result<f32, rppal::spi::Error> {
        let tx = [0x01_u8, (0x80 | (channel << 4)) & 0xFF, 0x00];
        let mut rx = [0_u8; 3];
        self.spi.transfer(&mut rx, &tx)?;
        let raw10 = (((rx[1] & 0x03) as u16) << 8) | rx[2] as u16;
        Ok(raw10 as f32 / 1023.0)
    }
}

#[cfg(target_os = "linux")]
impl HardwareInput for GpioHardwareInput {
    fn poll(&mut self, params: &mut Params, bands: Bands) {
        // Gate env-var check to ~1 Hz (every 30 ticks) — matches the Phase 3 audio.rs
        // pattern. At 30 Hz a per-tick syscall is negligible, but consistency matters.
        self.dbg_tick = self.dbg_tick.wrapping_add(1);
        if self.dbg_tick % 30 == 0 {
            self.dbg_check = std::env::var("CRT_HW_DEBUG").is_ok();
        }
        let hw_dbg = self.dbg_check;

        let alpha = params.hw_knob_alpha.clamp(HW_KNOB_ALPHA_MIN, HW_KNOB_ALPHA_MAX);

        // ── 1. SPI knob reads ──────────────────────────────────────────────────
        // Read each unique mapped MCP3008 channel once via SPI, then delegate to
        // dispatch_knob_readings for the dead-zone/low-pass/apply logic.
        // dispatch_knob_readings is a pure function and is the host-testable unit.
        let mut ch_raw  = [0.0_f32; 8];
        let mut ch_read = [false; 8];

        for entry in KNOBS.iter() {
            if matches!(entry.write, ParamWrite::Unmapped) { continue; }
            let ch = entry.ch as usize;
            if !ch_read[ch] {
                match self.read_adc(entry.ch) {
                    Ok(v) => {
                        ch_raw[ch]  = v;
                        ch_read[ch] = true;
                    }
                    Err(e) => {
                        eprintln!("[hw] SPI read error ch{ch}: {e}");
                    }
                }
            }
        }

        dispatch_knob_readings(&ch_raw, &mut self.last_adc, &mut self.smoothed, alpha, hw_dbg, params);

        // ── 2. Button events from background thread ────────────────────────────
        // Drain the mpsc channel non-blockingly; apply 50 ms software debounce.
        // Action is only fired on the falling edge (press, not release).
        // Disconnected error means the background thread has exited; warn once.
        let now = Instant::now();
        loop {
            match self.btn_rx.try_recv() {
                Ok((idx, pressed)) => {
                    if idx >= self.btn_debounce.len() { continue; }
                    let db = &mut self.btn_debounce[idx];

                    // Skip if state unchanged or too soon after the last confirmed edge.
                    if pressed == db.last_state { continue; }
                    if !debounce_ok(now, db.last_change) { continue; }

                    db.last_state  = pressed;
                    db.last_change = now;

                    if pressed {
                        // Falling edge (press) — invoke the mapped action.
                        if hw_dbg {
                            eprintln!("[hwdbg] button {} pressed (GPIO {})", idx, BUTTONS[idx].gpio);
                        }
                        apply_button(&BUTTONS[idx].action, params);
                    }
                }
                Err(mpsc::TryRecvError::Empty) => break,
                Err(mpsc::TryRecvError::Disconnected) => {
                    if should_warn_disconnect(&mut self.btn_disconnected) {
                        eprintln!(
                            "[hw] WARNING: button thread has exited — physical buttons are \
                            offline for this session. Restart the application to recover."
                        );
                    }
                    break;
                }
            }
        }

        // ── 3. LED outputs from band levels ────────────────────────────────────
        // Phase 4: threshold on/off. Software-PWM dimming deferred to Phase 5.
        for (pin, entry) in self.led_pins.iter_mut().zip(LEDS.iter()) {
            if band_level(&bands, &entry.band) > LED_THRESHOLD {
                pin.set_high();
            } else {
                pin.set_low();
            }
        }
    }

    fn is_live(&self) -> bool { true }
}

#[cfg(target_os = "linux")]
impl Drop for GpioHardwareInput {
    fn drop(&mut self) {
        // Signal the button-poll thread to exit cleanly.
        // The thread will notice on its next timeout cycle (within ~10 ms).
        self._stop.store(true, Ordering::Relaxed);
    }
}

// ── Factory ───────────────────────────────────────────────────────────────────

/// Build the hardware input source.
///
/// - **Linux:** attempts `GpioHardwareInput` (rppal SPI + GPIO). On init error (e.g.,
///   running on non-Pi Linux without `/dev/gpiochip4`), logs a warning and falls back
///   to `DevHardwareInput` — the same graceful-fallback pattern as `audio::new_source`.
/// - **Non-Linux:** always `DevHardwareInput` (zero new deps, no-op).
///
/// Callers hold `Box<dyn HardwareInput>` and call `poll()` once per 30 Hz tick.
pub fn new_hardware_input() -> Box<dyn HardwareInput> {
    #[cfg(target_os = "linux")]
    {
        match GpioHardwareInput::try_new() {
            Ok(hw) => {
                eprintln!(
                    "[hw] GPIO hardware input active ({} LED outputs, {} buttons, SPI MCP3008)",
                    LEDS.len(),
                    BUTTONS.len()
                );
                return Box::new(hw);
            }
            Err(e) => {
                eprintln!("[hw] GPIO init failed: {e}; falling back to dev stub (no hardware input)");
            }
        }
    }
    #[cfg(not(target_os = "linux"))]
    eprintln!("[hw] non-Linux platform: hardware input stub active (no GPIO)");
    Box::new(DevHardwareInput)
}

// ── Unit tests ────────────────────────────────────────────────────────────────
//
// All tests call host-testable functions (passes_dead_zone, low_pass, apply_knob,
// apply_button, debounce_ok) and use DevHardwareInput::poll. No hardware required.

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    // ── Dead-zone ──────────────────────────────────────────────────────────────

    #[test]
    fn dead_zone_suppresses_sub_threshold_delta() {
        // Exactly at the boundary (not strictly greater) → must suppress.
        assert!(!passes_dead_zone(0.005, 0.0),  "delta == DEAD_ZONE must be suppressed");
        assert!(!passes_dead_zone(0.003, 0.0),  "delta < DEAD_ZONE must be suppressed");
        assert!(!passes_dead_zone(0.0,   0.003),"negative delta < DEAD_ZONE must be suppressed");
        assert!(!passes_dead_zone(0.0,   0.005),"negative delta == DEAD_ZONE must be suppressed");
        // Zero change.
        assert!(!passes_dead_zone(0.5, 0.5), "no change must be suppressed");
    }

    #[test]
    fn dead_zone_passes_above_threshold_delta() {
        assert!(passes_dead_zone(0.006, 0.0),  "delta just above DEAD_ZONE must pass");
        assert!(passes_dead_zone(0.5,   0.0),  "large positive delta must pass");
        assert!(passes_dead_zone(0.0,   0.006),"large negative delta must pass");
        assert!(passes_dead_zone(1.0,   0.0),  "full-scale change must pass");
    }

    // ── Low-pass filter ────────────────────────────────────────────────────────

    #[test]
    fn low_pass_converges_to_raw_value() {
        let target = 1.0_f32;
        let alpha = 0.35_f32;
        let mut val = 0.0_f32;
        for _ in 0..300 {
            val = low_pass(target, val, alpha);
        }
        assert!(
            (val - target).abs() < 1e-4,
            "low-pass must converge to constant input {target} after 300 steps; got {val}"
        );
    }

    #[test]
    fn low_pass_alpha_one_is_passthrough() {
        assert_eq!(low_pass(0.7, 0.0, 1.0), 0.7, "alpha=1.0 must return raw, ignoring prev");
        assert_eq!(low_pass(0.0, 0.9, 1.0), 0.0, "alpha=1.0 must return raw regardless of prev");
    }

    #[test]
    fn low_pass_alpha_zero_is_frozen() {
        assert_eq!(low_pass(1.0, 0.5, 0.0), 0.5, "alpha=0.0 must return prev, ignoring raw");
        assert_eq!(low_pass(0.0, 0.3, 0.0), 0.3, "alpha=0.0 must return prev regardless of raw");
    }

    // ── Knob mapping ──────────────────────────────────────────────────────────

    #[test]
    fn knob_float_maps_to_full_param_range() {
        let entry = KnobEntry {
            chip: 0, ch: 1,
            write: ParamWrite::Float { field: |p| &mut p.bg_opacity, min: 0.0, max: 1.0 },
        };
        let mut p = Params::default();

        apply_knob(&entry, 0.0, &mut p);
        assert!((p.bg_opacity - 0.0).abs() < 1e-6, "smoothed=0.0 → min=0.0; got {}", p.bg_opacity);

        apply_knob(&entry, 1.0, &mut p);
        assert!((p.bg_opacity - 1.0).abs() < 1e-6, "smoothed=1.0 → max=1.0; got {}", p.bg_opacity);

        apply_knob(&entry, 0.5, &mut p);
        assert!((p.bg_opacity - 0.5).abs() < 1e-6, "smoothed=0.5 → midpoint=0.5; got {}", p.bg_opacity);
    }

    #[test]
    fn knob_float_clamps_nonzero_min_range() {
        // glitch_scatter: min=0.045, max=0.15
        let entry = KnobEntry {
            chip: 0, ch: 3,
            write: ParamWrite::Float { field: |p| &mut p.glitch_scatter, min: 0.045, max: 0.15 },
        };
        let mut p = Params::default();

        apply_knob(&entry, 0.0, &mut p);
        assert!(
            (p.glitch_scatter - 0.045).abs() < 1e-6,
            "smoothed=0.0 → clamped to min=0.045; got {}", p.glitch_scatter
        );

        apply_knob(&entry, 1.0, &mut p);
        assert!(
            (p.glitch_scatter - 0.15).abs() < 1e-6,
            "smoothed=1.0 → clamped to max=0.15; got {}", p.glitch_scatter
        );
    }

    #[test]
    fn knob_phosphor_index_truncates_across_full_range() {
        let entry = KnobEntry { chip: 0, ch: 6, write: ParamWrite::PhosphorIndex };
        let count = PHOSPHOR_ORDER.len(); // 5
        let mut p = Params::default();

        // smoothed=0.0 → index 0 (floor(0.0 * 5) = 0)
        apply_knob(&entry, 0.0, &mut p);
        assert_eq!(p.phosphor_index, 0, "smoothed=0.0 → phosphor_index=0");

        // smoothed=0.2 → index 1 (floor(0.2 * 5) = 1)
        apply_knob(&entry, 0.2, &mut p);
        assert_eq!(p.phosphor_index, 1, "smoothed=0.2 → phosphor_index=1");

        // smoothed=0.5 → index 2 (floor(0.5 * 5) = 2)
        apply_knob(&entry, 0.5, &mut p);
        assert_eq!(p.phosphor_index, 2, "smoothed=0.5 → phosphor_index=2");

        // smoothed=0.99 → index 4 (floor(0.99 * 5) = 4)
        apply_knob(&entry, 0.99, &mut p);
        assert_eq!(p.phosphor_index, 4, "smoothed=0.99 → phosphor_index=4");

        // smoothed=1.0 → must clamp to count-1=4, not out-of-range 5
        apply_knob(&entry, 1.0, &mut p);
        assert_eq!(
            p.phosphor_index,
            count - 1,
            "smoothed=1.0 → must clamp to count-1={}; got {}", count - 1, p.phosphor_index
        );
    }

    #[test]
    fn knob_unmapped_changes_nothing() {
        let entry = KnobEntry { chip: 0, ch: 2, write: ParamWrite::Unmapped };
        let mut p = Params::default();
        let snap_phosphor = p.phosphor_index;
        let snap_opacity  = p.rain_opacity;
        let snap_bg       = p.bg_enabled;

        apply_knob(&entry, 0.9, &mut p);

        assert_eq!(p.phosphor_index, snap_phosphor, "Unmapped must not change phosphor_index");
        assert_eq!(p.rain_opacity,   snap_opacity,   "Unmapped must not change rain_opacity");
        assert_eq!(p.bg_enabled,     snap_bg,        "Unmapped must not change bg_enabled");
    }

    // ── Button actions ────────────────────────────────────────────────────────

    #[test]
    fn button_cycle_phosphor_increments_and_wraps() {
        let count = PHOSPHOR_ORDER.len(); // 5
        let mut p = Params::default();

        let start = p.phosphor_index;
        apply_button(&ButtonAction::CyclePhosphor, &mut p);
        assert_eq!(p.phosphor_index, (start + 1) % count, "CyclePhosphor must increment index");

        // Drive to the last valid index, verify wrap to 0.
        p.phosphor_index = count - 1;
        apply_button(&ButtonAction::CyclePhosphor, &mut p);
        assert_eq!(p.phosphor_index, 0, "CyclePhosphor must wrap from last index to 0");
    }

    #[test]
    fn button_toggle_bool_flips_field() {
        let mut p = Params::default();
        let initial = p.bg_enabled;

        apply_button(&ButtonAction::ToggleBool(|p| &mut p.bg_enabled), &mut p);
        assert_eq!(p.bg_enabled, !initial, "ToggleBool must flip bg_enabled on first call");

        apply_button(&ButtonAction::ToggleBool(|p| &mut p.bg_enabled), &mut p);
        assert_eq!(p.bg_enabled, initial, "ToggleBool must flip bg_enabled back on second call");
    }

    #[test]
    fn button_noop_changes_nothing() {
        let mut p = Params::default();
        let snap = p.phosphor_index;
        apply_button(&ButtonAction::NoOp, &mut p);
        assert_eq!(p.phosphor_index, snap, "NoOp must not change any Params field");
    }

    // ── Debounce ──────────────────────────────────────────────────────────────

    #[test]
    fn debounce_rejects_within_50ms() {
        let t0 = Instant::now();
        // 0 ms elapsed — reject.
        assert!(!debounce_ok(t0, t0), "debounce must reject at 0 ms elapsed");
        // 49 ms — reject (< 50 ms threshold).
        let t49 = t0 + Duration::from_millis(49);
        assert!(!debounce_ok(t49, t0), "debounce must reject at 49 ms elapsed");
    }

    #[test]
    fn debounce_accepts_at_50ms_and_beyond() {
        let t0 = Instant::now();
        // Exactly 50 ms — accept (>= threshold).
        let t50 = t0 + Duration::from_millis(50);
        assert!(debounce_ok(t50, t0), "debounce must accept at exactly 50 ms elapsed");
        // 100 ms — accept.
        let t100 = t0 + Duration::from_millis(100);
        assert!(debounce_ok(t100, t0), "debounce must accept at 100 ms elapsed");
    }

    // ── DevHardwareInput ──────────────────────────────────────────────────────

    #[test]
    fn dev_hardware_input_poll_is_noop() {
        let mut hw = DevHardwareInput;
        let mut p  = Params::default();

        // Snapshot every field that any knob or button action might touch.
        let snap_phosphor  = p.phosphor_index;
        let snap_opacity   = p.rain_opacity;
        let snap_bg        = p.bg_enabled;
        let snap_alpha     = p.hw_knob_alpha;
        let snap_scatter   = p.glitch_scatter;
        let snap_fig_br    = p.fig_brightness;
        let snap_burn      = p.rain_burn_boost;
        let snap_speed_min = p.rain_speed_min;
        let snap_bg_op     = p.bg_opacity;

        hw.poll(&mut p, Bands::default());

        assert_eq!(p.phosphor_index,  snap_phosphor,  "poll must not change phosphor_index");
        assert_eq!(p.rain_opacity,    snap_opacity,    "poll must not change rain_opacity");
        assert_eq!(p.bg_enabled,      snap_bg,         "poll must not change bg_enabled");
        assert_eq!(p.hw_knob_alpha,   snap_alpha,      "poll must not change hw_knob_alpha");
        assert_eq!(p.glitch_scatter,  snap_scatter,    "poll must not change glitch_scatter");
        assert_eq!(p.fig_brightness,  snap_fig_br,     "poll must not change fig_brightness");
        assert_eq!(p.rain_burn_boost, snap_burn,       "poll must not change rain_burn_boost");
        assert_eq!(p.rain_speed_min,  snap_speed_min,  "poll must not change rain_speed_min");
        assert_eq!(p.bg_opacity,      snap_bg_op,      "poll must not change bg_opacity");
        assert!(!hw.is_live(), "DevHardwareInput must report is_live=false");
    }

    // ── Multi-entry channel dispatch (Critical-fix regression tests) ──────────
    //
    // These tests exercise dispatch_knob_readings end-to-end so the dead-zone ordering
    // bug (where last_adc was updated inside the per-entry loop, preventing entries 1-2
    // on ch 0 from ever being applied) cannot regress.  They do not require hardware.

    #[test]
    fn multi_entry_channel_all_ch0_params_update_on_dead_zone_pass() {
        let mut last_adc = [0.0_f32; 8];
        let mut smoothed = vec![0.5_f32; KNOBS.len()];
        let mut params   = Params::default();

        // Move ch 0 well past the dead-zone threshold (> 0.005).
        // alpha=1.0 → pass-through so predicted values are exact.
        let mut ch_raw = [0.0_f32; 8];
        ch_raw[0] = 0.8;

        dispatch_knob_readings(&ch_raw, &mut last_adc, &mut smoothed, 1.0, false, &mut params);

        // All three ch 0 entries must have been applied:
        //   rain_opacity:    min=0.0, max=1.0  → 0.0 + 0.8*(1.0-0.0)        = 0.800
        //   rain_burn_boost: min=0.0, max=0.5  → 0.0 + 0.8*(0.5-0.0)        = 0.400
        //   rain_speed_min:  min=0.01, max=0.2 → 0.01 + 0.8*(0.2-0.01)      = 0.162
        let want_opacity   = 0.0_f32  + 0.8 * (1.0 - 0.0);
        let want_burn      = 0.0_f32  + 0.8 * (0.5 - 0.0);
        let want_speed_min = 0.01_f32 + 0.8 * (0.2 - 0.01);

        assert!(
            (params.rain_opacity - want_opacity).abs() < 1e-5,
            "rain_opacity must update; expected {want_opacity:.4}, got {:.4}", params.rain_opacity
        );
        assert!(
            (params.rain_burn_boost - want_burn).abs() < 1e-5,
            "rain_burn_boost must update; expected {want_burn:.4}, got {:.4}", params.rain_burn_boost
        );
        assert!(
            (params.rain_speed_min - want_speed_min).abs() < 1e-5,
            "rain_speed_min must update; expected {want_speed_min:.4}, got {:.4}", params.rain_speed_min
        );
        // last_adc[0] must be updated once (not re-updated per-entry).
        assert!((last_adc[0] - 0.8).abs() < 1e-6, "last_adc[0] must be updated to ch_raw[0]");
    }

    #[test]
    fn multi_entry_channel_sub_dead_zone_move_updates_no_params() {
        let mut last_adc = [0.3_f32; 8]; // already seen 0.3 on ch 0
        let mut smoothed = vec![0.5_f32; KNOBS.len()];
        let mut params   = Params::default();

        let before_opacity   = params.rain_opacity;
        let before_burn      = params.rain_burn_boost;
        let before_speed_min = params.rain_speed_min;

        // Delta == DEAD_ZONE (not strictly greater) → must be suppressed.
        let mut ch_raw = [0.3_f32; 8];
        ch_raw[0] = 0.3 + DEAD_ZONE; // exactly at boundary

        dispatch_knob_readings(&ch_raw, &mut last_adc, &mut smoothed, 1.0, false, &mut params);

        assert_eq!(params.rain_opacity,    before_opacity,   "sub-dead-zone: rain_opacity must not change");
        assert_eq!(params.rain_burn_boost, before_burn,      "sub-dead-zone: rain_burn_boost must not change");
        assert_eq!(params.rain_speed_min,  before_speed_min, "sub-dead-zone: rain_speed_min must not change");
        // last_adc must not be updated since the gate did not pass.
        assert!((last_adc[0] - 0.3).abs() < 1e-6, "last_adc[0] must remain unchanged on sub-dead-zone");
    }

    #[test]
    fn multi_entry_channel_unmapped_channel_ignored() {
        // Ch 2 is Unmapped — a large move must not alter any param or last_adc[2].
        let mut last_adc = [0.0_f32; 8];
        let mut smoothed = vec![0.5_f32; KNOBS.len()];
        let mut params   = Params::default();

        let before_opacity  = params.rain_opacity;
        let before_burn     = params.rain_burn_boost;
        let before_speed    = params.rain_speed_min;
        let before_scatter  = params.glitch_scatter;
        let before_fig      = params.fig_brightness;
        let before_phosphor = params.phosphor_index;

        let mut ch_raw = [0.0_f32; 8];
        ch_raw[2] = 0.9; // large move on unmapped channel

        dispatch_knob_readings(&ch_raw, &mut last_adc, &mut smoothed, 1.0, false, &mut params);

        assert_eq!(params.rain_opacity,    before_opacity,  "unmapped ch2: rain_opacity must not change");
        assert_eq!(params.rain_burn_boost, before_burn,     "unmapped ch2: rain_burn_boost must not change");
        assert_eq!(params.rain_speed_min,  before_speed,    "unmapped ch2: rain_speed_min must not change");
        assert_eq!(params.glitch_scatter,  before_scatter,  "unmapped ch2: glitch_scatter must not change");
        assert_eq!(params.fig_brightness,  before_fig,      "unmapped ch2: fig_brightness must not change");
        assert_eq!(params.phosphor_index,  before_phosphor, "unmapped ch2: phosphor_index must not change");
        assert!((last_adc[2] - 0.0).abs() < 1e-6, "unmapped ch2: last_adc[2] must remain 0.0");
    }

    // ── Disconnect-warning rate-limit (Important-fix regression tests) ─────────

    #[test]
    fn disconnect_warn_fires_exactly_once() {
        let mut warned = false;
        assert!(should_warn_disconnect(&mut warned),  "first call must return true (emit warning)");
        assert!(!should_warn_disconnect(&mut warned), "second call must return false (already warned)");
        assert!(!should_warn_disconnect(&mut warned), "third call must return false (still warned)");
    }

    // ── Mapping table structure ───────────────────────────────────────────────

    #[test]
    fn knobs_table_structure_matches_bridge_py() {
        // ch 0 chip 0 must have exactly 3 Float entries (the three shadowed rain params).
        let ch0_count = KNOBS.iter().filter(|e| e.chip == 0 && e.ch == 0).count();
        assert_eq!(ch0_count, 3, "chip 0 ch 0 must drive exactly 3 knob entries");

        // ch 2 and ch 5 must be Unmapped (no native param in Phase 4).
        let unmapped: Vec<_> = KNOBS.iter()
            .filter(|e| matches!(e.write, ParamWrite::Unmapped))
            .collect();
        assert_eq!(unmapped.len(), 2, "must have exactly 2 Unmapped entries (ch 2 and ch 5)");
        assert!(unmapped.iter().any(|e| e.ch == 2), "ch 2 must be Unmapped");
        assert!(unmapped.iter().any(|e| e.ch == 5), "ch 5 must be Unmapped");

        // ch 6 must be the single PhosphorIndex entry.
        let phosphor_knobs: Vec<_> = KNOBS.iter()
            .filter(|e| matches!(e.write, ParamWrite::PhosphorIndex))
            .collect();
        assert_eq!(phosphor_knobs.len(), 1, "must have exactly 1 PhosphorIndex entry");
        assert_eq!(phosphor_knobs[0].ch, 6, "PhosphorIndex must be on ch 6");
    }

    #[test]
    fn buttons_table_structure_matches_bridge_py() {
        assert_eq!(BUTTONS.len(), 2, "must have exactly 2 button entries");
        assert_eq!(BUTTONS[0].gpio, 23, "first button must be GPIO 23");
        assert_eq!(BUTTONS[1].gpio, 24, "second button must be GPIO 24");
        assert!(matches!(BUTTONS[0].action, ButtonAction::CyclePhosphor),
            "GPIO 23 must map to CyclePhosphor");
        assert!(matches!(BUTTONS[1].action, ButtonAction::ToggleBool(_)),
            "GPIO 24 must map to ToggleBool");
    }

    #[test]
    fn leds_table_mirrors_bridge_py() {
        assert_eq!(LEDS.len(), 6, "must have 6 LED entries");
        let gpios: Vec<u8> = LEDS.iter().map(|e| e.gpio).collect();
        assert_eq!(gpios, vec![17, 27, 22, 5, 6, 13],
            "LED GPIO order must match bridge.py LED_CONFIG exactly");
    }
}
