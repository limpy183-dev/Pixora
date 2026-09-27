// Feature-based image alignment (shared by Auto-Align Layers, its worker and Photomerge-style blending):
// Harris corners → oriented, normalised patch descriptors → ratio-test matching → RANSAC fitting of
// translation / similarity / affine / homography models, plus focal length, vignetting and radial-distortion
// estimation from the inlier matches. Pure functions, no DOM.

export type M3 = number[];                                   // row-major 3×3
export const I3: M3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];
export type Model = 'translation' | 'similarity' | 'affine' | 'homography';
export interface Feats { n: number; x: Float32Array; y: Float32Array; d: Float32Array; lum: Float32Array }
export const DESC = 64;

// ------------------------------------------------------------------ matrices
export function mul3(a: M3, b: M3): M3 {
  const o = new Array(9).fill(0);
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) o[r * 3 + c] = a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c];
  return o;
}
export function inv3(m: M3): M3 | null {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g, det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-14) return null;
  return [A / det, -(b * i - c * h) / det, (b * f - c * e) / det, B / det, (a * i - c * g) / det, -(a * f - c * d) / det, C / det, -(a * h - b * g) / det, (a * e - b * d) / det];
}
export function apply3(m: M3, x: number, y: number): [number, number] {
  const w = m[6] * x + m[7] * y + m[8];
  return [(m[0] * x + m[1] * y + m[2]) / w, (m[3] * x + m[4] * y + m[5]) / w];
}
export const translate3 = (tx: number, ty: number): M3 => [1, 0, tx, 0, 1, ty, 0, 0, 1];
export const isAffine3 = (m: M3) => Math.abs(m[6]) < 1e-12 && Math.abs(m[7]) < 1e-12 && Math.abs(m[8] - 1) < 1e-9;
/** Solve A x = b (n×n, row-major) with partial pivoting. */
export function solve(A: number[], b: number[], n: number): number[] | null {
  const M = A.slice(), v = b.slice();
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r * n + c]) > Math.abs(M[p * n + c])) p = r;
    if (Math.abs(M[p * n + c]) < 1e-12) return null;
    if (p !== c) { for (let k = 0; k < n; k++) { const t = M[c * n + k]; M[c * n + k] = M[p * n + k]; M[p * n + k] = t; } const t = v[c]; v[c] = v[p]; v[p] = t; }
    for (let r = c + 1; r < n; r++) {
      const f = M[r * n + c] / M[c * n + c];
      if (!f) continue;
      for (let k = c; k < n; k++) M[r * n + k] -= f * M[c * n + k];
      v[r] -= f * v[c];
    }
  }
  const x = new Array(n).fill(0);
  for (let r = n - 1; r >= 0; r--) { let s = v[r]; for (let k = r + 1; k < n; k++) s -= M[r * n + k] * x[k]; x[r] = s / M[r * n + r]; }
  return x;
}

// ------------------------------------------------------------------ features
/** Grey (0–1) + validity mask from RGBA. */
export function grayOf(d: Uint8ClampedArray, w: number, h: number) {
  const g = new Float32Array(w * h), m = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) { g[i] = (0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2]) / 255; m[i] = d[i * 4 + 3] > 200 ? 1 : 0; }
  return { g, m };
}
function boxBlur(src: Float32Array, w: number, h: number, r: number) {
  const tmp = new Float32Array(w * h), out = new Float32Array(w * h), n = 2 * r + 1;
  for (let y = 0; y < h; y++) { let s = 0; const o = y * w; for (let x = -r; x <= r; x++) s += src[o + Math.min(w - 1, Math.max(0, x))]; for (let x = 0; x < w; x++) { tmp[o + x] = s / n; s += src[o + Math.min(w - 1, x + r + 1)] - src[o + Math.max(0, x - r)]; } }
  for (let x = 0; x < w; x++) { let s = 0; for (let y = -r; y <= r; y++) s += tmp[Math.min(h - 1, Math.max(0, y)) * w + x]; for (let y = 0; y < h; y++) { out[y * w + x] = s / n; s += tmp[Math.min(h - 1, y + r + 1) * w + x] - tmp[Math.max(0, y - r) * w + x]; } }
  return out;
}
const bil = (g: Float32Array, w: number, h: number, x: number, y: number) => {
  x = Math.max(0, Math.min(w - 1.001, x)); y = Math.max(0, Math.min(h - 1.001, y));
  const x0 = x | 0, y0 = y | 0, fx = x - x0, fy = y - y0, i = y0 * w + x0;
  return (g[i] * (1 - fx) + g[i + 1] * fx) * (1 - fy) + (g[i + w] * (1 - fx) + g[i + w + 1] * fx) * fy;
};
/** Harris corners spread over the image, then oriented 8×8 patch descriptors (zero mean, unit norm). */
export function features(g: Float32Array, m: Uint8Array, w: number, h: number, max = 700): Feats {
  const Ix = new Float32Array(w * h), Iy = new Float32Array(w * h);
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x;
    Ix[i] = (g[i - w + 1] + 2 * g[i + 1] + g[i + w + 1] - g[i - w - 1] - 2 * g[i - 1] - g[i + w - 1]) / 8;
    Iy[i] = (g[i + w - 1] + 2 * g[i + w] + g[i + w + 1] - g[i - w - 1] - 2 * g[i - w] - g[i - w + 1]) / 8;
  }
  const xx = new Float32Array(w * h), yy = new Float32Array(w * h), xy = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) { xx[i] = Ix[i] * Ix[i]; yy[i] = Iy[i] * Iy[i]; xy[i] = Ix[i] * Iy[i]; }
  const A = boxBlur(xx, w, h, 2), B = boxBlur(yy, w, h, 2), C = boxBlur(xy, w, h, 2);
  const R = new Float32Array(w * h), B0 = 14;
  for (let y = B0; y < h - B0; y++) for (let x = B0; x < w - B0; x++) {
    const i = y * w + x;
    if (!m[i] || !m[i - 12] || !m[i + 12] || !m[i - 12 * w] || !m[i + 12 * w]) continue;
    const a = A[i], b = B[i], c = C[i];
    R[i] = a * b - c * c - 0.04 * (a + b) * (a + b);
  }
  // non-maximum suppression (5×5) + per-cell quota so features cover the whole frame
  const cands: { i: number; r: number }[] = [];
  for (let y = B0; y < h - B0; y++) for (let x = B0; x < w - B0; x++) {
    const i = y * w + x, r = R[i];
    if (r <= 1e-7) continue;
    let ok = true;
    for (let dy = -2; dy <= 2 && ok; dy++) for (let dx = -2; dx <= 2; dx++) if ((dx || dy) && R[i + dy * w + dx] > r) { ok = false; break; }
    if (ok) cands.push({ i, r });
  }
  cands.sort((a, b) => b.r - a.r);
  const G = 8, quota = Math.ceil((max / (G * G)) * 2), cells = new Int32Array(G * G), pick: number[] = [];
  for (const c of cands) {
    const x = c.i % w, y = (c.i / w) | 0, k = Math.min(G - 1, ((y / h) * G) | 0) * G + Math.min(G - 1, ((x / w) * G) | 0);
    if (cells[k] >= quota) continue;
    cells[k]++; pick.push(c.i);
    if (pick.length >= max) break;
  }
  const sm = boxBlur(g, w, h, 1);
  const n = pick.length, fx = new Float32Array(n), fy = new Float32Array(n), d = new Float32Array(n * DESC), lum = new Float32Array(n);
  for (let k = 0; k < n; k++) {
    const x = pick[k] % w, y = (pick[k] / w) | 0;
    fx[k] = x; fy[k] = y;
    // orientation from the intensity centroid (radius 10)
    let m01 = 0, m10 = 0, L = 0;
    for (let dy = -10; dy <= 10; dy++) for (let dx = -10; dx <= 10; dx++) { if (dx * dx + dy * dy > 100) continue; const v = sm[(y + dy) * w + x + dx]; m10 += dx * v; m01 += dy * v; }
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) L += g[(y + dy) * w + x + dx];
    lum[k] = L / 25;
    const a = Math.atan2(m01, m10), ca = Math.cos(a), sa = Math.sin(a);
    let mean = 0;
    const o = k * DESC;
    for (let j = 0; j < 8; j++) for (let i = 0; i < 8; i++) {
      const u = (i - 3.5) * 1.6, v = (j - 3.5) * 1.6;
      const val = bil(sm, w, h, x + u * ca - v * sa, y + u * sa + v * ca);
      d[o + j * 8 + i] = val; mean += val;
    }
    mean /= DESC;
    let nrm = 0;
    for (let i = 0; i < DESC; i++) { d[o + i] -= mean; nrm += d[o + i] * d[o + i]; }
    nrm = Math.sqrt(nrm) || 1;
    for (let i = 0; i < DESC; i++) d[o + i] /= nrm;
  }
  return { n, x: fx, y: fy, d, lum };
}
/** Mutual nearest neighbours passing Lowe's ratio test. Returns index pairs [ia, ib]. */
export function match(a: Feats, b: Feats, ratio = 0.82): [number, number][] {
  const best = (P: Feats, Q: Feats) => {
    const out = new Int32Array(P.n).fill(-1);
    for (let i = 0; i < P.n; i++) {
      let b1 = Infinity, b2 = Infinity, bi = -1;
      const o = i * DESC;
      for (let j = 0; j < Q.n; j++) {
        const p = j * DESC;
        let s = 0;
        for (let k = 0; k < DESC; k++) { const t = P.d[o + k] - Q.d[p + k]; s += t * t; if (s > b2) break; }
        if (s < b1) { b2 = b1; b1 = s; bi = j; } else if (s < b2) b2 = s;
      }
      if (bi >= 0 && b1 < ratio * ratio * b2 && b1 < 0.6) out[i] = bi;
    }
    return out;
  };
  const ab = best(a, b), ba = best(b, a), res: [number, number][] = [];
  for (let i = 0; i < a.n; i++) if (ab[i] >= 0 && ba[ab[i]] === i) res.push([i, ab[i]]);
  return res;
}

// ------------------------------------------------------------------ model fitting
export type Pt = [number, number];
function fitMin(model: Model, P: Pt[], Q: Pt[]): M3 | null {
  if (model === 'translation') return translate3(Q[0][0] - P[0][0], Q[0][1] - P[0][1]);
  if (model === 'similarity') {
    const dx = P[1][0] - P[0][0], dy = P[1][1] - P[0][1], ex = Q[1][0] - Q[0][0], ey = Q[1][1] - Q[0][1], l = dx * dx + dy * dy;
    if (l < 1e-9) return null;
    const a = (ex * dx + ey * dy) / l, b = (ey * dx - ex * dy) / l;
    return [a, -b, Q[0][0] - a * P[0][0] + b * P[0][1], b, a, Q[0][1] - b * P[0][0] - a * P[0][1], 0, 0, 1];
  }
  return fitLS(model, P, Q);
}
/** Least-squares fit (homography with Hartley normalisation). */
export function fitLS(model: Model, P: Pt[], Q: Pt[]): M3 | null {
  const n = P.length;
  if (!n) return null;
  if (model === 'translation') { let tx = 0, ty = 0; for (let i = 0; i < n; i++) { tx += Q[i][0] - P[i][0]; ty += Q[i][1] - P[i][1]; } return translate3(tx / n, ty / n); }
  if (model === 'similarity') {
    if (n < 2) return fitLS('translation', P, Q);
    let px = 0, py = 0, qx = 0, qy = 0;
    for (let i = 0; i < n; i++) { px += P[i][0]; py += P[i][1]; qx += Q[i][0]; qy += Q[i][1]; }
    px /= n; py /= n; qx /= n; qy /= n;
    let sr = 0, si = 0, mu = 0;
    for (let i = 0; i < n; i++) { const ux = P[i][0] - px, uy = P[i][1] - py, tx = Q[i][0] - qx, ty = Q[i][1] - qy; sr += tx * ux + ty * uy; si += ty * ux - tx * uy; mu += ux * ux + uy * uy; }
    if (mu < 1e-9) return fitLS('translation', P, Q);
    const a = sr / mu, b = si / mu;
    return [a, -b, qx - a * px + b * py, b, a, qy - b * px - a * py, 0, 0, 1];
  }
  if (model === 'affine') {
    if (n < 3) return fitLS('similarity', P, Q);
    const N = [0, 0, 0, 0, 0, 0, 0, 0, 0], bx = [0, 0, 0], by = [0, 0, 0];
    for (let i = 0; i < n; i++) { const r = [P[i][0], P[i][1], 1]; for (let a = 0; a < 3; a++) { for (let b = 0; b < 3; b++) N[a * 3 + b] += r[a] * r[b]; bx[a] += r[a] * Q[i][0]; by[a] += r[a] * Q[i][1]; } }
    const X = solve(N, bx, 3), Y = solve(N, by, 3);
    return X && Y ? [X[0], X[1], X[2], Y[0], Y[1], Y[2], 0, 0, 1] : null;
  }
  if (n < 4) return fitLS('affine', P, Q);
  const norm = (S: Pt[]) => {
    let cx = 0, cy = 0; for (const p of S) { cx += p[0]; cy += p[1]; } cx /= S.length; cy /= S.length;
    let d = 0; for (const p of S) d += Math.hypot(p[0] - cx, p[1] - cy); d = d / S.length || 1;
    const s = Math.SQRT2 / d;
    return { T: [s, 0, -s * cx, 0, s, -s * cy, 0, 0, 1] as M3, pts: S.map(p => [(p[0] - cx) * s, (p[1] - cy) * s] as Pt) };
  };
  const A = norm(P), B = norm(Q);
  const N = new Array(64).fill(0), v = new Array(8).fill(0);
  const add = (r: number[], b: number) => { for (let i = 0; i < 8; i++) { v[i] += r[i] * b; for (let j = 0; j < 8; j++) N[i * 8 + j] += r[i] * r[j]; } };
  for (let i = 0; i < n; i++) {
    const [x, y] = A.pts[i], [u, w] = B.pts[i];
    add([x, y, 1, 0, 0, 0, -u * x, -u * y], u);
    add([0, 0, 0, x, y, 1, -w * x, -w * y], w);
  }
  const hsol = solve(N, v, 8);
  if (!hsol) return null;
  const Hn = [...hsol, 1], Bi = inv3(B.T);
  if (!Bi) return null;
  const H = mul3(Bi, mul3(Hn, A.T));
  return H.map(x => x / H[8]);
}
const need: Record<Model, number> = { translation: 1, similarity: 2, affine: 3, homography: 4 };
export function residual(M: M3, p: Pt, q: Pt) { const [x, y] = apply3(M, p[0], p[1]); return Math.hypot(x - q[0], y - q[1]); }
/** RANSAC with a deterministic RNG; returns the refined model and inlier indices. */
export function ransac(model: Model, P: Pt[], Q: Pt[], thresh: number, iters = 1500, seed = 7): { M: M3; inliers: number[] } | null {
  const k = need[model], n = P.length;
  if (n < Math.max(k, model === 'homography' ? 6 : k + 1)) return null;
  let s = seed >>> 0;
  const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  let best: number[] = [], bestM: M3 | null = null;
  for (let it = 0; it < iters; it++) {
    const idx: number[] = [];
    while (idx.length < k) { const j = (rnd() * n) | 0; if (!idx.includes(j)) idx.push(j); }
    const M = fitMin(model, idx.map(i => P[i]), idx.map(i => Q[i]));
    if (!M || M.some(x => !isFinite(x))) continue;
    const inl: number[] = [];
    for (let i = 0; i < n; i++) if (residual(M, P[i], Q[i]) < thresh) inl.push(i);
    if (inl.length > best.length) { best = inl; bestM = M; if (inl.length > n * 0.9) break; }
  }
  if (!bestM || best.length < k + 2) return null;
  // refine twice on the inliers
  for (let r = 0; r < 2; r++) {
    const M = fitLS(model, best.map(i => P[i]), best.map(i => Q[i]));
    if (!M) break;
    const inl: number[] = [];
    for (let i = 0; i < n; i++) if (residual(M, P[i], Q[i]) < thresh) inl.push(i);
    if (inl.length < best.length * 0.9) break;
    bestM = M; best = inl;
  }
  return { M: bestM, inliers: best };
}

// ------------------------------------------------------------------ camera estimation
/** Focal lengths from a homography between image-centred coordinates (Szeliski / OpenCV). */
export function focalsFromH(h: M3): number[] {
  const out: number[] = [];
  let d1 = h[6] * h[7], d2 = (h[7] - h[6]) * (h[7] + h[6]);
  let v1 = -(h[0] * h[1] + h[3] * h[4]) / d1, v2 = (h[0] * h[0] + h[3] * h[3] - h[1] * h[1] - h[4] * h[4]) / d2;
  if (v1 < v2) [v1, v2] = [v2, v1];
  if (v1 > 0 && v2 > 0) out.push(Math.sqrt(Math.abs(d1) > Math.abs(d2) ? v1 : v2)); else if (v1 > 0) out.push(Math.sqrt(v1));
  d1 = h[0] * h[3] + h[1] * h[4]; d2 = h[0] * h[0] + h[1] * h[1] - h[3] * h[3] - h[4] * h[4];
  v1 = -h[2] * h[5] / d1; v2 = (h[5] * h[5] - h[2] * h[2]) / d2;
  if (v1 < v2) [v1, v2] = [v2, v1];
  if (v1 > 0 && v2 > 0) out.push(Math.sqrt(Math.abs(d1) > Math.abs(d2) ? v1 : v2)); else if (v1 > 0) out.push(Math.sqrt(v1));
  return out.filter(f => isFinite(f) && f > 0);
}
/**
 * Vignetting from matched brightness: log Ia − log Ib = a (ra² − rb²) + b (ra⁴ − rb⁴), r normalised to the
 * half diagonal. Returns [a, b] of the brightness model exp(a r² + b r⁴), or null.
 */
export function vignetteFit(samples: { ra: number; rb: number; la: number; lb: number }[]): [number, number] | null {
  const N = [0, 0, 0, 0], v = [0, 0];
  let n = 0;
  for (const s of samples) {
    if (s.la < 0.04 || s.lb < 0.04 || s.la > 0.97 || s.lb > 0.97) continue;
    const y = Math.log(s.la) - Math.log(s.lb), x1 = s.ra * s.ra - s.rb * s.rb, x2 = s.ra ** 4 - s.rb ** 4;
    N[0] += x1 * x1; N[1] += x1 * x2; N[3] += x2 * x2; v[0] += x1 * y; v[1] += x2 * y; n++;
  }
  if (n < 12) return null;
  N[2] = N[1];
  N[0] += 1e-3; N[3] += 1e-3;                                   // ridge: stay near "no vignetting"
  const r = solve(N, v, 2);
  if (!r) return null;
  return [Math.max(-1.2, Math.min(0.3, r[0])), Math.max(-1, Math.min(1, r[1]))];
}
/** Radial model p' = c + (p − c)(1 + k r²), r normalised by `norm`. */
export const undistort = (x: number, y: number, cx: number, cy: number, norm: number, k: number): Pt => {
  const dx = (x - cx) / norm, dy = (y - cy) / norm, f = 1 + k * (dx * dx + dy * dy);
  return [cx + dx * f * norm, cy + dy * f * norm];
};
