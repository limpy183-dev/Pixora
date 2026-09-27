// Whole-document affine transforms shared by the Crop tool and Ruler › Straighten Layer:
// resample raster layers / masks / channels, transform vector layers (applyMatrix), paths, guides and
// point data in doc.extra. Always called inside a history transaction (canvases are replaced, never mutated).
import type { PixDocument } from '../../core/document';
import { GroupLayer, RasterLayer, type Layer } from '../../core/layer';
import { createCanvas, ctx2d } from '../../core/canvas';
import { intersectRect, roundRectOut, unionRect } from '../../core/geom';
import { transformSubpaths } from '../../core/path';
import type { LayerMask, Point, Rect, RGB } from '../../core/types';
import { toCss } from '../../core/color';

export const isTranslation = (m: DOMMatrix) => Math.abs(m.a - 1) < 1e-9 && Math.abs(m.b) < 1e-9 && Math.abs(m.c) < 1e-9 && Math.abs(m.d - 1) < 1e-9;
const isIntTranslation = (m: DOMMatrix) => isTranslation(m) && Number.isInteger(m.e) && Number.isInteger(m.f);

export const tp = (m: DOMMatrix, x: number, y: number): Point => { const p = m.transformPoint(new DOMPoint(x, y)); return { x: p.x, y: p.y }; };
export function quadOf(m: DOMMatrix, r: Rect): Point[] {
  return [tp(m, r.x, r.y), tp(m, r.x + r.w, r.y), tp(m, r.x + r.w, r.y + r.h), tp(m, r.x, r.y + r.h)];
}
export function quadBounds(q: Point[]): Rect {
  const xs = q.map(p => p.x), ys = q.map(p => p.y);
  const x = Math.min(...xs), y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}

/**
 * Largest scale s (≤ limit) so that the axis-aligned box centre c ± s·(hw, hh) lies inside the convex quad q
 * (any winding). Returns 0 when the centre itself is outside.
 */
export function maxScaleInside(c: Point, hw: number, hh: number, q: Point[], limit = Infinity): number {
  // orientation of the quad
  let area = 0;
  for (let i = 0; i < 4; i++) { const a = q[i], b = q[(i + 1) % 4]; area += a.x * b.y - b.x * a.y; }
  const sgn = area >= 0 ? 1 : -1;
  let s = limit;
  for (let i = 0; i < 4; i++) {
    const a = q[i], b = q[(i + 1) % 4];
    // inward normal
    const nx = -(b.y - a.y) * sgn, ny = (b.x - a.x) * sgn;
    const base = nx * (c.x - a.x) + ny * (c.y - a.y);
    if (base < -1e-6) return 0;
    for (const [dx, dy] of [[hw, hh], [hw, -hh], [-hw, hh], [-hw, -hh]]) {
      const k = nx * dx + ny * dy;
      if (k < 0) s = Math.min(s, base / -k);
    }
  }
  return Math.max(0, s);
}

/** Transform a canvas positioned at (x, y) by m. clip (doc rect) limits the output. */
export function transformCanvas(src: HTMLCanvasElement, x: number, y: number, m: DOMMatrix, clip?: Rect | null): { canvas: HTMLCanvasElement; x: number; y: number } | null {
  const full = { x, y, w: src.width, h: src.height };
  if (isIntTranslation(m)) {
    const nx = x + m.e, ny = y + m.f;
    if (!clip) return { canvas: src, x: nx, y: ny };
    const r = intersectRect({ x: nx, y: ny, w: src.width, h: src.height }, clip);
    if (!r) return null;
    if (r.x === nx && r.y === ny && r.w === src.width && r.h === src.height) return { canvas: src, x: nx, y: ny };
    const c = createCanvas(r.w, r.h);
    ctx2d(c).drawImage(src, nx - r.x, ny - r.y);
    return { canvas: c, x: r.x, y: r.y };
  }
  let b: Rect | null = roundRectOut(quadBounds(quadOf(m, full)));
  if (clip) b = intersectRect(b, clip);
  if (!b || b.w < 1 || b.h < 1) return null;
  const c = createCanvas(b.w, b.h), cx = ctx2d(c);
  cx.imageSmoothingEnabled = true;
  cx.imageSmoothingQuality = 'high';
  cx.setTransform(1, 0, 0, 1, -b.x, -b.y);
  cx.transform(m.a, m.b, m.c, m.d, m.e, m.f);
  cx.drawImage(src, x, y);
  return { canvas: c, x: b.x, y: b.y };
}

/** Transform a layer mask; the result keeps the mask's background value outside its canvas. */
export function transformMask(mask: LayerMask, m: DOMMatrix, docRect: Rect, deleteOutside: boolean): LayerMask {
  const src = { x: mask.x, y: mask.y, w: mask.canvas.width, h: mask.canvas.height };
  if (isIntTranslation(m) && !deleteOutside) return { ...mask, x: mask.x + m.e, y: mask.y + m.f };
  let b = roundRectOut(quadBounds(quadOf(m, src)));
  if (mask.bg === 255) b = unionRect(b, docRect)!;
  if (deleteOutside) b = intersectRect(b, docRect) || { ...docRect };
  const c = createCanvas(b.w, b.h), cx = ctx2d(c);
  cx.imageSmoothingQuality = 'high';
  if (mask.bg === 255) { cx.fillStyle = '#000'; cx.fillRect(0, 0, b.w, b.h); }
  cx.setTransform(1, 0, 0, 1, -b.x, -b.y);
  cx.transform(m.a, m.b, m.c, m.d, m.e, m.f);
  if (mask.bg === 255) cx.clearRect(src.x, src.y, src.w, src.h);
  cx.drawImage(mask.canvas, src.x, src.y);
  return { ...mask, canvas: c, x: b.x, y: b.y };
}

export interface DocTransformOpts {
  /** New document size. */
  width: number; height: number;
  /** Clip every layer to the new canvas (Crop "Delete Cropped Pixels"). */
  deleteOutside: boolean;
  /** Keep the Background layer (fill uncovered canvas with this colour) instead of converting it to "Layer 0". */
  backgroundFill: RGB | null;
  resolution?: number;
}

/** Transform one layer (and its mask) by m. Used for whole-doc transforms and for rotating a single layer. */
export function transformLayer(doc: PixDocument, layer: Layer, m: DOMMatrix, clip: Rect | null, deleteOutside: boolean, docRect: Rect) {
  const mask = layer.mask ? { ...layer.mask } : null;   // copy: translate() mutates mask.x/y in place
  if (layer instanceof GroupLayer) {
    for (const ch of layer.children) transformLayer(doc, ch, m, clip, deleteOutside, docRect);
  } else if (layer instanceof RasterLayer) {
    const r = transformCanvas(layer.canvas, layer.x, layer.y, m, clip);
    if (r) { layer.canvas = r.canvas; layer.x = r.x; layer.y = r.y; }
    else { layer.canvas = createCanvas(1, 1); layer.x = docRect.x; layer.y = docRect.y; }
  } else if (typeof (layer as any).applyMatrix === 'function') {
    (layer as any).applyMatrix(m);
  } else if (layer.kind !== 'adjustment' && layer.kind !== 'fill') {
    // unknown content: move it with the transform of its centre
    const b = layer.bounds(doc);
    if (b) { const c = tp(m, b.x + b.w / 2, b.y + b.h / 2); layer.translate(Math.round(c.x - b.x - b.w / 2), Math.round(c.y - b.y - b.h / 2)); }
  }
  // masks are handled here for every layer kind (translate()/applyMatrix() may have moved it: restore first)
  if (mask) layer.mask = transformMask(mask, m, docRect, deleteOutside);
  layer.invalidate();
}

/** Transform the whole document by m (old doc coords → new doc coords) and resize the canvas. */
export function transformDocument(doc: PixDocument, m: DOMMatrix, o: DocTransformOpts) {
  const W = Math.max(1, Math.round(o.width)), H = Math.max(1, Math.round(o.height));
  const docRect = { x: 0, y: 0, w: W, h: H };
  const clip = o.deleteOutside ? docRect : null;
  const bgLayer = doc.layers.find(l => l.isBackground) || null;
  if (bgLayer && !o.backgroundFill) { bgLayer.isBackground = false; bgLayer.name = 'Layer 0'; }
  for (const l of doc.layers) transformLayer(doc, l, m, clip, o.deleteOutside, docRect);
  // Background: always opaque and exactly canvas-sized
  if (bgLayer && o.backgroundFill && bgLayer instanceof RasterLayer) {
    const c = createCanvas(W, H), x = ctx2d(c);
    x.fillStyle = toCss(o.backgroundFill); x.fillRect(0, 0, W, H);
    x.drawImage(bgLayer.canvas, bgLayer.x, bgLayer.y);
    bgLayer.canvas = c; bgLayer.x = 0; bgLayer.y = 0;
  }
  // alpha channels / quick mask (doc sized)
  const docSized = (c: HTMLCanvasElement) => {
    const out = createCanvas(W, H), x = ctx2d(out);
    x.imageSmoothingQuality = 'high';
    x.setTransform(m.a, m.b, m.c, m.d, m.e, m.f);
    x.drawImage(c, 0, 0);
    return out;
  };
  doc.channels = doc.channels.map(ch => ({ ...ch, canvas: docSized(ch.canvas) }));
  if (doc.quickMask) doc.quickMask = { canvas: docSized(doc.quickMask.canvas), x: 0, y: 0 };
  // paths
  doc.paths = doc.paths.map((p: any) => (p && Array.isArray(p.subpaths) ? { ...p, subpaths: transformSubpaths(p.subpaths, m) } : p));
  // guides (positions follow the transform through the canvas centre line)
  doc.guides = doc.guides.map(g => {
    const p = g.orientation === 'v' ? tp(m, g.pos, doc.height / 2) : tp(m, doc.width / 2, g.pos);
    return { ...g, pos: g.orientation === 'v' ? p.x : p.y };
  });
  // point data kept in doc.extra
  const ex = { ...doc.extra };
  const mapPt = <T extends { x: number; y: number }>(o2: T): T => { const p = tp(m, o2.x, o2.y); return { ...o2, x: p.x, y: p.y }; };
  if (Array.isArray(ex.samplers)) ex.samplers = ex.samplers.map((s: any) => { const p = mapPt(s); return { ...p, x: Math.floor(p.x), y: Math.floor(p.y) }; }).filter((s: any) => s.x >= 0 && s.y >= 0 && s.x < W && s.y < H);
  if (Array.isArray(ex.notes)) ex.notes = ex.notes.map(mapPt);
  if (ex.counts && Array.isArray(ex.counts.groups)) ex.counts = { ...ex.counts, groups: ex.counts.groups.map((g: any) => ({ ...g, points: g.points.map(mapPt) })) };
  if (Array.isArray(ex.slices)) {
    ex.slices = isTranslation(m) || (Math.abs(m.b) < 1e-9 && Math.abs(m.c) < 1e-9)
      ? ex.slices.map((s: any) => { const a = tp(m, s.x, s.y), b = tp(m, s.x + s.w, s.y + s.h); return { ...s, x: Math.round(a.x), y: Math.round(a.y), w: Math.round(b.x - a.x), h: Math.round(b.y - a.y) }; })
      : [];
  }
  doc.extra = ex;
  doc.selection.setMask(null);
  if (o.resolution) doc.resolution = o.resolution;
  doc.setSize(W, H);
  for (const l of doc.allLayers()) l.invalidate();
}
