import { useMemo, useState } from 'react';
import { ApiError, fetchEstimate } from '../api.js';
import { formatLongDay, formatMoney } from '../format.js';
import Reveal from './Reveal.jsx';
import RouteMap from './RouteMap.jsx';

const ROUTE_LABEL = { ground: 'By road', air: 'Air-assisted' };

function routeSummary(route) {
  const names = route.stops.filter((stop) => stop.type === 'facility').map((stop) => stop.name.replace(/ \(.*\)$/, ''));
  return names.join(' → ');
}

export default function Estimator() {
  const [form, setForm] = useState({ from: '', to: '', weightKg: '1' });
  const [result, setResult] = useState(null);
  const [selectedCode, setSelectedCode] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const update = (field) => (event) => setForm((current) => ({ ...current, [field]: event.target.value }));

  const submit = async (event) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const estimate = await fetchEstimate({ ...form, weightKg: Number(form.weightKg) });
      setResult(estimate);
      setSelectedCode(estimate.services[0]?.code ?? null);
    } catch (failure) {
      setResult(null);
      setError(failure instanceof ApiError ? failure.message : 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  };

  const selected = result?.services.find((service) => service.code === selectedCode) ?? null;
  const route = selected ? (result.routes[selected.routeKind] ?? result.routes.ground) : null;

  const mapView = useMemo(() => {
    if (!result) return null;
    return {
      places: [{ id: 'origin', label: result.from.label, lat: result.from.lat, lon: result.from.lon, eventIds: [], note: 'Starting point' }],
      travelled: [],
      predicted: route,
      destinationPoint: { lat: result.to.lat, lon: result.to.lon, label: result.to.label },
    };
  }, [result, route]);

  return (
    <section className="section" id="estimate" aria-labelledby="estimate-title">
      <Reveal as="h2" id="estimate-title" className="section-title">What will it cost to send?</Reveal>
      <Reveal className="stage estimate-stage">
        <form className="estimate-form glass" onSubmit={submit}>
          <label>
            <span>From</span>
            <input value={form.from} onChange={update('from')} placeholder="Postal code or town, NL" autoComplete="off" required />
          </label>
          <label>
            <span>To</span>
            <input value={form.to} onChange={update('to')} placeholder="Postal code or town, ON" autoComplete="off" required />
          </label>
          <label className="estimate-weight">
            <span>Weight (kg)</span>
            <input type="number" min="0.001" max="30" step="any" inputMode="decimal" value={form.weightKg} onChange={update('weightKg')} required />
          </label>
          <button type="submit" className="button-primary estimate-submit" disabled={busy}>
            {busy ? <span className="spinner" role="status" aria-label="Estimating" /> : 'Estimate'}
          </button>
        </form>

        {error && <div className="note glass note-warn" role="alert">{error}</div>}

        {result && result.services.length === 0 && (
          <div className="note glass" role="status">Canada Post didn't return any services for this trip.</div>
        )}

        {result && result.services.length > 0 && (
          <div className="estimate-results">
            <ul className="service-list">
              {result.services.map((service) => (
                <li key={service.code}>
                  <button
                    type="button"
                    className={`service glass ${service.code === selectedCode ? 'is-selected' : ''}`}
                    aria-pressed={service.code === selectedCode}
                    onClick={() => setSelectedCode(service.code)}
                  >
                    <span className="service-head">
                      <strong>{service.name}</strong>
                      <span className="service-price">{formatMoney(service.price)}</span>
                    </span>
                    <span className="service-meta">
                      {service.transitDays ? `${service.transitDays} business day${service.transitDays === 1 ? '' : 's'}` : 'Timing not given'}
                      {service.guaranteed && ' · Guaranteed'}
                    </span>
                    {service.expectedDelivery && <span className="service-meta">Arrives by {formatLongDay(service.expectedDelivery)} if sent today</span>}
                    <span className="pill pill-quiet pill-route">{ROUTE_LABEL[service.routeKind]}</span>
                  </button>
                </li>
              ))}
            </ul>
            <div className="map-panel glass">
              <RouteMap view={mapView} selection={null} onSelectPlace={() => {}} />
              <div className="map-foot">
                <ul className="key" aria-label="Map key">
                  <li><span className="swatch swatch-dashed" />Road</li>
                  {route?.usesAir && <li><span className="swatch swatch-air" />Flight</li>}
                  {route?.usesFerry && <li><span className="swatch swatch-dotted" />Ferry</li>}
                </ul>
                {route ? (
                  <p className="estimate">
                    <strong>{selected.name}: about {route.distanceKm.toLocaleString('en-CA')} km{routeSummary(route) && ` via ${routeSummary(route)}`}.</strong>{' '}
                    Prices and dates are from Canada Post, for a {result.weightKg} kg parcel at {result.accountRates ? 'your account rates' : 'retail rates'}, including fuel and tax. The route is an estimate: Canada Post doesn't publish which services fly, so it's inferred from how fast each one is.
                  </p>
                ) : (
                  <p className="estimate">These two places are close enough that no long-haul route applies.</p>
                )}
              </div>
            </div>
          </div>
        )}
      </Reveal>
    </section>
  );
}
