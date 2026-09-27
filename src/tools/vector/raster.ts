// Rasterize vector paths into the current paint target (Shape tools in Pixels mode, Paths › Fill Path).
import type { PixDocument } from '../../core/document';
import type { BlendMode, RGB } from '../../core/types';
import type { SubPath } from '../../core/path';
import { RasterLayer } from '../../core/layer';
import { createCanvas, ctx2d, alphaBounds } from '../../core/canvas';
import { editableTarget } from '../../core/pixelops';
import { blendPixels } from '../../core/compositor';
import { luma } from '../../core/color';
import { hardenAlpha, blurAlpha } from '../../core/selection';
import { toast } from '../../ui/toast';
import { drawShapeMask } from '../../layers/shape-layer';

export interface PathFillOptions {
  color?: RGB;
  pattern?: HTMLCanvasElement | null;
  opacity: number;              // 0..1
  blend: BlendMode;
  antiAlias: boolean;
  feather: number;
  preserveTransparency?: boolean;
}
const NATIVE: Partial<Record<BlendMode, GlobalCompositeOperation>> = {
  normal: 'source-over', darken: 'darken', multiply: 'multiply', 'color-burn': 'color-burn', lighten: 'lighten', screen: 'screen',
  'color-dodge': 'color-dodge', overlay: 'overlay', 'soft-light': 'soft-light', 'hard-light': 'hard-light', difference: 'difference',
  exclusion: 'exclusion', hue: 'hue', saturation: 'saturation', color: 'color', luminosity: 'luminosity',
};

/** Doc-sized alpha canvas of the subpaths (honours path operations). */
export function pathAlpha(doc: PixDocument, subs: SubPath[], antiAlias = true, feather = 0): HTMLCanvasElement {
  let c = createCanvas(doc.width, doc.height);
  drawShapeMask(ctx2d(c), subs);
  if (!antiAlias) hardenAlpha(c);
  if (feather > 0) c = blurAlpha(c, feather);
  return c;
}

/** Fill subpaths into the active paint target as one history state. Returns false when nothing could be painted. */
export function fillPathPixels(doc: PixDocument, subs: SubPath[], o: PathFillOptions, name: string): boolean {
  const t = editableTarget(doc);
  if (!t) return false;
  if (t.kind === 'pixels' && t.layer!.pixelsLocked) { toast('Could not complete your request because the layer is locked.', 'error'); return false; }
  const shape = pathAlpha(doc, subs, o.antiAlias, o.feather);
  if (!doc.quickMask && doc.selection.mask) {
    const x = ctx2d(shape); x.globalCompositeOperation = 'destination-in'; x.drawImage(doc.selection.mask, 0, 0);
  }
  const b = alphaBounds(shape, 0);
  if (!b) return false;
  if (t.kind === 'pixels') (t.layer as RasterLayer).ensureRect({ x: 0, y: 0, w: doc.width, h: doc.height });
  const hd = t.holder;
  const edit = doc.history.beginPixelEdit(hd, name);
  const hx = ctx2d(hd.canvas);
  // coloured source (doc coords, cropped to bounds)
  const src = createCanvas(b.w, b.h), sx = ctx2d(src);
  sx.drawImage(shape, -b.x, -b.y);
  sx.globalCompositeOperation = 'source-in';
  if (t.isMask) sx.fillStyle = '#000';
  else if (o.pattern) { const p = sx.createPattern(o.pattern, 'repeat')!; p.setTransform(new DOMMatrix().translate(-b.x, -b.y)); sx.fillStyle = p; }
  else sx.fillStyle = `rgb(${o.color!.r},${o.color!.g},${o.color!.b})`;
  sx.fillRect(0, 0, b.w, b.h);
  const lx = b.x - hd.x, ly = b.y - hd.y;
  hx.save();
  if (t.isMask) {
    const v = o.color ? luma(o.color.r, o.color.g, o.color.b) / 255 : 1;
    hx.globalAlpha = o.opacity;
    hx.globalCompositeOperation = 'destination-out';
    hx.drawImage(src, lx, ly);
    if (v > 0) { hx.globalAlpha = o.opacity * v; hx.globalCompositeOperation = 'lighter'; hx.drawImage(src, lx, ly); }
  } else {
    const preserve = o.preserveTransparency || (t.layer?.transparencyLocked && !t.layer.isBackground);
    const op = NATIVE[o.blend];
    if (op && !preserve) {
      hx.globalAlpha = o.opacity; hx.globalCompositeOperation = op; hx.drawImage(src, lx, ly);
    } else {
      // generic path: blend a copy, optionally keep the original alpha
      const x0 = Math.max(0, lx), y0 = Math.max(0, ly), x1 = Math.min(hd.canvas.width, lx + b.w), y1 = Math.min(hd.canvas.height, ly + b.h);
      if (x1 > x0 && y1 > y0) {
        const dst = hx.getImageData(x0, y0, x1 - x0, y1 - y0);
        const s = sx.getImageData(x0 - lx, y0 - ly, x1 - x0, y1 - y0);
        const alpha = preserve ? Uint8ClampedArray.from({ length: dst.data.length / 4 }, (_, i) => dst.data[i * 4 + 3]) : null;
        blendPixels(dst.data, s.data, o.blend, o.opacity, x1 - x0, x0 + hd.x, y0 + hd.y);
        if (alpha) for (let i = 0; i < alpha.length; i++) dst.data[i * 4 + 3] = alpha[i];
        hx.putImageData(dst, x0, y0);
      }
    }
  }
  hx.restore();
  edit.commit(name, { x: lx, y: ly, w: b.w, h: b.h });
  doc.pixelsChanged(t.layer, b);
  return true;
}
