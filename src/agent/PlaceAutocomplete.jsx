// Debounced place-name autocomplete (location-name routing spec).
// - Types trigger `search(query)` after ~300 ms; identical queries are
//   cached client-side to stay inside Nominatim's public-instance rate
//   policy (max ~1 req/s).
// - Selecting a suggestion calls `onSelect(place)` with the confirmed
//   {label, lat, lng}; the parent stores the point and shows the label.
// - Manual edits notify the parent via `onEdit(text)` so it can clear any
//   previously-confirmed point.
import { useEffect, useRef, useState } from 'react';

const DEBOUNCE_MS = 300;

export default function PlaceAutocomplete({ value, onEdit, onSelect, search, placeholder }) {
  const [text, setText] = useState(value);
  const [sugg, setSugg] = useState([]);
  const [open, setOpen] = useState(false);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState('');
  const timerRef = useRef(null);
  const cacheRef = useRef(new Map());
  const wrapRef = useRef(null);

  // Parent changed the value externally (selection, map click, reset).
  useEffect(() => setText(value), [value]);

  useEffect(() => () => clearTimeout(timerRef.current), []);

  // Close the suggestions when clicking anywhere else.
  useEffect(() => {
    const onDoc = (e) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);

  const runSearch = (q) => {
    if (!q.trim()) { setSugg([]); setOpen(false); return; }
    const cached = cacheRef.current.get(q);
    if (cached) { setSugg(cached); setOpen(true); return; }
    setSearching(true);
    setError('');
    search(q)
      .then((list) => {
        cacheRef.current.set(q, list);
        setSugg(list);
        setOpen(true);
      })
      .catch((e) => {
        setError(e.message || 'Search failed');
        setSugg([]);
        setOpen(true);
      })
      .finally(() => setSearching(false));
  };

  const handleChange = (e) => {
    const v = e.target.value;
    setText(v);
    onEdit(v); // mark the point unconfirmed — the text is being changed
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => runSearch(v.trim()), DEBOUNCE_MS);
  };

  const handleSelect = (place) => {
    setText(place.label);
    setSugg([]);
    setOpen(false);
    onSelect(place);
  };

  return (
    <div className="autocomplete" ref={wrapRef}>
      <input
        value={text}
        onChange={handleChange}
        onFocus={() => text.trim() && runSearch(text.trim())}
        placeholder={placeholder}
        autoComplete="off"
        spellCheck={false}
      />
      {open && sugg.length > 0 && (
        <ul className="sugg">
          {sugg.map((p, i) => (
            <li key={i} onMouseDown={(e) => { e.preventDefault(); handleSelect(p); }}>
              <span className="sugg-name">{p.name || p.label}</span>
              {p.subtitle && <span className="sugg-sub">{p.subtitle}</span>}
            </li>
          ))}
        </ul>
      )}
      {open && searching && !error && <div className="sugg-hint">searching…</div>}
      {error && <div className="sugg-hint bad">{error}</div>}
    </div>
  );
}