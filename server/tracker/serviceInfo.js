// Scheduled outage notices from Canada Post's Service Information API.
import { callApi } from './apiClient.js';
import { clean } from './common.js';

/** Keeps notices for outages that haven't finished. */
export function parseOutages(messages, now = Date.now()) {
  if (!Array.isArray(messages)) return [];
  return messages
    .map((message) => ({ text: clean(message.messageText), from: clean(message.fromDatetime), to: clean(message.toDatetime) }))
    .filter((outage) => outage.text && (!outage.to || Date.parse(outage.to) > now));
}

export async function getOutages(options) {
  return parseOutages(await callApi('/serviceinfo/v1/shipments-service?message-type=SO', { ...options, product: 'Service Information' }));
}
