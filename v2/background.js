// v2/background.js — V2BackgroundLayer
// Loads a background image, downsamples it to grid resolution on a hidden
// canvas, and exposes getLuma(col, row) for per-cell brightness sampling.
//
// Usage:
//   const bg = new V2BackgroundLayer()
//   await bg.loadDefault()          // resolves when image is ready
//   bg.resample(renderer.cols, renderer.rows)  // called on init + resize
//   const luma = bg.getLuma(c, r)   // returns float in [0, 1]
//
// Load order: after config.js

'use strict';

class V2BackgroundLayer {

  constructor() {
    this._img    = new Image();
    this._canvas = document.createElement('canvas'); // never appended to DOM
    this._ctx2d  = this._canvas.getContext('2d');
    this._lumaData = new Float32Array(0);
    this._cols   = 0;
    this._rows   = 0;
    this._loaded = false;
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Load the default background image.
   * Resolves when the image is ready (or fails gracefully with a warning).
   * @returns {Promise<void>}
   */
  loadDefault() {
    return new Promise((resolve) => {
      this._img.onload = () => {
        this._loaded = true;
        // If resample() was already called with valid dimensions, resample now.
        if (this._cols > 0 && this._rows > 0) {
          this.resample(this._cols, this._rows);
        }
        resolve();
      };
      this._img.onerror = () => {
        console.warn('[V2BackgroundLayer] Failed to load background image — getLuma() will return 0.5');
        resolve(); // resolve (not reject) so init() always continues
      };
      // Path is relative to v2/index.html
      this._img.src = 'background_images/lminalpool.jpg';
    });
  }

  /**
   * Downsample the image to cols×rows and compute per-cell luma values.
   * Must be called on init (after loadDefault resolves) and on every resize.
   * @param {number} cols
   * @param {number} rows
   */
  resample(cols, rows) {
    if (!this._loaded) return; // image not yet loaded — guard
    if (cols <= 0 || rows <= 0) return;

    this._cols = cols;
    this._rows = rows;
    this._canvas.width  = cols;
    this._canvas.height = rows;

    // Draw the full image scaled to grid dimensions
    this._ctx2d.drawImage(this._img, 0, 0, cols, rows);

    const imageData = this._ctx2d.getImageData(0, 0, cols, rows);
    const data      = imageData.data; // Uint8ClampedArray: [r,g,b,a, r,g,b,a, ...]

    this._lumaData = new Float32Array(cols * rows);
    for (let i = 0; i < cols * rows; i++) {
      const r = data[i * 4];
      const g = data[i * 4 + 1];
      const b = data[i * 4 + 2];
      // BT.601 luma coefficients, normalized to [0, 1]
      this._lumaData[i] = (r * 0.299 + g * 0.587 + b * 0.114) / 255;
    }
  }

  /**
   * Return the luma value for a grid cell.
   * @param {number} col
   * @param {number} row
   * @returns {number} float in [0, 1]; returns 0.5 if not loaded or out of bounds
   */
  getLuma(col, row) {
    if (!this._loaded || this._cols === 0 || this._rows === 0) return 0.5;
    if (col < 0 || col >= this._cols || row < 0 || row >= this._rows) return 0.5;
    return this._lumaData[row * this._cols + col];
  }

}
