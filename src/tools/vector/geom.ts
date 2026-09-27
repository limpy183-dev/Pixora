// Vector geometry helpers shared by the pen/shape tools, shape layers and the Paths panel.
import { corner, parseSvgPath, toPath2D, type PathOp, type PathPoint, type SubPath } from '../../core/path';
import type { Point, Rect } from '../../core/types';

export const clonePt = (p: PathPoint): PathPoint => ({ ...p });
export const cloneSub = (sp: SubPath): SubPath => ({ ...sp, points: sp.points.map(clonePt) });
export const cloneSubs = (s: SubPath[]): SubPath[] => s.map(cloneSub);

/** Number of segments in a subpath. */
export const segCount = (sp: SubPath) => (sp.points.length < 2 ? 0 : sp.closed ? sp.points.length : sp.points.length - 1);
/** Control points of segment i (from points[i] to the next point). */
export function segCtrl(sp: SubPath, i: number): [Point, Point, Point, Point] {
  const p = sp.points[i], q = sp.points[(i + 1) % sp.points.length];
  return [{ x: p.x, y: p.y }, { x: p.ox, y: p.oy }, { x: q.ix, y: q.iy }, { x: q.x, y: q.y }];
}
export function bezPoint(a: Point, b: Point, c: Point, d: Point, t: number): Point {
  const mt = 1 - t, A = mt * mt * mt, B = 3 * mt * mt * t, C = 3 * mt * t * t, D = t * t * t;
  return { x: A * a.x + B * b.x + C * c.x + D * d.x, y: A * a.y + B * b.y + C * c.y + D * d.y };
}
const L = (a: Point, b: Point, t: number): Point => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
export const isStraight = (a: Point, b: Point, c: Point, d: Point) => b.x === a.x && b.y === a.y && c.x === d.x && c.y === d.y;

/** Split segment i of sp at t, inserting a smooth anchor. Returns the new point's index. */
export function splitSegment(sp: SubPath, i: number, t: number): number {
  const [a, b, c, d] = segCtrl(sp, i);
  const p = sp.points[i], q = sp.points[(i + 1) % sp.points.length];
  const straight = isStraight(a, b, c, d);
  const ab = L(a, b, t), bc = L(b, c, t), cd = L(c, d, t), abc = L(ab, bc, t), bcd = L(bc, cd, t), m = L(abc, bcd, t);
  const np: PathPoint = straight ? corner(m.x, m.y) : { x: m.x, y: m.y, ix: abc.x, iy: abc.y, ox: bcd.x, oy: bcd.y, smooth: true };
  if (!straight) { p.ox = ab.x; p.oy = ab.y; q.ix = cd.x; q.iy = cd.y; }
  sp.points.splice(i + 1, 0, np);
  return i + 1;
}

/** Nearest point on a cubic to p: {t, d, pt}. */
export function nearestOnCubic(a: Point, b: Point, c: Point, d: Point, p: Point): { t: number; d: number; pt: Point } {
  let best = 0, bd = Infinity;
  const N = isStraight(a, b, c, d) ? 1 : 40;
  if (N === 1) {
    const dx = d.x - a.x, dy = d.y - a.y, l2 = dx * dx + dy * dy || 1;
    const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2));
    const q = { x: a.x + dx * t, y: a.y + dy * t };
    return { t, d: Math.hypot(q.x - p.x, q.y - p.y), pt: q };
  }
  for (let i = 0; i <= N; i++) {
    const q = bezPoint(a, b, c, d, i / N), dd = (q.x - p.x) ** 2 + (q.y - p.y) ** 2;
    if (dd < bd) { bd = dd; best = i / N; }
  }
  let step = 1 / N;
  for (let k = 0; k < 12; k++) {
    step /= 2;
    for (const t of [best - step, best + step]) {
      if (t < 0 || t > 1) continue;
      const q = bezPoint(a, b, c, d, t), dd = (q.x - p.x) ** 2 + (q.y - p.y) ** 2;
      if (dd < bd) { bd = dd; best = t; }
    }
  }
  return { t: best, d: Math.sqrt(bd), pt: bezPoint(a, b, c, d, best) };
}

/** Exact bounds of the curves (not the control hull). */
export function tightBounds(subpaths: SubPath[]): Rect | null {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const inc = (q: Point) => { if (q.x < x0) x0 = q.x; if (q.x > x1) x1 = q.x; if (q.y < y0) y0 = q.y; if (q.y > y1) y1 = q.y; };
  for (const sp of subpaths) {
    for (const q of sp.points) inc(q);
    const n = segCount(sp);
    for (let i = 0; i < n; i++) {
      const [a, b, c, d] = segCtrl(sp, i);
      if (isStraight(a, b, c, d)) continue;
      for (const k of ['x', 'y'] as const) {
        const A = -a[k] + 3 * b[k] - 3 * c[k] + d[k], B = 2 * (a[k] - 2 * b[k] + c[k]), C = b[k] - a[k];
        const roots: number[] = [];
        if (Math.abs(A) < 1e-9) { if (Math.abs(B) > 1e-9) roots.push(-C / B); }
        else { const disc = B * B - 4 * A * C; if (disc >= 0) { const s = Math.sqrt(disc); roots.push((-B + s) / (2 * A), (-B - s) / (2 * A)); } }
        for (const t of roots) if (t > 0 && t < 1) inc(bezPoint(a, b, c, d, t));
      }
    }
  }
  return x1 < x0 ? null : { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** Flatten a subpath into a polyline (doc units). tol ≈ max chord error. */
export function flattenSub(sp: SubPath, tol = 0.25): Point[] {
  const out: Point[] = [];
  if (!sp.points.length) return out;
  out.push({ x: sp.points[0].x, y: sp.points[0].y });
  const n = segCount(sp);
  for (let i = 0; i < n; i++) {
    const [a, b, c, d] = segCtrl(sp, i);
    if (isStraight(a, b, c, d)) { out.push(d); continue; }
    const len = Math.hypot(b.x - a.x, b.y - a.y) + Math.hypot(c.x - b.x, c.y - b.y) + Math.hypot(d.x - c.x, d.y - c.y);
    const k = Math.max(2, Math.min(400, Math.ceil(Math.sqrt(len / tol))));
    for (let j = 1; j <= k; j++) out.push(bezPoint(a, b, c, d, j / k));
  }
  return out;
}

/** Rounded polygon: `radii[i]` rounds vertex i (0 = sharp). Arcs are exact-ish cubic approximations. */
export function roundPolygon(v: Point[], radii: number[] | number): SubPath {
  const n = v.length, pts: PathPoint[] = [];
  for (let i = 0; i < n; i++) {
    const V = v[i], P = v[(i + n - 1) % n], N = v[(i + 1) % n];
    let r = Array.isArray(radii) ? radii[i] || 0 : radii;
    const lp = Math.hypot(P.x - V.x, P.y - V.y), ln = Math.hypot(N.x - V.x, N.y - V.y);
    if (r <= 0 || lp < 1e-9 || ln < 1e-9) { pts.push(corner(V.x, V.y)); continue; }
    const u1 = { x: (P.x - V.x) / lp, y: (P.y - V.y) / lp }, u2 = { x: (N.x - V.x) / ln, y: (N.y - V.y) / ln };
    const th = Math.acos(Math.max(-1, Math.min(1, u1.x * u2.x + u1.y * u2.y)));
    if (th < 1e-4 || Math.PI - th < 1e-4) { pts.push(corner(V.x, V.y)); continue; }
    let d = r / Math.tan(th / 2);
    const maxD = Math.min(lp, ln) / 2;
    if (d > maxD) { d = maxD; r = d * Math.tan(th / 2); }
    const phi = Math.PI - th, k = (4 / 3) * Math.tan(phi / 4) * r;
    const A = { x: V.x + u1.x * d, y: V.y + u1.y * d }, B = { x: V.x + u2.x * d, y: V.y + u2.y * d };
    pts.push({ x: A.x, y: A.y, ix: A.x, iy: A.y, ox: A.x - u1.x * k, oy: A.y - u1.y * k, smooth: false });
    pts.push({ x: B.x, y: B.y, ix: B.x - u2.x * k, iy: B.y - u2.y * k, ox: B.x, oy: B.y, smooth: false });
  }
  return { closed: true, points: pts };
}

/** Rectangle with per-corner radii [tl, tr, br, bl]. */
export function roundRect(r: Rect, radii: number[] = [0, 0, 0, 0]): SubPath {
  const x0 = Math.min(r.x, r.x + r.w), y0 = Math.min(r.y, r.y + r.h), w = Math.abs(r.w), h = Math.abs(r.h);
  const m = Math.min(w, h) / 2;
  const rr = radii.map(v => Math.max(0, Math.min(v || 0, m)));
  return roundPolygon([{ x: x0, y: y0 }, { x: x0 + w, y: y0 }, { x: x0 + w, y: y0 + h }, { x: x0, y: y0 + h }], rr);
}

/** Catmull-Rom style automatic handles (curvature pen, smooth polygons). Only points in `only` (if given) change. */
export function autoSmooth(sp: SubPath, only?: Set<number>, tension = 1) {
  const pts = sp.points, n = pts.length;
  if (n < 2) return;
  for (let i = 0; i < n; i++) {
    if (only && !only.has(i)) continue;
    const p = pts[i];
    if (!p.smooth) { p.ix = p.x; p.iy = p.y; p.ox = p.x; p.oy = p.y; continue; }
    const hasPrev = sp.closed || i > 0, hasNext = sp.closed || i < n - 1;
    const prev = pts[(i + n - 1) % n], next = pts[(i + 1) % n];
    if (!hasPrev || !hasNext) {
      // open end: aim at a third of the way to the neighbour's handle
      const o = hasNext ? next : prev;
      const dx = (o.x - p.x) / 3, dy = (o.y - p.y) / 3;
      if (hasNext) { p.ox = p.x + dx * tension * 0.5; p.oy = p.y + dy * tension * 0.5; p.ix = p.x; p.iy = p.y; }
      else { p.ix = p.x + dx * tension * 0.5; p.iy = p.y + dy * tension * 0.5; p.ox = p.x; p.oy = p.y; }
      continue;
    }
    let tx = next.x - prev.x, ty = next.y - prev.y;
    const tl = Math.hypot(tx, ty) || 1; tx /= tl; ty /= tl;
    const dp = Math.hypot(p.x - prev.x, p.y - prev.y) / 3 * tension, dn = Math.hypot(next.x - p.x, next.y - p.y) / 3 * tension;
    p.ix = p.x - tx * dp; p.iy = p.y - ty * dp; p.ox = p.x + tx * dn; p.oy = p.y + ty * dn;
  }
}

export interface ArrowOpts { start: boolean; end: boolean; width: number; length: number; concavity: number } // % of weight
/** Line of `weight` thickness from p1 to p2 as a closed polygon, with optional arrowheads. */
export function linePolygon(p1: Point, p2: Point, weight: number, ar?: ArrowOpts): SubPath {
  const dx = p2.x - p1.x, dy = p2.y - p1.y, len = Math.hypot(dx, dy) || 1e-6;
  const u = { x: dx / len, y: dy / len }, n = { x: -u.y, y: u.x }, hw = Math.max(0.05, weight / 2);
  const P = (b: Point, du: number, dn: number) => ({ x: b.x + u.x * du + n.x * dn, y: b.y + u.y * du + n.y * dn });
  const AL = ar ? Math.min(len / ((ar.start && ar.end) ? 2 : 1), weight * ar.length / 100) : 0;
  const AW = ar ? Math.max(hw, weight * ar.width / 200) : 0;
  const inner = ar ? AL * (1 - ar.concavity / 100) : 0;
  const v: Point[] = [];
  if (ar?.start) { v.push(p1, P(p1, AL, AW), P(p1, inner, hw)); } else v.push(P(p1, 0, hw));
  if (ar?.end) { v.push(P(p2, -inner, hw), P(p2, -AL, AW), p2, P(p2, -AL, -AW), P(p2, -inner, -hw)); } else v.push(P(p2, 0, hw), P(p2, 0, -hw));
  if (ar?.start) { v.push(P(p1, inner, -hw), P(p1, AL, -AW)); } else v.push(P(p1, 0, -hw));
  return { closed: true, points: v.map(q => corner(q.x, q.y)) };
}

/** Regular polygon / star vertices inscribed in the ellipse of box r (first vertex at top). */
export function polygonVertices(r: Rect, sides: number, star = 0): Point[] {
  const n = Math.max(3, Math.round(sides)), cx = r.x + r.w / 2, cy = r.y + r.h / 2, rx = Math.abs(r.w) / 2, ry = Math.abs(r.h) / 2;
  const count = star > 0 ? n * 2 : n, out: Point[] = [];
  for (let i = 0; i < count; i++) {
    const k = star > 0 && i % 2 ? 1 - star : 1, a = -Math.PI / 2 + (i * Math.PI * 2) / count;
    out.push({ x: cx + Math.cos(a) * rx * k, y: cy + Math.sin(a) * ry * k });
  }
  return out;
}

export function transformSubsInPlace(subs: SubPath[], m: DOMMatrix) {
  const T = (x: number, y: number) => m.transformPoint(new DOMPoint(x, y));
  for (const sp of subs) for (const q of sp.points) {
    const a = T(q.x, q.y), i = T(q.ix, q.iy), o = T(q.ox, q.oy);
    q.x = a.x; q.y = a.y; q.ix = i.x; q.iy = i.y; q.ox = o.x; q.oy = o.y;
  }
}
export function translateSubs(subs: SubPath[], dx: number, dy: number) {
  for (const sp of subs) for (const q of sp.points) { q.x += dx; q.y += dy; q.ix += dx; q.iy += dy; q.ox += dx; q.oy += dy; }
}

let scratch: CanvasRenderingContext2D | null = null;
function sctx() { return scratch || (scratch = document.createElement('canvas').getContext('2d')!); }
/** Is p inside subpath sp (nonzero; open subpaths are closed implicitly)? */
export function insideSub(sp: SubPath, p: Point): boolean {
  if (sp.points.length < 2) return false;
  return sctx().isPointInPath(toPath2D([sp]), p.x, p.y, 'nonzero');
}

/** Signed area of a subpath's polygonal approximation (>0 = clockwise in y-down coords). */
export function signedArea(sp: SubPath): number {
  const pts = flattenSub(sp, 1);
  let a = 0;
  for (let i = 0; i < pts.length; i++) { const p = pts[i], q = pts[(i + 1) % pts.length]; a += p.x * q.y - q.x * p.y; }
  return a / 2;
}

/** Assign explicit path operations so shapes with holes (e.g. SVG rings) render with sequential ops. */
export function assignHoleOps(subs: SubPath[], op: PathOp = 'add'): SubPath[] {
  if (subs.length <= 1) { for (const s of subs) s.op = op; return subs; }
  const depth = subs.map((s, i) => { const p = s.points[0]; let d = 0; if (!p) return 0; subs.forEach((o, j) => { if (j !== i && o.closed && insideSub(o, p)) d++; }); return d; });
  const order = subs.map((s, i) => ({ s, d: depth[i], i })).sort((a, b) => a.d - b.d || a.i - b.i);
  return order.map(({ s, d }) => {
    const hole = d % 2 === 1;
    s.op = !hole ? op : op === 'subtract' ? 'add' : 'subtract';
    return s;
  });
}

/** Custom shape (SVG path data in a 0..100 box) mapped into rect r. */
export function customShapeSubs(d: string, r: Rect, op: PathOp = 'add'): SubPath[] {
  const subs = parseSvgPath(d);
  const b = tightBounds(subs) || { x: 0, y: 0, w: 100, h: 100 };
  const m = new DOMMatrix().translate(r.x, r.y).scale(r.w / (b.w || 1), r.h / (b.h || 1)).translate(-b.x, -b.y);
  transformSubsInPlace(subs, m);
  for (const s of subs) s.closed = true;
  return assignHoleOps(subs, op);
}

/** Serialize subpaths to SVG path data (for custom shapes / Copy SVG). */
export function subsToSvg(subs: SubPath[], m?: DOMMatrix): string {
  const f = (v: number) => (Math.round(v * 100) / 100).toString();
  const T = (x: number, y: number) => { if (!m) return `${f(x)} ${f(y)}`; const p = m.transformPoint(new DOMPoint(x, y)); return `${f(p.x)} ${f(p.y)}`; };
  let out = '';
  for (const sp of subs) {
    const pts = sp.points;
    if (!pts.length) continue;
    out += `M${T(pts[0].x, pts[0].y)}`;
    const seg = (a: PathPoint, b: PathPoint) => {
      if (a.ox === a.x && a.oy === a.y && b.ix === b.x && b.iy === b.y) out += `L${T(b.x, b.y)}`;
      else out += `C${T(a.ox, a.oy)} ${T(b.ix, b.iy)} ${T(b.x, b.y)}`;
    };
    for (let i = 1; i < pts.length; i++) seg(pts[i - 1], pts[i]);
    if (sp.closed && pts.length > 1) { seg(pts[pts.length - 1], pts[0]); out += 'Z'; }
  }
  return out;
}

/** Axis-aligned union of rects. */
export function unionRects(rs: (Rect | null)[]): Rect | null {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const r of rs) if (r) { x0 = Math.min(x0, r.x); y0 = Math.min(y0, r.y); x1 = Math.max(x1, r.x + r.w); y1 = Math.max(y1, r.y + r.h); }
  return x1 < x0 ? null : { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}
