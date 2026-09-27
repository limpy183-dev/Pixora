// Select > Transform Selection: a modal bounding box around the selection outline only (pixels are not touched).
// Drag inside = move, handles = scale (Shift: proportional, Alt: from centre), outside corners = rotate (Shift: 15°
// steps), Ctrl+side handle = skew. Options bar: X / Y / W / H / angle, commit / cancel. Enter commits, Esc cancels.
// Context menu: Flip Horizontal / Vertical, Rotate 180° / 90° CW / 90° CCW.
import { app, type Tool, type ToolPointer } from '../../core/app';
import type { PixDocument } from '../../core/document';
import { registerCommand } from '../../core/commands';
import { createCanvas, ctx2d } from '../../core/canvas';
import type { Point, Rect } from '../../core/types';
import type { Viewport } from '../../core/viewport';
import { h } from '../../ui/dom';
import { iconButton, numberField, separator, type Field } from '../../ui/widgets';
import { openMenu } from '../../ui/menu';
import { svgCursor } from '../../ui/cursors';

type Handle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';
const HANDLES: Handle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
const HPOS: Record<Handle, [number, number]> = { nw: [0, 0], n: [0.5, 0], ne: [1, 0], e: [1, 0.5], se: [1, 1], s: [0.5, 1], sw: [0, 1], w: [0, 0.5] };

interface State {
  doc: PixDocument; prevTool: string; base: HTMLCanvasElement; B: Rect; outline: Path2D; M: DOMMatrix;
  drag: null | { kind: 'move' | 'scale' | 'rotate' | 'skew'; h?: Handle; start: Point; M0: DOMMatrix };
}
let st: State | null = null;
const fields: { x?: Field<number>; y?: Field<number>; w?: Field<number>; h?: Field<number>; a?: Field<number> } = {};

const tp = (m: DOMMatrix, x: number, y: number): Point => { const p = m.transformPoint(new DOMPoint(x, y)); return { x: p.x, y: p.y }; };
const local = (s: State, p: Point) => tp(s.M.inverse(), p.x, p.y);
const handlePt = (s: State, hd: Handle) => { const [u, v] = HPOS[hd]; return tp(s.M, s.B.x + s.B.w * u, s.B.y + s.B.h * v); };
const centre = (s: State) => tp(s.M, s.B.x + s.B.w / 2, s.B.y + s.B.h / 2);

/** Decompose M into translate/rotate/scale for the options bar. */
function decompose(s: State) {
  const m = s.M, c = centre(s);
  const sx = Math.hypot(m.a, m.b), det = m.a * m.d - m.b * m.c;
  const sy = sx ? det / sx : Math.hypot(m.c, m.d);
  return { x: c.x, y: c.y, w: sx * 100, h: sy * 100, a: (Math.atan2(m.b, m.a) * 180) / Math.PI };
}
function syncFields() {
  if (!st) return;
  const d = decompose(st);
  fields.x?.setValue(d.x); fields.y?.setValue(d.y); fields.w?.setValue(d.w); fields.h?.setValue(d.h); fields.a?.setValue(d.a);
}
function fromFields(v: { x: number; y: number; w: number; h: number; a: number }) {
  if (!st) return;
  const cx = st.B.x + st.B.w / 2, cy = st.B.y + st.B.h / 2;
  st.M = new DOMMatrix().translate(v.x, v.y).rotate(v.a).scale(v.w / 100 || 0.001, v.h / 100 || 0.001).translate(-cx, -cy);
  st.doc.redrawOverlay();
}

function begin(doc: PixDocument) {
  if (doc.selection.empty) return;
  const prev = app.activeTool?.id === tool.id ? (st?.prevTool || 'marquee-rect') : app.activeTool?.id || 'marquee-rect';
  const B = { ...doc.selection.bounds! };
  const base = doc.selection.mask!;
  st = { doc, prevTool: prev, base, B, outline: doc.selection.outline() || new Path2D(), M: new DOMMatrix(), drag: null };
  if (app.viewport) app.viewport.hideSelection = true;
  app.setTool(tool.id);
  doc.redrawOverlay();
}
function end(apply: boolean, switchBack = true) {
  const s = st;
  if (!s) return;
  st = null;
  if (app.viewport) app.viewport.hideSelection = false;
  if (apply && !s.M.isIdentity) {
    const doc = s.doc, m = createCanvas(doc.width, doc.height), x = ctx2d(m);
    x.imageSmoothingEnabled = true; x.imageSmoothingQuality = 'high';
    x.setTransform(s.M);
    x.drawImage(s.base, 0, 0);
    doc.history.transaction('Transform Selection', () => doc.selection.setMask(m), 'selection');
  }
  s.doc.redrawOverlay();
  if (switchBack && app.activeTool?.id === tool.id) app.setTool(s.prevTool);
}

function hit(s: State, view: Viewport, p: ToolPointer): { kind: 'move' | 'scale' | 'rotate' | 'skew' | null; h?: Handle } {
  for (const hd of HANDLES) {
    const q = handlePt(s, hd), sc = view.docToScreen(q.x, q.y);
    if (Math.hypot(sc.x - p.sx, sc.y - p.sy) <= 7) return { kind: p.ctrl && hd.length === 1 ? 'skew' : 'scale', h: hd };
  }
  const l = local(s, p);
  if (l.x >= s.B.x && l.x <= s.B.x + s.B.w && l.y >= s.B.y && l.y <= s.B.y + s.B.h) return { kind: 'move' };
  // near the box (outside): rotate
  for (const hd of ['nw', 'ne', 'se', 'sw'] as Handle[]) {
    const q = handlePt(s, hd), sc = view.docToScreen(q.x, q.y);
    if (Math.hypot(sc.x - p.sx, sc.y - p.sy) <= 28) return { kind: 'rotate' };
  }
  return { kind: 'rotate' };
}

const ROT_CURSOR = svgCursor('<path d="M5 13a7 7 0 0 1 12-5"/><path d="M17 3v5h-5"/><path d="M19 11a7 7 0 0 1-12 5"/><path d="M7 21v-5h5"/>', 12, 12, 'crosshair');
function scaleCursor(s: State, hd: Handle): string {
  const c = centre(s), q = handlePt(s, hd);
  const a = ((Math.atan2(q.y - c.y, q.x - c.x) * 180) / Math.PI + 360) % 180;
  return a < 22.5 || a >= 157.5 ? 'ew-resize' : a < 67.5 ? 'nwse-resize' : a < 112.5 ? 'ns-resize' : 'nesw-resize';
}

const tool: Tool = {
  id: 'transform-selection', name: 'Transform Selection', group: 'transform-selection', icon: 'marquee-rect',
  noCtrlMove: true,
  cursor: () => {
    const v = app.viewport, s = st;
    if (!v || !s) return 'default';
    const p = v.pointer as any;
    if (s.drag) return s.drag.kind === 'move' ? 'move' : s.drag.kind === 'rotate' ? ROT_CURSOR : s.drag.h ? scaleCursor(s, s.drag.h) : 'default';
    const r = hit(s, v, { ...p, ctrl: false });
    return r.kind === 'move' ? 'move' : r.kind === 'scale' && r.h ? scaleCursor(s, r.h) : ROT_CURSOR;
  },
  options(bar) {
    const d = st ? decompose(st) : { x: 0, y: 0, w: 100, h: 100, a: 0 };
    const cur = () => (st ? decompose(st) : d);
    fields.x = numberField(d.x, v => fromFields({ ...cur(), x: v }), { label: 'X:', unit: 'px', width: 62, decimals: 1, title: 'Horizontal position of the reference point' });
    fields.y = numberField(d.y, v => fromFields({ ...cur(), y: v }), { label: 'Y:', unit: 'px', width: 62, decimals: 1, title: 'Vertical position of the reference point' });
    fields.w = numberField(d.w, v => fromFields({ ...cur(), w: v }), { label: 'W:', unit: '%', width: 58, decimals: 1, title: 'Horizontal scale' });
    fields.h = numberField(d.h, v => fromFields({ ...cur(), h: v }), { label: 'H:', unit: '%', width: 58, decimals: 1, title: 'Vertical scale' });
    fields.a = numberField(d.a, v => fromFields({ ...cur(), a: v }), { unit: '°', width: 52, decimals: 1, min: -180, max: 180, title: 'Rotation angle' });
    bar.append(h('span.opt-label', null, 'Transform Selection'), separator(), fields.x, fields.y, separator(), fields.w, fields.h, separator(),
      h('span.opt-group', { title: 'Rotate' }, h('span.opt-label', null, '∠'), fields.a), h('span.ts-flex'),
      iconButton('cancel', 'Cancel transform (Esc)', () => end(false)), iconButton('commit', 'Commit transform (Enter)', () => end(true)));
    return () => { fields.x = fields.y = fields.w = fields.h = fields.a = undefined; };
  },
  isModal: () => !!st,
  commit: () => end(true),
  cancel: () => end(false),
  deactivate() { if (st) end(true, false); },
  pointerDown(p, _doc) {
    const s = st, v = app.viewport;
    if (!s || !v) return;
    const r = hit(s, v, p);
    if (!r.kind) return;
    s.drag = { kind: r.kind, h: r.h, start: { x: p.x, y: p.y }, M0: DOMMatrix.fromMatrix(s.M) };
  },
  pointerMove(p, doc) {
    const s = st;
    if (!s?.drag) return;
    const d = s.drag, M0 = d.M0, B = s.B;
    if (d.kind === 'move') {
      let dx = p.x - d.start.x, dy = p.y - d.start.y;
      if (p.shift) { if (Math.abs(dx) > Math.abs(dy)) dy = 0; else dx = 0; }
      s.M = new DOMMatrix().translate(dx, dy).multiply(M0);
    } else if (d.kind === 'rotate') {
      const c = tp(M0, B.x + B.w / 2, B.y + B.h / 2);
      let a = Math.atan2(p.y - c.y, p.x - c.x) - Math.atan2(d.start.y - c.y, d.start.x - c.x);
      a = (a * 180) / Math.PI;
      if (p.shift) {
        const base = (Math.atan2(M0.b, M0.a) * 180) / Math.PI;
        a = Math.round((base + a) / 15) * 15 - base;
      }
      s.M = new DOMMatrix().translate(c.x, c.y).rotate(a).translate(-c.x, -c.y).multiply(M0);
    } else if (d.h) {
      const inv = M0.inverse(), l = tp(inv, p.x, p.y);
      const [u, v] = HPOS[d.h];
      const hx = B.x + B.w * u, hy = B.y + B.h * v;
      const ax = p.alt ? B.x + B.w / 2 : B.x + B.w * (1 - u), ay = p.alt ? B.y + B.h / 2 : B.y + B.h * (1 - v);
      if (d.kind === 'skew') {
        let m: DOMMatrix;
        if (v === 0.5) { const k = (l.y - hy) / (hx - ax || 1); m = new DOMMatrix([1, k, 0, 1, -k * ax, 0]); }
        else { const k = (l.x - hx) / (hy - ay || 1); m = new DOMMatrix([1, 0, k, 1, -k * ay, 0]); }
        s.M = M0.multiply(m);
      } else {
        let sx = u === 0.5 ? 1 : (l.x - ax) / (hx - ax || 1);
        let sy = v === 0.5 ? 1 : (l.y - ay) / (hy - ay || 1);
        if (p.shift) {
          if (u === 0.5) sx = Math.abs(sy) * Math.sign(sx || 1);
          else if (v === 0.5) sy = Math.abs(sx) * Math.sign(sy || 1);
          else { const k = Math.max(Math.abs(sx), Math.abs(sy)); sx = k * Math.sign(sx || 1); sy = k * Math.sign(sy || 1); }
        }
        if (Math.abs(sx) < 1e-3) sx = 1e-3 * Math.sign(sx || 1);
        if (Math.abs(sy) < 1e-3) sy = 1e-3 * Math.sign(sy || 1);
        s.M = M0.multiply(new DOMMatrix().translate(ax, ay).scale(sx, sy).translate(-ax, -ay));
      }
    }
    syncFields();
    doc.redrawOverlay();
  },
  pointerUp() { if (st) st.drag = null; },
  dblclick(p) { const s = st, v = app.viewport; if (s && v && hit(s, v, p).kind === 'move') end(true); },
  keyDown(e) {
    const s = st;
    if (!s) return false;
    const map: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    const v = map[e.key];
    if (v) { const k = e.shiftKey ? 10 : 1; s.M = new DOMMatrix().translate(v[0] * k, v[1] * k).multiply(s.M); syncFields(); s.doc.redrawOverlay(); return true; }
    return false;
  },
  contextMenu(p) {
    const s = st;
    if (!s) return;
    const about = (m: DOMMatrix) => { const c = centre(s); s.M = new DOMMatrix().translate(c.x, c.y).multiply(m).translate(-c.x, -c.y).multiply(s.M); syncFields(); s.doc.redrawOverlay(); };
    const e = p.event as MouseEvent;
    openMenu([
      { label: 'Rotate 180°', action: () => about(new DOMMatrix().rotate(180)) },
      { label: 'Rotate 90° Clockwise', action: () => about(new DOMMatrix().rotate(90)) },
      { label: 'Rotate 90° Counter Clockwise', action: () => about(new DOMMatrix().rotate(-90)) },
      '-',
      { label: 'Flip Horizontal', action: () => about(new DOMMatrix().scale(-1, 1)) },
      { label: 'Flip Vertical', action: () => about(new DOMMatrix().scale(1, -1)) },
      '-',
      { label: 'Commit Transform', action: () => end(true) },
      { label: 'Cancel Transform', action: () => end(false) },
    ], { x: e.clientX, y: e.clientY }, { minWidth: 210 });
  },
  drawOverlay(ctx, view) {
    const s = st;
    if (!s) return;
    // transformed marching ants
    ctx.save();
    view.applyDocTransform(ctx);
    ctx.transform(s.M.a, s.M.b, s.M.c, s.M.d, s.M.e, s.M.f);
    const k = Math.sqrt(Math.abs(s.M.a * s.M.d - s.M.b * s.M.c)) || 1;
    const px = 1 / (view.zoom * k);
    ctx.lineWidth = px;
    ctx.strokeStyle = '#fff'; ctx.stroke(s.outline);
    ctx.setLineDash([4 * px, 4 * px]); ctx.lineDashOffset = -view.antsPhase * px;
    ctx.strokeStyle = '#000'; ctx.stroke(s.outline);
    ctx.restore();
    // bounding box + handles (screen space)
    const q = (['nw', 'ne', 'se', 'sw'] as Handle[]).map(hd => { const d = handlePt(s, hd); return view.docToScreen(d.x, d.y); });
    ctx.save();
    ctx.strokeStyle = '#1e8bff'; ctx.lineWidth = 1;
    ctx.beginPath(); q.forEach((pt, i) => (i ? ctx.lineTo(pt.x, pt.y) : ctx.moveTo(pt.x, pt.y))); ctx.closePath(); ctx.stroke();
    for (const hd of HANDLES) {
      const d = handlePt(s, hd), sc = view.docToScreen(d.x, d.y);
      ctx.fillStyle = '#fff'; ctx.fillRect(Math.round(sc.x) - 3.5, Math.round(sc.y) - 3.5, 7, 7);
      ctx.strokeRect(Math.round(sc.x) - 3.5, Math.round(sc.y) - 3.5, 7, 7);
    }
    const c = centre(s), cs = view.docToScreen(c.x, c.y);
    ctx.beginPath(); ctx.arc(cs.x, cs.y, 4, 0, Math.PI * 2); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(cs.x - 6, cs.y); ctx.lineTo(cs.x + 6, cs.y); ctx.moveTo(cs.x, cs.y - 6); ctx.lineTo(cs.x, cs.y + 6); ctx.stroke();
    ctx.restore();
  },
};
app.registerTool(tool);

registerCommand({
  id: 'select.transform', label: 'Transform Selection',
  run: () => { const d = app.activeDoc; if (d) begin(d); },
  enabled: () => !!app.activeDoc && !app.activeDoc.selection.empty && !app.activeDoc.quickMask,
});
