import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, fetchDemo, fetchNotices, fetchTracking } from './api.js';
import { formatClock } from './format.js';
import { prefersReducedMotion, useTheme } from './useTheme.js';
import CommandBar from './components/CommandBar.jsx';
import Estimator from './components/Estimator.jsx';
import Faq from './components/Faq.jsx';
import { AppIcon, MoonIcon, SunIcon } from './components/Icons.jsx';
import PickupCard from './components/PickupCard.jsx';
import Reveal from './components/Reveal.jsx';
import RouteMap from './components/RouteMap.jsx';
import Stats from './components/Stats.jsx';
import SummaryCard from './components/SummaryCard.jsx';
import TestBench from './components/TestBench.jsx';
import Timeline from './components/Timeline.jsx';

const AUTO_REFRESH_MS = 20 * 60_000;

const ERROR_TITLES = {
  invalid_number: 'Check the tracking number',
  not_found: 'No tracking history found',
  auth_failed: 'Check your Canada Post API key',
  bad_request: 'Canada Post could not process that',
  rate_limited: 'Too many requests',
  blocked: 'Canada Post blocked the request',
  unavailable: 'Tracking is unavailable right now',
  offline: 'The server is not running',
};

function readUrl() {
  const params = new URLSearchParams(window.location.search);
  return { pin: params.get('pin') ?? '', dest: params.get('dest') ?? '', source: params.get('source') === 'test' ? 'test' : '' };
}

function writeUrl(params) {
  const query = new URLSearchParams(params).toString();
  window.history.replaceState(null, '', query ? `?${query}` : window.location.pathname);
}

const scrollToTracker = () =>
  document.getElementById('tracker')?.scrollIntoView({ behavior: prefersReducedMotion() ? 'auto' : 'smooth', block: 'start' });

export default function App() {
  const initial = useRef(readUrl()).current;
  const [theme, toggleTheme] = useTheme();
  const [query, setQuery] = useState(initial);
  const [view, setView] = useState(null);
  const [error, setError] = useState(null);
  const [banner, setBanner] = useState(null);
  const [loading, setLoading] = useState(false);
  const [selection, setSelection] = useState(null);
  const [notices, setNotices] = useState([]);
  const requestId = useRef(0);

  const load = useCallback(async (loader, { keepSelection = false } = {}) => {
    const id = ++requestId.current;
    setLoading(true);
    setError(null);
    try {
      const result = await loader();
      if (id !== requestId.current) return;
      setView(result);
      setBanner(null);
      if (!keepSelection) setSelection(null);
    } catch (failure) {
      if (id !== requestId.current) return;
      const problem = failure instanceof ApiError ? failure : new ApiError('internal', failure.message);
      if (problem.fallback) {
        setView(problem.fallback);
        setSelection(null);
        setBanner(`Canada Post's data format looks different from what this app expects (${problem.message}) You are seeing sample data, not your parcel.`);
      } else {
        setError(problem);
        if (!keepSelection) setView(null);
      }
    } finally {
      if (id === requestId.current) setLoading(false);
    }
  }, []);

  const showDemo = useCallback(() => {
    writeUrl({});
    setQuery({ pin: '', dest: '', source: '' });
    return load(fetchDemo);
  }, [load]);

  const track = useCallback(
    async ({ pin, dest, source = '' }) => {
      setQuery({ pin, dest, source });
      writeUrl({ pin, ...(dest ? { dest } : {}), ...(source ? { source } : {}) });
      await load(() => fetchTracking(pin, dest, source));
    },
    [load],
  );

  useEffect(() => {
    if (initial.pin) track(initial);
    else showDemo();
  }, [initial, showDemo, track]);

  useEffect(() => {
    fetchNotices().then(setNotices).catch(() => {});
  }, []);

  // The server also enforces its own limit, so a refresh can never reach Canada Post early.
  useEffect(() => {
    if (view?.mode !== 'live' || view.summary.delivered) return undefined;
    const timer = setInterval(() => {
      load(() => fetchTracking(query.pin, query.dest, query.source), { keepSelection: true });
    }, AUTO_REFRESH_MS);
    return () => clearInterval(timer);
  }, [view, query, load]);

  const selectEvent = (event) => setSelection({ source: 'timeline', eventId: event.id, placeId: event.placeId });
  const selectPlace = (placeId) => setSelection({ source: 'map', eventId: null, placeId });

  return (
    <>
      <div className="wallpaper" aria-hidden="true" />

      <header className="nav">
        <a className="brand" href="#top" aria-label="Parcel Path, back to top">
          <AppIcon />
          <span>Parcel Path</span>
        </a>
        <nav aria-label="Main">
          <a href="#tracker">Tracker</a>
          <a href="#estimate">Estimate</a>
          <a href="#faq" className="nav-wide">FAQ</a>
          <button
            type="button"
            className="icon-button"
            onClick={toggleTheme}
            aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
          >
            {theme === 'dark' ? <SunIcon /> : <MoonIcon />}
          </button>
        </nav>
      </header>

      <main id="top">
        {notices.map((notice) => (
          <div className="notice-strip note glass note-warn" role="status" key={notice.text}>{notice.text}</div>
        ))}

        <section className="hero">
          <h1 className="shimmer">Follow your parcel across the map</h1>
          <p>
            Enter a Canada Post tracking number to see every scan, the route so far, and an estimate of the road ahead.
          </p>
          <CommandBar
            key={`${query.pin}|${query.dest}`}
            initial={query}
            busy={loading}
            onSubmit={(values) => track(values).then(scrollToTracker)}
            onDemo={showDemo}
          />
        </section>

        <Reveal as="section" className="stage" id="tracker" aria-label="Tracker">
          {banner && <div className="note glass note-warn" role="alert">{banner}</div>}

          {loading && (
            <div className="note glass" role="status">
              <span className="spinner spinner-dark" aria-hidden="true" />
              Checking Canada Post…
            </div>
          )}

          {view?.mode === 'demo' && !banner && !loading && (
            <div className="note glass">Sample parcel: a real scan history stored in this app. Nothing is fetched from Canada Post.</div>
          )}

          {view?.mode === 'test' && !loading && (
            <div className="note glass">Test app data: Canada Post's sample response, not a real parcel.</div>
          )}

          {error && (
            <section className="notice glass" role="alert">
              <h2>{ERROR_TITLES[error.code] ?? 'Something went wrong'}</h2>
              <p>{error.message}</p>
              <button type="button" className="button-quiet" onClick={showDemo}>Show the demo parcel</button>
            </section>
          )}

          {view && (
            <div className="workspace">
              <div className="summary-stack">
                <SummaryCard view={view} />
                {view.pickup && <PickupCard office={view.pickup} />}
              </div>
              <div className="map-panel glass">
                <RouteMap view={view} selection={selection} theme={theme} onSelectPlace={selectPlace} />
                <MapKey view={view} />
              </div>
              <Timeline view={view} selection={selection} onSelectEvent={selectEvent} />
              {view.mode === 'live' && view.fetchedAt && (
                <p className="freshness">
                  Updated {formatClock(view.fetchedAt)} · To avoid overloading Canada Post, new data is available after {formatClock(view.nextRefreshAt)}
                </p>
              )}
            </div>
          )}
        </Reveal>

        {view && <Stats stats={view.stats} />}
        <Estimator theme={theme} />
        <Faq />
        <TestBench />
      </main>

      <footer className="footer">
        <span>Parcel Path is an independent project, not affiliated with Canada Post.</span>
        <span><a href="#test">Test bench</a> · Map data © OpenStreetMap contributors · Geocoding by Nominatim</span>
      </footer>
    </>
  );
}

function MapKey({ view }) {
  return (
    <div className="map-foot">
      <ul className="key" aria-label="Map key">
        <li><span className="swatch swatch-solid" />Scanned route</li>
        {view.predicted && <li><span className="swatch swatch-dashed" />Predicted route</li>}
        {view.predicted?.usesFerry && <li><span className="swatch swatch-dotted" />Ferry</li>}
        <li><span className="swatch swatch-current" />Current location</li>
      </ul>
      {view.predicted && (
        <p className="estimate">
          <strong>The dashed line is an estimate</strong> based on Canada Post's facility network. Real routing varies, and parcels can skip facilities or take other paths.
          {view.predicted.usesFerry && ' This route includes a ferry crossing.'}
        </p>
      )}
      {view.routeNote && <p className="estimate">{view.routeNote}</p>}
    </div>
  );
}
