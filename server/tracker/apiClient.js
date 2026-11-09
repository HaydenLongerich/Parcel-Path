// Shared connection to Canada Post's Developer Portal APIs: sign-in, rate limiting and errors.
//
// The API Key and Secret buy a short-lived OAuth token, which is then sent on each call.
// Test and production apps use the same addresses; the key decides which one you get.
import { TrackingError } from './common.js';

const API_ROOT = 'https://api.canadapost-postescanada.ca/prod/devportal-portaildesdeveloppeurs';
const TOKEN_URL = `${API_ROOT}/cpc-api-native-oauth-provider/oauth2/token`;
const REQUEST_TIMEOUT_MS = 15_000;
const TOKEN_EXPIRY_MARGIN_S = 60;
const CALLS_PER_MINUTE = 20;

const KEY_REJECTED = 'Canada Post did not accept the API Key or API Secret in .env.local. Check both values against your app in the Developer Portal.';

const pair = (key, secret) => (key?.trim() && secret?.trim() ? { apiKey: key.trim(), apiSecret: secret.trim() } : null);

/** The [Production] app's key, or null when none is configured. */
export const readApiConfig = (env = process.env) => pair(env.CANADA_POST_API_KEY, env.CANADA_POST_API_SECRET);

/** The optional [Test] app's key, which returns Canada Post's sample data. */
export const readTestApiConfig = (env = process.env) => pair(env.CANADA_POST_TEST_API_KEY, env.CANADA_POST_TEST_API_SECRET);

export function createRateLimiter({ limit = CALLS_PER_MINUTE, windowMs = 60_000, now = Date.now, sleep } = {}) {
  const pause = sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const recent = [];
  let queue = Promise.resolve();
  return () => {
    const turn = queue.then(async () => {
      while (recent.length && now() - recent[0] >= windowMs) recent.shift();
      if (recent.length >= limit) {
        await pause(recent[0] + windowMs - now());
        recent.shift();
      }
      recent.push(now());
    });
    queue = turn;
    return turn;
  };
}

const defaultLimiter = createRateLimiter();
const tokensByKey = new Map();

function defaultTokens(config) {
  if (!tokensByKey.has(config.apiKey)) tokensByKey.set(config.apiKey, {});
  return tokensByKey.get(config.apiKey);
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function send(url, init, fetchImpl) {
  let response;
  try {
    response = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  } catch {
    throw new TrackingError('unavailable', 'Could not reach Canada Post. Check your connection and try again.');
  }
  const body = await response.text();
  return { status: response.status, ok: response.ok, body, json: parseJson(body) };
}

const isThrottled = ({ status, body }) => status === 429 || /Rejected by SLM/i.test(body);
const throttled = () => new TrackingError('rate_limited', 'Too many requests in the last minute. Canada Post will accept more shortly.');

async function getAccessToken({ config, fetchImpl, tokens, now }) {
  if (tokens.value && now() < tokens.expiresAt) return tokens.value;

  const result = await send(
    TOKEN_URL,
    {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
        'X-IBM-Client-Id': config.apiKey,
        'X-IBM-Client-Secret': config.apiSecret,
      },
      body: 'grant_type=client_credentials&scope=merchant',
    },
    fetchImpl,
  );

  if (isThrottled(result)) throw throttled();
  if (result.status >= 500) throw new TrackingError('unavailable', `Canada Post's sign-in service returned HTTP ${result.status}.`);
  if (!result.ok) throw new TrackingError('auth_failed', KEY_REJECTED);
  if (!result.json?.access_token) throw new TrackingError('format_changed', 'Canada Post sign-in returned an unexpected response.');

  tokens.value = result.json.access_token;
  tokens.expiresAt = now() + (Number(result.json.expires_in) - TOKEN_EXPIRY_MARGIN_S) * 1000;
  return tokens.value;
}

function errorFor(result, { product, onClientError }) {
  const { status, json } = result;
  if (isThrottled(result)) return throttled();

  const specific = onClientError?.(result);
  if (specific) return specific;

  if (status === 401) return new TrackingError('auth_failed', KEY_REJECTED);
  if (status === 403) return new TrackingError('auth_failed', `Canada Post refused this request. Check that the ${product} product is added to your app in the Developer Portal.`);
  if (status === 400) return new TrackingError('bad_request', json?.errors?.[0]?.message ?? 'Canada Post could not understand that request.');
  if (status === 404) return new TrackingError('not_found', 'Canada Post could not find that.');
  if (status >= 500) return new TrackingError('unavailable', `Canada Post's ${product} service returned HTTP ${status}.`);
  return new TrackingError('format_changed', `Canada Post answered with an unexpected HTTP ${status}.`);
}

/** Calls an API path such as "/tracking/v1/pins/123/details" and returns the parsed JSON. */
export async function callApi(path, options, isRetry = false) {
  const { config, fetchImpl = fetch, limiter = defaultLimiter, now = Date.now, method = 'GET', body } = options;
  const tokens = options.tokens ?? defaultTokens(config);

  await limiter();
  const token = await getAccessToken({ config, fetchImpl, tokens, now });
  const result = await send(
    `${API_ROOT}${path}`,
    {
      method,
      headers: {
        Accept: 'application/json',
        'Accept-Language': 'en-CA',
        Authorization: `Bearer ${token}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    },
    fetchImpl,
  );

  // A token can expire early, so get a fresh one once before giving up.
  if (result.status === 401 && !isRetry) {
    tokens.value = null;
    return callApi(path, { ...options, tokens }, true);
  }
  if (!result.ok) throw errorFor(result, options);
  if (result.json === null) throw new TrackingError('format_changed', 'The response from Canada Post was not valid JSON.');
  return result.json;
}
