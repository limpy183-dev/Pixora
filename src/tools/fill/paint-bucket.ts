// Paint Bucket Tool (G): fills similar-coloured pixels with the foreground colour or a pattern.
// Tolerance (default 32), Anti-alias, Contiguous (scanline flood fill on typed arrays), All Layers (samples the merged
// image), Mode (incl. Behind / Clear) and Opacity. Respects the selection, locks, layer masks / Quick Mask.
// History: "Paint Bucket".
import { app, type Tool } from '../../core/app';
import type { PaintTarget, PixDocument } from '../../core/document';
import { RasterLayer } from '../../core/layer';
import { resources } from '../../core/registry';
import type { Pattern, Rect } from '../../core/types';
import type { BrushMode } from '../../core/brush';
import { cloneCanvas, createCanvas, ctx2d } from '../../core/canvas';
import { toCss } from '../../core/color';
import { events } from '../../core/events';
import { checkbox, label, numberField, popupSlider, select, separator } from '../../ui/widgets';
import { svgCursor } from '../../ui/cursors';
import { toast } from '../../ui/toast';
import { patternPresetPicker } from '../../features/color/preset-ui';
import { MODE_OPTIONS, composeFill, fillTarget } from './common';

const settings = {
  source: 'fg' as 'fg' | 'pattern',
  patternId: '',
  mode: 'normal' as BrushMode,
  opacity: 100,
  tolerance: 32,
  antiAlias: true,
  contiguous: true,
  allLayers: false,
};

const CURSOR = svgCursor('<path d="m5.2 12.2 6.4-6.4 6.8 6.8-5.9 5.9a1.5 1.5 0 0 1-2.1 0l-5.2-5.2a.8.8 0 0 1 0-1.1z" fill="#fff"/><path d="m8.6 8.8-2.9-2.9"/><path d="M20 14.5s1.8 2.2 1.8 3.4a1.8 1.8 0 0 1-3.6 0c0-1.2 1.8-3.4 1.8-3.4z" fill="#000"/>', 20, 21, 'crosshair');

export const findPattern = (id: string): Pattern | null => resources.patterns.find(p => p.id === id) || resources.patterns[0] || null;

/**
 * Region mask (doc-sized alpha, 0/255) of pixels similar to the seed.
 * Similarity: every channel (R, G, B, A) within `tol` of the seed colour (fully transparent pixels match each other).
 */
export function floodRegion(data: Uint8ClampedArray, w: number, h: number, sx: number, sy: number, tol: number, contiguous: boolean): Uint8Array {
  const px = new Uint32Array(data.buffer, data.byteOffset, w * h);
  const out = new Uint8Array(w * h);
  const i0 = sy * w + sx, s = i0 * 4;
  const r0 = data[s], g0 = data[s + 1], b0 = data[s + 2], a0 = data[s + 3];
  const seed = px[i0];
  const match = (i: number) => {
    if (px[i] === seed) return true;
    const k = i * 4, a = data[k + 3];
    if (a0 === 0 && a === 0) return true;
    return Math.abs(data[k] - r0) <= tol && Math.abs(data[k + 1] - g0) <= tol && Math.abs(data[k + 2] - b0) <= tol && Math.abs(a - a0) <= tol;
  };
  if (!contiguous) {
    for (let i = 0; i < out.length; i++) if (match(i)) out[i] = 255;
    return out;
  }
  // scanline flood fill with an explicit stack of seeds
  const stack = new Int32Array(Math.max(1024, w * 4));
  let sp = 0, st = stack;
  const push = (i: number) => { if (sp >= st.length) { const n = new Int32Array(st.length * 2); n.set(st); st = n; } st[sp++] = i; };
  push(i0);
  while (sp > 0) {
    const i = st[--sp];
    if (out[i]) continue;
    const y = (i / w) | 0, rowStart = y * w, rowEnd = rowStart + w - 1;
    let l = i, r = i;
    while (l > rowStart && !out[l - 1] && match(l - 1)) l--;
    while (r < rowEnd && !out[r + 1] && match(r + 1)) r++;
    for (let k = l; k <= r; k++) out[k] = 255;
    for (let pass = 0; pass < 2; pass++) {
      const dy = pass ? w : -w;
      if ((dy < 0 && y === 0) || (dy > 0 && y === h - 1)) continue;
      let inRun = false;
      for (let k = l; k <= r; k++) {
        const n = k + dy;
        const m = !out[n] && match(n);
        if (m && !inRun) { push(n); inRun = true; } else if (!m) inRun = false;
      }
    }
  }
  return out;
}

/** Pixels to compare against: merged image (All Layers) or the paint target's own pixels, doc-sized. */
function sampleImage(doc: PixDocument, t: PaintTarget): ImageData {
  if (settings.allLayers) return ctx2d(doc.getComposite()).getImageData(0, 0, doc.width, doc.height);
  const c = createCanvas(doc.width, doc.height), x = ctx2d(c);
  if (t.isMask && t.kind === 'mask' && t.layer?.mask?.bg === 255) { x.fillStyle = '#000'; x.fillRect(0, 0, doc.width, doc.height); x.clearRect(t.holder.x, t.holder.y, t.holder.canvas.width, t.holder.canvas.height); }
  x.drawImage(t.holder.canvas, t.holder.x, t.holder.y);
  return x.getImageData(0, 0, doc.width, doc.height);
}

function bucketFill(doc: PixDocument, px: number, py: number) {
  const x = Math.floor(px), y = Math.floor(py);
  if (x < 0 || y < 0 || x >= doc.width || y >= doc.height) return;
  if (!doc.quickMask && !doc.selection.empty && doc.selection.valueAt(x, y) === 0) return;   // outside the selection: nothing to fill
  const t = fillTarget(doc, 'Paint Bucket');
  if (!t) return;
  const pat = settings.source === 'pattern' ? findPattern(settings.patternId) : null;
  if (settings.source === 'pattern' && !pat) { toast('No pattern is available. Define a pattern first (Edit › Define Pattern).', 'error'); return; }
  document.body.classList.add('busy');
  try {
    if (t.kind === 'pixels') (t.layer as RasterLayer).ensureRect({ x: 0, y: 0, w: doc.width, h: doc.height });
    const W = doc.width, H = doc.height;
    const img = sampleImage(doc, t);
    const region = floodRegion(img.data, W, H, x, y, Math.max(0, Math.min(255, settings.tolerance)), settings.contiguous);
    // bounds of the region
    let x0 = W, y0 = H, x1 = -1, y1 = -1;
    for (let yy = 0, i = 0; yy < H; yy++) for (let xx = 0; xx < W; xx++, i++) if (region[i]) { if (xx < x0) x0 = xx; if (xx > x1) x1 = xx; if (yy < y0) y0 = yy; y1 = yy; }
    if (x1 < 0) return;
    const pad = settings.antiAlias ? 1 : 0;
    const r: Rect = { x: Math.max(0, x0 - pad), y: Math.max(0, y0 - pad), w: 0, h: 0 };
    r.w = Math.min(W, x1 + 1 + pad) - r.x; r.h = Math.min(H, y1 + 1 + pad) - r.y;
    // region mask canvas (r-sized)
    const mask = createCanvas(r.w, r.h), mimg = new ImageData(r.w, r.h), md = mimg.data;
    for (let yy = 0; yy < r.h; yy++) {
      const src = (yy + r.y) * W + r.x, dst = yy * r.w;
      for (let xx = 0; xx < r.w; xx++) md[(dst + xx) * 4 + 3] = region[src + xx];
    }
    ctx2d(mask).putImageData(mimg, 0, 0);
    if (settings.antiAlias) {
      // soften the edge: add a 1px partial-coverage fringe (like Photoshop's anti-aliased fill edge)
      const soft = createCanvas(r.w, r.h), sx = ctx2d(soft);
      sx.filter = 'blur(0.6px)'; sx.drawImage(mask, 0, 0); sx.filter = 'none';
      sx.globalCompositeOperation = 'lighten'; sx.drawImage(mask, 0, 0);
      ctx2d(mask).globalCompositeOperation = 'copy';
      ctx2d(mask).drawImage(soft, 0, 0);
    }
    // fill source (r-sized): colour or pattern tiled from the document origin, cut to the region
    const fill = createCanvas(r.w, r.h), fx = ctx2d(fill);
    if (pat) { const p = fx.createPattern(pat.canvas, 'repeat')!; p.setTransform(new DOMMatrix().translate(-r.x, -r.y)); fx.fillStyle = p; }
    else fx.fillStyle = toCss(app.fg);
    fx.fillRect(0, 0, r.w, r.h);
    fx.globalCompositeOperation = 'destination-in';
    fx.drawImage(mask, 0, 0);
    const orig = t.holder.canvas, out = cloneCanvas(orig);
    composeFill(doc, t, out, orig, fill, r, settings.mode, settings.opacity / 100);
    doc.history.transaction('Paint Bucket', () => { t.holder.canvas = out; }, 'paint-bucket');
    doc.pixelsChanged(t.layer, r);
  } finally { document.body.classList.remove('busy'); }
}

const tool: Tool = {
  id: 'paint-bucket', name: 'Paint Bucket Tool', group: 'gradient', icon: 'paint-bucket', shortcut: 'G', order: 1,
  altEyedropper: true,
  settings,
  cursor: () => CURSOR,
  options(bar) {
    const src = select([{ value: 'fg', label: 'Foreground' }, { value: 'pattern', label: 'Pattern' }], settings.source, v => { settings.source = v as 'fg' | 'pattern'; app.saveToolSettings(tool); syncPat(); }, { width: 96, title: 'Set source for fill area' });
    const pat = patternPresetPicker(findPattern(settings.patternId), p => { settings.patternId = p.id; app.saveToolSettings(tool); });
    const syncPat = () => { pat.style.display = settings.source === 'pattern' ? '' : 'none'; };
    const mode = select(MODE_OPTIONS, settings.mode, v => { settings.mode = v; app.saveToolSettings(tool); }, { width: 110, title: 'Blending mode' });
    const opacity = popupSlider('Opacity', settings.opacity, v => { settings.opacity = v; app.saveToolSettings(tool); }, { title: 'Opacity of the fill' });
    const tol = numberField(settings.tolerance, v => { settings.tolerance = v; app.saveToolSettings(tool); }, { min: 0, max: 255, width: 40, label: 'Tolerance:', title: 'Range of similar colors to fill (0–255)' });
    const aa = checkbox('Anti-alias', settings.antiAlias, v => { settings.antiAlias = v; app.saveToolSettings(tool); }, { title: 'Smooth the edges of the filled area' });
    const cont = checkbox('Contiguous', settings.contiguous, v => { settings.contiguous = v; app.saveToolSettings(tool); }, { title: 'Fill only adjacent pixels' });
    const all = checkbox('All Layers', settings.allLayers, v => { settings.allLayers = v; app.saveToolSettings(tool); }, { title: 'Sample the merged image of all visible layers' });
    bar.append(src, pat, separator(), label('Mode:'), mode, opacity, separator(), tol, aa, cont, all);
    syncPat();
    const sync = () => { src.setValue(settings.source); pat.setValue(findPattern(settings.patternId)); mode.setValue(settings.mode); opacity.setValue(settings.opacity); tol.setValue(settings.tolerance); aa.setValue(settings.antiAlias); cont.setValue(settings.contiguous); all.setValue(settings.allLayers); syncPat(); };
    return events.on('toolOptions', sync);
  },
  pointerDown(p, doc) {
    if (p.button !== 0) return;
    bucketFill(doc, p.x, p.y);
  },
};
app.registerTool(tool);
