// Left toolbar: tool slots with flyouts, foreground/background colors, quick mask, screen mode.
import { h, clear } from './dom';
import { icon } from './icons';
import { events } from '../core/events';
import { app } from '../core/app';
import { runCommand, shortcutLabel } from '../core/commands';
import { toCss } from '../core/color';
import { hooks } from '../core/registry';
import { openMenu, type MenuEntry } from './menu';

/** Toolbar slots (top → bottom). Each tool declares `group` = one of these ids. */
export const TOOLBAR_LAYOUT: string[] = [
  'move', 'marquee', 'quick-select', 'object-select', 'crop', 'frame', 'eyedropper', 'heal', 'brush', 'stamp',
  'history-brush', 'eraser', 'gradient', 'blur', 'color-replace', 'dodge', 'pen', 'type', 'path-select', 'shape', 'hand', 'zoom',
];

let doubleColumn = localStorage.getItem('pixora.toolbar.double') === '1';
/** Extension point: extra entries for the "…" button (Edit › Toolbar puts the Extra Tools here). */
export const toolbarExtras: { items: (() => MenuEntry[]) | null } = { items: null };

export function createToolbar(): HTMLElement {
  const el = h('div.toolbar', { class: doubleColumn ? 'double' : '' });
  const head = h('div.toolbar-head', null, h('button.toolbar-toggle', { type: 'button', title: 'Toggle single/double column', onclick: () => {
    doubleColumn = !doubleColumn; localStorage.setItem('pixora.toolbar.double', doubleColumn ? '1' : '0');
    el.classList.toggle('double', doubleColumn);
  } }, icon('dbl-right', 11)));
  const grip = h('div.bar-grip.horizontal');
  const tools = h('div.toolbar-tools');
  const bottom = h('div.toolbar-bottom');
  el.append(head, grip, tools, bottom);

  const build = () => {
    clear(tools);
    for (const slot of TOOLBAR_LAYOUT) {
      const list = app.toolsInGroup(slot);
      if (!list.length) continue;
      const selId = app.groupSelection[slot];
      const cur = list.find(t => t.id === selId) || list[0];
      const active = app.activeTool && app.activeTool.group === slot;
      const shown = active ? app.activeTool! : cur;
      const b = h('button.tool-btn', { type: 'button', class: active ? 'active' : '', dataset: { slot }, title: '' }, icon(shown.icon, 20), list.length > 1 ? h('span.tool-flyout-mark') : null);
      b.addEventListener('mouseenter', () => showTip(b, shown.name, shown.shortcut));
      b.addEventListener('mouseleave', hideTip);
      let holdTimer = 0;
      b.addEventListener('pointerdown', e => {
        hideTip();
        if (e.button === 2) return;
        if (list.length > 1) holdTimer = window.setTimeout(() => { holdTimer = 0; flyout(slot, b); }, 380);
      });
      b.addEventListener('pointerup', () => {
        if (holdTimer) { clearTimeout(holdTimer); holdTimer = 0; }
      });
      b.addEventListener('click', e => {
        if (e.altKey && list.length > 1) { // Alt+click cycles
          const i = list.indexOf(shown);
          app.setTool(list[(i + 1) % list.length].id);
          return;
        }
        if (!document.querySelector('.menu.tool-flyout')) app.setTool(shown.id);
      });
      b.addEventListener('contextmenu', e => { e.preventDefault(); if (list.length > 1) flyout(slot, b); });
      tools.appendChild(b);
    }
    const more = h('button.tool-btn', { type: 'button', title: 'Edit Toolbar...' }, icon('more', 20), h('span.tool-flyout-mark'));
    more.addEventListener('click', () => {
      const extra = toolbarExtras.items?.() || [];
      const items: MenuEntry[] = [...extra, ...(extra.length ? ['-' as const] : []), { label: 'Edit Toolbar...', cmd: 'edit.toolbar' }];
      openMenu(items, more, { side: 'right' });
    });
    tools.appendChild(more);
  };

  // colors + modes
  const fg = h('button.color-chip.fg', { type: 'button', title: 'Set foreground color' });
  const bg = h('button.color-chip.bg', { type: 'button', title: 'Set background color' });
  const paintColors = () => { fg.style.background = toCss(app.fg); bg.style.background = toCss(app.bg); };
  fg.addEventListener('click', async () => { const c = await hooks.openColorPicker(app.fg, 'Color Picker (Foreground Color)'); if (c) app.setForeground(c); });
  bg.addEventListener('click', async () => { const c = await hooks.openColorPicker(app.bg, 'Color Picker (Background Color)'); if (c) app.setBackground(c); });
  const colors = h('div.toolbar-colors', null,
    h('button.mini-btn.default-colors', { type: 'button', title: 'Default Foreground and Background Colors (D)', onclick: () => app.resetColors() }, icon('default-colors', 14)),
    h('button.mini-btn.swap-colors', { type: 'button', title: 'Switch Foreground and Background Colors (X)', onclick: () => app.swapColors() }, icon('swap-colors', 14)),
    bg, fg);
  const qm = h('button.tool-btn.qm-btn', { type: 'button', title: 'Edit in Quick Mask Mode (Q)', onclick: () => runCommand('select.quickMask') }, icon('quick-mask', 20));
  const sm = h('button.tool-btn', { type: 'button', title: 'Change Screen Mode (F)' }, icon('screen-mode', 20), h('span.tool-flyout-mark'));
  sm.addEventListener('click', () => runCommand('view.screenModeCycle'));
  sm.addEventListener('contextmenu', e => {
    e.preventDefault();
    openMenu([
      { label: 'Standard Screen Mode', shortcut: 'F', radio: true, checked: app.screenMode === 'standard', cmd: 'view.screenMode', arg: 'standard' },
      { label: 'Full Screen Mode With Menu Bar', shortcut: 'F', radio: true, checked: app.screenMode === 'full-menu', cmd: 'view.screenMode', arg: 'full-menu' },
      { label: 'Full Screen Mode', shortcut: 'F', radio: true, checked: app.screenMode === 'full', cmd: 'view.screenMode', arg: 'full' },
    ], sm, { side: 'right' });
  });
  const place = h('button.tool-btn', { type: 'button', title: 'Place Image' }, icon('place-image', 20), h('span.tool-flyout-mark'));
  place.addEventListener('click', () => runCommand('file.placeEmbedded'));
  bottom.append(colors, qm, sm, place);
  const syncQm = () => qm.classList.toggle('active', !!app.activeDoc?.quickMask);

  events.on('tool', build);
  events.on('colors', paintColors);
  events.on('activeDoc', syncQm);
  events.on('selection', syncQm);
  events.on('layers', syncQm);
  (el as any).rebuild = build;
  build();
  paintColors();
  return el;
}

function flyout(slot: string, anchor: HTMLElement) {
  hideTip();
  const list = app.toolsInGroup(slot);
  const cur = app.activeTool?.group === slot ? app.activeTool : list.find(t => t.id === app.groupSelection[slot]) || list[0];
  const items: MenuEntry[] = list.map(t => ({ label: t.name, icon: t.icon, shortcut: t.shortcut, checked: false, action: () => app.setTool(t.id), extra: t === cur ? () => h('span.flyout-current') : undefined }));
  const m = openMenu(items, anchor, { side: 'right', className: 'tool-flyout', minWidth: 230 });
  // show icons in the check column
  m.querySelectorAll('.menu-item').forEach((row, i) => { row.classList.toggle('current', list[i] === cur); });
}

// ---------------------------------------------------------------- rich tooltips
let tip: HTMLElement | null = null;
let tipTimer = 0;
export function showTip(anchor: HTMLElement, name: string, shortcut?: string) {
  if (!app.prefs.showTooltips) return;
  clearTimeout(tipTimer);
  tipTimer = window.setTimeout(() => {
    hideTip();
    tip = h('div.rich-tip', null, h('span.rich-tip-name', null, name), shortcut ? h('span.rich-tip-key', null, `(${shortcutLabel(shortcut)})`) : null);
    document.body.appendChild(tip);
    const r = anchor.getBoundingClientRect();
    tip.style.left = r.right + 8 + 'px';
    tip.style.top = r.top + r.height / 2 - tip.offsetHeight / 2 + 'px';
  }, 450);
}
export function hideTip() { clearTimeout(tipTimer); tip?.remove(); tip = null; }
