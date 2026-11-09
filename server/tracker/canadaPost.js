// Live tracking through Canada Post's Tracking 2.0.0 API.
// https://developer-developpeur.canadapost-postescanada.ca/devportal-portaildesdeveloppeurs/product/tracking/api/tracking-api-1.0.0
//
// Each lookup makes two calls: details for the scans, and summaries for the delivery
// status and destination province.
import { readFileSync } from 'node:fs';
import { callApi } from './apiClient.js';
import { clean, dateOnly, titleCase, TrackingError } from './common.js';

// Summaries often leave out eventType, so each scan's type comes from Canada Post's code table.
const EVENT_TYPES = JSON.parse(readFileSync(new URL('../data/event-types.json', import.meta.url), 'utf8')).types;

// From the "Tracking scan events" table in Canada Post's messages and code tables.
const DELAY_CODES = new Set([
  '159', '160', '161', '162', '163', '171', '172', '173',
  '621', '622', '623', '624', '625', '626', '627', '628', '1412', '2412',
]);

const STATUS_BY_EVENT_TYPE = {
  DELIVERED: 'Delivered',
  OUT: 'Out for delivery',
  TO_RETAIL: 'Ready for pickup',
  TO_APL: 'Heading to parcel locker',
  INDUCTION: 'Accepted',
  INFO: 'In transit',
  INCOMING: 'In transit',
  VEHICLE_INFO: 'In transit',
  TRANSFER_ITEM: 'In transit',
  ARRIVAL_IN_CANADA: 'In customs',
  TO_CUST: 'In customs',
  FOR_REVIEW: 'In customs',
  DETENTION: 'Held by customs',
  RTS_LABEL_PROC: 'Returning to sender',
};

const SERVICE_CODES = [
  [/priority/i, 'DOM.PC'],
  [/xpresspost/i, 'DOM.XP'],
  [/expedited/i, 'DOM.EP'],
  [/regular/i, 'DOM.RP'],
];

const NOT_FOUND = 'Canada Post has no tracking history for this number. Check the number, or try again once the item has been scanned.';

function trackingErrorFor({ status, json }) {
  const errors = Array.isArray(json?.errors) ? json.errors : [];
  const codes = errors.map((error) => String(error.errorCode));
  if (codes.includes('004')) return new TrackingError('not_found', NOT_FOUND);
  if (codes.includes('002')) return new TrackingError('not_found', 'Canada Post found more than one item with this number, so it could not pick one.');
  if (status === 404 && errors.length > 0) return new TrackingError('not_found', NOT_FOUND);
  if (status === 404) return new TrackingError('format_changed', 'Canada Post answered with an unexpected HTTP 404.');
  if (status === 400) return new TrackingError('invalid_number', errors[0]?.message ?? 'Canada Post says this tracking number is not valid.');
  return null;
}

function parseEvent(event, provinceBySite) {
  const date = dateOnly(event?.eventDate);
  if (!date) throw new TrackingError('format_changed', 'A scan event was missing its date.');
  const site = clean(event.eventSite);
  // National notices arrive with the site "Canada" and province "Ca": no real location.
  const isNational = /^canada$/i.test(site ?? '');
  // Some domestic scans omit the province, so borrow it from another scan at the same site.
  const region = isNational ? null : (clean(event.eventProvince)?.toUpperCase() ?? provinceBySite.get(site) ?? null);
  const code = clean(event.eventIdentifier)?.replace(/^0+(?=\d)/, '') ?? null;
  return {
    date,
    time: clean(event.eventTime)?.slice(0, 5) ?? null,
    description: clean(event.eventDescription) ?? 'Scan recorded',
    city: site && !isNational ? titleCase(site) : null,
    region,
    postalCode: null,
    // Province is only sent for domestic events, so a scan without one is treated as foreign.
    country: region ? 'CA' : null,
    code,
    type: EVENT_TYPES[code] ?? null,
    isDelay: DELAY_CODES.has(code),
    retailLocationId: clean(event.eventRetailLocationId),
  };
}

function parseDestination(detail, summary) {
  const id = clean(detail.destinationPostalId ?? summary.destinationPostalId)?.replace(/\s/g, '').toUpperCase();
  if (!id || !/^[ABCEGHJKLMNPRSTVXY]\d[A-Z](\d[A-Z]\d)?$/.test(id)) return null; // Abroad, or absent.
  return {
    city: null,
    region: clean(summary.destinationProvince)?.toUpperCase() ?? null,
    postalCode: id.length === 6 ? `${id.slice(0, 3)} ${id.slice(3)}` : id,
  };
}

function statusFor(summary, delivered, latest) {
  if (delivered) return 'Delivered';
  if (latest?.code === '3000') return 'Shipping info received';
  const type = clean(summary.eventType) ?? latest?.type;
  if (type === 'ATTEMPTED') return dateOnly(summary.attemptedDate) ? 'Delivery attempted' : 'Delivery issue';
  return STATUS_BY_EVENT_TYPE[type] ?? latest?.description ?? 'Unknown';
}

/** Converts the two JSON responses into this app's tracking record. */
export function parseTracking(detail, summaries, pin) {
  const summary = Array.isArray(summaries) ? summaries[0] : null;
  if (!detail || typeof detail !== 'object' || !('pin' in detail) || !summary) {
    throw new TrackingError('format_changed', 'The tracking response no longer has the expected structure.');
  }
  if (summary.error) throw new TrackingError('not_found', NOT_FOUND);

  const rawEvents = detail.significantEvents ?? [];
  if (!Array.isArray(rawEvents)) throw new TrackingError('format_changed', 'The scan list has an unexpected format.');

  const provinceBySite = new Map();
  for (const event of rawEvents) {
    const site = clean(event?.eventSite);
    const province = clean(event?.eventProvince);
    if (site && province) provinceBySite.set(site, province.toUpperCase());
  }

  // Canada Post lists newest first. Reversing keeps same-minute scans in order after sorting.
  const events = rawEvents
    .map((event) => parseEvent(event, provinceBySite))
    .reverse()
    .sort((a, b) => `${a.date} ${a.time ?? ''}`.localeCompare(`${b.date} ${b.time ?? ''}`));

  const actual = dateOnly(summary.actualDeliveryDate);
  const delivered = Boolean(actual) || clean(summary.eventType) === 'DELIVERED' || events.some((event) => event.type === 'DELIVERED');
  // A signature record can follow delivery, but it says nothing about where the parcel is.
  const latest = events.filter((event) => event.type !== 'SIGNATURE').at(-1);
  const standard = dateOnly(detail.expectedDeliveryDate) ?? dateOnly(summary.expectedDeliveryDate);
  const changed = dateOnly(detail.changedExpectedDate);
  const service = clean(detail.serviceName) ?? clean(summary.serviceName);
  const accepted = events.find((event) => event.type === 'INDUCTION' && event.code !== '3000')?.date ?? dateOnly(summary.mailedOnDate);

  return {
    pin, // Not read from the response: the examples send it as a number, which can lose digits.
    service,
    serviceCode: SERVICE_CODES.find(([pattern]) => pattern.test(service ?? ''))?.[1] ?? null,
    status: statusFor(summary, delivered, latest),
    delivered,
    expectedDelivery: actual ?? changed ?? standard,
    originalExpectedDelivery: !actual && changed && changed !== standard ? standard : null,
    expectedChangeReason: !actual && changed ? clean(detail.changedExpectedDeliveryReason) : null,
    originPostalId: clean(summary.originPostalId),
    acceptedDate: accepted,
    pickupOfficeId: delivered ? null : (events.filter((event) => event.retailLocationId).at(-1)?.retailLocationId ?? null),
    destination: parseDestination(detail, summary),
    events,
  };
}

/** Fetches the unparsed responses. A 15-digit number is a Delivery Notice Card. */
export async function fetchRawTracking(pin, options) {
  const kind = /^\d{15}$/.test(pin) ? 'dncs' : 'pins';
  const call = { ...options, product: 'Tracking', onClientError: trackingErrorFor };
  const detail = await callApi(`/tracking/v1/${kind}/${pin}/details`, call);
  const summary = await callApi(`/tracking/v1/${kind}/${pin}/summaries`, call);
  return { detail, summary };
}

export async function fetchFromApi(pin, options) {
  const { detail, summary } = await fetchRawTracking(pin, options);
  return parseTracking(detail, summary, pin);
}
