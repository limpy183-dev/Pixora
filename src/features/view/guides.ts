// Guides (drag out of the rulers, move / delete with the Move tool, lock, clear, New Guide, New Guide Layout,
// New Guides From Shape), the document grid, snapping (guides / grid / layers / document bounds) and smart guides.
import './view.css';
import { app } from '../../core/app';
import type { Guide, PixDocument } from '../../core/document';
import { events } from '../../core/events';
import { hooks } from '../../core/registry';
import { registerCommands } from '../../core/commands';
import { setViewOption, viewOptions, viewportHooks, type Viewport } from '../../core/viewport';
import type { Layer } from '../../core/layer';
import type { Rect } from '../../core/types';
import { h } from '../../ui/dom';
import { openDialog } from '../../ui/dialog';
import { checkbox, colorSwatch, numberField, select } from '../../ui/widgets';
import { toast } from '../../ui/toast';
import { workspaceHooks, unitScale } from '../../ui/workspace';
import { pathBounds, type VectorPath } from '../../core/path';
import { fromHex, toHex } from '../../core/color';
import { xp } from '../prefs/store';

const SNAP_PX = 8;               // snapping distance in screen pixels
let nextGuideId = 1;
const newId = (doc: PixDocument) => Math.max(nextGuideId++, ...doc.guides.map(g => g.id + 1));
const visible = () => viewOptions.extras && viewOptions.guides;
const guideColor = () => app.prefs.guideColor || '#4affff';

/** Replace the guides as one undoable step. */
export function setGuides(doc: PixDocument, name: string, guides: Guide[]) {
  doc.history.transaction(name, () => { doc.guides = guides; }, 'guide');
  events.emit('guides', doc);
  doc.redrawOverlay();
}

// ------------------------------------------------------------------ drawing: guides, grid, smart guides, layer edges
let live: { orientation: 'h' | 'v'; pos: number; id: number } | null = null;     // guide being dragged
let smart: { x?: number[]; y?: number[]; box?: Rect[] } | null = null;
function lineAcross(ctx: CanvasRenderingContext2D, view: Viewport, o: 'h' | 'v', pos: number) {
  const a = o === 'h' ? view.docToScreen(-1e5, pos) : view.docToScreen(pos, -1e5), b = o === 'h' ? view.docToScreen(1e5, pos) : view.docToScreen(pos, 1e5);
  ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y);
}
viewportHooks.overlay.push((ctx, view, doc) => {
  if (visible()) {
    ctx.save();
    ctx.lineWidth = 1;
    ctx.strokeStyle = guideColor();
    ctx.setLineDash(xp.guideStyle === 'dashed' ? [4, 3] : []);
    ctx.beginPath();
    for (const g of doc.guides) { if (live && g.id === live.id) continue; lineAcross(ctx, view, g.orientation, g.pos); }
    ctx.stroke();
    if (live) { ctx.strokeStyle = guideColor(); ctx.setLineDash([4, 3]); ctx.beginPath(); lineAcross(ctx, view, live.orientation, live.pos); ctx.stroke(); }
    ctx.restore();
  }
  if (smart && viewOptions.extras && viewOptions.smartGuides) {
    ctx.save();
    ctx.strokeStyle = app.prefs.smartGuideColor || '#ff4aff';
    ctx.lineWidth = 1;
    ctx.beginPath();
    const r = doc ? { x: 0, y: 0, w: doc.width, h: doc.height } : null;
    for (const x of smart.x || []) { const a = view.docToScreen(x, (r?.y ?? 0) - 20), b = view.docToScreen(x, (r ? r.y + r.h : 0) + 20); ctx.moveTo(Math.round(a.x) + 0.5, a.y); ctx.lineTo(Math.round(b.x) + 0.5, b.y); }
    for (const y of smart.y || []) { const a = view.docToScreen((r?.x ?? 0) - 20, y), b = view.docToScreen((r ? r.x + r.w : 0) + 20, y); ctx.moveTo(a.x, Math.round(a.y) + 0.5); ctx.lineTo(b.x, Math.round(b.y) + 0.5); }
    ctx.stroke();
    ctx.restore();
  }
  if (viewOptions.extras && viewOptions.layerEdges) {
    ctx.save();
    ctx.strokeStyle = '#1e8bff'; ctx.lineWidth = 1;
    for (const l of doc.selectedLayers) {
      const b = doc.layerBounds(l);
      if (!b) continue;
      const p = [view.docToScreen(b.x, b.y), view.docToScreen(b.x + b.w, b.y), view.docToScreen(b.x + b.w, b.y + b.h), view.docToScreen(b.x, b.y + b.h)];
      ctx.beginPath(); p.forEach((q, i) => (i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y))); ctx.closePath(); ctx.stroke();
    }
    ctx.restore();
  }
});
// grid: drawn on the main canvas over the image (below overlays, like Photoshop)
viewportHooks.afterComposite.push((ctx, view, doc) => {
  if (!viewOptions.extras || !viewOptions.grid) return;
  const step = Math.max(1, app.prefs.gridSpacing || 100) * gridUnitPx(doc), sub = Math.max(1, app.prefs.gridSubdivisions || 1);
  const z = view.zoom;
  const col = fromHex(app.prefs.gridColor) || { r: 158, g: 158, b: 158 };
  const tl = view.screenToDoc(0, 0), br = view.screenToDoc(view.width, view.height), tr = view.screenToDoc(view.width, 0), bl = view.screenToDoc(0, view.height);
  const x0 = Math.min(tl.x, br.x, tr.x, bl.x), x1 = Math.max(tl.x, br.x, tr.x, bl.x), y0 = Math.min(tl.y, br.y, tr.y, bl.y), y1 = Math.max(tl.y, br.y, tr.y, bl.y);
  const X0 = Math.max(0, x0), X1 = Math.min(doc.width, x1), Y0 = Math.max(0, y0), Y1 = Math.min(doc.height, y1);
  if (X1 <= X0 || Y1 <= Y0) return;
  view.applyDocTransform(ctx);
  ctx.lineWidth = 1 / z;
  const draw = (s: number, alpha: number, dash: boolean) => {
    if (s * z < 4) return;
    ctx.strokeStyle = `rgba(${col.r},${col.g},${col.b},${alpha})`;
    if (xp.gridStyle === 'dots') {                  // Preferences › Guides, Grid & Slices › Style: Dots
      ctx.fillStyle = ctx.strokeStyle;
      const d = 1.5 / z;
      for (let x = Math.ceil(X0 / s) * s; x <= X1; x += s) for (let y = Math.ceil(Y0 / s) * s; y <= Y1; y += s) ctx.fillRect(x - d / 2, y - d / 2, d, d);
      return;
    }
    ctx.setLineDash(dash || xp.gridStyle === 'dashed' ? [3 / z, 3 / z] : []);
    ctx.beginPath();
    for (let x = Math.ceil(X0 / s) * s; x <= X1; x += s) { ctx.moveTo(x, Y0); ctx.lineTo(x, Y1); }
    for (let y = Math.ceil(Y0 / s) * s; y <= Y1; y += s) { ctx.moveTo(X0, y); ctx.lineTo(X1, y); }
    ctx.stroke();
  };
  if (sub > 1) draw(step / sub, 0.45, true);
  draw(step, 0.9, false);
});
/** Grid spacing is stored in ruler units when the ruler shows physical units. */
function gridUnitPx(doc: PixDocument) { return app.prefs.rulerUnits === 'px' ? 1 : unitScale(doc).pxPerUnit; }

// ------------------------------------------------------------------ snapping
interface SnapTargets { xs: { v: number; kind: string }[]; ys: { v: number; kind: string }[] }
function targets(doc: PixDocument, exclude: Layer[] = []): SnapTargets {
  const xs: SnapTargets['xs'] = [], ys: SnapTargets['ys'] = [];
  if (viewOptions.snapGuides && visible()) for (const g of doc.guides) (g.orientation === 'v' ? xs : ys).push({ v: g.pos, kind: 'guide' });
  if (viewOptions.snapBounds) { xs.push({ v: 0, kind: 'bounds' }, { v: doc.width / 2, kind: 'bounds' }, { v: doc.width, kind: 'bounds' }); ys.push({ v: 0, kind: 'bounds' }, { v: doc.height / 2, kind: 'bounds' }, { v: doc.height, kind: 'bounds' }); }
  if (viewOptions.snapLayers) {
    const ex = new Set<number>();
    const add = (l: Layer) => { ex.add(l.id); (l as any).children?.forEach(add); };
    exclude.forEach(add);
    for (const l of doc.allLayers()) {
      if (ex.has(l.id) || !l.visible || l.isBackground || (l as any).children) continue;
      const b = doc.layerBounds(l);
      if (!b) continue;
      xs.push({ v: b.x, kind: 'layer' }, { v: b.x + b.w / 2, kind: 'layer' }, { v: b.x + b.w, kind: 'layer' });
      ys.push({ v: b.y, kind: 'layer' }, { v: b.y + b.h / 2, kind: 'layer' }, { v: b.y + b.h, kind: 'layer' });
    }
  }
  return { xs, ys };
}
function gridSnap(v: number, doc: PixDocument): number | null {
  if (!viewOptions.snapGrid || !viewOptions.grid || !viewOptions.extras) return null;
  const s = (Math.max(1, app.prefs.gridSpacing || 100) * gridUnitPx(doc)) / Math.max(1, app.prefs.gridSubdivisions || 1);
  return Math.round(v / s) * s;
}
const snapOn = () => viewOptions.snap;
let smartTimer = 0;
function showSmart(s: typeof smart) {
  smart = s && ((s.x?.length || 0) + (s.y?.length || 0)) ? s : null;
  clearTimeout(smartTimer);
  smartTimer = window.setTimeout(() => { smart = null; app.activeDoc?.redrawOverlay(); }, 900);
}
hooks.snapRect = (r, doc, exclude) => {
  if (!snapOn()) { showSmart(null); return { dx: 0, dy: 0 }; }
  const tol = SNAP_PX / (app.viewport?.zoom || 1);
  const T = targets(doc, exclude);
  const cand = (edges: number[], list: SnapTargets['xs'], axisGrid: boolean) => {
    let best: { d: number; v: number; kind: string } | null = null;
    for (const e of edges) {
      for (const t of list) { const d = t.v - e; if (Math.abs(d) <= tol && (!best || Math.abs(d) < Math.abs(best.d))) best = { d, v: t.v, kind: t.kind }; }
      if (axisGrid) { const g = gridSnap(e, doc); if (g !== null && Math.abs(g - e) <= tol && (!best || Math.abs(g - e) < Math.abs(best.d))) best = { d: g - e, v: g, kind: 'grid' }; }
    }
    return best;
  };
  const bx = cand([r.x, r.x + r.w / 2, r.x + r.w], T.xs, true), by = cand([r.y, r.y + r.h / 2, r.y + r.h], T.ys, true);
  const dx = bx?.d ?? 0, dy = by?.d ?? 0;
  // smart guides: every alignment of the snapped rect with layers / canvas
  const nr = { x: r.x + dx, y: r.y + dy, w: r.w, h: r.h };
  const sx = T.xs.filter(t => t.kind !== 'guide' && [nr.x, nr.x + nr.w / 2, nr.x + nr.w].some(e => Math.abs(e - t.v) < 0.5)).map(t => t.v);
  const sy = T.ys.filter(t => t.kind !== 'guide' && [nr.y, nr.y + nr.h / 2, nr.y + nr.h].some(e => Math.abs(e - t.v) < 0.5)).map(t => t.v);
  showSmart({ x: [...new Set(sx)], y: [...new Set(sy)] });
  return { dx, dy };
};
hooks.snapPoint = (p, doc) => {
  if (!snapOn()) return p;
  const tol = SNAP_PX / (app.viewport?.zoom || 1), T = targets(doc);
  const one = (v: number, list: SnapTargets['xs']) => {
    let best = v, bd = tol;
    for (const t of list) { const d = Math.abs(t.v - v); if (d <= bd) { bd = d; best = t.v; } }
    const g = gridSnap(v, doc);
    if (g !== null && Math.abs(g - v) <= bd) best = g;
    return best;
  };
  return { x: one(p.x, T.xs), y: one(p.y, T.ys) };
};
window.addEventListener('pointerup', () => { if (smart) { smart = null; app.activeDoc?.redrawOverlay(); } });

// ------------------------------------------------------------------ interaction: drag from rulers, move / delete
function docPointFromClient(view: Viewport, cx: number, cy: number) {
  const r = view.overlay.getBoundingClientRect();
  return { ...view.screenToDoc(cx - r.left, cy - r.top), inside: cx >= r.left && cy >= r.top && cx <= r.right && cy <= r.bottom };
}
function snapGuidePos(doc: PixDocument, o: 'h' | 'v', pos: number, shift: boolean): number {
  if (shift) {
    // Shift snaps to ruler ticks
    const u = unitScale(doc).pxPerUnit, z = (app.viewport?.zoom || 1) / u, steps = [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000];
    const major = steps.find(s => s * z >= 60) ?? 1000, tick = (major / 5) * u;
    return Math.round(pos / tick) * tick;
  }
  if (snapOn()) {
    const tol = SNAP_PX / (app.viewport?.zoom || 1), T = targets(doc), list = o === 'v' ? T.xs : T.ys;
    for (const t of list) if (t.kind !== 'guide' && Math.abs(t.v - pos) <= tol) return t.v;
    const g = gridSnap(pos, doc);
    if (g !== null && Math.abs(g - pos) <= tol) return g;
  }
  return Math.round(pos);
}
function dragGuide(view: Viewport, doc: PixDocument, g: { orientation: 'h' | 'v'; id: number; pos: number } | null, startO: 'h' | 'v', e: PointerEvent) {
  const existing = g ? doc.guides.find(x => x.id === g.id) : null;
  live = { orientation: startO, pos: g?.pos ?? 0, id: g?.id ?? -1 };
  let o = startO, outside = false;
  const move = (ev: PointerEvent) => {
    const p = docPointFromClient(view, ev.clientX, ev.clientY);
    if (!existing && ev.altKey !== e.altKey) o = startO === 'h' ? 'v' : 'h';     // Alt switches orientation while dragging out
    live = { orientation: o, pos: snapGuidePos(doc, o, o === 'h' ? p.y : p.x, ev.shiftKey), id: live!.id };
    outside = !p.inside;
    view.overlay.style.cursor = outside && existing ? 'not-allowed' : o === 'h' ? 'row-resize' : 'col-resize';
    app.status?.(`${o === 'h' ? 'Y' : 'X'}: ${Math.round((live.pos / unitScale(doc).pxPerUnit) * 100) / 100} ${unitScale(doc).label}`);
    doc.redrawOverlay();
  };
  const up = () => {
    window.removeEventListener('pointermove', move, true);
    window.removeEventListener('pointerup', up, true);
    const l = live;
    live = null;
    view.overlay.style.cursor = '';
    if (!l) return;
    if (existing) {
      if (outside) setGuides(doc, 'Delete Guide', doc.guides.filter(x => x.id !== existing.id));
      else if (l.pos !== existing.pos) setGuides(doc, 'Move Guide', doc.guides.map(x => (x.id === existing.id ? { ...x, pos: l.pos } : x)));
      else doc.redrawOverlay();
    } else if (!outside) {
      if (!viewOptions.guides || !viewOptions.extras) { setViewOption('guides', true); setViewOption('extras', true); }
      setGuides(doc, 'New Guide', [...doc.guides, { id: newId(doc), orientation: l.orientation, pos: l.pos }]);
    } else doc.redrawOverlay();
  };
  window.addEventListener('pointermove', move, true);
  window.addEventListener('pointerup', up, true);
}
workspaceHooks.rulerPointerDown = (o, e, view) => {
  const doc = app.activeDoc;
  if (!doc || e.button !== 0) return;
  e.preventDefault();
  dragGuide(view, doc, null, o, e);
};
/** Guide under a screen point (within 4 px). */
function guideAt(view: Viewport, doc: PixDocument, sx: number, sy: number): Guide | null {
  let best: Guide | null = null, bd = 4;
  for (const g of doc.guides) {
    const a = g.orientation === 'h' ? view.docToScreen(0, g.pos) : view.docToScreen(g.pos, 0), b = g.orientation === 'h' ? view.docToScreen(1, g.pos) : view.docToScreen(g.pos, 1);
    const dx = b.x - a.x, dy = b.y - a.y, L = Math.hypot(dx, dy) || 1, d = Math.abs((sx - a.x) * dy - (sy - a.y) * dx) / L;
    if (d < bd) { bd = d; best = g; }
  }
  return best;
}
const canGrabGuides = () => visible() && !viewOptions.lockGuides && (app.currentTool?.id === 'move' || app.currentTool?.id === 'artboard');
viewportHooks.pointerDown.push((p, doc, view) => {
  if (!canGrabGuides()) return false;
  const g = guideAt(view, doc, p.sx, p.sy);
  if (!g) return false;
  dragGuide(view, doc, g, g.orientation, p.event as PointerEvent);
  return { move() {}, up() {} };
});
// hover cursor over guides (runs after the viewport's own cursor update)
queueMicrotask(() => {
  const ov = document.querySelector('.view-overlay');
  ov?.addEventListener('pointermove', e => {
    const view = app.viewport, doc = app.activeDoc;
    if (!view || !doc || live || !canGrabGuides() || (e as PointerEvent).buttons) return;
    const r = view.overlay.getBoundingClientRect(), g = guideAt(view, doc, (e as PointerEvent).clientX - r.left, (e as PointerEvent).clientY - r.top);
    if (g) view.overlay.style.cursor = g.orientation === 'h' ? 'row-resize' : 'col-resize';
  });
  ov?.addEventListener('dblclick', e => {
    const view = app.viewport, doc = app.activeDoc;
    if (!view || !doc || !canGrabGuides()) return;
    const r = view.overlay.getBoundingClientRect(), g = guideAt(view, doc, (e as MouseEvent).clientX - r.left, (e as MouseEvent).clientY - r.top);
    if (g) { e.stopPropagation(); void guidePrefs(); }
  }, true);
});

// ------------------------------------------------------------------ dialogs
async function newGuideDialog(init?: { orientation: 'h' | 'v'; pos: number }) {
  const doc = app.activeDoc;
  if (!doc) return;
  const u = unitScale(doc);
  let o: 'h' | 'v' = init?.orientation || 'h', pos = init ? init.pos / u.pxPerUnit : 0;
  let color = fromHex(guideColor()) || { r: 74, g: 255, b: 255 };
  const hor = h('input', { type: 'radio', name: 'vw-ng', checked: o === 'h' }) as HTMLInputElement;
  const ver = h('input', { type: 'radio', name: 'vw-ng', checked: o === 'v' }) as HTMLInputElement;
  hor.addEventListener('change', () => { o = 'h'; });
  ver.addEventListener('change', () => { o = 'v'; });
  const posF = numberField(pos, v => { pos = v; }, { unit: u.label, decimals: 3, width: 110, title: 'Guide position' });
  const body = h('div.form.vw-form', null,
    h('fieldset.vw-fs', null, h('legend', null, 'Orientation'), h('label.vw-radio', null, hor, ' Horizontal'), h('label.vw-radio', null, ver, ' Vertical')),
    h('div.form-row', null, h('label.form-label', null, 'Position:'), posF),
    h('div.form-row', null, h('label.form-label', null, 'Color:'), colorSwatch(color, c => { color = c; }, { title: 'Guide color' })));
  const ok = await openDialog({ title: 'New Guide', body, layout: 'side', width: 380 }).result;
  if (!ok) return;
  if (toHex(color) !== guideColor()) app.setPrefs({ guideColor: toHex(color) });
  if (!viewOptions.guides) setViewOption('guides', true);
  setGuides(doc, 'New Guide', [...doc.guides, { id: newId(doc), orientation: o, pos: pos * u.pxPerUnit }]);
}
interface LayoutOpts { cols: boolean; colN: number; colW: number; colG: number; rows: boolean; rowN: number; rowH: number; rowG: number; margin: boolean; mt: number; ml: number; mb: number; mr: number; center: boolean; clear: boolean }
function layoutGuides(doc: PixDocument, o: LayoutOpts): Guide[] {
  const out: Guide[] = [];
  const add = (orientation: 'h' | 'v', pos: number) => { if (!out.some(g => g.orientation === orientation && Math.abs(g.pos - pos) < 0.01)) out.push({ id: 0, orientation, pos: Math.round(pos * 100) / 100 }); };
  const L = o.margin ? o.ml : 0, R = doc.width - (o.margin ? o.mr : 0), T = o.margin ? o.mt : 0, B = doc.height - (o.margin ? o.mb : 0);
  if (o.margin) { add('v', L); add('v', R); add('h', T); add('h', B); }
  const axis = (n: number, size: number, gut: number, a0: number, a1: number, orient: 'h' | 'v') => {
    if (n <= 0) return;
    const avail = a1 - a0;
    const w = size > 0 ? size : (avail - gut * (n - 1)) / n;
    const total = w * n + gut * (n - 1);
    let s = o.center && size > 0 ? a0 + (avail - total) / 2 : a0;
    for (let i = 0; i < n; i++) { add(orient, s); add(orient, s + w); s += w + gut; }
  };
  if (o.cols) axis(o.colN, o.colW, o.colG, L, R, 'v');
  if (o.rows) axis(o.rowN, o.rowH, o.rowG, T, B, 'h');
  return out;
}
let layoutTouched = false;
let lastLayout: LayoutOpts = { cols: true, colN: 8, colW: 0, colG: 20, rows: false, rowN: 4, rowH: 0, rowG: 20, margin: false, mt: 40, ml: 40, mb: 40, mr: 40, center: false, clear: true };
async function newGuideLayout() {
  const doc = app.activeDoc;
  if (!doc) return;
  // column size defaults come from Preferences › Units & Rulers until the layout is changed here
  const o: LayoutOpts = layoutTouched ? { ...lastLayout } : { ...lastLayout, colW: xp.columnWidth, colG: xp.columnGutter };
  const base = doc.guides;
  const t = doc.history.begin('New Guide Layout', 'guide');
  const preview = () => { const g = layoutGuides(doc, o); let id = newId(doc); doc.guides = [...(o.clear ? [] : base), ...g.map(x => ({ ...x, id: id++ }))]; doc.redrawOverlay(); };
  const n = (label: string, key: keyof LayoutOpts, unit = 'px') => h('div.form-row', null, h('label.form-label', null, label), numberField(o[key] as number, v => { (o as any)[key] = v; preview(); }, { min: 0, max: 30000, unit, width: 80, title: label.replace(':', '') }));
  const c = (label: string, key: keyof LayoutOpts) => checkbox(label, o[key] as boolean, v => { (o as any)[key] = v; preview(); });
  const presets = select<string>([{ value: 'custom', label: 'Custom' }, { value: '8col', label: '8 Column' }, { value: '12col', label: '12 Column' }, { value: '3x3', label: 'Thirds (3 × 3)' }, { value: 'margins', label: 'Margins Only' }], 'custom', v => {
    if (v === '8col') Object.assign(o, { cols: true, colN: 8, colW: 0, colG: 20, rows: false, margin: false });
    else if (v === '12col') Object.assign(o, { cols: true, colN: 12, colW: 0, colG: 20, rows: false, margin: false });
    else if (v === '3x3') Object.assign(o, { cols: true, colN: 3, colW: 0, colG: 0, rows: true, rowN: 3, rowH: 0, rowG: 0, margin: false });
    else if (v === 'margins') Object.assign(o, { cols: false, rows: false, margin: true });
    rebuild(); preview();
  }, { width: 160, title: 'Layout preset' });
  const form = h('div.form.vw-form');
  const rebuild = () => form.replaceChildren(
    h('div.form-row', null, h('label.form-label', null, 'Preset:'), presets),
    h('div.vw-cols', null,
      h('div.vw-col', null, c('Columns', 'cols'), n('Number:', 'colN', ''), n('Width:', 'colW'), n('Gutter:', 'colG')),
      h('div.vw-col', null, c('Rows', 'rows'), n('Number:', 'rowN', ''), n('Height:', 'rowH'), n('Gutter:', 'rowG'))),
    c('Margin', 'margin'),
    h('div.vw-cols', null, h('div.vw-col', null, n('Top:', 'mt'), n('Left:', 'ml')), h('div.vw-col', null, n('Bottom:', 'mb'), n('Right:', 'mr'))),
    c('Center Columns', 'center'), c('Clear Existing Guides', 'clear'),
    h('div.flt-hint', null, 'Width / height 0 = divide the space evenly.'));
  rebuild();
  if (!viewOptions.guides || !viewOptions.extras) { setViewOption('guides', true); setViewOption('extras', true); }
  preview();
  const ok = await openDialog({ title: 'New Guide Layout', body: form, layout: 'side', width: 520 }).result;
  if (ok) { lastLayout = o; layoutTouched = true; t.commit('New Guide Layout'); events.emit('guides', doc); } else { t.cancel(); doc.guides = base; }
  doc.redrawOverlay();
}
function guidesFromShape() {
  const doc = app.activeDoc;
  if (!doc) return;
  const rects: Rect[] = [];
  for (const l of doc.selectedLayers) {
    const sp = (l as any).subpaths;
    const b = sp ? pathBounds(sp) : doc.layerBounds(l);
    if (b) rects.push(b);
  }
  if (!rects.length) {
    const p = doc.paths.find((x: VectorPath) => x.kind === 'work') as VectorPath | undefined;
    const b = p ? pathBounds(p.subpaths) : doc.selection.empty ? null : doc.selection.bounds;
    if (b) rects.push(b);
  }
  if (!rects.length) { toast('Select a shape layer (or make a selection) first.', 'info'); return; }
  const gs = [...doc.guides];
  let id = newId(doc);
  for (const r of rects) for (const [o, v] of [['v', r.x], ['v', r.x + r.w / 2], ['v', r.x + r.w], ['h', r.y], ['h', r.y + r.h / 2], ['h', r.y + r.h]] as ['h' | 'v', number][]) {
    if (!gs.some(g => g.orientation === o && Math.abs(g.pos - v) < 0.01)) gs.push({ id: id++, orientation: o, pos: Math.round(v * 100) / 100 });
  }
  if (!viewOptions.guides) setViewOption('guides', true);
  setGuides(doc, 'New Guides From Shape', gs);
}
/** Guides, Grid & Slices preferences (double-click a guide). */
export async function guidePrefs() {
  let gc = fromHex(app.prefs.guideColor) || { r: 74, g: 255, b: 255 }, sc = fromHex(app.prefs.smartGuideColor) || { r: 255, g: 74, b: 255 }, grc = fromHex(app.prefs.gridColor) || { r: 158, g: 158, b: 158 };
  let spacing = app.prefs.gridSpacing, subs = app.prefs.gridSubdivisions;
  const body = h('div.form.vw-form', null,
    h('div.vw-sub', null, 'Guides'), h('div.form-row', null, h('label.form-label', null, 'Color:'), colorSwatch(gc, c => { gc = c; }, { title: 'Guide color' })),
    h('div.vw-sub', null, 'Smart Guides'), h('div.form-row', null, h('label.form-label', null, 'Color:'), colorSwatch(sc, c => { sc = c; }, { title: 'Smart guide color' })),
    h('div.vw-sub', null, 'Grid'), h('div.form-row', null, h('label.form-label', null, 'Color:'), colorSwatch(grc, c => { grc = c; }, { title: 'Grid color' })),
    h('div.form-row', null, h('label.form-label', null, 'Gridline Every:'), numberField(spacing, v => { spacing = v; }, { min: 1, max: 10000, width: 80, unit: app.prefs.rulerUnits })),
    h('div.form-row', null, h('label.form-label', null, 'Subdivisions:'), numberField(subs, v => { subs = v; }, { min: 1, max: 100, width: 60 })));
  const ok = await openDialog({ title: 'Guides, Grid & Slices', body, layout: 'side', width: 420 }).result;
  if (ok) app.setPrefs({ guideColor: toHex(gc), smartGuideColor: toHex(sc), gridColor: toHex(grc), gridSpacing: spacing, gridSubdivisions: subs });
  app.viewport?.requestRender();
}

registerCommands([
  { id: 'view.lockGuides', label: 'Lock Guides', enabled: () => !!app.activeDoc, checked: () => viewOptions.lockGuides, run: () => setViewOption('lockGuides', !viewOptions.lockGuides) },
  { id: 'view.clearGuides', label: 'Clear Guides', enabled: () => !!app.activeDoc?.guides.length, run: () => { const d = app.activeDoc; if (d) setGuides(d, 'Clear Guides', []); } },
  { id: 'view.newGuide', label: 'New Guide...', enabled: () => !!app.activeDoc, run: (a?: { orientation: 'h' | 'v'; pos: number }) => newGuideDialog(a) },
  { id: 'view.newGuideLayout', label: 'New Guide Layout...', enabled: () => !!app.activeDoc, run: newGuideLayout },
  { id: 'view.guidesFromShape', label: 'New Guides From Shape', enabled: () => !!app.activeDoc, run: guidesFromShape },
  { id: 'view.guidePrefs', label: 'Guides, Grid & Slices...', run: guidePrefs },
]);
events.on('prefs', () => app.viewport?.requestRender());
(window as any).__pxGuides = { layoutGuides, setGuides, targets };
