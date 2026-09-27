// Edit › Presets › Preset Manager… (brushes, swatches, gradients, styles, patterns, custom shapes, tool presets:
// rename, delete, reorder, load / save sets, reset) and Edit › Presets › Export/Import Presets… (one bundle file).
import './customize.css';
import { app } from '../../core/app';
import { registerCommands } from '../../core/commands';
import { resources, type CustomShape, type StylePreset } from '../../core/registry';
import { createCanvas, ctx2d } from '../../core/canvas';
import { gradientLUT } from '../../core/gradient';
import { toCss } from '../../core/color';
import { h } from '../../ui/dom';
import { icon } from '../../ui/icons';
import { openDialog, promptDialog, confirmDialog } from '../../ui/dialog';
import { checkbox, select } from '../../ui/widgets';
import { toast } from '../../ui/toast';
import { allPresets, addPreset, deletePreset, renamePreset, restoreDefaultBrushes, strokeThumb, brushEvents, type BrushPresetEx } from '../brushes/presets';
import { addGradient, addPattern, addSwatch, deleteGradient, deletePattern, renameGradient, renamePattern, resetGradients, resetPatterns, resetSwatches, saveSwatches, notifyPresets, type GradientEx, type PatternEx, type Swatch } from '../color/store';
import { saveUserStyles, styleThumb } from '../../effects/dialog';
import { saveUserShapes } from '../../tools/vector/resources';
import { downloadBlob, pickFiles } from '../file/io';
import { whenReady } from '../prefs/store';

// ------------------------------------------------------------------ overlay for built-in styles / shapes (their modules only persist user items)
type Overlay = { hidden: string[]; renamed: Record<string, string> };
const OKEY = 'pixora.presetManager';
const overlay: { styles: Overlay; shapes: Overlay } = (() => { try { return { styles: { hidden: [], renamed: {} }, shapes: { hidden: [], renamed: {} }, ...JSON.parse(localStorage.getItem(OKEY) || '{}') }; } catch { return { styles: { hidden: [], renamed: {} }, shapes: { hidden: [], renamed: {} } }; } })();
const saveOverlay = () => { try { localStorage.setItem(OKEY, JSON.stringify(overlay)); } catch { /* ignore */ } };
const stash: { styles: StylePreset[]; shapes: CustomShape[] } = { styles: [], shapes: [] };
const isUserStyle = (s: StylePreset) => s.id.startsWith('style-');
const isUserShape = (s: CustomShape) => s.id.startsWith('user-');
function applyOverlay() {
  for (const [kind, list, user] of [['styles', resources.styles, isUserStyle], ['shapes', resources.shapes, isUserShape]] as const) {
    const o = overlay[kind];
    for (const it of list as any[]) {
      if (user(it)) continue;
      if (!(stash[kind] as any[]).some(x => x.id === it.id)) (stash[kind] as any[]).push({ ...it });
      if (o.renamed[it.id]) it.name = o.renamed[it.id];
    }
    for (let i = list.length - 1; i >= 0; i--) if (!user(list[i] as any) && o.hidden.includes(list[i].id)) list.splice(i, 1);
  }
}
whenReady(applyOverlay);

// ------------------------------------------------------------------ canvas <-> data URL
const toURL = (c: HTMLCanvasElement | null | undefined) => (c ? c.toDataURL('image/png') : null);
const fromURL = (u: string | null | undefined): Promise<HTMLCanvasElement | null> => new Promise(res => {
  if (!u) { res(null); return; }
  const img = new Image();
  img.onload = () => { const c = createCanvas(img.width, img.height); ctx2d(c).drawImage(img, 0, 0); res(c); };
  img.onerror = () => res(null);
  img.src = u;
});

// ------------------------------------------------------------------ preset kinds
interface ToolPreset { name: string; tool: string; settings: any }
const loadToolPresets = (): ToolPreset[] => { try { return JSON.parse(localStorage.getItem('pixora.toolPresets') || '[]'); } catch { return []; } };
const saveToolPresets = (l: ToolPreset[]) => { try { localStorage.setItem('pixora.toolPresets', JSON.stringify(l)); } catch { /* ignore */ } };

interface Kind<T = any> {
  id: string; label: string;
  items(): T[];
  name(it: T): string;
  thumb(it: T): Element;
  rename(it: T, name: string): void;
  del(it: T): void;
  reset(): void;
  reorder?(from: number, to: number): void;
  exp(it: T): any;
  imp(data: any): Promise<void>;
  changed(): void;
}
const img = (src: string) => h('img', { src, draggable: false });
const brushes: Kind<BrushPresetEx> = {
  id: 'brushes', label: 'Brushes', items: () => allPresets(), name: p => p.name,
  thumb: p => img(strokeThumb(p, 96, 28)),
  rename: (p, n) => renamePreset(p, n), del: p => deletePreset(p), reset: () => restoreDefaultBrushes(),
  exp: p => { const { id: _i, tip, custom: _c, ...rest } = p as any; delete rest._builtin; return { ...rest, tip: toURL(tip) }; },
  imp: async d => { const tip = await fromURL(d.tip); addPreset({ ...d, tip }); },
  changed: () => brushEvents.emit('change'),
};
const swatches: Kind<Swatch> = {
  id: 'swatches', label: 'Swatches', items: () => resources.swatches, name: s => s.name,
  thumb: s => h('span.pm-swatch', { style: { background: toCss(s.color) } }),
  rename: (s, n) => { s.name = n; saveSwatches(); },
  del: s => { const i = resources.swatches.indexOf(s); if (i >= 0) resources.swatches.splice(i, 1); saveSwatches(); },
  reset: () => resetSwatches(),
  reorder: (a, b) => { const [x] = resources.swatches.splice(a, 1); resources.swatches.splice(b, 0, x); saveSwatches(); },
  exp: s => ({ name: s.name, color: s.color, group: s.group }), imp: async d => addSwatch(d.color, d.name, d.group),
  changed: () => notifyPresets('swatches'),
};
const gradients: Kind<GradientEx> = {
  id: 'gradients', label: 'Gradients', items: () => resources.gradients as GradientEx[], name: g => g.name,
  thumb: g => { const c = createCanvas(64, 28), x = ctx2d(c), lut = gradientLUT(g, false, 64); const d = x.createImageData(64, 28); for (let yy = 0; yy < 28; yy++) for (let i = 0; i < 64; i++) { const a = lut[i * 4 + 3] / 255, ck = ((i >> 2) + (yy >> 2)) & 1 ? 204 : 255; for (let k = 0; k < 3; k++) d.data[(yy * 64 + i) * 4 + k] = lut[i * 4 + k] * a + ck * (1 - a); d.data[(yy * 64 + i) * 4 + 3] = 255; } x.putImageData(d, 0, 0); return c; },
  rename: (g, n) => renameGradient(g, n), del: g => deleteGradient(g), reset: () => resetGradients(),
  exp: g => { const o = JSON.parse(JSON.stringify(g)); delete o._orig; delete o._renamed; return o; }, imp: async d => { addGradient(d, d.group); },
  changed: () => notifyPresets('gradients'),
};
const patterns: Kind<PatternEx> = {
  id: 'patterns', label: 'Patterns', items: () => resources.patterns as PatternEx[], name: p => p.name,
  thumb: p => { const c = createCanvas(40, 40), x = ctx2d(c); x.fillStyle = x.createPattern(p.canvas, 'repeat')!; x.fillRect(0, 0, 40, 40); return c; },
  rename: (p, n) => renamePattern(p, n), del: p => deletePattern(p), reset: () => resetPatterns(),
  exp: p => ({ name: p.name, group: p.group, canvas: toURL(p.canvas) }), imp: async d => { const c = await fromURL(d.canvas); if (c) addPattern(d.name, c, d.group || 'Imported'); },
  changed: () => notifyPresets('patterns'),
};
const styles: Kind<StylePreset> = {
  id: 'styles', label: 'Styles', items: () => resources.styles, name: s => s.name,
  thumb: s => { try { return styleThumb(s.effects as any, 40); } catch { return icon('fx', 22); } },
  rename: (s, n) => { s.name = n; if (isUserStyle(s)) saveUserStyles(); else { overlay.styles.renamed[s.id] = n; saveOverlay(); } },
  del: s => { const i = resources.styles.indexOf(s); if (i >= 0) resources.styles.splice(i, 1); if (isUserStyle(s)) saveUserStyles(); else { overlay.styles.hidden.push(s.id); saveOverlay(); } },
  reset: () => { overlay.styles = { hidden: [], renamed: {} }; saveOverlay(); resources.styles.splice(0, resources.styles.length, ...stash.styles.map(s => ({ ...s }))); saveUserStyles(); },
  reorder: (a, b) => { const [x] = resources.styles.splice(a, 1); resources.styles.splice(b, 0, x); saveUserStyles(); },
  exp: s => ({ name: s.name, effects: s.effects }), imp: async d => { resources.styles.push({ id: `style-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`, name: d.name, effects: d.effects }); saveUserStyles(); },
  changed: () => {},
};
const shapes: Kind<CustomShape> = {
  id: 'shapes', label: 'Custom Shapes', items: () => resources.shapes, name: s => s.name,
  thumb: s => { const d = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); d.setAttribute('viewBox', '-4 -4 108 108'); d.innerHTML = `<path d="${s.path}" fill="currentColor" fill-rule="evenodd"/>`; d.classList.add('pm-shape'); return d; },
  rename: (s, n) => { s.name = n; if (isUserShape(s)) saveUserShapes(); else { overlay.shapes.renamed[s.id] = n; saveOverlay(); } },
  del: s => { const i = resources.shapes.indexOf(s); if (i >= 0) resources.shapes.splice(i, 1); if (isUserShape(s)) saveUserShapes(); else { overlay.shapes.hidden.push(s.id); saveOverlay(); } },
  reset: () => { overlay.shapes = { hidden: [], renamed: {} }; saveOverlay(); resources.shapes.splice(0, resources.shapes.length, ...stash.shapes.map(s => ({ ...s }))); saveUserShapes(); },
  exp: s => ({ name: s.name, path: s.path, group: (s as any).group }), imp: async d => { resources.shapes.push({ id: `user-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`, name: d.name, path: d.path, group: d.group || 'Imported' } as CustomShape); saveUserShapes(); },
  changed: () => {},
};
let toolCache: ToolPreset[] = [];
const toolPresets: Kind<ToolPreset> = {
  id: 'toolPresets', label: 'Tool Presets', items: () => (toolCache = loadToolPresets()), name: p => p.name,
  thumb: p => icon(app.tools.get(p.tool)?.icon || 'more', 22),
  rename: (p, n) => { const l = loadToolPresets(), i = toolCache.indexOf(p); if (l[i]) { l[i].name = n; saveToolPresets(l); } },
  del: p => { const l = loadToolPresets(), i = toolCache.indexOf(p); if (i >= 0) { l.splice(i, 1); saveToolPresets(l); toolCache = l; } },
  reset: () => saveToolPresets([]),
  reorder: (a, b) => { const l = loadToolPresets(); const [x] = l.splice(a, 1); l.splice(b, 0, x); saveToolPresets(l); },
  exp: p => p, imp: async d => { const l = loadToolPresets(); l.push({ name: d.name, tool: d.tool, settings: d.settings }); saveToolPresets(l); },
  changed: () => {},
};
const KINDS: Kind[] = [brushes, swatches, gradients, styles, patterns, shapes, toolPresets];

// ------------------------------------------------------------------ bundle files
async function exportBundle(parts: { kind: Kind; items: any[] }[], file: string) {
  const out: any = { pixoraPresets: 1, created: new Date().toISOString() };
  for (const p of parts) out[p.kind.id] = p.items.map(it => p.kind.exp(it));
  downloadBlob(new Blob([JSON.stringify(out)], { type: 'application/json' }), file);
}
async function readBundle(): Promise<any | null> {
  const [f] = await pickFiles('.json,application/json');
  if (!f) return null;
  try { const v = JSON.parse(await f.text()); if (!v.pixoraPresets) throw new Error(); return v; }
  catch { toast('That file is not a Pixora presets file.', 'error'); return null; }
}
async function importInto(kind: Kind, list: any[]) {
  let n = 0;
  for (const d of list) { try { await kind.imp(d); n++; } catch (err) { console.error(err); } }
  kind.changed();
  return n;
}

// ------------------------------------------------------------------ Preset Manager
async function presetManager() {
  let kind = KINDS[0];
  let view: 'small' | 'large' | 'list' = 'small';
  const sel = new Set<number>();
  let anchor = -1;
  const grid = h('div.pm-grid');
  const info = h('div.pm-info');
  const draw = () => {
    const items = kind.items();
    grid.className = `pm-grid pm-${view}`;
    grid.replaceChildren(...items.map((it, i) => {
      const cell = h('div.pm-item', { class: sel.has(i) ? 'sel' : '', title: kind.name(it), draggable: !!kind.reorder, dataset: { i: String(i) } }, h('span.pm-thumb', null, kind.thumb(it)), view !== 'small' || kind === toolPresets ? h('span.pm-name', null, kind.name(it)) : null);
      cell.addEventListener('click', e => {
        if (e.shiftKey && anchor >= 0) { sel.clear(); for (let k = Math.min(anchor, i); k <= Math.max(anchor, i); k++) sel.add(k); }
        else if (e.ctrlKey || e.metaKey) { if (sel.has(i)) sel.delete(i); else sel.add(i); anchor = i; }
        else { sel.clear(); sel.add(i); anchor = i; }
        draw();
      });
      cell.addEventListener('dblclick', () => void rename());
      if (kind.reorder) {
        cell.addEventListener('dragstart', e => { e.dataTransfer?.setData('text/plain', String(i)); });
        cell.addEventListener('dragover', e => { e.preventDefault(); cell.classList.add('drop'); });
        cell.addEventListener('dragleave', () => cell.classList.remove('drop'));
        cell.addEventListener('drop', e => { e.preventDefault(); const from = +(e.dataTransfer?.getData('text/plain') ?? -1); if (from >= 0 && from !== i) { kind.reorder!(from, i); kind.changed(); sel.clear(); draw(); } });
      }
      return cell;
    }));
    info.textContent = `${items.length} ${kind.label.toLowerCase()}${sel.size ? ` — ${sel.size} selected` : ''}${kind.reorder ? ' — drag to reorder' : ''}`;
    syncButtons();
  };
  const selected = () => { const items = kind.items(); return [...sel].sort((a, b) => a - b).map(i => items[i]).filter(Boolean); };
  const rename = async () => {
    const list = selected();
    for (const it of list) {
      const n = await promptDialog('Rename', 'Name:', kind.name(it));
      if (n === null) break;
      if (n.trim()) kind.rename(it, n.trim());
    }
    kind.changed(); draw();
  };
  const del = async () => {
    const list = selected();
    if (!list.length) return;
    if ((await confirmDialog('Delete', `Delete ${list.length === 1 ? `“${kind.name(list[0])}”` : `${list.length} ${kind.label.toLowerCase()}`}?`)) !== 'ok') return;
    for (const it of list) kind.del(it);
    sel.clear(); kind.changed(); draw();
  };
  const btnRename = h('button.btn', { type: 'button', title: 'Rename the selected presets', onclick: () => void rename() }, 'Rename…') as HTMLButtonElement;
  const btnDelete = h('button.btn', { type: 'button', title: 'Delete the selected presets', onclick: () => void del() }, 'Delete') as HTMLButtonElement;
  const syncButtons = () => { btnRename.disabled = !sel.size; btnDelete.disabled = !sel.size; };
  const side = h('div.pm-side',
    null,
    h('button.btn', { type: 'button', title: `Add the ${kind.label.toLowerCase()} from a presets file`, onclick: async () => { const b = await readBundle(); if (!b) return; const list = b[kind.id] || []; if (!list.length) { toast(`The file contains no ${kind.label.toLowerCase()}.`, 'info'); return; } const n = await importInto(kind, list); toast(`Loaded ${n} ${kind.label.toLowerCase()}.`, 'success'); draw(); } }, 'Load…'),
    h('button.btn', { type: 'button', title: 'Save the selected presets (or all) as a presets file', onclick: () => { const list = selected().length ? selected() : kind.items(); void exportBundle([{ kind, items: list }], `${kind.label}.json`); } }, 'Save Set…'),
    btnRename, btnDelete,
    h('div.cz-gap'),
    h('button.btn', { type: 'button', title: `Restore the default ${kind.label.toLowerCase()}`, onclick: async () => { if ((await confirmDialog('Reset', `Replace the current ${kind.label.toLowerCase()} with the default set? Custom presets of this type are removed.`)) !== 'ok') return; kind.reset(); kind.changed(); sel.clear(); draw(); } }, 'Reset…'));
  const head = h('div.pm-head', null,
    h('label.form-label', null, 'Preset Type:'),
    select<string>(KINDS.map(k => ({ value: k.id, label: k.label })), kind.id, v => { kind = KINDS.find(k => k.id === v)!; sel.clear(); anchor = -1; draw(); }, { width: 170, title: 'Preset type' }),
    h('span.cz-flex'),
    select<'small' | 'large' | 'list'>([{ value: 'small', label: 'Small Thumbnail' }, { value: 'large', label: 'Large Thumbnail' }, { value: 'list', label: 'Small List' }], view, v => { view = v; draw(); }, { width: 150, title: 'View' }));
  draw();
  const onKey = (e: KeyboardEvent) => { if ((e.key === 'Delete' || e.key === 'Backspace') && sel.size && !(e.target as HTMLElement).matches?.('input')) { e.preventDefault(); e.stopPropagation(); void del(); } };
  window.addEventListener('keydown', onKey, true);
  await openDialog({ title: 'Preset Manager', body: h('div.pm-body', null, head, h('div.pm-main', null, grid, side), info), width: 760, className: 'pm-dialog', buttons: [{ label: 'Done', primary: true, value: 'ok' }] }).result;
  window.removeEventListener('keydown', onKey, true);
}

// ------------------------------------------------------------------ Export / Import Presets
async function exportImport() {
  let tab: 'export' | 'import' = 'export';
  const pick = new Set(KINDS.map(k => k.id));
  let bundle: any = null;
  const importPick = new Set<string>();
  const pane = h('div.pm-ei');
  const draw = () => {
    tabs.replaceChildren(...(['export', 'import'] as const).map(t => h('button.cz-tab', { type: 'button', class: t === tab ? 'on' : '', title: t === 'export' ? 'Export Presets' : 'Import Presets', onclick: () => { tab = t; draw(); } }, t === 'export' ? 'Export Presets' : 'Import Presets')));
    if (tab === 'export') {
      pane.replaceChildren(
        h('div.pm-ei-note', null, 'Choose the preset types to export into one file you can share or import on another computer.'),
        ...KINDS.map(k => h('div.pm-ei-row', null, checkbox(`${k.label} (${k.items().length})`, pick.has(k.id), v => { if (v) pick.add(k.id); else pick.delete(k.id); }, { title: `Include ${k.label.toLowerCase()}` }))),
        h('div.pf-actions', null, h('button.btn.primary', { type: 'button', title: 'Save the chosen presets as a file', onclick: () => { const parts = KINDS.filter(k => pick.has(k.id)).map(k => ({ kind: k, items: k.items() })); if (!parts.length) { toast('Choose at least one preset type.', 'info'); return; } void exportBundle(parts, 'Pixora Presets.json'); } }, 'Export Presets…')));
    } else {
      pane.replaceChildren(
        h('div.pf-actions', null, h('button.btn', { type: 'button', title: 'Choose a Pixora presets file', onclick: async () => { const b = await readBundle(); if (!b) return; bundle = b; importPick.clear(); for (const k of KINDS) if (b[k.id]?.length) importPick.add(k.id); draw(); } }, 'Choose File…')),
        ...(bundle ? KINDS.filter(k => bundle[k.id]?.length).map(k => h('div.pm-ei-row', null, checkbox(`${k.label} (${bundle[k.id].length})`, importPick.has(k.id), v => { if (v) importPick.add(k.id); else importPick.delete(k.id); }, { title: `Import ${k.label.toLowerCase()}` }))) : [h('div.pm-ei-note', null, 'Choose a presets file exported from Pixora to see what it contains.')]),
        ...(bundle ? [h('div.pf-actions', null, h('button.btn.primary', { type: 'button', title: 'Add the chosen presets', onclick: async () => {
          let total = 0;
          for (const k of KINDS) if (importPick.has(k.id)) total += await importInto(k, bundle[k.id]);
          toast(`Imported ${total} presets.`, 'success');
        } }, 'Import Presets'))] : []));
    }
  };
  const tabs = h('div.cz-tabs');
  draw();
  await openDialog({ title: 'Export/Import Presets', body: h('div.pm-body', null, tabs, pane), width: 520, buttons: [{ label: 'Done', primary: true, value: 'ok' }] }).result;
}

registerCommands([
  { id: 'edit.presetManager', label: 'Preset Manager...', run: presetManager },
  { id: 'edit.exportPresets', label: 'Export/Import Presets...', run: exportImport },
]);
(window as any).__pxPresets = { KINDS, exportBundle, importInto, overlay };
