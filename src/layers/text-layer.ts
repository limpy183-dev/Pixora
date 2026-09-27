// Text layers (kind 'text'): styled character runs + per-paragraph settings, point / paragraph (box) text,
// horizontal / vertical orientation, anti-aliasing, warp (mesh-warped rasterization) and an affine transform.
//
// Local text space: (0,0) is the origin. Point text: the baseline start of the first line (horizontal) or the
// top-centre of the first column (vertical). Paragraph text: top-left corner of the text box (boxW × boxH).
// Document position = DOMMatrix(transform[0..3], x, y) · local.
import { Layer, registerLayerClass, type LayerContent } from '../core/layer';
import type { PixDocument } from '../core/document';
import type { Rect, RGB } from '../core/types';
import { createCanvas, ctx2d } from '../core/canvas';

export type AntiAlias = 'none' | 'sharp' | 'crisp' | 'strong' | 'smooth';
export type TextAlign = 'left' | 'center' | 'right' | 'justify-left' | 'justify-center' | 'justify-right' | 'justify-all';
export type WarpStyle = 'none' | 'arc' | 'arc-lower' | 'arc-upper' | 'arch' | 'bulge' | 'shell-lower' | 'shell-upper'
  | 'flag' | 'wave' | 'fish' | 'rise' | 'fisheye' | 'inflate' | 'squeeze' | 'twist';

export const WARP_STYLES: { value: WarpStyle; label: string }[] = [
  { value: 'none', label: 'None' }, { value: 'arc', label: 'Arc' }, { value: 'arc-lower', label: 'Arc Lower' }, { value: 'arc-upper', label: 'Arc Upper' },
  { value: 'arch', label: 'Arch' }, { value: 'bulge', label: 'Bulge' }, { value: 'shell-lower', label: 'Shell Lower' }, { value: 'shell-upper', label: 'Shell Upper' },
  { value: 'flag', label: 'Flag' }, { value: 'wave', label: 'Wave' }, { value: 'fish', label: 'Fish' }, { value: 'rise', label: 'Rise' },
  { value: 'fisheye', label: 'Fisheye' }, { value: 'inflate', label: 'Inflate' }, { value: 'squeeze', label: 'Squeeze' }, { value: 'twist', label: 'Twist' },
];

export interface CharStyle {
  font: string;                   // family
  fontStyle: string;              // 'Regular', 'Bold', 'Light Italic'...
  size: number;                   // pt
  leading: number | 'auto';       // pt
  tracking: number;               // 1/1000 em
  kerning: 'metrics' | 'optical' | number;
  vScale: number;                 // %
  hScale: number;                 // %
  baseline: number;               // pt (positive = up)
  color: RGB;
  fauxBold: boolean; fauxItalic: boolean; allCaps: boolean; smallCaps: boolean;
  superscript: boolean; subscript: boolean; underline: boolean; strike: boolean;
  language: string;
}
export interface ParaStyle {
  align: TextAlign;
  indentLeft: number; indentRight: number; indentFirst: number;   // pt
  spaceBefore: number; spaceAfter: number;                          // pt
  hyphenate: boolean;
}
export interface TextRun { text: string; style: CharStyle }
export interface WarpSettings { style: WarpStyle; horizontal: boolean; bend: number; hDistort: number; vDistort: number }

export const defaultCharStyle = (): CharStyle => ({
  font: 'Arial', fontStyle: 'Regular', size: 12, leading: 'auto', tracking: 0, kerning: 'metrics', vScale: 100, hScale: 100, baseline: 0,
  color: { r: 0, g: 0, b: 0 }, fauxBold: false, fauxItalic: false, allCaps: false, smallCaps: false,
  superscript: false, subscript: false, underline: false, strike: false, language: 'English: USA',
});
export const defaultParaStyle = (): ParaStyle => ({ align: 'left', indentLeft: 0, indentRight: 0, indentFirst: 0, spaceBefore: 0, spaceAfter: 0, hyphenate: true });
export const defaultWarp = (): WarpSettings => ({ style: 'none', horizontal: true, bend: 50, hDistort: 0, vDistort: 0 });
export const CHAR_KEYS = Object.keys(defaultCharStyle()) as (keyof CharStyle)[];
export const PARA_KEYS = Object.keys(defaultParaStyle()) as (keyof ParaStyle)[];

export function sameValue(a: any, b: any): boolean {
  if (a === b) return true;
  if (a && b && typeof a === 'object' && typeof b === 'object') return a.r === b.r && a.g === b.g && a.b === b.b;
  return false;
}
export function sameStyle(a: CharStyle, b: CharStyle): boolean {
  for (const k of CHAR_KEYS) if (!sameValue(a[k], b[k])) return false;
  return true;
}
export const cloneChar = (s: CharStyle): CharStyle => ({ ...s, color: { ...s.color } });

// ------------------------------------------------------------------ fonts & measuring
const WEIGHTS: [RegExp, number][] = [
  [/thin|hairline/i, 100], [/(extra|ultra)[\s-]*light/i, 200], [/(semi|demi)[\s-]*light/i, 350], [/light/i, 300],
  [/medium/i, 500], [/(semi|demi)[\s-]*bold/i, 600], [/(extra|ultra)[\s-]*bold/i, 800], [/bold/i, 700], [/black|heavy/i, 900],
];
export function parseFontStyle(s: string): { weight: number; italic: boolean; stretch: string } {
  let weight = 400;
  for (const [re, w] of WEIGHTS) if (re.test(s)) { weight = w; break; }
  const stretch = /condensed|narrow/i.test(s) ? 'condensed' : /expanded|extended|wide/i.test(s) ? 'expanded' : 'normal';
  return { weight, italic: /italic|oblique/i.test(s), stretch };
}
export function familyCss(family: string) { return `"${family.replace(/["\\]/g, '')}"`; }
export function fontCss(st: { font: string; fontStyle: string }, px: number): string {
  const f = parseFontStyle(st.fontStyle);
  return `${f.italic ? 'italic ' : ''}${f.weight} ${Math.max(0.05, +px.toFixed(3))}px ${familyCss(st.font)}, sans-serif`;
}

interface Metrics { w: number; l: number; r: number; a: number; d: number }
const mctx = ctx2d(createCanvas(8, 8));
let mFont = '', mLs = NaN, mKern = '';
const mcache = new Map<string, Metrics>();
const fmcache = new Map<string, { a: number; d: number }>();
/** Forget cached measurements (call after web fonts finished loading). */
export function clearMeasureCache() { mcache.clear(); fmcache.clear(); mFont = ''; }

function setFont(ctx: CanvasRenderingContext2D, font: string, ls: number, kern: boolean) {
  ctx.font = font;
  (ctx as any).letterSpacing = ls ? `${ls}px` : '0px';
  ctx.fontKerning = kern ? 'normal' : 'none';
}
function measure(font: string, ls: number, kern: boolean, text: string): Metrics {
  const key = font + '\u0001' + ls + '\u0001' + (kern ? 1 : 0) + '\u0001' + text;
  let m = mcache.get(key);
  if (m) return m;
  if (mFont !== font || mLs !== ls || mKern !== String(kern)) { setFont(mctx, font, ls, kern); mFont = font; mLs = ls; mKern = String(kern); }
  const t = mctx.measureText(text);
  m = { w: t.width, l: t.actualBoundingBoxLeft || 0, r: t.actualBoundingBoxRight || 0, a: t.actualBoundingBoxAscent || 0, d: t.actualBoundingBoxDescent || 0 };
  if (mcache.size > 30000) mcache.clear();
  mcache.set(key, m);
  return m;
}
function fontMetrics(font: string): { a: number; d: number } {
  let m = fmcache.get(font);
  if (m) return m;
  mctx.font = font; mFont = '';
  const t = mctx.measureText('Hg');
  const px = parseFloat(/([\d.]+)px/.exec(font)?.[1] || '12');
  m = { a: t.fontBoundingBoxAscent || px * 0.8, d: t.fontBoundingBoxDescent || px * 0.2 };
  fmcache.set(font, m);
  return m;
}
/** Advance positions (length n+1) of each UTF-16 boundary of `disp`. Exact for short strings, scaled per-char sum for long ones. */
function prefixPositions(font: string, ls: number, kern: boolean, disp: string, total: number): Float64Array {
  const n = disp.length, out = new Float64Array(n + 1);
  if (!n) return out;
  if (n <= 48) {
    for (let k = 1; k <= n; k++) {
      const hi = disp.charCodeAt(k - 1);
      if (hi >= 0xd800 && hi <= 0xdbff && k < n) { out[k] = out[k - 1]; continue; }
      out[k] = measure(font, ls, kern, disp.slice(0, k)).w;
    }
  } else {
    let acc = 0;
    for (let k = 0; k < n; k++) {
      const c = disp.charCodeAt(k);
      if (c >= 0xd800 && c <= 0xdbff && k + 1 < n) { out[k + 1] = acc; acc += measure(font, ls, kern, disp.slice(k, k + 2)).w; out[k + 2] = acc; k++; continue; }
      acc += measure(font, ls, kern, disp[k]).w;
      out[k + 1] = acc;
    }
    const f = acc > 0 ? total / acc : 1;
    for (let k = 1; k <= n; k++) out[k] *= f;
  }
  return out;
}

// ------------------------------------------------------------------ layout model
export interface Piece {
  start: number; end: number;        // source range (end === start for synthetic hyphens)
  disp: string;
  x: number; y: number;              // horizontal: x = left edge (y unused). vertical: y = top of the cell
  w: number;                         // advance (horizontal: width, vertical: height)
  cw: number;                        // vertical: glyph width
  st: CharStyle; font: string; px: number; ls: number; kern: boolean; hs: number; vs: number;
  shift: number;                     // baseline shift, px up
  asc: number; desc: number;
}
export interface Line {
  start: number; end: number; para: number; hard: boolean; hyphen: boolean; firstOfPara: boolean;
  pieces: Piece[];
  x: number; w: number;              // horizontal: left + width. vertical: x = column centre, w = column length
  y0: number;                        // vertical: top of the column
  baseline: number; asc: number; desc: number; lead: number;
  hidden: boolean;
  _pos?: Float64Array;
}
export interface TextLayout { text: string; lines: Line[]; vertical: boolean; boxed: boolean; overflow: boolean; bounds: Rect; ink: Rect | null }

const isWS = (c: string) => c === ' ' || c === '\t' || c === '\u3000';
const isCJK = (c: number) => (c >= 0x2e80 && c <= 0x9fff) || (c >= 0xac00 && c <= 0xd7af) || (c >= 0xf900 && c <= 0xfaff) || (c >= 0xff00 && c <= 0xffef);
interface Word { start: number; end: number; ink: number }
function breakWords(text: string, s: number, e: number): Word[] {
  const out: Word[] = [];
  let i = s;
  while (i < e) {
    const w0 = i;
    if (isCJK(text.charCodeAt(i))) i++;
    else while (i < e && !isWS(text[i]) && !isCJK(text.charCodeAt(i))) { const ch = text[i++]; if (ch === '-' || ch === '\u2014' || ch === '\u2013' || ch === '/') break; }
    const ink = i;
    while (i < e && isWS(text[i])) i++;
    out.push({ start: w0, end: i, ink });
  }
  return out;
}
export function displayText(s: string, st: CharStyle): string {
  let out = '';
  const upper = st.allCaps || st.smallCaps;
  for (const ch of s) {
    if (ch === '\t') { out += '\u2003'; continue; }
    if (upper) { const u = ch.toUpperCase(); out += u.length === ch.length ? u : ch; } else out += ch;
  }
  return out;
}
const isLower = (ch: string) => ch !== ch.toUpperCase() && ch.toUpperCase().length === ch.length;

function rectUnion(a: Rect | null, x0: number, y0: number, x1: number, y1: number): Rect {
  if (!a) return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  const nx = Math.min(a.x, x0), ny = Math.min(a.y, y0);
  return { x: nx, y: ny, w: Math.max(a.x + a.w, x1) - nx, h: Math.max(a.y + a.h, y1) - ny };
}

// ------------------------------------------------------------------ warp math
/** Warp a point given relative to the warp centre (X, Y) with half extents hw, hh. Returns the warped point. */
export function warpXY(w: WarpSettings, X: number, Y: number, hw: number, hh: number): [number, number] {
  if (w.style === 'none') return [X, Y];
  if (!w.horizontal) { const [a, b] = warpCore(w, Y, X, hh, hw); return [b, a]; }
  return warpCore(w, X, Y, hw, hh);
}
function warpCore(w: WarpSettings, X: number, Y: number, hw: number, hh: number): [number, number] {
  const b = w.bend / 100, u = X / hw, v = Y / hh, c = Math.max(0, 1 - u * u), sag = 0.5 * hw;
  let x = X, y = Y;
  switch (w.style) {
    case 'arc': {
      if (Math.abs(b) < 1e-4) break;
      const A = b * Math.PI, R = (2 * hw) / A, phi = u * A / 2;
      x = (R - Y) * Math.sin(phi); y = R - (R - Y) * Math.cos(phi);
      break;
    }
    case 'arc-lower': y = Y + b * sag * ((v + 1) / 2) * c; break;
    case 'arc-upper': y = Y - b * sag * ((1 - v) / 2) * c; break;
    case 'arch': y = Y - b * sag * c * (0.75 + 0.25 * (1 - v) / 2); break;
    case 'bulge': y = Y + Math.sign(v) * Math.abs(v) * b * sag * c; break;
    case 'shell-lower': y = Y + b * sag * ((v + 1) / 2) * c; x = X * (1 - b * 0.35 * (v + 1) / 2); break;
    case 'shell-upper': y = Y - b * sag * ((1 - v) / 2) * c; x = X * (1 - b * 0.35 * (1 - v) / 2); break;
    case 'flag': y = Y - b * hw * 0.14 * Math.sin(Math.PI * u); break;
    case 'wave': y = Y - b * hw * 0.12 * Math.sin(Math.PI * u + v * 0.9); x = X + b * hh * 0.25 * Math.sin(Math.PI * v) * c; break;
    case 'fish': { const t = (u + 1) / 2; y = Y + v * b * sag * 0.8 * Math.sin(1.25 * Math.PI * t); break; }
    case 'rise': y = Y - b * hw * 0.3 * Math.sin(u * Math.PI / 2); break;
    case 'fisheye': { const r2 = Math.min(1, (u * u + v * v) / 2), f = 1 + b * 0.6 * (1 - r2); x = X * f; y = Y * f; break; }
    case 'inflate': x = X * (1 + b * 0.25 * Math.max(0, 1 - v * v)); y = Y * (1 + b * 0.6 * c * Math.min(3, hw / hh) * 0.5); break;
    case 'squeeze': y = Y * (1 - b * 0.55 * c); x = X * (1 + b * 0.15 * Math.max(0, 1 - v * v)); break;
    case 'twist': {
      const r = Math.min(1, Math.hypot(u, v) / Math.SQRT2), a = b * Math.PI * 0.6 * (1 - r) * (1 - r);
      const s = Math.sin(a), co = Math.cos(a);
      x = X * co - Y * s; y = X * s + Y * co;
      break;
    }
  }
  const hd = w.hDistort / 100, vd = w.vDistort / 100;
  if (hd) { const f = 1 + hd * (x / hw) * 0.5; y *= f; x *= 1 + hd * 0.15 * (1 - (x / hw) * (x / hw)); }
  if (vd) { const f = 1 - vd * (y / hh) * 0.5; x *= f; }
  return [x, y];
}

/** Draw `src` region (sx..) triangle into ctx triangle (affine texture mapping). */
function drawTri(ctx: CanvasRenderingContext2D, img: CanvasImageSource, iw: number, ih: number,
  u0: number, v0: number, u1: number, v1: number, u2: number, v2: number,
  x0: number, y0: number, x1: number, y1: number, x2: number, y2: number) {
  const det = u0 * (v1 - v2) - v0 * (u1 - u2) + (u1 * v2 - u2 * v1);
  if (Math.abs(det) < 1e-9) return;
  const a = (x0 * (v1 - v2) - v0 * (x1 - x2) + (x1 * v2 - x2 * v1)) / det;
  const c = (u0 * (x1 - x2) - x0 * (u1 - u2) + (u1 * x2 - u2 * x1)) / det;
  const e = (u0 * (v1 * x2 - v2 * x1) - v0 * (u1 * x2 - u2 * x1) + x0 * (u1 * v2 - u2 * v1)) / det;
  const b = (y0 * (v1 - v2) - v0 * (y1 - y2) + (y1 * v2 - y2 * v1)) / det;
  const d = (u0 * (y1 - y2) - y0 * (u1 - u2) + (u1 * y2 - u2 * y1)) / det;
  const f = (u0 * (v1 * y2 - v2 * y1) - v0 * (u1 * y2 - u2 * y1) + y0 * (u1 * v2 - u2 * v1)) / det;
  const cx = (x0 + x1 + x2) / 3, cy = (y0 + y1 + y2) / 3;
  const g = (x: number, y: number): [number, number] => { const vx = x - cx, vy = y - cy, l = Math.hypot(vx, vy) || 1; return [x + (vx / l) * 0.75, y + (vy / l) * 0.75]; };
  const [p0x, p0y] = g(x0, y0), [p1x, p1y] = g(x1, y1), [p2x, p2y] = g(x2, y2);
  ctx.save();
  ctx.beginPath(); ctx.moveTo(p0x, p0y); ctx.lineTo(p1x, p1y); ctx.lineTo(p2x, p2y); ctx.closePath(); ctx.clip();
  ctx.transform(a, b, c, d, e, f);
  const sx = Math.max(0, Math.floor(Math.min(u0, u1, u2)) - 1), sy = Math.max(0, Math.floor(Math.min(v0, v1, v2)) - 1);
  const ex = Math.min(iw, Math.ceil(Math.max(u0, u1, u2)) + 1), ey = Math.min(ih, Math.ceil(Math.max(v0, v1, v2)) + 1);
  if (ex > sx && ey > sy) ctx.drawImage(img, sx, sy, ex - sx, ey - sy, sx, sy, ex - sx, ey - sy);
  ctx.restore();
}

/** Mesh-warp `src` (covering local rect `r` at k px per unit) with fn (local → local). Returns canvas at the same scale + its local rect. */
export function meshWarp(src: HTMLCanvasElement, r: Rect, k: number, fn: (x: number, y: number) => [number, number]): { canvas: HTMLCanvasElement; rect: Rect } {
  const nx = Math.max(6, Math.min(72, Math.ceil(src.width / 18))), ny = Math.max(3, Math.min(36, Math.ceil(src.height / 18)));
  const pts = new Float64Array((nx + 1) * (ny + 1) * 2);
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let j = 0; j <= ny; j++) for (let i = 0; i <= nx; i++) {
    const [x, y] = fn(r.x + (r.w * i) / nx, r.y + (r.h * j) / ny);
    const o = (j * (nx + 1) + i) * 2;
    pts[o] = x; pts[o + 1] = y;
    if (x < x0) x0 = x; if (y < y0) y0 = y; if (x > x1) x1 = x; if (y > y1) y1 = y;
  }
  const pad = 2 / k;
  const rect = { x: x0 - pad, y: y0 - pad, w: x1 - x0 + pad * 2, h: y1 - y0 + pad * 2 };
  const out = createCanvas(Math.min(16384, Math.ceil(rect.w * k)), Math.min(16384, Math.ceil(rect.h * k))), ctx = ctx2d(out);
  ctx.imageSmoothingQuality = 'high';
  const cw = src.width / nx, ch = src.height / ny;
  const P = (i: number, j: number): [number, number] => { const o = (j * (nx + 1) + i) * 2; return [(pts[o] - rect.x) * k, (pts[o + 1] - rect.y) * k]; };
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const [ax, ay] = P(i, j), [bx, by] = P(i + 1, j), [cx, cy] = P(i + 1, j + 1), [dx, dy] = P(i, j + 1);
    const su0 = i * cw, sv0 = j * ch, su1 = (i + 1) * cw, sv1 = (j + 1) * ch;
    drawTri(ctx, src, src.width, src.height, su0, sv0, su1, sv0, su1, sv1, ax, ay, bx, by, cx, cy);
    drawTri(ctx, src, src.width, src.height, su0, sv0, su1, sv1, su0, sv1, ax, ay, cx, cy, dx, dy);
  }
  return { canvas: out, rect };
}

function transformedBounds(m: DOMMatrix, r: Rect): Rect {
  const pts = [[r.x, r.y], [r.x + r.w, r.y], [r.x, r.y + r.h], [r.x + r.w, r.y + r.h]].map(([x, y]) => m.transformPoint(new DOMPoint(x, y)));
  const x0 = Math.floor(Math.min(...pts.map(p => p.x))), y0 = Math.floor(Math.min(...pts.map(p => p.y)));
  const x1 = Math.ceil(Math.max(...pts.map(p => p.x))), y1 = Math.ceil(Math.max(...pts.map(p => p.y)));
  return { x: x0, y: y0, w: Math.max(1, x1 - x0), h: Math.max(1, y1 - y0) };
}

/** Apply the anti-alias method to rendered text alpha (in place). */
function postAntiAlias(c: HTMLCanvasElement, aa: AntiAlias) {
  if (aa !== 'none' && aa !== 'crisp' && aa !== 'smooth') return;
  const x = ctx2d(c), img = x.getImageData(0, 0, c.width, c.height), d = img.data;
  const lut = new Uint8Array(256);
  for (let i = 0; i < 256; i++) lut[i] = aa === 'none' ? (i >= 128 ? 255 : 0) : Math.max(0, Math.min(255, Math.round((i - 128) * (aa === 'crisp' ? 1.22 : 0.85) + 128 + (aa === 'smooth' ? 8 : 0))));
  lut[0] = 0; lut[255] = 255;
  for (let i = 3; i < d.length; i += 4) d[i] = lut[d[i]];
  x.putImageData(img, 0, 0);
}

// ------------------------------------------------------------------ the layer
export class TextLayer extends Layer {
  kind = 'text' as const;
  runs: TextRun[] = [{ text: '', style: defaultCharStyle() }];
  paras: ParaStyle[] = [defaultParaStyle()];
  textType: 'point' | 'paragraph' = 'point';
  boxW = 0;
  boxH = 0;
  orientation: 'horizontal' | 'vertical' = 'horizontal';
  antiAlias: AntiAlias = 'sharp';
  warp: WarpSettings = defaultWarp();
  x = 0;
  y = 0;
  /** Linear part of the layer transform [a, b, c, d, 0, 0] (translation lives in x/y). */
  transform: number[] = [1, 0, 0, 1, 0, 0];
  /** The name last derived from the text; while name === autoName the name follows the text. */
  autoName = '';

  _lay: { v: number; res: number; L: TextLayout } | null = null;
  _ras: { v: number; res: number; c: LayerContent | null } | null = null;

  constructor(name = 'Layer') { super(); this.name = name; }

  // ---------------------------------------------------------------- text model
  get text(): string { let s = ''; for (const r of this.runs) s += r.text; return s; }
  get length(): number { let n = 0; for (const r of this.runs) n += r.text.length; return n; }

  setText(text: string, style?: CharStyle) {
    const st = style || this.runs[0]?.style || defaultCharStyle();
    this.runs = [{ text, style: cloneChar(st) }];
    this.normalize();
  }
  /** Character style at index i (clamped). */
  styleAt(i: number): CharStyle {
    let pos = 0;
    for (const r of this.runs) { if (i < pos + r.text.length) return r.style; pos += r.text.length; }
    return this.runs[this.runs.length - 1].style;
  }
  /** Style used when typing at caret position i. */
  caretStyle(i: number): CharStyle {
    if (i > 0) { const t = this.text; if (t[i - 1] !== '\n' || i >= t.length) return this.styleAt(i - 1); }
    return this.styleAt(i);
  }
  private splitAt(i: number): number {
    let pos = 0;
    for (let k = 0; k < this.runs.length; k++) {
      const r = this.runs[k], len = r.text.length;
      if (i === pos) return k;
      if (i < pos + len) {
        this.runs.splice(k, 1, { text: r.text.slice(0, i - pos), style: r.style }, { text: r.text.slice(i - pos), style: cloneChar(r.style) });
        return k + 1;
      }
      pos += len;
    }
    return this.runs.length;
  }
  /** Merge equal adjacent runs, drop empty ones, keep paragraph settings in sync with the text. */
  normalize() {
    const out: TextRun[] = [];
    for (const r of this.runs) {
      if (!r.text) continue;
      const last = out[out.length - 1];
      if (last && sameStyle(last.style, r.style)) last.text += r.text;
      else out.push({ text: r.text, style: r.style });
    }
    if (!out.length) out.push({ text: '', style: this.runs[0]?.style || defaultCharStyle() });
    this.runs = out;
    const n = (this.text.match(/\n/g)?.length || 0) + 1;
    if (!this.paras.length) this.paras = [defaultParaStyle()];
    while (this.paras.length < n) this.paras.push({ ...this.paras[this.paras.length - 1] });
    if (this.paras.length > n) this.paras.length = n;
  }
  paraIndexAt(i: number): number {
    const t = this.text;
    let n = 0;
    for (let k = 0; k < i && k < t.length; k++) if (t.charCodeAt(k) === 10) n++;
    return n;
  }
  /** [start, end) of paragraph p (end excludes the newline). */
  paraRange(p: number): [number, number] {
    const t = this.text;
    let s = 0;
    for (let k = 0; k < p; k++) { const i = t.indexOf('\n', s); if (i < 0) return [t.length, t.length]; s = i + 1; }
    const e = t.indexOf('\n', s);
    return [s, e < 0 ? t.length : e];
  }
  insertText(pos: number, str: string, style: CharStyle) {
    if (!str) return;
    str = str.replace(/\r\n?/g, '\n');
    const nl = str.match(/\n/g)?.length || 0;
    if (nl) {
      const p = this.paraIndexAt(pos), base = this.paras[p] || defaultParaStyle();
      this.paras.splice(p + 1, 0, ...Array.from({ length: nl }, () => ({ ...base })));
    }
    const k = this.splitAt(pos);
    this.runs.splice(k, 0, { text: str, style: cloneChar(style) });
    this.normalize();
  }
  deleteRange(a: number, b: number) {
    if (b <= a) return;
    const removed = this.text.slice(a, b), nl = removed.match(/\n/g)?.length || 0;
    const keep = this.styleAt(a);
    if (nl) { const p = this.paraIndexAt(a); this.paras.splice(p + 1, nl); }
    const ka = this.splitAt(a), kb = this.splitAt(b);
    this.runs.splice(ka, kb - ka);
    if (!this.runs.length || this.length === 0) this.runs = [{ text: '', style: cloneChar(keep) }];
    this.normalize();
  }
  /** Runs covering [a, b) (for copy / styled paste). */
  sliceRuns(a: number, b: number): TextRun[] {
    const out: TextRun[] = [];
    let pos = 0;
    for (const r of this.runs) {
      const s = Math.max(a, pos), e = Math.min(b, pos + r.text.length);
      if (e > s) out.push({ text: r.text.slice(s - pos, e - pos), style: cloneChar(r.style) });
      pos += r.text.length;
    }
    return out;
  }
  insertRuns(pos: number, runs: TextRun[]) {
    let p = pos;
    for (const r of runs) { this.insertText(p, r.text, r.style); p += r.text.replace(/\r\n?/g, '\n').length; }
  }
  setStyleRange(a: number, b: number, patch: Partial<CharStyle>) {
    if (b <= a) return;
    const ka = this.splitAt(a), kb = this.splitAt(b);
    for (let k = ka; k < kb; k++) this.runs[k].style = { ...cloneChar(this.runs[k].style), ...patch, color: { ...(patch.color || this.runs[k].style.color) } };
    this.normalize();
  }
  setStyleAll(patch: Partial<CharStyle>) {
    if (!this.length) { this.runs[0].style = { ...cloneChar(this.runs[0].style), ...patch, color: { ...(patch.color || this.runs[0].style.color) } }; return; }
    this.setStyleRange(0, this.length, patch);
  }
  setParaRange(a: number, b: number, patch: Partial<ParaStyle>) {
    const p0 = this.paraIndexAt(a), p1 = this.paraIndexAt(Math.max(a, b));
    for (let p = p0; p <= p1 && p < this.paras.length; p++) this.paras[p] = { ...this.paras[p], ...patch };
  }
  /** Common style of [a, b) + keys whose value differs inside the range. */
  rangeStyle(a: number, b: number): { style: CharStyle; mixed: Set<keyof CharStyle> } {
    if (b <= a) return { style: this.caretStyle(a), mixed: new Set() };
    const runs = this.sliceRuns(a, b);
    const style = runs[0].style, mixed = new Set<keyof CharStyle>();
    for (const r of runs) for (const k of CHAR_KEYS) if (!sameValue(style[k], r.style[k])) mixed.add(k);
    return { style, mixed };
  }
  /** Keep the layer name in sync with the text (until the user renames the layer). */
  syncName() {
    const n = this.text.replace(/\s+/g, ' ').trim().slice(0, 30);
    if (!n) return;
    if (!this.autoName || this.name === this.autoName) { this.name = n; this.autoName = n; }
  }

  // ---------------------------------------------------------------- geometry
  matrix(): DOMMatrix { const t = this.transform; return new DOMMatrix([t[0], t[1], t[2], t[3], this.x, this.y]); }
  translate(dx: number, dy: number) { super.translate(dx, dy); }
  applyMatrix(m: DOMMatrix) {
    const f = m.multiply(this.matrix());
    this.x = f.e; this.y = f.f;
    this.transform = [f.a, f.b, f.c, f.d, 0, 0];
    this.invalidate();
  }
  /** Uniform scale factor of the transform (for font size display). */
  get scaleFactor(): number { const t = this.transform; return Math.sqrt(Math.abs(t[0] * t[3] - t[1] * t[2])) || 1; }
  get isIdentity(): boolean { const t = this.transform; return t[0] === 1 && t[1] === 0 && t[2] === 0 && t[3] === 1; }
  get vertical() { return this.orientation === 'vertical'; }

  // ---------------------------------------------------------------- layout
  getLayout(doc: PixDocument): TextLayout {
    const res = doc.resolution || 72;
    if (this._lay && this._lay.v === this._version && this._lay.res === res) return this._lay.L;
    const L = this.vertical ? this.layoutVertical(res) : this.layoutHorizontal(res);
    this._lay = { v: this._version, res, L };
    return L;
  }

  /** Style segments of [a,b) split at run boundaries and (small caps) case changes. */
  private segments(text: string, a: number, b: number, cb: (s: number, e: number, st: CharStyle, small: boolean) => void) {
    let pos = 0;
    for (const r of this.runs) {
      const rs = pos, re = pos + r.text.length;
      pos = re;
      const s = Math.max(a, rs), e = Math.min(b, re);
      if (e <= s) continue;
      if (!r.style.smallCaps || r.style.allCaps) { cb(s, e, r.style, false); continue; }
      let k = s;
      while (k < e) {
        const lower = isLower(text[k]);
        let j = k + 1;
        while (j < e && isLower(text[j]) === lower) j++;
        cb(k, j, r.style, lower);
        k = j;
      }
    }
  }
  private makePiece(text: string, s: number, e: number, st: CharStyle, small: boolean, res: number, dispOverride?: string): Piece {
    const em = (st.size * res) / 72;
    let px = em;
    if (st.superscript || st.subscript) px *= 0.583;
    if (small) px *= 0.7;
    const font = fontCss(st, px);
    const kern = st.kerning !== 0;
    const ls = ((st.tracking + (typeof st.kerning === 'number' ? st.kerning : 0)) / 1000) * px;
    const hs = st.hScale / 100, vs = st.vScale / 100;
    const shift = (st.baseline * res) / 72 + (st.superscript ? em * 0.333 : st.subscript ? -em * 0.2 : 0);
    const disp = dispOverride ?? displayText(text.slice(s, e), st);
    const w = disp ? measure(font, ls, kern, disp).w * hs : 0;
    const fm = fontMetrics(font);
    return { start: s, end: e, disp, x: 0, y: 0, w, cw: 0, st, font, px, ls, kern, hs, vs, shift, asc: fm.a * vs, desc: fm.d * vs };
  }
  private piecesOf(text: string, a: number, b: number, res: number): Piece[] {
    const out: Piece[] = [];
    this.segments(text, a, b, (s, e, st, small) => out.push(this.makePiece(text, s, e, st, small, res)));
    return out;
  }
  private rangeWidth(text: string, a: number, b: number, res: number): number {
    let w = 0;
    for (const p of this.piecesOf(text, a, b, res)) w += p.w;
    return w;
  }
  private leadingPx(st: CharStyle, res: number) { return st.leading === 'auto' ? (st.size * 1.2 * res) / 72 : (st.leading * res) / 72; }
  private lineMetrics(text: string, line: Line, res: number) {
    let asc = 0, desc = 0, lead = 0;
    for (const p of line.pieces) { asc = Math.max(asc, p.asc + p.shift); desc = Math.max(desc, p.desc - p.shift); }
    if (!line.pieces.length || line.end === line.start) {
      const st = this.caretStyle(line.start), px = (st.size * res) / 72, fm = fontMetrics(fontCss(st, px));
      asc = Math.max(asc, fm.a * st.vScale / 100); desc = Math.max(desc, fm.d * st.vScale / 100); lead = this.leadingPx(st, res);
    }
    this.segments(text, line.start, line.end, (_s, _e, st) => { lead = Math.max(lead, this.leadingPx(st, res)); });
    line.asc = asc; line.desc = desc; line.lead = lead;
  }

  private layoutHorizontal(res: number): TextLayout {
    const text = this.text, boxed = this.textType === 'paragraph';
    const pt = (v: number) => (v * res) / 72;
    const lines: Line[] = [];
    let ps = 0;
    for (let p = 0; p < this.paras.length; p++) {
      let pe = text.indexOf('\n', ps);
      if (pe < 0) pe = text.length;
      const P = this.paras[p] || defaultParaStyle();
      const iL = pt(P.indentLeft), iR = pt(P.indentRight), iF = pt(P.indentFirst);
      const drafts: { start: number; end: number; words: Word[]; hyphen: boolean }[] = [];
      const words = breakWords(text, ps, pe);
      if (!boxed || !words.length) drafts.push({ start: ps, end: pe, words, hyphen: false });
      else {
        let cur: Word[] = [], curW = 0, first = true;
        const avail = () => Math.max(1, this.boxW - iL - iR - (first ? iF : 0));
        const flush = (hyphen = false) => { if (!cur.length) return; drafts.push({ start: cur[0].start, end: cur[cur.length - 1].end, words: cur, hyphen }); cur = []; curW = 0; first = false; };
        const queue = [...words];
        while (queue.length) {
          const wd = queue.shift()!;
          const inkW = this.rangeWidth(text, wd.start, wd.ink, res);
          const A = avail();
          if (!cur.length && inkW > A && wd.ink - wd.start > 1) {
            // a single word longer than the line: break it by characters
            let lo = wd.start + 1, hi = wd.ink;
            while (lo < hi) { const mid = Math.ceil((lo + hi) / 2); if (this.rangeWidth(text, wd.start, mid, res) <= A) lo = mid; else hi = mid - 1; }
            if (lo < wd.ink && text.charCodeAt(lo - 1) >= 0xd800 && text.charCodeAt(lo - 1) <= 0xdbff) lo = Math.max(wd.start + 1, lo - 1);
            cur.push({ start: wd.start, end: lo, ink: lo }); flush();
            queue.unshift({ start: lo, end: wd.end, ink: wd.ink });
            continue;
          }
          if (!cur.length || curW + inkW <= A) { cur.push(wd); curW += this.rangeWidth(text, wd.start, wd.end, res); continue; }
          // hyphenation
          const P2 = this.paras[p];
          if (P2?.hyphenate && wd.ink - wd.start >= 6 && /^[\p{L}]+$/u.test(text.slice(wd.start, wd.ink))) {
            const st = this.styleAt(wd.ink - 1), hy = this.makePiece('-', 0, 1, st, false, res).w;
            let best = 0;
            for (let k = wd.ink - 3; k >= wd.start + 3; k--) { if (curW + this.rangeWidth(text, wd.start, k, res) + hy <= A) { best = k; break; } }
            if (best) {
              cur.push({ start: wd.start, end: best, ink: best }); flush(true);
              queue.unshift({ start: best, end: wd.end, ink: wd.ink });
              continue;
            }
          }
          flush();
          queue.unshift(wd);
        }
        flush();
      }
      drafts.forEach((d, i) => {
        const hard = i === drafts.length - 1;
        const firstOfPara = i === 0;
        const line: Line = { start: d.start, end: d.end, para: p, hard, hyphen: d.hyphen, firstOfPara, pieces: [], x: 0, w: 0, y0: 0, baseline: 0, asc: 0, desc: 0, lead: 0, hidden: false };
        let align = P.align;
        if (!boxed) align = align === 'justify-left' || align === 'justify-all' ? 'left' : align === 'justify-center' ? 'center' : align === 'justify-right' ? 'right' : align;
        const justify = boxed && (align === 'justify-all' || (align.startsWith('justify') && !hard));
        if (hard && align !== 'justify-all') align = align === 'justify-left' ? 'left' : align === 'justify-center' ? 'center' : align === 'justify-right' ? 'right' : align;
        const avail = Math.max(1, this.boxW - iL - iR - (firstOfPara ? iF : 0));
        let x = 0, inkW = 0;
        const lastInk = d.words.length ? d.words[d.words.length - 1].ink : d.end;
        if (justify && d.words.length > 1) {
          const inkTotal = this.rangeWidth(text, d.start, lastInk, res);
          const gaps = d.words.length - 1, extra = Math.max(0, avail - inkTotal) / gaps;
          d.words.forEach((wd, wi) => {
            for (const pc of this.piecesOf(text, wd.start, wd.end, res)) { pc.x = x; x += pc.w; line.pieces.push(pc); }
            if (wi < gaps) x += extra;
          });
          inkW = avail;
        } else {
          for (const pc of this.piecesOf(text, d.start, d.end, res)) { pc.x = x; x += pc.w; line.pieces.push(pc); }
          inkW = x - this.rangeWidth(text, lastInk, d.end, res);
        }
        if (d.hyphen) {
          const st = this.styleAt(Math.max(d.start, d.end - 1));
          const hp = this.makePiece('-', d.end, d.end, st, false, res, '-');
          hp.x = x; x += hp.w; inkW += hp.w;
          line.pieces.push(hp);
        }
        let off: number;
        if (boxed) {
          const base = iL + (firstOfPara ? iF : 0);
          off = align === 'center' ? base + (avail - inkW) / 2 : align === 'right' ? base + avail - inkW : base;
        } else off = align === 'center' ? -inkW / 2 : align === 'right' ? -inkW - iR : iL + (firstOfPara ? iF : 0);
        for (const pc of line.pieces) pc.x += off;
        line.x = off; line.w = x;
        this.lineMetrics(text, line, res);
        lines.push(line);
      });
      ps = pe + 1;
    }
    // baselines
    let overflow = false;
    lines.forEach((ln, i) => {
      if (i === 0) ln.baseline = boxed ? ln.asc : 0;
      else {
        const prev = lines[i - 1];
        ln.baseline = prev.baseline + ln.lead + (ln.firstOfPara ? pt(this.paras[prev.para]?.spaceAfter || 0) + pt(this.paras[ln.para]?.spaceBefore || 0) : 0);
      }
      if (boxed && (overflow || ln.baseline + ln.desc > this.boxH + 0.5)) { ln.hidden = true; overflow = true; }
    });
    return this.finishLayout(text, lines, false, boxed, overflow);
  }

  private layoutVertical(res: number): TextLayout {
    const text = this.text, boxed = this.textType === 'paragraph';
    const pt = (v: number) => (v * res) / 72;
    const lines: Line[] = [];
    const cells = (a: number, b: number): Piece[] => {
      const out: Piece[] = [];
      this.segments(text, a, b, (s, e, st, small) => {
        for (let k = s; k < e;) {
          const c = text.charCodeAt(k), n = c >= 0xd800 && c <= 0xdbff && k + 1 < e ? 2 : 1;
          const pc = this.makePiece(text, k, k + n, st, small, res);
          pc.cw = pc.w; pc.w = pc.px * pc.vs + pc.ls;
          out.push(pc);
          k += n;
        }
      });
      return out;
    };
    let ps = 0;
    for (let p = 0; p < this.paras.length; p++) {
      let pe = text.indexOf('\n', ps);
      if (pe < 0) pe = text.length;
      const P = this.paras[p] || defaultParaStyle();
      const iL = pt(P.indentLeft), iR = pt(P.indentRight), iF = pt(P.indentFirst);
      const all = cells(ps, pe);
      const drafts: Piece[][] = [];
      if (!boxed || !all.length) drafts.push(all);
      else {
        let cur: Piece[] = [], len = 0;
        const words = breakWords(text, ps, pe);
        let ci = 0;
        for (const wd of words) {
          const wc: Piece[] = [];
          while (ci < all.length && all[ci].start < wd.end) wc.push(all[ci++]);
          const inkLen = wc.filter(c => c.start < wd.ink).reduce((s, c) => s + c.w, 0);
          const A = Math.max(1, this.boxH - iL - iR - (drafts.length === 0 ? iF : 0));
          if (cur.length && len + inkLen > A) { drafts.push(cur); cur = []; len = 0; }
          for (const c of wc) {
            if (cur.length && len + c.w > A && c.start < wd.ink) { drafts.push(cur); cur = []; len = 0; }
            cur.push(c); len += c.w;
          }
        }
        if (cur.length) drafts.push(cur);
      }
      drafts.forEach((cs, i) => {
        const start = cs.length ? cs[0].start : ps, end = i === drafts.length - 1 ? pe : cs.length ? cs[cs.length - 1].end : ps;
        const line: Line = { start, end, para: p, hard: i === drafts.length - 1, hyphen: false, firstOfPara: i === 0, pieces: cs, x: 0, w: 0, y0: 0, baseline: 0, asc: 0, desc: 0, lead: 0, hidden: false };
        let y = 0;
        for (const c of cs) { c.y = y; y += c.w; }
        let inkLen = y;
        for (let k = cs.length - 1; k >= 0 && isWS(text[cs[k].start]); k--) inkLen -= cs[k].w;
        const avail = Math.max(1, this.boxH - iL - iR - (i === 0 ? iF : 0));
        let align = P.align;
        if (align.startsWith('justify')) align = align === 'justify-center' ? 'center' : align === 'justify-right' ? 'right' : 'left';
        let off: number;
        if (boxed) { const base = iL + (i === 0 ? iF : 0); off = align === 'center' ? base + (avail - inkLen) / 2 : align === 'right' ? base + avail - inkLen : base; }
        else off = align === 'center' ? -inkLen / 2 : align === 'right' ? -inkLen : iL + (i === 0 ? iF : 0);
        for (const c of cs) c.y += off;
        line.y0 = off; line.w = y;
        this.lineMetrics(text, line, res);
        let wmax = 0;
        for (const c of cs) wmax = Math.max(wmax, c.cw);
        line.asc = Math.max(line.lead, wmax) / 2; line.desc = line.asc;
        lines.push(line);
      });
      ps = pe + 1;
    }
    let overflow = false;
    lines.forEach((ln, i) => {
      if (i === 0) ln.x = boxed ? this.boxW - ln.lead / 2 : 0;
      else {
        const prev = lines[i - 1];
        ln.x = prev.x - ln.lead - (ln.firstOfPara ? pt(this.paras[prev.para]?.spaceAfter || 0) + pt(this.paras[ln.para]?.spaceBefore || 0) : 0);
      }
      ln.baseline = ln.x;
      if (boxed && (overflow || ln.x - ln.lead / 2 < -0.5)) { ln.hidden = true; overflow = true; }
    });
    return this.finishLayout(text, lines, true, boxed, overflow);
  }

  private finishLayout(text: string, lines: Line[], vertical: boolean, boxed: boolean, overflow: boolean): TextLayout {
    let bounds: Rect | null = null, ink: Rect | null = null;
    for (const ln of lines) {
      if (ln.hidden) continue;
      if (vertical) {
        const hw = Math.max(ln.lead, ln.asc * 2) / 2;
        bounds = rectUnion(bounds, ln.x - hw, ln.y0, ln.x + hw, ln.y0 + Math.max(ln.w, 1));
        for (const p of ln.pieces) {
          if (!p.disp.trim()) continue;
          const pad = p.px * 0.25 + 2;
          ink = rectUnion(ink, ln.x - p.cw / 2 - pad, p.y - pad, ln.x + p.cw / 2 + pad, p.y + p.w + pad);
        }
      } else {
        bounds = rectUnion(bounds, ln.x, ln.baseline - ln.asc, ln.x + Math.max(ln.w, 1), ln.baseline + ln.desc);
        for (const p of ln.pieces) {
          if (!p.disp.trim() && !p.st.underline && !p.st.strike) continue;
          const m = measure(p.font, p.ls, p.kern, p.disp);
          const by = ln.baseline - p.shift;
          const pad = 2 + (p.st.fauxBold ? p.px * 0.05 : 0) + (this.antiAlias === 'strong' ? p.px * 0.02 : 0);
          const slant = p.st.fauxItalic ? 0.22 * p.px : 0;
          ink = rectUnion(ink, p.x - m.l * p.hs - pad - slant * 0.3, by - Math.max(m.a, p.asc / p.vs) * p.vs - pad,
            p.x + Math.max(p.w, m.r * p.hs) + pad + slant, by + Math.max(m.d * p.vs, p.st.underline ? p.px * 0.2 : 0, p.desc * 0.5) + pad);
        }
      }
    }
    if (!bounds) bounds = boxed ? { x: 0, y: 0, w: Math.max(1, this.boxW), h: Math.max(1, this.boxH) } : { x: 0, y: -10, w: 1, h: 12 };
    return { text, lines, vertical, boxed, overflow, bounds, ink };
  }

  /** Char boundary positions of a line (x for horizontal, y for vertical), indexed from line.start. */
  positions(L: TextLayout, line: Line): Float64Array {
    if (line._pos) return line._pos;
    const n = line.end - line.start, out = new Float64Array(n + 1);
    if (L.vertical) {
      out.fill(line.y0);
      for (const p of line.pieces) { out[p.start - line.start] = p.y; out[p.end - line.start] = p.y + p.w; }
      for (let i = 1; i <= n; i++) if (out[i] < out[i - 1]) out[i] = out[i - 1];
    } else {
      out.fill(line.x);
      let last = line.x;
      for (const p of line.pieces) {
        if (p.end === p.start) continue;
        const pos = prefixPositions(p.font, p.ls, p.kern, p.disp, p.w / (p.hs || 1));
        for (let k = 0; k <= p.end - p.start; k++) out[p.start - line.start + k] = p.x + pos[Math.min(k, pos.length - 1)] * p.hs;
        last = p.x + p.w;
      }
      out[n] = Math.max(out[n], n ? last : line.x);
    }
    line._pos = out;
    return out;
  }
  /** Index of the line holding caret position i. */
  lineOf(L: TextLayout, i: number): number {
    let best = 0;
    for (let k = 0; k < L.lines.length; k++) {
      const ln = L.lines[k];
      if (i >= ln.start && i <= ln.end) {
        best = k;
        if (!(i === ln.end && !ln.hard && k + 1 < L.lines.length && L.lines[k + 1].start === i)) return k;
      } else if (ln.start > i) break;
    }
    return best;
  }
  /** Caret segment (local coords) for position i: [x1, y1, x2, y2] or null when in hidden overflow. */
  caretSegment(L: TextLayout, i: number): [number, number, number, number] | null {
    if (!L.lines.length) return null;
    const ln = L.lines[this.lineOf(L, i)];
    if (ln.hidden) return null;
    const pos = this.positions(L, ln), v = pos[Math.max(0, Math.min(pos.length - 1, i - ln.start))];
    if (L.vertical) { const hw = Math.max(ln.lead, ln.asc * 2) / 2; return [ln.x - hw, v, ln.x + hw, v]; }
    return [v, ln.baseline - ln.asc, v, ln.baseline + ln.desc];
  }
  /** Selection rectangles (local) for [a, b). */
  selectionRects(L: TextLayout, a: number, b: number): Rect[] {
    const out: Rect[] = [];
    if (b <= a) return out;
    for (const ln of L.lines) {
      if (ln.hidden || ln.end < a || ln.start > b || (ln.start === b && b > a)) continue;
      const s = Math.max(a, ln.start), e = Math.min(b, ln.end);
      const pos = this.positions(L, ln);
      let v0 = pos[s - ln.start], v1 = pos[e - ln.start];
      if (b > ln.end && ln.hard) v1 += (ln.lead || 10) * 0.25;   // selected newline
      if (v1 <= v0 && !(b > ln.end)) continue;
      if (L.vertical) { const hw = Math.max(ln.lead, ln.asc * 2) / 2; out.push({ x: ln.x - hw, y: v0, w: hw * 2, h: v1 - v0 }); }
      else out.push({ x: v0, y: ln.baseline - ln.asc, w: v1 - v0, h: ln.asc + ln.desc });
    }
    return out;
  }
  /** Nearest caret index to a local point. */
  hitTest(L: TextLayout, x: number, y: number): number {
    const vis = L.lines.filter(l => !l.hidden);
    if (!vis.length) return 0;
    let best = vis[0], bd = Infinity;
    for (const ln of vis) {
      const d = L.vertical ? Math.abs(x - ln.x) : (y < ln.baseline - ln.asc ? ln.baseline - ln.asc - y : y > ln.baseline + ln.desc ? y - ln.baseline - ln.desc : 0);
      if (d < bd) { bd = d; best = ln; }
    }
    return this.indexInLine(L, best, L.vertical ? y : x);
  }
  indexInLine(L: TextLayout, ln: Line, v: number): number {
    const pos = this.positions(L, ln);
    let bi = 0, bd = Infinity;
    for (let k = 0; k < pos.length; k++) {
      const c = this.text.charCodeAt(ln.start + k - 1);
      if (k > 0 && c >= 0xd800 && c <= 0xdbff) continue;
      const d = Math.abs(pos[k] - v);
      if (d < bd) { bd = d; bi = k; }
    }
    return ln.start + bi;
  }
  /** Warp a local point (identity if no warp). */
  warpLocal(L: TextLayout, x: number, y: number): [number, number] {
    if (this.warp.style === 'none') return [x, y];
    const b = L.bounds, cx = b.x + b.w / 2, cy = b.y + b.h / 2;
    const [X, Y] = warpXY(this.warp, x - cx, y - cy, Math.max(1, b.w / 2), Math.max(1, b.h / 2));
    return [cx + X, cy + Y];
  }
  /** Approximate inverse of warpLocal. */
  unwarpLocal(L: TextLayout, x: number, y: number): [number, number] {
    if (this.warp.style === 'none') return [x, y];
    let px = x, py = y;
    for (let i = 0; i < 40; i++) {
      const [wx, wy] = this.warpLocal(L, px, py);
      const ex = x - wx, ey = y - wy;
      px += ex * 0.7; py += ey * 0.7;
      if (Math.abs(ex) + Math.abs(ey) < 0.05) break;
    }
    return [px, py];
  }
  /** Local frame used for the editing box / hit area. */
  frameRect(L: TextLayout): Rect {
    if (this.textType === 'paragraph') return { x: 0, y: 0, w: this.boxW, h: this.boxH };
    return L.bounds;
  }

  // ---------------------------------------------------------------- rendering
  private drawLayout(ctx: CanvasRenderingContext2D, L: TextLayout, color: string | null) {
    ctx.textBaseline = 'alphabetic';
    ctx.textAlign = 'left';
    const strong = this.antiAlias === 'strong';
    for (const ln of L.lines) {
      if (ln.hidden) continue;
      for (const p of ln.pieces) {
        if (!p.disp) continue;
        const col = color || `rgb(${p.st.color.r},${p.st.color.g},${p.st.color.b})`;
        setFont(ctx, p.font, p.ls, p.kern);
        ctx.fillStyle = col;
        ctx.save();
        if (L.vertical) {
          const fm = fontMetrics(p.font);
          ctx.translate(ln.x - p.cw / 2, p.y + p.w / 2 + ((fm.a - fm.d) / 2) * p.vs);
        } else ctx.translate(p.x, ln.baseline - p.shift);
        if (p.hs !== 1 || p.vs !== 1) ctx.scale(p.hs, p.vs);
        if (p.st.fauxItalic) ctx.transform(1, 0, -0.21, 1, 0, 0);
        ctx.fillText(p.disp, 0, 0);
        if (p.st.fauxBold || strong) {
          ctx.lineWidth = (p.st.fauxBold ? p.px * 0.045 : 0) + (strong ? p.px * 0.025 : 0);
          ctx.strokeStyle = col; ctx.lineJoin = 'round';
          ctx.strokeText(p.disp, 0, 0);
        }
        ctx.restore();
        if (!L.vertical && (p.st.underline || p.st.strike)) {
          const t = Math.max(1, p.px * 0.055), by = ln.baseline - p.shift;
          if (p.st.underline) ctx.fillRect(p.x, by + p.px * 0.11 * p.vs, p.w, t);
          if (p.st.strike) ctx.fillRect(p.x, by - p.px * 0.3 * p.vs, p.w, t);
        } else if (L.vertical && (p.st.underline || p.st.strike)) {
          const t = Math.max(1, p.px * 0.055);
          if (p.st.underline) ctx.fillRect(ln.x + ln.asc - t, p.y, t, p.w);
          if (p.st.strike) ctx.fillRect(ln.x - t / 2, p.y, t, p.w);
        }
      }
    }
  }
  /** Rasterize into document space at `scale` (1 = document pixels). color overrides every run colour (masks). */
  renderTo(doc: PixDocument, scale = 1, color: string | null = null, noAA = false): LayerContent | null {
    const L = this.getLayout(doc);
    if (!L.ink) return null;
    const S = new DOMMatrix().scale(scale, scale).multiply(this.matrix());
    let out: HTMLCanvasElement, r: Rect;
    if (this.warp.style === 'none') {
      r = transformedBounds(S, L.ink);
      if (r.w * r.h > 16384 * 16384) return null;
      out = createCanvas(r.w, r.h);
      const ctx = ctx2d(out);
      ctx.setTransform(new DOMMatrix().translate(-r.x, -r.y).multiply(S));
      this.drawLayout(ctx, L, color);
    } else {
      const k = Math.max(1, Math.min(4, scale * Math.sqrt(Math.abs(S.a * S.d - S.b * S.c)) / Math.max(scale, 1e-6) * scale));
      const ink = L.ink;
      const lc = createCanvas(Math.min(16384, Math.ceil(ink.w * k)), Math.min(16384, Math.ceil(ink.h * k)));
      const lx = ctx2d(lc);
      lx.setTransform(k, 0, 0, k, -ink.x * k, -ink.y * k);
      this.drawLayout(lx, L, color);
      const wr = meshWarp(lc, ink, k, (x, y) => this.warpLocal(L, x, y));
      r = transformedBounds(S, wr.rect);
      out = createCanvas(r.w, r.h);
      const ctx = ctx2d(out);
      ctx.imageSmoothingQuality = 'high';
      ctx.setTransform(new DOMMatrix().translate(-r.x, -r.y).multiply(S).translate(wr.rect.x, wr.rect.y).scale(1 / k, 1 / k));
      ctx.drawImage(wr.canvas, 0, 0);
    }
    if (!noAA) postAntiAlias(out, this.antiAlias);
    return { canvas: out, x: r.x, y: r.y };
  }
  getContent(doc: PixDocument): LayerContent | null {
    const res = doc.resolution || 72;
    if (this._ras && this._ras.v === this._version && this._ras.res === res) return this._ras.c;
    let c: LayerContent | null = null;
    try { c = this.renderTo(doc, 1); } catch (err) { console.error('[text-layer]', err); }
    this._ras = { v: this._version, res, c };
    return c;
  }
}

registerLayerClass('text', TextLayer as any);
