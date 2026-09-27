// Shared state for the vector tools: the "target path" (active shape layer path or the path selected in the
// Paths panel), component/anchor selection, hit testing, Photoshop-style path overlay and edit helpers.
import { app } from '../../core/app';
import { events } from '../../core/events';
import type { PixDocument } from '../../core/document';
import { toPath2D, type PathOp, type PathPoint, type SubPath, type VectorPath } from '../../core/path';
import type { Point, Rect } from '../../core/types';
import { viewOptions, viewportHooks, type Viewport } from '../../core/viewport';
import { isShapeLayer, ShapeLayer } from '../../layers/shape-layer';
import { insideSub, nearestOnCubic, segCount, segCtrl, tightBounds, unionRects, cloneSubs, translateSubs, assignHoleOps } from './geom';
import { fitCurve } from './fit';
import { createCanvas, ctx2d } from '../../core/canvas';
import { traceAlpha } from '../../core/path';
import { drawShapeMask } from '../../layers/shape-layer';

export const VECTOR_TOOLS = new Set(['pen', 'freeform-pen', 'curvature-pen', 'add-anchor', 'delete-anchor', 'convert-point', 'path-select', 'direct-select', 'shape-rect', 'shape-ellipse', 'shape-triangle', 'shape-polygon', 'shape-line', 'shape-custom']);
export const SHAPE_TOOL_IDS = ['shape-rect', 'shape-ellipse', 'shape-triangle', 'shape-polygon', 'shape-line', 'shape-custom'];
export const PEN_TOOL_IDS = ['pen', 'freeform-pen', 'curvature-pen'];

// ------------------------------------------------------------------ path display options (gear › Path Options)
export const pathOptions: { thickness: number; color: string } = (() => {
  try { return { thickness: 1, color: '#1473e6', ...JSON.parse(localStorage.getItem('pixora.vector.pathOptions') || '{}') }; } catch { return { thickness: 1, color: '#1473e6' }; }
})();
export function savePathOptions() { try { localStorage.setItem('pixora.vector.pathOptions', JSON.stringify(pathOptions)); } catch { /* ignore */ } app.activeDoc?.redrawOverlay(); }
export const PATH_COLORS: [string, string][] = [['Default', '#1473e6'], ['Black', '#000000'], ['Red', '#ff2a2a'], ['Green', '#1fb41f'], ['Blue', '#2255ff'], ['Yellow', '#ffe000'], ['Magenta', '#ff00ff'], ['Cyan', '#00e5ff'], ['Light Gray', '#bfbfbf'], ['White', '#ffffff']];

// ------------------------------------------------------------------ target path
export interface Target { kind: 'layer' | 'path'; holder: { subpaths: SubPath[] }; layer: ShapeLayer | null; path: VectorPath | null; key: string }

const pathSel = new WeakMap<PixDocument, number>();
/** >0 = id of the selected path in doc.paths, 0 = the active shape layer's path, -1 = no path selected. */
export const getPathSel = (doc: PixDocument) => pathSel.get(doc) ?? 0;
export function setPathSel(doc: PixDocument, v: number) {
  if (getPathSel(doc) === v) return;
  pathSel.set(doc, v);
  events.emit('paths', doc);
  doc.redrawOverlay();
}
events.on('activeLayer', doc => { if (isShapeLayer(doc.activeLayer) && getPathSel(doc) !== 0) { pathSel.set(doc, 0); events.emit('paths', doc); } });

export function targetOf(doc: PixDocument): Target | null {
  const s = getPathSel(doc);
  if (s > 0) {
    const p = doc.paths.find((x: VectorPath) => x.id === s) as VectorPath | undefined;
    if (p) return { kind: 'path', holder: p, layer: null, path: p, key: 'p' + p.id };
  }
  if (s === 0) {
    const l = doc.activeLayer;
    if (isShapeLayer(l)) return { kind: 'layer', holder: l, layer: l, path: null, key: 'l' + l.id };
  }
  return null;
}
export const layerTarget = (l: ShapeLayer): Target => ({ kind: 'layer', holder: l, layer: l, path: null, key: 'l' + l.id });
export const pathTarget = (p: VectorPath): Target => ({ kind: 'path', holder: p, layer: null, path: p, key: 'p' + p.id });

export function nextPathId(doc: PixDocument): number { return Math.max(0, ...doc.paths.map((p: VectorPath) => p.id)) + 1; }
export function nextPathName(doc: PixDocument): string {
  let n = 1;
  while (doc.paths.some((p: VectorPath) => p.name === `Path ${n}`)) n++;
  return `Path ${n}`;
}
/** Path that new Path-mode drawing goes into: the selected work/saved path, else a fresh Work Path (replacing the old one). */
export function pathForDrawing(doc: PixDocument): VectorPath {
  const s = getPathSel(doc);
  const cur = s > 0 ? (doc.paths.find((p: VectorPath) => p.id === s) as VectorPath | undefined) : undefined;
  if (cur) return cur;
  doc.paths = doc.paths.filter((p: VectorPath) => p.kind !== 'work');
  const wp: VectorPath = { id: nextPathId(doc), name: 'Work Path', kind: 'work', subpaths: [] };
  doc.paths.unshift(wp);
  pathSel.set(doc, wp.id);
  events.emit('paths', doc);
  return wp;
}

// ------------------------------------------------------------------ selection (components / anchors)
export const sel = { key: '', subs: new Set<number>(), pts: new Set<string>() };
export const ptKey = (si: number, pi: number) => `${si}:${pi}`;
export function syncSel(t: Target | null) {
  if (!t || sel.key !== t.key) { sel.key = t?.key || ''; sel.subs.clear(); sel.pts.clear(); }
  if (t) {
    const n = t.holder.subpaths.length;
    for (const s of [...sel.subs]) if (s >= n) sel.subs.delete(s);
    for (const k of [...sel.pts]) { const [si, pi] = k.split(':').map(Number); if (si >= n || pi >= t.holder.subpaths[si].points.length) sel.pts.delete(k); }
  }
}
export function clearSel() { sel.subs.clear(); sel.pts.clear(); }
export function selectedPts(t: Target): [number, number][] {
  syncSel(t);
  return [...sel.pts].map(k => k.split(':').map(Number) as [number, number]);
}

// ------------------------------------------------------------------ hit testing (doc coords; tol in doc px)
export const tolDoc = (px = 5) => px / (app.viewport?.zoom || 1);
export function hitAnchor(subs: SubPath[], p: Point, tol: number, only?: Set<number>): { si: number; pi: number } | null {
  let best: { si: number; pi: number } | null = null, bd = tol;
  subs.forEach((sp, si) => {
    if (only && !only.has(si)) return;
    sp.points.forEach((q, pi) => { const d = Math.hypot(q.x - p.x, q.y - p.y); if (d <= bd) { bd = d; best = { si, pi }; } });
  });
  return best;
}
export function hitHandle(subs: SubPath[], p: Point, tol: number, visible: (si: number, pi: number) => boolean): { si: number; pi: number; which: 'in' | 'out' } | null {
  let best: { si: number; pi: number; which: 'in' | 'out' } | null = null, bd = tol;
  subs.forEach((sp, si) => sp.points.forEach((q, pi) => {
    if (!visible(si, pi)) return;
    for (const which of ['in', 'out'] as const) {
      const hx = which === 'in' ? q.ix : q.ox, hy = which === 'in' ? q.iy : q.oy;
      if (hx === q.x && hy === q.y) continue;
      const d = Math.hypot(hx - p.x, hy - p.y);
      if (d <= bd) { bd = d; best = { si, pi, which }; }
    }
  }));
  return best;
}
export function hitSegment(subs: SubPath[], p: Point, tol: number, only?: Set<number>): { si: number; seg: number; t: number; pt: Point } | null {
  let best: { si: number; seg: number; t: number; pt: Point } | null = null, bd = tol;
  subs.forEach((sp, si) => {
    if (only && !only.has(si)) return;
    const n = segCount(sp);
    for (let i = 0; i < n; i++) {
      const [a, b, c, d] = segCtrl(sp, i);
      const x0 = Math.min(a.x, b.x, c.x, d.x) - tol, x1 = Math.max(a.x, b.x, c.x, d.x) + tol;
      const y0 = Math.min(a.y, b.y, c.y, d.y) - tol, y1 = Math.max(a.y, b.y, c.y, d.y) + tol;
      if (p.x < x0 || p.x > x1 || p.y < y0 || p.y > y1) continue;
      const r = nearestOnCubic(a, b, c, d, p);
      if (r.d <= bd) { bd = r.d; best = { si, seg: i, t: r.t, pt: r.pt }; }
    }
  });
  return best;
}
/** Topmost subpath containing p (closed or not), searching from the end. */
export function hitInside(subs: SubPath[], p: Point): number {
  for (let i = subs.length - 1; i >= 0; i--) if (subs[i].points.length > 2 && insideSub(subs[i], p)) return i;
  return -1;
}
/** Topmost visible shape layer whose rendered shape contains p (Path Selection "All Layers"). */
export function shapeLayerAt(doc: PixDocument, p: Point, tol: number): ShapeLayer | null {
  const visible = (l: any): boolean => l.visible && (!l._parent || visible(l._parent));
  const list = doc.allLayers().reverse();
  for (const l of list) {
    if (!isShapeLayer(l) || !visible(l)) continue;
    if (hitInside(l.subpaths, p) >= 0 || hitSegment(l.subpaths, p, tol + (l.stroke.enabled ? l.stroke.width / 2 : 0))) return l;
  }
  return null;
}

// ------------------------------------------------------------------ edit helpers
/** Content changed during an interactive edit (cheap). */
export function touch(doc: PixDocument, t: Target | null) {
  if (t?.layer) { t.layer.invalidate(); doc.invalidate(); }
  doc.redrawOverlay();
}
/** Edit finished: notify panels. */
export function touchDone(doc: PixDocument, t: Target | null) {
  if (t?.layer) { t.layer.invalidate(); doc.layersChanged(); }
  events.emit('paths', doc);
  doc.redrawOverlay();
}
/** A live shape was edited as a path → it becomes a regular path (Photoshop converts live shapes). */
export function dropLive(t: Target | null) { if (t?.layer && t.layer.live) t.layer.live = null; }

/** Run a structural path edit as one history state. */
export function editTarget(doc: PixDocument, t: Target, name: string, fn: (subs: SubPath[]) => void, keepLive = false) {
  doc.history.transaction(name, () => {
    fn(t.holder.subpaths);
    if (!keepLive) dropLive(t);
    if (t.layer) t.layer.invalidate();
  });
  touchDone(doc, t);
}

export function boundsOfSubs(subs: SubPath[], idx?: Iterable<number>): Rect | null {
  if (!idx) return tightBounds(subs);
  return unionRects([...idx].map(i => subs[i] ? tightBounds([subs[i]]) : null));
}

// ------------------------------------------------------------------ path operations / merge
export const OP_LABELS: Record<string, string> = {
  new: 'New Layer', add: 'Combine Shapes', subtract: 'Subtract Front Shape', intersect: 'Intersect Shape Areas', exclude: 'Exclude Overlapping Shapes', merge: 'Merge Shape Components',
};
export const OP_ICONS: Record<string, string> = { new: 'vop-new', add: 'vop-add', subtract: 'vop-subtract', intersect: 'vop-intersect', exclude: 'vop-exclude', merge: 'vop-merge' };

/** Boolean-merge subpaths into clean outlines (raster union at supersampling → traced → fitted curves). */
export function mergeComponents(subs: SubPath[]): SubPath[] {
  const b = tightBounds(subs);
  if (!b || b.w < 0.5 || b.h < 0.5) return [];
  const s = Math.max(1, Math.min(4, Math.sqrt(6e6 / Math.max(1, (b.w + 4) * (b.h + 4)))));
  const W = Math.ceil((b.w + 4) * s), H = Math.ceil((b.h + 4) * s);
  const c = createCanvas(W, H), x = ctx2d(c);
  x.setTransform(s, 0, 0, s, (-b.x + 2) * s, (-b.y + 2) * s);
  drawShapeMask(x, subs);
  const loops = traceAlpha(c, 0.6 * s * 0.25 + 0.4, 128);
  const back = (q: Point): Point => ({ x: q.x / s + b.x - 2, y: q.y / s + b.y - 2 });
  const out: SubPath[] = loops.map(lp => {
    const poly = lp.points.map(back);
    return { closed: true, points: fitCornerCurve(poly, 0.35, true) };
  }).filter(sp => sp.points.length >= 2);
  return assignHoleOps(out, 'add');
}

/** Fit a polyline keeping sharp corners (turn > 50°) as corner anchors. */
export function fitCornerCurve(poly: Point[], error: number, closed: boolean): PathPoint[] {
  const n = poly.length;
  if (n < 3) return fitCurve(poly, error, closed);
  const turn = (i: number) => {
    const a = poly[(i - 1 + n) % n], b = poly[i], c = poly[(i + 1) % n];
    const v1x = b.x - a.x, v1y = b.y - a.y, v2x = c.x - b.x, v2y = c.y - b.y;
    const l1 = Math.hypot(v1x, v1y), l2 = Math.hypot(v2x, v2y);
    if (!l1 || !l2) return 0;
    return Math.acos(Math.max(-1, Math.min(1, (v1x * v2x + v1y * v2y) / (l1 * l2))));
  };
  const corners: number[] = [];
  for (let i = closed ? 0 : 1; i < (closed ? n : n - 1); i++) if (turn(i) > (50 * Math.PI) / 180) corners.push(i);
  if (!corners.length) return fitCurve(poly, error, closed);
  const pts: PathPoint[] = [];
  const pieces: Point[][] = [];
  if (closed) {
    for (let k = 0; k < corners.length; k++) {
      const a = corners[k], bb = corners[(k + 1) % corners.length];
      const piece: Point[] = [];
      for (let i = a; ; i = (i + 1) % n) { piece.push(poly[i]); if (i === bb && piece.length > 1) break; if (piece.length > n + 1) break; }
      pieces.push(piece);
    }
  } else {
    let start = 0;
    for (const c of [...corners, n - 1]) { pieces.push(poly.slice(start, c + 1)); start = c; }
  }
  for (const piece of pieces) {
    const f = fitCurve(piece, error, false);
    if (!f.length) continue;
    if (pts.length) {
      const last = pts[pts.length - 1];
      last.ox = f[0].ox; last.oy = f[0].oy; last.smooth = false;
      pts.push(...f.slice(1));
    } else pts.push(...f);
  }
  if (closed && pts.length > 1) {
    const last = pts.pop()!;
    pts[0].ix = last.ix; pts[0].iy = last.iy; pts[0].smooth = false;
  }
  return pts;
}

/** Apply a path operation to selected components (or all when none selected). 'merge' merges everything. */
export function applyOpToTarget(doc: PixDocument, t: Target, op: PathOp | 'merge') {
  syncSel(t);
  const subs = t.holder.subpaths;
  if (!subs.length) return;
  if (op === 'merge') {
    editTarget(doc, t, 'Merge Shape Components', s => { const m = mergeComponents(s); s.splice(0, s.length, ...m); });
    clearSel();
    return;
  }
  const idx = sel.subs.size ? [...sel.subs] : subs.map((_, i) => i);
  editTarget(doc, t, OP_LABELS[op], s => { for (const i of idx) if (s[i]) s[i].op = op; }, true);
}

// ------------------------------------------------------------------ alignment / arrangement of components
export function alignComponents(doc: PixDocument, t: Target, how: string, toCanvas: boolean) {
  syncSel(t);
  const subs = t.holder.subpaths;
  const idx = sel.subs.size ? [...sel.subs] : subs.map((_, i) => i);
  if (!idx.length) return;
  const ref = toCanvas ? { x: 0, y: 0, w: doc.width, h: doc.height } : boundsOfSubs(subs, idx);
  if (!ref) return;
  const bs = idx.map(i => tightBounds([subs[i]])!);
  editTarget(doc, t, 'Align', s => {
    if (how.startsWith('dist')) {
      const order = idx.map((i, k) => ({ i, b: bs[k] })).sort((a, b) => how === 'distH' ? a.b.x + a.b.w / 2 - (b.b.x + b.b.w / 2) : a.b.y + a.b.h / 2 - (b.b.y + b.b.h / 2));
      if (order.length < 3) return;
      const c0 = how === 'distH' ? order[0].b.x + order[0].b.w / 2 : order[0].b.y + order[0].b.h / 2;
      const last = order[order.length - 1].b, c1 = how === 'distH' ? last.x + last.w / 2 : last.y + last.h / 2;
      order.forEach((o, k) => {
        const target = c0 + ((c1 - c0) * k) / (order.length - 1);
        const cur = how === 'distH' ? o.b.x + o.b.w / 2 : o.b.y + o.b.h / 2;
        translateSubs([s[o.i]], how === 'distH' ? target - cur : 0, how === 'distV' ? target - cur : 0);
      });
      return;
    }
    idx.forEach((i, k) => {
      const b = bs[k];
      let dx = 0, dy = 0;
      if (how === 'left') dx = ref.x - b.x;
      else if (how === 'hcenter') dx = ref.x + ref.w / 2 - (b.x + b.w / 2);
      else if (how === 'right') dx = ref.x + ref.w - (b.x + b.w);
      else if (how === 'top') dy = ref.y - b.y;
      else if (how === 'vcenter') dy = ref.y + ref.h / 2 - (b.y + b.h / 2);
      else if (how === 'bottom') dy = ref.y + ref.h - (b.y + b.h);
      translateSubs([s[i]], dx, dy);
    });
  });
}
export function arrangeComponents(doc: PixDocument, t: Target, how: 'front' | 'forward' | 'backward' | 'back') {
  syncSel(t);
  const subs = t.holder.subpaths;
  if (!sel.subs.size || subs.length < 2) return;
  const picked = new Set(sel.subs);
  const names = { front: 'Bring Shape to Front', forward: 'Bring Shape Forward', backward: 'Send Shape Backward', back: 'Send Shape to Back' };
  let order = subs.map((s, i) => ({ s, i }));
  if (how === 'front') order = [...order.filter(o => !picked.has(o.i)), ...order.filter(o => picked.has(o.i))];
  else if (how === 'back') order = [...order.filter(o => picked.has(o.i)), ...order.filter(o => !picked.has(o.i))];
  else if (how === 'forward') { for (let k = order.length - 2; k >= 0; k--) if (picked.has(order[k].i) && !picked.has(order[k + 1].i)) [order[k], order[k + 1]] = [order[k + 1], order[k]]; }
  else { for (let k = 1; k < order.length; k++) if (picked.has(order[k].i) && !picked.has(order[k - 1].i)) [order[k], order[k - 1]] = [order[k - 1], order[k]]; }
  editTarget(doc, t, names[how], s => { const copy = order.map(o => o.s); s.splice(0, s.length, ...copy); }, true);
  sel.subs.clear();
  order.forEach((o, k) => { if (picked.has(o.i)) sel.subs.add(k); });
}

// ------------------------------------------------------------------ overlay
/** Transient overlay state written by tools. */
export const overlay = {
  hover: null as SubPath[] | null,
  /** Subpath index being drawn by the pen (anchors shown, last selected). */
  drawing: null as { key: string; si: number } | null,
  /** Show all anchors of the target path (direct-select / pen style). */
  showAnchors: false,
  marquee: null as Rect | null,
};

function drawOutline(ctx: CanvasRenderingContext2D, view: Viewport, subs: SubPath[], width = pathOptions.thickness, color = pathOptions.color) {
  if (!subs.length) return;
  const m = view.matrix();
  ctx.lineWidth = width;
  ctx.strokeStyle = color;
  ctx.stroke(toPath2D(subs, m));
}
export function drawAnchor(ctx: CanvasRenderingContext2D, x: number, y: number, filled: boolean, size = 6) {
  const h = size / 2;
  ctx.fillStyle = filled ? pathOptions.color : '#fff';
  ctx.fillRect(Math.round(x) - h, Math.round(y) - h, size, size);
  ctx.lineWidth = 1;
  ctx.strokeStyle = pathOptions.color;
  ctx.strokeRect(Math.round(x) - h + 0.5, Math.round(y) - h + 0.5, size - 1, size - 1);
}
function drawHandle(ctx: CanvasRenderingContext2D, view: Viewport, q: PathPoint, which: 'in' | 'out') {
  const hx = which === 'in' ? q.ix : q.ox, hy = which === 'in' ? q.iy : q.oy;
  if (hx === q.x && hy === q.y) return;
  const a = view.docToScreen(q.x, q.y), b = view.docToScreen(hx, hy);
  ctx.lineWidth = 1;
  ctx.strokeStyle = pathOptions.color;
  ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
  ctx.fillStyle = pathOptions.color;
  ctx.beginPath(); ctx.arc(b.x, b.y, 3, 0, Math.PI * 2); ctx.fill();
}

/** Draw a subpath's anchors: which = 'hollow' (direct select), 'filled' (component selected). */
export function drawComponent(ctx: CanvasRenderingContext2D, view: Viewport, t: Target, si: number, mode: 'hollow' | 'filled' | 'drawing') {
  const sp = t.holder.subpaths[si];
  if (!sp) return;
  const n = sp.points.length;
  const handleSet = new Set<number>();
  if (mode === 'hollow') {
    for (let pi = 0; pi < n; pi++) if (sel.pts.has(ptKey(si, pi))) {
      handleSet.add(pi);
      if (sp.closed || pi > 0) handleSet.add((pi - 1 + n) % n);
      if (sp.closed || pi < n - 1) handleSet.add((pi + 1) % n);
    }
  } else if (mode === 'drawing') { handleSet.add(n - 1); if (n > 1) handleSet.add(n - 2); }
  for (const pi of handleSet) {
    const q = sp.points[pi];
    const selPt = mode === 'drawing' ? pi === n - 1 : sel.pts.has(ptKey(si, pi));
    if (selPt) { drawHandle(ctx, view, q, 'in'); drawHandle(ctx, view, q, 'out'); }
    else {
      // neighbours only show the handle facing the selected anchor's segment
      const next = (pi + 1) % n, prev = (pi - 1 + n) % n;
      if (mode === 'drawing') { if (pi === n - 2) drawHandle(ctx, view, q, 'out'); continue; }
      if (sel.pts.has(ptKey(si, next))) drawHandle(ctx, view, q, 'out');
      if (sel.pts.has(ptKey(si, prev))) drawHandle(ctx, view, q, 'in');
    }
  }
  sp.points.forEach((q, pi) => {
    const s = view.docToScreen(q.x, q.y);
    const filled = mode === 'filled' || (mode === 'hollow' && sel.pts.has(ptKey(si, pi))) || (mode === 'drawing' && pi === n - 1);
    drawAnchor(ctx, s.x, s.y, filled);
  });
}

viewportHooks.overlay.push((ctx, view, doc) => {
  if (!viewOptions.extras || !viewOptions.targetPath) return;
  const t = targetOf(doc);
  const tool = app.currentTool?.id || '';
  if (overlay.hover && VECTOR_TOOLS.has(tool)) drawOutline(ctx, view, overlay.hover, Math.max(1, pathOptions.thickness) + 1);
  if (!t) return;
  syncSel(t);
  drawOutline(ctx, view, t.holder.subpaths);
  if (!VECTOR_TOOLS.has(tool)) return;
  const d = overlay.drawing && overlay.drawing.key === t.key ? overlay.drawing.si : -1;
  t.holder.subpaths.forEach((_, si) => {
    if (si === d) drawComponent(ctx, view, t, si, 'drawing');
    else if (sel.subs.has(si)) drawComponent(ctx, view, t, si, tool === 'path-select' ? 'filled' : 'hollow');
    else if (overlay.showAnchors && tool !== 'path-select' && !SHAPE_TOOL_IDS.includes(tool)) drawComponent(ctx, view, t, si, 'hollow');
  });
});

/** Marquee rectangle (path/direct selection) — screen space. */
export function drawMarquee(ctx: CanvasRenderingContext2D, view: Viewport, r: Rect) {
  const a = view.docToScreen(r.x, r.y), b = view.docToScreen(r.x + r.w, r.y + r.h);
  ctx.save();
  ctx.strokeStyle = '#000'; ctx.lineWidth = 1; ctx.setLineDash([4, 4]);
  ctx.strokeRect(Math.round(Math.min(a.x, b.x)) + 0.5, Math.round(Math.min(a.y, b.y)) + 0.5, Math.round(Math.abs(b.x - a.x)), Math.round(Math.abs(b.y - a.y)));
  ctx.strokeStyle = '#fff'; ctx.lineDashOffset = 4;
  ctx.strokeRect(Math.round(Math.min(a.x, b.x)) + 0.5, Math.round(Math.min(a.y, b.y)) + 0.5, Math.round(Math.abs(b.x - a.x)), Math.round(Math.abs(b.y - a.y)));
  ctx.restore();
}

/** Small HUD near the pointer (W/H while drawing shapes, like Photoshop's transform values). */
export function drawHud(ctx: CanvasRenderingContext2D, view: Viewport, lines: string[]) {
  if (!view.pointer.inside) return;
  ctx.save();
  ctx.font = '600 11px Segoe UI, system-ui, sans-serif';
  const w = Math.max(...lines.map(l => ctx.measureText(l).width)) + 16, hh = lines.length * 15 + 8;
  const x = view.pointer.sx + 18, y = view.pointer.sy + 18;
  ctx.fillStyle = 'rgba(40,40,40,.92)';
  ctx.beginPath(); (ctx as any).roundRect ? (ctx as any).roundRect(x, y, w, hh, 4) : ctx.rect(x, y, w, hh); ctx.fill();
  ctx.fillStyle = '#f0f0f0';
  lines.forEach((l, i) => ctx.fillText(l, x + 8, y + 16 + i * 15));
  ctx.restore();
}

export { cloneSubs };
