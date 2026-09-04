// Citizen-facing notification system (audio-safety-and-notifications spec §3).
//
// Two notification types, both scoped to a WATCHED AREA only:
//   1. traffic    — a watched cell crossed the noise-alert threshold
//   2. prediction — a watched cell is forecast to get loud in the next hours
//
// Each subscription is a delivery address (browser subscriber id) + the
// geohash-5 (~5 km) area it wants alerts for. This table is NEVER joined to
// readings or reward accounts — it stores only "this delivery address wants
// alerts for this area", exactly per spec §3.2.
//
// Throttle (spec §3.5): at most 1 traffic + 1 prediction alert per subscriber
// per watched cell per hour — a notification-layer cooldown, independent of
// the reading-ingestion rate limits.
import { CONFIG } from './config.js';
import { NOTIFICATIONS } from '../src/shared/schema.js';
import { cellCenter, neighbors } from '../src/shared/geohash.js';

const throttle = new Map(); // `${subscriberId}|${cell5}|${type}` -> hour key

export function resetNotifications() {
  throttle.clear();
}

const hourKey = (ts) => new Date(ts).toISOString().slice(0, 13); // YYYY-MM-DDTHH (UTC)

function hourLabel(h) {
  const hh = ((h % 24) + 24) % 24;
  const ampm = hh < 12 ? 'AM' : 'PM';
  const h12 = hh % 12 === 0 ? 12 : hh % 12;
  return `${h12} ${ampm}`;
}

function offsetMeters(lat, lng, dLatM, dLngM) {
  const metersPerDegLat = 111320;
  const metersPerDegLng = metersPerDegLat * Math.max(0.2, Math.cos((lat * Math.PI) / 180));
  return { lat: lat + dLatM / metersPerDegLat, lng: lng + dLngM / metersPerDegLng };
}

const uid = () => 'n-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);

function pushNotification(state, sub, { type, cell, dba, soundClass, forecastDba, hour, ts }) {
  let message;
  let solution;
  if (type === 'traffic') {
    // "🔴 Noise spike nearby: [area] just hit 88 dB (Construction)."
    message = `🔴 Noise spike nearby: cell ${cell} just hit ${Math.round(dba)} dB(A) (${soundClass}).`;
    // tap-to-solution (§3.3): bypass route around the noisy cell — the agent
    // dashboard computes quiet vs fastest for these endpoints when opened.
    const { lat, lng } = cellCenter(cell);
    solution = {
      type: 'route',
      from: offsetMeters(lat, lng, 0, -900), // 900 m west
      to: offsetMeters(lat, lng, 0, 900), // 900 m east
    };
  } else {
    // "⚠️ [area] is predicted to get loud around 5–6 PM today."
    message = `⚠️ Near you: ${Math.round(forecastDba)} dB(A) predicted around ${hourLabel(hour)}–${hourLabel(hour + 1)}.`;
    solution = {
      type: 'window',
      hour,
      forecastDba,
      before: (hour - 1 + 24) % 24, // suggested better times
      after: (hour + 2) % 24,
    };
  }

  state.notifications.push({
    id: uid(),
    subscriberId: sub.subscriberId,
    type,
    cell,
    dba: type === 'traffic' ? Math.round(dba * 10) / 10 : null,
    forecastDba: type === 'prediction' ? forecastDba : null,
    soundClass: type === 'traffic' ? soundClass : null,
    hour: type === 'prediction' ? hour : null,
    message,
    solution,
    ts,
    status: 'new',
  });

  // bound per subscriber
  const mine = state.notifications.filter((n) => n.subscriberId === sub.subscriberId);
  if (mine.length > NOTIFICATIONS.keepPerSubscriber) {
    const drop = mine.slice(0, mine.length - NOTIFICATIONS.keepPerSubscriber);
    const dropIds = new Set(drop.map((n) => n.id));
    state.notifications = state.notifications.filter((n) => !dropIds.has(n.id));
  }
}

/**
 * Scan current cells + predictions against every subscription and emit
 * notifications for newly-crossed thresholds, honoring the per-cell-per-hour
 * throttle. Called on each aggregation refresh.
 */
export function runNotificationCheck(state) {
  const now = Date.now();
  const predByCell = new Map(state.predictions.map((p) => [p.cell, p]));
  let created = 0;

  for (const sub of state.subscriptions) {
    // geohash-5 cells in the watched area: center + `radiusCells` rings of neighbors
    const radius = Math.min(2, Math.max(1, sub.radiusCells || NOTIFICATIONS.defaultRadiusCells));
    const watched = new Set([sub.watchedGeohash5]);
    let frontier = [sub.watchedGeohash5];
    for (let ring = 0; ring < radius; ring++) {
      const next = [];
      for (const c of frontier) {
        for (const n of neighbors(c)) {
          if (!watched.has(n)) {
            watched.add(n);
            next.push(n);
          }
        }
      }
      frontier = next;
    }

    for (const cell of state.cells) {
      const cell5 = cell.cell.slice(0, 5);
      if (!watched.has(cell5)) continue;

      // 1. traffic / noise spike alert
      if (cell.avgDba >= CONFIG.alertDba) {
        const key = `${sub.subscriberId}|${cell5}|traffic`;
        const hk = hourKey(now);
        if (throttle.get(key) !== hk) {
          throttle.set(key, hk);
          pushNotification(state, sub, {
            type: 'traffic',
            cell: cell.cell,
            dba: cell.avgDba,
            soundClass: cell.dominantClass,
            ts: now,
          });
          created++;
        }
      }

      // 2. future prediction alert
      const p = predByCell.get(cell.cell);
      if (p && p.hotspot && p.forecastDba >= CONFIG.alertDba) {
        const key = `${sub.subscriberId}|${cell5}|prediction`;
        const hk = hourKey(now);
        if (throttle.get(key) !== hk) {
          throttle.set(key, hk);
          pushNotification(state, sub, {
            type: 'prediction',
            cell: cell.cell,
            forecastDba: p.forecastDba,
            hour: p.hour,
            ts: now,
          });
          created++;
        }
      }
    }
  }
  return created;
}