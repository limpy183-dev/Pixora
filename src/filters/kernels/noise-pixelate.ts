// Noise and Pixelate kernels.
import { type Kernel, clamp, cloneImage, gaussian, gaussRand, lumaPlane, medianChannel, onRegion, rng, workRect } from './core';

// ------------------------------------------------------------------ Noise
const addNoise: Kernel = (img, p, m) => {
  const r = workRect(img, m), d = img.data, R = rng(m.seed), amt = p.amount * 2.55;
  const nz = () => (p.dist === 'gaussian' ? gaussRand(R) * 0.6 : (R() - 0.5) * 2) * amt;
  for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) {
    const i = (y * img.width + x) * 4;
    if (p.mono) { const n = nz(); d[i] = clamp(d[i] + n); d[i + 1] = clamp(d[i + 1] + n); d[i + 2] = clamp(d[i + 2] + n); }
    else { d[i] = clamp(d[i] + nz()); d[i + 1] = clamp(d[i + 1] + nz()); d[i + 2] = clamp(d[i + 2] + nz()); }
  }
  return img;
};
function median(img: ImageData, radius: number): ImageData {
  const out = new Uint8ClampedArray(img.data);
  for (let c = 0; c < 4; c++) medianChannel(img.data, img.width, img.height, c, radius, out);
  img.data.set(out);
  return img;
}
const medianK: Kernel = (img, p, m) => onRegion(img, m, p.radius + 1, sub => median(sub, Math.max(1, Math.round(p.radius))));
const dust: Kernel = (img, p, m) => onRegion(img, m, p.radius + 1, sub => {
  const orig = new Uint8ClampedArray(sub.data), med = median(sub, Math.max(1, Math.round(p.radius))).data;
  for (let i = 0; i < med.length; i += 4) {
    const diff = Math.max(Math.abs(orig[i] - med[i]), Math.abs(orig[i + 1] - med[i + 1]), Math.abs(orig[i + 2] - med[i + 2]));
    if (diff <= p.threshold) { med[i] = orig[i]; med[i + 1] = orig[i + 1]; med[i + 2] = orig[i + 2]; med[i + 3] = orig[i + 3]; }
  }
  return sub;
});
const despeckle: Kernel = (img, _p, m) => onRegion(img, m, 3, sub => {
  const W = sub.width, H = sub.height, L = lumaPlane(sub), orig = new Uint8ClampedArray(sub.data), med = median(sub, 1).data;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x, xl = x ? i - 1 : i, xr = x < W - 1 ? i + 1 : i, yu = y ? i - W : i, yd = y < H - 1 ? i + W : i;
    const g = Math.abs(L[xr] - L[xl]) + Math.abs(L[yd] - L[yu]);
    if (g > 40) { const o = i * 4; med[o] = orig[o]; med[o + 1] = orig[o + 1]; med[o + 2] = orig[o + 2]; med[o + 3] = orig[o + 3]; }   // keep edges
  }
  return sub;
});
/** Reduce Noise: edge-aware luminance smoothing + chroma blur + detail sharpening. */
const reduceNoise: Kernel = (img, p, m) => onRegion(img, m, 8, sub => {
  const W = sub.width, H = sub.height, n = W * H, d = sub.data;
  const Y = new Float32Array(n), Cb = new Float32Array(n), Cr = new Float32Array(n);
  for (let i = 0, j = 0; i < n; i++, j += 4) { const r = d[j], g = d[j + 1], b = d[j + 2]; Y[i] = 0.299 * r + 0.587 * g + 0.114 * b; Cb[i] = b - Y[i]; Cr[i] = r - Y[i]; }
  // luminance: bilateral-style 5x5 with range sigma from strength, detail preservation reduces it
  const sr = (p.strength / 10) * 30 * (1 - (p.preserve / 100) * 0.8) + 1, Ys = new Float32Array(n);
  const rangeW = new Float32Array(256); for (let k = 0; k < 256; k++) rangeW[k] = Math.exp(-(k * k) / (2 * sr * sr));
  const spW = new Float32Array(25); for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) spW[(dy + 2) * 5 + dx + 2] = Math.exp(-(dx * dx + dy * dy) / 8);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x, c = Y[i];
    let s = 0, ws = 0;
    for (let dy = -2; dy <= 2; dy++) { const row = (y + dy < 0 ? 0 : y + dy >= H ? H - 1 : y + dy) * W; for (let dx = -2; dx <= 2; dx++) { const xx = x + dx < 0 ? 0 : x + dx >= W ? W - 1 : x + dx, v = Y[row + xx]; const w = rangeW[Math.min(255, Math.abs(v - c) | 0)] * spW[(dy + 2) * 5 + dx + 2]; s += v * w; ws += w; } }
    Ys[i] = s / ws;
  }
  const mixY = p.strength / 10;
  // chroma: blur proportional to "Reduce Color Noise"
  const cs = (p.color / 100) * 4;
  const blurPlane = (a: Float32Array) => { const tmp = new ImageData(W, H); const t = tmp.data; for (let i = 0; i < n; i++) { t[i * 4] = a[i] + 128; t[i * 4 + 3] = 255; } gaussian(tmp, cs); for (let i = 0; i < n; i++) a[i] = t[i * 4] - 128; };
  if (cs > 0.2) { blurPlane(Cb); blurPlane(Cr); }
  // sharpen details: unsharp on luminance
  let Yo = Ys;
  if (p.sharpen > 0) {
    const tmp = new ImageData(W, H), t = tmp.data;
    for (let i = 0; i < n; i++) { t[i * 4] = Ys[i]; t[i * 4 + 3] = 255; }
    gaussian(tmp, 1);
    Yo = new Float32Array(n);
    for (let i = 0; i < n; i++) Yo[i] = Ys[i] + (Ys[i] - t[i * 4]) * (p.sharpen / 100) * 1.5;
  }
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    const y = Y[i] + (Yo[i] - Y[i]) * Math.min(1, mixY + (p.sharpen > 0 ? 0.001 : 0));
    const r = y + Cr[i], b = y + Cb[i], g = (y - 0.299 * r - 0.114 * b) / 0.587;
    d[j] = clamp(r); d[j + 1] = clamp(g); d[j + 2] = clamp(b);
  }
  return sub;
});

// ------------------------------------------------------------------ Pixelate
const mosaic: Kernel = (img, p, m) => {
  const r = workRect(img, m), s = Math.max(1, Math.round(p.size)), d = img.data, W = img.width;
  for (let by = r.y; by < r.y + r.h; by += s) for (let bx = r.x; bx < r.x + r.w; bx += s) {
    const ex = Math.min(r.x + r.w, bx + s), ey = Math.min(r.y + r.h, by + s);
    let R = 0, G = 0, B = 0, A = 0, n = 0;
    for (let y = by; y < ey; y++) for (let x = bx; x < ex; x++) { const i = (y * W + x) * 4, a = d[i + 3]; R += d[i] * a; G += d[i + 1] * a; B += d[i + 2] * a; A += a; n++; }
    const cr = A ? R / A : 0, cg = A ? G / A : 0, cb = A ? B / A : 0, ca = A / n;
    for (let y = by; y < ey; y++) for (let x = bx; x < ex; x++) { const i = (y * W + x) * 4; d[i] = cr; d[i + 1] = cg; d[i + 2] = cb; d[i + 3] = ca; }
  }
  return img;
};
/** Jittered-grid Voronoi: returns nearest seed index per pixel of r plus the seeds. */
function voronoi(r: { x: number; y: number; w: number; h: number }, cell: number, seed: number) {
  const R = rng(seed), gw = Math.ceil(r.w / cell) + 1, gh = Math.ceil(r.h / cell) + 1;
  const sx = new Float32Array(gw * gh), sy = new Float32Array(gw * gh);
  for (let j = 0; j < gh; j++) for (let i = 0; i < gw; i++) { sx[j * gw + i] = r.x + (i + R()) * cell; sy[j * gw + i] = r.y + (j + R()) * cell; }
  const idx = new Int32Array(r.w * r.h), dist = new Float32Array(r.w * r.h);
  for (let y = 0; y < r.h; y++) for (let x = 0; x < r.w; x++) {
    const px = r.x + x + 0.5, py = r.y + y + 0.5, gi = Math.floor((px - r.x) / cell), gj = Math.floor((py - r.y) / cell);
    let best = Infinity, bi = 0;
    for (let j = gj - 1; j <= gj + 1; j++) for (let i = gi - 1; i <= gi + 1; i++) {
      if (i < 0 || j < 0 || i >= gw || j >= gh) continue;
      const k = j * gw + i, dd = (sx[k] - px) ** 2 + (sy[k] - py) ** 2;
      if (dd < best) { best = dd; bi = k; }
    }
    idx[y * r.w + x] = bi; dist[y * r.w + x] = Math.sqrt(best);
  }
  return { idx, dist, sx, sy, count: gw * gh };
}
const crystallize: Kernel = (img, p, m) => {
  const r = workRect(img, m), d = img.data, W = img.width, v = voronoi(r, Math.max(3, p.size), m.seed);
  const acc = new Float64Array(v.count * 5);
  for (let y = 0; y < r.h; y++) for (let x = 0; x < r.w; x++) { const k = v.idx[y * r.w + x] * 5, i = ((r.y + y) * W + r.x + x) * 4, a = d[i + 3]; acc[k] += d[i] * a; acc[k + 1] += d[i + 1] * a; acc[k + 2] += d[i + 2] * a; acc[k + 3] += a; acc[k + 4]++; }
  for (let y = 0; y < r.h; y++) for (let x = 0; x < r.w; x++) {
    const k = v.idx[y * r.w + x] * 5, i = ((r.y + y) * W + r.x + x) * 4, A = acc[k + 3];
    if (A) { d[i] = acc[k] / A; d[i + 1] = acc[k + 1] / A; d[i + 2] = acc[k + 2] / A; }
    d[i + 3] = A / acc[k + 4];
  }
  return img;
};
const pointillize: Kernel = (img, p, m) => {
  const r = workRect(img, m), d = img.data, src = new Uint8ClampedArray(d), W = img.width, cell = Math.max(3, p.size), v = voronoi(r, cell, m.seed);
  const R = rng(m.seed + 7), rad = new Float32Array(v.count);
  for (let k = 0; k < v.count; k++) rad[k] = cell * (0.45 + R() * 0.25);
  const colAt = (k: number) => { const x = Math.max(0, Math.min(W - 1, Math.floor(v.sx[k]))), y = Math.max(0, Math.min(img.height - 1, Math.floor(v.sy[k]))); return (y * W + x) * 4; };
  const [br, bgc, bb] = m.bg;
  for (let y = 0; y < r.h; y++) for (let x = 0; x < r.w; x++) {
    const k = v.idx[y * r.w + x], i = ((r.y + y) * W + r.x + x) * 4, dd = v.dist[y * r.w + x];
    const t = Math.max(0, Math.min(1, rad[k] - dd + 0.5));
    const c = colAt(k);
    // slight colour jitter like the Photoshop filter
    d[i] = br + (src[c] - br) * t; d[i + 1] = bgc + (src[c + 1] - bgc) * t; d[i + 2] = bb + (src[c + 2] - bb) * t; d[i + 3] = 255;
  }
  return img;
};
const colorHalftone: Kernel = (img, p, m) => {
  const r = workRect(img, m), d = img.data, W = img.width, src = new Uint8ClampedArray(d);
  const cell = Math.max(4, p.radius * 2), angles = [p.a1, p.a2, p.a3];
  for (let c = 0; c < 3; c++) {
    const a = (angles[c] * Math.PI) / 180, ca = Math.cos(a), sa = Math.sin(a);
    for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) {
      // rotate into screen space, find the cell centre, sample the average there
      const u = (x + 0.5) * ca + (y + 0.5) * sa, v = -(x + 0.5) * sa + (y + 0.5) * ca;
      const cu = (Math.floor(u / cell) + 0.5) * cell, cv = (Math.floor(v / cell) + 0.5) * cell;
      const sx = Math.max(0, Math.min(W - 1, Math.floor(cu * ca - cv * sa))), sy = Math.max(0, Math.min(img.height - 1, Math.floor(cu * sa + cv * ca)));
      const val = src[(sy * W + sx) * 4 + c] / 255;
      const rad = (cell / 2) * Math.SQRT2 * Math.sqrt(val);
      const dist = Math.hypot(u - cu, v - cv);
      d[(y * W + x) * 4 + c] = clamp((rad - dist + 0.5) * 255);
    }
  }
  return img;
};
/** Facet: generalised Kuwahara — each pixel takes the mean of its most uniform quadrant. */
export function kuwahara(img: ImageData, rad: number): ImageData {
  const W = img.width, H = img.height, s = new Uint8ClampedArray(img.data), d = img.data, L = lumaPlane(img);
  // integral images of luma and luma² plus rgb for O(1) quadrant stats
  const I = (a: ArrayLike<number>, sq = false) => { const o = new Float64Array((W + 1) * (H + 1)); for (let y = 0; y < H; y++) { let row = 0; for (let x = 0; x < W; x++) { const v = a[y * W + x]; row += sq ? v * v : v; o[(y + 1) * (W + 1) + x + 1] = o[y * (W + 1) + x + 1] + row; } } return o; };
  const ch = [0, 1, 2].map(c => { const a = new Float32Array(W * H); for (let i = 0; i < W * H; i++) a[i] = s[i * 4 + c]; return I(a); });
  const IL = I(L), IL2 = I(L, true);
  const box = (T: Float64Array, x0: number, y0: number, x1: number, y1: number) => T[(y1 + 1) * (W + 1) + x1 + 1] - T[y0 * (W + 1) + x1 + 1] - T[(y1 + 1) * (W + 1) + x0] + T[y0 * (W + 1) + x0];
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let best = Infinity, bq: number[] = [x, y, x, y];
    for (const [ax, ay] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      const x0 = Math.max(0, Math.min(x, x + ax * rad)), x1 = Math.min(W - 1, Math.max(x, x + ax * rad)), y0 = Math.max(0, Math.min(y, y + ay * rad)), y1 = Math.min(H - 1, Math.max(y, y + ay * rad));
      const n = (x1 - x0 + 1) * (y1 - y0 + 1), mean = box(IL, x0, y0, x1, y1) / n, v = box(IL2, x0, y0, x1, y1) / n - mean * mean;
      if (v < best) { best = v; bq = [x0, y0, x1, y1]; }
    }
    const n = (bq[2] - bq[0] + 1) * (bq[3] - bq[1] + 1), o = (y * W + x) * 4;
    for (let c = 0; c < 3; c++) d[o + c] = box(ch[c], bq[0], bq[1], bq[2], bq[3]) / n;
  }
  return img;
}
const facet: Kernel = (img, _p, m) => onRegion(img, m, 4, sub => kuwahara(sub, 3));
const fragment: Kernel = (img, _p, m) => onRegion(img, m, 5, sub => {
  const W = sub.width, H = sub.height, s = new Uint8ClampedArray(sub.data), d = sub.data, off = [[-4, -4], [4, -4], [-4, 4], [4, 4]];
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const o = (y * W + x) * 4;
    for (let c = 0; c < 4; c++) { let v = 0; for (const [dx, dy] of off) v += s[(Math.min(H - 1, Math.max(0, y + dy)) * W + Math.min(W - 1, Math.max(0, x + dx))) * 4 + c]; d[o + c] = v / 4; }
  }
  return sub;
});
const mezzotint: Kernel = (img, p, m) => {
  const r = workRect(img, m), d = img.data, W = img.width, R = rng(m.seed), t = p.type as string;
  const grain = t.startsWith('fine') ? 1 : t.startsWith('medium dots') ? 2 : t.startsWith('grainy') ? 1 : t.startsWith('coarse') ? 3 : 1;
  const len = t.includes('short') ? 6 : t.includes('medium') && !t.includes('dots') ? 14 : t.includes('long') ? 28 : 1;
  const lines = t.includes('lines'), strokes = t.includes('strokes');
  const noise = new Float32Array(r.w * r.h);
  if (lines || strokes) {
    for (let y = 0; y < r.h; y++) {
      let x = 0;
      while (x < r.w) {
        const L = Math.max(1, Math.round(len * (0.5 + R()))), v = R();
        for (let k = 0; k < L; k++) {
          const xx = x + k, yy = strokes ? y + Math.floor(k * 0.7) : y;
          if (xx < r.w && yy < r.h) noise[yy * r.w + xx] = v;
        }
        x += L;
      }
    }
  } else {
    const gw = Math.ceil(r.w / grain), gh = Math.ceil(r.h / grain), g = new Float32Array(gw * gh);
    for (let i = 0; i < g.length; i++) g[i] = t.startsWith('grainy') ? Math.min(1, Math.max(0, 0.5 + gaussRand(R) * 0.3)) : R();
    for (let y = 0; y < r.h; y++) for (let x = 0; x < r.w; x++) noise[y * r.w + x] = g[Math.floor(y / grain) * gw + Math.floor(x / grain)];
  }
  for (let y = 0; y < r.h; y++) for (let x = 0; x < r.w; x++) {
    const i = ((r.y + y) * W + r.x + x) * 4, n = noise[y * r.w + x] * 255;
    for (let c = 0; c < 3; c++) d[i + c] = d[i + c] > n ? 255 : 0;
  }
  return img;
};

export const noiseKernels: Record<string, Kernel> = {
  'add-noise': addNoise, despeckle, 'dust-scratches': dust, median: medianK, 'reduce-noise': reduceNoise,
  'color-halftone': colorHalftone, crystallize, facet, fragment, mezzotint, mosaic, pointillize,
};
export { cloneImage };
