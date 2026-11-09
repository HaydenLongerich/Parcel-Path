// Limits how often Canada Post is contacted. A parcel is fetched at most once per
// interval; anything in between is served from memory, and failures are remembered too.
const MAX_ENTRIES = 200;

export function createTrackingCache({
  fetcher,
  minIntervalMs = 15 * 60_000,
  errorIntervalMs = 5 * 60_000,
  now = Date.now,
}) {
  const entries = new Map();
  const inFlight = new Map();

  function store(pin, entry) {
    entries.delete(pin);
    entries.set(pin, entry);
    if (entries.size > MAX_ENTRIES) entries.delete(entries.keys().next().value);
    return entry;
  }

  return async function getTracking(pin) {
    const entry = entries.get(pin);
    if (entry && now() < entry.nextFetchAt) {
      if (entry.error) throw entry.error;
      return entry;
    }
    if (inFlight.has(pin)) return inFlight.get(pin);

    const request = (async () => {
      try {
        const record = await fetcher(pin);
        const fetchedAt = now();
        return store(pin, { record, fetchedAt, nextFetchAt: fetchedAt + minIntervalMs });
      } catch (error) {
        store(pin, { error, nextFetchAt: now() + errorIntervalMs });
        throw error;
      } finally {
        inFlight.delete(pin);
      }
    })();
    inFlight.set(pin, request);
    return request;
  };
}
