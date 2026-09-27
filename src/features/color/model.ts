// Colour-model helpers shared by the Color panel and the Color Picker: a hue-preserving colour state,
// axis definitions (H S B / R G B / L a b) and fast per-pixel field rendering.
import type { RGB } from '../../core/types';
import { hsvToRgb, labToRgb, rgbToHsv, rgbToLab } from '../../core/color';

export type Model = 'hsb' | 'rgb' | 'lab';
export type Axis = 'h' | 's' | 'v' | 'r' | 'g' | 'b' | 'L' | 'A' | 'B';
export type Vec3 = [number, number, number];

export interface ColorState { hsb: Vec3; rgb: Vec3; lab: Vec3 }

export const AXES: Record<Axis, { model: Model; i: number; min: number; max: number; label: string; unit: string }> = {
  h: { model: 'hsb', i: 0, min: 0, max: 360, label: 'H', unit: '°' },
  s: { model: 'hsb', i: 1, min: 0, max: 100, label: 'S', unit: '%' },
  v: { model: 'hsb', i: 2, min: 0, max: 100, label: 'B', unit: '%' },
  r: { model: 'rgb', i: 0, min: 0, max: 255, label: 'R', unit: '' },
  g: { model: 'rgb', i: 1, min: 0, max: 255, label: 'G', unit: '' },
  b: { model: 'rgb', i: 2, min: 0, max: 255, label: 'B', unit: '' },
  L: { model: 'lab', i: 0, min: 0, max: 100, label: 'L', unit: '' },
  A: { model: 'lab', i: 1, min: -128, max: 127, label: 'a', unit: '' },
  B: { model: 'lab', i: 2, min: -128, max: 127, label: 'b', unit: '' },
};
/** Photoshop Color Picker: the selected radio axis drives the slider; the field shows the other two [x, y]. */
export const FIELD_AXES: Record<Axis, [Axis, Axis]> = {
  h: ['s', 'v'], s: ['h', 'v'], v: ['h', 's'],
  r: ['b', 'g'], g: ['b', 'r'], b: ['r', 'g'],
  L: ['A', 'B'], A: ['B', 'L'], B: ['A', 'L'],
};

const rgbVec = (c: RGB): Vec3 => [c.r, c.g, c.b];
export const toRGB = (s: ColorState): RGB => ({ r: Math.round(s.rgb[0]), g: Math.round(s.rgb[1]), b: Math.round(s.rgb[2]) });

function hsbFromRgb(rgb: Vec3, prev?: Vec3): Vec3 {
  const hsv = rgbToHsv({ r: rgb[0], g: rgb[1], b: rgb[2] });
  const out: Vec3 = [hsv.h, hsv.s, hsv.v];
  if (prev) {
    if (out[1] < 0.01 || out[2] < 0.01) out[0] = prev[0];   // achromatic: keep hue
    if (out[2] < 0.01) out[1] = prev[1];                    // black: keep saturation
  }
  return out;
}

export function stateFromRgb(c: RGB, prev?: ColorState): ColorState {
  const rgb = rgbVec(c);
  const same = prev && Math.round(prev.rgb[0]) === c.r && Math.round(prev.rgb[1]) === c.g && Math.round(prev.rgb[2]) === c.b;
  if (same) return prev!;
  const l = rgbToLab(c);
  return { rgb, hsb: hsbFromRgb(rgb, prev?.hsb), lab: [l.l, l.a, l.b] };
}

/** New state after setting one or more components of one model. */
export function setModel(s: ColorState, model: Model, v: Vec3): ColorState {
  if (model === 'hsb') {
    const c = hsvToRgb({ h: v[0], s: v[1], v: v[2] }), l = rgbToLab(c);
    return { hsb: [...v] as Vec3, rgb: rgbVec(c), lab: [l.l, l.a, l.b] };
  }
  if (model === 'rgb') {
    const rgb = v.map(x => Math.max(0, Math.min(255, Math.round(x)))) as Vec3, l = rgbToLab({ r: rgb[0], g: rgb[1], b: rgb[2] });
    return { rgb, hsb: hsbFromRgb(rgb, s.hsb), lab: [l.l, l.a, l.b] };
  }
  const c = labToRgb({ l: v[0], a: v[1], b: v[2] }), rgb = rgbVec(c);
  return { lab: [...v] as Vec3, rgb, hsb: hsbFromRgb(rgb, s.hsb) };
}
export function setAxis(s: ColorState, axis: Axis, value: number): ColorState {
  const a = AXES[axis], v = [...s[a.model]] as Vec3;
  v[a.i] = Math.max(a.min, Math.min(a.max, value));
  return setModel(s, a.model, v);
}
export const axisValue = (s: ColorState, axis: Axis) => s[AXES[axis].model][AXES[axis].i];

// ------------------------------------------------------------------ fast conversions (per pixel)
export function hsbToRgbFast(h: number, s: number, v: number, out: Vec3) {
  s /= 100; v /= 100; h = ((h % 360) + 360) % 360 / 60;
  const i = Math.floor(h), f = h - i, p = v * (1 - s), q = v * (1 - s * f), t = v * (1 - s * (1 - f));
  let r, g, b;
  switch (i) { case 0: r = v; g = t; b = p; break; case 1: r = q; g = v; b = p; break; case 2: r = p; g = v; b = t; break; case 3: r = p; g = q; b = v; break; case 4: r = t; g = p; b = v; break; default: r = v; g = p; b = q; }
  out[0] = r * 255; out[1] = g * 255; out[2] = b * 255;
}
const lin2srgb = (c: number) => (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055) * 255;
export function labToRgbFast(L: number, a: number, b: number, out: Vec3) {
  const fy = (L + 16) / 116, fx = a / 500 + fy, fz = fy - b / 200;
  const f = (t: number) => { const t3 = t * t * t; return t3 > 0.008856 ? t3 : (t - 16 / 116) / 7.787; };
  const x = f(fx) * 0.95047, y = f(fy), z = f(fz) * 1.08883;
  out[0] = lin2srgb(x * 3.2406 - y * 1.5372 - z * 0.4986);
  out[1] = lin2srgb(-x * 0.9689 + y * 1.8758 + z * 0.0415);
  out[2] = lin2srgb(x * 0.0557 - y * 0.204 + z * 1.057);
}
export function modelToRgbFast(model: Model, v: Vec3, out: Vec3) {
  if (model === 'hsb') hsbToRgbFast(v[0], v[1], v[2], out);
  else if (model === 'lab') labToRgbFast(v[0], v[1], v[2], out);
  else { out[0] = v[0]; out[1] = v[1]; out[2] = v[2]; }
}
export const webSafe = (c: RGB): RGB => ({ r: Math.round(c.r / 51) * 51, g: Math.round(c.g / 51) * 51, b: Math.round(c.b / 51) * 51 });
export const isWebSafe = (c: RGB) => c.r % 51 === 0 && c.g % 51 === 0 && c.b % 51 === 0;

/** Paint a canvas pixel by pixel. fn(u, v, out) gets u,v in 0..1 (v=0 at the top) and writes 0..255 RGB (+ optional alpha in out[3]). */
export function paintCanvas(c: HTMLCanvasElement, fn: (u: number, v: number, out: number[]) => void, web = false) {
  const w = c.width, h = c.height, x = c.getContext('2d')!, img = x.createImageData(w, h), d = img.data;
  const out = [0, 0, 0, 255];
  for (let py = 0, i = 0; py < h; py++) {
    const v = h > 1 ? py / (h - 1) : 0;
    for (let px = 0; px < w; px++, i += 4) {
      out[3] = 255;
      fn(w > 1 ? px / (w - 1) : 0, v, out);
      if (web) { d[i] = Math.round(out[0] / 51) * 51; d[i + 1] = Math.round(out[1] / 51) * 51; d[i + 2] = Math.round(out[2] / 51) * 51; }
      else { d[i] = out[0]; d[i + 1] = out[1]; d[i + 2] = out[2]; }
      d[i + 3] = out[3];
    }
  }
  x.putImageData(img, 0, 0);
}

/** Render the 2-D field for a slider axis: x/y axes vary, the third component comes from the state. */
export function paintAxisField(c: HTMLCanvasElement, s: ColorState, axis: Axis, web = false) {
  const [ax, ay] = FIELD_AXES[axis], A = AXES[ax], B = AXES[ay], model = AXES[axis].model;
  const base = [...s[model]] as Vec3, tmp: Vec3 = [0, 0, 0];
  paintCanvas(c, (u, v, out) => {
    base[A.i] = A.min + u * (A.max - A.min);
    base[B.i] = B.max - v * (B.max - B.min);
    modelToRgbFast(model, base, tmp);
    out[0] = tmp[0]; out[1] = tmp[1]; out[2] = tmp[2];
  }, web);
}
/** Render the 1-D slider strip (top = max). */
export function paintAxisSlider(c: HTMLCanvasElement, s: ColorState, axis: Axis, web = false) {
  const A = AXES[axis], model = A.model, base = [...s[model]] as Vec3, tmp: Vec3 = [0, 0, 0];
  // the hue strip is always drawn fully saturated/bright (Photoshop behaviour)
  if (axis === 'h') { base[1] = 100; base[2] = 100; }
  paintCanvas(c, (_u, v, out) => {
    base[A.i] = A.max - v * (A.max - A.min);
    modelToRgbFast(model, base, tmp);
    out[0] = tmp[0]; out[1] = tmp[1]; out[2] = tmp[2];
  }, web);
}
/** CSS linear-gradient for a slider track varying one axis (left → right) with the others from the state. */
export function axisTrackCss(s: ColorState, axis: Axis, steps = 12): string {
  const A = AXES[axis], base = [...s[A.model]] as Vec3, tmp: Vec3 = [0, 0, 0], stops: string[] = [];
  for (let i = 0; i <= steps; i++) {
    base[A.i] = A.min + (i / steps) * (A.max - A.min);
    modelToRgbFast(A.model, base, tmp);
    stops.push(`rgb(${tmp.map(v => Math.max(0, Math.min(255, Math.round(v)))).join(',')}) ${(i / steps * 100).toFixed(1)}%`);
  }
  return `linear-gradient(90deg, ${stops.join(', ')})`;
}
