// Edit › Keyboard Shortcuts (Alt+Shift+Ctrl+K) and Edit › Menus (Alt+Shift+Ctrl+M): one dialog with two tabs.
// Keyboard Shortcuts: edit the shortcuts of every application menu command and the tool letters, with conflict
// detection ("…is already in use and will be removed from…"), Use Default, Add / Delete Shortcut, Summarize (HTML).
// Menus: hide application / panel menu items (the menu then ends with "Show All Menu Items") and give them colours.
// Customisations live in named sets ("Pixora Defaults" is read-only); the active set is applied to the shortcut
// table, the menus (menuHooks) and the tools.
import './customize.css';
import { app } from '../../core/app';
import { commands, eventShortcut, normShortcut, registerCommands, shortcutLabel, shortcutMap } from '../../core/commands';
import { h } from '../../ui/dom';
import { icon } from '../../ui/icons';
import { openDialog, promptDialog, confirmDialog } from '../../ui/dialog';
import { select } from '../../ui/widgets';
import { toast } from '../../ui/toast';
import { menuHooks, type MenuEntry, type MenuItem } from '../../ui/menu';
import { buildMenus } from '../../ui/menus-def';
import { buildShortcutMap } from '../../ui/shortcuts';
import { panelDefs } from '../../ui/panels';
import { downloadBlob } from '../file/io';
import { xp, whenReady } from '../prefs/store';

// ------------------------------------------------------------------ sets
export interface SetData { shortcuts: Record<string, string[]>; tools: Record<string, string>; hidden: string[]; colors: Record<string, string> }
const DEFAULTS = 'Pixora Defaults';
const emptySet = (): SetData => ({ shortcuts: {}, tools: {}, hidden: [], colors: {} });
const KEY = 'pixora.customize';
const store: { current: string; sets: Record<string, SetData> } = (() => {
  try { const v = JSON.parse(localStorage.getItem(KEY) || '{}'); return { current: v.current || DEFAULTS, sets: v.sets || {} }; } catch { return { current: DEFAULTS, sets: {} }; }
})();
const save = () => { try { localStorage.setItem(KEY, JSON.stringify(store)); } catch { /* ignore */ } };
export const activeSet = (): SetData => ({ ...emptySet(), ...(store.sets[store.current] || {}) });
const clone = (s: SetData): SetData => JSON.parse(JSON.stringify(s));

export const mkey = (cmd: string, arg?: unknown) => (arg === undefined ? `m:${cmd}` : `m:${cmd}|${JSON.stringify(arg)}`);
const parseKey = (k: string) => { const s = k.slice(2), i = s.indexOf('|'); return i < 0 ? { id: s, arg: undefined } : { id: s.slice(0, i), arg: JSON.parse(s.slice(i + 1)) }; };

// ------------------------------------------------------------------ menu tree
interface Node { label: string; key?: string; def?: string[]; children?: Node[]; path: string }
const toList = (s?: string | string[]) => (Array.isArray(s) ? s : s ? [s] : []);
function appTree(): Node[] {
  const walk = (items: MenuEntry[], path: string): Node[] => {
    const out: Node[] = [];
    for (const raw of items) {
      if (raw === '-' || (raw as MenuItem).separator || (raw as MenuItem).header) continue;
      const it = raw as MenuItem;
      const label = String(it.label ?? (it.cmd ? commands.get(it.cmd)?.label : '') ?? '').replace(/\.\.\.$/, '…');
      if (it.submenu) {
        let sub: MenuEntry[] = [];
        try { sub = typeof it.submenu === 'function' ? it.submenu() : it.submenu; } catch { /* dynamic */ }
        const kids = walk(sub, `${path} › ${label}`);
        if (kids.length) out.push({ label, children: kids, path });
        continue;
      }
      if (!it.cmd) continue;
      const cmd = commands.get(it.cmd);
      out.push({ label, key: mkey(it.cmd, it.arg), def: it.shortcut ? [it.shortcut] : toList(cmd?.shortcut), path });
    }
    return out;
  };
  const tops = buildMenus().map(m => { let items: MenuEntry[] = []; try { items = m.items(); } catch { /* ignore */ } return { label: m.label, children: walk(items, m.label), path: '' }; });
  return tops;
}
function panelTree(): Node[] {
  return [...panelDefs.values()].filter(p => p.menu).map(p => {
    let items: MenuEntry[] = [];
    try { items = (origPanelMenu.get(p.id) || p.menu!)(); } catch { /* ignore */ }
    const kids = items.filter((x): x is MenuItem => x !== '-' && !!(x as MenuItem).label && !(x as MenuItem).header).map(x => ({ label: String(x.label), key: `p:${p.id}:${x.label}`, path: p.title }));
    return { label: p.title, children: kids, path: '' };
  }).filter(n => n.children.length);
}
const flat = (nodes: Node[]): Node[] => nodes.flatMap(n => (n.children ? flat(n.children) : [n]));

// ------------------------------------------------------------------ applying the active set
const toolDefaults = new Map<string, string | undefined>();
let revealAll = false, lastTitle: Element | null = null;
export function applyCustomization() {
  const S = activeSet();
  buildShortcutMap();
  for (const [k, list] of Object.entries(S.shortcuts)) {
    const { id, arg } = parseKey(k), ks = mkey(id, arg);
    for (const [sc, v] of [...shortcutMap]) if (mkey(v.id, v.arg) === ks) shortcutMap.delete(sc);
    for (const sc of list) shortcutMap.set(normShortcut(sc), { id, arg });
  }
  for (const t of app.tools.values()) {
    if (!toolDefaults.has(t.id)) toolDefaults.set(t.id, t.shortcut);
    t.shortcut = t.id in S.tools ? S.tools[t.id] || undefined : toolDefaults.get(t.id);
  }
}
function showAll() {
  revealAll = true;
  lastTitle?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
}
menuHooks.transform = items => {
  const S = activeSet();
  const qx = xp.quickFormat !== 'png';
  if (!qx && !S.hidden.length && !Object.keys(S.shortcuts).length && !Object.keys(S.colors).length) return items;
  let hid = false;
  const out: MenuEntry[] = [];
  for (const raw of items) {
    if (raw === '-') { out.push(raw); continue; }
    let it = raw as MenuItem & { __pkey?: string };
    if (qx && it.cmd === 'file.quickExport') it = { ...it, label: `Quick Export as ${xp.quickFormat === 'jpeg' ? 'JPG' : 'WebP'}` };
    const k = it.cmd ? mkey(it.cmd, it.arg) : it.__pkey;
    if (!k) { out.push(it); continue; }
    if (S.hidden.includes(k) && !revealAll) { hid = true; continue; }
    let r: MenuItem = it;
    if (it.cmd && S.shortcuts[k]) r = { ...r, shortcut: S.shortcuts[k][0] ?? '' };
    if (S.colors[k] && xp.menuColors) r = { ...r, color: S.colors[k] };
    out.push(r);
  }
  if (hid) out.push('-', { label: 'Show All Menu Items', action: showAll });
  return out;
};
window.addEventListener('pointerdown', e => {
  const t = e.target as Element | null;
  if (t?.closest?.('.menu-item')) { lastTitle = document.querySelector('.menu-title.open'); return; }
  if (!t?.closest?.('.menu, .menu-title')) revealAll = false;
}, true);
const origPanelMenu = new Map<string, () => MenuEntry[]>();
function tagPanelMenus() {
  for (const p of panelDefs.values()) {
    if (!p.menu || origPanelMenu.has(p.id)) continue;
    const orig = p.menu.bind(p);
    origPanelMenu.set(p.id, orig);
    p.menu = () => orig().map(it => (it === '-' ? it : ({ ...(it as MenuItem), __pkey: `p:${p.id}:${(it as MenuItem).label}` }) as MenuItem));
  }
}
whenReady(() => { tagPanelMenus(); applyCustomization(); });

// ------------------------------------------------------------------ dialog
const COLORS: [string, string][] = [['', 'None'], ['red', 'Red'], ['orange', 'Orange'], ['yellow', 'Yellow'], ['green', 'Green'], ['blue', 'Blue'], ['violet', 'Violet'], ['gray', 'Gray']];
const validMenu = (sc: string) => /(^|\+)F([1-9]|1[0-2])$/.test(sc) || sc.startsWith('Ctrl+');
async function customize(tab: 'keys' | 'menus') {
  let W = activeSet(), setName = store.current, dirty = false;
  let mode: 'app' | 'panel' | 'tools' = 'app';
  const open = new Set<string>();
  let selKey: string | null = null, capture: { key: string; add: boolean } | null = null;
  let pending: { key: string; list: string[]; conflict?: { key: string; sc: string } } | null = null;
  const trees = { app: appTree(), panel: panelTree() };
  const allApp = flat(trees.app);
  const byKey = new Map(allApp.map(n => [n.key!, n]));
  const eff = (k: string) => (k in W.shortcuts ? W.shortcuts[k] : byKey.get(k)?.def || []);
  const toolEff = (id: string) => (id in W.tools ? W.tools[id] : toolDefaults.get(id) ?? app.tools.get(id)?.shortcut) || '';
  const status = h('div.cz-status');
  const list = h('div.cz-list');
  const head = h('div.cz-head');
  const tabs = h('div.cz-tabs');
  const side = h('div.cz-side');
  const note = h('div.cz-note');
  const drawNote = () => { note.textContent = tab === 'keys' ? 'Click a shortcut, then press the new key combination. Menu shortcuts need Ctrl and/or a function key; Esc cancels.' : 'Hidden items are listed at the end of their menu under “Show All Menu Items”. Colours can be turned off in Preferences › Interface.'; };
  const markDirty = () => { if (!dirty) { dirty = true; drawHead(); } };
  const conflictOf = (key: string, sc: string) => { const n = normShortcut(sc); for (const x of allApp) if (x.key !== key && eff(x.key!).some(s => normShortcut(s) === n)) return x; return null; };
  const pathOf = (n: Node) => `${n.path} › ${n.label}`;
  // ---- header (set + mode)
  const drawHead = () => {
    const names = [DEFAULTS, ...Object.keys(store.sets).filter(n => n !== DEFAULTS)];
    const shown = dirty && setName === DEFAULTS ? `${DEFAULTS} (modified)` : setName + (dirty ? ' (modified)' : '');
    head.replaceChildren(
      h('label.form-label', null, 'Set:'),
      select<string>(names.map(n => ({ value: n, label: n === setName ? shown : n })), setName, v => { setName = v; W = clone(store.sets[v] || emptySet()); dirty = false; pending = null; drawHead(); drawList(); }, { width: 230, title: 'Shortcut and menu set' }),
      h('button.icon-btn', { type: 'button', title: 'Save all changes to the current set', onclick: () => void saveSet(false) }, icon('save', 16)),
      h('button.icon-btn', { type: 'button', title: 'Create a new set based on the current set', onclick: () => void saveSet(true) }, icon('file-new', 16)),
      h('button.icon-btn', { type: 'button', title: 'Delete the current set', onclick: () => void deleteSet() }, icon('trash', 16)),
      h('span.cz-flex'),
      h('label.form-label', null, tab === 'keys' ? 'Shortcuts For:' : 'Menu For:'),
      select<string>(tab === 'keys' ? [{ value: 'app', label: 'Application Menus' }, { value: 'tools', label: 'Tools' }] : [{ value: 'app', label: 'Application Menus' }, { value: 'panel', label: 'Panel Menus' }], mode, v => { mode = v as any; pending = null; capture = null; drawList(); }, { width: 170, title: 'What to customise' }));
  };
  const saveSet = async (asNew: boolean) => {
    let name = setName;
    if (asNew || name === DEFAULTS) {
      const n = await promptDialog('Save', 'Name:', name === DEFAULTS ? 'Pixora Defaults (modified)' : `${name} copy`);
      if (!n || n === DEFAULTS) return false;
      name = n;
    }
    store.sets[name] = clone(W); store.current = name; setName = name; dirty = false; save(); applyCustomization(); drawHead();
    toast(`Set “${name}” saved.`, 'success');
    return true;
  };
  const deleteSet = async () => {
    if (setName === DEFAULTS) { toast('The Pixora Defaults set cannot be deleted.', 'info'); return; }
    if ((await confirmDialog('Delete Set', `Delete the set “${setName}”?`)) !== 'ok') return;
    delete store.sets[setName]; setName = DEFAULTS; store.current = DEFAULTS; W = emptySet(); dirty = false; save(); applyCustomization(); drawHead(); drawList();
  };
  // ---- side buttons (keyboard tab)
  const drawSide = () => {
    side.replaceChildren();
    if (tab !== 'keys') return;
    const b = (label: string, title: string, fn: () => void, on = true) => h('button.btn', { type: 'button', title, disabled: !on, onclick: fn }, label);
    const k = selKey;
    side.append(
      b('Accept', 'Accept the pending shortcut change', accept, !!pending),
      b('Undo', 'Undo the pending change', () => { pending = null; capture = null; drawList(); }, !!pending || !!capture),
      b('Use Default', 'Restore the default shortcut of the selected item', () => {
        if (!k) return;
        if (mode === 'tools') delete W.tools[k]; else delete W.shortcuts[k];
        markDirty(); drawList();
      }, !!k),
      b('Add Shortcut', 'Add another shortcut to the selected command', () => { if (k && mode === 'app') { capture = { key: k, add: true }; drawList(); } }, !!k && mode === 'app'),
      b('Delete Shortcut', 'Remove the shortcut of the selected item', () => {
        if (!k) return;
        if (mode === 'tools') W.tools[k] = ''; else W.shortcuts[k] = eff(k).slice(1);
        markDirty(); drawList();
      }, !!k),
      h('div.cz-gap'),
      b('Summarize…', 'Save an HTML page listing every shortcut of this set', summarize));
  };
  const accept = () => {
    if (!pending) return;
    if (pending.conflict) {
      const c = pending.conflict;
      if (mode === 'tools') { /* tool letters may be shared */ }
      else W.shortcuts[c.key] = eff(c.key).filter(s => normShortcut(s) !== normShortcut(c.sc));
    }
    if (mode === 'tools') W.tools[pending.key] = pending.list[0] || ''; else W.shortcuts[pending.key] = pending.list;
    pending = null; capture = null; markDirty(); drawList();
  };
  // ---- key capture
  const onKey = (e: KeyboardEvent) => {
    if (!capture) return;
    if (['Shift', 'Control', 'Alt', 'Meta', 'CapsLock'].includes(e.key)) return;
    e.preventDefault(); e.stopImmediatePropagation();
    if (e.key === 'Escape') { capture = null; drawList(); return; }
    const cap = capture;
    if (mode === 'tools') {
      if (!/^Key[A-Z]$/.test(e.code) || e.ctrlKey || e.altKey || e.metaKey) { status.textContent = 'Tool shortcuts must be a single letter (A–Z).'; status.className = 'cz-status error'; return; }
      const letter = e.code.slice(3), other = [...app.tools.values()].find(t => t.id !== cap.key && t.group !== app.tools.get(cap.key)?.group && toolEff(t.id) === letter);
      pending = { key: cap.key, list: [letter], conflict: other ? { key: other.id, sc: letter } : undefined };
      capture = null;
      status.textContent = other ? `${letter} is also used by ${other.name}; both tools will share it (Shift+${letter} cycles).` : '';
      status.className = 'cz-status';
      drawList();
      return;
    }
    const sc = eventShortcut(e);
    if (!validMenu(sc)) { status.textContent = `“${shortcutLabel(sc)}” is not valid: shortcuts must include Ctrl and/or a function key (F1–F12).`; status.className = 'cz-status error'; return; }
    const cur = eff(cap.key);
    const next = cap.add ? [...cur.filter(s => normShortcut(s) !== normShortcut(sc)), sc] : [sc, ...cur.slice(1).filter(s => normShortcut(s) !== normShortcut(sc))];
    const c = conflictOf(cap.key, sc);
    pending = { key: cap.key, list: next, conflict: c ? { key: c.key!, sc } : undefined };
    capture = null;
    status.textContent = c ? `${shortcutLabel(sc)} is already in use and will be removed from ${pathOf(c)} if accepted.` : '';
    status.className = c ? 'cz-status warn' : 'cz-status';
    if (!c) accept(); else drawList();
  };
  window.addEventListener('keydown', onKey, true);
  // ---- list
  const drawList = () => {
    list.replaceChildren();
    const headRow = h('div.cz-row.cz-colhead', null, h('span.cz-name', null, tab === 'keys' ? (mode === 'tools' ? 'Tools' : 'Application Menu Command') : mode === 'panel' ? 'Panel Menu Command' : 'Application Menu Command'), tab === 'keys' ? h('span.cz-sc', null, 'Shortcut') : h('span.cz-vis', null, 'Visibility'), tab === 'menus' ? h('span.cz-color', null, 'Color') : null);
    list.append(headRow);
    if (tab === 'keys' && mode === 'tools') {
      const tools = [...app.tools.values()].filter(t => !t.group.includes('-warp') && t.group !== 'ca-scale').sort((a, b) => a.group.localeCompare(b.group) || (a.order ?? 0) - (b.order ?? 0));
      for (const t of tools) list.append(keyRow(t.id, t.name, 0, pending?.key === t.id ? pending.list : [toolEff(t.id)].filter(Boolean), t.icon));
    } else {
      const nodes = mode === 'panel' ? trees.panel : trees.app;
      const rec = (ns: Node[], depth: number, pid: string) => {
        for (const n of ns) {
          if (n.children) {
            const id = `${pid}/${n.label}`, isOpen = open.has(id);
            const r = h('div.cz-row.cz-group', { style: { paddingLeft: 6 + depth * 16 + 'px' }, onclick: () => { if (isOpen) open.delete(id); else open.add(id); drawList(); } }, icon(isOpen ? 'caret-down' : 'caret-right', 11), h('span.cz-name', null, n.label));
            list.append(r);
            if (isOpen) rec(n.children, depth + 1, id);
            continue;
          }
          if (tab === 'keys') list.append(keyRow(n.key!, n.label, depth, pending && pending.key === n.key ? pending.list : eff(n.key!)));
          else list.append(menuRow(n, depth));
        }
      };
      rec(nodes, 0, mode);
    }
    drawSide();
  };
  const keyRow = (key: string, label: string, depth: number, scs: string[], ic?: string) => {
    const capturing = capture?.key === key, changed = mode === 'tools' ? key in W.tools : key in W.shortcuts;
    const cell = h('span.cz-sc', { class: capturing ? 'capturing' : '', title: 'Click, then press the new shortcut' },
      capturing ? (capture!.add ? 'Press the additional shortcut…' : 'Press the new shortcut…') : scs.map(s => shortcutLabel(s)).join(', ') || '—');
    const r = h('div.cz-row', { class: [selKey === key ? 'sel' : '', changed ? 'changed' : '', pending?.key === key ? 'pending' : ''].join(' '), style: { paddingLeft: 6 + depth * 16 + 'px' } },
      ic ? icon(ic, 14) : null, h('span.cz-name', null, label), cell);
    r.addEventListener('click', () => { selKey = key; drawList(); });
    cell.addEventListener('click', e => { e.stopPropagation(); selKey = key; pending = null; capture = { key, add: false }; status.textContent = ''; drawList(); });
    return r;
  };
  const menuRow = (n: Node, depth: number) => {
    const k = n.key!, hidden = W.hidden.includes(k);
    const eye = h('button.icon-btn.cz-vis', { type: 'button', title: hidden ? 'Show this item' : 'Hide this item', onclick: (e: MouseEvent) => { e.stopPropagation(); W.hidden = hidden ? W.hidden.filter(x => x !== k) : [...W.hidden, k]; markDirty(); drawList(); } }, icon(hidden ? 'eye-off' : 'eye', 15));
    const col = select<string>(COLORS.map(([value, label]) => ({ value, label })), W.colors[k] || '', v => { if (v) W.colors[k] = v; else delete W.colors[k]; markDirty(); drawList(); }, { width: 96, title: 'Menu item colour' });
    return h('div.cz-row', { class: [hidden ? 'hidden' : '', W.colors[k] ? 'changed' : ''].join(' '), 'data-color': W.colors[k] || '', style: { paddingLeft: 6 + depth * 16 + 'px' } }, h('span.cz-name', null, n.label), eye, h('span.cz-color', null, col));
  };
  // ---- summarize
  function summarize() {
    const esc = (s: string) => s.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]!));
    let html = `<!doctype html><meta charset="utf-8"><title>Pixora Shortcuts — ${esc(setName)}</title><style>body{font:13px system-ui;margin:24px}table{border-collapse:collapse;margin:8px 0 20px}td,th{border:1px solid #ccc;padding:3px 10px;text-align:left}th{background:#eee}</style><h1>${esc(setName)}</h1>`;
    for (const top of trees.app) {
      const rows = flat([top]).filter(n => eff(n.key!).length);
      if (!rows.length) continue;
      html += `<h2>${esc(top.label)}</h2><table><tr><th>Command</th><th>Shortcut</th></tr>${rows.map(n => `<tr><td>${esc(pathOf(n).replace(/^ › /, ''))}</td><td>${esc(eff(n.key!).join(', '))}</td></tr>`).join('')}</table>`;
    }
    html += `<h2>Tools</h2><table><tr><th>Tool</th><th>Shortcut</th></tr>${[...app.tools.values()].filter(t => toolEff(t.id)).map(t => `<tr><td>${esc(t.name)}</td><td>${toolEff(t.id)}</td></tr>`).join('')}</table>`;
    downloadBlob(new Blob([html], { type: 'text/html' }), `${setName}.htm`);
  }
  // ---- tabs
  const drawTabs = () => tabs.replaceChildren(...(['keys', 'menus'] as const).map(t => h('button.cz-tab', { type: 'button', class: t === tab ? 'on' : '', title: t === 'keys' ? 'Keyboard Shortcuts' : 'Menus', onclick: () => { tab = t; mode = 'app'; pending = null; capture = null; drawTabs(); drawHead(); drawList(); drawNote(); } }, t === 'keys' ? 'Keyboard Shortcuts' : 'Menus')));
  drawTabs(); drawHead(); drawList(); drawNote();
  const body = h('div.cz-body', null, tabs, head, h('div.cz-main', null, list, side), status, note);
  const dlg = openDialog({ title: 'Keyboard Shortcuts and Menus', body, width: 860, className: 'cz-dialog', buttons: [{ label: 'OK', primary: true, value: 'ok' }, { label: 'Cancel', value: null }] });
  const res = await dlg.result;
  window.removeEventListener('keydown', onKey, true);
  if (res !== 'ok' || !dirty) return;
  if (setName === DEFAULTS) { setName = 'Pixora Defaults (modified)'; }
  store.sets[setName] = clone(W); store.current = setName; save(); applyCustomization();
  toast(`Shortcuts and menus saved in “${setName}”.`, 'success');
}

registerCommands([
  { id: 'edit.keyboardShortcuts', label: 'Keyboard Shortcuts...', shortcut: 'Alt+Shift+Ctrl+K', run: () => customize('keys') },
  { id: 'edit.menus', label: 'Menus...', shortcut: 'Alt+Shift+Ctrl+M', run: () => customize('menus') },
]);
(window as any).__pxCustomize = { store, applyCustomization, activeSet, mkey, appTree };
