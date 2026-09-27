// Brush engine: tip generation, dab spacing/smoothing and the stroke-buffer paint pipeline
// (Photoshop semantics: Flow accumulates per dab inside the stroke, Opacity caps the whole stroke).
import type { BlendMode, Point, Rect, RGB } from './types';
import { createCanvas, ctx2d, borrowCanvas, returnCanvas } from './canvas';
import { blendPixels } from './compositor';
import { luma } from './color';
import type { PixDocument, PaintTarget } from './document';
import { RasterLayer } from './layer';
import type { PixelEdit } from './history';
import { unionRect, intersectRect } from './geom';

// ------------------------------------------------------------------ tips
export interface TipParams {
  size: number;           // diameter px
  hardness: number;       // 0..1
  roundness?: number;     // 0..1 (1 = circle)
  angle?: number;         // degrees
  aliased?: boolean;      // pencil
  tip?: HTMLCanvasElement | null; // sampled tip: alpha = coverage
}

const tipCache = new Map<string, HTMLCanvasElement>();
/** Black tip with alpha coverage, square canvas ≥ size. Cached (LRU-ish). */
export function getTip(p: TipParams): HTMLCanvasElement {
  const size = Math.max(0.5, p.size);
  const q = size < 20 ? Math.round(size * 4) / 4 : Math.round(size);
  const hard = Math.round(p.hardness * 100) / 100;
  const key = p.tip ? `s:${(p.tip as any).__id || ((p.tip as any).__id = Math.random())}:${q}` : `r:${q}:${hard}:${p.aliased ? 1 : 0}`;
  let t = tipCache.get(key);
  if (t) { tipCache.delete(key); tipCache.set(key, t); return t; }
  if (p.tip) {
    const d = Math.max(1, Math.ceil(q));
    const ratio = p.tip.height / p.tip.width;
    t = createCanvas(d, Math.max(1, Math.round(d * ratio)));
    const x = ctx2d(t); x.imageSmoothingQuality = 'high';
    x.drawImage(p.tip, 0, 0, t.width, t.height);
  } else t = makeRoundTip(q, hard, !!p.aliased);
  tipCache.set(key, t);
  if (tipCache.size > 96) tipCache.delete(tipCache.keys().next().value!);
  return t;
}

function makeRoundTip(size: number, hardness: number, aliased: boolean): HTMLCanvasElement {
  const d = Math.max(1, Math.ceil(size) + (aliased ? 0 : 2));
  const c = createCanvas(d, d), x = ctx2d(c);
  const img = x.createImageData(d, d), data = img.data;
  const R = size / 2, cx = d / 2, cy = d / 2;
  const inner = R * Math.min(0.999, hardness);
  for (let py = 0; py < d; py++) {
    for (let px = 0; px < d; px++) {
      const r = Math.hypot(px + 0.5 - cx, py + 0.5 - cy);
      let a: number;
      if (aliased) a = r <= Math.max(0.5, R) ? 1 : 0;
      else if (hardness >= 0.999) a = Math.max(0, Math.min(1, R - r + 0.5));
      else if (r <= inner) a = 1;
      else if (r >= R) a = 0;
      else {
        const t = (r - inner) / (R - inner);
        a = Math.pow(1 - t * t, 2) * (1 - 0.15 * t) ;       // smooth Gaussian-like falloff
      }
      data[(py * d + px) * 4 + 3] = Math.round(a * 255);
    }
  }
  x.putImageData(img, 0, 0);
  return c;
}

const tintCache = new Map<string, HTMLCanvasElement>();
/** Tip filled with a colour (cached). */
export function tintTip(tip: HTMLCanvasElement, color: RGB): HTMLCanvasElement {
  const key = `${(tip as any).__tid || ((tip as any).__tid = Math.random())}:${color.r},${color.g},${color.b}`;
  let t = tintCache.get(key);
  if (t) return t;
  t = createCanvas(tip.width, tip.height);
  const x = ctx2d(t);
  x.fillStyle = `rgb(${color.r},${color.g},${color.b})`;
  x.fillRect(0, 0, t.width, t.height);
  x.globalCompositeOperation = 'destination-in';
  x.drawImage(tip, 0, 0);
  tintCache.set(key, t);
  if (tintCache.size > 64) tintCache.delete(tintCache.keys().next().value!);
  return t;
}

// ------------------------------------------------------------------ dab placement
export interface InputPoint { x: number; y: number; pressure: number; tiltX?: number; tiltY?: number }
export interface Dab { x: number; y: number; pressure: number; size: number; angle: number; roundness: number; flow: number; color: RGB; index: number }

/** Converts pointer samples into evenly spaced dabs (with optional smoothing). */
export class DabSpacer {
  private last: InputPoint | null = null;
  private smooth: InputPoint | null = null;
  private carry = 0;
  count = 0;
  constructor(
    /** Spacing in px for a given pressure. */
    private stepFor: (p: InputPoint) => number,
    private emit: (p: InputPoint) => void,
    /** 0..1 */
    private smoothing = 0,
  ) {}
  add(raw: InputPoint) {
    let p = raw;
    if (this.smoothing > 0 && this.smooth) {
      const k = 1 - Math.min(0.95, this.smoothing * 0.93);
      p = { ...raw, x: this.smooth.x + (raw.x - this.smooth.x) * k, y: this.smooth.y + (raw.y - this.smooth.y) * k };
    }
    this.smooth = p;
    this.segmentTo(p);
  }
  /** Catch up to the final raw point (end of stroke). */
  finish(raw?: InputPoint) { if (raw && this.smoothing > 0 && this.last) this.segmentTo(raw); }
  private segmentTo(p: InputPoint) {
    if (!this.last) { this.last = p; this.carry = 0; this.emit(p); this.count++; return; }
    const a = this.last, dx = p.x - a.x, dy = p.y - a.y, len = Math.hypot(dx, dy);
    if (len === 0) return;
    let pos = this.stepFor(a) - this.carry;
    let t = 0;
    while (pos <= len) {
      t = pos / len;
      const q: InputPoint = { x: a.x + dx * t, y: a.y + dy * t, pressure: a.pressure + (p.pressure - a.pressure) * t, tiltX: p.tiltX, tiltY: p.tiltY };
      this.emit(q); this.count++;
      pos += Math.max(0.25, this.stepFor(q));
    }
    this.carry = len - (pos - Math.max(0.25, this.stepFor(p)));
    if (this.carry < 0) this.carry = 0;
    this.last = p;
  }
}

// ------------------------------------------------------------------ stroke pipeline
export type BrushMode = BlendMode | 'behind' | 'clear';

export interface StrokeOptions {
  size: number;
  hardness: number;
  spacing?: number;          // fraction of size (default 0.25)
  roundness?: number;
  angle?: number;
  tip?: HTMLCanvasElement | null;
  aliased?: boolean;
  opacity: number;           // 0..1 stroke cap
  flow: number;              // 0..1 per dab
  color: RGB;
  mode?: 'paint' | 'erase';
  blendMode?: BrushMode;
  pressureSize?: boolean;
  pressureOpacity?: boolean;
  smoothing?: number;        // 0..1
  airbrush?: boolean;        // keep depositing while held still
  /** Modify / multiply each dab (brush dynamics: jitter, scatter, color dynamics). */
  transformDab?: (dab: Dab) => Dab | Dab[] | null;
  /** Custom dab renderer (clone stamp, pattern stamp, history brush). Draws into the stroke buffer.
   *  bx is in TARGET canvas coords (use dab.x - offset.x). Default draws the tinted tip. */
  renderDab?: (bx: CanvasRenderingContext2D, dab: Dab, tip: HTMLCanvasElement, offset: Point) => void;
  /** History state name, e.g. 'Brush Tool'. */
  historyName: string;
  historyIcon?: string;
}

/**
 * Paint stroke on the document's current paint target (layer pixels, layer mask or quick mask).
 * Usage: const s = PaintStroke.start(doc, opts, p); s?.move(p); s?.end();
 */
export class PaintStroke {
  readonly target: PaintTarget;
  private buffer: HTMLCanvasElement;
  private bx: CanvasRenderingContext2D;
  private edit: PixelEdit;
  private spacer: DabSpacer;
  private pending: Rect | null = null;
  private total: Rect | null = null;
  private raf = 0;
  private airTimer = 0;
  private lastPoint: InputPoint | null = null;
  private selMask: HTMLCanvasElement | null;
  private dabIndex = 0;
  private lockAlpha: boolean;

  static start(doc: PixDocument, opts: StrokeOptions, p: InputPoint): PaintStroke | null {
    const target = doc.getPaintTarget();
    if (!target) return null;
    if (target.kind === 'pixels' && target.layer!.pixelsLocked) return null;
    return new PaintStroke(doc, target, opts, p);
  }

  private constructor(readonly doc: PixDocument, target: PaintTarget, readonly opts: StrokeOptions, p: InputPoint) {
    this.target = target;
    if (target.kind === 'pixels') (target.layer as RasterLayer).ensureRect({ x: 0, y: 0, w: doc.width, h: doc.height });
    const h = target.holder;
    this.buffer = createCanvas(h.canvas.width, h.canvas.height);
    this.bx = ctx2d(this.buffer);
    this.edit = doc.history.beginPixelEdit(h, opts.historyName, opts.historyIcon);
    this.selMask = doc.quickMask ? null : doc.selection.mask;
    this.lockAlpha = target.kind === 'pixels' && !!target.layer?.transparencyLocked && opts.blendMode !== 'behind';
    const spacing = opts.spacing ?? 0.25;
    this.spacer = new DabSpacer(
      q => Math.max(0.5, spacing * this.sizeAt(q.pressure)),
      q => this.dab(q),
      opts.smoothing || 0,
    );
    this.move(p);
    if (opts.airbrush) this.airTimer = window.setInterval(() => { if (this.lastPoint) { this.dab(this.lastPoint); } }, 50);
  }

  private sizeAt(pressure: number) { return this.opts.pressureSize ? Math.max(1, this.opts.size * pressure) : this.opts.size; }

  move(p: InputPoint) {
    this.lastPoint = p;
    this.spacer.add(p);
  }

  private dab(q: InputPoint) {
    const o = this.opts;
    let dabs: Dab | Dab[] | null = {
      x: q.x, y: q.y, pressure: q.pressure, size: this.sizeAt(q.pressure),
      angle: o.angle || 0, roundness: o.roundness ?? 1,
      flow: o.flow * (o.pressureOpacity ? q.pressure : 1), color: o.color, index: this.dabIndex++,
    };
    if (o.transformDab) dabs = o.transformDab(dabs);
    if (!dabs) return;
    for (const d of Array.isArray(dabs) ? dabs : [dabs]) this.drawDab(d);
  }

  private drawDab(d: Dab) {
    const o = this.opts, h = this.target.holder;
    const tip = getTip({ size: d.size, hardness: o.hardness, tip: o.tip, aliased: o.aliased });
    const bx = this.bx;
    const cx = d.x - h.x, cy = d.y - h.y;
    const ext = Math.max(tip.width, tip.height) / 2 + 2;
    const r = { x: d.x - ext, y: d.y - ext, w: ext * 2, h: ext * 2 };
    if (o.renderDab) {
      o.renderDab(bx, d, tip, { x: h.x, y: h.y });
    } else {
      const colored = tintTip(tip, this.target.isMask ? { r: 0, g: 0, b: 0 } : d.color);
      bx.save();
      bx.globalAlpha = Math.max(0, Math.min(1, d.flow));
      if (o.aliased) { bx.imageSmoothingEnabled = false; }
      bx.translate(o.aliased ? Math.round(cx) : cx, o.aliased ? Math.round(cy) : cy);
      if (d.angle) bx.rotate((d.angle * Math.PI) / 180);
      if (d.roundness < 1) bx.scale(1, Math.max(0.01, d.roundness));
      bx.drawImage(colored, -tip.width / 2, -tip.height / 2);
      bx.restore();
    }
    this.pending = unionRect(this.pending, r);
    if (!this.raf) this.raf = requestAnimationFrame(() => this.flush());
  }

  /** Recompose the dirty area of the target: original pixels + stroke buffer. */
  private flush() {
    this.raf = 0;
    const pr = this.pending;
    this.pending = null;
    if (!pr) return;
    const h = this.target.holder;
    const canvasRect = { x: 0, y: 0, w: h.canvas.width, h: h.canvas.height };
    const local = intersectRect({ x: Math.floor(pr.x - h.x), y: Math.floor(pr.y - h.y), w: Math.ceil(pr.w) + 2, h: Math.ceil(pr.h) + 2 }, canvasRect);
    if (!local) return;
    this.total = unionRect(this.total, local);
    this.compose(local);
    this.doc.invalidate({ x: local.x + h.x, y: local.y + h.y, w: local.w, h: local.h });
  }

  private compose(D: Rect) {
    const o = this.opts, h = this.target.holder, hx = ctx2d(h.canvas);
    // stroke buffer region masked by the selection
    const s = borrowCanvas(D.w, D.h), sx = ctx2d(s);
    sx.drawImage(this.buffer, -D.x, -D.y);
    if (this.selMask) {
      sx.globalCompositeOperation = 'destination-in';
      sx.drawImage(this.selMask, -D.x - h.x, -D.y - h.y);
      sx.globalCompositeOperation = 'source-over';
    }
    hx.save();
    hx.beginPath(); hx.rect(D.x, D.y, D.w, D.h); hx.clip();
    hx.globalCompositeOperation = 'copy';
    hx.drawImage(this.edit.original, 0, 0);
    hx.globalCompositeOperation = 'source-over';
    const opacity = Math.max(0, Math.min(1, o.opacity));
    if (this.target.isMask) {
      // mask semantics: value = grey level of colour; dst = dst*(1-s) + v*s
      const v = o.mode === 'erase' ? 0 : luma(o.color.r, o.color.g, o.color.b) / 255;
      hx.globalAlpha = opacity;
      hx.globalCompositeOperation = 'destination-out';
      hx.drawImage(s, D.x, D.y);
      if (v > 0) {
        hx.globalAlpha = opacity * v;
        hx.globalCompositeOperation = 'lighter';
        hx.drawImage(s, D.x, D.y);
      }
    } else if (o.mode === 'erase' || o.blendMode === 'clear') {
      hx.globalAlpha = opacity;
      hx.globalCompositeOperation = 'destination-out';
      hx.drawImage(s, D.x, D.y);
    } else {
      const bm = o.blendMode || 'normal';
      const nativeOps: Record<string, GlobalCompositeOperation> = {
        normal: 'source-over', behind: 'destination-over', darken: 'darken', multiply: 'multiply', 'color-burn': 'color-burn',
        lighten: 'lighten', screen: 'screen', 'color-dodge': 'color-dodge', overlay: 'overlay', 'soft-light': 'soft-light',
        'hard-light': 'hard-light', difference: 'difference', exclusion: 'exclusion', hue: 'hue', saturation: 'saturation',
        color: 'color', luminosity: 'luminosity',
      };
      if (this.lockAlpha) {
        // paint only where pixels exist: blend into a copy, then keep original alpha
        const t = borrowCanvas(D.w, D.h), tx = ctx2d(t);
        tx.drawImage(this.edit.original, -D.x, -D.y);
        tx.globalAlpha = opacity;
        tx.globalCompositeOperation = nativeOps[bm] && bm !== 'behind' ? nativeOps[bm] : 'source-over';
        tx.drawImage(s, 0, 0);
        tx.globalAlpha = 1;
        tx.globalCompositeOperation = 'destination-in';
        tx.drawImage(this.edit.original, -D.x, -D.y);
        hx.globalCompositeOperation = 'copy';
        hx.drawImage(t, D.x, D.y);
        returnCanvas(t);
      } else if (nativeOps[bm]) {
        hx.globalAlpha = opacity;
        hx.globalCompositeOperation = nativeOps[bm];
        hx.drawImage(s, D.x, D.y);
      } else {
        hx.restore();
        const dst = hx.getImageData(D.x, D.y, D.w, D.h);
        blendPixels(dst.data, sx.getImageData(0, 0, D.w, D.h).data, bm as BlendMode, opacity, D.w, D.x + h.x, D.y + h.y);
        hx.putImageData(dst, D.x, D.y);
        returnCanvas(s);
        return;
      }
    }
    hx.restore();
    returnCanvas(s);
  }

  /** Finish the stroke and record history. */
  end(p?: InputPoint) {
    if (this.airTimer) clearInterval(this.airTimer);
    this.spacer.finish(p);
    if (this.raf) { cancelAnimationFrame(this.raf); this.raf = 0; }
    this.flush();
    const h = this.target.holder;
    if (this.total) {
      this.edit.commit(this.opts.historyName, this.total, this.opts.historyIcon);
      this.doc.pixelsChanged(this.target.layer, { x: this.total.x + h.x, y: this.total.y + h.y, w: this.total.w, h: this.total.h });
    } else this.edit.cancel();
  }
  cancel() {
    if (this.airTimer) clearInterval(this.airTimer);
    if (this.raf) cancelAnimationFrame(this.raf);
    this.edit.cancel();
    this.doc.invalidate();
  }
}
