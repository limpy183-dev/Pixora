// Edit > Cut / Copy / Copy Merged / Paste / Paste Special (Paste in Place, Paste Into, Paste Outside) / Clear.
// The clipboard keeps the pixels with their document position (Paste in Place) and mirrors copies to the system
// clipboard as PNG; Paste prefers a newer image from the system clipboard (other apps, screenshots).
import { app } from '../../core/app';
import type { PixDocument, PaintTarget } from '../../core/document';
import { RasterLayer } from '../../core/layer';
import { registerCommands, runCommand } from '../../core/commands';
import { alphaBounds, canvasFromBlob, canvasToBlob, createCanvas, cropCanvas, ctx2d } from '../../core/canvas';
import { intersectRect } from '../../core/geom';
import type { Rect } from '../../core/types';
import { isTyping } from '../../ui/dom';
import { toast } from '../../ui/toast';
import { xp } from '../prefs/store';

interface Clip { canvas: HTMLCanvasElement; x: number; y: number; docW: number; docH: number; stamp: string }
let clip: Clip | null = null;
/** Edit › Purge › Clipboard: drop the internal clipboard contents. */
export function purgeClipboard() { clip = null; }
const D = () => app.activeDoc;
const fail = (msg: string) => { toast(msg, 'error', 3600); return null; };
const stampOf = (c: HTMLCanvasElement) => `${c.width}x${c.height}`;

/** Doc-rect content of the paint target (masks as grey on opaque), cut by the selection when there is one. */
function grab(doc: PixDocument, t: PaintTarget | null, merged: boolean, what: string): Clip | null {
  const sel = !doc.selection.empty && !doc.quickMask;
  let src: HTMLCanvasElement, sx = 0, sy = 0;
  if (merged) src = doc.getComposite();
  else if (t) {
    if (t.isMask) {
      const m = t.holder.canvas, g = createCanvas(m.width, m.height), gx = ctx2d(g);
      gx.fillStyle = '#fff'; gx.fillRect(0, 0, g.width, g.height);
      gx.globalCompositeOperation = 'destination-in'; gx.drawImage(m, 0, 0);
      gx.globalCompositeOperation = 'destination-over'; gx.fillStyle = '#000'; gx.fillRect(0, 0, g.width, g.height);
      src = g;
    } else src = t.holder.canvas;
    sx = t.holder.x; sy = t.holder.y;
  } else {
    const l = doc.activeLayer, c = l?.getContent(doc);
    if (!c) return fail(`Could not complete the ${what} command because no pixels are selected.`);
    src = c.canvas; sx = c.x; sy = c.y;
  }
  const area: Rect | null = sel ? doc.selection.bounds! : { x: 0, y: 0, w: doc.width, h: doc.height };
  const r = intersectRect(area!, { x: sx, y: sy, w: src.width, h: src.height });
  if (!r) return fail(`Could not complete the ${what} command because the selected area is empty.`);
  const c = createCanvas(r.w, r.h), x = ctx2d(c);
  x.drawImage(src, sx - r.x, sy - r.y);
  if (sel) { x.globalCompositeOperation = 'destination-in'; x.drawImage(doc.selection.mask!, -r.x, -r.y); }
  const b = alphaBounds(c);
  if (!b) return fail(`Could not complete the ${what} command because the selected area is empty.`);
  const out = cropCanvas(c, b);
  return { canvas: out, x: r.x + b.x, y: r.y + b.y, docW: doc.width, docH: doc.height, stamp: stampOf(out) };
}

async function toSystem(c: HTMLCanvasElement) {
  if (!xp.exportClipboard) return;                    // Preferences › General › Export Clipboard
  try {
    const CI = (window as any).ClipboardItem;
    if (!CI || !navigator.clipboard?.write) return;
    await navigator.clipboard.write([new CI({ 'image/png': canvasToBlob(c) })]);
  } catch { /* not allowed (unfocused / insecure context): internal clipboard still works */ }
}
async function fromSystem(): Promise<HTMLCanvasElement | null> {
  let state = 'prompt';
  try { state = (await (navigator.permissions as any)?.query({ name: 'clipboard-read' }))?.state || 'prompt'; } catch { /* unsupported name */ }
  if (state === 'denied') return null;
  // never block Paste on an unanswered permission prompt
  const timeout = new Promise<null>(res => setTimeout(() => res(null), state === 'granted' ? 1500 : 3000));
  return Promise.race([timeout, readSystem()]);
}
async function readSystem(): Promise<HTMLCanvasElement | null> {
  try {
    if (!(navigator.clipboard as any)?.read) return null;
    const items = await (navigator.clipboard as any).read();
    for (const it of items) {
      const t = it.types.find((x: string) => x.startsWith('image/'));
      if (t) return canvasFromBlob(await it.getType(t));
    }
  } catch { /* denied */ }
  return null;
}

// ------------------------------------------------------------------ copy / cut / clear
function copy(merged = false): boolean {
  const doc = D();
  if (!doc) return false;
  const t = merged ? null : doc.getPaintTarget();
  const c = grab(doc, t, merged, merged ? 'Copy Merged' : 'Copy');
  if (!c) return false;
  clip = c;
  void toSystem(c.canvas);
  return true;
}
function clear(doc: PixDocument, name = 'Clear'): boolean {
  if (doc.selection.empty || doc.quickMask) return false;
  const t = doc.getPaintTarget();
  if (!t) { fail(`Could not complete the ${name} command because the layer is not a pixel layer.`); return false; }
  if (t.kind === 'pixels' && t.layer!.pixelsLocked) { fail(`Could not complete the ${name} command because the layer is locked.`); return false; }
  if (t.kind === 'pixels' && t.layer instanceof RasterLayer) t.layer.ensureRect({ x: 0, y: 0, w: doc.width, h: doc.height });
  const h = t.holder, x = ctx2d(h.canvas);
  const edit = doc.history.beginPixelEdit(h, name);
  x.save();
  const bgFill = t.isMask || (t.kind === 'pixels' && t.layer!.transparencyLocked);
  if (bgFill) {
    // masks / Background / locked transparency receive the background colour
    const v = t.isMask ? Math.round(0.299 * app.bg.r + 0.587 * app.bg.g + 0.114 * app.bg.b) : 0;
    const f = createCanvas(doc.width, doc.height), fx = ctx2d(f);
    fx.fillStyle = t.isMask ? `rgba(0,0,0,${v / 255})` : `rgb(${app.bg.r},${app.bg.g},${app.bg.b})`;
    fx.fillRect(0, 0, f.width, f.height);
    fx.globalCompositeOperation = 'destination-in'; fx.drawImage(doc.selection.mask!, 0, 0);
    if (t.isMask) { x.globalCompositeOperation = 'destination-out'; x.drawImage(doc.selection.mask!, -h.x, -h.y); x.globalCompositeOperation = 'source-over'; x.drawImage(f, -h.x, -h.y); }
    else { x.globalCompositeOperation = 'source-atop'; x.drawImage(f, -h.x, -h.y); }
  } else {
    x.globalCompositeOperation = 'destination-out';
    x.drawImage(doc.selection.mask!, -h.x, -h.y);
  }
  x.restore();
  if (edit.commit(name, null)) doc.pixelsChanged(t.layer, doc.selection.bounds);
  return true;
}

// ------------------------------------------------------------------ paste
type PasteMode = 'center' | 'inPlace' | 'into' | 'outside';
async function paste(mode: PasteMode) {
  const doc = D();
  // a newer image on the system clipboard (screenshot, other app) wins over the internal one
  const sys = await fromSystem();
  let c: Clip | null = clip;
  if (sys && (!clip || stampOf(sys) !== clip.stamp)) c = { canvas: sys, x: 0, y: 0, docW: 0, docH: 0, stamp: stampOf(sys) };
  if (!c) { toast('Nothing to paste: the clipboard is empty.', 'info'); return; }
  if (!doc) {
    // no document: Paste creates one sized like the clipboard (File > New with Clipboard preset)
    await runCommand('file.new', { name: 'Untitled', w: c.canvas.width, h: c.canvas.height, unit: 'px', res: 72, resUnit: 'ppi' });
    if (!D()) return;
    return paste(mode);
  }
  if ((mode === 'into' || mode === 'outside') && doc.selection.empty) { fail(`Could not complete the Paste ${mode === 'into' ? 'Into' : 'Outside'} command because there is no selection.`); return; }
  // position
  let px: number, py: number;
  const w = c.canvas.width, hh = c.canvas.height;
  const sameDoc = c.docW === doc.width && c.docH === doc.height;
  if (mode === 'inPlace' && c.docW) { px = c.x; py = c.y; }
  else if (!doc.selection.empty && mode !== 'outside') { const b = doc.selection.bounds!; px = Math.round(b.x + (b.w - w) / 2); py = Math.round(b.y + (b.h - hh) / 2); }
  else if (mode === 'inPlace' || (sameDoc && c.docW)) { px = c.x; py = c.y; }
  else {
    // centre of the visible canvas area
    const v = app.viewport;
    const ctr = v ? v.screenToDoc(v.width / 2, v.height / 2) : { x: doc.width / 2, y: doc.height / 2 };
    const cx = Math.max(0, Math.min(doc.width, ctr.x)), cy = Math.max(0, Math.min(doc.height, ctr.y));
    px = Math.round(cx - w / 2); py = Math.round(cy - hh / 2);
  }
  const l = new RasterLayer(1, 1, '');
  l.canvas = c.canvas; l.x = px; l.y = py;
  const name = mode === 'into' ? 'Paste Into' : mode === 'outside' ? 'Paste Outside' : mode === 'inPlace' ? 'Paste in Place' : 'Paste';
  doc.history.transaction(name, () => {
    l.name = doc.nextLayerName();
    doc.addLayer(l, { above: doc.activeLayer, select: true });
    if (mode === 'into' || mode === 'outside') {
      const m = createCanvas(doc.width, doc.height), mx = ctx2d(m);
      if (mode === 'outside') { mx.fillRect(0, 0, m.width, m.height); mx.globalCompositeOperation = 'destination-out'; }
      mx.drawImage(doc.selection.mask!, 0, 0);
      l.mask = { canvas: m, x: 0, y: 0, bg: 0, enabled: true, linked: false, density: 1, feather: 0 } as any;
      doc.selection.deselect();
    }
  });
  doc.layersChanged();
  doc.pixelsChanged(l, { x: px, y: py, w, h: hh });
}

// fallback for pastes that bypass the keyboard shortcut (browser menu / context menu)
window.addEventListener('paste', async e => {
  if (isTyping()) return;
  const f = Array.from(e.clipboardData?.files || []).find(x => x.type.startsWith('image/'));
  if (!f) return;
  e.preventDefault();
  const c = await canvasFromBlob(f);
  clip = { canvas: c, x: 0, y: 0, docW: 0, docH: 0, stamp: stampOf(c) };
  void paste('center');
});

const hasDoc = () => !!D();
const hasSel = () => !!D() && !D()!.selection.empty;
registerCommands([
  { id: 'edit.copy', label: 'Copy', run: () => copy(false), enabled: hasDoc },
  { id: 'edit.copyMerged', label: 'Copy Merged', run: () => copy(true), enabled: hasDoc },
  {
    id: 'edit.cut', label: 'Cut', enabled: hasDoc,
    run: () => {
      const doc = D();
      if (!doc) return;
      if (doc.selection.empty) { fail('Could not complete the Cut command because there is no selection.'); return; }
      if (copy(false)) clear(doc, 'Cut Pixels');
    },
  },
  { id: 'edit.paste', label: 'Paste', run: () => paste('center') },
  { id: 'edit.pasteInPlace', label: 'Paste in Place', run: () => paste('inPlace') },
  { id: 'edit.pasteInto', label: 'Paste Into', run: () => paste('into'), enabled: hasSel },
  { id: 'edit.pasteOutside', label: 'Paste Outside', run: () => paste('outside'), enabled: hasSel },
  {
    id: 'edit.clear', label: 'Clear', shortcut: ['Delete', 'Backspace'], enabled: hasDoc,
    run: () => {
      const doc = D();
      if (!doc) return;
      // without a selection Delete removes the active layer (Photoshop behaviour)
      if (doc.selection.empty || doc.quickMask) { void runCommand('layer.delete'); return; }
      clear(doc);
    },
  },
]);
