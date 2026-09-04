// Storage adapter for the application state. Local mode keeps the original
// JSON-file behavior; Firestore mode uses the same collection shapes so the
// aggregation, prediction, alert, and notification modules remain unchanged.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { CONFIG } from './config.js';
import { firestoreEnabled, getFirestoreDb } from './firebaseAdmin.js';

export const COLLECTIONS = {
  samples: 'noise_samples',
  cells: 'noise_cells',
  predictions: 'predictions',
  alerts: 'alerts',
  admins: 'admins',
  subscriptions: 'notification_subscriptions',
  notifications: 'notifications',
  rewards: 'rewards',
};

let state = null;
let writeTimer = null;
let dbPromise;

function freshState() {
  return {
    samples: [],
    cells: [],
    predictions: [],
    alerts: [],
    admins: CONFIG.admins,
    subscriptions: [],
    notifications: [],
    rewardsByContributor: {},
    sim: { running: false, posted: 0 },
  };
}

function localLoad() {
  try {
    const raw = fs.readFileSync(CONFIG.dataFile, 'utf8');
    state = JSON.parse(raw);
  } catch {
    state = freshState();
  }
  if (!Array.isArray(state.samples)) state.samples = [];
  if (!Array.isArray(state.cells)) state.cells = [];
  if (!Array.isArray(state.predictions)) state.predictions = [];
  if (!Array.isArray(state.alerts)) state.alerts = [];
  if (!Array.isArray(state.admins)) state.admins = CONFIG.admins;
  if (!Array.isArray(state.subscriptions)) state.subscriptions = [];
  if (!Array.isArray(state.notifications)) state.notifications = [];
  if (!state.rewardsByContributor || typeof state.rewardsByContributor !== 'object') state.rewardsByContributor = {};
  if (!state.sim) state.sim = { running: false, posted: 0 };
  return state;
}

async function db() {
  if (!dbPromise) dbPromise = getFirestoreDb();
  return dbPromise;
}

async function readCollection(name, limit = null) {
  let query = (await db()).collection(name);
  if (limit) query = query.limit(limit);
  const snapshot = await query.get();
  return snapshot.docs.map((doc) => ({ ...doc.data(), id: doc.id }));
}

async function loadCloud() {
  const next = freshState();
  next.samples = await readCollection(COLLECTIONS.samples, CONFIG.maxSamples);
  next.cells = await readCollection(COLLECTIONS.cells);
  next.predictions = await readCollection(COLLECTIONS.predictions);
  next.alerts = await readCollection(COLLECTIONS.alerts, 200);
  next.subscriptions = await readCollection(COLLECTIONS.subscriptions);
  next.notifications = await readCollection(COLLECTIONS.notifications, 5000);
  const rewards = await readCollection(COLLECTIONS.rewards);
  next.rewardsByContributor = Object.fromEntries(rewards.map((item) => [item.id, item]));
  state = next;
  return state;
}

export async function ensureLoaded() {
  if (state) return state;
  return firestoreEnabled() ? loadCloud() : localLoad();
}

export async function getState() {
  return ensureLoaded();
}

export async function saveNow() {
  if (firestoreEnabled()) return saveDerived(await ensureLoaded());
  fs.mkdirSync(path.dirname(CONFIG.dataFile), { recursive: true });
  fs.writeFileSync(CONFIG.dataFile, JSON.stringify(state, null, 2));
}

export function scheduleSave() {
  if (firestoreEnabled()) return;
  clearTimeout(writeTimer);
  writeTimer = setTimeout(() => { saveNow().catch((error) => console.error('store save failed', error)); }, 1500);
}

export async function addSample(sample) {
  const current = await ensureLoaded();
  // Browser submissions already receive an id in server.js, but the built-in
  // simulator calls this adapter directly. Always assign a unique id here as
  // a final safety boundary so simulator samples cannot overwrite one another
  // in Firestore under the literal key "undefined".
  const storedSample = sample.id ? sample : { ...sample, id: crypto.randomUUID() };
  if (firestoreEnabled()) {
    await (await db()).collection(COLLECTIONS.samples).doc(String(storedSample.id)).set({
      ...storedSample,
      createdAt: new Date(),
    });
  }
  current.samples.push(storedSample);
  if (current.samples.length > CONFIG.maxSamples) {
    current.samples.splice(0, current.samples.length - CONFIG.maxSamples);
  }
  scheduleSave();
  return storedSample;
}

async function clearCollection(name) {
  const snapshot = await (await db()).collection(name).get();
  const docs = snapshot.docs;
  for (let i = 0; i < docs.length; i += 450) {
    const batch = (await db()).batch();
    for (const doc of docs.slice(i, i + 450)) batch.delete(doc.ref);
    await batch.commit();
  }
}

export async function replaceCollection(name, documents) {
  if (!firestoreEnabled()) return;
  await clearCollection(name);
  for (let i = 0; i < documents.length; i += 450) {
    const batch = (await db()).batch();
    for (const item of documents.slice(i, i + 450)) {
      const id = item.id || item.cell || crypto.randomUUID();
      const { id: _ignored, ...payload } = item;
      batch.set((await db()).collection(name).doc(String(id)), payload);
    }
    await batch.commit();
  }
}

export async function saveDerived(current) {
  if (!firestoreEnabled()) {
    scheduleSave();
    return;
  }
  await replaceCollection(COLLECTIONS.cells, current.cells);
  await replaceCollection(COLLECTIONS.predictions, current.predictions);
  await replaceCollection(COLLECTIONS.alerts, current.alerts);
  await replaceCollection(COLLECTIONS.subscriptions, current.subscriptions);
  await replaceCollection(COLLECTIONS.notifications, current.notifications);
  await saveRewards(current.rewardsByContributor);
}

export async function loadRewards() {
  const current = await ensureLoaded();
  return current.rewardsByContributor || {};
}

export async function saveRewards(rewards) {
  if (!firestoreEnabled()) {
    const current = await ensureLoaded();
    current.rewardsByContributor = rewards || {};
    scheduleSave();
    return;
  }
  const entries = Object.entries(rewards || {});
  for (let i = 0; i < entries.length; i += 450) {
    const batch = (await db()).batch();
    for (const [key, value] of entries.slice(i, i + 450)) {
      batch.set((await db()).collection(COLLECTIONS.rewards).doc(key), value);
    }
    await batch.commit();
  }
}

export async function reset() {
  if (firestoreEnabled()) {
    for (const name of Object.values(COLLECTIONS)) await clearCollection(name);
  }
  state = freshState();
  if (!firestoreEnabled()) await saveNow();
  return state;
}
