// Layer style math: alpha masks, Euclidean distance transforms (Felzenszwalb), gaussian-like blurs (3× box),
// contours, noise, and effect defaults / presets shared by the renderer, the Layer Style dialog and the Styles panel.
import type { EffectType, Gradient, LayerEffect, RGB } from '../core/types';

// ------------------------------------------------------------------ distance transform
const INF = 1e20;
function edt1d(f: Float64Array, n: number, d: Float64Array, v: Int32Array, z: Float64Array) {
  let k = 0;
  v[0] = 0; z[0] = -INF; z[1] = INF;
  for (let q = 1; q < n; q++) {
    let s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    while (s <= z[k]) { k--; s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]); }
    k++; v[k] = q; z[k] = s; z[k + 1] = INF;
  }
  k = 0;
  for (let q = 0; q < n; q++) { while (z[k + 1] < q) k++; const dq = q - v[k]; d[q] = dq * dq + f[v[k]]; }
}
/** Euclidean distance (px) from every pixel to the nearest pixel where on[i] is true. */
export function distanceTo(on: Uint8Array, w: number, h: number): Float32Array {
  const n = Math.max(w, h), f = new Float64Array(n), d = new Float64Array(n), v = new Int32Array(n), z = new Float64Array(n + 1);
  const g = new Float64Array(w * h);
  for (let i = 0; i < w * h; i++) g[i] = on[i] ? 0 : INF;
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) f[y] = g[y * w + x];
    edt1d(f, h, d, v, z);
    for (let y = 0; y < h; y++) g[y * w + x] = d[y];
  }
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const o = y * w;
    for (let x = 0; x < w; x++) f[x] = g[o + x];
    edt1d(f, w, d, v, z);
    for (let x = 0; x < w; x++) out[o + x] = Math.sqrt(d[x]);
  }
  return out;
}
/**
 * Signed distance to the shape edge (negative inside), anti-aliased from the alpha coverage:
 * edge pixels use 0.5 − alpha as sub-pixel offset.
 */
export function signedDistance(a: Uint8Array, w: number, h: number): Float32Array {
  const inside = new Uint8Array(w * h), outside = new Uint8Array(w * h);
  for (let i = 0; i < a.length; i++) { if (a[i] >= 128) inside[i] = 1; else outside[i] = 1; }
  const dIn = distanceTo(inside, w, h), dOut = distanceTo(outside, w, h);
  const s = new Float32Array(w * h);
  for (let i = 0; i < s.length; i++) {
    const al = a[i] / 255;
    if (al > 0 && al < 1) s[i] = 0.5 - al;
    else s[i] = inside[i] ? -(dOut[i] - 0.5) : dIn[i] - 0.5;
  }
  return s;
}

// ------------------------------------------------------------------ blur
function boxPass(src: Float32Array, dst: Float32Array, w: number, h: number, r: number, horiz: boolean) {
  const len = horiz ? w : h, lines = horiz ? h : w, step = horiz ? 1 : w;
  const inv = 1 / (2 * r + 1);
  for (let l = 0; l < lines; l++) {
    const base = horiz ? l * w : l;
    let acc = 0;
    for (let i = -r; i <= r; i++) acc += src[base + Math.min(len - 1, Math.max(0, i)) * step];
    for (let i = 0; i < len; i++) {
      dst[base + i * step] = acc * inv;
      const add = Math.min(len - 1, i + r + 1), rem = Math.max(0, i - r);
      acc += src[base + add * step] - src[base + rem * step];
    }
  }
}
/** Gaussian approximation (three box passes) with the given radius (≈ 2.5σ). In place. */
export function blur(a: Float32Array, w: number, h: number, radius: number) {
  if (radius < 0.5) return;
  const sigma = radius / 2.5;
  // box sizes for 3 passes (Kovesi)
  const wIdeal = Math.sqrt((12 * sigma * sigma) / 3 + 1);
  let wl = Math.floor(wIdeal); if (wl % 2 === 0) wl--;
  const wu = wl + 2, m = Math.round((12 * sigma * sigma - 3 * wl * wl - 12 * wl - 9) / (-4 * wl - 4));
  const tmp = new Float32Array(a.length);
  for (let i = 0; i < 3; i++) {
    const r = Math.max(0, ((i < m ? wl : wu) - 1) / 2) | 0;
    if (!r) continue;
    boxPass(a, tmp, w, h, r, true);
    boxPass(tmp, a, w, h, r, false);
  }
}

// ------------------------------------------------------------------ contours
export type ContourId = 'linear' | 'cone' | 'cone-inverted' | 'gaussian' | 'half-round' | 'ring' | 'ring-double' | 'rolling-slope' | 'rounded-steps' | 'sawtooth';
export const CONTOURS: { id: ContourId; label: string; f: (x: number) => number }[] = [
  { id: 'linear', label: 'Linear', f: x => x },
  { id: 'cone', label: 'Cone', f: x => 1 - Math.abs(2 * x - 1) },
  { id: 'cone-inverted', label: 'Cone - Inverted', f: x => Math.abs(2 * x - 1) },
  { id: 'gaussian', label: 'Gaussian', f: x => 0.5 - 0.5 * Math.cos(Math.PI * x) },
  { id: 'half-round', label: 'Half Round', f: x => Math.sqrt(Math.max(0, 1 - (1 - x) * (1 - x))) },
  { id: 'ring', label: 'Ring', f: x => Math.sin(x * Math.PI) },
  { id: 'ring-double', label: 'Ring - Double', f: x => Math.abs(Math.sin(x * Math.PI * 2)) },
  { id: 'rolling-slope', label: 'Rolling Slope - Descending', f: x => (x < 0.6 ? (x / 0.6) * 0.9 : 0.9 + ((x - 0.6) / 0.4) * 0.1) },
  { id: 'rounded-steps', label: 'Rounded Steps', f: x => { const s = Math.floor(x * 4) / 4, t = x * 4 - Math.floor(x * 4); return Math.min(1, s + (0.5 - 0.5 * Math.cos(t * Math.PI)) / 4); } },
  { id: 'sawtooth', label: 'Sawtooth 1', f: x => (x * 3) % 1 },
];
const lutCache = new Map<string, Float32Array>();
export function contourLUT(id: string | undefined, invert = false): Float32Array {
  const key = `${id || 'linear'}${invert ? '!' : ''}`;
  let l = lutCache.get(key);
  if (!l) {
    const f = (CONTOURS.find(c => c.id === id) || CONTOURS[0]).f;
    l = new Float32Array(256);
    for (let i = 0; i < 256; i++) { const v = Math.max(0, Math.min(1, f(i / 255))); l[i] = invert ? 1 - v : v; }
    lutCache.set(key, l);
  }
  return l;
}
export const applyContour = (v: number, lut: Float32Array) => lut[Math.max(0, Math.min(255, Math.round(v * 255)))];

// ------------------------------------------------------------------ defaults
export const BLEND_NATIVE: Record<string, GlobalCompositeOperation> = {
  normal: 'source-over', darken: 'darken', multiply: 'multiply', 'color-burn': 'color-burn', lighten: 'lighten', screen: 'screen',
  'color-dodge': 'color-dodge', overlay: 'overlay', 'soft-light': 'soft-light', 'hard-light': 'hard-light', difference: 'difference',
  exclusion: 'exclusion', hue: 'hue', saturation: 'saturation', color: 'color', luminosity: 'luminosity',
  'linear-dodge': 'lighter', 'linear-burn': 'multiply', 'vivid-light': 'hard-light', 'linear-light': 'hard-light', 'pin-light': 'hard-light',
  'hard-mix': 'hard-light', dissolve: 'source-over', 'darker-color': 'darken', 'lighter-color': 'lighten', subtract: 'difference', divide: 'color-dodge',
};
const black: RGB = { r: 0, g: 0, b: 0 }, white: RGB = { r: 255, g: 255, b: 255 };
const defGrad = (a: RGB, b: RGB): Gradient => ({ name: 'Custom', stops: [{ pos: 0, color: a }, { pos: 1, color: b }], opacityStops: [{ pos: 0, opacity: 1 }, { pos: 1, opacity: 1 }] });

export function defaultEffect(type: EffectType): LayerEffect {
  switch (type) {
    case 'dropShadow': return { type, enabled: true, mode: 'multiply', color: { ...black }, opacity: 35, angle: 120, useGlobal: true, distance: 5, spread: 0, size: 5, contour: 'linear', antiAlias: false, noise: 0, knockout: true };
    case 'innerShadow': return { type, enabled: true, mode: 'multiply', color: { ...black }, opacity: 35, angle: 120, useGlobal: true, distance: 5, choke: 0, size: 5, contour: 'linear', antiAlias: false, noise: 0 };
    case 'outerGlow': return { type, enabled: true, mode: 'screen', opacity: 35, noise: 0, fill: 'color', color: { r: 255, g: 255, b: 190 }, gradient: defGrad({ r: 255, g: 255, b: 190 }, { r: 255, g: 255, b: 190 }), technique: 'softer', spread: 0, size: 5, contour: 'linear', antiAlias: false, range: 50, jitter: 0 };
    case 'innerGlow': return { type, enabled: true, mode: 'screen', opacity: 35, noise: 0, fill: 'color', color: { r: 255, g: 255, b: 190 }, gradient: defGrad({ r: 255, g: 255, b: 190 }, { r: 255, g: 255, b: 190 }), technique: 'softer', source: 'edge', choke: 0, size: 5, contour: 'linear', antiAlias: false, range: 50, jitter: 0 };
    case 'bevelEmboss': return { type, enabled: true, style: 'inner', technique: 'smooth', depth: 100, direction: 'up', size: 5, soften: 0, angle: 120, altitude: 30, useGlobal: true, gloss: 'linear', glossAntiAlias: false, hiMode: 'screen', hiColor: { ...white }, hiOpacity: 50, shMode: 'multiply', shColor: { ...black }, shOpacity: 50, contourOn: false, contour: 'linear', contourRange: 50, textureOn: false, pattern: '', textureScale: 100, textureDepth: 100, textureInvert: false };
    case 'satin': return { type, enabled: true, mode: 'multiply', color: { ...black }, opacity: 50, angle: 19, distance: 11, size: 14, contour: 'gaussian', antiAlias: true, invert: true };
    case 'colorOverlay': return { type, enabled: true, mode: 'normal', color: { r: 255, g: 0, b: 0 }, opacity: 100 };
    case 'gradientOverlay': return { type, enabled: true, mode: 'normal', opacity: 100, gradient: defGrad(black, white), reverse: false, style: 'linear', align: true, angle: 90, scale: 100, dither: false, offsetX: 0, offsetY: 0 };
    case 'patternOverlay': return { type, enabled: true, mode: 'normal', opacity: 100, pattern: '', scale: 100, link: true, offsetX: 0, offsetY: 0 };
    case 'stroke': return { type, enabled: true, size: 3, position: 'outside', mode: 'normal', opacity: 100, fill: 'color', color: { r: 0, g: 0, b: 0 }, gradient: defGrad(black, white), gradientStyle: 'linear', gradientAngle: 90, gradientScale: 100, reverse: false, pattern: '', patternScale: 100 };
  }
}
/** Merge stored effect values onto defaults (older files / presets). */
export const normEffect = (e: LayerEffect): LayerEffect => ({ ...defaultEffect(e.type), ...e });

/** Deterministic noise in [0,1). */
export function noiseAt(i: number): number { let x = (i * 374761393) ^ 0x5bd1e995; x = (x ^ (x >>> 13)) * 1274126177; return ((x ^ (x >>> 16)) >>> 0) / 4294967296; }
