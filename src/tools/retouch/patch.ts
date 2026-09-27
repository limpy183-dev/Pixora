// Patch Tool (J) and Content-Aware Move Tool (J).
// Both draw a freehand selection (like the Lasso) and, when dragged from inside the selection, move content:
//  * Patch — Source: the selected area is repaired with the pixels from where it is dragged to;
//            Destination: the selected pixels are copied to the drop location. Normal (healing) or Content-Aware
//            (structure/colour adaptation) blending, optional Transparent and Use Pattern.
//  * Content-Aware Move — Move: the selection is moved and the hole left behind is filled content-aware;
//            Extend: the selection is duplicated. Edges adapt to the destination (Structure / Color).
import { app, type Tool, type ToolPointer } from '../../core/app';
import type { PixDocument, PaintTarget } from '../../core/document';
import { createCanvas, ctx2d } from '../../core/canvas';
import type { Point, Rect, SelectOp } from '../../core/types';
import { button, separator } from '../../ui/widgets';
import { svgCursor } from '../../ui/cursors';
import { fail, optionsFor, patternById, readImg, retouchTarget, sampleImage, type Img } from './common';
import { dilate } from './heal-algo';
import {
  adaptBlend, commitResult, healBlend, isBusy, prepareTarget, readWork, regionFromCanvas, runInpaint, textureBlend, withBusy, workRect,
  type Work,
} from './heal-core';
import { glyphCursor, liveOp, opButtons, resolveOp, selectionContextMenu, strokePolyline, MOVE_SEL_CURSOR } from '../selection/common';

const PATCH_G = '<path d="M5 8.5 12.5 4l7 4-2 9.5-9.5 2.5z" stroke-dasharray="2 1.6"/><path d="M8.5 12.5h6M11.5 9.5v6"/>';
const MOVE_G = '<path d="M4 4h8v8H4z" stroke-dasharray="2 1.6"/><path d="M13 13h7v7h-7z"/><path d="m10 10 5 5M15 12v3h-3"/>';
const DRAG_CURSOR = svgCursor('<path d="m3 2 0 12 3.2-3.2 2.3 5 1.8-.9-2.3-5H12z" fill="#fff"/><path d="M13 13h8v7h-8z" stroke-dasharray="1.6 1.4"/>', 3, 2, 'default');

interface Shared { op: SelectOp }
type Mode = 'lasso' | 'drag';
interface St {
  mode: Mode; doc: PixDocument;
  pts: Point[]; op: SelectOp;                                // lasso
  start: Point; d: Point;                                    // drag (integer offset)
  B: Rect; sel: HTMLCanvasElement; img: Img; t: PaintTarget; preview: HTMLCanvasElement; content: HTMLCanvasElement | null;
}

function selCrop(doc: PixDocument, B: Rect): HTMLCanvasElement {
  const c = createCanvas(B.w, B.h);
  ctx2d(c).drawImage(doc.selection.mask!, -B.x, -B.y);
  return c;
}
/** Selected image content cropped to B (masked by the selection). */
function contentCrop(img: Img, sel: HTMLCanvasElement, B: Rect): HTMLCanvasElement {
  const c = createCanvas(B.w, B.h), x = ctx2d(c);
  x.drawImage(img.canvas, img.x - B.x, img.y - B.y);
  x.globalCompositeOperation = 'destination-in'; x.drawImage(sel, 0, 0);
  return c;
}
/** A copy of the selection mask moved by d (new canvas). */
function movedMask(doc: PixDocument, d: Point): HTMLCanvasElement {
  const m = createCanvas(doc.width, doc.height);
  ctx2d(m).drawImage(doc.selection.mask!, d.x, d.y);
  return m;
}
const shiftRect = (r: Rect, d: Point): Rect => ({ x: r.x + d.x, y: r.y + d.y, w: r.w, h: r.h });

/** Lasso + drag state machine shared by both tools. */
function makeTool(o: {
  id: string; name: string; order: number; glyph: string; settings: Shared & Record<string, any>;
  what: string; selName: string;
  sampleMode(): 'current' | 'all';
  /** Draw the drag preview (doc space, already transformed). */
  preview(ctx: CanvasRenderingContext2D, st: St): void;
  drop(st: St): Promise<void> | void;
  options(tool: Tool, bar: HTMLElement): void | (() => void);
}): Tool {
  const s = o.settings;
  let st: St | null = null;
  const finishLasso = (doc: PixDocument) => {
    const x = st; st = null;
    if (!x) return;
    const pts = x.pts.filter((p, i) => i === 0 || Math.hypot(p.x - x.pts[i - 1].x, p.y - x.pts[i - 1].y) > 0.01);
    if (pts.length < 3) {
      if (x.op === 'replace' && !doc.selection.empty) doc.history.transaction('Deselect', () => doc.selection.deselect(), 'selection');
    } else doc.history.transaction(o.selName, () => doc.selection.selectPolygon(pts, x.op, { antiAlias: true }), 'selection');
    doc.redrawOverlay();
  };
  const tool: Tool = {
    id: o.id, name: o.name, group: 'heal', icon: o.id, shortcut: 'J', order: o.order, settings: s,
    cursor: doc => {
      if (st?.mode === 'drag') return DRAG_CURSOR;
      const p = app.viewport?.pointer;
      if (!st && doc && !doc.selection.empty && p && doc.selection.contains(Math.floor(p.x), Math.floor(p.y)) && liveOp(s.op) === s.op && s.op === 'replace') return MOVE_SEL_CURSOR;
      return glyphCursor(o.glyph, 5, 20, st ? st.op : liveOp(s.op));
    },
    options(bar) { return o.options(tool, bar); },
    deactivate() { if (st) { st = null; if (app.viewport) app.viewport.selectionOffset = { x: 0, y: 0 }; } },
    pointerDown(p: ToolPointer, doc: PixDocument) {
      if (isBusy() || st) return;
      const inside = !doc.selection.empty && !p.shift && !p.alt && doc.selection.contains(Math.floor(p.x), Math.floor(p.y));
      if (!inside) {
        st = { mode: 'lasso', doc, pts: [{ x: p.x, y: p.y }], op: resolveOp(s.op, p.shift, p.alt) } as St;
        return;
      }
      const t = retouchTarget(doc, o.what);
      if (!t) return;
      if (t.isMask && o.id === 'content-aware-move') { fail('Could not use the content-aware move tool because the target is a mask.'); return; }
      const B = { ...doc.selection.bounds! };
      const sel = selCrop(doc, B);
      const img = sampleImage(doc, o.sampleMode(), t);
      st = { mode: 'drag', doc, pts: [], op: 'replace', start: { x: p.x, y: p.y }, d: { x: 0, y: 0 }, B, sel, img, t, preview: createCanvas(B.w, B.h), content: null };
      app.viewport!.selectionOffset = { x: 0, y: 0 };
    },
    pointerMove(p, doc) {
      if (!st) return;
      if (st.mode === 'lasso') {
        const l = st.pts[st.pts.length - 1];
        if (Math.hypot(p.x - l.x, p.y - l.y) * app.viewport!.zoom >= 1) st.pts.push({ x: p.x, y: p.y });
      } else {
        let dx = p.x - st.start.x, dy = p.y - st.start.y;
        if (p.shift) { if (Math.abs(dx) > Math.abs(dy)) dy = 0; else dx = 0; }
        st.d = { x: Math.round(dx), y: Math.round(dy) };
        app.viewport!.selectionOffset = { ...st.d };
      }
      doc.redrawOverlay();
    },
    async pointerUp(_p, doc) {
      if (!st) return;
      if (st.mode === 'lasso') { finishLasso(doc); return; }
      const x = st;
      try {
        if (x.d.x || x.d.y) await o.drop(x);
      } catch (err) { console.error(err); fail(`Could not complete the ${o.name.replace(' Tool', '')} because of a program error.`); }
      finally {
        st = null;
        if (app.viewport) app.viewport.selectionOffset = { x: 0, y: 0 };
        doc.redrawOverlay();
      }
    },
    drawOverlay(ctx, view) {
      if (!st) return;
      if (st.mode === 'lasso') { strokePolyline(ctx, view, st.pts); return; }
      if (!st.d.x && !st.d.y) return;
      ctx.save();
      view.applyDocTransform(ctx);
      ctx.imageSmoothingEnabled = view.zoom < 1;
      o.preview(ctx, st);
      ctx.restore();
    },
    keyDown(e) {
      if (e.key === 'Escape' && st) { st = null; if (app.viewport) app.viewport.selectionOffset = { x: 0, y: 0 }; app.activeDoc?.redrawOverlay(); return true; }
      return false;
    },
    contextMenu: selectionContextMenu,
  };
  app.registerTool(tool);
  return tool;
}

// ================================================================== Patch Tool
type PatchKind = 'normal' | 'content-aware';
const pt = {
  op: 'replace' as SelectOp, patch: 'normal' as PatchKind, which: 'source' as 'source' | 'destination', transparent: false,
  diffusion: 5, structure: 4, color: 0, sampleAll: false, patternId: 'checker',
};

function patchBlend(O: Uint8ClampedArray, S: Uint8ClampedArray, region: Uint8Array, w: number, h: number): Uint8ClampedArray {
  if (pt.patch === 'content-aware') return adaptBlend(O, S, region, w, h, pt.structure, pt.color);
  if (pt.transparent) return textureBlend(O, S, region, w, h);
  return healBlend(O, S, region, w, h, pt.diffusion);
}

function patchDrop(st: St) {
  const { doc, t, img, d } = st;
  prepareTarget(doc, t);
  const toDest = pt.which === 'destination';
  const dest = toDest ? shiftRect(st.B, d) : st.B;
  const w = workRect(doc, t, dest, 4 + pt.diffusion * 2);
  if (!w) return;
  const { R } = w;
  // region = the selection at the destination
  const { region, weight, count } = toDest ? regionFromCanvas(doc.selection.mask!, R, d.x, d.y) : regionFromCanvas(doc.selection.mask!, R);
  if (!count) return;
  const O = readWork(t, w);
  const S = readImg(img, toDest ? shiftRect(R, { x: -d.x, y: -d.y }) : shiftRect(R, d)).data;
  const res = patchBlend(O, S, region, R.w, R.h);
  doc.history.transaction('Patch Tool', () => {
    commitResult(doc, t, w, O, res, weight, 'Patch Tool', 'normal', 'patch', false);
    if (toDest) doc.selection.setMask(movedMask(doc, d));
  }, 'patch');
}

function usePattern(doc: PixDocument) {
  if (doc.selection.empty) { fail('Could not use the pattern because there is no selection.'); return; }
  const pat = patternById(pt.patternId);
  if (!pat) { fail('Could not use the pattern because no pattern is defined.'); return; }
  const t = retouchTarget(doc, 'patch tool');
  if (!t) return;
  prepareTarget(doc, t);
  const w = workRect(doc, t, doc.selection.bounds!, 4 + pt.diffusion * 2);
  if (!w) return;
  const { R } = w;
  const { region, weight } = regionFromCanvas(doc.selection.mask!, R);
  const c = createCanvas(R.w, R.h), x = ctx2d(c), cp = x.createPattern(pat.canvas, 'repeat')!;
  cp.setTransform(new DOMMatrix().translate(-R.x, -R.y));
  x.fillStyle = cp; x.fillRect(0, 0, R.w, R.h);
  const S = x.getImageData(0, 0, R.w, R.h).data;
  const O = readWork(t, w);
  commitResult(doc, t, w, O, patchBlend(O, S, region, R.w, R.h), weight, 'Patch Tool', 'normal', 'patch', false);
}

makeTool({
  id: 'patch', name: 'Patch Tool', order: 2, glyph: PATCH_G, settings: pt, what: 'patch tool', selName: 'Patch Selection',
  sampleMode: () => (pt.patch === 'content-aware' && pt.sampleAll ? 'all' : 'current'),
  preview(ctx, st) {
    const { B, d, preview: pc } = st;
    const x = ctx2d(pc);
    if (pt.which === 'source') {
      // what the selected area will receive: the content under the dragged outline
      x.globalCompositeOperation = 'copy';
      x.drawImage(st.img.canvas, st.img.x - (B.x + d.x), st.img.y - (B.y + d.y));
      x.globalCompositeOperation = 'destination-in'; x.drawImage(st.sel, 0, 0);
      x.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = 0.85;
      ctx.drawImage(pc, B.x, B.y);
    } else {
      if (!st.content) st.content = contentCrop(st.img, st.sel, B);
      ctx.globalAlpha = 0.85;
      ctx.drawImage(st.content, B.x + d.x, B.y + d.y);
    }
  },
  drop: patchDrop,
  options(tool, bar) {
    const o = optionsFor(tool);
    const normalOnly: HTMLElement[] = [], caOnly: HTMLElement[] = [];
    const sync = () => {
      for (const el of normalOnly) el.style.display = pt.patch === 'normal' ? '' : 'none';
      for (const el of caOnly) el.style.display = pt.patch === 'content-aware' ? '' : 'none';
    };
    const ops = opButtons(tool, pt);
    const trans = o.check('Transparent', 'transparent', 'Blend only the texture of the sampled area into the patch');
    const diff = o.num('Diffusion:', 'diffusion', { min: 1, max: 7, width: 36, title: 'Controls how quickly the pasted region adapts to the surrounding image' });
    const patRow = o.pattern();
    const useBtn = button('Use Pattern', () => { const doc = app.activeDoc; if (doc) usePattern(doc); }, { title: 'Fill the selection with the pattern (healed into the image)' });
    normalOnly.push(trans, patRow, useBtn);
    const structure = o.num('Structure:', 'structure', { min: 1, max: 7, width: 36, title: 'How strictly the patch keeps the existing image patterns (1 = loose, 7 = strict)' });
    const color = o.num('Color:', 'color', { min: 0, max: 10, width: 36, title: 'How much algorithmic colour blending is applied to the patch (0 = none, 10 = maximum)' });
    const all = o.check('Sample All Layers', 'sampleAll', 'Use data from all visible layers');
    caOnly.push(structure, color, all);
    const cleanup = o.finish(bar, ops, separator(),
      o.select('Patch:', 'patch', [{ value: 'normal', label: 'Normal' }, { value: 'content-aware', label: 'Content-Aware' }], 120, 'Patch mode', () => sync()),
      separator(),
      o.radio('', 'which', [
        { value: 'source', label: 'Source', title: 'Drag the selection to the area to sample; the selected area is repaired' },
        { value: 'destination', label: 'Destination', title: 'Drag the selection to the area to patch; the selected pixels are copied there' },
      ]),
      separator(), trans, diff, structure, color, all, separator(), patRow, useBtn);
    sync();
    return cleanup;
  },
});

// ================================================================== Content-Aware Move Tool
const cam = { op: 'replace' as SelectOp, mode: 'move' as 'move' | 'extend', structure: 4, color: 0, sampleAll: true };

async function moveDrop(st: St) {
  const { doc, t, img, d, B } = st;
  prepareTarget(doc, t);
  // 1) content-aware fill of the hole left behind (Move mode)
  let fill: { w: Work; F: Uint8ClampedArray; hole: Uint8Array } | null = null;
  if (cam.mode === 'move') {
    const size = Math.max(B.w, B.h);
    const wf = workRect(doc, t, B, Math.min(420, Math.max(40, size * 1.2 + 24)));
    if (wf) {
      const I = readImg(img, wf.R).data;
      const { region } = regionFromCanvas(doc.selection.mask!, wf.R, 0, 0, 8);
      const hole = dilate(region, wf.R.w, wf.R.h, 2);
      const holderCanvas = t.holder.canvas;
      const F = await withBusy(() => runInpaint(I, wf.R.w, wf.R.h, hole));
      if (t.holder.canvas !== holderCanvas) return;
      fill = { w: wf, F, hole };
    }
  }
  const wd = workRect(doc, t, shiftRect(B, d), 10);
  doc.history.transaction('Content-Aware Move', () => {
    if (fill) {
      const O = readWork(t, fill.w);
      const wt = new Float32Array(fill.hole.length);
      for (let i = 0; i < wt.length; i++) wt[i] = fill.hole[i];
      commitResult(doc, t, fill.w, O, fill.F, wt, 'Content-Aware Move', 'normal', 'content-aware-move', false);
    }
    if (wd) {
      const { R } = wd;
      const { region, weight, count } = regionFromCanvas(doc.selection.mask!, R, d.x, d.y);
      if (count) {
        const O = readWork(t, wd);
        // boundary colours: what is visible at the destination now (target, or the composite with Sample All Layers)
        const base = cam.sampleAll ? readImg(sampleImage(doc, 'all', t), R).data : O;
        const S = readImg(img, shiftRect(R, { x: -d.x, y: -d.y })).data;
        const res = adaptBlend(base, S, region, R.w, R.h, cam.structure, cam.color);
        commitResult(doc, t, wd, O, res, weight, 'Content-Aware Move', 'normal', 'content-aware-move', false);
      }
    }
    doc.selection.setMask(movedMask(doc, d));
  }, 'content-aware-move');
}

makeTool({
  id: 'content-aware-move', name: 'Content-Aware Move Tool', order: 3, glyph: MOVE_G, settings: cam, what: 'content-aware move tool', selName: 'Content-Aware Move Selection',
  sampleMode: () => (cam.sampleAll ? 'all' : 'current'),
  preview(ctx, st) {
    const { B, d } = st;
    if (!st.content) st.content = contentCrop(st.img, st.sel, B);
    if (cam.mode === 'move') {
      // hint the hole: darken the original area
      ctx.globalAlpha = 0.35;
      ctx.drawImage(st.sel, B.x, B.y);
    }
    ctx.globalAlpha = 1;
    ctx.drawImage(st.content, B.x + d.x, B.y + d.y);
  },
  drop: moveDrop,
  options(tool, bar) {
    const o = optionsFor(tool);
    return o.finish(bar, opButtons(tool, cam), separator(),
      o.select('Mode:', 'mode', [{ value: 'move', label: 'Move' }, { value: 'extend', label: 'Extend' }], 90, 'Move the selection (and fill the hole) or extend / duplicate it'),
      separator(),
      o.num('Structure:', 'structure', { min: 1, max: 7, width: 36, title: 'How strictly the moved content keeps its patterns (1 = loose, 7 = strict)' }),
      o.num('Color:', 'color', { min: 0, max: 10, width: 36, title: 'How much colour adaptation is applied to the moved content (0 = none, 10 = maximum)' }),
      separator(),
      o.check('Sample All Layers', 'sampleAll', 'Use data from all visible layers'));
  },
});
