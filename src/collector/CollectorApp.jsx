import { useCallback, useEffect, useRef, useState } from 'react';
import { v4 as uuidv4 } from 'uuid';
import { NoiseEngine } from './audioCapture.js';
import { loadClassifier, isClassifierReady } from './YamnetAnalyzer.js';
import { RealTimeAnalyzer } from './SessionAnalyzer.js';
import { buildSessionSample, uploadSample } from './Uploader.js';
import { REWARDS, NOTIFICATIONS, levelLabel, MODERATE_DBA, LOUD_DBA, DANGEROUS_DBA } from '../shared/schema.js';
import { cellFor, blurLocation } from '../shared/geohash.js';
import { getSessionId, localDayKey } from './sessionAndAlerts.js';
import { api } from '../shared/backend.js';
import { isFirebaseConfigured, uploadSampleToFirebase } from './firebase.js';
import { loadRewards, saveRewards, computeReward } from '../shared/rewards.js';

const hourLabel = (h) => {
  const hh = ((h % 24) + 24) % 24;
  const ampm = hh < 12 ? 'AM' : 'PM';
  const h12 = hh % 12 === 0 ? 12 : hh % 12;
  return `${h12} ${ampm}`;
};

const fmtSec = (s) => `${Math.round((s || 0) * 10) / 10}s`;
const withTimeout = (promise, ms, label) => Promise.race([
  promise,
  new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out`)), ms)),
]);

export default function CollectorApp() {
  const [aiStatus, setAiStatus] = useState('loading'); // loading | ready | error
  const [phase, setPhase] = useState('idle'); // idle | recording | analyzing | report
  const [loc, setLoc] = useState(null); // { lat, lng } — ALWAYS the blurred point (±100 m), kept only in memory
  const [locError, setLocError] = useState('');
  const [locPrompt, setLocPrompt] = useState(false); // location consent step before first request
  const locChoiceRef = useRef(null); // 'blurred' | 'none' — remember the citizen's choice for later sessions
  const [meter, setMeter] = useState(null); // { dba, level }
  const [elapsedSec, setElapsedSec] = useState(0);
  const [liveStats, setLiveStats] = useState(null); // { safeSec, speechSec, windowCount } while recording
  const [report, setReport] = useState(null); // summarizeWindows() result of the last recording
  const [uploaded, setUploaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [rewards, setRewards] = useState(loadRewards);
  const [log, setLog] = useState([]);
  const [cell, setCell] = useState(null);

  // watched-area notifications (spec §3 — opt-in, never linked to samples/rewards)
  const [watch, setWatch] = useState(false);
  const [notifToasts, setNotifToasts] = useState([]);
  const [solution, setSolution] = useState(null); // { type: 'window'|'route', ... }
  const notifSeenRef = useRef(new Set());
  const subscriberIdRef = useRef(
    typeof localStorage !== 'undefined' ? localStorage.getItem('qc-notif-subscriber') : null,
  );

  const engineRef = useRef(null);
  const analyzerRef = useRef(null); // RealTimeAnalyzer for the active recording
  const locRef = useRef(null);
  const sessionIdRef = useRef(getSessionId()); // daily-rotating anonymous id (see sessionAndAlerts.js)
  const rewardsRef = useRef(rewards);
  rewardsRef.current = rewards;

  // Load the AI model once on mount (used when the recording is analyzed).
  useEffect(() => {
    let alive = true;
    loadClassifier()
      .then(() => alive && setAiStatus('ready'))
      .catch((err) => {
        console.error('YAMNet load failed', err);
        alive && setAiStatus('error');
      });
    return () => { alive = false; };
  }, []);

  const addLog = useCallback((entry) => {
    setLog((l) => [{ id: Date.now() + '-' + Math.random().toString(36).slice(2, 6), ...entry }, ...l].slice(0, 12));
  }, []);

  // Spec §4/§6: base +1, streak by calendar day (cap +5), diversity +2 per new
  // geohash-4 area per day (cap 10). Awarded ONLY after a confirmed accepted
  // write — recordings with no safe windows never reach here.
  const award = useCallback((geohash) => {
    const { next, points, base, streakBonus, diversity } = computeReward(rewardsRef.current, {
      now: Date.now(),
      dayKey: localDayKey(),
      cellPrefix4: geohash ? geohash.slice(0, 4) : null,
    });
    setRewards(next);
    saveRewards(next);
    return { points, base, streakBonus, diversity };
  }, []);

  // Publish one recording's aggregate (the ONLY accepted unit) and award on a
  // confirmed write. Rejected readings (rate limit, movement) earn nothing.
  const publishSample = useCallback(async (sample) => {
    let localOk = false;
    let rejected = null;
    let uploadError = null;
    let apiResult = null;
    try {
      apiResult = await withTimeout(uploadSample(sample), 15000, 'API upload');
      localOk = true;
    } catch (err) {
      uploadError = err;
      if (err.code === 'rate-limited' || err.code === 'movement-suspicious') {
        rejected = err;
      } else {
        console.error('local API upload failed', err); // Firebase may still take it
      }
    }

    // If the API is temporarily unavailable or rejects authentication, retry
    // the same metadata-only sample directly through Firebase. Never bypass a
    // deliberate anti-abuse rejection (rate limit or movement check).
    const fbOn = isFirebaseConfigured() && !localOk && !rejected;
    let firebaseOk = false;
    if (fbOn) {
      try {
        await withTimeout(uploadSampleToFirebase(sample), 15000, 'Firebase upload');
        firebaseOk = true;
      } catch (err) {
        uploadError = err;
        console.error('Firebase upload failed', err);
      }
    }

    if ((localOk) || (fbOn && firebaseOk)) {
      const serverReward = apiResult?.reward;
      const { points, base, streakBonus, diversity } = serverReward || award(sample.geohash);
      if (serverReward?.state) {
        setRewards(serverReward.state);
        saveRewards(serverReward.state);
      }
      const breakdown =
        `+${base}` +
        (streakBonus ? ` · streak +${streakBonus}` : '') +
        (diversity ? ` · new area +${diversity}` : '');
      setUploaded(true);
      addLog({
        dba: sample.dba,
        type: 'accepted',
        label: `+${points} pts (${breakdown}) · uploaded ${fmtSec(sample.safeSec)} environmental data` +
          (sample.speechSec > 0 ? ` · ${fmtSec(sample.speechSec)} human voice discarded on-device` : '') +
          (firebaseOk ? ' · synced to Firebase' : ' · saved locally — no Firebase keys yet'),
      });
      return true;
    }

    if (rejected && rejected.code === 'rate-limited') {
      addLog({
        dba: sample.dba,
        type: 'info',
        label: `⏳ rate-limited (anti-abuse) — next OK in ~${Math.ceil((rejected.retryInMs || 8000) / 1000)}s`,
      });
    } else if (rejected) {
      addLog({ dba: sample.dba, type: 'info', label: '⛔ rejected: implausible movement (anti-abuse)' });
    } else {
      addLog({
        dba: sample.dba,
        type: 'error',
        label: `${fbOn ? 'cloud sync failed' : 'sample not saved'} — ${uploadError?.message || 'is the API running?'}`,
      });
    }
    return false;
  }, [award, addLog]);

  // ---- recording session (real-time chunk analysis) -------------------------
  // The mic engine hands each completed ~1 s chunk to the analyzer immediately
  // (spec §2: analyze chunks WHILE recording); speech/uncertain chunks are
  // discarded on-device as they arrive. STOP only flushes the final partial
  // tail chunk and aggregates what was already classified.
  const startRecording = useCallback(async () => {
    setReport(null);
    setUploaded(false);
    setMeter(null);
    setElapsedSec(0);
    setLiveStats(null);
    const analyzer = new RealTimeAnalyzer({
      onWindow: (rec, summary) =>
        setLiveStats({
          safeSec: summary.safeSec,
          speechSec: summary.speechSec,
          windowCount: summary.windowCount,
          privateCount: summary.speechWindowCount,
        }),
    });
    analyzerRef.current = analyzer;
    const engine = new NoiseEngine({
      onMeter: (m) => {
        setMeter({ dba: m.dba, level: m.dba == null ? null : levelLabel(m.dba) });
        if (m.elapsedSec != null) setElapsedSec(m.elapsedSec);
      },
      onChunk: (chunk) => {
        const a = analyzerRef.current;
        if (a) a.pushChunk(chunk);
      },
      onCap: () => {
        // session hit the 30 s cap → auto-stop and finalize
        if (engineRef.current) stopAndAnalyzeRef.current();
      },
    });
    engineRef.current = engine;
    try {
      await engine.start();
      setPhase('recording');
      addLog({
        dba: null,
        type: 'info',
        label: locRef.current
          ? '🎙 Recording — each second is classified on-device as it arrives; nothing leaves the device'
          : '🎙 Recording without location — results stay on-device',
      });
    } catch (err) {
      setLocError('Mic access denied. Enable microphone permission to contribute noise data.');
      console.error('mic start failed', err);
    }
  }, [addLog]);

  const stopAndAnalyze = useCallback(async () => {
    const engine = engineRef.current;
    if (!engine) return;
    engineRef.current = null;
    engine.stop();
    const analyzer = analyzerRef.current;
    if (!analyzer) {
      setPhase('idle');
      return;
    }
    setPhase('analyzing');

    if (aiStatus === 'error') {
      const tail = engine.takeTail();
      if (tail) tail.fill(0);
      analyzer.wipe();
      addLog({
        dba: null,
        type: 'error',
        label: 'AI model unavailable — recording discarded on-device (no speech check possible).',
      });
      analyzerRef.current = null;
      setPhase('idle');
      return;
    }
    if (!isClassifierReady()) {
      await loadClassifier().catch(() => { });
    }

    try {
      // Flush the final partial chunk into the (already-draining) analyzer.
      const tail = engine.takeTail();
      if (tail) analyzer.pushChunk(tail);
      const summary = await analyzer.finish();
      analyzerRef.current = null;
      if (summary.windowCount === 0) {
        addLog({ dba: null, type: 'info', label: 'Recording too short — keep it at least 2 seconds.' });
        setPhase('idle');
        return;
      }
      setReport(summary);
      setPhase('report');
    } catch (err) {
      console.error('session analysis failed', err);
      analyzerRef.current = null;
      addLog({ dba: null, type: 'error', label: 'Analysis failed — raw audio was wiped, nothing uploaded.' });
      setPhase('idle');
    }
  }, [aiStatus, addLog]);
  const stopAndAnalyzeRef = useRef(stopAndAnalyze);
  stopAndAnalyzeRef.current = stopAndAnalyze;

  // Start sensing: consent step first, then record.
  const startSensing = useCallback(() => {
    setLocError('');
    if (locChoiceRef.current) {
      // The citizen already decided earlier — reuse it, don't nag.
      if (locChoiceRef.current === 'blurred' && !locRef.current) locRef.current = loc;
      startRecording();
      return;
    }
    setLocPrompt(true);
  }, [loc, startRecording]);

  // Step 2: citizen allows approximate location → blur to ±100 m, then record.
  const requestLocationAndStart = useCallback(async () => {
    setLocPrompt(false);
    setLocError('');
    if (!navigator.geolocation) {
      setLocError('Geolocation is not supported by this browser — continuing without location.');
      locChoiceRef.current = 'none';
      startRecording();
      return;
    }
    const got = await new Promise((resolve) => {
      navigator.geolocation.getCurrentPosition(
        (pos) => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
        () => resolve(null),
        { enableHighAccuracy: false, timeout: 12000, maximumAge: 300000 },
      );
    });
    if (!got) {
      setLocError('Location permission denied — measuring on-device only; samples won’t join the city heatmap.');
      locChoiceRef.current = 'none';
      startRecording();
      return;
    }
    // Blur immediately: the exact fix is replaced by a random point within 100 m.
    const blurred = blurLocation(got, 100);
    locRef.current = blurred;
    setLoc(blurred);
    setCell(cellFor(blurred.lat, blurred.lng));
    locChoiceRef.current = 'blurred';
    startRecording();
  }, [startRecording]);

  // Step 2 (alt): citizen declines location — mic-only mode, nothing uploaded.
  const continueWithoutLocation = useCallback(() => {
    setLocPrompt(false);
    setLocError('');
    locChoiceRef.current = 'none';
    locRef.current = null;
    setCell(null);
    addLog({ dba: null, type: 'info', label: 'No location shared — recording stays on-device' });
    startRecording();
  }, [startRecording, addLog]);

  // Review step: upload ONLY the environmental aggregate (speech was discarded
  // before this point and never exists in the sample).
  const uploadReport = useCallback(async () => {
    const location = locRef.current;
    if (!location || !report || !report.aggregate) return;
    setBusy(true);
    try {
      const sample = buildSessionSample({
        location,
        sessionId: sessionIdRef.current,
        summary: report,
      });
      await publishSample(sample);
    } finally {
      setBusy(false);
    }
  }, [report, publishSample]);

  const discardReport = useCallback(() => {
    addLog({
      dba: null,
      type: 'privacy',
      label: report && report.speechSec > 0
        ? `🗑 Recording deleted — ${fmtSec(report.speechSec)} of speech was discarded on-device, nothing uploaded`
        : '🗑 Recording deleted — nothing uploaded',
    });
    setReport(null);
    setUploaded(false);
    setPhase('idle');
  }, [report, addLog]);

  // ---- watched-area notifications (spec §3) --------------------------------
  const subscribe = useCallback(async () => {
    const location = locRef.current;
    if (!location) {
      setLocError('Allow approximate location first — notifications need a watched area (never your exact position).');
      return;
    }
    let subId = subscriberIdRef.current;
    if (!subId) {
      subId = uuidv4(); // browser-scoped delivery address — NOT a readings session id
      subscriberIdRef.current = subId;
      localStorage.setItem('qc-notif-subscriber', subId);
    }
    const watched = cellFor(location.lat, location.lng, 5); // ~5 km area
    try {
      await api.subscribe({ subscriberId: subId, watchedGeohash5: watched, radiusCells: 1 });
      setWatch(true);
      addLog({ dba: null, type: 'info', label: `🔔 Watching ${watched} (≈5 km area) for noise alerts` });
    } catch (err) {
      console.error('subscribe failed', err);
      setLocError('Could not subscribe — is the API running?');
    }
  }, [addLog]);

  const unsubscribe = useCallback(async () => {
    setWatch(false);
    if (subscriberIdRef.current) {
      try { await api.unsubscribe(subscriberIdRef.current); } catch { /* fine */ }
    }
    addLog({ dba: null, type: 'info', label: '🔕 Stopped watching area alerts' });
  }, [addLog]);

  // Poll for new notifications while watching; toast only genuinely new ones.
  useEffect(() => {
    if (!watch) return;
    let alive = true;
    const pollNotifs = async () => {
      const subId = subscriberIdRef.current;
      if (!subId) return;
      try {
        const list = await api.getNotifications(subId);
        const fresh = list.filter((n) => !notifSeenRef.current.has(n.id));
        fresh.forEach((n) => notifSeenRef.current.add(n.id));
        if (fresh.length && alive) {
          setNotifToasts((t) => [...t, ...fresh.map((n) => ({ id: n.id, ...n }))].slice(-3));
        }
      } catch { /* backend not up — retry next poll */ }
    };
    pollNotifs();
    const t = setInterval(pollNotifs, NOTIFICATIONS.pollMs);
    return () => { alive = false; clearInterval(t); };
  }, [watch]);

  // Auto-dismiss notification toasts.
  useEffect(() => {
    if (!notifToasts.length) return;
    const t = setTimeout(() => setNotifToasts((l) => l.slice(1)), 7000);
    return () => clearTimeout(t);
  }, [notifToasts]);

  // Tap-to-solution (§3.3): traffic alert → open the agent dashboard with a
  // bypass route pre-filled; prediction alert → show the suggested window.
  const openNotification = useCallback((n) => {
    setNotifToasts((l) => l.filter((x) => x.id !== n.id));
    if (n.type === 'traffic' && n.solution && n.solution.type === 'route') {
      try {
        sessionStorage.setItem('qc-suggested-route', JSON.stringify({ from: n.solution.from, to: n.solution.to }));
      } catch { /* private mode */ }
      window.location.hash = '#/agent';
    } else if (n.type === 'prediction') {
      setSolution(n.solution || { type: 'window', hour: n.hour, forecastDba: n.forecastDba, before: null, after: null });
    }
  }, []);

  useEffect(() => () => { if (engineRef.current) engineRef.current.stop(); }, []);

  const meterPct = meter && meter.dba != null ? Math.min(100, Math.max(0, ((meter.dba - 35) / 55) * 100)) : 0;
  const meterColor = !meter || meter.dba == null ? 'var(--muted)'
    : meter.dba >= DANGEROUS_DBA ? 'var(--danger)'
      : meter.dba >= LOUD_DBA ? 'var(--warn)'
        : meter.dba >= MODERATE_DBA ? 'var(--amber)'
          : 'var(--ok)';

  const recording = phase === 'recording';
  const analyzing = phase === 'analyzing';

  return (
    <main className="collect">
      <section className="hero card">
        <div className="meter-wrap">
          <div className="meter-number" style={{ color: meterColor }}>{meter && meter.dba != null ? Math.round(meter.dba) : '–'}</div>
          <div className="meter-label">{meter && meter.dba != null ? `dB(A) · ${meter.level}` : 'dB(A)'}</div>
          <div className="meter-bar"><div className="meter-fill" style={{ width: meterPct + '%', background: meterColor }} /></div>
        </div>
        <div className="hero-side">
          <h2>Your phone is a noise sensor</h2>
          <p>
            Tap <strong>Record</strong> and hold still — your phone analyzes the live mic stream{' '}
            <strong>in ~1-second chunks, on-device, as you record</strong> (YAMNet, 521 sound classes).
            Any chunk containing — or ambiguously resembling — <strong>human speech is marked PRIVATE and
              discarded immediately</strong>, never retained or uploaded. Only the environmental chunks'
            metadata (dB, noise type, blurred ±100 m cell, duration) is kept and aggregated at{' '}
            <strong>Stop</strong>. <strong>Raw audio never leaves your device, and each chunk is wiped the
              moment its analysis finishes.</strong>
          </p>
          <div className="ai-status">
            {aiStatus === 'loading' && <span className="pulse">◌ Loading AI model (~2 MB)…</span>}
            {aiStatus === 'ready' && <span className="ok">✔ AI ready — on-device classification</span>}
            {aiStatus === 'error' && <span className="bad">✖ AI model failed to load — recordings can’t be privacy-checked</span>}
          </div>

          {phase === 'idle' && (
            <button className="btn btn-primary btn-big" onClick={startSensing} disabled={aiStatus !== 'ready'}>
              {aiStatus === 'loading' ? 'Loading AI model…' : aiStatus === 'error' ? 'AI unavailable — reload to retry' : '🎙 Record noise'}
            </button>
          )}
          {recording && (
            <div className="rec-bar">
              <span className="rec-dot" /> REC {Math.floor(elapsedSec)}s
              {liveStats && (
                <span className="live-stats">
                  ⚡ live: <b className="ok">{fmtSec(liveStats.safeSec)}</b> environmental ·{' '}
                  <b className={liveStats.speechSec > 0 ? 'bad' : ''}>{fmtSec(liveStats.speechSec)}</b> private (discarded)
                </span>
              )}
              <button className="btn btn-danger btn-big" onClick={stopAndAnalyze}>⏹ Stop &amp; analyze</button>
            </div>
          )}
          {analyzing && (
            <div className="analyzing">
              <span className="pulse">◌ Finalizing on-device analysis (last chunk)…</span>
            </div>
          )}
          {phase === 'report' && (
            <div className="rec-bar">
              <button className="btn btn-primary btn-big" onClick={startRecording} disabled={busy}>
                🎙 New recording
              </button>
              <button className="btn btn-sm" onClick={discardReport} disabled={busy}>🗑 Discard</button>
            </div>
          )}
          {locError && <div className="notice">{locError}</div>}
          {loc && <div className="loc-line">📍 Contributing to cell <code>{cell}</code> — exact GPS blurred to <strong>±100 m</strong>, true position never sent</div>}
        </div>
      </section>

      {report && phase === 'report' && (
        <SessionReport
          report={report}
          uploaded={uploaded}
          busy={busy}
          hasLoc={!!locRef.current}
          canUpload={!!locRef.current && !uploaded}
          onUpload={uploadReport}
          onDiscard={discardReport}
        />
      )}

      <section className="grid2">
        <div className="card">
          <h3>🏅 Rewards</h3>
          <div className="reward-row">
            <div><span className="big">{rewards.points}</span><span className="muted"> points</span></div>
            <div><span className="big">{rewards.streakDays}</span><span className="muted"> day streak</span></div>
            <div><span className="big">{rewards.distinctCellsToday.length}</span><span className="muted"> new areas today</span></div>
          </div>
          <p className="muted small">
            +1 per validated recording · +1/day streak (cap +{REWARDS.streakBonusCap}) · +{REWARDS.diversityBonus} the
            first recording in a new ~20 km area per day (max {REWARDS.diversityCapPerDay}). Recordings with no safe
            environmental windows (all speech/uncertain), rate-limit or movement rejections earn nothing. Stored
            locally on your device; never linked to your recordings.
          </p>
        </div>

        <div className="card">
          <h3>🔔 Noise alerts for my area</h3>
          <p className="muted small">
            Opt-in: get a notification when noise spikes — or is predicted to spike — in the ~5 km
            area around your (blurred) location. Only the area is shared; never your exact
            position, and never linked to your recordings or rewards.
          </p>
          {watch ? (
            <>
              <p className="ok">Watching your area for spikes &amp; forecasts</p>
              <button className="btn btn-sm" onClick={unsubscribe}>🔕 Stop watching</button>
            </>
          ) : (
            <button className="btn btn-sm" onClick={subscribe} disabled={!loc}>🔔 Watch my area</button>
          )}
          {!loc && <p className="muted small">Allow approximate location first to watch your area.</p>}
        </div>
      </section>

      <section className="card">
        <h3>📋 Activity</h3>
        {log.length === 0 ? (
          <p className="muted">No recordings yet. Hit “Record noise” and make some noise! 🔊</p>
        ) : (
          <ul className="log">
            {log.map((l) => (
              <li key={l.id} className={`log-${l.type}`}>
                <span className="log-time">{new Date(l.ts ?? Date.now()).toLocaleTimeString()}</span>
                <span>{l.dba != null ? `${l.dba} dB(A) · ` : ''}{l.label}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* watched-area notification toasts — tap for the solution view */}
      {notifToasts.length > 0 && (
        <div className="toasts">
          {notifToasts.map((n) => (
            <div key={n.id} className={`toast ${n.type === 'traffic' ? 'high' : ''}`} onClick={() => openNotification(n)}>
              <div className="toast-head">
                <span className="toast-cell">{n.type === 'traffic' ? '🔴 noise spike' : '🔮 forecast'}</span>
              </div>
              <div className="toast-msg">{n.message}</div>
              <button
                className="toast-close"
                onClick={(e) => { e.stopPropagation(); setNotifToasts((l) => l.filter((x) => x.id !== n.id)); }}
              >✕</button>
            </div>
          ))}
        </div>
      )}

      {/* tap-to-solution: predicted noisy window (§3.3) */}
      {solution && solution.type === 'window' && (
        <div className="modal-backdrop">
          <div className="modal">
            <div className="modal-icon">🔮</div>
            <h3>Predicted noisy window</h3>
            <p>
              An area near you is predicted to hit <strong>~{solution.forecastDba} dB(A)</strong>{' '}
              around <strong>{hourLabel(solution.hour)}–{hourLabel(solution.hour + 1)}</strong>.
            </p>
            {solution.before != null && solution.after != null && (
              <p>
                Consider passing through <strong>before {hourLabel(solution.before)}</strong> or{' '}
                <strong>after {hourLabel(solution.after)}</strong> based on today's forecast.
              </p>
            )}
            <div className="modal-actions">
              <button className="btn btn-primary" onClick={() => setSolution(null)}>Got it</button>
            </div>
          </div>
        </div>
      )}

      {locPrompt && (
        <div className="modal-backdrop">
          <div className="modal">
            <div className="modal-icon">📍</div>
            <h3>Share your approximate location?</h3>
            <p>
              Your GPS is used <strong>once</strong> so your noise recordings can join the city
              heatmap. For privacy, the exact coordinate is <strong>blurred on-device</strong>{' '}
              to a random point within <strong>±100 m</strong> — your precise position is never
              stored, uploaded, or visible to anyone, and only the anonymous area cell is used.
            </p>
            <div className="modal-actions">
              <button className="btn btn-primary" onClick={requestLocationAndStart}>
                Allow approximate location (±100 m)
              </button>
              <button className="btn" onClick={continueWithoutLocation}>
                Continue without location
              </button>
            </div>
            <p className="modal-foot">
              Either way, raw audio never leaves your device. With no location, recordings are
              still analyzed privately but don’t reach the city heatmap.
            </p>
          </div>
        </div>
      )}
    </main>
  );
}

// ---- Session report: what the privacy filter found in the last recording ----
function SessionReport({ report, uploaded, busy, canUpload, hasLoc, onUpload, onDiscard }) {
  const { aggregate } = report;
  const noSafeData = !aggregate;
  return (
    <section className="card report">
      <h3>📊 Recording analysis (on-device)</h3>
      <div className="report-stats">
        <div><span className="big">{fmtSec(report.totalSec)}</span><span className="muted"> recorded</span></div>
        <div><span className="big ok">{fmtSec(report.safeSec)}</span><span className="muted"> environmental ✓</span></div>
        <div><span className={`big ${report.speechSec > 0 ? 'bad' : ''}`}>{fmtSec(report.speechSec)}</span><span className="muted"> private (discarded)</span></div>
        <div>
          <span className="big">{aggregate ? aggregate.dba : '–'}</span>
          <span className="muted"> dB(A) avg</span>
        </div>
      </div>

      {report.speechSec > 0 && (
        <div className="notice bad">
          ⚠ {report.speechWindowCount} window{report.speechWindowCount > 1 ? 's' : ''} contained or resembled human
          voice — marked <strong>PRIVATE and discarded on-device</strong>. They were never retained, uploaded, or
          included in the totals above. Raw audio was deleted after analysis.
        </div>
      )}
      {report.windowCount > 0 && report.safeSec === 0 && (
        <div className="notice bad">
          No safe environmental windows were found (everything was speech or too ambiguous to rule out
          voice). <strong>Nothing was uploaded.</strong> Try recording in a spot with less talking.
        </div>
      )}

      {aggregate && (
        <>
          <p className="muted small">
            Dominant noise: <strong>{aggregate.dominantClass}</strong> ({aggregate.dominantType})
            {aggregate.topClasses.length > 1 && (
              <> · also {aggregate.topClasses.slice(1, 4).map((c) => c.name).join(', ')}</>
            )}
          </p>
          {report.segments.length > 0 && (
            <>
              <h4>Safe environmental windows ({report.segments.length})</h4>
              <div className="seg-list">
                {report.segments.map((s, i) => (
                  <div key={i} className="seg">
                    <span className="seg-time">{s.start.toFixed(1)}–{s.end.toFixed(1)}s</span>
                    <span className="seg-sound">{s.soundType}</span>
                    <span className="seg-dba">{s.dba} dB(A)</span>
                  </div>
                ))}
              </div>
            </>
          )}
          {!hasLoc && (
            <div className="notice">No location shared — this recording stays on your device. Nothing uploaded.</div>
          )}
        </>
      )}

      <div className="modal-actions">
        {noSafeData ? (
          <button className="btn btn-danger" onClick={onDiscard} disabled={busy}>🗑 Delete recording</button>
        ) : uploaded ? (
          <span className="ok">✔ Uploaded — only the environmental metadata above left your device.</span>
        ) : (
          <>
            <button className="btn btn-primary" onClick={onUpload} disabled={busy || !canUpload}>
              {busy ? 'Uploading…' : canUpload ? `⬆ Upload only safe data (${fmtSec(report.safeSec)})` : 'No location — cannot upload'}
            </button>
            <button className="btn btn-danger" onClick={onDiscard} disabled={busy}>🗑 Discard all</button>
          </>
        )}
      </div>
      <p className="modal-foot">
        Every chunk's raw audio was wiped the moment its on-device analysis finished. Even here,
        “Upload” sends <strong>no audio</strong> — only the metadata table above, with no speech windows in it.
      </p>
    </section>
  );
}
