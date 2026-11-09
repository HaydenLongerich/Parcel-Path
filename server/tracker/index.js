// Picks where live tracking comes from. The official API is used whenever a key is
// configured, and API errors are shown rather than silently retried another way.
import { readApiConfig, readTestApiConfig } from './apiClient.js';
import { fetchFromApi } from './canadaPost.js';
import { TrackingError } from './common.js';
import { enrichRecord } from './enrich.js';
import { fetchFromPublicPage } from './publicPage.js';

export { isValidPin, sanitizePin, TrackingError } from './common.js';

export function fetchTestTracking(pin) {
  const config = readTestApiConfig();
  if (!config) throw new TrackingError('bad_request', 'No Test app key is set. Add CANADA_POST_TEST_API_KEY and CANADA_POST_TEST_API_SECRET to .env.local.');
  return fetchFromApi(pin, { config });
}

export async function fetchTracking(pin) {
  const config = readApiConfig();
  if (!config) return fetchFromPublicPage(pin);
  return enrichRecord(await fetchFromApi(pin, { config }), { config });
}

export function describeSource() {
  return readApiConfig() ? 'Canada Post API' : 'public tracking page (no API key set)';
}
