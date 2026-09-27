// Window › Arrange: Tile All Vertically / Horizontally, 2-up, Consolidate All to Tabs, Float in Window, Float All
// in Windows, Match Zoom / Location / Rotation / All, New Window for <document>.
// The active document is always shown in the live (editable) viewport; the other documents — and extra windows of
// the same document — are shown in document panes with their own zoom / pan. Clicking a pane activates it.
import { app } from '../../core/app';
import type { PixDocument } from '../../core/document';
import { events } from '../../core/events';
import { registerCommands } from '../../core/commands';
import { h, dragPointer } from '../../ui/dom';
import { icon } from '../../ui/icons';
import { checkerPattern } from '../../core/canvas';

type Mode = 'tabs' | 'tile-v' | 'tile-h' | '2up-v' | '2up-h' | 'float' | 'float-all';
interface PaneView { zoom: number; panX: number; panY: number; rotation: number; fitted: boolean }
interface Pane { doc: PixDocument; el: HTMLElement; canvas: HTMLCanvasElement; view: PaneView; extra: boolean; ro: ResizeObserver; frame?: Frame }
interface Frame { x: number; y: number; w: number; h: number }

let mode: Mode = 'tabs';
let panes: Pane[] = [];
const extraWindows: PixDocument[] = [];          // "New Window for" entries (same document, own view)
let mainFrame: Frame | null = null;
const savedViews = new WeakMap<PixDocument, PaneView>();
let raf = 0;

const work = () => document.querySelector('.work') as HTMLElement | null;
const main = () => document.querySelector('.canvas-main') as HTMLElement | null;
let host: HTMLElement | null = null;
function ensureHost() {
  const w = work(), m = main();
  if (!w || !m) return null;
  if (!host) { host = h('div.arr-host'); m.after(host); }
  return host;
}

// ------------------------------------------------------------------ pane rendering
function fitView(p: Pane) {
  const r = p.canvas.getBoundingClientRect(), W = Math.max(1, r.width), H = Math.max(1, r.height - 0);
  const z = Math.min(W / p.doc.width, H / p.doc.height) * 0.92;
  p.view = { ...p.view, zoom: z, panX: (W - p.doc.width * z) / 2, panY: (H - p.doc.height * z) / 2, fitted: true };
}
function drawPane(p: Pane) {
  const c = p.canvas, dpr = window.devicePixelRatio || 1, r = c.getBoundingClientRect();
  const W = Math.max(1, Math.round(r.width * dpr)), H = Math.max(1, Math.round(r.height * dpr));
  if (c.width !== W || c.height !== H) { c.width = W; c.height = H; if (p.view.fitted) fitView(p); }
  const x = c.getContext('2d')!;
  x.setTransform(1, 0, 0, 1, 0, 0);
  x.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--pasteboard').trim() || '#282828';
  x.fillRect(0, 0, W, H);
  const v = p.view, d = p.doc;
  x.setTransform(dpr, 0, 0, dpr, 0, 0);
  const cx = r.width / 2, cy = r.height / 2;
  x.translate(cx, cy); x.rotate((v.rotation * Math.PI) / 180); x.translate(-cx, -cy);
  x.translate(v.panX, v.panY); x.scale(v.zoom, v.zoom);
  x.save(); x.shadowColor = 'rgba(0,0,0,.45)'; x.shadowBlur = 10; x.fillStyle = '#fff'; x.fillRect(0, 0, d.width, d.height); x.restore();
  const pat = checkerPattern(x, app.prefs.checkerSize || 8);
  pat.setTransform(new DOMMatrix().scale(1 / v.zoom, 1 / v.zoom));
  x.fillStyle = pat; x.fillRect(0, 0, d.width, d.height);
  x.imageSmoothingEnabled = v.zoom < 1; x.imageSmoothingQuality = 'high';
  x.drawImage(d.getComposite(), 0, 0);
  const t = p.el.querySelector('.arr-title span');
  if (t) t.textContent = `${d.name} @ ${Math.round(v.zoom * 1000) / 10}%${p.extra ? ' (2)' : ''}`;
}
function redrawAll() { if (!raf) raf = requestAnimationFrame(() => { raf = 0; panes.forEach(drawPane); }); }

function makePane(doc: PixDocument, extra: boolean): Pane {
  const canvas = h('canvas.arr-canvas') as HTMLCanvasElement;
  const close = h('button.arr-close', { type: 'button', title: extra ? 'Close this window' : `Close ${doc.name}` }, icon('close', 10));
  const title = h('div.arr-title', { title: 'Click to make this the active document; drag to move the window (floating)' }, h('span', null, doc.name), close);
  const el = h('div.arr-pane', null, title, canvas);
  const p: Pane = { doc, el, canvas, view: { zoom: 1, panX: 0, panY: 0, rotation: doc.view.rotation, fitted: true }, extra, ro: new ResizeObserver(() => redrawAll()) };
  p.ro.observe(canvas);
  close.addEventListener('click', e => {
    e.stopPropagation();
    if (extra) { const i = extraWindows.indexOf(doc); if (i >= 0) extraWindows.splice(i, 1); rebuild(); return; }
    import('../file/commands').then(m => m.closeDocument(doc));
  });
  // pan (drag) / zoom (wheel) / activate (click)
  canvas.addEventListener('pointerdown', e => {
    if (e.button !== 0 && e.button !== 1) return;
    const v0 = { ...p.view };
    let moved = false;
    dragPointer(e, (dx, dy) => { if (Math.abs(dx) + Math.abs(dy) > 3) moved = true; p.view = { ...v0, panX: v0.panX + dx, panY: v0.panY + dy, fitted: false }; drawPane(p); }, () => { if (!moved) activate(p); });
  });
  canvas.addEventListener('wheel', e => {
    e.preventDefault();
    const r = canvas.getBoundingClientRect(), sx = e.clientX - r.left, sy = e.clientY - r.top, v = p.view;
    const z = Math.max(0.01, Math.min(64, v.zoom * (e.deltaY < 0 ? 1.2 : 1 / 1.2))), ix = (sx - v.panX) / v.zoom, iy = (sy - v.panY) / v.zoom;
    p.view = { ...v, zoom: z, panX: sx - ix * z, panY: sy - iy * z, fitted: false };
    drawPane(p);
  }, { passive: false });
  canvas.addEventListener('dblclick', () => { fitView(p); drawPane(p); });
  if (mode === 'float-all' || mode === 'float') makeFloating(p, title);
  return p;
}
function activate(p: Pane) {
  if (p.extra) return;                                    // extra window of the active document: just a second view
  if (app.activeDoc === p.doc) return;
  app.setActiveDocument(p.doc);
}

// ------------------------------------------------------------------ floating frames
function makeFloating(p: Pane, title: HTMLElement) {
  const w = work()!, wr = w.getBoundingClientRect(), i = panes.length + 1;
  p.frame = p.frame || { x: 40 + i * 28, y: 60 + i * 28, w: Math.min(520, wr.width * 0.45), h: Math.min(400, wr.height * 0.5) };
  const place = () => { const f = p.frame!; Object.assign(p.el.style, { left: f.x + 'px', top: f.y + 'px', width: f.w + 'px', height: f.h + 'px' }); };
  place();
  p.el.addEventListener('pointerdown', () => { panes.forEach(q => q.el.classList.toggle('arr-front', q === p)); }, true);
  title.addEventListener('pointerdown', e => {
    if ((e.target as Element).closest('button')) return;
    const f0 = { ...p.frame! };
    let moved = false;
    dragPointer(e, (dx, dy) => { moved = true; p.frame = { ...f0, x: f0.x + dx, y: Math.max(0, f0.y + dy) }; place(); }, () => { if (!moved) activate(p); });
  });
  const grip = h('div.arr-grip', { title: 'Resize' });
  p.el.append(grip);
  grip.addEventListener('pointerdown', e => { e.stopPropagation(); const f0 = { ...p.frame! }; dragPointer(e, (dx, dy) => { p.frame = { ...f0, w: Math.max(200, f0.w + dx), h: Math.max(140, f0.h + dy) }; place(); }); });
}
function floatMain(on: boolean) {
  const w = work(), m = main();
  if (!w || !m) return;
  let bar = w.querySelector('.arr-mainbar') as HTMLElement | null;
  if (!on) { m.removeAttribute('style'); bar?.remove(); w.querySelector('.arr-maingrip')?.remove(); return; }
  const wr = w.getBoundingClientRect();
  mainFrame = mainFrame || { x: 24, y: 58, w: Math.round(wr.width * 0.62), h: Math.round(wr.height * 0.72) };
  if (!bar) {
    bar = h('div.arr-mainbar', { title: 'Drag to move the document window' }, h('span'));
    w.append(bar);
    bar.addEventListener('pointerdown', e => { const f0 = { ...mainFrame! }; dragPointer(e, (dx, dy) => { mainFrame = { ...f0, x: f0.x + dx, y: Math.max(30, f0.y + dy) }; placeMain(); }); });
    const grip = h('div.arr-grip.arr-maingrip', { title: 'Resize' });
    w.append(grip);
    grip.addEventListener('pointerdown', e => { const f0 = { ...mainFrame! }; dragPointer(e, (dx, dy) => { mainFrame = { ...f0, w: Math.max(260, f0.w + dx), h: Math.max(180, f0.h + dy) }; placeMain(); }); });
  }
  placeMain();
}
function placeMain() {
  const w = work(), m = main(), f = mainFrame;
  if (!w || !m || !f || (mode !== 'float' && mode !== 'float-all')) return;
  Object.assign(m.style, { position: 'absolute', left: f.x + 'px', top: f.y + 'px', width: f.w + 'px', height: f.h + 'px', zIndex: '3' });
  const bar = w.querySelector('.arr-mainbar') as HTMLElement | null, grip = w.querySelector('.arr-maingrip') as HTMLElement | null;
  if (bar) { Object.assign(bar.style, { left: f.x + 'px', top: f.y - 22 + 'px', width: f.w + 'px' }); (bar.firstChild as HTMLElement).textContent = app.activeDoc ? `${app.activeDoc.name} @ ${Math.round(app.activeDoc.view.zoom * 1000) / 10}%` : ''; }
  if (grip) Object.assign(grip.style, { left: f.x + f.w - 12 + 'px', top: f.y + f.h - 12 + 'px' });
}

// ------------------------------------------------------------------ layout
function rebuild() {
  const w = work(), m = main(), hst = ensureHost();
  if (!w || !m || !hst) return;
  for (const p of panes) { if (!p.extra) savedViews.set(p.doc, { ...p.view }); p.ro.disconnect(); p.el.remove(); }
  panes = [];
  w.classList.remove('arr-tiled', 'arr-floating');
  w.removeAttribute('data-arr');
  for (const el of [w, m, w.querySelector('.statusbar') as HTMLElement | null]) if (el) { el.style.gridTemplateColumns = ''; el.style.gridTemplateRows = ''; el.style.gridColumn = ''; el.style.gridRow = ''; }
  const others = app.docs.filter(d => d !== app.activeDoc);
  const docsInPanes: { doc: PixDocument; extra: boolean }[] = [
    ...extraWindows.filter(d => app.docs.includes(d)).map(d => ({ doc: d, extra: true })),
    ...(mode === '2up-v' || mode === '2up-h' ? others.slice(0, 1) : mode === 'float' ? [] : others).map(d => ({ doc: d, extra: false })),
  ];
  const tiled = mode === 'tile-v' || mode === 'tile-h' || mode === '2up-v' || mode === '2up-h';
  const floating = mode === 'float' || mode === 'float-all';
  floatMain(floating);
  if (mode === 'tabs' && !extraWindows.length) { hst.style.display = 'none'; app.viewport?.requestRender(); return; }
  hst.style.display = '';
  if (tiled || (mode === 'tabs' && extraWindows.length)) {
    w.classList.add('arr-tiled');
    w.dataset.arr = mode === 'tile-h' || mode === '2up-h' ? 'h' : 'v';
  } else if (floating) w.classList.add('arr-floating');
  for (const it of docsInPanes) { const p = makePane(it.doc, it.extra); const sv = !it.extra && savedViews.get(it.doc); if (sv) p.view = { ...sv }; panes.push(p); hst.append(p.el); }
  if (w.classList.contains('arr-tiled')) {
    // every document gets an equal column (vertical tiling) or row (horizontal tiling)
    const n = panes.length + 1, st = w.querySelector('.statusbar') as HTMLElement | null;
    if (w.dataset.arr === 'v') {
      w.style.gridTemplateColumns = `repeat(${n}, minmax(0, 1fr))`;
      m.style.gridColumn = '1'; m.style.gridRow = '2';
      panes.forEach((p, i) => { p.el.style.gridColumn = String(i + 2); p.el.style.gridRow = '2'; });
    } else {
      w.style.gridTemplateRows = `auto repeat(${n}, minmax(0, 1fr)) auto`;
      m.style.gridRow = '2';
      panes.forEach((p, i) => { p.el.style.gridRow = String(i + 3); p.el.style.gridColumn = '1'; });
      if (st) st.style.gridRow = String(n + 2);
    }
  }
  requestAnimationFrame(() => { panes.forEach(p => { if (p.view.fitted) fitView(p); drawPane(p); }); app.viewport?.requestRender(); });
}
function arrange(m: Mode) {
  if ((m === 'tile-v' || m === 'tile-h' || m === '2up-v' || m === '2up-h' || m === 'float-all') && app.docs.length < 2 && !extraWindows.length) {
    mode = m === 'float-all' ? 'float' : 'tabs';
  } else mode = m;
  if (m === 'tabs') extraWindows.length = 0;
  rebuild();
}

// ------------------------------------------------------------------ match
function viewCenter(): { u: number; v: number } | null {
  const vp = app.viewport, d = app.activeDoc;
  if (!vp || !d) return null;
  const c = vp.screenToDoc(vp.width / 2, vp.height / 2);
  return { u: c.x / d.width, v: c.y / d.height };
}
function match(what: 'zoom' | 'location' | 'rotation' | 'all') {
  const src = app.activeDoc, vp = app.viewport;
  if (!src || !vp) return;
  const z = src.view.zoom, rot = src.view.rotation, c = viewCenter();
  const apply = (doc: PixDocument, v: { zoom: number; panX: number; panY: number; rotation: number; fitted: boolean }, W: number, H: number) => {
    const cur = { u: (W / 2 - v.panX) / v.zoom / doc.width, v: (H / 2 - v.panY) / v.zoom / doc.height };
    const nz = what === 'zoom' || what === 'all' ? z : v.zoom;
    const cc = (what === 'location' || what === 'all') && c ? c : cur;
    v.zoom = nz; v.panX = W / 2 - cc.u * doc.width * nz; v.panY = H / 2 - cc.v * doc.height * nz; v.fitted = false;
    if (what === 'rotation' || what === 'all') v.rotation = rot;
  };
  for (const d of app.docs) if (d !== src) apply(d, d.view, vp.width, vp.height);
  for (const p of panes) { const r = p.canvas.getBoundingClientRect(); apply(p.doc, p.view, r.width, r.height); }
  redrawAll();
}

registerCommands([
  { id: 'window.arrange', label: 'Arrange', enabled: () => app.docs.length > 0, checked: (a?: string) => a === mode, run: (a: Mode) => arrange(a) },
  { id: 'window.match', label: 'Match', enabled: () => app.docs.length > 1 || panes.length > 0, run: (a: 'zoom' | 'location' | 'rotation' | 'all') => match(a) },
  {
    id: 'window.newWindow', label: 'New Window', enabled: () => !!app.activeDoc,
    run: () => { const d = app.activeDoc; if (!d) return; extraWindows.push(d); if (mode === 'tabs') mode = 'tile-v'; rebuild(); },
  },
]);
// keep panes in sync with the documents
events.on('activeDoc', () => { if (mode !== 'tabs' || extraWindows.length) rebuild(); placeMain(); });
events.on('docs', () => { for (let i = extraWindows.length - 1; i >= 0; i--) if (!app.docs.includes(extraWindows[i])) extraWindows.splice(i, 1); if (mode !== 'tabs' || panes.length) rebuild(); });
events.on('pixels', (e: any) => { if (panes.some(p => p.doc === e?.doc)) redrawAll(); });
for (const ev of ['layers', 'history', 'docSize'] as const) events.on(ev as any, () => { if (panes.length) redrawAll(); });
events.on('view', () => placeMain());
events.on('theme', () => redrawAll());
(window as any).__pxArrange = { get mode() { return mode; }, get panes() { return panes; }, arrange, match };
