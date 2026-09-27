// Object Selection Tool (W): drag a rectangle or lasso around an object → colour-model segmentation seeded by the
// region border as background, refined at the edges.
import { app, type Tool } from '../../core/app';
import type { Point, SelectOp } from '../../core/types';
import { checkbox, label, select } from '../../ui/widgets';
import { toast } from '../../ui/toast';
import { busy, commitMask, detectObject } from '../../features/selection/ops';
import {
  crossCursor, drawHud, liveOp, nudgeKey, onOptions, opButtons, resolveOp, selectAndMaskButton, selectionContextMenu,
  selectSubjectButton, separator, strokePolyline,
} from './common';

const s = { op: 'replace' as SelectOp, mode: 'rect' as 'rect' | 'lasso', sampleAll: false, hardEdge: false, objectSubtract: true };
let st: { op: SelectOp; a: Point; b: Point; pts: Point[]; moved: boolean } | null = null;

const tool: Tool = {
  id: 'object-select', name: 'Object Selection Tool', group: 'object-select', icon: 'object-select', shortcut: 'W', order: 0, settings: s,
  cursor: () => crossCursor(st ? st.op : liveOp(s.op)),
  options(bar) {
    const ops = opButtons(tool, s);
    const mode = select([{ value: 'rect', label: 'Rectangle' }, { value: 'lasso', label: 'Lasso' }], s.mode, v => { s.mode = v as 'rect' | 'lasso'; app.saveToolSettings(tool); }, { width: 96, title: 'Object finder mode' });
    const all = checkbox('Sample All Layers', s.sampleAll, v => { s.sampleAll = v; app.saveToolSettings(tool); });
    const hard = checkbox('Hard Edge', s.hardEdge, v => { s.hardEdge = v; app.saveToolSettings(tool); }, { title: 'Produce a hard selection edge' });
    const sub = checkbox('Object Subtract', s.objectSubtract, v => { s.objectSubtract = v; app.saveToolSettings(tool); }, { title: 'When subtracting, find and remove the object inside the region' });
    bar.append(ops, separator(), label('Mode:'), mode, separator(), all, hard, sub, separator(), selectSubjectButton(), selectAndMaskButton());
    return onOptions(() => { ops.setValue(s.op); mode.setValue(s.mode); all.setValue(s.sampleAll); hard.setValue(s.hardEdge); sub.setValue(s.objectSubtract); });
  },
  deactivate() { st = null; app.viewport && (app.viewport.hasAntsOverlay = false); },
  pointerDown(p) {
    st = { op: resolveOp(s.op, p.shift, p.alt), a: { x: p.x, y: p.y }, b: { x: p.x, y: p.y }, pts: [{ x: p.x, y: p.y }], moved: false };
    app.viewport!.hasAntsOverlay = true;
  },
  pointerMove(p, doc) {
    if (!st) return;
    st.b = { x: p.x, y: p.y };
    if (Math.hypot(p.x - st.a.x, p.y - st.a.y) * app.viewport!.zoom > 3) st.moved = true;
    if (s.mode === 'lasso') st.pts.push({ x: p.x, y: p.y });
    doc.redrawOverlay();
  },
  async pointerUp(_p, doc) {
    const x = st;
    st = null;
    app.viewport!.hasAntsOverlay = false;
    doc.redrawOverlay();
    if (!x) return;
    if (!x.moved) {
      if (x.op === 'replace' && !doc.selection.empty) doc.history.transaction('Deselect', () => doc.selection.deselect(), 'selection');
      return;
    }
    const xs = s.mode === 'lasso' ? x.pts.map(q => q.x) : [x.a.x, x.b.x], ys = s.mode === 'lasso' ? x.pts.map(q => q.y) : [x.a.y, x.b.y];
    const x0 = Math.max(0, Math.min(...xs)), y0 = Math.max(0, Math.min(...ys));
    const rect = { x: Math.floor(x0), y: Math.floor(y0), w: Math.ceil(Math.min(doc.width, Math.max(...xs)) - x0), h: Math.ceil(Math.min(doc.height, Math.max(...ys)) - y0) };
    const poly = s.mode === 'lasso' ? x.pts : undefined;
    if (x.op === 'subtract' && !s.objectSubtract) {
      // plain region subtract
      doc.history.transaction('Object Selection', () => poly ? doc.selection.selectPolygon(poly, 'subtract') : doc.selection.selectRect(rect, 'subtract'), 'selection');
      return;
    }
    const m = await busy('Object Selection…', () => detectObject(doc, { rect, poly }, s.sampleAll, { hard: s.hardEdge }));
    if (!m) { toast('No object was found in the selected region.'); return; }
    commitMask(doc, 'Object Selection', m, x.op);
  },
  keyDown(e, doc) {
    if (st && e.key === 'Escape') { st = null; app.viewport!.hasAntsOverlay = false; doc?.redrawOverlay(); return true; }
    return st ? false : nudgeKey(e, doc);
  },
  drawOverlay(ctx, view) {
    if (!st || !st.moved) return;
    if (s.mode === 'lasso') { strokePolyline(ctx, view, st.pts, st.pts[0], true); return; }
    const x = Math.min(st.a.x, st.b.x), y = Math.min(st.a.y, st.b.y), w = Math.abs(st.b.x - st.a.x), h = Math.abs(st.b.y - st.a.y);
    const path = new Path2D(); path.rect(x, y, w, h);
    view.strokeAnts(ctx, path);
    drawHud(ctx, view, [`W: ${Math.round(w)} px`, `H: ${Math.round(h)} px`]);
  },
  contextMenu: selectionContextMenu,
};
app.registerTool(tool);
