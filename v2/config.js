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
  // 20 columns × 14 rows = 280 slots — enough for the full charset (~275 chars)
  ATLAS_COLS: 20,             // characters per row in glyph atlas

  // Audio analysis
  FFT_SIZE:        1024,
  FFT_SMOOTHING:   0.65,
  BEAT_THRESHOLD:  1.4,
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
  PHOSPHOR_ORDER: ['green', 'amber', 'blue', 'red', 'white'],

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
  phosphorIndex: 0,

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
  rainSpeedMin:  0.15,
  rainSpeedMax:  0.90,
  rainBeatMult:  3.2,
  rainTrail:     14,
  rainInteract:  0.50,
  rainBurnBoost: 0.20,
  rainOpacity:   1.0,

  // Wave layer
  waveOpacity:    0.75,
  waveThreshold:  0.60,
  waveSpeed:      0.04,
  waveBeatBoost:  0.18,
  waveBeatDecay:  0.06,
  waveThreshDrop: 0.18,
  waveCharRate:   0.006,

  // Glitch layer
  glitchThreshold:    0.62,
  glitchChance:       0.55,
  glitchScatter:      0.045,
  glitchTear:         0.020,
  glitchSeedInterval: 80,
  glitchCgaEnabled:   true,
  glitchDecayRate:    0.010,
  glitchSmearChance:  0.10,
  glitchDropChance:   0.025,

  // BG (background image) layer
  bgEnabled:       true,
  bgOpacity:       0.55,
  bgLumaThreshold: 0.30,
  bgStutterAmp:    0.04,

};

// ── Param ranges for hardware bridge clamping ─────────────────────────────────

window.V2_PARAM_RANGES = {

  // phosphorIndex: max = PHOSPHOR_ORDER.length - 1 = 4 (green/amber/blue/red/white)
  phosphorIndex:     { min: 0,     max: 4    },

  scanlineIntensity: { min: 0,     max: 1.0  },
  scanlineMode:      { min: 0,     max: 1    },
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

  bgOpacity:        { min: 0,    max: 1.0  },
  bgLumaThreshold:  { min: 0.1,  max: 0.8  },
  bgStutterAmp:     { min: 0,    max: 0.2  },

};
