// v2/bg-fx.js — BgFxManager: audio-reactive CSS filter modulation on #v2-bg-image
// Applies brightness, saturation, hue-rotate, contrast, and optional blur each
// frame using values derived from audio band energy and beat intensity.
// Also manages opacity (persisted regardless of bgFxEnabled state) and
// transform scale pulse (beat-driven zoom envelope).
//
// Load order: after config.js and background.js, before sketch.js

'use strict';

class BgFxManager {

  constructor() {
    this._el = document.getElementById('v2-bg-image');
    if (!this._el) {
      console.warn('[BgFxManager] #v2-bg-image not found — update() and reset() are no-ops');
    }
    this._beatFlashCurrent  = 0;
    this._invertFlashCurrent = 0;
    this._scalePulseCurrent  = 0;

    // Set once — avoids a style mutation every frame for a value that never changes
    if (this._el) {
      this._el.style.transformOrigin = 'center center';
    }
  }

  /**
   * Called each frame when audio is active.
   *
   * Opacity is a base property the user wants persisted even when bgFxEnabled
   * is false — write it before the bgFxEnabled guard so it always tracks the
   * slider value while the bg layer is visible.
   *
   * The audio-reactive filter/transform pipeline only runs when bgFxEnabled
   * is true; the early return below gates that block.
   */
  update(audio) {
    if (!this._el) return;

    // Persist opacity whenever the bg layer is enabled, regardless of bgFxEnabled
    if (V2_PARAMS.bgEnabled) {
      this._el.style.opacity = String(V2_PARAMS.bgOpacity);
    }

    if (!V2_PARAMS.bgEnabled || !V2_PARAMS.bgFxEnabled) return;

    const p     = V2_PARAMS;
    const bands = audio.bands;

    // Beat-flash brightness envelope — 5-frame half-life at 30 fps
    this._beatFlashCurrent =
      this._beatFlashCurrent * 0.80 +
      audio.beatIntensity * p.bgFxBrightness * 0.20;

    // Invert flash envelope — same decay, gated by bgFxInvert param
    this._invertFlashCurrent =
      this._invertFlashCurrent * 0.80 +
      audio.beatIntensity * p.bgFxInvert * 0.20;

    // Scale pulse envelope — same decay, gated by bgFxScalePulse param
    this._scalePulseCurrent =
      this._scalePulseCurrent * 0.80 +
      audio.beatIntensity * p.bgFxScalePulse * 0.20;

    const hue      = bands.bass * p.bgFxHueShift;
    const sat      = 1.0 + audio.beatIntensity * p.bgFxSaturation;
    const bright   = 1.0 + this._beatFlashCurrent;
    const contrast = 1.0 + bands.mid * p.bgFxContrast;

    // Omit blur() entirely when the param is zero — some browsers still activate
    // the blur compositing path for blur(0px), which wastes GPU time.
    const blurPart = p.bgFxBlur > 0
      ? `blur(${(bands.treble * p.bgFxBlur).toFixed(1)}px) `
      : '';

    // Omit sepia/grayscale when zero to avoid triggering unnecessary compositor passes
    const sepiaPart     = p.bgFxSepia     > 0 ? ` sepia(${p.bgFxSepia.toFixed(2)})`     : '';
    const grayscalePart = p.bgFxGrayscale > 0 ? ` grayscale(${p.bgFxGrayscale.toFixed(2)})` : '';

    // Invert flash — skip when envelope is negligible (< 0.001) to avoid compositor pass
    const invertVal  = this._invertFlashCurrent;
    const invertPart = invertVal > 0.001 ? ` invert(${invertVal.toFixed(3)})` : '';

    // Filter emission order:
    // [blur if > 0] brightness saturate hue-rotate contrast [sepia if > 0] [grayscale if > 0] [invert if > 0]
    this._el.style.filter =
      `${blurPart}brightness(${bright.toFixed(2)}) saturate(${sat.toFixed(2)}) hue-rotate(${hue.toFixed(1)}deg) contrast(${contrast.toFixed(2)})${sepiaPart}${grayscalePart}${invertPart}`;

    // Scale pulse — only write transform when the envelope is non-negligible
    const scalePulse = this._scalePulseCurrent;
    if (scalePulse > 0.001) {
      this._el.style.transform = `scale(${(1 + scalePulse).toFixed(4)})`;
    }
  }

  /**
   * Clear all applied filters/transform/opacity and reset internal envelope state.
   * Called when bg is disabled (B key), bgFx is disabled (X key),
   * or audio transitions to idle.
   * Setting style properties to '' reasserts the page-level CSS defaults.
   */
  reset() {
    if (!this._el) return;
    this._el.style.filter    = '';
    this._el.style.transform = '';
    this._el.style.opacity   = '';
    this._beatFlashCurrent   = 0;
    this._invertFlashCurrent = 0;
    this._scalePulseCurrent  = 0;
  }

}
