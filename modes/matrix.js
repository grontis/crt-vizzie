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
      this.columns.push(this._makeColumn(rows));
    }
    this.codeFragments = [];
  }

  _makeColumn(rows) {
    return {
      headY: Math.random() * -rows,
      speed: CONFIG.MATRIX_SPEED_MIN + Math.random() * (CONFIG.MATRIX_SPEED_MAX - CONFIG.MATRIX_SPEED_MIN),
      trail: [],
      glitchTimer: 0,
      glitchLines: null,
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

    const bands = audio.getBands();
    const beatActive = audio.beatActive;
    const beatIntensity = audio.beatIntensity;

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
    } else {
      // Decay speed back toward normal
      for (const col of this.columns) {
        const targetSpeed = CONFIG.MATRIX_SPEED_MIN +
          Math.random() * (CONFIG.MATRIX_SPEED_MAX - CONFIG.MATRIX_SPEED_MIN);
        col.speed += (targetSpeed - col.speed) * 0.02;
      }
    }

    const trailLen = CONFIG.MATRIX_TRAIL_LENGTH;

    for (let c = 0; c < cols; c++) {
      const col = this.columns[c];

      // Advance head
      col.headY += col.speed;
      if (col.headY > rows + trailLen) {
        col.headY = Math.random() * -10;
        col.speed = CONFIG.MATRIX_SPEED_MIN + Math.random() * (CONFIG.MATRIX_SPEED_MAX - CONFIG.MATRIX_SPEED_MIN);
        col.glitchTimer = 0;
        col.glitchLines = null;
      }

      // Decrement glitch timer
      if (col.glitchTimer > 0) col.glitchTimer--;

      const headRow = Math.floor(col.headY);

      // Draw code fragment if active
      if (col.glitchTimer > 0 && col.glitchLines) {
        const frag = col.glitchLines;
        for (let i = 0; i < frag.text.length; i++) {
          const r = frag.startRow + i;
          if (r >= 0 && r < rows) {
            const brightness = i === 0 ? 1.0 : 0.6;
            setCell(c, r, frag.text[i], brightness);
          }
        }
        continue;
      }

      // Draw trail
      for (let t = 0; t < trailLen; t++) {
        const r = headRow - t;
        if (r < 0 || r >= rows) continue;

        let char, brightness;
        if (t === 0) {
          // Head character — bright white
          char = this._randomKatakana();
          brightness = 1.0;
        } else {
          // Trail — decaying brightness, occasional char mutation
          char = Math.random() < 0.05 ? this._randomKatakana() : this._randomKatakana();
          brightness = Math.max(0, 1 - t / trailLen) * 0.9;
        }
        setCell(c, r, char, brightness);
      }
    }

    // Bass energy bar on bottom row
    const bassLevel = bands.bass;
    const barWidth = Math.floor(bassLevel * cols);
    for (let c = 0; c < cols; c++) {
      const brightness = c < barWidth ? (0.4 + 0.6 * bassLevel) : 0.1;
      const char = c < barWidth ? '█' : '▁';
      setCell(c, rows - 1, char, brightness);
    }
  }
}
