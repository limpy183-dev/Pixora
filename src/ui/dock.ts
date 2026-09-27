// Panel dock: columns of tabbed panel groups (expanded or iconic), flyouts, floating panels,
// drag & drop of tabs, resizable groups/columns and saved workspaces.
import { h, dragPointer, clear } from './dom';
import { icon } from './icons';
import { openMenu, type MenuEntry } from './menu';
import { panelDefs, type PanelHooks } from './panels';
import { events } from '../core/events';
import { saveJSON } from '../core/app';

export interface DockGroup { id: string; panels: string[]; active: string; height?: number; minimized?: boolean }
export interface DockColumn { id: string; iconic: boolean; width: number; groups: DockGroup[]; labels?: boolean }
export interface DockFloat { id: string; group: DockGroup; x: number; y: number; w: number; h: number }
export interface DockLayout { columns: DockColumn[]; floats: DockFloat[] }

let uid = 0;
const gid = () => `g${++uid}${Math.random().toString(36).slice(2, 6)}`;
const grp = (panels: string[], height?: number, active = panels[0]): DockGroup => ({ id: gid(), panels, active, height });

/** Built-in workspaces. Other modules may add entries before initDock(). */
export const WORKSPACES: Record<string, () => DockLayout> = {
  Essentials: () => ({
    columns: [
      { id: 'c-icons', iconic: true, width: 46, groups: [grp(['actions', 'history'])] },
      { id: 'c-main', iconic: false, width: 432, groups: [grp(['color', 'swatches', 'gradients', 'patterns'], 165), grp(['properties', 'adjustments', 'libraries'], 305), grp(['layers', 'channels', 'paths'])] },
    ], floats: [],
  }),
  Painting: () => ({
    columns: [
      { id: 'c-icons', iconic: true, width: 46, groups: [grp(['brush-settings', 'brushes']), grp(['clone-source']), grp(['history'])] },
      { id: 'c-main', iconic: false, width: 400, groups: [grp(['color', 'swatches'], 230), grp(['brushes', 'brush-settings'], 300), grp(['layers', 'channels', 'paths'])] },
    ], floats: [],
  }),
  Photography: () => ({
    columns: [
      { id: 'c-icons', iconic: true, width: 46, groups: [grp(['history', 'actions']), grp(['info'])] },
      { id: 'c-main', iconic: false, width: 400, groups: [grp(['histogram', 'navigator'], 200), grp(['adjustments', 'properties', 'libraries'], 330), grp(['layers', 'channels', 'paths'])] },
    ], floats: [],
  }),
  'Graphic and Web': () => ({
    columns: [
      { id: 'c-icons', iconic: true, width: 46, groups: [grp(['character', 'paragraph', 'glyphs']), grp(['history'])] },
      { id: 'c-main', iconic: false, width: 400, groups: [grp(['properties', 'libraries'], 280), grp(['color', 'swatches', 'gradients'], 220), grp(['layers', 'channels', 'paths'])] },
    ], floats: [],
  }),
  Motion: () => ({
    columns: [
      { id: 'c-icons', iconic: true, width: 46, groups: [grp(['history', 'actions']), grp(['clone-source'])] },
      { id: 'c-main', iconic: false, width: 400, groups: [grp(['properties', 'adjustments'], 300), grp(['color', 'swatches'], 200), grp(['layers', 'channels', 'paths'])] },
    ], floats: [],
  }),
};

interface Instance { el: HTMLElement; hooks: PanelHooks | null; shown: boolean }
const instances = new Map<string, Instance>();
let root: HTMLElement;
let floatHost: HTMLElement;
let layout: DockLayout;
let workspaceName = 'Essentials';
let flyout: { el: HTMLElement; group: DockGroup; btn: HTMLElement } | null = null;
let hiddenAll = false;
let floatZ = 50;

export const dockState = {
  get workspace() { return workspaceName; },
  get layout() { return layout; },
};

// ------------------------------------------------------------------ persistence
function persist() {
  saveJSON('pixora.dock.workspace', workspaceName);
  saveJSON(`pixora.dock.layout.${workspaceName}`, layout);
  events.emit('panels');
}
function loadLayout(name: string): DockLayout {
  try {
    const raw = localStorage.getItem(`pixora.dock.layout.${name}`);
    if (raw) {
      const l = JSON.parse(raw) as DockLayout;
      if (l && Array.isArray(l.columns)) return l;
    }
  } catch { /* ignore */ }
  return (WORKSPACES[name] || WORKSPACES.Essentials)();
}

// ------------------------------------------------------------------ panel instances
function instance(id: string): Instance | null {
  let inst = instances.get(id);
  if (inst) return inst;
  const def = panelDefs.get(id);
  if (!def) return null;
  const el = h('div.panel', { dataset: { panel: id } });
  inst = { el, hooks: null, shown: false };
  instances.set(id, inst);
  try { inst.hooks = def.create(el) || null; } catch (err) { console.error(`[panel ${id}]`, err); el.textContent = 'Panel failed to load.'; }
  return inst;
}
function setShown(id: string, shown: boolean) {
  const inst = instances.get(id);
  if (!inst || inst.shown === shown) return;
  inst.shown = shown;
  inst.el.style.display = shown ? '' : 'none';
  try { shown ? inst.hooks?.onShow?.() : inst.hooks?.onHide?.(); } catch (err) { console.error(err); }
}
/** Is the panel's content currently visible? */
export function isPanelVisible(id: string): boolean { return !!instances.get(id)?.shown && !hiddenAll; }
/** Is the panel open somewhere in the workspace (possibly behind another tab or iconic)? */
export function isPanelOpen(id: string): boolean { return !!findGroup(id); }

function findGroup(id: string): { group: DockGroup; column?: DockColumn; float?: DockFloat } | null {
  for (const c of layout.columns) for (const g of c.groups) if (g.panels.includes(id)) return { group: g, column: c };
  for (const f of layout.floats) if (f.group.panels.includes(id)) return { group: f.group, float: f };
  return null;
}
function prune() {
  for (const c of layout.columns) {
    for (const g of c.groups) { g.panels = g.panels.filter(p => panelDefs.has(p)); if (!g.panels.includes(g.active)) g.active = g.panels[0]; }
    c.groups = c.groups.filter(g => g.panels.length);
  }
  layout.columns = layout.columns.filter(c => c.groups.length || !c.iconic);
  layout.floats = layout.floats.filter(f => { f.group.panels = f.group.panels.filter(p => panelDefs.has(p)); if (!f.group.panels.includes(f.group.active)) f.group.active = f.group.panels[0]; return f.group.panels.length; });
}

// ------------------------------------------------------------------ rendering
export function initDock(el: HTMLElement) {
  root = el;
  floatHost = h('div.float-host');
  document.body.appendChild(floatHost);
  try { workspaceName = JSON.parse(localStorage.getItem('pixora.dock.workspace') || '"Essentials"') || 'Essentials'; } catch { workspaceName = 'Essentials'; }
  if (!WORKSPACES[workspaceName] && !localStorage.getItem(`pixora.dock.layout.${workspaceName}`)) workspaceName = 'Essentials';
  layout = loadLayout(workspaceName);
  render();
  window.addEventListener('resize', () => { closeFlyout(); render(); });
  window.addEventListener('pointerdown', e => {
    if (!flyout) return;
    const t = e.target as Element;
    if (flyout.el.contains(t) || flyout.btn.contains(t) || t.closest('.menu, .popover, .dialog-overlay')) return;
    closeFlyout();
  }, true);
}

export function render() {
  prune();
  const visibleNow = new Set<string>();
  clear(root);
  root.classList.toggle('hidden', hiddenAll);
  for (const col of layout.columns) root.appendChild(col.iconic ? renderIconic(col) : renderColumn(col, visibleNow));
  clear(floatHost);
  for (const f of layout.floats) floatHost.appendChild(renderFloat(f, visibleNow));
  if (flyout) {
    const still = layout.columns.some(c => c.iconic && c.groups.includes(flyout!.group));
    if (still) visibleNow.add(flyout.group.active); else closeFlyout();
  }
  for (const [id] of instances) setShown(id, visibleNow.has(id));
}

function renderColumn(col: DockColumn, visible: Set<string>): HTMLElement {
  const el = h('div.dock-col', { style: { width: col.width + 'px' }, dataset: { col: col.id } });
  const head = h('div.dock-col-head', null,
    h('button.dock-collapse', { type: 'button', title: 'Collapse to Icons', onclick: () => { col.iconic = true; col.labels = true; persist(); render(); } }, icon('dbl-right', 12)));
  el.appendChild(head);
  // width resize handle
  const rz = h('div.dock-col-resize');
  rz.addEventListener('pointerdown', e => {
    e.preventDefault();
    const w0 = col.width;
    dragPointer(e, dx => { col.width = Math.max(220, Math.min(700, w0 - dx)); el.style.width = col.width + 'px'; notifyResize(col); }, () => { persist(); window.dispatchEvent(new Event('resize')); });
  });
  el.appendChild(rz);
  col.groups.forEach((g, i) => {
    const last = i === col.groups.length - 1;
    const gEl = renderGroup(g, visible, { column: col });
    if (g.minimized) gEl.classList.add('minimized');
    else if (!last && g.height) { gEl.style.height = g.height + 'px'; gEl.style.flex = '0 0 auto'; }
    else gEl.style.flex = '1 1 0';
    el.appendChild(gEl);
    if (!last) el.appendChild(splitter(col, i, gEl));
  });
  return el;
}

function splitter(col: DockColumn, i: number, above: HTMLElement): HTMLElement {
  const s = h('div.dock-splitter', { dataset: { col: col.id, index: String(i + 1) } });
  s.addEventListener('pointerdown', e => {
    e.preventDefault();
    const g = col.groups[i];
    const h0 = above.getBoundingClientRect().height;
    g.minimized = false;
    dragPointer(e, (_dx, dy) => {
      g.height = Math.max(60, Math.min(window.innerHeight - 200, h0 + dy));
      above.style.height = g.height + 'px'; above.style.flex = '0 0 auto';
      notifyResize(col);
    }, () => persist());
  });
  return s;
}
function notifyResize(col: DockColumn) {
  for (const g of col.groups) instances.get(g.active)?.hooks?.onResize?.();
}

function renderGroup(g: DockGroup, visible: Set<string>, ctx: { column?: DockColumn; float?: DockFloat }): HTMLElement {
  const tabs = h('div.dock-tabs', { dataset: { group: g.id } });
  for (const pid of g.panels) {
    const def = panelDefs.get(pid)!;
    const tab = h('div.dock-tab', { class: pid === g.active ? 'active' : '', dataset: { panel: pid } }, def.title);
    tab.addEventListener('pointerdown', e => {
      if (e.button !== 0) return;
      startTabDrag(e, pid, g, () => {
        if (g.active !== pid || g.minimized) { g.active = pid; g.minimized = false; persist(); render(); }
      });
    });
    tab.addEventListener('dblclick', () => { g.minimized = !g.minimized; persist(); render(); });
    tabs.appendChild(tab);
  }
  const spacer = h('div.dock-tabs-space');
  spacer.addEventListener('dblclick', () => { g.minimized = !g.minimized; persist(); render(); });
  spacer.addEventListener('pointerdown', e => {
    if (e.button !== 0) return;
    if (ctx.float) moveFloat(e, ctx.float);
    else startGroupDrag(e, g);
  });
  tabs.appendChild(spacer);
  tabs.appendChild(h('button.dock-menu', { type: 'button', title: 'Panel menu', 'data-menu-anchor': '', onclick: (e: MouseEvent) => panelMenu(g.active, g, e.currentTarget as HTMLElement) }, icon('menu', 14)));
  const body = h('div.dock-body');
  const inst = instance(g.active);
  if (inst && !g.minimized) { body.appendChild(inst.el); visible.add(g.active); }
  return h('div.dock-group', { dataset: { group: g.id } }, tabs, body);
}

function renderIconic(col: DockColumn): HTMLElement {
  const el = h('div.dock-col.iconic', { class: col.labels ? 'labels' : '', dataset: { col: col.id } });
  if (col.labels) el.style.width = Math.max(46, col.width > 200 ? 150 : col.width) + 'px';
  el.appendChild(h('div.dock-col-head', null,
    h('button.dock-collapse', { type: 'button', title: 'Expand Panels', onclick: () => { col.iconic = false; if (col.width < 220) col.width = 300; closeFlyout(); persist(); render(); } }, icon('dbl-left', 12))));
  for (const g of col.groups) {
    const box = h('div.icon-group', { dataset: { group: g.id } }, h('div.icon-grip'));
    box.querySelector('.icon-grip')!.addEventListener('pointerdown', e => startGroupDrag(e as PointerEvent, g));
    for (const pid of g.panels) {
      const def = panelDefs.get(pid)!;
      const b = h('button.icon-panel-btn', { type: 'button', title: def.title, class: flyout?.group === g && g.active === pid ? 'active' : '' }, icon(def.icon, 20), col.labels ? h('span.icon-panel-label', null, def.title) : null);
      b.addEventListener('pointerdown', e => {
        if (e.button !== 0) return;
        startTabDrag(e, pid, g, () => {
          if (flyout && flyout.group === g && g.active === pid) { closeFlyout(); return; }
          g.active = pid;
          openFlyout(g, b);
        });
      });
      box.appendChild(b);
    }
    el.appendChild(box);
  }
  return el;
}

function openFlyout(g: DockGroup, btn: HTMLElement) {
  closeFlyout();
  const def = panelDefs.get(g.active)!;
  const visible = new Set<string>();
  const gEl = renderGroup(g, visible, {});
  const fl = h('div.dock-flyout', null, gEl);
  const w = def.preferredWidth ?? 300, hgt = Math.min(window.innerHeight - 80, def.defaultHeight ?? 420);
  const colEl = btn.closest('.dock-col') as HTMLElement;
  const r = colEl.getBoundingClientRect(), br = btn.getBoundingClientRect();
  fl.style.width = w + 'px';
  fl.style.height = hgt + 'px';
  fl.style.left = r.left - w + 'px';
  fl.style.top = Math.max(r.top, Math.min(br.top - 36, window.innerHeight - hgt - 8)) + 'px';
  document.body.appendChild(fl);
  flyout = { el: fl, group: g, btn };
  document.querySelectorAll('.icon-panel-btn.active').forEach(x => x.classList.remove('active'));
  btn.classList.add('active');
  for (const [id] of instances) if (visible.has(id)) setShown(id, true);
}
export function closeFlyout() {
  if (!flyout) return;
  const g = flyout.group;
  flyout.el.remove();
  flyout.btn.classList.remove('active');
  flyout = null;
  for (const p of g.panels) setShown(p, false);
}

function renderFloat(f: DockFloat, visible: Set<string>): HTMLElement {
  const gEl = renderGroup(f.group, visible, { float: f });
  const el = h('div.float-panel', { style: { left: f.x + 'px', top: f.y + 'px', width: f.w + 'px', height: f.group.minimized ? 'auto' : f.h + 'px', zIndex: String(floatZ) } },
    h('div.float-head', null, h('button.float-close', { type: 'button', title: 'Close', onclick: () => { layout.floats = layout.floats.filter(x => x !== f); persist(); render(); } }, icon('close', 10))),
    gEl, h('div.float-resize'));
  el.querySelector('.float-head')!.addEventListener('pointerdown', e => { if (!(e.target as Element).closest('button')) moveFloat(e as PointerEvent, f); });
  el.addEventListener('pointerdown', () => { el.style.zIndex = String(++floatZ); });
  el.querySelector('.float-resize')!.addEventListener('pointerdown', e => {
    const pe = e as PointerEvent; pe.preventDefault(); pe.stopPropagation();
    const w0 = f.w, h0 = f.h;
    dragPointer(pe, (dx, dy) => { f.w = Math.max(200, w0 + dx); f.h = Math.max(120, h0 + dy); el.style.width = f.w + 'px'; el.style.height = f.h + 'px'; instances.get(f.group.active)?.hooks?.onResize?.(); }, () => persist());
  });
  return el;
}
function moveFloat(e: PointerEvent, f: DockFloat) {
  e.preventDefault();
  const x0 = f.x, y0 = f.y;
  const el = (e.target as Element).closest('.float-panel') as HTMLElement;
  dragPointer(e, (dx, dy) => {
    f.x = Math.max(0, Math.min(window.innerWidth - 60, x0 + dx)); f.y = Math.max(0, Math.min(window.innerHeight - 30, y0 + dy));
    el.style.left = f.x + 'px'; el.style.top = f.y + 'px';
  }, () => persist());
}

// ------------------------------------------------------------------ drag & drop
function removePanelFromLayout(pid: string) {
  const loc = findGroup(pid);
  if (!loc) return;
  loc.group.panels = loc.group.panels.filter(p => p !== pid);
  if (loc.group.active === pid) loc.group.active = loc.group.panels[0];
}
function startTabDrag(e: PointerEvent, pid: string, g: DockGroup, click: () => void) {
  const sx = e.clientX, sy = e.clientY;
  let ghost: HTMLElement | null = null, hint: HTMLElement | null = null;
  const def = panelDefs.get(pid)!;
  const move = (ev: PointerEvent) => {
    if (!ghost && Math.hypot(ev.clientX - sx, ev.clientY - sy) < 6) return;
    if (!ghost) { ghost = h('div.dock-ghost', null, def.title); document.body.appendChild(ghost); closeFlyout(); }
    ghost.style.left = ev.clientX + 8 + 'px'; ghost.style.top = ev.clientY + 8 + 'px';
    const t = dropTarget(ev);
    hint?.remove(); hint = null;
    if (t?.rect) { hint = h('div.dock-drop-hint'); Object.assign(hint.style, { left: t.rect.left + 'px', top: t.rect.top + 'px', width: t.rect.width + 'px', height: t.rect.height + 'px' }); document.body.appendChild(hint); }
  };
  const up = (ev: PointerEvent) => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    hint?.remove();
    if (!ghost) { click(); return; }
    ghost.remove();
    const t = dropTarget(ev);
    if (t?.group === g && g.panels.length === 1) return;
    removePanelFromLayout(pid);
    applyDrop(t, { id: gid(), panels: [pid], active: pid }, ev, pid);
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
}
function startGroupDrag(e: PointerEvent, g: DockGroup) {
  const sx = e.clientX, sy = e.clientY;
  let ghost: HTMLElement | null = null, hint: HTMLElement | null = null;
  const move = (ev: PointerEvent) => {
    if (!ghost && Math.hypot(ev.clientX - sx, ev.clientY - sy) < 6) return;
    if (!ghost) { ghost = h('div.dock-ghost', null, g.panels.map(p => panelDefs.get(p)?.title).join(' · ')); document.body.appendChild(ghost); closeFlyout(); }
    ghost.style.left = ev.clientX + 8 + 'px'; ghost.style.top = ev.clientY + 8 + 'px';
    const t = dropTarget(ev);
    hint?.remove(); hint = null;
    if (t?.rect && t.group !== g) { hint = h('div.dock-drop-hint'); Object.assign(hint.style, { left: t.rect.left + 'px', top: t.rect.top + 'px', width: t.rect.width + 'px', height: t.rect.height + 'px' }); document.body.appendChild(hint); }
  };
  const up = (ev: PointerEvent) => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    hint?.remove();
    if (!ghost) return;
    ghost.remove();
    const t = dropTarget(ev);
    if (t?.group === g) return;
    for (const c of layout.columns) c.groups = c.groups.filter(x => x !== g);
    layout.floats = layout.floats.filter(f => f.group !== g);
    applyDrop(t, g, ev, g.active);
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
}

interface DropTarget { kind: 'tabs' | 'split' | 'icons' | 'float'; group?: DockGroup; column?: DockColumn; index?: number; rect?: DOMRect }
function dropTarget(ev: PointerEvent): DropTarget | null {
  const el = document.elementFromPoint(ev.clientX, ev.clientY) as Element | null;
  if (!el) return { kind: 'float' };
  const tabs = el.closest('.dock-tabs') as HTMLElement | null;
  if (tabs) {
    const g = allGroups().find(x => x.id === tabs.dataset.group);
    if (g) return { kind: 'tabs', group: g, rect: tabs.getBoundingClientRect() };
  }
  const sp = el.closest('.dock-splitter') as HTMLElement | null;
  if (sp) {
    const col = layout.columns.find(c => c.id === sp.dataset.col);
    if (col) { const r = sp.getBoundingClientRect(); return { kind: 'split', column: col, index: +sp.dataset.index!, rect: new DOMRect(r.left, r.top - 3, r.width, 10) }; }
  }
  const ig = el.closest('.icon-group') as HTMLElement | null;
  if (ig) {
    const g = allGroups().find(x => x.id === ig.dataset.group);
    if (g) return { kind: 'tabs', group: g, rect: ig.getBoundingClientRect() };
  }
  const colEl = el.closest('.dock-col') as HTMLElement | null;
  if (colEl) {
    const col = layout.columns.find(c => c.id === colEl.dataset.col);
    if (col) {
      const r = colEl.getBoundingClientRect();
      return col.iconic ? { kind: 'icons', column: col, rect: new DOMRect(r.left, r.bottom - 40, r.width, 40) } : { kind: 'split', column: col, index: col.groups.length, rect: new DOMRect(r.left, r.bottom - 12, r.width, 12) };
    }
  }
  return { kind: 'float' };
}
function allGroups(): DockGroup[] { return [...layout.columns.flatMap(c => c.groups), ...layout.floats.map(f => f.group)]; }

function applyDrop(t: DropTarget | null, g: DockGroup, ev: PointerEvent, activate: string) {
  if (t?.kind === 'tabs' && t.group) {
    for (const p of g.panels) if (!t.group.panels.includes(p)) t.group.panels.push(p);
    t.group.active = activate;
    t.group.minimized = false;
  } else if (t?.kind === 'split' && t.column) {
    g.height = g.height || 250;
    t.column.groups.splice(t.index ?? t.column.groups.length, 0, g);
  } else if (t?.kind === 'icons' && t.column) {
    t.column.groups.push(g);
  } else {
    const def = panelDefs.get(activate);
    layout.floats.push({ id: gid(), group: g, x: Math.max(0, ev.clientX - 40), y: Math.max(0, ev.clientY - 10), w: def?.preferredWidth ?? 300, h: def?.defaultHeight ?? 360 });
  }
  persist();
  render();
}

// ------------------------------------------------------------------ menus / API
function panelMenu(pid: string, g: DockGroup, anchor: HTMLElement) {
  const def = panelDefs.get(pid);
  const items: MenuEntry[] = [...(def?.menu?.() || [])];
  if (items.length) items.push('-');
  items.push({ label: 'Close', action: () => hidePanel(pid) }, { label: 'Close Tab Group', action: () => { for (const p of [...g.panels]) removePanelFromLayout(p); persist(); render(); } });
  openMenu(items, anchor, { minWidth: 180 });
}

/** Show a panel (activate its tab, open its flyout, or float it if closed). */
export function showPanel(id: string) {
  if (!panelDefs.has(id)) return;
  if (hiddenAll) { hiddenAll = false; }
  const loc = findGroup(id);
  if (loc) {
    loc.group.active = id;
    loc.group.minimized = false;
    if (loc.column?.iconic) {
      render();
      const btn = [...root.querySelectorAll<HTMLElement>('.icon-group')].find(x => x.dataset.group === loc.group.id)?.querySelectorAll<HTMLElement>('.icon-panel-btn')[loc.group.panels.indexOf(id)];
      if (btn) openFlyout(loc.group, btn);
      persist();
      return;
    }
  } else {
    const def = panelDefs.get(id)!;
    const n = layout.floats.length;
    layout.floats.push({ id: gid(), group: { id: gid(), panels: [id], active: id }, x: Math.max(60, window.innerWidth - 480 - (def.preferredWidth ?? 300) - n * 24), y: 140 + n * 24, w: def.preferredWidth ?? 300, h: def.defaultHeight ?? 360 });
  }
  persist();
  render();
}
export function hidePanel(id: string) {
  if (flyout?.group.panels.includes(id)) closeFlyout();
  removePanelFromLayout(id);
  persist();
  render();
}
export function togglePanel(id: string) { if (isPanelVisible(id)) hidePanel(id); else showPanel(id); }
/** Tab key: hide/show all panels (and toolbar/options bar – handled by the shell). */
export function setPanelsHidden(v: boolean) { hiddenAll = v; closeFlyout(); render(); window.dispatchEvent(new Event('resize')); }
export function setWorkspace(name: string, reset = false) {
  closeFlyout();
  saveJSON(`pixora.dock.layout.${workspaceName}`, layout);
  workspaceName = name;
  layout = reset ? (WORKSPACES[name] || WORKSPACES.Essentials)() : loadLayout(name);
  persist();
  render();
  window.dispatchEvent(new Event('resize'));
}
export function resetWorkspace() { setWorkspace(workspaceName, true); }
export function saveWorkspaceAs(name: string) {
  const copy = JSON.parse(JSON.stringify(layout));
  WORKSPACES[name] = () => JSON.parse(JSON.stringify(copy));
  const custom = JSON.parse(localStorage.getItem('pixora.dock.custom') || '[]') as string[];
  if (!custom.includes(name)) custom.push(name);
  saveJSON('pixora.dock.custom', custom);
  workspaceName = name;
  persist();
}
export function customWorkspaces(): string[] {
  try { return JSON.parse(localStorage.getItem('pixora.dock.custom') || '[]'); } catch { return []; }
}
export function deleteWorkspace(name: string) {
  const custom = customWorkspaces().filter(n => n !== name);
  saveJSON('pixora.dock.custom', custom);
  localStorage.removeItem(`pixora.dock.layout.${name}`);
  delete WORKSPACES[name];
  if (workspaceName === name) setWorkspace('Essentials', true);
}
// custom workspaces are restorable from their saved layout
for (const n of customWorkspaces()) if (!WORKSPACES[n]) WORKSPACES[n] = () => loadLayout(n);
