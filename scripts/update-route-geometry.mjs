// Rebuilds server/data/route-geometry.json: the road and ferry paths for every network link.
// Run with `npm run update:routes` after changing server/data/network.json.
import { readFileSync, writeFileSync } from 'node:fs';
import { simplify } from '../server/route/geometry.js';

const read = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
const network = read('../server/data/network.json');
const stored = read('../server/data/facilities.json');
const facilities = Array.isArray(stored) ? stored : stored.facilities;
const OUTPUT = new URL('../server/data/route-geometry.json', import.meta.url);

const ROUTER = 'https://router.project-osrm.org/route/v1/driving';
const USER_AGENT = 'parcel-route-tracker/1.0 (self-hosted personal parcel map)';
const GAP_MS = 1100;
const TOLERANCE = 0.0004; // Degrees, about 40 m.

// The fastest road between some cities cuts through the United States. These keep the line on
// the Canadian highways a parcel truck would use. Points are [lat, lon] on the highway.
const VIAS = {
  'tor|wpg': [[46.5136, -80.9471], [46.5439, -84.2866], [47.9896, -84.7736], [48.4254, -89.2622], [49.7766, -94.4894]],
  'mct|mtl': [[45.9756, -66.7199], [47.3506, -68.3028], [47.8284, -69.5166], [46.7294, -71.2412]],
  'mct|que': [[45.9756, -66.7199], [47.3506, -68.3028], [47.8284, -69.5166], [46.7415, -71.2885]], // Last point is the Pierre-Laporte Bridge.
  'edm|van': [[52.8816, -118.0814], [50.7038, -120.3581]],
};

const facility = new Map([...facilities, ...network.waypoints].map((node) => [node.id, node]));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const round = (value) => Math.round(value * 1e5) / 1e5;

async function request(points) {
  const path = points.map(([lat, lon]) => `${lon},${lat}`).join(';');
  const url = `${ROUTER}/${path}?overview=full&geometries=geojson&steps=true`;
  const response = await fetch(url, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(60_000) });
  const body = await response.json();
  if (body.code !== 'Ok') throw new Error(`${body.code}: ${body.message ?? response.status}`);
  return body.routes[0];
}

function finish(key, coordinates, from, to) {
  const pairs = coordinates.map(([lon, lat]) => [round(lat), round(lon)]);
  pairs[0] = from;
  pairs[pairs.length - 1] = to;
  return simplify(pairs, TOLERANCE);
}

const steps = (route) => route.legs.flatMap((leg) => leg.steps);

async function roadLeg(key, from, to) {
  const route = await request([from, ...(VIAS[key] ?? []), to]);
  const interstate = steps(route).find((step) => /\bI[ -]?\d/.test(step.ref ?? ''));
  if (interstate) throw new Error(`${key} uses US highway ${interstate.ref}; add a via point`);
  if (steps(route).some((step) => step.mode === 'ferry')) throw new Error(`${key} unexpectedly uses a ferry`);
  return { path: finish(key, route.geometry.coordinates, from, to), km: route.distance / 1000 };
}

async function ferryLeg(key, from, to) {
  const route = await request([from, to]);
  const crossing = steps(route).filter((step) => step.mode === 'ferry');
  if (crossing.length === 0) throw new Error(`${key} found no ferry crossing`);
  return { path: finish(key, crossing.flatMap((step) => step.geometry.coordinates), from, to), km: crossing.reduce((sum, step) => sum + step.distance, 0) / 1000 };
}

const jobs = [
  ...network.edges.map((edge) => ({ key: `${edge.a}|${edge.b}`, a: facility.get(edge.a), b: facility.get(edge.b), expected: edge.km, ferry: edge.mode === 'ferry' })),
  ...network.airHubs.map((id) => ({ key: `${id}|${network.airports[id].code}`, a: facility.get(id), b: network.airports[id] })),
];

const legs = {};
for (const job of jobs) {
  const from = [job.a.lat, job.a.lon];
  const to = [job.b.lat, job.b.lon];
  const { path, km } = await (job.ferry ? ferryLeg : roadLeg)(job.key, from, to);
  legs[job.key] = path;
  const off = job.expected ? `${Math.round((km / job.expected - 1) * 100)}%` : '';
  console.log(`${job.key.padEnd(12)} ${String(Math.round(km)).padStart(5)} km  network ${String(job.expected ?? '-').padStart(5)}  ${off.padStart(5)}  ${path.length} points`);
  await sleep(GAP_MS);
}

writeFileSync(OUTPUT, `${JSON.stringify({
  source: 'Routed by OSRM using OpenStreetMap data, © OpenStreetMap contributors, ODbL 1.0. Points are [lat, lon].',
  legs,
})}\n`);
console.log(`Saved ${jobs.length} paths, ${Object.values(legs).reduce((sum, path) => sum + path.length, 0)} points.`);
