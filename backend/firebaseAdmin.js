// Firebase Admin is loaded only when STORAGE_BACKEND=firestore. Local demo
// mode therefore remains runnable without a service-account key.
import { CONFIG } from './config.js';

let sdkPromise;
let appPromise;

async function loadSdk() {
  if (!sdkPromise) {
    sdkPromise = Promise.all([
      import('firebase-admin/app'),
      import('firebase-admin/firestore'),
      import('firebase-admin/auth'),
    ]).then(([appSdk, firestoreSdk, authSdk]) => ({
      ...appSdk,
      getFirestore: firestoreSdk.getFirestore,
      getAuth: authSdk.getAuth,
    }));
  }
  return sdkPromise;
}

export function firestoreEnabled() {
  return CONFIG.storageBackend === 'firestore';
}

export async function getFirebaseAdmin() {
  if (!firestoreEnabled()) {
    throw new Error('Firebase Admin is disabled; set STORAGE_BACKEND=firestore.');
  }
  if (!appPromise) {
    appPromise = loadSdk().then(({ getApps, initializeApp, applicationDefault }) => {
      const existing = getApps();
      if (existing.length) return existing[0];
      return initializeApp({
        credential: applicationDefault(),
        projectId: CONFIG.firebaseProjectId,
      });
    });
  }
  return appPromise;
}

export async function getFirestoreDb() {
  const [{ getFirestore }, app] = await Promise.all([loadSdk(), getFirebaseAdmin()]);
  return getFirestore(app);
}

export async function getFirebaseAuth() {
  const [{ getAuth }, app] = await Promise.all([loadSdk(), getFirebaseAdmin()]);
  return getAuth(app);
}
