// Shared machinery for the healing tools (Spot Healing Brush, Healing Brush, Patch, Content-Aware Move) and
// Edit > Content-Aware Fill: the inpainting worker, work rectangles, region masks, colour adaptation and the
// final write into the paint target.
import type { PixDocument, PaintTarget } from '../../core/document';
import { RasterLayer } from '../../core/layer';
import { intersectRect } from '../../core/geom';
import type { Rect } from '../../core/types';
import { inpaint } from './inpaint';
import { readRegion } from '../paint/common';
import { blurRGB, healBlend, membrane } from './heal-algo';
import { blendIntoTarget, mix, readTarget, writeTarget, type MixMode } from './common';

// ------------------------------------------------------------------ inpainting worker
let worker: Worker | null = null;
let workerBroken = false;
let seq = 0;
const waiting = new Map<number, { ok: (v: Uint8ClampedArray) => void; err: (e: unknown) => void }>();

function getWorker(): Worker | null {
  if (workerBroken) return null;
  if (worker) return worker;
  try {
    worker = new Worker(new URL('./inpaint.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (e: MessageEvent) => {
      const w = waiting.get(e.data.id);
      if (!w) return;
      waiting.delete(e.data.id);
      if (e.data.error) w.err(new Error(e.data.error)); else w.ok(e.data.out as Uint8ClampedArray);
    };
    worker.onerror = () => {
      workerBroken = true; worker?.terminate(); worker = null;
      for (const w of waiting.values()) w.err(new Error('worker failed'));
      waiting.clear();
    };
  } catch { workerBroken = true; worker = null; }
  return worker;
}

/** Content-aware fill of `hole` (1 = fill) in an RGBA image. Runs in a worker; falls back to the main thread. */
export function runInpaint(data: Uint8ClampedArray, w: number, h: number, hole: Uint8Array, allowed: Uint8Array | null = null, patch = 3): Promise<Uint8ClampedArray> {
  const wk = getWorker();
  const sync = () => inpaint(data, w, h, hole, { allowed, patch });
  if (!wk) return Promise.resolve(sync());
  const id = ++seq;
  return new Promise<Uint8ClampedArray>((ok, err) => {
    waiting.set(id, { ok, err });
    // copies are sent so the caller keeps its buffers
    wk.postMessage({ id, data: new Uint8ClampedArray(data), w, h, hole: hole.slice(), allowed: allowed ? allowed.slice() : null, patch, seed: 12345 });
  }).catch(() => sync());
}

/** Canvas whose pixels are read back often (CPU-backed 2D context). */
export function cpuCanvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w)); c.height = Math.max(1, Math.round(h));
  c.getContext('2d', { willReadFrequently: true });
  return c;
}

// ------------------------------------------------------------------ busy state (one heal at a time)
let busyCount = 0;
export const isBusy = () => busyCount > 0;
export async function withBusy<T>(fn: () => Promise<T>): Promise<T> {
  busyCount++;
  document.body.classList.add('rt-busy');
  try { return await fn(); } finally {
    busyCount--;
    if (!busyCount) document.body.classList.remove('rt-busy');
  }
}

// ------------------------------------------------------------------ geometry
export interface Work {
  /** Work area in document coordinates. */
  R: Rect;
  /** Same area in holder (paint target canvas) coordinates. */
  hr: Rect;
}

/** Make sure a pixel layer covers the document so healing near the edges has pixels to write. */
export function prepareTarget(doc: PixDocument, t: PaintTarget) {
  if (t.kind === 'pixels' && t.layer instanceof RasterLayer) t.layer.ensureRect({ x: 0, y: 0, w: doc.width, h: doc.height });
}

/** Doc rect grown by `margin`, clipped to the document and the target canvas. */
export function workRect(doc: PixDocument, t: PaintTarget, r: Rect, margin: number): Work | null {
  const m = Math.ceil(margin);
  let R = intersectRect({ x: Math.floor(r.x) - m, y: Math.floor(r.y) - m, w: Math.ceil(r.w) + 2 * m, h: Math.ceil(r.h) + 2 * m }, { x: 0, y: 0, w: doc.width, h: doc.height });
  if (!R) return null;
  const h = t.holder;
  R = intersectRect(R, { x: h.x, y: h.y, w: h.canvas.width, h: h.canvas.height });
  if (!R) return null;
  return { R, hr: { x: R.x - h.x, y: R.y - h.y, w: R.w, h: R.h } };
}

/** Region (alpha > 0) and weights (alpha / 255) of a doc-aligned mask canvas over the rect R (doc coords). */
export function regionFromCanvas(mask: HTMLCanvasElement, R: Rect, mx = 0, my = 0, threshold = 1): { region: Uint8Array; weight: Float32Array; count: number } {
  const d = readRegion(mask, R.x - mx, R.y - my, R.w, R.h).data;
  const n = R.w * R.h, region = new Uint8Array(n), weight = new Float32Array(n);
  let count = 0;
  for (let i = 0, j = 3; i < n; i++, j += 4) {
    const a = d[j];
    if (a >= threshold) { region[i] = 1; count++; }
    weight[i] = a / 255;
  }
  return { region, weight, count };
}

// ------------------------------------------------------------------ blending variants
/**
 * Content-aware colour adaptation: S + D where D (membrane of the boundary difference) is fully applied near the
 * edge and scaled by `color` (0..10) inside. `structure` 1..7 = how strictly the source texture is kept.
 */
export function adaptBlend(O: Uint8ClampedArray, S: Uint8ClampedArray, region: Uint8Array, w: number, h: number, structure: number, color: number): Uint8ClampedArray {
  const r = Math.max(0, 7 - Math.round(structure));
  const ob = blurRGB(O, w, h, r), sb = blurRGB(S, w, h, r);
  const D = new Float32Array(w * h * 3);
  for (let i = 0; i < w * h; i++) if (!region[i]) for (let k = 0; k < 3; k++) D[i * 3 + k] = ob[i * 3 + k] - sb[i * 3 + k];
  membrane(D, region, w, h, 3);
  // edge ramp: 1 at the region border, falling to 0 a few pixels inside
  const outside = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) { const v = region[i] ? 0 : 255; outside[i * 4] = outside[i * 4 + 1] = outside[i * 4 + 2] = v; }
  const ramp = blurRGB(outside, w, h, Math.max(2, 8 - Math.round(structure)));
  const f = Math.max(0, Math.min(10, color)) / 10;
  const out = new Uint8ClampedArray(O);
  for (let i = 0; i < w * h; i++) {
    if (!region[i]) continue;
    const e = Math.min(1, (ramp[i * 3] / 255) * 2.2);
    const k = Math.max(f, e);
    const j = i * 4;
    out[j] = S[j] + D[i * 3] * k; out[j + 1] = S[j + 1] + D[i * 3 + 1] * k; out[j + 2] = S[j + 2] + D[i * 3 + 2] * k;
    out[j + 3] = Math.max(O[j + 3], S[j + 3]);
  }
  return out;
}

/** "Transparent" patch: only the texture (high frequencies) of S is transferred onto O. */
export function textureBlend(O: Uint8ClampedArray, S: Uint8ClampedArray, region: Uint8Array, w: number, h: number): Uint8ClampedArray {
  const sb = blurRGB(S, w, h, 3);
  const healed = healBlend(O, S, region, w, h, 5);
  const out = new Uint8ClampedArray(O);
  for (let i = 0; i < w * h; i++) {
    if (!region[i]) continue;
    const j = i * 4;
    for (let k = 0; k < 3; k++) {
      const detail = S[j + k] - sb[i * 3 + k];
      out[j + k] = (O[j + k] + healed[j + k]) / 2 + detail * 0.8;
    }
  }
  return out;
}

/** Plain heal (membrane), re-exported for callers that only import this module. */
export { healBlend };

// ------------------------------------------------------------------ write
const tmp = [0, 0, 0];
/**
 * Blend `res` into the target over `w.hr` using `weight` (× selection) through a retouch mode and record history.
 * `orig` = the target pixels of the rect before the operation (readTarget). Returns true when something changed.
 */
export function commitResult(doc: PixDocument, t: PaintTarget, w: Work, orig: Uint8ClampedArray, res: Uint8ClampedArray, weight: Float32Array, name: string, mode: MixMode = 'normal', icon?: string, useSelection = true): boolean {
  if (mode !== 'normal' && mode !== 'replace') {
    for (let i = 0, j = 0; i < weight.length; i++, j += 4) {
      if (weight[i] <= 0) continue;
      mix(mode, orig[j], orig[j + 1], orig[j + 2], res[j], res[j + 1], res[j + 2], tmp);
      res[j] = tmp[0]; res[j + 1] = tmp[1]; res[j + 2] = tmp[2];
    }
  }
  const out = blendIntoTarget(doc, t, orig, res, weight, w.hr, useSelection);
  const edit = doc.history.beginPixelEdit(t.holder, name, icon);
  writeTarget(t, out, w.hr);
  const changed = edit.commit(name, w.hr, icon);
  if (changed) doc.pixelsChanged(t.layer, w.R);
  return changed;
}

/** Target pixels over the work rect (masks as grey). */
export const readWork = (t: PaintTarget, w: Work, src?: HTMLCanvasElement) => readTarget(t, w.hr, src).data;
