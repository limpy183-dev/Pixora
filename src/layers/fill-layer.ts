// Fill layers (kind 'fill'): Solid Color / Gradient / Pattern — non-destructive, document-sized content.
// Also provides the Gradient Fill / Pattern Fill dialogs and the Properties panel section 'fill'.
import { app } from '../core/app';
import type { PixDocument } from '../core/document';
import { Layer, registerLayerClass, type LayerContent } from '../core/layer';
import type { Gradient, GradientShape, Pattern, RGB } from '../core/types';
import { createCanvas, ctx2d, alphaBounds } from '../core/canvas';
import { renderGradient } from '../core/gradient';
import { resolveGradient, FG_TO_BG, FG_TO_TRANSPARENT } from '../core/presets';
import { hooks, registerPropertiesSection, resources } from '../core/registry';
import { toCss } from '../core/color';
import { h, dragPointer } from '../ui/dom';
import { checkbox, colorSwatch, gradientPicker, numberField, patternPicker, select, button, slider, type Field } from '../ui/widgets';
import { openDialog } from '../ui/dialog';
import { liveEditor } from '../features/layers/shared';
import './fill-layer.css';

export type FillType = 'solid' | 'gradient' | 'pattern';
export interface FillSettings {
  type: FillType;
  color: RGB;
  gradient: Gradient;
  style: GradientShape;
  angle: number;        // gradient angle (degrees, 90 = bottom → top)
  scale: number;        // gradient scale %
  reverse: boolean;
  dither: boolean;
  align: boolean;       // Align with layer (use the mask bounds)
  offsetX: number;      // gradient centre / pattern origin offset (doc px)
  offsetY: number;
  pattern: string;      // pattern id (resources.patterns)
  patternScale: number; // %
  patternAngle: number; // degrees
  link: boolean;        // pattern: Link with Layer
}

export const FILL_NAMES: Record<FillType, string> = { solid: 'Color Fill', gradient: 'Gradient Fill', pattern: 'Pattern Fill' };

/** Gradients whose colours depend on the current fg/bg are baked when stored in a layer. */
export function bakeGradient(g: Gradient): Gradient {
  if (g.name === FG_TO_BG || g.name === FG_TO_TRANSPARENT) { const r = resolveGradient(g); return { ...r, name: 'Custom', stops: r.stops.map(s => ({ ...s, color: { ...s.color } })), opacityStops: r.opacityStops.map(s => ({ ...s })) }; }
  return JSON.parse(JSON.stringify(g));
}

export function defaultFill(type: FillType): FillSettings {
  return {
    type, color: { ...app.fg },
    gradient: bakeGradient(resources.gradients[0] || { name: FG_TO_BG, stops: [{ pos: 0, color: app.fg }, { pos: 1, color: app.bg }], opacityStops: [{ pos: 0, opacity: 1 }, { pos: 1, opacity: 1 }] }),
    style: 'linear', angle: 90, scale: 100, reverse: false, dither: true, align: true, offsetX: 0, offsetY: 0,
    pattern: resources.patterns[0]?.id || '', patternScale: 100, patternAngle: 0, link: true,
  };
}

const ids = new WeakMap<HTMLCanvasElement, number>();
let idCounter = 0;
const canvasId = (c: HTMLCanvasElement) => { let i = ids.get(c); if (!i) ids.set(c, (i = ++idCounter)); return i; };
const maskBoundsCache = new WeakMap<HTMLCanvasElement, ReturnType<typeof alphaBounds>>();

export class FillLayer extends Layer {
  kind = 'fill' as const;
  fill: FillSettings;
  _cache: { key: string; canvas: HTMLCanvasElement } | null = null;

  constructor(fill?: FillSettings, name?: string) {
    super();
    this.fill = fill || defaultFill('solid');
    this.name = name || FILL_NAMES[this.fill.type];
  }

  /** Reference rectangle for gradient geometry: the mask's bounds when aligned with the layer, else the document. */
  private refRect(doc: PixDocument) {
    const full = { x: 0, y: 0, w: doc.width, h: doc.height };
    const m = this.mask;
    if (!this.fill.align || !m || m.bg === 255) return full;
    let b = maskBoundsCache.get(m.canvas);
    if (b === undefined) { b = alphaBounds(m.canvas, 0); maskBoundsCache.set(m.canvas, b); }
    return b ? { x: b.x + m.x, y: b.y + m.y, w: b.w, h: b.h } : full;
  }

  getContent(doc: PixDocument): LayerContent {
    const f = this.fill;
    const m = f.type === 'gradient' && f.align ? this.mask : null;
    const key = `${this._version}|${doc.width}x${doc.height}|${m ? `${canvasId(m.canvas)},${m.x},${m.y}` : ''}`;
    if (this._cache && this._cache.key === key) return { canvas: this._cache.canvas, x: 0, y: 0 };
    const c = this._cache && this._cache.canvas.width === doc.width && this._cache.canvas.height === doc.height ? this._cache.canvas : createCanvas(doc.width, doc.height);
    const x = ctx2d(c);
    x.setTransform(1, 0, 0, 1, 0, 0);
    x.clearRect(0, 0, c.width, c.height);
    if (f.type === 'solid') {
      x.fillStyle = toCss(f.color); x.fillRect(0, 0, c.width, c.height);
    } else if (f.type === 'gradient') {
      const R = this.refRect(doc), th = (f.angle * Math.PI) / 180, ux = Math.cos(th), uy = -Math.sin(th);
      const cx = R.x + R.w / 2 + f.offsetX, cy = R.y + R.h / 2 + f.offsetY;
      const half = Math.max(1, ((Math.abs(R.w * ux) + Math.abs(R.h * uy)) / 2) * (f.scale / 100));
      const centred = f.style !== 'linear';
      const p0 = centred ? { x: cx, y: cy } : { x: cx - ux * half, y: cy - uy * half };
      const p1 = { x: cx + ux * half, y: cy + uy * half };
      x.putImageData(renderGradient(c.width, c.height, f.gradient, f.style, p0, p1, { reverse: f.reverse, dither: f.dither }), 0, 0);
    } else {
      const pat = resources.patterns.find(p => p.id === f.pattern) || resources.patterns[0];
      if (pat) {
        const p = x.createPattern(pat.canvas, 'repeat')!;
        const s = Math.max(0.01, f.patternScale / 100);
        p.setTransform(new DOMMatrix().translate(f.offsetX, f.offsetY).rotate(-f.patternAngle).scale(s, s));
        x.fillStyle = p; x.fillRect(0, 0, c.width, c.height);
      }
    }
    this._cache = { key, canvas: c };
    return { canvas: c, x: 0, y: 0 };
  }

  /** Moving a fill layer moves its mask and (when linked/aligned) the gradient / pattern origin. */
  translate(dx: number, dy: number) {
    if (this.mask && this.mask.linked) { this.mask.x += dx; this.mask.y += dy; }
    if (this.fill.type === 'pattern' ? this.fill.link : this.fill.type === 'gradient') { this.fill.offsetX += dx; this.fill.offsetY += dy; }
    this.invalidate();
  }
  applyMatrix(m: DOMMatrix) {
    if (this.fill.type === 'gradient') {
      const a = (Math.atan2(-m.b, m.a) * 180) / Math.PI;
      this.fill.angle = Math.round(((this.fill.angle + a) % 360 + 540) % 360 - 180);
      this.fill.scale = Math.round(this.fill.scale * Math.hypot(m.a, m.b));
    } else if (this.fill.type === 'pattern') {
      this.fill.patternScale = Math.round(this.fill.patternScale * Math.hypot(m.a, m.b));
    }
    this.translate(m.e, m.f);
  }
}
registerLayerClass('fill', FillLayer as any);

// ------------------------------------------------------------------ widgets
/** Photoshop angle dial (circle + radius line). */
export function angleDial(value: number, onInput: (v: number) => void, onChange?: (v: number) => void): Field<number> {
  let cur = value;
  const line = h('div.fl-dial-line');
  const el = h('div.fl-dial', { title: 'Drag to set the angle' }, line) as unknown as Field<number>;
  const paint = () => { line.style.transform = `rotate(${-cur}deg)`; };
  const fromEvent = (e: PointerEvent) => {
    const r = el.getBoundingClientRect();
    let a = Math.round((Math.atan2(-(e.clientY - r.top - r.height / 2), e.clientX - r.left - r.width / 2) * 180) / Math.PI);
    if (e.shiftKey) a = Math.round(a / 15) * 15;
    return a;
  };
  el.addEventListener('pointerdown', e => {
    e.preventDefault();
    cur = fromEvent(e); paint(); onInput(cur);
    dragPointer(e, (_dx, _dy, ev) => { cur = fromEvent(ev); paint(); onInput(cur); }, () => onChange?.(cur));
  });
  el.setValue = v => { cur = v; paint(); };
  el.getValue = () => cur;
  paint();
  return el;
}

const STYLES: { value: GradientShape; label: string }[] = [
  { value: 'linear', label: 'Linear' }, { value: 'radial', label: 'Radial' }, { value: 'angle', label: 'Angle' },
  { value: 'reflected', label: 'Reflected' }, { value: 'diamond', label: 'Diamond' },
];

/** Controls for a fill (used by the dialogs and the Properties panel). onEdit(fn, final) mutates the settings. */
function fillControls(f: FillSettings, onEdit: (fn: () => void, final: boolean) => void, compact = false): HTMLElement {
  const set = (k: keyof FillSettings, final = true) => (v: any) => onEdit(() => { (f as any)[k] = v; }, final);
  if (f.type === 'solid') {
    return h('div.fl-form', null, h('div.form-row', null, h('label.fl-label', null, 'Color:'),
      colorSwatch(f.color, c => onEdit(() => { f.color = c; }, true), { title: 'Color Picker (Solid Color)', size: 40 })));
  }
  if (f.type === 'gradient') {
    const angleNum = numberField(f.angle, v => { dial.setValue(v); set('angle')(v); }, { min: -180, max: 180, unit: '°', width: 52 });
    const dial = angleDial(f.angle, v => { angleNum.setValue(v); set('angle', false)(v); }, v => set('angle')(v));
    const scaleNum = numberField(f.scale, v => { scaleSl.setValue(v); set('scale')(v); }, { min: 10, max: 1000, unit: '%', width: 56 });
    const scaleSl = slider(f.scale, 10, 150, v => { scaleNum.setValue(v); set('scale', false)(v); }, { onChange: v => set('scale')(v), width: compact ? 110 : 150 });
    return h('div.fl-form', null,
      h('div.form-row', null, h('label.fl-label', null, 'Gradient:'), gradientPicker(f.gradient, g => set('gradient')(bakeGradient(g)), { width: compact ? 150 : 200 })),
      h('div.form-row', null, h('label.fl-label', null, 'Style:'), select(STYLES, f.style, set('style'), { width: 110 }),
        compact ? null : checkbox('Align with layer', f.align, set('align'))),
      compact ? h('div.form-row', null, h('label.fl-label'), checkbox('Align with layer', f.align, set('align'))) : null,
      h('div.form-row', null, h('label.fl-label', null, 'Angle:'), dial, angleNum),
      h('div.form-row', null, h('label.fl-label', null, 'Scale:'), scaleNum, scaleSl),
      h('div.form-row', null, h('label.fl-label'), checkbox('Reverse', f.reverse, set('reverse')), checkbox('Dither', f.dither, set('dither'))),
      h('div.form-row', null, h('label.fl-label'), button('Reset Alignment', () => onEdit(() => { f.offsetX = 0; f.offsetY = 0; }, true), { title: 'Move the gradient back to the centre of the layer' })),
    );
  }
  const pats = resources.patterns;
  const angleNum = numberField(f.patternAngle, v => { dial.setValue(v); set('patternAngle')(v); }, { min: -180, max: 180, unit: '°', width: 52 });
  const dial = angleDial(f.patternAngle, v => { angleNum.setValue(v); set('patternAngle', false)(v); }, v => set('patternAngle')(v));
  const scaleNum = numberField(f.patternScale, v => { scaleSl.setValue(v); set('patternScale')(v); }, { min: 1, max: 1000, unit: '%', width: 56 });
  const scaleSl = slider(f.patternScale, 1, 400, v => { scaleNum.setValue(v); set('patternScale', false)(v); }, { onChange: v => set('patternScale')(v), width: compact ? 110 : 150 });
  return h('div.fl-form', null,
    h('div.form-row', null, h('label.fl-label', null, 'Pattern:'), patternPicker(pats.find(p => p.id === f.pattern) || null, (p: Pattern) => set('pattern')(p.id))),
    h('div.form-row', null, h('label.fl-label', null, 'Angle:'), dial, angleNum),
    h('div.form-row', null, h('label.fl-label', null, 'Scale:'), scaleNum, scaleSl),
    h('div.form-row', null, h('label.fl-label'), checkbox('Link with Layer', f.link, set('link'))),
    h('div.form-row', null, h('label.fl-label'), button('Snap to Origin', () => onEdit(() => { f.offsetX = 0; f.offsetY = 0; }, true), { title: 'Align the pattern with the document origin' })),
  );
}

/** Redraw after a fill change (throttled to one frame). */
const pending = new Set<PixDocument>();
export function fillChanged(doc: PixDocument, layer: FillLayer) {
  layer.invalidate();
  if (pending.has(doc)) return;
  pending.add(doc);
  requestAnimationFrame(() => { pending.delete(doc); doc.pixelsChanged(layer, null); });
}

/**
 * Edit a fill layer's settings in the Photoshop dialog (Color Picker / Gradient Fill / Pattern Fill) with live preview.
 * The caller wraps it in a history transaction. Resolves false on Cancel (settings restored).
 */
export async function editFillDialog(doc: PixDocument, layer: FillLayer): Promise<boolean> {
  const f = layer.fill, backup = JSON.parse(JSON.stringify(f));
  if (f.type === 'solid') {
    const c = await hooks.openColorPicker(f.color, 'Color Picker (Solid Color)');
    if (!c) return false;
    f.color = c; fillChanged(doc, layer);
    return true;
  }
  const body = fillControls(f, fn => { fn(); fillChanged(doc, layer); });
  const ok = await openDialog({
    title: f.type === 'gradient' ? 'Gradient Fill' : 'Pattern Fill', body, layout: 'side', className: 'fl-dialog',
    buttons: [{ label: 'OK', primary: true, value: true }, { label: 'Cancel', value: false }],
  }).result;
  if (!ok) { layer.fill = backup; fillChanged(doc, layer); return false; }
  return true;
}

// ------------------------------------------------------------------ Properties panel section
registerPropertiesSection({
  id: 'fill', title: 'Fill', order: 20,
  match: (_doc, layer) => layer instanceof FillLayer,
  build(container, doc, layer) {
    const l = layer as FillLayer;
    const edit = liveEditor(doc, 'Modify Fill Layer');
    const kinds: { value: FillType; label: string }[] = [{ value: 'solid', label: 'Solid Color' }, { value: 'gradient', label: 'Gradient' }, { value: 'pattern', label: 'Pattern' }];
    const holder = h('div');
    const render = () => holder.replaceChildren(fillControls(l.fill, (fn, final) => edit(() => { fn(); fillChanged(doc, l); }, final), true));
    const head = h('div.fl-prop-head', null, h('span.fl-label', null, 'Fill:'), select(kinds, l.fill.type, t => {
      edit(() => { const d = defaultFill(t); l.fill = { ...d, color: l.fill.color }; fillChanged(doc, l); }, true);
      render();
    }, { width: 130 }));
    container.append(h('div.fl-props', null, head, holder));
    render();
  },
});
