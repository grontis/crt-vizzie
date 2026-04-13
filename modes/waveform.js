// modes/waveform.js — Time-Domain Waveform Display
// Maps waveform samples to rows, fills vertical gaps, brightness = abs(sample).

class WaveformMode {
  constructor(config) {
    this.config = config;
  }

  reset() {}

  update(grid, cols, rows, audio, bg) {
    const waveform = audio.getWaveform();
    const bands = audio.getBands();
    const centerRow = Math.floor(rows / 2);
    const amplitude = rows / 2 - 1; // max row deviation from center

    // Waveform array may be longer than cols — subsample it
    const wlen = waveform.length;
    const prevRows = [];

    // Title
    setString(0, 0, 'WAVEFORM', 0.35);

    // Draw center line (dim)
    for (let c = 0; c < cols; c++) {
      setCell(c, centerRow, '─', 0.15);
    }

    for (let c = 0; c < cols; c++) {
      const idx = Math.floor((c / cols) * wlen);
      const sample = waveform[idx] || 0;
      const row = Math.round(centerRow - sample * amplitude);
      const clampedRow = Math.max(0, Math.min(rows - 1, row));
      const brightness = Math.abs(sample) * 0.8 + 0.2;

      prevRows.push(clampedRow);

      // Fill vertical gap between this sample and previous sample
      if (c > 0) {
        const prevRow = prevRows[c - 1];
        const minR = Math.min(prevRow, clampedRow);
        const maxR = Math.max(prevRow, clampedRow);
        for (let r = minR; r <= maxR; r++) {
          const isEndpoint = (r === clampedRow || r === prevRow);
          const fillBrightness = isEndpoint ? brightness : brightness * 0.7;
          const char = isEndpoint ? '│' : '▓';
          setCell(c, r, char, fillBrightness);
        }
      } else {
        setCell(c, clampedRow, '│', brightness);
      }
    }

    // Bass energy indicator — bottom row
    const bassLevel = bands.bass;
    const bassWidth = Math.floor(bassLevel * cols);
    for (let c = 0; c < cols; c++) {
      if (c < bassWidth) {
        setCell(c, rows - 1, '▁', 0.3 + 0.5 * bassLevel);
      }
    }

    // Treble sparkle — random bright dots on peaks
    if (bands.treble > 0.3) {
      for (let i = 0; i < Math.floor(bands.treble * 10); i++) {
        const c = Math.floor(Math.random() * cols);
        const idx = Math.floor((c / cols) * wlen);
        const sample = waveform[idx] || 0;
        if (Math.abs(sample) > 0.5) {
          const r = Math.round(centerRow - sample * amplitude);
          setCell(c, Math.max(0, Math.min(rows - 1, r)), '*', 1.0);
        }
      }
    }
  }
}
