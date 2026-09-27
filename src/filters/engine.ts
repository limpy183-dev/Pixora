// Filter engine: runs kernels in a worker (preview lane is restarted when superseded, apply lane is not),
// applies filters to the paint target (selection / masks / history via applyPixelOp) or as Smart Filters on smart
// objects, and provides the Photoshop-style filter dialog with live canvas preview + preview box.
import './filters.css';
import { app } from '../core/app';
import type { PixDocument } from '../core/document';
import { events } from '../core/events';
import { registerFilter, registerPropertiesSection } from '../core/registry';
import { applyPixelOp, editableTarget, pixelOpPreview, type PixelOpInfo } from '../core/pixelops';
import { createCanvas, ctx2d } from '../core/canvas';
import { h, dragPointer } from '../ui/dom';
import { icon } from '../ui/icons';
import { openDialog } from '../ui/dialog';
import { checkbox, iconButton, select, sliderRow, colorSwatch, numberField, type SelectOption } from '../ui/widgets';
import { toast } from '../ui/toast';
import { SmartObjectLayer, smartFilterHooks, type SmartFilter } from '../layers/smart-object';
import { KERNELS, type Meta } from './kernels/index';
import type { RGB } from '../core/types';

// ------------------------------------------------------------------ worker lanes
type Job = { id: number; ok: (img: ImageData) => void; err: (e: unknown) => void };
class Lane {
  w: Worker | null = null; broken = false; job: Job | null = null; seq = 0;
  constructor(private restartable: boolean) {}
  private spawn(): Worker | null {
    if (this.broken) return null;
    if (this.w) return this.w;
    try {
      const w = new Worker(new URL('./filters.worker.ts', import.meta.url), { type: 'module' });
      w.onmessage = (e: MessageEvent) => {
        const j = this.job;
        if (!j || j.id !== e.data.id) return;
        this.job = null;
        if (e.data.error) j.err(new Error(e.data.error));
        else j.ok(new ImageData(new Uint8ClampedArray(e.data.data), e.data.width, e.data.height));
      };
      w.onerror = ev => { ev.preventDefault?.(); this.broken = true; this.w?.terminate(); this.w = null; const j = this.job; this.job = null; j?.err(new Error('filter worker failed')); };
      this.w = w;
    } catch { this.broken = true; }
    return this.w;
  }
  run(name: string, img: ImageData, params: any, meta: Meta): Promise<ImageData> {
    if (this.job && this.restartable) { this.w?.terminate(); this.w = null; this.job = null; }   // superseded preview: drop it
    const w = this.spawn();
    if (!w || (this.job && !this.restartable)) return Promise.resolve(runSync(name, img, params, meta));
    const id = ++this.seq;
    return new Promise<ImageData>((ok, err) => {
      this.job = { id, ok, err: e => { console.warn('[filters] worker error, running on the main thread', e); try { ok(runSync(name, img, params, meta)); } catch (x) { err(x); } } };
      const copy = new Uint8ClampedArray(img.data);
      w.postMessage({ id, name, params, width: img.width, height: img.height, data: copy.buffer, meta }, [copy.buffer]);
    });
  }
}
const previewLane = new Lane(true), applyLane = new Lane(false);
export function runSync(name: string, img: ImageData, params: any, meta: Meta): ImageData {
  const k = KERNELS[name];
  if (!k) throw new Error(`Unknown filter kernel: ${name}`);
  return k(img, params, meta);
}
export const rgb3 = (c: RGB): [number, number, number] => [c.r, c.g, c.b];

// ------------------------------------------------------------------ filter specs
export interface FilterCtx {
  doc: PixDocument;
  /** Thumbnail of the filtered area (selection bounds of the target), for centre pickers. */
  thumb(): HTMLCanvasElement;
  /** Extra data passed to the kernel (maps, paths...). Change it, then call update(). */
  aux: any;
  smart: boolean;
}
export interface FilterSpec<P = any> {
  id: string; label: string; category: string;
  /** false = applies immediately (no dialog). */
  dialog?: boolean;
  defaults: () => P;
  ui?(body: HTMLElement, p: P, update: () => void, ctx: FilterCtx): void;
  /** Collect auxiliary kernel data before running (return null to cancel). */
  prepare?(doc: PixDocument, p: P, ctx: FilterCtx): Promise<any> | any;
  kernel?: string;
  /** Can be applied as a smart filter (default true). */
  smart?: boolean;
  previewBox?: boolean;
  width?: number;
}
export const specs = new Map<string, FilterSpec>();

function metaFor(info: { x: number; y: number; isMask: boolean; selRect: any; preview: boolean }, doc: PixDocument, p: any, aux: any): Meta {
  return {
    x: info.x, y: info.y, docW: doc.width, docH: doc.height, sel: info.selRect, isMask: info.isMask, preview: info.preview,
    fg: p._fg || rgb3(app.fg), bg: p._bg || rgb3(app.bg), seed: p._seed ?? 1234, aux,
  };
}
const smartTarget = (doc: PixDocument): SmartObjectLayer | null => { const l = doc.activeLayer; return l instanceof SmartObjectLayer && doc.selectedIds.length <= 1 && !doc.editMask ? l : null; };
const stamp = (p: any) => ({ ...p, _fg: rgb3(app.fg), _bg: rgb3(app.bg), _seed: p._seed ?? Math.floor(Math.random() * 1e9) });

export function defineFilter<P>(spec: FilterSpec<P>) {
  specs.set(spec.id, spec as FilterSpec);
  registerFilter({ id: spec.id, label: spec.label, category: spec.category, run: (doc, opts) => runFilter(spec as FilterSpec, doc, opts.params) });
}

async function runFilter(spec: FilterSpec, doc: PixDocument, given?: any): Promise<any> {
  const so = smartTarget(doc);
  if (so && spec.smart === false) { toast(`${spec.label} cannot be applied as a Smart Filter. Rasterize the layer first.`, 'error', 4000); return null; }
  if (!so && !editableTarget(doc)) return null;
  const ctx = makeCtx(doc, !!so);
  let p = given ? JSON.parse(JSON.stringify(given)) : stamp(spec.defaults());
  if (given && !('_seed' in p)) p = stamp(p);
  if (spec.dialog !== false && !given) {
    const res = await filterDialog(spec, doc, p, ctx, so ? { so, index: -1 } : null);
    return res;
  }
  if (spec.prepare) { const a = await spec.prepare(doc, p, ctx); if (a === null) return null; ctx.aux = a ?? ctx.aux; }
  if (so) { addSmartFilter(doc, so, spec, p, ctx.aux); return p; }
  await applyToPixels(doc, spec, p, ctx.aux);
  return p;
}
function makeCtx(doc: PixDocument, smart: boolean): FilterCtx {
  let thumb: HTMLCanvasElement | null = null;
  return {
    doc, aux: {}, smart,
    thumb() {
      if (thumb) return thumb;
      const so = smartTarget(doc), t = so ? null : doc.getPaintTarget();
      let src: HTMLCanvasElement | null = so ? so.source : t ? t.holder.canvas : null;
      let r = { x: 0, y: 0, w: src?.width || 1, h: src?.height || 1 };
      const b = doc.selection.bounds;
      if (t && b && !doc.quickMask) r = { x: b.x - t.holder.x, y: b.y - t.holder.y, w: b.w, h: b.h };
      const k = Math.min(1, 180 / Math.max(r.w, r.h));
      thumb = createCanvas(Math.max(1, r.w * k), Math.max(1, r.h * k));
      const x = ctx2d(thumb);
      if (!src) { src = doc.getComposite(); }
      x.drawImage(src, r.x, r.y, r.w, r.h, 0, 0, thumb.width, thumb.height);
      return thumb;
    },
  };
}
async function applyToPixels(doc: PixDocument, spec: FilterSpec, p: any, aux: any) {
  const name = spec.label;
  const t0 = performance.now();
  const ok = await applyPixelOp(doc, name, (img: ImageData, info: PixelOpInfo) => applyLane.run(spec.kernel || spec.id, img, p, metaFor(info, doc, p, aux)));
  if (ok && performance.now() - t0 > 4000) toast(`${name} finished`, 'success');
}

// ------------------------------------------------------------------ smart filters
function addSmartFilter(doc: PixDocument, so: SmartObjectLayer, spec: FilterSpec, p: any, aux: any) {
  const f: SmartFilter = { id: spec.id, label: spec.label, params: { ...p, _aux: serializeAux(aux) }, enabled: true };
  doc.history.transaction(spec.label, () => { so.smartFilters = [...so.smartFilters, f]; so.invalidate(); }, 'smart');
  doc.pixelsChanged(so, null); doc.layersChanged();
}
function serializeAux(aux: any) { return aux && Object.keys(aux).length ? aux : undefined; }
smartFilterHooks.apply = (src: HTMLCanvasElement, f: SmartFilter): HTMLCanvasElement => {
  const spec = specs.get(f.id);
  if (!spec) return src;
  try {
    const rd = createCanvas(src.width, src.height).getContext('2d', { willReadFrequently: true })!;
    rd.drawImage(src, 0, 0);
    const img = rd.getImageData(0, 0, src.width, src.height);
    const p = f.params || {};
    const out = runSync(spec.kernel || spec.id, img, p, { x: 0, y: 0, docW: src.width, docH: src.height, sel: null, isMask: false, preview: false, fg: p._fg || rgb3(app.fg), bg: p._bg || rgb3(app.bg), seed: p._seed ?? 1, aux: p._aux || {} });
    const c = createCanvas(out.width, out.height);
    ctx2d(c).putImageData(out, 0, 0);
    return c;
  } catch (err) { console.error('[smart filter]', f.label, err); return src; }
};

// ------------------------------------------------------------------ dialog
interface Previewer { update(p: any, delay?: number): void; setEnabled(v: boolean): void; commit(p: any): Promise<void>; cancel(): void; source(): HTMLCanvasElement; onResult: (c: HTMLCanvasElement) => void }
function pixelPreviewer(doc: PixDocument, spec: FilterSpec, ctx: FilterCtx): Previewer | null {
  const pv: Previewer = { onResult: () => {} } as any;
  const inner = pixelOpPreview(doc, { onResult: c => pv.onResult(c) });
  if (!inner.ok) return null;
  const op = (p: any) => (img: ImageData, info: PixelOpInfo) => (info.preview ? previewLane : applyLane).run(spec.kernel || spec.id, img, p, metaFor(info, doc, p, ctx.aux));
  pv.update = (p, delay = 90) => inner.update(op(p), delay);
  pv.setEnabled = v => inner.setEnabled(v);
  pv.commit = async p => { await inner.commit(spec.label, op(p)); };
  pv.cancel = () => inner.cancel();
  pv.source = () => inner.target!.holder.canvas;
  return pv;
}
function smartPreviewer(doc: PixDocument, spec: FilterSpec, ctx: FilterCtx, so: SmartObjectLayer, index: number): Previewer {
  const orig = so.smartFilters, origEnabled = so.smartFiltersEnabled;
  let timer = 0, enabled = true, last: any = null;
  const pv: Previewer = { onResult: () => {} } as any;
  const make = (p: any): SmartFilter => ({ id: spec.id, label: spec.label, params: { ...p, _aux: serializeAux(ctx.aux) }, enabled: true });
  const show = (list: SmartFilter[]) => { so.smartFilters = list; so.smartFiltersEnabled = true; so.invalidate(); doc.pixelsChanged(so, null); };
  const listWith = (p: any) => (index < 0 ? [...orig, make(p)] : orig.map((f, i) => (i === index ? { ...make(p), enabled: f.enabled } : f)));
  pv.update = (p, delay = 150) => {
    last = p;
    clearTimeout(timer);
    timer = window.setTimeout(() => {
      if (!enabled) return;
      show(listWith(p));
      const c = so.getContent(doc).canvas;
      pv.onResult(c);
    }, delay);
  };
  pv.setEnabled = v => { enabled = v; if (!v) { clearTimeout(timer); show(orig); } else if (last) pv.update(last, 0); };
  pv.commit = async p => {
    clearTimeout(timer);
    so.smartFilters = orig; so.smartFiltersEnabled = origEnabled;
    doc.history.transaction(index < 0 ? spec.label : `Edit ${spec.label}`, () => { so.smartFilters = listWith(p); so.invalidate(); }, 'smart');
    doc.pixelsChanged(so, null); doc.layersChanged();
  };
  pv.cancel = () => { clearTimeout(timer); so.smartFilters = orig; so.smartFiltersEnabled = origEnabled; so.invalidate(); doc.pixelsChanged(so, null); };
  pv.source = () => so.source;
  return pv;
}

export async function filterDialog(spec: FilterSpec, doc: PixDocument, p: any, ctx: FilterCtx, smart: { so: SmartObjectLayer; index: number } | null): Promise<any> {
  const pv = smart ? smartPreviewer(doc, spec, ctx, smart.so, smart.index) : pixelPreviewer(doc, spec, ctx);
  if (!pv) return null;
  const showBox = spec.previewBox !== false;
  const box = createCanvas(260, 200);
  box.className = 'filter-preview-canvas';
  const src0 = pv.source();
  let zoom = 1, result: HTMLCanvasElement | null = null;
  const b = doc.selection.bounds, t = smart ? null : doc.getPaintTarget();
  let cx = src0.width / 2, cy = src0.height / 2;
  if (b && t) { cx = b.x + b.w / 2 - t.holder.x; cy = b.y + b.h / 2 - t.holder.y; }
  const zoomLabel = h('span.filter-zoom-label', null, '100%');
  const drawBox = () => {
    const x = ctx2d(box);
    x.setTransform(1, 0, 0, 1, 0, 0);
    x.clearRect(0, 0, box.width, box.height);
    const src = result || pv.source();
    x.imageSmoothingEnabled = zoom < 1;
    x.setTransform(zoom, 0, 0, zoom, box.width / 2 - cx * zoom, box.height / 2 - cy * zoom);
    x.drawImage(src, 0, 0);
    x.setTransform(1, 0, 0, 1, 0, 0);
    zoomLabel.textContent = Math.round(zoom * 100) + '%';
  };
  box.addEventListener('pointerdown', e => {
    const c0x = cx, c0y = cy, orig = result;
    result = null; drawBox();
    dragPointer(e, (dx, dy) => { cx = c0x - dx / zoom; cy = c0y - dy / zoom; drawBox(); }, () => { result = orig; drawBox(); });
  });
  const boxEl = showBox ? h('div.filter-preview', null, box,
    h('div.filter-zoom', null,
      h('button.icon-btn', { type: 'button', title: 'Zoom out', onclick: () => { zoom = Math.max(0.05, zoom / 2); drawBox(); } }, icon('minus', 14)),
      zoomLabel,
      h('button.icon-btn', { type: 'button', title: 'Zoom in', onclick: () => { zoom = Math.min(16, zoom * 2); drawBox(); } }, icon('plus', 14)))) : null;
  const controls = h('div.filter-controls');
  const update = () => pv.update(p);
  try { spec.ui?.(controls, p, update, ctx); } catch (err) { console.error(err); }
  pv.onResult = c => { result = c; if (showBox) drawBox(); };
  const d = openDialog({
    title: spec.label + '...', body: h('div.filter-dialog-body', null, boxEl, controls), layout: 'side', width: spec.width ?? (showBox ? 620 : 460),
    preview: { checked: true, onChange: v => pv.setEnabled(v) },
    buttons: [{ label: 'OK', primary: true, value: true }, { label: 'Cancel', value: false }], cancelValue: false, className: 'flt-dialog',
  });
  if (showBox) drawBox();
  if (spec.prepare) {
    const a = await spec.prepare(doc, p, ctx);
    if (a === null) { d.close(false); pv.cancel(); return null; }
    ctx.aux = a ?? ctx.aux;
  }
  update();
  const ok = await d.result;
  if (!ok) { pv.cancel(); return null; }
  try { await pv.commit(p); } catch (err: any) { toast('Filter failed: ' + (err?.message || err), 'error'); return null; }
  return p;
}

// ------------------------------------------------------------------ control helpers (bound to params)
export const ui = {
  slider(label: string, p: any, key: string, min: number, max: number, update: () => void, o: { unit?: string; decimals?: number; step?: number; center?: number } = {}) {
    return sliderRow(label, p[key], min, max, (v, final) => { p[key] = v; if (final || true) update(); }, o);
  },
  select<T>(label: string, p: any, key: string, options: SelectOption<T>[], update: () => void, width = 170) {
    return h('div.form-row', null, h('label.form-label', null, label), select<T>(options, p[key], v => { p[key] = v; update(); }, { width, title: label.replace(/:$/, '') }));
  },
  check(label: string, p: any, key: string, update: () => void) { return h('div.form-row.flt-check', null, checkbox(label, !!p[key], v => { p[key] = v; update(); })); },
  radios<T extends string>(label: string, p: any, key: string, options: [T, string][], update: () => void) {
    const name = 'flt-' + key + Math.random().toString(36).slice(2, 7);
    return h('fieldset.flt-radios', null, h('legend', null, label), ...options.map(([v, l]) => {
      const inp = h('input', { type: 'radio', name, checked: p[key] === v }) as HTMLInputElement;
      inp.addEventListener('change', () => { if (inp.checked) { p[key] = v; update(); } });
      return h('label.flt-radio', null, inp, h('span', null, l));
    }));
  },
  number(label: string, p: any, key: string, update: () => void, o: { min?: number; max?: number; unit?: string; decimals?: number; width?: number } = {}) {
    return h('div.form-row', null, h('label.form-label', null, label), numberField(p[key], v => { p[key] = v; update(); }, { width: o.width ?? 70, ...o }));
  },
  color(label: string, p: any, key: string, update: () => void) { return h('div.form-row', null, h('label.form-label', null, label), colorSwatch(p[key], c => { p[key] = c; update(); }, { title: label })); },
  button(label: string, title: string, fn: () => void) { return h('button.btn.flt-btn', { type: 'button', title, onclick: fn }, label); },
  /** Click / drag on a thumbnail to set a centre in % of the filtered area. */
  center(label: string, p: any, kx: string, ky: string, update: () => void, ctx: FilterCtx) {
    const th = ctx.thumb(), c = createCanvas(th.width, th.height);
    c.className = 'flt-center';
    const draw = () => {
      const x = ctx2d(c);
      x.drawImage(th, 0, 0);
      const px = (p[kx] / 100) * c.width, py = (p[ky] / 100) * c.height;
      x.strokeStyle = '#fff'; x.lineWidth = 3; x.beginPath(); x.moveTo(px - 8, py); x.lineTo(px + 8, py); x.moveTo(px, py - 8); x.lineTo(px, py + 8); x.stroke();
      x.strokeStyle = '#000'; x.lineWidth = 1; x.beginPath(); x.moveTo(px - 8, py); x.lineTo(px + 8, py); x.moveTo(px, py - 8); x.lineTo(px, py + 8); x.stroke();
    };
    const set = (e: PointerEvent) => { const r = c.getBoundingClientRect(); p[kx] = Math.round(Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * 1000) / 10; p[ky] = Math.round(Math.max(0, Math.min(1, (e.clientY - r.top) / r.height)) * 1000) / 10; draw(); };
    c.addEventListener('pointerdown', e => { set(e); dragPointer(e, (_dx, _dy, ev) => set(ev), () => update()); });
    c.title = 'Click or drag to set the centre';
    draw();
    return h('div.flt-center-wrap', null, h('div.flt-center-label', null, label), c);
  },
  angle(label: string, p: any, key: string, update: () => void) {
    const dial = h('div.flt-dial', { title: 'Drag to set the angle' }, h('div.flt-dial-hand'));
    const hand = dial.firstChild as HTMLElement;
    const num = numberField(p[key], v => { p[key] = v; sync(); update(); }, { min: -360, max: 360, unit: '°', width: 60 });
    const sync = () => { hand.style.transform = `rotate(${-p[key]}deg)`; num.setValue(p[key]); };
    dial.addEventListener('pointerdown', e => {
      const set = (ev: PointerEvent) => { const r = dial.getBoundingClientRect(); p[key] = Math.round((Math.atan2(-(ev.clientY - r.top - r.height / 2), ev.clientX - r.left - r.width / 2) * 180) / Math.PI); sync(); };
      set(e); dragPointer(e, (_a, _b, ev) => set(ev), () => update());
    });
    sync();
    return h('div.form-row.flt-angle', null, h('label.form-label', null, label), dial, num);
  },
};

// ------------------------------------------------------------------ Properties: Smart Filters section
registerPropertiesSection({
  id: 'smart-filters', title: 'Smart Filters', order: 22,
  match: (_d, l) => l instanceof SmartObjectLayer && l.smartFilters.length > 0,
  build(el, doc, layer) {
    const so = layer as SmartObjectLayer;
    const list = h('div.flt-sflist');
    const tx = (name: string, fn: () => void) => { doc.history.transaction(name, () => { fn(); so.invalidate(); }, 'smart'); doc.pixelsChanged(so, null); doc.layersChanged(); render(); };
    const render = () => {
      list.replaceChildren();
      const master = h('div.flt-sfrow.master', null,
        iconButton(so.smartFiltersEnabled ? 'eye' : 'eye-off', so.smartFiltersEnabled ? 'Disable all smart filters' : 'Enable all smart filters', () => tx(so.smartFiltersEnabled ? 'Disable Smart Filters' : 'Enable Smart Filters', () => { so.smartFiltersEnabled = !so.smartFiltersEnabled; }), { size: 16 }),
        h('span.flt-sfname', null, 'Smart Filters'));
      list.append(master);
      [...so.smartFilters].reverse().forEach((f, ri) => {
        const i = so.smartFilters.length - 1 - ri;
        const row = h('div.flt-sfrow', { title: 'Double-click to edit the filter settings' },
          iconButton(f.enabled ? 'eye' : 'eye-off', f.enabled ? 'Hide this smart filter' : 'Show this smart filter', () => tx(f.enabled ? 'Disable Smart Filter' : 'Enable Smart Filter', () => { so.smartFilters = so.smartFilters.map((x, k) => (k === i ? { ...x, enabled: !x.enabled } : x)); }), { size: 16 }),
          h('span.flt-sfname', null, f.label),
          iconButton('chevron-up', 'Move up (applied later)', () => { if (i < so.smartFilters.length - 1) tx('Move Smart Filter', () => { const a = [...so.smartFilters]; [a[i], a[i + 1]] = [a[i + 1], a[i]]; so.smartFilters = a; }); }, { size: 14, disabled: i === so.smartFilters.length - 1 }),
          iconButton('chevron-down', 'Move down (applied earlier)', () => { if (i > 0) tx('Move Smart Filter', () => { const a = [...so.smartFilters]; [a[i], a[i - 1]] = [a[i - 1], a[i]]; so.smartFilters = a; }); }, { size: 14, disabled: i === 0 }),
          iconButton('trash', 'Delete Smart Filter', () => tx('Delete Smart Filter', () => { so.smartFilters = so.smartFilters.filter((_, k) => k !== i); }), { size: 14 }));
        row.addEventListener('dblclick', async () => {
          const spec = specs.get(f.id);
          if (!spec || spec.dialog === false) return;
          const ctx = makeCtx(doc, true);
          ctx.aux = f.params._aux || {};
          const p = JSON.parse(JSON.stringify({ ...f.params, _aux: undefined }));
          await filterDialog(spec, doc, p, ctx, { so, index: i });
          render();
        });
        list.append(row);
      });
    };
    render();
    el.append(list);
    const off = events.on('history', () => render());
    return off;
  },
});

export { ctx2d, createCanvas };
(window as any).__pxFilters = { specs, runSync };
