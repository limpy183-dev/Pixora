// Edit › Sky Replacement: detects the sky of the active pixel layer and replaces it with a preset sky (generated
// procedurally — Blue Skies, Spectacular, Sunsets) or an imported image. Sky Move tool (drag the sky), Sky Brush
// (extend the sky area, Alt reduces), Shift / Fade Edge, sky Brightness / Temperature / Scale / Flip, Foreground
// Lighting (Multiply / Screen), Edge Lighting and Color Adjustment. Output: new layers in a group (Sky, Sky
// Replacement Color, Foreground Lighting — all with masks, fully editable) or a flattened duplicate layer.
import './sky.css';
import { app } from '../../core/app';
import { registerCommands } from '../../core/commands';
import { GroupLayer, RasterLayer, createMask } from '../../core/layer';
import { createCanvas, ctx2d } from '../../core/canvas';
import type { RGB } from '../../core/types';
import { h } from '../../ui/dom';
import { icon } from '../../ui/icons';
import { checkbox, select } from '../../ui/widgets';
import { toast } from '../../ui/toast';
import { openWorkspace, wsSection, wsSlider, type PointerInfo } from '../../filters/special/workspace';
import { detectSky } from '../selection/ops';

// ------------------------------------------------------------------ procedural skies
interface SkySpec { name: string; cat: 'Blue Skies' | 'Spectacular' | 'Sunsets'; top: number[]; mid: number[]; hor: number[]; cover: number; soft: number; light: number[]; shade: number[]; stretch: number; scale: number; sun?: { x: number; y: number; r: number; c: number[]; k: number }; seed: number }
const SKIES: SkySpec[] = [
  { name: 'Clear Blue', cat: 'Blue Skies', top: [38, 96, 186], mid: [88, 150, 222], hor: [196, 222, 244], cover: 0.18, soft: 0.25, light: [255, 255, 255], shade: [200, 212, 230], stretch: 3.2, scale: 3, seed: 11 },
  { name: 'Fair Weather', cat: 'Blue Skies', top: [30, 90, 180], mid: [76, 142, 216], hor: [182, 212, 238], cover: 0.46, soft: 0.14, light: [255, 255, 255], shade: [150, 166, 192], stretch: 1.6, scale: 4, seed: 23 },
  { name: 'High Cirrus', cat: 'Blue Skies', top: [46, 104, 190], mid: [104, 160, 226], hor: [208, 228, 246], cover: 0.36, soft: 0.34, light: [250, 252, 255], shade: [214, 224, 240], stretch: 6, scale: 2.4, seed: 37 },
  { name: 'Storm Front', cat: 'Spectacular', top: [40, 46, 58], mid: [78, 88, 104], hor: [150, 158, 166], cover: 0.72, soft: 0.2, light: [196, 200, 206], shade: [52, 56, 66], stretch: 2, scale: 3.4, seed: 41 },
  { name: 'Dramatic Clouds', cat: 'Spectacular', top: [24, 60, 124], mid: [70, 116, 176], hor: [200, 196, 190], cover: 0.58, soft: 0.1, light: [255, 250, 240], shade: [70, 80, 104], stretch: 1.8, scale: 3.6, sun: { x: 0.72, y: 0.35, r: 0.28, c: [255, 236, 190], k: 0.55 }, seed: 53 },
  { name: 'Golden Rays', cat: 'Spectacular', top: [60, 70, 110], mid: [160, 130, 120], hor: [250, 200, 130], cover: 0.5, soft: 0.16, light: [255, 222, 160], shade: [96, 78, 88], stretch: 2.2, scale: 3, sun: { x: 0.5, y: 0.62, r: 0.35, c: [255, 214, 140], k: 0.9 }, seed: 67 },
  { name: 'Warm Sunset', cat: 'Sunsets', top: [52, 58, 120], mid: [226, 120, 90], hor: [255, 196, 110], cover: 0.34, soft: 0.2, light: [255, 170, 110], shade: [120, 60, 80], stretch: 3.4, scale: 3, sun: { x: 0.35, y: 0.86, r: 0.3, c: [255, 220, 150], k: 1 }, seed: 71 },
  { name: 'Pink Dusk', cat: 'Sunsets', top: [70, 64, 140], mid: [206, 126, 170], hor: [255, 190, 170], cover: 0.4, soft: 0.22, light: [255, 184, 196], shade: [110, 80, 130], stretch: 3, scale: 3.2, sun: { x: 0.62, y: 0.92, r: 0.25, c: [255, 210, 190], k: 0.7 }, seed: 83 },
  { name: 'Twilight', cat: 'Sunsets', top: [14, 20, 58], mid: [70, 60, 130], hor: [236, 150, 100], cover: 0.26, soft: 0.2, light: [230, 150, 140], shade: [40, 36, 80], stretch: 4, scale: 2.8, sun: { x: 0.5, y: 1, r: 0.4, c: [255, 170, 100], k: 0.8 }, seed: 97 },
];
function hash(x: number, y: number, s: number) { let n = (x * 374761393 + y * 668265263 + s * 982451653) | 0; n = (n ^ (n >>> 13)) * 1274126177; return ((n ^ (n >>> 16)) >>> 0) / 4294967296; }
function vnoise(x: number, y: number, s: number) {
  const xi = Math.floor(x), yi = Math.floor(y), fx = x - xi, fy = y - yi, ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy);
  const a = hash(xi, yi, s), b = hash(xi + 1, yi, s), c = hash(xi, yi + 1, s), d = hash(xi + 1, yi + 1, s);
  return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy;
}
function fbm(x: number, y: number, s: number, oct = 5) { let v = 0, a = 0.5, f = 1, n = 0; for (let i = 0; i < oct; i++) { v += a * vnoise(x * f, y * f, s + i * 17); n += a; a *= 0.5; f *= 2.03; } return v / n; }
const sstep = (a: number, b: number, x: number) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
/** Resolution-independent sky rendering (so thumbnails match the full sky). */
function renderSky(sp: SkySpec, W: number, H: number): HTMLCanvasElement {
  const c = createCanvas(W, H), x = ctx2d(c), img = x.createImageData(W, H), d = img.data;
  const oct = W > 400 ? 6 : 4;
  for (let Y = 0; Y < H; Y++) {
    const v = (Y + 0.5) / H;
    const g = v < 0.6 ? v / 0.6 : (v - 0.6) / 0.4;
    const A = v < 0.6 ? sp.top : sp.mid, B = v < 0.6 ? sp.mid : sp.hor;
    const br = A[0] + (B[0] - A[0]) * g, bg = A[1] + (B[1] - A[1]) * g, bb = A[2] + (B[2] - A[2]) * g;
    const f = sp.scale * (1 + v * 1.6);                       // clouds get smaller towards the horizon
    for (let X = 0; X < W; X++) {
      const u = (X + 0.5) / W;
      let r = br, gg = bg, b = bb;
      if (sp.sun) { const dx = (u - sp.sun.x) * 1.7, dy = v - sp.sun.y, e = Math.exp(-(dx * dx + dy * dy) / (sp.sun.r * sp.sun.r)) * sp.sun.k; r += (sp.sun.c[0] - r) * e; gg += (sp.sun.c[1] - gg) * e; b += (sp.sun.c[2] - b) * e; }
      const nx = (u * f * 1.7) / (sp.stretch / 2), ny = v * f * 2.2;
      const n = fbm(nx, ny, sp.seed, oct);
      const dens = sstep(1 - sp.cover, 1 - sp.cover + sp.soft, n) * 0.96;
      if (dens > 0.002) {
        const up = fbm(nx, ny - 0.18, sp.seed, oct - 1);          // lit tops, shaded undersides
        const sh = Math.max(0, Math.min(1, (n - up) * 5 + 0.45));
        const cr = sp.light[0] + (sp.shade[0] - sp.light[0]) * sh, cg = sp.light[1] + (sp.shade[1] - sp.light[1]) * sh, cb = sp.light[2] + (sp.shade[2] - sp.light[2]) * sh;
        r += (cr - r) * dens; gg += (cg - gg) * dens; b += (cb - b) * dens;
      }
      const i = (Y * W + X) * 4;
      d[i] = r; d[i + 1] = gg; d[i + 2] = b; d[i + 3] = 255;
    }
  }
  x.putImageData(img, 0, 0);
  return c;
}
interface SkyItem { id: string; name: string; cat: string; thumb: HTMLCanvasElement; full(): HTMLCanvasElement }
const fullCache = new Map<string, HTMLCanvasElement>();
const customs: SkyItem[] = [];
let thumbs: SkyItem[] | null = null;
function presetItems(): SkyItem[] {
  if (!thumbs) thumbs = SKIES.map(sp => ({ id: sp.name, name: sp.name, cat: sp.cat, thumb: renderSky(sp, 112, 64), full: () => { let c = fullCache.get(sp.name); if (!c) { c = renderSky(sp, 1600, 900); fullCache.set(sp.name, c); } return c; } }));
  return thumbs;
}

// ------------------------------------------------------------------ mask maths (work resolution)
function blur(src: Float32Array, W: number, H: number, r: number): Float32Array {
  r = Math.round(r);
  if (r < 1) return src.slice();
  const tmp = new Float32Array(W * H), out = new Float32Array(W * H), n = 2 * r + 1;
  let inp: Float32Array = src;
  for (let pass = 0; pass < 2; pass++) {
    for (let y = 0; y < H; y++) { let s = 0; const o = y * W; for (let x = -r; x <= r; x++) s += inp[o + Math.min(W - 1, Math.max(0, x))]; for (let x = 0; x < W; x++) { tmp[o + x] = s / n; s += inp[o + Math.min(W - 1, x + r + 1)] - inp[o + Math.max(0, x - r)]; } }
    for (let x = 0; x < W; x++) { let s = 0; for (let y = -r; y <= r; y++) s += tmp[Math.min(H - 1, Math.max(0, y)) * W + x]; for (let y = 0; y < H; y++) { out[y * W + x] = s / n; s += tmp[Math.min(H - 1, y + r + 1) * W + x] - tmp[Math.max(0, y - r) * W + x]; } }
    inp = out.slice();
  }
  return out;
}
const alphaCanvas = (a: Float32Array, W: number, H: number) => {
  const c = createCanvas(W, H), x = ctx2d(c), img = x.createImageData(W, H);
  for (let i = 0; i < W * H; i++) img.data[i * 4 + 3] = Math.round(Math.max(0, Math.min(1, a[i])) * 255);
  x.putImageData(img, 0, 0);
  return c;
};

// ------------------------------------------------------------------ state
const P = { shift: 0, fade: 0, bright: 0, temp: 0, scale: 100, flip: false, mode: 'multiply' as 'multiply' | 'screen', fgLight: 50, edgeLight: 50, color: 50, output: 'layers' as 'layers' | 'duplicate', brush: 120, sky: 'Fair Weather' };
try { Object.assign(P, JSON.parse(localStorage.getItem('pixora.skyReplace') || '{}')); } catch { /* ignore */ }
interface Session {
  doc: NonNullable<typeof app.activeDoc>; layer: RasterLayer;
  W: number; H: number; k: number;                  // work resolution and scale (work px = doc px × k)
  fg: HTMLCanvasElement;                            // layer pixels at work size
  base: Float32Array; edit: Float32Array;           // detected sky + brush edits (−1..1)
  offX: number; offY: number;                       // sky offset in doc px
  sky: SkyItem;
}
/** Final sky mask after brush edits, Shift Edge and Fade Edge (at W×H, scale k). */
function skyMask(s: Session, W = s.W, H = s.H, k = s.k): Float32Array {
  let m: Float32Array = new Float32Array(W * H);
  if (W === s.W && H === s.H) for (let i = 0; i < m.length; i++) m[i] = Math.max(0, Math.min(1, s.base[i] + s.edit[i]));
  else {
    const c = createCanvas(W, H), x = c.getContext('2d', { willReadFrequently: true })!;
    x.imageSmoothingQuality = 'high'; x.drawImage(alphaCanvas(skyMask(s, s.W, s.H, s.k), s.W, s.H), 0, 0, W, H);
    const d = x.getImageData(0, 0, W, H).data;
    for (let i = 0; i < m.length; i++) m[i] = d[i * 4 + 3] / 255;
    return m;                                       // shift / fade already applied at work size
  }
  const unit = Math.max(W, H) / 1000;
  if (P.shift) {
    const mb = blur(m, W, H, 2 + (Math.abs(P.shift) * 0.14 * unit));
    const th = 0.5 - Math.sign(P.shift) * 0.42 * (Math.abs(P.shift) / 100);
    for (let i = 0; i < m.length; i++) m[i] = Math.max(0, Math.min(1, (mb[i] - th) / 0.1 + 0.5));
  }
  m = blur(m, W, H, Math.max(1, P.fade * 0.25 * unit));
  void k;
  return m;
}
function horizon(m: Float32Array, W: number, H: number) {
  // lowest row where at least a quarter of the row is sky
  for (let y = H - 1; y >= 0; y--) { let s = 0; for (let x = 0; x < W; x += 2) s += m[y * W + x]; if (s / (W / 2) > 0.25) return (y + 1) / H; }
  return 0.35;
}
function adjustedSky(src: HTMLCanvasElement, w: number, hh: number): HTMLCanvasElement {
  const c = createCanvas(Math.max(1, Math.round(w)), Math.max(1, Math.round(hh))), x = c.getContext('2d', { willReadFrequently: true })!;
  x.imageSmoothingQuality = 'high';
  if (P.flip) { x.translate(c.width, 0); x.scale(-1, 1); }
  x.drawImage(src, 0, 0, c.width, c.height);
  x.setTransform(1, 0, 0, 1, 0, 0);
  if (P.bright || P.temp) {
    const img = x.getImageData(0, 0, c.width, c.height), d = img.data, b = P.bright / 100, t = P.temp / 100;
    for (let i = 0; i < d.length; i += 4) {
      let r = d[i], g = d[i + 1], bl = d[i + 2];
      if (b > 0) { r += (255 - r) * b * 0.6; g += (255 - g) * b * 0.6; bl += (255 - bl) * b * 0.6; } else if (b < 0) { r *= 1 + b * 0.7; g *= 1 + b * 0.7; bl *= 1 + b * 0.7; }
      r += t * 40; g += t * 8; bl -= t * 40;
      d[i] = r; d[i + 1] = g; d[i + 2] = bl;
    }
    x.putImageData(img, 0, 0);
  }
  return c;
}
/** All the parts at a given size: sky image (placed), masks and the lighting colour. */
function parts(s: Session, W: number, H: number, k: number) {
  const m = skyMask(s, W, H, k);
  const src = s.sky.full();
  // cover the sky area: full width × scale, bottom a little below the horizon, top above the frame
  const hz = horizon(m, W, H) * H;
  // (25 % wider than the frame so the Sky Move tool has room; the offset is clamped so the sky always covers)
  let sw = W * 1.25 * (P.scale / 100), sh = (src.height / src.width) * sw;
  const needH = hz + H * 0.06;
  if (sh < needH) { const f = needH / sh; sw *= f; sh *= f; }
  if (sw < W) { const f = W / sw; sw *= f; sh *= f; }
  const cx = Math.max(W - sw, Math.min(0, (W - sw) / 2 + s.offX * k));
  const cy = Math.max(needH - sh, Math.min(0, Math.min(0, needH - sh) + s.offY * k));
  s.offX = (cx - (W - sw) / 2) / k; s.offY = (cy - Math.min(0, needH - sh)) / k;
  const sx = cx, sy = cy;
  const skyImg = adjustedSky(src, sw, sh);
  const sky = createCanvas(W, H), kx = ctx2d(sky);
  kx.drawImage(skyImg, sx, sy);
  // lighting colour: average of the lower part of the visible sky
  const probe = createCanvas(16, 8), px = probe.getContext('2d', { willReadFrequently: true })!;
  px.drawImage(skyImg, 0, skyImg.height * 0.55, skyImg.width, skyImg.height * 0.45, 0, 0, 16, 8);
  const pd = px.getImageData(0, 0, 16, 8).data, avg: RGB = { r: 0, g: 0, b: 0 };
  for (let i = 0; i < pd.length; i += 4) { avg.r += pd[i]; avg.g += pd[i + 1]; avg.b += pd[i + 2]; }
  avg.r = Math.round(avg.r / 128); avg.g = Math.round(avg.g / 128); avg.b = Math.round(avg.b / 128);
  // foreground masks: colour = everything but the sky; lighting additionally stronger near the sky edge
  const unit = Math.max(W, H) / 1000;
  const eb = blur(m, W, H, 40 * unit);
  const fgM = new Float32Array(W * H), lightM = new Float32Array(W * H);
  for (let i = 0; i < m.length; i++) { const f = 1 - m[i]; fgM[i] = f; lightM[i] = f * Math.min(1, 0.3 + (P.edgeLight / 100) * Math.min(1, eb[i] * 2.2) * 1.4); }
  return { sky, skyMask: alphaCanvas(m, W, H), colorMask: alphaCanvas(fgM, W, H), lightMask: alphaCanvas(lightM, W, H), avg };
}
function solid(W: number, H: number, c: RGB, mask: HTMLCanvasElement) {
  const o = createCanvas(W, H), x = ctx2d(o);
  x.fillStyle = `rgb(${c.r},${c.g},${c.b})`; x.fillRect(0, 0, W, H);
  x.globalCompositeOperation = 'destination-in'; x.drawImage(mask, 0, 0);
  return o;
}
/** Flattened result (preview or Duplicate Layer output), same stacking as the layer output. */
function flatten(fg: HTMLCanvasElement, pr: ReturnType<typeof parts>) {
  const W = fg.width, H = fg.height, out = createCanvas(W, H), x = ctx2d(out);
  x.drawImage(fg, 0, 0);
  const sk = createCanvas(W, H), sx = ctx2d(sk);
  sx.drawImage(pr.sky, 0, 0); sx.globalCompositeOperation = 'destination-in'; sx.drawImage(pr.skyMask, 0, 0);
  x.drawImage(sk, 0, 0);
  x.globalAlpha = (P.color / 100) * 0.6; x.globalCompositeOperation = 'color'; x.drawImage(solid(W, H, pr.avg, pr.colorMask), 0, 0);
  x.globalAlpha = P.fgLight / 100; x.globalCompositeOperation = P.mode; x.drawImage(solid(W, H, pr.avg, pr.lightMask), 0, 0);
  x.globalAlpha = 1; x.globalCompositeOperation = 'destination-in'; x.drawImage(fg, 0, 0);   // keep the layer's transparency
  return out;
}

// ------------------------------------------------------------------ dialog
async function skyReplacement() {
  const doc = app.activeDoc;
  if (!doc) return;
  const layer = doc.activeLayer;
  if (!(layer instanceof RasterLayer)) { toast('Could not complete the Sky Replacement command because the layer is not a pixel layer.', 'error', 4000); return; }
  if (!layer.visible) { toast('Could not complete the Sky Replacement command because the layer is hidden.', 'error'); return; }
  document.body.classList.add('busy');
  await new Promise(r => setTimeout(r, 20));
  const k = Math.min(1, 1000 / Math.max(doc.width, doc.height)), W = Math.max(1, Math.round(doc.width * k)), H = Math.max(1, Math.round(doc.height * k));
  const fg = createCanvas(W, H), fx = ctx2d(fg);
  fx.imageSmoothingQuality = 'high'; fx.setTransform(k, 0, 0, k, 0, 0); fx.drawImage(layer.canvas, layer.x, layer.y);
  const det = detectSky(doc);
  const base = new Float32Array(W * H);
  if (det) {
    const c = createCanvas(doc.width, doc.height), cx = ctx2d(c), img = cx.createImageData(doc.width, doc.height);
    for (let i = 0; i < det.length; i++) img.data[i * 4 + 3] = det[i];
    cx.putImageData(img, 0, 0);
    const sm = createCanvas(W, H), sx = sm.getContext('2d', { willReadFrequently: true })!;
    sx.imageSmoothingQuality = 'high'; sx.drawImage(c, 0, 0, W, H);
    const d = sx.getImageData(0, 0, W, H).data;
    for (let i = 0; i < base.length; i++) base[i] = d[i * 4 + 3] / 255;
  }
  document.body.classList.remove('busy');
  const items = presetItems();
  const s: Session = { doc, layer, W, H, k, fg, base, edit: new Float32Array(W * H), offX: 0, offY: 0, sky: [...items, ...customs].find(i => i.id === P.sky) || items[1] };

  // ---- side panel
  let preview = true;
  const skyGrid = h('div.sr-grid');
  const drawGrid = () => {
    skyGrid.replaceChildren();
    for (const cat of ['Blue Skies', 'Spectacular', 'Sunsets', 'Custom']) {
      const list = cat === 'Custom' ? customs : items.filter(i => i.cat === cat);
      if (!list.length && cat !== 'Custom') continue;
      skyGrid.append(h('div.sr-cat', null, cat));
      const row = h('div.sr-row');
      for (const it of list) {
        const b = h('button.sr-thumb', { type: 'button', title: it.name, class: it === s.sky ? 'on' : '', onclick: () => { s.sky = it; P.sky = it.id; drawGrid(); update(); } });
        const t = createCanvas(it.thumb.width, it.thumb.height); ctx2d(t).drawImage(it.thumb, 0, 0); b.append(t);
        row.append(b);
      }
      if (cat === 'Custom') row.append(h('button.sr-thumb.sr-add', { type: 'button', title: 'Import a sky image…', onclick: importSky }, icon('plus', 20)));
      skyGrid.append(row);
    }
  };
  const importSky = () => {
    const inp = h('input', { type: 'file', accept: 'image/*' }) as HTMLInputElement;
    inp.onchange = async () => {
      const f = inp.files?.[0];
      if (!f) return;
      try {
        const bmp = await createImageBitmap(f);
        const full = createCanvas(bmp.width, bmp.height); ctx2d(full).drawImage(bmp, 0, 0);
        const th = createCanvas(112, 64), tx = ctx2d(th), sc = Math.max(112 / bmp.width, 64 / bmp.height);
        tx.drawImage(bmp, (112 - bmp.width * sc) / 2, (64 - bmp.height * sc) / 2, bmp.width * sc, bmp.height * sc);
        const it: SkyItem = { id: 'custom:' + f.name + ':' + customs.length, name: f.name.replace(/\.[^.]+$/, ''), cat: 'Custom', thumb: th, full: () => full };
        customs.push(it); s.sky = it; P.sky = it.id; drawGrid(); update();
      } catch { toast('Could not read that image file.', 'error'); }
    };
    inp.click();
  };
  drawGrid();
  const sl = (label: string, key: keyof typeof P, min: number, max: number, o: { center?: number; unit?: string } = {}) => wsSlider(label, P[key] as number, min, max, v => { (P as any)[key] = v; update(); }, o);
  const brushRow = wsSlider('Brush Size:', P.brush, 5, 800, v => { P.brush = v; }, { unit: ' px' });
  const side = h('div.sr-side', null,
    wsSection('Sky', skyGrid),
    sl('Shift Edge:', 'shift', -100, 100, { center: 0 }), sl('Fade Edge:', 'fade', 0, 100),
    wsSection('Sky Adjustments', sl('Brightness:', 'bright', -100, 100, { center: 0 }), sl('Temperature:', 'temp', -100, 100, { center: 0 }), sl('Scale:', 'scale', 25, 400, { unit: '%' }),
      h('div.form-row', null, checkbox('Flip', P.flip, v => { P.flip = v; update(); }, { title: 'Flip the sky horizontally' }))),
    wsSection('Foreground Adjustments',
      h('div.form-row.sr-mode', null, h('label.form-label', null, 'Lighting Mode:'), select<'multiply' | 'screen'>([{ value: 'multiply', label: 'Multiply' }, { value: 'screen', label: 'Screen' }], P.mode, v => { P.mode = v; update(); }, { width: 110, title: 'Blend mode of the foreground lighting' })),
      sl('Foreground Lighting:', 'fgLight', 0, 100), sl('Edge Lighting:', 'edgeLight', 0, 100), sl('Color Adjustment:', 'color', 0, 100)),
    wsSection('Output', h('div.form-row', null, h('label.form-label', null, 'Output To:'), select<'layers' | 'duplicate'>([{ value: 'layers', label: 'New Layers' }, { value: 'duplicate', label: 'Duplicate Layer' }], P.output, v => { P.output = v; }, { width: 130, title: 'Where the result goes' }))),
    brushRow,
    h('div.form-row', null, checkbox('Preview', true, v => { preview = v; update(); }, { title: 'Show the replaced sky (P)' })));
  const ws = openWorkspace({
    title: 'Sky Replacement', side, className: 'sr-dialog',
    tools: [{ id: 'sky-move', icon: 'move', title: 'Sky Move Tool', key: 'V' }, { id: 'sky-brush', icon: 'brush', title: 'Sky Brush Tool (Alt to reduce the sky)', key: 'B' }, { id: 'hand', icon: 'hand', title: 'Hand Tool', key: 'H' }, { id: 'zoom', icon: 'zoom', title: 'Zoom Tool (Alt to zoom out)', key: 'Z' }],
    onTool: (id, w) => { w.view.cursor = id === 'sky-move' ? 'move' : id === 'sky-brush' ? 'none' : id === 'zoom' ? 'zoom-in' : 'grab'; w.view.canvas.style.cursor = w.view.cursor; brushRow.style.display = id === 'sky-brush' ? '' : 'none'; },
    onKey: e => { if (e.key === 'p' || e.key === 'P') { preview = !preview; update(); return true; } if (e.key === '[') { P.brush = Math.max(5, P.brush / 1.2); brushRow.setValue(P.brush); ws.view.draw(); return true; } if (e.key === ']') { P.brush = Math.min(800, P.brush * 1.2); brushRow.setValue(P.brush); ws.view.draw(); return true; } return false; },
  });
  if (!det) ws.status.textContent = 'No sky was detected — paint the sky area with the Sky Brush.';
  const view = ws.view;
  let raf = 0, cursor: PointerInfo | null = null;
  function update() {
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      view.setImage(preview ? flatten(s.fg, parts(s, W, H, k)) : s.fg, W, H);
    });
  }
  view.overlay = (c, v) => {
    if (ws.tool !== 'sky-brush' || !cursor) return;
    const q = v.toScreen(cursor.x, cursor.y), r = (P.brush / 2) * k * v.zoom;
    c.save(); c.strokeStyle = '#fff'; c.lineWidth = 1; c.beginPath(); c.arc(q.x, q.y, r, 0, Math.PI * 2); c.stroke();
    c.strokeStyle = '#000'; c.setLineDash([3, 3]); c.stroke(); c.restore();
  };
  let last: PointerInfo | null = null;
  const dab = (p: PointerInfo) => {
    const r = (P.brush / 2) * k, sign = p.e.altKey ? -1 : 1;
    const x0 = Math.max(0, Math.floor(p.x - r)), x1 = Math.min(W - 1, Math.ceil(p.x + r)), y0 = Math.max(0, Math.floor(p.y - r)), y1 = Math.min(H - 1, Math.ceil(p.y + r));
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const d = Math.hypot(x + 0.5 - p.x, y + 0.5 - p.y) / r;
      if (d >= 1) continue;
      const a = (1 - sstep(0.5, 1, d)) * 0.35, i = y * W + x;
      s.edit[i] = Math.max(-1, Math.min(1, s.edit[i] + sign * a));
    }
  };
  view.onDown = p => {
    last = p;
    if (ws.tool === 'zoom') { view.zoomAt(view.zoom * (p.e.altKey ? 1 / 1.5 : 1.5), p.sx, p.sy); return; }
    if (ws.tool === 'sky-brush') { dab(p); update(); }
  };
  view.onMove = (p, down) => {
    cursor = p;
    if (!down || !last) { if (ws.tool === 'sky-brush') view.draw(); return; }
    if (ws.tool === 'sky-move') { s.offX += (p.x - last.x) / k; s.offY += (p.y - last.y) / k; update(); }
    else if (ws.tool === 'sky-brush') {
      const n = Math.max(1, Math.ceil(Math.hypot(p.x - last.x, p.y - last.y) / Math.max(1, (P.brush * k) / 8)));
      for (let i = 1; i <= n; i++) dab({ ...p, x: last.x + ((p.x - last.x) * i) / n, y: last.y + ((p.y - last.y) * i) / n });
      update();
    }
    last = p;
  };
  view.onUp = () => { last = null; };
  view.setImage(s.fg, W, H, true);
  update();
  const ok = await ws.result;
  cancelAnimationFrame(raf);
  localStorage.setItem('pixora.skyReplace', JSON.stringify({ ...P }));
  if (!ok) return;
  document.body.classList.add('busy');
  await new Promise(r => setTimeout(r, 20));
  try { commit(s); } catch (err: any) { console.error(err); toast('Sky Replacement failed: ' + (err?.message || err), 'error'); }
  finally { document.body.classList.remove('busy'); }
}
function commit(s: Session) {
  const { doc, layer } = s, W = doc.width, H = doc.height;
  const pr = parts(s, W, H, 1);
  if (P.output === 'duplicate') {
    const fg = createCanvas(W, H); ctx2d(fg).drawImage(layer.canvas, layer.x, layer.y);
    const res = flatten(fg, pr);
    doc.history.transaction('Sky Replacement', () => {
      const nl = new RasterLayer(1, 1, `${layer.name} copy`);
      nl.canvas = res; nl.x = 0; nl.y = 0;
      doc.addLayer(nl, { above: layer, select: true });
    });
  } else {
    const mk = (c: HTMLCanvasElement) => ({ ...createMask(doc, 0), canvas: c });
    doc.history.transaction('Sky Replacement', () => {
      const g = new GroupLayer('Sky Replacement Group');
      doc.addLayer(g, { above: layer, select: false });
      const fill = (c: HTMLCanvasElement) => { const x = ctx2d(c); x.fillStyle = `rgb(${pr.avg.r},${pr.avg.g},${pr.avg.b})`; x.fillRect(0, 0, W, H); return c; };
      const sky = new RasterLayer(1, 1, 'Sky'); sky.canvas = pr.sky; sky.mask = mk(pr.skyMask);
      const col = new RasterLayer(1, 1, 'Sky Replacement Color'); col.canvas = fill(createCanvas(W, H)); col.blendMode = 'color'; col.opacity = (P.color / 100) * 0.6; col.mask = mk(pr.colorMask);
      const lit = new RasterLayer(1, 1, 'Foreground Lighting'); lit.canvas = fill(createCanvas(W, H)); lit.blendMode = P.mode; lit.opacity = P.fgLight / 100; lit.mask = mk(pr.lightMask);
      [sky, col, lit].forEach((l, i) => doc.addLayer(l, { parent: g, index: i, select: false }));
      doc.setActiveLayer(g);
    }, 'folder');
  }
  doc.pixelsChanged(null, null);
  doc.layersChanged();
}

registerCommands([{ id: 'edit.skyReplacement', label: 'Sky Replacement...', enabled: () => app.activeDoc?.activeLayer instanceof RasterLayer, run: skyReplacement }]);
(window as any).__pxSky = { renderSky, SKIES, P };
