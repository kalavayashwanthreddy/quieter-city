import crypto from 'node:crypto';
import { CONFIG } from './config.js';
import { getFirebaseAuth, firestoreEnabled } from './firebaseAdmin.js';

export async function verifyFirebaseToken(token) {
  if (!firestoreEnabled() || typeof token !== 'string' || !token) return null;
  try {
    const decoded = await (await getFirebaseAuth()).verifyIdToken(token);
    return decoded?.uid ? decoded : null;
  } catch {
    return null;
  }
}

export function derivePseudonym(payload, purpose) {
  const secret = CONFIG.authSecret;
  if (!secret) throw new Error('AUTH_SECRET is required for pseudonyms.');
  return crypto.createHmac('sha256', secret).update(`${purpose}:${payload.uid}`).digest('hex');
}

export function adminTokenValid(token) {
  const configured = CONFIG.adminToken;
  if (!configured || typeof token !== 'string') return false;
  const a = Buffer.from(token);
  const b = Buffer.from(configured);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
