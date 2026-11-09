import { describe, expect, it } from 'vitest';
import { FACILITIES, lookupFsa, matchFacilityByName, rangeIncludes, toFsa } from '../server/route/facilities.js';
import { parseFacilityTable, parseRanges } from '../scripts/parseFacilityTable.mjs';

const idFor = (code) => lookupFsa(code)?.facility.id;

describe('FSA → facility lookup', () => {
  it('has all 21 facilities, each with coordinates and FSAs', () => {
    expect(FACILITIES).toHaveLength(21);
    for (const facility of FACILITIES) {
      expect(Number.isFinite(facility.lat) && Number.isFinite(facility.lon)).toBe(true);
      expect(facility.fsa.major.length + facility.fsa.nonMajor.length).toBeGreaterThan(0);
    }
  });

  it.each([
    ['A1A', 'stj'],
    ['A0G 4M0', 'stj'], // Twillingate
    ['B3H', 'hfx'],
    ['C1A', 'cha'],
    ['E1A 5V8', 'mct'], // Dieppe
    ['E2L', 'sjb'],
    ['E3B', 'fre'],
    ['G1R', 'que'],
    ['H4T 1T4', 'mtl'],
    ['K1A', 'ott'],
    ['M5V', 'tor'],
    ['L8P', 'ham'],
    ['N2L', 'kit'],
    ['N6A', 'lon'],
    ['N9A', 'win'],
    ['R3C', 'wpg'],
    ['S4P', 'reg'],
    ['S7K', 'sas'],
    ['T2P', 'cal'], // Listed as the two-character prefix "T2"
    ['T5J', 'edm'], // "T5"
    ['V6B', 'van'],
    ['V8W', 'vic'],
  ])('maps %s to %s', (code, id) => {
    expect(idFor(code)).toBe(id);
  });

  it('follows the Labrador footnote, sending A0P, A0R and A2V to Québec', () => {
    expect(['A0P', 'A0R', 'A2V'].map(idFor)).toEqual(['que', 'que', 'que']);
  });

  it('reports the tier from the table', () => {
    expect(lookupFsa('A1A').tier).toBe('major');
    expect(lookupFsa('A0G').tier).toBe('nonMajor');
  });

  it('returns both facilities for the Toronto-or-Winnipeg FSAs', () => {
    for (const fsa of ['P0T', 'P0X', 'P7B', 'P8N', 'P9A']) {
      expect(lookupFsa(fsa).facilities.map((f) => f.id).sort()).toEqual(['tor', 'wpg']);
    }
  });

  it('has no other FSA claimed by two facilities', () => {
    const letters = 'ABCEGHJKLMNPRSTVWXYZ'.split('');
    const duplicates = [];
    for (const first of letters) {
      for (let digit = 0; digit <= 9; digit++) {
        for (const third of letters) {
          const fsa = `${first}${digit}${third}`;
          const found = lookupFsa(fsa);
          if (found?.facilities.length > 1) duplicates.push(fsa);
        }
      }
    }
    const allowed = /^(P0[T-X]|P[78][A-Z]|P9[A-N])$/;
    expect(duplicates.filter((fsa) => !allowed.test(fsa))).toEqual([]);
  });

  it('normalizes input and rejects what is not an FSA', () => {
    expect(toFsa('n9a 1a1')).toBe('N9A');
    expect(idFor('h4t-1t4')).toBe('mtl');
    expect(lookupFsa('12345')).toBeNull();
    expect(lookupFsa('')).toBeNull();
    expect(lookupFsa(null)).toBeNull();
  });

  it('returns null for an FSA missing from the table', () => {
    expect(lookupFsa('Z9Z')).toBeNull();
  });

  it('checks ranges and prefixes', () => {
    expect(rangeIncludes('A1A-A1H', 'A1C')).toBe(true);
    expect(rangeIncludes('A1A-A1H', 'A1J')).toBe(false);
    expect(rangeIncludes('T2', 'T2Z')).toBe(true);
    expect(rangeIncludes('T2', 'T3A')).toBe(false);
  });
});

describe('scan name → facility', () => {
  it('recognizes Dieppe as the Moncton facility', () => {
    expect(matchFacilityByName('Dieppe', 'NB').id).toBe('mct');
  });

  it('ignores accents and case', () => {
    expect(matchFacilityByName('MONTREAL', 'QC').id).toBe('mtl');
  });

  it('keeps same-named places in other provinces apart', () => {
    expect(matchFacilityByName('Windsor', 'NS')).toBeNull();
    expect(matchFacilityByName('Windsor', 'ON').id).toBe('win');
  });

  it('does not confuse Saint John with St. John\'s', () => {
    expect(matchFacilityByName('Saint John', 'NB').id).toBe('sjb');
    expect(matchFacilityByName("St. John's", 'NL').id).toBe('stj');
  });

  it('returns null for a town that has no facility', () => {
    expect(matchFacilityByName('Twillingate', 'NL')).toBeNull();
  });
});

describe('official table parser', () => {
  it('handles ranges, singles, two-character prefixes and footnote numbers', () => {
    expect(parseRanges('L1G to L1R 3 L3L T2 A0P 2')).toEqual(['L1G-L1R', 'L3L', 'T2', 'A0P']);
    expect(parseRanges('Not applicable')).toEqual([]);
  });

  it('reads table rows and skips the header', () => {
    const html = `<table><tr><th>Processing facility</th><th>Major</th><th>Non</th></tr>
      <tr><td>Windsor ON</td><td>N8N to N8Z<sup>1</sup></td><td>N0R</td></tr></table>`;
    expect(parseFacilityTable(html)).toEqual([{ name: 'Windsor ON', major: ['N8N-N8Z'], nonMajor: ['N0R'] }]);
  });
});
