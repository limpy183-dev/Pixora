// Image › Apply Image… and Image › Calculations… — channel / layer blending between documents of the same size.
import { app } from '../../core/app';
import { PixDocument } from '../../core/document';
import { GroupLayer, type Layer } from '../../core/layer';
import type { BlendMode } from '../../core/types';
import { BLEND_MODE_LABELS } from '../../core/types';
import { createCanvas, ctx2d } from '../../core/canvas';
import { renderLayersToCanvas, blendOnto } from '../../core/compositor';
import { pixelOpPreview } from '../../core/pixelops';
import { luma } from '../../core/color';
import { openDialog } from '../../ui/dialog';
import { h } from '../../ui/dom';
import { checkbox, select } from '../../ui/widgets';
import { docChanged, setDocPreview } from './ops';
import { dialogRow, numInput } from './ui';

type Channel = 'rgb' | 'gray' | 'red' | 'green' | 'blue' | 'alpha' | 'selection' | `ch:${number}`;
export interface SourceSpec { doc: PixDocument; layer: 'merged' | number; channel: Channel; invert: boolean }
type ApplyBlend = BlendMode | 'add' | 'subtract';
const BLENDS: (ApplyBlend | '-')[] = [
  'normal', '-', 'darken', 'multiply', 'color-burn', 'linear-burn', 'darker-color', '-', 'lighten', 'screen', 'color-dodge', 'linear-dodge', 'lighter-color', '-',
  'overlay', 'soft-light', 'hard-light', 'vivid-light', 'linear-light', 'pin-light', 'hard-mix', '-', 'add', 'subtract', '-', 'difference', 'exclusion', 'divide',
];
const blendOptions = BLENDS.map(b => (b === '-' ? '-' as const : { value: b, label: b === 'add' ? 'Add' : b === 'subtract' ? 'Subtract' : BLEND_MODE_LABELS[b] }));

const sameSizeDocs = (d: PixDocument) => app.docs.filter(x => x.width === d.width && x.height === d.height);
const layerLabel = (l: Layer) => l.name;

/** Source RGBA (doc sized). Channels come back as grey (R=G=B) with alpha 255; 'rgb' keeps the layer alpha. */
export function sourcePixels(s: SourceSpec): Uint8ClampedArray {
  const d = s.doc, W = d.width, H = d.height;
  const layer = s.layer === 'merged' ? null : d.findLayer(s.layer);
  let px: Uint8ClampedArray;
  if (s.channel === 'selection' || s.channel.startsWith('ch:')) {
    const cv = s.channel === 'selection' ? d.selection.mask : d.channels.find(c => `ch:${c.id}` === s.channel)?.canvas;
    px = new Uint8ClampedArray(W * H * 4);
    const a = cv ? ctx2d(cv).getImageData(0, 0, W, H).data : null;
    for (let i = 0; i < px.length; i += 4) { const v = a ? a[i + 3] : 0; px[i] = px[i + 1] = px[i + 2] = v; px[i + 3] = 255; }
  } else {
    const c = layer ? (layer instanceof GroupLayer ? renderLayersToCanvas(d, [layer]) : d.layerAsDocCanvas(layer)) : renderLayersToCanvas(d, d.layers);
    px = ctx2d(c).getImageData(0, 0, W, H).data;
    if (s.channel !== 'rgb') for (let i = 0; i < px.length; i += 4) {
      const v = s.channel === 'red' ? px[i] : s.channel === 'green' ? px[i + 1] : s.channel === 'blue' ? px[i + 2] : s.channel === 'alpha' ? px[i + 3] : luma(px[i], px[i + 1], px[i + 2]) * px[i + 3] / 255 + 255 * (1 - px[i + 3] / 255);
      px[i] = px[i + 1] = px[i + 2] = v; px[i + 3] = 255;
    }
  }
  if (s.invert) for (let i = 0; i < px.length; i += 4) { px[i] = 255 - px[i]; px[i + 1] = 255 - px[i + 1]; px[i + 2] = 255 - px[i + 2]; }
  return px;
}

/** Source / Layer / Channel / Invert controls. */
function sourcePicker(target: PixDocument, rgb: boolean, initial: Partial<SourceSpec>, onChange: () => void, title = 'Source') {
  const spec: SourceSpec = { doc: initial.doc || target, layer: initial.layer ?? 'merged', channel: initial.channel || (rgb ? 'rgb' : 'gray'), invert: !!initial.invert };
  const docSel = select(sameSizeDocs(target).map(d => ({ value: d.id, label: d.name })), spec.doc.id, id => { spec.doc = app.docs.find(d => d.id === id) || target; spec.layer = 'merged'; rebuild(); onChange(); }, { width: 200, title });
  const holder = h('div.imgd-form');
  const inv = checkbox('Invert', spec.invert, v => { spec.invert = v; onChange(); });
  const rebuild = () => {
    const layers = spec.doc.allLayers().filter(l => l.kind !== 'adjustment').reverse();
    const lSel = select<'merged' | number>([{ value: 'merged', label: 'Merged' }, ...layers.map(l => ({ value: l.id, label: layerLabel(l) }))], spec.layer, v => { spec.layer = v; onChange(); }, { width: 200 });
    const chans: { value: Channel; label: string }[] = [
      ...(rgb ? [{ value: 'rgb' as Channel, label: 'RGB' }] : [{ value: 'gray' as Channel, label: 'Gray' }]),
      { value: 'red', label: 'Red' }, { value: 'green', label: 'Green' }, { value: 'blue', label: 'Blue' }, { value: 'alpha', label: 'Transparency' },
      ...(spec.doc.selection.empty ? [] : [{ value: 'selection' as Channel, label: 'Selection' }]),
      ...spec.doc.channels.map(c => ({ value: `ch:${c.id}` as Channel, label: c.name })),
    ];
    if (!chans.some(c => c.value === spec.channel)) spec.channel = chans[0].value;
    const cSel = select<Channel>(chans, spec.channel, v => { spec.channel = v; onChange(); }, { width: 140 });
    holder.replaceChildren(dialogRow('Layer:', lSel), dialogRow('Channel:', cSel, inv));
  };
  rebuild();
  const el = h('fieldset.group', null, h('legend', null, title), h('div.imgd-form', null, dialogRow(title === 'Mask' ? 'Image:' : 'Source:', docSel), holder));
  return { el, spec };
}

/** Blend source pixels onto target pixels (both RGBA, same size) — Apply Image / Calculations core. */
export function blendArrays(dst: Uint8ClampedArray, src: Uint8ClampedArray, w: number, hh: number, mode: ApplyBlend, opacity: number, o: { scale?: number; offset?: number; mask?: Uint8ClampedArray | null; preserve?: boolean } = {}) {
  const alpha0 = o.preserve ? dst.filter((_, i) => (i & 3) === 3) : null;
  if (o.mask) for (let i = 0; i < src.length; i += 4) src[i + 3] = (src[i + 3] * o.mask[i]) / 255;
  if (mode === 'add' || mode === 'subtract') {
    const sc = o.scale || 1, off = o.offset || 0, sgn = mode === 'add' ? 1 : -1;
    for (let i = 0; i < dst.length; i += 4) {
      const a = (src[i + 3] / 255) * opacity;
      for (let c = 0; c < 3; c++) dst[i + c] = dst[i + c] + ((dst[i + c] + sgn * src[i + c]) / sc + off - dst[i + c]) * a;
      dst[i + 3] = Math.max(dst[i + 3], src[i + 3] * opacity);
    }
  } else {
    const T = createCanvas(w, hh), S = createCanvas(w, hh), tx = ctx2d(T);
    tx.putImageData(new ImageData(dst as any, w, hh), 0, 0);
    ctx2d(S).putImageData(new ImageData(src as any, w, hh), 0, 0);
    blendOnto(tx, S, mode, opacity, { x: 0, y: 0, w, h: hh });
    dst.set(tx.getImageData(0, 0, w, hh).data);
  }
  if (alpha0) for (let i = 0, p = 0; i < dst.length; i += 4, p++) dst[i + 3] = Math.min(dst[i + 3], alpha0[p]);
}

function cropDocArray(a: Uint8ClampedArray, W: number, H: number, x: number, y: number, w: number, hh: number): Uint8ClampedArray {
  if (x === 0 && y === 0 && w === W && hh === H) return new Uint8ClampedArray(a);
  const out = new Uint8ClampedArray(w * hh * 4);
  for (let r = 0; r < hh; r++) {
    const sy = y + r; if (sy < 0 || sy >= H) continue;
    const x0 = Math.max(0, x), x1 = Math.min(W, x + w);
    if (x1 <= x0) continue;
    out.set(a.subarray((sy * W + x0) * 4, (sy * W + x1) * 4), (r * w + (x0 - x)) * 4);
  }
  return out;
}

// ------------------------------------------------------------------ Apply Image
export async function applyImageDialog(doc: PixDocument) {
  const pv = pixelOpPreview(doc);
  if (!pv.ok) return;
  let mode: ApplyBlend = 'multiply', opacity = 100, preserve = false, useMask = false, scale = 1, offset = 0, preview = true;
  const cache = new Map<string, Uint8ClampedArray>();
  const get = (s: SourceSpec) => {
    const k = `${s.doc.id}|${s.layer}|${s.channel}|${s.invert}`;
    let v = cache.get(k);
    if (!v) { v = sourcePixels(s); cache.set(k, v); }
    return v;
  };
  const update = () => {
    if (!preview) { pv.setEnabled(false); return; }
    pv.setEnabled(true);
    pv.update((img, info) => {
      const W = doc.width, H = doc.height, w = img.width, hh = img.height;
      const src = cropDocArray(get(source.spec), W, H, info.x, info.y, w, hh);
      const mask = useMask ? cropDocArray(get(maskSrc.spec), W, H, info.x, info.y, w, hh) : null;
      blendArrays(img.data, src, w, hh, mode, opacity / 100, { scale, offset, mask, preserve: preserve || info.isMask });
    });
  };
  const source = sourcePicker(doc, true, {}, update);
  const maskSrc = sourcePicker(doc, false, { channel: 'gray' }, update, 'Mask');
  maskSrc.el.style.display = 'none';
  const t = pv.target!;
  const targetLbl = `${doc.name} (${t.layer ? t.layer.name : 'Quick Mask'}${t.kind === 'mask' ? ' Mask' : ''}, ${doc.mode === 'RGB' ? 'RGB' : doc.mode})`;
  const scaleIn = numInput(50, v => { scale = Math.max(1, Math.min(2, v)); scaleIn.show(scale, 3); update(); }); scaleIn.show(scale, 3);
  const offIn = numInput(50, v => { offset = Math.max(-255, Math.min(255, Math.round(v))); offIn.show(offset); update(); }); offIn.show(offset);
  const addRow = h('div.imgd-inline', null, h('span', null, 'Scale:'), scaleIn, h('span', null, 'Offset:'), offIn);
  const syncAdd = () => { addRow.style.display = mode === 'add' || mode === 'subtract' ? '' : 'none'; };
  const opIn = numInput(50, v => { opacity = Math.max(0, Math.min(100, Math.round(v))); opIn.show(opacity); update(); }); opIn.show(opacity);
  syncAdd();
  const body = h('div.imgd-form', { style: { minWidth: '400px' } },
    source.el,
    dialogRow('Target:', h('span.imgd-strong', null, targetLbl)),
    h('fieldset.group', null, h('legend', null, 'Blending'), h('div.imgd-form', null,
      dialogRow('Blending:', select<ApplyBlend>(blendOptions as any, mode, v => { mode = v; syncAdd(); update(); }, { width: 170 })),
      addRow,
      dialogRow('Opacity:', opIn, h('span', null, '%')),
      dialogRow('', checkbox('Preserve Transparency', preserve, v => { preserve = v; update(); })),
      dialogRow('', checkbox('Mask...', useMask, v => { useMask = v; maskSrc.el.style.display = v ? '' : 'none'; update(); })))),
    maskSrc.el);
  const dlg = openDialog({ title: 'Apply Image', body, layout: 'side', buttons: [{ label: 'OK', primary: true, value: 'ok' }, { label: 'Cancel', value: null }], preview: { checked: true, onChange: v => { preview = v; update(); } } });
  update();
  const r = await dlg.result;
  if (r === 'ok') { preview = true; pv.setEnabled(true); update(); await pv.commit('Apply Image'); }
  else pv.cancel();
}

// ------------------------------------------------------------------ Calculations
export async function calculationsDialog(doc: PixDocument) {
  let mode: ApplyBlend = 'multiply', opacity = 100, useMask = false, scale = 1, offset = 0, result = 'channel' as 'channel' | 'document' | 'selection', preview = true, timer = 0;
  const W = doc.width, H = doc.height;
  const compute = (): Uint8ClampedArray => {
    const s1 = sourcePixels(src1.spec), s2 = sourcePixels(src2.spec);
    const mask = useMask ? sourcePixels(maskSrc.spec) : null;
    blendArrays(s2, s1, W, H, mode, opacity / 100, { scale, offset, mask });
    return s2;
  };
  const toCanvas = (px: Uint8ClampedArray) => { const c = createCanvas(W, H); ctx2d(c).putImageData(new ImageData(px as any, W, H), 0, 0); return c; };
  const update = () => { clearTimeout(timer); timer = window.setTimeout(() => setDocPreview(doc, preview ? toCanvas(compute()) : null), 60); };
  const src1 = sourcePicker(doc, false, {}, update, 'Source 1');
  const src2 = sourcePicker(doc, false, {}, update, 'Source 2');
  const maskSrc = sourcePicker(doc, false, {}, update, 'Mask');
  maskSrc.el.style.display = 'none';
  const scaleIn = numInput(50, v => { scale = Math.max(1, Math.min(2, v)); scaleIn.show(scale, 3); update(); }); scaleIn.show(scale, 3);
  const offIn = numInput(50, v => { offset = Math.max(-255, Math.min(255, Math.round(v))); offIn.show(offset); update(); }); offIn.show(offset);
  const addRow = h('div.imgd-inline', null, h('span', null, 'Scale:'), scaleIn, h('span', null, 'Offset:'), offIn);
  const syncAdd = () => { addRow.style.display = mode === 'add' || mode === 'subtract' ? '' : 'none'; };
  syncAdd();
  const opIn = numInput(50, v => { opacity = Math.max(0, Math.min(100, Math.round(v))); opIn.show(opacity); update(); }); opIn.show(opacity);
  const body = h('div.imgd-form', { style: { minWidth: '400px' } },
    src1.el, src2.el,
    h('fieldset.group', null, h('legend', null, 'Blending'), h('div.imgd-form', null,
      dialogRow('Blending:', select<ApplyBlend>(blendOptions as any, mode, v => { mode = v; syncAdd(); update(); }, { width: 170 })),
      addRow,
      dialogRow('Opacity:', opIn, h('span', null, '%')),
      dialogRow('', checkbox('Mask...', useMask, v => { useMask = v; maskSrc.el.style.display = v ? '' : 'none'; update(); })))),
    maskSrc.el,
    dialogRow('Result:', select([{ value: 'channel', label: 'New Channel' }, { value: 'document', label: 'New Document' }, { value: 'selection', label: 'Selection' }], result, v => { result = v as any; }, { width: 170 })));
  const dlg = openDialog({ title: 'Calculations', body, layout: 'side', buttons: [{ label: 'OK', primary: true, value: 'ok' }, { label: 'Cancel', value: null }], preview: { checked: true, onChange: v => { preview = v; update(); } } });
  update();
  const r = await dlg.result;
  clearTimeout(timer);
  setDocPreview(doc, null);
  if (r !== 'ok') return;
  const px = compute();
  if (result === 'document') {
    const nd = PixDocument.create(W, H, { resolution: doc.resolution, resolutionUnit: doc.resolutionUnit, mode: 'Grayscale' });
    const bg = nd.layers[0] as any;
    ctx2d(bg.canvas).putImageData(new ImageData(px as any, W, H), 0, 0);
    bg.invalidate();
    app.addDocument(nd);
    return;
  }
  // grey → alpha (channels and selections store their value in alpha)
  const a = new Uint8ClampedArray(px.length);
  for (let i = 0; i < px.length; i += 4) a[i + 3] = px[i];
  const c = createCanvas(W, H); ctx2d(c).putImageData(new ImageData(a, W, H), 0, 0);
  if (result === 'selection') {
    doc.history.transaction('Calculations', () => doc.selection.setMask(c), 'selection');
  } else {
    const n = doc.channels.length + 1;
    doc.history.transaction('Calculations', () => { doc.channels = [...doc.channels, { id: Date.now() % 1e9, name: `Alpha ${n}`, canvas: c }]; }, 'channels');
    docChanged(doc);
  }
}
