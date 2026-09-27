// Gradients panel: search, gradient groups (Basics, Blues … Grays, Legacy), large thumbnails. Click applies the gradient to
// the Gradient tool (and to a selected Gradient fill layer); double-click opens the Gradient Editor.
// New (+ from the current tool gradient), New Group, Rename, Delete (button or drag to trash), views, import / export, reset.
import '../features/color/color.css';
import { registerPanel } from '../ui/panels';
import { app } from '../core/app';
import { events } from '../core/events';
import { hooks, resources } from '../core/registry';
import type { Gradient } from '../core/types';
import { h } from '../ui/dom';
import { iconButton } from '../ui/widgets';
import { contextMenu, type MenuEntry } from '../ui/menu';
import { confirmDialog, promptDialog } from '../ui/dialog';
import { toast } from '../ui/toast';
import { type GradientEx, addGradient, addGradientFolder, deleteGradient, deleteGradientFolder, gradientFolders, onPresets, renameGradient, resetGradients } from '../features/color/store';
import { type ViewMode, downloadJSON, dropTarget, gradientBg, pickJSON, renderFolders, searchField } from '../features/color/preset-ui';

const PREF = 'pixora.gradientsPanel';
const pref = (() => { try { return { mode: 'large' as ViewMode, collapsed: [] as string[], ...JSON.parse(localStorage.getItem(PREF) || '{}') }; } catch { return { mode: 'large' as ViewMode, collapsed: [] as string[] }; } })();
try { if (!localStorage.getItem(PREF)) pref.collapsed = ['Legacy Gradients']; } catch { /* ignore */ }
const collapsed = new Set<string>(pref.collapsed);
const savePref = () => { try { localStorage.setItem(PREF, JSON.stringify({ mode: pref.mode, collapsed: [...collapsed] })); } catch { /* ignore */ } };
let selected: GradientEx | null = null;
let selectedGroup: string | null = null;
let rerender = () => {};

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));
const toolGradient = (): Gradient | null => app.getTool('gradient')?.settings?.gradient ?? null;

/** Apply a gradient preset: Gradient tool settings + the active Gradient fill layer (if any). */
export function applyGradient(g: Gradient) {
  const t = app.getTool('gradient');
  if (t?.settings) { t.settings.gradient = clone(g); app.saveToolSettings(t); }
  const doc = app.activeDoc, l: any = doc?.activeLayer;
  if (doc && l && l.kind === 'fill' && l.fill?.type === 'gradient' && !l.locks?.all) {
    doc.history.transaction('Change Gradient Fill', () => { l.fill = { ...l.fill, gradient: clone(g) }; l.invalidate(); });
    doc.layersChanged();
  }
}

async function newGradient() {
  const cur = toolGradient() || resources.gradients[0];
  if (!cur) return;
  let n = 1;
  while (resources.gradients.some(g => g.name === `Gradient ${n}`)) n++;
  const name = await promptDialog('Gradient Name', 'Name:', cur.name && !resources.gradients.some(g => g.name === cur.name && JSON.stringify(g.stops) === JSON.stringify(cur.stops)) ? cur.name : `Gradient ${n}`);
  if (!name) return;
  selected = addGradient({ ...clone(cur), name }, selectedGroup || 'Custom');
}
async function newGroup() {
  let n = 1;
  while (gradientFolders().includes(`Group ${n}`)) n++;
  const name = await promptDialog('Group Name', 'Name:', `Group ${n}`);
  if (name) { addGradientFolder(name); selectedGroup = name; }
}
async function rename(g: GradientEx) {
  const name = await promptDialog('Gradient Name', 'Name:', g.name);
  if (name && name !== g.name) renameGradient(g, name);
}
function del(g: GradientEx) { if (selected === g) selected = null; deleteGradient(g); }
async function delGroup(name: string) {
  if (await confirmDialog('Delete Group', `Delete the gradient group "${name}" and all gradients in it?`) !== 'ok') return;
  if (selectedGroup === name) selectedGroup = null;
  deleteGradientFolder(name);
}
async function edit(g: GradientEx) {
  const r = await hooks.openGradientEditor(clone(g));
  if (r) applyGradient(r);
}
async function importGradients() {
  const data = await pickJSON();
  if (data === null) return;
  const list: any[] = Array.isArray(data) ? data : Array.isArray(data?.gradients) ? data.gradients : data?.stops ? [data] : [];
  const ok = list.filter(g => g && Array.isArray(g.stops) && g.stops.length && g.stops.every((s: any) => s.color && Number.isFinite(s.pos)));
  if (!ok.length) { toast('The file does not contain any gradients.', 'error'); return; }
  for (const g of ok) addGradient({ name: String(g.name || 'Gradient'), stops: g.stops, opacityStops: Array.isArray(g.opacityStops) && g.opacityStops.length ? g.opacityStops : [{ pos: 0, opacity: 1 }, { pos: 1, opacity: 1 }], smoothness: g.smoothness ?? 1, ...(g.type ? { type: g.type, noise: g.noise } : {}) } as GradientEx, g.group || 'Imported');
  toast(`Imported ${ok.length} gradient${ok.length === 1 ? '' : 's'}.`, 'success');
}

registerPanel({
  id: 'gradients', title: 'Gradients', icon: 'gradients', defaultHeight: 260, minHeight: 100,
  create(el) {
    let filter = '';
    const search = searchField('Search Gradients', v => { filter = v; render(); });
    const list = h('div.panel-scroll.pf-list');
    let dragged: GradientEx | null = null;
    const trash = iconButton('trash', 'Delete gradient (or drag a gradient here)', () => {
      if (selected) del(selected); else if (selectedGroup) delGroup(selectedGroup); else toast('Select a gradient or a group to delete.', 'info');
    });
    dropTarget(trash, () => { if (dragged) del(dragged); dragged = null; });
    el.append(h('div.pf-top', null, search), list, h('div.panel-footer', null,
      iconButton('folder', 'Create new group', () => newGroup()),
      iconButton('new-layer', 'Create new gradient from the current Gradient tool gradient', () => newGradient()),
      trash));
    const render = () => {
      const cur = toolGradient();
      renderFolders<GradientEx>(list, {
        cls: 'gr', collapsed, filter: () => filter, mode: () => pref.mode,
        groups: () => gradientFolders().map(name => ({ name, items: (resources.gradients as GradientEx[]).filter(g => (g.group || 'Custom') === name) })),
        name: g => g.name,
        thumb: g => h('div.gr-thumb', { style: { background: gradientBg(g) } }),
        isSelected: g => (selected ? g === selected : !!cur && g.name === cur.name),
        onToggle: savePref,
        onPick: g => { selected = g; selectedGroup = g.group || 'Custom'; applyGradient(g); render(); },
        onDblClick: g => edit(g),
        onDragStart: g => { dragged = g; },
        onContext: (g, e) => contextMenu(e, [
          { label: 'Edit Gradient...', action: () => edit(g) },
          { label: 'Duplicate Gradient', action: () => { selected = addGradient({ ...clone(g), name: g.name + ' copy' }, g.group); } },
          { label: 'Rename Gradient...', action: () => rename(g) },
          { label: 'Delete Gradient', action: () => del(g) },
          '-',
          { label: 'New Gradient Preset...', action: () => newGradient() },
        ]),
        onFolderContext: (name, e) => { selectedGroup = name; selected = null; contextMenu(e, [
          { label: 'New Gradient in Group...', action: () => newGradient() },
          { label: 'Export Group...', action: () => downloadJSON(`${name}.json`, { gradients: resources.gradients.filter(g => ((g as GradientEx).group || 'Custom') === name) }) },
          { label: 'Delete Group', action: () => delGroup(name) },
        ]); },
      });
    };
    rerender = render;
    render();
    onPresets('gradients', render);
    events.on('toolOptions', () => { if (el.isConnected) render(); });
    events.on('colors', () => { if (el.isConnected) render(); });   // Foreground/Background presets follow the colours
    return { onShow: render };
  },
  menu(): MenuEntry[] {
    const setMode = (m: ViewMode) => { pref.mode = m; savePref(); rerender(); };
    return [
      { label: 'New Gradient Preset...', action: () => newGradient() },
      { label: 'New Gradient Group...', action: () => newGroup() },
      '-',
      { label: 'Rename Gradient...', enabled: !!selected, action: () => selected && rename(selected) },
      { label: 'Delete Gradient', enabled: !!selected, action: () => selected && del(selected) },
      '-',
      { label: 'Small Thumbnail', radio: true, checked: pref.mode === 'small', action: () => setMode('small') },
      { label: 'Large Thumbnail', radio: true, checked: pref.mode === 'large', action: () => setMode('large') },
      { label: 'Small List', radio: true, checked: pref.mode === 'list-small', action: () => setMode('list-small') },
      { label: 'Large List', radio: true, checked: pref.mode === 'list-large', action: () => setMode('list-large') },
      '-',
      { label: 'Import Gradients...', action: () => importGradients() },
      { label: 'Export Selected Gradients...', action: () => {
        const list = selected ? [selected] : selectedGroup ? resources.gradients.filter(g => ((g as GradientEx).group || 'Custom') === selectedGroup) : resources.gradients;
        downloadJSON(`${selected?.name || selectedGroup || 'Gradients'}.json`, { gradients: list });
      } },
      { label: 'Reset Gradients...', action: async () => { if (await confirmDialog('Reset Gradients', 'Replace current gradients with the default gradients?') === 'ok') { selected = null; selectedGroup = null; resetGradients(); } } },
    ];
  },
});
