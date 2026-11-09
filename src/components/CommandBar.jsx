import { useEffect, useRef, useState } from 'react';
import { SearchIcon } from './Icons.jsx';

export default function CommandBar({ initial, busy, onSubmit, onDemo }) {
  const [pin, setPin] = useState(initial.pin);
  const [dest, setDest] = useState(initial.dest);
  const formRef = useRef(null);
  const pinRef = useRef(null);

  const submit = (event) => {
    event.preventDefault();
    const cleaned = pin.trim();
    if (cleaned && !busy) onSubmit({ pin: cleaned, dest: dest.trim() });
  };

  // ⌘/Ctrl + Enter works from anywhere on the page.
  useEffect(() => {
    const onKeyDown = (event) => {
      if (event.key !== 'Enter' || !(event.metaKey || event.ctrlKey)) return;
      event.preventDefault();
      if (pinRef.current.value.trim()) formRef.current.requestSubmit();
      else pinRef.current.focus();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, []);

  return (
    <form ref={formRef} className="command" onSubmit={submit}>
      <div className="command-bar glass-strong">
        <label className="command-field command-pin">
          <SearchIcon />
          <span className="visually-hidden">Tracking number</span>
          <input
            ref={pinRef}
            value={pin}
            onChange={(event) => setPin(event.target.value)}
            placeholder="Tracking number"
            autoComplete="off"
            spellCheck="false"
            inputMode="text"
            required
          />
        </label>
        <label className="command-field command-dest">
          <span className="visually-hidden">Destination, optional</span>
          <input
            value={dest}
            onChange={(event) => setDest(event.target.value)}
            placeholder="Destination (optional)"
            autoComplete="off"
          />
        </label>
        <button type="submit" className="button-primary command-submit" disabled={busy}>
          {busy ? <span className="spinner" role="status" aria-label="Tracking" /> : 'Track'}
        </button>
      </div>
      <p className="command-hint">
        <span className="hint-keys">
          <kbd>⌘</kbd>/<kbd>Ctrl</kbd> + <kbd>Enter</kbd> to track
          <span className="hint-dot" aria-hidden="true">·</span>
        </span>
        <button type="button" className="link-button" onClick={onDemo} disabled={busy}>Show the demo parcel</button>
      </p>
    </form>
  );
}
