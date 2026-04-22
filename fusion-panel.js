// fusion-panel.js — CRT-styled runtime parameter panel for FusionMode
//
// Builds <div id="fusion-panel"> and injects it into document.body.
// Exposes window.toggleFusionPanel() and window.hideFusionPanel().
//
// Must be loaded after fusion-params.js and modes/fusion.js.
// Must be loaded before sketch.js.

(function () {
  'use strict';

  if (typeof FUSION_PARAMS === 'undefined') {
    console.warn('[FusionPanel] FUSION_PARAMS not found — panel not built.');
    return;
  }

  // ── Inject panel CSS ──────────────────────────────────────────────────────

  const styleEl = document.createElement('style');
  styleEl.textContent = `
    #fusion-panel {
      position: fixed;
      bottom: 70px;
      right: 8px;
      width: min(700px, 96vw);
      background: var(--bg-dark, #0a0a0a);
      border: 2px solid var(--phosphor-dim, #00460f);
      color: var(--phosphor-mid, #00b428);
      font-family: 'Courier New', monospace;
      font-size: 11px;
      z-index: 100;
      box-shadow: 0 0 12px var(--phosphor-dim, #00460f);
      user-select: none;
    }

    #fusion-panel .fp-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 4px 8px;
      border-bottom: 1px solid var(--phosphor-dim, #00460f);
      background: linear-gradient(90deg, var(--bg-dark, #0a0a0a) 0%, #0d1a0d 100%);
    }

    #fusion-panel .fp-title {
      color: var(--phosphor-bright, #00ff41);
      font-weight: bold;
      letter-spacing: 2px;
      font-size: 12px;
      text-shadow: 0 0 6px var(--phosphor-bright, #00ff41);
    }

    #fusion-panel .fp-close {
      background: linear-gradient(180deg, #2a2a2a 0%, #111 50%, #1a1a1a 100%);
      border: 2px outset #444;
      color: var(--phosphor-bright, #00ff41);
      font-family: 'Courier New', monospace;
      font-size: 13px;
      font-weight: bold;
      width: 22px;
      height: 20px;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      padding: 0;
    }

    #fusion-panel .fp-close:hover {
      color: #fff;
      border-color: var(--phosphor-bright, #00ff41);
      text-shadow: 0 0 6px var(--phosphor-bright, #00ff41);
    }

    #fusion-panel .fp-body {
      padding: 6px 8px;
      display: flex;
      flex-direction: column;
      gap: 6px;
    }

    #fusion-panel .fp-section {
      border: 1px solid var(--phosphor-dim, #00460f);
      padding: 5px 7px;
    }

    #fusion-panel .fp-section-header {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 5px;
    }

    #fusion-panel .fp-section-label {
      color: var(--phosphor-bright, #00ff41);
      font-weight: bold;
      font-size: 11px;
      letter-spacing: 1px;
      min-width: 46px;
    }

    #fusion-panel .fp-toggle {
      background: linear-gradient(180deg, #2a2a2a 0%, #111 50%, #1a1a1a 100%);
      border: 2px outset #444;
      color: var(--phosphor-mid, #00b428);
      font-family: 'Courier New', monospace;
      font-size: 10px;
      font-weight: bold;
      padding: 1px 6px;
      height: 20px;
      cursor: pointer;
      letter-spacing: 0.5px;
    }

    #fusion-panel .fp-toggle:hover {
      color: var(--phosphor-bright, #00ff41);
      border-color: var(--phosphor-bright, #00ff41);
    }

    #fusion-panel .fp-toggle.fp-toggle-off {
      color: var(--phosphor-dim, #00460f);
      border-style: inset;
    }

    #fusion-panel .fp-sliders {
      display: flex;
      flex-wrap: wrap;
      gap: 4px 12px;
    }

    #fusion-panel .fp-slider-group {
      display: flex;
      flex-direction: column;
      gap: 1px;
      min-width: 90px;
    }

    #fusion-panel .fp-slider-top {
      display: flex;
      justify-content: space-between;
      align-items: baseline;
    }

    #fusion-panel .fp-slider-label {
      color: var(--phosphor-dim, #00460f);
      font-size: 10px;
      letter-spacing: 0.5px;
    }

    #fusion-panel .fp-slider-val {
      color: var(--phosphor-bright, #00ff41);
      font-size: 10px;
      font-weight: bold;
      min-width: 36px;
      text-align: right;
    }

    #fusion-panel input[type="range"] {
      -webkit-appearance: none;
      appearance: none;
      width: 100%;
      height: 4px;
      background: var(--phosphor-dim, #00460f);
      outline: none;
      border: none;
      cursor: pointer;
    }

    #fusion-panel input[type="range"]::-webkit-slider-thumb {
      -webkit-appearance: none;
      appearance: none;
      width: 10px;
      height: 14px;
      background: var(--phosphor-bright, #00ff41);
      cursor: pointer;
      box-shadow: 0 0 4px var(--phosphor-bright, #00ff41);
    }

    #fusion-panel input[type="range"]::-moz-range-thumb {
      width: 10px;
      height: 14px;
      background: var(--phosphor-bright, #00ff41);
      cursor: pointer;
      border: none;
      box-shadow: 0 0 4px var(--phosphor-bright, #00ff41);
    }

    #fusion-panel .fp-hint {
      color: var(--phosphor-dim, #00460f);
      font-size: 10px;
      text-align: right;
      padding: 2px 0 1px;
      letter-spacing: 0.5px;
    }
  `;
  document.head.appendChild(styleEl);

  // ── Panel state ───────────────────────────────────────────────────────────

  let panelEl = null;
  let panelVisible = false;

  // ── Builder helpers ───────────────────────────────────────────────────────

  // namespace: optional string — when provided, reads/writes FUSION_PARAMS[namespace][key]
  //            when absent, reads/writes FUSION_PARAMS[key] (flat, existing behaviour)
  function _makeSlider(label, key, min, max, step, namespace) {
    const obj = namespace ? FUSION_PARAMS[namespace] : FUSION_PARAMS;

    const group = document.createElement('div');
    group.className = 'fp-slider-group';

    const top = document.createElement('div');
    top.className = 'fp-slider-top';

    const labelEl = document.createElement('span');
    labelEl.className = 'fp-slider-label';
    labelEl.textContent = label;

    const valEl = document.createElement('span');
    valEl.className = 'fp-slider-val';

    // Format value — show more decimals for small step values
    function fmt(v) {
      if (step < 0.01) return v.toFixed(3);
      if (step < 0.1)  return v.toFixed(2);
      if (step < 1)    return v.toFixed(1);
      return String(Math.round(v));
    }

    valEl.textContent = fmt(obj[key]);

    top.appendChild(labelEl);
    top.appendChild(valEl);

    const slider = document.createElement('input');
    slider.type  = 'range';
    slider.min   = String(min);
    slider.max   = String(max);
    slider.step  = String(step);
    slider.value = String(obj[key]);
    // Data attributes used by syncFusionPanelState() to find the bound param
    slider.dataset.fpKey = key;
    if (namespace) slider.dataset.fpNamespace = namespace;

    slider.addEventListener('input', function () {
      const v = parseFloat(slider.value);
      obj[key] = v;
      valEl.textContent = fmt(v);
    });

    // Release focus back to document after interaction so Tab is not stolen
    slider.addEventListener('change', function () {
      slider.blur();
    });

    group.appendChild(top);
    group.appendChild(slider);
    return group;
  }

  function _makeToggle(key, namespace) {
    const obj = namespace ? FUSION_PARAMS[namespace] : FUSION_PARAMS;

    const btn = document.createElement('button');
    btn.className = 'fp-toggle';
    // Store sync metadata so the panel can re-sync on open after external changes
    btn.dataset.fpKey       = key;
    btn.dataset.fpNamespace = namespace || '';

    function syncBtn() {
      const nowOn = !!obj[key];
      btn.textContent = nowOn ? 'ON' : 'OFF';
      btn.classList.toggle('fp-toggle-off', !nowOn);
    }
    syncBtn();

    btn.addEventListener('click', function () {
      obj[key] = !obj[key];
      syncBtn();
      btn.blur();
    });

    return btn;
  }

  // Re-sync all toggle button visual states with the live FUSION_PARAMS values.
  // Called when the panel is opened so externally-changed params are reflected.
  function _syncToggleStates() {
    if (!panelEl) return;
    panelEl.querySelectorAll('.fp-toggle').forEach(function (btn) {
      const key       = btn.dataset.fpKey;
      const namespace = btn.dataset.fpNamespace;
      if (!key) return;
      const obj = namespace ? FUSION_PARAMS[namespace] : FUSION_PARAMS;
      const isOn = !!obj[key];
      btn.textContent = isOn ? 'ON' : 'OFF';
      btn.classList.toggle('fp-toggle-off', !isOn);
    });
  }

  function _makeSection(sectionLabel, toggleKey, sliderDefs, namespace) {
    const section = document.createElement('div');
    section.className = 'fp-section';

    const header = document.createElement('div');
    header.className = 'fp-section-header';

    const labelEl = document.createElement('span');
    labelEl.className = 'fp-section-label';
    labelEl.textContent = sectionLabel;

    header.appendChild(labelEl);
    header.appendChild(_makeToggle(toggleKey, namespace));
    section.appendChild(header);

    const sliders = document.createElement('div');
    sliders.className = 'fp-sliders';
    for (const def of sliderDefs) {
      sliders.appendChild(_makeSlider(def.label, def.key, def.min, def.max, def.step, namespace));
    }
    section.appendChild(sliders);
    return section;
  }

  // ── Build panel ───────────────────────────────────────────────────────────

  function buildFusionPanel() {
    const panel = document.createElement('div');
    panel.id = 'fusion-panel';
    panel.style.display = 'none';

    // Header
    const header = document.createElement('div');
    header.className = 'fp-header';

    const title = document.createElement('span');
    title.className = 'fp-title';
    title.textContent = 'FUSION PARAMS';

    const closeBtn = document.createElement('button');
    closeBtn.className = 'fp-close';
    closeBtn.textContent = '×';
    closeBtn.title = 'Close panel [TAB]';
    closeBtn.addEventListener('click', function () {
      window.hideFusionPanel();
    });

    header.appendChild(title);
    header.appendChild(closeBtn);
    panel.appendChild(header);

    // Body
    const body = document.createElement('div');
    body.className = 'fp-body';

    // FIGURE section
    body.appendChild(_makeSection('FIGURE', 'figureEnabled', [
      { label: 'DECAY',  key: 'figDecay',        min: 0.001, max: 0.03,  step: 0.001 },
      { label: 'BRIGHT', key: 'figBrightness',   min: 0.1,   max: 1.0,   step: 0.01  },
      { label: 'SMEAR',  key: 'figSmear',         min: 0,     max: 0.1,   step: 0.001 },
      { label: 'RESEED', key: 'figReseedFrames',  min: 40,    max: 400,   step: 10    },
    ]));

    // RAIN section — note: keep SPD MIN < SPD MAX
    body.appendChild(_makeSection('RAIN', 'rainEnabled', [
      { label: 'SPD MIN', key: 'rainSpeedMin',  min: 0.05, max: 0.5,  step: 0.01 },
      { label: 'SPD MAX', key: 'rainSpeedMax',  min: 0.3,  max: 2.0,  step: 0.05 },
      { label: 'TRAIL',   key: 'rainTrail',     min: 4,    max: 30,   step: 1    },
      { label: 'BEAT',    key: 'rainBeatMult',  min: 1.0,  max: 6.0,  step: 0.1  },
    ]));

    // GLITCH section
    body.appendChild(_makeSection('GLITCH', 'glitchEnabled', [
      { label: 'THRESH',  key: 'glitchThreshold', min: 0.3,  max: 0.95, step: 0.01  },
      { label: 'CHANCE',  key: 'glitchChance',    min: 0.05, max: 1.0,  step: 0.05  },
      { label: 'SCATTER', key: 'glitchScatter',   min: 0,    max: 0.15, step: 0.005 },
    ]));

    // BG MOD section (background modulation — flat FUSION_PARAMS keys)
    body.appendChild(_makeSection('BG MOD', 'bgEnabled', [
      { label: 'PULSE',  key: 'bgPulseAmount', min: 0,    max: 0.5,  step: 0.01  },
      { label: 'DECAY',  key: 'bgPulseDecay',  min: 0.01, max: 0.15, step: 0.005 },
      { label: 'LUMA',   key: 'bgLumaBoost',   min: 0,    max: 1.0,  step: 0.05  },
    ]));

    // BG FX section (pixel pipeline FX — nested FUSION_PARAMS.bgFx keys)
    const bgFxSection = _makeSection('BG FX', 'enabled', [
      { label: 'WARP',    key: 'warpAmount',    min: 0,   max: 20,  step: 1    },
      { label: 'W.BEAT',  key: 'warpBeatMult',  min: 1.0, max: 5.0, step: 0.1  },
      { label: 'STRIPS',  key: 'corruptStrips', min: 0,   max: 10,  step: 1    },
      { label: 'CORRUPT', key: 'corruptAmount', min: 0,   max: 30,  step: 1    },
      { label: 'CHROMA',  key: 'chromaOffset',  min: 0,   max: 12,  step: 1    },
      { label: 'FLASH',   key: 'flashAlpha',    min: 0,   max: 1.0, step: 0.05 },
      { label: 'LEVELS',  key: 'posterizeLevels', min: 2, max: 8,   step: 1    },
    ], 'bgFx');
    const bgFxNote = document.createElement('div');
    bgFxNote.className = 'fp-hint';
    bgFxNote.textContent = '(enable BG with [B] first)';
    bgFxSection.appendChild(bgFxNote);
    body.appendChild(bgFxSection);

    // AUTOMATION section
    const autoSection = document.createElement('div');
    autoSection.className = 'fp-section';

    const autoHeader = document.createElement('div');
    autoHeader.className = 'fp-section-header';
    const autoLabel = document.createElement('span');
    autoLabel.className = 'fp-section-label';
    autoLabel.textContent = 'AUTOMATION';
    autoHeader.appendChild(autoLabel);
    autoSection.appendChild(autoHeader);

    const autoControls = document.createElement('div');
    autoControls.style.cssText = 'display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding-top:3px;';

    // Drift toggle button
    const driftBtn = document.createElement('button');
    driftBtn.className = 'fp-toggle fp-toggle-off';
    driftBtn.id = 'fp-drift-toggle';
    driftBtn.textContent = 'DRIFT: OFF';
    driftBtn.addEventListener('click', function () {
      if (window.fusionAutomation) {
        window.fusionAutomation.driftEnabled = !window.fusionAutomation.driftEnabled;
        driftBtn.textContent = window.fusionAutomation.driftEnabled ? 'DRIFT: ON' : 'DRIFT: OFF';
        driftBtn.classList.toggle('fp-toggle-off', !window.fusionAutomation.driftEnabled);
      }
      driftBtn.blur();
    });
    autoControls.appendChild(driftBtn);

    // Morph N label + slider
    const morphLabel = document.createElement('span');
    morphLabel.style.cssText = 'color:var(--phosphor-dim,#00460f);font-size:10px;letter-spacing:0.5px;';
    morphLabel.textContent = 'MORPH EVERY';
    autoControls.appendChild(morphLabel);

    const morphGroup = document.createElement('div');
    morphGroup.className = 'fp-slider-group';
    morphGroup.style.cssText = 'min-width:120px;flex:1;';

    const morphTop = document.createElement('div');
    morphTop.className = 'fp-slider-top';
    const morphValEl = document.createElement('span');
    morphValEl.className = 'fp-slider-val';
    morphValEl.id = 'fp-morph-n-val';
    morphValEl.textContent = '16';
    morphTop.appendChild(morphValEl);

    const morphSuffix = document.createElement('span');
    morphSuffix.style.cssText = 'color:var(--phosphor-dim,#00460f);font-size:10px;';
    morphSuffix.textContent = 'BEATS';
    morphTop.appendChild(morphSuffix);
    morphGroup.appendChild(morphTop);

    const morphSlider = document.createElement('input');
    morphSlider.type  = 'range';
    morphSlider.id    = 'fp-morph-n';
    morphSlider.min   = '4';
    morphSlider.max   = '64';
    morphSlider.step  = '4';
    morphSlider.value = '16';
    morphSlider.addEventListener('input', function () {
      const v = parseInt(morphSlider.value);
      if (window.fusionAutomation) window.fusionAutomation.morphN = v;
      morphValEl.textContent = String(v);
    });
    morphSlider.addEventListener('change', function () { morphSlider.blur(); });
    morphGroup.appendChild(morphSlider);
    autoControls.appendChild(morphGroup);

    autoSection.appendChild(autoControls);
    body.appendChild(autoSection);

    // Hint line
    const hint = document.createElement('div');
    hint.className = 'fp-hint';
    hint.textContent = '[TAB] CLOSE  |  [,]/[.] SNAP SLOTS  |  SPD MIN < SPD MAX';
    body.appendChild(hint);

    panel.appendChild(body);
    document.body.appendChild(panel);
    panelEl = panel;
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  // Sync all panel controls to reflect the current live FUSION_PARAMS values.
  // Called by FusionAutomation after automated param writes and by toggleFusionPanel on open.
  window.syncFusionPanelState = function () {
    if (!panelEl) return;

    // Sync all range sliders that have data-fp-key attributes
    panelEl.querySelectorAll('input[type="range"][data-fp-key]').forEach(function (slider) {
      const key = slider.dataset.fpKey;
      const ns  = slider.dataset.fpNamespace;
      if (!key) return;
      const val = (ns && FUSION_PARAMS[ns]) ? FUSION_PARAMS[ns][key] : FUSION_PARAMS[key];
      if (val === undefined) return;
      slider.value = String(val);
      // Update adjacent value display span
      const group   = slider.closest('.fp-slider-group');
      const display = group ? group.querySelector('.fp-slider-val') : null;
      if (display) {
        const step = parseFloat(slider.step);
        if (step < 0.01) display.textContent = parseFloat(val).toFixed(3);
        else if (step < 0.1) display.textContent = parseFloat(val).toFixed(2);
        else if (step < 1)   display.textContent = parseFloat(val).toFixed(1);
        else                 display.textContent = String(Math.round(parseFloat(val)));
      }
    });

    // Sync toggle button states (handles all fp-toggle buttons via data-fp-key)
    _syncToggleStates();

    // Sync AUTOMATION section controls
    if (window.fusionAutomation) {
      const driftBtn = document.getElementById('fp-drift-toggle');
      if (driftBtn) {
        driftBtn.textContent = window.fusionAutomation.driftEnabled ? 'DRIFT: ON' : 'DRIFT: OFF';
        driftBtn.classList.toggle('fp-toggle-off', !window.fusionAutomation.driftEnabled);
      }
      const morphSlider = document.getElementById('fp-morph-n');
      if (morphSlider) {
        morphSlider.value = String(window.fusionAutomation.morphN);
        const morphValEl = document.getElementById('fp-morph-n-val');
        if (morphValEl) morphValEl.textContent = String(window.fusionAutomation.morphN);
      }
    }
  };

  window.toggleFusionPanel = function () {
    if (!panelEl) return;
    panelVisible = !panelVisible;
    panelEl.style.display = panelVisible ? '' : 'none';
    // Sync all panel controls when opening in case automation changed params externally
    if (panelVisible) window.syncFusionPanelState();
  };

  window.hideFusionPanel = function () {
    if (!panelEl) return;
    panelVisible = false;
    panelEl.style.display = 'none';
  };

  // ── Tab key interception ──────────────────────────────────────────────────
  // Intercepts Tab at the document level regardless of DOM focus state.
  // When the panel is visible, Tab closes it instead of cycling browser focus.
  // sketch.js handles Tab→toggleFusionPanel when Fusion is active; this listener
  // handles the case where a slider/button inside the panel has DOM focus.
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Tab' && panelVisible) {
      e.preventDefault(); // prevent browser focus cycling through panel elements
      // sketch.js p.keyPressed handles the actual toggle — don't call it here too
    }
  });

  // ── Init ──────────────────────────────────────────────────────────────────

  buildFusionPanel();

}());
