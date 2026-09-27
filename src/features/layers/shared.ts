// Helpers shared by the Layers panel, the Layer menu commands, fill layers and smart objects.
import { app, saveJSON } from '../../core/app';
import type { PixDocument } from '../../core/document';
import { GroupLayer, Layer, RasterLayer } from '../../core/layer';
import type { BlendMode, EffectType, LayerMask } from '../../core/types';
import { BLEND_MODE_LABELS, BLEND_MODE_MENU } from '../../core/types';
import { createCanvas, ctx2d, cloneCanvas } from '../../core/canvas';
import { toast } from '../../ui/toast';
import { h } from '../../ui/dom';
import { checkbox, numberField, select, textField } from '../../ui/widgets';
import { openDialog } from '../../ui/dialog';
import { events } from '../../core/events';
import { unionRect } from '../../core/geom';
import type { Rect } from '../../core/types';

// ------------------------------------------------------------------ Layers panel options (persisted)
export interface LayersPrefs {
  thumbSize: 'none' | 'small' | 'medium' | 'large';
  thumbContents: 'bounds' | 'document';
  defaultMasksOnFill: boolean;
  expandNewEffects: boolean;
  addCopy: boolean;
  confirmDelete: boolean;
}
export const layersPrefs: LayersPrefs = (() => {
  const d: LayersPrefs = { thumbSize: 'medium', thumbContents: 'document', defaultMasksOnFill: true, expandNewEffects: true, addCopy: true, confirmDelete: true };
  try { return { ...d, ...JSON.parse(localStorage.getItem('pixora.layersPanel') || '{}') }; } catch { return d; }
})();
export function saveLayersPrefs() { saveJSON('pixora.layersPanel', layersPrefs); }

/** UI hooks the Layers panel installs (commands call them when available). */
export const layersUI = {
  /** Start inline rename of a layer in the panel. Returns false when the panel is not visible. */
  rename: null as null | ((layer: Layer) => boolean),
};

// ------------------------------------------------------------------ naming
/** Next "Base N" name (scans existing names, like Photoshop's "Group 3", "Color Fill 2"). */
export function nextNumberedName(doc: PixDocument, base: string): string {
  const re = new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} (\\d+)$`);
  let n = 0;
  for (const l of doc.allLayers()) { const m = re.exec(l.name); if (m) n = Math.max(n, +m[1]); }
  return `${base} ${n + 1}`;
}
/** "Layer 1" → "Layer 1 copy" → "Layer 1 copy 2" … (honours the "Add copy" panel option). */
export function copyName(doc: PixDocument, name: string): string {
  if (!layersPrefs.addCopy) return name;
  const base = name.replace(/ copy( \d+)?$/, '');
  const names = new Set(doc.allLayers().map(l => l.name));
  if (!names.has(`${base} copy`)) return `${base} copy`;
  let i = 2;
  while (names.has(`${base} copy ${i}`)) i++;
  return `${base} copy ${i}`;
}

// ------------------------------------------------------------------ tree helpers
export function hasAncestor(l: Layer, anc: Layer): boolean { for (let p = l._parent; p; p = p._parent) if (p === anc) return true; return false; }
/** Selected layers without those inside a selected group, bottom → top (document order). */
export function topSelected(doc: PixDocument): Layer[] {
  const sel = doc.selectedLayers, set = new Set(sel);
  return sel.filter(l => { for (let p = l._parent; p; p = p._parent) if (set.has(p)) return false; return true; });
}
/** Stacking index of a layer in allLayers() (for sorting). */
export function orderIndex(doc: PixDocument): Map<Layer, number> {
  const m = new Map<Layer, number>();
  doc.allLayers().forEach((l, i) => m.set(l, i));
  return m;
}
export function isVisibleDeep(l: Layer): boolean { for (let p: Layer | null = l; p; p = p._parent) if (!p.visible) return false; return true; }
export function backgroundOf(doc: PixDocument): Layer | null { return doc.layers.find(l => l.isBackground) || null; }

/** Photoshop-style message when there is no document. */
export function needDoc(): PixDocument | null {
  const d = app.activeDoc;
  if (!d) toast('There is no open document.', 'error');
  return d;
}

/** Convert the Background into a normal layer (inside a transaction). */
export function unBackground(layer: Layer, name = 'Layer 0') {
  if (!layer.isBackground) return;
  layer.isBackground = false;
  layer.name = name;
  layer.locks = { ...layer.locks, all: false, position: false, transparency: false };
}

// ------------------------------------------------------------------ masks
/** Layer mask from the current selection (reveal = selected areas visible). */
export function maskFromSelection(doc: PixDocument, hide = false): LayerMask {
  const c = createCanvas(doc.width, doc.height), x = ctx2d(c), sel = doc.selection.mask;
  if (!hide) { if (sel) x.drawImage(sel, 0, 0); }
  else { x.fillStyle = '#000'; x.fillRect(0, 0, c.width, c.height); if (sel) { x.globalCompositeOperation = 'destination-out'; x.drawImage(sel, 0, 0); } }
  return { canvas: c, x: 0, y: 0, bg: hide ? 255 : 0, enabled: true, linked: true, density: 1, feather: 0 };
}
/** Mask value canvas covering the document (alpha = value), honouring mask offset and bg. */
export function maskDocCanvas(doc: PixDocument, m: LayerMask): HTMLCanvasElement {
  const c = createCanvas(doc.width, doc.height), x = ctx2d(c);
  if (m.bg === 255) { x.fillStyle = '#000'; x.fillRect(0, 0, c.width, c.height); x.clearRect(m.x, m.y, m.canvas.width, m.canvas.height); }
  x.drawImage(m.canvas, m.x, m.y);
  return c;
}
/** Alpha of a layer's content as a doc-sized selection canvas. */
export function transparencyCanvas(doc: PixDocument, l: Layer): HTMLCanvasElement | null {
  const c = l.getContent(doc);
  if (!c) return null;
  const out = createCanvas(doc.width, doc.height);
  ctx2d(out).drawImage(c.canvas, c.x, c.y);
  return out;
}

// ------------------------------------------------------------------ effect names
export const EFFECT_ORDER: EffectType[] = ['bevelEmboss', 'stroke', 'innerShadow', 'innerGlow', 'satin', 'colorOverlay', 'gradientOverlay', 'patternOverlay', 'outerGlow', 'dropShadow'];
export const EFFECT_LABELS: Record<EffectType, string> = {
  bevelEmboss: 'Bevel & Emboss', stroke: 'Stroke', innerShadow: 'Inner Shadow', innerGlow: 'Inner Glow', satin: 'Satin',
  colorOverlay: 'Color Overlay', gradientOverlay: 'Gradient Overlay', patternOverlay: 'Pattern Overlay', outerGlow: 'Outer Glow', dropShadow: 'Drop Shadow',
};

// ------------------------------------------------------------------ colour labels
export const LABEL_COLORS: [string, string, string][] = [
  ['none', 'No Color', ''], ['red', 'Red', '#9b3b3b'], ['orange', 'Orange', '#a1662f'], ['yellow', 'Yellow', '#9a8b35'],
  ['green', 'Green', '#4b7a3b'], ['blue', 'Blue', '#3c5f92'], ['violet', 'Violet', '#6d4d92'], ['gray', 'Gray', '#6e6e6e'],
];
export const labelCss = (id: string) => LABEL_COLORS.find(c => c[0] === id)?.[2] || '';

// ------------------------------------------------------------------ blend mode options
export function blendOptions(group: boolean) {
  const opts: ({ value: BlendMode; label: string } | '-')[] = [];
  if (group) opts.push({ value: 'pass-through', label: 'Pass Through' });
  for (const m of BLEND_MODE_MENU) opts.push(m === '-' ? '-' : { value: m, label: BLEND_MODE_LABELS[m] });
  return opts;
}
/** Neutral colour for "Fill with <mode>-neutral color". */
export function neutralFor(mode: BlendMode): { css: string; label: string } | null {
  if (['multiply', 'color-burn', 'linear-burn', 'darken', 'divide'].includes(mode)) return { css: '#fff', label: 'white' };
  if (['screen', 'color-dodge', 'linear-dodge', 'lighten', 'difference', 'exclusion', 'subtract'].includes(mode)) return { css: '#000', label: 'black' };
  if (['overlay', 'soft-light', 'hard-light', 'vivid-light', 'linear-light', 'pin-light'].includes(mode)) return { css: '#808080', label: '50% gray' };
  return null;
}

// ------------------------------------------------------------------ New Layer / New Group dialog
export interface NewLayerOpts { name: string; clip: boolean; color: string; mode: BlendMode; opacity: number; neutral: boolean }
/** Photoshop "New Layer" / "New Group" dialog. Resolves null on Cancel. */
export async function newLayerDialog(title: string, init: Partial<NewLayerOpts> & { name: string }, o: { group?: boolean; noClip?: boolean; noNeutral?: boolean } = {}): Promise<NewLayerOpts | null> {
  const v: NewLayerOpts = { clip: false, color: 'none', mode: o.group ? 'pass-through' : 'normal', opacity: 100, neutral: false, ...init };
  const name = textField(v.name, s => { v.name = s; }, { width: 280, onInput: s => { v.name = s; } });
  const neutralBox = h('div.lp-dlg-neutral');
  const renderNeutral = () => {
    neutralBox.replaceChildren();
    if (o.group || o.noNeutral) return;
    const n = neutralFor(v.mode);
    const cb = checkbox(n ? `Fill with ${BLEND_MODE_LABELS[v.mode]}-neutral color (${n.label})` : `Fill with ${BLEND_MODE_LABELS[v.mode]}-neutral color (neutral color does not exist)`, v.neutral && !!n, b => { v.neutral = b; });
    if (!n) { cb.classList.add('disabled'); (cb.querySelector('input') as HTMLInputElement).disabled = true; v.neutral = false; }
    neutralBox.append(cb);
  };
  const body = h('div.form.lp-dlg',
    null,
    h('div.form-row', null, h('label.form-label', null, 'Name:'), name),
    o.noClip || o.group ? null : h('div.form-row', null, h('label.form-label'), checkbox('Use Previous Layer to Create Clipping Mask', v.clip, b => { v.clip = b; })),
    h('div.form-row', null, h('label.form-label', null, 'Color:'),
      select(LABEL_COLORS.map(([id, label]) => ({ value: id, label })), v.color, c => { v.color = c; }, { width: 130 })),
    h('div.form-row', null, h('label.form-label', null, 'Mode:'),
      select(blendOptions(!!o.group), v.mode, m => { v.mode = m; renderNeutral(); }, { width: 150 }),
      h('span.lp-dlg-op', null, 'Opacity:'), numberField(v.opacity, n => { v.opacity = n; }, { min: 0, max: 100, unit: '%', width: 52 })),
    neutralBox,
  );
  renderNeutral();
  const r = await openDialog({ title, body, layout: 'side', buttons: [{ label: 'OK', primary: true, value: true }, { label: 'Cancel', value: false }] }).result;
  if (!r) return null;
  v.name = v.name.trim() || init.name;
  return v;
}

/** Apply the dialog result to a new layer (inside a transaction). */
export function applyNewLayerOpts(l: Layer, v: NewLayerOpts, doc: PixDocument) {
  l.name = v.name;
  l.blendMode = v.mode;
  l.opacity = Math.max(0, Math.min(1, v.opacity / 100));
  l.colorLabel = v.color;
  if (v.clip && !(l instanceof GroupLayer)) {
    if (doc.siblingsOf(l).indexOf(l) > 0) l.clipped = true;
  }
  if (v.neutral && l instanceof RasterLayer) {
    const n = neutralFor(v.mode);
    if (n) { const c = createCanvas(doc.width, doc.height), x = ctx2d(c); x.fillStyle = n.css; x.fillRect(0, 0, c.width, c.height); l.canvas = c; l.x = 0; l.y = 0; l.invalidate(); }
  }
}

/**
 * Coalesce live edits (slider drags) into one history state: call edit(fn, false) while dragging and
 * edit(fn, true) on release. A single edit(fn, true) records immediately.
 */
export function liveEditor(doc: PixDocument, name: string) {
  let t: ReturnType<PixDocument['history']['begin']> | null = null;
  return (fn: () => void, final: boolean) => {
    if (!t) t = doc.history.begin(name);
    fn();
    if (final) { const tt = t; t = null; tt.commit(); }
  };
}

/** Replace a raster layer's pixels with a copy (safe for history). */
export function replaceCanvas(l: RasterLayer, c: HTMLCanvasElement, x = l.x, y = l.y) { l.canvas = c; l.x = x; l.y = y; l.invalidate(); }
export { cloneCanvas };

// ------------------------------------------------------------------ selection / tree mutation helpers

/** Select several layers at once (active = last of the list unless given). */
export function selectLayers(doc: PixDocument, layers: Layer[], active?: Layer | null) {
  const list = layers.filter(Boolean);
  doc.selectedIds = list.map(l => l.id);
  doc.activeLayerId = (active || list[list.length - 1])?.id ?? null;
  if (!doc.activeLayer?.mask) doc.editMask = false;
  events.emit('activeLayer', doc);
}

/** Layers in Layers-panel order (top → bottom), children of collapsed groups excluded unless `all`. */
export function panelOrder(doc: PixDocument, all = false): Layer[] {
  const out: Layer[] = [];
  const walk = (list: Layer[]) => {
    for (let i = list.length - 1; i >= 0; i--) {
      const l = list[i];
      out.push(l);
      if (l instanceof GroupLayer && (all || l.expanded)) walk(l.children);
    }
  };
  walk(doc.layers);
  return out;
}

const COMMON_PROPS = ['name', 'visible', 'opacity', 'fillOpacity', 'blendMode', 'locks', 'clipped', 'mask', 'effects', 'effectsVisible', 'colorLabel', 'isBackground', 'linkId'] as const;
/** Copy the generic layer properties (name, opacity, mask, effects…) from one layer to another. */
export function copyCommon(from: Layer, to: Layer, skip: string[] = []) {
  for (const k of COMMON_PROPS) if (!skip.includes(k)) (to as any)[k] = (from as any)[k];
  if (to.blendMode === 'pass-through' && !(to instanceof GroupLayer)) to.blendMode = 'normal';
}

/** Put `neu` in place of `old` in the tree (keeps the id so selection stays valid). Call inside a transaction. */
export function replaceLayer(doc: PixDocument, old: Layer, neu: Layer) {
  const list = doc.siblingsOf(old), i = list.indexOf(old);
  if (i < 0) return;
  neu.id = old.id;
  list[i] = neu;
  doc.relink();
}

/** Rasterized copy of a layer's content (vector/text/fill/smart → pixels). Keeps the common properties. */
export function rasterOf(doc: PixDocument, l: Layer): RasterLayer {
  const r = new RasterLayer(1, 1, l.name);
  copyCommon(l, r);
  const c = l.getContent(doc);
  if (c) { r.canvas = cloneCanvas(c.canvas); r.x = c.x; r.y = c.y; }
  else { r.canvas = createCanvas(doc.width, doc.height); r.x = 0; r.y = 0; }
  r.invalidate();
  return r;
}

/** Union of the (untrimmed) content rects of layers and the canvas. */
export function stackRect(doc: PixDocument, layers: Layer[]): Rect {
  let r: Rect | null = { x: 0, y: 0, w: doc.width, h: doc.height };
  for (const l of layers) {
    const b = l.bounds(doc);
    if (b) r = unionRect(r, { x: Math.floor(b.x), y: Math.floor(b.y), w: Math.ceil(b.w) + 1, h: Math.ceil(b.h) + 1 });
  }
  return r!;
}

/** Mask value (alpha) for a rectangle in doc coords, honouring bg, density and feather — like the compositor. */
export function maskForRect(m: LayerMask, r: Rect): HTMLCanvasElement {
  const c = createCanvas(r.w, r.h), x = ctx2d(c);
  const density = m.density ?? 1;
  if (m.bg === 255) { x.fillStyle = '#000'; x.fillRect(0, 0, r.w, r.h); x.clearRect(m.x - r.x, m.y - r.y, m.canvas.width, m.canvas.height); }
  if (density < 1) { x.fillStyle = `rgba(0,0,0,${1 - density})`; x.fillRect(0, 0, r.w, r.h); }
  if (m.feather > 0) x.filter = `blur(${m.feather / 2}px)`;
  x.drawImage(m.canvas, m.x - r.x, m.y - r.y);
  x.filter = 'none';
  return c;
}

/** Load a doc-sized alpha canvas as the selection with the modifier op (inside a transaction). */
export function loadAsSelection(doc: PixDocument, c: HTMLCanvasElement | null, op: 'replace' | 'add' | 'subtract' | 'intersect', name = 'Load Selection') {
  if (!c) return;
  doc.history.transaction(name, () => doc.selection.apply(c, op));
}
export const opFromEvent = (e: MouseEvent): 'replace' | 'add' | 'subtract' | 'intersect' =>
  e.shiftKey && e.altKey ? 'intersect' : e.shiftKey ? 'add' : e.altKey ? 'subtract' : 'replace';
