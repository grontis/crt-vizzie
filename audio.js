// audio.js — AudioManager
// Two active sources:
//   'file' — p5.SoundFile looping a local audio file (MP3/OGG/WAV)
//   'demo' — procedural synthesizer (no hardware required)
// 'idle'  — no audio; spectrum/waveform are zeroed, draw loop shows terminal screen.

class AudioManager {
  constructor() {
    this._audioSource = 'idle'; // 'idle' | 'demo' | 'file'
    this._spectrum = new Float32Array(CONFIG.FFT_BINS / 2).fill(0);
    this._waveform = new Float32Array(CONFIG.FFT_BINS).fill(0);
    this._bands = { sub: 0, bass: 0, lowMid: 0, mid: 0, highMid: 0, treble: 0 };
    this._bassHistory = new Float32Array(CONFIG.BEAT_HISTORY).fill(0);
    this._bassHistIdx = 0;
    this._beatIntensity = 0;
    this._beatActive = false;
    this._lastBeatTime = 0;
    this._beatTimestamps = [];
    this._isMono = false;

    // File audio objects
    this._fft = null;
    this._soundFile = null;
    this._audioBlobUrl = null;

    // Demo oscillator state
    this._demoTime = 0;
    this._demoBPM = 120;
    this._demoBeatPulse = 0;
  }

  // ── Source control ──────────────────────────────────────────────────────────

  enableDemoMode() {
    this._cleanupFile();
    this._audioSource = 'demo';
    this._isMono = false;
    this._demoTime = 0;
    this._demoBeatPulse = 0;
    this._resetBeatState();
  }

  stopAudio() {
    this._cleanupFile();
    this._audioSource = 'idle';
    this._resetBeatState();
    this._spectrum.fill(0);
    this._waveform.fill(0);
    Object.keys(this._bands).forEach(k => this._bands[k] = 0);
  }

  // Load and loop a local audio file. Returns a promise: 'live' | 'error'.
  loadAudioFile(file) {
    this._cleanupFile();
    this._audioBlobUrl = URL.createObjectURL(file);

    return new Promise((resolve) => {
      this._soundFile = new p5.SoundFile(
        this._audioBlobUrl,
        () => {
          // p5.SoundFile routes through p5.sound master output by default.
          // p5.FFT without setInput() analyzes that master output — no explicit
          // wiring needed (setInput() would disconnect from master → silence).
          const ctx = typeof getAudioContext === 'function' ? getAudioContext() : null;
          if (ctx && ctx.state === 'suspended') ctx.resume().catch(() => {});

          this._fft = new p5.FFT(CONFIG.FFT_SMOOTHING, CONFIG.FFT_BINS);
          this._soundFile.loop();
          this._audioSource = 'file';
          this._isMono = false;
          this._resetBeatState();
          console.log('[AudioManager] File loaded:', file.name);
          resolve('live');
        },
        (err) => {
          console.warn('[AudioManager] Failed to load file:', err);
          URL.revokeObjectURL(this._audioBlobUrl);
          this._audioBlobUrl = null;
          resolve('error');
        }
      );
    });
  }

  // ── Getters ─────────────────────────────────────────────────────────────────

  get audioSource()   { return this._audioSource; }
  get isIdle()        { return this._audioSource === 'idle'; }
  get isDemo()        { return this._audioSource === 'demo'; }
  get isMono()        { return this._isMono; }
  get beatIntensity() { return this._beatIntensity; }
  get beatActive()    { return this._beatActive; }

  getSpectrum() { return this._spectrum; }
  getWaveform() { return this._waveform; }
  getBands()    { return this._bands; }

  // ── Per-frame update ────────────────────────────────────────────────────────

  update() {
    if (this._audioSource === 'idle') return;
    if (this._audioSource === 'demo') {
      this._updateDemo();
    } else {
      this._updateFile();
    }
    this._detectBeat();
  }

  _updateFile() {
    if (!this._fft) return;
    const spec = this._fft.analyze();
    for (let i = 0; i < this._spectrum.length; i++) {
      this._spectrum[i] = (spec[i] || 0) / 255;
    }
    const wave = this._fft.waveform();
    for (let i = 0; i < this._waveform.length; i++) {
      this._waveform[i] = wave[i] || 0;
    }
    this._computeBands();
  }

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

  // ── Internals ───────────────────────────────────────────────────────────────

  _cleanupFile() {
    if (this._soundFile) {
      try { if (this._soundFile.isPlaying()) this._soundFile.stop(); } catch (_) {}
      try { this._soundFile.disconnect(); } catch (_) {}
      this._soundFile = null;
    }
    if (this._audioBlobUrl) {
      URL.revokeObjectURL(this._audioBlobUrl);
      this._audioBlobUrl = null;
    }
    this._fft = null;
  }

  _resetBeatState() {
    this._beatIntensity = 0;
    this._beatActive = false;
    this._beatTimestamps = [];
    this._bassHistory.fill(0);
    this._bassHistIdx = 0;
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
    this._bassHistIdx = (this._bassHistIdx + 1) % CONFIG.BEAT_HISTORY;

    let avg = 0;
    for (let i = 0; i < CONFIG.BEAT_HISTORY; i++) avg += this._bassHistory[i];
    avg /= CONFIG.BEAT_HISTORY;

    const threshold  = avg * CONFIG.BEAT_THRESHOLD;
    const cooldownOk = (now - this._lastBeatTime) > CONFIG.BEAT_COOLDOWN;

    if (bass > threshold && bass > 0.2 && cooldownOk) {
      this._beatActive    = true;
      this._beatIntensity = Math.min(1, bass / Math.max(threshold, 0.01));
      this._lastBeatTime  = now;
      this._beatTimestamps.push(now);
      if (this._beatTimestamps.length > CONFIG.BPM_HISTORY) this._beatTimestamps.shift();
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

  getDominantFreq() {
    let maxVal = 0, maxIdx = 0;
    for (let i = 1; i < this._spectrum.length; i++) {
      if (this._spectrum[i] > maxVal) { maxVal = this._spectrum[i]; maxIdx = i; }
    }
    return Math.round(maxIdx * (44100 / CONFIG.FFT_BINS));
  }
}
