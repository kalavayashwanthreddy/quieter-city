import { useCallback, useEffect, useRef, useState } from 'react';
import MapView from './MapView.jsx';
import PlaceAutocomplete from './PlaceAutocomplete.jsx';
import { api } from '../shared/backend.js';
import { fetchOsrmRoutes, scoreRoute, rankRoutes } from './Router.js';
import { searchPlaces, reverseGeocode } from '../shared/geocode.js';

const DEFAULT_A = { lat: 12.9766, lng: 77.5924 }; // Cubbon Park
const DEFAULT_B = { lat: 12.9896, lng: 77.6505 }; // Airport Road area

const fmtPt = (p) => `${p.lat.toFixed(5)}, ${p.lng.toFixed(5)}`;

// A map point or GPS fix becomes a readable place name (reverse geocode),
// falling back to coordinates when the geocoder is unavailable.
const labelForPoint = async (pt) => (await reverseGeocode(pt.lat, pt.lng)) || fmtPt(pt);

export default function AgentApp() {
  const [tab, setTab] = useState('heatmap');
  const [cells, setCells] = useState([]);
  const [alerts, setAlerts] = useState([]);
  const [predictions, setPredictions] = useState([]);
  const [admins, setAdmins] = useState([]);
  const [health, setHealth] = useState(null);
  const [showForecast, setShowForecast] = useState(false);
  const [lastUpdated, setLastUpdated] = useState(null);
  const [toasts, setToasts] = useState([]);
  const seenAlertsRef = useRef(new Set()); // alert ids already shown as a toast
  const primedRef = useRef(false); // first poll seeds the seen-set without toasting

  // routing state. `fromConfirmed`/`toConfirmed` track whether the field text
  // corresponds to a REAL point (selection / map click / default) — manual
  // edits unconfirm it so we never route to a stale point.
  const [waypoints, setWaypoints] = useState({ a: { ...DEFAULT_A }, b: { ...DEFAULT_B } });
  const [fromText, setFromText] = useState(`${DEFAULT_A.lat}, ${DEFAULT_A.lng}`);
  const [toText, setToText] = useState(`${DEFAULT_B.lat}, ${DEFAULT_B.lng}`);
  const [fromConfirmed, setFromConfirmed] = useState(true);
  const [toConfirmed, setToConfirmed] = useState(true);
  const [routes, setRoutes] = useState([]);
  const [routesLoading, setRoutesLoading] = useState(false);
  const [routeError, setRouteError] = useState('');

  // live polling — "refresh data dynamically as available"
  const poll = useCallback(async () => {
    try {
      const [c, al, p, ad, h] = await Promise.all([
        api.getCells(),
        api.getAlerts(),
        api.getPredictions(),
        api.getAdmins(),
        api.health(),
      ]);
      setCells(c);
      setAlerts(al);
      setPredictions(p);
      setAdmins(ad);
      setHealth(h);
      setLastUpdated(new Date());

      // Toast ONLY genuinely new alerts. The first poll seeds the seen-set
      // so a page load doesn't blast the existing backlog at you.
      const active = al.filter((a) => a.status === 'active');
      if (!primedRef.current) {
        active.forEach((a) => seenAlertsRef.current.add(a.id));
        primedRef.current = true;
      } else {
        const fresh = active.filter((a) => !seenAlertsRef.current.has(a.id));
        if (fresh.length) {
          fresh.forEach((a) => seenAlertsRef.current.add(a.id));
          setToasts((t) => [
            ...t,
            ...fresh.map((a) => ({
              id: a.id,
              level: a.level,
              cell: a.cell,
              avgDba: a.avgDba,
              message: a.message,
            })),
          ].slice(-4)); // keep the stack bounded
        }
      }
    } catch (err) {
      console.warn('agent poll failed', err);
    }
  }, []);

  // Auto-dismiss toasts one at a time (newest stick around longest).
  useEffect(() => {
    if (!toasts.length) return;
    const t = setTimeout(() => setToasts((list) => list.slice(1)), 6000);
    return () => clearTimeout(t);
  }, [toasts]);

  const dismissToast = useCallback((id) => {
    setToasts((list) => list.filter((t) => t.id !== id));
  }, []);
  useEffect(() => {
    poll();
    const t = setInterval(poll, 5000);
    return () => clearInterval(t);
  }, [poll]);

  const parseLatLng = (s) => {
    const parts = s.split(',').map((x) => parseFloat(x.trim()));
    if (parts.length === 2 && !Number.isNaN(parts[0]) && !Number.isNaN(parts[1])) {
      return { lat: parts[0], lng: parts[1] };
    }
    return null;
  };

  // Shared route computation — used by the "Find routes" button AND by map
  // clicks (auto-routing once both endpoints are selected on the map).
  const computeRoutes = useCallback(async (a, b) => {
    setWaypoints({ a, b });
    setRoutesLoading(true);
    setRouteError('');
    setRoutes([]);
    try {
      // Road-graph alternatives from the routing engine, each scored against
      // the noise heatmap (75 m sampling, inverse-distance weighting, 55 dB
      // baseline for unmeasured stretches), then ranked with a 30% detour
      // guardrail — the quietest ACCEPTABLE route wins (quiet-route spec).
      const osrm = await fetchOsrmRoutes(a, b);
      const scored = osrm.map((r) => ({ ...r, ...scoreRoute(r.coords, cells) }));
      const all = rankRoutes(scored).map((r) => {
        let label = 'Alternative (OSRM)';
        let color = '#2b6cb0';
        if (r.quiet && r.fastest) { label = 'Fastest & quietest (AI)'; color = '#38a169'; }
        else if (r.quiet) { label = 'Quiet route (AI)'; color = '#38a169'; }
        else if (r.fastest) { label = 'Fastest (OSRM)'; color = '#3182ce'; }
        else if (r.detourTooLong) color = '#718096';
        return { ...r, label, color };
      });
      setRoutes(all);
    } catch (err) {
      setRouteError(err.message || 'Routing failed');
      console.error(err);
    } finally {
      setRoutesLoading(false);
    }
  }, [cells]);

  // Clicking the map picks A then B (third click rolls A → old B, B → new
  // point). The A/B fields update with the place name (reverse geocoded) and
  // routes compute right away once both endpoints are known.
  const handleMapClick = useCallback((latlng) => {
    const pt = { lat: latlng.lat, lng: latlng.lng };
    const next = !waypoints.a
      ? { a: pt, b: waypoints.b }
      : !waypoints.b
        ? { a: waypoints.a, b: pt }
        : { a: waypoints.b, b: pt };
    setWaypoints(next);
    if (next.a) {
      setFromConfirmed(true);
      labelForPoint(next.a).then(setFromText);
    } else {
      setFromText('');
    }
    if (next.b) {
      setToConfirmed(true);
      labelForPoint(next.b).then(setToText);
    } else {
      setToText('');
    }
    if (next.a && next.b) computeRoutes(next.a, next.b);
  }, [waypoints, computeRoutes]);

  // A confirmed point (place selection / map click / default) OR a raw
  // "lat, lng" string both resolve to coordinates — the spec's dual entry.
  const resolvePoint = useCallback((text, confirmed, pt) => {
    const parsed = parseLatLng(text);
    if (parsed) return parsed;
    if (confirmed && pt) return pt;
    return null;
  }, []);

  const findRoutes = useCallback(async () => {
    const a = resolvePoint(fromText, fromConfirmed, waypoints.a);
    const b = resolvePoint(toText, toConfirmed, waypoints.b);
    if (!a || !b) {
      setRouteError('Type a place name (pick from the suggestions) or exact "lat, lng" for both A and B.');
      return;
    }
    await computeRoutes(a, b);
  }, [fromText, toText, fromConfirmed, toConfirmed, waypoints, resolvePoint, computeRoutes]);

  // Place search for the autocomplete: also surfaces a "use exact
  // coordinates" option when the typed text parses as "lat, lng".
  const searchPlacesAround = useCallback(async (q) => {
    const places = await searchPlaces(q);
    const parsed = parseLatLng(q);
    if (parsed) {
      const dup = places.some((p) => Math.abs(p.lat - parsed.lat) < 1e-4 && Math.abs(p.lng - parsed.lng) < 1e-4);
      if (!dup) {
        places.unshift({
          name: 'Use exact coordinates',
          subtitle: `${parsed.lat.toFixed(5)}, ${parsed.lng.toFixed(5)}`,
          label: q,
          lat: parsed.lat,
          lng: parsed.lng,
        });
      }
    }
    return places;
  }, []);

  const selectFrom = useCallback((place) => {
    setFromText(place.label);
    setFromConfirmed(true);
    const a = { lat: place.lat, lng: place.lng };
    setWaypoints((w) => ({ a, b: w.b }));
    if (waypoints.b) computeRoutes(a, waypoints.b);
  }, [waypoints.b, computeRoutes]);

  const selectTo = useCallback((place) => {
    setToText(place.label);
    setToConfirmed(true);
    const b = { lat: place.lat, lng: place.lng };
    setWaypoints((w) => ({ a: w.a, b }));
    if (waypoints.a) computeRoutes(waypoints.a, b);
  }, [waypoints.a, computeRoutes]);

  const useMyLocation = useCallback(() => {
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const pt = { lat: pos.coords.latitude, lng: pos.coords.longitude };
        setWaypoints({ a: pt, b: waypoints.b });
        setFromConfirmed(true);
        labelForPoint(pt).then(setFromText);
        // Destination already known → route immediately.
        if (waypoints.b) computeRoutes(pt, waypoints.b);
      },
      () => setRouteError('Location permission denied'),
      { timeout: 8000 },
    );
  }, [waypoints.b, computeRoutes]);

  // Tap-to-solution from a citizen notification (spec §3.3): the collector
  // stores { from, to } of the suggested bypass route; land here with the
  // Routes tab open and that route already computed. Placed AFTER the
  // computeRoutes declaration (a useEffect dep array evaluates the binding).
  useEffect(() => {
    try {
      const raw = sessionStorage.getItem('qc-suggested-route');
      if (!raw) return;
      sessionStorage.removeItem('qc-suggested-route');
      const { from, to } = JSON.parse(raw);
      if (from && to) {
        setWaypoints({ a: from, b: to });
        setFromConfirmed(true);
        setToConfirmed(true);
        labelForPoint(from).then(setFromText);
        labelForPoint(to).then(setToText);
        setTab('routes');
        computeRoutes(from, to);
      }
    } catch { /* malformed — ignore */ }
  }, [computeRoutes]);

  return (
    <main className="agent">
      <div className="map-col">
        <MapView
          center={[12.9716, 77.5946]}
          cells={cells}
          alerts={alerts}
          predictions={predictions}
          routes={routes}
          waypoints={waypoints}
          onMapClick={handleMapClick}
          showForecast={showForecast}
        />
        <div className="map-hint">Click the map to set A, then B — place names auto-fill and routes auto-compute. Or type a place name in the panel.</div>
      </div>

      <aside className="panel">
        <div className="tabs">
          {['heatmap', 'routes', 'alerts', 'forecast'].map((t) => (
            <button key={t} className={`tab ${tab === t ? 'active' : ''}`} onClick={() => setTab(t)}>
              {t === 'heatmap' ? 'Heatmap' : t === 'routes' ? 'Routes' : t === 'alerts' ? 'Alerts' : 'Forecast'}
            </button>
          ))}
        </div>

        {tab === 'heatmap' && (
          <HeatmapPanel cells={cells} health={health} lastUpdated={lastUpdated} showForecast={showForecast} setShowForecast={setShowForecast} />
        )}
        {tab === 'routes' && (
          <RoutesPanel
            fromText={fromText} toText={toText}
            onEditFrom={(t) => { setFromText(t); setFromConfirmed(false); }}
            onEditTo={(t) => { setToText(t); setToConfirmed(false); }}
            onSelectFrom={selectFrom} onSelectTo={selectTo}
            searchPlaces={searchPlacesAround}
            routes={routes} routesLoading={routesLoading} routeError={routeError}
            findRoutes={findRoutes} useMyLocation={useMyLocation} waypoints={waypoints}
          />
        )}
        {tab === 'alerts' && <AlertsPanel alerts={alerts} admins={admins} onAck={async (id, adminId) => { await api.ackAlert(id, adminId); poll(); }} />}

      {/* live alert notifications — click to open the Alerts tab */}
      <div className="toasts">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={`toast ${t.level}`}
            onClick={() => { setTab('alerts'); dismissToast(t.id); }}
          >
            <div className="toast-head">
              <span className={`badge ${t.level}`}>{t.level}</span>
              <span className="toast-cell">cell {t.cell}</span>
            </div>
            <div className="toast-msg">🚨 {t.avgDba} dB(A) — new noise alert</div>
            <button className="toast-close" onClick={(e) => { e.stopPropagation(); dismissToast(t.id); }}>✕</button>
          </div>
        ))}
      </div>
        {tab === 'forecast' && <ForecastPanel predictions={predictions} cells={cells} showForecast={showForecast} setShowForecast={setShowForecast} />}
      </aside>
    </main>
  );
}

function HeatmapPanel({ cells, health, lastUpdated, showForecast, setShowForecast }) {
  return (
    <div className="panel-body">
      <h3>🗺️ Live noise heatmap</h3>
      <p className="muted">
        Aggregated from anonymous citizen samples in ~150 m cells. Green = quiet, red = loud, deep red = danger.
      </p>
      <div className="legend">
        <span className="sw" style={{ background: '#22c55e' }} /><span>quiet</span>
        <span className="sw" style={{ background: '#eab308' }} /><span>moderate</span>
        <span className="sw" style={{ background: '#ef4444' }} /><span>loud</span>
        <span className="sw" style={{ background: '#be123c' }} /><span>danger</span>
      </div>
      <div className="stats">
        <div><span className="big">{health ? health.cells : '–'}</span><span className="muted"> live cells</span></div>
        <div><span className="big">{health ? health.samples : '–'}</span><span className="muted"> samples</span></div>
        <div><span className="big warn">{health ? health.alerts : '–'}</span><span className="muted"> active alerts</span></div>
        <div><span className="big">{health ? health.predictions : '–'}</span><span className="muted"> hotspots forecast</span></div>
      </div>
      <label className="toggle">
        <input type="checkbox" checked={showForecast} onChange={(e) => setShowForecast(e.target.checked)} />
        <span>Show next-hour forecast on map</span>
      </label>
      <p className="muted small">
        {lastUpdated ? `Refreshed ${lastUpdated.toLocaleTimeString()} · auto-updates every 5 s` : 'Connecting…'}
      </p>
      <hr />
      <h4>Demo controls</h4>
      <div className="row">
        <button className="btn btn-sm" onClick={() => api.simStart().then(poll)}>▶ Start simulator</button>
        <button className="btn btn-sm" onClick={() => api.simStop().then(poll)}>⏸ Stop simulator</button>
        <button className="btn btn-sm btn-danger" onClick={() => { if (confirm('Reset all demo data?')) api.reset().then(poll); }}>
          ♻ Reset data
        </button>
      </div>
    </div>
  );
}

function RoutesPanel({ fromText, toText, onEditFrom, onEditTo, onSelectFrom, onSelectTo, searchPlaces, routes, routesLoading, routeError, findRoutes, useMyLocation, waypoints }) {
  return (
    <div className="panel-body">
      <h3>🧭 Noise-aware navigation</h3>
      <p className="muted">
        Type a place name (e.g. “Cubbon Park”) and pick the match, or paste exact
        “lat, lng” coordinates. The routing engine returns real road-based
        alternatives scored against the noise heatmap; the quietest acceptable
        route (≤30% longer than the fastest) wins.
      </p>
      <label className="field">
        <span>From (A)</span>
        <PlaceAutocomplete
          value={fromText} onEdit={onEditFrom} onSelect={onSelectFrom}
          search={searchPlaces} placeholder="e.g. Cubbon Park, Bengaluru"
        />
      </label>
      <label className="field">
        <span>To (B)</span>
        <PlaceAutocomplete
          value={toText} onEdit={onEditTo} onSelect={onSelectTo}
          search={searchPlaces} placeholder="e.g. MG Road Metro Station, Bengaluru"
        />
      </label>
      <div className="row">
        <button className="btn btn-primary" onClick={findRoutes} disabled={routesLoading}>
          {routesLoading ? 'Finding routes…' : 'Find routes'}
        </button>
        <button className="btn" onClick={useMyLocation}>📍 Use my location</button>
      </div>
      <p className="muted small">Tip: click the map twice to set A then B, or type a place name and pick a suggestion — fields auto-fill and routes start right away.</p>
      {routeError && <div className="notice bad">{routeError}</div>}

      {routes.length > 0 && (
        <div className="route-list">
          {routes.map((r, i) => (
            <div key={i} className={`route-card ${r.quiet ? 'quiet' : ''}`}>
              <div className="route-head">
                <span className="dot" style={{ background: r.color }} />
                <strong>{r.label}</strong>
                {r.quiet && <span className="badge">🤫 quietest pick</span>}
              </div>
              <div className="route-meta">
                <span>{r.distanceKm} km</span>
                {r.durationMin != null && <span>~{r.durationMin} min</span>}
                <span className={r.avgDba >= 70 ? 'warn' : ''}>avg {r.avgDba} dB(A)</span>
                <span className={r.noisyPct >= 40 ? 'warn' : ''}>{r.noisyPct}% in loud zones</span>
                {r.detourTooLong && <span className="bad">skipped — &gt;30% longer than fastest</span>}
              </div>
            </div>
          ))}
        </div>
      )}

      {waypoints.a && waypoints.b && (
        <p className="muted small">
          A: {waypoints.a.lat.toFixed(4)}, {waypoints.a.lng.toFixed(4)} · B: {waypoints.b.lat.toFixed(4)}, {waypoints.b.lng.toFixed(4)}
        </p>
      )}
    </div>
  );
}

function AlertsPanel({ alerts, admins, onAck }) {
  const [adminId, setAdminId] = useState('admin-bmc');
  const active = alerts.filter((a) => a.status === 'active');
  return (
    <div className="panel-body">
      <h3>🚨 Noise alerts</h3>
      <p className="muted">
        Triggered when a cell sustains ≥ 70 dB(A). Sent to admin-defined users below.
      </p>
      {active.length === 0 ? (
        <p className="muted">No active alerts. 🎉 (Simulated construction sites may change that…)</p>
      ) : (
        <ul className="alert-list">
          {alerts.map((a) => (
            <li key={a.id} className={`alert ${a.status}`}>
              <div className="alert-head">
                <span className={`badge ${a.level}`}>{a.level}</span>
                <span className="alert-cell">cell {a.cell}</span>
              </div>
              <div className="alert-msg">{a.message}</div>
              <div className="alert-meta">
                <span>{new Date(a.ts).toLocaleString()}</span>
                {a.status === 'active' ? (
                  <button className="btn btn-sm" onClick={() => onAck(a.id, adminId)}>✓ Acknowledge</button>
                ) : (
                  <span className="muted">acked by {a.ackedBy}</span>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
      <hr />
      <h4>Admin-defined alert recipients</h4>
      {admins.length === 0 ? (
        <p className="muted">Loading…</p>
      ) : (
        <ul className="admin-list">
          {admins.map((ad) => (
            <li key={ad.id}>
              <strong>{ad.name}</strong> <span className="muted">· {ad.role}</span>
              <div className="muted small">{ad.channels.join(' + ')}</div>
            </li>
          ))}
        </ul>
      )}
      <label className="field">
        <span>Acknowledge as</span>
        <select value={adminId} onChange={(e) => setAdminId(e.target.value)}>
          {admins.map((ad) => (
            <option key={ad.id} value={ad.id}>{ad.name}</option>
          ))}
        </select>
      </label>
    </div>
  );
}

function ForecastPanel({ predictions, showForecast, setShowForecast }) {
  const hotspots = predictions.filter((p) => p.hotspot);
  return (
    <div className="panel-body">
      <h3>🔮 Next-hour hotspots</h3>
      <p className="muted">
        Per-cell forecast blending the historical hourly profile with the live trend.
        “AI” for the demo — upgradeable to a trained model (see README).
      </p>
      <label className="toggle">
        <input type="checkbox" checked={showForecast} onChange={(e) => setShowForecast(e.target.checked)} />
        <span>Show on map</span>
      </label>
      {hotspots.length > 0 && (
        <>
          <h4>⚠ Expected hotspots (next hour)</h4>
          <ul className="alert-list">
            {hotspots.slice(0, 8).map((p, i) => (
              <li key={i} className="alert active">
                <div className="alert-msg">cell {p.cell} — {p.forecastDba} dB(A)</div>
                <div className="alert-meta">
                  <span>confidence {Math.round(p.confidence * 100)}%</span>
                  <span className="muted small">based on {p.basedOn}</span>
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
      <h4>All cell forecasts</h4>
      <table className="table">
        <thead><tr><th>cell</th><th>forecast</th><th>conf</th></tr></thead>
        <tbody>
          {predictions.slice(0, 25).map((p, i) => (
            <tr key={i} className={p.hotspot ? 'row-hot' : ''}>
              <td><code>{p.cell}</code></td>
              <td>{p.forecastDba} dB(A)</td>
              <td>{Math.round(p.confidence * 100)}%</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}