// Plugins: pixel-processing plugins that run in a sandboxed Web Worker (no access to the page or your documents
// beyond the pixels passed in). A plugin is a script that calls
//   pixora.register({ name, description, params: [{ key, label, min, max, default, step? , type?: 'slider'|'check' }],
//                     run(image /* ImageData */, params, info) { ...; return image } })
// Plugins menu: one item per enabled plugin (dialog with live preview when it has parameters), Plugins panel,
// Browse Plugins (built-in catalog), Manage Plugins (install from file, write / edit, enable / disable, remove).
import './plugins.css';
import { app } from '../../core/app';
import { events } from '../../core/events';
import { registerCommands, runCommand } from '../../core/commands';
import { applyPixelOp, editableTarget } from '../../core/pixelops';
import { h } from '../../ui/dom';
import { icon } from '../../ui/icons';
import { openDialog, confirmDialog } from '../../ui/dialog';
import { checkbox, sliderRow } from '../../ui/widgets';
import { filterDialog } from '../../ui/filter-dialog';
import { registerPanel } from '../../ui/panels';
import { toast } from '../../ui/toast';
import { pickFiles } from '../file/io';
import type { MenuEntry } from '../../ui/menu';
import { CATALOG } from './catalog';

export interface PluginParam { key: string; label: string; min?: number; max?: number; step?: number; default: number | boolean; type?: 'slider' | 'check' }
export interface PluginRecord { id: string; name: string; description: string; author: string; version: string; code: string; enabled: boolean; params: PluginParam[]; catalogId?: string }
const KEY = 'pixora.plugins';
let plugins: PluginRecord[] = (() => { try { return JSON.parse(localStorage.getItem(KEY) || '[]'); } catch { return []; } })();
const save = () => { try { localStorage.setItem(KEY, JSON.stringify(plugins)); } catch { toast('Could not save plugins (storage full).', 'error'); } events.emit('plugins' as any, null as any); };
export const installedPlugins = () => plugins;

// ------------------------------------------------------------------ sandbox
const WRAPPER = `
let __def = null;
self.pixora = { register(def) { __def = def; } };
self.onmessage = async (e) => {
  const { cmd, id, data, width, height, params, info } = e.data;
  try {
    if (!__def) throw new Error('The plugin did not call pixora.register()');
    if (cmd === 'meta') { self.postMessage({ id, meta: { name: __def.name, description: __def.description || '', author: __def.author || '', version: __def.version || '1.0', params: __def.params || [] } }); return; }
    const img = new ImageData(new Uint8ClampedArray(data), width, height);
    const out = (await __def.run(img, params || {}, info || {})) || img;
    if (!(out instanceof ImageData)) throw new Error('run() must return an ImageData');
    self.postMessage({ id, width: out.width, height: out.height, data: out.data.buffer }, [out.data.buffer]);
  } catch (err) { self.postMessage({ id, error: String(err && err.message || err) }); }
};
`;
function spawn(code: string): Worker {
  const src = `${WRAPPER}\n;(function(){\n${code}\n})();`;
  const url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
  const w = new Worker(url);
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  return w;
}
function call<T>(w: Worker, msg: any, transfer: Transferable[] = [], timeout = 30000): Promise<T> {
  const id = Math.random().toString(36).slice(2);
  return new Promise<T>((ok, err) => {
    const t = setTimeout(() => { w.terminate(); err(new Error('The plugin took too long and was stopped.')); }, timeout);
    w.onmessage = e => { if (e.data.id !== id) return; clearTimeout(t); if (e.data.error) err(new Error(e.data.error)); else ok(e.data as T); };
    w.onerror = e => { clearTimeout(t); e.preventDefault(); err(new Error(e.message || 'Plugin error')); };
    w.postMessage({ ...msg, id }, transfer);
  });
}
/** Read a plugin's metadata by running its registration in the sandbox. */
export async function inspect(code: string): Promise<Omit<PluginRecord, 'id' | 'code' | 'enabled'>> {
  const w = spawn(code);
  try { const r = await call<{ meta: any }>(w, { cmd: 'meta' }, [], 5000); return { name: String(r.meta.name || 'Untitled Plugin'), description: String(r.meta.description || ''), author: String(r.meta.author || ''), version: String(r.meta.version || '1.0'), params: Array.isArray(r.meta.params) ? r.meta.params : [] }; }
  finally { w.terminate(); }
}
const workers = new Map<string, Worker>();
async function runPlugin(p: PluginRecord, img: ImageData, params: any, info: any): Promise<ImageData> {
  let w = workers.get(p.id);
  if (!w) { w = spawn(p.code); workers.set(p.id, w); }
  const copy = new Uint8ClampedArray(img.data);
  try {
    const r = await call<{ width: number; height: number; data: ArrayBuffer }>(w, { cmd: 'run', data: copy.buffer, width: img.width, height: img.height, params, info }, [copy.buffer]);
    return new ImageData(new Uint8ClampedArray(r.data), r.width, r.height);
  } catch (e) { workers.delete(p.id); w.terminate(); throw e; }
}

// ------------------------------------------------------------------ running from the menu / panel
async function usePlugin(id: string) {
  const p = plugins.find(x => x.id === id);
  const doc = app.activeDoc;
  if (!p || !doc) return;
  if (!editableTarget(doc)) return;
  const defaults = Object.fromEntries(p.params.map(q => [q.key, q.default]));
  const info = (i: { x: number; y: number; isMask: boolean }) => ({ docWidth: doc.width, docHeight: doc.height, x: i.x, y: i.y, isMask: i.isMask, foreground: app.fg, background: app.bg });
  try {
    if (!p.params.length) { await applyPixelOp(doc, p.name, (img, i) => runPlugin(p, img, {}, info(i))); return; }
    await filterDialog({
      title: p.name + '...', doc, params: { ...defaults },
      build(body, params: any, update) {
        if (p.description) body.append(h('div.plg-desc', null, p.description));
        for (const q of p.params) {
          if (q.type === 'check' || typeof q.default === 'boolean') body.append(checkbox(q.label, !!params[q.key], v => { params[q.key] = v; update(); }));
          else body.append(sliderRow(q.label, params[q.key] as number, q.min ?? 0, q.max ?? 100, v => { params[q.key] = v; update(); }, { step: q.step, decimals: q.step && q.step < 1 ? 2 : 0 }));
        }
      },
      op: (params: any) => (img, i) => runPlugin(p, img, params, info(i)),
    });
  } catch (e: any) { toast(`${p.name}: ${e?.message || e}`, 'error', 5000); }
}

// ------------------------------------------------------------------ install / manage
async function install(code: string, catalogId?: string): Promise<PluginRecord | null> {
  let meta;
  try { meta = await inspect(code); } catch (e: any) { toast(`This is not a valid Pixora plugin: ${e?.message || e}`, 'error', 5000); return null; }
  const existing = plugins.find(x => (catalogId && x.catalogId === catalogId) || x.name === meta.name);
  const rec: PluginRecord = { id: existing?.id || `plg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`, ...meta, code, enabled: true, catalogId };
  plugins = existing ? plugins.map(x => (x === existing ? rec : x)) : [...plugins, rec];
  workers.get(rec.id)?.terminate(); workers.delete(rec.id);
  save();
  toast(`${existing ? 'Updated' : 'Installed'} plugin "${rec.name}"`, 'success');
  return rec;
}
function remove(p: PluginRecord) { plugins = plugins.filter(x => x !== p); workers.get(p.id)?.terminate(); workers.delete(p.id); save(); }
const TEMPLATE = `// Pixora plugin — runs in a sandbox and receives the layer pixels as ImageData.
pixora.register({
  name: 'My Plugin',
  description: 'Inverts the brightness, keeping colours.',
  params: [{ key: 'amount', label: 'Amount', min: 0, max: 100, default: 100 }],
  run(image, params) {
    const d = image.data, k = params.amount / 100;
    for (let i = 0; i < d.length; i += 4) {
      for (let c = 0; c < 3; c++) d[i + c] = d[i + c] + (255 - 2 * d[i + c]) * k;
    }
    return image;
  },
});`;
async function editor(p?: PluginRecord) {
  const ta = h('textarea.field.plg-code', { spellcheck: false, rows: 20 }) as HTMLTextAreaElement;
  ta.value = p?.code || TEMPLATE;
  ta.addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Tab') { e.preventDefault(); const s = ta.selectionStart; ta.setRangeText('  ', s, ta.selectionEnd, 'end'); } });
  const status = h('div.plg-status');
  const body = h('div.plg-editor', null, h('div.flt-hint', null, 'Plugins run in a sandboxed worker: they only see the pixels they are given and cannot access the page or your files.'), ta, status);
  const d = openDialog({
    title: p ? `Edit Plugin — ${p.name}` : 'New Plugin', body, width: 760, escClose: false,
    buttons: [
      { label: 'Check', onClick: async () => { try { const m = await inspect(ta.value); status.textContent = `✓ ${m.name} — ${m.params.length} parameter(s)`; status.className = 'plg-status ok'; } catch (e: any) { status.textContent = `✕ ${e?.message || e}`; status.className = 'plg-status bad'; } return false; } },
      { label: 'Save', primary: true, onClick: async () => { const r = await install(ta.value, p?.catalogId); return !!r; } },
      { label: 'Cancel', value: null },
    ],
  });
  setTimeout(() => ta.focus());
  await d.result;
}
function manage() {
  const list = h('div.plg-list');
  const render = () => {
    list.replaceChildren();
    if (!plugins.length) list.append(h('div.plg-empty', null, 'No plugins installed yet. Browse the catalog or write your own.'));
    for (const p of plugins) {
      list.append(h('div.plg-row', null,
        checkbox('', p.enabled, v => { p.enabled = v; save(); }, { title: p.enabled ? 'Disable plugin' : 'Enable plugin' }),
        h('div.plg-info', null, h('div.plg-name', null, p.name, h('span.plg-ver', null, ` ${p.version}`)), h('div.plg-meta', null, [p.author, p.description].filter(Boolean).join(' — '))),
        h('button.icon-btn', { type: 'button', title: 'Edit the plugin code', onclick: () => void editor(p).then(render) }, icon('pen', 14)),
        h('button.icon-btn', { type: 'button', title: 'Export the plugin as a file', onclick: () => { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([p.code], { type: 'text/javascript' })); a.download = `${p.name.replace(/[^\w-]+/g, '_')}.pxplugin.js`; a.click(); } }, icon('save', 14)),
        h('button.icon-btn', { type: 'button', title: 'Remove the plugin', onclick: async () => { if ((await confirmDialog('Remove Plugin', `Remove "${p.name}"?`)) === 'ok') { remove(p); render(); } } }, icon('trash', 14))));
    }
  };
  render();
  const off = events.on('plugins' as any, render);
  openDialog({
    title: 'Manage Plugins', body: h('div.plg-manage', null, list), width: 640, onClose: () => off(),
    buttons: [
      { label: 'Install from File...', onClick: async () => { const fs = await pickFiles('.js,text/javascript', true); for (const f of fs) await install(await f.text()); return false; } },
      { label: 'New Plugin...', onClick: () => { void editor(); return false; } },
      { label: 'Browse...', onClick: () => { browse(); return false; } },
      { label: 'Close', primary: true, value: null },
    ],
  });
}
function browse() {
  const grid = h('div.plg-cat');
  const render = () => {
    grid.replaceChildren();
    for (const c of CATALOG) {
      const inst = plugins.find(p => p.catalogId === c.id);
      const btn = h('button.btn', { type: 'button', class: inst ? '' : 'primary', title: inst ? 'Reinstall this plugin' : 'Install this plugin' }, inst ? 'Installed ✓' : 'Install');
      btn.addEventListener('click', async () => { btn.setAttribute('disabled', ''); await install(c.code, c.id); render(); });
      grid.append(h('div.plg-card', null, h('div.plg-card-ic', null, icon(c.icon, 22)), h('div.plg-card-body', null, h('div.plg-name', null, c.name), h('div.plg-meta', null, c.description)), btn));
    }
  };
  render();
  openDialog({ title: 'Browse Plugins', body: grid, width: 680, buttons: [{ label: 'Manage...', onClick: () => { manage(); return false; } }, { label: 'Close', primary: true, value: null }] });
}
function aboutPlugins() {
  const body = h('div.plg-about', null, plugins.length ? h('div', null, ...plugins.map(p => h('div.plg-row', null, h('div.plg-info', null, h('div.plg-name', null, `${p.name} ${p.version}`), h('div.plg-meta', null, `${p.author || 'Unknown author'} · ${p.enabled ? 'enabled' : 'disabled'}`))))) : h('div.plg-empty', null, 'No plugins are installed.'));
  openDialog({ title: 'About Plugins', body, width: 480, buttons: [{ label: 'OK', primary: true, value: null }] });
}

// ------------------------------------------------------------------ Plugins panel
registerPanel({
  id: 'plugins', title: 'Plugins', icon: 'plugin',
  create(el) {
    const list = h('div.panel-scroll.plg-panel');
    const footer = h('div.panel-footer', null,
      h('button.icon-btn', { type: 'button', title: 'Browse plugins', onclick: () => browse() }, icon('plus', 16)),
      h('button.icon-btn', { type: 'button', title: 'Manage plugins', onclick: () => manage() }, icon('gear', 16)));
    el.append(list, footer);
    const render = () => {
      list.replaceChildren();
      const on = plugins.filter(p => p.enabled);
      if (!on.length) list.append(h('div.plg-empty', null, h('div', null, 'No plugins yet.'), h('button.btn', { type: 'button', title: 'Browse the plugin catalog', onclick: () => browse() }, 'Browse Plugins')));
      for (const p of on) list.append(h('button.plg-item', { type: 'button', title: p.description || p.name, onclick: () => void usePlugin(p.id) }, icon('plugin', 16), h('span', null, p.name)));
    };
    render();
    const off = events.on('plugins' as any, render);
    return { destroy: off };
  },
});

registerCommands([
  { id: 'plugins.panel', label: 'Plugins Panel', checked: () => !!document.querySelector('[data-panel="plugins"]'), run: () => runCommand('window.togglePanel', 'plugins') },
  { id: 'plugins.browse', label: 'Browse Plugins...', run: browse },
  { id: 'plugins.manage', label: 'Manage Plugins...', run: manage },
  { id: 'plugins.run', label: 'Run Plugin', enabled: () => !!app.activeDoc, run: (id: string) => usePlugin(id) },
  { id: 'plugins.list', label: 'Plugins', run: (): MenuEntry[] => plugins.filter(p => p.enabled).map(p => ({ label: p.params.length ? `${p.name}...` : p.name, cmd: 'plugins.run', arg: p.id })) },
  { id: 'help.aboutPlugins', label: 'About Plugins...', run: aboutPlugins },
]);
(window as any).__pxPlugins = { install, inspect, installedPlugins, usePlugin, runPlugin };
