// Filter › Lens Correction (Shift+Ctrl+R): Auto Correction (generic lens profiles, auto scale, edge mode) and Custom
// (Remove Distortion, Chromatic Aberration, Vignette, Transform). Tools: Remove Distortion (D), Straighten (A),
// Move Grid (M), Hand (H), Zoom (Z). Show Grid with size / colour. Works as a Smart Filter.
import { registerCommands } from '../../core/commands';
import { registerIcons } from '../../ui/icons';
import { h } from '../../ui/dom';
import { checkbox, colorSwatch, select } from '../../ui/widgets';
import { app } from '../../core/app';
import { createCanvas } from '../../core/canvas';
import type { PixDocument } from '../../core/document';
import type { SmartObjectLayer } from '../../layers/smart-object';
import { applyKernel, putSmartFilter, registerSpec, runPreview, rgb3 } from '../engine';
import { perspectiveMatrix } from '../kernels/special';
import { grabSource, openWorkspace, readPixels, wsSection, wsSlider } from './workspace';

registerIcons({
  'lc-distort': '<path d="M4 4c3 2 13 2 16 0M4 20c3-2 13-2 16 0M4 4c2 3 2 13 0 16M20 4c-2 3-2 13 0 16"/>',
  'lc-straighten': '<path d="M3 17L21 7"/><circle cx="3" cy="17" r="1.5"/><circle cx="21" cy="7" r="1.5"/>',
  'lc-grid': '<path d="M4 4h16v16H4zM4 10h16M4 15h16M10 4v16M15 4v16"/>',
});
const PROFILES: { name: string; distortion: number; vignette: number; ca: number }[] = [
  { name: 'Generic 14mm Ultra-Wide', distortion: 32, vignette: 45, ca: 25 },
  { name: 'Generic 18mm Wide Zoom', distortion: 20, vignette: 35, ca: 18 },
  { name: 'Generic 24mm Wide', distortion: 11, vignette: 25, ca: 12 },
  { name: 'Generic 35mm', distortion: 5, vignette: 15, ca: 8 },
  { name: 'Generic 50mm Standard', distortion: 1, vignette: 12, ca: 5 },
  { name: 'Generic 85mm Portrait', distortion: -2, vignette: 8, ca: 4 },
  { name: 'Generic 200mm Telephoto', distortion: -5, vignette: 10, ca: 10 },
  { name: 'Smartphone Main Camera', distortion: 6, vignette: 22, ca: 10 },
  { name: 'Smartphone Ultra-Wide', distortion: 28, vignette: 38, ca: 20 },
  { name: 'Action Camera (Wide)', distortion: 60, vignette: 40, ca: 25 },
];
export const lensDefaults = () => ({ distortion: 0, caRed: 0, caGreen: 0, caBlue: 0, vignette: 0, midpoint: 50, vert: 0, horiz: 0, angle: 0, scale: 100, edge: 'transparent' as 'transparent' | 'black' | 'white' | 'extend' });

/** Smallest scale (%) at which the corrected image has no undefined corners / edge midpoints. */
function autoScale(p: ReturnType<typeof lensDefaults>, W: number, H: number): number {
  const test = (scale: number) => {
    const Hm = perspectiveMatrix({ vert: p.vert, horiz: p.horiz, angle: p.angle, scale }) as number[], k = -p.distortion / 100 * 0.35, cx = W / 2, cy = H / 2, R = Math.hypot(cx, cy);
    const caMax = Math.max(0, ((p.caRed - p.caGreen) / 100) * 0.004, ((p.caBlue - p.caGreen) / 100) * 0.004);
    for (const [x, y] of [[0, 0], [W, 0], [0, H], [W, H], [W / 2, 0], [W / 2, H], [0, H / 2], [W, H / 2]]) {
      const u = (x - cx) / R, v = (y - cy) / R, w = Hm[6] * u + Hm[7] * v + Hm[8];
      if (w <= 0.01) return false;
      const u2 = (Hm[0] * u + Hm[1] * v + Hm[2]) / w, v2 = (Hm[3] * u + Hm[4] * v + Hm[5]) / w, r2 = u2 * u2 + v2 * v2, f = (1 + k * r2) * (1 + caMax * Math.sqrt(r2) * 10);
      const sx = cx + u2 * f * R, sy = cy + v2 * f * R;
      if (sx < -0.5 || sy < -0.5 || sx > W + 0.5 || sy > H + 0.5) return false;
    }
    return true;
  };
  let lo = 50, hi = 200;
  if (test(100)) hi = 100;
  for (let i = 0; i < 24; i++) { const m = (lo + hi) / 2; if (test(m)) hi = m; else lo = m; }
  return Math.round(hi * 10) / 10;
}

export async function openLensCorrection(existing?: { so: SmartObjectLayer; index: number; params: any }) {
  const src = grabSource(1200);
  if (!src) return;
  const p: ReturnType<typeof lensDefaults> = existing ? { ...lensDefaults(), ...existing.params } : lensDefaults();
  const auto = { profile: -1, geometric: true, ca: true, vig: true, autoScale: true };
  const view = { grid: false, gridSize: 64, gridColor: { r: 128, g: 128, b: 128 }, gx: 0, gy: 0 };
  const orig = readPixels(src.preview), pw = orig.width, ph = orig.height;
  const outC = createCanvas(pw, ph), outX = outC.getContext('2d', { willReadFrequently: true })!;
  outX.putImageData(orig, 0, 0);
  let busy = false, pending = false;
  const render = async () => {
    if (busy) { pending = true; return; }
    busy = true;
    try {
      const img = new ImageData(new Uint8ClampedArray(orig.data), pw, ph);
      const res = await runPreview('lens-correction', img, p, { x: 0, y: 0, docW: pw, docH: ph, sel: null, isMask: false, preview: true, fg: rgb3(app.fg), bg: rgb3(app.bg), seed: 1, aux: {} });
      outX.putImageData(res, 0, 0);
      ws.view.draw();
    } catch (err) { console.error(err); }
    busy = false;
    if (pending) { pending = false; void render(); }
  };
  const sliders: { el: any; key: keyof typeof p }[] = [];
  const S = (label: string, key: keyof typeof p, min: number, max: number, o: { step?: number; center?: number; track?: string } = {}) => {
    const el = wsSlider(label, p[key] as number, min, max, v => { (p as any)[key] = v; if (auto.autoScale && key !== 'scale') { p.scale = autoScale(p, src.full.width, src.full.height); sync('scale'); } void render(); }, { center: o.center ?? (min < 0 ? 0 : undefined), step: o.step, track: o.track });
    sliders.push({ el, key });
    return el;
  };
  const sync = (only?: string) => sliders.forEach(s => { if (!only || s.key === only) s.el.setValue(p[s.key] as number); });
  const applyProfile = () => {
    const pr = PROFILES[auto.profile];
    if (!pr) return;
    if (auto.geometric) p.distortion = pr.distortion;
    if (auto.vig) { p.vignette = pr.vignette; p.midpoint = 50; }
    if (auto.ca) { p.caRed = pr.ca * 0.5; p.caBlue = -pr.ca * 0.4; }
    if (auto.autoScale) p.scale = autoScale(p, src.full.width, src.full.height);
    sync(); void render();
  };
  const edgeSel = select<string>([{ value: 'extend', label: 'Edge Extension' }, { value: 'transparent', label: 'Transparency' }, { value: 'black', label: 'Black Color' }, { value: 'white', label: 'White Color' }], p.edge, v => { p.edge = v as any; void render(); }, { width: 150, title: 'Fill undefined areas with' });
  const autoTab = h('div.lc-tab',
    null,
    h('div.ws-label', null, 'Correction'),
    checkbox('Geometric Distortion', auto.geometric, v => { auto.geometric = v; applyProfile(); }),
    checkbox('Chromatic Aberration', auto.ca, v => { auto.ca = v; applyProfile(); }),
    checkbox('Vignette', auto.vig, v => { auto.vig = v; applyProfile(); }),
    checkbox('Auto Scale Image', auto.autoScale, v => { auto.autoScale = v; if (v) { p.scale = autoScale(p, src.full.width, src.full.height); sync('scale'); void render(); } }),
    h('div.ws-row', null, h('span.ws-label', null, 'Edge:'), edgeSel),
    h('div.ws-label', null, 'Lens Profiles'),
    select<number>([{ value: -1, label: 'None' }, ...PROFILES.map((pr, i) => ({ value: i, label: pr.name }))], auto.profile, v => { auto.profile = v; applyProfile(); }, { width: 240, title: 'Generic lens profile' }),
    h('div.flt-hint', null, 'Generic profiles approximate typical lenses; fine-tune in the Custom tab.'));
  const angleNum = wsSlider('Angle', p.angle, -180, 180, v => { p.angle = v; if (auto.autoScale) { p.scale = autoScale(p, src.full.width, src.full.height); sync('scale'); } void render(); }, { step: 0.1, center: 0, unit: '°' });
  sliders.push({ el: angleNum, key: 'angle' });
  const customTab = h('div.lc-tab', null,
    wsSection('Geometric Distortion', S('Remove Distortion', 'distortion', -100, 100, { step: 0.5 })),
    wsSection('Chromatic Aberration', S('Fix Red/Cyan Fringe', 'caRed', -100, 100, { track: 'linear-gradient(90deg,#0cc,#888,#e33)' }), S('Fix Green/Magenta Fringe', 'caGreen', -100, 100, { track: 'linear-gradient(90deg,#c3c,#888,#3c3)' }), S('Fix Blue/Yellow Fringe', 'caBlue', -100, 100, { track: 'linear-gradient(90deg,#ec3,#888,#36f)' })),
    wsSection('Vignette', S('Amount', 'vignette', -100, 100, { track: 'linear-gradient(90deg,#000,#888,#fff)' }), S('Midpoint', 'midpoint', 0, 100)),
    wsSection('Transform', S('Vertical Perspective', 'vert', -100, 100), S('Horizontal Perspective', 'horiz', -100, 100), angleNum, S('Scale', 'scale', 50, 150, { center: 100, step: 0.1 })));
  let tab: 'auto' | 'custom' = existing ? 'custom' : 'auto';
  const tabsEl = h('div.ws-tabs');
  const body = h('div');
  const renderTabs = () => {
    tabsEl.replaceChildren(...(['auto', 'custom'] as const).map(t => { const b = h('button.ws-tab', { type: 'button', class: t === tab ? 'active' : '', title: t === 'auto' ? 'Profile-based corrections' : 'Manual corrections' }, t === 'auto' ? 'Auto Correction' : 'Custom'); b.addEventListener('click', () => { tab = t; renderTabs(); }); return b; }));
    body.replaceChildren(tab === 'auto' ? autoTab : customTab);
  };
  renderTabs();
  const side = h('div.lc-side', null, tabsEl, body,
    wsSection('Grid', checkbox('Show Grid', view.grid, v => { view.grid = v; ws.view.draw(); }),
      wsSlider('Size', view.gridSize, 8, 256, v => { view.gridSize = v; ws.view.draw(); }),
      h('div.ws-row', null, h('span.ws-label', null, 'Color'), colorSwatch(view.gridColor, c => { view.gridColor = c; ws.view.draw(); }, { title: 'Grid color', size: 18 }))),
    h('div.flt-hint', null, 'Straighten tool: drag along a line that should be horizontal or vertical.'));
  const ws = openWorkspace({
    title: 'Lens Correction', side, className: 'lc-dialog',
    tools: [
      { id: 'distort', icon: 'lc-distort', title: 'Remove Distortion Tool — drag towards or away from the centre', key: 'D' },
      { id: 'straighten', icon: 'lc-straighten', title: 'Straighten Tool', key: 'A' },
      { id: 'grid', icon: 'lc-grid', title: 'Move Grid Tool', key: 'M' },
      { id: 'hand', icon: 'lq-hand', title: 'Hand Tool', key: 'H' },
      { id: 'zoom', icon: 'lq-zoom', title: 'Zoom Tool', key: 'Z' },
    ],
    onTool: (id, w) => { w.view.cursor = id === 'hand' ? 'grab' : id === 'zoom' ? 'zoom-in' : id === 'grid' ? 'move' : 'crosshair'; w.view.canvas.style.cursor = w.view.cursor; if (id === 'grid') { view.grid = true; w.view.draw(); } },
  });
  ws.view.setImage(outC, pw, ph, true);
  let line: { x0: number; y0: number; x1: number; y1: number } | null = null, drag: { x: number; y: number; v: number; gx: number; gy: number } | null = null;
  ws.view.overlay = (c, v) => {
    if (view.grid) {
      c.save(); c.strokeStyle = `rgba(${view.gridColor.r},${view.gridColor.g},${view.gridColor.b},.8)`; c.lineWidth = 1;
      const st = view.gridSize * v.zoom, o = v.toScreen(view.gx % view.gridSize, view.gy % view.gridSize);
      c.beginPath();
      for (let x = o.x % st; x < c.canvas.width; x += st) { c.moveTo(Math.round(x) + 0.5, 0); c.lineTo(Math.round(x) + 0.5, c.canvas.height); }
      for (let y = o.y % st; y < c.canvas.height; y += st) { c.moveTo(0, Math.round(y) + 0.5); c.lineTo(c.canvas.width, Math.round(y) + 0.5); }
      c.stroke(); c.restore();
    }
    if (line) { const a = v.toScreen(line.x0, line.y0), b = v.toScreen(line.x1, line.y1); c.strokeStyle = '#1e8bff'; c.lineWidth = 1.5; c.beginPath(); c.moveTo(a.x, a.y); c.lineTo(b.x, b.y); c.stroke(); }
  };
  ws.view.onDown = pt => {
    if (ws.tool === 'zoom') { ws.view.zoomAt(ws.view.zoom * (pt.e.altKey ? 1 / 1.5 : 1.5), pt.sx, pt.sy); return; }
    if (ws.tool === 'straighten') line = { x0: pt.x, y0: pt.y, x1: pt.x, y1: pt.y };
    drag = { x: pt.x, y: pt.y, v: p.distortion, gx: view.gx, gy: view.gy };
  };
  ws.view.onMove = (pt, down) => {
    if (!down || !drag) return;
    if (ws.tool === 'straighten' && line) { line.x1 = pt.x; line.y1 = pt.y; ws.view.draw(); }
    else if (ws.tool === 'grid') { view.gx = drag.gx + pt.x - drag.x; view.gy = drag.gy + pt.y - drag.y; ws.view.draw(); }
    else if (ws.tool === 'distort') {
      const cx = pw / 2, cy = ph / 2, r0 = Math.hypot(drag.x - cx, drag.y - cy), r1 = Math.hypot(pt.x - cx, pt.y - cy);
      p.distortion = Math.max(-100, Math.min(100, Math.round((drag.v + ((r0 - r1) / Math.hypot(cx, cy)) * 200) * 2) / 2));
      if (auto.autoScale) p.scale = autoScale(p, src.full.width, src.full.height);
      sync(); void render();
    }
  };
  ws.view.onUp = () => {
    if (ws.tool === 'straighten' && line && Math.hypot(line.x1 - line.x0, line.y1 - line.y0) > 5) {
      let a = (Math.atan2(line.y1 - line.y0, line.x1 - line.x0) * 180) / Math.PI;
      if (a > 90) a -= 180; if (a < -90) a += 180;
      const target = Math.abs(a) > 45 ? (a > 0 ? 90 : -90) : 0;
      p.angle = Math.round((p.angle + (target - a)) * 10) / 10;
      if (auto.autoScale) p.scale = autoScale(p, src.full.width, src.full.height);
      sync(); void render();
    }
    line = null; drag = null; ws.view.draw();
  };
  void render();
  const ok = await ws.result;
  if (!ok) return;
  if (src.kind === 'smart' && src.so) putSmartFilter(src.doc, src.so, 'lens-correction', 'Lens Correction', { ...p }, existing?.index ?? -1);
  else await applyKernel(src.doc, 'Lens Correction', 'lens-correction', { ...p });
}

registerSpec({
  id: 'lens-correction', label: 'Lens Correction', category: 'Special', dialog: false, kernel: 'lens-correction', defaults: lensDefaults,
  edit: (doc: PixDocument, so: SmartObjectLayer, index: number) => { if (app.activeDoc !== doc) return; doc.setActiveLayer(so); void openLensCorrection({ so, index, params: so.smartFilters[index].params }); },
});
registerCommands([{ id: 'filter.lensCorrection', label: 'Lens Correction...', enabled: () => !!app.activeDoc, run: () => openLensCorrection() }]);
