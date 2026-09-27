// Least-squares cubic Bézier fitting (P. J. Schneider, "An Algorithm for Automatically Fitting Digitized Curves",
// Graphics Gems 1990). Used by the Freeform Pen and by Merge Shape Components to turn polylines into smooth paths.
import type { PathPoint } from '../../core/path';
import type { Point } from '../../core/types';

type V = Point;
const sub = (a: V, b: V): V => ({ x: a.x - b.x, y: a.y - b.y });
const add = (a: V, b: V): V => ({ x: a.x + b.x, y: a.y + b.y });
const mul = (a: V, s: number): V => ({ x: a.x * s, y: a.y * s });
const dot = (a: V, b: V) => a.x * b.x + a.y * b.y;
const len = (a: V) => Math.hypot(a.x, a.y);
const norm = (a: V): V => { const l = len(a) || 1; return { x: a.x / l, y: a.y / l }; };
type Bez = [V, V, V, V];

function q(b: Bez, t: number): V {
  const mt = 1 - t;
  return add(add(mul(b[0], mt * mt * mt), mul(b[1], 3 * mt * mt * t)), add(mul(b[2], 3 * mt * t * t), mul(b[3], t * t * t)));
}
function qPrime(b: Bez, t: number): V {
  const mt = 1 - t;
  return add(add(mul(sub(b[1], b[0]), 3 * mt * mt), mul(sub(b[2], b[1]), 6 * mt * t)), mul(sub(b[3], b[2]), 3 * t * t));
}
function qPrimePrime(b: Bez, t: number): V {
  return add(mul(add(sub(b[2], mul(b[1], 2)), b[0]), 6 * (1 - t)), mul(add(sub(b[3], mul(b[2], 2)), b[1]), 6 * t));
}

function chordParams(pts: V[], first: number, last: number): number[] {
  const u = [0];
  for (let i = first + 1; i <= last; i++) u.push(u[u.length - 1] + len(sub(pts[i], pts[i - 1])));
  const total = u[u.length - 1] || 1;
  return u.map(v => v / total);
}

function generate(pts: V[], first: number, last: number, u: number[], t1: V, t2: V): Bez {
  const p0 = pts[first], p3 = pts[last];
  let c00 = 0, c01 = 0, c11 = 0, x0 = 0, x1 = 0;
  for (let i = 0; i < u.length; i++) {
    const t = u[i], mt = 1 - t;
    const a1 = mul(t1, 3 * mt * mt * t), a2 = mul(t2, 3 * mt * t * t);
    c00 += dot(a1, a1); c01 += dot(a1, a2); c11 += dot(a2, a2);
    const tmp = sub(pts[first + i], q([p0, p0, p3, p3], t));
    x0 += dot(a1, tmp); x1 += dot(a2, tmp);
  }
  const det = c00 * c11 - c01 * c01;
  let alpha1 = det ? (x0 * c11 - x1 * c01) / det : 0, alpha2 = det ? (c00 * x1 - c01 * x0) / det : 0;
  const segLen = len(sub(p3, p0)), eps = 1e-6 * segLen;
  if (alpha1 < eps || alpha2 < eps) { alpha1 = alpha2 = segLen / 3; }
  return [p0, add(p0, mul(t1, alpha1)), add(p3, mul(t2, alpha2)), p3];
}

function reparam(b: Bez, pts: V[], first: number, u: number[]): number[] {
  return u.map((t, i) => {
    const p = pts[first + i], d = sub(q(b, t), p), d1 = qPrime(b, t), d2 = qPrimePrime(b, t);
    const num = dot(d, d1), den = dot(d1, d1) + dot(d, d2);
    const nt = den ? t - num / den : t;
    return Math.max(0, Math.min(1, nt));
  });
}

function maxError(pts: V[], first: number, last: number, b: Bez, u: number[]): [number, number] {
  let max = 0, split = Math.floor((last - first + 1) / 2) + first;
  for (let i = first + 1; i < last; i++) {
    const d = sub(q(b, u[i - first]), pts[i]), e = dot(d, d);
    if (e >= max) { max = e; split = i; }
  }
  return [max, split];
}

function fitCubic(pts: V[], first: number, last: number, t1: V, t2: V, err2: number, out: Bez[], depth: number) {
  if (last - first === 1) {
    const d = len(sub(pts[last], pts[first])) / 3;
    out.push([pts[first], add(pts[first], mul(t1, d)), add(pts[last], mul(t2, d)), pts[last]]);
    return;
  }
  let u = chordParams(pts, first, last);
  let b = generate(pts, first, last, u, t1, t2);
  let [e, split] = maxError(pts, first, last, b, u);
  if (e < err2) { out.push(b); return; }
  if (e < err2 * 4) {
    for (let k = 0; k < 6; k++) {
      u = reparam(b, pts, first, u);
      b = generate(pts, first, last, u, t1, t2);
      [e, split] = maxError(pts, first, last, b, u);
      if (e < err2) { out.push(b); return; }
    }
  }
  if (depth > 40) { out.push(b); return; }
  split = Math.max(first + 1, Math.min(last - 1, split));
  const tc = norm(sub(pts[split - 1], pts[split + 1]));
  fitCubic(pts, first, split, t1, tc, err2, out, depth + 1);
  fitCubic(pts, split, last, mul(tc, -1), t2, err2, out, depth + 1);
}

/** Remove consecutive near-duplicate points. */
function dedupe(pts: V[], minDist: number): V[] {
  const out: V[] = [];
  for (const p of pts) if (!out.length || len(sub(p, out[out.length - 1])) >= minDist) out.push(p);
  return out;
}

/** Fit a polyline with cubic Béziers; `error` in px. Returns anchors (smooth where tangents are continuous). */
export function fitCurve(raw: Point[], error = 2, closed = false): PathPoint[] {
  let pts = dedupe(raw, 0.5);
  if (closed && pts.length > 2 && len(sub(pts[0], pts[pts.length - 1])) > 0.5) pts = [...pts, pts[0]];
  if (pts.length < 2) return pts.map(p => ({ x: p.x, y: p.y, ix: p.x, iy: p.y, ox: p.x, oy: p.y, smooth: false }));
  const n = pts.length;
  let t1 = norm(sub(pts[Math.min(1, n - 1)], pts[0])), t2 = norm(sub(pts[Math.max(0, n - 2)], pts[n - 1]));
  if (closed && n > 3) { const tc = norm(sub(pts[1], pts[n - 2])); t1 = tc; t2 = mul(tc, -1); }
  const segs: Bez[] = [];
  fitCubic(pts, 0, n - 1, t1, t2, error * error, segs, 0);
  const out: PathPoint[] = [];
  segs.forEach((b, i) => {
    if (i === 0) out.push({ x: b[0].x, y: b[0].y, ix: b[0].x, iy: b[0].y, ox: b[1].x, oy: b[1].y, smooth: closed });
    else { out[out.length - 1].ox = b[1].x; out[out.length - 1].oy = b[1].y; }
    out.push({ x: b[3].x, y: b[3].y, ix: b[2].x, iy: b[2].y, ox: b[3].x, oy: b[3].y, smooth: i < segs.length - 1 });
  });
  if (closed && out.length > 2) {
    const last = out.pop()!;
    out[0].ix = last.ix; out[0].iy = last.iy;
  }
  return out;
}
