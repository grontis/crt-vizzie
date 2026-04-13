// modes/life.js — Conway's Game of Life with audio seeding
// Standard rules. Beat toggles random block. High bass raises resurrection probability.

class LifeMode {
  constructor(config) {
    this.config = config;
    this._cells = [];
    this._next = [];
    this._cols = 0;
    this._rows = 0;
    this._frameCount = 0;
    this._updateInterval = 3; // update Life every N frames
  }

  reset() {
    this._initGrid(this._cols, this._rows);
  }

  _initGrid(cols, rows) {
    this._cols = cols;
    this._rows = rows;
    this._cells = [];
    this._next = [];
    for (let r = 0; r < rows; r++) {
      this._cells.push(new Uint8Array(cols));
      this._next.push(new Uint8Array(cols));
    }
    // Seed with a random pattern
    this._seedRandom(0.25);
  }

  _seedRandom(density) {
    for (let r = 0; r < this._rows; r++) {
      for (let c = 0; c < this._cols; c++) {
        this._cells[r][c] = Math.random() < density ? 1 : 0;
      }
    }
  }

  _toggleBlock(centerCol, centerRow, size) {
    const half = Math.floor(size / 2);
    for (let dr = -half; dr <= half; dr++) {
      for (let dc = -half; dc <= half; dc++) {
        const r = centerRow + dr;
        const c = centerCol + dc;
        if (r >= 0 && r < this._rows && c >= 0 && c < this._cols) {
          this._cells[r][c] = this._cells[r][c] ? 0 : 1;
        }
      }
    }
  }

  _countNeighbors(r, c) {
    let count = 0;
    for (let dr = -1; dr <= 1; dr++) {
      for (let dc = -1; dc <= 1; dc++) {
        if (dr === 0 && dc === 0) continue;
        const nr = (r + dr + this._rows) % this._rows;
        const nc = (c + dc + this._cols) % this._cols;
        count += this._cells[nr][nc];
      }
    }
    return count;
  }

  _stepLife(resurrectChance) {
    for (let r = 0; r < this._rows; r++) {
      for (let c = 0; c < this._cols; c++) {
        const neighbors = this._countNeighbors(r, c);
        const alive = this._cells[r][c];
        if (alive) {
          this._next[r][c] = (neighbors === 2 || neighbors === 3) ? 1 : 0;
        } else {
          this._next[r][c] = (neighbors === 3 || Math.random() < resurrectChance) ? 1 : 0;
        }
      }
    }
    // Swap buffers
    const tmp = this._cells;
    this._cells = this._next;
    this._next = tmp;
  }

  _getCellChar(phosphorKey) {
    switch (phosphorKey) {
      case 'amber': return '▓';
      case 'blue':  return '▒';
      default:      return '█';
    }
  }

  update(grid, cols, rows, audio, bg) {
    if (cols !== this._cols || rows !== this._rows) {
      this._initGrid(cols, rows);
    }

    const bands = audio.getBands();
    const beatActive = audio.beatActive;
    this._frameCount++;

    // Beat toggles a random 5×5 block
    if (beatActive) {
      const bc = Math.floor(Math.random() * cols);
      const br = Math.floor(Math.random() * rows);
      this._toggleBlock(bc, br, CONFIG.LIFE_BEAT_BLOCK_SIZE);
    }

    // High bass raises resurrection probability
    const resurrectChance = bands.bass > CONFIG.LIFE_RESURRECT_BASS
      ? (bands.bass - CONFIG.LIFE_RESURRECT_BASS) * 0.01
      : 0;

    // Step the simulation every N frames
    if (this._frameCount % this._updateInterval === 0) {
      this._stepLife(resurrectChance);
    }

    // Get the current phosphor key from the global state (set by sketch.js)
    const phosphorKey = (typeof currentPhosphor !== 'undefined') ? currentPhosphor : 'green';
    const cellChar = this._getCellChar(phosphorKey);

    // Render cells
    for (let r = 0; r < rows; r++) {
      if (!this._cells[r]) continue;
      for (let c = 0; c < cols; c++) {
        if (this._cells[r][c]) {
          const neighbors = this._countNeighbors(r, c);
          const brightness = 0.3 + (neighbors / 8) * 0.7;
          setCell(c, r, cellChar, brightness);
        }
      }
    }

    // Title
    setString(0, 0, 'LIFE', 0.2);
    const popCount = this._cells.reduce((sum, row) => sum + row.reduce((s, v) => s + v, 0), 0);
    const popStr = 'POP:' + popCount;
    if (popStr.length < cols) {
      setString(cols - popStr.length - 1, 0, popStr, 0.25);
    }
  }
}
