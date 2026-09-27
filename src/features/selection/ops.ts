// Document-level selection helpers: image sampling (cached), committing masks, proxies for heavy segmentation,
// Select Subject / Sky / Object detection pipelines and the on-canvas selection preview (Color Range, Focus Area).
import { app } from '../../core/app';
import type { PixDocument } from '../../core/document';
import { Selection } from '../../core/selection';
import { createCanvas, ctx2d } from '../../core/canvas';
import { events } from '../../core/events';
import { viewportHooks } from '../../core/viewport';
import type { Point, Rect, SelectOp } from '../../core/types';
import { toast } from '../../ui/toast';
import {
  BG, FG, PR_BG, PR_FG, fillHoles, gradientMagnitude, keepLargest, otsu, refineEdges, resizeFloat, saliencyMap,
  segment, toLab, boxBlur, distanceField,
} from './algo';

// ------------------------------------------------------------------ sampling
let pixVersion = 0;
events.on('pixels', () => pixVersion++);
events.on('layers', () => pixVersion++);
events.on('docSize', () => pixVersion++);

/** Canvas to sample for selection tools: the merged image, or the active layer drawn at doc size. */
export function sampleCanvas(doc: PixDocument, all: boolean): HTMLCanvasElement {
  const layer = doc.activeLayer;
  if (!all && layer && layer.getContent(doc)) return doc.layerAsDocCanvas(layer);
  return doc.getComposite();
}

const imgCache = new WeakMap<PixDocument, { key: string; img: ImageData }>();
/** Doc-sized RGBA pixels to sample (cached until pixels/layers change). */
export function sampleImage(doc: PixDocument, all: boolean): ImageData {
  const layer = doc.activeLayer;
  const useLayer = !all && !!layer && !!layer.getContent(doc);
  const key = (useLayer ? `L${layer!.id}:${layer!._version}:` : 'C:') + pixVersion + ':' + doc.width + 'x' + doc.height;
  const hit = imgCache.get(doc);
  if (hit && hit.key === key) return hit.img;
  const c = sampleCanvas(doc, all);
  const img = ctx2d(c).getImageData(0, 0, doc.width, doc.height);
  imgCache.set(doc, { key, img });
  return img;
}

const gradCache = new WeakMap<ImageData, Float32Array>();
export function sampleGradient(img: ImageData): Float32Array {
  let g = gradCache.get(img);
  if (!g) { g = gradientMagnitude(img.data, img.width, img.height); gradCache.set(img, g); }
  return g;
}

/** Current selection as a doc-sized alpha array (zeros when there is no selection). */
export function selectionArray(doc: PixDocument): Uint8Array {
  if (doc.selection.empty) return new Uint8Array(doc.width * doc.height);
  return new Uint8Array(doc.selection.alphaArray());
}

/** Combine a doc-sized alpha array into the selection as one history state. */
export function commitMask(doc: PixDocument, name: string, alpha: Uint8Array | HTMLCanvasElement, op: SelectOp = 'replace', feather = 0) {
  const c = alpha instanceof HTMLCanvasElement ? alpha : Selection.canvasFromAlpha(alpha, doc.width, doc.height);
  doc.history.transaction(name, () => doc.selection.apply(c, op, feather), 'selection');
  if (feather > 0) warnIfFaint(doc);
}

/** Photoshop's warning when a feathered selection has no pixel above 50%. */
export function warnIfFaint(doc: PixDocument) {
  if (doc.selection.empty) return;
  const b = doc.selection.bounds!;
  const d = ctx2d(doc.selection.mask!).getImageData(b.x, b.y, b.w, b.h).data;
  for (let i = 3; i < d.length; i += 4) if (d[i] >= 128) return;
  toast('Warning: No pixels are more than 50% selected. The selection edges will not be visible.', 'info', 4200);
}

/** Resolve the selection op from the tool setting + modifier keys at pointer down (Shift add, Alt subtract, both intersect). */
export function resolveOp(base: SelectOp, shift: boolean, alt: boolean): SelectOp {
  if (shift && alt) return 'intersect';
  if (shift) return 'add';
  if (alt) return 'subtract';
  return base;
}

// ------------------------------------------------------------------ proxies
export interface Proxy { data: Uint8ClampedArray; w: number; h: number; rect: Rect; scale: number }
/** Downscaled copy of a region of `src` (max dimension `maxDim`). scale = proxy px per doc px. */
export function makeProxy(src: HTMLCanvasElement, rect: Rect, maxDim: number): Proxy {
  const scale = Math.min(1, maxDim / Math.max(rect.w, rect.h));
  const w = Math.max(1, Math.round(rect.w * scale)), h = Math.max(1, Math.round(rect.h * scale));
  const c = createCanvas(w, h), x = ctx2d(c);
  x.imageSmoothingEnabled = true; x.imageSmoothingQuality = 'high';
  x.drawImage(src, rect.x, rect.y, rect.w, rect.h, 0, 0, w, h);
  return { data: x.getImageData(0, 0, w, h).data, w, h, rect, scale: w / rect.w };
}

/**
 * Upsample a proxy-resolution mask (0..1) to the full-resolution rect, refine edges with the guided filter and
 * write it into a doc-sized alpha array.
 */
export function upsampleToDoc(doc: PixDocument, full: ImageData, pr: Proxy, pm: Float32Array, opts: { hard?: boolean; contrast?: number } = {}): Uint8Array {
  const { rect } = pr, W = doc.width;
  const up = resizeFloat(boxBlur(pm, pr.w, pr.h, 1), pr.w, pr.h, rect.w, rect.h);
  const sub = new Uint8ClampedArray(rect.w * rect.h * 4);
  for (let y = 0; y < rect.h; y++) sub.set(full.data.subarray(((y + rect.y) * W + rect.x) * 4, ((y + rect.y) * W + rect.x + rect.w) * 4), y * rect.w * 4);
  const r = Math.max(2, Math.min(12, Math.round(1.6 / pr.scale)));
  const q = pr.scale < 0.999 ? refineEdges(sub, rect.w, rect.h, up, r, 2e-3) : up;
  const out = new Uint8Array(doc.width * doc.height), k = opts.contrast ?? 2.2;
  for (let y = 0; y < rect.h; y++) for (let x = 0; x < rect.w; x++) {
    let v = (q[y * rect.w + x] - 0.5) * k + 0.5;
    if (opts.hard) v = v >= 0.5 ? 1 : 0;
    out[(y + rect.y) * W + x + rect.x] = v <= 0 ? 0 : v >= 1 ? 255 : Math.round(v * 255);
  }
  return out;
}

const binarize = (p: Float32Array, t = 0.5) => { const m = new Uint8Array(p.length); for (let i = 0; i < p.length; i++) m[i] = p[i] >= t ? 255 : 0; return m; };
const toFloat = (m: Uint8Array) => { const f = new Float32Array(m.length); for (let i = 0; i < m.length; i++) f[i] = m[i] / 255; return f; };

// ------------------------------------------------------------------ Select Subject
/** Heuristic subject detection: border-contrast saliency × centre prior → colour-model segmentation → cleanup → edge refine. */
export function detectSubject(doc: PixDocument, all = true, opts: { hard?: boolean } = {}): Uint8Array | null {
  const W = doc.width, H = doc.height;
  const src = sampleCanvas(doc, all);
  const pr = makeProxy(src, { x: 0, y: 0, w: W, h: H }, 240);
  const { data, w, h } = pr, n = w * h;
  const s = saliencyMap(data, w, h);
  const thr = Math.min(0.75, Math.max(0.22, otsu(s)));
  const labels = new Uint8Array(n), prior = new Float32Array(n);
  const hiT = thr + (1 - thr) * 0.55, loT = thr * 0.35;
  for (let i = 0; i < n; i++) {
    const v = s[i];
    labels[i] = v > hiT ? FG : v < loT ? BG : v > thr ? PR_FG : PR_BG;
    prior[i] = Math.min(0.95, Math.max(0.05, 0.5 + (v - thr) * 1.4));
  }
  // transparent pixels are never part of the subject
  for (let i = 0; i < n; i++) if (data[i * 4 + 3] < 8) labels[i] = BG;
  const p = segment(data, w, h, labels, { prior, iters: 4 });
  let m: Uint8Array = binarize(p);
  m = keepLargest(m, w, h, 0.18);
  m = fillHoles(m, w, h);
  let any = false;
  for (let i = 0; i < n; i++) if (m[i]) { any = true; break; }
  if (!any) return null;
  const full = sampleImage(doc, all);
  return upsampleToDoc(doc, full, pr, toFloat(m), opts);
}

// ------------------------------------------------------------------ Object Selection
/**
 * Find the object inside a rectangle / lasso region: GrabCut-style segmentation with everything outside the region
 * as definite background, refined at edges. Returns a doc-sized alpha array or null if nothing was found.
 */
export function detectObject(doc: PixDocument, region: { rect: Rect; poly?: Point[] }, all = false, opts: { hard?: boolean } = {}): Uint8Array | null {
  const W = doc.width, H = doc.height, r = region.rect;
  if (r.w < 3 || r.h < 3) return null;
  const m0 = Math.round(Math.max(r.w, r.h) * 0.12) + 8;
  const x0 = Math.max(0, Math.floor(r.x - m0)), y0 = Math.max(0, Math.floor(r.y - m0));
  const x1 = Math.min(W, Math.ceil(r.x + r.w + m0)), y1 = Math.min(H, Math.ceil(r.y + r.h + m0));
  const crop = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  if (crop.w < 2 || crop.h < 2) return null;
  const src = sampleCanvas(doc, all);
  const pr = makeProxy(src, crop, 260);
  const { data, w, h, scale } = pr, n = w * h;
  // region mask in proxy space
  const inside = new Uint8Array(n);
  const rc = createCanvas(w, h), rx = ctx2d(rc);
  rx.setTransform(scale, 0, 0, scale, -crop.x * scale, -crop.y * scale);
  rx.fillStyle = '#000';
  if (region.poly && region.poly.length > 2) { rx.beginPath(); region.poly.forEach((p, i) => (i ? rx.lineTo(p.x, p.y) : rx.moveTo(p.x, p.y))); rx.closePath(); rx.fill(); }
  else rx.fillRect(r.x, r.y, r.w, r.h);
  const rd = rx.getImageData(0, 0, w, h).data;
  let insideCount = 0, outsideCount = 0;
  for (let i = 0; i < n; i++) { inside[i] = rd[i * 4 + 3] >= 128 ? 1 : 0; if (inside[i]) insideCount++; else outsideCount++; }
  if (!insideCount) return null;
  const labels = new Uint8Array(n), prior = new Float32Array(n);
  const rcx = (r.x + r.w / 2 - crop.x) * scale, rcy = (r.y + r.h / 2 - crop.y) * scale, sx = 2 * (r.w * scale * 0.42) ** 2, sy = 2 * (r.h * scale * 0.42) ** 2;
  for (let i = 0; i < n; i++) {
    const x = i % w, y = (i / w) | 0;
    labels[i] = inside[i] ? (data[i * 4 + 3] < 8 ? BG : PR_FG) : BG;
    prior[i] = inside[i] ? 0.35 + 0.4 * Math.exp(-((x - rcx) ** 2) / sx - ((y - rcy) ** 2) / sy) : 0.05;
  }
  // the user draws the region around the object: its rim is probably background (also covers regions that touch
  // the canvas edge, where there is no background outside)
  const outsideFeat = new Uint8Array(n);
  for (let i = 0; i < n; i++) { const x = i % w, y = (i / w) | 0; outsideFeat[i] = !inside[i] || x === 0 || y === 0 || x === w - 1 || y === h - 1 ? 1 : 0; }
  const rimDist = distanceField(outsideFeat, w, h);
  const rim = Math.max(2, Math.min(r.w, r.h) * scale * (outsideCount < n * 0.08 ? 0.06 : 0.035));
  for (let i = 0; i < n; i++) if (inside[i] && labels[i] === PR_FG && rimDist[i] <= rim * rim) labels[i] = PR_BG;
  const p = segment(data, w, h, labels, { prior, iters: 5 });
  let m: Uint8Array = binarize(p);
  for (let i = 0; i < n; i++) if (!inside[i]) m[i] = 0;
  m = keepLargest(m, w, h, 0.25);
  m = fillHoles(m, w, h);
  let count = 0;
  for (let i = 0; i < n; i++) if (m[i]) count++;
  if (count < 4) return null;
  const full = sampleImage(doc, all);
  const out = upsampleToDoc(doc, full, pr, toFloat(m), opts);
  // clip to the drawn region (slightly feathered by the refinement)
  if (region.poly && region.poly.length > 2) {
    const clip = createCanvas(W, H), cx = ctx2d(clip);
    cx.beginPath(); region.poly.forEach((q, i) => (i ? cx.lineTo(q.x, q.y) : cx.moveTo(q.x, q.y))); cx.closePath(); cx.fill();
    const cd = cx.getImageData(crop.x, crop.y, crop.w, crop.h).data;
    for (let y = 0; y < crop.h; y++) for (let x = 0; x < crop.w; x++) {
      const i = (y + crop.y) * W + x + crop.x, a = cd[(y * crop.w + x) * 4 + 3];
      if (a < 255) out[i] = Math.min(out[i], a);
    }
  } else {
    for (let y = crop.y; y < crop.y + crop.h; y++) for (let x = crop.x; x < crop.x + crop.w; x++)
      if (x < r.x - 1 || y < r.y - 1 || x > r.x + r.w || y > r.y + r.h) out[y * W + x] = 0;
  }
  return out;
}

// ------------------------------------------------------------------ Select Sky
/** Sky: sky-coloured smooth region connected to the top edge (holes such as clouds are filled), refined at edges. */
export function detectSky(doc: PixDocument): Uint8Array | null {
  const W = doc.width, H = doc.height;
  const src = doc.getComposite();
  const pr = makeProxy(src, { x: 0, y: 0, w: W, h: H }, 256);
  const { data, w, h } = pr, n = w * h;
  const lab = toLab(data, n), L = lab.subarray(0, n), A = lab.subarray(n, 2 * n), B = lab.subarray(2 * n);
  const grad = gradientMagnitude(data, w, h);
  const skyLike = (i: number) => {
    const j = i * 4, r = data[j], g = data[j + 1], b = data[j + 2];
    if (data[j + 3] < 128) return false;
    const chroma = Math.hypot(A[i], B[i]);
    const blue = b > r + 8 && b >= g - 12 && B[i] < -4 && L[i] > 30;
    const overcast = L[i] > 68 && chroma < 16;
    const warm = L[i] > 55 && r > b && grad[i] < 0.03 && (i / w | 0) < h * 0.35; // sunset glow near the top
    return blue || overcast || warm;
  };
  const m = new Uint8Array(n), q = new Int32Array(n);
  let head = 0, tail = 0;
  for (let x = 0; x < w; x++) for (let y = 0; y < Math.min(2, h); y++) { const i = y * w + x; if (skyLike(i) && !m[i]) { m[i] = 255; q[tail++] = i; } }
  if (tail < w * 0.08) return null;
  while (head < tail) {
    const i = q[head++], x = i % w;
    for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, i >= w ? i - w : -1, i < n - w ? i + w : -1]) {
      if (j < 0 || m[j]) continue;
      const dE = Math.hypot(L[i] - L[j], A[i] - A[j], B[i] - B[j]);
      if (dE > 7 || grad[j] > 0.09 || !skyLike(j)) continue;
      m[j] = 255; q[tail++] = j;
    }
  }
  if (tail < n * 0.01) return null;
  let mm = fillHoles(m, w, h, n * 0.02);
  // refine with the colour model: sky region probable FG, everything below the lowest sky row definite BG
  const labels = new Uint8Array(n);
  let lowest = 0;
  for (let i = 0; i < n; i++) if (mm[i]) lowest = Math.max(lowest, (i / w) | 0);
  for (let i = 0; i < n; i++) {
    const y = (i / w) | 0;
    labels[i] = mm[i] ? (y < 2 ? FG : PR_FG) : y > Math.min(h - 1, lowest + 3) ? BG : PR_BG;
  }
  const p = segment(data, w, h, labels, { iters: 3 });
  mm = binarize(p);
  mm = keepLargest(mm, w, h, 0.05, m);
  mm = fillHoles(mm, w, h, n * 0.03);
  const full = sampleImage(doc, true);
  return upsampleToDoc(doc, full, pr, toFloat(mm));
}

// ------------------------------------------------------------------ on-canvas selection preview
export type PreviewMode = 'none' | 'grayscale' | 'black' | 'white' | 'quickmask';
const preview: { doc: PixDocument | null; mode: PreviewMode; canvas: HTMLCanvasElement | null } = { doc: null, mode: 'none', canvas: null };

/** Show `alpha` (doc-sized canvas, alpha = selected) on the canvas in a Photoshop "Selection Preview" mode. null clears. */
export function setSelectionPreview(doc: PixDocument | null, alpha: HTMLCanvasElement | null, mode: PreviewMode = 'grayscale') {
  if (!doc || !alpha || mode === 'none') {
    const had = preview.doc;
    preview.doc = null; preview.canvas = null; preview.mode = 'none';
    had?.invalidate();
    return;
  }
  const c = preview.canvas && preview.canvas.width === doc.width && preview.canvas.height === doc.height ? preview.canvas : createCanvas(doc.width, doc.height);
  const x = ctx2d(c);
  x.globalCompositeOperation = 'copy';
  if (mode === 'grayscale') {
    x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height);
    x.globalCompositeOperation = 'destination-in'; x.drawImage(alpha, 0, 0);
    x.globalCompositeOperation = 'destination-over'; x.fillStyle = '#000'; x.fillRect(0, 0, c.width, c.height);
  } else {
    x.fillStyle = mode === 'black' ? '#000' : mode === 'white' ? '#fff' : 'rgba(255,0,0,0.5)';
    x.fillRect(0, 0, c.width, c.height);
    x.globalCompositeOperation = 'destination-out'; x.drawImage(alpha, 0, 0);
  }
  x.globalCompositeOperation = 'source-over';
  preview.doc = doc; preview.canvas = c; preview.mode = mode;
  doc.invalidate();
}
export const previewActive = () => !!preview.doc;

viewportHooks.afterComposite.push((ctx, view, doc) => {
  if (preview.doc !== doc || !preview.canvas) return;
  view.applyDocTransform(ctx);
  ctx.imageSmoothingEnabled = view.zoom < 1;
  ctx.drawImage(preview.canvas, 0, 0);
});

/** Convenience for status messages while heavy work runs. */
export async function busy<T>(msg: string, fn: () => T): Promise<T> {
  document.body.classList.add('busy');
  app.status(msg);
  await new Promise(r => requestAnimationFrame(() => setTimeout(r, 0)));
  try { return fn(); } finally { document.body.classList.remove('busy'); app.status(''); }
}
