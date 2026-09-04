// Prediction layer ("AI" for the hackathon demo):
// per cell, blend the historical hourly profile with the live trend to forecast
// the NEXT hour's average noise and flag expected hotspots.
import { CONFIG } from './config.js';

const round1 = (n) => Math.round(n * 10) / 10;
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

export function computePredictions(state, cells) {
  const nextHour = (new Date().getHours() + 1) % 24;

  // hourly profile per cell: hourOfDay -> [dba, ...]
  const profile = new Map(); // geohash -> {hour: dba[]}
  for (const s of state.samples) {
    if (typeof s.ts !== 'number') continue;
    const h = new Date(s.ts).getHours();
    let p = profile.get(s.geohash);
    if (!p) { p = {}; profile.set(s.geohash, p); }
    if (!p[h]) p[h] = [];
    p[h].push(s.dba);
  }

  const predictions = [];
  for (const cell of cells) {
    const p = profile.get(cell.cell);
    const hist = p && p[nextHour] && p[nextHour].length ? p[nextHour] : null;
    const histAvg = hist ? hist.reduce((a, x) => a + x, 0) / hist.length : null;

    // forecast = profile (historical norm for this hour) + live trend correction
    let forecast;
    if (histAvg != null) {
      forecast = 0.55 * histAvg + 0.35 * cell.recentAvgDba + 0.10 * (cell.recentAvgDba + cell.trendPerMin * 60);
    } else {
      forecast = cell.recentAvgDba + cell.trendPerMin * 30; // limited history → live-biased
    }
    forecast = round1(clamp(forecast, 25, 115));

    const hotspot = forecast >= CONFIG.alertDba;
    predictions.push({
      cell: cell.cell,
      lat: cell.lat,
      lng: cell.lng,
      hour: nextHour,
      forecastDba: forecast,
      confidence: Math.min(1, Math.round((cell.count / 20) * 100) / 100),
      hotspot,
      basedOn: histAvg != null ? 'profile+live' : 'live',
    });
  }
  // only the interesting ones for the UI: hotspots first, then top confidence
  predictions.sort((a, b) => (b.hotspot - a.hotspot) || (b.confidence - a.confidence));
  return predictions.slice(0, 150);
}