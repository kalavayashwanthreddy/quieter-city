// Mic capture engine for the REAL-TIME privacy pipeline (spec: dynamic chunk
// processing). The microphone stream is decimated to 16 kHz mono and split into
// one-YAMNet-frame (~0.975 s) chunks. Each COMPLETED chunk is handed to the
// analyzer immediately while recording continues — the engine never accumulates
// more than one full chunk plus the current partial one, so raw audio exists
// only in short, immediately-analyzed slices (spec §10/§14: small RAM buffer →
// real-time detector → DROP). A live dB(A) meter also feeds the UI. Raw audio
// never leaves this class.
import {
  YAMNET_SAMPLE_RATE,
  YAMNET_WINDOW,
  SESSION_MAX_SECONDS,
  METER_INTERVAL_MS,
  CALIBRATION_OFFSET_DB,
} from '../shared/schema.js';
import { aWeightDb } from '../shared/audio.js';
import { MIN_WINDOW_SAMPLES } from '../shared/sessionAnalysis.js';

export class NoiseEngine {
  constructor({ onMeter, onCap, onChunk } = {}) {
    this.onMeter = onMeter || (() => {});
    this.onCap = onCap || (() => {});
    this.onChunk = onChunk || (() => {});
    this.buffer = new Float32Array(YAMNET_WINDOW); // current (possibly partial) chunk
    this.bufferLen = 0;
    this.totalSamples = 0;
    this.capSamples = SESSION_MAX_SECONDS * YAMNET_SAMPLE_RATE;
    this.analyser = null;
    this.ctx = null;
    this.stream = null;
    this.processor = null;
    this.timer = null;
    this.stopped = true;
    this.startedAt = 0;
  }

  async start() {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false, // we want the raw signal
      },
    });
    const Ctx = window.AudioContext || window.webkitAudioContext;
    this.ctx = new Ctx();
    await this.ctx.resume();

    this.source = this.ctx.createMediaStreamSource(this.stream);

    // Analyser for the live dB(A) meter.
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 2048;
    this.source.connect(this.analyser);

    // ScriptProcessor (deprecated but universally supported) to capture raw
    // PCM. Connected through a zero-gain node so we never hear ourselves.
    this.processor = this.ctx.createScriptProcessor(4096, 1, 1);
    this.source.connect(this.processor);
    const zero = this.ctx.createGain();
    zero.gain.value = 0;
    this.processor.connect(zero);
    zero.connect(this.ctx.destination);

    this.decimStep = this.ctx.sampleRate / YAMNET_SAMPLE_RATE;
    this.acc = 0;
    this.processor.onaudioprocess = (e) => this._onAudio(e);

    this.stopped = false;
    this.startedAt = performance.now();
    this.timer = setInterval(() => this._meterTick(), METER_INTERVAL_MS);
  }

  _onAudio(e) {
    if (this.stopped) return;
    const ch = e.inputBuffer.getChannelData(0);
    const step = this.decimStep;
    let acc = this.acc;
    for (let i = 0; i < ch.length && this.totalSamples < this.capSamples; i++) {
      acc += 1;
      if (acc >= step) {
        acc -= step;
        this.buffer[this.bufferLen++] = ch[i];
        this.totalSamples++;
        // Chunk complete → hand it to the analyzer RIGHT NOW; the engine then
        // forgets it entirely (the analyzer wipes the audio after classifying).
        if (this.bufferLen >= YAMNET_WINDOW) {
          const full = this.buffer;
          this.buffer = new Float32Array(YAMNET_WINDOW);
          this.bufferLen = 0;
          this.onChunk(full);
        }
      }
    }
    this.acc = acc;
    if (this.totalSamples >= this.capSamples && !this.stopped) {
      this.stop();
      this.onCap();
    }
  }

  // Live dB(A) from the analyser spectrum with A-weighting per bin.
  currentDba() {
    if (!this.analyser || this.stopped) return null;
    const bins = new Float32Array(this.analyser.frequencyBinCount);
    this.analyser.getFloatFrequencyData(bins);
    const binHz = this.ctx.sampleRate / this.analyser.fftSize;
    let power = 0;
    let n = 0;
    for (let i = 1; i < bins.length; i++) {
      const f = i * binHz;
      if (f > 12000) break; // skip ultra-high bins, they're mostly noise
      power += Math.pow(10, (bins[i] + aWeightDb(f)) / 10);
      n++;
    }
    if (n === 0) return null;
    return 10 * Math.log10(power / n) + CALIBRATION_OFFSET_DB; // ~dBFS + device offset
  }

  _meterTick() {
    if (this.stopped) return;
    const dba = this.currentDba();
    const elapsed = (performance.now() - this.startedAt) / 1000;
    this.onMeter({ dba: dba == null ? null : Math.round(dba * 10) / 10, elapsedSec: elapsed });
  }

  elapsedSec() {
    return this.stopped ? 0 : (performance.now() - this.startedAt) / 1000;
  }

  // The final PARTIAL chunk left in the engine when recording stopped (may be
  // null if too short to classify). The engine's copy is wiped immediately —
  // ownership of the tail moves to the caller, who analyzes then wipes it.
  takeTail() {
    if (this.bufferLen < MIN_WINDOW_SAMPLES) {
      this.buffer.fill(0);
      this.bufferLen = 0;
      return null;
    }
    const out = this.buffer.slice(0, this.bufferLen);
    this.buffer.fill(0);
    this.bufferLen = 0;
    return out;
  }

  stop() {
    if (this.stopped) return;
    this.stopped = true;
    clearInterval(this.timer);
    if (this.processor) this.processor.onaudioprocess = null;
    if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
    if (this.ctx && this.ctx.state !== 'closed') this.ctx.close();
    this.analyser = null;
  }
}