// modes/spectrum.js — FFT Spectrum Analyzer
// Logarithmic bin mapping, block chars, box-drawing frame, frequency labels, peak hold.

class SpectrumMode {
  constructor(config) {
    this.config = config;
    this.peakHolds = [];
    this._cols = 0;
    this._rows = 0;
  }

  reset() {
    this._initPeaks(this._cols);
  }

  _initPeaks(cols) {
    this._cols = cols;
    this.peakHolds = new Array(cols).fill(0);
  }

  update(grid, cols, rows, audio, bg) {
    if (cols !== this._cols) {
      this._initPeaks(cols);
    }
    this._rows = rows;

    const spectrum = audio.getSpectrum();
    const specLen = spectrum.length;
    const bands = audio.getBands();

    // Usable area: leave 2 cols for frame, 2 rows for labels + frame
    const innerCols = cols - 4;
    const innerRows = rows - 5;
    const startCol = 2;
    const startRow = 2;

    if (innerCols <= 0 || innerRows <= 0) return;

    const blockChars = CONFIG.BLOCK_CHARS; // '▁▂▃▄▅▆▇█'

    // Logarithmic bin mapping: map column i to FFT bin
    // Frequency range: 20 Hz – Nyquist
    // log scale: bin = round(specLen * (logFreq - logMin) / (logMax - logMin))
    const logMin = Math.log10(20);
    const logMax = Math.log10(20000);

    for (let c = 0; c < innerCols; c++) {
      // Map column to log-frequency bin
      const logF = logMin + (c / innerCols) * (logMax - logMin);
      const binF = Math.pow(10, logF);
      const binHz = 44100 / CONFIG.FFT_BINS;
      const binIdx = Math.min(specLen - 1, Math.max(0, Math.floor(binF / binHz)));

      // Average a small window of bins for smoother display
      let val = 0;
      const window = Math.max(1, Math.floor(binIdx * 0.1));
      let count = 0;
      for (let b = Math.max(0, binIdx - window); b <= Math.min(specLen - 1, binIdx + window); b++) {
        val += spectrum[b];
        count++;
      }
      val /= count;

      // Map value (0–1) to bar height in rows
      const barHeight = Math.floor(val * innerRows);

      // Update peak hold
      const col = startCol + c;
      if (val > this.peakHolds[c]) {
        this.peakHolds[c] = val;
      } else {
        this.peakHolds[c] = Math.max(0, this.peakHolds[c] - CONFIG.PEAK_DECAY);
      }
      const peakRow = startRow + innerRows - 1 - Math.floor(this.peakHolds[c] * innerRows);

      // Draw bar from bottom up
      for (let r = 0; r < innerRows; r++) {
        const row = startRow + innerRows - 1 - r;
        if (r < barHeight) {
          // Filled bar section
          const fillRatio = r / innerRows;
          const brightness = 0.4 + 0.6 * val;
          const charIdx = Math.min(blockChars.length - 1, Math.floor(fillRatio * blockChars.length));
          setCell(col, row, '█', brightness);
        } else {
          setCell(col, row, ' ', 0);
        }
      }

      // Draw peak hold dot
      if (peakRow >= startRow && peakRow < startRow + innerRows && this.peakHolds[c] > 0.02) {
        setCell(col, peakRow, '▄', 0.8);
      }
    }

    // Draw box frame
    // Top border
    setString(startCol - 1, startRow - 1, '┌' + '─'.repeat(innerCols) + '┐', 0.3);
    // Bottom border
    setString(startCol - 1, startRow + innerRows, '└' + '─'.repeat(innerCols) + '┘', 0.3);
    // Side borders
    for (let r = startRow; r < startRow + innerRows; r++) {
      setCell(startCol - 1, r, '│', 0.3);
      setCell(startCol + innerCols, r, '│', 0.3);
    }

    // Frequency labels along bottom
    const labels = [
      { label: 'SUB', freq: 40 },
      { label: 'BASS', freq: 120 },
      { label: 'LO-MID', freq: 300 },
      { label: 'MID', freq: 1000 },
      { label: 'HI-MID', freq: 3500 },
      { label: 'PRES', freq: 8000 },
      { label: 'AIR', freq: 16000 },
    ];

    const labelRow = startRow + innerRows + 1;
    if (labelRow < rows) {
      for (const lb of labels) {
        const logF = Math.log10(lb.freq);
        const t = (logF - logMin) / (logMax - logMin);
        const lc = startCol + Math.floor(t * innerCols) - Math.floor(lb.label.length / 2);
        if (lc >= 0 && lc + lb.label.length < cols) {
          setString(lc, labelRow, lb.label, 0.4);
        }
      }
    }

    // Master level indicator top right
    const masterLevel = (bands.bass + bands.mid + bands.treble) / 3;
    const masterStr = 'LVL:' + Math.floor(masterLevel * 100).toString().padStart(3, ' ') + '%';
    if (cols - masterStr.length - 1 > 0) {
      setString(cols - masterStr.length - 1, 0, masterStr, 0.5);
    }

    // Title
    setString(startCol, 0, 'SPECTRUM ANALYZER', 0.4);
  }
}
