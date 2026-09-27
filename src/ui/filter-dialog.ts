// Photoshop-style filter dialog: preview box (drag to pan, +/- zoom), controls, OK/Cancel + Preview on the right.
// Applies a live preview to the canvas and commits one history state on OK.
import { h, dragPointer } from './dom';
import { icon } from './icons';
import { openDialog } from './dialog';
import { pixelOpPreview, type PixelOp } from '../core/pixelops';
import type { PixDocument } from '../core/document';
import { createCanvas, ctx2d } from '../core/canvas';
import { toast } from './toast';

export interface FilterDialogOptions<P> {
  title: string;
  doc: PixDocument;
  params: P;
  /** Build controls; call update() after any param change. */
  build(body: HTMLElement, params: P, update: () => void): void;
  /** Pixel operation for the given params. */
  op(params: P): PixelOp;
  /** Show the in-dialog preview box (default true). */
  previewBox?: boolean;
  width?: number;
  /** History state name (default: title without "..."). */
  historyName?: string;
}

/** Returns the params on OK (after applying), or null on cancel. */
export async function filterDialog<P>(o: FilterDialogOptions<P>): Promise<P | null> {
  let onResult: (c: HTMLCanvasElement) => void = () => {};
  const preview = pixelOpPreview(o.doc, { onResult: c => onResult(c) });
  if (!preview.ok) return null;
  const target = preview.target!;
  const params = o.params;
  const showBox = o.previewBox !== false;
  // preview box state
  const box = createCanvas(260, 200) as HTMLCanvasElement;
  box.className = 'filter-preview-canvas';
  let zoom = 1, cx = target.holder.canvas.width / 2, cy = target.holder.canvas.height / 2;
  let result: HTMLCanvasElement | null = null;
  const zoomLabel = h('span.filter-zoom-label', null, '100%');
  const drawBox = () => {
    const x = ctx2d(box);
    x.fillStyle = '#fff'; x.fillRect(0, 0, box.width, box.height);
    const src = result || target.holder.canvas;
    x.imageSmoothingEnabled = zoom < 1;
    x.setTransform(zoom, 0, 0, zoom, box.width / 2 - cx * zoom, box.height / 2 - cy * zoom);
    x.drawImage(src, 0, 0);
    x.setTransform(1, 0, 0, 1, 0, 0);
    zoomLabel.textContent = Math.round(zoom * 100) + '%';
  };
  box.addEventListener('pointerdown', e => {
    const c0x = cx, c0y = cy;
    const orig = result;
    result = null; drawBox(); // show original while pressed (Photoshop behaviour)
    dragPointer(e, (dx, dy) => { cx = c0x - dx / zoom; cy = c0y - dy / zoom; drawBox(); }, () => { result = orig; drawBox(); });
  });
  const boxEl = showBox ? h('div.filter-preview', null, box,
    h('div.filter-zoom', null,
      h('button.icon-btn', { type: 'button', title: 'Zoom out', onclick: () => { zoom = Math.max(0.05, zoom / 2); drawBox(); } }, icon('minus', 14)),
      zoomLabel,
      h('button.icon-btn', { type: 'button', title: 'Zoom in', onclick: () => { zoom = Math.min(16, zoom * 2); drawBox(); } }, icon('plus', 14)))) : null;
  const controls = h('div.filter-controls');
  const update = () => preview.update(o.op(params), 90);
  try { o.build(controls, params, update); } catch (err) { console.error(err); }
  const body = h('div.filter-dialog-body', null, boxEl, controls);
  onResult = c => { result = c; drawBox(); };
  const d = openDialog({
    title: o.title, body, layout: 'side', width: o.width ?? (showBox ? 600 : 440),
    preview: { checked: true, onChange: v => preview.setEnabled(v) },
    buttons: [{ label: 'OK', primary: true, value: true }, { label: 'Cancel', value: false }],
    cancelValue: false,
  });
  drawBox();
  update();
  const ok = await d.result;
  if (!ok) { preview.cancel(); return null; }
  try {
    await preview.commit(o.historyName || o.title.replace(/\.\.\.$/, ''), o.op(params));
  } catch (err: any) { toast('Filter failed: ' + (err?.message || err), 'error'); return null; }
  return params;
}
