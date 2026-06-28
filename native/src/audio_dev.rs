use crate::audio::AudioSource;
use crate::rng::Xorshift32;

/// Six log-spaced energy bands — the exact set `fusion` consumes.
#[derive(Clone, Copy, Default)]
pub struct Bands {
    pub sub: f32,
    pub bass: f32,
    pub low_mid: f32,
    pub mid: f32,
    pub high_mid: f32,
    pub treble: f32,
}

pub struct DevAudioSource {
    spectrum: Vec<f32>,
    bands: Bands,
    beat_active: bool,
    beat_intensity: f32,

    time: f32,      // seconds
    now_ms: f32,    // ms, for the beat cooldown
    beat_pulse: f32,
    bpm: f32,
    rng: Xorshift32,

    // energy-beat detector state (mirrors V2_CONFIG.BEAT_* in config.js)
    bass_history: [f32; 43],
    hist_idx: usize,
    last_beat_ms: f32,
}

impl DevAudioSource {
    pub fn new(bins: usize) -> Self {
        Self {
            spectrum: vec![0.0; bins],
            bands: Bands::default(),
            beat_active: false,
            beat_intensity: 0.0,
            time: 0.0,
            now_ms: 0.0,
            beat_pulse: 0.0,
            bpm: 120.0,
            rng: Xorshift32::new(0x1234_5678),
            bass_history: [0.0; 43],
            hist_idx: 0,
            last_beat_ms: 0.0,
        }
    }

    pub fn spectrum(&self) -> &[f32] {
        &self.spectrum
    }
    pub fn bands(&self) -> Bands {
        self.bands
    }
    pub fn beat_active(&self) -> bool {
        self.beat_active
    }
    pub fn beat_intensity(&self) -> f32 {
        self.beat_intensity
    }

    /// Alias used by the `AudioSource` trait so callers can use `update()` uniformly.
    pub fn update(&mut self) { self.tick() }

    /// Advance one 30 Hz logic frame. Call from the same fixed tick as `fusion.update`.
    pub fn tick(&mut self) {
        self.time += 1.0 / 30.0;
        self.now_ms += 1000.0 / 30.0;
        let t = self.time;
        let bps = self.bpm / 60.0;

        let beat_phase = (t * bps).fract();
        if beat_phase < 0.05 {
            self.beat_pulse = self.beat_pulse.max(1.0 - beat_phase / 0.05);
        } else {
            self.beat_pulse *= 0.85;
        }

        let bass = 0.3 + 0.6 * self.beat_pulse + 0.05 * (t * 2.1).sin();
        let mid = 0.15 + 0.3 * (t * 3.7 + 0.5).sin() * (0.5 + 0.5 * (t * 0.4).sin());
        let treble = 0.05 + 0.2 * (t * 7.3).sin().abs() * self.rng.rand();

        let bins = self.spectrum.len();
        for i in 0..bins {
            let fi = i as f32;
            let norm = fi / bins as f32;
            let val = if norm < 0.06 {
                bass * (1.0 - norm / 0.06) * (0.7 + 0.3 * (t * 5.1 + fi * 0.3).sin())
            } else if norm < 0.2 {
                mid * 0.8 * (1.0 - (norm - 0.06) / 0.14) * (t * 4.2 + fi * 0.5).sin().abs()
            } else if norm < 0.5 {
                mid * 0.5 * (t * 6.6 + fi * 0.7).sin().abs()
            } else {
                treble * (0.3 + 0.7 * self.rng.rand()) * (1.0 - norm)
            };
            // same one-pole smoothing the v2 demo path uses
            self.spectrum[i] = self.spectrum[i] * 0.7 + val.clamp(0.0, 1.0) * 0.3;
        }

        // clamp(0.0, 1.0): mid can briefly go negative when the sin term dominates,
        // causing bands to underflow the [0, 1] contract expected by fusion and tests.
        self.bands.sub      = (bass * 0.9).clamp(0.0, 1.0);
        self.bands.bass     = (bass * 0.85 + 0.05 * (t * 3.0).sin()).clamp(0.0, 1.0);
        self.bands.low_mid  = (mid * 0.9).clamp(0.0, 1.0);
        self.bands.mid      = (mid * 0.7 + 0.1 * (t * 5.0).sin().abs()).clamp(0.0, 1.0);
        self.bands.high_mid = (mid * 0.4 + treble * 0.3).clamp(0.0, 1.0);
        self.bands.treble   = treble.clamp(0.0, 1.0);

        self.detect_beat();
    }

    /// Energy-beat detector — port of `_detectBeat`: 43-frame bass history, 1.25× threshold,
    /// 0.2 floor, 300 ms cooldown.
    fn detect_beat(&mut self) {
        let bass = self.bands.bass;
        self.bass_history[self.hist_idx] = bass;
        self.hist_idx = (self.hist_idx + 1) % self.bass_history.len();

        let avg = self.bass_history.iter().sum::<f32>() / self.bass_history.len() as f32;
        let threshold = avg * 1.25;
        let cooldown_ok = (self.now_ms - self.last_beat_ms) > 300.0;

        if bass > threshold && bass > 0.2 && cooldown_ok {
            self.beat_active = true;
            self.beat_intensity = (bass / threshold.max(0.01)).min(1.0);
            self.last_beat_ms = self.now_ms;
        } else {
            self.beat_active = false;
            self.beat_intensity *= 0.9;
        }
    }
}

impl AudioSource for DevAudioSource {
    fn update(&mut self)                      { self.tick() }
    fn spectrum(&self) -> &[f32]              { &self.spectrum }
    fn bands(&self) -> Bands                  { self.bands }
    fn beat_active(&self) -> bool             { self.beat_active }
    fn beat_intensity(&self) -> f32           { self.beat_intensity }
    fn is_live(&self) -> bool                 { false }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn outputs_in_range_and_beats_periodically() {
        let mut a = DevAudioSource::new(512);
        let mut beats = 0;
        for _ in 0..600 {
            // ~20 s @ 30 fps
            a.tick();
            assert_eq!(a.spectrum().len(), 512);
            for &s in a.spectrum() {
                assert!((0.0..=1.0).contains(&s), "spectrum bin out of range: {s}");
            }
            let b = a.bands();
            for v in [b.sub, b.bass, b.low_mid, b.mid, b.high_mid, b.treble] {
                assert!((0.0..=1.0).contains(&v), "band out of range: {v}");
            }
            assert!((0.0..=1.0).contains(&a.beat_intensity()));
            if a.beat_active() {
                beats += 1;
            }
        }
        // 120 BPM over ~20 s ≈ 40 beats; require a clearly periodic signal.
        assert!(beats > 10, "expected periodic beats, got {beats}");
    }
}
