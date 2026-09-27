// Pixel selection. The mask is a document-sized canvas whose ALPHA channel is the selection amount.
// Every modification creates a NEW mask canvas (never mutated in place) so history snapshots stay valid.
// Wrap selection changes in doc.history.transaction('Name', () => ...).
import type { Point, Rect, SelectOp } from './types';
import { alphaBounds, createCanvas, ctx2d } from './canvas';
import { intersectRect } from './geom';
import type { PixDocument } from './document';

export interface SelectOptions { feather?: number; antiAlias?: boolean }

export class Selection {
  mask: HTMLCanvasElement | null = null;
  bounds: Rect | null = null;
  private _outline: Path2D | null = null;
  private _data: Uint8ClampedArray | null = null;

  constructor(private doc: PixDocument) {}

  get empty() { return !this.mask || !this.bounds; }
  get w() { return this.doc.width; }
  get h() { return this.doc.height; }

  state() { return { mask: this.mask, bounds: this.bounds ? { ...this.bounds } : null }; }
  setState(s: { mask: HTMLCanvasElement | null; bounds: Rect | null }) {
    this.mask = s.mask; this.bounds = s.bounds ? { ...s.bounds } : null;
    this._outline = null; this._data = null;
  }

  /** Replace/combine the selection with a document-sized alpha canvas. */
  apply(shape: HTMLCanvasElement | null, op: SelectOp = 'replace', feather = 0) {
    if (shape && feather > 0) shape = blurAlpha(shape, feather);
    let next: HTMLCanvasElement | null;
    if (op === 'replace' || (!this.mask && (op === 'add'))) {
      next = shape;
    } else if (!this.mask) {
      next = op === 'intersect' || op === 'subtract' ? null : shape;
    } else {
      next = createCanvas(this.w, this.h);
      const x = ctx2d(next);
      x.drawImage(this.mask, 0, 0);
      if (shape) {
        x.globalCompositeOperation = op === 'add' ? 'source-over' : op === 'subtract' ? 'destination-out' : 'destination-in';
        x.drawImage(shape, 0, 0);
      } else if (op === 'intersect') x.clearRect(0, 0, this.w, this.h);
    }
    this.setMask(next);
  }

  /** Set the mask directly (null = deselect). Recomputes bounds. */
  setMask(mask: HTMLCanvasElement | null) {
    if (mask && (mask.width !== this.w || mask.height !== this.h)) {
      const c = createCanvas(this.w, this.h);
      ctx2d(c).drawImage(mask, 0, 0);
      mask = c;
    }
    this.mask = mask;
    this.bounds = mask ? alphaBounds(mask, 0) : null;
    if (!this.bounds) this.mask = null;
    this._outline = null; this._data = null;
    this.doc.selectionChanged();
  }

  /** Build a doc-sized alpha canvas by filling a path. */
  shapeFromPath(path: Path2D | ((ctx: CanvasRenderingContext2D) => void), antiAlias = true): HTMLCanvasElement {
    const c = createCanvas(this.w, this.h), x = ctx2d(c);
    x.imageSmoothingEnabled = antiAlias;
    x.fillStyle = '#000';
    if (typeof path === 'function') path(x); else x.fill(path);
    if (!antiAlias) hardenAlpha(c);
    return c;
  }

  selectRect(r: Rect, op: SelectOp = 'replace', o: SelectOptions = {}) {
    const rr = { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.x + r.w) - Math.round(r.x), h: Math.round(r.y + r.h) - Math.round(r.y) };
    const p = new Path2D(); p.rect(rr.x, rr.y, rr.w, rr.h);
    this.apply(this.shapeFromPath(p, true), op, o.feather || 0);
  }
  selectEllipse(r: Rect, op: SelectOp = 'replace', o: SelectOptions = {}) {
    const p = new Path2D(); p.ellipse(r.x + r.w / 2, r.y + r.h / 2, Math.abs(r.w / 2), Math.abs(r.h / 2), 0, 0, Math.PI * 2);
    this.apply(this.shapeFromPath(p, o.antiAlias !== false), op, o.feather || 0);
  }
  selectPolygon(pts: Point[], op: SelectOp = 'replace', o: SelectOptions = {}) {
    if (pts.length < 3) return;
    const p = new Path2D(); p.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) p.lineTo(pts[i].x, pts[i].y);
    p.closePath();
    this.apply(this.shapeFromPath(p, o.antiAlias !== false), op, o.feather || 0);
  }
  selectPath(path: Path2D, op: SelectOp = 'replace', o: SelectOptions = {}) {
    this.apply(this.shapeFromPath(path, o.antiAlias !== false), op, o.feather || 0);
  }
  selectAll() {
    const c = createCanvas(this.w, this.h), x = ctx2d(c);
    x.fillRect(0, 0, this.w, this.h);
    this.setMask(c);
  }
  deselect() { if (this.mask) { this.doc.lastSelection = this.mask; } this.setMask(null); }
  invert() {
    const c = createCanvas(this.w, this.h), x = ctx2d(c);
    x.fillRect(0, 0, this.w, this.h);
    if (this.mask) { x.globalCompositeOperation = 'destination-out'; x.drawImage(this.mask, 0, 0); }
    this.setMask(c);
  }

  /** Selection value 0..255 at a document pixel (255 everywhere when there is no selection). */
  valueAt(x: number, y: number): number {
    if (!this.mask) return 255;
    x = Math.floor(x); y = Math.floor(y);
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return 0;
    if (!this._data) this._data = ctx2d(this.mask).getImageData(0, 0, this.w, this.h).data;
    return this._data[(y * this.w + x) * 4 + 3];
  }
  contains(x: number, y: number) { return this.valueAt(x, y) >= 128; }

  /** Alpha values (0..255) of the mask as a flat array w*h (copy). */
  alphaArray(): Uint8ClampedArray {
    const out = new Uint8ClampedArray(this.w * this.h);
    if (!this.mask) { out.fill(255); return out; }
    const d = ctx2d(this.mask).getImageData(0, 0, this.w, this.h).data;
    for (let i = 0, j = 3; i < out.length; i++, j += 4) out[i] = d[j];
    return out;
  }
  /** Build a mask from a flat alpha array (w*h). */
  static canvasFromAlpha(alpha: Uint8ClampedArray | Uint8Array, w: number, h: number): HTMLCanvasElement {
    const c = createCanvas(w, h), img = new ImageData(w, h), d = img.data;
    for (let i = 0, j = 0; i < alpha.length; i++, j += 4) d[j + 3] = alpha[i];
    ctx2d(c).putImageData(img, 0, 0);
    return c;
  }

  /** Marching-ants outline (document coordinates, pixel edges at the 50% threshold) as continuous loops. Cached. */
  outline(): Path2D | null {
    if (!this.mask || !this.bounds) return null;
    if (this._outline) return this._outline;
    const b = this.bounds, W = this.w, H = this.h;
    if (!this._data) this._data = ctx2d(this.mask).getImageData(0, 0, W, H).data;
    const d = this._data;
    const x0 = Math.max(0, b.x - 1), y0 = Math.max(0, b.y - 1), x1 = Math.min(W, b.x + b.w + 1), y1 = Math.min(H, b.y + b.h + 1);
    const sel = (x: number, y: number) => x >= 0 && y >= 0 && x < W && y < H && d[(y * W + x) * 4 + 3] >= 128;
    // directed boundary edges (clockwise around selected pixels), keyed by start vertex
    const VW = W + 1;
    const next = new Map<number, number[]>();
    const add = (ax: number, ay: number, bx: number, by: number) => {
      const k = ay * VW + ax, v = by * VW + bx, l = next.get(k);
      if (l) l.push(v); else next.set(k, [v]);
    };
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
      if (!sel(x, y)) continue;
      if (!sel(x, y - 1)) add(x, y, x + 1, y);
      if (!sel(x + 1, y)) add(x + 1, y, x + 1, y + 1);
      if (!sel(x, y + 1)) add(x + 1, y + 1, x, y + 1);
      if (!sel(x - 1, y)) add(x, y + 1, x, y);
    }
    const p = new Path2D();
    for (const [start] of next) {
      if (!next.has(start)) continue;
      let k = start, px = -1, py = -1, dirx = 0, diry = 0, first = true;
      let guard = 0;
      while (guard++ < 5e7) {
        const l = next.get(k);
        if (!l || !l.length) break;
        const v = l.pop()!;
        if (!l.length) next.delete(k);
        const kx = k % VW, ky = (k / VW) | 0, vx = v % VW, vy = (v / VW) | 0;
        const ndx = vx - kx, ndy = vy - ky;
        if (first) { p.moveTo(kx, ky); first = false; }
        else if (ndx !== dirx || ndy !== diry) p.lineTo(kx, ky);   // only emit corners
        dirx = ndx; diry = ndy; px = vx; py = vy;
        k = v;
        if (k === start) break;
      }
      if (!first) { p.lineTo(px, py); p.closePath(); }
    }
    return (this._outline = p);
  }
}

/** Gaussian-feather an alpha canvas (returns new canvas of same size). */
export function blurAlpha(src: HTMLCanvasElement, radius: number): HTMLCanvasElement {
  const c = createCanvas(src.width, src.height), x = ctx2d(c);
  x.filter = `blur(${radius / 2}px)`;
  x.drawImage(src, 0, 0);
  x.filter = 'none';
  return c;
}

/** Threshold alpha at 50% (removes anti-aliasing). In place – only use on fresh canvases. */
export function hardenAlpha(c: HTMLCanvasElement) {
  const x = ctx2d(c), img = x.getImageData(0, 0, c.width, c.height), d = img.data;
  for (let i = 3; i < d.length; i += 4) d[i] = d[i] >= 128 ? 255 : 0;
  x.putImageData(img, 0, 0);
}
