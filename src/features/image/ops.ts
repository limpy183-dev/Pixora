// Whole-document geometric operations shared by the Image menu and the Properties panel:
// Image Size, Canvas Size, rotation, flips, Crop, Trim, Reveal All, flattening, previews.
// Every function here mutates the document and must run inside doc.history.transaction().
import { app } from '../../core/app';
import { events } from '../../core/events';
import { GroupLayer, RasterLayer, type Layer, type LayerContent } from '../../core/layer';
import type { PixDocument } from '../../core/document';
import type { ColorMode, Rect, RGB } from '../../core/types';
import { createCanvas, ctx2d, cropCanvas } from '../../core/canvas';
import { intersectRect, unionRect } from '../../core/geom';
import { toCss } from '../../core/color';
import { transformSubpaths } from '../../core/path';
import { renderLayersToCanvas } from '../../core/compositor';
import { viewportHooks } from '../../core/viewport';
import { resampleCanvas, type ResampleMethod } from './resample';

// ------------------------------------------------------------------ sizes / labels
export const MODE_LABELS: Record<ColorMode, string> = {
  Bitmap: 'Bitmap', Grayscale: 'Grayscale', Duotone: 'Duotone', Indexed: 'Indexed Color', RGB: 'RGB Color',
  CMYK: 'CMYK Color', Lab: 'Lab Color', Multichannel: 'Multichannel',
};
const CHANNELS: Record<ColorMode, number> = { Bitmap: 1 / 8, Grayscale: 1, Duotone: 1, Indexed: 1, RGB: 3, CMYK: 4, Lab: 3, Multichannel: 3 };
/** Uncompressed image size in bytes (Photoshop's "Image Size: 7.66M"). */
export function docBytes(doc: PixDocument, w = doc.width, h = doc.height): number {
  const bpc = doc.mode === 'Bitmap' ? 1 : doc.bitDepth / 8;
  return w * h * CHANNELS[doc.mode] * bpc;
}
export function fmtBytes(b: number): string {
  if (b >= 1024 * 1024 * 1024) return (b / 1024 / 1024 / 1024).toFixed(2) + 'G';
  if (b >= 1024 * 1024) return (b / 1024 / 1024).toFixed(2) + 'M';
  return Math.max(1, Math.round(b / 1024)) + 'K';
}

// ------------------------------------------------------------------ canvas transform
const isExact = (m: DOMMatrix) =>
  [m.a, m.b, m.c, m.d].every(v => v === 0 || v === 1 || v === -1) && Number.isInteger(m.e) && Number.isInteger(m.f) &&
  ((m.b === 0 && m.c === 0) || (m.a === 0 && m.d === 0));
const isScale = (m: DOMMatrix) => m.b === 0 && m.c === 0 && m.a > 0 && m.d > 0;

export interface CanvasTransformOpts { resample?: ResampleMethod | null; noise?: number; maskBg?: 0 | 255 }

/** Map a canvas placed at doc (x, y) through `m` (old doc → new doc). Returns the new canvas + its doc position. */
export function transformCanvas(src: HTMLCanvasElement, x: number, y: number, m: DOMMatrix, o: CanvasTransformOpts = {}): LayerContent {
  const w = src.width, h = src.height;
  if (o.resample && isScale(m) && !(m.a === 1 && m.d === 1)) {
    const x0 = Math.round(m.a * x + m.e), y0 = Math.round(m.d * y + m.f);
    const x1 = Math.round(m.a * (x + w) + m.e), y1 = Math.round(m.d * (y + h) + m.f);
    return { canvas: resampleCanvas(src, Math.max(1, x1 - x0), Math.max(1, y1 - y0), o.resample, { noise: o.noise }), x: x0, y: y0 };
  }
  const exact = isExact(m);
  const pts = [[x, y], [x + w, y], [x, y + h], [x + w, y + h]].map(([px, py]) => [m.a * px + m.c * py + m.e, m.b * px + m.d * py + m.f]);
  const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
  const rnd = exact ? Math.round : Math.floor, rup = exact ? Math.round : Math.ceil;
  const x0 = rnd(Math.min(...xs) + (exact ? 0 : 1e-6)), y0 = rnd(Math.min(...ys) + (exact ? 0 : 1e-6));
  const x1 = rup(Math.max(...xs) - (exact ? 0 : 1e-6)), y1 = rup(Math.max(...ys) - (exact ? 0 : 1e-6));
  const c = createCanvas(Math.max(1, x1 - x0), Math.max(1, y1 - y0)), cx = ctx2d(c);
  const fillBg = o.maskBg === 255 && !exact;
  if (fillBg) { cx.fillStyle = '#000'; cx.fillRect(0, 0, c.width, c.height); }
  cx.setTransform(m.a, m.b, m.c, m.d, m.e - x0, m.f - y0);
  cx.imageSmoothingEnabled = !exact;
  cx.imageSmoothingQuality = 'high';
  if (fillBg) { cx.beginPath(); cx.rect(x, y, w, h); cx.clip(); cx.clearRect(x, y, w, h); }
  cx.drawImage(src, x, y);
  return { canvas: c, x: x0, y: y0 };
}

/** Transform a document-sized canvas into a new document-sized canvas (selection, channels, quick mask). */
function transformDocCanvas(src: HTMLCanvasElement, m: DOMMatrix, W: number, H: number, resample: boolean): HTMLCanvasElement {
  const r = transformCanvas(src, 0, 0, m, { resample: resample ? 'bilinear' : null });
  const c = createCanvas(W, H);
  ctx2d(c).drawImage(r.canvas, r.x, r.y);
  return c;
}

// ------------------------------------------------------------------ document transform
export interface DocTransform {
  /** New document size. */
  w: number; h: number;
  /** Old doc coords → new doc coords. */
  m: DOMMatrix;
  /** Resample raster content (Image Size). */
  resample?: ResampleMethod | null;
  noise?: number;
  /** Colour for newly exposed Background-layer areas (default: background colour). */
  bgFill?: RGB | null;
  /** Discard layer pixels outside the new canvas (Crop / Trim). */
  clip?: boolean;
  /** Scale layer-style sizes (Image Size › Scale Styles). */
  scaleStyles?: boolean;
}

const pure = (m: DOMMatrix) => m.a === 1 && m.b === 0 && m.c === 0 && m.d === 1;
const STYLE_SIZE_KEYS = ['size', 'distance', 'softness', 'width'];

function withoutMask(l: Layer, fn: () => void) {
  const mk = l.mask, vm = (l as any).vectorMask;
  l.mask = null;
  if (vm !== undefined) (l as any).vectorMask = null;
  try { fn(); } finally { l.mask = mk; if (vm !== undefined) (l as any).vectorMask = vm; }
}

function transformPointArray(list: any, m: DOMMatrix): any {
  if (!Array.isArray(list)) return list;
  return list.map(it => {
    if (it && typeof it.x === 'number' && typeof it.y === 'number') {
      const p = m.transformPoint(new DOMPoint(it.x, it.y));
      return { ...it, x: p.x, y: p.y };
    }
    return it;
  });
}

/** Apply a geometric transform to the whole document (all layers, masks, selection, channels, guides, paths). */
export function transformDocument(doc: PixDocument, t: DocTransform) {
  const { m } = t;
  const W = Math.max(1, Math.round(t.w)), H = Math.max(1, Math.round(t.h));
  const docRect = { x: 0, y: 0, w: W, h: H };
  const styleScale = Math.sqrt(Math.abs(m.a * m.d - m.b * m.c));
  const res = t.resample || null;

  for (const l of doc.allLayers()) {
    // ---- content
    if (l instanceof RasterLayer) {
      if (l.isBackground) {
        const c = createCanvas(W, H), cx = ctx2d(c);
        cx.fillStyle = toCss(t.bgFill || app.bg); cx.fillRect(0, 0, W, H);
        const r = transformCanvas(l.canvas, l.x, l.y, m, { resample: res, noise: t.noise });
        cx.drawImage(r.canvas, r.x, r.y);
        l.canvas = c; l.x = 0; l.y = 0;
      } else {
        let r = transformCanvas(l.canvas, l.x, l.y, m, { resample: res, noise: t.noise });
        if (t.clip) {
          const ir = intersectRect({ x: r.x, y: r.y, w: r.canvas.width, h: r.canvas.height }, docRect);
          r = ir ? { canvas: cropCanvas(r.canvas, { x: ir.x - r.x, y: ir.y - r.y, w: ir.w, h: ir.h }), x: ir.x, y: ir.y } : { canvas: createCanvas(1, 1), x: 0, y: 0 };
        }
        l.canvas = r.canvas; l.x = r.x; l.y = r.y;
      }
    } else if (!(l instanceof GroupLayer) && l.kind !== 'adjustment' && l.kind !== 'fill') {
      const any = l as any;
      withoutMask(l, () => {
        if (typeof any.applyMatrix === 'function') any.applyMatrix(m);
        else if (pure(m)) l.translate(m.e, m.f);
        else {
          const b = l.bounds(doc);
          if (b) { const p = m.transformPoint(new DOMPoint(b.x, b.y)); l.translate(Math.round(p.x - b.x), Math.round(p.y - b.y)); }
        }
      });
    }
    // ---- masks
    if (l.mask) {
      const mk = l.mask;
      const r = transformCanvas(mk.canvas, mk.x, mk.y, m, { resample: res ? 'bilinear' : null, maskBg: mk.bg });
      mk.canvas = r.canvas; mk.x = r.x; mk.y = r.y;
      if (mk.feather) mk.feather *= styleScale;
    }
    const vm = (l as any).vectorMask;
    if (vm && Array.isArray(vm.subpaths)) (l as any).vectorMask = { ...vm, subpaths: transformSubpaths(vm.subpaths, m) };
    // ---- layer styles
    if (t.scaleStyles && styleScale !== 1 && l.effects?.length) {
      for (const e of l.effects) for (const k of STYLE_SIZE_KEYS) if (typeof e[k] === 'number') e[k] = Math.max(0, Math.round(e[k] * styleScale * 10) / 10);
    }
    l.invalidate();
  }

  // ---- document-sized canvases
  const selMask = doc.selection.mask;
  const quick = doc.quickMask;
  doc.setSize(W, H);
  if (selMask) doc.selection.setMask(transformDocCanvas(selMask, m, W, H, !!res));
  if (quick) doc.quickMask = { canvas: transformDocCanvas(quick.canvas, m, W, H, !!res), x: 0, y: 0 };
  doc.channels = doc.channels.map(ch => ({ ...ch, canvas: transformDocCanvas(ch.canvas, m, W, H, !!res) }));

  // ---- guides (kept in place for non-orthogonal rotations)
  const ortho = (m.b === 0 && m.c === 0) || (m.a === 0 && m.d === 0);
  if (ortho) {
    doc.guides = doc.guides.map(g => {
      const p = g.orientation === 'v' ? m.transformPoint(new DOMPoint(g.pos, 0)) : m.transformPoint(new DOMPoint(0, g.pos));
      const q = g.orientation === 'v' ? m.transformPoint(new DOMPoint(g.pos, 1)) : m.transformPoint(new DOMPoint(1, g.pos));
      return Math.abs(p.x - q.x) < 1e-9 ? { ...g, orientation: 'v' as const, pos: p.x } : { ...g, orientation: 'h' as const, pos: p.y };
    });
  }
  // ---- paths & point-based extras
  doc.paths = doc.paths.map(p => (p && Array.isArray(p.subpaths) ? { ...p, subpaths: transformSubpaths(p.subpaths, m) } : p));
  const ex = doc.extra || {};
  for (const k of ['samplers', 'notes', 'counts']) if (Array.isArray(ex[k])) ex[k] = transformPointArray(ex[k], m);
  if (Array.isArray(ex.slices) && ortho) ex.slices = ex.slices.map((s: any) => {
    if (!s || typeof s.x !== 'number' || typeof s.w !== 'number') return s;
    const a = m.transformPoint(new DOMPoint(s.x, s.y)), b = m.transformPoint(new DOMPoint(s.x + s.w, s.y + s.h));
    return { ...s, x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y) };
  });
}

/** Notify every listener after a whole-document change. */
export function docChanged(doc: PixDocument) {
  doc.relink();
  for (const l of doc.allLayers()) l.invalidate();
  doc.layersChanged();
  events.emit('pixels', { doc, layer: null, rect: null });
  events.emit('guides', doc);
  events.emit('paths', doc);
  events.emit('docSize', doc);
  doc.selectionChanged();
}

// ------------------------------------------------------------------ high level operations
export type Anchor = { ax: number; ay: number };   // 0 / 0.5 / 1

/** Canvas Size: resize the canvas around an anchor, Background extension filled with `fill`. */
export function canvasSize(doc: PixDocument, w: number, h: number, anchor: Anchor, fill: RGB | null) {
  w = Math.max(1, Math.round(w)); h = Math.max(1, Math.round(h));
  const dx = Math.round((w - doc.width) * anchor.ax), dy = Math.round((h - doc.height) * anchor.ay);
  transformDocument(doc, { w, h, m: new DOMMatrix([1, 0, 0, 1, dx, dy]), bgFill: fill });
}

/** Crop the canvas to `r` (doc coords). clip = delete pixels outside. */
export function cropTo(doc: PixDocument, r: Rect, clip = true) {
  transformDocument(doc, { w: r.w, h: r.h, m: new DOMMatrix([1, 0, 0, 1, -r.x, -r.y]), clip });
}

/** Rotate the canvas by 90 / -90 / 180 or any angle (degrees, clockwise). */
export function rotateCanvas(doc: PixDocument, deg: number, fill: RGB | null = null) {
  const W = doc.width, H = doc.height;
  const n = ((deg % 360) + 360) % 360;
  let m: DOMMatrix, w = W, h = H;
  if (n === 90) { m = new DOMMatrix([0, 1, -1, 0, H, 0]); w = H; h = W; }
  else if (n === 270) { m = new DOMMatrix([0, -1, 1, 0, 0, W]); w = H; h = W; }
  else if (n === 180) m = new DOMMatrix([-1, 0, 0, -1, W, H]);
  else if (n === 0) return;
  else {
    const a = (n * Math.PI) / 180, cs = Math.abs(Math.cos(a)), sn = Math.abs(Math.sin(a));
    w = Math.ceil(W * cs + H * sn - 1e-6); h = Math.ceil(W * sn + H * cs - 1e-6);
    m = new DOMMatrix().translate(w / 2, h / 2).rotate(n).translate(-W / 2, -H / 2);
  }
  transformDocument(doc, { w, h, m, bgFill: fill });
}

export function flipCanvas(doc: PixDocument, axis: 'h' | 'v') {
  const m = axis === 'h' ? new DOMMatrix([-1, 0, 0, 1, doc.width, 0]) : new DOMMatrix([1, 0, 0, -1, 0, doc.height]);
  transformDocument(doc, { w: doc.width, h: doc.height, m });
}

/** Image Size (resample = null keeps the pixels and only changes the resolution). */
export function imageSize(doc: PixDocument, w: number, h: number, resolution: number, method: ResampleMethod | null, opts: { noise?: number; scaleStyles?: boolean } = {}) {
  w = Math.max(1, Math.round(w)); h = Math.max(1, Math.round(h));
  doc.resolution = resolution;
  if (!method || (w === doc.width && h === doc.height)) { events.emit('docSize', doc); return; }
  const m = new DOMMatrix([w / doc.width, 0, 0, h / doc.height, 0, 0]);
  transformDocument(doc, { w, h, m, resample: method, noise: opts.noise, scaleStyles: opts.scaleStyles !== false });
}

/** Union of all layer content bounds (for Reveal All); null when nothing lies outside the canvas. */
export function revealRect(doc: PixDocument): Rect | null {
  let r: Rect | null = { x: 0, y: 0, w: doc.width, h: doc.height };
  for (const l of doc.allLayers()) {
    if (l instanceof GroupLayer || l.kind === 'adjustment' || l.kind === 'fill') continue;
    r = unionRect(r, doc.layerBounds(l));
  }
  return r && (r.x < 0 || r.y < 0 || r.x + r.w > doc.width || r.y + r.h > doc.height) ? r : null;
}

export type TrimBase = 'transparent' | 'topLeft' | 'bottomRight';
/** Trim rectangle for Image › Trim. */
export function trimRect(doc: PixDocument, base: TrimBase, sides: { top: boolean; bottom: boolean; left: boolean; right: boolean }): Rect | null {
  const W = doc.width, H = doc.height;
  const comp = renderLayersToCanvas(doc, doc.layers);
  const d = new Uint32Array(ctx2d(comp).getImageData(0, 0, W, H).data.buffer);
  const ref = base === 'topLeft' ? d[0] : base === 'bottomRight' ? d[W * H - 1] : 0;
  const keep = base === 'transparent' ? (v: number) => (v >>> 24) !== 0 : (v: number) => v !== ref;
  let x0 = W, y0 = H, x1 = -1, y1 = -1;
  for (let y = 0; y < H; y++) {
    const o = y * W;
    for (let x = 0; x < W; x++) if (keep(d[o + x])) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; y1 = y; }
  }
  if (x1 < 0) return null;
  const r = { x: sides.left ? x0 : 0, y: sides.top ? y0 : 0, w: 0, h: 0 };
  r.w = (sides.right ? x1 + 1 : W) - r.x;
  r.h = (sides.bottom ? y1 + 1 : H) - r.y;
  return r;
}

/** Replace all layers by one flattened layer. Opaque → Background (transparent areas filled with white). */
export function flattenDoc(doc: PixDocument, opts: { opaque?: boolean; name?: string } = {}): RasterLayer {
  const comp = renderLayersToCanvas(doc, doc.layers);
  const l = new RasterLayer(doc.width, doc.height, opts.name || (opts.opaque === false ? 'Layer 0' : 'Background'));
  const x = l.ctx;
  if (opts.opaque !== false) { x.fillStyle = '#fff'; x.fillRect(0, 0, doc.width, doc.height); l.isBackground = true; }
  x.drawImage(comp, 0, 0);
  doc.layers = [l];
  doc.relink();
  doc.editMask = false;
  doc.activeLayerId = l.id;
  doc.selectedIds = [l.id];
  events.emit('activeLayer', doc);
  doc.layersChanged();
  return l;
}
export const hasTransparency = (doc: PixDocument) => !doc.layers.some(l => l.isBackground && l.visible);
export const needsFlatten = (doc: PixDocument) => doc.layers.length > 1 || doc.layers.some(l => !(l instanceof RasterLayer));

/** Map every pixel of every raster layer through fn (RGBA in place). Replaces canvases (history safe). */
export function mapRasterPixels(doc: PixDocument, fn: (d: Uint8ClampedArray) => void) {
  for (const l of doc.allLayers()) {
    if (!(l instanceof RasterLayer)) continue;
    const c = createCanvas(l.canvas.width, l.canvas.height), x = ctx2d(c);
    const img = ctx2d(l.canvas).getImageData(0, 0, c.width, c.height);
    fn(img.data);
    x.putImageData(img, 0, 0);
    l.canvas = c;
    l.invalidate();
  }
}

// ------------------------------------------------------------------ full-document preview (mode dialogs)
let previewDoc: PixDocument | null = null, previewCanvas: HTMLCanvasElement | null = null;
viewportHooks.afterComposite.push((ctx, view, doc) => {
  if (!previewCanvas || doc !== previewDoc) return;
  view.applyDocTransform(ctx);
  ctx.imageSmoothingEnabled = view.zoom < 1;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, doc.width, doc.height);
  ctx.drawImage(previewCanvas, 0, 0);
});
/** Show `c` (doc-sized) instead of the composite until cleared with null. */
export function setDocPreview(doc: PixDocument | null, c: HTMLCanvasElement | null) {
  previewDoc = c ? doc : null; previewCanvas = c;
  app.viewport?.requestRender();
}
