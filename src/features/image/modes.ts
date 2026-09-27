// Image › Mode: Bitmap, Grayscale, Duotone, Indexed Color, RGB, CMYK, Lab, Multichannel + Color Table.
// Pixels are always stored as RGBA; a mode converts the pixels to what that mode can represent and sets doc.mode
// (CMYK uses an approximate gamut mapping — browsers have no ICC colour management).
import { app } from '../../core/app';
import type { PixDocument } from '../../core/document';
import { RasterLayer, type Layer } from '../../core/layer';
import type { ColorMode, RGB } from '../../core/types';
import { createCanvas, ctx2d } from '../../core/canvas';
import { luma, rgbToLab, labToRgb, toCss } from '../../core/color';
import { renderLayersToCanvas } from '../../core/compositor';
import { resources, hooks } from '../../core/registry';
import { openDialog, confirmDialog, alertDialog } from '../../ui/dialog';
import { h } from '../../ui/dom';
import { checkbox, colorSwatch, select, textField, patternPicker } from '../../ui/widgets';
import { MODE_LABELS, docChanged, flattenDoc, hasTransparency, mapRasterPixels, needsFlatten, setDocPreview } from './ops';
import { resampleCanvas } from './resample';
import { dialogRow, numInput, remember } from './ui';

const okCancel = [{ label: 'OK', primary: true, value: 'ok' }, { label: 'Cancel', value: null }];

// ------------------------------------------------------------------ colour helpers
/** Replace every {r,g,b} object inside a layer's persistent props (text/shape/fill colours, adjustment params...). */
export function mapLayerColors(l: Layer, fn: (c: RGB) => RGB) {
  const seen = new Set<any>();
  const walk = (o: any): any => {
    if (!o || typeof o !== 'object' || seen.has(o) || o instanceof HTMLCanvasElement || ArrayBuffer.isView(o) || o instanceof DOMMatrix) return o;
    seen.add(o);
    if (typeof o.r === 'number' && typeof o.g === 'number' && typeof o.b === 'number') {
      const c = fn({ r: o.r, g: o.g, b: o.b });
      o.r = c.r; o.g = c.g; o.b = c.b;
      return o;
    }
    for (const k of Object.keys(o)) if (k[0] !== '_' && k !== 'children' && k !== 'mask' && k !== 'canvas') walk(o[k]);
    return o;
  };
  for (const k of Object.keys(l)) if (k[0] !== '_' && k !== 'children' && k !== 'mask' && k !== 'canvas') walk((l as any)[k]);
  l.invalidate();
}

/** Convert pixels + colour props of every layer with a per-colour function (8-bit LUT-friendly). */
function convertDoc(doc: PixDocument, px: (d: Uint8ClampedArray) => void, color: (c: RGB) => RGB) {
  mapRasterPixels(doc, px);
  for (const l of doc.allLayers()) if (!(l instanceof RasterLayer)) mapLayerColors(l, color);
}

const grayPx = (d: Uint8ClampedArray) => { for (let i = 0; i < d.length; i += 4) d[i] = d[i + 1] = d[i + 2] = luma(d[i], d[i + 1], d[i + 2]); };
const grayColor = (c: RGB): RGB => { const v = Math.round(luma(c.r, c.g, c.b)); return { r: v, g: v, b: v }; };

/** Trilinear 3D LUT (17³ grid) of an RGB→RGB function, applied to RGBA bytes. */
function lut3d(fn: (r: number, g: number, b: number) => RGB) {
  const N = 17, S = 255 / (N - 1), t = new Float32Array(N * N * N * 3);
  for (let b = 0, o = 0; b < N; b++) for (let g = 0; g < N; g++) for (let r = 0; r < N; r++, o += 3) {
    const c = fn(r * S, g * S, b * S); t[o] = c.r; t[o + 1] = c.g; t[o + 2] = c.b;
  }
  const px = (d: Uint8ClampedArray) => {
    for (let i = 0; i < d.length; i += 4) {
      const fr = d[i] / S, fg = d[i + 1] / S, fb = d[i + 2] / S;
      const r0 = Math.min(N - 2, fr | 0), g0 = Math.min(N - 2, fg | 0), b0 = Math.min(N - 2, fb | 0);
      const xr = fr - r0, xg = fg - g0, xb = fb - b0;
      for (let ch = 0; ch < 3; ch++) {
        const at = (r: number, g: number, b: number) => t[((b * N + g) * N + r) * 3 + ch];
        const c00 = at(r0, g0, b0) * (1 - xr) + at(r0 + 1, g0, b0) * xr, c10 = at(r0, g0 + 1, b0) * (1 - xr) + at(r0 + 1, g0 + 1, b0) * xr;
        const c01 = at(r0, g0, b0 + 1) * (1 - xr) + at(r0 + 1, g0, b0 + 1) * xr, c11 = at(r0, g0 + 1, b0 + 1) * (1 - xr) + at(r0 + 1, g0 + 1, b0 + 1) * xr;
        d[i + ch] = (c00 * (1 - xg) + c10 * xg) * (1 - xb) + (c01 * (1 - xg) + c11 * xg) * xb;
      }
    }
  };
  return { px, color: (c: RGB): RGB => { const d = new Uint8ClampedArray([c.r, c.g, c.b, 255]); px(d); return { r: d[0], g: d[1], b: d[2] }; } };
}

/** Approximate sRGB → CMYK (SWOP-like) gamut: saturated colours lose chroma, cyan/blue darken a little. */
// ponytail: chroma knee instead of an ICC profile; swap for a real CMYK profile LUT if colour accuracy matters.
const cmykGamut = lut3d((r, g, b) => {
  const lab = rgbToLab({ r, g, b });
  const C = Math.hypot(lab.a, lab.b), hue = Math.atan2(lab.b, lab.a);
  const yellowness = Math.max(0, Math.cos(hue - 1.6));           // yellow survives, blue/cyan/violet shrink most
  const knee = 48 + 40 * yellowness, k = C > knee ? (knee + (C - knee) * 0.45) / C : 1;
  const blueish = Math.max(0, Math.cos(hue + 1.5)) * Math.min(1, C / 90);
  const L = lab.l - blueish * 6;
  return labToRgb({ l: Math.max(0, L), a: lab.a * k, b: lab.b * k });
});

async function confirmFlatten(doc: PixDocument): Promise<boolean> {
  if (!needsFlatten(doc)) return true;
  return (await confirmDialog('Pixora', 'Flatten layers?', [{ label: 'OK', primary: true, value: 'ok' }, { label: 'Cancel', value: 'cancel' }])) === 'ok';
}
async function toGrayscaleFirst(doc: PixDocument, what: string): Promise<boolean> {
  if (doc.mode === 'Grayscale') return true;
  const r = await confirmDialog('Pixora', `${what} is only available for Grayscale images. Convert the image to Grayscale first? Color information will be discarded.`, [{ label: 'Convert', primary: true, value: 'ok' }, { label: 'Cancel', value: 'cancel' }]);
  if (r !== 'ok') return false;
  toGrayscale(doc);
  return true;
}
function toGrayscale(doc: PixDocument) {
  doc.history.transaction('Grayscale', () => {
    if (doc.mode === 'Duotone' && doc.extra.duotone) {
      const inv = duotoneInverse(doc.extra.duotone);
      mapRasterPixels(doc, d => { for (let i = 0; i < d.length; i += 4) d[i] = d[i + 1] = d[i + 2] = inv[Math.round(luma(d[i], d[i + 1], d[i + 2]))]; });
    } else convertDoc(doc, grayPx, grayColor);
    delete doc.extra.duotone; delete doc.extra.indexedPalette;
    doc.mode = 'Grayscale';
  }, 'image');
  docChanged(doc);
}
/** Doc composite (with transparency) → ImageData for previews. */
function compositeData(doc: PixDocument): ImageData {
  const c = renderLayersToCanvas(doc, doc.layers);
  return ctx2d(c).getImageData(0, 0, c.width, c.height);
}
function previewFrom(img: ImageData, fn: (d: Uint8ClampedArray) => void): HTMLCanvasElement {
  const copy = new ImageData(new Uint8ClampedArray(img.data), img.width, img.height);
  fn(copy.data);
  const c = createCanvas(img.width, img.height);
  ctx2d(c).putImageData(copy, 0, 0);
  return c;
}

// ------------------------------------------------------------------ entry point
export async function convertMode(doc: PixDocument, target: ColorMode) {
  if (!target) return;
  if (target === doc.mode && target !== 'Duotone') return;
  const from = doc.mode;
  switch (target) {
    case 'Grayscale': {
      if (from === 'RGB' || from === 'CMYK' || from === 'Lab' || from === 'Indexed' || from === 'Multichannel') {
        const r = await confirmDialog('Pixora', 'Discard color information?', [{ label: 'Discard', primary: true, value: 'ok' }, { label: 'Cancel', value: 'cancel' }]);
        if (r !== 'ok') return;
      }
      toGrayscale(doc);
      return;
    }
    case 'RGB': case 'Lab': {
      doc.history.transaction(MODE_LABELS[target], () => { delete doc.extra.indexedPalette; delete doc.extra.duotone; doc.mode = target; }, 'image');
      docChanged(doc);
      return;
    }
    case 'CMYK': {
      doc.history.transaction('CMYK Color', () => {
        if (from !== 'Grayscale' && from !== 'Bitmap') convertDoc(doc, cmykGamut.px, cmykGamut.color);
        delete doc.extra.indexedPalette; delete doc.extra.duotone;
        doc.mode = 'CMYK';
      }, 'image');
      docChanged(doc);
      return;
    }
    case 'Multichannel': {
      if (!(await confirmFlatten(doc))) return;
      doc.history.transaction('Multichannel', () => { if (needsFlatten(doc)) flattenDoc(doc, { opaque: !hasTransparency(doc) }); doc.mode = 'Multichannel'; }, 'image');
      docChanged(doc);
      return;
    }
    case 'Bitmap': {
      if (!(await toGrayscaleFirst(doc, 'Bitmap mode'))) return;
      if (!(await confirmFlatten(doc))) return;
      await bitmapDialog(doc);
      return;
    }
    case 'Duotone': {
      if (from !== 'Duotone' && !(await toGrayscaleFirst(doc, 'Duotone mode'))) return;
      await duotoneDialog(doc);
      return;
    }
    case 'Indexed': {
      if (from === 'Bitmap') { await alertDialog('Pixora', 'Convert the image to Grayscale before converting it to Indexed Color.', 'warning'); return; }
      if (!(await confirmFlatten(doc))) return;
      await indexedDialog(doc);
      return;
    }
  }
}

// ================================================================== BITMAP
type BitmapMethod = 'threshold' | 'pattern' | 'diffusion' | 'halftone' | 'custom';
type HalftoneShape = 'round' | 'ellipse' | 'line' | 'square' | 'cross' | 'diamond';
const BAYER8 = (() => {
  let m = [[0]];
  for (let n = 1; n < 8; n *= 2) m = [...m.map(r => [...r.map(v => 4 * v), ...r.map(v => 4 * v + 2)]), ...m.map(r => [...r.map(v => 4 * v + 3), ...r.map(v => 4 * v + 1)])];
  return Float32Array.from(m.flat(), v => (v + 0.5) / 64);
})();

function spot(shape: HalftoneShape, u: number, v: number): number {   // u,v in [-1,1] → 0 (darkens first) .. 1
  const au = Math.abs(u), av = Math.abs(v);
  switch (shape) {
    case 'ellipse': return Math.min(1, (u * u + v * v * 2.2) / 3.2);
    case 'line': return av;
    case 'square': return Math.max(au, av);
    case 'cross': return Math.min(au, av);
    case 'diamond': return (au + av) / 2;
    default: return Math.min(1, Math.sqrt((u * u + v * v) / 2));
  }
}

/** Grey (0..255 in the R channel) → 1-bit black/white in place. */
export function bitmapize(d: Uint8ClampedArray, w: number, hh: number, method: BitmapMethod, o: { freq?: number; angle?: number; shape?: HalftoneShape; res?: number; pattern?: HTMLCanvasElement | null } = {}) {
  const n = w * hh, g = new Float32Array(n);
  for (let p = 0, i = 0; p < n; p++, i += 4) g[p] = luma(d[i], d[i + 1], d[i + 2]) / 255;
  const out = new Uint8Array(n);
  if (method === 'threshold') for (let p = 0; p < n; p++) out[p] = g[p] >= 0.5 ? 255 : 0;
  else if (method === 'pattern') for (let y = 0; y < hh; y++) for (let x = 0; x < w; x++) { const p = y * w + x; out[p] = g[p] > BAYER8[(y & 7) * 8 + (x & 7)] ? 255 : 0; }
  else if (method === 'diffusion') {
    for (let y = 0; y < hh; y++) for (let x = 0; x < w; x++) {
      const p = y * w + x, v = g[p], q = v >= 0.5 ? 1 : 0, e = v - q;
      out[p] = q ? 255 : 0;
      if (x + 1 < w) g[p + 1] += e * 7 / 16;
      if (y + 1 < hh) { if (x > 0) g[p + w - 1] += e * 3 / 16; g[p + w] += e * 5 / 16; if (x + 1 < w) g[p + w + 1] += e / 16; }
    }
  } else if (method === 'halftone') {
    const cell = Math.max(2, (o.res || 72) / (o.freq || 53)), a = ((o.angle ?? 45) * Math.PI) / 180, cs = Math.cos(a), sn = Math.sin(a);
    const shape = o.shape || 'round';
    for (let y = 0; y < hh; y++) for (let x = 0; x < w; x++) {
      const p = y * w + x;
      const ru = (x * cs + y * sn) / cell, rv = (-x * sn + y * cs) / cell;
      const u = (ru - Math.floor(ru)) * 2 - 1, v = (rv - Math.floor(rv)) * 2 - 1;
      out[p] = spot(shape, u, v) >= 1 - g[p] ? 255 : 0;
    }
  } else if (method === 'custom' && o.pattern) {
    const pc = o.pattern, pw = pc.width, ph = pc.height, pd = ctx2d(pc).getImageData(0, 0, pw, ph).data, th = new Float32Array(pw * ph);
    for (let i = 0; i < pw * ph; i++) th[i] = (luma(pd[i * 4], pd[i * 4 + 1], pd[i * 4 + 2]) + 0.5) / 256;
    for (let y = 0; y < hh; y++) for (let x = 0; x < w; x++) { const p = y * w + x; out[p] = g[p] > th[(y % ph) * pw + (x % pw)] ? 255 : 0; }
  }
  for (let p = 0, i = 0; p < n; p++, i += 4) { d[i] = d[i + 1] = d[i + 2] = out[p]; d[i + 3] = 255; }
}

async function halftoneDialog(res: number): Promise<{ freq: number; angle: number; shape: HalftoneShape } | null> {
  const S = remember('halftone', { freq: 53, unit: 'in' as 'in' | 'cm', angle: 45, shape: 'round' as HalftoneShape });
  const fIn = numInput(70, v => { S.freq = Math.max(1, Math.min(999, v)); fIn.show(S.freq, 1); }); fIn.show(S.freq, 1);
  const aIn = numInput(70, v => { S.angle = Math.max(-180, Math.min(180, v)); aIn.show(S.angle, 1); }); aIn.show(S.angle, 1);
  const body = h('div.imgd-form', null, h('fieldset.group', null, h('legend', null, 'Halftone Screen'),
    h('div.imgd-form', null,
      dialogRow('Frequency:', fIn, select([{ value: 'in', label: 'Lines/Inch' }, { value: 'cm', label: 'Lines/cm' }], S.unit, v => { S.unit = v as any; }, { width: 110 })),
      dialogRow('Angle:', aIn, h('span', null, 'degrees')),
      dialogRow('Shape:', select<HalftoneShape>([{ value: 'round', label: 'Round' }, { value: 'ellipse', label: 'Ellipse' }, { value: 'line', label: 'Line' }, { value: 'square', label: 'Square' }, { value: 'cross', label: 'Cross' }, { value: 'diamond', label: 'Diamond' }], S.shape, v => { S.shape = v; }, { width: 120 })))));
  const r = await openDialog({ title: 'Halftone Screen', body, layout: 'side', buttons: okCancel }).result;
  if (r !== 'ok') return null;
  S.save();
  void res;
  return { freq: S.unit === 'cm' ? S.freq * 2.54 : S.freq, angle: S.angle, shape: S.shape };
}

async function bitmapDialog(doc: PixDocument) {
  const S = remember('bitmap', { out: 0, unit: doc.resolutionUnit as 'ppi' | 'ppcm', method: 'diffusion' as BitmapMethod, pattern: '' });
  let unit = S.unit, out = S.out > 0 ? S.out : doc.resolution, method: BitmapMethod = S.method;
  let pat = resources.patterns.find(p => p.id === S.pattern) || resources.patterns[0] || null;
  const fmtRes = (ppi: number, u: string) => (u === 'ppcm' ? ppi / 2.54 : ppi);
  const outIn = numInput(80, v => { out = Math.max(1, Math.min(10000, unit === 'ppcm' ? v * 2.54 : v)); outIn.show(fmtRes(out, unit), 2); });
  outIn.show(fmtRes(out, unit), 2);
  const unitSel = select([{ value: 'ppi', label: 'Pixels/Inch' }, { value: 'ppcm', label: 'Pixels/Centimeter' }], unit, v => { unit = v as any; outIn.show(fmtRes(out, unit), 2); inLbl.textContent = `${Math.round(fmtRes(doc.resolution, unit) * 100) / 100} ${unit === 'ppcm' ? 'Pixels/Centimeter' : 'Pixels/Inch'}`; }, { width: 150 });
  const inLbl = h('span', null, `${Math.round(fmtRes(doc.resolution, unit) * 100) / 100} ${unit === 'ppcm' ? 'Pixels/Centimeter' : 'Pixels/Inch'}`);
  const pp = patternPicker(pat, p => { pat = p; });
  const syncPat = () => { pp.style.opacity = method === 'custom' ? '1' : '.4'; pp.style.pointerEvents = method === 'custom' ? '' : 'none'; };
  const methSel = select<BitmapMethod>([
    { value: 'threshold', label: '50% Threshold' }, { value: 'pattern', label: 'Pattern Dither' }, { value: 'diffusion', label: 'Diffusion Dither' },
    { value: 'halftone', label: 'Halftone Screen...' }, { value: 'custom', label: 'Custom Pattern', disabled: !resources.patterns.length },
  ], method, v => { method = v; syncPat(); }, { width: 180 });
  syncPat();
  const body = h('div.imgd-form', { style: { minWidth: '360px' } },
    h('fieldset.group', null, h('legend', null, 'Resolution'), h('div.imgd-form', null, dialogRow('Input:', inLbl), dialogRow('Output:', outIn, unitSel))),
    h('fieldset.group', null, h('legend', null, 'Method'), h('div.imgd-form', null, dialogRow('Use:', methSel), dialogRow('Custom Pattern:', pp))));
  const r = await openDialog({ title: 'Bitmap', body, layout: 'side', buttons: okCancel }).result;
  if (r !== 'ok') return;
  Object.assign(S, { out, unit, method, pattern: pat?.id || '' }); S.save();
  let ht: { freq: number; angle: number; shape: HalftoneShape } | null = null;
  if (method === 'halftone') { ht = await halftoneDialog(out); if (!ht) return; }
  document.body.classList.add('busy');
  await new Promise(requestAnimationFrame);
  try {
    doc.history.transaction('Bitmap', () => {
      const layer = flattenDoc(doc, { opaque: true });
      const k = out / doc.resolution;
      const W = Math.max(1, Math.round(doc.width * k)), H = Math.max(1, Math.round(doc.height * k));
      let c = layer.canvas;
      if (W !== doc.width || H !== doc.height) { c = resampleCanvas(c, W, H, 'bicubic'); doc.setSize(W, H); doc.selection.setMask(null); doc.guides = doc.guides.map(g => ({ ...g, pos: g.pos * k })); }
      const img = ctx2d(c).getImageData(0, 0, W, H);
      bitmapize(img.data, W, H, method, { ...(ht || {}), res: out, pattern: pat?.canvas || null });
      const nc = createCanvas(W, H); ctx2d(nc).putImageData(img, 0, 0);
      layer.canvas = nc; layer.x = 0; layer.y = 0;
      doc.resolution = out;
      doc.mode = 'Bitmap';
    }, 'image');
  } finally { document.body.classList.remove('busy'); }
  docChanged(doc);
}

// ================================================================== DUOTONE
export interface Ink { color: RGB; name: string; curve: number[] }   // curve: 13 % values at DUO_POS
export interface DuotoneSpec { type: 1 | 2 | 3 | 4; inks: Ink[] }
export const DUO_POS = [0, 5, 10, 20, 30, 40, 50, 60, 70, 80, 90, 95, 100];
const linear = () => DUO_POS.slice();
const DUO_PRESETS: Record<string, DuotoneSpec> = {
  'Black Monotone': { type: 1, inks: [{ color: { r: 0, g: 0, b: 0 }, name: 'Black', curve: linear() }] },
  'Warm Sepia': { type: 2, inks: [{ color: { r: 20, g: 16, b: 12 }, name: 'Black', curve: linear() }, { color: { r: 196, g: 142, b: 82 }, name: 'Sepia', curve: [0, 8, 16, 30, 42, 52, 62, 70, 78, 85, 92, 96, 100] }] },
  'Cool Blue': { type: 2, inks: [{ color: { r: 12, g: 14, b: 20 }, name: 'Black', curve: linear() }, { color: { r: 40, g: 110, b: 190 }, name: 'Blue', curve: [0, 7, 14, 28, 40, 50, 60, 68, 76, 84, 91, 95, 100] }] },
  'Gold Tritone': { type: 3, inks: [{ color: { r: 0, g: 0, b: 0 }, name: 'Black', curve: [0, 2, 4, 10, 18, 28, 38, 50, 62, 74, 86, 93, 100] }, { color: { r: 200, g: 150, b: 40 }, name: 'Gold', curve: linear() }, { color: { r: 150, g: 70, b: 40 }, name: 'Rust', curve: [0, 3, 6, 12, 20, 28, 36, 45, 55, 65, 75, 80, 85] }] },
  'Plum Quadtone': { type: 4, inks: [{ color: { r: 0, g: 0, b: 0 }, name: 'Black', curve: [0, 2, 4, 10, 18, 28, 38, 50, 62, 74, 86, 93, 100] }, { color: { r: 120, g: 50, b: 110 }, name: 'Plum', curve: linear() }, { color: { r: 220, g: 120, b: 150 }, name: 'Rose', curve: [0, 6, 12, 22, 30, 38, 44, 50, 55, 60, 65, 68, 70] }, { color: { r: 230, g: 210, b: 160 }, name: 'Cream', curve: [0, 8, 14, 22, 28, 32, 34, 36, 38, 40, 40, 40, 40] }] },
};
const curveAt = (c: number[], t: number) => {   // t 0..100
  for (let i = 1; i < DUO_POS.length; i++) if (t <= DUO_POS[i]) { const k = (t - DUO_POS[i - 1]) / (DUO_POS[i] - DUO_POS[i - 1]); return (c[i - 1] + (c[i] - c[i - 1]) * k) / 100; }
  return c[c.length - 1] / 100;
};
/** 256-entry grey → RGB table for a duotone spec (subtractive ink mixing). */
export function duotoneLUT(s: DuotoneSpec): Uint8ClampedArray {
  const t = new Uint8ClampedArray(256 * 3);
  for (let g = 0; g < 256; g++) {
    const amt = (1 - g / 255) * 100;
    let r = 1, gg = 1, b = 1;
    for (let i = 0; i < s.type; i++) {
      const ink = s.inks[i]; if (!ink) continue;
      const a = Math.max(0, Math.min(1, curveAt(ink.curve, amt)));
      r *= 1 - a * (1 - ink.color.r / 255); gg *= 1 - a * (1 - ink.color.g / 255); b *= 1 - a * (1 - ink.color.b / 255);
    }
    t[g * 3] = r * 255; t[g * 3 + 1] = gg * 255; t[g * 3 + 2] = b * 255;
  }
  return t;
}
/** Luminance → original grey level (inverse of a duotone LUT). */
function duotoneInverse(s: DuotoneSpec): Uint8Array {
  const lut = duotoneLUT(s), lum = new Float32Array(256), inv = new Uint8Array(256);
  for (let g = 0; g < 256; g++) lum[g] = luma(lut[g * 3], lut[g * 3 + 1], lut[g * 3 + 2]);
  for (let L = 0; L < 256; L++) { let best = 0, bd = 1e9; for (let g = 0; g < 256; g++) { const d = Math.abs(lum[g] - L); if (d < bd) { bd = d; best = g; } } inv[L] = best; }
  return inv;
}
function duotonePx(s: DuotoneSpec, inv: Uint8Array | null) {
  const lut = duotoneLUT(s);
  return (d: Uint8ClampedArray) => {
    for (let i = 0; i < d.length; i += 4) {
      let g = inv ? inv[Math.round(luma(d[i], d[i + 1], d[i + 2]))] : d[i];
      g *= 3; d[i] = lut[g]; d[i + 1] = lut[g + 1]; d[i + 2] = lut[g + 2];
    }
  };
}

async function curveDialog(ink: Ink): Promise<number[] | null> {
  const vals = ink.curve.slice();
  const cv = createCanvas(160, 160); cv.style.width = cv.style.height = '160px';
  const draw = () => {
    const x = ctx2d(cv); x.fillStyle = '#fff'; x.fillRect(0, 0, 160, 160);
    x.strokeStyle = '#ccc'; x.lineWidth = 1;
    for (let i = 1; i < 4; i++) { x.beginPath(); x.moveTo(i * 40 + .5, 0); x.lineTo(i * 40 + .5, 160); x.moveTo(0, i * 40 + .5); x.lineTo(160, i * 40 + .5); x.stroke(); }
    x.strokeStyle = toCss(ink.color); x.lineWidth = 2; x.beginPath();
    DUO_POS.forEach((p, i) => { const px = p * 1.6, py = 160 - vals[i] * 1.6; i ? x.lineTo(px, py) : x.moveTo(px, py); });
    x.stroke();
  };
  const fields = DUO_POS.map((p, i) => {
    const f = numInput(46, v => { vals[i] = Math.max(0, Math.min(100, v)); f.show(vals[i], 1); draw(); });
    f.show(vals[i], 1);
    return h('label.imgd-inline', null, h('span', { style: { minWidth: '34px', textAlign: 'right' } }, `${p}:`), f, h('span', null, '%'));
  });
  draw();
  const body = h('div.imgd-inline', { style: { alignItems: 'flex-start', gap: '16px' } }, cv, h('div.imgd-curve', null, ...fields));
  const r = await openDialog({ title: `Duotone Curve (${ink.name})`, body, layout: 'side', buttons: [...okCancel, { label: 'Reset', value: 'reset' }] }).result;
  if (r === 'reset') return linear();
  return r === 'ok' ? vals : null;
}

async function duotoneDialog(doc: PixDocument) {
  const wasDuo = doc.mode === 'Duotone' && doc.extra.duotone;
  const S = remember('duotone', { spec: DUO_PRESETS['Warm Sepia'] as DuotoneSpec });
  const spec: DuotoneSpec = JSON.parse(JSON.stringify(wasDuo ? doc.extra.duotone : S.spec));
  const defaults = [{ r: 0, g: 0, b: 0 }, { r: 196, g: 142, b: 82 }, { r: 60, g: 120, b: 180 }, { r: 200, g: 60, b: 70 }];
  while (spec.inks.length < 4) { const i = spec.inks.length; spec.inks.push({ color: defaults[i], name: '', curve: linear() }); }
  const inv = wasDuo ? duotoneInverse(doc.extra.duotone) : null;
  const src = compositeData(doc);
  let preview = true, timer = 0;
  const refresh = () => { clearTimeout(timer); timer = window.setTimeout(() => setDocPreview(doc, preview ? previewFrom(src, duotonePx(spec, inv)) : null), 30); };

  const syncInks: (() => void)[] = [];
  const inkRows = spec.inks.map((ink, i) => {
    const curve = createCanvas(26, 26); curve.className = 'imgd-ink-curve'; curve.title = 'Click to edit the duotone curve';
    const drawCurve = () => { const x = ctx2d(curve); x.fillStyle = '#fff'; x.fillRect(0, 0, 26, 26); x.strokeStyle = '#000'; x.beginPath(); DUO_POS.forEach((p, k) => { const px = p * 0.26, py = 26 - ink.curve[k] * 0.26; k ? x.lineTo(px, py) : x.moveTo(px, py); }); x.stroke(); };
    drawCurve();
    curve.addEventListener('click', async () => { const c = await curveDialog(ink); if (c) { ink.curve = c; drawCurve(); custom(); refresh(); } });
    const sw = colorSwatch(ink.color, c => { ink.color = c; custom(); refresh(); }, { title: `Ink ${i + 1} color`, size: 26 });
    const nm = textField(ink.name, v => { ink.name = v; custom(); }, { width: 150, onInput: v => { ink.name = v; } });
    syncInks.push(() => { drawCurve(); sw.setValue(ink.color); nm.setValue(ink.name); });
    return h('div.imgd-ink', null, h('span', { style: { minWidth: '44px' } }, `Ink ${i + 1}:`), curve, sw, nm);
  });
  const syncType = () => inkRows.forEach((r, i) => r.classList.toggle('disabled', i >= spec.type));
  const typeSel = select<number>([{ value: 1, label: 'Monotone' }, { value: 2, label: 'Duotone' }, { value: 3, label: 'Tritone' }, { value: 4, label: 'Quadtone' }], spec.type, v => { spec.type = v as any; syncType(); custom(); refresh(); }, { width: 130 });
  const presetSel = select<string>([{ value: 'Custom', label: 'Custom' }, ...Object.keys(DUO_PRESETS).map(k => ({ value: k, label: k }))], 'Custom', v => {
    const p = DUO_PRESETS[v]; if (!p) return;
    const c = JSON.parse(JSON.stringify(p)) as DuotoneSpec;
    spec.type = c.type; c.inks.forEach((ink, i) => Object.assign(spec.inks[i], ink));
    typeSel.setValue(spec.type); syncType(); syncInks.forEach(f => f()); refresh();
  }, { width: 220 });
  const custom = () => presetSel.setValue('Custom');
  syncType();
  const body = h('div.imgd-form', { style: { minWidth: '380px' } },
    dialogRow('Preset:', presetSel), dialogRow('Type:', typeSel), h('div.imgd-inks', null, ...inkRows),
    h('div.imgd-note', null, 'Click a curve box to edit how much of that ink prints at each grey level.'));
  const dlg = openDialog({
    title: 'Duotone Options', body, layout: 'side', buttons: okCancel,
    preview: { checked: preview, onChange: v => { preview = v; refresh(); } },
  });
  refresh();
  const r = await dlg.result;
  clearTimeout(timer);
  setDocPreview(doc, null);
  if (r !== 'ok') return;
  const final: DuotoneSpec = { type: spec.type, inks: spec.inks.slice(0, 4).map(i => ({ color: { ...i.color }, name: i.name, curve: i.curve.slice() })) };
  S.spec = final; S.save();
  doc.history.transaction('Duotone', () => {
    mapRasterPixels(doc, duotonePx(final, inv));
    doc.extra.duotone = final;
    doc.mode = 'Duotone';
  }, 'image');
  docChanged(doc);
}

// ================================================================== INDEXED COLOR
type PaletteKind = 'exact' | 'mac' | 'win' | 'web' | 'uniform' | 'perceptual' | 'selective' | 'adaptive' | 'custom' | 'previous';
type Forced = 'none' | 'bw' | 'primaries' | 'web';
type Dither = 'none' | 'diffusion' | 'pattern' | 'noise';
type Matte = 'none' | 'fg' | 'bg' | 'white' | 'black' | 'gray';
export type Palette = RGB[];

const webPalette = (): Palette => { const p: Palette = []; for (let r = 0; r < 6; r++) for (let g = 0; g < 6; g++) for (let b = 0; b < 6; b++) p.push({ r: r * 51, g: g * 51, b: b * 51 }); return p; };
function macPalette(): Palette {
  const p = webPalette().reverse();
  const ramp = [238, 221, 187, 170, 136, 119, 85, 68, 34, 17];
  for (const v of ramp) p.push({ r: v, g: 0, b: 0 }); for (const v of ramp) p.push({ r: 0, g: v, b: 0 });
  for (const v of ramp) p.push({ r: 0, g: 0, b: v }); for (const v of ramp) p.push({ r: v, g: v, b: v });
  return p.slice(0, 256);
}
function winPalette(): Palette {
  const vga = [[0, 0, 0], [128, 0, 0], [0, 128, 0], [128, 128, 0], [0, 0, 128], [128, 0, 128], [0, 128, 128], [192, 192, 192], [192, 220, 192], [166, 202, 240]];
  const hi = [[255, 251, 240], [160, 160, 164], [128, 128, 128], [255, 0, 0], [0, 255, 0], [255, 255, 0], [0, 0, 255], [255, 0, 255], [0, 255, 255], [255, 255, 255]];
  const p: Palette = vga.map(([r, g, b]) => ({ r, g, b }));
  const web = webPalette();
  for (const c of web) if (p.length < 246) p.push(c);
  while (p.length < 246) p.push({ r: 0, g: 0, b: 0 });
  return [...p, ...hi.map(([r, g, b]) => ({ r, g, b }))];
}
function uniformPalette(n: number): Palette {
  const L = Math.max(2, Math.floor(Math.cbrt(n))), p: Palette = [];
  for (let r = 0; r < L; r++) for (let g = 0; g < L; g++) for (let b = 0; b < L; b++) p.push({ r: Math.round((r * 255) / (L - 1)), g: Math.round((g * 255) / (L - 1)), b: Math.round((b * 255) / (L - 1)) });
  return p;
}
const TABLES: Record<string, () => Palette> = {
  'Black Body': () => Array.from({ length: 256 }, (_, i) => { const t = i / 255; return { r: Math.min(255, t * 3 * 255), g: Math.max(0, Math.min(255, (t * 3 - 1) * 255)), b: Math.max(0, Math.min(255, (t * 3 - 2) * 255)) }; }),
  Grayscale: () => Array.from({ length: 256 }, (_, i) => ({ r: i, g: i, b: i })),
  Spectrum: () => Array.from({ length: 256 }, (_, i) => { const hh = (i / 256) * 6, x = 1 - Math.abs((hh % 2) - 1); const [r, g, b] = hh < 1 ? [1, x, 0] : hh < 2 ? [x, 1, 0] : hh < 3 ? [0, 1, x] : hh < 4 ? [0, x, 1] : hh < 5 ? [x, 0, 1] : [1, 0, x]; return { r: r * 255, g: g * 255, b: b * 255 }; }),
  'System (Mac OS)': macPalette,
  'System (Windows)': winPalette,
};

/** Unique colours of an image (null if more than `max`). */
function exactColors(d: Uint8ClampedArray, max = 256): Palette | null {
  const set = new Set<number>();
  for (let i = 0; i < d.length; i += 4) { if (d[i + 3] < 128) continue; set.add((d[i] << 16) | (d[i + 1] << 8) | d[i + 2]); if (set.size > max) return null; }
  return [...set].map(v => ({ r: v >> 16, g: (v >> 8) & 255, b: v & 255 }));
}

/** Median cut on a 6-bit histogram. weights: per-axis importance (perceptual favours green). */
export function medianCut(d: Uint8ClampedArray, n: number, weights = [1, 1, 1]): Palette {
  const hist = new Uint32Array(262144);
  for (let i = 0; i < d.length; i += 4) if (d[i + 3] >= 128) hist[((d[i] >> 2) << 12) | ((d[i + 1] >> 2) << 6) | (d[i + 2] >> 2)]++;
  const bins: number[] = [];
  for (let k = 0; k < 262144; k++) if (hist[k]) bins.push(k);
  if (!bins.length) return [{ r: 0, g: 0, b: 0 }];
  const ch = (k: number, c: number) => (c === 0 ? k >> 12 : c === 1 ? (k >> 6) & 63 : k & 63);
  type Box = { items: number[]; count: number };
  const boxes: Box[] = [{ items: bins, count: bins.reduce((s, k) => s + hist[k], 0) }];
  const range = (b: Box) => {
    let best = 0, axis = 0;
    for (let c = 0; c < 3; c++) { let lo = 63, hi = 0; for (const k of b.items) { const v = ch(k, c); if (v < lo) lo = v; if (v > hi) hi = v; } const r = (hi - lo) * weights[c]; if (r > best) { best = r; axis = c; } }
    return { best, axis };
  };
  while (boxes.length < n) {
    let bi = -1, score = 0, ax = 0;
    boxes.forEach((b, i) => { if (b.items.length < 2) return; const r = range(b); const s = r.best * Math.sqrt(b.count); if (s > score) { score = s; bi = i; ax = r.axis; } });
    if (bi < 0) break;
    const b = boxes[bi];
    b.items.sort((x, y) => ch(x, ax) - ch(y, ax));
    let acc = 0, cut = 0;
    for (; cut < b.items.length - 2; cut++) { acc += hist[b.items[cut]]; if (acc >= b.count / 2) break; }
    const a = b.items.slice(0, cut + 1), c = b.items.slice(cut + 1);
    const cnt = (l: number[]) => l.reduce((s, k) => s + hist[k], 0);
    boxes.splice(bi, 1, { items: a, count: cnt(a) }, { items: c, count: cnt(c) });
  }
  return boxes.map(b => {
    let r = 0, g = 0, bl = 0, t = 0;
    for (const k of b.items) { const w = hist[k]; r += (ch(k, 0) * 4 + 2) * w; g += (ch(k, 1) * 4 + 2) * w; bl += (ch(k, 2) * 4 + 2) * w; t += w; }
    return { r: Math.round(r / t), g: Math.round(g / t), b: Math.round(bl / t) };
  });
}

/** Nearest-palette lookup with a 6-bit cache. */
function nearestFinder(p: Palette) {
  const cache = new Int16Array(262144).fill(-1);
  const pr = p.map(c => c.r), pg = p.map(c => c.g), pb = p.map(c => c.b), n = p.length;
  return (r: number, g: number, b: number) => {
    r = r < 0 ? 0 : r > 255 ? 255 : r; g = g < 0 ? 0 : g > 255 ? 255 : g; b = b < 0 ? 0 : b > 255 ? 255 : b;
    const key = ((r >> 2) << 12) | ((g >> 2) << 6) | (b >> 2);
    let i = cache[key];
    if (i < 0) {
      let bd = 1e9; i = 0;
      for (let k = 0; k < n; k++) { const dr = r - pr[k], dg = g - pg[k], db = b - pb[k], dd = dr * dr * 2 + dg * dg * 4 + db * db * 3; if (dd < bd) { bd = dd; i = k; } }
      cache[key] = i;
    }
    return i;
  };
}

export interface IndexedOpts { palette: PaletteKind; colors: number; forced: Forced; transparency: boolean; matte: Matte; dither: Dither; amount: number; preserveExact: boolean }
function buildPalette(d: Uint8ClampedArray, o: IndexedOpts, custom: Palette | null): Palette {
  const n = Math.max(2, Math.min(256, Math.round(o.colors)));
  let p: Palette;
  switch (o.palette) {
    case 'exact': p = exactColors(d) || medianCut(d, 256); break;
    case 'mac': p = macPalette(); break;
    case 'win': p = winPalette(); break;
    case 'web': p = webPalette(); break;
    case 'uniform': p = uniformPalette(n); break;
    case 'perceptual': p = medianCut(d, n, [0.8, 1.3, 0.6]); break;
    case 'selective': p = medianCut(d, n, [1, 1.2, 0.8]).map(c => { const w = { r: Math.round(c.r / 51) * 51, g: Math.round(c.g / 51) * 51, b: Math.round(c.b / 51) * 51 }; return Math.abs(w.r - c.r) + Math.abs(w.g - c.g) + Math.abs(w.b - c.b) < 18 ? w : c; }); break;
    case 'custom': case 'previous': p = custom?.length ? custom.slice() : medianCut(d, n); break;
    default: p = medianCut(d, n);
  }
  const forced: Palette = o.forced === 'bw' ? [{ r: 0, g: 0, b: 0 }, { r: 255, g: 255, b: 255 }]
    : o.forced === 'primaries' ? [[0, 0, 0], [255, 255, 255], [255, 0, 0], [0, 255, 0], [0, 0, 255], [0, 255, 255], [255, 0, 255], [255, 255, 0]].map(([r, g, b]) => ({ r, g, b }))
      : o.forced === 'web' ? webPalette() : [];
  if (forced.length) {
    const key = (c: RGB) => (c.r << 16) | (c.g << 8) | c.b, have = new Set(forced.map(key));
    p = [...forced, ...p.filter(c => !have.has(key(c)))].slice(0, Math.max(n, forced.length));
  }
  return p.slice(0, 256);
}
function matteRGB(m: Matte): RGB | null {
  return m === 'fg' ? app.fg : m === 'bg' ? app.bg : m === 'white' ? { r: 255, g: 255, b: 255 } : m === 'black' ? { r: 0, g: 0, b: 0 } : m === 'gray' ? { r: 128, g: 128, b: 128 } : null;
}
/** Quantize RGBA pixels (in place) to `p`. Returns the palette actually used. */
export function quantize(d: Uint8ClampedArray, w: number, hh: number, p: Palette, o: Pick<IndexedOpts, 'transparency' | 'matte' | 'dither' | 'amount' | 'preserveExact'>) {
  const near = nearestFinder(p), amt = o.amount / 100;
  const mt = matteRGB(o.matte) || { r: 255, g: 255, b: 255 };
  const exact = new Set(p.map(c => (c.r << 16) | (c.g << 8) | c.b));
  // flatten alpha: transparent (<50%) stays transparent when Transparency is on, partial alpha is matted
  const n = w * hh, fr = new Float32Array(n), fg = new Float32Array(n), fb = new Float32Array(n), op = new Uint8Array(n);
  for (let q = 0, i = 0; q < n; q++, i += 4) {
    const a = d[i + 3] / 255;
    op[q] = o.transparency ? (a >= 0.5 ? 1 : 0) : 1;
    const bgc = o.transparency && o.matte === 'none' ? { r: d[i], g: d[i + 1], b: d[i + 2] } : mt;
    fr[q] = d[i] * a + bgc.r * (1 - a); fg[q] = d[i + 1] * a + bgc.g * (1 - a); fb[q] = d[i + 2] * a + bgc.b * (1 - a);
  }
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) - 0.5;
  for (let y = 0; y < hh; y++) for (let x = 0; x < w; x++) {
    const q = y * w + x, i = q * 4;
    if (!op[q]) { d[i] = d[i + 1] = d[i + 2] = d[i + 3] = 0; continue; }
    let r = fr[q], g = fg[q], b = fb[q];
    const isExact = o.preserveExact && exact.has((Math.round(r) << 16) | (Math.round(g) << 8) | Math.round(b));
    if (!isExact && o.dither === 'pattern') { const t = (BAYER8[(y & 7) * 8 + (x & 7)] - 0.5) * 64 * amt; r += t; g += t; b += t; }
    else if (!isExact && o.dither === 'noise') { const t = rnd() * 64 * amt; r += t; g += t; b += t; }
    const k = near(Math.round(r), Math.round(g), Math.round(b)), c = p[k];
    d[i] = c.r; d[i + 1] = c.g; d[i + 2] = c.b; d[i + 3] = 255;
    if (o.dither === 'diffusion' && !isExact && amt > 0) {
      const er = (r - c.r) * amt, eg = (g - c.g) * amt, eb = (b - c.b) * amt;
      const push = (qq: number, f: number) => { fr[qq] += er * f; fg[qq] += eg * f; fb[qq] += eb * f; };
      if (x + 1 < w) push(q + 1, 7 / 16);
      if (y + 1 < hh) { if (x > 0) push(q + w - 1, 3 / 16); push(q + w, 5 / 16); if (x + 1 < w) push(q + w + 1, 1 / 16); }
    }
  }
}

async function indexedDialog(doc: PixDocument) {
  const src = compositeData(doc);
  const exactOk = !!exactColors(src.data);
  const S = remember('indexed', { palette: 'selective' as PaletteKind, colors: 256, forced: 'bw' as Forced, transparency: true, matte: 'none' as Matte, dither: 'diffusion' as Dither, amount: 75, preserveExact: false, previous: [] as Palette });
  const o: IndexedOpts = { palette: exactOk ? 'exact' : S.palette === 'exact' ? 'selective' : S.palette, colors: S.colors, forced: S.forced, transparency: S.transparency, matte: S.matte, dither: S.dither, amount: S.amount, preserveExact: S.preserveExact };
  let custom: Palette | null = (doc.extra.indexedPalette as Palette) || (S.previous.length ? S.previous : null);
  const transparentDoc = hasTransparency(doc);
  let preview = true, timer = 0, lastPalette: Palette = [];
  const info = h('span.imgd-note');
  const refresh = () => {
    clearTimeout(timer);
    timer = window.setTimeout(() => {
      if (!preview) { setDocPreview(doc, null); return; }
      const p = buildPalette(src.data, o, custom);
      lastPalette = p;
      info.textContent = `${p.length} colors`;
      setDocPreview(doc, previewFrom(src, d => quantize(d, src.width, src.height, p, o)));
    }, 60);
  };
  const fixedCount = () => ['exact', 'mac', 'win', 'web'].includes(o.palette);
  const colorsIn = numInput(60, v => { o.colors = Math.max(2, Math.min(256, Math.round(v))); colorsIn.show(o.colors); if (o.palette === 'custom' || o.palette === 'previous') { o.palette = 'adaptive'; palSel.setValue('adaptive'); } refresh(); });
  const syncColors = () => { colorsIn.disabled = fixedCount(); colorsIn.show(o.palette === 'exact' ? (exactColors(src.data)?.length ?? 256) : o.palette === 'web' ? 216 : fixedCount() ? 256 : o.colors); };
  const palSel = select<PaletteKind>([
    { value: 'exact', label: 'Exact', disabled: !exactOk }, { value: 'mac', label: 'System (Mac OS)' }, { value: 'win', label: 'System (Windows)' },
    { value: 'web', label: 'Web' }, { value: 'uniform', label: 'Uniform' }, '-',
    { value: 'perceptual', label: 'Local (Perceptual)' }, { value: 'selective', label: 'Local (Selective)' }, { value: 'adaptive', label: 'Local (Adaptive)' }, '-',
    { value: 'custom', label: 'Custom...' }, { value: 'previous', label: 'Previous', disabled: !S.previous.length },
  ], o.palette, async v => {
    o.palette = v;
    if (v === 'custom') { const p = await colorTableEditor(custom || lastPalette, 'Color Table'); if (p) custom = p; else { o.palette = 'adaptive'; palSel.setValue('adaptive'); } }
    if (v === 'previous') custom = S.previous;
    syncColors(); refresh();
  }, { width: 170, title: 'Palette' });
  const forcedSel = select<Forced>([{ value: 'none', label: 'None' }, { value: 'bw', label: 'Black and White' }, { value: 'primaries', label: 'Primaries' }, { value: 'web', label: 'Web' }], o.forced, v => { o.forced = v; refresh(); }, { width: 170 });
  const transCb = checkbox('Transparency', o.transparency && transparentDoc, v => { o.transparency = v; refresh(); });
  if (!transparentDoc) { o.transparency = false; transCb.querySelector('input')!.disabled = true; }
  const matteSel = select<Matte>([{ value: 'none', label: 'None' }, { value: 'fg', label: 'Foreground Color' }, { value: 'bg', label: 'Background Color' }, { value: 'white', label: 'White' }, { value: 'black', label: 'Black' }, { value: 'gray', label: '50% Gray' }], o.matte, v => { o.matte = v; refresh(); }, { width: 170 });
  const amtIn = numInput(50, v => { o.amount = Math.max(0, Math.min(100, Math.round(v))); amtIn.show(o.amount); refresh(); }); amtIn.show(o.amount);
  const exactCb = checkbox('Preserve Exact Colors', o.preserveExact, v => { o.preserveExact = v; refresh(); });
  const syncDither = () => { amtIn.disabled = o.dither === 'none'; exactCb.style.opacity = o.dither === 'diffusion' ? '1' : '.45'; };
  const ditherSel = select<Dither>([{ value: 'none', label: 'None' }, { value: 'diffusion', label: 'Diffusion' }, { value: 'pattern', label: 'Pattern' }, { value: 'noise', label: 'Noise' }], o.dither, v => { o.dither = v; syncDither(); refresh(); }, { width: 120 });
  syncColors(); syncDither();
  const body = h('div.imgd-form', { style: { minWidth: '360px' } },
    h('fieldset.group', null, h('legend', null, 'Palette'), h('div.imgd-form', null,
      dialogRow('Palette:', palSel), dialogRow('Colors:', colorsIn, info), dialogRow('Forced:', forcedSel), dialogRow('', transCb))),
    h('fieldset.group', null, h('legend', null, 'Options'), h('div.imgd-form', null,
      dialogRow('Matte:', matteSel), dialogRow('Dither:', ditherSel), dialogRow('Amount:', amtIn, h('span', null, '%')), dialogRow('', exactCb))));
  const dlg = openDialog({ title: 'Indexed Color', body, layout: 'side', buttons: okCancel, preview: { checked: true, onChange: v => { preview = v; refresh(); } } });
  refresh();
  const r = await dlg.result;
  clearTimeout(timer);
  setDocPreview(doc, null);
  const p = buildPalette(src.data, o, custom);
  Object.assign(S, { ...o, palette: o.palette === 'exact' ? S.palette : o.palette, previous: r === 'ok' ? p : S.previous }); S.save();
  if (r !== 'ok') return;
  document.body.classList.add('busy');
  await new Promise(requestAnimationFrame);
  try {
    doc.history.transaction('Indexed Color', () => {
      const keepAlpha = o.transparency && transparentDoc;
      const layer = flattenDoc(doc, { opaque: !keepAlpha, name: keepAlpha ? 'Index' : 'Background' });
      const img = ctx2d(layer.canvas).getImageData(0, 0, doc.width, doc.height);
      quantize(img.data, doc.width, doc.height, p, o);
      const c = createCanvas(doc.width, doc.height); ctx2d(c).putImageData(img, 0, 0);
      layer.canvas = c;
      doc.extra.indexedPalette = p;
      delete doc.extra.duotone;
      doc.mode = 'Indexed';
    }, 'image');
  } finally { document.body.classList.remove('busy'); }
  docChanged(doc);
}

// ------------------------------------------------------------------ Color Table
/** Palette grid editor. Resolves the edited palette or null. `onLive` previews edits. */
async function colorTableEditor(initial: Palette, title: string, onLive?: (p: Palette) => void): Promise<Palette | null> {
  let pal = initial.map(c => ({ ...c }));
  const grid = h('div.imgd-palette');
  const render = () => {
    grid.replaceChildren(...pal.map((c, i) => {
      const cell = h('div', { title: `Index ${i}: R ${c.r} G ${c.g} B ${c.b}`, style: { background: toCss(c) } });
      cell.addEventListener('click', async () => {
        const n = await hooks.openColorPicker(c, 'Select table color');
        if (n) { pal[i] = n; tableSel.setValue('Custom'); render(); onLive?.(pal); }
      });
      return cell;
    }));
  };
  const tableSel = select<string>([{ value: 'Custom', label: 'Custom' }, ...Object.keys(TABLES).map(k => ({ value: k, label: k }))], 'Custom', v => {
    const f = TABLES[v]; if (!f) return;
    pal = f().map(c => ({ r: Math.round(c.r), g: Math.round(c.g), b: Math.round(c.b) }));
    render(); onLive?.(pal);
  }, { width: 170 });
  render();
  const body = h('div.imgd-form', null, dialogRow('Table:', tableSel), grid, h('div.imgd-note', null, 'Click a color to change it.'));
  const r = await openDialog({ title, body, layout: 'side', buttons: okCancel }).result;
  return r === 'ok' ? pal : null;
}

/** Image › Mode › Color Table… (Indexed documents): edit the palette and remap every pixel. */
export async function colorTableDialog(doc: PixDocument) {
  if (doc.mode !== 'Indexed' || !Array.isArray(doc.extra.indexedPalette)) {
    await alertDialog('Pixora', 'Color Table is only available for Indexed Color images.', 'info');
    return;
  }
  const old: Palette = doc.extra.indexedPalette;
  const idx = new Map<number, number>(old.map((c, i) => [(c.r << 16) | (c.g << 8) | c.b, i]));
  const remapFn = (p: Palette) => (d: Uint8ClampedArray) => {
    for (let i = 0; i < d.length; i += 4) {
      if (!d[i + 3]) continue;
      const k = idx.get((d[i] << 16) | (d[i + 1] << 8) | d[i + 2]);
      if (k !== undefined && p[k]) { d[i] = p[k].r; d[i + 1] = p[k].g; d[i + 2] = p[k].b; }
    }
  };
  const src = compositeData(doc);
  const p = await colorTableEditor(old, 'Color Table', pal => setDocPreview(doc, previewFrom(src, remapFn(pal))));
  setDocPreview(doc, null);
  if (!p) return;
  doc.history.transaction('Color Table', () => { mapRasterPixels(doc, remapFn(p)); doc.extra.indexedPalette = p; }, 'image');
  docChanged(doc);
}

// ------------------------------------------------------------------ bit depth
export function setBitDepth(doc: PixDocument, bits: 8 | 16 | 32) {
  const was = doc.bitDepth;
  if (!bits || bits === was) return;
  const apply = (b: 8 | 16 | 32) => { doc.bitDepth = b; doc.afterHistoryJump(); docChanged(doc); };
  doc.history.push({ name: `${bits} Bits/Channel`, icon: 'image', undo: () => apply(was), redo: () => apply(bits) });
  apply(bits);
}
