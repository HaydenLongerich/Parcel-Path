import { useEffect, useRef } from 'react';
import L from 'leaflet';
import 'maplibre-gl/dist/maplibre-gl.css';
import '@maplibre/maplibre-gl-leaflet';
import { prefersReducedMotion } from '../useTheme.js';
import { BOAT_ICON_SVG, PLANE_ICON_SVG } from './Icons.jsx';

const CANADA_BOUNDS = [[42, -141], [70, -52]];
const SELECT_ZOOM = 9;
const DRAW_MS = 1800;

const CARTO_KEY = import.meta.env.VITE_CARTO_KEY;
const OSM_CREDIT = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';
const ROUTING_CREDIT = 'Routes: <a href="https://project-osrm.org">OSRM</a>';
const OPENFREEMAP_CREDIT = `<a href="https://openfreemap.org">OpenFreeMap</a> &copy; <a href="https://www.openmaptiles.org/">OpenMapTiles</a> ${OSM_CREDIT}`;

const supportsWebGl = () => Boolean(document.createElement('canvas').getContext('webgl2'));

/**
 * OpenFreeMap's minimal vector style needs no key. Raster OpenStreetMap tiles draw
 * forest cover as blocky patches across northern Canada, so they are only a last resort.
 */
function createBasemap(theme) {
  if (CARTO_KEY) {
    const style = theme === 'dark' ? 'dark_all' : 'light_all';
    return L.tileLayer(`https://basemaps.cartocdn.com/rastertiles/${style}/{z}/{x}/{y}{r}.png?key=${encodeURIComponent(CARTO_KEY)}`, {
      maxZoom: 19,
      attribution: `${OSM_CREDIT} &copy; <a href="https://carto.com/attributions">CARTO</a>`,
    });
  }
  if (supportsWebGl()) {
    return L.maplibreGL({
      style: `https://tiles.openfreemap.org/styles/${theme === 'dark' ? 'dark' : 'positron'}`,
      attribution: `${OPENFREEMAP_CREDIT} | ${ROUTING_CREDIT}`,
    });
  }
  return L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: OSM_CREDIT, className: 'tiles-restyled' });
}

const COLORS = {
  light: { route: '#D52B1E', selected: '#A31E14', predicted: '#1F3A5F', surface: '#FFFFFF' },
  dark: { route: '#D52B1E', selected: '#FF6A5E', predicted: '#9DBCE3', surface: '#1C1F24' },
};

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

function placeMarker(place, selected, colors) {
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
    color: colors.surface,
    weight: 2,
    fillColor: selected ? colors.selected : colors.route,
    fillOpacity: 1,
  });
}

function popupHtml(place) {
  if (place.note) return `<strong>${escapeHtml(place.label)}</strong><em>${escapeHtml(place.note)}</em>`;
  const count = place.eventIds.length;
  const facility = place.facilityName ? `<span>${escapeHtml(place.facilityName)} facility</span>` : '';
  return `<strong>${escapeHtml(place.label)}</strong>${facility}<em>${place.isCurrent ? 'Current location · ' : ''}${count} scan${count === 1 ? '' : 's'}</em>`;
}

export default function RouteMap({ view, selection, theme, onSelectPlace }) {
  const containerRef = useRef(null);
  const mapRef = useRef(null);
  const tilesRef = useRef(null);
  const routeLayerRef = useRef(null);
  const markerLayerRef = useRef(null);
  const drawnViewRef = useRef(null);
  const onSelectRef = useRef(onSelectPlace);
  onSelectRef.current = onSelectPlace;

  useEffect(() => {
    const map = L.map(containerRef.current, { scrollWheelZoom: false }).fitBounds(CANADA_BOUNDS, { animate: false });
    map.on('focus', () => map.scrollWheelZoom.enable());
    map.on('blur', () => map.scrollWheelZoom.disable());
    mapRef.current = map;
    routeLayerRef.current = L.layerGroup().addTo(map);
    markerLayerRef.current = L.layerGroup().addTo(map);
    const observer = new ResizeObserver(() => map.invalidateSize());
    observer.observe(containerRef.current);
    return () => {
      observer.disconnect();
      map.remove();
      mapRef.current = null;
    };
  }, []);

  useEffect(() => {
    tilesRef.current?.remove();
    tilesRef.current = createBasemap(theme).addTo(mapRef.current);
  }, [theme]);

  // Route lines. Only a newly loaded parcel animates, not a theme change.
  useEffect(() => {
    const layer = routeLayerRef.current;
    const colors = COLORS[theme];
    layer.clearLayers();
    const paths = [];

    const travelled = view.travelledPath ?? view.travelled;
    if (travelled.length > 1) {
      const coords = travelled.map(toLatLng);
      paths.push({ coords, line: L.polyline(coords, { color: colors.route, weight: 3.5, lineJoin: 'round', lineCap: 'round' }).addTo(layer) });
    }

    for (const segment of view.predicted?.segments ?? []) {
      const coords = segment.coords.map(toLatLng);
      const ferry = segment.mode === 'ferry';
      const air = segment.mode === 'air';
      const line = L.polyline(coords, {
        color: colors.predicted,
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
  }, [view, theme]);

  // Markers restyle on selection without restarting the line animation.
  useEffect(() => {
    const layer = markerLayerRef.current;
    const colors = COLORS[theme];
    layer.clearLayers();

    for (const stop of view.predicted?.stops ?? []) {
      L.circleMarker(toLatLng(stop), {
        radius: stop.type === 'facility' ? 5 : 3,
        color: colors.predicted,
        weight: 2,
        fillColor: colors.surface,
        fillOpacity: 1,
      })
        .bindTooltip(`${escapeHtml(stop.name)} (${stop.type === 'facility' ? 'predicted stop' : 'ferry terminal'})`, { className: 'glass-tooltip' })
        .addTo(layer);
    }

    if (view.destinationPoint && view.predicted) {
      L.circleMarker(toLatLng(view.destinationPoint), { radius: 8, color: colors.predicted, weight: 2.5, fillColor: colors.surface, fillOpacity: 1 })
        .bindTooltip(`Destination: ${escapeHtml(view.destinationPoint.label)}`, { className: 'glass-tooltip' })
        .addTo(layer);
    }

    for (const place of view.places) {
      const selected = selection?.placeId === place.id;
      const marker = placeMarker(place, selected, colors).bindPopup(popupHtml(place), { className: 'glass-popup' }).addTo(layer);
      marker.on('click', () => onSelectRef.current(place.id));
      if (selected) marker.openPopup();
    }
  }, [view, selection, theme]);

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
