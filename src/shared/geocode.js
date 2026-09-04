// Client-side geocoding (location-name routing spec).
// Turns a typed place name into a precise {lat, lng} BEFORE the existing
// coordinate-based router runs. The search is bounded to the operating city
// so "Market Street" doesn't resolve on another continent, and results are
// ranked so narrow places (buildings, POIs) beat broad administrative areas
// (suburb/city) that can be kilometres wide. Router.js and the backend are
// untouched — this is a purely pre-routing, name → coordinate step.

// Operating city: Bengaluru metro area [minLng, minLat, maxLng, maxLat].
export const BENGALURU_VIEWBOX = '77.45,12.82,77.75,13.15';

// Narrow place types rank above broad ones — a suburb match can be km wide,
// which defeats routing to a precise point.
const TYPE_RANK = {
  building: 5,
  amenity: 4,
  poi: 4,
  highway: 4,
  railway: 4,
  shop: 3,
  tourism: 3,
  leisure: 3,
  neighbourhood: 2,
  place: 2,
  suburb: 1,
  city: 0,
  county: 0,
  state: 0,
};

// Stable sort: narrow/building-level matches first, admin areas last.
export function sortByType(list) {
  return [...list].sort(
    (a, b) => (TYPE_RANK[b.type] ?? 0) - (TYPE_RANK[a.type] ?? 0),
  );
}

// OSM Nominatim search, bounded to the city viewbox. Returns up to `limit`
// candidates ordered by type rank (POIs/buildings before suburbs/cities).
// Swap for Google Places / Mapbox Geocoding in production — same shape.
export async function searchPlaces(query, { viewbox = BENGALURU_VIEWBOX, limit = 5 } = {}) {
  const url = new URL('https://nominatim.openstreetmap.org/search');
  url.searchParams.set('q', query);
  url.searchParams.set('format', 'jsonv2');
  url.searchParams.set('addressdetails', '1');
  url.searchParams.set('limit', String(limit));
  if (viewbox) {
    url.searchParams.set('viewbox', viewbox);
    url.searchParams.set('bounded', '1');
  }
  const res = await fetch(url, { headers: { 'Accept-Language': 'en' } });
  if (!res.ok) throw new Error(`Geocoding error ${res.status}`);
  const data = await res.json();
  return sortByType(
    data.map((d) => ({
      label: d.display_name,
      name: (d.display_name || '').split(',')[0].trim(),
      subtitle: (d.display_name || '').split(',').slice(1).join(',').trim(),
      lat: parseFloat(d.lat),
      lng: parseFloat(d.lon),
      boundingbox: d.boundingbox?.map(Number), // [south, north, west, east]
      type: d.addresstype ?? d.type ?? 'place',
    })),
  );
}

// Reverse geocode a clicked map point back to a readable place name, so
// map-click routing shows a name instead of raw coordinates. Returns null
// (caller falls back to coordinates) on any failure.
export async function reverseGeocode(lat, lng) {
  const url = new URL('https://nominatim.openstreetmap.org/reverse');
  url.searchParams.set('lat', String(lat));
  url.searchParams.set('lon', String(lng));
  url.searchParams.set('format', 'jsonv2');
  try {
    const res = await fetch(url, { headers: { 'Accept-Language': 'en' } });
    if (!res.ok) return null;
    const data = await res.json();
    return data.display_name ?? null;
  } catch {
    return null;
  }
}