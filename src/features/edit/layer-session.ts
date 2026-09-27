// Shared plumbing for modal layer edits (Content-Aware Scale, Puppet Warp, Perspective Warp): take the active
// pixel layer (or the selected pixels of it), show live previews through layer._preview and commit the result as
// one undoable step.
import { app, type Tool } from '../../core/app';
import type { PixDocument } from '../../core/document';
import { RasterLayer } from '../../core/layer';
import { alphaBounds, createCanvas, ctx2d, cropCanvas } from '../../core/canvas';
import type { Rect } from '../../core/types';
import { toast } from '../../ui/toast';

export interface LayerSource {
  doc: PixDocument; layer: RasterLayer;
  /** Pixels being edited (cropped) and their doc rect. */
  src: HTMLCanvasElement; rect: Rect;
  /** The rest of the layer (selection cut out), at hole.x/y — null when the whole layer is edited. */
  hole: { canvas: HTMLCanvasElement; x: number; y: number } | null;
  prevTool: string;
}
export function grabLayer(doc: PixDocument | null, what: string): LayerSource | null {
  if (!doc) return null;
  const l = doc.activeLayer;
  if (!(l instanceof RasterLayer)) { toast(`Could not complete the ${what} command because the layer is not a pixel layer. Rasterize it first.`, 'error', 4000); return null; }
  if (l.locks.all || l.locks.pixels || l.locks.position) { toast(`Could not complete the ${what} command because the layer “${l.name}” is locked.`, 'error'); return null; }
  if (!l.visible) { toast(`Could not complete the ${what} command because the layer is hidden.`, 'error'); return null; }
  const sel = !doc.selection.empty && doc.selection.mask ? doc.selection.mask : null;
  if (l.isBackground && !sel) { toast(`Could not complete the ${what} command because the layer is locked. Convert the Background into a normal layer first (double-click it in the Layers panel).`, 'error', 5000); return null; }
  const lr = { x: l.x, y: l.y, w: l.canvas.width, h: l.canvas.height };
  const content = createCanvas(lr.w, lr.h), cx = ctx2d(content);
  cx.drawImage(l.canvas, 0, 0);
  let hole: LayerSource['hole'] = null;
  if (sel) {
    cx.globalCompositeOperation = 'destination-in'; cx.drawImage(sel, -lr.x, -lr.y);
    const hc = createCanvas(lr.w, lr.h), hx = ctx2d(hc);
    hx.drawImage(l.canvas, 0, 0);
    hx.globalCompositeOperation = 'destination-out'; hx.drawImage(sel, -lr.x, -lr.y);
    if (l.isBackground) { hx.globalCompositeOperation = 'destination-over'; hx.fillStyle = `rgb(${app.bg.r},${app.bg.g},${app.bg.b})`; hx.fillRect(0, 0, lr.w, lr.h); }
    hole = { canvas: hc, x: lr.x, y: lr.y };
  }
  const b = alphaBounds(content);
  if (!b) { toast(`Could not complete the ${what} command because the ${sel ? 'selected area' : 'layer'} is empty.`, 'error'); return null; }
  return { doc, layer: l, src: cropCanvas(content, b), rect: { x: lr.x + b.x, y: lr.y + b.y, w: b.w, h: b.h }, hole, prevTool: app.activeTool?.id || 'move' };
}
/** Compose hole + result into one canvas (doc position returned). Background layers stay document-sized. */
function compose(s: LayerSource, res: HTMLCanvasElement | null, rx: number, ry: number) {
  const parts: Rect[] = [];
  if (s.hole) parts.push({ x: s.hole.x, y: s.hole.y, w: s.hole.canvas.width, h: s.hole.canvas.height });
  if (res) parts.push({ x: Math.floor(rx), y: Math.floor(ry), w: Math.ceil(rx + res.width) - Math.floor(rx), h: Math.ceil(ry + res.height) - Math.floor(ry) });
  let x0 = Math.min(...parts.map(p => p.x)), y0 = Math.min(...parts.map(p => p.y)), x1 = Math.max(...parts.map(p => p.x + p.w)), y1 = Math.max(...parts.map(p => p.y + p.h));
  if (s.layer.isBackground) { x0 = 0; y0 = 0; x1 = s.doc.width; y1 = s.doc.height; }
  if (!parts.length) { x0 = s.rect.x; y0 = s.rect.y; x1 = x0 + 1; y1 = y0 + 1; }
  const c = createCanvas(Math.max(1, x1 - x0), Math.max(1, y1 - y0)), x = ctx2d(c);
  if (s.hole) x.drawImage(s.hole.canvas, s.hole.x - x0, s.hole.y - y0);
  if (res) x.drawImage(res, rx - x0, ry - y0);
  return { canvas: c, x: x0, y: y0 };
}
export function showPreview(s: LayerSource, res: HTMLCanvasElement | null, rx: number, ry: number) {
  s.layer._preview = compose(s, res, rx, ry);
  s.doc.invalidate();
}
export function clearPreview(s: LayerSource) { s.layer._preview = null; s.doc.invalidate(); }
export function commitLayer(s: LayerSource, name: string, res: HTMLCanvasElement, rx: number, ry: number) {
  const c = compose(s, res, rx, ry);
  s.layer._preview = null;
  s.doc.history.transaction(name, () => { s.layer.canvas = c.canvas; s.layer.x = c.x; s.layer.y = c.y; s.layer.invalidate(); if (s.hole) s.doc.selection.deselect(); });
  s.doc.pixelsChanged(s.layer, null);
  s.doc.layersChanged();
}
/** Switch to a hidden modal tool; returns a function that switches back. */
export function enterTool(t: Tool, prev: string) { if (!app.tools.has(t.id)) app.registerTool(t); app.setTool(t.id); return () => { if (app.activeTool?.id === t.id) app.setTool(prev); }; }
