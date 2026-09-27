// Shared adjustment engine: definition helper, compiled-kernel cache, LUT builders (1D + 3D), histograms,
// auto-correction math and "source image" helpers (what an adjustment reads: the target layer for Image ›
// Adjustments dialogs, the composite below for adjustment layers).
import { registerAdjustment, type AdjustmentContext } from '../core/registry';
import type { PixDocument } from '../core/document';
import { AdjustmentLayer, GroupLayer, type Layer } from '../core/layer';
import { renderLayersToCanvas } from '../core/compositor';
import { createCanvas, ctx2d } from '../core/canvas';
import type { RGB } from '../core/types';

// ------------------------------------------------------------------ definitions
export type Kernel = (img: ImageData, ctx: AdjustmentContext) => void;
/** UI change callback: final=true when an interaction ended (slider release, field commit, click). */
export type Change = (final?: boolean) => void;

export interface AdjDef<P = any> {
  type: string;
  label: string;
  icon?: string;
  defaults(): P;
  /** Build a fast pixel kernel for the params (cached by params). */
  compile(p: P): Kernel;
  /** PS-like controls, shared by the dialog and the Properties panel. Mutate `p` then call change(). */
  build?(el: HTMLElement, p: P, change: Change, env: Env): void | (() => void);
  /** Built-in presets: [name, mutate(defaultsCopy)]. */
  presets?: [string, (p: P) => void][];
  /** Applied immediately from the menu (Invert, Desaturate, Equalize). */
  immediate?: boolean;
  /** Only available from Image › Adjustments (not as an adjustment layer). */
  dialogOnly?: boolean;
  dialogWidth?: number;
  /** Dialog title / history name when different from label. */
  historyName?: string;
}

export const defs: Record<string, AdjDef> = {};

export function defineAdjustment<P>(def: AdjDef<P>) {
  defs[def.type] = def;
  registerAdjustment({
    type: def.type, label: def.label, icon: def.icon,
    defaults: () => def.defaults(),
    apply(img, params, ctx) { kernelFor(def, params)(img, ctx); },
    ui(container, params, onChange, doc) {
      if (!def.build) return;
      return def.build(container, params, (final?: boolean) => (onChange as any)(params, final), new Env(doc));
    },
  });
}

// ------------------------------------------------------------------ kernel cache (keyed by params)
const cache = new Map<string, Kernel>();
const keyReplacer = (k: string, v: any) => (k[0] === '_' || k === 'cubeText' ? undefined : v);
export function paramsKey(type: string, p: any) { return type + ':' + JSON.stringify(p, keyReplacer); }
export function kernelFor(def: AdjDef, p: any): Kernel {
  const key = paramsKey(def.type, p);
  let fn = cache.get(key);
  if (fn) { cache.delete(key); cache.set(key, fn); return fn; }
  fn = def.compile(p);
  cache.set(key, fn);
  if (cache.size > 48) cache.delete(cache.keys().next().value!);
  return fn;
}
export const noop: Kernel = () => {};

export const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));
/** Fresh defaults with a preset applied. */
export function presetParams<P>(def: AdjDef<P>, name: string): P | null {
  const pr = def.presets?.find(x => x[0] === name);
  if (!pr) return null;
  const p = def.defaults();
  pr[1](p);
  return p;
}

// ------------------------------------------------------------------ math helpers
export const clamp = (v: number, lo = 0, hi = 255) => (v < lo ? lo : v > hi ? hi : v);
export const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
export const lum01 = (r: number, g: number, b: number) => 0.3 * r + 0.59 * g + 0.11 * b;

/** W3C SetLum/ClipColor (0..1 floats), writes into out. */
export function setLum(r: number, g: number, b: number, l: number, out: number[] | Float32Array) {
  const d = l - lum01(r, g, b);
  r += d; g += d; b += d;
  const L = lum01(r, g, b), n = Math.min(r, g, b), x = Math.max(r, g, b);
  if (n < 0) { const k = L / (L - n || 1); r = L + (r - L) * k; g = L + (g - L) * k; b = L + (b - L) * k; }
  if (x > 1) { const k = (1 - L) / (x - L || 1); r = L + (r - L) * k; g = L + (g - L) * k; b = L + (b - L) * k; }
  out[0] = r; out[1] = g; out[2] = b;
}

/** HSL (all 0..1) helpers operating on floats, hue in 0..1. */
export function rgb2hsl(r: number, g: number, b: number, out: number[] | Float32Array) {
  const mx = r > g ? (r > b ? r : b) : g > b ? g : b, mn = r < g ? (r < b ? r : b) : g < b ? g : b;
  const l = (mx + mn) / 2, d = mx - mn;
  let h = 0, s = 0;
  if (d > 1e-6) {
    s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
    if (mx === r) h = (g - b) / d + (g < b ? 6 : 0);
    else if (mx === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h /= 6;
  }
  out[0] = h; out[1] = s; out[2] = l;
}
const hue2 = (p: number, q: number, t: number) => {
  if (t < 0) t += 1; else if (t > 1) t -= 1;
  if (t < 1 / 6) return p + (q - p) * 6 * t;
  if (t < 0.5) return q;
  if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
  return p;
};
export function hsl2rgb(h: number, s: number, l: number, out: number[] | Float32Array) {
  if (s <= 0) { out[0] = out[1] = out[2] = l; return; }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
  out[0] = hue2(p, q, h + 1 / 3); out[1] = hue2(p, q, h); out[2] = hue2(p, q, h - 1 / 3);
}

export const srgbToLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
export const linearToSrgb = (c: number) => (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);

// ------------------------------------------------------------------ 1D LUTs
export const identityLUT = () => { const l = new Uint8Array(256); for (let i = 0; i < 256; i++) l[i] = i; return l; };
export const isIdentity = (l: Uint8Array) => { for (let i = 0; i < 256; i++) if (l[i] !== i) return false; return true; };
export function lutFrom(fn: (v: number) => number): Uint8Array {
  const l = new Uint8Array(256);
  for (let i = 0; i < 256; i++) l[i] = clamp(Math.round(fn(i)));
  return l;
}
/** out[v] = b[a[v]] */
export function composeLUT(a: Uint8Array, b: Uint8Array): Uint8Array {
  const o = new Uint8Array(256);
  for (let i = 0; i < 256; i++) o[i] = b[a[i]];
  return o;
}
export function lutKernel(r: Uint8Array, g: Uint8Array, b: Uint8Array): Kernel {
  if (isIdentity(r) && isIdentity(g) && isIdentity(b)) return noop;
  return img => {
    const d = img.data;
    for (let i = 0; i < d.length; i += 4) { d[i] = r[d[i]]; d[i + 1] = g[d[i + 1]]; d[i + 2] = b[d[i + 2]]; }
  };
}

export interface LevelsCh { inBlack: number; inWhite: number; gamma: number; outBlack: number; outWhite: number }
export const levelsDefault = (): LevelsCh => ({ inBlack: 0, inWhite: 255, gamma: 1, outBlack: 0, outWhite: 255 });
export function levelsLUT(c: LevelsCh): Uint8Array {
  const ib = c.inBlack, iw = Math.max(ib + 1, c.inWhite), ig = 1 / Math.max(0.01, c.gamma);
  const l = new Uint8Array(256);
  for (let v = 0; v < 256; v++) {
    let x = (v - ib) / (iw - ib);
    x = x < 0 ? 0 : x > 1 ? 1 : x;
    if (ig !== 1) x = Math.pow(x, ig);
    l[v] = clamp(Math.round(c.outBlack + x * (c.outWhite - c.outBlack)));
  }
  return l;
}

/** Monotone cubic (Fritsch–Carlson) curve through points (0..255) → 256-entry LUT. Flat outside the end points. */
export function curveLUT(points: number[][]): Uint8Array {
  const pts = [...points].sort((a, b) => a[0] - b[0]);
  const n = pts.length, l = new Uint8Array(256);
  if (!n) return identityLUT();
  if (n === 1) { l.fill(clamp(Math.round(pts[0][1]))); return l; }
  const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
  const dx: number[] = [], m: number[] = [];
  for (let i = 0; i < n - 1; i++) { dx[i] = xs[i + 1] - xs[i] || 1e-6; m[i] = (ys[i + 1] - ys[i]) / dx[i]; }
  const t: number[] = new Array(n);
  t[0] = m[0]; t[n - 1] = m[n - 2];
  for (let i = 1; i < n - 1; i++) t[i] = m[i - 1] * m[i] <= 0 ? 0 : (m[i - 1] + m[i]) / 2;
  for (let i = 0; i < n - 1; i++) {
    if (m[i] === 0) { t[i] = 0; t[i + 1] = 0; continue; }
    const a = t[i] / m[i], b = t[i + 1] / m[i], s = a * a + b * b;
    if (s > 9) { const k = 3 / Math.sqrt(s); t[i] = k * a * m[i]; t[i + 1] = k * b * m[i]; }
  }
  let seg = 0;
  for (let x = 0; x < 256; x++) {
    let y: number;
    if (x <= xs[0]) y = ys[0];
    else if (x >= xs[n - 1]) y = ys[n - 1];
    else {
      while (seg < n - 2 && x > xs[seg + 1]) seg++;
      const h = dx[seg], u = (x - xs[seg]) / h, u2 = u * u, u3 = u2 * u;
      y = (2 * u3 - 3 * u2 + 1) * ys[seg] + (u3 - 2 * u2 + u) * h * t[seg] + (-2 * u3 + 3 * u2) * ys[seg + 1] + (u3 - u2) * h * t[seg + 1];
    }
    l[x] = clamp(Math.round(y));
  }
  return l;
}

// ------------------------------------------------------------------ 3D LUTs (tetrahedral interpolation)
export const LUT_N = 33;
/** Bake f (0..1 in → 0..1 out) into an N³ RGB table (red fastest, like .cube files). Values 0..255. */
export function bakeLut3(f: (r: number, g: number, b: number, out: Float32Array) => void, N = LUT_N): Float32Array {
  const lut = new Float32Array(N * N * N * 3), o = new Float32Array(3), s = 1 / (N - 1);
  let i = 0;
  for (let b = 0; b < N; b++) for (let g = 0; g < N; g++) for (let r = 0; r < N; r++) {
    f(r * s, g * s, b * s, o);
    lut[i++] = clamp(o[0] * 255); lut[i++] = clamp(o[1] * 255); lut[i++] = clamp(o[2] * 255);
  }
  return lut;
}
export function lut3Kernel(lut: Float32Array, N = LUT_N, amount = 1): Kernel {
  const s = (N - 1) / 255, idx = new Int32Array(256), frac = new Float32Array(256);
  for (let v = 0; v < 256; v++) { const t = v * s; let i = Math.floor(t); if (i >= N - 1) i = N - 2; idx[v] = i; frac[v] = t - i; }
  const sR = 3, sG = N * 3, sB = N * N * 3;
  return img => {
    const d = img.data;
    for (let p = 0; p < d.length; p += 4) {
      if (d[p + 3] === 0) continue;
      const r = d[p], g = d[p + 1], b = d[p + 2];
      const fr = frac[r], fg = frac[g], fb = frac[b];
      const c0 = idx[b] * sB + idx[g] * sG + idx[r] * sR, c3 = c0 + sR + sG + sB;
      let c1: number, c2: number, w0: number, w1: number, w2: number, w3: number;
      if (fr > fg) {
        if (fg > fb) { c1 = c0 + sR; c2 = c0 + sR + sG; w0 = 1 - fr; w1 = fr - fg; w2 = fg - fb; w3 = fb; }
        else if (fr > fb) { c1 = c0 + sR; c2 = c0 + sR + sB; w0 = 1 - fr; w1 = fr - fb; w2 = fb - fg; w3 = fg; }
        else { c1 = c0 + sB; c2 = c0 + sR + sB; w0 = 1 - fb; w1 = fb - fr; w2 = fr - fg; w3 = fg; }
      } else if (fb > fg) { c1 = c0 + sB; c2 = c0 + sG + sB; w0 = 1 - fb; w1 = fb - fg; w2 = fg - fr; w3 = fr; }
      else if (fb > fr) { c1 = c0 + sG; c2 = c0 + sG + sB; w0 = 1 - fg; w1 = fg - fb; w2 = fb - fr; w3 = fr; }
      else { c1 = c0 + sG; c2 = c0 + sR + sG; w0 = 1 - fg; w1 = fg - fr; w2 = fr - fb; w3 = fb; }
      const nr = w0 * lut[c0] + w1 * lut[c1] + w2 * lut[c2] + w3 * lut[c3];
      const ng = w0 * lut[c0 + 1] + w1 * lut[c1 + 1] + w2 * lut[c2 + 1] + w3 * lut[c3 + 1];
      const nb = w0 * lut[c0 + 2] + w1 * lut[c1 + 2] + w2 * lut[c2 + 2] + w3 * lut[c3 + 2];
      if (amount >= 1) { d[p] = nr; d[p + 1] = ng; d[p + 2] = nb; }
      else { d[p] = r + (nr - r) * amount; d[p + 1] = g + (ng - g) * amount; d[p + 2] = b + (nb - b) * amount; }
    }
  };
}

// ------------------------------------------------------------------ histograms & auto corrections
export interface Hist { r: Uint32Array; g: Uint32Array; b: Uint32Array; l: Uint32Array; n: number }
export function histogram(img: ImageData): Hist {
  const r = new Uint32Array(256), g = new Uint32Array(256), b = new Uint32Array(256), l = new Uint32Array(256);
  const d = img.data;
  let n = 0;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] < 8) continue;
    const R = d[i], G = d[i + 1], B = d[i + 2];
    r[R]++; g[G]++; b[B]++; l[(R * 77 + G * 151 + B * 28) >> 8]++;
    n++;
  }
  return { r, g, b, l, n };
}
/** Values at `lo`/`hi` clipping fractions of a histogram. */
export function clipPoints(h: Uint32Array | Float64Array, lo = 0.001, hi = 0.001): [number, number] {
  let total = 0;
  for (let i = 0; i < 256; i++) total += h[i];
  if (!total) return [0, 255];
  let acc = 0, a = 0, b = 255;
  for (let i = 0; i < 256; i++) { acc += h[i]; if (acc > total * lo) { a = i; break; } }
  acc = 0;
  for (let i = 255; i >= 0; i--) { acc += h[i]; if (acc > total * hi) { b = i; break; } }
  if (b <= a) { a = Math.max(0, a - 1); b = Math.min(255, a + 2); }
  return [a, b];
}

export interface LevelsParams { rgb: LevelsCh; r: LevelsCh; g: LevelsCh; b: LevelsCh; _channel?: string; _preset?: string }
export const levelsParamsDefault = (): LevelsParams => ({ rgb: levelsDefault(), r: levelsDefault(), g: levelsDefault(), b: levelsDefault() });

/** Auto Tone ("Enhance Per Channel Contrast"): stretch each channel with 0.1% clipping. */
export function autoTone(img: ImageData, clip = 0.001): LevelsParams {
  const h = histogram(img), p = levelsParamsDefault();
  for (const c of ['r', 'g', 'b'] as const) { const [lo, hi] = clipPoints(h[c], clip, clip); p[c].inBlack = lo; p[c].inWhite = hi; }
  return p;
}
/** Auto Contrast ("Enhance Monochromatic Contrast"): one stretch for all channels (keeps colour relationships). */
export function autoContrast(img: ImageData, clip = 0.001): LevelsParams {
  const h = histogram(img), all = new Float64Array(256);
  for (let i = 0; i < 256; i++) all[i] = h.r[i] + h.g[i] + h.b[i];
  const [lo, hi] = clipPoints(all, clip, clip), p = levelsParamsDefault();
  p.rgb.inBlack = lo; p.rgb.inWhite = hi;
  return p;
}
/** Auto Color: find dark & light colors (average of the darkest / lightest 0.1%) + snap neutral midtones. */
export function autoColor(img: ImageData, clip = 0.001): LevelsParams {
  const h = histogram(img), p = levelsParamsDefault();
  if (!h.n) return p;
  const [lo, hi] = clipPoints(h.l, clip, clip);
  const d = img.data;
  const dark = [0, 0, 0, 0], light = [0, 0, 0, 0];
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] < 8) continue;
    const L = (d[i] * 77 + d[i + 1] * 151 + d[i + 2] * 28) >> 8;
    if (L <= lo) { dark[0] += d[i]; dark[1] += d[i + 1]; dark[2] += d[i + 2]; dark[3]++; }
    if (L >= hi) { light[0] += d[i]; light[1] += d[i + 1]; light[2] += d[i + 2]; light[3]++; }
  }
  const chans = ['r', 'g', 'b'] as const;
  chans.forEach((c, k) => {
    const [clo, chi] = clipPoints(h[c], clip, clip);
    // use the dark/light colours but never clip more than the channel's own clip points
    const dk = dark[3] ? dark[k] / dark[3] : clo, lt = light[3] ? light[k] / light[3] : chi;
    p[c].inBlack = Math.round(Math.max(0, Math.min(dk, clo + 40, 250)));
    p[c].inWhite = Math.round(Math.min(255, Math.max(lt, chi - 40, p[c].inBlack + 4)));
  });
  // snap neutral midtones: average of near-neutral midtone pixels after the stretch → per-channel gamma
  const L = chans.map(c => levelsLUT(p[c]));
  let sr = 0, sg = 0, sb = 0, sn = 0;
  for (let i = 0; i < d.length; i += 16) {
    if (d[i + 3] < 8) continue;
    const r = L[0][d[i]], g = L[1][d[i + 1]], b = L[2][d[i + 2]];
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), lu = (r + g + b) / 3;
    if (mx - mn < 40 && lu > 50 && lu < 205) { sr += r; sg += g; sb += b; sn++; }
  }
  if (sn > 20) {
    const m = [sr / sn, sg / sn, sb / sn], target = (m[0] + m[1] + m[2]) / 3 / 255;
    chans.forEach((c, k) => {
      const x = m[k] / 255;
      if (x > 0.02 && x < 0.98 && target > 0.02 && target < 0.98) p[c].gamma = +clamp(Math.log(x) / Math.log(target), 0.5, 2).toFixed(2);
    });
  }
  return p;
}
/** Levels params → kernel (per-channel, then master). */
export function levelsKernel(p: LevelsParams): Kernel {
  const m = levelsLUT(p.rgb);
  return lutKernel(composeLUT(levelsLUT(p.r), m), composeLUT(levelsLUT(p.g), m), composeLUT(levelsLUT(p.b), m));
}

// ------------------------------------------------------------------ source image (what the adjustment reads)
/** Run fn with `layer` and everything stacked above it hidden (ancestors stay visible). */
export function withLayersAboveHidden<T>(doc: PixDocument, layer: Layer, fn: () => T): T {
  const all = doc.allLayers(), i = all.indexOf(layer);
  const ancestors = new Set<Layer>();
  for (let p = layer._parent; p; p = p._parent) ancestors.add(p);
  const hidden: Layer[] = [];
  for (let k = i; k < all.length; k++) {
    const l = all[k];
    if (ancestors.has(l) || !l.visible) continue;
    l.visible = false; hidden.push(l);
  }
  try { return fn(); } finally { for (const l of hidden) l.visible = true; }
}
export function compositeBelow(doc: PixDocument, layer: Layer): HTMLCanvasElement {
  return withLayersAboveHidden(doc, layer, () => renderLayersToCanvas(doc, doc.layers));
}

/** Environment passed to adjustment UIs: access to the image being adjusted (histograms, eyedroppers, Auto). */
export class Env {
  readonly layer: AdjustmentLayer | null;
  private src: { canvas: HTMLCanvasElement; x: number; y: number; isMask: boolean } | null = null;
  private small: ImageData | null = null;
  private listeners = new Set<() => void>();
  /** Re-render the whole adjustment UI (set by mountAdjustmentUI; used after Auto / presets / eyedroppers). */
  rebuild: () => void = () => {};
  constructor(readonly doc: PixDocument | null, layer?: AdjustmentLayer | null) {
    this.layer = layer !== undefined ? layer : doc?.activeLayer instanceof AdjustmentLayer ? doc.activeLayer : null;
  }
  get mode(): 'layer' | 'dialog' { return this.layer ? 'layer' : 'dialog'; }
  /** Full-resolution source (doc-positioned). */
  source() {
    if (this.src) return this.src;
    const doc = this.doc;
    if (!doc) return null;
    if (this.layer) this.src = { canvas: compositeBelow(doc, this.layer), x: 0, y: 0, isMask: false };
    else {
      const t = doc.getPaintTarget();
      if (t) this.src = { canvas: t.holder.canvas, x: t.holder.x, y: t.holder.y, isMask: t.isMask };
      else this.src = { canvas: doc.getComposite(), x: 0, y: 0, isMask: false };
    }
    return this.src;
  }
  /** Downsampled pixels (≤ ~300k) of the source, restricted to the selection bounds in dialog mode. */
  stats(): ImageData | null {
    if (this.small) return this.small;
    const s = this.source();
    if (!s || !this.doc) return null;
    let r = { x: 0, y: 0, w: s.canvas.width, h: s.canvas.height };
    const sb = !this.layer && !this.doc.quickMask ? this.doc.selection.bounds : null;
    if (sb) {
      const x0 = Math.max(0, sb.x - s.x), y0 = Math.max(0, sb.y - s.y);
      const x1 = Math.min(s.canvas.width, sb.x + sb.w - s.x), y1 = Math.min(s.canvas.height, sb.y + sb.h - s.y);
      if (x1 > x0 && y1 > y0) r = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
    }
    const k = Math.min(1, Math.sqrt(300000 / (r.w * r.h)));
    const w = Math.max(1, Math.round(r.w * k)), h = Math.max(1, Math.round(r.h * k));
    const c = createCanvas(w, h), x = ctx2d(c);
    x.imageSmoothingEnabled = false;
    x.drawImage(s.canvas, r.x, r.y, r.w, r.h, 0, 0, w, h);
    const img = x.getImageData(0, 0, w, h);
    if (s.isMask) { const d = img.data; for (let i = 0; i < d.length; i += 4) { d[i] = d[i + 1] = d[i + 2] = d[i + 3]; d[i + 3] = 255; } }
    return (this.small = img);
  }
  /** Colour of the source at doc coords (3×3 average like PS "3 by 3 Average"), or null outside. */
  sample(x: number, y: number): RGB | null {
    const s = this.source();
    if (!s) return null;
    const px = Math.floor(x - s.x), py = Math.floor(y - s.y);
    if (px < 0 || py < 0 || px >= s.canvas.width || py >= s.canvas.height) return null;
    const x0 = Math.max(0, px - 1), y0 = Math.max(0, py - 1), x1 = Math.min(s.canvas.width, px + 2), y1 = Math.min(s.canvas.height, py + 2);
    const d = ctx2d(s.canvas).getImageData(x0, y0, x1 - x0, y1 - y0).data;
    let r = 0, g = 0, b = 0, n = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (s.isMask) { r += d[i + 3]; g += d[i + 3]; b += d[i + 3]; n++; continue; }
      if (d[i + 3] < 8) continue;
      r += d[i]; g += d[i + 1]; b += d[i + 2]; n++;
    }
    return n ? { r: Math.round(r / n), g: Math.round(g / n), b: Math.round(b / n) } : null;
  }
  /** Drop cached pixels (image under the adjustment changed) and notify listeners (histograms). */
  invalidate() { this.src = null; this.small = null; for (const f of this.listeners) f(); }
  onInvalidate(f: () => void) { this.listeners.add(f); return () => this.listeners.delete(f); }
}

/** Hide-test helper for groups (used by presets / panel). */
export const isGroup = (l: Layer | null | undefined): l is GroupLayer => l instanceof GroupLayer;
