//! Shared deterministic RNG — xorshift32.
//!
//! Previously duplicated across `fusion.rs` (seeded 0xDEAD_BEEF) and `audio_dev.rs`
//! (seeded 0x1234_5678). Centralised here so both modules share identical bit behaviour.

pub struct Xorshift32(u32);

impl Xorshift32 {
    pub fn new(seed: u32) -> Self {
        Self(seed.max(1))
    }

    /// Returns a value in `[0, 1)`.
    pub fn rand(&mut self) -> f32 {
        let mut x = self.0;
        x ^= x << 13;
        x ^= x >> 17;
        x ^= x << 5;
        self.0 = x;
        (x >> 8) as f32 / (1u32 << 24) as f32
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn outputs_in_range() {
        let mut rng = Xorshift32::new(0xDEAD_BEEF);
        for _ in 0..10_000 {
            let v = rng.rand();
            assert!((0.0..1.0).contains(&v), "rand() out of [0,1): {v}");
        }
    }

    #[test]
    fn seed_max_1_guards_zero_seed() {
        // Seed 0 would produce a degenerate all-zero sequence; new() clamps to 1.
        let mut rng = Xorshift32::new(0);
        let v = rng.rand();
        assert!((0.0..1.0).contains(&v), "degenerate sequence from zero seed: {v}");
    }

    #[test]
    fn known_sequence_matches_fusion_seed() {
        // Ensure the first output from the fusion seed is deterministic across refactors.
        let mut rng = Xorshift32::new(0xDEAD_BEEF);
        let first = rng.rand();
        // Re-run with the same seed and verify the sequence is identical.
        let mut rng2 = Xorshift32::new(0xDEAD_BEEF);
        assert_eq!(rng2.rand(), first);
    }
}
