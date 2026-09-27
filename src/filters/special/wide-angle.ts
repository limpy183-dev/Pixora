// Filter › Adaptive Wide Angle (Alt+Shift+Ctrl+A): Fisheye, Perspective, Full Spherical and Auto corrections with
// scale / focal length / crop factor; Constraint tool lines (drawn on the original image) level the result: each
// constraint is made horizontal or vertical (Shift while drawing forces the nearest), Alt-click deletes one.
import { registerCommands } from '../../core/commands';
import { registerIcons } from '../../ui/icons';
import { h } from '../../ui/dom';
import { select } from '../../ui/widgets';
import { app } from '../../core/app';
import { createCanvas } from '../../core/canvas';
import type { PixDocument } from '../../core/document';
import type { SmartObjectLayer } from '../../layers/smart-object';
import { applyKernel, putSmartFilter, registerSpec, runPreview, rgb3 } from '../engine';
import { grabSource, openWorkspace, readPixels, wsSection, wsSlider } from './workspace';

registerIcons({
  'aw-constraint': '<path d="M3 17c5-8 13-8 18 0"/><circle cx="3" cy="17" r="1.6"/><circle cx="21" cy="17" r="1.6"/>',
  'aw-move': '<path d="M12 3v18M3 12h18M12 3l-3 3M12 3l3 3M12 21l-3-3M12 21l3-3M3 12l3-3M3 12l3 3M21 12l-3-3M21 12l-3 3"/>',
});
export const awDefaults = () => ({ mode: 'fisheye', scale: 100, focal: 12, crop: 1, rotate: 0, offX: 0, offY: 0, yaw: 0, pitch: 0, fov: 90, edge: 'transparent', constraints: [] as { x0: number; y0: number; x1: number; y1: number; kind: 'h' | 'v' | 'auto' }[] });

/** Map an input (source) point to output coordinates for the current model (numerical inverse of the kernel map). */
function forward(p: ReturnType<typeof awDefaults>, W: number, H: number, sx: number, sy: number): [number, number] {
  const diag = Math.hypot(W, H), f = (p.focal / (43.27 / (p.crop || 1))) * diag, cx = W / 2 + (p.offX * W) / 200, cy = H / 2 + (p.offY * H) / 200, sc = p.scale / 100;
  const dx = sx - cx, dy = sy - cy, rd = Math.hypot(dx, dy);
  let u = dx, v = dy;
  const fish = p.mode === 'fisheye' || (p.mode === 'auto' && p.focal < 16);
  if (fish) { const theta = rd / f; const ru = theta < Math.PI / 2 - 0.01 ? f * Math.tan(theta) : f * 50; const k = rd > 0 ? ru / rd : 1; u = dx * k; v = dy * k; }
  else if (p.mode === 'perspective' || p.mode === 'auto') { let r = rd; for (let i = 0; i < 6; i++) { const k = 1 + (r / f) * (r / f) * (0.08 * (24 / Math.max(8, p.focal))); r = rd * k; } const k = rd > 0 ? r / rd : 1; u = dx * k; v = dy * k; }
  const a = (-(p.rotate || 0) * Math.PI) / 180, ca = Math.cos(a), sa = Math.sin(a);
  [u, v] = [u * ca - v * sa, u * sa + v * ca];
  return [W / 2 + u * sc, H / 2 + v * sc];
}
/** Rotation (deg) that best satisfies the constraints in corrected space. */
function solveRotation(p: ReturnType<typeof awDefaults>, W: number, H: number): number {
  if (!p.constraints.length) return 0;
  const q = { ...p, rotate: 0 };
  let sum = 0, n = 0;
  for (const c of p.constraints) {
    const [ax, ay] = forward(q, W, H, c.x0, c.y0), [bx, by] = forward(q, W, H, c.x1, c.y1);
    let a = (Math.atan2(by - ay, bx - ax) * 180) / Math.PI;
    if (a > 90) a -= 180; if (a < -90) a += 180;
    const vertical = c.kind === 'v' || (c.kind === 'auto' && Math.abs(a) > 45);
    const target = vertical ? (a > 0 ? 90 : -90) : 0;
    sum += target - a; n++;
  }
  return Math.round((sum / n) * 100) / 100;
}

export async function openWideAngle(existing?: { so: SmartObjectLayer; index: number; params: any }) {
  const src = grabSource(1200);
  if (!src) return;
  const p: ReturnType<typeof awDefaults> = existing ? { ...awDefaults(), ...JSON.parse(JSON.stringify(existing.params)) } : awDefaults();
  const W = src.full.width, H = src.full.height, s = src.scale;
  const orig = readPixels(src.preview), pw = orig.width, ph = orig.height;
  const outC = createCanvas(pw, ph), outX = outC.getContext('2d', { willReadFrequently: true })!;
  outX.putImageData(orig, 0, 0);
  let showOriginal = false, busy = false, pending = false;
  // the kernel works in full-resolution pixel units; previews pass a scaled copy of the focal length
  const kernelParams = (full: boolean) => ({ ...p, focal: p.focal, constraints: undefined, _pw: full ? W : pw });
  const render = async () => {
    if (busy) { pending = true; return; }
    busy = true;
    try {
      const img = new ImageData(new Uint8ClampedArray(orig.data), pw, ph);
      const res = await runPreview('wide-angle', img, kernelParams(false), { x: 0, y: 0, docW: pw, docH: ph, sel: null, isMask: false, preview: true, fg: rgb3(app.fg), bg: rgb3(app.bg), seed: 1, aux: {} });
      if (!showOriginal) outX.putImageData(res, 0, 0);
      ws.view.draw();
    } catch (err) { console.error(err); }
    busy = false;
    if (pending) { pending = false; void render(); }
  };
  const sliders: { el: any; key: keyof typeof p }[] = [];
  const S = (label: string, key: keyof typeof p, min: number, max: number, o: { step?: number; center?: number; unit?: string } = {}) => {
    const el = wsSlider(label, p[key] as number, min, max, v => { (p as any)[key] = v; if (key !== 'rotate') { p.rotate = solveRotation(p, W, H); sync('rotate'); } void render(); }, { step: o.step, center: o.center, unit: o.unit });
    sliders.push({ el, key });
    return el;
  };
  const sync = (only?: string) => sliders.forEach(x => { if (!only || x.key === only) x.el.setValue(p[x.key] as number); });
  const sphere = wsSection('Spherical View', S('Yaw', 'yaw', -180, 180, { center: 0, unit: '°' }), S('Pitch', 'pitch', -90, 90, { center: 0, unit: '°' }), S('Field of View', 'fov', 20, 150, { unit: '°' }));
  const list = h('div.aw-list');
  const renderList = () => {
    list.replaceChildren(...p.constraints.map((c, i) => {
      const kind = select<string>([{ value: 'auto', label: 'Auto' }, { value: 'h', label: 'Horizontal' }, { value: 'v', label: 'Vertical' }], c.kind, v => { c.kind = v as any; p.rotate = solveRotation(p, W, H); sync('rotate'); void render(); ws.view.draw(); }, { width: 100 });
      return h('div.ws-row', null, h('span.ws-label', null, `Constraint ${i + 1}`), kind,
        h('button.icon-btn', { type: 'button', title: 'Delete constraint', onclick: () => { p.constraints.splice(i, 1); renderList(); p.rotate = solveRotation(p, W, H); sync('rotate'); void render(); ws.view.draw(); } }, '×'));
    }));
    if (!p.constraints.length) list.append(h('div.flt-hint', null, 'Draw constraint lines with the Constraint tool (C) along edges that should be straight and level.'));
  };
  renderList();
  const side = h('div.aw-side', null,
    h('div.ws-row', null, h('span.ws-label', null, 'Correction:'), select<string>([{ value: 'fisheye', label: 'Fisheye' }, { value: 'perspective', label: 'Perspective' }, { value: 'spherical', label: 'Full Spherical' }, { value: 'auto', label: 'Auto' }], p.mode, v => { p.mode = v; sphere.style.display = v === 'spherical' ? '' : 'none'; void render(); }, { width: 150, title: 'Correction model' })),
    S('Scale', 'scale', 50, 150, { center: 100, unit: '%' }), S('Focal Length', 'focal', 4, 100, { step: 0.5, unit: ' mm' }), S('Crop Factor', 'crop', 0.5, 10, { step: 0.05 }), S('Rotate', 'rotate', -45, 45, { step: 0.1, center: 0, unit: '°' }),
    S('Horizontal Offset', 'offX', -50, 50, { center: 0 }), S('Vertical Offset', 'offY', -50, 50, { center: 0 }),
    h('div.ws-row', null, h('span.ws-label', null, 'Edge:'), select<string>([{ value: 'transparent', label: 'Transparency' }, { value: 'extend', label: 'Edge Extension' }, { value: 'black', label: 'Black' }, { value: 'white', label: 'White' }], p.edge, v => { p.edge = v; void render(); }, { width: 140 })),
    sphere, wsSection('Constraints', list),
    h('div.ws-row', null, h('button.btn', { type: 'button', title: 'Show the original image with the constraints (hold to compare)', onclick: () => { showOriginal = !showOriginal; outX.putImageData(showOriginal ? orig : outX.getImageData(0, 0, pw, ph), 0, 0); if (!showOriginal) void render(); ws.view.draw(); } }, 'Show Original')));
  sphere.style.display = p.mode === 'spherical' ? '' : 'none';
  const ws = openWorkspace({
    title: 'Adaptive Wide Angle', side, className: 'aw-dialog',
    tools: [
      { id: 'constraint', icon: 'aw-constraint', title: 'Constraint Tool — drag along a line that should be straight (Shift: horizontal/vertical, Alt-click: delete)', key: 'C' },
      { id: 'move', icon: 'aw-move', title: 'Move Tool — drag to offset the image', key: 'M' },
      { id: 'hand', icon: 'lq-hand', title: 'Hand Tool', key: 'H' },
      { id: 'zoom', icon: 'lq-zoom', title: 'Zoom Tool', key: 'Z' },
    ],
    onTool: (id, w) => { w.view.cursor = id === 'hand' ? 'grab' : id === 'zoom' ? 'zoom-in' : id === 'move' ? 'move' : 'crosshair'; w.view.canvas.style.cursor = w.view.cursor; },
  });
  ws.view.setImage(outC, pw, ph, true);
  let drawing: { x0: number; y0: number; x1: number; y1: number } | null = null, mv: { x: number; y: number; ox: number; oy: number } | null = null;
  ws.view.overlay = (c, v) => {
    // constraints are defined on the source image; show them where they land in the corrected preview
    const all = [...p.constraints, ...(drawing ? [{ ...drawing, kind: 'auto' as const }] : [])];
    for (const k of all) {
      c.strokeStyle = k.kind === 'h' ? '#ffd23f' : k.kind === 'v' ? '#e0409c' : '#1ee8ff'; c.lineWidth = 2;
      c.beginPath();
      for (let t = 0; t <= 24; t++) {
        const sx = k.x0 + ((k.x1 - k.x0) * t) / 24, sy = k.y0 + ((k.y1 - k.y0) * t) / 24;
        const [ox, oy] = showOriginal ? [sx, sy] : forward(p, W, H, sx, sy);
        const q = v.toScreen(ox * s, oy * s);
        if (t) c.lineTo(q.x, q.y); else c.moveTo(q.x, q.y);
      }
      c.stroke();
    }
  };
  /** Preview point → source (full-res) point by numerically inverting forward(). */
  const toSource = (x: number, y: number): [number, number] => {
    if (showOriginal) return [x / s, y / s];
    let sx = x / s, sy = y / s;
    for (let i = 0; i < 30; i++) { const [fx, fy] = forward(p, W, H, sx, sy); sx += (x / s - fx) * 0.7; sy += (y / s - fy) * 0.7; }
    return [sx, sy];
  };
  ws.view.onDown = pt => {
    if (ws.tool === 'zoom') { ws.view.zoomAt(ws.view.zoom * (pt.e.altKey ? 1 / 1.5 : 1.5), pt.sx, pt.sy); return; }
    if (ws.tool === 'move') { mv = { x: pt.x, y: pt.y, ox: p.offX, oy: p.offY }; return; }
    if (ws.tool !== 'constraint') return;
    const [sx, sy] = toSource(pt.x, pt.y);
    if (pt.e.altKey) {
      // delete the nearest constraint
      let best = -1, bd = 20 / (ws.view.zoom * s);
      p.constraints.forEach((c, i) => { const vx = c.x1 - c.x0, vy = c.y1 - c.y0, L2 = vx * vx + vy * vy || 1, t = Math.max(0, Math.min(1, ((sx - c.x0) * vx + (sy - c.y0) * vy) / L2)), d = Math.hypot(c.x0 + vx * t - sx, c.y0 + vy * t - sy); if (d < bd) { bd = d; best = i; } });
      if (best >= 0) { p.constraints.splice(best, 1); renderList(); p.rotate = solveRotation(p, W, H); sync('rotate'); void render(); }
      return;
    }
    drawing = { x0: sx, y0: sy, x1: sx, y1: sy };
  };
  ws.view.onMove = (pt, down) => {
    if (!down) return;
    if (mv) { p.offX = Math.max(-50, Math.min(50, mv.ox - ((pt.x - mv.x) / pw) * 200)); p.offY = Math.max(-50, Math.min(50, mv.oy - ((pt.y - mv.y) / ph) * 200)); sync('offX'); sync('offY'); void render(); return; }
    if (drawing) { const [sx, sy] = toSource(pt.x, pt.y); drawing.x1 = sx; drawing.y1 = sy; ws.view.draw(); }
  };
  ws.view.onUp = pt => {
    mv = null;
    if (drawing && Math.hypot(drawing.x1 - drawing.x0, drawing.y1 - drawing.y0) * s * ws.view.zoom > 8) {
      let kind: 'h' | 'v' | 'auto' = 'auto';
      if (pt.e.shiftKey) { const a = Math.abs(Math.atan2(drawing.y1 - drawing.y0, drawing.x1 - drawing.x0)); kind = a > Math.PI / 4 && a < (3 * Math.PI) / 4 ? 'v' : 'h'; }
      p.constraints.push({ ...drawing, kind });
      renderList(); p.rotate = solveRotation(p, W, H); sync('rotate'); void render();
    }
    drawing = null; ws.view.draw();
  };
  void render();
  const ok = await ws.result;
  if (!ok) return;
  const final = { ...kernelParams(true), constraints: p.constraints };
  if (src.kind === 'smart' && src.so) putSmartFilter(src.doc, src.so, 'wide-angle', 'Adaptive Wide Angle', final, existing?.index ?? -1);
  else await applyKernel(src.doc, 'Adaptive Wide Angle', 'wide-angle', final);
}

registerSpec({
  id: 'wide-angle', label: 'Adaptive Wide Angle', category: 'Special', dialog: false, kernel: 'wide-angle', defaults: awDefaults,
  edit: (doc: PixDocument, so: SmartObjectLayer, index: number) => { if (app.activeDoc !== doc) return; doc.setActiveLayer(so); void openWideAngle({ so, index, params: so.smartFilters[index].params }); },
});
registerCommands([{ id: 'filter.adaptiveWideAngle', label: 'Adaptive Wide Angle...', enabled: () => !!app.activeDoc, run: () => openWideAngle() }]);
