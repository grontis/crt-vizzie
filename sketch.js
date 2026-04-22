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
  let backgroundFX;
  let fusionAutomation;

  const modes = [];
  let currentModeIndex = 0;
  let activeMode;

  let phosphorIndex = 0;
  let showScanlines = true;
  let showUI = true;

  // Idle screen typewriter state
  let idlePhase         = 'boot';  // 'boot' | 'glitch' | 'typing' | 'gap' | 'done'
  let idlePhaseStart    = 0;       // timestamp when current phase began
  let idleLineIndex     = 0;
  let idleCharIndex     = 0;
  let idleLastTime      = 0;
  let idleRendered      = [];      // fully-typed lines so far
  let idleCursorVisible = true;
  let idleCursorTimer   = 0;

  // Audio library browser state
  let audioFiles        = [];       // filenames fetched from /audio/
  let audioFileIdx      = 0;        // currently highlighted file index
  let audioFilesLoading = false;    // true while fetch is in-flight

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
    cellW = p.textWidth('M') * CONFIG.CHAR_SPACING;
    cellH = CONFIG.FONT_SIZE * CONFIG.LINE_SPACING;
    cols  = Math.max(1, Math.floor(p.width  / cellW));
    rows  = Math.max(1, Math.floor(p.height / cellH));
    grid  = Array.from({ length: rows }, () =>
      Array.from({ length: cols }, () => ({ char: ' ', brightness: 0 }))
    );
    if (activeMode && typeof activeMode.reset === 'function') activeMode.reset();
    window._glitchActive    = false;
    window._glitchColorGrid = null;
    window._glitchSizeGrid  = null;
  }

  function getPhosphorColor(brightness) {
    const ph = CONFIG.PHOSPHORS[currentPhosphor];
    if (brightness > 0.66) return ph.bright;
    if (brightness > 0.33) return ph.mid;
    return ph.dim;
  }

  function renderGrid() {
    const isGlitch  = window._glitchActive && currentModeIndex === 0;
    const cgaColors = CONFIG.CGA_COLORS;

    // Audio state for reactive rendering — zero when idle
    const isActive      = audioManager && !audioManager.isIdle;
    const beatIntensity = isActive ? audioManager.beatIntensity : 0;
    const bassEnergy    = isActive ? audioManager.getBands().bass : 0;
    const trebleEnergy  = isActive ? audioManager.getBands().treble : 0;

    // Chromatic aberration: always-on BASE + BEAT * intensity
    const chromaOffset = Math.round(
      CONFIG.CHROMA_BASE + CONFIG.CHROMA_BEAT * Math.min(1, beatIntensity + bassEnergy * 0.4)
    );
    const jitterActive = isActive && (beatIntensity > 0.05 || trebleEnergy > 0.3);

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

        // Per-character jitter — probabilistic, magnitude tracks beat + treble
        let jx = 0, jy = 0;
        if (jitterActive && Math.random() < CONFIG.CHAR_JITTER_CHANCE) {
          const jMag = CONFIG.CHAR_JITTER_PX * Math.min(1, beatIntensity + trebleEnergy * 0.5);
          jx = (Math.random() - 0.5) * 2 * jMag;
          jy = (Math.random() - 0.5) *     jMag;
        }

        if (isGlitch && window._glitchColorGrid && window._glitchColorGrid[r]) {
          // Glitch mode: CGA color, no chroma (it already has its own chaos)
          p.fill(cgaColors[(window._glitchColorGrid[r][c] || 0) % cgaColors.length]);

          const sGrid    = window._glitchSizeGrid;
          const sizeMult = (sGrid && sGrid[r]) ? (sGrid[r][c] || 1.0) : 1.0;

          if (sizeMult > 1.02) {
            // Draw oversized — shift up+left so the char grows out from cell center
            const fs = Math.round(CONFIG.FONT_SIZE * sizeMult);
            const ox = -(sizeMult - 1) * cellW * 0.5;
            const oy = -(sizeMult - 1) * cellH * 0.5;
            p.textSize(fs);
            p.text(cell.char, px + ox + jx,     py + oy + jy);
            p.text(cell.char, px + ox + 1 + jx, py + oy + jy);
            p.text(cell.char, px + ox + jx,     py + oy + 1 + jy);
            p.text(cell.char, px + ox + 1 + jx, py + oy + 1 + jy);
            p.textSize(CONFIG.FONT_SIZE);
          } else {
            // Standard 2×2 pixel bold
            p.text(cell.char, px + jx,     py + jy);
            p.text(cell.char, px + jx + 1, py + jy);
            p.text(cell.char, px + jx,     py + jy + 1);
            p.text(cell.char, px + jx + 1, py + jy + 1);
          }
        } else {
          const mainColor = getPhosphorColor(cell.brightness);

          // Chromatic aberration: warm fringe left, cool fringe right
          if (chromaOffset > 0) {
            p.fill(255, 80, 40, 70);   // red-orange left
            p.text(cell.char, px - chromaOffset + jx, py + jy);
            p.fill(40, 120, 255, 70);  // blue right
            p.text(cell.char, px + chromaOffset + jx, py + jy);
          }

          // 2×2 pixel bold — same technique old terminal emulators used for bitmap fonts
          p.fill(mainColor);
          p.text(cell.char, px + jx,     py + jy);
          p.text(cell.char, px + jx + 1, py + jy);
          p.text(cell.char, px + jx,     py + jy + 1);
          p.text(cell.char, px + jx + 1, py + jy + 1);
        }
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
    idlePhase      = 'boot';
    idlePhaseStart = performance.now();
    idleLineIndex  = 0;
    idleCharIndex  = 0;
    idleLastTime   = 0;
    idleRendered   = [];
    idleCursorVisible = true;
    idleCursorTimer   = 0;
  }

  function renderIdleScreen() {
    const lines    = CONFIG.IDLE_LINES;
    const startCol = 2;
    const startRow = 2;
    const now      = performance.now();
    const elapsed  = now - idlePhaseStart;

    // ── Blinking cursor (shared across phases) ──
    idleCursorTimer++;
    if (idleCursorTimer % 30 === 0) idleCursorVisible = !idleCursorVisible;

    // ── BOOT phase — blinking cursor on dark screen ────────────────────────
    if (idlePhase === 'boot') {
      if (idleCursorVisible) _setCell(startCol, startRow, '█', 1.0);
      if (elapsed >= CONFIG.IDLE_BOOT_DELAY) {
        idlePhase      = 'glitch';
        idlePhaseStart = now;
      }
      return;
    }

    // ── GLITCH phase — scan-line noise that builds then collapses ──────────
    if (idlePhase === 'glitch') {
      const progress = elapsed / CONFIG.IDLE_GLITCH_DURATION;
      if (progress >= 1.0) {
        idlePhase    = 'typing';
        idleLastTime = now;
        return;
      }

      // Density arc: ramps up to peak at 50%, then collapses
      const density = progress < 0.5 ? progress * 2 : (1 - progress) * 2;
      const noiseChars = '!@#$%^&*<>?/|~░▒▓█▄▀■□' + CONFIG.KATAKANA.slice(0, 20).join('');

      // Scattered individual chars
      const scatterCount = Math.floor(density * cols * rows * 0.35);
      for (let i = 0; i < scatterCount; i++) {
        const r  = Math.floor(Math.random() * rows);
        const c  = Math.floor(Math.random() * cols);
        const ch = noiseChars[Math.floor(Math.random() * noiseChars.length)];
        _setCell(c, r, ch, 0.3 + Math.random() * 0.7);
      }

      // Horizontal scan-line bursts
      const lineCount = Math.floor(density * rows * 0.5);
      for (let i = 0; i < lineCount; i++) {
        const r      = Math.floor(Math.random() * rows);
        const len    = Math.floor(cols * (0.3 + Math.random() * 0.7));
        const startC = Math.floor(Math.random() * (cols - len));
        for (let c = startC; c < startC + len; c++) {
          const ch = noiseChars[Math.floor(Math.random() * noiseChars.length)];
          _setCell(c, r, ch, 0.4 + Math.random() * 0.6);
        }
      }

      // Near end of glitch (>70%): ghost of the first idle line bleeds through
      if (progress > 0.7) {
        const bleedBright = (progress - 0.7) / 0.3 * 0.5;
        _setString(startCol, startRow, lines[0], bleedBright);
      }
      return;
    }

    // ── TYPING / GAP / DONE phases — typewriter ────────────────────────────
    if (idlePhase === 'typing') {
      const line = lines[idleLineIndex];
      if (!line || line.length === 0) {
        idlePhase    = 'gap';
        idleLastTime = now;
      } else if (now - idleLastTime >= CONFIG.IDLE_CHAR_DELAY) {
        idleCharIndex++;
        idleLastTime = now;
        if (idleCharIndex >= line.length) {
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
        idlePhase    = idleLineIndex < lines.length ? 'typing' : 'done';
        idleLastTime = now;
      }
    }

    // Draw committed lines
    for (let i = 0; i < lines.length; i++) {
      const committed = idleRendered[i];
      if (committed) {
        const bright = (i === 0) ? 1.0 : committed.startsWith('>') ? 0.9 : 0.65;
        _setString(startCol, startRow + i, committed, bright);
      }
    }

    // Draw in-progress line
    if (idlePhase === 'typing' && idleLineIndex < lines.length) {
      const partial = lines[idleLineIndex].slice(0, idleCharIndex);
      if (partial.length > 0) {
        const bright = (idleLineIndex === 0) ? 1.0 : lines[idleLineIndex].startsWith('>') ? 0.9 : 0.65;
        _setString(startCol, startRow + idleLineIndex, partial, bright);
      }
    }

    // Typewriter cursor — hidden once file browser takes over as the cursor
    const browserVisible = audioFiles.length > 0 || audioFilesLoading;
    if (!browserVisible || idlePhase !== 'done') {
      const cursorRow = idlePhase === 'done'
        ? startRow + lines.length
        : startRow + idleLineIndex;
      const cursorCol = (idlePhase === 'done' || idlePhase === 'gap')
        ? startCol
        : startCol + idleCharIndex;
      if (idleCursorVisible) _setCell(cursorCol, cursorRow, '█', 1.0);
    }

    // ── File browser panel — right side of screen ──────────────────────────
    const maxLineLen = Math.max(...lines.map(l => l.length));
    const panelCol   = startCol + maxLineLen + 4;
    _renderFileBrowser(panelCol, startRow);
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

    const modeNames = ['GLITCH', 'FUSION'];
    modeEl.textContent = 'MODE: ' + (isIdle ? 'IDLE' : (modeNames[currentModeIndex] || 'UNKNOWN'));

    phoEl.textContent = 'PHO: ' + currentPhosphor.toUpperCase();

    srcEl.textContent = src === 'demo' ? '[DEMO]' :
                        src === 'file' ? '[AUDIO FILE]' :
                        '[READY]';

    // DEMO button lit = demo mode active
    const demoBtn = document.getElementById('demo-btn');
    if (demoBtn) demoBtn.classList.toggle('active', src === 'demo');

    // Fusion panel hint — shown only when Fusion mode is active and audio is running
    const fusionHintEl = document.getElementById('status-fusion');
    if (fusionHintEl) fusionHintEl.style.display = (currentModeIndex === 1 && !isIdle) ? '' : 'none';

    // Snapshot slot indicator — shown only in Fusion mode with audio active
    const snapEl = document.getElementById('status-snap');
    if (snapEl) {
      if (currentModeIndex === 1 && fusionAutomation && !isIdle) {
        snapEl.textContent = '[SNAP: ' + (fusionAutomation.currentSlot + 1) + ']';
        snapEl.style.display = '';
      } else {
        snapEl.textContent = '';
        snapEl.style.display = 'none';
      }
    }

    // BG playlist indicator — shown when playlist has 2+ items
    const bgEl = document.getElementById('status-bg');
    if (bgEl) {
      if (backgroundLayer.playlistLength > 1) {
        bgEl.textContent = '[BG ' + (backgroundLayer.playlistIndex + 1) + '/' + backgroundLayer.playlistLength + ']';
        bgEl.style.display = '';
      } else {
        bgEl.textContent = '';
        bgEl.style.display = 'none';
      }
    }

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
    if (window.hideFusionPanel) window.hideFusionPanel(); // close panel on any mode switch
    currentModeIndex = index;
    activeMode = modes[index];
    if (activeMode && typeof activeMode.reset === 'function') activeMode.reset();
    if (fusionAutomation) fusionAutomation.reset();
    if (index !== 0) window._glitchActive = false;
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

  // ── Audio library ─────────────────────────────────────────────────────────

  // Fetch the /audio/ directory listing and extract audio filenames.
  // Works with npx serve and python -m http.server (both serve HTML directory indexes).
  async function fetchAudioFileList() {
    audioFilesLoading = true;
    try {
      const res = await fetch('/audio/');
      if (!res.ok) { audioFilesLoading = false; return; }
      const html = await res.text();
      const re = /href="([^"?#]*\.(mp3|ogg|wav|flac|aac|m4a))"/gi;
      const seen = new Set();
      let m;
      while ((m = re.exec(html)) !== null) {
        const name = decodeURIComponent(m[1].split('/').pop());
        if (name) seen.add(name);
      }
      audioFiles   = [...seen].sort((a, b) => a.localeCompare(b));
      audioFileIdx = 0;
    } catch (e) {
      console.warn('[AudioBrowser] Could not fetch /audio/:', e.message);
    }
    audioFilesLoading = false;
  }

  // Fetch background_images/manifest.json and seed the playlist.
  // Mirrors the fetchAudioFileList() pattern — non-blocking, silent on failure.
  async function fetchBgManifest() {
    try {
      const res = await fetch('background_images/manifest.json');
      if (!res.ok) return;
      const files = await res.json();
      if (!Array.isArray(files)) return;
      files.forEach(name => {
        if (typeof name === 'string' && name.trim()) {
          backgroundLayer.addUrl('background_images/' + name.trim(), name.trim());
        }
      });
    } catch (e) {
      console.warn('[BgManifest] Could not load manifest:', e.message);
    }
  }

  // Load a file from the /audio/ library by filename.
  function _loadAudioFromLibrary(filename) {
    if (typeof getAudioContext === 'function') {
      const ctx = getAudioContext();
      if (ctx && ctx.state === 'suspended') ctx.resume().catch(() => {});
    }
    const srcEl = document.getElementById('status-src');
    if (srcEl) srcEl.textContent = '[LOADING...]';
    audioManager.loadAudioUrl('/audio/' + encodeURIComponent(filename)).then(result => {
      if (result === 'live') activateMode(currentModeIndex);
      updateStatusBar();
    });
  }

  // Render the audio file browser into the right panel of the idle screen.
  function _renderFileBrowser(panelCol, panelRow) {
    const panelW = cols - panelCol - 1;
    if (panelW < 12) return;

    let r = panelRow;

    // Header
    _setString(panelCol, r++, '── AUDIO LIBRARY', 0.4);

    if (audioFilesLoading) {
      r++;
      _setString(panelCol, r, 'SCANNING...', 0.45);
      return;
    }

    if (audioFiles.length === 0) {
      r++;
      _setString(panelCol, r++, 'NO FILES FOUND', 0.3);
      _setString(panelCol, r,   'ADD FILES TO /audio/', 0.22);
      return;
    }

    r++;  // blank row after header

    // Scrollable list — fill remaining rows minus 2 (gap + hint line)
    const viewH = Math.max(1, rows - panelRow - 3);
    const scrollTop = Math.max(0, Math.min(
      audioFileIdx - Math.floor(viewH / 2),
      Math.max(0, audioFiles.length - viewH)
    ));

    for (let i = 0; i < viewH; i++) {
      const idx = scrollTop + i;
      if (idx >= audioFiles.length) break;
      const isSelected = idx === audioFileIdx;
      const name = audioFiles[idx];

      // Truncate to panel width (prefix is 2 chars)
      const maxName = panelW - 2;
      const label = name.length > maxName ? name.slice(0, maxName - 3) + '...' : name;
      const prefix = isSelected ? '> ' : '  ';

      _setString(panelCol, r++, prefix + label, isSelected ? 1.0 : 0.45);
    }

    // Scroll indicator when list overflows
    if (audioFiles.length > viewH) {
      const pct = Math.round((scrollTop / Math.max(1, audioFiles.length - viewH)) * 100);
      _setString(panelCol, r++, '  [' + pct + '%]', 0.22);
    }

    r++;  // blank row before hint
    _setString(panelCol, r, '\u2191/\u2193 NAV  \u21b5 PLAY', 0.28);
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
    backgroundFX    = new BackgroundFX(backgroundLayer);
    resetIdleAnimation();
    fetchAudioFileList();   // non-blocking — populates audioFiles when ready
    fetchBgManifest();      // non-blocking — seeds bg playlist from manifest.json

    modes.push(new GlitchMode(CONFIG));   // 0
    modes.push(new FusionMode(CONFIG));   // 1

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
      const files = Array.from(input.files);
      files.forEach(f => backgroundLayer.addFile(f));
      input.value = '';
    };

    window.bgNext = function() { backgroundLayer.next(); };
    window.bgPrev = function() { backgroundLayer.prev(); };

    window.handleAudioFileInput = function(input) {
      const file = input.files[0];
      if (file) _loadAudioFileFromObject(file);
      input.value = '';
    };

    window.toggleScanlines = function() { showScanlines = !showScanlines; };

    fusionAutomation = window.fusionAutomation;

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

    // Drag-and-drop: audio → AudioManager; font → loadFontFile; image/video → BackgroundLayer
    document.addEventListener('dragover', e => e.preventDefault());
    document.addEventListener('drop', e => {
      e.preventDefault();
      const file = e.dataTransfer.files[0];
      if (!file) return;
      if (file.type.startsWith('audio/')) {
        _loadAudioFileFromObject(file);
      } else {
        backgroundLayer.addFile(file);
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
    if (fusionAutomation && currentModeIndex === 1) {
      fusionAutomation.update(audioManager);
    }
    backgroundLayer.update(cols, rows);
    if (backgroundFX) {
      if (currentModeIndex === 1) backgroundFX.update(audioManager);
      else backgroundFX.hide();
    }
    activeMode.update(grid, cols, rows, audioManager, backgroundLayer);
    p.background(0, CONFIG.CANVAS_BG_ALPHA);
    renderGrid();
    if (showScanlines) drawScanlines();
    updateStatusBar();
  };

  p.keyPressed = function() {
    const key     = p.key;
    const keyCode = p.keyCode;

    // ── Audio library browser navigation (idle screen only) ──
    if (audioManager && audioManager.isIdle && audioFiles.length > 0) {
      if (keyCode === p.UP_ARROW) {
        audioFileIdx = Math.max(0, audioFileIdx - 1);
        return false;
      }
      if (keyCode === p.DOWN_ARROW) {
        audioFileIdx = Math.min(audioFiles.length - 1, audioFileIdx + 1);
        return false;
      }
      if (keyCode === 13) { // ENTER
        _loadAudioFromLibrary(audioFiles[audioFileIdx]);
        return false;
      }
    }

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

    // Snapshot slot cycling — Fusion mode only, requires audio active
    if (p.key === '.' && currentModeIndex === 1 && fusionAutomation && !audioManager.isIdle) {
      fusionAutomation.nextSlot();
      updateStatusBar();
      return false;
    }
    if (p.key === ',' && currentModeIndex === 1 && fusionAutomation && !audioManager.isIdle) {
      fusionAutomation.prevSlot();
      updateStatusBar();
      return false;
    }

    // Background playlist navigation — Shift+, (<) and Shift+. (>)
    if (p.key === '<') { backgroundLayer.prev(); return false; }
    if (p.key === '>') { backgroundLayer.next(); return false; }

    // Tab — open/close Fusion params panel (Fusion mode only)
    if (keyCode === 9) {
      if (!audioManager.isIdle && currentModeIndex === 1) {
        if (window.toggleFusionPanel) window.toggleFusionPanel();
      }
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
