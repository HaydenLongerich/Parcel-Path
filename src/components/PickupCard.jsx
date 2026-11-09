export default function PickupCard({ office }) {
  const today = new Date().getDay();
  return (
    <section className="pickup glass" aria-label="Pickup location">
      <div>
        <p className="pickup-label">Held for pickup at</p>
        <h2>{office.name}</h2>
        {office.location && <p className="pickup-detail">{office.location}</p>}
        <p className="pickup-detail">{office.street}, {office.city}, {office.province} {office.postalCode}</p>
      </div>
      <ul className="hours" aria-label="Opening hours">
        {office.hours.map((entry, index) => (
          <li key={entry.day} className={index === today ? 'is-today' : undefined}>
            <span>{entry.day.slice(0, 3)}</span>
            <span>{entry.periods.length ? entry.periods.join(', ') : 'Closed'}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
