// Edit > Free Transform (Ctrl+T), Edit > Transform > Scale / Rotate / Skew / Distort / Perspective / Warp /
// Rotate 180° / 90° CW / 90° CCW / Flip Horizontal / Flip Vertical, and Transform Again (Shift+Ctrl+T).
//
// Targets: the selected layers (groups expand to their layers) with their linked masks; with a selection on a single
// pixel layer the selected pixels float and are transformed together with the selection; with a layer mask being
// edited only the mask. Raster pixels are resampled on commit (Nearest / Bilinear / Bicubic); shape, text, fill and
// smart object layers receive the affine matrix (applyMatrix) so they stay editable.
//
// Interaction (Photoshop): drag inside = move, handles = scale (corners keep proportions; Shift toggles), Alt = from
// the reference point, outside = rotate (Shift: 15°), Ctrl+corner = distort, Ctrl+side = skew, Ctrl+Alt+Shift+corner =
// perspective, drag the reference point, arrow keys nudge, Enter / double-click commits, Esc cancels. Warp mode
// shows a 4×4 Bézier grid with presets (Arc, Bulge, Flag, Wave, Fish, Twist…).
import './transform.css';
import { app, type Tool, type ToolPointer } from '../../core/app';
import type { PixDocument } from '../../core/document';
import { GroupLayer, RasterLayer, type Layer, type LayerContent } from '../../core/layer';
import { registerCommands } from '../../core/commands';
import { hooks } from '../../core/registry';
import { alphaBounds, createCanvas, cropCanvas, ctx2d } from '../../core/canvas';
import { intersectRect, unionRect } from '../../core/geom';
import type { Point, Rect } from '../../core/types';
import type { Viewport } from '../../core/viewport';
import { h } from '../../ui/dom';
import { checkbox, iconButton, numberField, select, separator, type Field } from '../../ui/widgets';
import { openMenu } from '../../ui/menu';
import { svgCursor } from '../../ui/cursors';
import { toast } from '../../ui/toast';
import { WARP_STYLES, warpXY, type WarpSettings, type WarpStyle } from '../../layers/text-layer';
import {
  affineOf, evalGrid, gridFromMap, isParallelogram, quadBounds, rectQuad, rectToQuad, quadToRect, renderMapped,
  type Grid, type Interp, type Mapping, type Quad,
} from './geom';

export type TMode = 'free' | 'scale' | 'rotate' | 'skew' | 'distort' | 'perspective' | 'warp';
type HandleId = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7;          // corners tl,tr,br,bl then edges t,r,b,l
const HANDLE_UV: [number, number][] = [[0, 0], [1, 0], [1, 1], [0, 1], [0.5, 0], [1, 0.5], [0.5, 1], [0, 0.5]];

interface Item {
  layer: Layer;
  kind: 'raster' | 'vector' | 'smart' | 'mask';
  src: HTMLCanvasElement; r: Rect;                            // content (doc coords) before the transform
  hole?: LayerContent;                                        // raster float: what stays behind
  mask?: { src: HTMLCanvasElement; r: Rect; bg: number; orig: { canvas: HTMLCanvasElement; x: number; y: number } };
}
interface State {
  doc: PixDocument; items: Item[]; B: Rect; q: Quad; grid: Grid | null; preset: WarpSettings | null;
  mode: TMode; pivot: Point; link: boolean; interp: Interp; prevTool: string;
  selFloat: HTMLCanvasElement | null;                         // selection mask moving with floated pixels
  history: string;
  maskOrig?: { canvas: HTMLCanvasElement; x: number; y: number };
  drag: null | { kind: 'move' | 'scale' | 'rotate' | 'skew' | 'distort' | 'perspective' | 'pivot' | 'grid'; h?: number; start: Point; q0: Quad; grid0: Grid | null; pivot0: Point };
  raf: number;
}
let st: State | null = null;
let showPivot = localStorage.getItem('pixora.transform.pivot') === '1';
let lastRel: null | { affine: DOMMatrix } | { quad: Point[] } = null;
const fields: Partial<Record<'x' | 'y' | 'w' | 'hh' | 'a' | 'sh' | 'sv', Field<number>>> = {};

// ================================================================== geometry helpers
const tp = (m: DOMMatrix, p: Point): Point => { const r = m.transformPoint(new DOMPoint(p.x, p.y)); return { x: r.x, y: r.y }; };
const isAffine = (s: State) => !s.grid && !s.preset && isParallelogram(s.q);

/** Source (doc) point → destination point for the current transform. */
function pointMap(s: State): (p: Point) => Point {
  const B = s.B;
  if (s.grid) { const g = s.grid; return p => evalGrid(g, (p.x - B.x) / (B.w || 1), (p.y - B.y) / (B.h || 1)); }
  const H = rectToQuad(B, s.q);
  if (s.preset && s.preset.style !== 'none') {
    const w = s.preset, cx = B.x + B.w / 2, cy = B.y + B.h / 2;
    return p => { const [X, Y] = warpXY(w, p.x - cx, p.y - cy, B.w / 2, B.h / 2); return H({ x: cx + X, y: cy + Y }); };
  }
  return H;
}
function mappingFor(s: State, r: Rect): Mapping {
  if (isAffine(s)) return { kind: 'affine', m: affineOf(s.B, s.q) };
  const f = pointMap(s);
  return { kind: 'mesh', f: (u, v) => f({ x: r.x + u * r.w, y: r.y + v * r.h }) };
}
const handlePt = (s: State, i: number) => { const [u, v] = HANDLE_UV[i]; return pointMap(s)({ x: s.B.x + s.B.w * u, y: s.B.y + s.B.h * v }); };

/** Apply a doc-space affine matrix to the current transform (quad / grid / pivot). */
function applyAffine(s: State, m: DOMMatrix) {
  s.q = s.q.map(p => tp(m, p)) as Quad;
  if (s.grid) s.grid = s.grid.map(p => tp(m, p));
  s.pivot = tp(m, s.pivot);
}
function decompose(s: State) {
  const m = affineOf(s.B, s.q);
  const sx = Math.hypot(m.a, m.b), det = m.a * m.d - m.b * m.c, sy = sx ? det / sx : 0;
  const ang = Math.atan2(m.b, m.a);
  const shear = sx && sy ? (m.a * m.c + m.b * m.d) / (sx * sx) : 0;
  const z = (v: number) => (Math.abs(v) < 1e-9 ? 0 : v);
  return { x: s.pivot.x, y: s.pivot.y, w: sx * 100, hh: sy * 100, a: z((ang * 180) / Math.PI), sh: z((Math.atan(shear) * 180) / Math.PI), sv: 0 };
}
function fromFields(v: { x: number; y: number; w: number; hh: number; a: number; sh: number; sv: number }) {
  const s = st;
  if (!s) return;
  if (!isAffine(s)) { toast('Numeric transform values apply to scale / rotate / skew only.', 'info'); syncFields(); return; }
  const piv = tp(affineOf(s.B, s.q).inverse(), s.pivot);    // pivot in source space
  const m = new DOMMatrix().translate(v.x, v.y).rotate(v.a)
    .multiply(new DOMMatrix([1, Math.tan((v.sv * Math.PI) / 180), Math.tan((v.sh * Math.PI) / 180), 1, 0, 0]))
    .scale((v.w || 0.1) / 100, (v.hh || 0.1) / 100).translate(-piv.x, -piv.y);
  s.q = rectQuad(s.B).map(p => tp(m, p)) as Quad;
  s.pivot = { x: v.x, y: v.y };
  schedule();
}
function syncFields() {
  const s = st;
  if (!s) return;
  const d = decompose(s), aff = isAffine(s);
  fields.x?.setValue(d.x); fields.y?.setValue(d.y);
  for (const [k, val] of [['w', d.w], ['hh', d.hh], ['a', d.a], ['sh', d.sh], ['sv', d.sv]] as const) { const f = fields[k]; if (f) { f.setValue(val); (f.querySelector?.('input') || f as any).disabled = !aff; } }
}

// ================================================================== targets
function leafLayers(list: Layer[]): Layer[] {
  const out: Layer[] = [];
  const walk = (l: Layer) => { if (l instanceof GroupLayer) l.children.forEach(walk); else out.push(l); };
  list.forEach(walk);
  return [...new Set(out)];
}
function contentOf(doc: PixDocument, l: Layer): { canvas: HTMLCanvasElement; r: Rect } | null {
  const c = l.getContent(doc);
  if (!c) return null;
  const b = alphaBounds(c.canvas);
  if (!b) return null;
  return { canvas: cropCanvas(c.canvas, b), r: { x: c.x + b.x, y: c.y + b.y, w: b.w, h: b.h } };
}
function maskInfo(l: Layer): Item['mask'] | undefined {
  const m = l.mask;
  if (!m || !m.linked) return undefined;
  return { src: m.canvas, r: { x: m.x, y: m.y, w: m.canvas.width, h: m.canvas.height }, bg: m.bg, orig: { canvas: m.canvas, x: m.x, y: m.y } };
}
const fail = (msg: string) => { toast(msg, 'error', 3600); return null; };

function gatherItems(doc: PixDocument, mode: TMode, what: string): { items: Item[]; selFloat: HTMLCanvasElement | null } | null {
  if (doc.quickMask) return fail(`Could not complete the ${what} command because Quick Mask mode is active.`);
  const active = doc.activeLayer;
  if (doc.editMask && active?.mask) {
    const m = active.mask;
    const b = alphaBounds(m.canvas) || { x: 0, y: 0, w: m.canvas.width, h: m.canvas.height };
    return { items: [{ layer: active, kind: 'mask', src: cropCanvas(m.canvas, b), r: { x: m.x + b.x, y: m.y + b.y, w: b.w, h: b.h } }], selFloat: null };
  }
  let layers = leafLayers(doc.selectedLayers.length ? doc.selectedLayers : active ? [active] : []);
  layers = layers.filter(l => l.kind !== 'adjustment');
  if (!layers.length) return fail(`Could not complete the ${what} command because no layer is selected.`);
  const sel = !doc.selection.empty;
  // floating selection on a single pixel layer
  if (sel && layers.length === 1 && layers[0] instanceof RasterLayer) {
    const l = layers[0] as RasterLayer;
    if (l.pixelsLocked) return fail(`Could not complete the ${what} command because the layer is locked.`);
    const S = doc.selection.bounds!;
    const lr = intersectRect(S, { x: l.x, y: l.y, w: l.canvas.width, h: l.canvas.height });
    if (!lr) return fail(`Could not complete the ${what} command because the selected area is empty.`);
    const fl = createCanvas(lr.w, lr.h), fx = ctx2d(fl);
    fx.drawImage(l.canvas, l.x - lr.x, l.y - lr.y);
    fx.globalCompositeOperation = 'destination-in'; fx.drawImage(doc.selection.mask!, -lr.x, -lr.y);
    const b = alphaBounds(fl);
    if (!b) return fail(`Could not complete the ${what} command because the selected area is empty.`);
    const hole = createCanvas(l.canvas.width, l.canvas.height), hx = ctx2d(hole);
    hx.drawImage(l.canvas, 0, 0);
    hx.globalCompositeOperation = 'destination-out'; hx.drawImage(doc.selection.mask!, -l.x, -l.y);
    if (l.isBackground) {
      // the Background has no transparency: the hole shows the background colour
      const f = createCanvas(l.canvas.width, l.canvas.height), ffx = ctx2d(f);
      ffx.fillStyle = `rgb(${app.bg.r},${app.bg.g},${app.bg.b})`; ffx.fillRect(0, 0, f.width, f.height);
      ffx.drawImage(hole, 0, 0);
      hx.globalCompositeOperation = 'copy'; hx.drawImage(f, 0, 0);
    }
    return {
      items: [{ layer: l, kind: 'raster', src: cropCanvas(fl, b), r: { x: lr.x + b.x, y: lr.y + b.y, w: b.w, h: b.h }, hole: { canvas: hole, x: l.x, y: l.y } }],
      selFloat: doc.selection.mask,
    };
  }
  const items: Item[] = [];
  for (const l of layers) {
    if (l.positionLocked) return fail(l.isBackground ? `Could not complete the ${what} command because the layer is locked. Convert the Background into a normal layer first (double-click it in the Layers panel).` : `Could not complete the ${what} command because the layer “${l.name}” is locked.`);
    const c = contentOf(doc, l);
    if (!c) continue;
    const kind: Item['kind'] = l instanceof RasterLayer ? 'raster' : l.kind === 'smart' ? 'smart' : 'vector';
    if (kind === 'vector' && l.kind === 'text' && (mode === 'distort' || mode === 'perspective')) return fail(`Could not complete the ${what} command because the type layer does not support distortions. Rasterize the type layer first.`);
    if (kind === 'vector' && typeof (l as any).applyMatrix !== 'function') continue;
    items.push({ layer: l, kind, src: c.canvas, r: c.r, mask: maskInfo(l) });
  }
  if (!items.length) return fail(`Could not complete the ${what} command because the selected layers are empty.`);
  return { items, selFloat: null };
}

// ================================================================== preview / commit
function schedule() {
  const s = st;
  if (!s || s.raf) return;
  s.raf = requestAnimationFrame(() => { if (st) { st.raf = 0; renderPreview(st); } });
  syncFields();
}
function renderMask(s: State, mk: NonNullable<Item['mask']>, quality: 'preview' | 'final') {
  const res = renderMapped(mk.src, mk.r, mappingFor(s, mk.r), 'bilinear', quality);
  if (mk.bg === 255) {
    // outside the transformed mask stays revealed
    const c = createCanvas(res.canvas.width, res.canvas.height), x = ctx2d(c);
    x.fillStyle = '#000'; x.fillRect(0, 0, c.width, c.height);
    const full = createCanvas(mk.src.width, mk.src.height); ctx2d(full).fillRect(0, 0, full.width, full.height);
    const cover = renderMapped(full, mk.r, mappingFor(s, mk.r), 'bilinear', quality);
    x.globalCompositeOperation = 'destination-out'; x.drawImage(cover.canvas, cover.x - res.x, cover.y - res.y);
    x.globalCompositeOperation = 'source-over'; x.drawImage(res.canvas, 0, 0);
    return { canvas: c, x: res.x, y: res.y };
  }
  return res;
}
function renderItem(s: State, it: Item, quality: 'preview' | 'final'): LayerContent {
  const res = renderMapped(it.src, it.r, mappingFor(s, it.r), s.interp, quality);
  if (!it.hole) return res;
  const hr = { x: it.hole.x, y: it.hole.y, w: it.hole.canvas.width, h: it.hole.canvas.height };
  const u = unionRect(hr, { x: res.x, y: res.y, w: res.canvas.width, h: res.canvas.height })!;
  const bounded = (it.layer as RasterLayer).isBackground ? intersectRect(u, { x: 0, y: 0, w: s.doc.width, h: s.doc.height }) || u : u;
  const c = createCanvas(bounded.w, bounded.h), x = ctx2d(c);
  x.drawImage(it.hole.canvas, hr.x - bounded.x, hr.y - bounded.y);
  x.drawImage(res.canvas, res.x - bounded.x, res.y - bounded.y);
  return { canvas: c, x: bounded.x, y: bounded.y };
}
function renderPreview(s: State) {
  for (const it of s.items) {
    if (it.kind === 'mask') {
      const r = renderMask(s, { src: it.src, r: it.r, bg: it.layer.mask!.bg, orig: null as any }, 'preview');
      const m = it.layer.mask!;
      m.canvas = r.canvas; m.x = r.x; m.y = r.y;
      it.layer.invalidate();
    } else {
      it.layer._preview = renderItem(s, it, 'preview');
      if (it.mask) { const r = renderMask(s, it.mask, 'preview'); const m = it.layer.mask!; m.canvas = r.canvas; m.x = r.x; m.y = r.y; }
      it.layer.invalidate();
    }
  }
  s.doc.invalidate();
  s.doc.redrawOverlay();
}
/** Put everything back as it was before the transform started (masks were replaced live). */
function restore(s: State) {
  for (const it of s.items) {
    it.layer._preview = null;
    if (it.kind === 'mask') { const m = it.layer.mask!; m.canvas = s.maskOrig!.canvas; m.x = s.maskOrig!.x; m.y = s.maskOrig!.y; }
    if (it.mask) { const m = it.layer.mask!; m.canvas = it.mask.orig.canvas; m.x = it.mask.orig.x; m.y = it.mask.orig.y; }
    it.layer.invalidate();
  }
}

function commit(s: State) {
  const same = (a: Point[], b: Point[]) => a.every((p, i) => Math.abs(p.x - b[i].x) < 1e-6 && Math.abs(p.y - b[i].y) < 1e-6);
  const rq = rectQuad(s.B);
  const identity = !s.preset && same(s.q, rq) && (!s.grid || same(s.grid, gridFromMap(s.B, rectToQuad(s.B, rq))));
  if (s.raf) { cancelAnimationFrame(s.raf); s.raf = 0; }
  restore(s);
  if (identity) { s.doc.invalidate(); return; }
  const aff = isAffine(s), M = aff ? affineOf(s.B, s.q) : null, pm = pointMap(s);
  // results computed before the transaction (pure rendering)
  const results = s.items.map(it => {
    if (it.kind === 'mask') return renderMask(s, { src: it.src, r: it.r, bg: it.layer.mask!.bg, orig: null as any }, 'final');
    if (it.kind === 'raster' || (!aff && it.kind === 'smart')) return renderItem(s, it, 'final');
    return null;
  });
  const maskResults = s.items.map(it => (it.mask ? renderMask(s, it.mask, 'final') : null));
  const selRes = s.selFloat ? renderMapped(s.selFloat, { x: 0, y: 0, w: s.doc.width, h: s.doc.height }, mappingFor(s, { x: 0, y: 0, w: s.doc.width, h: s.doc.height }), 'bilinear', 'final', { x: 0, y: 0, w: s.doc.width, h: s.doc.height }) : null;
  s.doc.history.transaction(s.history, () => {
    s.items.forEach((it, i) => {
      const l = it.layer as any, r = results[i];
      if (it.kind === 'mask') { const m = it.layer.mask!; m.canvas = r!.canvas; m.x = r!.x; m.y = r!.y; }
      else if (it.kind === 'raster') { l.canvas = r!.canvas; l.x = r!.x; l.y = r!.y; }
      else if (it.kind === 'smart') {
        if (aff) l.applyMatrix(M!);
        else { l.source = r!.canvas; l.contents = null; l.matrix = [1, 0, 0, 1, r!.x, r!.y]; }
      } else if (aff) withoutLinkedMask(it.layer, () => l.applyMatrix(M!));
      else if (Array.isArray(l.subpaths)) {
        // shapes: distort / warp the path points
        l.subpaths = l.subpaths.map((sp: any) => ({ ...sp, points: sp.points.map((q: any) => { const a = pm(q), ii = pm({ x: q.ix, y: q.iy }), o = pm({ x: q.ox, y: q.oy }); return { ...q, x: a.x, y: a.y, ix: ii.x, iy: ii.y, ox: o.x, oy: o.y }; }) }));
        if ('live' in l) l.live = null;
      }
      const mr = maskResults[i];
      if (mr) { const m = it.layer.mask!; m.canvas = mr.canvas; m.x = mr.x; m.y = mr.y; }
      it.layer.invalidate();
    });
    if (selRes) {
      const c = createCanvas(s.doc.width, s.doc.height);
      ctx2d(c).drawImage(selRes.canvas, selRes.x, selRes.y);
      s.doc.selection.setMask(c);
    }
  });
  // remember for Transform Again
  lastRel = aff ? { affine: M! } : { quad: s.q.map(p => ({ x: (p.x - s.B.x) / (s.B.w || 1), y: (p.y - s.B.y) / (s.B.h || 1) })) };
  s.doc.layersChanged();
  s.doc.pixelsChanged(null, null);
}
/** applyMatrix on vector layers also moves a linked mask; masks are transformed separately here. */
function withoutLinkedMask(l: Layer, fn: () => void) {
  const m = l.mask;
  if (!m) { fn(); return; }
  const keep = { canvas: m.canvas, x: m.x, y: m.y };
  fn();
  m.canvas = keep.canvas; m.x = keep.x; m.y = keep.y;
}

// ================================================================== start / end
const HISTORY: Record<TMode, string> = { free: 'Free Transform', scale: 'Scale', rotate: 'Rotate', skew: 'Skew', distort: 'Distort', perspective: 'Perspective', warp: 'Warp' };

export function startTransform(mode: TMode = 'free'): boolean {
  const doc = app.activeDoc;
  if (!doc) return false;
  if (st) { setMode(mode); return true; }
  const g = gatherItems(doc, mode, HISTORY[mode]);
  if (!g) return false;
  let B: Rect | null = null;
  for (const it of g.items) B = unionRect(B, it.r);
  const prev = app.activeTool?.id && app.activeTool.id !== tool.id ? app.activeTool.id : 'move';
  st = {
    doc, items: g.items, B: B!, q: rectQuad(B!), grid: null, preset: null, mode, pivot: { x: B!.x + B!.w / 2, y: B!.y + B!.h / 2 },
    link: true, interp: (localStorage.getItem('pixora.transform.interp') as Interp) || 'bicubic', prevTool: prev, selFloat: g.selFloat,
    history: HISTORY[mode], drag: null, raf: 0,
  };
  const mi = g.items.find(i => i.kind === 'mask');
  if (mi) st.maskOrig = { canvas: mi.layer.mask!.canvas, x: mi.layer.mask!.x, y: mi.layer.mask!.y };
  if (mode === 'warp') enterWarp(st);
  if (g.selFloat && app.viewport) app.viewport.hideSelection = true;
  app.setTool(tool.id);
  renderPreview(st);
  syncFields();
  return true;
}
function setMode(mode: TMode) {
  const s = st;
  if (!s) return;
  if (mode === 'warp') enterWarp(s);          // leaving warp keeps the warp; handles then edit the quad again
  s.mode = mode;
  if (s.history === 'Free Transform' || s.history === HISTORY[s.mode]) s.history = mode === 'free' ? s.history : HISTORY[mode];
  (document.querySelector('.optionsbar') as any)?.rebuild?.();
  app.saveToolSettings(tool);
  schedule();
}
function enterWarp(s: State) {
  s.mode = 'warp';
  s.history = 'Warp';
  if (!s.grid && !s.preset) s.grid = gridFromMap(s.B, pointMap(s));
}
function end(apply: boolean, switchBack = true) {
  const s = st;
  if (!s) return;
  st = null;
  if (apply) commit(s); else { restore(s); s.doc.invalidate(); }
  if (app.viewport) app.viewport.hideSelection = false;
  s.doc.redrawOverlay();
  if (switchBack && app.activeTool?.id === tool.id) app.setTool(s.prevTool);
}

// ================================================================== instant operations
const INSTANT: Record<string, { name: string; m: (c: Point) => DOMMatrix }> = {
  rotate180: { name: 'Rotate 180°', m: c => new DOMMatrix().translate(c.x, c.y).rotate(180).translate(-c.x, -c.y) },
  rotate90cw: { name: 'Rotate 90° Clockwise', m: c => new DOMMatrix().translate(c.x, c.y).rotate(90).translate(-c.x, -c.y) },
  rotate90ccw: { name: 'Rotate 90° Counter Clockwise', m: c => new DOMMatrix().translate(c.x, c.y).rotate(-90).translate(-c.x, -c.y) },
  flipH: { name: 'Flip Horizontal', m: c => new DOMMatrix().translate(c.x, c.y).scale(-1, 1).translate(-c.x, -c.y) },
  flipV: { name: 'Flip Vertical', m: c => new DOMMatrix().translate(c.x, c.y).scale(1, -1).translate(-c.x, -c.y) },
};
function instant(op: string) {
  const spec = INSTANT[op];
  if (!spec) return;
  if (st) { applyAffine(st, spec.m(st.pivot)); schedule(); return; }
  if (!startTransform('free')) return;
  const s = st!;
  // 90° rotations of pixels snap to whole pixels around the centre
  const c = { x: s.B.x + s.B.w / 2, y: s.B.y + s.B.h / 2 };
  if (op === 'rotate90cw' || op === 'rotate90ccw') { if ((s.B.w - s.B.h) % 2) c.x += 0.5; }
  applyAffine(s, spec.m(c));
  s.history = spec.name;
  s.interp = 'nearest';
  end(true);
}
function transformAgain() {
  if (!lastRel) return;
  if (!startTransform('free')) return;
  const s = st!;
  const rel = lastRel;
  if ('affine' in rel) s.q = rectQuad(s.B).map(p => tp(rel.affine, p)) as Quad;
  else s.q = rel.quad.map(p => ({ x: s.B.x + p.x * s.B.w, y: s.B.y + p.y * s.B.h })) as Quad;
  s.history = 'Transform Again';
  end(true);
}

// ================================================================== hit testing & cursors
function hit(s: State, view: Viewport, p: ToolPointer): { kind: 'pivot' | 'handle' | 'grid' | 'move' | 'rotate'; i?: number } {
  const near = (q: Point, r = 7) => { const sc = view.docToScreen(q.x, q.y); return Math.hypot(sc.x - p.sx, sc.y - p.sy) <= r; };
  if (s.mode === 'warp') {
    const g = s.grid;
    if (g) for (let i = 0; i < 16; i++) if (near(g[i], 7)) return { kind: 'grid', i };
    return { kind: 'move' };
  }
  if (showPivot && near(s.pivot, 7) && !p.alt) return { kind: 'pivot' };
  for (let i = 0; i < 8; i++) if (near(handlePt(s, i))) return { kind: 'handle', i };
  // inside the (possibly projective) quad?
  const inv = s.grid || s.preset ? null : quadToRect(s.B, s.q);
  if (inv) { const l = inv(p); if (l.x >= s.B.x && l.x <= s.B.x + s.B.w && l.y >= s.B.y && l.y <= s.B.y + s.B.h) return { kind: 'move' }; }
  else { const b = quadBounds([0, 1, 2, 3].map(i => handlePt(s, i))); if (p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h) return { kind: 'move' }; }
  return { kind: s.mode === 'scale' || s.mode === 'distort' || s.mode === 'perspective' || s.mode === 'skew' ? 'move' : 'rotate' };
}
const ROT_CURSOR = svgCursor('<path d="M5 13a7 7 0 0 1 12-5"/><path d="M17 3v5h-5"/><path d="M19 11a7 7 0 0 1-12 5"/><path d="M7 21v-5h5"/>', 12, 12, 'crosshair');
const DISTORT_CURSOR = svgCursor('<path d="m3 2 0 12 3.2-3.2 2.3 5 1.8-.9-2.3-5H12z" fill="#fff"/>', 3, 2, 'default');
const SKEW_CURSOR = svgCursor('<path d="m3 2 0 12 3.2-3.2 2.3 5 1.8-.9-2.3-5H12z" fill="#fff"/><path d="M14 18h7M16 16l-2 2 2 2M19 16l2 2-2 2"/>', 3, 2, 'default');
function arrowCursor(s: State, i: number): string {
  const c = pointMap(s)({ x: s.B.x + s.B.w / 2, y: s.B.y + s.B.h / 2 }), q = handlePt(s, i);
  const a = ((Math.atan2(q.y - c.y, q.x - c.x) * 180) / Math.PI + 360) % 180;
  return a < 22.5 || a >= 157.5 ? 'ew-resize' : a < 67.5 ? 'nwse-resize' : a < 112.5 ? 'ns-resize' : 'nesw-resize';
}

// ================================================================== drag handling
function dragMove(s: State, p: ToolPointer) {
  const d = s.drag!;
  const dx = p.x - d.start.x, dy = p.y - d.start.y;
  const B = s.B;
  const H0 = rectToQuad(B, d.q0), inv0 = quadToRect(B, d.q0);
  switch (d.kind) {
    case 'pivot': s.pivot = { x: d.pivot0.x + dx, y: d.pivot0.y + dy }; break;
    case 'move': {
      let mx = dx, my = dy;
      if (p.shift) { if (Math.abs(mx) > Math.abs(my)) my = 0; else mx = 0; }
      const m = new DOMMatrix().translate(mx, my);
      s.q = d.q0.map(q => tp(m, q)) as Quad;
      if (d.grid0) s.grid = d.grid0.map(q => tp(m, q));
      s.pivot = tp(m, d.pivot0);
      break;
    }
    case 'rotate': {
      const c = d.pivot0;
      let a = (Math.atan2(p.y - c.y, p.x - c.x) - Math.atan2(d.start.y - c.y, d.start.x - c.x)) * 180 / Math.PI;
      if (p.shift) {
        const base = (Math.atan2(d.q0[1].y - d.q0[0].y, d.q0[1].x - d.q0[0].x) * 180) / Math.PI;
        a = Math.round((base + a) / 15) * 15 - base;
      }
      const m = new DOMMatrix().translate(c.x, c.y).rotate(a).translate(-c.x, -c.y);
      s.q = d.q0.map(q => tp(m, q)) as Quad;
      if (d.grid0) s.grid = d.grid0.map(q => tp(m, q));
      break;
    }
    case 'distort': {
      const i = d.h!;
      s.q = d.q0.map((q, k) => (k === i ? { x: q.x + dx, y: q.y + dy } : q)) as Quad;
      break;
    }
    case 'perspective': {
      const i = d.h!;
      const l0 = inv0(d.start), l1 = inv0(p);
      const horizontal = Math.abs(l1.x - l0.x) * B.h >= Math.abs(l1.y - l0.y) * B.w;
      // partner corner on the same edge
      const partner = horizontal ? [1, 0, 3, 2][i] : [3, 2, 1, 0][i];
      const e = horizontal ? { x: d.q0[1].x - d.q0[0].x, y: d.q0[1].y - d.q0[0].y } : { x: d.q0[3].x - d.q0[0].x, y: d.q0[3].y - d.q0[0].y };
      const el = Math.hypot(e.x, e.y) || 1, ux = e.x / el, uy = e.y / el, t = dx * ux + dy * uy;
      s.q = d.q0.map((q, k) => (k === i ? { x: q.x + ux * t, y: q.y + uy * t } : k === partner ? { x: q.x - ux * t, y: q.y - uy * t } : q)) as Quad;
      break;
    }
    case 'skew': {
      // move the edge along its own direction (side handles), in source space
      const i = d.h!, l0 = inv0(d.start), l1 = inv0(p);
      let m: DOMMatrix;
      if (i === 4 || i === 6) { // top / bottom: shear x
        const ay = i === 4 ? B.y + B.h : B.y, k = (l1.x - l0.x) / ((i === 4 ? B.y : B.y + B.h) - ay || 1);
        m = new DOMMatrix([1, 0, k, 1, -k * ay, 0]);
      } else {
        const ax = i === 5 ? B.x : B.x + B.w, k = (l1.y - l0.y) / ((i === 5 ? B.x + B.w : B.x) - ax || 1);
        m = new DOMMatrix([1, k, 0, 1, 0, -k * ax]);
      }
      s.q = rectQuad(B).map(q => H0(tp(m, q))) as Quad;
      break;
    }
    case 'scale': {
      const i = d.h!, [u, v] = HANDLE_UV[i];
      const l = inv0(p);
      const piv = inv0(d.pivot0);
      const fromPivot = p.alt;
      const hx = B.x + B.w * u, hy = B.y + B.h * v;
      const ax = fromPivot ? piv.x : B.x + B.w * (1 - u), ay = fromPivot ? piv.y : B.y + B.h * (1 - v);
      let sx = u === 0.5 ? 1 : (l.x - ax) / (hx - ax || 1);
      let sy = v === 0.5 ? 1 : (l.y - ay) / (hy - ay || 1);
      const corner = i < 4;
      const keep = corner ? s.link !== p.shift : p.shift;
      if (keep) {
        if (u === 0.5) sx = Math.abs(sy) * Math.sign(sx || 1);
        else if (v === 0.5) sy = Math.abs(sx) * Math.sign(sy || 1);
        else { const k = Math.max(Math.abs(sx), Math.abs(sy)); sx = k * Math.sign(sx || 1); sy = k * Math.sign(sy || 1); }
      }
      if (Math.abs(sx) < 1e-3) sx = 1e-3; if (Math.abs(sy) < 1e-3) sy = 1e-3;
      const m = new DOMMatrix().translate(ax, ay).scale(sx, sy).translate(-ax, -ay);
      s.q = rectQuad(B).map(q => H0(tp(m, q))) as Quad;
      if (!fromPivot) s.pivot = H0(tp(m, piv));
      break;
    }
    case 'grid': {
      const i = d.h!;
      const g = d.grid0!.slice();
      g[i] = { x: g[i].x + dx, y: g[i].y + dy };
      // dragging a corner anchor moves its handles too
      const r = Math.floor(i / 4), c = i % 4;
      if ((r === 0 || r === 3) && (c === 0 || c === 3)) {
        const nb = [[r, c === 0 ? 1 : 2], [r === 0 ? 1 : 2, c], [r === 0 ? 1 : 2, c === 0 ? 1 : 2]];
        for (const [rr, cc] of nb) { const k = rr * 4 + cc; g[k] = { x: d.grid0![k].x + dx, y: d.grid0![k].y + dy }; }
      }
      s.grid = g; s.preset = null;
      break;
    }
  }
}

// ================================================================== tool
const tool: Tool = {
  id: 'free-transform', name: 'Free Transform', group: 'free-transform', icon: 'move', noCtrlMove: true,
  cursor: () => {
    const s = st, v = app.viewport;
    if (!s || !v) return 'default';
    const p = v.pointer as any as ToolPointer;
    if (s.drag) return s.drag.kind === 'move' ? 'move' : s.drag.kind === 'rotate' ? ROT_CURSOR : s.drag.kind === 'scale' ? arrowCursor(s, s.drag.h!) : s.drag.kind === 'skew' ? SKEW_CURSOR : s.drag.kind === 'pivot' ? 'crosshair' : DISTORT_CURSOR;
    const r = hit(s, v, { ...p, alt: false } as ToolPointer);
    if (r.kind === 'pivot') return 'crosshair';
    if (r.kind === 'grid') return 'pointer';
    if (r.kind === 'handle') {
      const ctrl = (p as any).ctrl;
      if (s.mode === 'distort' || s.mode === 'perspective' || (ctrl && r.i! < 4)) return DISTORT_CURSOR;
      if (s.mode === 'skew' || (ctrl && r.i! >= 4)) return SKEW_CURSOR;
      if (s.mode === 'rotate') return ROT_CURSOR;
      return arrowCursor(s, r.i!);
    }
    return r.kind === 'move' ? 'move' : ROT_CURSOR;
  },
  options(bar) {
    const s = st;
    if (!s) return;
    if (s.mode === 'warp') { buildWarpBar(bar, s); return; }
    // reference point locator
    const loc = h('div.ft-ref', { title: 'Reference point location' });
    for (let j = 0; j < 3; j++) for (let i = 0; i < 3; i++) {
      const b = h('button.ft-ref-dot', { type: 'button', title: 'Set the reference point' });
      b.addEventListener('click', () => { const S = st; if (!S) return; S.pivot = pointMap(S)({ x: S.B.x + (S.B.w * i) / 2, y: S.B.y + (S.B.h * j) / 2 }); schedule(); });
      loc.append(b);
    }
    const cur = () => (st ? decompose(st) : { x: 0, y: 0, w: 100, hh: 100, a: 0, sh: 0, sv: 0 });
    const d = cur();
    const nf = (k: keyof typeof fields, label: string, unit: string, title: string, dec = 1) => {
      const f = numberField((d as any)[k], v => fromFields({ ...cur(), [k]: v } as any), { label, unit, width: k === 'x' || k === 'y' ? 64 : 54, decimals: dec, title });
      fields[k] = f;
      return f;
    };
    const link = iconButton('link', 'Maintain aspect ratio', () => { const S = st; if (!S) return; S.link = !S.link; link.classList.toggle('active', S.link); }, { active: s.link });
    const interp = select<Interp>([{ value: 'nearest', label: 'Nearest Neighbor' }, { value: 'bilinear', label: 'Bilinear' }, { value: 'bicubic', label: 'Bicubic' }], s.interp, v => { if (st) { st.interp = v; localStorage.setItem('pixora.transform.interp', v); schedule(); } }, { width: 130, title: 'Interpolation' });
    const pv = checkbox('', showPivot, v => { showPivot = v; localStorage.setItem('pixora.transform.pivot', v ? '1' : '0'); st?.doc.redrawOverlay(); }, { title: 'Toggle reference point (show it to drag it; Alt-click sets it)' });
    bar.append(pv, loc, separator(),
      nf('x', 'X:', 'px', 'Horizontal position of the reference point'), nf('y', 'Y:', 'px', 'Vertical position of the reference point'), separator(),
      nf('w', 'W:', '%', 'Horizontal scale'), link, nf('hh', 'H:', '%', 'Vertical scale'), separator(),
      h('span.opt-group', { title: 'Rotate' }, h('span.opt-label', null, '∠'), nf('a', '', '°', 'Rotation angle')), separator(),
      nf('sh', 'H:', '°', 'Horizontal skew'), nf('sv', 'V:', '°', 'Vertical skew'), separator(),
      h('span.opt-label', null, 'Interpolation:'), interp,
      iconButton('warp', 'Switch between free transform and warp modes', () => setMode('warp')),
      h('span.ft-flex'),
      iconButton('cancel', 'Cancel transform (Esc)', () => end(false)), iconButton('commit', 'Commit transform (Enter)', () => end(true)));
    syncFields();
    return () => { for (const k of Object.keys(fields)) delete (fields as any)[k]; };
  },
  isModal: () => !!st,
  commit: () => end(true),
  cancel: () => end(false),
  deactivate() { if (st) end(true, false); },
  pointerDown(p, _doc) {
    const s = st, v = app.viewport;
    if (!s || !v) return;
    const r = hit(s, v, p);
    const base = { start: { x: p.x, y: p.y }, q0: s.q.map(q => ({ ...q })) as Quad, grid0: s.grid ? s.grid.map(q => ({ ...q })) : null, pivot0: { ...s.pivot } };
    let kind: NonNullable<State['drag']>['kind'];
    if (p.alt && r.kind !== 'handle' && r.kind !== 'grid' && s.mode !== 'warp') { s.pivot = { x: p.x, y: p.y }; s.doc.redrawOverlay(); syncFields(); return; }
    if (r.kind === 'grid') kind = 'grid';
    else if (r.kind === 'pivot') kind = 'pivot';
    else if (r.kind === 'handle') {
      const i = r.i!, corner = i < 4;
      if (s.mode === 'rotate') kind = 'rotate';
      else if (s.mode === 'distort' || (p.ctrl && corner && !(p.alt && p.shift))) kind = corner ? 'distort' : 'skew';
      else if (s.mode === 'perspective' || (p.ctrl && p.alt && p.shift && corner)) kind = corner ? 'perspective' : 'skew';
      else if (s.mode === 'skew' || (p.ctrl && !corner)) kind = corner ? 'distort' : 'skew';
      else kind = 'scale';
      if ((kind === 'scale' || kind === 'skew') && (s.grid || s.preset)) { s.grid = null; s.preset = null; }
    } else if (r.kind === 'move') kind = s.mode === 'rotate' ? 'rotate' : 'move';
    else kind = 'rotate';
    s.drag = { kind, h: r.i, ...base };
  },
  pointerMove(p) {
    const s = st;
    if (!s?.drag) return;
    dragMove(s, p);
    schedule();
  },
  pointerUp() { if (st) { st.drag = null; st.doc.redrawOverlay(); } },
  dblclick(p) { const s = st, v = app.viewport; if (s && v && hit(s, v, p).kind === 'move') end(true); },
  keyDown(e) {
    const s = st;
    if (!s) return false;
    const map: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    const v = map[e.key];
    if (v) { const k = e.shiftKey ? 10 : 1; applyAffine(s, new DOMMatrix().translate(v[0] * k, v[1] * k)); schedule(); return true; }
    return false;
  },
  contextMenu(p) {
    const s = st;
    if (!s) return;
    const e = p.event as MouseEvent;
    const it = (label: string, mode: TMode) => ({ label, radio: true, checked: s.mode === mode, action: () => setMode(mode) });
    openMenu([
      it('Free Transform', 'free'), '-', it('Scale', 'scale'), it('Rotate', 'rotate'), it('Skew', 'skew'), it('Distort', 'distort'), it('Perspective', 'perspective'), it('Warp', 'warp'), '-',
      ...Object.entries(INSTANT).map(([k, v]) => ({ label: v.name, action: () => instant(k) })), '-',
      { label: 'Commit Transform', action: () => end(true) }, { label: 'Cancel Transform', action: () => end(false) },
    ], { x: e.clientX, y: e.clientY }, { minWidth: 210 });
  },
  drawOverlay(ctx, view) {
    const s = st;
    if (!s) return;
    const pm = pointMap(s);
    const scr = (p: Point) => view.docToScreen(p.x, p.y);
    ctx.save();
    // transformed selection outline for floated pixels
    if (s.selFloat && isAffine(s)) {
      const path = s.doc.selection.outline();
      if (path) {
        ctx.save();
        view.applyDocTransform(ctx);
        const m = affineOf(s.B, s.q);
        ctx.transform(m.a, m.b, m.c, m.d, m.e, m.f);
        const k = Math.sqrt(Math.abs(m.a * m.d - m.b * m.c)) || 1, px = 1 / (view.zoom * k);
        ctx.lineWidth = px; ctx.strokeStyle = '#fff'; ctx.stroke(path);
        ctx.setLineDash([4 * px, 4 * px]); ctx.lineDashOffset = -view.antsPhase * px; ctx.strokeStyle = '#000'; ctx.stroke(path);
        ctx.restore();
      }
    }
    ctx.strokeStyle = '#1e8bff'; ctx.lineWidth = 1;
    // box edges (curved for warps)
    const n = s.grid || s.preset || !isParallelogram(s.q) ? 24 : 1;
    const edge = (u0: number, v0: number, u1: number, v1: number) => {
      for (let k = 0; k <= n; k++) { const t = k / n, p = scr(pm({ x: s.B.x + s.B.w * (u0 + (u1 - u0) * t), y: s.B.y + s.B.h * (v0 + (v1 - v0) * t) })); if (k) ctx.lineTo(p.x, p.y); else ctx.moveTo(p.x, p.y); }
    };
    ctx.beginPath(); edge(0, 0, 1, 0); edge(1, 0, 1, 1); edge(1, 1, 0, 1); edge(0, 1, 0, 0); ctx.stroke();
    if (s.mode === 'warp') {
      // inner grid lines at thirds
      ctx.globalAlpha = 0.8;
      ctx.beginPath();
      for (const t of [1 / 3, 2 / 3]) { edge(t, 0, t, 1); edge(0, t, 1, t); }
      ctx.stroke();
      ctx.globalAlpha = 1;
      if (s.grid) {
        const g = s.grid;
        // handle lines from corners
        ctx.beginPath();
        for (const [a, b] of [[0, 1], [0, 4], [3, 2], [3, 7], [12, 13], [12, 8], [15, 14], [15, 11]]) { const pa = scr(g[a]), pb = scr(g[b]); ctx.moveTo(pa.x, pa.y); ctx.lineTo(pb.x, pb.y); }
        ctx.stroke();
        g.forEach((q, i) => {
          const sc = scr(q), r = Math.floor(i / 4), c = i % 4, anchor = (r === 0 || r === 3) && (c === 0 || c === 3);
          ctx.fillStyle = '#fff';
          ctx.beginPath();
          if (anchor) ctx.rect(Math.round(sc.x) - 3.5, Math.round(sc.y) - 3.5, 7, 7); else ctx.arc(sc.x, sc.y, 3.5, 0, Math.PI * 2);
          ctx.fill(); ctx.stroke();
        });
      }
    } else {
      for (let i = 0; i < 8; i++) {
        const sc = scr(handlePt(s, i));
        ctx.fillStyle = '#fff';
        ctx.fillRect(Math.round(sc.x) - 3.5, Math.round(sc.y) - 3.5, 7, 7);
        ctx.strokeRect(Math.round(sc.x) - 3.5, Math.round(sc.y) - 3.5, 7, 7);
      }
      if (showPivot) {
        const c = scr(s.pivot);
        ctx.beginPath(); ctx.arc(c.x, c.y, 4.5, 0, Math.PI * 2); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(c.x - 7, c.y); ctx.lineTo(c.x + 7, c.y); ctx.moveTo(c.x, c.y - 7); ctx.lineTo(c.x, c.y + 7); ctx.stroke();
      }
    }
    // value HUD while dragging
    if (s.drag && app.prefs.showTransformValues && s.drag.kind !== 'grid') {
      const d = decompose(s);
      const txt = s.drag.kind === 'rotate' ? `${d.a.toFixed(1)}°` : s.drag.kind === 'move' ? `ΔX: ${Math.round(s.q[0].x - s.drag.q0[0].x)} px  ΔY: ${Math.round(s.q[0].y - s.drag.q0[0].y)} px` : `W: ${d.w.toFixed(1)}%  H: ${d.hh.toFixed(1)}%`;
      const p = view.pointer;
      ctx.font = '600 11px Segoe UI, system-ui, sans-serif';
      const w = ctx.measureText(txt).width + 16;
      ctx.fillStyle = 'rgba(38,38,38,.93)'; ctx.beginPath(); ctx.roundRect(p.sx + 16, p.sy + 16, w, 22, 4); ctx.fill();
      ctx.fillStyle = '#f0f0f0'; ctx.fillText(txt, p.sx + 24, p.sy + 31);
    }
    ctx.restore();
  },
};
app.registerTool(tool);

// ------------------------------------------------------------------ warp options bar
function buildWarpBar(bar: HTMLElement, s: State) {
  const w: WarpSettings = s.preset ? { ...s.preset } : { style: 'none', horizontal: true, bend: 50, hDistort: 0, vDistort: 0 };
  const opts = [{ value: 'custom', label: 'Custom' }, ...WARP_STYLES.filter(x => x.value !== 'none').map(x => ({ value: x.value as string, label: x.label }))];
  const apply = () => {
    const S = st;
    if (!S) return;
    if (w.style === 'none') { S.preset = null; if (!S.grid) S.grid = gridFromMap(S.B, pointMap(S)); }
    else { S.grid = null; S.preset = { ...w }; }
    schedule();
  };
  const style = select<string>(opts, s.preset ? s.preset.style : 'custom', v => { w.style = (v === 'custom' ? 'none' : v) as WarpStyle; apply(); sync(); }, { width: 130, title: 'Warp style' });
  const orient = iconButton('rotate-cw', 'Change the warp orientation', () => { w.horizontal = !w.horizontal; apply(); });
  const bend = numberField(w.bend, v => { w.bend = v; apply(); }, { label: 'Bend:', unit: '%', min: -100, max: 100, width: 54, title: 'Bend' });
  const hd = numberField(w.hDistort, v => { w.hDistort = v; apply(); }, { label: 'H:', unit: '%', min: -100, max: 100, width: 54, title: 'Horizontal distortion' });
  const vd = numberField(w.vDistort, v => { w.vDistort = v; apply(); }, { label: 'V:', unit: '%', min: -100, max: 100, width: 54, title: 'Vertical distortion' });
  const sync = () => { for (const el of [orient, bend, hd, vd]) el.style.opacity = w.style === 'none' ? '0.4' : ''; };
  const reset = iconButton('reset', 'Reset the warp', () => { const S = st; if (!S) return; S.preset = null; S.grid = gridFromMap(S.B, rectToQuad(S.B, S.q)); style.setValue('custom'); w.style = 'none'; sync(); schedule(); });
  sync();
  bar.append(h('span.opt-label', null, 'Warp:'), style, orient, separator(), bend, separator(), hd, vd, separator(), reset,
    iconButton('warp', 'Switch back to free transform', () => setMode('free'), { active: true }),
    h('span.ft-flex'),
    iconButton('cancel', 'Cancel transform (Esc)', () => end(false)), iconButton('commit', 'Commit transform (Enter)', () => end(true)));
}

// ================================================================== Move tool integration ("Show Transform Controls")
function moveBox(doc: PixDocument): Rect | null {
  if (st) return null;
  let r: Rect | null = null;
  for (const l of leafLayers(doc.selectedLayers)) { if (l.kind === 'adjustment') continue; r = unionRect(r, doc.layerBounds(l)); }
  return r;
}
function moveHandle(doc: PixDocument, p: { sx: number; sy: number }): number {
  const r = moveBox(doc), v = app.viewport;
  if (!r || !v) return -1;
  for (let i = 0; i < 8; i++) { const [u, w] = HANDLE_UV[i], sc = v.docToScreen(r.x + r.w * u, r.y + r.h * w); if (Math.hypot(sc.x - p.sx, sc.y - p.sy) <= 7) return i; }
  return -1;
}
hooks.moveTransform = {
  draw(ctx, view, doc) {
    const r = moveBox(doc);
    if (!r) return;
    const a = view.docToScreen(r.x, r.y), b = view.docToScreen(r.x + r.w, r.y), c = view.docToScreen(r.x + r.w, r.y + r.h), d = view.docToScreen(r.x, r.y + r.h);
    ctx.save();
    ctx.strokeStyle = '#1e8bff'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.lineTo(c.x, c.y); ctx.lineTo(d.x, d.y); ctx.closePath(); ctx.stroke();
    for (let i = 0; i < 8; i++) {
      const [u, w] = HANDLE_UV[i], sc = view.docToScreen(r.x + r.w * u, r.y + r.h * w);
      ctx.fillStyle = '#fff'; ctx.fillRect(Math.round(sc.x) - 3.5, Math.round(sc.y) - 3.5, 7, 7); ctx.strokeRect(Math.round(sc.x) - 3.5, Math.round(sc.y) - 3.5, 7, 7);
    }
    ctx.restore();
  },
  pointerDown(p, doc) {
    if (moveHandle(doc, p) < 0) return false;
    if (!startTransform('free')) return false;
    tool.pointerDown!(p, doc);
    return true;
  },
  pointerMove(p) { tool.pointerMove!(p, app.activeDoc!); },
  pointerUp(p) { tool.pointerUp!(p, app.activeDoc!); },
  cursor(p, doc) {
    const i = moveHandle(doc, p);
    if (i < 0) return null;
    return [0, 2].includes(i) ? 'nwse-resize' : [1, 3].includes(i) ? 'nesw-resize' : i === 4 || i === 6 ? 'ns-resize' : 'ew-resize';
  },
};

hooks.startFreeTransform = (mode?: string) => { startTransform((mode as TMode) || 'free'); };

// ================================================================== commands
const canTransform = () => !!app.activeDoc && (!!app.activeDoc.activeLayer || !!app.activeDoc.editMask);
registerCommands([
  { id: 'edit.freeTransform', label: 'Free Transform', shortcut: 'Ctrl+T', enabled: canTransform, run: () => startTransform('free') },
  {
    id: 'edit.transform', label: 'Transform', enabled: canTransform,
    run: (arg?: string) => { if (arg && arg in INSTANT) instant(arg); else startTransform((arg as TMode) || 'free'); },
  },
  { id: 'edit.transformAgain', label: 'Again', shortcut: 'Shift+Ctrl+T', enabled: () => canTransform() && !!lastRel, run: transformAgain },
]);
