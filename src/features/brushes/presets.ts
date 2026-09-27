// Brush presets: procedurally generated sampled tips (Dry Media, Wet Media, Special Effects), preset folders,
// custom presets (persisted), stroke thumbnails, applying presets to tool settings, Edit › Define Brush Preset.
import { resources, type BrushPreset } from '../../core/registry';
import { createCanvas, ctx2d, cropCanvas, alphaBounds } from '../../core/canvas';
import { Emitter } from '../../core/events';
import { app } from '../../core/app';
import { registerCommand } from '../../core/commands';
import { normDynamics, renderStrokePreview, type Dynamics, DYN_SECTIONS } from './dynamics';
import { brushPickerExt } from '../../ui/brush-picker';
import { openDialog } from '../../ui/dialog';
import { h } from '../../ui/dom';
import { toast } from '../../ui/toast';

export interface BrushPresetEx extends BrushPreset {
  group?: string;
  dyn?: Partial<Dynamics> | Dynamics;
  flow?: number;           // 0..1
  flipX?: boolean; flipY?: boolean;
  custom?: boolean;
  /** Bumped on edit (thumbnail cache key). */
  v?: number;
}

export const brushEvents = new Emitter<{ change: void }>();
export const GENERAL = 'General Brushes', DRY = 'Dry Media Brushes', WET = 'Wet Media Brushes', FX = 'Special Effects Brushes', CUSTOM = 'Custom Brushes';

// ------------------------------------------------------------------ procedural tips
function seeded(seed: number) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
function tip(w: number, hh: number, seed: number, draw: (x: CanvasRenderingContext2D, r: () => number) => void): HTMLCanvasElement {
  const c = createCanvas(w, hh), x = ctx2d(c);
  x.fillStyle = '#000'; x.strokeStyle = '#000';
  draw(x, seeded(seed));
  return c;
}
/** Knock random speckles out of a tip (grain). */
function grain(x: CanvasRenderingContext2D, r: () => number, amount: number, dotMax = 1.6) {
  const c = x.canvas, n = Math.round(c.width * c.height * amount);
  x.save();
  x.globalCompositeOperation = 'destination-out';
  for (let i = 0; i < n; i++) { x.globalAlpha = 0.3 + r() * 0.7; x.fillRect(r() * c.width, r() * c.height, 0.6 + r() * dotMax, 0.6 + r() * dotMax); }
  x.restore();
}
function blob(x: CanvasRenderingContext2D, cx: number, cy: number, rad: number, r: () => number, rough = 0.15, pts = 40) {
  x.beginPath();
  const ph = r() * 10;
  for (let i = 0; i <= pts; i++) {
    const a = (i / pts) * Math.PI * 2;
    const k = 1 + (Math.sin(a * 3 + ph) * 0.5 + Math.sin(a * 7 + ph * 2) * 0.3 + (r() - 0.5)) * rough;
    const px = cx + Math.cos(a) * rad * k, py = cy + Math.sin(a) * rad * k;
    i ? x.lineTo(px, py) : x.moveTo(px, py);
  }
  x.closePath();
}
function softDot(x: CanvasRenderingContext2D, cx: number, cy: number, rad: number, a: number) {
  const g = x.createRadialGradient(cx, cy, 0, cx, cy, rad);
  g.addColorStop(0, `rgba(0,0,0,${a})`); g.addColorStop(1, 'rgba(0,0,0,0)');
  x.fillStyle = g; x.fillRect(cx - rad, cy - rad, rad * 2, rad * 2);
}

const TIPS: Record<string, () => HTMLCanvasElement> = {
  pencil: () => tip(32, 32, 11, (x, r) => { x.globalAlpha = 0.9; blob(x, 16, 16, 13, r, 0.06); x.fill(); grain(x, r, 0.35, 1.2); }),
  charcoal: () => tip(96, 96, 21, (x, r) => {
    for (let i = 0; i < 260; i++) { const a = r() * Math.PI * 2, d = Math.sqrt(r()) * 40; x.globalAlpha = 0.25 + r() * 0.6; blob(x, 48 + Math.cos(a) * d, 48 + Math.sin(a) * d * 0.8, 1.5 + r() * 5, r, 0.4, 10); x.fill(); }
    grain(x, r, 0.25, 2.2);
  }),
  chalk: () => tip(80, 80, 31, (x, r) => {
    x.globalAlpha = 0.85; x.beginPath(); (x as any).roundRect ? (x as any).roundRect(10, 12, 60, 56, 10) : x.rect(10, 12, 60, 56); x.fill();
    grain(x, r, 0.9, 3.5);
  }),
  pastel: () => tip(90, 64, 41, (x, r) => {
    for (let i = 0; i < 90; i++) softDot(x, 45 + (r() - 0.5) * 50, 32 + (r() - 0.5) * 30, 8 + r() * 10, 0.25);
    grain(x, r, 0.6, 2);
  }),
  watercolor: () => tip(128, 128, 51, (x, r) => {
    x.globalAlpha = 0.45; blob(x, 64, 64, 50, r, 0.18, 60); x.fill();
    x.globalAlpha = 0.5; x.lineWidth = 4; blob(x, 64, 64, 50, r, 0.18, 60); x.stroke();
    x.globalAlpha = 0.3; for (let i = 0; i < 12; i++) { blob(x, 64 + (r() - 0.5) * 50, 64 + (r() - 0.5) * 50, 8 + r() * 14, r, 0.3, 16); x.fill(); }
  }),
  ink: () => tip(64, 64, 61, (x, r) => { blob(x, 32, 32, 28, r, 0.05, 50); x.fill(); }),
  oil: () => tip(120, 44, 71, (x, r) => {
    for (let i = 0; i < 34; i++) {
      const px = 6 + (i / 33) * 108 + (r() - 0.5) * 2;
      x.globalAlpha = 0.35 + r() * 0.6; x.lineWidth = 1.2 + r() * 2.8; x.lineCap = 'round';
      x.beginPath(); x.moveTo(px, 4 + r() * 8); x.lineTo(px + (r() - 0.5) * 3, 40 - r() * 8); x.stroke();
    }
  }),
  spatter: () => tip(110, 110, 81, (x, r) => {
    for (let i = 0; i < 70; i++) { const a = r() * Math.PI * 2, d = Math.pow(r(), 0.7) * 48, s = 0.8 + Math.pow(r(), 3) * 9; x.globalAlpha = 0.6 + r() * 0.4; x.beginPath(); x.arc(55 + Math.cos(a) * d, 55 + Math.sin(a) * d, s, 0, 7); x.fill(); }
  }),
  leaves: () => tip(100, 100, 91, x => {
    x.beginPath(); x.moveTo(50, 6); x.bezierCurveTo(90, 30, 82, 72, 50, 94); x.bezierCurveTo(18, 72, 10, 30, 50, 6); x.fill();
    x.globalCompositeOperation = 'destination-out'; x.lineWidth = 2.2; x.beginPath(); x.moveTo(50, 12); x.lineTo(50, 90);
    for (let i = 0; i < 5; i++) { const yy = 26 + i * 12; x.moveTo(50, yy + 8); x.lineTo(30, yy); x.moveTo(50, yy + 8); x.lineTo(70, yy); }
    x.stroke();
  }),
  grass: () => tip(100, 120, 101, (x, r) => {
    for (let i = 0; i < 7; i++) {
      const bx = 25 + r() * 50, lean = (r() - 0.5) * 60, ht = 60 + r() * 55, w = 3 + r() * 4;
      x.globalAlpha = 0.7 + r() * 0.3;
      x.beginPath(); x.moveTo(bx - w, 119); x.quadraticCurveTo(bx + lean * 0.3, 119 - ht * 0.6, bx + lean, 119 - ht); x.quadraticCurveTo(bx + lean * 0.3 + w * 0.5, 119 - ht * 0.6, bx + w, 119); x.fill();
    }
  }),
  stars: () => tip(100, 100, 111, x => {
    x.beginPath();
    for (let i = 0; i < 10; i++) { const a = -Math.PI / 2 + (i * Math.PI) / 5, rr = i % 2 ? 19 : 48; x.lineTo(50 + Math.cos(a) * rr, 52 + Math.sin(a) * rr); }
    x.closePath(); x.fill();
  }),
  bokeh: () => tip(100, 100, 121, x => {
    x.globalAlpha = 0.45; x.beginPath(); x.arc(50, 50, 44, 0, 7); x.fill();
    x.globalAlpha = 0.9; x.lineWidth = 3; x.beginPath(); x.arc(50, 50, 44, 0, 7); x.stroke();
  }),
  smoke: () => tip(128, 128, 131, (x, r) => { for (let i = 0; i < 60; i++) { const a = r() * Math.PI * 2, d = Math.sqrt(r()) * 38; softDot(x, 64 + Math.cos(a) * d, 64 + Math.sin(a) * d, 10 + r() * 22, 0.12); } }),
  hair: () => tip(100, 100, 141, (x, r) => {
    x.lineCap = 'round';
    for (let i = 0; i < 46; i++) {
      const sx = 10 + r() * 80, sy = 10 + r() * 20;
      x.globalAlpha = 0.4 + r() * 0.6; x.lineWidth = 0.6 + r() * 0.9;
      x.beginPath(); x.moveTo(sx, sy); x.bezierCurveTo(sx + (r() - 0.5) * 40, sy + 30, sx + (r() - 0.5) * 40, sy + 55, sx + (r() - 0.5) * 30, sy + 70 + r() * 10); x.stroke();
    }
  }),
};

// ------------------------------------------------------------------ built-in presets
type Def = Omit<BrushPresetEx, 'tip'> & { tipKey?: string };
const D = (d: Partial<Dynamics> | any) => d as Partial<Dynamics>;
const BUILTIN_DEFS: Def[] = [
  // General (ids of the core round presets are kept so saved tool settings still resolve)
  { id: 'soft-round', name: 'Soft Round', size: 45, hardness: 0, group: GENERAL },
  { id: 'hard-round', name: 'Hard Round', size: 30, hardness: 1, group: GENERAL },
  { id: 'soft-round-pressure', name: 'Soft Round Pressure Size', size: 45, hardness: 0, group: GENERAL, dyn: D({ shape: { on: true, sizeControl: 'pressure' } }) },
  { id: 'soft-round-pressure-opacity', name: 'Soft Round Pressure Opacity', size: 45, hardness: 0, group: GENERAL, dyn: D({ transfer: { on: true, opacityControl: 'pressure' } }) },
  { id: 'hard-round-pressure', name: 'Hard Round Pressure Opacity', size: 30, hardness: 1, group: GENERAL, dyn: D({ transfer: { on: true, opacityControl: 'pressure' } }) },
  { id: 'hard-round-pressure-size', name: 'Hard Round Pressure Size', size: 30, hardness: 1, group: GENERAL, dyn: D({ shape: { on: true, sizeControl: 'pressure' } }) },
  { id: 'soft-small', name: 'Soft Round 9', size: 9, hardness: 0, group: GENERAL },
  { id: 'hard-small', name: 'Hard Round 5', size: 5, hardness: 1, group: GENERAL },
  { id: 'medium-round', name: 'Round 50% Hardness', size: 60, hardness: 0.5, group: GENERAL },
  { id: 'soft-large', name: 'Soft Round 200', size: 200, hardness: 0, group: GENERAL },
  // Dry media
  { id: 'pencil', tipKey: 'pencil', name: 'Pencil', size: 8, hardness: 1, spacing: 0.1, group: DRY, dyn: D({ shape: { on: true, angleJitter: 100 }, transfer: { on: true, opacityControl: 'pressure' } }) },
  { id: 'charcoal', tipKey: 'charcoal', name: 'Charcoal', size: 40, hardness: 1, spacing: 0.15, group: DRY, dyn: D({ shape: { on: true, angleJitter: 100, sizeJitter: 15 }, texture: { on: true, pattern: 'canvas-weave', depth: 70, scale: 100 }, transfer: { on: true, flow: 30 } }) },
  { id: 'chalk', tipKey: 'chalk', name: 'Chalk', size: 36, hardness: 1, spacing: 0.2, group: DRY, dyn: D({ shape: { on: true, angleJitter: 100 }, texture: { on: true, pattern: 'noise', depth: 60 }, noise: true }) },
  { id: 'pastel', tipKey: 'pastel', name: 'Pastel', size: 50, hardness: 1, spacing: 0.15, group: DRY, dyn: D({ shape: { on: true, angleControl: 'direction' }, texture: { on: true, pattern: 'canvas-weave', depth: 80, scale: 150 } }) },
  // Wet media
  { id: 'watercolor', tipKey: 'watercolor', name: 'Watercolor', size: 70, hardness: 1, spacing: 0.15, flow: 0.35, group: WET, dyn: D({ shape: { on: true, sizeJitter: 20, angleJitter: 100 }, wetEdges: true, transfer: { on: true, flow: 40 } }) },
  { id: 'ink', tipKey: 'ink', name: 'Ink', size: 16, hardness: 1, spacing: 0.05, group: WET, dyn: D({ shape: { on: true, sizeControl: 'pressure', minDiameter: 20 } }) },
  { id: 'oil', tipKey: 'oil', name: 'Oil Flat Bristle', size: 60, hardness: 1, spacing: 0.06, flow: 0.6, group: WET, dyn: D({ shape: { on: true, angleControl: 'direction' }, transfer: { on: true, flow: 20, opacityControl: 'pressure' }, texture: { on: true, pattern: 'canvas-weave', depth: 35 } }) },
  // Special effects
  { id: 'spatter', tipKey: 'spatter', name: 'Spatter', size: 60, hardness: 1, spacing: 0.6, group: FX, dyn: D({ shape: { on: true, sizeJitter: 50, angleJitter: 100 }, scatter: { on: true, amount: 80, both: true, count: 2 } }) },
  { id: 'leaves', tipKey: 'leaves', name: 'Leaves', size: 50, hardness: 1, spacing: 0.9, group: FX, dyn: D({ shape: { on: true, sizeJitter: 60, minDiameter: 20, angleJitter: 100, roundJitter: 40 }, scatter: { on: true, amount: 180, both: true, count: 2, countJitter: 50 }, color: { on: true, perTip: true, fgbg: 100, hue: 8, bri: 15 } }) },
  { id: 'grass', tipKey: 'grass', name: 'Grass', size: 70, hardness: 1, spacing: 0.4, group: FX, dyn: D({ shape: { on: true, sizeJitter: 40, angleJitter: 8, flipX: true }, scatter: { on: true, amount: 60, count: 2 }, color: { on: true, perTip: true, fgbg: 100, hue: 5, bri: 10 } }) },
  { id: 'stars', tipKey: 'stars', name: 'Stars', size: 40, hardness: 1, spacing: 1.2, group: FX, dyn: D({ shape: { on: true, sizeJitter: 80, angleJitter: 100 }, scatter: { on: true, amount: 250, both: true, count: 1 }, transfer: { on: true, opacity: 60 } }) },
  { id: 'bokeh', tipKey: 'bokeh', name: 'Bokeh', size: 80, hardness: 1, spacing: 1.1, flow: 0.6, group: FX, dyn: D({ shape: { on: true, sizeJitter: 70 }, scatter: { on: true, amount: 200, both: true, count: 2 }, color: { on: true, perTip: true, fgbg: 100, hue: 12 }, transfer: { on: true, opacity: 70 } }) },
  { id: 'smoke', tipKey: 'smoke', name: 'Smoke', size: 120, hardness: 1, spacing: 0.2, flow: 0.25, group: FX, dyn: D({ shape: { on: true, sizeJitter: 30, angleJitter: 100 }, scatter: { on: true, amount: 40, both: true }, transfer: { on: true, flow: 50 } }) },
  { id: 'hair', tipKey: 'hair', name: 'Hair', size: 60, hardness: 1, spacing: 0.12, group: FX, dyn: D({ shape: { on: true, angleControl: 'direction' }, transfer: { on: true, opacityControl: 'pressure' } }) },
];
const builtinIds = new Set(BUILTIN_DEFS.map(d => d.id));
const tipCanvases = new Map<string, HTMLCanvasElement>();
function makeBuiltin(d: Def): BrushPresetEx {
  const { tipKey, ...rest } = d;
  let t: HTMLCanvasElement | null = null;
  if (tipKey) { t = tipCanvases.get(tipKey) || TIPS[tipKey](); tipCanvases.set(tipKey, t); }
  return { ...rest, tip: t, dyn: d.dyn ? normDynamics(d.dyn) : undefined };
}

// ------------------------------------------------------------------ persistence
interface Saved { custom: any[]; removed: string[]; renamed: Record<string, string>; groups: string[]; moved: Record<string, string> }
const KEY = 'pixora.brushes.v1';
let saved: Saved = (() => { try { return { custom: [], removed: [], renamed: {}, groups: [], moved: {}, ...JSON.parse(localStorage.getItem(KEY) || '{}') }; } catch { return { custom: [], removed: [], renamed: {}, groups: [], moved: {} }; } })();
const customTips = new Map<string, HTMLCanvasElement>();
const thumbCache = new Map<string, string>();

function canvasFromDataURL(url: string, w: number, hh: number): HTMLCanvasElement {
  const c = createCanvas(w, hh), img = new Image();
  img.onload = () => { ctx2d(c).drawImage(img, 0, 0); c.dataset.v = String(Date.now()); brushEvents.emit('change'); };
  img.src = url;
  return c;
}
function persist() {
  const custom = resources.brushes.filter((p: BrushPresetEx) => p.custom).map((p: BrushPresetEx) => {
    const { tip: t, ...rest } = p;
    return { ...rest, tipData: t ? t.toDataURL() : null, tw: t?.width, th: t?.height };
  });
  saved.custom = custom;
  try { localStorage.setItem(KEY, JSON.stringify(saved)); }
  catch { toast('Could not save the brush presets (browser storage is full).', 'error'); }
}

/** Rebuild resources.brushes: built-ins (minus removed, with renames/moves) + custom + presets added by other modules. */
function rebuild() {
  const others = resources.brushes.filter((p: BrushPresetEx) => !builtinIds.has(p.id) && !p.custom && !(p as any)._builtin);
  const list: BrushPresetEx[] = [];
  for (const d of BUILTIN_DEFS) {
    if (saved.removed.includes(d.id)) continue;
    const p = makeBuiltin(d);
    (p as any)._builtin = true;
    if (saved.renamed[d.id]) p.name = saved.renamed[d.id];
    if (saved.moved[d.id]) p.group = saved.moved[d.id];
    list.push(p);
  }
  for (const c of saved.custom) {
    let t: HTMLCanvasElement | null = null;
    if (c.tipData) { t = customTips.get(c.id) || canvasFromDataURL(c.tipData, c.tw || 64, c.th || 64); customTips.set(c.id, t); }
    const { tipData: _a, tw: _b, th: _c, ...rest } = c;
    list.push({ ...rest, tip: t, custom: true });
  }
  resources.brushes.splice(0, resources.brushes.length, ...list, ...others);
  thumbCache.clear();
  brushEvents.emit('change');
}
rebuild();

// ------------------------------------------------------------------ queries & edits
export const allPresets = () => resources.brushes as BrushPresetEx[];
export const findPreset = (id?: string | null) => (id ? allPresets().find(p => p.id === id) || null : null);

export function brushGroups(): { name: string; items: BrushPresetEx[] }[] {
  const names: string[] = [];
  for (const p of allPresets()) { const g = p.group || 'Other Brushes'; if (!names.includes(g)) names.push(g); }
  for (const g of saved.groups) if (!names.includes(g)) names.push(g);
  return names.map(name => ({ name, items: allPresets().filter(p => (p.group || 'Other Brushes') === name) }));
}

let uid = Date.now() % 100000;
export function addPreset(p: Omit<BrushPresetEx, 'id'> & { id?: string }): BrushPresetEx {
  const np: BrushPresetEx = { ...p, id: p.id || `custom-${uid++}`, custom: true, group: p.group || CUSTOM };
  resources.brushes.push(np);
  if (!saved.groups.includes(np.group!) && ![GENERAL, DRY, WET, FX].includes(np.group!)) saved.groups.push(np.group!);
  persist(); thumbCache.clear(); brushEvents.emit('change');
  return np;
}
export function deletePreset(p: BrushPresetEx) {
  const i = resources.brushes.indexOf(p);
  if (i >= 0) resources.brushes.splice(i, 1);
  if (!p.custom) saved.removed.push(p.id);
  persist(); brushEvents.emit('change');
}
export function renamePreset(p: BrushPresetEx, name: string) {
  p.name = name;
  if (!p.custom) saved.renamed[p.id] = name;
  persist(); brushEvents.emit('change');
}
export function movePreset(p: BrushPresetEx, group: string) {
  p.group = group;
  if (!p.custom) saved.moved[p.id] = group;
  persist(); brushEvents.emit('change');
}
export function addGroup(name: string) { if (!saved.groups.includes(name)) saved.groups.push(name); persist(); brushEvents.emit('change'); }
export function renameGroup(from: string, to: string) {
  for (const p of allPresets()) if ((p.group || 'Other Brushes') === from) { p.group = to; if (!p.custom) saved.moved[p.id] = to; }
  saved.groups = saved.groups.map(g => (g === from ? to : g));
  persist(); brushEvents.emit('change');
}
export function deleteGroup(name: string) {
  for (const p of [...allPresets()]) if ((p.group || 'Other Brushes') === name) deletePreset(p);
  saved.groups = saved.groups.filter(g => g !== name);
  persist(); brushEvents.emit('change');
}
export function restoreDefaultBrushes() {
  saved = { custom: saved.custom, removed: [], renamed: {}, groups: saved.groups, moved: {} };
  persist(); rebuild();
}

// ------------------------------------------------------------------ settings <-> presets
/** Apply a preset to a painting tool's settings (locked dynamics sections are kept). */
export function applyPreset(s: any, p: BrushPresetEx) {
  s.size = p.size; s.hardness = p.hardness; s.tipId = p.id;
  s.spacing = p.spacing ?? 0.25; s.roundness = p.roundness ?? 1; s.angle = p.angle ?? 0;
  if ('flipX' in s) { s.flipX = !!p.flipX; s.flipY = !!p.flipY; }
  if ('flow' in s && p.flow !== undefined) s.flow = p.flow;
  if ('dyn' in s) {
    const cur = normDynamics(s.dyn), next = normDynamics(p.dyn) as any;
    for (const k of [...DYN_SECTIONS, 'noise', 'wetEdges', 'buildup', 'smoothing']) if (cur.locks[k]) next[k] = (cur as any)[k];
    if (cur.protectTexture || cur.locks.texture) next.texture = cur.texture;
    next.locks = cur.locks; next.protectTexture = cur.protectTexture;
    s.dyn = next;
  }
}
/** New preset from the current settings of a tool. */
export function presetFromSettings(s: any, name: string, group = CUSTOM): BrushPresetEx {
  const base = findPreset(s.tipId);
  return addPreset({
    name, group, size: Math.round(s.size), hardness: s.hardness, spacing: s.spacing, roundness: s.roundness, angle: s.angle,
    flipX: s.flipX, flipY: s.flipY, flow: s.flow, tip: base?.tip || null, dyn: s.dyn ? JSON.parse(JSON.stringify(s.dyn)) : undefined,
  });
}

// ------------------------------------------------------------------ thumbnails
/** Data URL of a stroke preview for a preset. */
export function strokeThumb(p: BrushPresetEx, w = 150, hh = 36): string {
  const k = `${p.id}:${p.v || 0}:${w}x${hh}:${p.tip?.dataset.v || ''}`;
  let u = thumbCache.get(k);
  if (u) return u;
  const c = createCanvas(w, hh);
  renderStrokePreview(c, { size: p.size, hardness: p.hardness, spacing: p.spacing ?? 0.25, roundness: p.roundness ?? 1, angle: p.angle ?? 0, tipId: p.id, flipX: p.flipX, flipY: p.flipY, dyn: p.dyn as Dynamics, flow: p.flow, pressureSize: false }, { r: 225, g: 225, b: 225 }, { maxSize: hh * 0.62 });
  u = c.toDataURL();
  thumbCache.set(k, u);
  return u;
}
/** Data URL of the tip shape (white on transparent). */
export function tipThumb(p: BrushPresetEx, size = 44): string {
  const k = `tip:${p.id}:${p.v || 0}:${size}:${p.tip?.dataset.v || ''}`;
  let u = thumbCache.get(k);
  if (u) return u;
  const c = createCanvas(size, size), x = ctx2d(c);
  const pad = 4, avail = size - pad * 2;
  if (p.tip) {
    const s = Math.min(avail / p.tip.width, avail / p.tip.height);
    const w = p.tip.width * s, hh = p.tip.height * s;
    x.imageSmoothingQuality = 'high';
    x.drawImage(p.tip, (size - w) / 2, (size - hh) / 2, w, hh);
  } else {
    const r = Math.max(2, Math.min(avail / 2, 3 + p.size / 6));
    const g = x.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, r);
    g.addColorStop(0, '#000'); g.addColorStop(Math.max(0, Math.min(0.99, p.hardness)), '#000'); g.addColorStop(1, 'rgba(0,0,0,0)');
    x.fillStyle = g; x.beginPath(); x.arc(size / 2, size / 2, r, 0, 7); x.fill();
  }
  x.globalCompositeOperation = 'source-in'; x.fillStyle = '#e6e6e6'; x.fillRect(0, 0, size, size);
  u = c.toDataURL();
  thumbCache.set(k, u);
  return u;
}

// ------------------------------------------------------------------ tips from images
/** Grayscale → alpha tip (black = paint). Images with transparency use their alpha × darkness. Trimmed & capped at 2500 px. */
export function tipFromImage(src: CanvasImageSource, w: number, hh: number, selMask?: HTMLCanvasElement | null, mx = 0, my = 0): HTMLCanvasElement | null {
  const scale = Math.min(1, 2500 / Math.max(w, hh));
  const W = Math.max(1, Math.round(w * scale)), H = Math.max(1, Math.round(hh * scale));
  const c = createCanvas(W, H), x = ctx2d(c);
  x.drawImage(src as any, 0, 0, W, H);
  if (selMask) { x.globalCompositeOperation = 'destination-in'; x.drawImage(selMask, -mx * scale, -my * scale, selMask.width * scale, selMask.height * scale); x.globalCompositeOperation = 'source-over'; }
  const img = x.getImageData(0, 0, W, H), d = img.data;
  let transparent = false;
  for (let i = 3; i < d.length; i += 4) if (d[i] < 250) { transparent = true; break; }
  let any = false;
  for (let i = 0; i < d.length; i += 4) {
    const lum = d[i] * 0.3 + d[i + 1] * 0.59 + d[i + 2] * 0.11;
    const a = transparent && !selMask ? (d[i + 3] * (255 - lum * 0.85)) / 255 : ((255 - lum) * d[i + 3]) / 255;
    d[i] = d[i + 1] = d[i + 2] = 0; d[i + 3] = a;
    if (a > 2) any = true;
  }
  if (!any) return null;
  x.putImageData(img, 0, 0);
  const b = alphaBounds(c, 2);
  return b ? cropCanvas(c, b) : null;
}

/** Name dialog with a tip preview. */
async function nameDialog(title: string, t: HTMLCanvasElement, def: string): Promise<string | null> {
  const prev = createCanvas(96, 96), px = ctx2d(prev);
  px.fillStyle = '#fff'; px.fillRect(0, 0, 96, 96);
  const s = Math.min(88 / t.width, 88 / t.height, 1);
  px.drawImage(t, (96 - t.width * s) / 2, (96 - t.height * s) / 2, t.width * s, t.height * s);
  prev.className = 'bs-define-thumb';
  const inp = h('input.field', { type: 'text', value: def, style: { width: '240px' } }) as HTMLInputElement;
  inp.addEventListener('keydown', e => e.stopPropagation());
  const body = h('div.bs-define', null, h('div.bs-define-prev', null, prev, h('span', null, String(Math.max(t.width, t.height)))), h('div.form-row', null, h('label.form-label', null, 'Name:'), inp));
  const d = openDialog({ title, body, buttons: [{ label: 'OK', primary: true, value: 'ok' }, { label: 'Cancel', value: null }] });
  setTimeout(() => inp.select());
  return d.result.then(v => (v === 'ok' ? inp.value.trim() || def : null));
}

/** Edit › Define Brush Preset…: the selection (or whole visible image) → grayscale tip. */
async function defineBrush() {
  const doc = app.activeDoc;
  if (!doc) return;
  const b = doc.selection.empty ? { x: 0, y: 0, w: doc.width, h: doc.height } : doc.selection.bounds!;
  const src = cropCanvas(doc.getComposite(), b);
  const t = tipFromImage(src, b.w, b.h, doc.selection.empty ? null : cropCanvas(doc.selection.mask!, b));
  if (!t) { toast('Could not define brush because the selected area is empty.', 'error'); return; }
  const name = await nameDialog('Brush Name', t, doc.selection.empty ? doc.name.replace(/\.[^.]+$/, '') : 'Sampled Brush ' + (allPresets().filter(p => p.custom).length + 1));
  if (!name) return;
  const p = addPreset({ name, size: Math.max(t.width, t.height), hardness: 1, spacing: 0.25, tip: t, group: CUSTOM });
  const tool = app.activeTool?.settings && 'size' in app.activeTool.settings ? app.activeTool : app.getTool('brush');
  if (tool?.settings) { applyPreset(tool.settings, p); app.saveToolSettings(tool); }
  toast(`Brush preset "${name}" defined`, 'success');
}

/** Import PNG/JPEG files as brush tips. */
export function importBrushImages() {
  const inp = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp,image/gif', multiple: true }) as HTMLInputElement;
  inp.onchange = async () => {
    let n = 0;
    for (const f of Array.from(inp.files || [])) {
      try {
        const bmp = await createImageBitmap(f);
        const t = tipFromImage(bmp, bmp.width, bmp.height);
        bmp.close();
        if (!t) { toast(`"${f.name}" is empty and was skipped.`, 'error'); continue; }
        addPreset({ name: f.name.replace(/\.[^.]+$/, ''), size: Math.max(t.width, t.height), hardness: 1, spacing: 0.25, tip: t, group: 'Imported Brushes' });
        n++;
      } catch { toast(`Could not read "${f.name}".`, 'error'); }
    }
    if (n) toast(`${n} brush${n > 1 ? 'es' : ''} imported`, 'success');
  };
  inp.click();
}

registerCommand({ id: 'edit.defineBrush', run: defineBrush, enabled: () => !!app.activeDoc });

// ------------------------------------------------------------------ options-bar picker integration
brushPickerExt.groups = () => brushGroups();
brushPickerExt.thumb = (p: BrushPresetEx) => strokeThumb(p, 150, 32);
brushPickerExt.tipThumb = (p: BrushPresetEx) => tipThumb(p, 40);
brushPickerExt.apply = (s: any, p: BrushPresetEx) => applyPreset(s, p);
brushPickerExt.newPreset = (s: any, name: string) => presetFromSettings(s, name);
