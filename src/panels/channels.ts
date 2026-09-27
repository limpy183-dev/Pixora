// Channels panel: RGB composite + Red/Green/Blue (grayscale thumbnails, eyes, single-channel viewing via a
// viewport afterComposite drawing), Quick Mask channel, alpha channels (doc.channels: view, load, save, rename, delete).
import { app } from '../core/app';
import { events } from '../core/events';
import type { AlphaChannel, PixDocument } from '../core/document';
import { createCanvas, ctx2d, cloneCanvas } from '../core/canvas';
import { registerCommands } from '../core/commands';
import { viewportHooks } from '../core/viewport';
import { registerPanel } from '../ui/panels';
import { h } from '../ui/dom';
import { icon, registerIcons } from '../ui/icons';
import { iconButton, textField, numberField } from '../ui/widgets';
import { contextMenu, type MenuEntry } from '../ui/menu';
import { openDialog, confirmDialog } from '../ui/dialog';
import { toast } from '../ui/toast';
import { opFromEvent } from '../features/layers/shared';
import './channels.css';

registerIcons({
  'ch-load': `<circle cx="12" cy="12" r="7.5" stroke-dasharray="2.2 2.2"/>`,
  'ch-save': `<rect x="4" y="4" width="16" height="16" rx="1"/><circle cx="12" cy="12" r="4.5" fill="currentColor" stroke="none"/>`,
});

type Color = 'r' | 'g' | 'b';
interface ChanState { sel: Set<string>; vis: Set<string> }   // keys: 'r' 'g' 'b' 'qm' or 'a<id>'
const states = new WeakMap<PixDocument, ChanState>();
const stateOf = (d: PixDocument) => { let s = states.get(d); if (!s) states.set(d, (s = { sel: new Set(['r', 'g', 'b']), vis: new Set(['r', 'g', 'b']) })); return s; };
const COLORS: [Color, string, string][] = [['r', 'Red', 'Ctrl+3'], ['g', 'Green', 'Ctrl+4'], ['b', 'Blue', 'Ctrl+5']];
const aKey = (c: AlphaChannel) => 'a' + c.id;

function changed(doc: PixDocument) {
  app.viewport?.requestRender();
  events.emit('view', doc);
  panel?.schedule();
}

/** Current channel selection is the plain RGB composite (normal view)? */
export function isCompositeView(doc: PixDocument) { const s = stateOf(doc); return ['r', 'g', 'b'].every(k => s.vis.has(k)) && s.vis.size === 3; }

function selectColor(doc: PixDocument, k: Color | 'rgb', add = false) {
  const s = stateOf(doc);
  if (k === 'rgb') { s.sel = new Set(['r', 'g', 'b']); s.vis = new Set(['r', 'g', 'b']); }
  else if (add) { if (s.sel.has(k) && s.sel.size > 1) { s.sel.delete(k); s.vis.delete(k); } else { s.sel.add(k); s.vis.add(k); } }
  else { s.sel = new Set([k]); s.vis = new Set([k]); }
  changed(doc);
}
function selectAlpha(doc: PixDocument, c: AlphaChannel, add = false) {
  const s = stateOf(doc), k = aKey(c);
  if (add) { s.sel.add(k); s.vis.add(k); }
  else { s.sel = new Set([k]); s.vis = new Set([k]); }
  changed(doc);
}
function toggleVis(doc: PixDocument, k: string) {
  const s = stateOf(doc);
  if (k === 'rgb') { const on = !['r', 'g', 'b'].every(x => s.vis.has(x)); for (const x of ['r', 'g', 'b']) on ? s.vis.add(x) : s.vis.delete(x); }
  else if (s.vis.has(k)) s.vis.delete(k); else s.vis.add(k);
  if (!s.vis.size) s.vis.add(k === 'rgb' ? 'r' : k);
  changed(doc);
}

// ------------------------------------------------------------------ SVG colour-matrix filters for the channel views
const FILTERS: Record<string, string> = {
  r: '1 0 0 0 0  1 0 0 0 0  1 0 0 0 0  0 0 0 1 0',
  g: '0 1 0 0 0  0 1 0 0 0  0 1 0 0 0  0 0 0 1 0',
  b: '0 0 1 0 0  0 0 1 0 0  0 0 1 0 0  0 0 0 1 0',
  rg: '1 0 0 0 0  0 1 0 0 0  0 0 0 0 0  0 0 0 1 0',
  rb: '1 0 0 0 0  0 0 0 0 0  0 0 1 0 0  0 0 0 1 0',
  gb: '0 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 1 0',
};
(() => {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('width', '0'); svg.setAttribute('height', '0');
  svg.style.position = 'absolute'; svg.style.pointerEvents = 'none';
  for (const [k, m] of Object.entries(FILTERS)) {
    const f = document.createElementNS(ns, 'filter');
    f.id = `px-ch-${k}`;
    f.setAttribute('color-interpolation-filters', 'sRGB');
    const cm = document.createElementNS(ns, 'feColorMatrix');
    cm.setAttribute('type', 'matrix'); cm.setAttribute('values', m);
    f.append(cm); svg.append(f);
  }
  document.body.append(svg);
})();

/** White-with-alpha version of a selection-style canvas (cached per canvas). */
const whiteCache = new WeakMap<HTMLCanvasElement, HTMLCanvasElement>();
function whiteOf(c: HTMLCanvasElement): HTMLCanvasElement {
  let w = whiteCache.get(c);
  if (!w) { w = cloneCanvas(c); const x = ctx2d(w); x.globalCompositeOperation = 'source-in'; x.fillStyle = '#fff'; x.fillRect(0, 0, w.width, w.height); whiteCache.set(c, w); }
  return w;
}
/** Red rubylith over unselected (low) areas of a channel (cached per canvas). */
const rubyCache = new WeakMap<HTMLCanvasElement, HTMLCanvasElement>();
function rubyOf(c: HTMLCanvasElement): HTMLCanvasElement {
  let r = rubyCache.get(c);
  if (!r) { r = createCanvas(c.width, c.height); const x = ctx2d(r); x.fillStyle = 'rgba(255,0,0,.5)'; x.fillRect(0, 0, r.width, r.height); x.globalCompositeOperation = 'destination-out'; x.drawImage(c, 0, 0); rubyCache.set(c, r); }
  return r;
}

viewportHooks.afterComposite.push((ctx, view, doc) => {
  const s = states.get(doc);
  if (!s) return;
  const colors = (['r', 'g', 'b'] as Color[]).filter(k => s.vis.has(k));
  const alphas = doc.channels.filter(c => s.vis.has(aKey(c)));
  if (colors.length === 3 && !alphas.length) return;
  view.applyDocTransform(ctx);
  ctx.imageSmoothingEnabled = view.zoom < 1;
  const W = doc.width, H = doc.height;
  if (!colors.length) {
    // alpha channel(s) only: grayscale (white = selected)
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
    for (const a of alphas) ctx.drawImage(whiteOf(a.canvas), 0, 0);
    return;
  }
  if (colors.length < 3) {
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W, H);
    ctx.filter = `url(#px-ch-${colors.join('')})`;
    ctx.drawImage(doc.composite, 0, 0);
    ctx.filter = 'none';
  }
  for (const a of alphas) ctx.drawImage(rubyOf(a.canvas), 0, 0);
});

// ------------------------------------------------------------------ alpha channel operations
function nextAlphaName(doc: PixDocument) {
  let n = 1;
  while (doc.channels.some(c => c.name === `Alpha ${n}`)) n++;
  return `Alpha ${n}`;
}
const nextId = (doc: PixDocument) => Math.max(0, ...doc.channels.map(c => c.id)) + 1;

function saveSelection(doc: PixDocument) {
  if (doc.selection.empty) { newChannel(doc); return; }
  doc.history.transaction('Save Selection', () => { doc.channels = [...doc.channels, { id: nextId(doc), name: nextAlphaName(doc), canvas: cloneCanvas(doc.selection.mask!) }]; });
  panel?.schedule();
}
function newChannel(doc: PixDocument, name?: string) {
  doc.history.transaction('New Channel', () => { doc.channels = [...doc.channels, { id: nextId(doc), name: name || nextAlphaName(doc), canvas: createCanvas(doc.width, doc.height) }]; });
  panel?.schedule();
}
function deleteChannel(doc: PixDocument, c: AlphaChannel) {
  doc.history.transaction('Delete Channel', () => { doc.channels = doc.channels.filter(x => x !== c); });
  const s = stateOf(doc); s.sel.delete(aKey(c)); s.vis.delete(aKey(c));
  if (!s.sel.size) selectColor(doc, 'rgb'); else changed(doc);
}
function duplicateChannel(doc: PixDocument, c: AlphaChannel) {
  doc.history.transaction('Duplicate Channel', () => { doc.channels = [...doc.channels, { id: nextId(doc), name: `${c.name} copy`, canvas: cloneCanvas(c.canvas) }]; });
  panel?.schedule();
}
/** Channel as a selection canvas (alpha = value). Color channels use their brightness; 'rgb' uses luminosity. */
function channelSelection(doc: PixDocument, key: string): HTMLCanvasElement | null {
  if (key.startsWith('a')) return doc.channels.find(c => aKey(c) === key)?.canvas || null;
  if (key === 'qm') return doc.quickMask?.canvas || null;
  const comp = doc.getComposite(), W = doc.width, H = doc.height;
  const img = ctx2d(comp).getImageData(0, 0, W, H), d = img.data;
  const out = new ImageData(W, H), o = out.data;
  for (let i = 0; i < d.length; i += 4) {
    const a = d[i + 3] / 255;
    const v = key === 'r' ? d[i] : key === 'g' ? d[i + 1] : key === 'b' ? d[i + 2] : 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    o[i + 3] = v * a + 255 * (1 - a); // transparency counts as white
  }
  const c = createCanvas(W, H); ctx2d(c).putImageData(out, 0, 0);
  return c;
}
function loadChannel(doc: PixDocument, key: string, op: 'replace' | 'add' | 'subtract' | 'intersect' = 'replace') {
  const c = channelSelection(doc, key);
  if (!c) return;
  doc.history.transaction('Load Selection', () => doc.selection.apply(c, op));
}
async function channelOptions(doc: PixDocument, c: AlphaChannel) {
  let name = c.name;
  const body = h('div.form', null, h('div.form-row', null, h('label.form-label', null, 'Name:'), textField(name, v => { name = v; }, { width: 220, onInput: v => { name = v; } })));
  const ok = await openDialog({ title: 'Channel Options', body, layout: 'side' }).result;
  if (!ok || !name.trim() || name === c.name) return;
  doc.history.transaction('Channel Options', () => { doc.channels = doc.channels.map(x => (x === c ? { ...x, name: name.trim() } : x)); });
  panel?.schedule();
}
async function newChannelDialog(doc: PixDocument) {
  let name = nextAlphaName(doc);
  let opacity = 50;
  const body = h('div.form', null,
    h('div.form-row', null, h('label.form-label', null, 'Name:'), textField(name, v => { name = v; }, { width: 220, onInput: v => { name = v; } })),
    h('div.form-row', null, h('label.form-label', null, 'Opacity:'), numberField(opacity, v => { opacity = v; }, { min: 0, max: 100, unit: '%', width: 60 })),
    h('div.form-row', null, h('label.form-label'), h('span', { style: { color: 'var(--text-dim)' } }, 'Color indicates masked areas.')));
  const ok = await openDialog({ title: 'New Channel', body, layout: 'side' }).result;
  if (ok) newChannel(doc, name.trim() || undefined);
}

// ------------------------------------------------------------------ panel
class ChannelsPanel {
  list = h('div.chp-list');
  pending = false;
  thumbTimer = 0;
  thumbs = { rgb: h('canvas.chp-thumb') as HTMLCanvasElement, r: h('canvas.chp-thumb') as HTMLCanvasElement, g: h('canvas.chp-thumb') as HTMLCanvasElement, b: h('canvas.chp-thumb') as HTMLCanvasElement };
  alphaThumbs = new WeakMap<HTMLCanvasElement, HTMLCanvasElement>();
  renaming = false;

  constructor(el: HTMLElement) {
    const footer = h('div.panel-footer.chp-footer', null,
      iconButton('ch-load', 'Load channel as selection', e => { const d = app.activeDoc; if (!d) return; const k = this.primaryKey(d); if (k) loadChannel(d, k, opFromEvent(e as MouseEvent)); }),
      iconButton('ch-save', 'Save selection as channel', () => { const d = app.activeDoc; if (d) saveSelection(d); }),
      iconButton('new-layer', 'Create new channel', e => { const d = app.activeDoc; if (!d) return; if ((e as MouseEvent).altKey) newChannelDialog(d); else newChannel(d); }),
      iconButton('trash', 'Delete current channel', async () => {
        const d = app.activeDoc; if (!d) return;
        const c = this.selectedAlpha(d);
        if (!c) { toast('Only alpha channels can be deleted in an RGB document.'); return; }
        const r = await confirmDialog('Delete', `Delete channel "${c.name}"?`, [{ label: 'Yes', primary: true, value: 'ok' }, { label: 'No', value: 'cancel' }]);
        if (r === 'ok') deleteChannel(d, c);
      }),
    );
    this.list.addEventListener('contextmenu', e => { if (!(e.target as Element).closest('.chp-row')) contextMenu(e, this.menu()); });
    el.append(h('div.chp', null, this.list, footer));
    events.on('activeDoc', () => this.schedule());
    events.on('history', d => { if (d === app.activeDoc) this.schedule(); });
    events.on('layers', d => { if (d === app.activeDoc) this.scheduleThumbs(); });
    events.on('pixels', p => { if (p.doc === app.activeDoc) this.scheduleThumbs(); });
    events.on('selection', d => { if (d === app.activeDoc) this.schedule(); });
    events.on('docSize', d => { if (d === app.activeDoc) this.schedule(); });
    this.render();
  }
  schedule() { if (this.pending) return; this.pending = true; requestAnimationFrame(() => { this.pending = false; this.render(); }); }
  scheduleThumbs() { clearTimeout(this.thumbTimer); this.thumbTimer = window.setTimeout(() => this.colorThumbs(), 150); }

  primaryKey(doc: PixDocument): string | null {
    const s = stateOf(doc);
    const a = doc.channels.find(c => s.sel.has(aKey(c)));
    if (a) return aKey(a);
    if (s.sel.size === 3) return 'rgb';
    return [...s.sel][0] || null;
  }
  selectedAlpha(doc: PixDocument) { const s = stateOf(doc); return doc.channels.find(c => s.sel.has(aKey(c))) || null; }

  thumbSize(doc: PixDocument) { const T = 36, s = Math.min(T / doc.width, T / doc.height); return { w: Math.max(1, Math.round(doc.width * s)), h: Math.max(1, Math.round(doc.height * s)) }; }

  colorThumbs() {
    const doc = app.activeDoc;
    if (!doc) return;
    const { w, h: hh } = this.thumbSize(doc), k = Math.min(2, window.devicePixelRatio || 1);
    const W = Math.round(w * k), H = Math.round(hh * k);
    const small = createCanvas(W, H), sx = ctx2d(small);
    sx.fillStyle = '#fff'; sx.fillRect(0, 0, W, H);
    sx.imageSmoothingQuality = 'medium';
    sx.drawImage(doc.getComposite(), 0, 0, W, H);
    const img = sx.getImageData(0, 0, W, H), d = img.data;
    for (const key of ['rgb', 'r', 'g', 'b'] as const) {
      const c = this.thumbs[key];
      c.width = W; c.height = H; c.style.width = w + 'px'; c.style.height = hh + 'px';
      if (key === 'rgb') { ctx2d(c).drawImage(small, 0, 0); continue; }
      const o = new ImageData(W, H), od = o.data, off = key === 'r' ? 0 : key === 'g' ? 1 : 2;
      for (let i = 0; i < d.length; i += 4) { const v = d[i + off]; od[i] = od[i + 1] = od[i + 2] = v; od[i + 3] = 255; }
      ctx2d(c).putImageData(o, 0, 0);
    }
  }
  alphaThumb(doc: PixDocument, src: HTMLCanvasElement, live = false): HTMLCanvasElement {
    let c = live ? undefined : this.alphaThumbs.get(src);
    if (!c) {
      const { w, h: hh } = this.thumbSize(doc), k = Math.min(2, window.devicePixelRatio || 1);
      c = h('canvas.chp-thumb') as HTMLCanvasElement;
      c.width = Math.round(w * k); c.height = Math.round(hh * k); c.style.width = w + 'px'; c.style.height = hh + 'px';
      const x = ctx2d(c);
      x.fillStyle = '#000'; x.fillRect(0, 0, c.width, c.height);
      if (live) { const t = cloneCanvas(src), tx = ctx2d(t); tx.globalCompositeOperation = 'source-in'; tx.fillStyle = '#fff'; tx.fillRect(0, 0, t.width, t.height); x.drawImage(t, 0, 0, c.width, c.height); }
      else { x.drawImage(whiteOf(src), 0, 0, c.width, c.height); this.alphaThumbs.set(src, c); }
    }
    return c;
  }

  row(opts: { key: string; name: string; sc?: string; thumb: HTMLCanvasElement; selected: boolean; visible: boolean; cls?: string; onClick(e: MouseEvent): void; onEye(): void; onCtrl?(e: MouseEvent): void; onDbl?(): void; menu?(): MenuEntry[] }) {
    const eye = h('div.chp-eye', { title: 'Toggle channel visibility' }, opts.visible ? icon('eye', 16) : null);
    eye.addEventListener('pointerdown', e => { e.preventDefault(); opts.onEye(); });
    const name = h('span.chp-name', { class: opts.cls || '' }, opts.name);
    const main = h('div.chp-main', null, opts.thumb, name, opts.sc ? h('span.chp-sc', null, opts.sc) : null);
    main.addEventListener('pointerdown', e => {
      if (e.button !== 0) return;
      if ((e.ctrlKey || e.metaKey) && opts.onCtrl) { opts.onCtrl(e); return; }
      opts.onClick(e);
    });
    if (opts.onDbl) name.addEventListener('dblclick', () => opts.onDbl!());
    if (opts.menu) main.addEventListener('contextmenu', e => contextMenu(e, opts.menu!()));
    return h('div.chp-row', { class: opts.selected ? 'selected' : '', dataset: { key: opts.key } }, eye, main);
  }

  render() {
    const doc = app.activeDoc;
    if (this.renaming) return;
    if (!doc) { this.list.replaceChildren(); return; }
    const s = stateOf(doc);
    // drop state of deleted channels
    for (const k of [...s.sel, ...s.vis]) if (k.startsWith('a') && !doc.channels.some(c => aKey(c) === k)) { s.sel.delete(k); s.vis.delete(k); }
    if (!s.sel.size) { s.sel = new Set(['r', 'g', 'b']); s.vis = new Set(['r', 'g', 'b']); }
    this.colorThumbs();
    const rows: HTMLElement[] = [];
    const allColorSel = ['r', 'g', 'b'].every(k => s.sel.has(k));
    rows.push(this.row({
      key: 'rgb', name: 'RGB', sc: 'Ctrl+2', thumb: this.thumbs.rgb, selected: allColorSel, visible: ['r', 'g', 'b'].every(k => s.vis.has(k)),
      onClick: () => selectColor(doc, 'rgb'), onEye: () => toggleVis(doc, 'rgb'), onCtrl: e => loadChannel(doc, 'rgb', opFromEvent(e)),
      menu: () => this.menu(),
    }));
    for (const [k, label, sc] of COLORS) {
      rows.push(this.row({
        key: k, name: label, sc, thumb: this.thumbs[k], selected: s.sel.has(k), visible: s.vis.has(k),
        onClick: e => selectColor(doc, k, e.shiftKey), onEye: () => toggleVis(doc, k), onCtrl: e => loadChannel(doc, k, opFromEvent(e)),
        menu: () => this.menu(),
      }));
    }
    if (doc.quickMask) {
      const qm = doc.quickMask;
      rows.push(this.row({
        key: 'qm', name: 'Quick Mask', cls: 'qm', thumb: this.alphaThumb(doc, qm.canvas, true), selected: true, visible: true,
        onClick: () => {}, onEye: () => {}, onCtrl: e => loadChannel(doc, 'qm', opFromEvent(e)),
      }));
    }
    doc.channels.forEach((c, i) => {
      rows.push(this.row({
        key: aKey(c), name: c.name, sc: i < 4 ? `Ctrl+${6 + i}` : undefined, thumb: this.alphaThumb(doc, c.canvas), selected: s.sel.has(aKey(c)), visible: s.vis.has(aKey(c)),
        onClick: e => selectAlpha(doc, c, e.shiftKey), onEye: () => toggleVis(doc, aKey(c)), onCtrl: e => loadChannel(doc, aKey(c), opFromEvent(e)),
        onDbl: () => this.rename(doc, c),
        menu: () => [
          { label: 'Duplicate Channel...', action: () => duplicateChannel(doc, c) },
          { label: 'Delete Channel', action: () => deleteChannel(doc, c) }, '-',
          { label: 'Channel Options...', action: () => channelOptions(doc, c) },
          { label: 'Load as Selection', action: () => loadChannel(doc, aKey(c)) },
        ],
      }));
    });
    this.list.replaceChildren(...rows);
  }

  rename(doc: PixDocument, c: AlphaChannel) {
    const row = this.list.querySelector<HTMLElement>(`.chp-row[data-key="${aKey(c)}"]`);
    const name = row?.querySelector('.chp-name');
    if (!name) return;
    this.renaming = true;
    const inp = h('input.field.chp-rename', { type: 'text', value: c.name }) as HTMLInputElement;
    name.replaceWith(inp); inp.focus(); inp.select();
    let done = false;
    const finish = (ok: boolean) => {
      if (done) return; done = true; this.renaming = false;
      const v = inp.value.trim();
      if (ok && v && v !== c.name) doc.history.transaction('Rename Channel', () => { doc.channels = doc.channels.map(x => (x === c ? { ...x, name: v } : x)); });
      this.render();
    };
    inp.addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Enter') finish(true); else if (e.key === 'Escape') finish(false); });
    inp.addEventListener('blur', () => finish(true));
    inp.addEventListener('pointerdown', e => e.stopPropagation());
  }

  menu(): MenuEntry[] {
    const doc = app.activeDoc;
    const a = doc ? this.selectedAlpha(doc) : null;
    return [
      { label: 'New Channel...', enabled: !!doc, action: () => doc && newChannelDialog(doc) },
      { label: 'Duplicate Channel...', enabled: !!a, action: () => doc && a && duplicateChannel(doc, a) },
      { label: 'Delete Channel', enabled: !!a, action: () => doc && a && deleteChannel(doc, a) }, '-',
      { label: 'Channel Options...', enabled: !!a, action: () => doc && a && channelOptions(doc, a) }, '-',
      { label: 'Save Selection as Channel', enabled: !!doc && !doc.selection.empty, action: () => doc && saveSelection(doc) },
      { label: 'Load Channel as Selection', enabled: !!doc, action: () => { if (!doc) return; const k = this.primaryKey(doc); if (k) loadChannel(doc, k); } },
    ];
  }
}

let panel: ChannelsPanel | null = null;
registerPanel({
  id: 'channels', title: 'Channels', icon: 'channels', minHeight: 140,
  create(el) { panel = new ChannelsPanel(el); const p = panel; return { onShow: () => p.render() }; },
  menu: () => panel?.menu() ?? [],
});

// Ctrl+2 … Ctrl+9 channel shortcuts (Ctrl+Alt+2… loads as selection)
const D = () => app.activeDoc;
registerCommands([
  { id: 'channel.rgb', label: 'RGB', shortcut: 'Ctrl+2', run: () => { const d = D(); if (d) selectColor(d, 'rgb'); }, enabled: () => !!D() },
  { id: 'channel.red', label: 'Red', shortcut: 'Ctrl+3', run: () => { const d = D(); if (d) selectColor(d, 'r'); }, enabled: () => !!D() },
  { id: 'channel.green', label: 'Green', shortcut: 'Ctrl+4', run: () => { const d = D(); if (d) selectColor(d, 'g'); }, enabled: () => !!D() },
  { id: 'channel.blue', label: 'Blue', shortcut: 'Ctrl+5', run: () => { const d = D(); if (d) selectColor(d, 'b'); }, enabled: () => !!D() },
  ...[0, 1, 2, 3].map(i => ({ id: `channel.alpha${i + 1}`, label: `Alpha channel ${i + 1}`, shortcut: `Ctrl+${6 + i}`, run: () => { const d = D(); const c = d?.channels[i]; if (d && c) selectAlpha(d, c); }, enabled: () => !!D()?.channels[i] })),
  { id: 'channel.loadLuminosity', label: 'Load Luminosity', shortcut: 'Ctrl+Alt+2', run: () => { const d = D(); if (d) loadChannel(d, 'rgb'); }, enabled: () => !!D() },
  { id: 'channel.new', label: 'New Channel', run: () => { const d = D(); if (d) newChannel(d); }, enabled: () => !!D() },
  { id: 'channel.saveSelection', label: 'Save Selection as Channel', run: () => { const d = D(); if (d) saveSelection(d); }, enabled: () => !!D() && !D()!.selection.empty },
  { id: 'channel.load', label: 'Load Channel as Selection', run: (arg?: { key: string; op?: 'replace' | 'add' | 'subtract' | 'intersect' }) => { const d = D(); if (d && arg?.key) loadChannel(d, arg.key, arg.op); }, enabled: () => !!D() },
]);
// switching documents / closing: nothing to clean (state is per-document WeakMap)
