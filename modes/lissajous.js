// modes/lissajous.js — X/Y Oscilloscope (Lissajous) Mode
// Waveform as X/Y signal. Mono fallback: phase-shift by π/2 for Y axis.
// Trail of · chars with fading brightness.

class LissajousMode {
  constructor(config) {
    this.config = config;
    this._trail = []; // array of {col, row}
    this._maxTrail = CONFIG.LISSAJOUS_TRAIL_LENGTH;
  }

  reset() {
    this._trail = [];
  }

  _isMono(waveform) {
    // Compare first 10 samples to detect mono
    // p5.AudioIn is typically mono — always use phase-shift fallback for good display
    return true; // treat as mono for consistent lissajous figures
  }

  // Circular buffer offset for phase-shifted Y
  _phaseShift(waveform, offset) {
    const len = waveform.length;
    return (idx) => waveform[(idx + offset) % len];
  }

  update(grid, cols, rows, audio, bg) {
    const waveform = audio.getWaveform();
    const bands = audio.getBands();
    const wlen = waveform.length;

    if (wlen === 0) return;

    const cx = cols / 2;
    const cy = rows / 2;
    // Aspect-corrected radii
    const rx = cols / 2 - 2;
    const ry = rows / 2 - 2;

    // Mono detection and phase-shift fallback
    const isMono = audio.isMono || this._isMono(waveform);
    // Phase offset: π/2 of the waveform length
    const phaseOffset = Math.floor(wlen / 4);
    const getY = this._phaseShift(waveform, phaseOffset);

    // Sample N points from the waveform for the trail
    const sampleCount = Math.min(wlen, this._maxTrail * 2);
    const step = Math.floor(wlen / sampleCount);

    const newPositions = [];
    for (let i = 0; i < sampleCount; i++) {
      const idx = i * step;
      const xSample = waveform[idx] || 0;
      const ySample = isMono ? getY(idx) : (waveform[idx] || 0);

      const col = Math.round(cx + xSample * rx);
      const row = Math.round(cy - ySample * ry);
      newPositions.push({ col, row });
    }

    // Append to trail, trim to max length
    this._trail = this._trail.concat(newPositions).slice(-this._maxTrail);

    // Draw trail
    for (let i = 0; i < this._trail.length; i++) {
      const { col, row } = this._trail[i];
      if (col < 0 || col >= cols || row < 0 || row >= rows) continue;

      const age = (this._trail.length - i) / this._trail.length; // 0=newest, 1=oldest
      const brightness = Math.max(0.05, 1.0 - age * 0.95);

      let char;
      if (age < 0.1) {
        char = '+'; // newest points
      } else if (age < 0.3) {
        char = '·';
      } else {
        char = '·';
      }

      setCell(col, row, char, brightness);
    }

    // Draw axes
    for (let c = 0; c < cols; c++) {
      setCell(c, Math.round(cy), '─', 0.08);
    }
    for (let r = 0; r < rows; r++) {
      setCell(Math.round(cx), r, '│', 0.08);
    }
    setCell(Math.round(cx), Math.round(cy), '+', 0.15);

    // Current position dot (brightest)
    if (this._trail.length > 0) {
      const last = this._trail[this._trail.length - 1];
      if (last.col >= 0 && last.col < cols && last.row >= 0 && last.row < rows) {
        setCell(last.col, last.row, '@', 1.0);
      }
    }

    // Labels
    setString(0, 0, 'LISSAJOUS', 0.25);
    if (isMono) {
      setString(0, 1, 'MONO-PHASE', 0.2);
    }

    // Level indicator
    const level = bands.bass + bands.mid;
    const levelStr = 'LVL:' + '|'.repeat(Math.floor(level * 10));
    if (levelStr.length < cols) {
      setString(cols - levelStr.length - 1, 0, levelStr, 0.25);
    }
  }
}
