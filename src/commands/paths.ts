// Path commands (Paths panel buttons/menu, Pen "Make:" buttons, Edit › Define Custom Shape):
// Make Selection, Fill Path, Stroke Path, Make Work Path, vector mask, shape from path, new/duplicate/delete/save paths,
// Clipping Path.
import { app } from '../core/app';
import { registerCommands } from '../core/commands';
import type { PixDocument } from '../core/document';
import type { RGB, SelectOp, BlendMode } from '../core/types';
import { BLEND_MODE_LABELS, BLEND_MODE_MENU } from '../core/types';
import { traceAlpha, type SubPath, type VectorPath } from '../core/path';
import { PaintStroke, type InputPoint } from '../core/brush';
import { resources } from '../core/registry';
import { hooks } from '../core/registry';
import { events } from '../core/events';
import { h } from '../ui/dom';
import { openDialog, promptDialog } from '../ui/dialog';
import { toast } from '../ui/toast';
import { checkbox, numberField, patternPicker, select } from '../ui/widgets';
import { isShapeLayer } from '../layers/shape-layer';
import {
  clearSel, fitCornerCurve, getPathSel, nextPathId, nextPathName, sel, setPathSel, syncSel, targetOf, type Target,
} from '../tools/vector/common';
import { cloneSubs, flattenSub, subsToSvg, tightBounds, transformSubsInPlace } from '../tools/vector/geom';
import { fillPathPixels, pathAlpha } from '../tools/vector/raster';
import { newShapeLayer } from '../tools/vector/shape-tools';
import { saveUserShapes } from '../tools/vector/resources';

const D = () => app.activeDoc;

/** The path the commands act on: selected components of the target path, else all of it. */
export function activeSubpaths(doc: PixDocument): { t: Target; subs: SubPath[] } | null {
  const t = targetOf(doc);
  if (!t || !t.holder.subpaths.length) return null;
  syncSel(t);
  const picked = sel.subs.size && sel.subs.size < t.holder.subpaths.length ? t.holder.subpaths.filter((_, i) => sel.subs.has(i)) : t.holder.subpaths;
  return { t, subs: picked.filter(s => s.points.length > 0) };
}
const hasPath = () => { const d = D(); return !!d && !!activeSubpaths(d); };
const needPath = (doc: PixDocument) => {
  const a = activeSubpaths(doc);
  if (!a) toast('There is no path selected. Select a path in the Paths panel first.', 'error');
  return a;
};
const f = (lab: string, ...c: (HTMLElement | null)[]) => h('div.form-row', null, h('label.form-label', null, lab), ...c);

// ------------------------------------------------------------------ Make Selection
export function makeSelection(doc: PixDocument, subs: SubPath[], op: SelectOp = 'replace', feather = 0, antiAlias = true) {
  doc.history.transaction('Make Selection', () => doc.selection.apply(pathAlpha(doc, subs, antiAlias), op, feather));
}
async function makeSelectionDialog(arg?: { feather?: number; antiAlias?: boolean; op?: SelectOp }) {
  const doc = D(); if (!doc) return;
  const a = needPath(doc); if (!a) return;
  if (arg && (arg.op || arg.feather !== undefined)) { makeSelection(doc, a.subs, arg.op || 'replace', arg.feather || 0, arg.antiAlias !== false); return; }
  const v = { feather: 0, aa: true, op: 'replace' as SelectOp };
  const has = !doc.selection.empty;
  const radio = (label: string, op: SelectOp) => {
    const inp = h('input', { type: 'radio', name: 'px-mksel-op', checked: op === 'replace', disabled: op !== 'replace' && !has }) as HTMLInputElement;
    inp.onchange = () => { v.op = op; };
    return h('label.form-row', { style: { minHeight: '20px', paddingLeft: '8px' } }, inp, h('span', null, label));
  };
  const body = h('div.form', null,
    h('fieldset.vo-fieldset', null, h('legend', null, 'Rendering'),
      f('Feather Radius:', numberField(0, x => { v.feather = x; }, { min: 0, max: 1000, decimals: 1, width: 60 }), h('span', null, 'pixels')),
      f('', checkbox('Anti-aliased', true, x => { v.aa = x; }))),
    h('fieldset.vo-fieldset', null, h('legend', null, 'Operation'),
      radio('New Selection', 'replace'), radio('Add to Selection', 'add'), radio('Subtract from Selection', 'subtract'), radio('Intersect with Selection', 'intersect')));
  const ok = await openDialog({ title: 'Make Selection', body, width: 380 }).result;
  if (ok) makeSelection(doc, a.subs, v.op, v.feather, v.aa);
}

// ------------------------------------------------------------------ Fill Path
type Contents = 'fg' | 'bg' | 'color' | 'pattern' | 'black' | 'gray' | 'white';
async function fillPathCmd(arg?: 'quick' | { contents?: Contents; color?: RGB }) {
  const doc = D(); if (!doc) return;
  const a = needPath(doc); if (!a) return;
  const name = a.subs.length < a.t.holder.subpaths.length ? 'Fill Subpath' : 'Fill Path';
  if (arg === 'quick') { fillPathPixels(doc, a.subs, { color: app.fg, opacity: 1, blend: 'normal', antiAlias: true, feather: 0 }, name); return; }
  const v = { contents: 'fg' as Contents, color: app.fg, pattern: resources.patterns[0] || null, mode: 'normal' as BlendMode, opacity: 100, preserve: false, feather: 0, aa: true };
  const patRow = f('Custom Pattern:', patternPicker(v.pattern, p => { v.pattern = p; }));
  patRow.style.display = 'none';
  const body = h('div.form', null,
    f('Contents:', select<Contents>([{ value: 'fg', label: 'Foreground Color' }, { value: 'bg', label: 'Background Color' }, { value: 'color', label: 'Color...' }, { value: 'pattern', label: 'Pattern' }, '-', { value: 'black', label: 'Black' }, { value: 'gray', label: '50% Gray' }, { value: 'white', label: 'White' }], 'fg', async c => {
      v.contents = c;
      patRow.style.display = c === 'pattern' ? '' : 'none';
      if (c === 'color') { const col = await hooks.openColorPicker(v.color, 'Choose a color:'); if (col) v.color = col; }
    }, { width: 160 })),
    patRow,
    h('fieldset.vo-fieldset', null, h('legend', null, 'Blending'),
      f('Mode:', select<BlendMode>(BLEND_MODE_MENU.map(m => (m === '-' ? '-' : { value: m, label: BLEND_MODE_LABELS[m] })), 'normal', m => { v.mode = m; }, { width: 140 })),
      f('Opacity:', numberField(100, x => { v.opacity = x; }, { min: 1, max: 100, unit: '%', width: 56 })),
      f('', checkbox('Preserve Transparency', false, x => { v.preserve = x; }))),
    h('fieldset.vo-fieldset', null, h('legend', null, 'Rendering'),
      f('Feather Radius:', numberField(0, x => { v.feather = x; }, { min: 0, max: 250, decimals: 1, width: 60 }), h('span', null, 'pixels')),
      f('', checkbox('Anti-aliased', true, x => { v.aa = x; }))));
  const ok = await openDialog({ title: name, body, width: 420 }).result;
  if (!ok) return;
  const col: Record<Contents, RGB> = { fg: app.fg, bg: app.bg, color: v.color, pattern: app.fg, black: { r: 0, g: 0, b: 0 }, gray: { r: 128, g: 128, b: 128 }, white: { r: 255, g: 255, b: 255 } };
  fillPathPixels(doc, a.subs, {
    color: col[v.contents], pattern: v.contents === 'pattern' ? v.pattern?.canvas || null : null,
    opacity: v.opacity / 100, blend: v.mode, antiAlias: v.aa, feather: v.feather, preserveTransparency: v.preserve,
  }, name);
}

// ------------------------------------------------------------------ Stroke Path
const STROKE_TOOLS: [string, string][] = [['pencil', 'Pencil'], ['brush', 'Brush'], ['eraser', 'Eraser']];
/** Stroke the subpaths with a painting tool's current settings (one history state). */
export function strokeSubpaths(doc: PixDocument, subs: SubPath[], toolId = 'brush', simulatePressure = false, name = 'Stroke Path'): boolean {
  const target = doc.getPaintTarget();
  if (!target) { toast('Could not stroke the path because the target layer is not a pixel layer. Rasterize it first.', 'error', 3600); return false; }
  if (target.kind === 'pixels' && target.layer!.pixelsLocked) { toast('Could not stroke the path because the layer is locked.', 'error'); return false; }
  const s: any = app.getTool(toolId)?.settings || {};
  const norm = (v: any, d: number) => { const n = typeof v === 'number' ? v : d; return n > 1 ? n / 100 : n; };
  const tipPreset = resources.brushes.find(b => b.id === s.tipId);
  const pencil = toolId === 'pencil';
  const opts = {
    size: Math.max(1, s.size ?? (pencil ? 1 : 13)), hardness: pencil ? 1 : norm(s.hardness, tipPreset?.hardness ?? 1),
    spacing: s.spacing ?? 0.25, roundness: s.roundness ?? 1, angle: s.angle ?? 0, tip: tipPreset?.tip || null, aliased: pencil,
    opacity: norm(s.opacity, 1), flow: pencil ? 1 : norm(s.flow, 1), color: app.fg,
    mode: toolId === 'eraser' ? 'erase' as const : 'paint' as const, blendMode: (s.mode && s.mode !== 'block' && s.mode !== 'pencil' ? s.mode : 'normal') as any,
    pressureSize: simulatePressure, pressureOpacity: false, historyName: name,
  };
  let painted = false;
  doc.history.transaction(name, () => {
    for (const sp of subs) {
      const pts = flattenSub(sp, 0.2);
      if (sp.closed && pts.length > 1) pts.push({ ...pts[0] });
      if (pts.length < 1) continue;
      let total = 0;
      const cum = [0];
      for (let i = 1; i < pts.length; i++) { total += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y); cum.push(total); }
      const pr = (i: number) => (simulatePressure && total > 0 ? Math.max(0.05, Math.sin(Math.PI * (cum[i] / total))) : 1);
      const ip = (i: number): InputPoint => ({ x: pts[i].x, y: pts[i].y, pressure: pr(i) });
      const st = PaintStroke.start(doc, opts, ip(0));
      if (!st) continue;
      for (let i = 1; i < pts.length; i++) st.move(ip(i));
      st.end(ip(pts.length - 1));
      painted = true;
    }
  });
  return painted;
}
async function strokePathCmd(arg?: 'quick' | { tool?: string; pressure?: boolean }) {
  const doc = D(); if (!doc) return;
  const a = needPath(doc); if (!a) return;
  const name = a.subs.length < a.t.holder.subpaths.length ? 'Stroke Subpath' : 'Stroke Path';
  if (arg === 'quick') { strokeSubpaths(doc, a.subs, 'brush', false, name); return; }
  if (arg && typeof arg === 'object') { strokeSubpaths(doc, a.subs, arg.tool || 'brush', !!arg.pressure, name); return; }
  const cur = app.activeTool?.id;
  const v = { tool: STROKE_TOOLS.some(t => t[0] === cur) ? cur! : 'brush', pressure: false };
  const body = h('div.form', null,
    f('Tool:', select(STROKE_TOOLS.map(([value, label]) => ({ value, label, icon: value, disabled: !app.getTool(value) })), v.tool, x => { v.tool = x; }, { width: 150 })),
    f('', checkbox('Simulate Pressure', false, x => { v.pressure = x; })));
  const ok = await openDialog({ title: name, body, width: 330 }).result;
  if (ok) strokeSubpaths(doc, a.subs, v.tool, v.pressure, name);
}

// ------------------------------------------------------------------ Make Work Path (from selection)
export function makeWorkPath(doc: PixDocument, tolerance = 2): VectorPath | null {
  if (doc.selection.empty) { toast('There is no selection to make a work path from.', 'error'); return null; }
  const loops = traceAlpha(doc.selection.mask!, Math.max(0.25, tolerance * 0.5), 128);
  const subs: SubPath[] = loops.map(lp => ({ closed: true, op: 'add' as const, points: fitCornerCurve(lp.points.map(q => ({ x: q.x, y: q.y })), Math.max(0.3, tolerance * 0.6), true) })).filter(sp => sp.points.length >= 2);
  // holes: subpaths inside an odd number of others are subtracted
  let wp: VectorPath | null = null;
  doc.history.transaction('Make Work Path', () => {
    doc.paths = doc.paths.filter((p: VectorPath) => p.kind !== 'work');
    wp = { id: nextPathId(doc), name: 'Work Path', kind: 'work', subpaths: subs };
    doc.paths.unshift(wp);
  });
  import('../tools/vector/geom').then(g => { if (wp) { g.assignHoleOps(wp.subpaths, 'add'); events.emit('paths', doc); doc.redrawOverlay(); } });
  setPathSel(doc, wp!.id);
  return wp;
}
async function makeWorkPathDialog(arg?: number) {
  const doc = D(); if (!doc) return;
  if (typeof arg === 'number') { makeWorkPath(doc, arg); return; }
  let tol = 2;
  const body = h('div.form', null, f('Tolerance:', numberField(2, x => { tol = x; }, { min: 0.5, max: 10, decimals: 1, width: 56 }), h('span', null, 'pixels')));
  const ok = await openDialog({ title: 'Make Work Path', body, width: 320 }).result;
  if (ok) makeWorkPath(doc, tol);
}

// ------------------------------------------------------------------ mask / shape from path
function addVectorMask() {
  const doc = D(); if (!doc) return;
  const a = needPath(doc); if (!a) return;
  const l = doc.activeLayer;
  if (!l) { toast('No layer is selected.', 'error'); return; }
  if (l.isBackground) { toast('Could not add a vector mask because the layer is a Background layer.', 'error'); return; }
  if (l.mask) { toast('The layer already has a mask. Delete it first to add a vector mask.', 'error'); return; }
  const c = pathAlpha(doc, a.subs, true);
  doc.history.transaction('Add Vector Mask', () => {
    l.mask = { canvas: c, x: 0, y: 0, bg: 0, enabled: true, linked: true, density: 1, feather: 0 };
    (l.mask as any).vector = true;
    (l.mask as any).vectorPath = cloneSubs(a.subs);
  });
  doc.editMask = false;
  doc.layersChanged();
}
function makeShapeFromPath() {
  const doc = D(); if (!doc) return;
  const a = needPath(doc); if (!a) return;
  if (a.t.layer) { toast('The path already belongs to a shape layer.'); return; }
  doc.history.transaction('New Shape Layer', () => { newShapeLayer(doc, 'custom', cloneSubs(a.subs), null); });
  setPathSel(doc, 0);
  doc.layersChanged();
  events.emit('paths', doc);
}

// ------------------------------------------------------------------ path list management
function pathById(doc: PixDocument, id: number): VectorPath | undefined { return doc.paths.find((p: VectorPath) => p.id === id); }
/** Path shown as selected in the Paths panel (null for a shape layer path). */
export function selectedPath(doc: PixDocument): VectorPath | null { const s = getPathSel(doc); return s > 0 ? pathById(doc, s) || null : null; }

async function newPath(arg?: string) {
  const doc = D(); if (!doc) return;
  const name = arg ?? await promptDialog('New Path', 'Name:', nextPathName(doc));
  if (name === null) return;
  const p: VectorPath = { id: nextPathId(doc), name: name || nextPathName(doc), kind: 'saved', subpaths: [] };
  doc.history.transaction('New Path', () => { doc.paths.push(p); });
  setPathSel(doc, p.id);
  events.emit('paths', doc);
}
/** Save the Work Path (or duplicate a saved one / a shape path) under a name. */
async function savePath(arg?: { id?: number; name?: string }) {
  const doc = D(); if (!doc) return;
  const src = arg?.id !== undefined ? pathById(doc, arg.id) : selectedPath(doc);
  if (!src || src.kind !== 'work') return;
  const name = arg?.name ?? await promptDialog('Save Path', 'Name:', nextPathName(doc));
  if (name === null) return;
  doc.history.transaction('Save Path', () => {
    const p = pathById(doc, src.id)!;
    p.kind = 'saved'; p.name = name || nextPathName(doc);
  });
  events.emit('paths', doc);
}
async function duplicatePath(arg?: { name?: string }) {
  const doc = D(); if (!doc) return;
  const t = targetOf(doc);
  if (!t) return;
  const base = t.path ? t.path.name : `${t.layer!.name} Shape Path`;
  const name = arg?.name ?? await promptDialog('Duplicate Path', 'Name:', t.path?.kind === 'work' ? nextPathName(doc) : `${base} copy`);
  if (name === null) return;
  const p: VectorPath = { id: nextPathId(doc), name: name || `${base} copy`, kind: 'saved', subpaths: cloneSubs(t.holder.subpaths) };
  doc.history.transaction('Duplicate Path', () => { doc.paths.push(p); });
  setPathSel(doc, p.id);
  events.emit('paths', doc);
}
function deletePath() {
  const doc = D(); if (!doc) return;
  const t = targetOf(doc);
  if (!t) return;
  if (t.layer) {
    // deleting a shape path deletes the shape layer's vector content (PS removes the layer)
    const l = t.layer;
    doc.history.transaction('Delete Layer', () => doc.removeLayer(l));
    return;
  }
  const id = t.path!.id;
  doc.history.transaction('Delete Path', () => {
    doc.paths = doc.paths.filter((p: VectorPath) => p.id !== id);
    if (doc.extra.clippingPath?.id === id) delete doc.extra.clippingPath;
  });
  setPathSel(doc, -1);
  clearSel();
  events.emit('paths', doc);
  doc.redrawOverlay();
}
function renamePath(arg: { id: number; name: string }) {
  const doc = D(); if (!doc) return;
  const p = pathById(doc, arg.id);
  if (!p || !arg.name || p.name === arg.name) return;
  doc.history.transaction(p.kind === 'work' ? 'Save Path' : 'Rename Path', () => { const q = pathById(doc, arg.id)!; q.name = arg.name; if (q.kind === 'work') q.kind = 'saved'; });
  events.emit('paths', doc);
}
async function clippingPath() {
  const doc = D(); if (!doc) return;
  const saved = doc.paths.filter((p: VectorPath) => p.kind !== 'work') as VectorPath[];
  if (!saved.length) { toast('Save a path first: only saved paths can be used as a clipping path.', 'error'); return; }
  const cur = doc.extra.clippingPath as { id: number; flatness: number } | undefined;
  const v = { id: cur?.id ?? selectedPath(doc)?.id ?? saved[0].id, flatness: cur?.flatness ?? 0 };
  const body = h('div.form', null,
    f('Path:', select([{ value: 0, label: 'None' }, ...saved.map(p => ({ value: p.id, label: p.name }))], v.id, x => { v.id = x; }, { width: 170 })),
    f('Flatness:', numberField(v.flatness, x => { v.flatness = x; }, { min: 0, max: 100, decimals: 1, width: 56 }), h('span', null, 'device pixels')));
  const ok = await openDialog({ title: 'Clipping Path', body, width: 360 }).result;
  if (!ok) return;
  doc.history.transaction('Clipping Path', () => {
    if (!v.id) delete doc.extra.clippingPath;
    else doc.extra.clippingPath = { id: v.id, flatness: v.flatness };
  });
  events.emit('paths', doc);
}

// ------------------------------------------------------------------ Define Custom Shape
async function defineShape() {
  const doc = D(); if (!doc) return;
  const a = activeSubpaths(doc);
  if (!a) { toast('Could not complete the Define Custom Shape command because there is no path or shape selected.', 'error', 3600); return; }
  const name = await promptDialog('Shape Name', 'Name:', `Shape ${resources.shapes.filter(s => s.id.startsWith('user-')).length + 1}`);
  if (!name) return;
  const b = tightBounds(a.subs);
  if (!b || (b.w < 1 && b.h < 1)) return;
  const k = 100 / Math.max(b.w, b.h);
  const subs = cloneSubs(a.subs);
  transformSubsInPlace(subs, new DOMMatrix().scale(k, k).translate(-b.x, -b.y));
  resources.shapes.push({ id: `user-${Date.now().toString(36)}`, name, path: subsToSvg(subs), group: 'Custom' } as any);
  saveUserShapes();
  events.emit('paths', doc);
  toast(`Custom shape "${name}" defined`, 'success');
}

registerCommands([
  { id: 'paths.makeSelection', label: 'Make Selection...', run: a => makeSelectionDialog(a), enabled: hasPath },
  { id: 'paths.loadSelection', label: 'Load Path as Selection', run: (op?: SelectOp) => { const d = D(); const a = d && activeSubpaths(d); if (d && a) makeSelection(d, a.subs, op || 'replace'); }, enabled: hasPath },
  { id: 'paths.fill', label: 'Fill Path...', run: a => fillPathCmd(a), enabled: hasPath },
  { id: 'paths.stroke', label: 'Stroke Path...', run: a => strokePathCmd(a), enabled: hasPath },
  { id: 'paths.makeWorkPath', label: 'Make Work Path...', run: a => makeWorkPathDialog(a), enabled: () => !!D() && !D()!.selection.empty },
  { id: 'paths.addMask', label: 'Add Vector Mask', run: addVectorMask, enabled: hasPath },
  { id: 'paths.makeShape', label: 'Make Shape', run: makeShapeFromPath, enabled: hasPath },
  { id: 'paths.new', label: 'New Path...', run: a => newPath(a), enabled: () => !!D() },
  { id: 'paths.save', label: 'Save Path...', run: a => savePath(a), enabled: () => !!D() && selectedPath(D()!)?.kind === 'work' },
  { id: 'paths.duplicate', label: 'Duplicate Path...', run: a => duplicatePath(a), enabled: () => !!D() && !!targetOf(D()!) },
  { id: 'paths.delete', label: 'Delete Path', run: deletePath, enabled: () => !!D() && !!targetOf(D()!) },
  { id: 'paths.rename', label: 'Rename Path', run: a => renamePath(a), enabled: () => !!D() },
  { id: 'paths.clipping', label: 'Clipping Path...', run: clippingPath, enabled: () => !!D() },
  { id: 'paths.deselect', label: 'Deselect Path', run: () => { const d = D(); if (d) { setPathSel(d, -1); clearSel(); } }, enabled: () => !!D() },
  { id: 'edit.defineShape', label: 'Define Custom Shape...', run: defineShape, enabled: hasPath },
]);
void isShapeLayer;
