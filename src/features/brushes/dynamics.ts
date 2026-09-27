// Brush dynamics (Brush Settings panel model + per-dab engine): Shape Dynamics, Scattering, Texture, Dual Brush,
// Color Dynamics, Transfer, Brush Pose, Noise, Wet Edges, Build-up, Smoothing. The engine turns the settings into
// StrokeOptions.transformDab / renderDab for core PaintStroke, and can also render an offline stroke preview.
import type { Dab, InputPoint, StrokeOptions } from '../../core/brush';
import { DabSpacer, getTip, tintTip } from '../../core/brush';
import type { RGB } from '../../core/types';
import { createCanvas, ctx2d } from '../../core/canvas';
import { hsvToRgb, rgbToHsv } from '../../core/color';
import { resources } from '../../core/registry';

export type Control = 'off' | 'fade' | 'pressure' | 'tilt';
export type AngleControl = Control | 'initial' | 'direction';
export type TexMode = 'multiply' | 'subtract' | 'darken' | 'overlay' | 'color-dodge' | 'color-burn' | 'linear-burn' | 'hard-mix' | 'linear-height' | 'height';

export interface Dynamics {
  shape: { on: boolean; sizeJitter: number; sizeControl: Control; sizeFade: number; minDiameter: number; angleJitter: number; angleControl: AngleControl; angleFade: number; roundJitter: number; roundControl: Control; roundFade: number; minRound: number; flipX: boolean; flipY: boolean };
  scatter: { on: boolean; amount: number; both: boolean; control: Control; fade: number; count: number; countJitter: number; countControl: Control; countFade: number };
  texture: { on: boolean; pattern: string; invert: boolean; scale: number; brightness: number; contrast: number; eachTip: boolean; mode: TexMode; depth: number; minDepth: number; depthJitter: number };
  dual: { on: boolean; tipId: string; mode: TexMode; flip: boolean; size: number; spacing: number; scatter: number; both: boolean; count: number };
  color: { on: boolean; perTip: boolean; fgbg: number; fgbgControl: Control; fgbgFade: number; hue: number; sat: number; bri: number; purity: number };
  transfer: { on: boolean; opacity: number; opacityControl: Control; opacityFade: number; minOpacity: number; flow: number; flowControl: Control; flowFade: number; minFlow: number };
  pose: { on: boolean; tiltX: number; tiltY: number; rotation: number; pressure: number; overrideTilt: boolean; overrideRotation: boolean; overridePressure: boolean };
  noise: boolean; wetEdges: boolean; buildup: boolean; smoothing: boolean; protectTexture: boolean;
  /** Section locks: locked sections keep their values when another preset is chosen. */
  locks: Record<string, boolean>;
}

export const DYN_SECTIONS = ['shape', 'scatter', 'texture', 'dual', 'color', 'transfer', 'pose'] as const;
export const DYN_TOGGLES = ['noise', 'wetEdges', 'buildup', 'smoothing', 'protectTexture'] as const;

export function defaultDynamics(): Dynamics {
  return {
    shape: { on: false, sizeJitter: 0, sizeControl: 'off', sizeFade: 25, minDiameter: 0, angleJitter: 0, angleControl: 'off', angleFade: 25, roundJitter: 0, roundControl: 'off', roundFade: 25, minRound: 25, flipX: false, flipY: false },
    scatter: { on: false, amount: 0, both: false, control: 'off', fade: 25, count: 1, countJitter: 0, countControl: 'off', countFade: 25 },
    texture: { on: false, pattern: 'noise', invert: false, scale: 100, brightness: 0, contrast: 0, eachTip: true, mode: 'multiply', depth: 100, minDepth: 0, depthJitter: 0 },
    dual: { on: false, tipId: 'spatter', mode: 'multiply', flip: false, size: 30, spacing: 25, scatter: 0, both: false, count: 1 },
    color: { on: false, perTip: true, fgbg: 0, fgbgControl: 'off', fgbgFade: 25, hue: 0, sat: 0, bri: 0, purity: 0 },
    transfer: { on: false, opacity: 0, opacityControl: 'off', opacityFade: 25, minOpacity: 0, flow: 0, flowControl: 'off', flowFade: 25, minFlow: 0 },
    pose: { on: false, tiltX: 0, tiltY: 0, rotation: 0, pressure: 100, overrideTilt: false, overrideRotation: false, overridePressure: false },
    noise: false, wetEdges: false, buildup: false, smoothing: true, protectTexture: false,
    locks: {},
  };
}

/** Merge partial (possibly old / preset) dynamics onto defaults. */
export function normDynamics(d?: any): Dynamics {
  const out = defaultDynamics() as any;
  if (!d || typeof d !== 'object') return out;
  for (const k of Object.keys(out)) {
    if (!(k in d)) continue;
    if (typeof out[k] === 'object') Object.assign(out[k], d[k]);
    else out[k] = d[k];
  }
  return out;
}

/** Brush settings used by the dab engine (subset of a painting tool's settings). */
export interface BrushShape {
  size: number; hardness: number; spacing: number; roundness: number; angle: number;
  flipX?: boolean; flipY?: boolean; tipId?: string; aliased?: boolean;
}

export interface DabX extends Dab { flipX?: boolean; flipY?: boolean; tiltX?: number; tiltY?: number }

export const tipById = (id?: string): HTMLCanvasElement | null => (id ? resources.brushes.find(b => b.id === id)?.tip || null : null);

// ------------------------------------------------------------------ texture / noise tiles
const texCache = new Map<string, HTMLCanvasElement>();
/** Tile whose alpha = amount to REMOVE from the tip (so destination-out applies the texture). */
function textureTile(t: Dynamics['texture']): HTMLCanvasElement | null {
  const pat = resources.patterns.find(p => p.id === t.pattern) || resources.patterns[0];
  if (!pat) return null;
  const key = [pat.id, t.invert, t.scale, t.brightness, t.contrast, t.mode, t.depth].join('|');
  let c = texCache.get(key);
  if (c) return c;
  const sc = Math.max(0.01, t.scale / 100);
  const w = Math.max(1, Math.round(pat.canvas.width * sc)), hh = Math.max(1, Math.round(pat.canvas.height * sc));
  c = createCanvas(w, hh);
  const x = ctx2d(c);
  x.imageSmoothingQuality = 'high';
  x.drawImage(pat.canvas, 0, 0, w, hh);
  const img = x.getImageData(0, 0, w, hh), d = img.data;
  const cf = (100 + t.contrast) / 100, br = t.brightness / 150, depth = t.depth / 100;
  const hard = t.mode === 'hard-mix' || t.mode === 'height' || t.mode === 'linear-height';
  for (let i = 0; i < d.length; i += 4) {
    let v = (d[i] * 0.3 + d[i + 1] * 0.59 + d[i + 2] * 0.11) / 255;
    if (t.invert) v = 1 - v;
    v = Math.max(0, Math.min(1, (v - 0.5) * cf + 0.5 + br));
    let cut: number;
    if (hard) cut = v < depth ? 1 : 0;                                   // height map threshold
    else if (t.mode === 'subtract' || t.mode === 'color-dodge' || t.mode === 'linear-burn') cut = Math.min(1, (1 - v) * 2);
    else cut = 1 - v;                                                    // multiply family
    d[i] = d[i + 1] = d[i + 2] = 0; d[i + 3] = cut * 255;
  }
  x.putImageData(img, 0, 0);
  texCache.set(key, c);
  if (texCache.size > 24) texCache.delete(texCache.keys().next().value!);
  return c;
}
let noiseTile: HTMLCanvasElement | null = null;
function getNoiseTile() {
  if (noiseTile) return noiseTile;
  noiseTile = createCanvas(128, 128);
  const x = ctx2d(noiseTile), img = x.createImageData(128, 128);
  for (let i = 0; i < img.data.length; i += 4) img.data[i + 3] = Math.random() < 0.5 ? Math.random() * 255 : 0;
  x.putImageData(img, 0, 0);
  return noiseTile;
}

// ------------------------------------------------------------------ pipeline
export interface PipelineOpts {
  shape: BrushShape;
  dyn: Dynamics;
  fg: RGB; bg: RGB;
  rand?: () => number;
  /** Current pen tilt in degrees (PointerEvent tiltX/tiltY) for Pen Tilt controls. */
  getTilt?: () => { x: number; y: number };
  /** Extra expansion after dynamics (symmetry copies). */
  expand?: (d: DabX) => DabX[];
  /** Custom content for each dab instead of the tinted tip (history brush, mixer…): draw `mask`-shaped paint. */
  content?: (d: DabX, box: { x: number; y: number; w: number; h: number }) => CanvasImageSource | null;
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const quantSize = (s: number) => (s > 16 ? Math.exp(Math.round(Math.log(s) * 40) / 40) : Math.max(0.5, Math.round(s * 4) / 4));

/** Build transformDab/renderDab for a stroke. Returns only the pieces that are needed (fast path otherwise). */
export function dabPipeline(o: PipelineOpts): Pick<StrokeOptions, 'transformDab' | 'renderDab'> & { needsRender: boolean } {
  const { dyn, shape } = o;
  const rnd = o.rand || Math.random;
  let prev: { x: number; y: number } | null = null, dir = 0, initialDir: number | null = null;
  const ctrl = (c: Control, fade: number, d: DabX) => {
    switch (c) {
      case 'fade': return clamp01(1 - d.index / Math.max(1, fade));
      case 'pressure': return d.pressure;
      case 'tilt': return clamp01(Math.hypot(d.tiltX || 0, d.tiltY || 0) / 60);
      default: return 1;
    }
  };
  // stroke-level colour (Color Dynamics with Apply Per Tip off)
  const jitterColor = (base: RGB, d: DabX): RGB => {
    const c = dyn.color;
    let col = base;
    if (c.fgbg) {
      const k = rnd() * (c.fgbg / 100) * ctrl(c.fgbgControl, c.fgbgFade, d);
      col = { r: base.r + (o.bg.r - base.r) * k, g: base.g + (o.bg.g - base.g) * k, b: base.b + (o.bg.b - base.b) * k };
    }
    if (c.hue || c.sat || c.bri || c.purity) {
      const hsv = rgbToHsv(col);
      hsv.h += (rnd() - 0.5) * 2 * c.hue * 1.8;
      hsv.s = Math.max(0, Math.min(100, hsv.s + (rnd() - 0.5) * 2 * c.sat + c.purity));
      hsv.v = Math.max(0, Math.min(100, hsv.v + (rnd() - 0.5) * 2 * c.bri));
      col = hsvToRgb(hsv);
    }
    return { r: Math.round(col.r), g: Math.round(col.g), b: Math.round(col.b) };
  };
  let strokeColor: RGB | null = null;
  const baseFlipX = !!shape.flipX, baseFlipY = !!shape.flipY;
  const anyDyn = dyn.shape.on || dyn.scatter.on || dyn.color.on || dyn.transfer.on || dyn.pose.on || baseFlipX || baseFlipY || !!o.expand;

  const transformDab = (d0: Dab): Dab[] | Dab | null => {
    const d = d0 as DabX;
    if (dyn.pose.on) {
      if (dyn.pose.overridePressure) d.pressure = dyn.pose.pressure / 100;
      if (dyn.pose.overrideTilt) { d.tiltX = dyn.pose.tiltX * 0.6; d.tiltY = dyn.pose.tiltY * 0.6; }
      if (dyn.pose.overrideRotation) d.angle += dyn.pose.rotation;
    }
    if (prev) {
      const dx = d.x - prev.x, dy = d.y - prev.y;
      if (dx * dx + dy * dy > 0.01) { dir = (Math.atan2(dy, dx) * 180) / Math.PI; if (initialDir === null) initialDir = dir; }
    }
    prev = { x: d.x, y: d.y };
    if (d.tiltX === undefined && o.getTilt) { const t = o.getTilt(); d.tiltX = t.x; d.tiltY = t.y; }
    d.flipX = baseFlipX; d.flipY = baseFlipY;
    const s = dyn.shape;
    if (s.on) {
      const min = s.minDiameter / 100;
      let f = 1;
      if (s.sizeControl !== 'off') f = min + (1 - min) * ctrl(s.sizeControl, s.sizeFade, d);
      if (s.sizeJitter) f *= Math.max(min, 1 - rnd() * (s.sizeJitter / 100));
      d.size = quantSize(Math.max(0.5, d.size * f));
      let a = d.angle;
      if (s.angleControl === 'direction') a += dir;
      else if (s.angleControl === 'initial') a += initialDir ?? 0;
      else if (s.angleControl !== 'off') a += 360 * (1 - ctrl(s.angleControl, s.angleFade, d));
      if (s.angleJitter) a += (rnd() - 0.5) * 3.6 * s.angleJitter;
      d.angle = a;
      const mr = s.minRound / 100;
      let r = d.roundness;
      if (s.roundControl !== 'off') r *= mr + (1 - mr) * ctrl(s.roundControl, s.roundFade, d);
      if (s.roundJitter) r *= Math.max(mr, 1 - rnd() * (s.roundJitter / 100));
      d.roundness = Math.max(0.01, r);
      if (s.flipX && rnd() < 0.5) d.flipX = !d.flipX;
      if (s.flipY && rnd() < 0.5) d.flipY = !d.flipY;
    }
    const t = dyn.transfer;
    if (t.on) {
      let k = 1;
      if (t.flowControl !== 'off') k *= Math.max(t.minFlow / 100, ctrl(t.flowControl, t.flowFade, d));
      if (t.flow) k *= Math.max(t.minFlow / 100, 1 - rnd() * (t.flow / 100));
      if (t.opacityControl !== 'off') k *= Math.max(t.minOpacity / 100, ctrl(t.opacityControl, t.opacityFade, d));
      if (t.opacity) k *= Math.max(t.minOpacity / 100, 1 - rnd() * (t.opacity / 100));
      d.flow *= k;
    }
    if (dyn.color.on) {
      if (dyn.color.perTip) d.color = jitterColor(d.color, d);
      else d.color = strokeColor || (strokeColor = jitterColor(d.color, d));
    }
    let out: DabX[] = [d];
    const sc = dyn.scatter;
    if (sc.on && (sc.amount > 0 || sc.count > 1)) {
      let n = sc.count;
      if (sc.countJitter) n = Math.round(n * (1 - rnd() * (sc.countJitter / 100)));
      if (sc.countControl !== 'off') n = Math.round(n * ctrl(sc.countControl, sc.countFade, d));
      n = Math.max(1, n);
      const amt = (sc.amount / 100) * d.size * ctrl(sc.control, sc.fade, d);
      const rad = (dir * Math.PI) / 180, px = -Math.sin(rad), py = Math.cos(rad), ax = Math.cos(rad), ay = Math.sin(rad);
      out = [];
      for (let i = 0; i < n; i++) {
        const k = (rnd() * 2 - 1) * amt, k2 = sc.both ? (rnd() * 2 - 1) * amt : 0;
        out.push({ ...d, x: d.x + px * k + ax * k2, y: d.y + py * k + ay * k2 });
      }
    }
    if (o.expand) out = out.flatMap(o.expand);
    return out;
  };

  // ------------------------------------------------ renderer
  const tex = dyn.texture.on ? textureTile(dyn.texture) : null;
  const dualTip = dyn.dual.on ? tipById(dyn.dual.tipId) : null;
  const needsRender = !!(tex || dyn.dual.on || dyn.noise || dyn.wetEdges || dyn.color.on || o.content || baseFlipX || baseFlipY || dyn.shape.on && (dyn.shape.flipX || dyn.shape.flipY));
  let scratch: HTMLCanvasElement | null = null, scratch2: HTMLCanvasElement | null = null;
  const sized = (c: HTMLCanvasElement | null, w: number, h: number) => {
    if (!c) c = createCanvas(w, h);
    if (c.width < w || c.height < h) { c.width = Math.max(c.width, w); c.height = Math.max(c.height, h); }
    const x = ctx2d(c);
    x.setTransform(1, 0, 0, 1, 0, 0); x.globalAlpha = 1; x.globalCompositeOperation = 'source-over';
    x.clearRect(0, 0, w, h);
    return c;
  };

  const renderDab: StrokeOptions['renderDab'] = (bx, d0, tip, off) => {
    const d = d0 as DabX;
    const cx = d.x - off.x, cy = d.y - off.y;
    const ext = Math.ceil(Math.hypot(tip.width, tip.height) / 2) + 2;
    const box = { x: Math.floor(cx - ext), y: Math.floor(cy - ext), w: ext * 2, h: ext * 2 };
    scratch = sized(scratch, box.w, box.h);
    const sx = ctx2d(scratch);
    // 1) transformed tip shape
    sx.save();
    if (shape.aliased) sx.imageSmoothingEnabled = false;
    sx.translate(shape.aliased ? Math.round(cx - box.x) : cx - box.x, shape.aliased ? Math.round(cy - box.y) : cy - box.y);
    if (d.angle) sx.rotate((d.angle * Math.PI) / 180);
    sx.scale(d.flipX ? -1 : 1, (d.flipY ? -1 : 1) * Math.max(0.01, d.roundness));
    sx.drawImage(tip, -tip.width / 2, -tip.height / 2);
    sx.restore();
    // 2) dual brush (intersection / subtraction with a second tip)
    if (dyn.dual.on) {
      const du = dyn.dual;
      scratch2 = sized(scratch2, box.w, box.h);
      const s2 = ctx2d(scratch2);
      const dt = getTip({ size: Math.max(1, du.size), hardness: 1, tip: dualTip });
      const reps = Math.max(1, Math.round(du.count * Math.max(1, (shape.spacing * 100) / Math.max(1, du.spacing))));
      for (let i = 0; i < Math.min(24, reps); i++) {
        const r = (du.scatter / 100) * du.size;
        const ox = (rnd() * 2 - 1) * (du.both ? r : r * 0.5) + (rnd() - 0.5) * d.size * 0.6;
        const oy = (rnd() * 2 - 1) * r + (rnd() - 0.5) * d.size * 0.6;
        s2.save();
        s2.translate(cx - box.x + ox, cy - box.y + oy);
        s2.rotate(rnd() * Math.PI * 2);
        if (du.flip && rnd() < 0.5) s2.scale(-1, 1);
        s2.drawImage(dt, -dt.width / 2, -dt.height / 2);
        s2.restore();
      }
      sx.globalCompositeOperation = du.mode === 'subtract' || du.mode === 'color-dodge' ? 'destination-out' : 'destination-in';
      sx.drawImage(scratch2, 0, 0);
      sx.globalCompositeOperation = 'source-over';
    }
    // 3) texture (document-aligned)
    if (tex) {
      const tt = dyn.texture;
      let depth = tt.depth / 100;
      if (tt.depthJitter) depth = Math.max(tt.minDepth / 100, depth * (1 - rnd() * (tt.depthJitter / 100)));
      const pat = sx.createPattern(tex, 'repeat')!;
      pat.setTransform(new DOMMatrix().translate(-(box.x + off.x), -(box.y + off.y)));
      sx.globalCompositeOperation = 'destination-out';
      sx.globalAlpha = tt.mode === 'hard-mix' || tt.mode === 'height' || tt.mode === 'linear-height' ? 1 : depth;
      sx.fillStyle = pat;
      sx.fillRect(0, 0, box.w, box.h);
      sx.globalAlpha = 1;
      sx.globalCompositeOperation = 'source-over';
    }
    // 4) noise (grain on the soft edges)
    if (dyn.noise) {
      const pat = sx.createPattern(getNoiseTile(), 'repeat')!;
      pat.setTransform(new DOMMatrix().translate(Math.floor(rnd() * 128), Math.floor(rnd() * 128)));
      sx.globalCompositeOperation = 'destination-out';
      sx.globalAlpha = 0.3 + 0.5 * (1 - shape.hardness);
      sx.fillStyle = pat;
      sx.fillRect(0, 0, box.w, box.h);
      sx.globalAlpha = 1;
    }
    // 5) wet edges: paint pools at the edges, centre is lighter
    if (dyn.wetEdges) {
      sx.globalCompositeOperation = 'destination-out';
      sx.globalAlpha = 0.55;
      const k = 0.72;
      sx.save();
      sx.translate(cx - box.x, cy - box.y);
      if (d.angle) sx.rotate((d.angle * Math.PI) / 180);
      sx.scale(k, k * Math.max(0.01, d.roundness));
      sx.drawImage(tip, -tip.width / 2, -tip.height / 2);
      sx.restore();
      sx.globalAlpha = 1;
    }
    // 6) paint: colour or custom content inside the shape
    sx.globalCompositeOperation = 'source-in';
    const content = o.content?.(d, { x: box.x + off.x, y: box.y + off.y, w: box.w, h: box.h });
    if (content) sx.drawImage(content, 0, 0);
    else if (o.content) { sx.clearRect(0, 0, box.w, box.h); }
    else { sx.fillStyle = `rgb(${d.color.r},${d.color.g},${d.color.b})`; sx.fillRect(0, 0, box.w, box.h); }
    sx.globalCompositeOperation = 'source-over';
    bx.save();
    bx.globalAlpha = clamp01(d.flow);
    bx.drawImage(scratch, 0, 0, box.w, box.h, box.x, box.y, box.w, box.h);
    bx.restore();
  };
  return { transformDab: anyDyn ? transformDab : undefined, renderDab: needsRender ? renderDab : undefined, needsRender };
}

// ------------------------------------------------------------------ offline stroke preview
export interface PreviewSettings extends BrushShape { dyn?: Dynamics; flow?: number; opacity?: number; pressureSize?: boolean; pressureOpacity?: boolean }

function seeded(seed: number) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

/**
 * Render an S-curve stroke with the given brush into `out` (cleared). Size is clamped to fit the canvas.
 * Pressure tapers in/out along the stroke so pressure controls are visible.
 */
export function renderStrokePreview(out: HTMLCanvasElement, s: PreviewSettings, color: RGB = { r: 230, g: 230, b: 230 }, opts: { maxSize?: number; bg?: RGB } = {}) {
  const W = out.width, H = out.height, x = ctx2d(out);
  x.clearRect(0, 0, W, H);
  const buf = createCanvas(W, H), bx = ctx2d(buf);
  const size = Math.max(1, Math.min(s.size, opts.maxSize ?? H * 0.55));
  const scale = size / Math.max(1, s.size);
  const dyn = s.dyn ? normDynamics(s.dyn) : defaultDynamics();
  const sd = { ...dyn, scatter: { ...dyn.scatter, amount: dyn.scatter.amount }, dual: { ...dyn.dual, size: Math.max(1, dyn.dual.size * scale) } };
  const rand = seeded(7);
  const pipe = dabPipeline({ shape: { ...s, size }, dyn: sd, fg: color, bg: opts.bg || { r: 90, g: 90, b: 90 }, rand });
  const tipCanvas = tipById(s.tipId);
  const flow = s.flow ?? 1;
  let idx = 0;
  const pad = size * 0.6 + 4;
  const spacer = new DabSpacer(q => Math.max(0.5, (s.spacing || 0.25) * (s.pressureSize ? Math.max(1, size * q.pressure) : size)), q => {
    let dabs: Dab | Dab[] | null = {
      x: q.x, y: q.y, pressure: q.pressure, size: s.pressureSize ? Math.max(1, size * q.pressure) : size, angle: s.angle || 0,
      roundness: s.roundness ?? 1, flow: flow * (s.pressureOpacity ? q.pressure : 1), color, index: idx++,
    };
    if (pipe.transformDab) dabs = pipe.transformDab(dabs);
    if (!dabs) return;
    for (const d of Array.isArray(dabs) ? dabs : [dabs]) {
      const tip = getTip({ size: d.size, hardness: s.hardness, tip: tipCanvas, aliased: s.aliased });
      if (pipe.renderDab) pipe.renderDab(bx, d, tip, { x: 0, y: 0 });
      else {
        bx.save();
        bx.globalAlpha = clamp01(d.flow);
        bx.translate(d.x, d.y);
        if (d.angle) bx.rotate((d.angle * Math.PI) / 180);
        bx.scale(1, Math.max(0.01, d.roundness));
        const t = tintTip(tip, d.color);
        bx.drawImage(t, -t.width / 2, -t.height / 2);
        bx.restore();
      }
    }
  });
  const N = 64;
  for (let i = 0; i <= N; i++) {
    const t = i / N;
    const px = pad + (W - pad * 2) * t;
    const py = H / 2 + Math.sin(t * Math.PI * 2) * (H / 2 - pad) * 0.55;
    const pressure = Math.max(0.05, Math.sin(t * Math.PI));
    spacer.add({ x: px, y: py, pressure } as InputPoint);
  }
  x.globalAlpha = s.opacity ?? 1;
  x.drawImage(buf, 0, 0);
  x.globalAlpha = 1;
}
