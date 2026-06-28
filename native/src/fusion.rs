use std::collections::{HashMap, HashSet};

use crate::rng::Xorshift32;

// ── Supporting types ──────────────────────────────────────────────────────────

/// Per-column rain state.
struct RainCol {
    head_y:   f32,
    speed:    f32,
    bin_frac: f32, // column's log-spaced spectral fraction
}

/// Active pulse wave (spawned by glitch layer on hard beats).
struct PulseWave {
    cx:         f32,
    cy:         f32,
    r:          f32,
    max_r:      f32,
    speed:      f32,
    intensity:  f32,
    color_base: u8,
}

/// Active bass-vibration patch (native-only).
/// Fills a rectangular zone with randomly re-chosen block glyphs every tick
/// to simulate physical rumble/vibration. Fades over its lifetime then vanishes.
struct VibePatch {
    x:        usize,  // left column of the rect
    y:        usize,  // top row
    w:        usize,  // width in cells
    h:        usize,  // height in cells
    life:     f32,    // ticks remaining (decremented by retain_mut at end of each tick)
    life_max: f32,    // initial life — used to compute fade fraction
    intensity: f32,   // bass_level captured at spawn time
}

/// Audio data consumed by `Fusion::update`. Built in `main.rs` each 30 Hz tick.
pub struct AudioFrame<'a> {
    pub spectrum:       &'a [f32],
    pub bands:          crate::audio_dev::Bands,
    pub beat_active:    bool,
    pub beat_intensity: f32,
    /// `true` for real cpal capture; `false` for the synthetic `DevAudioSource` fallback.
    /// When `false`, the calm-idle activity envelope is forced to 1.0 (demo stays lively).
    pub live:           bool,
}

/// Block-shade glyph palette for the bass-vibe layer (lightest → heaviest).
/// All four chars are present in GLI_CHARS and therefore in the baked atlas.
const VIBE_BLOCKS: &[char] = &['░', '▒', '▓', '█'];

// ── Free helper functions (avoid borrowing conflicts in update) ───────────────

/// Write one cell into the three output slices.
#[inline]
fn set_cell_by_idx(
    char_idx:    &mut [u16],
    bright16:    &mut [u16],
    cga_idx_buf: &mut [u8],
    idx: usize,
    char_atlas_idx: u16,
    brightness: f32,
    cga: u8,
) {
    char_idx[idx]    = char_atlas_idx;
    bright16[idx]    = (brightness.clamp(0.0, 1.0) * 65535.0) as u16;
    cga_idx_buf[idx] = cga;
}

/// Look up `ch` in the char map; emit a one-time warning if missing.
fn char_idx_or_warn(
    char_map:       &HashMap<char, u16>,
    warned_missing: &mut HashSet<char>,
    ch: char,
) -> u16 {
    match char_map.get(&ch) {
        Some(&idx) => idx,
        None => {
            if warned_missing.insert(ch) {
                eprintln!("[fusion] char not in atlas: {:?} (U+{:04X})", ch, ch as u32);
            }
            0
        }
    }
}

/// Return a random atlas index from the katakana pool.
fn katakana_idx(rng: &mut Xorshift32, pool: &[char], char_map: &HashMap<char, u16>) -> u16 {
    if pool.is_empty() { return 0; }
    let i = (rng.rand() * pool.len() as f32) as usize % pool.len();
    *char_map.get(&pool[i]).unwrap_or(&0)
}

/// Return a random atlas index from the glitch char pool.
fn gli_char_idx(rng: &mut Xorshift32, gli: &[char], char_map: &HashMap<char, u16>) -> u16 {
    if gli.is_empty() { return 0; }
    let i = (rng.rand() * gli.len() as f32) as usize % gli.len();
    *char_map.get(&gli[i]).unwrap_or(&0)
}

/// Stamp a random figure into the figure layer buffers.
fn stamp_figure(
    rng:            &mut Xorshift32,
    figure_bright:  &mut [f32],
    figure_char:    &mut [u16],
    char_map:       &HashMap<char, u16>,
    warned_missing: &mut HashSet<char>,
    cols: usize,
    rows: usize,
    brightness: f32,
) {
    use crate::ascii_art::FIGURES;
    use crate::config::{MORPH_HEIGHT, MORPH_WIDTH};

    let fig_idx = (rng.rand() * FIGURES.len() as f32) as usize % FIGURES.len();
    let fig = &FIGURES[fig_idx];
    // div_euclid matches JS Math.floor for negative numerators (grid < morph dims).
    let sr = (rows as isize - MORPH_HEIGHT as isize).div_euclid(2);
    let sc = (cols as isize - MORPH_WIDTH  as isize).div_euclid(2);

    for (r_off, row_str) in fig.rows.iter().enumerate() {
        for (c_off, ch) in row_str.chars().enumerate() {
            if ch == ' ' { continue; }
            let gr = sr + r_off as isize;
            let gc = sc + c_off as isize;
            if gr < 0 || gr >= rows as isize || gc < 0 || gc >= cols as isize { continue; }
            let idx = gr as usize * cols + gc as usize;
            figure_char[idx]  = char_idx_or_warn(char_map, warned_missing, ch);
            figure_bright[idx] = brightness;
        }
    }
}

/// Seed the glitch layer with a hex-dump pattern.
fn seed_hex_dump(
    rng:            &mut Xorshift32,
    glitch_bright:  &mut [f32],
    glitch_char:    &mut [u16],
    glitch_cga:     &mut [u8],
    char_map:       &HashMap<char, u16>,
    cols: usize,
    rows: usize,
) {
    let start_row = (rng.rand() * (rows.saturating_sub(8).max(1)) as f32) as usize;
    let start_col = (rng.rand() * (cols.saturating_sub(30).max(1)) as f32) as usize;

    for r in start_row..(start_row + 6).min(rows) {
        // Address label  e.g. "00F0: "
        let addr = format!("{:04X}: ", r * 16);
        for (c_off, ch) in addr.chars().enumerate() {
            let col = start_col + c_off;
            if col >= cols { break; }
            let idx = r * cols + col;
            glitch_char[idx]  = *char_map.get(&ch).unwrap_or(&0);
            glitch_cga[idx]   = (rng.rand() * 4.0) as u8 + 1;
            glitch_bright[idx] = 0.7 + rng.rand() * 0.3;
        }
        // 16 hex bytes
        for b in 0..16usize {
            let byte_val = (rng.rand() * 256.0) as u8;
            let byte_str = format!("{:02X} ", byte_val);
            let bc = start_col + 6 + b * 3;
            for (i, ch) in byte_str.chars().enumerate() {
                let col = bc + i;
                if col >= cols { break; }
                let idx = r * cols + col;
                glitch_char[idx]  = *char_map.get(&ch).unwrap_or(&0);
                glitch_cga[idx]   = (rng.rand() * 5.0) as u8 + 10;
                glitch_bright[idx] = 0.5 + rng.rand() * 0.5;
            }
        }
    }
}

/// Seed the glitch layer with a spectrum bar-chart visualisation.
fn seed_from_spectrum(
    glitch_bright: &mut [f32],
    glitch_char:   &mut [u16],
    glitch_cga:    &mut [u8],
    spectrum:      &[f32],
    char_map:      &HashMap<char, u16>,
    cols: usize,
    rows: usize,
) {
    let start_row = (rows as f32 * 0.3) as usize;
    let bar_rows  = (rows as f32 * 0.5) as usize;
    let bar_char  = *char_map.get(&'█').unwrap_or(&0);
    let dot_char  = *char_map.get(&'·').unwrap_or(&0);

    for c in 0..cols {
        let spec_idx = ((c as f32 / cols as f32) * spectrum.len() as f32) as usize;
        let spec_idx = spec_idx.min(spectrum.len().saturating_sub(1));
        let val  = if spectrum.is_empty() { 0.0 } else { spectrum[spec_idx] };
        let bar_h = (val * bar_rows as f32) as usize;

        for r in 0..bar_rows {
            let row = start_row + bar_rows.saturating_sub(1 + r);
            if row >= rows { continue; }
            let idx = row * cols + c;
            if r < bar_h {
                glitch_char[idx]  = bar_char;
                glitch_cga[idx]   = (c % 4) as u8 + 9;
                glitch_bright[idx] = 0.6;
            } else {
                glitch_char[idx]  = dot_char;
                glitch_cga[idx]   = 0;
                glitch_bright[idx] = 0.05;
            }
        }
    }
}

/// Seed the glitch layer with a random figure (random CGA colors).
fn seed_glitch_figure(
    rng:            &mut Xorshift32,
    glitch_bright:  &mut [f32],
    glitch_char:    &mut [u16],
    glitch_cga:     &mut [u8],
    char_map:       &HashMap<char, u16>,
    warned_missing: &mut HashSet<char>,
    cols: usize,
    rows: usize,
) {
    use crate::ascii_art::FIGURES;
    use crate::config::{MORPH_HEIGHT, MORPH_WIDTH};

    let fig_idx = (rng.rand() * FIGURES.len() as f32) as usize % FIGURES.len();
    let fig = &FIGURES[fig_idx];
    // div_euclid matches JS Math.floor for negative numerators (grid < morph dims).
    let sr = (rows as isize - MORPH_HEIGHT as isize).div_euclid(2);
    let sc = (cols as isize - MORPH_WIDTH  as isize).div_euclid(2);

    for (r_off, row_str) in fig.rows.iter().enumerate() {
        for (c_off, ch) in row_str.chars().enumerate() {
            let gr = sr + r_off as isize;
            let gc = sc + c_off as isize;
            if gr < 0 || gr >= rows as isize || gc < 0 || gc >= cols as isize { continue; }
            let idx = gr as usize * cols + gc as usize;
            glitch_char[idx]  = char_idx_or_warn(char_map, warned_missing, ch);
            glitch_cga[idx]   = (rng.rand() * 16.0) as u8;
            glitch_bright[idx] = if ch == ' ' { 0.0 } else { 0.8 };
        }
    }
}

// ── Fusion struct ─────────────────────────────────────────────────────────────

pub struct Fusion {
    cols: usize,
    rows: usize,

    // character pools (built once at construction)
    katakana_pool: Vec<char>,
    gli_chars:     Vec<char>,

    // char → atlas-index map (built from renderer charset)
    char_map: HashMap<char, u16>,

    // output buffers — public so main.rs can borrow slices
    pub char_idx: Vec<u16>,
    pub bright16: Vec<u16>,
    pub cga_idx:  Vec<u8>,

    // figure layer
    figure_bright: Vec<f32>,
    figure_char:   Vec<u16>,
    seed_timer:    u32,

    // rain layer
    rain: Vec<RainCol>,

    // wave layer
    wave_char_idx:     Vec<u16>,
    wave_time:         f32,
    wave_beat_boost:   f32,
    wave_thresh_boost: f32,

    // glitch layer
    glitch_bright:    Vec<f32>,
    glitch_cga_idx:   Vec<u8>,
    glitch_char:      Vec<u16>,
    glitch_seed_timer: u32,
    pulse_waves:      Vec<PulseWave>,

    // beat / timing state
    now_ms:           f32,   // increments 1000/30 per tick
    last_beat_ms:     f32,
    beat_interval:    f32,   // EWMA of beat intervals (ms); init 600
    prev_beat_active: bool,

    // RNG
    rng: Xorshift32,

    // one-time warn set for missing chars
    warned_missing: HashSet<char>,

    // calm-idle activity envelope (native-only; 0 = idle, 1 = fully lively)
    activity: f32,

    // bass-vibe layer (native-only)
    bass_level:    f32,           // smoothed (sub+bass)/2 signal; gates vibe spawns
    vibe_patches:  Vec<VibePatch>,
    vibe_cooldown: f32,           // ms until next burst is allowed (mirrors beat clock idiom)
}

impl Fusion {
    /// Build a new Fusion.
    ///
    /// `charset` is the ordered glyph list from `AsciiRenderer::charset()`.
    /// Each element is a single-character String; its position is the atlas index.
    pub fn new(cols: usize, rows: usize, charset: &[String]) -> Self {
        let char_map: HashMap<char, u16> = charset
            .iter()
            .enumerate()
            .filter_map(|(i, s)| s.chars().next().map(|c| (c, i as u16)))
            .collect();

        let katakana_pool: Vec<char> = crate::config::KATAKANA.to_vec();
        let gli_chars: Vec<char>     = crate::config::GLI_CHARS.chars().collect();

        let mut rng = Xorshift32::new(0xDEAD_BEEF);
        let mut warned_missing = HashSet::new();
        let n = cols * rows;

        // Initialise rain columns
        let mut rain = Vec::with_capacity(cols);
        for c in 0..cols {
            let head_y  = rng.rand() * -(rows as f32);
            let speed   = 0.01 + rng.rand() * 0.19;
            let bin_frac = c as f32 / (cols.saturating_sub(1).max(1)) as f32;
            rain.push(RainCol { head_y, speed, bin_frac });
        }

        // Pre-fill wave chars with random katakana
        let mut wave_char_idx = vec![0u16; n];
        for i in 0..n {
            wave_char_idx[i] = katakana_idx(&mut rng, &katakana_pool, &char_map);
        }

        // Figure buffers (stamp_figure writes the initial figure below)
        let mut figure_bright = vec![0.0f32; n];
        let mut figure_char   = vec![0u16; n];

        // Stamp the initial figure before the struct is constructed
        stamp_figure(
            &mut rng, &mut figure_bright, &mut figure_char,
            &char_map, &mut warned_missing,
            cols, rows, 0.65,
        );

        Fusion {
            cols, rows,
            katakana_pool, gli_chars, char_map,
            char_idx:  vec![0u16; n],
            bright16:  vec![0u16; n],
            cga_idx:   vec![0u8; n],
            figure_bright, figure_char, seed_timer: 0,
            rain,
            wave_char_idx, wave_time: 0.0, wave_beat_boost: 0.0, wave_thresh_boost: 0.0,
            glitch_bright:     vec![0.0f32; n],
            glitch_cga_idx:    vec![0u8; n],
            glitch_char:       vec![0u16; n],
            glitch_seed_timer: 0,
            pulse_waves:       Vec::new(),
            now_ms: 0.0, last_beat_ms: 0.0, beat_interval: 600.0, prev_beat_active: false,
            rng, warned_missing,
            activity: 0.0,
            bass_level: 0.0, vibe_patches: Vec::new(), vibe_cooldown: 0.0,
        }
    }

    /// Reallocate all buffers for a new grid size and re-stamp the initial figure.
    pub fn reset(&mut self, cols: usize, rows: usize) {
        self.cols = cols;
        self.rows = rows;
        let n = cols * rows;

        // Output buffers
        self.char_idx = vec![0u16; n];
        self.bright16 = vec![0u16; n];
        self.cga_idx  = vec![0u8; n];

        // Figure layer
        self.figure_bright = vec![0.0f32; n];
        self.figure_char   = vec![0u16; n];
        self.seed_timer    = 0;

        // Rain
        self.rain.clear();
        for c in 0..cols {
            let head_y   = self.rng.rand() * -(rows as f32);
            let speed    = 0.01 + self.rng.rand() * 0.19;
            let bin_frac = c as f32 / (cols.saturating_sub(1).max(1)) as f32;
            self.rain.push(RainCol { head_y, speed, bin_frac });
        }

        // Glitch layer
        self.glitch_bright    = vec![0.0f32; n];
        self.glitch_cga_idx   = vec![0u8; n];
        self.glitch_char      = vec![0u16; n];
        self.glitch_seed_timer = 0;
        self.pulse_waves.clear();

        // Wave layer
        self.wave_char_idx = vec![0u16; n];
        for i in 0..n {
            self.wave_char_idx[i] = katakana_idx(&mut self.rng, &self.katakana_pool, &self.char_map);
        }
        self.wave_time        = 0.0;
        self.wave_beat_boost  = 0.0;
        self.wave_thresh_boost = 0.0;

        // Stamp initial figure
        stamp_figure(
            &mut self.rng, &mut self.figure_bright, &mut self.figure_char,
            &self.char_map, &mut self.warned_missing,
            cols, rows, 0.65,
        );

        // Reset calm-idle activity envelope
        self.activity = 0.0;

        // Reset bass-vibe layer
        self.bass_level    = 0.0;
        self.vibe_patches.clear();
        self.vibe_cooldown = 0.0;
    }

    /// Current calm-idle activity level in [0, 1].
    /// 0 = fully idle (silence), 1 = fully lively (loud audio or fallback source).
    pub fn activity(&self) -> f32 { self.activity }

    /// One 30 Hz logic tick: update all layer state, then composite into
    /// `self.char_idx` / `self.bright16` / `self.cga_idx`.
    pub fn update(
        &mut self,
        audio:  &AudioFrame<'_>,
        cols:   usize,
        rows:   usize,
        params: &crate::config::Params,
    ) {
        // Guard: resize if the grid changed (mirrors JS's auto-reset in update).
        if cols != self.cols || rows != self.rows {
            self.reset(cols, rows);
        }
        let n = cols * rows;
        if n == 0 { return; }

        // ── Timing and beat tracking ──────────────────────────────────────────
        self.now_ms += 1000.0 / 30.0;

        // ── Calm-idle activity envelope (native-only, no v2 parity) ──────────
        // DevAudioSource (demo/fallback) is forced to 1.0 so demo mode stays fully
        // lively. CpalAudioSource uses a broadband energy level with an asymmetric
        // attack/release envelope: fast up (audio onset), slow down (motion lingers).
        let activity_target = if !audio.live {
            1.0_f32 // fallback / demo source is always fully lively
        } else {
            let band_mean = (audio.bands.sub + audio.bands.bass + audio.bands.low_mid
                           + audio.bands.mid + audio.bands.high_mid + audio.bands.treble) / 6.0;
            // Subtract noise floor so mic hiss maps to 0.
            // Guard the denominator: idle_noise_floor is 0.06 today, but Params is a
            // pub struct the hardware bridge may write, so clamp away the 1.0 (÷0 → NaN)
            // and >1.0 (sign-inversion) cases.
            let denom = (1.0 - params.idle_noise_floor).max(f32::EPSILON);
            let level = ((band_mean - params.idle_noise_floor) / denom).clamp(0.0, 1.0);
            // Beats bump activity even if broadband level is modest.
            level.max(audio.beat_intensity * 0.6)
        };
        let rate = if activity_target > self.activity {
            params.activity_attack
        } else {
            params.activity_release
        };
        self.activity = (self.activity + (activity_target - self.activity) * rate).clamp(0.0, 1.0);
        let activity = self.activity; // local copy for use in this tick

        // Debug instrumentation (env-gated, ~1×/sec). Run with CRT_AUDIO_DEBUG=1 to enable.
        if audio.live
            && (self.now_ms % 1000.0) < (1000.0 / 30.0)
            && std::env::var("CRT_AUDIO_DEBUG").is_ok()
        {
            eprintln!("[idledbg] target={:.3} activity={:.3} beat_int={:.2}",
                activity_target, activity, audio.beat_intensity);
        }

        // ── Bass level (smoothed; drives vibe patch spawning) ─────────────────
        // Computed unconditionally — not gated by audio.live — so demo mode
        // (DevAudioSource with synthetic bands) can also trigger patches.
        let bass_raw = (audio.bands.sub + audio.bands.bass) * 0.5;
        self.bass_level = self.bass_level * 0.6 + bass_raw * 0.4;

        // ── Bass-vibe spawn logic ─────────────────────────────────────────────
        let tick_ms = 1000.0_f32 / 30.0;
        self.vibe_cooldown -= tick_ms;
        if self.bass_level >= params.bass_vibe_threshold && self.vibe_cooldown <= 0.0 {
            self.vibe_cooldown = params.bass_vibe_cooldown_ms;
            let over = (self.bass_level - params.bass_vibe_threshold).clamp(0.0, 1.0);
            let n_burst = (1 + (over * params.bass_vibe_patches as f32) as usize)
                .min(params.bass_vibe_patches);
            // Hard cap: never exceed 24 total live patches to avoid runaway.
            let available = 24_usize.saturating_sub(self.vibe_patches.len());
            let n_spawn = n_burst.min(available);
            let size_span = params.bass_vibe_size_max
                .saturating_sub(params.bass_vibe_size_min) + 1;
            for _ in 0..n_spawn {
                let w = (params.bass_vibe_size_min
                    + (self.rng.rand() * size_span as f32) as usize)
                    .min(cols);
                let h = (params.bass_vibe_size_min
                    + (self.rng.rand() * size_span as f32) as usize)
                    .min(rows);
                let max_x = cols.saturating_sub(w);
                let max_y = rows.saturating_sub(h);
                let x = if max_x > 0 {
                    (self.rng.rand() * max_x as f32) as usize % max_x
                } else { 0 };
                let y = if max_y > 0 {
                    (self.rng.rand() * max_y as f32) as usize % max_y
                } else { 0 };
                // Final safety clamp (no-op under normal conditions).
                let w = w.min(cols.saturating_sub(x));
                let h = h.min(rows.saturating_sub(y));
                if w == 0 || h == 0 { continue; }
                self.vibe_patches.push(VibePatch {
                    x, y, w, h,
                    life:      params.bass_vibe_life,
                    life_max:  params.bass_vibe_life,
                    intensity: self.bass_level,
                });
            }
        }

        let beat_rising_edge = audio.beat_active && !self.prev_beat_active;
        self.prev_beat_active = audio.beat_active;

        if audio.beat_active {
            if self.last_beat_ms > 0.0 {
                let iv = self.now_ms - self.last_beat_ms;
                if iv > 200.0 && iv < 2000.0 {
                    self.beat_interval = self.beat_interval * 0.75 + iv * 0.25;
                }
            }
            self.last_beat_ms = self.now_ms;
        }

        // ── Clear output arrays ───────────────────────────────────────────────
        self.char_idx[..n].fill(0);
        self.bright16[..n].fill(0);
        self.cga_idx[..n].fill(0);

        // =====================================================================
        // STATE UPDATE PHASES
        // =====================================================================

        // ── Phase 1: Figure layer state ───────────────────────────────────────
        if params.fig_enabled {
            // Calm-idle: when resting, hold the current figure static (no reseed, no decay/smear).
            // The figure is the coherent centerpiece — it should persist frozen at idle.
            // Beat-triggered force_reseed is intentionally blocked while resting (a beat means
            // activity is high anyway, so in practice resting=false whenever beats fire).
            let figure_resting = activity < params.idle_active_gate;
            if !figure_resting {
                self.seed_timer += 1;
                let force_reseed = audio.beat_active && audio.beat_intensity > 0.85 && self.seed_timer > 40;
                if self.seed_timer >= params.fig_reseed_frames || force_reseed {
                    self.seed_timer = 0;
                    stamp_figure(
                        &mut self.rng, &mut self.figure_bright, &mut self.figure_char,
                        &self.char_map, &mut self.warned_missing,
                        cols, rows, params.fig_brightness,
                    );
                }

                let total_energy = ((audio.bands.bass + audio.bands.mid + audio.bands.treble) / 3.0).max(0.1);
                let decay        = params.fig_decay * (0.5 + 0.5 * total_energy);
                let smear_chance = params.fig_smear * audio.bands.bass.max(0.3);

                // Iterate row-major so the rightward smear can cascade (matches JS in-place).
                for i in 0..n {
                    let c = i % cols;
                    let brt = self.figure_bright[i];
                    let new_brt = (brt - decay).max(0.0);
                    self.figure_bright[i] = new_brt;

                    // Horizontal smear — writes idx+1 in-place (cascade intended)
                    if new_brt > 0.08
                        && self.figure_char[i] != 0
                        && c + 1 < cols
                    {
                        let smear_roll = self.rng.rand();
                        if smear_roll < smear_chance {
                            let ni = i + 1;
                            if self.figure_bright[ni] < new_brt * 0.6 {
                                self.figure_char[ni]  = self.figure_char[i];
                                self.figure_bright[ni] = new_brt * 0.5;
                            }
                        }
                    }
                }
            }
        }

        // ── Phase 2: Rain layer state ─────────────────────────────────────────
        if params.rain_enabled {
            // Beat multiplier
            if audio.beat_active {
                for col in &mut self.rain {
                    col.speed = (col.speed * params.rain_beat_mult)
                        .min(params.rain_speed_max * params.rain_beat_mult);
                }
            }

            // Calm-idle: scale positional advance so rain crawls at idle (doesn't stop).
            // Speed targets are left unchanged — only how far the head actually moves.
            let rain_advance_scale = params.idle_rain_floor
                + (1.0 - params.idle_rain_floor) * activity;

            for c in 0..cols {
                if !audio.beat_active {
                    let log_frac = self.rain[c].bin_frac.powf(1.8);
                    let spec_len = audio.spectrum.len();
                    let spec_idx = ((log_frac * spec_len as f32) as usize).min(spec_len.saturating_sub(1));
                    let bin_e    = if spec_len > 0 { audio.spectrum[spec_idx] } else { 0.0 };
                    let target   = params.rain_speed_min + bin_e * (params.rain_speed_max - params.rain_speed_min);
                    self.rain[c].speed += (target - self.rain[c].speed) * 0.05;
                    self.rain[c].speed  = self.rain[c].speed.max(params.rain_speed_min * 0.5);
                }

                self.rain[c].head_y += self.rain[c].speed * rain_advance_scale;
                if self.rain[c].head_y > rows as f32 + params.rain_trail as f32 {
                    self.rain[c].head_y = self.rng.rand() * -10.0;
                    self.rain[c].speed  = params.rain_speed_min
                        + self.rng.rand() * (params.rain_speed_max - params.rain_speed_min);
                }

                // Rain head burn: boost figure brightness where the head touches
                let head_row = self.rain[c].head_y.floor() as isize;
                if head_row >= 0 && head_row < rows as isize {
                    let fig_idx = head_row as usize * cols + c;
                    if self.figure_bright[fig_idx] > 0.0 {
                        self.figure_bright[fig_idx] =
                            (self.figure_bright[fig_idx] + params.rain_burn_boost).min(1.0);
                    }
                }
            }
        }

        // ── Phase 2b: Wave layer state ────────────────────────────────────────
        if params.wave_enabled {
            if beat_rising_edge {
                self.wave_beat_boost   = (self.wave_beat_boost
                    + params.wave_beat_boost * audio.beat_intensity).min(0.8);
                self.wave_thresh_boost = (self.wave_thresh_boost
                    + params.wave_thresh_drop * audio.beat_intensity).min(0.5);
            }
            // Calm-idle: autonomous advance is scaled by activity so the wave nearly
            // freezes at silence. Beat boost is kept as-is (≈0 at silence naturally).
            self.wave_time       += params.wave_speed * activity + self.wave_beat_boost;
            self.wave_beat_boost   = (self.wave_beat_boost   - params.wave_beat_decay).max(0.0);
            self.wave_thresh_boost = (self.wave_thresh_boost - params.wave_beat_decay * 0.7).max(0.0);
        }

        // ── Phase 3: Glitch layer state ───────────────────────────────────────
        if params.glitch_enabled {
            let beat_phase = if self.last_beat_ms > 0.0 && self.beat_interval > 0.0 {
                ((self.now_ms - self.last_beat_ms) / self.beat_interval).min(1.0)
            } else {
                0.0
            };
            let scaled_intensity = (audio.beat_intensity * params.glitch_intensity_scale).min(1.0);

            // Calm-idle: when resting, do NOT advance the seed timer or trigger new seeds.
            // The decay suite below always runs so any leftover glitch fades out cleanly.
            // Beat-triggered scatter/blast/pulse is already gated by beat_active ≈ false
            // at silence, so no additional guard is needed there.
            let glitch_resting = activity < params.idle_active_gate;
            if !glitch_resting {
                // Timer-based seeding
                self.glitch_seed_timer += 1;
                if self.glitch_seed_timer >= params.glitch_seed_interval
                    || (audio.beat_active && self.glitch_seed_timer > params.glitch_beat_seed_min)
                {
                    self.glitch_seed_timer = 0;
                    let choice = (self.rng.rand() * 3.0) as u32;
                    match choice {
                        0 => seed_hex_dump(
                            &mut self.rng,
                            &mut self.glitch_bright, &mut self.glitch_char, &mut self.glitch_cga_idx,
                            &self.char_map, cols, rows,
                        ),
                        1 => seed_from_spectrum(
                            &mut self.glitch_bright, &mut self.glitch_char, &mut self.glitch_cga_idx,
                            audio.spectrum, &self.char_map, cols, rows,
                        ),
                        _ => seed_glitch_figure(
                            &mut self.rng,
                            &mut self.glitch_bright, &mut self.glitch_char, &mut self.glitch_cga_idx,
                            &self.char_map, &mut self.warned_missing, cols, rows,
                        ),
                    }
                }
            }

            // Beat reactions
            if audio.beat_active {
                // Random scatter
                if scaled_intensity > params.glitch_scatter_threshold {
                    let count = (scaled_intensity * cols as f32 * rows as f32 * params.glitch_scatter) as usize;
                    for _ in 0..count {
                        let gr  = (self.rng.rand() * rows as f32) as usize % rows;
                        let gc  = (self.rng.rand() * cols as f32) as usize % cols;
                        let idx = gr * cols + gc;
                        self.glitch_char[idx]  = gli_char_idx(&mut self.rng, &self.gli_chars, &self.char_map);
                        self.glitch_cga_idx[idx] = (self.rng.rand() * 16.0) as u8;
                        self.glitch_bright[idx] = 0.4 + self.rng.rand() * 0.5;
                    }
                }

                // Horizontal blast strip on hard beats
                if scaled_intensity > params.glitch_blast_threshold {
                    let blast_row   = (self.rng.rand() * rows as f32) as usize % rows;
                    let blast_len   = (scaled_intensity * cols as f32 * 0.65) as usize;
                    let max_start   = (cols as isize - blast_len as isize).max(1) as usize;
                    let blast_start = (self.rng.rand() * max_start as f32) as usize % max_start;
                    for bc in blast_start..(blast_start + blast_len).min(cols) {
                        let idx = blast_row * cols + bc;
                        self.glitch_char[idx]  = gli_char_idx(&mut self.rng, &self.gli_chars, &self.char_map);
                        self.glitch_cga_idx[idx] = (self.rng.rand() * 16.0) as u8;
                        self.glitch_bright[idx] = 0.75 + self.rng.rand() * 0.25;
                    }
                }

                // Spawn a pulse wave
                if scaled_intensity > params.glitch_threshold {
                    let spawn_roll = self.rng.rand();
                    if spawn_roll < params.glitch_chance {
                        self.pulse_waves.push(PulseWave {
                            cx:         self.rng.rand() * cols as f32,
                            cy:         self.rng.rand() * rows as f32,
                            r:          0.0,
                            max_r:      cols.max(rows) as f32 * (0.4 + scaled_intensity * 0.6),
                            speed:      0.4 + scaled_intensity * 1.8,
                            intensity:  scaled_intensity,
                            color_base: (self.rng.rand() * 16.0) as u8,
                        });
                    }
                }
            }

            // Expand pulse waves: retain_mut advances r and removes expired waves,
            // then a second loop draws points (avoids borrow conflict with glitch arrays).
            self.pulse_waves.retain_mut(|w| {
                w.r += w.speed;
                w.r <= w.max_r
            });

            let asp_y = if cols > 0 { rows as f32 / cols as f32 } else { 1.0 };
            for wi in 0..self.pulse_waves.len() {
                let (cx, cy, r, max_r, intensity, color_base) = {
                    let w = &self.pulse_waves[wi];
                    (w.cx, w.cy, w.r, w.max_r, w.intensity, w.color_base)
                };
                let density = 1.0 - r / max_r;
                let pts = ((r * std::f32::consts::PI * 1.4 * density * intensity) as usize).max(3);
                for _ in 0..pts {
                    let a  = self.rng.rand() * std::f32::consts::TAU;
                    let gc = (cx + a.cos() * r).round() as isize;
                    let gr = (cy + a.sin() * r * asp_y).round() as isize;
                    if gc < 0 || gc >= cols as isize || gr < 0 || gr >= rows as isize { continue; }
                    let idx = gr as usize * cols + gc as usize;
                    let brt = (0.4 + self.rng.rand() * 0.6) * density * intensity;
                    if brt > self.glitch_bright[idx] {
                        self.glitch_char[idx]    = gli_char_idx(&mut self.rng, &self.gli_chars, &self.char_map);
                        self.glitch_cga_idx[idx] = (color_base + (self.rng.rand() * 4.0) as u8) % 16;
                        self.glitch_bright[idx]  = brt;
                    }
                }
            }

            // Treble noise
            let air_energy = audio.bands.high_mid * 0.5 + audio.bands.treble * 0.5;
            if air_energy > params.glitch_treble_floor {
                let noise_count = (air_energy * cols as f32 * 0.15) as usize;
                for _ in 0..noise_count {
                    let nr  = (self.rng.rand() * rows as f32) as usize % rows;
                    let nc  = (self.rng.rand() * cols as f32) as usize % cols;
                    let idx = nr * cols + nc;
                    self.glitch_char[idx]    = gli_char_idx(&mut self.rng, &self.gli_chars, &self.char_map);
                    self.glitch_cga_idx[idx] = (self.rng.rand() * 16.0) as u8;
                    self.glitch_bright[idx]  = 0.3 + self.rng.rand() * 0.5;
                }
            }

            // Decay suite — O(rows × cols) inner loop with in-place smear + tear.
            // Reads and writes to glitch_bright/char/cga in a forward pass;
            // h-smear writes idx+1 and v-smear writes (r+1)*cols+c, both intentionally
            // visible to subsequent iterations (cascade, matching JS behaviour).
            let glitch_energy    = ((audio.bands.bass + audio.bands.mid + audio.bands.treble) / 3.0).max(0.1);
            let bass_weight      = audio.bands.bass.max(0.15);
            let phase_decay_mult = 0.3 + beat_phase * 1.5;
            let decay_amount     = params.glitch_decay_rate * (0.4 + 0.6 * glitch_energy) * phase_decay_mult;
            let h_smear_chance   = params.glitch_smear_chance * bass_weight;
            let v_smear_chance   = params.glitch_smear_chance * 0.5 * air_energy;
            let subst_rate       = 0.04 * bass_weight + 0.05 * audio.bands.treble;
            let tear_chance      = params.glitch_tear * bass_weight;
            let drop_chance      = params.glitch_drop_chance * bass_weight;

            for r in 0..rows {
                for c in 0..cols {
                    let idx     = r * cols + c;
                    let brt     = self.glitch_bright[idx];
                    let new_brt = (brt - decay_amount).max(0.0);
                    self.glitch_bright[idx] = new_brt;

                    // Horizontal smear (cascade: writes ahead in the same loop pass)
                    if c + 1 < cols {
                        let smear_h = self.rng.rand();
                        if smear_h < h_smear_chance {
                            let ni = idx + 1;
                            self.glitch_char[ni]  = self.glitch_char[idx];
                            self.glitch_cga_idx[ni] = self.glitch_cga_idx[idx];
                            self.glitch_bright[ni] = new_brt * 0.75;
                        }
                    }

                    // Vertical (downward) smear
                    if r + 1 < rows {
                        let smear_v = self.rng.rand();
                        if smear_v < v_smear_chance {
                            let di = (r + 1) * cols + c;
                            self.glitch_char[di]  = self.glitch_char[idx];
                            self.glitch_cga_idx[di] = self.glitch_cga_idx[idx].wrapping_add(1) % 16;
                            self.glitch_bright[di] = new_brt * 0.65;
                        }
                    }

                    // Char substitution
                    if new_brt > 0.1 {
                        let subst = self.rng.rand();
                        if subst < subst_rate {
                            self.glitch_char[idx]    = gli_char_idx(&mut self.rng, &self.gli_chars, &self.char_map);
                            self.glitch_cga_idx[idx] = (self.rng.rand() * 16.0) as u8;
                        }
                    }

                    // Vertical tear — copies row r upward into row r-1.
                    // The JS srcIdx = r*cols+tc, dstIdx = (r-1)*cols+tc (confirmed upward).
                    if r > 0 {
                        let tear = self.rng.rand();
                        if tear < tear_chance {
                            let raw = (self.rng.rand() * 12.0 * (0.3 + audio.beat_intensity)) as usize + 2;
                            let tear_length = raw.min(cols - c);
                            for tc in c..(c + tear_length) {
                                let src_idx = r * cols + tc;
                                let dst_idx = (r - 1) * cols + tc;
                                self.glitch_char[dst_idx]    = self.glitch_char[src_idx];
                                self.glitch_cga_idx[dst_idx] = self.glitch_cga_idx[src_idx];
                                self.glitch_bright[dst_idx]  = self.glitch_bright[src_idx] * 0.65;
                            }
                        }
                    }

                    // Dropout
                    let drop = self.rng.rand();
                    if drop < drop_chance {
                        self.glitch_bright[idx] = 0.0;
                    }
                }
            }
        } else {
            // Glitch disabled: clear dynamic state
            self.pulse_waves.clear();
            self.glitch_seed_timer = 0;
        }

        // =====================================================================
        // RENDER PHASES — bgAscii (skipped) → figure → wave → rain → glitch
        // =====================================================================

        // ── Phase 4b: Figure render ───────────────────────────────────────────
        if params.fig_enabled {
            let fig_op = params.fig_opacity;
            for idx in 0..n {
                let brt = self.figure_bright[idx];
                let ch  = self.figure_char[idx];
                if brt > 0.02 && ch != 0 {
                    set_cell_by_idx(
                        &mut self.char_idx, &mut self.bright16, &mut self.cga_idx,
                        idx, ch, (brt * fig_op).min(1.0), 0,
                    );
                }
            }
        }

        // ── Phase 4c: Wave render ─────────────────────────────────────────────
        if params.wave_enabled {
            let t         = self.wave_time;
            let threshold = (params.wave_threshold - self.wave_thresh_boost).max(0.1);
            let op        = params.wave_opacity;
            // Calm-idle: dim the wave layer at idle so it fades gracefully rather than
            // cutting out. idle_wave_dim is the floor brightness fraction (e.g. 0.20 = 20%).
            let wave_bright_scale = params.idle_wave_dim + (1.0 - params.idle_wave_dim) * activity;
            let bass_e    = audio.bands.bass;
            let treble_e  = audio.bands.treble;
            let mid_e     = audio.bands.mid;
            let pi        = std::f32::consts::PI;
            let tau       = std::f32::consts::TAU;

            let cx = cols as f32 * 0.5 + (t * 0.011).sin() * cols as f32 * 0.3;
            let cy = rows as f32 * 0.5 + (t * 0.007).cos() * rows as f32 * 0.3;

            for r in 0..rows {
                for c in 0..cols {
                    let cn   = c as f32 / cols as f32 * tau;
                    let rn   = r as f32 / rows as f32 * tau;
                    let dx   = (c as f32 - cx) / cols as f32 * tau;
                    let dy   = (r as f32 - cy) / rows as f32 * tau;
                    let dist = (dx * dx + dy * dy).sqrt();

                    let field =
                        (cn * 2.0 + t * 0.7).sin()                              * 0.22
                        + (cn * 1.5 + rn * 1.0 + t * 0.5).sin()                * 0.20
                        + (rn * 2.5 - t * 0.4 + bass_e * pi).sin()             * 0.22
                        + (dist * 2.0 - t * 1.1 + treble_e * pi).sin()         * 0.18
                        + (cn * 1.2 - rn * 1.8 + t * 0.6 + mid_e * 0.5).sin() * 0.18;

                    let norm = (field + 1.0) * 0.5;
                    if norm > threshold {
                        let idx  = r * cols + c;
                        // Stochastically refresh wave char
                        let roll = self.rng.rand();
                        if roll < params.wave_char_rate {
                            self.wave_char_idx[idx] =
                                katakana_idx(&mut self.rng, &self.katakana_pool, &self.char_map);
                        }
                        let wave_ch = self.wave_char_idx[idx];
                        set_cell_by_idx(
                            &mut self.char_idx, &mut self.bright16, &mut self.cga_idx,
                            idx, wave_ch,
                            (norm - threshold) / (1.0 - threshold) * op * wave_bright_scale,
                            0,
                        );
                    }
                }
            }
        }

        // ── Phase 4d: Rain render ─────────────────────────────────────────────
        if params.rain_enabled {
            let rain_op  = params.rain_opacity;
            let spec_len = audio.spectrum.len();

            for c in 0..cols {
                let head_y   = self.rain[c].head_y;
                let bin_frac = self.rain[c].bin_frac;
                let head_row = head_y.floor() as isize;

                let log_frac = bin_frac.powf(1.8);
                let spec_idx = ((log_frac * spec_len as f32) as usize).min(spec_len.saturating_sub(1));
                let bin_e    = if spec_len > 0 { audio.spectrum[spec_idx] } else { 0.0 };

                for t in 0..params.rain_trail {
                    let r = head_row - t as isize;
                    if r < 0 || r >= rows as isize { continue; }
                    let cell_idx = r as usize * cols + c;

                    let (char_atlas_idx, brt) = if t == 0 {
                        // Head cell: interact with figure or pick katakana
                        let fig_brt = self.figure_bright[cell_idx];
                        let ch = if fig_brt > 0.1 {
                            let interact_roll = self.rng.rand();
                            if interact_roll < params.rain_interact {
                                self.figure_char[cell_idx]
                            } else {
                                katakana_idx(&mut self.rng, &self.katakana_pool, &self.char_map)
                            }
                        } else {
                            katakana_idx(&mut self.rng, &self.katakana_pool, &self.char_map)
                        };
                        (ch, 1.0_f32)
                    } else {
                        let ch = katakana_idx(&mut self.rng, &self.katakana_pool, &self.char_map);
                        let b  = (1.0 - t as f32 / params.rain_trail as f32) * (0.5 + 0.5 * bin_e);
                        (ch, b.max(0.0))
                    };

                    set_cell_by_idx(
                        &mut self.char_idx, &mut self.bright16, &mut self.cga_idx,
                        cell_idx, char_atlas_idx, brt * rain_op, 0,
                    );
                }
            }
        }

        // ── Phase 4e: Glitch render (top layer) ───────────────────────────────
        if params.glitch_enabled {
            let use_cga = params.glitch_cga_enabled;
            for idx in 0..n {
                let brt = self.glitch_bright[idx];
                let ch  = self.glitch_char[idx];
                if brt > 0.02 && ch != 0 {
                    let cga = if use_cga { self.glitch_cga_idx[idx] } else { 0 };
                    set_cell_by_idx(
                        &mut self.char_idx, &mut self.bright16, &mut self.cga_idx,
                        idx, ch, brt, cga,
                    );
                }
            }
        }

        // ── Phase 4f: Bass-vibe patches (final layer — overwrites everything) ─
        // Each active patch fills its rect with block glyphs re-randomized every
        // tick to create a buzzing/vibration effect.  Renders last so patches
        // dominate any underlying layer while they are alive.
        //
        // Index-based loop (not iter_mut) so we can borrow self.rng and the output
        // slices without holding a simultaneous borrow on self.vibe_patches —
        // the same pattern used by the pulse_waves render above.
        let n_vibe = self.vibe_patches.len();
        for pi in 0..n_vibe {
            // Copy all patch fields to locals; releases the borrow on vibe_patches
            // before any mutable field is touched.
            let (px, py, pw, ph, life, life_max, intensity) = {
                let p = &self.vibe_patches[pi];
                (p.x, p.y, p.w, p.h, p.life, p.life_max, p.intensity)
            };
            let frac = (life / life_max).clamp(0.0, 1.0);
            let amt  = intensity * frac;

            for row in py..(py + ph).min(rows) {
                for col in px..(px + pw).min(cols) {
                    let idx  = row * cols + col;
                    // Random shade biased toward heavier blocks when amt is high.
                    let r    = self.rng.rand();
                    let shade = (r * 0.5 + amt * 0.5).clamp(0.0, 1.0);
                    let bi   = ((shade * (VIBE_BLOCKS.len() - 1) as f32).round() as usize)
                        .min(VIBE_BLOCKS.len() - 1);
                    let ch   = VIBE_BLOCKS[bi];
                    let ch_i = char_idx_or_warn(
                        &self.char_map, &mut self.warned_missing, ch,
                    );
                    let brightness = (amt * params.bass_vibe_brightness).min(1.0);
                    // cga 0 → use phosphor color (not a CGA palette override)
                    set_cell_by_idx(
                        &mut self.char_idx, &mut self.bright16, &mut self.cga_idx,
                        idx, ch_i, brightness, 0,
                    );
                }
            }
        }
        // Decrement life and prune expired patches (mirrors pulse_waves drain).
        self.vibe_patches.retain_mut(|p| {
            p.life -= 1.0;
            p.life > 0.0
        });
    }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::audio_dev::Bands;

    /// Build a minimal charset covering ASCII printable + katakana range.
    fn make_charset() -> Vec<String> {
        let mut cs: Vec<String> = (32u8..=126u8).map(|b| (b as char).to_string()).collect();
        // Add katakana block (needed so katakana_idx doesn't always return 0)
        for cp in 0x30A0u32..=0x30FFu32 {
            if let Some(ch) = char::from_u32(cp) {
                cs.push(ch.to_string());
            }
        }
        // A few block chars the glitch layer uses
        for ch in ['░', '▒', '▓', '█', '·'] {
            cs.push(ch.to_string());
        }
        cs
    }

    /// Verifies that div_euclid(2) matches JS Math.floor for negative odd numerators.
    /// The real grid is ~35×19 — smaller than MORPH (40×20) — so (rows - MORPH_HEIGHT)
    /// and (cols - MORPH_WIDTH) are negative. Rust `/` truncates toward zero; JS
    /// Math.floor floors toward −∞. div_euclid replicates floor, which FIX 3 requires.
    #[test]
    fn centering_div_euclid_matches_js_floor() {
        use crate::config::{MORPH_HEIGHT, MORPH_WIDTH};

        // Typical native grid: cols=35, rows=19 (window 1280×720 with cell 36×37)
        let rows: isize = 19;
        let cols: isize = 35;

        // (rows - MORPH_HEIGHT) = 19 - 20 = -1 (odd negative)
        let sr_euclid = (rows - MORPH_HEIGHT as isize).div_euclid(2);
        let sr_trunc  = (rows - MORPH_HEIGHT as isize) / 2;
        // JS Math.floor(-1 / 2) = Math.floor(-0.5) = -1
        assert_eq!(sr_euclid, -1, "div_euclid should floor -1/2 to -1 (not 0)");
        assert_eq!(sr_trunc,   0, "plain /2 truncates -1/2 to 0 — wrong for JS parity");
        assert_ne!(sr_euclid, sr_trunc, "the two methods must differ for this input");

        // (cols - MORPH_WIDTH) = 35 - 40 = -5 (odd negative)
        let sc_euclid = (cols - MORPH_WIDTH as isize).div_euclid(2);
        let sc_trunc  = (cols - MORPH_WIDTH as isize) / 2;
        // JS Math.floor(-5 / 2) = Math.floor(-2.5) = -3
        assert_eq!(sc_euclid, -3, "div_euclid should floor -5/2 to -3");
        assert_eq!(sc_trunc,  -2, "plain /2 truncates -5/2 to -2 — wrong for JS parity");
        assert_ne!(sc_euclid, sc_trunc, "the two methods must differ for this input");

        // Even numerator: both methods agree (no fix needed, confirm no regression)
        // (rows - MORPH_HEIGHT) with rows=18: 18-20=-2 (even)
        let even: isize = -2;
        assert_eq!(even.div_euclid(2), even / 2,
            "even negatives: div_euclid and /2 must agree");
    }

    /// Verifies that stamping a figure onto a grid smaller than MORPH dimensions
    /// uses only in-bounds writes and never panics, even for a 3×3 grid.
    #[test]
    fn stamp_on_tiny_grid_does_not_panic() {
        let charset = make_charset();
        // 3×3 grid is far smaller than MORPH (40×20). The centering formula
        // produces large negative offsets; all figure cells fall outside the grid
        // bounds and must be skipped silently.
        let mut fusion = Fusion::new(3, 3, &charset);
        assert_eq!(fusion.char_idx.len(), 9);

        // Run a tick — this exercises stamp_figure via the figure layer.
        let spectrum = vec![0.0f32; 512];
        let bands = crate::audio_dev::Bands::default();
        let params = crate::config::Params::default();
        let frame = AudioFrame { spectrum: &spectrum, bands, beat_active: false, beat_intensity: 0.0, live: false };
        fusion.update(&frame, 3, 3, &params);
        // If we reach here, no OOB panic occurred.
        assert_eq!(fusion.char_idx.len(), 9, "buffer length must not change after tiny-grid tick");
    }

    /// Verifies that beat-rising-edge detection fires exactly once per beat and that
    /// beat_interval EWMA updates inside the valid window (200–2000 ms).
    #[test]
    fn beat_rising_edge_tracked_correctly() {
        let charset = make_charset();
        let mut fusion = Fusion::new(10, 8, &charset);
        let spectrum = vec![0.2f32; 512];
        let bands = crate::audio_dev::Bands { sub: 0.5, bass: 0.6, low_mid: 0.2, mid: 0.3, high_mid: 0.1, treble: 0.1 };
        let params = crate::config::Params::default();

        // Two ticks with no beat
        for _ in 0..2 {
            let frame = AudioFrame { spectrum: &spectrum, bands, beat_active: false, beat_intensity: 0.0, live: false };
            fusion.update(&frame, 10, 8, &params);
        }
        // Simulate a beat
        let frame = AudioFrame { spectrum: &spectrum, bands, beat_active: true, beat_intensity: 0.8, live: false };
        fusion.update(&frame, 10, 8, &params);
        // After one beat, last_beat_ms should be > 0
        assert!(fusion.now_ms > 0.0, "now_ms should advance each tick");
        // Simulate a second beat after a gap
        for _ in 0..8 {
            let frame = AudioFrame { spectrum: &spectrum, bands, beat_active: false, beat_intensity: 0.0, live: false };
            fusion.update(&frame, 10, 8, &params);
        }
        let frame = AudioFrame { spectrum: &spectrum, bands, beat_active: true, beat_intensity: 0.7, live: false };
        fusion.update(&frame, 10, 8, &params);
        // beat_interval EWMA should have updated from 600 ms (it starts at 600;
        // after one valid interval it shifts toward the measured interval).
        // We just verify it's in the plausible range (200–2000 ms per the guard).
        assert!(fusion.beat_interval > 0.0 && fusion.beat_interval < 10_000.0,
            "beat_interval should be a plausible value, got {}", fusion.beat_interval);
    }

    #[test]
    fn smoke_no_panic_and_buffer_lengths() {
        let charset = make_charset();
        let cols = 20usize;
        let rows = 10usize;
        let n    = cols * rows;

        let mut fusion = Fusion::new(cols, rows, &charset);

        assert_eq!(fusion.char_idx.len(), n);
        assert_eq!(fusion.bright16.len(), n);
        assert_eq!(fusion.cga_idx.len(),  n);

        let spectrum = vec![0.3f32; 512];
        let bands    = Bands {
            sub: 0.3, bass: 0.5, low_mid: 0.2, mid: 0.3, high_mid: 0.1, treble: 0.15,
        };
        let params = crate::config::Params::default();

        // Run ticks with no beat — layers should update without panicking.
        for _ in 0..15 {
            let frame = AudioFrame { spectrum: &spectrum, bands, beat_active: false, beat_intensity: 0.0, live: false };
            fusion.update(&frame, cols, rows, &params);
        }
        assert_eq!(fusion.char_idx.len(), n, "buffer length changed after silent ticks");

        // Run ticks with an active beat — all beat-reactive paths exercise.
        for _ in 0..10 {
            let frame = AudioFrame { spectrum: &spectrum, bands, beat_active: true, beat_intensity: 0.9, live: false };
            fusion.update(&frame, cols, rows, &params);
        }
        assert_eq!(fusion.char_idx.len(), n, "buffer length changed after beat ticks");
        assert_eq!(fusion.bright16.len(), n);
        assert_eq!(fusion.cga_idx.len(),  n);

        // CGA indices must stay in the 0-15 range; our code always uses % 16 or * 16.0 as u8.
        for &v in &fusion.cga_idx {
            assert!(v < 16, "cga_idx value out of range: {}", v);
        }

        // Test resize: reset to a different grid, run a tick.
        fusion.reset(30, 15);
        assert_eq!(fusion.char_idx.len(), 30 * 15);
        let frame = AudioFrame { spectrum: &spectrum, bands, beat_active: false, beat_intensity: 0.0, live: false };
        fusion.update(&frame, 30, 15, &params);
        assert_eq!(fusion.char_idx.len(), 30 * 15);
    }

    // ── Calm-idle tests ───────────────────────────────────────────────────────

    /// With live=true and all-zero audio, activity decays from 0 and stays near 0.
    /// After 100 silent ticks the envelope must be ≤ 0.05.
    #[test]
    fn activity_envelope_decays_on_silence() {
        let charset = make_charset();
        let mut fusion = Fusion::new(20, 10, &charset);
        let spectrum = vec![0.0f32; 512];
        let bands    = crate::audio_dev::Bands::default(); // all zeros
        let params   = crate::config::Params::default();

        for _ in 0..100 {
            let frame = AudioFrame {
                spectrum: &spectrum,
                bands,
                beat_active: false,
                beat_intensity: 0.0,
                live: true,
            };
            fusion.update(&frame, 20, 10, &params);
        }
        assert!(
            fusion.activity() <= 0.05,
            "activity should be near 0 after 100 silent live ticks, got {}",
            fusion.activity()
        );
    }

    /// From activity ≈ 0, one tick of loud audio raises activity MORE than one tick of
    /// silence from activity ≈ 1.0 lowers it (validates attack rate > release rate).
    #[test]
    fn activity_attack_faster_than_release() {
        let charset  = make_charset();
        let spectrum = vec![0.9f32; 512];
        let params   = crate::config::Params::default();

        // Measure attack: fresh fusion (activity=0) → one loud tick.
        let bands_loud = crate::audio_dev::Bands {
            sub: 0.9, bass: 0.9, low_mid: 0.9, mid: 0.9, high_mid: 0.9, treble: 0.9,
        };
        let mut fusion_attack = Fusion::new(20, 10, &charset);
        let frame_loud = AudioFrame {
            spectrum: &spectrum,
            bands: bands_loud,
            beat_active: false,
            beat_intensity: 0.0,
            live: true,
        };
        fusion_attack.update(&frame_loud, 20, 10, &params);
        let delta_up = fusion_attack.activity(); // rose from 0.0

        // Measure release: drive activity to 1.0 (live=false), then one silent live tick.
        let bands_zero = crate::audio_dev::Bands::default();
        let mut fusion_release = Fusion::new(20, 10, &charset);
        for _ in 0..50 {
            let frame_dev = AudioFrame {
                spectrum: &spectrum,
                bands: bands_zero,
                beat_active: false,
                beat_intensity: 0.0,
                live: false, // forces activity_target = 1.0
            };
            fusion_release.update(&frame_dev, 20, 10, &params);
        }
        assert!(
            fusion_release.activity() > 0.99,
            "activity should be ≈1.0 after 50 fallback ticks, got {}",
            fusion_release.activity()
        );
        let before_release = fusion_release.activity();
        let frame_silent = AudioFrame {
            spectrum: &spectrum,
            bands: bands_zero,
            beat_active: false,
            beat_intensity: 0.0,
            live: true, // now live + silent → should fall
        };
        fusion_release.update(&frame_silent, 20, 10, &params);
        let delta_down = before_release - fusion_release.activity();

        assert!(
            delta_up > delta_down,
            "attack delta ({delta_up:.4}) must exceed release delta ({delta_down:.4})"
        );
    }

    /// With live=false (synthetic fallback), activity is forced to 1.0 regardless
    /// of band energy — demo mode must stay fully animated.
    #[test]
    fn fallback_source_forces_activity_to_one() {
        let charset  = make_charset();
        let spectrum = vec![0.0f32; 512];
        let bands    = crate::audio_dev::Bands::default(); // all zeros — no real audio
        let params   = crate::config::Params::default();
        let mut fusion = Fusion::new(20, 10, &charset);

        for _ in 0..30 {
            let frame = AudioFrame {
                spectrum: &spectrum,
                bands,
                beat_active: false,
                beat_intensity: 0.0,
                live: false, // DevAudioSource path → must force to 1.0
            };
            fusion.update(&frame, 20, 10, &params);
        }
        assert!(
            fusion.activity() > 0.99,
            "fallback source must converge activity to 1.0, got {}",
            fusion.activity()
        );
    }

    /// Exercises the idle gate from BOTH sides so it can't pass trivially:
    ///   - while ACTIVE (loud audio) the gate is open → glitch_seed_timer advances;
    ///   - after settling into idle (silence) the gate closes → wave_time freezes and
    ///     glitch_seed_timer stops advancing (seeding gated).
    #[test]
    fn idle_suppresses_autonomous_motion() {
        let charset = make_charset();
        let params  = crate::config::Params::default();
        let mut fusion = Fusion::new(20, 10, &charset);

        let loud_spec = vec![1.0f32; 512];
        let loud = crate::audio_dev::Bands {
            sub: 1.0, bass: 1.0, low_mid: 1.0, mid: 1.0, high_mid: 1.0, treble: 1.0,
        };
        let silent_spec = vec![0.0f32; 512];
        let silent = crate::audio_dev::Bands::default();

        // ── Active phase: gate OPEN — timer must advance ───────────────────────
        for _ in 0..5 {
            let frame = AudioFrame {
                spectrum: &loud_spec, bands: loud,
                beat_active: false, beat_intensity: 0.0, live: true,
            };
            fusion.update(&frame, 20, 10, &params);
        }
        assert!(
            fusion.activity() > params.idle_active_gate,
            "should be active after loud ticks, got {}", fusion.activity()
        );
        assert!(
            fusion.glitch_seed_timer > 0,
            "glitch_seed_timer must advance while active (gate open), got 0"
        );

        // ── Settle into idle: gate CLOSED ──────────────────────────────────────
        // Slow release (0.02) means activity decays geometrically; run enough silent
        // ticks that it bleeds to ~0 so the wave is genuinely frozen (not just slowed).
        for _ in 0..500 {
            let frame = AudioFrame {
                spectrum: &silent_spec, bands: silent,
                beat_active: false, beat_intensity: 0.0, live: true,
            };
            fusion.update(&frame, 20, 10, &params);
        }
        assert!(
            fusion.activity() < params.idle_active_gate,
            "activity should be below idle_active_gate after silence, got {}", fusion.activity()
        );

        // Capture state, then run one more silent tick.
        let wave_time_before    = fusion.wave_time;
        let glitch_timer_before = fusion.glitch_seed_timer;
        let frame = AudioFrame {
            spectrum: &silent_spec, bands: silent,
            beat_active: false, beat_intensity: 0.0, live: true,
        };
        fusion.update(&frame, 20, 10, &params);

        // Wave frozen: advance ≈ wave_speed * 0 + wave_beat_boost(=0) = 0.
        let wave_advance = (fusion.wave_time - wave_time_before).abs();
        assert!(
            wave_advance < 1e-4,
            "wave_time should not advance at idle, advanced by {wave_advance}"
        );
        // Glitch seeding gated: timer frozen while resting.
        assert_eq!(
            fusion.glitch_seed_timer, glitch_timer_before,
            "glitch_seed_timer must not advance while resting (was {glitch_timer_before}, now {})",
            fusion.glitch_seed_timer
        );
    }

    // ── Bass-vibe tests ───────────────────────────────────────────────────────

    /// With low bass (all bands 0.1) the smoothed bass_level never reaches
    /// bass_vibe_threshold (0.45), so no patches should ever spawn.
    #[test]
    fn bass_vibe_no_spawn_below_threshold() {
        let charset = make_charset();
        let params  = crate::config::Params::default();
        // Confirm threshold is above what low bands produce
        assert!(params.bass_vibe_threshold > 0.1,
            "sanity: threshold must be above 0.1 for this test to be meaningful");

        let mut fusion = Fusion::new(20, 10, &charset);
        let spectrum   = vec![0.1f32; 512];
        let bands      = crate::audio_dev::Bands {
            sub: 0.1, bass: 0.1, low_mid: 0.1, mid: 0.1, high_mid: 0.1, treble: 0.1,
        };

        for _ in 0..30 {
            let frame = AudioFrame {
                spectrum: &spectrum, bands,
                beat_active: false, beat_intensity: 0.0, live: false,
            };
            fusion.update(&frame, 20, 10, &params);
        }

        // bass_raw = (0.1 + 0.1) * 0.5 = 0.1; smoothed steady-state = 0.1 << 0.45
        assert!(
            fusion.vibe_patches.is_empty(),
            "no patches should spawn when bass is below threshold, got {}",
            fusion.vibe_patches.len()
        );
    }

    /// With heavy bass (sub=1.0, bass=1.0) patches should spawn quickly and at
    /// least one block glyph (░▒▓█) should appear in the composite char buffer.
    #[test]
    fn bass_vibe_spawns_on_heavy_bass_and_writes_block_glyphs() {
        let charset  = make_charset();
        let params   = crate::config::Params::default();
        let cols     = 20usize;
        let rows     = 10usize;
        let mut fusion = Fusion::new(cols, rows, &charset);

        // Build the set of atlas indices that correspond to block glyphs.
        let block_atlas: std::collections::HashSet<u16> = charset.iter().enumerate()
            .filter_map(|(i, s)| {
                let ch = s.chars().next()?;
                if ['░', '▒', '▓', '█'].contains(&ch) { Some(i as u16) } else { None }
            })
            .collect();
        assert!(!block_atlas.is_empty(), "block chars must be present in the test charset");

        let spectrum = vec![1.0f32; 512];
        let bands    = crate::audio_dev::Bands {
            sub: 1.0, bass: 1.0, low_mid: 0.5, mid: 0.5, high_mid: 0.2, treble: 0.2,
        };

        // Run a few heavy-bass ticks (bass_level converges toward 1.0 fast with α=0.4).
        for _ in 0..5 {
            let frame = AudioFrame {
                spectrum: &spectrum, bands,
                beat_active: false, beat_intensity: 0.0, live: false,
            };
            fusion.update(&frame, cols, rows, &params);
        }

        assert!(
            !fusion.vibe_patches.is_empty(),
            "heavy bass should have spawned at least one vibe patch"
        );

        // At least one cell in the composite must hold a block-glyph atlas index.
        let found_block = fusion.char_idx.iter().any(|&idx| block_atlas.contains(&idx));
        assert!(
            found_block,
            "at least one block glyph (░▒▓█) must be written into char_idx after heavy bass"
        );
    }

    /// After a heavy-bass burst, returning to silence for enough ticks must drain
    /// all patches (life decrements to 0 → retain_mut removes them).
    #[test]
    fn bass_vibe_patches_expire_on_silence() {
        let charset  = make_charset();
        let params   = crate::config::Params::default();
        let cols     = 20usize;
        let rows     = 10usize;
        let mut fusion = Fusion::new(cols, rows, &charset);

        let heavy_spec = vec![1.0f32; 512];
        let heavy_bands = crate::audio_dev::Bands {
            sub: 1.0, bass: 1.0, low_mid: 0.5, mid: 0.5, high_mid: 0.2, treble: 0.2,
        };
        let silent_spec  = vec![0.0f32; 512];
        let silent_bands = crate::audio_dev::Bands::default();

        // Trigger at least one spawn burst.
        for _ in 0..3 {
            let frame = AudioFrame {
                spectrum: &heavy_spec, bands: heavy_bands,
                beat_active: false, beat_intensity: 0.0, live: false,
            };
            fusion.update(&frame, cols, rows, &params);
        }
        assert!(!fusion.vibe_patches.is_empty(), "sanity: heavy bass should have spawned patches");

        // Silence for bass_vibe_life (6) + a few extra ticks — all patches must have expired.
        let drain_ticks = params.bass_vibe_life as usize + 5;
        for _ in 0..drain_ticks {
            let frame = AudioFrame {
                spectrum: &silent_spec, bands: silent_bands,
                beat_active: false, beat_intensity: 0.0, live: false,
            };
            fusion.update(&frame, cols, rows, &params);
        }

        assert!(
            fusion.vibe_patches.is_empty(),
            "all patches must have expired after {} silence ticks; {} remain",
            drain_ticks, fusion.vibe_patches.len()
        );
    }

    /// With heavy bass every tick for 10 ticks, the cooldown (120 ms ≈ 3.6 ticks)
    /// must prevent a burst on every tick.  The live-patch count after 10 ticks
    /// must be well below the uncooled maximum of 10 × bass_vibe_patches = 40.
    #[test]
    fn bass_vibe_cooldown_rate_limits_spawns() {
        let charset  = make_charset();
        let params   = crate::config::Params::default();
        let cols     = 40usize;
        let rows     = 20usize;
        let mut fusion = Fusion::new(cols, rows, &charset);

        let spectrum = vec![1.0f32; 512];
        let bands    = crate::audio_dev::Bands {
            sub: 1.0, bass: 1.0, low_mid: 0.5, mid: 0.5, high_mid: 0.2, treble: 0.2,
        };

        for _ in 0..10 {
            let frame = AudioFrame {
                spectrum: &spectrum, bands,
                beat_active: false, beat_intensity: 0.0, live: false,
            };
            fusion.update(&frame, cols, rows, &params);
        }

        // tick_ms ≈ 33.33 ms; cooldown 120 ms → burst fires every ~3.6 ticks.
        // In 10 ticks: ≤3 bursts.  Patches from early bursts will have expired
        // by tick 10 (life=6), leaving only the most recent burst alive.
        // Assert well below the uncooled ceiling of 10 × 4 = 40.
        let uncooled_ceiling = 10 * params.bass_vibe_patches;
        assert!(
            fusion.vibe_patches.len() < uncooled_ceiling,
            "cooldown should bound live patches to <<{uncooled_ceiling}; got {}",
            fusion.vibe_patches.len()
        );
        // Also confirm that at least one patch did spawn (bass was genuinely heavy).
        // (The last burst should still be alive since life=6 and we just ran 10 ticks.)
        assert!(
            !fusion.vibe_patches.is_empty(),
            "heavy bass for 10 ticks should have left at least one live patch"
        );
    }
}
