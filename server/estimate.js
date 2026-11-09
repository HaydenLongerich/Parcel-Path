// Prices a shipment and works out the likely route for each Canada Post service.
import { parseDestinationInput } from './buildView.js';
import { lookupFsa, matchFacilityByName, provinceFromFsa } from './route/facilities.js';
import { predictAirRoute, predictRoute } from './route/predict.js';
import { fullPostalCode, TrackingError } from './tracker/common.js';

// Canada Post doesn't publish which services fly. If a standard needs more than a truck
// can plausibly cover per business day, assume the parcel flies the long-haul part.
const AIR_KM_PER_BUSINESS_DAY = 800;

export function chooseRouteKind({ transitDays, groundKm, hasAirRoute }) {
  if (!hasAirRoute || !transitDays || !groundKm) return 'ground';
  return groundKm / transitDays > AIR_KM_PER_BUSINESS_DAY ? 'air' : 'ground';
}

async function resolveLocation(text, role, { locatePostalCode, locateCity }) {
  const parsed = parseDestinationInput(text);
  if (!parsed) throw new TrackingError('bad_request', `Enter a ${role} postal code or town.`);

  // A place Canada Post can't locate isn't fatal for postal codes: rates can still work.
  const tolerate = (lookup) => lookup.catch((error) => {
    if (error.code === 'bad_request' || error.code === 'not_found') return null;
    throw error;
  });

  let postalCode = fullPostalCode(parsed.postalCode);
  let found = null;
  if (postalCode) {
    found = await tolerate(locatePostalCode(postalCode));
  } else {
    const region = parsed.region ?? matchFacilityByName(parsed.city, null)?.province[0];
    if (!region) throw new TrackingError('bad_request', `Add the province to "${text}", like "${parsed.city}, ON".`);
    found = await tolerate(locateCity(parsed.city, region));
    postalCode = fullPostalCode(found?.postalCode);
    if (!postalCode) throw new TrackingError('bad_request', `Couldn't find "${text}". Try its postal code instead.`);
  }

  const lookup = lookupFsa(postalCode);
  if (!lookup) throw new TrackingError('bad_request', `"${text}" isn't a postal code Canada Post's parcel network serves.`);

  const province = found?.province ?? provinceFromFsa(postalCode);
  const facility = matchFacilityByName(found?.city ?? parsed.city, province);
  return {
    postalCode,
    label: found?.label ?? [parsed.postalCode ?? parsed.city, province].filter(Boolean).join(', '),
    lat: found?.lat ?? lookup.facility.lat,
    lon: found?.lon ?? lookup.facility.lon,
    region: province,
    facilityId: facility?.id ?? null,
    facilityIds: lookup.facilities.map((f) => f.id),
  };
}

export async function buildEstimate({ from, to, weightKg }, services) {
  const weight = Number(weightKg ?? 1);
  if (!Number.isFinite(weight) || weight <= 0 || weight > 30) throw new TrackingError('bad_request', 'Enter a weight between 0.001 and 30 kg.');

  const origin = await resolveLocation(from, 'starting', services);
  const destination = await resolveLocation(to, 'destination', services);
  const quotes = await services.getRates({ origin: origin.postalCode, destination: destination.postalCode, weightKg: weight });

  const routeFrom = { lat: origin.lat, lon: origin.lon, region: origin.region, label: origin.label, facilityId: origin.facilityId };
  const routeTo = { lat: destination.lat, lon: destination.lon, label: destination.label, facilityIds: destination.facilityIds };
  const addRoads = services.addRoadGeometry ?? (async (route) => route);
  const ground = await addRoads(predictRoute({ from: routeFrom, destination: routeTo }));
  const air = await addRoads(predictAirRoute({ from: routeFrom, destination: routeTo }));

  return {
    from: { label: origin.label, postalCode: origin.postalCode, lat: origin.lat, lon: origin.lon },
    to: { label: destination.label, postalCode: destination.postalCode, lat: destination.lat, lon: destination.lon },
    weightKg: weight,
    routes: { ground, air },
    services: quotes.map((quote) => ({
      ...quote,
      routeKind: chooseRouteKind({ transitDays: quote.transitDays, groundKm: ground?.distanceKm, hasAirRoute: Boolean(air) }),
    })),
  };
}
