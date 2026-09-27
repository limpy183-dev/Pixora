// History panel: snapshots (with thumbnails and the History Brush source box), the base state and every history
// state (click to jump, later states dimmed), footer buttons New Document from Current State / New Snapshot /
// Delete State, and the flyout menu (Step Forward / Backward, New Snapshot..., Delete, Clear History, New Document).
import './history.css';
import { app } from '../../core/app';
import { events } from '../../core/events';
import type { PixDocument } from '../../core/document';
import type { HistorySnapshot } from '../../core/history';
import { registerCommands } from '../../core/commands';
import { createCanvas, ctx2d } from '../../core/canvas';
import { registerPanel } from '../../ui/panels';
import { clear, h } from '../../ui/dom';
import { hasIcon, icon, registerIcons } from '../../ui/icons';
import { iconButton } from '../../ui/widgets';
import { confirmDialog, promptDialog } from '../../ui/dialog';
import { contextMenu, type MenuEntry } from '../../ui/menu';
import { duplicateDocument } from '../image/dialogs';

registerIcons({ 'hp-camera': '<path d="M4 8h3l1.5-2h7L17 8h3v11H4z"/><circle cx="12" cy="13" r="3.4"/>' });

const thumbs = new WeakMap<HistorySnapshot, string>();
function thumbOf(doc: PixDocument): string {
  const c = doc.getComposite(), k = 28 / Math.max(c.width, c.height);
  const t = createCanvas(Math.max(1, Math.round(c.width * k)), Math.max(1, Math.round(c.height * k)));
  const x = ctx2d(t); x.imageSmoothingQuality = 'high'; x.drawImage(c, 0, 0, t.width, t.height);
  return t.toDataURL();
}
const D = () => app.activeDoc;
// thumbnail of the initial snapshot, taken while the document is still in that state
events.on('docs', () => { for (const d of app.docs) { const s0 = d.history.snapshots[0]; if (s0 && !thumbs.has(s0) && d.history.index === 0) thumbs.set(s0, thumbOf(d)); } });
const H = (d: PixDocument) => d.history as any;

export async function newSnapshot(doc: PixDocument, ask = false) {
  let name = `Snapshot ${doc.history.snapshots.length}`;
  if (ask) { const n = await promptDialog('New Snapshot', 'Name:', name); if (n === null) return; name = n || name; }
  doc.history.snapshot(name);
  const s = doc.history.snapshots[doc.history.snapshots.length - 1];
  thumbs.set(s, thumbOf(doc));
  events.emit('history', doc);
}
function deleteState(doc: PixDocument) {
  const hs = doc.history;
  if (!hs.index) return;
  hs.goTo(hs.index - 1);
  hs.entries.length = hs.index;
  events.emit('history', doc);
}
async function clearHistory(doc: PixDocument) {
  if ((await confirmDialog('Clear History', 'Clear the history states? This cannot be undone. Snapshots are kept.')) !== 'ok') return;
  doc.history.clear();
}
function newDocFromState(doc: PixDocument) {
  const hs = doc.history;
  const name = hs.index ? hs.entries[hs.index - 1].name : hs.baseName;
  app.addDocument(duplicateDocument(doc, name));
}

registerPanel({
  id: 'history', title: 'History', icon: 'history', defaultHeight: 260,
  create(el) {
    const list = h('div.hp-list.panel-scroll');
    const foot = h('div.panel-footer', null,
      iconButton('file-new', 'Create new document from current state', () => { const d = D(); if (d) newDocFromState(d); }),
      iconButton('hp-camera', 'Create new snapshot (Alt-click to name it)', e => { const d = D(); if (d) void newSnapshot(d, e.altKey); }),
      iconButton('trash', 'Delete current state', () => { const d = D(); if (d) deleteState(d); }));
    el.append(h('div.hp-panel', null, list, foot));
    let lastDoc: PixDocument | null = null;
    const draw = () => {
      clear(list);
      const doc = D();
      if (!doc) return;
      const hs = doc.history;
      if (lastDoc !== doc) { lastDoc = doc; if (hs.snapshots[0] && !thumbs.has(hs.snapshots[0]) && hs.index === 0) thumbs.set(hs.snapshots[0], thumbOf(doc)); }
      const src = H(doc).brushSource ?? 0;
      // snapshots
      hs.snapshots.forEach((s, i) => {
        const box = h('button.hp-src', { type: 'button', class: src === i ? 'on' : '', title: 'Sets the source for the history brush' }, src === i ? icon('history-brush', 13) : null);
        box.addEventListener('click', e => { e.stopPropagation(); H(doc).brushSource = i; events.emit('history', doc); });
        const t = thumbs.get(s);
        const row = h('div.hp-row.hp-snap', { title: `Revert to “${s.name}”` }, box,
          t ? h('img.hp-thumb', { src: t, alt: '' }) : h('span.hp-thumb.hp-noimg', null, icon('image', 16)),
          h('span.hp-name', null, s.name));
        row.addEventListener('click', () => { hs.revertToSnapshot(i); });
        row.addEventListener('dblclick', async () => { const n = await promptDialog('Rename Snapshot', 'Name:', s.name); if (n) { s.name = n; events.emit('history', doc); } });
        row.addEventListener('contextmenu', e => {
          e.preventDefault();
          contextMenu(e, [
            { label: 'Revert to Snapshot', action: () => hs.revertToSnapshot(i) },
            { label: 'Rename Snapshot...', action: async () => { const n = await promptDialog('Rename Snapshot', 'Name:', s.name); if (n) { s.name = n; events.emit('history', doc); } } },
            { label: 'Delete Snapshot', enabled: i > 0, action: () => { hs.snapshots.splice(i, 1); if (src >= hs.snapshots.length) H(doc).brushSource = 0; events.emit('history', doc); } },
          ]);
        });
        list.append(row);
      });
      list.append(h('div.hp-sep'));
      // base state + entries
      const state = (n: number, name: string, ic?: string) => {
        const row = h('div.hp-row', { class: `${n === hs.index ? 'active' : ''} ${n > hs.index ? 'undone' : ''}`, title: name },
          h('span.hp-src.hp-nosrc'), h('span.hp-ico', null, icon(ic || (n === 0 ? 'file' : 'history'), 14)), h('span.hp-name', null, name));
        row.addEventListener('click', () => hs.goTo(n));
        list.append(row);
        return row;
      };
      state(0, hs.baseName, hs.baseName === 'Open' ? 'folder-open' : 'file-new');
      hs.entries.forEach((e, i) => state(i + 1, e.name, e.icon && hasIcon(e.icon) ? e.icon : undefined));
      list.querySelector('.hp-row.active')?.scrollIntoView({ block: 'nearest' });
    };
    let raf = 0;
    const later = () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; draw(); }); };
    draw();
    const offs = [events.on('history', later), events.on('activeDoc', later), events.on('docs', later)];
    return { onShow: draw, destroy: () => offs.forEach(f => f()) };
  },
  menu: (): MenuEntry[] => [
    { label: 'Step Forward', cmd: 'edit.stepForward' },
    { label: 'Step Backward', cmd: 'edit.stepBackward' },
    '-',
    { label: 'New Snapshot...', cmd: 'history.newSnapshot' },
    { label: 'Delete', cmd: 'history.deleteState' },
    { label: 'Clear History', cmd: 'history.clear' },
    '-',
    { label: 'New Document', cmd: 'history.newDocument' },
  ],
});

const hasDoc = () => !!D();
registerCommands([
  { id: 'history.newSnapshot', label: 'New Snapshot...', enabled: hasDoc, run: () => { const d = D(); if (d) void newSnapshot(d, true); } },
  { id: 'history.deleteState', label: 'Delete', enabled: () => !!D()?.history.index, run: () => { const d = D(); if (d) deleteState(d); } },
  { id: 'history.clear', label: 'Clear History', enabled: () => !!D()?.history.entries.length, run: () => { const d = D(); if (d) void clearHistory(d); } },
  { id: 'history.newDocument', label: 'New Document', enabled: hasDoc, run: () => { const d = D(); if (d) newDocFromState(d); } },
]);
