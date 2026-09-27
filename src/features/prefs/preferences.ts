// Edit › Preferences (Ctrl+K): sectioned dialog (General … Technology Previews) with Prev / Next, plus the runtime
// behaviour behind the settings that no other module owns: system colour picker, Shift tool switching, History Log,
// automatic recovery information, Reset Preferences On Quit, default interpolation.
import './prefs.css';
import { app, type Prefs } from '../../core/app';
import { events } from '../../core/events';
import { registerCommands, runCommand } from '../../core/commands';
import { fromHex, toHex } from '../../core/color';
import { hooks } from '../../core/registry';
import type { PixDocument } from '../../core/document';
import type { RGB } from '../../core/types';
import { h, isTyping } from '../../ui/dom';
import { openDialog, isDialogOpen } from '../../ui/dialog';
import { checkbox, colorSwatch, numberField, select, sliderRow } from '../../ui/widgets';
import { toast } from '../../ui/toast';
import { fontPrefs, setPreviewSize } from '../../tools/type/fonts';
import { xp, XDEFAULTS, setXPrefs, applyAppearance, resetAllPrefs, GRID_COLORS, GRID_SIZES, type XPrefs } from './store';
import { decodePXD, encodePXD } from '../file/formats';
import { downloadBlob } from '../file/io';

type Section = 'general' | 'interface' | 'workspace' | 'tools' | 'history' | 'files' | 'export' | 'performance' | 'cursors' | 'transparency' | 'units' | 'guides' | 'plugins' | 'type' | 'tech';
const SECTIONS: [Section, string][] = [
  ['general', 'General'], ['interface', 'Interface'], ['workspace', 'Workspace'], ['tools', 'Tools'], ['history', 'History Log'], ['files', 'File Handling'],
  ['export', 'Export'], ['performance', 'Performance'], ['cursors', 'Cursors'], ['transparency', 'Transparency & Gamut'], ['units', 'Units & Rulers'],
  ['guides', 'Guides, Grid & Slices'], ['plugins', 'Plugins'], ['type', 'Type'], ['tech', 'Technology Previews'],
];
let lastSection: Section = 'general';

// ------------------------------------------------------------------ dialog
async function preferences(start?: Section) {
  const A: Prefs = JSON.parse(JSON.stringify(app.prefs));
  const X: XPrefs = JSON.parse(JSON.stringify(xp));
  let fontPreview = fontPrefs.preview;
  let resetFlag = X.resetOnQuit;
  let cur: Section = start && SECTIONS.some(s => s[0] === start) ? start : lastSection;
  const nav = h('div.pf-nav');
  const pane = h('div.pf-pane');
  const row = (label: string, ...ctl: (Node | null)[]) => h('div.form-row.pf-row', null, h('label.form-label.pf-label', null, label), ...ctl);
  const group = (title: string, ...kids: (Node | null)[]) => h('fieldset.pf-group', null, h('legend', null, title), ...kids);
  const cb = (label: string, get: () => boolean, set: (v: boolean) => void, title?: string) => h('div.pf-check', null, checkbox(label, get(), set, { title: title || label }));
  const sel = <T,>(opts: [T, string][], v: T, set: (v: T) => void, width = 180, title = '') => select<T>(opts.map(([value, label]) => ({ value, label })), v, set, { width, title });
  const hexSwatch = (hex: string, set: (h: string) => void, title: string) => colorSwatch(fromHex(hex) || { r: 128, g: 128, b: 128 }, (c: RGB) => set(toHex(c)), { title });
  const note = (t: string) => h('div.pf-note', null, t);

  const build: Record<Section, () => HTMLElement[]> = {
    general: () => [
      row('Color Picker:', sel<XPrefs['colorPicker']>([['pixora', 'Pixora'], ['system', 'System (browser)']], X.colorPicker, v => { X.colorPicker = v; }, 180, 'Colour picker opened by the colour swatches')),
      row('Image Interpolation:', sel<XPrefs['interpolation']>([['nearest', 'Nearest Neighbor (preserve hard edges)'], ['bilinear', 'Bilinear'], ['bicubic', 'Bicubic (smooth gradients)'], ['bicubic-smoother', 'Bicubic Smoother (enlargement)'], ['bicubic-sharper', 'Bicubic Sharper (reduction)'], ['automatic', 'Bicubic Automatic']], X.interpolation, v => { X.interpolation = v; }, 280, 'Default resampling for Free Transform and Image Size')),
      group('Options',
        cb('Export Clipboard', () => X.exportClipboard, v => { X.exportClipboard = v; }, 'Copy / Cut also put the pixels on the system clipboard'),
        cb('Resize Image During Place', () => X.resizeOnPlace, v => { X.resizeOnPlace = v; }, 'Fit placed images inside the canvas'),
        cb('Always Create Smart Objects when Placing', () => X.placeAsSmart, v => { X.placeAsSmart = v; }, 'Placed images become Smart Objects (otherwise pixel layers)'),
        cb('Skip Transform when Placing', () => X.skipTransformPlace, v => { X.skipTransformPlace = v; }, 'Do not enter Free Transform after placing')),
      h('div.pf-actions', null,
        h('button.btn', { type: 'button', title: 'All preferences return to their defaults the next time Pixora starts', class: resetFlag ? 'pf-armed' : '', onclick: (e: MouseEvent) => { resetFlag = !resetFlag; (e.currentTarget as HTMLElement).classList.toggle('pf-armed', resetFlag); (e.currentTarget as HTMLElement).textContent = resetFlag ? 'Preferences Will Reset On Quit' : 'Reset Preferences On Quit'; } }, resetFlag ? 'Preferences Will Reset On Quit' : 'Reset Preferences On Quit')),
    ],
    interface: () => [
      group('Appearance',
        row('Color Theme:', h('div.pf-themes', null, ...(['darkest', 'dark', 'medium', 'light'] as const).map(t => { const b = h('button.pf-theme', { type: 'button', title: `${t[0].toUpperCase()}${t.slice(1)} theme`, class: `pf-t-${t}${A.theme === t ? ' on' : ''}`, onclick: () => { A.theme = t; b.parentElement!.querySelectorAll('.pf-theme').forEach(x => x.classList.toggle('on', x === b)); } }); return b; }))),
        row('Highlight Color:', sel<XPrefs['highlight']>([['blue', 'Default (Blue)'], ['gray', 'Gray']], X.highlight, v => { X.highlight = v; }, 160, 'Colour of selected buttons and controls'))),
      group('Canvas Color',
        ...([['canvasStandard', 'Standard Screen Mode:'], ['canvasFullMenu', 'Full Screen with Menus:'], ['canvasFull', 'Full Screen:']] as const).map(([k, label]) => {
          const presets: [string, string][] = [['', 'Default'], ['#000000', 'Black'], ['#282828', 'Dark Gray'], ['#535353', 'Medium Gray'], ['#a3a3a3', 'Light Gray']];
          const isCustom = !!X[k] && !presets.some(p => p[0] === X[k]);
          const sw = hexSwatch(X[k] || '#535353', v => { X[k] = v; s.setValue('custom'); }, 'Custom canvas colour');
          const s = sel<string>([...presets, ['custom', 'Custom…']], isCustom ? 'custom' : X[k], v => { if (v !== 'custom') X[k] = v; else X[k] = toHex(sw.getValue()); }, 140, 'Pasteboard colour around the image');
          return row(label, s, sw);
        })),
      group('Presentation',
        row('UI Font Size:', sel<XPrefs['uiScale']>([['small', 'Small'], ['medium', 'Medium'], ['large', 'Large']], X.uiScale, v => { X.uiScale = v; }, 120, 'Size of the text in panels and dialogs')),
        cb('Show Tool Tips', () => A.showTooltips, v => { A.showTooltips = v; }),
        cb('Show Menu Colors', () => X.menuColors, v => { X.menuColors = v; }, 'Show the colours assigned in Edit › Menus'),
        cb('Show Transformation Values', () => A.showTransformValues, v => { A.showTransformValues = v; }, 'Show size / angle next to the pointer while transforming'),
        cb('Enable Text Drop Shadow', () => X.textShadow, v => { X.textShadow = v; }, 'Subtle shadow behind interface labels')),
    ],
    workspace: () => [
      group('Options',
        cb('Open Documents as Tabs', () => X.docsAsTabs, v => { X.docsAsTabs = v; }, 'New documents open as tabs (otherwise in floating windows)'),
        cb('Large Tabs', () => X.largeTabs, v => { X.largeTabs = v; }, 'Taller document tabs'),
        cb('Enable Narrow Options Bar', () => X.narrowOptions, v => { X.narrowOptions = v; }, 'Compact options bar')),
      h('div.pf-actions', null, h('button.btn', { type: 'button', title: 'Restore the panels of the Essentials workspace', onclick: () => runCommand('window.workspace', 'Essentials') }, 'Restore Default Workspaces')),
    ],
    tools: () => [
      group('Options',
        cb('Use Shift Key for Tool Switch', () => X.shiftToolSwitch, v => { X.shiftToolSwitch = v; }, 'Off: pressing a tool letter again cycles through that slot'),
        cb('Zoom with Scroll Wheel', () => A.zoomWithScroll, v => { A.zoomWithScroll = v; }, 'The mouse wheel zooms instead of scrolling'),
        cb('Show Tool Tips', () => A.showTooltips, v => { A.showTooltips = v; })),
    ],
    history: () => {
      const exp = h('div.pf-actions', null,
        h('button.btn', { type: 'button', title: 'Download the history log as a text file', onclick: () => { const t = logText(); if (!t) { toast('The history log is empty.', 'info'); return; } downloadBlob(new Blob([t], { type: 'text/plain' }), 'Pixora History Log.txt'); } }, 'Save Log File…'),
        h('button.btn', { type: 'button', title: 'Delete the stored text log', onclick: () => { localStorage.removeItem(LOG_KEY); toast('History log cleared.', 'success'); } }, 'Clear Log'));
      return [
        cb('History Log', () => X.logEnabled, v => { X.logEnabled = v; }, 'Record the history of edits'),
        row('Save Log Items To:', sel<XPrefs['logTo']>([['metadata', 'Metadata'], ['text', 'Text File'], ['both', 'Both']], X.logTo, v => { X.logTo = v; }, 140, 'Metadata = stored in the document (File Info); Text File = the log you can save below')),
        row('Edit Log Items:', sel<XPrefs['logLevel']>([['sessions', 'Sessions Only'], ['concise', 'Concise'], ['detailed', 'Detailed']], X.logLevel, v => { X.logLevel = v; }, 140, 'How much is recorded')),
        note('Sessions Only records when documents are opened, saved and closed; Concise adds the name of every history state; Detailed adds undo/redo and times.'),
        exp,
      ];
    },
    files: () => [
      group('File Saving Options',
        row('Automatically Save Recovery Information Every:', sel<number>([[0, 'Off'], [1, '1 Minute'], [5, '5 Minutes'], [10, '10 Minutes'], [15, '15 Minutes'], [30, '30 Minutes'], [60, '1 Hour']], X.recoveryMinutes, v => { X.recoveryMinutes = v; }, 130, 'Unsaved documents are stored in the browser and offered after a crash')),
        cb('File Extension: Use Lower Case', () => X.lowercaseExt, v => { X.lowercaseExt = v; })),
      row('Recent File List Contains:', numberField(A.recentFileCount, v => { A.recentFileCount = Math.round(v); }, { min: 0, max: 100, width: 60, title: 'Number of recent files' }), h('span.pf-unit', null, 'files')),
    ],
    export: () => [
      group('Quick Export',
        row('Quick Export Format:', sel<XPrefs['quickFormat']>([['png', 'PNG'], ['jpeg', 'JPG'], ['webp', 'WebP']], X.quickFormat, v => { X.quickFormat = v; }, 120, 'Format of File › Export › Quick Export')),
        sliderRow('Quality:', X.quickQuality, 1, 100, v => { X.quickQuality = v; }, { unit: '%' })),
    ],
    performance: () => {
      const mem = h('div.pf-mem', null, 'Measuring…');
      const pm = (performance as any).memory, dm = (navigator as any).deviceMemory;
      const fmt = (b: number) => (b > 1e9 ? `${(b / 1e9).toFixed(2)} GB` : `${Math.round(b / 1e6)} MB`);
      void (async () => {
        const est = await navigator.storage?.estimate?.().catch(() => null);
        const persisted = await navigator.storage?.persisted?.().catch(() => false);
        mem.replaceChildren(...[
          h('div', null, `Device memory: ${dm ? dm + ' GB' : 'unknown'}`),
          pm ? h('div', null, `Script memory in use: ${fmt(pm.usedJSHeapSize)} of ${fmt(pm.jsHeapSizeLimit)}`) : null,
          est ? h('div', null, `Browser storage (recent files, recovery): ${fmt(est.usage || 0)} of ${fmt(est.quota || 0)}${persisted ? ' — persistent' : ''}`) : null,
          est && !persisted ? h('button.btn.small', { type: 'button', title: 'Ask the browser not to evict Pixora’s stored files', onclick: async () => { const ok = await navigator.storage.persist(); toast(ok ? 'Storage is now persistent.' : 'The browser declined persistent storage.', ok ? 'success' : 'info'); } }, 'Make Storage Persistent') : null].filter((x): x is HTMLElement => !!x));
      })();
      return [
        group('Memory Usage', mem),
        group('History & Cache',
          row('History States:', numberField(A.historyStates, v => { A.historyStates = Math.round(v); }, { min: 1, max: 1000, width: 70, title: 'Number of undo steps kept per document' })),
          h('div.pf-actions', null, h('button.btn', { type: 'button', title: 'Edit › Purge › All', onclick: () => runCommand('edit.purge', 'all') }, 'Purge Caches…'))),
      ];
    },
    cursors: () => [
      group('Painting Cursors',
        ...([['standard', 'Standard'], ['precise', 'Precise'], ['normal-tip', 'Normal Brush Tip'], ['full-tip', 'Full Size Brush Tip']] as const).map(([v, label]) => {
          const inp = h('input', { type: 'radio', name: 'pf-pc', checked: A.paintingCursor === v, onchange: () => { A.paintingCursor = v; } });
          return h('label.pf-radio', null, inp, h('span', null, label));
        }),
        note('Caps Lock temporarily switches painting cursors to Precise.')),
    ],
    transparency: () => {
      const pv = h('canvas.pf-checker', { width: 120, height: 80 }) as HTMLCanvasElement;
      const paint = () => {
        const x = pv.getContext('2d')!, [l, d] = X.gridColors === 'custom' ? X.gridCustom : GRID_COLORS[X.gridColors], s = GRID_SIZES[X.gridSize] || 8;
        x.fillStyle = l; x.fillRect(0, 0, 120, 80);
        if (GRID_SIZES[X.gridSize]) { x.fillStyle = d; for (let y = 0; y < 80; y += s) for (let xx = ((y / s) & 1) * s; xx < 120; xx += 2 * s) x.fillRect(xx, y, s, s); }
      };
      paint();
      const c1 = hexSwatch(X.gridCustom[0], v => { X.gridCustom = [v, X.gridCustom[1]]; X.gridColors = 'custom'; gc.setValue('custom'); paint(); }, 'Custom grid colour 1');
      const c2 = hexSwatch(X.gridCustom[1], v => { X.gridCustom = [X.gridCustom[0], v]; X.gridColors = 'custom'; gc.setValue('custom'); paint(); }, 'Custom grid colour 2');
      const gc = sel<XPrefs['gridColors']>([['light', 'Light'], ['medium', 'Medium'], ['dark', 'Dark'], ['red', 'Red'], ['orange', 'Orange'], ['green', 'Green'], ['blue', 'Blue'], ['purple', 'Purple'], ['custom', 'Custom']], X.gridColors, v => { X.gridColors = v; paint(); }, 120, 'Transparency grid colours');
      return [
        group('Transparency Settings', h('div.pf-split', null, h('div', null,
          row('Grid Size:', sel<XPrefs['gridSize']>([['none', 'None'], ['small', 'Small'], ['medium', 'Medium'], ['large', 'Large']], X.gridSize, v => { X.gridSize = v; paint(); }, 120, 'Transparency grid size')),
          row('Grid Colors:', gc, c1, c2)), pv)),
        group('Gamut Warning',
          row('Color:', hexSwatch(X.gamutColor, v => { X.gamutColor = v; }, 'Gamut warning colour')),
          row('Opacity:', numberField(X.gamutOpacity, v => { X.gamutOpacity = v; }, { min: 1, max: 100, unit: '%', width: 60, title: 'Gamut warning opacity' }))),
      ];
    },
    units: () => [
      group('Units',
        row('Rulers:', sel<Prefs['rulerUnits']>([['px', 'Pixels'], ['in', 'Inches'], ['cm', 'Centimeters'], ['mm', 'Millimeters'], ['pt', 'Points'], ['%', 'Percent']], A.rulerUnits, v => { A.rulerUnits = v; }, 140, 'Units of the rulers, Info panel and transform values'))),
      group('Column Size',
        row('Width:', numberField(X.columnWidth, v => { X.columnWidth = v; }, { min: 0, max: 10000, unit: 'px', width: 80, title: 'Column width for New Guide Layout (0 = fit to the canvas)' })),
        row('Gutter:', numberField(X.columnGutter, v => { X.columnGutter = v; }, { min: 0, max: 1000, unit: 'px', width: 80, title: 'Gutter for New Guide Layout' }))),
    ],
    guides: () => {
      const style = <K extends 'guideStyle' | 'gridStyle'>(k: K, opts: [XPrefs[K], string][]) => sel<XPrefs[K]>(opts, X[k], v => { X[k] = v; }, 110, 'Line style');
      return [
        group('Guides', row('Color:', hexSwatch(A.guideColor, v => { A.guideColor = v; }, 'Guide colour'), style('guideStyle', [['lines', 'Lines'], ['dashed', 'Dashed Lines']]))),
        group('Smart Guides', row('Color:', hexSwatch(A.smartGuideColor, v => { A.smartGuideColor = v; }, 'Smart guide colour'))),
        group('Grid',
          row('Color:', hexSwatch(A.gridColor, v => { A.gridColor = v; }, 'Grid colour'), style('gridStyle', [['lines', 'Lines'], ['dashed', 'Dashed Lines'], ['dots', 'Dots']])),
          row('Gridline Every:', numberField(A.gridSpacing, v => { A.gridSpacing = v; }, { min: 1, max: 10000, width: 70, title: 'Grid spacing (ruler units)' }), h('span.pf-unit', null, A.rulerUnits)),
          row('Subdivisions:', numberField(A.gridSubdivisions, v => { A.gridSubdivisions = Math.round(v); }, { min: 1, max: 100, width: 60, title: 'Grid subdivisions' }))),
        group('Slices',
          row('Line Color:', hexSwatch(X.sliceColor, v => { X.sliceColor = v; }, 'Slice line colour')),
          cb('Show Slice Numbers', () => X.sliceNumbers, v => { X.sliceNumbers = v; })),
      ];
    },
    plugins: () => [
      cb('Enable Plugins', () => X.pluginsEnabled, v => { X.pluginsEnabled = v; }, 'Allow installed plugins to run'),
      h('div.pf-actions', null, h('button.btn', { type: 'button', title: 'Plugins › Manage Plugins', onclick: () => runCommand('plugins.manage') }, 'Manage Plugins…')),
    ],
    type: () => [
      group('Type Options',
        cb('Use Smart Quotes', () => X.smartQuotes, v => { X.smartQuotes = v; }, 'Replace straight quotes with typographic quotes while typing'),
        row('Font Preview Size:', sel<string>([['none', 'None'], ['small', 'Small'], ['medium', 'Medium'], ['large', 'Large']], fontPreview, v => { fontPreview = v as any; }, 110, 'Size of the samples in the font menus')),
        row('Number of Recent Fonts to Display:', numberField(X.recentFontCount, v => { X.recentFontCount = Math.round(v); }, { min: 0, max: 30, width: 60, title: 'Recent fonts at the top of the font menus' }))),
    ],
    tech: () => [
      cb('Run Filters in Background Threads', () => X.workerFilters, v => { X.workerFilters = v; }, 'Filters run in Web Workers so the interface stays responsive; turn off to run them on the main thread'),
      note('Technology previews change how Pixora works internally. Turn a preview off if it causes problems on your system.'),
    ],
  };
  const draw = () => {
    lastSection = cur;
    nav.replaceChildren(...SECTIONS.map(([id, label]) => h('div.pf-navitem', { class: id === cur ? 'on' : '', title: label, onclick: () => { cur = id; draw(); } }, label)));
    pane.replaceChildren(h('div.pf-title', null, SECTIONS.find(s => s[0] === cur)![1]), ...build[cur]());
  };
  draw();
  const step = (d: number) => { const i = SECTIONS.findIndex(s => s[0] === cur); cur = SECTIONS[(i + d + SECTIONS.length) % SECTIONS.length][0]; draw(); };
  const dlg = openDialog({
    title: 'Preferences', body: h('div.pf-body', null, nav, pane), layout: 'side', width: 900, className: 'pf-dialog',
    buttons: [{ label: 'OK', primary: true, value: 'ok' }, { label: 'Cancel', value: null }, { label: 'Prev', onClick: () => { step(-1); return false; } }, { label: 'Next', onClick: () => { step(1); return false; } }] as any,
  });
  if ((await dlg.result) !== 'ok') return;
  X.resetOnQuit = resetFlag;
  const interpChanged = X.interpolation !== xp.interpolation;
  app.setPrefs(A);
  setXPrefs(X);
  if (fontPreview !== fontPrefs.preview) setPreviewSize(fontPreview);
  if (interpChanged) syncInterpolation();
  scheduleRecovery();
}

// ------------------------------------------------------------------ default interpolation
function syncInterpolation() {
  const t = xp.interpolation === 'nearest' ? 'nearest' : xp.interpolation === 'bilinear' ? 'bilinear' : 'bicubic';
  try { localStorage.setItem('pixora.transform.interp', t); } catch { /* ignore */ }
  const map: Record<string, string> = { nearest: 'nearest', bilinear: 'bilinear', bicubic: 'bicubic', 'bicubic-smoother': 'bicubic-smoother', 'bicubic-sharper': 'bicubic-sharper', automatic: 'automatic' };
  try { const k = 'pixora.image.imageSize', o = JSON.parse(localStorage.getItem(k) || '{}'); o.method = map[xp.interpolation]; localStorage.setItem(k, JSON.stringify(o)); } catch { /* ignore */ }
}

// ------------------------------------------------------------------ system colour picker
function nativePicker(c: RGB): Promise<RGB | null> {
  return new Promise(res => {
    const inp = h('input', { type: 'color', value: toHex(c), style: { position: 'fixed', left: '-100px', top: '0', opacity: '0' } }) as HTMLInputElement;
    document.body.append(inp);
    let done = false;
    const finish = (v: RGB | null) => { if (done) return; done = true; inp.remove(); res(v); };
    inp.addEventListener('change', () => finish(fromHex(inp.value)));
    inp.addEventListener('cancel', () => finish(null));
    // no 'cancel' event in some browsers: resolve when the window regains focus without a change
    window.addEventListener('focus', () => setTimeout(() => finish(null), 400), { once: true });
    inp.click();
  });
}
setTimeout(() => {
  const orig = hooks.openColorPicker;
  hooks.openColorPicker = ((c: RGB, ...rest: any[]) => (xp.colorPicker === 'system' ? nativePicker(c) : (orig as any)(c, ...rest))) as any;
});

// ------------------------------------------------------------------ Use Shift Key for Tool Switch (off → repeat the letter)
window.addEventListener('keydown', e => {
  if (xp.shiftToolSwitch || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey || e.repeat || isTyping() || isDialogOpen()) return;
  if (!/^Key[A-Z]$/.test(e.code)) return;
  const cur = app.activeTool, letter = e.code.slice(3);
  if (!cur || cur.shortcut !== letter || cur.isModal?.()) return;
  const list = app.toolsInGroup(cur.group).filter(t => t.shortcut === letter);
  if (list.length < 2) return;
  e.preventDefault(); e.stopImmediatePropagation();
  app.setTool(list[(list.indexOf(cur) + 1) % list.length].id);
}, true);

// ------------------------------------------------------------------ History Log
const LOG_KEY = 'pixora.historyLog';
const seen = new WeakMap<PixDocument, { last: unknown; index: number; len: number }>();
const stamp = () => new Date().toLocaleString();
export function logText() { try { return localStorage.getItem(LOG_KEY) || ''; } catch { return ''; } }
function log(doc: PixDocument | null, line: string) {
  if (!xp.logEnabled) return;
  const full = xp.logLevel === 'detailed' ? `${stamp()}  ${line}` : line;
  if ((xp.logTo === 'metadata' || xp.logTo === 'both') && doc) {
    const meta = doc.meta as Record<string, string>;
    meta.historyLog = (meta.historyLog ? meta.historyLog + '\n' : '') + full;
  }
  if (xp.logTo === 'text' || xp.logTo === 'both') {
    try { const t = (logText() + (doc ? `[${doc.name}] ` : '') + full + '\n').split('\n').slice(-5000).join('\n'); localStorage.setItem(LOG_KEY, t); } catch { /* quota */ }
  }
}
events.on('history', (doc: PixDocument) => {
  const hs = doc.history, last = hs.entries[hs.entries.length - 1], prev = seen.get(doc);
  seen.set(doc, { last, index: hs.index, len: hs.entries.length });
  if (!prev || xp.logLevel === 'sessions') return;
  if (last !== prev.last && hs.index === hs.entries.length && last) log(doc, (last as any).name);
  else if (xp.logLevel === 'detailed' && hs.index !== prev.index) log(doc, hs.index < prev.index ? `Undo: ${(hs.entries[hs.index] as any)?.name ?? ''}` : `Redo: ${(hs.entries[hs.index - 1] as any)?.name ?? ''}`);
});
let openDocs = new Set<PixDocument>();
events.on('docs', () => {
  const now = new Set(app.docs);
  for (const d of now) if (!openDocs.has(d)) { seen.set(d, { last: d.history.entries[d.history.entries.length - 1], index: d.history.index, len: d.history.entries.length }); log(d, `${stamp()}  File ${d.name} opened`); }
  for (const d of openDocs) if (!now.has(d)) { log(null, `${stamp()}  File ${d.name} closed`); void dropRecovery(d); }
  openDocs = now;
  // Open Documents as Tabs off → new documents float
  if (!xp.docsAsTabs && app.docs.length > 1) void runCommand('window.arrange', 'float');
});

// ------------------------------------------------------------------ recovery information (IndexedDB)
const RDB = 'pixora-recovery';
function rdb(): Promise<IDBDatabase> {
  return new Promise((res, rej) => { const r = indexedDB.open(RDB, 1); r.onupgradeneeded = () => r.result.createObjectStore('docs', { keyPath: 'id' }); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
}
async function rtx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await rdb();
  return new Promise<T>((res, rej) => { const t = db.transaction('docs', mode), q = fn(t.objectStore('docs')); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });
}
const recId = (d: PixDocument) => ((d as any)._recoveryId ??= `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`);
const savedAt = new WeakMap<PixDocument, unknown>();
async function saveRecovery() {
  for (const d of app.docs) {
    const top = d.history.entries[d.history.index - 1] ?? null;
    if (!d.modified) { void dropRecovery(d); continue; }
    if (savedAt.get(d) === top) continue;
    try { const blob = await encodePXD(d); await rtx('readwrite', s => s.put({ id: recId(d), name: d.name, date: Date.now(), blob })); savedAt.set(d, top); } catch { /* storage full / unavailable */ }
  }
}
async function dropRecovery(d: PixDocument) { if (!(d as any)._recoveryId) return; try { await rtx('readwrite', s => s.delete(recId(d))); } catch { /* ignore */ } }
let recTimer = 0;
function scheduleRecovery() { clearInterval(recTimer); if (xp.recoveryMinutes > 0) recTimer = window.setInterval(() => void saveRecovery(), xp.recoveryMinutes * 60_000); }
async function offerRecovery() {
  let list: { id: string; name: string; date: number; blob: Blob }[] = [];
  try { list = await rtx('readonly', s => s.getAll()); } catch { return; }
  if (!list.length) return;
  const body = h('div.pf-recover', null,
    h('div', null, `Pixora found recovery information for ${list.length} unsaved document(s):`),
    h('ul', null, ...list.map(r => h('li', null, `${r.name} — ${new Date(r.date).toLocaleString()}`))),
    h('div', null, 'Open them now? Discarded recovery information cannot be restored.'));
  const r = await openDialog({ title: 'Recover Documents', body, width: 460, cancelValue: 'no', buttons: [{ label: 'Recover', primary: true, value: 'yes' }, { label: 'Discard', value: 'no' }] }).result;
  if (r === 'yes') for (const it of list) {
    try { const d = await decodePXD(await it.blob.arrayBuffer(), `${it.name.replace(/( \(Recovered\))?$/, '')} (Recovered)`); (d as any)._recoveryId = it.id; d.modified = true; app.addDocument(d); }
    catch { toast(`Could not recover “${it.name}”.`, 'error'); }
  }
  else try { await rtx('readwrite', s => s.clear()); } catch { /* ignore */ }
}
window.addEventListener('beforeunload', () => { if (xp.recoveryMinutes > 0) void saveRecovery(); });

// ------------------------------------------------------------------ Reset Preferences On Quit
window.addEventListener('pagehide', () => {
  if (!xp.resetOnQuit) return;
  try { for (const k of Object.keys(localStorage)) if (k.startsWith('pixora.') && k !== 'pixora.recent') localStorage.removeItem(k); } catch { /* ignore */ }
  resetAllPrefs();
  try { localStorage.removeItem('pixora.prefs.x'); } catch { /* ignore */ }
});

// ------------------------------------------------------------------ boot
applyAppearance();
new MutationObserver(() => applyAppearance()).observe(document.body, { attributes: true, attributeFilter: ['data-screen'] });
scheduleRecovery();
setTimeout(() => void offerRecovery(), 1500);

registerCommands([{ id: 'edit.preferences', label: 'Preferences...', shortcut: 'Ctrl+K', run: (s?: Section) => preferences(s) }]);
(window as any).__pxPrefs = { xp, XDEFAULTS, setXPrefs, saveRecovery, offerRecovery, logText, preferences };
