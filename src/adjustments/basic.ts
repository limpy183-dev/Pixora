// Simple tonal / colour adjustments: Brightness/Contrast, Exposure, Vibrance, Invert, Posterize, Threshold,
// Desaturate, Equalize, Photo Filter, Channel Mixer, Gradient Map.
import { h } from '../ui/dom';
import { button, checkbox, colorSwatch, gradientPicker, gradientCss, select } from '../ui/widgets';
import { resources } from '../core/registry';
import { gradientLUT } from '../core/gradient';
import { resolveGradient } from '../core/presets';
import type { Gradient, RGB } from '../core/types';
import {
  defineAdjustment, lutFrom, lutKernel, noop, clamp, clamp01, lum01, setLum, srgbToLinear, linearToSrgb,
  bakeLut3, lut3Kernel, histogram, clone, type Kernel,
} from './lib';
import { sliderField, radioGroup, histogramView, track, dropperButton } from './ui';

// ------------------------------------------------------------------ Brightness/Contrast
interface BC { brightness: number; contrast: number; useLegacy: boolean }
function bcLUT(p: BC) {
  if (p.useLegacy) {
    const c = p.contrast, k = c >= 0 ? 1 / Math.max(0.01, 1 - c / 100) : 1 + c / 100;
    return lutFrom(v => (v - 127.5) * k + 127.5 + p.brightness);
  }
  const b = p.brightness / 150, c = p.contrast / 100;
  const g = Math.pow(2, -b * 1.25);
  return lutFrom(v => {
    let x = v / 255;
    if (b) x = Math.pow(x, g);
    if (c > 0) {
      const k = 1 + c * 2.2;
      const s = x < 0.5 ? 0.5 * Math.pow(2 * x, k) : 1 - 0.5 * Math.pow(2 * (1 - x), k);
      x = x + (s - x) * Math.min(1, c * 1.4);
    } else if (c < 0) x = 0.5 + (x - 0.5) * (1 + c * 0.9);
    return x * 255;
  });
}
defineAdjustment<BC>({
  type: 'brightness-contrast', label: 'Brightness/Contrast', icon: 'adj-brightness',
  defaults: () => ({ brightness: 0, contrast: 0, useLegacy: false }),
  compile(p) { if (!p.brightness && !p.contrast) return noop; const l = bcLUT(p); return lutKernel(l, l, l); },
  build(el, p, change, env) {
    const b = sliderField('Brightness:', p.brightness, p.useLegacy ? -150 : -150, 150, v => (p.brightness = v), change, { center: 0 });
    const c = sliderField('Contrast:', p.contrast, p.useLegacy ? -100 : -50, 100, v => (p.contrast = v), change, { center: 0 });
    el.append(
      h('div.adj-toprow', null, button('Auto', () => {
        const img = env.stats();
        if (!img) return;
        const hs = histogram(img);
        let sum = 0, sq = 0;
        for (let i = 0; i < 256; i++) { sum += hs.l[i] * i; sq += hs.l[i] * i * i; }
        const mean = sum / (hs.n || 1), sd = Math.sqrt(Math.max(0, sq / (hs.n || 1) - mean * mean));
        p.brightness = Math.round(clamp((128 - mean) * 0.9, -150, 150));
        p.contrast = Math.round(clamp((58 - sd) * 1.4, -50, 100));
        env.rebuild();
      }, { title: 'Automatically set brightness and contrast', cls: 'small' })),
      b, c,
      checkbox('Use Legacy', p.useLegacy, v => { p.useLegacy = v; if (!v && p.contrast < -50) p.contrast = -50; change(true); env.rebuild(); }, { title: 'Use the linear (legacy) Brightness/Contrast algorithm' }),
    );
  },
});

// ------------------------------------------------------------------ Exposure
interface Ex { exposure: number; offset: number; gamma: number }
defineAdjustment<Ex>({
  type: 'exposure', label: 'Exposure', icon: 'adj-exposure',
  defaults: () => ({ exposure: 0, offset: 0, gamma: 1 }),
  presets: [['Default', () => {}], ['Minus 1.0', p => (p.exposure = -1)], ['Minus 2.0', p => (p.exposure = -2)], ['Plus 1.0', p => (p.exposure = 1)], ['Plus 2.0', p => (p.exposure = 2)]],
  compile(p) {
    if (!p.exposure && !p.offset && p.gamma === 1) return noop;
    const m = Math.pow(2, p.exposure), ig = 1 / Math.max(0.01, p.gamma);
    const l = lutFrom(v => {
      let x = srgbToLinear(v / 255) * m + p.offset;
      x = linearToSrgb(Math.max(0, Math.min(1, x)));
      return Math.pow(x, ig) * 255;
    });
    return lutKernel(l, l, l);
  },
  build(el, p, change, env) {
    el.append(
      sliderField('Exposure:', p.exposure, -20, 20, v => (p.exposure = v), change, { decimals: 2, step: 0.01, center: 0 }),
      sliderField('Offset:', p.offset, -0.5, 0.5, v => (p.offset = v), change, { decimals: 4, step: 0.0001, center: 0 }),
      sliderField('Gamma Correction:', p.gamma, 0.01, 9.99, v => (p.gamma = v), change, { decimals: 2, step: 0.01, center: 1 }),
      h('div.adj-droppers', null,
        dropperButton('adj-dropper-black', 'Sample in image to set black point (sets Offset)', env, c => { p.offset = +clamp(-srgbToLinear(lum01(c.r, c.g, c.b) / 255) * Math.pow(2, p.exposure), -0.5, 0.5).toFixed(4); env.rebuild(); }),
        dropperButton('adj-dropper-gray', 'Sample in image to set gray point (sets Gamma)', env, c => { const x = lum01(c.r, c.g, c.b) / 255; if (x > 0.01 && x < 0.99) { p.gamma = +clamp(Math.log(x) / Math.log(0.5), 0.01, 9.99).toFixed(2); env.rebuild(); } }),
        dropperButton('adj-dropper-white', 'Sample in image to set white point (sets Exposure)', env, c => { const x = srgbToLinear(Math.max(c.r, c.g, c.b) / 255); if (x > 0.001) { p.exposure = +clamp(Math.log2(1 / x), -20, 20).toFixed(2); env.rebuild(); } })),
    );
  },
});

// ------------------------------------------------------------------ Vibrance
interface Vib { vibrance: number; saturation: number }
defineAdjustment<Vib>({
  type: 'vibrance', label: 'Vibrance', icon: 'adj-vibrance',
  defaults: () => ({ vibrance: 0, saturation: 0 }),
  compile(p) {
    if (!p.vibrance && !p.saturation) return noop;
    const V = p.vibrance / 100, S = p.saturation / 100;
    return lut3Kernel(bakeLut3((r, g, b, o) => {
      const mx = Math.max(r, g, b), mn = Math.min(r, g, b), sat = mx - mn, L = lum01(r, g, b);
      let k = 1 + S;
      if (V) {
        // boost less-saturated colours more; protect skin tones (red dominant, green > blue)
        const skin = r > g && g > b ? clamp01(1 - Math.abs((g - b) / (r - b + 1e-6) - 0.45) * 2.2) * 0.6 : 0;
        k *= 1 + V * (1 - sat) * (V > 0 ? 1 - skin : 1) * 1.4;
      }
      if (k < 0) k = 0;
      o[0] = L + (r - L) * k; o[1] = L + (g - L) * k; o[2] = L + (b - L) * k;
      if (o[0] < 0 || o[1] < 0 || o[2] < 0 || o[0] > 1 || o[1] > 1 || o[2] > 1) setLum(o[0], o[1], o[2], L, o);
    }));
  },
  build(el, p, change) {
    el.append(
      sliderField('Vibrance:', p.vibrance, -100, 100, v => (p.vibrance = v), change, { center: 0, track: track.two('#808080', '#ff8a00') }),
      sliderField('Saturation:', p.saturation, -100, 100, v => (p.saturation = v), change, { center: 0, track: track.two('#808080', '#ff2a2a') }),
    );
  },
});

// ------------------------------------------------------------------ Invert
defineAdjustment<{}>({
  type: 'invert', label: 'Invert', icon: 'adj-invert', immediate: true,
  defaults: () => ({}),
  compile() { const l = lutFrom(v => 255 - v); return lutKernel(l, l, l); },
});

// ------------------------------------------------------------------ Posterize
defineAdjustment<{ levels: number }>({
  type: 'posterize', label: 'Posterize', icon: 'adj-posterize',
  defaults: () => ({ levels: 4 }),
  compile(p) {
    const n = Math.max(2, Math.min(255, Math.round(p.levels)));
    const l = lutFrom(v => Math.round(Math.min(n - 1, Math.floor((v / 256) * n)) * 255 / (n - 1)));
    return lutKernel(l, l, l);
  },
  build(el, p, change) { el.append(sliderField('Levels:', p.levels, 2, 255, v => (p.levels = v), change)); },
});

// ------------------------------------------------------------------ Threshold
defineAdjustment<{ level: number }>({
  type: 'threshold', label: 'Threshold', icon: 'adj-threshold',
  defaults: () => ({ level: 128 }),
  compile(p) {
    const t = p.level;
    return img => {
      const d = img.data;
      for (let i = 0; i < d.length; i += 4) {
        const v = (d[i] * 77 + d[i + 1] * 151 + d[i + 2] * 28) >> 8 >= t ? 255 : 0;
        d[i] = d[i + 1] = d[i + 2] = v;
      }
    };
  },
  build(el, p, change, env) {
    const wrap = h('div.adj-hist-wrap.adj-th');
    const hist = histogramView(env, 256, 110, () => 'l');
    const mark = h('div.adj-th-mark');
    const pos = () => { mark.style.left = `${(p.level / 255) * 100}%`; };
    wrap.append(hist, mark);
    const s = sliderField('Threshold Level:', p.level, 1, 255, v => { p.level = v; pos(); }, change, { track: track.gray });
    pos();
    el.append(wrap, s);
    return () => hist.dispose();
  },
});

// ------------------------------------------------------------------ Desaturate (Image > Adjustments only)
defineAdjustment<{}>({
  type: 'desaturate', label: 'Desaturate', immediate: true, dialogOnly: true,
  defaults: () => ({}),
  compile() {
    return img => {
      const d = img.data;
      for (let i = 0; i < d.length; i += 4) {
        const r = d[i], g = d[i + 1], b = d[i + 2];
        const v = ((r > g ? (r > b ? r : b) : g > b ? g : b) + (r < g ? (r < b ? r : b) : g < b ? g : b)) >> 1;
        d[i] = d[i + 1] = d[i + 2] = v;
      }
    };
  },
});

// ------------------------------------------------------------------ Equalize (Image > Adjustments only)
/** Mapping that spreads the combined brightness histogram evenly (optionally from a histogram source). */
export function equalizeLUT(src: ImageData, mask?: Uint8ClampedArray | null): Uint8Array {
  const hs = new Float64Array(256), d = src.data;
  for (let i = 0, p = 0; i < d.length; i += 4, p++) {
    const w = mask ? mask[p] / 255 : d[i + 3] > 0 ? 1 : 0;
    if (!w) continue;
    hs[d[i]] += w; hs[d[i + 1]] += w; hs[d[i + 2]] += w;
  }
  let total = 0;
  for (let i = 0; i < 256; i++) total += hs[i];
  const l = new Uint8Array(256);
  if (!total) { for (let i = 0; i < 256; i++) l[i] = i; return l; }
  let first = 0;
  while (first < 255 && !hs[first]) first++;
  const base = hs[first];
  let acc = 0;
  for (let i = 0; i < 256; i++) { acc += hs[i]; l[i] = clamp(Math.round(((acc - base) / Math.max(1, total - base)) * 255)); }
  return l;
}
defineAdjustment<{}>({
  type: 'equalize', label: 'Equalize', immediate: true, dialogOnly: true,
  defaults: () => ({}),
  compile() { return img => { const l = equalizeLUT(img); lutKernel(l, l, l)(img, null as any); }; },
});

// ------------------------------------------------------------------ Photo Filter
export const PHOTO_FILTERS: [string, string][] = [
  ['Warming Filter (85)', '#ec8a00'], ['Warming Filter (LBA)', '#fa9600'], ['Warming Filter (81)', '#ebb113'],
  ['Cooling Filter (80)', '#006dff'], ['Cooling Filter (LBB)', '#005dff'], ['Cooling Filter (82)', '#00b5ff'],
  ['Red', '#ea1a1a'], ['Orange', '#f38417'], ['Yellow', '#f9e31c'], ['Green', '#19c919'], ['Cyan', '#1dcbea'],
  ['Blue', '#1d35ea'], ['Violet', '#9b1dea'], ['Magenta', '#e318e3'], ['Sepia', '#ac7a33'], ['Deep Red', '#ff0000'],
  ['Deep Blue', '#0022cd'], ['Deep Emerald', '#008c00'], ['Deep Yellow', '#ffd500'], ['Underwater', '#00c1b1'],
];
const hexRGB = (hx: string): RGB => { const n = parseInt(hx.slice(1), 16); return { r: n >> 16, g: (n >> 8) & 255, b: n & 255 }; };
interface PF { mode: 'filter' | 'color'; filter: string; color: RGB; density: number; preserveLuminosity: boolean }
export const photoFilterColor = (p: PF): RGB => p.mode === 'color' ? p.color : hexRGB((PHOTO_FILTERS.find(f => f[0] === p.filter) || PHOTO_FILTERS[0])[1]);
defineAdjustment<PF>({
  type: 'photo-filter', label: 'Photo Filter', icon: 'adj-photo-filter',
  defaults: () => ({ mode: 'filter', filter: 'Warming Filter (85)', color: { r: 236, g: 138, b: 0 }, density: 25, preserveLuminosity: true }),
  compile(p) {
    if (!p.density) return noop;
    const c = photoFilterColor(p), fr = c.r / 255, fg = c.g / 255, fb = c.b / 255, d = p.density / 100;
    return lut3Kernel(bakeLut3((r, g, b, o) => {
      // light passing through a coloured filter: multiply, mixed by density
      const mr = r + (r * fr - r) * d, mg = g + (g * fg - g) * d, mb = b + (b * fb - b) * d;
      if (p.preserveLuminosity) setLum(mr, mg, mb, lum01(r, g, b), o);
      else { o[0] = mr; o[1] = mg; o[2] = mb; }
    }));
  },
  build(el, p, change) {
    const filt = select(PHOTO_FILTERS.map(([n]) => ({ value: n, label: n })), p.filter, v => { p.filter = v; p.mode = 'filter'; rg.setValue('filter'); change(true); }, { width: 200, title: 'Filter' });
    const sw = colorSwatch(p.color, c => { p.color = c; p.mode = 'color'; rg.setValue('color'); change(true); }, { title: 'Select filter color', size: 26 });
    const rg = radioGroup('Filter type', [['filter', 'Filter'], ['color', 'Color']], p.mode, v => { p.mode = v as PF['mode']; change(true); }, 'adj-pf-radios');
    const rows = rg.querySelectorAll('.adj-radio');
    rows[0].appendChild(filt); rows[1].appendChild(sw);
    el.append(rg,
      sliderField('Density:', p.density, 0, 100, v => (p.density = v), change, { unit: '%' }),
      checkbox('Preserve Luminosity', p.preserveLuminosity, v => { p.preserveLuminosity = v; change(true); }, { title: 'Keep the image brightness unchanged' }));
  },
});

// ------------------------------------------------------------------ Channel Mixer
interface MixCh { r: number; g: number; b: number; c: number }
interface Mix { out: 'r' | 'g' | 'b'; r: MixCh; g: MixCh; b: MixCh; mono: boolean; grey: MixCh }
const mixDefaults = (): Mix => ({ out: 'r', r: { r: 100, g: 0, b: 0, c: 0 }, g: { r: 0, g: 100, b: 0, c: 0 }, b: { r: 0, g: 0, b: 100, c: 0 }, mono: false, grey: { r: 40, g: 40, b: 20, c: 0 } });
const monoPreset = (r: number, g: number, b: number) => (p: Mix) => { p.mono = true; p.grey = { r, g, b, c: 0 }; };
defineAdjustment<Mix>({
  type: 'channel-mixer', label: 'Channel Mixer', icon: 'adj-mixer',
  defaults: mixDefaults,
  presets: [
    ['Default', () => {}],
    ['Black & White Infrared (RGB)', monoPreset(-70, 200, -30)],
    ['Black & White with Blue Filter (RGB)', monoPreset(0, 0, 100)],
    ['Black & White with Green Filter (RGB)', monoPreset(0, 100, 0)],
    ['Black & White with Orange Filter (RGB)', monoPreset(50, 50, 0)],
    ['Black & White with Red Filter (RGB)', monoPreset(100, 0, 0)],
    ['Black & White with Yellow Filter (RGB)', monoPreset(34, 66, 0)],
  ],
  compile(p) {
    const rows = p.mono ? [p.grey, p.grey, p.grey] : [p.r, p.g, p.b];
    const id = !p.mono && rows.every((m, i) => m.c === 0 && m.r === (i === 0 ? 100 : 0) && m.g === (i === 1 ? 100 : 0) && m.b === (i === 2 ? 100 : 0));
    if (id) return noop;
    const k = rows.map(m => [m.r / 100, m.g / 100, m.b / 100, (m.c / 100) * 255]);
    return img => {
      const d = img.data;
      const [a, b, c] = k;
      for (let i = 0; i < d.length; i += 4) {
        const R = d[i], G = d[i + 1], B = d[i + 2];
        d[i] = a[0] * R + a[1] * G + a[2] * B + a[3];
        d[i + 1] = b[0] * R + b[1] * G + b[2] * B + b[3];
        d[i + 2] = c[0] * R + c[1] * G + c[2] * B + c[3];
      }
    };
  },
  build(el, p, change, env) {
    const cur = () => (p.mono ? p.grey : p[p.out]);
    const total = h('span.adj-total');
    const setTotal = () => {
      const m = cur(), t = m.r + m.g + m.b;
      total.textContent = `${t > 0 ? '+' : ''}${t}%`;
      total.classList.toggle('warn', t > 100);
      total.title = t > 100 ? 'Total above 100% may clip highlights' : 'Sum of the source channels';
    };
    const outSel = select([{ value: 'r', label: 'Red' }, { value: 'g', label: 'Green' }, { value: 'b', label: 'Blue' }], p.mono ? 'r' : p.out, v => { p.out = v as Mix['out']; env.rebuild(); }, { width: 110, title: 'Output Channel' });
    if (p.mono) outSel.classList.add('disabled'), outSel.setAttribute('disabled', '');
    const s = (key: 'r' | 'g' | 'b' | 'c', label: string, tr: string) =>
      sliderField(label, cur()[key], -200, 200, v => { cur()[key] = v; setTotal(); }, change, { unit: '%', center: 0, track: tr });
    el.append(
      h('div.form-row', null, h('span.adj-lbl', null, 'Output Channel:'), outSel),
      checkbox('Monochrome', p.mono, v => { p.mono = v; change(true); env.rebuild(); }, { title: 'Create a grayscale image from the channels' }),
      s('r', 'Red:', track.two('#000', '#f00')), s('g', 'Green:', track.two('#000', '#0f0')), s('b', 'Blue:', track.two('#000', '#00f')),
      h('div.adj-total-row', null, h('span', null, 'Total:'), total),
      s('c', 'Constant:', track.gray),
    );
    setTotal();
  },
});

// ------------------------------------------------------------------ Gradient Map
interface GM { gradient: Gradient; reverse: boolean; dither: boolean; method: 'perceptual' | 'linear' | 'classic' | 'smooth' }
export const blackWhiteGradient = (): Gradient => clone(resolveGradient(resources.gradients.find(g => g.name === 'Foreground to Background') || resources.gradients[0]));
defineAdjustment<GM>({
  type: 'gradient-map', label: 'Gradient Map', icon: 'adj-gradient-map',
  defaults: () => ({ gradient: blackWhiteGradient(), reverse: false, dither: false, method: 'perceptual' }),
  compile(p) {
    const lut = gradientLUT(p.gradient, p.reverse, 256);
    const m = p.method;
    // brightness → gradient position table
    let lin: Float32Array | null = null;
    if (m === 'linear') { lin = new Float32Array(256); for (let i = 0; i < 256; i++) lin[i] = srgbToLinear(i / 255); }
    const pos = new Uint8Array(256);
    for (let i = 0; i < 256; i++) { const t = i / 255; pos[i] = clamp(Math.round((m === 'smooth' ? t * t * (3 - 2 * t) : t) * 255)); }
    const dither = p.dither;
    return (img, ctx) => {
      const d = img.data, w = img.width, ox = ctx?.rect?.x || 0, oy = ctx?.rect?.y || 0;
      for (let i = 0, px = 0; i < d.length; i += 4, px++) {
        const r = d[i], g = d[i + 1], b = d[i + 2];
        let L: number;
        if (lin) L = linearToSrgb(0.2126 * lin[r] + 0.7152 * lin[g] + 0.0722 * lin[b]) * 255;
        else if (m === 'classic') L = 0.3 * r + 0.59 * g + 0.11 * b;
        else L = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        if (dither) { const x = (px % w) + ox, y = ((px / w) | 0) + oy; L += (((x * 7 + y * 13) & 15) / 16 - 0.47); }
        const k = pos[L <= 0 ? 0 : L >= 255 ? 255 : L | 0] * 4;
        d[i] = lut[k]; d[i + 1] = lut[k + 1]; d[i + 2] = lut[k + 2];
      }
    };
  },
  build(el, p, change) {
    // paint the preview ourselves (plain CSS gradient over the checkerboard)
    const paint = () => { const pv = gp.querySelector<HTMLElement>('.grad-preview'); if (pv) pv.style.background = `${gradientCss(p.gradient)}, repeating-conic-gradient(#ccc 0 25%, #fff 0 50%) 0 0 / 8px 8px`; };
    const gp = gradientPicker(p.gradient, g => { p.gradient = clone(resolveGradient(g)); paint(); change(true); }, { width: 230 });
    paint();
    el.append(
      h('div.adj-sub', null, 'Gradient Used for Grayscale Mapping'),
      gp,
      h('div.adj-sub', null, 'Gradient Options'),
      checkbox('Dither', p.dither, v => { p.dither = v; change(true); }, { title: 'Add noise to reduce banding' }),
      checkbox('Reverse', p.reverse, v => { p.reverse = v; change(true); }, { title: 'Reverse the gradient direction' }),
      h('div.form-row', null, h('span.adj-lbl', null, 'Method:'),
        select([{ value: 'perceptual', label: 'Perceptual' }, { value: 'linear', label: 'Linear' }, { value: 'classic', label: 'Classic' }, { value: 'smooth', label: 'Smooth' }], p.method, v => { p.method = v as GM['method']; change(true); }, { width: 130, title: 'Interpolation method' })),
    );
  },
});

export type { Kernel };
