import './env.js';
import express from 'express';
import { randomInt } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describeSource, fetchTestTracking, fetchTracking, isValidPin, sanitizePin, TrackingError } from './tracker/index.js';
import { readApiConfig, readTestApiConfig } from './tracker/apiClient.js';
import { fullPostalCode } from './tracker/common.js';
import { locateCity, locatePostalCode } from './tracker/postOffice.js';
import { getRates, usesAccountRates } from './tracker/rating.js';
import { getOutages } from './tracker/serviceInfo.js';
import { createTrackingCache } from './trackingCache.js';
import { buildView, parseDestinationInput } from './buildView.js';
import { buildEstimate } from './estimate.js';
import { addRoadGeometry } from './route/roads.js';
import { geocode as nominatimGeocode } from './geocoder.js';

const PORT = Number(process.env.API_PORT ?? 3001);
// Kept within your requested 15–30 minute limit.
const POLL_MINUTES = Math.min(30, Math.max(15, Number(process.env.POLL_MINUTES ?? 15)));
const NOTICE_CACHE_MS = 30 * 60_000;
const BENCH_LIMIT = 10;

const demoRecord = JSON.parse(readFileSync(new URL('./data/demo-parcel.json', import.meta.url), 'utf8'));
const getTracking = createTrackingCache({ fetcher: fetchTracking, minIntervalMs: POLL_MINUTES * 60_000 });
const getTestTracking = createTrackingCache({ fetcher: fetchTestTracking, minIntervalMs: 60_000, errorIntervalMs: 10_000 });

const STATUS_BY_CODE = {
  invalid_number: 400,
  bad_request: 400,
  not_found: 404,
  auth_failed: 502,
  rate_limited: 503,
  blocked: 503,
  unavailable: 503,
  format_changed: 502,
};

/** Post Office data places postal codes better than free geocoding does, so it goes first. */
async function geocode(query) {
  const config = readApiConfig();
  const postalCode = query.city ? null : fullPostalCode(query.postalCode);
  if (postalCode && config) {
    const found = await locatePostalCode(postalCode, { config }).catch(() => null);
    if (found) return { lat: found.lat, lon: found.lon, label: found.label, place: found.label };
  }
  return nominatimGeocode(query);
}

const demoView = async () => ({ ...(await buildView(demoRecord, { geocode, addRoads: addRoadGeometry })), mode: 'demo', fetchedAt: null, nextRefreshAt: null });

function requirePin(raw) {
  const pin = sanitizePin(raw);
  if (!isValidPin(pin)) {
    throw new TrackingError('invalid_number', 'That does not look like a Canada Post tracking number. Use 11 to 16 digits, or a format like RN123456789CA.');
  }
  return pin;
}

const app = express();
app.use(express.json({ limit: '10kb' }));

app.get('/api/demo', async (_req, res) => res.json(await demoView()));

app.get('/api/track/:pin', async (req, res) => {
  const pin = requirePin(req.params.pin);
  const isTest = req.query.source === 'test';
  const destinationOverride = parseDestinationInput(req.query.dest);
  const { record, fetchedAt, nextFetchAt } = await (isTest ? getTestTracking : getTracking)(pin);
  const view = await buildView(record, { geocode, destinationOverride, addRoads: addRoadGeometry });
  res.json({ ...view, mode: isTest ? 'test' : 'live', fetchedAt, nextRefreshAt: nextFetchAt });
});

let notices = { items: [], expiresAt: 0 };
app.get('/api/notices', async (_req, res) => {
  const config = readApiConfig();
  if (config && Date.now() >= notices.expiresAt) {
    const items = await getOutages({ config }).catch(() => notices.items);
    notices = { items, expiresAt: Date.now() + NOTICE_CACHE_MS };
  }
  res.json(notices.items);
});

app.post('/api/estimate', async (req, res) => {
  const config = readApiConfig();
  if (!config) throw new TrackingError('auth_failed', 'Estimates need a Canada Post API key in .env.local.');
  const options = { config };
  const estimate = await buildEstimate(req.body ?? {}, {
    getRates: (query) => getRates(query, options),
    locatePostalCode: (postalCode) => locatePostalCode(postalCode, options),
    locateCity: (city, province) => locateCity(city, province, options),
    addRoadGeometry,
  });
  res.json({ ...estimate, accountRates: usesAccountRates() });
});

app.get('/api/test-bench/info', (_req, res) => {
  res.json({ hasLiveKey: Boolean(readApiConfig()), hasTestKey: Boolean(readTestApiConfig()), limit: BENCH_LIMIT });
});

// Random numbers only ever go to a Test app. On a production key they could find a stranger's parcel.
app.get('/api/test-bench/random', (_req, res) => {
  if (!readTestApiConfig()) throw new TrackingError('bad_request', 'Random numbers need a Test app key, so that no real parcels are looked up.');
  res.json(Array.from({ length: 5 }, () => `7${String(randomInt(0, 1e9)).padStart(9, '0')}${String(randomInt(0, 1e6)).padStart(6, '0')}`));
});

app.post('/api/test-bench/run', async (req, res) => {
  const useTest = req.body?.source === 'test';
  const lookup = useTest ? getTestTracking : getTracking;
  const numbers = [...new Set((req.body?.numbers ?? []).map(sanitizePin).filter(Boolean))].slice(0, BENCH_LIMIT);
  const results = [];
  for (const number of numbers) {
    try {
      const { record } = await lookup(requirePin(number));
      results.push({
        number,
        ok: true,
        status: record.status,
        service: record.service,
        expectedDelivery: record.expectedDelivery ?? null,
        scans: record.events.length,
        destination: record.destination?.postalCode ?? null,
      });
    } catch (error) {
      if (!(error instanceof TrackingError)) throw error;
      results.push({ number, ok: false, code: error.code, message: error.message });
    }
  }
  res.json(results);
});

const distDir = fileURLToPath(new URL('../dist', import.meta.url));
if (existsSync(distDir)) {
  app.use(express.static(distDir));
  app.get(/^\/(?!api\/).*/, (_req, res) => res.sendFile('index.html', { root: distDir }));
}

app.use(async (error, _req, res, _next) => {
  const known = error instanceof TrackingError;
  if (!known) console.error(error);
  const body = {
    error: {
      code: known ? error.code : 'internal',
      message: known ? error.message : 'Something went wrong on the server.',
    },
  };
  // A changed page format falls back to demo data, which the frontend labels clearly.
  if (known && error.code === 'format_changed') body.fallback = await demoView().catch(() => null);
  res.status(known ? STATUS_BY_CODE[error.code] : 500).json(body);
});

// Local only: this server launches a browser on request, so it is not exposed to the network.
app.listen(PORT, '127.0.0.1', () => console.log(`API ready on http://127.0.0.1:${PORT}. Tracking source: ${describeSource()}`));
