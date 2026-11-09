import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { createRateLimiter, readApiConfig } from '../server/tracker/apiClient.js';
import { fetchFromApi, parseTracking } from '../server/tracker/canadaPost.js';
import { describeSource } from '../server/tracker/index.js';
import { buildView } from '../server/buildView.js';

// Shaped like the examples in the Tracking 2.0.0 OpenAPI document, quirks included:
// timestamps for dates, numbers for identifiers, and nulls for empty fields.
const event = (id, date, time, description, site = null, province = null) => ({
  eventIdentifier: id,
  eventDate: date,
  eventTime: time,
  eventTimeZone: 'EST',
  eventDescription: description,
  eventSite: site,
  eventProvince: province,
  eventRetailLocationId: null,
  eventRetailName: null,
});

const makeDetail = (overrides = {}) => ({
  pin: 3167437095800812,
  activeExists: true,
  archiveExists: false,
  changedExpectedDate: '2026-11-14T00:00:00.000Z',
  destinationPostalId: 'G1K4M7',
  expectedDeliveryDate: '2026-11-11T00:00:00.000Z',
  changedExpectedDeliveryReason: 'Customer addressing error found; attempting to correct',
  serviceName: 'Xpresspost',
  customerRef1: 8618725947,
  signatureImageExists: false,
  suppressSignature: false,
  significantEvents: [
    event('0173', '2026-11-08T00:00:00.000Z', '11:59:59', 'Customer addressing error found; attempting to correct. Possible delay', 'SAINTE-FOY', 'QC'),
    event(100, '2026-11-07T00:00:00.000Z', '08:10:00', 'Item processed', 'MONTREAL', 'QC'),
    event(162, '2026-11-06', '07:00:00', 'Delivery may be delayed due to transportation delay'),
    event(20, '2026-11-05T00:00:00.000Z', '10:00:00', 'Signature available', 'DIEPPE', null),
    event(3000, '2026-11-05T00:00:00.000Z', '09:00:00', 'Electronic information submitted by shipper', 'DIEPPE', 'NB'),
  ],
  ...overrides,
});

const makeSummary = (overrides = {}) => [{
  pin: 3167437095800812,
  originPostalId: 'E1A',
  destinationPostalId: 'G1K',
  destinationProvince: 'QC',
  serviceName: 'Xpresspost',
  expectedDeliveryDate: '2026-11-11T00:00:00.000Z',
  actualDeliveryDate: null,
  eventType: 'INFO',
  ...overrides,
}];

const CONFIG = { apiKey: 'key-id', apiSecret: 'secret-pass' };
const noWait = async () => {};
const notFoundBody = JSON.stringify({ title: 'Not found', detail: 'x', errors: [{ errorCode: '004', message: 'No Pin History' }] });

function fakeFetch(answers) {
  return vi.fn(async (url, init) => {
    const answer = answers(url, init);
    return new Response(answer.body, { status: answer.status ?? 200 });
  });
}

const tokenAnswer = { body: JSON.stringify({ access_token: 'token-1', expires_in: 3600, token_type: 'Bearer' }) };
const isToken = (url) => url.includes('/oauth2/token');
const working = () => fakeFetch((url) => (isToken(url) ? tokenAnswer : { body: JSON.stringify(url.endsWith('/details') ? makeDetail() : makeSummary()) }));
const apiFails = (status, body) => fakeFetch((url) => (isToken(url) ? tokenAnswer : { status, body }));
const track = (fetchImpl, { pin = '1371134583769923', tokens = {}, now } = {}) => fetchFromApi(pin, { config: CONFIG, fetchImpl, limiter: noWait, tokens, now });

describe('parsing API responses', () => {
  const parsed = parseTracking(makeDetail(), makeSummary(), '1371134583769923');

  it('reads the service and the oldest-first scans, using the number that was asked for', () => {
    expect(parsed.service).toBe('Xpresspost');
    expect(parsed.pin).toBe('1371134583769923');
    expect(parsed.events.map((e) => e.code)).toEqual(['3000', '20', '162', '100', '173']);
    expect(parsed.events[0]).toMatchObject({ date: '2026-11-05', time: '09:00', region: 'NB', country: 'CA' });
  });

  it('makes all-caps place names readable', () => {
    expect(parsed.events.map((e) => e.city)).toEqual(['Dieppe', 'Dieppe', null, 'Montreal', 'Sainte-Foy']);
  });

  it('fills in a missing province from another scan at the same site', () => {
    expect(parsed.events[1]).toMatchObject({ region: 'NB', country: 'CA' });
  });

  it('uses event codes for delays, including ones with leading zeros', () => {
    expect(parsed.events.map((e) => e.isDelay)).toEqual([false, false, true, false, true]);
  });

  it('reports a changed delivery date with its reason', () => {
    expect(parsed.expectedDelivery).toBe('2026-11-14');
    expect(parsed.originalExpectedDelivery).toBe('2026-11-11');
    expect(parsed.expectedChangeReason).toMatch(/addressing error/);
  });

  it('gets the destination from the API, in either postal format', () => {
    expect(parsed.destination).toEqual({ city: null, region: 'QC', postalCode: 'G1K 4M7' });
    expect(parseTracking(makeDetail({ destinationPostalId: 'N9A' }), makeSummary(), 'x').destination.postalCode).toBe('N9A');
  });

  it('leaves the destination empty for international parcels', () => {
    expect(parseTracking(makeDetail({ destinationPostalId: 90210 }), makeSummary({ destinationPostalId: null }), 'x').destination).toBeNull();
  });

  it('accepts a parcel with no scan list yet', () => {
    const { significantEvents: _omit, ...noEvents } = makeDetail();
    expect(parseTracking(noEvents, makeSummary(), 'x').events).toEqual([]);
  });

  it('marks delivered parcels and uses the actual date', () => {
    const record = parseTracking(makeDetail(), makeSummary({ actualDeliveryDate: '2026-11-15T00:00:00.000Z' }), 'x');
    expect(record).toMatchObject({ delivered: true, status: 'Delivered', expectedDelivery: '2026-11-15', originalExpectedDelivery: null });
  });

  it('labels statuses from the event type', () => {
    const status = (extra) => parseTracking(makeDetail(), makeSummary(extra), 'x').status;
    expect(status({ eventType: 'OUT' })).toBe('Out for delivery');
    expect(status({ eventType: 'TO_RETAIL' })).toBe('Ready for pickup');
    expect(status({ eventType: 'ATTEMPTED' })).toBe('Delivery issue');
    expect(status({ eventType: 'ATTEMPTED', attemptedDate: '2026-11-09' })).toBe('Delivery attempted');
  });

  describe('quirks seen on a real parcel', () => {
    const noType = makeSummary();
    delete noType[0].eventType;
    const withEvents = (...events) => makeDetail({ significantEvents: events });

    it('works out the status from the latest scan when the summary omits it', () => {
      const detail = withEvents(event('0410', '2026-11-09', '10:09:00', 'Item departed', 'MONTRÉAL', 'QC'));
      expect(parseTracking(detail, noType, 'x').status).toBe('In transit');
    });

    it('recognizes delivery from the scan code alone', () => {
      const detail = withEvents(event('1421', '2026-11-09', '10:09:00', "Delivered to recipient's front door", 'WINDSOR', 'ON'));
      expect(parseTracking(detail, noType, 'x')).toMatchObject({ delivered: true, status: 'Delivered' });
    });

    it('ignores a signature record when working out the status', () => {
      const detail = withEvents(
        event('0020', '2026-11-09', '10:10:00', 'Signature available', 'WINDSOR', 'ON'),
        event('0174', '2026-11-09', '08:00:00', 'Item out for delivery', 'WINDSOR', 'ON'),
      );
      expect(parseTracking(detail, noType, 'x').status).toBe('Out for delivery');
    });

    it('keeps national notices off the map', () => {
      const detail = withEvents(event('0162', '2026-11-03', '17:00:00', 'Delivery may be delayed due to transportation delay', 'Canada', 'Ca'));
      expect(parseTracking(detail, noType, 'x').events[0]).toMatchObject({ city: null, region: null, country: null, isDelay: true });
    });

    it('keeps accents when tidying all-caps names', () => {
      const detail = withEvents(event('0100', '2026-11-09', '01:40:00', 'Item processed', 'MONTRÉAL', 'QC'));
      expect(parseTracking(detail, noType, 'x').events[0].city).toBe('Montréal');
    });
  });

  it('treats a per-item summary error as not found', () => {
    const summary = [{ pin: 1, error: { code: '004', descEn: 'No Pin History', descFr: 'x' } }];
    expect(() => parseTracking(makeDetail(), summary, 'x')).toThrowError(expect.objectContaining({ code: 'not_found' }));
  });

  it('flags an unrecognizable response as a format change', () => {
    for (const [detail, summary] of [[null, makeSummary()], [{}, makeSummary()], [makeDetail(), {}], [makeDetail(), []], [makeDetail({ significantEvents: 'x' }), makeSummary()], [makeDetail({ significantEvents: [{}] }), makeSummary()]]) {
      expect(() => parseTracking(detail, summary, 'x')).toThrowError(expect.objectContaining({ code: 'format_changed' }));
    }
  });
});

describe('sign-in', () => {
  it('requests a token the documented way, without Basic auth', async () => {
    const fetchImpl = working();
    await track(fetchImpl);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://api.canadapost-postescanada.ca/prod/devportal-portaildesdeveloppeurs/cpc-api-native-oauth-provider/oauth2/token');
    expect(init.method).toBe('POST');
    expect(init.headers['X-IBM-Client-Id']).toBe('key-id');
    expect(init.headers['X-IBM-Client-Secret']).toBe('secret-pass');
    expect(init.headers['Content-Type']).toBe('application/x-www-form-urlencoded');
    expect(init.body).toBe('grant_type=client_credentials&scope=merchant');
    expect(init.headers.Authorization).toBeUndefined();
  });

  it('reuses a token until shortly before it expires', async () => {
    const fetchImpl = working();
    const tokens = {};
    let time = 0;
    const now = () => time;
    await track(fetchImpl, { tokens, now });
    await track(fetchImpl, { tokens, now });
    expect(fetchImpl.mock.calls.filter(([url]) => isToken(url))).toHaveLength(1);
    time = (3600 - 60) * 1000;
    await track(fetchImpl, { tokens, now });
    expect(fetchImpl.mock.calls.filter(([url]) => isToken(url))).toHaveLength(2);
  });

  it('gets a fresh token once after a 401, then succeeds', async () => {
    let rejected = false;
    const fetchImpl = fakeFetch((url) => {
      if (isToken(url)) return tokenAnswer;
      if (!rejected) {
        rejected = true;
        return { status: 401, body: '{}' };
      }
      return { body: JSON.stringify(url.endsWith('/details') ? makeDetail() : makeSummary()) };
    });
    await expect(track(fetchImpl)).resolves.toMatchObject({ service: 'Xpresspost' });
    expect(fetchImpl.mock.calls.filter(([url]) => isToken(url))).toHaveLength(2);
  });

  it('stops after one retry when the API keeps saying 401', async () => {
    const fetchImpl = apiFails(401, '{}');
    await expect(track(fetchImpl)).rejects.toMatchObject({ code: 'auth_failed' });
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it.each([
    [401, '{}', 'auth_failed'],
    [400, '{"error":"invalid_client"}', 'auth_failed'],
    [429, '', 'rate_limited'],
    [503, '', 'unavailable'],
    [200, '{"nope":true}', 'format_changed'],
    [200, 'not json', 'format_changed'],
  ])('turns a token response of HTTP %i with %j into %s', async (status, body, code) => {
    await expect(track(fakeFetch(() => ({ status, body })))).rejects.toMatchObject({ code });
  });
});

describe('API requests', () => {
  it('calls the documented paths with a Bearer token', async () => {
    const fetchImpl = working();
    await track(fetchImpl);
    const [url, init] = fetchImpl.mock.calls[1];
    expect(url).toBe('https://api.canadapost-postescanada.ca/prod/devportal-portaildesdeveloppeurs/tracking/v1/pins/1371134583769923/details');
    expect(init.headers.Accept).toBe('application/json');
    expect(init.headers.Authorization).toBe('Bearer token-1');
    expect(fetchImpl.mock.calls[2][0]).toMatch(/\/pins\/1371134583769923\/summaries$/);
  });

  it('treats a 15-digit number as a Delivery Notice Card', async () => {
    const fetchImpl = working();
    await track(fetchImpl, { pin: '315052413796541' });
    expect(fetchImpl.mock.calls[1][0]).toContain('/dncs/315052413796541/details');
  });

  it('skips the second call when the number is unknown', async () => {
    const fetchImpl = apiFails(404, notFoundBody);
    await expect(track(fetchImpl)).rejects.toMatchObject({ code: 'not_found' });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it.each([
    [404, notFoundBody, 'not_found'],
    [404, '{"title":"x","detail":"y","errors":[{"errorCode":"123","message":"z"}]}', 'not_found'],
    [400, '{"title":"x","detail":"y","errors":[{"errorCode":"002","message":"Duplicate Pin"}]}', 'not_found'],
    [400, '{"title":"x","detail":"y","errors":[{"errorCode":"999","message":"Bad number"}]}', 'invalid_number'],
    [403, '', 'auth_failed'],
    [429, '', 'rate_limited'],
    [403, 'Rejected by SLM Monitor', 'rate_limited'],
    [500, 'Rejected by SLM Monitor', 'rate_limited'],
    [503, '', 'unavailable'],
    [404, '<html></html>', 'format_changed'],
    [200, '<html>maintenance</html>', 'format_changed'],
  ])('turns HTTP %i with %j into %s', async (status, body, code) => {
    await expect(track(apiFails(status, body))).rejects.toMatchObject({ code });
  });

  it('reports a network failure as unavailable', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('getaddrinfo failed');
    });
    await expect(track(fetchImpl)).rejects.toMatchObject({ code: 'unavailable' });
  });

  it('never puts the key or token in an error message', async () => {
    for (const fetchImpl of [apiFails(401, '{}'), apiFails(403, ''), apiFails(500, ''), fakeFetch(() => ({ status: 401, body: '{}' }))]) {
      const error = await track(fetchImpl).catch((e) => e);
      for (const secret of ['key-id', 'secret-pass', 'token-1']) expect(error.message).not.toContain(secret);
    }
  });
});

describe('API settings', () => {
  it('needs both a key and a secret', () => {
    expect(readApiConfig({})).toBeNull();
    expect(readApiConfig({ CANADA_POST_API_KEY: 'a' })).toBeNull();
    expect(readApiConfig({ CANADA_POST_API_KEY: 'a', CANADA_POST_API_SECRET: ' ' })).toBeNull();
    expect(readApiConfig({ CANADA_POST_API_KEY: 'a', CANADA_POST_API_SECRET: 'b' })).toEqual({ apiKey: 'a', apiSecret: 'b' });
  });

  it('never shows the key when describing the source', () => {
    expect(describeSource()).not.toContain('secret');
  });
});

describe('rate limiter', () => {
  it('waits once the window is full, then frees a slot', async () => {
    let time = 0;
    const sleep = vi.fn(async (ms) => {
      time += ms;
    });
    const limit = createRateLimiter({ limit: 2, windowMs: 1000, now: () => time, sleep });
    await limit();
    time = 100;
    await limit();
    expect(sleep).not.toHaveBeenCalled();
    await limit();
    expect(sleep).toHaveBeenCalledWith(900);
  });
});

describe('API data on the map', () => {
  const places = { 'Sainte-Foy': { lat: 46.77, lon: -71.28 } };

  it('predicts a route from the destination the API gives', async () => {
    const geocode = async ({ city, postalCode }) => (city ? places[city] ?? null : postalCode ? { lat: 51.05, lon: -114.07 } : null);
    const record = parseTracking(makeDetail({ destinationPostalId: 'T2P1J9' }), makeSummary({ destinationProvince: 'AB' }), 'x');
    const view = await buildView(record, { geocode });
    expect(view.summary.destination).toBe('T2P 1J9, AB');
    expect(view.predicted.destinationFacilityId).toBe('cal');
    expect(view.summary.originalExpectedDelivery).toBe('2026-11-11');
  });

  it('does not mistake a foreign scan for a Canadian facility', async () => {
    const detail = makeDetail();
    detail.significantEvents[0] = event(100, '2026-11-08', '11:59:59', 'Item processed', 'LONDON', null);
    const geocode = async ({ city }) => (city === 'London' ? { lat: 51.5, lon: -0.12 } : null);
    const view = await buildView(parseTracking(detail, makeSummary(), 'x'), { geocode });
    expect(view.places.find((p) => p.label === 'London').kind).toBe('geocoded');
    expect(view.predicted).toBeNull();
    expect(view.routeNote).toMatch(/outside Canada/);
  });
});

// Real parcels saved with `npm run check:api -- <number> --save <name>` are tested here automatically.
describe('saved real responses', () => {
  const directory = new URL('./fixtures/', import.meta.url);
  const files = existsSync(directory) ? readdirSync(directory).filter((name) => name.endsWith('.json')) : [];

  if (files.length === 0) it.skip('none saved yet', () => {});
  else {
    it.each(files)('%s still parses', async (name) => {
      const { detail, summary } = JSON.parse(readFileSync(new URL(name, directory), 'utf8'));
      const record = parseTracking(detail, summary, 'x');
      expect(record.events.length).toBeGreaterThan(0);
      await expect(buildView(record, { geocode: async () => null })).resolves.toBeTruthy();
    });
  }
});
