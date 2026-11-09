// Prices and standard transit times from Canada Post's Rating API.
import { callApi } from './apiClient.js';
import { clean, dateOnly, TrackingError } from './common.js';

export function parseRates(quotes) {
  if (!Array.isArray(quotes)) throw new TrackingError('format_changed', 'The rating response has an unexpected format.');
  return quotes
    .map((quote) => ({
      code: clean(quote.serviceCode),
      name: clean(quote.serviceName),
      price: Number(quote.priceDetails?.due),
      transitDays: quote.serviceStandard?.expectedTransitTime ?? null,
      expectedDelivery: dateOnly(quote.serviceStandard?.expectedDeliveryDate),
      guaranteed: quote.serviceStandard?.guaranteedDelivery === true,
    }))
    .filter((quote) => quote.code && Number.isFinite(quote.price))
    .sort((a, b) => a.price - b.price);
}

const customerNumber = () => process.env.CANADA_POST_CUSTOMER_NUMBER?.trim() || null;

/** Without a customer number Canada Post quotes retail prices, which don't include Expedited Parcel. */
export const usesAccountRates = () => Boolean(customerNumber());

/** Prices for a domestic parcel. Postal codes must be six characters with no space. */
export async function getRates({ origin, destination, weightKg, services }, options) {
  const quotes = await callApi('/rating/v1/prices', {
    ...options,
    product: 'Rating',
    method: 'POST',
    body: {
      quoteType: usesAccountRates() ? 'commercial' : 'counter',
      ...(usesAccountRates() ? { customerNumber: customerNumber() } : {}),
      parcelCharacteristics: { weight: weightKg },
      originPostalCode: origin,
      destination: { domestic: { postalCode: destination } },
      ...(services ? { services } : {}),
    },
  });
  return parseRates(quotes);
}
