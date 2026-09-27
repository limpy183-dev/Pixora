// Selection algorithms on flat typed arrays (no DOM): distance transforms, morphology, flood fills,
// colour-model segmentation, saliency, guided filter refinement and live-wire edge tracing.
// Masks are Uint8Array (w*h, 0..255); images are RGBA Uint8ClampedArray (ImageData.data).

export type U8 = Uint8Array | Uint8ClampedArray;
const INF = 1e20;

// ------------------------------------------------------------------ distance transform (Felzenszwalb)
function dt1d(f: Float64Array, n: number, d: Float64Array, v: Int32Array, z: Float64Array) {
  let k = 0;
  v[0] = 0; z[0] = -INF; z[1] = INF;
  for (let q = 1; q < n; q++) {
    let s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    while (s <= z[k]) { k--; s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]); }
    k++; v[k] = q; z[k] = s; z[k + 1] = INF;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    const dq = q - v[k];
    d[q] = dq * dq + f[v[k]];
  }
}

/** Exact squared Euclidean distance from every pixel to the nearest pixel with feat[i] != 0. */
export function distanceField(feat: U8, w: number, h: number): Float32Array {
  const n = Math.max(w, h);
  const out = new Float32Array(w * h);
  const f = new Float64Array(n), d = new Float64Array(n), v = new Int32Array(n), z = new Float64Array(n + 1);
  for (let x = 0; x < w; x++) {
    for (let y = 0, i = x; y < h; y++, i += w) f[y] = feat[i] ? 0 : INF;
    dt1d(f, h, d, v, z);
    for (let y = 0, i = x; y < h; y++, i += w) out[i] = d[y];
  }
  for (let y = 0; y < h; y++) {
    const o = y * w;
    for (let x = 0; x < w; x++) f[x] = out[o + x];
    dt1d(f, w, d, v, z);
    for (let x = 0; x < w; x++) out[o + x] = d[x];
  }
  return out;
}

/** Expand the selection by r px (anti-aliased, round corners). */
export function expandMask(m: U8, w: number, h: number, r: number): Uint8Array {
  const n = w * h, feat = new Uint8Array(n);
  for (let i = 0; i < n; i++) feat[i] = m[i] >= 128 ? 1 : 0;
  const d = distanceField(feat, w, h), out = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const a = r + 1 - Math.sqrt(d[i]);
    const v = a >= 1 ? 255 : a <= 0 ? 0 : Math.round(a * 255);
    out[i] = v > m[i] ? v : m[i];
  }
  return out;
}

/** Contract the selection by r px. atBounds: the canvas edge counts as unselected. */
export function contractMask(m: U8, w: number, h: number, r: number, atBounds: boolean): Uint8Array {
  const n = w * h, out = new Uint8Array(n);
  const pw = atBounds ? w + 2 : w, ph = atBounds ? h + 2 : h, p = atBounds ? 1 : 0;
  const feat = new Uint8Array(pw * ph);
  if (atBounds) feat.fill(1);
  let any = false;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const u = m[y * w + x] < 128 ? 1 : 0;
    feat[(y + p) * pw + x + p] = u;
    if (u) any = true;
  }
  if (!any && !atBounds) { out.set(m); return out; }
  const d = distanceField(feat, pw, ph);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x, a = Math.sqrt(d[(y + p) * pw + x + p]) - r;
    const v = a >= 1 ? 255 : a <= 0 ? 0 : Math.round(a * 255);
    out[i] = v < m[i] ? v : m[i];
  }
  return out;
}

/** Border: a band `width` px wide centred on the selection edge. */
export function borderMask(m: U8, w: number, h: number, width: number, atBounds: boolean): Uint8Array {
  const half = width / 2;
  const outer = expandMask(m, w, h, half), inner = contractMask(m, w, h, half, atBounds);
  const out = new Uint8Array(w * h);
  for (let i = 0; i < out.length; i++) { const a = outer[i], b = 255 - inner[i]; out[i] = a < b ? a : b; }
  return softenEdges(out, w, h);
}

/** Smooth: majority filter over a (2r+1)² box, then anti-alias. */
export function smoothMask(m: U8, w: number, h: number, r: number, atBounds: boolean): Uint8Array {
  const W = w + 1, I = new Int32Array(W * (h + 1));
  for (let y = 0; y < h; y++) {
    let row = 0;
    for (let x = 0; x < w; x++) {
      row += m[y * w + x] >= 128 ? 1 : 0;
      I[(y + 1) * W + x + 1] = I[y * W + x + 1] + row;
    }
  }
  const out = new Uint8Array(w * h), full = (2 * r + 1) * (2 * r + 1);
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - r), y1 = Math.min(h, y + r + 1);
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - r), x1 = Math.min(w, x + r + 1);
      const c = I[y1 * W + x1] - I[y0 * W + x1] - I[y1 * W + x0] + I[y0 * W + x0];
      const area = atBounds ? full : (x1 - x0) * (y1 - y0);
      const i = y * w + x;
      out[i] = c * 2 > area ? 255 : c * 2 < area ? 0 : (m[i] >= 128 ? 255 : 0);
    }
  }
  return softenEdges(out, w, h);
}

/** Anti-alias a hard mask: edge pixels get the 3×3 mean. */
export function softenEdges(m: U8, w: number, h: number): Uint8Array {
  const out = new Uint8Array(m);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x, v = m[i];
    const l = x > 0 ? m[i - 1] : v, r = x < w - 1 ? m[i + 1] : v, t = y > 0 ? m[i - w] : v, b = y < h - 1 ? m[i + w] : v;
    if (l === v && r === v && t === v && b === v) continue;
    let s = 0, c = 0;
    for (let yy = Math.max(0, y - 1); yy <= Math.min(h - 1, y + 1); yy++)
      for (let xx = Math.max(0, x - 1); xx <= Math.min(w - 1, x + 1); xx++) { s += m[yy * w + xx]; c++; }
    out[i] = Math.round((s + v * 2) / (c + 2));
  }
  return out;
}

// ------------------------------------------------------------------ flood fill / colour tables
function colorMatcher(d: Uint8ClampedArray, r: number, g: number, b: number, a: number, tol: number) {
  return (j: number) => {
    const dr = d[j] - r, dg = d[j + 1] - g, db = d[j + 2] - b, da = d[j + 3] - a;
    return dr <= tol && dr >= -tol && dg <= tol && dg >= -tol && db <= tol && db >= -tol && da <= tol && da >= -tol;
  };
}

/** Average colour in a (size×size) box around (x, y). */
export function sampleColor(d: Uint8ClampedArray, w: number, h: number, x: number, y: number, size = 1): [number, number, number, number] {
  const r = Math.floor(size / 2);
  let sr = 0, sg = 0, sb = 0, sa = 0, c = 0;
  for (let yy = Math.max(0, y - r); yy <= Math.min(h - 1, y + r); yy++)
    for (let xx = Math.max(0, x - r); xx <= Math.min(w - 1, x + r); xx++) {
      const j = (yy * w + xx) * 4; sr += d[j]; sg += d[j + 1]; sb += d[j + 2]; sa += d[j + 3]; c++;
    }
  c = c || 1;
  return [sr / c, sg / c, sb / c, sa / c];
}

/** Magic Wand: pixels within ±tol of the sampled colour (per channel). Contiguous uses a scanline fill. */
export function wandMask(d: Uint8ClampedArray, w: number, h: number, x: number, y: number, tol: number, contiguous: boolean, sampleSize = 1): Uint8Array {
  const out = new Uint8Array(w * h);
  if (x < 0 || y < 0 || x >= w || y >= h) return out;
  const [r, g, b, a] = sampleColor(d, w, h, x, y, sampleSize);
  const match = colorMatcher(d, r, g, b, a, tol + 0.5);
  if (!contiguous) {
    for (let i = 0, j = 0; i < out.length; i++, j += 4) if (match(j)) out[i] = 255;
    return out;
  }
  scanlineFill(w, h, [y * w + x], i => match(i * 4), out);
  return out;
}

/** Generic scanline flood fill from seed indices; accept(i) decides membership; marks out[i] = 255. */
export function scanlineFill(w: number, h: number, seeds: number[] | Int32Array, accept: (i: number) => boolean, out: Uint8Array) {
  let stack = new Int32Array(Math.max(1024, seeds.length * 2));
  let sp = 0;
  const push = (i: number) => {
    if (sp >= stack.length) { const s = new Int32Array(stack.length * 2); s.set(stack); stack = s; }
    stack[sp++] = i;
  };
  for (const s of seeds) if (!out[s] && accept(s)) push(s);
  while (sp) {
    const i = stack[--sp];
    if (out[i]) continue;
    const y = (i / w) | 0, row = y * w;
    let xl = i - row, xr = xl;
    while (xl > 0 && !out[row + xl - 1] && accept(row + xl - 1)) xl--;
    while (xr < w - 1 && !out[row + xr + 1] && accept(row + xr + 1)) xr++;
    for (let x = xl; x <= xr; x++) out[row + x] = 255;
    for (const ny of [y - 1, y + 1]) {
      if (ny < 0 || ny >= h) continue;
      const nrow = ny * w;
      let inRun = false;
      for (let x = xl; x <= xr; x++) {
        const j = nrow + x;
        const ok = !out[j] && accept(j);
        if (ok && !inRun) { push(j); inRun = true; } else if (!ok) inRun = false;
      }
    }
  }
}

/** 64³ colour presence table of the selected pixels, dilated by `tol` (Chebyshev) — used by Grow / Similar. */
export function colorTable(d: Uint8ClampedArray, m: U8, tol: number): Uint8Array {
  const B = 64, t = new Uint8Array(B * B * B);
  for (let i = 0, j = 0; i < m.length; i++, j += 4) if (m[i] >= 128) t[((d[j] >> 2) * B + (d[j + 1] >> 2)) * B + (d[j + 2] >> 2)] = 1;
  const r = Math.ceil(tol / 4);
  if (r <= 0) return t;
  const tmp = new Uint8Array(t.length);
  const pass = (src: Uint8Array, dst: Uint8Array, stride: number) => {
    // dilate along one axis with a running count
    const line = new Int32Array(B);
    for (let a = 0; a < B; a++) for (let b = 0; b < B; b++) {
      let base: number;
      if (stride === 1) base = (a * B + b) * B; else if (stride === B) base = a * B * B + b; else base = a * B + b;
      let s = 0;
      for (let k = 0; k < B; k++) line[k] = src[base + k * stride];
      for (let k = 0; k <= Math.min(r, B - 1); k++) s += line[k];
      for (let k = 0; k < B; k++) {
        dst[base + k * stride] = s > 0 ? 1 : 0;
        if (k + r + 1 < B) s += line[k + r + 1];
        if (k - r >= 0) s -= line[k - r];
      }
    }
  };
  pass(t, tmp, 1); pass(tmp, t, B); pass(t, tmp, B * B);
  return tmp;
}
const inTable = (t: Uint8Array, d: Uint8ClampedArray, j: number) => t[(((d[j] >> 2) << 6) + (d[j + 1] >> 2)) * 64 + (d[j + 2] >> 2)] === 1;

/** Grow (contiguous) / Similar (global) using the colours of the current selection. */
export function growMask(d: Uint8ClampedArray, m: U8, w: number, h: number, tol: number, contiguous: boolean): Uint8Array {
  const t = colorTable(d, m, tol);
  const out = new Uint8Array(w * h);
  if (!contiguous) {
    for (let i = 0, j = 0; i < out.length; i++, j += 4) out[i] = m[i] >= 128 || inTable(t, d, j) ? 255 : m[i];
    return softenEdges(out, w, h);
  }
  const seeds: number[] = [];
  for (let i = 0; i < m.length; i++) if (m[i] >= 128) seeds.push(i);
  scanlineFill(w, h, seeds, i => m[i] >= 128 || inTable(t, d, i * 4), out);
  for (let i = 0; i < out.length; i++) if (!out[i]) out[i] = m[i];
  return softenEdges(out, w, h);
}

// ------------------------------------------------------------------ filters
/** Box blur with edge-normalised windows (separable running sums). */
export function boxBlur(src: Float32Array, w: number, h: number, r: number, out = new Float32Array(w * h)): Float32Array {
  if (r < 1) { out.set(src); return out; }
  const tmp = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const o = y * w;
    let s = 0;
    for (let x = 0; x <= Math.min(r, w - 1); x++) s += src[o + x];
    for (let x = 0; x < w; x++) {
      const lo = x - r, hi = x + r;
      tmp[o + x] = s / ((hi < w ? hi : w - 1) - (lo > 0 ? lo : 0) + 1);
      if (hi + 1 < w) s += src[o + hi + 1];
      if (lo >= 0) s -= src[o + lo];
    }
  }
  for (let x = 0; x < w; x++) {
    let s = 0;
    for (let y = 0; y <= Math.min(r, h - 1); y++) s += tmp[y * w + x];
    for (let y = 0; y < h; y++) {
      const lo = y - r, hi = y + r;
      out[y * w + x] = s / ((hi < h ? hi : h - 1) - (lo > 0 ? lo : 0) + 1);
      if (hi + 1 < h) s += tmp[(hi + 1) * w + x];
      if (lo >= 0) s -= tmp[lo * w + x];
    }
  }
  return out;
}

/** Colour guided filter (He et al.): edge-aware refinement of p (0..1) guided by the RGB image. */
export function guidedFilter(d: Uint8ClampedArray, p: Float32Array, w: number, h: number, r: number, eps: number): Float32Array {
  const n = w * h;
  const R = new Float32Array(n), G = new Float32Array(n), B = new Float32Array(n);
  for (let i = 0, j = 0; i < n; i++, j += 4) { R[i] = d[j] / 255; G[i] = d[j + 1] / 255; B[i] = d[j + 2] / 255; }
  const bl = (a: Float32Array) => boxBlur(a, w, h, r);
  const prod = (a: Float32Array, b: Float32Array) => { const o = new Float32Array(n); for (let i = 0; i < n; i++) o[i] = a[i] * b[i]; return bl(o); };
  const mr = bl(R), mg = bl(G), mb = bl(B), mp = bl(p);
  const mrp = prod(R, p), mgp = prod(G, p), mbp = prod(B, p);
  const vrr = prod(R, R), vrg = prod(R, G), vrb = prod(R, B), vgg = prod(G, G), vgb = prod(G, B), vbb = prod(B, B);
  const ar = new Float32Array(n), ag = new Float32Array(n), ab = new Float32Array(n), bb = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const cr = mrp[i] - mr[i] * mp[i], cg = mgp[i] - mg[i] * mp[i], cb = mbp[i] - mb[i] * mp[i];
    const a11 = vrr[i] - mr[i] * mr[i] + eps, a12 = vrg[i] - mr[i] * mg[i], a13 = vrb[i] - mr[i] * mb[i];
    const a22 = vgg[i] - mg[i] * mg[i] + eps, a23 = vgb[i] - mg[i] * mb[i], a33 = vbb[i] - mb[i] * mb[i] + eps;
    const i11 = a22 * a33 - a23 * a23, i12 = a13 * a23 - a12 * a33, i13 = a12 * a23 - a13 * a22;
    const i22 = a11 * a33 - a13 * a13, i23 = a13 * a12 - a11 * a23, i33 = a11 * a22 - a12 * a12;
    const det = a11 * i11 + a12 * i12 + a13 * i13 || 1e-12;
    const xr = (i11 * cr + i12 * cg + i13 * cb) / det, xg = (i12 * cr + i22 * cg + i23 * cb) / det, xb = (i13 * cr + i23 * cg + i33 * cb) / det;
    ar[i] = xr; ag[i] = xg; ab[i] = xb;
    bb[i] = mp[i] - xr * mr[i] - xg * mg[i] - xb * mb[i];
  }
  const mar = bl(ar), mag = bl(ag), mab = bl(ab), mbb = bl(bb);
  const q = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const v = mar[i] * R[i] + mag[i] * G[i] + mab[i] * B[i] + mbb[i];
    q[i] = v < 0 ? 0 : v > 1 ? 1 : v;
  }
  return q;
}

/** Sobel gradient magnitude of luminance (0..~1). */
export function gradientMagnitude(d: Uint8ClampedArray, w: number, h: number): Float32Array {
  const n = w * h, L = new Float32Array(n), g = new Float32Array(n);
  for (let i = 0, j = 0; i < n; i++, j += 4) L[i] = (0.299 * d[j] + 0.587 * d[j + 1] + 0.114 * d[j + 2]) * (d[j + 3] / 255) / 255;
  for (let y = 0; y < h; y++) {
    const ym = y > 0 ? y - 1 : 0, yp = y < h - 1 ? y + 1 : h - 1;
    for (let x = 0; x < w; x++) {
      const xm = x > 0 ? x - 1 : 0, xp = x < w - 1 ? x + 1 : w - 1;
      const a = L[ym * w + xm], b = L[ym * w + x], c = L[ym * w + xp], dd = L[y * w + xm], f = L[y * w + xp], gg = L[yp * w + xm], hh = L[yp * w + x], ii = L[yp * w + xp];
      const gx = (c + 2 * f + ii) - (a + 2 * dd + gg), gy = (gg + 2 * hh + ii) - (a + 2 * b + c);
      g[y * w + x] = Math.sqrt(gx * gx + gy * gy) / 4;
    }
  }
  return g;
}

/** Otsu threshold for values in [0, 1]. */
export function otsu(v: Float32Array, mask?: U8): number {
  const hist = new Float64Array(256);
  let total = 0;
  for (let i = 0; i < v.length; i++) { if (mask && !mask[i]) continue; hist[Math.min(255, Math.max(0, Math.round(v[i] * 255)))]++; total++; }
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sumB = 0, wB = 0, best = 0, thr = 128;
  for (let t = 0; t < 256; t++) {
    wB += hist[t]; if (!wB) continue;
    const wF = total - wB; if (!wF) break;
    sumB += t * hist[t];
    const mB = sumB / wB, mF = (sum - sumB) / wF, between = wB * wF * (mB - mF) * (mB - mF);
    if (between > best) { best = between; thr = t; }
  }
  return (thr + 0.5) / 255;
}

// ------------------------------------------------------------------ connected components
/** Keep the components (4-connected, value >= 128) whose area is >= minFrac of the largest. Returns new mask. */
export function keepLargest(m: U8, w: number, h: number, minFrac = 0.15, preferSeed?: U8): Uint8Array {
  const n = w * h, lab = new Int32Array(n), q = new Int32Array(n);
  const areas: number[] = [0], seeded: boolean[] = [false];
  let id = 0;
  for (let s = 0; s < n; s++) {
    if (m[s] < 128 || lab[s]) continue;
    id++;
    let head = 0, tail = 0, area = 0, hasSeed = false;
    q[tail++] = s; lab[s] = id;
    while (head < tail) {
      const i = q[head++]; area++;
      if (preferSeed && preferSeed[i]) hasSeed = true;
      const x = i % w;
      if (x > 0 && m[i - 1] >= 128 && !lab[i - 1]) { lab[i - 1] = id; q[tail++] = i - 1; }
      if (x < w - 1 && m[i + 1] >= 128 && !lab[i + 1]) { lab[i + 1] = id; q[tail++] = i + 1; }
      if (i >= w && m[i - w] >= 128 && !lab[i - w]) { lab[i - w] = id; q[tail++] = i - w; }
      if (i < n - w && m[i + w] >= 128 && !lab[i + w]) { lab[i + w] = id; q[tail++] = i + w; }
    }
    areas.push(area); seeded.push(hasSeed);
  }
  const out = new Uint8Array(n);
  if (!id) return out;
  let maxA = 0;
  for (let k = 1; k <= id; k++) if (!preferSeed || seeded[k] || !seeded.some(Boolean)) maxA = Math.max(maxA, areas[k]);
  const keep = new Uint8Array(id + 1);
  for (let k = 1; k <= id; k++) keep[k] = (preferSeed && seeded[k]) || areas[k] >= maxA * minFrac ? 1 : 0;
  for (let i = 0; i < n; i++) if (lab[i] && keep[lab[i]]) out[i] = m[i];
  return out;
}

/** Fill holes: unselected components that don't touch the image border (or are smaller than maxArea if given). */
export function fillHoles(m: U8, w: number, h: number, maxArea = Infinity): Uint8Array {
  const n = w * h, seen = new Uint8Array(n), q = new Int32Array(n), out = new Uint8Array(m);
  for (let s = 0; s < n; s++) {
    if (m[s] >= 128 || seen[s]) continue;
    let head = 0, tail = 0, border = false;
    q[tail++] = s; seen[s] = 1;
    while (head < tail) {
      const i = q[head++], x = i % w, y = (i / w) | 0;
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) border = true;
      if (x > 0 && m[i - 1] < 128 && !seen[i - 1]) { seen[i - 1] = 1; q[tail++] = i - 1; }
      if (x < w - 1 && m[i + 1] < 128 && !seen[i + 1]) { seen[i + 1] = 1; q[tail++] = i + 1; }
      if (y > 0 && m[i - w] < 128 && !seen[i - w]) { seen[i - w] = 1; q[tail++] = i - w; }
      if (y < h - 1 && m[i + w] < 128 && !seen[i + w]) { seen[i + w] = 1; q[tail++] = i + w; }
    }
    if (!border || tail <= maxArea) for (let k = 0; k < tail; k++) out[q[k]] = 255;
  }
  return out;
}

// ------------------------------------------------------------------ colour spaces
const LIN = new Float32Array(256);
for (let i = 0; i < 256; i++) { const c = i / 255; LIN[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }
const labF = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
/** RGBA → Lab planar Float32Array [L..., a..., b...]. */
export function toLab(d: Uint8ClampedArray, n: number): Float32Array {
  const out = new Float32Array(n * 3);
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    const r = LIN[d[j]], g = LIN[d[j + 1]], b = LIN[d[j + 2]];
    const x = labF((r * 0.4124 + g * 0.3576 + b * 0.1805) / 0.95047), y = labF(r * 0.2126 + g * 0.7152 + b * 0.0722), z = labF((r * 0.0193 + g * 0.1192 + b * 0.9505) / 1.08883);
    out[i] = 116 * y - 16; out[n + i] = 500 * (x - y); out[2 * n + i] = 200 * (y - z);
  }
  return out;
}

/** Tiny k-means on 3-D points (planar arrays sampled by index list). Returns centres. */
export function kmeans3(a: Float32Array, b: Float32Array, c: Float32Array, idx: number[], k: number, iters = 8): number[][] {
  if (!idx.length) return [];
  k = Math.min(k, idx.length);
  const cent: number[][] = [];
  // k-means++-ish deterministic init: spread picks
  for (let i = 0; i < k; i++) { const j = idx[Math.floor((i + 0.5) * idx.length / k)]; cent.push([a[j], b[j], c[j]]); }
  const assign = new Int32Array(idx.length);
  for (let it = 0; it < iters; it++) {
    for (let t = 0; t < idx.length; t++) {
      const j = idx[t];
      let best = 0, bd = Infinity;
      for (let q = 0; q < k; q++) { const d0 = a[j] - cent[q][0], d1 = b[j] - cent[q][1], d2 = c[j] - cent[q][2]; const dd = d0 * d0 + d1 * d1 + d2 * d2; if (dd < bd) { bd = dd; best = q; } }
      assign[t] = best;
    }
    const sum = cent.map(() => [0, 0, 0, 0]);
    for (let t = 0; t < idx.length; t++) { const j = idx[t], s = sum[assign[t]]; s[0] += a[j]; s[1] += b[j]; s[2] += c[j]; s[3]++; }
    for (let q = 0; q < k; q++) if (sum[q][3]) cent[q] = [sum[q][0] / sum[q][3], sum[q][1] / sum[q][3], sum[q][2] / sum[q][3]];
  }
  return cent;
}

// ------------------------------------------------------------------ segmentation (GrabCut-style)
/** Labels for segment(): definite / probable background / foreground. */
export const BG = 0, FG = 1, PR_BG = 2, PR_FG = 3;

/**
 * Iterative colour-model segmentation: 16³ colour histograms for FG/BG are learnt from the labels, turned into a
 * per-pixel likelihood, then smoothed with an edge-aware diffusion (random-walker style pairwise term) that
 * respects colour edges. Probable labels are re-estimated each iteration. Returns FG probability (0..1).
 */
export function segment(d: Uint8ClampedArray, w: number, h: number, labels: Uint8Array, opts: { iters?: number; prior?: Float32Array; lambda?: number; sweeps?: number } = {}): Float32Array {
  const n = w * h, iters = opts.iters ?? 4, lambda = opts.lambda ?? 0.35, sweeps = opts.sweeps ?? 30;
  // pairwise weights (right, down)
  const wr = new Float32Array(n), wd = new Float32Array(n);
  let sum = 0, cnt = 0;
  const cd = (i: number, j: number) => { const a = i * 4, b = j * 4, r = d[a] - d[b], g = d[a + 1] - d[b + 1], bl = d[a + 2] - d[b + 2]; return r * r + g * g + bl * bl; };
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    if (x < w - 1) { sum += cd(i, i + 1); cnt++; }
    if (y < h - 1) { sum += cd(i, i + w); cnt++; }
  }
  const beta = 1 / (2 * Math.max(1, sum / Math.max(1, cnt)));
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    wr[i] = x < w - 1 ? Math.exp(-beta * cd(i, i + 1)) : 0;
    wd[i] = y < h - 1 ? Math.exp(-beta * cd(i, i + w)) : 0;
  }
  const bin = new Uint16Array(n);
  for (let i = 0, j = 0; i < n; i++, j += 4) bin[i] = ((d[j] >> 4) << 8) | ((d[j + 1] >> 4) << 4) | (d[j + 2] >> 4);
  const p = new Float32Array(n), u = new Float32Array(n);
  for (let i = 0; i < n; i++) p[i] = labels[i] === FG || labels[i] === PR_FG ? 1 : 0;
  const hf = new Float32Array(4096), hb = new Float32Array(4096);
  const blur3 = (hh: Float32Array) => {
    const t = new Float32Array(4096);
    for (let pass = 0; pass < 3; pass++) {
      const s = pass === 0 ? 256 : pass === 1 ? 16 : 1;
      const src = pass === 1 ? t : hh, dst = pass === 1 ? hh : t;
      for (let i = 0; i < 4096; i++) {
        const c = (i / s | 0) % 16;
        dst[i] = src[i] * 2 + (c > 0 ? src[i - s] : src[i]) + (c < 15 ? src[i + s] : src[i]);
      }
    }
    hh.set(t);
  };
  for (let it = 0; it < iters; it++) {
    hf.fill(0); hb.fill(0);
    let nf = 0, nb = 0;
    for (let i = 0; i < n; i++) {
      const L = labels[i];
      if (L === FG || (L !== BG && p[i] >= 0.5)) { hf[bin[i]]++; nf++; } else { hb[bin[i]]++; nb++; }
    }
    if (!nf || !nb) break;
    blur3(hf); blur3(hb);
    let tf = 0, tb = 0;
    for (let i = 0; i < 4096; i++) { tf += hf[i]; tb += hb[i]; }
    const ef = tf * 1e-5, eb = tb * 1e-5;
    for (let i = 0; i < n; i++) {
      const L = labels[i];
      if (L === FG) { u[i] = 1; continue; }
      if (L === BG) { u[i] = 0; continue; }
      const pf = (hf[bin[i]] + ef) / tf, pb = (hb[bin[i]] + eb) / tb;
      let pr = opts.prior ? opts.prior[i] : 0.5;
      pr = pr < 0.03 ? 0.03 : pr > 0.97 ? 0.97 : pr;
      u[i] = (pf * pr) / (pf * pr + pb * (1 - pr));
    }
    // edge-aware diffusion: minimise λΣ(p-u)² + Σ w_ij (p_i - p_j)² with Gauss-Seidel sweeps
    p.set(u);
    for (let s = 0; s < sweeps; s++) {
      const fwd = (s & 1) === 0;
      for (let k = 0; k < n; k++) {
        const i = fwd ? k : n - 1 - k, L = labels[i];
        if (L === FG || L === BG) continue;
        const x = i % w;
        let num = lambda * u[i], den = lambda;
        if (x < w - 1) { num += wr[i] * p[i + 1]; den += wr[i]; }
        if (x > 0) { num += wr[i - 1] * p[i - 1]; den += wr[i - 1]; }
        if (i + w < n) { num += wd[i] * p[i + w]; den += wd[i]; }
        if (i >= w) { num += wd[i - w] * p[i - w]; den += wd[i - w]; }
        p[i] = num / den;
      }
    }
  }
  return p;
}

// ------------------------------------------------------------------ saliency (Select Subject)
/**
 * Background-contrast saliency: distance of each pixel's Lab colour to colour clusters of each image border.
 * A pixel is background if it resembles at least two borders (so subjects touching one border survive).
 * Multiplied by a centre prior. Returns 0..1.
 */
export function saliencyMap(d: Uint8ClampedArray, w: number, h: number): Float32Array {
  const n = w * h, lab = toLab(d, n);
  const L = lab.subarray(0, n), A = lab.subarray(n, 2 * n), B = lab.subarray(2 * n);
  const band = Math.max(2, Math.round(Math.min(w, h) * 0.04));
  const borders: number[][] = [[], [], [], []];
  const step = Math.max(1, Math.round((w + h) / 400));
  for (let y = 0; y < band; y++) for (let x = 0; x < w; x += step) { borders[0].push(y * w + x); borders[1].push((h - 1 - y) * w + x); }
  for (let x = 0; x < band; x++) for (let y = 0; y < h; y += step) { borders[2].push(y * w + x); borders[3].push(y * w + (w - 1 - x)); }
  const models = borders.map(idx => kmeans3(L, A, B, idx, 5));
  const dist = [new Float32Array(n), new Float32Array(n), new Float32Array(n), new Float32Array(n)];
  for (let i = 0; i < n; i++) for (let k = 0; k < 4; k++) {
    let best = Infinity;
    for (const c of models[k]) { const d0 = (L[i] - c[0]) * 0.7, d1 = A[i] - c[1], d2 = B[i] - c[2]; const dd = d0 * d0 + d1 * d1 + d2 * d2; if (dd < best) best = dd; }
    dist[k][i] = Math.sqrt(best);
  }
  const s = new Float32Array(n), tmp = [0, 0, 0, 0];
  const cx = w / 2, cy = h / 2, sx = 2 * (0.33 * w) ** 2, sy = 2 * (0.38 * h) ** 2;
  for (let i = 0; i < n; i++) {
    tmp[0] = dist[0][i]; tmp[1] = dist[1][i]; tmp[2] = dist[2][i]; tmp[3] = dist[3][i];
    tmp.sort((a, b) => a - b);
    const x = i % w, y = (i / w) | 0;
    const centre = Math.exp(-((x - cx) ** 2) / sx - ((y - cy) ** 2) / sy);
    s[i] = tmp[1] * (0.35 + 0.65 * centre);
  }
  // normalise by the 98th percentile
  const sorted = Float32Array.from(s).sort();
  const hi = sorted[Math.floor(n * 0.98)] || 1;
  for (let i = 0; i < n; i++) s[i] = Math.min(1, s[i] / hi);
  return boxBlur(s, w, h, Math.max(1, Math.round(Math.min(w, h) / 120)));
}

// ------------------------------------------------------------------ region growing (Quick Selection)
export interface GrowResult { x: number; y: number; w: number; h: number; mask: Uint8Array }
/**
 * Quick Selection region growing: learns up to 3 colour clusters under the brush and grows (4-connected) from the
 * brush footprint through similar colours inside a local window, stopping at strong gradients.
 */
export function quickGrow(d: Uint8ClampedArray, grad: Float32Array, W: number, H: number, cx: number, cy: number, r: number, reach: number): GrowResult | null {
  const x0 = Math.max(0, Math.floor(cx - reach)), y0 = Math.max(0, Math.floor(cy - reach));
  const x1 = Math.min(W, Math.ceil(cx + reach + 1)), y1 = Math.min(H, Math.ceil(cy + reach + 1));
  const w = x1 - x0, h = y1 - y0;
  if (w <= 0 || h <= 0) return null;
  const n = w * h;
  // seed pixels (brush disk)
  const seeds: number[] = [];
  const rr = Math.max(0.5, r), r2 = rr * rr;
  const sy0 = Math.max(y0, Math.floor(cy - rr)), sy1 = Math.min(y1 - 1, Math.ceil(cy + rr));
  const sx0 = Math.max(x0, Math.floor(cx - rr)), sx1 = Math.min(x1 - 1, Math.ceil(cx + rr));
  for (let y = sy0; y <= sy1; y++) for (let x = sx0; x <= sx1; x++) if ((x + 0.5 - cx) ** 2 + (y + 0.5 - cy) ** 2 <= r2) seeds.push((y - y0) * w + (x - x0));
  if (!seeds.length) { const sx = Math.min(x1 - 1, Math.max(x0, Math.floor(cx))), sy = Math.min(y1 - 1, Math.max(y0, Math.floor(cy))); seeds.push((sy - y0) * w + sx - x0); }
  // colour model from seeds (subsampled)
  const R = new Float32Array(n), G = new Float32Array(n), B = new Float32Array(n), gr = new Float32Array(n);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x, j = ((y + y0) * W + x + x0) * 4;
    R[i] = d[j]; G[i] = d[j + 1]; B[i] = d[j + 2]; gr[i] = grad[(y + y0) * W + x + x0];
  }
  const sample = seeds.length > 600 ? seeds.filter((_, k) => k % Math.ceil(seeds.length / 600) === 0) : seeds;
  const cent = kmeans3(R, G, B, sample, 3, 6);
  let spread = 0;
  const dmin = (i: number) => { let b = Infinity; for (const c of cent) { const a0 = R[i] - c[0], a1 = G[i] - c[1], a2 = B[i] - c[2]; const v = a0 * a0 + a1 * a1 + a2 * a2; if (v < b) b = v; } return Math.sqrt(b); };
  for (const i of sample) spread += dmin(i);
  spread /= sample.length;
  const T = Math.min(70, Math.max(26, 20 + spread * 1.6));
  // gradient threshold from seed texture
  const gs = sample.map(i => gr[i]).sort((a, b) => a - b);
  const gT = Math.max(0.11, (gs[Math.floor(gs.length * 0.9)] || 0) * 1.6);
  const mask = new Uint8Array(n), q = new Int32Array(n);
  let head = 0, tail = 0;
  for (const s of seeds) if (!mask[s]) { mask[s] = 255; q[tail++] = s; }
  while (head < tail) {
    const i = q[head++], x = i % w;
    const nb = [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, i >= w ? i - w : -1, i < n - w ? i + w : -1];
    for (const j of nb) {
      if (j < 0 || mask[j]) continue;
      if (gr[j] > gT || dmin(j) > T) continue;
      mask[j] = 255; q[tail++] = j;
    }
  }
  const cleaned = fillHoles(smoothMask(mask, w, h, 1, false), w, h, Math.max(16, r2));
  return { x: x0, y: y0, w, h, mask: cleaned };
}

// ------------------------------------------------------------------ live wire (Magnetic Lasso)
/** Intelligent-scissors path finder in a square window around a seed (8-connected Dijkstra on an edge cost). */
export class LiveWire {
  readonly x0: number; readonly y0: number; readonly w: number; readonly h: number;
  private cost: Float32Array; private dist: Float32Array; private prev: Int32Array;
  readonly grad: Float32Array;
  constructor(d: Uint8ClampedArray, W: number, H: number, seedX: number, seedY: number, radius: number, contrast: number) {
    this.x0 = Math.max(0, Math.floor(seedX - radius)); this.y0 = Math.max(0, Math.floor(seedY - radius));
    const x1 = Math.min(W, Math.ceil(seedX + radius + 1)), y1 = Math.min(H, Math.ceil(seedY + radius + 1));
    this.w = Math.max(1, x1 - this.x0); this.h = Math.max(1, y1 - this.y0);
    const n = this.w * this.h;
    // local image copy → gradient
    const sub = new Uint8ClampedArray(n * 4);
    for (let y = 0; y < this.h; y++) sub.set(d.subarray(((y + this.y0) * W + this.x0) * 4, ((y + this.y0) * W + this.x0 + this.w) * 4), y * this.w * 4);
    const g = gradientMagnitude(sub, this.w, this.h);
    this.grad = g;
    let gmax = 0.08;
    for (let i = 0; i < n; i++) if (g[i] > gmax) gmax = g[i];
    const c = new Float32Array(n);
    const thr = contrast * gmax * 0.9;
    for (let i = 0; i < n; i++) { const e = g[i] < thr ? 0 : g[i] / gmax; c[i] = 0.06 + (1 - e) * (1 - e); }
    this.cost = c;
    this.dist = new Float32Array(n).fill(Infinity);
    this.prev = new Int32Array(n).fill(-1);
    const sx = Math.min(this.w - 1, Math.max(0, Math.round(seedX) - this.x0)), sy = Math.min(this.h - 1, Math.max(0, Math.round(seedY) - this.y0));
    this.run(sy * this.w + sx);
  }
  private run(seed: number) {
    const w = this.w, h = this.h, dist = this.dist, prev = this.prev, cost = this.cost;
    let cap = 1 << 16, hk = new Float32Array(cap), hv = new Int32Array(cap), size = 0;
    const push = (k: number, v: number) => {
      if (size >= cap) { cap *= 2; const a = new Float32Array(cap), b = new Int32Array(cap); a.set(hk); b.set(hv); hk = a; hv = b; }
      let i = size++;
      while (i > 0) { const p = (i - 1) >> 1; if (hk[p] <= k) break; hk[i] = hk[p]; hv[i] = hv[p]; i = p; }
      hk[i] = k; hv[i] = v;
    };
    const pop = () => {
      const v = hv[0], lk = hk[--size], lv = hv[size];
      let i = 0;
      for (;;) { let c = 2 * i + 1; if (c >= size) break; if (c + 1 < size && hk[c + 1] < hk[c]) c++; if (hk[c] >= lk) break; hk[i] = hk[c]; hv[i] = hv[c]; i = c; }
      hk[i] = lk; hv[i] = lv;
      return v;
    };
    dist[seed] = 0; push(0, seed);
    const done = new Uint8Array(w * h);
    while (size) {
      const k0 = hk[0], i = pop();
      if (done[i] || k0 > dist[i]) continue;
      done[i] = 1;
      const x = i % w, y = (i / w) | 0;
      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy; if (ny < 0 || ny >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const nx = x + dx; if (nx < 0 || nx >= w) continue;
          const j = ny * w + nx;
          if (done[j]) continue;
          const nd = dist[i] + cost[j] * (dx && dy ? 1.4142 : 1);
          if (nd < dist[j]) { dist[j] = nd; prev[j] = i; push(nd, j); }
        }
      }
    }
  }
  contains(x: number, y: number) { return x >= this.x0 && y >= this.y0 && x < this.x0 + this.w && y < this.y0 + this.h; }
  /** Strongest edge within `radius` px of (x, y) (doc coords, pixel centres). */
  snap(x: number, y: number, radius: number): { x: number; y: number } {
    const cx = Math.round(x) - this.x0, cy = Math.round(y) - this.y0, r = Math.max(0, Math.round(radius));
    let best = -1, bx = cx, by = cy;
    for (let yy = Math.max(0, cy - r); yy <= Math.min(this.h - 1, cy + r); yy++)
      for (let xx = Math.max(0, cx - r); xx <= Math.min(this.w - 1, cx + r); xx++) {
        if ((xx - cx) ** 2 + (yy - cy) ** 2 > r * r) continue;
        const g = this.grad[yy * this.w + xx] - ((xx - cx) ** 2 + (yy - cy) ** 2) * 1e-4;
        if (g > best) { best = g; bx = xx; by = yy; }
      }
    return { x: Math.min(this.w - 1, Math.max(0, bx)) + this.x0, y: Math.min(this.h - 1, Math.max(0, by)) + this.y0 };
  }
  /** Path from the seed to (x, y) in doc coords (pixel centres), seed first. */
  path(x: number, y: number): { x: number; y: number }[] {
    const lx = Math.min(this.w - 1, Math.max(0, Math.round(x) - this.x0)), ly = Math.min(this.h - 1, Math.max(0, Math.round(y) - this.y0));
    const out: { x: number; y: number }[] = [];
    let i = ly * this.w + lx, guard = 0;
    while (i >= 0 && guard++ < this.w * this.h) { out.push({ x: (i % this.w) + this.x0 + 0.5, y: ((i / this.w) | 0) + this.y0 + 0.5 }); i = this.prev[i]; }
    return out.reverse();
  }
}

// ------------------------------------------------------------------ focus measure (Focus Area)
/** Local sharpness: variance of the Laplacian in a window, log-normalised 0..1. */
export function focusMap(d: Uint8ClampedArray, w: number, h: number, radius: number): Float32Array {
  const n = w * h, L = new Float32Array(n), lap = new Float32Array(n);
  for (let i = 0, j = 0; i < n; i++, j += 4) L[i] = 0.299 * d[j] + 0.587 * d[j + 1] + 0.114 * d[j + 2];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x, c = L[i];
    const l = x > 0 ? L[i - 1] : c, r = x < w - 1 ? L[i + 1] : c, t = y > 0 ? L[i - w] : c, b = y < h - 1 ? L[i + w] : c;
    const v = l + r + t + b - 4 * c;
    lap[i] = v * v;
  }
  const m = boxBlur(lap, w, h, radius);
  const out = new Float32Array(n);
  let mx = 0;
  for (let i = 0; i < n; i++) { const v = Math.log1p(m[i]); out[i] = v; if (v > mx) mx = v; }
  if (mx > 0) for (let i = 0; i < n; i++) out[i] /= mx;
  return out;
}

// ------------------------------------------------------------------ resampling
/** Bilinear resize of a float map (pixel-centre aligned). */
export function resizeFloat(p: Float32Array, pw: number, ph: number, W: number, H: number): Float32Array {
  const out = new Float32Array(W * H), sx = pw / W, sy = ph / H;
  for (let y = 0; y < H; y++) {
    let fy = (y + 0.5) * sy - 0.5; if (fy < 0) fy = 0;
    const y0 = Math.min(ph - 1, fy | 0), y1 = Math.min(ph - 1, y0 + 1), ty = fy - y0;
    for (let x = 0; x < W; x++) {
      let fx = (x + 0.5) * sx - 0.5; if (fx < 0) fx = 0;
      const x0 = Math.min(pw - 1, fx | 0), x1 = Math.min(pw - 1, x0 + 1), tx = fx - x0;
      const a = p[y0 * pw + x0], b = p[y0 * pw + x1], c = p[y1 * pw + x0], d = p[y1 * pw + x1];
      out[y * W + x] = (a + (b - a) * tx) * (1 - ty) + (c + (d - c) * tx) * ty;
    }
  }
  return out;
}

/**
 * Edge refinement of a full-resolution soft mask with the colour guided filter, processed in tiles and only where
 * the mask has an edge (keeps memory bounded and skips flat areas). Returns a new array.
 */
export function refineEdges(d: Uint8ClampedArray, W: number, H: number, p: Float32Array, r: number, eps: number, tile = 256): Float32Array {
  const out = p.slice();
  const o = 2 * r + 2;
  for (let ty = 0; ty < H; ty += tile) for (let tx = 0; tx < W; tx += tile) {
    const x0 = Math.max(0, tx - o), y0 = Math.max(0, ty - o), x1 = Math.min(W, tx + tile + o), y1 = Math.min(H, ty + tile + o);
    let mn = 1, mx = 0;
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { const v = p[y * W + x]; if (v < mn) mn = v; if (v > mx) mx = v; }
    if (mx - mn < 0.02) continue;
    const w = x1 - x0, h = y1 - y0, sub = new Uint8ClampedArray(w * h * 4), sp = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
      sub.set(d.subarray(((y + y0) * W + x0) * 4, ((y + y0) * W + x1) * 4), y * w * 4);
      sp.set(p.subarray((y + y0) * W + x0, (y + y0) * W + x1), y * w);
    }
    const q = guidedFilter(sub, sp, w, h, r, eps);
    const ix1 = Math.min(W, tx + tile), iy1 = Math.min(H, ty + tile);
    for (let y = ty; y < iy1; y++) for (let x = tx; x < ix1; x++) out[y * W + x] = q[(y - y0) * w + x - x0];
  }
  return out;
}
