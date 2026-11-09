import { formatDay, formatLongDay } from '../format.js';

function Fact({ label, children, muted }) {
  return (
    <div className="fact">
      <dt>{label}</dt>
      <dd className={muted ? 'muted' : undefined}>{children}</dd>
    </div>
  );
}

function OnTimePill({ onTime }) {
  if (!onTime) return null;
  if (onTime.daysBehind <= 0) return <span className="pill pill-quiet">On schedule</span>;
  return <span className="pill pill-gold">{onTime.daysBehind} business day{onTime.daysBehind === 1 ? '' : 's'} behind standard</span>;
}

export default function SummaryCard({ view }) {
  const { summary } = view;
  const stops = summary.stopsRemaining;
  return (
    <section className="summary glass lift" aria-label="Parcel summary">
      <div className="summary-lead">
        <div className="pills">
          <span className={`pill ${summary.delivered ? 'pill-done' : 'pill-red'}`}>{summary.status}</span>
          {summary.hasDelay && !summary.delivered && <span className="pill pill-gold">Delay reported</span>}
          <OnTimePill onTime={summary.onTime} />
          {view.mode === 'demo' && <span className="pill pill-quiet">Demo</span>}
          {view.mode === 'test' && <span className="pill pill-quiet">Test data</span>}
        </div>
        <p className="journey">
          <span>{summary.origin ?? 'Origin unknown'}</span>
          <span className="arrow" aria-label="to">→</span>
          <span>{summary.destination ?? 'Destination unknown'}</span>
        </p>
      </div>
      <dl className="facts">
        <Fact label="Service" muted={!summary.service}>{summary.service ?? 'Not provided'}</Fact>
        <Fact label={summary.delivered ? 'Delivered' : 'Expected delivery'} muted={!summary.expectedDelivery}>
          {summary.expectedDelivery ? formatLongDay(summary.expectedDelivery) : 'Not in the tracking data'}
          {summary.originalExpectedDelivery && (
            <small className="fact-note">
              Was {formatDay(summary.originalExpectedDelivery)}
              {summary.expectedChangeReason && `. ${summary.expectedChangeReason}`}
            </small>
          )}
        </Fact>
        <Fact label="Stops remaining" muted={stops === null}>
          {stops === null ? 'Unknown' : stops === 0 ? 'None' : <>≈ {stops} <small>estimate</small></>}
        </Fact>
      </dl>
    </section>
  );
}
