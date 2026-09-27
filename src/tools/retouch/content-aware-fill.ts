// Edit > Content-Aware Fill...: fills the selection with detail synthesized from the rest of the image
// (PatchMatch inpainting in a worker). Options: sampling area, sample all layers, colour adaptation, output to
// the current layer / a new layer / a duplicate layer. A live preview of the fill is shown in the dialog.
import { app } from '../../core/app';
import type { PixDocument } from '../../core/document';
import { RasterLayer } from '../../core/layer';
import { registerCommand } from '../../core/commands';
import { cloneCanvas, createCanvas, ctx2d } from '../../core/canvas';
import type { Rect } from '../../core/types';
import { h } from '../../ui/dom';
import { openDialog } from '../../ui/dialog';
import { checkbox, select } from '../../ui/widgets';
import { toast } from '../../ui/toast';
import { fail, readImg, retouchTarget, sampleImage } from './common';
import { dilate } from './heal-algo';
import { commitResult, healBlend, isBusy, prepareTarget, readWork, regionFromCanvas, runInpaint, withBusy, workRect, type Work } from './heal-core';

export type CafSampling = 'auto' | 'rectangular' | 'all';
export interface CafOptions { sampling: CafSampling; sampleAll: boolean; colorAdapt: boolean; output: 'current' | 'new' | 'duplicate' }

const opts: CafOptions = (() => {
  const d: CafOptions = { sampling: 'auto', sampleAll: false, colorAdapt: true, output: 'current' };
  try { return { ...d, ...JSON.parse(localStorage.getItem('pixora.contentAwareFill') || '{}') }; } catch { return d; }
})();

/** Doc rect used as sampling area for the selection bounds B. */
function samplingRect(doc: PixDocument, B: Rect, s: CafSampling): Rect {
  if (s === 'all') return { x: 0, y: 0, w: doc.width, h: doc.height };
  const size = Math.max(B.w, B.h);
  const m = s === 'rectangular' ? Math.max(24, size * 0.5) : Math.min(600, Math.max(48, size * 1.3 + 32));
  return { x: B.x - m, y: B.y - m, w: B.w + 2 * m, h: B.h + 2 * m };
}

interface Plan { w: Work; region: Uint8Array; weight: Float32Array; I: Uint8ClampedArray; hole: Uint8Array }
function plan(doc: PixDocument, o: CafOptions): Plan | null {
  const t = doc.getPaintTarget();
  if (!t || doc.selection.empty) return null;
  const B = doc.selection.bounds!;
  const S = samplingRect(doc, B, o.sampling);
  const w = workRect(doc, t, S, 0);
  if (!w) return null;
  const { region, weight, count } = regionFromCanvas(doc.selection.mask!, w.R);
  if (!count) return null;
  const img = sampleImage(doc, o.sampleAll ? 'all' : 'current', t);
  const I = readImg(img, w.R).data;
  return { w, region, weight, I, hole: dilate(region, w.R.w, w.R.h, 1) };
}

async function compute(p: Plan, o: CafOptions): Promise<Uint8ClampedArray> {
  const { R } = p.w;
  let res = await runInpaint(p.I, R.w, R.h, p.hole);
  if (o.colorAdapt) res = healBlend(p.I, res, p.hole, R.w, R.h, 3);
  return res;
}

/** Fill the selection content-aware (used by the dialog and by Edit > Fill > Content-Aware). */
export async function contentAwareFill(doc: PixDocument, o: CafOptions = opts, historyName = 'Content-Aware Fill'): Promise<boolean> {
  if (doc.selection.empty) { fail(`Could not complete the ${historyName} command because there is no selection.`); return false; }
  let t = retouchTarget(doc, 'content-aware fill');
  if (!t) return false;
  if (t.isMask && o.output !== 'current') { fail('Could not output to a new layer because the target is a mask.'); return false; }
  prepareTarget(doc, t);
  const p = plan(doc, o);
  if (!p) { fail(`Could not complete the ${historyName} command because the selected area is empty.`); return false; }
  const holderCanvas = t.holder.canvas;
  const res = await withBusy(() => compute(p, o));
  if (t.holder.canvas !== holderCanvas) return false;
  const weight = p.weight;
  doc.history.transaction(historyName, () => {
    if (o.output !== 'current') {
      const src = t!.layer as RasterLayer;
      const nl = o.output === 'new' ? new RasterLayer(doc.width, doc.height, `${src.name} Fill`) : new RasterLayer(1, 1, `${src.name} copy`);
      if (o.output === 'duplicate') { nl.canvas = cloneCanvas(src.canvas); nl.x = src.x; nl.y = src.y; }
      doc.addLayer(nl, { above: src, select: true });
      t = doc.getPaintTarget()!;
      prepareTarget(doc, t);
    }
    const w = workRect(doc, t!, p.w.R, 0)!;
    const O = readWork(t!, w);
    commitResult(doc, t!, w, O, res, weight, historyName, 'normal', 'content-aware-fill', false);
  });
  return true;
}

// ------------------------------------------------------------------ dialog
async function openContentAwareFill() {
  const doc = app.activeDoc;
  if (!doc) return;
  if (isBusy()) return;
  if (doc.selection.empty) { fail('Could not complete the Content-Aware Fill command because there is no selection.'); return; }
  if (!retouchTarget(doc, 'content-aware fill')) return;
  const o: CafOptions = { ...opts };
  const PW = 360, PH = 260;
  const pv = createCanvas(PW, PH);
  pv.className = 'caf-preview';
  const status = h('div.caf-status', null, '');
  let token = 0;
  const renderPreview = async () => {
    const my = ++token;
    const p = plan(doc, o);
    const x = ctx2d(pv);
    x.clearRect(0, 0, PW, PH);
    if (!p) { status.textContent = 'Nothing to fill.'; return; }
    status.textContent = 'Computing preview…';
    const res = await compute(p, o);
    if (my !== token) return;
    const { R } = p.w;
    const img = new ImageData(new Uint8ClampedArray(p.I), R.w, R.h);
    for (let i = 0, j = 0; i < p.weight.length; i++, j += 4) {
      const k = p.weight[i];
      if (k <= 0) continue;
      for (let c = 0; c < 4; c++) img.data[j + c] = p.I[j + c] * (1 - k) + res[j + c] * k;
    }
    const c = createCanvas(R.w, R.h); ctx2d(c).putImageData(img, 0, 0);
    const sc = Math.min(PW / R.w, PH / R.h);
    x.imageSmoothingQuality = 'high';
    x.drawImage(c, (PW - R.w * sc) / 2, (PH - R.h * sc) / 2, R.w * sc, R.h * sc);
    // sampling area outline = whole preview; selection outline in green like the workspace overlay
    status.textContent = `Sampling area: ${R.w} × ${R.h} px`;
  };
  const changed = () => { localStorage.setItem('pixora.contentAwareFill', JSON.stringify(o)); void renderPreview(); };
  const body = h('div.caf-body', null,
    pv, status,
    h('div.form-row', null, h('label.form-label', null, 'Sampling Area:'),
      select<CafSampling>([{ value: 'auto', label: 'Auto' }, { value: 'rectangular', label: 'Rectangular' }, { value: 'all', label: 'Entire Image' }], o.sampling, v => { o.sampling = v; changed(); }, { width: 140, title: 'Area the fill takes its content from' })),
    h('div.form-row', null, checkbox('Sample All Layers', o.sampleAll, v => { o.sampleAll = v; changed(); }, { title: 'Use the visible composite instead of the current layer' })),
    h('div.form-row', null, checkbox('Color Adaptation', o.colorAdapt, v => { o.colorAdapt = v; changed(); }, { title: 'Blend the fill into the surrounding colours and brightness' })),
    h('div.form-row', null, h('label.form-label', null, 'Output To:'),
      select<CafOptions['output']>([{ value: 'current', label: 'Current Layer' }, { value: 'new', label: 'New Layer' }, { value: 'duplicate', label: 'Duplicate Layer' }], o.output, v => { o.output = v; localStorage.setItem('pixora.contentAwareFill', JSON.stringify(o)); }, { width: 140, title: 'Where the fill result is written' })),
  );
  const dlg = openDialog({ title: 'Content-Aware Fill', body, layout: 'side', buttons: [{ label: 'OK', primary: true, value: 'ok' }, { label: 'Cancel', value: null }] });
  void renderPreview();
  const r = await dlg.result;
  token++;
  if (r !== 'ok') return;
  Object.assign(opts, o);
  toast('Content-Aware Fill…', 'info', 1200);
  await contentAwareFill(doc, o);
}

registerCommand({
  id: 'edit.contentAwareFill', label: 'Content-Aware Fill...',
  run: openContentAwareFill,
  enabled: () => !!app.activeDoc && !app.activeDoc.selection.empty,
});
