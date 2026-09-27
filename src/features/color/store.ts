// Preset store for the colour area: gradient folders, pattern folders, swatches, persistence + change listeners.
// resources.* (core/registry) stays the single source of truth; items carry an extra `group` (folder) property.
import { resources } from '../../core/registry';
import { FG_TO_BG, FG_TO_TRANSPARENT } from '../../core/presets';
import type { Gradient, Pattern, RGB } from '../../core/types';
import { createCanvas, ctx2d, loadImage } from '../../core/canvas';
import { fromHex, hsvToRgb } from '../../core/color';
import { toast } from '../../ui/toast';
import { generatePatterns } from './pattern-gen';

export interface NoiseParams { roughness: number; model: 'rgb' | 'hsb' | 'lab'; min: [number, number, number]; max: [number, number, number]; restrict: boolean; transparency: boolean; seed: number }
export type GradientEx = Gradient & { group?: string; type?: 'solid' | 'noise'; noise?: NoiseParams };
export type PatternEx = Pattern & { group?: string };
export type Swatch = { name: string; color: RGB; group?: string };

// ------------------------------------------------------------------ change listeners
type Kind = 'gradients' | 'patterns' | 'swatches';
const listeners: Record<Kind, Set<() => void>> = { gradients: new Set(), patterns: new Set(), swatches: new Set() };
export function onPresets(kind: Kind, fn: () => void): () => void { listeners[kind].add(fn); return () => listeners[kind].delete(fn); }
export function notifyPresets(kind: Kind) { for (const f of [...listeners[kind]]) { try { f(); } catch (e) { console.error(e); } } }

function load<T>(key: string, fb: T): T { try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fb; } catch { return fb; } }
function save(key: string, v: any): boolean {
  try { localStorage.setItem(key, JSON.stringify(v)); return true; }
  catch { toast('Presets could not be saved for future sessions (browser storage is full).', 'error'); return false; }
}

// ------------------------------------------------------------------ gradients
const H = (hex: string): RGB => fromHex(hex)!;
const grad = (name: string, group: string, hexes: string[], pos?: number[]): GradientEx => ({
  name, group, smoothness: 1, type: 'solid',
  stops: hexes.map((c, i) => ({ pos: pos ? pos[i] : i / (hexes.length - 1), color: H(c) })),
  opacityStops: [{ pos: 0, opacity: 1 }, { pos: 1, opacity: 1 }],
});
const FAMILIES: [string, string, string[][]][] = [
  ['Blues', 'Blue', [['#0a1f5c', '#3a8dde'], ['#00c6ff', '#0072ff'], ['#1e3c72', '#2a5298', '#6f9be0'], ['#a1c4fd', '#c2e9fb'], ['#2193b0', '#6dd5ed'], ['#000428', '#004e92'], ['#4facfe', '#00f2fe'], ['#0f2027', '#203a43', '#2c5364']]],
  ['Purples', 'Purple', [['#41295a', '#2f0743'], ['#8e2de2', '#4a00e0'], ['#c471f5', '#fa71cd'], ['#654ea3', '#eaafc8'], ['#360033', '#0b8793'], ['#7f00ff', '#e100ff'], ['#b993d6', '#8ca6db'], ['#3c1053', '#ad5389']]],
  ['Pinks', 'Pink', [['#ff9a9e', '#fecfef'], ['#ee9ca7', '#ffdde1'], ['#f857a6', '#ff5858'], ['#ff6a88', '#ff99ac'], ['#fbc2eb', '#a6c1ee'], ['#ec008c', '#fc6767'], ['#f78ca0', '#f9748f', '#fe9a8b'], ['#ffafbd', '#ffc3a0']]],
  ['Reds', 'Red', [['#cb2d3e', '#ef473a'], ['#8e0e00', '#1f1c18'], ['#ff416c', '#ff4b2b'], ['#ed213a', '#93291e'], ['#eb3349', '#f45c43'], ['#6d0019', '#e52d27'], ['#b20a2c', '#fffbd5'], ['#c31432', '#240b36']]],
  ['Oranges', 'Orange', [['#f12711', '#f5af19'], ['#ff8008', '#ffc837'], ['#fc4a1a', '#f7b733'], ['#ee0979', '#ff6a00'], ['#e65c00', '#f9d423'], ['#ff9966', '#ff5e62'], ['#f83600', '#f9d423'], ['#d38312', '#a83279']]],
  ['Yellows', 'Yellow', [['#f7971e', '#ffd200'], ['#ffe259', '#ffa751'], ['#fceabb', '#f8b500'], ['#ede574', '#e1f5c4'], ['#fffc00', '#ffffff'], ['#f5e050', '#b29a0f'], ['#fdfc47', '#c9d600'], ['#fff1a8', '#ffcc33', '#e0a100']]],
  ['Greens', 'Green', [['#56ab2f', '#a8e063'], ['#11998e', '#38ef7d'], ['#134e5e', '#71b280'], ['#0ba360', '#3cba92'], ['#00b09b', '#96c93d'], ['#1d976c', '#93f9b9'], ['#0f9b0f', '#000000'], ['#d4fc79', '#96e6a1']]],
  ['Grays', 'Gray', [['#000000', '#434343'], ['#bdc3c7', '#2c3e50'], ['#232526', '#414345'], ['#e0e0e0', '#ffffff'], ['#606c88', '#3f4c6b'], ['#8e9eab', '#eef2f3'], ['#3a3a3a', '#9a9a9a', '#3a3a3a'], ['#757f9a', '#d7dde8']]],
];

function initGradients() {
  const basics = new Set([FG_TO_BG, FG_TO_TRANSPARENT, 'Black, White']);
  for (const g of resources.gradients as GradientEx[]) if (!g.group) g.group = basics.has(g.name) ? 'Basics' : 'Legacy Gradients';
  // Basics first (in PS order), then colour families, then legacy.
  const list = resources.gradients as GradientEx[];
  const fam: GradientEx[] = [];
  for (const [folder, prefix, sets] of FAMILIES) sets.forEach((hx, i) => fam.push(grad(`${prefix}_${String(i + 1).padStart(2, '0')}`, folder, hx)));
  const b = list.filter(g => g.group === 'Basics'), rest = list.filter(g => g.group !== 'Basics');
  list.length = 0;
  list.push(...b, ...fam, ...rest);
  defaultGradientNames = new Set(list.map(g => g.name));
}
let defaultGradientNames = new Set<string>();

interface GradState { added: GradientEx[]; hidden: string[]; renamed: Record<string, string>; folders: string[] }
let gradState: GradState = load('pixora.gradients.user', { added: [], hidden: [], renamed: {}, folders: [] });

/** Apply persisted user changes to resources.gradients (idempotent). */
export function applyUserGradients() {
  const list = resources.gradients as GradientEx[];
  const hidden = new Set(gradState.hidden);
  for (let i = list.length - 1; i >= 0; i--) if (hidden.has(list[i].name) && !gradState.added.includes(list[i])) list.splice(i, 1);
  for (const g of list) if (gradState.renamed[g.name] && !(g as any)._renamed) { (g as any)._orig = g.name; g.name = gradState.renamed[g.name]; (g as any)._renamed = true; }
  for (const g of gradState.added) if (!list.includes(g)) list.push(g);
}
function saveGradients() { save('pixora.gradients.user', { ...gradState, added: gradState.added.map(g => JSON.parse(JSON.stringify(g))) }); notifyPresets('gradients'); }

export function gradientFolders(): string[] {
  const out: string[] = [];
  for (const g of resources.gradients as GradientEx[]) { const f = g.group || 'Custom'; if (!out.includes(f)) out.push(f); }
  for (const f of gradState.folders) if (!out.includes(f)) out.push(f);
  return out;
}
export function addGradient(g: Gradient, group?: string): GradientEx {
  const copy: GradientEx = JSON.parse(JSON.stringify(g));
  copy.group = group || (g as GradientEx).group || 'Custom';
  if (copy.group === 'Basics' && (copy.name === FG_TO_BG || copy.name === FG_TO_TRANSPARENT)) copy.name += ' copy';
  gradState.added.push(copy);
  (resources.gradients as GradientEx[]).push(copy);
  saveGradients();
  return copy;
}
export function deleteGradient(g: GradientEx) {
  const list = resources.gradients as GradientEx[], i = list.indexOf(g);
  if (i >= 0) list.splice(i, 1);
  const j = gradState.added.indexOf(g);
  if (j >= 0) gradState.added.splice(j, 1);
  else gradState.hidden.push((g as any)._orig || g.name);
  saveGradients();
}
export function renameGradient(g: GradientEx, name: string) {
  if (gradState.added.includes(g)) g.name = name;
  else { gradState.renamed[(g as any)._orig || g.name] = name; (g as any)._orig ??= g.name; (g as any)._renamed = true; g.name = name; }
  saveGradients();
}
export function addGradientFolder(name: string) { if (!gradState.folders.includes(name)) gradState.folders.push(name); saveGradients(); }
export function deleteGradientFolder(name: string) {
  for (const g of (resources.gradients as GradientEx[]).filter(g => (g.group || 'Custom') === name)) deleteGradient(g);
  gradState.folders = gradState.folders.filter(f => f !== name);
  saveGradients();
}
export function resetGradients() {
  gradState = { added: [], hidden: [], renamed: {}, folders: [] };
  const list = resources.gradients as GradientEx[];
  for (const g of list) if ((g as any)._orig) { g.name = (g as any)._orig; delete (g as any)._orig; delete (g as any)._renamed; }
  for (let i = list.length - 1; i >= 0; i--) if (!defaultGradientNames.has(list[i].name)) list.splice(i, 1);
  for (const g of baseGradients) if (!list.includes(g)) list.push(g);
  saveGradients();
}
let baseGradients: GradientEx[] = [];

// ------------------------------------------------------------------ patterns
interface PatState { added: { id: string; name: string; group: string; url: string }[]; hidden: string[]; renamed: Record<string, string> }
let patState: PatState = load('pixora.patterns.user', { added: [], hidden: [], renamed: {} });
const userPatterns: PatternEx[] = [];

function initPatterns() {
  for (const p of resources.patterns as PatternEx[]) if (!p.group) p.group = 'Legacy Patterns';
  const gen = generatePatterns();
  const list = resources.patterns as PatternEx[];
  const legacy = list.splice(0, list.length);
  list.push(...gen, ...legacy);
  basePatterns = [...list];
  // restore user patterns (async image decode)
  for (const a of patState.added) {
    const c = createCanvas(1, 1);
    const p: PatternEx = { id: a.id, name: a.name, group: a.group, canvas: c };
    userPatterns.push(p);
    loadImage(a.url).then(img => { c.width = img.width; c.height = img.height; ctx2d(c).drawImage(img, 0, 0); notifyPresets('patterns'); }).catch(() => { /* corrupt entry */ });
  }
  applyUserPatterns();
}
let basePatterns: PatternEx[] = [];

export function applyUserPatterns() {
  const list = resources.patterns as PatternEx[];
  const hidden = new Set(patState.hidden);
  for (let i = list.length - 1; i >= 0; i--) if (hidden.has(list[i].id)) list.splice(i, 1);
  for (const p of list) if (patState.renamed[p.id]) p.name = patState.renamed[p.id];
  for (const p of userPatterns) if (!list.includes(p)) list.push(p);
}
function savePatterns() { save('pixora.patterns.user', patState); notifyPresets('patterns'); }
export function patternFolders(): string[] {
  const out: string[] = [];
  for (const p of resources.patterns as PatternEx[]) { const f = p.group || 'Custom'; if (!out.includes(f)) out.push(f); }
  return out;
}
export function addPattern(name: string, canvas: HTMLCanvasElement, group = 'Custom'): PatternEx {
  const p: PatternEx = { id: `user-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`, name, group, canvas };
  userPatterns.push(p);
  (resources.patterns as PatternEx[]).push(p);
  let url = canvas.toDataURL('image/png');
  if (url.length > 1_500_000) url = '';
  if (url) patState.added.push({ id: p.id, name, group, url });
  else toast('The pattern is too large to be kept for future sessions; it is available until you reload.', 'info', 4000);
  savePatterns();
  return p;
}
export function deletePattern(p: PatternEx) {
  const list = resources.patterns as PatternEx[], i = list.indexOf(p);
  if (i >= 0) list.splice(i, 1);
  const u = userPatterns.indexOf(p);
  if (u >= 0) { userPatterns.splice(u, 1); patState.added = patState.added.filter(a => a.id !== p.id); }
  else patState.hidden.push(p.id);
  savePatterns();
}
export function renamePattern(p: PatternEx, name: string) {
  p.name = name;
  const a = patState.added.find(a => a.id === p.id);
  if (a) a.name = name; else patState.renamed[p.id] = name;
  savePatterns();
}
export function resetPatterns() {
  patState = { added: [], hidden: [], renamed: {} };
  userPatterns.length = 0;
  const list = resources.patterns as PatternEx[];
  list.length = 0;
  list.push(...basePatterns);
  savePatterns();
}

// ------------------------------------------------------------------ swatches
let defaultSwatches: Swatch[] = [];
/** Photoshop's default swatch groups: RGB, CMYK, Grayscale, Pastel, Light, Pure, Dark, Darker. */
function psSwatches(): Swatch[] {
  const out: Swatch[] = [];
  const add = (group: string, name: string, color: RGB) => out.push({ name, color, group });
  const six = ['Red', 'Yellow', 'Green', 'Cyan', 'Blue', 'Magenta'];
  ['#ff0000', '#ffff00', '#00ff00', '#00ffff', '#0000ff', '#ff00ff'].forEach((c, i) => add('RGB', `RGB ${six[i]}`, H(c)));
  ['#ed1c24', '#fff200', '#00a651', '#00aeef', '#2e3192', '#ec008c'].forEach((c, i) => add('CMYK', `CMYK ${six[i]}`, H(c)));
  for (let k = 0; k <= 100; k += 5) { const v = Math.round(255 * (1 - k / 100)); add('Grayscale', k === 0 ? 'White' : k === 100 ? 'Black' : `${k}% Gray`, { r: v, g: v, b: v }); }
  const hues: [string, number][] = [['Red', 0], ['Red Orange', 20], ['Yellow Orange', 38], ['Yellow', 56], ['Pea Green', 80], ['Yellow Green', 100], ['Green', 125], ['Green Cyan', 155],
    ['Cyan', 190], ['Cyan Blue', 205], ['Blue', 225], ['Blue Violet', 250], ['Violet', 270], ['Violet Magenta', 290], ['Magenta', 315], ['Magenta Red', 340]];
  const levels: [string, number, number][] = [['Pastel', 38, 98], ['Light', 62, 96], ['Pure', 100, 100], ['Dark', 100, 62], ['Darker', 100, 38]];
  for (const [grp, s, v] of levels) for (const [n, hh] of hues) add(grp, `${grp} ${n}`, hsvToRgb({ h: hh, s, v }));
  return out;
}
function initSwatches() {
  resources.swatches.length = 0;
  resources.swatches.push(...psSwatches());
  defaultSwatches = JSON.parse(JSON.stringify(resources.swatches));
  const saved = load<Swatch[] | null>('pixora.swatches', null);
  if (saved && Array.isArray(saved)) { resources.swatches.length = 0; resources.swatches.push(...saved); }
  swatchFolders = load<string[]>('pixora.swatchFolders', []);
}
let swatchFolders: string[] = [];
export function saveSwatches() { save('pixora.swatches', resources.swatches); save('pixora.swatchFolders', swatchFolders); notifyPresets('swatches'); }
export function swatchGroups(): string[] {
  const out: string[] = [];
  for (const s of resources.swatches) { const g = s.group || 'Custom'; if (!out.includes(g)) out.push(g); }
  for (const f of swatchFolders) if (!out.includes(f)) out.push(f);
  return out;
}
export function addSwatch(color: RGB, name: string, group?: string) {
  resources.swatches.push({ name, color: { r: color.r, g: color.g, b: color.b }, group: group || lastSwatchGroup() });
  saveSwatches();
}
function lastSwatchGroup() { const g = swatchGroups(); return g[g.length - 1] || 'Custom'; }
export function addSwatchFolder(name: string) { if (!swatchFolders.includes(name)) swatchFolders.push(name); saveSwatches(); }
export function removeSwatchFolder(name: string) {
  for (let i = resources.swatches.length - 1; i >= 0; i--) if ((resources.swatches[i].group || 'Custom') === name) resources.swatches.splice(i, 1);
  swatchFolders = swatchFolders.filter(f => f !== name);
  saveSwatches();
}
export function resetSwatches() {
  resources.swatches.length = 0;
  resources.swatches.push(...JSON.parse(JSON.stringify(defaultSwatches)));
  swatchFolders = [];
  saveSwatches();
}
export function nextSwatchName(): string {
  let n = resources.swatches.length + 1;
  while (resources.swatches.some(s => s.name === `Color Swatch ${n}`)) n++;
  return `Color Swatch ${n}`;
}

// ------------------------------------------------------------------ boot
initGradients();
baseGradients = [...(resources.gradients as GradientEx[])];
applyUserGradients();
initPatterns();
initSwatches();
