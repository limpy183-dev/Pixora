// Shared UI for the preset panels (Swatches, Gradients, Patterns) and the Gradient Editor presets area:
// folder list with expand/collapse, search filter, thumbnail/list views, drag-to-trash; gradient thumbnails;
// JSON import/export helpers.
import type { Gradient } from '../../core/types';
import { gradientLUT } from '../../core/gradient';
import { resolveGradient } from '../../core/presets';
import { createCanvas, ctx2d } from '../../core/canvas';
import { h } from '../../ui/dom';
import { icon } from '../../ui/icons';
import { hooks, resources } from '../../core/registry';
import type { Pattern } from '../../core/types';
import { showPop, thumbURL, type Field } from '../../ui/widgets';

export type ViewMode = 'small' | 'large' | 'list-small' | 'list-large';

export interface FolderViewOpts<T> {
  groups(): { name: string; items: T[] }[];
  name(t: T): string;
  /** Thumbnail element for an item. */
  thumb(t: T, mode: ViewMode): HTMLElement;
  mode(): ViewMode;
  filter(): string;
  collapsed: Set<string>;
  onToggle?(): void;
  onPick(t: T, e: MouseEvent): void;
  onDblClick?(t: T, e: MouseEvent): void;
  onContext?(t: T, e: MouseEvent): void;
  onFolderContext?(name: string, e: MouseEvent): void;
  isSelected?(t: T): boolean;
  /** Called when an item drag starts (HTML5 DnD) so a drop target (trash) can find it. */
  onDragStart?(t: T): void;
  cls: string;          // CSS prefix class for sizing (e.g. 'sw' / 'gr' / 'pt')
  emptyText?: string;
}

/** Render the folder tree into `host` (full rebuild — preset lists are small). */
export function renderFolders<T>(host: HTMLElement, o: FolderViewOpts<T>) {
  const q = o.filter().trim().toLowerCase(), mode = o.mode();
  const out: HTMLElement[] = [];
  for (const g of o.groups()) {
    const items = q ? g.items.filter(t => o.name(t).toLowerCase().includes(q) || g.name.toLowerCase().includes(q)) : g.items;
    if (q && !items.length) continue;
    const closed = !q && o.collapsed.has(g.name);
    const head = h('div.pf-head', { title: closed ? 'Expand group' : 'Collapse group' },
      h('span.pf-chev', null, icon(closed ? 'chevron-right' : 'chevron-down', 12)), icon('folder-outline', 16), h('span.pf-name', null, g.name));
    head.addEventListener('click', () => { if (o.collapsed.has(g.name)) o.collapsed.delete(g.name); else o.collapsed.add(g.name); o.onToggle?.(); renderFolders(host, o); });
    if (o.onFolderContext) head.addEventListener('contextmenu', e => { e.preventDefault(); o.onFolderContext!(g.name, e); });
    const body = h(`div.pf-body.${mode}`);
    if (!closed) for (const t of items) {
      const nm = o.name(t);
      const el = h(`div.pf-item.${o.cls}`, { title: nm, draggable: true },
        o.thumb(t, mode), mode.startsWith('list') ? h('span.pf-label', null, nm) : null);
      if (o.isSelected?.(t)) el.classList.add('sel');
      el.addEventListener('click', e => o.onPick(t, e));
      if (o.onDblClick) el.addEventListener('dblclick', e => o.onDblClick!(t, e));
      if (o.onContext) el.addEventListener('contextmenu', e => { e.preventDefault(); o.onContext!(t, e); });
      el.addEventListener('dragstart', e => { o.onDragStart?.(t); e.dataTransfer?.setData('text/plain', nm); if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move'; });
      body.append(el);
    }
    out.push(h('div.pf-group', null, head, closed ? null : body));
  }
  if (!out.length) out.push(h('div.panel-empty', null, q ? 'No matching presets.' : o.emptyText || 'No presets.'));
  host.replaceChildren(...out);
}

/** Make a button accept dropped items (drag-to-trash). */
export function dropTarget(btn: HTMLElement, onDrop: () => void) {
  btn.addEventListener('dragover', e => { e.preventDefault(); btn.classList.add('drop-hover'); });
  btn.addEventListener('dragleave', () => btn.classList.remove('drop-hover'));
  btn.addEventListener('drop', e => { e.preventDefault(); btn.classList.remove('drop-hover'); onDrop(); });
}

/** Search field for panels. */
export function searchField(placeholder: string, onInput: (v: string) => void): HTMLInputElement {
  const inp = h('input.field.pf-search-in', { type: 'search', placeholder, title: placeholder, spellcheck: false }) as HTMLInputElement;
  inp.addEventListener('input', () => onInput(inp.value));
  inp.addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Escape') { inp.value = ''; onInput(''); inp.blur(); } });
  return inp;
}

// ------------------------------------------------------------------ gradient thumbnails (exact LUT incl. opacity stops)
const gthumb = new Map<string, string>();
export function gradientKey(g: Gradient): string {
  const r = resolveGradient(g);
  return JSON.stringify([r.stops, r.opacityStops, r.smoothness]);
}
/** Data URL of a 256×1 gradient strip (use with background-size: 100% 100% over var(--checker)). */
export function gradientThumbURL(g: Gradient): string {
  const k = gradientKey(g);
  let u = gthumb.get(k);
  if (u) return u;
  const lut = gradientLUT(g, false, 256);
  const c = createCanvas(256, 1);
  ctx2d(c).putImageData(new ImageData(new Uint8ClampedArray(lut), 256, 1), 0, 0);
  u = c.toDataURL();
  if (gthumb.size > 600) gthumb.clear();
  gthumb.set(k, u);
  return u;
}
export function gradientBg(g: Gradient): string { return `url(${gradientThumbURL(g)}) 0 0 / 100% 100% no-repeat, var(--checker)`; }

// ------------------------------------------------------------------ JSON files
export function downloadJSON(fileName: string, data: unknown) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 1)], { type: 'application/json' }));
  const a = h('a', { href: url, download: fileName }) as HTMLAnchorElement;
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
export function pickJSON(): Promise<any | null> {
  return new Promise(resolve => {
    const inp = h('input', { type: 'file', accept: '.json,application/json' }) as HTMLInputElement;
    inp.onchange = async () => {
      const f = inp.files?.[0];
      if (!f) return resolve(null);
      try { resolve(JSON.parse(await f.text())); } catch { resolve(undefined); }
    };
    inp.click();
  });
}

// ------------------------------------------------------------------ options-bar preset pickers (folder popovers)
const pickerCollapsed = { gr: new Set<string>(), pt: new Set<string>() };
function presetPop<T extends { name: string; group?: string }>(anchor: HTMLElement, kind: 'gr' | 'pt', list: () => T[], thumb: (t: T) => HTMLElement, isSel: (t: T) => boolean, pick: (t: T) => void) {
  const host = h('div.pf-list.pf-pop-list');
  let q = '';
  const search = searchField(kind === 'gr' ? 'Search Gradients' : 'Search Patterns', v => { q = v; draw(); });
  let close = () => {};
  const draw = () => renderFolders<T>(host, {
    cls: kind, collapsed: pickerCollapsed[kind], filter: () => q, mode: () => 'small',
    groups: () => { const names: string[] = []; for (const t of list()) { const g = t.group || 'Custom'; if (!names.includes(g)) names.push(g); } return names.map(name => ({ name, items: list().filter(t => (t.group || 'Custom') === name) })); },
    name: t => t.name, thumb, isSelected: isSel,
    onPick: t => { pick(t); close(); },
  });
  draw();
  close = showPop(h('div.pf-pop', null, search, host), anchor);
}

/** Options-bar gradient picker: preview (click → Gradient Editor) + arrow (→ presets popover with folders). */
export function gradientPresetPicker(value: Gradient, onChange: (g: Gradient) => void): Field<Gradient> {
  let cur = value;
  const preview = h('div.grad-preview.pf-gpreview', { title: 'Click to edit the gradient' });
  const arrow = h('button.popup-arrow', { type: 'button', title: 'Open the gradient picker', 'data-menu-anchor': '' }, icon('chevron-down', 12));
  const el = h('span.grad-picker', null, preview, arrow) as unknown as Field<Gradient>;
  const paint = () => { preview.style.background = gradientBg(cur); preview.title = `${cur.name} — click to edit the gradient`; };
  preview.addEventListener('click', async () => { const r = await hooks.openGradientEditor(cur); if (r) { cur = r; paint(); onChange(r); } });
  arrow.addEventListener('click', () => presetPop(arrow, 'gr', () => resources.gradients as (Gradient & { group?: string })[],
    g => h('div.gr-thumb', { style: { background: gradientBg(g) } }), g => g.name === cur.name, g => { cur = g; paint(); onChange(g); }));
  paint();
  el.setValue = v => { cur = v; paint(); };
  el.getValue = () => cur;
  return el;
}

/** Options-bar pattern picker (preview + folder popover). */
export function patternPresetPicker(value: Pattern | null, onChange: (p: Pattern) => void): Field<Pattern | null> {
  let cur = value;
  const preview = h('div.pat-preview', { title: 'Pattern' });
  const arrow = h('button.popup-arrow', { type: 'button', title: 'Open the pattern picker', 'data-menu-anchor': '' }, icon('chevron-down', 12));
  const el = h('span.grad-picker', null, preview, arrow) as unknown as Field<Pattern | null>;
  const paint = () => { preview.style.backgroundImage = cur ? `url(${thumbURL(cur.canvas)})` : 'none'; preview.title = cur ? `Pattern: ${cur.name}` : 'Pattern'; };
  const open = (a: HTMLElement) => presetPop(a, 'pt', () => resources.patterns as (Pattern & { group?: string })[],
    p => h('div.pt-thumb', { style: { backgroundImage: `url(${thumbURL(p.canvas, 64)})` } }), p => p.id === cur?.id, p => { cur = p; paint(); onChange(p); });
  preview.addEventListener('click', () => open(preview));
  arrow.addEventListener('click', () => open(arrow));
  paint();
  el.setValue = v => { cur = v; paint(); };
  el.getValue = () => cur;
  return el;
}
