// modes/morph.js — ASCII Figure Morphing Mode
// Tweens cell-by-cell between ASCII art figures. Beat triggers transitions.

class MorphMode {
  constructor(config) {
    this.config = config;
    this._sourceFigure = null;
    this._targetFigure = null;
    this._tweenProgress = 1.0; // start fully on first figure
    this._noiseChars = CONFIG.MORPH_NOISE_CHARS;
    this._currentFigureIdx = 0;
    this._nextFigureIdx = 1;
    this._frameIndex = 0;
  }

  reset() {
    this._tweenProgress = 1.0;
    this._sourceFigure = AsciiArtLibrary.figures[this._currentFigureIdx % AsciiArtLibrary.figures.length];
    this._targetFigure = this._sourceFigure;
  }

  _pickNextFigure(bg) {
    // Background luma biases figure selection
    let lumaSum = 0;
    let lumaSamples = 0;
    if (bg && bg.hasMedia) {
      for (let attempts = 0; attempts < 5; attempts++) {
        const c = Math.floor(Math.random() * 10);
        const r = Math.floor(Math.random() * 5);
        lumaSum += bg.getLuma(c, r);
        lumaSamples++;
      }
    }
    const avgLuma = lumaSamples > 0 ? lumaSum / lumaSamples : 0;

    // High luma → prefer later figures; low luma → prefer earlier
    const figs = AsciiArtLibrary.figures;
    const biasedIdx = Math.floor(avgLuma * (figs.length - 1));
    const randomness = Math.floor(Math.random() * figs.length);
    const idx = (biasedIdx + randomness) % figs.length;

    return { fig: figs[idx], idx };
  }

  _startTransition(bg) {
    const { fig, idx } = this._pickNextFigure(bg);
    this._sourceFigure = this._targetFigure || AsciiArtLibrary.figures[0];
    this._targetFigure = fig;
    this._currentFigureIdx = this._nextFigureIdx;
    this._nextFigureIdx = idx;
    this._tweenProgress = 0.0;
  }

  update(grid, cols, rows, audio, bg) {
    const bands = audio.getBands();
    const beatActive = audio.beatActive;
    const beatIntensity = audio.beatIntensity;

    // Initialize on first call
    if (!this._targetFigure) {
      this._targetFigure = AsciiArtLibrary.figures[0];
      this._sourceFigure = AsciiArtLibrary.figures[0];
    }

    // Beat triggers transition
    if (beatActive && this._tweenProgress > 0.5) {
      this._startTransition(bg);
    }

    // Advance tween
    if (this._tweenProgress < 1.0) {
      this._tweenProgress = Math.min(1.0, this._tweenProgress + CONFIG.MORPH_TWEEN_SPEED);
    }

    // Center the figure in the grid
    const figW = CONFIG.MORPH_WIDTH;
    const figH = CONFIG.MORPH_HEIGHT;
    const startCol = Math.max(0, Math.floor((cols - figW) / 2));
    const startRow = Math.max(0, Math.floor((rows - figH) / 2));

    const sourceFrame = this._sourceFigure
      ? AsciiArtLibrary.getFrame(this._sourceFigure, this._frameIndex)
      : null;
    const targetFrame = this._targetFigure
      ? AsciiArtLibrary.getFrame(this._targetFigure, this._frameIndex)
      : null;

    for (let r = 0; r < figH && r < rows; r++) {
      const srcRow = sourceFrame && r < sourceFrame.length ? sourceFrame[r] : '';
      const tgtRow = targetFrame && r < targetFrame.length ? targetFrame[r] : '';

      for (let c = 0; c < figW && c < cols; c++) {
        const gc = startCol + c;
        const gr = startRow + r;
        if (gc >= cols || gr >= rows) continue;

        const srcChar = c < srcRow.length ? srcRow[c] : ' ';
        const tgtChar = c < tgtRow.length ? tgtRow[c] : ' ';

        let char, brightness;

        if (this._tweenProgress >= 1.0) {
          // Fully on target
          char = tgtChar;
          brightness = tgtChar === ' ' ? 0 : 0.7;
        } else if (srcChar === tgtChar) {
          // No change needed — render directly
          char = srcChar;
          brightness = srcChar === ' ' ? 0 : 0.65;
        } else {
          // Interpolate through noise chars
          const noiseLen = this._noiseChars.length;
          const noiseIdx = Math.floor(this._tweenProgress * noiseLen);
          char = this._noiseChars[noiseIdx % noiseLen];
          brightness = 0.4 + 0.4 * this._tweenProgress;
        }

        // Treble shimmer: inject noise chars into stable cells
        if (
          this._tweenProgress >= 1.0 &&
          bands.treble > 0.4 &&
          char !== ' ' &&
          Math.random() < CONFIG.MORPH_SHIMMER_CHANCE * bands.treble
        ) {
          const shimmerIdx = Math.floor(Math.random() * this._noiseChars.length);
          char = this._noiseChars[shimmerIdx];
          brightness = 0.9;
        }

        setCell(gc, gr, char, brightness);
      }
    }

    // Figure name label
    if (this._targetFigure) {
      const label = '[ ' + this._targetFigure.name.toUpperCase() + ' ]';
      const lc = Math.max(0, Math.floor((cols - label.length) / 2));
      const lr = startRow + figH + 1;
      if (lr < rows) {
        setString(lc, lr, label, 0.3);
      }
    }

    // Transition progress bar
    if (this._tweenProgress < 1.0) {
      const barW = Math.min(figW, cols - startCol);
      const filled = Math.floor(this._tweenProgress * barW);
      const barRow = startRow - 2;
      if (barRow >= 0) {
        for (let c = 0; c < barW; c++) {
          setCell(startCol + c, barRow, c < filled ? '▓' : '░', c < filled ? 0.6 : 0.15);
        }
      }
    }

    this._frameIndex++;
  }
}
