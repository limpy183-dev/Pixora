// Smaller Image menu dialogs: Rotate Canvas (Arbitrary), Trim, Duplicate Image, Trap.
import { app } from '../../core/app';
import { PixDocument } from '../../core/document';
import { cloneState } from '../../core/layer';
import { cloneCanvas } from '../../core/canvas';
import { openDialog, alertDialog } from '../../ui/dialog';
import { h } from '../../ui/dom';
import { checkbox, select, textField } from '../../ui/widgets';
import { applyPixelOp } from '../../core/pixelops';
import { luma } from '../../core/color';
import { toPx } from '../../core/units';
import { cropTo, docChanged, hasTransparency, rotateCanvas, trimRect, flattenDoc, type TrimBase } from './ops';
import { dialogRow, numInput, radioGroup, remember } from './ui';

const okCancel = [{ label: 'OK', primary: true, value: 'ok' }, { label: 'Cancel', value: null }];

// ------------------------------------------------------------------ Rotate Canvas (Arbitrary)
export async function rotateArbitraryDialog(doc: PixDocument) {
  const S = remember('rotate', { angle: 0, cw: true });
  let angle = S.angle, cw = S.cw;
  const inp = numInput(70, v => { angle = Math.max(-359.99, Math.min(359.99, v)); inp.show(angle, 2); });
  inp.show(angle, 2);
  const dir = radioGroup([{ value: true, label: '°CW' }, { value: false, label: '°CCW' }], cw, v => { cw = v; });
  const body = h('div.imgd-form', null, h('div.imgd-inline', null, h('span', null, 'Angle:'), inp, dir));
  const r = await openDialog({ title: 'Rotate Canvas', body, layout: 'side', buttons: okCancel }).result;
  if (r !== 'ok') return;
  Object.assign(S, { angle, cw }); S.save();
  if (!angle) return;
  doc.history.transaction('Rotate Canvas', () => rotateCanvas(doc, cw ? angle : -angle, app.bg), 'image');
  docChanged(doc);
}

// ------------------------------------------------------------------ Trim
export async function trimDialog(doc: PixDocument) {
  const transparent = hasTransparency(doc);
  const S = remember('trim', { base: 'transparent' as TrimBase, top: true, bottom: true, left: true, right: true });
  let base: TrimBase = transparent ? S.base : S.base === 'transparent' ? 'topLeft' : S.base;
  const sides = { top: S.top, bottom: S.bottom, left: S.left, right: S.right };
  const rg = radioGroup<TrimBase>([
    { value: 'transparent', label: 'Transparent Pixels', disabled: !transparent },
    { value: 'topLeft', label: 'Top Left Pixel Color' },
    { value: 'bottomRight', label: 'Bottom Right Pixel Color' },
  ], base, v => { base = v; });
  const cb = (k: keyof typeof sides, label: string) => checkbox(label, sides[k], v => { sides[k] = v; });
  const body = h('div.imgd-form', { style: { minWidth: '300px' } },
    h('fieldset.group', null, h('legend', null, 'Based On'), rg),
    h('fieldset.group', null, h('legend', null, 'Trim Away'),
      h('div.imgd-grid2', null, cb('top', 'Top'), cb('left', 'Left'), cb('bottom', 'Bottom'), cb('right', 'Right'))));
  const r = await openDialog({ title: 'Trim', body, layout: 'side', buttons: okCancel }).result;
  if (r !== 'ok') return;
  Object.assign(S, { base, ...sides }); S.save();
  if (!sides.top && !sides.bottom && !sides.left && !sides.right) return;
  const rect = trimRect(doc, base, sides);
  if (!rect) { await alertDialog('Pixora', 'Could not trim because the image would be empty.', 'warning'); return; }
  if (rect.x === 0 && rect.y === 0 && rect.w === doc.width && rect.h === doc.height) return;
  doc.history.transaction('Trim', () => cropTo(doc, rect, false), 'image');
  docChanged(doc);
}

// ------------------------------------------------------------------ Duplicate Image
/** Deep copy of a document as a new, unsaved document. */
export function duplicateDocument(doc: PixDocument, name: string, mergedOnly = false): PixDocument {
  const d = new PixDocument(doc.width, doc.height, name);
  d.resolution = doc.resolution; d.resolutionUnit = doc.resolutionUnit; d.mode = doc.mode; d.bitDepth = doc.bitDepth;
  const ids = new Map<number, number>();
  const all = doc.allLayers();
  d.layers = doc.layers.map(l => l.clone());
  d.relink();
  const allNew = d.allLayers();
  all.forEach((l, i) => ids.set(l.id, allNew[i]?.id));
  d.activeLayerId = ids.get(doc.activeLayerId!) ?? allNew[allNew.length - 1]?.id ?? null;
  d.selectedIds = doc.selectedIds.map(id => ids.get(id)!).filter(Boolean);
  if (doc.selection.mask) d.selection.setMask(cloneCanvas(doc.selection.mask));
  d.guides = cloneState(doc.guides);
  d.paths = cloneState(doc.paths, true);
  d.channels = cloneState(doc.channels, true);
  d.extra = cloneState(doc.extra, true);
  d.meta = { ...doc.meta };
  d.layerCounter = doc.layerCounter;
  if (mergedOnly) flattenDoc(d, { opaque: !hasTransparency(doc), name: hasTransparency(doc) ? 'Layer 1' : 'Background' });
  d.history.baseName = 'Duplicate';
  d.history.snapshots = [{ name: d.name, state: d.captureState(true) }];
  d.modified = false;
  return d;
}
export async function duplicateDialog(doc: PixDocument) {
  let name = `${doc.name.replace(/\.[^.]+$/, '')} copy`, merged = false;
  const multi = doc.allLayers().length > 1;
  const nameIn = textField(name, v => { name = v; }, { width: 240, onInput: v => { name = v; } });
  const mcb = checkbox('Duplicate Merged Layers Only', false, v => { merged = v; });
  if (!multi) mcb.querySelector('input')!.disabled = true;
  const body = h('div.imgd-form', null,
    h('div.imgd-inline', null, h('span.imgd-lbl', { style: { minWidth: '64px' } }, 'Duplicate:'), h('span.imgd-strong', null, doc.name)),
    h('div.imgd-inline', null, h('span.imgd-lbl', { style: { minWidth: '64px' } }, 'As:'), nameIn),
    h('div', { style: { paddingLeft: '72px' } }, mcb));
  const r = await openDialog({ title: 'Duplicate Image', body, layout: 'side', buttons: okCancel }).result;
  if (r !== 'ok') return;
  app.addDocument(duplicateDocument(doc, name.trim() || `${doc.name} copy`, merged && multi));
}

// ------------------------------------------------------------------ Trap (CMYK only, like Photoshop)
export async function trapDialog(doc: PixDocument) {
  if (doc.mode !== 'CMYK') {
    await alertDialog('Pixora', 'Could not complete the Trap command because the document is not in CMYK mode. Choose Image › Mode › CMYK Color first.', 'warning');
    return;
  }
  const S = remember('trap', { width: 1, unit: 'px' as 'px' | 'pt' | 'mm' });
  let width = S.width, unit = S.unit;
  const inp = numInput(60, v => { width = Math.max(0.01, v); inp.show(width, 2); });
  inp.show(width, 2);
  const us = select([{ value: 'px', label: 'Pixels' }, { value: 'pt', label: 'Points' }, { value: 'mm', label: 'Millimeters' }], unit, v => { unit = v as any; }, { width: 120 });
  const body = h('div.imgd-form', null, h('fieldset.group', null, h('legend', null, 'Trap'), dialogRow('Width:', inp, us)));
  const r = await openDialog({ title: 'Trap', body, layout: 'side', buttons: okCancel }).result;
  if (r !== 'ok') return;
  Object.assign(S, { width, unit }); S.save();
  const rad = Math.max(1, Math.min(10, Math.round(toPx(width, unit, doc.resolution))));
  // Lighter colours spread under darker ones: a darker pixel next to a lighter one is overprinted (multiplied) with it.
  await applyPixelOp(doc, 'Trap', img => {
    const { width: w, height: hh, data: d } = img;
    const src = new Uint8ClampedArray(d), L = new Float32Array(w * hh);
    for (let i = 0, p = 0; p < w * hh; i += 4, p++) L[p] = luma(src[i], src[i + 1], src[i + 2]);
    for (let y = 0; y < hh; y++) for (let x = 0; x < w; x++) {
      const p = y * w + x;
      let best = -1, bl = L[p] + 8;
      for (let dy = -rad; dy <= rad; dy++) {
        const yy = y + dy; if (yy < 0 || yy >= hh) continue;
        for (let dx = -rad; dx <= rad; dx++) {
          const xx = x + dx; if (xx < 0 || xx >= w || dx * dx + dy * dy > rad * rad) continue;
          const q = yy * w + xx;
          if (L[q] > bl && src[q * 4 + 3] > 0) { bl = L[q]; best = q; }
        }
      }
      if (best >= 0) { const i = p * 4, j = best * 4; d[i] = (src[i] * src[j]) / 255; d[i + 1] = (src[i + 1] * src[j + 1]) / 255; d[i + 2] = (src[i + 2] * src[j + 2]) / 255; }
    }
  });
}
