// Layer compositor: renders the document's layer tree into doc.composite (only dirty regions).
// Supports every Photoshop blend mode (native canvas ops where possible, CPU for the rest),
// opacity/fill, layer masks (density/feather), clipping masks, groups (pass-through / isolated),
// adjustment layers (via the adjustments registry), layer styles (via hooks.effectsRenderer)
// and live previews (layer._preview / mask._preview).
import { AdjustmentLayer, GroupLayer, Layer } from './layer';
import type { LayerContent } from './layer';
import type { PixDocument } from './document';
import type { BlendMode, Rect } from './types';
import { adjustments, hooks } from './registry';
import { borrowCanvas, createCanvas, ctx2d, returnCanvas } from './canvas';
import { intersectRect, roundRectOut } from './geom';

const NATIVE: Partial<Record<BlendMode, GlobalCompositeOperation>> = {
  normal: 'source-over', 'pass-through': 'source-over',
  darken: 'darken', multiply: 'multiply', 'color-burn': 'color-burn',
  lighten: 'lighten', screen: 'screen', 'color-dodge': 'color-dodge',
  overlay: 'overlay', 'soft-light': 'soft-light', 'hard-light': 'hard-light',
  difference: 'difference', exclusion: 'exclusion',
  hue: 'hue', saturation: 'saturation', color: 'color', luminosity: 'luminosity',
};

/** Render pending dirty regions of doc.composite. */
export function updateComposite(doc: PixDocument) {
  if (!doc._dirty) return;
  const r = intersectRect(roundRectOut(doc._dirty), { x: 0, y: 0, w: doc.width, h: doc.height });
  doc._dirty = null;
  if (!r) return;
  const s = borrowCanvas(r.w, r.h), sx = ctx2d(s);
  try {
    if (doc.viewMaskLayerId) renderMaskView(doc, sx, r);
    else compositeList(doc, doc.layers, sx, r);
  } catch (err) { console.error('[compositor]', err); }
  const out = ctx2d(doc.composite);
  out.clearRect(r.x, r.y, r.w, r.h);
  out.drawImage(s, r.x, r.y);
  returnCanvas(s);
}

/** Composite a subset of layers (e.g. for "Sample All Layers" or merge operations) into a new doc-sized canvas. */
export function renderLayersToCanvas(doc: PixDocument, layers: Layer[], rect?: Rect): HTMLCanvasElement {
  const r = rect || { x: 0, y: 0, w: doc.width, h: doc.height };
  const c = createCanvas(r.w, r.h);
  compositeList(doc, layers, ctx2d(c), r);
  return c;
}

/** Render a single layer's final surface (content+effects+mask+fill, without opacity/blend) into a region-sized canvas. */
export function renderLayerSurface(doc: PixDocument, layer: Layer, rect?: Rect): HTMLCanvasElement | null {
  const r = rect || { x: 0, y: 0, w: doc.width, h: doc.height };
  const s = surfaceOf(doc, layer, r);
  if (!s) return null;
  const c = createCanvas(r.w, r.h);
  ctx2d(c).drawImage(s, 0, 0);
  returnCanvas(s);
  return c;
}

function compositeList(doc: PixDocument, layers: Layer[], ctx: CanvasRenderingContext2D, R: Rect) {
  let i = 0;
  while (i < layers.length) {
    const base = layers[i];
    let j = i + 1;
    while (j < layers.length && layers[j].clipped) j++;
    if (base.visible) {
      const clippedLayers = layers.slice(i + 1, j).filter(l => l.visible);
      if (clippedLayers.length && base.kind !== 'adjustment') renderClipGroup(doc, base, clippedLayers, ctx, R);
      else renderLayer(doc, base, ctx, R);
    }
    i = j;
  }
}

function hasEffects(l: Layer) { return !!hooks.effectsRenderer && l.effectsVisible && l.effects.some(e => e.enabled); }
function hasMask(l: Layer) { return !!(l.mask && l.mask.enabled); }

function renderLayer(doc: PixDocument, layer: Layer, ctx: CanvasRenderingContext2D, R: Rect) {
  if (layer.opacity <= 0) return;
  if (layer instanceof AdjustmentLayer) return renderAdjustment(doc, layer, ctx, R);
  if (layer instanceof GroupLayer) {
    if (layer.blendMode === 'pass-through' && layer.opacity >= 1 && !hasMask(layer) && !hasEffects(layer)) {
      compositeList(doc, layer.children, ctx, R);
      return;
    }
  } else if (!hasMask(layer) && !hasEffects(layer) && NATIVE[layer.blendMode] && !hooks.beforeBlend?.needs(layer)) {
    // fast path: straight GPU draw
    const c = layer._preview || layer.getContent(doc);
    if (!c || !intersectRect({ x: c.x, y: c.y, w: c.canvas.width, h: c.canvas.height }, R)) return;
    ctx.globalAlpha = layer.opacity * layer.fillOpacity;
    ctx.globalCompositeOperation = NATIVE[layer.blendMode]!;
    ctx.drawImage(c.canvas, c.x - R.x, c.y - R.y);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    return;
  }
  const s = surfaceOf(doc, layer, R);
  if (!s) return;
  if (hooks.beforeBlend?.needs(layer)) hooks.beforeBlend.apply(layer, s, ctx, R);
  blendOnto(ctx, s, layer.blendMode, layer.opacity, R);
  returnCanvas(s);
}

/** Layer surface (content+effects+mask+fill) in an R-sized scratch canvas. Caller must returnCanvas(). */
function surfaceOf(doc: PixDocument, layer: Layer, R: Rect): HTMLCanvasElement | null {
  let s: HTMLCanvasElement;
  if (layer instanceof GroupLayer) {
    const eff = hasEffects(layer);
    const area = eff ? { x: 0, y: 0, w: doc.width, h: doc.height } : R;
    const g = borrowCanvas(area.w, area.h);
    compositeList(doc, layer.children, ctx2d(g), area);
    if (eff) {
      const res = hooks.effectsRenderer!(layer, { canvas: g, x: 0, y: 0 }, doc);
      s = borrowCanvas(R.w, R.h);
      if (res) ctx2d(s).drawImage(res.canvas, res.x - R.x, res.y - R.y);
      returnCanvas(g);
    } else s = g;
  } else if (layer instanceof AdjustmentLayer) {
    return null;
  } else {
    let content: LayerContent | null = layer._preview || layer.getContent(doc);
    if (!content) return null;
    let effectsDone = false;
    if (hasEffects(layer)) {
      const res = hooks.effectsRenderer!(layer, content, doc);
      if (res) { content = res; effectsDone = true; }
    }
    if (!intersectRect({ x: content.x, y: content.y, w: content.canvas.width, h: content.canvas.height }, R)) return null;
    s = borrowCanvas(R.w, R.h);
    const x = ctx2d(s);
    x.globalAlpha = effectsDone ? 1 : layer.fillOpacity;
    x.drawImage(content.canvas, content.x - R.x, content.y - R.y);
    x.globalAlpha = 1;
  }
  applyMask(layer, s, R);
  return s;
}

const featherCache = new WeakMap<HTMLCanvasElement, { feather: number; canvas: HTMLCanvasElement }>();

/** Multiply surface alpha by the layer mask (if enabled). */
function applyMask(layer: Layer, s: HTMLCanvasElement, R: Rect) {
  const m = layer.mask;
  if (!m || !m.enabled) return;
  let mc: HTMLCanvasElement = (m as any)._preview || m.canvas;
  if (m.feather > 0) {
    const hit = featherCache.get(mc);
    if (hit && hit.feather === m.feather) mc = hit.canvas;
    else {
      const f = createCanvas(mc.width, mc.height), fx = ctx2d(f);
      fx.filter = `blur(${m.feather / 2}px)`;
      fx.drawImage(mc, 0, 0);
      featherCache.set(mc, { feather: m.feather, canvas: f });
      mc = f;
    }
  }
  const ms = borrowCanvas(R.w, R.h), mx = ctx2d(ms);
  const density = m.density ?? 1;
  if (m.bg === 255) {
    mx.fillStyle = '#000'; mx.fillRect(0, 0, R.w, R.h);
    mx.clearRect(m.x - R.x, m.y - R.y, mc.width, mc.height);
  }
  if (density < 1) { mx.fillStyle = `rgba(0,0,0,${1 - density})`; mx.fillRect(0, 0, R.w, R.h); }
  mx.drawImage(mc, m.x - R.x, m.y - R.y);
  const sx = ctx2d(s);
  sx.globalCompositeOperation = 'destination-in';
  sx.drawImage(ms, 0, 0);
  sx.globalCompositeOperation = 'source-over';
  returnCanvas(ms);
}

function renderClipGroup(doc: PixDocument, base: Layer, clipped: Layer[], ctx: CanvasRenderingContext2D, R: Rect) {
  const b = surfaceOf(doc, base, R);
  if (!b) return;
  const group = borrowCanvas(R.w, R.h), gx = ctx2d(group);
  gx.drawImage(b, 0, 0);
  for (const c of clipped) {
    if (c.opacity <= 0) continue;
    if (c instanceof AdjustmentLayer) { renderAdjustment(doc, c, gx, R); continue; }
    const cs = surfaceOf(doc, c, R);
    if (!cs) continue;
    const cx = ctx2d(cs);
    cx.globalCompositeOperation = 'destination-in';
    cx.drawImage(b, 0, 0);
    cx.globalCompositeOperation = 'source-over';
    // clipped layers blend onto the base; use source-atop semantics for normal mode
    if (c.blendMode === 'normal' || c.blendMode === 'pass-through') {
      gx.globalAlpha = c.opacity; gx.globalCompositeOperation = 'source-atop';
      gx.drawImage(cs, 0, 0);
      gx.globalAlpha = 1; gx.globalCompositeOperation = 'source-over';
    } else blendOnto(gx, cs, c.blendMode, c.opacity, R);
    returnCanvas(cs);
  }
  blendOnto(ctx, group, base.blendMode, base.opacity, R);
  returnCanvas(group);
  returnCanvas(b);
}

function renderAdjustment(doc: PixDocument, layer: AdjustmentLayer, ctx: CanvasRenderingContext2D, R: Rect) {
  const def = adjustments[layer.adjustment.type];
  if (!def) return;
  const w = ctx.canvas.width, h = ctx.canvas.height;
  const backdrop = ctx.getImageData(0, 0, w, h);
  const adj = new ImageData(new Uint8ClampedArray(backdrop.data), w, h);
  try { def.apply(adj, layer.adjustment.params, { doc, rect: R }); } catch (err) { console.error('[adjustment]', err); return; }
  const simple = !hasMask(layer) && layer.opacity >= 1 && layer.fillOpacity >= 1 && (layer.blendMode === 'normal' || layer.blendMode === 'pass-through');
  if (simple) {
    // restore original alpha (adjustments must not change coverage)
    const a = adj.data, o = backdrop.data;
    for (let i = 3; i < a.length; i += 4) a[i] = o[i];
    ctx.putImageData(adj, 0, 0);
    return;
  }
  const s = borrowCanvas(w, h);
  ctx2d(s).putImageData(adj, 0, 0);
  applyMask(layer, s, R);
  const op = layer.opacity * layer.fillOpacity;
  if (layer.blendMode === 'normal' || layer.blendMode === 'pass-through') {
    ctx.globalAlpha = op; ctx.globalCompositeOperation = 'source-atop';
    ctx.drawImage(s, 0, 0);
    ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
  } else blendOnto(ctx, s, layer.blendMode, op, R);
  returnCanvas(s);
}

function renderMaskView(doc: PixDocument, ctx: CanvasRenderingContext2D, R: Rect) {
  const layer = doc.findLayer(doc.viewMaskLayerId);
  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, R.w, R.h);
  const m = layer?.mask;
  if (!m) return;
  const s = borrowCanvas(R.w, R.h), x = ctx2d(s);
  if (m.bg === 255) { x.fillStyle = '#fff'; x.fillRect(0, 0, R.w, R.h); x.clearRect(m.x - R.x, m.y - R.y, m.canvas.width, m.canvas.height); }
  const tmp = borrowCanvas(m.canvas.width, m.canvas.height), tx = ctx2d(tmp);
  tx.fillStyle = '#fff'; tx.fillRect(0, 0, tmp.width, tmp.height);
  tx.globalCompositeOperation = 'destination-in'; tx.drawImage((m as any)._preview || m.canvas, 0, 0);
  x.drawImage(tmp, m.x - R.x, m.y - R.y);
  ctx.drawImage(s, 0, 0);
  returnCanvas(tmp); returnCanvas(s);
}

/** Blend an R-sized surface onto an R-sized target. */
export function blendOnto(ctx: CanvasRenderingContext2D, src: HTMLCanvasElement, mode: BlendMode, opacity: number, R: Rect) {
  const op = NATIVE[mode];
  if (op) {
    ctx.globalAlpha = opacity; ctx.globalCompositeOperation = op;
    ctx.drawImage(src, 0, 0);
    ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
    return;
  }
  const w = ctx.canvas.width, h = ctx.canvas.height;
  const dst = ctx.getImageData(0, 0, w, h);
  const sd = ctx2d(src).getImageData(0, 0, w, h);
  blendPixels(dst.data, sd.data, mode, opacity, w, R.x, R.y);
  ctx.putImageData(dst, 0, 0);
}

const burn = (b: number, s: number) => (b >= 1 ? 1 : s <= 0 ? 0 : 1 - Math.min(1, (1 - b) / s));
const dodge = (b: number, s: number) => (b <= 0 ? 0 : s >= 1 ? 1 : Math.min(1, b / (1 - s)));
const SEP: Partial<Record<BlendMode, (b: number, s: number) => number>> = {
  'linear-burn': (b, s) => Math.max(0, b + s - 1),
  'linear-dodge': (b, s) => Math.min(1, b + s),
  'vivid-light': (b, s) => (s <= 0.5 ? burn(b, 2 * s) : dodge(b, 2 * (s - 0.5))),
  'linear-light': (b, s) => Math.min(1, Math.max(0, b + 2 * s - 1)),
  'pin-light': (b, s) => (s <= 0.5 ? Math.min(b, 2 * s) : Math.max(b, 2 * s - 1)),
  'hard-mix': (b, s) => (b + s >= 1 ? 1 : 0),
  subtract: (b, s) => Math.max(0, b - s),
  divide: (b, s) => (s <= 0 ? (b <= 0 ? 0 : 1) : Math.min(1, b / s)),
  // generic fallbacks (used only if called with a native mode)
  normal: (_b, s) => s,
};

/** CPU blend of RGBA byte arrays (dst updated in place). x0/y0 = doc offset of the region (for dissolve noise). */
export function blendPixels(d: Uint8ClampedArray, s: Uint8ClampedArray, mode: BlendMode, opacity: number, width: number, x0 = 0, y0 = 0) {
  const f = SEP[mode];
  for (let i = 0, p = 0; i < d.length; i += 4, p++) {
    let as = (s[i + 3] / 255) * opacity;
    if (as <= 0) continue;
    const ab = d[i + 3] / 255;
    const sr = s[i] / 255, sg = s[i + 1] / 255, sb = s[i + 2] / 255;
    const br = d[i] / 255, bg = d[i + 1] / 255, bb = d[i + 2] / 255;
    let rr: number, rg: number, rb: number;
    if (mode === 'dissolve') {
      const x = (p % width) + x0, y = ((p / width) | 0) + y0;
      let hsh = (x * 374761393 + y * 668265263) | 0; hsh = (hsh ^ (hsh >>> 13)) * 1274126177; hsh ^= hsh >>> 16;
      if ((hsh >>> 0) / 4294967296 >= as) continue;
      as = 1; rr = sr; rg = sg; rb = sb;
    } else if (mode === 'darker-color' || mode === 'lighter-color') {
      const ls = 0.299 * sr + 0.587 * sg + 0.114 * sb, lb = 0.299 * br + 0.587 * bg + 0.114 * bb;
      const pickS = mode === 'darker-color' ? ls < lb : ls > lb;
      rr = pickS ? sr : br; rg = pickS ? sg : bg; rb = pickS ? sb : bb;
    } else if (f) {
      rr = f(br, sr); rg = f(bg, sg); rb = f(bb, sb);
    } else { rr = sr; rg = sg; rb = sb; }
    // W3C compositing: mix blend result with source by backdrop alpha, then source-over
    const mr = (1 - ab) * sr + ab * rr, mg = (1 - ab) * sg + ab * rg, mb = (1 - ab) * sb + ab * rb;
    const ao = as + ab * (1 - as);
    d[i] = ((mr * as + br * ab * (1 - as)) / ao) * 255;
    d[i + 1] = ((mg * as + bg * ab * (1 - as)) / ao) * 255;
    d[i + 2] = ((mb * as + bb * ab * (1 - as)) / ao) * 255;
    d[i + 3] = ao * 255;
  }
}
