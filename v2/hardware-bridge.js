// v2/hardware-bridge.js — Browser-side WebSocket client for the Pi hardware bridge
//
// Identical WebSocket protocol to the root hardware-bridge.js (ws://localhost:9001).
// Receives { type: "hw", params: {...} } messages and writes values into V2_PARAMS.
// Sends { type: "audio", ... } messages with audioManager state at ~16 Hz.
//
// Differences from v1:
//   - Writes to window.V2_PARAMS / window.V2_PARAM_RANGES (not FUSION_PARAMS)
//   - No syncFusionPanelState() call (no panel in v2 MVP)
//   - No bgFx nested-path handling (no bgFx in v2)
//
// Load order: after config.js, before sketch.js

(function () {
  'use strict';

  const LOG_PREFIX        = '[hw-bridge-v2]';
  const WS_URL            = 'ws://localhost:9001';
  const SEND_INTERVAL_MS  = 60;      // ~16.7 Hz audio state updates
  const RECONNECT_MIN     = 1000;    // ms
  const RECONNECT_MAX     = 16000;   // ms

  let _reconnectDelay = RECONNECT_MIN;
  let _reconnectTimer = null;

  // ── Param writer ─────────────────────────────────────────────────────────────

  /**
   * Write a value to V2_PARAMS by key name.
   * Clamps against V2_PARAM_RANGES before writing.
   * Boolean params (keys ending with "Enabled") are accepted as-is (pass 0/1 or bool).
   *
   * @param {string} key   - param key (flat, no dot-path in v2)
   * @param {number} value - raw value from hardware
   */
  function setV2Param(key, value) {
    const params = window.V2_PARAMS;
    const ranges = window.V2_PARAM_RANGES;
    if (!params) return;

    // Boolean toggle: hardware sends 0/1
    if (typeof params[key] === 'boolean') {
      params[key] = Boolean(value);
      return;
    }

    // Reject NaN / Infinity before they can land in V2_PARAMS — Math.max/min
    // pass NaN through, and downstream consumers produce blank frames.
    if (typeof value !== 'number' || !Number.isFinite(value)) return;

    // Numeric param — clamp to range if available, round to integer if both bounds are integers
    const range = ranges && ranges[key];
    if (range) {
      let clamped = Math.max(range.min, Math.min(range.max, value));
      // Round only when the range spans more than 1 — avoids rounding float params
      // like bgOpacity {0,1} where Number.isInteger(1.0) === true in JS.
      if (Number.isInteger(range.min) && Number.isInteger(range.max) && (range.max - range.min) > 1) {
        clamped = Math.round(clamped);
      }
      params[key] = clamped;
    } else {
      params[key] = value;
    }
  }

  /**
   * Enforce rainSpeedMin < rainSpeedMax - 0.05.
   */
  function enforceSpeedConstraint() {
    const p = window.V2_PARAMS;
    if (!p) return;
    if (p.rainSpeedMin !== undefined && p.rainSpeedMax !== undefined) {
      if (p.rainSpeedMin > p.rainSpeedMax - 0.05) {
        p.rainSpeedMin = Math.max(0.05, p.rainSpeedMax - 0.05);
      }
    }
  }

  // ── Hardware event dispatcher ─────────────────────────────────────────────────

  const HW_EVENT_KEYS = {
    next_bg:         'ArrowRight',
    toggle_bg_ascii: 'v',
  };

  function dispatchHwEvent(eventName) {
    const key = HW_EVENT_KEYS[eventName];
    if (!key) {
      console.warn(LOG_PREFIX, 'Unknown hw_event:', eventName);
      return;
    }
    document.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
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

    if (msg.type === 'hw_event') {
      dispatchHwEvent(msg.event);
      return;
    }

    if (msg.type !== 'hw') return;

    const params = msg.params;
    if (!params || typeof params !== 'object') return;

    let speedParamWritten = false;

    for (const [key, value] of Object.entries(params)) {
      if (typeof value !== 'number' && typeof value !== 'boolean') continue;
      setV2Param(key, value);
      if (key === 'rainSpeedMin' || key === 'rainSpeedMax') {
        speedParamWritten = true;
      }
    }

    if (speedParamWritten) {
      enforceSpeedConstraint();
    }
  }

  // ── Audio state sender ────────────────────────────────────────────────────────

  function buildAudioMessage() {
    const am = window.audioManager;
    if (!am) return null;
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
    if (_reconnectTimer !== null) {
      clearTimeout(_reconnectTimer);
      _reconnectTimer = null;
    }

    let ws;
    try {
      ws = new WebSocket(WS_URL);
    } catch (e) {
      scheduleReconnect();
      return;
    }

    let sendInterval = null;

    ws.onopen = function () {
      console.log(LOG_PREFIX, 'Connected to', WS_URL);
      _reconnectDelay = RECONNECT_MIN;

      sendInterval = setInterval(function () {
        if (ws.readyState !== WebSocket.OPEN) return;
        const msg = buildAudioMessage();
        if (msg !== null) ws.send(msg);
      }, SEND_INTERVAL_MS);
    };

    ws.onmessage = handleMessage;

    ws.onerror = function () {
      // Followed by onclose — no action needed
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
