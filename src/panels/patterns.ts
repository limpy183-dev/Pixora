// Patterns panel: search, pattern groups (Trees, Grass, Water, Stone, Rust, Marble, Paper, Fabric, Leaves, Stars, Legacy),
// thumbnails; click sets the Paint Bucket / Pattern Stamp pattern (and a selected Pattern fill layer).
// + = Define Pattern from the selection (Edit › Define Pattern…, command 'edit.definePattern'), groups, rename, delete, reset.
import '../features/color/color.css';
import { registerPanel } from '../ui/panels';
import { app } from '../core/app';
import { events } from '../core/events';
import { resources } from '../core/registry';
import { registerCommand } from '../core/commands';
import { createCanvas, ctx2d, cropCanvas } from '../core/canvas';
import { h } from '../ui/dom';
import { iconButton, thumbURL } from '../ui/widgets';
import { contextMenu, type MenuEntry } from '../ui/menu';
import { confirmDialog, openDialog, promptDialog } from '../ui/dialog';
import { toast } from '../ui/toast';
import { type PatternEx, addPattern, deletePattern, onPresets, patternFolders, renamePattern, resetPatterns } from '../features/color/store';
import { type ViewMode, dropTarget, renderFolders, searchField } from '../features/color/preset-ui';

const PREF = 'pixora.patternsPanel';
const pref = (() => { try { return { mode: 'large' as ViewMode, collapsed: [] as string[], ...JSON.parse(localStorage.getItem(PREF) || '{}') }; } catch { return { mode: 'large' as ViewMode, collapsed: [] as string[] }; } })();
const collapsed = new Set<string>(pref.collapsed);
const savePref = () => { try { localStorage.setItem(PREF, JSON.stringify({ mode: pref.mode, collapsed: [...collapsed] })); } catch { /* ignore */ } };
let selected: PatternEx | null = null;
let rerender = () => {};

/** Current pattern of the Paint Bucket tool (id). */
const bucketPattern = (): string | undefined => app.getTool('paint-bucket')?.settings?.patternId;

/** Make `p` the pattern of the pattern-using tools and of a selected Pattern fill layer. */
export function applyPattern(p: PatternEx) {
  for (const id of ['paint-bucket', 'pattern-stamp']) {
    const t = app.getTool(id);
    if (!t?.settings) continue;
    if ('patternId' in t.settings) t.settings.patternId = p.id;
    if ('pattern' in t.settings) t.settings.pattern = p.id;
    if (id === 'paint-bucket' && 'source' in t.settings) t.settings.source = 'pattern';
    app.saveToolSettings(t);
  }
  const doc = app.activeDoc, l: any = doc?.activeLayer;
  if (doc && l && l.kind === 'fill' && l.fill?.type === 'pattern' && !l.locks?.all) {
    doc.history.transaction('Change Pattern Fill', () => { l.fill = { ...l.fill, pattern: p.id }; l.invalidate(); });
    doc.layersChanged();
  }
}

/** Edit › Define Pattern…: selection bounds (or the whole image) of the visible composite. */
async function definePattern() {
  const doc = app.activeDoc;
  if (!doc) return;
  const b = doc.selection.empty ? { x: 0, y: 0, w: doc.width, h: doc.height } : doc.selection.bounds!;
  if (b.w < 1 || b.h < 1) { toast('Could not define pattern because the selected area is empty.', 'error'); return; }
  if (b.w > 4000 || b.h > 4000) { toast('Could not define pattern because the selected area is too large (max 4000 × 4000 px).', 'error'); return; }
  const src = cropCanvas(doc.getComposite(), b);
  if (!doc.selection.empty) {
    // pixels outside a non-rectangular selection become transparent
    const x = ctx2d(src); x.globalCompositeOperation = 'destination-in'; x.drawImage(doc.selection.mask!, -b.x, -b.y);
  }
  const prev = createCanvas(96, 96), px = ctx2d(prev);
  const s = Math.min(96 / b.w, 96 / b.h, 1);
  px.imageSmoothingQuality = 'high';
  px.drawImage(src, (96 - b.w * s) / 2, (96 - b.h * s) / 2, b.w * s, b.h * s);
  prev.className = 'pt-define-prev thumb';
  let n = 1;
  while (resources.patterns.some(p => p.name === `Pattern ${n}`)) n++;
  const inp = h('input.field', { type: 'text', value: `Pattern ${n}`, style: { width: '220px' } }) as HTMLInputElement;
  inp.addEventListener('keydown', e => e.stopPropagation());
  const body = h('div.pt-define', null, prev, h('div.form', null, h('div.form-row', null, h('label', null, 'Name:'), inp), h('div.kbd-hint', null, `${b.w} × ${b.h} px`)));
  const d = openDialog({ title: 'Pattern Name', body, buttons: [{ label: 'OK', primary: true, value: 'ok' }, { label: 'Cancel', value: null }] });
  setTimeout(() => inp.select());
  if (await d.result !== 'ok') return;
  const p = addPattern(inp.value.trim() || `Pattern ${n}`, src, 'Custom');
  selected = p;
  collapsed.delete('Custom');
  applyPattern(p);
  toast(`Pattern "${p.name}" defined`, 'success');
}
registerCommand({ id: 'edit.definePattern', run: definePattern, enabled: () => !!app.activeDoc });

async function rename(p: PatternEx) {
  const name = await promptDialog('Pattern Name', 'Name:', p.name);
  if (name && name !== p.name) renamePattern(p, name);
}
function del(p: PatternEx) { if (selected === p) selected = null; deletePattern(p); }

registerPanel({
  id: 'patterns', title: 'Patterns', icon: 'patterns', defaultHeight: 260, minHeight: 100,
  create(el) {
    let filter = '';
    const search = searchField('Search Patterns', v => { filter = v; render(); });
    const list = h('div.panel-scroll.pf-list');
    let dragged: PatternEx | null = null;
    const trash = iconButton('trash', 'Delete pattern (or drag a pattern here)', () => { if (selected) del(selected); else toast('Select a pattern to delete.', 'info'); });
    dropTarget(trash, () => { if (dragged) del(dragged); dragged = null; });
    el.append(h('div.pf-top', null, search), list, h('div.panel-footer', null,
      iconButton('new-layer', 'Create new pattern from the selection (Define Pattern)', () => definePattern()),
      trash));
    const render = () => {
      const cur = bucketPattern();
      renderFolders<PatternEx>(list, {
        cls: 'pt', collapsed, filter: () => filter, mode: () => pref.mode,
        groups: () => patternFolders().map(name => ({ name, items: (resources.patterns as PatternEx[]).filter(p => (p.group || 'Custom') === name) })),
        name: p => p.name,
        thumb: (p, mode) => h('div.pt-thumb', { style: { backgroundImage: `url(${thumbURL(p.canvas, mode === 'large' ? 128 : 64)})` } }),
        isSelected: p => (selected ? p === selected : p.id === cur),
        onToggle: savePref,
        onPick: p => { selected = p; applyPattern(p); render(); },
        onDblClick: p => rename(p),
        onDragStart: p => { dragged = p; },
        onContext: (p, e) => contextMenu(e, [
          { label: 'Rename Pattern...', action: () => rename(p) },
          { label: 'Delete Pattern', action: () => del(p) },
          '-',
          { label: 'Define Pattern from Selection...', action: () => definePattern() },
        ]),
      });
    };
    rerender = render;
    render();
    onPresets('patterns', render);
    events.on('toolOptions', () => { if (el.isConnected) render(); });
    return { onShow: render };
  },
  menu(): MenuEntry[] {
    const setMode = (m: ViewMode) => { pref.mode = m; savePref(); rerender(); };
    return [
      { label: 'New Pattern...', action: () => definePattern(), enabled: !!app.activeDoc },
      '-',
      { label: 'Rename Pattern...', enabled: !!selected, action: () => selected && rename(selected) },
      { label: 'Delete Pattern', enabled: !!selected, action: () => selected && del(selected) },
      '-',
      { label: 'Small Thumbnail', radio: true, checked: pref.mode === 'small', action: () => setMode('small') },
      { label: 'Large Thumbnail', radio: true, checked: pref.mode === 'large', action: () => setMode('large') },
      { label: 'Small List', radio: true, checked: pref.mode === 'list-small', action: () => setMode('list-small') },
      { label: 'Large List', radio: true, checked: pref.mode === 'list-large', action: () => setMode('list-large') },
      '-',
      { label: 'Reset Patterns...', action: async () => { if (await confirmDialog('Reset Patterns', 'Replace current patterns with the default patterns?') === 'ok') { selected = null; resetPatterns(); } } },
    ];
  },
});
