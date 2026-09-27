// Lasso tools (L): freehand Lasso (Alt: temporary polygonal segments), Polygonal Lasso and Magnetic Lasso
// (live-wire edge snapping with auto anchors).
import { app, type Tool, type ToolPointer } from '../../core/app';
import type { PixDocument } from '../../core/document';
import type { Point, SelectOp } from '../../core/types';
import { numberField } from '../../ui/widgets';
import { LiveWire } from '../../features/selection/algo';
import { sampleImage, warnIfFaint } from '../../features/selection/ops';
import {
  antiAliasBox, featherField, glyphCursor, liveOp, mods, nudgeKey, onOptions, opButtons, resolveOp, selectAndMaskButton,
  selectionContextMenu, separator, strokePolyline,
} from './common';

interface Settings { op: SelectOp; feather: number; antiAlias: boolean }
const LASSO_G = '<path d="M13 3.5c4.8 0 8.6 2.4 8.6 5.4s-3.8 5.4-8.6 5.4-8.6-2.4-8.6-5.4S8.2 3.5 13 3.5z"/><path d="M8.6 13.4c-1 1.6-.4 3.3 1.5 3.7 1.6.3 2 1.9 1.1 3.7"/>';
const POLY_G = '<path d="M4.5 9.5 10 4l11.5 2.8-2.8 7.2H9.6z"/><path d="M9.6 14c-1.2 1.4-.6 3 1 3.4 1.5.4 1.8 2 1 3.6"/>';
const MAG_G = '<path d="M12 3.5c4.6 0 8.2 2.2 8.2 5"/><path d="M14.6 13.7c-.8.1-1.7.2-2.6.2-4.6 0-8.2-2.3-8.2-5.2S7.4 3.5 12 3.5"/><path d="M7.8 13c-.9 1.6-.3 3.2 1.4 3.6 1.5.3 1.9 1.8 1 3.6"/>';
const CLOSE_BADGE = '<circle cx="18" cy="19" r="2.6"/>';

function commitPoly(doc: PixDocument, pts: Point[], op: SelectOp, s: Settings, name: string) {
  const clean = pts.filter((p, i) => i === 0 || Math.hypot(p.x - pts[i - 1].x, p.y - pts[i - 1].y) > 0.01);
  if (clean.length < 3) {
    if (op === 'replace' && !doc.selection.empty) doc.history.transaction('Deselect', () => doc.selection.deselect(), 'selection');
    return;
  }
  doc.history.transaction(name, () => doc.selection.selectPolygon(clean, op, { feather: s.feather, antiAlias: s.antiAlias }), 'selection');
  if (s.feather > 0) warnIfFaint(doc);
}

function baseOptions(tool: Tool, s: Settings, bar: HTMLElement, extra: HTMLElement[] = []) {
  const ops = opButtons(tool, s), f = featherField(tool, s), aa = antiAliasBox(tool, s);
  bar.append(ops, separator(), f, aa, ...extra, separator(), selectAndMaskButton());
  return onOptions(() => { ops.setValue(s.op); f.setValue(s.feather); aa.setValue(s.antiAlias); });
}
const snap45 = (a: Point, p: Point): Point => {
  const dx = p.x - a.x, dy = p.y - a.y, ang = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4), len = Math.hypot(dx, dy);
  return { x: a.x + Math.cos(ang) * len, y: a.y + Math.sin(ang) * len };
};
const nearStart = (pts: Point[], p: ToolPointer | Point) => {
  if (pts.length < 3) return false;
  const v = app.viewport!, a = v.docToScreen(pts[0].x, pts[0].y), b = v.docToScreen(p.x, p.y);
  return Math.hypot(a.x - b.x, a.y - b.y) <= 7;
};

// ------------------------------------------------------------------ Lasso
{
  const s: Settings = { op: 'replace', feather: 0, antiAlias: true };
  let st: { pts: Point[]; op: SelectOp; poly: boolean; down: boolean; hover: Point | null } | null = null;
  const finish = (doc: PixDocument) => { const x = st; st = null; if (x) commitPoly(doc, x.pts, x.op, s, 'Lasso'); doc.redrawOverlay(); };
  const tool: Tool = {
    id: 'lasso', name: 'Lasso Tool', group: 'object-select', icon: 'lasso', shortcut: 'L', order: 1, settings: s,
    cursor: () => glyphCursor(st?.poly ? POLY_G : LASSO_G, 5, 20, st ? st.op : liveOp(s.op)),
    options(bar) { return baseOptions(tool, s, bar); },
    isModal: () => !!st && !st.down,
    commit() { const d = app.activeDoc; if (d) finish(d); },
    cancel() { st = null; app.activeDoc?.redrawOverlay(); },
    deactivate() { st = null; },
    pointerDown(p, doc) {
      if (st?.poly) { st.pts.push({ x: p.x, y: p.y }); st.down = true; if (nearStart(st.pts, p)) { st.pts.pop(); finish(doc); } return; }
      st = { pts: [{ x: p.x, y: p.y }], op: resolveOp(s.op, p.shift, p.alt), poly: false, down: true, hover: null };
    },
    pointerMove(p, doc) {
      if (!st) return;
      if (st.poly && mods.alt) { st.hover = { x: p.x, y: p.y }; doc.redrawOverlay(); return; }
      const l = st.pts[st.pts.length - 1];
      if (Math.hypot(p.x - l.x, p.y - l.y) * app.viewport!.zoom >= 1) st.pts.push({ x: p.x, y: p.y });
      doc.redrawOverlay();
    },
    pointerUp(p, doc) {
      if (!st) return;
      st.down = false;
      // Alt held at release: continue with straight segments until Alt is released
      if (mods.alt && st.pts.length > 1) { st.poly = true; st.hover = { x: p.x, y: p.y }; return; }
      if (st.poly) return;
      finish(doc);
    },
    hover(p, doc) { if (st?.poly) { st.hover = { x: p.x, y: p.y }; doc.redrawOverlay(); } },
    dblclick(_p, doc) { if (st?.poly) finish(doc); },
    keyDown(e, doc) { if (!st) return nudgeKey(e, doc); if ((e.key === 'Backspace' || e.key === 'Delete') && st.poly && st.pts.length > 1) { st.pts.pop(); doc?.redrawOverlay(); return true; } return false; },
    keyUp(e, doc) { if (e.key === 'Alt' && st?.poly && !st.down && doc) { finish(doc); return true; } return false; },
    drawOverlay(ctx, view) { if (st) strokePolyline(ctx, view, st.pts, st.poly ? st.hover : null); },
    contextMenu: selectionContextMenu,
  };
  app.registerTool(tool);
}

// ------------------------------------------------------------------ Polygonal Lasso
{
  const s: Settings = { op: 'replace', feather: 0, antiAlias: true };
  let st: { pts: Point[]; op: SelectOp; hover: Point | null; free: boolean } | null = null;
  const finish = (doc: PixDocument) => { const x = st; st = null; if (x) commitPoly(doc, x.pts, x.op, s, 'Polygonal Lasso'); doc.redrawOverlay(); app.viewport?.updateCursor(); };
  const target = (p: ToolPointer): Point => (st && p.shift && st.pts.length ? snap45(st.pts[st.pts.length - 1], p) : { x: p.x, y: p.y });
  const tool: Tool = {
    id: 'lasso-polygon', name: 'Polygonal Lasso Tool', group: 'object-select', icon: 'lasso-polygon', shortcut: 'L', order: 2, settings: s,
    cursor: () => {
      const v = app.viewport;
      const close = !!(st && v && nearStart(st.pts, { x: v.pointer.x, y: v.pointer.y }));
      return glyphCursor(POLY_G + (close ? CLOSE_BADGE : ''), 5, 20, st ? st.op : liveOp(s.op));
    },
    options(bar) { return baseOptions(tool, s, bar); },
    isModal: () => !!st,
    commit() { const d = app.activeDoc; if (d) finish(d); },
    cancel() { st = null; app.activeDoc?.redrawOverlay(); },
    deactivate() { st = null; },
    pointerDown(p, doc) {
      if (!st) { st = { pts: [{ x: p.x, y: p.y }], op: resolveOp(s.op, p.shift, p.alt), hover: null, free: false }; return; }
      if (nearStart(st.pts, p)) { finish(doc); return; }
      st.pts.push(target(p));
      st.free = false;
    },
    pointerMove(p, doc) {
      if (!st) return;
      // Alt + drag draws freehand segments
      if (p.alt) { st.free = true; st.pts.push({ x: p.x, y: p.y }); }
      st.hover = target(p);
      doc.redrawOverlay();
    },
    hover(p, doc) { if (st) { st.hover = target(p); doc.redrawOverlay(); app.viewport?.updateCursor(); } },
    dblclick(_p, doc) {
      if (!st) return;
      // the second click of the double-click added a duplicate point
      const n = st.pts.length;
      if (n > 1 && Math.hypot(st.pts[n - 1].x - st.pts[n - 2].x, st.pts[n - 1].y - st.pts[n - 2].y) < 3 / app.viewport!.zoom) st.pts.pop();
      finish(doc);
    },
    keyDown(e, doc) {
      if (!st) return nudgeKey(e, doc);
      if (e.key === 'Backspace' || e.key === 'Delete') { if (st.pts.length > 1) st.pts.pop(); else st = null; doc?.redrawOverlay(); return true; }
      if (e.key === 'Enter') { if (doc) finish(doc); return true; }
      if (e.key === 'Escape') { st = null; doc?.redrawOverlay(); return true; }
      return false;
    },
    drawOverlay(ctx, view) {
      if (!st) return;
      strokePolyline(ctx, view, st.pts, st.hover);
      if (st.hover && nearStart(st.pts, st.hover)) {
        const a = view.docToScreen(st.pts[0].x, st.pts[0].y);
        ctx.beginPath(); ctx.arc(a.x, a.y, 5, 0, Math.PI * 2);
        ctx.lineWidth = 3; ctx.strokeStyle = '#fff'; ctx.stroke(); ctx.lineWidth = 1.2; ctx.strokeStyle = '#000'; ctx.stroke();
      }
    },
    contextMenu: selectionContextMenu,
  };
  app.registerTool(tool);
}

// ------------------------------------------------------------------ Magnetic Lasso
{
  const s = { op: 'replace' as SelectOp, feather: 0, antiAlias: true, width: 10, contrast: 10, frequency: 57 };
  interface St { op: SelectOp; fixed: Point[]; anchors: number[]; wire: LiveWire; live: Point[]; img: ImageData; lastHover: Point }
  let st: St | null = null;
  const WIN = () => Math.max(60, s.width * 8);
  const newWire = (x: St | null, img: ImageData, at: Point) => new LiveWire(img.data, img.width, img.height, at.x, at.y, WIN(), s.contrast / 100);
  const spacing = () => 12 + (100 - s.frequency) * 1.6;
  const pathLen = (pts: Point[]) => { let l = 0; for (let i = 1; i < pts.length; i++) l += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y); return l; };

  function setAnchor(x: St, pts: Point[]) {
    for (let i = 1; i < pts.length; i++) x.fixed.push(pts[i]);
    x.anchors.push(x.fixed.length - 1);
    const a = x.fixed[x.fixed.length - 1];
    x.wire = newWire(x, x.img, a);
    x.live = [];
  }
  function track(x: St, p: Point) {
    const sp = x.wire.snap(p.x, p.y, s.width / 2);
    // leaving the search window → drop an anchor on the way and restart the wire there
    if (!x.wire.contains(p.x, p.y) || !x.wire.contains(sp.x, sp.y)) {
      const path = x.wire.path(sp.x, sp.y);
      if (path.length > 2) setAnchor(x, path.slice(0, Math.max(2, Math.floor(path.length * 0.8))));
      x.live = x.wire.path(x.wire.snap(p.x, p.y, s.width / 2).x, x.wire.snap(p.x, p.y, s.width / 2).y);
      return;
    }
    x.live = x.wire.path(sp.x, sp.y);
    if (pathLen(x.live) > spacing()) {
      const cut = Math.max(2, Math.floor(x.live.length * 0.75));
      setAnchor(x, x.live.slice(0, cut));
      x.live = x.wire.path(sp.x, sp.y);
    }
  }
  function close(doc: PixDocument, straight = false) {
    const x = st;
    st = null;
    if (!x) return;
    let pts = [...x.fixed, ...x.live.slice(1)];
    const start = x.fixed[0];
    if (!straight && pts.length > 2 && x.wire.contains(start.x, start.y)) pts = [...pts, ...x.wire.path(start.x, start.y).slice(1)];
    commitPoly(doc, pts, x.op, s, 'Magnetic Lasso');
    doc.redrawOverlay();
  }
  const tool: Tool = {
    id: 'lasso-magnetic', name: 'Magnetic Lasso Tool', group: 'object-select', icon: 'lasso-magnetic', shortcut: 'L', order: 3, settings: s,
    cursor: () => {
      const v = app.viewport;
      const closeIt = !!(st && v && nearStart(st.fixed, { x: v.pointer.x, y: v.pointer.y }) && st.fixed.length + st.live.length > 3);
      return glyphCursor(MAG_G + (closeIt ? CLOSE_BADGE : ''), 5, 20, st ? st.op : liveOp(s.op));
    },
    options(bar) {
      const w = numberField(s.width, v => { s.width = v; app.saveToolSettings(tool); }, { min: 1, max: 256, unit: 'px', width: 48, label: 'Width:', title: 'Edge detection width' });
      const c = numberField(s.contrast, v => { s.contrast = v; app.saveToolSettings(tool); }, { min: 1, max: 100, unit: '%', width: 44, label: 'Contrast:', title: 'Edge contrast' });
      const f = numberField(s.frequency, v => { s.frequency = v; app.saveToolSettings(tool); }, { min: 0, max: 100, width: 40, label: 'Frequency:', title: 'Anchor point frequency' });
      const off = baseOptions(tool, s, bar, [separator(), w, c, f]);
      const off2 = onOptions(() => { w.setValue(s.width); c.setValue(s.contrast); f.setValue(s.frequency); });
      return () => { off(); off2(); };
    },
    isModal: () => !!st,
    commit() { const d = app.activeDoc; if (d) close(d); },
    cancel() { st = null; app.activeDoc?.redrawOverlay(); },
    deactivate() { st = null; },
    pointerDown(p, doc) {
      if (!st) {
        const img = sampleImage(doc, true);
        const tmp = new LiveWire(img.data, img.width, img.height, p.x, p.y, Math.max(4, s.width), s.contrast / 100);
        const a = tmp.snap(p.x, p.y, s.width / 2);
        const x: St = { op: resolveOp(s.op, p.shift, p.alt), fixed: [a], anchors: [0], wire: null as unknown as LiveWire, live: [], img, lastHover: a };
        x.wire = newWire(x, img, a);
        st = x;
        return;
      }
      if (nearStart(st.fixed, p) && st.fixed.length + st.live.length > 3) { close(doc); return; }
      track(st, p);
      if (st.live.length > 1) setAnchor(st, st.live);
      doc.redrawOverlay();
    },
    pointerMove(p, doc) { if (st) { track(st, p); doc.redrawOverlay(); } },
    hover(p, doc) { if (st) { track(st, p); doc.redrawOverlay(); app.viewport?.updateCursor(); } },
    dblclick(p, doc) { if (st) close(doc, p.alt); },
    keyDown(e, doc) {
      if (!st) return nudgeKey(e, doc);
      if (e.key === 'Backspace' || e.key === 'Delete') {
        if (st.anchors.length > 1) {
          st.anchors.pop();
          const a = st.anchors[st.anchors.length - 1];
          st.fixed.length = a + 1;
          st.wire = newWire(st, st.img, st.fixed[a]);
          st.live = [];
        } else st = null;
        doc?.redrawOverlay();
        return true;
      }
      if (e.key === 'Enter') { if (doc) close(doc, e.altKey); return true; }
      if (e.key === 'Escape') { st = null; doc?.redrawOverlay(); return true; }
      if (e.code === 'BracketLeft' || e.code === 'BracketRight') { s.width = Math.max(1, Math.min(256, s.width + (e.code === 'BracketRight' ? 1 : -1))); app.saveToolSettings(tool); return true; }
      return false;
    },
    drawOverlay(ctx, view) {
      const v = view;
      if (st) {
        strokePolyline(ctx, v, [...st.fixed, ...st.live.slice(1)]);
        ctx.save();
        for (const i of st.anchors) {
          const a = v.docToScreen(st.fixed[i].x, st.fixed[i].y);
          ctx.fillStyle = '#fff'; ctx.strokeStyle = '#000'; ctx.lineWidth = 1;
          ctx.fillRect(Math.round(a.x) - 2.5, Math.round(a.y) - 2.5, 5, 5); ctx.strokeRect(Math.round(a.x) - 2.5, Math.round(a.y) - 2.5, 5, 5);
        }
        ctx.restore();
      }
      // Caps-Lock style width circle is shown while hovering
      if (v.pointer.inside && s.width * v.zoom > 6) {
        ctx.beginPath(); ctx.arc(v.pointer.sx, v.pointer.sy, (s.width * v.zoom) / 2, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(0,0,0,.45)'; ctx.lineWidth = 1; ctx.stroke();
      }
    },
    contextMenu: selectionContextMenu,
  };
  app.registerTool(tool);
}
