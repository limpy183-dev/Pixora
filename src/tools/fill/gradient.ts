// Gradient Tool (G): drag to draw a Linear / Radial / Angle / Reflected / Diamond gradient on the paint target.
// Live preview renders only the visible part at screen resolution (rAF-batched); full quality on release.
// Shift constrains to 45°, respects the selection, Lock Transparent Pixels and layer masks / Quick Mask. History: "Gradient".
import { app, type Tool, type ToolPointer } from '../../core/app';
import type { PaintTarget, PixDocument } from '../../core/document';
import { RasterLayer } from '../../core/layer';
import type { Gradient, GradientShape, Point, Rect } from '../../core/types';
import type { BrushMode } from '../../core/brush';
import { renderGradient } from '../../core/gradient';
import { FG_TO_BG, resolveGradient } from '../../core/presets';
import { canvasFromImageData, cloneCanvas, ctx2d } from '../../core/canvas';
import { intersectRect, unionRect } from '../../core/geom';
import { events } from '../../core/events';
import { checkbox, label, popupSlider, select, separator, toggleGroup } from '../../ui/widgets';
import { registerIcons } from '../../ui/icons';
import { CURSORS } from '../../ui/cursors';
import { gradientPresetPicker } from '../../features/color/preset-ui';
import { MODE_OPTIONS, composeFill, fillTarget, setTargetPreview } from './common';

registerIcons({
  'grad-linear': '<defs><linearGradient id="px-gl" x1="0" x2="1"><stop offset="0" stop-color="currentColor"/><stop offset="1" stop-color="currentColor" stop-opacity=".08"/></linearGradient></defs><rect x="3.5" y="3.5" width="17" height="17" rx="1" fill="url(#px-gl)"/>',
  'grad-radial': '<defs><radialGradient id="px-gr"><stop offset="0" stop-color="currentColor"/><stop offset="1" stop-color="currentColor" stop-opacity=".08"/></radialGradient></defs><rect x="3.5" y="3.5" width="17" height="17" rx="1" fill="url(#px-gr)"/>',
  'grad-angle': '<rect x="3.5" y="3.5" width="17" height="17" rx="1"/>'
    + [0, 1, 2, 3, 4, 5, 6, 7].map(i => { const a0 = (i / 8) * Math.PI * 2, a1 = ((i + 1) / 8) * Math.PI * 2, r = 12; return `<path d="M12 12L${(12 + r * Math.cos(a0)).toFixed(2)} ${(12 - r * Math.sin(a0)).toFixed(2)}L${(12 + r * Math.cos(a1)).toFixed(2)} ${(12 - r * Math.sin(a1)).toFixed(2)}Z" fill="currentColor" fill-opacity="${(0.08 + i * 0.12).toFixed(2)}" stroke="none" clip-path="url(#px-ga)"/>`; }).join('')
    + '<clipPath id="px-ga"><rect x="3.5" y="3.5" width="17" height="17" rx="1"/></clipPath>',
  'grad-reflected': '<defs><linearGradient id="px-gf" x1="0" x2="1"><stop offset="0" stop-color="currentColor" stop-opacity=".08"/><stop offset=".5" stop-color="currentColor"/><stop offset="1" stop-color="currentColor" stop-opacity=".08"/></linearGradient></defs><rect x="3.5" y="3.5" width="17" height="17" rx="1" fill="url(#px-gf)"/>',
  'grad-diamond': '<rect x="3.5" y="3.5" width="17" height="17" rx="1"/><path d="M12 3.5 20.5 12 12 20.5 3.5 12z" fill="currentColor" fill-opacity=".2" stroke="none"/><path d="M12 6.5 17.5 12 12 17.5 6.5 12z" fill="currentColor" fill-opacity=".45" stroke="none"/><path d="M12 9.3 14.7 12 12 14.7 9.3 12z" fill="currentColor" stroke="none"/>',
});

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));
const settings = {
  gradient: { name: FG_TO_BG, stops: [{ pos: 0, color: { r: 0, g: 0, b: 0 } }, { pos: 1, color: { r: 255, g: 255, b: 255 } }], opacityStops: [{ pos: 0, opacity: 1 }, { pos: 1, opacity: 1 }], smoothness: 1 } as Gradient,
  shape: 'linear' as GradientShape,
  mode: 'normal' as BrushMode,
  opacity: 100,
  reverse: false,
  dither: true,
  transparency: true,
};

interface Drag {
  doc: PixDocument; t: PaintTarget;
  p0: Point; p1: Point;
  orig: HTMLCanvasElement;      // holder canvas at drag start (never modified during the drag)
  preview: HTMLCanvasElement;   // holder-sized copy that receives the live preview
  region: Rect;                 // doc rect the gradient may cover (doc ∩ holder ∩ selection)
  last: Rect | null;            // last previewed doc rect
  raf: number;
  moved: boolean;
}
let drag: Drag | null = null;

function effectiveGradient(): Gradient {
  const g = settings.gradient;
  if (settings.transparency) return g;
  return { ...resolveGradient(g), name: 'Custom', opacityStops: [{ pos: 0, opacity: 1 }, { pos: 1, opacity: 1 }] };
}

/** Visible document rect of the viewport (axis-aligned). */
function visibleDocRect(): Rect | null {
  const vp = app.viewport;
  if (!vp) return null;
  const pts = [vp.screenToDoc(0, 0), vp.screenToDoc(vp.width, 0), vp.screenToDoc(0, vp.height), vp.screenToDoc(vp.width, vp.height)];
  const xs = pts.map(p => p.x), ys = pts.map(p => p.y);
  const x = Math.floor(Math.min(...xs)), y = Math.floor(Math.min(...ys));
  return { x, y, w: Math.ceil(Math.max(...xs)) - x, h: Math.ceil(Math.max(...ys)) - y };
}

/** Render the gradient for doc rect r at scale k (1 = full resolution) into a canvas. */
function gradientCanvas(r: Rect, k: number, p0: Point, p1: Point, dither: boolean): HTMLCanvasElement {
  const w = Math.max(1, Math.ceil(r.w * k)), hh = Math.max(1, Math.ceil(r.h * k));
  const sx = w / r.w, sy = hh / r.h;
  const img = renderGradient(w, hh, effectiveGradient(), settings.shape,
    { x: (p0.x - r.x) * sx, y: (p0.y - r.y) * sy }, { x: (p1.x - r.x) * sx, y: (p1.y - r.y) * sy },
    { reverse: settings.reverse, dither });
  return canvasFromImageData(img);
}

function renderPreview() {
  const d = drag;
  if (!d) return;
  d.raf = 0;
  const vis = visibleDocRect();
  const r = vis ? intersectRect(d.region, vis) : d.region;
  const px = ctx2d(d.preview);
  // restore the previously previewed area that falls outside the new one
  if (d.last && (!r || d.last.x !== r.x || d.last.y !== r.y || d.last.w !== r.w || d.last.h !== r.h)) {
    const L = d.last, hx = d.t.holder.x, hy = d.t.holder.y;
    px.save(); px.globalCompositeOperation = 'copy';
    px.drawImage(d.orig, L.x - hx, L.y - hy, L.w, L.h, L.x - hx, L.y - hy, L.w, L.h);
    px.restore();
  }
  if (!r) { setTargetPreview(d.doc, d.t, d.preview, d.last); d.last = null; return; }
  const zoom = app.viewport?.zoom ?? 1;
  const k = Math.min(1, zoom, Math.sqrt(420000 / (r.w * r.h)));
  const src = gradientCanvas(r, k, d.p0, d.p1, false);
  composeFill(d.doc, d.t, d.preview, d.orig, src, r, settings.mode, settings.opacity / 100);
  setTargetPreview(d.doc, d.t, d.preview, unionRect(d.last, r));
  d.last = r;
}

function constrain(p0: Point, p: ToolPointer): Point {
  if (!p.shift) return { x: p.x, y: p.y };
  const dx = p.x - p0.x, dy = p.y - p0.y, len = Math.hypot(dx, dy);
  const a = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
  return { x: p0.x + Math.cos(a) * len, y: p0.y + Math.sin(a) * len };
}

function finish(commit: boolean) {
  const d = drag;
  if (!d) return;
  drag = null;
  if (d.raf) cancelAnimationFrame(d.raf);
  setTargetPreview(d.doc, d.t, null, d.last);
  if (!commit || !d.moved || Math.hypot(d.p1.x - d.p0.x, d.p1.y - d.p0.y) < 0.5) { d.doc.redrawOverlay(); return; }
  document.body.classList.add('busy');
  try {
    const r = d.region;
    const out = cloneCanvas(d.orig);
    const src = gradientCanvas(r, 1, d.p0, d.p1, settings.dither);
    composeFill(d.doc, d.t, out, d.orig, src, r, settings.mode, settings.opacity / 100);
    d.doc.history.transaction('Gradient', () => { d.t.holder.canvas = out; }, 'gradient');
    d.doc.pixelsChanged(d.t.layer, r);
  } finally { document.body.classList.remove('busy'); }
  d.doc.redrawOverlay();
}

const tool: Tool = {
  id: 'gradient', name: 'Gradient Tool', group: 'gradient', icon: 'gradient', shortcut: 'G', order: 0,
  altEyedropper: true,
  settings,
  cursor: () => CURSORS.crosshair,
  options(bar) {
    const picker = gradientPresetPicker(settings.gradient, g => { settings.gradient = clone(g); app.saveToolSettings(tool); });
    const shapes = toggleGroup<GradientShape>([
      { value: 'linear', icon: 'grad-linear', title: 'Linear Gradient' },
      { value: 'radial', icon: 'grad-radial', title: 'Radial Gradient' },
      { value: 'angle', icon: 'grad-angle', title: 'Angle Gradient' },
      { value: 'reflected', icon: 'grad-reflected', title: 'Reflected Gradient' },
      { value: 'diamond', icon: 'grad-diamond', title: 'Diamond Gradient' },
    ], settings.shape, v => { settings.shape = v; app.saveToolSettings(tool); });
    const mode = select(MODE_OPTIONS, settings.mode, v => { settings.mode = v; app.saveToolSettings(tool); }, { width: 110, title: 'Blending mode' });
    const opacity = popupSlider('Opacity', settings.opacity, v => { settings.opacity = v; app.saveToolSettings(tool); }, { title: 'Opacity of the gradient' });
    const reverse = checkbox('Reverse', settings.reverse, v => { settings.reverse = v; app.saveToolSettings(tool); }, { title: 'Reverse the order of colors in the gradient' });
    const dither = checkbox('Dither', settings.dither, v => { settings.dither = v; app.saveToolSettings(tool); }, { title: 'Dither to reduce banding' });
    const transp = checkbox('Transparency', settings.transparency, v => { settings.transparency = v; app.saveToolSettings(tool); }, { title: 'Use the transparency mask of the gradient' });
    bar.append(picker, separator(), shapes, separator(), label('Mode:'), mode, opacity, separator(), reverse, dither, transp);
    const sync = () => { picker.setValue(settings.gradient); shapes.setValue(settings.shape); mode.setValue(settings.mode); opacity.setValue(settings.opacity); reverse.setValue(settings.reverse); dither.setValue(settings.dither); transp.setValue(settings.transparency); };
    const offs = [events.on('toolOptions', sync), events.on('colors', () => picker.setValue(settings.gradient))];
    return () => offs.forEach(f => f());
  },
  pointerDown(p, doc) {
    if (p.button !== 0) return;
    const t = fillTarget(doc, 'Gradient Tool');
    if (!t) return;
    if (t.kind === 'pixels') (t.layer as RasterLayer).ensureRect({ x: 0, y: 0, w: doc.width, h: doc.height });
    const hr = { x: t.holder.x, y: t.holder.y, w: t.holder.canvas.width, h: t.holder.canvas.height };
    let region = intersectRect({ x: 0, y: 0, w: doc.width, h: doc.height }, hr);
    if (region && !doc.quickMask && !doc.selection.empty) region = intersectRect(region, doc.selection.bounds!);
    if (!region) return;
    drag = { doc, t, p0: { x: p.x, y: p.y }, p1: { x: p.x, y: p.y }, orig: t.holder.canvas, preview: cloneCanvas(t.holder.canvas), region, last: null, raf: 0, moved: false };
  },
  pointerMove(p, doc) {
    const d = drag;
    if (!d) return;
    d.p1 = constrain(d.p0, p);
    if (!d.moved && Math.hypot(d.p1.x - d.p0.x, d.p1.y - d.p0.y) * (app.viewport?.zoom ?? 1) < 2) return;
    d.moved = true;
    if (!d.raf) d.raf = requestAnimationFrame(renderPreview);
    doc.redrawOverlay();
  },
  pointerUp(p) {
    if (!drag) return;
    drag.p1 = constrain(drag.p0, p);
    finish(true);
  },
  keyDown(e) {
    if (e.key === 'Escape' && drag) { finish(false); return true; }
  },
  deactivate() { finish(false); },
  drawOverlay(ctx, view) {
    const d = drag;
    if (!d || !d.moved) return;
    const a = view.docToScreen(d.p0.x, d.p0.y), b = view.docToScreen(d.p1.x, d.p1.y);
    ctx.save();
    ctx.lineCap = 'round';
    ctx.strokeStyle = 'rgba(0,0,0,.6)'; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    for (const [q, fill] of [[a, '#fff'], [b, '#1473e6']] as const) {
      ctx.beginPath(); ctx.arc(q.x, q.y, 4, 0, Math.PI * 2);
      ctx.fillStyle = fill; ctx.fill(); ctx.strokeStyle = '#000'; ctx.stroke();
    }
    ctx.restore();
  },
};
app.registerTool(tool);

