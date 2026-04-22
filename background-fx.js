// background-fx.js — BackgroundFX class
//
// Pixel-pipeline canvas FX for the background media element.
// Draws the raw media through posterize → warp → scanline corruption →
// chromatic aberration → beat flash, all on a dedicated <canvas id="bg-fx-canvas">
// layered between the raw media element and the p5 canvas.
//
// No p5 dependency — plain Canvas 2D API only.
// Reads FUSION_PARAMS.bgFx for all parameters.
// Must be loaded after background.js and fusion-params.js, before sketch.js.

class BackgroundFX {
  constructor(backgroundLayer) {
    this._bg = backgroundLayer;

    // Grab the FX canvas from the DOM (inserted by index.html)
    this._canvas = document.getElementById('bg-fx-canvas');
    this._ctx = this._canvas.getContext('2d', { willReadFrequently: true });

    // Offscreen scratch canvas — used as un-modified read source for warp
    this._scratch = document.createElement('canvas');
    this._scratchCtx = this._scratch.getContext('2d', { willReadFrequently: true });

    this._fxW = 0;
    this._fxH = 0;

    // Warp time accumulator
    this._warpTime = 0;

    // Flash alpha state
    this._flashAlphaVal = 0;

    // Corrupt strip state — array of { y, h, shift, framesLeft }
    this._corruptStrips = [];
    this._corruptCooldown = 0;
  }

  // Hides the FX canvas and restores the raw media element. Called when not in Fusion mode.
  hide() {
    this._canvas.style.display = 'none';
    const bg = this._bg;
    if (bg.hasMedia && bg.mediaElement) {
      bg.mediaElement.style.display = bg.isVisible ? 'block' : 'none';
    }
  }

  // Called each frame from sketch.js draw loop after backgroundLayer.update()
  update(audioManager) {
    const bgFx = window.FUSION_PARAMS && window.FUSION_PARAMS.bgFx;
    if (!bgFx) return;

    const bg = this._bg;

    // Guard: if disabled or no visible media, hide FX canvas, restore raw media, and return
    if (!bgFx.enabled || !bg.hasMedia || !bg.isVisible) {
      this._canvas.style.display = 'none';
      // Restore the raw media element display so BackgroundLayer retains control
      if (bg.hasMedia && bg.mediaElement) {
        bg.mediaElement.style.display = bg.isVisible ? 'block' : 'none';
      }
      return;
    }

    // Check media readiness BEFORE touching visibility so the first frame does not
    // briefly flash blank canvas in place of the source image/video
    const mediaEl = bg.mediaElement;
    if (bg.isVideo) {
      if (mediaEl.readyState < 2) return;
    } else {
      if (!mediaEl.complete || mediaEl.naturalWidth === 0) return;
    }

    // Resize FX canvas if container dimensions changed
    const container = this._canvas.parentElement;
    // Guard: if container is missing or has not been laid out yet, skip this frame
    if (!container || container.offsetWidth === 0 || container.offsetHeight === 0) return;
    const w = Math.min(container.offsetWidth,  1280);
    const h = Math.min(container.offsetHeight, 720);

    // Media is ready — now swap visibility atomically:
    // show FX canvas, hide raw media so only the processed canvas is visible
    this._canvas.style.display = 'block';
    bg.mediaElement.style.display = 'none';
    this._ensureCanvas(w, h);

    // Draw source media into FX canvas
    try {
      this._ctx.drawImage(mediaEl, 0, 0, w, h);
    } catch (e) {
      // CORS or other error — skip frame silently
      return;
    }

    // Collect audio state once
    const beatActive    = audioManager && audioManager.beatActive;
    const beatIntensity = (audioManager && audioManager.beatIntensity) || 0;
    let bassEnergy = 0;
    if (audioManager && typeof audioManager.getBands === 'function') {
      try {
        const bands = audioManager.getBands();
        // bands[0] and bands[1] are typically sub-bass and bass
        if (bands && bands.length > 0) {
          bassEnergy = (bands[0] + (bands[1] || 0)) * 0.5;
        }
      } catch (e) { /* ignore */ }
    }

    // 1. Posterize
    if (bgFx.posterizeEnabled) {
      this._applyPosterize(this._ctx, w, h, bgFx.posterizeLevels);
    }

    // Copy posterized result to scratch canvas (unmodified source for warp)
    this._copyToScratch(w, h);

    // 2. Warp
    if (bgFx.warpEnabled) {
      this._applyWarp(this._ctx, this._scratchCtx, w, h, bgFx, bassEnergy, beatIntensity, beatActive);
    }

    // 3. Scanline corruption (beat-gated)
    if (bgFx.corruptEnabled) {
      this._applyCorrupt(this._ctx, w, h, bgFx, beatIntensity, beatActive);
    }

    // 4. Chromatic aberration
    if (bgFx.chromaEnabled) {
      this._applyChroma(this._ctx, w, h, bgFx, beatIntensity);
    }

    // 5. Beat flash
    if (bgFx.flashEnabled) {
      this._applyFlash(this._ctx, w, h, bgFx, beatActive);
    }

    // Advance warp time accumulator
    this._warpTime += 0.02;
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  _ensureCanvas(w, h) {
    if (this._fxW === w && this._fxH === h) return;
    this._canvas.width  = w;
    this._canvas.height = h;
    this._scratch.width  = w;
    this._scratch.height = h;
    this._fxW = w;
    this._fxH = h;
  }

  _copyToScratch(w, h) {
    this._scratchCtx.drawImage(this._canvas, 0, 0, w, h);
  }

  _applyPosterize(ctx, w, h, levels) {
    if (levels < 2) levels = 2;
    const step = 255 / (levels - 1);

    const imgData = ctx.getImageData(0, 0, w, h);
    const data = imgData.data;
    const len = data.length;

    for (let i = 0; i < len; i += 4) {
      data[i]     = Math.round(data[i]     / step) * step;
      data[i + 1] = Math.round(data[i + 1] / step) * step;
      data[i + 2] = Math.round(data[i + 2] / step) * step;
      // alpha (i+3) unchanged
    }

    ctx.putImageData(imgData, 0, 0);
  }

  _applyWarp(ctx, scratchCtx, w, h, params, bassEnergy, beatIntensity, beatActive) {
    const freq      = params.warpFreq;
    const baseAmt   = params.warpAmount;
    const beatMult  = params.warpBeatMult;
    const time      = this._warpTime;

    // Scale amplitude by bass energy; spike on beat
    let amplitude = baseAmt * (0.3 + bassEnergy * 0.7);
    if (beatActive) {
      amplitude += baseAmt * beatIntensity * beatMult;
    }

    // Read from scratch (posterized, un-warped) and write warped result to ctx
    const srcData = scratchCtx.getImageData(0, 0, w, h);
    const src = srcData.data;

    const outData = ctx.createImageData(w, h);
    const out = outData.data;

    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        // Compute displacement
        const dx = Math.sin(y * freq + time)       * amplitude;
        const dy = Math.cos(x * freq + time * 0.7) * amplitude;

        const sx = Math.max(0, Math.min(w - 1, Math.round(x + dx)));
        const sy = Math.max(0, Math.min(h - 1, Math.round(y + dy)));

        const dstIdx = (y  * w + x)  * 4;
        const srcIdx = (sy * w + sx) * 4;

        out[dstIdx]     = src[srcIdx];
        out[dstIdx + 1] = src[srcIdx + 1];
        out[dstIdx + 2] = src[srcIdx + 2];
        out[dstIdx + 3] = src[srcIdx + 3];
      }
    }

    ctx.putImageData(outData, 0, 0);
  }

  _applyCorrupt(ctx, w, h, params, beatIntensity, beatActive) {
    // Tick down existing active strips
    if (this._corruptCooldown > 0) this._corruptCooldown--;

    // Trigger new strips on beat when intensity meets threshold
    if (beatActive && beatIntensity >= params.corruptThresh && this._corruptCooldown === 0) {
      const stripCount = Math.max(0, Math.round(params.corruptStrips));
      this._corruptStrips = [];
      for (let i = 0; i < stripCount; i++) {
        const stripH = Math.floor(Math.random() * 4) + 1;  // 1–4 rows
        const y      = Math.floor(Math.random() * Math.max(1, h - stripH));
        const shift  = (Math.random() < 0.5 ? -1 : 1) *
                       Math.floor(Math.random() * params.corruptAmount + 2);
        this._corruptStrips.push({ y, h: stripH, shift, framesLeft: 8 });
      }
      this._corruptCooldown = 12;
    }

    // Decay existing strips
    const alive = [];
    for (const strip of this._corruptStrips) {
      if (strip.framesLeft <= 0) continue;
      strip.framesLeft--;

      // Shift strip pixels horizontally by strip.shift, wrapping
      const stripData = ctx.getImageData(0, strip.y, w, strip.h);
      const src = new Uint8ClampedArray(stripData.data);
      const out = stripData.data;
      const shift = strip.shift;

      for (let row = 0; row < strip.h; row++) {
        for (let col = 0; col < w; col++) {
          const dstIdx = (row * w + col) * 4;
          // Wrap source column
          let srcCol = ((col - shift) % w + w) % w;
          const srcIdx = (row * w + srcCol) * 4;
          out[dstIdx]     = src[srcIdx];
          out[dstIdx + 1] = src[srcIdx + 1];
          out[dstIdx + 2] = src[srcIdx + 2];
          out[dstIdx + 3] = src[srcIdx + 3];
        }
      }

      ctx.putImageData(stripData, 0, strip.y);
      alive.push(strip);
    }
    this._corruptStrips = alive;
  }

  _applyChroma(ctx, w, h, params, beatIntensity) {
    const offset = Math.round(params.chromaOffset + beatIntensity * params.chromaBeatMult);
    if (offset <= 0) return;

    const srcData = ctx.getImageData(0, 0, w, h);
    const src = srcData.data;

    const outData = ctx.createImageData(w, h);
    const out = outData.data;

    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const dstIdx = (y * w + x) * 4;

        // R channel shifted left by -offset
        const rx    = Math.max(0, Math.min(w - 1, x - offset));
        const rIdx  = (y * w + rx) * 4;

        // G channel unshifted
        const gIdx  = (y * w + x) * 4;

        // B channel shifted right by +offset
        const bx    = Math.max(0, Math.min(w - 1, x + offset));
        const bIdx  = (y * w + bx) * 4;

        out[dstIdx]     = src[rIdx];
        out[dstIdx + 1] = src[gIdx + 1];
        out[dstIdx + 2] = src[bIdx + 2];
        out[dstIdx + 3] = 255;
      }
    }

    ctx.putImageData(outData, 0, 0);
  }

  _applyFlash(ctx, w, h, params, beatActive) {
    // On beat: add flash alpha (capped at 1)
    if (beatActive) {
      this._flashAlphaVal = Math.min(1, this._flashAlphaVal + params.flashAlpha);
    }

    // Decay each frame
    this._flashAlphaVal = Math.max(0, this._flashAlphaVal - params.flashDecay);

    if (this._flashAlphaVal <= 0) return;

    ctx.globalAlpha = this._flashAlphaVal;
    ctx.fillStyle   = '#ffffff';
    ctx.fillRect(0, 0, w, h);
    ctx.globalAlpha = 1;
  }
}
