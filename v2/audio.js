// v2/audio.js — V2AudioManager
// Raw Web Audio API — no p5.sound, no CDN dependencies.
//
// Four source modes:
//   'idle'  — all data zeroed
//   'demo'  — procedural synthesizer (oscillator + LFO, no hardware required)
//   'file'  — HTML <audio> element via MediaElementSourceNode
//   'live'  — microphone via MediaStreamSourceNode (getUserMedia)
//
// AudioContext is created lazily on first call to resume() (user gesture).
//
// Load order: after config.js

'use strict';

class V2AudioManager {

  constructor() {
    this._source = 'idle'; // 'idle' | 'demo' | 'file' | 'live'

    // Web Audio nodes (created lazily)
    this._ctx      = null;
    this._analyser = null;
    this._gain     = null;

    // Demo oscillator nodes
    this._demoOsc      = null;
    this._demoLfo      = null;
    this._demoLfoGain  = null;
    this._demoNoise    = null;

    // File audio
    this._audioEl       = null;
    this._mediaSource   = null;
    this._blobUrl       = null;

    // Live (microphone) audio
    this._stream     = null; // MediaStream
    this._liveSource = null; // MediaStreamSourceNode

    // Analysis buffers
    // _spectrum size derived from FFT_SIZE so demo and file paths always agree.
    this._spectrumRaw  = null; // Float32Array — dB values from getFloatFrequencyData
    this._spectrum     = new Float32Array(V2_CONFIG.FFT_SIZE / 2).fill(0); // normalized 0–1
    this._waveform     = new Float32Array(1024).fill(0);
    this._bands        = { sub: 0, bass: 0, lowMid: 0, mid: 0, highMid: 0, treble: 0 };

    // Beat detection
    this._bassHistory     = new Float32Array(V2_CONFIG.BEAT_HISTORY).fill(0);
    this._bassHistIdx     = 0;
    this._beatIntensity   = 0;
    this._beatActive      = false;
    this._lastBeatTime    = 0;
    this._beatTimestamps  = [];

    // Demo synthesizer state (CPU-side, drives demo band values directly)
    this._demoTime       = 0;
    this._demoBeatPulse  = 0;
    this._demoBPM        = 120;
  }

  // ── AudioContext lifecycle ──────────────────────────────────────────────────

  /**
   * Create (or resume) the AudioContext.
   * Must be called from a user-gesture handler the first time.
   */
  resume() {
    if (!this._ctx) {
      this._ctx = new (window.AudioContext || window.webkitAudioContext)();
      this._analyser = this._ctx.createAnalyser();
      this._analyser.fftSize             = V2_CONFIG.FFT_SIZE;
      this._analyser.smoothingTimeConstant = V2_CONFIG.FFT_SMOOTHING;
      this._analyser.minDecibels         = -90;
      this._analyser.maxDecibels         = -10;

      this._gain = this._ctx.createGain();
      this._gain.gain.value = 1.0;
      this._gain.connect(this._analyser);
      this._analyser.connect(this._ctx.destination);

      const bins = this._analyser.frequencyBinCount; // fftSize/2
      this._spectrumRaw = new Float32Array(bins);
      this._spectrum    = new Float32Array(bins).fill(0);
    }
    if (this._ctx.state === 'suspended') {
      this._ctx.resume().catch(() => {});
    }
  }

  // ── Source control ──────────────────────────────────────────────────────────

  enableDemoMode() {
    this._cleanupFileAudio();
    this._cleanupLiveAudio();
    this._cleanupDemoNodes();
    this._source = 'demo';
    this._demoTime = 0;
    this._demoBeatPulse = 0;
    this._resetBeatState();

    // Build a simple oscillator graph: bass tone + LFO tremolo
    if (this._ctx) {
      this._buildDemoGraph();
    }
    // If ctx isn't created yet (no user gesture), demo mode still works via CPU path
  }

  stopAudio() {
    this._cleanupFileAudio();
    this._cleanupLiveAudio();
    this._cleanupDemoNodes();
    this._source = 'idle';
    this._resetBeatState();
    this._spectrum.fill(0);
    this._waveform.fill(0);
    Object.keys(this._bands).forEach(k => this._bands[k] = 0);
  }

  /**
   * Load a File object, create a blob URL, wire through MediaElementSourceNode.
   * Returns a promise resolving to 'live' | 'error'.
   */
  loadAudioFile(file) {
    this._cleanupFileAudio();
    this._cleanupLiveAudio();
    this._cleanupDemoNodes();

    if (this._blobUrl) {
      URL.revokeObjectURL(this._blobUrl);
    }
    this._blobUrl = URL.createObjectURL(file);

    return new Promise((resolve) => {
      const audioEl = new Audio();
      audioEl.loop  = true;
      audioEl.src   = this._blobUrl;

      audioEl.addEventListener('canplaythrough', () => {
        // Wire: audioEl → mediaSource → gain → analyser → destination
        try {
          if (!this._ctx) this.resume();
          const src = this._ctx.createMediaElementSource(audioEl);
          src.connect(this._gain);
          this._mediaSource = src;
          this._audioEl = audioEl;
          this._source = 'file';
          this._resetBeatState();
          audioEl.play().catch(e => console.warn('[V2Audio] play():', e));
          console.log('[V2Audio] File loaded:', file.name);
          resolve('live');
        } catch (e) {
          console.warn('[V2Audio] File wiring error:', e);
          resolve('error');
        }
      }, { once: true });

      audioEl.addEventListener('error', (e) => {
        console.warn('[V2Audio] Audio element error:', e);
        URL.revokeObjectURL(this._blobUrl);
        this._blobUrl = null;
        resolve('error');
      }, { once: true });

      audioEl.load();
    });
  }

  /**
   * Request microphone access and wire it into the existing audio graph.
   * Returns a promise resolving to 'live' on success or 'error' on failure.
   * @returns {Promise<'live' | 'error'>}
   */
  enableLiveMode() {
    this._cleanupFileAudio();
    this._cleanupLiveAudio();
    this._cleanupDemoNodes();

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      console.warn('[V2Audio] getUserMedia not available in this context');
      return Promise.resolve('error');
    }

    return navigator.mediaDevices.getUserMedia({ audio: true, video: false })
      .then((stream) => {
        if (!this._ctx) this.resume();
        this._stream = stream;
        this._liveSource = this._ctx.createMediaStreamSource(stream);
        this._liveSource.connect(this._gain);
        this._source = 'live';
        this._resetBeatState();
        console.log('[V2Audio] Live microphone input active');
        return 'live';
      })
      .catch((err) => {
        console.warn('[V2Audio] getUserMedia failed:', err);
        return 'error';
      });
  }

  // ── Getters ─────────────────────────────────────────────────────────────────

  get isIdle()        { return this._source === 'idle'; }
  get isDemo()        { return this._source === 'demo'; }
  get isLive()        { return this._source === 'live'; }
  get audioSource()   { return this._source; }
  get beatActive()    { return this._beatActive; }
  get beatIntensity() { return this._beatIntensity; }

  getSpectrum() { return this._spectrum; }
  getWaveform() { return this._waveform; }
  getBands()    { return this._bands; }

  getAudioState() {
    return {
      isIdle:        this.isIdle,
      spectrum:      this._spectrum,
      waveform:      this._waveform,
      bands:         this._bands,
      beatActive:    this._beatActive,
      beatIntensity: this._beatIntensity,
    };
  }

  // ── Per-frame update ────────────────────────────────────────────────────────

  update() {
    if (this._source === 'idle') return;

    if (this._source === 'demo') {
      this._updateDemo();
    } else {
      this._updateFile();
    }

    this._detectBeat();
  }

  // ── Private: file audio update ──────────────────────────────────────────────

  _updateFile() {
    if (!this._analyser || !this._spectrumRaw) return;

    this._analyser.getFloatFrequencyData(this._spectrumRaw);

    // Normalize dB values to 0–1 range
    // minDecibels = -90, maxDecibels = -10  → range = 80 dB
    const min   = this._analyser.minDecibels;
    const range = this._analyser.maxDecibels - min;
    const bins  = this._spectrumRaw.length;
    for (let i = 0; i < bins; i++) {
      this._spectrum[i] = Math.max(0, Math.min(1, (this._spectrumRaw[i] - min) / range));
    }

    this._analyser.getFloatTimeDomainData(this._waveform);
    this._computeBands();
  }

  // ── Private: demo synth ─────────────────────────────────────────────────────

  _updateDemo() {
    this._demoTime += 1 / 60;
    const t   = this._demoTime;
    const bps = this._demoBPM / 60;

    const beatPhase = (t * bps) % 1;
    if (beatPhase < 0.05) {
      this._demoBeatPulse = Math.max(this._demoBeatPulse, 1 - beatPhase / 0.05);
    } else {
      this._demoBeatPulse *= 0.85;
    }

    const bass   = 0.3 + 0.6 * this._demoBeatPulse + 0.05 * Math.sin(t * 2.1);
    const mid    = 0.15 + 0.3 * Math.sin(t * 3.7 + 0.5) * (0.5 + 0.5 * Math.sin(t * 0.4));
    const treble = 0.05 + 0.2 * Math.abs(Math.sin(t * 7.3)) * Math.random();

    // Fill spectrum bins to match the pattern from v1
    const bins = this._spectrum.length;
    for (let i = 0; i < bins; i++) {
      const norm = i / bins;
      let val = 0;
      if      (norm < 0.06) val = bass   * (1 - norm / 0.06) * (0.7 + 0.3 * Math.sin(t * 5.1 + i * 0.3));
      else if (norm < 0.2)  val = mid    * 0.8 * (1 - (norm - 0.06) / 0.14) * Math.abs(Math.sin(t * 4.2 + i * 0.5));
      else if (norm < 0.5)  val = mid    * 0.5 * Math.abs(Math.sin(t * 6.6 + i * 0.7));
      else                  val = treble * (0.3 + 0.7 * Math.random()) * (1 - norm);
      this._spectrum[i] = this._spectrum[i] * 0.7 + Math.min(1, Math.max(0, val)) * 0.3;
    }

    const wlen = this._waveform.length;
    for (let i = 0; i < wlen; i++) {
      const ph = (i / wlen) * Math.PI * 2;
      this._waveform[i] = Math.max(-1, Math.min(1,
        0.4 * bass   * Math.sin(ph * 2  + t * 6.28) +
        0.2 * mid    * Math.sin(ph * 5  + t * 12.56) +
        0.1 * treble * Math.sin(ph * 13 + t * 31.4) +
        0.05 * (Math.random() * 2 - 1)
      ));
    }

    this._bands.sub     = Math.min(1, bass * 0.9);
    this._bands.bass    = Math.min(1, bass * 0.85 + 0.05 * Math.sin(t * 3));
    this._bands.lowMid  = Math.min(1, mid * 0.9);
    this._bands.mid     = Math.min(1, mid * 0.7 + 0.1 * Math.abs(Math.sin(t * 5)));
    this._bands.highMid = Math.min(1, mid * 0.4 + treble * 0.3);
    this._bands.treble  = Math.min(1, treble);
  }

  // ── Private: demo Web Audio graph ──────────────────────────────────────────

  _buildDemoGraph() {
    if (!this._ctx || !this._gain) return;
    try {
      // Bass oscillator
      this._demoOsc = this._ctx.createOscillator();
      this._demoOsc.type = 'sawtooth';
      this._demoOsc.frequency.value = 55; // A1

      // LFO for tremolo / beat-like pulsing
      this._demoLfo     = this._ctx.createOscillator();
      this._demoLfoGain = this._ctx.createGain();
      this._demoLfo.type = 'sine';
      this._demoLfo.frequency.value = 2; // 2 Hz

      const oscGain = this._ctx.createGain();
      oscGain.gain.value = 0.15; // low volume — we only care about analysis

      this._demoLfoGain.gain.value = 0.5;
      this._demoLfo.connect(this._demoLfoGain);
      this._demoLfoGain.connect(oscGain.gain);

      this._demoOsc.connect(oscGain);
      oscGain.connect(this._gain);

      this._demoOsc.start();
      this._demoLfo.start();
    } catch (e) {
      console.warn('[V2Audio] Demo graph build error:', e);
    }
  }

  // ── Private: internals ──────────────────────────────────────────────────────

  _cleanupDemoNodes() {
    for (const node of [this._demoOsc, this._demoLfo, this._demoLfoGain, this._demoNoise]) {
      if (!node) continue;
      try { node.stop(); } catch (_) {}
      try { node.disconnect(); } catch (_) {}
    }
    this._demoOsc     = null;
    this._demoLfo     = null;
    this._demoLfoGain = null;
    this._demoNoise   = null;
  }

  _cleanupFileAudio() {
    if (this._audioEl) {
      try { this._audioEl.pause(); } catch (_) {}
      this._audioEl.src = '';
      this._audioEl = null;
    }
    if (this._mediaSource) {
      try { this._mediaSource.disconnect(); } catch (_) {}
      this._mediaSource = null;
    }
    if (this._blobUrl) {
      URL.revokeObjectURL(this._blobUrl);
      this._blobUrl = null;
    }
    // Only reset to idle if we were actually in file mode — avoid clobbering
    // other source states when called as part of a source switch.
    if (this._source === 'file') this._source = 'idle';
  }

  _cleanupLiveAudio() {
    if (this._liveSource) {
      try { this._liveSource.disconnect(); } catch (_) {}
      this._liveSource = null;
    }
    if (this._stream) {
      try { this._stream.getTracks().forEach(t => t.stop()); } catch (_) {}
      this._stream = null;
    }
    if (this._source === 'live') this._source = 'idle';
  }

  _resetBeatState() {
    this._beatIntensity = 0;
    this._beatActive    = false;
    this._beatTimestamps = [];
    this._bassHistory.fill(0);
    this._bassHistIdx   = 0;
  }

  _computeBands() {
    const bins = this._spectrum.length;
    this._bands.sub     = this._avgBins(0,                        Math.floor(bins * 0.02));
    this._bands.bass    = this._avgBins(Math.floor(bins * 0.02),  Math.floor(bins * 0.05));
    this._bands.lowMid  = this._avgBins(Math.floor(bins * 0.05),  Math.floor(bins * 0.1));
    this._bands.mid     = this._avgBins(Math.floor(bins * 0.1),   Math.floor(bins * 0.2));
    this._bands.highMid = this._avgBins(Math.floor(bins * 0.2),   Math.floor(bins * 0.45));
    this._bands.treble  = this._avgBins(Math.floor(bins * 0.45),  bins);
  }

  _avgBins(start, end) {
    if (end <= start) return 0;
    let sum = 0;
    for (let i = start; i < end; i++) sum += this._spectrum[i];
    return sum / (end - start);
  }

  _detectBeat() {
    const now  = performance.now();
    const bass = this._bands.bass;

    this._bassHistory[this._bassHistIdx] = bass;
    this._bassHistIdx = (this._bassHistIdx + 1) % V2_CONFIG.BEAT_HISTORY;

    let avg = 0;
    for (let i = 0; i < V2_CONFIG.BEAT_HISTORY; i++) avg += this._bassHistory[i];
    avg /= V2_CONFIG.BEAT_HISTORY;

    const threshold  = avg * V2_CONFIG.BEAT_THRESHOLD;
    const cooldownOk = (now - this._lastBeatTime) > V2_CONFIG.BEAT_COOLDOWN;

    if (bass > threshold && bass > 0.2 && cooldownOk) {
      this._beatActive    = true;
      this._beatIntensity = Math.min(1, bass / Math.max(threshold, 0.01));
      this._lastBeatTime  = now;
      this._beatTimestamps.push(now);
      if (this._beatTimestamps.length > V2_CONFIG.BPM_HISTORY) this._beatTimestamps.shift();
    } else {
      this._beatActive     = false;
      this._beatIntensity *= 0.9;
    }
  }

  getBPM() {
    if (this._beatTimestamps.length < 4) return null;
    const intervals = [];
    for (let i = 1; i < this._beatTimestamps.length; i++) {
      intervals.push(this._beatTimestamps[i] - this._beatTimestamps[i - 1]);
    }
    intervals.sort((a, b) => a - b);
    const median = intervals[Math.floor(intervals.length / 2)];
    return median > 0 ? Math.round(60000 / median) : null;
  }
}
