// v2/fusion.js — V2FusionMode
// Ports figure/rain/wave/glitch layer logic from modes/fusion.js.
//
// Key difference from v1: instead of calling setCell(), writes directly into
// typed arrays each frame:
//   Uint16Array charIdx[row*cols + col]   — atlas glyph index (0 = space)
//   Uint16Array bright16[row*cols + col]  — brightness * 65535
//   Uint8Array  cgaIdx[row*cols + col]    — CGA color index (0 = use phosphor)
//
// These arrays are passed to V2Renderer.upload() each frame.
// All tunable params read from window.V2_PARAMS (config.js).
//
// Load order: after config.js, ascii-art.js

'use strict';

const _warnedMissingChars = new Set();

function _charIdxOrWarn(charMap, ch) {
  if (charMap.has(ch)) return charMap.get(ch);
  if (!_warnedMissingChars.has(ch)) {
    _warnedMissingChars.add(ch);
    console.warn('[fusion] char not in atlas:', JSON.stringify(ch));
  }
  return 0;
}

class V2FusionMode {

  static GLI_CHARS = '!@#$%^&*[]{}|\\/<>?~`+=-_░▒▓█▄▀■□▪▫◘◙◄►▲▼◆◇○●αβγδλπφψΩΣ∂∇∆√∞∑≈≠≤≥±∈∅←↑↓→↔⇒';

  /**
   * @param {number} cols
   * @param {number} rows
   * @param {object} config — V2_CONFIG
   * @param {string[]} charset — full charset array (same order as atlas)
   */
  constructor(cols, rows, config, charset) {
    this._config  = config;
    this._cols    = 0;
    this._rows    = 0;

    // Typed output arrays (allocated in _init or reset)
    this.charIdx  = null; // Uint16Array
    this.bright16 = null; // Uint16Array
    this.cgaIdx   = null; // Uint8Array

    // Build charsetIndex lookup map: character → atlas index
    this._charMap = new Map();
    for (let i = 0; i < charset.length; i++) {
      this._charMap.set(charset[i], i);
    }
    // Fallback: space → 0 (assumed to be first char or a blank slot)
    if (!this._charMap.has(' ')) this._charMap.set(' ', 0);

    // Layer state — typed flat arrays (zero GC on resize/reset)
    // Figure layer: brightness + char atlas index per cell
    this._figureBright = null; // Float32Array(n)
    this._figureChar   = null; // Uint16Array(n)  — atlas char index
    // Rain layer: flat array of per-column state objects (one object per column)
    this._rain         = null;
    // Glitch layer: brightness + CGA index + char atlas index per cell
    this._glitchBright = null; // Float32Array(n)
    this._glitchCgaIdx = null; // Uint8Array(n)
    this._glitchChar   = null; // Uint16Array(n)  — atlas char index
    this._pulseWaves   = [];
    // Wave layer: char atlas index per cell
    this._waveCharIdx  = null; // Uint16Array(n)

    // Timers and beat state
    this._seedTimer        = 0;
    this._glitchSeedTimer  = 0;
    this._lastBeatTime     = 0;
    this._beatInterval     = 600;
    this._prevBeatActive   = false;

    // Wave state
    this._waveTime        = 0;
    this._waveBeatBoost   = 0;
    this._waveThreshBoost = 0;

    this._init(cols, rows);
  }

  // ── Public: reset on resize ──────────────────────────────────────────────

  reset(cols, rows) {
    this._init(cols, rows);
  }

  // ── Public: per-frame update ─────────────────────────────────────────────

  /**
   * @param {object} audio    — { spectrum, bands, beatActive, beatIntensity }
   * @param {number} cols
   * @param {number} rows
   * @param {V2BackgroundLayer|null} [bgLayer] — optional background luma source
   */
  update(audio, cols, rows, bgLayer = null) {
    if (cols !== this._cols || rows !== this._rows) {
      this._init(cols, rows);
    }

    const p             = window.V2_PARAMS;
    const bands         = audio.bands;
    const spectrum      = audio.spectrum;
    const beatActive    = audio.beatActive;
    const beatIntensity = audio.beatIntensity;
    const now           = performance.now();

    const beatRisingEdge = beatActive && !this._prevBeatActive;
    this._prevBeatActive = beatActive;

    // Track beat interval for timing-aware effects
    if (beatActive) {
      if (this._lastBeatTime > 0) {
        const iv = now - this._lastBeatTime;
        if (iv > 200 && iv < 2000) {
          this._beatInterval = this._beatInterval * 0.75 + iv * 0.25;
        }
      }
      this._lastBeatTime = now;
    }

    // Clear output arrays
    this.charIdx.fill(0);
    this.bright16.fill(0);
    this.cgaIdx.fill(0);

    // ── Phase 1: Update figure state ─────────────────────────────────────────

    if (p.figureEnabled) {
      this._seedTimer++;
      const forceReseed = beatActive && beatIntensity > 0.85 && this._seedTimer > 40;
      if (this._seedTimer >= p.figReseedFrames || forceReseed) {
        this._seedTimer = 0;
        this._stampFigure(cols, rows);
      }

      const totalEnergy = Math.max(0.1, (bands.bass + bands.mid + bands.treble) / 3);
      const decay = p.figDecay * (0.5 + 0.5 * totalEnergy);
      const smearChance = p.figSmear * Math.max(0.3, bands.bass);
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const idx = r * cols + c;
          const brt = this._figureBright[idx];
          // Decay
          const newBrt = Math.max(0, brt - decay);
          this._figureBright[idx] = newBrt;
          // Horizontal smear
          if (newBrt > 0.08 && this._figureChar[idx] !== 0 &&
              Math.random() < smearChance && c + 1 < cols) {
            const nIdx = idx + 1;
            if (this._figureBright[nIdx] < newBrt * 0.6) {
              this._figureChar[nIdx]   = this._figureChar[idx];
              this._figureBright[nIdx] = newBrt * 0.5;
            }
          }
        }
      }
    }

    // ── Phase 2: Update rain state ───────────────────────────────────────────

    if (p.rainEnabled) {
      if (beatActive) {
        for (const col of this._rain) {
          col.speed = Math.min(
            p.rainSpeedMax * p.rainBeatMult,
            col.speed * p.rainBeatMult
          );
        }
      }

      for (let c = 0; c < cols; c++) {
        const col = this._rain[c];

        if (!beatActive) {
          const logFrac = Math.pow(col.binFrac, 1.8);
          const specIdx = Math.min(spectrum.length - 1, Math.floor(logFrac * spectrum.length));
          const binE    = spectrum[specIdx] || 0;
          const target  = p.rainSpeedMin + binE * (p.rainSpeedMax - p.rainSpeedMin);
          col.speed += (target - col.speed) * 0.05;
          col.speed  = Math.max(p.rainSpeedMin * 0.5, col.speed);
        }

        col.headY += col.speed;
        if (col.headY > rows + p.rainTrail) {
          col.headY = Math.random() * -10;
          col.speed = p.rainSpeedMin + Math.random() * (p.rainSpeedMax - p.rainSpeedMin);
        }

        // Burn: boost figure brightness where the rain head touches
        const headRow = Math.floor(col.headY);
        if (headRow >= 0 && headRow < rows) {
          const figIdx = headRow * cols + c;
          if (this._figureBright[figIdx] > 0) {
            this._figureBright[figIdx] = Math.min(1.0, this._figureBright[figIdx] + p.rainBurnBoost);
          }
        }
      }
    }

    // ── Phase 2b: Update wave state ──────────────────────────────────────────

    if (p.waveEnabled) {
      if (beatRisingEdge) {
        this._waveBeatBoost   = Math.min(0.8, this._waveBeatBoost + p.waveBeatBoost * beatIntensity);
        this._waveThreshBoost = Math.min(0.5, this._waveThreshBoost + p.waveThreshDrop * beatIntensity);
      }
      this._waveTime       += p.waveSpeed + this._waveBeatBoost;
      this._waveBeatBoost   = Math.max(0, this._waveBeatBoost   - p.waveBeatDecay);
      this._waveThreshBoost = Math.max(0, this._waveThreshBoost - p.waveBeatDecay * 0.7);
    }

    // ── Phase 3: Update glitch state ─────────────────────────────────────────

    if (p.glitchEnabled) {
      const beatPhase = (this._lastBeatTime > 0 && this._beatInterval > 0)
        ? Math.min(1, (now - this._lastBeatTime) / this._beatInterval)
        : 0;
      const scaledIntensity = Math.min(1, beatIntensity * p.glitchIntensityScale);

      // Timer-based seeding
      this._glitchSeedTimer++;
      if (this._glitchSeedTimer >= p.glitchSeedInterval ||
          (beatActive && this._glitchSeedTimer > p.glitchBeatSeedMin)) {
        this._glitchSeedTimer = 0;
        const choice = Math.floor(Math.random() * 3);
        if (choice === 0) {
          this._seedHexDump(cols, rows);
        } else if (choice === 1) {
          this._seedFromSpectrum(spectrum, cols, rows);
        } else {
          this._seedGlitchFigure(cols, rows);
        }
      }

      // Beat reactions
      if (beatActive) {
        // Random scatter
        if (scaledIntensity > p.glitchScatterThreshold) {
          const count = Math.floor(scaledIntensity * cols * rows * p.glitchScatter);
          for (let i = 0; i < count; i++) {
            const gr  = Math.floor(Math.random() * rows);
            const gc  = Math.floor(Math.random() * cols);
            const idx = gr * cols + gc;
            this._glitchChar[idx]   = this._glitchCharIdx();
            this._glitchCgaIdx[idx] = Math.floor(Math.random() * 16);
            this._glitchBright[idx] = 0.4 + Math.random() * 0.5;
          }
        }

        // Horizontal blast strip on hard beats
        if (scaledIntensity > p.glitchBlastThreshold) {
          const blastRow   = Math.floor(Math.random() * rows);
          const blastLen   = Math.floor(scaledIntensity * cols * 0.65);
          const blastStart = Math.floor(Math.random() * Math.max(1, cols - blastLen));
          for (let bc = blastStart; bc < Math.min(cols, blastStart + blastLen); bc++) {
            const idx = blastRow * cols + bc;
            this._glitchChar[idx]   = this._glitchCharIdx();
            this._glitchCgaIdx[idx] = Math.floor(Math.random() * 16);
            this._glitchBright[idx] = 0.75 + Math.random() * 0.25;
          }
        }

        // Spawn pulse wave
        if (scaledIntensity > p.glitchThreshold && Math.random() < p.glitchChance) {
          this._pulseWaves.push({
            cx:        Math.floor(Math.random() * cols),
            cy:        Math.floor(Math.random() * rows),
            r:         0,
            maxR:      Math.max(cols, rows) * (0.4 + scaledIntensity * 0.6),
            speed:     0.4 + scaledIntensity * 1.8,
            intensity: scaledIntensity,
            colorBase: Math.floor(Math.random() * 16),
          });
        }
      }

      // Expand pulse waves
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
            const idx = gr * cols + gc;
            const brt = (0.4 + Math.random() * 0.6) * density * w.intensity;
            if (brt > this._glitchBright[idx]) {
              this._glitchChar[idx]   = this._glitchCharIdx();
              this._glitchCgaIdx[idx] = (w.colorBase + Math.floor(Math.random() * 4)) % 16;
              this._glitchBright[idx] = brt;
            }
          }
        }
      }

      // Treble noise
      const airEnergy = bands.highMid * 0.5 + bands.treble * 0.5;
      if (airEnergy > p.glitchTrebleFloor) {
        const noiseCount = Math.floor(airEnergy * cols * 0.15);
        for (let i = 0; i < noiseCount; i++) {
          const nr  = Math.floor(Math.random() * rows);
          const nc  = Math.floor(Math.random() * cols);
          const idx = nr * cols + nc;
          this._glitchChar[idx]   = this._glitchCharIdx();
          this._glitchCgaIdx[idx] = Math.floor(Math.random() * 16);
          this._glitchBright[idx] = 0.3 + Math.random() * 0.5;
        }
      }

      // Decay suite
      const glitchEnergy   = Math.max(0.1, (bands.bass + bands.mid + bands.treble) / 3);
      const bassWeight     = Math.max(0.15, bands.bass);
      const phaseDecayMult = 0.3 + beatPhase * 1.5;
      const decayAmount    = p.glitchDecayRate * (0.4 + 0.6 * glitchEnergy) * phaseDecayMult;
      const hSmearChance   = p.glitchSmearChance * bassWeight;
      const vSmearChance   = p.glitchSmearChance * 0.5 * airEnergy;
      const substRate      = 0.04 * bassWeight + 0.05 * bands.treble;
      const tearChance     = p.glitchTear * bassWeight;
      const dropChance     = p.glitchDropChance * bassWeight;

      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const idx = r * cols + c;
          const brt = this._glitchBright[idx];

          const newBrt = Math.max(0, brt - decayAmount);
          this._glitchBright[idx] = newBrt;

          // Horizontal smear
          if (Math.random() < hSmearChance && c + 1 < cols) {
            const nIdx = idx + 1;
            this._glitchChar[nIdx]   = this._glitchChar[idx];
            this._glitchCgaIdx[nIdx] = this._glitchCgaIdx[idx];
            this._glitchBright[nIdx] = newBrt * 0.75;
          }

          // Downward smear
          if (Math.random() < vSmearChance && r + 1 < rows) {
            const dIdx = (r + 1) * cols + c;
            this._glitchChar[dIdx]   = this._glitchChar[idx];
            this._glitchCgaIdx[dIdx] = (this._glitchCgaIdx[idx] + 1) % 16;
            this._glitchBright[dIdx] = newBrt * 0.65;
          }

          // Char substitution
          if (Math.random() < substRate && newBrt > 0.1) {
            this._glitchChar[idx]   = this._glitchCharIdx();
            this._glitchCgaIdx[idx] = Math.floor(Math.random() * 16);
          }

          // Vertical tear
          if (Math.random() < tearChance && r > 0) {
            const tearLength = Math.floor(Math.random() * 12 * (0.3 + beatIntensity)) + 2;
            for (let tc = c; tc < Math.min(cols, c + tearLength); tc++) {
              const srcIdx = idx - c + tc; // r*cols + tc
              const dstIdx = srcIdx - cols; // (r-1)*cols + tc
              this._glitchChar[dstIdx]   = this._glitchChar[srcIdx];
              this._glitchCgaIdx[dstIdx] = this._glitchCgaIdx[srcIdx];
              this._glitchBright[dstIdx] = this._glitchBright[srcIdx] * 0.65;
            }
          }

          // Dropout
          if (Math.random() < dropChance) {
            this._glitchBright[idx] = 0;
          }
        }
      }
    } else {
      this._pulseWaves      = [];
      this._glitchSeedTimer = 0;
    }

    // ── Phase 4: Render — bgAscii → figure → wave → rain → glitch ──────────

    // 4a. bgAscii layer (bottom of stack — runs before figure so other layers overwrite it)
    if (p.bgAsciiEnabled && bgLayer && bgLayer.isLoaded) {
      const rampPreset = p.bgAsciiRampPreset | 0;
      if (rampPreset !== this._bgAsciiLastPreset) {
        this._buildBgAsciiRamp();
      }
      const effectiveLevel = Math.min(1.0, p.bgAsciiLevel + p._bgAsciiAudioAdd);
      if (effectiveLevel > 0.01) {
        for (let r = 0; r < rows; r++) {
          for (let c = 0; c < cols; c++) {
            const idx = r * cols + c;
            let luma  = bgLayer.getLuma(c, r);
            if (p.bgAsciiInvert) luma = 1.0 - luma;
            const rampIdx    = Math.min(255, Math.floor(luma * 255));
            const charAtlasIdx = this._bgAsciiRamp[rampIdx];
            if (charAtlasIdx !== 0) {
              this._setCellByIdx(idx, charAtlasIdx, luma * effectiveLevel, 0);
            }
          }
        }
      }
    }

    // 4b. Figure
    if (p.figureEnabled) {
      const figOp = p.figOpacity;
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const idx = r * cols + c;
          const brt = this._figureBright[idx];
          if (brt > 0.02 && this._figureChar[idx] !== 0) {
            this._setCellByIdx(idx, this._figureChar[idx], Math.min(1, brt * figOp), 0);
          }
        }
      }
    }

    // 4c. Wave
    if (p.waveEnabled) {
      const t         = this._waveTime;
      const threshold = Math.max(0.1, p.waveThreshold - this._waveThreshBoost);
      const op        = p.waveOpacity;
      const bassE     = bands.bass;
      const trebleE   = bands.treble;
      const midE      = bands.mid;
      const TWO_PI    = Math.PI * 2;

      const cx = cols * 0.5 + Math.sin(t * 0.011) * cols * 0.3;
      const cy = rows * 0.5 + Math.cos(t * 0.007) * rows * 0.3;

      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const cn   = c / cols * TWO_PI;
          const rn   = r / rows * TWO_PI;
          const dx   = (c - cx) / cols * TWO_PI;
          const dy   = (r - cy) / rows * TWO_PI;
          const dist = Math.sqrt(dx * dx + dy * dy);

          const field =
            Math.sin(cn * 2.0 + t * 0.7)                          * 0.22 +
            Math.sin(cn * 1.5 + rn * 1.0 + t * 0.5)              * 0.20 +
            Math.sin(rn * 2.5 - t * 0.4 + bassE * Math.PI)        * 0.22 +
            Math.sin(dist * 2.0 - t * 1.1 + trebleE * Math.PI)    * 0.18 +
            Math.sin(cn * 1.2 - rn * 1.8 + t * 0.6 + midE * 0.5) * 0.18;

          const norm = (field + 1) * 0.5;
          if (norm > threshold) {
            const idx = r * cols + c;
            if (Math.random() < p.waveCharRate) {
              this._waveCharIdx[idx] = this._katakanaIdx();
            }
            this._setCellByIdx(idx, this._waveCharIdx[idx],
              (norm - threshold) / (1 - threshold) * op, 0);
          }
        }
      }
    }

    // 4d. Rain
    if (p.rainEnabled) {
      const rainOp = p.rainOpacity;
      for (let c = 0; c < cols; c++) {
        const col     = this._rain[c];
        const headRow = Math.floor(col.headY);
        const binE    = spectrum[Math.min(spectrum.length - 1,
          Math.floor(Math.pow(col.binFrac, 1.8) * spectrum.length))] || 0;

        for (let t = 0; t < p.rainTrail; t++) {
          const r = headRow - t;
          if (r < 0 || r >= rows) continue;

          const cellIdx = r * cols + c;
          let charAtlasIdx, brt;
          if (t === 0) {
            const figBrt = this._figureBright[cellIdx];
            charAtlasIdx = (figBrt > 0.1 && Math.random() < p.rainInteract)
                ? this._figureChar[cellIdx]
                : this._katakanaIdx();
            brt = 1.0;
          } else {
            charAtlasIdx = this._katakanaIdx();
            brt = Math.max(0, 1 - t / p.rainTrail) * (0.5 + 0.5 * binE);
          }
          this._setCellByIdx(cellIdx, charAtlasIdx, brt * rainOp, 0);
        }
      }
    }

    // 4e. Glitch buffer (top layer)
    if (p.glitchEnabled) {
      const useCGA = p.glitchCgaEnabled;
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const idx = r * cols + c;
          const brt = this._glitchBright[idx];
          if (brt > 0.02 && this._glitchChar[idx] !== 0) {
            const cga = useCGA ? this._glitchCgaIdx[idx] : 0;
            this._setCellByIdx(idx, this._glitchChar[idx], brt, cga);
          }
        }
      }
    }

  }

  // ── Private helpers ──────────────────────────────────────────────────────

  /**
   * Write a cell by its flat array index (row*cols+col) — avoids re-computing idx.
   * charAtlasIdx must already be resolved to an atlas index.
   */
  _setCellByIdx(idx, charAtlasIdx, brightness, cgaIndex) {
    if (idx < 0 || idx >= this.charIdx.length) return;
    this.charIdx[idx]  = charAtlasIdx;
    this.bright16[idx] = Math.floor(Math.max(0, Math.min(1, brightness)) * 65535);
    this.cgaIdx[idx]   = cgaIndex & 0xFF;
  }

  /**
   * Write a cell by col/row coordinates, converting char to atlas index.
   * Used by seeding helpers that work with character strings.
   */
  _setCell(col, row, char, brightness, cgaIndex) {
    const idx = row * this._cols + col;
    if (idx < 0 || idx >= this.charIdx.length) return;
    const charAtlasIdx = this._charMap.get(char) || 0;
    this.charIdx[idx]  = charAtlasIdx;
    this.bright16[idx] = Math.floor(Math.max(0, Math.min(1, brightness)) * 65535);
    this.cgaIdx[idx]   = cgaIndex & 0xFF;
  }

  /** Return a random glitch char as atlas index. */
  _glitchCharIdx() {
    const s = V2FusionMode.GLI_CHARS;
    return this._charMap.get(s[Math.floor(Math.random() * s.length)]) || 0;
  }

  /** Return a random katakana char as atlas index. */
  _katakanaIdx() {
    const pool = this._config.KATAKANA;
    return this._charMap.get(pool[Math.floor(Math.random() * pool.length)]) || 0;
  }

  // ── Initialization ───────────────────────────────────────────────────────

  _init(cols, rows) {
    this._cols = cols;
    this._rows = rows;

    const n = cols * rows;

    // Output arrays
    this.charIdx  = new Uint16Array(n);
    this.bright16 = new Uint16Array(n);
    this.cgaIdx   = new Uint8Array(n);

    // Figure layer: typed flat arrays (zero GC on reset)
    this._figureBright = new Float32Array(n); // all zeroed
    this._figureChar   = new Uint16Array(n);  // all 0 = space

    // Rain: flat array of column-state objects — one per column (not per cell)
    this._rain = Array.from({ length: cols }, (_, c) => this._makeRainCol(rows, c, cols));

    // Glitch layer: typed flat arrays
    this._glitchBright = new Float32Array(n);
    this._glitchCgaIdx = new Uint8Array(n);
    this._glitchChar   = new Uint16Array(n);

    // Wave layer: char atlas index per cell, pre-filled with random katakana
    this._waveCharIdx = new Uint16Array(n);
    for (let i = 0; i < n; i++) {
      this._waveCharIdx[i] = this._katakanaIdx();
    }

    this._pulseWaves      = [];
    this._glitchSeedTimer = 0;
    this._seedTimer       = 0;
    this._waveTime        = 0;
    this._waveBeatBoost   = 0;
    this._waveThreshBoost = 0;

    // bgAscii layer state
    this._bgAsciiRamp       = new Uint16Array(256);
    this._bgAsciiLastPreset = -1; // -1 forces rebuild on first update
    this._buildBgAsciiRamp();

    this._stampFigure(cols, rows);
  }

  /**
   * Build the 256-entry bgAscii density ramp lookup table.
   * Maps luma values [0..255] to atlas character indices using the configured
   * density ramp string. Rebuilt when bgAsciiRampPreset changes.
   */
  _buildBgAsciiRamp() {
    const preset  = window.V2_PARAMS.bgAsciiRampPreset | 0;
    const ramps   = window.V2_CONFIG.ASCII_DENSITY_RAMPS;
    const rampStr = ramps[Math.min(preset, ramps.length - 1)];
    const len     = rampStr.length;
    for (let i = 0; i < 256; i++) {
      const charIdx = Math.min(len - 1, Math.floor((i / 255) * (len - 1)));
      const ch      = rampStr[charIdx];
      this._bgAsciiRamp[i] = this._charMap.get(ch) ?? 0;
    }
    this._bgAsciiLastPreset = preset;
  }

  _makeRainCol(rows, colIdx, totalCols) {
    const p = window.V2_PARAMS;
    const range = p.rainSpeedMax - p.rainSpeedMin;
    return {
      headY:   Math.random() * -rows,
      speed:   p.rainSpeedMin + Math.random() * range,
      binFrac: colIdx / Math.max(1, totalCols - 1),
    };
  }

  _stampFigure(cols, rows) {
    const cfg   = this._config;
    const p     = window.V2_PARAMS;
    const fig   = AsciiArtLibrary.random();
    const frame = AsciiArtLibrary.getFrame(fig, 0);
    const sr    = Math.floor((rows - cfg.MORPH_HEIGHT) / 2);
    const sc    = Math.floor((cols - cfg.MORPH_WIDTH)  / 2);
    for (let r = 0; r < frame.length; r++) {
      for (let c = 0; c < frame[r].length; c++) {
        const gr = sr + r, gc = sc + c;
        if (gr < 0 || gr >= rows || gc < 0 || gc >= cols) continue;
        const ch = frame[r][c];
        if (ch !== ' ') {
          const idx = gr * cols + gc;
          this._figureChar[idx]   = _charIdxOrWarn(this._charMap, ch);
          this._figureBright[idx] = p.figBrightness;
        }
      }
    }
  }

  _seedHexDump(cols, rows) {
    const startRow = Math.floor(Math.random() * Math.max(1, rows - 8));
    const startCol = Math.floor(Math.random() * Math.max(1, cols - 30));
    for (let r = startRow; r < Math.min(rows, startRow + 6); r++) {
      const addr    = (r * 16).toString(16).toUpperCase().padStart(4, '0');
      const addrStr = addr + ': ';
      for (let c = 0; c < addrStr.length && startCol + c < cols; c++) {
        const col = startCol + c;
        if (col < cols) {
          const idx = r * cols + col;
          this._glitchChar[idx]   = this._charMap.get(addrStr[c]) || 0;
          this._glitchCgaIdx[idx] = Math.floor(Math.random() * 4) + 1;
          this._glitchBright[idx] = 0.7 + Math.random() * 0.3;
        }
      }
      for (let b = 0; b < 16; b++) {
        const byteStr = Math.floor(Math.random() * 256).toString(16).toUpperCase().padStart(2, '0') + ' ';
        const bc = startCol + 6 + b * 3;
        for (let i = 0; i < byteStr.length && bc + i < cols; i++) {
          const idx = r * cols + bc + i;
          this._glitchChar[idx]   = this._charMap.get(byteStr[i]) || 0;
          this._glitchCgaIdx[idx] = Math.floor(Math.random() * 5) + 10;
          this._glitchBright[idx] = 0.5 + Math.random() * 0.5;
        }
      }
    }
  }

  _seedFromSpectrum(spectrum, cols, rows) {
    const startRow = Math.floor(rows * 0.3);
    const barRows  = Math.floor(rows * 0.5);
    const barChar  = this._charMap.get('█') || 0;
    const dotChar  = this._charMap.get('·') || 0;
    for (let c = 0; c < cols; c++) {
      const specIdx = Math.floor((c / cols) * spectrum.length);
      const val     = spectrum[specIdx] || 0;
      const barH    = Math.floor(val * barRows);
      for (let r = 0; r < barRows; r++) {
        const row = startRow + barRows - 1 - r;
        if (row < 0 || row >= rows) continue;
        const idx = row * cols + c;
        if (r < barH) {
          this._glitchChar[idx]   = barChar;
          this._glitchCgaIdx[idx] = (c % 4) + 9;
          this._glitchBright[idx] = 0.6;
        } else {
          this._glitchChar[idx]   = dotChar;
          this._glitchCgaIdx[idx] = 0;
          this._glitchBright[idx] = 0.05;
        }
      }
    }
  }

  _seedGlitchFigure(cols, rows) {
    const cfg      = this._config;
    const fig      = AsciiArtLibrary.random();
    const frame    = AsciiArtLibrary.getFrame(fig, 0);
    const startRow = Math.floor((rows - cfg.MORPH_HEIGHT) / 2);
    const startCol = Math.floor((cols - cfg.MORPH_WIDTH)  / 2);
    for (let r = 0; r < frame.length; r++) {
      for (let c = 0; c < frame[r].length; c++) {
        const gr = startRow + r, gc = startCol + c;
        if (gr >= 0 && gr < rows && gc >= 0 && gc < cols) {
          const idx = gr * cols + gc;
          const ch  = frame[r][c];
          this._glitchChar[idx]   = _charIdxOrWarn(this._charMap, ch);
          this._glitchCgaIdx[idx] = Math.floor(Math.random() * 16);
          this._glitchBright[idx] = ch === ' ' ? 0 : 0.8;
        }
      }
    }
  }
}
