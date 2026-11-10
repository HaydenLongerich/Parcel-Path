import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { FACILITIES } from '../server/route/facilities.js';
import { buildGraph, landmassOf, nearestFacility, predictRoute } from '../server/route/predict.js';
import { buildView, hasActiveDelay, parseDestinationInput } from '../server/buildView.js';

describe('hasActiveDelay', () => {
  const scan = (location) => ({ isDelay: false, location });
  const delay = (location = null) => ({ isDelay: true, location });
  it('is false with no delay', () => expect(hasActiveDelay([scan('A'), scan('B')])).toBe(false));
  it('is true when the delay is the latest event', () => expect(hasActiveDelay([scan('A'), delay()])).toBe(true));
  it('is false once a later scan shows movement', () => expect(hasActiveDelay([scan('A'), delay(), scan('B')])).toBe(false));
  it('ignores later events with no location', () => expect(hasActiveDelay([scan('A'), delay(), scan(null)])).toBe(true));
  it('uses the newest delay', () => expect(hasActiveDelay([delay(), scan('B'), delay('C')])).toBe(true));
});

const facility = (id) => FACILITIES.find((f) => f.id === id);
const fromFacility = (id) => {
  const f = facility(id);
  return { lat: f.lat, lon: f.lon, region: f.province[0], label: f.name, facilityId: id };
};
const toFacility = (id, label = facility(id).name) => {
  const f = facility(id);
  return { lat: f.lat, lon: f.lon, label, facilityIds: [id] };
};
const ids = (route) => route.stops.map((stop) => stop.id);

const TWILLINGATE = { lat: 49.6566, lon: -54.7574, region: 'NL', label: 'Twillingate, NL' };

describe('route prediction', () => {
  it('routes the demo parcel from Montréal through Toronto to Windsor', () => {
    const route = predictRoute({ from: fromFacility('mtl'), destination: toFacility('win') });
    expect(ids(route)).toEqual(['tor', 'win']);
    expect(route.stopsRemaining).toBe(2);
    expect(route.isEstimate).toBe(true);
    expect(route.usesFerry).toBe(false);
  });

  it('takes the Newfoundland ferry out of St. John\'s', () => {
    const route = predictRoute({ from: fromFacility('stj'), destination: toFacility('win') });
    expect(ids(route).slice(0, 3)).toEqual(['pab', 'nsy', 'mct']);
    expect(route.usesFerry).toBe(true);
    expect(route.segments.find((s) => s.mode === 'ferry').from).toBe('Port aux Basques');
  });

  it('takes the ferry into Newfoundland too', () => {
    const route = predictRoute({ from: fromFacility('tor'), destination: toFacility('stj') });
    expect(ids(route)).toEqual(['mtl', 'mct', 'nsy', 'pab', 'stj']);
  });

  it('does not count ferry terminals as stops', () => {
    const route = predictRoute({ from: fromFacility('stj'), destination: toFacility('mct') });
    expect(ids(route)).toEqual(['pab', 'nsy', 'mct']);
    expect(route.stopsRemaining).toBe(1);
  });

  it('sends an outport NL scan to the ferry instead of back to St. John\'s', () => {
    const route = predictRoute({ from: TWILLINGATE, destination: toFacility('win') });
    expect(ids(route).slice(0, 3)).toEqual(['pab', 'nsy', 'mct']);
    expect(ids(route)).not.toContain('stj');
  });

  it('crosses Canada along the prairie corridor', () => {
    const route = predictRoute({ from: fromFacility('mct'), destination: toFacility('van') });
    expect(ids(route)).toEqual(['mtl', 'tor', 'wpg', 'reg', 'cal', 'van']);
  });

  it('reaches Victoria by ferry from Vancouver', () => {
    const route = predictRoute({ from: fromFacility('cal'), destination: toFacility('vic') });
    expect(ids(route)).toEqual(['van', 'tsa', 'swb', 'vic']);
    expect(route.segments.map((s) => s.mode)).toContain('ferry');
    expect(route.segments.at(-1).mode).toBe('road');
  });

  it('adds a final leg and stop for a town beyond its facility', () => {
    const route = predictRoute({
      from: fromFacility('mtl'),
      destination: { lat: 42.0, lon: -82.6, label: 'Leamington, ON', facilityIds: ['win'] },
    });
    expect(route.segments.at(-1).to).toBe('Leamington, ON');
    expect(route.stopsRemaining).toBe(3);
  });

  it('picks the closer facility where the table allows two', () => {
    const destination = { lat: 48.38, lon: -89.25, label: 'Thunder Bay, ON', facilityIds: ['tor', 'wpg'] };
    expect(predictRoute({ from: fromFacility('reg'), destination }).destinationFacilityId).toBe('wpg');
    expect(predictRoute({ from: fromFacility('mtl'), destination }).destinationFacilityId).toBe('tor');
  });

  it('returns null once the parcel is at its destination', () => {
    expect(predictRoute({ from: fromFacility('win'), destination: toFacility('win') })).toBeNull();
  });

  it('returns null when the destination facility is unknown to the graph', () => {
    expect(predictRoute({ from: fromFacility('mtl'), destination: { lat: 45, lon: -70, label: 'X', facilityIds: ['nope'] } })).toBeNull();
  });

  it('rejects a network that references a missing node', () => {
    expect(() => buildGraph(FACILITIES, { waypoints: [], edges: [{ a: 'mtl', b: 'nope', km: 1 }] })).toThrow(/unknown node/);
  });

  it('connects every facility to the rest of the network', () => {
    for (const f of FACILITIES.filter((x) => x.id !== 'tor')) {
      expect(predictRoute({ from: fromFacility('tor'), destination: toFacility(f.id) })).not.toBeNull();
    }
  });
});

describe('landmass rules', () => {
  it('separates island Newfoundland from Labrador', () => {
    expect(landmassOf(TWILLINGATE)).toBe('newfoundland');
    expect(landmassOf({ lat: 53.3, lon: -60.4, region: 'NL' })).toBe('mainland');
  });

  it('separates Vancouver Island from the BC mainland', () => {
    expect(landmassOf({ lat: 49.16, lon: -123.94, region: 'BC' })).toBe('vancouver-island'); // Nanaimo
    expect(landmassOf({ lat: 49.28, lon: -123.12, region: 'BC' })).toBe('mainland'); // Vancouver
  });

  it('keeps nearest-facility on the same landmass', () => {
    expect(nearestFacility({ lat: 49.16, lon: -123.94, region: 'BC' }).id).toBe('vic');
  });
});

describe('full view from the demo fixture', () => {
  const demo = JSON.parse(readFileSync(new URL('../server/data/demo-parcel.json', import.meta.url), 'utf8'));
  const geocode = async ({ city }) => (city === 'Twillingate' ? { lat: 49.6566, lon: -54.7574 } : null);

  it('builds the summary, places and predicted route', async () => {
    const view = await buildView(demo, { geocode });
    expect(view.summary).toMatchObject({
      origin: 'Twillingate, NL',
      destination: 'Windsor, ON',
      service: 'Expedited Parcel',
      stopsRemaining: 2,
      expectedDelivery: null,
    });
    expect(view.places.map((p) => p.label)).toEqual(['Twillingate, NL', 'Dieppe, NB', 'Montréal, QC']);
    expect(view.places.find((p) => p.isCurrent).label).toBe('Montréal, QC');
    expect(view.travelled).toHaveLength(3);
    expect(view.predicted.stops.map((s) => s.id)).toEqual(['tor', 'win']);
  });

  it('adds up the stats row', async () => {
    const { stats } = await buildView(demo, { geocode });
    expect(stats.stopsCompleted).toBe(3);
    expect(stats.daysInTransit).toBe(8);
    expect(stats.kmTravelled).toBeGreaterThan(1200);
    expect(stats.kmTravelled).toBeLessThan(1900);
  });

  it('stops counting days at delivery', async () => {
    const { stats } = await buildView({ ...demo, delivered: true, asOf: '2027-01-01' }, { geocode });
    expect(stats.daysInTransit).toBe(8);
  });

  it('flags delay notices in the timeline, but drops the summary flag once the parcel moves on', async () => {
    const view = await buildView(demo, { geocode });
    expect(view.events.filter((e) => e.isDelay)).toHaveLength(1);
    expect(view.summary.hasDelay).toBe(false);
  });

  it('keeps the summary delay flag while the delay is the latest news', async () => {
    const delay = demo.events.find((e) => /delay/i.test(e.description));
    const events = [...demo.events.filter((e) => e !== delay), { ...delay, date: '2099-01-01' }];
    const view = await buildView({ ...demo, events }, { geocode });
    expect(view.summary.hasDelay).toBe(true);
    expect((await buildView({ ...demo, events, delivered: true }, { geocode })).summary.hasDelay).toBe(false);
  });

  it('keeps the national notice in the timeline but off the map', async () => {
    const view = await buildView(demo, { geocode });
    const notice = view.events.find((e) => e.description.includes('delayed'));
    expect(notice.location).toBeNull();
    expect(notice.placeId).toBeNull();
  });

  it('groups repeat scans at one place under one marker', async () => {
    const view = await buildView(demo, { geocode });
    expect(view.places.find((p) => p.label === 'Dieppe, NB').eventIds).toHaveLength(2);
  });

  it('predicts nothing once delivered', async () => {
    const view = await buildView({ ...demo, delivered: true, status: 'Delivered' }, { geocode });
    expect(view.predicted).toBeNull();
    expect(view.summary.stopsRemaining).toBe(0);
  });

  it('asks for a destination when none is known', async () => {
    const view = await buildView({ ...demo, destination: null }, { geocode });
    expect(view.predicted).toBeNull();
    expect(view.routeNote).toMatch(/did not provide a destination/);
  });

  it('lets the user supply the destination', async () => {
    const view = await buildView(
      { ...demo, destination: null },
      { geocode, destinationOverride: parseDestinationInput('T2P') },
    );
    expect(view.predicted.destinationFacilityId).toBe('cal');
  });
});

describe('destination input', () => {
  it('reads postal codes, FSAs and cities', () => {
    expect(parseDestinationInput('n9a 1a1').postalCode).toBe('N9A 1A1');
    expect(parseDestinationInput('N9A').postalCode).toBe('N9A');
    expect(parseDestinationInput('Windsor, on')).toEqual({ city: 'Windsor', region: 'ON', postalCode: null });
    expect(parseDestinationInput('  ')).toBeNull();
  });
});
