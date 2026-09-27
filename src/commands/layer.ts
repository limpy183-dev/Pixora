// Layer menu commands (every 'layer.*' id of menus-def.ts except the layer-style and adjustment-layer ones),
// plus layer navigation shortcuts (Alt+[ / Alt+] …).
import { app } from '../core/app';
import type { PixDocument } from '../core/document';
import { PixDocument as PixDocumentClass } from '../core/document';
import { AdjustmentLayer, GroupLayer, Layer, RasterLayer, createMask } from '../core/layer';
import type { LayerMask, Rect } from '../core/types';
import { registerCommands, runCommand, commands } from '../core/commands';
import { alphaBounds, canvasToBlob, cloneCanvas, createCanvas, cropCanvas, ctx2d } from '../core/canvas';
import { renderLayersToCanvas, renderLayerSurface } from '../core/compositor';
import { toCss, toHex } from '../core/color';
import { toPath2D, type SubPath } from '../core/path';
import { events } from '../core/events';
import { h } from '../ui/dom';
import { checkbox, select, textField, numberField } from '../ui/widgets';
import { alertDialog, confirmDialog, openDialog, promptDialog } from '../ui/dialog';
import { toast } from '../ui/toast';
import {
  applyNewLayerOpts, copyCommon, copyName, layersPrefs, layersUI, maskForRect, maskFromSelection, needDoc, newLayerDialog,
  nextNumberedName, panelOrder, rasterOf, replaceLayer, saveLayersPrefs, selectLayers, stackRect, topSelected, unBackground,
  transparencyCanvas, LABEL_COLORS,
} from '../features/layers/shared';
import { FillLayer, FILL_NAMES, defaultFill, editFillDialog, type FillType } from '../layers/fill-layer';
import {
  SmartObjectLayer, canvasFromFile, editContents, exportContents, pickImageFile, replaceMatrix, smartFromLayers, smartToLayers,
} from '../layers/smart-object';

// ------------------------------------------------------------------ small helpers
const D = () => app.activeDoc;
const A = () => app.activeDoc?.activeLayer ?? null;
const isGroup = (l: Layer | null): l is GroupLayer => l instanceof GroupLayer;
const hasSel = () => !!app.activeDoc && !app.activeDoc.selection.empty;
const vis = (l: Layer) => { for (let p: Layer | null = l; p; p = p._parent) if (!p.visible) return false; return true; };

function walk(list: Layer[], fn: (l: Layer) => void) { for (const l of list) { fn(l); if (l instanceof GroupLayer) walk(l.children, fn); } }

/** Trim a rendered canvas placed at (x, y) to its opaque bounds. */
function trimmed(c: HTMLCanvasElement, x: number, y: number): { canvas: HTMLCanvasElement; x: number; y: number } {
  const b = alphaBounds(c, 0);
  if (!b) return { canvas: createCanvas(1, 1), x: 0, y: 0 };
  if (b.x === 0 && b.y === 0 && b.w === c.width && b.h === c.height) return { canvas: c, x, y };
  return { canvas: cropCanvas(c, b), x: x + b.x, y: y + b.y };
}

/** Render a stack of layers (bottom → top) exactly as the compositor does, into a trimmed raster layer. */
function renderStack(doc: PixDocument, layers: Layer[], name: string, full = false): RasterLayer {
  const R = full ? { x: 0, y: 0, w: doc.width, h: doc.height } : stackRect(doc, layers);
  const c = renderLayersToCanvas(doc, layers, R);
  const r = new RasterLayer(1, 1, name);
  if (full) { r.canvas = c; r.x = 0; r.y = 0; }
  else { const t = trimmed(c, R.x, R.y); r.canvas = t.canvas; r.x = t.x; r.y = t.y; }
  r.invalidate();
  return r;
}

/** Temporarily override layer props while rendering. */
function withProps<T>(layers: [Layer, Partial<Layer>][], fn: () => T): T {
  const saved = layers.map(([l, p]) => [l, Object.fromEntries(Object.keys(p).map(k => [k, (l as any)[k]]))] as const);
  for (const [l, p] of layers) Object.assign(l, p);
  try { return fn(); } finally { for (const [l, p] of saved) Object.assign(l, p); }
}

function backgroundIndexGuard(doc: PixDocument, parent: GroupLayer | null, index: number) {
  if (!parent && doc.layers[0]?.isBackground) return Math.max(1, index);
  return index;
}

/** Selected layers that can be moved (not Background, not position-locked). */
function movable(doc: PixDocument) { return topSelected(doc).filter(l => !l.isBackground && !l.positionLocked); }

function lockedMsg(l: Layer, what: string) { toast(`Could not ${what} because the layer "${l.name}" is locked.`, 'error'); }

// ------------------------------------------------------------------ New
async function newLayer(arg?: { noDialog?: boolean; below?: boolean; name?: string }) {
  const doc = needDoc(); if (!doc) return;
  const active = doc.activeLayer;
  let opts = { name: arg?.name || `Layer ${doc.layerCounter + 1}`, clip: false, color: 'none', mode: 'normal' as const, opacity: 100, neutral: false } as any;
  if (!arg?.noDialog) {
    const r = await newLayerDialog('New Layer', { name: opts.name });
    if (!r) return;
    opts = r;
  }
  doc.history.transaction('New Layer', () => {
    doc.layerCounter++;
    const l = new RasterLayer(doc.width, doc.height, opts.name);
    if (arg?.below && active && !active.isBackground) {
      doc.addLayer(l, { parent: active._parent, index: doc.siblingsOf(active).indexOf(active) });
    } else if (arg?.below && active?.isBackground) {
      doc.addLayer(l, { above: active });
    } else {
      if (isGroup(active) && !active.locks.all) { active.expanded = true; doc.addLayer(l, { parent: active, index: active.children.length }); }
      else doc.addLayer(l);
    }
    // inserted inside a clipping group → clip too
    const sib = doc.siblingsOf(l), i = sib.indexOf(l);
    if (sib[i + 1]?.clipped && i > 0) l.clipped = true;
    applyNewLayerOpts(l, opts, doc);
  });
}

async function newGroup(arg?: { noDialog?: boolean; name?: string }) {
  const doc = needDoc(); if (!doc) return;
  let opts: any = { name: arg?.name || nextNumberedName(doc, 'Group'), clip: false, color: 'none', mode: 'pass-through', opacity: 100, neutral: false };
  if (!arg?.noDialog) { const r = await newLayerDialog('New Group', { name: opts.name }, { group: true }); if (!r) return; opts = r; }
  doc.history.transaction('New Group', () => {
    const g = new GroupLayer(opts.name);
    doc.addLayer(g);
    applyNewLayerOpts(g, opts, doc);
  });
}

function groupLayers(doc: PixDocument, name: string, opts?: any): GroupLayer | null {
  const sel = topSelected(doc).filter(l => !l.isBackground);
  if (!sel.length) { toast('Could not group the layers because the Background layer is locked.', 'error'); return null; }
  const top = sel[sel.length - 1];
  const parent = top._parent;
  const g = new GroupLayer(name);
  doc.history.transaction('Group Layers', () => {
    const list = doc.siblingsOf(top);
    list.splice(list.indexOf(top) + 1, 0, g);
    g._parent = parent;
    for (const l of sel) { const from = doc.siblingsOf(l); from.splice(from.indexOf(l), 1); }
    g.children = sel;
    if (sel[0].clipped) sel[0].clipped = false;
    doc.relink();
    if (opts) applyNewLayerOpts(g, opts, doc);
    selectLayers(doc, [g]);
    doc.layersChanged();
  });
  return g;
}

async function groupFromLayers() {
  const doc = needDoc(); if (!doc) return;
  const r = await newLayerDialog('New Group from Layers', { name: nextNumberedName(doc, 'Group') }, { group: true });
  if (!r) return;
  groupLayers(doc, r.name, r);
}

function ungroup() {
  const doc = needDoc(); if (!doc) return;
  const groups = topSelected(doc).filter(isGroup);
  if (!groups.length) return;
  const children: Layer[] = [];
  doc.history.transaction('Ungroup Layers', () => {
    for (const g of groups) {
      const list = doc.siblingsOf(g), i = list.indexOf(g);
      list.splice(i, 1, ...g.children);
      children.push(...g.children);
      g.children = [];
    }
    doc.relink();
    selectLayers(doc, children);
    doc.layersChanged();
  });
}

async function layerFromBackground(arg?: { noDialog?: boolean }) {
  const doc = needDoc(); if (!doc) return;
  const bg = doc.layers.find(l => l.isBackground);
  if (!bg) return;
  let opts: any = { name: 'Layer 0', clip: false, color: 'none', mode: 'normal', opacity: 100, neutral: false };
  if (!arg?.noDialog) { const r = await newLayerDialog('New Layer', { name: 'Layer 0' }, { noClip: true, noNeutral: true }); if (!r) return; opts = r; }
  doc.history.transaction('Layer From Background', () => {
    unBackground(bg, opts.name);
    applyNewLayerOpts(bg, { ...opts, clip: false, neutral: false }, doc);
    doc.layersChanged();
  });
}

function backgroundFromLayer() {
  const doc = needDoc(); if (!doc) return;
  const l = doc.activeLayer;
  if (!l || isGroup(l) || l instanceof AdjustmentLayer) return;
  doc.history.transaction('Background From Layer', () => {
    const c = createCanvas(doc.width, doc.height), x = ctx2d(c);
    x.fillStyle = toCss(app.bg); x.fillRect(0, 0, c.width, c.height);
    const surf = withProps([[l, { blendMode: 'normal', clipped: false, visible: true }]], () => renderLayersToCanvas(doc, [l]));
    x.drawImage(surf, 0, 0);
    const r = new RasterLayer(1, 1, 'Background');
    r.canvas = c; r.isBackground = true; r.colorLabel = l.colorLabel;
    const list = doc.siblingsOf(l); list.splice(list.indexOf(l), 1);
    r.id = l.id;
    doc.layers.unshift(r);
    doc.relink();
    selectLayers(doc, [r]);
    doc.layersChanged();
  });
}

// ------------------------------------------------------------------ via copy / cut
function selectedPixels(doc: PixDocument, l: Layer): { canvas: HTMLCanvasElement; x: number; y: number } | null {
  const c = l.getContent(doc), sel = doc.selection;
  if (!c || !sel.mask || !sel.bounds) return null;
  const b = sel.bounds;
  const out = createCanvas(b.w, b.h), x = ctx2d(out);
  x.drawImage(c.canvas, c.x - b.x, c.y - b.y);
  x.globalCompositeOperation = 'destination-in';
  x.drawImage(sel.mask, -b.x, -b.y);
  const t = trimmed(out, b.x, b.y);
  return alphaBounds(t.canvas, 0) ? t : null;
}

function viaCopy(cut = false) {
  const doc = needDoc(); if (!doc) return;
  const l = doc.activeLayer;
  if (!l) return;
  if (!hasSel()) {
    if (cut) return;
    // duplicate the selected layers
    const sel = topSelected(doc);
    doc.history.transaction('Layer Via Copy', () => {
      const made: Layer[] = [];
      for (const s of sel) {
        const c = s.clone();
        c.name = s.isBackground ? 'Layer 1' : copyName(doc, s.name);
        if (s.isBackground) { unBackground(c, c.name); c.name = doc.nextLayerName(); }
        doc.addLayer(c, { above: s, select: false });
        made.push(c);
      }
      selectLayers(doc, made);
    });
    return;
  }
  if (isGroup(l) || l instanceof AdjustmentLayer) { toast(`Could not complete the Layer via ${cut ? 'Cut' : 'Copy'} command because the selected area is empty.`, 'error'); return; }
  if (cut && !(l instanceof RasterLayer)) { toast('Could not complete the Layer via Cut command because the target layer is not a pixel layer.', 'error'); return; }
  if (cut && l.pixelsLocked) { lockedMsg(l, 'complete the Layer via Cut command'); return; }
  const px = selectedPixels(doc, l);
  if (!px) { toast(`Could not complete the Layer via ${cut ? 'Cut' : 'Copy'} command because the selected area is empty.`, 'error'); return; }
  doc.history.transaction(cut ? 'Layer Via Cut' : 'Layer Via Copy', () => {
    if (cut && l instanceof RasterLayer) {
      const nc = cloneCanvas(l.canvas), x = ctx2d(nc);
      if (l.isBackground) {
        const fill = createCanvas(doc.width, doc.height), fx = ctx2d(fill);
        fx.fillStyle = toCss(app.bg); fx.fillRect(0, 0, fill.width, fill.height);
        fx.globalCompositeOperation = 'destination-in'; fx.drawImage(doc.selection.mask!, 0, 0);
        x.globalCompositeOperation = 'destination-out'; x.drawImage(doc.selection.mask!, -l.x, -l.y);
        x.globalCompositeOperation = 'source-over'; x.drawImage(fill, -l.x, -l.y);
      } else {
        x.globalCompositeOperation = 'destination-out'; x.drawImage(doc.selection.mask!, -l.x, -l.y);
      }
      l.canvas = nc; l.invalidate();
    }
    const r = new RasterLayer(1, 1, doc.nextLayerName());
    r.canvas = px.canvas; r.x = px.x; r.y = px.y;
    if (!l.isBackground) { r.blendMode = l.blendMode === 'pass-through' ? 'normal' : l.blendMode; r.opacity = l.opacity; r.fillOpacity = l.fillOpacity; }
    doc.addLayer(r, { above: isGroup(l) ? l : l });
    doc.pixelsChanged(l, null);
  });
}

// ------------------------------------------------------------------ CSS / SVG
function svgPathData(subpaths: SubPath[]): string {
  const f = (n: number) => +n.toFixed(2);
  return subpaths.map(sp => {
    const p = sp.points;
    if (!p.length) return '';
    let d = `M${f(p[0].x)} ${f(p[0].y)}`;
    const seg = (a: typeof p[0], b: typeof p[0]) => (a.ox === a.x && a.oy === a.y && b.ix === b.x && b.iy === b.y)
      ? ` L${f(b.x)} ${f(b.y)}` : ` C${f(a.ox)} ${f(a.oy)} ${f(b.ix)} ${f(b.iy)} ${f(b.x)} ${f(b.y)}`;
    for (let i = 1; i < p.length; i++) d += seg(p[i - 1], p[i]);
    if (sp.closed && p.length > 1) d += seg(p[p.length - 1], p[0]) + ' Z';
    return d;
  }).join(' ');
}
const cssName = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'layer';
async function toClipboard(text: string, what: string) {
  try { await navigator.clipboard.writeText(text); toast(`${what} copied to the clipboard.`, 'success'); }
  catch {
    const ta = h('textarea.field', { style: { width: '520px', height: '260px', fontFamily: 'monospace', fontSize: '11px' } }) as HTMLTextAreaElement;
    ta.value = text;
    setTimeout(() => ta.select());
    await openDialog({ title: what, body: h('div', null, h('div', { style: { marginBottom: '6px' } }, 'The clipboard is not available — copy the text below:'), ta), buttons: [{ label: 'OK', primary: true }] }).result;
  }
}
function copyCSS() {
  const doc = needDoc(); if (!doc) return;
  const out: string[] = [];
  for (const l of topSelected(doc).slice().reverse()) {
    const b = doc.layerBounds(l);
    const lines = [`.${cssName(l.name)} {`, '  position: absolute;'];
    if (b) lines.push(`  left: ${Math.round(b.x)}px;`, `  top: ${Math.round(b.y)}px;`, `  width: ${Math.round(b.w)}px;`, `  height: ${Math.round(b.h)}px;`);
    if (l.opacity < 1) lines.push(`  opacity: ${+l.opacity.toFixed(2)};`);
    if (l.blendMode !== 'normal' && l.blendMode !== 'pass-through' && !['linear-burn', 'darker-color', 'linear-dodge', 'lighter-color', 'vivid-light', 'linear-light', 'pin-light', 'hard-mix', 'subtract', 'divide', 'dissolve'].includes(l.blendMode)) lines.push(`  mix-blend-mode: ${l.blendMode};`);
    const any = l as any;
    if (l instanceof FillLayer) {
      const f = l.fill;
      if (f.type === 'solid') lines.push(`  background-color: ${toHex(f.color)};`);
      else if (f.type === 'gradient') lines.push(`  background-image: ${f.style === 'radial' ? 'radial-gradient(circle' : `linear-gradient(${90 - f.angle + 90}deg`}, ${f.gradient.stops.map(s => `${toHex(s.color)} ${Math.round(s.pos * 100)}%`).join(', ')});`);
    } else if (l.kind === 'shape' && any.fill) {
      if (any.fill.type === 'solid' && any.fill.color) lines.push(`  background-color: ${toHex(any.fill.color)};`);
      if (any.stroke?.enabled) lines.push(`  border: ${any.stroke.width}px solid ${toHex(any.stroke.color)};`);
      if (any.live?.radius) lines.push(`  border-radius: ${Array.isArray(any.live.radius) ? any.live.radius.map((r: number) => r + 'px').join(' ') : any.live.radius + 'px'};`);
    } else if (l.kind === 'text' && any.runs?.[0]?.style) {
      const s = any.runs[0].style;
      if (s.font) lines.push(`  font-family: "${s.font}";`);
      if (s.size) lines.push(`  font-size: ${s.size}pt;`);
      if (s.color) lines.push(`  color: ${toHex(s.color)};`);
      lines.push(`  /* ${any.runs.map((r: any) => r.text).join('').slice(0, 60).replace(/\*\//g, '')} */`);
    }
    lines.push('}');
    out.push(lines.join('\n'));
  }
  return toClipboard(out.join('\n\n'), 'CSS');
}
async function copySVG() {
  const doc = needDoc(); if (!doc) return;
  const parts: string[] = [];
  for (const l of topSelected(doc)) {
    const any = l as any;
    const op = l.opacity < 1 ? ` opacity="${+l.opacity.toFixed(2)}"` : '';
    if (l.kind === 'shape' && Array.isArray(any.subpaths)) {
      const fill = any.fill?.type === 'solid' && any.fill.color ? toHex(any.fill.color) : 'none';
      const stroke = any.stroke?.enabled ? ` stroke="${toHex(any.stroke.color)}" stroke-width="${any.stroke.width}"` : '';
      parts.push(`  <path id="${cssName(l.name)}" d="${svgPathData(any.subpaths)}" fill="${fill}"${stroke}${op}/>`);
    } else {
      const c = l.getContent(doc);
      if (!c) continue;
      const t = trimmed(c.canvas, c.x, c.y);
      const url = await new Promise<string>(res => { const fr = new FileReader(); canvasToBlob(t.canvas).then(b => { fr.onload = () => res(String(fr.result)); fr.readAsDataURL(b); }); });
      parts.push(`  <image id="${cssName(l.name)}" x="${t.x}" y="${t.y}" width="${t.canvas.width}" height="${t.canvas.height}"${op} href="${url}"/>`);
    }
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${doc.width}" height="${doc.height}" viewBox="0 0 ${doc.width} ${doc.height}">\n${parts.join('\n')}\n</svg>`;
  return toClipboard(svg, 'SVG');
}

// ------------------------------------------------------------------ duplicate / delete
async function duplicate(arg?: { noDialog?: boolean }) {
  const doc = needDoc(); if (!doc) return;
  const sel = topSelected(doc);
  if (!sel.length) return;
  const single = sel.length === 1 ? sel[0] : null;
  let asName = single ? copyName(doc, single.isBackground ? 'Background' : single.name) : '';
  let dest = doc.id as number | 'new';
  let newName = 'Untitled-1';
  if (!arg?.noDialog) {
    const nameF = textField(newName, v => { newName = v; }, { width: 220, onInput: v => { newName = v; } });
    (nameF as unknown as HTMLInputElement).disabled = true;
    const docs = app.docs.map(d => ({ value: d.id as number | 'new', label: d.name }));
    docs.push({ value: 'new', label: 'New' });
    const body = h('div.form.lp-dlg', null,
      h('div.form-row', null, h('label.form-label', null, 'Duplicate:'), h('b', null, single ? single.name : `${sel.length} layers`)),
      single ? h('div.form-row', null, h('label.form-label', null, 'As:'), textField(asName, v => { asName = v; }, { width: 260, onInput: v => { asName = v; } })) : null,
      h('div.lp-dlg-fieldset', null, h('div.lp-dlg-legend', null, 'Destination'),
        h('div.form-row', null, h('label.form-label', null, 'Document:'), select(docs, dest, v => { dest = v; (nameF as unknown as HTMLInputElement).disabled = v !== 'new'; }, { width: 220 })),
        h('div.form-row', null, h('label.form-label', null, 'Name:'), nameF)),
    );
    const ok = await openDialog({ title: single ? 'Duplicate Layer' : 'Duplicate Layers', body, layout: 'side' }).result;
    if (!ok) return;
  }
  const clones = sel.map(l => {
    const c = l.clone();
    if (l.isBackground && dest !== doc.id) { /* stays Background only in a new doc */ }
    return c;
  });
  if (single) clones[0].name = asName.trim() || copyName(doc, single.name);
  else clones.forEach((c, i) => { c.name = copyName(doc, sel[i].name); });
  const histName = single ? 'Duplicate Layer' : 'Duplicate Layers';
  if (dest === 'new') {
    const nd = new PixDocumentClass(doc.width, doc.height, newName.trim() || 'Untitled-1');
    nd.resolution = doc.resolution; nd.resolutionUnit = doc.resolutionUnit; nd.mode = doc.mode;
    nd.layers = clones; nd.relink();
    clones.forEach((c, i) => { if (i > 0 || !sel[0].isBackground) c.isBackground = false; if (c.isBackground) c.name = 'Background'; });
    const top = clones[clones.length - 1];
    nd.activeLayerId = top.id; nd.selectedIds = [top.id];
    nd.history.baseName = 'Duplicate';
    nd.history.snapshots = [{ name: nd.name, state: nd.captureState(true) }];
    app.addDocument(nd);
    return;
  }
  const target = app.docs.find(d => d.id === dest) || doc;
  target.history.transaction(histName, () => {
    const made: Layer[] = [];
    for (let i = 0; i < clones.length; i++) {
      const c = clones[i];
      if (c.isBackground) { unBackground(c, single ? c.name : copyName(target, sel[i].name)); if (single && asName.trim()) c.name = asName.trim(); }
      if (target === doc) doc.addLayer(c, { above: sel[i], select: false });
      else target.addLayer(c, { select: false });
      made.push(c);
    }
    selectLayers(target, made);
  });
  if (target !== doc) { app.setActiveDocument(target); target.layersChanged(); }
}

async function confirmWithDontShow(title: string, message: string): Promise<boolean> {
  if (!layersPrefs.confirmDelete) return true;
  let dont = false;
  const body = h('div', null,
    h('div.msg-box', null, h('div.msg-text', null, message)),
    h('div', { style: { marginTop: '14px' } }, checkbox("Don't show again", false, v => { dont = v; })));
  const r = await openDialog({ title, body, width: 420, buttons: [{ label: 'Yes', primary: true, value: true }, { label: 'No', value: false }], cancelValue: false }).result;
  if (r && dont) { layersPrefs.confirmDelete = false; saveLayersPrefs(); }
  return !!r;
}

async function deleteLayers(arg?: { noConfirm?: boolean; layers?: Layer[] }) {
  const doc = needDoc(); if (!doc) return;
  const sel = arg?.layers || topSelected(doc);
  if (!sel.length) return;
  if (sel.length >= doc.layers.length && sel.every(l => !l._parent) && doc.layers.every(l => sel.includes(l))) { toast('Could not delete: a document must contain at least one layer.', 'error'); return; }
  const locked = sel.find(l => l.locks.all && !l.isBackground);
  if (locked) { lockedMsg(locked, 'delete the layer'); return; }
  if (!arg?.noConfirm) {
    const msg = sel.length === 1 ? `Delete the layer "${sel[0].name}"?` : `Delete the ${sel.length} selected layers?`;
    if (!(await confirmWithDontShow('Delete', msg))) return;
  }
  doc.history.transaction(sel.length === 1 ? 'Delete Layer' : 'Delete Layers', () => {
    const topIdx = panelOrder(doc).indexOf(sel[sel.length - 1]);
    for (const l of sel) doc.removeLayer(l);
    const order = panelOrder(doc);
    const next = order[Math.min(Math.max(0, topIdx), order.length - 1)];
    if (next) selectLayers(doc, [next]);
    doc.layersChanged();
  });
}

async function deleteHidden() {
  const doc = needDoc(); if (!doc) return;
  const hidden: Layer[] = [];
  const w = (list: Layer[]) => { for (const l of list) { if (!l.visible) hidden.push(l); else if (l instanceof GroupLayer) w(l.children); } };
  w(doc.layers);
  if (!hidden.length) return;
  if (hidden.length >= doc.allLayers().length) { toast('Could not delete: every layer is hidden.', 'error'); return; }
  const r = await confirmDialog('Delete', 'Delete the hidden layers?', [{ label: 'Yes', primary: true, value: 'ok' }, { label: 'No', value: 'cancel' }]);
  if (r !== 'ok') return;
  doc.history.transaction('Delete Hidden Layers', () => { for (const l of hidden) doc.removeLayer(l); doc.layersChanged(); });
}

// ------------------------------------------------------------------ export
async function quickExport(layer?: Layer) {
  const doc = needDoc(); if (!doc) return;
  const layers = layer ? [layer] : topSelected(doc);
  for (const l of layers) {
    const R = stackRect(doc, [l]);
    const c = withProps([[l, { visible: true, clipped: false }]], () => renderLayersToCanvas(doc, [l], R));
    const t = trimmed(c, 0, 0);
    const blob = await canvasToBlob(t.canvas);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${l.name.replace(/[\\/:*?"<>|]+/g, '_')}.png`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }
}
function exportAs() {
  const doc = needDoc(); if (!doc) return;
  if (commands.has('file.exportAs')) return runCommand('file.exportAs', { layer: doc.activeLayer, layers: topSelected(doc) });
  return quickExport();
}

// ------------------------------------------------------------------ rename / properties
async function rename(layer?: Layer) {
  const doc = needDoc(); if (!doc) return;
  const l = layer || doc.activeLayer;
  if (!l) return;
  if (layersUI.rename?.(l)) return;
  const v = await promptDialog('Rename Layer', 'Name:', l.name);
  if (v === null || !v.trim() || v === l.name) return;
  doc.history.transaction('Rename Layer', () => { l.name = v.trim(); doc.layersChanged(); });
}

async function layerProperties() {
  const doc = needDoc(); if (!doc) return;
  const l = doc.activeLayer;
  if (!l) return;
  let name = l.name, color = l.colorLabel;
  const body = h('div.form.lp-dlg', null,
    h('div.form-row', null, h('label.form-label', null, 'Layer Name:'), textField(name, v => { name = v; }, { width: 240, onInput: v => { name = v; } })),
    h('div.form-row', null, h('label.form-label', null, 'Color:'), select(LABEL_COLORS.map(([id, label]) => ({ value: id, label })), color, v => { color = v; }, { width: 130 })));
  const ok = await openDialog({ title: 'Layer Properties', body, layout: 'side' }).result;
  if (!ok) return;
  doc.history.transaction('Layer Properties', () => { if (name.trim()) l.name = name.trim(); l.colorLabel = color; doc.layersChanged(); });
}

// ------------------------------------------------------------------ fill layers
async function newFill(arg?: FillType | { type: FillType; noDialog?: boolean }) {
  const doc = needDoc(); if (!doc) return;
  const type: FillType = (typeof arg === 'string' ? arg : arg?.type) || 'solid';
  const noDialog = typeof arg === 'object' && !!arg?.noDialog;
  const t = doc.history.begin('New Fill Layer');
  const l = new FillLayer(defaultFill(type), nextNumberedName(doc, FILL_NAMES[type]));
  if (hasSel()) l.mask = maskFromSelection(doc);
  else if (layersPrefs.defaultMasksOnFill) l.mask = createMask(doc, 255);
  if (hasSel()) doc.selection.deselect();
  doc.addLayer(l);
  doc.editMask = false;
  if (!noDialog && !(await editFillDialog(doc, l))) { t.cancel(); return; }
  t.commit();
  doc.layersChanged();
}

async function contentOptions() {
  const doc = needDoc(); if (!doc) return;
  const l = doc.activeLayer;
  if (l instanceof FillLayer) {
    const t = doc.history.begin('Modify Fill Layer');
    if (await editFillDialog(doc, l)) t.commit(); else t.cancel();
    doc.layersChanged();
  } else if (l instanceof AdjustmentLayer) runCommand('window.showPanel', 'properties');
  else if (l instanceof SmartObjectLayer) editContents(doc, l);
}

// ------------------------------------------------------------------ masks
function canMask(l: Layer | null): l is Layer { return !!l; }

function addMask(doc: PixDocument, l: Layer, mask: LayerMask, name = 'Add Layer Mask') {
  if (l.locks.all) { lockedMsg(l, 'add a layer mask'); return; }
  doc.history.transaction(name, () => {
    if (l.isBackground) unBackground(l);
    l.mask = mask;
    doc.editMask = true;
    doc.layersChanged();
  });
  events.emit('activeLayer', doc);
}

async function maskCmd(arg: string) {
  const doc = needDoc(); if (!doc) return;
  const l = doc.activeLayer;
  if (!canMask(l)) return;
  switch (arg) {
    case 'revealAll': case 'hideAll': {
      if (l.mask) { toast('The layer already has a layer mask.'); return; }
      addMask(doc, l, createMask(doc, arg === 'revealAll' ? 255 : 0));
      break;
    }
    case 'revealSelection': case 'hideSelection': {
      if (l.mask) { toast('The layer already has a layer mask.'); return; }
      if (!hasSel()) { addMask(doc, l, createMask(doc, arg === 'revealSelection' ? 255 : 0)); return; }
      const m = maskFromSelection(doc, arg === 'hideSelection');
      doc.history.transaction('Add Layer Mask', () => {
        if (l.isBackground) unBackground(l);
        l.mask = m; doc.editMask = true;
        doc.selection.deselect();
        doc.layersChanged();
      });
      events.emit('activeLayer', doc);
      break;
    }
    case 'fromTransparency': {
      if (!(l instanceof RasterLayer) || l.mask) return;
      doc.history.transaction('Add Layer Mask', () => {
        if (l.isBackground) unBackground(l);
        const w = l.canvas.width, hh = l.canvas.height;
        const img = ctx2d(l.canvas).getImageData(0, 0, w, hh), d = img.data;
        const mc = createCanvas(w, hh), mimg = new ImageData(w, hh), md = mimg.data;
        for (let i = 0; i < d.length; i += 4) { md[i + 3] = d[i + 3]; if (d[i + 3] > 0) d[i + 3] = 255; }
        ctx2d(mc).putImageData(mimg, 0, 0);
        const nc = createCanvas(w, hh); ctx2d(nc).putImageData(img, 0, 0);
        l.canvas = nc; l.invalidate();
        l.mask = { canvas: mc, x: l.x, y: l.y, bg: 0, enabled: true, linked: true, density: 1, feather: 0 };
        doc.editMask = true;
        doc.pixelsChanged(l, null); doc.layersChanged();
      });
      break;
    }
    case 'delete': case 'deleteNoAsk': {
      if (!l.mask) return;
      if (arg === 'delete' && l instanceof RasterLayer && !l.pixelsLocked) {
        const r = await confirmDialog('Delete Layer Mask', 'Apply mask to layer before removing?', [{ label: 'Apply', primary: true, value: 'apply' }, { label: 'Cancel', value: 'cancel' }, { label: 'Delete', value: 'delete' }]);
        if (r === 'cancel') return;
        if (r === 'apply') return maskCmd('apply');
      }
      doc.history.transaction('Delete Layer Mask', () => { l.mask = null; doc.editMask = false; if (doc.viewMaskLayerId === l.id) doc.viewMaskLayerId = 0; doc.layersChanged(); });
      events.emit('activeLayer', doc);
      break;
    }
    case 'apply': {
      if (!l.mask) return;
      let target: Layer = l;
      if (!(l instanceof RasterLayer)) {
        if (isGroup(l) || l instanceof AdjustmentLayer || l instanceof FillLayer) { toast('Could not apply the layer mask to this kind of layer — use Rasterize or Merge first.', 'error'); return; }
      }
      if (l.pixelsLocked) { lockedMsg(l, 'apply the layer mask'); return; }
      doc.history.transaction('Apply Layer Mask', () => {
        if (!(l instanceof RasterLayer)) { target = rasterOf(doc, l); replaceLayer(doc, l, target); }
        const r = target as RasterLayer, m = l.mask!;
        const nc = cloneCanvas(r.canvas), x = ctx2d(nc);
        if (m.enabled) {
          x.globalCompositeOperation = 'destination-in';
          x.drawImage(maskForRect(m, { x: r.x, y: r.y, w: r.canvas.width, h: r.canvas.height }), 0, 0);
        }
        r.canvas = nc; r.mask = null; r.invalidate();
        doc.editMask = false;
        if (doc.viewMaskLayerId === l.id) doc.viewMaskLayerId = 0;
        doc.pixelsChanged(r, null); doc.layersChanged();
      });
      events.emit('activeLayer', doc);
      break;
    }
    case 'toggle': case 'enable': case 'disable': {
      if (!l.mask) return;
      const on = arg === 'toggle' ? !l.mask.enabled : arg === 'enable';
      doc.history.transaction(on ? 'Enable Layer Mask' : 'Disable Layer Mask', () => { l.mask = { ...l.mask!, enabled: on }; doc.layersChanged(); });
      break;
    }
    case 'unlink': case 'link': case 'toggleLink': {
      if (!l.mask) return;
      const on = arg === 'toggleLink' ? !l.mask.linked : arg === 'link';
      doc.history.transaction(on ? 'Link Layer Mask' : 'Unlink Layer Mask', () => { l.mask = { ...l.mask!, linked: on }; doc.layersChanged(); });
      break;
    }
  }
}

function currentPathSubpaths(doc: PixDocument): SubPath[] | null {
  const a = doc.activeLayer as any;
  const paths = doc.paths as any[];
  const p = paths.find(x => x?.kind === 'work') || paths[paths.length - 1];
  if (p?.subpaths?.length) return p.subpaths;
  if (a?.kind === 'shape' && a.subpaths?.length) return a.subpaths;
  return null;
}

/** Vector masks are stored as (anti-aliased) pixel layer masks flagged `vector` — Pixora has no separate vector mask slot. */
function vectorMask(arg: string) {
  const doc = needDoc(); if (!doc) return;
  const l = doc.activeLayer;
  if (!l) return;
  if (arg === 'delete') {
    if (!(l.mask as any)?.vector) return;
    doc.history.transaction('Delete Vector Mask', () => { l.mask = null; doc.editMask = false; doc.layersChanged(); });
    return;
  }
  if (l.mask) { toast('The layer already has a mask. Delete it first to add a vector mask.'); return; }
  let m: LayerMask;
  if (arg === 'currentPath') {
    const sp = currentPathSubpaths(doc);
    if (!sp) { toast('There is no path to use as a vector mask. Draw a path with the Pen tool first.', 'error'); return; }
    const c = createCanvas(doc.width, doc.height), x = ctx2d(c);
    x.fillStyle = '#000'; x.fill(toPath2D(sp), 'evenodd');
    m = { canvas: c, x: 0, y: 0, bg: 0, enabled: true, linked: true, density: 1, feather: 0 };
  } else m = createMask(doc, arg === 'revealAll' ? 255 : 0);
  (m as any).vector = true;
  addMask(doc, l, m, 'Add Vector Mask');
  doc.editMask = false;
}

function clippingMask() {
  const doc = needDoc(); if (!doc) return;
  const a = doc.activeLayer;
  if (!a) return;
  const sel = topSelected(doc).filter(l => !l.isBackground);
  if (a.clipped && sel.length <= 1) {
    doc.history.transaction('Release Clipping Mask', () => {
      const sib = doc.siblingsOf(a);
      for (let i = sib.indexOf(a); i < sib.length && sib[i].clipped; i++) sib[i].clipped = false;
      doc.layersChanged();
    });
    return;
  }
  const cand = sel.filter(l => doc.siblingsOf(l).indexOf(l) > 0);
  if (!cand.length) return;
  const release = cand.every(l => l.clipped);
  doc.history.transaction(release ? 'Release Clipping Mask' : 'Create Clipping Mask', () => {
    for (const l of cand) l.clipped = !release;
    // with several layers selected, the bottom one becomes the base
    if (!release && sel.length > 1) { const bottom = sel[0]; if (cand.includes(bottom) && sel.every(l => l._parent === bottom._parent)) bottom.clipped = false; }
    doc.layersChanged();
  });
}

// ------------------------------------------------------------------ smart objects
function toSmart() {
  const doc = needDoc(); if (!doc) return;
  const sel = topSelected(doc);
  if (!sel.length) return;
  doc.history.transaction('Convert to Smart Object', () => {
    const so = smartFromLayers(doc, sel);
    const top = sel[sel.length - 1];
    if (top.isBackground) so.name = 'Layer 0';
    const list = doc.siblingsOf(top);
    list.splice(list.indexOf(top) + 1, 0, so);
    doc.relink();
    for (const l of sel) { const from = doc.siblingsOf(l); from.splice(from.indexOf(l), 1); }
    doc.relink();
    selectLayers(doc, [so]);
    doc.layersChanged();
  });
}
function smartViaCopy() {
  const doc = needDoc(); if (!doc) return;
  const so = doc.activeLayer;
  if (!(so instanceof SmartObjectLayer)) return;
  doc.history.transaction('New Smart Object via Copy', () => {
    const c = so.clone() as SmartObjectLayer;
    c.contentId = `so-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    c.name = copyName(doc, so.name);
    doc.addLayer(c, { above: so });
  });
}
async function smartReplace() {
  const doc = needDoc(); if (!doc) return;
  const so = doc.activeLayer;
  if (!(so instanceof SmartObjectLayer)) return;
  const f = await pickImageFile();
  if (!f) return;
  const src = await canvasFromFile(f);
  doc.history.transaction('Replace Contents', () => {
    for (const l of doc.allLayers()) if (l instanceof SmartObjectLayer && l.contentId === so.contentId) {
      l.matrix = replaceMatrix(l, src.width, src.height);
      l.source = src; l.contents = null; l.invalidate();
    }
    doc.pixelsChanged(null, null); doc.layersChanged();
  });
}
function smartToLayersCmd() {
  const doc = needDoc(); if (!doc) return;
  const so = doc.activeLayer;
  if (!(so instanceof SmartObjectLayer)) return;
  doc.history.transaction('Convert to Layers', () => {
    const layers = smartToLayers(so);
    let neu: Layer;
    if (layers.length === 1) { neu = layers[0]; neu.name = layers[0].name || so.name; }
    else { const g = new GroupLayer(so.name); g.children = layers; neu = g; }
    copyCommon(so, neu, ['name', 'isBackground', 'effects']);
    if (neu instanceof GroupLayer && neu.blendMode === 'normal') neu.blendMode = 'pass-through';
    const list = doc.siblingsOf(so);
    list.splice(list.indexOf(so), 1, neu);
    doc.relink();
    selectLayers(doc, [neu]);
    doc.pixelsChanged(null, null); doc.layersChanged();
  });
}

// ------------------------------------------------------------------ rasterize
const RASTER_KIND: Record<string, (l: Layer) => boolean> = {
  type: l => l.kind === 'text', shape: l => l.kind === 'shape', fill: l => l.kind === 'fill', smart: l => l.kind === 'smart',
  layer: l => !isGroup(l) && !(l instanceof AdjustmentLayer) && !(l instanceof RasterLayer),
  vectorMask: l => !!(l.mask as any)?.vector,
  style: l => l.effects.length > 0 && !(l instanceof AdjustmentLayer),
};
const RASTER_NAMES: Record<string, string> = { type: 'Rasterize Type', shape: 'Rasterize Shape', fill: 'Rasterize Fill Content', smart: 'Rasterize Smart Object', layer: 'Rasterize Layer', all: 'Rasterize All Layers', vectorMask: 'Rasterize Vector Mask', style: 'Rasterize Layer Style' };
function rasterTargets(doc: PixDocument, arg: string): Layer[] {
  if (arg === 'all') return doc.allLayers().filter(RASTER_KIND.layer);
  const test = RASTER_KIND[arg] || RASTER_KIND.layer;
  return topSelected(doc).filter(test);
}
function rasterize(arg = 'layer') {
  const doc = needDoc(); if (!doc) return;
  const targets = rasterTargets(doc, arg);
  if (!targets.length) return;
  doc.history.transaction(RASTER_NAMES[arg] || 'Rasterize Layer', () => {
    for (const l of targets) {
      if (arg === 'vectorMask') { l.mask = { ...l.mask! }; delete (l.mask as any).vector; continue; }
      if (arg === 'style') {
        // bake effects (and fill opacity) into pixels; mask, opacity and blend mode stay live
        const R = stackRect(doc, [l]);
        const surf = withProps([[l, { mask: null, visible: true }]], () => renderLayerSurface(doc, l, R));
        const r = new RasterLayer(1, 1, l.name);
        copyCommon(l, r);
        const t = surf ? trimmed(surf, R.x, R.y) : { canvas: createCanvas(1, 1), x: 0, y: 0 };
        r.canvas = t.canvas; r.x = t.x; r.y = t.y;
        r.effects = []; r.fillOpacity = 1;
        replaceLayer(doc, l, r);
        continue;
      }
      replaceLayer(doc, l, rasterOf(doc, l));
    }
    doc.pixelsChanged(null, null); doc.layersChanged();
  });
  events.emit('activeLayer', doc);
}

// ------------------------------------------------------------------ visibility / arrange
function hideLayers() {
  const doc = needDoc(); if (!doc) return;
  const sel = topSelected(doc);
  if (!sel.length) return;
  const show = sel.every(l => !l.visible);
  doc.history.transaction(show ? 'Show Layer' : 'Hide Layer', () => { for (const l of sel) l.visible = show; doc.layersChanged(); });
}

function arrange(arg: string) {
  const doc = needDoc(); if (!doc) return;
  const sel = movable(doc).filter(l => !l.isBackground);
  if (!sel.length) return;
  doc.history.transaction('Layer Order', () => {
    const byParent = new Map<GroupLayer | null, Layer[]>();
    for (const l of sel) { const k = l._parent; if (!byParent.has(k)) byParent.set(k, []); byParent.get(k)!.push(l); }
    for (const [parent, ls] of byParent) {
      const list = parent ? parent.children : doc.layers;
      const minIdx = !parent && list[0]?.isBackground ? 1 : 0;
      const set = new Set(ls);
      if (arg === 'front' || arg === 'back') {
        const rest = list.filter(l => !set.has(l)), moved = list.filter(l => set.has(l));
        list.length = 0;
        if (arg === 'front') list.push(...rest, ...moved);
        else list.push(...rest.slice(0, minIdx), ...moved, ...rest.slice(minIdx));
      } else if (arg === 'forward') {
        for (let i = list.length - 2; i >= 0; i--) if (set.has(list[i]) && !set.has(list[i + 1])) [list[i], list[i + 1]] = [list[i + 1], list[i]];
      } else if (arg === 'backward') {
        for (let i = minIdx + 1; i < list.length; i++) if (set.has(list[i]) && !set.has(list[i - 1])) [list[i], list[i - 1]] = [list[i - 1], list[i]];
      } else if (arg === 'reverse') {
        const idx = list.map((l, i) => (set.has(l) ? i : -1)).filter(i => i >= 0);
        const moved = idx.map(i => list[i]).reverse();
        idx.forEach((i, k) => { list[i] = moved[k]; });
      }
      // the new bottom layer of a list can't be clipped
      if (list[0]?.clipped) list[0].clipped = false;
    }
    doc.relink();
    doc.layersChanged();
  });
}

// ------------------------------------------------------------------ align / distribute
function alignInfo(doc: PixDocument) {
  const targets = movable(doc).map(l => ({ l, b: doc.layerBounds(l) })).filter(t => t.b) as { l: Layer; b: Rect }[];
  let ref: Rect | null = null;
  if (!doc.selection.empty) ref = doc.selection.bounds;
  else if (targets.length >= 2) {
    const x0 = Math.min(...targets.map(t => t.b.x)), y0 = Math.min(...targets.map(t => t.b.y));
    ref = { x: x0, y: y0, w: Math.max(...targets.map(t => t.b.x + t.b.w)) - x0, h: Math.max(...targets.map(t => t.b.y + t.b.h)) - y0 };
  } else ref = { x: 0, y: 0, w: doc.width, h: doc.height };
  return { targets, ref: ref! };
}
function align(arg: string) {
  const doc = needDoc(); if (!doc) return;
  const { targets, ref } = alignInfo(doc);
  if (!targets.length) return;
  doc.history.transaction('Align', () => {
    for (const { l, b } of targets) {
      let dx = 0, dy = 0;
      if (arg === 'left') dx = ref.x - b.x;
      else if (arg === 'right') dx = ref.x + ref.w - (b.x + b.w);
      else if (arg === 'hcenter') dx = ref.x + ref.w / 2 - (b.x + b.w / 2);
      else if (arg === 'top') dy = ref.y - b.y;
      else if (arg === 'bottom') dy = ref.y + ref.h - (b.y + b.h);
      else if (arg === 'vcenter') dy = ref.y + ref.h / 2 - (b.y + b.h / 2);
      dx = Math.round(dx); dy = Math.round(dy);
      if (dx || dy) l.translate(dx, dy);
    }
    doc.pixelsChanged(null, null); doc.layersChanged();
  });
}
function distribute(arg: string) {
  const doc = needDoc(); if (!doc) return;
  const { targets } = alignInfo(doc);
  if (targets.length < 3) return;
  const horiz = ['left', 'hcenter', 'right', 'hspace'].includes(arg);
  const key = (b: Rect) => arg === 'left' ? b.x : arg === 'right' ? b.x + b.w : arg === 'hcenter' ? b.x + b.w / 2
    : arg === 'top' ? b.y : arg === 'bottom' ? b.y + b.h : arg === 'vcenter' ? b.y + b.h / 2 : horiz ? b.x : b.y;
  const list = targets.slice().sort((a, b) => key(a.b) - key(b.b));
  doc.history.transaction('Distribute', () => {
    const n = list.length;
    if (arg === 'hspace' || arg === 'vspace') {
      const size = (b: Rect) => (horiz ? b.w : b.h), start = (b: Rect) => (horiz ? b.x : b.y);
      const first = list[0].b, last = list[n - 1].b;
      const span = start(last) + size(last) - start(first);
      const total = list.reduce((s, t) => s + size(t.b), 0);
      const gap = (span - total) / (n - 1);
      let pos = start(first) + size(first) + gap;
      for (let i = 1; i < n - 1; i++) {
        const d = Math.round(pos - start(list[i].b));
        if (d) list[i].l.translate(horiz ? d : 0, horiz ? 0 : d);
        pos += size(list[i].b) + gap;
      }
    } else {
      const k0 = key(list[0].b), k1 = key(list[n - 1].b);
      for (let i = 1; i < n - 1; i++) {
        const d = Math.round(k0 + ((k1 - k0) * i) / (n - 1) - key(list[i].b));
        if (d) list[i].l.translate(horiz ? d : 0, horiz ? 0 : d);
      }
    }
    doc.pixelsChanged(null, null); doc.layersChanged();
  });
}

// ------------------------------------------------------------------ locks / links
async function lockDialog() {
  const doc = needDoc(); if (!doc) return;
  const sel = topSelected(doc).filter(l => !l.isBackground);
  if (!sel.length) return;
  const cur = { ...sel[0].locks };
  const boxes: Record<string, ReturnType<typeof checkbox>> = {};
  const mk = (k: keyof typeof cur, label: string) => (boxes[k] = checkbox(label, cur[k], v => { cur[k] = v; if (k === 'all') sync(); }));
  const sync = () => { for (const k of ['transparency', 'pixels', 'position', 'artboard'] as const) { boxes[k].classList.toggle('disabled', cur.all); (boxes[k].querySelector('input') as HTMLInputElement).disabled = cur.all; } };
  const anyGroup = sel.some(isGroup);
  const body = h('div.form.lp-dlg', null,
    h('div.lp-dlg-legend', null, 'Lock:'),
    h('div.lp-lock-grid', null, mk('transparency', 'Transparency'), mk('pixels', 'Image'), mk('position', 'Position'), mk('artboard', 'Prevent Auto-Nesting'), mk('all', 'All')));
  sync();
  const ok = await openDialog({ title: anyGroup ? 'Lock All Layers in Group' : 'Lock Layers', body, layout: 'side' }).result;
  if (!ok) return;
  doc.history.transaction('Lock Layers', () => {
    const apply = (l: Layer) => { l.locks = { ...cur }; };
    for (const l of sel) { apply(l); if (anyGroup && l instanceof GroupLayer) walk(l.children, apply); }
    doc.layersChanged();
  });
}

let linkCounter = Date.now() % 100000;
function linkLayers() {
  const doc = needDoc(); if (!doc) return;
  const sel = doc.selectedLayers;
  if (!sel.length) return;
  const id = sel[0].linkId;
  const unlink = id !== 0 && sel.every(l => l.linkId === id);
  doc.history.transaction(unlink ? 'Unlink Layers' : 'Link Layers', () => {
    const nid = ++linkCounter;
    for (const l of sel) l.linkId = unlink ? 0 : nid;
    // a link group of one layer is not a link
    const counts = new Map<number, number>();
    for (const l of doc.allLayers()) if (l.linkId) counts.set(l.linkId, (counts.get(l.linkId) || 0) + 1);
    for (const l of doc.allLayers()) if (l.linkId && counts.get(l.linkId) === 1) l.linkId = 0;
    doc.layersChanged();
  });
}
function selectLinked() {
  const doc = needDoc(); if (!doc) return;
  const a = doc.activeLayer;
  if (!a?.linkId) return;
  selectLayers(doc, doc.allLayers().filter(l => l.linkId === a.linkId), a);
}

// ------------------------------------------------------------------ merge / flatten
function lowerOf(doc: PixDocument, l: Layer): Layer | null { const s = doc.siblingsOf(l); return s[s.indexOf(l) - 1] || null; }

function mergeDown() {
  const doc = needDoc(); if (!doc) return;
  const sel = topSelected(doc);
  if (sel.length > 1) return mergeLayers(doc, sel);
  const up = sel[0];
  if (!up) return;
  if (isGroup(up)) return mergeLayers(doc, [up], 'Merge Group');
  const low = lowerOf(doc, up);
  if (!low || isGroup(low) || low instanceof AdjustmentLayer) return;
  if (low.pixelsLocked) { lockedMsg(low, 'merge down'); return; }
  doc.history.transaction('Merge Down', () => {
    const r = withProps([[low, { opacity: 1, blendMode: 'normal', clipped: false, visible: true }]],
      () => (low.isBackground ? renderStack(doc, [low, up], low.name, true) : renderStack(doc, [low, up], low.name)));
    r.opacity = low.opacity; r.blendMode = low.blendMode === 'pass-through' ? 'normal' : low.blendMode;
    r.clipped = low.clipped; r.visible = low.visible; r.colorLabel = low.colorLabel; r.isBackground = low.isBackground;
    if (low.isBackground) r.locks = { ...low.locks };
    replaceLayer(doc, low, r);
    doc.removeLayer(up);
    selectLayers(doc, [r]);
    doc.pixelsChanged(null, null); doc.layersChanged();
  });
}

function mergeLayers(doc: PixDocument, sel: Layer[], name = 'Merge Layers') {
  const top = sel[sel.length - 1];
  const bg = sel.find(l => l.isBackground);
  doc.history.transaction(name, () => {
    const over: [Layer, Partial<Layer>][] = [[sel[0], { clipped: false }]];
    if (sel.length === 1) over.push([sel[0], { clipped: false, opacity: 1, blendMode: 'normal' }]);
    const r = withProps(over, () => renderStack(doc, sel, bg ? 'Background' : top.name, !!bg));
    if (sel.length === 1) { r.opacity = top.opacity; r.blendMode = top.blendMode === 'pass-through' ? 'normal' : top.blendMode; r.clipped = top.clipped; r.visible = top.visible; }
    if (bg) {
      r.isBackground = true;
      for (const l of sel) doc.removeLayer(l);
      doc.layers.unshift(r); doc.relink();
    } else {
      const list = doc.siblingsOf(top);
      list.splice(list.indexOf(top) + 1, 0, r); r._parent = top._parent;
      doc.relink();
      for (const l of sel) doc.removeLayer(l);
    }
    selectLayers(doc, [r]);
    doc.pixelsChanged(null, null); doc.layersChanged();
  });
}

function mergeVisible(arg?: string) {
  const doc = needDoc(); if (!doc) return;
  if (arg === 'stamp') {
    doc.history.transaction('Stamp Visible', () => {
      const c = cloneCanvas(doc.getComposite());
      const r = new RasterLayer(1, 1, doc.nextLayerName());
      const t = trimmed(c, 0, 0); r.canvas = t.canvas; r.x = t.x; r.y = t.y;
      doc.addLayer(r);
    });
    return;
  }
  const visibleTop = doc.layers.filter(l => l.visible);
  if (visibleTop.length < 2 && !(visibleTop.length === 1 && isGroup(visibleTop[0]))) return;
  const bg = visibleTop.find(l => l.isBackground);
  const a = doc.activeLayer;
  const nameSrc = a && visibleTop.includes(a) ? a : visibleTop[visibleTop.length - 1];
  doc.history.transaction('Merge Visible', () => {
    const r = withProps([[visibleTop[0], { clipped: false }]], () => renderStack(doc, visibleTop, bg ? 'Background' : nameSrc.name, !!bg));
    if (bg) r.isBackground = true;
    const idx = doc.layers.indexOf(visibleTop[0]);
    doc.layers.splice(idx, 0, r);
    doc.relink();
    for (const l of visibleTop) { const i = doc.layers.indexOf(l); if (i >= 0) doc.layers.splice(i, 1); }
    doc.relink();
    selectLayers(doc, [r]);
    doc.pixelsChanged(null, null); doc.layersChanged();
  });
}

async function flatten() {
  const doc = needDoc(); if (!doc) return;
  const hidden = doc.allLayers().some(l => !vis(l));
  if (hidden) {
    const r = await confirmDialog('Flatten Image', 'Discard hidden layers?', [{ label: 'OK', primary: true, value: 'ok' }, { label: 'Cancel', value: 'cancel' }]);
    if (r !== 'ok') return;
  }
  doc.history.transaction('Flatten Image', () => {
    const c = createCanvas(doc.width, doc.height), x = ctx2d(c);
    x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height);
    x.drawImage(renderLayersToCanvas(doc, doc.layers), 0, 0);
    const r = new RasterLayer(1, 1, 'Background');
    r.canvas = c; r.isBackground = true;
    doc.layers = [r]; doc.relink();
    doc.editMask = false; doc.viewMaskLayerId = 0;
    selectLayers(doc, [r]);
    doc.pixelsChanged(null, null); doc.layersChanged();
  });
}

// ------------------------------------------------------------------ matting
function propagateColors(d: Uint8ClampedArray, w: number, hh: number, known: Uint8Array, target: Uint8Array, iterations: number) {
  const nb = [-1, 1, -w, w, -w - 1, -w + 1, w - 1, w + 1];
  for (let it = 0; it < iterations; it++) {
    const add: number[] = [];
    for (let y = 0; y < hh; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (known[i] || !target[i]) continue;
      let r = 0, g = 0, b = 0, n = 0;
      for (const o of nb) {
        const j = i + o, jx = j % w;
        if (j < 0 || j >= w * hh || Math.abs(jx - x) > 1 || !known[j]) continue;
        r += d[j * 4]; g += d[j * 4 + 1]; b += d[j * 4 + 2]; n++;
      }
      if (n) { d[i * 4] = r / n; d[i * 4 + 1] = g / n; d[i * 4 + 2] = b / n; add.push(i); }
    }
    if (!add.length) break;
    for (const i of add) known[i] = 1;
  }
}
async function matting(arg: string) {
  const doc = needDoc(); if (!doc) return;
  const l = doc.activeLayer;
  if (!(l instanceof RasterLayer) || l.isBackground) return;
  if (l.pixelsLocked) { lockedMsg(l, 'use Matting'); return; }
  let width = 1;
  if (arg === 'defringe') {
    const body = h('div.form', null, h('div.form-row', null, h('label.form-label', null, 'Width:'), numberField(1, v => { width = v; }, { min: 1, max: 200, unit: 'pixels', width: 80 })));
    const ok = await openDialog({ title: 'Defringe', body, layout: 'side' }).result;
    if (!ok) return;
  }
  const w = l.canvas.width, hh = l.canvas.height;
  const img = ctx2d(l.canvas).getImageData(0, 0, w, hh), d = img.data;
  if (arg === 'black' || arg === 'white') {
    const m = arg === 'white' ? 255 : 0;
    for (let i = 0; i < d.length; i += 4) {
      const a = d[i + 3] / 255;
      if (a <= 0 || a >= 1) continue;
      for (let k = 0; k < 3; k++) d[i + k] = (d[i + k] - m * (1 - a)) / a;
    }
  } else {
    const n = w * hh, known = new Uint8Array(n), target = new Uint8Array(n);
    let eff: Uint8ClampedArray | null = null;
    if (arg === 'decontaminate' && l.mask) eff = ctx2d(maskForRect(l.mask, { x: l.x, y: l.y, w, h: hh })).getImageData(0, 0, w, hh).data;
    for (let i = 0; i < n; i++) {
      const a = eff ? (d[i * 4 + 3] * eff[i * 4 + 3]) / 255 : d[i * 4 + 3];
      if (a >= 254) known[i] = 1; else if (a > 0 || (eff && d[i * 4 + 3] > 0)) target[i] = 1;
    }
    propagateColors(d, w, hh, known, target, arg === 'decontaminate' ? 12 : width);
  }
  const nc = createCanvas(w, hh); ctx2d(nc).putImageData(img, 0, 0);
  const names: Record<string, string> = { black: 'Remove Black Matte', white: 'Remove White Matte', defringe: 'Defringe', decontaminate: 'Color Decontaminate' };
  doc.history.transaction(names[arg] || 'Matting', () => { l.canvas = nc; l.invalidate(); doc.pixelsChanged(l, null); });
}

// ------------------------------------------------------------------ navigation
function selectRel(dir: 1 | -1 | 'top' | 'bottom', add = false) {
  const doc = needDoc(); if (!doc) return;
  const order = panelOrder(doc);
  if (!order.length) return;
  const a = doc.activeLayer;
  let target: Layer;
  if (dir === 'top') target = order[0];
  else if (dir === 'bottom') target = order[order.length - 1];
  else {
    const i = a ? order.indexOf(a) : -1;
    const j = i < 0 ? 0 : i - dir; // dir 1 = up in the panel
    if (j < 0 || j >= order.length) return;
    target = order[j];
  }
  if (add) {
    const ids = new Set(doc.selectedIds);
    if (dir === 'top' || dir === 'bottom') {
      const i = a ? order.indexOf(a) : 0, j = order.indexOf(target);
      for (let k = Math.min(i, j); k <= Math.max(i, j); k++) ids.add(order[k].id);
    } else ids.add(target.id);
    selectLayers(doc, doc.allLayers().filter(l => ids.has(l.id)), target);
  } else doc.setActiveLayer(target);
}

// ------------------------------------------------------------------ enabled() predicates
const hasActive = () => !!A();
const hasSelNonBg = () => !!D() && topSelected(D()!).some(l => !l.isBackground);
const mergeDownEnabled = () => {
  const doc = D(); if (!doc) return false;
  const sel = topSelected(doc);
  if (sel.length > 1) return true;
  const up = sel[0];
  if (!up) return false;
  if (isGroup(up)) return up.children.length > 0;
  const low = lowerOf(doc, up);
  return !!low && !isGroup(low) && !(low instanceof AdjustmentLayer) && low.visible && up.visible;
};

registerCommands([
  { id: 'layer.new', label: 'New Layer...', run: newLayer, enabled: () => !!D() },
  { id: 'layer.backgroundFromLayer', run: backgroundFromLayer, enabled: () => { const d = D(), l = A(); return !!d && !!l && !d.layers.some(x => x.isBackground) && !isGroup(l) && !(l instanceof AdjustmentLayer); } },
  { id: 'layer.layerFromBackground', run: layerFromBackground, enabled: () => !!D()?.layers.some(l => l.isBackground) },
  { id: 'layer.newGroup', run: newGroup, enabled: () => !!D() },
  { id: 'layer.groupFromLayers', run: groupFromLayers, enabled: hasSelNonBg },
  { id: 'layer.newArtboard', run: () => alertDialog('Artboard', 'Artboards are not available in Pixora yet. Use File › New with a preset size, or Image › Canvas Size, to lay out several designs in one document.'), enabled: () => !!D() },
  { id: 'layer.viaCopy', run: () => viaCopy(false), enabled: hasActive },
  { id: 'layer.viaCut', run: () => viaCopy(true), enabled: () => hasSel() && A() instanceof RasterLayer },
  { id: 'layer.copyCSS', run: copyCSS, enabled: hasActive },
  { id: 'layer.copySVG', run: copySVG, enabled: hasActive },
  { id: 'layer.duplicate', label: 'Duplicate Layer...', run: duplicate, enabled: hasActive },
  { id: 'layer.delete', label: 'Delete Layer', run: deleteLayers, enabled: () => { const d = D(); return !!d && d.selectedIds.length > 0 && d.allLayers().length > 1; } },
  { id: 'layer.deleteHidden', run: deleteHidden, enabled: () => !!D()?.allLayers().some(l => !l.visible) },
  { id: 'layer.quickExport', run: () => quickExport(), enabled: hasActive },
  { id: 'layer.exportAs', run: exportAs, enabled: hasActive },
  { id: 'layer.rename', run: rename, enabled: hasActive },
  { id: 'layer.properties', label: 'Layer Properties...', run: layerProperties, enabled: hasActive },
  { id: 'layer.smartFilterToggle', run: () => { const d = D(), l = A(); if (!d || !(l instanceof SmartObjectLayer)) return; d.history.transaction(l.smartFiltersEnabled ? 'Disable Smart Filters' : 'Enable Smart Filters', () => { l.smartFiltersEnabled = !l.smartFiltersEnabled; l.invalidate(); d.pixelsChanged(l, null); d.layersChanged(); }); }, enabled: () => { const l = A(); return l instanceof SmartObjectLayer && l.smartFilters.length > 0; }, checked: () => { const l = A(); return l instanceof SmartObjectLayer && !l.smartFiltersEnabled; } },
  { id: 'layer.smartFilterClear', run: () => { const d = D(), l = A(); if (!d || !(l instanceof SmartObjectLayer)) return; d.history.transaction('Clear Smart Filters', () => { l.smartFilters = []; l.invalidate(); d.pixelsChanged(l, null); d.layersChanged(); }); }, enabled: () => { const l = A(); return l instanceof SmartObjectLayer && l.smartFilters.length > 0; } },
  { id: 'layer.newFill', run: newFill, enabled: () => !!D() },
  { id: 'layer.contentOptions', run: contentOptions, enabled: () => { const l = A(); return l instanceof FillLayer || l instanceof AdjustmentLayer || l instanceof SmartObjectLayer; } },
  { id: 'layer.mask', run: maskCmd, enabled: () => !!A() },
  { id: 'layer.vectorMask', run: vectorMask, enabled: () => !!A() },
  { id: 'layer.clippingMask', label: 'Create Clipping Mask', run: clippingMask, enabled: () => { const d = D(), l = A(); return !!d && !!l && !l.isBackground && (l.clipped || topSelected(d).some(x => !x.isBackground && d.siblingsOf(x).indexOf(x) > 0)); } },
  { id: 'layer.toSmartObject', label: 'Convert to Smart Object', run: toSmart, enabled: hasActive },
  { id: 'layer.smartViaCopy', run: smartViaCopy, enabled: () => A() instanceof SmartObjectLayer },
  { id: 'layer.smartEdit', label: 'Edit Contents', run: () => { const d = D(), l = A(); if (d && l instanceof SmartObjectLayer) editContents(d, l); }, enabled: () => A() instanceof SmartObjectLayer },
  { id: 'layer.smartExport', run: () => { const l = A(); if (l instanceof SmartObjectLayer) return exportContents(l); }, enabled: () => A() instanceof SmartObjectLayer },
  { id: 'layer.smartReplace', run: smartReplace, enabled: () => A() instanceof SmartObjectLayer },
  { id: 'layer.smartToLayers', label: 'Convert to Layers', run: smartToLayersCmd, enabled: () => A() instanceof SmartObjectLayer },
  { id: 'layer.rasterize', label: 'Rasterize Layer', run: rasterize, enabled: () => !!D() },
  { id: 'layer.group', label: 'Group Layers', run: () => { const d = needDoc(); if (d) groupLayers(d, nextNumberedName(d, 'Group')); }, enabled: hasSelNonBg },
  { id: 'layer.ungroup', label: 'Ungroup Layers', run: ungroup, enabled: () => !!D() && topSelected(D()!).some(isGroup) },
  { id: 'layer.hide', run: hideLayers, enabled: hasActive },
  { id: 'layer.arrange', run: arrange, enabled: () => !!D() && movable(D()!).length > 0 },
  { id: 'layer.moveUp', label: 'Bring Forward', run: () => arrange('forward'), enabled: () => !!D() && movable(D()!).length > 0 },
  { id: 'layer.moveDown', label: 'Send Backward', run: () => arrange('backward'), enabled: () => !!D() && movable(D()!).length > 0 },
  { id: 'layer.align', run: align, enabled: () => !!D() && alignInfo(D()!).targets.length > 0 },
  { id: 'layer.distribute', run: distribute, enabled: () => !!D() && alignInfo(D()!).targets.length >= 3 },
  { id: 'layer.lockDialog', run: lockDialog, enabled: hasSelNonBg },
  { id: 'layer.link', label: 'Link Layers', run: linkLayers, enabled: () => { const d = D(); return !!d && (d.selectedIds.length > 1 || !!d.activeLayer?.linkId); } },
  { id: 'layer.selectLinked', run: selectLinked, enabled: () => !!A()?.linkId },
  { id: 'layer.mergeDown', label: 'Merge Down', run: mergeDown, enabled: mergeDownEnabled },
  { id: 'layer.mergeVisible', label: 'Merge Visible', run: mergeVisible, enabled: () => !!D() && D()!.layers.filter(l => l.visible).length >= 1 },
  { id: 'layer.flatten', label: 'Flatten Image', run: flatten, enabled: () => { const d = D(); return !!d && (d.layers.length > 1 || !d.layers[0]?.isBackground || d.layers[0] instanceof GroupLayer); } },
  { id: 'layer.matting', run: matting, enabled: () => { const l = A(); return l instanceof RasterLayer && !l.isBackground; } },
  { id: 'layer.selectNext', label: 'Select Next Layer', shortcut: 'Alt+]', run: (add?: boolean) => selectRel(1, add === true), enabled: hasActive },
  { id: 'layer.selectPrev', label: 'Select Previous Layer', shortcut: 'Alt+[', run: (add?: boolean) => selectRel(-1, add === true), enabled: hasActive },
  { id: 'layer.selectTop', label: 'Select Top Layer', shortcut: 'Alt+.', run: (add?: boolean) => selectRel('top', add === true), enabled: () => !!D() },
  { id: 'layer.selectBottom', label: 'Select Bottom Layer', shortcut: 'Alt+,', run: (add?: boolean) => selectRel('bottom', add === true), enabled: () => !!D() },
  { id: 'layer.selectNextAdd', label: 'Add Next Layer to Selection', shortcut: 'Alt+Shift+]', run: () => selectRel(1, true), enabled: hasActive },
  { id: 'layer.selectPrevAdd', label: 'Add Previous Layer to Selection', shortcut: 'Alt+Shift+[', run: () => selectRel(-1, true), enabled: hasActive },
  { id: 'layer.selectTopAdd', label: 'Select to Top Layer', shortcut: 'Alt+Shift+.', run: () => selectRel('top', true), enabled: hasActive },
  { id: 'layer.selectBottomAdd', label: 'Select to Bottom Layer', shortcut: 'Alt+Shift+,', run: () => selectRel('bottom', true), enabled: hasActive },
  { id: 'layer.stampVisible', label: 'Stamp Visible', shortcut: 'Ctrl+Alt+Shift+E', run: () => mergeVisible('stamp'), enabled: () => !!D() },
  { id: 'layer.newQuick', label: 'New Layer', shortcut: 'Ctrl+Alt+Shift+N', run: () => newLayer({ noDialog: true }), enabled: () => !!D() },
  { id: 'layer.loadTransparency', label: 'Load Layer Transparency', run: (arg?: { layer?: Layer; op?: 'replace' | 'add' | 'subtract' | 'intersect' }) => {
    const d = needDoc(); const l = arg?.layer || d?.activeLayer; if (!d || !l) return;
    const c = l instanceof AdjustmentLayer || isGroup(l) && !l.children.length ? null : isGroup(l) ? renderLayersToCanvas(d, [l]) : transparencyCanvas(d, l);
    if (!c) return;
    d.history.transaction('Load Selection', () => d.selection.apply(c, arg?.op || 'replace'));
  }, enabled: hasActive },
]);

export { mergeLayers, groupLayers, deleteLayers, rename };
