// Filter menu definitions: Blur, Blur Gallery, Distort, Noise.
import { app } from '../core/app';
import type { PixDocument } from '../core/document';
import { resources } from '../core/registry';
import { parseSvgPath, toPath2D, type SubPath, type VectorPath } from '../core/path';
import { createCanvas, ctx2d } from '../core/canvas';
import { h, dragPointer } from '../ui/dom';
import { toast } from '../ui/toast';
import { getPathSel } from '../tools/vector/common';
import { pickFiles } from '../features/file/io';
import { flatCanvasOf } from '../features/file/commands';
import { defineFilter, ui, type FilterCtx } from './engine';
import { curveAt } from './kernels/distort';

// ------------------------------------------------------------------ shared prepare helpers
/** Selection mask alpha in paint-target coordinates. */
export function selMaskFor(doc: PixDocument): Uint8Array | null {
  const t = doc.getPaintTarget(), sel = doc.selection.mask;
  if (!t || !sel || doc.selection.empty) return null;
  const c = t.holder.canvas, tmp = createCanvas(c.width, c.height), x = tmp.getContext('2d', { willReadFrequently: true })!;
  x.drawImage(sel, -t.holder.x, -t.holder.y);
  const d = x.getImageData(0, 0, c.width, c.height).data, out = new Uint8Array(c.width * c.height);
  for (let i = 0; i < out.length; i++) out[i] = d[i * 4 + 3];
  return out;
}
/** The selected path in the Paths panel, else the Work Path. */
export function activePath(doc: PixDocument): VectorPath | null {
  const id = getPathSel(doc);
  return (doc.paths.find((p: VectorPath) => p.id === id) as VectorPath) || (doc.paths.find((p: VectorPath) => p.kind === 'work') as VectorPath) || null;
}
/** Flatten sub-paths to polylines (doc coords). */
export function polylines(subs: SubPath[], step = 4): number[][][] {
  const out: number[][][] = [];
  for (const sp of subs) {
    const pts = sp.points, n = pts.length;
    if (n < 2) continue;
    const pl: number[][] = [[pts[0].x, pts[0].y]];
    const segs = sp.closed ? n : n - 1;
    for (let i = 0; i < segs; i++) {
      const a = pts[i], b = pts[(i + 1) % n];
      const L = Math.hypot(b.x - a.x, b.y - a.y) + Math.hypot(a.ox - a.x, a.oy - a.y) + Math.hypot(b.ix - b.x, b.iy - b.y);
      const k = Math.max(1, Math.ceil(L / step));
      for (let j = 1; j <= k; j++) {
        const t = j / k, u = 1 - t;
        pl.push([u * u * u * a.x + 3 * u * u * t * a.ox + 3 * u * t * t * b.ix + t * t * t * b.x, u * u * u * a.y + 3 * u * u * t * a.oy + 3 * u * t * t * b.iy + t * t * t * b.y]);
      }
    }
    out.push(pl);
  }
  return out;
}
export function pathSegments(doc: PixDocument): number[][] {
  const p = activePath(doc);
  if (!p) return [];
  const segs: number[][] = [];
  for (const pl of polylines(p.subpaths, 12)) for (let i = 0; i < pl.length - 1; i++) segs.push([pl[i][0], pl[i][1], pl[i + 1][0], pl[i + 1][1]]);
  return segs;
}
const hint = (t: string) => h('div.flt-hint', null, t);

// ================================================================== Blur
defineFilter({ id: 'average', label: 'Average', category: 'Blur', dialog: false, defaults: () => ({}), prepare: doc => ({ selMask: selMaskFor(doc) }) });
defineFilter({ id: 'blur', label: 'Blur', category: 'Blur', dialog: false, defaults: () => ({}) });
defineFilter({ id: 'blur-more', label: 'Blur More', category: 'Blur', dialog: false, defaults: () => ({}) });
defineFilter({
  id: 'box-blur', label: 'Box Blur', category: 'Blur', defaults: () => ({ radius: 10 }),
  ui: (b, p, u) => b.append(ui.slider('Radius:', p, 'radius', 1, 2000, u, { unit: 'Pixels', decimals: 0 })),
});
defineFilter({
  id: 'gaussian-blur', label: 'Gaussian Blur', category: 'Blur', defaults: () => ({ radius: 5 }),
  ui: (b, p, u) => b.append(ui.slider('Radius:', p, 'radius', 0.1, 1000, u, { unit: 'Pixels', decimals: 1, step: 0.1 })),
});
defineFilter({
  id: 'lens-blur', label: 'Lens Blur', category: 'Blur', width: 680,
  defaults: () => ({ radius: 15, shape: 'hexagon', curvature: 0, rotation: 0, brightness: 0, threshold: 255, noise: 0, dist: 'uniform', mono: false, depth: 'none', focal: 0, invert: false }),
  prepare(doc, p) {
    if (p.depth === 'none') return {};
    const t = doc.getPaintTarget();
    if (!t) return {};
    const c = t.holder.canvas, out = new Uint8Array(c.width * c.height);
    const x = createCanvas(c.width, c.height).getContext('2d', { willReadFrequently: true })!;
    if (p.depth === 'mask' && t.layer?.mask) x.drawImage(t.layer.mask.canvas, t.layer.mask.x - t.holder.x, t.layer.mask.y - t.holder.y);
    else x.drawImage(c, 0, 0);
    const d = x.getImageData(0, 0, c.width, c.height).data;
    for (let i = 0; i < out.length; i++) out[i] = d[i * 4 + 3];
    return { depth: out };
  },
  ui(b, p, u, ctx) {
    const depthRow = ui.select('Depth Map:', p, 'depth', [{ value: 'none', label: 'None' }, { value: 'transparency', label: 'Transparency' }, { value: 'mask', label: 'Layer Mask' }], () => { void prepDepth(ctx, p).then(() => u()); });
    b.append(depthRow, ui.slider('Blur Focal Distance:', p, 'focal', 0, 255, u), ui.check('Invert', p, 'invert', u),
      ui.select('Iris Shape:', p, 'shape', ['triangle', 'square', 'pentagon', 'hexagon', 'heptagon', 'octagon'].map(s => ({ value: s, label: `${s[0].toUpperCase()}${s.slice(1)} (${({ triangle: 3, square: 4, pentagon: 5, hexagon: 6, heptagon: 7, octagon: 8 } as any)[s]})` })), u),
      ui.slider('Radius:', p, 'radius', 0, 100, u), ui.slider('Blade Curvature:', p, 'curvature', 0, 100, u), ui.slider('Rotation:', p, 'rotation', 0, 360, u, { unit: '°' }),
      ui.slider('Specular Brightness:', p, 'brightness', 0, 100, u), ui.slider('Threshold:', p, 'threshold', 0, 255, u),
      ui.slider('Noise Amount:', p, 'noise', 0, 100, u), ui.radios('Distribution', p, 'dist', [['uniform', 'Uniform'], ['gaussian', 'Gaussian']], u), ui.check('Monochromatic', p, 'mono', u));
  },
});
async function prepDepth(ctx: FilterCtx, p: any) {
  const doc = ctx.doc;
  if (p.depth === 'none') { ctx.aux = {}; return; }
  const t = doc.getPaintTarget();
  if (!t) return;
  if (p.depth === 'mask' && !t.layer?.mask) { toast('The layer has no layer mask; using transparency.', 'info'); }
  const c = t.holder.canvas, out = new Uint8Array(c.width * c.height);
  const x = createCanvas(c.width, c.height).getContext('2d', { willReadFrequently: true })!;
  if (p.depth === 'mask' && t.layer?.mask) x.drawImage(t.layer.mask.canvas, t.layer.mask.x - t.holder.x, t.layer.mask.y - t.holder.y);
  else x.drawImage(c, 0, 0);
  const d = x.getImageData(0, 0, c.width, c.height).data;
  for (let i = 0; i < out.length; i++) out[i] = d[i * 4 + 3];
  ctx.aux = { depth: out };
}
defineFilter({
  id: 'motion-blur', label: 'Motion Blur', category: 'Blur', defaults: () => ({ angle: 0, distance: 10 }),
  ui: (b, p, u) => b.append(ui.angle('Angle:', p, 'angle', u), ui.slider('Distance:', p, 'distance', 1, 2000, u, { unit: 'Pixels' })),
});
defineFilter({
  id: 'radial-blur', label: 'Radial Blur', category: 'Blur', previewBox: false, defaults: () => ({ amount: 10, method: 'spin', quality: 'good', cx: 50, cy: 50 }),
  ui: (b, p, u, ctx) => b.append(ui.slider('Amount:', p, 'amount', 1, 100, u), ui.radios('Blur Method', p, 'method', [['spin', 'Spin'], ['zoom', 'Zoom']], u),
    ui.radios('Quality', p, 'quality', [['draft', 'Draft'], ['good', 'Good'], ['best', 'Best']], u), ui.center('Blur Center:', p, 'cx', 'cy', u, ctx)),
});
function shapeMask(id: string): { shapeMask: Uint8Array; shapeSize: number } | null {
  const s = resources.shapes.find(x => x.id === id) || resources.shapes[0];
  if (!s) return null;
  const N = 128, c = createCanvas(N, N), x = c.getContext('2d', { willReadFrequently: true })!;
  x.fillStyle = '#000';
  x.fill(toPath2D(parseSvgPath(s.path, new DOMMatrix().scale(N / 100))), 'evenodd');
  const d = x.getImageData(0, 0, N, N).data, m = new Uint8Array(N * N);
  for (let i = 0; i < m.length; i++) m[i] = d[i * 4 + 3];
  return { shapeMask: m, shapeSize: N };
}
defineFilter({
  id: 'shape-blur', label: 'Shape Blur', category: 'Blur', defaults: () => ({ radius: 10, shape: resources.shapes[0]?.id || '' }),
  prepare: (_d, p) => shapeMask(p.shape) || {},
  ui(b, p, u, ctx) {
    const grid = h('div.flt-shapes');
    const render = () => {
      grid.replaceChildren();
      for (const s of resources.shapes.slice(0, 60)) {
        const c = createCanvas(28, 28), x = ctx2d(c);
        x.fillStyle = getComputedStyle(document.body).getPropertyValue('--text') || '#ccc';
        x.fill(toPath2D(parseSvgPath(s.path, new DOMMatrix().translate(2, 2).scale(0.24))), 'evenodd');
        const cell = h('button.flt-shape', { type: 'button', title: s.name, class: s.id === p.shape ? 'active' : '' }, c);
        cell.addEventListener('click', () => { p.shape = s.id; ctx.aux = shapeMask(s.id) || {}; render(); u(); });
        grid.append(cell);
      }
    };
    render();
    b.append(ui.slider('Radius:', p, 'radius', 5, 1000, u, { unit: 'Pixels' }), grid);
  },
});
defineFilter({
  id: 'smart-blur', label: 'Smart Blur', category: 'Blur', defaults: () => ({ radius: 3, threshold: 25, quality: 'medium', mode: 'normal' }),
  ui: (b, p, u) => b.append(ui.slider('Radius:', p, 'radius', 0.1, 100, u, { decimals: 1, step: 0.1 }), ui.slider('Threshold:', p, 'threshold', 0.1, 100, u, { decimals: 1, step: 0.1 }),
    ui.select('Quality:', p, 'quality', [{ value: 'low', label: 'Low' }, { value: 'medium', label: 'Medium' }, { value: 'high', label: 'High' }], u),
    ui.select('Mode:', p, 'mode', [{ value: 'normal', label: 'Normal' }, { value: 'edge', label: 'Edge Only' }, { value: 'overlay', label: 'Overlay Edge' }], u)),
});
defineFilter({
  id: 'surface-blur', label: 'Surface Blur', category: 'Blur', defaults: () => ({ radius: 5, threshold: 15 }),
  ui: (b, p, u) => b.append(ui.slider('Radius:', p, 'radius', 1, 100, u, { unit: 'Pixels' }), ui.slider('Threshold:', p, 'threshold', 2, 255, u, { unit: 'levels' })),
});

// ================================================================== Blur Gallery
const galleryCommon = (b: HTMLElement, p: any, u: () => void) => b.append(
  h('div.flt-sub', null, 'Effects'),
  ui.slider('Light Bokeh:', p, 'bokeh', 0, 100, u, { unit: '%' }), ui.slider('Bokeh Light Range:', p, 'bokehRange', 0, 100, u),
  h('div.flt-sub', null, 'Noise'), ui.slider('Amount:', p, 'noise', 0, 100, u, { unit: '%' }));
defineFilter({
  id: 'field-blur', label: 'Field Blur', category: 'Blur Gallery', width: 680,
  defaults: () => ({ pins: [{ x: 30, y: 50, blur: 0 }, { x: 70, y: 50, blur: 25 }], sel: 1, bokeh: 0, bokehRange: 25, noise: 0 }),
  ui(b, p, u, ctx) {
    const list = h('div.flt-pins');
    const th = ctx.thumb(), c = createCanvas(th.width, th.height);
    c.className = 'flt-center';
    c.title = 'Click to add a pin, drag a pin to move it';
    const draw = () => {
      const x = ctx2d(c); x.drawImage(th, 0, 0);
      p.pins.forEach((pin: any, i: number) => { const px = (pin.x / 100) * c.width, py = (pin.y / 100) * c.height; x.beginPath(); x.arc(px, py, 6, 0, 7); x.fillStyle = i === p.sel ? '#1e8bff' : '#fff'; x.fill(); x.strokeStyle = '#000'; x.stroke(); });
    };
    const renderList = () => {
      list.replaceChildren();
      p.pins.forEach((pin: any, i: number) => {
        const row = ui.slider(`Pin ${i + 1} Blur:`, pin, 'blur', 0, 500, u, { unit: 'px' });
        row.classList.toggle('flt-pin-active', i === p.sel);
        row.addEventListener('pointerdown', () => { p.sel = i; draw(); });
        list.append(row);
      });
      list.append(ui.button('Remove Pin', 'Remove the selected pin', () => { if (p.pins.length > 1) { p.pins.splice(p.sel, 1); p.sel = Math.max(0, p.sel - 1); renderList(); draw(); u(); } }));
    };
    c.addEventListener('pointerdown', e => {
      const r = c.getBoundingClientRect(), fx = ((e.clientX - r.left) / r.width) * 100, fy = ((e.clientY - r.top) / r.height) * 100;
      let hit = p.pins.findIndex((pin: any) => Math.hypot(((pin.x - fx) / 100) * r.width, ((pin.y - fy) / 100) * r.height) < 9);
      if (hit < 0) { p.pins.push({ x: fx, y: fy, blur: 15 }); hit = p.pins.length - 1; renderList(); }
      p.sel = hit; draw();
      const pin = p.pins[hit];
      dragPointer(e, (_dx, _dy, ev) => { pin.x = Math.max(0, Math.min(100, ((ev.clientX - r.left) / r.width) * 100)); pin.y = Math.max(0, Math.min(100, ((ev.clientY - r.top) / r.height) * 100)); draw(); }, () => u());
    });
    draw(); renderList();
    b.append(h('div.flt-center-wrap', null, h('div.flt-center-label', null, 'Blur pins:'), c), list);
    galleryCommon(b, p, u);
  },
});
defineFilter({
  id: 'iris-blur', label: 'Iris Blur', category: 'Blur Gallery', width: 680,
  defaults: () => ({ blur: 15, cx: 50, cy: 50, rx: 30, ry: 30, rot: 0, feather: 35, bokeh: 0, bokehRange: 25, noise: 0 }),
  ui: (b, p, u, ctx) => { b.append(ui.center('Center:', p, 'cx', 'cy', u, ctx), ui.slider('Blur:', p, 'blur', 0, 500, u, { unit: 'px' }), ui.slider('Width:', p, 'rx', 2, 100, u, { unit: '%' }), ui.slider('Height:', p, 'ry', 2, 100, u, { unit: '%' }), ui.slider('Rotation:', p, 'rot', -180, 180, u, { unit: '°' }), ui.slider('Sharp Area:', p, 'feather', 0, 99, u, { unit: '%' })); galleryCommon(b, p, u); },
});
defineFilter({
  id: 'tilt-shift', label: 'Tilt-Shift', category: 'Blur Gallery', width: 680,
  defaults: () => ({ blur: 15, cx: 50, cy: 50, angle: 0, focus: 20, transition: 30, symmetric: true, bokeh: 0, bokehRange: 25, noise: 0 }),
  ui: (b, p, u, ctx) => { b.append(ui.center('Center:', p, 'cx', 'cy', u, ctx), ui.slider('Blur:', p, 'blur', 0, 500, u, { unit: 'px' }), ui.slider('Rotation:', p, 'angle', -90, 90, u, { unit: '°' }), ui.slider('Focus Area:', p, 'focus', 0, 100, u, { unit: '%' }), ui.slider('Transition:', p, 'transition', 1, 100, u, { unit: '%' }), ui.check('Symmetric Distortion', p, 'symmetric', u)); galleryCommon(b, p, u); },
});
defineFilter({
  id: 'path-blur', label: 'Path Blur', category: 'Blur Gallery', width: 640,
  defaults: () => ({ speed: 50, taper: 0, angle: 0, centered: true }),
  prepare: doc => ({ segments: pathSegments(doc) }),
  ui: (b, p, u, ctx) => b.append(
    hint(pathSegments(ctx.doc).length ? 'The blur follows the selected path (or Work Path) in the Paths panel.' : 'No path: the blur follows the angle below. Draw a path with the Pen tool to blur along it.'),
    ui.slider('Speed:', p, 'speed', 0, 500, u, { unit: 'px' }), ui.slider('Taper:', p, 'taper', 0, 100, u, { unit: '%' }), ui.angle('Angle:', p, 'angle', u), ui.check('Centered Blur', p, 'centered', u)),
});
defineFilter({
  id: 'spin-blur', label: 'Spin Blur', category: 'Blur Gallery', width: 660,
  defaults: () => ({ angle: 15, cx: 50, cy: 50, rx: 30, ry: 30, rot: 0, feather: 20 }),
  ui: (b, p, u, ctx) => b.append(ui.center('Center:', p, 'cx', 'cy', u, ctx), ui.slider('Blur Angle:', p, 'angle', 0, 360, u, { unit: '°' }), ui.slider('Width:', p, 'rx', 2, 100, u, { unit: '%' }), ui.slider('Height:', p, 'ry', 2, 100, u, { unit: '%' }), ui.slider('Rotation:', p, 'rot', -180, 180, u, { unit: '°' }), ui.slider('Feather:', p, 'feather', 0, 100, u, { unit: '%' })),
});

// ================================================================== Distort
async function pickMap(): Promise<{ map: ImageData } | null> {
  const [f] = await pickFiles('image/*,.psd,.pxd');
  if (!f) return null;
  const c = await flatCanvasOf(f, f.name);
  return { map: c.getContext('2d', { willReadFrequently: true })!.getImageData(0, 0, c.width, c.height) };
}
defineFilter({
  id: 'displace', label: 'Displace', category: 'Distort', smart: false, width: 640,
  defaults: () => ({ h: 10, v: 10, fit: 'stretch', edge: 'wrap' }),
  prepare: async () => { toast('Choose a displacement map (grayscale or RGB image, PSD supported).', 'info', 3500); const m = await pickMap(); if (!m) return null; return m; },
  ui: (b, p, u, ctx) => b.append(
    ui.slider('Horizontal Scale:', p, 'h', -999, 999, u, { unit: '%', center: 0 }), ui.slider('Vertical Scale:', p, 'v', -999, 999, u, { unit: '%', center: 0 }),
    ui.radios('Displacement Map', p, 'fit', [['stretch', 'Stretch to Fit'], ['tile', 'Tile']], u),
    ui.radios('Undefined Areas', p, 'edge', [['wrap', 'Wrap Around'], ['repeat', 'Repeat Edge Pixels']], u),
    ui.button('Choose Map…', 'Choose a different displacement map', async () => { const m = await pickMap(); if (m) { ctx.aux = m; u(); } })),
});
defineFilter({ id: 'pinch', label: 'Pinch', category: 'Distort', defaults: () => ({ amount: 50 }), ui: (b, p, u) => b.append(ui.slider('Amount:', p, 'amount', -100, 100, u, { unit: '%', center: 0 })) });
defineFilter({ id: 'polar', label: 'Polar Coordinates', category: 'Distort', defaults: () => ({ mode: 'toPolar' }), ui: (b, p, u) => b.append(ui.radios('', p, 'mode', [['toPolar', 'Rectangular to Polar'], ['toRect', 'Polar to Rectangular']], u)) });
defineFilter({
  id: 'ripple', label: 'Ripple', category: 'Distort', defaults: () => ({ amount: 100, size: 'medium', edge: 'repeat' }),
  ui: (b, p, u) => b.append(ui.slider('Amount:', p, 'amount', -999, 999, u, { unit: '%', center: 0 }), ui.select('Size:', p, 'size', [{ value: 'small', label: 'Small' }, { value: 'medium', label: 'Medium' }, { value: 'large', label: 'Large' }], u)),
});
defineFilter({
  id: 'shear', label: 'Shear', category: 'Distort', defaults: () => ({ points: [[0, 0], [1, 0]], edge: 'wrap' }),
  ui(b, p, u) {
    const S = 180, c = createCanvas(S, S);
    c.className = 'flt-curve';
    c.title = 'Click to add points, drag to bend, drag a point out to remove it';
    const draw = () => {
      const x = ctx2d(c); x.clearRect(0, 0, S, S);
      x.strokeStyle = 'rgba(128,128,128,.4)'; for (let i = 1; i < 4; i++) { x.beginPath(); x.moveTo((i * S) / 4, 0); x.lineTo((i * S) / 4, S); x.moveTo(0, (i * S) / 4); x.lineTo(S, (i * S) / 4); x.stroke(); }
      const pts = [...p.points].sort((a: number[], bb: number[]) => a[0] - bb[0]);
      x.strokeStyle = '#1e8bff'; x.lineWidth = 1.5; x.beginPath();
      for (let yy = 0; yy <= S; yy += 2) { const v = curveAt(pts, yy / S); const xx = S / 2 + (v * S) / 2; if (yy) x.lineTo(xx, yy); else x.moveTo(xx, yy); }
      x.stroke();
      x.fillStyle = '#fff'; x.strokeStyle = '#000';
      for (const [t, v] of pts) { x.fillRect(S / 2 + (v * S) / 2 - 3, t * S - 3, 6, 6); x.strokeRect(S / 2 + (v * S) / 2 - 3, t * S - 3, 6, 6); }
    };
    c.addEventListener('pointerdown', e => {
      const r = c.getBoundingClientRect(), toV = (ev: PointerEvent) => [Math.max(0, Math.min(1, (ev.clientY - r.top) / r.height)), Math.max(-1, Math.min(1, ((ev.clientX - r.left) / r.width) * 2 - 1))];
      const [t0, v0] = toV(e);
      let idx = p.points.findIndex(([t, v]: number[]) => Math.abs(t - t0) * S < 7 && Math.abs(v - v0) * (S / 2) < 7);
      if (idx < 0) { p.points.push([t0, v0]); idx = p.points.length - 1; }
      const end = p.points[idx][0] === 0 || p.points[idx][0] === 1;
      dragPointer(e, (_dx, _dy, ev) => {
        if (idx < 0) return;
        const [t, v] = toV(ev);
        p.points[idx] = [end ? p.points[idx][0] : t, v];
        if (!end && (ev.clientX < r.left - 20 || ev.clientX > r.right + 20)) { p.points.splice(idx, 1); idx = -1; }
        draw();
      }, () => u());
      draw();
    });
    draw();
    b.append(c, ui.button('Default', 'Reset the curve', () => { p.points = [[0, 0], [1, 0]]; draw(); u(); }),
      ui.radios('Undefined Areas', p, 'edge', [['wrap', 'Wrap Around'], ['repeat', 'Repeat Edge Pixels']], u));
  },
});
defineFilter({
  id: 'spherize', label: 'Spherize', category: 'Distort', defaults: () => ({ amount: 100, mode: 'normal' }),
  ui: (b, p, u) => b.append(ui.slider('Amount:', p, 'amount', -100, 100, u, { unit: '%', center: 0 }), ui.select('Mode:', p, 'mode', [{ value: 'normal', label: 'Normal' }, { value: 'horizontal', label: 'Horizontal only' }, { value: 'vertical', label: 'Vertical only' }], u)),
});
defineFilter({ id: 'twirl', label: 'Twirl', category: 'Distort', defaults: () => ({ angle: 50 }), ui: (b, p, u) => b.append(ui.slider('Angle:', p, 'angle', -999, 999, u, { unit: '°', center: 0 })) });
defineFilter({
  id: 'wave', label: 'Wave', category: 'Distort', width: 680,
  defaults: () => ({ generators: 5, wlMin: 10, wlMax: 120, ampMin: 5, ampMax: 35, scaleH: 100, scaleV: 100, type: 'sine', edge: 'repeat', seed: 1 }),
  ui: (b, p, u) => b.append(
    ui.slider('Number of Generators:', p, 'generators', 1, 999, u), ui.slider('Wavelength Min:', p, 'wlMin', 1, 998, u), ui.slider('Wavelength Max:', p, 'wlMax', 2, 999, u),
    ui.slider('Amplitude Min:', p, 'ampMin', 1, 998, u), ui.slider('Amplitude Max:', p, 'ampMax', 2, 999, u), ui.slider('Scale Horiz.:', p, 'scaleH', 1, 100, u, { unit: '%' }), ui.slider('Scale Vert.:', p, 'scaleV', 1, 100, u, { unit: '%' }),
    ui.radios('Type', p, 'type', [['sine', 'Sine'], ['triangle', 'Triangle'], ['square', 'Square']], u),
    ui.radios('Undefined Areas', p, 'edge', [['wrap', 'Wrap Around'], ['repeat', 'Repeat Edge Pixels']], u),
    ui.button('Randomize', 'New random waves', () => { p.seed = Math.floor(Math.random() * 1e6); u(); })),
});
defineFilter({
  id: 'zigzag', label: 'ZigZag', category: 'Distort', defaults: () => ({ amount: 10, ridges: 5, style: 'pond' }),
  ui: (b, p, u) => b.append(ui.slider('Amount:', p, 'amount', -100, 100, u, { center: 0 }), ui.slider('Ridges:', p, 'ridges', 1, 20, u),
    ui.select('Style:', p, 'style', [{ value: 'around', label: 'Around center' }, { value: 'out', label: 'Out from center' }, { value: 'pond', label: 'Pond ripples' }], u)),
});

// ================================================================== Noise
defineFilter({
  id: 'add-noise', label: 'Add Noise', category: 'Noise', defaults: () => ({ amount: 12.5, dist: 'uniform', mono: false }),
  ui: (b, p, u) => b.append(ui.slider('Amount:', p, 'amount', 0.1, 400, u, { unit: '%', decimals: 1, step: 0.1 }), ui.radios('Distribution', p, 'dist', [['uniform', 'Uniform'], ['gaussian', 'Gaussian']], u), ui.check('Monochromatic', p, 'mono', u)),
});
defineFilter({ id: 'despeckle', label: 'Despeckle', category: 'Noise', dialog: false, defaults: () => ({}) });
defineFilter({
  id: 'dust-scratches', label: 'Dust & Scratches', category: 'Noise', defaults: () => ({ radius: 1, threshold: 0 }),
  ui: (b, p, u) => b.append(ui.slider('Radius:', p, 'radius', 1, 100, u, { unit: 'Pixels' }), ui.slider('Threshold:', p, 'threshold', 0, 255, u, { unit: 'levels' })),
});
defineFilter({ id: 'median', label: 'Median', category: 'Noise', defaults: () => ({ radius: 1 }), ui: (b, p, u) => b.append(ui.slider('Radius:', p, 'radius', 1, 100, u, { unit: 'Pixels' })) });
defineFilter({
  id: 'reduce-noise', label: 'Reduce Noise', category: 'Noise', width: 660, defaults: () => ({ strength: 6, preserve: 60, color: 45, sharpen: 25 }),
  ui: (b, p, u) => b.append(ui.slider('Strength:', p, 'strength', 0, 10, u), ui.slider('Preserve Details:', p, 'preserve', 0, 100, u, { unit: '%' }), ui.slider('Reduce Color Noise:', p, 'color', 0, 100, u, { unit: '%' }), ui.slider('Sharpen Details:', p, 'sharpen', 0, 100, u, { unit: '%' })),
});

export { app };
