// Path Selection (A) and Direct Selection tools: select / move / duplicate path components and shape layers,
// drag anchors, handles and segments, marquee selection, Delete and arrow-key nudging.
import { app, type Tool, type ToolPointer } from '../../core/app';
import type { PixDocument } from '../../core/document';
import type { Point, Rect } from '../../core/types';
import type { PathPoint, SubPath } from '../../core/path';
import { snap45 } from '../../core/geom';
import { h } from '../../ui/dom';
import { checkbox, select } from '../../ui/widgets';
import { svgCursor } from '../../ui/cursors';
import { isShapeLayer } from '../../layers/shape-layer';
import {
  clearSel, dropLive, hitAnchor, hitHandle, hitInside, hitSegment, layerTarget, overlay, ptKey, sel, setPathSel, shapeLayerAt, syncSel,
  targetOf, tolDoc, touch, touchDone, drawMarquee, type Target,
} from './common';
import { cloneSub, segCtrl, tightBounds, translateSubs } from './geom';
import {
  alignButton, alignEdgesBox, arrangeButton, gearButton, onVectorChange, opsButton, separator, sizeControls, styleControls,
} from './options';
import { drawRadiusHandles, radiusCursor, radiusPointerDown, radiusPointerMove, radiusPointerUp } from './shape-tools';

interface SelSettings { layers: 'active' | 'all'; constrain: boolean; alignEdges: boolean }
const psSettings: SelSettings = { layers: 'all', constrain: false, alignEdges: true };
const dsSettings: SelSettings = { layers: 'all', constrain: false, alignEdges: false };

const ARROW = '<path d="m5 3 0 15 3.8-3.8 2.6 6 2.2-1-2.6-6H16z"/>';
export const CUR_PATH_SELECT = svgCursor(ARROW.replace('/>', ' fill="#000"/>'), 5, 3, 'default');
export const CUR_DIRECT = svgCursor(ARROW.replace('/>', ' fill="#fff"/>'), 5, 3, 'default');

// ------------------------------------------------------------------ drag state
type Drag =
  | { kind: 'move'; t: Target; start: Point; applied: Point; txn: ReturnType<PixDocument['history']['begin']>; wholeLayer: boolean; subs: number[] }
  | { kind: 'anchors'; t: Target; start: Point; applied: Point; txn: ReturnType<PixDocument['history']['begin']>; orig: SubPath[] }
  | { kind: 'handle'; t: Target; si: number; pi: number; which: 'in' | 'out'; alt: boolean; txn: ReturnType<PixDocument['history']['begin']> }
  | { kind: 'segment'; t: Target; si: number; seg: number; tt: number; start: Point; orig: SubPath; txn: ReturnType<PixDocument['history']['begin']> }
  | { kind: 'marquee'; t: Target | null; start: Point; rect: Rect; additive: boolean; direct: boolean }
  | { kind: 'radius' }
  | { kind: 'none' };
let drag: Drag = { kind: 'none' };

const alignRound = (s: SelSettings, v: number) => (s.alignEdges ? Math.round(v) : v);
const locked = (t: Target) => !!t.layer && (t.layer.locks.all || t.layer.positionLocked && t.layer.locks.position);

/** Find the target + component under p (activating another shape layer in "All Layers" mode). */
function pickComponent(doc: PixDocument, p: ToolPointer, s: SelSettings): { t: Target; si: number } | null {
  const tol = tolDoc(5);
  const t = targetOf(doc);
  if (t) {
    const hs = hitSegment(t.holder.subpaths, p, tol);
    const si = hs ? hs.si : hitInside(t.holder.subpaths, p);
    if (si >= 0) return { t, si };
  }
  const active = doc.activeLayer;
  const l = s.layers === 'all' ? shapeLayerAt(doc, p, tol) : isShapeLayer(active) && doc.selectedLayers.includes(active) ? active : null;
  if (l) {
    const lt = layerTarget(l);
    const hs = hitSegment(l.subpaths, p, tol + (l.stroke.enabled ? l.stroke.width / 2 : 0));
    const si = hs ? hs.si : hitInside(l.subpaths, p);
    if (si < 0) return null;
    if (doc.activeLayer !== l) doc.setActiveLayer(l);
    setPathSel(doc, 0);
    syncSel(lt);
    return { t: lt, si };
  }
  return null;
}

function startMove(doc: PixDocument, t: Target, p: ToolPointer, subsIdx: number[], dup: boolean) {
  const txn = doc.history.begin(dup ? 'Duplicate Path' : 'Drag Path');
  let subs = subsIdx;
  if (dup) {
    const list = t.holder.subpaths;
    const copies = subsIdx.map(i => cloneSub(list[i]));
    const base = list.length;
    list.push(...copies);
    subs = copies.map((_, k) => base + k);
    sel.subs = new Set(subs);
    dropLive(t);
  }
  const wholeLayer = !!t.layer && subs.length === t.holder.subpaths.length;
  drag = { kind: 'move', t, start: { x: p.x, y: p.y }, applied: { x: 0, y: 0 }, txn, wholeLayer, subs };
}

function moveBy(doc: PixDocument, d: Extract<Drag, { kind: 'move' }>, dx: number, dy: number) {
  const ddx = dx - d.applied.x, ddy = dy - d.applied.y;
  if (!ddx && !ddy) return;
  d.applied = { x: dx, y: dy };
  if (d.wholeLayer && d.t.layer) d.t.layer.translate(ddx, ddy);
  else { translateSubs(d.subs.map(i => d.t.holder.subpaths[i]), ddx, ddy); dropLive(d.t); }
  touch(doc, d.t);
}

// ------------------------------------------------------------------ direct selection helpers
/** Handles that are currently visible (selected anchors + the facing handles of their neighbours). */
function handleVisible(t: Target) {
  return (si: number, pi: number) => {
    const sp = t.holder.subpaths[si], n = sp.points.length;
    if (sel.pts.has(ptKey(si, pi))) return true;
    const nx = (pi + 1) % n, pv = (pi - 1 + n) % n;
    return (sel.pts.has(ptKey(si, nx)) && (sp.closed || pi < n - 1)) || (sel.pts.has(ptKey(si, pv)) && (sp.closed || pi > 0));
  };
}
function moveHandle(q: PathPoint, which: 'in' | 'out', x: number, y: number, breakIt: boolean) {
  if (which === 'in') { q.ix = x; q.iy = y; } else { q.ox = x; q.oy = y; }
  if (breakIt) { q.smooth = false; return; }
  if (q.smooth) {
    // keep the opposite handle colinear (its own length is preserved)
    const ox = which === 'in' ? q.ox : q.ix, oy = which === 'in' ? q.oy : q.iy;
    const len = Math.hypot(ox - q.x, oy - q.y);
    const dx = q.x - x, dy = q.y - y, dl = Math.hypot(dx, dy);
    if (len > 1e-6 && dl > 1e-6) {
      const nx = q.x + (dx / dl) * len, ny = q.y + (dy / dl) * len;
      if (which === 'in') { q.ox = nx; q.oy = ny; } else { q.ix = nx; q.iy = ny; }
    }
  }
}
/** Delete the selected anchors (Photoshop: the adjacent segments go too, closed paths open up). */
export function deleteSelectedAnchors(doc: PixDocument, t: Target) {
  const pts = [...sel.pts].map(k => k.split(':').map(Number));
  if (!pts.length) return false;
  const bySub = new Map<number, Set<number>>();
  for (const [si, pi] of pts) { if (!bySub.has(si)) bySub.set(si, new Set()); bySub.get(si)!.add(pi); }
  doc.history.transaction('Delete Anchor Point', () => {
    const out: SubPath[] = [];
    t.holder.subpaths.forEach((sp, si) => {
      const del = bySub.get(si);
      if (!del) { out.push(sp); return; }
      const n = sp.points.length;
      if (del.size >= n) return;
      // split into runs of kept points
      let start = 0;
      if (sp.closed) { start = [...Array(n).keys()].find(i => del.has(i))!; }
      const runs: PathPoint[][] = [];
      let run: PathPoint[] = [];
      for (let k = 0; k < n; k++) {
        const i = (start + k) % n;
        if (del.has(i)) { if (run.length) runs.push(run); run = []; } else run.push(sp.points[i]);
      }
      if (run.length) runs.push(run);
      for (const r of runs) {
        const first = r[0], last = r[r.length - 1];
        first.ix = first.x; first.iy = first.y; last.ox = last.x; last.oy = last.y;
        out.push({ points: r, closed: false, op: sp.op });
      }
    });
    t.holder.subpaths.splice(0, t.holder.subpaths.length, ...out);
    dropLive(t);
  });
  clearSel();
  touchDone(doc, t);
  return true;
}
export function deleteSelectedComponents(doc: PixDocument, t: Target) {
  if (!sel.subs.size) return false;
  const keep = t.holder.subpaths.filter((_, i) => !sel.subs.has(i));
  doc.history.transaction('Delete Path', () => { t.holder.subpaths.splice(0, t.holder.subpaths.length, ...keep); dropLive(t); });
  clearSel();
  touchDone(doc, t);
  return true;
}

function nudge(doc: PixDocument, direct: boolean, dx: number, dy: number) {
  const t = targetOf(doc);
  if (!t || locked(t)) return false;
  syncSel(t);
  if (direct && sel.pts.size) {
    doc.history.transaction('Nudge', () => {
      for (const k of sel.pts) { const [si, pi] = k.split(':').map(Number); const q = t.holder.subpaths[si].points[pi]; q.x += dx; q.y += dy; q.ix += dx; q.iy += dy; q.ox += dx; q.oy += dy; }
      dropLive(t);
    });
  } else {
    const idx = sel.subs.size ? [...sel.subs] : t.holder.subpaths.map((_, i) => i);
    if (!idx.length) return false;
    doc.history.transaction('Nudge', () => {
      if (t.layer && idx.length === t.holder.subpaths.length) t.layer.translate(dx, dy);
      else { translateSubs(idx.map(i => t.holder.subpaths[i]), dx, dy); dropLive(t); }
    });
  }
  touchDone(doc, t);
  return true;
}

// ------------------------------------------------------------------ shared pointer handlers
function hoverHighlight(doc: PixDocument, p: ToolPointer, s: SelSettings) {
  const tol = tolDoc(5);
  const t = targetOf(doc);
  let hl: SubPath[] | null = null;
  if (t) {
    const hs = hitSegment(t.holder.subpaths, p, tol);
    const si = hs ? hs.si : hitInside(t.holder.subpaths, p);
    if (si >= 0) hl = [t.holder.subpaths[si]];
  }
  if (!hl && s.layers === 'all') { const l = shapeLayerAt(doc, p, tol); if (l && l !== t?.layer) hl = l.subpaths; }
  if (overlay.hover !== hl) { overlay.hover = hl; doc.redrawOverlay(); }
}

function marqueeUp(doc: PixDocument, d: Extract<Drag, { kind: 'marquee' }>, s: SelSettings) {
  const r = d.rect;
  overlay.marquee = null;
  const inside = (q: Point) => q.x >= r.x && q.y >= r.y && q.x <= r.x + r.w && q.y <= r.y + r.h;
  const hits = (b: Rect | null) => !!b && b.x <= r.x + r.w && b.x + b.w >= r.x && b.y <= r.y + r.h && b.y + b.h >= r.y;
  let t = d.t;
  if (r.w < 1 && r.h < 1) {
    if (!d.additive) clearSel();
    doc.redrawOverlay();
    return;
  }
  if (!t && s.layers === 'all') {
    // pick shape layers touched by the marquee
    const layers = doc.allLayers().filter(l => isShapeLayer(l) && l.visible && hits(tightBounds(l.subpaths)));
    if (!layers.length) { doc.redrawOverlay(); return; }
    layers.forEach((l, i) => doc.setActiveLayer(l, i > 0));
    setPathSel(doc, 0);
    t = targetOf(doc);
    if (!t) return;
  }
  if (!t) return;
  syncSel(t);
  if (!d.additive) clearSel();
  t.holder.subpaths.forEach((sp, si) => {
    if (d.direct) {
      sp.points.forEach((q, pi) => { if (inside(q)) { sel.pts.add(ptKey(si, pi)); sel.subs.add(si); } });
    } else if (hits(tightBounds([sp]))) sel.subs.add(si);
  });
  doc.redrawOverlay();
}

function makeSelectTool(id: string, name: string, iconName: string, order: number, s: SelSettings, direct: boolean): Tool {
  const tool: Tool = {
    id, name, group: 'path-select', icon: iconName, shortcut: 'A', order, settings: s,
    cursor: doc => radiusCursor(doc) || (direct ? CUR_DIRECT : CUR_PATH_SELECT),
    activate() { overlay.showAnchors = direct; app.activeDoc?.redrawOverlay(); },
    deactivate() { overlay.hover = null; overlay.marquee = null; overlay.showAnchors = false; },
    options(bar) {
      const st = styleControls(), sz = sizeControls();
      const els: HTMLElement[] = [
        h('span.opt-label', null, 'Select:'),
        select([{ value: 'active', label: 'Active Layers' }, { value: 'all', label: 'All Layers' }], s.layers, v => { s.layers = v as any; app.saveToolSettings(tool); }, { width: 110, title: 'Select paths on the active layers or on all layers' }),
        separator(), ...st.els, separator(), ...sz.els, separator(),
        opsButton(null, null, false), alignButton(), arrangeButton(),
        gearButton('Set additional path options', () => [h('div.vo-gear-sep'), checkbox('Constrain Path Dragging', s.constrain, v => { s.constrain = v; app.saveToolSettings(tool); })]),
        separator(), alignEdgesBox(s, tool),
      ];
      const sync = () => { const shape = !!app.activeDoc && isShapeLayer(app.activeDoc.activeLayer); for (const e of [...st.els, ...sz.els]) e.style.display = shape ? '' : 'none'; st.sync(); sz.sync(); };
      bar.append(...els);
      sync();
      return onVectorChange(sync);
    },
    pointerDown(p, doc) {
      if (radiusPointerDown(p, doc)) { drag = { kind: 'radius' }; return; }
      directPointerDown(p, doc, s, direct);
    },
    pointerMove(p, doc) { selectPointerMove(p, doc, s); },
    pointerUp(p, doc) { selectPointerUp(p, doc, s); },
    hover(p, doc) { hoverHighlight(doc, p, s); },
    dblclick(_p, doc) {
      // double click on a shape layer with Path Selection → edit it with Direct Selection (like PS entering isolation)
      if (!direct && isShapeLayer(doc.activeLayer)) app.setTool('direct-select');
    },
    keyDown(e, doc) {
      if (!doc) return false;
      const map: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
      const v = map[e.key];
      if (v && !e.ctrlKey && !e.metaKey && !e.altKey) { const k = e.shiftKey ? 10 : 1; return nudge(doc, direct, v[0] * k, v[1] * k); }
      if ((e.key === 'Delete' || e.key === 'Backspace') && !e.ctrlKey) {
        const t = targetOf(doc);
        if (!t || locked(t)) return false;
        syncSel(t);
        if (direct && sel.pts.size) return deleteSelectedAnchors(doc, t);
        return deleteSelectedComponents(doc, t);
      }
      if (e.key === 'Escape') { const t = targetOf(doc); if (t && (sel.subs.size || sel.pts.size)) { clearSel(); doc.redrawOverlay(); return true; } }
      return false;
    },
    drawOverlay(ctx, view, doc) {
      if (overlay.marquee) drawMarquee(ctx, view, overlay.marquee);
      if (drag.kind === 'none' || drag.kind === 'radius') drawRadiusHandles(ctx, doc);
    },
  };
  return tool;
}

/** Pointer down for both selection tools (also used by the Pen's Ctrl override: direct = true). */
export function directPointerDown(p: ToolPointer, doc: PixDocument, s: SelSettings = dsSettings, direct = true) {
  const tol = tolDoc(5);
  let t = targetOf(doc);
  if (t) syncSel(t);
  if (direct && t) {
    const subs = t.holder.subpaths;
    // handles first (only visible ones)
    const hh = hitHandle(subs, p, tol, handleVisible(t));
    if (hh && !locked(t)) {
      drag = { kind: 'handle', t, si: hh.si, pi: hh.pi, which: hh.which, alt: p.alt, txn: doc.history.begin('Drag Handle') };
      return;
    }
    const ha = hitAnchor(subs, p, tol);
    if (ha) {
      const k = ptKey(ha.si, ha.pi);
      if (p.shift) { if (sel.pts.has(k)) sel.pts.delete(k); else sel.pts.add(k); sel.subs.add(ha.si); doc.redrawOverlay(); drag = { kind: 'none' }; return; }
      if (p.alt) { sel.subs = new Set([ha.si]); if (!locked(t)) startMove(doc, t, p, [ha.si], false); return; }
      if (!sel.pts.has(k)) { sel.pts.clear(); sel.pts.add(k); }
      sel.subs.add(ha.si);
      if (!locked(t)) drag = { kind: 'anchors', t, start: { x: p.x, y: p.y }, applied: { x: 0, y: 0 }, txn: doc.history.begin('Drag Anchor Point'), orig: t.holder.subpaths.map(cloneSub) };
      doc.redrawOverlay();
      return;
    }
    const hs = hitSegment(subs, p, tol);
    if (hs) {
      if (p.alt) { sel.subs = new Set([hs.si]); if (!locked(t)) startMove(doc, t, p, [hs.si], false); return; }
      if (!p.shift) sel.pts.clear();
      sel.subs.add(hs.si);
      if (!locked(t)) drag = { kind: 'segment', t, si: hs.si, seg: hs.seg, tt: hs.t, start: { x: p.x, y: p.y }, orig: cloneSub(subs[hs.si]), txn: doc.history.begin('Drag Segment') };
      doc.redrawOverlay();
      return;
    }
  }
  const pick = pickComponent(doc, p, s);
  if (pick) {
    t = pick.t;
    syncSel(t);
    if (direct && !p.alt) {
      // clicking inside a component: select the path (hollow anchors), no anchors selected
      if (!p.shift) sel.pts.clear();
      sel.subs = new Set([...(p.shift ? sel.subs : []), pick.si]);
      drag = { kind: 'marquee', t, start: { x: p.x, y: p.y }, rect: { x: p.x, y: p.y, w: 0, h: 0 }, additive: true, direct };
      doc.redrawOverlay();
      return;
    }
    if (p.shift && !p.alt) {
      if (sel.subs.has(pick.si)) { sel.subs.delete(pick.si); drag = { kind: 'none' }; doc.redrawOverlay(); return; }
      sel.subs.add(pick.si);
    } else if (!sel.subs.has(pick.si)) { sel.subs = new Set([pick.si]); sel.pts.clear(); }
    if (locked(t)) { drag = { kind: 'none' }; doc.redrawOverlay(); return; }
    startMove(doc, t, p, [...sel.subs], p.alt);
    doc.redrawOverlay();
    return;
  }
  drag = { kind: 'marquee', t, start: { x: p.x, y: p.y }, rect: { x: p.x, y: p.y, w: 0, h: 0 }, additive: p.shift, direct };
  if (!p.shift && t) { clearSel(); doc.redrawOverlay(); }
}

export function selectPointerMove(p: ToolPointer, doc: PixDocument, s: SelSettings = dsSettings) {
  const d = drag;
  if (d.kind === 'radius') { radiusPointerMove(p, doc); return; }
  if (d.kind === 'move') {
    let dx = p.x - d.start.x, dy = p.y - d.start.y;
    if (p.shift) { const q = snap45(d.start, p); dx = q.x - d.start.x; dy = q.y - d.start.y; }
    moveBy(doc, d, alignRound(s, dx), alignRound(s, dy));
    return;
  }
  if (d.kind === 'anchors') {
    let dx = p.x - d.start.x, dy = p.y - d.start.y;
    if (p.shift) { const q = snap45(d.start, p); dx = q.x - d.start.x; dy = q.y - d.start.y; }
    const subs = d.t.holder.subpaths;
    for (const k of sel.pts) {
      const [si, pi] = k.split(':').map(Number);
      const o = d.orig[si]?.points[pi], q = subs[si]?.points[pi];
      if (!o || !q) continue;
      q.x = o.x + dx; q.y = o.y + dy; q.ix = o.ix + dx; q.iy = o.iy + dy; q.ox = o.ox + dx; q.oy = o.oy + dy;
    }
    d.applied = { x: dx, y: dy };
    dropLive(d.t);
    touch(doc, d.t);
    return;
  }
  if (d.kind === 'handle') {
    const q = d.t.holder.subpaths[d.si]?.points[d.pi];
    if (!q) return;
    let v = { x: p.x, y: p.y };
    if (p.shift) v = snap45(q, v);
    moveHandle(q, d.which, v.x, v.y, d.alt || p.alt);
    dropLive(d.t);
    touch(doc, d.t);
    return;
  }
  if (d.kind === 'segment') {
    const sp = d.t.holder.subpaths[d.si], o = d.orig;
    const n = sp.points.length, i0 = d.seg, i1 = (d.seg + 1) % n;
    const dx = p.x - d.start.x, dy = p.y - d.start.y;
    const [a, b, c, e] = segCtrl(o, d.seg);
    const straight = b.x === a.x && b.y === a.y && c.x === e.x && c.y === e.y;
    if (straight || !s.constrain) {
      // move the segment's two anchors (with their handles); neighbouring segments stretch
      for (const i of [i0, i1]) { const q = sp.points[i], oq = o.points[i]; q.x = oq.x + dx; q.y = oq.y + dy; q.ix = oq.ix + dx; q.iy = oq.iy + dy; q.ox = oq.ox + dx; q.oy = oq.oy + dy; }
    } else {
      // reshape: move the control points so the curve passes through the pointer at parameter t
      const t = Math.max(0.05, Math.min(0.95, d.tt)), mt = 1 - t;
      const w1 = 3 * mt * mt * t, w2 = 3 * mt * t * t, den = w1 * w1 + w2 * w2;
      const k1 = w1 / den, k2 = w2 / den;
      const P = sp.points[i0], Q = sp.points[i1];
      P.ox = b.x + dx * k1; P.oy = b.y + dy * k1; Q.ix = c.x + dx * k2; Q.iy = c.y + dy * k2;
      P.smooth = false; Q.smooth = false;
    }
    dropLive(d.t);
    touch(doc, d.t);
    return;
  }
  if (d.kind === 'marquee') {
    const x = Math.min(d.start.x, p.x), y = Math.min(d.start.y, p.y);
    d.rect = { x, y, w: Math.abs(p.x - d.start.x), h: Math.abs(p.y - d.start.y) };
    overlay.marquee = d.rect.w * (app.viewport?.zoom || 1) > 2 || d.rect.h * (app.viewport?.zoom || 1) > 2 ? d.rect : null;
    doc.redrawOverlay();
  }
}

export function selectPointerUp(_p: ToolPointer, doc: PixDocument, s: SelSettings = dsSettings) {
  const d = drag;
  drag = { kind: 'none' };
  if (d.kind === 'radius') { radiusPointerUp(doc); return; }
  if (d.kind === 'move') {
    if (!d.applied.x && !d.applied.y) { d.txn.cancel(); if (d.t) syncSel(d.t); touchDone(doc, targetOf(doc)); return; }
    d.txn.commit();
    touchDone(doc, d.t);
    return;
  }
  if (d.kind === 'anchors') { if (!d.applied.x && !d.applied.y) d.txn.cancel(); else d.txn.commit(); touchDone(doc, d.t); return; }
  if (d.kind === 'handle' || d.kind === 'segment') { d.txn.commit(); touchDone(doc, d.t); return; }
  if (d.kind === 'marquee') marqueeUp(doc, d, s);
}

export const pathSelectTool = makeSelectTool('path-select', 'Path Selection Tool', 'path-select', 0, psSettings, false);
export const directSelectTool = makeSelectTool('direct-select', 'Direct Selection Tool', 'direct-select', 1, dsSettings, true);
app.registerTool(pathSelectTool);
app.registerTool(directSelectTool);
export const isSelectDragging = () => drag.kind !== 'none';
