import { describe, expect, it } from 'vitest';
import { TrackingError } from '../server/tracker/common.js';
import { addBusinessDays, businessDaysBetween, enrichRecord } from '../server/tracker/enrich.js';
import { locateCity, locatePostalCode, parsePostOffice } from '../server/tracker/postOffice.js';
import { parseRates } from '../server/tracker/rating.js';
import { parseOutages } from '../server/tracker/serviceInfo.js';
import { buildEstimate, chooseRouteKind } from '../server/estimate.js';
import { FACILITIES, findOtherHub, HUBS } from '../server/route/facilities.js';
import { buildView } from '../server/buildView.js';
import { distanceKm, predictAirRoute, predictRoute } from '../server/route/predict.js';
import { greatCirclePath, simplify, storedPath } from '../server/route/geometry.js';
import { createRoadRouter } from '../server/route/roads.js';

// Shapes taken from real responses for these services.
const QUOTE = (code, name, due, days, guaranteed = false) => ({
  serviceCode: code,
  serviceName: name,
  priceDetails: { base: 10, due },
  serviceStandard: { guaranteedDelivery: guaranteed, expectedTransitTime: days, expectedDeliveryDate: '2026-11-12' },
});

const OFFICE = {
  address: { latitude: 42.29168, longitude: -83.05869, officeAddress: '2670 TECUMSEH RD W', city: 'WINDSOR', province: 'ON', postalCode: 'N9B1W0' },
  location: 'UNIVERSITY MALL PO',
  name: 'SHOPPERS DRUG MART #0762',
  officeId: '0000020990',
  hoursList: [
    { day: '1', time: ['12:00', '16:00'] },
    { day: '2', time: ['08:00', '12:00', '13:00', '21:00'] },
    { day: '3', time: ['08:00'] },
  ],
};

describe('rates', () => {
  it('sorts by price and keeps the total due', () => {
    const rates = parseRates([QUOTE('DOM.PC', 'Priority', 78.06, 2, true), QUOTE('DOM.RP', 'Regular Parcel', 25.71, 7)]);
    expect(rates.map((r) => r.code)).toEqual(['DOM.RP', 'DOM.PC']);
    expect(rates[1]).toMatchObject({ price: 78.06, transitDays: 2, expectedDelivery: '2026-11-12', guaranteed: true });
  });

  it('rejects a strange response', () => {
    expect(() => parseRates({})).toThrowError(expect.objectContaining({ code: 'format_changed' }));
  });
});

describe('Post Office details', () => {
  const office = parsePostOffice(OFFICE);

  it('tidies names and keeps coordinates', () => {
    expect(office).toMatchObject({ street: '2670 Tecumseh Rd W', city: 'Windsor', lat: 42.29168, lon: -83.05869 });
  });

  it('starts the week on Sunday and pairs opening and closing times', () => {
    expect(office.hours[0]).toEqual({ day: 'Sunday', periods: ['12:00–16:00'] });
    expect(office.hours[1].periods).toEqual(['08:00–12:00', '13:00–21:00']);
  });

  it('handles open-until-close and days with no hours', () => {
    expect(office.hours[2].periods).toEqual(['08:00–close']);
    expect(office.hours[6]).toEqual({ day: 'Saturday', periods: [] });
  });
});

describe('Post Office lookups', () => {
  it('returns a promise on repeat lookups too', async () => {
    const fetchImpl = async (url) =>
      new Response(url.includes('/oauth2/token') ? JSON.stringify({ access_token: 't', expires_in: 3600 }) : JSON.stringify([OFFICE]));
    const options = { config: { apiKey: 'a', apiSecret: 'b' }, fetchImpl, limiter: async () => {}, tokens: {} };
    await locatePostalCode('N9A6S1', options);
    const repeat = locatePostalCode('N9A6S1', options);
    expect(repeat).toBeInstanceOf(Promise);
    await expect(repeat).resolves.toMatchObject({ city: 'Windsor', province: 'ON', label: 'Windsor, ON' });
  });
});

describe('choosing a town\'s Post Office', () => {
  const entry = (name, location, city) => ({ ...OFFICE, name, location, address: { ...OFFICE.address, city } });
  const lookup = (offices) => ({
    config: { apiKey: 'a', apiSecret: 'b' },
    limiter: async () => {},
    tokens: {},
    fetchImpl: async (url) => new Response(url.includes('/oauth2/token') ? JSON.stringify({ access_token: 't', expires_in: 3600 }) : JSON.stringify(offices)),
  });

  it('prefers the town station over a rural office with the same mailing town', async () => {
    const offices = [entry('ROSSMORE PO', 'ROSSMORE PO', 'BELLEVILLE'), entry('BELLEVILLE STN MAIN', 'BELLEVILLE MAIN PO', 'BELLEVILLE')];
    const found = await locateCity('Belleville', 'ON', lookup(offices));
    expect(found.site.name).toBe('Belleville Main Post Office');
  });

  it('uses the first office in town when there is no station', async () => {
    const offices = [entry('X', 'NEARBY PO', 'OTHERTOWN'), entry('SHOPPERS', 'CORNER PO', 'SOMEWHERE')];
    const found = await locateCity('Somewhere', 'ON', lookup(offices));
    expect(found.site.name).toBe('Corner Post Office');
  });
});

describe('outage notices', () => {
  const now = Date.parse('2026-11-09T12:00:00Z');
  const notice = (to) => ({ messageType: 'SO', messageText: 'Maintenance', fromDatetime: '2026-11-08T00:00:00Z', toDatetime: to });

  it('drops outages that are over', () => {
    expect(parseOutages([notice('2026-11-09T11:00:00Z')], now)).toEqual([]);
    expect(parseOutages([notice('2026-11-10T11:00:00Z')], now)).toHaveLength(1);
  });

  it('copes with an empty or strange response', () => {
    expect(parseOutages([], now)).toEqual([]);
    expect(parseOutages(null, now)).toEqual([]);
  });
});

describe('business days', () => {
  it('skips weekends when adding', () => {
    expect(addBusinessDays('2026-11-06', 1)).toBe('2026-11-09'); // Friday to Monday
    expect(addBusinessDays('2026-11-02', 7)).toBe('2026-11-11');
  });

  it('counts between dates in either direction', () => {
    expect(businessDaysBetween('2026-11-11', '2026-11-13')).toBe(2);
    expect(businessDaysBetween('2026-11-13', '2026-11-11')).toBe(-2);
    expect(businessDaysBetween('2026-11-13', '2026-11-16')).toBe(1);
    expect(businessDaysBetween('2026-11-13', '2026-11-13')).toBe(0);
  });
});

describe('on-time check', () => {
  const quoteFetch = (body, status = 200) => async (url) => {
    if (url.includes('/oauth2/token')) return new Response(JSON.stringify({ access_token: 't', expires_in: 3600 }));
    if (url.includes('/rating/')) return new Response(JSON.stringify(body), { status });
    return new Response(JSON.stringify(OFFICE));
  };
  const record = {
    serviceCode: 'DOM.RP',
    originPostalId: 'A0G',
    destination: { postalCode: 'N9A 6S1' },
    acceptedDate: '2026-11-02',
    expectedDelivery: '2026-11-13',
    delivered: false,
    pickupOfficeId: null,
  };
  const options = (fetchImpl) => ({ config: { apiKey: 'a', apiSecret: 'b' }, fetchImpl, limiter: async () => {}, tokens: {} });

  it('compares the expected date with the standard for that service', async () => {
    const { onTime } = await enrichRecord(record, options(quoteFetch([QUOTE('DOM.RP', 'Regular Parcel', 25.71, 7)])));
    expect(onTime).toEqual({ standardDate: '2026-11-11', transitDays: 7, daysBehind: 2 });
  });

  it('shows nothing, and keeps the parcel, when no standard is available', async () => {
    const failing = quoteFetch({ title: 'x', detail: 'y', errors: [{ errorCode: '9', message: 'No services' }] }, 400);
    await expect(enrichRecord(record, options(failing))).resolves.toMatchObject({ onTime: null, pickup: null, serviceCode: 'DOM.RP' });
  });

  it('adds Post Office hours for a parcel being held', async () => {
    const held = { ...record, pickupOfficeId: '0000020990' };
    const { pickup } = await enrichRecord(held, options(quoteFetch([])));
    expect(pickup).toMatchObject({ city: 'Windsor', province: 'ON' });
  });
});

describe('air routes', () => {
  const facility = (id) => FACILITIES.find((f) => f.id === id);
  const at = (id) => ({ lat: facility(id).lat, lon: facility(id).lon, region: facility(id).province[0], label: facility(id).name, facilityId: id });
  const to = (id) => ({ lat: facility(id).lat, lon: facility(id).lon, label: facility(id).name, facilityIds: [id] });

  it('flies between hubs', () => {
    const route = predictAirRoute({ from: at('mtl'), destination: to('van') });
    expect(route.segments.map((s) => s.mode)).toEqual(['road', 'air', 'road']);
    expect(route.stops.map((s) => s.id)).toEqual(['van']);
    expect(route.usesAir).toBe(true);
  });

  it('drives to and from hubs where needed', () => {
    const route = predictAirRoute({ from: at('sas'), destination: to('win') });
    const modes = route.segments.map((s) => s.mode);
    expect(modes).toContain('air');
    expect(modes[0]).toBe('road');
    expect(route.stops.at(-1).id).toBe('win');
  });

  it('has no air route when one hub serves both ends', () => {
    expect(predictAirRoute({ from: at('ham'), destination: to('kit') })).toBeNull();
  });
});

describe('route shapes', () => {
  const facility = (id) => FACILITIES.find((f) => f.id === id);
  const at = (id) => ({ lat: facility(id).lat, lon: facility(id).lon, region: facility(id).province[0], label: facility(id).name, facilityId: id });
  const to = (id) => ({ lat: facility(id).lat, lon: facility(id).lon, label: facility(id).name, facilityIds: [id] });

  it('follows stored roads and ferry lanes, joined end to end', () => {
    const route = predictRoute({ from: at('stj'), destination: to('hfx') });
    expect(route.segments.every((s) => s.coords.length > 10)).toBe(true);
    route.segments.slice(1).forEach((segment, i) => expect(segment.coords[0]).toEqual(route.segments[i].coords.at(-1)));
    expect(route.segments[0].coords[0]).toEqual({ lat: facility('stj').lat, lon: facility('stj').lon });
  });

  it('reverses a stored path when travelling the other way', () => {
    expect(storedPath('hfx', 'mct')).toEqual(storedPath('mct', 'hfx').reverse());
    expect(storedPath('hfx', 'van')).toBeNull();
  });

  it('keeps the Toronto to Winnipeg road in Canada, through Thunder Bay', () => {
    const path = storedPath('tor', 'wpg');
    expect(Math.min(...path.map((p) => p.lat))).toBeGreaterThan(43.6);
    expect(path.some((p) => Math.abs(p.lat - 48.4) < 0.1 && Math.abs(p.lon + 89.25) < 0.3)).toBe(true);
  });

  it('flies between airports along a great circle', () => {
    const route = predictAirRoute({ from: at('mtl'), destination: to('van') });
    const flight = route.segments.find((s) => s.mode === 'air');
    expect(flight.coords[0]).toEqual({ lat: 45.4706, lon: -73.7408 });
    expect(flight.coords.at(-1)).toEqual({ lat: 49.1947, lon: -123.1792 });
    // The straight map line stays below 49.2; the great circle bends north of it.
    expect(Math.max(...flight.coords.map((p) => p.lat))).toBeGreaterThan(50);
    expect(flight.label).toContain('YUL → YVR');
  });

  it('makes a great circle as long as the distance between its ends', () => {
    const a = { lat: 47.6, lon: -52.75 };
    const b = { lat: 49.2, lon: -123.18 };
    const path = greatCirclePath(a, b);
    const length = path.slice(1).reduce((km, point, i) => km + distanceKm(path[i], point), 0);
    expect(Math.abs(length - distanceKm(a, b))).toBeLessThan(1);
  });

  it('drops points that do not change the shape', () => {
    expect(simplify([[0, 0], [0.00001, 1], [0, 2], [1, 3]], 0.001)).toEqual([[0, 0], [0, 2], [1, 3]]);
  });
});

describe('road lookups', () => {
  const a = { lat: 49.65, lon: -54.75 };
  const b = { lat: 49.2, lon: -55 };
  const route = (overrides = {}) => ({ code: 'Ok', waypoints: [{ distance: 10 }, { distance: 10 }], routes: [{ distance: 70_000, geometry: { coordinates: [[-54.75, 49.65], [-54.9, 49.4], [-55, 49.2]] } }], ...overrides });
  const reply = (body) => async () => new Response(JSON.stringify(body));
  const leg = { segments: [{ from: 'A', to: 'B', mode: 'road', coords: [a, b] }] };

  it('replaces a straight leg with the road, keeping exact ends', async () => {
    const { addRoadGeometry } = createRoadRouter({ fetchImpl: reply(route()), minGapMs: 0 });
    const { segments } = await addRoadGeometry(leg);
    expect(segments[0].coords.length).toBeGreaterThan(2);
    expect(segments[0].coords[0]).toEqual(a);
    expect(segments[0].coords.at(-1)).toEqual(b);
  });

  it('asks only once for the same leg', async () => {
    let calls = 0;
    const fetchImpl = async () => ((calls += 1), new Response(JSON.stringify(route())));
    const { roadBetween } = createRoadRouter({ fetchImpl, minGapMs: 0 });
    await roadBetween(a, b);
    await roadBetween(a, b);
    expect(calls).toBe(1);
  });

  it('leaves ferry, air and already detailed legs alone', async () => {
    let calls = 0;
    const fetchImpl = async () => ((calls += 1), new Response(JSON.stringify(route())));
    const { addRoadGeometry } = createRoadRouter({ fetchImpl, minGapMs: 0 });
    await addRoadGeometry({ segments: [{ mode: 'ferry', coords: [a, b] }, { mode: 'air', coords: [a, b] }, { mode: 'road', coords: [a, a, b] }] });
    expect(calls).toBe(0);
  });

  it('keeps a straight line for a place with no road nearby', async () => {
    const offRoad = route({ waypoints: [{ distance: 90_000 }, { distance: 10 }] });
    const { addRoadGeometry } = createRoadRouter({ fetchImpl: reply(offRoad), minGapMs: 0 });
    const { segments } = await addRoadGeometry(leg);
    expect(segments[0]).toMatchObject({ coords: [a, b], noRoadData: true });
  });

  it('keeps a straight line for an absurd detour', async () => {
    const detour = route({ routes: [{ distance: 900_000, geometry: { coordinates: [[-54.75, 49.65], [-55, 49.2]] } }] });
    const { roadBetween } = createRoadRouter({ fetchImpl: reply(detour), minGapMs: 0 });
    await expect(roadBetween(a, b)).resolves.toBeNull();
  });

  it('survives an outage, stops asking for a while, and does not remember the failure', async () => {
    let calls = 0;
    let clock = 0;
    let working = false;
    const fetchImpl = async () => {
      calls += 1;
      if (!working) throw new Error('offline');
      return new Response(JSON.stringify(route()));
    };
    const { roadBetween } = createRoadRouter({ fetchImpl, minGapMs: 0, now: () => clock });
    await expect(roadBetween(a, b)).resolves.toBeNull();
    await expect(roadBetween(a, b)).resolves.toBeNull();
    expect(calls).toBe(1);
    clock = 120_000;
    working = true;
    await expect(roadBetween(a, b)).resolves.not.toBeNull();
  });
});

describe('exact locations', () => {
  it('gives every hub a street address and a building, not a city centre', () => {
    expect(HUBS).toHaveLength(24);
    for (const hub of HUBS) {
      expect(hub.address).toMatch(/\d.*, [A-Z]{2}/);
      expect(Number.isFinite(hub.lat) && Number.isFinite(hub.lon)).toBe(true);
    }
    expect(HUBS.find((hub) => hub.id === 'mtl')).toMatchObject({ name: 'Léo Blanchette Plant', lat: 45.48731 });
  });

  it('says so when a facility has no published address', () => {
    expect(HUBS.find((hub) => hub.id === 'fre').note).toMatch(/main Post Office/);
    expect(HUBS.find((hub) => hub.id === 'mtl').note).toBeNull();
  });

  it('tells the Toronto plants apart by postal area', () => {
    expect(findOtherHub({ city: 'Toronto', region: 'ON', postalCode: 'M1X 0A5' }).id).toBe('ajk');
    expect(findOtherHub({ city: 'Toronto', region: 'ON', postalCode: 'M4L 1A5' }).id).toBe('tsc');
    expect(findOtherHub({ city: 'Toronto', region: 'ON', postalCode: 'M5V 2T6' })).toBeNull();
    expect(findOtherHub({ city: 'Thunder Bay', region: 'ON', postalCode: null }).id).toBe('tby');
  });

  const record = (events, destination = { city: null, region: null, postalCode: 'N9A 6S1' }) => ({ pin: 'x', status: 'In transit', delivered: false, destination, events });
  const scan = (city, region, postalCode = null) => ({ date: '2026-11-09', time: null, description: 'Item processed', city, region, postalCode, country: 'CA' });
  const office = { lat: 44.16, lon: -77.38, label: 'Belleville, ON', site: { name: 'Belleville PO', address: '1 Front St, Belleville, ON' } };

  it('puts a plant scan on the plant', async () => {
    const view = await buildView(record([scan('Montréal', 'QC', 'H4T 1T4')]), { geocode: async () => null });
    expect(view.places[0]).toMatchObject({ lat: 45.48731, site: { name: 'Léo Blanchette Plant', address: expect.stringContaining('555 McArthur') } });
  });

  it('puts a town scan on its Post Office and says it is not certain', async () => {
    const view = await buildView(record([scan('Belleville', 'ON')]), { geocode: async () => office });
    expect(view.places[0]).toMatchObject({ lat: 44.16, site: { name: 'Belleville PO', note: expect.stringContaining('Closest Post Office') } });
  });

  it('says a scan is only at the town centre when no office is known', async () => {
    const view = await buildView(record([scan('Belleville', 'ON')]), { geocode: async () => ({ lat: 44.16, lon: -77.38 }) });
    expect(view.places[0].site.note).toMatch(/Town centre/);
  });

  it('keeps a destination city at its Post Office, not the sorting plant', async () => {
    const destination = { city: 'Windsor', region: 'ON', postalCode: null };
    const view = await buildView(record([scan('Montréal', 'QC')], destination), { geocode: async () => ({ lat: 42.31, lon: -83.04, site: { name: 'Windsor PO', address: 'x' } }) });
    expect(view.destinationPoint).toMatchObject({ lat: 42.31, site: { name: 'Windsor PO' } });
    expect(view.predicted.segments.at(-1).to).toBe('Windsor, ON');
    expect(view.predicted.stopsRemaining).toBe(2); // A short last hop doesn't count as a stop.
  });

  it('carries the building details on predicted stops', () => {
    const facility = (id) => FACILITIES.find((f) => f.id === id);
    const route = predictRoute({
      from: { lat: facility('mtl').lat, lon: facility('mtl').lon, region: 'QC', label: 'Montréal', facilityId: 'mtl' },
      destination: { lat: facility('win').lat, lon: facility('win').lon, label: 'Windsor', facilityIds: ['win'] },
    });
    expect(route.stops[0].site.address).toContain('4567 Dixie');
  });
});

describe('choosing a route for a service', () => {
  it('assumes a flight only when a truck could not keep up', () => {
    expect(chooseRouteKind({ transitDays: 2, groundKm: 3300, hasAirRoute: true })).toBe('air');
    expect(chooseRouteKind({ transitDays: 7, groundKm: 3300, hasAirRoute: true })).toBe('ground');
    expect(chooseRouteKind({ transitDays: 1, groundKm: 450, hasAirRoute: true })).toBe('ground');
  });

  it('stays on the road without the data to decide', () => {
    expect(chooseRouteKind({ transitDays: null, groundKm: 3300, hasAirRoute: true })).toBe('ground');
    expect(chooseRouteKind({ transitDays: 1, groundKm: 3300, hasAirRoute: false })).toBe('ground');
  });
});

describe('estimates', () => {
  const services = (overrides = {}) => ({
    getRates: async () => parseRates([QUOTE('DOM.RP', 'Regular Parcel', 25.71, 7), QUOTE('DOM.PC', 'Priority', 78.06, 2, true)]),
    locatePostalCode: async () => null,
    locateCity: async (city) => (city === 'Twillingate' ? { lat: 49.65, lon: -54.75, city: 'Twillingate', province: 'NL', postalCode: 'A0G4M0', label: 'Twillingate, NL' } : null),
    ...overrides,
  });

  it('gives a price and a route for each service', async () => {
    const estimate = await buildEstimate({ from: 'Twillingate, NL', to: 'N9A 6S1', weightKg: 1 }, services());
    expect(estimate.from.postalCode).toBe('A0G4M0');
    expect(estimate.to.postalCode).toBe('N9A6S1');
    expect(estimate.services.map((s) => [s.code, s.routeKind])).toEqual([['DOM.RP', 'ground'], ['DOM.PC', 'air']]);
    expect(estimate.routes.ground.usesFerry).toBe(true);
    expect(estimate.routes.air.usesAir).toBe(true);
  });

  it('asks for a postal code when a town cannot be found', async () => {
    await expect(buildEstimate({ from: 'Nowhereville, NL', to: 'N9A 6S1' }, services())).rejects.toThrow(/postal code/);
  });

  it('asks for a province, unless the town is a known facility city', async () => {
    await expect(buildEstimate({ from: 'Twillingate', to: 'N9A 6S1' }, services())).rejects.toThrow(/Add the province/);
    let asked;
    const locateCity = async (city, province) => {
      asked = province;
      return { lat: 44.6, lon: -63.5, city, province, postalCode: 'B3H1A1', label: `${city}, ${province}` };
    };
    await buildEstimate({ from: 'Halifax', to: 'N9A 6S1' }, services({ locateCity }));
    expect(asked).toBe('NS');
  });

  it('still prices a postal area Canada Post cannot place on the map', async () => {
    const locatePostalCode = async () => {
      throw new TrackingError('bad_request', 'The Postal Code is invalid.');
    };
    const estimate = await buildEstimate({ from: 'N9C', to: 'T2P' }, services({ locatePostalCode }));
    expect(estimate.services).toHaveLength(2);
    expect(estimate.to).toMatchObject({ lat: FACILITIES.find((f) => f.id === 'cal').lat });
  });

  it('rejects an empty location and an impossible weight', async () => {
    await expect(buildEstimate({ from: '', to: 'N9A 6S1' }, services())).rejects.toMatchObject({ code: 'bad_request' });
    await expect(buildEstimate({ from: 'N9A 6S1', to: 'K1A 0B1', weightKg: 500 }, services())).rejects.toMatchObject({ code: 'bad_request' });
  });

  it('accepts a three-character postal area', async () => {
    let asked;
    const estimate = await buildEstimate({ from: 'N9C', to: 'K1A', weightKg: 1 }, services({ getRates: async (q) => ((asked = q), []) }));
    expect(asked).toMatchObject({ origin: 'N9C1A1', destination: 'K1A1A1' });
    expect(estimate.services).toEqual([]);
  });
});
