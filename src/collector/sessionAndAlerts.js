// Two independent utilities:
//   1. getSessionId()          — anonymous session ID for THIS app run (rotates daily)
//   2. shouldResetAlertsToday() / markAlertsSeenToday() — daily alert reset helpers
//      (used once alerts are synced from Firebase / the backend into the client)
import { v4 as uuidv4 } from 'uuid'

const SESSION_KEY = 'qc-session-id'
const SESSION_DATE_KEY = 'qc-session-date'
const ALERTS_SEEN_DATE_KEY = 'qc-alerts-last-reset'

/**
 * Local calendar day as YYYY-MM-DD — NOT UTC.
 *
 * This is the "time glitch" fix: the previous implementation used
 * `new Date().toISOString().slice(0, 10)`, which returns the UTC date.
 * For anyone east of Greenwich (e.g. UTC+5:30 India) the "day" then flips
 * at UTC midnight — 05:30 in the morning — so the session ID rotated and
 * alerts reset in the middle of the night, and could flip mid-evening for
 * western timezones. This builds the key from the LOCAL year/month/day,
 * so the calendar day rolls over at local midnight where the citizen is.
 */
export function localDayKey(date = new Date()) {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

/**
 * A fresh random session ID is generated once per LOCAL calendar day (not
 * per app-open) so a single day's samples can be loosely grouped without
 * letting an ID persist indefinitely and become a de-facto identifier.
 * Never derived from device info, IP, or any PII.
 */
export function getSessionId() {
  const today = localDayKey()
  const storedDate = localStorage.getItem(SESSION_DATE_KEY)
  let sessionId = localStorage.getItem(SESSION_KEY)

  if (!sessionId || storedDate !== today) {
    sessionId = uuidv4()
    localStorage.setItem(SESSION_KEY, sessionId)
    localStorage.setItem(SESSION_DATE_KEY, today)
  }
  return sessionId
}

/**
 * Returns true exactly once per LOCAL calendar day, telling the caller
 * "clear/reset the alerts list now." Date-based, not timer-based, so it is
 * immune to the app being closed, backgrounded, or the device sleeping
 * through a setTimeout/setInterval.
 */
export function shouldResetAlertsToday() {
  const today = localDayKey()
  const lastReset = localStorage.getItem(ALERTS_SEEN_DATE_KEY)
  return lastReset !== today
}

export function markAlertsSeenToday() {
  const today = localDayKey()
  localStorage.setItem(ALERTS_SEEN_DATE_KEY, today)
}