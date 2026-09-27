// Edit › Auto-Align Layers: aligns the selected pixel layers on matching content. Projection: Auto, Perspective
// (homography), Collage (rotate / scale / move), Cylindrical, Spherical (panorama projections from the estimated
// focal length) or Reposition (move only). Lens Correction: Vignette Removal and Geometric Distortion are estimated
// from the matches. The layer with a position lock (or the Background) is the reference; otherwise the layer
// that overlaps most with the others.
import './warp.css';
import { app } from '../../core/app';
import type { PixDocument } from '../../core/document';
import { registerCommands } from '../../core/commands';
import { RasterLayer, type Layer } from '../../core/layer';
import { alphaBounds, createCanvas, ctx2d, cropCanvas } from '../../core/canvas';
import type { Rect } from '../../core/types';
import { h } from '../../ui/dom';
import { openDialog } from '../../ui/dialog';
import { checkbox } from '../../ui/widgets';
import { registerIcons, icon } from '../../ui/icons';
import { toast } from '../../ui/toast';
import { renderMapped } from '../transform/geom';
import { apply3, fitLS, focalsFromH, isAffine3, mul3, ransac, residual, undistort, vignetteFit, I3, type M3, type Model, type Pt } from './align-core';

registerIcons({
  'aa-auto': '<rect x="3" y="6" width="8" height="10" rx="1"/><rect x="10" y="8" width="8" height="10" rx="1" transform="rotate(8 14 13)"/><path d="M19 3l.6 1.4L21 5l-1.4.6L19 7l-.6-1.4L17 5l1.4-.6z" fill="currentColor"/>',
  'aa-perspective': '<path d="M3 6l7 1.5v9L3 18z"/><path d="M10 7.5l4-.5v10l-4-.5M14 7l7-1v12l-7-1"/>',
  'aa-collage': '<rect x="3" y="7" width="8" height="9" rx="1"/><rect x="11" y="5" width="9" height="9" rx="1" transform="rotate(-10 15 10)"/>',
  'aa-cylindrical': '<path d="M3 7q9-3 18 0v10q-9-3-18 0z"/><path d="M9 5.6v10.8M15 5.6v10.8"/>',
  'aa-spherical': '<path d="M3 8q9-6 18 0v8q-9 6-18 0z"/><path d="M9 5.5v13M15 5.5v13"/>',
  'aa-reposition': '<rect x="3" y="5" width="9" height="9" rx="1"/><rect x="10" y="10" width="9" height="9" rx="1"/>',
});

export type Projection = 'auto' | 'perspective' | 'collage' | 'cylindrical' | 'spherical' | 'reposition';
export const alignOpts = { projection: 'auto' as Projection, vignette: false, distortion: false };
try { Object.assign(alignOpts, JSON.parse(localStorage.getItem('pixora.autoAlign') || '{}')); } catch { /* ignore */ }

// ------------------------------------------------------------------ inputs
export interface AlignItem { layer: RasterLayer; rect: Rect; canvas: HTMLCanvasElement; k: number }
/** Selected, visible pixel layers with content (≥ 2), or null after telling the user why not. */
export function alignTargets(doc: PixDocument | null, what: string): RasterLayer[] | null {
  if (!doc) return null;
  const sel = doc.selectedLayers.filter(l => l.visible);
  const ras = sel.filter((l: Layer): l is RasterLayer => l instanceof RasterLayer && !!alphaBounds(l.canvas));
  if (ras.length < 2) { toast(`Could not complete the ${what} command because it requires at least two selected pixel layers with content.`, 'error', 4500); return null; }
  if (ras.length < sel.length) toast(`${sel.length - ras.length} selected layer(s) are not pixel layers and were skipped.`, 'info', 3500);
  return ras;
}
function prep(layers: RasterLayer[], maxDim = 800): AlignItem[] {
  return layers.map(l => {
    const b = alphaBounds(l.canvas)!;
    const canvas = cropCanvas(l.canvas, b);
    return { layer: l, rect: { x: l.x + b.x, y: l.y + b.y, w: b.w, h: b.h }, canvas, k: Math.min(1, maxDim / Math.max(b.w, b.h)) };
  });
}
interface PairMatches { i: number; j: number; P: Pt[]; Q: Pt[]; la: number[]; lb: number[] }
let worker: Worker | null = null, wseq = 0;
function computeMatches(items: AlignItem[]): Promise<PairMatches[]> {
  const images = items.map(it => {
    const w = Math.max(24, Math.round(it.rect.w * it.k)), hh = Math.max(24, Math.round(it.rect.h * it.k));
    const c = createCanvas(w, hh), x = c.getContext('2d', { willReadFrequently: true })!;
    x.imageSmoothingQuality = 'high'; x.drawImage(it.canvas, 0, 0, w, hh);
    return { data: x.getImageData(0, 0, w, hh).data, w, h: hh, sx: it.rect.w / w, sy: it.rect.h / hh };
  });
  if (!worker) worker = new Worker(new URL('./align.worker.ts', import.meta.url), { type: 'module' });
  const id = ++wseq, wk = worker;
  return new Promise((ok, err) => {
    const on = (e: MessageEvent) => {
      if (e.data.id !== id) return;
      wk.removeEventListener('message', on);
      if (e.data.error) { err(new Error(e.data.error)); return; }
      const F = e.data.feats as { x: Float32Array; y: Float32Array; lum: Float32Array }[];
      const doc = (k: number, i: number): Pt => [items[k].rect.x + (F[k].x[i] + 0.5) * images[k].sx, items[k].rect.y + (F[k].y[i] + 0.5) * images[k].sy];
      ok((e.data.pairs as { i: number; j: number; m: Int32Array }[]).map(p => {
        const P: Pt[] = [], Q: Pt[] = [], la: number[] = [], lb: number[] = [];
        for (let t = 0; t < p.m.length; t += 2) { P.push(doc(p.i, p.m[t])); Q.push(doc(p.j, p.m[t + 1])); la.push(F[p.i].lum[p.m[t]]); lb.push(F[p.j].lum[p.m[t + 1]]); }
        return { i: p.i, j: p.j, P, Q, la, lb };
      }));
    };
    wk.addEventListener('message', on);
    wk.addEventListener('error', ev => { worker = null; err(new Error(ev.message || 'align worker failed')); }, { once: true });
    wk.postMessage({ id, images: images.map(({ data, w, h }) => ({ data, w, h })) });
  });
}

// ------------------------------------------------------------------ solving
export interface AlignResult {
  items: AlignItem[]; ref: number;
  /** Per item: doc → doc mapping (null = not aligned). */
  maps: (((x: number, y: number) => Pt) | null)[];
  /** Per item: pure matrix when the mapping is projective (fast rendering path). */
  mats: (M3 | null)[];
  vignette: [number, number] | null;
  unaligned: number;
}
export async function solveAlignment(layers: RasterLayer[], o = alignOpts): Promise<AlignResult> {
  const items = prep(layers);
  const pairs = await computeMatches(items);
  const n = items.length, kmin = Math.min(...items.map(i => i.k));
  const thresh = 2.5 / kmin;
  // loose homography per pair → inlier correspondences and graph weights
  const edges: { i: number; j: number; P: Pt[]; Q: Pt[]; la: number[]; lb: number[]; w: number }[] = [];
  for (const p of pairs) {
    const r = ransac('homography', p.P, p.Q, thresh * 1.6, 2000) ?? ransac('similarity', p.P, p.Q, thresh * 1.6, 800);
    if (!r || r.inliers.length < 10) continue;
    edges.push({ i: p.i, j: p.j, P: r.inliers.map(k => p.P[k]), Q: r.inliers.map(k => p.Q[k]), la: r.inliers.map(k => p.la[k]), lb: r.inliers.map(k => p.lb[k]), w: r.inliers.length });
  }
  // reference: position-locked layer, else the best connected one
  let ref = items.findIndex(it => it.layer.positionLocked);
  if (ref < 0) { const score = new Array(n).fill(0); for (const e of edges) { score[e.i] += e.w; score[e.j] += e.w; } ref = score.indexOf(Math.max(...score)); }
  const centre = (k: number): Pt => [items[k].rect.x + items[k].rect.w / 2, items[k].rect.y + items[k].rect.h / 2];
  const halfDiag = (k: number) => Math.hypot(items[k].rect.w, items[k].rect.h) / 2;
  // lens distortion (one k for the whole set): minimise the homography residual of the inliers
  let kd = 0;
  if (o.distortion && edges.length) {
    let best = Infinity;
    for (let k = -0.3; k <= 0.3001; k += 0.01) {
      let err = 0, cnt = 0;
      for (const e of edges) {
        const [ax, ay] = centre(e.i), [bx, by] = centre(e.j);
        const P = e.P.map(p => undistort(p[0], p[1], ax, ay, halfDiag(e.i), k)), Q = e.Q.map(q => undistort(q[0], q[1], bx, by, halfDiag(e.j), k));
        const M = fitLS('homography', P, Q);
        if (!M) { err = Infinity; break; }
        for (let t = 0; t < P.length; t++) { err += Math.min(residual(M, P[t], Q[t]), thresh * 3); cnt++; }
      }
      const m = err / Math.max(1, cnt) + Math.abs(k) * 0.02;               // slight preference for no correction
      if (m < best) { best = m; kd = k; }
    }
  }
  const vignette = o.vignette && edges.length ? vignetteFit(edges.flatMap(e => {
    const [ax, ay] = centre(e.i), [bx, by] = centre(e.j);
    return e.P.map((p, t) => ({ ra: Math.hypot(p[0] - ax, p[1] - ay) / halfDiag(e.i), rb: Math.hypot(e.Q[t][0] - bx, e.Q[t][1] - by) / halfDiag(e.j), la: e.la[t], lb: e.lb[t] }));
  })) : null;
  // focal length for panorama projections: from the pairwise homographies (image-centred coordinates)
  let f = Math.max(...items.map(i => Math.max(i.rect.w, i.rect.h)));
  const proj = o.projection;
  if (proj === 'cylindrical' || proj === 'spherical') {
    const fs: number[] = [];
    for (const e of edges) {
      const [ax, ay] = centre(e.i), [bx, by] = centre(e.j);
      const H = fitLS('homography', e.P.map(p => [p[0] - ax, p[1] - ay] as Pt), e.Q.map(q => [q[0] - bx, q[1] - by] as Pt));
      if (H) fs.push(...focalsFromH(H));
    }
    fs.sort((a, b) => a - b);
    const med = fs[fs.length >> 1];
    if (med && med > f * 0.25 && med < f * 8) f = med;
  }
  // per-item pre-mapping (distortion, then panorama projection around the image centre)
  const pre = items.map((_, k) => {
    const [cx, cy] = centre(k), hd = halfDiag(k);
    return (x: number, y: number): Pt => {
      if (kd) [x, y] = undistort(x, y, cx, cy, hd, kd);
      if (proj === 'cylindrical') { const dx = x - cx; return [cx + f * Math.atan2(dx, f), cy + (f * (y - cy)) / Math.hypot(dx, f)]; }
      if (proj === 'spherical') { const dx = x - cx, dy = y - cy; return [cx + f * Math.atan2(dx, f), cy + f * Math.atan2(dy, Math.hypot(dx, f))]; }
      return [x, y];
    };
  });
  const preIdentity = !kd && proj !== 'cylindrical' && proj !== 'spherical';
  const modelOf = (): Model => {
    if (proj === 'perspective') return 'homography';
    if (proj === 'collage' || proj === 'cylindrical' || proj === 'spherical') return 'similarity';
    if (proj === 'reposition') return 'translation';
    // auto: perspective when it explains clearly more matches than a similarity
    let sh = 0, ss = 0;
    for (const e of edges) {
      const P = e.P.map(p => pre[e.i](p[0], p[1])), Q = e.Q.map(q => pre[e.j](q[0], q[1]));
      sh += ransac('homography', P, Q, thresh, 600)?.inliers.length ?? 0;
      ss += ransac('similarity', P, Q, thresh, 400)?.inliers.length ?? 0;
    }
    return sh > ss * 1.12 ? 'homography' : 'similarity';
  };
  const model = modelOf();
  // maximum spanning tree from the reference (Prim), composing child → parent transforms
  const T: (M3 | null)[] = new Array(n).fill(null);
  T[ref] = I3;
  const done = new Set([ref]);
  while (true) {
    let bestE: (typeof edges)[number] | null = null;
    for (const e of edges) if (done.has(e.i) !== done.has(e.j) && (!bestE || e.w > bestE.w)) bestE = e;
    if (!bestE) break;
    const parent = done.has(bestE.i) ? bestE.i : bestE.j, child = parent === bestE.i ? bestE.j : bestE.i;
    const Pc = (child === bestE.i ? bestE.P : bestE.Q).map(p => pre[child](p[0], p[1]));
    const Pp = (parent === bestE.i ? bestE.P : bestE.Q).map(p => pre[parent](p[0], p[1]));
    const r = ransac(model, Pc, Pp, thresh * 1.5, 1500);
    const M = r ? fitLS(model, r.inliers.map(k => Pc[k]), r.inliers.map(k => Pp[k])) : null;
    done.add(child);
    if (M && T[parent]) T[child] = mul3(T[parent]!, M);
  }
  const maps = items.map((_, k) => { const M = T[k]; if (!M) return null; return (x: number, y: number) => { const [u, v] = pre[k](x, y); return apply3(M, u, v); }; });
  return { items, ref, maps, mats: T.map(M => (M && preIdentity ? M : null)), vignette, unaligned: T.filter(t => !t).length };
}

// ------------------------------------------------------------------ applying
export function devignette(c: HTMLCanvasElement, v: [number, number]): HTMLCanvasElement {
  const w = c.width, hh = c.height, out = createCanvas(w, hh), x = out.getContext('2d', { willReadFrequently: true })!;
  x.drawImage(c, 0, 0);
  const img = x.getImageData(0, 0, w, hh), d = img.data, hd = Math.hypot(w, hh) / 2, cx = w / 2, cy = hh / 2;
  for (let y = 0; y < hh; y++) for (let X = 0; X < w; X++) {
    const r2 = ((X + 0.5 - cx) ** 2 + (y + 0.5 - cy) ** 2) / (hd * hd), g = Math.exp(-(v[0] * r2 + v[1] * r2 * r2)), i = (y * w + X) * 4;
    d[i] = d[i] * g; d[i + 1] = d[i + 1] * g; d[i + 2] = d[i + 2] * g;
  }
  x.putImageData(img, 0, 0);
  return out;
}
/** Render every aligned item; returns new canvases + positions (the caller commits them). */
export function renderAligned(res: AlignResult): ({ canvas: HTMLCanvasElement; x: number; y: number } | null)[] {
  return res.items.map((it, k) => {
    const map = res.maps[k], M = res.mats[k];
    if (!map) return null;
    const src = res.vignette ? devignette(it.canvas, res.vignette) : it.canvas;
    if (M && k === res.ref && M.every((v, i) => Math.abs(v - I3[i]) < 1e-9)) return res.vignette ? { canvas: src, x: it.rect.x, y: it.rect.y } : null;
    if (M && isAffine3(M)) return renderMapped(src, it.rect, { kind: 'affine', m: new DOMMatrix([M[0], M[3], M[1], M[4], M[2], M[5]]) }, 'bicubic', 'final');
    const r = it.rect;
    return renderMapped(src, r, { kind: 'mesh', f: (u, v) => { const [x, y] = map(r.x + u * r.w, r.y + v * r.h); return { x, y }; } }, 'bicubic', 'final');
  });
}

async function autoAlign() {
  const doc = app.activeDoc;
  const layers = alignTargets(doc, 'Auto-Align Layers');
  if (!doc || !layers) return;
  const o = { ...alignOpts };
  const PROJ: [Projection, string, string][] = [['auto', 'Auto', 'Analyses the images and applies Perspective or a collage layout, whichever fits best'], ['perspective', 'Perspective', 'Keeps one image as reference and transforms the others to match its perspective'],
    ['collage', 'Collage', 'Aligns the layers and matches overlapping content without distorting shapes (rotate, scale, move)'], ['cylindrical', 'Cylindrical', 'Displays each image as on an unfolded cylinder — good for wide panoramas'],
    ['spherical', 'Spherical', 'Aligns the images as if mapped to the inside of a sphere — for 360° panoramas'], ['reposition', 'Reposition', 'Aligns the layers and matches overlapping content, but does not transform (stretch or skew) any of them']];
  const tiles = h('div.aa-proj');
  const draw = () => { tiles.replaceChildren(...PROJ.map(([v, label, tip]) => h('button.aa-tile', { type: 'button', class: o.projection === v ? 'on' : '', title: tip, onclick: () => { o.projection = v; draw(); } }, icon(`aa-${v}`, 34), h('span', null, label)))); };
  draw();
  const body = h('div.aa-body', null,
    h('div.aa-head', null, 'Projection'), tiles,
    h('div.aa-head', null, 'Lens Correction'),
    h('div.form-row', null, checkbox('Vignette Removal', o.vignette, v => { o.vignette = v; }, { title: 'Compensate for lens vignetting (darkened corners), estimated from the overlaps' })),
    h('div.form-row', null, checkbox('Geometric Distortion', o.distortion, v => { o.distortion = v; }, { title: 'Compensate for barrel, pincushion or fisheye distortion, estimated from the matches' })),
    h('div.aa-note', null, `${layers.length} layers selected. The reference is the layer with a position lock (or the Background); otherwise the layer that overlaps most.`));
  const dlg = openDialog({ title: 'Auto-Align Layers', body, width: 560, buttons: [{ label: 'OK', primary: true, value: 'ok' }, { label: 'Cancel', value: null }] });
  if ((await dlg.result) !== 'ok') return;
  Object.assign(alignOpts, o);
  localStorage.setItem('pixora.autoAlign', JSON.stringify(alignOpts));
  document.body.classList.add('busy');
  toast('Aligning layers…', 'info', 1500);
  try {
    const res = await solveAlignment(layers, o);
    if (res.unaligned >= res.items.length - 1) { toast('Could not align the layers: not enough matching content was found between them.', 'error', 5000); return; }
    const out = renderAligned(res);
    doc.history.transaction('Auto-Align Layers', () => {
      res.items.forEach((it, k) => {
        const r = out[k];
        if (!r) return;
        const l = it.layer;
        if (l.isBackground && k !== res.ref) return;
        l.canvas = r.canvas; l.x = r.x; l.y = r.y; l.invalidate();
      });
    });
    doc.pixelsChanged(null, null);
    doc.layersChanged();
    if (res.unaligned) toast(`${res.unaligned} layer(s) could not be aligned (no matching content).`, 'info', 4000);
  } catch (err: any) { console.error(err); toast('Auto-Align Layers failed: ' + (err?.message || err), 'error'); }
  finally { document.body.classList.remove('busy'); }
}

registerCommands([{ id: 'edit.autoAlign', label: 'Auto-Align Layers...', enabled: () => (app.activeDoc?.selectedLayers.length ?? 0) >= 2, run: autoAlign }]);
(window as any).__pxAlign = { solveAlignment, renderAligned };
