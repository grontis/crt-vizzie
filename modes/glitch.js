// modes/glitch.js — Glitch / Frame Buffer Decay Mode
// Persistent buffer with decay operations. CGA colors bypass phosphor palette.
// Beat-synced pulse waves, per-cell size variation, and rhythmic decay pulsing.
// Note: this mode sets window._glitchActive / _glitchColorGrid / _glitchSizeGrid for sketch.js.

class GlitchMode {
  constructor(config) {
    this.config = config;
    this._buffer = [];
    this._cols = 0;
    this._rows = 0;
    this._seedTimer = 0;
    this._frameCount = 0;
    this._hexChars = '0123456789ABCDEF';

    // Beat-sync state
    this._lastBeatTime  = 0;
    this._beatInterval  = 600;   // smoothed ms estimate of beat period
    this._pulseWaves    = [];    // { cx, cy, r, maxR, speed, intensity, colorBase }
    this._sizeGrid      = null;  // Float32Array[rows][cols] — per-cell size multiplier
  }

  reset() {
    this._initBuffer(this._cols, this._rows);
  }

  _initBuffer(cols, rows) {
    this._cols = cols;
    this._rows = rows;
    this._buffer = [];
    for (let r = 0; r < rows; r++) {
      this._buffer.push([]);
      for (let c = 0; c < cols; c++) {
        this._buffer[r].push({ char: ' ', colorIdx: 0, brightness: 0 });
      }
    }
    this._seedTimer  = 0;
    this._pulseWaves = [];
    this._sizeGrid   = Array.from({ length: rows }, () => new Float32Array(cols).fill(1.0));
  }

  _randomCGAChar() {
    const chars = '!@#$%^&*[]{}|\\/<>?~`+=-_░▒▓█▄▀■□▪▫◘◙◄►▲▼◆◇○●';
    return chars[Math.floor(Math.random() * chars.length)];
  }

  _seedHexDump(cols, rows) {
    const startRow = Math.floor(Math.random() * Math.max(1, rows - 8));
    const startCol = Math.floor(Math.random() * Math.max(1, cols - 30));
    for (let r = startRow; r < Math.min(rows, startRow + 6); r++) {
      const addr    = (r * 16).toString(16).toUpperCase().padStart(4, '0');
      const addrStr = addr + ': ';
      for (let c = 0; c < addrStr.length && startCol + c < cols; c++) {
        if (this._buffer[r]) {
          this._buffer[r][startCol + c] = {
            char: addrStr[c],
            colorIdx: Math.floor(Math.random() * 4) + 1,
            brightness: 0.7 + Math.random() * 0.3,
          };
        }
      }
      for (let b = 0; b < 16; b++) {
        const byteStr = Math.floor(Math.random() * 256).toString(16).toUpperCase().padStart(2, '0') + ' ';
        const bc = startCol + 6 + b * 3;
        for (let i = 0; i < byteStr.length && bc + i < cols; i++) {
          if (this._buffer[r]) {
            this._buffer[r][bc + i] = {
              char: byteStr[i],
              colorIdx: (Math.floor(Math.random() * 5) + 10),
              brightness: 0.5 + Math.random() * 0.5,
            };
          }
        }
      }
    }
  }

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
        if (this._buffer[row]) {
          this._buffer[row][c] = { char, colorIdx, brightness: r < barH ? 0.6 : 0.05 };
        }
      }
    }
  }

  update(grid, cols, rows, audio, bg) {
    if (cols !== this._cols || rows !== this._rows) {
      this._initBuffer(cols, rows);
    }

    const bands        = audio.getBands();
    const spectrum     = audio.getSpectrum();
    const beatActive   = audio.beatActive;
    const beatIntensity = audio.beatIntensity;
    this._frameCount++;

    // ── Beat timing ───────────────────────────────────────────────────────────
    const now = performance.now();
    if (beatActive) {
      if (this._lastBeatTime > 0) {
        const interval = now - this._lastBeatTime;
        if (interval > 200 && interval < 2000) {
          this._beatInterval = this._beatInterval * 0.75 + interval * 0.25;
        }
      }
      this._lastBeatTime = now;
    }

    // 0 = just after beat, 1 = just before next — used to breathe decay rate
    const beatPhase = (this._lastBeatTime > 0 && this._beatInterval > 0)
      ? Math.min(1, (now - this._lastBeatTime) / this._beatInterval)
      : 0;

    // ── Seed buffer ───────────────────────────────────────────────────────────
    this._seedTimer++;
    if (this._seedTimer >= CONFIG.GLITCH_SEED_INTERVAL || (beatActive && this._seedTimer > 20)) {
      this._seedTimer = 0;
      const choice = Math.floor(Math.random() * 3);
      if (choice === 0) {
        this._seedHexDump(cols, rows);
      } else if (choice === 1) {
        this._seedFromSpectrum(spectrum, cols, rows);
      } else {
        const fig   = AsciiArtLibrary.random();
        const frame = AsciiArtLibrary.getFrame(fig, 0);
        const startRow = Math.floor((rows - CONFIG.MORPH_HEIGHT) / 2);
        const startCol = Math.floor((cols - CONFIG.MORPH_WIDTH) / 2);
        for (let r = 0; r < frame.length; r++) {
          for (let c = 0; c < frame[r].length; c++) {
            const gr = startRow + r;
            const gc = startCol + c;
            if (gr >= 0 && gr < rows && gc >= 0 && gc < cols && this._buffer[gr]) {
              this._buffer[gr][gc] = {
                char: frame[r][c],
                colorIdx: Math.floor(Math.random() * 16),
                brightness: frame[r][c] === ' ' ? 0 : 0.8,
              };
            }
          }
        }
      }
    }

    // ── Beat reactions ────────────────────────────────────────────────────────
    if (beatActive) {
      // Random scatter burst
      const burstCount = Math.floor(beatIntensity * cols * rows * 0.06);
      for (let i = 0; i < burstCount; i++) {
        const r = Math.floor(Math.random() * rows);
        const c = Math.floor(Math.random() * cols);
        if (this._buffer[r]) {
          this._buffer[r][c] = {
            char: this._randomCGAChar(),
            colorIdx: Math.floor(Math.random() * 16),
            brightness: 0.7 + Math.random() * 0.3,
          };
        }
      }

      // Hard beat: horizontal blast strip
      if (beatIntensity > 0.6) {
        const blastRow   = Math.floor(Math.random() * rows);
        const blastLen   = Math.floor(beatIntensity * cols * 0.7);
        const blastStart = Math.floor(Math.random() * Math.max(1, cols - blastLen));
        for (let c = blastStart; c < Math.min(cols, blastStart + blastLen); c++) {
          if (this._buffer[blastRow]) {
            this._buffer[blastRow][c] = {
              char: this._randomCGAChar(),
              colorIdx: Math.floor(Math.random() * 16),
              brightness: 0.85 + Math.random() * 0.15,
            };
          }
        }
      }

      // Spawn expanding pulse wave from a focal point
      if (beatIntensity > 0.4) {
        const fx = Math.floor(Math.random() * cols);
        const fy = Math.floor(Math.random() * rows);
        this._pulseWaves.push({
          cx:        fx,
          cy:        fy,
          r:         0,
          maxR:      Math.max(cols, rows) * (0.45 + beatIntensity * 0.55),
          speed:     0.5 + beatIntensity * 2.0,
          intensity: beatIntensity,
          colorBase: Math.floor(Math.random() * 16),
        });

        // Boost size at focal point
        if (this._sizeGrid) {
          const radius = Math.floor(2 + beatIntensity * 5);
          for (let r = Math.max(0, fy - radius); r < Math.min(rows, fy + radius + 1); r++) {
            if (!this._sizeGrid[r]) continue;
            for (let c = Math.max(0, fx - radius); c < Math.min(cols, fx + radius + 1); c++) {
              const d = Math.sqrt((r - fy) ** 2 + (c - fx) ** 2);
              if (d < radius) {
                const boost = 1.0 + (1 - d / radius) * beatIntensity * 2.5;
                if (boost > this._sizeGrid[r][c]) this._sizeGrid[r][c] = boost;
              }
            }
          }
        }
      }
    }

    // ── Treble / highMid scattered noise ──────────────────────────────────────
    const airEnergy = bands.highMid * 0.5 + bands.treble * 0.5;
    if (airEnergy > 0.2) {
      const noiseCount = Math.floor(airEnergy * cols * 0.15);
      for (let i = 0; i < noiseCount; i++) {
        const r = Math.floor(Math.random() * rows);
        const c = Math.floor(Math.random() * cols);
        if (this._buffer[r]) {
          this._buffer[r][c] = {
            char: this._randomCGAChar(),
            colorIdx: Math.floor(Math.random() * 16),
            brightness: 0.3 + Math.random() * 0.5,
          };
        }
      }
    }

    // ── Pulse wave update & render ────────────────────────────────────────────
    const aspY = rows / cols;
    for (let wi = this._pulseWaves.length - 1; wi >= 0; wi--) {
      const w = this._pulseWaves[wi];
      w.r += w.speed;
      if (w.r > w.maxR) {
        this._pulseWaves.splice(wi, 1);
        continue;
      }
      const density = 1 - w.r / w.maxR;
      const pts = Math.max(3, Math.floor(w.r * Math.PI * 1.4 * density * w.intensity));
      for (let pi = 0; pi < pts; pi++) {
        const a  = Math.random() * Math.PI * 2;
        const gc = Math.round(w.cx + Math.cos(a) * w.r);
        const gr = Math.round(w.cy + Math.sin(a) * w.r * aspY);
        if (gc >= 0 && gc < cols && gr >= 0 && gr < rows && this._buffer[gr]) {
          const brt = (0.45 + Math.random() * 0.55) * density * w.intensity;
          if (brt > (this._buffer[gr][gc].brightness || 0)) {
            this._buffer[gr][gc] = {
              char: this._randomCGAChar(),
              colorIdx: (w.colorBase + Math.floor(Math.random() * 4)) % 16,
              brightness: brt,
            };
          }
          // Size boost at wavefront
          if (this._sizeGrid && this._sizeGrid[gr]) {
            const sizeBoost = 1.0 + density * w.intensity * 1.3;
            if (sizeBoost > this._sizeGrid[gr][gc]) this._sizeGrid[gr][gc] = sizeBoost;
          }
        }
      }
    }

    // ── Decay operations ──────────────────────────────────────────────────────
    const bassWeight  = Math.max(0.15, bands.bass);
    const totalEnergy = Math.max(0.1, (bands.bass + bands.mid + bands.treble) / 3);

    // Decay rate breathes with beat phase:
    // low (0.3) right after beat so chars pile up, higher (1.8) approaching next beat
    const phaseDecayMult = 0.3 + beatPhase * 1.5;

    for (let r = 0; r < rows; r++) {
      if (!this._buffer[r]) continue;
      for (let c = 0; c < cols; c++) {
        const cell = this._buffer[r][c];
        if (!cell) continue;

        cell.brightness = Math.max(0,
          cell.brightness - CONFIG.GLITCH_DECAY_RATE * (0.4 + 0.6 * totalEnergy) * phaseDecayMult
        );

        // Horizontal smear
        if (Math.random() < CONFIG.GLITCH_SMEAR_CHANCE * bassWeight && c + 1 < cols) {
          this._buffer[r][c + 1] = {
            char: cell.char,
            colorIdx: cell.colorIdx,
            brightness: cell.brightness * 0.75,
          };
        }

        // Downward smear
        if (Math.random() < CONFIG.GLITCH_SMEAR_CHANCE * 0.5 * airEnergy && r + 1 < rows) {
          this._buffer[r + 1][c] = {
            char: cell.char,
            colorIdx: (cell.colorIdx + 1) % 16,
            brightness: cell.brightness * 0.65,
          };
        }

        // Character substitution
        const substRate = 0.04 * bassWeight + 0.05 * bands.treble;
        if (Math.random() < substRate && cell.brightness > 0.1) {
          cell.char     = this._randomCGAChar();
          cell.colorIdx = Math.floor(Math.random() * 16);
        }

        // Vertical tear
        if (Math.random() < CONFIG.GLITCH_TEAR_CHANCE * bassWeight && r > 0) {
          const tearLength = Math.floor(Math.random() * 12 * (0.3 + beatIntensity)) + 2;
          for (let tc = c; tc < Math.min(cols, c + tearLength); tc++) {
            if (this._buffer[r - 1] && this._buffer[r][tc]) {
              this._buffer[r - 1][tc] = {
                char: this._buffer[r][tc].char,
                colorIdx: this._buffer[r][tc].colorIdx,
                brightness: this._buffer[r][tc].brightness * 0.65,
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

    // ── Size grid decay toward 1.0 ────────────────────────────────────────────
    if (this._sizeGrid) {
      for (let r = 0; r < rows; r++) {
        if (!this._sizeGrid[r]) continue;
        for (let c = 0; c < cols; c++) {
          if (this._sizeGrid[r][c] > 1.0) {
            this._sizeGrid[r][c] = Math.max(1.0, this._sizeGrid[r][c] - 0.08);
          }
        }
      }
    }

    // ── Write to grid + side channels ─────────────────────────────────────────
    window._glitchActive   = true;
    window._glitchSizeGrid = this._sizeGrid;

    if (!window._glitchColorGrid || window._glitchColorGrid.length !== rows) {
      window._glitchColorGrid = Array.from({ length: rows }, () => new Array(cols).fill(0));
    }

    for (let r = 0; r < rows; r++) {
      if (!this._buffer[r]) continue;
      if (!window._glitchColorGrid[r] || window._glitchColorGrid[r].length !== cols) {
        window._glitchColorGrid[r] = new Array(cols).fill(0);
      }
      for (let c = 0; c < cols; c++) {
        const cell = this._buffer[r][c];
        if (!cell) continue;
        if (cell.brightness > 0 && cell.char !== ' ') {
          setCell(c, r, cell.char, cell.brightness);
          window._glitchColorGrid[r][c] = cell.colorIdx;
        }
      }
    }
  }
}
