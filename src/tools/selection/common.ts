// Shared pieces for the selection tools: selection-op buttons, modifier tracking, cursors, the canvas context menu,
// moving / nudging the selection outline, HUD and ants drawing helpers.
import './selection.css';
import { app, type Tool, type ToolPointer } from '../../core/app';
import type { PixDocument } from '../../core/document';
import type { Viewport } from '../../core/viewport';
import type { SelectOp } from '../../core/types';
import { createCanvas, ctx2d } from '../../core/canvas';
import { commands, runCommand } from '../../core/commands';
import { svgCursor } from '../../ui/cursors';
import { openMenu, type MenuEntry } from '../../ui/menu';
import { button, toggleGroup, numberField, checkbox, separator, type Field } from '../../ui/widgets';
import { events } from '../../core/events';
import { resolveOp } from '../../features/selection/ops';

export { resolveOp };

// ------------------------------------------------------------------ modifier keys (for cursors / previews)
export const mods = { shift: false, alt: false, space: false };
const syncMods = (e: KeyboardEvent) => { mods.shift = e.shiftKey; mods.alt = e.altKey; };
window.addEventListener('keydown', e => { syncMods(e); if (e.code === 'Space') mods.space = true; }, true);
window.addEventListener('keyup', e => { syncMods(e); if (e.code === 'Space') mods.space = false; }, true);
window.addEventListener('blur', () => { mods.shift = mods.alt = mods.space = false; });

/** The op that a click would perform now (tool setting + held modifiers). */
export const liveOp = (base: SelectOp) => resolveOp(base, mods.shift, mods.alt);

// ------------------------------------------------------------------ options bar pieces
const OP_ITEMS: { value: SelectOp; icon: string; title: string }[] = [
  { value: 'replace', icon: 'sel-new', title: 'New selection' },
  { value: 'add', icon: 'sel-add', title: 'Add to selection (Shift)' },
  { value: 'subtract', icon: 'sel-subtract', title: 'Subtract from selection (Alt)' },
  { value: 'intersect', icon: 'sel-intersect', title: 'Intersect with selection (Shift+Alt)' },
];
export function opButtons(tool: Tool, s: { op: SelectOp }, only?: SelectOp[]): Field<SelectOp> {
  const g = toggleGroup(OP_ITEMS.filter(i => !only || only.includes(i.value)), s.op, v => { s.op = v; app.saveToolSettings(tool); });
  g.classList.add('sel-ops');
  return g;
}
export function featherField(tool: Tool, s: { feather: number }): Field<number> {
  return numberField(s.feather, v => { s.feather = v; app.saveToolSettings(tool); }, { min: 0, max: 1000, unit: 'px', width: 48, label: 'Feather:', title: 'Feather radius of the new selection (0–1000 px)' });
}
export function antiAliasBox(tool: Tool, s: { antiAlias: boolean }): Field<boolean> {
  return checkbox('Anti-alias', s.antiAlias, v => { s.antiAlias = v; app.saveToolSettings(tool); }, { title: 'Smooth the jagged edges of the selection' });
}
export function selectAndMaskButton(): HTMLButtonElement {
  return button('Select and Mask...', () => runCommand('select.selectAndMask'), { title: 'Refine the selection edge in the Select and Mask workspace (Alt+Ctrl+R)', cls: 'sel-sam-btn' });
}
export function selectSubjectButton(): HTMLButtonElement {
  return button('Select Subject', () => runCommand('select.subject'), { title: 'Automatically select the most prominent subject in the image', cls: 'sel-subject-btn' });
}
export { separator };

/** Re-sync option widgets when settings change elsewhere (tool presets / reset). */
export function onOptions(fn: () => void) { return events.on('toolOptions', fn); }

// ------------------------------------------------------------------ cursors
const badge: Record<SelectOp, string> = {
  replace: '',
  add: '<path d="M18 16v6M15 19h6"/>',
  subtract: '<path d="M15 19h6"/>',
  intersect: '<path d="m15.5 16.5 5 5M20.5 16.5l-5 5"/>',
};
const CROSS = '<path d="M9 1v6M9 11v6M1 9h6M11 9h6"/>';
export function crossCursor(op: SelectOp) { return svgCursor(CROSS + badge[op], 9, 9, 'crosshair'); }
/** Cursor made from a tool glyph (lasso etc.) with an op badge. */
export function glyphCursor(body: string, hx: number, hy: number, op: SelectOp) { return svgCursor(body + badge[op], hx, hy, 'crosshair'); }
export const MOVE_SEL_CURSOR = svgCursor('<path d="m3 2 0 12 3.2-3.2 2.3 5 1.8-.9-2.3-5H12z" fill="#000"/><rect x="12.5" y="13.5" width="8" height="6" stroke-dasharray="1.6 1.4"/>', 3, 2, 'default');

// ------------------------------------------------------------------ outline move / nudge
/** Translate the selection mask by whole pixels (new canvas; record in a transaction). */
export function translateSelection(doc: PixDocument, dx: number, dy: number, name = 'Move Selection') {
  if (doc.selection.empty || (!dx && !dy)) return;
  const m = createCanvas(doc.width, doc.height);
  ctx2d(m).drawImage(doc.selection.mask!, Math.round(dx), Math.round(dy));
  doc.history.transaction(name, () => doc.selection.setMask(m), 'selection');
}

export interface OutlineDrag { sx: number; sy: number; dx: number; dy: number }
export function beginOutlineDrag(p: ToolPointer): OutlineDrag { app.viewport!.selectionOffset = { x: 0, y: 0 }; return { sx: p.x, sy: p.y, dx: 0, dy: 0 }; }
export function moveOutlineDrag(d: OutlineDrag, p: ToolPointer, doc: PixDocument) {
  let dx = p.x - d.sx, dy = p.y - d.sy;
  if (p.shift) { if (Math.abs(dx) > Math.abs(dy)) dy = 0; else dx = 0; }
  d.dx = Math.round(dx); d.dy = Math.round(dy);
  app.viewport!.selectionOffset = { x: d.dx, y: d.dy };
  doc.redrawOverlay();
}
export function endOutlineDrag(d: OutlineDrag, doc: PixDocument) {
  app.viewport!.selectionOffset = { x: 0, y: 0 };
  translateSelection(doc, d.dx, d.dy);
  doc.redrawOverlay();
}

/** Arrow keys nudge the selection outline 1 px (Shift: 10 px). Returns true when handled. */
export function nudgeKey(e: KeyboardEvent, doc: PixDocument | null): boolean {
  const map: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
  const v = map[e.key];
  if (!v || !doc || doc.selection.empty || e.ctrlKey || e.metaKey || e.altKey) return false;
  const k = e.shiftKey ? 10 : 1;
  translateSelection(doc, v[0] * k, v[1] * k, 'Nudge Selection');
  return true;
}

// ------------------------------------------------------------------ context menu
export function selectionContextMenu(p: ToolPointer, doc: PixDocument) {
  const has = !doc.selection.empty;
  const lastFilter = commands.get('filter.last');
  const items: MenuEntry[] = has ? [
    { label: 'Deselect', cmd: 'select.deselect' },
    { label: 'Select Inverse', cmd: 'select.inverse' },
    '-',
    { label: 'Feather...', cmd: 'select.modify', arg: 'feather' },
    { label: 'Select and Mask...', cmd: 'select.selectAndMask' },
    '-',
    { label: 'Save Selection...', cmd: 'select.save' },
    { label: 'Make Work Path...', cmd: 'select.makeWorkPath' },
    '-',
    { label: 'Layer via Copy', cmd: 'layer.viaCopy' },
    { label: 'Layer via Cut', cmd: 'layer.viaCut' },
    { label: 'New Layer...', cmd: 'layer.new' },
    '-',
    { label: 'Free Transform', cmd: 'edit.freeTransform' },
    { label: 'Transform Selection', cmd: 'select.transform' },
    '-',
    { label: 'Fill...', cmd: 'edit.fill' },
    { label: 'Stroke...', cmd: 'edit.stroke' },
    '-',
    { label: lastFilter?.label || 'Last Filter', cmd: 'filter.last' },
    { label: 'Fade...', cmd: 'edit.fade' },
  ] : [
    { label: 'Select All', cmd: 'select.all' },
    { label: 'Reselect', cmd: 'select.reselect' },
    { label: 'Select Subject', cmd: 'select.subject' },
    { label: 'Select Inverse', cmd: 'select.inverse', enabled: false },
    '-',
    { label: 'Color Range...', cmd: 'select.colorRange' },
    { label: 'Load Selection...', cmd: 'select.load' },
    '-',
    { label: 'New Layer...', cmd: 'layer.new' },
    { label: 'Fill...', cmd: 'edit.fill' },
    { label: 'Free Transform', cmd: 'edit.freeTransform' },
    '-',
    { label: lastFilter?.label || 'Last Filter', cmd: 'filter.last' },
    { label: 'Fade...', cmd: 'edit.fade' },
  ];
  const e = p.event;
  openMenu(items, { x: e.clientX, y: e.clientY }, { minWidth: 200 });
}

// ------------------------------------------------------------------ overlay helpers
/** Photoshop-style dark info bubble next to the pointer. */
export function drawHud(ctx: CanvasRenderingContext2D, view: Viewport, lines: string[]) {
  if (!view.pointer.inside || !lines.length) return;
  ctx.save();
  ctx.font = '600 11px Segoe UI, system-ui, sans-serif';
  const w = Math.max(...lines.map(l => ctx.measureText(l).width)) + 16, hh = lines.length * 15 + 8;
  let x = view.pointer.sx + 18, y = view.pointer.sy + 18;
  if (x + w > view.width) x = view.pointer.sx - w - 12;
  if (y + hh > view.height) y = view.pointer.sy - hh - 12;
  ctx.fillStyle = 'rgba(38,38,38,.93)';
  ctx.strokeStyle = 'rgba(255,255,255,.12)';
  ctx.beginPath(); ctx.roundRect(x, y, w, hh, 4); ctx.fill(); ctx.stroke();
  ctx.fillStyle = '#f0f0f0';
  lines.forEach((l, i) => ctx.fillText(l, x + 8, y + 16 + i * 15));
  ctx.restore();
}
/** Solid 1px screen-space polyline (lasso feedback) in doc coordinates. */
export function strokePolyline(ctx: CanvasRenderingContext2D, view: Viewport, pts: { x: number; y: number }[], closeTo?: { x: number; y: number } | null, dashed = false) {
  if (!pts.length) return;
  ctx.save();
  view.applyDocTransform(ctx);
  const px = 1 / view.zoom;
  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
  if (closeTo) ctx.lineTo(closeTo.x, closeTo.y);
  ctx.lineWidth = px * 2.2; ctx.strokeStyle = 'rgba(255,255,255,.9)'; ctx.stroke();
  ctx.lineWidth = px; ctx.strokeStyle = '#000';
  if (dashed) { ctx.setLineDash([4 * px, 4 * px]); ctx.lineDashOffset = -view.antsPhase * px; }
  ctx.stroke();
  ctx.restore();
}
export const px2 = (n: number) => `${Math.round(n)} px`;
