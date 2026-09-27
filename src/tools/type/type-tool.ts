// Horizontal Type Tool (T), Vertical Type Tool, Horizontal / Vertical Type Mask Tools.
// Click = point text, drag = paragraph text box; click an existing text layer to edit it. In-canvas editing with a
// hidden textarea (IME friendly): caret / selection with mouse (double-click word, triple-click paragraph) and
// keyboard (arrows, Ctrl word jumps, Home/End, Shift to extend), Backspace / Delete, Enter, Ctrl+A, copy / cut /
// paste, Ctrl+Shift+</> size, Ctrl+B/I/U faux styles. Paragraph boxes resize with handles. Ctrl+Enter, Esc or the
// ✓ button commit, ⊘ cancels. Type masks turn the committed text into a selection.
import './type.css';
import { app, type Tool, type ToolPointer } from '../../core/app';
import type { PixDocument } from '../../core/document';
import type { Layer } from '../../core/layer';
import { events } from '../../core/events';
import { hooks } from '../../core/registry';
import { createCanvas, ctx2d } from '../../core/canvas';
import type { Point, RGB } from '../../core/types';
import type { Viewport } from '../../core/viewport';
import { h } from '../../ui/dom';
import { colorSwatch, iconButton, numberField, select, separator, showPop, type SelectOption } from '../../ui/widgets';
import { runCommand } from '../../core/commands';
import { svgCursor } from '../../ui/cursors';
import { toast } from '../../ui/toast';
import { registerIcons } from '../../ui/icons';
import { isDialogOpen } from '../../ui/dialog';
import { TextLayer, cloneChar, defaultCharStyle, type AntiAlias, type CharStyle, type TextAlign, type TextLayout } from '../../layers/text-layer';
import { FONT_STYLES, fontPicker } from './fonts';

registerIcons({
  'tp-left': '<path d="M4 6h16M4 10h10M4 14h16M4 18h10"/>',
  'tp-center': '<path d="M4 6h16M7 10h10M4 14h16M7 18h10"/>',
  'tp-right': '<path d="M4 6h16M10 10h10M4 14h16M10 18h10"/>',
  'tp-orient': '<path d="M4 5h8M8 5v11"/><path d="M15 9v10M13 17l2 2 2-2"/>',
  'tp-panel': '<rect x="4" y="4" width="16" height="16" rx="2"/><path d="M8 9h8M12 9v7"/>',
  'tp-warp': '<path d="M3 15c3-5 6-5 9 0s6 5 9 0"/><path d="M7 7h10M12 7v5"/>',
});

// ------------------------------------------------------------------ settings shared by the four tools
export const typeSettings = {
  font: 'Arial', fontStyle: 'Regular', size: 12, antiAlias: 'sharp' as AntiAlias, align: 'left' as TextAlign,
  color: null as RGB | null,                                      // null = use the foreground colour
  char: {} as Partial<CharStyle>,                                 // other Character panel defaults for new text
  para: {} as Record<string, any>,                                // Paragraph panel defaults for new text
};
const SIZES = [6, 7, 8, 9, 10, 11, 12, 14, 18, 24, 30, 36, 48, 60, 72];
const AA: SelectOption<AntiAlias>[] = [{ value: 'none', label: 'None' }, { value: 'sharp', label: 'Sharp' }, { value: 'crisp', label: 'Crisp' }, { value: 'strong', label: 'Strong' }, { value: 'smooth', label: 'Smooth' }];

// ------------------------------------------------------------------ editing session
interface Ed {
  doc: PixDocument; layer: TextLayer; caret: number; anchor: number; isNew: boolean; mask: boolean;
  tx: { commit(name?: string): void; cancel(): void } | null;
  typing: CharStyle | null;                   // style for the next typed text (collapsed selection)
  blinkOn: boolean; blink: number;
  drag: null | { kind: 'select' } | { kind: 'box'; h: number; start: Point; w0: number; h0: number; x0: number; y0: number };
}
let ed: Ed | null = null;
let creating: { start: Point; cur: Point; vertical: boolean; mask: boolean } | null = null;
const ta = h('textarea.tp-ime', { autocomplete: 'off', spellcheck: false, 'aria-label': 'Text input' }) as HTMLTextAreaElement;
document.body.append(ta);
let composing = false;

export const editing = () => ed;
const selRange = (e: Ed): [number, number] => [Math.min(e.caret, e.anchor), Math.max(e.caret, e.anchor)];
const layoutOf = (e: Ed): TextLayout => e.layer.getLayout(e.doc);
const ptPx = (doc: PixDocument) => (doc.resolution || 72) / 72;

function touched(e: Ed) {
  e.layer.invalidate();
  e.blinkOn = true;
  if (!e.mask) e.doc.pixelsChanged(e.layer, null);
  e.doc.redrawOverlay();
  placeIme(e);
  events.emit('toolOptions');
}
function placeIme(e: Ed) {
  const v = app.viewport;
  const seg = e.layer.caretSegment(layoutOf(e), e.caret);
  if (!v || !seg) return;
  const p = e.layer.matrix().transformPoint(new DOMPoint(seg[2], seg[3]));
  const s = v.docToScreen(p.x, p.y);
  const ov = document.querySelector('.view-overlay')?.getBoundingClientRect();
  ta.style.left = `${(ov?.left || 0) + s.x}px`; ta.style.top = `${(ov?.top || 0) + s.y}px`;
}

function charStyleForNew(doc: PixDocument): CharStyle {
  return { ...defaultCharStyle(), ...typeSettings.char, font: typeSettings.font, fontStyle: typeSettings.fontStyle, size: typeSettings.size, color: { ...(typeSettings.color || app.fg) } };
}
function begin(doc: PixDocument, layer: TextLayer, isNew: boolean, mask: boolean, caret = layer.length) {
  if (ed) end(true);
  ed = { doc, layer, caret, anchor: caret, isNew, mask, tx: mask ? null : doc.history.begin(isNew ? 'Type Tool' : 'Edit Type Layer', 'type'), typing: null, blinkOn: true, blink: 0, drag: null };
  if (isNew && !mask) { doc.addLayer(layer, { above: doc.activeLayer, select: true }); doc.layersChanged(); }
  ed.blink = window.setInterval(() => { if (ed) { ed.blinkOn = !ed.blinkOn; ed.doc.redrawOverlay(); } }, 530);
  ta.value = '';
  setTimeout(() => { if (!isDialogOpen()) ta.focus({ preventScroll: true }); });
  touched(ed);
  (document.querySelector('.optionsbar') as any)?.rebuild?.();
}
/** Finish editing. apply=false discards all changes of the session. */
export function end(apply: boolean) {
  const e = ed;
  if (!e) return;
  ed = null;
  clearInterval(e.blink);
  ta.blur();
  const empty = !e.layer.text.trim();
  if (e.mask) {
    if (apply && !empty) {
      const c = e.layer.renderTo(e.doc, 1, '#000', false);
      if (c) {
        const m = createCanvas(e.doc.width, e.doc.height);
        ctx2d(m).drawImage(c.canvas, c.x, c.y);
        e.doc.history.transaction('Type Mask', () => e.doc.selection.apply(m, 'replace'), 'selection');
      }
    }
  } else if (!apply || (e.isNew && empty)) {
    e.tx?.cancel();
  } else {
    if (empty) { e.doc.removeLayer(e.layer); }      // edited down to nothing: PS deletes the layer
    else e.layer.syncName();
    e.tx?.commit(e.isNew ? 'Type Tool' : 'Edit Type Layer');
  }
  e.doc.layersChanged();
  e.doc.invalidate();
  e.doc.redrawOverlay();
  (document.querySelector('.optionsbar') as any)?.rebuild?.();
}

// ------------------------------------------------------------------ text operations
function insert(e: Ed, str: string) {
  const [a, b] = selRange(e);
  const style = e.typing || (a < b ? e.layer.styleAt(a) : e.layer.caretStyle(a));
  if (b > a) e.layer.deleteRange(a, b);
  e.layer.insertText(a, str, style);
  e.caret = e.anchor = a + str.replace(/\r\n?/g, '\n').length;
  e.typing = null;
  touched(e);
}
function del(e: Ed, dir: -1 | 1, word = false) {
  const [a, b] = selRange(e);
  if (b > a) { e.layer.deleteRange(a, b); e.caret = e.anchor = a; touched(e); return; }
  const t = e.layer.text;
  let p = e.caret;
  if (dir < 0) { if (p === 0) return; p = word ? wordBoundary(t, p, -1) : prevChar(t, p); e.layer.deleteRange(p, e.caret); e.caret = e.anchor = p; }
  else { if (p >= t.length) return; const q = word ? wordBoundary(t, p, 1) : nextChar(t, p); e.layer.deleteRange(p, q); }
  touched(e);
}
const isLow = (c: number) => c >= 0xdc00 && c <= 0xdfff;
const prevChar = (t: string, p: number) => (p >= 2 && isLow(t.charCodeAt(p - 1)) ? p - 2 : Math.max(0, p - 1));
const nextChar = (t: string, p: number) => (p < t.length - 1 && isLow(t.charCodeAt(p + 1)) ? p + 2 : Math.min(t.length, p + 1));
const isWord = (ch: string) => /[\p{L}\p{N}_]/u.test(ch);
function wordBoundary(t: string, p: number, dir: -1 | 1): number {
  if (dir < 0) { while (p > 0 && !isWord(t[p - 1])) p--; while (p > 0 && isWord(t[p - 1])) p--; return p; }
  while (p < t.length && !isWord(t[p])) p++; while (p < t.length && isWord(t[p])) p++; return p;
}
function wordAt(t: string, p: number): [number, number] {
  let a = p, b = p;
  if (!isWord(t[p] || '') && p > 0 && isWord(t[p - 1])) a = b = p - 1;
  while (a > 0 && isWord(t[a - 1])) a--;
  while (b < t.length && isWord(t[b])) b++;
  return a === b ? [p, Math.min(t.length, p + 1)] : [a, b];
}
function moveVert(e: Ed, dir: -1 | 1): number {
  const L = layoutOf(e), li = e.layer.lineOf(L, e.caret), ln = L.lines[li + dir];
  if (!ln) return dir < 0 ? 0 : e.layer.length;
  const seg = e.layer.caretSegment(L, e.caret);
  return seg ? e.layer.indexInLine(L, ln, L.vertical ? seg[1] : seg[0]) : e.caret;
}
function lineEdge(e: Ed, end: boolean): number {
  const L = layoutOf(e), ln = L.lines[e.layer.lineOf(L, e.caret)];
  if (!ln) return e.caret;
  let p = end ? ln.end : ln.start;
  if (end && !ln.hard && p > ln.start && /\s/.test(e.layer.text[p - 1] || '')) p--;
  return p;
}
/** Apply a character style patch to the selection (or the typing style when collapsed). */
export function applyCharPatch(patch: Partial<CharStyle>) {
  const e = ed;
  if (e) {
    const [a, b] = selRange(e);
    if (b > a) e.layer.setStyleRange(a, b, patch);
    else if (!e.layer.length) e.layer.setStyleAll(patch);
    else e.typing = { ...cloneChar(e.typing || e.layer.caretStyle(a)), ...patch };
    touched(e);
    return true;
  }
  return false;
}
export function applyParaPatch(patch: Record<string, any>) {
  const e = ed;
  if (!e) return false;
  const [a, b] = selRange(e);
  e.layer.setParaRange(a, b, patch);
  touched(e);
  return true;
}
/** Insert text at the caret of the current editing session (Glyphs panel, Paste Lorem Ipsum). */
export function insertAtCaret(str: string): boolean {
  if (!ed) return false;
  insert(ed, str);
  setTimeout(() => { if (!isDialogOpen()) ta.focus({ preventScroll: true }); });
  return true;
}
/** Start editing a text layer with [a, b) selected (Find and Replace). */
export function editRange(doc: PixDocument, layer: TextLayer, a: number, b: number) {
  if (!ed || ed.layer !== layer) {
    if (app.activeTool?.id !== (layer.vertical ? 'type-vertical' : 'type')) app.setTool(layer.vertical ? 'type-vertical' : 'type');
    doc.setActiveLayer(layer);
    begin(doc, layer, false, false, b);
  }
  if (!ed) return;
  ed.anchor = a; ed.caret = b; ed.typing = null;
  touched(ed);
}
/** Replace the editing selection (Find and Replace "Change"). */
export function replaceSelection(str: string) { if (ed) insert(ed, str); }
export const editingRange = (): [number, number] | null => (ed ? selRange(ed) : null);
/** Current style shown in the options bar / Character panel while editing. */
export function editStyle(): { style: CharStyle; mixed: Set<string> } | null {
  const e = ed;
  if (!e) return null;
  const [a, b] = selRange(e);
  if (b > a) return e.layer.rangeStyle(a, b) as any;
  return { style: e.typing || e.layer.caretStyle(a), mixed: new Set() };
}

// ------------------------------------------------------------------ keyboard (hidden textarea)
ta.addEventListener('compositionstart', () => { composing = true; });
ta.addEventListener('compositionend', () => { composing = false; if (ed && ta.value) { insert(ed, ta.value); } ta.value = ''; });
ta.addEventListener('input', () => { if (!ed || composing) return; if (ta.value) insert(ed, ta.value); ta.value = ''; });
ta.addEventListener('copy', ev => { const e = ed; if (!e) return; const [a, b] = selRange(e); if (b > a) { ev.clipboardData?.setData('text/plain', e.layer.text.slice(a, b)); ev.preventDefault(); } });
ta.addEventListener('cut', ev => { const e = ed; if (!e) return; const [a, b] = selRange(e); if (b > a) { ev.clipboardData?.setData('text/plain', e.layer.text.slice(a, b)); ev.preventDefault(); del(e, 1); } });
ta.addEventListener('paste', ev => { const e = ed; if (!e) return; const t = ev.clipboardData?.getData('text/plain'); ev.preventDefault(); if (t) insert(e, t); });
ta.addEventListener('keydown', ev => {
  const e = ed;
  if (!e || composing) return;
  const ctrl = ev.ctrlKey || ev.metaKey, t = e.layer.text;
  let handled = true;
  const move = (p: number) => { e.caret = Math.max(0, Math.min(t.length, p)); if (!ev.shiftKey) e.anchor = e.caret; e.typing = null; touched(e); };
  const vert = e.layer.vertical;
  switch (ev.key) {
    case 'ArrowLeft': if (vert) move(moveVert(e, 1)); else if (!ev.shiftKey && e.caret !== e.anchor) move(Math.min(e.caret, e.anchor)); else move(ctrl ? wordBoundary(t, e.caret, -1) : prevChar(t, e.caret)); break;
    case 'ArrowRight': if (vert) move(moveVert(e, -1)); else if (!ev.shiftKey && e.caret !== e.anchor) move(Math.max(e.caret, e.anchor)); else move(ctrl ? wordBoundary(t, e.caret, 1) : nextChar(t, e.caret)); break;
    case 'ArrowUp': move(vert ? prevChar(t, e.caret) : moveVert(e, -1)); break;
    case 'ArrowDown': move(vert ? nextChar(t, e.caret) : moveVert(e, 1)); break;
    case 'Home': move(ctrl ? 0 : lineEdge(e, false)); break;
    case 'End': move(ctrl ? t.length : lineEdge(e, true)); break;
    case 'Backspace': del(e, -1, ctrl); break;
    case 'Delete': del(e, 1, ctrl); break;
    case 'Enter': if (ctrl || ev.code === 'NumpadEnter') end(true); else insert(e, '\n'); break;
    case 'Escape': end(true); break;
    case 'Tab': insert(e, '\t'); break;
    default:
      handled = false;
      if (ctrl) {
        const k = ev.key.toLowerCase();
        if (k === 'a') { e.anchor = 0; e.caret = t.length; touched(e); handled = true; }
        else if (k === 'z') { handled = true; toast('Undo is available after committing the text.', 'info'); }
        else if (ev.shiftKey && (ev.key === '>' || ev.key === '.' || ev.key === '<' || ev.key === ',')) {
          const st = editStyle()?.style; const up = ev.key === '>' || ev.key === '.';
          if (st) applyCharPatch({ size: Math.max(0.5, Math.round((st.size + (up ? 2 : -2)) * 10) / 10) }); handled = true;
        } else if (ev.shiftKey && k === 'b') { const st = editStyle()?.style; if (st) applyCharPatch({ fauxBold: !st.fauxBold }); handled = true; }
        else if (ev.shiftKey && k === 'i') { const st = editStyle()?.style; if (st) applyCharPatch({ fauxItalic: !st.fauxItalic }); handled = true; }
        else if (ev.shiftKey && k === 'u') { const st = editStyle()?.style; if (st) applyCharPatch({ underline: !st.underline }); handled = true; }
        else if (ev.shiftKey && k === 'k') { const st = editStyle()?.style; if (st) applyCharPatch({ allCaps: !st.allCaps }); handled = true; }
        else if (k === 'c' || k === 'x' || k === 'v') return;          // native clipboard events
      }
  }
  if (handled) { ev.preventDefault(); ev.stopPropagation(); }
});
ta.addEventListener('blur', () => { setTimeout(() => { if (ed && document.activeElement !== ta && !document.activeElement?.closest('.optionsbar, .panel, .popover, .dialog, .menu')) ta.focus({ preventScroll: true }); }, 0); });

// ------------------------------------------------------------------ pointer & hit testing
function localPoint(e: Ed, p: Point): Point {
  const q = e.layer.matrix().inverse().transformPoint(new DOMPoint(p.x, p.y));
  const [x, y] = e.layer.unwarpLocal(layoutOf(e), q.x, q.y);
  return { x, y };
}
/** Topmost visible text layer under a doc point. */
function textLayerAt(doc: PixDocument, p: Point, tolPx: number): TextLayer | null {
  const all = doc.allLayers().filter(l => l instanceof TextLayer && l.visible && !l.locks.all) as TextLayer[];
  for (let i = all.length - 1; i >= 0; i--) {
    const l = all[i], L = l.getLayout(doc);
    const q = l.matrix().inverse().transformPoint(new DOMPoint(p.x, p.y));
    const [x, y] = l.unwarpLocal(L, q.x, q.y);
    const r = l.frameRect(L), t = tolPx / l.scaleFactor;
    if (x >= r.x - t && x <= r.x + r.w + t && y >= r.y - t && y <= r.y + r.h + t) return l;
  }
  return null;
}
const BOX_H: [number, number][] = [[0, 0], [0.5, 0], [1, 0], [1, 0.5], [1, 1], [0.5, 1], [0, 1], [0, 0.5]];
function boxHandle(e: Ed, v: Viewport, p: ToolPointer): number {
  if (e.layer.textType !== 'paragraph') return -1;
  const m = e.layer.matrix();
  for (let i = 0; i < 8; i++) {
    const q = m.transformPoint(new DOMPoint(BOX_H[i][0] * e.layer.boxW, BOX_H[i][1] * e.layer.boxH)), s = v.docToScreen(q.x, q.y);
    if (Math.hypot(s.x - p.sx, s.y - p.sy) <= 6) return i;
  }
  return -1;
}
const IBEAM = svgCursor('<path d="M9 4h2.5c.9 0 1.5.6 1.5 1.5V19c0 .9-.6 1.5-1.5 1.5H9M15 4h-2.5M15 20.5h-2.5M10 12h4"/>', 12, 12, 'text');
const IBEAM_V = svgCursor('<path d="M4 9v2.5c0 .9.6 1.5 1.5 1.5H19c.9 0 1.5-.6 1.5-1.5V9M4 15v-2.5M20.5 15v-2.5M12 10v4"/>', 12, 12, 'vertical-text');

function makeTool(id: string, name: string, icon: string, order: number, vertical: boolean, mask: boolean): Tool {
  const tool: Tool = {
    id, name, group: 'type', icon, shortcut: 'T', order, settings: typeSettings, noCtrlMove: false,
    cursor: () => {
      const v = app.viewport, e = ed;
      if (e && v) { const i = boxHandle(e, v, v.pointer as any); if (i >= 0) return i % 4 === 0 ? 'nwse-resize' : i % 4 === 2 ? 'nesw-resize' : i % 4 === 1 ? 'ns-resize' : 'ew-resize'; }
      return vertical ? IBEAM_V : IBEAM;
    },
    isModal: () => !!ed,
    commit: () => end(true),
    cancel: () => end(false),
    deactivate() { if (ed) end(true); creating = null; },
    options(bar) { buildOptions(bar, tool, vertical); },
    pointerDown(p, doc) {
      const e = ed, v = app.viewport!;
      if (e) {
        const hi = boxHandle(e, v, p);
        if (hi >= 0) { e.drag = { kind: 'box', h: hi, start: { x: p.x, y: p.y }, w0: e.layer.boxW, h0: e.layer.boxH, x0: e.layer.x, y0: e.layer.y }; return; }
        const L = layoutOf(e), lp = localPoint(e, p), fr = e.layer.frameRect(L), tol = 12 / (v.zoom * e.layer.scaleFactor);
        if (lp.x >= fr.x - tol && lp.x <= fr.x + fr.w + tol && lp.y >= fr.y - tol && lp.y <= fr.y + fr.h + tol) {
          const i = e.layer.hitTest(L, lp.x, lp.y);
          const detail = (p.event as MouseEvent).detail || 1;
          if (detail >= 3) { const pi = e.layer.paraIndexAt(i), [a, b] = e.layer.paraRange(pi); e.anchor = a; e.caret = b; }
          else if (detail === 2) { const [a, b] = wordAt(e.layer.text, i); e.anchor = a; e.caret = b; }
          else { e.caret = i; if (!p.shift) e.anchor = i; e.drag = { kind: 'select' }; }
          e.typing = null;
          touched(e);
          return;
        }
        end(true);   // click outside commits (like Photoshop)
        return;
      }
      if (!mask) {
        const hit = textLayerAt(doc, p, 6 / v.zoom);
        if (hit) {
          if (hit.locks.pixels || hit.locks.all) { toast('Could not edit the text because the layer is locked.', 'error'); return; }
          doc.setActiveLayer(hit);
          const L = hit.getLayout(doc);
          const q = hit.matrix().inverse().transformPoint(new DOMPoint(p.x, p.y));
          const [lx, ly] = hit.unwarpLocal(L, q.x, q.y);
          begin(doc, hit, false, false, hit.hitTest(L, lx, ly));
          return;
        }
      }
      creating = { start: { x: p.x, y: p.y }, cur: { x: p.x, y: p.y }, vertical, mask };
    },
    pointerMove(p, doc) {
      const e = ed;
      if (e?.drag?.kind === 'select') {
        const lp = localPoint(e, p);
        e.caret = e.layer.hitTest(layoutOf(e), lp.x, lp.y);
        touched(e);
      } else if (e?.drag?.kind === 'box') {
        const d = e.drag, m = e.layer.matrix().inverse(), a = m.transformPoint(new DOMPoint(d.start.x, d.start.y)), b = m.transformPoint(new DOMPoint(p.x, p.y));
        const dx = b.x - a.x, dy = b.y - a.y, [u, vv] = BOX_H[d.h];
        let w = d.w0, hh = d.h0, ox = 0, oy = 0;
        if (u === 1) w = Math.max(8, d.w0 + dx); if (u === 0) { w = Math.max(8, d.w0 - dx); ox = d.w0 - w; }
        if (vv === 1) hh = Math.max(8, d.h0 + dy); if (vv === 0) { hh = Math.max(8, d.h0 - dy); oy = d.h0 - hh; }
        const base = new DOMMatrix([e.layer.transform[0], e.layer.transform[1], e.layer.transform[2], e.layer.transform[3], d.x0, d.y0]).transformPoint(new DOMPoint(ox, oy));
        e.layer.boxW = w; e.layer.boxH = hh; e.layer.x = base.x; e.layer.y = base.y;
        touched(e);
      } else if (creating) { creating.cur = { x: p.x, y: p.y }; doc.redrawOverlay(); }
    },
    pointerUp(_p, doc) {
      if (ed?.drag) { ed.drag = null; return; }
      const c = creating;
      creating = null;
      if (!c) return;
      const l = new TextLayer('Layer');
      l.runs = [{ text: '', style: charStyleForNew(doc) }];
      l.orientation = c.vertical ? 'vertical' : 'horizontal';
      l.antiAlias = typeSettings.antiAlias;
      l.paras = [{ ...l.paras[0], ...typeSettings.para, align: typeSettings.align }];
      const w = Math.abs(c.cur.x - c.start.x), hh = Math.abs(c.cur.y - c.start.y);
      const z = app.viewport?.zoom || 1;
      if (w * z > 6 && hh * z > 6) {
        l.textType = 'paragraph'; l.boxW = w; l.boxH = hh;
        l.x = Math.min(c.start.x, c.cur.x); l.y = Math.min(c.start.y, c.cur.y);
        if (c.vertical) { l.x = Math.max(c.start.x, c.cur.x); }
      } else { l.x = c.start.x; l.y = c.start.y; }
      begin(doc, l, true, c.mask, 0);
    },
    drawOverlay(ctx, view, doc) {
      if (creating) {
        const a = view.docToScreen(creating.start.x, creating.start.y), b = view.docToScreen(creating.cur.x, creating.cur.y);
        ctx.save(); ctx.strokeStyle = '#000'; ctx.setLineDash([4, 3]); ctx.strokeRect(Math.min(a.x, b.x) + 0.5, Math.min(a.y, b.y) + 0.5, Math.abs(b.x - a.x), Math.abs(b.y - a.y));
        ctx.strokeStyle = '#fff'; ctx.lineDashOffset = 3; ctx.strokeRect(Math.min(a.x, b.x) + 0.5, Math.min(a.y, b.y) + 0.5, Math.abs(b.x - a.x), Math.abs(b.y - a.y)); ctx.restore();
      }
      const e = ed;
      if (!e || e.doc !== doc) return;
      drawEditing(ctx, view, e);
    },
  };
  app.registerTool(tool);
  return tool;
}

function drawEditing(ctx: CanvasRenderingContext2D, view: Viewport, e: Ed) {
  const L = layoutOf(e), m = e.layer.matrix(), k = view.zoom * e.layer.scaleFactor;
  ctx.save();
  // type mask: red overlay with the text cut out
  if (e.mask) {
    const c = e.layer.renderTo(e.doc, 1, '#000', false);
    const o = createCanvas(view.width, view.height), ox = ctx2d(o);
    ox.fillStyle = 'rgba(255,0,0,0.45)'; ox.fillRect(0, 0, o.width, o.height);
    if (c) { ox.globalCompositeOperation = 'destination-out'; view.applyDocTransform(ox); ox.drawImage(c.canvas, c.x, c.y); }
    ctx.drawImage(o, 0, 0);
  }
  view.applyDocTransform(ctx);
  ctx.transform(m.a, m.b, m.c, m.d, m.e, m.f);
  const px = 1 / k;
  const warped = e.layer.warp.style !== 'none';
  const W = (x: number, y: number) => (warped ? e.layer.warpLocal(L, x, y) : [x, y]);
  // paragraph box / point text baselines
  ctx.lineWidth = px;
  if (e.layer.textType === 'paragraph') {
    ctx.strokeStyle = '#000'; ctx.setLineDash([4 * px, 3 * px]);
    ctx.strokeRect(0, 0, e.layer.boxW, e.layer.boxH);
    ctx.strokeStyle = '#fff'; ctx.lineDashOffset = 3 * px; ctx.strokeRect(0, 0, e.layer.boxW, e.layer.boxH);
    ctx.setLineDash([]);
    for (const [u, v] of BOX_H) { const s = 6 * px; ctx.fillStyle = '#fff'; ctx.fillRect(u * e.layer.boxW - s / 2, v * e.layer.boxH - s / 2, s, s); ctx.strokeStyle = '#000'; ctx.strokeRect(u * e.layer.boxW - s / 2, v * e.layer.boxH - s / 2, s, s); }
    if (L.overflow) { const s = 8 * px; ctx.fillStyle = '#fff'; ctx.fillRect(e.layer.boxW - s, e.layer.boxH - s, s, s); ctx.strokeStyle = '#000'; ctx.beginPath(); ctx.moveTo(e.layer.boxW - s * 0.8, e.layer.boxH - s / 2); ctx.lineTo(e.layer.boxW - s * 0.2, e.layer.boxH - s / 2); ctx.moveTo(e.layer.boxW - s / 2, e.layer.boxH - s * 0.8); ctx.lineTo(e.layer.boxW - s / 2, e.layer.boxH - s * 0.2); ctx.stroke(); }
  } else if (!L.vertical) {
    ctx.strokeStyle = 'rgba(30,139,255,.9)';
    ctx.beginPath();
    for (const ln of L.lines) { const pos = e.layer.positions(L, ln), x0 = pos[0], x1 = Math.max(pos[pos.length - 1], x0 + 2); const [ax, ay] = W(x0, ln.baseline), [bx, by] = W(x1, ln.baseline); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); }
    ctx.stroke();
  }
  // selection
  const [a, b] = selRange(e);
  if (b > a) {
    ctx.fillStyle = 'rgba(30,120,255,.35)';
    for (const r of e.layer.selectionRects(L, a, b)) {
      if (!warped) ctx.fillRect(r.x, r.y, r.w, r.h);
      else { const p = [W(r.x, r.y), W(r.x + r.w, r.y), W(r.x + r.w, r.y + r.h), W(r.x, r.y + r.h)]; ctx.beginPath(); p.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y))); ctx.fill(); }
    }
  } else if (e.blinkOn) {
    const seg = e.layer.caretSegment(L, e.caret);
    if (seg) {
      const [x1, y1] = W(seg[0], seg[1]), [x2, y2] = W(seg[2], seg[3]);
      ctx.lineWidth = Math.max(px, 1.2 * px);
      ctx.strokeStyle = '#000';
      ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
    }
  }
  ctx.restore();
}

// ------------------------------------------------------------------ options bar
/** Text layers the options apply to when not editing. */
function targets(): TextLayer[] {
  const d = app.activeDoc;
  return d ? (d.selectedLayers.filter(l => l instanceof TextLayer) as TextLayer[]) : [];
}
/** Apply a style change to the editing selection, the selected text layers, or the defaults. */
export function applyToText(name: string, patch: Partial<CharStyle>, layerPatch?: (l: TextLayer) => void) {
  if (ed) { applyCharPatch(patch); if (layerPatch) { layerPatch(ed.layer); touched(ed); } return; }
  const ls = targets(), d = app.activeDoc;
  if (d && ls.length) {
    d.history.transaction(name, () => { for (const l of ls) { if (Object.keys(patch).length) l.setStyleAll(patch); layerPatch?.(l); l.invalidate(); } }, 'type');
    d.pixelsChanged(null, null); d.layersChanged();
  }
}
function currentStyle(): CharStyle {
  const es = editStyle();
  if (es) return es.style;
  const l = targets()[0];
  if (l) return l.styleAt(0);
  return { ...defaultCharStyle(), font: typeSettings.font, fontStyle: typeSettings.fontStyle, size: typeSettings.size, color: typeSettings.color || app.fg };
}
function buildOptions(bar: HTMLElement, tool: Tool, vertical: boolean) {
  const save = () => app.saveToolSettings(tool);
  const st = currentStyle();
  const setDef = (k: keyof typeof typeSettings, v: any) => { (typeSettings as any)[k] = v; save(); };
  const orient = iconButton('tp-orient', 'Toggle text orientation', () => {
    if (ed) { ed.layer.orientation = ed.layer.vertical ? 'horizontal' : 'vertical'; touched(ed); return; }
    const ls = targets();
    if (ls.length) void runCommand('type.orientation', ls[0].vertical ? 'horizontal' : 'vertical');
    else app.setTool(vertical ? (tool.id.includes('mask') ? 'type-mask' : 'type') : (tool.id.includes('mask') ? 'type-mask-vertical' : 'type-vertical'));
  });
  const font = fontPicker(st.font, f => { setDef('font', f); applyToText('Change Font', { font: f }); }, { width: 150 });
  const style = select<string>(FONT_STYLES.map(s => ({ value: s, label: s })), st.fontStyle, v => { setDef('fontStyle', v); applyToText('Change Font Style', { fontStyle: v }); }, { width: 110, title: 'Set the font style' });
  const size = numberField(st.size, v => { setDef('size', v); applyToText('Change Font Size', { size: v }); }, { min: 0.1, max: 1296, decimals: 2, unit: 'pt', width: 62, title: 'Set the font size' });
  const sizeMenu = iconButton('chevron-down', 'Font size presets', ev => {
    const pop = h('div.tp-sizepop');
    for (const s of SIZES) { const it = h('div.tp-sizeitem', null, `${s} pt`); it.addEventListener('mousedown', e2 => { e2.preventDefault(); size.setValue(s); setDef('size', s); applyToText('Change Font Size', { size: s }); close(); }); pop.append(it); }
    const close = showPop(pop, ev.currentTarget as HTMLElement);
  });
  const aa = select<AntiAlias>(AA, ed?.layer.antiAlias || targets()[0]?.antiAlias || typeSettings.antiAlias, v => { setDef('antiAlias', v); applyToText('Anti Alias', {}, l => { l.antiAlias = v; }); }, { width: 90, title: 'Set the anti-aliasing method' });
  const align = (a: TextAlign, ic: string, title: string) => iconButton(ic, title, () => {
    setDef('align', a);
    if (ed) { applyParaPatch({ align: a }); return; }
    const ls = targets(), d = app.activeDoc;
    if (d && ls.length) { d.history.transaction('Paragraph Alignment', () => { for (const l of ls) { l.paras = l.paras.map(p => ({ ...p, align: a })); l.invalidate(); } }); d.pixelsChanged(null, null); }
  });
  const color = colorSwatch(st.color, c => { setDef('color', c); applyToText('Change Text Color', { color: c }); }, { title: 'Set the text color' });
  bar.append(orient, separator(), font, style, separator(), h('span.tp-size', null, size, sizeMenu), separator(),
    h('span.opt-label', null, 'aa'), aa, separator(),
    align('left', 'tp-left', vertical ? 'Top align text' : 'Left align text'), align('center', 'tp-center', 'Center text'), align('right', 'tp-right', vertical ? 'Bottom align text' : 'Right align text'), separator(),
    color, separator(),
    iconButton('tp-warp', 'Create warped text', () => runCommand('type.warp')),
    iconButton('tp-panel', 'Toggle the Character and Paragraph panels', () => runCommand('window.togglePanel', 'character')),
    h('span.tp-flex'),
    ed ? iconButton('cancel', 'Cancel any current edits (discard)', () => end(false)) : h('span'),
    ed ? iconButton('commit', 'Commit any current edits (Ctrl+Enter)', () => end(true)) : h('span'));
  const sync = () => { const s = currentStyle(); font.setValue(s.font); style.setValue(s.fontStyle); size.setValue(s.size); color.setValue(s.color); };
  const off = events.on('toolOptions', sync);
  return () => off();
}

makeTool('type', 'Horizontal Type Tool', 'type', 0, false, false);
makeTool('type-vertical', 'Vertical Type Tool', 'type-vertical', 1, true, false);
makeTool('type-vertical-mask', 'Vertical Type Mask Tool', 'type-mask-vertical', 2, true, true);
makeTool('type-mask', 'Horizontal Type Mask Tool', 'type-mask', 3, false, true);

// Layers panel double-click on a type thumbnail / Properties "Edit text"
hooks.editTextLayer = (l: Layer) => {
  const doc = app.activeDoc;
  if (!doc || !(l instanceof TextLayer)) return;
  app.setTool(l.vertical ? 'type-vertical' : 'type');
  doc.setActiveLayer(l);
  begin(doc, l, false, false, l.length);
  if (ed) { ed.anchor = 0; ed.caret = l.length; touched(ed); }
};
events.on('activeDoc', () => { if (ed) end(true); });
