import Reveal from './Reveal.jsx';

const number = (value) => (value === null || value === undefined ? '—' : value.toLocaleString('en-CA'));

export default function Stats({ stats }) {
  const items = [
    { label: 'Stops completed', value: stats.stopsCompleted, note: 'Places with a mapped scan' },
    { label: 'Km travelled', value: stats.kmTravelled, note: 'Straight-line, scan to scan' },
    { label: 'Days in transit', value: stats.daysInTransit, note: 'Since the first scan' },
  ];
  return (
    <section className="section" aria-labelledby="stats-title">
      <Reveal as="h2" id="stats-title" className="section-title">The trip so far</Reveal>
      <dl className="stats">
        {items.map((item, index) => (
          <Reveal key={item.label} className="stat glass lift" delay={index * 90}>
            <dd>{number(item.value)}</dd>
            <dt>{item.label}</dt>
            <p>{item.note}</p>
          </Reveal>
        ))}
      </dl>
    </section>
  );
}
