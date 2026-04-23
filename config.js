// config.js — Central configuration object for GRONTIS.IO v1.1
// All tuneable constants live here. No logic — pure data.

const CONFIG = {

  // ── Font ──
  FONT_FACE: 'GlassTTY',
  FONT_SIZE: 40,          // px — optimized for CRT composite output legibility
  CHAR_SPACING: 1.15,     // multiplier on glyph width — adds horizontal breathing room
  LINE_SPACING: 1.10,     // multiplier on font size for row height

  // ── Text glitch rendering ──
  CHROMA_BASE: 1,         // always-on chromatic aberration offset in pixels
  CHROMA_BEAT: 4,         // additional px offset on beat (total = BASE + BEAT * intensity)
  CHAR_JITTER_PX: 3.5,    // max per-character position jitter in pixels on beat
  CHAR_JITTER_CHANCE: 0.31, // fraction of characters that jitter each frame on beat

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
  BG_DEFAULT_OPACITY: 1.0,
  BG_OPACITY_STEP: 0.05,
  // ── Scanlines ──
  SCANLINE_ALPHA: 0.33,    // opacity of the scanline overlay
  SCANLINE_SPACING: 4,     // draw a line every N pixels

  // ── Modes ──
  MORPH_WIDTH: 40,   // ASCII art stamp width
  MORPH_HEIGHT: 20,  // ASCII art stamp height

  // ── Phosphor Presets ──
  PHOSPHORS: {
    green: { dim: '#00460f', mid: '#00b428', bright: '#00ff41' },
    amber: { dim: '#552d00', mid: '#c87800', bright: '#ffb200' },
    blue:  { dim: '#0f2855', mid: '#2d69c8', bright: '#50aaff' },
    red:   { dim: '#3d0000', mid: '#880000', bright: '#ff2200' },
    white: { dim: '#222222', mid: '#aaaaaa', bright: '#f0f0f0' },
  },
  PHOSPHOR_ORDER: ['green', 'amber', 'blue', 'red', 'white'],

  // ── CGA Colors (used by Fusion mode glitch layer) ──
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
  IDLE_BOOT_DELAY: 2500,     // ms of blinking cursor before glitch starts
  IDLE_GLITCH_DURATION: 900, // ms of noise animation before typewriter begins
  IDLE_CHAR_DELAY: 30,       // ms per character typed
  IDLE_LINE_GAP: 125,        // ms pause between lines

  IDLE_LINES: [
    'GRONTIS.IO AUDIO TERMINAL v1.1',
    '(c) 1993 CYBERTRANCE INDUSTRIES',
    '',
    'FFT SUBSYSTEM..................... READY',
    'PHOSPHOR PALETTE.................. READY',
    'SCANLINE RENDERER................. READY',
    '',
    '> SYSTEM READY. (HACK THE PLANET)',
    '',
    '  DROP AUDIO FILE TO BEGIN',
    '  [A] BROWSE FILES   [D] DEMO MODE',
  ],

  // ── Canvas background overlay ──
  CANVAS_BG_ALPHA: 100,  // translucent black drawn each frame (0–255) — lower = more background visible

};
