import { readFileSync } from 'node:fs';

const loadJson = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));

export const FACILITIES = loadJson('../data/facilities.json').facilities;

const normalize = (text) =>
  (text ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/gi, ' ')
    .trim()
    .toLowerCase();

export function toFsa(postalCode) {
  const compact = (postalCode ?? '').replace(/[^a-z0-9]/gi, '').toUpperCase();
  return /^[A-Z]\d[A-Z]/.test(compact) ? compact.slice(0, 3) : null;
}

const PROVINCE_BY_LETTER = {
  A: 'NL', B: 'NS', C: 'PE', E: 'NB', G: 'QC', H: 'QC', J: 'QC', K: 'ON', L: 'ON', M: 'ON', N: 'ON', P: 'ON', R: 'MB', S: 'SK', T: 'AB', V: 'BC',
};

export const provinceFromFsa = (postalCode) => PROVINCE_BY_LETTER[String(postalCode ?? '').charAt(0).toUpperCase()] ?? null;

export function rangeIncludes(range, fsa) {
  if (range.includes('-')) {
    const [start, end] = range.split('-');
    return fsa >= start && fsa <= end;
  }
  return fsa.startsWith(range);
}

/**
 * Finds the processing facilities for a postal code or FSA. Most FSAs have one; the
 * official table lets P0T–P0X and P7A–P9N use either Toronto or Winnipeg, so callers
 * get every match in `facilities` and the first in `facility`.
 */
export function lookupFsa(postalCode, facilities = FACILITIES) {
  const fsa = toFsa(postalCode);
  if (!fsa) return null;
  const matches = [];
  for (const facility of facilities) {
    for (const tier of ['major', 'nonMajor']) {
      if (facility.fsa[tier].some((range) => rangeIncludes(range, fsa))) {
        matches.push({ facility, tier });
        break;
      }
    }
  }
  if (matches.length === 0) return null;
  return {
    fsa,
    facility: matches[0].facility,
    tier: matches[0].tier,
    facilities: matches.map((m) => m.facility),
  };
}

/** Matches a scan's city and province to a facility, e.g. "Dieppe, NB" → Moncton. */
export function matchFacilityByName(city, region, facilities = FACILITIES) {
  const wanted = normalize(city);
  if (!wanted) return null;
  const province = (region ?? '').toUpperCase();
  return (
    facilities.find(
      (f) =>
        (!province || f.province.includes(province)) &&
        f.scanNames.some((name) => normalize(name) === wanted),
    ) ?? null
  );
}
