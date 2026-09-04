// On-device sound classification with YAMNet (Google's 521-class AudioSet
// model, run through the official MediaPipe Audio Tasks runtime — the original
// tfjs wrapper package @tensorflow-models/yamnet was unpublished from npm).
//
// All inference happens in the browser. No audio ever leaves the device.
import { AudioClassifier, FilesetResolver } from '@mediapipe/tasks-audio';
import { YAMNET_MODEL_URL, YAMNET_SAMPLE_RATE } from '../shared/schema.js';

// version must match package.json → used only as a CDN fallback for the WASM
const WASM_CDN = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-audio@0.10.35/wasm`;

let classifier = null;
let loadingPromise = null;

export async function loadClassifier() {
  if (classifier) return classifier;
  if (!loadingPromise) {
    loadingPromise = (async () => {
      let fileset;
      try {
        fileset = await FilesetResolver.forAudioTasks('/wasm'); // served locally
      } catch {
        fileset = await FilesetResolver.forAudioTasks(WASM_CDN); // fallback
      }
      classifier = await AudioClassifier.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: YAMNET_MODEL_URL, delegate: 'CPU' },
        maxResults: 10,
      });
      return classifier;
    })();
    loadingPromise.catch(() => { loadingPromise = null; }); // allow retry
  }
  return loadingPromise;
}

// waveform: Float32Array of YAMNET_WINDOW samples @16kHz
// → [{ index, score, categoryName }] sorted by score desc (max 10)
export function classifyWaveform(waveform) {
  if (!classifier) return [];
  try {
    const result = classifier.classify(waveform, YAMNET_SAMPLE_RATE);
    return result?.[0]?.classifications?.[0]?.categories ?? [];
  } catch (err) {
    console.warn('YAMNet classify failed:', err);
    return [];
  }
}

export const isClassifierReady = () => !!classifier;