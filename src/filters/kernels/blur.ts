// Blur and Blur Gallery kernels.
import {
  type Kernel, type Meta, type KRect, clamp, cloneImage, crop, paste, fromPlanes, gaussian, gaussPlanes, onRegion, rng, gaussRand,
  toPlanes, boxBlurPlane, variableBlur, workRect, lumaPlane, fastGaussPlanes, premul, tap, putAcc,
} from './core';

const avgInSelection: Kernel = (img, _p, m) => {
  const r = workRect(img, m), d = img.data, mask: Uint8Array | null = m.aux?.selMask || null;
  let R = 0, G = 0, B = 0, A = 0, N = 0;
  for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) {
    const i = y * img.width + x, w = mask ? mask[i] / 255 : 1;
    if (!w) continue;
    const a = d[i * 4 + 3] * w;
    R += d[i * 4] * a; G += d[i * 4 + 1] * a; B += d[i * 4 + 2] * a; A += a; N += w;
  }
  if (!A) return img;
  const cr = R / A, cg = G / A, cb = B / A, ca = A / N;
  for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) { const i = (y * img.width + x) * 4; d[i] = cr; d[i + 1] = cg; d[i + 2] = cb; d[i + 3] = ca; }
  return img;
};

const boxBlur: Kernel = (img, p, m) => onRegion(img, m, Math.ceil(p.radius) + 2, sub => {
  const P = toPlanes(sub);
  for (const c of P.c) boxBlurPlane(c, P.w, P.h, p.radius, p.radius);
  return fromPlanes(P, sub);
});
const gaussBlur: Kernel = (img, p, m) => onRegion(img, m, Math.ceil(p.radius * 3) + 2, sub => (p.radius >= 12 ? fromPlanes(fastGaussPlanes(toPlanes(sub), p.radius), sub) : gaussian(sub, p.radius)));

// ------------------------------------------------------------------ motion / radial / spin
/** Blur along a direction (line integral of `len` px, sampled with bilinear taps). */
function lineBlur(src: ImageData, dst: ImageData, r: KRect, dirAt: (x: number, y: number) => [number, number, number], preview = false) {
  const d = dst.data, cap = preview ? 24 : 64, P = premul(src), W = src.width, H = src.height, acc = new Float64Array(4);
  for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) {
    const [dx, dy, len] = dirAt(x + 0.5, y + 0.5);
    const n = Math.max(1, Math.min(cap, Math.ceil(len / 1.5)));
    for (let k = 0; k <= n; k++) { const t = k / n - 0.5; tap(P, W, H, x + 0.5 + dx * len * t, y + 0.5 + dy * len * t, acc); }
    putAcc(d, (y * dst.width + x) * 4, acc, n + 1);
  }
}
const motionBlur: Kernel = (img, p, m) => onRegion(img, m, Math.ceil(p.distance) + 2, sub => {
  const a = (-p.angle * Math.PI) / 180, dx = Math.cos(a), dy = Math.sin(a), src = cloneImage(sub);
  lineBlur(src, sub, { x: 0, y: 0, w: sub.width, h: sub.height }, () => [dx, dy, p.distance], m.preview);
  if (p.distance > 96) return gaussian(sub, (p.distance / 96) * 0.6);
  return sub;
});
const radialBlur: Kernel = (img, p, m) => {
  const r = workRect(img, m), P = premul(img), W = img.width, H = img.height, acc = new Float64Array(4);
  const cx = r.x + r.w * (p.cx / 100), cy = r.y + r.h * (p.cy / 100);
  const maxTaps = Math.min(m.preview ? 16 : 128, p.quality === 'draft' ? 12 : p.quality === 'good' ? 40 : 96);
  const d = img.data, amt = p.amount / 100, spin = p.method === 'spin';
  // rotation tables per tap count (spin): cos/sin of each tap angle
  const trig: Float64Array[] = [];
  if (spin) for (let n = 0; n <= maxTaps; n++) { const t = new Float64Array((n + 1) * 2); for (let k = 0; k <= n; k++) { const a = (n ? k / n - 0.5 : 0) * amt * 0.7; t[k * 2] = Math.cos(a); t[k * 2 + 1] = Math.sin(a); } trig.push(t); }
  for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) {
    const vx = x + 0.5 - cx, vy = y + 0.5 - cy;
    const taps = Math.max(2, Math.min(maxTaps, Math.ceil((Math.hypot(vx, vy) * amt * (spin ? 0.7 : 0.6)) / 1.5)));
    for (let k = 0; k <= taps; k++) {
      const t = k / taps - 0.5;
      if (spin) { const tb = trig[taps], c = tb[k * 2], s2 = tb[k * 2 + 1]; tap(P, W, H, cx + vx * c - vy * s2, cy + vx * s2 + vy * c, acc); }
      else { const f = 1 + t * amt * 0.6; tap(P, W, H, cx + vx * f, cy + vy * f, acc); }
    }
    putAcc(d, (y * W + x) * 4, acc, taps + 1);
  }
  return img;
};

// ------------------------------------------------------------------ shape / lens (polygon kernel via row spans)
type Spans = { dy: number; runs: [number, number][] }[];
function polygonSpans(radius: number, sides: number, rotation: number, curvature: number): Spans {
  const r = Math.max(0.5, radius), out: Spans = [], R = Math.ceil(r);
  const inside = (x: number, y: number) => {
    const d = Math.hypot(x, y);
    if (d > r) return false;
    if (sides < 3) return true;
    const a = Math.atan2(y, x) - rotation, seg = (2 * Math.PI) / sides;
    const t = ((a % seg) + seg) % seg - seg / 2;
    const poly = (r * Math.cos(seg / 2)) / Math.cos(t);
    return d <= poly + (r - poly) * curvature;
  };
  for (let dy = -R; dy <= R; dy++) {
    const runs: [number, number][] = [];
    let start = -9999;
    for (let dx = -R; dx <= R + 1; dx++) {
      const inn = dx <= R && inside(dx, dy);
      if (inn && start === -9999) start = dx;
      if (!inn && start !== -9999) { runs.push([start, dx - 1]); start = -9999; }
    }
    if (runs.length) out.push({ dy, runs });
  }
  return out;
}
export function spanSpans(mask: Uint8Array, size: number): Spans {
  const out: Spans = [], c = size >> 1;
  for (let y = 0; y < size; y++) {
    const runs: [number, number][] = [];
    let start = -1;
    for (let x = 0; x <= size; x++) {
      const inn = x < size && mask[y * size + x] > 127;
      if (inn && start < 0) start = x;
      if (!inn && start >= 0) { runs.push([start - c, x - 1 - c]); start = -1; }
    }
    if (runs.length) out.push({ dy: y - c, runs });
  }
  return out;
}
/** Convolve premultiplied planes with a flat kernel given as row spans (clamped edges, prefix sums per row). */
function spanConvolve(planes: Float32Array[], W: number, H: number, spans: Spans): Float32Array[] {
  let area = 0, R = 0;
  for (const s of spans) for (const [a, b] of s.runs) { area += b - a + 1; R = Math.max(R, -a, b); }
  const EW = W + 2 * R;
  return planes.map(src => {
    const out = new Float32Array(W * H);
    const rows: Float64Array[] = [];
    for (let y = 0; y < H; y++) {
      const pr = new Float64Array(EW + 1), o = y * W;
      for (let x = 0; x < EW; x++) { const sx = x - R; pr[x + 1] = pr[x] + src[o + (sx < 0 ? 0 : sx >= W ? W - 1 : sx)]; }
      rows.push(pr);
    }
    for (let y = 0; y < H; y++) {
      const o = y * W;
      for (const s of spans) {
        const sy = y + s.dy, pr = rows[sy < 0 ? 0 : sy >= H ? H - 1 : sy];
        for (const [a, b] of s.runs) { const A = R + a, B = R + b + 1; for (let x = 0; x < W; x++) out[o + x] += pr[x + B] - pr[x + A]; }
      }
      for (let x = 0; x < W; x++) out[o + x] /= area;
    }
    return out;
  });
}
const shapeBlur: Kernel = (img, p, m) => {
  const size = Math.max(3, Math.round(p.radius) * 2 + 1), mask: Uint8Array | null = m.aux?.shapeMask ? scaleMask(m.aux.shapeMask, m.aux.shapeSize, size) : null;
  const spans = mask ? spanSpans(mask, size) : polygonSpans(p.radius, 0, 0, 1);
  return onRegion(img, m, size, sub => { const P = toPlanes(sub); P.c = spanConvolve(P.c, P.w, P.h, spans); return fromPlanes(P, sub); });
};
function scaleMask(src: Uint8Array, ss: number, size: number): Uint8Array {
  const out = new Uint8Array(size * size);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) out[y * size + x] = src[Math.floor((y / size) * ss) * ss + Math.floor((x / size) * ss)];
  return out;
}
const IRIS: Record<string, number> = { triangle: 3, square: 4, pentagon: 5, hexagon: 6, heptagon: 7, octagon: 8 };
const lensBlur: Kernel = (img, p, m) => {
  const r = workRect(img, m, Math.ceil(p.radius) + 2);
  const sub = crop(img, r);
  const W = sub.width, H = sub.height, n = W * H;
  // work in (approximately) linear light so bright highlights bloom like real bokeh
  const P = toPlanes(sub);
  const thr = p.threshold, boost = p.brightness / 100;
  for (let i = 0; i < n; i++) {
    const a = P.c[3][i] / 255 || 1e-6;
    let mx = 0;
    for (let c = 0; c < 3; c++) { const v = P.c[c][i] / a; if (v > mx) mx = v; }
    const spec = boost > 0 && mx >= thr ? 1 + boost * 8 * ((mx - thr + 1) / (256 - thr)) : 1;
    for (let c = 0; c < 3; c++) { const v = P.c[c][i] / a / 255; P.c[c][i] = Math.pow(v, 2.2) * 255 * a * spec; }
  }
  const spans = polygonSpans(p.radius, IRIS[p.shape] || 6, (p.rotation * Math.PI) / 180, p.curvature / 100);
  const full = spanConvolve(P.c, W, H, spans);
  let res = full;
  const depth: Uint8Array | null = m.aux?.depth || null;
  if (depth) {
    // depth map: blend between sharp and full-radius results by |depth - focal| (invert flips near/far)
    res = P.c.map((c, ci) => {
      const o = new Float32Array(n);
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const i = y * W + x;
        let dv = depth[(y + r.y) * img.width + x + r.x];
        if (p.invert) dv = 255 - dv;
        const t = Math.min(1, (Math.abs(dv - p.focal) / 255) * 1.6);
        o[i] = c[i] * (1 - t) + full[ci][i] * t;
      }
      return o;
    });
  }
  const R = rng(m.seed), amt = p.noise;
  for (let i = 0; i < n; i++) {
    const a = res[3][i] / 255 || 1e-6;
    const nz = amt > 0 && p.mono ? (p.dist === 'gaussian' ? gaussRand(R) * 0.5 : R() - 0.5) * amt * 2 : 0;
    for (let c = 0; c < 3; c++) {
      const v = Math.min(1, res[c][i] / a / 255);
      let o = Math.pow(v, 1 / 2.2) * 255;
      if (amt > 0) o += p.mono ? nz : (p.dist === 'gaussian' ? gaussRand(R) * 0.5 : R() - 0.5) * amt * 2;
      res[c][i] = clamp(o) * a;
    }
  }
  paste(img, fromPlanes({ w: W, h: H, c: res }), r.x, r.y);
  return img;
};

// ------------------------------------------------------------------ smart / surface blur (edge preserving)
function edgePreserving(img: ImageData, m: Meta, radius: number, threshold: number, weightFn: (diff: number) => number, mode: 'normal' | 'edge' | 'overlay' = 'normal'): ImageData {
  return onRegion(img, m, Math.ceil(radius) + 1, sub => {
    const W = sub.width, H = sub.height, s = sub.data, out = new Uint8ClampedArray(s);
    const r = Math.max(1, Math.round(radius)), step = r >= 4 ? Math.max(1, Math.ceil(r / (m.preview ? 2.5 : 3.5))) : 1;
    const lum = mode !== 'normal' ? lumaPlane(sub) : null;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      let R = 0, G = 0, B = 0, A = 0, wsum = 0;
      for (let dy = -r; dy <= r; dy += step) {
        const yy = y + dy < 0 ? 0 : y + dy >= H ? H - 1 : y + dy;
        for (let dx = -r; dx <= r; dx += step) {
          const xx = x + dx < 0 ? 0 : x + dx >= W ? W - 1 : x + dx, q = (yy * W + xx) * 4;
          const diff = Math.max(Math.abs(s[q] - s[i]), Math.abs(s[q + 1] - s[i + 1]), Math.abs(s[q + 2] - s[i + 2]));
          const w = weightFn(diff);
          if (w <= 0) continue;
          R += s[q] * w; G += s[q + 1] * w; B += s[q + 2] * w; A += s[q + 3] * w; wsum += w;
        }
      }
      if (wsum > 0) { out[i] = R / wsum; out[i + 1] = G / wsum; out[i + 2] = B / wsum; out[i + 3] = A / wsum; }
    }
    if (mode !== 'normal' && lum) {
      // edges: where the local change exceeds the threshold
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const i = y * W + x, gx = lum[y * W + Math.min(W - 1, x + 1)] - lum[i], gy = lum[Math.min(H - 1, y + 1) * W + x] - lum[i];
        const edge = Math.hypot(gx, gy) > threshold * 0.5;
        const o = i * 4;
        if (mode === 'edge') { const v = edge ? 255 : 0; out[o] = out[o + 1] = out[o + 2] = v; out[o + 3] = 255; }
        else if (edge) { out[o] = out[o + 1] = out[o + 2] = 255; }
      }
    }
    sub.data.set(out);
    return sub;
  });
}
const smartBlur: Kernel = (img, p, m) => {
  const q = p.quality === 'low' ? 0.5 : p.quality === 'high' ? 1.5 : 1;
  return edgePreserving(img, m, p.radius * (m.preview ? 1 : 1), p.threshold, d => (d <= p.threshold * q ? 1 : 0), p.mode);
};
const surfaceBlur: Kernel = (img, p, m) => edgePreserving(img, m, p.radius, p.threshold, d => Math.max(0, 1 - d / (2.5 * Math.max(1, p.threshold))));

// ------------------------------------------------------------------ Blur Gallery
function ellipseT(x: number, y: number, p: any, r: KRect): number {
  // 0 inside the sharp core, 1 outside the ellipse, smooth in between
  const cx = r.x + (p.cx / 100) * r.w, cy = r.y + (p.cy / 100) * r.h, a = (p.rot * Math.PI) / 180;
  const dx = x - cx, dy = y - cy, u = (dx * Math.cos(a) + dy * Math.sin(a)) / Math.max(1, (p.rx / 100) * r.w), v = (-dx * Math.sin(a) + dy * Math.cos(a)) / Math.max(1, (p.ry / 100) * r.h);
  const d = Math.sqrt(u * u + v * v), f = p.feather / 100;
  return d <= f ? 0 : d >= 1 ? 1 : ((d - f) / (1 - f)) ** 2 * (3 - 2 * (d - f) / (1 - f));
}
function bokehBoost(img: ImageData, p: any) {
  if (!p.bokeh) return;
  const d = img.data, k = p.bokeh / 100, thr = 255 - p.bokehRange * 2.2;
  for (let i = 0; i < d.length; i += 4) { const mx = Math.max(d[i], d[i + 1], d[i + 2]); if (mx > thr) { const f = 1 + k * 2 * ((mx - thr) / (256 - thr)); d[i] = clamp(d[i] * f); d[i + 1] = clamp(d[i + 1] * f); d[i + 2] = clamp(d[i + 2] * f); } }
}
function galleryNoise(img: ImageData, p: any, m: Meta) {
  if (!p.noise) return;
  const R = rng(m.seed), d = img.data;
  for (let i = 0; i < d.length; i += 4) { const nz = (R() - 0.5) * p.noise * 2.5; d[i] = clamp(d[i] + nz); d[i + 1] = clamp(d[i + 1] + nz); d[i + 2] = clamp(d[i + 2] + nz); }
}
const fieldBlur: Kernel = (img, p, m) => {
  const r = workRect(img, m), W = img.width, H = img.height, pins: { x: number; y: number; blur: number }[] = p.pins?.length ? p.pins : [{ x: 50, y: 50, blur: p.blur ?? 15 }];
  const sig = new Float32Array(W * H);
  let mx = 0;
  const G = 8, gw = Math.ceil(W / G) + 1, gh = Math.ceil(H / G) + 1, grid = new Float32Array(gw * gh);
  for (let gy = 0; gy < gh; gy++) for (let gx = 0; gx < gw; gx++) {
    let ws = 0, v = 0;
    for (const pin of pins) { const px = r.x + (pin.x / 100) * r.w, py = r.y + (pin.y / 100) * r.h, d2 = (gx * G - px) ** 2 + (gy * G - py) ** 2 + 1; const w = 1 / (d2 * d2); ws += w; v += w * pin.blur; }
    grid[gy * gw + gx] = v / ws;
  }
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const fx = x / G, fy = y / G, x0 = Math.floor(fx), y0 = Math.floor(fy), tx = fx - x0, ty = fy - y0;
    const v = grid[y0 * gw + x0] * (1 - tx) * (1 - ty) + grid[y0 * gw + x0 + 1] * tx * (1 - ty) + grid[(y0 + 1) * gw + x0] * (1 - tx) * ty + grid[(y0 + 1) * gw + x0 + 1] * tx * ty;
    sig[y * W + x] = v; if (v > mx) mx = v;
  }
  bokehBoost(img, p);
  variableBlur(img, sig, mx);
  galleryNoise(img, p, m);
  return img;
};
const irisBlur: Kernel = (img, p, m) => {
  const r = workRect(img, m), W = img.width, H = img.height, sig = new Float32Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) sig[y * W + x] = p.blur * ellipseT(x + 0.5, y + 0.5, p, r);
  bokehBoost(img, p);
  variableBlur(img, sig, p.blur);
  galleryNoise(img, p, m);
  return img;
};
const tiltShift: Kernel = (img, p, m) => {
  const r = workRect(img, m), W = img.width, H = img.height, sig = new Float32Array(W * H);
  const cx = r.x + (p.cx / 100) * r.w, cy = r.y + (p.cy / 100) * r.h, a = (p.angle * Math.PI) / 180, nx = -Math.sin(a), ny = Math.cos(a);
  const focus = (p.focus / 100) * r.h / 2, trans = Math.max(1, (p.transition / 100) * r.h / 2);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let d = (x + 0.5 - cx) * nx + (y + 0.5 - cy) * ny;
    if (!p.symmetric && d < 0) d = -d * 1;
    const ad = Math.abs(d), t = ad <= focus ? 0 : ad >= focus + trans ? 1 : (ad - focus) / trans;
    sig[y * W + x] = p.blur * t * t * (3 - 2 * t);
  }
  bokehBoost(img, p);
  variableBlur(img, sig, p.blur);
  galleryNoise(img, p, m);
  return img;
};
const spinBlur: Kernel = (img, p, m) => {
  const r = workRect(img, m), P = premul(img), W = img.width, H = img.height, d = img.data, acc = new Float64Array(4);
  const cx = r.x + (p.cx / 100) * r.w, cy = r.y + (p.cy / 100) * r.h, amt = (p.angle * Math.PI) / 180;
  const maxTaps = m.preview ? 20 : 72, q = { ...p, feather: 100 - p.feather };
  for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) {
    const t = 1 - ellipseT(x + 0.5, y + 0.5, q, r);
    if (t <= 0) continue;
    const vx = x + 0.5 - cx, vy = y + 0.5 - cy;
    const taps = Math.max(2, Math.min(maxTaps, Math.ceil((Math.hypot(vx, vy) * amt * t) / 1.5)));
    for (let k = 0; k <= taps; k++) { const ang = (k / taps - 0.5) * amt * t, c = Math.cos(ang), s2 = Math.sin(ang); tap(P, W, H, cx + vx * c - vy * s2, cy + vx * s2 + vy * c, acc); }
    putAcc(d, (y * W + x) * 4, acc, taps + 1);
  }
  return img;
};
/** Path Blur: motion blur following the direction of the nearest path segment (or a straight direction). */
const pathBlur: Kernel = (img, p, m) => {
  const r = workRect(img, m), src = cloneImage(img);
  const segs: number[][] = (m.aux?.segments || []).map((s: number[]) => [s[0] - m.x, s[1] - m.y, s[2] - m.x, s[3] - m.y]);
  if (!segs.length) { const a = (-p.angle * Math.PI) / 180, c = r.x + r.w / 2, cy = r.y + r.h / 2; segs.push([c - Math.cos(a) * 100, cy - Math.sin(a) * 100, c + Math.cos(a) * 100, cy + Math.sin(a) * 100]); }
  const G = 16, gw = Math.ceil(img.width / G) + 2, gh = Math.ceil(img.height / G) + 2, dirs = new Float32Array(gw * gh * 3);
  let total = 0;
  for (const s of segs) total += Math.hypot(s[2] - s[0], s[3] - s[1]);
  for (let gy = 0; gy < gh; gy++) for (let gx = 0; gx < gw; gx++) {
    const x = gx * G, y = gy * G;
    let best = Infinity, bx = 1, by = 0, along = 0, acc = 0, t0 = 0;
    for (const s of segs) {
      const vx = s[2] - s[0], vy = s[3] - s[1], L2 = vx * vx + vy * vy || 1, L = Math.sqrt(L2);
      const t = Math.max(0, Math.min(1, ((x - s[0]) * vx + (y - s[1]) * vy) / L2));
      const dd = (s[0] + vx * t - x) ** 2 + (s[1] + vy * t - y) ** 2;
      if (dd < best) { best = dd; bx = vx / L; by = vy / L; t0 = (acc + t * L) / (total || 1); }
      acc += L;
    }
    along = t0;
    const taper = p.taper / 100, len = p.speed * (1 - taper * Math.abs(along * 2 - 1)) * (p.centered ? 1 : 1);
    dirs[(gy * gw + gx) * 3] = bx; dirs[(gy * gw + gx) * 3 + 1] = by; dirs[(gy * gw + gx) * 3 + 2] = Math.max(0, len);
  }
  lineBlur(src, img, r, (x, y) => {
    const gx = Math.min(gw - 1, Math.round(x / G)), gy = Math.min(gh - 1, Math.round(y / G)), o = (gy * gw + gx) * 3;
    return [dirs[o], dirs[o + 1], dirs[o + 2]];
  }, m.preview);
  return img;
};

export const blurKernels: Record<string, Kernel> = {
  average: avgInSelection,
  blur: (img, _p, m) => onRegion(img, m, 4, sub => gaussian(sub, 0.7)),
  'blur-more': (img, _p, m) => onRegion(img, m, 8, sub => gaussian(sub, 1.6)),
  'box-blur': boxBlur,
  'gaussian-blur': gaussBlur,
  'lens-blur': lensBlur,
  'motion-blur': motionBlur,
  'radial-blur': radialBlur,
  'shape-blur': shapeBlur,
  'smart-blur': smartBlur,
  'surface-blur': surfaceBlur,
  'field-blur': fieldBlur,
  'iris-blur': irisBlur,
  'tilt-shift': tiltShift,
  'spin-blur': spinBlur,
  'path-blur': pathBlur,
};
export { gaussPlanes };
