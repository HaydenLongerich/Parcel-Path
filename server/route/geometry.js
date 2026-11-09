// The shapes of route lines: stored road and ferry paths, and flight paths.
import { existsSync, readFileSync } from 'node:fs';

const GEOMETRY_URL = new URL('../data/route-geometry.json', import.meta.url);
const LEGS = existsSync(GEOMETRY_URL) ? JSON.parse(readFileSync(GEOMETRY_URL, 'utf8')).legs : {};

const toPoints = (pairs) => pairs.map(([lat, lon]) => ({ lat, lon }));

/** The stored path between two network points, in travel order, or null if there isn't one. */
export function storedPath(fromId, toId) {
  if (LEGS[`${fromId}|${toId}`]) return toPoints(LEGS[`${fromId}|${toId}`]);
  if (LEGS[`${toId}|${fromId}`]) return toPoints(LEGS[`${toId}|${fromId}`]).reverse();
  return null;
}

/** Douglas-Peucker. Tolerance is in degrees; pairs are [lat, lon]. */
export function simplify(pairs, tolerance) {
  if (pairs.length < 3) return pairs;
  const keep = new Uint8Array(pairs.length);
  keep[0] = 1;
  keep[pairs.length - 1] = 1;
  const pending = [[0, pairs.length - 1]];
  while (pending.length > 0) {
    const [first, last] = pending.pop();
    const [ay, ax] = pairs[first];
    const [by, bx] = pairs[last];
    const dx = bx - ax;
    const dy = by - ay;
    const lengthSquared = dx * dx + dy * dy;
    let farthest = -1;
    let worst = tolerance * tolerance;
    for (let i = first + 1; i < last; i++) {
      const [py, px] = pairs[i];
      const t = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lengthSquared));
      const distanceSquared = (px - ax - t * dx) ** 2 + (py - ay - t * dy) ** 2;
      if (distanceSquared > worst) {
        worst = distanceSquared;
        farthest = i;
      }
    }
    if (farthest !== -1) {
      keep[farthest] = 1;
      pending.push([first, farthest], [farthest, last]);
    }
  }
  return pairs.filter((_, i) => keep[i]);
}

/** Points along the shortest path over the Earth, which is the track long-haul flights approximate. */
export function greatCirclePath(a, b) {
  const rad = (deg) => (deg * Math.PI) / 180;
  const deg = (r) => Math.round(((r * 180) / Math.PI) * 1e5) / 1e5;
  const unit = ({ lat, lon }) => [Math.cos(rad(lat)) * Math.cos(rad(lon)), Math.cos(rad(lat)) * Math.sin(rad(lon)), Math.sin(rad(lat))];
  const [u, v] = [unit(a), unit(b)];
  const angle = Math.acos(Math.min(1, u[0] * v[0] + u[1] * v[1] + u[2] * v[2]));
  if (angle === 0) return [a, b];

  const steps = Math.max(8, Math.min(96, Math.round((angle * 6371) / 40)));
  const path = [a];
  for (let i = 1; i < steps; i++) {
    const f = i / steps;
    const s = Math.sin((1 - f) * angle) / Math.sin(angle);
    const t = Math.sin(f * angle) / Math.sin(angle);
    const [x, y, z] = u.map((value, axis) => s * value + t * v[axis]);
    path.push({ lat: deg(Math.atan2(z, Math.hypot(x, y))), lon: deg(Math.atan2(y, x)) });
  }
  path.push(b);
  return path;
}
