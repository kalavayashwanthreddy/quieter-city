// Framework-free verification of the pure logic modules:
//   - reward system (spec §4/§5/§6: base, streak-by-day cap, diversity bonus,
//     daily caps, reset)
//   - server-side anti-abuse (spec §5: rate limit, movement sanity)
//   - notification engine (spec §3: traffic + prediction, per-cell-hour throttle)
//   - local-day time-glitch fix
// Run with: npm run verify — exits non-zero on the first failing assertion.
import { computeReward, loadRewards, saveRewards, emptyRewards, localDayKey, yesterdayOf } from '../src/shared/rewards.js';
import { REWARDS, SPEECH_THRESHOLD, SPEECH_SINGLE_FLOOR } from '../src/shared/schema.js';
import { checkSample, resetAntiAbuse } from '../backend/antiAbuse.js';
import { prepareSample, createRateLimiter, adminGuard, MAX_TS_SKEW_MS } from '../backend/security.js';
import { sanitizeLabel, escapeHtml } from '../src/shared/privacy.js';
import { runNotificationCheck, resetNotifications } from '../backend/notifications.js';
import { getSessionId, shouldResetAlertsToday, markAlertsSeenToday } from '../src/collector/sessionAndAlerts.js';
import { planWindows, decideWindow, summarizeWindows, windowDba, MIN_WINDOW_SAMPLES } from '../src/shared/sessionAnalysis.js';
import { buildSessionSample } from '../src/collector/Uploader.js';
import { toFirestoreDoc } from '../src/collector/firebase.js';
import { YAMNET_SAMPLE_RATE, YAMNET_WINDOW } from '../src/shared/schema.js';
import {
  haversineMeters,
  sampleRoutePoints,
  scorePoint,
  scoreRoute,
  rankRoutes,
  DEFAULT_BASELINE_NOISE,
} from '../src/agent/Router.js';
import { sortByType } from '../src/shared/geocode.js';

let failures = 0;
function assert(cond, label) {
  if (cond) { console.log('  ✔', label); }
  else { failures++; console.error('  ✘ FAIL:', label); }
}

console.log('\n== Reward system (spec §4/§6) ==');
const D1 = '2026-09-04';
const D2 = '2026-09-05';
const D3 = '2026-09-07'; // D2 is skipped → missed day
const t0 = 1_700_000_000_000;

let s = emptyRewards(new Date('2026-09-04T12:00:00'));
assert(s.points === 0 && s.streakDays === 0 && s.distinctCellsToday.length === 0, 'empty rewards start at zero');

// Day 1, first reading, brand-new area → base 1 + streak 1 + diversity 2 = 4
let r1 = computeReward(s, { now: t0, dayKey: D1, cellPrefix4: 'tdr1' });
assert(r1.points === 4 && r1.base === 1 && r1.streakBonus === 1 && r1.diversity === 2,
  `day-1 first reading: +4 (1 base + 1 streak + 2 new area), got +${r1.points}`);
assert(r1.next.streakDays === 1 && r1.next.distinctCellsToday.includes('tdr1'), 'streakDays 1, cell recorded');

// Same day, same cell → base + streak only (no diversity repeat)
let r2 = computeReward(r1.next, { now: t0 + 60_000, dayKey: D1, cellPrefix4: 'tdr1' });
assert(r2.points === 2 && r2.diversity === 0, `same-day same-cell: +2, no repeat diversity (got +${r2.points})`);

// Same day, NEW cell → diversity again
let r3 = computeReward(r2.next, { now: t0 + 120_000, dayKey: D1, cellPrefix4: 'tf04' });
assert(r3.points === 4 && r3.diversity === 2 && r3.next.distinctCellsToday.length === 2, 'same-day new area: +2 diversity again');

// Next day (streak continues) → streak 2 → +2, and diversity cells wiped at midnight
let r4 = computeReward(r3.next, { now: t0 + 86_400_000, dayKey: D2, cellPrefix4: 'tdr1' });
assert(r4.next.streakDays === 2 && r4.streakBonus === 2 && r4.points === 5,
  `day-2 reading: streak 2 → +2 bonus, +5 total (got +${r4.points})`);
assert(r4.next.distinctCellsToday.length === 1, 'day rollover wiped yesterday\'s diversity cells');

// Missed day → streak resets to 1 (a fresh day), never a partial value
let r5 = computeReward(r4.next, { now: t0 + 3 * 86_400_000, dayKey: D3, cellPrefix4: 'tf04' });
assert(r5.next.streakDays === 1 && r5.streakBonus === 1 && r5.points === 4,
  `missed day → streak resets to 1, +4 total (got streak ${r5.next.streakDays})`);

// Streak bonus caps at +5 (day 6 of a streak still earns 5 bonus, not 6)
let capped = computeReward(
  { ...emptyRewards(new Date('2026-09-05T12:00:00')), streakDays: 5, lastDay: '2026-09-04', day: D1 },
  { now: t0, dayKey: D2, cellPrefix4: 'tdr1' },
);
assert(capped.streakBonus === REWARDS.streakBonusCap && capped.points === 1 + 5 + 2,
  `streak bonus capped at +${REWARDS.streakBonusCap} (day 6 → 1+5+2=8, got +${capped.points})`);

// Diversity cap: ≥10 cells today → bonus silently capped, base+streak still paid
let full = {
  ...emptyRewards(new Date('2026-09-04T12:00:00')),
  streakDays: 2,
  lastDay: D1,
  day: D1,
  distinctCellsToday: ['aaaa', 'bbbb', 'cccc', 'dddd', 'eeee', 'ffff', 'gggg', 'hhhh', 'iiii', 'jjjj'],
};
let cappedDiversity = computeReward(full, { now: t0, dayKey: D1, cellPrefix4: 'kkkk' });
assert(cappedDiversity.diversity === 0 && cappedDiversity.points === 1 + 2,
  'diversity cap at 10/day: bonus silently capped, reading still paid');

// yesterdayOf correctness (incl. month/year boundaries)
assert(yesterdayOf('2026-09-04') === '2026-09-03', 'yesterdayOf plain');
assert(yesterdayOf('2026-03-01') === '2026-02-28', 'yesterdayOf month boundary');
assert(yesterdayOf('2026-01-01') === '2025-12-31', 'yesterdayOf year boundary');

console.log('\n== Persistence (spec §2 web fallback: local, session-scoped) ==');
const mem = new Map();
const storage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, v) };
saveRewards(r4.next, storage);
const loaded = loadRewards(storage);
assert(JSON.stringify(loaded) === JSON.stringify(r4.next), 'save → load round-trip is lossless');
const bad = loadRewards({ getItem: () => '{not json', setItem: () => {} });
assert(bad.points === 0 && bad.streakDays === 0, 'corrupted storage degrades to empty rewards');
// migration from the old (pre-spec) shape
const oldShape = loadRewards({
  getItem: () => JSON.stringify({ points: 123, streak: 4, today: 7, day: 'x', lastTs: 1_700_000_000_000 }),
  setItem: () => {},
});
assert(oldShape.points === 123 && oldShape.lifetime === 123 && oldShape.streakDays === 0,
  'old reward shape migrates: points kept, streak bookkeeping restarts');

console.log('\n== Server-side anti-abuse (spec §5) ==');
resetAntiAbuse();
const c1 = { sessionId: 'ses-1', geohash: 'tdr1vf5', cellLat: 12.9, cellLng: 77.6, ts: 1000 };
assert(checkSample(c1).ok === true, 'first reading accepted');
assert(checkSample({ ...c1, ts: 4000 }).ok === false, 'same cell within 8 s → rate-limited');
const c2 = { sessionId: 'ses-1', geohash: 'tdr1vfq', cellLat: 12.901, cellLng: 77.601, ts: 4000 };
assert(checkSample(c2).ok === true, 'different cell within 8 s → OK (walking)');
const rateRetry = checkSample({ sessionId: 'ses-1', geohash: 'tdr1vf5', cellLat: 12.9, cellLng: 77.6, ts: 10_000 });
assert(rateRetry.ok === true, 'same cell after 8 s → accepted again');
// teleport: ~150 km in 3 s
resetAntiAbuse();
checkSample({ sessionId: 'ses-2', geohash: 'tdr1vf5', cellLat: 12.9, cellLng: 77.6, ts: 1000 });
const teleport = checkSample({ sessionId: 'ses-2', geohash: 'whvth0b', cellLat: 13.5, cellLng: 78.5, ts: 4000 });
assert(teleport.ok === false && teleport.code === 'movement-suspicious', 'implausible movement → rejected');
// blur-induced cell flips (≤ ~220 m in 3 s) must NOT trip movement
resetAntiAbuse();
checkSample({ sessionId: 'ses-3', geohash: 'tdr1vf5', cellLat: 12.9, cellLng: 77.6, ts: 1000 });
assert(checkSample({ sessionId: 'ses-3', geohash: 'tdr1vfq', cellLat: 12.9017, cellLng: 77.6018, ts: 4000 }).ok === true,
  'small blur flip across a cell boundary stays accepted');

console.log('\n== Notification engine (spec §3) ==');
resetNotifications();
const sub = { subscriberId: 'sub-test', watchedGeohash5: 'tdr1v', radiusCells: 1 };
const fakeState = () => ({
  cells: [{ cell: 'tdr1vf5', avgDba: 80, dominantClass: 'Construction', lat: 12.9, lng: 77.6 }],
  predictions: [{ cell: 'tdr1vf5', forecastDba: 78, hour: 17, hotspot: true }],
  subscriptions: [sub],
  notifications: [],
});
const st1 = fakeState();
const created1 = runNotificationCheck(st1);
assert(created1 === 2 && st1.notifications.length === 2, `watched loud cell → traffic + prediction notifications (got ${created1})`);
const traffic = st1.notifications.find((n) => n.type === 'traffic');
assert(traffic && traffic.message.includes('80 dB') && traffic.solution.type === 'route' && traffic.solution.from && traffic.solution.to,
  'traffic alert message + bypass-route solution payload');
const pred = st1.notifications.find((n) => n.type === 'prediction');
assert(pred && pred.solution.type === 'window' && pred.solution.before != null && pred.solution.after != null,
  'prediction alert + suggested better times');
// throttle: same hour → nothing new
const created2 = runNotificationCheck(fakeState());
assert(created2 === 0, 'per-cell-per-hour throttle: no duplicate in the same hour');
// a subscriber far away hears nothing
const farAway = fakeState();
farAway.subscriptions = [{ ...sub, watchedGeohash5: 'tf04r' }];
assert(runNotificationCheck(farAway) === 0, 'subscriber outside the noisy area gets nothing');

console.log('\n== Privacy-first audio pipeline (windowed YAMNet + discard) ==');
// window planning: a 10 s recording → 10 full windows + tail, and 0 for silence
const p10 = planWindows(10 * YAMNET_SAMPLE_RATE);
assert(p10.length >= 10 && p10[0].endSec >= 0.9, `10 s recording → ≥10 analysis windows (got ${p10.length})`);
assert(planWindows(1000).length === 0, 'sub-window recording (< MIN_WINDOW_SAMPLES) yields no windows');
// real-time cadence: the engine delivers completed one-YAMNet-frame chunks WHILE
// recording, plus the final partial tail at STOP — exactly what planWindows
// covers, so the real-time chunk boundaries match the batch window plan
// one-for-one (identical per-chunk aggregation math).
const pcmLen = 10 * YAMNET_SAMPLE_RATE;
const rtChunks = [];
let off = 0;
while (off + YAMNET_WINDOW <= pcmLen) {
  rtChunks.push({ startSec: off / YAMNET_SAMPLE_RATE, endSec: (off + YAMNET_WINDOW) / YAMNET_SAMPLE_RATE });
  off += YAMNET_WINDOW;
}
const tailLen = pcmLen - off;
if (tailLen >= MIN_WINDOW_SAMPLES) {
  rtChunks.push({ startSec: off / YAMNET_SAMPLE_RATE, endSec: pcmLen / YAMNET_SAMPLE_RATE }); // engine.takeTail()
}
assert(rtChunks.length === p10.length, `real-time chunks (full + tail) match batch windows in count (${rtChunks.length} vs ${p10.length})`);
assert(
  rtChunks[0].startSec === p10[0].startSec &&
  rtChunks[rtChunks.length - 1].endSec === p10[p10.length - 1].endSec,
  'real-time chunk offsets match the batch window plan exactly',
);

// verdicts (doc §8/§17): speech evidence → PRIVATE, uncertainty → PRIVATE
const speechWin = [{ categoryName: 'Speech', score: 0.62 }, { categoryName: 'Traffic noise, roadway noise', score: 0.2 }];
assert(decideWindow(speechWin, -30).verdict === 'private', 'clear speech (single class ≥ floor) → PRIVATE');
const spreadWin = [{ categoryName: 'Conversation', score: 0.25 }, { categoryName: 'Speech', score: 0.2 }, { categoryName: 'Narration, monologue', score: 0.12 }];
assert(decideWindow(spreadWin, -28).verdict === 'private', 'speech spread over classes (sum ≥ threshold) → PRIVATE');
const trafficWin = [{ categoryName: 'Traffic noise, roadway noise', score: 0.81 }, { categoryName: 'Speech', score: 0.08 }];
assert(decideWindow(trafficWin, -22).verdict === 'environmental', 'confident non-speech (traffic 0.81) → environmental');
const quietWin = [{ categoryName: 'Inside, small room', score: 0.12 }, { categoryName: 'Speech', score: 0.1 }];
assert(decideWindow(quietWin, -65).verdict === 'environmental', 'genuine silence → safe quiet data (even with faint speech scores)');
const ambiguousWin = [{ categoryName: 'Music', score: 0.2 }, { categoryName: 'Speech', score: 0.14 }];
assert(decideWindow(ambiguousWin, -30).verdict === 'private', 'low-confidence/ambiguous window → PRIVATE (§17 conservative)');

// dB helper sanity
const tone = new Float32Array(YAMNET_WINDOW).fill(0.1);
const d = windowDba(tone, 0, YAMNET_WINDOW);
assert(Math.abs(d.rmsDb - (-20)) < 0.1, `constant 0.1 amplitude → rmsDb ≈ −20 (got ${d.rmsDb})`);

// aggregation: speech windows never appear in the output (segments or classes)
const summary = summarizeWindows([
  { startSec: 0, endSec: 0.975, verdict: 'environmental', reason: 'sound', dba: 70, rmsDb: -12, categories: [{ categoryName: 'Jackhammer', score: 0.9 }] },
  { startSec: 0.975, endSec: 1.95, verdict: 'environmental', reason: 'sound', dba: 60, rmsDb: -22, categories: [{ categoryName: 'Vehicle horn, car horn, honking', score: 0.7 }, { categoryName: 'Speech', score: 0.05 }] },
  { startSec: 1.95, endSec: 2.925, verdict: 'private', reason: 'speech', dba: 55, rmsDb: -27, categories: [] },
]);
assert(summary.windowCount === 3 && summary.speechWindowCount === 1 && summary.safeSec === 1.95 && Math.abs(summary.speechSec - 0.975) < 0.01,
  'summary counts: 3 windows, 1 private, 1.95 s safe');
assert(summary.segments.length === 2, 'segments contain ONLY environmental windows');
const segNames = summary.segments.map((s) => s.soundType);
assert(!segNames.some((n) => /speech|conversation/i.test(n)), 'no speech class leaks into segments');
assert(Math.abs(summary.aggregate.dba - ((Math.log10((Math.pow(10, 7) + Math.pow(10, 6)) / 2) * 10))) < 0.6, 'aggregate dba is an energy average (70 & 60 → ~67)');
assert(summary.aggregate.dominantType === 'construction', 'dominant type resolved from aggregated classes');
const allSpeech = summarizeWindows([
  { startSec: 0, endSec: 0.975, verdict: 'private', reason: 'speech', dba: 55, rmsDb: -27, categories: [] },
]);
assert(allSpeech.aggregate === null && allSpeech.safeSec === 0, 'all-speech recording → no aggregate, nothing uploadable');

console.log('\n== Session sample doc (metadata-only, speech-free) ==');
const sessionSummary = summarizeWindows([
  { startSec: 0, endSec: 0.975, verdict: 'environmental', reason: 'sound', dba: 68, rmsDb: -14, categories: [{ categoryName: 'Jackhammer', score: 0.9 }] },
  { startSec: 0.975, endSec: 1.95, verdict: 'private', reason: 'speech', dba: 60, rmsDb: -20, categories: [] },
]);
const sessionSample = buildSessionSample({
  location: { lat: 12.972442, lng: 77.580643 },
  sessionId: 'day-abc',
  summary: sessionSummary,
});
assert(sessionSample.geohash && sessionSample.geohash.length === 7, 'sample carries only a blurred geohash-7 cell');
assert(typeof sessionSample.dba === 'number' && Math.abs(sessionSample.safeSec - 0.975) < 0.02 && Math.abs(sessionSample.speechSec - 0.975) < 0.02,
  'aggregate dba + duration/safe/speech seconds present');
assert(sessionSample.segments.length === 1, 'segments exclude the speech window');
const doc = toFirestoreDoc(sessionSample, 'anon-uid-1');
const flat = JSON.stringify(doc);
for (const banned of ['audio', 'waveform', 'pcm', 'deviceId']) {
  assert(!flat.toLowerCase().includes(banned), `Firestore doc carries no ${banned}`);
}
// exact raw lat/lng keys are banned; cellLat/cellLng (cell CENTER) are allowed
assert(!/"lat"\s*:/.test(flat) && !/"lng"\s*:/.test(flat), 'Firestore doc carries no raw lat/lng (cell center is allowed)');
assert(doc.segments.length === 1 && doc.durationSec === 1.95, 'Firestore doc mirrors session metadata (single server timestamp)');
assert(!JSON.stringify(doc.segments).toLowerCase().includes('speech'), 'Firestore segments are speech-free');

console.log('\n== Time glitch fix (local calendar day) ==');
assert(localDayKey(new Date(2026, 0, 5, 0, 30)) === '2026-01-05', 'localDayKey(00:30 local Jan 5) = 2026-01-05');
assert(localDayKey(new Date(2026, 11, 31, 12, 0)) === '2026-12-31', 'localDayKey month/day padding');
assert(localDayKey(new Date(2026, 0, 5, 23, 59)) === '2026-01-05', 'localDayKey 23:59 local same day');

const mem2 = new Map();
const ls2 = { getItem: (k) => (mem2.has(k) ? mem2.get(k) : null), setItem: (k, v) => mem2.set(k, v) };
globalThis.localStorage = ls2;
mem2.set('qc-session-date', localDayKey());
mem2.set('qc-session-id', 'fixed-id');
assert(getSessionId() === 'fixed-id', 'same LOCAL day → same session id');
mem2.set('qc-session-date', '2020-01-01');
assert(getSessionId() !== 'fixed-id' && getSessionId().length > 10, 'stale day → fresh session id');
mem2.delete('qc-alerts-last-reset');
assert(shouldResetAlertsToday() === true, 'no stored reset → reset needed');
markAlertsSeenToday();
assert(shouldResetAlertsToday() === false, 'after markAlertsSeenToday → no reset');

console.log('\n== Location-name routing (geocode spec) ==');
// Narrow place types must rank before broad admin areas so routing resolves
// to a precise point, not a suburb that can be km wide.
const mixedTypes = [
  { name: 'Suburb', type: 'suburb' },
  { name: 'Metro', type: 'railway' },
  { name: 'Park', type: 'leisure' },
  { name: 'Cafe', type: 'amenity' },
  { name: 'Tower', type: 'building' },
  { name: 'District', type: 'city' },
];
const sorted = sortByType(mixedTypes);
const idxOf = (t) => sorted.findIndex((s) => s.type === t);
assert(sorted[0].type === 'building', `building-level match ranks first (got ${sorted.map((s) => s.type).join(',')})`);
assert(idxOf('amenity') < idxOf('leisure') && idxOf('railway') < idxOf('leisure'),
  'narrow types (amenity/railway) beat leisure');
assert(sorted.at(-1).type === 'city' && sorted.at(-2).type === 'suburb',
  `broad admin areas rank last (got ${sorted.map((s) => s.type).join(',')})`);
// unknown types (no rank) fall between narrow and admin, and the sort is stable
const stable = sortByType([{ name: 'A', type: 'suburb' }, { name: 'B', type: 'suburb' }]);
assert(stable[0].name === 'A' && stable[1].name === 'B', 'equal-rank types keep input order (stable sort)');

console.log('\n== Quiet route navigation (road-graph scoring spec) ==');
// Baseline fallback: a point with no readings within 100 m scores 55 dB —
// unmeasured stretches are neutral, never "quiet because nobody measured".
const farPoint = scorePoint(12.99, 77.99, [{ lat: 12.971, lng: 77.594, avgDba: 80 }]);
assert(farPoint.dba === DEFAULT_BASELINE_NOISE && farPoint.known === false, 'unknown area → baseline 55 dB');

// Inverse-distance weighting: on-reading point scores the reading; a point
// midway between a loud and a quiet reading lands between them (~60).
const heat = [
  { lat: 12.971, lng: 77.594, avgDba: 80 },
  { lat: 12.971, lng: 77.5942, avgDba: 40 }, // ~22 m east
];
const onLoud = scorePoint(12.971, 77.594, heat);
const mid = scorePoint(12.971, 77.5941, heat);
// the on-point reading dominates; the quiet reading ~22 m away still pulls it
// down a little — that is the spec's inverse-distance behaviour
assert(onLoud.dba > 75 && onLoud.dba < 80, `point on a loud reading → ~78 dB (got ${onLoud.dba})`);
assert(mid.dba > 40 && mid.dba < 80 && Math.abs(mid.dba - 60) < 6,
  `inverse-distance weighting: midpoint ≈ 60 dB (got ${mid.dba})`);

// Sampling: a ~327 m straight polyline sampled every 75 m → ~5 points, start included.
const line = [];
for (let i = 0; i <= 30; i++) line.push([77.59 + i * 0.0001, 12.971]); // [lng, lat]
const samples = sampleRoutePoints(line);
assert(samples.length >= 4 && samples.length <= 6, `75 m sampling over ~327 m → ~5 points (got ${samples.length})`);
assert(samples[0][0] === 77.59 && samples[0][1] === 12.971, 'first sample is the route start');
assert(haversineMeters(12.971, 77.59, 12.971, 77.594) > 400 && haversineMeters(12.971, 77.59, 12.971, 77.594) < 500,
  'haversineMeters sanity (~435 m for 0.004° lng)');

// Whole-route scoring: unknown samples contribute the 55 dB baseline to the
// average (never "free quiet"), known samples blend in, knownPct reflects
// partial coverage. Route: 55 (unmeasured) + 40 (quiet reading) + 55 → 50.
const scored = scoreRoute([[77.59, 12.971], [77.595, 12.971], [77.61, 12.971]], heat);
assert(Math.abs(scored.avgDba - 50) < 0.5,
  `baseline joins the average: (55 + 40 + 55)/3 = 50 (got ${scored.avgDba})`);
assert(scored.knownPct === 33, `knownPct reflects partial coverage (got ${scored.knownPct}%)`);
const bare = scoreRoute([[77.7, 12.99], [77.71, 12.99], [77.72, 12.99]], heat);
assert(bare.avgDba === DEFAULT_BASELINE_NOISE && bare.knownPct === 0,
  'fully unmeasured route scores the 55 dB baseline — not 0, so no route looks artificially quiet');

// Guardrail: a 2.5× longer "quiet" route is rejected; the quietest
// ACCEPTABLE route (≤30% longer than fastest) wins.
const rFast = { durationSec: 600, avgDba: 62 };
const rQuietButLong = { durationSec: 1500, avgDba: 42 };
const rBalanced = { durationSec: 720, avgDba: 50 };
const ranked = rankRoutes([rFast, rQuietButLong, rBalanced]);
const byDur = Object.fromEntries(ranked.map((r) => [r.durationSec, r]));
assert(byDur[600].fastest === true && byDur[600].quiet === false, 'fastest route flagged fastest, not quietest');
assert(byDur[1500].detourTooLong === true, '2.5× longer route rejected by the 30% guardrail');
assert(byDur[720].quiet === true, 'quietest acceptable route wins');

console.log('\n== Security hardening (validation, sanitization, rate limit, admin gate) ==');
// stored-label sanitizer: markup can never be stored
assert(sanitizeLabel('<img src=x onerror=alert(1)>') === 'img src=x onerror=alert(1)', 'sanitizeLabel strips angle brackets (no markup)');
assert(sanitizeLabel('Construction\u0000site\n noise') === 'Construction site noise', 'sanitizeLabel strips control chars + collapses whitespace');
assert(sanitizeLabel('a'.repeat(500)).length === 120, 'sanitizeLabel caps length');
assert(sanitizeLabel('Traffic noise, roadway noise') === 'Traffic noise, roadway noise', 'sanitizeLabel keeps plain labels');
assert(escapeHtml('<b>&"\'</b>') === '&lt;b&gt;&amp;&quot;&#39;&lt;/b&gt;', 'escapeHtml neutralizes HTML special chars');

// payload validation: clock-skewed ts is rejected (the anti-abuse bypass)
const NOW = 1_700_000_000_000;
const goodBody = {
  sessionId: 'ses-sec', geohash: 'tdr1vf5', cellLat: 12.9, cellLng: 77.6, dba: 65,
  ts: NOW, dominantClass: 'Jackhammer', dominantType: 'construction',
  topClasses: [{ name: 'Jackhammer', score: 0.9 }],
};
const okPrep = prepareSample(goodBody, { now: NOW });
assert(okPrep.ok === true && okPrep.sample.ts === NOW && okPrep.sample.dominantClass === 'Jackhammer', 'valid sample passes prepareSample');
assert(prepareSample({ ...goodBody, ts: 0 }, { now: NOW }).ok === false, 'ts=0 (past) → invalid-ts, closes the rate-limit bypass');
assert(prepareSample({ ...goodBody, ts: NOW + MAX_TS_SKEW_MS + 1000 }, { now: NOW }).ok === false, 'ts far in the future → invalid-ts');
assert(prepareSample({ ...goodBody, ts: 'garbage' }, { now: NOW }).ok === false, 'non-numeric ts → invalid-ts');
assert(prepareSample({ ...goodBody, ts: undefined }, { now: NOW }).sample.ts === NOW, 'missing ts → server-stamped time');

// markup in free-text fields is neutralized before storage
const xssPrep = prepareSample({ ...goodBody, dominantClass: '<img src=x onerror=alert(1)>', topClasses: [{ name: '<script>', score: 2 }] }, { now: NOW });
assert(xssPrep.ok === true && !xssPrep.sample.dominantClass.includes('<'), 'stored dominantClass is markup-free');
assert(xssPrep.sample.topClasses[0].name === 'script' && xssPrep.sample.topClasses[0].score === 1, 'topClasses names sanitized + scores clamped');

// geometry/type validation
assert(prepareSample({ ...goodBody, cellLat: '12.9' }, { now: NOW }).ok === false, 'non-numeric cellLat → invalid-cell');
assert(prepareSample({ ...goodBody, cellLat: 500 }, { now: NOW }).ok === false, 'out-of-range cellLat → invalid-cell');
assert(prepareSample({ ...goodBody, dba: Number.NaN }, { now: NOW }).ok === false, 'NaN dba → invalid-dba');
assert(prepareSample({ ...goodBody, sessionId: 'x'.repeat(200) }, { now: NOW }).ok === false, 'oversized sessionId → invalid-session');
assert(prepareSample({ ...goodBody, geohash: 'not-a-cell' }, { now: NOW }).ok === false, 'bad geohash → invalid-geohash');

// per-IP rate limiter (injectable clock)
let t = 1000;
const limiter = createRateLimiter({ windowMs: 60_000, max: 2, nowFn: () => t });
const mkReq = () => ({ ip: '1.2.3.4', socket: { remoteAddress: '1.2.3.4' } });
let passed = 0;
let blocked = null;
const okNext = () => { passed++; };
limiter(mkReq(), { status: () => ({ json: (b) => { blocked = b; } }) }, okNext);
limiter(mkReq(), { status: () => ({ json: (b) => { blocked = b; } }) }, okNext);
limiter(mkReq(), { status: () => ({ json: (b) => { blocked = b; } }) }, okNext);
assert(passed === 2 && blocked && blocked.error === 'ip-rate-limited', 'rate limiter: 2 allowed, 3rd blocked');
t = 1000 + 61_000;
limiter(mkReq(), { status: () => ({ json: (b) => { blocked = b; } }) }, okNext);
assert(passed === 3, 'rate limiter: window slides → allowed again');

// admin token guard
let called = false;
adminGuard({ expectedToken: 'secret' })(mkReq(), { status: (code) => ({ json: (b) => { called = true; assert(code === 401 && b.error === 'unauthorized', 'admin guard rejects missing token with 401'); } }) }, () => {});
assert(called === true, 'admin guard without token → 401');
let nextCount = 0;
const spy = { status: () => ({ json: () => {} }) };
adminGuard({ expectedToken: 'secret' })({ get: () => 'secret' }, spy, () => { nextCount++; });
assert(nextCount === 1, 'admin guard with correct token → next()');
adminGuard({ expectedToken: 'secret' })({ get: () => 'wrong' }, spy, () => { nextCount++; });
assert(nextCount === 1, 'admin guard with wrong token → rejected (next not called)');

console.log('\n' + (failures ? `✘ ${failures} assertion(s) FAILED` : '✔ all assertions passed'));
process.exit(failures ? 1 : 0);