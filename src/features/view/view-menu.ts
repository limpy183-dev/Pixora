// View menu: Extras, Show ▸ (layer edges, selection edges, target path, grid, guides, count, smart guides, notes,
// pixel grid, all / none), Rulers, Snap / Snap To ▸, Proof Colors, Gamut Warning and Pattern Preview.
import { app } from '../../core/app';
import type { PixDocument } from '../../core/document';
import { events } from '../../core/events';
import { registerCommands } from '../../core/commands';
import { setViewOption, viewOptions, viewportHooks, type ViewOptions } from '../../core/viewport';
import { createCanvas } from '../../core/canvas';
import { xp } from '../prefs/store';
import { fromHex } from '../../core/color';

const SHOW_KEYS = ['layerEdges', 'selectionEdges', 'targetPath', 'grid', 'guides', 'count', 'smartGuides', 'notes', 'pixelGrid'] as const;
const SNAP_KEYS = ['snapGuides', 'snapGrid', 'snapLayers', 'snapBounds'] as const;
const opt = (k: string): boolean => (viewOptions as any)[k] !== false;
const set = (k: string, v: boolean) => setViewOption(k as keyof ViewOptions, v as any);

// ------------------------------------------------------------------ Proof Colors / Gamut Warning (working CMYK simulation)
export const proof = { colors: false, gamut: false, pattern: false };
const INKS = { c: [0, 174, 239], m: [236, 0, 140], y: [255, 242, 0], k: [35, 31, 32] };
const lin = (v: number) => { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
const unlin = (v: number) => 255 * (v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(Math.max(0, v), 1 / 2.4) - 0.055);
let LUT: { rgb: Uint8Array; gamut: Uint8Array } | null = null;
const Q = 64;
/** Printed colour of an RGB value through a simple SWOP-like press model (GCR separation, dot gain, ink absorption). */
function printed(r: number, g: number, b: number): [number, number, number] {
  const R = r / 255, G = g / 255, B = b / 255;
  let c = 1 - R, m = 1 - G, y = 1 - B;
  const k = Math.min(c, m, y) * 0.85;
  if (k < 1) { c = (c - k) / (1 - k); m = (m - k) / (1 - k); y = (y - k) / (1 - k); } else c = m = y = 0;
  const gain = (v: number) => v + 0.18 * 4 * v * (1 - v) * 0.5;
  const cov = [gain(c), gain(m), gain(y), gain(k)], inks = [INKS.c, INKS.m, INKS.y, INKS.k];
  const out: [number, number, number] = [0, 0, 0];
  for (let ch = 0; ch < 3; ch++) {
    let refl = lin(250);
    for (let i = 0; i < 4; i++) refl *= 1 - cov[i] * (1 - lin(inks[i][ch]));
    out[ch] = unlin(refl);
  }
  return out;
}
function buildLUT() {
  const rgb = new Uint8Array(Q * Q * Q * 3), gamut = new Uint8Array(Q * Q * Q);
  for (let ri = 0; ri < Q; ri++) for (let gi = 0; gi < Q; gi++) for (let bi = 0; bi < Q; bi++) {
    const r = (ri * 255) / (Q - 1), g = (gi * 255) / (Q - 1), b = (bi * 255) / (Q - 1), i = (ri * Q + gi) * Q + bi;
    const p = printed(r, g, b);
    const Y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    const ch0 = Math.max(r, g, b) - Math.min(r, g, b), ch1 = Math.max(...p) - Math.min(...p);
    // keep the original colour but limit its chroma to what the press reaches at that value
    let k = 1;
    if (ch0 > ch1 + 2) k = ch1 / ch0;
    const pr = Y + (r - Y) * k, pg = Y + (g - Y) * k, pb = Y + (b - Y) * k;
    const lim = (v: number) => Math.max(26, Math.min(250, v));
    rgb[i * 3] = lim(pr); rgb[i * 3 + 1] = lim(pg); rgb[i * 3 + 2] = lim(pb);
    gamut[i] = ch0 - ch1 > 38 ? 1 : 0;
  }
  LUT = { rgb, gamut };
}
const cache = new WeakMap<PixDocument, { proof: HTMLCanvasElement | null; gamut: HTMLCanvasElement | null; dirty: boolean; timer: number }>();
function entry(doc: PixDocument) { let e = cache.get(doc); if (!e) { e = { proof: null, gamut: null, dirty: true, timer: 0 }; cache.set(doc, e); } return e; }
function recompute(doc: PixDocument) {
  if (!LUT) buildLUT();
  const e = entry(doc), comp = doc.getComposite(), W = comp.width, H = comp.height;
  const rd = createCanvas(W, H), rx = rd.getContext('2d', { willReadFrequently: true })!;
  rx.drawImage(comp, 0, 0);
  const img = rx.getImageData(0, 0, W, H), d = img.data, s = (Q - 1) / 255;
  const gimg = proof.gamut ? rx.createImageData(W, H) : null, gd = gimg?.data;
  // Preferences › Transparency & Gamut › Gamut Warning colour and opacity
  const gc = fromHex(xp.gamutColor) || { r: 128, g: 128, b: 128 }, ga = Math.round((xp.gamutOpacity / 100) * 255);
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] === 0) continue;
    const k = ((Math.round(d[i] * s) * Q + Math.round(d[i + 1] * s)) * Q + Math.round(d[i + 2] * s));
    if (gd && LUT!.gamut[k]) { gd[i] = gc.r; gd[i + 1] = gc.g; gd[i + 2] = gc.b; gd[i + 3] = ga; }
    if (proof.colors) { d[i] = LUT!.rgb[k * 3]; d[i + 1] = LUT!.rgb[k * 3 + 1]; d[i + 2] = LUT!.rgb[k * 3 + 2]; }
  }
  if (proof.colors) { const c = createCanvas(W, H); c.getContext('2d')!.putImageData(img, 0, 0); e.proof = c; } else e.proof = null;
  if (gimg) { const c = createCanvas(W, H); c.getContext('2d')!.putImageData(gimg, 0, 0); e.gamut = c; } else e.gamut = null;
  e.dirty = false;
  app.viewport?.requestRender();
}
function schedule(doc: PixDocument | null | undefined, delay = 140) {
  if (!doc || !(proof.colors || proof.gamut)) return;
  const e = entry(doc);
  e.dirty = true;
  clearTimeout(e.timer);
  e.timer = window.setTimeout(() => recompute(doc), delay);
}
for (const ev of ['layers', 'history', 'docSize'] as const) events.on(ev as any, (d: any) => schedule(d?.doc ?? d ?? app.activeDoc));
events.on('pixels', (p: any) => schedule(p?.doc));
events.on('activeDoc', d => schedule(d as any, 0));

viewportHooks.afterComposite.push((ctx, view, doc) => {
  // Pattern Preview: tile the image around the canvas
  if (proof.pattern) {
    const comp = doc.getComposite();
    view.applyDocTransform(ctx);
    ctx.imageSmoothingEnabled = view.zoom < 1;
    const tl = view.screenToDoc(0, 0), br = view.screenToDoc(view.width, view.height);
    const i0 = Math.floor(Math.min(tl.x, br.x) / doc.width) - 1, i1 = Math.ceil(Math.max(tl.x, br.x) / doc.width) + 1;
    const j0 = Math.floor(Math.min(tl.y, br.y) / doc.height) - 1, j1 = Math.ceil(Math.max(tl.y, br.y) / doc.height) + 1;
    for (let j = Math.max(j0, -20); j <= Math.min(j1, 20); j++) for (let i = Math.max(i0, -20); i <= Math.min(i1, 20); i++) {
      if (!i && !j) continue;
      ctx.fillStyle = '#fff'; ctx.fillRect(i * doc.width, j * doc.height, doc.width, doc.height);
      ctx.drawImage(comp, i * doc.width, j * doc.height);
    }
    ctx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
  }
  if (!(proof.colors || proof.gamut)) return;
  const e = entry(doc);
  if (e.dirty) { schedule(doc, 60); return; }
  view.applyDocTransform(ctx);
  ctx.imageSmoothingEnabled = view.zoom < 1;
  if (proof.colors && e.proof) ctx.drawImage(e.proof, 0, 0);
  if (proof.gamut && e.gamut) ctx.drawImage(e.gamut, 0, 0);
});
function toggleProof(k: 'colors' | 'gamut' | 'pattern') {
  proof[k] = !proof[k];
  const d = app.activeDoc;
  if (d && k !== 'pattern') { entry(d).dirty = true; if (proof.colors || proof.gamut) recompute(d); }
  app.viewport?.requestRender();
  events.emit('view', d!);
}

registerCommands([
  { id: 'view.extras', label: 'Extras', checked: () => viewOptions.extras, run: () => set('extras', !viewOptions.extras) },
  {
    id: 'view.show', label: 'Show',
    checked: (k?: string) => (!k || k === 'all' || k === 'none' ? false : opt(k)),
    run: (k: string) => {
      if (k === 'all') { for (const x of SHOW_KEYS) set(x, true); set('extras', true); return; }
      if (k === 'none') { for (const x of SHOW_KEYS) set(x, false); return; }
      const on = !opt(k);
      set(k, on);
      if (on && !viewOptions.extras) set('extras', true);
    },
  },
  { id: 'view.rulers', label: 'Rulers', checked: () => viewOptions.rulers, run: () => set('rulers', !viewOptions.rulers) },
  { id: 'view.snap', label: 'Snap', checked: () => viewOptions.snap, run: () => set('snap', !viewOptions.snap) },
  {
    id: 'view.snapTo', label: 'Snap To',
    checked: (k?: string) => (k && (SNAP_KEYS as readonly string[]).includes(k) ? !!(viewOptions as any)[k] : false),
    enabled: () => viewOptions.snap,
    run: (k: string) => {
      if (k === 'all') { for (const x of SNAP_KEYS) set(x, true); return; }
      if (k === 'none') { for (const x of SNAP_KEYS) set(x, false); return; }
      set(k, !(viewOptions as any)[k]);
    },
  },
  { id: 'view.proofColors', label: 'Proof Colors', enabled: () => !!app.activeDoc, checked: () => proof.colors, run: () => toggleProof('colors') },
  { id: 'view.gamutWarning', label: 'Gamut Warning', enabled: () => !!app.activeDoc, checked: () => proof.gamut, run: () => toggleProof('gamut') },
  { id: 'view.patternPreview', label: 'Pattern Preview', enabled: () => !!app.activeDoc, checked: () => proof.pattern, run: () => toggleProof('pattern') },
]);
(window as any).__pxProof = { proof, printed, recompute };
