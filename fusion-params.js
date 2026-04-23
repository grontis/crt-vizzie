// fusion-params.js — Live parameter store for FusionMode
//
// All values here mirror the static constants that were originally hardcoded in
// modes/fusion.js. Setting any value here takes effect the very next frame —
// no page reload required.
//
// This file has no logic. It only sets window.FUSION_PARAMS.
// Must be loaded before modes/fusion.js.

window.FUSION_PARAMS = {

  // ── Layer enable gates ────────────────────────────────────────────────────
  figureEnabled: true,   // master toggle for the ASCII art figure layer
  rainEnabled:   true,   // master toggle for the matrix rain layer
  glitchEnabled: true,   // master toggle for glitch corruption effects
  bgEnabled:     true,   // master toggle for background modulation

  // ── Figure layer ──────────────────────────────────────────────────────────
  // default: FIG_DECAY = 0.007
  figDecay:        0.007,  // brightness lost per frame — lower = figure lingers longer
  // default: FIG_RESEED_F = 160
  figReseedFrames: 160,    // frames between automatic figure reseeds
  // default: FIG_BRIGHTNESS = 0.65
  figBrightness:   0.65,   // brightness when a figure is first stamped in
  // default: FIG_SMEAR = 0.025
  figSmear:        0.025,  // per-cell chance per frame to smear char to right neighbor
  figOpacity:      1.0,    // global brightness multiplier for figure cells (0–1)

  // ── Rain layer ────────────────────────────────────────────────────────────
  // default: RAIN_SPEED_MIN = 0.15
  rainSpeedMin:  0.15,
  // default: RAIN_SPEED_MAX = 0.90
  rainSpeedMax:  0.90,
  // default: RAIN_BEAT_MULT = 3.2
  rainBeatMult:  3.2,   // speed multiplier on beat
  // default: RAIN_TRAIL = 14
  rainTrail:     14,    // cells behind the head that form the trail
  // default: RAIN_INTERACT = 0.50
  rainInteract:  0.50,  // chance the rain head borrows the figure char it overlaps
  // default: RAIN_BURN_BOOST = 0.20
  rainBurnBoost: 0.20,  // brightness added to figure cell when rain head touches it
  rainOpacity:   1.0,   // global brightness multiplier for rain cells (0–1)

  // ── Glitch layer ──────────────────────────────────────────────────────────
  // default: GLI_THRESHOLD = 0.62
  glitchThreshold: 0.62,   // beatIntensity needed to trigger a burst
  // default: GLI_CHANCE = 0.55
  glitchChance:    0.55,   // probability a burst fires when threshold is met
  // default: GLI_SCATTER = 0.045
  glitchScatter:   0.045,  // fraction of cells scattered on a hard beat
  // default: GLI_TEAR = 0.020
  glitchTear:      0.020,  // per-row horizontal tear probability on beat
  glitchSeedInterval: 80,  // frames between timer-based content reseeds
  glitchCgaEnabled:   true, // use CGA 16-color palette on glitch cells; false = phosphor
  glitchDecayRate:    0.010, // brightness lost per frame on glitch cells
  glitchSmearChance:  0.10,  // per-cell chance per frame to smear char to right/down neighbor
  glitchDropChance:   0.025, // per-cell chance per frame to drop (zero) brightness

  // ── Background layer ──────────────────────────────────────────────────────
  // default: BG_KICK_SUB = 0.50
  bgKickSub:       0.50,   // sub threshold for kick detection
  // default: BG_KICK_BASS = 0.40
  bgKickBass:      0.40,   // bass threshold for kick detection
  // default: BG_PULSE_AMOUNT = 0.18
  bgPulseAmount:   0.18,   // opacity added on each kick
  // default: BG_PULSE_DECAY = 0.04
  bgPulseDecay:    0.04,   // opacity units recovered per frame after a pulse
  // default: BG_TREBLE_THRESH = 0.39
  bgTrebleThresh:  0.39,   // treble level that triggers a stutter
  // default: BG_STUTTER_FRAMES = 14
  bgStutterFrames: 14,     // frames of stutter window (~230ms at 60fps)
  // default: BG_STUTTER_CHANCE = 0.45
  bgStutterChance: 0.45,   // per-frame probability of flipping visibility during stutter
  // default: BG_STUTTER_DWELL = 1500
  bgStutterDwell:  1500,   // minimum ms between stutter events (internal, no slider)
  // default: BG_LUMA_BOOST = 0.35
  bgLumaBoost:     0.35,   // max extra brightness added to figure cells by luma sampling

  // ── Wave layer ────────────────────────────────────────────────────────────
  waveEnabled:    true,
  waveOpacity:    0.75,    // global brightness multiplier (0–1)
  waveThreshold:  0.60,    // field value above which chars are visible (0–1)
  waveSpeed:      0.04,    // base time advancement per frame
  waveBeatBoost:  0.18,    // speed added on beat rising edge (decays per frame)
  waveBeatDecay:  0.06,    // speed boost decay rate per frame
  waveThreshDrop: 0.18,    // amount threshold is lowered on beat
  waveCharRate:   0.006,   // per-cell chance per frame to mutate visible char

  // ── Background pixel FX (BackgroundFX class) ─────────────────────────────
  bgFx: {
    enabled:         false,  // master toggle — FX canvas shown only when true

    // Posterize
    posterizeEnabled: true,
    posterizeLevels:  4,      // 2–8 quantization levels

    // Warp
    warpEnabled:      true,
    warpAmount:       6,      // max pixel displacement radius
    warpFreq:         0.012,  // spatial frequency of warp noise (lower = slower undulation)
    warpBeatMult:     2.5,    // displacement multiplier on beat

    // Scanline corruption
    corruptEnabled:   true,
    corruptStrips:    4,      // number of horizontal strips shifted per trigger
    corruptAmount:    8,      // max pixel shift per strip
    corruptThresh:    0.55,   // beatIntensity threshold to trigger corruption

    // Chromatic aberration
    chromaEnabled:    true,
    chromaOffset:     4,      // base channel separation in pixels
    chromaBeatMult:   3.0,    // multiplier on beat

    // Beat flash
    flashEnabled:     true,
    flashAlpha:       0.35,   // max white overlay alpha (0–1) on beat
    flashDecay:       0.08,   // alpha reduced per frame
  },

};

// ── Param ranges for automation (drift LFO + beat-synced morph) ──────────────
// Parallel structure to FUSION_PARAMS — provides { min, max } for every numeric
// param that drift/morph may touch. Boolean keys and internal timing constants
// are intentionally absent (they are excluded from automation).

window.FUSION_PARAM_RANGES = {

  // Figure layer
  figDecay:        { min: 0.001, max: 0.03  },
  figReseedFrames: { min: 40,    max: 400   },
  figBrightness:   { min: 0.1,   max: 1.0   },
  figSmear:        { min: 0,     max: 0.1   },
  figOpacity:      { min: 0,     max: 1.0   },

  // Rain layer
  rainSpeedMin:    { min: 0.05,  max: 0.5   },
  rainSpeedMax:    { min: 0.3,   max: 2.0   },
  rainBeatMult:    { min: 1.0,   max: 6.0   },
  rainTrail:       { min: 4,     max: 30    },
  rainInteract:    { min: 0,     max: 1.0   },
  rainBurnBoost:   { min: 0,     max: 0.5   },
  rainOpacity:     { min: 0,     max: 1.0   },

  // Glitch layer
  glitchThreshold: { min: 0.3,   max: 0.95  },
  glitchChance:    { min: 0.05,  max: 1.0   },
  glitchScatter:   { min: 0,     max: 0.15  },
  glitchTear:      { min: 0,     max: 0.05  },
  glitchSeedInterval: { min: 20, max: 300 },
  glitchDecayRate:   { min: 0.002, max: 0.05 },
  glitchSmearChance: { min: 0,     max: 0.3  },
  glitchDropChance:  { min: 0,     max: 0.1  },

  // Background modulation layer
  bgKickSub:       { min: 0.1,   max: 0.9   },
  bgKickBass:      { min: 0.1,   max: 0.9   },
  bgPulseAmount:   { min: 0,     max: 0.5   },
  bgPulseDecay:    { min: 0.01,  max: 0.15  },
  bgTrebleThresh:  { min: 0.1,   max: 0.9   },
  bgLumaBoost:     { min: 0,     max: 1.0   },

  // Wave layer
  waveOpacity:     { min: 0,     max: 1.0  },
  waveThreshold:   { min: 0.3,   max: 0.85 },
  waveSpeed:       { min: 0.01,  max: 0.12 },
  waveBeatBoost:   { min: 0,     max: 0.5  },
  waveBeatDecay:   { min: 0.02,  max: 0.2  },
  waveThreshDrop:  { min: 0,     max: 0.4  },
  waveCharRate:    { min: 0,     max: 0.05 },

  // Background pixel FX (nested sub-object)
  bgFx: {
    warpAmount:     { min: 0,     max: 20   },
    warpFreq:       { min: 0.003, max: 0.05 },
    warpBeatMult:   { min: 1.0,   max: 5.0  },
    corruptStrips:  { min: 0,     max: 10   },
    corruptAmount:  { min: 0,     max: 30   },
    corruptThresh:  { min: 0.3,   max: 0.95 },
    chromaOffset:   { min: 0,     max: 12   },
    chromaBeatMult: { min: 1.0,   max: 5.0  },
    flashAlpha:     { min: 0,     max: 1.0  },
    flashDecay:     { min: 0.02,  max: 0.2  },
  },

};
