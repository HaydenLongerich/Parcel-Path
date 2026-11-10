// Turns a tracking record into everything the map, timeline and summary need.
import { findOtherHub, lookupFsa, matchFacilityByName, toSite } from './route/facilities.js';
import { distanceKm, nearestFacility, predictRoute } from './route/predict.js';

const DAY_MS = 86_400_000;
const NEARBY_TOWNS_KM = 300;

const SCAN_OFFICE_NOTE = "Closest Post Office. Canada Post doesn't say which building made this scan.";
const SCAN_TOWN_NOTE = "Town centre. Canada Post doesn't say which building made this scan.";
const DESTINATION_OFFICE_NOTE = "Closest Post Office. Canada Post doesn't share the delivery address.";
const DESTINATION_AREA_NOTE = "Centre of the destination area. Canada Post doesn't share the delivery address.";
const dayNumber = (iso) => Math.floor(Date.parse(`${iso.slice(0, 10)}T00:00:00Z`) / DAY_MS);

function buildStats(record, route) {
  const first = record.events[0]?.date;
  // A parcel still moving counts up to today; a fixture can pin that date with `asOf`.
  const end = record.delivered ? record.events.at(-1)?.date : (record.asOf ?? new Date().toISOString());
  return {
    stopsCompleted: route.length,
    kmTravelled: Math.round(route.slice(1).reduce((km, place, i) => km + distanceKm(route[i], place), 0)),
    daysInTransit: first && end ? Math.max(0, dayNumber(end) - dayNumber(first)) : null,
  };
}

const placeKey = (event) => `${event.city}|${event.region ?? ''}|${event.country ?? ''}`.toLowerCase();
const placeLabel = ({ city, region }) => [city, region].filter(Boolean).join(', ');

const isCanadian = (event) => (event.country ? event.country === 'CA' : Boolean(event.region));

async function resolvePlace(event, geocode) {
  const inCanada = isCanadian(event);
  const otherHub = inCanada ? findOtherHub(event) : null;
  if (otherHub) {
    return { lat: otherHub.lat, lon: otherHub.lon, kind: 'facility', facilityId: null, facilityName: otherHub.plant, inCanada, site: toSite(otherHub) };
  }
  const facility = inCanada ? matchFacilityByName(event.city, event.region) : null;
  if (facility) {
    return { lat: facility.lat, lon: facility.lon, kind: 'facility', facilityId: facility.id, facilityName: facility.name, inCanada, site: toSite(facility) };
  }
  const hit = await geocode(event);
  if (!hit) return null;
  const site = hit.site ? { ...hit.site, note: SCAN_OFFICE_NOTE } : { name: null, address: null, note: SCAN_TOWN_NOTE };
  return { lat: hit.lat, lon: hit.lon, kind: 'geocoded', facilityId: null, facilityName: null, inCanada, site };
}

/** Accepts "N9A 1A1", "N9A" or "Windsor, ON". */
export function parseDestinationInput(text) {
  const value = text?.trim();
  if (!value) return null;
  if (/^[a-z]\d[a-z](\s*\d[a-z]\d)?$/i.test(value)) return { city: null, region: null, postalCode: value.toUpperCase() };
  const [city, region] = value.split(',').map((part) => part.trim());
  const province = region?.toUpperCase().match(/^[A-Z]{2}/)?.[0] ?? null;
  return { city, region: province, postalCode: null };
}

async function resolveDestination(destination, geocode) {
  if (!destination) return null;
  const { city, region, postalCode } = destination;
  const byName = city ? matchFacilityByName(city, region) : null;
  const byFsa = postalCode ? lookupFsa(postalCode) : null;
  const label = city ? placeLabel(destination) : [postalCode, region].filter(Boolean).join(', ');

  if (postalCode && !byFsa) return { label, unresolved: `No processing facility is listed for postal code ${postalCode}.` };

  const point = await geocode({ city, region, postalCode, country: 'CA' });
  const site = point?.site ? { ...point.site, note: DESTINATION_OFFICE_NOTE } : { name: null, address: null, note: DESTINATION_AREA_NOTE };

  // The destination is a place in that city, not the sorting plant that serves it.
  if (byName && (!byFsa || byFsa.facilities.includes(byName))) {
    return { label, lat: point?.lat ?? byName.lat, lon: point?.lon ?? byName.lon, facilityIds: [byName.id], site };
  }

  if (byFsa) {
    const fallback = byFsa.facility;
    return {
      label: point?.place ?? label,
      lat: point?.lat ?? fallback.lat,
      lon: point?.lon ?? fallback.lon,
      facilityIds: byFsa.facilities.map((f) => f.id),
      site,
    };
  }
  if (!point) return { label, unresolved: `Could not find "${label}" on the map.` };
  const nearest = nearestFacility({ ...point, region });
  return { label, lat: point.lat, lon: point.lon, facilityIds: [nearest.id], site };
}

/** The line between two scans. It follows the network, except between nearby towns or outside Canada. */
async function scanLeg(a, b, addRoads) {
  const straight = [{ lat: a.lat, lon: a.lon }, { lat: b.lat, lon: b.lon }];
  if (!a.inCanada || !b.inCanada) return straight;

  const direct = !a.facilityId && !b.facilityId && distanceKm(a, b) < NEARBY_TOWNS_KM;
  const targetId = b.facilityId ?? nearestFacility(b)?.id;
  let leg = null;
  if (direct) leg = { segments: [{ from: a.label, to: b.label, mode: 'road', coords: straight }] };
  else if (targetId) {
    leg = predictRoute({
      from: { lat: a.lat, lon: a.lon, region: a.region, label: a.label, facilityId: a.facilityId },
      destination: { lat: b.lat, lon: b.lon, label: b.label, facilityIds: [targetId] },
    });
  }
  if (!leg) return straight;
  return (await addRoads(leg)).segments.flatMap((segment) => segment.coords);
}

export async function buildView(record, { geocode, destinationOverride = null, addRoads = async (route) => route }) {
  const places = new Map();
  const route = [];
  const events = [];

  for (const [index, event] of record.events.entries()) {
    const id = `e${index}`;
    let placeId = null;
    if (event.city) {
      const key = placeKey(event);
      if (!places.has(key)) {
        const resolved = await resolvePlace(event, geocode);
        places.set(key, resolved && {
          id: `p${places.size}`,
          label: placeLabel(event),
          postalCode: null,
          region: event.region,
          eventIds: [],
          ...resolved,
        });
      }
      const place = places.get(key);
      if (place) {
        placeId = place.id;
        place.eventIds.push(id);
        place.postalCode ??= event.postalCode;
        if (route.at(-1) !== place) route.push(place);
      }
    }
    events.push({
      id,
      date: event.date,
      dateLabel: event.dateLabel ?? null,
      time: event.time,
      description: event.description,
      location: event.city ? placeLabel(event) : null,
      postalCode: event.postalCode,
      placeId,
      isDelay: event.isDelay ?? /delay/i.test(event.description),
    });
  }

  const current = route.at(-1) ?? null;
  const mapped = [...places.values()].filter(Boolean);
  for (const place of mapped) place.isCurrent = place === current;

  const destinationInput = destinationOverride ?? record.destination;
  const destination = await resolveDestination(destinationInput, geocode);

  let predicted = null;
  let routeNote = null;
  if (record.delivered) {
    routeNote = 'This item has been delivered, so no route is predicted.';
  } else if (!destination) {
    routeNote = 'Canada Post did not provide a destination. Enter a postal code or city to see a predicted route.';
  } else if (destination.unresolved) {
    routeNote = destination.unresolved;
  } else if (!current) {
    routeNote = 'No scan has a mappable location yet, so a route cannot be predicted.';
  } else if (!current.inCanada) {
    routeNote = 'The last scan is outside Canada, so the Canadian network cannot predict the route yet.';
  } else {
    predicted = await addRoads(predictRoute({
      from: { lat: current.lat, lon: current.lon, region: current.region, label: current.label, facilityId: current.facilityId },
      destination,
    }));
    if (!predicted) routeNote = 'The parcel is already at its destination area.';
  }

  const travelledPath = [];
  for (let i = 1; i < route.length; i++) travelledPath.push(...(await scanLeg(route[i - 1], route[i], addRoads)));

  const firstPlace = route[0] ?? null;
  return {
    pin: record.pin,
    summary: {
      origin: firstPlace?.label ?? record.originPostalId ?? null,
      destination: destination?.label ?? null,
      service: record.service ?? null,
      status: record.status,
      delivered: record.delivered,
      expectedDelivery: record.expectedDelivery ?? null,
      originalExpectedDelivery: record.originalExpectedDelivery ?? null,
      expectedChangeReason: record.expectedChangeReason ?? null,
      onTime: record.onTime ?? null,
      stopsRemaining: record.delivered ? 0 : (predicted?.stopsRemaining ?? null),
      hasDelay: events.some((event) => event.isDelay),
    },
    stats: buildStats(record, route),
    pickup: record.pickup ?? null,
    events,
    places: mapped,
    travelled: route.map((place) => ({ lat: place.lat, lon: place.lon })),
    travelledPath,
    destinationPoint: destination && !destination.unresolved ? { lat: destination.lat, lon: destination.lon, label: destination.label, site: destination.site ?? null } : null,
    predicted,
    routeNote,
  };
}
