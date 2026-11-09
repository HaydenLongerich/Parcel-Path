// Road paths for legs outside the stored network, such as a town to its nearest facility.
// Uses the public OSRM server, at most one request per second, with results cached on disk.
// Only town or Post Office coordinates are sent, never tracking numbers or addresses.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { distanceKm } from './predict.js';
import { simplify } from './geometry.js';

const CACHE_PATH = fileURLToPath(new URL('../.cache/roads.json', import.meta.url));
const ROUTER = 'https://router.project-osrm.org/route/v1/driving';
const USER_AGENT = 'parcel-route-tracker/1.0 (self-hosted personal parcel map)';
const MIN_GAP_MS = 1100;
const TIMEOUT_MS = 5000;
const RETRY_AFTER_MS = 60_000;
const TOLERANCE = 0.0004;
const MAX_SNAP_METRES = 5000; // Farther than this from a road, the town isn't on the road network.
const MAX_DETOUR = 3;

function loadDiskCache() {
  return existsSync(CACHE_PATH) ? JSON.parse(readFileSync(CACHE_PATH, 'utf8')) : {};
}

function saveDiskCache(cache) {
  mkdirSync(dirname(CACHE_PATH), { recursive: true });
  writeFileSync(CACHE_PATH, JSON.stringify(cache));
}

const coordinate = (value) => value.toFixed(4);

export function createRoadRouter({ fetchImpl = fetch, cache = {}, save = () => {}, minGapMs = MIN_GAP_MS, now = Date.now } = {}) {
  let queue = Promise.resolve();
  let lastRequestAt = 0;
  let unavailableUntil = 0;

  function throttled(task) {
    const run = queue.then(async () => {
      const wait = lastRequestAt + minGapMs - now();
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
      lastRequestAt = now();
      return task();
    });
    queue = run.catch(() => {});
    return run;
  }

  async function request(a, b) {
    const path = `${coordinate(a.lon)},${coordinate(a.lat)};${coordinate(b.lon)},${coordinate(b.lat)}`;
    const response = await fetchImpl(`${ROUTER}/${path}?overview=full&geometries=geojson&steps=false`, {
      headers: { 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const body = await response.json();
    // OSRM reports a place it can't connect as an answer, not a server failure.
    if (body.code === 'NoRoute') return null;
    if (body.code !== 'Ok') throw new Error(body.code);

    const [route] = body.routes;
    const tooFar = body.waypoints.some((point) => point.distance > MAX_SNAP_METRES);
    const straightKm = distanceKm(a, b);
    if (tooFar || route.distance / 1000 > Math.max(straightKm * MAX_DETOUR, 50)) return null;

    const pairs = route.geometry.coordinates.map(([lon, lat]) => [Math.round(lat * 1e5) / 1e5, Math.round(lon * 1e5) / 1e5]);
    return simplify(pairs, TOLERANCE);
  }

  /** Returns the road's points, or null when there's no road or the service can't be reached. */
  async function roadBetween(a, b) {
    const key = [a.lat, a.lon, b.lat, b.lon].map(coordinate).join(',');
    if (key in cache) return cache[key];
    if (now() < unavailableUntil) return null;
    try {
      const pairs = await throttled(() => request(a, b));
      cache[key] = pairs;
      save(cache);
      return pairs;
    } catch {
      // Failures aren't cached. Pausing keeps an outage from slowing every page by the timeout.
      unavailableUntil = now() + RETRY_AFTER_MS;
      return null;
    }
  }

  /** Replaces any straight road leg in a route with the road itself. Straight lines remain as the fallback. */
  async function addRoadGeometry(route) {
    if (!route) return route;
    const segments = [];
    for (const segment of route.segments) {
      if (segment.mode !== 'road' || segment.coords.length !== 2) {
        segments.push(segment);
        continue;
      }
      const [from, to] = segment.coords;
      const pairs = await roadBetween(from, to);
      segments.push(pairs ? { ...segment, coords: [from, ...pairs.map(([lat, lon]) => ({ lat, lon })), to] } : { ...segment, noRoadData: true });
    }
    return { ...route, segments };
  }

  return { roadBetween, addRoadGeometry };
}

export const { addRoadGeometry } = createRoadRouter({ cache: loadDiskCache(), save: saveDiskCache });
