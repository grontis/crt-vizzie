// v2/startup.js — V2StartupScreen
// Full-screen terminal-style boot overlay with typewriter animation, glitch
// corruption, and a three-option audio-source menu.
//
// Usage:
//   const screen = new V2StartupScreen(V2_CONFIG)
//   const choice = await screen.run()  // 'demo' | 'live' | 'file'
//
// The overlay is injected into document.body by run() and removed on selection.
// Load order: after config.js

'use strict';

class V2StartupScreen {

  // Boot text lines — printed character by character before the menu appears
  static BOOT_LINES = [
    'GRONTIS.IO SYSTEM v2.0',
    '──────────────────────────────────────',
    'BIOS v2.48  [OK]',
    'CPU: ARM CORTEX-A76 x4  3.6GHz  [OK]',
    'MEMORY: 8192MB LPDDR4X  [OK]',
    'WebGL2: INITIALIZING... DONE  [OK]',
    'GLYPH ATLAS: 275 chars  [OK]',
    'AUDIO ENGINE: READY  [OK]',
    '──────────────────────────────────────',
    'SELECT INPUT SOURCE:',
  ];

  // Characters used for glitch corruption
  static GLITCH_CHARS = '!@#$%^&*[]{}|\\/<>?~░▒▓';

  // Menu option definitions: [data-choice, display label]
  static MENU_OPTIONS = [
    { choice: 'demo', label: '[ 1 ]  DEMO MODE' },
    { choice: 'live', label: '[ 2 ]  LIVE INPUT' },
    { choice: 'file', label: '[ 3 ]  LOAD FILE' },
  ];

  /**
   * @param {object} config — V2_CONFIG (not used directly now but kept for
   *   forward-compatibility if the font name or palette ever comes from config)
   */
  constructor(config) {
    this._config = config;

    // DOM refs (populated in _buildDOM)
    this._overlayEl  = null;
    this._outputEl   = null;
    this._cursorEl   = null;
    this._menuEl     = null;
    this._menuItems  = []; // Array of DOM elements, one per menu option

    // Typewriter state
    this._lines    = V2StartupScreen.BOOT_LINES;
    this._lineIdx  = 0;
    this._charIdx  = 0;

    // Selection state
    this._selectedIdx = 0; // index into MENU_OPTIONS

    // Timers and handlers
    this._glitchInterval = null;
    this._keyHandler     = null;

    // Promise resolver — set in run()
    this._resolve = null;
  }

  // ── Public ─────────────────────────────────────────────────────────────────

  /**
   * Show the overlay, run the boot sequence, and wait for a user choice.
   * @returns {Promise<'demo' | 'live' | 'file'>}
   */
  run() {
    return new Promise((resolve) => {
      this._resolve = resolve;
      this._buildDOM();
      this._startGlitchTick();
      this._typeNext();
    });
  }

  // ── DOM construction ───────────────────────────────────────────────────────

  _buildDOM() {
    // Overlay
    const overlay = document.createElement('div');
    overlay.id = 'v2-startup-overlay';
    this._overlayEl = overlay;

    // Terminal container
    const terminal = document.createElement('div');
    terminal.id = 'v2-startup-terminal';

    // Boot output area
    const output = document.createElement('div');
    output.id = 'v2-boot-output';
    this._outputEl = output;

    // Blinking cursor
    const cursor = document.createElement('div');
    cursor.id = 'v2-boot-cursor';
    cursor.textContent = '█'; // █
    this._cursorEl = cursor;

    // Menu (hidden until boot text completes)
    const menu = document.createElement('div');
    menu.id = 'v2-menu';
    menu.style.display = 'none';
    this._menuEl = menu;

    V2StartupScreen.MENU_OPTIONS.forEach((opt, i) => {
      const item = document.createElement('div');
      item.className = 'v2-menu-item';
      item.dataset.choice = opt.choice;
      item.textContent = opt.label;
      item.addEventListener('click', () => {
        this._select(opt.choice);
      });
      this._menuItems.push(item);
      menu.appendChild(item);
    });

    terminal.appendChild(output);
    terminal.appendChild(cursor);
    terminal.appendChild(menu);
    overlay.appendChild(terminal);
    document.body.appendChild(overlay);
  }

  // ── Typewriter ─────────────────────────────────────────────────────────────

  _typeNext() {
    // All lines printed — show menu
    if (this._lineIdx >= this._lines.length) {
      this._showMenu();
      return;
    }

    const line = this._lines[this._lineIdx];

    if (this._charIdx < line.length) {
      // Append next character
      this._outputEl.textContent += line[this._charIdx];
      this._charIdx++;
      setTimeout(() => this._typeNext(), 18);
    } else {
      // End of line — append newline and advance
      this._outputEl.textContent += '\n';
      this._lineIdx++;
      this._charIdx = 0;
      setTimeout(() => this._typeNext(), 120);
    }
  }

  // ── Glitch tick ────────────────────────────────────────────────────────────

  _startGlitchTick() {
    this._glitchInterval = setInterval(() => {
      // ~8% chance per 80ms tick to corrupt one character
      if (Math.random() >= 0.08) return;

      const original = this._outputEl.textContent;
      if (original.length === 0) return;

      // Find indices of non-newline, non-space characters
      const candidates = [];
      for (let i = 0; i < original.length; i++) {
        const ch = original[i];
        if (ch !== '\n' && ch !== ' ') candidates.push(i);
      }
      if (candidates.length === 0) return;

      const pos     = candidates[Math.floor(Math.random() * candidates.length)];
      const glyphs  = V2StartupScreen.GLITCH_CHARS;
      const corrupt = glyphs[Math.floor(Math.random() * glyphs.length)];

      // Splice in corrupt character
      const corrupted = original.slice(0, pos) + corrupt + original.slice(pos + 1);
      this._outputEl.textContent = corrupted;

      // Restore after 150ms
      setTimeout(() => {
        // Only restore if the output element is still present and hasn't changed further
        if (this._outputEl) {
          this._outputEl.textContent = original;
        }
      }, 150);
    }, 80);
  }

  // ── Menu ───────────────────────────────────────────────────────────────────

  _showMenu() {
    this._menuEl.style.display = 'block';
    this._selectedIdx = 0;
    this._updateMenuHighlight();

    // Keyboard handler
    this._keyHandler = (e) => {
      switch (e.key) {
        case '1':
          this._select('demo');
          break;
        case '2':
          this._select('live');
          break;
        case '3':
          this._select('file');
          break;
        case 'ArrowUp':
          e.preventDefault();
          this._selectedIdx = (this._selectedIdx - 1 + V2StartupScreen.MENU_OPTIONS.length)
            % V2StartupScreen.MENU_OPTIONS.length;
          this._updateMenuHighlight();
          break;
        case 'ArrowDown':
          e.preventDefault();
          this._selectedIdx = (this._selectedIdx + 1)
            % V2StartupScreen.MENU_OPTIONS.length;
          this._updateMenuHighlight();
          break;
        case 'Enter':
          this._select(V2StartupScreen.MENU_OPTIONS[this._selectedIdx].choice);
          break;
      }
    };
    document.addEventListener('keydown', this._keyHandler);
  }

  _updateMenuHighlight() {
    this._menuItems.forEach((item, i) => {
      if (i === this._selectedIdx) {
        item.classList.add('selected');
      } else {
        item.classList.remove('selected');
      }
    });
  }

  // ── Selection and fade-out ─────────────────────────────────────────────────

  _select(choice) {
    // Guard: prevent double-selection (e.g. kiosk timer + simultaneous keypress)
    if (!this._resolve) return;
    const resolve = this._resolve;
    this._resolve = null;

    // Stop glitch tick
    if (this._glitchInterval) {
      clearInterval(this._glitchInterval);
      this._glitchInterval = null;
    }

    // Remove keyboard handler
    if (this._keyHandler) {
      document.removeEventListener('keydown', this._keyHandler);
      this._keyHandler = null;
    }

    // Trigger CSS fade-out
    this._overlayEl.classList.add('fade-out');

    // After transition completes, remove overlay and resolve promise
    setTimeout(() => {
      if (this._overlayEl && this._overlayEl.parentNode) {
        this._overlayEl.remove();
      }
      this._overlayEl = null;
      resolve(choice);
    }, 650);
  }

}
