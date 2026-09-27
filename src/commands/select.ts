// Select menu: All / Deselect / Reselect / Inverse, layer selection, Subject / Sky, Modify, Grow / Similar,
// Quick Mask, Load / Save Selection, Make Work Path. Color Range, Focus Area and Select and Mask live in
// src/features/selection/.
import { app } from '../core/app';
import type { PixDocument, AlphaChannel } from '../core/document';
import { registerCommands, runCommand, commands } from '../core/commands';
import { events } from '../core/events';
import { createCanvas, ctx2d, cloneCanvas } from '../core/canvas';
import { Selection, blurAlpha } from '../core/selection';
import { traceAlpha, type VectorPath } from '../core/path';
import type { SelectOp } from '../core/types';
import { h } from '../ui/dom';
import { openDialog, alertDialog } from '../ui/dialog';
import { checkbox, numberField, select, textField, row } from '../ui/widgets';
import { toast } from '../ui/toast';
import { boxBlur, borderMask, contractMask, expandMask, growMask, smoothMask } from '../features/selection/algo';
import { busy, commitMask, detectSky, detectSubject, sampleImage, selectionArray, warnIfFaint } from '../features/selection/ops';
import { openColorRange } from '../features/selection/color-range';
import { openFocusArea } from '../features/selection/focus-area';
import { openSelectAndMask } from '../features/selection/select-and-mask';
import '../tools/selection/selection.css';

const D = () => app.activeDoc;
const hasDoc = () => !!D();
const hasSel = () => !!D() && !D()!.selection.empty && !D()!.quickMask;

function selTxn(doc: PixDocument, name: string, fn: () => void) { doc.history.transaction(name, fn, 'selection'); }

// ------------------------------------------------------------------ small dialog helpers
export function radios<T extends string>(name: string, items: { value: T; label: string; disabled?: boolean }[], value: T, onChange: (v: T) => void): HTMLElement & { value: () => T } {
  let cur = value;
  const el = h('div.sel-radios', { style: { display: 'flex', flexDirection: 'column', gap: '6px' } }) as any;
  for (const it of items) {
    const inp = h('input', { type: 'radio', name, checked: it.value === value, disabled: !!it.disabled }) as HTMLInputElement;
    inp.addEventListener('change', () => { if (inp.checked) { cur = it.value; onChange(it.value); } });
    el.append(h('label.sel-radio', { class: it.disabled ? 'cr-dim' : '' }, inp, h('span', null, it.label)));
  }
  el.value = () => cur;
  return el;
}
export const fieldset = (title: string, ...children: HTMLElement[]) => h('div.sel-fieldset', null, h('div.sel-legend', null, title), ...children);

// ------------------------------------------------------------------ Modify
type ModifyKind = 'border' | 'smooth' | 'expand' | 'contract' | 'feather';
const MODIFY: Record<ModifyKind, { title: string; label: string; min: number; max: number; def: number; decimals?: number; bounds: boolean; history: string }> = {
  border: { title: 'Border Selection', label: 'Width:', min: 1, max: 200, def: 5, bounds: false, history: 'Border' },
  smooth: { title: 'Smooth Selection', label: 'Sample Radius:', min: 1, max: 500, def: 5, bounds: true, history: 'Smooth' },
  expand: { title: 'Expand Selection', label: 'Expand By:', min: 1, max: 500, def: 5, bounds: true, history: 'Expand' },
  contract: { title: 'Contract Selection', label: 'Contract By:', min: 1, max: 500, def: 5, bounds: true, history: 'Contract' },
  feather: { title: 'Feather Selection', label: 'Feather Radius:', min: 0.1, max: 1000, def: 5, decimals: 1, bounds: true, history: 'Feather' },
};
const modifyMemory: Record<string, { v: number; bounds: boolean }> = {};

/** Apply a Modify operation to the current selection (no dialog). */
export function modifySelection(doc: PixDocument, kind: ModifyKind, v: number, atBounds: boolean) {
  const W = doc.width, H = doc.height;
  if (kind === 'feather') {
    let c: HTMLCanvasElement;
    if (atBounds) c = blurAlpha(doc.selection.mask!, v * 2);
    else {
      // edge-normalised gaussian (≈ 3 box passes): the canvas edge does not pull the selection in
      const m = selectionArray(doc);
      let f: Float32Array = new Float32Array(m.length);
      for (let i = 0; i < m.length; i++) f[i] = m[i];
      const r = Math.max(1, Math.round(v * 0.58));
      f = boxBlur(boxBlur(boxBlur(f, W, H, r), W, H, r), W, H, r);
      const out = new Uint8Array(m.length);
      for (let i = 0; i < m.length; i++) out[i] = f[i] + 0.5;
      c = Selection.canvasFromAlpha(out, W, H);
    }
    selTxn(doc, 'Feather', () => doc.selection.setMask(c));
    warnIfFaint(doc);
    return;
  }
  const m = selectionArray(doc);
  const r = Math.round(v);
  const out = kind === 'border' ? borderMask(m, W, H, r, atBounds)
    : kind === 'smooth' ? smoothMask(m, W, H, r, atBounds)
    : kind === 'expand' ? expandMask(m, W, H, r)
    : contractMask(m, W, H, r, atBounds);
  commitMask(doc, MODIFY[kind].history, out, 'replace');
  if (kind === 'border') warnIfFaint(doc);
}

async function modifyDialog(kind: ModifyKind) {
  const doc = D();
  if (!doc || doc.selection.empty) return;
  const def = MODIFY[kind];
  const mem = modifyMemory[kind] || { v: def.def, bounds: false };
  const num = numberField(mem.v, v => { mem.v = v; }, { min: def.min, max: def.max, decimals: def.decimals ?? 0, unit: 'pixels', width: 90 });
  const bounds = checkbox('Apply effect at canvas bounds', mem.bounds, v => { mem.bounds = v; }, { title: 'Treat the canvas edge as unselected' });
  const body = h('div.sel-form', null, row(def.label, num), def.bounds ? bounds : null);
  const ok = await openDialog({ title: def.title, body, layout: 'side', width: 420 }).result;
  if (!ok) return;
  modifyMemory[kind] = mem;
  const v = Math.max(def.min, Math.min(def.max, mem.v));
  await busy(`${def.history}…`, () => modifySelection(doc, kind, v, def.bounds && mem.bounds));
}

// ------------------------------------------------------------------ Grow / Similar
function wandTolerance(): number { return app.getTool('magic-wand')?.settings?.tolerance ?? 32; }
async function growSimilar(contiguous: boolean) {
  const doc = D();
  if (!doc || doc.selection.empty) return;
  await busy(contiguous ? 'Grow…' : 'Similar…', () => {
    const all = !!app.getTool('magic-wand')?.settings?.sampleAll;
    const img = sampleImage(doc, all);
    const out = growMask(img.data, selectionArray(doc), doc.width, doc.height, wandTolerance(), contiguous);
    commitMask(doc, contiguous ? 'Grow' : 'Similar', out);
  });
}

// ------------------------------------------------------------------ Quick Mask
export function toggleQuickMask(doc: PixDocument) {
  if (doc.quickMask) {
    const qm = doc.quickMask;
    const mask = createCanvas(doc.width, doc.height);
    ctx2d(mask).drawImage(qm.canvas, qm.x, qm.y);
    selTxn(doc, 'Quick Mask', () => { doc.quickMask = null; doc.selection.setMask(mask); });
  } else {
    const c = doc.selection.empty ? createCanvas(doc.width, doc.height) : cloneCanvas(doc.selection.mask!);
    selTxn(doc, 'Quick Mask', () => { doc.quickMask = { canvas: c, x: 0, y: 0 }; doc.selection.setMask(null); });
  }
  doc.invalidate();
  events.emit('layers', doc);
}

// ------------------------------------------------------------------ Load / Save Selection
interface ChannelSource { label: string; get(): HTMLCanvasElement | null }
function channelSources(doc: PixDocument): ChannelSource[] {
  const out: ChannelSource[] = [];
  const layer = doc.activeLayer;
  if (layer && layer.getContent(doc) && !layer.isBackground) out.push({ label: `${layer.name} Transparency`, get: () => doc.layerAsDocCanvas(layer) });
  if (layer?.mask) out.push({ label: `${layer.name} Mask`, get: () => {
    const m = layer.mask!, c = createCanvas(doc.width, doc.height), x = ctx2d(c);
    if (m.bg === 255) { x.fillRect(0, 0, c.width, c.height); x.clearRect(m.x, m.y, m.canvas.width, m.canvas.height); }
    x.drawImage(m.canvas, m.x, m.y);
    return c;
  } });
  for (const ch of doc.channels) out.push({ label: ch.name, get: () => ch.canvas });
  return out;
}

function invertCanvas(c: HTMLCanvasElement): HTMLCanvasElement {
  const o = createCanvas(c.width, c.height), x = ctx2d(o);
  x.fillRect(0, 0, o.width, o.height);
  x.globalCompositeOperation = 'destination-out';
  x.drawImage(c, 0, 0);
  return o;
}

async function loadSelectionDialog() {
  const doc = D();
  if (!doc) return;
  const docs = app.docs.filter(d => d.width === doc.width && d.height === doc.height);
  let srcDoc = doc;
  let chIndex = 0, invert = false, op: SelectOp = 'replace';
  const chSel = h('span');
  const buildCh = () => {
    const list = channelSources(srcDoc);
    chIndex = Math.min(chIndex, Math.max(0, list.length - 1));
    chSel.replaceChildren(list.length
      ? select(list.map((s, i) => ({ value: i, label: s.label })), chIndex, v => { chIndex = v; }, { width: 220 })
      : h('span.sel-note', null, 'No channels available'));
  };
  buildCh();
  const docSel = select(docs.map(d => ({ value: d.id, label: d.name })), doc.id, v => { srcDoc = docs.find(d => d.id === v) || doc; buildCh(); }, { width: 220 });
  const has = !doc.selection.empty;
  const ops = radios<SelectOp>('load-op', [
    { value: 'replace', label: 'New Selection' },
    { value: 'add', label: 'Add to Selection', disabled: !has },
    { value: 'subtract', label: 'Subtract from Selection', disabled: !has },
    { value: 'intersect', label: 'Intersect with Selection', disabled: !has },
  ], op, v => { op = v; });
  const body = h('div.sel-form', null,
    fieldset('Source', row('Document:', docSel), row('Channel:', chSel), row('', checkbox('Invert', false, v => { invert = v; }))),
    fieldset('Operation', ops));
  const ok = await openDialog({ title: 'Load Selection', body, layout: 'side', width: 470 }).result;
  if (!ok) return;
  const src = channelSources(srcDoc)[chIndex];
  let c = src?.get();
  if (!c) { toast('There is no channel to load.', 'error'); return; }
  if (invert) c = invertCanvas(c);
  selTxn(doc, 'Load Selection', () => doc.selection.apply(c!, op));
  if (doc.selection.empty && op === 'replace') warnIfFaint(doc);
}

async function saveSelectionDialog() {
  const doc = D();
  if (!doc || doc.selection.empty) return;
  const docs = app.docs.filter(d => d.width === doc.width && d.height === doc.height);
  let dst = doc, chId = 0, name = '';
  type SaveOp = 'new' | 'replace' | 'add' | 'subtract' | 'intersect';
  let op: SaveOp = 'new';
  const opsBox = h('div');
  const chBox = h('span');
  const nameField = textField('', v => { name = v; }, { width: 220, onInput: v => { name = v; } });
  const build = () => {
    chBox.replaceChildren(select([{ value: 0, label: 'New' }, ...dst.channels.map(c => ({ value: c.id, label: c.name }))], chId, v => { chId = v; build(); }, { width: 220 }));
    const isNew = chId === 0;
    op = isNew ? 'new' : (op === 'new' ? 'replace' : op);
    (nameField as unknown as HTMLInputElement).disabled = !isNew;
    opsBox.replaceChildren(radios<SaveOp>('save-op', [
      { value: 'new', label: 'New Channel', disabled: !isNew },
      { value: 'replace', label: 'Replace Channel', disabled: isNew },
      { value: 'add', label: 'Add to Channel', disabled: isNew },
      { value: 'subtract', label: 'Subtract from Channel', disabled: isNew },
      { value: 'intersect', label: 'Intersect with Channel', disabled: isNew },
    ], op, v => { op = v; }));
  };
  build();
  const docSel = select(docs.map(d => ({ value: d.id, label: d.name })), doc.id, v => { dst = docs.find(d => d.id === v) || doc; chId = 0; build(); }, { width: 220 });
  const body = h('div.sel-form', null,
    fieldset('Destination', row('Document:', docSel), row('Channel:', chBox), row('Name:', nameField)),
    fieldset('Operation', opsBox));
  const ok = await openDialog({ title: 'Save Selection', body, layout: 'side', width: 470 }).result;
  if (!ok) return;
  const mask = cloneCanvas(doc.selection.mask!);
  dst.history.transaction('Save Selection', () => {
    if (chId === 0) {
      const id = Math.max(0, ...dst.channels.map(c => c.id)) + 1;
      let n = 1;
      while (dst.channels.some(c => c.name === `Alpha ${n}`)) n++;
      dst.channels = [...dst.channels, { id, name: name.trim() || `Alpha ${n}`, canvas: mask }];
    } else {
      dst.channels = dst.channels.map((c: AlphaChannel) => {
        if (c.id !== chId) return c;
        if (op === 'replace') return { ...c, canvas: mask };
        const o = cloneCanvas(c.canvas), x = ctx2d(o);
        x.globalCompositeOperation = op === 'add' ? 'source-over' : op === 'subtract' ? 'destination-out' : 'destination-in';
        x.drawImage(mask, 0, 0);
        return { ...c, canvas: o };
      });
    }
  }, 'channels');
  dst.layersChanged();
  events.emit('selection', dst);
}

// ------------------------------------------------------------------ Make Work Path
async function makeWorkPath(arg?: { tolerance?: number }) {
  const doc = D();
  if (!doc || doc.selection.empty) return;
  let tol = arg?.tolerance ?? 2;
  if (arg?.tolerance === undefined) {
    const num = numberField(tol, v => { tol = v; }, { min: 0.5, max: 10, decimals: 1, unit: 'pixels', width: 90 });
    const ok = await openDialog({ title: 'Make Work Path', body: h('div.sel-form', null, row('Tolerance:', num)), layout: 'side', width: 380 }).result;
    if (!ok) return;
  }
  const subpaths = traceAlpha(doc.selection.mask!, Math.max(0.5, Math.min(10, tol)));
  if (!subpaths.length) { toast('The selection is too small to make a path.'); return; }
  doc.history.transaction('Make Work Path', () => {
    const id = Math.max(0, ...doc.paths.map((p: VectorPath) => p.id)) + 1;
    doc.paths = [{ id, name: 'Work Path', kind: 'work', subpaths } as VectorPath, ...doc.paths.filter((p: VectorPath) => p.kind !== 'work')];
    doc.selection.deselect();
  }, 'path');
  events.emit('paths', doc);
}

// ------------------------------------------------------------------ Layers panel filter (Find / Isolate Layers)
async function layersPanelFilter(mode: 'Name' | 'Selected') {
  await runCommand('window.showPanel', 'layers');
  await new Promise(r => requestAnimationFrame(() => r(0)));
  const kind = document.querySelector<HTMLElement>('.lp-fbar .lp-kind .select, .lp-fbar .select');
  if (!kind) { toast('Open the Layers panel to filter layers.'); return; }
  kind.click();
  const item = [...document.querySelectorAll<HTMLElement>('.menu .menu-item')].find(e => e.querySelector('.menu-label')?.textContent?.trim() === mode);
  if (!item) { toast('Layer filtering is not available.'); return; }
  item.click();
  await new Promise(r => requestAnimationFrame(() => r(0)));
  if (mode === 'Name') document.querySelector<HTMLInputElement>('.lp-fbar input[type=text], .lp-fbar input.field')?.focus();
}

// ------------------------------------------------------------------ commands
registerCommands([
  { id: 'select.all', label: 'All', run: () => { const d = D(); if (d) selTxn(d, 'Select All', () => d.selection.selectAll()); }, enabled: () => hasDoc() && !D()!.quickMask },
  { id: 'select.deselect', label: 'Deselect', run: () => { const d = D(); if (d && !d.selection.empty) selTxn(d, 'Deselect', () => d.selection.deselect()); }, enabled: hasSel },
  {
    id: 'select.reselect', label: 'Reselect',
    run: () => { const d = D(); if (d?.lastSelection) { const m = d.lastSelection; selTxn(d, 'Reselect', () => d.selection.setMask(m)); } },
    enabled: () => !!D()?.lastSelection && !!D()!.selection.empty && !D()!.quickMask,
  },
  { id: 'select.inverse', label: 'Inverse', run: () => { const d = D(); if (d) selTxn(d, 'Select Inverse', () => d.selection.invert()); }, enabled: hasSel },
  {
    id: 'select.allLayers', label: 'All Layers',
    run: () => {
      const d = D(); if (!d) return;
      const list = d.allLayers().filter(l => !l.isBackground && !l._parent);
      if (!list.length) return;
      d.selectedIds = list.map(l => l.id);
      d.activeLayerId = list[list.length - 1].id;
      events.emit('activeLayer', d); events.emit('layers', d);
    },
    enabled: hasDoc,
  },
  { id: 'select.deselectLayers', label: 'Deselect Layers', run: () => { const d = D(); if (d) { d.setActiveLayer(null); events.emit('layers', d); } }, enabled: () => !!D()?.selectedIds.length },
  { id: 'select.findLayers', label: 'Find Layers', run: () => layersPanelFilter('Name'), enabled: hasDoc },
  { id: 'select.isolateLayers', label: 'Isolate Layers', run: () => layersPanelFilter('Selected'), enabled: () => !!D()?.selectedIds.length },
  { id: 'select.colorRange', label: 'Color Range...', run: () => { const d = D(); if (d) return openColorRange(d); }, enabled: () => hasDoc() && !D()!.quickMask },
  { id: 'select.focusArea', label: 'Focus Area...', run: () => { const d = D(); if (d) return openFocusArea(d); }, enabled: () => hasDoc() && !D()!.quickMask },
  {
    id: 'select.subject', label: 'Subject',
    run: async (arg?: { op?: SelectOp; hard?: boolean; all?: boolean }) => {
      const d = D(); if (!d) return;
      const m = await busy('Selecting subject…', () => detectSubject(d, arg?.all ?? true, { hard: arg?.hard }));
      if (!m) { toast('No subject was found in the image.'); return; }
      commitMask(d, 'Select Subject', m, arg?.op ?? 'replace');
    },
    enabled: () => hasDoc() && !D()!.quickMask,
  },
  {
    id: 'select.sky', label: 'Sky',
    run: async (arg?: { op?: SelectOp }) => {
      const d = D(); if (!d) return;
      const m = await busy('Selecting sky…', () => detectSky(d));
      if (!m) { await alertDialog('Select Sky', 'No sky was detected in this image.'); return; }
      commitMask(d, 'Select Sky', m, arg?.op ?? 'replace');
    },
    enabled: () => hasDoc() && !D()!.quickMask,
  },
  { id: 'select.selectAndMask', label: 'Select and Mask...', run: () => { const d = D(); if (d) return openSelectAndMask(d); }, enabled: () => hasDoc() && !D()!.quickMask },
  { id: 'select.modify', label: 'Modify', run: (arg?: ModifyKind) => modifyDialog(arg && arg in MODIFY ? arg : 'feather'), enabled: hasSel },
  { id: 'select.grow', label: 'Grow', run: () => growSimilar(true), enabled: hasSel },
  { id: 'select.similar', label: 'Similar', run: () => growSimilar(false), enabled: hasSel },
  { id: 'select.quickMask', label: 'Edit in Quick Mask Mode', run: () => { const d = D(); if (d) toggleQuickMask(d); }, enabled: hasDoc, checked: () => !!D()?.quickMask },
  { id: 'select.load', label: 'Load Selection...', run: loadSelectionDialog, enabled: hasDoc },
  { id: 'select.save', label: 'Save Selection...', run: saveSelectionDialog, enabled: hasSel },
  // not in the Select menu, used by the selection tools' context menu
  { id: 'select.makeWorkPath', label: 'Make Work Path...', run: makeWorkPath, enabled: hasSel },
]);

// Photoshop's Delete/Backspace with Quick Mask etc. are handled by the Edit module; expose helpers for tests.
(window as any).__pxSelect = { modifySelection, toggleQuickMask, commands: () => [...commands.keys()].filter(k => k.startsWith('select.')) };
