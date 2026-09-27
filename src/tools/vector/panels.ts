// Paths panel and Shapes panel.
//  * Paths: the active shape layer's path, the Work Path and saved paths with thumbnails; click to select, click on
//    empty space to deselect, double-click to rename (Work Path: save), drag to reorder; footer buttons Fill with
//    foreground / Stroke with brush / Load as selection / Make work path / Add mask / New / Delete (Alt-click opens
//    the dialog variants); flyout + context menus with every path command; thumbnail size option.
//  * Shapes: custom shapes by group; click picks the shape for the Custom Shape Tool, drag onto the canvas (or
//    double-click) creates a shape layer; define / delete user shapes, new group, view sizes.
import { app } from '../../core/app';
import { events } from '../../core/events';
import type { PixDocument } from '../../core/document';
import { runCommand } from '../../core/commands';
import { createCanvas, ctx2d } from '../../core/canvas';
import { resources } from '../../core/registry';
import { toPath2D, type SubPath, type VectorPath } from '../../core/path';
import { registerPanel } from '../../ui/panels';
import { clear, h } from '../../ui/dom';
import { iconButton } from '../../ui/widgets';
import { registerIcons } from '../../ui/icons';
import { contextMenu, type MenuEntry } from '../../ui/menu';
import { confirmDialog, promptDialog } from '../../ui/dialog';
import { isShapeLayer } from '../../layers/shape-layer';
import { getPathSel, setPathSel, clearSel } from './common';
import { saveUserShapes, shapeGroup } from './resources';
import { createShapeAt, setCustomShape, shapeThumb } from './shape-tools';

registerIcons({
  'vp-fill': '<circle cx="12" cy="12" r="7" fill="currentColor"/>',
  'vp-stroke': '<circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="2.2" fill="currentColor"/>',
  'vp-load': '<circle cx="12" cy="12" r="7" stroke-dasharray="2.4 2"/>',
  'vp-workpath': '<rect x="5" y="5" width="14" height="14" stroke-dasharray="2.4 2"/><path d="M8.5 15.5c1.5-5 5.5-7 7-7"/><rect x="7.2" y="14.2" width="2.6" height="2.6" fill="currentColor"/><rect x="14.2" y="7.2" width="2.6" height="2.6" fill="currentColor"/>',
});

// ================================================================== Paths
type ThumbSize = 0 | 24 | 36 | 52;
const pp = (() => { try { return { thumb: 36 as ThumbSize, ...JSON.parse(localStorage.getItem('pixora.pathsPanel') || '{}') }; } catch { return { thumb: 36 as ThumbSize }; } })();
const savePP = () => { try { localStorage.setItem('pixora.pathsPanel', JSON.stringify(pp)); } catch { /* ignore */ } };

function pathThumb(doc: PixDocument, subs: SubPath[], size: number): HTMLCanvasElement {
  const k = size / Math.max(doc.width, doc.height);
  const w = Math.max(4, Math.round(doc.width * k)), hh = Math.max(4, Math.round(doc.height * k));
  const c = createCanvas(w, hh), x = ctx2d(c);
  x.fillStyle = '#fff'; x.fillRect(0, 0, w, hh);
  if (subs.length) {
    x.scale(k, k);
    const p = toPath2D(subs);
    x.fillStyle = '#6e6e6e';
    x.fill(p, subs.some(s => s.op === 'subtract' || s.op === 'exclude') ? 'evenodd' : 'nonzero');
    const open = subs.filter(s => !s.closed);
    if (open.length) { x.lineWidth = 1.5 / k; x.strokeStyle = '#333'; x.stroke(toPath2D(open)); }
  }
  c.className = 'vp-thumb';
  return c;
}

const alt = (e: MouseEvent) => e.altKey;
function pathMenu(doc: PixDocument | null): MenuEntry[] {
  const sel = doc ? getPathSel(doc) : -1;
  const p = doc && sel > 0 ? (doc.paths.find((x: VectorPath) => x.id === sel) as VectorPath | undefined) : undefined;
  return [
    { label: 'New Path...', cmd: 'paths.new' },
    ...(p?.kind === 'work' ? [{ label: 'Save Path...', cmd: 'paths.save' } as MenuEntry] : []),
    { label: 'Duplicate Path...', cmd: 'paths.duplicate' },
    { label: 'Delete Path', cmd: 'paths.delete' },
    '-',
    { label: 'Make Work Path...', cmd: 'paths.makeWorkPath' },
    '-',
    { label: 'Make Selection...', cmd: 'paths.makeSelection' },
    { label: 'Fill Path...', cmd: 'paths.fill' },
    { label: 'Stroke Path...', cmd: 'paths.stroke' },
    '-',
    { label: 'Clipping Path...', cmd: 'paths.clipping' },
    '-',
    { label: 'Panel Options...', submenu: ([['None', 0], ['Small', 24], ['Medium', 36], ['Large', 52]] as [string, ThumbSize][]).map(([label, v]) => ({ label: `Thumbnail: ${label}`, radio: true, checked: pp.thumb === v, action: () => { pp.thumb = v; savePP(); events.emit('paths', app.activeDoc!); } })) },
  ];
}

registerPanel({
  id: 'paths', title: 'Paths', icon: 'paths', defaultHeight: 240,
  create(el) {
    const list = h('div.vp-list.panel-scroll');
    const foot = h('div.panel-footer.vp-foot', null,
      iconButton('vp-fill', 'Fill path with foreground color (Alt-click: Fill Path dialog)', e => runCommand('paths.fill', alt(e) ? undefined : 'quick')),
      iconButton('vp-stroke', 'Stroke path with brush (Alt-click: Stroke Path dialog)', e => runCommand('paths.stroke', alt(e) ? undefined : 'quick')),
      iconButton('vp-load', 'Load path as a selection (Alt-click: Make Selection dialog)', e => runCommand(alt(e) ? 'paths.makeSelection' : 'paths.loadSelection')),
      iconButton('vp-workpath', 'Make work path from selection (Alt-click: set tolerance)', e => runCommand('paths.makeWorkPath', alt(e) ? undefined : 2)),
      iconButton('mask', 'Add a vector mask from the path', () => runCommand('paths.addMask')),
      iconButton('new-layer', 'Create new path (Alt-click: name it)', e => runCommand('paths.new', alt(e) ? undefined : '')),
      iconButton('trash', 'Delete current path', () => runCommand('paths.delete')));
    el.append(h('div.vp-panel', null, list, foot));

    let dragId = 0;
    const row = (doc: PixDocument, key: number, name: string, subs: SubPath[], opts: { italic?: boolean; path?: VectorPath }) => {
      const active = getPathSel(doc) === key;
      const r = h('div.vp-row', { class: `${active ? 'active' : ''} ${opts.italic ? 'italic' : ''}`, title: name, draggable: opts.path?.kind === 'saved' ? 'true' : 'false' },
        pp.thumb ? pathThumb(doc, subs, pp.thumb) : null, h('span.vp-name', null, name));
      if (pp.thumb) (r.firstChild as HTMLElement).style.height = pp.thumb + 'px';
      r.addEventListener('click', e => { e.stopPropagation(); setPathSel(doc, key); clearSel(); });
      r.addEventListener('dblclick', async e => {
        e.stopPropagation();
        if (!opts.path) return;
        if (opts.path.kind === 'work') { void runCommand('paths.save', { id: opts.path.id }); return; }
        const nameEl = r.querySelector('.vp-name') as HTMLElement;
        const inp = h('input.field.vp-edit', { type: 'text', value: opts.path.name }) as HTMLInputElement;
        nameEl.replaceWith(inp);
        inp.focus(); inp.select();
        let done = false;
        const finish = (ok: boolean) => { if (done) return; done = true; if (ok && inp.value.trim()) void runCommand('paths.rename', { id: opts.path!.id, name: inp.value.trim() }); draw(); };
        inp.addEventListener('keydown', ev => { ev.stopPropagation(); if (ev.key === 'Enter') finish(true); if (ev.key === 'Escape') finish(false); });
        inp.addEventListener('blur', () => finish(true));
      });
      r.addEventListener('contextmenu', e => { e.preventDefault(); setPathSel(doc, key); contextMenu(e, pathMenu(doc)); });
      if (opts.path?.kind === 'saved') {
        const id = opts.path.id;
        r.addEventListener('dragstart', e => { dragId = id; e.dataTransfer?.setData('text/plain', String(id)); r.classList.add('dragging'); });
        r.addEventListener('dragend', () => { dragId = 0; r.classList.remove('dragging'); });
        r.addEventListener('dragover', e => { if (dragId && dragId !== id) { e.preventDefault(); r.classList.add('drop'); } });
        r.addEventListener('dragleave', () => r.classList.remove('drop'));
        r.addEventListener('drop', e => {
          e.preventDefault(); r.classList.remove('drop');
          const from = doc.paths.findIndex((p: VectorPath) => p.id === dragId), to = doc.paths.findIndex((p: VectorPath) => p.id === id);
          if (from < 0 || to < 0 || from === to) return;
          doc.history.transaction('Move Path', () => { const arr = [...doc.paths]; const [m] = arr.splice(from, 1); arr.splice(to, 0, m); doc.paths = arr; });
          events.emit('paths', doc);
        });
      }
      return r;
    };
    const draw = () => {
      clear(list);
      const doc = app.activeDoc;
      if (!doc) return;
      const l = doc.activeLayer;
      if (isShapeLayer(l)) list.append(row(doc, 0, `${l.name} Shape Path`, l.subpaths, { italic: true }));
      const mask = l && (l.mask as any)?.vector ? (l.mask as any).vectorPath as SubPath[] : null;
      if (l && mask) list.append(h('div.vp-row.italic.vp-static', { title: 'Vector mask (edit it from the Layers panel)' }, pp.thumb ? pathThumb(doc, mask, pp.thumb) : null, h('span.vp-name', null, `${l.name} Vector Mask`)));
      for (const p of doc.paths as VectorPath[]) {
        const clip = doc.extra.clippingPath?.id === p.id;
        const r = row(doc, p.id, p.name, p.subpaths, { italic: p.kind === 'work', path: p });
        if (clip) r.classList.add('clip');
        list.append(r);
      }
    };
    list.addEventListener('click', () => { const d = app.activeDoc; if (d) { setPathSel(d, -1); clearSel(); } });
    list.addEventListener('contextmenu', e => { if (e.target === list) { e.preventDefault(); contextMenu(e, pathMenu(app.activeDoc)); } });
    let raf = 0;
    const later = () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; draw(); }); };
    draw();
    const offs = [events.on('paths', later), events.on('activeDoc', later), events.on('layers', later), events.on('activeLayer', later), events.on('history', later)];
    return { onShow: draw, destroy: () => offs.forEach(f => f()) };
  },
  menu: () => pathMenu(app.activeDoc),
});

// ================================================================== Shapes
const sp = (() => { try { return { size: 40, collapsed: [] as string[], groups: [] as string[], ...JSON.parse(localStorage.getItem('pixora.shapesPanel') || '{}') }; } catch { return { size: 40, collapsed: [] as string[], groups: [] as string[] }; } })();
const spCollapsed = new Set<string>(sp.collapsed);
const saveSP = () => { try { localStorage.setItem('pixora.shapesPanel', JSON.stringify({ size: sp.size, collapsed: [...spCollapsed], groups: sp.groups })); } catch { /* ignore */ } };
function moveShape(id: string, group: string) {
  const sh = resources.shapes.find(s => s.id === id) as any;
  if (!sh) return;
  sh.group = group;
  if (sh.id.startsWith('user-')) saveUserShapes();
  spRedraw();
}
let spSelected = '';
let spRedraw = () => {};

/** Create a shape layer from a custom shape centred at doc point (x, y). */
function placeShape(doc: PixDocument, id: string, x: number, y: number) {
  const tool = app.getTool('shape-custom');
  if (!tool) return;
  setCustomShape(id);
  const prevMode = tool.settings!.mode;
  tool.settings!.mode = 'shape';
  const s = Math.max(24, Math.round(Math.min(doc.width, doc.height) / 4));
  createShapeAt(doc, 'shape-custom', { x: Math.round(x - s / 2), y: Math.round(y - s / 2), w: s, h: s });
  tool.settings!.mode = prevMode;
}
function pickShape(id: string) {
  spSelected = id;
  setCustomShape(id);
  if (app.activeTool?.id !== 'shape-custom') app.setTool('shape-custom');
  spRedraw();
}
async function deleteShape(id: string) {
  const sh = resources.shapes.find(s => s.id === id);
  if (!sh) return;
  if ((await confirmDialog('Delete Shape', `Delete the shape "${sh.name}"?`)) !== 'ok') return;
  resources.shapes.splice(resources.shapes.indexOf(sh), 1);
  saveUserShapes();
  spRedraw();
}
async function renameShape(id: string) {
  const sh = resources.shapes.find(s => s.id === id);
  if (!sh) return;
  const n = await promptDialog('Shape Name', 'Name:', sh.name);
  if (!n) return;
  sh.name = n;
  if (sh.id.startsWith('user-')) saveUserShapes();
  spRedraw();
}

// drop target on the canvas (installed once)
document.addEventListener('dragover', e => {
  if (e.dataTransfer?.types.includes('application/x-pixora-shape') && (e.target as Element)?.closest?.('.view-overlay, .viewport, .canvas-area')) e.preventDefault();
});
document.addEventListener('drop', e => {
  const id = e.dataTransfer?.getData('application/x-pixora-shape');
  if (!id) return;
  const ov = document.querySelector('.view-overlay') as HTMLElement | null, doc = app.activeDoc, v = app.viewport;
  if (!ov || !doc || !v) return;
  const r = ov.getBoundingClientRect();
  if (e.clientX < r.left || e.clientY < r.top || e.clientX > r.right || e.clientY > r.bottom) return;
  e.preventDefault();
  const p = v.screenToDoc(e.clientX - r.left, e.clientY - r.top);
  placeShape(doc, id, p.x, p.y);
});

registerPanel({
  id: 'shapes', title: 'Shapes', icon: 'shape-custom', defaultHeight: 300,
  create(el) {
    const search = h('input.field.sp-search', { type: 'search', placeholder: 'Search Shapes', title: 'Search shapes by name' }) as HTMLInputElement;
    search.addEventListener('keydown', e => e.stopPropagation());
    const list = h('div.sp-list.panel-scroll');
    const foot = h('div.panel-footer', null,
      h('span.sp-hint', null, 'Drag a shape onto the canvas'),
      h('span.sp-flex'),
      iconButton('folder', 'Create a new group', async () => {
        let k = 1;
        while (sp.groups.includes(`Group ${k}`)) k++;
        const n = await promptDialog('Group Name', 'Name:', `Group ${k}`);
        if (!n || sp.groups.includes(n)) return;
        sp.groups.push(n); saveSP(); draw();
      }),
      iconButton('new-layer', 'Create new shape from the selected path', () => runCommand('edit.defineShape')),
      iconButton('trash', 'Delete the selected shape', () => { if (spSelected) void deleteShape(spSelected); }));
    el.append(h('div.sp-panel', null, h('div.sp-top', null, search), list, foot));

    const draw = () => {
      clear(list);
      const q = search.value.trim().toLowerCase();
      const groups = new Map<string, typeof resources.shapes>();
      for (const sh of resources.shapes) {
        if (q && !sh.name.toLowerCase().includes(q)) continue;
        const g = shapeGroup(sh);
        if (!groups.has(g)) groups.set(g, []);
        groups.get(g)!.push(sh);
      }
      if (!q) for (const g of sp.groups) if (!groups.has(g)) groups.set(g, []);
      const cur = spSelected || (app.getTool('shape-custom')?.settings?.shapeId as string) || '';
      for (const [g, items] of groups) {
        const closed = !q && spCollapsed.has(g);
        const head = h('div.sp-group', { title: closed ? 'Expand group' : 'Collapse group' }, h('span.sp-chev', null, closed ? '▸' : '▾'), h('span', null, g), h('span.sp-count', null, String(items.length)));
        head.addEventListener('click', () => { if (spCollapsed.has(g)) spCollapsed.delete(g); else spCollapsed.add(g); saveSP(); draw(); });
        if (sp.groups.includes(g)) head.addEventListener('contextmenu', e => {
          e.preventDefault();
          contextMenu(e, [{ label: 'Delete Group', enabled: !items.length, action: () => { sp.groups = sp.groups.filter((x: string) => x !== g); saveSP(); draw(); } }]);
        });
        list.append(head);
        if (closed) continue;
        const grid = h('div.sp-grid', { style: { gridTemplateColumns: `repeat(auto-fill, minmax(${sp.size + 8}px, 1fr))` } });
        if (!items.length) grid.append(h('div.sp-empty', null, 'Empty group'));
        for (const sh of items) {
          const cell = h('button.sp-cell', { type: 'button', title: `${sh.name} (click: use with Custom Shape Tool, drag onto the canvas: new shape layer)`, class: sh.id === cur ? 'active' : '', draggable: 'true' }, shapeThumb(sh.path, sp.size));
          cell.addEventListener('click', () => pickShape(sh.id));
          cell.addEventListener('dblclick', () => { const d = app.activeDoc; if (d) placeShape(d, sh.id, d.width / 2, d.height / 2); });
          cell.addEventListener('dragstart', e => { e.dataTransfer?.setData('application/x-pixora-shape', sh.id); e.dataTransfer!.effectAllowed = 'copy'; });
          cell.addEventListener('contextmenu', e => {
            e.preventDefault();
            contextMenu(e, [
              { label: 'Use with Custom Shape Tool', action: () => pickShape(sh.id) },
              { label: 'Add to Canvas', enabled: !!app.activeDoc, action: () => { const d = app.activeDoc; if (d) placeShape(d, sh.id, d.width / 2, d.height / 2); } },
              '-',
              { label: 'Rename Shape...', action: () => void renameShape(sh.id) },
              { label: 'Move to Group', submenu: [...new Set([...resources.shapes.map(x => shapeGroup(x)), ...sp.groups])].filter(n => n !== g).map(n => ({ label: n, action: () => moveShape(sh.id, n) })) },
              { label: 'Delete Shape', enabled: sh.id.startsWith('user-'), action: () => void deleteShape(sh.id) },
            ]);
          });
          grid.append(cell);
        }
        list.append(grid);
      }
    };
    spRedraw = draw;
    search.addEventListener('input', draw);
    draw();
    const offs = [events.on('paths', () => draw()), events.on('toolOptions', () => { if (app.activeTool?.id === 'shape-custom') draw(); })];
    return { onShow: draw, destroy: () => offs.forEach(f => f()) };
  },
  menu: () => [
    { label: 'New Shape...', cmd: 'edit.defineShape' },
    '-',
    ...([['Small Thumbnail', 28], ['Medium Thumbnail', 40], ['Large Thumbnail', 60]] as [string, number][]).map(([label, v]) => ({ label, radio: true, checked: sp.size === v, action: () => { sp.size = v; saveSP(); spRedraw(); } } as MenuEntry)),
  ],
});
