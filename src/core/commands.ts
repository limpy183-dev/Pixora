// Command registry. Menus, shortcuts, buttons and actions all run commands by id.
import { events } from './events';
import { toast } from '../ui/toast';

export interface Command {
  id: string;                          // e.g. 'layer.new'
  label?: string;                      // fallback label (menus usually provide their own)
  /** Shortcut(s) like 'Ctrl+Shift+N', 'Alt+Backspace', 'F7'. Use Ctrl (mapped to Cmd on macOS). */
  shortcut?: string | string[];
  run(arg?: any): any;
  /** Greyed out in menus when false. Default: enabled. */
  enabled?(): boolean;
  /** Shows a check mark in menus when true. */
  checked?(arg?: any): boolean;
}

export const commands = new Map<string, Command>();

export function registerCommand(cmd: Command) { commands.set(cmd.id, cmd); }
export function registerCommands(list: Command[]) { for (const c of list) registerCommand(c); }

export function isCommandEnabled(id: string): boolean {
  const c = commands.get(id);
  if (!c) return false;
  try { return c.enabled ? !!c.enabled() : true; } catch { return false; }
}
export function isCommandChecked(id: string, arg?: any): boolean {
  const c = commands.get(id);
  try { return !!c?.checked?.(arg); } catch { return false; }
}

/** Run a command. Returns its result (awaitable). Errors are reported as a toast. */
export async function runCommand(id: string, arg?: any): Promise<any> {
  const c = commands.get(id);
  if (!c) { toast(`"${id}" is not available yet`); return; }
  if (!isCommandEnabled(id)) return;
  events.emit('command', { id, arg });
  try { return await c.run(arg); }
  catch (err: any) {
    console.error(`[command ${id}]`, err);
    toast(err?.message ? `Could not complete the command: ${err.message}` : 'Could not complete the command.', 'error');
  }
}

// ---------------------------------------------------------------- shortcut normalisation
export const isMac = /Mac|iPhone|iPad/.test(navigator.platform);

/** Normalise 'shift+ctrl+n' → 'Ctrl+Shift+N'. */
export function normShortcut(s: string): string {
  const parts = s.split('+').map(p => p.trim()).filter(Boolean);
  let key = parts.pop() || '';
  const mods = new Set(parts.map(p => p.toLowerCase()));
  if (key.length === 1) key = key.toUpperCase();
  const out: string[] = [];
  if (mods.has('ctrl') || mods.has('cmd') || mods.has('meta')) out.push('Ctrl');
  if (mods.has('alt') || mods.has('option')) out.push('Alt');
  if (mods.has('shift')) out.push('Shift');
  out.push(key);
  return out.join('+');
}
/** Shortcut string for a keyboard event (same format as normShortcut). */
export function eventShortcut(e: KeyboardEvent): string {
  let key = e.key;
  if (key === ' ') key = 'Space';
  else if (key.length === 1) key = key.toUpperCase();
  // Use physical key for digits / symbols when modifiers change the produced char
  if (e.code.startsWith('Digit')) key = e.code.slice(5);
  else if (e.code.startsWith('Key')) key = e.code.slice(3);
  else if (e.code === 'Equal') key = '=';
  else if (e.code === 'Minus') key = '-';
  else if (e.code === 'BracketLeft') key = '[';
  else if (e.code === 'BracketRight') key = ']';
  else if (e.code === 'Backslash') key = '\\';
  else if (e.code === 'Semicolon') key = ';';
  else if (e.code === 'Quote') key = "'";
  else if (e.code === 'Comma') key = ',';
  else if (e.code === 'Period') key = '.';
  else if (e.code === 'Slash') key = '/';
  else if (e.code === 'Backquote') key = '`';
  const out: string[] = [];
  if (e.ctrlKey || e.metaKey) out.push('Ctrl');
  if (e.altKey) out.push('Alt');
  if (e.shiftKey) out.push('Shift');
  out.push(key);
  return out.join('+');
}
/** Pretty label for menus ('Ctrl+Shift+N' → '⇧⌘N' on mac). */
export function shortcutLabel(s: string): string {
  if (!isMac) return s;
  return s.replace('Ctrl+', '⌘').replace('Alt+', '⌥').replace('Shift+', '⇧');
}

/** shortcut → command (+arg). Filled by registerShortcut / menu definitions / command.shortcut. */
export const shortcutMap = new Map<string, { id: string; arg?: any }>();
export function registerShortcut(shortcut: string, commandId: string, arg?: any) { shortcutMap.set(normShortcut(shortcut), { id: commandId, arg }); }
