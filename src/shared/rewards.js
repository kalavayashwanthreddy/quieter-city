// Reward logic per the reward-system spec. Pure functions so the maths
// (streak days, daily rollover, diversity bonus, caps, persistence) can be
// unit-tested independently of the UI.
//
// Identity boundary (spec §2): this ledger is the WEB fallback — it is
// device-local, never synced to any account, and never joined with the
// anonymous reading session ids. The counters it keeps (distinct cells,
// streak, last timestamps) exist ONLY to compute bonuses server-side-style;
// they are never exposed and reset at local midnight.
import { REWARDS } from './schema.js';

export const REWARD_KEY = 'quieter-city-rewards';

/** Local calendar day as YYYY-MM-DD — NOT UTC (same fix as sessionAndAlerts). */
export function localDayKey(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function yesterdayOf(dayKey) {
  const [y, m, d] = dayKey.split('-').map(Number);
  const dt = new Date(y, m - 1, d - 1);
  return localDayKey(dt);
}

export function emptyRewards(now = new Date()) {
  return {
    points: 0, // spendable-style counter (local, session-scoped)
    lifetime: 0, // lifetime_points
    streakDays: 0, // current_streak_days
    lastRewardAt: 0, // epoch ms of last accepted reading
    lastDay: null, // local day of last accepted reading
    distinctCellsToday: [], // geohash-4 prefixes seen today (diversity bonus only)
    day: localDayKey(now),
  };
}

/** Read persisted rewards; safe against corrupted JSON / private mode. */
export function loadRewards(storage = typeof localStorage !== 'undefined' ? localStorage : null) {
  if (!storage) return emptyRewards();
  try {
    const r = JSON.parse(storage.getItem(REWARD_KEY) || '{}');
    const fresh = emptyRewards();
    // migrate old shape (points/streak/today/day/lastTs) → new shape; carry
    // the accumulated points, everything streak/diversity related starts over.
    const lastTs = r.lastRewardAt || r.lastTs || 0;
    return {
      points: r.points || 0,
      lifetime: r.lifetime || r.points || 0,
      // only migrate-to-zero for the OLD pre-spec shape (which had `streak`,
      // not `streakDays`); a new-shape save keeps its streak.
      streakDays: typeof r.streakDays === 'number' ? r.streakDays : 0,
      lastRewardAt: lastTs,
      lastDay: r.lastDay || (lastTs ? localDayKey(new Date(lastTs)) : null),
      distinctCellsToday: Array.isArray(r.distinctCellsToday) ? r.distinctCellsToday : [],
      day: r.day || fresh.day,
    };
  } catch {
    return emptyRewards();
  }
}

export function saveRewards(r, storage = typeof localStorage !== 'undefined' ? localStorage : null) {
  if (!storage) return;
  try {
    storage.setItem(REWARD_KEY, JSON.stringify(r));
  } catch {
    // private mode / quota — rewards still work for this session, just not persisted
  }
}

/**
 * Pure award calculation for ONE accepted reading.
 * @param prev previous reward state (loadRewards)
 * @param opts { now, dayKey, cellPrefix4 } — injectable for tests; cellPrefix4
 *        is the geohash-4 prefix (~20 km) of the reading's cell.
 * @returns {{ next, points, base, streakBonus, diversity }}
 *
 * Spec §4:
 *  - base   +1 per accepted reading
 *  - streak +1 per consecutive calendar day with a reading, capped at +5
 *            (day 5+ → 1 base + 5 bonus = 6 per reading)
 *  - diversity +2 the FIRST time in a day a reading lands in a new geohash-4
 *            cell; at most 10 diversity bonuses per day (§5)
 * Spec §6: on local-day rollover, distinct cells reset and the streak is
 * evaluated — incremented if the last reading fell on the day that just ended,
 * reset to 0 otherwise ("never a partial value").
 */
export function computeReward(prev, { now = Date.now(), dayKey = localDayKey(), cellPrefix4 = null } = {}) {
  const dayRolled = prev.day !== dayKey;

  // streak days INCLUDING today, from §6 semantics:
  //  - same day as last reading → unchanged (today already counted)
  //  - yesterday → continued streak +1
  //  - older / never → fresh streak of 1 (a missed day resets to 0, not partial)
  let streakDays;
  if (prev.lastDay === dayKey) {
    streakDays = prev.streakDays;
  } else if (prev.lastDay === yesterdayOf(dayKey)) {
    streakDays = prev.streakDays + 1;
  } else {
    streakDays = 1;
  }

  let distinct = prev.distinctCellsToday;
  if (dayRolled) distinct = []; // §6: wipe diversity cells at midnight

  let diversity = 0;
  if (
    cellPrefix4 &&
    !distinct.includes(cellPrefix4) &&
    distinct.length < REWARDS.diversityCapPerDay // §5: daily diversity cap (silently capped)
  ) {
    distinct = [...distinct, cellPrefix4];
    diversity = REWARDS.diversityBonus;
  }

  const base = REWARDS.perSample; // +1
  const streakBonus = Math.min(streakDays, REWARDS.streakBonusCap); // cap +5
  const points = base + streakBonus + diversity;

  const next = {
    points: prev.points + points,
    lifetime: (prev.lifetime || 0) + points,
    streakDays,
    lastRewardAt: now,
    lastDay: dayKey,
    distinctCellsToday: distinct,
    day: dayKey,
  };
  return { next, points, base, streakBonus, diversity };
}