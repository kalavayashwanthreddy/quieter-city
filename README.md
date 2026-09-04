# 🎧 Quieter City — Privacy-First Crowdsourced Noise Intelligence

> **Problem:** Urban noise causes health issues but cities only have a few static sound
> meters — no real-time map, no prediction, no action.
>
> **Solution:** Citizens' phones become noise sensors. Audio is analyzed **on-device**
> (YAMNet: dB level + noise type — traffic, construction, music, speech). Only anonymous
> **metadata** is uploaded (no raw audio, no exact location). A live heatmap, next-hour
> hotspot predictions, noise-aware routing and admin alerts turn that data into action.

Built as a hackathon project: one React + Vite web app with **two interfaces**, plus a
mock backend that mirrors a Firebase/Firestore data model so everything runs with zero
setup.

---

## ⚡ Quick start

```bash
npm install        # installs deps + copies MediaPipe WASM into public/wasm
npm run dev        # starts API (localhost:3001) + web app (localhost:5173)
```

Then open **http://localhost:5173**:

- **Citizen Sensor** (default): grant mic + location → the phone starts classifying
  noise on-device and contributing anonymous samples.
- **Agent Dashboard**: switch via the top nav or `#/agent` — live colourful heatmap with
  an on-map legend, noise-aware routes, **pop-up notifications whenever a new alert fires**
  (click one to jump to the Alerts tab), forecasts.

> The **simulator** runs automatically (16 virtual citizens in Bengaluru) so the map,
> alerts and predictions light up immediately — even before any real phone contributes.
> Run `npm run verify` anytime to unit-test the reward maths, the anti-abuse gate, the
> notification engine, and the local-calendar-day logic (the “time glitch” fix).

## 🗺️ What you get

### Citizen Sensor (`#/collect`)
- Live dB(A) meter + YAMNet on-device classification (521 AudioSet classes, ~2 MB model).
- **SpeechGuard** — if human speech is detected, nothing is uploaded: the user chooses
  *Discard* or *De-voice* (on-device band-stop filter carves out the 300–3400 Hz speech
  band; traffic/construction data survives).
- **Privacy by design**: the exact GPS fix is blurred on-device to a random point within
  **±100 m**, then bucketed into a geohash-7 cell (~153 m × 153 m); only that cell + a random
  session id are uploaded. Raw audio, exact coordinates, device & user info never leave the
  device (also enforced server-side — see "Privacy" below).
- **Rewards** (reward-system spec §4): **+1** per accepted reading · **+1** streak bonus
  per consecutive calendar day, capped at **+5** · **+2** diversity bonus the first time a
  reading lands in a new ~20 km (geohash-4) area per day, capped at 10/day. Rejected
  readings (speech, rate limit, implausible movement) earn nothing. Granted only after a
  **confirmed write** to the durable store (Firestore when keys are configured, otherwise
  the local API) — never for silent failures. Rewards are device-local and never linked to
  your samples.
- **Watch my area (opt-in notifications, spec §3)**: subscribe to the ~5 km area around
  your (blurred) location and get a toast when noise spikes there — or is predicted to
  spike — with **tap-to-solution**: a spike alert jumps to the Agent Dashboard with a
  bypass route already computed; a forecast alert shows the noisy window plus suggested
  better times. Throttled to 1 of each per area per hour. The subscription is a
  browser-scoped id that is never joined to your samples or rewards.
- **Firebase-ready**: when you paste your project keys, every accepted sample is also
  synced to Firestore (`noise_samples`) under an **anonymous uid** — still metadata only,
  still no raw audio or exact GPS (see “Connecting Firebase” below).

### Agent Dashboard (`#/agent`)
- **Heatmap** — live per-cell dB(A) overlay on OpenStreetMap, red = loud, auto-refresh
  every 5 s.
- **Routes** — type a **place name** (“Cubbon Park”) and pick a suggestion — a
  city-bounded Nominatim search (`src/shared/geocode.js`) resolves it to a precise
  point — or paste exact coordinates. The routing engine (OSRM) then returns several
  **road-based alternatives**; each is scored against the noise heatmap (75 m sampling,
  inverse-distance weighting, 55 dB baseline where the city has no data) and ranked.
  Candidates more than 30% longer than the fastest are rejected, so the **quietest
  acceptable route** wins — noise picks the real road route, it never invents a path
  through unroaded space. Map clicks reverse-geocode back to place names.
- **Alerts** — sustained ≥ 70 dB(A) in a cell triggers an alert to **admin-defined users**
  (City Control Room, Traffic Police HQ, Green Zone Authority…), with acknowledge flow.
- **Forecast** — next-hour hotspot prediction per cell (hourly profile + live trend),
  toggleable on the map.

## 🧱 Architecture

```
Phone mic ──► WebAudio dB(A) ──► YAMNet (MediaPipe, on-device) ──► SpeechGuard
     │
     └─► metadata only: { sessionId, geohash-7 cell, dBA, classes, ts }
                    │
        ┌───────────┴───────────────┐
        ▼ POST /api/samples         ▼ addDoc (when keys configured)
  Mock backend (Express + JSON)  Firestore `noise_samples` (anonymous uid)
     │  ├─ aggregation → noise_cells (live heatmap)
     │  ├─ prediction  → hotspots (next hour)
     │  ├─ anti-abuse  → 8 s rate limit + movement sanity (reject before insert)
     │  ├─ alert engine→ alerts → admin users
     │  └─ notifications→ watched-area spikes & forecasts (1/area/hour each)
     ▼
        Agent dashboard: heatmap · quiet routing · alerts · forecasts
```

### Repo layout — each folder is a small, independently testable "project"

| Piece | Files | What it does |
|---|---|---|
| **P1 · shared core** | `src/shared/` | geohash (ngeohash), privacy (session ids, PII strip), audio math (RMS, A-weight, resample), schema/thresholds — pure, node-testable |
| **P2 · backend mock** | `backend/` | Express API, JSON store, aggregation, prediction, alerts, anti-abuse gate, watched-area notifications, seed simulator |
| **P3 · collector** | `src/collector/` | mic engine (raw PCM → 16 kHz chunks delivered live), real-time YAMNet chunk analyzer (`SessionAnalyzer.js`), uploader, rewards, Firebase adapter (`firebase.js`), daily session id (`sessionAndAlerts.js`) |
| **P4 · agent** | `src/agent/` | Leaflet heatmap, OSRM road alternatives scored by noise (quietest-acceptable pick), alerts panel, forecast panel |
| **P5 · integration** | root | `App.jsx` (hash router), Vite proxy, styles, README, demo script |

## 🛡️ Security hardening (added on top of the privacy design)

The mock backend ships with a small security layer in `backend/security.js`:

- **Admin token** — acknowledge-alert, simulator start/stop and **reset** now
  require `x-admin-token`. The demo default (`quieter-city-demo-admin`) ships
  in the client so the demo keeps working; in production set a real secret:
  `ADMIN_TOKEN=<secret> npm run dev` and store the same value under
  `localStorage['qc-admin-token']` in the browser. Without the token these
  endpoints return `401` — a random visitor can no longer wipe the store or
  impersonate an admin on alerts.
- **Per-IP rate limits** — `POST /api/samples` (120/min) and
  `POST /api/subscriptions` (30/hour) complement the per-session anti-abuse
  gate, so rotating session ids from one host can't farm the API.
- **Anti-abuse clock fix** — `ts` must be a finite number within ±5 min of
  server time. Previously a client could send `ts: 0` (or any past value) to
  make the rate-limit/movement `dt` negative and **bypass both checks**; now
  that payload is rejected with `invalid-ts`.
- **Stored-XSS defense** — free-text fields (`dominantClass`, `dominantType`,
  `topClasses`, segments) are sanitized server-side before storage (no angle
  brackets, no control chars, length-capped), and the agent map escapes HTML
  in every Leaflet tooltip/popup (`escapeHtml` in `src/shared/privacy.js`) —
  double protection against markup smuggled into heatmap tooltips or alert
  popups.
- **Hardened HTTP layer** — security headers on every response
  (`X-Content-Type-Options`, `X-Frame-Options: DENY`, `Referrer-Policy`,
  `Cross-Origin-Opener-Policy`, `Permissions-Policy`), `x-powered-by`
  disabled, CORS restricted to the configured dev origins (never `*`),
  JSON-only 404/error responses (no HTML stack traces), and per-IP limiter
  tables self-prune so memory stays bounded.

`npm run verify` unit-tests all of the above (payload validation, sanitizer,
rate limiter, admin guard).

## 🔒 Privacy design (the heart of the pitch)

1. **No raw audio ever uploaded.** Only `{sessionId, geohash, cellLat/Lng (cell center), dba, topClasses, ts}`.
2. **No exact location.** The GPS fix is immediately blurred on-device to a random point within ±100 m (`blurLocation` in `src/shared/geohash.js`), then coarsened to a geohash-7 cell (~153 m); the true lat/lng never survives in memory, let alone on the wire.
3. **No identity.** An anonymous session id that rotates **daily** (never derived from device
   info); when Firebase is connected, an **anonymous Firebase uid** per device — no emails,
   no phone numbers, no device fingerprints, and anonymous accounts are never linked to a real identity.
4. **Real-time speech cross-check.** The mic stream is split into ~1-second chunks that
   are classified by YAMNet **as they arrive**; any chunk containing — or ambiguously
   resembling — human voice is marked PRIVATE and discarded immediately (never retained,
   never uploaded). Each chunk's raw audio is wiped the moment its analysis finishes, so
   raw audio exists only as the slice currently being classified — it never persists or travels.
5. **Defense in depth.** The backend rejects any sample containing forbidden keys (`lat`, `audio`, `deviceId`, …) — see `src/shared/privacy.js` and the reference rules in `backend/firestore.rules.example`.
6. **Anti-abuse without identity.** Server-side checks (≥ 8 s between same session + cell
   writes; physically implausible movement) reject readings **before** they are stored — a
   rejected reading earns nothing — and operate on the anonymous session id only, never on
   a reward account. Notification subscriptions are separate: they store only “this
   delivery address wants alerts for this area” and are never joined to readings or rewards.

## 🔁 Firebase / Firestore integration

The project now supports two storage modes:

- **Local development (default):** Express + `backend/data/db.json`, with the simulator enabled.
- **Cloud mode:** Express + Firebase Admin SDK + Firestore. Set `STORAGE_BACKEND=firestore` and
  deploy the API to Cloud Run with Application Default Credentials.

The browser uses the Firebase Web config already present in `src/collector/firebase.js`. Set
`VITE_API_AUTH=true` when building the cloud frontend. Citizen API requests then carry a Firebase
Anonymous Auth ID token; the backend verifies it with Firebase Admin before accepting samples or
notification subscriptions. Authenticated samples are stored with a purpose-specific pseudonym,
not a raw Firebase UID.

Required Cloud Run environment:

```text
NODE_ENV=production
STORAGE_BACKEND=firestore
FIREBASE_PROJECT_ID=vibra-map
AUTH_REQUIRED=true
AUTH_SECRET=<long-random-secret>
ADMIN_TOKEN=<long-random-admin-token>
CLIENT_ORIGIN=<Firebase Hosting URL>
```

For local Firestore testing, use `GOOGLE_APPLICATION_CREDENTIALS` with a service-account JSON file
that is excluded by `.gitignore`. Do not place that file in React, `public/`, or GitHub.

Publish `backend/firestore.rules.example` in Firebase Console. Raw samples remain private; only
aggregated cells and predictions are public. The current aggregation implementation rewrites the
small derived collections after accepted samples, which is appropriate for a hackathon/demo scale;
an incremental worker should replace it before high-volume production.

**Google Maps** (swap the Leaflet map): replace the tile layer + `L.heatLayer` in
`src/agent/MapView.jsx` with the Google Maps JS `HeatmapLayer` and `DirectionsService`
(the routing logic in `src/agent/Router.js` — road-route scoring + quietest-acceptable
ranking — is map-agnostic; `fetchOsrmRoutes` maps 1:1 to the Directions API call in the
quiet-route spec).

**Real push alerts**: watched-area notifications currently surface as in-app toasts (the
spec's browser fallback). To go native, wire `backend/notifications.js` output to Web Push
(service worker + VAPID) or Telegram `sendMessage` — the `subscriptions` / `notifications`
shapes already mirror the spec's `notification_subscriptions` table.

## ⚠️ Honest limitations

- Phone-mic dB is **uncalibrated** — readings use an offset approximation (`CALIBRATION_OFFSET_DB`); great for relative heatmaps, not for certified measurements. A per-device calibration step is the natural upgrade.
- The **prediction layer** uses live statistics (hourly profile + trend). Upgradable to a trained model: train on the aggregated cells in a Colab notebook and export to TF.js.
- OSRM public demo server may be rate-limited (swap in a Google Directions API key in
  `fetchOsrmRoutes` for a production grade routing engine).
- Mic capture uses `ScriptProcessorNode` (deprecated but universally supported); a future version should move to `AudioWorklet`.

## 🎬 Demo script (90 seconds)

1. `npm install && npm run dev`, open http://localhost:5173 — the simulator is already feeding data.
2. Open **Agent Dashboard → Heatmap**: show live cells, red construction/traffic hotspots, auto-refresh.
3. **Routes**: Cubbon Park → Airport Road. Find routes → several real road alternatives appear, scored by the heatmap (avg dB(A), % in loud zones); the green **quietest pick** is the quietest acceptable route (≤30% longer than the fastest) — a rejected "too-long detour" shows grayed out if OSRM returns one.
4. **Alerts**: show high/critical alerts (construction ≥ 70 dB(A)) and the admin recipients; acknowledge one.
5. **Forecast**: show expected next-hour hotspots.
6. Switch to **Citizen Sensor**, grant mic + location, clap or play music: watch the live dB meter, YAMNet chips, points tick up — and mention that all of it is on-device; no audio ever leaves the phone. Note the anti-abuse beat: standing still, samples are accepted at most ~1 per 8 s (rate limit), so one person can't farm points.
7. **Watch my area**: tap 🔔 *Watch my area* → let the simulator run or open Agent → Reset data → watch a 🔴 noise-spike toast appear → tap it and it lands on the Routes tab with a pre-computed quieter path around the noisy area.
8. Privacy close: "Raw audio never leaves the device. Speech is detected and blocked/de-voiced on-device. Your exact GPS is blurred to ±100 m on-device; only an anonymous area cell + dB goes to the city."

## 🛠️ Scripts

| Command | What it does |
|---|---|
| `npm run dev` | API + web app together |
| `npm run dev:api` / `npm run dev:web` | separately |
| `npm run build` | production build |
| `npm run check` | syntax-check all backend files |
| `ADMIN_TOKEN=… npm run dev` | run with a real admin token for the privileged endpoints |
| `PORT=3100 DATA_FILE=/tmp/test.json npm run dev:api` | isolated API instance (staging/tests) |
| `npm run sim:once` | seed the store directly (no server) |
| `npm run verify` | unit-test rewards, anti-abuse, notifications & the local-day fix |
