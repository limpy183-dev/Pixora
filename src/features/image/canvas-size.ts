// Image › Canvas Size… (Alt+Ctrl+C) — Current/New size, units, Relative, 3×3 anchor, canvas extension colour.
import { app } from '../../core/app';
import type { PixDocument } from '../../core/document';
import type { RGB } from '../../core/types';
import { openDialog, confirmDialog } from '../../ui/dialog';
import { h } from '../../ui/dom';
import { checkbox, colorSwatch, select } from '../../ui/widgets';
import { registerIcons, icon } from '../../ui/icons';
import { hooks } from '../../core/registry';
import type { Unit } from '../../core/units';
import { canvasSize, docBytes, docChanged, fmtBytes, type Anchor } from './ops';
import { ALL_UNITS, defaultUnit, lenLabel, numInput, pxFrom, remember, showIn, unitOptions } from './ui';

registerIcons({ 'img-arrow': '<path d="M12 19V5M6.5 10.5 12 5l5.5 5.5"/>' });

type ExtColor = 'fg' | 'bg' | 'white' | 'black' | 'gray' | 'other';
const EXT_LABELS: [ExtColor, string][] = [['fg', 'Foreground'], ['bg', 'Background'], ['white', 'White'], ['black', 'Black'], ['gray', 'Gray'], ['other', 'Other...']];
function extRGB(k: ExtColor, other: RGB): RGB {
  switch (k) {
    case 'fg': return app.fg;
    case 'bg': return app.bg;
    case 'white': return { r: 255, g: 255, b: 255 };
    case 'black': return { r: 0, g: 0, b: 0 };
    case 'gray': return { r: 128, g: 128, b: 128 };
    default: return other;
  }
}

/** 3×3 anchor picker with arrows pointing away from the anchor (Photoshop style). */
export function anchorGrid(value: Anchor, onChange: (a: Anchor) => void): HTMLElement & { set(a: Anchor): void } {
  const el = h('div.imgd-anchor', { title: 'Anchor' }) as HTMLElement & { set(a: Anchor): void };
  let cur = value;
  const cells: HTMLButtonElement[] = [];
  for (let j = 0; j < 3; j++) for (let i = 0; i < 3; i++) {
    const b = h('button', { type: 'button', title: 'Anchor' }) as HTMLButtonElement;
    b.addEventListener('click', () => { cur = { ax: i / 2, ay: j / 2 }; paint(); onChange(cur); });
    cells.push(b); el.appendChild(b);
  }
  const paint = () => {
    const ci = Math.round(cur.ax * 2), cj = Math.round(cur.ay * 2);
    cells.forEach((b, k) => {
      const i = k % 3, j = (k / 3) | 0, dx = i - ci, dy = j - cj;
      b.classList.toggle('on', !dx && !dy);
      b.replaceChildren();
      if (!dx && !dy) b.appendChild(h('span.imgd-dot'));
      else if (Math.abs(dx) <= 1 && Math.abs(dy) <= 1) {
        const ic = icon('img-arrow', 14);
        ic.style.transform = `rotate(${(Math.atan2(dy, dx) * 180) / Math.PI + 90}deg)`;
        b.appendChild(ic);
      }
    });
  };
  el.set = a => { cur = a; paint(); };
  paint();
  return el;
}

export async function canvasSizeDialog(doc: PixDocument): Promise<void> {
  const W0 = doc.width, H0 = doc.height, res = doc.resolution;
  const S = remember('canvasSize', { unit: defaultUnit() as Unit, ext: 'bg' as ExtColor, other: { r: 255, g: 255, b: 255 } as RGB });
  let unit: Unit = S.unit, ext: ExtColor = S.ext, other: RGB = S.other;
  let relative = false, anchor: Anchor = { ax: 0.5, ay: 0.5 };
  let nW = W0, nH = H0;   // target size in px

  const curSize = h('span.imgd-strong'), newSize = h('span.imgd-strong');
  const curW = h('span'), curH = h('span');
  const wIn = numInput(90, v => setDim('w', v)), hIn = numInput(90, v => setDim('h', v));
  const unitW = select(unitOptions(ALL_UNITS), unit, u => { unit = u; unitH.setValue(u); sync(); }, { width: 120, title: 'Units' });
  const unitH = select(unitOptions(ALL_UNITS), unit, u => { unit = u; unitW.setValue(u); sync(); }, { width: 120, title: 'Units' });
  const relCb = checkbox('Relative', relative, v => { relative = v; sync(); }, { title: 'Enter the amount to add to (or subtract from) the current size' });
  const grid = anchorGrid(anchor, a => { anchor = a; });
  const swatch = colorSwatch(extRGB(ext, other), c => { ext = 'other'; other = c; extSel.setValue('other'); }, { title: 'Canvas extension color', size: 20 });
  const extSel = select(EXT_LABELS.map(([value, label]) => ({ value, label })), ext, async v => {
    if (v === 'other') {
      const c = await hooks.openColorPicker(other, 'Color Picker (Canvas Extension Color)');
      if (c) other = c; else { extSel.setValue(ext); return; }
    }
    ext = v; swatch.setValue(extRGB(ext, other));
  }, { width: 130, title: 'Canvas extension color' });
  const hasBg = doc.layers.some(l => l.isBackground);
  if (!hasBg) { extSel.setAttribute('disabled', ''); swatch.setAttribute('disabled', ''); }

  function setDim(which: 'w' | 'h', v: number) {
    const ref = which === 'w' ? W0 : H0;
    let px = pxFrom(v, unit, res, ref);
    if (relative) px = ref + (unit === '%' ? (v / 100) * ref : pxFrom(v, unit, res, ref));
    px = Math.max(1, Math.min(300000, Math.round(px)));
    if (which === 'w') nW = px; else nH = px;
    sync();
  }
  function sync() {
    curSize.textContent = fmtBytes(docBytes(doc));
    newSize.textContent = fmtBytes(docBytes(doc, nW, nH));
    curW.textContent = lenLabel(W0, unit === '%' ? 'px' : unit, res, W0);
    curH.textContent = lenLabel(H0, unit === '%' ? 'px' : unit, res, H0);
    if (relative) {
      const dw = nW - W0, dh = nH - H0;
      unit === '%' ? wIn.show((dw / W0) * 100, 2) : showIn(wIn, dw, unit, res, W0);
      unit === '%' ? hIn.show((dh / H0) * 100, 2) : showIn(hIn, dh, unit, res, H0);
    } else { showIn(wIn, nW, unit, res, W0); showIn(hIn, nH, unit, res, H0); }
  }
  sync();

  const lbl = (t: string) => h('span.imgd-lbl', { style: { minWidth: '64px' } }, t);
  const body = h('div.imgd-form', { style: { minWidth: '380px' } },
    h('div.imgd-inline', null, h('span', null, 'Current Size: '), curSize),
    h('div.imgd-inline', { style: { paddingLeft: '18px' } }, lbl('Width:'), curW),
    h('div.imgd-inline', { style: { paddingLeft: '18px' } }, lbl('Height:'), curH),
    h('div.imgd-sep'),
    h('div.imgd-inline', null, h('span', null, 'New Size: '), newSize),
    h('div.imgd-inline', { style: { paddingLeft: '18px' } }, lbl('Width:'), wIn, unitW),
    h('div.imgd-inline', { style: { paddingLeft: '18px' } }, lbl('Height:'), hIn, unitH),
    h('div.imgd-inline', { style: { paddingLeft: '90px' } }, relCb),
    h('div.imgd-inline', { style: { paddingLeft: '18px', alignItems: 'flex-start' } }, lbl('Anchor:'), grid),
    h('div.imgd-sep'),
    h('div.imgd-inline', null, h('span', { class: hasBg ? '' : 'imgd-note' }, 'Canvas extension color:'), extSel, swatch));

  const r = await openDialog({ title: 'Canvas Size', body, layout: 'side', buttons: [{ label: 'OK', primary: true, value: 'ok' }, { label: 'Cancel', value: null }] }).result;
  Object.assign(S, { unit, ext, other }); S.save();
  if (r !== 'ok' || (nW === W0 && nH === H0)) return;
  if (nW < W0 || nH < H0) {
    const c = await confirmDialog('Pixora', 'The new canvas size is smaller than the current canvas size; some clipping will occur.', [{ label: 'Proceed', primary: true, value: 'ok' }, { label: 'Cancel', value: 'cancel' }]);
    if (c !== 'ok') return;
  }
  doc.history.transaction('Canvas Size', () => canvasSize(doc, nW, nH, anchor, extRGB(ext, other)), 'image');
  docChanged(doc);
}
