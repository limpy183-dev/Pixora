// Image › Adjustments only: Shadows/Highlights, HDR Toning, Match Color, Replace Color.
import { h } from '../ui/dom';
import { checkbox, colorSwatch, section, select } from '../ui/widgets';
import { app } from '../core/app';
import { createCanvas, ctx2d } from '../core/canvas';
import { GroupLayer } from '../core/layer';
import type { RGB } from '../core/types';
import {
  defineAdjustment, defs, clamp, clamp01, setLum, curveLUT, bakeLut3, lut3Kernel, noop, type Kernel,
} from './lib';
import { sliderField, track, dropperButton } from './ui';
import { hueSatFn } from './color';

// ------------------------------------------------------------------ blurred luminance (GPU blur on a downscaled copy)
function lumaImage(img: ImageData): ImageData {
  const out = new ImageData(img.width, img.height), s = img.data, d = out.data;
  for (let i = 0; i < s.length; i += 4) { const v = (s[i] * 77 + s[i + 1] * 151 + s[i + 2] * 28) >> 8; d[i] = d[i + 1] = d[i + 2] = v; d[i + 3] = 255; }
  return out;
}
/** Gaussian-blurred luminance (0..255 per pixel). Edges are clamped (no dark halo at the borders). */
export function blurredLuma(img: ImageData, radius: number, luma?: ImageData): Uint8ClampedArray {
  const w = img.width, hh = img.height, L = luma || lumaImage(img);
  const src = createCanvas(w, hh);
  ctx2d(src).putImageData(L, 0, 0);
  if (radius < 0.5) { const d = L.data, o = new Uint8ClampedArray(w * hh); for (let i = 0; i < o.length; i++) o[i] = d[i * 4]; return o; }
  const k = Math.max(1, Math.min(16, radius / 4));
  const sw = Math.max(1, Math.round(w / k)), sh = Math.max(1, Math.round(hh / k)), r = radius / k, pad = Math.ceil(r * 3) + 2;
  const small = createCanvas(sw + pad * 2, sh + pad * 2), sx = ctx2d(small);
  sx.imageSmoothingQuality = 'high';
  sx.drawImage(src, pad, pad, sw, sh);
  // replicate edges into the padding
  sx.drawImage(small, pad, pad, 1, sh, 0, pad, pad, sh);
  sx.drawImage(small, pad + sw - 1, pad, 1, sh, pad + sw, pad, pad, sh);
  sx.drawImage(small, 0, pad, sw + pad * 2, 1, 0, 0, sw + pad * 2, pad);
  sx.drawImage(small, 0, pad + sh - 1, sw + pad * 2, 1, 0, pad + sh, sw + pad * 2, pad);
  const bl = createCanvas(sw + pad * 2, sh + pad * 2), bx = ctx2d(bl);
  bx.filter = `blur(${r}px)`;
  bx.drawImage(small, 0, 0);
  bx.filter = 'none';
  const big = createCanvas(w, hh), gx = ctx2d(big);
  gx.imageSmoothingQuality = 'high';
  gx.drawImage(bl, pad, pad, sw, sh, 0, 0, w, hh);
  const d = gx.getImageData(0, 0, w, hh).data, o = new Uint8ClampedArray(w * hh);
  for (let i = 0; i < o.length; i++) o[i] = d[i * 4];
  return o;
}
/** Scale pixel colour so its luminance becomes nl (0..1), then adjust saturation by sk. */
function applyLum(d: Uint8ClampedArray, i: number, L: number, nl: number, sk: number, tmp: Float32Array) {
  const r = d[i] / 255, g = d[i + 1] / 255, b = d[i + 2] / 255;
  const f = L > 0.004 ? nl / L : 0;
  let nr = L > 0.004 ? r * f : nl, ng = L > 0.004 ? g * f : nl, nb = L > 0.004 ? b * f : nl;
  if (sk !== 1) { nr = nl + (nr - nl) * sk; ng = nl + (ng - nl) * sk; nb = nl + (nb - nl) * sk; }
  if (nr > 1 || ng > 1 || nb > 1 || nr < 0 || ng < 0 || nb < 0) { setLum(nr, ng, nb, nl, tmp); nr = tmp[0]; ng = tmp[1]; nb = tmp[2]; }
  d[i] = nr * 255; d[i + 1] = ng * 255; d[i + 2] = nb * 255;
}

// ------------------------------------------------------------------ Shadows/Highlights
interface SH { sAmount: number; sTone: number; sRadius: number; hAmount: number; hTone: number; hRadius: number; color: number; midtone: number }
defineAdjustment<SH>({
  type: 'shadows-highlights', label: 'Shadows/Highlights', icon: 'adj-shadows', dialogOnly: true, dialogWidth: 470,
  defaults: () => ({ sAmount: 35, sTone: 50, sRadius: 30, hAmount: 0, hTone: 50, hRadius: 30, color: 20, midtone: 0 }),
  compile(p) {
    if (!p.sAmount && !p.hAmount && !p.midtone) return noop;
    const sa = p.sAmount / 100, ha = p.hAmount / 100, ts = 0.1 + (p.sTone / 100) * 0.85, th = 0.1 + (p.hTone / 100) * 0.85;
    const col = p.color / 100, mc = p.midtone / 100;
    return img => {
      const d = img.data, luma = lumaImage(img);
      const bs = sa ? blurredLuma(img, p.sRadius, luma) : null;
      const bh = ha ? (p.hRadius === p.sRadius && bs ? bs : blurredLuma(img, p.hRadius, luma)) : null;
      const tmp = new Float32Array(3);
      for (let i = 0, px = 0; i < d.length; i += 4, px++) {
        if (!d[i + 3]) continue;
        const L = luma.data[i] / 255;
        let nl = L, m = 0;
        if (bs) {
          const B = bs[px] / 255, w = clamp01(1 - B / ts);
          const ms = sa * w * w * (3 - 2 * w);
          nl = nl + (1 - nl) * ms * (1 - nl) * 1.6 * (0.35 + 0.65 * (1 - L));
          m += ms;
        }
        if (bh) {
          const B = bh[px] / 255, w = clamp01((B - (1 - th)) / th);
          const mh = ha * w * w * (3 - 2 * w);
          nl = nl - nl * mh * nl * 1.1 * (0.35 + 0.65 * L);
          m += mh;
        }
        if (mc) { const s = nl < 0.5 ? 0.5 * Math.pow(2 * nl, 1 + mc) : 1 - 0.5 * Math.pow(2 * (1 - nl), 1 + mc); nl = mc > 0 ? s : 0.5 + (nl - 0.5) * (1 + mc * 0.8); }
        applyLum(d, i, L, clamp01(nl), 1 + col * Math.min(1, m) * 1.5, tmp);
      }
    };
  },
  build(el, p, change) {
    el.append(
      h('div.adj-sub', null, 'Shadows'),
      sliderField('Amount:', p.sAmount, 0, 100, v => (p.sAmount = v), change, { unit: '%' }),
      sliderField('Tone:', p.sTone, 0, 100, v => (p.sTone = v), change, { unit: '%' }),
      sliderField('Radius:', p.sRadius, 0, 2500, v => (p.sRadius = v), change, { unit: 'px' }),
      h('div.adj-sub', null, 'Highlights'),
      sliderField('Amount:', p.hAmount, 0, 100, v => (p.hAmount = v), change, { unit: '%' }),
      sliderField('Tone:', p.hTone, 0, 100, v => (p.hTone = v), change, { unit: '%' }),
      sliderField('Radius:', p.hRadius, 0, 2500, v => (p.hRadius = v), change, { unit: 'px' }),
      h('div.adj-sub', null, 'Adjustments'),
      sliderField('Color:', p.color, -100, 100, v => (p.color = v), change, { center: 0 }),
      sliderField('Midtone:', p.midtone, -100, 100, v => (p.midtone = v), change, { center: 0 }),
    );
  },
});

// ------------------------------------------------------------------ HDR Toning
interface HDR {
  method: 'local' | 'equalize' | 'exposure' | 'compress';
  radius: number; strength: number; gamma: number; exposure: number; detail: number;
  shadow: number; highlight: number; vibrance: number; saturation: number; curve: number[][];
}
const hdrDefaults = (): HDR => ({ method: 'local', radius: 16, strength: 0.52, gamma: 1, exposure: 0, detail: 30, shadow: 0, highlight: 0, vibrance: 0, saturation: 20, curve: [[0, 0], [255, 255]] });
defineAdjustment<HDR>({
  type: 'hdr-toning', label: 'HDR Toning', icon: 'adj-shadows', dialogOnly: true, dialogWidth: 520,
  defaults: hdrDefaults,
  presets: [
    ['Default', () => {}],
    ['Flat', p => Object.assign(p, { radius: 60, strength: 1.4, detail: 0, saturation: 0, gamma: 1.2 })],
    ['Monochromatic', p => Object.assign(p, { radius: 30, strength: 0.8, detail: 60, saturation: -100, vibrance: 0 })],
    ['Monochromatic High Contrast', p => Object.assign(p, { radius: 90, strength: 1.2, detail: 120, saturation: -100, curve: [[0, 0], [64, 40], [192, 215], [255, 255]] })],
    ['Photorealistic', p => Object.assign(p, { radius: 40, strength: 0.7, detail: 40, saturation: 10, vibrance: 10 })],
    ['Photorealistic High Contrast', p => Object.assign(p, { radius: 80, strength: 0.9, detail: 70, saturation: 15, curve: [[0, 0], [64, 50], [192, 205], [255, 255]] })],
    ['Saturated', p => Object.assign(p, { radius: 40, strength: 0.8, detail: 50, saturation: 60, vibrance: 40 })],
    ['Surrealistic', p => Object.assign(p, { radius: 120, strength: 2.5, detail: 200, saturation: 45, vibrance: 30 })],
  ],
  compile(p) {
    const cl = curveLUT(p.curve);
    const em = Math.pow(2, p.exposure), ig = 1 / Math.max(0.1, p.gamma);
    const vib = p.vibrance / 100, sat = p.saturation / 100, det = 1 + p.detail / 100, st = p.strength;
    const shw = p.shadow / 100, hiw = p.highlight / 100;
    return img => {
      const d = img.data, luma = lumaImage(img), tmp = new Float32Array(3);
      let base: Uint8ClampedArray | null = null, eq: Uint8Array | null = null;
      if (p.method === 'local') base = blurredLuma(img, p.radius, luma);
      if (p.method === 'equalize') {
        const hs = new Float64Array(256);
        for (let i = 0; i < d.length; i += 4) if (d[i + 3]) hs[luma.data[i]]++;
        let tot = 0; for (let i = 0; i < 256; i++) tot += hs[i];
        eq = new Uint8Array(256); let acc = 0;
        for (let i = 0; i < 256; i++) { acc += hs[i]; eq[i] = Math.round((acc / (tot || 1)) * 255); }
      }
      for (let i = 0, px = 0; i < d.length; i += 4, px++) {
        if (!d[i + 3]) continue;
        const L = luma.data[i] / 255;
        let nl = L;
        if (base) {
          const B = base[px] / 255;
          const Bc = 0.5 + (B - 0.5) / (1 + st * 0.9);
          nl = Bc + (L - B) * det * (1 + st * 0.35);
        } else if (eq) nl = eq[luma.data[i]] / 255;
        else if (p.method === 'compress') { const x = L * 2; nl = (x * (1 + x / 4)) / (1 + x); }
        if (p.method !== 'equalize' && p.method !== 'compress') nl = Math.pow(clamp01(nl * em), ig);
        if (shw) nl += shw * (1 - nl) * (1 - nl) * 0.5;
        if (hiw) nl += hiw * nl * nl * 0.5;
        nl = cl[clamp(Math.round(clamp01(nl) * 255))] / 255;
        let sk = 1 + sat;
        if (vib) { const mx = Math.max(d[i], d[i + 1], d[i + 2]), mn = Math.min(d[i], d[i + 1], d[i + 2]); sk *= 1 + vib * (1 - (mx - mn) / 255); }
        applyLum(d, i, L, nl, Math.max(0, sk), tmp);
      }
    };
  },
  build(el, p, change, env) {
    const local = p.method === 'local', expo = p.method === 'exposure';
    const toning = h('div.adj-toning');
    const proxy: any = { rgb: p.curve, r: [[0, 0], [255, 255]], g: [[0, 0], [255, 255]], b: [[0, 0], [255, 255]], _channel: 'rgb' };
    const cleanup = defs.curves.build?.(toning, proxy, (final?: boolean) => { p.curve = proxy.rgb; change(final); }, env);
    el.append(
      h('div.form-row', null, h('span.adj-lbl', null, 'Method:'),
        select([{ value: 'local', label: 'Local Adaptation' }, { value: 'equalize', label: 'Equalize Histogram' }, { value: 'exposure', label: 'Exposure and Gamma' }, { value: 'compress', label: 'Highlight Compression' }], p.method, v => { p.method = v as HDR['method']; change(true); env.rebuild(); }, { width: 180, title: 'Tone mapping method' })),
    );
    if (local) el.append(
      h('div.adj-sub', null, 'Edge Glow'),
      sliderField('Radius:', p.radius, 1, 500, v => (p.radius = v), change, { unit: 'px' }),
      sliderField('Strength:', p.strength, 0.1, 4, v => (p.strength = v), change, { decimals: 2, step: 0.01 }),
    );
    if (local || expo) el.append(
      h('div.adj-sub', null, 'Tone and Detail'),
      sliderField('Gamma:', p.gamma, 0.1, 2, v => (p.gamma = v), change, { decimals: 2, step: 0.01, center: 1 }),
      sliderField('Exposure:', p.exposure, -5, 5, v => (p.exposure = v), change, { decimals: 2, step: 0.01, center: 0 }),
    );
    if (local) el.append(
      sliderField('Detail:', p.detail, -100, 300, v => (p.detail = v), change, { unit: '%', center: 0 }),
      h('div.adj-sub', null, 'Advanced'),
      sliderField('Shadow:', p.shadow, -100, 100, v => (p.shadow = v), change, { unit: '%', center: 0 }),
      sliderField('Highlight:', p.highlight, -100, 100, v => (p.highlight = v), change, { unit: '%', center: 0 }),
      sliderField('Vibrance:', p.vibrance, -100, 100, v => (p.vibrance = v), change, { unit: '%', center: 0 }),
      sliderField('Saturation:', p.saturation, -100, 100, v => (p.saturation = v), change, { unit: '%', center: 0 }),
      section('Toning Curve and Histogram', toning, { collapsed: true }),
    );
    return () => { if (typeof cleanup === 'function') cleanup(); };
  },
});

// ------------------------------------------------------------------ Match Color
interface Stats { m: number[]; s: number[] }
interface MC { luminance: number; intensity: number; fade: number; neutralize: boolean; sourceDoc: number; sourceLayer: number; src: Stats | null }
const toYCC = (r: number, g: number, b: number, o: number[]) => { o[0] = 0.299 * r + 0.587 * g + 0.114 * b; o[1] = -0.168736 * r - 0.331264 * g + 0.5 * b; o[2] = 0.5 * r - 0.418688 * g - 0.081312 * b; };
function statsOf(d: Uint8ClampedArray, step = 1): Stats {
  const o = [0, 0, 0], sum = [0, 0, 0], sq = [0, 0, 0];
  let n = 0;
  const inc = Math.max(1, step) * 4;
  for (let i = 0; i < d.length; i += inc) {
    if (d[i + 3] < 8) continue;
    toYCC(d[i] / 255, d[i + 1] / 255, d[i + 2] / 255, o);
    for (let k = 0; k < 3; k++) { sum[k] += o[k]; sq[k] += o[k] * o[k]; }
    n++;
  }
  n = n || 1;
  const m = sum.map(v => v / n);
  return { m, s: sq.map((v, k) => Math.max(1e-3, Math.sqrt(Math.max(0, v / n - m[k] * m[k])))) };
}
function sourceStats(p: MC): Stats | null {
  const doc = app.docs.find(dd => dd.id === p.sourceDoc);
  if (!doc) return null;
  const l = p.sourceLayer ? doc.findLayer(p.sourceLayer) : null;
  let c: HTMLCanvasElement;
  if (l && !(l instanceof GroupLayer) && l.getContent(doc)) c = doc.layerAsDocCanvas(l);
  else c = doc.getComposite();
  const k = Math.min(1, Math.sqrt(250000 / (c.width * c.height)));
  const s = createCanvas(Math.max(1, c.width * k), Math.max(1, c.height * k));
  ctx2d(s).drawImage(c, 0, 0, s.width, s.height);
  return statsOf(ctx2d(s).getImageData(0, 0, s.width, s.height).data);
}
defineAdjustment<MC>({
  type: 'match-color', label: 'Match Color', dialogOnly: true, dialogWidth: 500,
  defaults: () => ({ luminance: 100, intensity: 100, fade: 0, neutralize: false, sourceDoc: 0, sourceLayer: 0, src: null }),
  compile(p) {
    if (!p.src && p.luminance === 100 && p.intensity === 100 && !p.neutralize) return noop;
    return img => {
      const d = img.data;
      const tgt = statsOf(d, Math.max(1, Math.floor((d.length / 4) / 200000)));
      const src = p.src || tgt;
      const lk = p.luminance / 100, ck = p.intensity / 100, fade = p.fade / 100;
      const tm = [...tgt.m];
      const sm = [...src.m];
      // std ratios are clamped so a flat source can't erase all detail
      const k = [0, 1, 2].map(c => Math.max(0.3, Math.min(3, src.s[c] / tgt.s[c])));
      if (p.neutralize) { sm[1] = 0; sm[2] = 0; }
      const f = bakeLut3((r, g, b, o) => {
        const y = [0, 0, 0];
        toYCC(r, g, b, y);
        let Y = sm[0] + (y[0] - tm[0]) * k[0];
        Y = Y * lk;
        const cb = (sm[1] + (y[1] - tm[1]) * k[1]) * ck;
        const cr = (sm[2] + (y[2] - tm[2]) * k[2]) * ck;
        let nr = Y + 1.402 * cr, ng = Y - 0.344136 * cb - 0.714136 * cr, nb = Y + 1.772 * cb;
        nr = r + (clamp01(nr) - r) * (1 - fade); ng = g + (clamp01(ng) - g) * (1 - fade); nb = b + (clamp01(nb) - b) * (1 - fade);
        o[0] = nr; o[1] = ng; o[2] = nb;
      });
      lut3Kernel(f)(img, null as any);
    };
  },
  build(el, p, change, env) {
    const doc = env.doc;
    const tl = doc?.activeLayer;
    const docs = app.docs;
    const srcDoc = () => docs.find(dd => dd.id === p.sourceDoc) || null;
    const recompute = () => { p.src = p.sourceDoc ? sourceStats(p) : null; };
    const layerOpts = () => {
      const d = srcDoc();
      const o: any[] = [{ value: 0, label: 'Merged' }];
      if (d) for (const l of [...d.allLayers()].reverse()) if (!(l instanceof GroupLayer) && l.kind !== 'adjustment') o.push({ value: l.id, label: l.name });
      return o;
    };
    el.append(
      h('div.adj-sub', null, 'Destination Image'),
      h('div.form-row', null, h('span.adj-lbl', null, 'Target:'), h('span', null, `${doc?.name || ''}${tl ? ` (${tl.name}, RGB/8)` : ''}`)),
      h('div.adj-sub', null, 'Image Options'),
      sliderField('Luminance', p.luminance, 1, 200, v => (p.luminance = v), change),
      sliderField('Color Intensity', p.intensity, 1, 200, v => (p.intensity = v), change),
      sliderField('Fade', p.fade, 0, 100, v => (p.fade = v), change),
      checkbox('Neutralize', p.neutralize, v => { p.neutralize = v; change(true); }, { title: 'Remove the color cast from the target image' }),
      h('div.adj-sub', null, 'Image Statistics'),
      h('div.form-row', null, h('span.adj-lbl', null, 'Source:'),
        select([{ value: 0, label: 'None' }, ...docs.map(dd => ({ value: dd.id, label: dd.name }))], p.sourceDoc, v => { p.sourceDoc = v; p.sourceLayer = 0; recompute(); change(true); env.rebuild(); }, { width: 220, title: 'Image whose colors are matched' })),
      h('div.form-row', null, h('span.adj-lbl', null, 'Layer:'),
        select(layerOpts(), p.sourceLayer, v => { p.sourceLayer = v; recompute(); change(true); }, { width: 220, title: 'Layer of the source image' })),
    );
    if (docs.length < 2) el.append(h('div.adj-empty', null, 'Tip: open a second image to use it as the color source.'));
  },
});

// ------------------------------------------------------------------ Replace Color
interface RC { colors: number[][]; minus: number[][]; fuzziness: number; hue: number; saturation: number; lightness: number; _view?: 'selection' | 'image' }
/** Per-pixel selection weight (0..1) for Replace Color. */
function rcWeightFn(p: RC) {
  const fz = Math.max(1, p.fuzziness) * 0.9;
  const pos = p.colors, neg = p.minus;
  return (r: number, g: number, b: number) => {
    let best = 1e9;
    for (const c of pos) { const dr = r - c[0], dg = g - c[1], db = b - c[2]; const dd = dr * dr * 0.3 + dg * dg * 0.59 + db * db * 0.11 + 0.4 * ((dr - dg) * (dr - dg) + (dg - db) * (dg - db)) * 0.25; if (dd < best) best = dd; }
    let w = clamp01(1 - Math.sqrt(best) / fz);
    for (const c of neg) { const dr = r - c[0], dg = g - c[1], db = b - c[2]; const dd = Math.sqrt(dr * dr * 0.3 + dg * dg * 0.59 + db * db * 0.11); w *= clamp01(dd / fz); }
    return w;
  };
}
const rcHS = (p: RC) => hueSatFn({ master: { h: p.hue, s: p.saturation, l: p.lightness }, ranges: [], colorize: false, cz: { h: 0, s: 0, l: 0 } });
defineAdjustment<RC>({
  type: 'replace-color', label: 'Replace Color', dialogOnly: true, dialogWidth: 470,
  defaults: () => ({ colors: [[app.fg.r, app.fg.g, app.fg.b]], minus: [], fuzziness: 40, hue: 0, saturation: 0, lightness: 0 }),
  compile(p): Kernel {
    if (!p.colors.length || (!p.hue && !p.saturation && !p.lightness)) return noop;
    const lk = lut3Kernel(bakeLut3(rcHS(p)));
    const wf = rcWeightFn(p);
    // weight cache per quantised colour (5 bits/channel) keeps the per-pixel cost low
    const wc = new Float32Array(32768).fill(-1);
    return (img, ctx) => {
      const orig = new Uint8ClampedArray(img.data);
      lk(img, ctx);
      const d = img.data;
      for (let i = 0; i < d.length; i += 4) {
        const q = ((orig[i] >> 3) << 10) | ((orig[i + 1] >> 3) << 5) | (orig[i + 2] >> 3);
        let w = wc[q];
        if (w < 0) w = wc[q] = wf((orig[i] & 0xf8) + 4, (orig[i + 1] & 0xf8) + 4, (orig[i + 2] & 0xf8) + 4);
        if (w >= 1) continue;
        d[i] = orig[i] + (d[i] - orig[i]) * w; d[i + 1] = orig[i + 1] + (d[i + 1] - orig[i + 1]) * w; d[i + 2] = orig[i + 2] + (d[i + 2] - orig[i + 2]) * w;
      }
    };
  },
  build(el, p, change, env) {
    const view = () => p._view || 'selection';
    const pv = h('canvas.adj-rc-preview', { width: 240, height: 170, title: 'Click to sample a color (Shift+click adds, Alt+click subtracts)' }) as HTMLCanvasElement;
    const result = colorSwatch({ r: 0, g: 0, b: 0 }, () => {}, { title: 'Result color', size: 30 });
    const src = env.stats();
    const paintPreview = () => {
      const x = ctx2d(pv);
      x.fillStyle = '#000'; x.fillRect(0, 0, pv.width, pv.height);
      if (!src) return;
      const k = Math.min(pv.width / src.width, pv.height / src.height), w = Math.max(1, Math.round(src.width * k)), hh = Math.max(1, Math.round(src.height * k));
      const tmp = createCanvas(src.width, src.height);
      const out = new ImageData(new Uint8ClampedArray(src.data), src.width, src.height);
      if (view() === 'selection') {
        const wf = rcWeightFn(p), d = out.data;
        for (let i = 0; i < d.length; i += 4) { const v = wf(d[i], d[i + 1], d[i + 2]) * 255; d[i] = d[i + 1] = d[i + 2] = v; d[i + 3] = 255; }
      }
      ctx2d(tmp).putImageData(out, 0, 0);
      x.drawImage(tmp, (pv.width - w) / 2, (pv.height - hh) / 2, w, hh);
      const c = p.colors[0];
      if (c) { const o = [0, 0, 0]; rcHS(p)(c[0] / 255, c[1] / 255, c[2] / 255, o); result.setValue({ r: Math.round(o[0] * 255), g: Math.round(o[1] * 255), b: Math.round(o[2] * 255) }); }
    };
    let raf = 0;
    const later = () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; paintPreview(); }); };
    const ch = (final?: boolean) => { later(); change(final); };
    const addSample = (c: RGB, mode: 'set' | 'add' | 'sub') => {
      const v = [c.r, c.g, c.b];
      if (mode === 'set') { p.colors = [v]; p.minus = []; } else if (mode === 'add') p.colors.push(v); else p.minus.push(v);
      sw.setValue(c); ch(true);
    };
    pv.addEventListener('pointerdown', e => {
      if (!src) return;
      const r = pv.getBoundingClientRect();
      const k = Math.min(pv.width / src.width, pv.height / src.height);
      const ox = (pv.width - src.width * k) / 2, oy = (pv.height - src.height * k) / 2;
      const ix = Math.floor(((e.clientX - r.left) * (pv.width / r.width) - ox) / k), iy = Math.floor(((e.clientY - r.top) * (pv.height / r.height) - oy) / k);
      if (ix < 0 || iy < 0 || ix >= src.width || iy >= src.height) return;
      const i = (iy * src.width + ix) * 4;
      addSample({ r: src.data[i], g: src.data[i + 1], b: src.data[i + 2] }, e.shiftKey ? 'add' : e.altKey ? 'sub' : 'set');
    });
    const c0 = p.colors[0] || [0, 0, 0];
    const sw = colorSwatch({ r: c0[0], g: c0[1], b: c0[2] }, c => addSample(c, 'set'), { title: 'Selected color', size: 30 });
    const vSel = h('input', { type: 'radio', name: 'adj-rcv', checked: view() === 'selection' }) as HTMLInputElement;
    const vImg = h('input', { type: 'radio', name: 'adj-rcv', checked: view() === 'image' }) as HTMLInputElement;
    vSel.onchange = () => { p._view = 'selection'; paintPreview(); };
    vImg.onchange = () => { p._view = 'image'; paintPreview(); };
    el.append(
      h('div.adj-sub', null, 'Selection'),
      h('div.adj-toprow', null,
        h('div.adj-droppers', null,
          dropperButton('adj-dropper', 'Sample a color in the image', env, c => addSample(c, 'set')),
          dropperButton('adj-dropper-plus', 'Add to sample', env, c => addSample(c, 'add')),
          dropperButton('adj-dropper-minus', 'Subtract from sample', env, c => addSample(c, 'sub'))),
        h('span.adj-lbl', null, 'Color:'), sw),
      sliderField('Fuzziness:', p.fuzziness, 0, 200, v => (p.fuzziness = v), ch),
      h('div.adj-rc-wrap', null, pv),
      h('div.adj-radios.inline.adj-rc-view', null,
        h('label.adj-radio', null, vSel, h('span.adj-radio-dot'), h('span', null, 'Selection')),
        h('label.adj-radio', null, vImg, h('span.adj-radio-dot'), h('span', null, 'Image'))),
      h('div.adj-sub', null, 'Replacement'),
      sliderField('Hue:', p.hue, -180, 180, v => (p.hue = v), ch, { center: 0, track: track.rainbowCenter }),
      sliderField('Saturation:', p.saturation, -100, 100, v => (p.saturation = v), ch, { center: 0 }),
      sliderField('Lightness:', p.lightness, -100, 100, v => (p.lightness = v), ch, { center: 0, track: track.three('#000', '#808080', '#fff') }),
      h('div.adj-toprow.adj-rc-result', null, h('span.adj-lbl', null, 'Result'), result),
    );
    paintPreview();
    return () => cancelAnimationFrame(raf);
  },
});

