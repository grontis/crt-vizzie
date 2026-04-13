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

  MATRIX_SPEED_MIN: 0.2,
  MATRIX_SPEED_MAX: 1.2,
  MATRIX_BEAT_MULT: 3.5,    // speed multiplier on beat
  MATRIX_TRAIL_LENGTH: 20,

  TUNNEL_RING_COUNT: 12,
  TUNNEL_BEAT_WARP: 0.7,    // radii multiplier on beat
  TUNNEL_WARP_EASE: 0.08,   // easing speed back from warp
  TUNNEL_BASE_SPEED: 0.4,

  LIFE_BEAT_BLOCK_SIZE: 5,  // random block toggled on beat
  LIFE_RESURRECT_BASS: 0.7, // bass threshold above which random cells resurrect

  LISSAJOUS_TRAIL_LENGTH: 480,   // total trail points kept across frames
  LISSAJOUS_SAMPLES_PER_FRAME: 512, // waveform samples plotted each frame
  LISSAJOUS_MONO_TOLERANCE: 0.001,

  VU_PEAK_DECAY: 0.008,     // VU peak needle decay per frame

  GLITCH_DECAY_RATE: 0.010,  // brightness decay per frame in glitch buffer
  GLITCH_SEED_INTERVAL: 80, // frames between buffer reseeds
  GLITCH_SMEAR_CHANCE: 0.10,
  GLITCH_TEAR_CHANCE: 0.030,
  GLITCH_DROP_CHANCE: 0.025,

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

  // ── VJ Sync ──
  VJ_SYNC: {
    MODE_LIST:            [0, 1, 2, 3, 4, 5, 6, 7, 8], // all modes eligible for auto-switch
    MODE_DWELL_MS:        3000,   // minimum ms between auto mode switches
    PHOSPHOR_DWELL_MS:    4000,   // minimum ms between phosphor cycles
    SCANLINES_ENABLED:    true,   // whether VJ sync auto-toggles scanlines
    SCANLINE_DWELL_MS:    16000,  // minimum ms between scanline toggles
    BG_PULSE_AMOUNT:      0.18,   // opacity delta added to background on kick
    BG_PULSE_DECAY:       0.04,   // opacity units recovered per frame toward baseline
    BG_TOGGLE_ENABLED:    true,   // whether VJ sync stutters background on treble peaks
    BG_TREBLE_THRESH:     0.39,   // treble level that triggers a background stutter
    BG_STUTTER_FRAMES:    14,     // total frames of stutter window (~230ms at 60fps)
    BG_STUTTER_CHANCE:    0.45,   // per-frame probability of flipping visibility during stutter
    BG_STUTTER_DWELL_MS:  1500,   // minimum ms between stutter events
    KICK_SUB_THRESH:      0.50,   // bands.sub threshold for kick detection
    KICK_BASS_THRESH:     0.40,   // bands.bass threshold for kick detection
    SNARE_HIGHMID_THRESH: 0.35,   // bands.highMid threshold for snare detection
    SNARE_BASS_MAX:       0.30,   // bands.bass must be BELOW this for snare (not a kick)
  },
};
