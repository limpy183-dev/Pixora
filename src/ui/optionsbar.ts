// Tool options bar: home button, tool preset picker, the active tool's options and the app bar buttons.
import { h, clear } from './dom';
import { icon } from './icons';
import { events } from '../core/events';
import { app, saveJSON } from '../core/app';
import { runCommand } from '../core/commands';
import { openMenu, type MenuEntry } from './menu';
import { WORKSPACES, dockState } from './dock';
import { promptDialog } from './dialog';
import { toast } from './toast';

interface ToolPreset { name: string; tool: string; settings: Record<string, any> }
function loadPresets(): ToolPreset[] { try { return JSON.parse(localStorage.getItem('pixora.toolPresets') || '[]'); } catch { return []; } }

export function createOptionsBar(): HTMLElement {
  const bar = h('div.optionsbar');
  const grip = h('div.bar-grip');
  const home = h('button.icon-btn.home-btn', { type: 'button', title: 'Home', onclick: () => runCommand('app.home') }, icon('home', 20));
  const presetBtn = h('button.icon-btn.preset-btn', { type: 'button', title: 'Tool Preset picker', 'data-menu-anchor': '' });
  const opts = h('div.tool-options');
  const right = h('div.appbar-right', null,
    h('button.icon-btn', { type: 'button', title: 'Share', onclick: () => runCommand('app.share') }, icon('share', 20)),
    h('button.icon-btn', { type: 'button', title: 'Notifications', onclick: (e: MouseEvent) => runCommand('app.notifications', e.currentTarget) }, icon('bell', 20)),
    h('button.icon-btn', { type: 'button', title: 'Search (Ctrl+F)', onclick: () => runCommand('edit.search') }, icon('search', 20)),
    h('button.icon-btn', { type: 'button', title: 'Discover', onclick: () => runCommand('help.discover') }, icon('lightbulb', 20)),
    h('button.icon-btn.workspace-btn', { type: 'button', title: 'Choose a workspace', 'data-menu-anchor': '', onclick: (e: MouseEvent) => workspaceMenu(e.currentTarget as HTMLElement) }, icon('workspace', 22), icon('chevron-down', 12)),
  );
  bar.append(grip, home, h('div.opt-sep'), presetBtn, h('div.opt-sep.thin'), opts, right);

  presetBtn.addEventListener('click', () => {
    const t = app.activeTool;
    if (!t) return;
    const presets = loadPresets();
    const mine = presets.filter(p => p.tool === t.id);
    const items: MenuEntry[] = [
      { header: true, label: t.name },
      ...(mine.length ? mine.map(p => ({ label: p.name, icon: t.icon, action: () => { if (t.settings) { Object.assign(t.settings, p.settings); app.saveToolSettings(t); buildOptions(); } } })) : [{ label: 'No tool presets', enabled: false }]),
      '-',
      { label: 'New Tool Preset...', enabled: !!t.settings, action: async () => {
        const name = await promptDialog('New Tool Preset', 'Name:', `${t.name.replace(' Tool', '')} 1`);
        if (!name) return;
        presets.push({ name, tool: t.id, settings: JSON.parse(JSON.stringify(t.settings || {})) });
        saveJSON('pixora.toolPresets', presets);
        toast(`Tool preset "${name}" saved`, 'success');
      } },
      { label: 'Reset Tool', action: () => runCommand('tool.reset') },
      { label: 'Reset All Tools', action: () => runCommand('tool.resetAll') },
      '-',
      { label: 'Delete Presets for This Tool', enabled: mine.length > 0, action: () => saveJSON('pixora.toolPresets', presets.filter(p => p.tool !== t.id)) },
    ];
    openMenu(items, presetBtn, { minWidth: 220 });
  });

  let cleanup: void | (() => void);
  const buildOptions = () => {
    try { if (typeof cleanup === 'function') cleanup(); } catch { /* ignore */ }
    cleanup = undefined;
    clear(opts);
    const t = app.activeTool;
    presetBtn.replaceChildren(t ? icon(t.icon, 20) : '', icon('chevron-down', 12));
    if (t?.options) {
      try { cleanup = t.options(opts); } catch (err) { console.error(`[options ${t.id}]`, err); }
    }
  };
  events.on('tool', buildOptions);
  (bar as any).rebuild = buildOptions;
  buildOptions();
  return bar;
}

function workspaceMenu(anchor: HTMLElement) {
  const items: MenuEntry[] = [
    ...Object.keys(WORKSPACES).map(n => ({ label: n === 'Essentials' ? 'Essentials (Default)' : n, radio: true, checked: dockState.workspace === n, cmd: 'window.workspace', arg: n })),
    '-',
    { label: `Reset ${dockState.workspace}`, cmd: 'window.resetWorkspace' },
    { label: 'New Workspace...', cmd: 'window.newWorkspace' },
    { label: 'Delete Workspace...', cmd: 'window.deleteWorkspace' },
  ];
  openMenu(items, anchor, { minWidth: 220 });
}
