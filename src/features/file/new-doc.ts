// File > New... (Ctrl+N): the New Document dialog — preset categories (Recent, Saved, Photo, Print, Art &
// Illustration, Web, Mobile, Film & Video) with a preset grid, and Preset Details (name, width / height with units,
// orientation, resolution, colour mode + bit depth, background contents). Saved presets persist; the clipboard
// image size is offered as a preset.
import { app } from '../../core/app';
import { PixDocument } from '../../core/document';
import type { ColorMode, RGB } from '../../core/types';
import { fromPx, toPx, type Unit } from '../../core/units';
import { hooks } from '../../core/registry';
import { clear, h } from '../../ui/dom';
import { openDialog } from '../../ui/dialog';
import { colorSwatch, numberField, select, type SelectOption } from '../../ui/widgets';
import { icon } from '../../ui/icons';
import { promptDialog } from '../../ui/dialog';

type Bg = 'white' | 'black' | 'background' | 'transparent' | 'custom';
interface Preset { name: string; w: number; h: number; unit: Unit; res: number; resUnit: 'ppi' | 'ppcm'; mode?: ColorMode; bits?: 8 | 16 | 32; bg?: Bg; custom?: RGB; cat?: string }

const px = (name: string, w: number, h: number, res = 72): Preset => ({ name, w, h, unit: 'px', res, resUnit: 'ppi' });
const CATS: Record<string, Preset[]> = {
  Photo: [
    { name: 'Landscape, 6 x 4', w: 6, h: 4, unit: 'in', res: 300, resUnit: 'ppi' }, { name: 'Portrait, 4 x 6', w: 4, h: 6, unit: 'in', res: 300, resUnit: 'ppi' },
    { name: 'Landscape, 7 x 5', w: 7, h: 5, unit: 'in', res: 300, resUnit: 'ppi' }, { name: 'Landscape, 10 x 8', w: 10, h: 8, unit: 'in', res: 300, resUnit: 'ppi' },
    { name: 'Square, 5 x 5', w: 5, h: 5, unit: 'in', res: 300, resUnit: 'ppi' }, { name: 'Default Pixora Size', w: 16, h: 12, unit: 'cm', res: 118.11, resUnit: 'ppcm' },
  ],
  Print: [
    { name: 'Letter', w: 8.5, h: 11, unit: 'in', res: 300, resUnit: 'ppi' }, { name: 'Legal', w: 8.5, h: 14, unit: 'in', res: 300, resUnit: 'ppi' },
    { name: 'Tabloid', w: 11, h: 17, unit: 'in', res: 300, resUnit: 'ppi' }, { name: 'A3', w: 297, h: 420, unit: 'mm', res: 300, resUnit: 'ppi' },
    { name: 'A4', w: 210, h: 297, unit: 'mm', res: 300, resUnit: 'ppi' }, { name: 'A5', w: 148, h: 210, unit: 'mm', res: 300, resUnit: 'ppi' },
    { name: 'B5', w: 176, h: 250, unit: 'mm', res: 300, resUnit: 'ppi' },
  ],
  'Art & Illustration': [
    { name: 'Poster', w: 18, h: 24, unit: 'in', res: 300, resUnit: 'ppi' }, px('Postcard', 1920, 1080),
    { name: 'Letter', w: 8.5, h: 11, unit: 'in', res: 300, resUnit: 'ppi' }, px('Square 2048', 2048, 2048), px('Tall 3000', 2000, 3000),
  ],
  Web: [px('Web Large', 1920, 1080), px('Web Medium', 1440, 900), px('Web Common', 1366, 768), px('MacBook Pro 16"', 1728, 1117), px('Web Minimum', 1024, 768), px('Social Square', 1080, 1080)],
  Mobile: [px('iPhone 15 Pro', 1179, 2556), px('iPhone 15 Pro Max', 1290, 2796), px('iPhone SE', 750, 1334), px('Android 1080p', 1080, 1920), px('iPad Pro 12.9"', 2048, 2732), px('Apple Watch 45mm', 396, 484)],
  'Film & Video': [px('HDTV 1080p', 1920, 1080), px('HDV/HDTV 720p', 1280, 720), px('UHD 4K', 3840, 2160), px('DCI 4K', 4096, 2160), px('UHD 8K', 7680, 4320), px('NTSC DV', 720, 480)],
};
const SAVED_KEY = 'pixora.newDoc.saved', RECENT_KEY = 'pixora.newDoc.recent', LAST_KEY = 'pixora.newDoc.last';
const load = <T,>(k: string, d: T): T => { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } };
const store = (k: string, v: unknown) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* ignore */ } };

const UNITS: SelectOption<Unit>[] = [{ value: 'px', label: 'Pixels' }, { value: 'in', label: 'Inches' }, { value: 'cm', label: 'Centimeters' }, { value: 'mm', label: 'Millimeters' }, { value: 'pt', label: 'Points' }, { value: 'pica', label: 'Picas' }];
const MODES: SelectOption<ColorMode>[] = [{ value: 'Bitmap', label: 'Bitmap' }, { value: 'Grayscale', label: 'Grayscale' }, { value: 'RGB', label: 'RGB Color' }, { value: 'CMYK', label: 'CMYK Color' }, { value: 'Lab', label: 'Lab Color' }];
const BGS: SelectOption<Bg>[] = [{ value: 'white', label: 'White' }, { value: 'black', label: 'Black' }, { value: 'background', label: 'Background Color' }, { value: 'transparent', label: 'Transparent' }, { value: 'custom', label: 'Custom...' }];

function pixelsOf(p: Preset) {
  const ppi = p.resUnit === 'ppcm' ? p.res * 2.54 : p.res;
  return { w: Math.max(1, Math.round(toPx(p.w, p.unit, ppi))), h: Math.max(1, Math.round(toPx(p.h, p.unit, ppi))) };
}
const describe = (p: Preset) => {
  const { w, h: hh } = pixelsOf(p);
  const dims = p.unit === 'px' ? `${w} x ${hh} px` : `${+p.w.toFixed(2)} x ${+p.h.toFixed(2)} ${p.unit}`;
  return `${dims} @ ${Math.round(p.res * 100) / 100} ${p.resUnit}`;
};

/** Create the document described by a preset. */
export function createFromPreset(p: Preset): PixDocument {
  const { w, h: hh } = pixelsOf(p);
  const bg = p.bg || 'white';
  const color: RGB | 'transparent' = bg === 'white' ? { r: 255, g: 255, b: 255 } : bg === 'black' ? { r: 0, g: 0, b: 0 } : bg === 'background' ? { ...app.bg } : bg === 'custom' ? p.custom || { r: 255, g: 255, b: 255 } : 'transparent';
  const doc = PixDocument.create(w, hh, { name: p.name && !CATS_NAMES.has(p.name) ? p.name : undefined, resolution: p.res, resolutionUnit: p.resUnit, background: color, mode: p.mode || 'RGB' });
  doc.bitDepth = p.bits || 8;
  return doc;
}
const CATS_NAMES = new Set(Object.values(CATS).flat().map(p => p.name));

async function clipboardSize(): Promise<{ w: number; h: number } | null> {
  // never trigger a permission prompt just for a preset: only read when access is already granted
  try {
    const st = await (navigator.permissions as any)?.query({ name: 'clipboard-read' });
    if (st?.state !== 'granted') return null;
  } catch { return null; }
  const timeout = new Promise<null>(res => setTimeout(() => res(null), 400));
  return Promise.race([timeout, readClipboardSize()]);
}
async function readClipboardSize(): Promise<{ w: number; h: number } | null> {
  try {
    const items = await (navigator.clipboard as any).read?.();
    for (const it of items || []) {
      const t = it.types.find((x: string) => x.startsWith('image/'));
      if (!t) continue;
      const bmp = await createImageBitmap(await it.getType(t));
      const r = { w: bmp.width, h: bmp.height };
      bmp.close();
      return r;
    }
  } catch { /* permission denied / unsupported */ }
  return null;
}

export async function newDocumentDialog(initial?: Partial<Preset>): Promise<PixDocument | null> {
  const last = load<Preset>(LAST_KEY, { ...CATS.Photo[5], name: '' });
  const cur: Preset = { ...last, name: '', ...(initial || {}) };
  if (!cur.bg) cur.bg = 'white';
  const clip = initial ? null : await clipboardSize();
  if (clip) Object.assign(cur, { w: clip.w, h: clip.h, unit: 'px', res: 72, resUnit: 'ppi', name: 'Clipboard' });

  let cat = clip ? 'Recent' : 'Recent';
  const tabs = h('div.nd-tabs');
  const grid = h('div.nd-grid');
  const nameF = h('input.field.nd-name', { type: 'text', value: '', placeholder: 'Untitled', title: 'Document name' }) as HTMLInputElement;
  nameF.addEventListener('keydown', e => e.stopPropagation());
  let unit = cur.unit;
  const ppi = () => (cur.resUnit === 'ppcm' ? cur.res * 2.54 : cur.res);
  const wF = numberField(cur.w, v => { cur.w = v; syncOrient(); }, { min: 0.001, max: 300000, decimals: 3, width: 90, title: 'Width' });
  const hF = numberField(cur.h, v => { cur.h = v; syncOrient(); }, { min: 0.001, max: 300000, decimals: 3, width: 90, title: 'Height' });
  const unitF = select<Unit>(UNITS, unit, u => {
    const p = pixelsOf(cur);
    cur.w = fromPx(p.w, u, ppi()); cur.h = fromPx(p.h, u, ppi()); cur.unit = unit = u;
    wF.setValue(cur.w); hF.setValue(cur.h);
  }, { width: 120, title: 'Units' });
  const resF = numberField(cur.res, v => { const p = pixelsOf(cur); cur.res = v; if (unit === 'px') { cur.w = p.w; cur.h = p.h; } refreshInfo(); }, { min: 1, max: 29999, decimals: 2, width: 90, title: 'Resolution' });
  const resUnitF = select<'ppi' | 'ppcm'>([{ value: 'ppi', label: 'Pixels/Inch' }, { value: 'ppcm', label: 'Pixels/Centimeter' }], cur.resUnit, v => {
    cur.res = v === 'ppcm' && cur.resUnit === 'ppi' ? cur.res / 2.54 : v === 'ppi' && cur.resUnit === 'ppcm' ? cur.res * 2.54 : cur.res;
    cur.resUnit = v; resF.setValue(cur.res);
  }, { width: 150, title: 'Resolution units' });
  const modeF = select<ColorMode>(MODES, cur.mode || 'RGB', v => { cur.mode = v; }, { width: 130, title: 'Color mode' });
  const bitsF = select<number>([{ value: 1, label: '1 bit' }, { value: 8, label: '8 bit' }, { value: 16, label: '16 bit' }, { value: 32, label: '32 bit' }], cur.bits || 8, v => { cur.bits = (v === 1 ? 8 : v) as 8 | 16 | 32; }, { width: 90, title: 'Bit depth' });
  const swatch = colorSwatch(cur.custom || { r: 255, g: 255, b: 255 }, c => { cur.custom = c; cur.bg = 'custom'; bgF.setValue('custom'); }, { title: 'Custom background color' });
  const bgF = select<Bg>(BGS, cur.bg, async v => {
    if (v === 'custom') { const c = await hooks.openColorPicker(cur.custom || { r: 255, g: 255, b: 255 }, 'Color Picker (Custom Background)'); if (!c) { bgF.setValue(cur.bg!); return; } cur.custom = c; swatch.setValue(c); }
    cur.bg = v; syncSwatch();
  }, { width: 170, title: 'Background contents' });
  const syncSwatch = () => { swatch.style.visibility = cur.bg === 'custom' ? '' : 'hidden'; };
  const portrait = h('button.icon-btn.nd-or', { type: 'button', title: 'Portrait' }, icon('portrait', 18));
  const landscape = h('button.icon-btn.nd-or', { type: 'button', title: 'Landscape' }, icon('landscape', 18));
  const flip = (want: 'p' | 'l') => { if ((want === 'p') !== (cur.h > cur.w)) { [cur.w, cur.h] = [cur.h, cur.w]; wF.setValue(cur.w); hF.setValue(cur.h); } syncOrient(); };
  portrait.addEventListener('click', () => flip('p')); landscape.addEventListener('click', () => flip('l'));
  const info = h('div.nd-info');
  const refreshInfo = () => { const p = pixelsOf(cur); const mb = (p.w * p.h * 4 * ((cur.bits || 8) / 8)) / 1048576; info.textContent = `${p.w} x ${p.h} px · ${mb >= 1 ? mb.toFixed(1) + ' MB' : Math.round(mb * 1024) + ' KB'}`; };
  const syncOrient = () => { portrait.classList.toggle('active', cur.h > cur.w); landscape.classList.toggle('active', cur.w >= cur.h); refreshInfo(); };

  const applyPreset = (p: Preset) => {
    Object.assign(cur, { ...p, bg: p.bg || cur.bg, mode: p.mode || cur.mode || 'RGB', bits: p.bits || cur.bits || 8 });
    unit = cur.unit;
    nameF.placeholder = p.name || 'Untitled';
    wF.setValue(cur.w); hF.setValue(cur.h); unitF.setValue(cur.unit); resF.setValue(cur.res); resUnitF.setValue(cur.resUnit);
    modeF.setValue(cur.mode || 'RGB'); bitsF.setValue(cur.bits || 8); bgF.setValue(cur.bg || 'white'); syncSwatch(); syncOrient();
    drawGrid();
  };
  const presetsOf = (c: string): Preset[] => c === 'Recent' ? [...(clip ? [{ ...px('Clipboard', clip.w, clip.h) }] : []), ...load<Preset[]>(RECENT_KEY, [])] : c === 'Saved' ? load<Preset[]>(SAVED_KEY, []) : CATS[c];
  const drawTabs = () => {
    clear(tabs);
    for (const c of ['Recent', 'Saved', ...Object.keys(CATS)]) {
      const t = h('button.nd-tab', { type: 'button', class: c === cat ? 'active' : '', title: `${c} presets` }, c);
      t.addEventListener('click', () => { cat = c; drawTabs(); drawGrid(); });
      tabs.append(t);
    }
  };
  const drawGrid = () => {
    clear(grid);
    const list = presetsOf(cat);
    if (!list.length) grid.append(h('div.nd-empty', null, cat === 'Saved' ? 'No saved presets. Use the save icon next to the name to save the current settings.' : 'No recent documents yet.'));
    list.forEach((p, i) => {
      const { w, h: hh } = pixelsOf(p);
      const k = 64 / Math.max(w, hh);
      const box = h('div.nd-thumb', null, h('div.nd-page', { style: { width: Math.max(8, w * k) + 'px', height: Math.max(8, hh * k) + 'px' } }));
      const same = p.w === cur.w && p.h === cur.h && p.unit === cur.unit && p.res === cur.res;
      const card = h('button.nd-card', { type: 'button', class: same ? 'active' : '', title: `${p.name} — ${describe(p)}` }, box, h('div.nd-cname', null, p.name), h('div.nd-cdesc', null, describe(p)));
      card.addEventListener('click', () => applyPreset(p));
      card.addEventListener('dblclick', () => { applyPreset(p); dlg.close('ok'); });
      if (cat === 'Saved') card.addEventListener('contextmenu', e => { e.preventDefault(); const l = load<Preset[]>(SAVED_KEY, []); l.splice(i, 1); store(SAVED_KEY, l); drawGrid(); });
      grid.append(card);
    });
  };
  const saveBtn = h('button.icon-btn', { type: 'button', title: 'Save document preset' }, icon('save', 16));
  saveBtn.addEventListener('click', async () => {
    const n = await promptDialog('Save Document Preset', 'Save Preset Name:', nameF.value || 'Custom');
    if (!n) return;
    store(SAVED_KEY, [...load<Preset[]>(SAVED_KEY, []), { ...cur, name: n }]);
    cat = 'Saved'; drawTabs(); drawGrid();
  });
  const row = (label: string, ...els: HTMLElement[]) => h('div.nd-row', null, h('label.nd-lab', null, label), ...els);
  const details = h('div.nd-details', null,
    h('div.nd-dtitle', null, 'PRESET DETAILS'),
    h('div.nd-row', null, nameF, saveBtn),
    row('Width', wF, unitF),
    row('Height', hF, h('span.nd-orient', null, h('span.nd-lab2', null, 'Orientation'), portrait, landscape)),
    row('Resolution', resF, resUnitF),
    row('Color Mode', modeF, bitsF),
    row('Background Contents', bgF, swatch),
    info);
  const body = h('div.nd-body', null, h('div.nd-left', null, tabs, grid), details);
  drawTabs(); drawGrid(); syncSwatch(); syncOrient();
  const dlg = openDialog({ title: 'New Document', body, className: 'nd-dialog', buttons: [{ label: 'Create', primary: true, value: 'ok' }, { label: 'Close', value: null }] });
  setTimeout(() => nameF.focus(), 30);
  if ((await dlg.result) !== 'ok') return null;
  const final: Preset = { ...cur, name: nameF.value.trim() };
  store(LAST_KEY, { ...final, name: '' });
  const recent = load<Preset[]>(RECENT_KEY, []).filter(p => describe(p) !== describe(final));
  store(RECENT_KEY, [{ ...final, name: final.name || `${pixelsOf(final).w} x ${pixelsOf(final).h}` }, ...recent].slice(0, 12));
  const doc = createFromPreset(final);
  if (final.name) doc.name = final.name;
  app.addDocument(doc);
  return doc;
}
