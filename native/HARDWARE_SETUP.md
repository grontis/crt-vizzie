# Hardware Setup — Raspberry Pi 5 + MCP3008 knobs/sliders + buttons + LEDs

This guide wires physical controls into the **native crt-vizzie frontend**. Unlike the `v2/`
web app — which needed a Python WebSocket bridge (`pi/bridge.py`) because a browser cannot
touch SPI or GPIO — the native binary talks to the hardware **directly, in-process**, through
the [`rppal`](https://docs.rs/rppal) crate. There is no bridge process, no WebSocket, no
serialization: a knob turn is an SPI read followed by a plain field write into the `Params`
struct that the very next frame reads.

All hardware logic lives in [`src/hw_input.rs`](src/hw_input.rs). The mapping tables
(`KNOBS`, `BUTTONS`, `LEDS`) at the top of that file are the single place to edit when you
rewire or remap anything.

---

## Architecture: in-process GPIO, no bridge

```
                 v2 (browser) — RETIRED PATH                native (this app)
  ┌─────────────────────────────────────────────┐   ┌──────────────────────────────────┐
  │ knobs → MCP3008 → spidev → bridge.py        │   │ knobs → MCP3008 → SPI0 (rppal)   │
  │                     │  JSON over WebSocket  │   │             │                    │
  │                     ▼  ws://localhost:9001  │   │             ▼  same process,     │
  │        hardware-bridge.js → V2_PARAMS       │   │  hw_input::poll() → &mut Params  │
  └─────────────────────────────────────────────┘   └──────────────────────────────────┘
```

Data flow inside the native binary, once per 30 Hz logic tick (`main.rs`):

```
   ┌────────────┐   SPI @ 1 MHz    ┌──────────────────┐
   │ 7 knobs /  ├─────────────────►│                  │  dead-zone → low-pass → clamp
   │ sliders    │  MCP3008 (CE0)   │                  ├──────────────► Params fields
   └────────────┘                  │                  │                (rain_opacity,
   ┌────────────┐  GPIO interrupt  │  hw_input::poll  │                 bg_opacity, …)
   │ 2 buttons  ├─── background ──►│  (main thread,   │
   └────────────┘  thread + mpsc   │   30 Hz tick)    ├──────────────► actions
   ┌────────────┐                  │                  │                (cycle phosphor,
   │ 6 LEDs     │◄─────────────────┤                  │                 toggle game bg)
   └────────────┘  band > 0.5      └──────────────────┘
        ▲            on/off                 ▲
        │                                   │
        └── audio band levels ── audio.update() (USB line-in → FFT → bands)
```

- **Knobs** are read synchronously in-tick (~70 µs for all channels at 1 MHz — negligible).
  Each reading passes a dead-zone gate (Δ > 0.005 of full scale), a first-order low-pass
  (`hw_knob_alpha`, default 0.35), and a range clamp before landing in `Params`.
- **Buttons** are edge-detected on a background thread (`poll_interrupt` on each pin) and
  delivered to the main thread over an `mpsc` channel, with 50 ms software debounce.
- **LEDs** are driven from the live audio band levels each tick — threshold on/off at 0.5
  (software-PWM dimming is future work; see ARCHITECTURE.md).

If SPI/GPIO init fails (no hardware, non-Pi machine), the app logs a warning and falls back
to a no-op stub — keyboard control keeps working, nothing crashes. This is the same
graceful-fallback pattern the audio input uses.

---

## Components

| Component | Role |
|---|---|
| Raspberry Pi 5 8GB | Host: runs the native binary (emulator + visualizer + hardware I/O) |
| MCP3008 | 10-bit SPI ADC — 8 analog channels |
| Rotary potentiometers (B1K–B1M) | Knobs → ADC channels |
| B10K slider potentiometers | Sliders → ADC channels |
| 0.1 µF ceramic capacitors | Supply decoupling + wiper noise filtering |
| Momentary pushbuttons (NO) | Discrete actions (phosphor cycle, game-underlay toggle) |
| 5 mm LEDs + series resistors | Audio-band-reactive output |
| Breadboard + jumper wires | Prototyping |

> **Pot values**: anything from 1K to 100K works well on the 3.3 V rail. Above ~100K the
> wiper starts picking up noise; below ~500 Ω it loads the rail noticeably. **B10K is
> ideal** — matches the sliders.

---

## Electrical safety (Pi 5 GPIO)

- GPIO pins are **3.3 V only** — never connect 5 V signals directly to a GPIO pin.
- Max **16 mA per pin**; stay under ~10 mA per LED for long-term reliability.
- Max **50 mA total** across all GPIO simultaneously.
- Always use a series resistor with every LED.

### LED resistor selection

The GPIO output is 3.3 V; LED forward voltage varies by color:

| Color | Vf | Series R | Current at 3.3 V |
|---|---|---|---|
| Red / Orange / Yellow | ~2.0 V | **150 Ω** | ~8.5 mA |
| Standard Green | ~2.2 V | **150 Ω** | ~7.3 mA |
| Blue | ~3.0–3.2 V | **68 Ω** | ~1.5–4.5 mA (dim) |
| White | ~3.0–3.6 V | **68 Ω** | may be very dim |

Blue/white LEDs sit near or above the 3.3 V rail and will look dim. For full brightness,
drive them from 5 V through a small NPN transistor (2N2222 / BC547) with a 1 kΩ base
resistor from the GPIO pin — the pin then *controls* the LED instead of powering it.

---

## Pi 5 GPIO header

```
            3.3V  [1]  [2]  5V
    (SDA1) GPIO2  [3]  [4]  5V
    (SCL1) GPIO3  [5]  [6]  GND
           GPIO4  [7]  [8]  GPIO14
             GND  [9]  [10] GPIO15
   LED1 → GPIO17  [11] [12] GPIO18
   LED2 → GPIO27  [13] [14] GND
   LED3 → GPIO22  [15] [16] GPIO23 ← Button 1
            3.3V  [17] [18] GPIO24 ← Button 2
 SPI0 MOSI/GPIO10 [19] [20] GND
 SPI0 MISO/GPIO9  [21] [22] GPIO25
 SPI0 CLK/GPIO11  [23] [24] GPIO8/SPI0_CE0 ← MCP3008 CS
             GND  [25] [26] GPIO7/SPI0_CE1
           GPIO0  [27] [28] GPIO1
   LED4 →  GPIO5  [29] [30] GND
   LED5 →  GPIO6  [31] [32] GPIO12
   LED6 → GPIO13  [33] [34] GND
          GPIO19  [35] [36] GPIO16
          GPIO26  [37] [38] GPIO20
             GND  [39] [40] GPIO21
```

**SPI0 pins used by the MCP3008:**

| Signal | GPIO | Header pin |
|---|---|---|
| MOSI (data to ADC) | GPIO10 | 19 |
| MISO (data from ADC) | GPIO9 | 21 |
| CLK | GPIO11 | 23 |
| CE0 (chip select) | GPIO8 | 24 |

> The app currently opens **SPI0/CE0 only** (one MCP3008, 8 channels). The `KnobEntry.chip`
> field exists for a second chip on CE1 (header pin 26), but `hw_input.rs` does not read it
> yet — wire a second chip only after adding CE1 support there.

---

## MCP3008 pinout (DIP-16)

```
        ┌─── notch ───┐
   CH0  [1]          [16]  VDD   ← 3.3V
   CH1  [2]          [15]  VREF  ← 3.3V
   CH2  [3] MCP3008  [14]  AGND  ← GND
   CH3  [4]          [13]  CLK   ← SPI CLK   (pin 23)
   CH4  [5]          [12]  DOUT  → SPI MISO  (pin 21)
   CH5  [6]          [11]  DIN   ← SPI MOSI  (pin 19)
   CH6  [7]          [10]  CS    ← SPI CE0   (pin 24)
   CH7  [8]          [9]   DGND  ← GND
        └─────────────┘
```

Place the chip with the notch at the top; pin 1 is top-left.

| MCP3008 pin | Signal | Pi header pin |
|---|---|---|
| 16 VDD | 3.3 V power | 1 (3.3V) |
| 15 VREF | Analog reference | 1 (3.3V) |
| 14 AGND | Analog ground | 6 (GND) |
| 9 DGND | Digital ground | 6 (GND) |
| 13 CLK | SPI clock | 23 (GPIO11) |
| 11 DIN | SPI MOSI | 19 (GPIO10) |
| 12 DOUT | SPI MISO | 21 (GPIO9) |
| 10 CS/SHDN | Chip select 0 | 24 (GPIO8) |

Place a **0.1 µF capacitor between VDD (16) and DGND (9)** as close to the chip as possible,
and a second **0.1 µF between VREF (15) and AGND (14)** to stabilize the reference.

---

## Wiring: knobs and sliders

A potentiometer has three pins. Viewed from the front (shaft toward you):

```
        3.3V rail ────────┐             ┌──────── GND rail
                          │             │
                        Right         Left
                          └──┐ ┌───┐ ┌─┘
                             │ POT │
                             └──┬──┘
                              Middle (wiper)
                                │
                                ├───────────► MCP3008 CHx
                                │
                               ─┴─ 0.1 µF
                               ─┬─
                                │
                              GND rail
```

| Pot pin | Connects to |
|---|---|
| Left | GND rail |
| Middle (wiper) | MCP3008 channel pin (CH0–CH7) |
| Right | 3.3 V rail |

This gives fully-CCW = 0 V (param minimum), fully-CW = 3.3 V (param maximum).

**One 0.1 µF cap between each wiper and GND**, placed near the ADC input, forms a lowpass
with the pot resistance and kills ADC jitter. (The firmware also low-pass filters readings —
`hw_knob_alpha` — but the hardware cap removes noise before quantization.)

Slider pots are electrically identical: end pins to GND and 3.3 V, wiper to the channel.
If a slider works backwards, swap the two end pins.

### Knob → parameter map (current)

Defined in the `KNOBS` table in `src/hw_input.rs`:

| MCP3008 ch | Parameter(s) | Range | Effect |
|---|---|---|---|
| CH0 | `rain_opacity` + `rain_burn_boost` + `rain_speed_min` | 0–1 / 0–0.5 / 0.01–0.2 | One pot drives all three rain params (reassign to free channels once more pots are wired) |
| CH1 | `bg_opacity` | 0–1 | Game-frame underlay opacity |
| CH2 | *(unmapped)* | — | Was `bgFxHueShift` in v2; no native equivalent yet |
| CH3 | `glitch_scatter` | 0.045–0.15 | Beat-triggered glitch scatter density |
| CH4 | `fig_brightness` | 0.5–1.0 | ASCII figure brightness |
| CH5 | *(unmapped)* | — | Was `bgAsciiLevel` in v2; bgAscii layer is deferred |
| CH6 | `phosphor_index` | 0–4 discrete | Sweeps through red → amber → green → blue → white |

Knob behavior details (all in `hw_input.rs`):

- **Dead-zone** — a channel must move more than 0.5 % of full scale to register, so a noisy
  idle knob never fights the keyboard or debug UI.
- **No slam at boot** — params keep their defaults until a knob is physically moved past the
  dead-zone; a knob parked at zero doesn't zero its param at startup.
- **Smoothing** — first-order low-pass with `Params::hw_knob_alpha` (default 0.35 ≈ 4 ticks
  to reach 95 % of a step at 30 Hz).

---

## Wiring: pushbuttons

The firmware enables the Pi's internal pull-up on each button pin — **no external resistor
needed**. Wire each normally-open momentary button between the GPIO pin and GND:

```
   GPIO pin ────┤ button ├──── GND
   (internal pull-up: idle = high, pressed = low)
```

| Button | GPIO | Header pin | Native action |
|---|---|---|---|
| Button 1 | GPIO23 | 16 | Cycle phosphor preset (P-key analog) |
| Button 2 | GPIO24 | 18 | Toggle game underlay on/off (B-key analog) |

The v2 events these pins used to fire (`next_bg`, `toggle_bg_ascii`) have no native meaning —
the game *is* the background — so they are remapped in the `BUTTONS` table. Presses are
debounced at 50 ms in software; actions fire on press (falling edge), not release.

---

## Wiring: LEDs

```
   GPIO pin ───[ R ]───►│ LED ├─── GND
                     anode   cathode
                    (long leg) (flat side)
```

The resistor can sit on either side of the LED. Long leg = anode (+), toward the GPIO side.

| LED | GPIO | Header pin | Audio band |
|---|---|---|---|
| LED 1 | GPIO17 | 11 | sub |
| LED 2 | GPIO27 | 13 | bass |
| LED 3 | GPIO22 | 15 | lowMid |
| LED 4 | GPIO5 | 29 | mid |
| LED 5 | GPIO6 | 31 | highMid |
| LED 6 | GPIO13 | 33 | treble |

Each LED lights when its band's level exceeds 0.5 (threshold on/off — the v2 bridge did
PWM brightness; native PWM dimming is listed as future work in ARCHITECTURE.md).

GPIO 2, 3, 7, 8, 9, 10, 11 are reserved for SPI/I2C — don't use them for LEDs or buttons.

---

## Breadboard layout (830-point board)

```
        Pi pin 1 (3.3V) ──► + rail          Pi pin 6 (GND) ──► − rail
   ┌────────────────────────────────────────────────────────────────────┐
   │ + ───────────────────────────────────────────────────────────── +  │
   │ − ───────────────────────────────────────────────────────────── −  │
   │                                                                    │
   │   ┌MCP3008┐    caps: VDD–DGND, VREF–AGND next to chip              │
   │   │◦ ◦ ◦ ◦│◄── CH0–CH7 rows: one wiper + one 0.1µF cap each        │
   │   │◦ ◦ ◦ ◦│◄── right side: 3.3V, GND, and SPI jumpers to Pi        │
   │   └───────┘         (pins 19 / 21 / 23 / 24)                       │
   │                                                                    │
   │   [pot1] [pot2] [pot3] …   outer pins → rails, wiper → CHx row     │
   │                                                                    │
   │   (btn1)──GND   (btn2)──GND      GPIO23 / GPIO24, no resistor      │
   │                                                                    │
   │   ●─[150Ω]─GND ×6   LEDs: anode ← GPIO jumper, cathode → resistor  │
   │                                                                    │
   │ + ───────────────────────────────────────────────────────────── +  │
   │ − ───────────────────────────────────────────────────────────── −  │
   └────────────────────────────────────────────────────────────────────┘
```

1. **Power rails** — Pi pin 1 (3.3 V) to `+`, Pi pin 6 (GND) to `−`; jumper both rails to the
   far side of the board if you use it.
2. **MCP3008** — straddle the center gap. Bypass caps immediately adjacent.
3. **Pots/sliders** — outer pins to the rails, wiper to a free row, short jumper from that row
   to the MCP3008 channel pin, 0.1 µF cap from the same row to GND.
4. **Buttons** — one leg to a GPIO jumper, the other to the GND rail.
5. **LEDs** — anode toward the GPIO jumper, cathode through the resistor to GND.

---

## Software setup

There is nothing to install beyond the app itself — no Python, no pip packages, no separate
daemon. `rppal` is compiled into the binary (Linux targets only; see `Cargo.toml`).

### 1. Enable SPI

```bash
sudo raspi-config
# Interface Options → SPI → Enable → reboot
```

Verify:

```bash
ls /dev/spidev*
# expect: /dev/spidev0.0  /dev/spidev0.1
```

### 2. Device permissions

The binary needs read/write access to `/dev/spidev0.0` (SPI) and `/dev/gpiochip*` (buttons
and LEDs, via the character-device GPIO API — the Pi 5's RP1 controller requires
`rppal >= 0.19`, already pinned in `Cargo.toml`). On Raspberry Pi OS the default user is
usually in both groups already; if not:

```bash
sudo usermod -aG spi,gpio $USER
# log out and back in
```

### 3. Build and run

```bash
cd native
./scripts/run-release.sh /path/to/game.z64
```

On startup, look for these lines on stderr:

```
[hw] SPI0 CE0 opened at 1 MHz (MCP3008)
[hw] 6 LED outputs initialized (GPIO [17, 27, 22, 5, 6, 13])
[hw] 2 button inputs initialized (GPIO [23, 24])
[hw] GPIO hardware input active (6 LED outputs, 2 buttons, SPI MCP3008)
```

If instead you see `[hw] GPIO init failed: …; falling back to dev stub`, the app still runs —
keyboard control only — and the message tells you which resource failed to open.

### 4. Live diagnostics

```bash
CRT_HW_DEBUG=1 ./target/release/crt-vizzie --core … --rom …
```

prints every knob change (`[hwdbg] knob chip0 ch3 raw=0.512 smoothed=0.498`) and button edge
as it happens. Pair with the on-screen debug slider overlay (`ui.rs`) to confirm params land.

---

## Remapping knobs, buttons, and LEDs

All three mapping tables are plain `static` arrays at the top of `src/hw_input.rs`:

```rust
static KNOBS: &[KnobEntry] = &[
    KnobEntry { chip: 0, ch: 1, write: ParamWrite::Float { field: |p| &mut p.bg_opacity, min: 0.0, max: 1.0 } },
    // ...
];

static BUTTONS: &[ButtonEntry] = &[
    ButtonEntry { gpio: 23, action: ButtonAction::CyclePhosphor },
    ButtonEntry { gpio: 24, action: ButtonAction::ToggleBool(|p| &mut p.bg_enabled) },
];

static LEDS: &[LedEntry] = &[
    LedEntry { gpio: 17, band: LedBand::Sub },
    // ...
];
```

- A **knob** entry names a `Params` field via accessor closure plus an engineering range —
  any `f32` field in `config.rs::Params` works (e.g. `edge_gain`, `glitch_fx_intensity`).
  `ParamWrite::PhosphorIndex` shows the pattern for discrete stepping from a continuous pot.
- A **button** action is either `CyclePhosphor`, `ToggleBool(field)`, or a new variant you
  add to the `ButtonAction` enum with its arm in `apply_button`.
- An **LED** entry pairs a GPIO with one of the six audio bands.

Mapping logic is covered by host-runnable unit tests (`cargo test hw_input` — no hardware
needed); the table-structure tests at the bottom of the file will point at any entry you
break while editing.

---

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| `[hw] GPIO init failed … /dev/spidev0.0` | SPI not enabled in raspi-config, or user not in `spi` group |
| `[hw] GPIO init failed … gpiochip` | User not in `gpio` group, or a pin is claimed by another process |
| ADC reads all 0 or all 1 | MOSI/MISO swapped, or VDD/AGND not connected |
| Noisy / jittery params | Missing wiper caps or floating wiper; raise smoothing by lowering `hw_knob_alpha` |
| Knob does nothing | Channel is `Unmapped` in `KNOBS`, or wiper on the wrong CHx pin |
| Button fires twice per press | Worn switch bouncing longer than 50 ms — raise `DEBOUNCE_MS` |
| Buttons stop responding mid-session | `[hw] WARNING: button thread has exited` was logged — restart the app |
| LEDs never light | Series resistor too large, LED reversed, or band level never crossing 0.5 (check `CRT_HW_DEBUG` + audio input) |
| Everything dead but app runs | Look for the `[hw] … falling back to dev stub` line at startup |
