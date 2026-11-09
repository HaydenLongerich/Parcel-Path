import { useState } from 'react';
import { ChevronIcon } from './Icons.jsx';
import Reveal from './Reveal.jsx';

const QUESTIONS = [
  {
    q: 'Why did my parcel skip a city?',
    a: 'Trucks don’t stop at every processing facility on the way, and a parcel can pass through one without being scanned. The demo parcel left Newfoundland with no St. John’s scan at all. A missing city usually just means the parcel took a more direct run.',
  },
  {
    q: 'What does ‘transportation delay’ mean?',
    a: 'It’s a general notice that something slowed the network, such as weather, a cancelled ferry or heavy volume. It isn’t tied to one place, so it appears in the scan history without a point on the map. The parcel may still be moving.',
  },
  {
    q: 'How accurate is the predicted route?',
    a: 'Treat it as an educated guess. It’s the shortest path through a simplified model of the long-haul network, and Canada Post doesn’t publish actual routing. The solid line is what really happened; the dashed line and the stop count are estimates.',
  },
];

export default function Faq() {
  const [open, setOpen] = useState(0);
  return (
    <section className="section section-narrow" id="faq" aria-labelledby="faq-title">
      <Reveal as="h2" id="faq-title" className="section-title">Good questions</Reveal>
      <div className="faq">
        {QUESTIONS.map(({ q, a }, index) => {
          const isOpen = open === index;
          return (
            <Reveal key={q} className={`faq-item glass ${isOpen ? 'is-open' : ''}`} delay={index * 70}>
              <h3>
                <button
                  type="button"
                  id={`faq-q-${index}`}
                  aria-expanded={isOpen}
                  aria-controls={`faq-a-${index}`}
                  onClick={() => setOpen(isOpen ? -1 : index)}
                >
                  {q}
                  <ChevronIcon />
                </button>
              </h3>
              <div className="faq-answer" id={`faq-a-${index}`} role="region" aria-labelledby={`faq-q-${index}`} inert={!isOpen}>
                <div><p>{a}</p></div>
              </div>
            </Reveal>
          );
        })}
      </div>
    </section>
  );
}
