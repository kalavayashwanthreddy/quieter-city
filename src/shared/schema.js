// Shared constants + schema for the whole platform.
// This file is the single source of truth for shapes, thresholds and labels,
// shared by the collector UI, the agent UI and the mock backend.

export const CELL_PRECISION = 7; // geohash precision 7 ≈ 153m × 153m cell ("~100m range")

export const YAMNET_SAMPLE_RATE = 16000; // YAMNet expects 16 kHz mono
export const YAMNET_WINDOW = 15600; // 0.975 s of 16 kHz samples — one YAMNet frame

// One-shot recording session (see real-time privacy-first audio pipeline):
//   mic stream → ~1 s chunks → YAMNet each chunk WHILE recording → drop
//   speech/uncertain chunks immediately as PRIVATE → aggregate the environmental
//   chunks at STOP → wipe every chunk right after its analysis → upload metadata
//   only (never the audio).
export const SESSION_MAX_SECONDS = 30; // hard cap on one recording (auto-stops)
export const METER_INTERVAL_MS = 300; // live dB meter cadence while recording

// Analysis windows are exactly one YAMNet frame each (~0.975 s).
export const WINDOW_SECONDS = YAMNET_WINDOW / YAMNET_SAMPLE_RATE;

// Official MediaPipe-hosted YAMNet model (same 521-class AudioSet model from google/yamnet).
export const YAMNET_MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/audio_classifier/yamnet/float32/1/yamnet.tflite';

// dB(A) references (approx — phone mics are uncalibrated)
export const QUIET_DBA = 50;
export const MODERATE_DBA = 60;
export const LOUD_DBA = 70; // alert threshold
export const DANGEROUS_DBA = 85;
export const CALIBRATION_OFFSET_DB = 82; // analyser dBFS → approx dB(A) offset

// Privacy filter (windowed YAMNet analysis, spec §8/§17): a ~1 s window is
// marked PRIVATE (discarded on-device, never retained or uploaded) when there
// is evidence of human voice — a single speech class ≥ SPEECH_SINGLE_FLOOR, or
// speech classes summing ≥ SPEECH_THRESHOLD (catches speech spread across
// several classes, e.g. Speech + Conversation). Genuine silence (rmsDb below
// SILENCE_RMS_DB) is kept as a safe quiet measurement. Any other window that
// isn't a confidently-identified non-speech sound is AMBIGUOUS → also PRIVATE:
// uncertainty is deliberately resolved toward PRIVATE to protect privacy (§17),
// even though it sacrifices some environmental data.
export const SPEECH_THRESHOLD = 0.4; // summed speech-class score → PRIVATE
export const SPEECH_SINGLE_FLOOR = 0.3; // single speech class ≥ this → PRIVATE

// A window quieter than this (raw dBFS RMS) can't carry intelligible speech →
// it's a safe, genuinely quiet measurement even if YAMNet can't name a sound.
export const SILENCE_RMS_DB = -55;

// Rewards (gamification) — matches the reward-system spec:
//  +1 per accepted reading
//  +1 bonus per consecutive calendar day with a reading, capped at +5
//    (day 5+ earns 1 base + 5 bonus = 6 per reading)
//  +2 diversity bonus the FIRST time in a day a reading lands in a new
//    geohash-4 cell (~20 km), capped at 10 bonuses per day
// Rejected readings (speech guard, rate limit, movement sanity) earn nothing.
export const REWARDS = {
  perSample: 1,
  streakBonusPerDay: 1,
  streakBonusCap: 5,
  diversityBonus: 2,
  diversityCapPerDay: 10,
  diversityCellPrecision: 4, // geohash-4 ≈ 20 km cell
};

// Anti-abuse checks (spec §5 — enforced server-side BEFORE a reading is
// accepted; the client only awards points after a confirmed accepted write).
export const ANTI_ABUSE = {
  rateLimitMs: 8 * 1000, // same session_id + same geohash: ≥8 s between writes
  maxSpeedMps: 100, // cell-to-cell speed above this is physically implausible
};

// Citizen-facing notifications (spec §3 — opt-in, never joined to readings/rewards).
export const NOTIFICATIONS = {
  pollMs: 15000, // how often the collector re-checks its notifications
  keepPerSubscriber: 50, // cap stored notifications per subscriber
  defaultRadiusCells: 1, // watched geohash-5 cell + 1 ring of neighbors (~5 km)
};

export const API_BASE = '/api';

// Admin-token plumbing for the privileged demo endpoints (acknowledge alert,
// simulator controls, reset). The demo default mirrors backend/config.js;
// when the server runs with a real ADMIN_TOKEN env secret, store that same
// value under localStorage 'qc-admin-token' and the agent UI uses it.
export const ADMIN_TOKEN_KEY = 'qc-admin-token';
export const DEFAULT_ADMIN_TOKEN = 'quieter-city-demo-admin';

// ---- YAMNet / AudioSet class mapping -------------------------------------

// Class-name keywords (case-insensitive substring) that indicate human voice /
// conversation. If any of these dominates, the audio may carry private speech.
export const SPEECH_KEYWORDS = [
  'speech', 'conversation', 'narration', 'babbling', 'shout', 'yell',
  'screaming', 'whispering', 'chatter', 'singing', 'child speech',
  'children shouting', 'laughter', 'crying', 'sigh', 'whoop', 'bellow',
];

// Non-speech noise-type buckets. First matching rule wins.
export const NOISE_TYPE_RULES = [
  {
    type: 'construction',
    keywords: ['jackhammer', 'drill', 'sawing', 'explosion', 'hammer',
      'power tool', 'machinery', 'machine', 'construction', 'chainsaw'],
  },
  {
    type: 'traffic',
    keywords: ['vehicle', 'car', 'truck', 'bus', 'motorcycle', 'engine',
      'traffic noise', 'roadway', 'horn', 'car alarm', 'siren', 'emergency',
      'train', 'rail', 'aircraft', 'helicopter', 'bicycle', 'scooter', 'auto'],
  },
  {
    type: 'music',
    keywords: ['music', 'musical instrument', 'guitar', 'piano', 'drum',
      'synthesizer', 'violin', 'trumpet', 'flute', 'bass guitar', 'singer',
      'opera', 'rock music', 'pop music', 'hip hop'],
  },
  {
    type: 'nature',
    keywords: ['bird', 'rain', 'water', 'wind', 'chirp', 'tweet', 'thunder',
      'stream', 'river', 'waves', 'frog', 'insect', 'cricket'],
  },
  { type: 'other', keywords: [] },
];

export function isSpeechCategory(name) {
  const n = name.toLowerCase();
  return SPEECH_KEYWORDS.some((k) => n.includes(k));
}

// categories: [{index, score, categoryName}] sorted desc by score (from MediaPipe).
// Returns { type, name, score } of the loudest NON-speech class, or null.
export function classifyNoise(categories) {
  if (!categories || !categories.length) return null;
  for (const c of categories) {
    if (isSpeechCategory(c.categoryName)) continue;
    const rule = NOISE_TYPE_RULES.find((r) =>
      r.keywords.some((k) => c.categoryName.toLowerCase().includes(k)),
    );
    return { type: rule ? rule.type : 'other', name: c.categoryName, score: c.score };
  }
  return null;
}

// Highest score among speech-ish classes (0..1).
export function speechScoreOf(categories) {
  if (!categories || !categories.length) return 0;
  let best = 0;
  for (const c of categories) {
    if (isSpeechCategory(c.categoryName) && c.score > best) best = c.score;
  }
  return best;
}

// Sum of scores across speech-ish classes — a more sensitive speech indicator
// than the max alone (conversation often spreads across several classes).
export function speechScoreSumOf(categories) {
  if (!categories || !categories.length) return 0;
  let sum = 0;
  for (const c of categories) {
    if (isSpeechCategory(c.categoryName)) sum += c.score;
  }
  return sum;
}

// ---- Sample document (what leaves the device — metadata ONLY) -------------
// {
//   id, sessionId, geohash, cellLat, cellLng, dba, rmsDb,
//   topClasses: [{name, score}], dominantClass, dominantType, speechScore,
//   speechHandled: 'none'|'discarded', ts, source,
//   durationSec, safeSec, speechSec, segments: [{start, end, soundType, confidence, dba}]
// }
// Recording sessions produce ONE such sample (aggregate over the environmental
// windows). Segments are the per-window metadata of the kept (non-speech)
// windows only — speech windows never appear anywhere.

export function levelLabel(dba) {
  if (dba >= DANGEROUS_DBA) return 'Dangerous';
  if (dba >= LOUD_DBA) return 'Loud';
  if (dba >= MODERATE_DBA) return 'Moderate';
  return 'Quiet';
}