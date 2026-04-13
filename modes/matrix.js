// modes/matrix.js — Digital Rain Mode
// Per-column falling character rain with beat reactions and bass energy bar.

class MatrixMode {
  constructor(config) {
    this.config = config;
    this.columns = [];
    this.codeFragments = [];
    this._cols = 0;
    this._rows = 0;
  }

  reset() {
    this._initColumns(this._cols, this._rows);
  }

  _initColumns(cols, rows) {
    this._cols = cols;
    this._rows = rows;
    this.columns = [];
    for (let c = 0; c < cols; c++) {
      this.columns.push(this._makeColumn(rows, c, cols));
    }
    this.codeFragments = [];
  }

  _makeColumn(rows, colIdx, totalCols) {
    return {
      headY: Math.random() * -rows,
      speed: CONFIG.MATRIX_SPEED_MIN + Math.random() * (CONFIG.MATRIX_SPEED_MAX - CONFIG.MATRIX_SPEED_MIN),
      trail: [],
      glitchTimer: 0,
      glitchLines: null,
      // Per-column vibration state
      vibOffset: 0,        // current horizontal draw offset (-2..+2)
      vibVelocity: 0,      // spring velocity for vibration
      vibTarget: 0,        // target offset
      vibTimer: 0,         // countdown until next vibration kick
      // Per-column frequency bin (maps column to a spectrum slice)
      binFrac: colIdx / Math.max(1, totalCols - 1),
      // Mutation rate multiplier (driven by treble)
      mutationBoost: 0,
      // Stutter state — low freq peak causes column to freeze briefly
      stutterFrames: 0,
    };
  }

  _randomKatakana() {
    const pool = CONFIG.KATAKANA;
    return pool[Math.floor(Math.random() * pool.length)];
  }

  _makeCodeFragment(rows) {
    const fragments = [
      '0xDEADBEEF', 'NULL', 'SIGKILL', 'OVERFLOW',
      'ACCESS::OK', 'ERR::404', 'SYN+ACK', 'RST+FIN',
      '0xFF00FF', 'KERNEL', 'MALLOC', 'REALLOC',
    ];
    const text = fragments[Math.floor(Math.random() * fragments.length)];
    const startRow = Math.floor(Math.random() * Math.max(1, rows - text.length));
    return { text, startRow, timer: 30 };
  }

  update(grid, cols, rows, audio, bg) {
    // Reinit if grid size changed
    if (cols !== this._cols || rows !== this._rows) {
      this._initColumns(cols, rows);
    }

    const bands    = audio.getBands();
    const spectrum = audio.getSpectrum();
    const beatActive    = audio.beatActive;
    const beatIntensity = audio.beatIntensity;

    // Global vibration strength from sub+bass
    const subBass = Math.max(0, bands.sub * 0.5 + bands.bass * 0.5);
    // Treble-driven mutation boost (global floor, columns add more via their bin)
    const globalMutation = bands.treble * 0.6 + bands.highMid * 0.3;

    // On beat: speed up all columns, possibly spawn code fragment
    if (beatActive) {
      for (const col of this.columns) {
        col.speed = Math.min(
          CONFIG.MATRIX_SPEED_MAX * CONFIG.MATRIX_BEAT_MULT,
          col.speed * CONFIG.MATRIX_BEAT_MULT
        );
      }
      // Hard beat: random column shows code fragment
      if (beatIntensity > 0.7) {
        const c = Math.floor(Math.random() * cols);
        this.columns[c].glitchTimer = 30;
        this.columns[c].glitchLines = this._makeCodeFragment(rows);
      }
    }

    for (let c = 0; c < cols; c++) {
      const col = this.columns[c];

      // ── Per-column spectrum energy ──────────────────────────────────────
      // Map this column's bin fraction logarithmically (bass-weighted) to spectrum
      const logBinFrac = Math.pow(col.binFrac, 1.8);
      const specIdx = Math.min(spectrum.length - 1, Math.floor(logBinFrac * spectrum.length));
      // Average a small window around the bin
      let binEnergy = 0;
      const w = Math.max(1, Math.floor(specIdx * 0.08) + 1);
      for (let b = Math.max(0, specIdx - w); b <= Math.min(spectrum.length - 1, specIdx + w); b++) {
        binEnergy += spectrum[b];
      }
      binEnergy /= (w * 2 + 1);

      // ── Speed: blend beat decay with per-bin energy boost ───────────────
      if (!beatActive) {
        const baseTarget = CONFIG.MATRIX_SPEED_MIN +
          Math.random() * 0.3 * (CONFIG.MATRIX_SPEED_MAX - CONFIG.MATRIX_SPEED_MIN);
        const energyBoost = binEnergy * (CONFIG.MATRIX_SPEED_MAX - CONFIG.MATRIX_SPEED_MIN) * 1.2;
        col.speed += (baseTarget + energyBoost - col.speed) * 0.04;
        col.speed = Math.max(CONFIG.MATRIX_SPEED_MIN * 0.5, col.speed);
      }

      // ── Stutter: low-freq / sub energy causes brief freeze ──────────────
      if (col.stutterFrames > 0) {
        col.stutterFrames--;
        // Column is frozen — still draw it but don't advance headY
      } else {
        // Trigger stutter on sub/bass spike for bass-range columns
        if (col.binFrac < 0.15 && subBass > 0.55 && Math.random() < subBass * 0.08) {
          col.stutterFrames = Math.floor(2 + Math.random() * 4 * subBass);
        }
      }

      // ── Vibration: sub/bass shakes columns horizontally ─────────────────
      col.vibTimer--;
      if (col.vibTimer <= 0) {
        // Schedule next kick — more frequent with high sub/bass
        col.vibTimer = Math.floor(4 + Math.random() * 10 * (1 - subBass));
        if (subBass > 0.25) {
          // Kick: set a new random target offset proportional to energy
          const maxShift = Math.min(2, Math.floor(1 + subBass * 2.5));
          col.vibTarget = (Math.random() < 0.5 ? -1 : 1) * Math.floor(Math.random() * (maxShift + 1));
        } else {
          col.vibTarget = 0;
        }
      }
      // Spring toward target with damping
      col.vibVelocity += (col.vibTarget - col.vibOffset) * 0.6;
      col.vibVelocity *= 0.45;
      col.vibOffset = Math.round(col.vibOffset + col.vibVelocity);
      // Hard clamp
      col.vibOffset = Math.max(-2, Math.min(2, col.vibOffset));

      // ── Mutation boost for this column ──────────────────────────────────
      col.mutationBoost += (globalMutation + binEnergy * 0.4 - col.mutationBoost) * 0.15;

      // ── Advance head (skip if stuttering) ───────────────────────────────
      if (col.stutterFrames === 0) {
        col.headY += col.speed;
      }
      if (col.headY > rows + CONFIG.MATRIX_TRAIL_LENGTH) {
        col.headY = Math.random() * -10;
        col.speed = CONFIG.MATRIX_SPEED_MIN + Math.random() * (CONFIG.MATRIX_SPEED_MAX - CONFIG.MATRIX_SPEED_MIN);
        col.glitchTimer = 0;
        col.glitchLines = null;
      }

      // Decrement glitch timer
      if (col.glitchTimer > 0) col.glitchTimer--;

      const headRow   = Math.floor(col.headY);
      const drawCol   = Math.max(0, Math.min(cols - 1, c + col.vibOffset));
      const trailLen  = CONFIG.MATRIX_TRAIL_LENGTH;

      // ── Draw code fragment if active ─────────────────────────────────────
      if (col.glitchTimer > 0 && col.glitchLines) {
        const frag = col.glitchLines;
        for (let i = 0; i < frag.text.length; i++) {
          const r = frag.startRow + i;
          if (r >= 0 && r < rows) {
            const brightness = i === 0 ? 1.0 : 0.6;
            setCell(drawCol, r, frag.text[i], brightness);
          }
        }
        continue;
      }

      // ── Draw trail ───────────────────────────────────────────────────────
      // Brightness ceiling scales with per-column bin energy
      const energyBright = 0.55 + 0.45 * binEnergy;

      for (let t = 0; t < trailLen; t++) {
        const r = headRow - t;
        if (r < 0 || r >= rows) continue;

        let char, brightness;
        if (t === 0) {
          // Head — always bright white
          char = this._randomKatakana();
          brightness = 1.0;
        } else {
          // Mutation rate: base chance + per-column boost
          const mutChance = 0.04 + col.mutationBoost * 0.35;
          char = Math.random() < mutChance ? this._randomKatakana() : this._randomKatakana();
          brightness = Math.max(0, 1 - t / trailLen) * energyBright;
        }
        setCell(drawCol, r, char, brightness);
      }

      // ── Stutter flash: brief bright row when column snaps back ───────────
      if (col.stutterFrames === 1 && headRow >= 0 && headRow < rows) {
        // One frame of extra brightness at the head when stutter releases
        setCell(drawCol, headRow, this._randomKatakana(), 1.0);
        setCell(drawCol, Math.max(0, headRow - 1), this._randomKatakana(), 0.9);
      }
    }

    // ── Bass energy bar on bottom row ────────────────────────────────────────
    const bassLevel = bands.bass;
    const barWidth = Math.floor(bassLevel * cols);
    for (let c = 0; c < cols; c++) {
      const brightness = c < barWidth ? (0.4 + 0.6 * bassLevel) : 0.1;
      const char = c < barWidth ? '█' : '▁';
      setCell(c, rows - 1, char, brightness);
    }
  }
}
