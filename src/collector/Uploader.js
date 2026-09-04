// Builds the metadata-only sample document and posts it.
// This is the ONLY thing that ever leaves the device — no audio, no PII.
// One recording session → ONE sample (the aggregate of its environmental
// windows). Speech/uncertain windows never appear anywhere in the doc.
import { api } from '../shared/backend.js';
import { anonymizeLocation } from '../shared/geohash.js';
import { newSessionId } from '../shared/privacy.js';

// sessionId: the collector's daily-rotating anonymous id (see
// sessionAndAlerts.js) so a day's samples can be loosely grouped; falls back
// to a fresh uuid per upload if not supplied.
// summary: the result of summarizeWindows() for one recording.
// location: the BLURRED ±100 m point ({lat, lng}) — only its cell is used.
export function buildSessionSample({ location, sessionId, summary }) {
  const loc = anonymizeLocation(location.lat, location.lng); // cell only!
  const agg = summary.aggregate;
  return {
    sessionId: sessionId ?? newSessionId(), // anonymous id — never device/user info
    geohash: loc.cell,
    cellLat: loc.cellLat, // cell CENTER — a 153m area, not the user
    cellLng: loc.cellLng,
    dba: agg ? agg.dba : null,
    rmsDb: agg ? agg.rmsDb : null,
    topClasses: agg ? agg.topClasses : [],
    dominantClass: agg ? agg.dominantClass : 'unknown',
    dominantType: agg ? agg.dominantType : 'other',
    speechScore: 0, // any speech evidence was discarded on-device pre-upload
    speechHandled: summary.speechWindowCount > 0 ? 'discarded' : 'none',
    // one-shot measurement meta: a single timestamp for the whole recording
    durationSec: summary.totalSec,
    safeSec: summary.safeSec,
    speechSec: summary.speechSec,
    segments: summary.segments, // environmental windows only (metadata, no audio)
    ts: Date.now(),
    source: 'app',
  };
}

export async function uploadSample(sample) {
  return api.postSample(sample);
}
