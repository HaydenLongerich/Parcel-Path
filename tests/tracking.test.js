import { describe, expect, it, vi } from 'vitest';
import { checkSummary, parseDetail } from '../server/tracker/publicPage.js';
import { isValidPin, sanitizePin, TrackingError } from '../server/tracker/common.js';
import { createTrackingCache } from '../server/trackingCache.js';

describe('tracking number validation', () => {
  it('accepts domestic and international formats', () => {
    expect(isValidPin('1371134583769923')).toBe(true);
    expect(isValidPin('RN123456789CA')).toBe(true);
    expect(isValidPin(sanitizePin(' 1371 1345-8376 9923 '))).toBe(true);
  });

  it('rejects anything else', () => {
    for (const bad of ['', '123', 'abc', '12345678901234567', '../../etc/passwd']) {
      expect(isValidPin(sanitizePin(bad))).toBe(false);
    }
  });
});

describe('response parsing', () => {
  // Field names come from the tracking page's own code.
  const sample = {
    pin: '1371134583769923',
    productNmEn: 'Expedited Parcel',
    status: 'InTransit',
    expectedDlvryDateTime: { dlvryDate: '2026-11-12', revisedDate: '' },
    events: [
      { cd: '100', descEn: 'Item processed', datetime: { date: '2026-11-09', time: '14:05:00' }, locationAddr: { city: ' MONTREAL ', regionCd: 'qc', countryCd: 'CA' } },
      { cd: '90', descEn: 'Notice', datetime: { date: '2026-11-03', time: '' }, locationAddr: { city: '', regionCd: '' } },
    ],
  };

  it('produces clean, oldest-first events', () => {
    const parsed = parseDetail(sample, 'x');
    expect(parsed.service).toBe('Expedited Parcel');
    expect(parsed.expectedDelivery).toBe('2026-11-12');
    expect(parsed.events[0]).toMatchObject({ date: '2026-11-03', city: null });
    expect(parsed.events[1]).toMatchObject({ city: 'MONTREAL', region: 'QC', time: '14:05' });
    expect(parsed.delivered).toBe(false);
  });

  it('prefers a revised delivery date', () => {
    const revised = { ...sample, expectedDlvryDateTime: { dlvryDate: '2026-11-12', revisedDate: '2026-11-14' } };
    expect(parseDetail(revised, 'x').expectedDelivery).toBe('2026-11-14');
  });

  it('flags delivered items', () => {
    const parsed = parseDetail({ ...sample, status: 'Delivered' }, 'x');
    expect(parsed.delivered).toBe(true);
    expect(parsed.status).toBe('Delivered');
  });

  it('reports a format change for an unrecognizable response', () => {
    for (const bad of [null, {}, { events: 'nope' }, { events: [{ descEn: 'no date' }] }]) {
      expect(() => parseDetail(bad, 'x')).toThrowError(expect.objectContaining({ code: 'format_changed' }));
    }
  });

  it('turns the "No PIN History" answer into not_found', () => {
    const summary = [{ pin: 'x', error: { cd: '004', descEn: 'No PIN History' } }];
    expect(() => checkSummary(summary)).toThrowError(expect.objectContaining({ code: 'not_found' }));
  });

  it('accepts a normal summary and rejects a strange one', () => {
    expect(() => checkSummary([{ pin: 'x', status: 'InTransit' }])).not.toThrow();
    expect(() => checkSummary({})).toThrowError(expect.objectContaining({ code: 'format_changed' }));
  });
});

describe('tracking cache', () => {
  const setup = () => {
    let time = 0;
    const fetcher = vi.fn(async () => ({ pin: 'a' }));
    const get = createTrackingCache({ fetcher, minIntervalMs: 1000, errorIntervalMs: 100, now: () => time });
    return { fetcher, get, advance: (ms) => (time += ms) };
  };

  it('fetches once within the interval, then again after it', async () => {
    const { fetcher, get, advance } = setup();
    await get('a');
    advance(999);
    await get('a');
    expect(fetcher).toHaveBeenCalledTimes(1);
    advance(1);
    await get('a');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('shares one fetch between simultaneous requests', async () => {
    const { fetcher, get } = setup();
    await Promise.all([get('a'), get('a'), get('a')]);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('remembers failures so errors do not cause rapid retries', async () => {
    let time = 0;
    const fetcher = vi.fn(async () => {
      throw new TrackingError('blocked', 'no');
    });
    const get = createTrackingCache({ fetcher, errorIntervalMs: 100, now: () => time });
    await expect(get('a')).rejects.toThrow('no');
    await expect(get('a')).rejects.toThrow('no');
    expect(fetcher).toHaveBeenCalledTimes(1);
    time = 100;
    await expect(get('a')).rejects.toThrow('no');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
