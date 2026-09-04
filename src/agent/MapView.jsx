import { useEffect, useRef } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import 'leaflet.heat';
import { QUIET_DBA, MODERATE_DBA, LOUD_DBA, DANGEROUS_DBA } from '../shared/schema.js';
import { escapeHtml } from '../shared/privacy.js';

// Level → color used by BOTH the cell dots and the map legend, so the map
// colours and the panel legend always agree.
export function levelColor(dba) {
  if (dba >= DANGEROUS_DBA) return '#be123c'; // deep red — danger
  if (dba >= LOUD_DBA) return '#ef4444';      // red — loud
  if (dba >= MODERATE_DBA) return '#f97316';  // orange — moderate+
  if (dba >= QUIET_DBA) return '#eab308';     // yellow — moderate
  return '#22c55e';                            // green — quiet
}

// Vivid heat gradient (leaflet.heat) — neon scale, danger pops magenta-red.
const HEAT_GRADIENT = {
  0.0: '#1d4ed8', // blue — quiet
  0.2: '#06b6d4', // cyan
  0.4: '#22c55e', // green
  0.55: '#eab308', // yellow
  0.7: '#f97316', // orange
  0.85: '#ef4444', // red — loud
  1.0: '#be123c', // deep magenta-red — danger
};

export default function MapView({ center, cells, alerts, predictions, routes, waypoints, onMapClick, showForecast }) {
  const divRef = useRef(null);
  const mapRef = useRef(null);
  const layersRef = useRef({ heat: null, cells: [], alerts: [], predictions: [], routes: [], waypoints: [] });
  const clickRef = useRef(onMapClick);
  clickRef.current = onMapClick;

  // init once
  useEffect(() => {
    if (mapRef.current) return;
    const map = L.map(divRef.current, { center, zoom: 13, zoomControl: true });
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '© OpenStreetMap contributors',
    }).addTo(map);
    const heat = L.heatLayer([], {
      radius: 30,
      blur: 24,
      max: 1,
      minOpacity: 0.4,
      gradient: HEAT_GRADIENT,
    }).addTo(map);
    map.on('click', (e) => clickRef.current && clickRef.current(e.latlng));

    // On-map legend (bottom-right) so the colours are self-explanatory.
    const legend = L.control({ position: 'bottomright' });
    legend.onAdd = () => {
      const el = L.DomUtil.create('div', 'map-legend');
      el.innerHTML = `
        <div class="legend-title">🔊 Noise level</div>
        <div class="legend-scale"></div>
        <div class="legend-row">
          <span>quiet</span><span>moderate</span><span>loud</span><span>danger</span>
        </div>
        <div class="legend-alert"><span class="legend-pulse"></span> active alert · <span class="legend-forecast">◉</span> forecast</div>`;
      return el;
    };
    legend.addTo(map);

    mapRef.current = map;
    layersRef.current.heat = heat;
    return () => {
      map.remove();
      mapRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // heat layer ← live cells (intensity = avgDba / 100)
  useEffect(() => {
    const heat = layersRef.current.heat;
    if (!heat) return;
    heat.setLatLngs(cells.map((c) => [c.lat, c.lng, Math.min(1, Math.max(0, c.avgDba / 100))]));
  }, [cells]);

  // per-cell colour dots — the "red zones" story made explicit; each dot is
  // coloured by its noise level with a tooltip of dB + dominant class.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    layersRef.current.cells.forEach((m) => m.remove());
    layersRef.current.cells = cells.map((c) =>
      L.circleMarker([c.lat, c.lng], {
        radius: 7,
        color: levelColor(c.avgDba),
        weight: 1.5,
        fillColor: levelColor(c.avgDba),
        fillOpacity: 0.45,
      })
        .addTo(map)
        .bindTooltip(
          `<b>${c.avgDba} dB(A)</b> · ${escapeHtml(c.dominantClass)}<br/>cell <code>${escapeHtml(c.cell)}</code> · ${c.count} samples`,
          { sticky: true },
        ),
    );
  }, [cells]);

  // alert circles (red, pulsing)
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    layersRef.current.alerts.forEach((m) => m.remove());
    layersRef.current.alerts = alerts.map((a) =>
      L.circleMarker([a.lat, a.lng], {
        radius: a.level === 'critical' ? 14 : 11,
        color: '#7f1d1d',
        weight: 2,
        fillColor: a.level === 'critical' ? '#be123c' : '#fc8181',
        fillOpacity: 0.9,
        className: 'alert-pulse',
      })
        .addTo(map)
        .bindPopup(`<b>${a.level.toUpperCase()}</b><br/>${escapeHtml(a.message)}<br/><small>${new Date(a.ts).toLocaleString()}</small>`),
    );
  }, [alerts]);

  // prediction markers (purple = expected hotspot, blue = quieter forecast)
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    layersRef.current.predictions.forEach((m) => m.remove());
    if (!showForecast) { layersRef.current.predictions = []; return; }
    layersRef.current.predictions = predictions.map((p) =>
      L.circleMarker([p.lat, p.lng], {
        radius: p.hotspot ? 9 : 6,
        color: p.hotspot ? '#6b21a8' : '#2563eb',
        weight: 1.5,
        fillColor: p.hotspot ? '#a855f7' : '#60a5fa',
        fillOpacity: 0.7,
      })
        .addTo(map)
        .bindPopup(`<b>Forecast next hour: ${p.forecastDba} dB(A)</b> (${p.hotspot ? '⚠ expected hotspot' : 'ok'})<br/>confidence ${Math.round(p.confidence * 100)}%`),
    );
  }, [predictions, showForecast]);

  // route polylines
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    layersRef.current.routes.forEach((p) => p.remove());
    layersRef.current.routes = routes.map((r) =>
      L.polyline(r.coords.map(([lng, lat]) => [lat, lng]), {
        color: r.color,
        weight: r.quiet ? 6 : 4,
        opacity: 0.9,
        dashArray: r.quiet ? null : '8 6',
      }).addTo(map),
    );
    if (routes.length) {
      const pts = routes.flatMap((r) => r.coords.map(([lng, lat]) => [lat, lng]));
      if (waypoints.a) pts.push([waypoints.a.lat, waypoints.a.lng]);
      if (waypoints.b) pts.push([waypoints.b.lat, waypoints.b.lng]);
      map.fitBounds(L.latLngBounds(pts).pad(0.25));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routes]);

  // waypoint markers
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    layersRef.current.waypoints.forEach((m) => m.remove());
    const marks = [];
    if (waypoints.a) {
      marks.push(L.circleMarker([waypoints.a.lat, waypoints.a.lng], { radius: 10, color: '#276749', fillColor: '#38a169', fillOpacity: 0.9, weight: 2 }).addTo(map).bindPopup('<b>A</b> — start'));
    }
    if (waypoints.b) {
      marks.push(L.circleMarker([waypoints.b.lat, waypoints.b.lng], { radius: 10, color: '#9b2c2c', fillColor: '#e53e3e', fillOpacity: 0.9, weight: 2 }).addTo(map).bindPopup('<b>B</b> — destination'));
    }
    layersRef.current.waypoints = marks;
  }, [waypoints]);

  return <div ref={divRef} className="map" />;
}