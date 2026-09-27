// Smart Objects (kind 'smart'): embedded source content + a non-destructive affine transform.
// The source is either a flattened canvas (placed images) or a sub-document of layers (Convert to Smart Object),
// which "Edit Contents" opens as its own document tab; edits there update every instance in the parent.
import { app } from '../core/app';
import { events } from '../core/events';
import { PixDocument } from '../core/document';
import { GroupLayer, Layer, RasterLayer, registerLayerClass, type LayerContent } from '../core/layer';
import type { HistoryEntry } from '../core/history';
import type { Rect } from '../core/types';
import { alphaBounds, canvasFromBlob, canvasToBlob, createCanvas, cropCanvas, ctx2d } from '../core/canvas';
import { renderLayersToCanvas } from '../core/compositor';
import { registerPropertiesSection } from '../core/registry';
import { unionRect } from '../core/geom';
import { h } from '../ui/dom';
import { button, numberField } from '../ui/widgets';
import { toast } from '../ui/toast';
import { icon } from '../ui/icons';

export interface SmartContents { width: number; height: number; layers: Layer[] }
export interface SmartFilter { id: string; label: string; params: any; enabled: boolean }

/** Filters engine hook: apply one smart filter to a canvas (installed by the filters module). */
export const smartFilterHooks = { apply: null as null | ((src: HTMLCanvasElement, f: SmartFilter) => HTMLCanvasElement) };

let contentCounter = 0;
const newContentId = () => `so-${Date.now().toString(36)}-${++contentCounter}`;

export class SmartObjectLayer extends Layer {
  kind = 'smart' as const;
  /** Flattened contents at native resolution. */
  source: HTMLCanvasElement = createCanvas(1, 1);
  /** Layered contents (null = the source bitmap is the whole content). Treat as immutable: replace, never mutate. */
  contents: SmartContents | null = null;
  /** Affine transform source px → document px: [a, b, c, d, e, f]. */
  matrix: number[] = [1, 0, 0, 1, 0, 0];
  /** Instances sharing a contentId are updated together by Edit Contents. */
  contentId = newContentId();
  smartFilters: SmartFilter[] = [];
  smartFiltersEnabled = true;
  _cache: { key: number; content: LayerContent } | null = null;

  static fromCanvas(canvas: HTMLCanvasElement, name = 'Layer', x = 0, y = 0): SmartObjectLayer {
    const l = new SmartObjectLayer();
    l.source = canvas; l.name = name; l.matrix = [1, 0, 0, 1, x, y];
    return l;
  }

  get domMatrix() { return new DOMMatrix(this.matrix); }
  /** Quad corners of the transformed content (doc coords). */
  corners(): DOMPoint[] {
    const m = this.domMatrix, w = this.source.width, hh = this.source.height;
    return [[0, 0], [w, 0], [w, hh], [0, hh]].map(([x, y]) => m.transformPoint(new DOMPoint(x, y)));
  }
  transformedBounds(): Rect {
    const p = this.corners();
    const x0 = Math.min(...p.map(q => q.x)), y0 = Math.min(...p.map(q => q.y)), x1 = Math.max(...p.map(q => q.x)), y1 = Math.max(...p.map(q => q.y));
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }

  getContent(_doc: PixDocument): LayerContent {
    if (this._cache && this._cache.key === this._version) return this._cache.content;
    let src = this.source;
    if (this.smartFiltersEnabled && smartFilterHooks.apply) for (const f of this.smartFilters) if (f.enabled) src = smartFilterHooks.apply(src, f);
    const [a, b, c, d, e, f] = this.matrix;
    let content: LayerContent;
    if (a === 1 && b === 0 && c === 0 && d === 1 && Number.isInteger(e) && Number.isInteger(f)) {
      content = { canvas: src, x: e, y: f };
    } else {
      const r = this.transformedBounds();
      const x0 = Math.floor(r.x), y0 = Math.floor(r.y), w = Math.max(1, Math.ceil(r.x + r.w) - x0), hh = Math.max(1, Math.ceil(r.y + r.h) - y0);
      const out = createCanvas(w, hh), x = ctx2d(out);
      x.imageSmoothingEnabled = true; x.imageSmoothingQuality = 'high';
      x.setTransform(a, b, c, d, e - x0, f - y0);
      x.drawImage(src, 0, 0);
      content = { canvas: out, x: x0, y: y0 };
    }
    this._cache = { key: this._version, content };
    return content;
  }
  translate(dx: number, dy: number) {
    this.matrix = [this.matrix[0], this.matrix[1], this.matrix[2], this.matrix[3], this.matrix[4] + dx, this.matrix[5] + dy];
    if (this.mask && this.mask.linked) { this.mask.x += dx; this.mask.y += dy; }
    this.invalidate();
  }
  /** Apply an affine transform (doc coords) on top of the current one. Linked masks only follow translations. */
  applyMatrix(m: DOMMatrix) {
    const r = m.multiply(this.domMatrix);
    this.matrix = [r.a, r.b, r.c, r.d, r.e, r.f];
    if (this.mask && this.mask.linked && m.a === 1 && m.b === 0 && m.c === 0 && m.d === 1) { this.mask.x += m.e; this.mask.y += m.f; }
    this.invalidate();
  }
}
registerLayerClass('smart', SmartObjectLayer as any);

// ------------------------------------------------------------------ helpers
function walk(l: Layer, fn: (x: Layer) => void) { fn(l); if (l instanceof GroupLayer) for (const c of l.children) walk(c, fn); }
/** Move a layer (and every mask in its subtree, linked or not) by dx, dy. */
export function shiftLayer(l: Layer, dx: number, dy: number) {
  l.translate(dx, dy);
  walk(l, x => { if (x.mask && !x.mask.linked) { x.mask.x += dx; x.mask.y += dy; } });
}
/** Union of content rectangles (not trimmed) of a layer subtree. */
function contentRect(doc: PixDocument, layers: Layer[]): Rect | null {
  let r: Rect | null = null;
  for (const l of layers) walk(l, x => {
    if (x.kind === 'adjustment' || x.kind === 'fill') r = unionRect(r, { x: 0, y: 0, w: doc.width, h: doc.height });
    else if (!(x instanceof GroupLayer)) { const c = x.getContent(doc); if (c) r = unionRect(r, { x: c.x, y: c.y, w: c.canvas.width, h: c.canvas.height }); }
    if (x.effects.some(e => e.enabled) && r) r = { x: r.x - 120, y: r.y - 120, w: r.w + 240, h: r.h + 240 };
  });
  return r;
}
/** Render layered contents into a w×h canvas using a scratch document (fill layers size to the contents). */
export function renderContents(c: SmartContents, like?: PixDocument): HTMLCanvasElement {
  const tmp = new PixDocument(c.width, c.height, 'contents');
  if (like) { tmp.resolution = like.resolution; tmp.mode = like.mode; }
  tmp.layers = c.layers;
  tmp.relink();
  const out = renderLayersToCanvas(tmp, tmp.layers);
  tmp.layers = [];
  return out;
}

/** Build a smart object from top-level layers (bottom → top) of `doc`. Does not modify the document. */
export function smartFromLayers(doc: PixDocument, layers: Layer[]): SmartObjectLayer {
  const single = layers.length === 1 ? layers[0] : null;
  const clones = layers.map(l => l.clone());
  if (single) { const c = clones[0]; c.opacity = 1; c.blendMode = c instanceof GroupLayer ? 'pass-through' : 'normal'; c.clipped = false; c.visible = true; }
  clones[0].clipped = false;
  const area = contentRect(doc, layers) || { x: 0, y: 0, w: doc.width, h: doc.height };
  // pass 1: find the painted area
  const tmp = new PixDocument(doc.width, doc.height, 'contents');
  tmp.layers = clones; tmp.relink();
  const probe = renderLayersToCanvas(tmp, clones, { x: Math.floor(area.x), y: Math.floor(area.y), w: Math.max(1, Math.ceil(area.w)), h: Math.max(1, Math.ceil(area.h)) });
  tmp.layers = [];
  const tb0 = alphaBounds(probe, 0);
  const tb = tb0 ? { x: tb0.x + Math.floor(area.x), y: tb0.y + Math.floor(area.y), w: tb0.w, h: tb0.h } : { x: 0, y: 0, w: 1, h: 1 };
  for (const c of clones) shiftLayer(c, -tb.x, -tb.y);
  const contents: SmartContents = { width: tb.w, height: tb.h, layers: clones };
  const so = new SmartObjectLayer();
  so.name = layers[layers.length - 1].name;
  so.contents = contents;
  so.source = renderContents(contents, doc);
  so.matrix = [1, 0, 0, 1, tb.x, tb.y];
  if (single) {
    so.opacity = single.opacity; so.blendMode = single.blendMode === 'pass-through' ? 'normal' : single.blendMode;
    so.clipped = single.clipped; so.visible = single.visible; so.colorLabel = single.colorLabel;
  }
  return so;
}

/** Transform a canvas placed at (x, y) by m (doc coords). */
export function transformCanvas(canvas: HTMLCanvasElement, x: number, y: number, m: DOMMatrix): { canvas: HTMLCanvasElement; x: number; y: number } {
  const full = m.multiply(new DOMMatrix().translate(x, y));
  const pts = [[0, 0], [canvas.width, 0], [canvas.width, canvas.height], [0, canvas.height]].map(([px, py]) => full.transformPoint(new DOMPoint(px, py)));
  const x0 = Math.floor(Math.min(...pts.map(p => p.x))), y0 = Math.floor(Math.min(...pts.map(p => p.y)));
  const x1 = Math.ceil(Math.max(...pts.map(p => p.x))), y1 = Math.ceil(Math.max(...pts.map(p => p.y)));
  const out = createCanvas(Math.max(1, x1 - x0), Math.max(1, y1 - y0)), cx = ctx2d(out);
  cx.imageSmoothingQuality = 'high';
  cx.setTransform(full.a, full.b, full.c, full.d, full.e - x0, full.f - y0);
  cx.drawImage(canvas, 0, 0);
  return { canvas: out, x: x0, y: y0 };
}

/** Layers of a smart object placed in document space (for "Convert to Layers"). */
export function smartToLayers(so: SmartObjectLayer): Layer[] {
  const m = so.domMatrix;
  const layers = so.contents ? so.contents.layers.map(l => l.clone()) : [Object.assign(new RasterLayer(1, 1, so.name), { canvas: so.source })];
  if (!so.contents) { const r = layers[0] as RasterLayer; r.canvas = createCanvas(so.source.width, so.source.height); ctx2d(r.canvas).drawImage(so.source, 0, 0); }
  const pure = m.a === 1 && m.b === 0 && m.c === 0 && m.d === 1;
  for (const l of layers) walk(l, x => {
    if (pure) return;
    if (x instanceof RasterLayer) { const t = transformCanvas(x.canvas, x.x, x.y, m); x.canvas = t.canvas; x.x = t.x; x.y = t.y; }
    else if (typeof (x as any).applyMatrix === 'function') (x as any).applyMatrix(m);
    if (x.mask) { const t = transformCanvas(x.mask.canvas, x.mask.x, x.mask.y, m); x.mask = { ...x.mask, canvas: t.canvas, x: t.x, y: t.y }; }
    x.invalidate();
  });
  if (pure) for (const l of layers) shiftLayer(l, m.e, m.f);
  return layers;
}

// ------------------------------------------------------------------ Edit Contents (round trip)
interface Link { parent: PixDocument; contentId: string; sub: PixDocument; entry: HistoryEntry | null; before: any; after: any; timer: number }
const links = new Map<PixDocument, Link>();

function applyUpdate(link: Link) {
  const { parent, sub } = link;
  if (!app.docs.includes(parent)) return;
  const targets = parent.allLayers().filter(l => l instanceof SmartObjectLayer && l.contentId === link.contentId) as SmartObjectLayer[];
  if (!targets.length) return;
  const contents: SmartContents = { width: sub.width, height: sub.height, layers: sub.layers.map(l => l.clone()) };
  const source = renderLayersToCanvas(sub, sub.layers);
  const mutate = () => {
    for (const t of targets) {
      // keep the visual size when the contents' canvas size changed
      const sx = t.source.width / source.width, sy = t.source.height / source.height;
      if (sx !== 1 || sy !== 1) { const m = t.domMatrix.scale(sx, sy); t.matrix = [m.a, m.b, m.c, m.d, m.e, m.f]; }
      t.source = source; t.contents = contents; t.invalidate();
    }
  };
  const hist = parent.history;
  if (link.entry && hist.entries[hist.index - 1] === link.entry) {
    mutate(); link.after = parent.captureState();
  } else {
    link.before = parent.captureState(); mutate(); link.after = parent.captureState();
    const l = link;
    link.entry = { name: 'Update Smart Object', undo: () => parent.restoreState(l.before), redo: () => parent.restoreState(l.after) };
    hist.push(link.entry);
  }
  parent.pixelsChanged(null, null);
  events.emit('layers', parent);
}

/** Open a smart object's contents as a new document (Layer › Smart Objects › Edit Contents). */
export function editContents(parent: PixDocument, so: SmartObjectLayer): PixDocument {
  for (const [sub, l] of links) if (l.parent === parent && l.contentId === so.contentId && app.docs.includes(sub)) { app.setActiveDocument(sub); return sub; }
  const w = so.contents?.width ?? so.source.width, hh = so.contents?.height ?? so.source.height;
  const sub = new PixDocument(w, hh, `${so.name}.psb`);
  sub.resolution = parent.resolution; sub.resolutionUnit = parent.resolutionUnit; sub.mode = parent.mode;
  if (so.contents) sub.layers = so.contents.layers.map(l => l.clone());
  else { const r = new RasterLayer(w, hh, so.name); ctx2d(r.canvas).drawImage(so.source, 0, 0); sub.layers = [r]; }
  sub.relink();
  const top = sub.layers[sub.layers.length - 1];
  sub.activeLayerId = top.id; sub.selectedIds = [top.id];
  sub.layerCounter = sub.layers.length;
  sub.history.baseName = 'Open';
  sub.history.snapshots = [{ name: sub.name, state: sub.captureState(true) }];
  const link: Link = { parent, contentId: so.contentId, sub, entry: null, before: null, after: null, timer: 0 };
  links.set(sub, link);
  app.addDocument(sub);
  return sub;
}

events.on('history', d => {
  const link = links.get(d);
  if (!link) return;
  clearTimeout(link.timer);
  link.timer = window.setTimeout(() => applyUpdate(link), 250);
});
events.on('docs', () => {
  for (const [sub, l] of links) if (!app.docs.includes(sub)) { clearTimeout(l.timer); links.delete(sub); }
});

// ------------------------------------------------------------------ export / replace
export async function exportContents(so: SmartObjectLayer) {
  const blob = await canvasToBlob(so.source);
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${so.name.replace(/[\\/:*?"<>|]+/g, '_')}.png`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}
export function pickImageFile(): Promise<File | null> {
  return new Promise(resolve => {
    const inp = document.createElement('input');
    inp.type = 'file'; inp.accept = 'image/*';
    inp.onchange = () => resolve(inp.files?.[0] || null);
    inp.oncancel = () => resolve(null);
    inp.click();
  });
}
/** New matrix so that `newSource` keeps the old centre and scale. */
export function replaceMatrix(so: SmartObjectLayer, nw: number, nh: number): number[] {
  const m = so.domMatrix;
  const oc = m.transformPoint(new DOMPoint(so.source.width / 2, so.source.height / 2));
  const nc = m.transformPoint(new DOMPoint(nw / 2, nh / 2));
  const r = new DOMMatrix().translate(oc.x - nc.x, oc.y - nc.y).multiply(m);
  return [r.a, r.b, r.c, r.d, r.e, r.f];
}
export async function canvasFromFile(f: File): Promise<HTMLCanvasElement> { return canvasFromBlob(f); }

// ------------------------------------------------------------------ Properties panel section
registerPropertiesSection({
  id: 'smart', title: 'Smart Object', order: 20,
  match: (_doc, layer) => layer instanceof SmartObjectLayer,
  build(container, doc, layer) {
    const so = layer as SmartObjectLayer;
    const round = (v: number) => Math.round(v * 100) / 100;
    const b = () => so.transformedBounds();
    const apply = (name: string, fn: () => void) => { doc.history.transaction(name, fn); doc.pixelsChanged(so, null); sync(); };
    const W = numberField(round(b().w), v => apply('Transform', () => { const r = b(); so.applyMatrix(new DOMMatrix().translate(r.x, r.y).scale(v / r.w, 1).translate(-r.x, -r.y)); }), { label: 'W', unit: 'px', min: 1, width: 72, decimals: 2 });
    const H = numberField(round(b().h), v => apply('Transform', () => { const r = b(); so.applyMatrix(new DOMMatrix().translate(r.x, r.y).scale(1, v / r.h).translate(-r.x, -r.y)); }), { label: 'H', unit: 'px', min: 1, width: 72, decimals: 2 });
    const X = numberField(round(b().x), v => apply('Move', () => so.translate(v - b().x, 0)), { label: 'X', unit: 'px', width: 72, decimals: 2 });
    const Y = numberField(round(b().y), v => apply('Move', () => so.translate(0, v - b().y)), { label: 'Y', unit: 'px', width: 72, decimals: 2 });
    const angle = h('span.so-info');
    const sync = () => {
      const r = b(); W.setValue(round(r.w)); H.setValue(round(r.h)); X.setValue(round(r.x)); Y.setValue(round(r.y));
      const [a, bb] = so.matrix;
      angle.textContent = `Angle: ${round((Math.atan2(bb, a) * 180) / Math.PI)}°   Scale: ${round(Math.hypot(a, bb) * 100)}%`;
    };
    sync();
    const off = events.on('layers', d => { if (d === doc) sync(); });
    container.append(h('div.so-props', null,
      h('div.so-head', null, icon('kind-smart', 18), h('span', null, 'Embedded Smart Object'), h('span.so-dim', null, `${so.contents?.width ?? so.source.width} × ${so.contents?.height ?? so.source.height} px`)),
      h('div.so-grid', null, W, X, H, Y),
      angle,
      h('div.so-buttons', null,
        button('Edit Contents', () => editContents(doc, so), { title: 'Open the contents in a new document' }),
        button('Convert to Layers', async () => { const { runCommand } = await import('../core/commands'); runCommand('layer.smartToLayers'); }, { title: 'Replace the smart object with its layers' })),
    ));
    return off;
  },
});

// styles (small, scoped)
const css = document.createElement('style');
css.textContent = `
.so-props { padding: 6px 12px 12px; display: flex; flex-direction: column; gap: 10px; }
.so-head { display: flex; align-items: center; gap: 8px; color: var(--text-strong); }
.so-dim { margin-left: auto; color: var(--text-dim); }
.so-grid { display: grid; grid-template-columns: auto auto; gap: 6px 16px; justify-content: start; }
.so-grid .num-wrap .scrub-label { width: 14px; }
.so-info { color: var(--text-dim); }
.so-buttons { display: flex; gap: 8px; flex-wrap: wrap; }
`;
document.head.appendChild(css);

export { cropCanvas };
