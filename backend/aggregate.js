// Aggregation: raw samples → per-cell rolling stats (the "noise_cells" doc).
import { CONFIG } from './config.js';
import { cellCenter } from '../src/shared/geohash.js';

const round1 = (n) => Math.round(n * 10) / 10;
// Cell-center coordinates are published at ~1 m precision: the center of a
// ~153 m geohash-7 cell is a deterministic, privacy-safe centroid (the cell
// string itself already pins the box), and coarse rounding would break
// 100 m-radius noise matching in route scoring (quiet-route spec).
const round5 = (n) => Math.round(n * 1e5) / 1e5;

function mode(arr) {
  const counts = new Map();
  let best = arr[0] || 'other';
  let bestCount = 0;
  for (const v of arr) {
    const c = (counts.get(v) || 0) + 1;
    counts.set(v, c);
    if (c > bestCount) { bestCount = c; best = v; }
  }
  return best;
}

export function aggregateCells(state) {
  const now = Date.now();
  const windowStart = now - CONFIG.liveWindowMs;
  const recentStart = now - 10 * 60 * 1000; // last 10 min (for trend)

  const buckets = new Map(); // geohash -> {dbas, recentDbas, classes, count}
  for (const s of state.samples) {
    if (typeof s.ts !== 'number' || s.ts < windowStart) continue;
    let b = buckets.get(s.geohash);
    if (!b) {
      const center = cellCenter(s.geohash);
      b = { cell: s.geohash, lat: center.lat, lng: center.lng, dbas: [], recentDbas: [], classes: [], count: 0 };
      buckets.set(s.geohash, b);
    }
    b.dbas.push(s.dba);
    b.classes.push(s.dominantClass || 'other');
    b.count++;
    if (s.ts >= recentStart) b.recentDbas.push(s.dba);
  }

  const cells = [];
  for (const b of buckets.values()) {
    const avg = b.dbas.reduce((a, x) => a + x, 0) / b.dbas.length;
    const recentAvg = b.recentDbas.length
      ? b.recentDbas.reduce((a, x) => a + x, 0) / b.recentDbas.length
      : avg;
    // crude trend: dB per minute between the live average and the recent average
    const trend = (recentAvg - avg) / Math.max(1, (CONFIG.liveWindowMs - 10 * 60 * 1000) / 60000);
    cells.push({
      cell: b.cell,
      lat: round5(b.lat),
      lng: round5(b.lng),
      count: b.count,
      avgDba: round1(avg),
      maxDba: round1(Math.max(...b.dbas)),
      recentAvgDba: round1(recentAvg),
      trendPerMin: round1(trend),
      dominantClass: mode(b.classes),
      updatedAt: now,
    });
  }
  return cells;
}