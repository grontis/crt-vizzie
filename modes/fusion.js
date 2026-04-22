// modes/fusion.js — Fusion Mode: ASCII Art + Matrix Rain + Glitch Corruption + BG Modulation
//
// Four layered systems rendered into a single grid each frame:
//   FIGURE : A centered ASCII art figure that slowly decays and gets reseeded
//   RAIN   : Matrix-style falling columns that burn through and interact with the figure
//   GLITCH : Beat-triggered corruption — persistent buffer with pulse waves, smear, and decay
//   BG     : Background image modulation mirroring VJ sync — kick-driven opacity pulse,
//            treble-triggered stutter, and per-cell luma sampling to bias figure brightness
//
// Rendering order: figure (background) → rain (midground) → glitch buffer (top)
// All tunable constants live in window.FUSION_PARAMS (fusion-params.js).
// Default values are shown as comments beside each static field declaration below.

class FusionMode {

  // ── Figure layer ──────────────────────────────────────────────────────────
  // static FIG_DECAY       = 0.007;  // brightness lost per frame — lower = figure lingers longer
  // static FIG_RESEED_F    = 160;    // frames between automatic figure reseeds
  // static FIG_BRIGHTNESS  = 0.65;   // brightness when a figure is first stamped in
  // static FIG_SMEAR       = 0.025;  // per-cell chance per frame to smear char to right neighbor
  // static FIG_OPACITY     = 1.0;    // global brightness multiplier for figure cells

  // ── Rain layer ────────────────────────────────────────────────────────────
  // static RAIN_SPEED_MIN  = 0.15;
  // static RAIN_SPEED_MAX  = 0.90;
  // static RAIN_BEAT_MULT  = 3.2;    // speed multiplier on beat
  // static RAIN_TRAIL      = 14;     // cells behind the head that form the trail
  // static RAIN_INTERACT   = 0.50;   // chance the rain head borrows the figure char it overlaps
  // static RAIN_BURN_BOOST = 0.20;   // brightness added to figure cell when rain head touches it
  // static RAIN_OPACITY    = 1.0;    // global brightness multiplier for rain cells

  // ── Glitch layer ──────────────────────────────────────────────────────────
  // static GLI_THRESHOLD   = 0.62;   // beatIntensity needed to trigger a pulse wave
  // static GLI_CHANCE      = 0.55;   // probability a pulse wave fires when threshold is met
  // static GLI_SCATTER     = 0.045;  // fraction of cells scattered on a hard beat
  // static GLI_TEAR        = 0.020;  // per-row horizontal tear probability on beat
  static GLI_CHARS       = '!@#$%^&*[]{}|\\/<>?~`+=-_░▒▓█▄▀■□▪▫◘◙◄►▲▼◆◇○●';

  // ── Background layer ──────────────────────────────────────────────────────
  // static BG_KICK_SUB     = 0.50;   // sub threshold for kick detection
  // static BG_KICK_BASS    = 0.40;   // bass threshold for kick detection
  // static BG_PULSE_AMOUNT = 0.18;   // opacity added on each kick
  // static BG_PULSE_DECAY  = 0.04;   // opacity units recovered per frame after a pulse
  // static BG_TREBLE_THRESH = 0.39;  // treble level that triggers a stutter
  // static BG_STUTTER_FRAMES = 14;   // frames of stutter window (~230ms at 60fps)
  // static BG_STUTTER_CHANCE = 0.45; // per-frame probability of flipping visibility during stutter
  // static BG_STUTTER_DWELL = 1500;  // minimum ms between stutter events
  // static BG_LUMA_BOOST   = 0.35;   // max extra brightness added to figure cells by luma sampling

  // ─────────────────────────────────────────────────────────────────────────

  constructor(config) {
    this.config        = config;
    this._cols         = 0;
    this._rows         = 0;
    this._figure       = [];   // [rows][cols] { char, brightness } — the persistent art layer
    this._rain         = [];   // per-column rain state
    this._glitchBuffer    = [];   // [rows][cols] { char, colorIdx, brightness } — persistent glitch layer
    this._pulseWaves      = [];   // expanding ring waves: { cx, cy, r, maxR, speed, intensity, colorBase }
    this._sizeGrid        = [];   // per-cell size multiplier (Float32Array per row)
    this._glitchSeedTimer = 0;    // timer for content-type seeding (separate from _seedTimer)
    this._seedTimer       = 0;
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
    this._glitchBuffer = Array.from({ length: rows }, () =>
      Array.from({ length: cols }, () => ({ char: ' ', colorIdx: 0, brightness: 0 }))
    );
    this._pulseWaves      = [];
    this._sizeGrid        = Array.from({ length: rows }, () => new Float32Array(cols).fill(1.0));
    this._glitchSeedTimer = 0;
    this._seedTimer       = 0;
    this._bgPulseActive   = 0;
    this._bgStutterFrames = 0;
    this._stampFigure(cols, rows);
  }

  _makeRainCol(rows, colIdx, totalCols) {
    const range = FUSION_PARAMS.rainSpeedMax - FUSION_PARAMS.rainSpeedMin;
    return {
      headY:   Math.random() * -rows,
      speed:   FUSION_PARAMS.rainSpeedMin + Math.random() * range,
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
          this._figure[gr][gc] = { char: ch, brightness: FUSION_PARAMS.figBrightness };
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
    return bands.sub  > FUSION_PARAMS.bgKickSub &&
           bands.bass > FUSION_PARAMS.bgKickBass;
  }

  // Ported from GlitchMode — seeds glitch buffer with hex dump content
  _seedHexDump(cols, rows) {
    const startRow = Math.floor(Math.random() * Math.max(1, rows - 8));
    const startCol = Math.floor(Math.random() * Math.max(1, cols - 30));
    for (let r = startRow; r < Math.min(rows, startRow + 6); r++) {
      const addr    = (r * 16).toString(16).toUpperCase().padStart(4, '0');
      const addrStr = addr + ': ';
      for (let c = 0; c < addrStr.length && startCol + c < cols; c++) {
        if (this._glitchBuffer[r]) {
          this._glitchBuffer[r][startCol + c] = {
            char:       addrStr[c],
            colorIdx:   Math.floor(Math.random() * 4) + 1,
            brightness: 0.7 + Math.random() * 0.3,
          };
        }
      }
      for (let b = 0; b < 16; b++) {
        const byteStr = Math.floor(Math.random() * 256).toString(16).toUpperCase().padStart(2, '0') + ' ';
        const bc = startCol + 6 + b * 3;
        for (let i = 0; i < byteStr.length && bc + i < cols; i++) {
          if (this._glitchBuffer[r]) {
            this._glitchBuffer[r][bc + i] = {
              char:       byteStr[i],
              colorIdx:   Math.floor(Math.random() * 5) + 10,
              brightness: 0.5 + Math.random() * 0.5,
            };
          }
        }
      }
    }
  }

  // Ported from GlitchMode — seeds glitch buffer with spectrum bar chart
  _seedFromSpectrum(spectrum, cols, rows) {
    const startRow = Math.floor(rows * 0.3);
    const barRows  = Math.floor(rows * 0.5);
    for (let c = 0; c < cols; c++) {
      const idx  = Math.floor((c / cols) * spectrum.length);
      const val  = spectrum[idx] || 0;
      const barH = Math.floor(val * barRows);
      for (let r = 0; r < barRows; r++) {
        const row = startRow + barRows - 1 - r;
        if (row < 0 || row >= rows) continue;
        const char     = r < barH ? '█' : '·';
        const colorIdx = r < barH ? (c % 4) + 9 : 0;
        if (this._glitchBuffer[row]) {
          this._glitchBuffer[row][c] = { char, colorIdx, brightness: r < barH ? 0.6 : 0.05 };
        }
      }
    }
  }

  // ── Background modulation ─────────────────────────────────────────────────
  // Mirrors the two VJ sync background effects: kick pulse and treble stutter.
  // Must be called every frame so in-progress pulses and stutters finish cleanly.

  _updateBackground(bg, bands, beatRisingEdge, now) {
    if (!bg.hasMedia) return;

    // Kick pulse — boost opacity on each kick, decay back each frame
    if (beatRisingEdge && this._isKick(bands)) {
      const add = FUSION_PARAMS.bgPulseAmount;
      this._bgPulseActive = Math.min(1.0, this._bgPulseActive + add);
      bg.adjustOpacity(add);
    }
    if (this._bgPulseActive > 0) {
      const decay = Math.min(this._bgPulseActive, FUSION_PARAMS.bgPulseDecay);
      bg.adjustOpacity(-decay);
      this._bgPulseActive -= decay;
    }

    // Treble stutter — trigger on rising edge of treble threshold
    const treble = bands.treble;
    if (treble > FUSION_PARAMS.bgTrebleThresh &&
        this._prevTreble <= FUSION_PARAMS.bgTrebleThresh &&
        this._bgStutterFrames === 0 &&
        now - this._lastBgStutter >= FUSION_PARAMS.bgStutterDwell &&
        bg.isVisible) {
      this._bgStutterFrames = FUSION_PARAMS.bgStutterFrames;
      this._lastBgStutter   = now;
    }
    this._prevTreble = treble;

    // Advance stutter — randomly flip visibility each frame, guarantee restore on expiry
    if (this._bgStutterFrames > 0) {
      this._bgStutterFrames--;
      if (this._bgStutterFrames === 0) {
        if (!bg.isVisible) bg.toggle(); // ensure restored
      } else if (Math.random() < FUSION_PARAMS.bgStutterChance) {
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

    // ── Background modulation (runs every frame when enabled) ──────────────
    if (FUSION_PARAMS.bgEnabled) {
      this._updateBackground(bg, bands, beatRisingEdge, now);
    }

    // ── Phase 1: Update figure state ───────────────────────────────────────

    if (FUSION_PARAMS.figureEnabled) {
      this._seedTimer++;
      const forceReseed = beatActive && beatIntensity > 0.85 && this._seedTimer > 40;
      if (this._seedTimer >= FUSION_PARAMS.figReseedFrames || forceReseed) {
        this._seedTimer = 0;
        this._stampFigure(cols, rows);
      }

      const totalEnergy = Math.max(0.1, (bands.bass + bands.mid + bands.treble) / 3);
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const cell = this._figure[r][c];
          // Decay — faster when there's more audio energy
          cell.brightness = Math.max(0, cell.brightness - FUSION_PARAMS.figDecay * (0.5 + 0.5 * totalEnergy));
          // Bass-driven horizontal smear
          if (cell.brightness > 0.08 && cell.char !== ' ' &&
              Math.random() < FUSION_PARAMS.figSmear * Math.max(0.3, bands.bass) && c + 1 < cols) {
            const nb = this._figure[r][c + 1];
            if (nb.brightness < cell.brightness * 0.6) {
              nb.char       = cell.char;
              nb.brightness = cell.brightness * 0.5;
            }
          }
        }
      }
    }

    // ── Phase 2: Update rain state ─────────────────────────────────────────

    if (FUSION_PARAMS.rainEnabled) {
      if (beatActive) {
        for (const col of this._rain) {
          col.speed = Math.min(
            FUSION_PARAMS.rainSpeedMax * FUSION_PARAMS.rainBeatMult,
            col.speed * FUSION_PARAMS.rainBeatMult
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
          const target  = FUSION_PARAMS.rainSpeedMin + binE * (FUSION_PARAMS.rainSpeedMax - FUSION_PARAMS.rainSpeedMin);
          col.speed += (target - col.speed) * 0.05;
          col.speed  = Math.max(FUSION_PARAMS.rainSpeedMin * 0.5, col.speed);
        }

        col.headY += col.speed;
        if (col.headY > rows + FUSION_PARAMS.rainTrail) {
          col.headY = Math.random() * -10;
          col.speed = FUSION_PARAMS.rainSpeedMin + Math.random() * (FUSION_PARAMS.rainSpeedMax - FUSION_PARAMS.rainSpeedMin);
        }

        // Burn: boost figure brightness where the rain head touches
        const headRow = Math.floor(col.headY);
        if (headRow >= 0 && headRow < rows) {
          const figCell = this._figure[headRow][c];
          if (figCell.brightness > 0) {
            figCell.brightness = Math.min(1.0, figCell.brightness + FUSION_PARAMS.rainBurnBoost);
          }
        }
      }
    }

    // ── Phase 3: Update glitch state ──────────────────────────────────────
    //
    // Full GlitchMode-style: timer-based seeding, continuous treble noise,
    // beat reactions with CGA colorIdx, expanding pulse waves with colorBase,
    // per-cell size grid, and complete decay suite (brightness + horiz smear +
    // downward smear + char substitution + vertical tear + dropout), all
    // modulated by beatPhase. The glitch buffer is composited as the top layer —
    // it never writes into the figure buffer, keeping layers cleanly separated.

    if (FUSION_PARAMS.glitchEnabled) {

      // Beat phase: 0 = just after beat, 1 = just before next
      const beatPhase = (this._lastBeatTime > 0 && this._beatInterval > 0)
        ? Math.min(1, (now - this._lastBeatTime) / this._beatInterval)
        : 0;

      // Timer-based seeding (hex dump / spectrum / ASCII art)
      this._glitchSeedTimer++;
      if (this._glitchSeedTimer >= FUSION_PARAMS.glitchSeedInterval ||
          (beatActive && this._glitchSeedTimer > 20)) {
        this._glitchSeedTimer = 0;
        const choice = Math.floor(Math.random() * 3);
        if (choice === 0) {
          this._seedHexDump(cols, rows);
        } else if (choice === 1) {
          this._seedFromSpectrum(spectrum, cols, rows);
        } else {
          // ASCII art seed
          const fig      = AsciiArtLibrary.random();
          const frame    = AsciiArtLibrary.getFrame(fig, 0);
          const startRow = Math.floor((rows - this.config.MORPH_HEIGHT) / 2);
          const startCol = Math.floor((cols - this.config.MORPH_WIDTH)  / 2);
          for (let r = 0; r < frame.length; r++) {
            for (let c = 0; c < frame[r].length; c++) {
              const gr = startRow + r, gc = startCol + c;
              if (gr >= 0 && gr < rows && gc >= 0 && gc < cols) {
                this._glitchBuffer[gr][gc] = {
                  char:       frame[r][c],
                  colorIdx:   Math.floor(Math.random() * 16),
                  brightness: frame[r][c] === ' ' ? 0 : 0.8,
                };
              }
            }
          }
        }
      }

      // Beat reactions — seed glitch buffer with CGA colorIdx
      if (beatActive) {

        // Random scatter
        if (beatIntensity > 0.35) {
          const count = Math.floor(beatIntensity * cols * rows * FUSION_PARAMS.glitchScatter);
          for (let i = 0; i < count; i++) {
            const gr = Math.floor(Math.random() * rows);
            const gc = Math.floor(Math.random() * cols);
            this._glitchBuffer[gr][gc] = {
              char:       this._glitchChar(),
              colorIdx:   Math.floor(Math.random() * 16),
              brightness: 0.4 + Math.random() * 0.5,
            };
          }
        }

        // Horizontal blast strip on hard beats
        if (beatIntensity > 0.55) {
          const blastRow   = Math.floor(Math.random() * rows);
          const blastLen   = Math.floor(beatIntensity * cols * 0.65);
          const blastStart = Math.floor(Math.random() * Math.max(1, cols - blastLen));
          for (let bc = blastStart; bc < Math.min(cols, blastStart + blastLen); bc++) {
            this._glitchBuffer[blastRow][bc] = {
              char:       this._glitchChar(),
              colorIdx:   Math.floor(Math.random() * 16),
              brightness: 0.75 + Math.random() * 0.25,
            };
          }
        }

        // Spawn expanding pulse wave from random focal point
        if (beatIntensity > FUSION_PARAMS.glitchThreshold && Math.random() < FUSION_PARAMS.glitchChance) {
          const wx = Math.floor(Math.random() * cols);
          const wy = Math.floor(Math.random() * rows);
          this._pulseWaves.push({
            cx:        wx,
            cy:        wy,
            r:         0,
            maxR:      Math.max(cols, rows) * (0.4 + beatIntensity * 0.6),
            speed:     0.4 + beatIntensity * 1.8,
            intensity: beatIntensity,
            colorBase: Math.floor(Math.random() * 16),
          });

          // Boost size at focal point
          if (this._sizeGrid) {
            const radius = Math.floor(2 + beatIntensity * 5);
            for (let r = Math.max(0, wy - radius); r < Math.min(rows, wy + radius + 1); r++) {
              for (let c = Math.max(0, wx - radius); c < Math.min(cols, wx + radius + 1); c++) {
                const d = Math.sqrt((r - wy) ** 2 + (c - wx) ** 2);
                if (d < radius) {
                  const boost = 1.0 + (1 - d / radius) * beatIntensity * 2.5;
                  if (boost > this._sizeGrid[r][c]) this._sizeGrid[r][c] = boost;
                }
              }
            }
          }
        }
      }

      // Pulse waves — expand and write to glitch buffer with CGA colorIdx
      const aspY = rows / cols;
      for (let wi = this._pulseWaves.length - 1; wi >= 0; wi--) {
        const w = this._pulseWaves[wi];
        w.r += w.speed;
        if (w.r > w.maxR) { this._pulseWaves.splice(wi, 1); continue; }
        const density = 1 - w.r / w.maxR;
        const pts = Math.max(3, Math.floor(w.r * Math.PI * 1.4 * density * w.intensity));
        for (let pi = 0; pi < pts; pi++) {
          const a  = Math.random() * Math.PI * 2;
          const gc = Math.round(w.cx + Math.cos(a) * w.r);
          const gr = Math.round(w.cy + Math.sin(a) * w.r * aspY);
          if (gc >= 0 && gc < cols && gr >= 0 && gr < rows) {
            const brt = (0.4 + Math.random() * 0.6) * density * w.intensity;
            if (brt > this._glitchBuffer[gr][gc].brightness) {
              this._glitchBuffer[gr][gc] = {
                char:     this._glitchChar(),
                colorIdx: (w.colorBase + Math.floor(Math.random() * 4)) % 16,
                brightness: brt,
              };
            }
            // Size boost on wavefront cells
            if (this._sizeGrid && this._sizeGrid[gr]) {
              const sizeBoost = 1.0 + density * w.intensity * 1.3;
              if (sizeBoost > this._sizeGrid[gr][gc]) this._sizeGrid[gr][gc] = sizeBoost;
            }
          }
        }
      }

      // Treble / highMid scattered noise — every frame when air energy is high
      const airEnergy = bands.highMid * 0.5 + bands.treble * 0.5;
      if (airEnergy > 0.2) {
        const noiseCount = Math.floor(airEnergy * cols * 0.15);
        for (let i = 0; i < noiseCount; i++) {
          const nr = Math.floor(Math.random() * rows);
          const nc = Math.floor(Math.random() * cols);
          this._glitchBuffer[nr][nc] = {
            char:       this._glitchChar(),
            colorIdx:   Math.floor(Math.random() * 16),
            brightness: 0.3 + Math.random() * 0.5,
          };
        }
      }

      // Full decay suite — beatPhase-modulated brightness fade, horiz smear,
      // downward smear, char substitution, vertical tear, dropout
      const glitchEnergy   = Math.max(0.1, (bands.bass + bands.mid + bands.treble) / 3);
      const bassWeight     = Math.max(0.15, bands.bass);
      const phaseDecayMult = 0.3 + beatPhase * 1.5;

      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const cell = this._glitchBuffer[r][c];

          // Brightness decay — breathes with beat phase
          cell.brightness = Math.max(0,
            cell.brightness - CONFIG.GLITCH_DECAY_RATE * (0.4 + 0.6 * glitchEnergy) * phaseDecayMult
          );

          // Horizontal smear — propagate colorIdx
          if (Math.random() < CONFIG.GLITCH_SMEAR_CHANCE * bassWeight && c + 1 < cols) {
            this._glitchBuffer[r][c + 1] = {
              char:       cell.char,
              colorIdx:   cell.colorIdx,
              brightness: cell.brightness * 0.75,
            };
          }

          // Downward smear — shift colorIdx by 1
          if (Math.random() < CONFIG.GLITCH_SMEAR_CHANCE * 0.5 * airEnergy && r + 1 < rows) {
            this._glitchBuffer[r + 1][c] = {
              char:       cell.char,
              colorIdx:   (cell.colorIdx + 1) % 16,
              brightness: cell.brightness * 0.65,
            };
          }

          // Character substitution
          const substRate = 0.04 * bassWeight + 0.05 * bands.treble;
          if (Math.random() < substRate && cell.brightness > 0.1) {
            cell.char     = this._glitchChar();
            cell.colorIdx = Math.floor(Math.random() * 16);
          }

          // Vertical tear
          if (Math.random() < FUSION_PARAMS.glitchTear * bassWeight && r > 0) {
            const tearLength = Math.floor(Math.random() * 12 * (0.3 + beatIntensity)) + 2;
            for (let tc = c; tc < Math.min(cols, c + tearLength); tc++) {
              if (this._glitchBuffer[r - 1]) {
                this._glitchBuffer[r - 1][tc] = {
                  char:       this._glitchBuffer[r][tc].char,
                  colorIdx:   this._glitchBuffer[r][tc].colorIdx,
                  brightness: this._glitchBuffer[r][tc].brightness * 0.65,
                };
              }
            }
          }

          // Dropout
          if (Math.random() < CONFIG.GLITCH_DROP_CHANCE * bassWeight) {
            cell.brightness = 0;
          }
        }
      }

      // Size grid decay toward 1.0
      if (this._sizeGrid) {
        for (let r = 0; r < rows; r++) {
          for (let c = 0; c < cols; c++) {
            if (this._sizeGrid[r][c] > 1.0) {
              this._sizeGrid[r][c] = Math.max(1.0, this._sizeGrid[r][c] - 0.08);
            }
          }
        }
      }

    } else {
      // Clear waves and timers so they don't linger when layer is re-enabled
      this._pulseWaves      = [];
      this._glitchSeedTimer = 0;
      window._fusionGlitchActive = false;
    }

    // ── Phase 4: Render — figure → rain → glitch ──────────────────────────

    // 4a. Figure (background) — written first so rain/glitch can overwrite.
    //     Where a background image is loaded, luma at each cell biases brightness
    //     so bright image areas make the figure chars glow more.
    if (FUSION_PARAMS.figureEnabled) {
      const figOp = FUSION_PARAMS.figOpacity;
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const cell = this._figure[r][c];
          if (cell.brightness > 0.02 && cell.char !== ' ') {
            const luma = bg.getLuma(c, r); // 0 when no image loaded
            setCell(c, r, cell.char, Math.min(1, (cell.brightness + luma * FUSION_PARAMS.bgLumaBoost) * figOp));
          }
        }
      }
    }

    // 4b. Rain (midground) — overwrites figure cells it passes through
    if (FUSION_PARAMS.rainEnabled) {
      const rainOp = FUSION_PARAMS.rainOpacity;
      for (let c = 0; c < cols; c++) {
        const col     = this._rain[c];
        const headRow = Math.floor(col.headY);
        const binE    = spectrum[Math.min(spectrum.length - 1, Math.floor(Math.pow(col.binFrac, 1.8) * spectrum.length))] || 0;

        for (let t = 0; t < FUSION_PARAMS.rainTrail; t++) {
          const r = headRow - t;
          if (r < 0 || r >= rows) continue;

          let ch, brt;
          if (t === 0) {
            // Head: borrow figure char if overlapping, otherwise katakana
            const figCell = this._figure[r][c];
            ch  = (figCell.brightness > 0.1 && Math.random() < FUSION_PARAMS.rainInteract)
                ? figCell.char
                : this._katakana();
            brt = 1.0;
          } else {
            ch  = this._katakana();
            brt = Math.max(0, 1 - t / FUSION_PARAMS.rainTrail) * (0.5 + 0.5 * binE);
          }
          setCell(c, r, ch, brt * rainOp);
        }
      }
    }

    // 4c. Glitch buffer (top layer) — CGA-colored via sparse side-channel
    if (FUSION_PARAMS.glitchEnabled) {
      const useCGA = FUSION_PARAMS.glitchCgaEnabled;

      // Ensure side-channel arrays exist and are sized correctly; fill sentinel each frame
      if (useCGA) {
        if (!window._fusionGlitchColorGrid || window._fusionGlitchColorGrid.length !== rows) {
          window._fusionGlitchColorGrid = Array.from({ length: rows }, () => new Array(cols).fill(-1));
        }
        for (let r = 0; r < rows; r++) {
          if (!window._fusionGlitchColorGrid[r] || window._fusionGlitchColorGrid[r].length !== cols) {
            window._fusionGlitchColorGrid[r] = new Array(cols).fill(-1);
          } else {
            window._fusionGlitchColorGrid[r].fill(-1); // reset to sentinel each frame
          }
        }
        window._fusionGlitchSizeGrid = this._sizeGrid;
        window._fusionGlitchActive   = true;
      }

      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const cell = this._glitchBuffer[r][c];
          if (cell.brightness > 0.02 && cell.char !== ' ') {
            setCell(c, r, cell.char, cell.brightness);
            if (useCGA && window._fusionGlitchColorGrid[r]) {
              window._fusionGlitchColorGrid[r][c] = cell.colorIdx;
            }
          }
        }
      }
    }
  }
}
