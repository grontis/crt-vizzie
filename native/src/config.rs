//! Phase 1 config: the renderer-relevant tunable params + the phosphor/CGA tables.
//! Values copied verbatim from `v2/config.js` (V2_PARAMS / V2_CONFIG). Expand as bridge.rs and
//! fusion.rs land.

pub struct Params {
    pub phosphor_index: usize,    // 0–4, indexes PHOSPHOR_ORDER / PHOSPHORS
    pub scanline_intensity: f32,  // 0.0–1.0
    pub scanline_mode: i32,       // 0=off 1=pixel 2=cell-gap 3=smooth
    pub chroma_base: f32,         // always-on chromatic-aberration pixel offset
    pub chroma_beat_current: f32, // beat-reactive add (0.0 in Phase 1 — no audio yet)
    pub bg_enabled: bool,         // B key — composite game vs ASCII-on-black
    pub bg_opacity: f32,          // 0.0–1.0 game opacity before the screen blend
}

impl Default for Params {
    fn default() -> Self {
        Self {
            phosphor_index: 2, // green (PHOSPHOR_ORDER[2])
            scanline_intensity: 0.33,
            scanline_mode: 1, // PIXEL
            chroma_base: 1.5,
            chroma_beat_current: 0.0,
            bg_enabled: true,
            bg_opacity: 0.55,
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
