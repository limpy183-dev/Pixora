// Helpers to run pixel operations (filters, adjustments, fills) on the current paint target,
// honouring the selection, layer locks and history. Also provides live previews for dialogs.
import type { PixDocument, PaintTarget } from './document';
import { RasterLayer } from './layer';
import { createCanvas, ctx2d } from './canvas';
import { toast } from '../ui/toast';
import { luma } from './color';
import type { Rect } from './types';

export interface PixelOpInfo {
  doc: PixDocument;
  target: PaintTarget;
  /** Document position of the ImageData's (0,0). */
  x: number; y: number;
  /** true when operating on a mask (image is greyscale: R=G=B=mask value, A=255). */
  isMask: boolean;
  /** Selection bounds in image coordinates (or null = whole image). */
  selRect: Rect | null;
  /** Preview mode (dialogs): may use cheaper settings. */
  preview: boolean;
}
export type PixelOp = (img: ImageData, info: PixelOpInfo) => ImageData | void | Promise<ImageData | void>;

/** Resolve an editable paint target for filters/adjustments, showing Photoshop's error if not possible. */
export function editableTarget(doc: PixDocument | null, quiet = false): PaintTarget | null {
  if (!doc) return null;
  const t = doc.getPaintTarget();
  if (!t) {
    if (!quiet) toast(doc.activeLayer ? 'Could not complete your request because the layer is not a pixel layer. Rasterize it first.' : 'No layer is selected.', 'error', 3600);
    return null;
  }
  if (t.kind === 'pixels' && t.layer!.pixelsLocked) {
    if (!quiet) toast('Could not complete your request because the layer is locked.', 'error');
    return null;
  }
  if (t.kind === 'pixels' && t.layer instanceof RasterLayer && !t.layer.visible && !quiet) {
    toast('The target layer is hidden.', 'info');
  }
  return t;
}

function readImage(t: PaintTarget): ImageData {
  const c = t.holder.canvas;
  const img = ctx2d(c).getImageData(0, 0, c.width, c.height);
  if (t.isMask) {
    const d = img.data;
    for (let i = 0; i < d.length; i += 4) { const a = d[i + 3]; d[i] = d[i + 1] = d[i + 2] = a; d[i + 3] = 255; }
  }
  return img;
}
function writeMaskFromGrey(img: ImageData) {
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) { const v = luma(d[i], d[i + 1], d[i + 2]); d[i] = d[i + 1] = d[i + 2] = 0; d[i + 3] = v; }
}

/** Combine result with original through the selection (out = orig*(1-s) + res*s). Returns a NEW canvas. */
export function mergeThroughSelection(doc: PixDocument, t: PaintTarget, original: HTMLCanvasElement, result: HTMLCanvasElement): HTMLCanvasElement {
  const sel = doc.quickMask ? null : doc.selection.mask;
  const lockAlpha = t.kind === 'pixels' && t.layer!.transparencyLocked;
  const out = createCanvas(original.width, original.height), ox = ctx2d(out);
  if (!sel) {
    ox.drawImage(result, 0, 0);
  } else {
    const hx = t.holder.x, hy = t.holder.y;
    const r = createCanvas(original.width, original.height), rx = ctx2d(r);
    rx.drawImage(result, 0, 0);
    rx.globalCompositeOperation = 'destination-in';
    rx.drawImage(sel, -hx, -hy);
    ox.drawImage(original, 0, 0);
    ox.globalCompositeOperation = 'destination-out';
    ox.drawImage(sel, -hx, -hy);
    ox.globalCompositeOperation = 'lighter';
    ox.drawImage(r, 0, 0);
    ox.globalCompositeOperation = 'source-over';
  }
  if (lockAlpha) {
    ox.globalCompositeOperation = 'destination-in';
    ox.drawImage(original, 0, 0);
    ox.globalCompositeOperation = 'source-over';
  }
  return out;
}

async function compute(doc: PixDocument, t: PaintTarget, op: PixelOp, preview: boolean): Promise<HTMLCanvasElement | null> {
  const img = readImage(t);
  const b = doc.quickMask ? null : doc.selection.bounds;
  const selRect = b ? { x: b.x - t.holder.x, y: b.y - t.holder.y, w: b.w, h: b.h } : null;
  const res = (await op(img, { doc, target: t, x: t.holder.x, y: t.holder.y, isMask: t.isMask, selRect, preview })) || img;
  if (t.isMask) writeMaskFromGrey(res);
  const rc = createCanvas(res.width, res.height);
  ctx2d(rc).putImageData(res, 0, 0);
  if (res.width !== t.holder.canvas.width || res.height !== t.holder.canvas.height) return rc;
  return mergeThroughSelection(doc, t, t.holder.canvas, rc);
}

/** Apply an ImageData operation to the current target as one undoable step. */
export async function applyPixelOp(doc: PixDocument, name: string, op: PixelOp, opts: { icon?: string } = {}): Promise<boolean> {
  const t = editableTarget(doc);
  if (!t) return false;
  if (t.kind === 'pixels') (t.layer as RasterLayer).ensureRect({ x: 0, y: 0, w: doc.width, h: doc.height });
  document.body.classList.add('busy');
  try {
    const out = await compute(doc, t, op, false);
    if (!out) return false;
    doc.history.transaction(name, () => { t.holder.canvas = out; }, opts.icon);
    doc.pixelsChanged(t.layer, null);
    return true;
  } finally { document.body.classList.remove('busy'); }
}

/**
 * Live preview controller for dialogs. update(op) recomputes (debounced) and shows the result on canvas
 * without touching history; commit(name) applies; cancel() restores.
 */
export function pixelOpPreview(doc: PixDocument, opts: { onResult?: (c: HTMLCanvasElement) => void } = {}) {
  const t = editableTarget(doc);
  let token = 0, timer = 0, enabled = true, last: PixelOp | null = null;
  const holder = t?.holder as any;
  const setPreview = (c: HTMLCanvasElement | null) => {
    if (!t) return;
    if (t.kind === 'pixels') t.layer!._preview = c ? { canvas: c, x: t.holder.x, y: t.holder.y } : null;
    else holder._preview = c;
    doc.invalidate();
  };
  return {
    target: t,
    get ok() { return !!t; },
    setEnabled(v: boolean) { enabled = v; if (!v) setPreview(null); if (last) this.update(last, 0); },
    update(op: PixelOp, delay = 60) {
      last = op;
      if (!t) return;
      clearTimeout(timer);
      const my = ++token;
      timer = window.setTimeout(async () => {
        try {
          const c = await compute(doc, t, op, true);
          if (my !== token) return;
          if (enabled) setPreview(c);
          if (c) opts.onResult?.(c);
        } catch (err) { console.error(err); }
      }, delay);
    },
    async commit(name: string, op?: PixelOp, icon?: string) {
      clearTimeout(timer); token++;
      setPreview(null);
      if (op || last) await applyPixelOp(doc, name, (op || last)!, { icon });
    },
    cancel() { clearTimeout(timer); token++; setPreview(null); },
  };
}
