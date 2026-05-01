# Hardware Setup Guide — Raspberry Pi 5 + MCP3008 + Knobs/Sliders + LEDs

This guide wires your physical controls into crt-vizzie's `V2_PARAMS` system via
the `bridge.py` WebSocket bridge.

---

## Your components

| Component | Role |
|---|---|
| Raspberry Pi 5 8GB | Host: runs browser + bridge |
| 2× MCP3008 | 10-bit SPI ADC — 8 channels each, 16 total |
| Rotary potentiometers (B1K–B1M) | Knobs → ADC channels |
| 5× B10K slider potentiometers | Sliders → ADC channels |
| 100× 0.1µF ceramic capacitors | Bypass / noise filtering |
| 5mm LEDs | Beat-reactive visual output |
| Breadboard + jumper wires | Prototyping |

> **Note on pot values**: B1K–B1M is a very wide range. For ADC control anything from
> 1K to 100K works well. Very high values (>100K) start to pick up noise; very low
> values (<500Ω) load the 3.3V rail noticeably. **B10K is ideal** — matches your sliders.

---

## LED resistors — what to buy

The Pi 5 GPIO outputs **3.3V**. LED forward voltage (Vf) varies by color:

| Color | Vf | Recommended R | Current at 3.3V |
|---|---|---|---|
| Red / Orange / Yellow | ~2.0V | **150Ω** | ~8.5 mA |
| Standard Green | ~2.2V | **150Ω** | ~7.3 mA |
| Blue | ~3.0–3.2V | **68Ω** | ~1.5–4.5 mA (dim) |
| White | ~3.0–3.6V | **68Ω** | may be very dim |

**Buy these:**
- **150Ω ¼W** resistors — for red / orange / yellow / standard green LEDs
- **68Ω ¼W** resistors — for blue / white LEDs

Blue and white LEDs are near or above the 3.3V rail, so they will be noticeably
dimmer than reds. If you need full brightness from blue/white, drive them from 5V
through a small NPN transistor (2N2222 / BC547) with a 1KΩ base resistor from the
GPIO pin — the GPIO pin controls it, not powers it directly.

---

## Pi 5 GPIO safety notes

- GPIO pins output **3.3V only** — do not connect 5V signals directly to GPIO
- Max **16 mA per pin** (stay under 10 mA per LED for long-term reliability)
- Max **50 mA total across all GPIO** simultaneously
- Always use series resistors on LEDs — never wire LEDs directly to GPIO

---

## Pi 5 GPIO pinout

```
          3.3V  [1]  [2]  5V
  (SDA1) GPIO2  [3]  [4]  5V
  (SCL1) GPIO3  [5]  [6]  GND
         GPIO4  [7]  [8]  GPIO14
           GND  [9]  [10] GPIO15
        GPIO17  [11] [12] GPIO18
        GPIO27  [13] [14] GND
        GPIO22  [15] [16] GPIO23
          3.3V  [17] [18] GPIO24
  SPI0_MOSI/GPIO10 [19] [20] GND
  SPI0_MISO/GPIO9  [21] [22] GPIO25
  SPI0_CLK/GPIO11  [23] [24] GPIO8/SPI0_CE0
           GND  [25] [26] GPIO7/SPI0_CE1   ← second MCP3008
        GPIO0   [27] [28] GPIO1
        GPIO5   [29] [30] GND
        GPIO6   [31] [32] GPIO12
        GPIO13  [33] [34] GND
        GPIO19  [35] [36] GPIO16
        GPIO26  [37] [38] GPIO20
           GND  [39] [40] GPIO21
```

**SPI0 pins used by the MCP3008s:**

| Signal | GPIO | Header Pin |
|---|---|---|
| MOSI (data to ADC) | GPIO10 | Pin 19 |
| MISO (data from ADC) | GPIO9 | Pin 21 |
| CLK | GPIO11 | Pin 23 |
| CE0 (chip select — MCP3008 #1) | GPIO8 | Pin 24 |
| CE1 (chip select — MCP3008 #2) | GPIO7 | Pin 26 |

---

## MCP3008 pinout (DIP-16)

```
        ┌─── notch ───┐
   CH0  [1]          [16]  VDD   ← 3.3V
   CH1  [2]          [15]  VREF  ← 3.3V
   CH2  [3] MCP3008  [14]  AGND  ← GND
   CH3  [4]          [13]  CLK   ← SPI CLK
   CH4  [5]          [12]  DOUT  → SPI MISO
   CH5  [6]          [11]  DIN   ← SPI MOSI
   CH6  [7]          [10]  CS    ← SPI CE0 (or CE1)
   CH7  [8]          [9]   DGND  ← GND
        └─────────────┘
```

Place the chip with the notch at the top. Pin 1 is top-left.

---

## Wiring: MCP3008 #1 (channels 0–7)

| MCP3008 #1 Pin | Signal | Pi Header Pin |
|---|---|---|
| 16 VDD | 3.3V power | Pin 1 (3.3V) |
| 15 VREF | Analog reference | Pin 1 (3.3V) |
| 14 AGND | Analog ground | Pin 6 (GND) |
| 9 DGND | Digital ground | Pin 6 (GND) |
| 13 CLK | SPI clock | Pin 23 (GPIO11) |
| 11 DIN | SPI MOSI | Pin 19 (GPIO10) |
| 12 DOUT | SPI MISO | Pin 21 (GPIO9) |
| 10 CS/SHDN | Chip select 0 | Pin 24 (GPIO8) |

Place a **0.1µF capacitor between VDD (pin 16) and GND (pin 9)** as close to the chip
as possible on the breadboard. This decouples supply noise from the ADC.

Place a second **0.1µF capacitor between VREF (pin 15) and AGND (pin 14)** to stabilize
the reference voltage.

---

## Wiring: MCP3008 #2 (channels 8–15)

Identical wiring to chip #1 with one difference — **CS connects to CE1 instead of CE0**:

| MCP3008 #2 Pin | Signal | Pi Header Pin |
|---|---|---|
| 16 VDD | 3.3V power | Pin 1 (3.3V) |
| 15 VREF | Analog reference | Pin 1 (3.3V) |
| 14 AGND | Analog ground | Pin 6 (GND) |
| 9 DGND | Digital ground | Pin 6 (GND) |
| 13 CLK | SPI clock | Pin 23 (GPIO11) |
| 11 DIN | SPI MOSI | Pin 19 (GPIO10) |
| 12 DOUT | SPI MISO | Pin 21 (GPIO9) |
| **10 CS/SHDN** | **Chip select 1** | **Pin 26 (GPIO7)** |

CLK, MOSI, and MISO are shared between both chips — they connect to the same Pi pins.
Only the CS lines are separate.

---

## Wiring: Potentiometers (rotary)

A standard potentiometer has three pins. Viewed from the front (shaft toward you):

```
  Left   Middle   Right
  (GND)  (wiper)  (3.3V)
```

This gives CCW = 0V (minimum), CW = 3.3V (maximum).

| Pot pin | Connects to |
|---|---|
| Left | GND rail |
| Middle (wiper) | MCP3008 channel pin (CH0–CH7) |
| Right | 3.3V rail |

**Add a 0.1µF cap between the wiper and GND** (one cap per pot, placed near the ADC
input on the breadboard). This forms a lowpass filter with the pot resistance and
eliminates ADC jitter from electrical noise.

---

## Wiring: Pushbuttons

Two momentary pushbuttons trigger browser actions when pressed.

gpiozero enables the Pi's internal pull-up resistor automatically — **no external resistor is needed**. Wire each button between a GPIO pin and GND.

```
  GPIO pin ──┤button├── GND
```

| Button | Action | GPIO | Header Pin |
|--------|---------|------|------------|
| Button 1 | Next background media (→) | GPIO23 | Pin 16 |
| Button 2 | Toggle bg ASCII layer (V) | GPIO24 | Pin 18 |

Use normally-open (NO) momentary pushbuttons. The bridge debounces each button at 50 ms.

---

## Wiring: Slider potentiometers (B10K)

Sliders are electrically identical to rotary pots. Check the datasheet or use a
multimeter to identify which end pin is which — physically the two end pins map to
the two travel extremes.

| Slider pin | Connects to |
|---|---|
| End pin A | GND |
| Middle / wiper | MCP3008 channel pin |
| End pin B | 3.3V |

Same 0.1µF cap between wiper and GND applies.

> If the slider moves the wrong way (up = lower value), swap pins A and B.

---

## Wiring: LEDs

Each LED connects between a GPIO output pin and GND, with a resistor in series.
Put the resistor on either side — between GPIO and anode, or between cathode and GND,
both work.

```
  GPIO pin ──[R]──┤LED anode  cathode├── GND
```

Polarity: the **longer leg is the anode (+)**. The flat side of the lens base is the
cathode (−).

Suggested GPIO pins for LEDs (available when SPI0 is in use):

| LED | GPIO | Header Pin |
|---|---|---|
| LED 1 | GPIO17 | Pin 11 |
| LED 2 | GPIO27 | Pin 13 |
| LED 3 | GPIO22 | Pin 15 |
| LED 4 | GPIO5 | Pin 29 |
| LED 5 | GPIO6 | Pin 31 |
| LED 6 | GPIO13 | Pin 33 |

GPIO pins 2, 3, 7, 8, 9, 10, 11 are reserved for SPI/I2C — avoid those for LEDs.

---

## Full connection summary (breadboard strategy)

On a standard 830-point breadboard:

1. **Power rails**: connect Pi pin 1 (3.3V) to the `+` rail, Pi pin 6 (GND) to the `−` rail.
   Add a jumper from pin 6 to the bottom rail too if using the full board.

2. **MCP3008 #1**: straddle the center gap, pins 1–8 on the left half, pins 9–16 on
   the right. Place bypass caps (VDD–GND and VREF–AGND) immediately adjacent.

3. **MCP3008 #2**: place further along the board, same orientation. Shares the CLK /
   MOSI / MISO lines via the breadboard row — run a single jumper from each SPI signal
   line to the second chip.

4. **Pots and sliders**: wire outer pins to power rails, wiper to a row, then a short
   jumper from that row to the MCP3008 channel pin. Place the 0.1µF cap in the same row
   as the wiper, other leg to the GND rail.

5. **LEDs**: each LED sits in a row, anode toward the GPIO jumper, cathode toward GND
   through its resistor.

---

## Software setup

### 1. Enable SPI on Pi 5

```bash
sudo raspi-config
# Interface Options → SPI → Enable
# Reboot
```

Verify after reboot:
```bash
ls /dev/spidev*
# Should show: /dev/spidev0.0  /dev/spidev0.1
```

### 2. Install Python dependencies

```bash
pip install websockets spidev
```

`spidev` requires SPI to be enabled in raspi-config first. On non-Pi machines
`spidev` will fail to install — that is expected; `pi-bridge.py` falls back to mock
sine-wave mode automatically.

### 3. Verify SPI user permissions

By default, `/dev/spidev*` is owned by the `spi` group. Add your user if needed:

```bash
sudo usermod -aG spi $USER
# Log out and back in for the group change to take effect
```

### 4. Start the bridge

```bash
chmod +x pi/pi-start.sh
./pi/pi-start.sh
```

This starts the HTTP file server on port 8080 and the WebSocket bridge on port 9001.
Open `http://localhost:8080` in Chromium.

---

## Configuring channels (hw-mapping.json)

`pi/hw-mapping.json` maps each ADC channel to a `V2_PARAMS` key. The `chip` field
selects which MCP3008 to read (0 = CE0, 1 = CE1). `channel` is 0–7 on that chip.

```json
{
  "channels": [
    { "chip": 0, "channel": 0, "param": "rainSpeedMax", "min": 0.3, "max": 2.0 },
    { "chip": 1, "channel": 0, "param": "waveOpacity",  "min": 0.0, "max": 1.0 }
  ]
}
```

For nested params (the `bgFx` sub-object), use dot notation: `"bgFx.warpAmount"`.

All available params and their valid ranges are in `fusion-params.js` under
`window.FUSION_PARAM_RANGES`. Do not map boolean params (e.g. `figureEnabled`) —
the bridge only routes numeric values.

---

## Testing without hardware

Run `python pi/pi-bridge.py` on any machine. When `spidev` is unavailable the bridge
automatically generates slowly-changing sine-wave values for every configured channel.
Open the app in the browser and watch the Fusion panel sliders move.

You can verify the WebSocket message format by watching the bridge's log output
(DEBUG level is on by default).

---

## Adding LED behavior

Fill in `pi/led_output.py`. The bridge calls `update_leds(beat_active, beat_intensity, bands)`
at ~16 Hz whenever the browser is connected. See the docstring and examples in that file.
No other files need to change.

---

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| `/dev/spidev*` not found | SPI not enabled in raspi-config |
| `PermissionError: /dev/spidev0.0` | User not in `spi` group |
| ADC reads all 0 or all 1023 | MOSI/MISO swapped, or VDD/AGND not connected |
| Noisy/jittery readings | Missing bypass caps, or floating wiper |
| Only chip #1 works, chip #2 reads 0 | CE1 (GPIO7, pin 26) not connected to chip #2 CS pin |
| Browser shows no param changes | Check bridge log for WebSocket connection messages |
