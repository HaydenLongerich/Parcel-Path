export class TrackingError extends Error {
  constructor(code, message) {
    super(message);
    // invalid_number | not_found | bad_request | auth_failed | rate_limited | blocked | unavailable | format_changed
    this.code = code;
  }
}

export function sanitizePin(input) {
  return String(input ?? '').replace(/[\s-]/g, '').toUpperCase();
}

export function isValidPin(pin) {
  return /^\d{11,16}$/.test(pin) || /^[A-Z]{2}\d{9}[A-Z]{2}$/.test(pin);
}

/** Canada Post sends "SAINTE-FOY"; show "Sainte-Foy". Mixed-case text is left alone. */
export function titleCase(text) {
  if (!text || /[a-zà-ÿ]/.test(text)) return text;
  return text.toLowerCase().replace(/(^|[\s-])([a-zà-ÿ])/g, (_, gap, letter) => gap + letter.toUpperCase());
}

/** The spec's examples mix text, numbers and null, so normalize everything to text. */
export function clean(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim().replace(/\s+/g, ' ');
  return text || null;
}

/** Dates arrive as "2023-12-11" or "2023-12-11T00:00:00.000Z". */
export const dateOnly = (value) => clean(value)?.slice(0, 10) ?? null;

/** "n9a1a1" or "N9A" becomes "N9A1A1". An area-only code gets a placeholder ending, which Canada Post accepts. */
export function fullPostalCode(input) {
  const compact = String(input ?? '').replace(/\s/g, '').toUpperCase();
  if (/^[A-Z]\d[A-Z]\d[A-Z]\d$/.test(compact)) return compact;
  return /^[A-Z]\d[A-Z]$/.test(compact) ? `${compact}1A1` : null;
}
