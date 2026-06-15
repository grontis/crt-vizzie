// v2/sketch.js — Main loop and module wiring
// Loads after all other v2 scripts.
//
// Boot sequence:
//   1. await document.fonts.ready
//   2. Build glyph atlas from charset
//   3. Init renderer, audio manager, background layer
//   4. await startupScreen.run() — blocks until user selects audio source
//   5. applyChoice() — wires audio source, inits fusion mode
//   6. Wire input handlers (keyboard, drag-and-drop, file picker)
//   7. Start requestAnimationFrame loop at TARGET_FPS
//
// Load order: last

'use strict';

(async function () {

  // ── State ──────────────────────────────────────────────────────────────────

  let renderer     = null;
  let audioManager = null;
  let fusionMode   = null;
  let bgLayer      = null;
  let bgFolder     = null;     // V2BgFolder — granted directory handle + entries
  let bgFx         = null;
  let bgFxPanel    = null;

  let _bgIndex          = -1;   // current entry index in bgFolder; -1 = off-playlist (manual file load)
  let _statusFlashTimer = null; // setTimeout handle for transient status flash

  let _audioContextResumed = false;
  let _lastFrameTime       = 0;
  const FRAME_INTERVAL     = V2_CONFIG.FRAME_BUDGET; // ms between frames

  // Perf overlay state
  let _perfOverlayVisible    = false;
  let _perfOverlayEl         = null;
  let _statusInfoEl          = null;
  let _statusHelpEl          = null;
  const _frameTimes          = new Float32Array(60);
  let _frameTimeIdx          = 0;

  // ── Charset ────────────────────────────────────────────────────────────────
  // Build the full charset array: space first (index 0), then all characters
  // used by fusion mode. The atlas index for each char is its position here.

  function buildCharset() {
    const set = new Set();
    set.add(' '); // index 0 = empty/space

    // ASCII printable
    for (let i = 32; i < 127; i++) set.add(String.fromCharCode(i));

    // Katakana range
    for (const ch of V2_CONFIG.KATAKANA) set.add(ch);

    // Glitch chars
    const glitchChars = '!@#$%^&*[]{}|\\/<>?~`+=-_░▒▓█▄▀■□▪▫◘◙◄►▲▼◆◇○●';
    for (const ch of glitchChars) set.add(ch);

    // Block / shade chars
    for (const ch of '▁▂▃▄▅▆▇█') set.add(ch);

    // Dot for spectrum bar chart
    set.add('·');

    // Full box-drawing Unicode block (U+2500–U+257F) — covers all border chars
    // used in ascii-art.js figures (─ │ ┌ ┐ └ ┘ ├ ┤ ┬ ┴ ┼ ═ ║ ╔ ╗ ╚ ╝ ╠ ╣ ╱ ╲ etc.)
    for (let i = 0x2500; i <= 0x257F; i++) set.add(String.fromCharCode(i));

    // Symbolic chars confirmed present in ascii-art.js figures but outside the box-drawing block
    for (const ch of '†‡⌐⌘⌬◈◉◊★☽☾✓✦✧⟲') set.add(ch);

    const charset = [...set];

    // Dev-mode validator: warn about any ascii-art chars missing from the just-built charset.
    // Runs once at startup; negligible cost.
    if (typeof AsciiArtLibrary !== 'undefined') {
      const charsetSet = new Set(charset);
      const missingChars = new Set();
      for (const fig of AsciiArtLibrary.figures) {
        for (const frames of fig.frames) {
          for (const row of frames) {
            for (const ch of row) {
              if (ch !== ' ' && !charsetSet.has(ch)) missingChars.add(ch);
            }
          }
        }
      }
      if (missingChars.size > 0) {
        console.warn('[sketch] Charset missing chars used in ascii-art figures:', [...missingChars].join(' '));
      }
    }

    // Validate charset fits within the atlas capacity
    const atlasCols = V2_CONFIG.ATLAS_COLS;
    const atlasRows = Math.ceil(charset.length / atlasCols);
    const atlasSlots = atlasCols * atlasRows;
    console.log(`[sketch] Charset: ${charset.length} chars, atlas: ${atlasCols}×${atlasRows} = ${atlasSlots} slots`);
    if (charset.length > atlasSlots) {
      console.error(`[sketch] Charset (${charset.length}) exceeds atlas capacity (${atlasSlots})! Some chars will be missing.`);
    }

    return charset;
  }

  // ── Init ───────────────────────────────────────────────────────────────────

  async function init() {
    // 1. Wait for custom font to load
    try {
      await document.fonts.load(`${V2_CONFIG.FONT_SIZE}px "${V2_CONFIG.FONT_FACE}"`);
    } catch (e) {
      console.warn('[sketch] Font load failed, falling back to monospace:', e);
    }
    await document.fonts.ready;

    // Check font actually loaded
    const fontLoaded = [...document.fonts].some(f =>
      f.family.includes(V2_CONFIG.FONT_FACE) && f.status === 'loaded'
    );
    if (!fontLoaded) {
      console.warn(`[sketch] ${V2_CONFIG.FONT_FACE} font not loaded — atlas will use fallback font`);
    } else {
      console.log(`[sketch] ${V2_CONFIG.FONT_FACE} font loaded OK`);
    }

    const canvas = document.getElementById('v2-canvas');
    canvas.width  = V2_CONFIG.CANVAS_WIDTH;
    canvas.height = V2_CONFIG.CANVAS_HEIGHT;

    // 2. Create renderer (throws if WebGL 2 unavailable)
    try {
      renderer = new V2Renderer(canvas, V2_CONFIG);
    } catch (e) {
      showError(e.message);
      return;
    }

    // Build glyph atlas — must happen before startupScreen.run() so the
    // atlas is ready the moment the render loop starts after selection.
    const charset = buildCharset();
    renderer.buildAtlas(charset);

    // 3. Create audio manager
    audioManager = new V2AudioManager();
    window.audioManager = audioManager; // exposed for hardware-bridge.js
    window.renderer     = renderer;     // exposed for console debug (renderer.debugAtlas())

    // 4. Background layer + bg folder.
    //    Try to silently restore a previously granted FileSystemDirectoryHandle
    //    from IndexedDB. On success we kick off loading the first entry but
    //    DO NOT await it — a large/slow first file (e.g. a 4K video) would
    //    otherwise block the startup screen for many seconds. The bg layer
    //    self-resamples once the async load completes.
    //    On first run (no stored handle) the user picks a folder via the
    //    M key from the main app.
    bgLayer  = new V2BackgroundLayer();
    bgFolder = new V2BgFolder();
    window.bgLayer  = bgLayer;   // exposed for console debugging
    window.bgFolder = bgFolder;
    bgLayer.onVideoEnded = () => cycleBgMedia(+1);
    if (await bgFolder.tryRestoreSilent()) {
      tryShowBgEntry(0, +1);
    }
    bgFx = new BgFxManager();
    bgFxPanel = new BgFxPanel();

    // 5. Startup screen — blocks here until user selects an audio source.
    //    The render loop has NOT started yet, so the WebGL canvas is invisible
    //    behind the overlay.

    // Early fullscreen listener — active only during startup screen.
    // Removed immediately after startupScreen.run() resolves so
    // setupInputHandlers() can register its own F handler without duplication.
    function earlyFullscreenHandler(e) {
      if (e.key !== 'f' && e.key !== 'F') return;
      if (!document.fullscreenElement) {
        document.documentElement.requestFullscreen().catch(() => {});
      } else {
        document.exitFullscreen().catch(() => {});
      }
    }
    document.addEventListener('keydown', earlyFullscreenHandler);

    const startupScreen = new V2StartupScreen(V2_CONFIG);
    const choice = await startupScreen.run();
    document.removeEventListener('keydown', earlyFullscreenHandler);

    // 6. Apply audio source choice (calls audioManager.resume() — valid because
    //    the startup screen interaction counts as a user gesture on non-kiosk paths)
    await applyChoice(choice);

    // 6b. Bg folder permission upgrade. If we have a handle on disk but its
    //     permission lapsed to 'prompt' (typical after a browser restart),
    //     piggyback on the startup-screen click as a user gesture to ask for
    //     it back. No-op when silent restore already succeeded.
    if (bgFolder.hasPendingHandle) {
      if (await bgFolder.requestPermissionAndScan()) {
        tryShowBgEntry(0, +1);
      }
    }

    // 7. Resample background image to current grid dimensions, then init fusion mode
    bgLayer.resample(renderer.cols, renderer.rows);
    fusionMode = new V2FusionMode(renderer.cols, renderer.rows, V2_CONFIG, charset);

    // 8. Wire event handlers, update status, start render loop
    // Sync bg image div to initial V2_PARAMS.bgEnabled state
    const bgImageEl = document.getElementById('v2-bg-image');
    if (bgImageEl) bgImageEl.classList.toggle('visible', V2_PARAMS.bgEnabled);

    // Cache overlay and status span elements
    _perfOverlayEl = document.getElementById('v2-perf-overlay');
    _statusInfoEl  = document.getElementById('v2-status-info');
    _statusHelpEl  = document.querySelector('.v2-status-help');

    setupInputHandlers(canvas);
    updateStatus();

    // Apply any pre-existing fullscreen state — user may have pressed F during
    // the startup screen, before the resize/fullscreenchange listeners existed.
    onResize();

    requestAnimationFrame(loop);

    console.log('[sketch] Init complete');
  }

  // ── Audio source selection ────────────────────────────────────────────────

  async function applyChoice(choice) {
    // Resume AudioContext — safe here because startup screen interaction is
    // a user gesture on non-kiosk paths; on kiosk, --autoplay-policy=no-user-gesture-required
    audioManager.resume();

    if (choice === 'demo') {
      audioManager.enableDemoMode();
    } else if (choice === 'live') {
      const result = await audioManager.enableLiveMode();
      if (result === 'error') {
        console.warn('[sketch] Live input failed — falling back to demo mode');
        audioManager.enableDemoMode();
      }
    } else if (choice === 'file') {
      // Open file picker; audio stays idle until user selects a file.
      // The render loop starts immediately — fusionMode runs in idle state.
      triggerFilePicker();
    }

    _audioContextResumed = true;
  }

  // ── Background folder cycling ─────────────────────────────────────────────

  /**
   * Try to load+show the bg-folder entry at startIdx, advancing by `delta`
   * on each failure until an entry loads or every entry has been tried.
   * Reads files via FileSystemFileHandle so the video element streams from
   * disk on demand — no full-file download/buffering.
   */
  async function tryShowBgEntry(startIdx, delta) {
    const len = bgFolder.count;
    if (len === 0) return false;

    let idx = ((startIdx % len) + len) % len;
    for (let attempts = 0; attempts < len; attempts++) {
      const filename = bgFolder.nameAt(idx);
      const file = await bgFolder.getFile(idx);

      if (file) {
        await bgLayer.loadFromFile(file);
        if (bgLayer.isLoaded) {
          _bgIndex = idx;
          bgLayer.resample(renderer.cols, renderer.rows);
          if (!V2_PARAMS.bgEnabled) {
            V2_PARAMS.bgEnabled = true;
            const bgEl = document.getElementById('v2-bg-image');
            if (bgEl) bgEl.classList.add('visible');
          }
          flashStatus(`bg: ${filename}`, false);
          return true;
        }
      }

      flashStatus(`[ERR] ${filename}`, true);
      idx = ((idx + delta) % len + len) % len;
    }

    flashStatus('[ERR] all bg entries failed', true);
    return false;
  }

  async function cycleBgMedia(delta) {
    if (bgFolder.count === 0) {
      flashStatus('[NO BG FOLDER — press M]', true);
      return;
    }
    const len = bgFolder.count;
    const startIdx = ((_bgIndex + delta) % len + len) % len;
    await tryShowBgEntry(startIdx, delta);
  }

  /**
   * Prompt the user to pick a bg-media folder via the FS Access API, persist
   * the granted handle, and load the first entry. Must be called from a user
   * gesture (key/click handler).
   */
  async function pickBgFolder() {
    if (!V2BgFolder.isSupported()) {
      flashStatus('[FS API NOT SUPPORTED]', true);
      return;
    }
    const ok = await bgFolder.pickFolder();
    if (!ok) return; // user cancelled
    if (bgFolder.count === 0) {
      flashStatus('[NO MEDIA IN FOLDER]', true);
      return;
    }
    await tryShowBgEntry(0, +1);
  }

  // ── Main loop ──────────────────────────────────────────────────────────────

  function loop(timestamp) {
    // Gate to TARGET_FPS
    if (timestamp - _lastFrameTime < FRAME_INTERVAL) {
      requestAnimationFrame(loop);
      return;
    }
    const _prevFrameTime = _lastFrameTime;
    _lastFrameTime = timestamp;
    if (_prevFrameTime > 0) {
      _frameTimes[_frameTimeIdx++ % 60] = timestamp - _prevFrameTime;
    }

    // Update audio
    audioManager.update();

    // If audio is active, update fusion mode and upload to GPU
    if (!audioManager.isIdle) {
      const audio = {
        spectrum:      audioManager.getSpectrum(),
        waveform:      audioManager.getWaveform(),
        bands:         audioManager.getBands(),
        beatActive:    audioManager.beatActive,
        beatIntensity: audioManager.beatIntensity,
      };

      // Modulate chroma beat add — decays between beats, spikes on beat.
      // _chromaBeatCurrent is initialized to 0 in V2_PARAMS (config.js).
      V2_PARAMS._chromaBeatCurrent =
        V2_PARAMS._chromaBeatCurrent * 0.85 +
        audioManager.beatIntensity * V2_PARAMS.chromaBeat * 0.15;

      // bgAscii audio-reactive brightness add — same envelope pattern as _chromaBeatCurrent.
      if (V2_PARAMS.bgAsciiEnabled) {
        const energy = audio.bands.bass * 0.5 + audio.bands.mid * 0.3 + audio.bands.treble * 0.2;
        V2_PARAMS._bgAsciiAudioAdd =
          V2_PARAMS._bgAsciiAudioAdd * 0.88 +
          energy * V2_PARAMS.bgAsciiAudioMult * 0.12;
      } else {
        V2_PARAMS._bgAsciiAudioAdd = 0.0;
      }

      bgLayer.tick();
      bgFx.update(audio);
      fusionMode.update(audio, renderer.cols, renderer.rows, bgLayer);
      renderer.upload(fusionMode.charIdx, fusionMode.bright16, fusionMode.cgaIdx);
    }

    // Always render (renderer draws black when no data)
    renderer.render(V2_PARAMS);

    // Update perf overlay if visible
    if (_perfOverlayVisible && _perfOverlayEl && _frameTimeIdx > 0) {
      const count = Math.min(_frameTimeIdx, 60);
      let sum = 0;
      for (let i = 0; i < count; i++) sum += _frameTimes[i];
      const avg = sum / count;
      const fps = Math.round(1000 / avg);
      _perfOverlayEl.textContent = `${avg.toFixed(1)}ms | ${fps}fps (target: ${V2_CONFIG.TARGET_FPS})`;
    }

    requestAnimationFrame(loop);
  }

  // ── Input handlers ─────────────────────────────────────────────────────────

  function setupInputHandlers(canvas) {
    // Resume AudioContext on first user gesture (required by browsers)
    const resumeAudio = () => {
      if (!_audioContextResumed) {
        _audioContextResumed = true;
        audioManager.resume();
      }
    };

    // Keyboard
    document.addEventListener('keydown', (e) => {
      resumeAudio();

      if (e.key === 'Tab') {
        // If the panel is open and focus is inside it, let Tab traverse panel controls normally
        if (bgFxPanel.isVisible && bgFxPanel.contains(document.activeElement)) {
          return;
        }
        e.preventDefault();
        const visible = bgFxPanel.toggle();
        if (visible) bgFxPanel.syncState();
        return;
      }

      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        if (bgFxPanel.isVisible && bgFxPanel.contains(document.activeElement)) return;
        e.preventDefault();
        cycleBgMedia(e.key === 'ArrowRight' ? 1 : -1);
        return;
      }

      switch (e.key.toUpperCase()) {
        case 'D':
          // Demo mode toggle
          if (audioManager.isDemo) {
            audioManager.stopAudio();
            bgFx.reset();
          } else {
            audioManager.enableDemoMode();
            // Demo mode may need audio graph if ctx just resumed
            if (_audioContextResumed) audioManager.resume();
          }
          updateStatus();
          break;

        case 'A':
          // Open file picker
          triggerFilePicker();
          break;

        case 'P':
          // Cycle phosphor preset
          V2_PARAMS.phosphorIndex =
            (V2_PARAMS.phosphorIndex + 1) % V2_CONFIG.PHOSPHOR_ORDER.length;
          updateStatus();
          break;

        case 'B': {
          // Toggle background image visibility
          V2_PARAMS.bgEnabled = !V2_PARAMS.bgEnabled;
          const bgEl = document.getElementById('v2-bg-image');
          if (bgEl) bgEl.classList.toggle('visible', V2_PARAMS.bgEnabled);
          if (!V2_PARAMS.bgEnabled) bgFx.reset();
          updateStatus();
          break;
        }

        case 'S':
          // Cycle scanline mode: 0=off → 1=pixel → 2=cell-gap → 3=smooth → 0
          V2_PARAMS.scanlineMode = (V2_PARAMS.scanlineMode + 1) % 4;
          updateStatus();
          break;

        case 'F':
          // Toggle fullscreen
          if (!document.fullscreenElement) {
            document.documentElement.requestFullscreen().catch(err =>
              console.warn('[sketch] Fullscreen request failed:', err)
            );
          } else {
            document.exitFullscreen().catch(() => {});
          }
          break;

        case 'L':
          // Load background image or video from file
          triggerBgFilePicker();
          break;

        case 'M':
          // Pick / re-pick the bg-media folder via FS Access API
          pickBgFolder();
          break;

        case 'ESCAPE':
          if (bgFxPanel.isVisible) {
            bgFxPanel.hide();
            break;
          }
          if (document.fullscreenElement) {
            document.exitFullscreen().catch(() => {});
          }
          break;

        case 'X':
          // Toggle audio-reactive CSS filter FX on background layer
          V2_PARAMS.bgFxEnabled = !V2_PARAMS.bgFxEnabled;
          if (!V2_PARAMS.bgFxEnabled) bgFx.reset();
          updateStatus();
          break;

        case 'V':
          // Toggle bgAscii layer (ASCII art rendering of background luma)
          V2_PARAMS.bgAsciiEnabled = !V2_PARAMS.bgAsciiEnabled;
          if (!V2_PARAMS.bgAsciiEnabled) V2_PARAMS._bgAsciiAudioAdd = 0.0;
          updateStatus();
          break;

        case '`':
          // Debug: show atlas
          if (renderer) renderer.debugAtlas();
          break;

        case '~':
          // Toggle perf overlay
          _perfOverlayVisible = !_perfOverlayVisible;
          if (_perfOverlayEl) {
            _perfOverlayEl.style.display = _perfOverlayVisible ? 'block' : 'none';
          }
          break;
      }
    });

    // Resize / fullscreen change
    window.addEventListener('resize', onResize);
    document.addEventListener('fullscreenchange', onResize);

    // Drag-and-drop audio file
    canvas.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    });

    canvas.addEventListener('drop', async (e) => {
      e.preventDefault();
      resumeAudio();
      const file = e.dataTransfer.files && e.dataTransfer.files[0];
      if (!file) return;
      await loadAudioFile(file);
    });

    // Click on canvas to resume audio (kiosk-friendly)
    canvas.addEventListener('click', () => {
      resumeAudio();
    });
  }

  function onResize() {
    if (!renderer) return;

    let w, h;
    if (document.fullscreenElement) {
      w = window.innerWidth;
      h = window.innerHeight;
    } else {
      w = V2_CONFIG.CANVAS_WIDTH;
      h = V2_CONFIG.CANVAS_HEIGHT;
    }

    renderer.resize(w, h);
    if (fusionMode) {
      fusionMode.reset(renderer.cols, renderer.rows);
    }
    if (bgLayer) {
      bgLayer.resample(renderer.cols, renderer.rows);
    }

    console.log(`[sketch] Resize: ${w}×${h}, grid ${renderer.cols}×${renderer.rows}`);
  }

  function triggerFilePicker() {
    const input = document.createElement('input');
    input.type   = 'file';
    input.accept = 'audio/*';
    input.onchange = async () => {
      if (input.files && input.files[0]) {
        audioManager.resume();
        await loadAudioFile(input.files[0]);
      }
    };
    input.click();
  }

  async function loadAudioFile(file) {
    console.log('[sketch] Loading audio file:', file.name);
    const result = await audioManager.loadAudioFile(file);
    if (result === 'live') {
      console.log('[sketch] Audio file active');
    } else {
      console.warn('[sketch] Audio file load failed');
    }
    updateStatus();
  }

  function triggerBgFilePicker() {
    const input = document.createElement('input');
    input.type   = 'file';
    input.accept = 'image/*,video/*';
    input.onchange = async () => {
      if (input.files && input.files[0]) {
        await loadBgFile(input.files[0]);
      }
    };
    input.click();
  }

  async function loadBgFile(file) {
    console.log('[sketch] Loading background file:', file.name);
    await bgLayer.loadFromFile(file);
    bgLayer.resample(renderer.cols, renderer.rows);
    _bgIndex = -1; // manually loaded file is off-playlist
    // Ensure bg layer is visible after loading a new file
    if (!V2_PARAMS.bgEnabled) {
      V2_PARAMS.bgEnabled = true;
      const bgEl = document.getElementById('v2-bg-image');
      if (bgEl) bgEl.classList.add('visible');
    }
    updateStatus();
  }

  // ── Status overlay ────────────────────────────────────────────────────────

  const SCANLINE_NAMES = ['OFF', 'PIXEL', 'CELL-GAP', 'SMOOTH'];

  function flashStatus(text, isError) {
    if (_statusFlashTimer !== null) {
      clearTimeout(_statusFlashTimer);
      _statusFlashTimer = null;
    }
    if (!_statusInfoEl) return;
    _statusInfoEl.textContent = text;
    _statusInfoEl.style.color = isError ? '#ff4444' : '';
    _statusFlashTimer = setTimeout(() => {
      _statusFlashTimer = null;
      if (_statusInfoEl) _statusInfoEl.style.color = '';
      updateStatus();
    }, 3000);
  }

  function updateStatus() {
    if (!_statusInfoEl && !_statusHelpEl) return;
    const src = audioManager ? audioManager.audioSource : 'idle';
    const ph  = audioManager ? V2_CONFIG.PHOSPHOR_ORDER[V2_PARAMS.phosphorIndex] : '–';
    const glInfo    = renderer ? renderer.glVersion : '–';
    const scanName  = SCANLINE_NAMES[V2_PARAMS.scanlineMode] ?? 'OFF';
    const bgState    = V2_PARAMS.bgEnabled ? 'ON' : 'OFF';
    const bgFxState  = V2_PARAMS.bgFxEnabled ? 'ON' : 'OFF';
    const asciiState = V2_PARAMS.bgAsciiEnabled ? 'ON' : 'OFF';
    if (_statusInfoEl) {
      _statusInfoEl.textContent = `[${src.toUpperCase()}] phosphor:${ph} | scanline:${scanName} | bg:${bgState} | bgfx:${bgFxState} | ascii:${asciiState} | ${glInfo}`;
    }
    if (_statusHelpEl) {
      _statusHelpEl.textContent = ' | B=bg X=bgfx V=ascii-layer S=scanline P=phosphor L=load-bg M=bg-folder ←/→=cycle-bg F=full';
    }
  }

  // ── Error display ─────────────────────────────────────────────────────────

  function showError(msg) {
    const div = document.createElement('div');
    div.style.cssText = [
      'position:fixed', 'top:50%', 'left:50%', 'transform:translate(-50%,-50%)',
      'background:#1a0000', 'color:#ff4444', 'font-family:monospace',
      'font-size:16px', 'padding:24px 32px', 'border:2px solid #ff4444',
      'white-space:pre-wrap', 'max-width:80vw', 'z-index:9999',
    ].join(';');
    div.textContent = 'ERROR: ' + msg;
    document.body.appendChild(div);
    console.error('[sketch] Fatal error:', msg);
  }

  // ── Boot ──────────────────────────────────────────────────────────────────
  // On Pi kiosk deployments, run Chromium with
  // --autoplay-policy=no-user-gesture-required so the AudioContext can resume
  // without a click. The startup screen still requires a key/click selection.

  document.addEventListener('DOMContentLoaded', async () => {
    await init();
  });

}());
