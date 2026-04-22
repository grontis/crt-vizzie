// background.js — BackgroundLayer class
// Manages a background <img>/<video> DOM element and a hidden 2D canvas for luma sampling.
// Supports a playlist of multiple media items (images and/or videos).

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

    // Playlist state
    // Each entry: { url: string|null, blobUrl: string|null, isVideo: boolean, name: string }
    // url is the src string (path or blob: URL). blobUrl tracks blob: URLs created by this class.
    this._playlist = [];
    this._playlistIndex = -1;
  }

  // ── Private: navigate to a playlist entry by index ───────────────────────

  _goTo(index) {
    if (this._playlist.length === 0 || index < 0 || index >= this._playlist.length) return;

    const entry = this._playlist[index];
    const isVideo = entry.isVideo;

    // Swap DOM element type if needed (img ↔ video)
    if (isVideo !== this._isVideo) {
      const container = document.getElementById('canvas-container');
      const oldEl = this._mediaEl;

      if (isVideo) {
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
      } else {
        const img = document.createElement('img');
        img.id = 'bg-media';
        img.alt = '';
        img.style.cssText = oldEl.style.cssText;
        container.insertBefore(img, oldEl);
        oldEl.remove();
        this._mediaEl = img;
      }
    }

    this._mediaEl.src = entry.url;
    if (isVideo) {
      this._mediaEl.loop = true;
      this._mediaEl.muted = true;
      this._mediaEl.autoplay = true;
      this._mediaEl.playsInline = true;
      this._mediaEl.play().catch(() => {});
    }

    this._isVideo = isVideo;
    this._hasMedia = true;
    this._playlistIndex = index;
    this._mediaEl.style.opacity = this._opacity;
    // Visibility (_visible, display) is the caller's responsibility — _goTo does not change it.
  }

  // ── Public: playlist management ───────────────────────────────────────────

  // Add a same-origin URL (or any URL string) to the playlist.
  // Does NOT force visibility — caller controls when to show.
  addUrl(url, name) {
    const entryName = name || url.split('/').pop();
    const isVideo = /\.(mp4|webm|ogg)$/i.test(url);
    this._playlist.push({ url, blobUrl: null, isVideo, name: entryName });
    if (this._playlist.length === 1) {
      // First item — load it into the DOM (invisible until toggled)
      this._goTo(0);
    }
    return this._playlist.length - 1;
  }

  // Add a File object to the playlist. Forces visibility (mirrors original load() behavior).
  addFile(file) {
    const blobUrl = URL.createObjectURL(file);
    const isVideo = file.type.startsWith('video/');
    this._playlist.push({ url: blobUrl, blobUrl, isVideo, name: file.name });
    this._goTo(this._playlist.length - 1);
    // File additions always make the background visible
    this._visible = true;
    this._mediaEl.style.display = 'block';
    return this._playlist.length - 1;
  }

  // Navigate to the next playlist item (wraps around).
  next() {
    if (this._playlist.length < 2) return;
    this._goTo((this._playlistIndex + 1) % this._playlist.length);
  }

  // Navigate to the previous playlist item (wraps around).
  prev() {
    if (this._playlist.length < 2) return;
    this._goTo((this._playlistIndex - 1 + this._playlist.length) % this._playlist.length);
  }

  // ── Backward-compat wrappers ──────────────────────────────────────────────

  // Load a same-origin image path directly (backward compat — calls addUrl).
  loadUrl(url) {
    this.addUrl(url, url.split('/').pop());
  }

  // Load a File object (backward compat — calls addFile).
  load(file) {
    if (!file) return;
    this.addFile(file);
  }

  // ── Frame update & sampling ───────────────────────────────────────────────

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

  // ── Opacity & visibility ──────────────────────────────────────────────────

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

  // ── Getters ───────────────────────────────────────────────────────────────

  get isVisible()      { return this._visible; }
  get opacity()        { return this._opacity; }
  get hasMedia()       { return this._hasMedia; }
  get mediaElement()   { return this._mediaEl; }
  get isVideo()        { return this._isVideo; }
  get playlistLength() { return this._playlist.length; }
  get playlistIndex()  { return this._playlistIndex; }
}
