// Privacy utilities: anonymous session IDs and PII stripping.
// Runs in the browser (collector) AND in the mock backend (validation).

export function newSessionId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  // Fallback (older contexts)
  return 's-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 12);
}

// Keys that must NEVER appear in an uploaded sample (defense in depth).
export const FORBIDDEN_KEYS = [
  'lat', 'lng', 'latitude', 'longitude', 'accuracy', 'audio', 'waveform',
  'pcm', 'base64', 'deviceId', 'userAgent', 'ip', 'phone', 'imei', 'email',
  'name', 'fcmToken',
];

// Deep-strip any forbidden key from an object before it leaves the device /
// before the backend accepts it.
export function stripPii(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj || {})) {
    if (FORBIDDEN_KEYS.includes(k.toLowerCase())) continue;
    if (v && typeof v === 'object' && !Array.isArray(v)) out[k] = stripPii(v);
    else out[k] = v;
  }
  return out;
}

export function containsPii(obj, path = '') {
  for (const [k, v] of Object.entries(obj || {})) {
    const p = path ? `${path}.${k}` : k;
    if (FORBIDDEN_KEYS.includes(k.toLowerCase())) return p;
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const found = containsPii(v, p);
      if (found) return found;
    }
  }
  return null;
}

// Security: normalize a free-text label before it is STORED server-side.
// Strips angle brackets (no markup), control characters and excessive
// whitespace, then caps the length — so a crafted class name or alert label
// can never smuggle HTML/JS into map tooltips, popups or messages even if a
// renderer forgets to escape.
export function sanitizeLabel(value, maxLen = 120) {
  if (typeof value !== 'string') return value;
  return value
    .replace(/[<>]/g, '') // no angle brackets → no markup
    .replace(/[\u0000-\u001F\u007F]/g, ' ') // control chars out
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLen);
}

// Defense in depth at the renderer: escape a string for safe interpolation
// into Leaflet tooltips/popups (bindTooltip/bindPopup take HTML strings).
export function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}