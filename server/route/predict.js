import { readFileSync } from 'node:fs';
import { FACILITIES, toSite } from './facilities.js';
import { greatCirclePath, storedPath } from './geometry.js';

const NETWORK = JSON.parse(readFileSync(new URL('../data/network.json', import.meta.url), 'utf8'));

const ROAD_FACTOR = 1.25; // Roads are longer than the straight line to a nearby hub.
const ENTRY_NODES = 3; // A scan away from any facility may join at any of its nearest nodes.
const SAME_PLACE_KM = 10;
const AT_BUILDING_KM = 0.2;

export function distanceKm(a, b) {
  const rad = (deg) => (deg * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(h));
}

/** Keeps road links from crossing water: island scans only join nodes on that island. */
export function landmassOf({ lat, lon, region }) {
  if (region === 'NL') return lat > 51.6 ? 'mainland' : 'newfoundland';
  const westOfGeorgiaStrait = lon < -122.95 - (lat - 48.4) * 1.08;
  if (region === 'BC' && lat < 50.95 && westOfGeorgiaStrait) return 'vancouver-island';
  return 'mainland';
}

export function buildGraph(facilities = FACILITIES, network = NETWORK) {
  const nodes = new Map();
  for (const f of facilities) nodes.set(f.id, { ...f, isFacility: true });
  for (const w of network.waypoints) nodes.set(w.id, { ...w, isFacility: false });

  const adjacency = new Map([...nodes.keys()].map((id) => [id, []]));
  for (const edge of network.edges) {
    if (!nodes.has(edge.a) || !nodes.has(edge.b)) {
      throw new Error(`network.json references an unknown node: ${edge.a} or ${edge.b}`);
    }
    adjacency.get(edge.a).push({ to: edge.b, edge });
    adjacency.get(edge.b).push({ to: edge.a, edge });
  }
  return { nodes, adjacency };
}

function dijkstra(graph, sources) {
  const dist = new Map();
  const prev = new Map();
  const unvisited = new Set(graph.nodes.keys());
  for (const { id, km } of sources) dist.set(id, km);

  while (unvisited.size > 0) {
    let current = null;
    for (const id of unvisited) {
      if (dist.has(id) && (current === null || dist.get(id) < dist.get(current))) current = id;
    }
    if (current === null) break;
    unvisited.delete(current);
    for (const { to, edge } of graph.adjacency.get(current)) {
      const candidate = dist.get(current) + edge.km;
      if (!dist.has(to) || candidate < dist.get(to)) {
        dist.set(to, candidate);
        prev.set(to, { from: current, edge });
      }
    }
  }
  return { dist, prev };
}

function entryNodes(graph, point) {
  if (point.facilityId) return [{ id: point.facilityId, km: 0 }];
  const landmass = landmassOf(point);
  return [...graph.nodes.values()]
    .filter((node) => node.landmass === landmass)
    .map((node) => ({ id: node.id, km: distanceKm(point, node) * ROAD_FACTOR }))
    .sort((a, b) => a.km - b.km)
    .slice(0, ENTRY_NODES);
}

/** The facility nearest a town when no postal code is available. */
export function nearestFacility(point, facilities = FACILITIES) {
  const landmass = landmassOf(point);
  return facilities
    .filter((f) => f.landmass === landmass)
    .reduce(
      (best, f) => {
        const km = distanceKm(point, f);
        return km < best.km ? { facility: f, km } : best;
      },
      { facility: null, km: Infinity },
    ).facility;
}

const toPoint = (place) => ({ lat: place.lat, lon: place.lon });

/**
 * Estimates an air-assisted trip: by road to the nearest air hub, a flight to the hub
 * nearest the destination, then by road again. Returns null when one hub serves both ends.
 */
export function predictAirRoute({ from, destination, graph = buildGraph(), airHubs = NETWORK.airHubs }) {
  const outbound = dijkstra(graph, entryNodes(graph, from)).dist;
  const nearestHub = (dist) =>
    airHubs.filter((id) => dist.has(id)).sort((a, b) => dist.get(a) - dist.get(b))[0];

  const originHub = nearestHub(outbound);
  const targetId = destination.facilityIds.filter((id) => graph.nodes.has(id))[0];
  if (!originHub || !targetId) return null;
  const destHub = nearestHub(dijkstra(graph, [{ id: targetId, km: 0 }]).dist);
  if (!destHub || originHub === destHub) return null;

  const hubA = graph.nodes.get(originHub);
  const hubB = graph.nodes.get(destHub);
  const toHub = predictRoute({ from, destination: { ...toPoint(hubA), label: hubA.name, facilityIds: [originHub] }, graph });
  const fromHub = predictRoute({ from: { ...toPoint(hubB), region: hubB.province[0], label: hubB.name, facilityId: destHub }, destination, graph });

  const airportA = NETWORK.airports[originHub];
  const airportB = NETWORK.airports[destHub];
  const airKm = Math.round(distanceKm(airportA, airportB));
  const toAirport = { from: hubA.name, to: airportA.name, mode: 'road', coords: storedPath(originHub, airportA.code) ?? [toPoint(hubA), toPoint(airportA)] };
  const flight = {
    from: airportA.name,
    to: airportB.name,
    mode: 'air',
    label: `${airportA.code} → ${airportB.code} flight, ${hubA.name} to ${hubB.name}`,
    km: airKm,
    coords: greatCirclePath(toPoint(airportA), toPoint(airportB)),
  };
  const fromAirport = { from: airportB.name, to: hubB.name, mode: 'road', coords: storedPath(destHub, airportB.code) ?? [toPoint(airportB), toPoint(hubB)] };
  const hubStop = { id: hubB.id, name: hubB.name, lat: hubB.lat, lon: hubB.lon, type: 'facility', site: toSite(hubB) };
  const stops = [...(toHub?.stops ?? []), hubStop, ...(fromHub?.stops ?? [])];
  const townStop = fromHub ? fromHub.stopsRemaining - fromHub.stops.filter((stop) => stop.type === 'facility').length : 0;

  return {
    isEstimate: true,
    destinationFacilityId: targetId,
    distanceKm: (toHub?.distanceKm ?? 0) + airKm + (fromHub?.distanceKm ?? 0),
    segments: [...(toHub?.segments ?? []), toAirport, flight, fromAirport, ...(fromHub?.segments ?? [])],
    stops,
    stopsRemaining: stops.filter((stop) => stop.type === 'facility').length + townStop,
    usesFerry: Boolean(toHub?.usesFerry || fromHub?.usesFerry),
    usesAir: true,
  };
}

/**
 * Predicts the rest of a parcel's trip.
 *
 * @param from Last scan: { lat, lon, region, label, facilityId? }
 * @param destination { lat, lon, label, facilityIds: [ids of acceptable facilities] }
 * @returns An estimate with stops, drawable segments and a stop count, or null when
 *          no route can be worked out.
 */
export function predictRoute({ from, destination, graph = buildGraph() }) {
  const atDestination = distanceKm(from, destination) <= SAME_PLACE_KM;
  if (atDestination) return null;

  const { dist, prev } = dijkstra(graph, entryNodes(graph, from));
  const targetId = destination.facilityIds
    .filter((id) => dist.has(id))
    .sort((a, b) => dist.get(a) - dist.get(b))[0];
  if (!targetId) return null;

  const hops = [];
  let cursor = targetId;
  while (prev.has(cursor)) {
    hops.unshift({ id: cursor, edge: prev.get(cursor).edge });
    cursor = prev.get(cursor).from;
  }
  const entry = graph.nodes.get(cursor);

  const segments = [];
  const stops = [];
  const addStop = (node) =>
    stops.push({ id: node.id, name: node.name, lat: node.lat, lon: node.lon, type: node.isFacility ? 'facility' : 'waypoint', site: node.isFacility ? toSite(node) : null });

  if (!from.facilityId) {
    segments.push({ from: from.label, to: entry.name, mode: 'road', coords: [toPoint(from), toPoint(entry)] });
    addStop(entry);
  }

  let previous = entry;
  for (const hop of hops) {
    const node = graph.nodes.get(hop.id);
    segments.push({
      from: previous.name,
      to: node.name,
      mode: hop.edge.mode ?? 'road',
      label: hop.edge.label ?? null,
      km: hop.edge.km,
      coords: storedPath(previous.id, node.id) ?? [toPoint(previous), toPoint(node)],
    });
    addStop(node);
    previous = node;
  }

  // A short hop still reaches the destination's marker, but only a real one counts as a stop.
  const finalKm = distanceKm(previous, destination);
  const finalLeg = finalKm > SAME_PLACE_KM;
  if (finalKm > AT_BUILDING_KM) {
    segments.push({ from: previous.name, to: destination.label, mode: 'road', coords: [toPoint(previous), toPoint(destination)] });
  }

  const facilityStops = stops.filter((stop) => stop.type === 'facility').length;
  return {
    isEstimate: true,
    destinationFacilityId: targetId,
    distanceKm: Math.round(dist.get(targetId) + (finalLeg ? distanceKm(previous, destination) * ROAD_FACTOR : 0)),
    segments,
    stops,
    stopsRemaining: facilityStops + (finalLeg ? 1 : 0),
    usesFerry: segments.some((segment) => segment.mode === 'ferry'),
  };
}
