// Ruler Tool (I): measure distances and angles, Alt-drag from an endpoint for a protractor, Straighten Layer.
import { app, type Tool, type ToolPointer } from '../../core/app';
import type { PixDocument } from '../../core/document';
import { events } from '../../core/events';
import type { Viewport } from '../../core/viewport';
import type { Point } from '../../core/types';
import { snap45 } from '../../core/geom';
import { checkbox, button, separator } from '../../ui/widgets';
import { h } from '../../ui/dom';
import { svgCursor } from '../../ui/cursors';
import { toast } from '../../ui/toast';
import { fmtLen, measureEvents } from './common';
import { transformDocument, transformLayer, maxScaleInside, quadOf } from '../crop/xform';

/** pts[0] is the vertex of a protractor; a plain line is [a, b]. */
export interface RulerLine { pts: Point[] }
const lines = new WeakMap<PixDocument, RulerLine>();
export const getRuler = (doc: PixDocument | null): RulerLine | null => (doc && lines.get(doc)) || null;

const settings = { useScale: false };
export const rulerUsesScale = () => settings.useScale;

/** Readouts in Photoshop's order. Angle is counter-clockwise positive (y up). */
export function rulerInfo(doc: PixDocument, line: RulerLine) {
  const [a, b, c] = line.pts;
  const ang = (p: Point, q: Point) => (Math.atan2(-(q.y - p.y), q.x - p.x) * 180) / Math.PI;
  const len = (p: Point, q: Point) => Math.hypot(q.x - p.x, q.y - p.y);
  if (c) {
    let d = Math.abs(ang(a, b) - ang(a, c));
    if (d > 180) d = 360 - d;
    return { x: a.x, y: a.y, w: null as number | null, h: null as number | null, angle: d, l1: len(a, b), l2: len(a, c) as number | null };
  }
  return { x: a.x, y: a.y, w: b.x - a.x, h: b.y - a.y, angle: ang(a, b), l1: len(a, b), l2: null as number | null };
}

function setLine(doc: PixDocument, l: RulerLine | null) {
  if (l) lines.set(doc, l); else lines.delete(doc);
  measureEvents.emit('ruler', doc);
  doc.redrawOverlay();
}

let drag: { mode: 'new' | 'point' | 'all' | 'arm'; index: number; start: Point; orig: Point[] } | null = null;

function hit(view: Viewport, line: RulerLine, sx: number, sy: number): { kind: 'point' | 'line'; index: number } | null {
  const s = line.pts.map(p => view.docToScreen(p.x, p.y));
  for (let i = 0; i < s.length; i++) if (Math.hypot(s[i].x - sx, s[i].y - sy) <= 7) return { kind: 'point', index: i };
  const seg = (p: Point, q: Point) => {
    const dx = q.x - p.x, dy = q.y - p.y, l2 = dx * dx + dy * dy || 1;
    const t = Math.max(0, Math.min(1, ((sx - p.x) * dx + (sy - p.y) * dy) / l2));
    return Math.hypot(p.x + t * dx - sx, p.y + t * dy - sy);
  };
  if (seg(s[0], s[1]) <= 4 || (s[2] && seg(s[0], s[2]) <= 4)) return { kind: 'line', index: -1 };
  return null;
}

// ------------------------------------------------------------------ straighten
/** Rotation (degrees, canvas convention: clockwise positive) that makes the ruler line level. */
function levelRotation(line: RulerLine): number {
  const [a, b] = line.pts;
  const deg = (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI;   // screen angle, clockwise positive
  let r = -deg;
  // straighten to the nearest axis (vertical lines become vertical)
  while (r > 45) r -= 90;
  while (r < -45) r += 90;
  return r;
}

export function straighten(doc: PixDocument, noCrop = false) {
  const line = getRuler(doc);
  if (!line) return;
  const rot = levelRotation(line);
  if (Math.abs(rot) < 1e-6) { setLine(doc, null); return; }
  const layer = doc.activeLayer;
  if (!layer) { toast('No layer is selected.', 'error'); return; }
  if (layer.positionLocked && !layer.isBackground) { toast('Could not straighten because the layer is locked.', 'error'); return; }
  const W = doc.width, H = doc.height;
  doc.history.transaction('Straighten', () => {
    if (layer.isBackground) {
      // rotate the whole canvas about its centre, then crop to the largest same-aspect rectangle
      const rotM = new DOMMatrix().translate(W / 2, H / 2).rotate(rot).translate(-W / 2, -H / 2);
      let nw = W, nh = H;
      if (!noCrop) {
        const s = maxScaleInside({ x: W / 2, y: H / 2 }, W / 2, H / 2, quadOf(rotM, { x: 0, y: 0, w: W, h: H }), 1);
        nw = Math.max(1, Math.floor(W * s)); nh = Math.max(1, Math.floor(H * s));
      }
      const m = new DOMMatrix().translate(-(W - nw) / 2, -(H - nh) / 2).multiply(rotM);
      transformDocument(doc, m, { width: nw, height: nh, deleteOutside: true, backgroundFill: app.bg });
    } else {
      const b = layer.bounds(doc) || { x: 0, y: 0, w: W, h: H };
      const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
      const m = new DOMMatrix().translate(cx, cy).rotate(rot).translate(-cx, -cy);
      transformLayer(doc, layer, m, null, false, { x: 0, y: 0, w: W, h: H });
    }
  });
  lines.delete(doc);
  measureEvents.emit('ruler', doc);
  doc.layersChanged();
  doc.pixelsChanged(null, null);
}

// ------------------------------------------------------------------ tool
const RULER_CURSOR = svgCursor('<path d="M3 3l6 6M3 3h4M3 3v4"/><path d="m8 21 13-13-3-3L5 18z"/><path d="m11 15 1.5 1.5M13.5 12.5 15 14M16 10l1.5 1.5"/>', 3, 3, 'crosshair');

const tool: Tool = {
  id: 'ruler', name: 'Ruler Tool', group: 'eyedropper', icon: 'ruler', shortcut: 'I', order: 2,
  settings,
  cursor: () => {
    const v = app.viewport, d = app.activeDoc, l = getRuler(d);
    if (v && d && l) { const hh = hit(v, l, v.pointer.sx, v.pointer.sy); if (hh) return hh.kind === 'point' && (window as any).__altDown && l.pts.length === 2 ? 'crosshair' : 'move'; }
    return RULER_CURSOR;
  },
  options(bar) {
    const val = (lab: string) => { const v = h('span.ms-val'); bar.append(h('span.ms-read', null, h('span.ms-lab', null, lab), v)); return v; };
    const X = val('X:'), Y = val('Y:'), Wd = val('W:'), Ht = val('H:'), A = val('A:'), L1 = val('L1:'), L2 = val('L2:');
    bar.append(separator(),
      checkbox('Use Measurement Scale', settings.useScale, v => { settings.useScale = v; app.saveToolSettings(tool); sync(); }, { title: 'Show values in the document\'s measurement scale units' }),
      separator());
    const str = button('Straighten Layer', e => { const d = app.activeDoc; if (d) straighten(d, e.altKey); }, { cls: 'small', title: 'Rotate the layer so the ruler line becomes level (Alt+click: straighten without cropping)' });
    const clr = button('Clear', () => { const d = app.activeDoc; if (d) setLine(d, null); }, { cls: 'small', title: 'Clear the measurement' });
    bar.append(str, clr);
    const sync = () => {
      const d = app.activeDoc, l = getRuler(d);
      str.disabled = clr.disabled = !l;
      if (!d || !l) { for (const e of [X, Y, Wd, Ht, A, L1, L2]) e.textContent = ''; return; }
      const r = rulerInfo(d, l), f = (v: number | null) => (v === null ? '' : fmtLen(d, v, settings.useScale));
      X.textContent = f(r.x); Y.textContent = f(r.y); Wd.textContent = f(r.w); Ht.textContent = f(r.h);
      A.textContent = `${r.angle.toFixed(1)}°`; L1.textContent = f(r.l1); L2.textContent = f(r.l2);
    };
    sync();
    const offs = [measureEvents.on('ruler', sync), events.on('activeDoc', sync), events.on('prefs', sync), measureEvents.on('scale', sync)];
    return () => offs.forEach(f => f());
  },
  pointerDown(p: ToolPointer, doc) {
    const view = app.viewport!, line = getRuler(doc);
    const hh = line ? hit(view, line, p.sx, p.sy) : null;
    if (line && hh) {
      if (hh.kind === 'point' && p.alt && line.pts.length === 2) {
        // protractor: the clicked endpoint becomes the vertex
        const v = line.pts[hh.index], other = line.pts[1 - hh.index];
        setLine(doc, { pts: [v, other, { x: p.x, y: p.y }] });
        drag = { mode: 'arm', index: 2, start: { x: p.x, y: p.y }, orig: getRuler(doc)!.pts.map(q => ({ ...q })) };
        return;
      }
      drag = { mode: hh.kind === 'point' ? 'point' : 'all', index: hh.index, start: { x: p.x, y: p.y }, orig: line.pts.map(q => ({ ...q })) };
      return;
    }
    setLine(doc, { pts: [{ x: p.x, y: p.y }, { x: p.x, y: p.y }] });
    drag = { mode: 'new', index: 1, start: { x: p.x, y: p.y }, orig: [{ x: p.x, y: p.y }, { x: p.x, y: p.y }] };
  },
  pointerMove(p, doc) {
    if (!drag) return;
    const pts = drag.orig.map(q => ({ ...q }));
    if (drag.mode === 'all') {
      const dx = p.x - drag.start.x, dy = p.y - drag.start.y;
      for (const q of pts) { q.x += dx; q.y += dy; }
    } else {
      // the anchor for Shift-constraining is the vertex (or the other endpoint)
      const anchor = drag.index === 0 ? pts[1] : pts[0];
      pts[drag.index] = p.shift ? snap45(anchor, { x: p.x, y: p.y }) : { x: p.x, y: p.y };
    }
    setLine(doc, { pts });
  },
  pointerUp(_p, doc) {
    const d = drag;
    drag = null;
    const l = getRuler(doc);
    if (d?.mode === 'new' && l && Math.hypot(l.pts[1].x - l.pts[0].x, l.pts[1].y - l.pts[0].y) < 0.5) setLine(doc, null);
  },
  keyDown(e, doc) {
    if (doc && getRuler(doc) && (e.key === 'Delete' || e.key === 'Backspace') && !e.ctrlKey) { setLine(doc, null); return true; }
    return false;
  },
  drawOverlay(ctx, view, doc) {
    const l = getRuler(doc);
    if (!l) return;
    const s = l.pts.map(p => view.docToScreen(p.x, p.y));
    ctx.save();
    const path = () => {
      ctx.beginPath(); ctx.moveTo(s[1].x, s[1].y); ctx.lineTo(s[0].x, s[0].y);
      if (s[2]) ctx.lineTo(s[2].x, s[2].y);
    };
    ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(255,255,255,.8)'; path(); ctx.stroke();
    ctx.lineWidth = 1; ctx.strokeStyle = '#000'; path(); ctx.stroke();
    // endpoint crosses
    for (const q of s) {
      for (const [c, w] of [['rgba(255,255,255,.9)', 3], ['#000', 1]] as [string, number][]) {
        ctx.strokeStyle = c; ctx.lineWidth = w;
        ctx.beginPath(); ctx.moveTo(q.x - 5, q.y); ctx.lineTo(q.x + 5, q.y); ctx.moveTo(q.x, q.y - 5); ctx.lineTo(q.x, q.y + 5); ctx.stroke();
      }
    }
    if (s[2]) {
      // protractor arc
      const a1 = Math.atan2(s[1].y - s[0].y, s[1].x - s[0].x), a2 = Math.atan2(s[2].y - s[0].y, s[2].x - s[0].x);
      let d = a2 - a1;
      while (d > Math.PI) d -= Math.PI * 2;
      while (d < -Math.PI) d += Math.PI * 2;
      ctx.strokeStyle = '#1473e6'; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(s[0].x, s[0].y, 22, a1, a1 + d, d < 0); ctx.stroke();
    }
    // floating readout while dragging
    if (drag) {
      const r = rulerInfo(doc, l);
      const text = `${r.angle.toFixed(1)}°   ${fmtLen(doc, r.l1, settings.useScale, true)}${r.l2 !== null ? '   ' + fmtLen(doc, r.l2, settings.useScale, true) : ''}`;
      ctx.font = '600 11px Segoe UI, system-ui, sans-serif';
      const w = ctx.measureText(text).width + 16, x = view.pointer.sx + 16, y = view.pointer.sy + 16;
      ctx.fillStyle = 'rgba(40,40,40,.92)';
      ctx.beginPath(); ctx.roundRect(x, y, w, 22, 4); ctx.fill();
      ctx.fillStyle = '#f0f0f0'; ctx.fillText(text, x + 8, y + 15);
    }
    ctx.restore();
  },
};
app.registerTool(tool);
events.on('docSize', d => { if (getRuler(d)) setLine(d, null); });
