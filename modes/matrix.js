// modes/matrix.js — Digital Rain Mode
// Per-column falling character rain with beat reactions, bass energy bar,
// and glitch bursts that warp columns and flood the screen with noise on hard beats.

class MatrixMode {
  constructor(config) {
    this.config     = config;
    this.columns    = [];
    this._cols      = 0;
    this._rows      = 0;
    this._burst     = null;   // null | { startTime, duration, intensity, cx, cy }
    this._noiseChars = '!@#$%^&*<>?/|~░▒▓█▄▀■□◆' + CONFIG.KATAKANA.slice(0, 22).join('');
  }

  reset() {
    this._initColumns(this._cols, this._rows);
  }

  _initColumns(cols, rows) {
    this._cols  = cols;
    this._rows  = rows;
    this._burst = null;
    this.columns = [];
    for (let c = 0; c < cols; c++) {
      this.columns.push(this._makeColumn(rows, c, cols));
    }
  }

  _makeColumn(rows, colIdx, totalCols) {
    return {
      headY:        Math.random() * -rows,
      speed:        CONFIG.MATRIX_SPEED_MIN + Math.random() * (CONFIG.MATRIX_SPEED_MAX - CONFIG.MATRIX_SPEED_MIN),
      glitchTimer:  0,
      glitchLines:  null,
      vibOffset:    0,
      vibVelocity:  0,
      vibTarget:    0,
      vibTimer:     0,
      binFrac:      colIdx / Math.max(1, totalCols - 1),
      mutationBoost: 0,
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
    const text     = fragments[Math.floor(Math.random() * fragments.length)];
    const startRow = Math.floor(Math.random() * Math.max(1, rows - text.length));
    return { text, startRow, timer: 30 };
  }

  // ── Glitch burst overlay ──────────────────────────────────────────────────
  // Expanding ring + scan lines + scatter — same language as the boot glitch.

  _renderBurst(cols, rows, progress, density, burst) {
    const nc  = this._noiseChars;
    const rnd = () => nc[Math.floor(Math.random() * nc.length)];

    // Expanding ring radiating from the focal point.
    // Points are placed randomly on the circumference so it reads as a dashed ring.
    const maxR   = Math.max(cols, rows) * 1.4;
    const ringR  = progress * maxR;
    const pts    = Math.max(4, Math.floor(ringR * Math.PI * 1.2 * density));
    const aspY   = rows / cols;  // compensate for non-square cell aspect ratio
    for (let i = 0; i < pts; i++) {
      const a  = Math.random() * Math.PI * 2;
      const gr = Math.round(burst.cy + Math.sin(a) * ringR * aspY);
      const gc = Math.round(burst.cx + Math.cos(a) * ringR);
      if (gr >= 0 && gr < rows && gc >= 0 && gc < cols) {
        setCell(gc, gr, rnd(), 0.6 + Math.random() * 0.4 * density);
      }
    }

    // Horizontal scan-line bursts
    const lineCount = Math.floor(density * rows * 0.5 * burst.intensity);
    for (let i = 0; i < lineCount; i++) {
      const r   = Math.floor(Math.random() * rows);
      const len = Math.floor(cols * (0.2 + Math.random() * 0.65));
      const sc  = Math.floor(Math.random() * Math.max(1, cols - len));
      for (let c = sc; c < sc + len; c++) {
        setCell(c, r, rnd(), 0.35 + Math.random() * 0.65 * density);
      }
    }

    // Scattered individual chars
    const scatter = Math.floor(density * cols * rows * 0.10 * burst.intensity);
    for (let i = 0; i < scatter; i++) {
      setCell(
        Math.floor(Math.random() * cols),
        Math.floor(Math.random() * rows),
        rnd(),
        0.25 + Math.random() * 0.75 * density
      );
    }
  }

  // ── Main update ───────────────────────────────────────────────────────────

  update(grid, cols, rows, audio, bg) {
    if (cols !== this._cols || rows !== this._rows) {
      this._initColumns(cols, rows);
    }

    const bands        = audio.getBands();
    const spectrum     = audio.getSpectrum();
    const beatActive   = audio.beatActive;
    const beatIntensity = audio.beatIntensity;

    const subBass      = Math.max(0, bands.sub * 0.5 + bands.bass * 0.5);
    const globalMutation = bands.treble * 0.6 + bands.highMid * 0.3;

    // ── Beat reactions ────────────────────────────────────────────────────
    if (beatActive) {
      for (const col of this.columns) {
        col.speed = Math.min(
          CONFIG.MATRIX_SPEED_MAX * CONFIG.MATRIX_BEAT_MULT,
          col.speed * CONFIG.MATRIX_BEAT_MULT
        );
      }
      if (beatIntensity > 0.7) {
        const c = Math.floor(Math.random() * cols);
        this.columns[c].glitchTimer = 30;
        this.columns[c].glitchLines = this._makeCodeFragment(rows);
      }
    }

    // ── Glitch burst trigger ──────────────────────────────────────────────
    // Hard beats above threshold fire a burst with 60% probability.
    const BURST_THRESHOLD = 0.72;
    const BURST_CHANCE    = 0.60;
    if (beatActive && beatIntensity > BURST_THRESHOLD && !this._burst && Math.random() < BURST_CHANCE) {
      this._burst = {
        startTime: performance.now(),
        duration:  400 + beatIntensity * 700,  // 400–1100ms depending on hit strength
        intensity: beatIntensity,
        cx: Math.floor(Math.random() * cols),
        cy: Math.floor(Math.random() * rows),
      };
    }

    // Resolve burst progress — density arcs 0→1 over first 40%, 1→0 over remaining 60%
    let burstProgress = 0;
    let burstDensity  = 0;
    if (this._burst) {
      burstProgress = (performance.now() - this._burst.startTime) / this._burst.duration;
      if (burstProgress >= 1.0) {
        this._burst = null;
      } else {
        burstDensity = burstProgress < 0.4
          ? burstProgress / 0.4
          : (1 - burstProgress) / 0.6;
      }
    }

    // ── Per-column update ─────────────────────────────────────────────────
    for (let c = 0; c < cols; c++) {
      const col = this.columns[c];

      // Per-column spectrum energy (logarithmic bin mapping)
      const logBinFrac = Math.pow(col.binFrac, 1.8);
      const specIdx    = Math.min(spectrum.length - 1, Math.floor(logBinFrac * spectrum.length));
      let binEnergy    = 0;
      const w          = Math.max(1, Math.floor(specIdx * 0.08) + 1);
      for (let b = Math.max(0, specIdx - w); b <= Math.min(spectrum.length - 1, specIdx + w); b++) {
        binEnergy += spectrum[b];
      }
      binEnergy /= (w * 2 + 1);

      // Speed decay toward per-bin energy target between beats
      if (!beatActive) {
        const baseTarget   = CONFIG.MATRIX_SPEED_MIN + Math.random() * 0.3 * (CONFIG.MATRIX_SPEED_MAX - CONFIG.MATRIX_SPEED_MIN);
        const energyBoost  = binEnergy * (CONFIG.MATRIX_SPEED_MAX - CONFIG.MATRIX_SPEED_MIN) * 1.2;
        col.speed += (baseTarget + energyBoost - col.speed) * 0.04;
        col.speed  = Math.max(CONFIG.MATRIX_SPEED_MIN * 0.5, col.speed);
      }

      // Stutter: bass-range columns freeze briefly on sub/bass spikes
      if (col.stutterFrames > 0) {
        col.stutterFrames--;
      } else if (col.binFrac < 0.15 && subBass > 0.55 && Math.random() < subBass * 0.08) {
        col.stutterFrames = Math.floor(2 + Math.random() * 4 * subBass);
      }

      // Vibration: sub/bass shakes columns horizontally via spring
      col.vibTimer--;
      if (col.vibTimer <= 0) {
        col.vibTimer = Math.floor(4 + Math.random() * 10 * (1 - subBass));
        if (subBass > 0.25) {
          const maxShift = Math.min(2, Math.floor(1 + subBass * 2.5));
          col.vibTarget  = (Math.random() < 0.5 ? -1 : 1) * Math.floor(Math.random() * (maxShift + 1));
        } else {
          col.vibTarget = 0;
        }
      }
      col.vibVelocity += (col.vibTarget - col.vibOffset) * 0.6;
      col.vibVelocity *= 0.45;
      col.vibOffset    = Math.round(col.vibOffset + col.vibVelocity);
      col.vibOffset    = Math.max(-2, Math.min(2, col.vibOffset));

      col.mutationBoost += (globalMutation + binEnergy * 0.4 - col.mutationBoost) * 0.15;

      // Advance head
      if (col.stutterFrames === 0) col.headY += col.speed;
      if (col.headY > rows + CONFIG.MATRIX_TRAIL_LENGTH) {
        col.headY       = Math.random() * -10;
        col.speed       = CONFIG.MATRIX_SPEED_MIN + Math.random() * (CONFIG.MATRIX_SPEED_MAX - CONFIG.MATRIX_SPEED_MIN);
        col.glitchTimer = 0;
        col.glitchLines = null;
      }
      if (col.glitchTimer > 0) col.glitchTimer--;

      const headRow = Math.floor(col.headY);
      let drawCol   = Math.max(0, Math.min(cols - 1, c + col.vibOffset));

      // Wave distortion during burst — sinusoidal ripple across all columns
      if (this._burst && burstDensity > 0) {
        const wave = Math.sin(c * 0.85 + burstProgress * Math.PI * 10) *
                     burstDensity * 4 * this._burst.intensity;
        drawCol = Math.max(0, Math.min(cols - 1, drawCol + Math.round(wave)));
      }

      // Draw code fragment
      if (col.glitchTimer > 0 && col.glitchLines) {
        const frag = col.glitchLines;
        for (let i = 0; i < frag.text.length; i++) {
          const r = frag.startRow + i;
          if (r >= 0 && r < rows) {
            setCell(drawCol, r, frag.text[i], i === 0 ? 1.0 : 0.6);
          }
        }
        continue;
      }

      // Draw trail
      const energyBright = 0.55 + 0.45 * binEnergy;
      for (let t = 0; t < CONFIG.MATRIX_TRAIL_LENGTH; t++) {
        const r = headRow - t;
        if (r < 0 || r >= rows) continue;
        let char, brightness;
        if (t === 0) {
          char       = this._randomKatakana();
          brightness = 1.0;
        } else {
          const mutChance = 0.04 + col.mutationBoost * 0.35;
          char       = this._randomKatakana();
          brightness = Math.max(0, 1 - t / CONFIG.MATRIX_TRAIL_LENGTH) * energyBright;
        }
        setCell(drawCol, r, char, brightness);
      }

      // Stutter flash on release
      if (col.stutterFrames === 1 && headRow >= 0 && headRow < rows) {
        setCell(drawCol, headRow,                  this._randomKatakana(), 1.0);
        setCell(drawCol, Math.max(0, headRow - 1), this._randomKatakana(), 0.9);
      }
    }

    // ── Burst overlay (drawn after columns so it sits on top) ────────────
    if (this._burst && burstDensity > 0) {
      this._renderBurst(cols, rows, burstProgress, burstDensity, this._burst);
    }

    // ── Bass energy bar ───────────────────────────────────────────────────
    const bassLevel = bands.bass;
    const barWidth  = Math.floor(bassLevel * cols);
    for (let c = 0; c < cols; c++) {
      setCell(c, rows - 1,
        c < barWidth ? '█' : '▁',
        c < barWidth ? 0.4 + 0.6 * bassLevel : 0.1
      );
    }
  }
}
