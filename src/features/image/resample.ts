// High-quality image resampling (Image Size, Properties W/H, Bitmap output resolution...).
// Separable convolution on premultiplied Float32 data with a pre-filter scaled to the reduction factor
// (no aliasing), preceded by exact 2×2 box halving for big reductions (multi-step downscale).
import { createCanvas, ctx2d } from '../../core/canvas';

export type ResampleMethod =
  | 'automatic' | 'preserve2' | 'preserve' | 'bicubicSmoother' | 'bicubicSharper' | 'bicubic' | 'nearest' | 'bilinear' | 'lanczos';

export const RESAMPLE_LABELS: [ResampleMethod, string][] = [
  ['automatic', 'Automatic'],
  ['preserve2', 'Preserve Details 2.0'],
  ['preserve', 'Preserve Details (enlargement)'],
  ['bicubicSmoother', 'Bicubic Smoother (enlargement)'],
  ['bicubicSharper', 'Bicubic Sharper (reduction)'],
  ['bicubic', 'Bicubic (smooth gradients)'],
  ['nearest', 'Nearest Neighbor (hard edges)'],
  ['bilinear', 'Bilinear'],
];

type Kernel = { f: (x: number) => number; support: number };
const keys = (a: number): Kernel => ({
  support: 2,
  f: x => {
    x = Math.abs(x);
    if (x < 1) return ((a + 2) * x - (a + 3)) * x * x + 1;
    if (x < 2) return ((a * x - 5 * a) * x + 8 * a) * x - 4 * a;
    return 0;
  },
});
const mitchell = (B: number, C: number): Kernel => ({
  support: 2,
  f: x => {
    x = Math.abs(x);
    if (x < 1) return ((12 - 9 * B - 6 * C) * x * x * x + (-18 + 12 * B + 6 * C) * x * x + (6 - 2 * B)) / 6;
    if (x < 2) return ((-B - 6 * C) * x * x * x + (6 * B + 30 * C) * x * x + (-12 * B - 48 * C) * x + (8 * B + 24 * C)) / 6;
    return 0;
  },
});
const sinc = (x: number) => (x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x));
const LANCZOS3: Kernel = { support: 3, f: x => (Math.abs(x) < 3 ? sinc(x) * sinc(x / 3) : 0) };
const TRIANGLE: Kernel = { support: 1, f: x => Math.max(0, 1 - Math.abs(x)) };

/** Resolve 'automatic' like Photoshop: Bicubic Smoother for enlargement, Bicubic Sharper for reduction. */
export function resolveMethod(m: ResampleMethod, enlarge: boolean): ResampleMethod {
  return m === 'automatic' ? (enlarge ? 'bicubicSmoother' : 'bicubicSharper') : m;
}
function kernelOf(m: ResampleMethod): Kernel {
  switch (m) {
    case 'bilinear': return TRIANGLE;
    case 'bicubicSmoother': return mitchell(1 / 3, 1 / 3);
    case 'bicubicSharper': return keys(-0.75);
    case 'preserve': case 'preserve2': case 'lanczos': return LANCZOS3;
    default: return keys(-0.5);
  }
}

/** Per-output-pixel tap indices + normalised weights for one axis. */
function contributions(srcN: number, dstN: number, k: Kernel) {
  const scale = dstN / srcN, fs = Math.min(1, scale), sup = k.support / fs;
  const taps = Math.ceil(sup) * 2 + 1;
  const idx = new Int32Array(dstN * taps), w = new Float32Array(dstN * taps);
  for (let i = 0; i < dstN; i++) {
    const c = (i + 0.5) / scale - 0.5;
    const j0 = Math.ceil(c - sup);
    let sum = 0;
    for (let t = 0; t < taps; t++) {
      const j = j0 + t, v = k.f((j - c) * fs);
      idx[i * taps + t] = j < 0 ? 0 : j >= srcN ? srcN - 1 : j;
      w[i * taps + t] = v; sum += v;
    }
    if (sum) for (let t = 0; t < taps; t++) w[i * taps + t] /= sum;
  }
  return { idx, w, taps };
}

/** RGBA8 → premultiplied float. */
function toPremul(d: Uint8ClampedArray): Float32Array {
  const f = new Float32Array(d.length);
  for (let i = 0; i < d.length; i += 4) {
    const a = d[i + 3] / 255;
    f[i] = d[i] * a; f[i + 1] = d[i + 1] * a; f[i + 2] = d[i + 2] * a; f[i + 3] = d[i + 3];
  }
  return f;
}

/** Exact 2:1 box reduction on premultiplied float data (only the flagged axes). */
function halve(src: Float32Array, w: number, h: number, fx: boolean, fy: boolean) {
  const nw = fx ? Math.max(1, w >> 1) : w, nh = fy ? Math.max(1, h >> 1) : h;
  const out = new Float32Array(nw * nh * 4);
  const k = (fx ? 0.5 : 1) * (fy ? 0.5 : 1);
  for (let y = 0; y < nh; y++) {
    const y0 = fy ? y * 2 : y, y1 = fy ? Math.min(h - 1, y * 2 + 1) : y;
    for (let x = 0; x < nw; x++) {
      const x0 = fx ? x * 2 : x, x1 = fx ? Math.min(w - 1, x * 2 + 1) : x;
      const a = (y0 * w + x0) * 4, b = (y0 * w + x1) * 4, c = (y1 * w + x0) * 4, e = (y1 * w + x1) * 4, o = (y * nw + x) * 4;
      for (let ch = 0; ch < 4; ch++) {
        out[o + ch] = fx && fy ? (src[a + ch] + src[b + ch] + src[c + ch] + src[e + ch]) * k
          : fx ? (src[a + ch] + src[b + ch]) * k : (src[a + ch] + src[c + ch]) * k;
      }
    }
  }
  return { data: out, w: nw, h: nh };
}

/** 3×3 [1 2 1] blur of an RGBA8 buffer (used for Reduce Noise / detail enhancement). */
function blur121(d: Uint8ClampedArray, w: number, h: number): Float32Array {
  const t = new Float32Array(d.length), o = new Float32Array(d.length);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const l = (y * w + Math.max(0, x - 1)) * 4, c = (y * w + x) * 4, r = (y * w + Math.min(w - 1, x + 1)) * 4;
    for (let ch = 0; ch < 4; ch++) t[c + ch] = (d[l + ch] + 2 * d[c + ch] + d[r + ch]) / 4;
  }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const u = (Math.max(0, y - 1) * w + x) * 4, c = (y * w + x) * 4, dn = (Math.min(h - 1, y + 1) * w + x) * 4;
    for (let ch = 0; ch < 4; ch++) o[c + ch] = (t[u + ch] + 2 * t[c + ch] + t[dn + ch]) / 4;
  }
  return o;
}

/** Resample RGBA8 pixels (w×h) to dw×dh. */
export function resamplePixels(src: Uint8ClampedArray, w: number, h: number, dw: number, dh: number, method: ResampleMethod = 'bicubic', opts: { noise?: number } = {}): Uint8ClampedArray {
  dw = Math.max(1, Math.round(dw)); dh = Math.max(1, Math.round(dh));
  const m = resolveMethod(method, dw * dh > w * h);
  if (m === 'nearest') {
    const s32 = new Uint32Array(src.buffer, src.byteOffset, w * h), out = new Uint8ClampedArray(dw * dh * 4), o32 = new Uint32Array(out.buffer);
    const xs = new Int32Array(dw);
    for (let x = 0; x < dw; x++) xs[x] = Math.min(w - 1, Math.floor(((x + 0.5) * w) / dw));
    for (let y = 0; y < dh; y++) {
      const sy = Math.min(h - 1, Math.floor(((y + 0.5) * h) / dh)) * w, oy = y * dw;
      for (let x = 0; x < dw; x++) o32[oy + x] = s32[sy + xs[x]];
    }
    return out;
  }
  let cur = toPremul(src), cw = w, chh = h;
  // multi-step: exact box halving while the reduction is at least 2×
  while (dw * 2 <= cw || dh * 2 <= chh) {
    const r = halve(cur, cw, chh, dw * 2 <= cw, dh * 2 <= chh);
    cur = r.data; cw = r.w; chh = r.h;
  }
  const k = kernelOf(m);
  // horizontal pass → tmp (chh × dw)
  let tmp: Float32Array;
  if (cw === dw) tmp = cur;
  else {
    const { idx, w: wt, taps } = contributions(cw, dw, k);
    tmp = new Float32Array(dw * chh * 4);
    for (let y = 0; y < chh; y++) {
      const row = y * cw, orow = y * dw * 4;
      for (let x = 0; x < dw; x++) {
        let r = 0, g = 0, b = 0, a = 0;
        const base = x * taps;
        for (let t = 0; t < taps; t++) {
          const wv = wt[base + t];
          if (!wv) continue;
          const p = (row + idx[base + t]) * 4;
          r += cur[p] * wv; g += cur[p + 1] * wv; b += cur[p + 2] * wv; a += cur[p + 3] * wv;
        }
        const o = orow + x * 4;
        tmp[o] = r; tmp[o + 1] = g; tmp[o + 2] = b; tmp[o + 3] = a;
      }
    }
  }
  // vertical pass → out (dh × dw), un-premultiply
  const out = new Uint8ClampedArray(dw * dh * 4);
  const write = (o: number, r: number, g: number, b: number, a: number) => {
    if (a <= 0.5) { out[o] = out[o + 1] = out[o + 2] = out[o + 3] = 0; return; }
    const ia = 255 / a;
    out[o] = r * ia; out[o + 1] = g * ia; out[o + 2] = b * ia; out[o + 3] = a;
  };
  if (chh === dh) {
    for (let i = 0; i < dw * dh * 4; i += 4) write(i, tmp[i], tmp[i + 1], tmp[i + 2], tmp[i + 3]);
  } else {
    const { idx, w: wt, taps } = contributions(chh, dh, k);
    const acc = new Float32Array(dw * 4);
    for (let y = 0; y < dh; y++) {
      acc.fill(0);
      const base = y * taps;
      for (let t = 0; t < taps; t++) {
        const wv = wt[base + t];
        if (!wv) continue;
        const row = idx[base + t] * dw * 4;
        for (let i = 0; i < dw * 4; i++) acc[i] += tmp[row + i] * wv;
      }
      const orow = y * dw * 4;
      for (let i = 0; i < dw * 4; i += 4) write(orow + i, acc[i], acc[i + 1], acc[i + 2], acc[i + 3]);
    }
  }
  // Preserve Details: Reduce Noise (blend toward a smoothed copy) / 2.0: gentle detail enhancement
  const noise = m === 'preserve' || m === 'preserve2' ? (opts.noise ?? 0) / 100 : 0;
  const detail = m === 'preserve2' && dw * dh > w * h ? 0.35 : 0;
  if (noise > 0 || detail > 0) {
    const bl = blur121(out, dw, dh), k2 = noise * 0.9 - detail;
    for (let i = 0; i < out.length; i++) out[i] = out[i] + (bl[i] - out[i]) * k2;
  }
  return out;
}

/** Resample a canvas to w×h (returns a new canvas). Exported for other modules. */
export function resampleCanvas(src: HTMLCanvasElement, w: number, h: number, method: ResampleMethod = 'bicubic', opts: { noise?: number } = {}): HTMLCanvasElement {
  w = Math.max(1, Math.round(w)); h = Math.max(1, Math.round(h));
  const out = createCanvas(w, h);
  if (w === src.width && h === src.height) { ctx2d(out).drawImage(src, 0, 0); return out; }
  const img = ctx2d(src).getImageData(0, 0, src.width, src.height);
  const px = resamplePixels(img.data, src.width, src.height, w, h, method, opts);
  ctx2d(out).putImageData(new ImageData(px as any, w, h), 0, 0);
  return out;
}

// ponytail: self-check (run in the console: __imageResampleCheck()) — flat colour must stay flat, sizes exact.
(window as any).__imageResampleCheck = () => {
  const src = new Uint8ClampedArray(7 * 5 * 4);
  for (let i = 0; i < src.length; i += 4) { src[i] = 200; src[i + 1] = 100; src[i + 2] = 50; src[i + 3] = 255; }
  for (const m of RESAMPLE_LABELS.map(x => x[0])) for (const [dw, dh] of [[3, 2], [20, 13], [1, 1], [7, 11]]) {
    const o = resamplePixels(src, 7, 5, dw, dh, m);
    console.assert(o.length === dw * dh * 4, 'size', m);
    for (let i = 0; i < o.length; i += 4) console.assert(Math.abs(o[i] - 200) <= 1 && Math.abs(o[i + 1] - 100) <= 1 && o[i + 3] === 255, 'flat', m, dw, dh, o[i], o[i + 1], o[i + 3]);
  }
  return 'ok';
};
