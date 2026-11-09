import { useCallback, useEffect, useState } from 'react';

const STORAGE_KEY = 'parcel-path-theme';

function readSaved() {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

export function useTheme() {
  const [theme, setTheme] = useState(() => document.documentElement.dataset.theme ?? 'light');

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  // Follow the system setting until the visitor picks a theme themselves.
  useEffect(() => {
    const query = matchMedia('(prefers-color-scheme: dark)');
    const onChange = (event) => {
      if (!readSaved()) setTheme(event.matches ? 'dark' : 'light');
    };
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);

  const toggle = useCallback(() => {
    setTheme((current) => {
      const next = current === 'dark' ? 'light' : 'dark';
      try {
        localStorage.setItem(STORAGE_KEY, next);
      } catch {
        // The toggle still works for this visit without storage.
      }
      return next;
    });
  }, []);

  return [theme, toggle];
}

export const prefersReducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
