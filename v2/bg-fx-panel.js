// v2/bg-fx-panel.js — BgFxPanel: fixed-position overlay for live-tuning bg FX params
//
// Provides a minimal DOM panel for adjusting all BG FX params directly in
// the browser without a hardware bridge. Toggle with Tab key.
//
// syncState() exists so callers (e.g. hardware-bridge.js) that mutate V2_PARAMS
// externally can push fresh values into the panel controls on demand.
//
// Load order: after bg-fx.js, before startup.js

'use strict';

class BgFxPanel {

  constructor() {
    this._panel      = null;
    this._enabledCb  = null;
    this._sliders    = {}; // keyed by param name
    this._readouts   = {}; // keyed by param name

    this._buildDOM();
  }

  // ── DOM construction ───────────────────────────────────────────────────────

  _buildDOM() {
    // Inject styles once — scoped to #bg-fx-panel to avoid polluting global scope
    const style = document.createElement('style');
    style.textContent = `
      #bg-fx-panel {
        position: fixed;
        top: 12px;
        right: 12px;
        background: rgba(0, 0, 0, 0.85);
        border: 1px solid #00ff41;
        font-family: 'Orbitron', monospace;
        font-size: 12px;
        color: #00ff41;
        padding: 12px 14px;
        min-width: 280px;
        z-index: 150;
        pointer-events: auto;
        display: none;
      }
      #bg-fx-panel h3 {
        margin: 0 0 10px 0;
        font-size: 13px;
        letter-spacing: 2px;
        text-transform: uppercase;
      }
      .bg-fx-row {
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 8px;
        margin-bottom: 6px;
      }
      .bg-fx-row label {
        flex: 0 0 auto;
        white-space: nowrap;
      }
      .bg-fx-row input[type="range"] {
        flex: 1 1 auto;
        width: 100%;
        accent-color: #00ff41;
      }
      .bg-fx-readout {
        flex: 0 0 40px;
        text-align: right;
        font-variant-numeric: tabular-nums;
      }
      .bg-fx-row input[type="checkbox"] {
        accent-color: #00ff41;
        width: 14px;
        height: 14px;
        cursor: pointer;
      }
    `;
    document.head.appendChild(style);

    const panel = document.createElement('div');
    panel.id = 'bg-fx-panel';

    const heading = document.createElement('h3');
    heading.textContent = 'BG FX';
    panel.appendChild(heading);

    // Checkbox row: bgFxEnabled
    panel.appendChild(this._buildCheckboxRow());

    // Slider rows in specified panel order:
    //   1. Opacity           (bgOpacity)        — base opacity, always active when bg on
    //   2. Hue shift         (bgFxHueShift)
    //   3. Saturation        (bgFxSaturation)
    //   4. Brightness flash  (bgFxBrightness)
    //   5. Contrast          (bgFxContrast)
    //   6. Blur              (bgFxBlur)
    //   7. Sepia             (bgFxSepia)
    //   8. Grayscale         (bgFxGrayscale)
    //   9. Invert flash      (bgFxInvert)       — beat-driven envelope
    //  10. Scale pulse       (bgFxScalePulse)   — beat-driven zoom envelope
    const sliderDefs = [
      { key: 'bgOpacity',      label: 'Opacity',          step: 0.05, fmt: 'two'  },
      { key: 'bgFxHueShift',   label: 'Hue shift',        step: 1,    fmt: 'deg'  },
      { key: 'bgFxSaturation', label: 'Saturation',        step: 0.05, fmt: 'two'  },
      { key: 'bgFxBrightness', label: 'Brightness flash',  step: 0.05, fmt: 'two'  },
      { key: 'bgFxContrast',   label: 'Contrast',          step: 0.05, fmt: 'two'  },
      { key: 'bgFxBlur',       label: 'Blur',              step: 0.1,  fmt: 'one'  },
      { key: 'bgFxSepia',      label: 'Sepia',             step: 0.05, fmt: 'two'  },
      { key: 'bgFxGrayscale',  label: 'Grayscale',         step: 0.05, fmt: 'two'  },
      { key: 'bgFxInvert',     label: 'Invert flash',      step: 0.05, fmt: 'two'  },
      { key: 'bgFxScalePulse', label: 'Scale pulse',       step: 0.01, fmt: 'two'  },
    ];

    for (const def of sliderDefs) {
      panel.appendChild(this._buildSliderRow(def));
    }

    document.body.appendChild(panel);
    this._panel = panel;
  }

  _buildCheckboxRow() {
    const row = document.createElement('div');
    row.className = 'bg-fx-row';

    const label = document.createElement('label');
    label.textContent = 'Enabled';
    label.htmlFor = 'bg-fx-enabled-cb';

    const cb = document.createElement('input');
    cb.type  = 'checkbox';
    cb.id    = 'bg-fx-enabled-cb';
    cb.checked = !!window.V2_PARAMS.bgFxEnabled;

    cb.addEventListener('change', () => {
      window.V2_PARAMS.bgFxEnabled = cb.checked;
    });

    row.appendChild(label);
    row.appendChild(cb);
    this._enabledCb = cb;
    return row;
  }

  _buildSliderRow({ key, label: labelText, step, fmt }) {
    const ranges = window.V2_PARAM_RANGES;
    const range  = ranges[key];
    const min    = range.min;
    const max    = range.max;

    const row = document.createElement('div');
    row.className = 'bg-fx-row';

    const label = document.createElement('label');
    label.textContent = labelText;
    label.htmlFor     = `bg-fx-slider-${key}`;

    const slider = document.createElement('input');
    slider.type  = 'range';
    slider.id    = `bg-fx-slider-${key}`;
    slider.min   = min;
    slider.max   = max;
    slider.step  = step;
    slider.value = window.V2_PARAMS[key];

    const readout = document.createElement('span');
    readout.className = 'bg-fx-readout';
    readout.textContent = this._format(window.V2_PARAMS[key], fmt);

    slider.addEventListener('input', () => {
      const val = parseFloat(slider.value);
      window.V2_PARAMS[key] = val;
      readout.textContent = this._format(val, fmt);
    });

    row.appendChild(label);
    row.appendChild(slider);
    row.appendChild(readout);

    this._sliders[key]  = slider;
    this._readouts[key] = { el: readout, fmt };
    return row;
  }

  // ── Formatting ─────────────────────────────────────────────────────────────

  _format(val, fmt) {
    switch (fmt) {
      case 'deg': return val.toFixed(0);
      case 'one': return val.toFixed(1);
      case 'two': return val.toFixed(2);
      default:    return val.toFixed(2);
    }
  }

  // ── Visibility ─────────────────────────────────────────────────────────────

  show() {
    this._panel.style.display = 'block';
  }

  hide() {
    this._panel.style.display = 'none';
  }

  /**
   * Toggle visibility.
   * @returns {boolean} true if the panel is now visible, false if hidden.
   */
  toggle() {
    const nowVisible = this._panel.style.display === 'none' || this._panel.style.display === '';
    if (nowVisible) {
      this.show();
    } else {
      this.hide();
    }
    return nowVisible;
  }

  /** @returns {boolean} true if the panel is currently visible. */
  get isVisible() {
    return this._panel.style.display !== 'none' && this._panel.style.display !== '';
  }

  /** @returns {boolean} true if el is the panel or a descendant of it. */
  contains(el) {
    return this._panel.contains(el);
  }

  // ── State sync ─────────────────────────────────────────────────────────────

  /**
   * Push current V2_PARAMS values into all controls.
   * Call when the panel becomes visible, or after external code mutates V2_PARAMS.
   */
  syncState() {
    const p = window.V2_PARAMS;

    if (this._enabledCb) {
      this._enabledCb.checked = !!p.bgFxEnabled;
    }

    for (const key of Object.keys(this._sliders)) {
      this._sliders[key].value = p[key];
      const r = this._readouts[key];
      r.el.textContent = this._format(p[key], r.fmt);
    }
  }

}
