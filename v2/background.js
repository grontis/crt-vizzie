// v2/background.js — V2BackgroundLayer
// Loads a background image or video, downsamples it to grid resolution on a
// hidden canvas, and exposes getLuma(col, row) for per-cell brightness sampling.
//
// Usage:
//   const bg = new V2BackgroundLayer()
//   await bg.loadDefault()                     // resolves when image is ready
//   bg.resample(renderer.cols, renderer.rows)  // called on init + resize
//   bg.tick()                                  // call each frame — no-op for images, resamples video
//   const luma = bg.getLuma(c, r)              // returns float in [0, 1]
//
// Load order: after config.js

'use strict';

class V2BackgroundLayer {

  constructor() {
    this._img      = new Image();
    this._video    = null;   // HTMLVideoElement when a video file is loaded
    this._source   = null;   // points to _img or _video — the canvas-drawable source
    this._canvas   = document.createElement('canvas'); // never appended to DOM
    this._ctx2d    = this._canvas.getContext('2d');
    this._lumaData = new Float32Array(0);
    this._cols     = 0;
    this._rows     = 0;
    this._loaded   = false;
    this._isVideo  = false;
    this._objURL   = null;   // current object URL — revoked on next load
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
        this._source  = this._img;
        this._isVideo = false;
        this._loaded  = true;
        if (this._cols > 0 && this._rows > 0) this.resample(this._cols, this._rows);
        resolve();
      };
      this._img.onerror = () => {
        console.warn('[V2BackgroundLayer] Failed to load background image — getLuma() will return 0.5');
        resolve();
      };
      this._img.src = 'background_images/lminalpool.jpg';
    });
  }

  /**
   * Load a user-selected image or video File.
   * Updates the visible #v2-bg-image element automatically.
   * @param {File} file
   * @returns {Promise<void>}
   */
  loadFromFile(file) {
    if (this._objURL) {
      URL.revokeObjectURL(this._objURL);
      this._objURL = null;
    }

    const objURL = URL.createObjectURL(file);
    this._objURL = objURL;
    this._loaded = false;

    if (file.type.startsWith('video/')) {
      return this._loadVideo(objURL);
    }
    return this._loadImage(objURL);
  }

  /**
   * Call each render frame. For video sources, resamples the current video
   * frame so getLuma() stays in sync with playback. No-op for images.
   */
  tick() {
    if (!this._isVideo || !this._video || this._video.readyState < 2) return;
    if (this._cols > 0 && this._rows > 0) this._drawSource();
  }

  /**
   * Downsample the current source to cols×rows and compute per-cell luma values.
   * Must be called on init (after loadDefault resolves) and on every resize.
   * @param {number} cols
   * @param {number} rows
   */
  resample(cols, rows) {
    if (!this._loaded || !this._source) return;
    if (cols <= 0 || rows <= 0) return;

    this._cols = cols;
    this._rows = rows;
    this._canvas.width  = cols;
    this._canvas.height = rows;

    this._drawSource();
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

  // ── Private ────────────────────────────────────────────────────────────────

  _loadImage(src) {
    this._stopVideo();

    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        this._img     = img;
        this._source  = img;
        this._isVideo = false;
        this._loaded  = true;
        this._updateVisibleEl(null, src);
        if (this._cols > 0 && this._rows > 0) this.resample(this._cols, this._rows);
        resolve();
      };
      img.onerror = () => {
        console.warn('[V2BackgroundLayer] Failed to load image file');
        resolve();
      };
      img.src = src;
    });
  }

  _loadVideo(src) {
    this._stopVideo();

    return new Promise((resolve) => {
      const video = document.createElement('video');
      video.src        = src;
      video.loop       = true;
      video.muted      = true;
      video.playsInline = true;
      video.autoplay   = true;

      video.addEventListener('canplay', () => {
        this._video   = video;
        this._source  = video;
        this._isVideo = true;
        this._loaded  = true;
        video.play().catch(() => {});
        this._updateVisibleEl(video, null);
        if (this._cols > 0 && this._rows > 0) this.resample(this._cols, this._rows);
        resolve();
      }, { once: true });

      video.addEventListener('error', () => {
        console.warn('[V2BackgroundLayer] Failed to load video file');
        resolve();
      }, { once: true });
    });
  }

  _stopVideo() {
    if (this._video) {
      this._video.pause();
      this._video.src = '';
      this._video = null;
    }
    this._isVideo = false;
  }

  _updateVisibleEl(videoEl, imageSrc) {
    const el = document.getElementById('v2-bg-image');
    if (!el) return;

    // Remove any previously embedded video
    const prev = el.querySelector('video');
    if (prev) prev.remove();

    if (videoEl) {
      videoEl.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;object-fit:cover;';
      el.style.background   = 'none';
      el.appendChild(videoEl);
    } else if (imageSrc) {
      el.style.background = `url(${imageSrc}) center / cover no-repeat`;
    }
  }

  // Draws _source to the hidden canvas and recomputes _lumaData.
  _drawSource() {
    try {
      this._ctx2d.drawImage(this._source, 0, 0, this._cols, this._rows);
    } catch {
      return; // video frame not ready or cross-origin
    }

    const imageData = this._ctx2d.getImageData(0, 0, this._cols, this._rows);
    const data      = imageData.data;

    this._lumaData = new Float32Array(this._cols * this._rows);
    for (let i = 0; i < this._cols * this._rows; i++) {
      const r = data[i * 4];
      const g = data[i * 4 + 1];
      const b = data[i * 4 + 2];
      // BT.601 luma coefficients, normalized to [0, 1]
      this._lumaData[i] = (r * 0.299 + g * 0.587 + b * 0.114) / 255;
    }
  }

}
