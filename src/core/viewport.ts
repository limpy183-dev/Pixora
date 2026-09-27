// Viewport: renders the active document into the canvas area (zoom / pan / rotate), draws overlays
// (marching ants, pixel grid, tool feedback, hooks for guides/grid/paths) and dispatches pointer input to tools.
import { app, saveJSON } from './app';
import type { Tool, ToolPointer } from './app';
import { events } from './events';
import { renderHooks, type PixDocument } from './document';
import { updateComposite } from './compositor';
import { checkerPattern, createCanvas, ctx2d } from './canvas';
import type { Point, Rect } from './types';

export interface ViewOptions {
  rulers: boolean; extras: boolean; pixelGrid: boolean; grid: boolean; guides: boolean; selectionEdges: boolean;
  snap: boolean; snapGuides: boolean; snapGrid: boolean; snapLayers: boolean; snapBounds: boolean;
  lockGuides: boolean; smartGuides: boolean; targetPath: boolean; layerEdges: boolean;
}
const VIEW_DEFAULTS: ViewOptions = {
  rulers: false, extras: true, pixelGrid: true, grid: false, guides: true, selectionEdges: true,
  snap: true, snapGuides: true, snapGrid: true, snapLayers: true, snapBounds: true,
  lockGuides: false, smartGuides: true, targetPath: true, layerEdges: false,
};
export const viewOptions: ViewOptions = (() => {
  try { return { ...VIEW_DEFAULTS, ...JSON.parse(localStorage.getItem('pixora.view') || '{}') }; } catch { return { ...VIEW_DEFAULTS }; }
})();
export function setViewOption<K extends keyof ViewOptions>(k: K, v: ViewOptions[K]) {
  viewOptions[k] = v;
  saveJSON('pixora.view', viewOptions);
  app.viewport?.requestRender();
  events.emit('view', app.activeDoc!);
}

type DrawHook = (ctx: CanvasRenderingContext2D, view: Viewport, doc: PixDocument) => void;
/** Extension points for other modules (guides, grid, paths, color samplers, transform boxes...). */
export const viewportHooks = {
  /** Drawn on the main canvas right after the composite (screen space). */
  afterComposite: [] as DrawHook[],
  /** Drawn on the overlay canvas before the active tool overlay (screen space). */
  overlay: [] as DrawHook[],
  /** Pointer interceptors (e.g. dragging guides with the Move tool). Return true to take the whole drag. */
  pointerDown: [] as ((p: ToolPointer, doc: PixDocument, view: Viewport) => boolean | { move?(p: ToolPointer): void; up?(p: ToolPointer): void })[],
  /** Context menu provider for the canvas when the tool doesn't supply one. */
  contextMenu: null as null | ((p: ToolPointer, doc: PixDocument) => void),
};

export const ZOOM_STEPS = [0.01, 0.015, 0.02, 0.03, 0.04, 0.05, 0.0625, 0.0833, 0.125, 0.1667, 0.25, 0.3333, 0.5, 0.6667, 1, 2, 3, 4, 5, 6, 7, 8, 12, 16, 20, 24, 32, 48, 64];
export const MIN_ZOOM = 0.01, MAX_ZOOM = 64;

/** Tools that must never be replaced by the temporary Ctrl → Move override. */
export const NO_CTRL_MOVE = new Set(['hand', 'rotate-view', 'zoom', 'move', 'path-select', 'direct-select', 'pen', 'freeform-pen', 'curvature-pen', 'add-anchor', 'delete-anchor', 'convert-point', 'type', 'type-vertical', 'crop', 'perspective-crop', 'artboard']);

export class Viewport {
  readonly canvas: HTMLCanvasElement;
  readonly overlay: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private octx: CanvasRenderingContext2D;
  width = 1;
  height = 1;
  dpr = window.devicePixelRatio || 1;
  doc: PixDocument | null = null;
  /** Last known pointer position (for brush cursors). */
  pointer = { x: 0, y: 0, sx: -1, sy: -1, inside: false, down: false };
  private needMain = true;
  private needOverlay = true;
  private raf = 0;
  private antsOffset = 0;
  private antsTimer = 0;
  private drag: { tool: Tool | null; hook?: { move?(p: ToolPointer): void; up?(p: ToolPointer): void }; pointerId: number } | null = null;
  private interacting = 0;

  constructor(readonly el: HTMLElement) {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'view-canvas';
    this.overlay = document.createElement('canvas');
    this.overlay.className = 'view-overlay';
    el.append(this.canvas, this.overlay);
    this.ctx = this.canvas.getContext('2d', { alpha: false })!;
    this.octx = ctx2d(this.overlay);
    new ResizeObserver(() => this.resize()).observe(el);
    this.bindInput();
    renderHooks.request = (doc, overlayOnly) => { if (doc === this.doc) this.requestRender(overlayOnly); };
    this.antsTimer = window.setInterval(() => {
      const d = this.doc;
      if (d && ((!d.selection.empty && viewOptions.extras && viewOptions.selectionEdges) || this.hasAntsOverlay)) {
        this.antsOffset = (this.antsOffset + 1) % 8;
        this.requestRender(true);
      }
    }, 110);
    app.viewport = this;
    this.resize();
  }
  /** Set by tools that draw their own animated ants (e.g. marquee while dragging). */
  hasAntsOverlay = false;
  /** Temporary offset applied to the selection outline while dragging selected pixels (doc px). */
  selectionOffset = { x: 0, y: 0 };
  /** Hide the marching ants (e.g. while a tool draws its own selection preview). */
  hideSelection = false;
  get antsPhase() { return this.antsOffset; }

  setDocument(doc: PixDocument | null) {
    this.doc = doc;
    if (doc && doc.view.fitted) this.fit(false);
    this.requestRender();
  }

  // ------------------------------------------------------------------ geometry
  get zoom() { return this.doc?.view.zoom ?? 1; }
  /** doc → screen (CSS px) matrix. */
  matrix(): DOMMatrix {
    const v = this.doc?.view;
    if (!v) return new DOMMatrix();
    let m = new DOMMatrix().translate(v.panX, v.panY);
    if (v.rotation || v.flip) {
      const cx = this.width / 2, cy = this.height / 2;
      m = new DOMMatrix().translate(cx, cy).rotate(v.rotation).scale(v.flip ? -1 : 1, 1).translate(-cx, -cy).multiply(m);
    }
    return m.scale(v.zoom, v.zoom);
  }
  docToScreen(x: number, y: number): Point {
    const p = this.matrix().transformPoint(new DOMPoint(x, y));
    return { x: p.x, y: p.y };
  }
  screenToDoc(sx: number, sy: number): Point {
    const p = this.matrix().inverse().transformPoint(new DOMPoint(sx, sy));
    return { x: p.x, y: p.y };
  }
  /** Screen rect (axis aligned bounds) of a doc rect. */
  docRectToScreen(r: Rect): Rect {
    const pts = [this.docToScreen(r.x, r.y), this.docToScreen(r.x + r.w, r.y), this.docToScreen(r.x, r.y + r.h), this.docToScreen(r.x + r.w, r.y + r.h)];
    const xs = pts.map(p => p.x), ys = pts.map(p => p.y);
    const x = Math.min(...xs), y = Math.min(...ys);
    return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
  }
  /** Size of one screen pixel in document units. */
  get px() { return 1 / this.zoom; }
  /** Apply the doc→screen transform to a context (for drawing in doc coordinates on the overlay). */
  applyDocTransform(ctx: CanvasRenderingContext2D) {
    const m = this.matrix();
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.transform(m.a, m.b, m.c, m.d, m.e, m.f);
  }
  resetTransform(ctx: CanvasRenderingContext2D) { ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0); }

  // ------------------------------------------------------------------ zoom / pan
  setZoom(z: number, anchor?: { sx: number; sy: number }) {
    const d = this.doc;
    if (!d) return;
    z = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, z));
    const a = anchor || { sx: this.width / 2, sy: this.height / 2 };
    const docPt = this.screenToDoc(a.sx, a.sy);
    d.view.zoom = z;
    // keep docPt under the anchor
    const now = this.docToScreen(docPt.x, docPt.y);
    d.view.panX += a.sx - now.x;
    d.view.panY += a.sy - now.y;
    d.view.fitted = false;
    this.clampPan();
    this.viewChanged();
  }
  zoomIn(anchor?: { sx: number; sy: number }) {
    const z = this.zoom, next = ZOOM_STEPS.find(s => s > z * 1.001) ?? MAX_ZOOM;
    this.setZoom(next, anchor);
  }
  zoomOut(anchor?: { sx: number; sy: number }) {
    const z = this.zoom, prev = [...ZOOM_STEPS].reverse().find(s => s < z / 1.001) ?? MIN_ZOOM;
    this.setZoom(prev, anchor);
  }
  /** Fit on Screen (Ctrl+0). */
  fit(notify = true) {
    const d = this.doc;
    if (!d) return;
    const m = Math.min(112, this.height * 0.12);
    const z = Math.min((this.width - m * 2) / d.width, (this.height - m * 2) / d.height);
    d.view.zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, z));
    d.view.rotation = 0;
    this.center();
    d.view.fitted = true;
    if (notify) this.viewChanged(); else this.requestRender();
  }
  /** Fill screen (zoom so the image fills the viewport). */
  fill() {
    const d = this.doc;
    if (!d) return;
    d.view.zoom = Math.max(this.width / d.width, this.height / d.height);
    this.center();
    d.view.fitted = false;
    this.viewChanged();
  }
  /** 100% (Ctrl+1). */
  actualPixels() { this.setZoom(1); this.center(); this.viewChanged(); }
  /** Print size: zoom so 1 inch of the doc is 96 CSS px. */
  printSize() { const d = this.doc; if (d) { this.setZoom(96 / d.resolution); this.center(); this.viewChanged(); } }
  center() {
    const d = this.doc;
    if (!d) return;
    d.view.panX = (this.width - d.width * d.view.zoom) / 2;
    d.view.panY = (this.height - d.height * d.view.zoom) / 2;
  }
  panBy(dx: number, dy: number) {
    const d = this.doc;
    if (!d) return;
    // pan is applied before rotation: convert the screen delta into the unrotated frame
    const v = d.view;
    if (v.rotation || v.flip) {
      const a = (-v.rotation * Math.PI) / 180;
      let rx = dx * Math.cos(a) - dy * Math.sin(a), ry = dx * Math.sin(a) + dy * Math.cos(a);
      if (v.flip) rx = -rx;
      dx = rx; dy = ry;
    }
    v.panX += dx; v.panY += dy;
    v.fitted = false;
    this.clampPan();
    this.viewChanged();
  }
  setRotation(deg: number) {
    const d = this.doc;
    if (!d) return;
    d.view.rotation = ((deg % 360) + 360) % 360;
    this.viewChanged();
  }
  /** Keep at least part of the document visible (Photoshop allows overscroll up to the viewport centre). */
  clampPan() {
    const d = this.doc;
    if (!d) return;
    const v = d.view, w = d.width * v.zoom, h = d.height * v.zoom;
    const mx = this.width / 2, my = this.height / 2;
    v.panX = Math.min(mx, Math.max(mx - w, v.panX));
    v.panY = Math.min(my, Math.max(my - h, v.panY));
  }
  /** Scroll extents for scrollbars: {pos, size, total} in screen px per axis. */
  scrollInfo() {
    const d = this.doc;
    if (!d) return null;
    const v = d.view, w = d.width * v.zoom, h = d.height * v.zoom;
    const totalX = w + this.width, totalY = h + this.height;
    return {
      x: { pos: this.width / 2 - v.panX, size: this.width, total: totalX },
      y: { pos: this.height / 2 - v.panY, size: this.height, total: totalY },
    };
  }
  private viewChanged() {
    this.requestRender();
    if (this.doc) events.emit('view', this.doc);
  }

  // ------------------------------------------------------------------ render
  resize() {
    const r = this.el.getBoundingClientRect();
    const w = Math.max(1, Math.round(r.width)), h = Math.max(1, Math.round(r.height));
    const dpr = window.devicePixelRatio || 1;
    if (w === this.width && h === this.height && dpr === this.dpr && this.canvas.width === Math.round(w * dpr)) return;
    const oldW = this.width, oldH = this.height;
    this.width = w; this.height = h; this.dpr = dpr;
    for (const c of [this.canvas, this.overlay]) {
      c.width = Math.round(w * dpr); c.height = Math.round(h * dpr);
      c.style.width = w + 'px'; c.style.height = h + 'px';
    }
    const d = this.doc;
    if (d) {
      if (d.view.fitted) this.fit(false);
      else { d.view.panX += (w - oldW) / 2; d.view.panY += (h - oldH) / 2; }
    }
    this.requestRender();
    if (d) events.emit('view', d);
  }
  requestRender(overlayOnly = false) {
    if (!overlayOnly) this.needMain = true;
    this.needOverlay = true;
    if (!this.raf) this.raf = requestAnimationFrame(() => this.frame());
  }
  private frame() {
    this.raf = 0;
    if (this.needMain) { this.needMain = false; this.renderMain(); }
    if (this.needOverlay) { this.needOverlay = false; this.renderOverlay(); }
    if (this.doc) events.emit('render', this.doc);
  }

  private pasteboard = '#282828';
  refreshTheme() {
    this.pasteboard = getComputedStyle(document.documentElement).getPropertyValue('--pasteboard').trim() || '#282828';
    this.requestRender();
  }

  private renderMain() {
    const ctx = this.ctx, d = this.doc;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = this.pasteboard;
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    if (!d) return;
    updateComposite(d);
    const m = this.matrix(), z = d.view.zoom;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.transform(m.a, m.b, m.c, m.d, m.e, m.f);
    // soft shadow + checkerboard
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.45)';
    ctx.shadowBlur = 12 * this.dpr;
    ctx.shadowOffsetX = 3 * this.dpr; ctx.shadowOffsetY = 3 * this.dpr;
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, d.width, d.height);
    ctx.restore();
    const pat = checkerPattern(ctx, app.prefs.checkerSize || 8);
    pat.setTransform(new DOMMatrix().scale(1 / z, 1 / z).rotate(-d.view.rotation));
    ctx.fillStyle = pat;
    ctx.fillRect(0, 0, d.width, d.height);
    // image
    ctx.imageSmoothingEnabled = z < 1;
    ctx.imageSmoothingQuality = this.interacting ? 'low' : 'high';
    ctx.drawImage(d.composite, 0, 0);
    // quick mask overlay (red over unselected areas)
    if (d.quickMask) {
      const qm = this.quickMaskCanvas(d);
      ctx.drawImage(qm, 0, 0);
    }
    for (const h of viewportHooks.afterComposite) {
      ctx.save();
      ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      try { h(ctx, this, d); } catch (err) { console.error(err); }
      ctx.restore();
    }
  }

  private qmCanvas: HTMLCanvasElement | null = null;
  private quickMaskCanvas(d: PixDocument) {
    const qm = d.quickMask!;
    if (!this.qmCanvas || this.qmCanvas.width !== d.width || this.qmCanvas.height !== d.height) this.qmCanvas = createCanvas(d.width, d.height);
    const x = ctx2d(this.qmCanvas);
    x.globalCompositeOperation = 'copy';
    x.fillStyle = 'rgba(255,0,0,0.5)';
    x.fillRect(0, 0, d.width, d.height);
    x.globalCompositeOperation = 'destination-out';
    x.drawImage(qm._preview || qm.canvas, qm.x, qm.y);
    x.globalCompositeOperation = 'source-over';
    return this.qmCanvas;
  }

  private renderOverlay() {
    const ctx = this.octx, d = this.doc;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.overlay.width, this.overlay.height);
    if (!d) return;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    const z = d.view.zoom;
    // pixel grid
    if (viewOptions.extras && viewOptions.pixelGrid && z >= 6) this.drawPixelGrid(ctx, d);
    for (const h of viewportHooks.overlay) {
      ctx.save();
      try { h(ctx, this, d); } catch (err) { console.error(err); }
      ctx.restore();
      ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    }
    // marching ants
    if (viewOptions.extras && viewOptions.selectionEdges && !d.quickMask && !this.hideSelection) {
      const path = d.selection.outline();
      if (path) this.strokeAnts(ctx, path, this.selectionOffset.x, this.selectionOffset.y);
    }
    const tool = app.currentTool;
    if (tool?.drawOverlay) {
      ctx.save();
      try { tool.drawOverlay(ctx, this, d); } catch (err) { console.error(err); }
      ctx.restore();
    }
  }

  /** Stroke a doc-space path as marching ants. */
  strokeAnts(ctx: CanvasRenderingContext2D, path: Path2D, dx = 0, dy = 0) {
    ctx.save();
    this.applyDocTransform(ctx);
    if (dx || dy) ctx.translate(dx, dy);
    const px = 1 / this.zoom;
    ctx.lineWidth = px;
    ctx.strokeStyle = '#fff';
    ctx.setLineDash([]);
    ctx.stroke(path);
    ctx.strokeStyle = '#000';
    ctx.setLineDash([4 * px, 4 * px]);
    ctx.lineDashOffset = -this.antsOffset * px;
    ctx.stroke(path);
    ctx.restore();
  }

  private drawPixelGrid(ctx: CanvasRenderingContext2D, d: PixDocument) {
    const tl = this.screenToDoc(0, 0), br = this.screenToDoc(this.width, this.height);
    const tr = this.screenToDoc(this.width, 0), bl = this.screenToDoc(0, this.height);
    const x0 = Math.max(0, Math.floor(Math.min(tl.x, br.x, tr.x, bl.x))), x1 = Math.min(d.width, Math.ceil(Math.max(tl.x, br.x, tr.x, bl.x)));
    const y0 = Math.max(0, Math.floor(Math.min(tl.y, br.y, tr.y, bl.y))), y1 = Math.min(d.height, Math.ceil(Math.max(tl.y, br.y, tr.y, bl.y)));
    ctx.save();
    this.applyDocTransform(ctx);
    ctx.lineWidth = 1 / this.zoom;
    ctx.strokeStyle = 'rgba(128,128,128,0.35)';
    ctx.beginPath();
    for (let x = x0; x <= x1; x++) { ctx.moveTo(x, y0); ctx.lineTo(x, y1); }
    for (let y = y0; y <= y1; y++) { ctx.moveTo(x0, y); ctx.lineTo(x1, y); }
    ctx.stroke();
    ctx.restore();
  }

  // ------------------------------------------------------------------ input
  private toolPointer(e: PointerEvent | MouseEvent, pressure?: number): ToolPointer {
    const r = this.overlay.getBoundingClientRect();
    const sx = e.clientX - r.left, sy = e.clientY - r.top;
    const p = this.screenToDoc(sx, sy);
    const pe = e as PointerEvent;
    const isPen = pe.pointerType === 'pen';
    return {
      x: p.x, y: p.y, sx, sy,
      pressure: pressure ?? (isPen ? (pe.pressure || 0) : 1),
      tiltX: pe.tiltX || 0, tiltY: pe.tiltY || 0,
      button: e.button, buttons: e.buttons,
      shift: e.shiftKey, alt: e.altKey, ctrl: e.ctrlKey || e.metaKey,
      pointerType: pe.pointerType || 'mouse',
      time: e.timeStamp, event: e,
    };
  }

  /** Update the canvas CSS cursor from the current tool. */
  updateCursor() {
    const t = app.currentTool;
    let c = 'default';
    if (t?.cursor) c = typeof t.cursor === 'function' ? t.cursor(this.doc) : t.cursor;
    if (this.overlay.style.cursor !== c) this.overlay.style.cursor = c;
  }

  private bindInput() {
    const el = this.overlay;
    el.style.touchAction = 'none';
    el.addEventListener('pointerdown', e => {
      if (e.button === 1) { this.middlePan(e); return; }
      if (e.button !== 0 && e.button !== 2) return;
      const d = this.doc;
      const tool = app.currentTool;
      if (!tool) return;
      if (!d && !tool.worksWithoutDoc) return;
      if (e.button === 2) return; // context menu handles right click
      (document.activeElement as HTMLElement | null)?.blur?.();
      const p = this.toolPointer(e);
      // extension hooks (guides etc.)
      if (d) for (const h of viewportHooks.pointerDown) {
        const r = h(p, d, this);
        if (r) {
          el.setPointerCapture(e.pointerId);
          this.drag = { tool: null, hook: typeof r === 'object' ? r : undefined, pointerId: e.pointerId };
          return;
        }
      }
      el.setPointerCapture(e.pointerId);
      this.drag = { tool, pointerId: e.pointerId };
      this.pointer.down = true;
      this.interacting++;
      try { tool.pointerDown?.(p, d!); } catch (err) { console.error(err); }
      this.requestRender(true);
    });
    el.addEventListener('pointermove', e => {
      const p = this.toolPointer(e);
      this.pointer.x = p.x; this.pointer.y = p.y; this.pointer.sx = p.sx; this.pointer.sy = p.sy; this.pointer.inside = true;
      const d = this.doc;
      events.emit('status', ''); // lets Info panel refresh cheaply via 'render'
      if (this.drag && this.drag.pointerId === e.pointerId) {
        if (this.drag.hook) { this.drag.hook.move?.(p); return; }
        const tool = this.drag.tool;
        const list = (e as any).getCoalescedEvents?.() as PointerEvent[] | undefined;
        if (list && list.length > 1) for (const ce of list) tool?.pointerMove?.(this.toolPointer(ce), d!);
        else tool?.pointerMove?.(p, d!);
      } else {
        this.updateCursor();
        if (d) app.currentTool?.hover?.(p, d);
      }
      this.requestRender(true);
    });
    const up = (e: PointerEvent) => {
      if (!this.drag || this.drag.pointerId !== e.pointerId) return;
      const p = this.toolPointer(e);
      const drag = this.drag;
      this.drag = null;
      this.pointer.down = false;
      this.interacting = Math.max(0, this.interacting - 1);
      if (drag.hook) { drag.hook.up?.(p); this.requestRender(); return; }
      try { drag.tool?.pointerUp?.(p, this.doc!); } catch (err) { console.error(err); }
      if (app.springReleasePending) { app.springTool = null; app.springReleasePending = false; }
      this.updateCursor();
      this.requestRender();
    };
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
    el.addEventListener('pointerleave', () => { this.pointer.inside = false; this.requestRender(true); });
    el.addEventListener('pointerenter', () => { this.pointer.inside = true; this.updateCursor(); });
    el.addEventListener('dblclick', e => {
      const d = this.doc;
      if (d) app.currentTool?.dblclick?.(this.toolPointer(e), d);
    });
    el.addEventListener('contextmenu', e => {
      e.preventDefault();
      const d = this.doc;
      if (!d) return;
      const p = this.toolPointer(e);
      const t = app.currentTool as any;
      if (t?.contextMenu) t.contextMenu(p, d);
      else viewportHooks.contextMenu?.(p, d);
    });
    el.addEventListener('wheel', e => {
      e.preventDefault();
      const d = this.doc;
      if (!d) return;
      const r = el.getBoundingClientRect();
      const anchor = { sx: e.clientX - r.left, sy: e.clientY - r.top };
      let dy = e.deltaY, dx = e.deltaX;
      if (e.deltaMode === 1) { dy *= 16; dx *= 16; }
      const zoomGesture = e.ctrlKey || e.altKey || app.prefs.zoomWithScroll;
      if (zoomGesture && !(e.shiftKey && !e.ctrlKey && !e.altKey)) {
        const f = Math.exp(-dy * (e.ctrlKey && Math.abs(dy) < 50 ? 0.01 : 0.0025));
        this.setZoom(this.zoom * f, anchor);
      } else if (e.shiftKey) this.panBy(-(dy || dx), 0);
      else this.panBy(-dx, -dy);
    }, { passive: false });
  }

  private middlePan(e: PointerEvent) {
    e.preventDefault();
    const el = this.overlay;
    el.setPointerCapture(e.pointerId);
    let lx = e.clientX, ly = e.clientY;
    const move = (ev: PointerEvent) => { this.panBy(ev.clientX - lx, ev.clientY - ly); lx = ev.clientX; ly = ev.clientY; };
    const up = () => { el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up); };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
  }

  /** Mark start/end of an interactive view change (lower render quality while moving). */
  beginInteraction() { this.interacting++; }
  endInteraction() { this.interacting = Math.max(0, this.interacting - 1); this.requestRender(); }
}

/** Draw a Photoshop-style brush outline at the pointer (screen space ctx). */
export function drawBrushCursor(ctx: CanvasRenderingContext2D, view: Viewport, size: number, opts: { roundness?: number; angle?: number; crosshair?: boolean } = {}) {
  if (!view.pointer.inside) return;
  const { sx, sy } = view.pointer;
  const r = Math.max(0.5, (size * view.zoom) / 2);
  ctx.save();
  ctx.translate(sx, sy);
  if (opts.angle) ctx.rotate((opts.angle * Math.PI) / 180 + ((view.doc?.view.rotation || 0) * Math.PI) / 180);
  ctx.scale(1, opts.roundness ?? 1);
  ctx.lineWidth = 1;
  if (r < 3 || opts.crosshair) {
    ctx.strokeStyle = 'rgba(0,0,0,0.8)';
    ctx.beginPath(); ctx.moveTo(-6, 0); ctx.lineTo(6, 0); ctx.moveTo(0, -6); ctx.lineTo(0, 6); ctx.stroke();
    ctx.strokeStyle = 'rgba(255,255,255,0.9)';
    ctx.beginPath(); ctx.moveTo(-5, 0.5); ctx.lineTo(5, 0.5); ctx.moveTo(0.5, -5); ctx.lineTo(0.5, 5); ctx.stroke();
  }
  if (r >= 3) {
    ctx.strokeStyle = 'rgba(0,0,0,0.75)';
    ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI * 2); ctx.stroke();
    ctx.strokeStyle = 'rgba(255,255,255,0.85)';
    ctx.beginPath(); ctx.arc(0, 0, Math.max(0.5, r - 1), 0, Math.PI * 2); ctx.stroke();
  }
  ctx.restore();
}
