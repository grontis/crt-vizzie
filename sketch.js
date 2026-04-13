// sketch.js — p5 instance mode entry point
// Owns grid, state, render loop, keyboard handling.
// Must be loaded LAST — all other scripts must be loaded before this.

// ── Global state ──
let currentPhosphor = CONFIG.PHOSPHOR_ORDER[0];

// ── Global helpers (assigned in setup, exposed for HTML buttons and mode files) ──
window.setCell = null;
window.setString = null;
window.switchModeByIndex = null;
window.cyclePhosphor = null;
window.toggleBackground = null;
window.toggleScanlines = null;
window.toggleDemo = null;
window.toggleUI = null;
window.toggleFullscreen = null;

// ── p5 Sketch ──
const sketch = function(p) {

  // ── State ──
  let grid;
  let cols, rows;
  let cellW, cellH;

  let audioManager;
  let backgroundLayer;

  const modes = [];
  let currentModeIndex = 0;
  let activeMode;

  let phosphorIndex = 0;
  let showScanlines = true;
  let showUI = true;

  // Idle screen typewriter state
  let idlePhase         = 'typing'; // 'typing' | 'gap' | 'done'
  let idleLineIndex     = 0;
  let idleCharIndex     = 0;
  let idleLastTime      = 0;
  let idleRendered      = [];       // fully-typed lines so far
  let idleCursorVisible = true;
  let idleCursorTimer   = 0;

  // ── Internal helpers ──────────────────────────────────────────────────────

  function _setCell(col, row, char, brightness) {
    if (col < 0 || col >= cols || row < 0 || row >= rows) return;
    grid[row][col] = { char, brightness };
  }

  function _setString(col, row, str, brightness) {
    for (let i = 0; i < str.length; i++) _setCell(col + i, row, str[i], brightness);
  }

  function clearGrid() {
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        grid[r][c].char = ' ';
        grid[r][c].brightness = 0;
      }
    }
  }

  function initGrid() {
    p.textFont(CONFIG.FONT_FACE);
    p.textSize(CONFIG.FONT_SIZE);
    cellW = p.textWidth('M');
    cellH = CONFIG.FONT_SIZE * 1.2;
    cols  = Math.max(1, Math.floor(p.width  / cellW));
    rows  = Math.max(1, Math.floor(p.height / cellH));
    grid  = Array.from({ length: rows }, () =>
      Array.from({ length: cols }, () => ({ char: ' ', brightness: 0 }))
    );
    if (activeMode && typeof activeMode.reset === 'function') activeMode.reset();
    window._glitchActive    = false;
    window._glitchColorGrid = null;
  }

  function getPhosphorColor(brightness) {
    const ph = CONFIG.PHOSPHORS[currentPhosphor];
    if (brightness > 0.66) return ph.bright;
    if (brightness > 0.33) return ph.mid;
    return ph.dim;
  }

  function renderGrid() {
    const isGlitch = window._glitchActive && currentModeIndex === 5;
    const cgaColors = CONFIG.CGA_COLORS;

    p.textFont(CONFIG.FONT_FACE);
    p.textSize(CONFIG.FONT_SIZE);
    p.noStroke();
    p.textAlign(p.LEFT, p.TOP);

    for (let r = 0; r < rows; r++) {
      const py = r * cellH;
      for (let c = 0; c < cols; c++) {
        const cell = grid[r][c];
        if (!cell || cell.char === ' ' || cell.brightness <= 0) continue;
        const px = c * cellW;
        if (isGlitch && window._glitchColorGrid && window._glitchColorGrid[r]) {
          p.fill(cgaColors[(window._glitchColorGrid[r][c] || 0) % cgaColors.length]);
        } else {
          p.fill(getPhosphorColor(cell.brightness));
        }
        p.text(cell.char, px, py);
      }
    }
    window._glitchActive = false;
  }

  function drawScanlines() {
    p.noStroke();
    p.fill(0, Math.floor(CONFIG.SCANLINE_ALPHA * 255));
    for (let y = 0; y < p.height; y += CONFIG.SCANLINE_SPACING * 2) {
      p.rect(0, y, p.width, CONFIG.SCANLINE_SPACING);
    }
  }

  // ── Idle screen ───────────────────────────────────────────────────────────

  function resetIdleAnimation() {
    idlePhase     = 'typing';
    idleLineIndex = 0;
    idleCharIndex = 0;
    idleLastTime  = performance.now();
    idleRendered  = [];
    idleCursorVisible = true;
    idleCursorTimer   = 0;
  }

  function renderIdleScreen() {
    const lines    = CONFIG.IDLE_LINES;
    const startCol = 2;
    const startRow = 2;
    const now      = performance.now();

    // ── Typewriter advance ──
    if (idlePhase === 'typing') {
      const line = lines[idleLineIndex];
      if (!line || line.length === 0) {
        // blank line — treat as gap then advance
        idlePhase    = 'gap';
        idleLastTime = now;
      } else if (now - idleLastTime >= CONFIG.IDLE_CHAR_DELAY) {
        idleCharIndex++;
        idleLastTime = now;
        if (idleCharIndex >= line.length) {
          // line complete
          idleRendered[idleLineIndex] = line;
          idleCharIndex = 0;
          idlePhase     = 'gap';
          idleLastTime  = now;
        }
      }
    } else if (idlePhase === 'gap') {
      if (now - idleLastTime >= CONFIG.IDLE_LINE_GAP) {
        idleLineIndex++;
        idleCharIndex = 0;
        idlePhase = idleLineIndex < lines.length ? 'typing' : 'done';
        idleLastTime = now;
      }
    }

    // ── Draw committed lines ──
    for (let i = 0; i < lines.length; i++) {
      const committed = idleRendered[i];
      if (committed) {
        const bright = (i === 0) ? 1.0 : committed.startsWith('>') ? 0.9 : 0.65;
        _setString(startCol, startRow + i, committed, bright);
      }
    }

    // ── Draw in-progress line ──
    if (idlePhase === 'typing' && idleLineIndex < lines.length) {
      const partial = lines[idleLineIndex].slice(0, idleCharIndex);
      if (partial.length > 0) {
        const bright = (idleLineIndex === 0) ? 1.0 : lines[idleLineIndex].startsWith('>') ? 0.9 : 0.65;
        _setString(startCol, startRow + idleLineIndex, partial, bright);
      }
    }

    // ── Blinking cursor ──
    idleCursorTimer++;
    if (idleCursorTimer % 30 === 0) idleCursorVisible = !idleCursorVisible;

    const cursorRow = idlePhase === 'done'
      ? startRow + lines.length
      : startRow + idleLineIndex;
    const cursorCol = idlePhase === 'done' || idlePhase === 'gap'
      ? startCol
      : startCol + idleCharIndex;

    if (idleCursorVisible) {
      _setCell(cursorCol, cursorRow, '█', 1.0);
    }
  }

  // ── Status bar ────────────────────────────────────────────────────────────

  function updateStatusBar() {
    const freqEl   = document.getElementById('status-freq');
    const bpmEl    = document.getElementById('status-bpm');
    const modeEl   = document.getElementById('status-mode');
    const phoEl    = document.getElementById('status-pho');
    const srcEl    = document.getElementById('status-src');
    const cursorEl = document.getElementById('status-cursor');
    if (!freqEl) return;

    const src = audioManager ? audioManager.audioSource : 'idle';
    const isIdle = (src === 'idle');

    if (!isIdle && audioManager) {
      freqEl.textContent = 'FREQ: ' + audioManager.getDominantFreq() + 'Hz';
      const bpm = audioManager.getBPM();
      bpmEl.textContent = 'BPM: ' + (bpm !== null ? '~' + bpm : '---');
    } else {
      freqEl.textContent = 'FREQ: ---';
      bpmEl.textContent  = 'BPM: ---';
    }

    const modeNames = ['MATRIX', 'SPECTRUM', 'WAVEFORM', 'VU METER', 'MORPH', 'GLITCH', 'TUNNEL', 'LIFE', 'LISSAJOUS'];
    modeEl.textContent = 'MODE: ' + (isIdle ? 'IDLE' : (modeNames[currentModeIndex] || 'UNKNOWN'));

    phoEl.textContent = 'PHO: ' + currentPhosphor.toUpperCase();

    srcEl.textContent = src === 'demo' ? '[DEMO]' :
                        src === 'file' ? '[AUDIO FILE]' :
                        '[READY]';

    // DEMO button lit = demo mode active
    const demoBtn = document.getElementById('demo-btn');
    if (demoBtn) demoBtn.classList.toggle('active', src === 'demo');

    // Blinking cursor in status bar only when idle
    cursorEl.style.display = isIdle ? '' : 'none';

    // Sync phosphor CSS variables
    const ph = CONFIG.PHOSPHORS[currentPhosphor];
    document.documentElement.style.setProperty('--phosphor-dim',    ph.dim);
    document.documentElement.style.setProperty('--phosphor-mid',    ph.mid);
    document.documentElement.style.setProperty('--phosphor-bright', ph.bright);
  }

  function updateModeButtons() {
    document.querySelectorAll('#mode-buttons .ctrl-btn').forEach((btn, idx) => {
      btn.classList.toggle('active', idx === currentModeIndex);
    });
  }

  // ── Mode control ──────────────────────────────────────────────────────────

  function activateMode(index) {
    currentModeIndex = index;
    activeMode = modes[index];
    if (activeMode && typeof activeMode.reset === 'function') activeMode.reset();
    if (index !== 5) window._glitchActive = false;
    updateModeButtons();
  }

  // ── Audio file loading ────────────────────────────────────────────────────

  function _loadAudioFileFromObject(file) {
    // Resume AudioContext synchronously while still inside the user gesture window.
    // SoundFile.loop() will fail silently if context is suspended when called later.
    if (typeof getAudioContext === 'function') {
      const ctx = getAudioContext();
      if (ctx && ctx.state === 'suspended') ctx.resume().catch(() => {});
    }
    const srcEl = document.getElementById('status-src');
    if (srcEl) srcEl.textContent = '[LOADING...]';
    audioManager.loadAudioFile(file).then((result) => {
      if (result === 'live') activateMode(currentModeIndex);
      updateStatusBar();
    });
  }

  // ── p5 Lifecycle ──────────────────────────────────────────────────────────

  p.preload = function() {};

  p.setup = async function() {
    const container = document.getElementById('canvas-container');
    const canvas = p.createCanvas(container.offsetWidth, container.offsetHeight);
    canvas.parent('canvas-container');

    p.frameRate(60);
    p.textAlign(p.LEFT, p.TOP);
    p.noStroke();

    await document.fonts.ready;

    initGrid();

    audioManager    = new AudioManager();   // starts in 'idle'
    backgroundLayer = new BackgroundLayer();
    resetIdleAnimation();

    modes.push(new MatrixMode(CONFIG));     // 0
    modes.push(new SpectrumMode(CONFIG));   // 1
    modes.push(new WaveformMode(CONFIG));   // 2
    modes.push(new VUMode(CONFIG));         // 3
    modes.push(new MorphMode(CONFIG));      // 4
    modes.push(new GlitchMode(CONFIG));     // 5
    modes.push(new TunnelMode(CONFIG));     // 6
    modes.push(new LifeMode(CONFIG));       // 7
    modes.push(new LissajousMode(CONFIG));  // 8

    activeMode = modes[0];

    // ── Window-scoped API ──

    window.setCell   = _setCell;
    window.setString = _setString;

    window.switchModeByIndex = function(idx) {
      if (audioManager.isIdle) return;
      if (idx >= 0 && idx < modes.length) activateMode(idx);
    };

    window.cyclePhosphor = function() {
      phosphorIndex  = (phosphorIndex + 1) % CONFIG.PHOSPHOR_ORDER.length;
      currentPhosphor = CONFIG.PHOSPHOR_ORDER[phosphorIndex];
      updateStatusBar();
    };

    window.toggleBackground = function() { backgroundLayer.toggle(); };

    window.loadBackgroundFile = function(input) {
      const file = input.files[0];
      if (file) backgroundLayer.load(file);
      input.value = '';
    };

    window.handleAudioFileInput = function(input) {
      const file = input.files[0];
      if (file) _loadAudioFileFromObject(file);
      input.value = '';
    };

    window.toggleScanlines = function() { showScanlines = !showScanlines; };

    window.toggleDemo = function() {
      if (audioManager.isDemo) {
        audioManager.stopAudio();   // demo → idle
        resetIdleAnimation();
      } else {
        audioManager.enableDemoMode();
        activateMode(currentModeIndex);
      }
      updateStatusBar();
    };

    window.toggleUI = function() {
      showUI = !showUI;
      document.body.classList.toggle('ui-hidden', !showUI);
      setTimeout(() => {
        const c2 = document.getElementById('canvas-container');
        p.resizeCanvas(c2.offsetWidth, c2.offsetHeight);
        initGrid();
      }, 50);
    };

    window.toggleFullscreen = function() {
      if (document.fullscreenElement) document.exitFullscreen();
      else document.documentElement.requestFullscreen().catch(() => {});
    };

    // Fullscreen → resize canvas
    document.addEventListener('fullscreenchange', () => {
      setTimeout(() => {
        const c2 = document.getElementById('canvas-container');
        p.resizeCanvas(c2.offsetWidth, c2.offsetHeight);
        initGrid();
      }, 100);
    });

    // Drag-and-drop: audio files → AudioManager; images/video → BackgroundLayer
    document.addEventListener('dragover', e => e.preventDefault());
    document.addEventListener('drop', e => {
      e.preventDefault();
      const file = e.dataTransfer.files[0];
      if (!file) return;
      if (file.type.startsWith('audio/')) {
        _loadAudioFileFromObject(file);
      } else {
        backgroundLayer.load(file);
      }
    });

    updateStatusBar();
    updateModeButtons();
  };

  // ── Draw loop ─────────────────────────────────────────────────────────────

  p.draw = function() {
    if (!grid) return;

    p.clear();
    clearGrid();

    if (audioManager && audioManager.isIdle) {
      // ── Idle / terminal screen ──
      renderIdleScreen();
      p.background(0, 255);   // solid black — no background bleed in idle
      renderGrid();
      if (showScanlines) drawScanlines();
      updateStatusBar();
      return;
    }

    // ── Active visualizer loop ──
    audioManager.update();
    backgroundLayer.update(cols, rows);
    activeMode.update(grid, cols, rows, audioManager, backgroundLayer);
    p.background(0, CONFIG.CANVAS_BG_ALPHA);
    renderGrid();
    if (showScanlines) drawScanlines();
    updateStatusBar();
  };

  p.keyPressed = function() {
    if (p.keyCode === 9) return false; // handle Tab below

    const key     = p.key;
    const keyCode = p.keyCode;

    // Mode switching 1–9 (only when active)
    if (key >= '1' && key <= '9') {
      window.switchModeByIndex(parseInt(key) - 1);
      return false;
    }

    switch (key.toUpperCase()) {
      case 'A': document.getElementById('audio-file-input').click(); break;
      case 'D': window.toggleDemo();       break;
      case 'P': window.cyclePhosphor();    break;
      case 'L': document.getElementById('bg-file-input').click(); break;
      case 'B': window.toggleBackground(); break;
      case 'S': window.toggleScanlines();  break;
      case 'F': window.toggleFullscreen(); break;
      case 'U': window.toggleUI();         break;
      case '[': backgroundLayer.adjustOpacity(-CONFIG.BG_OPACITY_STEP); break;
      case ']': backgroundLayer.adjustOpacity( CONFIG.BG_OPACITY_STEP); break;
    }

    // Tab cycles modes (only when active)
    if (keyCode === 9) {
      if (!audioManager.isIdle) activateMode((currentModeIndex + 1) % modes.length);
      return false;
    }
  };

  p.windowResized = function() {
    const container = document.getElementById('canvas-container');
    p.resizeCanvas(container.offsetWidth, container.offsetHeight);
    initGrid();
  };
};

// ── Launch ──
new p5(sketch);
