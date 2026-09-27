// Count Tool (I): numbered markers in count groups (doc.extra.counts).
import { app, type Tool } from '../../core/app';
import type { PixDocument } from '../../core/document';
import { events } from '../../core/events';
import { viewportHooks, viewOptions, type Viewport } from '../../core/viewport';
import { toCss } from '../../core/color';
import type { Point, RGB } from '../../core/types';
import { select, colorSwatch, button, separator, label, numberField, iconButton } from '../../ui/widgets';
import { h } from '../../ui/dom';
import { promptDialog } from '../../ui/dialog';
import { CURSORS } from '../../ui/cursors';
import { measureEvents } from './common';

export interface CountGroup { name: string; color: RGB; visible: boolean; markerSize: number; labelSize: number; points: Point[] }
export interface Counts { groups: CountGroup[]; active: number }

const GROUP_COLORS: RGB[] = [{ r: 255, g: 30, b: 30 }, { r: 20, g: 110, b: 255 }, { r: 0, g: 170, b: 60 }, { r: 255, g: 140, b: 0 }, { r: 170, g: 40, b: 220 }, { r: 0, g: 180, b: 190 }];
const newGroup = (i: number): CountGroup => ({ name: `Count Group ${i + 1}`, color: { ...GROUP_COLORS[i % GROUP_COLORS.length] }, visible: true, markerSize: 3, labelSize: 12, points: [] });

export function getCounts(doc: PixDocument | null): Counts {
  const c = doc?.extra?.counts as Counts | undefined;
  return c && c.groups?.length ? c : { groups: [newGroup(0)], active: 0 };
}
export const totalCount = (doc: PixDocument | null) => getCounts(doc).groups.reduce((n, g) => n + g.points.length, 0);
function setCounts(doc: PixDocument, name: string | null, c: Counts) {
  if (name) doc.history.transaction(name, () => { doc.extra = { ...doc.extra, counts: c }; });
  else doc.extra = { ...doc.extra, counts: c };   // view-only changes (visibility, active group)
  measureEvents.emit('counts', doc);
  doc.redrawOverlay();
}
const patchGroup = (c: Counts, i: number, p: Partial<CountGroup>): Counts => ({ ...c, groups: c.groups.map((g, j) => (j === i ? { ...g, ...p } : g)) });
export function clearCounts(doc: PixDocument, all = false) {
  const c = getCounts(doc);
  setCounts(doc, 'Clear Count', all ? { ...c, groups: c.groups.map(g => ({ ...g, points: [] })) } : patchGroup(c, c.active, { points: [] }));
}
const countsVisible = () => viewOptions.extras && (viewOptions as any).count !== false;

function markerAt(view: Viewport, doc: PixDocument, sx: number, sy: number): { g: number; i: number } | null {
  const c = getCounts(doc);
  for (let g = c.groups.length - 1; g >= 0; g--) {
    const grp = c.groups[g];
    if (!grp.visible) continue;
    for (let i = grp.points.length - 1; i >= 0; i--) {
      const p = view.docToScreen(grp.points[i].x, grp.points[i].y);
      if (Math.hypot(p.x - sx, p.y - sy) <= Math.max(6, grp.markerSize * 2)) return { g, i };
    }
  }
  return null;
}

function drawCounts(ctx: CanvasRenderingContext2D, view: Viewport, doc: PixDocument) {
  if (!countsVisible()) return;
  const c = getCounts(doc);
  ctx.save();
  c.groups.forEach((g, gi) => {
    if (!g.visible || !g.points.length) return;
    ctx.fillStyle = toCss(g.color);
    ctx.font = `600 ${g.labelSize}px Segoe UI, system-ui, sans-serif`;
    g.points.forEach((pt, i) => {
      const pos = drag && drag.g === gi && drag.i === i ? drag.pos : pt;
      const p = view.docToScreen(pos.x, pos.y);
      const r = 1.5 + g.markerSize * 1.2;
      ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, Math.PI * 2); ctx.fill();
      ctx.lineWidth = 1; ctx.strokeStyle = 'rgba(255,255,255,.85)'; ctx.stroke();
      const t = String(i + 1);
      ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(255,255,255,.8)'; ctx.strokeText(t, p.x + r + 2, p.y - r - 1);
      ctx.fillText(t, p.x + r + 2, p.y - r - 1);
    });
  });
  ctx.restore();
}
viewportHooks.overlay.push(drawCounts);

let drag: { g: number; i: number; pos: Point; start: Point; orig: Point; moved: boolean } | null = null;

const tool: Tool = {
  id: 'count', name: 'Count Tool', group: 'eyedropper', icon: 'count', shortcut: 'I', order: 4,
  cursor: () => {
    const v = app.viewport, d = app.activeDoc;
    return v && d && markerAt(v, d, v.pointer.sx, v.pointer.sy) ? 'move' : CURSORS.crosshair;
  },
  options(bar) {
    const countLbl = h('span.ms-count');
    const groupSel = h('span.ms-group-host');
    const vis = iconButton('eye', 'Toggle count group visibility', () => { const d = app.activeDoc; if (!d) return; const c = getCounts(d); setCounts(d, null, patchGroup(c, c.active, { visible: !c.groups[c.active].visible })); });
    const folderBtn = iconButton('folder', 'Create a new count group', () => newCountGroup());
    const clear = button('Clear', () => app.activeDoc && clearCounts(app.activeDoc), { cls: 'small', title: 'Clear the counts of the current group' });
    const color = colorSwatch({ r: 255, g: 0, b: 0 }, col => { const d = app.activeDoc; if (!d) return; const c = getCounts(d); setCounts(d, 'Count Group Color', patchGroup(c, c.active, { color: col })); }, { title: 'Count group color', size: 20 });
    const marker = numberField(3, v => { const d = app.activeDoc; if (!d) return; const c = getCounts(d); setCounts(d, null, patchGroup(c, c.active, { markerSize: v })); }, { label: 'Marker Size:', min: 1, max: 10, width: 36 });
    const lab = numberField(12, v => { const d = app.activeDoc; if (!d) return; const c = getCounts(d); setCounts(d, null, patchGroup(c, c.active, { labelSize: v })); }, { label: 'Label Size:', min: 8, max: 72, width: 36 });
    bar.append(label('Count:'), countLbl, separator(), groupSel, vis, folderBtn, h('span.ms-trash'), clear, separator(), color, separator(), marker, lab);
    const sync = () => {
      const d = app.activeDoc, c = getCounts(d), g = c.groups[c.active];
      countLbl.textContent = String(g.points.length);
      const sel = select(c.groups.map((gg, i) => ({ value: i, label: gg.name })).concat([{ value: -1, label: 'New Count Group...' }, { value: -2, label: 'Rename...' }, { value: -3, label: 'Delete Count Group' }] as any), c.active, v => {
        if (!d) return;
        if (v === -1) newCountGroup();
        else if (v === -2) renameGroup();
        else if (v === -3) deleteGroup();
        else setCounts(d, null, { ...getCounts(d), active: v });
      }, { width: 150, title: 'Count Group' });
      groupSel.replaceChildren(sel);
      vis.replaceChildren(...(h('span', null) as any).childNodes);
      vis.innerHTML = '';
      vis.append(iconButton(g.visible ? 'eye' : 'eye-off', '').firstChild!);
      color.setValue(g.color); marker.setValue(g.markerSize); lab.setValue(g.labelSize);
    };
    sync();
    const offs = [measureEvents.on('counts', sync), events.on('activeDoc', sync), events.on('history', sync)];
    return () => offs.forEach(f => f());
  },
  pointerDown(p, doc) {
    const hit = markerAt(app.viewport!, doc, p.sx, p.sy);
    const c = getCounts(doc);
    if (hit) {
      if (p.alt) { setCounts(doc, 'Delete Count', patchGroup(c, hit.g, { points: c.groups[hit.g].points.filter((_, i) => i !== hit.i) })); return; }
      const pt = c.groups[hit.g].points[hit.i];
      drag = { ...hit, pos: { ...pt }, start: { x: p.x, y: p.y }, orig: { ...pt }, moved: false };
      return;
    }
    if (p.x < 0 || p.y < 0 || p.x >= doc.width || p.y >= doc.height) return;
    const g = c.groups[c.active];
    const groups = g.visible ? c : patchGroup(c, c.active, { visible: true });
    setCounts(doc, 'Count', patchGroup(groups, c.active, { points: [...g.points, { x: Math.round(p.x * 10) / 10, y: Math.round(p.y * 10) / 10 }] }));
  },
  pointerMove(p, doc) {
    if (!drag) return;
    drag.pos = { x: drag.orig.x + p.x - drag.start.x, y: drag.orig.y + p.y - drag.start.y };
    drag.moved = true;
    doc.redrawOverlay();
  },
  pointerUp(_p, doc) {
    const d = drag;
    drag = null;
    if (!d?.moved) return;
    const c = getCounts(doc);
    setCounts(doc, 'Move Count', patchGroup(c, d.g, { points: c.groups[d.g].points.map((q, i) => (i === d.i ? d.pos : q)) }));
  },
};
app.registerTool(tool);

async function newCountGroup() {
  const d = app.activeDoc;
  if (!d) return;
  const c = getCounts(d);
  const name = await promptDialog('Count Group Name', 'Name:', `Count Group ${c.groups.length + 1}`);
  if (!name) { measureEvents.emit('counts', d); return; }
  setCounts(d, 'New Count Group', { groups: [...c.groups, { ...newGroup(c.groups.length), name }], active: c.groups.length });
}
async function renameGroup() {
  const d = app.activeDoc;
  if (!d) return;
  const c = getCounts(d);
  const name = await promptDialog('Count Group Name', 'Name:', c.groups[c.active].name);
  if (!name) { measureEvents.emit('counts', d); return; }
  setCounts(d, 'Rename Count Group', patchGroup(c, c.active, { name }));
}
function deleteGroup() {
  const d = app.activeDoc;
  if (!d) return;
  const c = getCounts(d);
  const groups = c.groups.filter((_, i) => i !== c.active);
  setCounts(d, 'Delete Count Group', groups.length ? { groups, active: Math.max(0, c.active - 1) } : { groups: [newGroup(0)], active: 0 });
}
