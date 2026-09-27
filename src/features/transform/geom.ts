// Transform geometry: projective maps (rect → quad), bicubic Bézier warp patches and mesh rendering of a source
// canvas through such a mapping (affine fast path, triangle mesh for distort / perspective / warp).
import { createCanvas, ctx2d } from '../../core/canvas';
import type { Point, Rect } from '../../core/types';

export type Quad = [Point, Point, Point, Point];           // tl, tr, br, bl
export type Grid = Point[];                                 // 16 control points, row-major (v = 0..3, u = 0..3)

export const rectQuad = (r: Rect): Quad => [{ x: r.x, y: r.y }, { x: r.x + r.w, y: r.y }, { x: r.x + r.w, y: r.y + r.h }, { x: r.x, y: r.y + r.h }];
export const quadBounds = (pts: Point[]): Rect => {
  const xs = pts.map(p => p.x), ys = pts.map(p => p.y);
  const x = Math.min(...xs), y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
};
export const isParallelogram = (q: Quad, eps = 1e-3) => Math.abs(q[0].x + q[2].x - q[1].x - q[3].x) < eps && Math.abs(q[0].y + q[2].y - q[1].y - q[3].y) < eps;

/** Affine matrix mapping rect r onto parallelogram q (uses q0, q1, q3). */
export function affineOf(r: Rect, q: Quad): DOMMatrix {
  const a = (q[1].x - q[0].x) / (r.w || 1), b = (q[1].y - q[0].y) / (r.w || 1);
  const c = (q[3].x - q[0].x) / (r.h || 1), d = (q[3].y - q[0].y) / (r.h || 1);
  return new DOMMatrix([a, b, c, d, q[0].x - a * r.x - c * r.y, q[0].y - b * r.x - d * r.y]);
}

// ------------------------------------------------------------------ projective
/** 3×3 homography as [a,b,c,d,e,f,g,h] with x' = (a x + b y + c)/(g x + h y + 1), y' = (d x + e y + f)/(…). */
export type H8 = number[];
/** Unit square → quad. */
function squareToQuad(q: Quad): H8 {
  const [p0, p1, p2, p3] = q;
  const dx1 = p1.x - p2.x, dx2 = p3.x - p2.x, dy1 = p1.y - p2.y, dy2 = p3.y - p2.y;
  const sx = p0.x - p1.x + p2.x - p3.x, sy = p0.y - p1.y + p2.y - p3.y;
  let g = 0, hh = 0;
  if (Math.abs(sx) > 1e-9 || Math.abs(sy) > 1e-9) {
    const den = dx1 * dy2 - dx2 * dy1 || 1e-12;
    g = (sx * dy2 - dx2 * sy) / den;
    hh = (dx1 * sy - sx * dy1) / den;
  }
  return [p1.x - p0.x + g * p1.x, p3.x - p0.x + hh * p3.x, p0.x, p1.y - p0.y + g * p1.y, p3.y - p0.y + hh * p3.y, p0.y, g, hh];
}
/** Rect → quad homography. */
export function rectToQuad(r: Rect, q: Quad): (p: Point) => Point {
  const H = squareToQuad(q), iw = 1 / (r.w || 1), ih = 1 / (r.h || 1);
  return p => {
    const u = (p.x - r.x) * iw, v = (p.y - r.y) * ih;
    const w = H[6] * u + H[7] * v + 1;
    return { x: (H[0] * u + H[1] * v + H[2]) / w, y: (H[3] * u + H[4] * v + H[5]) / w };
  };
}
/** Inverse of rectToQuad (numerically, via the adjugate). */
export function quadToRect(r: Rect, q: Quad): (p: Point) => Point {
  const [a, b, c, d, e, f, g, hh] = squareToQuad(q);
  // inverse of [[a b c][d e f][g h 1]]
  const A = e - f * hh, B = c * hh - b, C = b * f - c * e, D = f * g - d, E = a - c * g, F = c * d - a * f, G = d * hh - e * g, Hh = b * g - a * hh, I = a * e - b * d;
  return p => {
    const w = G * p.x + Hh * p.y + I;
    const u = (A * p.x + B * p.y + C) / w, v = (D * p.x + E * p.y + F) / w;
    return { x: r.x + u * r.w, y: r.y + v * r.h };
  };
}

// ------------------------------------------------------------------ Bézier warp patch
const bern = (t: number) => { const s = 1 - t; return [s * s * s, 3 * s * s * t, 3 * s * t * t, t * t * t]; };
export function evalGrid(g: Grid, u: number, v: number): Point {
  const bu = bern(u), bv = bern(v);
  let x = 0, y = 0;
  for (let j = 0; j < 4; j++) for (let i = 0; i < 4; i++) { const w = bu[i] * bv[j], p = g[j * 4 + i]; x += p.x * w; y += p.y * w; }
  return { x, y };
}
/** Grid equivalent to a rect → quad mapping (control points at thirds). */
export function gridFromMap(r: Rect, map: (p: Point) => Point): Grid {
  const g: Grid = [];
  for (let j = 0; j < 4; j++) for (let i = 0; i < 4; i++) g.push(map({ x: r.x + (r.w * i) / 3, y: r.y + (r.h * j) / 3 }));
  return g;
}

// ------------------------------------------------------------------ rendering
export type Interp = 'bicubic' | 'bilinear' | 'nearest';

/** Mapping source (canvas coords relative to srcRect origin == srcRect in doc coords) → destination doc coords. */
export type Mapping = { kind: 'affine'; m: DOMMatrix } | { kind: 'mesh'; f: (u: number, v: number) => Point };

/** Destination bounds of a mapping applied to rect r. */
export function mappedBounds(r: Rect, map: Mapping, n = 16): Rect {
  const pts: Point[] = [];
  if (map.kind === 'affine') for (const p of rectQuad(r)) { const q = map.m.transformPoint(new DOMPoint(p.x, p.y)); pts.push({ x: q.x, y: q.y }); }
  else for (let i = 0; i <= n; i++) for (const [u, v] of [[i / n, 0], [i / n, 1], [0, i / n], [1, i / n]]) pts.push(map.f(u, v));
  return quadBounds(pts);
}

/**
 * Render `src` (occupying doc rect r) through `map` into a new canvas covering the mapped bounds.
 * Returns the canvas and its doc position. `clip` limits the output area (doc rect).
 */
export function renderMapped(src: CanvasImageSource, r: Rect, map: Mapping, interp: Interp = 'bicubic', quality: 'preview' | 'final' = 'final', clip?: Rect | null): { canvas: HTMLCanvasElement; x: number; y: number } {
  let b = mappedBounds(r, map);
  let x0 = Math.floor(b.x), y0 = Math.floor(b.y), x1 = Math.ceil(b.x + b.w), y1 = Math.ceil(b.y + b.h);
  if (clip) { x0 = Math.max(x0, Math.floor(clip.x)); y0 = Math.max(y0, Math.floor(clip.y)); x1 = Math.min(x1, Math.ceil(clip.x + clip.w)); y1 = Math.min(y1, Math.ceil(clip.y + clip.h)); }
  const w = Math.max(1, x1 - x0), hh = Math.max(1, y1 - y0);
  // guard against absurd sizes (e.g. perspective near the horizon)
  const MAX = 16000;
  const out = createCanvas(Math.min(MAX, w), Math.min(MAX, hh)), x = ctx2d(out);
  x.imageSmoothingEnabled = interp !== 'nearest';
  x.imageSmoothingQuality = interp === 'bicubic' ? 'high' : 'low';
  if (map.kind === 'affine') {
    const m = map.m;
    x.setTransform(m.a, m.b, m.c, m.d, m.e - x0, m.f - y0);
    x.drawImage(src, r.x, r.y);
    return { canvas: out, x: x0, y: y0 };
  }
  // triangle mesh
  const n = quality === 'preview' ? 14 : Math.max(16, Math.min(48, Math.round(Math.max(r.w, r.h) / 24)));
  const P: Point[] = [];
  for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++) { const p = map.f(i / n, j / n); P.push({ x: p.x - x0, y: p.y - y0 }); }
  const S = (i: number, j: number): Point => ({ x: r.x + (r.w * i) / n, y: r.y + (r.h * j) / n });
  const tri = (s0: Point, s1: Point, s2: Point, d0: Point, d1: Point, d2: Point) => {
    // affine s → d
    const den = (s1.x - s0.x) * (s2.y - s0.y) - (s2.x - s0.x) * (s1.y - s0.y);
    if (Math.abs(den) < 1e-12) return;
    const a = ((d1.x - d0.x) * (s2.y - s0.y) - (d2.x - d0.x) * (s1.y - s0.y)) / den;
    const c = ((d2.x - d0.x) * (s1.x - s0.x) - (d1.x - d0.x) * (s2.x - s0.x)) / den;
    const b = ((d1.y - d0.y) * (s2.y - s0.y) - (d2.y - d0.y) * (s1.y - s0.y)) / den;
    const d = ((d2.y - d0.y) * (s1.x - s0.x) - (d1.y - d0.y) * (s2.x - s0.x)) / den;
    const e = d0.x - a * s0.x - c * s0.y, f = d0.y - b * s0.x - d * s0.y;
    // clip to the destination triangle, grown by ~0.5px to hide seams
    const cx = (d0.x + d1.x + d2.x) / 3, cy = (d0.y + d1.y + d2.y) / 3;
    const grow = (p: Point) => { const dx = p.x - cx, dy = p.y - cy, l = Math.hypot(dx, dy) || 1; return { x: p.x + (dx / l) * 0.9, y: p.y + (dy / l) * 0.9 }; };
    const g0 = grow(d0), g1 = grow(d1), g2 = grow(d2);
    x.save();
    x.beginPath(); x.moveTo(g0.x, g0.y); x.lineTo(g1.x, g1.y); x.lineTo(g2.x, g2.y); x.closePath(); x.clip();
    x.setTransform(a, b, c, d, e, f);
    const sx0 = Math.floor(Math.min(s0.x, s1.x, s2.x) - 1), sy0 = Math.floor(Math.min(s0.y, s1.y, s2.y) - 1);
    const sx1 = Math.ceil(Math.max(s0.x, s1.x, s2.x) + 1), sy1 = Math.ceil(Math.max(s0.y, s1.y, s2.y) + 1);
    const cx0 = Math.max(r.x, sx0), cy0 = Math.max(r.y, sy0), cx1 = Math.min(r.x + r.w, sx1), cy1 = Math.min(r.y + r.h, sy1);
    if (cx1 > cx0 && cy1 > cy0) x.drawImage(src, cx0 - r.x, cy0 - r.y, cx1 - cx0, cy1 - cy0, cx0, cy0, cx1 - cx0, cy1 - cy0);
    x.restore();
  };
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const p00 = P[j * (n + 1) + i], p10 = P[j * (n + 1) + i + 1], p01 = P[(j + 1) * (n + 1) + i], p11 = P[(j + 1) * (n + 1) + i + 1];
    const s00 = S(i, j), s10 = S(i + 1, j), s01 = S(i, j + 1), s11 = S(i + 1, j + 1);
    tri(s00, s10, s11, p00, p10, p11);
    tri(s00, s11, s01, p00, p11, p01);
  }
  return { canvas: out, x: x0, y: y0 };
}
