// Pixora bootstrap.
import './styles/app.css';
import './core/presets';
import { app } from './core/app';
import { PixDocument } from './core/document';
import { h } from './ui/dom';
import { createMenuBar } from './ui/menubar';
import { createOptionsBar } from './ui/optionsbar';
import { createToolbar } from './ui/toolbar';
import { createWorkspace } from './ui/workspace';
import { initDock } from './ui/dock';
import { initShortcuts, buildShortcutMap } from './ui/shortcuts';
import { events } from './core/events';

// Feature modules register tools, panels, commands, adjustments, filters and effects on import.
// Worker entry files must be named *.worker.ts (they are excluded here).
const modules = import.meta.glob([
  './commands/**/*.ts', './tools/**/*.ts', './panels/**/*.ts', './adjustments/**/*.ts',
  './filters/**/*.ts', './effects/**/*.ts', './layers/**/*.ts', './features/**/*.ts',
  '!./**/*.worker.ts', '!./**/*.test.ts',
]);

async function boot() {
  document.documentElement.dataset.theme = app.prefs.theme;
  const t0 = performance.now();
  await Promise.all(Object.entries(modules).map(([path, load]) => load().catch(err => console.error(`[module] ${path}`, err))));
  await new Promise(r => setTimeout(r, 0)); // let deferred registrations (placeholders) run

  const root = document.getElementById('app')!;
  root.replaceChildren();
  const { el: work, viewport } = createWorkspace();
  const dock = h('div#dock');
  root.append(createMenuBar(), createOptionsBar(), createToolbar(), work, dock);
  initDock(dock);
  initShortcuts();
  buildShortcutMap();
  viewport.refreshTheme();
  events.on('theme', () => viewport.refreshTheme());

  if (!app.activeTool) app.setTool(app.groupSelection['move'] && app.tools.has(app.groupSelection['move']) ? app.groupSelection['move'] : 'move');

  // Start like the reference screenshot: a 16×12 cm, 300 ppi white document.
  const params = new URLSearchParams(location.search);
  if (!params.has('empty')) {
    const doc = PixDocument.create(1890, 1417, { resolution: 300, resolutionUnit: 'ppcm' });
    app.addDocument(doc);
  }
  console.info(`[pixora] ready in ${Math.round(performance.now() - t0)} ms — ${app.tools.size} tools`);
  // Test/debug handles (used by scripts/shot.mjs based checks).
  (window as any).__px = {
    app, PixDocument, events,
    layer: await import('./core/layer'), brush: await import('./core/brush'), commands: await import('./core/commands'),
    compositor: await import('./core/compositor'), canvas: await import('./core/canvas'), pixelops: await import('./core/pixelops'),
    registry: await import('./core/registry'), dock: await import('./ui/dock'), filterDialog: await import('./ui/filter-dialog'), widgets: await import('./ui/widgets'),
  };
  (window as any).__pixoraReady = true;
}

boot();
