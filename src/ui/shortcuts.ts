// Global keyboard handling: menu/command shortcuts, tool letters, spring-loaded tools, brush size, opacity digits.
import { app } from '../core/app';
import { commands, eventShortcut, normShortcut, registerShortcut, runCommand, shortcutMap } from '../core/commands';
import { buildMenus } from './menus-def';
import type { MenuEntry, MenuItem } from './menu';
import { isTyping } from './dom';
import { isDialogOpen } from './dialog';
import { NO_CTRL_MOVE } from '../core/viewport';
import { events } from '../core/events';

let built = false;
/** (Re)build the shortcut table from menus + command.shortcut fields. */
export function buildShortcutMap() {
  shortcutMap.clear();
  const walk = (items: MenuEntry[]) => {
    for (const it of items) {
      if (it === '-') continue;
      const m = it as MenuItem;
      if (m.shortcut && m.cmd) registerShortcut(m.shortcut, m.cmd, m.arg);
      if (m.submenu) { try { walk(typeof m.submenu === 'function' ? m.submenu() : m.submenu); } catch { /* dynamic */ } }
    }
  };
  for (const m of buildMenus()) { try { walk(m.items()); } catch (err) { console.error(err); } }
  for (const c of commands.values()) {
    const list = Array.isArray(c.shortcut) ? c.shortcut : c.shortcut ? [c.shortcut] : [];
    for (const s of list) if (!shortcutMap.has(normShortcut(s))) registerShortcut(s, c.id);
  }
  built = true;
}

let digitTimer = 0, lastDigit = '';

function toolLetter(e: KeyboardEvent): boolean {
  if (e.ctrlKey || e.metaKey || e.altKey) return false;
  if (!/^Key[A-Z]$/.test(e.code)) return false;
  const letter = e.code.slice(3);
  const tools = [...app.tools.values()].filter(t => t.shortcut === letter);
  if (!tools.length) return false;
  const cur = app.activeTool;
  if (e.shiftKey && cur && cur.shortcut === letter) {
    // Shift+letter cycles the tools sharing this letter within the current slot first
    const same = tools.filter(t => t.group === cur.group);
    const list = same.length > 1 ? same : tools;
    const i = list.indexOf(cur);
    app.setTool(list[(i + 1) % list.length].id);
    return true;
  }
  if (e.shiftKey) return false;
  if (cur && cur.shortcut === letter) return true;
  // prefer the last used tool of a slot that has this letter
  const slots = [...new Set(tools.map(t => t.group))];
  const pick = tools.find(t => app.groupSelection[t.group] === t.id && slots.includes(t.group)) || tools.sort((a, b) => (a.order ?? 0) - (b.order ?? 0))[0];
  app.setTool(pick.id);
  return true;
}

function spring(id: string | null) {
  const t = id ? app.getTool(id) : null;
  if (app.springTool === t) return;
  if (!t && app.viewport?.pointer.down) { app.springReleasePending = true; return; }
  app.springTool = t;
  app.springReleasePending = false;
  app.viewport?.updateCursor();
  app.activeDoc?.redrawOverlay();
  events.emit('tool');
}

function adjustSize(dir: number, hardness: boolean) {
  const s = app.activeTool?.settings;
  if (!s) return;
  if (hardness && 'hardness' in s) {
    s.hardness = Math.max(0, Math.min(1, Math.round((s.hardness + dir * 0.25) * 4) / 4));
  } else if ('size' in s) {
    const v = s.size as number;
    const step = v < 10 ? 1 : v < 50 ? 5 : v < 100 ? 10 : v < 200 ? 25 : v < 300 ? 50 : 100;
    s.size = Math.max(1, Math.min(5000, dir > 0 ? v + step : v - (v <= 10 ? 1 : step)));
  } else return;
  app.saveToolSettings();
  app.activeDoc?.redrawOverlay();
}

function digit(e: KeyboardEvent): boolean {
  if (e.ctrlKey || e.metaKey || e.altKey || !/^Digit\d$/.test(e.code)) return false;
  const d = e.code.slice(5);
  const now = lastDigit && digitTimer ? lastDigit + d : '';
  clearTimeout(digitTimer);
  let pct: number;
  if (now) { pct = parseInt(now, 10); lastDigit = ''; digitTimer = 0; }
  else { pct = d === '0' ? 100 : parseInt(d, 10) * 10; lastDigit = d; digitTimer = window.setTimeout(() => { lastDigit = ''; digitTimer = 0; }, 600); }
  const t = app.activeTool, s = t?.settings;
  const key = e.shiftKey ? 'flow' : 'opacity';
  if (s && key in s && t?.paints) {
    s[key] = s[key] > 1 ? pct : pct / 100;     // settings may store 0..1 or 0..100
    app.saveToolSettings();
    return true;
  }
  const doc = app.activeDoc, layer = doc?.activeLayer;
  if (doc && layer && !e.shiftKey && !layer.isBackground) {
    doc.history.transaction('Opacity Change', () => { layer.opacity = pct / 100; });
    doc.layersChanged();
    return true;
  }
  return false;
}

export function initShortcuts() {
  window.addEventListener('keydown', e => {
    if (!built) buildShortcutMap();
    if (isDialogOpen()) return;
    const typing = isTyping();
    const tool = app.activeTool, doc = app.activeDoc;

    // tool gets first chance (text editing, transform, crop, nudging...)
    if (!typing && tool?.keyDown) {
      try { if (tool.keyDown(e, doc)) { e.preventDefault(); return; } } catch (err) { console.error(err); }
    }
    if (typing) return;

    // modal tools
    if (tool?.isModal?.()) {
      if (e.key === 'Enter') { e.preventDefault(); tool.commit?.(); doc?.invalidate(); return; }
      if (e.key === 'Escape') { e.preventDefault(); tool.cancel?.(); doc?.invalidate(); return; }
    }

    // spring-loaded tools
    if (e.code === 'Space' && !e.repeat) {
      e.preventDefault();
      spring(e.ctrlKey || e.metaKey ? 'zoom' : e.altKey ? 'zoom' : 'hand');
      return;
    }
    if (e.code === 'Space') { e.preventDefault(); return; }
    if ((e.key === 'Alt') && !e.repeat && tool?.altEyedropper) { e.preventDefault(); spring('eyedropper'); return; }
    if ((e.key === 'Control' || e.key === 'Meta') && !e.repeat && tool && !NO_CTRL_MOVE.has(tool.id) && !tool.noCtrlMove && !tool.isModal?.()) { spring('move'); }
    if (e.key === 'Alt') e.preventDefault(); // keep browser menu from stealing focus

    const combo = eventShortcut(e);
    const hit = shortcutMap.get(combo);
    if (hit) {
      e.preventDefault();
      runCommand(hit.id, hit.arg);
      return;
    }
    // built-in single keys
    if (!e.ctrlKey && !e.metaKey && !e.altKey) {
      switch (e.code) {
        case 'KeyD': if (!e.shiftKey) { app.resetColors(); e.preventDefault(); return; } break;
        case 'KeyX': if (!e.shiftKey) { app.swapColors(); e.preventDefault(); return; } break;
        case 'KeyF': if (!e.shiftKey) { runCommand('view.screenModeCycle'); e.preventDefault(); return; } break;
        case 'Tab': e.preventDefault(); runCommand(e.shiftKey ? 'view.togglePanelsOnly' : 'view.togglePanels'); return;
        case 'BracketLeft': e.preventDefault(); adjustSize(-1, e.shiftKey); return;
        case 'BracketRight': e.preventDefault(); adjustSize(1, e.shiftKey); return;
        case 'Escape': if (doc && !tool?.isModal?.()) { /* nothing */ } break;
      }
      if (digit(e)) { e.preventDefault(); return; }
      if (toolLetter(e)) { e.preventDefault(); return; }
    }
  });
  window.addEventListener('keyup', e => {
    const tool = app.activeTool;
    if (!isTyping() && tool?.keyUp) { try { if (tool.keyUp(e, app.activeDoc)) { e.preventDefault(); return; } } catch (err) { console.error(err); } }
    if (e.code === 'Space' && app.springTool && ['hand', 'zoom'].includes(app.springTool.id)) spring(null);
    else if (e.key === 'Alt' && app.springTool?.id === 'eyedropper') spring(null);
    else if ((e.key === 'Control' || e.key === 'Meta') && app.springTool?.id === 'move') spring(null);
    else if (e.key === 'Alt' || e.key === 'Shift' || e.key === 'Control') { app.viewport?.updateCursor(); app.activeDoc?.redrawOverlay(); }
  });
  window.addEventListener('keydown', e => {
    if (['Alt', 'Shift', 'Control', 'Meta'].includes(e.key)) { app.viewport?.updateCursor(); app.activeDoc?.redrawOverlay(); }
  });
  window.addEventListener('blur', () => { if (app.springTool) spring(null); });
}
