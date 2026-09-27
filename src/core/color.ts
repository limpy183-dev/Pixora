// Color conversions. RGB channels are 0..255; H in degrees 0..360; S/V/L in 0..100 (Photoshop units).
import type { RGB, RGBA } from './types';

export const clamp = (v: number, lo = 0, hi = 255) => (v < lo ? lo : v > hi ? hi : v);
export const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

export const rgb = (r: number, g: number, b: number): RGB => ({ r, g, b });
export const BLACK: RGB = { r: 0, g: 0, b: 0 };
export const WHITE: RGB = { r: 255, g: 255, b: 255 };

export function toCss(c: RGB, a = 1): string {
  return a >= 1 ? `rgb(${c.r | 0},${c.g | 0},${c.b | 0})` : `rgba(${c.r | 0},${c.g | 0},${c.b | 0},${a})`;
}
export function rgbaCss(c: RGBA): string { return toCss(c, c.a); }

export function toHex(c: RGB): string {
  return ((1 << 24) | ((c.r & 255) << 16) | ((c.g & 255) << 8) | (c.b & 255)).toString(16).slice(1);
}
export function fromHex(hex: string): RGB | null {
  let h = hex.trim().replace(/^#/, '');
  if (h.length === 3) h = h.split('').map(ch => ch + ch).join('');
  if (!/^[0-9a-f]{6}$/i.test(h)) return null;
  const n = parseInt(h, 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}
export function parseCss(css: string): RGB | null {
  if (css.startsWith('#')) return fromHex(css);
  const m = css.match(/rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/);
  return m ? { r: +m[1], g: +m[2], b: +m[3] } : null;
}
export const sameColor = (a: RGB, b: RGB) => a.r === b.r && a.g === b.g && a.b === b.b;

export interface HSV { h: number; s: number; v: number }
export interface HSL { h: number; s: number; l: number }
export interface Lab { l: number; a: number; b: number }
export interface CMYK { c: number; m: number; y: number; k: number }

export function rgbToHsv({ r, g, b }: RGB): HSV {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  let h = 0;
  if (d) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60; if (h < 0) h += 360;
  }
  return { h, s: max ? (d / max) * 100 : 0, v: max * 100 };
}
export function hsvToRgb({ h, s, v }: HSV): RGB {
  s /= 100; v /= 100; h = ((h % 360) + 360) % 360;
  const c = v * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = v - c;
  let r = 0, g = 0, b = 0;
  if (h < 60) [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  return { r: Math.round((r + m) * 255), g: Math.round((g + m) * 255), b: Math.round((b + m) * 255) };
}
export function rgbToHsl({ r, g, b }: RGB): HSL {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2, d = max - min;
  let h = 0, s = 0;
  if (d) {
    s = d / (1 - Math.abs(2 * l - 1));
    if (max === r) h = ((g - b) / d) % 6; else if (max === g) h = (b - r) / d + 2; else h = (r - g) / d + 4;
    h *= 60; if (h < 0) h += 360;
  }
  return { h, s: s * 100, l: l * 100 };
}
export function hslToRgb({ h, s, l }: HSL): RGB {
  s /= 100; l /= 100; h = ((h % 360) + 360) % 360;
  const c = (1 - Math.abs(2 * l - 1)) * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = l - c / 2;
  let r = 0, g = 0, b = 0;
  if (h < 60) [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  return { r: Math.round((r + m) * 255), g: Math.round((g + m) * 255), b: Math.round((b + m) * 255) };
}

const srgbToLin = (c: number) => { c /= 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
const linToSrgb = (c: number) => clamp(Math.round(255 * (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055)));

export function rgbToLab(c: RGB): Lab {
  const r = srgbToLin(c.r), g = srgbToLin(c.g), b = srgbToLin(c.b);
  let x = (r * 0.4124 + g * 0.3576 + b * 0.1805) / 0.95047;
  let y = r * 0.2126 + g * 0.7152 + b * 0.0722;
  let z = (r * 0.0193 + g * 0.1192 + b * 0.9505) / 1.08883;
  const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  x = f(x); y = f(y); z = f(z);
  return { l: 116 * y - 16, a: 500 * (x - y), b: 200 * (y - z) };
}
export function labToRgb({ l, a, b }: Lab): RGB {
  let y = (l + 16) / 116, x = a / 500 + y, z = y - b / 200;
  const f = (t: number) => (t ** 3 > 0.008856 ? t ** 3 : (t - 16 / 116) / 7.787);
  x = f(x) * 0.95047; y = f(y); z = f(z) * 1.08883;
  return {
    r: linToSrgb(x * 3.2406 + y * -1.5372 + z * -0.4986),
    g: linToSrgb(x * -0.9689 + y * 1.8758 + z * 0.0415),
    b: linToSrgb(x * 0.0557 + y * -0.204 + z * 1.057),
  };
}
export function rgbToCmyk({ r, g, b }: RGB): CMYK {
  const rr = r / 255, gg = g / 255, bb = b / 255, k = 1 - Math.max(rr, gg, bb);
  if (k >= 1) return { c: 0, m: 0, y: 0, k: 100 };
  return { c: ((1 - rr - k) / (1 - k)) * 100, m: ((1 - gg - k) / (1 - k)) * 100, y: ((1 - bb - k) / (1 - k)) * 100, k: k * 100 };
}
export function cmykToRgb({ c, m, y, k }: CMYK): RGB {
  c /= 100; m /= 100; y /= 100; k /= 100;
  return { r: Math.round(255 * (1 - c) * (1 - k)), g: Math.round(255 * (1 - m) * (1 - k)), b: Math.round(255 * (1 - y) * (1 - k)) };
}
/** Rec.601 luma, 0..255 */
export const luma = (r: number, g: number, b: number) => 0.299 * r + 0.587 * g + 0.114 * b;
