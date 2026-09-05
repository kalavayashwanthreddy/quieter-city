// Express API for FreeBuff. STORAGE_BACKEND=firestore uses Firebase Admin
// and Firestore; local development retains the JSON-file fallback.
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIG } from './config.js';
import {
  ensureLoaded,
  getState,
  addSample,
  reset as resetStore,
  saveDerived,
} from './store.js';
import { aggregateCells } from './aggregate.js';
import { computePredictions } from './predict.js';
import { runAlertCheck } from './alerts.js';
import { runNotificationCheck } from './notifications.js';
import { checkSample } from './antiAbuse.js';
import { Simulator } from './seedSimulator.js';
import { containsPii } from '../src/shared/privacy.js';
import { isValidCell } from '../src/shared/geohash.js';
import { NOTIFICATIONS } from '../src/shared/schema.js';
import { adminGuard, createRateLimiter, prepareSample } from './security.js';
import { derivePseudonym, verifyFirebaseToken } from './auth.js';
import { computeReward, emptyRewards, localDayKey } from '../src/shared/rewards.js';

const app = express();
const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST_DIR = path.join(PROJECT_ROOT, 'dist');
app.disable('x-powered-by');
app.use(express.json({ limit: '100kb' }));

app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('X-Frame-Options', 'DENY');
  res.set('Referrer-Policy', 'no-referrer');
  res.set('X-XSS-Protection', '1; mode=block');
  res.set('Cross-Origin-Opener-Policy', 'same-origin');
  res.set('Permissions-Policy', 'geolocation=(self), microphone=(self)');
  if (req.path.startsWith('/api/')) res.set('Cache-Control', 'no-store');
  next();
});

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && CONFIG.allowedOrigins.includes(origin)) {
    res.set('Access-Control-Allow-Origin', origin);
    res.set('Vary', 'Origin');
    res.set('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-admin-token');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

const adminOnly = adminGuard({ expectedToken: CONFIG.adminToken });
const limitSamples = createRateLimiter(CONFIG.rateLimit.samples);
const limitSubscriptions = createRateLimiter(CONFIG.rateLimit.subscriptions);
const uid = () => 's-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
let lastAlertCheck = 0;

async function requireCitizen(req, res, next) {
  if (!CONFIG.authRequired) return next();
  try {
    const token = String(req.get('Authorization') || '').replace(/^Bearer\s+/i, '');
    const payload = await verifyFirebaseToken(token);
    if (!payload) return res.status(401).json({ ok: false, error: 'unauthorized' });
    req.authPayload = payload;
    return next();
  } catch {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }
}

async function refreshDerived() {
  const state = await getState();
  state.cells = aggregateCells(state);
  state.predictions = computePredictions(state, state.cells);
  const now = Date.now();
  if (now - lastAlertCheck > 10000) {
    runAlertCheck(state, state.cells);
    runNotificationCheck(state);
    lastAlertCheck = now;
  }
  await saveDerived(state);
  return state;
}

app.get('/api/health', asyncHandler(async (req, res) => {
  const state = await getState();
  res.json({
    ok: true,
    storage: CONFIG.storageBackend,
    authRequired: CONFIG.authRequired,
    city: CONFIG.city,
    samples: state.samples.length,
    cells: state.cells.length,
    alerts: state.alerts.filter((a) => a.status === 'active').length,
    predictions: state.predictions.filter((p) => p.hotspot).length,
    sim: { running: simulator.running, posted: simulator.posted },
    time: Date.now(),
  });
}));

app.post('/api/samples', limitSamples, requireCitizen, asyncHandler(async (req, res) => {
  const body = req.body || {};
  const piiField = containsPii(body);
  if (piiField) return res.status(400).json({ ok: false, error: 'privacy-violation', field: piiField });

  const prepared = prepareSample(body);
  if (!prepared.ok) return res.status(400).json({ ok: false, error: prepared.error });

  const sample = {
    ...prepared.sample,
    id: uid(),
    source: body.source === 'simulator' ? 'simulator' : 'app',
    ...(req.authPayload ? { contributorPseudonym: derivePseudonym(req.authPayload, 'samples') } : {}),
  };
  const gate = checkSample(sample);
  if (!gate.ok) {
    const status = gate.code === 'rate-limited' ? 429 : 400;
    return res.status(status).json({ ok: false, error: gate.code, ...gate });
  }

  await addSample(sample);
  let reward = null;
  if (req.authPayload) {
    const state = await getState();
    const contributor = sample.contributorPseudonym;
    const previous = state.rewardsByContributor[contributor] || emptyRewards();
    const awarded = computeReward(previous, {
      now: Date.now(),
      dayKey: localDayKey(),
      cellPrefix4: sample.geohash.slice(0, 4),
    });
    state.rewardsByContributor[contributor] = awarded.next;
    reward = {
      points: awarded.points,
      base: awarded.base,
      streakBonus: awarded.streakBonus,
      diversity: awarded.diversity,
      state: awarded.next,
    };
  }
  await refreshDerived();
  res.json({ ok: true, id: sample.id, received: sample.ts, reward });
}));

app.get('/api/cells', asyncHandler(async (req, res) => res.json((await getState()).cells)));
app.get('/api/predictions', asyncHandler(async (req, res) => res.json((await getState()).predictions)));
app.get('/api/alerts', asyncHandler(async (req, res) => {
  const alerts = [...(await getState()).alerts].sort((a, b) => b.ts - a.ts).slice(0, 100);
  res.json(alerts);
}));

app.post('/api/alerts/:id/ack', adminOnly, asyncHandler(async (req, res) => {
  const state = await getState();
  const alert = state.alerts.find((a) => a.id === req.params.id);
  if (!alert) return res.status(404).json({ ok: false, error: 'not-found' });
  const ackedBy = (req.body && req.body.adminId) || 'unknown';
  if (typeof ackedBy !== 'string' || ackedBy.length > 64) {
    return res.status(400).json({ ok: false, error: 'invalid-admin' });
  }
  alert.status = 'acknowledged';
  alert.ackedBy = ackedBy;
  await saveDerived(state);
  res.json({ ok: true, alert });
}));

app.get('/api/admins', (req, res) => res.json(CONFIG.admins));

app.post('/api/subscriptions', limitSubscriptions, requireCitizen, asyncHandler(async (req, res) => {
  const state = await getState();
  const { subscriberId, watchedGeohash5, radiusCells } = req.body || {};
  if (typeof subscriberId !== 'string' || !subscriberId || subscriberId.length > 128) {
    return res.status(400).json({ ok: false, error: 'invalid-subscriber' });
  }
  if (!isValidCell(watchedGeohash5, 5)) {
    return res.status(400).json({ ok: false, error: 'invalid-geohash5' });
  }
  const radius = Math.min(2, Math.max(1, Number(radiusCells) || NOTIFICATIONS.defaultRadiusCells));
  const existing = state.subscriptions.find((s) => s.subscriberId === subscriberId);
  if (existing) {
    existing.watchedGeohash5 = watchedGeohash5;
    existing.radiusCells = radius;
    existing.updatedAt = Date.now();
  } else {
    state.subscriptions.push({
      id: 'sub-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6),
      subscriberId,
      watchedGeohash5,
      radiusCells: radius,
      createdAt: Date.now(),
    });
  }
  await saveDerived(state);
  res.json({ ok: true, watchedGeohash5, radiusCells: radius });
}));

app.delete('/api/subscriptions/:subscriberId', requireCitizen, asyncHandler(async (req, res) => {
  const state = await getState();
  const before = state.subscriptions.length;
  state.subscriptions = state.subscriptions.filter((s) => s.subscriberId !== req.params.subscriberId);
  if (state.subscriptions.length === before) return res.status(404).json({ ok: false, error: 'not-found' });
  await saveDerived(state);
  res.json({ ok: true });
}));

app.get('/api/notifications', requireCitizen, asyncHandler(async (req, res) => {
  const state = await getState();
  const sub = String(req.query.subscriberId || '');
  if (!sub) return res.json([]);
  const list = state.notifications.filter((n) => n.subscriberId === sub).sort((a, b) => b.ts - a.ts).slice(0, NOTIFICATIONS.keepPerSubscriber);
  res.json(list);
}));

app.post('/api/sim/start', adminOnly, (req, res) => {
  simulator.start();
  res.json({ ok: true, running: true });
});
app.post('/api/sim/stop', adminOnly, (req, res) => {
  simulator.stop();
  res.json({ ok: true, running: false });
});

app.post('/api/reset', adminOnly, asyncHandler(async (req, res) => {
  const wasRunning = simulator.running;
  simulator.stop();
  await resetStore();
  if (wasRunning) simulator.start();
  res.json({ ok: true });
}));

// Render runs one web service for both the Vite frontend and the API.
app.use(express.static(DIST_DIR, { index: 'index.html' }));
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  return res.sendFile(path.join(DIST_DIR, 'index.html'), (error) => {
    if (error) next(error);
  });
});

app.use((req, res) => res.status(404).json({ ok: false, error: 'not-found' }));
app.use((err, req, res, next) => {
  if (err && err.type === 'entity.parse.failed') return res.status(400).json({ ok: false, error: 'invalid-json' });
  if (err && err.type === 'entity.too.large') return res.status(413).json({ ok: false, error: 'payload-too-large' });
  console.error('api error', err);
  res.status(500).json({ ok: false, error: 'internal' });
});

let simulatorRefreshTimer = null;
let simulatorRefreshQueue = Promise.resolve();
function scheduleSimulatorRefresh() {
  clearTimeout(simulatorRefreshTimer);
  simulatorRefreshTimer = setTimeout(() => {
    simulatorRefreshQueue = simulatorRefreshQueue
      .catch(() => {})
      .then(() => refreshDerived())
      .catch((error) => console.error('simulator refresh error', error));
  }, 250);
}

const simulator = new Simulator((sample) => {
  addSample(sample)
    .then(scheduleSimulatorRefresh)
    .catch((error) => console.error('simulator storage error', error));
});

async function boot() {
  if (CONFIG.authRequired && (!CONFIG.authSecret || !CONFIG.adminToken)) {
    throw new Error('AUTH_SECRET and ADMIN_TOKEN are required when authentication is enabled.');
  }
  await ensureLoaded();
  const state = await getState();
  state.sim = { running: CONFIG.sim.enabled, posted: simulator.posted };
  await refreshDerived();
  if (CONFIG.sim.enabled) simulator.start();
  setInterval(() => { refreshDerived().catch((error) => console.error('refresh error', error)); }, 15000);
  app.listen(CONFIG.port, () => {
    console.log(`🔊 FreeBuff API on http://localhost:${CONFIG.port}`);
    console.log(`   Storage: ${CONFIG.storageBackend} · Firebase project: ${CONFIG.firebaseProjectId}`);
    console.log(`   Auth: ${CONFIG.authRequired ? 'Firebase ID token required' : 'local development bypass'}`);
    console.log(`   City: ${CONFIG.city.name} · simulator: ${CONFIG.sim.enabled ? 'ON' : 'OFF'}`);
  });
}

boot().catch((error) => {
  console.error('API failed to start', error);
  process.exitCode = 1;
});
