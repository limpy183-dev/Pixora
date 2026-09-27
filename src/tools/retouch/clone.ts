// Clone Stamp Tool (S) and Pattern Stamp Tool (S).
import { app, type Tool, type ToolPointer } from '../../core/app';
import type { PixDocument } from '../../core/document';
import { borrowCanvas, ctx2d, returnCanvas } from '../../core/canvas';
import type { Viewport } from '../../core/viewport';
import type { BlendMode, Point } from '../../core/types';
import { BLEND_MODE_MENU, BLEND_MODE_LABELS } from '../../core/types';
import type { SelectOption } from '../../ui/widgets';
import { separator } from '../../ui/widgets';
import { BufferStroke, type DabInfo } from './strokes';
import {
  CURSOR_TARGET, drawCursor, fail, mods, optionsFor, patternById, retouchTarget, sampleImage, type Img, type SampleMode,
} from './common';
import { activeSource, clone, defineSource, destToSource, hoverAnchor, sourceDoc, sourceToDest, strokeAnchor } from './source';

export const PAINT_MODES: SelectOption<BlendMode>[] = BLEND_MODE_MENU.filter(m => m !== '-' && m !== 'dissolve').map(m => ({ value: m as BlendMode, label: BLEND_MODE_LABELS[m as BlendMode] }));

/** Render the source image through the clone mapping into a dab, masked by the tip. */
export function renderSourceDab(bx: CanvasRenderingContext2D, img: Img, M: DOMMatrix, dab: DabInfo, tip: HTMLCanvasElement, tl: Point, holder: Point) {
  const c = borrowCanvas(tip.width, tip.height), x = ctx2d(c);
  x.setTransform(1, 0, 0, 1, -tl.x, -tl.y);
  x.transform(M.a, M.b, M.c, M.d, M.e, M.f);
  x.imageSmoothingEnabled = !(M.a === 1 && M.d === 1 && M.b === 0 && M.c === 0);
  x.imageSmoothingQuality = 'high';
  x.drawImage(img.canvas, img.x, img.y);
  x.setTransform(1, 0, 0, 1, 0, 0);
  x.globalCompositeOperation = 'destination-in';
  x.drawImage(tip, 0, 0);
  bx.globalAlpha = Math.max(0, Math.min(1, dab.flow));
  bx.drawImage(c, tl.x - holder.x, tl.y - holder.y);
  returnCanvas(c);
}

// ------------------------------------------------------------------ overlay helpers (shared with the Healing Brush)
/** Draw the clone overlay (source preview) and, while painting, the source crosshair. */
export function drawCloneOverlay(ctx: CanvasRenderingContext2D, view: Viewport, doc: PixDocument, size: number, aligned: boolean, anchor: Point | null) {
  const s = activeSource(), sd = sourceDoc(s);
  if (!s.defined || !sd) return;
  const ov = clone.overlay, p = view.pointer;
  const A = anchor || hoverAnchor(s, p, aligned);
  if (ov.showOverlay && p.inside && !(clone.painting && ov.autoHide)) {
    const t = sd.getPaintTarget();
    const img = t && !t.isMask && sd.activeLayer ? { canvas: t.holder.canvas, x: t.holder.x, y: t.holder.y } : { canvas: sd.getComposite(), x: 0, y: 0 };
    ctx.save();
    if (ov.clipped) { ctx.beginPath(); ctx.arc(p.sx, p.sy, Math.max(2, (size * view.zoom) / 2), 0, Math.PI * 2); ctx.clip(); }
    view.applyDocTransform(ctx);
    ctx.beginPath(); ctx.rect(0, 0, doc.width, doc.height); ctx.clip();
    const M = sourceToDest(s, A);
    ctx.transform(M.a, M.b, M.c, M.d, M.e, M.f);
    ctx.globalAlpha = ov.opacity / 100;
    ctx.globalCompositeOperation = ov.mode === 'normal' ? 'source-over' : ov.mode;
    if (ov.invert) ctx.filter = 'invert(1)';
    ctx.imageSmoothingEnabled = view.zoom < 1;
    ctx.drawImage(img.canvas, img.x, img.y);
    ctx.restore();
  }
  if (clone.painting && anchor && sd === doc) {
    const q = destToSource(s, anchor, { x: p.x, y: p.y });
    const sp = view.docToScreen(q.x, q.y);
    ctx.save();
    ctx.lineWidth = 1;
    for (const [col, w] of [['rgba(255,255,255,.9)', 3], ['rgba(0,0,0,.85)', 1]] as const) {
      ctx.strokeStyle = col; ctx.lineWidth = w;
      ctx.beginPath(); ctx.moveTo(sp.x - 8, sp.y); ctx.lineTo(sp.x + 8, sp.y); ctx.moveTo(sp.x, sp.y - 8); ctx.lineTo(sp.x, sp.y + 8); ctx.stroke();
    }
    ctx.restore();
  }
}

// ------------------------------------------------------------------ Clone Stamp
const cs = {
  size: 70, hardness: 0, tipId: 'soft-round', roundness: 1, angle: 0, spacing: 25, pressureSize: false,
  mode: 'normal' as BlendMode, opacity: 100, flow: 100, airbrush: false, pressureOpacity: false,
  aligned: true, sample: 'current' as SampleMode,
};
let stroke: BufferStroke | null = null;
let anchor: Point | null = null;

const cloneTool: Tool = {
  id: 'clone-stamp', name: 'Clone Stamp Tool', group: 'stamp', icon: 'clone-stamp', shortcut: 'S', order: 0,
  settings: cs, paints: true,
  cursor: () => (mods.alt ? CURSOR_TARGET : 'none'),
  options(bar) {
    const o = optionsFor(cloneTool);
    return o.finish(bar, o.brush(), o.brushPanel(), o.clonePanel(), separator(),
      o.select('Mode:', 'mode', PAINT_MODES, 120), separator(),
      o.pct('Opacity', 'opacity', 'Set opacity for stroke'), o.toggle('pressure-opacity', 'pressureOpacity', 'Always use pressure for opacity. When off, Brush Settings presets control pressure.'), separator(),
      o.pct('Flow', 'flow', 'Set flow rate for stroke'), o.toggle('airbrush', 'airbrush', 'Enable airbrush-style build-up effects'), separator(),
      o.angle(), separator(),
      o.check('Aligned', 'aligned', 'Use the same offset for each stroke'), separator(),
      o.sample(), separator(),
      o.toggle('pressure-size', 'pressureSize', 'Always use pressure for size. When off, Brush Settings presets control pressure.'));
  },
  pointerDown(p: ToolPointer, doc: PixDocument) {
    if (p.alt) { defineSource(doc, p.x, p.y); return; }
    const src = activeSource(), sd = sourceDoc(src);
    if (!src.defined || !sd) { fail('Could not use the clone stamp because the area to clone has not been defined (Alt-click to define a source point).'); return; }
    const t = retouchTarget(doc, 'clone stamp');
    if (!t) return;
    const img = sampleImage(sd, cs.sample, sd === doc ? t : sd.getPaintTarget());
    anchor = strokeAnchor(src, p, cs.aligned);
    const M = sourceToDest(src, anchor);
    clone.painting = true;
    stroke = new BufferStroke(doc, t, {
      ...cs, opacity: cs.opacity / 100, flow: cs.flow / 100, blendMode: cs.mode, historyName: 'Clone Stamp',
      renderDab: (bx, dab, tip, tl, holder) => renderSourceDab(bx, img, M, dab, tip, tl, holder),
    }, p);
  },
  pointerMove(p) { stroke?.move(p); },
  pointerUp() {
    stroke?.end(); stroke = null;
    clone.painting = false; anchor = null;
    app.activeDoc?.redrawOverlay();
  },
  deactivate() { if (stroke) { stroke.end(); stroke = null; clone.painting = false; } },
  drawOverlay(ctx, view, doc) {
    drawCloneOverlay(ctx, view, doc, cs.size, cs.aligned, anchor);
    if (!mods.alt) drawCursor(ctx, view, cs);
  },
};
app.registerTool(cloneTool);

// ------------------------------------------------------------------ Pattern Stamp
const ps = {
  size: 70, hardness: 0, tipId: 'soft-round', roundness: 1, angle: 0, spacing: 25, pressureSize: false,
  mode: 'normal' as BlendMode, opacity: 100, flow: 100, airbrush: false, pressureOpacity: false,
  patternId: 'checker', aligned: true, impressionist: false,
};
let pStroke: BufferStroke | null = null;

const patCache = new WeakMap<HTMLCanvasElement, ImageData>();
function patternPixel(c: HTMLCanvasElement, x: number, y: number) {
  let d = patCache.get(c);
  if (!d) { d = ctx2d(c).getImageData(0, 0, c.width, c.height); patCache.set(c, d); }
  const px = ((Math.floor(x) % c.width) + c.width) % c.width, py = ((Math.floor(y) % c.height) + c.height) % c.height;
  const i = (py * c.width + px) * 4;
  return { r: d.data[i], g: d.data[i + 1], b: d.data[i + 2], a: d.data[i + 3] / 255 };
}

const patternTool: Tool = {
  id: 'pattern-stamp', name: 'Pattern Stamp Tool', group: 'stamp', icon: 'pattern-stamp', shortcut: 'S', order: 1,
  settings: ps, paints: true,
  cursor: 'none',
  options(bar) {
    const o = optionsFor(patternTool);
    return o.finish(bar, o.brush(), o.brushPanel(), separator(),
      o.select('Mode:', 'mode', PAINT_MODES, 120), separator(),
      o.pct('Opacity', 'opacity', 'Set opacity for stroke'), o.toggle('pressure-opacity', 'pressureOpacity', 'Always use pressure for opacity'), separator(),
      o.pct('Flow', 'flow', 'Set flow rate for stroke'), o.toggle('airbrush', 'airbrush', 'Enable airbrush-style build-up effects'), separator(),
      o.angle(), separator(),
      o.pattern(), separator(),
      o.check('Aligned', 'aligned', 'Keep the pattern continuous between strokes'),
      o.check('Impressionist', 'impressionist', 'Paint with daubs of pattern colour for an impressionist effect'), separator(),
      o.toggle('pressure-size', 'pressureSize', 'Always use pressure for size'));
  },
  pointerDown(p, doc) {
    const pat = patternById(ps.patternId);
    if (!pat) { fail('Could not use the pattern stamp because no pattern is defined.'); return; }
    const t = retouchTarget(doc, 'pattern stamp');
    if (!t) return;
    const origin = ps.aligned ? { x: 0, y: 0 } : { x: Math.round(p.x), y: Math.round(p.y) };
    let seed = 1;
    const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    pStroke = new BufferStroke(doc, t, {
      ...ps, opacity: ps.opacity / 100, flow: ps.flow / 100, blendMode: ps.mode, historyName: 'Pattern Stamp',
      renderDab: (bx, dab, tip, tl, holder) => {
        const c = borrowCanvas(tip.width, tip.height), x = ctx2d(c);
        if (ps.impressionist) {
          // daub: a smaller, jittered dab in the pattern colour found near the brush centre
          const jx = (rnd() - 0.5) * dab.size * 0.5, jy = (rnd() - 0.5) * dab.size * 0.5;
          const col = patternPixel(pat.canvas, dab.x + jx - origin.x, dab.y + jy - origin.y);
          const k = 0.45 + rnd() * 0.45;
          x.fillStyle = `rgba(${col.r},${col.g},${col.b},${col.a})`;
          x.fillRect(0, 0, c.width, c.height);
          x.globalCompositeOperation = 'destination-in';
          x.translate(c.width / 2 + jx, c.height / 2 + jy); x.scale(k, k);
          x.drawImage(tip, -tip.width / 2, -tip.height / 2);
        } else {
          const cp = x.createPattern(pat.canvas, 'repeat')!;
          cp.setTransform(new DOMMatrix().translate(origin.x - tl.x, origin.y - tl.y));
          x.fillStyle = cp;
          x.fillRect(0, 0, c.width, c.height);
          x.globalCompositeOperation = 'destination-in';
          x.drawImage(tip, 0, 0);
        }
        bx.globalAlpha = Math.max(0, Math.min(1, dab.flow));
        bx.drawImage(c, tl.x - holder.x, tl.y - holder.y);
        returnCanvas(c);
      },
    }, p);
  },
  pointerMove(p) { pStroke?.move(p); },
  pointerUp() { pStroke?.end(); pStroke = null; },
  deactivate() { pStroke?.end(); pStroke = null; },
  drawOverlay(ctx, view) { drawCursor(ctx, view, ps); },
};
app.registerTool(patternTool);
