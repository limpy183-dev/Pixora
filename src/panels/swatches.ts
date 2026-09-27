// Swatches panel: search, Recent Colors, swatch groups (folders), new swatch / group, delete (button or drag to trash),
// thumbnail / list views, reset, import / export (.json). User swatches persist in localStorage (features/color/store).
import '../features/color/color.css';
import { registerPanel } from '../ui/panels';
import { app } from '../core/app';
import { events } from '../core/events';
import { resources } from '../core/registry';
import type { RGB } from '../core/types';
import { toCss, toHex } from '../core/color';
import { h } from '../ui/dom';
import { iconButton } from '../ui/widgets';
import { contextMenu, type MenuEntry } from '../ui/menu';
import { confirmDialog, promptDialog } from '../ui/dialog';
import { toast } from '../ui/toast';
import { type Swatch, addSwatch, addSwatchFolder, nextSwatchName, onPresets, removeSwatchFolder, resetSwatches, saveSwatches, swatchGroups } from '../features/color/store';
import { type ViewMode, downloadJSON, dropTarget, pickJSON, renderFolders, searchField } from '../features/color/preset-ui';

const PREF = 'pixora.swatchesPanel';
const pref = (() => { try { return { mode: 'small' as ViewMode, recent: true, collapsed: [] as string[], ...JSON.parse(localStorage.getItem(PREF) || '{}') }; } catch { return { mode: 'small' as ViewMode, recent: true, collapsed: [] as string[] }; } })();
const collapsed = new Set<string>(pref.collapsed);
const savePref = () => { try { localStorage.setItem(PREF, JSON.stringify({ mode: pref.mode, recent: pref.recent, collapsed: [...collapsed] })); } catch { /* ignore */ } };
let selected: Swatch | null = null;
let selectedGroup: string | null = null;
let refresh = () => {};

const pickColor = (c: RGB, e: MouseEvent) => {
  if (e.altKey || e.ctrlKey || e.metaKey) app.setBackground(c); else app.setForeground(c);
};

async function newSwatch(color: RGB = app.fg) {
  const name = await promptDialog('Color Swatch Name', 'Name:', nextSwatchName());
  if (name === null) return;
  addSwatch(color, name || nextSwatchName(), selectedGroup ?? (selected?.group || undefined));
}
async function newGroup() {
  let n = 1;
  while (swatchGroups().includes(`Group ${n}`)) n++;
  const name = await promptDialog('Group Name', 'Name:', `Group ${n}`);
  if (!name) return;
  addSwatchFolder(name);
  selectedGroup = name;
}
function deleteSwatch(s: Swatch) {
  const i = resources.swatches.indexOf(s);
  if (i < 0) return;
  resources.swatches.splice(i, 1);
  if (selected === s) selected = null;
  saveSwatches();
}
async function renameSwatch(s: Swatch) {
  const name = await promptDialog('Color Swatch Name', 'Name:', s.name);
  if (name) { s.name = name; saveSwatches(); }
}
async function deleteGroup(name: string) {
  const r = await confirmDialog('Delete Group', `Delete the swatch group "${name}" and all swatches in it?`);
  if (r !== 'ok') return;
  removeSwatchFolder(name);
  if (selectedGroup === name) selectedGroup = null;
}
async function importSwatches() {
  const data = await pickJSON();
  if (data === null) return;
  const list: any[] = Array.isArray(data) ? data : Array.isArray(data?.swatches) ? data.swatches : [];
  const ok = list.filter(s => s && s.color && [s.color.r, s.color.g, s.color.b].every((v: any) => Number.isFinite(v)));
  if (!ok.length) { toast('The file does not contain any swatches.', 'error'); return; }
  for (const s of ok) resources.swatches.push({ name: String(s.name || nextSwatchName()), color: { r: s.color.r | 0, g: s.color.g | 0, b: s.color.b | 0 }, group: s.group || 'Imported' });
  saveSwatches();
  toast(`Imported ${ok.length} swatch${ok.length === 1 ? '' : 'es'}.`, 'success');
}

registerPanel({
  id: 'swatches', title: 'Swatches', icon: 'swatches', defaultHeight: 220, minHeight: 90,
  create(el) {
    let filter = '';
    const search = searchField('Search Swatches', v => { filter = v; render(); });
    const recent = h('div.sw-recent', { title: 'Recently used colors' });
    const list = h('div.panel-scroll.pf-list');
    const trash = iconButton('trash', 'Delete swatch (or drag a swatch here)', () => {
      if (selected) deleteSwatch(selected);
      else if (selectedGroup) deleteGroup(selectedGroup);
      else toast('Select a swatch or a group to delete.', 'info');
    });
    let dragged: Swatch | null = null;
    dropTarget(trash, () => { if (dragged) deleteSwatch(dragged); dragged = null; });
    const footer = h('div.panel-footer', null,
      iconButton('folder', 'Create new group', () => newGroup()),
      iconButton('new-layer', 'Create new swatch from the foreground color', () => newSwatch()),
      trash);
    el.append(h('div.pf-top', null, search), recent, list, footer);

    const renderRecent = () => {
      recent.style.display = pref.recent ? '' : 'none';
      if (!pref.recent) return;
      const cols = app.recentColors;
      recent.replaceChildren(...(cols.length ? cols : [app.fg]).slice(0, 12).map(c => {
        const s = h('div.sw-chip', { title: `#${toHex(c).toUpperCase()} — click: foreground, Ctrl/Alt-click: background`, style: { background: toCss(c) } });
        s.addEventListener('click', e => pickColor(c, e));
        return s;
      }));
    };
    const render = () => {
      renderFolders<Swatch>(list, {
        cls: 'sw', collapsed, filter: () => filter, mode: () => pref.mode,
        groups: () => swatchGroups().map(name => ({ name, items: resources.swatches.filter(s => (s.group || 'Custom') === name) })),
        name: s => s.name,
        thumb: s => h('div.sw-thumb', { style: { background: toCss(s.color) } }),
        isSelected: s => s === selected,
        onToggle: savePref,
        onPick: (s, e) => { selected = s; selectedGroup = s.group || 'Custom'; pickColor(s.color, e); render(); },
        onDblClick: s => renameSwatch(s),
        onDragStart: s => { dragged = s; },
        onContext: (s, e) => contextMenu(e, [
          { label: 'New Swatch...', action: () => newSwatch(app.fg) },
          { label: 'Rename Swatch...', action: () => renameSwatch(s) },
          { label: 'Delete Swatch', action: () => deleteSwatch(s) },
          '-',
          { label: 'Set as Background Color', action: () => app.setBackground(s.color) },
          { label: "Copy Color's Hex Code", action: () => navigator.clipboard?.writeText('#' + toHex(s.color)).then(() => toast('Hex code copied', 'success')) },
        ]),
        onFolderContext: (name, e) => { selectedGroup = name; selected = null; contextMenu(e, [
          { label: 'New Swatch in Group...', action: () => { selectedGroup = name; newSwatch(); } },
          { label: 'Rename Group...', action: async () => {
            const nn = await promptDialog('Group Name', 'Name:', name);
            if (!nn || nn === name) return;
            for (const s of resources.swatches) if ((s.group || 'Custom') === name) s.group = nn;
            collapsed.delete(name);
            addSwatchFolder(nn); removeSwatchFolder(name);
          } },
          { label: 'Delete Group', action: () => deleteGroup(name) },
        ]); },
        emptyText: 'No swatches. Click + to add the foreground color.',
      });
    };
    refresh = () => { renderRecent(); render(); };
    refresh();
    events.on('colors', renderRecent);
    onPresets('swatches', render);
    return { onShow: refresh };
  },
  menu(): MenuEntry[] {
    const setMode = (m: ViewMode) => { pref.mode = m; savePref(); refresh(); };
    return [
      { label: 'New Swatch Preset...', action: () => newSwatch() },
      { label: 'New Swatch Group...', action: () => newGroup() },
      '-',
      { label: 'Show Recent Colors', checked: pref.recent, action: () => { pref.recent = !pref.recent; savePref(); refresh(); } },
      '-',
      { label: 'Small Thumbnail', radio: true, checked: pref.mode === 'small', action: () => setMode('small') },
      { label: 'Large Thumbnail', radio: true, checked: pref.mode === 'large', action: () => setMode('large') },
      { label: 'Small List', radio: true, checked: pref.mode === 'list-small', action: () => setMode('list-small') },
      { label: 'Large List', radio: true, checked: pref.mode === 'list-large', action: () => setMode('list-large') },
      '-',
      { label: 'Import Swatches...', action: () => importSwatches() },
      { label: 'Export Selected Swatches...', action: () => {
        const list = selectedGroup ? resources.swatches.filter(s => (s.group || 'Custom') === selectedGroup) : resources.swatches;
        downloadJSON(`${selectedGroup || 'Swatches'}.json`, { swatches: list });
      } },
      { label: 'Reset Swatches...', action: async () => { if (await confirmDialog('Reset Swatches', 'Replace current swatches with the default swatches?') === 'ok') { selected = null; selectedGroup = null; resetSwatches(); } } },
    ];
  },
});
