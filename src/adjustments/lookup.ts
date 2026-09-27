// Color Lookup: built-in "looks" generated in code as 3D LUTs, plus loading .cube files (1D / 3D).
import { h } from '../ui/dom';
import { select } from '../ui/widgets';
import { toast } from '../ui/toast';
import { defineAdjustment, bakeLut3, lut3Kernel, noop, clamp01, lum01, setLum } from './lib';

interface CL { look: string; cubeName?: string; cubeText?: string; cubeId?: string }
type F = (r: number, g: number, b: number, o: Float32Array) => void;

// ---- building blocks (0..1 floats)
const S = (x: number, k: number) => { // contrast S-curve around .5 (k>0 more contrast)
  x = clamp01(x);
  const y = x < 0.5 ? 0.5 * Math.pow(2 * x, 1 + k) : 1 - 0.5 * Math.pow(2 * (1 - x), 1 + k);
  return k >= 0 ? y : 0.5 + (x - 0.5) * (1 + k);
};
const G = (x: number, g: number) => Math.pow(clamp01(x), 1 / g);
const lift = (x: number, lo: number, hi = 1) => lo + x * (hi - lo);
function sat(o: Float32Array, k: number) { const L = lum01(o[0], o[1], o[2]); o[0] = L + (o[0] - L) * k; o[1] = L + (o[1] - L) * k; o[2] = L + (o[2] - L) * k; }
/** Split toning: add shadow colour in darks and highlight colour in lights (colours as -1..1 offsets). */
function split(o: Float32Array, sh: number[], hi: number[], amt = 1) {
  const L = lum01(o[0], o[1], o[2]), ws = (1 - L) * (1 - L), wh = L * L;
  for (let i = 0; i < 3; i++) o[i] += (sh[i] * ws + hi[i] * wh) * amt;
}
const keepLum = (o: Float32Array, L: number) => setLum(o[0], o[1], o[2], L, o);
const set = (o: Float32Array, r: number, g: number, b: number) => { o[0] = r; o[1] = g; o[2] = b; };

export const LOOKS: [string, F][] = [
  ['Teal & Orange', (r, g, b, o) => {
    set(o, r, g, b);
    const L = lum01(r, g, b);
    // push shadows/cool hues to teal and skin/warm hues to orange
    const warm = clamp01((r - b) * 1.6 + 0.2);
    const tr = 0.95, tg = 0.62, tb = 0.28, cr = 0.1, cg = 0.45, cb = 0.5;
    const tint = [cr + (tr - cr) * warm, cg + (tg - cg) * warm, cb + (tb - cb) * warm];
    for (let i = 0; i < 3; i++) o[i] = o[i] * 0.72 + tint[i] * 0.28 * (0.4 + L);
    keepLum(o, S(L, 0.25));
    sat(o, 1.15);
  }],
  ['Bleach Bypass', (r, g, b, o) => {
    const L = lum01(r, g, b), c = S(L, 0.6);
    set(o, r, g, b); sat(o, 0.45); keepLum(o, c);
    for (let i = 0; i < 3; i++) o[i] = o[i] * 0.85 + c * 0.15;
  }],
  ['Candlelight', (r, g, b, o) => {
    set(o, G(r, 1.12), G(g, 0.98), G(b, 0.78));
    split(o, [0.06, 0.02, -0.04], [0.08, 0.03, -0.06]);
    sat(o, 0.9);
    for (let i = 0; i < 3; i++) o[i] = lift(o[i], 0.03, 0.97);
  }],
  ['Crisp Warm', (r, g, b, o) => {
    set(o, S(r, 0.3), S(g, 0.25), S(b, 0.2));
    set(o, o[0] * 1.04 + 0.015, o[1] * 1.01, o[2] * 0.92);
    sat(o, 1.1);
  }],
  ['Crisp Winter', (r, g, b, o) => {
    set(o, S(r, 0.25) * 0.93, S(g, 0.28) * 0.99, S(b, 0.3) * 1.04 + 0.03);
    split(o, [-0.02, 0.0, 0.05], [0.0, 0.02, 0.05]);
    sat(o, 0.92);
  }],
  ['Drop Blues', (r, g, b, o) => {
    set(o, r, g, b);
    const L = lum01(r, g, b);
    const blue = clamp01((b - Math.max(r, g)) * 3);
    for (let i = 0; i < 3; i++) o[i] = o[i] + (L - o[i]) * blue * 0.85;
    keepLum(o, S(L, 0.15));
  }],
  ['Edgy Amber', (r, g, b, o) => {
    const L = S(lum01(r, g, b), 0.55);
    set(o, r, g, b); sat(o, 0.55);
    split(o, [0.05, 0.02, -0.03], [0.14, 0.07, -0.12]);
    keepLum(o, L);
  }],
  ['Fall Colors', (r, g, b, o) => {
    set(o, r, g, b);
    const green = clamp01((g - Math.max(r, b)) * 3);
    o[0] += green * (g - r) * 0.9; o[1] -= green * (g - b) * 0.25; o[2] -= green * 0.05;
    set(o, G(o[0], 1.06), o[1], G(o[2], 0.9));
    sat(o, 1.12);
    keepLum(o, S(lum01(r, g, b), 0.12));
  }],
  ['Filmstock 50', (r, g, b, o) => {
    set(o, lift(S(r, 0.18), 0.04, 0.96), lift(S(g, 0.2), 0.035, 0.97), lift(S(b, 0.15), 0.06, 0.93));
    split(o, [0.0, 0.015, 0.03], [0.03, 0.015, -0.02]);
    sat(o, 0.9);
  }],
  ['Foggy Night', (r, g, b, o) => {
    const L = lum01(r, g, b);
    set(o, r, g, b); sat(o, 0.4);
    for (let i = 0; i < 3; i++) o[i] = lift(o[i], 0.14, 0.82);
    split(o, [-0.04, 0.0, 0.07], [0.0, 0.03, 0.06]);
    keepLum(o, lift(G(L, 0.85), 0.12, 0.8));
  }],
  ['Late Sunset', (r, g, b, o) => {
    set(o, G(r, 1.18), G(g, 0.95), G(b, 0.85));
    split(o, [0.06, -0.02, 0.06], [0.1, 0.03, -0.08]);
    sat(o, 1.15);
    keepLum(o, S(lum01(o[0], o[1], o[2]), 0.15));
  }],
  ['Moonlight', (r, g, b, o) => {
    const L = lum01(r, g, b);
    set(o, r, g, b); sat(o, 0.25);
    const l2 = G(L, 0.72) * 0.78;
    set(o, o[0] * 0.8, o[1] * 0.92, o[2] * 1.12 + 0.04);
    keepLum(o, l2);
  }],
  ['Soft Warming', (r, g, b, o) => {
    set(o, G(r, 1.07) , G(g, 1.02), G(b, 0.94));
    for (let i = 0; i < 3; i++) o[i] = lift(o[i], 0.02, 0.99);
    sat(o, 1.03);
  }],
  ['Tension Green', (r, g, b, o) => {
    const L = S(lum01(r, g, b), 0.35);
    set(o, r, g, b); sat(o, 0.6);
    split(o, [-0.03, 0.06, 0.0], [0.02, 0.08, -0.04]);
    keepLum(o, L);
  }],
  ['Futuristic Bleak', (r, g, b, o) => {
    const L = S(lum01(r, g, b), 0.45);
    set(o, r, g, b); sat(o, 0.3);
    split(o, [-0.05, 0.02, 0.05], [-0.02, 0.04, 0.04]);
    keepLum(o, lift(L, 0.05, 0.93));
  }],
  ['Horror Blue', (r, g, b, o) => {
    const L = lum01(r, g, b);
    set(o, r, g, b); sat(o, 0.35);
    set(o, o[0] * 0.75, o[1] * 0.95, o[2] * 1.2 + 0.05);
    keepLum(o, S(G(L, 0.85), 0.4) * 0.88);
  }],
  ['Night From Day', (r, g, b, o) => {
    const L = lum01(r, g, b);
    set(o, r, g, b); sat(o, 0.3);
    set(o, o[0] * 0.7, o[1] * 0.85, o[2] * 1.25 + 0.03);
    keepLum(o, Math.pow(L, 1.9) * 0.62);
  }],
];

// ---- .cube files
interface Cube { n: number; lut: Float32Array }
const cubeCache = new Map<string, Cube>();
export function hashText(s: string) {
  let h1 = 0x811c9dc5 | 0;
  for (let i = 0; i < s.length; i += 7) { h1 ^= s.charCodeAt(i); h1 = Math.imul(h1, 16777619); }
  return (h1 >>> 0).toString(36) + '-' + s.length.toString(36);
}
export function parseCube(text: string): Cube {
  let n3 = 0, n1 = 0, dmin = [0, 0, 0], dmax = [1, 1, 1];
  const vals: number[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line[0] === '#') continue;
    const up = line.toUpperCase();
    if (up.startsWith('LUT_3D_SIZE')) { n3 = parseInt(line.split(/\s+/)[1]); continue; }
    if (up.startsWith('LUT_1D_SIZE')) { n1 = parseInt(line.split(/\s+/)[1]); continue; }
    if (up.startsWith('DOMAIN_MIN')) { dmin = line.split(/\s+/).slice(1, 4).map(Number); continue; }
    if (up.startsWith('DOMAIN_MAX')) { dmax = line.split(/\s+/).slice(1, 4).map(Number); continue; }
    if (/^[A-Z_]/.test(up)) continue; // TITLE, LUT_3D_INPUT_RANGE …
    const p = line.split(/\s+/);
    if (p.length >= 3) vals.push(+p[0], +p[1], +p[2]);
  }
  const norm = (v: number, c: number) => clamp01((v - dmin[c]) / ((dmax[c] - dmin[c]) || 1)) * 255;
  if (n3 >= 2 && vals.length >= n3 * n3 * n3 * 3) {
    const lut = new Float32Array(n3 * n3 * n3 * 3);
    for (let i = 0; i < lut.length; i++) lut[i] = norm(vals[i], i % 3);
    return { n: n3, lut };
  }
  if (n1 >= 2 && vals.length >= n1 * 3) {
    const at = (c: number, x: number) => { const t = x * (n1 - 1), i = Math.min(n1 - 2, Math.floor(t)), f = t - i; return (vals[i * 3 + c] * (1 - f) + vals[(i + 1) * 3 + c] * f); };
    const lut = bakeLut3((r, g, b, o) => { o[0] = norm(at(0, r), 0) / 255; o[1] = norm(at(1, g), 1) / 255; o[2] = norm(at(2, b), 2) / 255; }, 17);
    return { n: 17, lut };
  }
  throw new Error('Not a valid .cube file (missing LUT_3D_SIZE / LUT_1D_SIZE or data).');
}
function cubeFor(p: CL): Cube | null {
  if (!p.cubeText) return null;
  const id = p.cubeId || hashText(p.cubeText);
  let c = cubeCache.get(id);
  if (!c) { try { c = parseCube(p.cubeText); } catch { return null; } cubeCache.set(id, c); }
  return c;
}

defineAdjustment<CL>({
  type: 'color-lookup', label: 'Color Lookup', icon: 'adj-lookup',
  defaults: () => ({ look: '' }),
  compile(p) {
    if (p.look === '__cube') { const c = cubeFor(p); return c ? lut3Kernel(c.lut, c.n) : noop; }
    const f = LOOKS.find(l => l[0] === p.look)?.[1];
    return f ? lut3Kernel(bakeLut3(f)) : noop;
  },
  build(el, p, change, env) {
    const file = h('input', { type: 'file', accept: '.cube,.CUBE', style: { display: 'none' } }) as HTMLInputElement;
    file.addEventListener('change', async () => {
      const f = file.files?.[0];
      if (!f) return;
      const text = await f.text();
      try { parseCube(text); } catch (err: any) { toast(err.message, 'error'); return; }
      p.look = '__cube'; p.cubeText = text; p.cubeName = f.name; p.cubeId = hashText(text);
      change(true); env.rebuild();
    });
    const opts: any[] = [{ value: '__load', label: 'Load 3D LUT...' }, '-', { value: '', label: 'None' }];
    if (p.cubeText) opts.push({ value: '__cube', label: p.cubeName || 'Loaded LUT' });
    opts.push('-', ...LOOKS.map(([n]) => ({ value: n, label: n })));
    const sel = select(opts, p.look, v => {
      if (v === '__load') { sel.setValue(p.look); file.value = ''; file.click(); return; }
      p.look = v; change(true);
    }, { width: 210, title: 'Choose a look (3D LUT) or load a .cube file' });
    el.append(
      h('div.form-row', null, h('span.adj-lbl', null, '3DLUT File'), sel),
      h('div.adj-empty', null, 'Looks are generated 3D LUTs (33³, tetrahedral interpolation). Load 3D LUT accepts Adobe/Resolve .cube files (1D or 3D).'),
      file,
    );
  },
});
