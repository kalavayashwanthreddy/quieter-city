# Run doc — Quieter City

## Reproduce the uncommitted artifacts

This workspace is the main checkout, so no env/config files need copying from elsewhere.

1. Install dependencies (also runs `postinstall` → `scripts/copy-wasm.mjs`):
   ```
   npm install
   ```
2. Verify the MediaPipe WASM runtime is present (postinstall copies it into `public/wasm`):
   ```
   ls public/wasm/audio_wasm_internal.wasm
   ```
   If missing, run `node scripts/copy-wasm.mjs`.

## Run the server

Start both the API (port 3001) and the Vite web server (port 5173) with:

```
npm run dev
```

or individually:

- `npm run dev:api` → `node backend/server.js` on port 3001
- `npm run dev:web` → `vite` on port 5173

Open http://localhost:5173/ — the app proxies `/api` requests to the backend.

Config is env-overridable: `PORT` (default 3001), `DATA_FILE`, `ADMIN_TOKEN`. A seeded demo dataset (`backend/data/db.json`) ships with the repo.

Firebase (optional, for the citizen collector only): the web config for project `vibra-map` is already committed in `src/collector/firebase.js`. The app runs fine without it — console-side setup is required to make live writes work: enable Authentication + Anonymous sign-in and create the Firestore database in the Firebase console, then deploy `backend/firestore.rules.example`.