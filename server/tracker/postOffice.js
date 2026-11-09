// Post Office details and locations from Canada Post's Post Office Services API.
import { callApi } from './apiClient.js';
import { clean, titleCase, TrackingError } from './common.js';

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const CACHE_MS = 24 * 60 * 60_000;
const CACHE_LIMIT = 500;

const cache = new Map();

async function remembered(key, load, now = Date.now) {
  const hit = cache.get(key);
  if (hit && now() < hit.expiresAt) return hit.value;
  const value = await load();
  cache.delete(key);
  cache.set(key, { value, expiresAt: now() + CACHE_MS });
  if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value);
  return value;
}

/** Times come as open, close, and optionally a second open and close. A missing close means open to end of day. */
function formatPeriods(times) {
  const periods = [];
  for (let i = 0; i < times.length; i += 2) periods.push(`${times[i]}–${times[i + 1] ?? 'close'}`);
  return periods;
}

export function parsePostOffice(office) {
  if (!office?.address || !Array.isArray(office.hoursList)) {
    throw new TrackingError('format_changed', 'The Post Office response has an unexpected format.');
  }
  const { address } = office;
  return {
    id: clean(office.officeId),
    name: titleCase(clean(office.name)),
    location: titleCase(clean(office.location)),
    street: titleCase(clean(address.officeAddress)),
    city: titleCase(clean(address.city)),
    province: clean(address.province),
    postalCode: clean(address.postalCode),
    lat: Number(address.latitude),
    lon: Number(address.longitude),
    hours: DAYS.map((day, index) => {
      const entry = office.hoursList.find((item) => Number(item.day) === index + 1);
      return { day, periods: entry ? formatPeriods(entry.time ?? []) : [] };
    }),
  };
}

export function getPostOffice(id, options) {
  return remembered(`office:${id}`, async () =>
    parsePostOffice(await callApi(`/postoffice/v1/post-offices/${encodeURIComponent(id)}/details`, { ...options, product: 'Post Office Services' })),
  );
}

function toLocation(office) {
  const lat = Number(office?.address?.latitude);
  const lon = Number(office?.address?.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  const city = titleCase(clean(office.address.city));
  const province = clean(office.address.province);
  return { lat, lon, city, province, postalCode: clean(office.address.postalCode)?.replace(/\s/g, ''), label: [city, province].filter(Boolean).join(', ') };
}

const normalizeName = (text) => (text ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

async function findOffices(query, maximum, options) {
  const offices = await callApi(`/postoffice/v1/post-offices?${new URLSearchParams({ ...query, maximum: String(maximum) })}`, { ...options, product: 'Post Office Services' });
  return Array.isArray(offices) ? offices : [];
}

/** Finds the area around a postal code, using its closest Post Office. */
export function locatePostalCode(postalCode, options) {
  return remembered(`postal:${postalCode}`, async () => toLocation((await findOffices({ 'postal-code': postalCode }, 1, options))[0]));
}

/**
 * Finds a town and a usable postal code for it. Canada Post can list a neighbouring
 * town's office first, so this prefers one that's actually in the town asked for.
 */
export function locateCity(city, province, options) {
  return remembered(`city:${city}|${province}`.toLowerCase(), async () => {
    const offices = await findOffices({ city, province }, 10, options);
    const wanted = normalizeName(city);
    const location = toLocation(offices.find((office) => normalizeName(office.address?.city) === wanted) ?? offices[0]);
    if (!location) return null;
    const name = titleCase(city.toUpperCase());
    return { ...location, city: name, label: `${name}, ${province}` };
  });
}
