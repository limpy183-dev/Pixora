// Shape tools (U): Rectangle, Ellipse, Triangle, Polygon, Line, Custom Shape.
// Modes: Shape (live shape layers), Path (Work Path) and Pixels (rasterized into the active layer).
import { app, type Tool, type ToolPointer } from '../../core/app';
import type { PixDocument } from '../../core/document';
import type { Point, Rect } from '../../core/types';
import type { PathOp, SubPath } from '../../core/path';
import { toPath2D } from '../../core/path';
import { snap45 } from '../../core/geom';
import { unionRect } from '../../core/geom';
import { resources } from '../../core/registry';
import { toCss } from '../../core/color';
import { h } from '../../ui/dom';
import { icon } from '../../ui/icons';
import { CURSORS, svgCursor } from '../../ui/cursors';
import { openDialog } from '../../ui/dialog';
import { toast } from '../../ui/toast';
import { checkbox, label, numberField, select, separator, showPop } from '../../ui/widgets';
import {
  DEFAULT_ARROWS, ShapeLayer, isShapeLayer, liveGeometry, makeLive, nextShapeName, shapeArea, type LiveShape, type ShapeType,
} from '../../layers/shape-layer';
import {
  drawHud, layerTarget, pathForDrawing, pathTarget, setPathSel, targetOf, touchDone, type Target,
} from './common';
import {
  alignButton, alignEdgesBox, arrangeButton, gearButton, modeSelect, newLayerStyle, onVectorChange, opsButton, selectedShapes,
  sizeControls, styleControls, type OpSetting,
} from './options';
import { fillPathPixels } from './raster';
import { customShapeSubs, tightBounds } from './geom';
import './resources';

type Constrain = 'none' | 'square' | 'fixed' | 'proportional' | 'defined' | 'defined-size';
interface ShapeSettings {
  mode: 'shape' | 'path' | 'pixels';
  op: OpSetting;
  alignEdges: boolean;
  radius: number;
  sides: number; star: number; smoothCorners: boolean; smoothIndents: boolean;
  weight: number;
  arrows: { start: boolean; end: boolean; width: number; length: number; concavity: number };
  shapeId: string;
  constrain: Constrain; fixedW: number; fixedH: number; propW: number; propH: number; fromCenter: boolean;
  pxOpacity: number; pxBlend: string; pxAntiAlias: boolean;
}
const baseSettings = (extra: Partial<ShapeSettings> = {}): ShapeSettings => ({
  mode: 'shape', op: 'new', alignEdges: true, radius: 0, sides: 5, star: 0, smoothCorners: false, smoothIndents: false, weight: 1,
  arrows: { ...DEFAULT_ARROWS }, shapeId: 'heart', constrain: 'none', fixedW: 100, fixedH: 100, propW: 1, propH: 1, fromCenter: false,
  pxOpacity: 100, pxBlend: 'normal', pxAntiAlias: true, ...extra,
});

const TOOL_TYPE: Record<string, ShapeType> = {
  'shape-rect': 'rect', 'shape-ellipse': 'ellipse', 'shape-triangle': 'triangle', 'shape-polygon': 'polygon', 'shape-line': 'line', 'shape-custom': 'custom',
};
const TOOL_NAMES: Record<ShapeType, string> = { rect: 'Rectangle Tool', ellipse: 'Ellipse Tool', triangle: 'Triangle Tool', polygon: 'Polygon Tool', line: 'Line Tool', custom: 'Custom Shape Tool' };

// ------------------------------------------------------------------ helpers shared with the pen tool
/** Create a new shape layer (above the active layer) with the current fill/stroke style. Call inside a history action. */
export function newShapeLayer(doc: PixDocument, type: ShapeType, subpaths: SubPath[], live: LiveShape | null): ShapeLayer {
  const l = new ShapeLayer(nextShapeName(doc, type));
  const st = newLayerStyle();
  l.fill = st.fill;
  l.stroke = st.stroke;
  l.subpaths = subpaths;
  l.live = live;
  doc.addLayer(l);
  return l;
}

/** Live shape for a tool + drag box / line. */
function liveFor(type: ShapeType, s: ShapeSettings, r: Rect, line?: { a: Point; b: Point }): LiveShape {
  const rad = Math.max(0, s.radius);
  if (type === 'line' && line) {
    const box = { x: Math.min(line.a.x, line.b.x), y: Math.min(line.a.y, line.b.y), w: Math.abs(line.b.x - line.a.x), h: Math.abs(line.b.y - line.a.y) };
    return makeLive('line', box, { x1: line.a.x, y1: line.a.y, x2: line.b.x, y2: line.b.y, weight: Math.max(0.1, s.weight), arrows: { ...s.arrows } });
  }
  return makeLive(type, r, {
    radii: [rad, rad, rad, rad], sides: Math.max(3, Math.round(s.sides)), star: Math.max(0, Math.min(0.99, s.star / 100)),
    smooth: s.smoothCorners, smoothIndents: s.smoothIndents, shapeId: s.shapeId,
  });
}

// ------------------------------------------------------------------ drawing state
interface DrawState {
  tool: Tool; type: ShapeType; s: ShapeSettings;
  start: Point; cur: Point; last: Point;
  moved: boolean; space: boolean;
  mode: 'shape' | 'path' | 'pixels';
  op: PathOp | 'new';
  txn: ReturnType<PixDocument['history']['begin']> | null;
  layer: ShapeLayer | null;
  target: Target | null;
  subStart: number; subCount: number;
  preview: SubPath[];
  prevArea: Rect | null;
  hud: string[];
}
let drag: DrawState | null = null;
let radiusDrag: { layer: ShapeLayer; corner: number; txn: ReturnType<PixDocument['history']['begin']>; alt: boolean } | null = null;

/** Geometry box from the drag, honouring Shift (constrain), Alt (from centre) and the gear constraints. */
function dragBox(d: DrawState, p: ToolPointer): Rect {
  const s = d.s, a = d.start;
  let dx = d.cur.x - a.x, dy = d.cur.y - a.y;
  const fromCenter = p.alt || s.fromCenter;
  const sgn = (v: number) => (v < 0 ? -1 : 1);
  let aspect = 0;
  if (s.constrain === 'square' || p.shift) aspect = d.type === 'triangle' && p.shift ? Math.sqrt(3) / 2 : 1;
  if (s.constrain === 'proportional' && s.propW > 0 && s.propH > 0) aspect = s.propH / s.propW;
  if (d.type === 'custom' && (p.shift || s.constrain === 'defined')) aspect = customRatio(s);
  if (aspect) {
    const m = Math.max(Math.abs(dx), Math.abs(dy) / aspect);
    dx = sgn(dx) * m; dy = sgn(dy) * m * aspect;
  }
  if (s.constrain === 'fixed' || (d.type === 'custom' && s.constrain === 'defined-size')) {
    const fw = d.type === 'custom' && s.constrain === 'defined-size' ? 100 : s.fixedW, fh = d.type === 'custom' && s.constrain === 'defined-size' ? 100 * customRatio(s) : s.fixedH;
    dx = sgn(dx) * fw; dy = sgn(dy) * fh;
  }
  let r: Rect = fromCenter ? { x: a.x - dx, y: a.y - dy, w: dx * 2, h: dy * 2 } : { x: a.x, y: a.y, w: dx, h: dy };
  if (r.w < 0) r = { ...r, x: r.x + r.w, w: -r.w };
  if (r.h < 0) r = { ...r, y: r.y + r.h, h: -r.h };
  if (s.alignEdges) { const x0 = Math.round(r.x), y0 = Math.round(r.y); r = { x: x0, y: y0, w: Math.round(r.x + r.w) - x0, h: Math.round(r.y + r.h) - y0 }; }
  return r;
}
function customRatio(s: ShapeSettings): number {
  const shape = resources.shapes.find(x => x.id === s.shapeId);
  return shape ? rawRatio(shape.path) : 1;
}
const ratioCache = new Map<string, number>();
function rawRatio(d: string): number {
  let r = ratioCache.get(d);
  if (r === undefined) {
    // ratio of the shape's own coordinates (before fitting into a box)
    const nums = d.match(/-?\d*\.?\d+(?:e[-+]?\d+)?/g)?.map(Number) || [];
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    const cmds = d.match(/[a-zA-Z]/g) || [];
    // absolute commands only in presets; take coordinate pairs
    if (cmds.every(c => c === c.toUpperCase() && c !== 'H' && c !== 'V' && c !== 'A')) {
      for (let i = 0; i + 1 < nums.length; i += 2) { x0 = Math.min(x0, nums[i]); x1 = Math.max(x1, nums[i]); y0 = Math.min(y0, nums[i + 1]); y1 = Math.max(y1, nums[i + 1]); }
    }
    r = x1 > x0 && y1 > y0 ? (y1 - y0) / (x1 - x0) : 1;
    ratioCache.set(d, r);
  }
  return r;
}

function lineEnds(d: DrawState, p: ToolPointer): { a: Point; b: Point } {
  let b = p.shift ? snap45(d.start, d.cur) : d.cur;
  let a = d.start;
  if (d.s.alignEdges) { a = { x: Math.round(a.x), y: Math.round(a.y) }; b = { x: Math.round(b.x), y: Math.round(b.y) }; }
  return { a, b };
}

function geometry(d: DrawState, p: ToolPointer): { subs: SubPath[]; live: LiveShape; box: Rect } {
  const box = dragBox(d, p);
  const line = d.type === 'line' ? lineEnds(d, p) : undefined;
  const live = liveFor(d.type, d.s, box, line);
  const op: PathOp = d.op === 'new' ? 'add' : d.op;
  return { subs: liveGeometry(live, op), live, box };
}

function fmt(v: number) { return `${Math.round(v * 10) / 10} px`; }

function updateDraw(d: DrawState, p: ToolPointer, doc: PixDocument) {
  const g = geometry(d, p);
  d.hud = d.type === 'line'
    ? [`L: ${fmt(Math.hypot(g.live.x2 - g.live.x1, g.live.y2 - g.live.y1))}`, `∠: ${Math.round((-Math.atan2(g.live.y2 - g.live.y1, g.live.x2 - g.live.x1) * 180) / Math.PI * 10) / 10}°`]
    : [`W: ${fmt(g.box.w)}`, `H: ${fmt(g.box.h)}`];
  if (d.mode === 'pixels') { d.preview = g.subs; doc.redrawOverlay(); return; }
  if (!d.txn) {
    d.txn = doc.history.begin(TOOL_NAMES[d.type]);
    if (d.mode === 'shape') {
      const active = doc.activeLayer;
      if (d.op !== 'new' && isShapeLayer(active)) {
        d.layer = active;
        d.subStart = active.subpaths.length;
        active.live = null;
      } else {
        d.layer = newShapeLayer(doc, d.type, [], null);
        d.subStart = 0;
      }
      d.target = layerTarget(d.layer);
      setPathSel(doc, 0);
    } else {
      const path = pathForDrawing(doc);
      d.target = pathTarget(path);
      d.subStart = path.subpaths.length;
    }
    d.subCount = 0;
  }
  const holder = d.target!.holder;
  holder.subpaths.splice(d.subStart, d.subCount, ...g.subs);
  d.subCount = g.subs.length;
  if (d.layer) {
    if (d.subStart === 0 && holder.subpaths.length === g.subs.length) d.layer.live = g.live;
    d.layer.invalidate();
    const area = shapeArea(d.layer.subpaths, d.layer.stroke, doc);
    doc.invalidate(unionRect(d.prevArea, area) || undefined);
    d.prevArea = area;
  }
  doc.redrawOverlay();
}

// ------------------------------------------------------------------ click → "Create …" dialog
function createDialog(doc: PixDocument, tool: Tool, type: ShapeType, s: ShapeSettings, at: Point) {
  const v = { w: 100, h: 100, r: [s.radius, s.radius, s.radius, s.radius], center: s.fromCenter, sides: s.sides, star: s.star, smooth: s.smoothIndents, len: 100, angle: 0, weight: s.weight, keep: true };
  const rows: HTMLElement[] = [];
  const num = (lab: string, val: number, set: (x: number) => void, o: { min?: number; max?: number; unit?: string; decimals?: number } = {}) =>
    rows.push(h('div.form-row', null, h('label.form-label', null, lab), numberField(val, set, { min: o.min ?? 0, max: o.max ?? 300000, unit: o.unit ?? 'px', decimals: o.decimals ?? 2, width: 80 })));
  if (type === 'line') {
    num('Length:', v.len, x => { v.len = x; }, { min: 1 });
    num('Angle:', v.angle, x => { v.angle = x; }, { min: -360, max: 360, unit: '°' });
    num('Weight:', v.weight, x => { v.weight = x; }, { min: 0.1, max: 1000 });
  } else {
    num('Width:', v.w, x => { v.w = x; }, { min: 1 });
    num('Height:', v.h, x => { v.h = x; }, { min: 1 });
    if (type === 'rect') {
      const radii = h('div.vo-dlg-grid', null, ...v.r.map((r, i) => numberField(r, x => { v.r[i] = x; }, { min: 0, max: 100000, unit: 'px', decimals: 2, width: 70, title: ['Top left', 'Top right', 'Bottom right', 'Bottom left'][i] })));
      rows.push(h('div.form-row', null, h('label.form-label', null, 'Radii:'), radii));
    }
    if (type === 'triangle') num('Corner Radius:', v.r[0], x => { v.r = [x, x, x, x]; });
    if (type === 'polygon') {
      num('Number of Sides:', v.sides, x => { v.sides = x; }, { min: 3, max: 100, unit: '', decimals: 0 });
      num('Corner Radius:', v.r[0], x => { v.r = [x, x, x, x]; });
      num('Star Ratio:', v.star, x => { v.star = x; }, { min: 0, max: 99, unit: '%', decimals: 0 });
      rows.push(h('div.form-row', null, h('label.form-label', null, ''), checkbox('Smooth Star Indents', v.smooth, x => { v.smooth = x; })));
    }
    if (type === 'custom') rows.push(h('div.form-row', null, h('label.form-label', null, ''), checkbox('Preserve Proportions', v.keep, x => { v.keep = x; })));
    rows.push(h('div.form-row', null, h('label.form-label', null, ''), checkbox('From Center', v.center, x => { v.center = x; })));
  }
  const title = { rect: 'Create Rectangle', ellipse: 'Create Ellipse', triangle: 'Create Triangle', polygon: 'Create Polygon', line: 'Create Line', custom: 'Create Custom Shape' }[type];
  openDialog({ title, body: h('div.form', null, ...rows), width: 360 }).result.then(ok => {
    if (!ok) return;
    const s2: ShapeSettings = { ...s, radius: v.r[0], sides: v.sides, star: v.star, smoothIndents: v.smooth, weight: v.weight };
    let live: LiveShape;
    if (type === 'line') {
      const a = (-v.angle * Math.PI) / 180, b = { x: at.x + Math.cos(a) * v.len, y: at.y + Math.sin(a) * v.len };
      live = liveFor('line', s2, { x: 0, y: 0, w: 0, h: 0 }, { a: at, b });
    } else {
      let w = v.w, hh = v.h;
      if (type === 'custom' && v.keep) hh = w * customRatio(s);
      const r = v.center ? { x: at.x - w / 2, y: at.y - hh / 2, w, h: hh } : { x: at.x, y: at.y, w, h: hh };
      live = liveFor(type, s2, r);
      if (type === 'rect') live.radii = v.r.slice();
    }
    commitShape(doc, type, s, live);
  });
}

/** Create a finished shape (dialog / Shapes panel drop) honouring the tool mode + path operation. */
export function commitShape(doc: PixDocument, type: ShapeType, s: { mode: string; op: OpSetting; pxOpacity?: number; pxBlend?: string; pxAntiAlias?: boolean }, live: LiveShape) {
  const op: PathOp = s.op === 'new' ? 'add' : s.op;
  const subs = liveGeometry(live, op);
  const name = TOOL_NAMES[type];
  if (s.mode === 'pixels') {
    fillPathPixels(doc, subs, { color: app.fg, opacity: (s.pxOpacity ?? 100) / 100, blend: (s.pxBlend || 'normal') as any, antiAlias: s.pxAntiAlias !== false, feather: 0 }, name);
    return;
  }
  doc.history.transaction(name, () => {
    if (s.mode === 'path') {
      const p = pathForDrawing(doc);
      p.subpaths.push(...subs);
      return;
    }
    const active = doc.activeLayer;
    if (s.op !== 'new' && isShapeLayer(active)) { active.live = null; active.subpaths.push(...subs); active.invalidate(); }
    else newShapeLayer(doc, type, subs, live);
  });
  if (s.mode === 'shape') setPathSel(doc, 0);
  touchDone(doc, targetOf(doc));
}

// ------------------------------------------------------------------ live corner radius handles (rectangles)
function radiusHandles(l: ShapeLayer): { x: number; y: number; corner: number }[] {
  const lv = l.live;
  if (!lv || lv.type !== 'rect' || lv.w < 4 || lv.h < 4) return [];
  const z = app.viewport?.zoom || 1;
  const cx = lv.x + lv.w / 2, cy = lv.y + lv.h / 2;
  const m = new DOMMatrix().translate(cx, cy).rotate(lv.angle).translate(-cx, -cy);
  const min = Math.min(lv.w, lv.h) / 2;
  const corners: [number, number, number, number][] = [[lv.x, lv.y, 1, 1], [lv.x + lv.w, lv.y, -1, 1], [lv.x + lv.w, lv.y + lv.h, -1, -1], [lv.x, lv.y + lv.h, 1, -1]];
  return corners.map(([x, y, sx, sy], i) => {
    const off = Math.min(min, Math.max(lv.radii[i] || 0, 14 / z));
    const p = m.transformPoint(new DOMPoint(x + sx * off, y + sy * off));
    return { x: p.x, y: p.y, corner: i };
  });
}
function hitRadius(doc: PixDocument, p: ToolPointer): { layer: ShapeLayer; corner: number } | null {
  const l = doc.activeLayer;
  if (!isShapeLayer(l) || l.locks.all || l.positionLocked && l.locks.all) return null;
  const tol = 6 / (app.viewport?.zoom || 1);
  for (const hnd of radiusHandles(l)) if (Math.hypot(hnd.x - p.x, hnd.y - p.y) <= tol) return { layer: l, corner: hnd.corner };
  return null;
}
export function drawRadiusHandles(ctx: CanvasRenderingContext2D, doc: PixDocument) {
  const l = doc.activeLayer;
  if (!isShapeLayer(l)) return;
  const v = app.viewport!;
  for (const hnd of radiusHandles(l)) {
    const s = v.docToScreen(hnd.x, hnd.y);
    ctx.beginPath(); ctx.arc(s.x, s.y, 4, 0, Math.PI * 2);
    ctx.fillStyle = '#fff'; ctx.fill();
    ctx.lineWidth = 1.5; ctx.strokeStyle = '#1473e6'; ctx.stroke();
    ctx.beginPath(); ctx.arc(s.x, s.y, 1.5, 0, Math.PI * 2); ctx.fillStyle = '#1473e6'; ctx.fill();
  }
}
/** Pointer handling for the radius handles (used by shape tools and path selection). Returns true if it took the drag. */
export function radiusPointerDown(p: ToolPointer, doc: PixDocument): boolean {
  const hit = hitRadius(doc, p);
  if (!hit) return false;
  radiusDrag = { ...hit, txn: doc.history.begin('Change Corner Radius'), alt: p.alt };
  return true;
}
export function radiusPointerMove(p: ToolPointer, doc: PixDocument): boolean {
  if (!radiusDrag) return false;
  const l = radiusDrag.layer, lv = l.live;
  if (!lv) return true;
  const cx = lv.x + lv.w / 2, cy = lv.y + lv.h / 2;
  const inv = new DOMMatrix().translate(cx, cy).rotate(-lv.angle).translate(-cx, -cy);
  const q = inv.transformPoint(new DOMPoint(p.x, p.y));
  const corners = [[lv.x, lv.y], [lv.x + lv.w, lv.y], [lv.x + lv.w, lv.y + lv.h], [lv.x, lv.y + lv.h]];
  const [kx, ky] = corners[radiusDrag.corner];
  const r = Math.max(0, Math.min(Math.min(lv.w, lv.h) / 2, (Math.abs(q.x - kx) + Math.abs(q.y - ky)) / 2));
  const rr = Math.round(r * 100) / 100;
  if (radiusDrag.alt) lv.radii[radiusDrag.corner] = rr; else lv.radii = [rr, rr, rr, rr];
  l.rebuildFromLive();
  doc.invalidate();
  return true;
}
export function radiusPointerUp(doc: PixDocument): boolean {
  if (!radiusDrag) return false;
  radiusDrag.txn.commit();
  radiusDrag = null;
  doc.layersChanged();
  return true;
}
export const radiusCursor = (doc: PixDocument | null): string | null => {
  const v = app.viewport;
  if (!doc || !v) return null;
  const p = { x: v.pointer.x, y: v.pointer.y } as ToolPointer;
  return hitRadius(doc, p) ? RADIUS_CURSOR : null;
};
const RADIUS_CURSOR = svgCursor('<circle cx="12" cy="12" r="6"/><path d="M12 12h8"/>', 12, 12, 'pointer');

// ------------------------------------------------------------------ custom shape picker
export function shapeThumb(pathData: string, size = 30): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '-4 -4 108 108');
  svg.setAttribute('width', String(size)); svg.setAttribute('height', String(size));
  const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  const ratio = rawRatio(pathData);
  const w = ratio > 1 ? 100 / ratio : 100, hh = ratio > 1 ? 100 : 100 * ratio;
  const fitted = customShapeSubs(pathData, { x: (100 - w) / 2, y: (100 - hh) / 2, w, h: hh });
  p.setAttribute('d', svgD(fitted));
  p.setAttribute('fill', 'currentColor');
  p.setAttribute('fill-rule', 'evenodd');
  svg.append(p);
  return svg;
}
function svgD(subs: SubPath[]): string {
  const f = (v: number) => (Math.round(v * 10) / 10).toString();
  let out = '';
  for (const sp of subs) {
    const pts = sp.points;
    if (!pts.length) continue;
    out += `M${f(pts[0].x)} ${f(pts[0].y)}`;
    const n = pts.length;
    for (let i = 1; i <= (sp.closed ? n : n - 1); i++) {
      const a = pts[i - 1], b = pts[i % n];
      out += `C${f(a.ox)} ${f(a.oy)} ${f(b.ix)} ${f(b.iy)} ${f(b.x)} ${f(b.y)}`;
    }
    out += 'Z';
  }
  return out;
}
function shapePicker(s: ShapeSettings, tool: Tool): HTMLElement {
  const cur = () => resources.shapes.find(x => x.id === s.shapeId) || resources.shapes[0];
  const btn = h('button.vo-shape-picker', { type: 'button', title: 'Set shape to use in the custom shape tool', 'data-menu-anchor': '' });
  const paint = () => { const c = cur(); btn.replaceChildren(c ? shapeThumb(c.path, 20) : icon('shape-custom', 20), h('span.select-caret', null, icon('chevron-down', 12))); btn.title = c ? `Shape: ${c.name}` : 'Shape'; };
  paint();
  btn.onclick = () => {
    const grid = h('div.vo-shape-grid');
    const groups = new Map<string, typeof resources.shapes>();
    for (const sh of resources.shapes) { const g = (sh as any).group || 'Shapes'; if (!groups.has(g)) groups.set(g, []); groups.get(g)!.push(sh); }
    for (const [g, list] of groups) {
      grid.append(h('div.vo-group-title', null, g));
      for (const sh of list) {
        const cell = h('button.vo-shape-cell', { type: 'button', title: sh.name, class: sh.id === s.shapeId ? 'on' : '' }, shapeThumb(sh.path));
        cell.onclick = () => { s.shapeId = sh.id; app.saveToolSettings(tool); paint(); close(); };
        grid.append(cell);
      }
    }
    const close = showPop(h('div.vo-shape-pop', null, h('div.vo-pop-title', null, 'Shapes'), grid), btn);
  };
  return btn;
}
export function setCustomShape(id: string) {
  const t = app.getTool('shape-custom');
  if (!t?.settings) return;
  t.settings.shapeId = id;
  app.saveToolSettings(t);
}

// ------------------------------------------------------------------ tool factory
function makeShapeTool(id: string, name: string, iconName: string, order: number, s: ShapeSettings): Tool {
  const type = TOOL_TYPE[id];
  const tool: Tool = {
    id, name, group: 'shape', icon: iconName, shortcut: 'U', order, settings: s,
    cursor: doc => radiusCursor(doc) || CURSORS.crosshair,
    options(bar) {
      const rebuild = () => (document.querySelector('.optionsbar') as any)?.rebuild?.();
      const mode = modeSelect(s, tool, ['shape', 'path', 'pixels'], rebuild);
      const els: (HTMLElement | SVGElement)[] = [mode, separator()];
      let sync = () => {};
      if (s.mode === 'shape') {
        const st = styleControls(), sz = sizeControls();
        els.push(...st.els, separator(), ...sz.els, separator());
        sync = () => { st.sync(); sz.sync(); };
      } else if (s.mode === 'path') {
        const mk = (text: string, cmd: string, tip: string) => h('button.btn', { type: 'button', title: tip, onclick: () => import('../../core/commands').then(m => m.runCommand(cmd)) }, text);
        els.push(label('Make:'), h('span.vo-make', null, mk('Selection…', 'paths.makeSelection', 'Make a selection from the path'), mk('Mask', 'paths.addMask', 'Add a vector mask from the path'), mk('Shape', 'paths.makeShape', 'Make a shape layer from the path')), separator());
      } else {
        const blend = select(['normal', 'multiply', 'screen', 'overlay', 'darken', 'lighten', 'color-burn', 'color-dodge', 'soft-light', 'hard-light', 'difference', 'exclusion', 'hue', 'saturation', 'color', 'luminosity'].map(v => ({ value: v, label: v.replace(/(^|-)(\w)/g, (_m, a, b) => (a ? ' ' : '') + b.toUpperCase()) })), s.pxBlend, v => { s.pxBlend = v; app.saveToolSettings(tool); }, { width: 96, title: 'Blending mode' });
        const op = numberField(s.pxOpacity, v => { s.pxOpacity = v; app.saveToolSettings(tool); }, { min: 1, max: 100, unit: '%', width: 48, label: 'Opacity:' });
        els.push(label('Mode:'), blend, op, checkbox('Anti-alias', s.pxAntiAlias, v => { s.pxAntiAlias = v; app.saveToolSettings(tool); }), separator());
      }
      if (s.mode !== 'pixels') els.push(opsButton(tool, s, s.mode === 'shape'), alignButton(), arrangeButton());
      els.push(gearButton('Set additional shape and path options', () => gearExtras(type, s, tool)));
      if (type === 'rect' || type === 'triangle' || type === 'polygon') {
        const rad = numberField(s.radius, v => {
          s.radius = v; app.saveToolSettings(tool);
          const d = app.activeDoc, l = d?.activeLayer;
          if (d && isShapeLayer(l) && l.live && l.live.type === type) {
            d.history.transaction('Change Corner Radius', () => { l.live!.radii = [v, v, v, v]; l.rebuildFromLive(); });
            d.layersChanged();
          }
        }, { min: 0, max: 10000, unit: 'px', decimals: 2, width: 60, title: 'Set radius of rounded corners' });
        els.push(h('span.opt-gap'), icon('corner-radius', 16), rad);
      }
      if (type === 'polygon') {
        els.push(h('span.opt-gap'), numberField(s.sides, v => {
          s.sides = v; app.saveToolSettings(tool);
          const d = app.activeDoc, l = d?.activeLayer;
          if (d && isShapeLayer(l) && l.live?.type === 'polygon') { d.history.transaction('Change Number of Sides', () => { l.live!.sides = v; l.rebuildFromLive(); }); d.layersChanged(); }
        }, { min: 3, max: 100, width: 40, label: '#', title: 'Set number of sides' }));
      }
      if (type === 'line') {
        els.push(h('span.opt-gap'), numberField(s.weight, v => {
          s.weight = v; app.saveToolSettings(tool);
          const d = app.activeDoc, l = d?.activeLayer;
          if (d && isShapeLayer(l) && l.live?.type === 'line') { d.history.transaction('Change Line Weight', () => { l.live!.weight = v; l.rebuildFromLive(); }); d.layersChanged(); }
        }, { min: 0.1, max: 1000, decimals: 2, unit: 'px', width: 60, label: 'Weight:', title: 'Set line weight' }));
      }
      if (type === 'custom') els.push(h('span.opt-gap'), label('Shape:'), shapePicker(s, tool));
      if (s.mode !== 'pixels') els.push(separator(), alignEdgesBox(s, tool));
      bar.append(...els);
      sync();
      return onVectorChange(sync);
    },
    pointerDown(p, doc) {
      if (s.mode !== 'pixels' && radiusPointerDown(p, doc)) return;
      if (s.mode === 'pixels') {
        const t = doc.getPaintTarget();
        if (!t) { toast('Could not use the shape tool because the target layer is not a pixel layer. Choose Shape or Path mode or select a pixel layer.', 'error', 3600); return; }
        if (t.kind === 'pixels' && t.layer!.pixelsLocked) { toast('Could not use the shape tool because the layer is locked.', 'error'); return; }
      }
      const active = doc.activeLayer;
      let op: PathOp | 'new' = s.op;
      const hasTarget = s.mode === 'path' ? true : isShapeLayer(active);
      if (hasTarget && (p.shift || p.alt)) op = p.shift && p.alt ? 'intersect' : p.shift ? 'add' : 'subtract';
      if (s.mode === 'path' && op === 'new') op = 'add';
      if (s.mode === 'shape' && op !== 'new' && !isShapeLayer(active)) op = 'new';
      if (s.mode === 'shape' && op !== 'new' && active?.locks.all) { toast('Could not edit the shape because the layer is locked.', 'error'); return; }
      const start = { x: p.x, y: p.y };
      drag = {
        tool, type, s, start, cur: start, last: start, moved: false, space: false, mode: s.mode, op,
        txn: null, layer: null, target: null, subStart: 0, subCount: 0, preview: [], prevArea: null, hud: [],
      };
      // modifiers used to pick the operation must not also constrain at the start
      (drag as any).opMods = { shift: p.shift, alt: p.alt };
    },
    pointerMove(p, doc) {
      if (radiusPointerMove(p, doc)) return;
      const d = drag;
      if (!d) return;
      const pt = { x: p.x, y: p.y };
      if (d.space) { d.start = { x: d.start.x + pt.x - d.last.x, y: d.start.y + pt.y - d.last.y }; }
      d.last = pt;
      d.cur = pt;
      const z = app.viewport?.zoom || 1;
      if (!d.moved && Math.hypot(pt.x - d.start.x, pt.y - d.start.y) * z < 3) return;
      d.moved = true;
      updateDraw(d, p, doc);
    },
    pointerUp(p, doc) {
      if (radiusPointerUp(doc)) return;
      const d = drag;
      drag = null;
      if (!d) return;
      if (!d.moved) { createDialog(doc, tool, type, s, { x: p.x, y: p.y }); return; }
      if (d.mode === 'pixels') {
        const subs = d.preview;
        d.preview = [];
        doc.redrawOverlay();
        if (subs.length) fillPathPixels(doc, subs, { color: app.fg, opacity: s.pxOpacity / 100, blend: s.pxBlend as any, antiAlias: s.pxAntiAlias, feather: 0 }, TOOL_NAMES[type]);
        return;
      }
      if (d.txn) {
        const tb = tightBounds(d.target!.holder.subpaths.slice(d.subStart, d.subStart + d.subCount));
        if (!tb || (tb.w < 0.5 && tb.h < 0.5)) { d.txn.cancel(); doc.layersChanged(); return; }
        d.txn.commit();
        if (d.layer) doc.layersChanged();
        touchDone(doc, d.target);
      }
    },
    keyDown(e, doc) {
      if (drag && e.code === 'Space') { if (!drag.space) { drag.space = true; } return true; }
      if (drag && e.key === 'Escape' && doc) {
        drag.txn?.cancel(); drag.preview = []; drag = null; doc.layersChanged(); return true;
      }
      return false;
    },
    keyUp(e) {
      if (drag && e.code === 'Space') { drag.space = false; return true; }
      return false;
    },
    drawOverlay(ctx, view, doc) {
      const d = drag;
      if (d && d.mode === 'pixels' && d.preview.length) {
        ctx.save();
        const m = view.matrix();
        ctx.fillStyle = toCss(app.fg, Math.max(0.15, s.pxOpacity / 100));
        ctx.fill(toPath2D(d.preview, m), 'nonzero');
        ctx.lineWidth = 1; ctx.strokeStyle = '#1473e6'; ctx.stroke(toPath2D(d.preview, m));
        ctx.restore();
      }
      if (d && d.moved && app.prefs.showTransformValues) drawHud(ctx, view, d.hud);
      if (!d && s.mode !== 'pixels' && !selectedShapes(doc).length) return;
      if (!d && s.mode !== 'pixels') drawRadiusHandles(ctx, doc);
    },
  };
  return tool;
}

function gearExtras(type: ShapeType, s: ShapeSettings, tool: Tool): HTMLElement[] {
  const save = () => app.saveToolSettings(tool);
  const out: HTMLElement[] = [h('div.vo-gear-sep')];
  const radio = (text: string, value: Constrain) => {
    const inp = h('input', { type: 'radio', name: 'vo-constrain', checked: s.constrain === value }) as HTMLInputElement;
    inp.onchange = () => { s.constrain = value; save(); };
    return h('label.vo-row', { style: { marginTop: '4px' } }, inp, h('span', null, text));
  };
  const wh = (keyW: 'fixedW' | 'propW', keyH: 'fixedH' | 'propH', unit: string) => h('div.vo-row', { style: { paddingLeft: '22px', marginTop: '2px' } },
    numberField(s[keyW], v => { (s as any)[keyW] = v; save(); }, { min: 0.01, max: 100000, decimals: 2, unit, width: 64, label: 'W:' }),
    numberField(s[keyH], v => { (s as any)[keyH] = v; save(); }, { min: 0.01, max: 100000, decimals: 2, unit, width: 64, label: 'H:' }));
  if (type === 'rect' || type === 'ellipse') {
    out.push(radio('Unconstrained', 'none'), radio(type === 'rect' ? 'Square' : 'Circle (draw diameter or radius)', 'square'), radio('Fixed Size', 'fixed'), wh('fixedW', 'fixedH', 'px'), radio('Proportional', 'proportional'), wh('propW', 'propH', ''),
      checkbox('From Center', s.fromCenter, v => { s.fromCenter = v; save(); }));
  } else if (type === 'polygon') {
    out.push(h('div.vo-row', null, label('Star Ratio:'), numberField(s.star, v => { s.star = v; save(); applyLivePoly(v); }, { min: 0, max: 99, unit: '%', width: 52, title: 'Indent sides by' })),
      checkbox('Smooth Star Indents', s.smoothIndents, v => { s.smoothIndents = v; save(); }),
      checkbox('Smooth Corners', s.smoothCorners, v => { s.smoothCorners = v; save(); }),
      checkbox('From Center', s.fromCenter, v => { s.fromCenter = v; save(); }));
  } else if (type === 'triangle') {
    out.push(checkbox('From Center', s.fromCenter, v => { s.fromCenter = v; save(); }));
  } else if (type === 'line') {
    const ar = s.arrows;
    out.push(h('div.vo-pop-title', { style: { marginTop: '6px' } }, 'Arrowheads'),
      h('div.vo-row', null, checkbox('Start', ar.start, v => { ar.start = v; save(); }), checkbox('End', ar.end, v => { ar.end = v; save(); })),
      h('div.vo-row', null, label('Width:'), numberField(ar.width, v => { ar.width = v; save(); }, { min: 10, max: 1000, unit: '%', width: 56 })),
      h('div.vo-row', null, label('Length:'), numberField(ar.length, v => { ar.length = v; save(); }, { min: 10, max: 5000, unit: '%', width: 56 })),
      h('div.vo-row', null, label('Concavity:'), numberField(ar.concavity, v => { ar.concavity = v; save(); }, { min: -50, max: 50, unit: '%', width: 56 })));
  } else if (type === 'custom') {
    out.push(radio('Unconstrained', 'none'), radio('Defined Proportions', 'defined'), radio('Defined Size', 'defined-size'), radio('Fixed Size', 'fixed'), wh('fixedW', 'fixedH', 'px'),
      checkbox('From Center', s.fromCenter, v => { s.fromCenter = v; save(); }));
  }
  return out;
}
function applyLivePoly(star: number) {
  const d = app.activeDoc, l = d?.activeLayer;
  if (d && isShapeLayer(l) && l.live?.type === 'polygon') { d.history.transaction('Change Star Ratio', () => { l.live!.star = Math.min(0.99, star / 100); l.rebuildFromLive(); }); d.layersChanged(); }
}

// ------------------------------------------------------------------ registration
app.registerTool(makeShapeTool('shape-rect', 'Rectangle Tool', 'shape-rect', 0, baseSettings()));
app.registerTool(makeShapeTool('shape-ellipse', 'Ellipse Tool', 'shape-ellipse', 1, baseSettings()));
app.registerTool(makeShapeTool('shape-triangle', 'Triangle Tool', 'shape-triangle', 2, baseSettings()));
app.registerTool(makeShapeTool('shape-polygon', 'Polygon Tool', 'shape-polygon', 3, baseSettings()));
app.registerTool(makeShapeTool('shape-line', 'Line Tool', 'shape-line', 4, baseSettings({ alignEdges: false, weight: 3 })));
app.registerTool(makeShapeTool('shape-custom', 'Custom Shape Tool', 'shape-custom', 5, baseSettings()));

/** Test / panel helper: create a shape of `type` in box r with the tool's settings. */
export function createShapeAt(doc: PixDocument, toolId: string, r: Rect) {
  const t = app.getTool(toolId);
  const type = TOOL_TYPE[toolId];
  if (!t || !type) return;
  const s = t.settings as ShapeSettings;
  const live = type === 'line' ? liveFor('line', s, r, { a: { x: r.x, y: r.y }, b: { x: r.x + r.w, y: r.y + r.h } }) : liveFor(type, s, r);
  commitShape(doc, type, { ...s, mode: s.mode === 'pixels' ? 'pixels' : s.mode }, live);
}
