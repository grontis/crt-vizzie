// hardware-bridge.js — Browser-side WebSocket client for the Pi hardware bridge
//
// Connects to ws://localhost:9001 (pi-bridge.py).
// Receives { type: "hw", params: {...} } messages and writes values into FUSION_PARAMS.
// Sends { type: "audio", ... } messages with audioManager state at ~16 Hz.
//
// Load order: after fusion-params.js, fusion-panel.js, fusion-automation.js
//             and immediately before sketch.js.
//
// Design goals:
//   - Silent no-op when the bridge is not running (connection errors are swallowed)
//   - No crash if audioManager or FUSION_PARAMS are not yet defined
//   - Reconnects automatically with exponential backoff (1s → 2s → 4s → 8s → 16s cap)

(function () {
  'use strict';

  const LOG_PREFIX   = '[hw-bridge]';
  const WS_URL       = 'ws://localhost:9001';
  const SEND_INTERVAL_MS  = 60;     // ~16.7 Hz audio state updates
  const RECONNECT_MIN     = 1000;   // ms
  const RECONNECT_MAX     = 16000;  // ms

  let _reconnectDelay = RECONNECT_MIN;
  let _reconnectTimer = null;

  // ── Param writer ─────────────────────────────────────────────────────────────

  /**
   * Write a value to FUSION_PARAMS by dot-path notation.
   * Handles top-level keys ("rainSpeed") and one-level nested keys ("bgFx.warpAmount").
   * Clamps against FUSION_PARAM_RANGES before writing.
   *
   * @param {string} path  - dot-path param key
   * @param {number} value - raw value from hardware
   */
  function setFusionParam(path, value) {
    const params = window.FUSION_PARAMS;
    const ranges = window.FUSION_PARAM_RANGES;
    if (!params) return;

    const parts = path.split('.');

    if (parts.length === 1) {
      // Top-level param (e.g. "rainSpeed")
      const range   = ranges && ranges[path];
      const clamped = range ? Math.max(range.min, Math.min(range.max, value)) : value;
      params[path]  = clamped;

    } else if (parts.length === 2 && parts[0] === 'bgFx') {
      // Nested bgFx param (e.g. "bgFx.warpAmount")
      if (!params.bgFx) return;
      const key     = parts[1];
      const range   = ranges && ranges.bgFx && ranges.bgFx[key];
      const clamped = range ? Math.max(range.min, Math.min(range.max, value)) : value;
      params.bgFx[key] = clamped;

    } else {
      console.warn(LOG_PREFIX, 'Unsupported param path:', path);
    }
  }

  /**
   * Enforce rainSpeedMin < rainSpeedMax - 0.05.
   * Mirrors FusionAutomation._enforceSpeedConstraint().
   */
  function enforceSpeedConstraint() {
    const p = window.FUSION_PARAMS;
    if (!p) return;
    if (p.rainSpeedMin !== undefined && p.rainSpeedMax !== undefined) {
      if (p.rainSpeedMin > p.rainSpeedMax - 0.05) {
        p.rainSpeedMin = Math.max(0.05, p.rainSpeedMax - 0.05);
      }
    }
  }

  // ── Message handler ───────────────────────────────────────────────────────────

  function handleMessage(event) {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch (e) {
      console.warn(LOG_PREFIX, 'Non-JSON message ignored:', event.data);
      return;
    }

    if (msg.type !== 'hw') return;

    const params = msg.params;
    if (!params || typeof params !== 'object') return;

    let speedParamWritten = false;

    for (const [path, value] of Object.entries(params)) {
      if (typeof value !== 'number') continue;
      setFusionParam(path, value);
      if (path === 'rainSpeedMin' || path === 'rainSpeedMax') {
        speedParamWritten = true;
      }
    }

    if (speedParamWritten) {
      enforceSpeedConstraint();
    }

    // Sync panel sliders and toggle buttons to new param values
    if (typeof window.syncFusionPanelState === 'function') {
      window.syncFusionPanelState();
    }
  }

  // ── Audio state sender ────────────────────────────────────────────────────────

  function buildAudioMessage() {
    const am = window.audioManager;
    if (!am) {
      return null;
    }
    try {
      return JSON.stringify({
        type:          'audio',
        beatActive:    am.beatActive,
        beatIntensity: am.beatIntensity,
        bands:         am.getBands(),
      });
    } catch (e) {
      return null;
    }
  }

  // ── Connection ────────────────────────────────────────────────────────────────

  function connect() {
    // Clear any pending reconnect timer from a previous close/error
    if (_reconnectTimer !== null) {
      clearTimeout(_reconnectTimer);
      _reconnectTimer = null;
    }

    let ws;
    try {
      ws = new WebSocket(WS_URL);
    } catch (e) {
      // WebSocket construction can throw if the URL is invalid
      scheduleReconnect();
      return;
    }

    let sendInterval = null;

    ws.onopen = function () {
      console.log(LOG_PREFIX, 'Connected to', WS_URL);
      _reconnectDelay = RECONNECT_MIN;  // reset backoff on successful open

      sendInterval = setInterval(function () {
        if (ws.readyState !== WebSocket.OPEN) return;
        const msg = buildAudioMessage();
        if (msg !== null) {
          ws.send(msg);
        }
      }, SEND_INTERVAL_MS);
    };

    ws.onmessage = handleMessage;

    ws.onerror = function () {
      // Error is always followed by onclose — no action needed here
      // (logging at this level would be noisy when the bridge is simply not running)
    };

    ws.onclose = function () {
      if (sendInterval !== null) {
        clearInterval(sendInterval);
        sendInterval = null;
      }
      console.log(LOG_PREFIX, 'Disconnected — retrying in', _reconnectDelay, 'ms');
      scheduleReconnect();
    };
  }

  function scheduleReconnect() {
    _reconnectTimer = setTimeout(function () {
      _reconnectTimer = null;
      _reconnectDelay = Math.min(_reconnectDelay * 2, RECONNECT_MAX);
      connect();
    }, _reconnectDelay);
  }

  // ── Boot ──────────────────────────────────────────────────────────────────────

  console.log(LOG_PREFIX, 'Initializing — connecting to', WS_URL);
  connect();

}());
