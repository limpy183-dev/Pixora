// Font catalogue for the type tools: common families (only those actually installed are listed), local fonts via
// the Local Font Access API (Type > More Fonts...), recent fonts, style names, font picker widget with live preview.
import { h } from '../../ui/dom';
import { icon } from '../../ui/icons';
import { showPop } from '../../ui/widgets';
import { createCanvas, ctx2d } from '../../core/canvas';
import { toast } from '../../ui/toast';

const CANDIDATES = [
  'Arial', 'Arial Black', 'Helvetica', 'Helvetica Neue', 'Segoe UI', 'Roboto', 'Open Sans', 'Lato', 'Montserrat', 'Noto Sans', 'DejaVu Sans', 'Liberation Sans',
  'Ubuntu', 'Cantarell', 'Inter', 'Verdana', 'Tahoma', 'Trebuchet MS', 'Calibri', 'Candara', 'Franklin Gothic Medium', 'Gill Sans', 'Futura', 'Century Gothic',
  'Times New Roman', 'Times', 'Georgia', 'Garamond', 'Palatino Linotype', 'Book Antiqua', 'Cambria', 'Baskerville', 'Didot', 'Noto Serif', 'DejaVu Serif', 'Liberation Serif',
  'Courier New', 'Courier', 'Consolas', 'Menlo', 'Monaco', 'Lucida Console', 'DejaVu Sans Mono', 'Liberation Mono', 'Source Code Pro', 'Fira Code',
  'Impact', 'Comic Sans MS', 'Brush Script MT', 'Lucida Handwriting', 'Papyrus', 'Copperplate', 'Rockwell', 'Stencil',
];
export const GENERIC = ['sans-serif', 'serif', 'monospace', 'cursive', 'fantasy', 'system-ui'];
export const FONT_STYLES = ['Regular', 'Italic', 'Thin', 'Light', 'Light Italic', 'Medium', 'Medium Italic', 'Semibold', 'Bold', 'Bold Italic', 'Extra Bold', 'Black', 'Condensed', 'Bold Condensed'];

const probe = ctx2d(createCanvas(10, 10));
function installed(family: string): boolean {
  const s = 'mmmmmmmmmmlliWWWQ@#&ff1234';
  for (const base of ['monospace', 'serif', 'sans-serif']) {
    probe.font = `72px ${base}`;
    const w0 = probe.measureText(s).width;
    probe.font = `72px "${family}", ${base}`;
    if (probe.measureText(s).width !== w0) return true;
  }
  return false;
}
let families: string[] | null = null;
const localFamilies = new Set<string>();
export function fontFamilies(): string[] {
  if (!families) families = [...new Set([...CANDIDATES.filter(installed), ...localFamilies])].sort((a, b) => a.localeCompare(b));
  return [...families, ...GENERIC];
}
/** Type > More Fonts...: ask the browser for every installed font family. */
export async function loadLocalFonts(): Promise<number> {
  const q = (window as any).queryLocalFonts;
  if (typeof q !== 'function') { toast('This browser does not allow listing installed fonts. Common fonts are shown instead.', 'info', 4000); return 0; }
  try {
    const list = await q();
    for (const f of list) localFamilies.add(f.family);
    families = null;
    return localFamilies.size;
  } catch { toast('Access to local fonts was not granted.', 'error'); return 0; }
}
const RECENT_KEY = 'pixora.type.recentFonts';
export const recentFonts = (): string[] => { try { return JSON.parse(localStorage.getItem(RECENT_KEY) || '[]'); } catch { return []; } };
export function addRecentFont(f: string) { try { localStorage.setItem(RECENT_KEY, JSON.stringify([f, ...recentFonts().filter(x => x !== f)].slice(0, 8))); } catch { /* ignore */ } }

export type PreviewSize = 'none' | 'small' | 'medium' | 'large';
export const fontPrefs = { preview: (localStorage.getItem('pixora.type.preview') as PreviewSize) || 'medium' };
export function setPreviewSize(p: PreviewSize) { fontPrefs.preview = p; localStorage.setItem('pixora.type.preview', p); }

/** Font family picker: text field (type to filter) + popup list with previews, recent fonts on top. */
export function fontPicker(value: string, onChange: (f: string) => void, opts: { width?: number } = {}): HTMLElement & { setValue(v: string): void } {
  let cur = value;
  const inp = h('input.field.tp-font', { type: 'text', value, title: 'Set the font family', style: { width: (opts.width || 160) + 'px' } }) as HTMLInputElement;
  const btn = h('button.popup-arrow', { type: 'button', title: 'Choose a font', 'data-menu-anchor': '' }, icon('chevron-down', 12));
  const el = h('span.tp-fontpick', null, inp, btn) as any;
  const commit = (f: string) => { cur = f; inp.value = f; addRecentFont(f); onChange(f); };
  inp.addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Enter') { const m = fontFamilies().find(f => f.toLowerCase().startsWith(inp.value.toLowerCase())); commit(m || inp.value || cur); inp.blur(); } if (e.key === 'Escape') { inp.value = cur; inp.blur(); } });
  inp.addEventListener('focus', () => inp.select());
  inp.addEventListener('input', () => open(inp.value));
  let closeCur: (() => void) | null = null;
  const open = (filter = '') => {
    closeCur?.();
    const list = h('div.tp-fontlist');
    const px = fontPrefs.preview === 'large' ? 18 : fontPrefs.preview === 'small' ? 11 : 14;
    const add = (f: string) => {
      const it = h('div.tp-fontitem', { class: f === cur ? 'active' : '', title: f }, h('span.tp-fname', null, f), fontPrefs.preview !== 'none' ? h('span.tp-fprev', { style: { fontFamily: `"${f}", ${GENERIC.includes(f) ? f : 'sans-serif'}`, fontSize: px + 'px' } }, 'Sample') : null);
      it.addEventListener('mousedown', e => { e.preventDefault(); commit(f); close(); });
      list.append(it);
    };
    const q = filter.trim().toLowerCase();
    const all = fontFamilies().filter(f => !q || f.toLowerCase().includes(q));
    const rec = q ? [] : recentFonts().filter(f => all.includes(f));
    for (const f of rec) add(f);
    if (rec.length) list.append(h('div.tp-fontsep'));
    for (const f of all) add(f);
    if (!all.length) list.append(h('div.tp-fontempty', null, 'No matching fonts'));
    const more = h('div.tp-fontmore', null, 'More Fonts…');
    more.addEventListener('mousedown', async e => { e.preventDefault(); close(); const n = await loadLocalFonts(); if (n) { toast(`${n} local font families available`, 'success'); open(); } });
    const pop = h('div.tp-fontpop', null, list, more);
    const close = showPop(pop, el, () => { if (closeCur === close) closeCur = null; });
    closeCur = close;
    list.querySelector('.active')?.scrollIntoView({ block: 'center' });
  };
  btn.addEventListener('click', () => open());
  el.setValue = (v: string) => { cur = v; if (document.activeElement !== inp) inp.value = v; };
  return el;
}
