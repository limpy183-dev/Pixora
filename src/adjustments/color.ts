// Colour adjustments: Hue/Saturation, Color Balance, Black & White, Selective Color.
// All are functions of the pixel colour only → baked into a 33³ 3D LUT (fast, cached by params).
import { h, dragPointer } from '../ui/dom';
import { button, checkbox, numberField, select, slider } from '../ui/widgets';
import {
  defineAdjustment, bakeLut3, lut3Kernel, noop, clamp, clamp01, lum01, setLum, rgb2hsl, hsl2rgb,
} from './lib';
import { sliderField, radioGroup, track, dropperButton } from './ui';

// ------------------------------------------------------------------ Hue/Saturation
interface HSL3 { h: number; s: number; l: number }
interface HueRange extends HSL3 { a: number; b: number; c: number; d: number }
export interface HueSat {
  master: HSL3;
  ranges: HueRange[];            // Reds, Yellows, Greens, Cyans, Blues, Magentas
  colorize: boolean;
  cz: HSL3;                      // colorize hue 0..360, sat 0..100, light -100..100
  _edit?: number;                // -1 = Master, 0..5 = range index
}
export const HUE_RANGES = ['Reds', 'Yellows', 'Greens', 'Cyans', 'Blues', 'Magentas'];
const RANGE_DEF = [[315, 345, 15, 45], [15, 45, 75, 105], [75, 105, 135, 165], [135, 165, 195, 225], [195, 225, 255, 285], [255, 285, 315, 345]];
const hueDefaults = (): HueSat => ({
  master: { h: 0, s: 0, l: 0 },
  ranges: RANGE_DEF.map(([a, b, c, d]) => ({ h: 0, s: 0, l: 0, a, b, c, d })),
  colorize: false,
  cz: { h: 0, s: 25, l: 0 },
});
const wrap360 = (v: number) => ((v % 360) + 360) % 360;
export function rangeWeight(hue: number, r: { a: number; b: number; c: number; d: number }) {
  const t = wrap360(hue - r.a), ab = wrap360(r.b - r.a), bc = wrap360(r.c - r.b), cd = wrap360(r.d - r.c);
  if (t < ab) return ab ? t / ab : 1;
  if (t <= ab + bc) return 1;
  if (t < ab + bc + cd) return cd ? 1 - (t - ab - bc) / cd : 0;
  return 0;
}
const applyLight = (v: number, L: number) => (L > 0 ? v * (1 - L) + L : v * (1 + L));
/** Float colour function for Hue/Saturation params (used for the LUT and the output colour bar). */
export function hueSatFn(p: HueSat) {
  const hsl = new Float32Array(3);
  const active = p.ranges.filter(r => r.h || r.s || r.l);
  return (r: number, g: number, b: number, o: Float32Array | number[]) => {
    if (p.colorize) {
      const L = lum01(r, g, b);
      hsl2rgb(wrap360(p.cz.h) / 360, clamp01(p.cz.s / 100), L, o);
      const cl = p.cz.l / 100;
      if (cl) { o[0] = applyLight(o[0], cl); o[1] = applyLight(o[1], cl); o[2] = applyLight(o[2], cl); }
      return;
    }
    rgb2hsl(r, g, b, hsl);
    const hue = hsl[0] * 360;
    let dh = p.master.h, ds = 0, dl = 0;
    const sw = Math.min(1, hsl[1] * 6); // neutrals are not part of any colour range
    for (const rg of active) {
      const w = rangeWeight(hue, rg) * sw;
      if (!w) continue;
      dh += rg.h * w; ds += (rg.s / 100) * w; dl += (rg.l / 100) * w;
    }
    let s = hsl[1];
    const ms = p.master.s / 100;
    if (ms) s = ms > 0 ? s + (1 - s) * s * ms + s * ms * 0.35 : s * (1 + ms);
    if (ds) s = ds > 0 ? s + (1 - s) * s * ds + s * ds * 0.35 : s * (1 + ds);
    hsl2rgb(wrap360(hue + dh) / 360, clamp01(s), hsl[2], o);
    const L = p.master.l / 100 + dl;
    if (L) { const l = Math.max(-1, Math.min(1, L)); o[0] = applyLight(o[0], l); o[1] = applyLight(o[1], l); o[2] = applyLight(o[2], l); }
  };
}
const hsPreset = (fn: (p: HueSat) => void) => fn;
defineAdjustment<HueSat>({
  type: 'hue-saturation', label: 'Hue/Saturation', icon: 'adj-hue', dialogWidth: 520,
  defaults: hueDefaults,
  presets: [
    ['Default', () => {}],
    ['Cyanotype', hsPreset(p => { p.colorize = true; p.cz = { h: 205, s: 30, l: 0 }; })],
    ['Further Increase Saturation', hsPreset(p => { p.master.s = 40; })],
    ['Increase Saturation', hsPreset(p => { p.master.s = 20; })],
    ['Old Style', hsPreset(p => { p.master.s = -45; p.ranges[0].s = -10; p.ranges[1].h = -8; p.ranges[1].s = 10; p.master.l = -4; })],
    ['Red Boost', hsPreset(p => { p.ranges[0].s = 40; p.ranges[0].l = -4; })],
    ['Sepia', hsPreset(p => { p.colorize = true; p.cz = { h: 35, s: 25, l: 0 }; })],
    ['Strong Saturation', hsPreset(p => { p.master.s = 65; })],
    ['Yellow Boost', hsPreset(p => { p.ranges[1].s = 45; p.ranges[1].l = 5; })],
  ],
  compile(p) {
    if (!p.colorize && !p.master.h && !p.master.s && !p.master.l && p.ranges.every(r => !r.h && !r.s && !r.l)) return noop;
    return lut3Kernel(bakeLut3(hueSatFn(p)));
  },
  build(el, p, change, env) {
    const edit = () => (p.colorize ? -1 : p._edit ?? -1);
    const cur = (): HSL3 => (p.colorize ? p.cz : edit() < 0 ? p.master : p.ranges[edit()]);
    const rangeSel = select([{ value: -1, label: 'Master' }, ...HUE_RANGES.map((n, i) => ({ value: i, label: n }))], edit(), v => { p._edit = v; env.rebuild(); }, { width: 120, title: 'Color range to edit' });
    if (p.colorize) rangeSel.setAttribute('disabled', '');
    const hue = sliderField('Hue:', p.colorize ? p.cz.h : cur().h, p.colorize ? 0 : -180, p.colorize ? 360 : 180, v => { cur().h = v; paintBars(); }, change, { center: p.colorize ? undefined : 0, track: p.colorize ? track.rainbow : track.rainbowCenter });
    const sat = sliderField('Saturation:', cur().s, p.colorize ? 0 : -100, 100, v => { cur().s = v; paintBars(); }, change, { center: p.colorize ? undefined : 0, track: track.two('#7f7f7f', p.colorize ? '#ff5a3c' : '#ff1f1f') });
    const lig = sliderField('Lightness:', cur().l, -100, 100, v => { cur().l = v; paintBars(); }, change, { center: 0, track: track.three('#000', '#808080', '#fff') });

    // ---- colour bars with range handles
    const top = h('canvas.adj-hs-bar', { width: 360, height: 12 }) as HTMLCanvasElement;
    const bottom = h('canvas.adj-hs-bar', { width: 360, height: 12 }) as HTMLCanvasElement;
    const handles = h('div.adj-hs-handles');
    const rangeTxt = h('div.adj-hs-range');
    const bars = h('div.adj-hs-bars', null, top, handles, bottom);
    const offset = () => { const e = edit(); if (e < 0) return 0; const r = p.ranges[e]; return wrap360(r.b + wrap360(r.c - r.b) / 2 - 180); };
    const fn = () => hueSatFn(p);
    function paintBars() {
      const off = offset(), f = fn(), o = [0, 0, 0];
      for (const [cv, adj] of [[top, false], [bottom, true]] as const) {
        const x = cv.getContext('2d')!, img = x.createImageData(360, 1);
        for (let i = 0; i < 360; i++) {
          hsl2rgb(wrap360(i + off) / 360, 1, 0.5, o);
          if (adj) f(o[0], o[1], o[2], o);
          img.data[i * 4] = o[0] * 255; img.data[i * 4 + 1] = o[1] * 255; img.data[i * 4 + 2] = o[2] * 255; img.data[i * 4 + 3] = 255;
        }
        for (let y = 0; y < 12; y++) x.putImageData(img, 0, y);
      }
      handles.replaceChildren();
      const e = edit();
      if (e < 0) { rangeTxt.textContent = ''; return; }
      const r = p.ranges[e];
      const X = (deg: number) => (wrap360(deg - off) / 360) * 100;
      const band = (a: number, b: number, cls: string) => {
        const l = X(a), w = wrap360(b - a) / 3.6;
        handles.appendChild(h('div.adj-hs-band.' + cls, { style: { left: l + '%', width: w + '%' } }));
      };
      band(r.a, r.b, 'fall'); band(r.b, r.c, 'core'); band(r.c, r.d, 'fall');
      const mk = (k: 'a' | 'b' | 'c' | 'd', cls: string, title: string) => {
        const m = h('div.adj-hs-h.' + cls, { title, style: { left: X(r[k]) + '%' } });
        m.addEventListener('pointerdown', ev => dragRange(ev, [k]));
        handles.appendChild(m);
      };
      mk('a', 'tri', 'Drag to adjust the fall-off'); mk('b', 'bar', 'Drag to adjust the range'); mk('c', 'bar', 'Drag to adjust the range'); mk('d', 'tri', 'Drag to adjust the fall-off');
      (handles.querySelector('.adj-hs-band.core') as HTMLElement).addEventListener('pointerdown', ev => dragRange(ev, ['a', 'b', 'c', 'd']));
      rangeTxt.textContent = `${Math.round(r.a)}°/${Math.round(r.b)}°   ${Math.round(r.c)}°\\${Math.round(r.d)}°`;
    }
    function dragRange(ev: PointerEvent, keys: ('a' | 'b' | 'c' | 'd')[]) {
      ev.preventDefault(); ev.stopPropagation();
      const r = p.ranges[edit()], start = { ...r }, w = handles.getBoundingClientRect().width, off = offset();
      dragPointer(ev, dx => {
        const dd = (dx / w) * 360;
        if (keys.length === 4) for (const k of keys) r[k] = Math.round(wrap360(start[k] + dd));
        else {
          const k = keys[0], order = ['a', 'b', 'c', 'd'] as const, i = order.indexOf(k);
          // keep a ≤ b ≤ c ≤ d in the (offset) bar space
          const pos = (deg: number) => wrap360(deg - off);
          let v = pos(start[k]) + dd;
          const lo = i > 0 ? pos(r[order[i - 1]]) : 0, hi = i < 3 ? pos(r[order[i + 1]]) : 359;
          v = Math.max(lo, Math.min(hi, v));
          r[k] = Math.round(wrap360(v + off));
        }
        paintBars(); change(false);
      }, () => { paintBars(); change(true); });
    }
    const pickHue = (c: { r: number; g: number; b: number }) => { const o = [0, 0, 0]; rgb2hsl(c.r / 255, c.g / 255, c.b / 255, o); return o[0] * 360; };
    const droppers = h('div.adj-droppers', null,
      dropperButton('adj-dropper', 'Sample a color to set the range', env, c => {
        const hh = pickHue(c);
        let i = p._edit ?? -1;
        if (i < 0) { i = RANGE_DEF.findIndex(([, b, cc]) => rangeWeight(hh, { a: b, b, c: cc, d: cc }) > 0); if (i < 0) i = 0; p._edit = i; }
        const r = p.ranges[i], half = wrap360(r.c - r.b) / 2, fa = wrap360(r.b - r.a), fd = wrap360(r.d - r.c);
        r.b = Math.round(wrap360(hh - half)); r.c = Math.round(wrap360(hh + half)); r.a = Math.round(wrap360(r.b - fa)); r.d = Math.round(wrap360(r.c + fd));
        env.rebuild();
      }),
      dropperButton('adj-dropper-plus', 'Add to the range', env, c => {
        const i = p._edit ?? -1; if (i < 0) return;
        const r = p.ranges[i], hh = pickHue(c);
        if (rangeWeight(hh, { a: r.b, b: r.b, c: r.c, d: r.c }) > 0) return;
        const fa = wrap360(r.b - r.a), fd = wrap360(r.d - r.c);
        if (wrap360(hh - r.c) < wrap360(r.b - hh)) { r.c = Math.round(hh); r.d = Math.round(wrap360(hh + fd)); } else { r.b = Math.round(hh); r.a = Math.round(wrap360(hh - fa)); }
        env.rebuild();
      }),
      dropperButton('adj-dropper-minus', 'Subtract from the range', env, c => {
        const i = p._edit ?? -1; if (i < 0) return;
        const r = p.ranges[i], hh = pickHue(c);
        if (!(rangeWeight(hh, { a: r.b, b: r.b, c: r.c, d: r.c }) > 0)) return;
        const fa = wrap360(r.b - r.a), fd = wrap360(r.d - r.c);
        if (wrap360(hh - r.b) < wrap360(r.c - hh)) { r.b = Math.round(wrap360(hh + 1)); r.a = Math.round(wrap360(r.b - fa)); } else { r.c = Math.round(wrap360(hh - 1)); r.d = Math.round(wrap360(r.c + fd)); }
        env.rebuild();
      }));
    el.append(
      h('div.adj-toprow', null, rangeSel),
      hue, sat, lig,
      h('div.adj-hs-foot', null,
        checkbox('Colorize', p.colorize, v => { p.colorize = v; change(true); env.rebuild(); }, { title: 'Replace the colors with a single hue' }),
        droppers),
      rangeTxt, bars,
    );
    requestAnimationFrame(paintBars);
    paintBars();
  },
});

// ------------------------------------------------------------------ Color Balance
type Tri = [number, number, number];
interface CB { shadows: Tri; midtones: Tri; highlights: Tri; preserveLuminosity: boolean; _tone?: 'shadows' | 'midtones' | 'highlights' }
function cbTransfer(v: number, s: number, m: number, hh: number) {
  const a = 0.25, b = 0.333, sc = 0.7;
  const sw = clamp01((v - b) / -a + 0.5) * sc;
  const mw = clamp01((v - b) / a + 0.5) * clamp01((v + b - 1) / -a + 0.5) * sc;
  const hw = clamp01((v + b - 1) / a + 0.5) * sc;
  return clamp01(v + s * sw + m * mw + hh * hw);
}
function cbRow(l: string, r: string, t: Tri, i: number, change: (f?: boolean) => void, tr: string) {
  const num = numberField(t[i], v => { t[i] = v; sl.setValue(v); change(true); }, { min: -100, max: 100, width: 48, title: `${l} – ${r}` });
  const sl = slider(t[i], -100, 100, v => { t[i] = v; num.setValue(v); change(false); }, { onChange: () => change(true), track: tr, center: 0 });
  return h('div.adj-cb', null, h('span.adj-cb-l', null, l), sl, h('span.adj-cb-r', null, r), num);
}
defineAdjustment<CB>({
  type: 'color-balance', label: 'Color Balance', icon: 'adj-balance',
  defaults: () => ({ shadows: [0, 0, 0], midtones: [0, 0, 0], highlights: [0, 0, 0], preserveLuminosity: true }),
  compile(p) {
    if ([...p.shadows, ...p.midtones, ...p.highlights].every(v => !v)) return noop;
    const S = p.shadows.map(v => v / 100), M = p.midtones.map(v => v / 100), H = p.highlights.map(v => v / 100);
    return lut3Kernel(bakeLut3((r, g, b, o) => {
      const nr = cbTransfer(r, S[0], M[0], H[0]), ng = cbTransfer(g, S[1], M[1], H[1]), nb = cbTransfer(b, S[2], M[2], H[2]);
      if (p.preserveLuminosity) setLum(nr, ng, nb, lum01(r, g, b), o); else { o[0] = nr; o[1] = ng; o[2] = nb; }
    }));
  },
  build(el, p, change, env) {
    const tone = p._tone || 'midtones';
    const t = p[tone];
    el.append(
      h('div.form-row', null, h('span.adj-lbl', null, 'Tone:'),
        select([{ value: 'shadows', label: 'Shadows' }, { value: 'midtones', label: 'Midtones' }, { value: 'highlights', label: 'Highlights' }], tone, v => { p._tone = v as CB['_tone']; env.rebuild(); }, { width: 120, title: 'Tonal range' })),
      cbRow('Cyan', 'Red', t, 0, change, track.two('#00e0e0', '#ff2020')),
      cbRow('Magenta', 'Green', t, 1, change, track.two('#ff20ff', '#20e020')),
      cbRow('Yellow', 'Blue', t, 2, change, track.two('#f0f000', '#2040ff')),
      checkbox('Preserve Luminosity', p.preserveLuminosity, v => { p.preserveLuminosity = v; change(true); }, { title: 'Keep the image brightness unchanged' }),
    );
  },
});

// ------------------------------------------------------------------ Black & White
interface BW { reds: number; yellows: number; greens: number; cyans: number; blues: number; magentas: number; tint: boolean; tintHue: number; tintSat: number }
const BW_KEYS = ['reds', 'yellows', 'greens', 'cyans', 'blues', 'magentas'] as const;
const bwSet = (v: number[]) => (p: BW) => BW_KEYS.forEach((k, i) => (p[k] = v[i]));
/** Photoshop's B&W mix: grey = min + (mid−min)·secondary + (max−mid)·primary. */
export function bwGray(r: number, g: number, b: number, w: number[]) {
  // w: reds, yellows, greens, cyans, blues, magentas (fractions)
  let mx: number, md: number, mn: number, prim: number, sec: number;
  if (r >= g && r >= b) { mx = r; prim = w[0]; if (g >= b) { md = g; mn = b; sec = w[1]; } else { md = b; mn = g; sec = w[5]; } }
  else if (g >= r && g >= b) { mx = g; prim = w[2]; if (r >= b) { md = r; mn = b; sec = w[1]; } else { md = b; mn = r; sec = w[3]; } }
  else { mx = b; prim = w[4]; if (r >= g) { md = r; mn = g; sec = w[5]; } else { md = g; mn = r; sec = w[3]; } }
  return mn + (md - mn) * sec + (mx - md) * prim;
}
defineAdjustment<BW>({
  type: 'black-white', label: 'Black & White', icon: 'adj-bw', dialogWidth: 520,
  defaults: () => ({ reds: 40, yellows: 60, greens: 40, cyans: 60, blues: 20, magentas: 80, tint: false, tintHue: 42, tintSat: 20 }),
  presets: [
    ['Default', () => {}],
    ['Blue Filter', bwSet([-10, 20, 30, 110, 130, 110])],
    ['Darker', bwSet([25, 45, 25, 45, 5, 65])],
    ['Green Filter', bwSet([40, 110, 120, 110, -10, 20])],
    ['High Contrast Blue Filter', bwSet([-50, -50, 50, 150, 200, 150])],
    ['High Contrast Red Filter', bwSet([120, 120, -10, -50, -50, 120])],
    ['Infrared', bwSet([-40, 235, 144, -68, -3, -107])],
    ['Lighter', bwSet([55, 75, 55, 75, 35, 95])],
    ['Maximum Black', bwSet([0, 0, 0, 0, 0, 0])],
    ['Maximum White', bwSet([100, 100, 100, 100, 100, 100])],
    ['Neutral Density', bwSet([50, 50, 50, 50, 50, 50])],
    ['Red Filter', bwSet([120, 110, -10, -50, -50, 120])],
    ['Yellow Filter', bwSet([120, 110, 40, -30, 0, 70])],
  ],
  compile(p) {
    const w = BW_KEYS.map(k => p[k] / 100);
    const tc = [0, 0, 0];
    hsl2rgb(p.tintHue / 360, 1, 0.5, tc);
    const ts = p.tint ? p.tintSat / 100 : 0, o2 = [0, 0, 0];
    return lut3Kernel(bakeLut3((r, g, b, o) => {
      const v = clamp01(bwGray(r, g, b, w));
      if (ts) { setLum(tc[0], tc[1], tc[2], v, o2); o[0] = v + (o2[0] - v) * ts; o[1] = v + (o2[1] - v) * ts; o[2] = v + (o2[2] - v) * ts; }
      else o[0] = o[1] = o[2] = v;
    }));
  },
  build(el, p, change, env) {
    const cols = ['#ff3b3b', '#ffe53b', '#3bd43b', '#3be5ff', '#3b6bff', '#ff3bff'];
    const lbl = ['Reds:', 'Yellows:', 'Greens:', 'Cyans:', 'Blues:', 'Magentas:'];
    const auto = button('Auto', () => {
      // spread the grey values: weight each hue family by how bright/dark it is relative to the image mean
      const img = env.stats();
      if (!img) return;
      const d = img.data, sum = new Float64Array(6), cnt = new Float64Array(6), o = [0, 0, 0];
      let mean = 0, n = 0;
      for (let i = 0; i < d.length; i += 4) {
        const r = d[i] / 255, g = d[i + 1] / 255, b = d[i + 2] / 255;
        rgb2hsl(r, g, b, o);
        const L = lum01(r, g, b);
        mean += L; n++;
        if (o[1] < 0.12) continue;
        const k = Math.round(o[0] * 6) % 6;
        sum[k] += L * o[1]; cnt[k] += o[1];
      }
      mean /= n || 1;
      BW_KEYS.forEach((k, i) => {
        const avg = cnt[i] ? sum[i] / cnt[i] : mean;
        p[k] = Math.round(clamp(50 + (avg - mean) * 160 + [0, 10, 0, 10, -20, 20][i], -200, 300));
      });
      env.rebuild();
    }, { title: 'Auto: set a grayscale mix that maximises the tonal range', cls: 'small' });
    el.append(h('div.adj-toprow', null, auto));
    BW_KEYS.forEach((k, i) => el.append(sliderField(lbl[i], p[k], -200, 300, v => (p[k] = v), change, { unit: '%', track: track.two('#000', cols[i]) })));
    el.append(
      checkbox('Tint', p.tint, v => { p.tint = v; change(true); env.rebuild(); }, { title: 'Apply a color tone to the grayscale image' }),
      sliderField('Hue', p.tintHue, 0, 360, v => (p.tintHue = v), change, { unit: '°', track: track.rainbow }),
      sliderField('Saturation', p.tintSat, 0, 100, v => (p.tintSat = v), change, { unit: '%' }),
    );
    if (!p.tint) el.querySelectorAll('.adj-slider').forEach((s, i) => { if (i >= 6) s.classList.add('disabled'); });
  },
});

// ------------------------------------------------------------------ Selective Color
interface CMYK { c: number; m: number; y: number; k: number }
const SC_COLORS = ['reds', 'yellows', 'greens', 'cyans', 'blues', 'magentas', 'whites', 'neutrals', 'blacks'] as const;
type SCKey = typeof SC_COLORS[number];
interface SC { colors: Record<SCKey, CMYK>; method: 'relative' | 'absolute'; _color?: SCKey }
defineAdjustment<SC>({
  type: 'selective-color', label: 'Selective Color', icon: 'adj-selective',
  defaults: () => ({ colors: Object.fromEntries(SC_COLORS.map(k => [k, { c: 0, m: 0, y: 0, k: 0 }])) as Record<SCKey, CMYK>, method: 'relative' }),
  compile(p) {
    const act = SC_COLORS.map(k => p.colors[k]).map((v, i) => ({ i, c: v.c / 100, m: v.m / 100, y: v.y / 100, k: v.k / 100 })).filter(v => v.c || v.m || v.y || v.k);
    if (!act.length) return noop;
    const rel = p.method === 'relative';
    const w = new Float32Array(9);
    return lut3Kernel(bakeLut3((r, g, b, o) => {
      const mx = Math.max(r, g, b), mn = Math.min(r, g, b), md = r + g + b - mx - mn;
      w.fill(0);
      if (mx === r && r > mn) w[0] = mx - md;
      if (mn === b && b < mx) w[1] = md - mn;
      if (mx === g && g > mn && mx !== r) w[2] = mx - md;
      if (mn === r && r < mx) w[3] = md - mn;
      if (mx === b && b > mn && mx !== r && mx !== g) w[4] = mx - md;
      if (mn === g && g < mx && mn !== b) w[5] = md - mn;
      w[6] = mn > 0.5 ? (mn - 0.5) * 2 : 0;
      w[7] = clamp01(1 - (Math.abs(mx - 0.5) + Math.abs(mn - 0.5)));
      w[8] = mx < 0.5 ? (0.5 - mx) * 2 : 0;
      const ch = [r, g, b];
      for (const a of act) {
        const wt = w[a.i];
        if (!wt) continue;
        const inks = [a.c, a.m, a.y];
        for (let j = 0; j < 3; j++) {
          const v = ch[j], ink = 1 - v;
          let ni = rel ? ink + ink * inks[j] : ink + inks[j];
          ni = clamp01(ni);
          // black: adds/removes ink on all channels
          ni = a.k > 0 ? ni + (1 - ni) * a.k * (rel ? (1 - v * 0.5) : 1) : ni * (1 + a.k);
          ch[j] = v + (1 - clamp01(ni) - v) * wt;
        }
      }
      o[0] = ch[0]; o[1] = ch[1]; o[2] = ch[2];
    }));
  },
  build(el, p, change, env) {
    const key = p._color || 'reds';
    const v = p.colors[key];
    const names = ['Reds', 'Yellows', 'Greens', 'Cyans', 'Blues', 'Magentas', 'Whites', 'Neutrals', 'Blacks'];
    el.append(
      h('div.form-row', null, h('span.adj-lbl', null, 'Colors:'),
        select(SC_COLORS.map((k, i) => ({ value: k, label: names[i] })), key, k => { p._color = k; env.rebuild(); }, { width: 130, title: 'Color to adjust' })),
      sliderField('Cyan:', v.c, -100, 100, x => (v.c = x), change, { unit: '%', center: 0, track: track.two('#fff', '#00b7eb') }),
      sliderField('Magenta:', v.m, -100, 100, x => (v.m = x), change, { unit: '%', center: 0, track: track.two('#fff', '#ec008c') }),
      sliderField('Yellow:', v.y, -100, 100, x => (v.y = x), change, { unit: '%', center: 0, track: track.two('#fff', '#ffe600') }),
      sliderField('Black:', v.k, -100, 100, x => (v.k = x), change, { unit: '%', center: 0, track: track.gray }),
      radioGroup('Method', [['relative', 'Relative'], ['absolute', 'Absolute']], p.method, m => { p.method = m as SC['method']; change(true); }, 'inline'),
    );
  },
});

