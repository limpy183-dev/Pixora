// Shape layers (kind 'shape'): vector subpaths (doc coords) rendered with a fill and a stroke.
// Live shapes (rectangle, ellipse, triangle, polygon, line, custom) keep their parameters so the options bar and the
// Properties panel can edit them after creation (corner radii, sides, star ratio, arrowheads...).
import { Layer, registerLayerClass, type LayerContent } from '../core/layer';
import type { PixDocument } from '../core/document';
import type { Gradient, GradientShape, LayerKind, Rect, RGB } from '../core/types';
import { toPath2D, type PathOp, type SubPath } from '../core/path';
import { createCanvas, ctx2d } from '../core/canvas';
import { gradientLUT, renderGradient } from '../core/gradient';
import { resources } from '../core/registry';
import { toCss } from '../core/color';
import { customShapeSubs, linePolygon, polygonVertices, roundPolygon, roundRect, autoSmooth, transformSubsInPlace, translateSubs, tightBounds } from '../tools/vector/geom';
import { ellipsePath } from '../core/path';

/** Fill / stroke content (Photoshop's "No Color / Solid Color / Gradient / Pattern"). */
export interface Paint {
  type: 'solid' | 'gradient' | 'pattern' | 'none';
  color?: RGB;
  gradient?: Gradient;
  pattern?: string;           // pattern id (resources.patterns)
  angle?: number;             // degrees
  scale?: number;             // percent
  style?: GradientShape;      // gradient style (default linear)
  reverse?: boolean;
}
export interface ShapeStroke {
  enabled: boolean;
  color: RGB;
  width: number;
  align: 'inside' | 'center' | 'outside';
  cap?: 'butt' | 'round' | 'square';
  join?: 'miter' | 'round' | 'bevel';
  dash?: number[];            // in multiples of the stroke width ([] = solid)
  opacity?: number;           // 0..1
  /** Gradient / pattern stroke (solid strokes use `color`). */
  paint?: Paint;
}
export type ShapeType = 'rect' | 'ellipse' | 'triangle' | 'polygon' | 'line' | 'custom';
export interface LiveShape {
  type: ShapeType;
  x: number; y: number; w: number; h: number;   // unrotated box
  angle: number;                                // degrees, around the box centre
  radii: number[];                              // [tl, tr, br, bl] (rect) / [r] (triangle, polygon)
  sides: number; star: number;                  // polygon (star 0..1 = indent)
  smooth: boolean; smoothIndents: boolean;
  x1: number; y1: number; x2: number; y2: number; weight: number;   // line (doc coords)
  arrows: { start: boolean; end: boolean; width: number; length: number; concavity: number };
  shapeId: string;                              // custom shape id
}

export const DEFAULT_ARROWS = { start: false, end: false, width: 500, length: 1000, concavity: 0 };
export function makeLive(type: ShapeType, r: Rect, extra: Partial<LiveShape> = {}): LiveShape {
  return {
    type, x: r.x, y: r.y, w: r.w, h: r.h, angle: 0, radii: [0, 0, 0, 0], sides: 5, star: 0, smooth: false, smoothIndents: false,
    x1: r.x, y1: r.y, x2: r.x + r.w, y2: r.y + r.h, weight: 1, arrows: { ...DEFAULT_ARROWS }, shapeId: '', ...extra,
  };
}

/** Subpaths of a live shape. */
export function liveGeometry(l: LiveShape, op: PathOp = 'add'): SubPath[] {
  const r = { x: l.x, y: l.y, w: l.w, h: l.h };
  let subs: SubPath[];
  switch (l.type) {
    case 'rect': subs = [roundRect(r, l.radii)]; break;
    case 'ellipse': subs = [ellipsePath(r)]; break;
    case 'triangle': subs = [roundPolygon([{ x: r.x + r.w / 2, y: r.y }, { x: r.x + r.w, y: r.y + r.h }, { x: r.x, y: r.y + r.h }], l.radii[0] || 0)]; break;
    case 'polygon': {
      const v = polygonVertices(r, l.sides, l.star);
      const sp = roundPolygon(v, l.radii[0] || 0);
      if (l.smooth || (l.star && l.smoothIndents)) {
        const pts = v.map((p, i) => ({ x: p.x, y: p.y, ix: p.x, iy: p.y, ox: p.x, oy: p.y, smooth: l.star ? (i % 2 ? l.smoothIndents : l.smooth) : l.smooth }));
        const s2: SubPath = { closed: true, points: pts };
        autoSmooth(s2, undefined, 1);
        subs = [s2];
      } else subs = [sp];
      break;
    }
    case 'line': subs = [linePolygon({ x: l.x1, y: l.y1 }, { x: l.x2, y: l.y2 }, l.weight, l.arrows)]; break;
    default: {
      const shape = resources.shapes.find(s => s.id === l.shapeId);
      subs = shape ? customShapeSubs(shape.path, r, op) : [roundRect(r)];
      if (l.angle) rotate(subs, l);
      return subs;
    }
  }
  if (l.angle && l.type !== 'line') rotate(subs, l);
  for (const s of subs) s.op = op;
  return subs;
}
function rotate(subs: SubPath[], l: LiveShape) {
  const cx = l.x + l.w / 2, cy = l.y + l.h / 2;
  transformSubsInPlace(subs, new DOMMatrix().translate(cx, cy).rotate(l.angle).translate(-cx, -cy));
}

// ------------------------------------------------------------------ paint styles
const cpuGradCache = new Map<string, HTMLCanvasElement>();
/** Canvas fill/stroke style for a paint over `box` (doc coords; the context must be in doc space). */
export function paintStyle(ctx: CanvasRenderingContext2D, paint: Paint, box: Rect): string | CanvasGradient | CanvasPattern | null {
  if (paint.type === 'none') return null;
  if (paint.type === 'solid' || (paint.type === 'gradient' && !paint.gradient) || (paint.type === 'pattern' && !paint.pattern)) return toCss(paint.color || { r: 0, g: 0, b: 0 });
  const scale = (paint.scale ?? 100) / 100;
  if (paint.type === 'pattern') {
    const pat = resources.patterns.find(p => p.id === paint.pattern);
    if (!pat) return toCss(paint.color || { r: 0, g: 0, b: 0 });
    const cp = ctx.createPattern(pat.canvas, 'repeat');
    if (!cp) return null;
    cp.setTransform(new DOMMatrix().translate(box.x, box.y).rotate(-(paint.angle || 0)).scale(scale, scale));
    return cp;
  }
  const g = paint.gradient!, style = paint.style || 'linear';
  const ang = ((paint.angle ?? 90) * Math.PI) / 180, dir = { x: Math.cos(ang), y: -Math.sin(ang) };
  const cx = box.x + box.w / 2, cy = box.y + box.h / 2;
  const half = ((Math.abs(box.w * dir.x) + Math.abs(box.h * dir.y)) / 2) * scale || 1;
  const lut = gradientLUT(g, !!paint.reverse, 64);
  const stop = (gr: CanvasGradient, t: number, k: number) => gr.addColorStop(t, `rgba(${lut[k * 4]},${lut[k * 4 + 1]},${lut[k * 4 + 2]},${lut[k * 4 + 3] / 255})`);
  if (style === 'linear' || style === 'reflected') {
    const gr = ctx.createLinearGradient(cx - dir.x * half, cy - dir.y * half, cx + dir.x * half, cy + dir.y * half);
    for (let i = 0; i < 64; i++) {
      const t = i / 63;
      if (style === 'linear') stop(gr, t, i);
      else { stop(gr, 0.5 + t / 2, i); stop(gr, 0.5 - t / 2, i); }
    }
    return gr;
  }
  if (style === 'radial') {
    const rad = (Math.hypot(box.w, box.h) / 2) * scale || 1;
    const gr = ctx.createRadialGradient(cx, cy, 0, cx, cy, rad);
    for (let i = 0; i < 64; i++) stop(gr, i / 63, i);
    return gr;
  }
  if (style === 'angle' && (ctx as any).createConicGradient) {
    const gr: CanvasGradient = (ctx as any).createConicGradient(-ang, cx, cy);
    for (let i = 0; i < 64; i++) stop(gr, i / 63, 63 - i);
    return gr;
  }
  // diamond (or angle fallback): CPU render once per parameters, then use as a pattern
  const w = Math.max(1, Math.ceil(box.w)), h = Math.max(1, Math.ceil(box.h));
  const key = JSON.stringify([g, style, paint.angle, paint.scale, paint.reverse, w, h]);
  let c = cpuGradCache.get(key);
  if (!c) {
    const img = renderGradient(w, h, g, style, { x: w / 2, y: h / 2 }, { x: w / 2 + dir.x * half, y: h / 2 + dir.y * half }, { reverse: paint.reverse });
    c = createCanvas(w, h); ctx2d(c).putImageData(img, 0, 0);
    cpuGradCache.set(key, c);
    if (cpuGradCache.size > 24) cpuGradCache.delete(cpuGradCache.keys().next().value!);
  }
  const cp = ctx.createPattern(c, 'no-repeat');
  cp?.setTransform(new DOMMatrix().translate(Math.floor(box.x), Math.floor(box.y)));
  return cp;
}

/** Build a clip/fill mask of the subpaths honouring sequential path operations (combine/subtract/intersect/exclude). */
export function drawShapeMask(x: CanvasRenderingContext2D, subpaths: SubPath[]) {
  x.fillStyle = '#000';
  let first = true;
  for (const sp of subpaths) {
    if (sp.points.length < 2) continue;
    const op = first ? (sp.op === 'subtract' || sp.op === 'intersect' ? sp.op : 'add') : sp.op || 'add';
    x.globalCompositeOperation = op === 'subtract' ? 'destination-out' : op === 'intersect' ? 'destination-in' : op === 'exclude' ? 'xor' : 'source-over';
    x.fill(toPath2D([sp]), 'nonzero');
    first = false;
  }
  x.globalCompositeOperation = 'source-over';
}

/** Extent of the stroke outside the path (doc px). */
export function strokeExtent(s: ShapeStroke): number {
  if (!s.enabled || s.width <= 0) return 0;
  const lw = s.align === 'center' ? s.width : s.width * 2;
  return s.align === 'inside' ? 0 : (lw / 2) * ((s.join || 'miter') === 'miter' ? 4 : 1);
}

/** Render fill + stroke of subpaths into ctx (ctx in doc space; `box` = tight path bounds). */
export function renderShape(ctx: CanvasRenderingContext2D, subpaths: SubPath[], fill: Paint, stroke: ShapeStroke, area: Rect) {
  const box = tightBounds(subpaths);
  if (!box) return;
  const W = area.w, H = area.h;
  const fstyle = paintStyle(ctx, fill, box);
  const needMask = fstyle || (stroke.enabled && stroke.align !== 'center');
  let mask: HTMLCanvasElement | null = null;
  if (needMask) {
    mask = createCanvas(W, H);
    const mx = ctx2d(mask);
    mx.translate(-area.x, -area.y);
    drawShapeMask(mx, subpaths);
  }
  if (fstyle && mask) {
    const f = createCanvas(W, H), fx = ctx2d(f);
    fx.drawImage(mask, 0, 0);
    fx.globalCompositeOperation = 'source-in';
    fx.translate(-area.x, -area.y);
    fx.fillStyle = fstyle;
    fx.fillRect(area.x, area.y, W, H);
    ctx.drawImage(f, area.x, area.y);
  }
  if (stroke.enabled && stroke.width > 0) {
    const s = createCanvas(W, H), sx = ctx2d(s);
    sx.translate(-area.x, -area.y);
    const lw = stroke.align === 'center' ? stroke.width : stroke.width * 2;
    sx.lineWidth = lw;
    sx.lineCap = stroke.cap || 'butt';
    sx.lineJoin = stroke.join || 'miter';
    sx.miterLimit = 4;
    if (stroke.dash && stroke.dash.length) sx.setLineDash(stroke.dash.map(d => Math.max(0, d) * stroke.width));
    const sp = stroke.paint && stroke.paint.type !== 'solid' && stroke.paint.type !== 'none' ? paintStyle(sx, stroke.paint, box) : toCss(stroke.color);
    sx.strokeStyle = sp || toCss(stroke.color);
    for (const p of subpaths) if (p.points.length > 1) sx.stroke(toPath2D([p]));
    if (mask && stroke.align !== 'center') {
      sx.setTransform(1, 0, 0, 1, 0, 0);
      sx.globalCompositeOperation = stroke.align === 'inside' ? 'destination-in' : 'destination-out';
      sx.drawImage(mask, 0, 0);
    }
    ctx.globalAlpha = stroke.opacity ?? 1;
    ctx.drawImage(s, area.x, area.y);
    ctx.globalAlpha = 1;
  }
}

/** Document area (integer) covered by the rendered shape, clipped to the document (+ margin). */
export function shapeArea(subpaths: SubPath[], stroke: ShapeStroke, doc: { width: number; height: number } | null): Rect | null {
  const b = tightBounds(subpaths);
  if (!b) return null;
  const e = strokeExtent(stroke) + 2;
  let x0 = Math.floor(b.x - e), y0 = Math.floor(b.y - e), x1 = Math.ceil(b.x + b.w + e), y1 = Math.ceil(b.y + b.h + e);
  if (doc) { x0 = Math.max(x0, -2); y0 = Math.max(y0, -2); x1 = Math.min(x1, doc.width + 2); y1 = Math.min(y1, doc.height + 2); }
  if (x1 <= x0 || y1 <= y0) return null;
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

// ------------------------------------------------------------------ layer
export class ShapeLayer extends Layer {
  kind: LayerKind = 'shape';
  subpaths: SubPath[] = [];
  fill: Paint = { type: 'solid', color: { r: 0, g: 0, b: 0 } };
  stroke: ShapeStroke = { enabled: false, color: { r: 0, g: 0, b: 0 }, width: 1, align: 'inside', cap: 'butt', join: 'miter', dash: [], opacity: 1 };
  /** Live shape parameters (null = regular path). */
  live: LiveShape | null = null;
  _cache: { v: number; dw: number; dh: number; content: LayerContent | null } | null = null;

  constructor(name = 'Shape 1') {
    super();
    this.name = name;
  }
  get shapeType(): ShapeType { return this.live?.type ?? 'custom'; }

  getContent(doc: PixDocument): LayerContent | null {
    const c = this._cache;
    if (c && c.v === this._version && c.dw === doc.width && c.dh === doc.height) return c.content;
    const area = shapeArea(this.subpaths, this.stroke, doc);
    let content: LayerContent | null = null;
    if (area) {
      const canvas = createCanvas(area.w, area.h), x = ctx2d(canvas);
      x.translate(-area.x, -area.y);
      renderShape(x, this.subpaths, this.fill, this.stroke, area);
      content = { canvas, x: area.x, y: area.y };
    }
    this._cache = { v: this._version, dw: doc.width, dh: doc.height, content };
    return content;
  }

  /** Tight vector bounds (doc coords). */
  pathBounds(): Rect | null { return tightBounds(this.subpaths); }

  translate(dx: number, dy: number) {
    translateSubs(this.subpaths, dx, dy);
    const l = this.live;
    if (l) { l.x += dx; l.y += dy; l.x1 += dx; l.y1 += dy; l.x2 += dx; l.y2 += dy; }
    if (this.mask && this.mask.linked) { this.mask.x += dx; this.mask.y += dy; }
    this.invalidate();
  }

  applyMatrix(m: DOMMatrix) {
    transformSubsInPlace(this.subpaths, m);
    const l = this.live;
    if (l) {
      const sx = Math.hypot(m.a, m.b), sy = Math.hypot(m.c, m.d), ortho = Math.abs(m.a * m.c + m.b * m.d) < 1e-6 * sx * sy;
      const det = m.a * m.d - m.b * m.c;
      if (l.type === 'line') {
        const p1 = m.transformPoint(new DOMPoint(l.x1, l.y1)), p2 = m.transformPoint(new DOMPoint(l.x2, l.y2));
        l.x1 = p1.x; l.y1 = p1.y; l.x2 = p2.x; l.y2 = p2.y;
        if (Math.abs(sx - sy) < 1e-6 * sx) l.weight *= sx; else this.live = null;
      } else if (!ortho || det < 0) this.live = null;
      else {
        const rot = (Math.atan2(m.b, m.a) * 180) / Math.PI;
        if (Math.abs(rot) > 1e-6 && Math.abs(sx - sy) > 1e-6 * sx) this.live = null;
        else {
          const c = m.transformPoint(new DOMPoint(l.x + l.w / 2, l.y + l.h / 2));
          // scale in the shape's own (rotated) frame
          const a = (l.angle * Math.PI) / 180, ux = Math.cos(a), uy = Math.sin(a);
          const kx = Math.hypot(m.a * ux + m.c * uy, m.b * ux + m.d * uy), ky = Math.hypot(-m.a * uy + m.c * ux, -m.b * uy + m.d * ux);
          l.w *= kx; l.h *= ky;
          l.radii = l.radii.map(r => r * Math.min(kx, ky));
          l.x = c.x - l.w / 2; l.y = c.y - l.h / 2;
          l.angle = ((l.angle + rot) % 360 + 360) % 360;
          if (l.angle > 180) l.angle -= 360;
        }
      }
    }
    if (this.mask && this.mask.linked && m.b === 0 && m.c === 0 && m.a === 1 && m.d === 1) { this.mask.x += m.e; this.mask.y += m.f; }
    this.invalidate();
  }

  /** Regenerate the subpaths from `live` (after editing live properties). Keeps the combine op of the first subpath. */
  rebuildFromLive() {
    if (!this.live) return;
    this.subpaths = liveGeometry(this.live, this.subpaths[0]?.op || 'add');
    this.invalidate();
  }
}

registerLayerClass('shape', ShapeLayer as any);

const TYPE_NAMES: Record<ShapeType, string> = { rect: 'Rectangle', ellipse: 'Ellipse', triangle: 'Triangle', polygon: 'Polygon', line: 'Line', custom: 'Shape' };
/** Photoshop-style next name: "Rectangle 1", "Rectangle 2"... */
export function nextShapeName(doc: PixDocument, type: ShapeType): string {
  const base = TYPE_NAMES[type];
  let max = 0;
  const re = new RegExp(`^${base} (\\d+)$`);
  for (const l of doc.allLayers()) { const m = l.name.match(re); if (m) max = Math.max(max, +m[1]); }
  return `${base} ${max + 1}`;
}
export const isShapeLayer = (l: Layer | null | undefined): l is ShapeLayer => !!l && l.kind === 'shape' && Array.isArray((l as any).subpaths);
