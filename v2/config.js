// v2/config.js — Configuration for v2 WebGL ASCII visualizer
// V2_CONFIG: immutable runtime constants
// V2_PARAMS: live-tunable visual parameters (written by hardware-bridge.js)
// V2_PARAM_RANGES: min/max bounds for every numeric param
//
// Load order: must be first — all other v2 files read from these objects.

'use strict';

// ── Runtime constants ─────────────────────────────────────────────────────────

window.V2_CONFIG = {

  // Font
  FONT_FACE:         'Orbitron',
  FONT_FILE:         'fonts/Orbitron-VariableFont_wght.ttf',
  FONT_WEIGHT:       800,          // variable font weight (100–900)
  FONT_SIZE:         33,           // px — cell height (visualizer)
  STARTUP_FONT_SIZE: 24,           // px — startup terminal text
  CHAR_SPACING:      1.15,         // multiplier on measured glyph width
  LINE_SPACING:      1.10,         // multiplier on font size for row height

  // Canvas
  CANVAS_WIDTH:  1280,
  CANVAS_HEIGHT: 720,

  // Rendering
  TARGET_FPS:    30,
  FRAME_BUDGET:  1000 / 30,  // ms

  // ASCII art stamp dimensions (must match AsciiArtLibrary frame dimensions)
  MORPH_WIDTH:  40,
  MORPH_HEIGHT: 20,

  // Glyph atlas layout
  // 20 columns × ~22 rows = ~440 slots — covers ~423 chars after box-drawing + symbolic expansion
  ATLAS_COLS: 20,             // characters per row in glyph atlas

  // Audio analysis
  FFT_SIZE:        1024,
  FFT_SMOOTHING:   0.65,
  BEAT_THRESHOLD:  1.25,
  BEAT_HISTORY:    43,
  BEAT_COOLDOWN:   300,       // ms minimum between beats
  BPM_HISTORY:     8,

  // Character sets (used by fusion mode)
  KATAKANA: (function () {
    const chars = [];
    for (let i = 0x30A0; i <= 0x30FF; i++) chars.push(String.fromCharCode(i));
    '0123456789ABCDEFabcdef|/\\'.split('').forEach(c => chars.push(c));
    return chars;
  })(),

  // Phosphor presets: each has dim/mid/bright as [r,g,b] 0–1 floats
  PHOSPHORS: {
    green: { dim: [0.000, 0.275, 0.059], mid: [0.000, 0.706, 0.157], bright: [0.000, 1.000, 0.255] },
    amber: { dim: [0.333, 0.176, 0.000], mid: [0.784, 0.471, 0.000], bright: [1.000, 0.698, 0.000] },
    blue:  { dim: [0.059, 0.157, 0.333], mid: [0.176, 0.412, 0.784], bright: [0.314, 0.667, 1.000] },
    red:   { dim: [0.239, 0.000, 0.000], mid: [0.533, 0.000, 0.000], bright: [1.000, 0.133, 0.000] },
    white: { dim: [0.133, 0.133, 0.133], mid: [0.667, 0.667, 0.667], bright: [0.941, 0.941, 0.941] },
  },
  PHOSPHOR_ORDER: ['red', 'amber', 'green', 'blue', 'white'],

  // ASCII density ramps (lightest to darkest visual weight)
  // Used by the bgAscii layer in fusion.js to map background luma to characters.
  ASCII_DENSITY_RAMPS: [
    ' .\'`^",:;Il!i><~+_-?][}{1)(|/tfjrxnuvczXYUJCLQ0OZmwqpdbkhao*#MW&8%B@$', // 0: full 70-char ramp
    ' .:-=+*#%@',                                                                 // 1: minimal 10-char ramp
    ' ░▒▓█',                                                  // 2: block shading ramp (░▒▓█)
  ],

  // CGA 16-color palette as [r,g,b] 0–1 floats
  // Index 0 = black (used as "no CGA override — use phosphor")
  CGA_COLORS: [
    [0.000, 0.000, 0.000], // 0  black
    [0.000, 0.000, 0.667], // 1  dark blue
    [0.000, 0.667, 0.000], // 2  dark green
    [0.000, 0.667, 0.667], // 3  dark cyan
    [0.667, 0.000, 0.000], // 4  dark red
    [0.667, 0.000, 0.667], // 5  dark magenta
    [0.667, 0.333, 0.000], // 6  brown
    [0.667, 0.667, 0.667], // 7  light gray
    [0.333, 0.333, 0.333], // 8  dark gray
    [0.333, 0.333, 1.000], // 9  bright blue
    [0.333, 1.000, 0.333], // 10 bright green
    [0.333, 1.000, 1.000], // 11 bright cyan
    [1.000, 0.333, 0.333], // 12 bright red
    [1.000, 0.333, 1.000], // 13 bright magenta
    [1.000, 1.000, 0.333], // 14 yellow
    [1.000, 1.000, 1.000], // 15 white
  ],

};

// ── Live-tunable parameters ───────────────────────────────────────────────────
// Written each frame by fusion.js. Can be mutated by hardware-bridge.js.

window.V2_PARAMS = {

  // Phosphor preset (index into V2_CONFIG.PHOSPHOR_ORDER)
  phosphorIndex: 2,

  // Beat-reactive chroma offset (internal state, updated by sketch.js each frame)
  _chromaBeatCurrent: 0,

  // Scanline darkening intensity (0 = off, 1 = very dark every other row)
  scanlineIntensity: 0.33,
  // Scanline mode: 0=off, 1=pixel (every other px row), 2=cell-gap, 3=smooth
  scanlineMode: 1,

  // Chromatic aberration base offset in pixels (0 = off)
  chromaBase:  1.5,
  chromaBeat:  4.0,   // extra px on beat (added to chromaBase * beatIntensity)

  // Layer enables
  figureEnabled: true,
  rainEnabled:   true,
  waveEnabled:   true,
  glitchEnabled: true,

  // Figure layer
  figDecay:        0.007,
  figReseedFrames: 160,
  figBrightness:   0.65,
  figSmear:        0.025,
  figOpacity:      1.0,

  // Rain layer
  rainSpeedMin:  0.01,
  rainSpeedMax:  0.2,
  rainBeatMult:  8.2,
  rainTrail:     6,
  rainInteract:  0.50,
  rainBurnBoost: 0.20,
  rainOpacity:   0.5,

  // Wave layer
  waveOpacity:    0.66,
  waveThreshold:  0.60,
  waveSpeed:      0.04,
  waveBeatBoost:  0.33,
  waveBeatDecay:  0.06,
  waveThreshDrop: 0.18,
  waveCharRate:   0.006,

  // Glitch layer
  glitchThreshold:    0.30,
  glitchChance:       0.66,
  glitchScatter:      0.045,
  glitchTear:         0.020,
  glitchSeedInterval: 80,
  glitchCgaEnabled:   true,
  glitchDecayRate:    0.010,
  glitchSmearChance:  0.33,
  glitchDropChance:   0.025,
  glitchScatterThreshold: 0.20,
  glitchBlastThreshold:   0.40,
  glitchTrebleFloor:      0.15,
  glitchBeatSeedMin:      12,
  glitchIntensityScale:   1.5,

  // BG (background image) layer
  bgEnabled:       true,
  bgOpacity:       0.55,
  bgLumaThreshold: 0.30,
  bgStutterAmp:    0.1,

  // BG FX (audio-reactive CSS filters on the bg layer)
  bgFxEnabled:    true,
  bgFxHueShift:   35.0,
  bgFxSaturation: 1.1,
  bgFxBrightness: 1.0,
  bgFxContrast:   0.11,
  bgFxBlur:       1.0,
  bgFxInvert:     0.0,
  bgFxScalePulse: 0.0,
  bgFxSepia:      0.0,
  bgFxGrayscale:  0.0,

  // ASCII art layer (bgAscii) — V key toggles
  bgAsciiEnabled:    false, // bool: layer on/off
  bgAsciiLevel:      0.33,   // float [0..1]: overall blend/brightness (static knob)
  _bgAsciiAudioAdd:  0.33,   // float: audio-reactive add (written by sketch.js each frame)
  bgAsciiAudioMult:  0.33,   // float [0..1]: how strongly audio drives brightness boost
  bgAsciiInvert:     false, // bool: invert luma→ramp mapping (for dark-bg media)
  bgAsciiRampPreset: 0,     // int [0..2]: density ramp selector

};

// ── Param ranges for hardware bridge clamping ─────────────────────────────────

window.V2_PARAM_RANGES = {

  // phosphorIndex: max = PHOSPHOR_ORDER.length - 1 = 4 (green/amber/blue/red/white)
  phosphorIndex:     { min: 0,     max: 4    },

  scanlineIntensity: { min: 0,     max: 1.0  },
  scanlineMode:      { min: 0,     max: 3    },
  chromaBase:        { min: 0,     max: 8.0  },
  chromaBeat:        { min: 0,     max: 12.0 },

  figDecay:        { min: 0.001, max: 0.03  },
  figReseedFrames: { min: 40,    max: 400   },
  figBrightness:   { min: 0.1,   max: 1.0   },
  figSmear:        { min: 0,     max: 0.1   },
  figOpacity:      { min: 0,     max: 1.0   },

  rainSpeedMin:    { min: 0.05,  max: 0.5   },
  rainSpeedMax:    { min: 0.3,   max: 2.0   },
  rainBeatMult:    { min: 1.0,   max: 6.0   },
  rainTrail:       { min: 4,     max: 30    },
  rainInteract:    { min: 0,     max: 1.0   },
  rainBurnBoost:   { min: 0,     max: 0.5   },
  rainOpacity:     { min: 0,     max: 1.0   },

  waveOpacity:     { min: 0,     max: 1.0  },
  waveThreshold:   { min: 0.3,   max: 0.85 },
  waveSpeed:       { min: 0.01,  max: 0.12 },
  waveBeatBoost:   { min: 0,     max: 0.5  },
  waveBeatDecay:   { min: 0.02,  max: 0.2  },
  waveThreshDrop:  { min: 0,     max: 0.4  },
  waveCharRate:    { min: 0,     max: 0.05 },

  glitchThreshold:    { min: 0.3,   max: 0.95  },
  glitchChance:       { min: 0.05,  max: 1.0   },
  glitchScatter:      { min: 0,     max: 0.15  },
  glitchTear:         { min: 0,     max: 0.05  },
  glitchSeedInterval: { min: 20,    max: 300   },
  glitchDecayRate:    { min: 0.002, max: 0.05  },
  glitchSmearChance:  { min: 0,     max: 0.3   },
  glitchDropChance:   { min: 0,     max: 0.1   },
  glitchScatterThreshold: { min: 0.05, max: 0.60 },
  glitchBlastThreshold:   { min: 0.15, max: 0.80 },
  glitchTrebleFloor:      { min: 0.02, max: 0.40 },
  glitchBeatSeedMin:      { min: 4,    max: 40   },
  glitchIntensityScale:   { min: 0.5,  max: 2.0  },

  bgOpacity:        { min: 0,    max: 1.0  },
  bgLumaThreshold:  { min: 0.1,  max: 0.8  },
  bgStutterAmp:     { min: 0,    max: 0.2  },

  // BG FX (audio-reactive CSS filters on the bg layer)
  bgFxHueShift:    { min: 0,   max: 180.0 },
  bgFxSaturation:  { min: 0,   max: 2.0   },
  bgFxBrightness:  { min: 0,   max: 1.0   },
  bgFxContrast:    { min: 0,   max: 1.0   },
  bgFxBlur:        { min: 0,   max: 4.0   },
  bgFxInvert:      { min: 0,   max: 1.0   },
  bgFxScalePulse:  { min: 0,   max: 0.3   },
  bgFxSepia:       { min: 0,   max: 1.0   },
  bgFxGrayscale:   { min: 0,   max: 1.0   },

  // ASCII art layer
  bgAsciiLevel:      { min: 0, max: 1.0 },
  bgAsciiAudioMult:  { min: 0, max: 1.0 },
  bgAsciiRampPreset: { min: 0, max: 2   },

};
