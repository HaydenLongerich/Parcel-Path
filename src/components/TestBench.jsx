import { useEffect, useState } from 'react';
import { ApiError, fetchBenchInfo, fetchRandomNumbers, runBench } from '../api.js';
import { formatLongDay } from '../format.js';
import Reveal from './Reveal.jsx';

export default function TestBench() {
  const [info, setInfo] = useState(null);
  const [source, setSource] = useState('live');
  const [text, setText] = useState('');
  const [results, setResults] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetchBenchInfo()
      .then((details) => {
        setInfo(details);
        if (details.hasTestKey) setSource('test');
      })
      .catch(() => setInfo({ hasLiveKey: false, hasTestKey: false, limit: 10 }));
  }, []);

  const attempt = async (action) => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (failure) {
      setError(failure instanceof ApiError ? failure.message : 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  };

  const numbers = text.split(/[\s,]+/).filter(Boolean);
  const fillRandom = () => attempt(async () => setText((await fetchRandomNumbers()).join('\n')));
  const run = (event) => {
    event.preventDefault();
    attempt(async () => setResults(await runBench(numbers, source)));
  };

  const openLink = (number) => `?pin=${encodeURIComponent(number)}${source === 'test' ? '&source=test' : ''}`;

  return (
    <section className="section section-narrow" id="test" aria-labelledby="test-title">
      <Reveal as="h2" id="test-title" className="section-title">Test bench</Reveal>
      <Reveal as="form" className="bench glass" onSubmit={run}>
        <fieldset>
          <legend>Look up with</legend>
          <label>
            <input type="radio" name="source" checked={source === 'test'} disabled={!info?.hasTestKey} onChange={() => setSource('test')} />
            Test app <small>sample data, any number</small>
          </label>
          <label>
            <input type="radio" name="source" checked={source === 'live'} onChange={() => setSource('live')} />
            Production key <small>real parcels, numbers you type</small>
          </label>
        </fieldset>

        {info && !info.hasTestKey && (
          <p className="bench-note">
            To test random numbers, create a <strong>[Test]</strong> app in the Developer Portal and add its key to <code>.env.local</code> as <code>CANADA_POST_TEST_API_KEY</code> and <code>CANADA_POST_TEST_API_SECRET</code>. Random numbers stay off your production key, because they could pull up a stranger's parcel.
          </p>
        )}

        <label className="bench-numbers">
          <span>Tracking numbers, up to {info?.limit ?? 10}</span>
          <textarea rows={5} value={text} onChange={(event) => setText(event.target.value)} spellCheck="false" placeholder="One per line" />
        </label>

        <div className="bench-actions">
          <button type="submit" className="button-primary bench-run" disabled={busy || numbers.length === 0}>
            {busy ? <span className="spinner" role="status" aria-label="Running" /> : 'Run'}
          </button>
          <button type="button" className="button-quiet" onClick={fillRandom} disabled={busy || source !== 'test' || !info?.hasTestKey}>Random numbers</button>
        </div>

        {error && <p className="bench-error" role="alert">{error}</p>}

        {results && (
          <div className="bench-results">
            <table>
              <thead>
                <tr><th scope="col">Number</th><th scope="col">Result</th><th scope="col">Scans</th><th scope="col">Expected</th><th scope="col"><span className="visually-hidden">Open</span></th></tr>
              </thead>
              <tbody>
                {results.map((row) => (
                  <tr key={row.number}>
                    <td className="bench-number">{row.number}</td>
                    <td>{row.ok ? `${row.status}${row.service ? ` · ${row.service}` : ''}` : row.message}</td>
                    <td>{row.ok ? row.scans : '—'}</td>
                    <td>{row.expectedDelivery ? formatLongDay(row.expectedDelivery) : '—'}</td>
                    <td>{row.ok && <a href={openLink(row.number)}>Open</a>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Reveal>
    </section>
  );
}
