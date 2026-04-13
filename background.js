// background.js — BackgroundLayer class
// Manages a background <img>/<video> DOM element and a hidden 2D canvas for luma sampling.

class BackgroundLayer {
  constructor() {
    this._mediaEl = document.getElementById('bg-media');
    this._sampleCanvas = document.getElementById('bg-sample');
    this._sampleCtx = this._sampleCanvas.getContext('2d');
    this._pixelData = null;
    this._sampleCols = 0;
    this._sampleRows = 0;
    this._visible = false;
    this._opacity = CONFIG.BG_DEFAULT_OPACITY;
    this._hasMedia = false;
    this._isVideo = false;
  }

  // Load a same-origin image path directly (no blob URL needed).
  loadUrl(url) {
    if (this._mediaEl.tagName !== 'IMG') {
      // Replace video element with img if needed
      const container = document.getElementById('canvas-container');
      const img = document.createElement('img');
      img.id = 'bg-media';
      img.alt = '';
      img.style.cssText = this._mediaEl.style.cssText;
      container.insertBefore(img, this._mediaEl);
      this._mediaEl.remove();
      this._mediaEl = img;
    }
    this._isVideo  = false;
    this._hasMedia = true;
    this._visible  = false;
    this._mediaEl.src = url;
    this._mediaEl.style.display  = 'none';
    this._mediaEl.style.opacity  = this._opacity;
  }

  // Load a File object (from drag-and-drop)
  load(file) {
    if (!file) return;

    // Clean up previous blob URL
    if (this._blobUrl) {
      URL.revokeObjectURL(this._blobUrl);
    }

    this._blobUrl = URL.createObjectURL(file);
    this._isVideo = file.type.startsWith('video/');

    // Replace <img> with <video> or vice versa as needed
    const container = document.getElementById('canvas-container');
    const oldEl = this._mediaEl;

    if (this._isVideo) {
      // Convert to video element if not already
      if (this._mediaEl.tagName !== 'VIDEO') {
        const video = document.createElement('video');
        video.id = 'bg-media';
        video.loop = true;
        video.muted = true;
        video.autoplay = true;
        video.playsInline = true;
        video.style.cssText = oldEl.style.cssText;
        container.insertBefore(video, oldEl);
        oldEl.remove();
        this._mediaEl = video;
      }
      this._mediaEl.src = this._blobUrl;
      this._mediaEl.play().catch(() => {});
    } else {
      // Convert to img element if not already
      if (this._mediaEl.tagName !== 'IMG') {
        const img = document.createElement('img');
        img.id = 'bg-media';
        img.alt = '';
        img.style.cssText = oldEl.style.cssText;
        container.insertBefore(img, oldEl);
        oldEl.remove();
        this._mediaEl = img;
      }
      this._mediaEl.src = this._blobUrl;
    }

    this._hasMedia = true;
    this._visible = true;
    this._mediaEl.style.display = 'block';
    this._mediaEl.style.opacity = this._opacity;
  }

  // Called each frame from sketch.js draw loop
  update(cols, rows) {
    if (!this._hasMedia || !this._visible) {
      this._pixelData = null;
      return;
    }

    // Resize sample canvas if grid dimensions changed
    if (this._sampleCols !== cols || this._sampleRows !== rows) {
      this._sampleCanvas.width = cols;
      this._sampleCanvas.height = rows;
      this._sampleCols = cols;
      this._sampleRows = rows;
    }

    // Check if media is ready to sample
    if (this._isVideo) {
      if (this._mediaEl.readyState < 2) return; // HAVE_CURRENT_DATA
    } else {
      if (!this._mediaEl.complete || this._mediaEl.naturalWidth === 0) return;
    }

    try {
      this._sampleCtx.drawImage(this._mediaEl, 0, 0, cols, rows);
      this._pixelData = this._sampleCtx.getImageData(0, 0, cols, rows).data;
    } catch (e) {
      // CORS or other error — silently skip sampling
      this._pixelData = null;
    }
  }

  // Returns luma 0–1 for a grid cell
  getLuma(col, row) {
    if (!this._pixelData) return 0;
    const idx = (row * this._sampleCols + col) * 4;
    if (idx < 0 || idx + 2 >= this._pixelData.length) return 0;
    const r = this._pixelData[idx];
    const g = this._pixelData[idx + 1];
    const b = this._pixelData[idx + 2];
    return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  }

  setOpacity(value) {
    this._opacity = Math.max(0, Math.min(1, value));
    if (this._mediaEl) {
      this._mediaEl.style.opacity = this._opacity;
    }
  }

  adjustOpacity(delta) {
    this.setOpacity(this._opacity + delta);
  }

  toggle() {
    if (!this._hasMedia) return;
    this._visible = !this._visible;
    this._mediaEl.style.display = this._visible ? 'block' : 'none';
  }

  get isVisible() { return this._visible; }
  get opacity() { return this._opacity; }
  get hasMedia() { return this._hasMedia; }
}
