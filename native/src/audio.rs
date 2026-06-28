use std::sync::{Arc, Mutex};
use std::collections::VecDeque;
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};

use crate::config::{FFT_SIZE, FFT_BINS, FFT_SMOOTHING, BEAT_THRESHOLD, BEAT_HISTORY, BEAT_COOLDOWN_MS};

// ── Public trait ──────────────────────────────────────────────────────────────

/// Uniform interface over audio analysis sources (cpal capture or synthetic fallback).
///
/// The five methods mirror the five accessors on `DevAudioSource` and are called by the
/// main-thread 30 Hz tick in `main.rs`.  Dispatch is via vtable through `Box<dyn AudioSource>`;
/// the overhead is ~6 virtual calls per tick (negligible at 30 Hz).
pub trait AudioSource {
    /// Advance one 30 Hz frame: drain ring → FFT → bands → beat (or advance the synthetic clock).
    fn update(&mut self);
    /// Normalized spectrum bins in [0, 1], length `FFT_BINS`.
    fn spectrum(&self) -> &[f32];
    /// Six log-spaced energy bands consumed by `fusion.rs`.
    fn bands(&self) -> crate::audio_dev::Bands;
    /// True on the frame a beat is detected; false on all other frames.
    fn beat_active(&self) -> bool;
    /// Decaying beat intensity in [0, 1].
    fn beat_intensity(&self) -> f32;
    /// Returns `true` for real cpal capture, `false` for the synthetic `DevAudioSource` fallback.
    /// Used by `fusion.rs` to decide whether to apply the calm-idle activity envelope.
    fn is_live(&self) -> bool;
}

// ── pub(crate) helpers — testable without a cpal device ──────────────────────

/// Average of `spectrum[start..end]`. Returns 0.0 for empty or out-of-bounds ranges.
/// Mirrors `avgBins` in v2/audio.js.
pub(crate) fn avg_bins(spectrum: &[f32], start: usize, end: usize) -> f32 {
    if end <= start { return 0.0; }
    let end = end.min(spectrum.len());
    if end <= start { return 0.0; }
    spectrum[start..end].iter().sum::<f32>() / (end - start) as f32
}

/// Compute six frequency bands from a normalized spectrum slice.
/// Bin-edge fractions mirror `_computeBands` in v2/audio.js (lines 367–375).
///
/// With `FFT_BINS = 512`:
///   sub:     [0,   10)   bins  0.. 10
///   bass:    [10,  25)   bins 10.. 25
///   low_mid: [25,  51)   bins 25.. 51
///   mid:     [51, 102)   bins 51..102
///   high_mid:[102,230)   bins 102..230
///   treble:  [230,512)   bins 230..512
pub(crate) fn compute_bands_fn(spectrum: &[f32]) -> crate::audio_dev::Bands {
    let bins = spectrum.len();
    crate::audio_dev::Bands {
        sub:      avg_bins(spectrum, 0,                              (bins as f32 * 0.02) as usize),
        bass:     avg_bins(spectrum, (bins as f32 * 0.02) as usize, (bins as f32 * 0.05) as usize),
        low_mid:  avg_bins(spectrum, (bins as f32 * 0.05) as usize, (bins as f32 * 0.10) as usize),
        mid:      avg_bins(spectrum, (bins as f32 * 0.10) as usize, (bins as f32 * 0.20) as usize),
        high_mid: avg_bins(spectrum, (bins as f32 * 0.20) as usize, (bins as f32 * 0.45) as usize),
        treble:   avg_bins(spectrum, (bins as f32 * 0.45) as usize, bins),
    }
}

/// Pre-compute a Blackman window of length `n`.
/// Formula: w[i] = 0.42 - 0.5·cos(2π·i/(N-1)) + 0.08·cos(4π·i/(N-1))
/// Standard property: w[0] ≈ 0, w[N/2] ≈ 1, values in [0, 1], symmetric.
pub(crate) fn blackman_window(n: usize) -> Vec<f32> {
    (0..n)
        .map(|i| {
            let x = 2.0 * std::f32::consts::PI * i as f32 / (n as f32 - 1.0);
            // Clamp to [0, 1]: f32 rounding can push w[0] just below 0.0
            // (0.42 - 0.5 + 0.08 = 0.0 exactly in theory, -1.5e-8 in f32).
            (0.42 - 0.5 * x.cos() + 0.08 * (2.0 * x).cos()).clamp(0.0, 1.0)
        })
        .collect()
}

/// One step of the energy beat detector. Mirrors `_detectBeat` in v2/audio.js (lines 384–406).
///
/// Parameters:
///   `bass`         — current bass band value [0, 1]
///   `bass_history` — circular 43-frame bass history
///   `hist_idx`     — write head into `bass_history`
///   `now_ms`       — current time in ms (incremented 1000/30 per tick by the caller)
///   `last_beat_ms` — time of the previous beat (mutated on detection)
///   `prev_intensity` — beat_intensity from the previous frame (used for decay)
///
/// Returns `(beat_active, new_beat_intensity)`.
pub(crate) fn beat_step(
    bass: f32,
    bass_history: &mut [f32; BEAT_HISTORY],
    hist_idx: &mut usize,
    now_ms: f32,
    last_beat_ms: &mut f32,
    prev_intensity: f32,
) -> (bool, f32) {
    bass_history[*hist_idx] = bass;
    *hist_idx = (*hist_idx + 1) % BEAT_HISTORY;

    let avg = bass_history.iter().sum::<f32>() / BEAT_HISTORY as f32;
    let threshold = avg * BEAT_THRESHOLD;
    let cooldown_ok = (now_ms - *last_beat_ms) > BEAT_COOLDOWN_MS;

    if bass > threshold && bass > 0.2 && cooldown_ok {
        *last_beat_ms = now_ms;
        let intensity = (bass / threshold.max(0.01)).min(1.0);
        (true, intensity)
    } else {
        (false, prev_intensity * 0.9)
    }
}

// ── CpalAudioSource ───────────────────────────────────────────────────────────

/// Captures audio from the system default input device via cpal, runs a rustfft
/// analysis pipeline, and delivers the same `AudioFrame` seam that `fusion.rs` consumes.
///
/// The cpal callback runs on a realtime OS thread (WASAPI on Windows).  It pushes mono
/// f32 samples into a bounded `VecDeque` ring via `try_lock()` — samples are silently
/// dropped on lock contention or ring overflow (acceptable at 30 Hz visualization rate).
///
/// `update()` (main thread, 30 Hz) drains the ring, maintains a rolling 1024-sample
/// window, runs the FFT, smooths magnitudes, converts to normalized dB, and computes
/// bands + beat.
///
/// The `_stream` field owns the `cpal::Stream`; dropping it stops capture.
pub struct CpalAudioSource {
    // Capture side
    ring:         Arc<Mutex<VecDeque<f32>>>,
    _stream:      cpal::Stream,
    _sample_rate: u32,

    // Rolling sample window (trimmed to FFT_SIZE)
    sample_buf:   Vec<f32>,

    // FFT pipeline state
    window_fn:    Vec<f32>,
    smooth_mag:   Vec<f32>,
    fft_plan:     Arc<dyn rustfft::Fft<f32>>,
    fft_input:    Vec<rustfft::num_complex::Complex<f32>>,
    fft_scratch:  Vec<rustfft::num_complex::Complex<f32>>,

    // Analysis outputs (updated each update() call)
    spectrum:       Vec<f32>,
    bands:          crate::audio_dev::Bands,
    beat_active:    bool,
    beat_intensity: f32,

    // Beat detector state
    bass_history: [f32; BEAT_HISTORY],
    hist_idx:     usize,
    now_ms:       f32,
    last_beat_ms: f32,
}

impl CpalAudioSource {
    /// Try to open cpal's system default audio input.
    ///
    /// Uses `host.default_input_device()` only — no device enumeration, no CLI flag.
    /// Device selection for ALSA / Pi is deferred to Phase 5.
    ///
    /// Returns `Err(String)` if no default device is available or the stream fails to open.
    pub fn try_new() -> Result<Self, String> {
        let host = cpal::default_host();
        let device = host
            .default_input_device()
            .ok_or_else(|| "no default input device available".to_string())?;
        eprintln!("[audio] using default input: {}", device.name().unwrap_or_default());

        let supported = device
            .default_input_config()
            .map_err(|e| format!("default_input_config: {e}"))?;
        let sample_rate = supported.sample_rate().0;
        let channels    = supported.channels() as usize;

        // Pre-allocate to the eviction bound so the realtime callback's push_back
        // never reallocates (heap alloc on the audio thread is forbidden).
        let ring: Arc<Mutex<VecDeque<f32>>> =
            Arc::new(Mutex::new(VecDeque::with_capacity(16_384)));

        let stream = build_input_stream(&device, &supported, ring.clone(), channels)?;
        stream.play().map_err(|e| format!("stream.play: {e}"))?;

        let window_fn = blackman_window(FFT_SIZE);
        let mut planner = rustfft::FftPlanner::<f32>::new();
        let fft_plan    = planner.plan_fft_forward(FFT_SIZE);
        // process_with_scratch is in-place — use the in-place scratch length.
        let scratch_len = fft_plan.get_inplace_scratch_len();
        let zero = rustfft::num_complex::Complex::new(0.0_f32, 0.0_f32);

        Ok(Self {
            ring,
            _stream:      stream,
            _sample_rate: sample_rate,
            sample_buf:   Vec::with_capacity(FFT_SIZE),
            window_fn,
            smooth_mag:   vec![0.0_f32; FFT_BINS],
            fft_plan,
            fft_input:    vec![zero; FFT_SIZE],
            fft_scratch:  vec![zero; scratch_len],
            spectrum:     vec![0.0_f32; FFT_BINS],
            bands:        crate::audio_dev::Bands::default(),
            beat_active:    false,
            beat_intensity: 0.0,
            bass_history: [0.0_f32; BEAT_HISTORY],
            hist_idx:     0,
            now_ms:       0.0,
            last_beat_ms: 0.0,
        })
    }

    fn compute_bands(&mut self) {
        self.bands = compute_bands_fn(&self.spectrum);
    }

    fn detect_beat(&mut self) {
        let (active, intensity) = beat_step(
            self.bands.bass,
            &mut self.bass_history,
            &mut self.hist_idx,
            self.now_ms,
            &mut self.last_beat_ms,
            self.beat_intensity,
        );
        self.beat_active    = active;
        self.beat_intensity = intensity;
    }
}

impl AudioSource for CpalAudioSource {
    fn update(&mut self) {
        self.now_ms += 1000.0 / 30.0;

        // 1. Drain ring buffer into the rolling sample window.
        if let Ok(mut ring) = self.ring.try_lock() {
            while let Some(s) = ring.pop_front() {
                self.sample_buf.push(s);
            }
        }
        // Trim to last FFT_SIZE samples.
        if self.sample_buf.len() > FFT_SIZE {
            let excess = self.sample_buf.len() - FFT_SIZE;
            self.sample_buf.drain(0..excess);
        }
        // Debug instrumentation (env-gated, ~1×/sec). Run with CRT_AUDIO_DEBUG=1 to enable.
        let audio_dbg = (self.now_ms % 1000.0) < (1000.0 / 30.0)
            && std::env::var("CRT_AUDIO_DEBUG").is_ok();

        // Not enough data yet — all outputs stay at zero.
        if self.sample_buf.len() < FFT_SIZE {
            if audio_dbg {
                eprintln!("[audiodbg] WARMUP buf={}/{} — if this never grows, no samples are being captured",
                    self.sample_buf.len(), FFT_SIZE);
            }
            return;
        }

        // 2. Apply Blackman window → fill fft_input.
        for i in 0..FFT_SIZE {
            let windowed = self.sample_buf[i] * self.window_fn[i];
            self.fft_input[i] = rustfft::num_complex::Complex::new(windowed, 0.0);
        }

        // 3. In-place forward FFT.
        self.fft_plan.process_with_scratch(&mut self.fft_input, &mut self.fft_scratch);

        // 4. Smooth magnitudes (Web Audio smoothingTimeConstant = 0.65) → dB → normalize.
        //    Mirrors the AnalyserNode pipeline in v2/audio.js.
        //    dB range: minDecibels = -90, maxDecibels = -10 → (dB + 90) / 80.
        for i in 0..FFT_BINS {
            let re  = self.fft_input[i].re;
            let im  = self.fft_input[i].im;
            // rustfft is unnormalized; divide by FFT_SIZE to match the Web Audio
            // AnalyserNode magnitude scale that v2/audio.js's dB mapping assumes.
            // Without this the magnitudes are ~N× too large (~+54 dB) and nearly
            // every bin saturates to 1.0 after the (dB + 90) / 80 mapping.
            let mag = (re * re + im * im).sqrt() / FFT_SIZE as f32;
            self.smooth_mag[i] = FFT_SMOOTHING * self.smooth_mag[i]
                + (1.0 - FFT_SMOOTHING) * mag;
            let db = 20.0 * self.smooth_mag[i].max(1e-10_f32).log10();
            self.spectrum[i] = ((db + 90.0) / 80.0).clamp(0.0, 1.0);
        }

        // 5. Compute bands and detect beat.
        self.compute_bands();
        self.detect_beat();

        if audio_dbg {
            let spec_max  = self.spectrum.iter().copied().fold(0.0_f32, f32::max);
            let spec_mean = self.spectrum.iter().sum::<f32>() / self.spectrum.len() as f32;
            let b = &self.bands;
            eprintln!(
                "[audiodbg] buf={} spec_max={:.3} spec_mean={:.3} | sub={:.2} bass={:.2} lmid={:.2} mid={:.2} hmid={:.2} treb={:.2} | beat={} ({:.2})",
                self.sample_buf.len(), spec_max, spec_mean,
                b.sub, b.bass, b.low_mid, b.mid, b.high_mid, b.treble,
                self.beat_active, self.beat_intensity,
            );
        }
    }

    fn spectrum(&self) -> &[f32]                { &self.spectrum }
    fn bands(&self) -> crate::audio_dev::Bands  { self.bands }
    fn beat_active(&self) -> bool               { self.beat_active }
    fn beat_intensity(&self) -> f32             { self.beat_intensity }
    fn is_live(&self) -> bool                   { true }
}

// ── Silent (blank) source ───────────────────────────────────────────────────────

/// A do-nothing source: zeroed spectrum/bands, never beats. Reports `is_live() == true`
/// so the calm-idle envelope settles the visualizer into its resting state (held figure +
/// faint drift) rather than the forced-lively demo. Used when no audio device is available,
/// so a capture failure looks visibly "silent" instead of masquerading as a working demo.
pub struct SilentAudioSource {
    spectrum: Vec<f32>,
    bands:    crate::audio_dev::Bands,
}

impl SilentAudioSource {
    pub fn new() -> Self {
        Self { spectrum: vec![0.0_f32; FFT_BINS], bands: crate::audio_dev::Bands::default() }
    }
}

impl Default for SilentAudioSource {
    fn default() -> Self { Self::new() }
}

impl AudioSource for SilentAudioSource {
    fn update(&mut self)                        {}
    fn spectrum(&self) -> &[f32]                { &self.spectrum }
    fn bands(&self) -> crate::audio_dev::Bands  { self.bands }
    fn beat_active(&self) -> bool               { false }
    fn beat_intensity(&self) -> f32             { 0.0 }
    fn is_live(&self) -> bool                   { true }
}

// ── Factory ───────────────────────────────────────────────────────────────────

/// Build the audio source:
/// - `demo == true` (`--demo-mode`): skip the audio device entirely and run the synthetic
///   `DevAudioSource` — animates regardless of any audio input.
/// - otherwise: open the default cpal input. If none is available or the stream fails, fall
///   back to a `SilentAudioSource` so the visualizer shows its idle (silent) state — NOT the
///   demo — making a capture failure visually obvious while troubleshooting input.
///
/// Callers hold `Box<dyn AudioSource>` and call `update()` once per 30 Hz tick.
pub fn new_source(demo: bool) -> Box<dyn AudioSource> {
    if demo {
        eprintln!("[audio] --demo-mode: synthetic source active (audio input ignored)");
        return Box::new(crate::audio_dev::DevAudioSource::new(FFT_BINS));
    }
    match CpalAudioSource::try_new() {
        Ok(src) => {
            eprintln!("[audio] cpal source active");
            Box::new(src)
        }
        Err(e) => {
            eprintln!("[audio] cpal init failed: {e}; no audio input — showing idle (silent) state");
            Box::new(SilentAudioSource::new())
        }
    }
}

// ── cpal stream builder ───────────────────────────────────────────────────────

/// Push one mono sample into the ring; silently drops the oldest if the ring exceeds 16 384.
/// Called from the cpal callback (realtime thread).  `try_lock()` is used — drops the sample
/// entirely if the main thread is holding the lock (acceptable for 30 Hz visualization).
fn push_to_ring(ring: &Arc<Mutex<VecDeque<f32>>>, sample: f32) {
    if let Ok(mut g) = ring.try_lock() {
        g.push_back(sample);
        if g.len() > 16_384 {
            g.pop_front();
        }
    }
}

/// Build a cpal input stream, converting all sample formats to f32 and mixing to mono.
///
/// Handles `F32`, `I16`, `U16`; returns `Err` for other formats (e.g. `F64`).
/// Conversion:
///   I16 → f32 : `s as f32 / i16::MAX as f32`
///   U16 → f32 : `s as f32 / u16::MAX as f32 * 2.0 - 1.0`
///   F32       : pass-through
fn build_input_stream(
    device:   &cpal::Device,
    config:   &cpal::SupportedStreamConfig,
    ring:     Arc<Mutex<VecDeque<f32>>>,
    channels: usize,
) -> Result<cpal::Stream, String> {
    use cpal::SampleFormat;

    let stream_cfg: cpal::StreamConfig = config.clone().into();
    let ch = channels.max(1);
    // Runs on the realtime audio thread — must not block. eprintln! takes the stderr
    // lock and can stall, so swallow here; proper error surfacing is deferred to Phase 5.
    let err_fn = |_err: cpal::StreamError| {};

    let stream = match config.sample_format() {
        SampleFormat::F32 => {
            let r = ring.clone();
            device.build_input_stream(
                &stream_cfg,
                move |data: &[f32], _: &cpal::InputCallbackInfo| {
                    for chunk in data.chunks(ch) {
                        let mono = chunk.iter().sum::<f32>() / ch as f32;
                        push_to_ring(&r, mono);
                    }
                },
                err_fn,
                None,
            )
        }
        SampleFormat::I16 => {
            let r = ring.clone();
            device.build_input_stream(
                &stream_cfg,
                move |data: &[i16], _: &cpal::InputCallbackInfo| {
                    for chunk in data.chunks(ch) {
                        let mono = chunk.iter()
                            .map(|&s| s as f32 / i16::MAX as f32)
                            .sum::<f32>() / ch as f32;
                        push_to_ring(&r, mono);
                    }
                },
                err_fn,
                None,
            )
        }
        SampleFormat::U16 => {
            let r = ring.clone();
            device.build_input_stream(
                &stream_cfg,
                move |data: &[u16], _: &cpal::InputCallbackInfo| {
                    for chunk in data.chunks(ch) {
                        let mono = chunk.iter()
                            .map(|&s| s as f32 / u16::MAX as f32 * 2.0 - 1.0)
                            .sum::<f32>() / ch as f32;
                        push_to_ring(&r, mono);
                    }
                },
                err_fn,
                None,
            )
        }
        fmt => return Err(format!("unsupported sample format: {fmt:?}")),
    }
    .map_err(|e| format!("build_input_stream: {e}"))?;

    Ok(stream)
}

// ── Unit tests ────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    /// The blank fallback source outputs nothing but reports `is_live() == true`, so the
    /// calm-idle envelope drives the resting state instead of the forced-lively demo path.
    #[test]
    fn silent_source_is_zeroed_and_live() {
        let mut s = SilentAudioSource::new();
        s.update();
        assert_eq!(s.spectrum().len(), FFT_BINS);
        assert!(s.spectrum().iter().all(|&v| v == 0.0), "spectrum must be all zeros");
        let b = s.bands();
        assert_eq!([b.sub, b.bass, b.low_mid, b.mid, b.high_mid, b.treble], [0.0; 6]);
        assert!(!s.beat_active() && s.beat_intensity() == 0.0, "must never beat");
        assert!(s.is_live(), "must report live so calm-idle (not demo) handles the silence");
    }

    /// Validates the band bin-edge math matches the JS reference (_computeBands, audio.js 367–375).
    /// Sets exactly one bin per band to 1.0; asserts the average equals 1/band_width.
    #[test]
    fn analysis_band_averages_match_known_spectrum() {
        let bins  = FFT_BINS; // 512
        let mut spectrum = vec![0.0_f32; bins];

        // Compute the exact integer bin edges used by compute_bands_fn.
        let sub_end:      usize = (bins as f32 * 0.02) as usize; //  10
        let bass_start:   usize = sub_end;
        let bass_end:     usize = (bins as f32 * 0.05) as usize; //  25
        let lm_start:     usize = bass_end;
        let lm_end:       usize = (bins as f32 * 0.10) as usize; //  51
        let mid_start:    usize = lm_end;
        let mid_end:      usize = (bins as f32 * 0.20) as usize; // 102
        let hm_start:     usize = mid_end;
        let hm_end:       usize = (bins as f32 * 0.45) as usize; // 230
        let treble_start: usize = hm_end;

        // Place exactly one 1.0 in each band region.
        spectrum[0]            = 1.0; // sub
        spectrum[bass_start]   = 1.0; // bass
        spectrum[lm_start]     = 1.0; // low_mid
        spectrum[mid_start]    = 1.0; // mid
        spectrum[hm_start]     = 1.0; // high_mid
        spectrum[treble_start] = 1.0; // treble

        let bands = compute_bands_fn(&spectrum);
        let eps = 1e-5_f32;

        let expected_sub    = 1.0 / sub_end as f32;
        let expected_bass   = 1.0 / (bass_end   - bass_start)   as f32;
        let expected_lm     = 1.0 / (lm_end     - lm_start)     as f32;
        let expected_mid    = 1.0 / (mid_end     - mid_start)    as f32;
        let expected_hm     = 1.0 / (hm_end      - hm_start)    as f32;
        let expected_treble = 1.0 / (bins        - treble_start) as f32;

        assert!((bands.sub      - expected_sub).abs()    < eps, "sub:      got {}, want {}", bands.sub,      expected_sub);
        assert!((bands.bass     - expected_bass).abs()   < eps, "bass:     got {}, want {}", bands.bass,     expected_bass);
        assert!((bands.low_mid  - expected_lm).abs()     < eps, "low_mid:  got {}, want {}", bands.low_mid,  expected_lm);
        assert!((bands.mid      - expected_mid).abs()    < eps, "mid:      got {}, want {}", bands.mid,      expected_mid);
        assert!((bands.high_mid - expected_hm).abs()     < eps, "high_mid: got {}, want {}", bands.high_mid, expected_hm);
        assert!((bands.treble   - expected_treble).abs() < eps, "treble:   got {}, want {}", bands.treble,   expected_treble);
    }

    /// Validates the beat detector: primes history with bass=0.5 (43 frames), then fires on
    /// bass=0.8 (> 0.5 × 1.25 = 0.625).  Also checks the 300 ms cooldown gate.
    #[test]
    fn beat_detector_fires_after_sustained_bass() {
        let mut history   = [0.0_f32; BEAT_HISTORY];
        let mut hist_idx  = 0_usize;
        let mut last_beat = 0.0_f32;
        let mut intensity = 0.0_f32;
        let mut now_ms    = 0.0_f32;
        let dt = 1000.0_f32 / 30.0;

        // Prime: 43 frames of bass=0.5 so avg ≈ 0.5, threshold ≈ 0.625.
        for _ in 0..BEAT_HISTORY {
            now_ms += dt;
            let (_, i) = beat_step(0.5, &mut history, &mut hist_idx, now_ms, &mut last_beat, intensity);
            intensity = i;
        }

        // Feed bass=0.8 — should fire.
        now_ms += dt;
        let (active, i) = beat_step(0.8, &mut history, &mut hist_idx, now_ms, &mut last_beat, intensity);
        intensity = i;
        assert!(active, "beat should fire: bass 0.8 > avg 0.5 × 1.25 = 0.625");

        // Feed bass=0.8 again one frame later — cooldown (300 ms >> 33 ms) must block.
        now_ms += dt;
        let (active2, _) = beat_step(0.8, &mut history, &mut hist_idx, now_ms, &mut last_beat, intensity);
        assert!(!active2, "beat should not re-fire within 300 ms cooldown");

        // Advance past 300 ms (10 frames ≈ 333 ms), but send weak bass — must not fire.
        for _ in 0..10 {
            now_ms += dt;
        }
        let (active3, _) = beat_step(0.1, &mut history, &mut hist_idx, now_ms, &mut last_beat, intensity);
        assert!(!active3, "bass=0.1 should not trigger a beat even after cooldown expires");
    }

    /// Validates Blackman window construction: w[0]≈0, w[N/2]≈1, symmetric, all in [0,1].
    #[test]
    fn blackman_window_coefficients_are_symmetric_and_bounded() {
        let n = FFT_SIZE; // 1024
        let w = blackman_window(n);

        assert_eq!(w.len(), n, "window length must equal FFT_SIZE");

        // Standard Blackman property: w[0] = 0.42 - 0.5*1 + 0.08*1 = 0.0 exactly.
        assert!(w[0].abs() < 1e-4_f32, "w[0] should be ≈0 (Blackman), got {}", w[0]);

        // Peak near the center (index N/2 = 512).
        // w[512] ≈ 0.42 + 0.5 + 0.08 = 1.0 (cos(π) = -1, cos(2π) = 1).
        let mid = n / 2;
        assert!(w[mid] > 0.99_f32, "w[N/2] should be ≈1.0, got {}", w[mid]);

        // All values in [0, 1].
        for (i, &v) in w.iter().enumerate() {
            assert!(v >= 0.0 && v <= 1.0, "w[{i}]={v} out of [0,1]");
        }

        // Symmetry: w[k] ≈ w[n-1-k].
        for k in 0..n / 2 {
            let diff = (w[k] - w[n - 1 - k]).abs();
            assert!(diff < 1e-5_f32,
                "window not symmetric at k={k}: w[{k}]={} vs w[{}]={}", w[k], n-1-k, w[n-1-k]);
        }
    }

    // ── QA-added integration tests ────────────────────────────────────────────

    /// Validates exact integer bin boundaries and contiguous coverage of all six bands.
    ///
    /// The six boundaries are: floor(512 * [0.02, 0.05, 0.10, 0.20, 0.45]) = [10, 25, 51, 102, 230].
    /// Coverage must be gap-free: sub starts at 0, treble ends at 512, adjacent bands share an edge.
    /// Mirrors JS _computeBands (audio.js 367–375) with Math.floor(bins * fraction).
    #[test]
    fn band_bin_edges_are_contiguous_and_match_js_floor() {
        let bins = FFT_BINS; // 512

        // Rust `as usize` on a positive f32 is equivalent to Math.floor for the range [0, 512].
        let sub_start:    usize = 0;
        let sub_end:      usize = (bins as f32 * 0.02) as usize; // floor(10.24)  = 10
        let bass_start:   usize = sub_end;
        let bass_end:     usize = (bins as f32 * 0.05) as usize; // floor(25.6)   = 25
        let lm_start:     usize = bass_end;
        let lm_end:       usize = (bins as f32 * 0.10) as usize; // floor(51.2)   = 51
        let mid_start:    usize = lm_end;
        let mid_end:      usize = (bins as f32 * 0.20) as usize; // floor(102.4)  = 102
        let hm_start:     usize = mid_end;
        let hm_end:       usize = (bins as f32 * 0.45) as usize; // floor(230.4)  = 230
        let treble_start: usize = hm_end;
        let treble_end:   usize = bins;

        // Assert the exact boundary values that must match the JS reference.
        assert_eq!(sub_end,      10,  "sub_end = floor(512*0.02) must be 10");
        assert_eq!(bass_end,     25,  "bass_end = floor(512*0.05) must be 25");
        assert_eq!(lm_end,       51,  "low_mid_end = floor(512*0.10) must be 51");
        assert_eq!(mid_end,      102, "mid_end = floor(512*0.20) must be 102");
        assert_eq!(hm_end,       230, "high_mid_end = floor(512*0.45) must be 230");
        assert_eq!(treble_end,   512, "treble_end must equal FFT_BINS (512)");

        // Contiguous coverage: no gaps or overlaps.
        assert_eq!(sub_start,    0,             "sub starts at bin 0");
        assert_eq!(bass_start,   sub_end,       "sub/bass boundary: no gap");
        assert_eq!(lm_start,     bass_end,      "bass/low_mid boundary: no gap");
        assert_eq!(mid_start,    lm_end,        "low_mid/mid boundary: no gap");
        assert_eq!(hm_start,     mid_end,       "mid/high_mid boundary: no gap");
        assert_eq!(treble_start, hm_end,        "high_mid/treble boundary: no gap");
        assert_eq!(treble_end,   bins,          "treble closes at FFT_BINS");

        // Cross-check with compute_bands_fn: one bin per band set to 1.0.
        let mut spectrum = vec![0.0_f32; bins];
        spectrum[sub_start]    = 1.0;
        spectrum[bass_start]   = 1.0;
        spectrum[lm_start]     = 1.0;
        spectrum[mid_start]    = 1.0;
        spectrum[hm_start]     = 1.0;
        spectrum[treble_start] = 1.0;
        let bands = compute_bands_fn(&spectrum);
        let eps = 1e-5_f32;
        assert!((bands.sub      - 1.0 / (sub_end - sub_start)         as f32).abs() < eps);
        assert!((bands.bass     - 1.0 / (bass_end - bass_start)       as f32).abs() < eps);
        assert!((bands.low_mid  - 1.0 / (lm_end - lm_start)          as f32).abs() < eps);
        assert!((bands.mid      - 1.0 / (mid_end - mid_start)         as f32).abs() < eps);
        assert!((bands.high_mid - 1.0 / (hm_end - hm_start)          as f32).abs() < eps);
        assert!((bands.treble   - 1.0 / (treble_end - treble_start)   as f32).abs() < eps);
    }

    /// Validates the dB normalization formula from CpalAudioSource::update():
    ///   spectrum[i] = ((20 * log10(smooth_mag.max(1e-10)) + 90) / 80).clamp(0, 1)
    ///
    /// The `.max(1e-10)` guard must prevent NaN/-inf for zero-magnitude bins.
    /// The range maps v2/audio.js minDecibels=-90, maxDecibels=-10 → [0, 1].
    #[test]
    fn db_normalization_formula_correctness() {
        // Case 1: zero magnitude — guard must produce a finite, non-NaN result clamped to 0.
        {
            let mag = 0.0_f32;
            let guarded = mag.max(1e-10_f32);
            let db = 20.0 * guarded.log10();
            assert!(db.is_finite(), "max(1e-10) guard must prevent -inf: db={db}");
            assert!(!db.is_nan(),   "max(1e-10) guard must prevent NaN: db={db}");
            // dB = 20*log10(1e-10) = -200 → ((-200+90)/80) = -1.375 → clamped to 0.0
            let spec = ((db + 90.0) / 80.0).clamp(0.0, 1.0);
            assert_eq!(spec, 0.0, "zero-magnitude bin maps to spectrum 0.0 after guard+clamp");
        }

        // Case 2: magnitude at exactly -70 dB → spectrum = ((-70+90)/80) = 0.25
        {
            let mag = 10.0_f32.powf(-70.0 / 20.0); // 10^-3.5
            let db  = 20.0 * mag.max(1e-10_f32).log10();
            let spec = ((db + 90.0) / 80.0).clamp(0.0, 1.0);
            assert!((spec - 0.25).abs() < 1e-4,
                "mag at -70 dB should give spectrum ≈ 0.25, got {spec}");
        }

        // Case 3: mag=1.0 (0 dB) → ((0+90)/80) = 1.125 → clamped to 1.0
        {
            let mag = 1.0_f32;
            let db  = 20.0 * mag.max(1e-10_f32).log10();
            let spec = ((db + 90.0) / 80.0).clamp(0.0, 1.0);
            assert_eq!(spec, 1.0, "0 dB (mag=1.0) should clamp to spectrum 1.0");
        }

        // Case 4: mag at the minDecibels boundary (-90 dB) → spectrum ≈ 0.0
        {
            let mag = 10.0_f32.powf(-90.0 / 20.0); // 10^-4.5
            let db  = 20.0 * mag.max(1e-10_f32).log10();
            let spec = ((db + 90.0) / 80.0).clamp(0.0, 1.0);
            assert!((spec - 0.0).abs() < 1e-4,
                "mag at -90 dB (minDecibels boundary) should give spectrum ≈ 0.0, got {spec}");
        }
    }

    /// Validates the exponential smoothing recurrence applied to magnitudes before dB conversion:
    ///   smooth = FFT_SMOOTHING * prev + (1 - FFT_SMOOTHING) * mag
    ///
    /// Mirrors Web Audio AnalyserNode.smoothingTimeConstant = 0.65.
    /// Tests: initial coefficient, convergence toward a constant input, and decay direction.
    #[test]
    fn smoothing_recurrence_converges_to_constant_input() {
        // One step from 0 with input 1.0 must equal (1 - FFT_SMOOTHING) = 0.35.
        let first = FFT_SMOOTHING * 0.0_f32 + (1.0 - FFT_SMOOTHING) * 1.0_f32;
        assert!(
            (first - (1.0 - FFT_SMOOTHING)).abs() < 1e-6,
            "one step from 0 with input 1.0 should be 1-FFT_SMOOTHING={}, got {first}",
            1.0 - FFT_SMOOTHING
        );

        // After 200 steps of constant input 1.0, value must converge to 1.0.
        let mut smooth = 0.0_f32;
        for _ in 0..200 {
            smooth = FFT_SMOOTHING * smooth + (1.0 - FFT_SMOOTHING) * 1.0;
        }
        assert!(
            (smooth - 1.0).abs() < 1e-4,
            "smoothing must converge to constant input 1.0 after 200 steps, got {smooth}"
        );

        // From initial 1.0 with input 0.0, value must decay toward 0.0.
        let mut decay = 1.0_f32;
        for _ in 0..200 {
            decay = FFT_SMOOTHING * decay + (1.0 - FFT_SMOOTHING) * 0.0;
        }
        assert!(
            decay < 1e-4,
            "smoothing must decay to ≈0 from 1.0 when input is 0.0, got {decay}"
        );
    }

    /// Validates two beat detector properties not covered by the existing firing test:
    ///   1. The beat fires AGAIN once the 300 ms cooldown expires (not just blocked within it).
    ///   2. The 0.2 floor suppresses beats even when bass exceeds the avg-derived threshold.
    #[test]
    fn beat_detector_fires_again_after_cooldown_and_floor_suppresses_weak_bass() {
        let dt = 1000.0_f32 / 30.0;

        // ── Part 1: fires again after the 300 ms cooldown expires ────────────
        {
            let mut history   = [0.0_f32; BEAT_HISTORY];
            let mut hist_idx  = 0_usize;
            let mut last_beat = 0.0_f32;
            let mut intensity = 0.0_f32;
            let mut now_ms    = 0.0_f32;

            // Prime 43 frames of bass=0.5 → avg ≈ 0.5, threshold ≈ 0.625.
            for _ in 0..BEAT_HISTORY {
                now_ms += dt;
                let (_, i) = beat_step(0.5, &mut history, &mut hist_idx, now_ms, &mut last_beat, intensity);
                intensity = i;
            }

            // Fire first beat.
            now_ms += dt;
            let (first, i) = beat_step(0.8, &mut history, &mut hist_idx, now_ms, &mut last_beat, intensity);
            intensity = i;
            assert!(first, "first beat should fire (bass 0.8 > threshold ≈ 0.625)");
            let beat_timestamp = last_beat; // now_ms value stored on beat

            // Feed 11 more frames of bass=0.5 — no beat should fire since bass < threshold.
            // These frames advance now_ms by 11 × 33.33 ms ≈ 367 ms > 300 ms.
            for _ in 0..11 {
                now_ms += dt;
                let (_, i) = beat_step(0.5, &mut history, &mut hist_idx, now_ms, &mut last_beat, intensity);
                intensity = i;
            }
            assert!(
                now_ms - beat_timestamp > BEAT_COOLDOWN_MS,
                "elapsed {}ms must exceed cooldown {}ms", now_ms - beat_timestamp, BEAT_COOLDOWN_MS
            );

            // Now feed bass=0.8 again — cooldown has expired, should fire.
            now_ms += dt;
            let (second, _) = beat_step(0.8, &mut history, &mut hist_idx, now_ms, &mut last_beat, intensity);
            assert!(second, "beat should fire a second time once the 300 ms cooldown expires");
        }

        // ── Part 2: 0.2 floor suppresses weak-but-above-avg-threshold bass ──
        // When history is all zeros, avg=0 and threshold=0, so any bass>0 exceeds the
        // avg-based threshold. The 0.2 floor is the only remaining guard in this scenario.
        {
            // bass=0.15: above avg threshold (0) but below the 0.2 floor — must NOT fire.
            let mut h1  = [0.0_f32; BEAT_HISTORY];
            let mut i1  = 0_usize;
            let mut lb1 = 0.0_f32;
            let (active_below, _) = beat_step(0.15, &mut h1, &mut i1,
                BEAT_COOLDOWN_MS * 2.0, &mut lb1, 0.0);
            assert!(!active_below,
                "bass=0.15 is below the 0.2 floor and must be suppressed (false positive guard)");

            // bass=0.21: just above the floor — SHOULD fire (threshold=0, cooldown clear).
            let mut h2  = [0.0_f32; BEAT_HISTORY];
            let mut i2  = 0_usize;
            let mut lb2 = 0.0_f32;
            let (active_above, _) = beat_step(0.21, &mut h2, &mut i2,
                BEAT_COOLDOWN_MS * 2.0, &mut lb2, 0.0);
            assert!(active_above,
                "bass=0.21 is above the 0.2 floor and above avg threshold (0) — must fire");
        }
    }
}
