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

  let _audioContextResumed = false;
  let _lastFrameTime       = 0;
  const FRAME_INTERVAL     = V2_CONFIG.FRAME_BUDGET; // ms between frames

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

    const charset = [...set];

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
      f.family.includes('GlassTTY') && f.status === 'loaded'
    );
    if (!fontLoaded) {
      console.warn('[sketch] GlassTTY font not loaded — atlas will use fallback font');
    } else {
      console.log('[sketch] GlassTTY font loaded OK');
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

    // 4. Background layer — load image before startup screen so it is
    //    ready to resample immediately after the user makes a selection.
    bgLayer = new V2BackgroundLayer();
    await bgLayer.loadDefault();

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

    // 7. Resample background image to current grid dimensions, then init fusion mode
    bgLayer.resample(renderer.cols, renderer.rows);
    fusionMode = new V2FusionMode(renderer.cols, renderer.rows, V2_CONFIG, charset);

    // 8. Wire event handlers, update status, start render loop
    // Sync bg image div to initial V2_PARAMS.bgEnabled state
    const bgImageEl = document.getElementById('v2-bg-image');
    if (bgImageEl) bgImageEl.classList.toggle('visible', V2_PARAMS.bgEnabled);

    setupInputHandlers(canvas);
    updateStatus();
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

  // ── Main loop ──────────────────────────────────────────────────────────────

  function loop(timestamp) {
    // Gate to TARGET_FPS
    if (timestamp - _lastFrameTime < FRAME_INTERVAL) {
      requestAnimationFrame(loop);
      return;
    }
    _lastFrameTime = timestamp;

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

      bgLayer.tick();
      fusionMode.update(audio, renderer.cols, renderer.rows, bgLayer);
      renderer.upload(fusionMode.charIdx, fusionMode.bright16, fusionMode.cgaIdx);
    }

    // Always render (renderer draws black when no data)
    renderer.render(V2_PARAMS);

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

      switch (e.key.toUpperCase()) {
        case 'D':
          // Demo mode toggle
          if (audioManager.isDemo) {
            audioManager.stopAudio();
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
          updateStatus();
          break;
        }

        case 'S':
          // Toggle scanline pixel mode on/off
          V2_PARAMS.scanlineMode = V2_PARAMS.scanlineMode === 0 ? 1 : 0;
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

        case 'ESCAPE':
          if (document.fullscreenElement) {
            document.exitFullscreen().catch(() => {});
          }
          break;

        case '`':
          // Debug: show atlas
          if (renderer) renderer.debugAtlas();
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
      w = window.screen.width;
      h = window.screen.height;
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
    // Ensure bg layer is visible after loading a new file
    if (!V2_PARAMS.bgEnabled) {
      V2_PARAMS.bgEnabled = true;
      const bgEl = document.getElementById('v2-bg-image');
      if (bgEl) bgEl.classList.add('visible');
    }
    updateStatus();
  }

  // ── Status overlay ────────────────────────────────────────────────────────

  function updateStatus() {
    const el = document.getElementById('v2-status');
    if (!el) return;
    const src = audioManager ? audioManager.audioSource : 'idle';
    const ph  = audioManager ? V2_CONFIG.PHOSPHOR_ORDER[V2_PARAMS.phosphorIndex] : '–';
    const glInfo = renderer ? renderer.glVersion : '–';
    const scanName = V2_PARAMS.scanlineMode ? 'ON' : 'OFF';
    const bgState  = V2_PARAMS.bgEnabled ? 'ON' : 'OFF';
    el.textContent = `[${src.toUpperCase()}] phosphor:${ph} | scanline:${scanName} | bg:${bgState} | ${glInfo} | B=bg S=scanline P=phosphor L=load-bg F=full`;
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
  // Kiosk auto-start is now handled inside V2StartupScreen (8s kiosk timer
  // that auto-selects DEMO if no user input arrives after the menu appears).
  // The --autoplay-policy=no-user-gesture-required Chromium flag is still
  // required for the AudioContext to work without a gesture on Pi kiosk.

  document.addEventListener('DOMContentLoaded', async () => {
    await init();
  });

}());
