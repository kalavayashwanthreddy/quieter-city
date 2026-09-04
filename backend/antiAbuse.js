// Anti-abuse checks (reward spec §5 — server-side, non-negotiable). These run
// BEFORE a reading is accepted, and a rejected reading is never inserted, so
// it earns nothing. None of these checks reference a reward account — they
// operate purely on the anonymous session_id + the coarse cell, keeping the
// anonymity boundary intact even in anti-abuse logic.
//
// The seed simulator rotates session ids per sample (it represents many
// anonymous citizens), so it is never rate-limited or movement-checked —
// exactly like a crowd of different people.
import { ANTI_ABUSE } from '../src/shared/schema.js';

// sessionId -> { ts, geohash, lat, lng } of the last ACCEPTED reading.
// In-memory is fine for the mock (a real deployment puts this in the DB).
const tracker = new Map();

export function resetAntiAbuse() {
  tracker.clear();
}

function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/**
 * @param sample the stripped, validated sample { sessionId, geohash, cellLat, cellLng, ts }
 * @returns { ok: true } to accept, or { ok: false, code, retryInMs?, speedMps? } to reject.
 */
export function checkSample(sample) {
  const { sessionId, geohash, ts, cellLat, cellLng } = sample;
  const prev = tracker.get(sessionId);

  if (prev) {
    const dt = ts - prev.ts;

    // §5 rate limit: same session writing to the same geohash more than once
    // per 8 s is rejected — a stationary citizen can contribute at most
    // ~1 accepted reading / 8 s, so spamming one spot doesn't farm points.
    if (dt >= 0 && dt < ANTI_ABUSE.rateLimitMs && prev.geohash === geohash) {
      return { ok: false, code: 'rate-limited', retryInMs: Math.ceil(ANTI_ABUSE.rateLimitMs - dt) };
    }

    // §5 movement sanity: consecutive geohashes imply a physically implausible
    // speed → reject. (cell centers, coarse — a 100 m blur flip across a cell
    // boundary stays well under the threshold; only teleports trip this.)
    if (dt > 0 && typeof cellLat === 'number' && typeof prev.lat === 'number') {
      const distM = haversineKm(prev.lat, prev.lng, cellLat, cellLng) * 1000;
      const speedMps = distM / (dt / 1000);
      if (speedMps > ANTI_ABUSE.maxSpeedMps) {
        return { ok: false, code: 'movement-suspicious', speedMps: Math.round(speedMps) };
      }
    }
  }

  tracker.set(sessionId, { ts, geohash, lat: cellLat, lng: cellLng });
  return { ok: true };
}