// Backend configuration. Local development remains available by default; set
// STORAGE_BACKEND=firestore for Cloud Run/Firestore persistence.
export const CONFIG = {
  storageBackend: process.env.STORAGE_BACKEND || (process.env.NODE_ENV === 'production' ? 'firestore' : 'local'),
  firebaseProjectId: process.env.FIREBASE_PROJECT_ID || 'vibra-map',
  authRequired: process.env.AUTH_REQUIRED === 'true' || process.env.NODE_ENV === 'production',
  authSecret: process.env.AUTH_SECRET || (process.env.NODE_ENV === 'production' ? null : 'dev-only-change-me'),
  adminToken: process.env.ADMIN_TOKEN || (process.env.NODE_ENV === 'production' ? null : 'quieter-city-demo-admin'),
  googleApplicationCredentials: process.env.GOOGLE_APPLICATION_CREDENTIALS || null,

  port: Number(process.env.PORT) || 3001,
  dataFile: process.env.DATA_FILE || 'backend/data/db.json',

  allowedOrigins: [
    'http://localhost:5173',
    'http://127.0.0.1:5173',
    'http://localhost:4173',
    'http://127.0.0.1:4173',
    ...(process.env.CLIENT_ORIGIN ? [process.env.CLIENT_ORIGIN] : []),
  ],

  rateLimit: {
    samples: { windowMs: 60 * 1000, max: 120 },
    subscriptions: { windowMs: 60 * 60 * 1000, max: 30 },
  },
  city: {
    name: 'Bengaluru',
    center: [12.9716, 77.5946],
  },
  alertDba: 70,
  alertCooldownMs: 30 * 60 * 1000,
  liveWindowMs: 30 * 60 * 1000,
  maxSamples: 40000,

  sim: {
    // SIM_ENABLED enables the demo simulator feature. It does not start it;
    // the agent's Start/Stop controls own the running state.
    enabled: process.env.SIM_ENABLED === 'true',
    autoStart: process.env.SIM_AUTOSTART === 'true',
    intervalMs: 4000,
    citizens: 16,
    zones: [
      { id: 'traffic-mgroad', type: 'traffic', center: [12.9752, 77.6059], radiusKm: 0.8, base: 66, variance: 8 },
      { id: 'construction-stadium', type: 'construction', center: [12.9786, 77.5897], radiusKm: 0.45, base: 75, variance: 9 },
      { id: 'quiet-cubbon', type: 'quiet', center: [12.9766, 77.5924], radiusKm: 0.5, base: 47, variance: 5 },
      { id: 'traffic-outerring', type: 'traffic', center: [12.9667, 77.6475], radiusKm: 0.7, base: 64, variance: 7 },
      { id: 'market-jayanagar', type: 'market', center: [12.9303, 77.585], radiusKm: 0.6, base: 67, variance: 8 },
      { id: 'traffic-airport-rd', type: 'traffic', center: [12.9896, 77.6505], radiusKm: 0.6, base: 68, variance: 7 },
    ],
  },

  admins: [
    { id: 'admin-bmc', name: 'City Control Room', role: 'Noise Officer', channels: ['app', 'email'] },
    { id: 'admin-traffic', name: 'Traffic Police HQ', role: 'Traffic Cell', channels: ['app'] },
    { id: 'admin-green', name: 'Green Zone Authority', role: 'Parks & Environment', channels: ['app', 'sms'] },
  ],
};
