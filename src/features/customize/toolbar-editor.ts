// Edit › Toolbar…: customise the toolbar. Drag tools between slots, reorder them, drop a tool between slots to give
// it its own slot, or drop it on Extra Tools (reachable from the "…" button at the bottom of the toolbar). Restore
// Defaults, Clear Tools, Save / Load Preset and the visibility of the bottom controls. Persisted and applied at boot.
import './customize.css';
import { app, type Tool } from '../../core/app';
import { events } from '../../core/events';
import { registerCommands } from '../../core/commands';
import { h } from '../../ui/dom';
import { icon } from '../../ui/icons';
import { openDialog } from '../../ui/dialog';
import { checkbox } from '../../ui/widgets';
import { toast } from '../../ui/toast';
import { TOOLBAR_LAYOUT, toolbarExtras } from '../../ui/toolbar';
import type { MenuEntry } from '../../ui/menu';
import { downloadBlob, pickFiles } from '../file/io';
import { whenReady } from '../prefs/store';

interface Layout { slots: string[][]; extra: string[]; hide: { colors: boolean; qm: boolean; screen: boolean; place: boolean } }
const KEY = 'pixora.toolbar.custom';
const EXTRA = 'extra';
let defaults: { slots: string[]; groups: Map<string, { group: string; order: number }> } | null = null;

/** Tools that live on the toolbar (default slots), in default layout order. */
function captureDefaults() {
  if (defaults) return defaults;
  const groups = new Map<string, { group: string; order: number }>();
  for (const t of app.tools.values()) if (TOOLBAR_LAYOUT.includes(t.group)) groups.set(t.id, { group: t.group, order: t.order ?? 0 });
  defaults = { slots: [...TOOLBAR_LAYOUT], groups };
  return defaults;
}
function defaultLayout(): Layout {
  const d = captureDefaults();
  return { slots: d.slots.map(s => [...d.groups].filter(([, g]) => g.group === s).sort((a, b) => a[1].order - b[1].order).map(([id]) => id)).filter(x => x.length), extra: [], hide: { colors: false, qm: false, screen: false, place: false } };
}
function currentLayout(): Layout {
  try { const v = JSON.parse(localStorage.getItem(KEY) || 'null'); if (v?.slots) return normalise(v); } catch { /* ignore */ }
  return defaultLayout();
}
/** Keep only known toolbar tools; tools added since the layout was saved go to their default slot. */
function normalise(l: Layout): Layout {
  const d = captureDefaults(), known = new Set(d.groups.keys()), seen = new Set<string>();
  const clean = (ids: string[]) => ids.filter(id => known.has(id) && !seen.has(id) && (seen.add(id), true));
  const out: Layout = { slots: (l.slots || []).map(clean).filter(s => s.length), extra: clean(l.extra || []), hide: Object.assign({ colors: false, qm: false, screen: false, place: false }, l.hide || {}) };
  for (const id of known) if (!seen.has(id)) {
    const g = d.groups.get(id)!.group, slot = out.slots.find(s => s.some(x => d.groups.get(x)?.group === g));
    if (slot) slot.push(id); else out.slots.push([id]);
  }
  return out;
}
function apply(l: Layout) {
  const d = captureDefaults();
  const ids: string[] = [];
  l.slots.forEach((slot, i) => {
    // keep the original slot id when the slot still holds tools of that group (tool selection memory keeps working)
    const orig = d.groups.get(slot[0])?.group;
    const id = orig && !ids.includes(orig) ? orig : `custom-${i}`;
    ids.push(id);
    slot.forEach((tid, k) => { const t = app.tools.get(tid); if (t) { t.group = id; t.order = k; } });
  });
  l.extra.forEach((tid, k) => { const t = app.tools.get(tid); if (t) { t.group = EXTRA; t.order = k; } });
  TOOLBAR_LAYOUT.splice(0, TOOLBAR_LAYOUT.length, ...ids);
  const b = document.body;
  b.classList.toggle('tb-hide-colors', l.hide.colors); b.classList.toggle('tb-hide-qm', l.hide.qm);
  b.classList.toggle('tb-hide-screen', l.hide.screen); b.classList.toggle('tb-hide-place', l.hide.place);
  events.emit('tool');
}
toolbarExtras.items = () => [...app.tools.values()].filter(t => t.group === EXTRA).sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
  .map(t => ({ label: t.name, icon: t.icon, shortcut: t.shortcut, radio: true, checked: app.activeTool === t, action: () => app.setTool(t.id) }) as MenuEntry);
whenReady(() => { captureDefaults(); if (localStorage.getItem(KEY)) apply(currentLayout()); });

// ------------------------------------------------------------------ dialog
async function editToolbar() {
  let L = currentLayout();
  const left = h('div.tbe-list'), right = h('div.tbe-list');
  let dragId: string | null = null;
  const toolEl = (id: string) => {
    const t = app.tools.get(id) as Tool;
    const el = h('div.tbe-tool', { draggable: true, title: `Drag ${t.name} to another slot or to Extra Tools`, dataset: { tool: id } }, icon(t.icon, 18), h('span', null, t.name), t.shortcut ? h('span.tbe-key', null, t.shortcut) : null);
    el.addEventListener('dragstart', e => { dragId = id; el.classList.add('dragging'); e.dataTransfer?.setData('text/plain', id); if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move'; });
    el.addEventListener('dragend', () => { dragId = null; el.classList.remove('dragging'); document.querySelectorAll('.tbe-body .drop').forEach(x => x.classList.remove('drop')); });
    return el;
  };
  const remove = (id: string) => { L.slots = L.slots.map(s => s.filter(x => x !== id)); L.extra = L.extra.filter(x => x !== id); };
  /** Move a tool: to slot i at position k, to a new slot before slot i ('gap'), or to the extra list. */
  const move = (id: string, to: { slot?: number; at?: number; gap?: number; extra?: boolean; atExtra?: number }) => {
    const before = JSON.stringify(L);
    const target = to.slot !== undefined ? L.slots[to.slot] : null;
    remove(id);
    if (to.extra) L.extra.splice(to.atExtra ?? L.extra.length, 0, id);
    else if (to.gap !== undefined) L.slots.splice(to.gap, 0, [id]);
    else if (target) target.splice(Math.min(to.at ?? target.length, target.length), 0, id);
    L.slots = L.slots.filter(s => s.length);
    if (JSON.stringify(L) !== before) draw();
  };
  const dropZone = (el: HTMLElement, onDrop: (id: string, e: DragEvent) => void) => {
    el.addEventListener('dragover', e => { if (!dragId) return; e.preventDefault(); e.stopPropagation(); el.classList.add('drop'); });
    el.addEventListener('dragleave', e => { if (!el.contains(e.relatedTarget as Node)) el.classList.remove('drop'); });
    el.addEventListener('drop', e => { e.preventDefault(); e.stopPropagation(); el.classList.remove('drop'); const id = dragId || e.dataTransfer?.getData('text/plain'); if (id) onDrop(id, e); });
  };
  const indexIn = (container: HTMLElement, e: DragEvent) => { const rows = [...container.querySelectorAll<HTMLElement>(':scope > .tbe-tool')]; const i = rows.findIndex(r => e.clientY < r.getBoundingClientRect().top + r.offsetHeight / 2); return i < 0 ? rows.length : i; };
  const draw = () => {
    left.replaceChildren();
    L.slots.forEach((slot, i) => {
      const gap = h('div.tbe-gap', { title: 'Drop here to make a new slot' });
      dropZone(gap, id => move(id, { gap: i }));
      const box = h('div.tbe-slot', null, ...slot.map(toolEl));
      dropZone(box, (id, e) => move(id, { slot: i, at: indexIn(box, e) }));
      left.append(gap, box);
    });
    const tail = h('div.tbe-gap', { title: 'Drop here to make a new slot' });
    dropZone(tail, id => move(id, { gap: L.slots.length }));
    left.append(tail);
    right.replaceChildren(...(L.extra.length ? L.extra.map(toolEl) : [h('div.tbe-empty', null, 'Drag tools here to remove them from the toolbar. They stay available from the “…” button.')]));
  };
  dropZone(right, (id, e) => move(id, { extra: true, atExtra: indexIn(right, e) }));
  draw();
  (window as any).__tbeState = () => L;
  const show = (k: keyof Layout['hide'], label: string) => checkbox(label, !L.hide[k], v => { L.hide[k] = !v; }, { title: `Show ${label} at the bottom of the toolbar` });
  const body = h('div', null,
    h('div.tbe-body', null,
      h('div.tbe-col', null, h('div.tbe-title', null, 'Toolbar'), left),
      h('div.tbe-col', null, h('div.tbe-title', null, 'Extra Tools'), right)),
    h('div.tbe-foot', null,
      h('button.btn', { type: 'button', title: 'Put every tool back in its default slot', onclick: () => { const hide = L.hide; L = defaultLayout(); L.hide = hide; draw(); } }, 'Restore Defaults'),
      h('button.btn', { type: 'button', title: 'Move every tool to Extra Tools', onclick: () => { L.extra = [...L.slots.flat(), ...L.extra]; L.slots = []; draw(); } }, 'Clear Tools'),
      h('button.btn', { type: 'button', title: 'Save this toolbar as a preset file', onclick: () => downloadBlob(new Blob([JSON.stringify({ pixoraToolbar: 1, ...L }, null, 1)], { type: 'application/json' }), 'Toolbar.json') }, 'Save Preset…'),
      h('button.btn', { type: 'button', title: 'Load a toolbar preset file', onclick: async () => {
        const [f] = await pickFiles('.json,application/json');
        if (!f) return;
        try { const v = JSON.parse(await f.text()); if (!v.pixoraToolbar) throw new Error(); L = normalise(v); draw(); } catch { toast('That file is not a Pixora toolbar preset.', 'error'); }
      } }, 'Load Preset…')),
    h('div.tbe-foot', null, h('span.opt-label', null, 'Show:'), h('div.tbe-show', null, show('colors', 'Foreground / Background Colors'), show('qm', 'Quick Mask Mode'), show('screen', 'Screen Mode'), show('place', 'Place Image'))));
  const dlg = openDialog({ title: 'Customize Toolbar', body, width: 700, className: 'tbe-dialog', buttons: [{ label: 'Done', primary: true, value: 'ok' }, { label: 'Cancel', value: null }] });
  if ((await dlg.result) !== 'ok') return;
  try { localStorage.setItem(KEY, JSON.stringify(L)); } catch { /* ignore */ }
  apply(L);
}

registerCommands([{ id: 'edit.toolbar', label: 'Toolbar...', run: editToolbar }]);
(window as any).__pxToolbarEditor = { currentLayout, apply, defaultLayout, KEY };
