// Eraser (E: Brush / Pencil / Block modes, Erase to History), Background Eraser (E) and Magic Eraser (E).
import { app, type Tool } from '../../core/app';
import type { PixDocument } from '../../core/document';
import { RasterLayer } from '../../core/layer';
import { createCanvas, ctx2d } from '../../core/canvas';
import type { RGB } from '../../core/types';
import { registerIcons } from '../../ui/icons';
import { checkbox, numberField, popupSlider, select, separator, toggleGroup } from '../../ui/widgets';
import { h } from '../../ui/dom';
import { toast } from '../../ui/toast';
import { svgCursor } from '../../ui/cursors';
import {
  createPaintTool, finishOptions, floodKeep, optAngle, optBrush, optCtx, optPercent, optSmoothing, optSymmetry, optToggle,
  paintDefaults, paintTarget, readRegion, scratchCanvas, unlockBackground, type PaintSettings,
} from './common';
import { historySource } from './history-brush';

registerIcons({
  'pt-sample-cont': '<path d="m11.3 9.8 2.9 2.9-6.6 6.6-3.6.6.6-3.6z"/><path d="M13.4 6.6a2.3 2.3 0 0 1 3.2 0l.8.8a2.3 2.3 0 0 1 0 3.2l-2 2-4-4z" fill="currentColor" stroke="none"/><path d="M16 17h6M16 20h6M16 14h6" stroke-dasharray="1.5 1.5"/>',
  'pt-sample-once': '<path d="m11.3 9.8 2.9 2.9-6.6 6.6-3.6.6.6-3.6z"/><path d="M13.4 6.6a2.3 2.3 0 0 1 3.2 0l.8.8a2.3 2.3 0 0 1 0 3.2l-2 2-4-4z" fill="currentColor" stroke="none"/><path d="M18.5 15.5v6M17 17l1.5-1.5"/>',
  'pt-sample-bg': '<path d="m11.3 9.8 2.9 2.9-6.6 6.6-3.6.6.6-3.6z"/><path d="M13.4 6.6a2.3 2.3 0 0 1 3.2 0l.8.8a2.3 2.3 0 0 1 0 3.2l-2 2-4-4z" fill="currentColor" stroke="none"/><rect x="15.5" y="15.5" width="6" height="6"/>',
});

// ------------------------------------------------------------------ Eraser
const eraserSettings = paintDefaults({ size: 45, hardness: 0, tipId: 'soft-round', eraseMode: 'brush' as 'brush' | 'pencil' | 'block', eraseToHistory: false });
let altHistory = false;
let blockTip: HTMLCanvasElement | null = null;
const squareTip = () => { if (!blockTip) { blockTip = createCanvas(32, 32); const x = ctx2d(blockTip); x.fillStyle = '#000'; x.fillRect(0, 0, 32, 32); } return blockTip; };
let hsScratch: HTMLCanvasElement | null = null;

createPaintTool({
  id: 'eraser', name: 'Eraser Tool', group: 'eraser', icon: 'eraser', shortcut: 'E', order: 0,
  settings: eraserSettings,
  historyName: 'Eraser',
  sizeOf: s => (s.eraseMode === 'block' ? 16 / (app.viewport?.zoom || 1) : s.size),
  cursorTip: s => (s.eraseMode === 'block' ? squareTip() : undefined),
  options(bar, tool) {
    const c = optCtx(tool);
    const mode = select<string>([{ value: 'brush', label: 'Brush' }, { value: 'pencil', label: 'Pencil' }, { value: 'block', label: 'Block' }], c.s.eraseMode, v => { c.s.eraseMode = v; c.save(); sync(); app.activeDoc?.redrawOverlay(); }, { width: 80, title: 'Set the eraser mode' });
    const hist = checkbox('Erase to History', c.s.eraseToHistory, v => { c.s.eraseToHistory = v; c.save(); }, { title: 'Erase to the history source state (hold Alt to toggle temporarily)' });
    const opacity = optPercent(c, 'opacity', 'Opacity', 'Set the opacity for strokes');
    const flow = optPercent(c, 'flow', 'Flow', 'Set the flow rate for strokes');
    const rest = h('span.pt-group', null, ...optBrush(c));
    const sync = () => {
      mode.setValue(c.s.eraseMode); hist.setValue(c.s.eraseToHistory);
      const block = c.s.eraseMode === 'block';
      for (const el of [opacity, flow, rest]) el.style.opacity = block ? '0.4' : '';
      for (const el of [opacity, flow, rest]) el.style.pointerEvents = block ? 'none' : '';
    };
    c.syncs.push(sync);
    bar.append(rest, separator(), h('span.opt-label', null, 'Mode:'), mode, separator(), opacity,
      optToggle(c, 'pressureOpacity', 'pressure-opacity', 'Always use Pressure for Opacity. When off, Brush Settings override pressure.'), separator(),
      flow, optToggle(c, 'airbrush', 'airbrush', 'Enable airbrush-style build-up effects'), separator(), ...optSmoothing(c), separator(), optAngle(c), separator(),
      hist, separator(), optToggle(c, 'pressureSize', 'pressure-size', 'Always use Pressure for Size. When off, Brush Settings override pressure.'), optSymmetry());
    sync();
    return finishOptions(c);
  },
  keyDown(e) { if (e.key === 'Alt' && !altHistory) { altHistory = true; e.preventDefault(); } },
  keyUp(e) { if (e.key === 'Alt') altHistory = false; },
  setup(doc, target, p, s) {
    const block = s.eraseMode === 'block';
    const base = block
      ? { tip: squareTip(), aliased: true, hardness: 1, opacity: 1, flow: 1, roundness: 1, angle: 0, spacing: 0.2, noDynamics: true, pressureSize: false, pressureOpacity: false, airbrush: false }
      : s.eraseMode === 'pencil' ? { aliased: true, hardness: 1 } : {};
    if (s.eraseToHistory !== (altHistory || p.alt)) {
      const src = historySource(doc, target, 'Eraser');
      if (!src) return null;
      return {
        ...base, mode: 'paint', blendMode: 'normal', historyName: 'Eraser',
        content: (_d, box) => { hsScratch = scratchCanvas(hsScratch, box.w, box.h); ctx2d(hsScratch).drawImage(src.canvas, src.x - box.x, src.y - box.y); return hsScratch; },
      };
    }
    // Background / locked transparency and masks: paint with the background colour
    if (target.isMask || target.layer?.transparencyLocked) return { ...base, mode: 'paint', blendMode: 'normal', color: app.bg };
    return { ...base, mode: 'erase', blendMode: 'normal' };
  },
});

// ------------------------------------------------------------------ Background Eraser
type Sampling = 'continuous' | 'once' | 'background';
type Limits = 'contiguous' | 'discontiguous' | 'edges';
const bgSettings = paintDefaults({ size: 60, hardness: 1, tipId: 'hard-round', sampling: 'continuous' as Sampling, limits: 'contiguous' as Limits, tolerance: 50, protectFg: false, smoothing: 0 });
let bgScratch: HTMLCanvasElement | null = null;

createPaintTool({
  id: 'bg-eraser', name: 'Background Eraser Tool', group: 'eraser', icon: 'bg-eraser', shortcut: 'E', order: 1,
  settings: bgSettings,
  historyName: 'Background Eraser',
  options(bar, tool) {
    const c = optCtx(tool);
    const samp = toggleGroup<Sampling>([
      { value: 'continuous', icon: 'pt-sample-cont', title: 'Sampling: Continuous' },
      { value: 'once', icon: 'pt-sample-once', title: 'Sampling: Once' },
      { value: 'background', icon: 'pt-sample-bg', title: 'Sampling: Background Swatch' },
    ], c.s.sampling, v => { c.s.sampling = v; c.save(); });
    const lim = select<Limits>([{ value: 'discontiguous', label: 'Discontiguous' }, { value: 'contiguous', label: 'Contiguous' }, { value: 'edges', label: 'Find Edges' }], c.s.limits, v => { c.s.limits = v; c.save(); }, { width: 110, title: 'Set the erasing limits' });
    const tol = popupSlider('Tolerance', c.s.tolerance, v => { c.s.tolerance = v; c.save(); }, { title: 'Set the tolerance for the colors to erase' });
    const prot = checkbox('Protect Foreground Color', c.s.protectFg, v => { c.s.protectFg = v; c.save(); }, { title: 'Prevent erasing areas that match the foreground color' });
    c.syncs.push(() => { samp.setValue(c.s.sampling); lim.setValue(c.s.limits); tol.setValue(c.s.tolerance); prot.setValue(c.s.protectFg); });
    bar.append(...optBrush(c), separator(), samp, separator(), h('span.opt-label', null, 'Limits:'), lim, separator(), tol, separator(), prot, separator(),
      optAngle(c), separator(), optToggle(c, 'pressureSize', 'pressure-size', 'Always use Pressure for Size'));
    return finishOptions(c);
  },
  setup(doc, target, p, s) {
    if (target.kind !== 'pixels') { toast('Could not use the Background Eraser because the target is a mask.', 'error'); return null; }
    const layer = target.layer as RasterLayer;
    if (layer.isBackground) unlockBackground(doc, layer, 'Background Eraser');
    else if (layer.transparencyLocked) { toast('Could not use the Background Eraser because the layer’s transparency is locked.', 'error', 3600); return null; }
    const t = doc.getPaintTarget()!;
    const tol = (s.tolerance / 100) * 255;
    const soft = s.limits === 'edges' ? 0.5 : Math.max(2, tol * 0.25);
    const fg = app.fg;
    let sample: RGB | null = s.sampling === 'background' ? app.bg : null;
    if (s.sampling === 'once') {
      const lx = Math.floor(p.x - t.holder.x), ly = Math.floor(p.y - t.holder.y), cv = t.holder.canvas;
      if (lx >= 0 && ly >= 0 && lx < cv.width && ly < cv.height) { const d = ctx2d(cv).getImageData(lx, ly, 1, 1).data; sample = { r: d[0], g: d[1], b: d[2] }; }
    }
    return {
      mode: 'erase', blendMode: 'normal', opacity: 1, flow: 1, airbrush: false,
      content: (d, box) => {
        const cv = t.holder.canvas;
        const lx = box.x - t.holder.x, ly = box.y - t.holder.y;
        const src = readRegion(cv, lx, ly, box.w, box.h), sd = src.data;
        const cx = Math.floor(d.x - box.x), cy = Math.floor(d.y - box.y);
        let ref = sample;
        if (s.sampling === 'continuous') {
          const i = (Math.max(0, Math.min(box.h - 1, cy)) * box.w + Math.max(0, Math.min(box.w - 1, cx))) * 4;
          if (sd[i + 3] === 0) return null;          // hotspot over transparency: nothing to erase
          ref = { r: sd[i], g: sd[i + 1], b: sd[i + 2] };
        }
        if (!ref) return null;
        const n = box.w * box.h, wts = new Uint8Array(n);
        for (let i = 0, k = 0; i < n; i++, k += 4) {
          if (!sd[k + 3]) continue;
          const dist = Math.max(Math.abs(sd[k] - ref.r), Math.abs(sd[k + 1] - ref.g), Math.abs(sd[k + 2] - ref.b));
          let w = dist <= tol ? 255 : dist < tol + soft ? Math.round(255 * (1 - (dist - tol) / soft)) : 0;
          if (w && s.protectFg && Math.max(Math.abs(sd[k] - fg.r), Math.abs(sd[k + 1] - fg.g), Math.abs(sd[k + 2] - fg.b)) <= Math.max(8, tol)) w = 0;
          wts[i] = w;
        }
        const final = s.limits === 'discontiguous' ? wts : floodKeep(wts, box.w, box.h, Math.max(0, Math.min(box.h - 1, cy)) * box.w + Math.max(0, Math.min(box.w - 1, cx)));
        const out = new ImageData(box.w, box.h), od = out.data;
        for (let i = 0; i < n; i++) od[i * 4 + 3] = final[i];
        bgScratch = scratchCanvas(bgScratch, box.w, box.h);
        ctx2d(bgScratch).putImageData(out, 0, 0);
        return bgScratch;
      },
    };
  },
});

// ------------------------------------------------------------------ Magic Eraser
const magicSettings = { tolerance: 32, antiAlias: true, contiguous: true, sampleAll: false, opacity: 100 };
const MAGIC_CURSOR = svgCursor('<path d="m9 12 6-6 5 5-6 6z" fill="#fff"/><path d="M9 12 5 16l3 3h4l2-2"/><path d="M3 4l1.5 1.5M6.5 2v2M2 6.5h2" /><path d="M5.5 5.5 9 9"/>', 5, 5, 'crosshair');

function magicErase(doc: PixDocument, x: number, y: number) {
  const target = paintTarget(doc, 'Magic Eraser');
  if (!target) return;
  if (target.kind !== 'pixels') { toast('Could not use the Magic Eraser because the target is a mask.', 'error'); return; }
  const layer = target.layer as RasterLayer;
  const sx = Math.floor(x), sy = Math.floor(y);
  if (sx < 0 || sy < 0 || sx >= doc.width || sy >= doc.height) return;
  const s = magicSettings;
  const W = doc.width, H = doc.height;
  // sample image (doc-sized)
  let sample: ImageData;
  if (s.sampleAll) sample = ctx2d(doc.getComposite()).getImageData(0, 0, W, H);
  else { const c = createCanvas(W, H); ctx2d(c).drawImage(layer.canvas, layer.x, layer.y); sample = ctx2d(c).getImageData(0, 0, W, H); }
  const d = sample.data, n = W * H, i0 = (sy * W + sx) * 4;
  const r0 = d[i0], g0 = d[i0 + 1], b0 = d[i0 + 2], a0 = d[i0 + 3];
  const tol = s.tolerance, soft = s.antiAlias ? Math.max(1, tol * 0.3 + 4) : 0;
  const wts = new Uint8Array(n);
  for (let i = 0, k = 0; i < n; i++, k += 4) {
    const a = d[k + 3];
    const dist = a0 === 0 && a === 0 ? 0 : Math.max(Math.abs(d[k] - r0), Math.abs(d[k + 1] - g0), Math.abs(d[k + 2] - b0), Math.abs(a - a0));
    wts[i] = dist <= tol ? 255 : soft && dist < tol + soft ? Math.round(255 * (1 - (dist - tol) / soft)) : 0;
  }
  const region = s.contiguous ? floodKeep(wts, W, H, sy * W + sx) : wts;
  const mask = createCanvas(W, H), mx = ctx2d(mask), mi = mx.createImageData(W, H);
  let any = false;
  for (let i = 0; i < n; i++) if (region[i]) { mi.data[i * 4 + 3] = region[i]; any = true; }
  if (!any) return;
  mx.putImageData(mi, 0, 0);
  if (!doc.selection.empty) { mx.globalCompositeOperation = 'destination-in'; mx.drawImage(doc.selection.mask!, 0, 0); }
  if (layer.isBackground) unlockBackground(doc, layer, 'Magic Eraser');
  layer.ensureRect({ x: 0, y: 0, w: W, h: H });
  const edit = doc.history.beginPixelEdit(layer, 'Magic Eraser', 'magic-eraser');
  const lx = ctx2d(layer.canvas);
  lx.save();
  lx.globalAlpha = s.opacity / 100;
  if (layer.transparencyLocked) {
    const f = createCanvas(W, H), fx = ctx2d(f);
    fx.fillStyle = `rgb(${app.bg.r},${app.bg.g},${app.bg.b})`; fx.fillRect(0, 0, W, H);
    fx.globalCompositeOperation = 'destination-in'; fx.drawImage(mask, 0, 0);
    lx.globalCompositeOperation = 'source-atop';
    lx.drawImage(f, -layer.x, -layer.y);
  } else {
    lx.globalCompositeOperation = 'destination-out';
    lx.drawImage(mask, -layer.x, -layer.y);
  }
  lx.restore();
  if (edit.commit('Magic Eraser', null, 'magic-eraser')) doc.pixelsChanged(layer, null);
}

const magic: Tool = {
  id: 'magic-eraser', name: 'Magic Eraser Tool', group: 'eraser', icon: 'magic-eraser', shortcut: 'E', order: 2,
  settings: magicSettings,
  cursor: MAGIC_CURSOR,
  options(bar) {
    const save = () => app.saveToolSettings(magic);
    const tol = numberField(magicSettings.tolerance, v => { magicSettings.tolerance = v; save(); }, { min: 0, max: 255, width: 44, label: 'Tolerance:', title: 'Set the tolerance for colors to erase' });
    const aa = checkbox('Anti-alias', magicSettings.antiAlias, v => { magicSettings.antiAlias = v; save(); }, { title: 'Smooth the edges of the erased area' });
    const co = checkbox('Contiguous', magicSettings.contiguous, v => { magicSettings.contiguous = v; save(); }, { title: 'Erase only adjacent pixels of similar color' });
    const all = checkbox('Sample All Layers', magicSettings.sampleAll, v => { magicSettings.sampleAll = v; save(); }, { title: 'Use the merged image to determine the erased area' });
    const op = popupSlider('Opacity', magicSettings.opacity, v => { magicSettings.opacity = v; save(); }, { title: 'Set the opacity of the erasure' });
    bar.append(tol, separator(), aa, co, all, separator(), op);
  },
  pointerDown(p, doc) { magicErase(doc, p.x, p.y); },
};
app.registerTool(magic);

export type { PaintSettings };
