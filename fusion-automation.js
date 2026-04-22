// fusion-automation.js — FusionAutomation
//
// Param snapshots (localStorage), auto-drift LFO, and beat-synced param morphing
// for Fusion mode. Reads from window.FUSION_PARAMS and window.FUSION_PARAM_RANGES.
//
// Call update(audioManager) every frame when Fusion is active.
// Must be loaded after fusion-panel.js and before sketch.js.

class FusionAutomation {
  constructor() {
    // Public state — readable by panel and sketch.js
    this.currentSlot    = 0;      // 0-based; displayed as currentSlot + 1
    this.slotCount      = 4;
    this.driftEnabled   = false;
    this.morphN         = 16;     // beats between morphs

    // Private morph state
    this._morphDuration  = 60;    // frames for lerp (≈1s at 60fps)
    this._morphProgress  = -1;    // -1 = not morphing; 0–1 during morph
    this._morphBeatCount = 0;
    this._morphTargets   = {};    // flat key → target value
    this._morphTargetsBgFx = {};  // bgFx key → target value
    this._morphStart     = {};    // flat key → value at morph start (for clean lerp)
    this._morphStartBgFx = {};    // bgFx key → value at morph start

    // Private drift state
    this._driftPhases    = {};    // flat key → LFO phase in radians (lazy init)
    this._driftPhaseBgFx = {};    // bgFx key → LFO phase in radians (lazy init)

    // Private beat-edge detection
    this._prevBeatActive = false;

    // Tuning constants
    this._DRIFT_SPEED_BASE = 0.0003;  // radians per frame at base speed (~350s/cycle)
    this._DRIFT_AMOUNT     = 0.15;    // ±15% of param range
    this._MORPH_DELTA      = 0.20;    // ±20% of range per morph step

    // Params excluded from automation — booleans and internal timing constants
    this._EXCLUDED_FLAT = new Set([
      'figureEnabled', 'rainEnabled', 'glitchEnabled', 'bgEnabled',
      'bgStutterDwell', 'bgStutterFrames',
    ]);
    this._EXCLUDED_BGFX = new Set([
      'enabled', 'posterizeEnabled', 'warpEnabled', 'corruptEnabled',
      'chromaEnabled', 'flashEnabled', 'posterizeLevels',
    ]);

    // Save slot 0 on first run if localStorage is empty
    this._loadSlots();
  }

  // ── Public API ───────────────────────────────────────────────────────────────

  /** Auto-save current params into currentSlot, advance to next slot, load it. */
  nextSlot() {
    this.saveCurrentSlot();
    this.currentSlot = (this.currentSlot + 1) % this.slotCount;
    this.loadCurrentSlot();
  }

  /** Auto-save current params into currentSlot, retreat to previous slot, load it. */
  prevSlot() {
    this.saveCurrentSlot();
    this.currentSlot = (this.currentSlot - 1 + this.slotCount) % this.slotCount;
    this.loadCurrentSlot();
  }

  /** Called on mode switch — resets per-session counters without disturbing VJ state. */
  reset() {
    this._morphBeatCount = 0;
    this._morphProgress  = -1;
    this._morphTargets   = {};
    this._morphTargetsBgFx = {};
    this._morphStart     = {};
    this._morphStartBgFx = {};
    // Do NOT reset currentSlot, driftEnabled, morphN, or drift phases —
    // those are persistent VJ state, not per-session mode state.
  }

  /** Save current FUSION_PARAMS into localStorage slot `idx`. */
  saveCurrentSlot() {
    this._saveSlot(this.currentSlot);
  }

  /** Load FUSION_PARAMS from localStorage slot `currentSlot`. No-op if slot is empty. */
  loadCurrentSlot() {
    this._loadSlot(this.currentSlot);
    if (window.syncFusionPanelState) window.syncFusionPanelState();
  }

  /**
   * Called every frame from sketch.js draw loop when Fusion is active.
   * Advances drift LFO and beat-synced morph.
   */
  update(audioManager) {
    // Beat edge detection (rising edge only)
    const beatNow    = !!(audioManager && audioManager.beatActive);
    const beatRising = beatNow && !this._prevBeatActive;
    this._prevBeatActive = beatNow;

    let paramsChanged = false;

    // Beat-synced morph (3c) — count rising edges, kick a morph every morphN beats
    if (beatRising) {
      this._morphBeatCount++;
      if (this._morphBeatCount >= this.morphN && this._morphProgress < 0) {
        this._morphBeatCount = 0;
        this._startMorph();
      }
    }

    // Advance morph if in progress
    if (this._morphProgress >= 0) {
      this._advanceMorph();
      paramsChanged = true;
    }

    // Advance drift LFO if enabled (3b)
    if (this.driftEnabled) {
      this._advanceDrift();
      paramsChanged = true;
    }

    if (paramsChanged && window.syncFusionPanelState) {
      window.syncFusionPanelState();
    }
  }

  // ── Private: Snapshots ───────────────────────────────────────────────────────

  _loadSlots() {
    // Pre-populate slot 0 with current defaults on first run
    if (!localStorage.getItem('fusionSnap_0')) {
      this._saveSlot(0);
    }
  }

  _saveSlot(idx) {
    try {
      const params = window.FUSION_PARAMS;
      if (!params) return;
      // Deep-clone flat keys + bgFx sub-object
      const snap = Object.assign({}, params);
      snap.bgFx = Object.assign({}, params.bgFx);
      localStorage.setItem('fusionSnap_' + idx, JSON.stringify(snap));
    } catch (e) {
      console.warn('[FusionAutomation] localStorage save failed:', e.message);
    }
  }

  _loadSlot(idx) {
    try {
      const raw = localStorage.getItem('fusionSnap_' + idx);
      if (!raw) return;  // empty slot — leave params unchanged
      const snap   = JSON.parse(raw);
      const params = window.FUSION_PARAMS;
      if (!params || !snap) return;
      // Restore flat keys
      for (const key of Object.keys(snap)) {
        if (key === 'bgFx') continue;
        if (key in params) params[key] = snap[key];
      }
      // Restore bgFx keys
      if (snap.bgFx && params.bgFx) {
        for (const key of Object.keys(snap.bgFx)) {
          if (key in params.bgFx) params.bgFx[key] = snap.bgFx[key];
        }
      }
      this._enforceSpeedConstraint();
    } catch (e) {
      console.warn('[FusionAutomation] localStorage load failed:', e.message);
    }
  }

  // ── Private: Morph ───────────────────────────────────────────────────────────

  _startMorph() {
    const params = window.FUSION_PARAMS;
    const ranges = window.FUSION_PARAM_RANGES;
    if (!params || !ranges) return;

    this._morphTargets     = {};
    this._morphTargetsBgFx = {};
    this._morphStart       = {};
    this._morphStartBgFx   = {};
    this._morphProgress    = 0;

    // Pick random targets within ±_MORPH_DELTA of each param's range span
    for (const key of Object.keys(ranges)) {
      if (key === 'bgFx') continue;
      if (this._EXCLUDED_FLAT.has(key)) continue;
      if (typeof params[key] !== 'number') continue;
      const range = ranges[key];
      if (!range) continue;
      const span   = (range.max - range.min) * this._MORPH_DELTA;
      const target = params[key] + (Math.random() * 2 - 1) * span;
      this._morphStart[key]   = params[key];
      this._morphTargets[key] = this._clamp(target, range.min, range.max);
    }

    if (ranges.bgFx && params.bgFx) {
      for (const key of Object.keys(ranges.bgFx)) {
        if (this._EXCLUDED_BGFX.has(key)) continue;
        if (typeof params.bgFx[key] !== 'number') continue;
        const range = ranges.bgFx[key];
        if (!range) continue;
        const span   = (range.max - range.min) * this._MORPH_DELTA;
        const target = params.bgFx[key] + (Math.random() * 2 - 1) * span;
        this._morphStartBgFx[key]   = params.bgFx[key];
        this._morphTargetsBgFx[key] = this._clamp(target, range.min, range.max);
      }
    }
  }

  _advanceMorph() {
    this._morphProgress += 1 / this._morphDuration;
    const rawT = Math.min(1, this._morphProgress);
    // Ease-out cubic: fast start, slows near target
    const t = 1 - Math.pow(1 - rawT, 3);

    const params = window.FUSION_PARAMS;

    // Lerp flat params from stored start values toward targets
    for (const key of Object.keys(this._morphTargets)) {
      params[key] = this._lerp(this._morphStart[key], this._morphTargets[key], t);
    }
    // Lerp bgFx params
    if (params.bgFx) {
      for (const key of Object.keys(this._morphTargetsBgFx)) {
        params.bgFx[key] = this._lerp(this._morphStartBgFx[key], this._morphTargetsBgFx[key], t);
      }
    }

    // Snap to exact targets on completion to eliminate floating-point drift
    if (rawT >= 1) {
      for (const key of Object.keys(this._morphTargets)) {
        params[key] = this._morphTargets[key];
      }
      if (params.bgFx) {
        for (const key of Object.keys(this._morphTargetsBgFx)) {
          params.bgFx[key] = this._morphTargetsBgFx[key];
        }
      }
      this._morphProgress = -1;
    }

    this._enforceSpeedConstraint();
  }

  // ── Private: Drift ───────────────────────────────────────────────────────────

  _advanceDrift() {
    const params = window.FUSION_PARAMS;
    const ranges = window.FUSION_PARAM_RANGES;
    if (!params || !ranges) return;

    // Advance flat params
    for (const key of Object.keys(ranges)) {
      if (key === 'bgFx') continue;
      if (this._EXCLUDED_FLAT.has(key)) continue;
      if (typeof params[key] !== 'number') continue;
      const range = ranges[key];
      if (!range) continue;
      // Lazy-init phase with random offset so params are staggered
      if (this._driftPhases[key] === undefined) {
        this._driftPhases[key] = Math.random() * Math.PI * 2;
      }
      this._driftPhases[key] += this._DRIFT_SPEED_BASE;
      const center   = (range.min + range.max) / 2;
      const halfSpan = (range.max - range.min) / 2 * this._DRIFT_AMOUNT;
      params[key] = this._clamp(
        center + Math.sin(this._driftPhases[key]) * halfSpan,
        range.min,
        range.max
      );
    }

    // Advance bgFx params
    if (ranges.bgFx && params.bgFx) {
      for (const key of Object.keys(ranges.bgFx)) {
        if (this._EXCLUDED_BGFX.has(key)) continue;
        if (typeof params.bgFx[key] !== 'number') continue;
        const range = ranges.bgFx[key];
        if (!range) continue;
        if (this._driftPhaseBgFx[key] === undefined) {
          this._driftPhaseBgFx[key] = Math.random() * Math.PI * 2;
        }
        this._driftPhaseBgFx[key] += this._DRIFT_SPEED_BASE;
        const center   = (range.min + range.max) / 2;
        const halfSpan = (range.max - range.min) / 2 * this._DRIFT_AMOUNT;
        params.bgFx[key] = this._clamp(
          center + Math.sin(this._driftPhaseBgFx[key]) * halfSpan,
          range.min,
          range.max
        );
      }
    }

    this._enforceSpeedConstraint();
  }

  // ── Private: Helpers ─────────────────────────────────────────────────────────

  /** Ensure rainSpeedMin < rainSpeedMax at all times. */
  _enforceSpeedConstraint() {
    const p = window.FUSION_PARAMS;
    if (!p) return;
    if (p.rainSpeedMin !== undefined && p.rainSpeedMax !== undefined) {
      if (p.rainSpeedMin > p.rainSpeedMax - 0.05) {
        p.rainSpeedMin = Math.max(0.05, p.rainSpeedMax - 0.05);
      }
    }
  }

  _clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }
  _lerp(a, b, t)      { return a + (b - a) * t; }
}

// ── Instantiate ──────────────────────────────────────────────────────────────
window.fusionAutomation = new FusionAutomation();
