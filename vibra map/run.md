# Run doc — quieter-city

## Reproduce uncommitted artifacts

- No `.env*` files or other uncommitted artifacts are required: this worktree **is** the main checkout
  (`C:\Users\kalav\OneDrive\Desktop\projects\.freebuff`), so there is nothing to copy.
- Dependencies: `npm install` (postinstall runs `node scripts/copy-wasm.mjs` to copy the
  MediaPipe/WASM assets needed by the on-device YAMNet analyzer).

## Run the server

- Dev server (API :3001 + Vite web :5173) in one process:
  `npm run dev`  (concurrently runs `node backend/server.js` and `vite`)
- Or separately: `npm run dev:api` and `npm run dev:web`.
- Web app: http://localhost:5173 (collector route `#/collect`, agent dashboard `#/agent`).
- Verify: `npm run verify` · `npm run check` · `npm run build`.