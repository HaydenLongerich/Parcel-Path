// City-name geocoding through Nominatim, within its usage policy: at most one request
// per second, an identifying User-Agent, and results cached on disk.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const SEED_URL = new URL('./data/geocache.seed.json', import.meta.url);
const CACHE_PATH = fileURLToPath(new URL('./.cache/geocode.json', import.meta.url));
const MIN_GAP_MS = 1100;
const USER_AGENT = 'parcel-route-tracker/1.0 (self-hosted personal parcel map)';

// The seed is checked by hand, so it wins over anything looked up earlier.
const cache = {
  ...(existsSync(CACHE_PATH) ? JSON.parse(readFileSync(CACHE_PATH, 'utf8')) : {}),
  ...JSON.parse(readFileSync(SEED_URL, 'utf8')),
};

function persist() {
  mkdirSync(dirname(CACHE_PATH), { recursive: true });
  writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2));
}

let queue = Promise.resolve();
let lastRequestAt = 0;

function throttled(task) {
  const run = queue.then(async () => {
    const wait = lastRequestAt + MIN_GAP_MS - Date.now();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    lastRequestAt = Date.now();
    return task();
  });
  queue = run.catch(() => {});
  return run;
}

/** Returns { lat, lon, label } or null. Lookup failures are not cached, so they can retry. */
export async function geocode({ city, region, postalCode, country = 'CA' }) {
  const key = [city ?? postalCode, region, country].filter(Boolean).join('|').toLowerCase();
  if (!key) return null;
  if (key in cache) return cache[key];

  const params = new URLSearchParams({ format: 'jsonv2', limit: '1' });
  if (city) {
    params.set('q', [city, region, country === 'CA' ? 'Canada' : country].filter(Boolean).join(', '));
  } else {
    params.set('postalcode', postalCode);
    params.set('country', country);
  }
  if (country?.length === 2) params.set('countrycodes', country.toLowerCase());

  try {
    const response = await throttled(() =>
      fetch(`https://nominatim.openstreetmap.org/search?${params}`, {
        headers: { 'User-Agent': USER_AGENT },
        signal: AbortSignal.timeout(10_000),
      }),
    );
    if (!response.ok) return null;
    const [hit] = await response.json();
    const result = hit
      ? { lat: Number(hit.lat), lon: Number(hit.lon), label: [city ?? postalCode, region].filter(Boolean).join(', ') }
      : null;
    cache[key] = result;
    persist();
    return result;
  } catch {
    return null;
  }
}
