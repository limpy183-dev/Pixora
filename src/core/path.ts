// Vector path model shared by the pen/shape tools, Paths panel, type (work paths) and selections.
import type { Point, Rect } from './types';

/** Anchor with absolute handle positions. A corner point has handles equal to the anchor. */
export interface PathPoint { x: number; y: number; ix: number; iy: number; ox: number; oy: number; smooth: boolean }
export type PathOp = 'add' | 'subtract' | 'intersect' | 'exclude';
export interface SubPath { points: PathPoint[]; closed: boolean; op?: PathOp }
/** A named path shown in the Paths panel. kind 'work' = the temporary Work Path. */
export interface VectorPath { id: number; name: string; kind: 'work' | 'saved' | 'clip'; subpaths: SubPath[] }

let pid = 1;
export const newPathId = () => pid++;

export const corner = (x: number, y: number): PathPoint => ({ x, y, ix: x, iy: y, ox: x, oy: y, smooth: false });

/** Build a Path2D (nonzero fill for 'add'; use evenodd for exclude). */
export function toPath2D(subpaths: SubPath[], m?: DOMMatrix): Path2D {
  const p = new Path2D();
  for (const sp of subpaths) appendSubpath(p, sp, m);
  return p;
}
export function appendSubpath(p: Path2D | CanvasRenderingContext2D, sp: SubPath, m?: DOMMatrix) {
  const pts = sp.points;
  if (!pts.length) return;
  const T = (x: number, y: number) => (m ? m.transformPoint(new DOMPoint(x, y)) : { x, y });
  const a0 = T(pts[0].x, pts[0].y);
  p.moveTo(a0.x, a0.y);
  const seg = (a: PathPoint, b: PathPoint) => {
    const c1 = T(a.ox, a.oy), c2 = T(b.ix, b.iy), e = T(b.x, b.y);
    if (a.ox === a.x && a.oy === a.y && b.ix === b.x && b.iy === b.y) p.lineTo(e.x, e.y);
    else p.bezierCurveTo(c1.x, c1.y, c2.x, c2.y, e.x, e.y);
  };
  for (let i = 1; i < pts.length; i++) seg(pts[i - 1], pts[i]);
  if (sp.closed && pts.length > 1) { seg(pts[pts.length - 1], pts[0]); p.closePath(); }
}

/** Approximate bounds (control-point hull). */
export function pathBounds(subpaths: SubPath[]): Rect | null {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const sp of subpaths) for (const q of sp.points) for (const [x, y] of [[q.x, q.y], [q.ix, q.iy], [q.ox, q.oy]]) {
    if (x < x0) x0 = x; if (y < y0) y0 = y; if (x > x1) x1 = x; if (y > y1) y1 = y;
  }
  return x1 < x0 ? null : { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}
export function transformSubpaths(subpaths: SubPath[], m: DOMMatrix): SubPath[] {
  const T = (x: number, y: number) => { const p = m.transformPoint(new DOMPoint(x, y)); return [p.x, p.y]; };
  return subpaths.map(sp => ({
    ...sp,
    points: sp.points.map(q => { const [x, y] = T(q.x, q.y), [ix, iy] = T(q.ix, q.iy), [ox, oy] = T(q.ox, q.oy); return { x, y, ix, iy, ox, oy, smooth: q.smooth }; }),
  }));
}

/** Shapes as subpaths (used by shape tools / custom shapes). */
export function rectPath(r: Rect, radius = 0): SubPath {
  const { x, y, w, h } = r;
  const rr = Math.max(0, Math.min(radius, Math.abs(w) / 2, Math.abs(h) / 2));
  if (!rr) return { closed: true, points: [corner(x, y), corner(x + w, y), corner(x + w, y + h), corner(x, y + h)] };
  const k = rr * 0.5523;
  const P = (ax: number, ay: number, ix: number, iy: number, ox: number, oy: number): PathPoint => ({ x: ax, y: ay, ix, iy, ox, oy, smooth: false });
  return {
    closed: true, points: [
      P(x + rr, y, x + rr - k, y, x + rr, y), P(x + w - rr, y, x + w - rr, y, x + w - rr + k, y),
      P(x + w, y + rr, x + w, y + rr - k, x + w, y + rr), P(x + w, y + h - rr, x + w, y + h - rr, x + w, y + h - rr + k),
      P(x + w - rr, y + h, x + w - rr + k, y + h, x + w - rr, y + h), P(x + rr, y + h, x + rr, y + h, x + rr - k, y + h),
      P(x, y + h - rr, x, y + h - rr + k, x, y + h - rr), P(x, y + rr, x, y + rr, x, y + rr - k),
    ],
  };
}
export function ellipsePath(r: Rect): SubPath {
  const cx = r.x + r.w / 2, cy = r.y + r.h / 2, rx = r.w / 2, ry = r.h / 2, kx = rx * 0.5523, ky = ry * 0.5523;
  const P = (x: number, y: number, ix: number, iy: number, ox: number, oy: number): PathPoint => ({ x, y, ix, iy, ox, oy, smooth: true });
  return {
    closed: true, points: [
      P(cx, cy - ry, cx - kx, cy - ry, cx + kx, cy - ry), P(cx + rx, cy, cx + rx, cy - ky, cx + rx, cy + ky),
      P(cx, cy + ry, cx + kx, cy + ry, cx - kx, cy + ry), P(cx - rx, cy, cx - rx, cy + ky, cx - rx, cy - ky),
    ],
  };
}
export function polygonPath(cx: number, cy: number, radius: number, sides: number, star = 0, rotation = -Math.PI / 2): SubPath {
  const pts: PathPoint[] = [];
  const n = Math.max(3, Math.round(sides));
  for (let i = 0; i < n * (star ? 2 : 1); i++) {
    const r = star && i % 2 ? radius * (1 - star) : radius;
    const a = rotation + (i * Math.PI * 2) / (n * (star ? 2 : 1));
    pts.push(corner(cx + Math.cos(a) * r, cy + Math.sin(a) * r));
  }
  return { closed: true, points: pts };
}

/** Parse SVG path data (M L H V C S Q T Z, absolute/relative) into subpaths. Arcs are approximated by lines. */
export function parseSvgPath(d: string, m?: DOMMatrix): SubPath[] {
  const toks = d.match(/[a-zA-Z]|-?\d*\.?\d+(?:e[-+]?\d+)?/g) || [];
  const out: SubPath[] = [];
  let i = 0, cmd = '', cx = 0, cy = 0, sx = 0, sy = 0, cur: SubPath | null = null, lastC: Point | null = null;
  const num = () => parseFloat(toks[i++]);
  const push = (x: number, y: number) => { cur!.points.push(corner(x, y)); };
  while (i < toks.length) {
    if (/[a-zA-Z]/.test(toks[i])) cmd = toks[i++];
    const rel = cmd === cmd.toLowerCase(), C = cmd.toUpperCase();
    const ox = rel ? cx : 0, oy = rel ? cy : 0;
    if (C === 'M') { cx = num() + ox; cy = num() + oy; sx = cx; sy = cy; cur = { points: [], closed: false }; out.push(cur); push(cx, cy); cmd = rel ? 'l' : 'L'; lastC = null; }
    else if (C === 'L') { cx = num() + ox; cy = num() + oy; push(cx, cy); lastC = null; }
    else if (C === 'H') { cx = num() + ox; push(cx, cy); lastC = null; }
    else if (C === 'V') { cy = num() + oy; push(cx, cy); lastC = null; }
    else if (C === 'C' || C === 'S' || C === 'Q' || C === 'T') {
      let x1: number, y1: number, x2: number, y2: number;
      const prev = cur!.points[cur!.points.length - 1];
      if (C === 'C') { x1 = num() + ox; y1 = num() + oy; x2 = num() + ox; y2 = num() + oy; }
      else if (C === 'S') { x1 = lastC ? 2 * cx - lastC.x : cx; y1 = lastC ? 2 * cy - lastC.y : cy; x2 = num() + ox; y2 = num() + oy; }
      else {
        let qx: number, qy: number;
        if (C === 'Q') { qx = num() + ox; qy = num() + oy; } else { qx = lastC ? 2 * cx - lastC.x : cx; qy = lastC ? 2 * cy - lastC.y : cy; }
        const ex = num() + ox, ey = num() + oy;
        x1 = cx + (2 / 3) * (qx - cx); y1 = cy + (2 / 3) * (qy - cy); x2 = ex + (2 / 3) * (qx - ex); y2 = ey + (2 / 3) * (qy - ey);
        prev.ox = x1; prev.oy = y1;
        cur!.points.push({ x: ex, y: ey, ix: x2, iy: y2, ox: ex, oy: ey, smooth: false });
        cx = ex; cy = ey; lastC = { x: qx, y: qy };
        continue;
      }
      const ex = num() + ox, ey = num() + oy;
      prev.ox = x1; prev.oy = y1;
      cur!.points.push({ x: ex, y: ey, ix: x2, iy: y2, ox: ex, oy: ey, smooth: false });
      cx = ex; cy = ey; lastC = { x: x2, y: y2 };
    } else if (C === 'A') {
      num(); num(); num(); num(); num(); cx = num() + ox; cy = num() + oy; push(cx, cy); lastC = null;
    } else if (C === 'Z') {
      if (cur) {
        const f = cur.points[0], l = cur.points[cur.points.length - 1];
        if (cur.points.length > 1 && Math.abs(f.x - l.x) < 1e-6 && Math.abs(f.y - l.y) < 1e-6) { f.ix = l.ix; f.iy = l.iy; cur.points.pop(); }
        cur.closed = true;
      }
      cx = sx; cy = sy; lastC = null;
    } else i++;
  }
  return m ? transformSubpaths(out, m) : out;
}

/** Trace the alpha>=threshold outline of a canvas into polygon subpaths (marching squares + simplification). */
export function traceAlpha(canvas: HTMLCanvasElement | ImageData, tolerance = 1, threshold = 128, offset: Point = { x: 0, y: 0 }): SubPath[] {
  const img = canvas instanceof ImageData ? canvas : canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height);
  const W = img.width, H = img.height, d = img.data;
  const inside = (x: number, y: number) => x >= 0 && y >= 0 && x < W && y < H && d[(y * W + x) * 4 + 3] >= threshold;
  // collect directed boundary edges around filled pixels (clockwise), then chain them
  const next = new Map<number, number[]>();
  const key = (x: number, y: number) => y * (W + 1) + x;
  const add = (x0: number, y0: number, x1: number, y1: number) => { const k = key(x0, y0); const v = key(x1, y1); const l = next.get(k); if (l) l.push(v); else next.set(k, [v]); };
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (!inside(x, y)) continue;
    if (!inside(x, y - 1)) add(x, y, x + 1, y);
    if (!inside(x + 1, y)) add(x + 1, y, x + 1, y + 1);
    if (!inside(x, y + 1)) add(x + 1, y + 1, x, y + 1);
    if (!inside(x - 1, y)) add(x, y + 1, x, y);
  }
  const out: SubPath[] = [];
  for (const [start] of next) {
    let k = start;
    const loop: Point[] = [];
    let guard = 0;
    while (guard++ < 1e7) {
      const l = next.get(k);
      if (!l || !l.length) break;
      const v = l.pop()!;
      if (!l.length) next.delete(k);
      loop.push({ x: k % (W + 1), y: Math.floor(k / (W + 1)) });
      k = v;
      if (k === start) break;
    }
    if (loop.length < 4) continue;
    const simple = rdp([...loop, loop[0]], tolerance);
    simple.pop();
    if (simple.length >= 3) out.push({ closed: true, points: simple.map(p => corner(p.x + offset.x, p.y + offset.y)) });
  }
  return out;
}
function rdp(pts: Point[], eps: number): Point[] {
  if (pts.length < 3) return pts;
  const a = pts[0], b = pts[pts.length - 1];
  let maxD = -1, idx = 0;
  const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy) || 1;
  for (let i = 1; i < pts.length - 1; i++) {
    const d = Math.abs(dy * pts[i].x - dx * pts[i].y + b.x * a.y - b.y * a.x) / len;
    if (d > maxD) { maxD = d; idx = i; }
  }
  if (maxD <= eps) return [a, b];
  const l = rdp(pts.slice(0, idx + 1), eps), r = rdp(pts.slice(idx), eps);
  return [...l.slice(0, -1), ...r];
}
