// Adjustment icons (24×24, currentColor) — used by the Adjustments panel, Properties header and Layers panel.
import { registerIcons } from '../ui/icons';

const F = 'fill="currentColor" stroke="none"';
registerIcons({
  'adj-brightness': `<circle cx="12" cy="12" r="4.2"/><path d="M12 7.8a4.2 4.2 0 0 1 0 8.4z" ${F}/><path d="M12 2.5v2.2M12 19.3v2.2M2.5 12h2.2M19.3 12h2.2M5.3 5.3l1.6 1.6M17.1 17.1l1.6 1.6M5.3 18.7l1.6-1.6M17.1 6.9l1.6-1.6"/>`,
  'adj-levels': `<path d="M3 17.5V14l2.5-4 2.5 3 3-7 3 5 2.5-2 2.5 3 2 2v3.5z" ${F} opacity=".85"/><path d="M3 20.5h18"/><path d="m3.5 21.8 1.3-2 1.3 2z M11 21.8l1-2 1 2z M18.5 21.8l1.3-2 1.3 2z" ${F}/>`,
  'adj-curves': `<rect x="3.5" y="3.5" width="17" height="17" rx="1.5"/><path d="M3.5 20.5C9 20 8.5 8 20.5 3.5" stroke-width="1.8"/><path d="M9.2 3.5v17M14.8 3.5v17M3.5 9.2h17M3.5 14.8h17" opacity=".35"/>`,
  'adj-exposure': `<rect x="3.5" y="3.5" width="17" height="17" rx="1.5"/><path d="M20.5 3.5 3.5 20.5V3.5z" ${F}/><path d="M6 8h4M8 6v4" stroke="var(--bg, #535353)"/><path d="M14 16h4"/>`,
  'adj-vibrance': `<path d="M3.5 5h17L12 20z"/><path d="M7.6 8.2h8.8L12 16.2z" ${F}/>`,
  'adj-hue': `<rect x="3.5" y="4" width="17" height="4" rx="1" ${F} opacity=".45"/><rect x="3.5" y="10" width="17" height="4" rx="1" ${F} opacity=".75"/><rect x="3.5" y="16" width="17" height="4" rx="1" ${F}/>`,
  'adj-balance': `<path d="M12 3.5v16M7 20.5h10M4.5 7h15"/><path d="M4.5 7 2.2 13h4.6zM19.5 7l-2.3 6h4.6z"/><path d="M2.2 13a2.3 2.3 0 0 0 4.6 0zM17.2 13a2.3 2.3 0 0 0 4.6 0z" ${F}/>`,
  'adj-bw': `<rect x="3.5" y="3.5" width="17" height="17" rx="1.5"/><path d="M3.5 20.5 20.5 3.5v15.5a1.5 1.5 0 0 1-1.5 1.5z" ${F}/>`,
  'adj-photo-filter': `<path d="M3.5 8.5a1.5 1.5 0 0 1 1.5-1.5h2.6l1.6-2.2h5.6l1.6 2.2H19a1.5 1.5 0 0 1 1.5 1.5v9.5a1.5 1.5 0 0 1-1.5 1.5H5a1.5 1.5 0 0 1-1.5-1.5z"/><circle cx="12" cy="13" r="3.6"/><path d="M12 9.4a3.6 3.6 0 0 1 0 7.2z" ${F}/>`,
  'adj-mixer': `<circle cx="12" cy="8.3" r="4.8"/><circle cx="8.3" cy="14.7" r="4.8"/><circle cx="15.7" cy="14.7" r="4.8"/>`,
  'adj-lookup': `<rect x="3.5" y="3.5" width="17" height="17" rx="1.5"/><path d="M3.5 9.2h17M3.5 14.8h17M9.2 3.5v17M14.8 3.5v17"/><path d="M3.5 3.5h5.7v5.7H3.5zM14.8 9.2h5.7v5.6h-5.7zM9.2 14.8h5.6v5.7H9.2z" ${F}/>`,
  'adj-invert': `<rect x="3.5" y="3.5" width="17" height="17" rx="1.5"/><path d="M12 3.5h7a1.5 1.5 0 0 1 1.5 1.5v14a1.5 1.5 0 0 1-1.5 1.5h-7z" ${F}/><circle cx="12" cy="12" r="4"/><path d="M12 8a4 4 0 0 0 0 8z" ${F}/><path d="M12 8a4 4 0 0 1 0 8" stroke="var(--bg, #535353)"/>`,
  'adj-posterize': `<path d="M3.5 20.5v-4h4.3v-4.3h4.4V7.8h4.3V3.5h4v17z" ${F} opacity=".85"/><path d="M3.5 20.5h17"/>`,
  'adj-threshold': `<rect x="3.5" y="3.5" width="17" height="17" rx="1.5"/><path d="M12 3.5v4l-2 2 3 3-2 2 1 2v3.5H5a1.5 1.5 0 0 1-1.5-1.5V5A1.5 1.5 0 0 1 5 3.5z" ${F}/>`,
  'adj-gradient-map': `<defs><linearGradient id="adjgm" x1="0" x2="1"><stop offset="0" stop-color="currentColor" stop-opacity="1"/><stop offset="1" stop-color="currentColor" stop-opacity=".05"/></linearGradient></defs><rect x="3.5" y="6" width="17" height="12" rx="1.5" fill="url(#adjgm)"/><rect x="3.5" y="6" width="17" height="12" rx="1.5"/>`,
  'adj-selective': `<circle cx="12" cy="12" r="8.5"/><path d="M12 3.5a8.5 8.5 0 0 1 7.4 4.3L12 12z" ${F}/><path d="M12 12l-7.4 4.3A8.5 8.5 0 0 0 12 20.5z" ${F} opacity=".55"/>`,
  'adj-shadows': `<rect x="3.5" y="3.5" width="17" height="17" rx="1.5"/><path d="M3.5 13c3-2 5 2 8.5 0s5.5-2 8.5 0v6a1.5 1.5 0 0 1-1.5 1.5H5A1.5 1.5 0 0 1 3.5 19z" ${F}/>`,
  'adj-grid': `<rect x="3.5" y="3.5" width="17" height="17"/><path d="M3.5 6.9h17M3.5 10.3h17M3.5 13.7h17M3.5 17.1h17M6.9 3.5v17M10.3 3.5v17M13.7 3.5v17M17.1 3.5v17" opacity=".7"/>`,
  'adj-prev': `<path d="M4 12a8 8 0 1 0 2.4-5.7"/><path d="M4 3.8v4.6h4.6"/><circle cx="12" cy="12" r="2.4" ${F}/>`,
  'adj-mask-toggle': `<rect x="3.5" y="3.5" width="17" height="17" rx="1.5"/><circle cx="12" cy="12" r="5" ${F}/>`,
});
