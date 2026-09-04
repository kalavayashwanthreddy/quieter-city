// Pure audio math (no DOM / WebAudio) — node-testable.
import { CALIBRATION_OFFSET_DB } from './schema.js';

export function dbFromRms(rms) {
  return 20 * Math.log10(Math.max(rms, 1e-9));
}

export function rmsOf(buf) {
  if (!buf || !buf.length) return 0;
  let sum = 0;
  for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
  return Math.sqrt(sum / buf.length);
}

// Linear-interpolation resample to a target rate (e.g. 48k → 16k).
export function resampleTo(src, srcRate, targetRate) {
  if (srcRate === targetRate) return src;
  const ratio = srcRate / targetRate;
  const outLen = Math.floor(src.length / ratio);
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const pos = i * ratio;
    const i0 = Math.floor(pos);
    const i1 = Math.min(i0 + 1, src.length - 1);
    const frac = pos - i0;
    out[i] = src[i0] * (1 - frac) + src[i1] * frac;
  }
  return out;
}

// A-weighting (dB) for a frequency in Hz — standard IEC 61672 approximation.
export function aWeightDb(freq) {
  const f2 = freq * freq;
  const num = 12194 ** 2 * f2 * f2;
  const den = (f2 + 20.6 ** 2) * Math.sqrt((f2 + 107.7 ** 2) * (f2 + 737.9 ** 2)) * (f2 + 12194 ** 2);
  return 20 * Math.log10(num / den) + 2.0;
}

// True-RMS + A-weighting on raw PCM (float [-1, 1]) → approx dB(A).
// Applies A-weighting per FFT-free approach: uses RMS of the whole buffer as a
// broadband estimate, then compensates with a crude high-frequency roll-off is
// NOT done here — we use per-bin A-weighting in the browser (see collector/audioCapture.js).
export function dbAFromRms(rms) {
  return dbFromRms(rms) + CALIBRATION_OFFSET_DB;
}

export function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

export function gaussian() {
  // Box–Muller — used by the simulator for realistic dB jitter.
  let u = 0;
  let v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}