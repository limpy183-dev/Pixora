// Shared helpers for the Gradient and Paint Bucket tools: the painting Mode menu (incl. Behind / Clear) and
// compositing a doc-aligned fill source onto the paint target (layer pixels, layer mask or Quick Mask) honouring the
// selection, Lock Transparent Pixels, mode and opacity.
import type { PaintTarget, PixDocument } from '../../core/document';
import type { BlendMode, Rect } from '../../core/types';
import { BLEND_MODE_LABELS, BLEND_MODE_MENU } from '../../core/types';
import type { BrushMode } from '../../core/brush';
import { blendPixels } from '../../core/compositor';
import { borrowCanvas, ctx2d, returnCanvas } from '../../core/canvas';
import { luma } from '../../core/color';
import { toast } from '../../ui/toast';
import type { SelectOption } from '../../ui/widgets';

export const MODE_OPTIONS: (SelectOption<BrushMode> | '-')[] = (() => {
  const out: (SelectOption<BrushMode> | '-')[] = [];
  for (const m of BLEND_MODE_MENU) {
    if (m === '-') { out.push('-'); continue; }
    out.push({ value: m, label: BLEND_MODE_LABELS[m] });
    if (m === 'dissolve') out.push({ value: 'behind', label: 'Behind' }, { value: 'clear', label: 'Clear' });
  }
  return out;
})();

const NATIVE: Partial<Record<BrushMode, GlobalCompositeOperation>> = {
  normal: 'source-over', behind: 'destination-over', clear: 'destination-out', darken: 'darken', multiply: 'multiply', 'color-burn': 'color-burn',
  lighten: 'lighten', screen: 'screen', 'color-dodge': 'color-dodge', overlay: 'overlay', 'soft-light': 'soft-light', 'hard-light': 'hard-light',
  difference: 'difference', exclusion: 'exclusion', hue: 'hue', saturation: 'saturation', color: 'color', luminosity: 'luminosity',
};

/** Resolve the paint target for a fill tool, with Photoshop's messages. */
export function fillTarget(doc: PixDocument, toolName: string): PaintTarget | null {
  const t = doc.getPaintTarget();
  if (!t) {
    const l = doc.activeLayer;
    toast(!l ? 'Could not complete your request because no layer is selected.'
      : l.kind === 'group' ? `Could not use the ${toolName} because the target layer is a group.`
        : l.kind === 'adjustment' ? `Could not use the ${toolName} because the target channel is hidden or the layer is an adjustment layer. Select a pixel layer or a mask.`
          : `Could not use the ${toolName} because the content of the layer is not directly editable. Rasterize the layer first (Layer › Rasterize).`, 'error', 4200);
    return null;
  }
  if (t.kind === 'pixels' && t.layer!.pixelsLocked) { toast(`Could not use the ${toolName} because the layer is locked.`, 'error'); return null; }
  return t;
}

/**
 * Composite `src` (covering doc rect `r`, 1:1 or scaled: drawn stretched to r) onto `dst` (holder-sized canvas already
 * containing the ORIGINAL pixels in rect r), using `orig` for lock-transparency. Everything is limited to rect r.
 */
export function composeFill(doc: PixDocument, t: PaintTarget, dst: HTMLCanvasElement, orig: HTMLCanvasElement, src: CanvasImageSource, r: Rect, mode: BrushMode, opacity: number) {
  const hx = t.holder.x, hy = t.holder.y;
  const L = { x: Math.floor(r.x - hx), y: Math.floor(r.y - hy), w: Math.ceil(r.w), h: Math.ceil(r.h) };
  if (L.w <= 0 || L.h <= 0) return;
  const sel = doc.quickMask ? null : doc.selection.mask;
  // source limited by the selection
  const s = borrowCanvas(L.w, L.h), sx = ctx2d(s);
  sx.imageSmoothingEnabled = true; sx.imageSmoothingQuality = 'high';
  sx.drawImage(src as any, 0, 0, L.w, L.h);
  if (sel) { sx.globalCompositeOperation = 'destination-in'; sx.drawImage(sel, -(L.x + hx), -(L.y + hy)); sx.globalCompositeOperation = 'source-over'; }
  const x = ctx2d(dst);
  x.save();
  x.beginPath(); x.rect(L.x, L.y, L.w, L.h); x.clip();
  x.globalCompositeOperation = 'copy';
  x.drawImage(orig, L.x, L.y, L.w, L.h, L.x, L.y, L.w, L.h);
  x.globalCompositeOperation = 'source-over';
  if (t.isMask) {
    // mask value = grey level of the source; coverage = source alpha × opacity (like painting on a mask)
    const img = sx.getImageData(0, 0, L.w, L.h), d = img.data;
    const v = borrowCanvas(L.w, L.h), vimg = new ImageData(L.w, L.h), vd = vimg.data;
    const clear = mode === 'clear';
    for (let i = 0; i < d.length; i += 4) vd[i + 3] = clear ? 0 : (d[i + 3] * luma(d[i], d[i + 1], d[i + 2])) / 255;
    ctx2d(v).putImageData(vimg, 0, 0);
    x.globalAlpha = opacity;
    x.globalCompositeOperation = 'destination-out';
    x.drawImage(s, L.x, L.y);
    x.globalCompositeOperation = 'lighter';
    x.drawImage(v, L.x, L.y);
    returnCanvas(v);
  } else if (t.kind === 'pixels' && t.layer!.transparencyLocked && mode !== 'behind' && mode !== 'clear') {
    const tmp = borrowCanvas(L.w, L.h), tx = ctx2d(tmp);
    tx.drawImage(orig, -L.x, -L.y);
    blendInto(tx, s, mode, opacity, L, hx, hy);
    tx.globalAlpha = 1; tx.globalCompositeOperation = 'destination-in';
    tx.drawImage(orig, -L.x, -L.y);
    x.globalCompositeOperation = 'copy';
    x.drawImage(tmp, L.x, L.y);
    returnCanvas(tmp);
  } else if (NATIVE[mode]) {
    x.globalAlpha = opacity;
    x.globalCompositeOperation = NATIVE[mode]!;
    x.drawImage(s, L.x, L.y);
  } else {
    x.restore();
    const dimg = x.getImageData(L.x, L.y, L.w, L.h);
    blendPixels(dimg.data, sx.getImageData(0, 0, L.w, L.h).data, mode as BlendMode, opacity, L.w, L.x + hx, L.y + hy);
    x.putImageData(dimg, L.x, L.y);
    returnCanvas(s);
    return;
  }
  x.restore();
  returnCanvas(s);
}

/** Blend s onto an L-sized context (origin at L). */
function blendInto(tx: CanvasRenderingContext2D, s: HTMLCanvasElement, mode: BrushMode, opacity: number, L: Rect, hx: number, hy: number) {
  const op = NATIVE[mode];
  if (op) { tx.globalAlpha = opacity; tx.globalCompositeOperation = op; tx.drawImage(s, 0, 0); tx.globalAlpha = 1; tx.globalCompositeOperation = 'source-over'; return; }
  const dimg = tx.getImageData(0, 0, L.w, L.h);
  blendPixels(dimg.data, ctx2d(s).getImageData(0, 0, L.w, L.h).data, mode as BlendMode, opacity, L.w, L.x + hx, L.y + hy);
  tx.putImageData(dimg, 0, 0);
}

/** Show / clear a live preview canvas on the paint target. */
export function setTargetPreview(doc: PixDocument, t: PaintTarget, c: HTMLCanvasElement | null, dirty?: Rect | null) {
  if (t.kind === 'pixels') t.layer!._preview = c ? { canvas: c, x: t.holder.x, y: t.holder.y } : null;
  else t.holder._preview = c;
  doc.invalidate(dirty ?? null);
}
