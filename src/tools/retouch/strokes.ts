// Stroke engines for the retouching tools.
//  * BufferStroke: stamp tools (Clone Stamp, Pattern Stamp, Healing Brush preview). Dabs are rendered into a stroke
//    buffer (flow accumulates per dab, opacity caps the stroke) which is composited over the original pixels.
//  * DirectStroke: tools that transform existing pixels (Blur, Sharpen, Smudge, Dodge, Burn, Sponge). Dabs are queued
//    and processed per animation frame on the ImageData of the union of their rects only.
import { DabSpacer, type InputPoint } from '../../core/brush';
import type { PixDocument, PaintTarget } from '../../core/document';
import { RasterLayer } from '../../core/layer';
import type { PixelEdit } from '../../core/history';
import { borrowCanvas, createCanvas, ctx2d, returnCanvas } from '../../core/canvas';
import { blendPixels } from '../../core/compositor';
import { intersectRect, unionRect } from '../../core/geom';
import type { BlendMode, Rect } from '../../core/types';
import { selectionAlpha, tipAlpha, tipCanvas, readTarget, writeTarget, type BrushLike } from './common';

export interface DabInfo { x: number; y: number; size: number; pressure: number; flow: number; index: number }

export interface StrokeBase extends BrushLike {
  historyName: string;
  airbrush?: boolean;
  smoothing?: number;
}

function prepare(doc: PixDocument, t: PaintTarget) {
  if (t.kind === 'pixels') (t.layer as RasterLayer).ensureRect({ x: 0, y: 0, w: doc.width, h: doc.height });
}

// ================================================================== BufferStroke
export interface BufferOpts extends StrokeBase {
  opacity: number;              // 0..1
  flow: number;                 // 0..1
  blendMode: BlendMode;
  pressureOpacity?: boolean;
  /** Draw one dab into the buffer. `tl` = top-left of the tip in DOC coords (integers). Buffer is in holder coords. */
  renderDab(bx: CanvasRenderingContext2D, dab: DabInfo, tip: HTMLCanvasElement, tl: { x: number; y: number }, holder: { x: number; y: number }): void;
}

const NATIVE: Record<string, GlobalCompositeOperation> = {
  normal: 'source-over', darken: 'darken', multiply: 'multiply', 'color-burn': 'color-burn', lighten: 'lighten', screen: 'screen',
  'color-dodge': 'color-dodge', overlay: 'overlay', 'soft-light': 'soft-light', 'hard-light': 'hard-light', difference: 'difference',
  exclusion: 'exclusion', hue: 'hue', saturation: 'saturation', color: 'color', luminosity: 'luminosity',
};

export class BufferStroke {
  readonly buffer: HTMLCanvasElement;
  readonly edit: PixelEdit;
  total: Rect | null = null;              // holder coords
  private bx: CanvasRenderingContext2D;
  private spacer: DabSpacer;
  private pending: Rect | null = null;
  private raf = 0;
  private air = 0;
  private last: InputPoint | null = null;
  private index = 0;
  private sel: HTMLCanvasElement | null;
  private lockAlpha: boolean;

  constructor(readonly doc: PixDocument, readonly target: PaintTarget, readonly o: BufferOpts, p: InputPoint) {
    prepare(doc, target);
    const hc = target.holder.canvas;
    this.buffer = createCanvas(hc.width, hc.height);
    this.bx = ctx2d(this.buffer);
    this.edit = doc.history.beginPixelEdit(target.holder, o.historyName);
    this.sel = doc.quickMask || doc.selection.empty ? null : doc.selection.mask;
    this.lockAlpha = target.kind === 'pixels' && !!target.layer?.transparencyLocked;
    const spacing = (o.spacing ?? 25) / 100;
    this.spacer = new DabSpacer(q => Math.max(0.5, spacing * this.sizeAt(q.pressure)), q => this.dab(q), o.smoothing || 0);
    this.move(p);
    if (o.airbrush) this.air = window.setInterval(() => { if (this.last) this.dab(this.last); }, 60);
  }
  private sizeAt(pr: number) { return this.o.pressureSize ? Math.max(1, this.o.size * pr) : this.o.size; }
  move(p: InputPoint) { this.last = p; this.spacer.add(p); }

  private dab(q: InputPoint) {
    const o = this.o, size = this.sizeAt(q.pressure);
    const tip = tipCanvas(o, size);
    const tl = { x: Math.round(q.x - tip.width / 2), y: Math.round(q.y - tip.height / 2) };
    const d: DabInfo = { x: q.x, y: q.y, size, pressure: q.pressure, flow: o.flow * (o.pressureOpacity ? q.pressure : 1), index: this.index++ };
    const h = this.target.holder;
    this.bx.save();
    o.renderDab(this.bx, d, tip, tl, { x: h.x, y: h.y });
    this.bx.restore();
    this.pending = unionRect(this.pending, { x: tl.x - h.x, y: tl.y - h.y, w: tip.width, h: tip.height });
    if (!this.raf) this.raf = requestAnimationFrame(() => this.flush());
  }

  private flush() {
    this.raf = 0;
    const pr = this.pending; this.pending = null;
    if (!pr) return;
    const h = this.target.holder;
    const D = intersectRect(pr, { x: 0, y: 0, w: h.canvas.width, h: h.canvas.height });
    if (!D) return;
    this.total = unionRect(this.total, D);
    this.compose(D);
    this.doc.invalidate({ x: D.x + h.x, y: D.y + h.y, w: D.w, h: D.h });
  }

  private compose(D: Rect) {
    const o = this.o, h = this.target.holder, hx = ctx2d(h.canvas);
    const s = borrowCanvas(D.w, D.h), sx = ctx2d(s);
    sx.drawImage(this.buffer, -D.x, -D.y);
    if (this.sel) { sx.globalCompositeOperation = 'destination-in'; sx.drawImage(this.sel, -D.x - h.x, -D.y - h.y); sx.globalCompositeOperation = 'source-over'; }
    const opacity = Math.max(0, Math.min(1, o.opacity));
    if (this.target.isMask) {
      // mask: value = grey of the buffer colour, mixed by buffer alpha × opacity
      const orig = ctx2d(this.edit.original).getImageData(D.x, D.y, D.w, D.h), od = orig.data;
      const bd = sx.getImageData(0, 0, D.w, D.h).data;
      for (let i = 0; i < od.length; i += 4) {
        const k = (bd[i + 3] / 255) * opacity;
        if (k <= 0) continue;
        const v = 0.299 * bd[i] + 0.587 * bd[i + 1] + 0.114 * bd[i + 2];
        od[i + 3] = od[i + 3] * (1 - k) + v * k;
      }
      hx.putImageData(orig, D.x, D.y);
      returnCanvas(s);
      return;
    }
    hx.save();
    hx.beginPath(); hx.rect(D.x, D.y, D.w, D.h); hx.clip();
    hx.globalCompositeOperation = 'copy';
    hx.drawImage(this.edit.original, 0, 0);
    const bm = o.blendMode || 'normal';
    if (this.lockAlpha) {
      const t = borrowCanvas(D.w, D.h), tx = ctx2d(t);
      tx.drawImage(this.edit.original, -D.x, -D.y);
      tx.globalAlpha = opacity;
      tx.globalCompositeOperation = NATIVE[bm] || 'source-over';
      tx.drawImage(s, 0, 0);
      tx.globalAlpha = 1;
      tx.globalCompositeOperation = 'destination-in';
      tx.drawImage(this.edit.original, -D.x, -D.y);
      hx.globalCompositeOperation = 'copy';
      hx.drawImage(t, D.x, D.y);
      returnCanvas(t);
    } else if (NATIVE[bm]) {
      hx.globalCompositeOperation = NATIVE[bm];
      hx.globalAlpha = opacity;
      hx.drawImage(s, D.x, D.y);
    } else {
      hx.restore();
      const dst = hx.getImageData(D.x, D.y, D.w, D.h);
      blendPixels(dst.data, sx.getImageData(0, 0, D.w, D.h).data, bm, opacity, D.w, D.x + h.x, D.y + h.y);
      hx.putImageData(dst, D.x, D.y);
      returnCanvas(s);
      return;
    }
    hx.restore();
    returnCanvas(s);
  }

  private stop() {
    if (this.air) { clearInterval(this.air); this.air = 0; }
    this.spacer.finish(this.last || undefined);
    if (this.raf) { cancelAnimationFrame(this.raf); this.raf = 0; }
    this.flush();
  }
  /** Finish and record history (commit=false leaves the edit open: caller must commit/cancel `edit`). */
  end(commit = true): Rect | null {
    this.stop();
    if (!commit) return this.total;
    const h = this.target.holder;
    if (this.total) {
      this.edit.commit(this.o.historyName, this.total);
      this.doc.pixelsChanged(this.target.layer, { x: this.total.x + h.x, y: this.total.y + h.y, w: this.total.w, h: this.total.h });
    } else this.edit.cancel();
    return this.total;
  }
  cancel() {
    if (this.air) clearInterval(this.air);
    if (this.raf) cancelAnimationFrame(this.raf);
    this.edit.cancel();
    this.doc.invalidate();
  }
}

// ================================================================== DirectStroke
export interface DabCtx {
  /** RGBA of the region (holder pixels; masks as grey), modified in place. */
  data: Uint8ClampedArray;
  /** What to sample from: composite (Sample All Layers) or `data` itself. */
  src: Uint8ClampedArray;
  rw: number; rh: number;
  /** Tip top-left in region coords and tip size. */
  x0: number; y0: number; tw: number; th: number;
  /** Tip rect clipped to the region. */
  bx0: number; by0: number; bx1: number; by1: number;
  /** Weight per tip pixel (tip alpha × strength × selection), index (y−y0)·tw + (x−x0). */
  w: Float32Array;
  dab: DabInfo;
  isMask: boolean;
  lockAlpha: boolean;
}
export interface DirectOpts extends StrokeBase {
  strength: number;             // 0..1 multiplier on the weights
  pressureStrength?: boolean;
  margin?: number;              // extra px read around each dab (kernels)
  sampleAll?: boolean;
  process(c: DabCtx): void;
}

export class DirectStroke {
  readonly edit: PixelEdit;
  total: Rect | null = null;
  private spacer: DabSpacer;
  private queue: { tl: { x: number; y: number }; tip: HTMLCanvasElement; dab: DabInfo }[] = [];
  private pending: Rect | null = null;
  private raf = 0;
  private air = 0;
  private last: InputPoint | null = null;
  private index = 0;
  private sel: Uint8Array | null;
  private lockAlpha: boolean;

  constructor(readonly doc: PixDocument, readonly target: PaintTarget, readonly o: DirectOpts, p: InputPoint) {
    prepare(doc, target);
    this.edit = doc.history.beginPixelEdit(target.holder, o.historyName);
    this.sel = selectionAlpha(doc);
    this.lockAlpha = target.kind === 'pixels' && !!target.layer?.transparencyLocked;
    const spacing = (o.spacing ?? 25) / 100;
    this.spacer = new DabSpacer(q => Math.max(0.5, spacing * this.sizeAt(q.pressure)), q => this.dab(q), o.smoothing || 0);
    this.move(p);
    if (o.airbrush) this.air = window.setInterval(() => { if (this.last) this.dab(this.last); }, 60);
  }
  private sizeAt(pr: number) { return this.o.pressureSize ? Math.max(1, this.o.size * pr) : this.o.size; }
  move(p: InputPoint) { this.last = p; this.spacer.add(p); }

  private dab(q: InputPoint) {
    const size = this.sizeAt(q.pressure);
    const tip = tipCanvas(this.o, size);
    const h = this.target.holder;
    const tl = { x: Math.round(q.x - tip.width / 2) - h.x, y: Math.round(q.y - tip.height / 2) - h.y };
    const flow = this.o.strength * (this.o.pressureStrength ? q.pressure : 1);
    this.queue.push({ tl, tip, dab: { x: q.x - h.x, y: q.y - h.y, size, pressure: q.pressure, flow, index: this.index++ } });
    const m = this.o.margin || 0;
    this.pending = unionRect(this.pending, { x: tl.x - m, y: tl.y - m, w: tip.width + 2 * m, h: tip.height + 2 * m });
    if (!this.raf) this.raf = requestAnimationFrame(() => this.flush());
  }

  private flush() {
    this.raf = 0;
    const pr = this.pending, queue = this.queue;
    this.pending = null; this.queue = [];
    if (!pr || !queue.length) return;
    const t = this.target, h = t.holder;
    const R = intersectRect(pr, { x: 0, y: 0, w: h.canvas.width, h: h.canvas.height });
    if (!R) return;
    const img = readTarget(t, R), data = img.data;
    let alpha0: Uint8ClampedArray | null = null;
    if (this.lockAlpha) { alpha0 = new Uint8ClampedArray(R.w * R.h); for (let i = 0, j = 3; i < alpha0.length; i++, j += 4) alpha0[i] = data[j]; }
    let src = data;
    if (this.o.sampleAll && !t.isMask) {
      src = new Uint8ClampedArray(data);
      const dr = intersectRect({ x: R.x + h.x, y: R.y + h.y, w: R.w, h: R.h }, { x: 0, y: 0, w: this.doc.width, h: this.doc.height });
      if (dr) {
        const cd = ctx2d(this.doc.getComposite()).getImageData(dr.x, dr.y, dr.w, dr.h).data;
        for (let y = 0; y < dr.h; y++) {
          const so = y * dr.w * 4, dO = ((dr.y - h.y - R.y + y) * R.w + (dr.x - h.x - R.x)) * 4;
          src.set(cd.subarray(so, so + dr.w * 4), dO);
        }
      }
    }
    const dw = this.doc.width, dh = this.doc.height, sel = this.sel;
    for (const q of queue) {
      const tw = q.tip.width, th = q.tip.height, ta = tipAlpha(q.tip);
      const x0 = q.tl.x - R.x, y0 = q.tl.y - R.y;
      const bx0 = Math.max(0, x0), by0 = Math.max(0, y0), bx1 = Math.min(R.w, x0 + tw), by1 = Math.min(R.h, y0 + th);
      if (bx1 <= bx0 || by1 <= by0) continue;
      const w = new Float32Array(tw * th), k = q.dab.flow / 255;
      for (let y = by0; y < by1; y++) {
        const dy = y + R.y + h.y;
        for (let x = bx0; x < bx1; x++) {
          const ti = (y - y0) * tw + (x - x0);
          let v = ta[ti] * k;
          if (v && sel) { const dx = x + R.x + h.x; v *= dx >= 0 && dy >= 0 && dx < dw && dy < dh ? sel[dy * dw + dx] / 255 : 0; }
          w[ti] = v;
        }
      }
      q.dab.x -= R.x; q.dab.y -= R.y;
      this.o.process({ data, src: src === data ? data : src, rw: R.w, rh: R.h, x0, y0, tw, th, bx0, by0, bx1, by1, w, dab: q.dab, isMask: t.isMask, lockAlpha: this.lockAlpha });
    }
    if (alpha0) for (let i = 0, j = 3; i < alpha0.length; i++, j += 4) data[j] = alpha0[i];
    writeTarget(t, img, R);
    this.total = unionRect(this.total, R);
    this.doc.invalidate({ x: R.x + h.x, y: R.y + h.y, w: R.w, h: R.h });
  }

  end() {
    if (this.air) { clearInterval(this.air); this.air = 0; }
    this.spacer.finish(this.last || undefined);
    if (this.raf) { cancelAnimationFrame(this.raf); this.raf = 0; }
    this.flush();
    const h = this.target.holder;
    if (this.total) {
      this.edit.commit(this.o.historyName, this.total);
      this.doc.pixelsChanged(this.target.layer, { x: this.total.x + h.x, y: this.total.y + h.y, w: this.total.w, h: this.total.h });
    } else this.edit.cancel();
  }
  cancel() {
    if (this.air) clearInterval(this.air);
    if (this.raf) cancelAnimationFrame(this.raf);
    this.edit.cancel();
    this.doc.invalidate();
  }
}
