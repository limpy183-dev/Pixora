// Pen tools (P): Pen, Freeform Pen (+ Magnetic), Curvature Pen, Add / Delete Anchor Point, Convert Point.
import { app, type Tool, type ToolPointer } from '../../core/app';
import type { PixDocument } from '../../core/document';
import type { Point } from '../../core/types';
import { corner, type PathOp, type PathPoint, type SubPath } from '../../core/path';
import { snap45 } from '../../core/geom';
import { runCommand } from '../../core/commands';
import { h } from '../../ui/dom';
import { svgCursor } from '../../ui/cursors';
import { checkbox, label, numberField, separator } from '../../ui/widgets';
import { isShapeLayer } from '../../layers/shape-layer';
import {
  dropLive, hitAnchor, hitHandle, hitSegment, layerTarget, overlay, pathForDrawing, pathTarget, ptKey, sel, setPathSel, syncSel,
  targetOf, tolDoc, touch, touchDone, type Target,
} from './common';
import { autoSmooth, splitSegment } from './geom';
import { fitCurve } from './fit';
import {
  alignButton, alignEdgesBox, arrangeButton, gearButton, modeSelect, onVectorChange, opsButton, sizeControls, styleControls, type OpSetting,
} from './options';
import { newShapeLayer } from './shape-tools';
import { CUR_DIRECT, directPointerDown, selectPointerMove, selectPointerUp } from './select';

interface PenSettings { mode: 'shape' | 'path'; op: OpSetting; rubberBand: boolean; autoAddDelete: boolean; alignEdges: boolean; magnetic: boolean; curveFit: number; magWidth: number; magContrast: number }
const penSettings: PenSettings = { mode: 'path', op: 'new', rubberBand: false, autoAddDelete: true, alignEdges: false, magnetic: false, curveFit: 2, magWidth: 10, magContrast: 10 };
const ffSettings: PenSettings = { ...penSettings };
const cvSettings: PenSettings = { ...penSettings };

// ------------------------------------------------------------------ cursors
const NIB = '<path d="M3.5 3.5 13 7l4 7.5-2.5 2.5L7 13z" fill="#fff"/><path d="M3.5 3.5 9 9"/><circle cx="9.6" cy="9.6" r="1"/>';
const pc = (extra: string) => svgCursor(NIB + extra, 3, 3, 'crosshair');
const CUR = {
  pen: pc(''), start: pc('<path d="m17 18 4 4M21 18l-4 4"/>'), add: pc('<path d="M19 17v6M16 20h6"/>'), del: pc('<path d="M16 20h6"/>'),
  close: pc('<circle cx="19.5" cy="19.5" r="2.2"/>'), cont: pc('<path d="M16 22h6"/><path d="M19 17v2"/>'), convert: svgCursor('<path d="M4 20 12 5l8 15"/>', 12, 5, 'crosshair'),
  freeform: svgCursor('<path d="M3.5 3.5 13 7l4 7.5-2.5 2.5L7 13z" fill="#fff"/><path d="M3.5 3.5 9 9"/><path d="M15 21c2-3 4-1 6-4"/>', 3, 3, 'crosshair'),
  curvature: pc('<path d="M15 22c1-5 5-5 6-2"/>'),
};
let hoverCursor = CUR.pen;
let ctrlHeld = false;

// ------------------------------------------------------------------ drawing helpers
/** Currently drawn open subpath of the target (the pen continues it), or null. */
function drawing(doc: PixDocument): { t: Target; si: number } | null {
  const t = targetOf(doc);
  const d = overlay.drawing;
  if (!t || !d || d.key !== t.key) return null;
  const sp = t.holder.subpaths[d.si];
  if (!sp || sp.closed) return null;
  return { t, si: d.si };
}
function setDrawing(t: Target | null, si = 0) { overlay.drawing = t ? { key: t.key, si } : null; }
export function endDrawing(doc: PixDocument | null) { if (overlay.drawing) { overlay.drawing = null; doc?.redrawOverlay(); } }

/** Target for a NEW subpath in the given mode (creating the Work Path / a shape layer inside the current history action). */
function newSubpathTarget(doc: PixDocument, s: PenSettings): { t: Target; op: PathOp; name: string } {
  const op: PathOp = s.op === 'new' ? 'add' : s.op;
  if (s.mode === 'shape') {
    const active = doc.activeLayer;
    if (s.op !== 'new' && isShapeLayer(active) && !active.locks.all) { active.live = null; setPathSel(doc, 0); return { t: layerTarget(active), op, name: 'Add Anchor Point' }; }
    const l = newShapeLayer(doc, 'custom', [], null);
    setPathSel(doc, 0);
    return { t: layerTarget(l), op: 'add', name: 'New Shape Layer' };
  }
  const had = doc.paths.some((p: any) => p.kind === 'work');
  const path = pathForDrawing(doc);
  return { t: pathTarget(path), op, name: path.kind === 'work' && (!had || path.subpaths.length === 0) ? 'New Work Path' : 'Add Anchor Point' };
}
const snapPt = (s: PenSettings, p: Point): Point => (s.alignEdges ? { x: Math.round(p.x), y: Math.round(p.y) } : { x: p.x, y: p.y });
const isEndpoint = (sp: SubPath, pi: number) => !sp.closed && sp.points.length > 0 && (pi === 0 || pi === sp.points.length - 1);
/** Reverse a subpath in place (so drawing can continue from its first point). */
function reverseSub(sp: SubPath) {
  sp.points.reverse();
  for (const q of sp.points) { const ix = q.ix, iy = q.iy; q.ix = q.ox; q.iy = q.oy; q.ox = ix; q.oy = iy; }
}
function deleteAnchor(sp: SubPath, pi: number) {
  sp.points.splice(pi, 1);
  if (!sp.closed && sp.points.length) {
    const f = sp.points[0], l = sp.points[sp.points.length - 1];
    f.ix = f.x; f.iy = f.y; l.ox = l.x; l.oy = l.y;
  }
}
function removeIfEmpty(t: Target, si: number) {
  const sp = t.holder.subpaths[si];
  if (sp && sp.points.length < 2 && !(overlay.drawing && overlay.drawing.si === si)) t.holder.subpaths.splice(si, 1);
}
const mirror = (a: Point, v: Point): Point => ({ x: 2 * a.x - v.x, y: 2 * a.y - v.y });

// ------------------------------------------------------------------ pen state machine
type PenDrag =
  | { kind: 'new-point'; t: Target; si: number; pi: number; txn: Txn; name: string; moved: boolean; closing?: boolean }
  | { kind: 'convert'; t: Target; si: number; pi: number; txn: Txn; moved: boolean }
  | { kind: 'break'; t: Target; si: number; pi: number; which: 'in' | 'out'; txn: Txn }
  | { kind: 'move-point'; t: Target; si: number; pi: number; txn: Txn; start: Point; orig: PathPoint; curvature?: boolean; moved: boolean; created?: boolean }
  | { kind: 'direct' }
  | { kind: 'freeform'; pts: Point[]; img: ImageData | null; cont: { t: Target; si: number; atStart: boolean } | null }
  | { kind: 'none' };
type Txn = ReturnType<PixDocument['history']['begin']>;
let pd: PenDrag = { kind: 'none' };
let rubber: Point | null = null;

function penDown(p: ToolPointer, doc: PixDocument, s: PenSettings) {
  const tol = tolDoc(5);
  if (p.ctrl) { directPointerDown(p, doc); pd = { kind: 'direct' }; return; }
  const dr = drawing(doc);
  const t = targetOf(doc);
  if (t) syncSel(t);
  if (t?.layer?.locks.all) { pd = { kind: 'none' }; return; }
  // Alt: convert anchor / break handle
  if (p.alt && t) {
    const vis = (si: number, pi: number) => (dr && dr.si === si && pi >= t.holder.subpaths[si].points.length - 2) || sel.pts.has(ptKey(si, pi));
    const hh = hitHandle(t.holder.subpaths, p, tol, vis);
    if (hh) { pd = { kind: 'break', t, si: hh.si, pi: hh.pi, which: hh.which, txn: doc.history.begin('Drag Handle') }; return; }
    const ha = hitAnchor(t.holder.subpaths, p, tol);
    if (ha) { pd = { kind: 'convert', t, si: ha.si, pi: ha.pi, txn: doc.history.begin('Convert Anchor Point'), moved: false }; return; }
  }
  if (dr) {
    const sp = dr.t.holder.subpaths[dr.si], n = sp.points.length;
    const ha = hitAnchor([sp], p, tol);
    if (ha && ha.pi === 0 && n > 1) {
      const txn = doc.history.begin('Close Path');
      sp.closed = true;
      pd = { kind: 'new-point', t: dr.t, si: dr.si, pi: 0, txn, name: 'Close Path', moved: false, closing: true };
      touch(doc, dr.t);
      return;
    }
    if (ha && ha.pi === n - 1) {
      // click the last anchor: remove its outgoing handle (drag pulls a new one)
      const txn = doc.history.begin('Convert Anchor Point');
      const q = sp.points[n - 1]; q.ox = q.x; q.oy = q.y; q.smooth = false;
      pd = { kind: 'break', t: dr.t, si: dr.si, pi: n - 1, which: 'out', txn };
      touch(doc, dr.t);
      return;
    }
    const txn = doc.history.begin('Add Anchor Point');
    const last = sp.points[n - 1];
    const q = snapPt(s, p.shift ? snap45(last, p) : p);
    sp.points.push(corner(q.x, q.y));
    dropLive(dr.t);
    pd = { kind: 'new-point', t: dr.t, si: dr.si, pi: n, txn, name: 'Add Anchor Point', moved: false };
    touch(doc, dr.t);
    return;
  }
  // not drawing
  if (t) {
    const subs = t.holder.subpaths;
    const ha = hitAnchor(subs, p, tol);
    if (ha && isEndpoint(subs[ha.si], ha.pi)) {
      // continue an open path from its endpoint
      if (ha.pi === 0 && subs[ha.si].points.length > 1) editReverse(doc, t, ha.si);
      setDrawing(t, ha.si);
      pd = { kind: 'none' };
      doc.redrawOverlay();
      return;
    }
    if (s.autoAddDelete && ha) {
      doc.history.transaction('Delete Anchor Point', () => { deleteAnchor(subs[ha.si], ha.pi); removeIfEmpty(t, ha.si); dropLive(t); });
      touchDone(doc, t);
      pd = { kind: 'none' };
      return;
    }
    const hs = s.autoAddDelete ? hitSegment(subs, p, tol) : null;
    if (hs) {
      const txn = doc.history.begin('Add Anchor Point');
      const pi = splitSegment(subs[hs.si], hs.seg, hs.t);
      dropLive(t);
      pd = { kind: 'move-point', t, si: hs.si, pi, txn, start: { x: p.x, y: p.y }, orig: { ...subs[hs.si].points[pi] }, moved: false, created: true };
      touch(doc, t);
      return;
    }
  }
  // start a new subpath
  const txn = doc.history.begin('Pen');
  const nt = newSubpathTarget(doc, s);
  const q = snapPt(s, p);
  nt.t.holder.subpaths.push({ points: [corner(q.x, q.y)], closed: false, op: nt.op });
  const si = nt.t.holder.subpaths.length - 1;
  dropLive(nt.t);
  setDrawing(nt.t, si);
  syncSel(nt.t);
  pd = { kind: 'new-point', t: nt.t, si, pi: 0, txn, name: nt.name, moved: false };
  touch(doc, nt.t);
}
function editReverse(doc: PixDocument, t: Target, si: number) {
  doc.history.transaction('Pen', () => { reverseSub(t.holder.subpaths[si]); dropLive(t); });
}

function penMove(p: ToolPointer, doc: PixDocument) {
  const d = pd;
  if (d.kind === 'direct') { selectPointerMove(p, doc); return; }
  if (d.kind === 'new-point' || d.kind === 'convert') {
    const sp = d.t.holder.subpaths[d.si], q = sp?.points[d.pi];
    if (!q) return;
    const z = app.viewport?.zoom || 1;
    if (!d.moved && Math.hypot(p.x - q.x, p.y - q.y) * z < 2) return;
    d.moved = true;
    const v = p.shift ? snap45(q, p) : { x: p.x, y: p.y };
    if (d.kind === 'new-point' && d.closing) {
      // dragging while closing shapes the closing segment: in-handle mirrors the drag
      const m = mirror(q, v);
      q.ix = m.x; q.iy = m.y;
      if (!p.alt) { q.ox = v.x; q.oy = v.y; q.smooth = true; }
    } else {
      q.ox = v.x; q.oy = v.y;
      if (d.kind === 'convert' || !p.alt) { const m = mirror(q, v); q.ix = m.x; q.iy = m.y; q.smooth = true; } else q.smooth = false;
    }
    touch(doc, d.t);
    return;
  }
  if (d.kind === 'break') {
    const q = d.t.holder.subpaths[d.si]?.points[d.pi];
    if (!q) return;
    const v = p.shift ? snap45(q, p) : p;
    if (d.which === 'in') { q.ix = v.x; q.iy = v.y; } else { q.ox = v.x; q.oy = v.y; }
    q.smooth = false;
    dropLive(d.t);
    touch(doc, d.t);
    return;
  }
  if (d.kind === 'move-point') {
    const sp = d.t.holder.subpaths[d.si], q = sp?.points[d.pi];
    if (!q) return;
    let dx = p.x - d.start.x, dy = p.y - d.start.y;
    if (p.shift) { const s = snap45(d.start, p); dx = s.x - d.start.x; dy = s.y - d.start.y; }
    const o = d.orig;
    q.x = o.x + dx; q.y = o.y + dy; q.ix = o.ix + dx; q.iy = o.iy + dy; q.ox = o.ox + dx; q.oy = o.oy + dy;
    if (d.curvature) curvatureSmooth(sp, d.pi);
    d.moved = true;
    touch(doc, d.t);
  }
}

function penUp(p: ToolPointer, doc: PixDocument) {
  const d = pd;
  pd = { kind: 'none' };
  if (d.kind === 'direct') { selectPointerUp(p, doc); return; }
  if (d.kind === 'new-point') {
    d.txn.commit(d.name);
    if (d.closing) setDrawing(null);
    touchDone(doc, d.t);
    return;
  }
  if (d.kind === 'convert') {
    const q = d.t.holder.subpaths[d.si]?.points[d.pi];
    if (q && !d.moved) { q.ix = q.x; q.iy = q.y; q.ox = q.x; q.oy = q.y; q.smooth = false; }
    dropLive(d.t);
    d.txn.commit();
    touchDone(doc, d.t);
    return;
  }
  if (d.kind === 'move-point' && !d.moved && !d.created) { d.txn.cancel(); touchDone(doc, targetOf(doc)); return; }
  if (d.kind === 'break' || d.kind === 'move-point') { d.txn.commit(); touchDone(doc, d.t); }
}

function penHover(p: ToolPointer, doc: PixDocument, s: PenSettings) {
  ctrlHeld = p.ctrl;
  const tol = tolDoc(5);
  const dr = drawing(doc);
  const t = targetOf(doc);
  let c = CUR.start;
  if (p.alt && t && hitAnchor(t.holder.subpaths, p, tol)) c = CUR.convert;
  else if (dr) {
    const sp = dr.t.holder.subpaths[dr.si];
    const ha = hitAnchor([sp], p, tol);
    c = ha && ha.pi === 0 && sp.points.length > 1 ? CUR.close : ha ? CUR.convert : CUR.pen;
  } else if (t) {
    const ha = hitAnchor(t.holder.subpaths, p, tol);
    if (ha && isEndpoint(t.holder.subpaths[ha.si], ha.pi)) c = CUR.cont;
    else if (s.autoAddDelete && ha) c = CUR.del;
    else if (s.autoAddDelete && hitSegment(t.holder.subpaths, p, tol)) c = CUR.add;
  }
  hoverCursor = c;
  rubber = dr && s.rubberBand ? { x: p.x, y: p.y } : null;
  if (dr && s.rubberBand) doc.redrawOverlay();
}

function drawRubber(ctx: CanvasRenderingContext2D, doc: PixDocument, s: PenSettings) {
  const dr = drawing(doc);
  if (!dr || !rubber || !s.rubberBand || pd.kind !== 'none') return;
  const sp = dr.t.holder.subpaths[dr.si], a = sp.points[sp.points.length - 1];
  const v = app.viewport!;
  const A = v.docToScreen(a.x, a.y), B = v.docToScreen(a.ox, a.oy), E = v.docToScreen(rubber.x, rubber.y);
  ctx.save();
  ctx.strokeStyle = '#1473e6'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(A.x, A.y); ctx.bezierCurveTo(B.x, B.y, E.x, E.y, E.x, E.y); ctx.stroke();
  ctx.restore();
}

// ------------------------------------------------------------------ options bar
function penOptions(bar: HTMLElement, tool: Tool, s: PenSettings, extra: () => HTMLElement[] = () => []) {
  const rebuild = () => (document.querySelector('.optionsbar') as any)?.rebuild?.();
  const els: HTMLElement[] = [modeSelect(s, tool, ['shape', 'path'], rebuild), separator()];
  let sync = () => {};
  if (s.mode === 'path') {
    const mk = (text: string, cmd: string, tip: string) => h('button.btn', { type: 'button', title: tip, onclick: () => runCommand(cmd) }, text);
    els.push(label('Make:'), h('span.vo-make', null, mk('Selection…', 'paths.makeSelection', 'Make a selection from the path'), mk('Mask', 'paths.addMask', 'Add a vector mask from the path'), mk('Shape', 'paths.makeShape', 'Make a shape layer from the path')), separator());
  } else {
    const st = styleControls(), sz = sizeControls();
    els.push(...st.els, separator(), ...sz.els, separator());
    sync = () => { st.sync(); sz.sync(); };
  }
  els.push(opsButton(tool, s, s.mode === 'shape'), alignButton(), arrangeButton());
  els.push(gearButton('Set additional pen and path options', () => [h('div.vo-gear-sep'), ...extra()]));
  els.push(separator(), alignEdgesBox(s, tool));
  bar.append(...els);
  sync();
  return onVectorChange(sync);
}
const cancelKeys = (e: KeyboardEvent, doc: PixDocument | null): boolean => {
  if (!doc) return false;
  if ((e.key === 'Escape' || e.key === 'Enter') && overlay.drawing) { endDrawing(doc); return true; }
  if ((e.key === 'Backspace' || e.key === 'Delete') && !e.ctrlKey) {
    const dr = drawing(doc);
    if (dr) {
      const sp = dr.t.holder.subpaths[dr.si];
      doc.history.transaction('Delete Anchor Point', () => {
        sp.points.pop();
        if (sp.points.length) { const l = sp.points[sp.points.length - 1]; l.ox = l.x; l.oy = l.y; }
        else { dr.t.holder.subpaths.splice(dr.si, 1); overlay.drawing = null; }
      });
      touchDone(doc, dr.t);
      return true;
    }
  }
  return false;
};

// ------------------------------------------------------------------ Pen
const penTool: Tool = {
  id: 'pen', name: 'Pen Tool', group: 'pen', icon: 'pen', shortcut: 'P', order: 0, settings: penSettings,
  cursor: () => (ctrlHeld ? CUR_DIRECT : hoverCursor),
  activate() { overlay.showAnchors = true; },
  deactivate() { overlay.showAnchors = false; endDrawing(app.activeDoc); rubber = null; },
  options(bar) {
    const off = penOptions(bar, penTool, penSettings, () => [
      checkbox('Rubber Band', penSettings.rubberBand, v => { penSettings.rubberBand = v; app.saveToolSettings(penTool); }),
    ]);
    bar.insertBefore(checkbox('Auto Add/Delete', penSettings.autoAddDelete, v => { penSettings.autoAddDelete = v; app.saveToolSettings(penTool); }, { title: 'Add or delete anchor points by clicking on the path' }), bar.lastElementChild);
    return off;
  },
  pointerDown(p, doc) { penDown(p, doc, penSettings); },
  pointerMove(p, doc) { penMove(p, doc); },
  pointerUp(p, doc) { penUp(p, doc); },
  hover(p, doc) { penHover(p, doc, penSettings); },
  keyDown: cancelKeys,
  keyUp(e) { if (e.key === 'Control' || e.key === 'Meta') { ctrlHeld = false; app.viewport?.updateCursor(); } return false; },
  drawOverlay(ctx, _view, doc) { drawRubber(ctx, doc, penSettings); },
  noCtrlMove: true,
};
app.registerTool(penTool);

// ------------------------------------------------------------------ Freeform Pen (+ Magnetic)
function sobelAt(img: ImageData, x: number, y: number): number {
  const W = img.width, H = img.height, d = img.data;
  if (x < 1 || y < 1 || x >= W - 1 || y >= H - 1) return 0;
  const L = (xx: number, yy: number) => { const i = (yy * W + xx) * 4; return d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114; };
  const gx = -L(x - 1, y - 1) - 2 * L(x - 1, y) - L(x - 1, y + 1) + L(x + 1, y - 1) + 2 * L(x + 1, y) + L(x + 1, y + 1);
  const gy = -L(x - 1, y - 1) - 2 * L(x, y - 1) - L(x + 1, y - 1) + L(x - 1, y + 1) + 2 * L(x, y + 1) + L(x + 1, y + 1);
  return Math.hypot(gx, gy);
}
/** Magnetic snapping: strongest edge within the detection width (falls back to the raw point on low contrast). */
function magnetize(img: ImageData, p: Point, width: number, contrast: number): Point {
  const r = Math.max(1, Math.round(width / 2)), cx = Math.round(p.x), cy = Math.round(p.y);
  let best = -1, bx = p.x, by = p.y;
  for (let y = cy - r; y <= cy + r; y++) for (let x = cx - r; x <= cx + r; x++) {
    if ((x - cx) ** 2 + (y - cy) ** 2 > r * r) continue;
    const g = sobelAt(img, x, y) - Math.hypot(x - p.x, y - p.y) * 2;   // prefer near edges
    if (g > best) { best = g; bx = x; by = y; }
  }
  return best >= (contrast / 100) * 1020 * 0.25 ? { x: bx, y: by } : p;
}
const ffTool: Tool = {
  id: 'freeform-pen', name: 'Freeform Pen Tool', group: 'pen', icon: 'pen-freeform', shortcut: 'P', order: 1, settings: ffSettings,
  cursor: () => (ctrlHeld ? CUR_DIRECT : CUR.freeform),
  activate() { overlay.showAnchors = true; },
  deactivate() { overlay.showAnchors = false; },
  options(bar) {
    const off = penOptions(bar, ffTool, ffSettings, () => [
      h('div.vo-row', null, label('Curve Fit:'), numberField(ffSettings.curveFit, v => { ffSettings.curveFit = v; app.saveToolSettings(ffTool); }, { min: 0.5, max: 10, decimals: 1, unit: 'px', width: 52 })),
      checkbox('Magnetic', ffSettings.magnetic, v => { ffSettings.magnetic = v; app.saveToolSettings(ffTool); }),
      h('div.vo-row', null, label('Width:'), numberField(ffSettings.magWidth, v => { ffSettings.magWidth = v; app.saveToolSettings(ffTool); }, { min: 1, max: 256, unit: 'px', width: 52 })),
      h('div.vo-row', null, label('Contrast:'), numberField(ffSettings.magContrast, v => { ffSettings.magContrast = v; app.saveToolSettings(ffTool); }, { min: 1, max: 100, unit: '%', width: 52 })),
    ]);
    bar.insertBefore(checkbox('Magnetic', ffSettings.magnetic, v => { ffSettings.magnetic = v; app.saveToolSettings(ffTool); }, { title: 'Snap the freeform path to edges in the image' }), bar.lastElementChild);
    return off;
  },
  pointerDown(p, doc) {
    if (p.ctrl) { directPointerDown(p, doc); pd = { kind: 'direct' }; return; }
    const img = ffSettings.magnetic ? (() => { const c = doc.getComposite(); return c.getContext('2d')!.getImageData(0, 0, c.width, c.height); })() : null;
    const t = targetOf(doc);
    let cont: { t: Target; si: number; atStart: boolean } | null = null;
    if (t) {
      const ha = hitAnchor(t.holder.subpaths, p, tolDoc(6));
      if (ha && isEndpoint(t.holder.subpaths[ha.si], ha.pi)) cont = { t, si: ha.si, atStart: ha.pi === 0 && t.holder.subpaths[ha.si].points.length > 1 };
    }
    const start = img ? magnetize(img, p, ffSettings.magWidth, ffSettings.magContrast) : { x: p.x, y: p.y };
    pd = { kind: 'freeform', pts: [start], img, cont };
  },
  pointerMove(p, doc) {
    const d = pd;
    if (d.kind === 'direct') { selectPointerMove(p, doc); return; }
    if (d.kind !== 'freeform') return;
    const q = d.img ? magnetize(d.img, p, ffSettings.magWidth, ffSettings.magContrast) : { x: p.x, y: p.y };
    const last = d.pts[d.pts.length - 1];
    if (Math.hypot(q.x - last.x, q.y - last.y) >= 0.75 / (app.viewport?.zoom || 1)) d.pts.push(q);
    doc.redrawOverlay();
  },
  pointerUp(p, doc) {
    const d = pd;
    pd = { kind: 'none' };
    if (d.kind === 'direct') { selectPointerUp(p, doc); return; }
    if (d.kind !== 'freeform' || d.pts.length < 2) { doc.redrawOverlay(); return; }
    const z = app.viewport?.zoom || 1;
    const closed = !d.cont && d.pts.length > 8 && Math.hypot(d.pts[0].x - d.pts[d.pts.length - 1].x, d.pts[0].y - d.pts[d.pts.length - 1].y) * z < 8;
    const fitted = fitCurve(closed ? d.pts.slice(0, -1) : d.pts, Math.max(0.3, ffSettings.curveFit / Math.max(1, Math.min(4, z))), closed);
    if (fitted.length < 2) return;
    const txn = doc.history.begin('Freeform Pen');
    let t: Target;
    if (d.cont) {
      t = d.cont.t;
      const sp = t.holder.subpaths[d.cont.si];
      if (d.cont.atStart) reverseSub(sp);
      const last = sp.points[sp.points.length - 1];
      last.ox = fitted[0].ox; last.oy = fitted[0].oy; last.smooth = false;
      sp.points.push(...fitted.slice(1));
      dropLive(t);
    } else {
      const nt = newSubpathTarget(doc, ffSettings);
      t = nt.t;
      t.holder.subpaths.push({ points: fitted, closed, op: nt.op });
    }
    txn.commit();
    touchDone(doc, t);
  },
  drawOverlay(ctx, view) {
    const d = pd;
    if (d.kind !== 'freeform' || d.pts.length < 2) return;
    ctx.save();
    ctx.strokeStyle = '#1473e6'; ctx.lineWidth = 1;
    ctx.beginPath();
    d.pts.forEach((q, i) => { const s = view.docToScreen(q.x, q.y); if (i) ctx.lineTo(s.x, s.y); else ctx.moveTo(s.x, s.y); });
    ctx.stroke();
    ctx.restore();
  },
  keyDown: cancelKeys,
  keyUp(e) { if (e.key === 'Control' || e.key === 'Meta') { ctrlHeld = false; app.viewport?.updateCursor(); } return false; },
  hover(p) { ctrlHeld = p.ctrl; },
  noCtrlMove: true,
};
app.registerTool(ffTool);

// ------------------------------------------------------------------ Curvature Pen
/** Re-smooth a curvature-pen point and its neighbours (corner points keep straight handles). */
function curvatureSmooth(sp: SubPath, pi: number) {
  const n = sp.points.length;
  const only = new Set<number>();
  for (const k of [-1, 0, 1]) { const i = sp.closed ? (pi + k + n) % n : pi + k; if (i >= 0 && i < n) only.add(i); }
  autoSmooth(sp, only, 1);
}
const cvTool: Tool = {
  id: 'curvature-pen', name: 'Curvature Pen Tool', group: 'pen', icon: 'pen-curvature', shortcut: 'P', order: 2, settings: cvSettings,
  cursor: () => (ctrlHeld ? CUR_DIRECT : hoverCursor === CUR.close || hoverCursor === CUR.del ? hoverCursor : CUR.curvature),
  activate() { overlay.showAnchors = true; },
  deactivate() { overlay.showAnchors = false; endDrawing(app.activeDoc); },
  options(bar) { return penOptions(bar, cvTool, cvSettings); },
  pointerDown(p, doc) {
    if (p.ctrl) { directPointerDown(p, doc); pd = { kind: 'direct' }; return; }
    const tol = tolDoc(5);
    const t = targetOf(doc);
    const dr = drawing(doc);
    if (t) {
      syncSel(t);
      const ha = hitAnchor(t.holder.subpaths, p, tol);
      if (ha) {
        const sp = t.holder.subpaths[ha.si];
        if (dr && dr.si === ha.si && ha.pi === 0 && sp.points.length > 2) {
          doc.history.transaction('Close Path', () => { sp.closed = true; curvatureSmooth(sp, 0); curvatureSmooth(sp, sp.points.length - 1); dropLive(t); });
          setDrawing(null);
          touchDone(doc, t);
          pd = { kind: 'none' };
          return;
        }
        sel.pts = new Set([ptKey(ha.si, ha.pi)]); sel.subs.add(ha.si);
        pd = { kind: 'move-point', t, si: ha.si, pi: ha.pi, txn: doc.history.begin('Drag Anchor Point'), start: { x: p.x, y: p.y }, orig: { ...sp.points[ha.pi] }, curvature: true, moved: false };
        return;
      }
      if (!dr) {
        const hs = hitSegment(t.holder.subpaths, p, tol);
        if (hs) {
          const txn = doc.history.begin('Add Anchor Point');
          const sp = t.holder.subpaths[hs.si];
          const pi = splitSegment(sp, hs.seg, hs.t);
          sp.points[pi].smooth = true;
          curvatureSmooth(sp, pi);
          dropLive(t);
          pd = { kind: 'move-point', t, si: hs.si, pi, txn, start: { x: p.x, y: p.y }, orig: { ...sp.points[pi] }, curvature: true, moved: false, created: true };
          touch(doc, t);
          return;
        }
      }
    }
    if (dr) {
      const txn = doc.history.begin('Add Anchor Point');
      const sp = dr.t.holder.subpaths[dr.si];
      const q = snapPt(cvSettings, p);
      sp.points.push({ ...corner(q.x, q.y), smooth: true });
      const pi = sp.points.length - 1;
      curvatureSmooth(sp, pi);
      dropLive(dr.t);
      pd = { kind: 'move-point', t: dr.t, si: dr.si, pi, txn, start: { x: p.x, y: p.y }, orig: { ...sp.points[pi] }, curvature: true, moved: false, created: true };
      touch(doc, dr.t);
      return;
    }
    const txn = doc.history.begin('Curvature Pen');
    const nt = newSubpathTarget(doc, cvSettings);
    const q = snapPt(cvSettings, p);
    nt.t.holder.subpaths.push({ points: [{ ...corner(q.x, q.y), smooth: true }], closed: false, op: nt.op });
    const si = nt.t.holder.subpaths.length - 1;
    setDrawing(nt.t, si);
    txn.commit(nt.name);
    touchDone(doc, nt.t);
    pd = { kind: 'none' };
  },
  pointerMove(p, doc) { penMove(p, doc); },
  pointerUp(p, doc) { penUp(p, doc); },
  dblclick(p, doc) {
    // double-click toggles a point between smooth and corner
    const t = targetOf(doc);
    if (!t) return;
    const ha = hitAnchor(t.holder.subpaths, p, tolDoc(5));
    if (!ha) return;
    const sp = t.holder.subpaths[ha.si];
    doc.history.transaction('Convert Anchor Point', () => {
      const q = sp.points[ha.pi];
      q.smooth = !q.smooth;
      if (!q.smooth) { q.ix = q.x; q.iy = q.y; q.ox = q.x; q.oy = q.y; }
      curvatureSmooth(sp, ha.pi);
      dropLive(t);
    });
    touchDone(doc, t);
  },
  hover(p, doc) {
    ctrlHeld = p.ctrl;
    const dr = drawing(doc);
    const ha = dr ? hitAnchor([dr.t.holder.subpaths[dr.si]], p, tolDoc(5)) : null;
    hoverCursor = ha && ha.pi === 0 ? CUR.close : CUR.curvature;
    rubber = dr ? { x: p.x, y: p.y } : null;
    if (dr) doc.redrawOverlay();
  },
  drawOverlay(ctx, view, doc) {
    // preview of the next curved segment through the pointer
    const dr = drawing(doc);
    if (!dr || !rubber || pd.kind !== 'none') return;
    const sp = dr.t.holder.subpaths[dr.si];
    const preview: SubPath = { points: [...sp.points.slice(-2).map(q => ({ ...q })), { ...corner(rubber.x, rubber.y), smooth: true }], closed: false };
    const n = preview.points.length;
    if (n >= 2) { preview.points[n - 2].smooth = preview.points[n - 2].smooth !== false; autoSmooth(preview, new Set([n - 2, n - 1]), 1); }
    const a = preview.points[n - 2], b = preview.points[n - 1];
    const A = view.docToScreen(a.x, a.y), B = view.docToScreen(a.ox, a.oy), C = view.docToScreen(b.ix, b.iy), E = view.docToScreen(b.x, b.y);
    ctx.save();
    ctx.strokeStyle = '#1473e6'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(A.x, A.y); ctx.bezierCurveTo(B.x, B.y, C.x, C.y, E.x, E.y); ctx.stroke();
    ctx.restore();
  },
  keyDown(e, doc) {
    if (!doc) return false;
    if ((e.key === 'Delete' || e.key === 'Backspace') && !overlay.drawing) {
      const t = targetOf(doc);
      if (t && sel.pts.size) {
        const pts = [...sel.pts].map(k => k.split(':').map(Number)).sort((a, b) => b[1] - a[1]);
        doc.history.transaction('Delete Anchor Point', () => { for (const [si, pi] of pts) { const sp = t.holder.subpaths[si]; deleteAnchor(sp, pi); if (sp.points.length) curvatureSmooth(sp, Math.min(pi, sp.points.length - 1)); } for (let i = t.holder.subpaths.length - 1; i >= 0; i--) removeIfEmpty(t, i); dropLive(t); });
        sel.pts.clear();
        touchDone(doc, t);
        return true;
      }
    }
    return cancelKeys(e, doc);
  },
  keyUp(e) { if (e.key === 'Control' || e.key === 'Meta') { ctrlHeld = false; app.viewport?.updateCursor(); } return false; },
  noCtrlMove: true,
};
app.registerTool(cvTool);

// ------------------------------------------------------------------ Add / Delete Anchor Point, Convert Point
function simpleTool(id: string, name: string, iconName: string, order: number, cursor: string, down: (p: ToolPointer, doc: PixDocument, t: Target | null) => void, hoverCur?: (p: ToolPointer, doc: PixDocument, t: Target | null) => string): Tool {
  let cur = cursor;
  const tool: Tool = {
    id, name, group: 'pen', icon: iconName, shortcut: undefined, order,
    cursor: () => (ctrlHeld ? CUR_DIRECT : cur),
    activate() { overlay.showAnchors = true; },
    deactivate() { overlay.showAnchors = false; },
    options(bar) {
      bar.append(h('span.opt-label', null, name.replace(' Tool', '')), separator(), alignButton(), arrangeButton(), gearButton('Set additional path options'));
    },
    pointerDown(p, doc) {
      if (p.ctrl) { directPointerDown(p, doc); pd = { kind: 'direct' }; return; }
      const t = targetOf(doc);
      if (t) syncSel(t);
      if (t?.layer?.locks.all) return;
      down(p, doc, t);
    },
    pointerMove(p, doc) { penMove(p, doc); },
    pointerUp(p, doc) { penUp(p, doc); },
    hover(p, doc) { ctrlHeld = p.ctrl; if (hoverCur) cur = hoverCur(p, doc, targetOf(doc)); },
    keyUp(e) { if (e.key === 'Control' || e.key === 'Meta') { ctrlHeld = false; app.viewport?.updateCursor(); } return false; },
    noCtrlMove: true,
  };
  return tool;
}
app.registerTool(simpleTool('add-anchor', 'Add Anchor Point Tool', 'pen-add', 3, CUR.add, (p, doc, t) => {
  if (!t) return;
  const hs = hitSegment(t.holder.subpaths, p, tolDoc(5));
  if (!hs) return;
  const txn = doc.history.begin('Add Anchor Point');
  const sp = t.holder.subpaths[hs.si];
  const pi = splitSegment(sp, hs.seg, hs.t);
  dropLive(t);
  sel.pts = new Set([ptKey(hs.si, pi)]); sel.subs.add(hs.si);
  pd = { kind: 'move-point', t, si: hs.si, pi, txn, start: { x: p.x, y: p.y }, orig: { ...sp.points[pi] }, moved: false, created: true };
  touch(doc, t);
}));
app.registerTool(simpleTool('delete-anchor', 'Delete Anchor Point Tool', 'pen-delete', 4, CUR.del, (p, doc, t) => {
  if (!t) return;
  const ha = hitAnchor(t.holder.subpaths, p, tolDoc(5));
  if (!ha) return;
  doc.history.transaction('Delete Anchor Point', () => { deleteAnchor(t.holder.subpaths[ha.si], ha.pi); removeIfEmpty(t, ha.si); dropLive(t); });
  sel.pts.clear();
  touchDone(doc, t);
}));
app.registerTool(simpleTool('convert-point', 'Convert Point Tool', 'convert-point', 5, CUR.convert, (p, doc, t) => {
  if (!t) return;
  const tol = tolDoc(5);
  const vis = (si: number, pi: number) => sel.subs.has(si) || sel.pts.has(ptKey(si, pi));
  const hh = hitHandle(t.holder.subpaths, p, tol, vis);
  if (hh) { pd = { kind: 'break', t, si: hh.si, pi: hh.pi, which: hh.which, txn: doc.history.begin('Convert Anchor Point') }; return; }
  const ha = hitAnchor(t.holder.subpaths, p, tol);
  if (!ha) return;
  sel.subs.add(ha.si); sel.pts = new Set([ptKey(ha.si, ha.pi)]);
  pd = { kind: 'convert', t, si: ha.si, pi: ha.pi, txn: doc.history.begin('Convert Anchor Point'), moved: false };
}));
