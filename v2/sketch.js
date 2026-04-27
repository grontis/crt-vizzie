// v2/sketch.js — Main loop and module wiring
// Loads after all other v2 scripts.
//
// Boot sequence:
//   1. await document.fonts.ready
//   2. Build glyph atlas from charset
//   3. Init renderer, audio, fusion mode
//   4. Wire input handlers (keyboard, drag-and-drop, file picker)
//   5. Start requestAnimationFrame loop at TARGET_FPS
//
// Load order: last

'use strict';

(async function () {

  // ── State ──────────────────────────────────────────────────────────────────

  let renderer    = null;
  let audioManager = null;
  let fusionMode   = null;

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
    // Wait for custom font to load
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

    // Create renderer (throws if WebGL 2 unavailable)
    try {
      renderer = new V2Renderer(canvas, V2_CONFIG);
    } catch (e) {
      showError(e.message);
      return;
    }

    // Build glyph atlas
    const charset = buildCharset();
    renderer.buildAtlas(charset);

    // Create audio manager
    audioManager = new V2AudioManager();
    window.audioManager = audioManager; // exposed for hardware-bridge.js
    window.renderer     = renderer;     // exposed for console debug (renderer.debugAtlas())

    // Create fusion mode
    fusionMode = new V2FusionMode(renderer.cols, renderer.rows, V2_CONFIG, charset);

    // Wire event handlers
    setupInputHandlers(canvas);

    // Update status display
    updateStatus();

    // Start the render loop
    requestAnimationFrame(loop);

    console.log('[sketch] Init complete — press D for demo mode, A to load audio file');
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

      fusionMode.update(audio, renderer.cols, renderer.rows);
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

  // ── Status overlay ────────────────────────────────────────────────────────

  function updateStatus() {
    const el = document.getElementById('v2-status');
    if (!el) return;
    const src = audioManager ? audioManager.audioSource : 'idle';
    const ph  = audioManager ? V2_CONFIG.PHOSPHOR_ORDER[V2_PARAMS.phosphorIndex] : '–';
    const glInfo = renderer ? renderer.glVersion : '–';
    el.textContent = `[${src.toUpperCase()}] phosphor:${ph} | ${glInfo} | D=demo A=file P=phosphor F=fullscreen`;
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

  // ── Auto-start for unattended kiosk ───────────────────────────────────────
  // If no user gesture arrives within 3 seconds, start demo mode automatically.
  // Chromium kiosk flag --autoplay-policy=no-user-gesture-required is also
  // needed for the AudioContext to work without a gesture.

  function scheduleAutoDemo() {
    setTimeout(() => {
      if (!audioManager || audioManager.isIdle) {
        console.log('[sketch] Auto-starting demo mode (kiosk)');
        // Use the audio context resume without gesture guard
        // (kiosk.sh sets --autoplay-policy=no-user-gesture-required)
        if (audioManager) {
          try {
            audioManager.resume();
          } catch (_) {}
          audioManager.enableDemoMode();
          updateStatus();
        }
      }
    }, 3000);
  }

  // ── Boot ──────────────────────────────────────────────────────────────────

  document.addEventListener('DOMContentLoaded', async () => {
    await init();
    scheduleAutoDemo();
  });

}());
