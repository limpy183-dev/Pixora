// Layer style renderer (hooks.effectsRenderer). Builds the layer surface with its effects in Photoshop's stacking
// order: Drop Shadow, Outer Glow, content (× Fill opacity), Pattern / Gradient / Color Overlay, Satin, Inner Glow,
// Inner Shadow, Stroke, Bevel & Emboss. Masks come from the content alpha (signed distance field + blurs); results
// are cached per layer until its content, effects or the global light change.
import type { PixDocument } from '../core/document';
import type { Layer, LayerContent } from '../core/layer';
import { events } from '../core/events';
import { hooks, resources } from '../core/registry';
import { alphaBounds, createCanvas, ctx2d } from '../core/canvas';
import { renderGradient, gradientLUT } from '../core/gradient';
import { resolveGradient } from '../core/presets';
import type { GradientShape, LayerEffect, RGB } from '../core/types';
import { BLEND_NATIVE, applyContour, blur, contourLUT, noiseAt, normEffect, signedDistance } from './engine';

export interface GlobalLight { angle: number; altitude: number }
export const globalLight = (doc: PixDocument): GlobalLight => ({ angle: 120, altitude: 30, ...(doc.extra?.globalLight || {}) });

// ------------------------------------------------------------------ cache
const pixelGen = new WeakMap<Layer, number>();
events.on('pixels', e => { if (e.layer) pixelGen.set(e.layer, (pixelGen.get(e.layer) || 0) + 1); else for (const l of e.doc.allLayers()) pixelGen.set(l, (pixelGen.get(l) || 0) + 1); });
const canvasIds = new WeakMap<HTMLCanvasElement, number>();
let canvasSeq = 0;
const cid = (c: HTMLCanvasElement) => { let v = canvasIds.get(c); if (!v) canvasIds.set(c, (v = ++canvasSeq)); return v; };
const cache = new WeakMap<Layer, { key: string; res: LayerContent }>();

/** Padding (px) an effect needs around the content. */
function extent(e: LayerEffect): number {
  switch (e.type) {
    case 'dropShadow': return e.distance + e.size + 3;
    case 'outerGlow': return e.size + 3;
    case 'stroke': return e.position === 'inside' ? 1 : e.size + 3;
    case 'bevelEmboss': return e.style === 'inner' ? 2 : e.size + e.soften + 3;
    default: return 2;
  }
}

// ------------------------------------------------------------------ helpers
type Mask = Float32Array;
interface Ctx { W: number; H: number; A: Mask; sdf: Float32Array | null; R: { x: number; y: number }; doc: PixDocument; bounds: { x: number; y: number; w: number; h: number } }
const sdfOf = (c: Ctx) => {
  if (!c.sdf) { const a8 = new Uint8Array(c.A.length); for (let i = 0; i < a8.length; i++) a8[i] = Math.round(c.A[i] * 255); c.sdf = signedDistance(a8, c.W, c.H); }
  return c.sdf;
};
const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
/** Shape coverage dilated by d px (d < 0 erodes). */
function dilated(c: Ctx, d: number): Mask {
  if (Math.abs(d) < 0.01) return c.A.slice();
  const s = sdfOf(c), m = new Float32Array(s.length);
  for (let i = 0; i < m.length; i++) m[i] = clamp01(0.5 + d - s[i]);
  return m;
}
function shifted(m: Mask, W: number, H: number, dx: number, dy: number, fill = 0): Mask {
  const ix = Math.round(dx), iy = Math.round(dy);
  if (!ix && !iy) return m;
  const o = new Float32Array(m.length);
  for (let y = 0; y < H; y++) {
    const sy = y - iy;
    for (let x = 0; x < W; x++) { const sx = x - ix; o[y * W + x] = sx >= 0 && sy >= 0 && sx < W && sy < H ? m[sy * W + sx] : fill; }
  }
  return o;
}
function toCanvas(W: number, H: number, fill: (i: number, d: Uint8ClampedArray, j: number) => void): HTMLCanvasElement {
  const img = new ImageData(W, H), d = img.data;
  for (let i = 0, j = 0; i < W * H; i++, j += 4) fill(i, d, j);
  const c = createCanvas(W, H); ctx2d(c).putImageData(img, 0, 0);
  return c;
}
/** Solid colour × mask × opacity. */
function colored(c: Ctx, m: Mask, col: RGB, opacity: number, noise = 0): HTMLCanvasElement {
  const k = opacity / 100, n = noise / 100;
  return toCanvas(c.W, c.H, (i, d, j) => {
    let a = m[i];
    if (a <= 0) return;
    if (n) a *= 1 - n * noiseAt(i);
    d[j] = col.r; d[j + 1] = col.g; d[j + 2] = col.b; d[j + 3] = a * k * 255;
  });
}
/** Gradient coloured by the mask value (glows: centre → edge). */
function gradientByValue(c: Ctx, m: Mask, e: LayerEffect, opacity: number): HTMLCanvasElement {
  const lut = gradientLUT(resolveGradient(e.gradient), false, 256), k = opacity / 100, n = (e.noise || 0) / 100;
  return toCanvas(c.W, c.H, (i, d, j) => {
    let a = m[i];
    if (a <= 0) return;
    if (n) a *= 1 - n * noiseAt(i);
    const q = Math.round((1 - clamp01(a)) * 255) * 4;
    d[j] = lut[q]; d[j + 1] = lut[q + 1]; d[j + 2] = lut[q + 2]; d[j + 3] = a * (lut[q + 3] / 255) * k * 255;
  });
}
function draw(out: CanvasRenderingContext2D, src: HTMLCanvasElement, mode: string) {
  out.globalCompositeOperation = BLEND_NATIVE[mode] || 'source-over';
  out.drawImage(src, 0, 0);
  out.globalCompositeOperation = 'source-over';
}
const lightDir = (angle: number) => { const a = (angle * Math.PI) / 180; return { x: -Math.cos(a), y: Math.sin(a) }; };
const angleOf = (c: Ctx, e: LayerEffect) => (e.useGlobal ? globalLight(c.doc).angle : e.angle);

// ------------------------------------------------------------------ effects
function dropShadow(c: Ctx, e: LayerEffect): HTMLCanvasElement {
  const dil = (e.size * e.spread) / 100;
  let m = dilated(c, dil);
  blur(m, c.W, c.H, e.size - dil);
  const lut = contourLUT(e.contour);
  if (e.contour !== 'linear') for (let i = 0; i < m.length; i++) m[i] = applyContour(m[i], lut);
  const d = lightDir(angleOf(c, e));
  m = shifted(m, c.W, c.H, d.x * e.distance, d.y * e.distance);
  if (e.knockout) { const out = new Float32Array(m.length); for (let i = 0; i < m.length; i++) out[i] = m[i] * (1 - c.A[i]); m = out; }
  return colored(c, m, e.color, e.opacity, e.noise);
}
function innerShadow(c: Ctx, e: LayerEffect): HTMLCanvasElement {
  const dil = (e.size * e.choke) / 100;
  // inverse shape, choked (grown into the layer), blurred and offset
  const s = sdfOf(c);
  let m: Mask = new Float32Array(s.length);
  for (let i = 0; i < m.length; i++) m[i] = clamp01(0.5 + dil + s[i]);
  blur(m, c.W, c.H, e.size - dil);
  const lut = contourLUT(e.contour);
  if (e.contour !== 'linear') for (let i = 0; i < m.length; i++) m[i] = applyContour(m[i], lut);
  const d = lightDir(angleOf(c, e));
  m = shifted(m, c.W, c.H, d.x * e.distance, d.y * e.distance, 1);
  for (let i = 0; i < m.length; i++) m[i] *= c.A[i];
  return colored(c, m, e.color, e.opacity, e.noise);
}
function glowMask(c: Ctx, e: LayerEffect, inner: boolean): Mask {
  const s = sdfOf(c), size = Math.max(0.5, e.size), spread = (inner ? e.choke : e.spread) / 100;
  const m = new Float32Array(s.length);
  if (e.technique === 'precise') {
    for (let i = 0; i < m.length; i++) {
      const dist = inner ? -s[i] : s[i];
      m[i] = dist <= 0 ? (inner ? 0 : 1) : clamp01(1 - (dist - size * spread) / (size * (1 - spread) || 1));
    }
    if (inner) for (let i = 0; i < m.length; i++) m[i] = c.A[i] > 0 ? clamp01(1 - (-s[i] - size * spread) / (size * (1 - spread) || 1)) : 0;
  } else {
    const dil = size * spread;
    for (let i = 0; i < m.length; i++) m[i] = inner ? clamp01(0.5 + dil + s[i]) : clamp01(0.5 + dil - s[i]);
    blur(m, c.W, c.H, size - dil);
  }
  // range: how much of the falloff the contour covers (50% = neutral)
  const g = 50 / Math.max(1, e.range ?? 50), lut = contourLUT(e.contour);
  for (let i = 0; i < m.length; i++) { let v = m[i]; if (g !== 1) v = Math.pow(v, g); m[i] = e.contour !== 'linear' ? applyContour(v, lut) : v; }
  if (inner) {
    if (e.source === 'center') for (let i = 0; i < m.length; i++) m[i] = (1 - m[i]) * c.A[i];
    else for (let i = 0; i < m.length; i++) m[i] *= c.A[i];
  }
  return m;
}
function glow(c: Ctx, e: LayerEffect, inner: boolean): HTMLCanvasElement {
  const m = glowMask(c, e, inner);
  return e.fill === 'gradient' ? gradientByValue(c, m, e, e.opacity) : colored(c, m, e.color, e.opacity, e.noise);
}
function satin(c: Ctx, e: LayerEffect): HTMLCanvasElement {
  const a = (e.angle * Math.PI) / 180, dx = Math.cos(a) * e.distance, dy = -Math.sin(a) * e.distance;
  const m1 = shifted(c.A, c.W, c.H, dx, dy).slice(), m2 = shifted(c.A, c.W, c.H, -dx, -dy).slice();
  blur(m1, c.W, c.H, e.size); blur(m2, c.W, c.H, e.size);
  const lut = contourLUT(e.contour, e.invert), m = new Float32Array(m1.length);
  for (let i = 0; i < m.length; i++) m[i] = applyContour(Math.abs(m1[i] - m2[i]), lut) * c.A[i];
  return colored(c, m, e.color, e.opacity);
}
function overlayColor(c: Ctx, e: LayerEffect): HTMLCanvasElement { return colored(c, c.A, e.color, e.opacity); }
/** Gradient image over the work area for an angle / style / scale relative to a box. */
function gradientImage(c: Ctx, gr: any, style: GradientShape, angle: number, scale: number, reverse: boolean, dither: boolean, box: { x: number; y: number; w: number; h: number }, off = { x: 0, y: 0 }): ImageData {
  const a = (angle * Math.PI) / 180, dir = { x: Math.cos(a), y: -Math.sin(a) };
  const cx = box.x + box.w / 2 + (off.x * box.w) / 100, cy = box.y + box.h / 2 + (off.y * box.h) / 100;
  const half = ((Math.abs(box.w * dir.x) + Math.abs(box.h * dir.y)) / 2) * (scale / 100) || 1;
  const radial = style === 'radial' || style === 'diamond' || style === 'angle';
  const p0 = radial ? { x: cx, y: cy } : { x: cx - dir.x * half, y: cy - dir.y * half };
  const p1 = radial ? { x: cx + dir.x * half, y: cy + dir.y * half } : style === 'reflected' ? { x: cx + dir.x * half, y: cy + dir.y * half } : { x: cx + dir.x * half, y: cy + dir.y * half };
  const p0r = style === 'reflected' ? { x: cx, y: cy } : p0;
  return renderGradient(c.W, c.H, resolveGradient(gr), style, p0r, p1, { reverse, dither, ox: c.R.x, oy: c.R.y });
}
function maskImage(c: Ctx, img: ImageData, m: Mask, opacity: number): HTMLCanvasElement {
  const d = img.data, k = opacity / 100;
  for (let i = 0, j = 3; i < m.length; i++, j += 4) d[j] = d[j] * m[i] * k;
  const cv = createCanvas(c.W, c.H); ctx2d(cv).putImageData(img, 0, 0);
  return cv;
}
function overlayGradient(c: Ctx, e: LayerEffect): HTMLCanvasElement {
  const box = e.align ? c.bounds : { x: 0, y: 0, w: c.doc.width, h: c.doc.height };
  const img = gradientImage(c, e.gradient, e.style, e.angle, e.scale, e.reverse, e.dither, box, { x: e.offsetX || 0, y: e.offsetY || 0 });
  return maskImage(c, img, c.A, e.opacity);
}
function patternFill(c: Ctx, patId: string, scale: number, link: boolean, ox = 0, oy = 0): ImageData | null {
  const pat = resources.patterns.find(p => p.id === patId) || resources.patterns[0];
  if (!pat) return null;
  const cv = createCanvas(c.W, c.H), x = ctx2d(cv);
  const p = x.createPattern(pat.canvas, 'repeat')!;
  const origin = link ? { x: c.bounds.x, y: c.bounds.y } : { x: 0, y: 0 };
  p.setTransform(new DOMMatrix().translate(origin.x - c.R.x + ox, origin.y - c.R.y + oy).scale(scale / 100, scale / 100));
  x.fillStyle = p; x.fillRect(0, 0, c.W, c.H);
  return x.getImageData(0, 0, c.W, c.H);
}
function overlayPattern(c: Ctx, e: LayerEffect): HTMLCanvasElement | null {
  const img = patternFill(c, e.pattern, e.scale, e.link, e.offsetX || 0, e.offsetY || 0);
  return img ? maskImage(c, img, c.A, e.opacity) : null;
}
function stroke(c: Ctx, e: LayerEffect): HTMLCanvasElement | null {
  const s = sdfOf(c), size = Math.max(0.5, e.size), m = new Float32Array(s.length);
  for (let i = 0; i < m.length; i++) {
    const d = s[i];
    if (e.position === 'outside') m[i] = clamp01(0.5 + size - d) * (1 - c.A[i]);
    else if (e.position === 'inside') m[i] = clamp01(0.5 + size + d) * c.A[i];
    else m[i] = clamp01(0.5 + size / 2 - Math.abs(d));
  }
  if (e.fill === 'gradient') {
    const style: GradientShape = e.gradientStyle === 'shape' ? 'linear' : e.gradientStyle;
    if (e.gradientStyle === 'shape') {
      // shape burst: gradient along the distance from the edge
      const lut = gradientLUT(resolveGradient(e.gradient), !!e.reverse, 256);
      return toCanvas(c.W, c.H, (i, d, j) => {
        if (m[i] <= 0) return;
        const t = clamp01((e.position === 'inside' ? -s[i] : e.position === 'outside' ? s[i] : s[i] + size / 2) / size);
        const q = Math.round(t * 255) * 4;
        d[j] = lut[q]; d[j + 1] = lut[q + 1]; d[j + 2] = lut[q + 2]; d[j + 3] = m[i] * lut[q + 3] * (e.opacity / 100);
      });
    }
    const img = gradientImage(c, e.gradient, style, e.gradientAngle, e.gradientScale, !!e.reverse, false, c.bounds);
    return maskImage(c, img, m, e.opacity);
  }
  if (e.fill === 'pattern') { const img = patternFill(c, e.pattern, e.patternScale, true); return img ? maskImage(c, img, m, e.opacity) : null; }
  return colored(c, m, e.color, e.opacity);
}
function bevel(c: Ctx, e: LayerEffect): [HTMLCanvasElement, HTMLCanvasElement] {
  const s = sdfOf(c), W = c.W, H = c.H, size = Math.max(1, e.size);
  const hgt = new Float32Array(s.length);
  const ramp = (v: number) => (e.technique === 'smooth' ? v * v * (3 - 2 * v) : v);
  for (let i = 0; i < s.length; i++) {
    const d = s[i];
    switch (e.style) {
      case 'outer': hgt[i] = d <= 0 ? 1 : ramp(clamp01(1 - d / size)); break;
      case 'emboss': case 'stroke': hgt[i] = ramp(clamp01(0.5 - d / (2 * size))); break;
      case 'pillow': hgt[i] = ramp(clamp01(Math.abs(d) / size)); break;          // groove along the edge
      default: hgt[i] = d >= 0 ? 0 : ramp(clamp01(-d / size));                    // inner
    }
  }
  if (e.technique === 'smooth') blur(hgt, W, H, Math.max(1, size / 3));
  else if (e.technique === 'chisel-soft') blur(hgt, W, H, 1.2);
  if (e.contourOn) { const lut = contourLUT(e.contour); for (let i = 0; i < hgt.length; i++) hgt[i] = applyContour(clamp01(hgt[i]), lut); }
  if (e.textureOn) {
    const tex = patternFill(c, e.pattern, e.textureScale, true);
    if (tex) { const td = tex.data, k = (e.textureDepth / 100) * 0.35 * (e.textureInvert ? -1 : 1); for (let i = 0, j = 0; i < hgt.length; i++, j += 4) hgt[i] += ((td[j] * 0.3 + td[j + 1] * 0.59 + td[j + 2] * 0.11) / 255 - 0.5) * k * c.A[i]; }
  }
  const dir = e.direction === 'down' ? -1 : 1;
  const zs = size * (e.depth / 100) * dir;
  const gl = globalLight(c.doc);
  const ang = ((e.useGlobal ? gl.angle : e.angle) * Math.PI) / 180, alt = ((e.useGlobal ? gl.altitude : e.altitude) * Math.PI) / 180;
  const L = { x: Math.cos(alt) * Math.cos(ang), y: -Math.cos(alt) * Math.sin(ang), z: Math.sin(alt) };   // towards the light
  const shade = new Float32Array(s.length);
  const gloss = contourLUT(e.gloss);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x;
    const gx = (hgt[y * W + Math.min(W - 1, x + 1)] - hgt[y * W + Math.max(0, x - 1)]) * 0.5 * zs;
    const gy = (hgt[Math.min(H - 1, y + 1) * W + x] - hgt[Math.max(0, y - 1) * W + x]) * 0.5 * zs;
    const nl = Math.hypot(gx, gy, 1);
    const dot = (-gx * L.x - gy * L.y + L.z) / nl;
    let v = dot - L.z;                                   // relative to a flat surface
    if (e.gloss !== 'linear') v = applyContour(clamp01(v * 0.5 + 0.5), gloss) * 2 - 1;
    shade[i] = v;
  }
  if (e.soften > 0) blur(shade, W, H, e.soften);
  // where the bevel is visible
  const region = (i: number) => e.style === 'inner' ? c.A[i] : e.style === 'outer' ? 1 - c.A[i] : clamp01(1.5 - Math.abs(s[i]) / size);
  const k = 2.2;
  const hi = toCanvas(W, H, (i, d, j) => { const v = shade[i] * k; if (v <= 0) return; d[j] = e.hiColor.r; d[j + 1] = e.hiColor.g; d[j + 2] = e.hiColor.b; d[j + 3] = clamp01(v) * region(i) * (e.hiOpacity / 100) * 255; });
  const sh = toCanvas(W, H, (i, d, j) => { const v = -shade[i] * k; if (v <= 0) return; d[j] = e.shColor.r; d[j + 1] = e.shColor.g; d[j + 2] = e.shColor.b; d[j + 3] = clamp01(v) * region(i) * (e.shOpacity / 100) * 255; });
  return [hi, sh];
}

// ------------------------------------------------------------------ renderer
const STACK: string[] = ['dropShadow', 'outerGlow', 'CONTENT', 'patternOverlay', 'gradientOverlay', 'colorOverlay', 'satin', 'innerGlow', 'innerShadow', 'stroke', 'bevelEmboss'];

export function renderEffects(layer: Layer, content: LayerContent, doc: PixDocument): LayerContent | null {
  const fx = layer.effects.filter(e => e.enabled).map(normEffect);
  if (!fx.length) return null;
  const key = [(layer as any).blendInterior ? 1 : 0, layer._version, pixelGen.get(layer) || 0, cid(content.canvas), content.x, content.y, content.canvas.width, content.canvas.height, layer.fillOpacity, JSON.stringify(fx), JSON.stringify(globalLight(doc))].join('|');
  const hit = cache.get(layer);
  if (hit && hit.key === key) return hit.res;
  const b = alphaBounds(content.canvas);
  if (!b) return null;
  const pad = Math.ceil(Math.max(2, ...fx.map(extent)));
  const R = { x: content.x + b.x - pad, y: content.y + b.y - pad };
  const W = b.w + 2 * pad, H = b.h + 2 * pad;
  if (W * H > 40e6) return null;                               // guard absurd sizes
  const base = createCanvas(W, H), bx = ctx2d(base);
  bx.drawImage(content.canvas, content.x - R.x, content.y - R.y);
  const ad = bx.getImageData(0, 0, W, H).data, A = new Float32Array(W * H);
  for (let i = 0, j = 3; i < A.length; i++, j += 4) A[i] = ad[j] / 255;
  const c: Ctx = { W, H, A, sdf: null, R, doc, bounds: { x: content.x + b.x, y: content.y + b.y, w: b.w, h: b.h } };
  const out = createCanvas(W, H), mainX = ctx2d(out);
  // Blend Interior Effects as Group: content + interior effects share the Fill opacity
  const interior = !!(layer as any).blendInterior && layer.fillOpacity < 1;
  const inner = interior ? createCanvas(W, H) : null;
  let ox = mainX;
  for (const step of STACK) {
    if (step === 'CONTENT') {
      if (inner) { ox = ctx2d(inner); ox.drawImage(base, 0, 0); }
      else { ox.globalAlpha = layer.fillOpacity; ox.drawImage(base, 0, 0); ox.globalAlpha = 1; }
      continue;
    }
    if (inner && step === 'stroke') { mainX.globalAlpha = layer.fillOpacity; mainX.drawImage(inner, 0, 0); mainX.globalAlpha = 1; ox = mainX; }
    for (const e of fx.filter(f => f.type === step)) {
      try {
        switch (e.type) {
          case 'dropShadow': draw(ox, dropShadow(c, e), e.mode); break;
          case 'outerGlow': draw(ox, glow(c, e, false), e.mode); break;
          case 'innerShadow': draw(ox, innerShadow(c, e), e.mode); break;
          case 'innerGlow': draw(ox, glow(c, e, true), e.mode); break;
          case 'satin': draw(ox, satin(c, e), e.mode); break;
          case 'colorOverlay': draw(ox, overlayColor(c, e), e.mode); break;
          case 'gradientOverlay': draw(ox, overlayGradient(c, e), e.mode); break;
          case 'patternOverlay': { const p = overlayPattern(c, e); if (p) draw(ox, p, e.mode); break; }
          case 'stroke': { const p = stroke(c, e); if (p) draw(ox, p, e.mode); break; }
          case 'bevelEmboss': { const [hi, sh] = bevel(c, e); draw(ox, sh, e.shMode); draw(ox, hi, e.hiMode); break; }
        }
      } catch (err) { console.error('[effects]', e.type, err); }
    }
  }
  const res = { canvas: out, x: R.x, y: R.y };
  cache.set(layer, { key, res });
  return res;
}

hooks.effectsRenderer = renderEffects;
