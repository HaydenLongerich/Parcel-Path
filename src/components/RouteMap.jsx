import { useEffect, useRef } from 'react';
import L from 'leaflet';
import { fetchHubs } from '../api.js';
import { prefersReducedMotion } from '../motion.js';
import { BOAT_ICON_SVG, PLANE_ICON_SVG } from './Icons.jsx';

const CANADA_BOUNDS = [[42, -141], [70, -52]];
const SELECT_ZOOM = 9;
const DRAW_MS = 1800;

const WORLD_BOUNDS = [[-85.06, -180], [85.06, 180]];
const TILE_SIZE = 256;
const MAX_ZOOM = 18;

const ESRI_TILES = 'https://server.arcgisonline.com/ArcGIS/rest/services';
// Esri and OpenStreetMap both require this credit to stay visible on the map.
const CREDIT = 'Esri, Vantor, Earthstar Geographics, GIS User Community | &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>';

const PHOTO_RADIUS_METRES = 190;
const PHOTO_ASPECT = 16 / 9;
const EARTH_RADIUS = 6378137;
const POPUP_OPTIONS = { className: 'glass-popup', minWidth: 280, maxWidth: 280 };

/** An overhead picture centred on one building. */
function aerialPhotoUrl({ lat, lon }) {
  const x = (lon * Math.PI * EARTH_RADIUS) / 180;
  const y = Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360)) * EARTH_RADIUS;
  // Web Mercator stretches away from the equator, so the box widens to keep the same ground size.
  const halfHeight = PHOTO_RADIUS_METRES / Math.cos((lat * Math.PI) / 180);
  const halfWidth = halfHeight * PHOTO_ASPECT;
  const bbox = [x - halfWidth, y - halfHeight, x + halfWidth, y + halfHeight].map((value) => value.toFixed(1)).join(',');
  return `${ESRI_TILES}/World_Imagery/MapServer/export?bbox=${bbox}&bboxSR=3857&imageSR=3857&size=640,360&format=jpg&f=image`;
}

function sitePopup({ title, site, detail, lat, lon }) {
  const lines = [
    `<img class="site-photo" src="${aerialPhotoUrl({ lat, lon })}" alt="Satellite picture of ${escapeHtml(title)}" width="280" height="158" />`,
    `<strong>${escapeHtml(title)}</strong>`,
    site?.name && site.name !== title && `<span>${escapeHtml(site.name)}</span>`,
    site?.address && `<span>${escapeHtml(site.address)}</span>`,
    detail && `<em>${escapeHtml(detail)}</em>`,
    site?.note && `<em>${escapeHtml(site.note)}</em>`,
    '<small>Satellite picture: Esri</small>',
  ];
  return lines.filter(Boolean).join('');
}

function addSatelliteLayers(map) {
  const shared = { noWrap: true, bounds: WORLD_BOUNDS, maxZoom: MAX_ZOOM };
  L.tileLayer(`${ESRI_TILES}/World_Imagery/MapServer/tile/{z}/{y}/{x}`, { ...shared, attribution: CREDIT }).addTo(map);
  L.tileLayer(`${ESRI_TILES}/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}`, shared).addTo(map);
}

/** Stops zooming out once the single world would no longer fill the map. */
function limitZoomOut(map) {
  const { x, y } = map.getSize();
  if (x > 0 && y > 0) map.setMinZoom(Math.ceil(Math.log2(Math.max(x, y) / TILE_SIZE)));
}

// Bright enough to stand out against dark satellite imagery.
const COLORS = { route: '#FF3B30', selected: '#FF8A80', predicted: '#E3EEFF', surface: '#14181F' };

const escapeHtml = (text) =>
  String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const toLatLng = ({ lat, lon }) => [lat, lon];
const span = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const pathLength = (coords) => coords.slice(1).reduce((sum, point, i) => sum + span(coords[i], point), 0);

function truncatePath(coords, length) {
  const result = [coords[0]];
  let remaining = length;
  for (let i = 1; i < coords.length && remaining > 0; i++) {
    const piece = span(coords[i - 1], coords[i]);
    const fraction = Math.min(1, remaining / piece);
    result.push([
      coords[i - 1][0] + (coords[i][0] - coords[i - 1][0]) * fraction,
      coords[i - 1][1] + (coords[i][1] - coords[i - 1][1]) * fraction,
    ]);
    remaining -= piece;
  }
  return result;
}

/** Draws the lines end to end as one continuous stroke. Returns a cancel function. */
function drawProgressively(paths, onDone) {
  const lengths = paths.map((path) => pathLength(path.coords));
  const total = lengths.reduce((a, b) => a + b, 0);
  const start = performance.now();
  const complete = paths.map(() => false);
  let frame = 0;
  const step = (now) => {
    const t = Math.min(1, (now - start) / DRAW_MS);
    let remaining = t * t * (3 - 2 * t) * total;
    paths.forEach((path, i) => {
      const drawn = Math.max(0, Math.min(remaining, lengths[i]));
      remaining -= lengths[i];
      if (complete[i]) return;
      // Roads have thousands of points, so a finished line isn't redrawn every frame.
      complete[i] = drawn >= lengths[i];
      path.line.setLatLngs(complete[i] ? path.coords : truncatePath(path.coords, drawn));
    });
    if (t < 1) frame = requestAnimationFrame(step);
    else onDone();
  };
  frame = requestAnimationFrame(step);
  return () => cancelAnimationFrame(frame);
}

function placeMarker(place, selected) {
  if (place.isCurrent) {
    return L.marker(toLatLng(place), {
      icon: L.divIcon({
        className: '',
        html: `<span class="current-marker ${selected ? 'is-selected' : ''}"><i></i></span>`,
        iconSize: [36, 36],
        iconAnchor: [18, 18],
      }),
      zIndexOffset: 1000,
      keyboard: true,
      title: place.label,
      alt: `${place.label}, current location`,
    });
  }
  return L.circleMarker(toLatLng(place), {
    radius: selected ? 8 : 5.5,
    color: COLORS.surface,
    weight: 2,
    fillColor: selected ? COLORS.selected : COLORS.route,
    fillOpacity: 1,
  });
}

function popupHtml(place) {
  const count = place.eventIds.length;
  const scans = `${place.isCurrent ? 'Current location · ' : ''}${count} scan${count === 1 ? '' : 's'}`;
  return sitePopup({ title: place.label, site: place.site, detail: place.note ?? scans, lat: place.lat, lon: place.lon });
}

export default function RouteMap({ view, selection, onSelectPlace }) {
  const containerRef = useRef(null);
  const mapRef = useRef(null);
  const routeLayerRef = useRef(null);
  const markerLayerRef = useRef(null);
  const drawnViewRef = useRef(null);
  const onSelectRef = useRef(onSelectPlace);
  onSelectRef.current = onSelectPlace;

  useEffect(() => {
    const map = L.map(containerRef.current, { scrollWheelZoom: false, maxBounds: WORLD_BOUNDS, maxBoundsViscosity: 1 });
    map.attributionControl.setPrefix(false);
    limitZoomOut(map);
    map.fitBounds(CANADA_BOUNDS, { animate: false });
    addSatelliteLayers(map);
    map.on('focus', () => map.scrollWheelZoom.enable());
    map.on('blur', () => map.scrollWheelZoom.disable());
    mapRef.current = map;
    // Below the route lines, so a hub never covers a scan.
    map.createPane('hubs').style.zIndex = 350;
    fetchHubs()
      .then((hubs) => {
        if (mapRef.current !== map) return;
        for (const hub of hubs) {
          L.marker(toLatLng(hub), {
            pane: 'hubs',
            alt: `${hub.name}, Canada Post hub`,
            title: hub.name,
            icon: L.divIcon({ className: '', html: '<span class="hub-marker"></span>', iconSize: [18, 18], iconAnchor: [9, 9] }),
          })
            .bindPopup(sitePopup({ title: hub.name, site: { address: hub.address, note: hub.note }, detail: 'Canada Post hub', lat: hub.lat, lon: hub.lon }), POPUP_OPTIONS)
            .addTo(map);
        }
      })
      .catch(() => {}); // The tracker still works without the hub markers.
    routeLayerRef.current = L.layerGroup().addTo(map);
    markerLayerRef.current = L.layerGroup().addTo(map);
    const observer = new ResizeObserver(() => {
      map.invalidateSize();
      limitZoomOut(map);
    });
    observer.observe(containerRef.current);
    return () => {
      observer.disconnect();
      map.remove();
      mapRef.current = null;
    };
  }, []);

  // Route lines. Only a newly loaded parcel animates.
  useEffect(() => {
    const layer = routeLayerRef.current;
    layer.clearLayers();
    const paths = [];

    const travelled = view.travelledPath ?? view.travelled;
    if (travelled.length > 1) {
      const coords = travelled.map(toLatLng);
      paths.push({ coords, line: L.polyline(coords, { color: COLORS.route, weight: 3.5, lineJoin: 'round', lineCap: 'round' }).addTo(layer) });
    }

    for (const segment of view.predicted?.segments ?? []) {
      const coords = segment.coords.map(toLatLng);
      const ferry = segment.mode === 'ferry';
      const air = segment.mode === 'air';
      const line = L.polyline(coords, {
        color: COLORS.predicted,
        weight: ferry ? 3 : 2.5,
        dashArray: ferry ? '0.5 8' : air ? '16 9' : '8 8',
        lineCap: ferry ? 'round' : 'butt',
      }).addTo(layer);
      line.bindTooltip(`Predicted: ${escapeHtml(segment.label ?? `${segment.from} → ${segment.to}`)}${segment.noRoadData ? ' (direct line, road path unavailable)' : ''}`, { sticky: true, className: 'glass-tooltip' });
      paths.push({ coords, line });

      if (ferry || air) {
        const middle = truncatePath(coords, pathLength(coords) / 2).at(-1);
        L.marker(middle, {
          interactive: false,
          keyboard: false,
          icon: L.divIcon({ className: '', html: `<span class="ferry-badge">${air ? PLANE_ICON_SVG : BOAT_ICON_SVG}</span>`, iconSize: [26, 26], iconAnchor: [13, 13] }),
        }).addTo(layer);
      }
    }

    if (drawnViewRef.current === view || document.hidden || prefersReducedMotion() || paths.length === 0) {
      drawnViewRef.current = view;
      return undefined;
    }
    drawnViewRef.current = view;
    let finished = false;
    const cancel = drawProgressively(paths, () => {
      finished = true;
    });
    return () => {
      cancel();
      if (!finished) drawnViewRef.current = null;
    };
  }, [view]);

  // Markers restyle on selection without restarting the line animation.
  useEffect(() => {
    const layer = markerLayerRef.current;
    layer.clearLayers();

    for (const stop of view.predicted?.stops ?? []) {
      L.circleMarker(toLatLng(stop), {
        radius: stop.type === 'facility' ? 9 : 4,
        color: COLORS.predicted,
        weight: 2,
        fillColor: COLORS.surface,
        fillOpacity: stop.type === 'facility' ? 0 : 1, // Lets the hub marker show through the ring.
      })
        .bindTooltip(`${escapeHtml(stop.name)} (${stop.type === 'facility' ? 'predicted stop' : 'ferry terminal'})`, { className: 'glass-tooltip' })
        .bindPopup(sitePopup({ title: stop.site?.name ?? stop.name, site: stop.site, detail: stop.type === 'facility' ? 'Predicted stop' : 'Ferry terminal', lat: stop.lat, lon: stop.lon }), POPUP_OPTIONS)
        .addTo(layer);
    }

    if (view.destinationPoint && view.predicted) {
      L.circleMarker(toLatLng(view.destinationPoint), { radius: 8, color: COLORS.predicted, weight: 2.5, fillColor: COLORS.surface, fillOpacity: 1 })
        .bindTooltip(`Destination: ${escapeHtml(view.destinationPoint.label)}`, { className: 'glass-tooltip' })
        .bindPopup(sitePopup({ title: view.destinationPoint.label, site: view.destinationPoint.site, detail: 'Destination', lat: view.destinationPoint.lat, lon: view.destinationPoint.lon }), POPUP_OPTIONS)
        .addTo(layer);
    }

    for (const place of view.places) {
      const selected = selection?.placeId === place.id;
      const marker = placeMarker(place, selected).bindPopup(popupHtml(place), POPUP_OPTIONS).addTo(layer);
      marker.on('click', () => onSelectRef.current(place.id));
      if (selected) marker.openPopup();
    }
  }, [view, selection]);

  // Fit the whole trip when a new parcel loads.
  useEffect(() => {
    const points = [
      ...view.places.map(toLatLng),
      ...(view.predicted?.stops ?? []).map(toLatLng),
      ...(view.travelledPath ?? []).map(toLatLng),
      ...(view.predicted?.segments ?? []).flatMap((segment) => segment.coords.map(toLatLng)),
      ...(view.destinationPoint ? [toLatLng(view.destinationPoint)] : []),
    ];
    const padding = containerRef.current.clientWidth < 480 ? 22 : 48;
    if (points.length > 0) mapRef.current.fitBounds(points, { padding: [padding, padding], maxZoom: 10, animate: false });
  }, [view]);

  // Timeline clicks zoom to the matching place.
  useEffect(() => {
    if (selection?.source !== 'timeline') return;
    const place = view.places.find((p) => p.id === selection.placeId);
    if (!place) return;
    const map = mapRef.current;
    const zoom = Math.max(SELECT_ZOOM, map.getZoom());
    if (prefersReducedMotion()) map.setView(toLatLng(place), zoom, { animate: false });
    else map.flyTo(toLatLng(place), zoom, { duration: 0.9 });
  }, [selection, view]);

  return <div ref={containerRef} className="map" role="application" aria-label="Map of the parcel's route" />;
}
