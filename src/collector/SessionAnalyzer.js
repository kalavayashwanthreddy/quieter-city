// Browser-side half of the REAL-TIME privacy pipeline (spec: dynamic chunk
// processing). The mic engine hands each completed ~1 s chunk to pushChunk()
// WHILE recording continues; a sequential worker runs YAMNet on the chunk
// (all on-device), decides ENVIRONMENTAL vs PRIVATE per the privacy filter,
// and discards speech/uncertain chunks immediately — the raw audio of every
// chunk is wiped right after its analysis, so raw audio exists only as the
// slice currently being classified (spec §2/§10/§14).
//
// Pure math lives in src/shared/sessionAnalysis.js (node-testable); this file
// adds only the YAMNet glue + a bounded pending queue. Per the spec's
// drop-preferring-to-retain rule, if the model falls behind, the OLDEST
// unprocessed chunk is dropped (wiped) rather than letting raw audio pile up.
import { YAMNET_SAMPLE_RATE, YAMNET_WINDOW } from '../shared/schema.js';
import { decideWindow, windowDba, summarizeWindows } from '../shared/sessionAnalysis.js';
import { classifyWaveform } from './YamnetAnalyzer.js';

const wait = (ms = 0) => new Promise((r) => setTimeout(r, ms));
const MAX_PENDING = 2; // bounded queue — never retain more than this much audio

/**
 * Consumes the live chunk stream and accumulates per-window verdicts.
 * @param opts { onWindow: (rec, summary) => void, classify?: (frame) => categories }
 */
export class RealTimeAnalyzer {
  constructor({ onWindow, classify = classifyWaveform } = {}) {
    this.onWindow = onWindow || (() => {});
    this.classify = classify;
    this.pending = []; // Float32Array chunks awaiting the model
    this.analyzed = []; // per-window verdict records (speech windows: verdict 'private', categories [])
    this.nextSec = 0;
    this.pumping = false;
    this.finished = false;
  }

  // Called by the engine the moment a chunk completes. Analysis runs in the
  // background while recording continues; nothing is retained beyond the
  // bounded pending queue.
  pushChunk(chunk) {
    if (this.finished) return;
    if (this.pending.length >= MAX_PENDING) {
      this.pending.shift().fill(0); // drop oldest = wipe, never retain raw audio
    }
    this.pending.push(chunk);
    this._pump();
  }

  async _pump() {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (this.pending.length) {
        const chunk = this.pending.shift();
        await this._analyzeChunk(chunk);
        chunk.fill(0); // delete this chunk's audio immediately after analysis
      }
    } finally {
      this.pumping = false;
    }
  }

  async _analyzeChunk(chunk) {
    // YAMNet expects exactly one model frame; short tails are padded with silence.
    const frame = new Float32Array(YAMNET_WINDOW);
    frame.set(chunk.subarray(0, Math.min(chunk.length, YAMNET_WINDOW)));
    const categories = this.classify(frame);
    const { rmsDb, dba } = windowDba(chunk, 0, chunk.length);
    const verdict = decideWindow(categories, rmsDb);
    const startSec = this.nextSec;
    const endSec = startSec + chunk.length / YAMNET_SAMPLE_RATE;
    this.nextSec = endSec;

    const rec = {
      startSec: Math.round(startSec * 100) / 100,
      endSec: Math.round(endSec * 100) / 100,
      verdict: verdict.verdict,
      reason: verdict.reason,
      dba,
      rmsDb,
      categories: verdict.verdict === 'environmental' ? categories : [], // speech never aggregated
    };
    this.analyzed.push(rec);
    this.onWindow(rec, this.summary());
    await wait(0); // yield so the meter/UI can paint
  }

  // Running summary over everything analyzed so far (metadata only).
  summary() {
    return summarizeWindows(this.analyzed);
  }

  // Drains any in-flight/pending analysis (e.g. the final partial tail chunk),
  // then returns the recording's aggregate. Metadata ONLY — no audio ever
  // leaves this class.
  async finish() {
    while (this.pumping) await wait(10);
    this.finished = true;
    return summarizeWindows(this.analyzed);
  }

  // Abort: wipe every chunk still waiting for the model and forget the session
  // (used when classification is impossible, e.g. the model failed to load).
  wipe() {
    this.finished = true;
    this.pending.forEach((c) => c.fill(0));
    this.pending = [];
    this.analyzed = [];
  }
}