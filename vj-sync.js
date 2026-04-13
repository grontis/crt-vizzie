// vj-sync.js — VJSyncManager
// Automates VJ controls in sync with beat detection.
// Loaded after config.js and before sketch.js.
//
// Constructor receives an audioManager reference and a hooks object containing
// thin closures from sketch.js — no window globals are read directly.

class VJSyncManager {
  constructor(audioManager, hooks) {
    this._audio = audioManager;
    this._hooks = hooks;
    this._cfg   = CONFIG.VJ_SYNC;

    // Public toggle state
    this.enabled = false;

    // Beat edge detection
    this._prevBeatActive = false;

    // Treble peak detection — independent of beat system
    this._prevTreble = 0;

    // Dwell timers — performance.now() timestamps of last action
    this._lastModeSwitch     = 0;
    this._lastPhosphorCycle  = 0;
    this._lastScanlineToggle = 0;
    this._lastBgStutter      = 0;

    // Background stutter — frames remaining in current stutter window
    this._bgStutterFrames = 0;

    // Background pulse accumulator — extra opacity currently added
    this._bgPulseActive = 0;
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  get enabled() { return this._enabled; }
  set enabled(v) { this._enabled = v; }

  toggle() {
    this._enabled = !this._enabled;

    if (this._enabled) {
      this._lastModeSwitch     = 0;
      this._lastPhosphorCycle  = 0;
      this._lastScanlineToggle = 0;
      this._lastBgStutter      = 0;
      this._bgPulseActive      = 0;
      this._prevBeatActive     = false;
      this._prevTreble         = 0;
      this._bgStutterFrames    = 0;
    } else {
      // Mid-stutter on disable — restore background immediately
      if (this._bgStutterFrames > 0) {
        this._bgStutterFrames = 0;
        if (!this._hooks.getBgVisible()) this._hooks.toggleBackground();
      }
    }

    console.log('[VJSync]', this._enabled ? 'ON' : 'OFF');
  }

  update(audioManager) {
    // Always run cleanup effects even when disabled
    this._applyBgPulse(audioManager);
    this._advanceBgStutter();

    if (!this._enabled || audioManager.isIdle) return;

    const bands      = audioManager.getBands();
    const now        = performance.now();
    const beatActive = audioManager.beatActive;
    const risingEdge = beatActive && !this._prevBeatActive;

    // ── Beat-driven actions ─────────────────────────────────────────────────
    if (risingEdge) {
      this._onBeatEdge(bands, now);
    }
    this._prevBeatActive = beatActive;

    // ── Treble peak detection (independent of beat system) ───────────────────
    // Fires on the rising edge of treble crossing the threshold.
    const treble = bands.treble;
    if (treble > this._cfg.BG_TREBLE_THRESH &&
        this._prevTreble <= this._cfg.BG_TREBLE_THRESH &&
        this._bgStutterFrames === 0 &&
        now - this._lastBgStutter >= this._cfg.BG_STUTTER_DWELL_MS &&
        this._hooks.getBgVisible()) {
      this._bgStutterFrames = this._cfg.BG_STUTTER_FRAMES;
      this._lastBgStutter   = now;
    }
    this._prevTreble = treble;
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  _detectKick(bands) {
    return bands.sub  > this._cfg.KICK_SUB_THRESH &&
           bands.bass > this._cfg.KICK_BASS_THRESH;
  }

  _detectSnare(bands) {
    return bands.highMid > this._cfg.SNARE_HIGHMID_THRESH &&
           bands.bass    < this._cfg.SNARE_BASS_MAX;
  }

  _onBeatEdge(bands, now) {
    const isKick = this._detectKick(bands);

    // ── Mode switch — any beat ───────────────────────────────────────────────
    if (now - this._lastModeSwitch >= this._cfg.MODE_DWELL_MS) {
      const currentIdx = this._hooks.getCurrentModeIndex();
      const candidates = this._cfg.MODE_LIST.filter(idx => idx !== currentIdx);
      if (candidates.length > 0) {
        const chosen = candidates[Math.floor(Math.random() * candidates.length)];
        this._hooks.activateMode(chosen);
        this._lastModeSwitch = now;
      }
    }

    // ── Phosphor cycle — any beat ────────────────────────────────────────────
    if (now - this._lastPhosphorCycle >= this._cfg.PHOSPHOR_DWELL_MS) {
      this._hooks.cyclePhosphor();
      this._lastPhosphorCycle = now;
    }

    // ── Scanline toggle — kick only ──────────────────────────────────────────
    if (isKick &&
        this._cfg.SCANLINES_ENABLED &&
        now - this._lastScanlineToggle >= this._cfg.SCANLINE_DWELL_MS) {
      this._hooks.toggleScanlines();
      this._lastScanlineToggle = now;
    }
  }

  /**
   * Per-frame background stutter advance.
   * Each frame of the stutter window, randomly flip background visibility —
   * creates a rapid glitchy flicker. On expiry, guarantees background is restored.
   * Runs unconditionally so an in-progress stutter always finishes cleanly.
   */
  _advanceBgStutter() {
    if (this._bgStutterFrames <= 0) return;

    this._bgStutterFrames--;

    if (this._bgStutterFrames === 0) {
      // Stutter done — guarantee background is visible again
      if (!this._hooks.getBgVisible()) this._hooks.toggleBackground();
      return;
    }

    // Randomly flip visibility each frame for a glitchy stutter feel
    if (Math.random() < this._cfg.BG_STUTTER_CHANCE) {
      this._hooks.toggleBackground();
    }
  }

  /**
   * Per-frame background opacity pulse on kicks.
   * Runs unconditionally to clean up residual pulse on disable.
   */
  _applyBgPulse(audioManager) {
    const bands = audioManager.isIdle ? null : audioManager.getBands();

    if (!audioManager.isIdle && audioManager.beatActive && bands && this._detectKick(bands)) {
      const addAmount = this._cfg.BG_PULSE_AMOUNT;
      this._bgPulseActive = Math.min(1.0, this._bgPulseActive + addAmount);
      this._hooks.adjustBgOpacity(addAmount);
    }

    if (this._bgPulseActive > 0) {
      const decay = Math.min(this._bgPulseActive, this._cfg.BG_PULSE_DECAY);
      this._hooks.adjustBgOpacity(-decay);
      this._bgPulseActive -= decay;
    }
  }
}
