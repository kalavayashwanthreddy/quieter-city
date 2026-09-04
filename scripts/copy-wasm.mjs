// Copies MediaPipe's WASM runtime into public/wasm so the app can serve it
// locally (no CDN dependency, works offline, no CORS surprises).
import { cpSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'node_modules', '@mediapipe', 'tasks-audio', 'wasm');
const dest = join(root, 'public', 'wasm');

if (!existsSync(src)) {
  console.warn('⚠ @mediapipe/tasks-audio wasm not found — run `npm install` first.');
  process.exit(0);
}
mkdirSync(dest, { recursive: true });
cpSync(src, dest, { recursive: true });
console.log('✔ Copied MediaPipe WASM → public/wasm');