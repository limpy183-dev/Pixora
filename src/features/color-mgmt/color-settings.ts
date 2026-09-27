// Edit › Color Settings (Shift+Ctrl+K), Assign Profile, Convert to Profile and Purge.
//  • Working spaces + colour management policies (applied when opening files with embedded profiles, with the
//    "Embedded Profile Mismatch" / "Missing Profile" questions), conversion options (intent, dither), desaturate
//    monitor colours.
//  • Documents carry a profile tag (doc.extra.profile); tagged non-sRGB documents are colour-managed on screen
//    (converted to the sRGB monitor space), exports are converted to sRGB.
//  • Assign Profile re-tags without changing pixel values; Convert to Profile converts the pixel values.
import './color-mgmt.css';
import { app } from '../../core/app';
import { events } from '../../core/events';
import { registerCommands, runCommand } from '../../core/commands';
import type { PixDocument } from '../../core/document';
import { createCanvas, ctx2d } from '../../core/canvas';
import { viewportHooks } from '../../core/viewport';
import type { RGB } from '../../core/types';
import { h } from '../../ui/dom';
import { openDialog, confirmDialog } from '../../ui/dialog';
import { checkbox, numberField, select } from '../../ui/widgets';
import { toast } from '../../ui/toast';
import { mapLayerColors } from '../image/modes';
import { docChanged, mapRasterPixels } from '../image/ops';
import { RasterLayer } from '../../core/layer';
import { purgeClipboard } from '../edit/clipboard';
import { whenReady } from '../prefs/store';
import { PROFILES, profileById, convertPixels, converter, buildLUT, embeddedProfile, type Intent, type Profile } from './profiles';

// ------------------------------------------------------------------ settings
type Policy = 'off' | 'preserve' | 'convert';
interface CS { preset: string; rgb: string; gray: string; policyRGB: Policy; policyGray: Policy; askOpen: boolean; askMissing: boolean; intent: Intent; dither: boolean; desat: boolean; desatAmount: number }
const PRESETS: Record<string, [string, Partial<CS>]> = {
  general: ['General Purpose (sRGB)', { rgb: 'srgb', gray: 'gray22', policyRGB: 'preserve', policyGray: 'preserve', askOpen: false, askMissing: false, intent: 'relative' }],
  web: ['Web / Internet', { rgb: 'srgb', gray: 'sgray', policyRGB: 'convert', policyGray: 'convert', askOpen: false, askMissing: false, intent: 'perceptual' }],
  wide: ['Prepress — Wide Gamut', { rgb: 'clay', gray: 'gray22', policyRGB: 'preserve', policyGray: 'preserve', askOpen: true, askMissing: true, intent: 'relative' }],
  photo: ['Photography — ROMM RGB', { rgb: 'romm', gray: 'gray18', policyRGB: 'preserve', policyGray: 'preserve', askOpen: true, askMissing: true, intent: 'perceptual' }],
  p3: ['Display P3 Screens', { rgb: 'p3', gray: 'sgray', policyRGB: 'preserve', policyGray: 'preserve', askOpen: true, askMissing: false, intent: 'relative' }],
  monitor: ['Monitor Color', { rgb: 'srgb', gray: 'sgray', policyRGB: 'off', policyGray: 'off', askOpen: false, askMissing: false, intent: 'relative' }],
};
const KEY = 'pixora.colorSettings';
export const cs: CS = (() => {
  const d: CS = { preset: 'general', rgb: 'srgb', gray: 'gray22', policyRGB: 'preserve', policyGray: 'preserve', askOpen: false, askMissing: false, intent: 'relative', dither: true, desat: false, desatAmount: 20 };
  try { return { ...d, ...JSON.parse(localStorage.getItem(KEY) || '{}') }; } catch { return d; }
})();
const saveCS = () => { try { localStorage.setItem(KEY, JSON.stringify(cs)); } catch { /* ignore */ } };
const working = (kind: 'rgb' | 'gray') => profileById(kind === 'rgb' ? cs.rgb : cs.gray)!;

/** The profile a document's numbers are in (null = not colour managed). Untagged documents use the working space. */
export function docProfile(doc: PixDocument): Profile | null {
  const tag = (doc.extra || {}).profile as string | undefined;
  if (tag === 'none') return null;
  const kind = doc.mode === 'Grayscale' ? 'gray' : 'rgb';
  const p = profileById(tag);
  return p && p.kind === kind ? p : working(kind);
}
const SRGB = profileById('srgb')!;
const isMonitor = (p: Profile | null) => !p || p.id === 'srgb' || p.id === 'sgray';

// ------------------------------------------------------------------ display colour management
interface Disp { canvas: HTMLCanvasElement | null; key: string; dirty: boolean; timer: number }
const disp = new WeakMap<PixDocument, Disp>();
let preview: { doc: PixDocument; canvas: HTMLCanvasElement } | null = null;
const override = new WeakMap<PixDocument, string>();           // Assign Profile preview
function displayProfile(doc: PixDocument) { const o = override.get(doc); if (o) return o === 'none' ? null : profileById(o); return docProfile(doc); }
const lutCache = new Map<string, (d: Uint8ClampedArray) => void>();
function lutFor(p: Profile) { const k = `${p.id}>srgb`; let f = lutCache.get(k); if (!f) { f = buildLUT(p, SRGB, 'relative'); lutCache.set(k, f); } return f; }
/** Convert a doc-space canvas to the sRGB monitor space (new canvas). */
export function toMonitor(c: HTMLCanvasElement, p: Profile | null): HTMLCanvasElement {
  const out = createCanvas(c.width, c.height), x = out.getContext('2d', { willReadFrequently: true })!;
  x.drawImage(c, 0, 0);
  if (isMonitor(p)) return out;
  const img = x.getImageData(0, 0, c.width, c.height);
  lutFor(p!)(img.data);
  x.putImageData(img, 0, 0);
  return out;
}
function recompute(doc: PixDocument) {
  const e = disp.get(doc);
  if (!e) return;
  const p = displayProfile(doc);
  if (isMonitor(p)) { e.canvas = null; e.dirty = false; app.viewport?.requestRender(); return; }
  e.canvas = toMonitor(doc.getComposite(), p);
  e.key = p!.id; e.dirty = false;
  app.viewport?.requestRender();
}
function schedule(doc: PixDocument | null | undefined, delay = 160) {
  if (!doc) return;
  let e = disp.get(doc);
  if (!e) { e = { canvas: null, key: '', dirty: true, timer: 0 }; disp.set(doc, e); }
  e.dirty = true;
  clearTimeout(e.timer);
  e.timer = window.setTimeout(() => recompute(doc), delay);
}
viewportHooks.afterComposite.push((ctx, view, doc) => {
  const c = preview && preview.doc === doc ? preview.canvas : (() => { const e = disp.get(doc); if (!e) { schedule(doc, 0); return null; } return !e.dirty && !isMonitor(displayProfile(doc)) ? e.canvas : null; })();
  if (!c) return;
  view.applyDocTransform(ctx);
  ctx.imageSmoothingEnabled = view.zoom < 1;
  ctx.drawImage(c, 0, 0);
});
events.on('pixels', (e: any) => schedule(e?.doc));
events.on('layers', (d: any) => schedule(d || app.activeDoc));
events.on('history', (d: PixDocument) => schedule(d));
events.on('activeDoc', (d: any) => schedule(d));
function applyDesaturate() { const c = app.viewport?.canvas; if (c) c.style.filter = cs.desat ? `saturate(${Math.max(0, 1 - cs.desatAmount / 100)})` : ''; }

// ------------------------------------------------------------------ opening files (policies)
export interface OpenPolicy { raw: boolean; profile: string | null; convertTo?: string }
/** Decide how an image with (or without) an embedded profile is opened. Called by File › Open before decoding. */
export async function openPolicy(blob: Blob, name: string): Promise<OpenPolicy> {
  const det = await embeddedProfile(blob);
  const W = working('rgb');
  if (!det) {
    if (!cs.askMissing) return { raw: false, profile: null };
    const choice = await ask('Missing Profile', `The document “${name}” does not have an embedded RGB profile.`, [['none', 'Leave as is (don’t color manage)'], ['working', `Assign working RGB: ${W.name}`], ['srgb', `Assign profile: ${SRGB.name}`]], 'working');
    return { raw: false, profile: choice === 'working' ? W.id : choice };
  }
  const p = profileById(det.id);
  if (!p || p.kind !== 'rgb') return { raw: false, profile: 'srgb' };        // unknown profile: the browser converted to sRGB
  if (p.id === W.id) return { raw: true, profile: p.id };
  let pol: Policy = cs.policyRGB;
  if (cs.askOpen) {
    const choice = await ask('Embedded Profile Mismatch', `The document “${name}” has an embedded color profile that does not match the current RGB working space.\nEmbedded: ${det.desc}\nWorking: ${W.name}`,
      [['preserve', 'Use the embedded profile (instead of the working space)'], ['convert', 'Convert document’s colors to the working space'], ['off', 'Discard the embedded profile (don’t color manage)']], pol);
    pol = choice as Policy;
  }
  if (pol === 'preserve') return { raw: true, profile: p.id };
  if (pol === 'off') return { raw: true, profile: 'none' };
  return { raw: false, profile: W.id, convertTo: W.id === 'srgb' ? undefined : W.id };
}
async function ask(title: string, msg: string, opts: [string, string][], def: string): Promise<string> {
  let v = def;
  const name = 'cm' + Math.random().toString(36).slice(2);
  const body = h('div.cm-ask', null, ...msg.split('\n').map(l => h('div', null, l)),
    h('div.cm-radios', null, ...opts.map(([k, label]) => h('label.cm-radio', null, h('input', { type: 'radio', name, checked: k === def, onchange: () => { v = k; } }), h('span', null, label)))));
  const r = await openDialog({ title, body, width: 520, cancelValue: 'cancel', buttons: [{ label: 'OK', primary: true, value: 'ok' }, { label: 'Cancel', value: 'cancel' }] }).result;
  if (r !== 'ok') return def;
  return v;
}
/** Decode an image without the browser's colour conversion (raw numbers). */
export async function decodeRaw(blob: Blob): Promise<HTMLCanvasElement> {
  const bmp = await createImageBitmap(blob, { colorSpaceConversion: 'none' } as any);
  const c = createCanvas(bmp.width, bmp.height);
  ctx2d(c).drawImage(bmp, 0, 0);
  bmp.close();
  return c;
}
/** Convert a canvas from one profile to another (in place semantics: returns the same canvas). */
export function convertCanvas(c: HTMLCanvasElement, from: string, to: string, intent: Intent = cs.intent) {
  const a = profileById(from), b = profileById(to);
  if (!a || !b || a.id === b.id) return c;
  const x = c.getContext('2d', { willReadFrequently: true })!, img = x.getImageData(0, 0, c.width, c.height);
  convertPixels(img.data, a, b, intent, cs.dither);
  x.putImageData(img, 0, 0);
  return c;
}
/** Canvas ready for export: converted to sRGB when the document uses another profile. */
export function exportCanvas(doc: PixDocument, c: HTMLCanvasElement): HTMLCanvasElement {
  const p = docProfile(doc);
  return isMonitor(p) || doc.mode === 'Grayscale' ? c : toMonitor(c, p);
}
// untagged new documents get the working space tag
function tagDocs() { for (const d of app.docs) if (d.extra && d.extra.profile === undefined) d.extra.profile = working(d.mode === 'Grayscale' ? 'gray' : 'rgb').id; }
events.on('docs', tagDocs);

// ------------------------------------------------------------------ Color Settings dialog
async function colorSettings() {
  const W: CS = { ...cs };
  const profSel = (kind: 'rgb' | 'gray', v: string, set: (v: string) => void) => select<string>(PROFILES.filter(p => p.kind === kind).map(p => ({ value: p.id, label: p.name })), v, x => { set(x); W.preset = 'custom'; presetSel.setValue('custom'); desc(); }, { width: 300, title: `${kind === 'rgb' ? 'RGB' : 'Gray'} working space` });
  const polSel = (v: Policy, set: (v: Policy) => void) => select<Policy>([{ value: 'off', label: 'Off' }, { value: 'preserve', label: 'Preserve Embedded Profiles' }, { value: 'convert', label: 'Convert to Working Space' }], v, x => { set(x); W.preset = 'custom'; presetSel.setValue('custom'); }, { width: 220, title: 'Color management policy' });
  const info = h('div.cm-desc');
  const desc = () => { const p = profileById(W.rgb)!; info.textContent = `RGB working space: ${p.name}. ${p.id === 'srgb' ? 'Matches typical monitors and the web; the safest choice for screen work.' : p.id === 'p3' ? 'The gamut of modern phone and laptop displays; documents are converted to sRGB for display on this monitor and on export.' : p.id === 'romm' ? 'Very wide gamut for high-bit photographic editing; many of its colours cannot be displayed.' : 'Wider than sRGB; useful for print work. Documents are colour-managed on screen and converted to sRGB on export.'}`; };
  const presetSel = select<string>([...Object.entries(PRESETS).map(([k, [label]]) => ({ value: k, label })), { value: 'custom', label: 'Custom' }], W.preset, v => {
    if (v !== 'custom') { Object.assign(W, PRESETS[v][1]); W.preset = v; rebuild(); }
  }, { width: 300, title: 'Color settings preset' });
  const form = h('div.cm-form');
  const row = (label: string, ...ctl: Node[]) => h('div.form-row', null, h('label.form-label.cm-label', null, label), ...ctl);
  const group = (title: string, ...kids: Node[]) => h('fieldset.pf-group', null, h('legend', null, title), ...kids);
  const rebuild = () => {
    presetSel.setValue(W.preset);
    form.replaceChildren(
      row('Settings:', presetSel),
      group('Working Spaces', row('RGB:', profSel('rgb', W.rgb, v => { W.rgb = v; })), row('Gray:', profSel('gray', W.gray, v => { W.gray = v; }))),
      group('Color Management Policies',
        row('RGB:', polSel(W.policyRGB, v => { W.policyRGB = v; })), row('Gray:', polSel(W.policyGray, v => { W.policyGray = v; })),
        row('Profile Mismatches:', checkbox('Ask When Opening', W.askOpen, v => { W.askOpen = v; W.preset = 'custom'; presetSel.setValue('custom'); }, { title: 'Ask what to do when an opened file has a different profile' })),
        row('Missing Profiles:', checkbox('Ask When Opening', W.askMissing, v => { W.askMissing = v; W.preset = 'custom'; presetSel.setValue('custom'); }, { title: 'Ask what to do when an opened file has no profile' }))),
      group('Conversion Options',
        row('Engine:', h('span.cm-static', { title: 'Matrix/TRC profiles with Bradford chromatic adaptation' }, 'Pixora Color Engine')),
        row('Intent:', select<Intent>([{ value: 'perceptual', label: 'Perceptual' }, { value: 'relative', label: 'Relative Colorimetric' }, { value: 'saturation', label: 'Saturation' }, { value: 'absolute', label: 'Absolute Colorimetric' }], W.intent, v => { W.intent = v; W.preset = 'custom'; presetSel.setValue('custom'); }, { width: 200, title: 'Rendering intent for conversions' })),
        row('', checkbox('Use Dither (8-bit/channel images)', W.dither, v => { W.dither = v; }, { title: 'Add fine noise when converting to avoid banding' }))),
      group('Advanced Controls',
        row('', checkbox('Desaturate Monitor Colors By:', W.desat, v => { W.desat = v; }, { title: 'Show colours less saturated on screen (to judge wide-gamut images)' }), numberField(W.desatAmount, v => { W.desatAmount = v; }, { min: 0, max: 100, unit: '%', width: 60, title: 'Desaturation amount' }))),
      group('Description', info));
    desc();
  };
  rebuild();
  const r = await openDialog({ title: 'Color Settings', body: form, width: 800, layout: 'side', className: 'cm-dialog', buttons: [{ label: 'OK', primary: true, value: 'ok' }, { label: 'Cancel', value: null }] }).result;
  if (r !== 'ok') return;
  Object.assign(cs, W); saveCS(); applyDesaturate();
  for (const d of app.docs) schedule(d, 0);
}

// ------------------------------------------------------------------ Assign Profile
async function assignProfile() {
  const doc = app.activeDoc;
  if (!doc) return;
  const kind = doc.mode === 'Grayscale' ? 'gray' : 'rgb', Wp = working(kind);
  const cur = (doc.extra?.profile as string) || Wp.id;
  let mode: 'none' | 'working' | 'profile' = cur === 'none' ? 'none' : cur === Wp.id ? 'working' : 'profile';
  let pick = cur !== 'none' && profileById(cur)?.kind === kind ? cur : kind === 'rgb' ? 'p3' : 'sgray';
  let pv = true;
  const value = () => (mode === 'none' ? 'none' : mode === 'working' ? Wp.id : pick);
  const refresh = () => { if (pv) override.set(doc, value()); else override.delete(doc); schedule(doc, 0); };
  const name = 'ap' + Date.now();
  const radio = (m: typeof mode, label: string, extra?: Node) => h('div.cm-radio', null, h('label', null, h('input', { type: 'radio', name, checked: mode === m, onchange: () => { mode = m; refresh(); } }), h('span', null, label)), extra || null);
  const body = h('div.cm-ask', null,
    h('div.cm-sub', null, 'Assign Profile:'),
    radio('none', 'Don’t Color Manage This Document'),
    radio('working', `Working ${kind === 'rgb' ? 'RGB' : 'Gray'}: ${Wp.name}`),
    radio('profile', 'Profile:', select<string>(PROFILES.filter(p => p.kind === kind).map(p => ({ value: p.id, label: p.name })), pick, v => { pick = v; mode = 'profile'; (body.querySelectorAll('input[type=radio]')[2] as HTMLInputElement).checked = true; refresh(); }, { width: 280, title: 'Profile to assign' })),
    h('div.cm-note', null, 'Assigning a profile changes how the pixel values are interpreted (their appearance), not the values themselves.'));
  refresh();
  const r = await openDialog({ title: 'Assign Profile', body, width: 520, layout: 'side', preview: { checked: true, onChange: v => { pv = v; refresh(); } }, buttons: [{ label: 'OK', primary: true, value: 'ok' }, { label: 'Cancel', value: null }] }).result;
  override.delete(doc);
  if (r === 'ok' && value() !== cur) {
    doc.history.transaction('Assign Profile', () => { doc.extra.profile = value(); }, 'image');
    doc.layersChanged();
  }
  schedule(doc, 0);
}

// ------------------------------------------------------------------ Convert to Profile
async function convertToProfile() {
  const doc = app.activeDoc;
  if (!doc) return;
  if (!['RGB', 'Grayscale'].includes(doc.mode)) { toast(`Convert to Profile works on RGB and Grayscale documents (this document is ${doc.mode}).`, 'error', 4000); return; }
  const src = docProfile(doc) || SRGB;
  let dst = src.kind === 'rgb' ? (src.id === 'srgb' ? 'p3' : 'srgb') : 'srgb';
  let intent: Intent = cs.intent, dither = cs.dither, flatten = false, pv = true;
  const run = () => {
    if (!pv) { preview = null; app.viewport?.requestRender(); return; }
    const d = profileById(dst)!, comp = doc.getComposite();
    const c = createCanvas(comp.width, comp.height), x = c.getContext('2d', { willReadFrequently: true })!;
    x.drawImage(comp, 0, 0);
    const img = x.getImageData(0, 0, c.width, c.height);
    buildLUT(src, d, intent)(img.data);
    x.putImageData(img, 0, 0);
    preview = { doc, canvas: toMonitor(c, d) };
    app.viewport?.requestRender();
  };
  let timer = 0;
  const later = () => { clearTimeout(timer); timer = window.setTimeout(run, 60); };
  const body = h('div.cm-ask', null,
    h('fieldset.pf-group', null, h('legend', null, 'Source Space'), h('div', null, `Profile: ${doc.extra?.profile === 'none' ? 'Untagged — ' : ''}${src.name}`)),
    h('fieldset.pf-group', null, h('legend', null, 'Destination Space'), h('div.form-row', null, h('label.form-label', null, 'Profile:'),
      select<string>(PROFILES.map(p => ({ value: p.id, label: `${p.name}${p.kind === 'gray' ? ' (Grayscale)' : ''}` })), dst, v => { dst = v; later(); }, { width: 300, title: 'Destination profile' }))),
    h('fieldset.pf-group', null, h('legend', null, 'Conversion Options'),
      h('div.form-row', null, h('label.form-label', null, 'Engine:'), h('span.cm-static', null, 'Pixora Color Engine')),
      h('div.form-row', null, h('label.form-label', null, 'Intent:'), select<Intent>([{ value: 'perceptual', label: 'Perceptual' }, { value: 'relative', label: 'Relative Colorimetric' }, { value: 'saturation', label: 'Saturation' }, { value: 'absolute', label: 'Absolute Colorimetric' }], intent, v => { intent = v; later(); }, { width: 200, title: 'Rendering intent' })),
      h('div.form-row', null, checkbox('Use Dither', dither, v => { dither = v; }, { title: 'Add fine noise to avoid banding' })),
      h('div.form-row', null, checkbox('Flatten Image to Preserve Appearance', flatten, v => { flatten = v; }, { title: 'Flatten first so blend modes look the same after the conversion' }))));
  run();
  const r = await openDialog({ title: 'Convert to Profile', body, width: 560, layout: 'side', preview: { checked: true, onChange: v => { pv = v; run(); } }, buttons: [{ label: 'OK', primary: true, value: 'ok' }, { label: 'Cancel', value: null }] }).result;
  clearTimeout(timer);
  preview = null;
  if (r !== 'ok') { app.viewport?.requestRender(); return; }
  const d = profileById(dst)!;
  if (d.id === src.id) { app.viewport?.requestRender(); return; }
  if (flatten && (doc.layers.length > 1 || !(doc.layers[0] instanceof RasterLayer))) await runCommand('layer.flatten');
  const f = converter(src, d, intent), o = [0, 0, 0];
  const colorFn = (c: RGB): RGB => { f(c.r / 255, c.g / 255, c.b / 255, o); return { r: Math.round(o[0] * 255), g: Math.round(o[1] * 255), b: Math.round(o[2] * 255) }; };
  doc.history.transaction('Convert to Profile', () => {
    mapRasterPixels(doc, px => convertPixels(px, src, d, intent, dither));
    for (const l of doc.allLayers()) if (!(l instanceof RasterLayer)) mapLayerColors(l, colorFn);
    doc.mode = d.kind === 'gray' ? 'Grayscale' : 'RGB';
    doc.extra.profile = d.id;
  }, 'image');
  docChanged(doc);
  schedule(doc, 0);
}

// ------------------------------------------------------------------ Purge
async function purge(what: 'clipboard' | 'histories' | 'all') {
  if ((await confirmDialog('Purge', 'This operation cannot be undone. Continue?')) !== 'ok') return;
  if (what !== 'histories') purgeClipboard();
  if (what !== 'clipboard') for (const d of app.docs) d.history.clear();
  if (what === 'all') { lutCache.clear(); for (const d of app.docs) { const e = disp.get(d); if (e) e.canvas = null; schedule(d, 0); } }
  toast(what === 'clipboard' ? 'Clipboard purged.' : what === 'histories' ? 'Histories purged.' : 'Clipboard, histories and caches purged.', 'success');
}

whenReady(() => { applyDesaturate(); tagDocs(); });
registerCommands([
  { id: 'edit.colorSettings', label: 'Color Settings...', shortcut: 'Shift+Ctrl+K', run: colorSettings },
  { id: 'edit.assignProfile', label: 'Assign Profile...', enabled: () => !!app.activeDoc, run: assignProfile },
  { id: 'edit.convertProfile', label: 'Convert to Profile...', enabled: () => !!app.activeDoc, run: convertToProfile },
  { id: 'edit.purge', label: 'Purge', run: (a?: 'clipboard' | 'histories' | 'all') => purge(a || 'all') },
]);
(window as any).__pxColor = { cs, docProfile, openPolicy, convertCanvas, exportCanvas, PROFILES };
