// File menu commands: New, Open / Open As / Open as Smart Object / Open Recent, Close / Close All / Close Others
// (with the unsaved-changes prompt), Save / Save As / Save a Copy (.pxd, .psd, PNG, JPEG, WebP), Revert, Export
// (Quick Export, Export As, Save for Web, Layers to Files, Export as PSD), Place Embedded / Linked, Import (clipboard,
// device), File Info, Print / Print One Copy, Exit, and drag-and-drop of files onto the window.
import './file.css';
import { app } from '../../core/app';
import { events } from '../../core/events';
import { PixDocument, type DocState } from '../../core/document';
import { registerCommands } from '../../core/commands';
import { canvasFromBlob, createCanvas, ctx2d } from '../../core/canvas';
import { hooks } from '../../core/registry';
import { h } from '../../ui/dom';
import { confirmDialog, openDialog } from '../../ui/dialog';
import { checkbox, numberField, select, textField } from '../../ui/widgets';
import { toast } from '../../ui/toast';
import type { MenuEntry } from '../../ui/menu';
import { SmartObjectLayer } from '../../layers/smart-object';
import { RasterLayer, type Layer } from '../../core/layer';
import { xp } from '../prefs/store';
import { baseName, extOf, FORMAT_INFO, OPEN_ACCEPT, readAnyFile, svgToCanvas, writeDocument, writePSD, type SaveFormat } from './formats';
import { addRecent, chooseSaveTarget, clearRecent, downloadBlob, getRecent, pickFiles, recentList, saveTargetOf, setSaveTarget, writeTarget } from './io';
import { newDocumentDialog } from './new-doc';
import { exportAsDialog, layersToFiles, quickExport } from './export';

const D = () => app.activeDoc;
const hasDoc = () => !!app.activeDoc;

// ------------------------------------------------------------------ saved state (Revert / modified flag)
const savedState = new WeakMap<PixDocument, DocState>();
const markSaved = (doc: PixDocument) => { savedState.set(doc, doc.captureState(true)); doc.modified = false; events.emit('docs'); events.emit('history', doc); };
events.on('docs', () => { for (const d of app.docs) if (!savedState.has(d)) savedState.set(d, d.captureState(true)); });

// ------------------------------------------------------------------ open
export async function openBlob(blob: Blob, name: string, opts: { smart?: boolean; recent?: boolean } = {}): Promise<PixDocument | null> {
  try {
    let doc: PixDocument;
    if (opts.smart) {
      const c = await flatCanvasOf(blob, name);
      doc = new PixDocument(c.width, c.height, baseName(name));
      const l = SmartObjectLayer.fromCanvas(c, baseName(name));
      doc.layers = [l]; doc.relink(); doc.activeLayerId = l.id; doc.selectedIds = [l.id];
      doc.history.baseName = 'Open';
      doc.history.snapshots = [{ name: doc.name, state: doc.captureState(true) }];
    } else doc = await readAnyFile(blob, name);
    const ext = extOf(name);
    const fmt: SaveFormat | null = ext === 'pxd' ? 'pxd' : ext === 'psd' ? 'psd' : ext === 'png' ? 'png' : ext === 'jpg' || ext === 'jpeg' ? 'jpeg' : ext === 'webp' ? 'webp' : null;
    if (fmt && !opts.smart) setSaveTarget(doc, { name, format: fmt });
    app.addDocument(doc);
    markSaved(doc);
    if (opts.recent !== false) void addRecent(name, blob);
    return doc;
  } catch (err: any) {
    console.error(err);
    toast(`Could not open “${name}” because ${err?.message ? err.message.replace(/\.$/, '').toLowerCase() : 'the file is not a supported format'}.`, 'error', 4200);
    return null;
  }
}
/** Flattened canvas of any supported file (for Place / Smart Objects / stacks). */
export async function flatCanvasOf(blob: Blob, name: string): Promise<HTMLCanvasElement> {
  const ext = extOf(name);
  if (ext === 'svg' || blob.type === 'image/svg+xml') return svgToCanvas(blob);
  if (ext === 'pxd' || ext === 'psd' || ext === 'psb') { const d = await readAnyFile(blob, name); return d.flattenedCanvas(); }
  return canvasFromBlob(blob);
}
async function openFiles(opts: { smart?: boolean } = {}) {
  const files = await pickFiles(OPEN_ACCEPT, true);
  for (const f of files) await openBlob(f, f.name, opts);
}

// ------------------------------------------------------------------ close
/** Returns false when the user cancelled. */
export async function closeDocument(doc: PixDocument): Promise<boolean> {
  if (doc.modified) {
    app.setActiveDocument(doc);
    const r = await confirmDialog('Pixora', `Save changes to the Pixora document “${doc.name}” before closing?`, [
      { label: 'Yes', primary: true, value: 'yes' }, { label: 'No', value: 'no' }, { label: 'Cancel', value: 'cancel' },
    ]);
    if (r === 'cancel' || r === null) return false;
    if (r === 'yes' && !(await save(doc))) return false;
  }
  app.removeDocument(doc);
  return true;
}
async function closeMany(list: PixDocument[]) { for (const d of [...list]) if (!(await closeDocument(d))) return false; return true; }

// ------------------------------------------------------------------ save
const SAVE_FORMATS: SaveFormat[] = ['pxd', 'psd', 'png', 'jpeg', 'webp'];
/** JPEG / WebP quality prompt (Photoshop's JPEG Options). */
async function qualityFor(fmt: SaveFormat): Promise<number | null> {
  if (fmt !== 'jpeg' && fmt !== 'webp') return 0.92;
  let q = Number(localStorage.getItem('pixora.jpegQuality') || 10);
  const label = () => (q >= 10 ? 'Maximum' : q >= 8 ? 'High' : q >= 5 ? 'Medium' : 'Low');
  const lab = h('span.fl-qlab', null, label());
  const f = numberField(q, v => { q = v; lab.textContent = label(); }, { min: 0, max: 12, width: 50, title: 'Quality (0–12)' });
  const body = h('div.form', null, h('div.form-row', null, h('label.form-label', null, 'Quality:'), f, lab));
  const r = await openDialog({ title: fmt === 'jpeg' ? 'JPEG Options' : 'WebP Options', body, buttons: [{ label: 'OK', primary: true, value: 'ok' }, { label: 'Cancel', value: null }] }).result;
  if (r !== 'ok') return null;
  localStorage.setItem('pixora.jpegQuality', String(q));
  return Math.max(0.05, Math.min(1, q / 12));
}
/** Name + format dialog used when the browser has no native save picker. */
async function saveAsDialog(doc: PixDocument, title: string): Promise<{ name: string; format: SaveFormat } | null> {
  const cur = saveTargetOf(doc);
  let fmt: SaveFormat = cur?.format || 'pxd';
  let name = baseName(cur?.name || doc.name);
  const body = h('div.form', null,
    h('div.form-row', null, h('label.form-label', null, 'File name:'), textField(name, v => { name = v; }, { width: 240 })),
    h('div.form-row', null, h('label.form-label', null, 'Save as type:'), select<SaveFormat>(SAVE_FORMATS.map(f => ({ value: f, label: FORMAT_INFO[f].label })), fmt, v => { fmt = v; }, { width: 240 })),
    h('div.fl-note', null, fmt === 'pxd' || fmt === 'psd' ? '' : 'Flat formats merge all layers into one image.'));
  const r = await openDialog({ title, body, buttons: [{ label: 'Save', primary: true, value: 'ok' }, { label: 'Cancel', value: null }] }).result;
  if (r !== 'ok') return null;
  return { name: `${(name || doc.name).trim()}.${FORMAT_INFO[fmt].ext}`, format: fmt };
}
async function saveAs(doc: PixDocument, copy = false): Promise<boolean> {
  const suggested = `${baseName(saveTargetOf(doc)?.name || doc.name)}${copy ? ' copy' : ''}.${FORMAT_INFO[saveTargetOf(doc)?.format || 'pxd'].ext}`;
  let target = typeof (window as any).showSaveFilePicker === 'function' && window.isSecureContext ? await chooseSaveTarget(suggested, SAVE_FORMATS) : null;
  if (!target) {
    if (typeof (window as any).showSaveFilePicker === 'function' && window.isSecureContext) return false;   // cancelled native dialog
    const r = await saveAsDialog(doc, copy ? 'Save a Copy' : 'Save As');
    if (!r) return false;
    target = r;
  }
  const q = await qualityFor(target.format);
  if (q === null) return false;
  try {
    const blob = await writeDocument(doc, target.format, q);
    await writeTarget(target, blob);
    if (!copy) {
      setSaveTarget(doc, target);
      doc.name = baseName(target.name);
      markSaved(doc);
    }
    void addRecent(target.name, blob);
    toast(`Saved ${target.name} (${Math.max(1, Math.round(blob.size / 1024))} KB)`, 'success');
    return true;
  } catch (err: any) {
    console.error(err);
    toast(`Could not save “${target.name}”: ${err?.message || 'write error'}.`, 'error', 4200);
    return false;
  }
}
export async function save(doc: PixDocument): Promise<boolean> {
  const t = saveTargetOf(doc);
  if (!t) return saveAs(doc);
  if (!t.handle) return saveAs(doc);            // downloads cannot overwrite: behave like Save As
  const q = t.format === 'jpeg' || t.format === 'webp' ? Math.max(0.05, Number(localStorage.getItem('pixora.jpegQuality') || 10) / 12) : 0.92;
  try {
    const blob = await writeDocument(doc, t.format, q);
    await writeTarget(t, blob);
    markSaved(doc);
    void addRecent(t.name, blob);
    toast(`Saved ${t.name}`, 'success', 1600);
    return true;
  } catch (err: any) {
    console.error(err);
    toast(`Could not save “${t.name}”: ${err?.message || 'write error'}.`, 'error', 4200);
    return false;
  }
}

function revert(doc: PixDocument) {
  const s = savedState.get(doc);
  if (!s) return;
  doc.history.transaction('Revert', () => doc.restoreState(s, true));
  doc.modified = false;
  events.emit('docs');
}

// ------------------------------------------------------------------ place
/** Place a file as a smart object layer above the active layer, fitted inside the canvas, then Free Transform. */
export async function placeFile(doc: PixDocument, blob: Blob, name: string, linked = false, at?: { x: number; y: number }) {
  let c: HTMLCanvasElement;
  try { c = await flatCanvasOf(blob, name); } catch { toast(`Could not place “${name}” because the file is not a supported format.`, 'error'); return; }
  // Preferences › General: Resize Image During Place, Always Create Smart Objects, Skip Transform when Placing
  const k = xp.resizeOnPlace ? Math.min(1, doc.width / c.width, doc.height / c.height) : 1;
  const w = c.width * k, hh = c.height * k;
  const cx = at?.x ?? doc.width / 2, cy = at?.y ?? doc.height / 2;
  let l: Layer;
  if (xp.placeAsSmart || linked) {
    const so = SmartObjectLayer.fromCanvas(c, baseName(name));
    so.matrix = [k, 0, 0, k, Math.round(cx - w / 2), Math.round(cy - hh / 2)];
    if (linked) (so as any).linkedFile = name;
    l = so;
  } else {
    const r = new RasterLayer(Math.max(1, Math.round(w)), Math.max(1, Math.round(hh)), baseName(name));
    const rx = r.canvas.getContext('2d')!; rx.imageSmoothingQuality = 'high'; rx.drawImage(c, 0, 0, r.canvas.width, r.canvas.height);
    r.x = Math.round(cx - w / 2); r.y = Math.round(cy - hh / 2);
    l = r;
  }
  doc.history.transaction(linked ? 'Place Linked' : 'Place Embedded', () => { doc.addLayer(l, { above: doc.activeLayer, select: true }); });
  doc.layersChanged();
  if (!xp.skipTransformPlace) hooks.startFreeTransform();
}
async function placeCmd(arg?: { blob?: Blob; name?: string }, linked = false) {
  const doc = D();
  if (!doc) return;
  if (arg?.blob) { await placeFile(doc, arg.blob, arg.name || 'Placed Image', linked); return; }
  const [f] = await pickFiles(OPEN_ACCEPT);
  if (f) await placeFile(doc, f, f.name, linked);
}

// ------------------------------------------------------------------ import
async function clipboardImage(): Promise<Blob | null> {
  try {
    const items = await (navigator.clipboard as any).read();
    for (const it of items) { const t = it.types.find((x: string) => x.startsWith('image/')); if (t) return await it.getType(t); }
  } catch { /* permission / unsupported */ }
  return null;
}
async function importClipboard() {
  const b = await clipboardImage();
  if (!b) { toast('There is no image on the clipboard (or clipboard access was denied).', 'error'); return; }
  await openBlob(b, `Clipboard.${b.type.split('/')[1] || 'png'}`, { recent: false });
}

// ------------------------------------------------------------------ File Info
const INFO_FIELDS: [string, string, boolean?][] = [
  ['title', 'Document Title'], ['author', 'Author'], ['authorTitle', 'Author Title'], ['description', 'Description', true],
  ['rating', 'Rating'], ['keywords', 'Keywords'], ['copyrightStatus', 'Copyright Status'], ['copyright', 'Copyright Notice', true], ['copyrightUrl', 'Copyright Info URL'],
];
async function fileInfo(doc: PixDocument) {
  const v: Record<string, string> = { ...doc.meta };
  const body = h('div.form.fl-info');
  for (const [k, label, multi] of INFO_FIELDS) {
    let ctl: HTMLElement;
    if (k === 'copyrightStatus') ctl = select([{ value: 'unknown', label: 'Unknown' }, { value: 'copyrighted', label: 'Copyrighted' }, { value: 'public', label: 'Public Domain' }], v[k] || 'unknown', x => { v[k] = x; }, { width: 180 });
    else if (k === 'rating') ctl = select(['0', '1', '2', '3', '4', '5'].map(x => ({ value: x, label: x === '0' ? 'None' : '★'.repeat(+x) })), v[k] || '0', x => { v[k] = x; }, { width: 120 });
    else if (multi) { const t = h('textarea.field.fl-area', { rows: 3 }, v[k] || '') as HTMLTextAreaElement; t.addEventListener('input', () => { v[k] = t.value; }); t.addEventListener('keydown', e => e.stopPropagation()); ctl = t; }
    else ctl = textField(v[k] || '', x => { v[k] = x; }, { width: 300 });
    body.append(h('div.form-row', null, h('label.form-label', null, label + ':'), ctl));
  }
  body.append(h('div.fl-note', null, `${doc.width} × ${doc.height} px · ${doc.resolution} ${doc.resolutionUnit} · ${doc.mode} ${doc.bitDepth}-bit · ${doc.allLayers().length} layer(s)`));
  const r = await openDialog({ title: doc.name, body, buttons: [{ label: 'OK', primary: true, value: 'ok' }, { label: 'Cancel', value: null }] }).result;
  if (r !== 'ok') return;
  doc.history.transaction('File Info', () => { doc.meta = { ...v }; });
}

// ------------------------------------------------------------------ Print
function printCanvas(doc: PixDocument, scalePct = 100, center = true) {
  const ppi = doc.resolutionUnit === 'ppcm' ? doc.resolution * 2.54 : doc.resolution;
  const wIn = ((doc.width / ppi) * scalePct) / 100, hIn = ((doc.height / ppi) * scalePct) / 100;
  const url = doc.flattenedCanvas().toDataURL('image/png');
  const frame = h('iframe', { style: { position: 'fixed', width: '0', height: '0', border: '0', left: '-10px', top: '-10px' } }) as HTMLIFrameElement;
  document.body.append(frame);
  const d = frame.contentDocument!;
  d.open();
  d.write(`<!doctype html><title>${doc.name}</title><style>@page{margin:0.5in}html,body{margin:0}body{display:flex;${center ? 'justify-content:center;align-items:center;min-height:100vh' : ''}}img{width:${wIn}in;height:${hIn}in;max-width:100%;max-height:100vh;object-fit:contain}</style><img src="${url}">`);
  d.close();
  const img = d.querySelector('img')!;
  const go = () => { frame.contentWindow!.focus(); frame.contentWindow!.print(); setTimeout(() => frame.remove(), 1000); };
  if (img.complete) setTimeout(go, 50); else img.onload = () => setTimeout(go, 50);
}
async function printDialog(doc: PixDocument) {
  const v = { scale: 100, fit: false, center: true };
  const ppi = doc.resolutionUnit === 'ppcm' ? doc.resolution * 2.54 : doc.resolution;
  const pv = createCanvas(220, 280); pv.className = 'fl-print-pv';
  const drawPv = () => {
    const x = ctx2d(pv), pageW = 8.5, pageH = 11, k = Math.min(200 / pageW, 260 / pageH);
    x.fillStyle = '#3a3a3a'; x.fillRect(0, 0, 220, 280);
    const pw = pageW * k, ph = pageH * k, ox = (220 - pw) / 2, oy = (280 - ph) / 2;
    x.fillStyle = '#fff'; x.fillRect(ox, oy, pw, ph);
    let iw = (doc.width / ppi) * (v.scale / 100) * k, ih = (doc.height / ppi) * (v.scale / 100) * k;
    const maxW = pw - k, maxH = ph - k;
    if (v.fit || iw > maxW || ih > maxH) { const s = Math.min(maxW / iw, maxH / ih); iw *= s; ih *= s; }
    x.drawImage(doc.getComposite(), v.center ? ox + (pw - iw) / 2 : ox + k / 2, v.center ? oy + (ph - ih) / 2 : oy + k / 2, iw, ih);
  };
  const scale = numberField(100, s => { v.scale = s; drawPv(); }, { min: 1, max: 1000, unit: '%', decimals: 2, width: 70, title: 'Print scale' });
  const body = h('div.fl-print', null, pv, h('div.form', null,
    h('div.fl-sec', null, 'Position and Size'),
    h('div.form-row', null, h('label.form-label', null, ''), checkbox('Center', true, c => { v.center = c; drawPv(); })),
    h('div.form-row', null, h('label.form-label', null, 'Scale:'), scale),
    h('div.form-row', null, h('label.form-label', null, ''), checkbox('Scale to Fit Media', false, c => { v.fit = c; drawPv(); })),
    h('div.fl-note', null, `Print size: ${(doc.width / ppi).toFixed(2)} × ${(doc.height / ppi).toFixed(2)} in at ${Math.round(ppi)} ppi`)));
  drawPv();
  const r = await openDialog({ title: 'Pixora Print Settings', body, layout: 'side', buttons: [{ label: 'Print', primary: true, value: 'ok' }, { label: 'Cancel', value: null }] }).result;
  if (r === 'ok') printCanvas(doc, v.fit ? 10000 : v.scale, v.center);
}

// ------------------------------------------------------------------ recent menu
function recentMenu(): MenuEntry[] {
  const list = recentList();
  if (!list.length) return [{ label: '(No recent files)', enabled: false }];
  return [
    ...list.map((r, i) => ({ label: `${i + 1} ${r.name}`, action: async () => {
      const e = await getRecent(r.id);
      if (!e) { toast(`Could not reopen “${r.name}” because its contents are no longer stored. Use Open... instead.`, 'error', 4000); return; }
      await openBlob(e.blob, e.name);
    } } as MenuEntry)),
    '-',
    { label: 'Clear Recent File List', action: () => void clearRecent() },
  ];
}

// ------------------------------------------------------------------ drag & drop files
window.addEventListener('dragover', e => { if (e.dataTransfer?.types.includes('Files')) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; } });
window.addEventListener('drop', async e => {
  const files = Array.from(e.dataTransfer?.files || []);
  if (!files.length) return;
  e.preventDefault();
  const ov = document.querySelector('.view-overlay') as HTMLElement | null;
  const doc = D(), v = app.viewport;
  const r = ov?.getBoundingClientRect();
  const overCanvas = !!(doc && r && v && e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom && !document.body.classList.contains('show-home'));
  for (const f of files) {
    if (overCanvas && doc && v && r) { const p = v.screenToDoc(e.clientX - r.left, e.clientY - r.top); await placeFile(doc, f, f.name, false, p); }
    else await openBlob(f, f.name);
  }
});
window.addEventListener('beforeunload', e => { if (app.docs.some(d => d.modified)) { e.preventDefault(); e.returnValue = ''; } });

// ------------------------------------------------------------------ commands
registerCommands([
  { id: 'file.new', label: 'New...', run: (arg?: any) => newDocumentDialog(arg) },
  { id: 'file.open', label: 'Open...', run: () => openFiles() },
  { id: 'file.openAs', label: 'Open As...', run: () => openFiles() },
  { id: 'file.openAsSmart', label: 'Open as Smart Object...', run: () => openFiles({ smart: true }) },
  { id: 'file.recentList', run: () => recentMenu() },
  { id: 'file.close', label: 'Close', enabled: hasDoc, run: () => { const d = D(); if (d) void closeDocument(d); } },
  { id: 'file.closeAll', label: 'Close All', enabled: hasDoc, run: () => closeMany(app.docs) },
  { id: 'file.closeOthers', label: 'Close Others', enabled: () => app.docs.length > 1, run: () => closeMany(app.docs.filter(d => d !== D())) },
  { id: 'file.save', label: 'Save', enabled: hasDoc, run: () => { const d = D(); if (d) void save(d); } },
  { id: 'file.saveAs', label: 'Save As...', enabled: hasDoc, run: () => { const d = D(); if (d) void saveAs(d); } },
  { id: 'file.saveCopy', label: 'Save a Copy...', enabled: hasDoc, run: () => { const d = D(); if (d) void saveAs(d, true); } },
  { id: 'file.revert', label: 'Revert', enabled: () => !!D()?.modified, run: () => { const d = D(); if (d) revert(d); } },
  { id: 'file.quickExport', label: 'Quick Export as PNG', enabled: hasDoc, run: () => { const d = D(); if (d) void quickExport(d); } },
  { id: 'file.exportAs', label: 'Export As...', enabled: hasDoc, run: () => { const d = D(); if (d) void exportAsDialog(d); } },
  { id: 'file.saveForWeb', label: 'Save for Web (Legacy)...', enabled: hasDoc, run: () => { const d = D(); if (d) void exportAsDialog(d, true); } },
  { id: 'file.layersToFiles', label: 'Layers to Files...', enabled: hasDoc, run: () => { const d = D(); if (d) void layersToFiles(d); } },
  { id: 'file.exportPSD', label: 'Export as PSD...', enabled: hasDoc, run: async () => { const d = D(); if (!d) return; const b = await writePSD(d); downloadBlob(b, `${baseName(d.name)}.psd`); toast(`Exported ${baseName(d.name)}.psd`, 'success'); } },
  { id: 'file.placeEmbedded', label: 'Place Embedded...', enabled: hasDoc, run: (arg?: any) => placeCmd(arg, false) },
  { id: 'file.placeLinked', label: 'Place Linked...', enabled: hasDoc, run: (arg?: any) => placeCmd(arg, true) },
  { id: 'file.importClipboard', label: 'Images from Clipboard', run: importClipboard },
  { id: 'file.importDevice', label: 'Images from Device...', run: async () => { for (const f of await pickFiles('image/*', true, true)) await openBlob(f, f.name); } },
  { id: 'file.info', label: 'File Info...', enabled: hasDoc, run: () => { const d = D(); if (d) void fileInfo(d); } },
  { id: 'file.print', label: 'Print...', enabled: hasDoc, run: () => { const d = D(); if (d) void printDialog(d); } },
  { id: 'file.printOne', label: 'Print One Copy', enabled: hasDoc, run: () => { const d = D(); if (d) printCanvas(d); } },
  { id: 'file.exit', label: 'Exit', run: () => closeMany(app.docs) },
]);
