// Shared pixel utilities for filter kernels. Pure functions on ImageData / typed arrays so they run both in the
// filters worker and on the main thread (smart filters). No DOM access here (OffscreenCanvas only).
export interface KRect { x: number; y: number; w: number; h: number }
export interface Meta {
  /** Document position of the image's (0,0). */
  x: number; y: number;
  docW: number; docH: number;
  /** Selection bounds in image coordinates (null = whole image). */
  sel: KRect | null;
  isMask: boolean;
  preview: boolean;
  fg: [number, number, number]; bg: [number, number, number];
  seed: number;
  aux?: any;
}
export type Kernel = (img: ImageData, p: any, m: Meta) => ImageData;

export const clamp = (v: number, a = 0, b = 255) => (v < a ? a : v > b ? b : v);
export const newImage = (w: number, h: number) => new ImageData(Math.max(1, w), Math.max(1, h));
export function cloneImage(img: ImageData): ImageData { return new ImageData(new Uint8ClampedArray(img.data), img.width, img.height); }

/** Area the filter works on: selection bounds (clipped) or the whole image. */
export function workRect(img: ImageData, m: Meta, pad = 0): KRect {
  const s = m.sel;
  if (!s) return { x: 0, y: 0, w: img.width, h: img.height };
  const x0 = Math.max(0, Math.floor(s.x) - pad), y0 = Math.max(0, Math.floor(s.y) - pad);
  const x1 = Math.min(img.width, Math.ceil(s.x + s.w) + pad), y1 = Math.min(img.height, Math.ceil(s.y + s.h) + pad);
  return { x: x0, y: y0, w: Math.max(1, x1 - x0), h: Math.max(1, y1 - y0) };
}
export function crop(img: ImageData, r: KRect): ImageData {
  if (r.x === 0 && r.y === 0 && r.w === img.width && r.h === img.height) return img;
  const out = newImage(r.w, r.h), s = img.data, d = out.data;
  for (let y = 0; y < r.h; y++) d.set(s.subarray(((r.y + y) * img.width + r.x) * 4, ((r.y + y) * img.width + r.x + r.w) * 4), y * r.w * 4);
  return out;
}
export function paste(dst: ImageData, src: ImageData, x: number, y: number) {
  if (src === dst) return;
  const d = dst.data, s = src.data;
  for (let j = 0; j < src.height; j++) {
    const dy = y + j;
    if (dy < 0 || dy >= dst.height) continue;
    const x0 = Math.max(0, x), x1 = Math.min(dst.width, x + src.width);
    if (x1 <= x0) continue;
    d.set(s.subarray((j * src.width + (x0 - x)) * 4, (j * src.width + (x1 - x)) * 4), (dy * dst.width + x0) * 4);
  }
}
/** Run fn on the selection area (plus pad pixels of context) only, then paste the result back. */
export function onRegion(img: ImageData, m: Meta, pad: number, fn: (sub: ImageData, r: KRect) => ImageData): ImageData {
  const r = workRect(img, m, pad);
  const sub = crop(img, r);
  const res = fn(sub, r);
  if (res === img) return img;
  paste(img, res, r.x, r.y);
  return img;
}

// ------------------------------------------------------------------ premultiplied float planes
export interface Planes { w: number; h: number; c: Float32Array[] }   // premultiplied R,G,B + A (0..255)
export function toPlanes(img: ImageData): Planes {
  const n = img.width * img.height, d = img.data;
  const r = new Float32Array(n), g = new Float32Array(n), b = new Float32Array(n), a = new Float32Array(n);
  for (let i = 0, j = 0; i < n; i++, j += 4) { const al = d[j + 3], k = al / 255; r[i] = d[j] * k; g[i] = d[j + 1] * k; b[i] = d[j + 2] * k; a[i] = al; }
  return { w: img.width, h: img.height, c: [r, g, b, a] };
}
export function fromPlanes(p: Planes, out?: ImageData): ImageData {
  const img = out || newImage(p.w, p.h), d = img.data, [r, g, b, a] = p.c, n = p.w * p.h;
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    const al = a[i];
    if (al <= 0.001) { d[j] = d[j + 1] = d[j + 2] = d[j + 3] = 0; continue; }
    const k = 255 / al;
    d[j] = r[i] * k; d[j + 1] = g[i] * k; d[j + 2] = b[i] * k; d[j + 3] = al;
  }
  return img;
}
export const opaque = (img: ImageData) => { const d = img.data; for (let i = 3; i < d.length; i += 4) if (d[i] !== 255) return false; return true; };

// ------------------------------------------------------------------ blurs on planes
/** 1-D box blur (running sum, clamped edges) of radius r (may be fractional) along rows or columns. */
function boxLine(src: Float32Array, dst: Float32Array, n: number, stride: number, off: number, r: number) {
  const ri = Math.floor(r), fr = r - ri, norm = 1 / (2 * r + 1), last = off + (n - 1) * stride;
  const first = src[off], lastV = src[last];
  const at = (i: number) => (i < 0 ? first : i >= n ? lastV : src[off + i * stride]);
  let sum = 0;
  for (let i = -ri; i <= ri; i++) sum += at(i);
  const lo = ri + 1, hi = n - ri - 2;
  for (let i = 0; i < n; i++) {
    let add: number, sub: number, edge = 0;
    if (i >= lo && i <= hi) {
      add = src[off + (i + ri + 1) * stride]; sub = src[off + (i - ri) * stride];
      if (fr > 0) edge = (src[off + (i - ri - 1) * stride] + add) * fr;
    } else {
      add = at(i + ri + 1); sub = at(i - ri);
      if (fr > 0) edge = (at(i - ri - 1) + add) * fr;
    }
    dst[off + i * stride] = (sum + edge) * norm;
    sum += add - sub;
  }
}
export function boxBlurPlane(p: Float32Array, w: number, h: number, rx: number, ry = rx, tmp?: Float32Array): void {
  const t = tmp || new Float32Array(p.length);
  if (rx > 0) { for (let y = 0; y < h; y++) boxLine(p, t, w, 1, y * w, rx); p.set(t); }
  if (ry > 0) { boxCols(p, t, w, h, ry); p.set(t); }
}
/** Vertical box blur with per-column running sums (row-major, cache friendly). */
function boxCols(src: Float32Array, dst: Float32Array, w: number, h: number, r: number) {
  const ri = Math.floor(r), fr = r - ri, norm = 1 / (2 * r + 1), sums = new Float64Array(w);
  const row = (y: number) => (y < 0 ? 0 : y >= h ? h - 1 : y) * w;
  for (let i = -ri; i <= ri; i++) { const o = row(i); for (let x = 0; x < w; x++) sums[x] += src[o + x]; }
  for (let y = 0; y < h; y++) {
    const oa = row(y + ri + 1), os = row(y - ri), od = y * w;
    if (fr > 0) { const ol = row(y - ri - 1); for (let x = 0; x < w; x++) { dst[od + x] = (sums[x] + (src[ol + x] + src[oa + x]) * fr) * norm; sums[x] += src[oa + x] - src[os + x]; } }
    else for (let x = 0; x < w; x++) { dst[od + x] = sums[x] * norm; sums[x] += src[oa + x] - src[os + x]; }
  }
}
/** Gaussian approximation by 3 box passes (sigma from Photoshop radius ≈ sigma). */
export function gaussPlane(p: Float32Array, w: number, h: number, sigma: number, sigmaY = sigma) {
  if (sigma <= 0 && sigmaY <= 0) return;
  const radius = (s: number) => (s <= 0 ? 0 : (Math.sqrt((12 * s * s) / 3 + 1) - 1) / 2);
  const rx = radius(sigma), ry = radius(sigmaY), tmp = new Float32Array(p.length);
  for (let k = 0; k < 3; k++) boxBlurPlane(p, w, h, rx, ry, tmp);
}
export function gaussPlanes(P: Planes, sigma: number, sigmaY = sigma) { for (const c of P.c) gaussPlane(c, P.w, P.h, sigma, sigmaY); }
/** Gaussian blur of an image (premultiplied, alpha correct). */
export function gaussian(img: ImageData, sigma: number, sigmaY = sigma): ImageData {
  if (sigma <= 0 && sigmaY <= 0) return img;
  const P = toPlanes(img);
  gaussPlanes(P, sigma, sigmaY);
  return fromPlanes(P, img);
}
export function lumaPlane(img: ImageData): Float32Array {
  const n = img.width * img.height, d = img.data, out = new Float32Array(n);
  for (let i = 0, j = 0; i < n; i++, j += 4) out[i] = d[j] * 0.299 + d[j + 1] * 0.587 + d[j + 2] * 0.114;
  return out;
}

// ------------------------------------------------------------------ sampling
export type EdgeMode = 'clamp' | 'wrap' | 'transparent' | 'bg';
/** Bilinear sample into out[0..3] (straight RGBA). */
export function sample(img: ImageData, x: number, y: number, out: Float32Array | number[], edge: EdgeMode = 'clamp', bg?: [number, number, number]) {
  const W = img.width, H = img.height, d = img.data;
  if (edge === 'transparent' || edge === 'bg') {
    if (x < -0.5 || y < -0.5 || x > W - 0.5 || y > H - 0.5) {
      if (edge === 'bg' && bg) { out[0] = bg[0]; out[1] = bg[1]; out[2] = bg[2]; out[3] = 255; } else out[0] = out[1] = out[2] = out[3] = 0;
      return;
    }
  }
  x -= 0.5; y -= 0.5;
  let x0 = Math.floor(x), y0 = Math.floor(y);
  const fx = x - x0, fy = y - y0;
  let x1 = x0 + 1, y1 = y0 + 1;
  if (edge === 'wrap') { x0 = ((x0 % W) + W) % W; x1 = ((x1 % W) + W) % W; y0 = ((y0 % H) + H) % H; y1 = ((y1 % H) + H) % H; }
  else { x0 = x0 < 0 ? 0 : x0 >= W ? W - 1 : x0; x1 = x1 < 0 ? 0 : x1 >= W ? W - 1 : x1; y0 = y0 < 0 ? 0 : y0 >= H ? H - 1 : y0; y1 = y1 < 0 ? 0 : y1 >= H ? H - 1 : y1; }
  const i00 = (y0 * W + x0) * 4, i10 = (y0 * W + x1) * 4, i01 = (y1 * W + x0) * 4, i11 = (y1 * W + x1) * 4;
  const w00 = (1 - fx) * (1 - fy) * d[i00 + 3], w10 = fx * (1 - fy) * d[i10 + 3], w01 = (1 - fx) * fy * d[i01 + 3], w11 = fx * fy * d[i11 + 3];
  const a = w00 + w10 + w01 + w11;
  if (a <= 0) { out[0] = out[1] = out[2] = out[3] = 0; return; }
  for (let c = 0; c < 3; c++) out[c] = (d[i00 + c] * w00 + d[i10 + c] * w10 + d[i01 + c] * w01 + d[i11 + c] * w11) / a;
  out[3] = a;
}
/** Inverse-mapped distortion: map(x, y) returns the source position for destination pixel centre (x, y) inside r. */
export function remap(img: ImageData, r: KRect, map: (x: number, y: number, o: number[]) => boolean | void, edge: EdgeMode = 'clamp', bg?: [number, number, number]): ImageData {
  const src = cloneImage(img), d = img.data, o = [0, 0], px = new Float32Array(4);
  for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) {
    if (map(x + 0.5, y + 0.5, o) === false) continue;
    sample(src, o[0], o[1], px, edge, bg);
    const i = (y * img.width + x) * 4;
    d[i] = px[0]; d[i + 1] = px[1]; d[i + 2] = px[2]; d[i + 3] = px[3];
  }
  return img;
}

// ------------------------------------------------------------------ random / noise
export function rng(seed: number) {
  let s = (seed >>> 0) || 0x9e3779b9;
  return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
}
export function gaussRand(r: () => number) { let u = 0, v = 0; while (u === 0) u = r(); v = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }
function hash2(x: number, y: number, seed: number) {
  let h = (x * 374761393 + y * 668265263 + seed * 2246822519) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
const fade = (t: number) => t * t * (3 - 2 * t);
/** Value noise in [0,1]. */
export function vnoise(x: number, y: number, seed: number) {
  const xi = Math.floor(x), yi = Math.floor(y), fx = fade(x - xi), fy = fade(y - yi);
  const a = hash2(xi, yi, seed), b = hash2(xi + 1, yi, seed), c = hash2(xi, yi + 1, seed), d = hash2(xi + 1, yi + 1, seed);
  return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
}
/** Fractal (fBm) value noise in [0,1]. */
export function fbm(x: number, y: number, seed: number, oct = 6, gain = 0.5) {
  let s = 0, amp = 0.5, f = 1, n = 0;
  for (let i = 0; i < oct; i++) { s += vnoise(x * f, y * f, seed + i * 131) * amp; n += amp; amp *= gain; f *= 2; }
  return s / n;
}

// ------------------------------------------------------------------ colour
export function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  r /= 255; g /= 255; b /= 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2;
  if (mx === mn) return [0, 0, l];
  const d = mx - mn, s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
  const h = mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h / 6, s, l];
}
export function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  if (s === 0) return [l * 255, l * 255, l * 255];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
  const f = (t: number) => { t = ((t % 1) + 1) % 1; return t < 1 / 6 ? p + (q - p) * 6 * t : t < 0.5 ? q : t < 2 / 3 ? p + (q - p) * (2 / 3 - t) * 6 : p; };
  return [f(h + 1 / 3) * 255, f(h) * 255, f(h - 1 / 3) * 255];
}
export function rgbToHsb(r: number, g: number, b: number): [number, number, number] {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  let h = 0;
  if (d) h = mx === r ? ((g - b) / d + (g < b ? 6 : 0)) / 6 : mx === g ? ((b - r) / d + 2) / 6 : ((r - g) / d + 4) / 6;
  return [h, mx ? d / mx : 0, mx / 255];
}
export function hsbToRgb(h: number, s: number, v: number): [number, number, number] {
  const i = Math.floor(h * 6), f = h * 6 - i, p = v * (1 - s), q = v * (1 - f * s), t = v * (1 - (1 - f) * s);
  const [r, g, b] = [[v, t, p], [q, v, p], [p, v, t], [p, q, v], [t, p, v], [v, p, q]][((i % 6) + 6) % 6];
  return [r * 255, g * 255, b * 255];
}

// ------------------------------------------------------------------ convolution / morphology
/** Generic square kernel convolution (per channel, alpha preserved) with clamped edges. */
export function convolve(img: ImageData, k: number[], size: number, scale = 1, offset = 0, alphaToo = false): ImageData {
  const W = img.width, H = img.height, s = img.data, out = new Uint8ClampedArray(s.length), hsz = size >> 1;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let r = 0, g = 0, b = 0, a = 0;
    for (let j = 0; j < size; j++) {
      const yy = Math.min(H - 1, Math.max(0, y + j - hsz));
      for (let i = 0; i < size; i++) {
        const w = k[j * size + i];
        if (!w) continue;
        const xx = Math.min(W - 1, Math.max(0, x + i - hsz)), q = (yy * W + xx) * 4;
        r += s[q] * w; g += s[q + 1] * w; b += s[q + 2] * w; a += s[q + 3] * w;
      }
    }
    const o = (y * W + x) * 4;
    out[o] = r / scale + offset; out[o + 1] = g / scale + offset; out[o + 2] = b / scale + offset;
    out[o + 3] = alphaToo ? a / scale + offset : s[o + 3];
  }
  img.data.set(out);
  return img;
}
/** Running max/min over a window of 2r+1 along a line (van Herk / Gil-Werman). */
function vhLine(src: Uint8Array | Float32Array, dst: Uint8Array | Float32Array, n: number, stride: number, off: number, r: number, max: boolean) {
  const w = 2 * r + 1, g = new Float32Array(n + w), hh = new Float32Array(n + w);
  const at = (i: number) => src[off + (i < 0 ? 0 : i >= n ? n - 1 : i) * stride];
  const op = max ? Math.max : Math.min;
  const L = n + 2 * r;
  for (let b = 0; b < L; b += w) {
    const e = Math.min(L, b + w);
    g[b] = at(b - r); for (let i = b + 1; i < e; i++) g[i] = op(g[i - 1], at(i - r));
    hh[e - 1] = at(e - 1 - r); for (let i = e - 2; i >= b; i--) hh[i] = op(hh[i + 1], at(i - r));
  }
  for (let i = 0; i < n; i++) dst[off + i * stride] = op(hh[i], g[i + 2 * r]);
}
export function morphPlane(p: Float32Array, w: number, h: number, rx: number, ry: number, max: boolean) {
  const t = new Float32Array(p.length);
  if (rx > 0) { for (let y = 0; y < h; y++) vhLine(p, t, w, 1, y * w, rx, max); p.set(t); }
  if (ry > 0) { for (let x = 0; x < w; x++) vhLine(p, t, h, w, x, ry, max); p.set(t); }
}
/** Round structuring element: max over rows of horizontally-maxed spans. */
export function morphRoundPlane(p: Float32Array, w: number, h: number, r: number, max: boolean) {
  const rows = new Map<number, Float32Array>();
  for (let dy = 0; dy <= r; dy++) {
    const half = Math.floor(Math.sqrt(Math.max(0, r * r - dy * dy)) + 0.001);
    if (!rows.has(half)) { const c = new Float32Array(p); morphPlane(c, w, h, half, 0, max); rows.set(half, c); }
  }
  const out = new Float32Array(p.length).fill(max ? -Infinity : Infinity);
  for (let dy = -r; dy <= r; dy++) {
    const half = Math.floor(Math.sqrt(Math.max(0, r * r - dy * dy)) + 0.001), src = rows.get(half)!;
    for (let y = 0; y < h; y++) {
      const sy = Math.min(h - 1, Math.max(0, y + dy)), o = y * w, so = sy * w;
      if (max) for (let x = 0; x < w; x++) { const v = src[so + x]; if (v > out[o + x]) out[o + x] = v; }
      else for (let x = 0; x < w; x++) { const v = src[so + x]; if (v < out[o + x]) out[o + x] = v; }
    }
  }
  p.set(out);
}
/** Per-channel sliding-histogram median (Huang). */
export function medianChannel(src: Uint8ClampedArray, W: number, H: number, ch: number, r: number, out: Uint8ClampedArray) {
  const hist = new Uint32Array(256), win = (2 * r + 1) * (2 * r + 1), half = win >> 1;
  const at = (x: number, y: number) => src[((y < 0 ? 0 : y >= H ? H - 1 : y) * W + (x < 0 ? 0 : x >= W ? W - 1 : x)) * 4 + ch];
  for (let y = 0; y < H; y++) {
    hist.fill(0);
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) hist[at(dx, y + dy)]++;
    let med = 0, cnt = 0;
    for (; med < 256; med++) { cnt += hist[med]; if (cnt > half) break; }
    let below = cnt - hist[med];          // number of values < med
    out[(y * W) * 4 + ch] = med;
    for (let x = 1; x < W; x++) {
      for (let dy = -r; dy <= r; dy++) {
        const o = at(x - r - 1, y + dy), n = at(x + r, y + dy);
        hist[o]--; if (o < med) below--;
        hist[n]++; if (n < med) below++;
      }
      if (below > half) { do { med--; below -= hist[med]; } while (below > half); }
      else { while (below + hist[med] <= half) { below += hist[med]; med++; } }
      out[(y * W + x) * 4 + ch] = med;
    }
  }
}

/** Blend two images: out = a*(1-t) + b*t with per-pixel t (0..1) array. */
export function mixImages(a: ImageData, b: ImageData, t: Float32Array) {
  const d = a.data, e = b.data;
  for (let i = 0, j = 0; i < t.length; i++, j += 4) { const k = t[i]; if (k <= 0) continue; for (let c = 0; c < 4; c++) d[j + c] = d[j + c] + (e[j + c] - d[j + c]) * k; }
  return a;
}
/** Gaussian of large sigma computed at reduced resolution (box downsample → blur → bilinear upsample). */
export function fastGaussPlanes(P: Planes, sigma: number): Planes {
  const f = sigma >= 6 ? Math.min(8, Math.floor(sigma / 3)) : 1;
  if (f <= 1) { const q: Planes = { w: P.w, h: P.h, c: P.c.map(c => new Float32Array(c)) }; gaussPlanes(q, sigma); return q; }
  const w = Math.ceil(P.w / f), h = Math.ceil(P.h / f);
  const small = P.c.map(c => {
    const o = new Float32Array(w * h), cnt = new Float32Array(w * h);
    for (let y = 0; y < P.h; y++) { const sy = ((y / f) | 0) * w; for (let x = 0; x < P.w; x++) { const k = sy + ((x / f) | 0); o[k] += c[y * P.w + x]; cnt[k]++; } }
    for (let i = 0; i < o.length; i++) o[i] /= cnt[i];
    gaussPlane(o, w, h, sigma / f);
    return o;
  });
  const out = small.map(sm => {
    const o = new Float32Array(P.w * P.h);
    for (let y = 0; y < P.h; y++) {
      const fy = Math.max(0, Math.min(h - 1.001, (y + 0.5) / f - 0.5)), y0 = fy | 0, ty = fy - y0, y1 = Math.min(h - 1, y0 + 1);
      for (let x = 0; x < P.w; x++) {
        const fx = Math.max(0, Math.min(w - 1.001, (x + 0.5) / f - 0.5)), x0 = fx | 0, tx = fx - x0, x1 = Math.min(w - 1, x0 + 1);
        o[y * P.w + x] = (sm[y0 * w + x0] * (1 - tx) + sm[y0 * w + x1] * tx) * (1 - ty) + (sm[y1 * w + x0] * (1 - tx) + sm[y1 * w + x1] * tx) * ty;
      }
    }
    return o;
  });
  return { w: P.w, h: P.h, c: out };
}
/** Variable-radius gaussian: blend a stack of blur levels according to a per-pixel sigma map. */
export function variableBlur(img: ImageData, sigma: Float32Array, maxSigma: number): ImageData {
  if (maxSigma <= 0.3) return img;
  const levels = [0, ...Array.from({ length: 6 }, (_, i) => maxSigma * Math.pow(2, i - 5))];
  const base = toPlanes(img), stack: Planes[] = [base];
  for (let i = 1; i < levels.length; i++) stack.push(fastGaussPlanes(base, levels[i]));
  const out: Planes = { w: base.w, h: base.h, c: base.c.map(c => new Float32Array(c.length)) };
  for (let i = 0; i < sigma.length; i++) {
    const s = Math.max(0, Math.min(maxSigma, sigma[i]));
    let k = 1;
    while (k < levels.length - 1 && levels[k] < s) k++;
    const s0 = levels[k - 1], s1 = levels[k], t = s1 > s0 ? Math.max(0, Math.min(1, (s - s0) / (s1 - s0))) : 0;
    for (let c = 0; c < 4; c++) out.c[c][i] = stack[k - 1].c[c][i] * (1 - t) + stack[k].c[c][i] * t;
  }
  return fromPlanes(out, img);
}

/** Premultiplied interleaved float copy (for fast multi-tap bilinear sampling). */
export function premul(img: ImageData): Float32Array {
  const d = img.data, o = new Float32Array(d.length);
  for (let i = 0; i < d.length; i += 4) { const a = d[i + 3], k = a / 255; o[i] = d[i] * k; o[i + 1] = d[i + 1] * k; o[i + 2] = d[i + 2] * k; o[i + 3] = a; }
  return o;
}
/** Accumulate a clamped bilinear premultiplied sample at (x, y) (pixel-centre coords) into acc[0..3]. */
export function tap(P: Float32Array, W: number, H: number, x: number, y: number, acc: Float64Array) {
  x -= 0.5; y -= 0.5;
  if (x < 0) x = 0; else if (x > W - 1) x = W - 1;
  if (y < 0) y = 0; else if (y > H - 1) y = H - 1;
  const x0 = x | 0, y0 = y | 0, fx = x - x0, fy = y - y0, x1 = x0 + 1 < W ? x0 + 1 : x0, y1 = y0 + 1 < H ? y0 + 1 : y0;
  const i00 = (y0 * W + x0) * 4, i10 = (y0 * W + x1) * 4, i01 = (y1 * W + x0) * 4, i11 = (y1 * W + x1) * 4;
  const w00 = (1 - fx) * (1 - fy), w10 = fx * (1 - fy), w01 = (1 - fx) * fy, w11 = fx * fy;
  acc[0] += P[i00] * w00 + P[i10] * w10 + P[i01] * w01 + P[i11] * w11;
  acc[1] += P[i00 + 1] * w00 + P[i10 + 1] * w10 + P[i01 + 1] * w01 + P[i11 + 1] * w11;
  acc[2] += P[i00 + 2] * w00 + P[i10 + 2] * w10 + P[i01 + 2] * w01 + P[i11 + 2] * w11;
  acc[3] += P[i00 + 3] * w00 + P[i10 + 3] * w10 + P[i01 + 3] * w01 + P[i11 + 3] * w11;
}
/** Write an accumulated premultiplied sum of n taps as straight RGBA. */
export function putAcc(d: Uint8ClampedArray, i: number, acc: Float64Array, n: number) {
  const a = acc[3];
  if (a > 0) { d[i] = acc[0] * 255 / a; d[i + 1] = acc[1] * 255 / a; d[i + 2] = acc[2] * 255 / a; }
  d[i + 3] = a / n;
  acc[0] = acc[1] = acc[2] = acc[3] = 0;
}
