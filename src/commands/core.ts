// Core commands owned by the shell: undo/redo, zoom, panels, workspaces, screen modes, tool reset.
import { registerCommands } from '../core/commands';
import { app } from '../core/app';
import { events } from '../core/events';
import { showPanel, togglePanel, setPanelsHidden, setWorkspace, resetWorkspace, saveWorkspaceAs, customWorkspaces, deleteWorkspace } from '../ui/dock';
import { promptDialog, openDialog } from '../ui/dialog';
import { h } from '../ui/dom';
import { select } from '../ui/widgets';
import { toast } from '../ui/toast';
import { filters } from '../core/registry';
import { editableTarget } from '../core/pixelops';

let lastFilter: { id: string; params: any } | null = null;

const hasDoc = () => !!app.activeDoc;
const vp = () => app.viewport!;

let panelsHidden = false;
function applyScreenMode() {
  document.body.dataset.screen = app.screenMode;
  window.dispatchEvent(new Event('resize'));
}

registerCommands([
  // ---------------------------------------------------------------- history
  { id: 'edit.undo', run: () => app.activeDoc!.history.undo(), enabled: () => !!app.activeDoc?.history.canUndo },
  { id: 'edit.redo', run: () => app.activeDoc!.history.redo(), enabled: () => !!app.activeDoc?.history.canRedo },
  { id: 'edit.stepBackward', run: () => app.activeDoc!.history.undo(), enabled: () => !!app.activeDoc?.history.canUndo },
  { id: 'edit.stepForward', run: () => app.activeDoc!.history.redo(), enabled: () => !!app.activeDoc?.history.canRedo },
  {
    id: 'edit.toggleLast', enabled: () => !!app.activeDoc && (app.activeDoc.history.canUndo || app.activeDoc.history.canRedo),
    run: () => { const hh = app.activeDoc!.history; if (hh.canRedo && hh.index === hh.entries.length - 1) hh.redo(); else hh.undo(); },
  },

  // ---------------------------------------------------------------- view / zoom
  { id: 'view.zoomIn', shortcut: ['Ctrl+=', 'Ctrl+Shift+='], run: () => vp().zoomIn(), enabled: hasDoc },
  { id: 'view.zoomOut', shortcut: 'Ctrl+-', run: () => vp().zoomOut(), enabled: hasDoc },
  { id: 'view.fit', run: () => vp().fit(), enabled: hasDoc },
  { id: 'view.fill', run: () => vp().fill(), enabled: hasDoc },
  { id: 'view.actual', run: () => vp().actualPixels(), enabled: hasDoc },
  { id: 'view.zoom200', run: () => { vp().setZoom(2); vp().center(); }, enabled: hasDoc },
  { id: 'view.printSize', run: () => vp().printSize(), enabled: hasDoc },
  { id: 'view.flip', run: () => { const d = app.activeDoc!; d.view.flip = !d.view.flip; vp().requestRender(); events.emit('view', d); }, enabled: hasDoc, checked: () => !!app.activeDoc?.view.flip },
  { id: 'view.resetRotation', shortcut: 'Escape', run: () => vp().setRotation(0), enabled: () => !!app.activeDoc?.view.rotation && app.activeTool?.id === 'rotate-view' },
  {
    id: 'view.screenMode', run: (mode: 'standard' | 'full-menu' | 'full') => { app.screenMode = mode || 'standard'; applyScreenMode(); },
  },
  {
    id: 'view.screenModeCycle', run: () => {
      const order: typeof app.screenMode[] = ['standard', 'full-menu', 'full'];
      app.screenMode = order[(order.indexOf(app.screenMode) + 1) % 3];
      applyScreenMode();
      if (app.screenMode === 'full') toast('Full Screen Mode — press F to cycle screen modes, Tab to show panels', 'info', 3000);
    },
  },
  {
    id: 'view.togglePanels', run: () => {
      panelsHidden = !panelsHidden;
      document.body.classList.toggle('panels-hidden', panelsHidden);
      setPanelsHidden(panelsHidden);
    },
  },
  {
    id: 'view.togglePanelsOnly', run: () => {
      panelsHidden = !panelsHidden;
      document.body.classList.toggle('dock-hidden', panelsHidden);
      setPanelsHidden(panelsHidden);
    },
  },

  // ---------------------------------------------------------------- panels / workspaces
  { id: 'window.togglePanel', run: (id: string) => togglePanel(id) },
  { id: 'window.showPanel', run: (id: string) => showPanel(id) },
  { id: 'window.workspace', run: (name: string) => setWorkspace(name) },
  { id: 'window.resetWorkspace', run: () => resetWorkspace() },
  {
    id: 'window.newWorkspace', run: async () => {
      const name = await promptDialog('New Workspace', 'Name:', 'Workspace 1');
      if (name) { saveWorkspaceAs(name); toast(`Workspace "${name}" saved`, 'success'); }
    },
  },
  {
    id: 'window.deleteWorkspace', enabled: () => customWorkspaces().length > 0, run: async () => {
      let pick = customWorkspaces()[0];
      const body = h('div.form', null, h('div.form-row', null, h('label.form-label', null, 'Workspace:'), select(customWorkspaces().map(n => ({ value: n, label: n })), pick, v => { pick = v; }, { width: 200 })));
      const r = await openDialog({ title: 'Delete Workspace', body, buttons: [{ label: 'Delete', primary: true, value: true }, { label: 'Cancel', value: false }] }).result;
      if (r && pick) deleteWorkspace(pick);
    },
  },

  // ---------------------------------------------------------------- tools
  {
    id: 'tool.reset', run: () => {
      const t = app.activeTool;
      if (!t?.settings) return;
      localStorage.removeItem(`pixora.tool.${t.id}`);
      toast('Tool settings will reset on reload', 'info');
    },
  },
  {
    id: 'tool.resetAll', run: () => {
      for (const k of Object.keys(localStorage)) if (k.startsWith('pixora.tool.')) localStorage.removeItem(k);
      location.reload();
    },
  },

  // ---------------------------------------------------------------- filters
  {
    id: 'filter.run', enabled: hasDoc,
    run: async (id: string) => {
      const f = filters[id], doc = app.activeDoc;
      if (!doc) return;
      if (!f) { toast(`${id} is not available yet`); return; }
      if (!editableTarget(doc)) return;
      const params = await f.run(doc, {});
      if (params !== null && params !== undefined && params !== false) lastFilter = { id, params };
    },
  },
  {
    id: 'filter.last', enabled: () => !!lastFilter && hasDoc(),
    get label() { return lastFilter ? filters[lastFilter.id]?.label || 'Last Filter' : 'Last Filter'; },
    run: async () => {
      const doc = app.activeDoc;
      if (!doc || !lastFilter || !editableTarget(doc)) return;
      await filters[lastFilter.id]?.run(doc, { params: lastFilter.params });
    },
  } as any,

  // ---------------------------------------------------------------- home
  {
    id: 'app.home', run: () => { document.body.classList.toggle('show-home'); events.emit('docs'); },
  },
]);

events.on('activeDoc', () => { if (document.body.classList.contains('show-home')) { document.body.classList.remove('show-home'); events.emit('docs'); } });
applyScreenMode();
