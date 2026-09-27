// Edit › Auto-Blend Layers: builds layer masks for the selected (aligned) pixel layers.
//  • Panorama — every point is taken from the image whose edge is farthest away (seams run through the middle of
//    the overlaps).
//  • Stack Images — every point is taken from the sharpest layer (focus stacking).
// Seamless Tones and Colors matches the exposure / colour of the layers (gain compensation) and softens the seams;
// Content Aware Fill Transparent Areas adds a merged layer with the empty areas filled.
import './warp.css';
import { app } from '../../core/app';
import { registerCommands } from '../../core/commands';
import { RasterLayer, createMask } from '../../core/layer';
import { createCanvas, ctx2d } from '../../core/canvas';
import { renderLayersToCanvas } from '../../core/compositor';
import { h } from '../../ui/dom';
import { openDialog } from '../../ui/dialog';
import { checkbox } from '../../ui/widgets';
import { registerIcons, icon } from '../../ui/icons';
import { toast } from '../../ui/toast';
import { solve } from './align-core';
import { alignTargets } from './auto-align';
import { runInpaint } from '../../tools/retouch/heal-core';

registerIcons({
  'ab-panorama': '<rect x="2" y="7" width="9" height="10" rx="1"/><rect x="8" y="6" width="9" height="10" rx="1"/><rect x="14" y="7" width="8" height="10" rx="1"/>',
  'ab-stack': '<path d="M12 3 3 8l9 5 9-5z"/><path d="m3 12 9 5 9-5M3 16l9 5 9-5"/>',
});
type Method = 'panorama' | 'stack';
const opts = { method: 'panorama' as Method, seamless: true, fill: false };
try { Object.assign(opts, JSON.parse(localStorage.getItem('pixora.autoBlend') || '{}')); } catch { /* ignore */ }

// ------------------------------------------------------------------ helpers (work resolution)
interface Img { rgb: Float32Array; a: Float32Array }
function read(doc: { width: number; height: number }, l: RasterLayer, W: number, H: number, s: number): Img {
  const c = createCanvas(W, H), x = c.getContext('2d', { willReadFrequently: true })!;
  x.imageSmoothingQuality = 'high';
  x.setTransform(s, 0, 0, s, 0, 0); x.drawImage(l.canvas, l.x, l.y);
  const d = x.getImageData(0, 0, W, H).data, rgb = new Float32Array(W * H * 3), a = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++) { a[i] = d[i * 4 + 3] / 255; rgb[i * 3] = d[i * 4]; rgb[i * 3 + 1] = d[i * 4 + 1]; rgb[i * 3 + 2] = d[i * 4 + 2]; }
  void doc;
  return { rgb, a };
}
/** Chamfer distance (3-4) from transparent pixels. */
function distance(a: Float32Array, W: number, H: number): Float32Array {
  const D = new Float32Array(W * H), INF = 1e9;
  for (let i = 0; i < W * H; i++) D[i] = a[i] > 0.5 ? INF : 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x; if (!D[i]) continue;
    let v = D[i];
    v = Math.min(v, x > 0 ? D[i - 1] + 3 : 3, y > 0 ? D[i - W] + 3 : 3, x > 0 && y > 0 ? D[i - W - 1] + 4 : 4, x < W - 1 && y > 0 ? D[i - W + 1] + 4 : 4);
    if (x === 0 || y === 0) v = Math.min(v, 3);
    D[i] = v;
  }
  for (let y = H - 1; y >= 0; y--) for (let x = W - 1; x >= 0; x--) {
    const i = y * W + x; if (!D[i]) continue;
    let v = D[i];
    v = Math.min(v, x < W - 1 ? D[i + 1] + 3 : 3, y < H - 1 ? D[i + W] + 3 : 3, x < W - 1 && y < H - 1 ? D[i + W + 1] + 4 : 4, x > 0 && y < H - 1 ? D[i + W - 1] + 4 : 4);
    D[i] = v;
  }
  return D;
}
function blur(src: Float32Array, W: number, H: number, r: number): Float32Array {
  if (r < 1) return src;
  const tmp = new Float32Array(W * H), out = new Float32Array(W * H);
  for (let pass = 0; pass < 2; pass++) {                       // two box passes ≈ Gaussian
    const inp = pass ? out.slice() : src;
    for (let y = 0; y < H; y++) { let s = 0; const o = y * W; for (let x = -r; x <= r; x++) s += inp[o + Math.min(W - 1, Math.max(0, x))]; for (let x = 0; x < W; x++) { tmp[o + x] = s / (2 * r + 1); s += inp[o + Math.min(W - 1, x + r + 1)] - inp[o + Math.max(0, x - r)]; } }
    for (let x = 0; x < W; x++) { let s = 0; for (let y = -r; y <= r; y++) s += tmp[Math.min(H - 1, Math.max(0, y)) * W + x]; for (let y = 0; y < H; y++) { out[y * W + x] = s / (2 * r + 1); s += tmp[Math.min(H - 1, y + r + 1) * W + x] - tmp[Math.max(0, y - r) * W + x]; } }
  }
  return out;
}
/** Per-layer RGB gains that equalise the overlaps (Brown & Lowe gain compensation). */
function gains(imgs: Img[], N: number): number[][] {
  const n = imgs.length, out: number[][] = [];
  for (let c = 0; c < 3; c++) {
    const A = new Array(n * n).fill(0), b = new Array(n).fill(0), sn = 10, sg = 0.1;
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
      let cnt = 0, mi = 0, mj = 0;
      for (let p = 0; p < N; p += 2) if (imgs[i].a[p] > 0.9 && imgs[j].a[p] > 0.9) { cnt++; mi += imgs[i].rgb[p * 3 + c]; mj += imgs[j].rgb[p * 3 + c]; }
      if (cnt < 50) continue;
      mi /= cnt; mj /= cnt;
      const w = cnt / 1000;
      // Σ w (gi mi − gj mj)² / sn² + Σ w (1 − g)² / sg²
      A[i * n + i] += w * mi * mi / (sn * sn) + w / (sg * sg); A[j * n + j] += w * mj * mj / (sn * sn) + w / (sg * sg);
      A[i * n + j] -= w * mi * mj / (sn * sn); A[j * n + i] -= w * mi * mj / (sn * sn);
      b[i] += w / (sg * sg); b[j] += w / (sg * sg);
    }
    for (let i = 0; i < n; i++) if (!A[i * n + i]) { A[i * n + i] = 1; b[i] = 1; }
    const g = solve(A, b, n) ?? new Array(n).fill(1);
    out.push(g.map(v => Math.max(0.5, Math.min(2, v))));
  }
  return imgs.map((_, i) => [out[0][i], out[1][i], out[2][i]]);
}
function scaled(c: HTMLCanvasElement, g: number[]): HTMLCanvasElement {
  const o = createCanvas(c.width, c.height), x = o.getContext('2d', { willReadFrequently: true })!;
  x.drawImage(c, 0, 0);
  const img = x.getImageData(0, 0, o.width, o.height), d = img.data;
  for (let i = 0; i < d.length; i += 4) { d[i] = d[i] * g[0]; d[i + 1] = d[i + 1] * g[1]; d[i + 2] = d[i + 2] * g[2]; }
  x.putImageData(img, 0, 0);
  return o;
}

// ------------------------------------------------------------------ blending
export async function autoBlendLayers(layers: RasterLayer[], o = opts): Promise<boolean> {
  const doc = app.activeDoc!;
  const s = Math.min(1, (o.method === 'stack' ? 1800 : 1200) / Math.max(doc.width, doc.height));
  const W = Math.max(1, Math.round(doc.width * s)), H = Math.max(1, Math.round(doc.height * s)), N = W * H;
  const imgs = layers.map(l => read(doc, l, W, H, s));
  const g = o.seamless ? gains(imgs, N) : null;
  if (g) for (const [i, im] of imgs.entries()) for (let p = 0; p < N; p++) for (let c = 0; c < 3; c++) im.rgb[p * 3 + c] *= g[i][c];
  // score per layer and pixel → label
  const score = imgs.map(im => {
    if (o.method === 'panorama') return distance(im.a, W, H);
    const L = new Float32Array(N), E = new Float32Array(N);
    for (let p = 0; p < N; p++) L[p] = 0.299 * im.rgb[p * 3] + 0.587 * im.rgb[p * 3 + 1] + 0.114 * im.rgb[p * 3 + 2];
    for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) { const p = y * W + x; E[p] = Math.abs(4 * L[p] - L[p - 1] - L[p + 1] - L[p - W] - L[p + W]); }
    const B = blur(E, W, H, Math.max(2, Math.round(6 * s)));
    for (let p = 0; p < N; p++) if (im.a[p] < 0.5) B[p] = -1;
    return B;
  });
  const label = new Int16Array(N).fill(-1);
  for (let p = 0; p < N; p++) {
    let best = -1, bv = -Infinity;
    for (let i = 0; i < imgs.length; i++) { if (imgs[i].a[p] <= 0.01) continue; const v = score[i][p]; if (v > bv + 1e-6) { bv = v; best = i; } }
    label[p] = best;
  }
  // stack: where every layer is flat the choice is arbitrary — let the neighbourhood decide
  if (o.method === 'stack') {
    const votes = imgs.map((_, i) => blur(Float32Array.from(label, v => (v === i ? 1 : 0)), W, H, Math.max(2, Math.round(10 * s))));
    for (let p = 0; p < N; p++) { if (label[p] < 0) continue; const flat = score.every(sc => sc[p] < 1.5); if (!flat) continue; let b = label[p], bv = -1; votes.forEach((v, i) => { if (imgs[i].a[p] > 0.01 && v[p] > bv) { bv = v[p]; b = i; } }); label[p] = b; }
  }
  // soft weights: one-hot labels blurred (wider for seamless), limited to each layer's pixels, normalised
  const r = Math.max(1, Math.round((o.seamless ? (o.method === 'panorama' ? 16 : 4) : 1) * Math.max(0.5, s * 1.5)));
  const wts = imgs.map((im, i) => { const w = blur(Float32Array.from(label, v => (v === i ? 1 : 0)), W, H, r); for (let p = 0; p < N; p++) w[p] *= im.a[p] > 0.01 ? 1 : 0; return w; });
  // layer masks bottom → top: m_k = w_k / Σ_{j≤k} w_j
  const acc = new Float32Array(N), masks: HTMLCanvasElement[] = [];
  for (let k = 0; k < imgs.length; k++) {
    const c = createCanvas(W, H), x = ctx2d(c), img = x.createImageData(W, H);
    for (let p = 0; p < N; p++) {
      acc[p] += wts[k][p];
      img.data[p * 4 + 3] = k === 0 ? (label[p] >= 0 || imgs[k].a[p] > 0 ? 255 : 0) : acc[p] > 1e-6 ? Math.round((255 * wts[k][p]) / acc[p]) : 0;
    }
    x.putImageData(img, 0, 0);
    const full = createCanvas(doc.width, doc.height), fx = ctx2d(full);
    fx.imageSmoothingQuality = 'high'; fx.drawImage(c, 0, 0, doc.width, doc.height);
    masks.push(full);
  }
  const newCanvases = g ? layers.map((l, i) => scaled(l.canvas, g[i])) : null;
  // optional merged + filled layer
  let merged: HTMLCanvasElement | null = null;
  if (o.fill) {
    const tmp = layers.map((l, i) => { const t = new RasterLayer(1, 1, l.name); t.canvas = newCanvases ? newCanvases[i] : l.canvas; t.x = l.x; t.y = l.y; t.opacity = l.opacity; t.blendMode = l.blendMode; t.mask = { ...createMask(doc, 0), canvas: masks[i] }; return t; });
    merged = renderLayersToCanvas(doc, tmp);
    merged = await fillTransparent(merged);
  }
  doc.history.transaction('Auto-Blend Layers', () => {
    layers.forEach((l, i) => {
      if (newCanvases) l.canvas = newCanvases[i];
      l.mask = { ...createMask(doc, 0), canvas: masks[i] };
      l.invalidate();
    });
    if (merged) {
      const top = layers[layers.length - 1];
      const nl = new RasterLayer(1, 1, `${top.name} (merged)`);
      nl.canvas = merged; nl.x = 0; nl.y = 0;
      doc.addLayer(nl, { above: top, select: true });
    }
  });
  doc.pixelsChanged(null, null);
  doc.layersChanged();
  return true;
}
/** Fill the transparent parts of a doc-sized canvas by content-aware inpainting (reduced resolution). */
async function fillTransparent(c: HTMLCanvasElement): Promise<HTMLCanvasElement> {
  const k = Math.min(1, 700 / Math.max(c.width, c.height)), w = Math.max(1, Math.round(c.width * k)), hh = Math.max(1, Math.round(c.height * k));
  const sm = createCanvas(w, hh), sx = sm.getContext('2d', { willReadFrequently: true })!;
  sx.drawImage(c, 0, 0, w, hh);
  const d = sx.getImageData(0, 0, w, hh), hole = new Uint8Array(w * hh);
  let any = false;
  for (let i = 0; i < w * hh; i++) if (d.data[i * 4 + 3] < 250) { hole[i] = 1; any = true; }
  if (!any) return c;
  // un-premultiply the partly covered edge by treating it as hole too (dilate by one pixel)
  const hole2 = hole.slice();
  for (let y = 0; y < hh; y++) for (let x = 0; x < w; x++) if (hole[y * w + x]) for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const X = x + dx, Y = y + dy; if (X >= 0 && Y >= 0 && X < w && Y < hh) hole2[Y * w + X] = 1; }
  for (let i = 0; i < w * hh; i++) if (hole2[i]) d.data[i * 4 + 3] = 0;
  const res = await runInpaint(d.data, w, hh, hole2);
  const fc = createCanvas(w, hh); ctx2d(fc).putImageData(new ImageData(new Uint8ClampedArray(res), w, hh), 0, 0);
  const out = createCanvas(c.width, c.height), ox = ctx2d(out);
  ox.imageSmoothingQuality = 'high'; ox.drawImage(fc, 0, 0, c.width, c.height);
  ox.drawImage(c, 0, 0);
  return out;
}

async function autoBlend() {
  const doc = app.activeDoc;
  const layers = alignTargets(doc, 'Auto-Blend Layers');
  if (!doc || !layers) return;
  const o = { ...opts };
  const tiles = h('div.ab-methods');
  const draw = () => tiles.replaceChildren(
    h('button.aa-tile', { type: 'button', class: o.method === 'panorama' ? 'on' : '', title: 'Blend overlapping layers into a panorama', onclick: () => { o.method = 'panorama'; draw(); } }, icon('ab-panorama', 30), h('span', null, 'Panorama')),
    h('button.aa-tile', { type: 'button', class: o.method === 'stack' ? 'on' : '', title: 'Take the best detail (sharpest focus) of each area from the layers', onclick: () => { o.method = 'stack'; draw(); } }, icon('ab-stack', 30), h('span', null, 'Stack Images')));
  draw();
  const body = h('div.aa-body', null,
    h('div.aa-head', null, 'Blend Method'), tiles,
    h('div.form-row', null, checkbox('Seamless Tones and Colors', o.seamless, v => { o.seamless = v; }, { title: 'Match colour and tone between the layers and soften the seams' })),
    h('div.form-row', null, checkbox('Content Aware Fill Transparent Areas', o.fill, v => { o.fill = v; }, { title: 'Add a merged layer with the transparent areas filled from the surrounding content' })),
    h('div.aa-note', null, `${layers.length} layers selected. Align them first (Edit › Auto-Align Layers). Layer masks are added to the layers.`));
  const dlg = openDialog({ title: 'Auto-Blend Layers', body, width: 440, buttons: [{ label: 'OK', primary: true, value: 'ok' }, { label: 'Cancel', value: null }] });
  if ((await dlg.result) !== 'ok') return;
  Object.assign(opts, o);
  localStorage.setItem('pixora.autoBlend', JSON.stringify(opts));
  document.body.classList.add('busy');
  toast('Blending layers…', 'info', 1500);
  await new Promise(r => setTimeout(r, 30));
  try { await autoBlendLayers(layers, o); }
  catch (err: any) { console.error(err); toast('Auto-Blend Layers failed: ' + (err?.message || err), 'error'); }
  finally { document.body.classList.remove('busy'); }
}

registerCommands([{ id: 'edit.autoBlend', label: 'Auto-Blend Layers...', enabled: () => (app.activeDoc?.selectedLayers.length ?? 0) >= 2, run: autoBlend }]);
(window as any).__pxBlend = { autoBlendLayers };
