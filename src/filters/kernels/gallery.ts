// Filter Gallery effects (Artistic, Brush Strokes, Distort, Sketch, Stylize, Texture). Metadata + kernels are
// DOM-free so they run in the worker; the 'gallery' kernel applies a stack of effect layers in order.
import { type Kernel, clamp, cloneImage, gaussian, lumaPlane, rng, fbm, vnoise, premul, tap, putAcc, gaussPlane, convolve } from './core';
import { kuwahara } from './noise-pixelate';

export type GParam = { key: string; label: string; min?: number; max?: number; def: any; type?: 'slider' | 'select' | 'check' | 'color'; options?: [string, string][] };
export interface GEffect { id: string; name: string; group: string; params: GParam[]; run: (img: ImageData, p: any, fg: number[], bg: number[], seed: number) => ImageData }

// ------------------------------------------------------------------ primitives
const W_ = (img: ImageData) => img.width, H_ = (img: ImageData) => img.height;
function sobel(L: Float32Array, W: number, H: number): Float32Array {
  const o = new Float32Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const xm = x ? x - 1 : x, xp = x < W - 1 ? x + 1 : x, ym = y ? y - 1 : y, yp = y < H - 1 ? y + 1 : y;
    const gx = L[ym * W + xp] + 2 * L[y * W + xp] + L[yp * W + xp] - L[ym * W + xm] - 2 * L[y * W + xm] - L[yp * W + xm];
    const gy = L[yp * W + xm] + 2 * L[yp * W + x] + L[yp * W + xp] - L[ym * W + xm] - 2 * L[ym * W + x] - L[ym * W + xp];
    o[y * W + x] = Math.hypot(gx, gy) / 4;
  }
  return o;
}
function blurPlane(p: Float32Array, W: number, H: number, s: number) { const c = new Float32Array(p); gaussPlane(c, W, H, s); return c; }
/** Directional blur (strokes). */
function dirBlur(img: ImageData, angleDeg: number, len: number): ImageData {
  if (len < 1) return img;
  const W = img.width, H = img.height, P = premul(img), d = img.data, acc = new Float64Array(4), a = (-angleDeg * Math.PI) / 180, dx = Math.cos(a), dy = Math.sin(a);
  const n = Math.max(2, Math.min(40, Math.ceil(len)));
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    for (let k = 0; k <= n; k++) { const t = (k / n - 0.5) * len; tap(P, W, H, x + 0.5 + dx * t, y + 0.5 + dy * t, acc); }
    putAcc(d, (y * W + x) * 4, acc, n + 1);
  }
  return img;
}
function posterize(img: ImageData, levels: number) {
  const d = img.data, k = 255 / Math.max(1, levels - 1);
  for (let i = 0; i < d.length; i += 4) for (let c = 0; c < 3; c++) d[i + c] = Math.round(d[i + c] / k) * k;
  return img;
}
/** Map a 0..1 value plane to a fg→bg duotone (0 = foreground, 1 = background). */
function duotone(img: ImageData, T: Float32Array, fg: number[], bg: number[]) {
  const d = img.data;
  for (let i = 0; i < T.length; i++) { const t = Math.max(0, Math.min(1, T[i])); d[i * 4] = fg[0] + (bg[0] - fg[0]) * t; d[i * 4 + 1] = fg[1] + (bg[1] - fg[1]) * t; d[i * 4 + 2] = fg[2] + (bg[2] - fg[2]) * t; }
  return img;
}
const LIGHT: Record<string, number> = { bottom: 270, 'bottom-left': 225, left: 180, 'top-left': 135, top: 90, 'top-right': 45, right: 0, 'bottom-right': 315 };
const LIGHT_OPTS: [string, string][] = [['bottom', 'Bottom'], ['bottom-left', 'Bottom Left'], ['left', 'Left'], ['top-left', 'Top Left'], ['top', 'Top'], ['top-right', 'Top Right'], ['right', 'Right'], ['bottom-right', 'Bottom Right']];
/** Procedural height textures (0..1). */
function texture(kind: string, W: number, H: number, scale: number, seed: number): Float32Array {
  const t = new Float32Array(W * H), s = Math.max(0.2, scale / 100);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const X = x / s, Y = y / s;
    let v: number;
    if (kind === 'brick') {
      const bw = 48, bh = 20, row = Math.floor(Y / bh), off = (row % 2) * (bw / 2), bx = ((X + off) % bw + bw) % bw, by = ((Y % bh) + bh) % bh;
      const mortar = Math.min(bx, bw - bx, by * 2.2, (bh - by) * 2.2);
      v = Math.min(1, mortar / 3) * (0.75 + vnoise(X / 6, Y / 6, seed) * 0.25);
    } else if (kind === 'burlap') {
      v = 0.5 + 0.25 * Math.sin(X * 0.9) * Math.sign(Math.sin(Y * 0.45)) + 0.25 * Math.sin(Y * 0.9) * Math.sign(Math.sin(X * 0.45)) + (vnoise(X / 2, Y / 2, seed) - 0.5) * 0.4;
    } else if (kind === 'sandstone') {
      v = fbm(X / 12, Y / 12, seed, 5) * 0.7 + vnoise(X, Y, seed + 3) * 0.3;
    } else if (kind === 'frosted') {
      v = vnoise(X / 1.5, Y / 1.5, seed) * 0.6 + fbm(X / 8, Y / 8, seed + 1, 3) * 0.4;
    } else if (kind === 'lens') {
      const cx = ((X % 14) + 14) % 14 - 7, cy = ((Y % 14) + 14) % 14 - 7; v = Math.max(0, 1 - (cx * cx + cy * cy) / 49);
    } else if (kind === 'blocks') {
      v = (Math.floor(X / 12) + Math.floor(Y / 12)) % 2 ? 0.8 : 0.2;
    } else { // canvas
      v = 0.5 + 0.18 * Math.sin(X * 1.1) * Math.sin(Y * 0.55) + 0.18 * Math.sin(Y * 1.1) * Math.cos(X * 0.55) + (vnoise(X / 3, Y / 3, seed) - 0.5) * 0.3;
    }
    t[y * W + x] = Math.max(0, Math.min(1, v));
  }
  return t;
}
/** Bump-shade the image with a height plane. */
function relief(img: ImageData, Ht: Float32Array, amount: number, light: string, invert = false) {
  const W = img.width, H = img.height, d = img.data, a = ((LIGHT[light] ?? 90) * Math.PI) / 180, lx = Math.cos(a), ly = -Math.sin(a), k = amount * (invert ? -1 : 1);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x, gx = Ht[y * W + Math.min(W - 1, x + 1)] - Ht[y * W + Math.max(0, x - 1)], gy = Ht[Math.min(H - 1, y + 1) * W + x] - Ht[Math.max(0, y - 1) * W + x];
    const sh = 1 + (gx * lx + gy * ly) * k * 0.5;
    d[i * 4] = clamp(d[i * 4] * sh); d[i * 4 + 1] = clamp(d[i * 4 + 1] * sh); d[i * 4 + 2] = clamp(d[i * 4 + 2] * sh);
  }
  return img;
}
function addNoise(img: ImageData, amt: number, seed: number, mono = true) {
  const r = rng(seed), d = img.data;
  for (let i = 0; i < d.length; i += 4) { const n = (r() - 0.5) * amt; if (mono) { d[i] = clamp(d[i] + n); d[i + 1] = clamp(d[i + 1] + n); d[i + 2] = clamp(d[i + 2] + n); } else for (let c = 0; c < 3; c++) d[i + c] = clamp(d[i + c] + (r() - 0.5) * amt); }
  return img;
}
function contrast(img: ImageData, k: number, mid = 128) { const d = img.data; for (let i = 0; i < d.length; i += 4) for (let c = 0; c < 3; c++) d[i + c] = clamp((d[i + c] - mid) * k + mid); return img; }
function saturate(img: ImageData, k: number) { const d = img.data; for (let i = 0; i < d.length; i += 4) { const y = d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114; for (let c = 0; c < 3; c++) d[i + c] = clamp(y + (d[i + c] - y) * k); } return img; }
function strokesPlane(W: number, H: number, len: number, angle: number, seed: number): Float32Array {
  // random stroke field: noise smeared along a direction
  const n = new ImageData(W, H), r = rng(seed), d = n.data;
  for (let i = 0; i < d.length; i += 4) { const v = r() * 255; d[i] = d[i + 1] = d[i + 2] = v; d[i + 3] = 255; }
  dirBlur(n, angle, len);
  const L = lumaPlane(n);
  let mn = 255, mx = 0; for (const v of L) { if (v < mn) mn = v; if (v > mx) mx = v; }
  for (let i = 0; i < L.length; i++) L[i] = (L[i] - mn) / (mx - mn || 1);
  return L;
}
function voronoiEdges(W: number, H: number, cell: number, seed: number): { id: Int32Array; edge: Float32Array; sx: Float32Array; sy: Float32Array } {
  const r = rng(seed), gw = Math.ceil(W / cell) + 1, gh = Math.ceil(H / cell) + 1, sx = new Float32Array(gw * gh), sy = new Float32Array(gw * gh);
  for (let j = 0; j < gh; j++) for (let i = 0; i < gw; i++) { sx[j * gw + i] = (i + r()) * cell; sy[j * gw + i] = (j + r()) * cell; }
  const id = new Int32Array(W * H), edge = new Float32Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const gi = Math.floor(x / cell), gj = Math.floor(y / cell);
    let b1 = Infinity, b2 = Infinity, bi = 0;
    for (let j = gj - 1; j <= gj + 1; j++) for (let i = gi - 1; i <= gi + 1; i++) {
      if (i < 0 || j < 0 || i >= gw || j >= gh) continue;
      const k = j * gw + i, dd = Math.hypot(sx[k] - x - 0.5, sy[k] - y - 0.5);
      if (dd < b1) { b2 = b1; b1 = dd; bi = k; } else if (dd < b2) b2 = dd;
    }
    id[y * W + x] = bi; edge[y * W + x] = (b2 - b1) / 2;     // distance to the cell border
  }
  return { id, edge, sx, sy };
}
const texParams = (def = 'canvas'): GParam[] => [
  { key: 'texture', label: 'Texture', def, type: 'select', options: [['brick', 'Brick'], ['burlap', 'Burlap'], ['canvas', 'Canvas'], ['sandstone', 'Sandstone']] },
  { key: 'scaling', label: 'Scaling', min: 50, max: 200, def: 100 }, { key: 'relief', label: 'Relief', min: 0, max: 50, def: 20 },
  { key: 'light', label: 'Light', def: 'bottom', type: 'select', options: LIGHT_OPTS }, { key: 'invert', label: 'Invert', def: false, type: 'check' },
];
const withTexture = (img: ImageData, p: any, seed: number) => relief(img, texture(p.texture, W_(img), H_(img), p.scaling, seed), p.relief / 30, p.light, p.invert);

// ------------------------------------------------------------------ effects
export const GALLERY: GEffect[] = [
  // ---------------- Artistic
  { id: 'colored-pencil', name: 'Colored Pencil', group: 'Artistic', params: [{ key: 'width', label: 'Pencil Width', min: 1, max: 24, def: 4 }, { key: 'pressure', label: 'Stroke Pressure', min: 0, max: 15, def: 8 }, { key: 'paper', label: 'Paper Brightness', min: 0, max: 50, def: 25 }],
    run(img, p, _f, _b, seed) {
      const W = W_(img), H = H_(img), L = lumaPlane(img), S = strokesPlane(W, H, p.width * 3, 45, seed), d = img.data, paper = 150 + p.paper * 2;
      for (let i = 0; i < L.length; i++) { const dark = 1 - L[i] / 255, cover = S[i] < dark * (0.6 + p.pressure / 25) ? 1 : 0.15; for (let c = 0; c < 3; c++) d[i * 4 + c] = paper + (d[i * 4 + c] * 0.9 - paper) * cover; }
      return img;
    } },
  { id: 'cutout', name: 'Cutout', group: 'Artistic', params: [{ key: 'levels', label: 'Number of Levels', min: 2, max: 8, def: 4 }, { key: 'simplicity', label: 'Edge Simplicity', min: 0, max: 10, def: 4 }, { key: 'fidelity', label: 'Edge Fidelity', min: 1, max: 3, def: 2 }],
    run(img, p) { gaussian(img, p.simplicity * 0.8 + 0.5); kuwahara(img, Math.max(1, 5 - p.fidelity)); return posterize(img, p.levels); } },
  { id: 'dry-brush', name: 'Dry Brush', group: 'Artistic', params: [{ key: 'size', label: 'Brush Size', min: 0, max: 10, def: 2 }, { key: 'detail', label: 'Brush Detail', min: 0, max: 10, def: 8 }, { key: 'texture', label: 'Texture', min: 1, max: 3, def: 1 }],
    run(img, p, _f, _b, seed) { kuwahara(img, p.size + 2); posterize(img, 4 + p.detail * 2); return addNoise(img, p.texture * 14, seed); } },
  { id: 'film-grain', name: 'Film Grain', group: 'Artistic', params: [{ key: 'grain', label: 'Grain', min: 0, max: 20, def: 4 }, { key: 'area', label: 'Highlight Area', min: 0, max: 20, def: 0 }, { key: 'intensity', label: 'Intensity', min: 0, max: 10, def: 10 }],
    run(img, p, _f, _b, seed) {
      addNoise(img, p.grain * 6, seed);
      const d = img.data, thr = 255 - p.area * 8;
      for (let i = 0; i < d.length; i += 4) { const y = d[i] * 0.3 + d[i + 1] * 0.59 + d[i + 2] * 0.11; if (y > thr) { const k = ((y - thr) / (256 - thr)) * (p.intensity / 10) * 60; d[i] = clamp(d[i] + k); d[i + 1] = clamp(d[i + 1] + k); d[i + 2] = clamp(d[i + 2] + k); } }
      return img;
    } },
  { id: 'fresco', name: 'Fresco', group: 'Artistic', params: [{ key: 'size', label: 'Brush Size', min: 0, max: 10, def: 2 }, { key: 'detail', label: 'Brush Detail', min: 0, max: 10, def: 8 }, { key: 'texture', label: 'Texture', min: 1, max: 3, def: 1 }],
    run(img, p, _f, _b, seed) { kuwahara(img, p.size + 2); contrast(img, 1.35 - p.detail * 0.02, 150); return addNoise(img, p.texture * 18, seed); } },
  { id: 'neon-glow', name: 'Neon Glow', group: 'Artistic', params: [{ key: 'size', label: 'Glow Size', min: -24, max: 24, def: 5 }, { key: 'brightness', label: 'Glow Brightness', min: 0, max: 50, def: 15 }, { key: 'color', label: 'Glow Color', def: { r: 40, g: 120, b: 255 }, type: 'color' }],
    run(img, p, fg) {
      const W = W_(img), H = H_(img), L = lumaPlane(img), E = blurPlane(sobel(L, W, H), W, H, Math.abs(p.size) * 0.6 + 0.5), d = img.data, gc = p.color && typeof p.color === 'object' ? [p.color.r, p.color.g, p.color.b] : [40, 120, 255];
      for (let i = 0; i < L.length; i++) { const base = (p.size >= 0 ? L[i] : 255 - L[i]) * 0.55 * (fg[0] + fg[1] + fg[2] > 0 ? 1 : 1); const g = Math.min(1, E[i] / 40) * (p.brightness / 50) * 1.8; for (let c = 0; c < 3; c++) d[i * 4 + c] = clamp(base * 0.6 + gc[c] * g + base * 0.2); }
      return img;
    } },
  { id: 'paint-daubs', name: 'Paint Daubs', group: 'Artistic', params: [{ key: 'size', label: 'Brush Size', min: 1, max: 50, def: 8 }, { key: 'sharpness', label: 'Sharpness', min: 0, max: 40, def: 7 }, { key: 'type', label: 'Brush Type', def: 'simple', type: 'select', options: [['simple', 'Simple'], ['light', 'Light Rough'], ['dark', 'Dark Rough'], ['wide-sharp', 'Wide Sharp'], ['wide-blurry', 'Wide Blurry'], ['sparkle', 'Sparkle']] }],
    run(img, p, _f, _b, seed) {
      kuwahara(img, Math.max(1, Math.round(p.size / 2)));
      if (p.type === 'wide-blurry') gaussian(img, 1.5);
      const sharp = cloneImage(img); gaussian(sharp, 1.2); const d = img.data, s = sharp.data, k = p.sharpness / 12;
      for (let i = 0; i < d.length; i += 4) for (let c = 0; c < 3; c++) d[i + c] = clamp(d[i + c] + (d[i + c] - s[i + c]) * k);
      if (p.type === 'dark') contrast(img, 1.2, 180); if (p.type === 'light') contrast(img, 1.1, 80); if (p.type === 'sparkle') addNoise(img, 30, seed);
      return img;
    } },
  { id: 'palette-knife', name: 'Palette Knife', group: 'Artistic', params: [{ key: 'size', label: 'Stroke Size', min: 1, max: 50, def: 25 }, { key: 'detail', label: 'Stroke Detail', min: 1, max: 3, def: 3 }, { key: 'softness', label: 'Softness', min: 0, max: 10, def: 0 }],
    run(img, p) { kuwahara(img, Math.max(2, Math.round(p.size / 4))); posterize(img, 3 + p.detail * 3); if (p.softness) gaussian(img, p.softness * 0.3); return img; } },
  { id: 'plastic-wrap', name: 'Plastic Wrap', group: 'Artistic', params: [{ key: 'strength', label: 'Highlight Strength', min: 0, max: 20, def: 15 }, { key: 'detail', label: 'Detail', min: 1, max: 15, def: 9 }, { key: 'smoothness', label: 'Smoothness', min: 1, max: 15, def: 7 }],
    run(img, p) {
      const W = W_(img), H = H_(img), L = blurPlane(lumaPlane(img), W, H, p.smoothness * 0.7 + (15 - p.detail) * 0.2), d = img.data;
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const i = y * W + x, gx = L[y * W + Math.min(W - 1, x + 1)] - L[y * W + Math.max(0, x - 1)], gy = L[Math.min(H - 1, y + 1) * W + x] - L[Math.max(0, y - 1) * W + x], sp = Math.pow(Math.max(0, (-gx - gy) / 30), 2) * p.strength * 12; for (let c = 0; c < 3; c++) d[i * 4 + c] = clamp(d[i * 4 + c] * 0.9 + sp); }
      return img;
    } },
  { id: 'poster-edges', name: 'Poster Edges', group: 'Artistic', params: [{ key: 'thickness', label: 'Edge Thickness', min: 0, max: 10, def: 2 }, { key: 'intensity', label: 'Edge Intensity', min: 0, max: 10, def: 1 }, { key: 'posterization', label: 'Posterization', min: 0, max: 6, def: 2 }],
    run(img, p) {
      const W = W_(img), H = H_(img), E = blurPlane(sobel(lumaPlane(img), W, H), W, H, p.thickness * 0.3 + 0.3);
      posterize(img, 2 + p.posterization);
      const d = img.data, k = (p.intensity + 1) / 30;
      for (let i = 0; i < E.length; i++) { const f = Math.max(0, 1 - E[i] * k); d[i * 4] *= f; d[i * 4 + 1] *= f; d[i * 4 + 2] *= f; }
      return img;
    } },
  { id: 'rough-pastels', name: 'Rough Pastels', group: 'Artistic', params: [{ key: 'length', label: 'Stroke Length', min: 0, max: 40, def: 6 }, { key: 'detail', label: 'Stroke Detail', min: 1, max: 20, def: 4 }, ...texParams()],
    run(img, p, _f, _b, seed) { dirBlur(img, 45, p.length); addNoise(img, 40 - p.detail * 1.5, seed); return withTexture(img, p, seed); } },
  { id: 'smudge-stick', name: 'Smudge Stick', group: 'Artistic', params: [{ key: 'length', label: 'Stroke Length', min: 0, max: 10, def: 2 }, { key: 'area', label: 'Highlight Area', min: 0, max: 20, def: 0 }, { key: 'intensity', label: 'Intensity', min: 0, max: 10, def: 10 }],
    run(img, p) {
      dirBlur(img, -45, p.length * 3 + 2); contrast(img, 1.15, 160);
      const d = img.data, thr = 250 - p.area * 8;
      for (let i = 0; i < d.length; i += 4) { const y = d[i] * 0.3 + d[i + 1] * 0.59 + d[i + 2] * 0.11; if (y > thr) { const k = (p.intensity / 10) * 50; for (let c = 0; c < 3; c++) d[i + c] = clamp(d[i + c] + k); } }
      return img;
    } },
  { id: 'sponge', name: 'Sponge', group: 'Artistic', params: [{ key: 'size', label: 'Brush Size', min: 0, max: 10, def: 2 }, { key: 'definition', label: 'Definition', min: 0, max: 25, def: 12 }, { key: 'smoothness', label: 'Smoothness', min: 1, max: 15, def: 5 }],
    run(img, p, _f, _b, seed) {
      kuwahara(img, p.size + 1);
      const W = W_(img), H = H_(img), d = img.data;
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const n = fbm(x / (3 + p.size), y / (3 + p.size), seed, 3), k = 1 - Math.max(0, n - 0.45) * p.definition / 12; const i = (y * W + x) * 4; for (let c = 0; c < 3; c++) d[i + c] = clamp(d[i + c] * k); }
      return gaussian(img, p.smoothness * 0.15);
    } },
  { id: 'underpainting', name: 'Underpainting', group: 'Artistic', params: [{ key: 'size', label: 'Brush Size', min: 0, max: 40, def: 6 }, { key: 'coverage', label: 'Texture Coverage', min: 0, max: 40, def: 16 }, ...texParams()],
    run(img, p, _f, _b, seed) { kuwahara(img, Math.max(1, Math.round(p.size / 3))); gaussian(img, p.size * 0.15); saturate(img, 0.8); return relief(img, texture(p.texture, W_(img), H_(img), p.scaling, seed), (p.relief / 30) * (p.coverage / 20), p.light, p.invert); } },
  { id: 'watercolor', name: 'Watercolor', group: 'Artistic', params: [{ key: 'detail', label: 'Brush Detail', min: 1, max: 14, def: 9 }, { key: 'shadow', label: 'Shadow Intensity', min: 0, max: 10, def: 1 }, { key: 'texture', label: 'Texture', min: 1, max: 3, def: 1 }],
    run(img, p, _f, _b, seed) {
      kuwahara(img, Math.max(1, 15 - p.detail) >> 1 || 1);
      const W = W_(img), H = H_(img), E = sobel(lumaPlane(img), W, H), d = img.data;
      for (let i = 0; i < E.length; i++) { const k = 1 - Math.min(0.6, E[i] / 120) * (0.4 + p.shadow * 0.1); for (let c = 0; c < 3; c++) d[i * 4 + c] = clamp(d[i * 4 + c] * k); }
      saturate(img, 1.25);
      return relief(img, texture('sandstone', W, H, 60, seed), p.texture * 0.4, 'top');
    } },
  // ---------------- Brush Strokes
  { id: 'accented-edges', name: 'Accented Edges', group: 'Brush Strokes', params: [{ key: 'width', label: 'Edge Width', min: 1, max: 14, def: 2 }, { key: 'brightness', label: 'Edge Brightness', min: 0, max: 50, def: 38 }, { key: 'smoothness', label: 'Smoothness', min: 1, max: 15, def: 5 }],
    run(img, p) {
      const W = W_(img), H = H_(img), E = blurPlane(sobel(blurPlane(lumaPlane(img), W, H, p.smoothness * 0.3), W, H), W, H, p.width * 0.3), d = img.data, b = (p.brightness - 25) * 8;
      for (let i = 0; i < E.length; i++) { const k = Math.min(1, E[i] / 25); for (let c = 0; c < 3; c++) d[i * 4 + c] = clamp(d[i * 4 + c] + k * b); }
      return img;
    } },
  { id: 'angled-strokes', name: 'Angled Strokes', group: 'Brush Strokes', params: [{ key: 'balance', label: 'Direction Balance', min: 0, max: 100, def: 50 }, { key: 'length', label: 'Stroke Length', min: 3, max: 50, def: 15 }, { key: 'sharpness', label: 'Sharpness', min: 0, max: 10, def: 3 }],
    run(img, p) {
      const a = dirBlur(cloneImage(img), 45, p.length), b = dirBlur(cloneImage(img), -45, p.length), L = lumaPlane(img), d = img.data, bal = p.balance / 100;
      for (let i = 0; i < L.length; i++) { const t = L[i] / 255 < bal ? 1 : 0; for (let c = 0; c < 3; c++) d[i * 4 + c] = a.data[i * 4 + c] * t + b.data[i * 4 + c] * (1 - t); }
      return contrast(img, 1 + p.sharpness * 0.04);
    } },
  { id: 'crosshatch', name: 'Crosshatch', group: 'Brush Strokes', params: [{ key: 'length', label: 'Stroke Length', min: 3, max: 50, def: 9 }, { key: 'sharpness', label: 'Sharpness', min: 0, max: 20, def: 6 }, { key: 'strength', label: 'Strength', min: 1, max: 3, def: 1 }],
    run(img, p, _f, _b, seed) {
      const W = W_(img), H = H_(img), s1 = strokesPlane(W, H, p.length, 45, seed), s2 = strokesPlane(W, H, p.length, -45, seed + 1), d = img.data;
      for (let i = 0; i < s1.length; i++) { const k = 1 + ((s1[i] - 0.5) + (s2[i] - 0.5)) * 0.35 * p.strength; for (let c = 0; c < 3; c++) d[i * 4 + c] = clamp(d[i * 4 + c] * k); }
      return contrast(img, 1 + p.sharpness * 0.02);
    } },
  { id: 'dark-strokes', name: 'Dark Strokes', group: 'Brush Strokes', params: [{ key: 'balance', label: 'Balance', min: 0, max: 10, def: 5 }, { key: 'black', label: 'Black Intensity', min: 0, max: 10, def: 6 }, { key: 'white', label: 'White Intensity', min: 0, max: 10, def: 2 }],
    run(img, p) {
      const a = dirBlur(cloneImage(img), 45, 6), b = dirBlur(cloneImage(img), -45, 16), L = lumaPlane(img), d = img.data, thr = 255 * (p.balance / 10);
      for (let i = 0; i < L.length; i++) { const dark = L[i] < thr; const src = dark ? a : b, k = dark ? 1 - p.black * 0.07 : 1 + p.white * 0.05; for (let c = 0; c < 3; c++) d[i * 4 + c] = clamp(src.data[i * 4 + c] * k); }
      return img;
    } },
  { id: 'ink-outlines', name: 'Ink Outlines', group: 'Brush Strokes', params: [{ key: 'length', label: 'Stroke Length', min: 1, max: 50, def: 4 }, { key: 'dark', label: 'Dark Intensity', min: 0, max: 50, def: 20 }, { key: 'light', label: 'Light Intensity', min: 0, max: 50, def: 10 }],
    run(img, p) {
      dirBlur(img, -45, p.length);
      const W = W_(img), H = H_(img), L = lumaPlane(img), E = sobel(L, W, H), d = img.data;
      for (let i = 0; i < L.length; i++) { const k = (1 - Math.min(1, (E[i] / 30) * (p.dark / 20))) * (1 + (L[i] > 128 ? p.light * 0.01 : 0)); for (let c = 0; c < 3; c++) d[i * 4 + c] = clamp(d[i * 4 + c] * k); }
      return img;
    } },
  { id: 'spatter', name: 'Spatter', group: 'Brush Strokes', params: [{ key: 'radius', label: 'Spray Radius', min: 0, max: 25, def: 10 }, { key: 'smoothness', label: 'Smoothness', min: 1, max: 15, def: 5 }],
    run(img, p, _f, _b, seed) {
      const W = W_(img), H = H_(img), src = new Uint8ClampedArray(img.data), d = img.data, r = rng(seed), R = p.radius;
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const n = fbm(x / (p.smoothness + 1), y / (p.smoothness + 1), seed, 2); if (n < 0.45) continue; const sx = Math.min(W - 1, Math.max(0, x + Math.round((r() - 0.5) * R * 2))), sy = Math.min(H - 1, Math.max(0, y + Math.round((r() - 0.5) * R * 2))); const i = (y * W + x) * 4, j = (sy * W + sx) * 4; d[i] = src[j]; d[i + 1] = src[j + 1]; d[i + 2] = src[j + 2]; }
      return img;
    } },
  { id: 'sprayed-strokes', name: 'Sprayed Strokes', group: 'Brush Strokes', params: [{ key: 'length', label: 'Stroke Length', min: 0, max: 20, def: 12 }, { key: 'radius', label: 'Spray Radius', min: 0, max: 25, def: 7 }, { key: 'dir', label: 'Stroke Direction', def: 'right', type: 'select', options: [['right', 'Right Diagonal'], ['horizontal', 'Horizontal'], ['left', 'Left Diagonal'], ['vertical', 'Vertical']] }],
    run(img, p, _f, _b, seed) {
      const W = W_(img), H = H_(img), src = new Uint8ClampedArray(img.data), d = img.data, r = rng(seed);
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { if (r() < 0.5) continue; const sx = Math.min(W - 1, Math.max(0, x + Math.round((r() - 0.5) * p.radius))), sy = Math.min(H - 1, Math.max(0, y + Math.round((r() - 0.5) * p.radius))); const i = (y * W + x) * 4, j = (sy * W + sx) * 4; d[i] = src[j]; d[i + 1] = src[j + 1]; d[i + 2] = src[j + 2]; }
      return dirBlur(img, p.dir === 'horizontal' ? 0 : p.dir === 'vertical' ? 90 : p.dir === 'left' ? -45 : 45, p.length);
    } },
  { id: 'sumi-e', name: 'Sumi-e', group: 'Brush Strokes', params: [{ key: 'width', label: 'Stroke Width', min: 3, max: 15, def: 10 }, { key: 'pressure', label: 'Stroke Pressure', min: 0, max: 15, def: 2 }, { key: 'contrast', label: 'Contrast', min: 0, max: 40, def: 16 }],
    run(img, p) { kuwahara(img, Math.max(1, Math.round(p.width / 3))); dirBlur(img, 45, p.width * 0.6); saturate(img, 0.6); contrast(img, 1 + p.contrast * 0.03, 140 + p.pressure * 4); return img; } },
  // ---------------- Distort
  { id: 'diffuse-glow', name: 'Diffuse Glow', group: 'Distort', params: [{ key: 'grain', label: 'Graininess', min: 0, max: 10, def: 6 }, { key: 'glow', label: 'Glow Amount', min: 0, max: 20, def: 10 }, { key: 'clear', label: 'Clear Amount', min: 0, max: 20, def: 15 }],
    run(img, p, _f, bg, seed) {
      const d = img.data, r = rng(seed), thr = 255 - p.glow * 9 + p.clear * 3;
      for (let i = 0; i < d.length; i += 4) { const y = d[i] * 0.3 + d[i + 1] * 0.59 + d[i + 2] * 0.11, t = Math.max(0, Math.min(1, (y - thr) / 90)), g = t * (r() < p.grain / 12 ? 0.3 : 1); for (let c = 0; c < 3; c++) d[i + c] = clamp(d[i + c] + (bg[c] - d[i + c]) * g); }
      return img;
    } },
  { id: 'glass', name: 'Glass', group: 'Distort', params: [{ key: 'distortion', label: 'Distortion', min: 0, max: 20, def: 5 }, { key: 'smoothness', label: 'Smoothness', min: 1, max: 15, def: 3 }, { key: 'texture', label: 'Texture', def: 'frosted', type: 'select', options: [['blocks', 'Blocks'], ['canvas', 'Canvas'], ['frosted', 'Frosted'], ['lens', 'Tiny Lens']] }, { key: 'scaling', label: 'Scaling', min: 50, max: 200, def: 100 }, { key: 'invert', label: 'Invert', def: false, type: 'check' }],
    run(img, p, _f, _b, seed) {
      const W = W_(img), H = H_(img), T = blurPlane(texture(p.texture, W, H, p.scaling, seed), W, H, p.smoothness * 0.4), P = premul(img), d = img.data, acc = new Float64Array(4), k = p.distortion * 1.5 * (p.invert ? -1 : 1);
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const gx = T[y * W + Math.min(W - 1, x + 1)] - T[y * W + Math.max(0, x - 1)], gy = T[Math.min(H - 1, y + 1) * W + x] - T[Math.max(0, y - 1) * W + x]; tap(P, W, H, x + 0.5 + gx * k * 4, y + 0.5 + gy * k * 4, acc); putAcc(d, (y * W + x) * 4, acc, 1); }
      return img;
    } },
  { id: 'ocean-ripple', name: 'Ocean Ripple', group: 'Distort', params: [{ key: 'size', label: 'Ripple Size', min: 1, max: 15, def: 9 }, { key: 'magnitude', label: 'Ripple Magnitude', min: 0, max: 20, def: 9 }],
    run(img, p, _f, _b, seed) {
      const W = W_(img), H = H_(img), P = premul(img), d = img.data, acc = new Float64Array(4), s = p.size * 1.6;
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const dx = (vnoise(x / s, y / s, seed) - 0.5) * p.magnitude * 1.5, dy = (vnoise(x / s, y / s, seed + 5) - 0.5) * p.magnitude * 1.5; tap(P, W, H, x + 0.5 + dx, y + 0.5 + dy, acc); putAcc(d, (y * W + x) * 4, acc, 1); }
      return img;
    } },
  // ---------------- Sketch (foreground / background colours)
  { id: 'bas-relief', name: 'Bas Relief', group: 'Sketch', params: [{ key: 'detail', label: 'Detail', min: 1, max: 15, def: 13 }, { key: 'smoothness', label: 'Smoothness', min: 1, max: 15, def: 3 }, { key: 'light', label: 'Light', def: 'bottom', type: 'select', options: LIGHT_OPTS }],
    run(img, p, fg, bg) {
      const W = W_(img), H = H_(img), L = blurPlane(lumaPlane(img), W, H, p.smoothness * 0.4), a = ((LIGHT[p.light] ?? 270) * Math.PI) / 180, T = new Float32Array(W * H), k = p.detail / 25;
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const gx = L[y * W + Math.min(W - 1, x + 1)] - L[y * W + Math.max(0, x - 1)], gy = L[Math.min(H - 1, y + 1) * W + x] - L[Math.max(0, y - 1) * W + x]; T[y * W + x] = 0.5 + (gx * Math.cos(a) - gy * Math.sin(a)) * k / 30; }
      return duotone(img, T, fg, bg);
    } },
  { id: 'chalk-charcoal', name: 'Chalk & Charcoal', group: 'Sketch', params: [{ key: 'charcoal', label: 'Charcoal Area', min: 0, max: 20, def: 6 }, { key: 'chalk', label: 'Chalk Area', min: 0, max: 20, def: 6 }, { key: 'pressure', label: 'Stroke Pressure', min: 0, max: 5, def: 1 }],
    run(img, p, fg, bg, seed) {
      const W = W_(img), H = H_(img), L = lumaPlane(img), S1 = strokesPlane(W, H, 10, 45, seed), S2 = strokesPlane(W, H, 10, -45, seed + 2), d = img.data;
      for (let i = 0; i < L.length; i++) { const v = L[i] / 255; let col = [128, 128, 128]; if (v < 0.3 + p.charcoal * 0.02 && S1[i] > 0.45 - p.pressure * 0.05) col = fg; else if (v > 0.7 - p.chalk * 0.02 && S2[i] > 0.45 - p.pressure * 0.05) col = bg; d[i * 4] = col[0]; d[i * 4 + 1] = col[1]; d[i * 4 + 2] = col[2]; }
      return img;
    } },
  { id: 'charcoal', name: 'Charcoal', group: 'Sketch', params: [{ key: 'thickness', label: 'Charcoal Thickness', min: 1, max: 7, def: 1 }, { key: 'detail', label: 'Detail', min: 0, max: 5, def: 5 }, { key: 'balance', label: 'Light/Dark Balance', min: 0, max: 100, def: 50 }],
    run(img, p, fg, bg, seed) {
      const W = W_(img), H = H_(img), L = blurPlane(lumaPlane(img), W, H, (5 - p.detail) * 0.4), S = strokesPlane(W, H, 6 + p.thickness * 3, 45, seed), T = new Float32Array(W * H);
      for (let i = 0; i < L.length; i++) T[i] = L[i] / 255 + (S[i] - 0.5) * 0.6 > p.balance / 100 ? 1 : 0;
      return duotone(img, T, fg, bg);
    } },
  { id: 'chrome', name: 'Chrome', group: 'Sketch', params: [{ key: 'detail', label: 'Detail', min: 0, max: 10, def: 4 }, { key: 'smoothness', label: 'Smoothness', min: 0, max: 10, def: 7 }],
    run(img, p) {
      const W = W_(img), H = H_(img), L = blurPlane(lumaPlane(img), W, H, p.smoothness * 0.6 + 0.5), d = img.data;
      for (let i = 0; i < L.length; i++) { const v = clamp(128 + 127 * Math.sin((L[i] / 255) * Math.PI * (2 + p.detail * 0.4))); d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = v; }
      return img;
    } },
  { id: 'conte-crayon', name: 'Conté Crayon', group: 'Sketch', params: [{ key: 'fgLevel', label: 'Foreground Level', min: 1, max: 15, def: 11 }, { key: 'bgLevel', label: 'Background Level', min: 1, max: 15, def: 7 }, ...texParams()],
    run(img, p, fg, bg, seed) {
      const W = W_(img), H = H_(img), L = lumaPlane(img), T = new Float32Array(W * H), mid = (p.fgLevel - p.bgLevel) / 30 + 0.5;
      for (let i = 0; i < L.length; i++) T[i] = Math.max(0, Math.min(1, (L[i] / 255 - mid) * 2.2 + 0.5));
      duotone(img, T, fg, bg);
      return withTexture(img, p, seed);
    } },
  { id: 'graphic-pen', name: 'Graphic Pen', group: 'Sketch', params: [{ key: 'length', label: 'Stroke Length', min: 1, max: 15, def: 15 }, { key: 'balance', label: 'Light/Dark Balance', min: 0, max: 100, def: 50 }, { key: 'dir', label: 'Stroke Direction', def: 'right', type: 'select', options: [['right', 'Right Diagonal'], ['horizontal', 'Horizontal'], ['left', 'Left Diagonal'], ['vertical', 'Vertical']] }],
    run(img, p, fg, bg, seed) {
      const W = W_(img), H = H_(img), L = lumaPlane(img), S = strokesPlane(W, H, p.length * 2, p.dir === 'horizontal' ? 0 : p.dir === 'vertical' ? 90 : p.dir === 'left' ? -45 : 45, seed), T = new Float32Array(W * H);
      for (let i = 0; i < L.length; i++) T[i] = S[i] < L[i] / 255 * (p.balance / 50) ? 1 : 0;
      return duotone(img, T, fg, bg);
    } },
  { id: 'halftone-pattern', name: 'Halftone Pattern', group: 'Sketch', params: [{ key: 'size', label: 'Size', min: 1, max: 12, def: 1 }, { key: 'contrast', label: 'Contrast', min: 0, max: 50, def: 5 }, { key: 'type', label: 'Pattern Type', def: 'dot', type: 'select', options: [['circle', 'Circle'], ['dot', 'Dot'], ['line', 'Line']] }],
    run(img, p, fg, bg) {
      const W = W_(img), H = H_(img), L = lumaPlane(img), T = new Float32Array(W * H), cell = 3 + p.size * 2, k = 1 + p.contrast / 10;
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const i = y * W + x, v = Math.max(0, Math.min(1, (L[i] / 255 - 0.5) * k + 0.5));
        let s: number;
        if (p.type === 'line') s = Math.abs(((y % cell) / cell) - 0.5) * 2;
        else if (p.type === 'circle') { const r = Math.hypot(x - W / 2, y - H / 2); s = Math.abs(((r % cell) / cell) - 0.5) * 2; }
        else { const cx = (x % cell) / cell - 0.5, cy = (y % cell) / cell - 0.5; s = Math.hypot(cx, cy) * 1.41; }
        T[i] = s < 1 - v ? 0 : 1;
      }
      return duotone(img, T, fg, bg);
    } },
  { id: 'note-paper', name: 'Note Paper', group: 'Sketch', params: [{ key: 'balance', label: 'Image Balance', min: 0, max: 50, def: 25 }, { key: 'grain', label: 'Graininess', min: 0, max: 20, def: 10 }, { key: 'relief', label: 'Relief', min: 0, max: 25, def: 11 }],
    run(img, p, fg, bg, seed) {
      const W = W_(img), H = H_(img), L = blurPlane(lumaPlane(img), W, H, 1), T = new Float32Array(W * H);
      for (let i = 0; i < L.length; i++) T[i] = L[i] / 255 > p.balance / 50 ? 1 : 0;
      duotone(img, T, fg, bg);
      relief(img, blurPlane(T, W, H, 1.5), p.relief / 3, 'top-left');
      return addNoise(img, p.grain * 4, seed);
    } },
  { id: 'photocopy', name: 'Photocopy', group: 'Sketch', params: [{ key: 'detail', label: 'Detail', min: 1, max: 24, def: 7 }, { key: 'darkness', label: 'Darkness', min: 1, max: 50, def: 8 }],
    run(img, p, fg, bg) {
      const W = W_(img), H = H_(img), L = lumaPlane(img), B = blurPlane(L, W, H, 25 - p.detail), T = new Float32Array(W * H);
      for (let i = 0; i < L.length; i++) T[i] = 1 - Math.max(0, Math.min(1, (B[i] - L[i]) * p.darkness / 40));
      return duotone(img, T, fg, bg);
    } },
  { id: 'plaster', name: 'Plaster', group: 'Sketch', params: [{ key: 'balance', label: 'Image Balance', min: 0, max: 50, def: 20 }, { key: 'smoothness', label: 'Smoothness', min: 1, max: 15, def: 2 }, { key: 'light', label: 'Light', def: 'top', type: 'select', options: LIGHT_OPTS }],
    run(img, p, fg, bg) {
      const W = W_(img), H = H_(img), L = blurPlane(lumaPlane(img), W, H, p.smoothness), T = new Float32Array(W * H);
      for (let i = 0; i < L.length; i++) T[i] = L[i] / 255 > p.balance / 50 ? 1 : 0;
      const Hh = blurPlane(T, W, H, 2);
      duotone(img, Hh, fg, bg);
      return relief(img, Hh, 6, p.light);
    } },
  { id: 'reticulation', name: 'Reticulation', group: 'Sketch', params: [{ key: 'density', label: 'Density', min: 0, max: 50, def: 12 }, { key: 'fgLevel', label: 'Foreground Level', min: 0, max: 50, def: 40 }, { key: 'bgLevel', label: 'Background Level', min: 0, max: 50, def: 5 }],
    run(img, p, fg, bg, seed) {
      const W = W_(img), H = H_(img), L = lumaPlane(img), r = rng(seed), T = new Float32Array(W * H);
      for (let i = 0; i < L.length; i++) { const v = L[i] / 255 + (p.bgLevel - p.fgLevel) / 100; T[i] = r() * (0.5 + p.density / 50) < v ? 1 : 0; }
      return duotone(img, blurPlane(T, W, H, 0.6), fg, bg);
    } },
  { id: 'stamp', name: 'Stamp', group: 'Sketch', params: [{ key: 'balance', label: 'Light/Dark Balance', min: 0, max: 50, def: 25 }, { key: 'smoothness', label: 'Smoothness', min: 1, max: 50, def: 5 }],
    run(img, p, fg, bg) {
      const W = W_(img), H = H_(img), L = blurPlane(lumaPlane(img), W, H, p.smoothness * 0.4), T = new Float32Array(W * H);
      for (let i = 0; i < L.length; i++) T[i] = Math.max(0, Math.min(1, (L[i] / 255 - p.balance / 50) * 12 + 0.5));
      return duotone(img, T, fg, bg);
    } },
  { id: 'torn-edges', name: 'Torn Edges', group: 'Sketch', params: [{ key: 'balance', label: 'Image Balance', min: 0, max: 50, def: 25 }, { key: 'smoothness', label: 'Smoothness', min: 1, max: 15, def: 11 }, { key: 'contrast', label: 'Contrast', min: 1, max: 25, def: 17 }],
    run(img, p, fg, bg, seed) {
      const W = W_(img), H = H_(img), L = blurPlane(lumaPlane(img), W, H, 1), T = new Float32Array(W * H);
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const i = y * W + x, n = (fbm(x / (16 - p.smoothness), y / (16 - p.smoothness), seed, 3) - 0.5) * 0.25; T[i] = Math.max(0, Math.min(1, (L[i] / 255 + n - p.balance / 50) * p.contrast + 0.5)); }
      return duotone(img, T, fg, bg);
    } },
  { id: 'water-paper', name: 'Water Paper', group: 'Sketch', params: [{ key: 'fiber', label: 'Fiber Length', min: 3, max: 50, def: 15 }, { key: 'brightness', label: 'Brightness', min: 0, max: 100, def: 60 }, { key: 'contrast', label: 'Contrast', min: 0, max: 100, def: 80 }],
    run(img, p, _f, _b, seed) {
      dirBlur(img, 90, p.fiber * 0.6); dirBlur(img, 0, p.fiber * 0.3);
      const W = W_(img), H = H_(img), d = img.data;
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const f = vnoise(x / 2, y / (p.fiber / 2), seed) * 30 - 15, i = (y * W + x) * 4; for (let c = 0; c < 3; c++) d[i + c] = clamp((d[i + c] + f - 128) * (p.contrast / 80) + 128 + (p.brightness - 50) * 1.5); }
      return img;
    } },
  // ---------------- Stylize
  { id: 'glowing-edges', name: 'Glowing Edges', group: 'Stylize', params: [{ key: 'width', label: 'Edge Width', min: 1, max: 14, def: 2 }, { key: 'brightness', label: 'Edge Brightness', min: 0, max: 20, def: 6 }, { key: 'smoothness', label: 'Smoothness', min: 1, max: 15, def: 5 }],
    run(img, p) {
      const W = W_(img), H = H_(img), src = cloneImage(img); gaussian(src, p.smoothness * 0.25);
      const d = img.data;
      for (let c = 0; c < 3; c++) {
        const pl = new Float32Array(W * H); for (let i = 0; i < pl.length; i++) pl[i] = src.data[i * 4 + c];
        const E = blurPlane(sobel(pl, W, H), W, H, p.width * 0.35);
        for (let i = 0; i < pl.length; i++) d[i * 4 + c] = clamp(E[i] * (0.8 + p.brightness * 0.35));
      }
      return img;
    } },
  // ---------------- Texture
  { id: 'craquelure', name: 'Craquelure', group: 'Texture', params: [{ key: 'spacing', label: 'Crack Spacing', min: 2, max: 100, def: 15 }, { key: 'depth', label: 'Crack Depth', min: 0, max: 10, def: 6 }, { key: 'brightness', label: 'Crack Brightness', min: 0, max: 10, def: 9 }],
    run(img, p, _f, _b, seed) {
      const W = W_(img), H = H_(img), v = voronoiEdges(W, H, p.spacing * 2 + 6, seed), Hh = new Float32Array(W * H);
      for (let i = 0; i < Hh.length; i++) Hh[i] = Math.min(1, v.edge[i] / 2.5);
      const d = img.data;
      for (let i = 0; i < Hh.length; i++) { const k = 0.6 + 0.04 * p.brightness + (1 - (0.6 + 0.04 * p.brightness)) * Hh[i]; for (let c = 0; c < 3; c++) d[i * 4 + c] = clamp(d[i * 4 + c] * k); }
      return relief(img, Hh, p.depth, 'top-left');
    } },
  { id: 'grain', name: 'Grain', group: 'Texture', params: [{ key: 'intensity', label: 'Intensity', min: 0, max: 100, def: 40 }, { key: 'contrast', label: 'Contrast', min: 0, max: 100, def: 50 }, { key: 'type', label: 'Grain Type', def: 'regular', type: 'select', options: [['regular', 'Regular'], ['soft', 'Soft'], ['sprinkles', 'Sprinkles'], ['clumped', 'Clumped'], ['contrasty', 'Contrasty'], ['enlarged', 'Enlarged'], ['stippled', 'Stippled'], ['horizontal', 'Horizontal'], ['vertical', 'Vertical'], ['speckle', 'Speckle']] }],
    run(img, p, _f, bg, seed) {
      const W = W_(img), H = H_(img), r = rng(seed), d = img.data, amt = p.intensity * 1.6, t = p.type;
      const plane = new Float32Array(W * H);
      if (t === 'horizontal' || t === 'vertical') { for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) plane[y * W + x] = t === 'horizontal' ? vnoise(x / 30, y, seed) : vnoise(x, y / 30, seed); }
      else if (t === 'clumped' || t === 'enlarged' || t === 'soft') { const s = t === 'enlarged' ? 3 : t === 'clumped' ? 2 : 1.2; for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) plane[y * W + x] = vnoise(x / s, y / s, seed); }
      else for (let i = 0; i < plane.length; i++) plane[i] = r();
      for (let i = 0; i < plane.length; i++) {
        const n = (plane[i] - 0.5) * amt;
        if (t === 'sprinkles' || t === 'speckle') { if (plane[i] > 1 - p.intensity / 250) { for (let c = 0; c < 3; c++) d[i * 4 + c] = t === 'sprinkles' ? bg[c] : 255 - d[i * 4 + c]; } continue; }
        if (t === 'stippled') { if (plane[i] > 0.5 + (1 - p.intensity / 100) * 0.5) for (let c = 0; c < 3; c++) d[i * 4 + c] = d[i * 4 + c] * 0.3; continue; }
        if (t === 'contrasty') { for (let c = 0; c < 3; c++) d[i * 4 + c] = clamp((d[i * 4 + c] - 128) * (1 + p.contrast / 60) + 128 + n); continue; }
        for (let c = 0; c < 3; c++) d[i * 4 + c] = clamp(d[i * 4 + c] + n);
      }
      if (t !== 'contrasty') contrast(img, 0.8 + p.contrast / 125);
      return img;
    } },
  { id: 'mosaic-tiles', name: 'Mosaic Tiles', group: 'Texture', params: [{ key: 'size', label: 'Tile Size', min: 2, max: 100, def: 12 }, { key: 'grout', label: 'Grout Width', min: 1, max: 15, def: 3 }, { key: 'lighten', label: 'Lighten Grout', min: 0, max: 10, def: 9 }],
    run(img, p, _f, _b, seed) {
      const W = W_(img), H = H_(img), v = voronoiEdges(W, H, p.size * 1.5 + 4, seed), d = img.data, Hh = new Float32Array(W * H);
      for (let i = 0; i < Hh.length; i++) { const g = v.edge[i] < p.grout / 2 ? 1 : 0; Hh[i] = g ? 0 : 1; if (g) { const k = p.lighten * 20; for (let c = 0; c < 3; c++) d[i * 4 + c] = clamp(d[i * 4 + c] * 0.4 + k); } }
      return relief(img, blurPlane(Hh, W, H, 1), 3, 'top-left');
    } },
  { id: 'patchwork', name: 'Patchwork', group: 'Texture', params: [{ key: 'size', label: 'Square Size', min: 0, max: 10, def: 4 }, { key: 'relief', label: 'Relief', min: 0, max: 25, def: 8 }],
    run(img, p, _f, _b, seed) {
      const W = W_(img), H = H_(img), s = Math.max(2, p.size * 2 + 2), d = img.data, r = rng(seed), Hh = new Float32Array(W * H);
      for (let by = 0; by < H; by += s) for (let bx = 0; bx < W; bx += s) {
        const cx = Math.min(W - 1, bx + (s >> 1)), cy = Math.min(H - 1, by + (s >> 1)), ci = (cy * W + cx) * 4, hgt = r();
        for (let y = by; y < Math.min(H, by + s); y++) for (let x = bx; x < Math.min(W, bx + s); x++) { const i = y * W + x; d[i * 4] = d[ci]; d[i * 4 + 1] = d[ci + 1]; d[i * 4 + 2] = d[ci + 2]; Hh[i] = (x === bx || y === by) ? 0 : hgt; }
      }
      return relief(img, Hh, p.relief / 3, 'top-left');
    } },
  { id: 'stained-glass', name: 'Stained Glass', group: 'Texture', params: [{ key: 'size', label: 'Cell Size', min: 2, max: 50, def: 10 }, { key: 'border', label: 'Border Thickness', min: 1, max: 20, def: 4 }, { key: 'light', label: 'Light Intensity', min: 0, max: 10, def: 3 }],
    run(img, p, fg, _b, seed) {
      const W = W_(img), H = H_(img), v = voronoiEdges(W, H, p.size * 2 + 4, seed), d = img.data, n = v.sx.length, acc = new Float64Array(n * 4);
      for (let i = 0; i < W * H; i++) { const k = v.id[i] * 4; acc[k] += d[i * 4]; acc[k + 1] += d[i * 4 + 1]; acc[k + 2] += d[i * 4 + 2]; acc[k + 3]++; }
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const i = y * W + x, k = v.id[i] * 4, cnt = acc[k + 3] || 1;
        if (v.edge[i] < p.border / 2) { d[i * 4] = fg[0]; d[i * 4 + 1] = fg[1]; d[i * 4 + 2] = fg[2]; continue; }
        const lit = 1 + (p.light / 10) * Math.max(0, 1 - Math.hypot(x - W / 2, y - H / 2) / (Math.hypot(W, H) / 2)) * 0.6;
        d[i * 4] = clamp((acc[k] / cnt) * lit); d[i * 4 + 1] = clamp((acc[k + 1] / cnt) * lit); d[i * 4 + 2] = clamp((acc[k + 2] / cnt) * lit);
      }
      return img;
    } },
  { id: 'texturizer', name: 'Texturizer', group: 'Texture', params: [...texParams('canvas').map(q => (q.key === 'relief' ? { ...q, def: 4 } : q.key === 'light' ? { ...q, def: 'top' } : q))],
    run(img, p, _f, _b, seed) { return withTexture(img, p, seed); } },
];
export const GALLERY_BY_ID = new Map(GALLERY.map(e => [e.id, e]));
export const galleryDefaults = (id: string) => Object.fromEntries((GALLERY_BY_ID.get(id)?.params || []).map(q => [q.key, q.def]));

/** Apply a stack of effect layers: p.layers = [{ id, params, visible }]. */
export const galleryKernel: Kernel = (img, p, m) => {
  let out = img;
  for (const l of p.layers || []) {
    if (l.visible === false) continue;
    const e = GALLERY_BY_ID.get(l.id);
    if (!e) continue;
    const alpha = new Uint8ClampedArray(out.width * out.height);
    for (let i = 0; i < alpha.length; i++) alpha[i] = out.data[i * 4 + 3];
    out = e.run(out, { ...galleryDefaults(l.id), ...l.params }, m.fg, m.bg, (m.seed || 1) + 17);
    for (let i = 0; i < alpha.length; i++) out.data[i * 4 + 3] = alpha[i];      // effects keep the layer's transparency
  }
  return out;
};
export { convolve };
