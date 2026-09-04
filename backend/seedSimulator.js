// Seed simulator: a fleet of virtual citizens streaming realistic samples so the
// heatmap, predictions and alerts come alive instantly — no real phones needed.
import { pathToFileURL } from 'node:url';
import { CONFIG } from './config.js';
import { clamp, gaussian } from '../src/shared/audio.js';
import { anonymizeLocation } from '../src/shared/geohash.js';
import { newSessionId } from '../src/shared/privacy.js';

const CLASSES = {
  traffic: ['Traffic noise, roadway noise', 'Vehicle', 'Car', 'Engine', 'Horn, vehicle horn, car horn, honking'],
  construction: ['Jackhammer', 'Drill', 'Machinery', 'Explosion', 'Hammer'],
  market: ['Traffic noise, roadway noise', 'Crowd noise', 'Vehicle', 'Music'],
  quiet: ['Bird vocalization, bird call, bird song', 'Silence', 'Wind', 'Rain'],
};

export function makeCitizen(i) {
  const zone = CONFIG.sim.zones[i % CONFIG.sim.zones.length];
  const span = zone.radiusKm * 0.011; // approx deg
  return {
    id: 'citizen-' + (i + 1),
    zone,
    lat: zone.center[0] + (Math.random() - 0.5) * span,
    lng: zone.center[1] + (Math.random() - 0.5) * span,
    drift: 0.00015 + Math.random() * 0.00035,
    phase: Math.random() * Math.PI * 2,
  };
}

export function nextSample(citizen) {
  const z = citizen.zone;
  const span = z.radiusKm * 0.011;
  citizen.lat = clamp(citizen.lat + (Math.random() - 0.5) * citizen.drift, z.center[0] - span, z.center[0] + span);
  citizen.lng = clamp(citizen.lng + (Math.random() - 0.5) * citizen.drift, z.center[1] - span, z.center[1] + span);

  // dB: base + Gaussian jitter + slow sinusoidal drift (rush-hour-ish variation)
  const dba = clamp(z.base + gaussian() * z.variance + Math.sin(Date.now() / 90000 + citizen.phase) * 2.5, 25, 105);
  const classes = CLASSES[z.type];
  const name = classes[Math.floor(Math.random() * classes.length)];

  const loc = anonymizeLocation(citizen.lat, citizen.lng); // cell only — no exact coords
  return {
    sessionId: 'sim-' + citizen.id + '-' + Date.now().toString(36),
    geohash: loc.cell,
    cellLat: loc.cellLat,
    cellLng: loc.cellLng,
    dba: Math.round(dba * 10) / 10,
    rmsDb: Math.round((dba - 82) * 10) / 10, // consistent with CALIBRATION_OFFSET_DB
    topClasses: [{ name, score: Math.round((0.65 + Math.random() * 0.3) * 100) / 100 }],
    dominantClass: name,
    dominantType: z.type,
    speechScore: 0,
    speechHandled: 'none',
    ts: Date.now(),
    source: 'simulator',
  };
}

export class Simulator {
  constructor(post) {
    this.post = post;
    this.citizens = Array.from({ length: CONFIG.sim.citizens }, (_, i) => makeCitizen(i));
    this.timer = null;
    this.running = false;
    this.posted = 0;
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.timer = setInterval(() => this.tick(), CONFIG.sim.intervalMs);
    this.tick(); // immediate first round
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
    this.running = false;
  }

  tick() {
    for (const c of this.citizens) {
      this.post(nextSample(c));
      this.posted++;
    }
  }
}

// Standalone mode: `node backend/seedSimulator.js --once` seeds data directly
// into the store (useful for smoke tests without the HTTP server).
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { ensureLoaded, addSample, saveNow } = await import('./store.js');
  const sim = new Simulator((sample) => addSample(sample));
  for (let round = 0; round < 25; round++) {
    for (const citizen of sim.citizens) await addSample(nextSample(citizen));
  }
  await saveNow();
  const state = await ensureLoaded();
  console.log(`Seeded ${state.samples.length} samples into ${CONFIG.dataFile}`);
  process.exit(0);
}
