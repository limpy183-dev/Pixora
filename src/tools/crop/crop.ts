// Crop Tool (C) and Perspective Crop Tool (C).
// Crop: the crop box starts on the whole canvas; drag to draw a new box, handles resize (Shift / ratio presets keep
// the aspect ratio, Alt from the centre), drag inside moves, drag outside rotates (Shift: 15°). Options: ratio /
// W×H×Resolution presets, swap, Clear, Straighten (draw a line along the horizon), overlays (Rule of Thirds, Grid,
// Diagonal, Triangle, Golden Ratio, Golden Spiral), Delete Cropped Pixels, Content-Aware (fills the transparent
// corners after rotating or extending beyond the canvas). Enter / double-click commits, Esc cancels.
// Perspective Crop: drag a box, move its four corners onto a skewed rectangle; commit maps it to a rectangle.
import './crop.css';
import { app, type Tool, type ToolPointer } from '../../core/app';
import type { PixDocument } from '../../core/document';
import { RasterLayer, type Layer } from '../../core/layer';
import { createCanvas, ctx2d } from '../../core/canvas';
import type { Point, Rect } from '../../core/types';
import type { Viewport } from '../../core/viewport';
import { h } from '../../ui/dom';
import { checkbox, iconButton, numberField, select, separator, type SelectOption } from '../../ui/widgets';
import { svgCursor } from '../../ui/cursors';
import { toast } from '../../ui/toast';
import { events } from '../../core/events';
import { docChanged } from '../../features/image/ops';
import { maxScaleInside, transformDocument } from './xform';
import { rectToQuad, type Quad } from '../../features/transform/geom';
import { runInpaint, withBusy } from '../retouch/heal-core';

// ================================================================== Crop
type Overlay = 'thirds' | 'grid' | 'diagonal' | 'triangle' | 'golden' | 'spiral';
type Preset = 'ratio' | 'wxh' | 'original' | '1:1' | '4:5' | '5:7' | '2:3' | '16:9';
const cs = {
  preset: 'ratio' as Preset, rw: 0, rh: 0, res: 300, deleteCropped: true, contentAware: false, overlay: 'thirds' as Overlay,
};
interface Box { cx: number; cy: number; w: number; h: number; a: number }       // centre, size, rotation (deg)
interface CropState {
  doc: PixDocument; box: Box; dirty: boolean; straighten: boolean;
  drag: null | { kind: 'new' | 'move' | 'rotate' | 'handle' | 'line'; i?: number; start: Point; box0: Box; p?: Point };
}
let cr: CropState | null = null;
const HUV: [number, number][] = [[-1, -1], [1, -1], [1, 1], [-1, 1], [0, -1], [1, 0], [0, 1], [-1, 0]];

const rad = (d: number) => (d * Math.PI) / 180;
/** Box-local (unit: -1..1 on each axis) → doc point. */
function boxPt(b: Box, u: number, v: number): Point {
  const c = Math.cos(rad(b.a)), s = Math.sin(rad(b.a)), x = (u * b.w) / 2, y = (v * b.h) / 2;
  return { x: b.cx + x * c - y * s, y: b.cy + x * s + y * c };
}
function toLocal(b: Box, p: Point): Point {
  const c = Math.cos(rad(b.a)), s = Math.sin(rad(b.a)), dx = p.x - b.cx, dy = p.y - b.cy;
  return { x: dx * c + dy * s, y: -dx * s + dy * c };
}
const fullBox = (doc: PixDocument): Box => ({ cx: doc.width / 2, cy: doc.height / 2, w: doc.width, h: doc.height, a: 0 });

/** Aspect ratio (w / h) required by the options, or 0. */
function ratio(doc: PixDocument): number {
  switch (cs.preset) {
    case 'original': return doc.width / doc.height;
    case '1:1': return 1;
    case '4:5': return cs.rw >= cs.rh ? 5 / 4 : 4 / 5;
    case '5:7': return cs.rw >= cs.rh ? 7 / 5 : 5 / 7;
    case '2:3': return cs.rw >= cs.rh ? 3 / 2 : 2 / 3;
    case '16:9': return cs.rw >= cs.rh && !(cs.rw === 9 && cs.rh === 16) ? 16 / 9 : 9 / 16;
    default: return cs.rw > 0 && cs.rh > 0 ? cs.rw / cs.rh : 0;
  }
}

function ensure(doc: PixDocument): CropState {
  if (!cr || cr.doc !== doc) cr = { doc, box: fullBox(doc), dirty: false, straighten: false, drag: null };
  return cr;
}

async function commitCrop() {
  const s = cr;
  if (!s) return;
  const doc = s.doc, b = s.box;
  cr = null;
  if (!s.dirty) { doc.redrawOverlay(); return; }
  let W = Math.max(1, Math.round(b.w)), H = Math.max(1, Math.round(b.h));
  if (cs.preset === 'wxh' && cs.rw > 0 && cs.rh > 0) { W = Math.round(cs.rw); H = Math.round(cs.rh); }
  const m = new DOMMatrix().scale(W / b.w, H / b.h).translate(b.w / 2, b.h / 2).rotate(-b.a).translate(-b.cx, -b.cy);
  // uncovered canvas (rotation / box beyond the image) for Content-Aware
  const cover = createCanvas(W, H), cx = ctx2d(cover);
  cx.setTransform(m); cx.fillRect(0, 0, doc.width, doc.height);
  const cd = cx.getImageData(0, 0, W, H).data;
  let holes = 0;
  const hole = new Uint8Array(W * H);
  for (let i = 0, j = 3; i < hole.length; i++, j += 4) if (cd[j] < 250) { hole[i] = 1; holes++; }
  const bg = doc.layers.find(l => l.isBackground) as RasterLayer | undefined;
  doc.history.transaction('Crop', () => {
    transformDocument(doc, m, { width: W, height: H, deleteOutside: cs.deleteCropped, backgroundFill: app.bg, resolution: cs.preset === 'wxh' ? cs.res : undefined });
  });
  docChanged(doc);
  if (cs.contentAware && holes && bg) {
    toast('Content-Aware: filling the uncovered areas…', 'info', 1600);
    const d = ctx2d(bg.canvas).getImageData(0, 0, W, H).data;
    // grow the hole a little so the anti-aliased edge is rebuilt too
    const grown = hole.slice();
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (hole[y * W + x]) for (let k = -2; k <= 2; k++) { const xx = x + k, yy = y + k; if (xx >= 0 && xx < W) grown[y * W + xx] = 1; if (yy >= 0 && yy < H) grown[yy * W + x] = 1; }
    const res = await withBusy(() => runInpaint(new Uint8ClampedArray(d), W, H, grown));
    if (doc.layers.includes(bg) && bg.canvas.width === W) {
      const edit = doc.history.beginPixelEdit(bg, 'Content-Aware Fill');
      ctx2d(bg.canvas).putImageData(new ImageData(new Uint8ClampedArray(res), W, H), 0, 0);
      if (edit.commit('Content-Aware Fill', { x: 0, y: 0, w: W, h: H })) doc.pixelsChanged(bg, null);
    }
  }
}
function cancelCrop() { const d = cr?.doc; cr = null; d?.redrawOverlay(); }

/** Straighten: rotate so the drawn line becomes horizontal (or vertical) and fit the largest box inside. */
function straightenTo(s: CropState, a: Point, b: Point) {
  let ang = (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI;
  if (ang > 90) ang -= 180; if (ang < -90) ang += 180;
  if (ang > 45) ang -= 90; else if (ang < -45) ang += 90;
  const doc = s.doc, box: Box = { cx: doc.width / 2, cy: doc.height / 2, w: doc.width, h: doc.height, a: ang };
  if (!cs.contentAware) {
    // image corners in the box frame
    const q = [[0, 0], [doc.width, 0], [doc.width, doc.height], [0, doc.height]].map(([x, y]) => { const l = toLocal(box, { x, y }); return { x: l.x, y: l.y }; });
    const k = maxScaleInside({ x: 0, y: 0 }, doc.width / 2, doc.height / 2, q, 1);
    box.w = doc.width * k; box.h = doc.height * k;
  }
  s.box = box; s.dirty = true;
}

function hitCrop(s: CropState, view: Viewport, p: ToolPointer): { kind: 'handle' | 'move' | 'rotate'; i?: number } {
  for (let i = 0; i < 8; i++) { const q = boxPt(s.box, HUV[i][0], HUV[i][1]), sc = view.docToScreen(q.x, q.y); if (Math.hypot(sc.x - p.sx, sc.y - p.sy) <= 8) return { kind: 'handle', i }; }
  const l = toLocal(s.box, p);
  if (Math.abs(l.x) <= s.box.w / 2 && Math.abs(l.y) <= s.box.h / 2) return { kind: 'move' };
  return { kind: 'rotate' };
}
const ROT = svgCursor('<path d="M5 13a7 7 0 0 1 12-5"/><path d="M17 3v5h-5"/><path d="M19 11a7 7 0 0 1-12 5"/><path d="M7 21v-5h5"/>', 12, 12, 'crosshair');
const CROP_CURSOR = svgCursor('<path d="M6 2v16h16"/><path d="M2 6h16v16"/>', 6, 6, 'crosshair');
const LEVEL_CURSOR = svgCursor('<path d="M3 17h18"/><path d="M6 13h12v4H6z"/><circle cx="12" cy="15" r="1"/>', 12, 17, 'crosshair');

function drawOverlayGuides(ctx: CanvasRenderingContext2D, pts: (u: number, v: number) => Point) {
  const line = (u0: number, v0: number, u1: number, v1: number) => { const a = pts(u0, v0), b = pts(u1, v1); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); };
  ctx.beginPath();
  switch (cs.overlay) {
    case 'thirds': for (const t of [-1 / 3, 1 / 3]) { line(t, -1, t, 1); line(-1, t, 1, t); } break;
    case 'grid': for (let k = 1; k < 8; k++) { const t = -1 + k / 4; line(t, -1, t, 1); line(-1, t, 1, t); } break;
    case 'diagonal': line(-1, -1, 1, 1); line(1, -1, -1, 1); break;
    case 'triangle': line(-1, -1, 1, 1); line(1, -1, 0, 0); line(-1, 1, 0, 0); break;
    case 'golden': { const g = 1 - 2 / 1.618; for (const t of [-g, g]) { line(t, -1, t, 1); line(-1, t, 1, t); } break; }
    case 'spiral': {
      // golden spiral approximation made of quarter arcs
      let x0 = -1, y0 = -1, w = 2, hh = 2;
      for (let k = 0; k < 7; k++) {
        const sq = Math.min(w, hh), dir = k % 4;
        const [cxu, cyu, a0] = dir === 0 ? [x0 + sq, y0 + sq, Math.PI] : dir === 1 ? [x0 + w - sq, y0 + sq, -Math.PI / 2] : dir === 2 ? [x0 + w - sq, y0 + hh - sq, 0] : [x0 + sq, y0 + hh - sq, Math.PI / 2];
        for (let t = 0; t <= 12; t++) { const ang = a0 + (t / 12) * (Math.PI / 2), p = pts(cxu + Math.cos(ang) * sq, cyu + Math.sin(ang) * sq); if (t) ctx.lineTo(p.x, p.y); else ctx.moveTo(p.x, p.y); }
        if (dir === 0) { x0 += sq; w -= sq; } else if (dir === 1) { y0 += sq; hh -= sq; } else if (dir === 2) { w -= sq; } else { hh -= sq; }
      }
      break;
    }
  }
  ctx.stroke();
}

const cropTool: Tool = {
  id: 'crop', name: 'Crop Tool', group: 'crop', icon: 'crop', shortcut: 'C', order: 0, settings: cs,
  cursor: () => {
    const s = cr, v = app.viewport;
    if (!s || !v) return CROP_CURSOR;
    if (s.straighten) return LEVEL_CURSOR;
    const p = v.pointer as any as ToolPointer;
    if (s.drag) return s.drag.kind === 'rotate' ? ROT : s.drag.kind === 'move' ? 'move' : 'crosshair';
    const r = hitCrop(s, v, p);
    if (r.kind === 'handle') { const i = r.i!; return i === 0 || i === 2 ? 'nwse-resize' : i === 1 || i === 3 ? 'nesw-resize' : i === 4 || i === 6 ? 'ns-resize' : 'ew-resize'; }
    return r.kind === 'move' ? (s.dirty ? 'move' : CROP_CURSOR) : ROT;
  },
  activate() { const d = app.activeDoc; if (d) { ensure(d); d.redrawOverlay(); } },
  deactivate() { if (cr?.dirty) void commitCrop(); else cr = null; },
  isModal: () => !!cr?.dirty,
  commit: () => void commitCrop(),
  cancel: cancelCrop,
  options(bar) {
    const save = () => app.saveToolSettings(cropTool);
    const presets: (SelectOption<Preset> | '-')[] = [
      { value: 'ratio', label: 'Ratio' }, { value: 'wxh', label: 'W x H x Resolution' }, { value: 'original', label: 'Original Ratio' }, '-',
      { value: '1:1', label: '1 : 1 (Square)' }, { value: '4:5', label: '4 : 5 (8 : 10)' }, { value: '5:7', label: '5 : 7' }, { value: '2:3', label: '2 : 3 (4 : 6)' }, { value: '16:9', label: '16 : 9' },
    ];
    const fitRatio = () => {
      const d = app.activeDoc, r = d ? ratio(d) : 0;
      if (!d || !r) return;
      const s = ensure(d), b = s.box;
      // shrink the box to the ratio, keeping its centre
      if (b.w / b.h > r) b.w = b.h * r; else b.h = b.w / r;
      s.dirty = true; d.redrawOverlay();
    };
    const pre = select<Preset>(presets, cs.preset, v => {
      cs.preset = v;
      if (v === 'original') { const d = app.activeDoc; if (d) { cs.rw = d.width; cs.rh = d.height; } }
      else if (v.includes(':')) { const [a, b] = v.split(':').map(Number); cs.rw = a; cs.rh = b; }
      else if (v === 'ratio') { cs.rw = 0; cs.rh = 0; }
      wF.setValue(cs.rw || NaN); hF.setValue(cs.rh || NaN); resF.style.display = v === 'wxh' ? '' : 'none';
      save(); fitRatio();
    }, { width: 150, title: 'Choose a preset aspect ratio or crop size' });
    const unit = () => (cs.preset === 'wxh' ? 'px' : '');
    const wF = numberField(cs.rw || NaN, v => { cs.rw = v; save(); fitRatio(); }, { min: 0, max: 300000, decimals: 2, width: 64, unit: unit(), title: 'Width' });
    const hF = numberField(cs.rh || NaN, v => { cs.rh = v; save(); fitRatio(); }, { min: 0, max: 300000, decimals: 2, width: 64, unit: unit(), title: 'Height' });
    const swap = iconButton('swap-colors', 'Swap the height and width', () => { [cs.rw, cs.rh] = [cs.rh, cs.rw]; wF.setValue(cs.rw || NaN); hF.setValue(cs.rh || NaN); save(); const d = app.activeDoc; if (d && cr) { const b = cr.box; [b.w, b.h] = [b.h, b.w]; cr.dirty = true; d.redrawOverlay(); } });
    const resF = numberField(cs.res, v => { cs.res = v; save(); }, { min: 1, max: 29999, decimals: 2, width: 60, label: 'Res:', title: 'Resolution (px/in)' });
    resF.style.display = cs.preset === 'wxh' ? '' : 'none';
    const clearB = h('button.btn.cr-btn', { type: 'button', title: 'Clear the ratio values' }, 'Clear');
    clearB.addEventListener('click', () => { cs.preset = 'ratio'; cs.rw = cs.rh = 0; pre.setValue('ratio'); wF.setValue(NaN); hF.setValue(NaN); save(); });
    const straightenB = iconButton('ruler', 'Straighten the image by drawing a line on it', () => { const d = app.activeDoc; if (!d) return; const s = ensure(d); s.straighten = !s.straighten; straightenB.classList.toggle('active', s.straighten); });
    const ov = select<Overlay>([
      { value: 'thirds', label: 'Rule of Thirds' }, { value: 'grid', label: 'Grid' }, { value: 'diagonal', label: 'Diagonal' }, { value: 'triangle', label: 'Triangle' }, { value: 'golden', label: 'Golden Ratio' }, { value: 'spiral', label: 'Golden Spiral' },
    ], cs.overlay, v => { cs.overlay = v; save(); app.activeDoc?.redrawOverlay(); }, { width: 130, title: 'Set the overlay options for the Crop Tool' });
    const del = checkbox('Delete Cropped Pixels', cs.deleteCropped, v => { cs.deleteCropped = v; save(); }, { title: 'Discard the pixels outside the crop (off: keep them outside the canvas)' });
    const ca = checkbox('Content-Aware', cs.contentAware, v => { cs.contentAware = v; save(); }, { title: 'Fill the transparent areas left by rotating or extending the canvas with content-aware detail' });
    bar.append(pre, wF, swap, hF, resF, clearB, separator(), straightenB, separator(), h('span.opt-label', null, 'Overlay:'), ov, separator(), del, ca,
      h('span.cr-flex'),
      iconButton('reset', 'Reset the crop box, rotation and aspect ratio', () => { const d = app.activeDoc; if (d) { cr = { doc: d, box: fullBox(d), dirty: false, straighten: false, drag: null }; d.redrawOverlay(); } }),
      iconButton('cancel', 'Cancel current crop operation (Esc)', cancelCrop),
      iconButton('commit', 'Commit current crop operation (Enter)', () => void commitCrop()));
  },
  pointerDown(p, doc) {
    const s = ensure(doc), v = app.viewport!;
    if (s.straighten) { s.drag = { kind: 'line', start: { x: p.x, y: p.y }, box0: { ...s.box }, p: { x: p.x, y: p.y } }; return; }
    const r = hitCrop(s, v, p);
    const base = { start: { x: p.x, y: p.y }, box0: { ...s.box } };
    if (r.kind === 'handle') s.drag = { kind: 'handle', i: r.i, ...base };
    else if (r.kind === 'move') s.drag = { kind: s.dirty ? 'move' : 'new', ...base };
    else s.drag = { kind: p.ctrl ? 'new' : 'rotate', ...base };
  },
  pointerMove(p, doc) {
    const s = cr;
    if (!s?.drag) return;
    const d = s.drag, b0 = d.box0;
    const r = ratio(doc);
    if (d.kind === 'line') { d.p = { x: p.x, y: p.y }; doc.redrawOverlay(); return; }
    if (d.kind === 'new') {
      let w = p.x - d.start.x, hh = p.y - d.start.y;
      const k = r || (p.shift ? 1 : 0);
      if (k) { const a = Math.max(Math.abs(w), Math.abs(hh) * k); w = Math.sign(w || 1) * a; hh = Math.sign(hh || 1) * a / k; }
      if (Math.abs(w) < 2 && Math.abs(hh) < 2) return;
      s.box = p.alt ? { cx: d.start.x, cy: d.start.y, w: Math.abs(w) * 2, h: Math.abs(hh) * 2, a: 0 } : { cx: d.start.x + w / 2, cy: d.start.y + hh / 2, w: Math.abs(w), h: Math.abs(hh), a: 0 };
    } else if (d.kind === 'move') {
      let dx = p.x - d.start.x, dy = p.y - d.start.y;
      if (p.shift) { if (Math.abs(dx) > Math.abs(dy)) dy = 0; else dx = 0; }
      s.box = { ...b0, cx: b0.cx + dx, cy: b0.cy + dy };
    } else if (d.kind === 'rotate') {
      let a = (Math.atan2(p.y - b0.cy, p.x - b0.cx) - Math.atan2(d.start.y - b0.cy, d.start.x - b0.cx)) * 180 / Math.PI;
      if (p.shift) a = Math.round((b0.a + a) / 15) * 15 - b0.a;
      s.box = { ...b0, a: b0.a + a };
    } else if (d.kind === 'handle') {
      const [hu, hv] = HUV[d.i!];
      const l = toLocal(b0, p);
      // opposite edge stays (Alt: centre stays)
      let x0 = -b0.w / 2, x1 = b0.w / 2, y0 = -b0.h / 2, y1 = b0.h / 2;
      if (hu < 0) x0 = Math.min(l.x, x1 - 1); if (hu > 0) x1 = Math.max(l.x, x0 + 1);
      if (hv < 0) y0 = Math.min(l.y, y1 - 1); if (hv > 0) y1 = Math.max(l.y, y0 + 1);
      if (p.alt) { if (hu) { const e = Math.max(Math.abs(l.x), 1); x0 = -e; x1 = e; } if (hv) { const e = Math.max(Math.abs(l.y), 1); y0 = -e; y1 = e; } }
      let w = x1 - x0, hh = y1 - y0;
      const k = r || (p.shift && hu && hv ? b0.w / b0.h : 0);
      if (k) {
        if (hu && hv) { if (w / hh > k) hh = w / k; else w = hh * k; }
        else if (hu) hh = w / k; else w = hh * k;
        if (hu < 0) x0 = x1 - w; else if (hu > 0) x1 = x0 + w; else { const c = (x0 + x1) / 2; x0 = c - w / 2; x1 = c + w / 2; }
        if (hv < 0) y0 = y1 - hh; else if (hv > 0) y1 = y0 + hh; else { const c = (y0 + y1) / 2; y0 = c - hh / 2; y1 = c + hh / 2; }
        if (p.alt) { x0 = -w / 2; x1 = w / 2; y0 = -hh / 2; y1 = hh / 2; }
      }
      const c = boxPt(b0, ((x0 + x1) / 2) / (b0.w / 2), ((y0 + y1) / 2) / (b0.h / 2));
      s.box = { cx: c.x, cy: c.y, w: x1 - x0, h: y1 - y0, a: b0.a };
    }
    s.dirty = true;
    doc.redrawOverlay();
  },
  pointerUp(_p, doc) {
    const s = cr;
    if (!s?.drag) return;
    const d = s.drag;
    s.drag = null;
    if (d.kind === 'line' && d.p && Math.hypot(d.p.x - d.start.x, d.p.y - d.start.y) > 4) {
      straightenTo(s, d.start, d.p);
      s.straighten = false;
      document.querySelector('.optionsbar .active[title^="Straighten"]')?.classList.remove('active');
    }
    doc.redrawOverlay();
  },
  dblclick(p, doc) { const s = cr; if (s && hitCrop(s, app.viewport!, p).kind === 'move') void commitCrop(); void doc; },
  keyDown(e) {
    const s = cr;
    if (!s) return false;
    const map: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    const v = map[e.key];
    if (v && s.dirty) { const k = e.shiftKey ? 10 : 1; s.box = { ...s.box, cx: s.box.cx + v[0] * k, cy: s.box.cy + v[1] * k }; s.doc.redrawOverlay(); return true; }
    return false;
  },
  drawOverlay(ctx, view, doc) {
    const s = ensure(doc);
    const b = s.box;
    const corners = [boxPt(b, -1, -1), boxPt(b, 1, -1), boxPt(b, 1, 1), boxPt(b, -1, 1)].map(p => view.docToScreen(p.x, p.y));
    ctx.save();
    // shield outside the crop box
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.beginPath();
    ctx.rect(0, 0, view.width, view.height);
    ctx.moveTo(corners[0].x, corners[0].y); for (let i = 3; i >= 0; i--) ctx.lineTo(corners[i].x, corners[i].y); ctx.closePath();
    ctx.fill('evenodd');
    // overlay guides
    ctx.strokeStyle = 'rgba(255,255,255,.55)'; ctx.lineWidth = 1;
    const scr = (u: number, v: number) => { const p = boxPt(b, u, v); return view.docToScreen(p.x, p.y); };
    if (s.dirty || s.drag) drawOverlayGuides(ctx, scr);
    // box + handles
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 1;
    ctx.beginPath(); corners.forEach((c, i) => (i ? ctx.lineTo(c.x, c.y) : ctx.moveTo(c.x, c.y))); ctx.closePath(); ctx.stroke();
    ctx.lineWidth = 3; ctx.strokeStyle = '#fff';
    const L = 14;
    for (let i = 0; i < 4; i++) {
      const c = corners[i], n1 = corners[(i + 1) % 4], n2 = corners[(i + 3) % 4];
      const e = (t: Point) => { const dx = t.x - c.x, dy = t.y - c.y, l = Math.hypot(dx, dy) || 1, k = Math.min(L, l / 3); return { x: c.x + (dx / l) * k, y: c.y + (dy / l) * k }; };
      const a = e(n1), bb = e(n2);
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(c.x, c.y); ctx.lineTo(bb.x, bb.y); ctx.stroke();
    }
    for (let i = 4; i < 8; i++) { const [u, v] = HUV[i], c = scr(u, v); ctx.beginPath(); if (u) { ctx.moveTo(c.x, c.y - 7); ctx.lineTo(c.x, c.y + 7); } else { ctx.moveTo(c.x - 7, c.y); ctx.lineTo(c.x + 7, c.y); } ctx.stroke(); }
    // straighten line
    if (s.drag?.kind === 'line' && s.drag.p) {
      const a = view.docToScreen(s.drag.start.x, s.drag.start.y), e = view.docToScreen(s.drag.p.x, s.drag.p.y);
      ctx.lineWidth = 1; ctx.strokeStyle = '#1e8bff'; ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(e.x, e.y); ctx.stroke();
    }
    // size / angle HUD
    if (s.drag && s.drag.kind !== 'line') {
      const txt = s.drag.kind === 'rotate' ? `${b.a.toFixed(1)}°` : `W: ${Math.round(b.w)} px  H: ${Math.round(b.h)} px`;
      const p = view.pointer;
      ctx.font = '600 11px Segoe UI, system-ui, sans-serif';
      const w = ctx.measureText(txt).width + 16;
      ctx.fillStyle = 'rgba(38,38,38,.93)'; ctx.beginPath(); ctx.roundRect(p.sx + 16, p.sy + 16, w, 22, 4); ctx.fill();
      ctx.fillStyle = '#f0f0f0'; ctx.fillText(txt, p.sx + 24, p.sy + 31);
    }
    ctx.restore();
  },
};
app.registerTool(cropTool);
events.on('activeDoc', () => { if (cr && cr.doc !== app.activeDoc) cr = null; });
events.on('docSize', d => { if (cr?.doc === d && !cr.dirty) cr = null; });

// ================================================================== Perspective Crop
let pc: { doc: PixDocument; q: Quad | null; drag: null | { i: number; start: Point; q0: Quad } | { draw: Point } } | null = null;
const pcs = { showGrid: true };

/** Render `src` (at doc position) so that source quad q maps onto a W×H rectangle. */
function pullQuad(src: HTMLCanvasElement, sx: number, sy: number, q: Quad, W: number, H: number): HTMLCanvasElement {
  const out = createCanvas(W, H), x = ctx2d(out);
  x.imageSmoothingEnabled = true; x.imageSmoothingQuality = 'high';
  const f = rectToQuad({ x: 0, y: 0, w: W, h: H }, q);
  const n = Math.max(16, Math.min(48, Math.round(Math.max(W, H) / 24)));
  const S = (i: number, j: number) => f({ x: (W * i) / n, y: (H * j) / n });
  const Dp = (i: number, j: number) => ({ x: (W * i) / n, y: (H * j) / n });
  const tri = (s0: Point, s1: Point, s2: Point, d0: Point, d1: Point, d2: Point) => {
    const den = (s1.x - s0.x) * (s2.y - s0.y) - (s2.x - s0.x) * (s1.y - s0.y);
    if (Math.abs(den) < 1e-12) return;
    const a = ((d1.x - d0.x) * (s2.y - s0.y) - (d2.x - d0.x) * (s1.y - s0.y)) / den;
    const c = ((d2.x - d0.x) * (s1.x - s0.x) - (d1.x - d0.x) * (s2.x - s0.x)) / den;
    const b = ((d1.y - d0.y) * (s2.y - s0.y) - (d2.y - d0.y) * (s1.y - s0.y)) / den;
    const d = ((d2.y - d0.y) * (s1.x - s0.x) - (d1.y - d0.y) * (s2.x - s0.x)) / den;
    const cx = (d0.x + d1.x + d2.x) / 3, cy = (d0.y + d1.y + d2.y) / 3;
    const g = (p: Point) => { const dx = p.x - cx, dy = p.y - cy, l = Math.hypot(dx, dy) || 1; return { x: p.x + (dx / l) * 0.9, y: p.y + (dy / l) * 0.9 }; };
    const g0 = g(d0), g1 = g(d1), g2 = g(d2);
    x.save();
    x.beginPath(); x.moveTo(g0.x, g0.y); x.lineTo(g1.x, g1.y); x.lineTo(g2.x, g2.y); x.closePath(); x.clip();
    x.setTransform(a, b, c, d, d0.x - a * s0.x - c * s0.y, d0.y - b * s0.x - d * s0.y);
    x.drawImage(src, sx, sy);
    x.restore();
  };
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    tri(S(i, j), S(i + 1, j), S(i + 1, j + 1), Dp(i, j), Dp(i + 1, j), Dp(i + 1, j + 1));
    tri(S(i, j), S(i + 1, j + 1), S(i, j + 1), Dp(i, j), Dp(i + 1, j + 1), Dp(i, j + 1));
  }
  return out;
}
function commitPerspective() {
  const s = pc;
  if (!s?.q) return;
  pc = null;
  const doc = s.doc, q = s.q;
  const d = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);
  const W = Math.max(1, Math.round((d(q[0], q[1]) + d(q[3], q[2])) / 2)), H = Math.max(1, Math.round((d(q[0], q[3]) + d(q[1], q[2])) / 2));
  doc.history.transaction('Perspective Crop', () => {
    const conv = (l: Layer): Layer => {
      if (l.kind === 'group') { (l as any).children = (l as any).children.map(conv); return l; }
      if (l.kind === 'adjustment') return l;
      const c = l.getContent(doc);
      const r = new RasterLayer(W, H, l.name);
      Object.assign(r, { id: l.id, visible: l.visible, opacity: l.opacity, fillOpacity: l.fillOpacity, blendMode: l.blendMode, locks: l.locks, clipped: l.clipped, effects: l.effects, colorLabel: l.colorLabel, isBackground: l.isBackground });
      if (c) r.canvas = pullQuad(c.canvas, c.x, c.y, q, W, H);
      if (l.mask) r.mask = { ...l.mask, canvas: pullQuad(l.mask.canvas, l.mask.x, l.mask.y, q, W, H), x: 0, y: 0 };
      r.x = 0; r.y = 0;
      return r;
    };
    doc.layers = doc.layers.map(conv);
    doc.relink();
    doc.selection.setMask(null);
    doc.setSize(W, H);
  });
  docChanged(doc);
}
const persp: Tool = {
  id: 'crop-perspective', name: 'Perspective Crop Tool', group: 'crop', icon: 'crop-perspective', shortcut: 'C', order: 1, settings: pcs,
  cursor: () => (pc?.drag && 'i' in pc.drag ? 'crosshair' : CROP_CURSOR),
  isModal: () => !!pc?.q,
  commit: commitPerspective,
  cancel: () => { const d = pc?.doc; pc = null; d?.redrawOverlay(); },
  deactivate() { pc = null; },
  options(bar) {
    bar.append(checkbox('Show Grid', pcs.showGrid, v => { pcs.showGrid = v; app.saveToolSettings(persp); app.activeDoc?.redrawOverlay(); }, { title: 'Show a grid inside the crop quad' }),
      h('span.cr-flex'),
      iconButton('cancel', 'Cancel (Esc)', () => persp.cancel!()), iconButton('commit', 'Commit (Enter)', commitPerspective));
  },
  pointerDown(p, doc) {
    if (!pc || pc.doc !== doc) pc = { doc, q: null, drag: null };
    const v = app.viewport!;
    if (pc.q) {
      for (let i = 0; i < 4; i++) { const sc = v.docToScreen(pc.q[i].x, pc.q[i].y); if (Math.hypot(sc.x - p.sx, sc.y - p.sy) <= 9) { pc.drag = { i, start: { x: p.x, y: p.y }, q0: pc.q.map(c => ({ ...c })) as Quad }; return; } }
      // inside: move the quad
      pc.drag = { i: -1, start: { x: p.x, y: p.y }, q0: pc.q.map(c => ({ ...c })) as Quad };
      return;
    }
    pc.drag = { draw: { x: p.x, y: p.y } };
  },
  pointerMove(p, doc) {
    const s = pc;
    if (!s?.drag) return;
    if ('draw' in s.drag) { const a = s.drag.draw; s.q = [{ x: a.x, y: a.y }, { x: p.x, y: a.y }, { x: p.x, y: p.y }, { x: a.x, y: p.y }]; }
    else { const d = s.drag, dx = p.x - d.start.x, dy = p.y - d.start.y; s.q = d.q0.map((c, k) => (d.i < 0 || k === d.i ? { x: c.x + dx, y: c.y + dy } : c)) as Quad; }
    doc.redrawOverlay();
  },
  pointerUp(_p, doc) {
    const s = pc;
    if (!s) return;
    if (s.drag && 'draw' in s.drag && s.q && Math.abs(s.q[2].x - s.q[0].x) < 3) s.q = null;
    s.drag = null;
    doc.redrawOverlay();
  },
  dblclick() { if (pc?.q) commitPerspective(); },
  drawOverlay(ctx, view) {
    const s = pc;
    if (!s?.q) return;
    const c = s.q.map(p => view.docToScreen(p.x, p.y));
    ctx.save();
    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    ctx.beginPath(); ctx.rect(0, 0, view.width, view.height);
    ctx.moveTo(c[0].x, c[0].y); for (let i = 3; i >= 0; i--) ctx.lineTo(c[i].x, c[i].y); ctx.closePath(); ctx.fill('evenodd');
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 1;
    ctx.beginPath(); c.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y))); ctx.closePath(); ctx.stroke();
    if (pcs.showGrid) {
      const f = rectToQuad({ x: 0, y: 0, w: 1, h: 1 }, s.q);
      ctx.strokeStyle = 'rgba(255,255,255,.5)';
      ctx.beginPath();
      for (let k = 1; k < 8; k++) {
        const t = k / 8;
        const a = f({ x: t, y: 0 }), b = f({ x: t, y: 1 }), l = f({ x: 0, y: t }), r = f({ x: 1, y: t });
        for (const [p0, p1] of [[a, b], [l, r]]) { const s0 = view.docToScreen(p0.x, p0.y), s1 = view.docToScreen(p1.x, p1.y); ctx.moveTo(s0.x, s0.y); ctx.lineTo(s1.x, s1.y); }
      }
      ctx.stroke();
    }
    for (const p of c) { ctx.fillStyle = '#fff'; ctx.fillRect(p.x - 4, p.y - 4, 8, 8); ctx.strokeStyle = '#1e8bff'; ctx.strokeRect(p.x - 4, p.y - 4, 8, 8); }
    ctx.restore();
  },
};
app.registerTool(persp);
