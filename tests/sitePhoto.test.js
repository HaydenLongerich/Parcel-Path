import { describe, expect, it } from 'vitest';
import { aerialPhotoUrl, googleMapsUrl } from '../src/sitePhoto.js';

describe('site pictures', () => {
  const point = { lat: 45.48731, lon: -73.70058 };
  const box = (url) => new URL(url).searchParams.get('bbox').split(',').map(Number);

  it('centres the picture on the point', () => {
    const [west, south, east, north] = box(aerialPhotoUrl(point));
    const lon = (((west + east) / 2) * 180) / (Math.PI * 6378137);
    const lat = (2 * Math.atan(Math.exp((south + north) / 2 / 6378137)) - Math.PI / 2) * (180 / Math.PI);
    expect(lon).toBeCloseTo(point.lon, 4);
    expect(lat).toBeCloseTo(point.lat, 4);
  });

  it('covers the requested ground size at any latitude', () => {
    const [, south, , north] = box(aerialPhotoUrl(point, { radius: 300 }));
    expect(((north - south) / 2) * Math.cos((point.lat * Math.PI) / 180)).toBeCloseTo(300, 0);
  });

  it('keeps the picture and the box the same shape', () => {
    const url = aerialPhotoUrl(point, { width: 3200 });
    expect(new URL(url).searchParams.get('size')).toBe('3200,1800');
    const [west, south, east, north] = box(url);
    expect((east - west) / (north - south)).toBeCloseTo(16 / 9, 3);
  });

  it('links to the exact point on Google Maps', () => {
    expect(googleMapsUrl(point)).toBe('https://www.google.com/maps/search/?api=1&query=45.48731,-73.70058');
  });
});
