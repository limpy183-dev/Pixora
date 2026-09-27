// Shared shell for the full-window filter workspaces (Liquify, Camera Raw, Lens Correction, Filter Gallery,
// Adaptive Wide Angle): big dialog with a tool strip, a zoom/pan image view and a settings column under OK/Cancel.
import './special.css';
import { h } from '../../ui/dom';
import { icon } from '../../ui/icons';
import { openDialog, type DialogHandle } from '../../ui/dialog';
import { createCanvas, ctx2d } from '../../core/canvas';
import { app } from '../../core/app';
import type { PixDocument } from '../../core/document';
import { editableTarget } from '../../core/pixelops';
import { toast } from '../../ui/toast';
import { SmartObjectLayer } from '../../layers/smart-object';
import { smartTarget } from '../engine';

export interface WsTool { id: string; icon: string; title: string; key?: string }
export interface PointerInfo { x: number; y: number; sx: number; sy: number; e: PointerEvent }

/** Zoomable, pannable view of an image (image units = pixels of `image`). */
export class ImageView {
  el: HTMLElement; canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D;
  image: CanvasImageSource | null = null; iw = 1; ih = 1;
  zoom = 1; ox = 0; oy = 0;               // screen = image * zoom + o
  overlay: ((ctx: CanvasRenderingContext2D, v: ImageView) => void) | null = null;
  onDown: ((p: PointerInfo) => void) | null = null;
  onMove: ((p: PointerInfo, down: boolean) => void) | null = null;
  onUp: ((p: PointerInfo) => void) | null = null;
  cursor = 'default';
  panMode = false;
  private raf = 0;
  zoomLabel = h('span.ws-zoom-label', null, '100%');
  constructor(w: number, hh: number) {
    this.canvas = createCanvas(w, hh);
    this.canvas.className = 'ws-canvas';
    this.ctx = ctx2d(this.canvas);
    this.el = h('div.ws-view', null, this.canvas);
    let down = false, panning = false, px = 0, py = 0, ox0 = 0, oy0 = 0;
    const info = (e: PointerEvent): PointerInfo => { const r = this.canvas.getBoundingClientRect(), sx = ((e.clientX - r.left) / r.width) * this.canvas.width, sy = ((e.clientY - r.top) / r.height) * this.canvas.height; return { sx, sy, x: (sx - this.ox) / this.zoom, y: (sy - this.oy) / this.zoom, e }; };
    this.canvas.addEventListener('pointerdown', e => {
      this.canvas.setPointerCapture(e.pointerId);
      down = true;
      if (this.panMode || e.button === 1 || spaceDown) { panning = true; px = e.clientX; py = e.clientY; ox0 = this.ox; oy0 = this.oy; this.canvas.style.cursor = 'grabbing'; return; }
      this.onDown?.(info(e));
    });
    this.canvas.addEventListener('pointermove', e => {
      if (panning) { const r = this.canvas.getBoundingClientRect(), k = this.canvas.width / r.width; this.ox = ox0 + (e.clientX - px) * k; this.oy = oy0 + (e.clientY - py) * k; this.draw(); return; }
      this.onMove?.(info(e), down);
    });
    const up = (e: PointerEvent) => { if (!down) return; down = false; if (panning) { panning = false; this.canvas.style.cursor = this.cursor; return; } this.onUp?.(info(e)); };
    this.canvas.addEventListener('pointerup', up);
    this.canvas.addEventListener('pointercancel', up);
    this.canvas.addEventListener('wheel', e => {
      e.preventDefault();
      const r = this.canvas.getBoundingClientRect(), sx = ((e.clientX - r.left) / r.width) * this.canvas.width, sy = ((e.clientY - r.top) / r.height) * this.canvas.height;
      if (e.ctrlKey || e.altKey || !e.shiftKey) this.zoomAt(this.zoom * (e.deltaY < 0 ? 1.15 : 1 / 1.15), sx, sy);
      else { this.ox -= e.deltaY; this.draw(); }
    }, { passive: false });
  }
  setImage(img: CanvasImageSource, w: number, hh: number, refit = false) { const first = !this.image; this.image = img; this.iw = w; this.ih = hh; if (first || refit) this.fit(); else this.draw(); }
  fit() { this.zoom = Math.min(this.canvas.width / this.iw, this.canvas.height / this.ih) * 0.96; this.ox = (this.canvas.width - this.iw * this.zoom) / 2; this.oy = (this.canvas.height - this.ih * this.zoom) / 2; this.draw(); }
  zoomAt(z: number, sx = this.canvas.width / 2, sy = this.canvas.height / 2) {
    z = Math.max(0.02, Math.min(32, z));
    const ix = (sx - this.ox) / this.zoom, iy = (sy - this.oy) / this.zoom;
    this.zoom = z; this.ox = sx - ix * z; this.oy = sy - iy * z; this.draw();
  }
  toScreen(x: number, y: number) { return { x: x * this.zoom + this.ox, y: y * this.zoom + this.oy }; }
  draw() { if (!this.raf) this.raf = requestAnimationFrame(() => { this.raf = 0; this.paint(); }); }
  paint() {
    const c = this.ctx, W = this.canvas.width, H = this.canvas.height;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.fillStyle = getComputedStyle(this.el).getPropertyValue('--ws-bg').trim() || '#282828';
    c.fillRect(0, 0, W, H);
    if (this.image) {
      c.save();
      c.imageSmoothingEnabled = this.zoom < 2; c.imageSmoothingQuality = 'high';
      c.setTransform(this.zoom, 0, 0, this.zoom, this.ox, this.oy);
      c.fillStyle = checker(c);
      c.fillRect(0, 0, this.iw, this.ih);
      c.drawImage(this.image, 0, 0, this.iw, this.ih);
      c.restore();
    }
    this.overlay?.(c, this);
    this.zoomLabel.textContent = `${Math.round(this.zoom * 100)}%`;
  }
}
let checkerPat: CanvasPattern | null = null;
function checker(c: CanvasRenderingContext2D) {
  if (checkerPat) return checkerPat;
  const t = createCanvas(16, 16), x = ctx2d(t);
  x.fillStyle = '#fff'; x.fillRect(0, 0, 16, 16); x.fillStyle = '#ccc'; x.fillRect(0, 0, 8, 8); x.fillRect(8, 8, 8, 8);
  checkerPat = c.createPattern(t, 'repeat')!;
  return checkerPat;
}
let spaceDown = false;
window.addEventListener('keydown', e => { if (e.code === 'Space') spaceDown = true; }, true);
window.addEventListener('keyup', e => { if (e.code === 'Space') spaceDown = false; }, true);

export interface Workspace { dlg: DialogHandle; view: ImageView; tool: string; setTool(id: string): void; side: HTMLElement; result: Promise<boolean>; status: HTMLElement }
export function openWorkspace(o: { title: string; tools?: WsTool[]; side: HTMLElement; onTool?: (id: string, ws: Workspace) => void; onKey?: (e: KeyboardEvent) => boolean | void; className?: string; extraButtons?: { label: string; onClick: () => void; title?: string }[] }): Workspace {
  const W = Math.min(1500, window.innerWidth - 40), H = Math.min(860, window.innerHeight - 90);
  const viewW = Math.max(400, W - 340 - (o.tools ? 44 : 0)), viewH = Math.max(300, H - 90);
  const view = new ImageView(viewW, viewH);
  const status = h('span.ws-status');
  const ws: Workspace = { dlg: null as any, view, tool: o.tools?.[0]?.id || '', setTool: () => {}, side: o.side, result: null as any, status };
  const toolBtns = (o.tools || []).map(t => {
    const b = h('button.icon-btn.ws-tool', { type: 'button', title: `${t.title}${t.key ? ` (${t.key})` : ''}` }, icon(t.icon, 20));
    b.addEventListener('click', () => ws.setTool(t.id));
    return b;
  });
  ws.setTool = id => {
    ws.tool = id;
    toolBtns.forEach((b, i) => b.classList.toggle('active', o.tools![i].id === id));
    view.panMode = id === 'hand';
    o.onTool?.(id, ws);
  };
  const bar = h('div.ws-viewbar', null,
    h('button.icon-btn', { type: 'button', title: 'Zoom out (Ctrl+-)', onclick: () => view.zoomAt(view.zoom / 1.5) }, icon('minus', 14)), view.zoomLabel,
    h('button.icon-btn', { type: 'button', title: 'Zoom in (Ctrl++)', onclick: () => view.zoomAt(view.zoom * 1.5) }, icon('plus', 14)),
    h('button.btn.ws-fit', { type: 'button', title: 'Fit in view (Ctrl+0)', onclick: () => view.fit() }, 'Fit'),
    h('button.btn.ws-fit', { type: 'button', title: 'Actual pixels (Ctrl+1)', onclick: () => view.zoomAt(1) }, '100%'),
    status);
  const body = h('div.ws-body', null, o.tools ? h('div.ws-tools', null, ...toolBtns) : null, h('div.ws-center', null, view.el, bar));
  const sideWrap = h('div.ws-side', null, o.side);
  const dlg = openDialog({
    title: o.title, body, layout: 'side', width: W, className: 'ws-dialog ' + (o.className || ''), escClose: true,
    buttons: [{ label: 'OK', primary: true, value: true }, { label: 'Cancel', value: false }, ...(o.extraButtons || []).map(b => ({ label: b.label, onClick: () => { b.onClick(); return false; } }))],
    cancelValue: false, sideExtras: [sideWrap],
  });
  ws.dlg = dlg;
  const onKey = (e: KeyboardEvent) => {
    if ((e.target as HTMLElement)?.matches?.('input, textarea')) return;
    if (o.onKey?.(e)) { e.preventDefault(); return; }
    const ctrl = e.ctrlKey || e.metaKey;
    if (ctrl && (e.key === '+' || e.key === '=')) { view.zoomAt(view.zoom * 1.5); e.preventDefault(); return; }
    if (ctrl && e.key === '-') { view.zoomAt(view.zoom / 1.5); e.preventDefault(); return; }
    if (ctrl && e.key === '0') { view.fit(); e.preventDefault(); return; }
    if (ctrl && e.key === '1') { view.zoomAt(1); e.preventDefault(); return; }
    if (ctrl || e.altKey) return;
    const t = o.tools?.find(x => x.key && x.key.toLowerCase() === e.key.toLowerCase());
    if (t) { ws.setTool(t.id); e.preventDefault(); }
  };
  window.addEventListener('keydown', onKey, true);
  ws.result = dlg.result.then(v => { window.removeEventListener('keydown', onKey, true); return !!v; });
  if (o.tools?.length) ws.setTool(o.tools[0].id);
  return ws;
}

// ------------------------------------------------------------------ sources
export interface Source { doc: PixDocument; kind: 'pixels' | 'smart'; so: SmartObjectLayer | null; full: HTMLCanvasElement; preview: HTMLCanvasElement; scale: number }
/** Resolve the filter target and make a preview-size copy (max `maxDim` px). Shows Photoshop's messages. */
export function grabSource(maxDim = 1400): Source | null {
  const doc = app.activeDoc;
  if (!doc) return null;
  const so = smartTarget(doc);
  let full: HTMLCanvasElement;
  if (so) full = so.source;
  else {
    const t = editableTarget(doc);
    if (!t) return null;
    if (t.isMask) { toast('This filter works on pixel layers only.', 'error'); return null; }
    full = t.holder.canvas;
  }
  const scale = Math.min(1, maxDim / Math.max(full.width, full.height));
  const preview = createCanvas(Math.max(1, Math.round(full.width * scale)), Math.max(1, Math.round(full.height * scale)));
  const x = preview.getContext('2d', { willReadFrequently: true })!;
  x.imageSmoothingQuality = 'high';
  x.drawImage(full, 0, 0, preview.width, preview.height);
  return { doc, kind: so ? 'smart' : 'pixels', so, full, preview, scale };
}
export const readPixels = (c: HTMLCanvasElement) => c.getContext('2d', { willReadFrequently: true })!.getImageData(0, 0, c.width, c.height);

/** Small labelled slider (Camera Raw / Liquify side panels). */
export function wsSlider(label: string, value: number, min: number, max: number, onInput: (v: number) => void, o: { step?: number; center?: number; unit?: string; track?: string; onChange?: (v: number) => void } = {}) {
  const step = o.step ?? 1, dec = step < 1 ? (step < 0.1 ? 2 : 1) : 0;
  const fmt = (v: number) => (o.center !== undefined && v > o.center ? '+' : '') + v.toFixed(dec) + (o.unit || '');
  const num = h('input.field.ws-num', { type: 'text', value: fmt(value) }) as HTMLInputElement;
  const rng = h('input.ws-range', { type: 'range', min, max, step, value }) as HTMLInputElement;
  if (o.track) rng.style.setProperty('--ws-track', o.track);
  const set = (v: number, fire = true) => { v = Math.max(min, Math.min(max, v)); rng.value = String(v); num.value = fmt(v); if (fire) onInput(v); };
  rng.addEventListener('input', () => set(parseFloat(rng.value)));
  rng.addEventListener('change', () => o.onChange?.(parseFloat(rng.value)));
  rng.addEventListener('dblclick', () => { set(o.center ?? min); o.onChange?.(o.center ?? min); });
  num.addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Enter') num.blur(); });
  num.addEventListener('change', () => { const v = parseFloat(num.value.replace('+', '')); if (Number.isFinite(v)) { set(v); o.onChange?.(v); } else num.value = fmt(parseFloat(rng.value)); });
  const el = h('div.ws-slider', { title: `${label.replace(/:$/, '')} — double-click the slider to reset` }, h('div.ws-slider-top', null, h('span.ws-slider-label', null, label), num), rng) as HTMLElement & { setValue(v: number): void };
  el.setValue = v => set(v, false);
  return el;
}
export function wsSection(title: string, ...children: (HTMLElement | null)[]) {
  const head = h('div.ws-sec-head', null, icon('chevron-down', 12), h('span', null, title));
  const body = h('div.ws-sec-body', null, ...children);
  const el = h('div.ws-sec', null, head, body);
  head.addEventListener('click', () => el.classList.toggle('collapsed'));
  return el;
}
