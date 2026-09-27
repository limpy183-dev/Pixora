// Slice Tool and Slice Select Tool (C). User slices live in doc.extra.slices (history-safe); auto slices fill the
// remaining area. Slice Select moves / resizes / deletes, double-click opens Slice Options, Divide Slice, stacking
// order, Promote, Slices From Guides, Hide Auto Slices. View › Lock Slices / Clear Slices.
import './crop.css';
import { app, type Tool, type ToolPointer } from '../../core/app';
import type { PixDocument } from '../../core/document';
import { events } from '../../core/events';
import { hooks } from '../../core/registry';
import { registerCommands } from '../../core/commands';
import { viewOptions, viewportHooks, type Viewport } from '../../core/viewport';
import type { Rect } from '../../core/types';
import { h } from '../../ui/dom';
import { openDialog } from '../../ui/dialog';
import { checkbox, iconButton, numberField, select, separator } from '../../ui/widgets';
import { svgCursor } from '../../ui/cursors';
import { toast } from '../../ui/toast';
import { registerIcons } from '../../ui/icons';
import { xp } from '../../features/prefs/store';

registerIcons({
  'sl-front': '<rect x="8" y="8" width="11" height="11" fill="currentColor"/><rect x="4" y="4" width="11" height="11"/>',
  'sl-forward': '<rect x="4" y="4" width="11" height="11"/><rect x="8" y="8" width="11" height="11" fill="currentColor" opacity=".6"/>',
  'sl-backward': '<rect x="8" y="8" width="11" height="11"/><rect x="4" y="4" width="11" height="11" fill="currentColor" opacity=".6"/>',
  'sl-back': '<rect x="4" y="4" width="11" height="11" fill="currentColor"/><rect x="8" y="8" width="11" height="11"/>',
});

export interface Slice { id: number; x: number; y: number; w: number; h: number; name: string; url: string; target: string; alt: string; message: string }
const settings = { style: 'normal' as 'normal' | 'ratio' | 'fixed', w: 1, h: 1, hideAuto: false };
let locked = localStorage.getItem('pixora.slicesLocked') === '1';
const slicesOf = (doc: PixDocument): Slice[] => (Array.isArray(doc.extra.slices) ? doc.extra.slices : []);
let selId: number | null = null;
const baseName = (doc: PixDocument) => doc.name.replace(/\.[^.]+$/, '').replace(/\s+/g, '_');
function setSlices(doc: PixDocument, name: string, list: Slice[]) {
  doc.history.transaction(name, () => { doc.extra.slices = list; }, 'slice');
  doc.redrawOverlay();
  events.emit('layers', doc);
}
const nextId = (doc: PixDocument) => Math.max(0, ...slicesOf(doc).map(s => s.id)) + 1;
function makeSlice(doc: PixDocument, r: Rect): Slice {
  const id = nextId(doc);
  return { id, x: Math.round(r.x), y: Math.round(r.y), w: Math.max(1, Math.round(r.w)), h: Math.max(1, Math.round(r.h)), name: `${baseName(doc)}_${String(id).padStart(2, '0')}`, url: '', target: '', alt: '', message: '' };
}
const clip = (doc: PixDocument, r: Rect): Rect => { const x0 = Math.max(0, r.x), y0 = Math.max(0, r.y), x1 = Math.min(doc.width, r.x + r.w), y1 = Math.min(doc.height, r.y + r.h); return { x: x0, y: y0, w: Math.max(0, x1 - x0), h: Math.max(0, y1 - y0) }; };

/** Auto slices: grid cells (from user slice edges) not covered by a user slice, merged along rows. */
export function autoSlices(doc: PixDocument): Rect[] {
  const user = slicesOf(doc).map(s => clip(doc, s)).filter(r => r.w > 0 && r.h > 0);
  if (!user.length) return [{ x: 0, y: 0, w: doc.width, h: doc.height }];
  const xs = [...new Set([0, doc.width, ...user.flatMap(r => [r.x, r.x + r.w])])].sort((a, b) => a - b);
  const ys = [...new Set([0, doc.height, ...user.flatMap(r => [r.y, r.y + r.h])])].sort((a, b) => a - b);
  const out: Rect[] = [];
  for (let j = 0; j < ys.length - 1; j++) {
    let run: Rect | null = null;
    for (let i = 0; i < xs.length - 1; i++) {
      const c = { x: xs[i], y: ys[j], w: xs[i + 1] - xs[i], h: ys[j + 1] - ys[j] };
      const covered = user.some(u => c.x >= u.x && c.y >= u.y && c.x + c.w <= u.x + u.w && c.y + c.h <= u.y + u.h);
      if (covered) { if (run) { out.push(run); run = null; } continue; }
      if (run) run.w += c.w; else run = { ...c };
    }
    if (run) out.push(run);
  }
  // merge vertically identical spans
  const merged: Rect[] = [];
  for (const r of out) { const m = merged.find(q => q.x === r.x && q.w === r.w && q.y + q.h === r.y); if (m) m.h += r.h; else merged.push({ ...r }); }
  return merged;
}
/** All slices in Photoshop numbering order (top to bottom, left to right). */
function numbered(doc: PixDocument) {
  const all = [...slicesOf(doc).map(s => ({ r: s as Rect, user: s as Slice | null })), ...autoSlices(doc).map(r => ({ r, user: null }))];
  return all.sort((a, b) => a.r.y - b.r.y || a.r.x - b.r.x);
}

// ------------------------------------------------------------------ drawing
const sliceToolActive = () => ['slice', 'slice-select'].includes(app.currentTool?.id || '');
const showSlices = (doc: PixDocument) => viewOptions.extras && (sliceToolActive() || slicesOf(doc).length > 0);
viewportHooks.overlay.push((ctx, view, doc) => {
  if (!showSlices(doc)) return;
  const list = numbered(doc), activeTool = sliceToolActive();
  ctx.save();
  ctx.font = '10px system-ui, sans-serif';
  list.forEach((s, i) => {
    if (!s.user && (settings.hideAuto || !activeTool)) return;
    const a = view.docToScreen(s.r.x, s.r.y), b = view.docToScreen(s.r.x + s.r.w, s.r.y + s.r.h);
    const x = Math.round(Math.min(a.x, b.x)) + 0.5, y = Math.round(Math.min(a.y, b.y)) + 0.5, w = Math.abs(b.x - a.x), hh = Math.abs(b.y - a.y);
    const sel = s.user && s.user.id === selId;
    ctx.strokeStyle = s.user ? (sel ? '#ffb000' : xp.sliceColor) : 'rgba(150,150,150,.9)';
    ctx.setLineDash(s.user ? [] : [3, 3]);
    ctx.lineWidth = 1;
    ctx.strokeRect(x, y, w, hh);
    if (!s.user && activeTool) { ctx.fillStyle = 'rgba(0,0,0,.18)'; ctx.fillRect(x, y, w, hh); }
    // number badge (Preferences › Guides, Grid & Slices › Show Slice Numbers)
    if (!xp.sliceNumbers) { if (sel) for (const [u, v] of HANDLES) { const hx = x + u * w, hy = y + v * hh; ctx.fillStyle = '#ffb000'; ctx.fillRect(hx - 3, hy - 3, 6, 6); } return; }
    const label = String(i + 1).padStart(2, '0');
    const bw = ctx.measureText(label).width + 16;
    ctx.fillStyle = s.user ? (sel ? '#ffb000' : xp.sliceColor) : '#8a8a8a';
    ctx.fillRect(x + 1, y + 1, bw, 13);
    ctx.fillStyle = '#fff';
    ctx.fillText(label, x + 4, y + 11);
    ctx.fillRect(x + bw - 8, y + 4, 6, 6);                       // slice-type glyph
    if (sel) for (const [u, v] of HANDLES) { const hx = x + u * w, hy = y + v * hh; ctx.fillStyle = '#ffb000'; ctx.fillRect(hx - 3, hy - 3, 6, 6); }
  });
  ctx.restore();
});
const HANDLES: [number, number][] = [[0, 0], [0.5, 0], [1, 0], [1, 0.5], [1, 1], [0.5, 1], [0, 1], [0, 0.5]];

// ------------------------------------------------------------------ Slice Tool
let draw: { a: { x: number; y: number }; b: { x: number; y: number } } | null = null;
const sliceCursor = svgCursor('<path d="M3.5 20.5 17.7 6.3c1.3-1.3 3.2.1 2 1.5L8.3 19.9z"/><path d="M3.5 20.5h5.5"/>', 3, 20, 'crosshair');
function dragRect(p: ToolPointer): Rect {
  const a = draw!.a;
  let b = hooks.snapPoint({ x: p.x, y: p.y }, app.activeDoc!);
  let w = b.x - a.x, hh = b.y - a.y;
  if (settings.style === 'fixed') { w = settings.w * Math.sign(w || 1); hh = settings.h * Math.sign(hh || 1); }
  else if (settings.style === 'ratio' || p.shift) { const r = settings.style === 'ratio' ? settings.w / settings.h : 1; if (Math.abs(w) / r > Math.abs(hh)) hh = (Math.abs(w) / r) * Math.sign(hh || 1); else w = Math.abs(hh) * r * Math.sign(w || 1); }
  let x = a.x, y = a.y;
  if (p.alt) { x -= w; y -= hh; w *= 2; hh *= 2; }
  b = { x: x + w, y: y + hh };
  return { x: Math.min(x, b.x), y: Math.min(y, b.y), w: Math.abs(w), h: Math.abs(hh) };
}
let lastRect: Rect | null = null;
const sliceTool: Tool = {
  id: 'slice', name: 'Slice Tool', group: 'crop', icon: 'slice', shortcut: 'C', order: 2, settings, cursor: sliceCursor,
  pointerDown(p, doc) {
    if (locked) { toast('Slices are locked (View › Lock Slices).', 'info'); return; }
    const a = hooks.snapPoint({ x: p.x, y: p.y }, doc);
    draw = { a, b: a }; lastRect = null;
  },
  pointerMove(p, doc) { if (!draw) return; lastRect = dragRect(p); doc.redrawOverlay(); },
  pointerUp(p, doc) {
    if (!draw) return;
    const r = clip(doc, dragRect(p));
    draw = null; lastRect = null;
    if (r.w < 2 || r.h < 2) { doc.redrawOverlay(); return; }
    const s = makeSlice(doc, r);
    selId = s.id;
    setSlices(doc, 'Slice', [...slicesOf(doc), s]);
  },
  drawOverlay(ctx, view) {
    if (!lastRect) return;
    const a = view.docToScreen(lastRect.x, lastRect.y), b = view.docToScreen(lastRect.x + lastRect.w, lastRect.y + lastRect.h);
    ctx.strokeStyle = '#3d8bff'; ctx.setLineDash([4, 3]); ctx.strokeRect(a.x + 0.5, a.y + 0.5, b.x - a.x, b.y - a.y);
  },
  options(bar) {
    const save = () => app.saveToolSettings(sliceTool);
    const wF = numberField(settings.w, v => { settings.w = v; save(); }, { min: 1, max: 30000, width: 60, label: 'Width:', title: 'Width (or ratio)' });
    const hF = numberField(settings.h, v => { settings.h = v; save(); }, { min: 1, max: 30000, width: 60, label: 'Height:', title: 'Height (or ratio)' });
    const sync = () => { const on = settings.style !== 'normal'; wF.style.opacity = hF.style.opacity = on ? '1' : '.45'; wF.style.pointerEvents = hF.style.pointerEvents = on ? '' : 'none'; };
    bar.append(h('span.opt-label', null, 'Style:'), select([{ value: 'normal', label: 'Normal' }, { value: 'ratio', label: 'Fixed Aspect Ratio' }, { value: 'fixed', label: 'Fixed Size' }], settings.style, v => { settings.style = v as any; save(); sync(); }, { width: 140, title: 'Slice style' }),
      wF, hF, separator(), h('button.btn', { type: 'button', title: 'Create slices from the guides', onclick: () => fromGuides() }, 'Slices From Guides'));
    sync();
  },
};
function fromGuides() {
  const doc = app.activeDoc;
  if (!doc) return;
  if (locked) { toast('Slices are locked (View › Lock Slices).', 'info'); return; }
  if (!doc.guides.length) { toast('There are no guides to create slices from.', 'info'); return; }
  const xs = [...new Set([0, doc.width, ...doc.guides.filter(g => g.orientation === 'v').map(g => Math.round(g.pos)).filter(v => v > 0 && v < doc.width)])].sort((a, b) => a - b);
  const ys = [...new Set([0, doc.height, ...doc.guides.filter(g => g.orientation === 'h').map(g => Math.round(g.pos)).filter(v => v > 0 && v < doc.height)])].sort((a, b) => a - b);
  const list: Slice[] = [];
  let id = 1;
  for (let j = 0; j < ys.length - 1; j++) for (let i = 0; i < xs.length - 1; i++) list.push({ id: id, x: xs[i], y: ys[j], w: xs[i + 1] - xs[i], h: ys[j + 1] - ys[j], name: `${baseName(doc)}_${String(id++).padStart(2, '0')}`, url: '', target: '', alt: '', message: '' });
  selId = null;
  setSlices(doc, 'Slices From Guides', list);
}

// ------------------------------------------------------------------ Slice Select Tool
let sdrag: null | { id: number; mode: number; start: { x: number; y: number }; r0: Rect; txn: ReturnType<PixDocument['history']['begin']> } = null;
function sliceAt(doc: PixDocument, x: number, y: number): Slice | null {
  const l = slicesOf(doc);
  for (let i = l.length - 1; i >= 0; i--) { const s = l[i]; if (x >= s.x && y >= s.y && x < s.x + s.w && y < s.y + s.h) return s; }
  return null;
}
function handleAt(view: Viewport, s: Slice, sx: number, sy: number): number {
  for (let i = 0; i < 8; i++) { const [u, v] = HANDLES[i], p = view.docToScreen(s.x + u * s.w, s.y + v * s.h); if (Math.abs(p.x - sx) <= 5 && Math.abs(p.y - sy) <= 5) return i; }
  return -1;
}
const selected = (doc: PixDocument) => slicesOf(doc).find(s => s.id === selId) || null;
const selectTool: Tool = {
  id: 'slice-select', name: 'Slice Select Tool', group: 'crop', icon: 'slice-select', shortcut: 'C', order: 3, settings,
  cursor: () => {
    const doc = app.activeDoc, v = app.viewport, s = doc && selected(doc);
    if (s && v && !locked) { const i = handleAt(v, s, v.pointer.sx, v.pointer.sy); if (i >= 0) return i % 4 === 0 ? 'nwse-resize' : i % 4 === 2 ? 'nesw-resize' : i % 4 === 1 ? 'ns-resize' : 'ew-resize'; }
    return 'default';
  },
  pointerDown(p, doc) {
    const v = app.viewport!, cur = selected(doc);
    let mode = cur && !locked ? handleAt(v, cur, p.sx, p.sy) : -1;
    let s = mode >= 0 ? cur : sliceAt(doc, p.x, p.y);
    if (!s) {
      // clicking an auto slice promotes it to a user slice (Photoshop asks for Promote; we do it on double-click)
      selId = null; doc.redrawOverlay(); return;
    }
    selId = s.id;
    events.emit('toolOptions');
    if (locked) { doc.redrawOverlay(); return; }
    if (mode < 0) mode = 8;           // move
    sdrag = { id: s.id, mode, start: { x: p.x, y: p.y }, r0: { x: s.x, y: s.y, w: s.w, h: s.h }, txn: doc.history.begin(mode === 8 ? 'Move Slice' : 'Resize Slice', 'slice') };
    s = null;
  },
  pointerMove(p, doc) {
    if (!sdrag) return;
    const d = sdrag, r = { ...d.r0 };
    let dx = p.x - d.start.x, dy = p.y - d.start.y;
    if (d.mode === 8) { if (p.shift) { if (Math.abs(dx) > Math.abs(dy)) dy = 0; else dx = 0; } const sn = hooks.snapRect({ x: r.x + dx, y: r.y + dy, w: r.w, h: r.h }, doc); r.x += dx + sn.dx; r.y += dy + sn.dy; }
    else {
      const [u, v] = HANDLES[d.mode];
      if (u === 0) { r.x = d.r0.x + dx; r.w = d.r0.w - dx; } if (u === 1) r.w = d.r0.w + dx;
      if (v === 0) { r.y = d.r0.y + dy; r.h = d.r0.h - dy; } if (v === 1) r.h = d.r0.h + dy;
      if (r.w < 0) { r.x += r.w; r.w = -r.w; } if (r.h < 0) { r.y += r.h; r.h = -r.h; }
    }
    doc.extra.slices = slicesOf(doc).map(s => (s.id === d.id ? { ...s, x: Math.round(r.x), y: Math.round(r.y), w: Math.max(1, Math.round(r.w)), h: Math.max(1, Math.round(r.h)) } : s));
    doc.redrawOverlay();
  },
  pointerUp(_p, doc) {
    const d = sdrag;
    sdrag = null;
    if (!d) return;
    const s = slicesOf(doc).find(x => x.id === d.id);
    if (s && (s.x !== d.r0.x || s.y !== d.r0.y || s.w !== d.r0.w || s.h !== d.r0.h)) d.txn.commit(); else d.txn.cancel();
    doc.redrawOverlay();
  },
  dblclick(p, doc) {
    const s = sliceAt(doc, p.x, p.y);
    if (s) { void sliceOptions(doc, s); return; }
    // promote the auto slice under the pointer
    const a = autoSlices(doc).find(r => p.x >= r.x && p.y >= r.y && p.x < r.x + r.w && p.y < r.y + r.h);
    if (a && !locked) { const n = makeSlice(doc, a); selId = n.id; setSlices(doc, 'Promote to User Slice', [...slicesOf(doc), n]); }
  },
  keyDown(e, doc) {
    if (!doc || selId === null) return false;
    if ((e.key === 'Delete' || e.key === 'Backspace') && !locked) { const id = selId; selId = null; setSlices(doc, 'Delete Slice', slicesOf(doc).filter(s => s.id !== id)); return true; }
    const map: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    const v = map[e.key];
    if (v && !locked) { const k = e.shiftKey ? 10 : 1; setSlices(doc, 'Move Slice', slicesOf(doc).map(s => (s.id === selId ? { ...s, x: s.x + v[0] * k, y: s.y + v[1] * k } : s))); return true; }
    return false;
  },
  options(bar) {
    const doc = app.activeDoc;
    const order = (fn: (l: Slice[], i: number) => void, name: string) => () => {
      const d = app.activeDoc; if (!d || selId === null || locked) return;
      const l = [...slicesOf(d)], i = l.findIndex(s => s.id === selId); if (i < 0) return;
      fn(l, i); setSlices(d, name, l);
    };
    bar.append(
      iconButton('sl-front', 'Bring to Front', order((l, i) => { l.push(l.splice(i, 1)[0]); }, 'Bring Slice to Front')),
      iconButton('sl-forward', 'Bring Forward', order((l, i) => { if (i < l.length - 1) [l[i], l[i + 1]] = [l[i + 1], l[i]]; }, 'Bring Slice Forward')),
      iconButton('sl-backward', 'Send Backward', order((l, i) => { if (i > 0) [l[i], l[i - 1]] = [l[i - 1], l[i]]; }, 'Send Slice Backward')),
      iconButton('sl-back', 'Send to Back', order((l, i) => { l.unshift(l.splice(i, 1)[0]); }, 'Send Slice to Back')),
      separator(),
      h('button.btn', { type: 'button', title: 'Divide the selected slice', onclick: () => { const d = app.activeDoc, s = d && selected(d); if (d && s) void divideSlice(d, s); else toast('Select a user slice first.', 'info'); } }, 'Divide...'),
      h('button.btn', { type: 'button', title: 'Slice options', onclick: () => { const d = app.activeDoc, s = d && selected(d); if (d && s) void sliceOptions(d, s); else toast('Select a user slice first.', 'info'); } }, 'Slice Options...'),
      separator(),
      checkbox('Hide Auto Slices', settings.hideAuto, v => { settings.hideAuto = v; app.saveToolSettings(selectTool); app.activeDoc?.redrawOverlay(); }, { title: 'Hide the automatically generated slices' }));
    void doc;
  },
};
async function sliceOptions(doc: PixDocument, s: Slice) {
  const d = { ...s };
  const tf = (label: string, key: keyof Slice, width = 240) => { const inp = h('input.field', { type: 'text', value: String(d[key]), style: { width: width + 'px' } }) as HTMLInputElement; inp.addEventListener('keydown', e => e.stopPropagation()); inp.addEventListener('input', () => { (d as any)[key] = inp.value; }); return h('div.form-row', null, h('label.form-label', null, label), inp); };
  const nf = (label: string, key: 'x' | 'y' | 'w' | 'h') => h('div.form-row', null, h('label.form-label', null, label), numberField(d[key], v => { d[key] = Math.round(v); }, { min: key === 'w' || key === 'h' ? 1 : -30000, max: 30000, unit: 'px', width: 80 }));
  const body = h('div.form.sl-form', null, tf('Name:', 'name'), tf('URL:', 'url'), tf('Target:', 'target', 120), tf('Message Text:', 'message'), tf('Alt Tag:', 'alt'),
    h('div.sl-sub', null, 'Dimensions'), h('div.sl-dims', null, nf('X:', 'x'), nf('W:', 'w'), nf('Y:', 'y'), nf('H:', 'h')));
  const ok = await openDialog({ title: 'Slice Options', body, layout: 'side', width: 480 }).result;
  if (!ok || locked) return;
  setSlices(doc, 'Edit Slice Options', slicesOf(doc).map(x => (x.id === s.id ? d : x)));
}
async function divideSlice(doc: PixDocument, s: Slice) {
  if (locked) return;
  const o = { hOn: true, hMode: 'count' as 'count' | 'px', hN: 2, hPx: Math.round(s.h / 2), vOn: false, vMode: 'count' as 'count' | 'px', vN: 2, vPx: Math.round(s.w / 2) };
  const base = slicesOf(doc);
  const t = doc.history.begin('Divide Slice', 'slice');
  const compute = () => {
    const rowsN = !o.hOn ? 1 : o.hMode === 'count' ? Math.max(1, o.hN) : Math.max(1, Math.ceil(s.h / Math.max(1, o.hPx)));
    const colsN = !o.vOn ? 1 : o.vMode === 'count' ? Math.max(1, o.vN) : Math.max(1, Math.ceil(s.w / Math.max(1, o.vPx)));
    const rowH = o.hOn && o.hMode === 'px' ? o.hPx : s.h / rowsN, colW = o.vOn && o.vMode === 'px' ? o.vPx : s.w / colsN;
    const out: Slice[] = [];
    let id = nextId(doc);
    for (let j = 0; j < rowsN; j++) for (let i = 0; i < colsN; i++) {
      const x0 = Math.round(s.x + i * colW), y0 = Math.round(s.y + j * rowH), x1 = Math.min(s.x + s.w, Math.round(s.x + (i + 1) * colW)), y1 = Math.min(s.y + s.h, Math.round(s.y + (j + 1) * rowH));
      out.push(i === 0 && j === 0 ? { ...s, w: x1 - x0, h: y1 - y0 } : { ...s, id, x: x0, y: y0, w: x1 - x0, h: y1 - y0, name: `${baseName(doc)}_${String(id++).padStart(2, '0')}` });
    }
    doc.extra.slices = base.flatMap(x => (x.id === s.id ? out : [x]));
    doc.redrawOverlay();
  };
  const row = (onKey: 'hOn' | 'vOn', title: string, modeKey: 'hMode' | 'vMode', nKey: 'hN' | 'vN', pxKey: 'hPx' | 'vPx', dir: string) => h('fieldset.sl-fs', null, h('legend', null, checkbox(title, o[onKey], v => { o[onKey] = v; compute(); })),
    h('div.form-row', null, select([{ value: 'count', label: `slices ${dir}, evenly spaced` }, { value: 'px', label: 'pixels per slice' }], o[modeKey], v => { (o as any)[modeKey] = v; compute(); }, { width: 200 }),
      numberField(o[nKey], v => { o[nKey] = v; compute(); }, { min: 1, max: 999, width: 56, title: 'Number of slices' }), numberField(o[pxKey], v => { o[pxKey] = v; compute(); }, { min: 1, max: 30000, width: 64, unit: 'px', title: 'Pixels per slice' })));
  compute();
  const ok = await openDialog({ title: 'Divide Slice', body: h('div.form.sl-form', null, row('hOn', 'Divide Horizontally Into', 'hMode', 'hN', 'hPx', 'down'), row('vOn', 'Divide Vertically Into', 'vMode', 'vN', 'vPx', 'across')), layout: 'side', width: 520 }).result;
  if (ok) t.commit('Divide Slice'); else { t.cancel(); doc.extra.slices = base; }
  doc.redrawOverlay();
}
app.registerTool(sliceTool);
app.registerTool(selectTool);

registerCommands([
  { id: 'view.lockSlices', label: 'Lock Slices', checked: () => locked, run: () => { locked = !locked; localStorage.setItem('pixora.slicesLocked', locked ? '1' : '0'); app.activeDoc?.redrawOverlay(); } },
  { id: 'view.clearSlices', label: 'Clear Slices', enabled: () => !!app.activeDoc && slicesOf(app.activeDoc).length > 0, run: () => { const d = app.activeDoc; if (!d) return; if (locked) { toast('Slices are locked (View › Lock Slices).', 'info'); return; } selId = null; setSlices(d, 'Clear Slices', []); } },
  { id: 'slice.fromGuides', label: 'Slices From Guides', enabled: () => !!app.activeDoc, run: fromGuides },
]);
events.on('activeDoc', () => { selId = null; });
(window as any).__pxSlices = { autoSlices, slicesOf, numbered };
