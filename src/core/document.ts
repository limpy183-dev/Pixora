// PixDocument: one open image.
import { events } from './events';
import { History } from './history';
import { Selection } from './selection';
import { GroupLayer, Layer, RasterLayer, cloneState, layerClasses, reserveLayerId } from './layer';
import type { LayerContent } from './layer';
import type { ColorMode, LayerMask, Rect, RGB } from './types';
import { alphaBounds, canvasFromBlob, canvasToBlob, cloneCanvas, createCanvas, ctx2d } from './canvas';
import { unionRect } from './geom';
import { updateComposite } from './compositor';

export interface Guide { id: number; orientation: 'h' | 'v'; pos: number }  // pos in doc px
export interface AlphaChannel { id: number; name: string; canvas: HTMLCanvasElement }

export interface ViewState {
  zoom: number;         // 1 = 100%
  panX: number;         // screen x (CSS px, relative to canvas area) of document origin (before rotation)
  panY: number;
  rotation: number;     // degrees (Rotate View tool)
  flip: boolean;        // horizontal view flip
  fitted: boolean;      // true until the user zooms/pans (keeps fit-on-screen on resize)
}

/** Paint target returned by doc.getPaintTarget(). `holder.canvas` is painted in place (use beginPixelEdit). */
export interface PaintTarget {
  kind: 'pixels' | 'mask' | 'quickmask';
  layer: Layer | null;
  holder: { canvas: HTMLCanvasElement; x: number; y: number; _preview?: any };
  /** true for masks: paint colours are converted to grey levels (white reveals / selects). */
  isMask: boolean;
}

export interface DocState {
  width: number; height: number; resolution: number; mode: ColorMode;
  tree: NodeState[];
  activeLayerId: number | null;
  selectedIds: number[];
  selection: { mask: HTMLCanvasElement | null; bounds: Rect | null };
  guides: Guide[];
  paths: any[];
  channels: AlphaChannel[];
  quickMask: { canvas: HTMLCanvasElement; x: number; y: number } | null;
  editMask: boolean;
  extra: any;
}
interface NodeState { layer: Layer; state: any; children?: NodeState[] }

/** Global render scheduler hook – set by the workspace. */
export const renderHooks = {
  request: (_doc: PixDocument, _overlayOnly = false) => {},
};

let docCounter = 0;
const boundsCache = new WeakMap<Layer, { version: number; canvas: HTMLCanvasElement; x: number; y: number; rect: Rect | null }>();
let untitledCounter = 0;

export class PixDocument {
  id = ++docCounter;
  name: string;
  width: number;
  height: number;
  resolution = 72;              // pixels per inch
  /** Unit used to DISPLAY resolution (value is always stored as ppi). */
  resolutionUnit: 'ppi' | 'ppcm' = 'ppi';
  mode: ColorMode = 'RGB';
  bitDepth: 8 | 16 | 32 = 8;
  layers: Layer[] = [];         // root layers, bottom → top
  activeLayerId: number | null = null;
  selectedIds: number[] = [];
  selection: Selection;
  lastSelection: HTMLCanvasElement | null = null;
  guides: Guide[] = [];
  paths: any[] = [];            // Paths panel data (owned by the vector module)
  channels: AlphaChannel[] = [];// saved selections (alpha channels)
  quickMask: { canvas: HTMLCanvasElement; x: number; y: number; _preview?: HTMLCanvasElement | null } | null = null;
  /** true = painting edits the active layer's mask instead of its pixels. */
  editMask = false;
  /** Layer id whose mask is shown full-screen (Alt+click mask thumbnail), or 0. */
  viewMaskLayerId = 0;
  /** Free-form per-feature state that should participate in undo (keep plain data). */
  extra: any = {};
  history: History;
  view: ViewState = { zoom: 1, panX: 0, panY: 0, rotation: 0, flip: false, fitted: true };
  composite: HTMLCanvasElement;
  modified = false;
  fileName: string | null = null;
  fileHandle: any = null;
  meta: Record<string, string> = {};
  layerCounter = 0;
  /** Composite region needing re-render (doc coords) or null. */
  _dirty: Rect | null = null;

  constructor(width: number, height: number, name?: string) {
    this.width = Math.max(1, Math.round(width));
    this.height = Math.max(1, Math.round(height));
    this.name = name || `Untitled-${++untitledCounter}`;
    this.selection = new Selection(this);
    this.history = new History(this);
    this.composite = createCanvas(this.width, this.height);
    this._dirty = { x: 0, y: 0, w: this.width, h: this.height };
  }

  /** Create a document with a single background layer. background: color, 'transparent' or null. */
  static create(width: number, height: number, opts: { name?: string; resolution?: number; resolutionUnit?: 'ppi' | 'ppcm'; background?: RGB | 'transparent' | null; mode?: ColorMode } = {}): PixDocument {
    const doc = new PixDocument(width, height, opts.name);
    doc.resolution = opts.resolution || 72;
    doc.resolutionUnit = opts.resolutionUnit || 'ppi';
    if (opts.mode) doc.mode = opts.mode;
    const bg = opts.background === undefined ? { r: 255, g: 255, b: 255 } : opts.background;
    const layer = new RasterLayer(doc.width, doc.height, 'Background');
    if (bg && bg !== 'transparent') {
      const x = layer.ctx; x.fillStyle = `rgb(${bg.r},${bg.g},${bg.b})`; x.fillRect(0, 0, doc.width, doc.height);
      layer.isBackground = true;
    } else { layer.name = 'Layer 0'; }
    doc.layers.push(layer);
    doc.activeLayerId = layer.id;
    doc.selectedIds = [layer.id];
    doc.history.baseName = 'New';
    doc.history.snapshots = [{ name: doc.name, state: doc.captureState(true) }];
    return doc;
  }

  // ---------------------------------------------------------------- layer tree
  /** All layers depth-first, bottom → top (a group comes AFTER its children, i.e. above them). */
  allLayers(): Layer[] {
    const out: Layer[] = [];
    const walk = (list: Layer[]) => { for (const l of list) { if (l instanceof GroupLayer) walk(l.children); out.push(l); } };
    walk(this.layers);
    return out;
  }
  findLayer(id: number | null | undefined): Layer | null {
    if (!id) return null;
    for (const l of this.allLayers()) if (l.id === id) return l;
    return null;
  }
  /** The array containing `layer` (root list or a group's children). */
  siblingsOf(layer: Layer): Layer[] { return layer._parent ? layer._parent.children : this.layers; }
  parentOf(layer: Layer): GroupLayer | null { return layer._parent; }
  get activeLayer(): Layer | null { return this.findLayer(this.activeLayerId); }
  get selectedLayers(): Layer[] {
    const set = new Set(this.selectedIds);
    return this.allLayers().filter(l => set.has(l.id));
  }
  /** Make `layer` active. additive=true toggles it in the multi-selection (Ctrl+click). */
  setActiveLayer(layer: Layer | null, additive = false) {
    if (!layer) { this.activeLayerId = null; this.selectedIds = []; }
    else if (additive) {
      const i = this.selectedIds.indexOf(layer.id);
      if (i >= 0 && this.selectedIds.length > 1) {
        this.selectedIds.splice(i, 1);
        if (this.activeLayerId === layer.id) this.activeLayerId = this.selectedIds[this.selectedIds.length - 1];
      } else if (i < 0) { this.selectedIds.push(layer.id); this.activeLayerId = layer.id; }
    } else { this.activeLayerId = layer.id; this.selectedIds = [layer.id]; }
    if (!(this.activeLayer?.mask)) this.editMask = false;
    events.emit('activeLayer', this);
  }
  /** Re-link _parent pointers (call after structural edits done by hand). */
  relink() {
    const walk = (list: Layer[], parent: GroupLayer | null) => { for (const l of list) { l._parent = parent; if (l instanceof GroupLayer) walk(l.children, l); } };
    walk(this.layers, null);
  }
  nextLayerName(base = 'Layer') { return `${base} ${++this.layerCounter}`; }

  /** Insert a layer. Default position: directly above the active layer (inside the same group). */
  addLayer(layer: Layer, opts: { above?: Layer | null; parent?: GroupLayer | null; index?: number; select?: boolean } = {}): Layer {
    let list: Layer[], index: number;
    const ref = opts.above !== undefined ? opts.above : this.activeLayer;
    if (opts.parent !== undefined || opts.index !== undefined) {
      list = opts.parent ? opts.parent.children : this.layers;
      index = opts.index ?? list.length;
      layer._parent = opts.parent || null;
    } else if (ref) {
      list = this.siblingsOf(ref); index = list.indexOf(ref) + 1; layer._parent = ref._parent;
    } else { list = this.layers; index = list.length; layer._parent = null; }
    list.splice(index, 0, layer);
    this.relink();
    if (opts.select !== false) this.setActiveLayer(layer);
    this.layersChanged();
    return layer;
  }
  removeLayer(layer: Layer) {
    const list = this.siblingsOf(layer), i = list.indexOf(layer);
    if (i < 0) return;
    list.splice(i, 1);
    layer._parent = null;
    if (this.selectedIds.includes(layer.id) || this.activeLayerId === layer.id) {
      this.selectedIds = this.selectedIds.filter(id => id !== layer.id && this.findLayer(id));
      const next = list[Math.min(i, list.length - 1)] || list[i - 1] || null;
      const fallback = next || (layer._parent as any) || this.layers[this.layers.length - 1] || null;
      this.activeLayerId = this.selectedIds[0] ?? fallback?.id ?? null;
      if (!this.selectedIds.length && this.activeLayerId) this.selectedIds = [this.activeLayerId];
      events.emit('activeLayer', this);
    }
    this.relink();
    this.layersChanged();
  }
  /** Move `layer` into `parent` (null = root) at `index` (in that list after removal). */
  moveLayer(layer: Layer, parent: GroupLayer | null, index: number) {
    const from = this.siblingsOf(layer), i = from.indexOf(layer);
    if (i >= 0) from.splice(i, 1);
    const to = parent ? parent.children : this.layers;
    to.splice(Math.max(0, Math.min(index, to.length)), 0, layer);
    this.relink();
    this.layersChanged();
  }
  /** Convenience: create an empty doc-sized raster layer above the active layer. */
  newRasterLayer(name?: string, opts: { above?: Layer | null; select?: boolean } = {}): RasterLayer {
    const l = new RasterLayer(this.width, this.height, name || this.nextLayerName());
    this.addLayer(l, opts);
    return l;
  }

  /** Resolve what painting tools should paint on, or null if the active layer can't be painted. */
  getPaintTarget(): PaintTarget | null {
    if (this.quickMask) return { kind: 'quickmask', layer: null, holder: this.quickMask, isMask: true };
    const layer = this.activeLayer;
    if (!layer) return null;
    if (this.editMask && layer.mask) return { kind: 'mask', layer, holder: layer.mask as LayerMask & { _preview?: any }, isMask: true };
    if (layer instanceof RasterLayer) return { kind: 'pixels', layer, holder: layer, isMask: false };
    return null;
  }

  // ---------------------------------------------------------------- change notification
  /** Mark part (or all) of the composite as needing re-render. */
  invalidate(rect?: Rect | null) {
    const full = { x: 0, y: 0, w: this.width, h: this.height };
    this._dirty = rect ? unionRect(this._dirty, rect) : full;
    renderHooks.request(this);
  }
  /** Layer tree or layer properties changed. */
  layersChanged() { this.invalidate(); events.emit('layers', this); }
  /** Pixel content of `layer` changed inside `rect` (doc coords; null = everything). */
  pixelsChanged(layer: Layer | null, rect?: Rect | null) {
    layer?.invalidate();
    this.invalidate(rect || null);
    events.emit('pixels', { doc: this, layer, rect: rect || null });
  }
  selectionChanged() { renderHooks.request(this, true); events.emit('selection', this); }
  /** Overlay-only redraw (tool previews, guides...). */
  redrawOverlay() { renderHooks.request(this, true); }
  afterHistoryJump() {
    this.relink();
    for (const l of this.allLayers()) l.invalidate();
    this.invalidate();
    events.emit('layers', this);
    events.emit('activeLayer', this);
    events.emit('selection', this);
    events.emit('guides', this);
    events.emit('paths', this);
    events.emit('pixels', { doc: this, layer: null, rect: null });
  }

  /** Change document dimensions (does not touch layer pixels — callers handle that). */
  setSize(w: number, h: number) {
    w = Math.max(1, Math.round(w)); h = Math.max(1, Math.round(h));
    if (w === this.width && h === this.height) return;
    this.width = w; this.height = h;
    this.composite = createCanvas(w, h);
    this.invalidate();
    events.emit('docSize', this);
  }

  // ---------------------------------------------------------------- history state
  captureState(cloneCanvases = false): DocState {
    const walk = (list: Layer[]): NodeState[] => list.map(l => {
      const state = cloneCanvases ? cloneState(l.snapshot(), true) : l.snapshot();
      return l instanceof GroupLayer ? { layer: l, state, children: walk(l.children) } : { layer: l, state };
    });
    const sel = this.selection.state();
    return {
      width: this.width, height: this.height, resolution: this.resolution, mode: this.mode,
      tree: walk(this.layers),
      activeLayerId: this.activeLayerId,
      selectedIds: [...this.selectedIds],
      selection: cloneCanvases && sel.mask ? { mask: cloneCanvas(sel.mask), bounds: sel.bounds } : sel,
      guides: cloneState(this.guides),
      paths: cloneState(this.paths, cloneCanvases),
      channels: cloneState(this.channels, cloneCanvases),
      quickMask: this.quickMask ? { canvas: cloneCanvases ? cloneCanvas(this.quickMask.canvas) : this.quickMask.canvas, x: 0, y: 0 } : null,
      editMask: this.editMask,
      extra: cloneState(this.extra, cloneCanvases),
    };
  }
  restoreState(s: DocState, cloneCanvases = false) {
    const sizeChanged = s.width !== this.width || s.height !== this.height || s.resolution !== this.resolution || s.mode !== this.mode;
    this.width = s.width; this.height = s.height; this.resolution = s.resolution; this.mode = s.mode;
    if (this.composite.width !== s.width || this.composite.height !== s.height) this.composite = createCanvas(s.width, s.height);
    const build = (nodes: NodeState[], parent: GroupLayer | null): Layer[] => nodes.map(n => {
      n.layer.restore(cloneCanvases ? cloneState(n.state, true) : n.state);
      n.layer._parent = parent;
      if (n.children && n.layer instanceof GroupLayer) n.layer.children = build(n.children, n.layer);
      return n.layer;
    });
    this.layers = build(s.tree, null);
    this.activeLayerId = s.activeLayerId;
    this.selectedIds = [...s.selectedIds];
    this.selection.setState(cloneCanvases && s.selection.mask ? { mask: cloneCanvas(s.selection.mask), bounds: s.selection.bounds } : s.selection);
    this.guides = cloneState(s.guides);
    this.paths = cloneState(s.paths, cloneCanvases);
    this.channels = cloneState(s.channels, cloneCanvases);
    this.quickMask = s.quickMask ? { canvas: cloneCanvases ? cloneCanvas(s.quickMask.canvas) : s.quickMask.canvas, x: 0, y: 0 } : null;
    this.editMask = s.editMask;
    this.extra = cloneState(s.extra, cloneCanvases);
    this.afterHistoryJump();
    if (sizeChanged) events.emit('docSize', this);
  }

  // ---------------------------------------------------------------- serialization (.pxd)
  /** Serialize to JSON + PNG blobs (canvases are replaced by {"$canvas": index}). */
  async serialize(): Promise<{ json: any; blobs: Blob[] }> {
    const blobs: Blob[] = [];
    const pending: Promise<void>[] = [];
    const enc = (v: any): any => {
      if (v === null || typeof v !== 'object') return v;
      if (v instanceof HTMLCanvasElement) {
        const i = blobs.length; blobs.push(null as any);
        pending.push(canvasToBlob(v).then(b => { blobs[i] = b; }));
        return { $canvas: i };
      }
      if (v instanceof Layer) {
        const o: any = { $layer: v.kind };
        for (const k of Object.keys(v)) if (k[0] !== '_') o[k] = enc((v as any)[k]);
        return o;
      }
      if (v instanceof DOMMatrix) return { $matrix: [v.a, v.b, v.c, v.d, v.e, v.f] };
      if (ArrayBuffer.isView(v)) return { $typed: v.constructor.name, data: Array.from(v as any) };
      if (Array.isArray(v)) return v.map(enc);
      const o: any = {};
      for (const k of Object.keys(v)) if (k[0] !== '_' && typeof v[k] !== 'function') o[k] = enc(v[k]);
      return o;
    };
    const json = {
      format: 'pixora', version: 1,
      name: this.name, width: this.width, height: this.height, resolution: this.resolution, resolutionUnit: this.resolutionUnit, mode: this.mode, bitDepth: this.bitDepth,
      layers: enc(this.layers), activeLayerId: this.activeLayerId, selectedIds: this.selectedIds,
      selection: enc(this.selection.mask), guides: this.guides, paths: enc(this.paths), channels: enc(this.channels),
      extra: enc(this.extra), meta: this.meta, layerCounter: this.layerCounter,
    };
    await Promise.all(pending);
    return { json, blobs };
  }
  static async deserialize(json: any, blobs: Blob[]): Promise<PixDocument> {
    const canvases = await Promise.all(blobs.map(b => canvasFromBlob(b)));
    const dec = (v: any): any => {
      if (v === null || typeof v !== 'object') return v;
      if (Array.isArray(v)) return v.map(dec);
      if ('$canvas' in v) return canvases[v.$canvas];
      if ('$matrix' in v) return new DOMMatrix(v.$matrix);
      if ('$typed' in v) return new (globalThis as any)[v.$typed](v.data);
      if ('$layer' in v) {
        const Ctor = layerClasses[v.$layer] || RasterLayer;
        const l: any = new (Ctor as any)();
        for (const k of Object.keys(v)) if (k !== '$layer') l[k] = dec(v[k]);
        reserveLayerId(l.id);
        l.invalidate?.();
        return l;
      }
      const o: any = {};
      for (const k of Object.keys(v)) o[k] = dec(v[k]);
      return o;
    };
    const doc = new PixDocument(json.width, json.height, json.name);
    doc.resolution = json.resolution || 72;
    doc.resolutionUnit = json.resolutionUnit || 'ppi';
    doc.mode = json.mode || 'RGB';
    doc.bitDepth = json.bitDepth || 8;
    doc.layers = dec(json.layers);
    doc.relink();
    doc.activeLayerId = json.activeLayerId;
    doc.selectedIds = json.selectedIds || [];
    const sel = dec(json.selection);
    if (sel) doc.selection.setMask(sel);
    doc.guides = json.guides || [];
    doc.paths = dec(json.paths) || [];
    doc.channels = dec(json.channels) || [];
    doc.extra = dec(json.extra) || {};
    doc.meta = json.meta || {};
    doc.layerCounter = json.layerCounter || 0;
    doc.history.baseName = 'Open';
    doc.history.snapshots = [{ name: doc.name, state: doc.captureState(true) }];
    return doc;
  }

  /** Up-to-date composite (renders pending dirty regions). Do not mutate the returned canvas. */
  getComposite(): HTMLCanvasElement {
    updateComposite(this);
    return this.composite;
  }
  /** Flattened copy of the visible image. */
  flattenedCanvas(): HTMLCanvasElement {
    return cloneCanvas(this.getComposite());
  }
  /** Tight bounds of a layer's visible pixels (alpha > 0) in doc coords, cached per content version. Groups: union of children. */
  layerBounds(layer: Layer): Rect | null {
    if (layer instanceof GroupLayer) {
      let r: Rect | null = null;
      for (const ch of layer.children) r = unionRect(r, this.layerBounds(ch));
      return r;
    }
    if (layer.kind === 'adjustment' || layer.kind === 'fill') return { x: 0, y: 0, w: this.width, h: this.height };
    const c = layer.getContent(this);
    if (!c) return null;
    const hit = boundsCache.get(layer);
    if (hit && hit.version === layer._version && hit.canvas === c.canvas && hit.x === c.x && hit.y === c.y) return hit.rect ? { ...hit.rect } : null;
    const b = alphaBounds(c.canvas, 0);
    const rect = b ? { x: b.x + c.x, y: b.y + c.y, w: b.w, h: b.h } : null;
    boundsCache.set(layer, { version: layer._version, canvas: c.canvas, x: c.x, y: c.y, rect });
    return rect ? { ...rect } : null;
  }
  /** Top-most visible layer with a non-transparent pixel at (x, y), or null. */
  layerAt(x: number, y: number, opts: { groups?: boolean } = {}): Layer | null {
    const list = this.allLayers().reverse();
    const visible = (l: Layer): boolean => l.visible && (!l._parent || visible(l._parent));
    for (const l of list) {
      if (l instanceof GroupLayer || l.kind === 'adjustment' || !visible(l)) continue;
      const c = l.getContent(this);
      if (!c) continue;
      const lx = Math.floor(x - c.x), ly = Math.floor(y - c.y);
      if (lx < 0 || ly < 0 || lx >= c.canvas.width || ly >= c.canvas.height) continue;
      const a = ctx2d(c.canvas).getImageData(lx, ly, 1, 1).data[3];
      if (a > 12) {
        if (!opts.groups) return l;
        let top: Layer = l;
        while (top._parent) top = top._parent;
        return top;
      }
    }
    return null;
  }

  /** Content of a layer drawn onto a doc-sized canvas (for sampling). */
  layerAsDocCanvas(layer: Layer): HTMLCanvasElement {
    const c = createCanvas(this.width, this.height), content: LayerContent | null = layer.getContent(this);
    if (content) ctx2d(c).drawImage(content.canvas, content.x, content.y);
    return c;
  }
}
