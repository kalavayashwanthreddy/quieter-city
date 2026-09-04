// Security hardening for the mock backend.
//   - adminGuard: bearer-token gate for privileged endpoints (ack, sim, reset)
//   - createRateLimiter: per-IP sliding-window rate limit (samples, subscriptions)
//   - prepareSample: strict validation + sanitization of incoming samples so the
//     anti-abuse gate can't be clock-bypassed and stored labels can't smuggle
//     HTML/JS into map tooltips or alert messages (stored-XSS defense)
// All functions are pure-ish (nowFn injectable) so scripts/verify.mjs can test
// them without an HTTP server.
import { isValidCell } from '../src/shared/geohash.js';
import { sanitizeLabel, stripPii } from '../src/shared/privacy.js';

export const MAX_TS_SKEW_MS = 5 * 60 * 1000; // client clock within ±5 min of server
export const MAX_TOPMOST_CLASSES = 50;
export const MAX_SEGMENTS = 500;

export function isFiniteNumber(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

// ---- admin token guard -----------------------------------------------------
// Privileged endpoints (acknowledge alert, start/stop simulator, reset data)
// require `x-admin-token: <CONFIG.adminToken>`. The demo client ships the
// default token; production sets ADMIN_TOKEN env and the browser stores the
// real token under localStorage 'qc-admin-token'.
export function adminGuard({ expectedToken }) {
  return (req, res, next) => {
    const provided = req.get && req.get('x-admin-token');
    if (!expectedToken || !provided || provided !== expectedToken) {
      return res.status(401).json({ ok: false, error: 'unauthorized' });
    }
    next();
  };
}

// ---- per-IP sliding-window rate limiter -----------------------------------
export function createRateLimiter({ windowMs, max, nowFn = Date.now }) {
  const hits = new Map(); // ip -> { windowStart, count }
  return (req, res, next) => {
    const ip = (req.ip || (req.socket && req.socket.remoteAddress) || 'unknown').replace(/^::ffff:/, '');
    const now = nowFn();
    let rec = hits.get(ip);
    if (!rec || now - rec.windowStart > windowMs) {
      rec = { windowStart: now, count: 0 };
      hits.set(ip, rec);
    }
    rec.count += 1;
    if (rec.count > max) {
      return res.status(429).json({
        ok: false,
        error: 'ip-rate-limited',
        retryInMs: Math.max(0, rec.windowStart + windowMs - now),
      });
    }
    // bounded memory: drop expired entries when the table grows
    if (hits.size > 10_000) {
      for (const [k, r] of hits) if (now - r.windowStart > windowMs) hits.delete(k);
    }
    next();
  };
}

// ---- sample payload validation + sanitization ------------------------------
// Runs BEFORE stripPii/checkSample. Rejects malformed or clock-skewed payloads
// (the anti-abuse gate is only trustworthy when `ts` is a real recent time),
// caps array sizes, and sanitizes free-text labels so nothing markup-like is
// ever stored. Returns { ok:true, sample } or { ok:false, error }.
export function prepareSample(body, { now = Date.now() } = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, error: 'invalid-body' };
  }

  const { geohash, dba, sessionId, cellLat, cellLng } = body;
  if (!isValidCell(geohash)) return { ok: false, error: 'invalid-geohash' };
  if (!isFiniteNumber(dba) || dba < 0 || dba > 140) return { ok: false, error: 'invalid-dba' };
  if (typeof sessionId !== 'string' || !sessionId || sessionId.length > 64) {
    return { ok: false, error: 'invalid-session' };
  }
  if (
    !isFiniteNumber(cellLat) || cellLat < -90 || cellLat > 90 ||
    !isFiniteNumber(cellLng) || cellLng < -180 || cellLng > 180
  ) {
    return { ok: false, error: 'invalid-cell' };
  }

  // Timestamp must be a finite number close to server time. This closes the
  // clock-bypass: a client sending ts in the past (e.g. 0) can no longer make
  // dt negative to skip the 8 s rate limit and the movement check.
  let ts;
  if (body.ts == null) {
    ts = now;
  } else {
    if (!isFiniteNumber(body.ts) || Math.abs(body.ts - now) > MAX_TS_SKEW_MS) {
      return { ok: false, error: 'invalid-ts' };
    }
    ts = body.ts;
  }

  // Free-text labels: sanitized (no angle brackets / control chars) + capped.
  const topClasses = Array.isArray(body.topClasses)
    ? body.topClasses.slice(0, MAX_TOPMOST_CLASSES).map((c) => ({
        name: sanitizeLabel(c && c.name, 100) || 'unknown',
        score: isFiniteNumber(c && c.score) ? Math.min(1, Math.max(0, c.score)) : 0,
      }))
    : [];
  const segments = Array.isArray(body.segments)
    ? body.segments.slice(0, MAX_SEGMENTS).map((s) => ({
        ...(s && typeof s === 'object' ? s : {}),
        soundType: sanitizeLabel(s && s.soundType, 100) || 'other',
      }))
    : [];
  const durationSec = body.durationSec != null
    ? (isFiniteNumber(body.durationSec) && body.durationSec >= 0 ? Math.min(body.durationSec, 600) : null)
    : null;

  const sample = stripPii({
    ...body,
    geohash,
    cellLat,
    cellLng,
    dba,
    sessionId,
    ts,
    topClasses,
    segments,
    dominantClass: sanitizeLabel(body.dominantClass, 100) || 'other',
    dominantType: sanitizeLabel(body.dominantType, 50) || 'other',
    ...(durationSec != null ? { durationSec } : {}),
  });
  return { ok: true, sample };
}