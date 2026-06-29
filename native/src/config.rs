pub struct Params {
    pub phosphor_index: usize,      // 0–4, indexes PHOSPHOR_ORDER / PHOSPHORS
    pub scanline_intensity: f32,    // 0.0–1.0
    pub scanline_mode: i32,         // 0=off 1=pixel 2=cell-gap 3=smooth
    pub chroma_base: f32,           // always-on chromatic-aberration pixel offset
    pub chroma_beat_current: f32,   // beat-reactive add (envelope maintained by main.rs)
    pub chroma_beat: f32,           // extra px on beat (added to chromaBase * beatIntensity)
    pub bg_enabled: bool,           // B key — composite game vs ASCII-on-black
    pub bg_opacity: f32,            // 0.0–1.0 game opacity before the screen blend
    /// 0 = phosphor/CGA glyph color; 1 = color glyphs by a contrast of the game underneath them.
    pub glyph_tint: f32,

    // ── Layer enables ────────────────────────────────────────────────────────
    pub fig_enabled: bool,           // figureEnabled
    pub rain_enabled: bool,          // rainEnabled
    pub wave_enabled: bool,          // waveEnabled
    pub glitch_enabled: bool,        // glitchEnabled

    // ── Figure layer ─────────────────────────────────────────────────────────
    pub fig_decay: f32,              // figDecay: 0.007
    pub fig_reseed_frames: u32,      // figReseedFrames: 160
    pub fig_brightness: f32,         // figBrightness: 0.65
    pub fig_smear: f32,              // figSmear: 0.025
    pub fig_opacity: f32,            // figOpacity: 1.0

    // ── Rain layer ───────────────────────────────────────────────────────────
    pub rain_speed_min: f32,         // rainSpeedMin: 0.01
    pub rain_speed_max: f32,         // rainSpeedMax: 0.2
    pub rain_beat_mult: f32,         // rainBeatMult: 8.2
    pub rain_trail: usize,           // rainTrail: 6
    pub rain_interact: f32,          // rainInteract: 0.50
    pub rain_burn_boost: f32,        // rainBurnBoost: 0.20
    pub rain_opacity: f32,           // rainOpacity: 0.5

    // ── Wave layer ───────────────────────────────────────────────────────────
    pub wave_opacity: f32,           // waveOpacity: 0.66
    pub wave_threshold: f32,         // waveThreshold: 0.60
    pub wave_speed: f32,             // waveSpeed: 0.04
    pub wave_beat_boost: f32,        // waveBeatBoost: 0.33
    pub wave_beat_decay: f32,        // waveBeatDecay: 0.06
    pub wave_thresh_drop: f32,       // waveThreshDrop: 0.18
    pub wave_char_rate: f32,         // waveCharRate: 0.006

    // ── Glitch layer ─────────────────────────────────────────────────────────
    pub glitch_threshold: f32,           // glitchThreshold: 0.30
    pub glitch_chance: f32,              // glitchChance: 0.66
    pub glitch_scatter: f32,             // glitchScatter: 0.045
    pub glitch_tear: f32,                // glitchTear: 0.020
    pub glitch_seed_interval: u32,       // glitchSeedInterval: 80
    pub glitch_cga_enabled: bool,        // glitchCgaEnabled: true
    pub glitch_decay_rate: f32,          // glitchDecayRate: 0.010
    pub glitch_smear_chance: f32,        // glitchSmearChance: 0.33
    pub glitch_drop_chance: f32,         // glitchDropChance: 0.025
    pub glitch_scatter_threshold: f32,   // glitchScatterThreshold: 0.20
    pub glitch_blast_threshold: f32,     // glitchBlastThreshold: 0.40
    pub glitch_treble_floor: f32,        // glitchTrebleFloor: 0.15
    pub glitch_beat_seed_min: u32,       // glitchBeatSeedMin: 12
    pub glitch_intensity_scale: f32,     // glitchIntensityScale: 1.5

    // ── Calm-idle (native-only) ───────────────────────────────────────────────
    /// Broadband level below this maps to "silent" (mic hiss stays idle). Default: 0.06.
    pub idle_noise_floor:  f32,
    /// Activity envelope rise rate (fast attack on audio onset). Default: 0.35.
    pub activity_attack:   f32,
    /// Activity envelope fall rate (slow release when audio stops). Default: 0.02.
    pub activity_release:  f32,
    /// Below this activity level, figure holds static and glitch stops seeding. Default: 0.15.
    pub idle_active_gate:  f32,
    /// Rain drift fraction at full idle (rain crawls rather than stopping). Default: 0.04.
    pub idle_rain_floor:   f32,
    /// Wave brightness floor at full idle (wave dims rather than disappearing). Default: 0.20.
    pub idle_wave_dim:     f32,

    // ── Hardware input (native-only) ──────────────────────────────────────────
    /// First-order low-pass alpha for knob smoothing. Range: 0.0 (frozen) – 1.0 (passthrough).
    /// Default 0.35: lightly smooths ADC noise at 30 Hz (~4 frames to reach 95 % of a step)
    /// without feeling laggy. Clamped to [HW_KNOB_ALPHA_MIN, HW_KNOB_ALPHA_MAX] in hw_input.rs
    /// before use; adjust via hardware-bridge debug builds or future config file.
    pub hw_knob_alpha: f32,

    // ── Edge-contour mode (native-only) ───────────────────────────────────────
    /// Minimum Sobel gradient magnitude before a cell lights up. Default: 0.08.
    pub edge_threshold:    f32,
    /// Gradient magnitude → cell brightness scale. Default: 4.0.
    pub edge_gain:         f32,
    /// Extra gain added to edge_gain at full beat intensity. Default: 0.5.
    pub edge_beat_boost:   f32,
    /// Per-frame beat envelope added to edge_gain (maintained in main.rs, mirrors
    /// chroma_beat_current). Default: 0.0.
    pub edge_beat_current: f32,
    /// Cells with game luma below this become animation space ("negative space"). Default: 0.25.
    pub edge_dark_threshold: f32,
    /// Max intensity (0..1) of the dark/negative-space animation. The threshold picks where it
    /// starts; this scales how strong it gets at full darkness. Default: 0.6.
    pub edge_dark_level:     f32,

    // ── Full-screen glitch FX (native-only post-process) ───────────────────────
    /// Single 0..1 "glitchiness" control (shown as a percentage in the UI). Drives the three
    /// derived params below each tick in main.rs. Default: 0.05 (5%).
    pub glitch_fx_master: f32,
    /// Master displacement scale while a glitch burst is active (derived from glitch_fx_master).
    pub glitch_fx_intensity: f32,
    /// Per-30 Hz-tick probability of a random glitch burst. Default: 0.02.
    pub glitch_fx_chance:    f32,
    /// Burst envelope decay per tick (lower = shorter bursts). Default: 0.82.
    pub glitch_fx_decay:     f32,
    /// Runtime burst envelope, 0 = idle (maintained in main.rs). Default: 0.0.
    pub glitch_fx_env:       f32,
    /// Runtime random seed for the current burst's pattern (maintained in main.rs). Default: 0.0.
    pub glitch_fx_seed:      f32,

    // ── Bass-vibe layer (native-only) ─────────────────────────────────────────
    /// Smoothed bass level must exceed this to trigger vibe patches. Default: 0.45.
    pub bass_vibe_threshold:   f32,
    /// Minimum gap between vibe-patch bursts in ms (rate-limits punchy spawning). Default: 120.0.
    pub bass_vibe_cooldown_ms: f32,
    /// Maximum number of new patches spawned per burst. Default: 4.
    pub bass_vibe_patches:     usize,
    /// Patch lifetime in ticks (30 Hz; patches fade then vanish). Default: 6.0.
    pub bass_vibe_life:        f32,
    /// Minimum patch width/height in cells. Default: 2.
    pub bass_vibe_size_min:    usize,
    /// Maximum patch width/height in cells. Default: 6.
    pub bass_vibe_size_max:    usize,
    /// Block brightness scale applied to patch cells (1.0 = full). Default: 1.0.
    pub bass_vibe_brightness:  f32,
}

impl Default for Params {
    fn default() -> Self {
        Self {
            // Renderer
            phosphor_index: 2,           // green (PHOSPHOR_ORDER[2])
            scanline_intensity: 0.33,
            scanline_mode: 1,            // PIXEL
            chroma_base: 1.5,
            chroma_beat_current: 0.0,
            chroma_beat: 4.0,
            bg_enabled: true,
            bg_opacity: 0.55,
            glyph_tint: 1.0,

            // Layer enables
            fig_enabled: true,
            rain_enabled: true,
            wave_enabled: true,
            glitch_enabled: true,

            // Figure
            fig_decay: 0.007,
            fig_reseed_frames: 160,
            fig_brightness: 0.65,
            fig_smear: 0.025,
            fig_opacity: 1.0,

            // Rain
            rain_speed_min: 0.01,
            rain_speed_max: 0.2,
            rain_beat_mult: 8.2,
            rain_trail: 6,
            rain_interact: 0.50,
            rain_burn_boost: 0.20,
            rain_opacity: 0.5,

            // Wave
            wave_opacity: 0.66,
            wave_threshold: 0.60,
            wave_speed: 0.04,
            wave_beat_boost: 0.33,
            wave_beat_decay: 0.06,
            wave_thresh_drop: 0.18,
            wave_char_rate: 0.006,

            // Glitch
            glitch_threshold: 0.30,
            glitch_chance: 0.66,
            glitch_scatter: 0.045,
            glitch_tear: 0.020,
            glitch_seed_interval: 80,
            glitch_cga_enabled: true,
            glitch_decay_rate: 0.010,
            glitch_smear_chance: 0.33,
            glitch_drop_chance: 0.025,
            glitch_scatter_threshold: 0.20,
            glitch_blast_threshold: 0.40,
            glitch_treble_floor: 0.15,
            glitch_beat_seed_min: 12,
            glitch_intensity_scale: 1.5,

            // Hardware input (native-only)
            hw_knob_alpha: 0.35,

            // Calm-idle (native-only)
            idle_noise_floor: 0.06,
            activity_attack:  0.35,
            activity_release: 0.02,
            idle_active_gate: 0.15,
            idle_rain_floor:  0.04,
            idle_wave_dim:    0.20,

            // Edge mode (native-only)
            edge_threshold:    0.08,
            edge_gain:         4.0,
            edge_beat_boost:   0.5,
            edge_beat_current: 0.0,
            edge_dark_threshold: 0.25,
            edge_dark_level:     0.6,

            // Full-screen glitch FX (intensity/chance/decay are derived from the master each tick)
            glitch_fx_master:    0.05,
            glitch_fx_intensity: 0.15,
            glitch_fx_chance:    0.01,
            glitch_fx_decay:     0.524,
            glitch_fx_env:       0.0,
            glitch_fx_seed:      0.0,

            // Bass-vibe (native-only)
            bass_vibe_threshold:   0.45,
            bass_vibe_cooldown_ms: 120.0,
            bass_vibe_patches:     4,
            bass_vibe_life:        6.0,
            bass_vibe_size_min:    2,
            bass_vibe_size_max:    6,
            bass_vibe_brightness:  1.0,
        }
    }
}

pub const PHOSPHOR_ORDER: [&str; 5] = ["red", "amber", "green", "blue", "white"];

pub struct PhosphorPreset {
    pub dim: [f32; 3],
    pub mid: [f32; 3],
    pub bright: [f32; 3],
}

// Ordered to match PHOSPHOR_ORDER.
pub const PHOSPHORS: [PhosphorPreset; 5] = [
    PhosphorPreset { dim: [0.239, 0.000, 0.000], mid: [0.533, 0.000, 0.000], bright: [1.000, 0.133, 0.000] }, // red
    PhosphorPreset { dim: [0.333, 0.176, 0.000], mid: [0.784, 0.471, 0.000], bright: [1.000, 0.698, 0.000] }, // amber
    PhosphorPreset { dim: [0.000, 0.275, 0.059], mid: [0.000, 0.706, 0.157], bright: [0.000, 1.000, 0.255] }, // green
    PhosphorPreset { dim: [0.059, 0.157, 0.333], mid: [0.176, 0.412, 0.784], bright: [0.314, 0.667, 1.000] }, // blue
    PhosphorPreset { dim: [0.133, 0.133, 0.133], mid: [0.667, 0.667, 0.667], bright: [0.941, 0.941, 0.941] }, // white
];

// CGA 16-color palette (index 0 = black = "use phosphor"; 1–15 = real overrides).
pub const CGA_COLORS: [[f32; 3]; 16] = [
    [0.000, 0.000, 0.000],
    [0.000, 0.000, 0.667],
    [0.000, 0.667, 0.000],
    [0.000, 0.667, 0.667],
    [0.667, 0.000, 0.000],
    [0.667, 0.000, 0.667],
    [0.667, 0.333, 0.000],
    [0.667, 0.667, 0.667],
    [0.333, 0.333, 0.333],
    [0.333, 0.333, 1.000],
    [0.333, 1.000, 0.333],
    [0.333, 1.000, 1.000],
    [1.000, 0.333, 0.333],
    [1.000, 0.333, 1.000],
    [1.000, 1.000, 0.333],
    [1.000, 1.000, 1.000],
];

// ── Audio analysis constants (V2_CONFIG audio params) ───────────────────────

/// FFT frame size. Matches AnalyserNode fftSize = 1024 in v2/audio.js.
pub const FFT_SIZE: usize = 1024;
/// Output spectrum bin count = FFT_SIZE / 2.
pub const FFT_BINS: usize = FFT_SIZE / 2;
/// Smoothing coefficient applied to magnitudes before dB conversion.
/// Matches AnalyserNode.smoothingTimeConstant = 0.65.
pub const FFT_SMOOTHING: f32 = 0.65;
/// Beat threshold multiplier: beat fires when bass > avg * BEAT_THRESHOLD.
pub const BEAT_THRESHOLD: f32 = 1.25;
/// Rolling history window for beat detection (frames). Matches V2_CONFIG.BEAT_HISTORY.
pub const BEAT_HISTORY: usize = 43;
/// Minimum gap between beats in milliseconds. Matches V2_CONFIG.BEAT_COOLDOWN.
pub const BEAT_COOLDOWN_MS: f32 = 300.0;

// ── Hardware input constants ─────────────────────────────────────────────────

/// Valid range for `Params::hw_knob_alpha`. Clamped in `hw_input.rs` before use.
pub const HW_KNOB_ALPHA_MIN: f32 = 0.0;
pub const HW_KNOB_ALPHA_MAX: f32 = 1.0;

// ── Fusion constants (verbatim from V2_CONFIG) ───────────────────────────────

/// ASCII art stamp dimensions — must match AsciiArtLibrary frame dimensions.
pub const MORPH_WIDTH: usize = 40;
pub const MORPH_HEIGHT: usize = 20;

/// Katakana character pool for the rain and wave layers.
/// Built from V2_CONFIG.KATAKANA: U+30A0..=U+30FF (96 chars) then ASCII hex+symbol chars (25 chars).
pub const KATAKANA: &[char] = &[
    // U+30A0..=U+30FF — full katakana block (96 characters)
    '゠', 'ァ', 'ア', 'ィ', 'イ', 'ゥ', 'ウ', 'ェ', 'エ', 'ォ',
    'オ', 'カ', 'ガ', 'キ', 'ギ', 'ク', 'グ', 'ケ', 'ゲ', 'コ',
    'ゴ', 'サ', 'ザ', 'シ', 'ジ', 'ス', 'ズ', 'セ', 'ゼ', 'ソ',
    'ゾ', 'タ', 'ダ', 'チ', 'ヂ', 'ッ', 'ツ', 'ヅ', 'テ', 'デ',
    'ト', 'ド', 'ナ', 'ニ', 'ヌ', 'ネ', 'ノ', 'ハ', 'バ', 'パ',
    'ヒ', 'ビ', 'ピ', 'フ', 'ブ', 'プ', 'ヘ', 'ベ', 'ペ', 'ホ',
    'ボ', 'ポ', 'マ', 'ミ', 'ム', 'メ', 'モ', 'ャ', 'ヤ', 'ュ',
    'ユ', 'ョ', 'ヨ', 'ラ', 'リ', 'ル', 'レ', 'ロ', 'ヮ', 'ワ',
    'ヰ', 'ヱ', 'ヲ', 'ン', 'ヴ', 'ヵ', 'ヶ', 'ヷ', 'ヸ', 'ヹ',
    'ヺ', '・', 'ー', 'ヽ', 'ヾ', 'ヿ',
    // ASCII hex digits + symbols (25 characters)
    '0', '1', '2', '3', '4', '5', '6', '7', '8', '9',
    'A', 'B', 'C', 'D', 'E', 'F',
    'a', 'b', 'c', 'd', 'e', 'f',
    '|', '/', '\\',
];

/// Glitch layer character pool (V2FusionMode.GLI_CHARS static field).
pub const GLI_CHARS: &str = "!@#$%^&*[]{}|\\/<>?~`+=-_░▒▓█▄▀■□▪▫◘◙◄►▲▼◆◇○●αβγδλπφψΩΣ∂∇∆√∞∑≈≠≤≥±∈∅←↑↓→↔⇒";

// ── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    /// Spot-check every fusion knob default against v2/config.js V2_PARAMS.
    /// Any divergence here is a fidelity regression.
    #[test]
    fn params_defaults_match_js_reference() {
        let p = Params::default();

        // Renderer params
        assert_eq!(p.chroma_base,  1.5_f32,  "chromaBase");
        assert_eq!(p.chroma_beat,  4.0_f32,  "chromaBeat");
        assert_eq!(p.scanline_intensity, 0.33_f32, "scanlineIntensity");
        assert_eq!(p.scanline_mode, 1i32, "scanlineMode");
        assert!(p.bg_enabled, "bgEnabled");
        assert_eq!(p.bg_opacity, 0.55_f32, "bgOpacity");

        // Layer enables
        assert!(p.fig_enabled,   "figureEnabled");
        assert!(p.rain_enabled,  "rainEnabled");
        assert!(p.wave_enabled,  "waveEnabled");
        assert!(p.glitch_enabled, "glitchEnabled");

        // Figure layer
        assert_eq!(p.fig_decay,          0.007_f32, "figDecay");
        assert_eq!(p.fig_reseed_frames,  160u32,    "figReseedFrames");
        assert_eq!(p.fig_brightness,     0.65_f32,  "figBrightness");
        assert_eq!(p.fig_smear,          0.025_f32, "figSmear");
        assert_eq!(p.fig_opacity,        1.0_f32,   "figOpacity");

        // Rain layer
        assert_eq!(p.rain_speed_min,  0.01_f32,  "rainSpeedMin");
        assert_eq!(p.rain_speed_max,  0.2_f32,   "rainSpeedMax");
        assert_eq!(p.rain_beat_mult,  8.2_f32,   "rainBeatMult");
        assert_eq!(p.rain_trail,      6usize,    "rainTrail");
        assert_eq!(p.rain_interact,   0.50_f32,  "rainInteract");
        assert_eq!(p.rain_burn_boost, 0.20_f32,  "rainBurnBoost");
        assert_eq!(p.rain_opacity,    0.5_f32,   "rainOpacity");

        // Wave layer
        assert_eq!(p.wave_opacity,     0.66_f32, "waveOpacity");
        assert_eq!(p.wave_threshold,   0.60_f32, "waveThreshold");
        assert_eq!(p.wave_speed,       0.04_f32, "waveSpeed");
        assert_eq!(p.wave_beat_boost,  0.33_f32, "waveBeatBoost");
        assert_eq!(p.wave_beat_decay,  0.06_f32, "waveBeatDecay");
        assert_eq!(p.wave_thresh_drop, 0.18_f32, "waveThreshDrop");
        assert_eq!(p.wave_char_rate,   0.006_f32, "waveCharRate");

        // Glitch layer
        assert_eq!(p.glitch_threshold,        0.30_f32, "glitchThreshold");
        assert_eq!(p.glitch_chance,            0.66_f32, "glitchChance");
        assert_eq!(p.glitch_scatter,           0.045_f32, "glitchScatter");
        assert_eq!(p.glitch_tear,              0.020_f32, "glitchTear");
        assert_eq!(p.glitch_seed_interval,     80u32,   "glitchSeedInterval");
        assert!(p.glitch_cga_enabled, "glitchCgaEnabled");
        assert_eq!(p.glitch_decay_rate,        0.010_f32, "glitchDecayRate");
        assert_eq!(p.glitch_smear_chance,      0.33_f32,  "glitchSmearChance");
        assert_eq!(p.glitch_drop_chance,       0.025_f32, "glitchDropChance");
        assert_eq!(p.glitch_scatter_threshold, 0.20_f32,  "glitchScatterThreshold");
        assert_eq!(p.glitch_blast_threshold,   0.40_f32,  "glitchBlastThreshold");
        assert_eq!(p.glitch_treble_floor,      0.15_f32,  "glitchTrebleFloor");
        assert_eq!(p.glitch_beat_seed_min,     12u32,   "glitchBeatSeedMin");
        assert_eq!(p.glitch_intensity_scale,   1.5_f32,  "glitchIntensityScale");

        // Calm-idle activity envelope (native-only — no JS reference; guards against
        // a default being fat-fingered onto the wrong field during tuning).
        assert_eq!(p.idle_noise_floor, 0.06_f32, "idleNoiseFloor");
        assert_eq!(p.activity_attack,  0.35_f32, "activityAttack");
        assert_eq!(p.activity_release, 0.02_f32, "activityRelease");
        assert_eq!(p.idle_active_gate, 0.15_f32, "idleActiveGate");
        assert_eq!(p.idle_rain_floor,  0.04_f32, "idleRainFloor");
        assert_eq!(p.idle_wave_dim,    0.20_f32, "idleWaveDim");

        // Hardware input (native-only — no JS reference).
        assert_eq!(p.hw_knob_alpha, 0.35_f32, "hwKnobAlpha");

        // Bass-vibe layer (native-only — no JS reference).
        assert_eq!(p.bass_vibe_threshold,   0.45_f32,  "bassVibeThreshold");
        assert_eq!(p.bass_vibe_cooldown_ms, 120.0_f32, "bassVibeCooldownMs");
        assert_eq!(p.bass_vibe_patches,     4_usize,   "bassVibePatches");
        assert_eq!(p.bass_vibe_life,        6.0_f32,   "bassVibeLife");
        assert_eq!(p.bass_vibe_size_min,    2_usize,   "bassVibeSizeMin");
        assert_eq!(p.bass_vibe_size_max,    6_usize,   "bassVibeSizeMax");
        assert_eq!(p.bass_vibe_brightness,  1.0_f32,   "bassVibeBrightness");
    }

    /// KATAKANA must have exactly 121 entries: 96 katakana (U+30A0..=U+30FF) +
    /// 25 ASCII hex+symbol chars ("0123456789ABCDEFabcdef|/\\").
    /// JS reference: V2_CONFIG.KATAKANA (config.js lines 47-52).
    #[test]
    fn katakana_count_and_bounds_match_js_source() {
        assert_eq!(KATAKANA.len(), 121,
            "KATAKANA must have 121 entries (96 katakana block + 25 ASCII hex+symbols)");

        // First entry: U+30A0 (゠, Katakana-Hiragana Double Hyphen)
        assert_eq!(KATAKANA[0], '\u{30A0}',
            "KATAKANA[0] should be U+30A0 (゠)");

        // 96th entry (index 95): U+30FF (ヿ, last katakana in the block)
        assert_eq!(KATAKANA[95], '\u{30FF}',
            "KATAKANA[95] should be U+30FF (ヿ)");

        // Last entry: backslash (the last char in "0123456789ABCDEFabcdef|/\\")
        assert_eq!(*KATAKANA.last().unwrap(), '\\',
            "last KATAKANA entry should be backslash");

        // All entries should be unique (no duplicates across the two sources)
        let mut seen = std::collections::HashSet::new();
        for &ch in KATAKANA {
            assert!(seen.insert(ch),
                "duplicate char in KATAKANA: {:?} (U+{:04X})", ch, ch as u32);
        }
    }
}
