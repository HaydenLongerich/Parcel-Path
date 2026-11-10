const IMAGERY = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer';
const IMAGERY_EXPORT = `${IMAGERY}/export`;
export const SATELLITE_TILES = `${IMAGERY}/tile/{z}/{y}/{x}`;
const EARTH_RADIUS = 6378137;
const ASPECT = 16 / 9;

/** An overhead picture centred on a point. `radius` is the ground distance in metres from centre to top. */
export function aerialPhotoUrl({ lat, lon }, { radius = 190, width = 640 } = {}) {
  const x = (lon * Math.PI * EARTH_RADIUS) / 180;
  const y = Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360)) * EARTH_RADIUS;
  // Web Mercator stretches away from the equator, so the box widens to keep the same ground size.
  const halfHeight = radius / Math.cos((lat * Math.PI) / 180);
  const halfWidth = halfHeight * ASPECT;
  const bbox = [x - halfWidth, y - halfHeight, x + halfWidth, y + halfHeight].map((value) => value.toFixed(1)).join(',');
  return `${IMAGERY_EXPORT}?bbox=${bbox}&bboxSR=3857&imageSR=3857&size=${width},${Math.round(width / ASPECT)}&format=jpg&f=image`;
}

export const googleMapsUrl = ({ lat, lon }) => `https://www.google.com/maps/search/?api=1&query=${lat},${lon}`;
