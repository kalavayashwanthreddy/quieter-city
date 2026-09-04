// Alert engine: when a cell sustains a high average dB(A), create an alert
// targeted at the admin-defined users (City control room, traffic police…).
import { CONFIG } from './config.js';

export function runAlertCheck(state, cells) {
  const now = Date.now();

  // cells with an active alert still inside the cooldown window
  const coolingDown = new Set();
  for (const a of state.alerts) {
    if (a.status === 'active' && now - a.ts < CONFIG.alertCooldownMs) coolingDown.add(a.cell);
  }

  let created = 0;
  for (const cell of cells) {
    if (cell.avgDba < CONFIG.alertDba) continue;
    if (coolingDown.has(cell.cell)) continue;

    const level = cell.avgDba >= 85 ? 'critical' : 'high';
    state.alerts.push({
      id: 'al-' + now.toString(36) + '-' + Math.random().toString(36).slice(2, 6),
      cell: cell.cell,
      lat: cell.lat,
      lng: cell.lng,
      level,
      avgDba: cell.avgDba,
      dominantClass: cell.dominantClass,
      message: `Sustained ${cell.avgDba} dB(A) (${cell.dominantClass}) in cell ${cell.cell}`,
      ts: now,
      status: 'active',
      ackedBy: null,
      // who gets it — admin-defined users from config
      recipients: CONFIG.admins.map((a) => a.id),
    });
    coolingDown.add(cell.cell);
    created++;
  }

  // keep the feed bounded
  if (state.alerts.length > 200) state.alerts.splice(0, state.alerts.length - 200);
  return created;
}