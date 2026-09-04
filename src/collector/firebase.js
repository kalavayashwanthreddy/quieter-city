// firebase.js
// Central Firebase init — anonymous auth + Firestore writes for the collector.
//
// 🔑 Configured for the vibra-map Firebase project (Firebase console →
// Project settings → General → Your apps → SDK setup and configuration).
// While isFirebaseConfigured() is true the collector uploads every sample
// to Firestore IN ADDITION to the mock backend, and rewards are gated on
// a confirmed Firestore write.
//
// PRIVACY: only anonymous metadata is ever written — no raw audio, no exact
// GPS (samples already carry only a blurred ±100 m geohash cell). Every doc
// also carries the caller's anonymous uid so Firestore rules can scope
// writes to the author (see backend/firestore.rules.example).
//
// The SDK is loaded lazily (dynamic import) so the demo page stays light
// when Firebase isn't configured yet.

const firebaseConfig = {
  apiKey: 'AIzaSyCNEHsfSuLSqjGXisYq1vAkkHg_5oEUrhY',
  authDomain: 'vibra-map.firebaseapp.com',
  projectId: 'vibra-map',
  storageBucket: 'vibra-map.firebasestorage.app',
  messagingSenderId: '207032905743',
  appId: '1:207032905743:web:2b3bd8c3239f5b7671f37a',
  measurementId: 'G-JYRK08QZNG', // unused by this app (no analytics import)
}

const SAMPLES_COLLECTION = 'noise_samples'

export function isFirebaseConfigured() {
  return !!firebaseConfig.apiKey && !firebaseConfig.apiKey.startsWith('YOUR_')
}

let fbPromise = null

// One-shot lazy loader: returns { app, auth, db, collection, addDoc, serverTimestamp }.
function loadFirebase() {
  if (!fbPromise) {
    fbPromise = Promise.all([
      import('firebase/app'),
      import('firebase/auth'),
      import('firebase/firestore'),
    ]).then(([{ initializeApp }, authMod, fsMod]) => {
      const app = initializeApp(firebaseConfig)
      return {
        app,
        auth: authMod.getAuth(app),
        db: fsMod.getFirestore(app),
        collection: fsMod.collection,
        addDoc: fsMod.addDoc,
        serverTimestamp: fsMod.serverTimestamp,
        onAuthStateChanged: authMod.onAuthStateChanged,
        signInAnonymously: authMod.signInAnonymously,
      }
    })
    fbPromise.catch(() => { fbPromise = null }) // allow retry after a transient failure
  }
  return fbPromise
}

/**
 * Ensures the user has a persistent anonymous identity.
 * Firebase keeps the same uid across sessions on the SAME device/browser
 * (it's stored in IndexedDB under the hood), so this uid is what makes
 * rewards/history survive app restarts.
 *
 * NOTE: "cross-device" sync of the SAME identity requires either
 *   (a) linking this anonymous account to email/Google later
 *       (auth.currentUser.linkWithCredential(...)), or
 *   (b) your own persistent recovery code the user re-enters on a new device.
 * Pure anonymous auth alone does NOT sync across devices.
 */
export async function ensureAuth() {
  if (!isFirebaseConfigured()) {
    throw new Error('Firebase not configured — paste your config in src/collector/firebase.js')
  }
  const { auth, onAuthStateChanged, signInAnonymously } = await loadFirebase()
  return new Promise((resolve, reject) => {
    const unsub = onAuthStateChanged(
      auth,
      (user) => {
        unsub()
        if (user) {
          resolve(user.uid)
        } else {
          signInAnonymously(auth)
            .then((cred) => resolve(cred.user.uid))
            .catch(reject)
        }
      },
      reject,
    )
  })
}

/**
 * Maps the app's canonical metadata-only sample (see Uploader.buildSessionSample)
 * onto a Firestore document. Pure + exported so it can be unit-checked in
 * Node. No raw audio, no raw coordinates — ever.
 */
export function toFirestoreDoc(sample, uid) {
  return {
    uid, // anonymous Firebase uid — not a real identity, just a stable per-device handle
    sessionId: sample.sessionId ?? null,
    dba: Math.round(sample.dba * 10) / 10 ?? null,
    rmsDb: Math.round(sample.rmsDb * 10) / 10 ?? null,
    topClasses: (sample.topClasses ?? []).slice(0, 5), // [{name, score}] — class labels only
    dominantClass: sample.dominantClass ?? null,
    dominantType: sample.dominantType ?? null,
    speechScore: sample.speechScore ?? null,
    speechHandled: sample.speechHandled ?? 'none',
    // one-shot measurement: single server timestamp + per-recording durations
    durationSec: sample.durationSec ?? null,
    safeSec: sample.safeSec ?? null,
    speechSec: sample.speechSec ?? null,
    segments: (sample.segments ?? []).slice(0, 60), // env windows only — never audio
    geohash: sample.geohash ?? null, // blurred ~150 m cell — NEVER raw lat/lng
    cellLat: sample.cellLat ?? null, // cell CENTER, a public area point
    cellLng: sample.cellLng ?? null,
    createdAt: null, // replaced with a real serverTimestamp() at write time
  }
}

/**
 * Uploads one noise sample to Firestore. Only anonymous metadata goes up —
 * no raw audio, no exact GPS. Throws if Firebase isn't configured or the
 * write fails, so callers can gate rewards on a confirmed write.
 */
export async function getFirebaseIdToken(forceRefresh = false) {
  await ensureAuth()
  const { auth } = await loadFirebase()
  if (!auth.currentUser) throw new Error('Firebase authentication failed.')
  return auth.currentUser.getIdToken(forceRefresh)
}

export async function uploadSampleToFirebase(sample) {
  const uid = await ensureAuth()
  const { db, collection, addDoc, serverTimestamp } = await loadFirebase()
  const doc = toFirestoreDoc(sample, uid)
  doc.createdAt = serverTimestamp() // server-side clock — avoids device-clock drift
  const docRef = await addDoc(collection(db, SAMPLES_COLLECTION), doc)
  return docRef.id
}
