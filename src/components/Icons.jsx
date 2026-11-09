const line = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.8,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
};

export const AppIcon = () => (
  <svg viewBox="0 0 32 32" width="26" height="26" aria-hidden="true">
    <rect width="32" height="32" rx="9" fill="#D52B1E" />
    <path d="M9 23c8 0 3-14 14-14" fill="none" stroke="#fff" strokeWidth="2.5" strokeLinecap="round" strokeDasharray="1 4.6" />
    <circle cx="9" cy="23" r="3" fill="#fff" />
    <circle cx="23" cy="9" r="3" fill="#fff" />
  </svg>
);

export const SearchIcon = () => (
  <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" {...line}>
    <circle cx="11" cy="11" r="6.5" />
    <path d="m16 16 4 4" />
  </svg>
);

export const SunIcon = () => (
  <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" {...line}>
    <circle cx="12" cy="12" r="4" />
    <path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6 7 7M17 17l1.4 1.4M18.4 5.6 17 7M7 17l-1.4 1.4" />
  </svg>
);

export const MoonIcon = () => (
  <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" {...line}>
    <path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5Z" />
  </svg>
);

export const ChevronIcon = () => (
  <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" {...line}>
    <path d="m6 9 6 6 6-6" />
  </svg>
);

// Plain strings: these go into Leaflet map icons, outside React.
export const PLANE_ICON_SVG = `<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12h18M14 12l-3 8M14 12l-3-8M6 12l-2 4M6 12 4 8"/></svg>`;

export const BOAT_ICON_SVG = `<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v9M12 4l5 7h-5M4 15h16l-2.5 4h-11z"/></svg>`;
