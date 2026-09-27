// Select › Focus Area: selects the in-focus parts of the image (local Laplacian variance), with In-Focus Range,
// Image Noise Level, Soften Edge, view modes and Output To.
import '../../tools/selection/selection.css';
import type { PixDocument } from '../../core/document';
import { createCanvas, ctx2d } from '../../core/canvas';
import { Selection } from '../../core/selection';
import { h } from '../../ui/dom';
import { openDialog } from '../../ui/dialog';
import { checkbox, select, sliderRow } from '../../ui/widgets';
import { boxBlur, fillHoles, focusMap, keepLargest, otsu, smoothMask } from './algo';
import { busy, makeProxy, sampleImage, setSelectionPreview, upsampleToDoc, type PreviewMode } from './ops';
import { OUTPUT_OPTIONS, outputMask, type OutputTo } from './select-and-mask';

const mem = { range: 3.0, auto: true, noise: 0, noiseAuto: true, soften: false, view: 'white' as PreviewMode, output: 'selection' as OutputTo };

export async function openFocusArea(doc: PixDocument): Promise<void> {
  const W = doc.width, H = doc.height;
  const pr = makeProxy(doc.getComposite(), { x: 0, y: 0, w: W, h: H }, 480);
  const { w, h: ph } = pr, n = w * ph;
  const fmap = focusMap(pr.data, w, ph, Math.max(2, Math.round(Math.min(w, ph) / 60)));
  const autoRange = () => Math.max(0, Math.min(7.5, (1 - otsu(fmap)) * 7.5));
  if (mem.auto) mem.range = autoRange();

  /** Binary in-focus mask at proxy resolution (0/255). */
  const compute = (): Uint8Array => {
    const thr = 1 - mem.range / 7.5;                              // higher range → lower sharpness threshold
    const noise = mem.noiseAuto ? 0.04 : mem.noise;
    const f = boxBlur(fmap, w, ph, Math.max(1, Math.round(Math.min(w, ph) / 90)));
    let m: Uint8Array = new Uint8Array(n);
    for (let i = 0; i < n; i++) m[i] = f[i] - noise * 0.5 > thr ? 255 : 0;
    m = smoothMask(m, w, ph, 2, false);
    for (let i = 0; i < n; i++) m[i] = m[i] >= 128 ? 255 : 0;
    m = keepLargest(m, w, ph, 0.04);
    return fillHoles(m, w, ph, n * 0.01);
  };
  let pm = compute();
  let raf = 0;
  const refresh = () => {
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0; pm = compute();
      const c = createCanvas(W, H), x = ctx2d(c);
      x.imageSmoothingEnabled = true;
      x.drawImage(Selection.canvasFromAlpha(pm, w, ph), 0, 0, W, H);
      setSelectionPreview(doc, c, mem.view === 'none' ? 'grayscale' : mem.view);
    });
  };

  const view = select<PreviewMode>([{ value: 'white', label: 'On White' }, { value: 'black', label: 'On Black' }, { value: 'quickmask', label: 'Overlay' }, { value: 'grayscale', label: 'Black & White' }], mem.view, v => { mem.view = v; refresh(); }, { width: 150 });
  const range = sliderRow('In-Focus Range:', Math.round(mem.range * 100) / 100, 0, 7.5, v => { mem.range = v; mem.auto = false; autoBox.setValue(false); refresh(); }, { decimals: 2, step: 0.01 });
  const autoBox = checkbox('Auto', mem.auto, v => { mem.auto = v; if (v) { mem.range = autoRange(); range.setValue(Math.round(mem.range * 100) / 100); refresh(); } });
  const noise = sliderRow('Image Noise Level:', mem.noise * 100, 0, 100, v => { mem.noise = v / 100; mem.noiseAuto = false; noiseAuto.setValue(false); refresh(); }, { unit: '%' });
  const noiseAuto = checkbox('Auto', mem.noiseAuto, v => { mem.noiseAuto = v; refresh(); });
  const soften = checkbox('Soften Edge', mem.soften, v => { mem.soften = v; });
  const out = select(OUTPUT_OPTIONS, mem.output, v => { mem.output = v; }, { width: 200 });
  const body = h('div.cr-body', null,
    h('div.cr-row', null, h('span', null, 'View:'), view),
    h('div.sel-fieldset', null, h('div.sel-legend', null, 'Parameters'), range, autoBox),
    h('div.sel-fieldset', null, h('div.sel-legend', null, 'Advanced'), noise, noiseAuto),
    h('div.sel-fieldset', null, h('div.sel-legend', null, 'Output'), soften, h('div.cr-row', null, h('span', null, 'Output To:'), out)),
  );
  const dlg = openDialog({ title: 'Focus Area', body, layout: 'side', modal: false });
  const r = dlg.el.getBoundingClientRect();
  Object.assign(dlg.el.style, { position: 'fixed', margin: '0', left: Math.max(8, window.innerWidth - r.width - 330) + 'px', top: '90px' });
  refresh();
  const ok = await dlg.result;
  setSelectionPreview(null, null);
  if (!ok) return;
  const alpha = await busy('Focus Area…', () => {
    const f = new Float32Array(n);
    for (let i = 0; i < n; i++) f[i] = pm[i] / 255;
    return upsampleToDoc(doc, sampleImage(doc, true), pr, f, { hard: !mem.soften, contrast: mem.soften ? 1.2 : 2.2 });
  });
  outputMask(doc, alpha, mem.output, 'Focus Area');
}
