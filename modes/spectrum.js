// modes/spectrum.js — FFT Spectrum Analyzer
// Logarithmic bin mapping, glitchy zone-based characters, peak hold, frequency labels.
// Bars are built from five vertical zones each with their own character pool and
// persistence rate — lower zones are sticky, upper zones flicker faster.

class SpectrumMode {
  constructor(config) {
    this.config    = config;
    this.peakHolds = [];
    this._cols     = 0;
    this._rows     = 0;
    this._frame    = 0;

    // Character pools per vertical zone (index 0 = bar bottom → 4 = bar top)
    this._zonePools = [
      '░▒·∙▂▃',             // 0: 0–20%   — dim atmospheric base
      '▒▓╱╲─│╬╪┼',          // 1: 20–45%  — texture / box fragments
      '▓█╬╪╠╣╦╩╔╗╚╝',       // 2: 45–65%  — dense structure
      '█◆●◎◉■▲▼◄►',         // 3: 65–85%  — bold shapes
      '★◆◉◎●■▲◆★',          // 4: 85%+    — hot sparkle (weighted toward ★◆)
    ];
    // How many frames a cell keeps its char before cycling to the next
    this._zoneCycles   = [7, 5, 3, 2, 1];
    // Base probability of randomly overriding the sticky char each frame
    this._zoneRandBase = [0.04, 0.10, 0.18, 0.30, 0.48];
    // Base brightness floor per zone
    this._zoneBright   = [0.17, 0.30, 0.46, 0.63, 0.82];

    // Bar head (topmost lit cell) — always freshly randomized, most dramatic
    this._headChars = '★◆●◉▲◆★◉';
    // Peak hold — slowly cycling glitch chars
    this._peakChars = '◆═▬─◈◇';
  }

  reset() {
    this._initPeaks(this._cols);
  }

  _initPeaks(cols) {
    this._cols     = cols;
    this.peakHolds = new Array(cols).fill(0);
  }

  update(grid, cols, rows, audio, bg) {
    if (cols !== this._cols) {
      this._initPeaks(cols);
    }
    this._rows = rows;
    this._frame++;

    const spectrum      = audio.getSpectrum();
    const specLen       = spectrum.length;
    const bands         = audio.getBands();
    const beatActive    = audio.beatActive;
    const beatIntensity = audio.beatIntensity;

    // Beat boost: ramps up randomness across all zones on a hit
    const beatBoost = beatActive ? Math.min(1, beatIntensity * 2.0) : 0;

    // Usable area: 2-col frame + 2-row labels
    const innerCols = cols - 4;
    const innerRows = rows - 5;
    const startCol  = 2;
    const startRow  = 2;

    if (innerCols <= 0 || innerRows <= 0) return;

    const logMin = Math.log10(20);
    const logMax = Math.log10(20000);

    for (let c = 0; c < innerCols; c++) {
      // Logarithmic frequency → FFT bin
      const logF   = logMin + (c / innerCols) * (logMax - logMin);
      const binF   = Math.pow(10, logF);
      const binHz  = 44100 / CONFIG.FFT_BINS;
      const binIdx = Math.min(specLen - 1, Math.max(0, Math.floor(binF / binHz)));

      // Average a window of bins for smoother response
      let val = 0, count = 0;
      const win = Math.max(1, Math.floor(binIdx * 0.1));
      for (let b = Math.max(0, binIdx - win); b <= Math.min(specLen - 1, binIdx + win); b++) {
        val += spectrum[b];
        count++;
      }
      val /= count;

      const barHeight = Math.floor(val * innerRows);
      const gridCol   = startCol + c;

      // Peak hold
      if (val > this.peakHolds[c]) {
        this.peakHolds[c] = val;
      } else {
        this.peakHolds[c] = Math.max(0, this.peakHolds[c] - CONFIG.PEAK_DECAY);
      }
      const peakRow = startRow + innerRows - 1 - Math.floor(this.peakHolds[c] * innerRows);

      // ── Draw bar cells bottom-up ──────────────────────────────────────────
      for (let r = 0; r < innerRows; r++) {
        const gridRow   = startRow + innerRows - 1 - r;
        const fillRatio = r / innerRows;  // 0 = bottom of bar area, 1 = top

        if (r >= barHeight) {
          setCell(gridCol, gridRow, ' ', 0);
          continue;
        }

        // Determine zone
        const zoneIdx = fillRatio < 0.20 ? 0
                      : fillRatio < 0.45 ? 1
                      : fillRatio < 0.65 ? 2
                      : fillRatio < 0.85 ? 3 : 4;

        const isHead = (r === barHeight - 1);

        let ch;
        if (isHead) {
          // Bar head — always live-randomized, full drama
          ch = this._headChars[Math.floor(Math.random() * this._headChars.length)];
        } else {
          const pool      = this._zonePools[zoneIdx];
          const randChance = this._zoneRandBase[zoneIdx] + beatBoost * 0.55;

          if (Math.random() < randChance) {
            // Random override — fully live char this frame
            ch = pool[Math.floor(Math.random() * pool.length)];
          } else {
            // Sticky char — changes every N frames for a persistence feel
            const seed = (c * 71 + r * 37 + Math.floor(this._frame / this._zoneCycles[zoneIdx]));
            ch = pool[seed % pool.length];
          }
        }

        // Brightness: zone floor + energy contribution + beat flash
        const brightness = Math.min(1.0,
          this._zoneBright[zoneIdx]
          + val * (0.55 - zoneIdx * 0.04)
          + beatBoost * 0.18
        );

        setCell(gridCol, gridRow, ch, brightness);
      }

      // ── Peak hold dot — glitchy, slowly cycling ───────────────────────────
      if (peakRow >= startRow && peakRow < startRow + innerRows && this.peakHolds[c] > 0.02) {
        const pkPool = this._peakChars;
        const pkCh   = Math.random() < 0.28
          ? pkPool[Math.floor(Math.random() * pkPool.length)]
          : pkPool[Math.floor(this._frame / 3) % pkPool.length];
        setCell(gridCol, peakRow, pkCh, 0.82 + beatBoost * 0.18);
      }
    }

    // ── Box frame ─────────────────────────────────────────────────────────────
    setString(startCol - 1, startRow - 1, '┌' + '─'.repeat(innerCols) + '┐', 0.3);
    setString(startCol - 1, startRow + innerRows, '└' + '─'.repeat(innerCols) + '┘', 0.3);
    for (let r = startRow; r < startRow + innerRows; r++) {
      setCell(startCol - 1, r, '│', 0.3);
      setCell(startCol + innerCols, r, '│', 0.3);
    }

    // ── Frequency labels ──────────────────────────────────────────────────────
    const labels = [
      { label: 'SUB',    freq: 40    },
      { label: 'BASS',   freq: 120   },
      { label: 'LO-MID', freq: 300   },
      { label: 'MID',    freq: 1000  },
      { label: 'HI-MID', freq: 3500  },
      { label: 'PRES',   freq: 8000  },
      { label: 'AIR',    freq: 16000 },
    ];

    const labelRow = startRow + innerRows + 1;
    if (labelRow < rows) {
      for (const lb of labels) {
        const logF = Math.log10(lb.freq);
        const t    = (logF - logMin) / (logMax - logMin);
        const lc   = startCol + Math.floor(t * innerCols) - Math.floor(lb.label.length / 2);
        if (lc >= 0 && lc + lb.label.length < cols) {
          setString(lc, labelRow, lb.label, 0.4);
        }
      }
    }

    // ── HUD ───────────────────────────────────────────────────────────────────
    const masterLevel = (bands.bass + bands.mid + bands.treble) / 3;
    const masterStr   = 'LVL:' + Math.floor(masterLevel * 100).toString().padStart(3, ' ') + '%';
    if (cols - masterStr.length - 1 > 0) {
      setString(cols - masterStr.length - 1, 0, masterStr, 0.5);
    }
    setString(startCol, 0, 'SPECTRUM ANALYZER', 0.4);
  }
}
