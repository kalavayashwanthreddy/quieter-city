// Geohash helpers — the privacy cornerstone.
// Citizens' exact GPS is NEVER transmitted: only a coarse geohash cell
// (precision 7 ≈ 153m × 153m) plus the cell CENTER as a representative point.
import ngeohash from 'ngeohash';
import { CELL_PRECISION } from './schema.js';

export function cellFor(lat, lng, precision = CELL_PRECISION) {
  return ngeohash.encode(lat, lng, precision);
}

// Center point of a cell — safe to publish: it is the cell centroid, not a user location.
export function cellCenter(cell) {
  const { latitude, longitude } = ngeohash.decode(cell);
  return { lat: latitude, lng: longitude };
}

export function neighbors(cell) {
  return ngeohash.neighbors(cell);
}

export function isValidCell(cell, precision = CELL_PRECISION) {
  return typeof cell === 'string' && cell.length === precision && /^[0123456789bcdefghjkmnpqrstuvwxyz]+$/.test(cell);
}

// lat/lng → anonymous location payload (cell + cell center only).
export function anonymizeLocation(lat, lng, precision = CELL_PRECISION) {
  const cell = cellFor(lat, lng, precision);
  const center = cellCenter(cell);
  return { cell, cellLat: center.lat, cellLng: center.lng };
}

// Blur an exact GPS fix to a random point within `radiusMeters` of the truth
// (uniform over the disk). The precise coordinate is destroyed here — this is
// the LAST function that ever sees it, and only the blurred point lives on in
// memory or is used to compute the cell.
export function blurLocation({ lat, lng }, radiusMeters = 100) {
  const u = Math.random();
  const v = Math.random();
  const r = radiusMeters * Math.sqrt(u); // sqrt → uniform area over the disk
  const theta = 2 * Math.PI * v;
  const metersPerDegLat = 111320;
  const metersPerDegLng = metersPerDegLat * Math.max(0.2, Math.cos((lat * Math.PI) / 180));
  return {
    lat: lat + (r * Math.cos(theta)) / metersPerDegLat,
    lng: lng + (r * Math.sin(theta)) / metersPerDegLng,
  };
}