// v2/background.js — V2BackgroundLayer
// Loads a background image or video, downsamples it to grid resolution on a
// hidden canvas, and exposes getLuma(col, row) for per-cell brightness sampling.
//
// Usage:
//   const bg = new V2BackgroundLayer()
//   await bg.loadFromFile(file)                // load from a user-selected File object
//   bg.resample(renderer.cols, renderer.rows)  // called on init + resize
//   bg.tick()                                  // call each frame — no-op for images, resamples video
//   const luma = bg.getLuma(c, r)              // returns float in [0, 1]
//
// Load order: after config.js

'use strict';

class V2BackgroundLayer {

  constructor() {
    this._img      = null;   // set by _loadImage() on first image load
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
    this.onVideoEnded = null; // optional callback — set by sketch.js to advance playlist
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  get isLoaded() { return this._loaded; }

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
   * Must be called after a successful load and on every resize.
   * @param {number} cols
   * @param {number} rows
   */
  resample(cols, rows) {
    if (cols <= 0 || rows <= 0) return;

    // Cache dimensions even when no source is loaded yet, so an async load
    // completing later can self-resample using the stored cols/rows.
    const dimsChanged = (cols !== this._cols) || (rows !== this._rows);
    this._cols = cols;
    this._rows = rows;

    // Pre-allocate the luma buffer on dimension change. _drawSource() reuses
    // it every frame to avoid per-frame GC churn (matters on Pi).
    if (dimsChanged || this._lumaData.length !== cols * rows) {
      this._lumaData = new Float32Array(cols * rows);
    }

    if (!this._loaded || !this._source) return;

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
      video.muted      = true;
      video.playsInline = true;
      video.autoplay   = true;

      // Both listeners share an AbortController so whichever fires first
      // removes the other. Without this the unused listener stays attached
      // and fires later when _stopVideo() sets src='' on cleanup, producing
      // a spurious "Empty src attribute" error log for an already-loaded video.
      const ac = new AbortController();

      video.addEventListener('canplay', () => {
        ac.abort();
        // Chromium can fire canplay for files where it demuxed the container
        // and decoded audio but couldn't decode the video stream (e.g. HEVC,
        // some AV1 builds). videoWidth/Height stay at 0 in that case. Treat
        // it as a load failure so the playlist skips to the next entry.
        if (video.videoWidth === 0 || video.videoHeight === 0) {
          console.warn('[V2BackgroundLayer] Video stream not decodable (likely unsupported codec):', src);
          resolve();
          return;
        }
        this._video   = video;
        this._source  = video;
        this._isVideo = true;
        this._loaded  = true;
        video.play().catch(() => {});
        video.addEventListener('ended', () => {
          if (this.onVideoEnded) this.onVideoEnded();
        });
        this._updateVisibleEl(video, null);
        if (this._cols > 0 && this._rows > 0) this.resample(this._cols, this._rows);
        resolve();
      }, { signal: ac.signal });

      video.addEventListener('error', () => {
        ac.abort();
        const err = video.error;
        // MediaError codes: 1=ABORTED, 2=NETWORK, 3=DECODE, 4=SRC_NOT_SUPPORTED
        const codeName = err
          ? ({ 1: 'ABORTED', 2: 'NETWORK', 3: 'DECODE', 4: 'SRC_NOT_SUPPORTED' }[err.code] || `code=${err.code}`)
          : 'unknown';
        console.warn(`[V2BackgroundLayer] Failed to load video file (${codeName})`,
          err && err.message ? err.message : '', src);
        resolve();
      }, { signal: ac.signal });
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
      // imageSrc is always a blob URL from URL.createObjectURL (local file) — no escaping needed
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
    const luma      = this._lumaData; // reused buffer; resample() owns its size
    const n         = this._cols * this._rows;

    for (let i = 0; i < n; i++) {
      const r = data[i * 4];
      const g = data[i * 4 + 1];
      const b = data[i * 4 + 2];
      // BT.601 luma coefficients, normalized to [0, 1]
      luma[i] = (r * 0.299 + g * 0.587 + b * 0.114) / 255;
    }
  }

}
