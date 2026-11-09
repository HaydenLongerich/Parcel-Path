import { useEffect, useRef } from 'react';
import { formatDay, formatTime } from '../format.js';

export default function Timeline({ view, selection, onSelectEvent }) {
  const listRef = useRef(null);
  const newestFirst = [...view.events].reverse();
  const latestLocated = newestFirst.find((event) => event.placeId)?.id;

  const isActive = (event) =>
    selection && (selection.eventId === event.id || (selection.source === 'map' && event.placeId === selection.placeId));

  // When a map marker is picked, bring its events into view inside the list.
  useEffect(() => {
    if (selection?.source !== 'map') return;
    const list = listRef.current;
    const first = list?.querySelector('.event.is-active');
    if (first) list.scrollTo({ top: first.offsetTop - 8, behavior: 'smooth' });
  }, [selection]);

  return (
    <section className="timeline glass" aria-label="Scan history">
      <h2>Scan history</h2>
      <ol ref={listRef}>
        {newestFirst.map((event) => {
          const time = formatTime(event.time);
          const content = (
            <>
              <span className="event-dot" aria-hidden="true" />
              <span className="event-body">
                <span className="event-date">
                  {event.dateLabel ?? formatDay(event.date)}
                  {time && <small> · {time}</small>}
                  {event.id === latestLocated && <b>Current</b>}
                  {event.isDelay && <span className="pill pill-gold pill-small">Delay</span>}
                </span>
                <span className="event-text">{event.description}</span>
                <span className="event-place">
                  {event.location ?? (event.isDelay ? 'National notice, no location' : 'No location given')}
                  {event.postalCode && ` · ${event.postalCode}`}
                </span>
              </span>
            </>
          );
          const classes = [
            'event',
            isActive(event) && 'is-active',
            !event.placeId && 'is-notice',
            event.isDelay && 'is-delay',
            event.id === latestLocated && 'is-current',
          ].filter(Boolean).join(' ');
          return (
            <li key={event.id}>
              {event.placeId ? (
                <button type="button" className={classes} aria-pressed={Boolean(isActive(event))} onClick={() => onSelectEvent(event)}>
                  {content}
                </button>
              ) : (
                <div className={classes}>{content}</div>
              )}
            </li>
          );
        })}
      </ol>
    </section>
  );
}
