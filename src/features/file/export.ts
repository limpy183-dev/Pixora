// File > Export > Export As... / Save for Web (Legacy) / Quick Export as PNG / Layers to Files.
// Export As: format (PNG / JPEG / WebP), quality, transparency or matte, image size (W/H linked, scale %),
// resample method, extra scale variants with suffixes (1x, 2x…), live preview with file-size estimate.
import type { PixDocument } from '../../core/document';
import { GroupLayer, type Layer } from '../../core/layer';
import { alphaBounds, createCanvas, cropCanvas, ctx2d } from '../../core/canvas';
import { renderLayersToCanvas } from '../../core/compositor';
import type { RGB } from '../../core/types';
import { h, clear } from '../../ui/dom';
import { openDialog } from '../../ui/dialog';
import { checkbox, colorSwatch, iconButton, numberField, select, slider, textField } from '../../ui/widgets';
import { toast } from '../../ui/toast';
import { resampleCanvas, RESAMPLE_LABELS, type ResampleMethod } from '../image/resample';
import { baseName, encodeImage, FORMAT_INFO } from './formats';
import { downloadBlob } from './io';
import { xp } from '../prefs/store';
import { exportCanvas as toExportSpace } from '../color-mgmt/color-settings';

type Fmt = 'png' | 'jpeg' | 'webp';
interface ExportOpts { fmt: Fmt; quality: number; transparent: boolean; matte: RGB; scale: number; method: ResampleMethod; extras: { scale: number; suffix: string }[]; metadata: boolean }
const opts: ExportOpts = (() => {
  const d: ExportOpts = { fmt: 'png', quality: 85, transparent: true, matte: { r: 255, g: 255, b: 255 }, scale: 100, method: 'bicubic', extras: [], metadata: false };
  try { return { ...d, ...JSON.parse(localStorage.getItem('pixora.exportAs') || '{}') }; } catch { return d; }
})();
const persist = () => { try { localStorage.setItem('pixora.exportAs', JSON.stringify(opts)); } catch { /* ignore */ } };

export const fmtSize = (b: number) => (b >= 1048576 ? `${(b / 1048576).toFixed(1)} MB` : b >= 1024 ? `${Math.round(b / 1024)} KB` : `${b} B`);

/** Scaled + matted canvas for export. */
export function exportCanvas(src: HTMLCanvasElement, o: Pick<ExportOpts, 'fmt' | 'transparent' | 'matte' | 'scale' | 'method'>, scale = o.scale): HTMLCanvasElement {
  const w = Math.max(1, Math.round((src.width * scale) / 100)), hh = Math.max(1, Math.round((src.height * scale) / 100));
  let c = w === src.width && hh === src.height ? src : resampleCanvas(src, w, hh, o.method);
  if (!o.transparent || o.fmt === 'jpeg') {
    const m = createCanvas(c.width, c.height), x = ctx2d(m);
    x.fillStyle = `rgb(${o.matte.r},${o.matte.g},${o.matte.b})`; x.fillRect(0, 0, m.width, m.height);
    x.drawImage(c, 0, 0);
    c = m;
  }
  return c;
}

export async function quickExport(doc: PixDocument) {
  // Preferences › Export: Quick Export format and quality
  const fmt = xp.quickFormat, ext = fmt === 'jpeg' ? 'jpg' : fmt;
  const blob = await encodeImage(toExportSpace(doc, doc.flattenedCanvas()), fmt, xp.quickQuality / 100);
  const file = `${baseName(doc.name)}.${xp.lowercaseExt ? ext : ext.toUpperCase()}`;
  downloadBlob(blob, file);
  toast(`Exported ${file} (${fmtSize(blob.size)})`, 'success');
}

export async function exportAsDialog(doc: PixDocument, legacy = false, source?: { canvas: HTMLCanvasElement; name: string }) {
  const srcC = toExportSpace(doc, source?.canvas || doc.flattenedCanvas());         // converted to sRGB for export
  const name0 = source?.name || baseName(doc.name);
  const o: ExportOpts = JSON.parse(JSON.stringify(opts));
  const PW = 460, PH = 340;
  const pv = createCanvas(PW, PH); pv.className = 'ex-preview';
  const sizeInfo = h('div.ex-size');
  const nameF = textField(name0, () => {}, { width: 180 });
  let zoomFit = true;
  const W0 = srcC.width, H0 = srcC.height;
  const wF = numberField(Math.round((W0 * o.scale) / 100), v => { o.scale = (v / W0) * 100; sync(); }, { min: 1, max: 30000, unit: 'px', width: 76, label: 'W:', title: 'Width in pixels' });
  const hF = numberField(Math.round((H0 * o.scale) / 100), v => { o.scale = (v / H0) * 100; sync(); }, { min: 1, max: 30000, unit: 'px', width: 76, label: 'H:', title: 'Height in pixels' });
  const scaleF = numberField(o.scale, v => { o.scale = v; sync(); }, { min: 1, max: 1000, unit: '%', decimals: 1, width: 64, label: 'Scale:', title: 'Scale of the exported image' });
  const methodF = select<ResampleMethod>(RESAMPLE_LABELS.map(([value, label]) => ({ value, label })), o.method, v => { o.method = v; sync(); }, { width: 170, title: 'Resample method' });
  const qF = slider(o.quality, 1, 100, v => { o.quality = v; qNum.setValue(v); schedule(); }, { width: 150 });
  const qNum = numberField(o.quality, v => { o.quality = v; qF.setValue(v); schedule(); }, { min: 1, max: 100, unit: '%', width: 50, title: 'Quality' });
  const qRow = h('div.form-row', null, h('label.form-label', null, 'Quality:'), qF, qNum);
  const trans = checkbox('Transparency', o.transparent, v => { o.transparent = v; sync(); }, { title: 'Keep transparent pixels (PNG / WebP)' });
  const matte = colorSwatch(o.matte, c => { o.matte = c; sync(); }, { title: 'Matte color used for transparent pixels' });
  const matteRow = h('div.form-row', null, h('label.form-label', null, 'Matte:'), matte);
  const fmtF = select<Fmt>([{ value: 'png', label: 'PNG' }, { value: 'jpeg', label: 'JPG' }, { value: 'webp', label: 'WebP' }], o.fmt, v => { o.fmt = v; sync(); }, { width: 110, title: 'File format' });
  const meta = checkbox('Include copyright info (file name only)', o.metadata, v => { o.metadata = v; }, { title: 'Append the copyright notice from File Info to the file name' });
  const extrasBox = h('div.ex-extras');
  const drawExtras = () => {
    clear(extrasBox);
    o.extras.forEach((e, i) => {
      extrasBox.append(h('div.ex-extra', null,
        numberField(e.scale, v => { e.scale = v; }, { min: 1, max: 1000, unit: 'x', decimals: 2, width: 58, title: 'Scale factor' }),
        textField(e.suffix, v => { e.suffix = v; }, { width: 70, placeholder: '@2x' }),
        iconButton('trash', 'Remove this size', () => { o.extras.splice(i, 1); drawExtras(); })));
    });
  };
  const addExtra = h('button.btn.ex-add', { type: 'button', title: 'Export an additional size (e.g. @2x for retina screens)' }, '+ Add Size');
  addExtra.addEventListener('click', () => { const n = o.extras.length + 2; o.extras.push({ scale: n, suffix: `@${n}x` }); drawExtras(); });
  drawExtras();

  let timer = 0, token = 0;
  const schedule = () => { clearTimeout(timer); timer = window.setTimeout(() => void render(), 120); };
  const render = async () => {
    const my = ++token;
    const c = exportCanvas(srcC, o);
    const blob = await encodeImage(c, o.fmt, o.quality / 100, o.matte);
    if (my !== token) return;
    const x = ctx2d(pv);
    x.clearRect(0, 0, PW, PH);
    // show the encoded result (JPEG / WebP artefacts visible)
    const bmp = await createImageBitmap(blob);
    const k = zoomFit ? Math.min(1, PW / bmp.width, PH / bmp.height) : 1;
    const w = bmp.width * k, hh = bmp.height * k;
    x.imageSmoothingQuality = 'high';
    x.drawImage(bmp, (PW - w) / 2, (PH - hh) / 2, w, hh);
    bmp.close();
    sizeInfo.textContent = `${c.width} x ${c.height} px · ${fmtSize(blob.size)} · ${o.fmt === 'jpeg' ? 'JPG' : o.fmt.toUpperCase()}`;
  };
  const sync = () => {
    wF.setValue(Math.round((W0 * o.scale) / 100)); hF.setValue(Math.round((H0 * o.scale) / 100)); scaleF.setValue(Math.round(o.scale * 10) / 10);
    qRow.style.display = o.fmt === 'png' ? 'none' : '';
    trans.style.display = o.fmt === 'jpeg' ? 'none' : '';
    matteRow.style.display = o.fmt === 'jpeg' || !o.transparent ? '' : 'none';
    schedule();
  };
  const zoomBtn = h('button.btn.ex-zoom', { type: 'button', title: 'Toggle fit / 100% preview' }, 'Fit');
  zoomBtn.addEventListener('click', () => { zoomFit = !zoomFit; zoomBtn.textContent = zoomFit ? 'Fit' : '100%'; schedule(); });
  const settings = h('div.ex-settings', null,
    h('div.ex-sec', null, 'File Settings'),
    h('div.form-row', null, h('label.form-label', null, 'Name:'), nameF),
    h('div.form-row', null, h('label.form-label', null, 'Format:'), fmtF),
    qRow, h('div.form-row', null, h('label.form-label', null, ''), trans), matteRow,
    h('div.ex-sec', null, 'Image Size'),
    h('div.form-row.ex-dims', null, wF, hF), h('div.form-row', null, scaleF),
    h('div.form-row', null, h('label.form-label', null, 'Resample:'), methodF),
    h('div.ex-sec', null, 'Additional Sizes'), extrasBox, addExtra,
    h('div.ex-sec', null, 'Metadata'), meta);
  const body = h('div.ex-body', null, settings, h('div.ex-view', null, pv, h('div.ex-bar', null, sizeInfo, zoomBtn)));
  sync();
  const dlg = openDialog({ title: legacy ? 'Save for Web (Legacy)' : 'Export As', body, className: 'ex-dialog', layout: 'side', buttons: [{ label: legacy ? 'Save...' : 'Export', primary: true, value: 'ok' }, { label: 'Cancel', value: null }] });
  const r = await dlg.result;
  token++;
  if (r !== 'ok') return;
  Object.assign(opts, o); persist();
  const nm = (nameF.getValue() || name0).trim();
  const copyright = o.metadata && doc.meta?.copyright ? ` (c) ${String(doc.meta.copyright).replace(/[\\/:*?"<>|]+/g, '')}` : '';
  const ext = FORMAT_INFO[o.fmt].ext;
  const main = await encodeImage(exportCanvas(srcC, o), o.fmt, o.quality / 100, o.matte);
  downloadBlob(main, `${nm}${copyright}.${ext}`);
  for (const e of o.extras) {
    const b = await encodeImage(exportCanvas(srcC, o, o.scale * e.scale), o.fmt, o.quality / 100, o.matte);
    downloadBlob(b, `${nm}${e.suffix || '@' + e.scale + 'x'}${copyright}.${ext}`);
  }
  toast(`Exported ${nm}.${ext}${o.extras.length ? ` and ${o.extras.length} more size${o.extras.length > 1 ? 's' : ''}` : ''}`, 'success');
}

// ------------------------------------------------------------------ Layers to Files
export async function layersToFiles(doc: PixDocument) {
  const v = { prefix: baseName(doc.name), fmt: 'png' as Fmt, visibleOnly: true, trim: false, quality: 90 };
  const body = h('div.form',
    null,
    h('div.form-row', null, h('label.form-label', null, 'File Name Prefix:'), textField(v.prefix, x => { v.prefix = x; }, { width: 200 })),
    h('div.form-row', null, h('label.form-label', null, 'File Type:'), select<Fmt>([{ value: 'png', label: 'PNG-24' }, { value: 'jpeg', label: 'JPEG' }, { value: 'webp', label: 'WebP' }], v.fmt, x => { v.fmt = x; }, { width: 120 })),
    h('div.form-row', null, h('label.form-label', null, 'Quality:'), numberField(v.quality, x => { v.quality = x; }, { min: 1, max: 100, unit: '%', width: 56 })),
    h('div.form-row', null, h('label.form-label', null, ''), checkbox('Visible Layers Only', v.visibleOnly, x => { v.visibleOnly = x; })),
    h('div.form-row', null, h('label.form-label', null, ''), checkbox('Trim Layers', v.trim, x => { v.trim = x; })));
  const r = await openDialog({ title: 'Export Layers To Files', body, buttons: [{ label: 'Run', primary: true, value: 'ok' }, { label: 'Cancel', value: null }] }).result;
  if (r !== 'ok') return;
  const leaves: Layer[] = [];
  const walk = (list: Layer[]) => { for (const l of list) { if (v.visibleOnly && !l.visible) continue; if (l instanceof GroupLayer) walk(l.children); else leaves.push(l); } };
  walk(doc.layers);
  let n = 0;
  for (const l of [...leaves].reverse()) {
    let c = renderLayersToCanvas(doc, [l]);
    if (v.trim) { const b = alphaBounds(c); if (!b) continue; c = cropCanvas(c, b); }
    const blob = await encodeImage(c, v.fmt, v.quality / 100);
    n++;
    const safe = l.name.replace(/[\\/:*?"<>|]+/g, '_');
    downloadBlob(blob, `${v.prefix}_${String(n).padStart(4, '0')}_${safe}.${FORMAT_INFO[v.fmt].ext}`);
    await new Promise(res => setTimeout(res, 120));   // browsers throttle bursts of downloads
  }
  toast(n ? `Exported ${n} layer${n > 1 ? 's' : ''}.` : 'No layers to export.', n ? 'success' : 'info');
}

