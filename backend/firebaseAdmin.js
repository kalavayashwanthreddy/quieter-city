// Firebase Admin is loaded only when STORAGE_BACKEND=firestore. Local demo
// mode therefore remains runnable without a service-account key.
import { CONFIG } from './config.js';

let sdkPromise;
let appPromise;
let firestoreDbPromise;

async function loadSdk() {
  if (!sdkPromise) {
    sdkPromise = Promise.all([
      import('firebase-admin/app'),
      import('firebase-admin/firestore'),
      import('firebase-admin/auth'),
    ]).then(([appSdk, firestoreSdk, authSdk]) => ({
      ...appSdk,
      cert: appSdk.cert,
      getFirestore: firestoreSdk.getFirestore,
      getAuth: authSdk.getAuth,
    }));
  }
  return sdkPromise;
}

export function firestoreEnabled() {
  return CONFIG.storageBackend === 'firestore';
}

function serviceAccountCredential(cert) {
  const encoded = process.env.FIREBASE_SERVICE_ACCOUNT_BASE64;
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON ||
    (encoded ? Buffer.from(encoded, 'base64').toString('utf8') : '');

  if (!raw.trim()) return null;

  let serviceAccount;
  try {
    serviceAccount = JSON.parse(raw);
  } catch {
    throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON/BASE64 is not valid JSON.');
  }

  return cert(serviceAccount);
}

export async function getFirebaseAdmin() {
  if (!firestoreEnabled()) {
    throw new Error('Firebase Admin is disabled; set STORAGE_BACKEND=firestore.');
  }
  if (!appPromise) {
    appPromise = loadSdk().then(({ getApps, initializeApp, applicationDefault, cert }) => {
      const existing = getApps();
      if (existing.length) return existing[0];
      const credential = serviceAccountCredential(cert) || applicationDefault();
      return initializeApp({
        credential,
        projectId: CONFIG.firebaseProjectId,
      });
    });
  }
  return appPromise;
}

export async function getFirestoreDb() {
  if (!firestoreDbPromise) {
    firestoreDbPromise = Promise.all([loadSdk(), getFirebaseAdmin()]).then(([{ getFirestore }, app]) => {
      const database = getFirestore(app);
      // Render deployments can leave the Admin SDK's default gRPC channel
      // pending indefinitely. REST is slower per request but bounded and
      // reliable for this demo's low-volume writes.
      database.settings({ preferRest: true });
      return database;
    });
  }
  return firestoreDbPromise;
}

export async function getFirebaseAuth() {
  const [{ getAuth }, app] = await Promise.all([loadSdk(), getFirebaseAdmin()]);
  return getAuth(app);
}
