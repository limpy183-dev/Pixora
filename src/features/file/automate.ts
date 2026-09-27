// File > Automate / Scripts: Fit Image, Contact Sheet II, Crop and Straighten Photos, Image Processor,
// Load Files into Stack.
import { app } from '../../core/app';
import { PixDocument } from '../../core/document';
import { RasterLayer } from '../../core/layer';
import { registerCommands } from '../../core/commands';
import { createCanvas, ctx2d } from '../../core/canvas';
import { h } from '../../ui/dom';
import { openDialog } from '../../ui/dialog';
import { checkbox, numberField, select, textField } from '../../ui/widgets';
import { toast } from '../../ui/toast';
import { resampleCanvas } from '../image/resample';
import { docChanged, transformDocument } from '../image/ops';
import { baseName, encodeImage, FORMAT_INFO, OPEN_ACCEPT } from './formats';
import { downloadBlob, pickFiles } from './io';
import { flatCanvasOf } from './commands';

const D = () => app.activeDoc;
const row = (label: string, ...els: (HTMLElement | null)[]) => h('div.form-row', null, h('label.form-label', null, label), ...els);
const ok = async (title: string, body: HTMLElement, btn = 'OK') => (await openDialog({ title, body, buttons: [{ label: btn, primary: true, value: 'ok' }, { label: 'Cancel', value: null }] }).result) === 'ok';

// ------------------------------------------------------------------ Fit Image
async function fitImage() {
  const doc = D();
  if (!doc) return;
  const v = { w: doc.width, h: doc.height, noEnlarge: true };
  const body = h('div.form', null,
    h('div.fl-sec', null, 'Constrain Within'),
    row('Width:', numberField(v.w, x => { v.w = x; }, { min: 1, max: 300000, unit: 'px', width: 80 })),
    row('Height:', numberField(v.h, x => { v.h = x; }, { min: 1, max: 300000, unit: 'px', width: 80 })),
    row('', checkbox("Don't Enlarge", v.noEnlarge, x => { v.noEnlarge = x; })));
  if (!(await ok('Fit Image', body))) return;
  let k = Math.min(v.w / doc.width, v.h / doc.height);
  if (v.noEnlarge) k = Math.min(1, k);
  if (Math.abs(k - 1) < 1e-6) return;
  const W = Math.max(1, Math.round(doc.width * k)), H = Math.max(1, Math.round(doc.height * k));
  doc.history.transaction('Fit Image', () => transformDocument(doc, { w: W, h: H, m: new DOMMatrix().scale(W / doc.width, H / doc.height), resample: k < 1 ? 'bicubicSharper' : 'bicubicSmoother' }));
  docChanged(doc);
}

// ------------------------------------------------------------------ Contact Sheet II
async function contactSheet() {
  const files = await pickFiles(OPEN_ACCEPT, true);
  if (!files.length) return;
  const v = { w: 2480, h: 3508, res: 300, cols: 5, rows: 6, spacing: 30, captions: true, fontSize: 28, flatten: false, rotate: false };
  const body = h('div.form', null,
    h('div.fl-sec', null, `Document (${files.length} image${files.length > 1 ? 's' : ''})`),
    row('Width:', numberField(v.w, x => { v.w = x; }, { min: 100, max: 30000, unit: 'px', width: 80 })),
    row('Height:', numberField(v.h, x => { v.h = x; }, { min: 100, max: 30000, unit: 'px', width: 80 })),
    row('Resolution:', numberField(v.res, x => { v.res = x; }, { min: 1, max: 2400, width: 80 }), h('span', null, 'Pixels/Inch')),
    h('div.fl-sec', null, 'Thumbnails'),
    row('Columns:', numberField(v.cols, x => { v.cols = x; }, { min: 1, max: 40, width: 60 })),
    row('Rows:', numberField(v.rows, x => { v.rows = x; }, { min: 1, max: 40, width: 60 })),
    row('Spacing:', numberField(v.spacing, x => { v.spacing = x; }, { min: 0, max: 1000, unit: 'px', width: 70 })),
    row('', checkbox('Rotate For Best Fit', v.rotate, x => { v.rotate = x; })),
    row('', checkbox('Use Filename As Caption', v.captions, x => { v.captions = x; })),
    row('Font Size:', numberField(v.fontSize, x => { v.fontSize = x; }, { min: 4, max: 400, unit: 'px', width: 70 })),
    row('', checkbox('Flatten All Layers', v.flatten, x => { v.flatten = x; })));
  if (!(await ok('Contact Sheet II', body))) return;
  const per = v.cols * v.rows;
  const cellW = (v.w - v.spacing * (v.cols + 1)) / v.cols, cellH = (v.h - v.spacing * (v.rows + 1)) / v.rows;
  const capH = v.captions ? v.fontSize * 1.5 : 0;
  for (let page = 0; page * per < files.length; page++) {
    const doc = PixDocument.create(v.w, v.h, { name: `ContactSheet-${String(page + 1).padStart(3, '0')}`, resolution: v.res });
    const bg = doc.layers[0] as RasterLayer;
    for (let i = 0; i < per && page * per + i < files.length; i++) {
      const f = files[page * per + i];
      let c: HTMLCanvasElement;
      try { c = await flatCanvasOf(f, f.name); } catch { continue; }
      const cx = v.spacing + (i % v.cols) * (cellW + v.spacing), cy = v.spacing + Math.floor(i / v.cols) * (cellH + v.spacing);
      let src = c;
      const availH = cellH - capH;
      if (v.rotate && (c.width > c.height) !== (cellW > availH)) {
        src = createCanvas(c.height, c.width);
        const x = ctx2d(src); x.translate(c.height, 0); x.rotate(Math.PI / 2); x.drawImage(c, 0, 0);
      }
      const k = Math.min(cellW / src.width, availH / src.height);
      const w = Math.max(1, Math.round(src.width * k)), hh = Math.max(1, Math.round(src.height * k));
      const thumb = resampleCanvas(src, w, hh, 'bicubicSharper');
      const target = v.flatten ? bg : (() => { const l = new RasterLayer(1, 1, baseName(f.name)); doc.layers.push(l); return l; })();
      if (v.flatten) ctx2d(bg.canvas).drawImage(thumb, Math.round(cx + (cellW - w) / 2), Math.round(cy + (availH - hh) / 2));
      else { target.canvas = thumb; target.x = Math.round(cx + (cellW - w) / 2); target.y = Math.round(cy + (availH - hh) / 2); }
      if (v.captions) {
        const x = ctx2d(bg.canvas);
        x.fillStyle = '#000'; x.font = `${v.fontSize}px Segoe UI, system-ui, sans-serif`; x.textAlign = 'center'; x.textBaseline = 'top';
        let label = baseName(f.name);
        while (label.length > 3 && x.measureText(label).width > cellW) label = label.slice(0, -2);
        x.fillText(label === baseName(f.name) ? label : label + '…', cx + cellW / 2, cy + availH + v.fontSize * 0.25);
      }
    }
    doc.relink();
    const top = doc.layers[doc.layers.length - 1];
    doc.activeLayerId = top.id; doc.selectedIds = [top.id];
    doc.history.snapshots = [{ name: doc.name, state: doc.captureState(true) }];
    app.addDocument(doc);
  }
}

// ------------------------------------------------------------------ Load Files into Stack
async function loadStack() {
  const files = await pickFiles(OPEN_ACCEPT, true);
  if (!files.length) return;
  const canvases: { c: HTMLCanvasElement; name: string }[] = [];
  for (const f of files) { try { canvases.push({ c: await flatCanvasOf(f, f.name), name: baseName(f.name) }); } catch { toast(`Skipped “${f.name}” (unsupported file).`, 'error'); } }
  if (!canvases.length) return;
  const W = Math.max(...canvases.map(x => x.c.width)), H = Math.max(...canvases.map(x => x.c.height));
  const doc = new PixDocument(W, H, canvases[0].name);
  doc.layers = canvases.map(({ c, name }) => { const l = new RasterLayer(1, 1, name); l.canvas = c; l.x = Math.round((W - c.width) / 2); l.y = Math.round((H - c.height) / 2); return l; });
  doc.relink();
  const top = doc.layers[doc.layers.length - 1];
  doc.activeLayerId = top.id; doc.selectedIds = [top.id];
  doc.history.baseName = 'Load Layers';
  doc.history.snapshots = [{ name: doc.name, state: doc.captureState(true) }];
  app.addDocument(doc);
}

// ------------------------------------------------------------------ Image Processor
async function imageProcessor() {
  const files = await pickFiles(OPEN_ACCEPT, true);
  if (!files.length) return;
  type Out = { on: boolean; fit: boolean; w: number; h: number; q: number };
  const out: Record<'jpeg' | 'png' | 'webp', Out> = {
    jpeg: { on: true, fit: false, w: 1920, h: 1920, q: 10 }, png: { on: false, fit: false, w: 1920, h: 1920, q: 12 }, webp: { on: false, fit: false, w: 1920, h: 1920, q: 10 },
  };
  let suffix = '';
  const block = (fmt: 'jpeg' | 'png' | 'webp', label: string) => {
    const o = out[fmt];
    return h('fieldset.vo-fieldset', null, h('legend', null, label),
      row('', checkbox(`Save as ${label}`, o.on, x => { o.on = x; })),
      fmt !== 'png' ? row('Quality:', numberField(o.q, x => { o.q = x; }, { min: 0, max: 12, width: 50 })) : null,
      row('', checkbox('Resize to Fit', o.fit, x => { o.fit = x; })),
      row('W:', numberField(o.w, x => { o.w = x; }, { min: 1, max: 30000, unit: 'px', width: 80 }), h('span', null, 'H:'), numberField(o.h, x => { o.h = x; }, { min: 1, max: 30000, unit: 'px', width: 80 })));
  };
  const body = h('div.form', null, h('div.fl-note', null, `${files.length} image${files.length > 1 ? 's' : ''} selected. Processed files are downloaded.`),
    block('jpeg', 'JPEG'), block('png', 'PNG'), block('webp', 'WebP'),
    row('File name suffix:', textField(suffix, x => { suffix = x; }, { width: 120, placeholder: '_web' })));
  if (!(await ok('Image Processor', body, 'Run'))) return;
  let n = 0;
  for (const f of files) {
    let c: HTMLCanvasElement;
    try { c = await flatCanvasOf(f, f.name); } catch { continue; }
    for (const fmt of ['jpeg', 'png', 'webp'] as const) {
      const o = out[fmt];
      if (!o.on) continue;
      let img = c;
      if (o.fit) {
        const k = Math.min(1, o.w / c.width, o.h / c.height);
        if (k < 1) img = resampleCanvas(c, Math.max(1, Math.round(c.width * k)), Math.max(1, Math.round(c.height * k)), 'bicubicSharper');
      }
      const blob = await encodeImage(img, fmt, Math.max(0.05, o.q / 12));
      downloadBlob(blob, `${baseName(f.name)}${suffix}.${FORMAT_INFO[fmt].ext}`);
      n++;
      await new Promise(r => setTimeout(r, 120));
    }
  }
  toast(`Image Processor: ${n} file${n === 1 ? '' : 's'} written.`, 'success');
}

// ------------------------------------------------------------------ Crop and Straighten Photos
/** Find separate photos on a scanner background; each becomes a straightened document. */
function cropStraighten() {
  const doc = D();
  if (!doc) return;
  const src = doc.flattenedCanvas();
  const k = Math.min(1, 700 / Math.max(src.width, src.height));
  const W = Math.max(1, Math.round(src.width * k)), H = Math.max(1, Math.round(src.height * k));
  const small = createCanvas(W, H), sx = ctx2d(small);
  sx.drawImage(src, 0, 0, W, H);
  const d = sx.getImageData(0, 0, W, H).data;
  // background colour: median of the border
  const border: number[][] = [];
  for (let x = 0; x < W; x++) for (const y of [0, H - 1]) { const i = (y * W + x) * 4; border.push([d[i], d[i + 1], d[i + 2]]); }
  for (let y = 0; y < H; y++) for (const x of [0, W - 1]) { const i = (y * W + x) * 4; border.push([d[i], d[i + 1], d[i + 2]]); }
  const med = [0, 1, 2].map(c => border.map(b => b[c]).sort((a, b) => a - b)[border.length >> 1]);
  const fg = new Uint8Array(W * H);
  for (let i = 0, j = 0; i < fg.length; i++, j += 4) fg[i] = Math.max(Math.abs(d[j] - med[0]), Math.abs(d[j + 1] - med[1]), Math.abs(d[j + 2] - med[2])) > 28 ? 1 : 0;
  // close small gaps (3×3 dilate then erode)
  const morph = (a: Uint8Array, v: 0 | 1) => { const o = new Uint8Array(a.length); for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { let r = 1 - v; for (let dy = -1; dy <= 1 && r !== v; dy++) for (let dx = -1; dx <= 1; dx++) { const xx = x + dx, yy = y + dy; if (xx >= 0 && yy >= 0 && xx < W && yy < H && a[yy * W + xx] === v) { r = v; break; } } o[y * W + x] = r; } return o; };
  const mask = morph(morph(fg, 1), 0);
  // connected components
  const lab = new Int32Array(W * H).fill(-1);
  const comps: number[][] = [];
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i] || lab[i] >= 0) continue;
    const id = comps.length, pts: number[] = [], st = [i];
    lab[i] = id;
    while (st.length) {
      const p = st.pop()!; pts.push(p);
      const x = p % W, y = (p - x) / W;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const xx = x + dx, yy = y + dy, q = yy * W + xx; if (xx >= 0 && yy >= 0 && xx < W && yy < H && mask[q] && lab[q] < 0) { lab[q] = id; st.push(q); } }
    }
    comps.push(pts);
  }
  const photos = comps.filter(c => c.length > W * H * 0.01);
  if (!photos.length) { toast('Could not find any photos to crop and straighten.', 'error'); return; }
  let n = 0;
  for (const pts of photos) {
    // best angle: smallest bounding box area over −45°…45°
    let best = { a: 0, area: Infinity, x0: 0, y0: 0, x1: 0, y1: 0 };
    const step = Math.max(1, Math.floor(pts.length / 4000));
    for (let deg = -45; deg <= 45; deg += 0.5) {
      const r = (deg * Math.PI) / 180, cs = Math.cos(r), sn = Math.sin(r);
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (let t = 0; t < pts.length; t += step) { const p = pts[t], x = p % W, y = (p - x) / W; const u = x * cs + y * sn, v = -x * sn + y * cs; if (u < x0) x0 = u; if (u > x1) x1 = u; if (v < y0) y0 = v; if (v > y1) y1 = v; }
      const area = (x1 - x0) * (y1 - y0);
      if (area < best.area - 1e-6) best = { a: deg, area, x0, y0, x1, y1 };
    }
    const inv = 1 / k, inset = 2;
    const w = Math.max(1, Math.round((best.x1 - best.x0 + 1) * inv) - inset * 2), hh = Math.max(1, Math.round((best.y1 - best.y0 + 1) * inv) - inset * 2);
    const out = PixDocument.create(w, hh, { name: `${baseName(doc.name)} Copy${n ? ' ' + (n + 1) : ''}`, resolution: doc.resolution, resolutionUnit: doc.resolutionUnit });
    const x = ctx2d((out.layers[0] as RasterLayer).canvas);
    const r = (best.a * Math.PI) / 180;
    x.imageSmoothingQuality = 'high';
    x.translate(-best.x0 * inv - inset, -best.y0 * inv - inset);
    x.rotate(-r);
    x.drawImage(src, 0, 0);
    out.history.snapshots = [{ name: out.name, state: out.captureState(true) }];
    app.addDocument(out);
    n++;
  }
  toast(`Crop and Straighten Photos: ${n} photo${n > 1 ? 's' : ''} extracted.`, 'success');
}

registerCommands([
  { id: 'file.fitImage', label: 'Fit Image...', enabled: () => !!D(), run: fitImage },
  { id: 'file.contactSheet', label: 'Contact Sheet II...', run: contactSheet },
  { id: 'file.cropStraighten', label: 'Crop and Straighten Photos', enabled: () => !!D(), run: cropStraighten },
  { id: 'file.imageProcessor', label: 'Image Processor...', run: imageProcessor },
  { id: 'file.loadStack', label: 'Load Files into Stack...', run: loadStack },
]);
