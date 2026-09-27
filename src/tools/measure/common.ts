// Shared helpers for the eyedropper / sampler / ruler / count / note tools and the Info, Histogram and
// Measurement Log panels: colour sampling, measurement scale, unit formatting and the measurement log.
import { app } from '../../core/app';
import type { PixDocument } from '../../core/document';
import { renderLayersToCanvas } from '../../core/compositor';
import { GroupLayer, type Layer } from '../../core/layer';
import { Emitter } from '../../core/events';
import { intersectRect } from '../../core/geom';
import type { Rect, RGB } from '../../core/types';

// ------------------------------------------------------------------ colour sampling
export const SAMPLE_SIZES: { value: number; label: string }[] = [
  { value: 1, label: 'Point Sample' }, { value: 3, label: '3 by 3 Average' }, { value: 5, label: '5 by 5 Average' },
  { value: 11, label: '11 by 11 Average' }, { value: 31, label: '31 by 31 Average' }, { value: 51, label: '51 by 51 Average' },
  { value: 101, label: '101 by 101 Average' },
];
export type SampleMode = 'all' | 'current' | 'current-below' | 'all-noadj' | 'current-below-noadj';
export const SAMPLE_MODES: { value: SampleMode; label: string }[] = [
  { value: 'current', label: 'Current Layer' }, { value: 'current-below', label: 'Current & Below' },
  { value: 'all', label: 'All Layers' }, { value: 'all-noadj', label: 'All Layers No Adjustments' },
  { value: 'current-below-noadj', label: 'Current & Below No Adjustments' },
];

// Small CPU-backed scratch canvas: reading back from it never triggers the "multiple readbacks" warning.
let scratch: CanvasRenderingContext2D | null = null;
function scratchCtx(w: number, h: number): CanvasRenderingContext2D {
  if (!scratch) scratch = document.createElement('canvas').getContext('2d', { willReadFrequently: true })!;
  const c = scratch.canvas;
  if (c.width < w || c.height < h) { c.width = Math.max(c.width, w); c.height = Math.max(c.height, h); }
  scratch.setTransform(1, 0, 0, 1, 0, 0);
  scratch.globalCompositeOperation = 'copy';
  return scratch;
}

/** Read RGBA pixels of `src` (an image in doc coords placed at ox,oy) inside doc rect r. */
export function readRegion(src: CanvasImageSource, ox: number, oy: number, r: Rect): Uint8ClampedArray {
  const x = scratchCtx(r.w, r.h);
  x.clearRect(0, 0, r.w, r.h);
  x.drawImage(src as any, ox - r.x, oy - r.y);
  x.globalCompositeOperation = 'source-over';
  return x.getImageData(0, 0, r.w, r.h).data;
}

/** Proxy of a group that renders only some of its children (shares all other props by prototype). */
function partialGroup(g: GroupLayer, children: Layer[]): GroupLayer {
  const p = Object.create(g) as GroupLayer;
  p.children = children;
  return p;
}
function withoutAdjustments(list: Layer[]): Layer[] {
  return list.filter(l => l.kind !== 'adjustment').map(l => (l instanceof GroupLayer ? partialGroup(l, withoutAdjustments(l.children)) : l));
}
/** Layers from the bottom up to (and including) `target`, keeping the group structure. */
function upTo(list: Layer[], target: Layer): Layer[] | null {
  const out: Layer[] = [];
  for (const l of list) {
    if (l === target) { out.push(l); return out; }
    if (l instanceof GroupLayer) {
      const inner = upTo(l.children, target);
      if (inner) { out.push(partialGroup(l, inner)); return out; }
    }
    out.push(l);
  }
  return null;
}

/** The layer list to composite for a sampling mode (null = use the full composite). */
export function sampleLayers(doc: PixDocument, mode: SampleMode): Layer[] | null {
  if (mode === 'all') return null;
  if (mode === 'all-noadj') return withoutAdjustments(doc.layers);
  const active = doc.activeLayer;
  if (!active) return [];
  if (mode === 'current') return [active];
  const below = upTo(doc.layers, active) || [];
  return mode === 'current-below-noadj' ? withoutAdjustments(below) : below;
}

/** Raw RGBA of a doc rect for a sampling mode (clipped to the document). */
export function sampleRegion(doc: PixDocument, r: Rect, mode: SampleMode = 'all'): { data: Uint8ClampedArray; rect: Rect } | null {
  const rr = intersectRect(r, { x: 0, y: 0, w: doc.width, h: doc.height });
  if (!rr) return null;
  if (mode === 'all') return { data: readRegion(doc.getComposite(), 0, 0, rr), rect: rr };
  if (mode === 'current') {
    const l = doc.activeLayer;
    const c = l ? (l._preview || l.getContent(doc)) : null;
    if (!c) return { data: new Uint8ClampedArray(rr.w * rr.h * 4), rect: rr };
    return { data: readRegion(c.canvas, c.x, c.y, rr), rect: rr };
  }
  const layers = sampleLayers(doc, mode) || [];
  const canvas = renderLayersToCanvas(doc, layers, rr);
  return { data: readRegion(canvas, rr.x, rr.y, rr), rect: rr };
}

/** Average colour (alpha weighted) of a size×size area centred on (x, y); null if outside / fully transparent. */
export function sampleColor(doc: PixDocument, x: number, y: number, size = 1, mode: SampleMode = 'all'): (RGB & { a: number }) | null {
  const half = (size - 1) >> 1;
  const reg = sampleRegion(doc, { x: Math.floor(x) - half, y: Math.floor(y) - half, w: size, h: size }, mode);
  if (!reg) return null;
  const d = reg.data;
  let r = 0, g = 0, b = 0, a = 0;
  for (let i = 0; i < d.length; i += 4) { const w = d[i + 3]; r += d[i] * w; g += d[i + 1] * w; b += d[i + 2] * w; a += w; }
  if (!a) return null;
  return { r: Math.round(r / a), g: Math.round(g / a), b: Math.round(b / a), a: a / (d.length / 4) / 255 };
}

/** Notifications for measure-tool data (samplers / notes / counts / ruler) that the panels listen to. */
export const measureEvents = new Emitter<{ samplers: PixDocument; notes: PixDocument; counts: PixDocument; ruler: PixDocument; scale: PixDocument }>();

// ------------------------------------------------------------------ measurement scale
export interface MeasureScale { pixelLength: number; logicalLength: number; units: string; name?: string }
export const DEFAULT_SCALE: MeasureScale = { pixelLength: 1, logicalLength: 1, units: 'pixels', name: 'Default' };
export const getScale = (doc: PixDocument | null): MeasureScale => (doc?.extra?.measureScale as MeasureScale) || DEFAULT_SCALE;
export const scaleFactor = (s: MeasureScale) => s.logicalLength / (s.pixelLength || 1);
export const scaleLabel = (s: MeasureScale) => `${s.pixelLength} pixels = ${s.logicalLength.toFixed(4)} ${s.units}`;

// ------------------------------------------------------------------ ruler units
/** px per ruler unit + label for the current Units & Rulers preference. */
export function rulerUnit(doc: PixDocument): { k: number; label: string; dec: number } {
  const res = doc.resolution;
  switch (app.prefs.rulerUnits) {
    case 'in': return { k: res, label: 'in', dec: 3 };
    case 'cm': return { k: res / 2.54, label: 'cm', dec: 2 };
    case 'mm': return { k: res / 25.4, label: 'mm', dec: 1 };
    case 'pt': return { k: res / 72, label: 'pt', dec: 1 };
    case '%': return { k: doc.width / 100, label: '%', dec: 1 };
    default: return { k: 1, label: 'px', dec: 0 };
  }
}
/** Format a pixel distance in ruler units (or the measurement scale when useScale). */
export function fmtLen(doc: PixDocument, px: number, useScale = false, withUnit = false): string {
  if (useScale) {
    const s = getScale(doc), v = px * scaleFactor(s);
    return (s.units === 'pixels' && s.logicalLength === s.pixelLength ? v.toFixed(0) : v.toFixed(2)) + (withUnit ? ' ' + s.units : '');
  }
  const u = rulerUnit(doc), v = px / u.k;
  return v.toFixed(u.dec) + (withUnit ? ' ' + u.label : '');
}

// ------------------------------------------------------------------ measurement log (global, like Photoshop)
export interface MeasureRecord {
  id: number; label: string; date: string; document: string; source: string;
  scale: string; scaleUnits: string; scaleFactor: number;
  count?: number; length?: number; angle?: number; area?: number; perimeter?: number; circularity?: number;
  height?: number; width?: number; grayMean?: number; grayMin?: number; grayMax?: number; integratedDensity?: number;
}
export const measureLog: MeasureRecord[] = [];
export const logEvents = new Emitter<{ change: void }>();
let recordId = 0;
export function addRecord(r: Omit<MeasureRecord, 'id' | 'label' | 'date'>): MeasureRecord {
  const rec = { id: ++recordId, label: `Measurement ${recordId}`, date: new Date().toLocaleString(), ...r } as MeasureRecord;
  measureLog.push(rec);
  logEvents.emit('change');
  return rec;
}

/** Format for readouts: degrees with one decimal. */
export const fmtAngle = (deg: number) => `${deg.toFixed(1)}°`;
