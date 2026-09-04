// Noise-aware routing (quiet-route-navigation spec).
// 1. A real routing engine (OSRM, playing Google Directions' role — no API
//    key needed for the demo; swap the fetch URL for Directions API in
//    production) returns road-network route ALTERNATIVES, so every candidate
//    is guaranteed to follow real streets.
// 2. Each alternative is scored against the noise heatmap: the polyline is
//    sampled every ~75 m; each sample averages nearby readings (≤ 100 m,
//    inverse-distance weighted) and falls back to a 55 dB baseline where the
//    city has no data — so unmeasured areas never look artificially quiet.
// 3. Candidates more than 30% longer than the fastest route are rejected;
//    the quietest ACCEPTABLE route wins. Noise only decides which real route
//    wins — it never invents a path through unroaded space.
export const SAMPLE_INTERVAL_METERS = 75;
export const MATCH_RADIUS_METERS = 100;
export const DEFAULT_BASELINE_NOISE = 55; // dB(A) for unmeasured stretches
export const MAX_DETOUR_RATIO = 1.3; // reject routes >30% longer than fastest
export const LOUD_DBA = 70; // "loud zone" threshold for noisyPct

export function haversineMeters(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// OSRM public demo server — coords in [lng, lat]. `alternatives=true` gives
// 2–5 real road-based candidates between the two points (spec step 1).
export async function fetchOsrmRoutes(a, b) {
  const url =
    `https://router.project-osrm.org/route/v1/driving/` +
    `${a.lng},${a.lat};${b.lng},${b.lat}?alternatives=true&overview=full&geometries=geojson&steps=false`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`OSRM error ${res.status}`);
  const data = await res.json();
  if (!data.routes || !data.routes.length) throw new Error('No road route found');
  return data.routes.map((r) => ({
    coords: r.geometry.coordinates, // [[lng, lat], ...]
    distanceKm: Math.round((r.distance / 1000) * 10) / 10,
    durationSec: Math.round(r.duration),
    durationMin: Math.round(r.duration / 60),
  }));
}

// Take a point roughly every `intervalMeters` along the polyline (spec step 2).
export function sampleRoutePoints(coords, intervalMeters = SAMPLE_INTERVAL_METERS) {
  const samples = [coords[0]];
  let accumulated = 0;
  for (let i = 1; i < coords.length; i++) {
    const [lng1, lat1] = coords[i - 1];
    const [lng2, lat2] = coords[i];
    accumulated += haversineMeters(lat1, lng1, lat2, lng2);
    if (accumulated >= intervalMeters) {
      samples.push(coords[i]);
      accumulated = 0;
    }
  }
  return samples;
}

// Score one sample point: inverse-distance weighted average of heatmap
// readings within `radiusMeters`; baseline (unknown) if none nearby.
// `heatmap` entries: { lat, lng, avgDba | noiseLevel }.
export function scorePoint(lat, lng, heatmap, radiusMeters = MATCH_RADIUS_METERS) {
  let weightSum = 0;
  let valueSum = 0;
  for (const entry of heatmap) {
    const dist = haversineMeters(lat, lng, entry.lat, entry.lng);
    if (dist <= radiusMeters) {
      const weight = 1 / Math.max(dist, 1); // closer readings count more
      weightSum += weight;
      valueSum += weight * (entry.avgDba ?? entry.noiseLevel);
    }
  }
  if (weightSum === 0) return { dba: DEFAULT_BASELINE_NOISE, known: false };
  return { dba: valueSum / weightSum, known: true };
}

// Score a whole route (spec steps 3–4): sample every ~75 m, blend every
// sample (KNOWN readings and the baseline alike — an unmeasured stretch
// scores 55 dB, never "free quiet").
export function scoreRoute(coords, heatmap) {
  const samples = sampleRoutePoints(coords);
  const scores = samples.map(([lng, lat]) => scorePoint(lat, lng, heatmap));
  const knownCount = scores.filter((s) => s.known).length;
  const avgAll = scores.reduce((a, s) => a + s.dba, 0) / scores.length;
  const maxAll = Math.max(...scores.map((s) => s.dba));
  const above = scores.filter((s) => s.dba >= LOUD_DBA).length;
  let distKm = 0;
  for (let i = 1; i < coords.length; i++) {
    distKm += haversineMeters(coords[i - 1][1], coords[i - 1][0], coords[i][1], coords[i][0]) / 1000;
  }
  return {
    avgDba: Math.round(avgAll * 10) / 10,
    maxDba: Math.round(maxAll * 10) / 10,
    noisyPct: Math.round((above / scores.length) * 100),
    knownPct: Math.round((knownCount / scores.length) * 100),
    distanceKm: Math.round(distKm * 10) / 10,
  };
}

// Rank scored routes (spec step 5): drop anything >30% longer than the
// fastest candidate, sort the survivors by average noise, flag the winner.
// Returns the input routes annotated with `quiet` / `fastest` /
// `detourTooLong` so the UI can highlight the pick.
export function rankRoutes(scoredRoutes) {
  if (!scoredRoutes.length) return [];
  const fastest = scoredRoutes.reduce((a, b) => (b.durationSec < a.durationSec ? b : a));
  const fastestDuration = fastest.durationSec;
  const acceptable = scoredRoutes.filter((r) => r.durationSec <= fastestDuration * MAX_DETOUR_RATIO);
  const quietest = acceptable.reduce((a, b) => (b.avgDba < a.avgDba ? b : a), acceptable[0]);
  return scoredRoutes.map((r) => ({
    ...r,
    quiet: r === quietest,
    fastest: r === fastest,
    detourTooLong: !acceptable.includes(r),
  }));
}