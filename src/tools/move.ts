// Move Tool (V): moves layers or selected pixels, Auto-Select, Alt-drag duplicate, nudge, align buttons.
import { app, type Tool, type ToolPointer } from '../core/app';
import type { PixDocument } from '../core/document';
import { Layer, RasterLayer } from '../core/layer';
import { events } from '../core/events';
import { createCanvas, ctx2d } from '../core/canvas';
import { hooks } from '../core/registry';
import { runCommand, isCommandEnabled } from '../core/commands';
import { checkbox, select, separator, iconButton, showPop } from '../ui/widgets';
import { h } from '../ui/dom';
import { CURSORS } from '../ui/cursors';
import { toast } from '../ui/toast';
import { toCss } from '../core/color';
import type { Rect } from '../core/types';

interface Drag {
  sx: number; sy: number;
  dx: number; dy: number;
  mode: 'layers' | 'pixels' | 'transform' | 'none';
  txn: ReturnType<PixDocument['history']['begin']> | null;
  layers: Layer[];
  startBounds: Rect | null;
  float?: { layer: RasterLayer; base: HTMLCanvasElement; float: HTMLCanvasElement; preview: HTMLCanvasElement; sel: HTMLCanvasElement };
  applied: { x: number; y: number };
}

const settings = { autoSelect: true, target: 'layer' as 'layer' | 'group', showTransform: true, snapPixels: true };
let drag: Drag | null = null;

/** Selected layers that can move (drops children of selected groups and locked layers). */
function movableLayers(doc: PixDocument): Layer[] {
  const sel = doc.selectedLayers;
  const set = new Set(sel);
  const hasSelectedAncestor = (l: Layer) => { for (let p = l._parent; p; p = p._parent) if (set.has(p)) return true; return false; };
  return sel.filter(l => !hasSelectedAncestor(l) && !l.positionLocked);
}

function boundsOf(doc: PixDocument, layers: Layer[]): Rect | null {
  let r: Rect | null = null;
  for (const l of layers) {
    const b = doc.layerBounds(l);
    if (!b) continue;
    if (!r) r = b; else { const x = Math.min(r.x, b.x), y = Math.min(r.y, b.y); r = { x, y, w: Math.max(r.x + r.w, b.x + b.w) - x, h: Math.max(r.y + r.h, b.y + b.h) - y }; }
  }
  return r;
}

function beginFloat(doc: PixDocument, layer: RasterLayer, duplicate: boolean): Drag['float'] {
  layer.ensureRect({ x: 0, y: 0, w: doc.width, h: doc.height });
  const sel = doc.selection.mask!;
  const w = layer.canvas.width, hh = layer.canvas.height;
  const float = createCanvas(w, hh), fx = ctx2d(float);
  fx.drawImage(layer.canvas, 0, 0);
  fx.globalCompositeOperation = 'destination-in';
  fx.drawImage(sel, -layer.x, -layer.y);
  const base = createCanvas(w, hh), bx = ctx2d(base);
  bx.drawImage(layer.canvas, 0, 0);
  if (!duplicate) {
    bx.globalCompositeOperation = 'destination-out';
    bx.drawImage(sel, -layer.x, -layer.y);
    if (layer.transparencyLocked) {
      // background layer: the hole is filled with the background colour
      const fill = createCanvas(w, hh), fl = ctx2d(fill);
      fl.fillStyle = toCss(app.bg); fl.fillRect(0, 0, w, hh);
      fl.globalCompositeOperation = 'destination-in'; fl.drawImage(sel, -layer.x, -layer.y);
      bx.globalCompositeOperation = 'source-over';
      bx.drawImage(fill, 0, 0);
    }
  }
  return { layer, base, float, preview: createCanvas(w, hh), sel };
}
function renderFloat(f: NonNullable<Drag['float']>, dx: number, dy: number): HTMLCanvasElement {
  const x = ctx2d(f.preview);
  x.globalCompositeOperation = 'copy';
  x.drawImage(f.base, 0, 0);
  x.globalCompositeOperation = f.layer.transparencyLocked ? 'source-atop' : 'source-over';
  x.drawImage(f.float, dx, dy);
  x.globalCompositeOperation = 'source-over';
  return f.preview;
}

function applyDelta(doc: PixDocument, d: Drag, dx: number, dy: number) {
  const ddx = dx - d.applied.x, ddy = dy - d.applied.y;
  if (!ddx && !ddy) return;
  d.applied = { x: dx, y: dy };
  if (d.mode === 'pixels' && d.float) {
    const pv = renderFloat(d.float, dx, dy);
    d.float.layer._preview = { canvas: pv, x: d.float.layer.x, y: d.float.layer.y };
    app.viewport!.selectionOffset = { x: dx, y: dy };
    doc.invalidate();
  } else {
    for (const l of d.layers) l.translate(ddx, ddy);
    doc.invalidate();
  }
}

function finish(doc: PixDocument, d: Drag, name = 'Move') {
  app.viewport!.selectionOffset = { x: 0, y: 0 };
  if (d.mode === 'pixels' && d.float) {
    const f = d.float;
    f.layer._preview = null;
    if (!d.applied.x && !d.applied.y) { d.txn?.cancel(); doc.invalidate(); return; }
    const out = createCanvas(f.base.width, f.base.height);
    ctx2d(out).drawImage(renderFloat(f, d.applied.x, d.applied.y), 0, 0);
    f.layer.canvas = out;
    f.layer.invalidate();
    // move the selection with the pixels
    const m = createCanvas(doc.width, doc.height);
    ctx2d(m).drawImage(f.sel, d.applied.x, d.applied.y);
    doc.selection.setMask(m);
    d.txn?.commit(name);
    doc.pixelsChanged(f.layer, null);
    return;
  }
  if (!d.applied.x && !d.applied.y) { d.txn?.cancel(); doc.layersChanged(); return; }
  d.txn?.commit(name);
  doc.layersChanged();
}

function nudge(doc: PixDocument, dx: number, dy: number) {
  const layers = movableLayers(doc);
  const active = doc.activeLayer;
  const pixels = !doc.selection.empty && active instanceof RasterLayer && !active.pixelsLocked;
  if (!pixels && !layers.length) return;
  const d: Drag = { sx: 0, sy: 0, dx: 0, dy: 0, mode: pixels ? 'pixels' : 'layers', txn: doc.history.begin('Nudge', 'move'), layers, startBounds: null, applied: { x: 0, y: 0 } };
  if (pixels) d.float = beginFloat(doc, active as RasterLayer, false);
  applyDelta(doc, d, dx, dy);
  finish(doc, d, 'Nudge');
}

function drawDefaultBox(ctx: CanvasRenderingContext2D, doc: PixDocument) {
  const view = app.viewport!;
  const layers = movableLayers(doc).length ? movableLayers(doc) : doc.selectedLayers;
  const b = boundsOf(doc, layers.filter(l => !l.isBackground));
  if (!b) return;
  const pts = [[b.x, b.y], [b.x + b.w, b.y], [b.x + b.w, b.y + b.h], [b.x, b.y + b.h]].map(([x, y]) => view.docToScreen(x, y));
  ctx.save();
  ctx.lineWidth = 1;
  ctx.strokeStyle = '#1473e6';
  ctx.beginPath();
  pts.forEach((p, i) => (i ? ctx.lineTo(Math.round(p.x) + 0.5, Math.round(p.y) + 0.5) : ctx.moveTo(Math.round(p.x) + 0.5, Math.round(p.y) + 0.5)));
  ctx.closePath();
  ctx.stroke();
  const mids = [0, 1, 2, 3].map(i => ({ x: (pts[i].x + pts[(i + 1) % 4].x) / 2, y: (pts[i].y + pts[(i + 1) % 4].y) / 2 }));
  ctx.fillStyle = '#fff';
  for (const p of [...pts, ...mids]) { ctx.fillRect(Math.round(p.x) - 3.5, Math.round(p.y) - 3.5, 7, 7); ctx.strokeRect(Math.round(p.x) - 3.5, Math.round(p.y) - 3.5, 7, 7); }
  ctx.restore();
}

function drawHud(ctx: CanvasRenderingContext2D, d: Drag) {
  const v = app.viewport!;
  if (!v.pointer.inside) return;
  const text = `ΔX: ${d.applied.x} px   ΔY: ${d.applied.y} px`;
  ctx.save();
  ctx.font = '600 11px Segoe UI, system-ui, sans-serif';
  const w = ctx.measureText(text).width + 16;
  const x = v.pointer.sx + 18, y = v.pointer.sy + 18;
  ctx.fillStyle = 'rgba(40,40,40,.92)';
  ctx.beginPath(); (ctx as any).roundRect?.(x, y, w, 22, 4) ?? ctx.rect(x, y, w, 22); ctx.fill();
  ctx.fillStyle = '#f0f0f0';
  ctx.fillText(text, x + 8, y + 15);
  ctx.restore();
}

const tool: Tool = {
  id: 'move', name: 'Move Tool', group: 'move', icon: 'move', shortcut: 'V', order: 0,
  settings,
  cursor: () => {
    const p = app.viewport?.pointer;
    const doc = app.activeDoc;
    if (settings.showTransform && hooks.moveTransform && doc && p) {
      const c = hooks.moveTransform.cursor({ x: p.x, y: p.y, sx: p.sx, sy: p.sy }, doc);
      if (c) return c;
    }
    return CURSORS.move;
  },
  options(bar) {
    const autoSel = checkbox('Auto-Select:', settings.autoSelect, v => { settings.autoSelect = v; app.saveToolSettings(tool); });
    const target = select([{ value: 'group', label: 'Group' }, { value: 'layer', label: 'Layer' }], settings.target, v => { settings.target = v as any; app.saveToolSettings(tool); }, { width: 66 });
    const showT = checkbox('Show Transform Controls', settings.showTransform, v => { settings.showTransform = v; app.saveToolSettings(tool); app.activeDoc?.redrawOverlay(); });
    const al = (icon: string, title: string, cmd: string, arg: string) => {
      const b = iconButton(icon, title, () => runCommand(cmd, arg));
      b.classList.add('align-btn');
      return b;
    };
    const aligns = [
      al('align-left', 'Align left edges', 'layer.align', 'left'), al('align-hcenter', 'Align horizontal centers', 'layer.align', 'hcenter'), al('align-right', 'Align right edges', 'layer.align', 'right'),
      h('span.opt-gap'),
      al('distribute-vertical', 'Distribute vertically', 'layer.distribute', 'vcenter'),
      separator(),
      al('align-top', 'Align top edges', 'layer.align', 'top'), al('align-vcenter', 'Align vertical centers', 'layer.align', 'vcenter'), al('align-bottom', 'Align bottom edges', 'layer.align', 'bottom'),
      h('span.opt-gap'),
      al('distribute-horizontal', 'Distribute horizontally', 'layer.distribute', 'hcenter'),
    ];
    const more = iconButton('more', 'Align and Distribute', e => {
      const pop = h('div.align-pop', null,
        h('div.align-pop-title', null, 'Align'),
        h('div.align-pop-row', null, ...['left', 'hcenter', 'right', 'top', 'vcenter', 'bottom'].map(a => iconButton('align-' + a, 'Align ' + a, () => runCommand('layer.align', a)))),
        h('div.align-pop-title', null, 'Distribute'),
        h('div.align-pop-row', null, ...['top', 'vcenter', 'bottom', 'left', 'hcenter', 'right'].map(a => iconButton(a === 'left' || a === 'hcenter' || a === 'right' ? 'distribute-left' : 'distribute-top', 'Distribute ' + a, () => runCommand('layer.distribute', a)))),
        h('div.align-pop-title', null, 'Distribute Spacing'),
        h('div.align-pop-row', null, iconButton('distribute-vertical', 'Distribute vertical spacing', () => runCommand('layer.distribute', 'vspace')), iconButton('distribute-horizontal', 'Distribute horizontal spacing', () => runCommand('layer.distribute', 'hspace'))),
      );
      showPop(pop, e.currentTarget as HTMLElement);
    });
    const gear = iconButton('gear', 'Additional move options', e => {
      const pop = h('div.opt-pop', null,
        checkbox('Snap vector tools and transforms to pixel grid', settings.snapPixels, v => { settings.snapPixels = v; app.saveToolSettings(tool); }),
        checkbox('Auto-Select', settings.autoSelect, v => { settings.autoSelect = v; autoSel.setValue(v); app.saveToolSettings(tool); }),
        checkbox('Show Transform Controls', settings.showTransform, v => { settings.showTransform = v; showT.setValue(v); app.saveToolSettings(tool); app.activeDoc?.redrawOverlay(); }),
      );
      showPop(pop, e.currentTarget as HTMLElement);
    });
    bar.append(autoSel, target, separator(), showT, separator(), ...aligns, separator(), more, separator(), gear);
    const sync = () => {
      for (const b of bar.querySelectorAll<HTMLButtonElement>('.align-btn')) b.disabled = !isCommandEnabled('layer.align');
    };
    sync();
    const offs = [events.on('activeLayer', sync), events.on('selection', sync), events.on('activeDoc', sync), events.on('layers', sync)];
    return () => offs.forEach(f => f());
  },
  pointerDown(p: ToolPointer, doc: PixDocument) {
    if (settings.showTransform && hooks.moveTransform?.pointerDown(p, doc)) {
      drag = { sx: p.x, sy: p.y, dx: 0, dy: 0, mode: 'transform', txn: null, layers: [], startBounds: null, applied: { x: 0, y: 0 } };
      return;
    }
    const auto = app.springTool === tool ? true : settings.autoSelect !== p.ctrl;
    if (auto) {
      const hit = doc.layerAt(p.x, p.y, { groups: settings.target === 'group' });
      if (hit) {
        if (p.shift) doc.setActiveLayer(hit, true);
        else if (!doc.selectedIds.includes(hit.id)) doc.setActiveLayer(hit);
      }
    }
    const active = doc.activeLayer;
    const layers = movableLayers(doc);
    const pixels = !doc.selection.empty && active instanceof RasterLayer && !active.pixelsLocked;
    if (!pixels && !layers.length) {
      drag = { sx: p.x, sy: p.y, dx: 0, dy: 0, mode: 'none', txn: null, layers: [], startBounds: null, applied: { x: 0, y: 0 } };
      if (active?.positionLocked) toast(active.isBackground ? 'Could not use the move tool because the target layer is locked (Background). Convert it to a normal layer first.' : 'Could not use the move tool because the layer is locked.', 'error');
      return;
    }
    const txn = doc.history.begin(p.alt ? 'Duplicate' : 'Move', 'move');
    let moving = layers;
    if (!pixels && p.alt) {
      // Alt-drag duplicates the layers
      moving = layers.map(l => {
        const c = l.clone();
        c.name = l.name + ' copy';
        c.isBackground = false;
        doc.addLayer(c, { above: l, select: false });
        return c;
      });
      doc.selectedIds = moving.map(l => l.id);
      doc.activeLayerId = moving[moving.length - 1].id;
      doc.layersChanged();
    }
    drag = { sx: p.x, sy: p.y, dx: 0, dy: 0, mode: pixels ? 'pixels' : 'layers', txn, layers: moving, startBounds: boundsOf(doc, moving), applied: { x: 0, y: 0 } };
    if (pixels) drag.float = beginFloat(doc, active as RasterLayer, p.alt);
  },
  pointerMove(p, doc) {
    if (!drag) return;
    if (drag.mode === 'transform') { hooks.moveTransform?.pointerMove(p, doc); return; }
    if (drag.mode === 'none') return;
    let dx = p.x - drag.sx, dy = p.y - drag.sy;
    if (p.shift) { if (Math.abs(dx) > Math.abs(dy)) dy = 0; else dx = 0; }
    dx = Math.round(dx); dy = Math.round(dy);
    if (drag.startBounds && drag.mode === 'layers') {
      const b = drag.startBounds;
      const s = hooks.snapRect({ x: b.x + dx, y: b.y + dy, w: b.w, h: b.h }, doc, drag.layers);
      dx += Math.round(s.dx); dy += Math.round(s.dy);
    }
    applyDelta(doc, drag, dx, dy);
  },
  pointerUp(p, doc) {
    const d = drag;
    drag = null;
    if (!d) return;
    if (d.mode === 'transform') { hooks.moveTransform?.pointerUp(p, doc); return; }
    if (d.mode === 'none') return;
    finish(doc, d, d.txn && p.alt && d.mode === 'layers' ? 'Duplicate' : 'Move');
  },
  keyDown(e, doc) {
    if (!doc) return false;
    const map: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    const v = map[e.key];
    if (v && !e.ctrlKey && !e.metaKey && !e.altKey) {
      const k = e.shiftKey ? 10 : 1;
      nudge(doc, v[0] * k, v[1] * k);
      return true;
    }
    return false;
  },
  drawOverlay(ctx, view, doc) {
    if (settings.showTransform && !(drag && drag.mode === 'pixels')) {
      if (hooks.moveTransform) hooks.moveTransform.draw(ctx, view, doc);
      else drawDefaultBox(ctx, doc);
    }
    if (drag && drag.mode !== 'transform' && drag.mode !== 'none' && (drag.applied.x || drag.applied.y)) drawHud(ctx, drag);
  },
};

app.registerTool(tool);

// Artboard tool shares the move slot (artboards are not supported; it behaves like a guide-aware move).
app.registerTool({
  id: 'artboard', name: 'Artboard Tool', group: 'move', icon: 'artboard', shortcut: 'V', order: 1,
  cursor: CURSORS.move,
  options(bar) { bar.append(h('span.opt-label', null, 'Artboards are not available in Pixora — use Image › Canvas Size to resize the canvas.')); },
  pointerDown(p, doc) { tool.pointerDown!(p, doc); },
  pointerMove(p, doc) { tool.pointerMove!(p, doc); },
  pointerUp(p, doc) { tool.pointerUp!(p, doc); },
});
