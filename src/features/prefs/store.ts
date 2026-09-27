// Extended preferences (everything the Preferences dialog adds on top of app.prefs). Stored separately so the core
// Prefs type stays untouched; modules read `xp` and listen to the 'prefs' event.
import { app, saveJSON } from '../../core/app';
import { events } from '../../core/events';
import { checkerStyle, resetCheckerPattern } from '../../core/canvas';

/** Run fn once every feature module has loaded and registered (main.ts sets window.__pixoraReady). */
export function whenReady(fn: () => void) {
  if ((window as any).__pixoraReady) { fn(); return; }
  const t = window.setInterval(() => { if ((window as any).__pixoraReady) { clearInterval(t); fn(); } }, 30);
}

export type Interp = 'nearest' | 'bilinear' | 'bicubic' | 'bicubic-smoother' | 'bicubic-sharper' | 'automatic';
export interface XPrefs {
  // General
  colorPicker: 'pixora' | 'system';
  interpolation: Interp;
  exportClipboard: boolean;
  placeAsSmart: boolean;
  skipTransformPlace: boolean;
  resizeOnPlace: boolean;
  resetOnQuit: boolean;
  // Interface
  highlight: 'blue' | 'gray';
  uiScale: 'small' | 'medium' | 'large';
  canvasStandard: string;                 // '' = theme default, else a CSS colour
  canvasFull: string;
  canvasFullMenu: string;
  menuColors: boolean;
  textShadow: boolean;
  // Workspace
  docsAsTabs: boolean;
  largeTabs: boolean;
  narrowOptions: boolean;
  // Tools
  shiftToolSwitch: boolean;
  // History log
  logEnabled: boolean;
  logTo: 'metadata' | 'text' | 'both';
  logLevel: 'sessions' | 'concise' | 'detailed';
  // File handling
  recoveryMinutes: number;                // 0 = off
  lowercaseExt: boolean;
  // Export
  quickFormat: 'png' | 'jpeg' | 'webp';
  quickQuality: number;
  // Transparency & gamut
  gridSize: 'none' | 'small' | 'medium' | 'large';
  gridColors: 'light' | 'medium' | 'dark' | 'red' | 'orange' | 'green' | 'blue' | 'purple' | 'custom';
  gridCustom: [string, string];
  gamutColor: string;
  gamutOpacity: number;
  // Units & rulers
  columnWidth: number;                    // px, 0 = fit the columns to the canvas
  columnGutter: number;                   // px
  // Guides, grid & slices
  guideStyle: 'lines' | 'dashed';
  gridStyle: 'lines' | 'dashed' | 'dots';
  sliceColor: string;
  sliceNumbers: boolean;
  // Plugins
  pluginsEnabled: boolean;
  // Type
  smartQuotes: boolean;
  recentFontCount: number;
  // Technology previews
  workerFilters: boolean;
}
export const XDEFAULTS: XPrefs = {
  colorPicker: 'pixora', interpolation: 'automatic', exportClipboard: true, placeAsSmart: true, skipTransformPlace: false, resizeOnPlace: true, resetOnQuit: false,
  highlight: 'blue', uiScale: 'small', canvasStandard: '', canvasFull: '#000000', canvasFullMenu: '', menuColors: true, textShadow: false,
  docsAsTabs: true, largeTabs: false, narrowOptions: false,
  shiftToolSwitch: true,
  logEnabled: false, logTo: 'metadata', logLevel: 'concise',
  recoveryMinutes: 10, lowercaseExt: true,
  quickFormat: 'png', quickQuality: 90,
  gridSize: 'medium', gridColors: 'light', gridCustom: ['#ffffff', '#cccccc'], gamutColor: '#808080', gamutOpacity: 100,
  columnWidth: 0, columnGutter: 20,
  guideStyle: 'lines', gridStyle: 'lines', sliceColor: '#3d8bff', sliceNumbers: true,
  pluginsEnabled: true,
  smartQuotes: true, recentFontCount: 8,
  workerFilters: true,
};
const KEY = 'pixora.prefs.x';
export const xp: XPrefs = (() => { try { return { ...XDEFAULTS, ...JSON.parse(localStorage.getItem(KEY) || '{}') }; } catch { return { ...XDEFAULTS }; } })();

export function setXPrefs(p: Partial<XPrefs>) {
  Object.assign(xp, p);
  saveJSON(KEY, xp);
  applyAppearance();
  events.emit('prefs');
  app.activeDoc?.invalidate();
}
/** Restore every preference (app + extended) to its default. */
export function resetAllPrefs() {
  Object.assign(xp, JSON.parse(JSON.stringify(XDEFAULTS)));
  saveJSON(KEY, xp);
  try { localStorage.removeItem('pixora.prefs'); } catch { /* ignore */ }
}

export const GRID_COLORS: Record<Exclude<XPrefs['gridColors'], 'custom'>, [string, string]> = {
  light: ['#ffffff', '#cccccc'], medium: ['#999999', '#666666'], dark: ['#666666', '#333333'],
  red: ['#ffffff', '#ffcccc'], orange: ['#ffffff', '#ffe0bf'], green: ['#ffffff', '#ccffcc'], blue: ['#ffffff', '#cce0ff'], purple: ['#ffffff', '#e6ccff'],
};
export const GRID_SIZES = { none: 0, small: 4, medium: 8, large: 16 } as const;

/** Push the visual preferences into CSS variables / body classes / the transparency grid. */
export function applyAppearance() {
  const root = document.documentElement, b = document.body;
  if (xp.highlight === 'gray') { root.style.setProperty('--accent', '#6e6e6e'); root.style.setProperty('--accent-hover', '#7c7c7c'); root.style.setProperty('--accent-soft', 'rgba(128,128,128,.35)'); }
  else { root.style.removeProperty('--accent'); root.style.removeProperty('--accent-hover'); root.style.removeProperty('--accent-soft'); }
  const mode = app.screenMode, canvas = mode === 'full' ? xp.canvasFull : mode === 'full-menu' ? xp.canvasFullMenu : xp.canvasStandard;
  if (canvas) root.style.setProperty('--pasteboard', canvas); else root.style.removeProperty('--pasteboard');
  if (b) {
    b.classList.toggle('pf-ui-medium', xp.uiScale === 'medium');
    b.classList.toggle('pf-ui-large', xp.uiScale === 'large');
    b.classList.toggle('pf-large-tabs', xp.largeTabs);
    b.classList.toggle('pf-narrow-options', xp.narrowOptions);
    b.classList.toggle('pf-text-shadow', xp.textShadow);
  }
  const [light, dark] = xp.gridColors === 'custom' ? xp.gridCustom : GRID_COLORS[xp.gridColors];
  const size = GRID_SIZES[xp.gridSize];
  checkerStyle.light = light; checkerStyle.dark = size ? dark : light; checkerStyle.size = size || 8;
  resetCheckerPattern();
  app.viewport?.refreshTheme();
  app.viewport?.requestRender(true);
}
