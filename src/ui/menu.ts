// Popup menus (menu bar dropdowns, context menus, flyouts, dropdown lists).
import { h } from './dom';
import { icon } from './icons';
import { commands, isCommandChecked, isCommandEnabled, runCommand, shortcutLabel } from '../core/commands';

export interface MenuItem {
  label?: string;
  /** Command id to run (label/enabled/checked/shortcut fall back to the command). */
  cmd?: string;
  /** Argument passed to the command. */
  arg?: any;
  action?: () => void;
  shortcut?: string;
  checked?: boolean | (() => boolean);
  enabled?: boolean | (() => boolean);
  submenu?: MenuEntry[] | (() => MenuEntry[]);
  icon?: string;
  /** Radio style check (dot) instead of ✓. */
  radio?: boolean;
  /** Visually hidden when false. */
  visible?: boolean | (() => boolean);
  /** Separator (or use the string '-'). */
  separator?: boolean;
  /** Section header (non clickable). */
  header?: boolean;
  /** Extra element rendered on the right (e.g. color chip). */
  extra?: () => HTMLElement;
  /** Highlight colour name (Edit › Menus), rendered as data-color on the row. */
  color?: string;
}
export type MenuEntry = MenuItem | '-';

/** Extension point: rewrite a menu's items before they are shown (Edit › Menus / Keyboard Shortcuts customisation). */
export const menuHooks: { transform: ((items: MenuEntry[]) => MenuEntry[]) | null } = { transform: null };

const val = <T>(v: T | (() => T) | undefined, d: T): T => (v === undefined ? d : typeof v === 'function' ? (v as () => T)() : v);

let openStack: HTMLElement[] = [];
let onCloseAll: (() => void) | null = null;

export function closeMenus() {
  for (const m of openStack) m.remove();
  openStack = [];
  const cb = onCloseAll; onCloseAll = null;
  cb?.();
}

function isEnabled(it: MenuItem) {
  if (it.enabled !== undefined) return val(it.enabled, true);
  if (it.cmd) return isCommandEnabled(it.cmd);
  return !!(it.action || it.submenu);
}

function buildMenu(items: MenuEntry[], level: number): HTMLElement {
  if (menuHooks.transform) items = menuHooks.transform(items);
  const menu = h('div.menu', { role: 'menu', tabindex: -1 });
  let pendingSep = false, any = false;
  for (const raw of items) {
    if (raw === '-' || (raw as MenuItem).separator) { pendingSep = any; continue; }
    const it = raw as MenuItem;
    if (!val(it.visible, true)) continue;
    if (pendingSep) { menu.appendChild(h('div.menu-sep')); pendingSep = false; }
    any = true;
    if (it.header) { menu.appendChild(h('div.menu-header', null, it.label || '')); continue; }
    const cmd = it.cmd ? commands.get(it.cmd) : undefined;
    const label = it.label ?? cmd?.label ?? it.cmd ?? '';
    const sc = it.shortcut ?? (Array.isArray(cmd?.shortcut) ? cmd!.shortcut[0] : cmd?.shortcut);
    const checked = it.checked !== undefined ? val(it.checked, false) : it.cmd ? isCommandChecked(it.cmd, it.arg) : false;
    const enabled = isEnabled(it);
    const hasSub = !!it.submenu;
    const row = h('div.menu-item', { role: 'menuitem', class: [enabled ? '' : 'disabled', hasSub ? 'has-sub' : ''].join(' ') },
      h('span.menu-check', null, checked ? (it.radio ? h('span.menu-dot') : icon('check', 14)) : it.icon ? icon(it.icon, 14) : null),
      h('span.menu-label', null, label),
      it.extra ? it.extra() : null,
      h('span.menu-shortcut', null, sc ? shortcutLabel(sc) : ''),
      h('span.menu-arrow', null, hasSub ? icon('caret-right', 12) : null),
    );
    if (it.color) row.dataset.color = it.color;
    if (enabled) {
      if (hasSub) {
        let timer = 0;
        const open = () => {
          while (openStack.length > level + 1) openStack.pop()!.remove();
          if (openStack.length > level + 1) return;
          const sub = buildMenu(val(it.submenu as any, [] as MenuEntry[]), level + 1);
          showAt(sub, row.getBoundingClientRect(), 'right');
          row.classList.add('open');
        };
        row.addEventListener('pointerenter', () => { clearTimeout(timer); timer = window.setTimeout(open, 120); });
        row.addEventListener('pointerleave', () => clearTimeout(timer));
        row.addEventListener('click', e => { e.stopPropagation(); open(); });
      } else {
        row.addEventListener('pointerenter', () => { while (openStack.length > level + 1) openStack.pop()!.remove(); menu.querySelectorAll('.open').forEach(x => x.classList.remove('open')); });
        row.addEventListener('click', e => {
          e.stopPropagation();
          closeMenus();
          if (it.action) it.action();
          else if (it.cmd) runCommand(it.cmd, it.arg);
        });
      }
    } else row.addEventListener('pointerenter', () => { while (openStack.length > level + 1) openStack.pop()!.remove(); });
    menu.appendChild(row);
  }
  return menu;
}

function showAt(menu: HTMLElement, anchor: DOMRect | { left: number; top: number; right: number; bottom: number }, side: 'below' | 'right') {
  menu.style.visibility = 'hidden';
  document.body.appendChild(menu);
  openStack.push(menu);
  const r = menu.getBoundingClientRect(), vw = window.innerWidth, vh = window.innerHeight;
  let x: number, y: number;
  if (side === 'right') {
    x = anchor.right - 2; y = anchor.top - 5;
    if (x + r.width > vw) x = anchor.left - r.width + 2;
  } else {
    x = anchor.left; y = anchor.bottom;
    if (y + r.height > vh) y = Math.max(0, anchor.top - r.height);
  }
  if (y + r.height > vh) y = Math.max(0, vh - r.height - 2);
  x = Math.max(0, Math.min(x, vw - r.width - 2));
  menu.style.left = x + 'px'; menu.style.top = y + 'px';
  menu.style.visibility = '';
}

/** Open a popup menu. anchor = element/DOMRect (menu below it) or a point {x, y}. */
export function openMenu(items: MenuEntry[], anchor: Element | DOMRect | { x: number; y: number }, opts: { onClose?: () => void; side?: 'below' | 'right'; minWidth?: number; className?: string } = {}) {
  closeMenus();
  const menu = buildMenu(items, 0);
  if (opts.minWidth) menu.style.minWidth = opts.minWidth + 'px';
  if (opts.className) menu.classList.add(opts.className);
  let rect: any;
  if (anchor instanceof Element) rect = anchor.getBoundingClientRect();
  else if ('x' in anchor && !('left' in anchor)) rect = { left: anchor.x, right: anchor.x, top: anchor.y, bottom: anchor.y };
  else rect = anchor;
  showAt(menu, rect, opts.side || 'below');
  onCloseAll = opts.onClose || null;
  return menu;
}
export function contextMenu(e: MouseEvent, items: MenuEntry[]) {
  e.preventDefault();
  openMenu(items, { x: e.clientX, y: e.clientY });
}

// global dismissal
window.addEventListener('pointerdown', e => {
  if (!openStack.length) return;
  const t = e.target as Element;
  if (openStack.some(m => m.contains(t))) return;
  if (t.closest?.('[data-menu-anchor]')) return; // anchors handle toggling themselves
  closeMenus();
}, true);
window.addEventListener('keydown', e => {
  if (!openStack.length) return;
  const menu = openStack[openStack.length - 1];
  const items = [...menu.querySelectorAll<HTMLElement>('.menu-item:not(.disabled)')];
  const cur = menu.querySelector<HTMLElement>('.menu-item.kbd');
  let i = cur ? items.indexOf(cur) : -1;
  if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); if (openStack.length > 1) openStack.pop()!.remove(); else closeMenus(); return; }
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault(); e.stopPropagation();
    i = e.key === 'ArrowDown' ? (i + 1) % items.length : (i - 1 + items.length) % items.length;
    cur?.classList.remove('kbd');
    items[i]?.classList.add('kbd');
    items[i]?.scrollIntoView({ block: 'nearest' });
    return;
  }
  if (e.key === 'Enter' || e.key === 'ArrowRight') {
    if (cur) { e.preventDefault(); e.stopPropagation(); if (e.key === 'Enter' || cur.classList.contains('has-sub')) cur.click(); }
    return;
  }
  if (e.key === 'ArrowLeft' && openStack.length > 1) { e.preventDefault(); e.stopPropagation(); openStack.pop()!.remove(); }
}, true);
window.addEventListener('blur', () => closeMenus());
