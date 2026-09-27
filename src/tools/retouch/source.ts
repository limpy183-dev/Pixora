// Clone sources shared by the Clone Stamp and Healing Brush tools and the Clone Source panel.
// Five source slots (like Photoshop); each keeps its source point, aligned offset and transform.
import type { PixDocument } from '../../core/document';
import { app, saveJSON } from '../../core/app';
import type { Point } from '../../core/types';

export interface CloneSrc {
  docId: number;
  docName: string;
  layerName: string;
  defined: boolean;
  sx: number; sy: number;                 // source point (doc px, integers)
  offset: Point | null;                   // aligned offset (dest - source); null until the first stroke
  scaleX: number; scaleY: number;         // %
  linked: boolean;                        // W/H linked
  angle: number;                          // degrees
  flipH: boolean; flipV: boolean;
  frameOffset: number; lockFrame: boolean;
}

export type OverlayMode = 'normal' | 'darken' | 'lighten' | 'difference';

const blank = (): CloneSrc => ({
  docId: 0, docName: '', layerName: '', defined: false, sx: 0, sy: 0, offset: null,
  scaleX: 100, scaleY: 100, linked: true, angle: 0, flipH: false, flipV: false, frameOffset: 0, lockFrame: false,
});

function loadOverlay() {
  const d = { showOverlay: true, opacity: 100, clipped: true, autoHide: true, invert: false, mode: 'normal' as OverlayMode, showAlways: false };
  try { return { ...d, ...JSON.parse(localStorage.getItem('pixora.cloneOverlay') || '{}') }; } catch { return d; }
}

export const clone = {
  active: 0,
  sources: [blank(), blank(), blank(), blank(), blank()],
  overlay: loadOverlay(),
  /** true while a clone/heal stroke is in progress (Auto Hide). */
  painting: false,
  /** Dest anchor of the stroke in progress (for the crosshair). */
  strokeAnchor: null as Point | null,
};

const listeners = new Set<() => void>();
export function onCloneChange(fn: () => void): () => void { listeners.add(fn); return () => listeners.delete(fn); }
export function cloneChanged() {
  saveJSON('pixora.cloneOverlay', clone.overlay);
  for (const f of listeners) { try { f(); } catch (err) { console.error(err); } }
  app.activeDoc?.redrawOverlay();
}

export const activeSource = () => clone.sources[clone.active];

/** Alt-click: define the source point of the active slot. */
export function defineSource(doc: PixDocument, x: number, y: number) {
  const s = activeSource();
  s.docId = doc.id; s.docName = doc.name; s.layerName = doc.activeLayer?.name || '';
  s.sx = Math.round(x); s.sy = Math.round(y);
  s.defined = true;
  s.offset = null;
  cloneChanged();
}

export function sourceDoc(s: CloneSrc): PixDocument | null {
  return s.defined ? app.docs.find(d => d.id === s.docId) || null : null;
}

/** Linear part of the source → destination mapping (scale, flip, rotation). */
export function linearOf(s: CloneSrc): DOMMatrix {
  return new DOMMatrix().rotate(s.angle).scale((s.flipH ? -1 : 1) * s.scaleX / 100, (s.flipV ? -1 : 1) * s.scaleY / 100);
}
export const isIdentity = (s: CloneSrc) => s.angle === 0 && s.scaleX === 100 && s.scaleY === 100 && !s.flipH && !s.flipV;

/** Matrix mapping SOURCE doc coords to DESTINATION doc coords for a stroke anchored at `anchor` (dest point that samples the source point). */
export function sourceToDest(s: CloneSrc, anchor: Point): DOMMatrix {
  return new DOMMatrix().translate(anchor.x, anchor.y).multiply(linearOf(s)).translate(-s.sx, -s.sy);
}
/** Source point sampled when painting at dest point p. */
export function destToSource(s: CloneSrc, anchor: Point, p: Point): Point {
  const q = sourceToDest(s, anchor).inverse().transformPoint(new DOMPoint(p.x, p.y));
  return { x: q.x, y: q.y };
}

/** Anchor for a new stroke starting at p (Aligned keeps the offset between strokes). */
export function strokeAnchor(s: CloneSrc, p: Point, aligned: boolean): Point {
  const P = { x: Math.round(p.x), y: Math.round(p.y) };
  if (!aligned) return P;
  if (!s.offset) { s.offset = { x: P.x - s.sx, y: P.y - s.sy }; cloneChanged(); }
  return { x: s.sx + s.offset.x, y: s.sy + s.offset.y };
}

/** Anchor used for the hover overlay (before the stroke starts). */
export function hoverAnchor(s: CloneSrc, p: Point, aligned: boolean): Point {
  if (aligned && s.offset) return { x: s.sx + s.offset.x, y: s.sy + s.offset.y };
  return { x: Math.round(p.x), y: Math.round(p.y) };
}

export function resetTransform(s: CloneSrc) {
  s.scaleX = s.scaleY = 100; s.angle = 0; s.flipH = s.flipV = false;
  cloneChanged();
}
