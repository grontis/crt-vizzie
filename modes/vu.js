// modes/vu.js — VU Meter Mode
// 6 frequency bands + master. Three visual zones. Peak needle per band.

class VUMode {
  constructor(config) {
    this.config = config;
    this.peaks = {};
    this._bandNames = ['SUB', 'BASS', 'LO-MID', 'MID', 'HI-MID', 'TREBLE', 'MASTER'];
    this._bandKeys = ['sub', 'bass', 'lowMid', 'mid', 'highMid', 'treble', 'master'];
    this._initPeaks();
  }

  _initPeaks() {
    for (const k of this._bandKeys) {
      this.peaks[k] = 0;
    }
  }

  reset() {
    this._initPeaks();
  }

  update(grid, cols, rows, audio, bg) {
    const bands = audio.getBands();

    // Compute master as average of all bands
    const master = (bands.sub + bands.bass + bands.lowMid + bands.mid + bands.highMid + bands.treble) / 6;
    const allBands = {
      sub: bands.sub, bass: bands.bass, lowMid: bands.lowMid,
      mid: bands.mid, highMid: bands.highMid, treble: bands.treble,
      master,
    };

    const numBands = this._bandKeys.length;
    const rowsPerBand = Math.floor((rows - 4) / numBands);
    const barMaxWidth = cols - 20; // leave room for labels and dB value

    if (barMaxWidth <= 0) return;

    // Title
    setString(0, 0, 'VU METER', 0.35);
    setString(cols - 9, 0, 'LEVEL dB', 0.25);

    for (let bi = 0; bi < numBands; bi++) {
      const key = this._bandKeys[bi];
      const name = this._bandNames[bi];
      const energy = allBands[key];

      // Update peak
      if (energy > this.peaks[key]) {
        this.peaks[key] = energy;
      } else {
        this.peaks[key] = Math.max(0, this.peaks[key] - CONFIG.VU_PEAK_DECAY);
      }

      const dB = 20 * Math.log10(energy + 0.0001);
      const dBStr = dB.toFixed(1).padStart(6, ' ') + 'dB';

      const baseRow = 2 + bi * rowsPerBand;
      if (baseRow + 1 >= rows) break;

      // Label
      const labelPad = name.padEnd(7, ' ');
      setString(1, baseRow, labelPad, 0.4);

      // Bar
      const barFill = Math.floor(energy * barMaxWidth);
      const peakPos = Math.min(barMaxWidth - 1, Math.floor(this.peaks[key] * barMaxWidth));

      for (let c = 0; c < barMaxWidth; c++) {
        const barCol = 9 + c;
        if (barCol >= cols - 10) break;

        const ratio = c / barMaxWidth;

        if (c < barFill) {
          // Filled portion
          let char, brightness;
          if (ratio > 0.9) {
            // Red zone > 90%
            char = '!';
            brightness = 1.0;
          } else if (ratio > 0.72) {
            // Yellow zone 72–90%
            char = '▓';
            brightness = 0.85;
          } else {
            // Normal zone
            char = '█';
            brightness = 0.5 + 0.5 * ratio;
          }
          setCell(barCol, baseRow, char, brightness);
        } else if (c === peakPos && this.peaks[key] > 0.01) {
          // Peak needle
          setCell(barCol, baseRow, '│', 0.9);
        } else {
          // Empty
          setCell(barCol, baseRow, '·', 0.1);
        }
      }

      // dB value
      const dbCol = cols - dBStr.length - 1;
      if (dbCol > 0) {
        setString(dbCol, baseRow, dBStr, 0.35);
      }

      // Separator
      if (bi < numBands - 1) {
        setString(1, baseRow + 1, '─'.repeat(Math.min(cols - 2, 50)), 0.1);
      }
    }

    // Master separator line
    const masterBaseRow = 2 + (numBands - 1) * rowsPerBand;
    if (masterBaseRow > 2) {
      setString(0, masterBaseRow - 1, '═'.repeat(cols), 0.2);
    }
  }
}
