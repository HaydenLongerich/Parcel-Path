// Adds Post Office hours and an on-time check to a tracked parcel. These are extras:
// if either lookup fails, the parcel still shows.
import { fullPostalCode } from './common.js';
import { getPostOffice } from './postOffice.js';
import { getRates } from './rating.js';

const DAY_MS = 86_400_000;
const toDay = (iso) => Date.parse(`${iso.slice(0, 10)}T00:00:00Z`);
const isWeekend = (time) => [0, 6].includes(new Date(time).getUTCDay());

export function addBusinessDays(iso, count) {
  let time = toDay(iso);
  for (let remaining = count; remaining > 0;) {
    time += DAY_MS;
    if (!isWeekend(time)) remaining -= 1;
  }
  return new Date(time).toISOString().slice(0, 10);
}

/** Business days from `from` to `to`. Negative when `to` is earlier. */
export function businessDaysBetween(from, to) {
  const start = toDay(from);
  const end = toDay(to);
  const direction = end >= start ? 1 : -1;
  let count = 0;
  for (let time = start; time !== end;) {
    time += DAY_MS * direction;
    if (!isWeekend(time)) count += direction;
  }
  return count;
}

async function checkOnTime(record, options) {
  const origin = fullPostalCode(record.originPostalId);
  const destination = fullPostalCode(record.destination?.postalCode);
  if (!origin || !destination || !record.serviceCode || !record.acceptedDate || !record.expectedDelivery || record.delivered) return null;

  const [quote] = await getRates({ origin, destination, weightKg: 1, services: [record.serviceCode] }, options);
  if (!quote?.transitDays) return null;

  const standardDate = addBusinessDays(record.acceptedDate, quote.transitDays);
  return { standardDate, transitDays: quote.transitDays, daysBehind: businessDaysBetween(standardDate, record.expectedDelivery) };
}

export async function enrichRecord(record, options) {
  const [pickup, onTime] = await Promise.all([
    record.pickupOfficeId ? getPostOffice(record.pickupOfficeId, options).catch(() => null) : null,
    checkOnTime(record, options).catch(() => null),
  ]);
  return { ...record, pickup, onTime };
}
