// modes/lissajous.js — X/Y Oscilloscope (Lissajous) Mode
// Dense waveform sampling with line-fill between points, direction-based characters,
// energy-reactive radius, beat pulse + burst scatter, and harmonic mode cycling.

class LissajousMode {
  constructor(config) {
    this.config   = config;
    this._trail   = [];
    this._beatPulse    = 0;   // decaying radius boost after each beat
    this._burstFrames  = 0;   // frames remaining for beat burst scatter
    this._burstIntensity = 0;
    this._harmIdx = 0;        // index into harmonic phase-offset ratios
    // Phase offsets as fractions of waveform length (1/4 = π/2, 1/3 = 2π/3, etc.)
    this._harmonics = [0.25, 0.333, 0.167, 0.4, 0.1, 0.45];
    // Noise chars for beat burst
    this._burstChars = '★◆●◉◎○◇◈✦✧■□▪▫';
  }

  reset() {
    this._trail        = [];
    this._beatPulse    = 0;
    this._burstFrames  = 0;
  }

  // Bresenham line — calls cb(col, row) for each cell between (x0,y0)→(x1,y1)
  _line(x0, y0, x1, y1, cb) {
    let dx = Math.abs(x1 - x0), sx = x0 < x1 ? 1 : -1;
    let dy = Math.abs(y1 - y0), sy = y0 < y1 ? 1 : -1;
    let err = dx - dy;
    while (true) {
      cb(x0, y0);
      if (x0 === x1 && y0 === y1) break;
      const e2 = 2 * err;
      if (e2 > -dy) { err -= dy; x0 += sx; }
      if (e2 <  dx) { err += dx; y0 += sy; }
    }
  }

  // Pick a character based on movement angle and age in trail
  _charForPoint(dx, dy, age) {
    const speed = Math.sqrt(dx * dx + dy * dy);
    if (age < 0.04) return speed > 2 ? '★' : '◆';
    if (age < 0.12) return speed > 1.5 ? '◆' : '●';
    if (age < 0.25) return speed > 1.0 ? '●' : '○';
    if (age < 0.45) {
      // Direction char for mid-age points
      if (speed < 0.3) return '·';
      const a = ((Math.atan2(dy, dx) % Math.PI) + Math.PI) % Math.PI;
      if (a < Math.PI * 0.125 || a >= Math.PI * 0.875) return '─';
      if (a < Math.PI * 0.375) return '╱';
      if (a < Math.PI * 0.625) return '│';
      return '╲';
    }
    if (age < 0.70) return '·';
    return '∙';
  }

  update(grid, cols, rows, audio, bg) {
    const waveform     = audio.getWaveform();
    const bands        = audio.getBands();
    const beatActive   = audio.beatActive;
    const beatIntensity = audio.beatIntensity;
    const wlen         = waveform.length;

    if (wlen === 0) return;

    // ── Beat reactions ───────────────────────────────────────────────────────
    if (beatActive) {
      this._beatPulse = Math.min(1.0, this._beatPulse + beatIntensity * 0.7);
      // Hard beat: scatter burst + optional harmonic switch
      if (beatIntensity > 0.75) {
        this._burstFrames    = Math.floor(4 + beatIntensity * 6);
        this._burstIntensity = beatIntensity;
        if (Math.random() < 0.45) {
          this._harmIdx = (this._harmIdx + 1) % this._harmonics.length;
          // Thin the trail on harmonic switch so new figure reads cleanly
          this._trail = this._trail.slice(-60);
        }
      }
    }
    this._beatPulse *= 0.86;
    if (this._burstFrames > 0) this._burstFrames--;

    // ── Geometry ─────────────────────────────────────────────────────────────
    const cx = cols / 2;
    const cy = rows / 2;

    const energy       = Math.min(1.4, bands.bass * 0.55 + bands.mid * 0.3 + bands.treble * 0.15);
    const radiusScale  = 0.80 + energy * 0.28 + this._beatPulse * 0.40;
    const rx           = (cols / 2 - 2) * radiusScale;
    const ry           = (rows / 2 - 2) * radiusScale;

    // ── Sample waveform → new trail points ───────────────────────────────────
    const sampleCount  = Math.min(wlen, CONFIG.LISSAJOUS_SAMPLES_PER_FRAME);
    const step         = Math.floor(wlen / sampleCount);
    const phaseLen     = Math.round(wlen * this._harmonics[this._harmIdx]);

    const newPoints = [];
    for (let i = 0; i < sampleCount; i++) {
      const idx  = i * step;
      const xS   = waveform[idx] || 0;
      const yS   = waveform[(idx + phaseLen) % wlen] || 0;
      newPoints.push({
        col: Math.round(cx + xS * rx),
        row: Math.round(cy - yS * ry),
      });
    }

    // Append to trail, trim
    this._trail = this._trail.concat(newPoints).slice(-CONFIG.LISSAJOUS_TRAIL_LENGTH);

    // ── Draw trail ────────────────────────────────────────────────────────────
    const tlen = this._trail.length;
    for (let i = 0; i < tlen - 1; i++) {
      const p0  = this._trail[i];
      const p1  = this._trail[i + 1];
      const age = (tlen - i) / tlen;  // 0 = newest, 1 = oldest

      const dx  = p1.col - p0.col;
      const dy  = p1.row - p0.row;
      const char      = this._charForPoint(dx, dy, age);
      const brightness = Math.pow(1 - age, 0.55) * (0.45 + energy * 0.55);

      // Fill the line between consecutive trail points so there are no gaps
      this._line(p0.col, p0.row, p1.col, p1.row, (c, r) => {
        if (c < 0 || c >= cols || r < 0 || r >= rows) return;
        setCell(c, r, char, brightness);
      });

      // Glow halo around fresh points
      if (age < 0.08 && brightness > 0.4) {
        const glowB = brightness * 0.25;
        const glowC = age < 0.04 ? '●' : '·';
        if (p0.col + 1 < cols) setCell(p0.col + 1, p0.row, glowC, glowB);
        if (p0.col - 1 >= 0)   setCell(p0.col - 1, p0.row, glowC, glowB);
        if (p0.row + 1 < rows) setCell(p0.col, p0.row + 1, glowC, glowB);
        if (p0.row - 1 >= 0)   setCell(p0.col, p0.row - 1, glowC, glowB);
      }
    }

    // ── Beat burst scatter ────────────────────────────────────────────────────
    if (this._burstFrames > 0) {
      const density   = this._burstFrames / 10;
      const count     = Math.floor(density * cols * rows * 0.04 * this._burstIntensity);
      const bc        = this._burstChars;
      const maxR      = Math.min(rx, ry);
      for (let i = 0; i < count; i++) {
        const a  = Math.random() * Math.PI * 2;
        const r  = Math.random() * maxR * (0.6 + Math.random() * 0.8);
        const gc = Math.round(cx + Math.cos(a) * r);
        const gr = Math.round(cy + Math.sin(a) * r * (rows / cols)); // aspect fix
        if (gc >= 0 && gc < cols && gr >= 0 && gr < rows) {
          setCell(gc, gr, bc[Math.floor(Math.random() * bc.length)],
                  0.4 + Math.random() * 0.6 * density);
        }
      }
    }

    // ── Dim axes ─────────────────────────────────────────────────────────────
    const axisB = 0.07;
    for (let c = 0; c < cols; c++) setCell(c, Math.round(cy), '─', axisB);
    for (let r = 0; r < rows; r++) setCell(Math.round(cx), r, '│', axisB);
    setCell(Math.round(cx), Math.round(cy), '┼', 0.14);

    // ── Current head ─────────────────────────────────────────────────────────
    const last = this._trail[tlen - 1];
    if (last && last.col >= 0 && last.col < cols && last.row >= 0 && last.row < rows) {
      setCell(last.col, last.row, '◉', 1.0);
    }

    // ── Labels ───────────────────────────────────────────────────────────────
    setString(0, 0, 'LISSAJOUS', 0.20);
    const harmLabel = ['1:1', '3:4', '3:2', '2:5', '9:10', '5:9'][this._harmIdx];
    setString(0, 1, 'HRM:' + harmLabel, 0.15);
  }
}
