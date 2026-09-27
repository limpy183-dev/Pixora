// Shared helpers for the retouching tools: options-bar builders, paint-target checks, sampling,
// selection/tip alpha access and the small colour-math used by several tools.
import { app, type Tool } from '../../core/app';
import type { PixDocument, PaintTarget } from '../../core/document';
import { GroupLayer, type Layer } from '../../core/layer';
import { events } from '../../core/events';
import { runCommand } from '../../core/commands';
import { resources } from '../../core/registry';
import { getTip } from '../../core/brush';
import { createCanvas, ctx2d, cloneCanvas } from '../../core/canvas';
import { renderLayersToCanvas } from '../../core/compositor';
import { drawBrushCursor, type Viewport } from '../../core/viewport';
import { toast } from '../../ui/toast';
import { h } from '../../ui/dom';
import { brushPicker, tipFor } from '../../ui/brush-picker';
import { checkbox, select, popupSlider, numberField, iconButton, toggleButton, patternPicker, type SelectOption } from '../../ui/widgets';
import { icon } from '../../ui/icons';
import { svgCursor } from '../../ui/cursors';
import type { Pattern, Rect } from '../../core/types';
import { readRegion } from '../paint/common';
import './retouch.css';

export type SampleMode = 'current' | 'below' | 'all';

export interface BrushLike {
  size: number; hardness: number; tipId?: string; roundness?: number; angle?: number; spacing?: number;
  pressureSize?: boolean;
}

// ------------------------------------------------------------------ modifier keys
export const mods = { alt: false };
for (const t of ['keydown', 'keyup'] as const) window.addEventListener(t, e => { mods.alt = e.altKey; }, true);
window.addEventListener('blur', () => { mods.alt = false; });

export const CURSOR_TARGET = svgCursor('<circle cx="12" cy="12" r="6.5"/><path d="M12 2.5v5M12 16.5v5M2.5 12h5M16.5 12h5"/><path d="M12 12h.01"/>', 12, 12, 'crosshair');

// ------------------------------------------------------------------ messages / targets
export const fail = (msg: string) => toast(msg, 'error', 3600);

/** Resolve the paint target or show the Photoshop-style error. `what` e.g. 'clone stamp'. */
export function retouchTarget(doc: PixDocument, what: string): PaintTarget | null {
  const layer = doc.activeLayer;
  if (!layer && !doc.quickMask) { fail(`Could not use the ${what} because no layer is selected.`); return null; }
  const t = doc.getPaintTarget();
  if (!t) {
    fail(layer instanceof GroupLayer
      ? `Could not use the ${what} because the target layer is a group.`
      : `Could not use the ${what} because the content of the layer is not directly editable. Rasterize the layer first.`);
    return null;
  }
  if (t.kind === 'pixels' && t.layer!.pixelsLocked) { fail(`Could not use the ${what} because the layer is locked.`); return null; }
  if (t.kind !== 'quickmask' && t.layer && !isVisible(t.layer)) { fail(`Could not use the ${what} because the target layer is hidden.`); return null; }
  return t;
}
const isVisible = (l: Layer): boolean => l.visible && (!l._parent || isVisible(l._parent));

// ------------------------------------------------------------------ sampling
export interface Img { canvas: HTMLCanvasElement; x: number; y: number }

/** Grey opaque image of a mask (value in RGB). */
export function maskAsGrey(c: HTMLCanvasElement): HTMLCanvasElement {
  const o = createCanvas(c.width, c.height), x = ctx2d(o);
  x.fillStyle = '#fff'; x.fillRect(0, 0, o.width, o.height);
  x.globalCompositeOperation = 'destination-in'; x.drawImage(c, 0, 0);
  x.globalCompositeOperation = 'destination-over'; x.fillStyle = '#000'; x.fillRect(0, 0, o.width, o.height);
  return o;
}

/** Root-level layers up to (and including) the top-level ancestor of the active layer. */
function belowList(doc: PixDocument): Layer[] {
  let top = doc.activeLayer;
  while (top?._parent) top = top._parent;
  const i = top ? doc.layers.indexOf(top) : doc.layers.length - 1;
  return doc.layers.slice(0, i + 1);
}

/**
 * Snapshot of the image a tool samples from (doc-aligned). 'current' = the paint target itself
 * (masks as grey), 'below' = current and below, 'all' = the visible composite.
 */
export function sampleImage(doc: PixDocument, mode: SampleMode, target: PaintTarget | null = doc.getPaintTarget()): Img {
  if (target?.isMask || (mode === 'current' && target)) {
    const h0 = target!.holder;
    return { canvas: target!.isMask ? maskAsGrey(h0.canvas) : cloneCanvas(h0.canvas), x: h0.x, y: h0.y };
  }
  if (mode === 'below') return { canvas: renderLayersToCanvas(doc, belowList(doc)), x: 0, y: 0 };
  return { canvas: cloneCanvas(doc.getComposite()), x: 0, y: 0 };
}

/** Read a doc-space rect of an Img as RGBA (outside the image = transparent). */
export function readImg(img: Img, r: Rect): ImageData {
  const c = createCanvas(r.w, r.h), x = ctx2d(c);
  x.drawImage(img.canvas, img.x - r.x, img.y - r.y);
  return x.getImageData(0, 0, r.w, r.h);
}

// ------------------------------------------------------------------ selection & tips
const selCache = new WeakMap<HTMLCanvasElement, Uint8Array>();
/** Doc-size selection alpha (null = everything selected). Cached per mask canvas. */
export function selectionAlpha(doc: PixDocument): Uint8Array | null {
  if (doc.quickMask || doc.selection.empty || !doc.selection.mask) return null;
  const m = doc.selection.mask;
  let a = selCache.get(m);
  if (!a) {
    const d = readRegion(m, 0, 0, m.width, m.height).data;
    a = new Uint8Array(m.width * m.height);
    for (let i = 0, j = 3; i < a.length; i++, j += 4) a[i] = d[j];
    selCache.set(m, a);
  }
  return a;
}

const shapedCache = new Map<string, HTMLCanvasElement>();
/** Tip canvas including roundness/angle (square canvas, alpha = coverage). */
export function tipCanvas(s: BrushLike, size = s.size): HTMLCanvasElement {
  const base = getTip({ size, hardness: s.hardness, tip: tipFor(s) });
  const round = s.roundness ?? 1, ang = s.angle || 0;
  if (round >= 0.999 && !ang) return base;
  const key = `${(base as any).__sid || ((base as any).__sid = Math.random())}:${round.toFixed(2)}:${Math.round(ang)}`;
  let c = shapedCache.get(key);
  if (c) return c;
  const d = Math.max(base.width, base.height);
  c = createCanvas(d, d);
  const x = ctx2d(c);
  x.translate(d / 2, d / 2); x.rotate((ang * Math.PI) / 180); x.scale(1, Math.max(0.01, round));
  x.drawImage(base, -base.width / 2, -base.height / 2);
  shapedCache.set(key, c);
  if (shapedCache.size > 48) shapedCache.delete(shapedCache.keys().next().value!);
  return c;
}
const alphaCache = new WeakMap<HTMLCanvasElement, Uint8ClampedArray>();
export function tipAlpha(tip: HTMLCanvasElement): Uint8ClampedArray {
  let a = alphaCache.get(tip);
  if (!a) {
    const d = ctx2d(tip).getImageData(0, 0, tip.width, tip.height).data;
    a = new Uint8ClampedArray(tip.width * tip.height);
    for (let i = 0, j = 3; i < a.length; i++, j += 4) a[i] = d[j];
    alphaCache.set(tip, a);
  }
  return a;
}

export function drawCursor(ctx: CanvasRenderingContext2D, view: Viewport, s: BrushLike) {
  drawBrushCursor(ctx, view, s.size, { roundness: s.roundness, angle: s.angle, crosshair: app.prefs.paintingCursor === 'precise' });
}

export const patternById = (id: string): Pattern | null => resources.patterns.find(p => p.id === id) || resources.patterns[0] || null;

// ------------------------------------------------------------------ colour math
export const lum = (r: number, g: number, b: number) => 0.3 * r + 0.59 * g + 0.11 * b;
function clipColor(c: number[]) {
  const l = lum(c[0], c[1], c[2]), n = Math.min(c[0], c[1], c[2]), x = Math.max(c[0], c[1], c[2]);
  if (n < 0) for (let i = 0; i < 3; i++) c[i] = l + ((c[i] - l) * l) / (l - n || 1);
  if (x > 255) for (let i = 0; i < 3; i++) c[i] = l + ((c[i] - l) * (255 - l)) / (x - l || 1);
  return c;
}
function setLum(c: number[], l: number) { const d = l - lum(c[0], c[1], c[2]); return clipColor([c[0] + d, c[1] + d, c[2] + d]); }
const sat = (c: number[]) => Math.max(c[0], c[1], c[2]) - Math.min(c[0], c[1], c[2]);
function setSat(c: number[], s: number) {
  const idx = [0, 1, 2].sort((a, b) => c[a] - c[b]);
  const out = [0, 0, 0];
  const mn = c[idx[0]], md = c[idx[1]], mx = c[idx[2]];
  if (mx > mn) { out[idx[1]] = ((md - mn) * s) / (mx - mn); out[idx[2]] = s; }
  return out;
}
/** Retouch blend modes (Photoshop menus of healing/blur/clone tools). b = base (destination), s = new colour. */
export type MixMode = 'normal' | 'replace' | 'darken' | 'lighten' | 'multiply' | 'screen' | 'hue' | 'saturation' | 'color' | 'luminosity';
export function mix(mode: MixMode, b0: number, b1: number, b2: number, s0: number, s1: number, s2: number, out: number[]) {
  switch (mode) {
    case 'darken': out[0] = Math.min(b0, s0); out[1] = Math.min(b1, s1); out[2] = Math.min(b2, s2); return;
    case 'lighten': out[0] = Math.max(b0, s0); out[1] = Math.max(b1, s1); out[2] = Math.max(b2, s2); return;
    case 'multiply': out[0] = (b0 * s0) / 255; out[1] = (b1 * s1) / 255; out[2] = (b2 * s2) / 255; return;
    case 'screen': out[0] = b0 + s0 - (b0 * s0) / 255; out[1] = b1 + s1 - (b1 * s1) / 255; out[2] = b2 + s2 - (b2 * s2) / 255; return;
    case 'hue': { const r = setLum(setSat([s0, s1, s2], sat([b0, b1, b2])), lum(b0, b1, b2)); out[0] = r[0]; out[1] = r[1]; out[2] = r[2]; return; }
    case 'saturation': { const r = setLum(setSat([b0, b1, b2], sat([s0, s1, s2])), lum(b0, b1, b2)); out[0] = r[0]; out[1] = r[1]; out[2] = r[2]; return; }
    case 'color': { const r = setLum([s0, s1, s2], lum(b0, b1, b2)); out[0] = r[0]; out[1] = r[1]; out[2] = r[2]; return; }
    case 'luminosity': { const r = setLum([b0, b1, b2], lum(s0, s1, s2)); out[0] = r[0]; out[1] = r[1]; out[2] = r[2]; return; }
    default: out[0] = s0; out[1] = s1; out[2] = s2;
  }
}
export const MODE_LABEL: Record<MixMode, string> = {
  normal: 'Normal', replace: 'Replace', darken: 'Darken', lighten: 'Lighten', multiply: 'Multiply', screen: 'Screen',
  hue: 'Hue', saturation: 'Saturation', color: 'Color', luminosity: 'Luminosity',
};
export const modeOptions = (list: MixMode[]): SelectOption<MixMode>[] => list.map(m => ({ value: m, label: MODE_LABEL[m] }));

/**
 * Write a region result into the paint target: out = orig·(1−k) + res·k with k = weight·selection
 * (premultiplied; alpha kept when transparency is locked). Rect in HOLDER coords; res/weight sized r.w×r.h.
 */
export function blendIntoTarget(doc: PixDocument, t: PaintTarget, orig: Uint8ClampedArray, res: Uint8ClampedArray, weight: Float32Array, r: Rect, useSelection = true): ImageData {
  const out = new ImageData(r.w, r.h), o = out.data;
  const sel = useSelection ? selectionAlpha(doc) : null, dw = doc.width, dh = doc.height;
  const lockA = t.kind === 'pixels' && !!t.layer?.transparencyLocked;
  const hx = t.holder.x, hy = t.holder.y;
  for (let y = 0; y < r.h; y++) {
    const dy = y + r.y + hy;
    for (let x = 0; x < r.w; x++) {
      const i = y * r.w + x, j = i * 4;
      let k = weight[i];
      if (k > 0 && sel) { const dx = x + r.x + hx; k *= dx >= 0 && dy >= 0 && dx < dw && dy < dh ? sel[dy * dw + dx] / 255 : 0; }
      if (k <= 0) { o[j] = orig[j]; o[j + 1] = orig[j + 1]; o[j + 2] = orig[j + 2]; o[j + 3] = orig[j + 3]; continue; }
      if (k > 1) k = 1;
      const ao = orig[j + 3] / 255, as = res[j + 3] / 255;
      let a = ao * (1 - k) + as * k;
      if (lockA) a = ao;
      if (a <= 0) { o[j] = o[j + 1] = o[j + 2] = o[j + 3] = 0; continue; }
      const pa = ao * (1 - k) + as * k || 1;
      for (let c = 0; c < 3; c++) o[j + c] = (orig[j + c] * ao * (1 - k) + res[j + c] * as * k) / pa;
      o[j + 3] = a * 255;
    }
  }
  return out;
}

/** Read the holder rect as RGBA; masks are returned as grey (R=G=B=value, A=255). */
export function readTarget(t: PaintTarget, r: Rect, src: HTMLCanvasElement = t.holder.canvas): ImageData {
  const img = readRegion(src, r.x, r.y, r.w, r.h);
  if (t.isMask) { const d = img.data; for (let i = 0; i < d.length; i += 4) { const a = d[i + 3]; d[i] = d[i + 1] = d[i + 2] = a; d[i + 3] = 255; } }
  return img;
}
/** Write RGBA back to the holder rect (grey → mask alpha for masks). */
export function writeTarget(t: PaintTarget, img: ImageData, r: Rect) {
  if (t.isMask) { const d = img.data; for (let i = 0; i < d.length; i += 4) { const v = Math.round(0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]); d[i] = d[i + 1] = d[i + 2] = 0; d[i + 3] = v; } }
  ctx2d(t.holder.canvas).putImageData(img, r.x, r.y);
}

// ------------------------------------------------------------------ options bar builder
export function optionsFor(tool: Tool) {
  const s = tool.settings as Record<string, any>;
  const syncs: (() => void)[] = [];
  const save = () => { app.saveToolSettings(tool); app.activeDoc?.redrawOverlay(); };
  const lab = (text: string) => h('span.opt-label', null, text);
  return {
    s, save,
    brush(): HTMLElement {
      const b = brushPicker(s as any, save);
      syncs.push(() => (b as any).refresh?.());
      return b;
    },
    brushPanel(): HTMLElement { return iconButton('brush-settings', 'Toggle the Brush Settings panel', () => runCommand('window.showPanel', 'brush-settings')); },
    clonePanel(): HTMLElement { return iconButton('clone-source', 'Toggle the Clone Source panel', () => runCommand('window.showPanel', 'clone-source')); },
    select<T>(label: string, key: string, options: SelectOption<T>[], width = 110, title?: string, onChange?: () => void): HTMLElement {
      const f = select(options, s[key] as T, v => { s[key] = v; save(); onChange?.(); }, { width, title: title || label.replace(':', '') });
      syncs.push(() => { f.setValue(s[key]); onChange?.(); });
      return h('span.opt-group', null, label ? lab(label) : null, f);
    },
    pct(label: string, key: string, title: string, min = 0, max = 100): HTMLElement {
      const f = popupSlider(label, s[key], v => { s[key] = v; save(); }, { min, max, title });
      syncs.push(() => f.setValue(s[key]));
      return f;
    },
    num(label: string, key: string, o: { min: number; max: number; unit?: string; width?: number; title: string; decimals?: number }): HTMLElement {
      const f = numberField(s[key], v => { s[key] = v; save(); }, { ...o, label: label || undefined, width: o.width ?? 44 });
      syncs.push(() => f.setValue(s[key]));
      return f;
    },
    check(label: string, key: string, title: string): HTMLElement {
      const f = checkbox(label, !!s[key], v => { s[key] = v; save(); }, { title });
      syncs.push(() => f.setValue(!!s[key]));
      return f;
    },
    toggle(iconName: string, key: string, title: string): HTMLElement {
      const f = toggleButton(iconName, title, !!s[key], v => { s[key] = v; save(); });
      syncs.push(() => f.setValue(!!s[key]));
      return f;
    },
    radio<T extends string>(label: string, key: string, items: { value: T; label: string; title?: string }[], onChange?: () => void): HTMLElement {
      const name = `rt-${tool.id}-${key}`;
      const inputs = items.map(it => {
        const inp = h('input', { type: 'radio', name, checked: s[key] === it.value }) as HTMLInputElement;
        inp.addEventListener('change', () => { if (inp.checked) { s[key] = it.value; save(); onChange?.(); } });
        return { inp, it, el: h('label.rt-radio', { title: it.title || it.label }, inp, h('span.rt-radio-dot'), h('span', null, it.label)) };
      });
      syncs.push(() => inputs.forEach(o => { o.inp.checked = s[key] === o.it.value; }));
      return h('span.opt-group.rt-radios', null, label ? lab(label) : null, ...inputs.map(o => o.el));
    },
    angle(): HTMLElement {
      const f = numberField(s.angle || 0, v => { s.angle = v; save(); }, { min: -180, max: 180, unit: '°', width: 44, title: 'Set the brush angle' });
      syncs.push(() => f.setValue(s.angle || 0));
      return h('span.opt-group', { title: 'Brush angle' }, icon('angle', 18), f);
    },
    sample(key = 'sample'): HTMLElement {
      return this.select<SampleMode>('Sample:', key, [
        { value: 'current', label: 'Current Layer' }, { value: 'below', label: 'Current & Below' }, { value: 'all', label: 'All Layers' },
      ], 130, 'Sample');
    },
    pattern(key = 'patternId'): HTMLElement {
      const f = patternPicker(patternById(s[key]), p => { s[key] = p.id; save(); });
      syncs.push(() => f.setValue(patternById(s[key])));
      return h('span.opt-group', { title: 'Pattern picker' }, f);
    },
    label: lab,
    finish(bar: HTMLElement, ...els: (HTMLElement | null)[]) {
      bar.append(...els.filter(Boolean) as HTMLElement[]);
      const off = events.on('toolOptions', () => syncs.forEach(f => f()));
      return () => off();
    },
  };
}
