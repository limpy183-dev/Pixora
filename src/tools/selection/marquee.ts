// Marquee tools (M): Rectangular, Elliptical, Single Row, Single Column.
import { app, type Tool, type ToolPointer } from '../../core/app';
import type { PixDocument } from '../../core/document';
import type { Rect, SelectOp } from '../../core/types';
import { h } from '../../ui/dom';
import { iconButton, label, numberField, select } from '../../ui/widgets';
import { warnIfFaint } from '../../features/selection/ops';
import {
  antiAliasBox, beginOutlineDrag, crossCursor, drawHud, endOutlineDrag, featherField, liveOp, mods, MOVE_SEL_CURSOR,
  moveOutlineDrag, nudgeKey, onOptions, opButtons, resolveOp, selectAndMaskButton, selectionContextMenu, separator, type OutlineDrag,
} from './common';

type Kind = 'rect' | 'ellipse' | 'row' | 'col';
type Style = 'normal' | 'ratio' | 'size';
interface Settings { op: SelectOp; feather: number; antiAlias: boolean; style: Style; ratioW: number; ratioH: number; sizeW: number; sizeH: number }

interface Drag {
  kind: 'draw' | 'move';
  op: SelectOp;
  ax: number; ay: number;      // anchor (doc)
  bx: number; by: number;      // current corner (doc)
  lastX: number; lastY: number;
  shiftAtStart: boolean; altAtStart: boolean;
  shiftFree: boolean; altFree: boolean;     // modifier released since pointer down → may be used for constraints
  space: boolean;
  moved: boolean;
  sx: number; sy: number;      // screen start
  outline?: OutlineDrag;
}
let drag: Drag | null = null;

const NAMES: Record<Kind, string> = { rect: 'Rectangular Marquee', ellipse: 'Elliptical Marquee', row: 'Single Row Marquee', col: 'Single Column Marquee' };

/** Rectangle of the current marquee drag, with constraints / style applied. */
function marqueeRect(d: Drag, s: Settings, kind: Kind, p: { shift: boolean; alt: boolean }): Rect {
  const constrain = p.shift && (!d.shiftAtStart || d.shiftFree);
  const center = p.alt && (!d.altAtStart || d.altFree);
  let w = d.bx - d.ax, hgt = d.by - d.ay;
  if (s.style === 'size') {
    const fw = Math.max(1, s.sizeW), fh = Math.max(1, s.sizeH);
    return center ? { x: Math.round(d.bx - fw / 2), y: Math.round(d.by - fh / 2), w: fw, h: fh } : { x: Math.round(d.bx), y: Math.round(d.by), w: fw, h: fh };
  }
  if (s.style === 'ratio' && s.ratioW > 0 && s.ratioH > 0) {
    const r = s.ratioW / s.ratioH;
    const aw = Math.max(Math.abs(w), Math.abs(hgt) * r);
    w = Math.sign(w || 1) * aw; hgt = Math.sign(hgt || 1) * aw / r;
  } else if (constrain) {
    const m = Math.max(Math.abs(w), Math.abs(hgt));
    w = Math.sign(w || 1) * m; hgt = Math.sign(hgt || 1) * m;
  }
  let x = d.ax, y = d.ay;
  if (center) { x = d.ax - w; y = d.ay - hgt; w *= 2; hgt *= 2; }
  const x0 = Math.min(x, x + w), y0 = Math.min(y, y + hgt);
  if (kind === 'rect') {
    const rx0 = Math.round(x0), ry0 = Math.round(y0);
    return { x: rx0, y: ry0, w: Math.round(x0 + Math.abs(w)) - rx0, h: Math.round(y0 + Math.abs(hgt)) - ry0 };
  }
  return { x: x0, y: y0, w: Math.abs(w), h: Math.abs(hgt) };
}

function makeTool(kind: Kind, id: string, name: string, icon: string, order: number, shortcut?: string): Tool {
  const settings: Settings = { op: 'replace', feather: 0, antiAlias: true, style: 'normal', ratioW: 1, ratioH: 1, sizeW: 64, sizeH: 64 };
  const lineRect = (doc: PixDocument, x: number, y: number): Rect => kind === 'row'
    ? { x: 0, y: Math.max(0, Math.min(doc.height - 1, Math.floor(y))), w: doc.width, h: 1 }
    : { x: Math.max(0, Math.min(doc.width - 1, Math.floor(x))), y: 0, w: 1, h: doc.height };

  const commit = (doc: PixDocument, d: Drag, p: ToolPointer) => {
    const op = d.op;
    if (kind === 'row' || kind === 'col') {
      const r = lineRect(doc, d.bx, d.by);
      doc.history.transaction(NAMES[kind], () => doc.selection.selectRect(r, op, { feather: settings.feather }), 'selection');
      return;
    }
    // click without a drag: deselect (New), otherwise nothing
    if (!d.moved && settings.style !== 'size') {
      if (op === 'replace' && !doc.selection.empty) doc.history.transaction('Deselect', () => doc.selection.deselect(), 'selection');
      return;
    }
    const r = marqueeRect(d, settings, kind, p);
    if (r.w < 0.5 || r.h < 0.5) {
      if (op === 'replace' && !doc.selection.empty) doc.history.transaction('Deselect', () => doc.selection.deselect(), 'selection');
      return;
    }
    doc.history.transaction(NAMES[kind], () => {
      if (kind === 'rect') doc.selection.selectRect(r, op, { feather: settings.feather });
      else doc.selection.selectEllipse(r, op, { feather: settings.feather, antiAlias: settings.antiAlias });
    }, 'selection');
    if (settings.feather > 0) warnIfFaint(doc);
  };

  const tool: Tool = {
    id, name, group: 'marquee', icon, shortcut, order, settings,
    noCtrlMove: false,
    cursor: doc => {
      if (drag) return drag.kind === 'move' ? MOVE_SEL_CURSOR : crossCursor(drag.op);
      const p = app.viewport?.pointer;
      const op = liveOp(settings.op);
      if (doc && p && op === 'replace' && kind !== 'row' && kind !== 'col' && !doc.selection.empty && doc.selection.contains(p.x, p.y)) return MOVE_SEL_CURSOR;
      return crossCursor(op);
    },
    options(bar) {
      const ops = opButtons(tool, settings);
      const feather = featherField(tool, settings);
      const aa = antiAliasBox(tool, settings);
      const aaWrap = h('span', { class: kind === 'ellipse' ? '' : 'cr-dim', title: kind === 'ellipse' ? '' : 'Anti-alias is only available for the Elliptical Marquee' }, aa);
      const wField = numberField(0, v => { if (settings.style === 'ratio') settings.ratioW = v; else settings.sizeW = v; app.saveToolSettings(tool); }, { min: 0.001, max: 300000, width: 58, label: 'Width:', decimals: 3 });
      const hField = numberField(0, v => { if (settings.style === 'ratio') settings.ratioH = v; else settings.sizeH = v; app.saveToolSettings(tool); }, { min: 0.001, max: 300000, width: 58, label: 'Height:', decimals: 3 });
      const swap = iconButton('swap-colors', 'Swap height and width', () => {
        if (settings.style === 'ratio') [settings.ratioW, settings.ratioH] = [settings.ratioH, settings.ratioW];
        else if (settings.style === 'size') [settings.sizeW, settings.sizeH] = [settings.sizeH, settings.sizeW];
        app.saveToolSettings(tool); syncWH();
      }, { cls: 'sel-style-swap', size: 14 });
      const wh = h('span.sel-wh', null, wField, swap, hField);
      const style = select<Style>([{ value: 'normal', label: 'Normal' }, { value: 'ratio', label: 'Fixed Ratio' }, { value: 'size', label: 'Fixed Size' }], settings.style, v => {
        settings.style = v; app.saveToolSettings(tool); syncWH();
      }, { width: 96, title: 'Marquee style' });
      const syncWH = () => {
        const on = settings.style !== 'normal';
        wh.classList.toggle('cr-dim', !on);
        const ratio = settings.style === 'ratio';
        wField.setValue(ratio ? settings.ratioW : settings.sizeW); hField.setValue(ratio ? settings.ratioH : settings.sizeH);
        for (const f of [wField, hField]) (f.querySelector('input') as HTMLInputElement).disabled = !on;
      };
      const lineKind = kind === 'row' || kind === 'col';
      bar.append(ops, separator(), feather, aaWrap);
      if (!lineKind) bar.append(separator(), label('Style:'), style, wh);
      bar.append(separator(), selectAndMaskButton());
      syncWH();
      return onOptions(() => { ops.setValue(settings.op); feather.setValue(settings.feather); aa.setValue(settings.antiAlias); style.setValue(settings.style); syncWH(); });
    },
    activate() { drag = null; },
    deactivate() { if (drag) { app.viewport!.hasAntsOverlay = false; app.viewport!.selectionOffset = { x: 0, y: 0 }; drag = null; } },
    pointerDown(p, doc) {
      const op = resolveOp(settings.op, p.shift, p.alt);
      const d: Drag = {
        kind: 'draw', op, ax: p.x, ay: p.y, bx: p.x, by: p.y, lastX: p.x, lastY: p.y,
        shiftAtStart: p.shift, altAtStart: p.alt, shiftFree: false, altFree: false, space: false, moved: false, sx: p.sx, sy: p.sy,
      };
      if (op === 'replace' && kind !== 'row' && kind !== 'col' && !doc.selection.empty && doc.selection.contains(p.x, p.y)) {
        d.kind = 'move'; d.outline = beginOutlineDrag(p);
      }
      if (settings.style === 'size' && d.kind === 'draw') d.moved = true;
      drag = d;
      app.viewport!.hasAntsOverlay = d.kind === 'draw';
    },
    pointerMove(p, doc) {
      const d = drag;
      if (!d) return;
      if (!p.shift) d.shiftFree = true;
      if (!p.alt) d.altFree = true;
      if (Math.hypot(p.sx - d.sx, p.sy - d.sy) > 2) d.moved = true;
      if (d.kind === 'move') { moveOutlineDrag(d.outline!, p, doc); return; }
      if (d.space || mods.space) {
        // Space: reposition the marquee while drawing
        const dx = p.x - d.lastX, dy = p.y - d.lastY;
        d.ax += dx; d.ay += dy; d.bx += dx; d.by += dy;
      } else { d.bx = p.x; d.by = p.y; }
      d.lastX = p.x; d.lastY = p.y;
      doc.redrawOverlay();
    },
    pointerUp(p, doc) {
      const d = drag;
      drag = null;
      app.viewport!.hasAntsOverlay = false;
      if (!d) return;
      if (d.kind === 'move') {
        if (d.moved) endOutlineDrag(d.outline!, doc);
        else { app.viewport!.selectionOffset = { x: 0, y: 0 }; if (!doc.selection.empty) doc.history.transaction('Deselect', () => doc.selection.deselect(), 'selection'); }
        return;
      }
      if (!d.space) { d.bx = p.x; d.by = p.y; }
      commit(doc, d, p);
      doc.redrawOverlay();
    },
    keyDown(e, doc) {
      if (drag && e.code === 'Space') { drag.space = true; return true; }
      if (drag && e.key === 'Escape') { drag = null; app.viewport!.hasAntsOverlay = false; app.viewport!.selectionOffset = { x: 0, y: 0 }; doc?.redrawOverlay(); return true; }
      if (!drag) return nudgeKey(e, doc);
      return false;
    },
    keyUp(e) {
      if (drag && e.code === 'Space') { drag.space = false; return true; }
      return false;
    },
    drawOverlay(ctx, view, doc) {
      const d = drag;
      const p = view.pointer;
      if (!d) {
        if ((kind === 'row' || kind === 'col') && p.inside) {
          // preview line under the cursor
          const r = lineRect(doc, p.x, p.y);
          const path = new Path2D(); path.rect(r.x, r.y, r.w, r.h);
          ctx.globalAlpha = 0.5; view.strokeAnts(ctx, path); ctx.globalAlpha = 1;
        }
        return;
      }
      if (d.kind === 'move') {
        if (d.moved) drawHud(ctx, view, [`ΔX: ${d.outline!.dx} px`, `ΔY: ${d.outline!.dy} px`]);
        return;
      }
      if (kind === 'row' || kind === 'col') {
        const r = lineRect(doc, d.bx, d.by);
        const path = new Path2D(); path.rect(r.x, r.y, r.w, r.h);
        view.strokeAnts(ctx, path);
        return;
      }
      if (!d.moved) return;
      const r = marqueeRect(d, settings, kind, { shift: mods.shift, alt: mods.alt });
      const path = new Path2D();
      if (kind === 'rect') path.rect(r.x, r.y, r.w, r.h);
      else path.ellipse(r.x + r.w / 2, r.y + r.h / 2, r.w / 2, r.h / 2, 0, 0, Math.PI * 2);
      view.strokeAnts(ctx, path);
      drawHud(ctx, view, [`W: ${Math.round(r.w)} px`, `H: ${Math.round(r.h)} px`]);
    },
    contextMenu: selectionContextMenu,
  };
  return tool;
}

app.registerTool(makeTool('rect', 'marquee-rect', 'Rectangular Marquee Tool', 'marquee-rect', 0, 'M'));
app.registerTool(makeTool('ellipse', 'marquee-ellipse', 'Elliptical Marquee Tool', 'marquee-ellipse', 1, 'M'));
app.registerTool(makeTool('row', 'marquee-row', 'Single Row Marquee Tool', 'marquee-row', 2));
app.registerTool(makeTool('col', 'marquee-col', 'Single Column Marquee Tool', 'marquee-col', 3));
