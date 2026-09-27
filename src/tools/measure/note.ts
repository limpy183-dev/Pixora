// Note Tool (I): annotations stored in doc.extra.notes, edited in the Notes panel.
import { app, type Tool } from '../../core/app';
import type { PixDocument } from '../../core/document';
import { events } from '../../core/events';
import { viewportHooks, viewOptions, type Viewport } from '../../core/viewport';
import { toCss } from '../../core/color';
import type { RGB } from '../../core/types';
import { textField, colorSwatch, button, separator, label, iconButton } from '../../ui/widgets';
import { runCommand } from '../../core/commands';
import { confirmDialog } from '../../ui/dialog';
import { isPanelVisible, hidePanel, showPanel } from '../../ui/dock';
import { measureEvents } from './common';

export interface Note { id: number; x: number; y: number; author: string; color: RGB; text: string; date: string }
export const getNotes = (doc: PixDocument | null): Note[] => (doc?.extra?.notes as Note[]) || [];

const settings = { author: localStorage.getItem('pixora.noteAuthor') || '', color: { r: 255, g: 221, b: 0 } as RGB, show: true };
/** Currently selected note per document. */
const current = new WeakMap<PixDocument, number>();
export const currentNoteId = (doc: PixDocument | null) => (doc ? current.get(doc) ?? 0 : 0);
export function selectNote(doc: PixDocument, id: number, focus = false) {
  current.set(doc, id);
  measureEvents.emit('notes', doc);
  if (focus) (window as any).__pixoraNoteFocus = true;
  doc.redrawOverlay();
}
export function setNotes(doc: PixDocument, name: string, notes: Note[]) {
  doc.history.transaction(name, () => { doc.extra = { ...doc.extra, notes }; });
  measureEvents.emit('notes', doc);
  doc.redrawOverlay();
}
export function updateNote(doc: PixDocument, id: number, patch: Partial<Note>, name = 'Edit Note') {
  setNotes(doc, name, getNotes(doc).map(n => (n.id === id ? { ...n, ...patch } : n)));
}
export function deleteNote(doc: PixDocument, id: number) {
  const list = getNotes(doc), i = list.findIndex(n => n.id === id);
  if (i < 0) return;
  const rest = list.filter(n => n.id !== id);
  setNotes(doc, 'Delete Note', rest);
  selectNote(doc, rest[Math.min(i, rest.length - 1)]?.id ?? 0);
}
export async function clearNotes(doc: PixDocument) {
  if (!getNotes(doc).length) return;
  if (await confirmDialog('Delete All Notes', 'Are you sure you want to delete all notes?') !== 'ok') return;
  setNotes(doc, 'Delete All Notes', []);
  selectNote(doc, 0);
}
export const notesVisible = () => settings.show && viewOptions.extras && (viewOptions as any).notes !== false;

const ICON = 18;
function noteAt(view: Viewport, doc: PixDocument, sx: number, sy: number): Note | null {
  if (!notesVisible()) return null;
  const list = getNotes(doc);
  for (let i = list.length - 1; i >= 0; i--) {
    const p = view.docToScreen(list[i].x, list[i].y);
    if (sx >= p.x && sy >= p.y && sx <= p.x + ICON && sy <= p.y + ICON) return list[i];
  }
  return null;
}

function drawNotes(ctx: CanvasRenderingContext2D, view: Viewport, doc: PixDocument) {
  const list = getNotes(doc);
  if (!list.length || !notesVisible()) return;
  const sel = currentNoteId(doc);
  for (const n of list) {
    const pos = drag && drag.id === n.id ? drag.pos : n;
    const p = view.docToScreen(pos.x, pos.y);
    const x = Math.round(p.x) + 0.5, y = Math.round(p.y) + 0.5, f = 6;
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,.35)'; ctx.shadowBlur = 3; ctx.shadowOffsetY = 1;
    ctx.fillStyle = toCss(n.color);
    ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + ICON - f, y); ctx.lineTo(x + ICON, y + f); ctx.lineTo(x + ICON, y + ICON); ctx.lineTo(x, y + ICON); ctx.closePath(); ctx.fill();
    ctx.shadowColor = 'transparent';
    ctx.strokeStyle = n.id === sel ? '#1473e6' : 'rgba(0,0,0,.75)'; ctx.lineWidth = n.id === sel ? 2 : 1; ctx.stroke();
    ctx.lineWidth = 1; ctx.strokeStyle = 'rgba(0,0,0,.55)';
    ctx.beginPath(); ctx.moveTo(x + ICON - f, y); ctx.lineTo(x + ICON - f, y + f); ctx.lineTo(x + ICON, y + f);
    for (const ly of [7, 10.5, 14]) { ctx.moveTo(x + 4, y + ly); ctx.lineTo(x + ICON - 4, y + ly); }
    ctx.stroke();
    ctx.restore();
  }
}
viewportHooks.overlay.push(drawNotes);

let drag: { id: number; start: { x: number; y: number }; orig: { x: number; y: number }; pos: { x: number; y: number }; moved: boolean } | null = null;
let nextId = 1;

const tool: Tool = {
  id: 'note', name: 'Note Tool', group: 'eyedropper', icon: 'note', shortcut: 'I', order: 3,
  settings,
  cursor: () => {
    const v = app.viewport, d = app.activeDoc;
    return v && d && noteAt(v, d, v.pointer.sx, v.pointer.sy) ? 'move' : 'copy';
  },
  options(bar) {
    const author = textField(settings.author, v => { settings.author = v; localStorage.setItem('pixora.noteAuthor', v); app.saveToolSettings(tool); }, { width: 140, placeholder: 'Author' });
    author.title = 'Author of new notes';
    const color = colorSwatch(settings.color, c => {
      settings.color = c; app.saveToolSettings(tool);
      const d = app.activeDoc, id = currentNoteId(d);
      if (d && id) updateNote(d, id, { color: c }, 'Note Color');
    }, { title: 'Note color', size: 20 });
    const clear = button('Clear All', () => app.activeDoc && clearNotes(app.activeDoc), { cls: 'small', title: 'Delete all notes in this document' });
    const panelBtn = iconButton('notes', 'Show or Hide Notes Panel', () => { if (isPanelVisible('notes')) hidePanel('notes'); else showPanel('notes'); });
    bar.append(label('Author:'), author, separator(), label('Color:'), color, separator(), clear, separator(), panelBtn);
  },
  pointerDown(p, doc) {
    const n = noteAt(app.viewport!, doc, p.sx, p.sy);
    if (n) {
      selectNote(doc, n.id);
      drag = { id: n.id, start: { x: p.x, y: p.y }, orig: { x: n.x, y: n.y }, pos: { x: n.x, y: n.y }, moved: false };
      return;
    }
    if (p.x < 0 || p.y < 0 || p.x > doc.width || p.y > doc.height) return;
    for (const x of getNotes(doc)) nextId = Math.max(nextId, x.id + 1);
    const note: Note = { id: nextId++, x: Math.round(p.x), y: Math.round(p.y), author: settings.author, color: { ...settings.color }, text: '', date: new Date().toLocaleString() };
    setNotes(doc, 'New Note', [...getNotes(doc), note]);
    selectNote(doc, note.id, true);
    runCommand('window.showPanel', 'notes');
  },
  pointerMove(p, doc) {
    if (!drag) return;
    drag.pos = { x: Math.round(drag.orig.x + p.x - drag.start.x), y: Math.round(drag.orig.y + p.y - drag.start.y) };
    drag.moved = drag.moved || Math.hypot(p.x - drag.start.x, p.y - drag.start.y) * (app.viewport?.zoom || 1) > 2;
    doc.redrawOverlay();
  },
  pointerUp(_p, doc) {
    const d = drag;
    drag = null;
    if (d?.moved) updateNote(doc, d.id, { x: d.pos.x, y: d.pos.y }, 'Move Note');
  },
  dblclick(p, doc) {
    const n = noteAt(app.viewport!, doc, p.sx, p.sy);
    if (n) { selectNote(doc, n.id, true); runCommand('window.showPanel', 'notes'); }
  },
  keyDown(e, doc) {
    if (!doc || e.ctrlKey || e.metaKey) return false;
    if ((e.key === 'Delete' || e.key === 'Backspace') && currentNoteId(doc)) { deleteNote(doc, currentNoteId(doc)); return true; }
    return false;
  },
};
app.registerTool(tool);

// double-clicking a note with any tool opens the Notes panel
events.on('activeDoc', d => { if (d && !current.has(d)) current.set(d, getNotes(d)[0]?.id ?? 0); });
window.addEventListener('dblclick', e => {
  const v = app.viewport, d = app.activeDoc;
  if (!v || !d || e.target !== v.overlay || app.currentTool?.id === 'note') return;
  const r = v.overlay.getBoundingClientRect();
  const n = noteAt(v, d, e.clientX - r.left, e.clientY - r.top);
  if (n) { selectNote(d, n.id, true); runCommand('window.showPanel', 'notes'); }
}, true);
