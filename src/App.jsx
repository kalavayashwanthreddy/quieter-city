import { useEffect, useState } from 'react';
import CollectorApp from './collector/CollectorApp.jsx';
import AgentApp from './agent/AgentApp.jsx';
import { api } from './shared/backend.js';

function useHashRoute() {
  const [route, setRoute] = useState(() => window.location.hash || '#/collect');
  useEffect(() => {
    const onHash = () => setRoute(window.location.hash || '#/collect');
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  return route;
}

export default function App() {
  const route = useHashRoute();
  const [health, setHealth] = useState(null);

  useEffect(() => {
    let alive = true;
    const poll = async () => {
      try {
        const h = await api.health();
        if (alive) setHealth(h);
      } catch { /* backend not up yet */ }
    };
    poll();
    const t = setInterval(poll, 10000);
    return () => { alive = false; clearInterval(t); };
  }, []);

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">🎧 Quieter City</div>
        <nav>
          <a className={route.startsWith('#/collect') ? 'active' : ''} href="#/collect">Citizen Sensor</a>
          <a className={route.startsWith('#/agent') ? 'active' : ''} href="#/agent">Agent Dashboard</a>
        </nav>
        <div className={`health ${health ? (health.ok ? 'ok' : 'down') : 'unknown'}`}>
          {health
            ? health.ok
              ? `API live · ${health.samples} samples · ${health.alerts} alerts`
              : 'API down'
            : 'connecting…'}
        </div>
      </header>
      {route.startsWith('#/agent') ? <AgentApp /> : <CollectorApp />}
    </div>
  );
}