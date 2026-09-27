// Quick Selection Tool (W) — brush-based edge-aware region growing — and Magic Wand Tool (W).
import { app, type Tool } from '../../core/app';
import type { PixDocument } from '../../core/document';
import type { Rect, SelectOp } from '../../core/types';
import { createCanvas, ctx2d } from '../../core/canvas';
import { drawBrushCursor } from '../../core/viewport';
import { Selection } from '../../core/selection';
import { brushPicker } from '../../ui/brush-picker';
import { checkbox, numberField, select, label } from '../../ui/widgets';
import { quickGrow, refineEdges, softenEdges, wandMask } from '../../features/selection/algo';
import { busy, commitMask, sampleGradient, sampleImage } from '../../features/selection/ops';
import {
  glyphCursor, liveOp, nudgeKey, onOptions, opButtons, resolveOp, selectAndMaskButton, selectionContextMenu,
  selectSubjectButton, separator,
} from './common';

// ------------------------------------------------------------------ Magic Wand
{
  const s = { op: 'replace' as SelectOp, sampleSize: 1, tolerance: 32, antiAlias: true, contiguous: true, sampleAll: false };
  const WAND = '<path d="M4 20 14 10"/><path d="m14 10 2.5-2.5" stroke-width="2.6"/><path d="M18.5 3v3M18.5 11v3M13 8.5h3M21 8.5h3"/>';
  const tool: Tool = {
    id: 'magic-wand', name: 'Magic Wand Tool', group: 'quick-select', icon: 'magic-wand', shortcut: 'W', order: 1, settings: s,
    cursor: () => glyphCursor(WAND, 4, 20, liveOp(s.op)),
    options(bar) {
      const ops = opButtons(tool, s);
      const size = select([
        { value: 1, label: 'Point Sample' }, { value: 3, label: '3 by 3 Average' }, { value: 5, label: '5 by 5 Average' }, { value: 11, label: '11 by 11 Average' },
        { value: 31, label: '31 by 31 Average' }, { value: 51, label: '51 by 51 Average' }, { value: 101, label: '101 by 101 Average' },
      ], s.sampleSize, v => { s.sampleSize = v; app.saveToolSettings(tool); }, { width: 130, title: 'Sample size' });
      const tol = numberField(s.tolerance, v => { s.tolerance = v; app.saveToolSettings(tool); }, { min: 0, max: 255, width: 40, label: 'Tolerance:', title: 'Range of similar colours to select (0–255)' });
      const aa = checkbox('Anti-alias', s.antiAlias, v => { s.antiAlias = v; app.saveToolSettings(tool); });
      const cont = checkbox('Contiguous', s.contiguous, v => { s.contiguous = v; app.saveToolSettings(tool); }, { title: 'Select only adjacent areas using the same colours' });
      const all = checkbox('Sample All Layers', s.sampleAll, v => { s.sampleAll = v; app.saveToolSettings(tool); });
      bar.append(ops, separator(), label('Sample Size:'), size, separator(), tol, aa, cont, all, separator(), selectSubjectButton(), selectAndMaskButton());
      return onOptions(() => { ops.setValue(s.op); size.setValue(s.sampleSize); tol.setValue(s.tolerance); aa.setValue(s.antiAlias); cont.setValue(s.contiguous); all.setValue(s.sampleAll); });
    },
    pointerDown(p, doc) {
      const x = Math.floor(p.x), y = Math.floor(p.y);
      if (x < 0 || y < 0 || x >= doc.width || y >= doc.height) return;
      const op = resolveOp(s.op, p.shift, p.alt);
      const img = sampleImage(doc, s.sampleAll);
      let m = wandMask(img.data, doc.width, doc.height, x, y, s.tolerance, s.contiguous, s.sampleSize);
      if (s.antiAlias) m = softenEdges(m, doc.width, doc.height);
      commitMask(doc, 'Magic Wand', m, op);
    },
    keyDown: (e, doc) => nudgeKey(e, doc),
    contextMenu: selectionContextMenu,
  };
  app.registerTool(tool);
}

// ------------------------------------------------------------------ Quick Selection
{
  const s = { op: 'replace' as SelectOp, size: 30, hardness: 1, spacing: 25, sampleAll: false, enhanceEdge: false };
  interface St { op: SelectOp; acc: Uint8Array; bounds: Rect | null; lx: number; ly: number; img: ImageData; grad: Float32Array; tint: HTMLCanvasElement; dirty: Rect | null }
  let st: St | null = null;
  const union = (a: Rect | null, b: Rect): Rect => a ? { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.max(a.x + a.w, b.x + b.w) - Math.min(a.x, b.x), h: Math.max(a.y + a.h, b.y + b.h) - Math.min(a.y, b.y) } : { ...b };

  function dab(x: St, cx: number, cy: number, W: number, H: number) {
    const r = Math.max(1, s.size / 2);
    const g = quickGrow(x.img.data, x.grad, W, H, cx, cy, r, r * 6 + 80);
    if (!g) return;
    for (let yy = 0; yy < g.h; yy++) {
      const row = (yy + g.y) * W + g.x, mr = yy * g.w;
      for (let xx = 0; xx < g.w; xx++) { const v = g.mask[mr + xx]; if (v > x.acc[row + xx]) x.acc[row + xx] = v; }
    }
    const rect = { x: g.x, y: g.y, w: g.w, h: g.h };
    x.bounds = union(x.bounds, rect);
    x.dirty = union(x.dirty, rect);
  }
  /** Push dirty accumulator pixels into the tint canvas (small rect only). */
  function flushTint(x: St, W: number) {
    const r = x.dirty;
    if (!r) return;
    x.dirty = null;
    const t = ctx2d(x.tint), img = t.createImageData(r.w, r.h), d = img.data;
    const sub = x.op === 'subtract';
    for (let yy = 0; yy < r.h; yy++) for (let xx = 0; xx < r.w; xx++) {
      const v = x.acc[(yy + r.y) * W + xx + r.x], j = (yy * r.w + xx) * 4;
      d[j] = sub ? 255 : 40; d[j + 1] = sub ? 70 : 140; d[j + 2] = sub ? 70 : 255; d[j + 3] = v * 0.38;
    }
    t.putImageData(img, r.x, r.y);
  }
  const tool: Tool = {
    id: 'quick-select', name: 'Quick Selection Tool', group: 'quick-select', icon: 'quick-select', shortcut: 'W', order: 0, settings: s,
    paints: false,
    cursor: 'none',
    options(bar) {
      const ops = opButtons(tool, s, ['replace', 'add', 'subtract']);
      const bp = brushPicker(s, () => app.saveToolSettings(tool));
      const all = checkbox('Sample All Layers', s.sampleAll, v => { s.sampleAll = v; app.saveToolSettings(tool); });
      const enh = checkbox('Enhance Edge', s.enhanceEdge, v => { s.enhanceEdge = v; app.saveToolSettings(tool); }, { title: 'Reduce roughness and blockiness in the selection boundary' });
      bar.append(ops, separator(), bp, separator(), all, enh, separator(), selectSubjectButton(), selectAndMaskButton());
      return onOptions(() => { ops.setValue(s.op); (bp as any).refresh?.(); all.setValue(s.sampleAll); enh.setValue(s.enhanceEdge); });
    },
    pointerDown(p, doc) {
      const W = doc.width, H = doc.height;
      // New selection mode switches to Add after the first stroke (like Photoshop)
      let op = resolveOp(s.op, p.shift, p.alt);
      if (op === 'intersect') op = 'add';
      const img = sampleImage(doc, s.sampleAll);
      st = { op, acc: new Uint8Array(W * H), bounds: null, lx: p.x, ly: p.y, img, grad: sampleGradient(img), tint: createCanvas(W, H), dirty: null };
      dab(st, p.x, p.y, W, H);
      flushTint(st, W);
      doc.redrawOverlay();
    },
    pointerMove(p, doc) {
      const x = st;
      if (!x) return;
      const W = doc.width, H = doc.height, step = Math.max(2, s.size * 0.35);
      const dist = Math.hypot(p.x - x.lx, p.y - x.ly);
      if (dist < step) return;
      const n = Math.ceil(dist / step);
      for (let k = 1; k <= n; k++) dab(x, x.lx + (p.x - x.lx) * k / n, x.ly + (p.y - x.ly) * k / n, W, H);
      x.lx = p.x; x.ly = p.y;
      flushTint(x, W);
      doc.redrawOverlay();
    },
    async pointerUp(_p, doc) {
      const x = st;
      st = null;
      if (!x || !x.bounds) { doc.redrawOverlay(); return; }
      const W = doc.width, H = doc.height;
      let acc = x.acc;
      if (s.enhanceEdge) {
        const b = x.bounds, pad = 8;
        const r = { x: Math.max(0, b.x - pad), y: Math.max(0, b.y - pad), w: 0, h: 0 };
        r.w = Math.min(W, b.x + b.w + pad) - r.x; r.h = Math.min(H, b.y + b.h + pad) - r.y;
        acc = await busy('Enhance Edge…', () => {
          const sub = new Uint8ClampedArray(r.w * r.h * 4), f = new Float32Array(r.w * r.h);
          for (let y = 0; y < r.h; y++) {
            sub.set(x.img.data.subarray(((y + r.y) * W + r.x) * 4, ((y + r.y) * W + r.x + r.w) * 4), y * r.w * 4);
            for (let xx = 0; xx < r.w; xx++) f[y * r.w + xx] = x.acc[(y + r.y) * W + r.x + xx] / 255;
          }
          const q = refineEdges(sub, r.w, r.h, f, 3, 2e-3);
          const out = new Uint8Array(W * H);
          for (let y = 0; y < r.h; y++) for (let xx = 0; xx < r.w; xx++) {
            const v = (q[y * r.w + xx] - 0.5) * 1.8 + 0.5;
            out[(y + r.y) * W + r.x + xx] = v <= 0 ? 0 : v >= 1 ? 255 : Math.round(v * 255);
          }
          return out;
        });
      }
      commitMask(doc, 'Quick Selection', Selection.canvasFromAlpha(acc, W, H), x.op);
      if (s.op === 'replace') { s.op = 'add'; app.saveToolSettings(tool); }
      doc.redrawOverlay();
    },
    keyDown: (e, doc) => nudgeKey(e, doc),
    drawOverlay(ctx, view) {
      if (st) {
        ctx.save();
        view.applyDocTransform(ctx);
        ctx.imageSmoothingEnabled = view.zoom < 1;
        ctx.drawImage(st.tint, 0, 0);
        ctx.restore();
      }
      drawBrushCursor(ctx, view, s.size);
      if (view.pointer.inside) {
        const op = st ? st.op : liveOp(s.op === 'replace' ? 'add' : s.op);
        ctx.save();
        ctx.font = '600 13px system-ui'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        const t = op === 'subtract' ? '−' : '+';
        ctx.lineWidth = 3; ctx.strokeStyle = '#fff'; ctx.strokeText(t, view.pointer.sx, view.pointer.sy);
        ctx.fillStyle = '#000'; ctx.fillText(t, view.pointer.sx, view.pointer.sy);
        ctx.restore();
      }
    },
    contextMenu: selectionContextMenu,
  };
  app.registerTool(tool);
}
