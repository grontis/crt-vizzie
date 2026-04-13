// config.js — Central configuration object for VIZZÍE v1.0
// All tuneable constants live here. No logic — pure data.

const CONFIG = {

  // ── Font ──
  FONT_FACE: 'VT323',
  FONT_SIZE: 30,          // px — optimized for CRT composite output legibility

  // ── Grid (computed at runtime in sketch.js, seeded here for reference) ──
  // cols and rows are derived from canvas size / cell dimensions

  // ── FFT / Audio ──
  FFT_BINS: 1024,          // number of FFT bins (must be power of 2)
  FFT_SMOOTHING: 0.65,     // p5.FFT smoothing factor (0–1) — lower = faster decay on silence
  BEAT_THRESHOLD: 1.4,     // beat detected when bass > average * this
  BEAT_HISTORY: 43,        // number of bass energy samples for rolling average (~1s at 60fps / 1.4)
  BEAT_COOLDOWN: 300,      // ms minimum between detected beats
  BPM_HISTORY: 8,          // number of beat intervals to keep for BPM median

  // ── Background ──
  BG_DEFAULT_OPACITY: 0.85,
  BG_OPACITY_STEP: 0.05,
  BG_LUMA_INFLUENCE: 0.4,  // how much background luma biases morph figure selection (0–1)

  // ── Scanlines ──
  SCANLINE_ALPHA: 0.33,    // opacity of the scanline overlay
  SCANLINE_SPACING: 4,     // draw a line every N pixels

  // ── Modes ──
  MORPH_WIDTH: 40,
  MORPH_HEIGHT: 20,
  MORPH_NOISE_CHARS: '!@#$%^&*<>?/\\|~`abcdefghijklmnopqrstuvwxyz0123456789',
  MORPH_TWEEN_SPEED: 0.015, // tweenProgress increment per frame (beat overrides)
  MORPH_SHIMMER_CHANCE: 0.04, // chance per stable cell per frame of treble shimmer

  PEAK_DECAY: 0.015,        // spectrum peak hold decay per frame

  MATRIX_SPEED_MIN: 0.3,
  MATRIX_SPEED_MAX: 1.2,
  MATRIX_BEAT_MULT: 2.0,    // speed multiplier on beat
  MATRIX_TRAIL_LENGTH: 16,

  TUNNEL_RING_COUNT: 12,
  TUNNEL_BEAT_WARP: 0.7,    // radii multiplier on beat
  TUNNEL_WARP_EASE: 0.08,   // easing speed back from warp
  TUNNEL_BASE_SPEED: 0.4,

  LIFE_BEAT_BLOCK_SIZE: 5,  // random block toggled on beat
  LIFE_RESURRECT_BASS: 0.7, // bass threshold above which random cells resurrect

  LISSAJOUS_TRAIL_LENGTH: 120,
  LISSAJOUS_MONO_TOLERANCE: 0.001,

  VU_PEAK_DECAY: 0.008,     // VU peak needle decay per frame

  GLITCH_DECAY_RATE: 0.02,  // brightness decay per frame in glitch buffer
  GLITCH_SEED_INTERVAL: 180,// frames between buffer reseeds
  GLITCH_SMEAR_CHANCE: 0.05,
  GLITCH_TEAR_CHANCE: 0.015,
  GLITCH_DROP_CHANCE: 0.03,

  // ── Phosphor Presets ──
  PHOSPHORS: {
    green: { dim: '#00460f', mid: '#00b428', bright: '#00ff41' },
    amber: { dim: '#552d00', mid: '#c87800', bright: '#ffb200' },
    blue:  { dim: '#0f2855', mid: '#2d69c8', bright: '#50aaff' },
    red:   { dim: '#3d0000', mid: '#880000', bright: '#ff2200' },
    white: { dim: '#222222', mid: '#aaaaaa', bright: '#f0f0f0' },
  },
  PHOSPHOR_ORDER: ['green', 'amber', 'blue', 'red', 'white'],

  // ── CGA Colors (used exclusively by glitch mode) ──
  CGA_COLORS: [
    '#000000', '#0000aa', '#00aa00', '#00aaaa',
    '#aa0000', '#aa00aa', '#aa5500', '#aaaaaa',
    '#555555', '#5555ff', '#55ff55', '#55ffff',
    '#ff5555', '#ff55ff', '#ffff55', '#ffffff',
  ],

  // ── Character Sets ──
  KATAKANA: (function() {
    const chars = [];
    for (let i = 0x30A0; i <= 0x30FF; i++) chars.push(String.fromCharCode(i));
    // also add some Latin and digit noise
    '0123456789ABCDEFabcdef|/\\'.split('').forEach(c => chars.push(c));
    return chars;
  })(),

  BLOCK_CHARS: '▁▂▃▄▅▆▇█',
  SHADE_CHARS: ' ░▒▓█',

  // ── Idle screen (shown when no audio source is active) ──
  IDLE_CHAR_DELAY: 30,   // ms per character typed
  IDLE_LINE_GAP: 150,    // ms pause between lines

  IDLE_LINES: [
    'VIZZÍE AUDIO TERMINAL v1.0',
    '(c) 1997 CRTLAB INDUSTRIES',
    '',
    'FFT SUBSYSTEM..................... OK',
    'PHOSPHOR PALETTE.................. OK',
    'SCANLINE RENDERER................. OK',
    '',
    '> SYSTEM READY.',
    '',
    '  DROP AUDIO FILE TO BEGIN',
    '  [A] BROWSE FILES   [D] DEMO MODE',
  ],

  // ── Canvas background overlay ──
  CANVAS_BG_ALPHA: 150,  // translucent black drawn each frame (0–255) — lower = more background visible
};
