// Commands: Image › Adjustments dialogs (image.adjust), Auto Tone / Contrast / Color, and
// Layer › New Adjustment Layer (layer.newAdjustment).
import { app } from '../core/app';
import { registerCommand, runCommand } from '../core/commands';
import { applyPixelOp, pixelOpPreview, editableTarget, mergeThroughSelection, type PixelOp, type PixelOpInfo } from '../core/pixelops';
import { AdjustmentLayer, GroupLayer, createMask } from '../core/layer';
import type { PixDocument } from '../core/document';
import { createCanvas, ctx2d } from '../core/canvas';
import { openDialog } from '../ui/dialog';
import { toast } from '../ui/toast';
import { h } from '../ui/dom';
import { maskFromSelection, nextNumberedName } from '../features/layers/shared';
import { defs, kernelFor, clone, Env, autoTone, autoContrast, autoColor, levelsKernel, type AdjDef, type LevelsParams } from './lib';
import { mountAdjustmentUI, disarmEyedropper } from './ui';
import { equalizeLUT } from './basic';
import { lutKernel } from './lib';

const opFor = (def: AdjDef, params: any): PixelOp => {
  const p = clone(params);
  return (img: ImageData, info: PixelOpInfo) => {
    kernelFor(def, p)(img, { doc: info.doc, rect: { x: info.x, y: info.y, w: img.width, h: img.height } });
  };
};
export const historyName = (def: AdjDef) => def.historyName || def.label;

let dialogOpen = false;
/** Image › Adjustments › <type>: PS-style dialog with live preview (or immediate apply for Invert etc.). */
export async function adjustDialog(type: string, initial?: any): Promise<boolean> {
  const doc = app.activeDoc;
  const def = defs[type];
  if (!doc) return false;
  if (!def) { toast(`${type} is not available.`); return false; }
  if (def.immediate) {
    if (type === 'equalize') return equalize(doc);
    return applyPixelOp(doc, historyName(def), opFor(def, def.defaults()));
  }
  if (dialogOpen) return false;
  const preview = pixelOpPreview(doc);
  if (!preview.ok) return false;
  dialogOpen = true;
  const p = initial ? clone(initial) : def.defaults();
  const env = new Env(doc, null);
  const body = h('div.adj-dialog-body', { dataset: { adj: type } });
  let raf = 0;
  const change = () => {
    if (raf) return;
    raf = requestAnimationFrame(() => { raf = 0; preview.update(opFor(def, p), 0); });
  };
  const cleanup = mountAdjustmentUI(def, body, p, change, env);
  // Alt turns "Cancel" into "Reset" (Photoshop behaviour)
  let alt = false;
  const cancelBtn = { label: 'Cancel', value: false, onClick: () => {
    if (!alt) return;
    const d = def.defaults();
    for (const k of Object.keys(p)) if (k[0] !== '_') delete p[k];
    Object.assign(p, d);
    env.rebuild();
    return false;
  } };
  const d = openDialog({
    title: def.label, body, layout: 'side', width: def.dialogWidth ?? 440, className: 'adj-dialog',
    preview: { checked: true, onChange: v => preview.setEnabled(v) },
    buttons: [{ label: 'OK', primary: true, value: true }, cancelBtn],
    cancelValue: false,
  });
  const btns = d.el.querySelectorAll<HTMLButtonElement>('.dialog-buttons .btn');
  const altKey = (e: KeyboardEvent) => {
    if (e.key !== 'Alt') return;
    alt = e.type === 'keydown';
    if (btns[1]) btns[1].textContent = alt ? 'Reset' : 'Cancel';
    e.preventDefault();
  };
  window.addEventListener('keydown', altKey, true);
  window.addEventListener('keyup', altKey, true);
  preview.update(opFor(def, p), 0);
  const ok = await d.result;
  window.removeEventListener('keydown', altKey, true);
  window.removeEventListener('keyup', altKey, true);
  cancelAnimationFrame(raf);
  cleanup();
  disarmEyedropper();
  dialogOpen = false;
  if (!ok) { preview.cancel(); return false; }
  await preview.commit(historyName(def), opFor(def, p));
  return true;
}

/** Equalize: with a selection, ask whether to equalize only the selection or the whole image based on it. */
async function equalize(doc: PixDocument): Promise<boolean> {
  const t = editableTarget(doc);
  if (!t) return false;
  const sel = !doc.quickMask && !doc.selection.empty ? doc.selection.mask : null;
  if (!sel) return applyPixelOp(doc, 'Equalize', img => { const l = equalizeLUT(img); lutKernel(l, l, l)(img, null as any); });
  let mode = 'selection';
  const body = h('div.form', null,
    h('div.adj-sub', null, 'Options'),
    ...[['selection', 'Equalize selected area only'], ['entire', 'Equalize entire image based on selected area']].map(([v, l]) => {
      const inp = h('input', { type: 'radio', name: 'adj-eq', checked: v === mode }) as HTMLInputElement;
      inp.addEventListener('change', () => { if (inp.checked) mode = v; });
      return h('label.adj-radio', null, inp, h('span.adj-radio-dot'), h('span', null, l));
    }));
  const ok = await openDialog({ title: 'Equalize', body, width: 400, cancelValue: false, buttons: [{ label: 'OK', primary: true, value: true }, { label: 'Cancel', value: false }] }).result;
  if (!ok) return false;
  if (t.kind === 'pixels') (t.layer as any).ensureRect({ x: 0, y: 0, w: doc.width, h: doc.height });
  const c = t.holder.canvas, img = ctx2d(c).getImageData(0, 0, c.width, c.height);
  // selection mask in holder coordinates
  const mc = createCanvas(c.width, c.height);
  ctx2d(mc).drawImage(sel, -t.holder.x, -t.holder.y);
  const md = ctx2d(mc).getImageData(0, 0, c.width, c.height).data, m = new Uint8ClampedArray(md.length / 4);
  for (let i = 0; i < m.length; i++) m[i] = md[i * 4 + 3];
  const src = t.isMask ? greyFromAlpha(img) : img;
  const l = equalizeLUT(src, m);
  lutKernel(l, l, l)(src, null as any);
  if (t.isMask) { const d = src.data; for (let i = 0; i < d.length; i += 4) { d[i + 3] = d[i]; d[i] = d[i + 1] = d[i + 2] = 0; } }
  const res = createCanvas(c.width, c.height);
  ctx2d(res).putImageData(src, 0, 0);
  const out = mode === 'selection' ? mergeThroughSelection(doc, t, c, res) : res;
  doc.history.transaction('Equalize', () => { t.holder.canvas = out; });
  doc.pixelsChanged(t.layer, null);
  return true;
}
function greyFromAlpha(img: ImageData) {
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) { d[i] = d[i + 1] = d[i + 2] = d[i + 3]; d[i + 3] = 255; }
  return img;
}

/** ImageData restricted to the selection bounds (statistics for Auto corrections). */
function statsRegion(img: ImageData, r: PixelOpInfo['selRect']): ImageData {
  if (!r) return img;
  const x0 = Math.max(0, r.x), y0 = Math.max(0, r.y), x1 = Math.min(img.width, r.x + r.w), y1 = Math.min(img.height, r.y + r.h);
  if (x1 <= x0 || y1 <= y0) return img;
  const out = new ImageData(x1 - x0, y1 - y0);
  for (let y = y0; y < y1; y++) out.data.set(img.data.subarray((y * img.width + x0) * 4, (y * img.width + x1) * 4), (y - y0) * out.width * 4);
  return out;
}
function auto(name: string, fn: (img: ImageData) => LevelsParams) {
  const doc = app.activeDoc;
  if (!doc) return;
  return applyPixelOp(doc, name, (img, info) => { levelsKernel(fn(statsRegion(img, info.selRect)))(img, null as any); });
}

// ------------------------------------------------------------------ adjustment layers
export interface NewAdjOpts { type: string; params?: any; name?: string; parent?: GroupLayer | null; index?: number; history?: boolean; clipped?: boolean; mask?: boolean }
/** Create an adjustment layer (with a reveal-all or selection mask) above the active layer. */
export function createAdjustmentLayer(doc: PixDocument, o: NewAdjOpts): AdjustmentLayer | null {
  const def = defs[o.type];
  if (!def || def.dialogOnly) { toast(`${def?.label || o.type} is not available as an adjustment layer.`); return null; }
  const layer = new AdjustmentLayer(o.type, o.params ? clone(o.params) : def.defaults(), o.name || nextNumberedName(doc, def.label));
  layer.mask = o.mask === false ? null : !doc.quickMask && !doc.selection.empty ? maskFromSelection(doc) : createMask(doc, 255);
  if (o.clipped) layer.clipped = true;
  const add = () => {
    if (o.parent !== undefined || o.index !== undefined) doc.addLayer(layer, { parent: o.parent ?? null, index: o.index });
    else doc.addLayer(layer);
    doc.editMask = false;
  };
  if (o.history === false) add(); else doc.history.transaction(`New ${def.label} Layer`, add, 'adjust-layer');
  return layer;
}

registerCommand({ id: 'image.adjust', run: (type: string) => adjustDialog(type), enabled: () => !!app.activeDoc });
registerCommand({ id: 'image.autoTone', shortcut: 'Shift+Ctrl+L', run: () => auto('Auto Tone', img => autoTone(img)), enabled: () => !!app.activeDoc });
registerCommand({ id: 'image.autoContrast', shortcut: 'Alt+Shift+Ctrl+L', run: () => auto('Auto Contrast', img => autoContrast(img)), enabled: () => !!app.activeDoc });
registerCommand({ id: 'image.autoColor', shortcut: 'Shift+Ctrl+B', run: () => auto('Auto Color', img => autoColor(img)), enabled: () => !!app.activeDoc });
registerCommand({
  id: 'layer.newAdjustment',
  enabled: () => !!app.activeDoc,
  run(arg: string | NewAdjOpts) {
    const doc = app.activeDoc;
    if (!doc) return;
    const o = typeof arg === 'string' ? { type: arg } : arg;
    const l = createAdjustmentLayer(doc, o);
    if (l) runCommand('window.showPanel', 'properties');
    return l;
  },
});


