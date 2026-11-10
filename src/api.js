export class ApiError extends Error {
  constructor(code, message, fallback) {
    super(message);
    this.code = code;
    this.fallback = fallback ?? null;
  }
}

const OFFLINE_MESSAGE = 'Could not reach the local server. Make sure it is running with "npm run dev".';

async function request(path, init) {
  let response;
  try {
    response = await fetch(path, init);
  } catch {
    throw new ApiError('offline', OFFLINE_MESSAGE);
  }
  const body = await response.json().catch(() => null);
  if (!body) throw new ApiError('offline', OFFLINE_MESSAGE);
  if (!response.ok) throw new ApiError(body.error?.code ?? 'internal', body.error?.message ?? 'The request failed.', body.fallback);
  return body;
}

const postJson = (path, data) =>
  request(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });

export const fetchDemo = () => request('/api/demo');

let hubsRequest = null;
export function fetchHubs() {
  hubsRequest ??= request('/api/hubs').catch((failure) => {
    hubsRequest = null;
    throw failure;
  });
  return hubsRequest;
}

export const fetchNotices = () => request('/api/notices');
export const fetchBenchInfo = () => request('/api/test-bench/info');
export const fetchRandomNumbers = () => request('/api/test-bench/random');
export const runBench = (numbers, source) => postJson('/api/test-bench/run', { numbers, source });
export const fetchEstimate = (input) => postJson('/api/estimate', input);

export function fetchTracking(pin, destination, source) {
  const query = new URLSearchParams();
  if (destination) query.set('dest', destination);
  if (source) query.set('source', source);
  const suffix = query.size ? `?${query}` : '';
  return request(`/api/track/${encodeURIComponent(pin)}${suffix}`);
}
