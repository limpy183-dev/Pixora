// Layer model.
//
// RULES (important for history + serialization):
//  * All persistent layer state lives in own enumerable properties. Properties whose name starts
//    with "_" are transient caches: they are skipped by history snapshots, clone() and file saving.
//  * Canvases are stored by reference in history snapshots. NEVER mutate a layer/mask canvas in place
//    unless you wrapped the change in `doc.history.beginPixelEdit(...)` (see history.ts). Whole-canvas
//    operations (filters, transforms, resizes) should create a NEW canvas and assign it inside
//    `doc.history.transaction(...)`.
//  * After changing layer props call `doc.layersChanged()`; after changing pixels `doc.pixelsChanged(layer, rect)`.
import type { BlendMode, LayerEffect, LayerKind, LayerLocks, LayerMask, Rect } from './types';
import { cloneCanvas, createCanvas, ctx2d } from './canvas';
import type { PixDocument } from './document';

let nextLayerId = 1;
export const newLayerId = () => nextLayerId++;
export const reserveLayerId = (id: number) => { if (id >= nextLayerId) nextLayerId = id + 1; };

export interface LayerContent { canvas: HTMLCanvasElement; x: number; y: number }

/** Deep-clone plain state; canvases/bitmaps/Layers are kept by reference (or cloned when cloneCanvases). */
export function cloneState<T>(v: T, cloneCanvases = false): T {
  if (v === null || typeof v !== 'object') return v;
  if (v instanceof HTMLCanvasElement) return (cloneCanvases ? cloneCanvas(v) : v) as any;
  if (v instanceof ImageData || v instanceof ImageBitmap || v instanceof HTMLImageElement || v instanceof Path2D || v instanceof Layer) return v;
  if (v instanceof DOMMatrix) return DOMMatrix.fromMatrix(v) as any;
  if (v instanceof Float32Array || v instanceof Uint8Array || v instanceof Uint8ClampedArray || v instanceof Float64Array) return v.slice() as any;
  if (Array.isArray(v)) return v.map(x => cloneState(x, cloneCanvases)) as any;
  const out = Object.create(Object.getPrototypeOf(v));
  for (const k of Object.keys(v as any)) if (k[0] !== '_') out[k] = cloneState((v as any)[k], cloneCanvases);
  return out;
}

export const defaultLocks = (): LayerLocks => ({ transparency: false, pixels: false, position: false, artboard: false, all: false });

export abstract class Layer {
  id = newLayerId();
  abstract kind: LayerKind;
  name = 'Layer';
  visible = true;
  opacity = 1;              // 0..1
  fillOpacity = 1;          // 0..1 ("Fill" in Layers panel; does not affect layer effects)
  blendMode: BlendMode = 'normal';
  locks: LayerLocks = defaultLocks();
  clipped = false;          // clipping mask onto the layer below
  mask: LayerMask | null = null;
  effects: LayerEffect[] = [];
  effectsVisible = true;
  colorLabel = 'none';      // none|red|orange|yellow|green|blue|violet|gray
  isBackground = false;
  linkId = 0;               // layers sharing a non-zero linkId are linked

  /** Transient: parent group (null = root). Maintained by PixDocument. */
  _parent: GroupLayer | null = null;
  /** Transient: bumped whenever content changes (thumbnails / caches compare it). */
  _version = 0;
  /** Transient: live preview content used by the compositor instead of getContent() (brush strokes, filter previews). */
  _preview: LayerContent | null = null;

  /** Content pixels in document coordinates, or null (group, adjustment, empty). */
  abstract getContent(doc: PixDocument): LayerContent | null;

  /** Mark cached rasterization stale. */
  invalidate() { this._version++; }

  get isPixelLayer() { return this.kind === 'raster'; }
  /** Pixel painting blocked (lock pixels / lock all). */
  get pixelsLocked() { return this.locks.all || this.locks.pixels; }
  get positionLocked() { return this.locks.all || this.locks.position || this.isBackground; }
  get transparencyLocked() { return this.locks.all || this.locks.transparency || this.isBackground; }

  /** Move the layer content by (dx, dy) document px (linked mask follows). Vector layers override. */
  translate(dx: number, dy: number) {
    const self = this as any;
    if (typeof self.x === 'number') { self.x += dx; self.y += dy; }
    if (this.mask && this.mask.linked) { this.mask.x += dx; this.mask.y += dy; }
    this.invalidate();
  }

  /** Bounds of the layer content in document coordinates. */
  bounds(doc: PixDocument): Rect | null {
    const c = this.getContent(doc);
    return c ? { x: c.x, y: c.y, w: c.canvas.width, h: c.canvas.height } : null;
  }

  snapshot(): any {
    const s: any = {};
    for (const k of Object.keys(this)) if (k[0] !== '_' && k !== 'children') s[k] = cloneState((this as any)[k]);
    return s;
  }
  restore(s: any) {
    for (const k of Object.keys(s)) (this as any)[k] = cloneState(s[k]);
    this.invalidate();
  }
  /** Deep copy with a new id (canvases duplicated). Groups copy children too. */
  clone(): Layer {
    const c: Layer = Object.create(Object.getPrototypeOf(this));
    for (const k of Object.keys(this)) if (k[0] !== '_' && k !== 'children') (c as any)[k] = cloneState((this as any)[k], true);
    c.id = newLayerId();
    c._parent = null;
    c._version = 0;
    if (this instanceof GroupLayer) (c as GroupLayer).children = this.children.map(ch => { const cc = ch.clone(); cc._parent = c as GroupLayer; return cc; });
    c.invalidate();
    return c;
  }
}

export class RasterLayer extends Layer {
  kind: LayerKind = 'raster';
  canvas: HTMLCanvasElement;
  x = 0;
  y = 0;
  constructor(w = 1, h = 1, name = 'Layer') {
    super();
    this.canvas = createCanvas(w, h);
    this.name = name;
  }
  get ctx() { return ctx2d(this.canvas); }
  getContent(): LayerContent { return { canvas: this.canvas, x: this.x, y: this.y }; }
  /** Grow (never shrink) the canvas so it covers `r` (document coords). Replaces this.canvas when it grows. */
  ensureRect(r: Rect): boolean {
    const x0 = Math.min(this.x, Math.floor(r.x)), y0 = Math.min(this.y, Math.floor(r.y));
    const x1 = Math.max(this.x + this.canvas.width, Math.ceil(r.x + r.w)), y1 = Math.max(this.y + this.canvas.height, Math.ceil(r.y + r.h));
    if (x0 === this.x && y0 === this.y && x1 - x0 === this.canvas.width && y1 - y0 === this.canvas.height) return false;
    const c = createCanvas(x1 - x0, y1 - y0);
    ctx2d(c).drawImage(this.canvas, this.x - x0, this.y - y0);
    this.canvas = c; this.x = x0; this.y = y0;
    this.invalidate();
    return true;
  }
}

export class GroupLayer extends Layer {
  kind: LayerKind = 'group';
  children: Layer[] = [];   // bottom → top
  expanded = true;
  constructor(name = 'Group 1') {
    super();
    this.name = name;
    this.blendMode = 'pass-through';
  }
  getContent(): null { return null; }
  translate(dx: number, dy: number) {
    for (const ch of this.children) ch.translate(dx, dy);
    if (this.mask && this.mask.linked) { this.mask.x += dx; this.mask.y += dy; }
    this.invalidate();
  }
  bounds(doc: PixDocument): Rect | null {
    let r: Rect | null = null;
    for (const ch of this.children) {
      const b = ch.bounds(doc);
      if (!b) continue;
      if (!r) r = { ...b };
      else { const x = Math.min(r.x, b.x), y = Math.min(r.y, b.y); r = { x, y, w: Math.max(r.x + r.w, b.x + b.w) - x, h: Math.max(r.y + r.h, b.y + b.h) - y }; }
    }
    return r;
  }
}

/** Non-destructive adjustment. `adjustment.type` is a key of the adjustments registry. */
export class AdjustmentLayer extends Layer {
  kind: LayerKind = 'adjustment';
  adjustment: { type: string; params: any };
  constructor(type: string, params: any, name?: string) {
    super();
    this.adjustment = { type, params };
    this.name = name || type;
  }
  getContent(): null { return null; }
  bounds(doc: PixDocument): Rect { return { x: 0, y: 0, w: doc.width, h: doc.height }; }
}

/** Registry of layer classes by kind (for file loading). Feature modules register their own kinds. */
export const layerClasses: Record<string, new () => Layer> = {
  raster: RasterLayer as any,
  group: GroupLayer as any,
  adjustment: AdjustmentLayer as any,
};
export function registerLayerClass(kind: string, ctor: new () => Layer) { layerClasses[kind] = ctor; }

/** Create an empty layer mask covering the document, filled with value 255 (reveal) or 0 (hide). */
export function createMask(doc: PixDocument, value: 0 | 255 = 255): LayerMask {
  const c = createCanvas(doc.width, doc.height);
  if (value) { const x = ctx2d(c); x.fillStyle = '#000'; x.fillRect(0, 0, c.width, c.height); }
  return { canvas: c, x: 0, y: 0, bg: value, enabled: true, linked: true, density: 1, feather: 0 };
}
