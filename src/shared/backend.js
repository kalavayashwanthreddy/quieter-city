// Frontend ↔ backend adapter. In production, VITE_API_AUTH=true attaches a
// Firebase Anonymous Auth ID token to citizen endpoints. Local demo mode keeps
// the original unauthenticated development API.
import { API_BASE, ADMIN_TOKEN_KEY, DEFAULT_ADMIN_TOKEN } from './schema.js';
import { getFirebaseIdToken } from '../collector/firebase.js';

const API_AUTH_ENABLED = import.meta.env.VITE_API_AUTH === 'true';

function adminHeaders() {
  const token =
    (typeof localStorage !== 'undefined' && localStorage.getItem(ADMIN_TOKEN_KEY)) ||
    import.meta.env.VITE_ADMIN_TOKEN ||
    DEFAULT_ADMIN_TOKEN;
  return { 'x-admin-token': token };
}

async function req(path, opts = {}, { auth = false, retried = false } = {}) {
  const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
  if (auth && API_AUTH_ENABLED) {
    headers.Authorization = `Bearer ${await getFirebaseIdToken(retried)}`;
  }

  const res = await fetch(API_BASE + path, { ...opts, headers });
  if (res.status === 401 && auth && API_AUTH_ENABLED && !retried) {
    return req(path, opts, { auth, retried: true });
  }
  if (!res.ok) {
    let detail = {};
    try { detail = await res.json(); } catch { /* ignore */ }
    const err = new Error(`${res.status} ${detail.error || JSON.stringify(detail)}`);
    err.status = res.status;
    if (detail.error) err.code = detail.error;
    if (detail.retryInMs) err.retryInMs = detail.retryInMs;
    throw err;
  }
  return res.json();
}

export function isApiAuthEnabled() {
  return API_AUTH_ENABLED;
}

export const api = {
  health: () => req('/health'),
  postSample: (sample) => req('/samples', { method: 'POST', body: JSON.stringify(sample) }, { auth: true }),
  getCells: () => req('/cells'),
  getPredictions: () => req('/predictions'),
  getAlerts: () => req('/alerts'),
  ackAlert: (id, adminId) => req(`/alerts/${encodeURIComponent(id)}/ack`, {
    method: 'POST', headers: adminHeaders(), body: JSON.stringify({ adminId }),
  }),
  getAdmins: () => req('/admins'),
  subscribe: (sub) => req('/subscriptions', { method: 'POST', body: JSON.stringify(sub) }, { auth: true }),
  unsubscribe: (subscriberId) => req(`/subscriptions/${encodeURIComponent(subscriberId)}`, { method: 'DELETE' }, { auth: true }),
  getNotifications: (subscriberId) => req(`/notifications?subscriberId=${encodeURIComponent(subscriberId)}`, {}, { auth: true }),
  simStart: () => req('/sim/start', { method: 'POST', headers: adminHeaders() }),
  simStop: () => req('/sim/stop', { method: 'POST', headers: adminHeaders() }),
  reset: () => req('/reset', { method: 'POST', headers: adminHeaders() }),
};
