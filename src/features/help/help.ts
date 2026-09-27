// Help menu: Pixora Help (topics), Hands-on Tutorials (step-by-step with live progress), Keyboard Shortcuts
// (searchable, from the menus + tools), What's New, About Pixora, About Plugins, System Info, GPU Compatibility,
// Updates (checks whether a newer build is being served).
import './help.css';
import { app } from '../../core/app';
import { events } from '../../core/events';
import { commands, registerCommands, runCommand, shortcutLabel } from '../../core/commands';
import { h } from '../../ui/dom';
import { icon } from '../../ui/icons';
import { openDialog } from '../../ui/dialog';
import { toast } from '../../ui/toast';
import { buildMenus } from '../../ui/menus-def';
import type { MenuEntry } from '../../ui/menu';

export const VERSION = '1.0.0';
const BUILD = 'Web';

// ------------------------------------------------------------------ Pixora Help
const TOPICS: [string, string, string][] = [
  ['Getting started', 'home', `Create a document with <b>File › New</b> (Ctrl+N) or open an image with <b>File › Open</b> (Ctrl+O). You can also drop image files onto the window.
   <br><br>The window is laid out like a classic image editor: the <b>menu bar</b> on top, the <b>options bar</b> below it (settings for the current tool), the <b>toolbar</b> on the left, your documents in the middle and <b>panels</b> on the right. Choose other panels from the <b>Window</b> menu and save your own layout with <b>Window › Workspace › New Workspace</b>.`],
  ['Navigating', 'zoom-in', `Zoom with <b>Ctrl + / Ctrl -</b>, fit the image with <b>Ctrl+0</b>, view actual pixels with <b>Ctrl+1</b>. Hold <b>Space</b> to pan with the Hand tool, <b>R</b> rotates the view.
   <br><br>Show rulers with <b>Ctrl+R</b> and drag guides out of them. <b>View › Snap</b> makes layers, selections and slices snap to guides, the grid, other layers and the canvas edges. Several documents can be shown side by side with <b>Window › Arrange</b>.`],
  ['Layers', 'layers', `Every document is a stack of layers. Create layers with <b>Shift+Ctrl+N</b>, duplicate with <b>Ctrl+J</b>, group with <b>Ctrl+G</b>. Double-click a layer to open <b>Layer Style</b> (drop shadows, strokes, glows, overlays…).
   <br><br>Layer masks hide parts of a layer non-destructively: paint black to hide, white to reveal. <b>Smart Objects</b> keep the original pixels so transforms and <b>Smart Filters</b> can be edited later.`],
  ['Selections', 'marquee', `Use the Marquee, Lasso, Object Selection, Quick Selection and Magic Wand tools to select areas, or <b>Select › Subject</b> / <b>Sky</b>. Hold Shift to add, Alt to subtract. <b>Select › Select and Mask</b> refines edges such as hair.
   <br><br>Most tools and filters only affect the selected area. Save selections with <b>Select › Save Selection</b>.`],
  ['Painting & retouching', 'brush', `The Brush (B), Pencil, Mixer Brush and Eraser (E) paint with the foreground colour; choose brushes in the Brushes panel and fine-tune them in Brush Settings (F5).
   <br><br>Retouch with the Spot Healing Brush (J), Healing Brush, Patch, Content-Aware Move, Clone Stamp (S) and <b>Edit › Content-Aware Fill</b>.`],
  ['Adjustments & filters', 'adjust-layer', `<b>Image › Adjustments</b> changes the pixels directly; adjustment layers (Layers panel ◐ button) do the same non-destructively. The <b>Filter</b> menu holds blurs, sharpening, distortions, noise, stylize effects, the <b>Filter Gallery</b>, <b>Liquify</b>, <b>Camera Raw Filter</b>, <b>Lens Correction</b> and <b>Adaptive Wide Angle</b>.
   <br><br>Convert a layer for Smart Filters first to keep every filter editable.`],
  ['Type', 'type', `Click with the Type tool (T) to add a line of text, drag to create a paragraph box. Format text in the options bar or the Character and Paragraph panels. <b>Type › Warp Text</b> bends text; <b>Type › Convert to Shape</b> turns it into vector outlines.`],
  ['Saving & exporting', 'save', `<b>File › Save</b> keeps layers (Pixora .pxd or .psd). <b>File › Export › Export As</b> writes PNG, JPEG, WebP, GIF or SVG, and <b>Quick Export</b> uses your last settings.`],
];
function helpDialog(topic = 0) {
  const list = h('div.hlp-topics'), content = h('div.hlp-content');
  const show = (i: number) => {
    list.querySelectorAll('.hlp-topic').forEach((el, k) => el.classList.toggle('active', k === i));
    content.innerHTML = `<h2>${TOPICS[i][0]}</h2><p>${TOPICS[i][2]}</p>`;
  };
  TOPICS.forEach(([t, ic], i) => { const b = h('button.hlp-topic', { type: 'button', title: t }, icon(ic, 16), h('span', null, t)); b.addEventListener('click', () => show(i)); list.append(b); });
  list.append(h('div.hlp-links', null,
    h('button.btn', { type: 'button', title: 'Open the hands-on tutorials', onclick: () => { d.close(null); void tutorialsDialog(); } }, 'Hands-on Tutorials'),
    h('button.btn', { type: 'button', title: 'List all keyboard shortcuts', onclick: () => { d.close(null); shortcutsDialog(); } }, 'Keyboard Shortcuts')));
  const d = openDialog({ title: 'Pixora Help', body: h('div.hlp-help', null, list, content), width: 760, buttons: [{ label: 'Close', primary: true, value: null }] });
  show(topic);
}

// ------------------------------------------------------------------ Hands-on Tutorials
interface Step { text: string; target?: string; done?: () => boolean; on?: string[] }
interface Tutorial { title: string; desc: string; steps: Step[] }
const lastHistory = () => app.activeDoc?.history.entries.at(-1)?.name || '';
const TUTORIALS: Tutorial[] = [
  { title: 'Paint your first stroke', desc: 'Pick a colour and brush, then paint.', steps: [
    { text: 'Create a new document: File › New (or press Ctrl+N) and click Create.', done: () => app.docs.length > 0, on: ['docs', 'activeDoc'] },
    { text: 'Select the Brush tool in the toolbar (or press B).', target: '.tool-btn[data-slot="brush"]', done: () => app.activeTool?.id === 'brush', on: ['tool'] },
    { text: 'Click the foreground colour swatch and choose a colour you like.', target: '.color-chip.fg', done: () => app.fg.r + app.fg.g + app.fg.b !== 0 && app.fg.r + app.fg.g + app.fg.b !== 765, on: ['colors'] },
    { text: 'Drag on the canvas to paint a stroke.', target: '.view-overlay', done: () => /Brush/.test(lastHistory()), on: ['history'] },
    { text: 'Press Ctrl+Z to undo it, then Shift+Ctrl+Z to redo. Every step is also listed in the History panel.', done: () => false },
  ] },
  { title: 'Make and use a selection', desc: 'Select an area and fill it.', steps: [
    { text: 'Open or create a document.', done: () => !!app.activeDoc, on: ['activeDoc', 'docs'] },
    { text: 'Choose the Rectangular Marquee tool (M).', target: '.tool-btn[data-slot="marquee"]', done: () => app.activeTool?.group === 'marquee', on: ['tool'] },
    { text: 'Drag a rectangle on the canvas.', target: '.view-overlay', done: () => !!app.activeDoc && !app.activeDoc.selection.empty, on: ['selection'] },
    { text: 'Fill it with the foreground colour: press Alt+Backspace.', done: () => /Fill/.test(lastHistory()), on: ['history'] },
    { text: 'Deselect with Ctrl+D.', done: () => !!app.activeDoc && app.activeDoc.selection.empty, on: ['selection'] },
  ] },
  { title: 'Add text with a style', desc: 'Type a headline and give it a drop shadow.', steps: [
    { text: 'Open or create a document.', done: () => !!app.activeDoc, on: ['activeDoc', 'docs'] },
    { text: 'Choose the Horizontal Type tool (T).', target: '.tool-btn[data-slot="type"]', done: () => app.activeTool?.id === 'type', on: ['tool'] },
    { text: 'Click on the canvas, type a word, then press Ctrl+Enter to commit.', target: '.view-overlay', done: () => lastHistory() === 'Type Tool', on: ['history'] },
    { text: 'Open Layer › Layer Style › Drop Shadow… (or double-click the layer) and press OK.', done: () => /Layer Style|Drop Shadow/.test(lastHistory()), on: ['history'] },
  ] },
  { title: 'Non-destructive filters', desc: 'Blur a layer with an editable Smart Filter.', steps: [
    { text: 'Open or create a document.', done: () => !!app.activeDoc, on: ['activeDoc', 'docs'] },
    { text: 'Choose Filter › Convert for Smart Filters.', done: () => app.activeDoc?.activeLayer?.kind === 'smart', on: ['layers', 'history'] },
    { text: 'Apply Filter › Blur › Gaussian Blur… and press OK.', done: () => !!(app.activeDoc?.activeLayer as any)?.smartFilters?.length, on: ['history', 'layers'] },
    { text: 'In the Properties panel, double-click "Gaussian Blur" under Smart Filters to change it again.', done: () => false },
  ] },
];
let tutorialOff: (() => void) | null = null;
function runTutorial(t: Tutorial) {
  tutorialOff?.();
  let i = 0;
  const card = h('div.hlp-tut');
  document.body.append(card);
  let hl: Element | null = null;
  const offs: (() => void)[] = [];
  const render = () => {
    hl?.classList.remove('hlp-pulse');
    const s = t.steps[i];
    card.replaceChildren(
      h('div.hlp-tut-head', null, h('span', null, `${t.title} · Step ${i + 1} of ${t.steps.length}`), h('button.icon-btn', { type: 'button', title: 'Close tutorial', onclick: () => stop() }, icon('close', 12))),
      h('div.hlp-tut-text', null, s.text),
      h('div.hlp-tut-foot', null,
        h('button.btn', { type: 'button', title: 'Previous step', disabled: i === 0, onclick: () => { i = Math.max(0, i - 1); render(); } }, 'Back'),
        h('button.btn.primary', { type: 'button', title: i === t.steps.length - 1 ? 'Finish the tutorial' : 'Next step', onclick: () => next() }, i === t.steps.length - 1 ? 'Done' : 'Next')));
    hl = s.target ? document.querySelector(s.target) : null;
    hl?.classList.add('hlp-pulse');
  };
  const next = () => { if (i >= t.steps.length - 1) { toast(`Tutorial complete: ${t.title}`, 'success'); stop(); return; } i++; render(); check(); };
  const check = () => { const s = t.steps[i]; if (s?.done?.()) setTimeout(() => { if (t.steps[i] === s) next(); }, 350); };
  for (const ev of ['docs', 'activeDoc', 'tool', 'colors', 'history', 'selection', 'layers']) offs.push(events.on(ev as any, check));
  const stop = () => { hl?.classList.remove('hlp-pulse'); card.remove(); offs.forEach(o => o()); tutorialOff = null; };
  tutorialOff = stop;
  render(); check();
}
async function tutorialsDialog() {
  const grid = h('div.hlp-tuts');
  const d = openDialog({ title: 'Hands-on Tutorials', body: grid, width: 640, buttons: [{ label: 'Close', primary: true, value: null }] });
  TUTORIALS.forEach(t => {
    const b = h('button.hlp-tcard', { type: 'button', title: `Start: ${t.title}` }, h('div.hlp-tcard-title', null, t.title), h('div.hlp-tcard-desc', null, t.desc), h('div.hlp-tcard-steps', null, `${t.steps.length} steps`));
    b.addEventListener('click', () => { d.close(null); runTutorial(t); });
    grid.append(b);
  });
}

// ------------------------------------------------------------------ Keyboard Shortcuts
export function allShortcuts(): { area: string; label: string; keys: string }[] {
  const out: { area: string; label: string; keys: string }[] = [];
  const walk = (area: string, items: MenuEntry[]) => {
    for (const it of items) {
      if (it === '-' || !it || typeof it !== 'object') continue;
      const e = it as any;
      const sub = typeof e.submenu === 'function' ? e.submenu() : e.submenu;
      if (sub) { walk(`${area} › ${e.label}`, sub); continue; }
      const cmd = e.cmd ? commands.get(e.cmd) : null;
      const sc = e.shortcut ?? (Array.isArray(cmd?.shortcut) ? cmd!.shortcut[0] : cmd?.shortcut);
      if (sc) out.push({ area, label: String(e.label ?? cmd?.label ?? e.cmd).replace(/\.\.\.$/, '…'), keys: shortcutLabel(sc) });
    }
  };
  try { for (const m of buildMenus()) walk(m.label, m.items()); } catch (err) { console.error(err); }
  const seenTools = new Set<string>();
  for (const t of [...app.tools.values()].sort((a, b) => (a.group || '').localeCompare(b.group || '') || (a.order ?? 0) - (b.order ?? 0))) {
    if (!t.shortcut || !t.group || seenTools.has(t.id)) continue;
    seenTools.add(t.id);
    out.push({ area: 'Tools', label: t.name, keys: `${t.shortcut}${[...app.tools.values()].filter(x => x.group === t.group && x.shortcut).length > 1 ? '  (Shift+' + t.shortcut + ' cycles)' : ''}` });
  }
  const extra: [string, string, string][] = [
    ['Navigation', 'Temporary Hand tool', 'Space'], ['Navigation', 'Zoom in / out temporarily', 'Ctrl+Space / Alt+Space'], ['Navigation', 'Hide panels', 'Tab'], ['Navigation', 'Hide panels except toolbar', 'Shift+Tab'],
    ['Painting', 'Decrease / increase brush size', '[ / ]'], ['Painting', 'Softer / harder brush', 'Shift+[ / Shift+]'], ['Painting', 'Default colours', 'D'], ['Painting', 'Swap colours', 'X'], ['Painting', 'Set opacity 10–100%', '1 … 0'],
    ['Painting', 'Eyedropper while painting', 'Alt'], ['Selection', 'Add to selection', 'Shift'], ['Selection', 'Subtract from selection', 'Alt'], ['Layers', 'Select next / previous layer', 'Alt+] / Alt+['],
  ];
  for (const [a, l, k] of extra) out.push({ area: a, label: l, keys: k });
  return out;
}
function shortcutsDialog() {
  const all = allShortcuts();
  const search = h('input.field', { type: 'search', placeholder: 'Search shortcuts…', style: { width: '100%' } }) as HTMLInputElement;
  search.addEventListener('keydown', e => e.stopPropagation());
  const list = h('div.hlp-sc-list');
  const render = () => {
    const q = search.value.trim().toLowerCase();
    list.replaceChildren();
    let area = '';
    for (const s of all) {
      if (q && !`${s.area} ${s.label} ${s.keys}`.toLowerCase().includes(q)) continue;
      if (s.area !== area) { area = s.area; list.append(h('div.hlp-sc-area', null, area)); }
      list.append(h('div.hlp-sc-row', null, h('span', null, s.label), h('kbd', null, s.keys)));
    }
    if (!list.childNodes.length) list.append(h('div.flt-hint', null, 'No shortcuts match.'));
  };
  search.addEventListener('input', render);
  render();
  openDialog({ title: 'Keyboard Shortcuts', body: h('div.hlp-sc', null, search, list), width: 620, buttons: [{ label: 'Customize…', value: 'edit', onClick: () => { void runCommand('edit.keyboardShortcuts'); } }, { label: 'Close', primary: true, value: null }] });
  setTimeout(() => search.focus());
}

// ------------------------------------------------------------------ What's New / About
const NEWS: [string, string[]][] = [
  ['Views & windows', ['Guides from the rulers, guide layouts and guides from shapes', 'Snapping with smart guides', 'Proof Colors, Gamut Warning and Pattern Preview', 'Slice and Slice Select tools', 'Tile, 2-up and floating document windows, Match Zoom / Location', 'Plugins with a sandboxed runtime']],
  ['Filters', ['Full Filter menu with live previews running in the background', 'Smart Filters on Smart Objects', 'Liquify, Camera Raw Filter, Lens Correction, Adaptive Wide Angle', 'Filter Gallery with 47 effects and effect layers']],
  ['Type & styles', ['Type tools with in-canvas editing, warp and type masks', 'Character, Paragraph, Styles and Glyphs panels', 'Layer Styles with all effects, Blend If and a Styles panel']],
];
function whatsNew() {
  const body = h('div.hlp-news', null, h('div.hlp-news-ver', null, `Pixora ${VERSION}`), ...NEWS.map(([t, items]) => h('div.hlp-news-sec', null, h('h3', null, t), h('ul', null, ...items.map(i => h('li', null, i))))));
  openDialog({ title: "What's New", body, width: 560, buttons: [{ label: 'Close', primary: true, value: null }] });
}
function about() {
  const logo = h('div.hlp-logo', null, 'Px');
  const body = h('div.hlp-about', null, logo,
    h('div', null, h('div.hlp-about-name', null, 'Pixora'), h('div.hlp-about-ver', null, `Version ${VERSION} (${BUILD})`),
      h('p', null, 'A layer-based image editor that runs entirely in your browser. Your images never leave your computer unless you export or share them.'),
      h('p.hlp-dim', null, `© ${new Date().getFullYear()} Pixora contributors. Rendering: Canvas 2D + Web Workers.`)));
  openDialog({ title: 'About Pixora', body, width: 520, buttons: [{ label: 'OK', primary: true, value: null }] });
}

// ------------------------------------------------------------------ System Info / GPU / Updates
function gpuInfo(): { vendor: string; renderer: string; webgl2: boolean; maxTexture: number } {
  try {
    const c = document.createElement('canvas'), gl = (c.getContext('webgl2') || c.getContext('webgl')) as WebGLRenderingContext | null;
    if (!gl) return { vendor: 'n/a', renderer: 'WebGL unavailable', webgl2: false, maxTexture: 0 };
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const res = { vendor: String(ext ? gl.getParameter(ext.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR)), renderer: String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)), webgl2: typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext, maxTexture: gl.getParameter(gl.MAX_TEXTURE_SIZE) as number };
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return res;
  } catch { return { vendor: 'n/a', renderer: 'unknown', webgl2: false, maxTexture: 0 }; }
}
async function systemInfoText(): Promise<string> {
  const nav = navigator as any, g = gpuInfo();
  const est = await nav.storage?.estimate?.().catch(() => null);
  const mem = (performance as any).memory;
  const lines = [
    `Pixora version: ${VERSION} (${BUILD})`,
    `Browser: ${navigator.userAgent}`,
    `Platform: ${nav.userAgentData?.platform || navigator.platform}`,
    `Language: ${navigator.language}`,
    `Logical processors: ${navigator.hardwareConcurrency || '?'}`,
    `Device memory: ${nav.deviceMemory ? nav.deviceMemory + ' GB' : 'n/a'}`,
    `JS heap: ${mem ? `${Math.round(mem.usedJSHeapSize / 1048576)} MB used of ${Math.round(mem.jsHeapSizeLimit / 1048576)} MB` : 'n/a'}`,
    `Screen: ${screen.width} × ${screen.height} @ ${window.devicePixelRatio}x, window ${innerWidth} × ${innerHeight}`,
    `GPU: ${g.renderer} (${g.vendor})`,
    `WebGL 2: ${g.webgl2 ? 'yes' : 'no'}, max texture ${g.maxTexture}`,
    `OffscreenCanvas: ${typeof OffscreenCanvas !== 'undefined' ? 'yes' : 'no'}`,
    `Web Workers: ${typeof Worker !== 'undefined' ? 'yes' : 'no'}`,
    `File System Access API: ${'showSaveFilePicker' in window ? 'yes' : 'no'}`,
    `Local Font Access: ${'queryLocalFonts' in window ? 'yes' : 'no'}`,
    `Storage: ${est ? `${Math.round((est.usage || 0) / 1048576)} MB used of ${Math.round((est.quota || 0) / 1048576)} MB` : 'n/a'}`,
    `Open documents: ${app.docs.length}${app.docs.map(d => `\n  ${d.name}: ${d.width} × ${d.height}, ${d.allLayers().length} layers, ${d.history.entries.length} history states`).join('')}`,
    `Theme: ${app.prefs.theme}, history states: ${app.prefs.historyStates}`,
  ];
  return lines.join('\n');
}
async function systemInfo() {
  const text = await systemInfoText();
  const pre = h('textarea.field.hlp-sys', { readonly: true, rows: 18 }) as HTMLTextAreaElement;
  pre.value = text;
  openDialog({ title: 'System Info', body: pre, width: 680, buttons: [{ label: 'Copy', onClick: async () => { try { await navigator.clipboard.writeText(text); toast('System info copied', 'success'); } catch { pre.select(); document.execCommand('copy'); } return false; } }, { label: 'OK', primary: true, value: null }] });
}
function canvasLimit(): number {
  let lo = 4096, hi = 32768;
  const ok = (s: number) => { try { const c = document.createElement('canvas'); c.width = s; c.height = 1; const x = c.getContext('2d')!; x.fillRect(s - 1, 0, 1, 1); return x.getImageData(s - 1, 0, 1, 1).data[3] === 255; } catch { return false; } };
  if (!ok(lo)) return lo;
  for (let i = 0; i < 6; i++) { const m = Math.round((lo + hi) / 2); if (ok(m)) lo = m; else hi = m; }
  return lo;
}
function gpuCompat() {
  const g = gpuInfo(), maxW = canvasLimit();
  const rows: [string, boolean, string][] = [
    ['Canvas 2D', true, 'Required for all drawing'],
    ['Large canvases', maxW >= 16384, `Widest canvas: ${maxW}px`],
    ['WebGL', g.renderer !== 'WebGL unavailable', g.renderer],
    ['WebGL 2', g.webgl2, g.webgl2 ? `Max texture ${g.maxTexture}px` : 'Not available'],
    ['OffscreenCanvas', typeof OffscreenCanvas !== 'undefined', 'Used by filters in the background'],
    ['Web Workers', typeof Worker !== 'undefined', 'Keeps filters and healing responsive'],
    ['createImageBitmap', typeof createImageBitmap === 'function', 'Fast image decoding'],
  ];
  const body = h('div.hlp-gpu', null, h('p', null, rows.every(r => r[1]) ? 'Your browser and graphics hardware support every Pixora feature.' : 'Some features will run slower or are unavailable:'),
    ...rows.map(([n, ok, d]) => h('div.hlp-gpu-row', null, h('span.hlp-gpu-ic', { class: ok ? 'ok' : 'bad' }, ok ? '✓' : '✕'), h('span.hlp-gpu-name', null, n), h('span.hlp-dim', null, d))));
  openDialog({ title: 'GPU Compatibility', body, width: 560, buttons: [{ label: 'OK', primary: true, value: null }] });
}
async function updates() {
  const status = h('div.hlp-upd', null, `You are running Pixora ${VERSION}. Checking for a newer version…`);
  const d = openDialog({ title: 'Updates', body: status, width: 480, buttons: [{ label: 'Reload', onClick: () => { location.reload(); } }, { label: 'Close', primary: true, value: null }] });
  try {
    const res = await fetch(location.href.split('#')[0], { cache: 'no-store' });
    const html = await res.text();
    const scripts = (s: string) => [...s.matchAll(/<script[^>]+src="([^"]+)"/g)].map(m => m[1]).sort().join('|');
    const current = [...document.querySelectorAll('script[src]')].map(s => (s as HTMLScriptElement).getAttribute('src')).sort().join('|');
    const newer = scripts(html) && current && scripts(html) !== current;
    status.textContent = newer ? 'A newer version of Pixora is available. Save your work, then click Reload to update.' : `Pixora ${VERSION} is up to date. Pixora updates automatically whenever a new version is published and the page is reloaded.`;
  } catch { status.textContent = 'Could not check for updates (you may be offline). Pixora updates automatically the next time the page is reloaded online.'; }
  void d;
}

registerCommands([
  { id: 'help.help', label: 'Pixora Help...', shortcut: 'F1', run: () => helpDialog() },
  { id: 'help.tutorials', label: 'Hands-on Tutorials...', run: () => tutorialsDialog() },
  { id: 'help.shortcuts', label: 'Keyboard Shortcuts', run: shortcutsDialog },
  { id: 'help.whatsNew', label: "What's New", run: whatsNew },
  { id: 'help.about', label: 'About Pixora...', run: about },
  { id: 'help.systemInfo', label: 'System Info...', run: systemInfo },
  { id: 'help.gpu', label: 'GPU Compatibility...', run: gpuCompat },
  { id: 'help.updates', label: 'Updates...', run: updates },
]);
(window as any).__pxHelp = { allShortcuts, systemInfoText, TUTORIALS, runTutorial };
