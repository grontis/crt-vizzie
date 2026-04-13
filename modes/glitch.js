// modes/glitch.js — Glitch / Frame Buffer Decay Mode
// Persistent buffer with decay operations. CGA colors bypass phosphor palette.
// Note: this mode sets window._glitchColors for sketch.js to pick up per-cell.

class GlitchMode {
  constructor(config) {
    this.config = config;
    this._buffer = [];      // buffer[row][col] = { char, colorIdx, brightness }
    this._cols = 0;
    this._rows = 0;
    this._seedTimer = 0;
    this._frameCount = 0;
    this._hexChars = '0123456789ABCDEF';
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
    this._seedTimer = 0;
  }

  _randomCGAChar() {
    const chars = '!@#$%^&*[]{}|\\/<>?~`+=-_░▒▓█▄▀■□▪▫◘◙◄►▲▼◆◇○●';
    return chars[Math.floor(Math.random() * chars.length)];
  }

  _seedHexDump(cols, rows) {
    // Fill a region with hex dump style text
    const startRow = Math.floor(Math.random() * Math.max(1, rows - 8));
    const startCol = Math.floor(Math.random() * Math.max(1, cols - 30));
    for (let r = startRow; r < Math.min(rows, startRow + 6); r++) {
      // Address
      const addr = (r * 16).toString(16).toUpperCase().padStart(4, '0');
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
      // Hex bytes
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
    // Draw a rough spectrum snapshot into the buffer using CGA colors
    const startRow = Math.floor(rows * 0.3);
    const barRows = Math.floor(rows * 0.5);
    for (let c = 0; c < cols; c++) {
      const idx = Math.floor((c / cols) * spectrum.length);
      const val = spectrum[idx] || 0;
      const barH = Math.floor(val * barRows);
      for (let r = 0; r < barRows; r++) {
        const row = startRow + barRows - 1 - r;
        if (row < 0 || row >= rows) continue;
        const char = r < barH ? '█' : '·';
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

    const bands = audio.getBands();
    const spectrum = audio.getSpectrum();
    const beatActive = audio.beatActive;
    const beatIntensity = audio.beatIntensity;
    this._frameCount++;

    // Seed buffer periodically or on hard beat
    this._seedTimer++;
    if (this._seedTimer >= CONFIG.GLITCH_SEED_INTERVAL || (beatActive && this._seedTimer > 20)) {
      this._seedTimer = 0;
      const choice = Math.floor(Math.random() * 3);
      if (choice === 0) {
        this._seedHexDump(cols, rows);
      } else if (choice === 1) {
        this._seedFromSpectrum(spectrum, cols, rows);
      } else {
        // Seed with a morph figure
        const fig = AsciiArtLibrary.random();
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

    // Beat-triggered scatter burst — proportional to beat intensity
    if (beatActive) {
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

      // Hard beat: blast a horizontal strip of chars
      if (beatIntensity > 0.6) {
        const blastRow = Math.floor(Math.random() * rows);
        const blastLen = Math.floor(beatIntensity * cols * 0.7);
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
    }

    // High treble/highMid energy injects scattered noise chars
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

    // Apply decay operations each frame
    const bassWeight = Math.max(0.15, bands.bass);
    const totalEnergy = Math.max(0.1, (bands.bass + bands.mid + bands.treble) / 3);

    for (let r = 0; r < rows; r++) {
      if (!this._buffer[r]) continue;
      for (let c = 0; c < cols; c++) {
        const cell = this._buffer[r][c];
        if (!cell) continue;

        // Brightness decay — slower at low energy so chars accumulate
        cell.brightness = Math.max(0, cell.brightness - CONFIG.GLITCH_DECAY_RATE * (0.4 + 0.6 * totalEnergy));

        // Horizontal smear: copy to right neighbor
        if (Math.random() < CONFIG.GLITCH_SMEAR_CHANCE * bassWeight && c + 1 < cols) {
          this._buffer[r][c + 1] = {
            char: cell.char,
            colorIdx: cell.colorIdx,
            brightness: cell.brightness * 0.75,
          };
        }

        // Downward smear driven by highMid/treble
        if (Math.random() < CONFIG.GLITCH_SMEAR_CHANCE * 0.5 * airEnergy && r + 1 < rows) {
          this._buffer[r + 1][c] = {
            char: cell.char,
            colorIdx: (cell.colorIdx + 1) % 16,
            brightness: cell.brightness * 0.65,
          };
        }

        // CGA character substitution — bass drives low chars, treble drives high-freq flicker
        const substRate = 0.04 * bassWeight + 0.05 * bands.treble;
        if (Math.random() < substRate && cell.brightness > 0.1) {
          cell.char = this._randomCGAChar();
          cell.colorIdx = Math.floor(Math.random() * 16);
        }

        // Vertical tear: copy row up — length scales with beat intensity
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

        // Dropout: random cells go dark
        if (Math.random() < CONFIG.GLITCH_DROP_CHANCE * bassWeight) {
          cell.brightness = 0;
        }
      }
    }

    // Write buffer to grid with CGA color info stored in a side channel
    // sketch.js reads window._glitchActive and window._glitchColorGrid
    window._glitchActive = true;
    if (!window._glitchColorGrid || window._glitchColorGrid.length !== rows) {
      window._glitchColorGrid = Array.from({ length: rows }, () => new Array(cols).fill(0));
    }

    for (let r = 0; r < rows; r++) {
      if (!this._buffer[r]) continue;
      // Resize color grid row if needed
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
