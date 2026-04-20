// modes/fusion.js — Fusion Mode: ASCII Art + Matrix Rain + Glitch Corruption + BG Modulation
//
// Four layered systems rendered into a single grid each frame:
//   FIGURE : A centered ASCII art figure that slowly decays and gets reseeded
//   RAIN   : Matrix-style falling columns that burn through and interact with the figure
//   GLITCH : Beat-triggered corruption — expanding ring bursts, tears, scatter
//   BG     : Background image modulation mirroring VJ sync — kick-driven opacity pulse,
//            treble-triggered stutter, and per-cell luma sampling to bias figure brightness
//
// Rendering order: figure (background) → rain (midground) → glitch bursts (top)
// Tune each layer independently via the static constants below.

class FusionMode {

  // ── Figure layer ──────────────────────────────────────────────────────────
  // The background ASCII art that anchors the scene.
  static FIG_DECAY       = 0.007;  // brightness lost per frame — lower = figure lingers longer
  static FIG_RESEED_F    = 160;    // frames between automatic figure reseeds
  static FIG_BRIGHTNESS  = 0.65;   // brightness when a figure is first stamped in
  static FIG_SMEAR       = 0.025;  // per-cell chance per frame to smear char to right neighbor

  // ── Rain layer ────────────────────────────────────────────────────────────
  // Katakana/mixed chars falling in columns, interacting with the figure.
  static RAIN_SPEED_MIN  = 0.15;
  static RAIN_SPEED_MAX  = 0.90;
  static RAIN_BEAT_MULT  = 3.2;    // speed multiplier on beat
  static RAIN_TRAIL      = 14;     // cells behind the head that form the trail
  static RAIN_INTERACT   = 0.50;   // chance the rain head borrows the figure char it overlaps
  static RAIN_BURN_BOOST = 0.20;   // brightness added to figure cell when rain head touches it

  // ── Glitch layer ──────────────────────────────────────────────────────────
  // Hard-beat corruption that tears, scatters, and fires expanding ring bursts.
  static GLI_THRESHOLD   = 0.62;   // beatIntensity needed to trigger a burst
  static GLI_CHANCE      = 0.55;   // probability a burst fires when threshold is met
  static GLI_SCATTER     = 0.045;  // fraction of cells scattered on a hard beat
  static GLI_TEAR        = 0.020;  // per-row horizontal tear probability on beat
  static GLI_CHARS       = '!@#$%^&*[]{}|\\/<>?~░▒▓█▄▀■□◆';

  // ── Background layer ──────────────────────────────────────────────────────
  // Kick-driven opacity pulse and treble-triggered stutter, mirroring VJ sync.
  // Also uses per-cell luma to bias figure brightness where the image is bright.
  static BG_KICK_SUB     = 0.50;   // sub threshold for kick detection
  static BG_KICK_BASS    = 0.40;   // bass threshold for kick detection
  static BG_PULSE_AMOUNT = 0.18;   // opacity added on each kick
  static BG_PULSE_DECAY  = 0.04;   // opacity units recovered per frame after a pulse
  static BG_TREBLE_THRESH = 0.39;  // treble level that triggers a stutter
  static BG_STUTTER_FRAMES = 14;   // frames of stutter window (~230ms at 60fps)
  static BG_STUTTER_CHANCE = 0.45; // per-frame probability of flipping visibility during stutter
  static BG_STUTTER_DWELL = 1500;  // minimum ms between stutter events
  static BG_LUMA_BOOST   = 0.35;   // max extra brightness added to figure cells by luma sampling

  // ─────────────────────────────────────────────────────────────────────────

  constructor(config) {
    this.config        = config;
    this._cols         = 0;
    this._rows         = 0;
    this._figure       = [];   // [rows][cols] { char, brightness } — the persistent art layer
    this._rain         = [];   // per-column rain state
    this._seedTimer    = 0;
    this._burst        = null; // null | { startTime, duration, intensity, cx, cy }
    this._lastBeatTime = 0;
    this._beatInterval = 600;

    // Background modulation state
    this._bgPulseActive   = 0;     // accumulated opacity currently added by pulse
    this._bgStutterFrames = 0;     // frames remaining in current stutter window
    this._lastBgStutter   = 0;     // performance.now() of last stutter trigger
    this._prevTreble      = 0;     // treble value from last frame for rising-edge detection
    this._prevBeatActive  = false; // beat state from last frame for rising-edge detection
  }

  reset() {
    this._init(this._cols, this._rows);
  }

  // ── Initialization ────────────────────────────────────────────────────────

  _init(cols, rows) {
    this._cols = cols;
    this._rows = rows;
    this._figure = Array.from({ length: rows }, () =>
      Array.from({ length: cols }, () => ({ char: ' ', brightness: 0 }))
    );
    this._rain = Array.from({ length: cols }, (_, c) =>
      this._makeRainCol(rows, c, cols)
    );
    this._seedTimer    = 0;
    this._burst        = null;
    this._bgPulseActive   = 0;
    this._bgStutterFrames = 0;
    this._stampFigure(cols, rows);
  }

  _makeRainCol(rows, colIdx, totalCols) {
    const range = FusionMode.RAIN_SPEED_MAX - FusionMode.RAIN_SPEED_MIN;
    return {
      headY:   Math.random() * -rows,
      speed:   FusionMode.RAIN_SPEED_MIN + Math.random() * range,
      binFrac: colIdx / Math.max(1, totalCols - 1), // 0–1, maps column to frequency bin
    };
  }

  _stampFigure(cols, rows) {
    const fig   = AsciiArtLibrary.random();
    const frame = AsciiArtLibrary.getFrame(fig, 0);
    const sr    = Math.floor((rows - this.config.MORPH_HEIGHT) / 2);
    const sc    = Math.floor((cols - this.config.MORPH_WIDTH)  / 2);
    for (let r = 0; r < frame.length; r++) {
      for (let c = 0; c < frame[r].length; c++) {
        const gr = sr + r, gc = sc + c;
        if (gr < 0 || gr >= rows || gc < 0 || gc >= cols) continue;
        const ch = frame[r][c];
        if (ch !== ' ') {
          this._figure[gr][gc] = { char: ch, brightness: FusionMode.FIG_BRIGHTNESS };
        }
      }
    }
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  _glitchChar() {
    const s = FusionMode.GLI_CHARS;
    return s[Math.floor(Math.random() * s.length)];
  }

  _katakana() {
    const pool = this.config.KATAKANA;
    return pool[Math.floor(Math.random() * pool.length)];
  }

  _isKick(bands) {
    return bands.sub  > FusionMode.BG_KICK_SUB &&
           bands.bass > FusionMode.BG_KICK_BASS;
  }

  // ── Background modulation ─────────────────────────────────────────────────
  // Mirrors the two VJ sync background effects: kick pulse and treble stutter.
  // Must be called every frame so in-progress pulses and stutters finish cleanly.

  _updateBackground(bg, bands, beatRisingEdge, now) {
    if (!bg.hasMedia) return;

    // Kick pulse — boost opacity on each kick, decay back each frame
    if (beatRisingEdge && this._isKick(bands)) {
      const add = FusionMode.BG_PULSE_AMOUNT;
      this._bgPulseActive = Math.min(1.0, this._bgPulseActive + add);
      bg.adjustOpacity(add);
    }
    if (this._bgPulseActive > 0) {
      const decay = Math.min(this._bgPulseActive, FusionMode.BG_PULSE_DECAY);
      bg.adjustOpacity(-decay);
      this._bgPulseActive -= decay;
    }

    // Treble stutter — trigger on rising edge of treble threshold
    const treble = bands.treble;
    if (treble > FusionMode.BG_TREBLE_THRESH &&
        this._prevTreble <= FusionMode.BG_TREBLE_THRESH &&
        this._bgStutterFrames === 0 &&
        now - this._lastBgStutter >= FusionMode.BG_STUTTER_DWELL &&
        bg.isVisible) {
      this._bgStutterFrames = FusionMode.BG_STUTTER_FRAMES;
      this._lastBgStutter   = now;
    }
    this._prevTreble = treble;

    // Advance stutter — randomly flip visibility each frame, guarantee restore on expiry
    if (this._bgStutterFrames > 0) {
      this._bgStutterFrames--;
      if (this._bgStutterFrames === 0) {
        if (!bg.isVisible) bg.toggle(); // ensure restored
      } else if (Math.random() < FusionMode.BG_STUTTER_CHANCE) {
        bg.toggle();
      }
    }
  }

  // ── Main update ───────────────────────────────────────────────────────────

  update(grid, cols, rows, audio, bg) {
    if (cols !== this._cols || rows !== this._rows) this._init(cols, rows);

    const bands         = audio.getBands();
    const spectrum      = audio.getSpectrum();
    const beatActive    = audio.beatActive;
    const beatIntensity = audio.beatIntensity;
    const now           = performance.now();

    const beatRisingEdge = beatActive && !this._prevBeatActive;
    this._prevBeatActive = beatActive;

    // Track beat interval for timing-aware effects
    if (beatActive) {
      if (this._lastBeatTime > 0) {
        const iv = now - this._lastBeatTime;
        if (iv > 200 && iv < 2000) this._beatInterval = this._beatInterval * 0.75 + iv * 0.25;
      }
      this._lastBeatTime = now;
    }

    // ── Background modulation (runs every frame) ───────────────────────────
    this._updateBackground(bg, bands, beatRisingEdge, now);

    // ── Phase 1: Update figure state ───────────────────────────────────────

    this._seedTimer++;
    const forceReseed = beatActive && beatIntensity > 0.85 && this._seedTimer > 40;
    if (this._seedTimer >= FusionMode.FIG_RESEED_F || forceReseed) {
      this._seedTimer = 0;
      this._stampFigure(cols, rows);
    }

    const totalEnergy = Math.max(0.1, (bands.bass + bands.mid + bands.treble) / 3);
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const cell = this._figure[r][c];
        // Decay — faster when there's more audio energy
        cell.brightness = Math.max(0, cell.brightness - FusionMode.FIG_DECAY * (0.5 + 0.5 * totalEnergy));
        // Bass-driven horizontal smear
        if (cell.brightness > 0.08 && cell.char !== ' ' &&
            Math.random() < FusionMode.FIG_SMEAR * Math.max(0.3, bands.bass) && c + 1 < cols) {
          const nb = this._figure[r][c + 1];
          if (nb.brightness < cell.brightness * 0.6) {
            nb.char       = cell.char;
            nb.brightness = cell.brightness * 0.5;
          }
        }
      }
    }

    // ── Phase 2: Update rain state ─────────────────────────────────────────

    if (beatActive) {
      for (const col of this._rain) {
        col.speed = Math.min(
          FusionMode.RAIN_SPEED_MAX * FusionMode.RAIN_BEAT_MULT,
          col.speed * FusionMode.RAIN_BEAT_MULT
        );
      }
    }

    for (let c = 0; c < cols; c++) {
      const col = this._rain[c];

      // Speed tracks its frequency bin's energy between beats
      if (!beatActive) {
        const logFrac = Math.pow(col.binFrac, 1.8);
        const specIdx = Math.min(spectrum.length - 1, Math.floor(logFrac * spectrum.length));
        const binE    = spectrum[specIdx] || 0;
        const target  = FusionMode.RAIN_SPEED_MIN + binE * (FusionMode.RAIN_SPEED_MAX - FusionMode.RAIN_SPEED_MIN);
        col.speed += (target - col.speed) * 0.05;
        col.speed  = Math.max(FusionMode.RAIN_SPEED_MIN * 0.5, col.speed);
      }

      col.headY += col.speed;
      if (col.headY > rows + FusionMode.RAIN_TRAIL) {
        col.headY = Math.random() * -10;
        col.speed = FusionMode.RAIN_SPEED_MIN + Math.random() * (FusionMode.RAIN_SPEED_MAX - FusionMode.RAIN_SPEED_MIN);
      }

      // Burn: boost figure brightness where the rain head touches
      const headRow = Math.floor(col.headY);
      if (headRow >= 0 && headRow < rows) {
        const figCell = this._figure[headRow][c];
        if (figCell.brightness > 0) {
          figCell.brightness = Math.min(1.0, figCell.brightness + FusionMode.RAIN_BURN_BOOST);
        }
      }
    }

    // ── Phase 3: Update glitch state ──────────────────────────────────────

    // Trigger a new burst on hard beats
    if (beatActive && beatIntensity > FusionMode.GLI_THRESHOLD &&
        !this._burst && Math.random() < FusionMode.GLI_CHANCE) {
      this._burst = {
        startTime: now,
        duration:  350 + beatIntensity * 600,
        intensity: beatIntensity,
        cx: Math.floor(Math.random() * cols),
        cy: Math.floor(Math.random() * rows),
      };
    }

    // Scatter glitch chars into the figure buffer on beats
    if (beatActive && beatIntensity > 0.40) {
      const count = Math.floor(beatIntensity * cols * rows * FusionMode.GLI_SCATTER);
      for (let i = 0; i < count; i++) {
        const gr = Math.floor(Math.random() * rows);
        const gc = Math.floor(Math.random() * cols);
        this._figure[gr][gc] = {
          char:       this._glitchChar(),
          brightness: 0.3 + Math.random() * 0.45,
        };
      }
    }

    // Horizontal tears copy a strip from one row into the row above
    if (beatActive && beatIntensity > 0.35) {
      for (let r = 1; r < rows; r++) {
        if (Math.random() < FusionMode.GLI_TEAR * beatIntensity) {
          const tearLen = Math.floor(4 + Math.random() * 14 * beatIntensity);
          const sc      = Math.floor(Math.random() * Math.max(1, cols - tearLen));
          for (let tc = sc; tc < Math.min(cols, sc + tearLen); tc++) {
            this._figure[r - 1][tc] = {
              char:       this._figure[r][tc].char,
              brightness: this._figure[r][tc].brightness * 0.65,
            };
          }
        }
      }
    }

    // ── Phase 4: Render — figure → rain → burst ───────────────────────────

    // 4a. Figure (background) — written first so rain can overwrite.
    //     Where a background image is loaded, luma at each cell biases brightness
    //     so bright image areas make the figure chars glow more.
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const cell = this._figure[r][c];
        if (cell.brightness > 0.02 && cell.char !== ' ') {
          const luma = bg.getLuma(c, r); // 0 when no image loaded
          setCell(c, r, cell.char, Math.min(1, cell.brightness + luma * FusionMode.BG_LUMA_BOOST));
        }
      }
    }

    // 4b. Rain (midground) — overwrites figure cells it passes through
    for (let c = 0; c < cols; c++) {
      const col     = this._rain[c];
      const headRow = Math.floor(col.headY);
      const binE    = spectrum[Math.min(spectrum.length - 1, Math.floor(Math.pow(col.binFrac, 1.8) * spectrum.length))] || 0;

      for (let t = 0; t < FusionMode.RAIN_TRAIL; t++) {
        const r = headRow - t;
        if (r < 0 || r >= rows) continue;

        let ch, brt;
        if (t === 0) {
          // Head: borrow figure char if overlapping, otherwise katakana
          const figCell = this._figure[r][c];
          ch  = (figCell.brightness > 0.1 && Math.random() < FusionMode.RAIN_INTERACT)
              ? figCell.char
              : this._katakana();
          brt = 1.0;
        } else {
          ch  = this._katakana();
          brt = Math.max(0, 1 - t / FusionMode.RAIN_TRAIL) * (0.5 + 0.5 * binE);
        }
        setCell(c, r, ch, brt);
      }
    }

    // 4c. Glitch burst (top layer)
    if (this._burst) {
      const progress = (now - this._burst.startTime) / this._burst.duration;
      if (progress >= 1.0) {
        this._burst = null;
      } else {
        const density = progress < 0.4 ? progress / 0.4 : (1 - progress) / 0.6;
        this._renderBurst(cols, rows, progress, density, this._burst);
      }
    }
  }

  // ── Burst renderer ────────────────────────────────────────────────────────
  // Expanding ring from a focal point + horizontal scan lines.

  _renderBurst(cols, rows, progress, density, burst) {
    const maxR  = Math.max(cols, rows) * 1.4;
    const ringR = progress * maxR;
    const aspY  = rows / cols;

    // Expanding dashed ring
    const pts = Math.max(4, Math.floor(ringR * Math.PI * 1.2 * density));
    for (let i = 0; i < pts; i++) {
      const a  = Math.random() * Math.PI * 2;
      const gr = Math.round(burst.cy + Math.sin(a) * ringR * aspY);
      const gc = Math.round(burst.cx + Math.cos(a) * ringR);
      if (gr >= 0 && gr < rows && gc >= 0 && gc < cols) {
        setCell(gc, gr, this._glitchChar(), 0.6 + Math.random() * 0.4 * density);
      }
    }

    // Horizontal scan-line flashes
    const lineCount = Math.floor(density * rows * 0.4 * burst.intensity);
    for (let i = 0; i < lineCount; i++) {
      const r   = Math.floor(Math.random() * rows);
      const len = Math.floor(cols * (0.12 + Math.random() * 0.5));
      const sc  = Math.floor(Math.random() * Math.max(1, cols - len));
      for (let c = sc; c < sc + len; c++) {
        setCell(c, r, this._glitchChar(), 0.3 + Math.random() * 0.7 * density);
      }
    }
  }
}
