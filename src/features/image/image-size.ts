// Image › Image Size… (Alt+Ctrl+I) — Photoshop's dialog with live preview, Fit To presets, linked W/H,
// resolution, Resample methods (+ Reduce Noise), Scale Styles.
import { openDialog } from '../../ui/dialog';
import { h, dragPointer } from '../../ui/dom';
import { select, checkbox, iconButton, slider } from '../../ui/widgets';
import { openMenu } from '../../ui/menu';
import { icon } from '../../ui/icons';
import type { PixDocument } from '../../core/document';
import { renderLayersToCanvas } from '../../core/compositor';
import { createCanvas, ctx2d } from '../../core/canvas';
import { toPx, UNIT_LABELS, type Unit } from '../../core/units';
import { resamplePixels, RESAMPLE_LABELS, resolveMethod, type ResampleMethod } from './resample';
import { docBytes, fmtBytes, imageSize, docChanged } from './ops';
import { numInput, showIn, pxFrom, remember, ALL_UNITS, radioGroup, dialogRow, unitOptions } from './ui';

const MAX_PX = 300000;
type Preset = { label: string; w: number; h: number; unit: 'px' | 'in' | 'mm'; res: number };
const PRESETS: Preset[] = [
  { label: '640 x 480 Pixels 72 ppi', w: 640, h: 480, unit: 'px', res: 72 },
  { label: '800 x 600 Pixels 72 ppi', w: 800, h: 600, unit: 'px', res: 72 },
  { label: '1024 x 768 Pixels 72 ppi', w: 1024, h: 768, unit: 'px', res: 72 },
  { label: '1280 x 800 Pixels 72 ppi', w: 1280, h: 800, unit: 'px', res: 72 },
  { label: '1366 x 768 Pixels 72 ppi', w: 1366, h: 768, unit: 'px', res: 72 },
  { label: '4 x 6 in 300 ppi', w: 6, h: 4, unit: 'in', res: 300 },
  { label: '5 x 7 in 300 ppi', w: 7, h: 5, unit: 'in', res: 300 },
  { label: '8 x 10 in 300 ppi', w: 10, h: 8, unit: 'in', res: 300 },
  { label: 'Letter 300 ppi', w: 11, h: 8.5, unit: 'in', res: 300 },
  { label: 'Legal 300 ppi', w: 14, h: 8.5, unit: 'in', res: 300 },
  { label: 'Tabloid 300 ppi', w: 17, h: 11, unit: 'in', res: 300 },
  { label: 'A4 300 ppi', w: 297, h: 210, unit: 'mm', res: 300 },
  { label: 'A3 300 ppi', w: 420, h: 297, unit: 'mm', res: 300 },
  { label: 'B5 300 ppi', w: 250, h: 176, unit: 'mm', res: 300 },
  { label: 'B4 300 ppi', w: 353, h: 250, unit: 'mm', res: 300 },
  { label: 'B3 300 ppi', w: 500, h: 353, unit: 'mm', res: 300 },
];

/** Auto Resolution sub-dialog: returns ppi or null. */
async function autoResolution(): Promise<number | null> {
  let screen = 133, q = 'good' as 'draft' | 'good' | 'best';
  const scr = numInput(70, v => { screen = Math.max(1, v); scr.show(screen, 1); });
  scr.show(screen, 1);
  const body = h('div.imgd-form', null,
    dialogRow('Screen:', scr, h('span', null, 'Lines/Inch')),
    dialogRow('Quality:', radioGroup([{ value: 'draft', label: 'Draft' }, { value: 'good', label: 'Good' }, { value: 'best', label: 'Best' }], q, v => { q = v as any; })));
  const r = await openDialog({ title: 'Auto Resolution', body, layout: 'side', buttons: [{ label: 'OK', primary: true, value: 'ok' }, { label: 'Cancel', value: null }] }).result;
  if (r !== 'ok') return null;
  return q === 'draft' ? 72 : q === 'good' ? Math.min(Math.round(screen * 1.5), 2400) : Math.min(screen * 2, 2400);
}

export async function imageSizeDialog(doc: PixDocument): Promise<void> {
  const W0 = doc.width, H0 = doc.height, res0 = doc.resolution;
  const S = remember('imageSize', { unit: 'px' as Unit, resample: true, method: 'automatic' as ResampleMethod, scaleStyles: true, constrain: true, dimUnit: 'px' as Unit, noise: 0 });
  let tW = W0, tH = H0, res = res0, resUnit = doc.resolutionUnit;
  let unit: Unit = S.unit, dimUnit: Unit = S.dimUnit;
  let resample = S.resample, method: ResampleMethod = S.method, constrain = S.constrain, scaleStyles = S.scaleStyles, noise = S.noise;
  let preset = 'original';

  // ---------------------------------------------------------------- controls
  const sizeLbl = h('span');
  const dimLbl = h('span.imgd-strong');
  const dimSel = select(unitOptions(ALL_UNITS), dimUnit, u => { dimUnit = u; sync(); }, { width: 30, title: 'Dimensions units' });
  const presetSel = select<string>([
    { value: 'custom', label: 'Custom', disabled: true },
    { value: 'original', label: 'Original Size' }, { value: 'auto', label: 'Auto Resolution...' }, '-',
    ...PRESETS.map(p => ({ value: p.label, label: p.label })),
  ], preset, v => applyPreset(v), { width: 230, title: 'Fit To' });
  const wIn = numInput(96, v => setDim('w', v, true), v => setDim('w', v, false));
  const hIn = numInput(96, v => setDim('h', v, true), v => setDim('h', v, false));
  const resIn = numInput(96, v => setRes(v), undefined, { title: 'Resolution' });
  let wUnit = makeUnitSel(), hUnit = makeUnitSel();
  const resUnitSel = select([{ value: 'ppi', label: 'Pixels/Inch' }, { value: 'ppcm', label: 'Pixels/Centimeter' }], resUnit, v => { resUnit = v as any; sync(); }, { width: 150, title: 'Resolution units' });
  const chainBtn = iconButton(constrain ? 'link-v' : 'link-v-broken', 'Constrain aspect ratio', () => {
    constrain = !constrain;
    if (constrain) tH = clampPx(tW * H0 / W0);
    custom(); sync();
  });
  const chain = h('div.imgd-chain', null, chainBtn);
  const methodSel = select(RESAMPLE_LABELS.map(([value, label]) => ({ value, label })), method, v => { method = v; sync(); schedulePreview(); }, { width: 230, title: 'Resample method' });
  const resampleCb = checkbox('Resample:', resample, v => {
    resample = v;
    if (!v) { tW = W0; tH = H0; if (unit === 'px' || unit === '%') unit = resUnit === 'ppcm' ? 'cm' : 'in'; }
    rebuildUnits(); custom(); sync();
  }, { title: 'Resample image' });
  const noiseVal = h('span', null, '0%');
  const noiseSl = slider(noise, 0, 100, v => { noise = v; noiseVal.textContent = v + '%'; schedulePreview(); });
  const noiseRow = h('div.imgd-inline.imgd-noise', null, h('span.imgd-lbl', null, 'Reduce Noise:'), noiseSl, noiseVal);
  const gear = iconButton('gear', 'Settings', e => {
    openMenu([{ label: 'Scale Styles', checked: scaleStyles, action: () => { scaleStyles = !scaleStyles; } }], e.currentTarget as HTMLElement);
  });

  function makeUnitSel() {
    const opts = unitOptions(ALL_UNITS).map(o => ({ ...o, disabled: !resample && (o.value === 'px' || o.value === '%') }));
    return select(opts, unit, u => { unit = u; rebuildUnits(); sync(); }, { width: 120, title: 'Units' });
  }
  function rebuildUnits() {
    const nw = makeUnitSel(), nh = makeUnitSel();
    wUnit.replaceWith(nw); hUnit.replaceWith(nh); wUnit = nw; hUnit = nh;
  }
  const clampPx = (v: number) => Math.max(1, Math.min(MAX_PX, v));
  function custom() { preset = 'custom'; presetSel.setValue('custom'); }

  function setDim(which: 'w' | 'h', v: number, final: boolean) {
    if (!(v > 0)) { if (final) sync(); return; }
    if (resample) {
      if (which === 'w') { tW = clampPx(pxFrom(v, unit, res, W0)); if (constrain) tH = clampPx(tW * H0 / W0); }
      else { tH = clampPx(pxFrom(v, unit, res, H0)); if (constrain) tW = clampPx(tH * W0 / H0); }
    } else {
      // pixel count is fixed: the physical size changes the resolution
      const inches = toPx(v, unit, 1) ;
      if (inches > 0) res = Math.max(0.01, (which === 'w' ? W0 : H0) / inches);
    }
    custom();
    sync(which);
  }
  function setRes(v: number) {
    const ppi = resUnit === 'ppcm' ? v * 2.54 : v;
    if (!(ppi > 0)) { sync(); return; }
    if (resample) { const k = ppi / res; tW = clampPx(tW * k); tH = clampPx(tH * k); }
    res = Math.min(30000, ppi);
    custom(); sync();
  }
  async function applyPreset(v: string) {
    if (v === 'original') { tW = W0; tH = H0; res = res0; preset = v; sync(); return; }
    if (v === 'auto') {
      const r = await autoResolution();
      presetSel.setValue(preset);
      if (r) setRes(resUnit === 'ppcm' ? r / 2.54 : r);
      return;
    }
    const p = PRESETS.find(x => x.label === v);
    if (!p) return;
    const long = Math.max(p.w, p.h), short = Math.min(p.w, p.h);
    const [bw, bh] = W0 >= H0 ? [long, short] : [short, long];
    res = p.res; resample = true; constrain = true;
    resampleCb.setValue(true); chainBtn.classList.add('active');
    const k = Math.min(toPx(bw, p.unit, res) / W0, toPx(bh, p.unit, res) / H0);
    tW = clampPx(W0 * k); tH = clampPx(H0 * k);
    unit = p.unit;
    preset = v;
    rebuildUnits(); sync();
  }

  function sync(editing?: 'w' | 'h') {
    const pw = Math.round(tW), ph = Math.round(tH);
    const now = docBytes(doc, pw, ph), was = docBytes(doc);
    sizeLbl.replaceChildren('Image Size: ', h('b', null, fmtBytes(now)), pw !== W0 || ph !== H0 ? h('span.imgd-note', null, ` (was ${fmtBytes(was)})`) : '');
    const f = (px: number, ref: number) => {
      if (dimUnit === 'px') return `${Math.round(px)} px`;
      const v = pxFrom(1, 'px', res, ref) && (px / (dimUnit === '%' ? ref / 100 : toPx(1, dimUnit, res)));
      return `${Math.round(v * 100) / 100}${dimUnit === '%' ? '%' : ' ' + (dimUnit === 'pica' ? 'picas' : dimUnit)}`;
    };
    dimLbl.textContent = `${f(pw, W0)} × ${f(ph, H0)}`;
    if (editing !== 'w') showIn(wIn, resample ? tW : W0, unit, res, W0);
    if (editing !== 'h') showIn(hIn, resample ? tH : H0, unit, res, H0);
    resIn.show(resUnit === 'ppcm' ? res / 2.54 : res, 2);
    wUnit.setValue(unit); hUnit.setValue(unit);
    chainBtn.replaceChildren(icon(constrain ? 'link-v' : 'link-v-broken', 16));
    chainBtn.classList.toggle('active', constrain);
    chain.classList.toggle('off', !constrain);
    chainBtn.disabled = !resample;
    methodSel.style.visibility = resample ? '' : 'hidden';
    methodSel.setValue(method);
    const m = resolveMethod(method, pw * ph > W0 * H0);
    noiseRow.style.display = resample && (m === 'preserve') ? '' : 'none';
    presetSel.setValue(preset);
    schedulePreview();
  }

  // ---------------------------------------------------------------- preview
  const src = renderLayersToCanvas(doc, doc.layers);
  const pv = createCanvas(300, 300);
  const box = h('div.imgd-prev-box', { title: 'Drag to view a different part of the image' }, pv);
  let pcx = W0 / 2, pcy = H0 / 2, pz = 1, timer = 0;
  const zoomLbl = h('span', null, '100%');
  const zoomBy = (k: number) => { pz = Math.max(0.0625, Math.min(8, pz * k)); zoomLbl.textContent = Math.round(pz * 1000) / 10 + '%'; schedulePreview(0); };
  function schedulePreview(delay = 40) { clearTimeout(timer); timer = window.setTimeout(renderPreview, delay); }
  function renderPreview() {
    const sx = (resample ? tW : W0) / W0, sy = (resample ? tH : H0) / H0;
    const rw = Math.min(W0, Math.ceil(300 / pz / sx) + 2), rh = Math.min(H0, Math.ceil(300 / pz / sy) + 2);
    pcx = Math.max(rw / 2, Math.min(W0 - rw / 2, pcx)); pcy = Math.max(rh / 2, Math.min(H0 - rh / 2, pcy));
    const x0 = Math.max(0, Math.round(pcx - rw / 2)), y0 = Math.max(0, Math.round(pcy - rh / 2));
    let region = ctx2d(src).getImageData(x0, y0, rw, rh), w = rw, hh = rh;
    const dw = Math.max(1, Math.round(rw * sx)), dh = Math.max(1, Math.round(rh * sy));
    const px = ctx2d(pv);
    px.setTransform(1, 0, 0, 1, 0, 0);
    px.clearRect(0, 0, 300, 300);
    let out: ImageData;
    if (resample) {
      if (w * hh > 1.6e6 && dw * dh * 4 < w * hh) {   // big reduction: pre-shrink on the GPU first
        const t = createCanvas(dw * 2, dh * 2), tx = ctx2d(t);
        tx.imageSmoothingQuality = 'high';
        tx.drawImage(src, x0, y0, rw, rh, 0, 0, t.width, t.height);
        region = tx.getImageData(0, 0, t.width, t.height); w = t.width; hh = t.height;
      }
      out = new ImageData(resamplePixels(region.data, w, hh, dw, dh, method, { noise }) as any, dw, dh);
    } else out = region;
    const tmp = createCanvas(out.width, out.height);
    ctx2d(tmp).putImageData(out, 0, 0);
    px.imageSmoothingEnabled = pz < 1;
    const ox = 150 - ((pcx - x0) * sx) * pz, oy = 150 - ((pcy - y0) * sy) * pz;
    px.drawImage(tmp, ox, oy, out.width * pz, out.height * pz);
  }
  box.addEventListener('pointerdown', e => {
    e.preventDefault();
    const cx0 = pcx, cy0 = pcy;
    const sx = (resample ? tW : W0) / W0, sy = (resample ? tH : H0) / H0;
    box.classList.add('drag');
    dragPointer(e, (dx, dy) => { pcx = cx0 - dx / (pz * sx); pcy = cy0 - dy / (pz * sy); schedulePreview(0); }, () => box.classList.remove('drag'));
  });
  box.addEventListener('wheel', e => { e.preventDefault(); zoomBy(e.deltaY < 0 ? 2 : 0.5); }, { passive: false });

  // ---------------------------------------------------------------- layout
  const lbl = (t: string) => h('span.imgd-lbl', null, t);
  const body = h('div.imgd-size', null,
    h('div.imgd-prev', null, box,
      h('div.imgd-prev-zoom', null, iconButton('zoom-out', 'Zoom out', () => zoomBy(0.5), { size: 14 }), zoomLbl, iconButton('zoom-in', 'Zoom in', () => zoomBy(2), { size: 14 }))),
    h('div.imgd-size-right', null,
      h('div.imgd-size-head', null, sizeLbl, gear),
      h('div.imgd-inline', null, lbl('Dimensions:'), h('div.imgd-dim', null, dimSel, dimLbl)),
      h('div.imgd-inline', null, lbl('Fit To:'), presetSel),
      h('div.imgd-link', null, chain, h('div.imgd-link-rows', null,
        h('div.imgd-inline', null, h('span.imgd-lbl', { style: { minWidth: '48px' } }, 'Width:'), wIn, wUnit),
        h('div.imgd-inline', null, h('span.imgd-lbl', { style: { minWidth: '48px' } }, 'Height:'), hIn, hUnit))),
      h('div.imgd-inline', null, lbl('Resolution:'), resIn, resUnitSel),
      h('div.imgd-inline', { style: { paddingLeft: '10px' } }, resampleCb, methodSel),
      noiseRow));
  // the unit selects are recreated: keep references inside the rows up to date
  sync();

  // Alt turns Cancel into Reset (like Photoshop)
  let alt = false;
  const dlg = openDialog({
    title: 'Image Size', body, className: 'imgd-dialog',
    buttons: [
      { label: 'OK', primary: true, value: 'ok' },
      { label: 'Cancel', value: null, onClick: () => { if (alt) { tW = W0; tH = H0; res = res0; preset = 'original'; sync(); return false; } } },
    ],
  });
  const cancelBtn = dlg.el.querySelectorAll('.dialog-buttons .btn')[1] as HTMLElement;
  const onAlt = (e: KeyboardEvent) => { alt = e.altKey; cancelBtn.textContent = alt ? 'Reset' : 'Cancel'; if (e.key === 'Alt') e.preventDefault(); };
  window.addEventListener('keydown', onAlt); window.addEventListener('keyup', onAlt);
  const r = await dlg.result;
  window.removeEventListener('keydown', onAlt); window.removeEventListener('keyup', onAlt);
  clearTimeout(timer);
  Object.assign(S, { unit, dimUnit, resample, method, constrain, scaleStyles, noise }); S.save();
  if (r !== 'ok') return;
  const nw = Math.round(resample ? tW : W0), nh = Math.round(resample ? tH : H0);
  if (nw === W0 && nh === H0 && Math.abs(res - res0) < 1e-9) { doc.resolutionUnit = resUnit; docChanged(doc); return; }
  document.body.classList.add('busy');
  await new Promise(requestAnimationFrame);
  await new Promise(r2 => setTimeout(r2, 0));
  try {
    doc.history.transaction('Image Size', () => imageSize(doc, nw, nh, res, resample ? method : null, { noise, scaleStyles }), 'image');
    doc.resolutionUnit = resUnit;
    docChanged(doc);
  } finally { document.body.classList.remove('busy'); }
}

export const UNIT_NAMES = UNIT_LABELS;
