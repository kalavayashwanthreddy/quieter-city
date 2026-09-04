// Windowed privacy-filter math for the REAL-TIME chunk pipeline (spec:
// dynamic chunk processing). Pure + node-testable: no DOM, no YAMNet —
// classification results are passed in as plain {categoryName, score} lists.
//
// Pipeline per recording (privacy-first spec):
//   mic stream → ~1 s chunks → YAMNet each chunk WHILE recording →
//   speech/uncertain chunks marked PRIVATE and discarded immediately →
//   environmental chunks aggregated at STOP → every chunk wiped right after its
//   analysis → metadata-only upload. Each completed chunk is exactly one
//   YAMNet window, so this module's per-window math applies chunk-for-chunk.
import {
  YAMNET_SAMPLE_RATE,
  YAMNET_WINDOW,
  WINDOW_SECONDS,
  SPEECH_THRESHOLD,
  SPEECH_SINGLE_FLOOR,
  SILENCE_RMS_DB,
  CALIBRATION_OFFSET_DB,
  classifyNoise,
  isSpeechCategory,
  speechScoreOf,
  speechScoreSumOf,
} from './schema.js';
import { rmsOf, dbFromRms } from './audio.js';

// YAMNet needs at least this many samples to say anything useful about a tail.
export const MIN_WINDOW_SAMPLES = 1600;

// Windows are one YAMNet frame each (~0.975 s), taken consecutively so a whole
// recording is covered end to end. Returns [{ start, end, startSec, endSec }]
// as sample indices / offsets from the start of the recording.
export function planWindows(totalSamples) {
  const windows = [];
  let start = 0;
  while (start + MIN_WINDOW_SAMPLES <= totalSamples) {
    const end = Math.min(start + YAMNET_WINDOW, totalSamples);
    windows.push({
      start,
      end,
      startSec: +(start / YAMNET_SAMPLE_RATE).toFixed(2),
      endSec: +(end / YAMNET_SAMPLE_RATE).toFixed(2),
    });
    start = end;
  }
  return windows;
}

// Decide whether one analyzed window may be kept as ENVIRONMENTAL data or must
// be marked PRIVATE (spec §8/§17 — uncertainty resolves toward PRIVATE).
//   categories: top-k YAMNet classes [{categoryName, score}] (score desc)
//   rmsDb:      raw dBFS RMS of the window (pre-calibration)
// Returns { verdict: 'environmental'|'private', reason, dominant? }.
export function decideWindow(categories, rmsDb) {
  const speechSum = speechScoreSumOf(categories);
  const speechSingle = speechScoreOf(categories);

  // 1. Clear human-voice evidence → PRIVATE, never retained or uploaded.
  if (speechSingle >= SPEECH_SINGLE_FLOOR || speechSum >= SPEECH_THRESHOLD) {
    return { verdict: 'private', reason: 'speech' };
  }

  // 2. Genuine silence can't carry intelligible speech → safe "quiet" data.
  if (rmsDb < SILENCE_RMS_DB) {
    return { verdict: 'environmental', reason: 'quiet', dominant: null };
  }

  // 3. A confidently-identified NON-speech sound (traffic, jackhammer, music,
  //    birdsong…) → environmental.
  const top = categories && categories[0];
  if (top && !isSpeechCategory(top.categoryName) && top.score >= SPEECH_THRESHOLD) {
    return { verdict: 'environmental', reason: 'sound', dominant: top };
  }

  // 4. Everything else is ambiguous — YAMNet can't confidently rule out voice,
  //    so we sacrifice the window to protect privacy (§17).
  return { verdict: 'private', reason: 'uncertain', dominant: null };
}

// Per-window measurement taken straight from PCM (no analyser involved):
// approximate dB(A) = raw dBFS RMS + calibration offset (phones are uncalibrated).
export function windowDba(pcm, start, end) {
  const slice = pcm.subarray(start, end);
  const rms = rmsOf(slice);
  return { rmsDb: +dbFromRms(rms).toFixed(1), dba: +(dbFromRms(rms) + CALIBRATION_OFFSET_DB).toFixed(1) };
}

/**
 * Summarize one recording from its analyzed windows.
 * @param windows array of { startSec, endSec, verdict, reason, dba, rmsDb,
 *        categories (env windows only, kept for aggregation) }
 * @returns { totalSec, windowCount, speechSec, safeSec, speechWindowCount,
 *        segments: [{start,end,soundType,confidence,dba}] — env windows only,
 *        aggregate: {dba, rmsDb, topClasses, dominantClass, dominantType} | null }
 * Speech windows appear NOWHERE in the output (not even as segments) — the
 * aggregate is computed exclusively from environmental windows.
 */
export function summarizeWindows(analyzed) {
  const dur = (w) => w.endSec - w.startSec; // real per-window duration (tail may be short)
  const env = analyzed.filter((w) => w.verdict === 'environmental');
  const totalSec = analyzed.reduce((a, w) => a + dur(w), 0);
  const safeSec = env.reduce((a, w) => a + dur(w), 0);
  const speechSec = totalSec - safeSec;
  const speechWindowCount = analyzed.length - env.length;

  // Aggregate only environmental windows.
  let aggregate = null;
  if (env.length) {
    // Energy-average the dB so loud windows aren't diluted by quiet ones.
    const power = env.reduce((a, w) => a + Math.pow(10, w.dba / 10), 0);
    const dba = 10 * Math.log10(power / env.length);
    const rmsDb = env.reduce((a, w) => a + w.rmsDb, 0) / env.length;

    // Sum per-class scores across env windows → top 5 + dominant class.
    const sums = new Map();
    for (const w of env) {
      for (const c of w.categories) {
        sums.set(c.categoryName, (sums.get(c.categoryName) || 0) + c.score);
      }
    }
    const topClasses = [...sums.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([name, score]) => ({ name, score: Math.round(score * 1000) / 1000 }));
    const dominantClass = topClasses[0].name;
    const mapped = classifyNoise([{ categoryName: dominantClass, score: 1 }]);
    aggregate = {
      dba: Math.round(dba * 10) / 10,
      rmsDb: Math.round(rmsDb * 10) / 10,
      topClasses,
      dominantClass,
      dominantType: mapped ? mapped.type : 'other',
    };
  }

  // Coarse noise labels for display (doc uses Traffic / Construction / …).
  const noiseTypeOf = (name) => {
    const m = classifyNoise([{ categoryName: name, score: 1 }]);
    return m ? m.type : 'other';
  };
  if (aggregate) {
    const domType = noiseTypeOf(aggregate.dominantClass);
    aggregate.dominantType = domType || aggregate.dominantType;
  }

  const segments = env.map((w) => {
    const top = w.categories && w.categories[0];
    const mapped = classifyNoise(w.categories || []); // first non-speech rule match
    return {
      start: w.startSec,
      end: w.endSec,
      soundType: mapped ? mapped.name : top ? top.categoryName : 'Quiet',
      noiseType: mapped ? mapped.type : 'other',
      confidence: top ? Math.round(top.score * 1000) / 1000 : null,
      dba: w.dba,
    };
  });

  return {
    totalSec: Math.round(totalSec * 100) / 100,
    windowCount: analyzed.length,
    speechSec: Math.round(speechSec * 100) / 100,
    safeSec: Math.round(safeSec * 100) / 100,
    speechWindowCount,
    segments,
    aggregate,
  };
}
