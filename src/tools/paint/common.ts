// Shared infrastructure for the painting tools (Brush, Pencil, Mixer Brush, Color Replacement, Erasers, History
// brushes): settings model, options-bar controls, target checks (locks / rasterize prompt), stroke smoothing
// (pulled string / catch-up), Shift-click lines, paint symmetry, brush outline cursor and the stroke driver.
import './paint.css';
import { app, type Tool, type ToolPointer } from '../../core/app';
import type { PixDocument, PaintTarget } from '../../core/document';
import { PaintStroke, getTip, type BrushMode, type InputPoint, type StrokeOptions } from '../../core/brush';
import { events } from '../../core/events';
import { runCommand } from '../../core/commands';
import { createCanvas, ctx2d } from '../../core/canvas';
import { BLEND_MODE_LABELS, BLEND_MODE_MENU, type RGB } from '../../core/types';
import type { Layer } from '../../core/layer';
import { drawBrushCursor, type Viewport } from '../../core/viewport';
import { h } from '../../ui/dom';
import { icon } from '../../ui/icons';
import { checkbox, iconButton, numberField, popupSlider, select, separator, showPop, type SelectOption } from '../../ui/widgets';
import { openMenu, type MenuEntry } from '../../ui/menu';
import { brushPicker, openBrushPopup } from '../../ui/brush-picker';
import { confirmDialog, openDialog } from '../../ui/dialog';
import { toast } from '../../ui/toast';
import { svgCursor } from '../../ui/cursors';
import { dabPipeline, defaultDynamics, normDynamics, tipById, type DabX, type Dynamics, type PipelineOpts } from '../../features/brushes/dynamics';

// ------------------------------------------------------------------ settings
export interface SmoothOpts { pulled: boolean; catchUp: boolean; catchUpEnd: boolean; adjustZoom: boolean }
export interface PaintSettings {
  size: number; hardness: number; tipId?: string; spacing: number; roundness: number; angle: number; flipX: boolean; flipY: boolean;
  opacity: number; flow: number;            // 0..1
  mode: BrushMode;
  smoothing: number;                        // 0..1
  airbrush: boolean; pressureSize: boolean; pressureOpacity: boolean;
  smooth: SmoothOpts;
  dyn: Dynamics;
  [k: string]: any;
}
export function paintDefaults(over: Partial<PaintSettings> = {}): PaintSettings {
  return {
    size: 45, hardness: 0, tipId: 'soft-round', spacing: 0.25, roundness: 1, angle: 0, flipX: false, flipY: false,
    opacity: 1, flow: 1, mode: 'normal', smoothing: 0.1, airbrush: false, pressureSize: false, pressureOpacity: false,
    smooth: { pulled: false, catchUp: true, catchUpEnd: true, adjustZoom: true },
    dyn: defaultDynamics(),
    ...over,
  };
}
/** Fix up settings loaded from storage (older versions / partial objects). */
export function normSettings(s: PaintSettings) {
  s.dyn = normDynamics(s.dyn);
  s.smooth = Object.assign({ pulled: false, catchUp: true, catchUpEnd: true, adjustZoom: true }, s.smooth || {});
  if (s.opacity > 1) s.opacity /= 100;
  if (s.flow > 1) s.flow /= 100;
}

export const MODE_OPTIONS: (SelectOption<BrushMode> | '-')[] = (() => {
  const out: (SelectOption<BrushMode> | '-')[] = [];
  for (const m of BLEND_MODE_MENU) {
    if (m === '-') { out.push('-'); continue; }
    out.push({ value: m, label: BLEND_MODE_LABELS[m] });
    if (m === 'dissolve') out.push({ value: 'behind', label: 'Behind' }, { value: 'clear', label: 'Clear' });
  }
  return out;
})();

// ------------------------------------------------------------------ target checks
const RASTER_MSG: Record<string, string> = {
  text: 'This type layer must be rasterized before proceeding. Its text will no longer be editable. Rasterize the type?',
  shape: 'This shape layer must be rasterized before proceeding. Its vector mask will no longer be editable. Rasterize the shape?',
  smart: 'This smart object must be rasterized before proceeding. Its contents will no longer be editable. Rasterize the smart object?',
  fill: 'This fill layer must be rasterized before proceeding. Its content will no longer be editable. Rasterize the layer?',
  frame: 'This frame layer must be rasterized before proceeding. Rasterize the layer?',
};
const visibleDeep = (l: Layer) => { for (let p: Layer | null = l; p; p = p._parent) if (!p.visible) return false; return true; };

/** Resolve the paint target with Photoshop's messages (and the rasterize prompt for vector-ish layers). */
export function paintTarget(doc: PixDocument, toolName: string): PaintTarget | null {
  const t = doc.getPaintTarget();
  const l = doc.activeLayer;
  if (!t) {
    if (!l) toast(`Could not use the ${toolName} because no layer is selected.`, 'error');
    else if (RASTER_MSG[l.kind]) {
      confirmDialog('Pixora', RASTER_MSG[l.kind], [{ label: 'OK', primary: true, value: 'ok' }, { label: 'Cancel', value: 'cancel' }])
        .then(r => { if (r === 'ok') runCommand('layer.rasterize', 'layer'); });
    } else if (l.kind === 'group') toast(`Could not use the ${toolName} because the target layer is a group.`, 'error');
    else toast(`Could not use the ${toolName} because the layer is an adjustment layer. Select a pixel layer or its mask.`, 'error', 3600);
    return null;
  }
  if (t.kind === 'pixels') {
    if (t.layer!.pixelsLocked) { toast(`Could not use the ${toolName} because the layer is locked.`, 'error'); return null; }
    if (!visibleDeep(t.layer!)) { toast(`Could not use the ${toolName} because the target layer is hidden.`, 'error'); return null; }
  }
  return t;
}

// ------------------------------------------------------------------ symmetry
export type SymType = 'off' | 'vertical' | 'horizontal' | 'dual' | 'diagonal' | 'wavy' | 'circle' | 'spiral' | 'parallel' | 'radial' | 'mandala';
export const symmetry: { type: SymType; segments: number } = (() => {
  try { return { type: 'off' as SymType, segments: 6, ...JSON.parse(localStorage.getItem('pixora.symmetry') || '{}') }; } catch { return { type: 'off' as SymType, segments: 6 }; }
})();
const symCenter = new WeakMap<PixDocument, { x: number; y: number }>();
export const centerOf = (doc: PixDocument) => symCenter.get(doc) || { x: doc.width / 2, y: doc.height / 2 };
function saveSym() { try { localStorage.setItem('pixora.symmetry', JSON.stringify(symmetry)); } catch { /* ignore */ } app.activeDoc?.redrawOverlay(); }

function mirrorDab(d: DabX, phiDeg: number, px: number, py: number): DabX {
  const phi = (phiDeg * Math.PI) / 180, c = Math.cos(2 * phi), s = Math.sin(2 * phi);
  const x = d.x - px, y = d.y - py;
  return { ...d, x: px + x * c + y * s, y: py + x * s - y * c, angle: 2 * phiDeg - d.angle, flipY: !d.flipY };
}
function rotateDab(d: DabX, deg: number, cx: number, cy: number, scale = 1): DabX {
  const a = (deg * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a), x = d.x - cx, y = d.y - cy;
  return { ...d, x: cx + (x * c - y * s) * scale, y: cy + (x * s + y * c) * scale, angle: d.angle + deg, size: d.size * scale };
}
/** Symmetry expansion for a document (null when off). */
export function symmetryExpand(doc: PixDocument): ((d: DabX) => DabX[]) | undefined {
  const t = symmetry.type;
  if (t === 'off') return undefined;
  const { x: cx, y: cy } = centerOf(doc), n = Math.max(2, Math.min(12, symmetry.segments | 0));
  const W = doc.width, H = doc.height;
  switch (t) {
    case 'vertical': return d => [d, mirrorDab(d, 90, cx, cy)];
    case 'horizontal': return d => [d, mirrorDab(d, 0, cx, cy)];
    case 'dual': return d => [d, mirrorDab(d, 90, cx, cy), mirrorDab(d, 0, cx, cy), rotateDab(d, 180, cx, cy)];
    case 'diagonal': return d => [d, mirrorDab(d, 45, cx, cy), mirrorDab(d, -45, cx, cy), rotateDab(d, 180, cx, cy)];
    case 'parallel': { const g = W * 0.15; return d => [d, mirrorDab(d, 90, cx - g, cy), mirrorDab(d, 90, cx + g, cy)]; }
    case 'wavy': {
      const A = Math.min(W, H) * 0.04, L = H / 4;
      return d => { const ax = cx + A * Math.sin(((d.y - cy) / L) * Math.PI * 2); return [d, mirrorDab(d, 90, ax, d.y)]; };
    }
    case 'circle': {
      const R = Math.min(W, H) * 0.3;
      return d => {
        const dx = d.x - cx, dy = d.y - cy, r = Math.hypot(dx, dy);
        if (r < 1e-3 || 2 * R - r <= 0) return [d];
        const k = (2 * R - r) / r, th = (Math.atan2(dy, dx) * 180) / Math.PI;
        return [d, { ...mirrorDab(d, th + 90, d.x, d.y), x: cx + dx * k, y: cy + dy * k }];
      };
    }
    case 'spiral': return d => Array.from({ length: n }, (_, k) => (k ? rotateDab(d, (k * 360) / n, cx, cy, Math.pow(0.82, k)) : d));
    case 'radial': return d => Array.from({ length: n }, (_, k) => (k ? rotateDab(d, (k * 360) / n, cx, cy) : d));
    case 'mandala': return d => {
      const m = mirrorDab(d, 90, cx, cy), out: DabX[] = [];
      for (let k = 0; k < n; k++) { out.push(k ? rotateDab(d, (k * 360) / n, cx, cy) : d, rotateDab(m, (k * 360) / n, cx, cy)); }
      return out;
    };
  }
  return undefined;
}
/** Axis lines (doc coords) for the overlay. */
function symmetryAxes(doc: PixDocument): [number, number, number, number][] | 'circle' | 'wavy' {
  const { x: cx, y: cy } = centerOf(doc), L = Math.hypot(doc.width, doc.height);
  const line = (deg: number, px = cx, py = cy): [number, number, number, number] => { const a = (deg * Math.PI) / 180; return [px - Math.cos(a) * L, py - Math.sin(a) * L, px + Math.cos(a) * L, py + Math.sin(a) * L]; };
  const n = Math.max(2, Math.min(12, symmetry.segments | 0));
  switch (symmetry.type) {
    case 'vertical': return [line(90)];
    case 'horizontal': return [line(0)];
    case 'dual': return [line(0), line(90)];
    case 'diagonal': return [line(45), line(-45)];
    case 'parallel': return [line(90, cx - doc.width * 0.15), line(90, cx + doc.width * 0.15)];
    case 'radial': case 'spiral': return Array.from({ length: n }, (_, k) => { const a = (k * 360) / n - 90, r = (a * Math.PI) / 180; return [cx, cy, cx + Math.cos(r) * L, cy + Math.sin(r) * L] as [number, number, number, number]; });
    case 'mandala': return Array.from({ length: n * 2 }, (_, k) => { const a = (k * 180) / n - 90, r = (a * Math.PI) / 180; return [cx, cy, cx + Math.cos(r) * L, cy + Math.sin(r) * L] as [number, number, number, number]; });
    case 'circle': return 'circle';
    case 'wavy': return 'wavy';
  }
  return [];
}
function drawSymmetry(ctx: CanvasRenderingContext2D, view: Viewport, doc: PixDocument) {
  if (symmetry.type === 'off') return;
  const axes = symmetryAxes(doc), c = centerOf(doc);
  ctx.save();
  view.applyDocTransform(ctx);
  const px = 1 / view.zoom;
  ctx.beginPath();
  if (axes === 'circle') { const R = Math.min(doc.width, doc.height) * 0.3; ctx.arc(c.x, c.y, R, 0, Math.PI * 2); }
  else if (axes === 'wavy') {
    const A = Math.min(doc.width, doc.height) * 0.04, L = doc.height / 4;
    for (let y = 0; y <= doc.height; y += 4) { const x = c.x + A * Math.sin(((y - c.y) / L) * Math.PI * 2); y ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }
  } else for (const [x0, y0, x1, y1] of axes) { ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); }
  ctx.lineWidth = 3 * px; ctx.strokeStyle = 'rgba(0,0,0,.35)'; ctx.stroke();
  ctx.lineWidth = 1.2 * px; ctx.strokeStyle = '#3aa0ff'; ctx.setLineDash([6 * px, 4 * px]); ctx.stroke();
  ctx.setLineDash([]);
  ctx.beginPath(); ctx.arc(c.x, c.y, 5 * px, 0, Math.PI * 2);
  ctx.fillStyle = '#fff'; ctx.fill(); ctx.lineWidth = 1.5 * px; ctx.strokeStyle = '#3aa0ff'; ctx.stroke();
  ctx.restore();
}

async function segmentsDialog(title: string): Promise<boolean> {
  let v = symmetry.segments;
  const f = numberField(v, x => { v = x; }, { min: 2, max: 12, width: 60 });
  const body = h('div.form', null, h('div.form-row', null, h('label.form-label', null, 'Segment Count (2-12):'), f));
  const r = await openDialog({ title, body, buttons: [{ label: 'OK', primary: true, value: 'ok' }, { label: 'Cancel', value: null }] }).result;
  if (r !== 'ok') return false;
  symmetry.segments = Math.max(2, Math.min(12, Math.round(f.getValue())));
  return true;
}
function symmetryMenu(anchor: HTMLElement, refresh: () => void) {
  const set = (t: SymType) => async () => {
    if ((t === 'radial' || t === 'mandala' || t === 'spiral') && !(await segmentsDialog(t === 'radial' ? 'Radial Symmetry' : t === 'mandala' ? 'Mandala Symmetry' : 'Spiral Symmetry'))) return;
    symmetry.type = t; saveSym(); refresh();
  };
  const it = (t: SymType, label: string): MenuEntry => ({ label, radio: true, checked: symmetry.type === t, action: set(t) });
  openMenu([
    it('off', 'Symmetry Off'), '-',
    it('vertical', 'Vertical'), it('horizontal', 'Horizontal'), it('dual', 'Dual Axis'), it('diagonal', 'Diagonal'), it('wavy', 'Wavy'),
    it('circle', 'Circle'), it('spiral', 'Spiral...'), it('parallel', 'Parallel Lines'), it('radial', 'Radial...'), it('mandala', 'Mandala...'), '-',
    { label: 'Reset Symmetry Center', enabled: !!app.activeDoc, action: () => { if (app.activeDoc) { symCenter.delete(app.activeDoc); saveSym(); } } },
  ], anchor, { minWidth: 190 });
}

// ------------------------------------------------------------------ smoothing
class Smoother {
  private pos: InputPoint | null = null;
  private target: InputPoint | null = null;
  private raf = 0;
  constructor(private radius: number, private k: number, private o: SmoothOpts, private emit: (p: InputPoint) => void) {}
  start(p: InputPoint) { this.pos = { ...p }; this.target = p; this.emit(p); }
  push(p: InputPoint) {
    this.target = p;
    this.step();
    if (this.o.catchUp && !this.o.pulled && this.radius > 0 && !this.raf) this.loop();
  }
  private step(catchUp = false) {
    const a = this.pos, t = this.target;
    if (!a || !t) return;
    const dx = t.x - a.x, dy = t.y - a.y, d = Math.hypot(dx, dy);
    if (this.radius <= 0.01) { this.pos = { ...t }; this.emit(t); return; }
    let f: number;
    if (this.o.pulled) { if (d <= this.radius) return; f = (d - this.radius) / d; }
    else f = catchUp ? 0.22 : d > this.radius * 4 ? (d - this.radius * 4) / d + this.k : this.k;
    f = Math.min(1, f);
    if (d < 0.05) return;
    this.pos = { x: a.x + dx * f, y: a.y + dy * f, pressure: a.pressure + (t.pressure - a.pressure) * f, tiltX: t.tiltX, tiltY: t.tiltY };
    this.emit(this.pos);
  }
  private loop() {
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      const a = this.pos, t = this.target;
      if (!a || !t || Math.hypot(t.x - a.x, t.y - a.y) < 0.5) return;
      this.step(true);
      this.loop();
    });
  }
  /** End of stroke: optionally catch up to the final point. */
  finish(): InputPoint | null {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    if (this.o.catchUpEnd && this.target && this.pos && (this.target.x !== this.pos.x || this.target.y !== this.pos.y)) { this.pos = { ...this.target }; this.emit(this.target); }
    return this.pos;
  }
  get brush() { return this.pos; }
  get pointer() { return this.target; }
  cancel() { if (this.raf) cancelAnimationFrame(this.raf); this.raf = 0; }
}

// ------------------------------------------------------------------ brush outline cursor
const outlineCache = new Map<string, HTMLCanvasElement>();
/** White/black outline image of a sampled tip at screen size (centered). */
function tipOutline(tipC: HTMLCanvasElement, w: number, hh: number): HTMLCanvasElement {
  const key = `${(tipC as any).__oid || ((tipC as any).__oid = Math.random())}:${w}x${hh}`;
  let c = outlineCache.get(key);
  if (c) return c;
  const W = Math.max(3, Math.round(w)) + 4, H = Math.max(3, Math.round(hh)) + 4;
  const t = createCanvas(W, H), tx = ctx2d(t);
  tx.drawImage(tipC, 2, 2, W - 4, H - 4);
  const src = tx.getImageData(0, 0, W, H).data;
  let max = 0;
  for (let i = 3; i < src.length; i += 4) if (src[i] > max) max = src[i];
  const th = Math.max(8, max * 0.35);
  const inside = (x: number, y: number) => x >= 0 && y >= 0 && x < W && y < H && src[(y * W + x) * 4 + 3] >= th;
  c = createCanvas(W, H);
  const cx = ctx2d(c), out = cx.createImageData(W, H), o = out.data;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (!inside(x, y)) continue;
    if (inside(x - 1, y) && inside(x + 1, y) && inside(x, y - 1) && inside(x, y + 1)) continue;
    const i = (y * W + x) * 4, dark = (x + y) & 1;
    o[i] = o[i + 1] = o[i + 2] = dark ? 20 : 245; o[i + 3] = 230;
  }
  cx.putImageData(out, 0, 0);
  outlineCache.set(key, c);
  if (outlineCache.size > 24) outlineCache.delete(outlineCache.keys().next().value!);
  return c;
}
let capsLock = false;
export const preciseCursor = () => capsLock || app.prefs.paintingCursor === 'precise';
const STANDARD_CURSOR = svgCursor('<path d="M14.5 4.5 19.5 9.5 11 18l-4.5-.5-.5-4.5z" fill="#fff"/><path d="M6.2 17.8 3.5 20.5"/>', 4, 20, 'crosshair');
export function paintCursor(): string {
  if (app.prefs.paintingCursor === 'standard' && !capsLock) return STANDARD_CURSOR;
  return preciseCursor() ? 'crosshair' : 'none';
}
/** Draw the brush outline (round or sampled) at the pointer. */
export function drawOutline(ctx: CanvasRenderingContext2D, view: Viewport, s: { size: number; hardness?: number; roundness?: number; angle?: number; tipId?: string; flipX?: boolean; flipY?: boolean }, overrideTip?: HTMLCanvasElement | null) {
  if (!view.pointer.inside || app.prefs.paintingCursor === 'standard' || preciseCursor()) {
    if (view.pointer.inside && preciseCursor()) drawBrushCursor(ctx, view, 0, { crosshair: true });
    return;
  }
  const tipC = overrideTip !== undefined ? overrideTip : tipById(s.tipId);
  let size = s.size;
  if (!tipC && app.prefs.paintingCursor === 'normal-tip' && (s.hardness ?? 1) < 1) {
    const hd = s.hardness ?? 1;
    size = s.size * (hd + (1 - hd) * 0.55);
  }
  const scr = size * view.zoom;
  if (!tipC || scr < 6) { drawBrushCursor(ctx, view, size, { roundness: s.roundness, angle: s.angle }); return; }
  const ratio = tipC.height / tipC.width;
  const w = Math.min(1600, scr), hh = w * ratio;
  const o = tipOutline(tipC, w, hh);
  ctx.save();
  ctx.translate(view.pointer.sx, view.pointer.sy);
  const rot = ((s.angle || 0) + (view.doc?.view.rotation || 0)) * Math.PI / 180;
  if (rot) ctx.rotate(rot);
  ctx.scale(s.flipX ? -1 : 1, (s.flipY ? -1 : 1) * (s.roundness ?? 1));
  ctx.drawImage(o, -o.width / 2, -o.height / 2);
  ctx.restore();
}

// ------------------------------------------------------------------ options-bar controls
export type Sync = () => void;
export interface OptCtx { tool: Tool; s: PaintSettings; syncs: Sync[]; save(): void }
export function optCtx(tool: Tool): OptCtx {
  const s = tool.settings as PaintSettings;
  return { tool, s, syncs: [], save: () => app.saveToolSettings(tool) };
}
/** Wire external setting changes ([ ], digits, panels) back into the controls. */
export function finishOptions(c: OptCtx): () => void {
  let busy = false;
  const off = events.on('toolOptions', () => { if (busy) return; busy = true; try { c.syncs.forEach(f => f()); } finally { busy = false; } });
  return off;
}
export function optBrush(c: OptCtx, opts: { settingsButton?: boolean } = {}): HTMLElement[] {
  const pick = brushPicker(c.s, () => { c.save(); app.activeDoc?.redrawOverlay(); });
  c.syncs.push(() => (pick as any).refresh?.());
  const out: HTMLElement[] = [pick];
  if (opts.settingsButton !== false) out.push(iconButton('brush-settings', 'Toggle the Brush Settings panel (F5)', () => runCommand('window.togglePanel', 'brush-settings')));
  return out;
}
export function optMode(c: OptCtx, options: (SelectOption<any> | '-')[] = MODE_OPTIONS, key = 'mode', label = 'Mode:', width = 110): HTMLElement[] {
  const f = select<any>(options, c.s[key], v => { c.s[key] = v; c.save(); }, { width, title: 'Set the blending mode' });
  c.syncs.push(() => f.setValue(c.s[key]));
  return [h('span.opt-label', null, label), f];
}
export function optPercent(c: OptCtx, key: string, label: string, title: string): HTMLElement {
  const f = popupSlider(label, Math.round(c.s[key] * 100), v => { c.s[key] = v / 100; c.save(); }, { title });
  c.syncs.push(() => f.setValue(Math.round(c.s[key] * 100)));
  return f;
}
export function optToggle(c: OptCtx, key: string, iconName: string, title: string): HTMLElement {
  const b = iconButton(iconName, title, () => { c.s[key] = !c.s[key]; b.classList.toggle('active', !!c.s[key]); c.save(); }, { active: !!c.s[key] });
  c.syncs.push(() => b.classList.toggle('active', !!c.s[key]));
  return b;
}
export function optSmoothing(c: OptCtx): HTMLElement[] {
  const f = popupSlider('Smoothing', Math.round(c.s.smoothing * 100), v => { c.s.smoothing = v / 100; c.save(); }, { title: 'Set the smoothing for strokes' });
  c.syncs.push(() => f.setValue(Math.round(c.s.smoothing * 100)));
  const gear = iconButton('gear', 'Set additional smoothing options', e => {
    const so = c.s.smooth;
    const set = (k: keyof SmoothOpts) => (v: boolean) => { so[k] = v; c.save(); };
    showPop(h('div.opt-pop', null,
      checkbox('Pulled String Mode', so.pulled, set('pulled'), { title: 'Paint only when the string is pulled taut' }),
      checkbox('Stroke Catch-up', so.catchUp, set('catchUp'), { title: 'The paint continues to catch up with the cursor when you pause' }),
      checkbox('Catch-up on Stroke End', so.catchUpEnd, set('catchUpEnd'), { title: 'Complete the stroke to the pointer position when you release' }),
      checkbox('Adjust for Zoom', so.adjustZoom, set('adjustZoom'), { title: 'Scale smoothing with the zoom level' }),
    ), e.currentTarget as HTMLElement);
  });
  return [f, gear];
}
export function optAngle(c: OptCtx): HTMLElement {
  const f = numberField(c.s.angle, v => { c.s.angle = v; c.save(); app.activeDoc?.redrawOverlay(); }, { min: -180, max: 180, unit: '°', width: 44, title: 'Set the brush angle' });
  c.syncs.push(() => f.setValue(c.s.angle));
  return h('span.pt-angle', { title: 'Brush angle' }, icon('angle', 18), f);
}
export function optSymmetry(): HTMLElement {
  const b = iconButton('symmetry', 'Set paint symmetry options', () => symmetryMenu(b, sync), { caret: true });
  const sync = () => b.classList.toggle('active', symmetry.type !== 'off');
  sync();
  return b;
}
/** Standard PS brush-like options row. */
export function standardOptions(bar: HTMLElement, tool: Tool, o: { mode?: boolean; flow?: boolean; smoothing?: boolean; extra?: (c: OptCtx) => HTMLElement[]; beforePressure?: (c: OptCtx) => HTMLElement[] } = {}): () => void {
  const c = optCtx(tool);
  const els: HTMLElement[] = [...optBrush(c), separator()];
  if (o.mode !== false) els.push(...optMode(c), separator());
  els.push(optPercent(c, 'opacity', 'Opacity', 'Set the opacity for strokes'), optToggle(c, 'pressureOpacity', 'pressure-opacity', 'Always use Pressure for Opacity. When off, Brush Settings override pressure.'), separator());
  if (o.flow !== false) els.push(optPercent(c, 'flow', 'Flow', 'Set the flow rate for strokes'), optToggle(c, 'airbrush', 'airbrush', 'Enable airbrush-style build-up effects'), separator());
  if (o.smoothing !== false) els.push(...optSmoothing(c), separator());
  els.push(optAngle(c));
  if (o.extra) els.push(separator(), ...o.extra(c));
  els.push(separator(), optToggle(c, 'pressureSize', 'pressure-size', 'Always use Pressure for Size. When off, Brush Settings override pressure.'), optSymmetry());
  bar.append(...els);
  return finishOptions(c);
}

// ------------------------------------------------------------------ stroke driver
export interface StrokeSetup extends Partial<StrokeOptions> {
  /** Custom paint content inside each dab (history brush, mixer, color replacement…). */
  content?: PipelineOpts['content'];
  /** Called after the stroke was committed. */
  after?: () => void;
  /** Disable dynamics (Block eraser). */
  noDynamics?: boolean;
}
export interface PaintToolDef {
  id: string; name: string; group: string; icon: string; shortcut: string; order: number;
  settings: PaintSettings;
  historyName: string;
  altEyedropper?: boolean;
  options?(bar: HTMLElement, tool: Tool): void | (() => void);
  /** Build stroke options for this tool; return null to abort. */
  setup(doc: PixDocument, target: PaintTarget, p: ToolPointer, s: PaintSettings): StrokeSetup | null | Promise<StrokeSetup | null>;
  /** Override the size used (Block eraser). */
  sizeOf?(s: PaintSettings): number;
  /** Tip override for the cursor. */
  cursorTip?(s: PaintSettings): HTMLCanvasElement | null | undefined;
  /** Pointer down hook before painting: return true to swallow (e.g. mixer Alt-click load). */
  preDown?(p: ToolPointer, doc: PixDocument): boolean;
  keyDown?(e: KeyboardEvent, doc: PixDocument | null): boolean | void;
  keyUp?(e: KeyboardEvent, doc: PixDocument | null): boolean | void;
  cursor?(): string | null;
}

interface Active {
  stroke: PaintStroke; smoother: Smoother; doc: PixDocument; setup: StrokeSetup;
  start: { x: number; y: number }; axis: 'x' | 'y' | null; shiftDrag: boolean; last: InputPoint;
}
const lastPoints = new WeakMap<PixDocument, { tool: string; x: number; y: number }>();
let tilt = { x: 0, y: 0 };

export function createPaintTool(def: PaintToolDef): Tool {
  normSettings(def.settings);
  let act: Active | null = null;
  let symDrag: { doc: PixDocument } | null = null;
  let pending = false;
  const s = def.settings;
  const sizeOf = () => (def.sizeOf ? def.sizeOf(s) : s.size);

  const toInput = (p: ToolPointer): InputPoint => ({ x: p.x, y: p.y, pressure: p.pointerType === 'pen' ? Math.max(0.01, p.pressure) : 1, tiltX: p.tiltX, tiltY: p.tiltY });

  const tool: Tool = {
    id: def.id, name: def.name, group: def.group, icon: def.icon, shortcut: def.shortcut, order: def.order,
    settings: s, paints: true, altEyedropper: def.altEyedropper,
    cursor: () => def.cursor?.() || paintCursor(),
    options(bar) {
      const r = def.options ? def.options(bar, tool) : standardOptions(bar, tool);
      return r || undefined;
    },
    activate() { normSettings(s); },
    deactivate() { if (act) { act.smoother.cancel(); act.stroke.end(); act = null; } },
    async pointerDown(p, doc) {
      capsLock = !!(p.event as any).getModifierState?.('CapsLock');
      tilt = { x: p.tiltX, y: p.tiltY };
      if (act || pending) return;
      // drag the symmetry centre
      if (symmetry.type !== 'off') {
        const c = centerOf(doc), view = app.viewport!, sc = view.docToScreen(c.x, c.y);
        if (Math.hypot(sc.x - p.sx, sc.y - p.sy) < 9) { symDrag = { doc }; return; }
      }
      if (def.preDown?.(p, doc)) return;
      const target = paintTarget(doc, def.name);
      if (!target) return;
      let setup: StrokeSetup | null;
      const r = def.setup(doc, target, p, s);
      if (r instanceof Promise) {
        pending = true;
        try { setup = await r; } finally { pending = false; }
        if (!app.viewport?.pointer.down) return;   // released while a dialog / async preparation was open
      } else setup = r;
      if (!setup) return;
      const last = lastPoints.get(doc);
      const fromLast = p.shift && last && last.tool === def.id;
      const first: InputPoint = fromLast ? { x: last!.x, y: last!.y, pressure: 1 } : toInput(p);
      const pipe = setup.noDynamics ? { transformDab: undefined, renderDab: undefined } : dabPipeline({
        shape: { size: sizeOf(), hardness: s.hardness, spacing: s.spacing, roundness: s.roundness, angle: s.angle, flipX: s.flipX, flipY: s.flipY, tipId: s.tipId, aliased: setup.aliased },
        dyn: s.dyn, fg: setup.color || app.fg, bg: app.bg, expand: symmetryExpand(doc), content: setup.content, getTilt: () => tilt,
      });
      const { content: _c, after: _a, noDynamics: _n, ...rest } = setup;
      const opts: StrokeOptions = {
        size: sizeOf(), hardness: s.hardness, spacing: s.spacing, roundness: s.roundness, angle: s.angle, tip: tipById(s.tipId),
        opacity: s.opacity * (s.dyn.wetEdges ? 0.6 : 1), flow: s.flow, color: app.fg, mode: 'paint', blendMode: s.mode,
        pressureSize: s.pressureSize, pressureOpacity: s.pressureOpacity, smoothing: 0, airbrush: s.airbrush || s.dyn.buildup,
        transformDab: pipe.transformDab, renderDab: pipe.renderDab,
        historyName: def.historyName, historyIcon: def.icon,
        ...rest,
      };
      const stroke = PaintStroke.start(doc, opts, first);
      if (!stroke) { toast(`Could not use the ${def.name}.`, 'error'); return; }
      const view = app.viewport!;
      const baseR = s.smoothing * 60 * (s.dyn.smoothing ? 1 : 0.6);
      const radius = s.smooth.adjustZoom ? baseR / view.zoom : baseR;
      const k = Math.max(0.06, 1 - s.smoothing * 0.94);
      const smoother = new Smoother(s.smoothing > 0 ? radius : 0, k, s.smooth, q => { act && (act.last = q); stroke.move(q); });
      act = { stroke, smoother, doc, setup, start: { x: first.x, y: first.y }, axis: null, shiftDrag: !!p.shift && !fromLast, last: first };
      smoother.start(first);
      if (fromLast) smoother.push(toInput(p));
    },
    pointerMove(p, doc) {
      tilt = { x: p.tiltX, y: p.tiltY };
      if (symDrag) { symCenter.set(symDrag.doc, { x: Math.round(p.x), y: Math.round(p.y) }); doc.redrawOverlay(); return; }
      if (!act) return;
      let q = toInput(p);
      if (act.shiftDrag && p.shift) {
        const dx = q.x - act.start.x, dy = q.y - act.start.y;
        if (!act.axis && Math.hypot(dx, dy) > 4 / (app.viewport?.zoom || 1)) act.axis = Math.abs(dx) >= Math.abs(dy) ? 'x' : 'y';
        if (act.axis === 'x') q = { ...q, y: act.start.y }; else if (act.axis === 'y') q = { ...q, x: act.start.x };
      }
      act.smoother.push(q);
    },
    pointerUp(_p, doc) {
      if (symDrag) { symDrag = null; saveSym(); return; }
      const a = act;
      act = null;
      if (!a) return;
      const end = a.smoother.finish() || a.last;
      a.stroke.end();
      lastPoints.set(doc, { tool: def.id, x: end.x, y: end.y });
      a.setup.after?.();
    },
    hover(p) { capsLock = !!(p.event as any).getModifierState?.('CapsLock'); },
    keyDown: def.keyDown ? (e, d) => def.keyDown!(e, d) : undefined,
    keyUp: def.keyUp ? (e, d) => def.keyUp!(e, d) : undefined,
    contextMenu(p) {
      const e = p.event as MouseEvent;
      openBrushPopup(s, { x: e.clientX, y: e.clientY }, () => { app.saveToolSettings(tool); app.activeDoc?.redrawOverlay(); });
    },
    drawOverlay(ctx, view, doc) {
      drawSymmetry(ctx, view, doc);
      const ct = def.cursorTip?.(s);
      drawOutline(ctx, view, { ...s, size: sizeOf() }, ct);
      // pulled-string indicator
      if (act && s.smoothing > 0 && act.smoother.brush && act.smoother.pointer) {
        const b = view.docToScreen(act.smoother.brush.x, act.smoother.brush.y), t = view.docToScreen(act.smoother.pointer.x, act.smoother.pointer.y);
        if (Math.hypot(b.x - t.x, b.y - t.y) > 2) {
          ctx.save(); ctx.strokeStyle = '#ff5ad2'; ctx.lineWidth = 1;
          ctx.beginPath(); ctx.moveTo(b.x, b.y); ctx.lineTo(t.x, t.y); ctx.stroke();
          ctx.restore();
        }
      }
    },
  };
  app.registerTool(tool);
  normSettings(s);
  return tool;
}

/** Colour of a single pixel of the paint target (null outside / transparent). */
export function targetPixel(t: PaintTarget, x: number, y: number): { r: number; g: number; b: number; a: number } | null {
  const lx = Math.floor(x - t.holder.x), ly = Math.floor(y - t.holder.y), c = t.holder.canvas;
  if (lx < 0 || ly < 0 || lx >= c.width || ly >= c.height) return null;
  const d = ctx2d(c).getImageData(lx, ly, 1, 1).data;
  return { r: d[0], g: d[1], b: d[2], a: d[3] };
}
export const sameRGB = (a: RGB, b: RGB, tol = 0) => Math.abs(a.r - b.r) <= tol && Math.abs(a.g - b.g) <= tol && Math.abs(a.b - b.b) <= tol;
export { getTip };

/** Reusable scratch canvas (grown, cleared). */
export function scratchCanvas(prev: HTMLCanvasElement | null, w: number, hh: number): HTMLCanvasElement {
  const c = prev && prev.width >= w && prev.height >= hh ? prev : createCanvas(Math.max(w, prev?.width || 0), Math.max(hh, prev?.height || 0));
  const x = ctx2d(c);
  x.setTransform(1, 0, 0, 1, 0, 0); x.globalAlpha = 1; x.globalCompositeOperation = 'source-over';
  x.clearRect(0, 0, c.width, c.height);
  return c;
}

/** Keep only the 4-connected region of non-zero weights containing `seed` (scanline flood). Returns a new array. */
export function floodKeep(wts: Uint8Array, w: number, hh: number, seed: number): Uint8Array {
  const out = new Uint8Array(wts.length);
  if (seed < 0 || seed >= wts.length || !wts[seed]) return out;
  let st = new Int32Array(Math.max(256, w * 2)), sp = 0;
  const push = (i: number) => { if (sp >= st.length) { const n = new Int32Array(st.length * 2); n.set(st); st = n; } st[sp++] = i; };
  push(seed);
  while (sp) {
    const i = st[--sp];
    if (out[i] || !wts[i]) continue;
    const y = (i / w) | 0, row = y * w;
    let l = i, r = i;
    while (l > row && wts[l - 1] && !out[l - 1]) l--;
    while (r < row + w - 1 && wts[r + 1] && !out[r + 1]) r++;
    for (let k = l; k <= r; k++) out[k] = wts[k];
    for (const dy of [-w, w]) {
      if ((dy < 0 && y === 0) || (dy > 0 && y === hh - 1)) continue;
      let run = false;
      for (let k = l; k <= r; k++) { const n = k + dy, ok = wts[n] && !out[n]; if (ok && !run) { push(n); run = true; } else if (!ok) run = false; }
    }
  }
  return out;
}

/** Convert the Background layer into a normal layer ("Layer 0") so it can hold transparency. */
export function unlockBackground(doc: PixDocument, layer: Layer, name: string) {
  doc.history.transaction(name, () => { layer.isBackground = false; layer.name = 'Layer 0'; layer.locks = { ...layer.locks, transparency: false, position: false }; });
  doc.layersChanged();
}

let readC: HTMLCanvasElement | null = null, readX: CanvasRenderingContext2D | null = null;
/** Read pixels of `src` (x,y in src coords) through a CPU-backed canvas (avoids GPU readback stalls/warnings). */
export function readRegion(src: CanvasImageSource, x: number, y: number, w: number, hh: number): ImageData {
  if (!readC || readC.width < w || readC.height < hh) {
    readC = document.createElement('canvas');
    readC.width = Math.max(w, readC?.width || 0, 64); readC.height = Math.max(hh, 64);
    readX = readC.getContext('2d', { willReadFrequently: true })!;
  }
  const x2 = readX!;
  x2.globalCompositeOperation = 'copy';
  x2.clearRect(0, 0, w, hh);
  x2.drawImage(src as any, x, y, w, hh, 0, 0, w, hh);
  x2.globalCompositeOperation = 'source-over';
  return x2.getImageData(0, 0, w, hh);
}
