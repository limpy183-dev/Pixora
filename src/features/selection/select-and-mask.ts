// Select and Mask workspace (Alt+Ctrl+R): full-window modal with a tool strip (Quick Selection, Refine Edge Brush,
// Brush, Object Selection, Lasso, Hand, Zoom), a live preview in 7 view modes and the Properties column
// (Edge Detection, Global Refinements, Output Settings). Editing happens on a downscaled proxy for interactivity;
// OK upsamples the refined mask and snaps it to the full-resolution image edges.
import '../../tools/selection/selection.css';
import { app } from '../../core/app';
import { PixDocument } from '../../core/document';
import { RasterLayer } from '../../core/layer';
import { Selection } from '../../core/selection';
import { createCanvas, ctx2d } from '../../core/canvas';
import type { Point } from '../../core/types';
import { h, clear } from '../../ui/dom';
import { icon } from '../../ui/icons';
import { button, checkbox, iconButton, numberField, section, select, sliderRow, toggleGroup } from '../../ui/widgets';
import { toast } from '../../ui/toast';
import { svgCursor, CURSORS } from '../../ui/cursors';
import {
  boxBlur, distanceField, gradientMagnitude, guidedFilter, quickGrow, refineEdges, resizeFloat,
} from './algo';
import { busy, commitMask, detectObject, detectSubject, makeProxy, sampleCanvas, type Proxy } from './ops';

// ------------------------------------------------------------------ output (shared with Focus Area)
export type OutputTo = 'selection' | 'mask' | 'layer' | 'layerMask' | 'doc' | 'docMask';
export const OUTPUT_OPTIONS: { value: OutputTo; label: string }[] = [
  { value: 'selection', label: 'Selection' }, { value: 'mask', label: 'Layer Mask' }, { value: 'layer', label: 'New Layer' },
  { value: 'layerMask', label: 'New Layer with Layer Mask' }, { value: 'doc', label: 'New Document' }, { value: 'docMask', label: 'New Document with Layer Mask' },
];

/** Replace colours of partially selected pixels by nearby fully selected colours (amount 0..1). Returns a new canvas. */
export function decontaminate(src: HTMLCanvasElement, alpha: Uint8Array, amount: number, radius: number): HTMLCanvasElement {
  const W = src.width, H = src.height, n = W * H;
  const img = ctx2d(src).getImageData(0, 0, W, H), d = img.data;
  const wgt = new Float32Array(n), R = new Float32Array(n), G = new Float32Array(n), B = new Float32Array(n);
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    const f = alpha[i] >= 242 && d[j + 3] > 0 ? 1 : 0;
    wgt[i] = f; R[i] = d[j] * f; G[i] = d[j + 1] * f; B[i] = d[j + 2] * f;
  }
  const r = Math.max(2, Math.round(radius));
  const bw = boxBlur(boxBlur(wgt, W, H, r), W, H, r), br = boxBlur(boxBlur(R, W, H, r), W, H, r), bg = boxBlur(boxBlur(G, W, H, r), W, H, r), bb = boxBlur(boxBlur(B, W, H, r), W, H, r);
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    const a = alpha[i];
    if (a >= 250 || a === 0 || bw[i] < 1e-4) continue;
    const k = amount * Math.min(1, (1 - a / 255) * 1.6 + 0.35);
    d[j] += (br[i] / bw[i] - d[j]) * k; d[j + 1] += (bg[i] / bw[i] - d[j + 1]) * k; d[j + 2] += (bb[i] / bw[i] - d[j + 2]) * k;
  }
  const out = createCanvas(W, H);
  ctx2d(out).putImageData(img, 0, 0);
  return out;
}

/** Send a doc-sized alpha array to the chosen output (Select and Mask / Focus Area "Output To"). */
export function outputMask(doc: PixDocument, alpha: Uint8Array, to: OutputTo, name: string, decon = 0) {
  const W = doc.width, H = doc.height;
  const maskCanvas = Selection.canvasFromAlpha(alpha, W, H);
  if (to === 'selection') { commitMask(doc, name, maskCanvas); return; }
  const layer = doc.activeLayer;
  if (!layer || !layer.getContent(doc)) { toast('The active layer has no pixels to output. Choose Output To: Selection.', 'error'); return; }
  let pixels = doc.layerAsDocCanvas(layer);
  if (decon > 0) pixels = decontaminate(pixels, alpha, decon, Math.max(4, Math.round(Math.max(W, H) / 200)));
  const maskOf = () => ({ canvas: maskCanvas, x: 0, y: 0, bg: 0 as const, enabled: true, linked: true, density: 1, feather: 0 });
  const masked = () => { const c = createCanvas(W, H), x = ctx2d(c); x.drawImage(pixels, 0, 0); x.globalCompositeOperation = 'destination-in'; x.drawImage(maskCanvas, 0, 0); return c; };
  if (to === 'doc' || to === 'docMask') {
    const nd = PixDocument.create(W, H, { name: `${doc.name.replace(/\.[^.]+$/, '')} copy`, resolution: doc.resolution, resolutionUnit: doc.resolutionUnit, background: 'transparent' });
    const l = nd.layers[0] as RasterLayer;
    ctx2d(l.canvas).drawImage(to === 'doc' ? masked() : pixels, 0, 0);
    if (to === 'docMask') l.mask = maskOf();
    nd.history.snapshots = [{ name: nd.name, state: nd.captureState(true) }];
    app.addDocument(nd);
    return;
  }
  doc.history.transaction(name, () => {
    if (to === 'mask') {
      if (layer.isBackground) { layer.isBackground = false; layer.name = 'Layer 0'; }
      if (decon > 0 && layer instanceof RasterLayer) { const c = createCanvas(W, H); ctx2d(c).drawImage(pixels, 0, 0); layer.canvas = c; layer.x = 0; layer.y = 0; }
      layer.mask = maskOf();
      doc.editMask = false;
    } else {
      const nl = new RasterLayer(W, H, `${layer.name} copy`);
      nl.canvas = to === 'layer' ? masked() : pixels;
      if (to === 'layerMask') nl.mask = maskOf();
      doc.addLayer(nl, { above: layer });
      layer.visible = false;
    }
    doc.selection.setMask(null);
  });
  doc.layersChanged();
  doc.pixelsChanged(null, null);
}

// ------------------------------------------------------------------ workspace
type ToolId = 'quick' | 'refine' | 'brush' | 'object' | 'lasso' | 'hand' | 'zoom';
type ViewMode = 'onion' | 'ants' | 'overlay' | 'black' | 'white' | 'bw' | 'layers';
const VIEW_MODES: { value: ViewMode; label: string; key: string }[] = [
  { value: 'onion', label: 'Onion Skin', key: 'O' }, { value: 'ants', label: 'Marching Ants', key: 'M' }, { value: 'overlay', label: 'Overlay', key: 'V' },
  { value: 'black', label: 'On Black', key: 'A' }, { value: 'white', label: 'On White', key: 'T' }, { value: 'bw', label: 'Black & White', key: 'K' }, { value: 'layers', label: 'On Layers', key: 'Y' },
];
const TOOLS: { id: ToolId; name: string; icon: string; key: string }[] = [
  { id: 'quick', name: 'Quick Selection Tool', icon: 'quick-select', key: 'W' },
  { id: 'refine', name: 'Refine Edge Brush Tool', icon: 'sam-refine', key: 'R' },
  { id: 'brush', name: 'Brush Tool', icon: 'brush', key: 'B' },
  { id: 'object', name: 'Object Selection Tool', icon: 'object-select', key: 'W' },
  { id: 'lasso', name: 'Lasso Tool', icon: 'lasso', key: 'L' },
  { id: 'hand', name: 'Hand Tool', icon: 'hand', key: 'H' },
  { id: 'zoom', name: 'Zoom Tool', icon: 'zoom', key: 'Z' },
];

const saved = (() => { try { return JSON.parse(localStorage.getItem('pixora.selectAndMask') || '{}'); } catch { return {}; } })();
const state = {
  view: (saved.view as ViewMode) || 'onion',
  transparency: { onion: 50, overlay: 50, black: 80, white: 80, layers: 100, ants: 0, bw: 0, ...(saved.transparency || {}) } as Record<ViewMode, number>,
  radius: 0, smart: false, smooth: 0, feather: 0, contrast: 0, shift: 0,
  decon: false, deconAmount: 100, output: 'selection' as OutputTo,
  size: saved.size || 30, sampleAll: saved.sampleAll ?? false, objectMode: 'rect' as 'rect' | 'lasso',
  remember: !!saved.remember,
};
if (state.remember && saved.params) Object.assign(state, saved.params);
function persist() {
  const p = { radius: state.radius, smart: state.smart, smooth: state.smooth, feather: state.feather, contrast: state.contrast, shift: state.shift, decon: state.decon, deconAmount: state.deconAmount, output: state.output };
  try { localStorage.setItem('pixora.selectAndMask', JSON.stringify({ view: state.view, transparency: state.transparency, size: state.size, sampleAll: state.sampleAll, remember: state.remember, params: state.remember ? p : undefined })); } catch { /* ignore */ }
}

const REFINE_ICON = '<path d="M20.5 3.5c-3.3 1.9-7.8 6.6-9.6 9l1.6 1.6c2.4-1.8 7.1-6.3 9-9.6"/><path d="M10.6 13.5c-1.6-.4-3.1.6-3.3 2.2-.2 1.2-.8 1.8-1.7 2.1 2.2 1.3 5.2.6 5.8-2"/><path d="M3 7.5c1.2-1.6 2.6-2.4 4.2-2.4M3.2 11c.9-1.1 2-1.6 3.2-1.6M5 3c1-.4 1.9-.4 2.8-.1" stroke-dasharray="1.5 1.5"/>';
import { registerIcons } from '../../ui/icons';
registerIcons({ 'sam-refine': REFINE_ICON });

export async function openSelectAndMask(doc: PixDocument): Promise<void> {
  if (!doc.activeLayer) { toast('Select a layer first.', 'error'); return; }
  const W = doc.width, H = doc.height;
  const full = { x: 0, y: 0, w: W, h: H };
  const composite = sampleCanvas(doc, true);
  const pr: Proxy = makeProxy(composite, full, 900);
  const pw = pr.w, ph = pr.h, pn = pw * ph, s = pr.scale;
  const layerProxy = state.sampleAll ? pr : makeProxy(sampleCanvas(doc, false), full, 900);
  const grad = gradientMagnitude(pr.data, pw, ph);
  let sampleData = state.sampleAll ? pr.data : layerProxy.data;
  let sampleGrad = state.sampleAll ? grad : gradientMagnitude(layerProxy.data, pw, ph);

  // editable base mask (0..1) and refine-edge region (0/1), proxy resolution
  let base: Float32Array = new Float32Array(pn);
  const loadMask = (c: HTMLCanvasElement | null) => {
    base = new Float32Array(pn);
    if (!c) return;
    const t = createCanvas(pw, ph), x = ctx2d(t);
    x.imageSmoothingQuality = 'high';
    x.drawImage(c, 0, 0, pw, ph);
    const d = x.getImageData(0, 0, pw, ph).data;
    for (let i = 0; i < pn; i++) base[i] = d[i * 4 + 3] / 255;
  };
  loadMask(doc.selection.mask);
  const refineRegion = new Uint8Array(pn);
  let baseVersion = 1;
  const undo: { base: Float32Array; refine: Uint8Array }[] = [];
  const pushUndo = () => { undo.push({ base: base.slice(), refine: refineRegion.slice() }); if (undo.length > 30) undo.shift(); };

  // ---------------------------------------------------------------- refinement pipeline (proxy)
  let guidedCache: { key: string; q: Float32Array } | null = null;
  let band: Uint8Array = new Uint8Array(pn);
  function refine(): Float32Array {
    const R = state.radius * s;
    let m: Float32Array = base;
    band = new Uint8Array(pn);
    let anyRefine = false;
    for (let i = 0; i < pn; i++) if (refineRegion[i]) { anyRefine = true; break; }
    if (R >= 0.5 || anyRefine) {
      // band around the 50% contour (+ Refine Edge brush strokes)
      if (R >= 0.5) {
        const edge = new Uint8Array(pn);
        for (let y = 0; y < ph; y++) for (let x = 0; x < pw; x++) {
          const i = y * pw + x, a = base[i] >= 0.5;
          if ((x < pw - 1 && (base[i + 1] >= 0.5) !== a) || (y < ph - 1 && (base[i + pw] >= 0.5) !== a) || (base[i] > 0.02 && base[i] < 0.98)) edge[i] = 1;
        }
        const df = distanceField(edge, pw, ph);
        for (let i = 0; i < pn; i++) {
          const rr = state.smart ? R * (1 - Math.min(0.85, grad[i] * 3)) : R;
          if (df[i] <= rr * rr) band[i] = 1;
        }
      }
      for (let i = 0; i < pn; i++) if (refineRegion[i]) band[i] = 1;
      const gr = Math.max(2, Math.min(24, Math.round(Math.max(R * 0.6, anyRefine ? 8 * s + 3 : 0))));
      const eps = state.smart ? 4e-4 : 1.2e-3;
      const key = `${baseVersion}:${gr}:${eps}`;
      if (!guidedCache || guidedCache.key !== key) guidedCache = { key, q: guidedFilter(sampleData, base, pw, ph, gr, eps) };
      const q = guidedCache.q;
      m = base.slice();
      for (let i = 0; i < pn; i++) if (band[i]) m[i] = q[i];
    }
    // Smooth: blur + re-threshold keeps hard contours but removes jaggies
    if (state.smooth > 0) {
      const r = Math.max(1, Math.round(state.smooth / 100 * 10 * s + 0.5));
      const b = boxBlur(boxBlur(m, pw, ph, r), pw, ph, r);
      const k = 2 + 60 / (1 + state.smooth / 10);
      const o = new Float32Array(pn);
      for (let i = 0; i < pn; i++) { const soft = m[i] > 0.02 && m[i] < 0.98; const v = soft ? b[i] : (b[i] - 0.5) * k + 0.5; o[i] = v < 0 ? 0 : v > 1 ? 1 : v; }
      m = o;
    }
    // Shift Edge: move the contour in/out (blur + shifted threshold)
    if (state.shift) {
      const px = Math.max(1, (Math.abs(state.shift) / 100) * (8 + state.radius + state.feather) * s);
      const r = Math.max(1, Math.round(px));
      const b = boxBlur(boxBlur(m, pw, ph, r), pw, ph, r);
      const t = 0.5 - Math.sign(state.shift) * Math.min(0.45, px / (2 * r + 1));
      const o = new Float32Array(pn);
      for (let i = 0; i < pn; i++) { const v = (b[i] - t) * 4 + 0.5; o[i] = v < 0 ? 0 : v > 1 ? 1 : v; }
      for (let i = 0; i < pn; i++) o[i] = state.shift > 0 ? Math.max(o[i], m[i]) : Math.min(o[i], m[i]);
      m = o;
    }
    if (state.feather > 0) {
      const r = Math.max(1, Math.round(state.feather * s * 0.58));
      m = boxBlur(boxBlur(boxBlur(m, pw, ph, r), pw, ph, r), pw, ph, r);
    }
    if (state.contrast > 0) {
      const k = state.contrast >= 100 ? 1e4 : 1 / (1 - state.contrast / 100);
      const o = new Float32Array(pn);
      for (let i = 0; i < pn; i++) { const v = (m[i] - 0.5) * k + 0.5; o[i] = v < 0 ? 0 : v > 1 ? 1 : v; }
      m = o;
    }
    return m;
  }

  // ---------------------------------------------------------------- DOM
  let tool: ToolId = 'quick';
  let subtract = false;
  let showEdge = false, showOriginal = false;
  let result = refine();
  const stage = h('div.sam-stage');
  const cv = h('canvas') as HTMLCanvasElement;
  stage.append(cv);
  const disp = createCanvas(pw, ph), dx = ctx2d(disp);
  const view = { zoom: 1, panX: 0, panY: 0, fitted: true };
  const toolBtns = new Map<ToolId, HTMLButtonElement>();
  const toolStrip = h('div.sam-tools');
  for (const t of TOOLS) {
    const b = iconButton(t.icon, `${t.name} (${t.key})`, () => setTool(t.id), { size: 20 });
    toolBtns.set(t.id, b); toolStrip.append(b);
  }
  const optsBox = h('span', { style: { display: 'flex', alignItems: 'center', gap: '8px' } });
  const bar = h('div.sam-bar', null, h('span.sam-title', null, 'Select and Mask'), optsBox);
  const props = h('div.sam-props');
  const overlay = h('div.sam-overlay', null, bar, toolStrip, stage, props);

  // ---------------------------------------------------------------- properties column
  const transp = sliderRow('Transparency', state.transparency[state.view], 0, 100, v => { state.transparency[state.view] = v; renderDisplay(); }, { unit: '%' });
  const viewSel = select(VIEW_MODES.map(v => ({ value: v.value, label: `${v.label} (${v.key})` })), state.view, v => setView(v), { width: 170, title: 'View mode (F cycles)' });
  const edgeBox = checkbox('Show Edge (J)', false, v => { showEdge = v; renderDisplay(); });
  const origBox = checkbox('Show Original (P)', false, v => { showOriginal = v; renderDisplay(); });
  const viewSec = section('View Mode', h('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px' } },
    h('div.form-row', null, h('label.form-label', null, 'View:'), viewSel), edgeBox, origBox, transp));
  const subjBtn = button('Select Subject', () => void selectSubject(), { title: 'Select the most prominent subject' });
  const radius = sliderRow('Radius', state.radius, 0, 250, (v, fin) => { state.radius = v; schedule(fin); }, { unit: 'px' });
  const smart = checkbox('Smart Radius', state.smart, v => { state.smart = v; schedule(true); }, { title: 'Adapt the radius to hard and soft edges' });
  const edgeSec = section('Edge Detection', h('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px' } }, radius, smart));
  const smooth = sliderRow('Smooth', state.smooth, 0, 100, (v, fin) => { state.smooth = v; schedule(fin); });
  const feather = sliderRow('Feather', state.feather, 0, 250, (v, fin) => { state.feather = v; schedule(fin); }, { unit: 'px', decimals: 1 });
  const contrast = sliderRow('Contrast', state.contrast, 0, 100, (v, fin) => { state.contrast = v; schedule(fin); }, { unit: '%' });
  const shift = sliderRow('Shift Edge', state.shift, -100, 100, (v, fin) => { state.shift = v; schedule(fin); }, { unit: '%', center: 0 });
  const clearBtn = button('Clear Selection', () => { pushUndo(); base = new Float32Array(pn); refineRegion.fill(0); changed(); }, { title: 'Clear the selection' });
  const invBtn = button('Invert', () => { pushUndo(); for (let i = 0; i < pn; i++) base[i] = 1 - base[i]; changed(); }, { title: 'Invert the selection' });
  const globalSec = section('Global Refinements', h('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px' } }, smooth, feather, contrast, shift, h('div', { style: { display: 'flex', gap: '6px' } }, clearBtn, invBtn)));
  const deconAmt = sliderRow('Amount', state.deconAmount, 0, 100, v => { state.deconAmount = v; }, { unit: '%' });
  const outputSel = select(OUTPUT_OPTIONS.map(o => ({ ...o, disabled: false })), state.output, v => { state.output = v; }, { width: 190 });
  const deconBox = checkbox('Decontaminate Colors', state.decon, v => {
    state.decon = v; deconAmt.classList.toggle('cr-dim', !v);
    if (v && (state.output === 'selection' || state.output === 'mask')) { state.output = 'layerMask'; outputSel.setValue('layerMask'); }
  }, { title: 'Replace colour fringes with nearby fully selected colours (outputs to a new layer)' });
  deconAmt.classList.toggle('cr-dim', !state.decon);
  const remember = checkbox('Remember Settings', state.remember, v => { state.remember = v; });
  const outSec = section('Output Settings', h('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px' } }, deconBox, deconAmt, h('div.form-row', null, h('label.form-label', null, 'Output To:'), outputSel), remember));
  const okBtn = button('OK', () => void finish(true), { primary: true, title: 'Apply (Enter)' });
  const cancelBtn = button('Cancel', () => void finish(false), { title: 'Cancel (Esc)' });
  const resetBtn = iconButton('reset', 'Reset the workspace', () => {
    Object.assign(state, { radius: 0, smart: false, smooth: 0, feather: 0, contrast: 0, shift: 0 });
    radius.setValue(0); smart.setValue(false); smooth.setValue(0); feather.setValue(0); contrast.setValue(0); shift.setValue(0);
    pushUndo(); loadMask(doc.selection.mask); refineRegion.fill(0); changed();
  });
  props.append(h('div', { style: { padding: '8px 12px', display: 'flex', gap: '6px', alignItems: 'center' } }, subjBtn, h('span', { style: { flex: '1' } }), resetBtn), viewSec, edgeSec, globalSec, outSec, h('div.sam-buttons', null, okBtn, cancelBtn));

  // ---------------------------------------------------------------- options bar per tool
  function buildOptions() {
    clear(optsBox);
    if (tool === 'quick' || tool === 'refine' || tool === 'brush' || tool === 'object' || tool === 'lasso') {
      const ops = toggleGroup([{ value: false, icon: 'sel-add', title: 'Add to selection' }, { value: true, icon: 'sel-subtract', title: 'Subtract from selection (Alt)' }], subtract, v => { subtract = v; });
      optsBox.append(ops);
    }
    if (tool === 'quick' || tool === 'refine' || tool === 'brush') {
      optsBox.append(numberField(state.size, v => { state.size = v; drawStage(); }, { min: 1, max: 2000, unit: 'px', width: 60, label: 'Size:', title: 'Brush size ([ and ])' }));
    }
    if (tool === 'quick' || tool === 'object') {
      optsBox.append(checkbox('Sample All Layers', state.sampleAll, v => {
        state.sampleAll = v;
        sampleData = v ? pr.data : layerProxy.data; sampleGrad = v ? grad : gradientMagnitude(layerProxy.data, pw, ph); guidedCache = null;
      }));
    }
    if (tool === 'object') optsBox.append(select([{ value: 'rect', label: 'Rectangle' }, { value: 'lasso', label: 'Lasso' }], state.objectMode, v => { state.objectMode = v as 'rect' | 'lasso'; }, { width: 100, title: 'Object finder mode' }));
    if (tool === 'refine') optsBox.append(h('span.sam-hint', null, 'Paint over soft edges such as hair or fur to refine them.'));
    if (tool === 'hand' || tool === 'zoom') optsBox.append(button('Fit Screen', () => fit(), { title: 'Fit the image in the window' }), button('100%', () => { setZoom(1 / s); }, { title: 'Actual pixels' }));
  }
  function setTool(t: ToolId) { tool = t; toolBtns.forEach((b, id) => b.classList.toggle('active', id === t)); buildOptions(); updateCursor(); drawStage(); }
  function setView(v: ViewMode) { state.view = v; viewSel.setValue(v); transp.setValue(state.transparency[v]); transp.classList.toggle('cr-dim', v === 'ants' || v === 'bw'); renderDisplay(); }

  // ---------------------------------------------------------------- rendering
  let raf = 0, heavyTimer = 0;
  function changed() { baseVersion++; guidedCache = null; schedule(true); }
  function schedule(final: boolean) {
    // cheap refinements update live; the guided filter pass is throttled
    clearTimeout(heavyTimer);
    const run = () => { result = refine(); renderDisplay(); };
    if (final || !(state.radius > 0)) { if (!raf) raf = requestAnimationFrame(() => { raf = 0; run(); }); }
    else heavyTimer = window.setTimeout(run, 60);
  }
  let antsPath: Path2D | null = null;
  function renderDisplay() {
    const img = dx.createImageData(pw, ph), o = img.data, src = pr.data;
    const t = state.transparency[state.view] / 100;
    const mode = state.view;
    antsPath = null;
    for (let i = 0, j = 0; i < pn; i++, j += 4) {
      let a = showOriginal ? 1 : result[i];
      if (showEdge && !showOriginal) a = band[i] ? a : 0;
      const r = src[j], g = src[j + 1], b = src[j + 2];
      switch (showOriginal ? 'layers' : mode) {
        case 'bw': { const v = Math.round(a * 255); o[j] = o[j + 1] = o[j + 2] = v; o[j + 3] = 255; break; }
        case 'overlay': { const k = (1 - a) * t; o[j] = r + (255 - r) * k; o[j + 1] = g * (1 - k); o[j + 2] = b * (1 - k); o[j + 3] = 255; break; }
        case 'black': case 'white': {
          const aa = a + (1 - a) * (1 - t), bg = mode === 'white' ? 255 : 0;
          o[j] = r * aa + bg * (1 - aa); o[j + 1] = g * aa + bg * (1 - aa); o[j + 2] = b * aa + bg * (1 - aa); o[j + 3] = 255; break;
        }
        case 'ants': o[j] = r; o[j + 1] = g; o[j + 2] = b; o[j + 3] = 255; break;
        case 'onion': o[j] = r; o[j + 1] = g; o[j + 2] = b; o[j + 3] = (a + (1 - a) * (1 - t)) * src[j + 3]; break;
        default: o[j] = r; o[j + 1] = g; o[j + 2] = b; o[j + 3] = a * src[j + 3]; break;
      }
    }
    dx.putImageData(img, 0, 0);
    if (mode === 'ants' && !showOriginal) {
      const m = new Uint8Array(pn);
      for (let i = 0; i < pn; i++) m[i] = result[i] >= 0.5 ? 255 : 0;
      const stub: any = { width: pw, height: ph, selectionChanged() {}, lastSelection: null };
      const sel = new Selection(stub);
      sel.setMask(Selection.canvasFromAlpha(m, pw, ph));
      antsPath = sel.outline();
    }
    drawStage();
  }
  let antsPhase = 0;
  const antsTimer = window.setInterval(() => { if (state.view === 'ants' && antsPath) { antsPhase = (antsPhase + 1) % 8; drawStage(); } }, 110);
  const pointer = { x: 0, y: 0, inside: false };
  let lassoPts: Point[] | null = null;
  let objRect: { x0: number; y0: number; x1: number; y1: number } | null = null;
  function drawStage() {
    const dpr = window.devicePixelRatio || 1;
    const r = stage.getBoundingClientRect();
    const cw = Math.max(1, Math.round(r.width * dpr)), chh = Math.max(1, Math.round(r.height * dpr));
    if (cv.width !== cw || cv.height !== chh) { cv.width = cw; cv.height = chh; if (view.fitted) fit(false); }
    const x = ctx2d(cv);
    x.setTransform(1, 0, 0, 1, 0, 0);
    x.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--pasteboard').trim() || '#282828';
    x.fillRect(0, 0, cw, chh);
    x.setTransform(dpr * view.zoom, 0, 0, dpr * view.zoom, dpr * view.panX, dpr * view.panY);
    if (state.view === 'onion' || state.view === 'layers' || showOriginal) {
      const pat = x.createPattern(checker(), 'repeat')!;
      pat.setTransform(new DOMMatrix().scale(1 / view.zoom));
      x.fillStyle = pat; x.fillRect(0, 0, pw, ph);
    }
    x.imageSmoothingEnabled = view.zoom < 2;
    x.drawImage(disp, 0, 0);
    if (antsPath) {
      const px = 1 / view.zoom;
      x.lineWidth = px; x.strokeStyle = '#fff'; x.setLineDash([]); x.stroke(antsPath);
      x.strokeStyle = '#000'; x.setLineDash([4 * px, 4 * px]); x.lineDashOffset = -antsPhase * px; x.stroke(antsPath); x.setLineDash([]);
    }
    const px = 1 / view.zoom;
    if (lassoPts && lassoPts.length > 1) {
      x.beginPath(); lassoPts.forEach((p, i) => (i ? x.lineTo(p.x, p.y) : x.moveTo(p.x, p.y)));
      x.lineWidth = 2 * px; x.strokeStyle = '#fff'; x.stroke(); x.lineWidth = px; x.strokeStyle = '#000'; x.stroke();
    }
    if (objRect) {
      x.lineWidth = px; x.strokeStyle = '#fff'; x.setLineDash([]);
      x.strokeRect(Math.min(objRect.x0, objRect.x1), Math.min(objRect.y0, objRect.y1), Math.abs(objRect.x1 - objRect.x0), Math.abs(objRect.y1 - objRect.y0));
      x.strokeStyle = '#000'; x.setLineDash([4 * px, 4 * px]);
      x.strokeRect(Math.min(objRect.x0, objRect.x1), Math.min(objRect.y0, objRect.y1), Math.abs(objRect.x1 - objRect.x0), Math.abs(objRect.y1 - objRect.y0));
      x.setLineDash([]);
    }
    // brush cursor
    if (pointer.inside && (tool === 'quick' || tool === 'refine' || tool === 'brush')) {
      const rr = (state.size * s) / 2;
      x.beginPath(); x.arc(pointer.x, pointer.y, rr, 0, Math.PI * 2);
      x.lineWidth = 1.6 * px; x.strokeStyle = 'rgba(0,0,0,.7)'; x.stroke();
      x.lineWidth = px; x.strokeStyle = 'rgba(255,255,255,.9)'; x.stroke();
      const sign = subtract ? '−' : '+';
      x.setTransform(dpr, 0, 0, dpr, 0, 0);
      const sp = toScreen(pointer.x, pointer.y);
      x.font = '12px system-ui'; x.fillStyle = '#fff'; x.fillText(tool === 'refine' ? '' : sign, sp.x - 3, sp.y + 4);
    }
  }
  let checkerCanvas: HTMLCanvasElement | null = null;
  function checker() {
    if (checkerCanvas) return checkerCanvas;
    const c = createCanvas(16, 16), x = ctx2d(c);
    x.fillStyle = '#fff'; x.fillRect(0, 0, 16, 16); x.fillStyle = '#ccc'; x.fillRect(8, 0, 8, 8); x.fillRect(0, 8, 8, 8);
    return (checkerCanvas = c);
  }
  function fit(redraw = true) {
    const r = stage.getBoundingClientRect();
    const z = Math.min((r.width - 60) / pw, (r.height - 60) / ph);
    view.zoom = Math.max(0.02, z); view.panX = (r.width - pw * view.zoom) / 2; view.panY = (r.height - ph * view.zoom) / 2; view.fitted = true;
    if (redraw) drawStage();
  }
  function setZoom(z: number, ax?: number, ay?: number) {
    const r = stage.getBoundingClientRect();
    ax ??= r.width / 2; ay ??= r.height / 2;
    const p = toProxy(ax, ay);
    view.zoom = Math.max(0.02, Math.min(32 / s, z));
    view.panX = ax - p.x * view.zoom; view.panY = ay - p.y * view.zoom; view.fitted = false;
    drawStage();
  }
  const toProxy = (sx: number, sy: number) => ({ x: (sx - view.panX) / view.zoom, y: (sy - view.panY) / view.zoom });
  const toScreen = (x: number, y: number) => ({ x: x * view.zoom + view.panX, y: y * view.zoom + view.panY });

  // ---------------------------------------------------------------- editing
  function dab(cx: number, cy: number, sub: boolean, target: 'base' | 'refine') {
    const r = Math.max(0.5, (state.size * s) / 2);
    const x0 = Math.max(0, Math.floor(cx - r)), x1 = Math.min(pw - 1, Math.ceil(cx + r)), y0 = Math.max(0, Math.floor(cy - r)), y1 = Math.min(ph - 1, Math.ceil(cy + r));
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
      if (d > r + 0.5) continue;
      const i = y * pw + x, a = Math.min(1, r + 0.5 - d);
      if (target === 'refine') refineRegion[i] = sub ? 0 : 1;
      else base[i] = sub ? Math.min(base[i], 1 - a) : Math.max(base[i], a);
    }
  }
  function quickDab(cx: number, cy: number, sub: boolean) {
    const r = Math.max(1, (state.size * s) / 2);
    const g = quickGrow(sampleData, sampleGrad, pw, ph, cx, cy, r, r * 4 + 12);
    if (!g) return;
    for (let y = 0; y < g.h; y++) for (let x = 0; x < g.w; x++) {
      const v = g.mask[y * g.w + x] / 255;
      if (!v) continue;
      const i = (y + g.y) * pw + x + g.x;
      base[i] = sub ? Math.min(base[i], 1 - v) : Math.max(base[i], v);
    }
  }
  async function selectSubject() {
    const m = await busy('Selecting subject…', () => detectSubject(doc, true));
    if (!m) { toast('No subject was found in the image.'); return; }
    pushUndo();
    loadMask(Selection.canvasFromAlpha(m, W, H));
    changed();
  }
  async function objectSelect(rect: { x: number; y: number; w: number; h: number }, poly?: Point[]) {
    const docRect = { x: rect.x / s, y: rect.y / s, w: rect.w / s, h: rect.h / s };
    const m = await busy('Object Selection…', () => detectObject(doc, { rect: docRect, poly: poly?.map(p => ({ x: p.x / s, y: p.y / s })) }, state.sampleAll));
    if (!m) { toast('No object was found in the region.'); return; }
    const t = createCanvas(pw, ph), x = ctx2d(t);
    x.drawImage(Selection.canvasFromAlpha(m, W, H), 0, 0, pw, ph);
    const d = x.getImageData(0, 0, pw, ph).data;
    pushUndo();
    for (let i = 0; i < pn; i++) { const v = d[i * 4 + 3] / 255; base[i] = subtract ? Math.min(base[i], 1 - v) : Math.max(base[i], v); }
    changed();
  }
  function fillPoly(pts: Point[], sub: boolean) {
    if (pts.length < 3) return;
    const t = createCanvas(pw, ph), x = ctx2d(t);
    x.beginPath(); pts.forEach((p, i) => (i ? x.lineTo(p.x, p.y) : x.moveTo(p.x, p.y))); x.closePath(); x.fill();
    const d = x.getImageData(0, 0, pw, ph).data;
    for (let i = 0; i < pn; i++) { const v = d[i * 4 + 3] / 255; if (v) base[i] = sub ? Math.min(base[i], 1 - v) : Math.max(base[i], v); }
  }

  let space = false, alt = false;
  const effTool = (): ToolId => (space ? 'hand' : tool);
  const cursors: Partial<Record<ToolId, string>> = { hand: CURSORS.hand, zoom: CURSORS.zoomIn, object: CURSORS.crosshair, lasso: svgCursor('<path d="M12 3.5c4.8 0 8.6 2.4 8.6 5.4s-3.8 5.4-8.6 5.4-8.6-2.4-8.6-5.4S7.2 3.5 12 3.5z"/><path d="M7.6 13.4c-1 1.6-.4 3.3 1.5 3.7 1.6.3 2 1.9 1.1 3.7"/>', 10, 21, 'crosshair') };
  function updateCursor() { cv.style.cursor = cursors[effTool()] || 'none'; }
  let drag: { tool: ToolId; lx: number; ly: number; sx: number; sy: number; sub: boolean } | null = null;
  cv.addEventListener('pointerdown', e => {
    if (e.button !== 0) return;
    cv.setPointerCapture(e.pointerId);
    const r = cv.getBoundingClientRect(), sx = e.clientX - r.left, sy = e.clientY - r.top, p = toProxy(sx, sy);
    const t = effTool();
    const sub = subtract !== e.altKey;
    drag = { tool: t, lx: p.x, ly: p.y, sx, sy, sub };
    if (t === 'zoom') { setZoom(view.zoom * (e.altKey ? 0.5 : 2), sx, sy); drag = null; return; }
    if (t === 'quick' || t === 'brush' || t === 'refine') {
      pushUndo();
      if (t === 'quick') quickDab(p.x, p.y, sub); else dab(p.x, p.y, sub, t === 'refine' ? 'refine' : 'base');
      if (t === 'refine') { showEdge = true; edgeBox.setValue(true); }
      changed();
    }
    if (t === 'lasso' || (t === 'object' && state.objectMode === 'lasso')) lassoPts = [p];
    if (t === 'object' && state.objectMode === 'rect') objRect = { x0: p.x, y0: p.y, x1: p.x, y1: p.y };
  });
  cv.addEventListener('pointermove', e => {
    const r = cv.getBoundingClientRect(), sx = e.clientX - r.left, sy = e.clientY - r.top, p = toProxy(sx, sy);
    pointer.x = p.x; pointer.y = p.y; pointer.inside = true;
    const d = drag;
    if (!d) { drawStage(); return; }
    if (d.tool === 'hand') { view.panX += sx - d.sx; view.panY += sy - d.sy; view.fitted = false; d.sx = sx; d.sy = sy; drawStage(); return; }
    if (d.tool === 'quick' || d.tool === 'brush' || d.tool === 'refine') {
      const dist = Math.hypot(p.x - d.lx, p.y - d.ly), step = Math.max(1, (state.size * s) / (d.tool === 'quick' ? 2 : 4));
      if (dist >= step) {
        const n = Math.ceil(dist / step);
        for (let k = 1; k <= n; k++) {
          const x = d.lx + (p.x - d.lx) * k / n, y = d.ly + (p.y - d.ly) * k / n;
          if (d.tool === 'quick') quickDab(x, y, d.sub); else dab(x, y, d.sub, d.tool === 'refine' ? 'refine' : 'base');
        }
        d.lx = p.x; d.ly = p.y;
        if (d.tool === 'refine') { renderBandOnly(); } else { baseVersion++; guidedCache = null; result = state.radius > 0 ? result : refine(); if (state.radius > 0) schedule(false); else renderDisplay(); }
      } else drawStage();
      return;
    }
    if (lassoPts) { lassoPts.push(p); drawStage(); return; }
    if (objRect) { objRect.x1 = p.x; objRect.y1 = p.y; drawStage(); }
  });
  function renderBandOnly() { for (let i = 0; i < pn; i++) if (refineRegion[i]) band[i] = 1; renderDisplay(); }
  const up = (e: PointerEvent) => {
    const d = drag; drag = null;
    if (!d) return;
    try { cv.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
    if (d.tool === 'quick' || d.tool === 'brush' || d.tool === 'refine') { changed(); return; }
    if (lassoPts) {
      const pts = lassoPts; lassoPts = null;
      if (d.tool === 'object') {
        const xs = pts.map(p => p.x), ys = pts.map(p => p.y), x0 = Math.min(...xs), y0 = Math.min(...ys);
        void objectSelect({ x: x0, y: y0, w: Math.max(...xs) - x0, h: Math.max(...ys) - y0 }, pts);
      } else { pushUndo(); fillPoly(pts, d.sub); changed(); }
      drawStage(); return;
    }
    if (objRect) {
      const o = objRect; objRect = null;
      const rect = { x: Math.min(o.x0, o.x1), y: Math.min(o.y0, o.y1), w: Math.abs(o.x1 - o.x0), h: Math.abs(o.y1 - o.y0) };
      if (rect.w * view.zoom > 4 && rect.h * view.zoom > 4) void objectSelect(rect);
      drawStage();
    }
  };
  cv.addEventListener('pointerup', up);
  cv.addEventListener('pointercancel', up);
  cv.addEventListener('pointerleave', () => { pointer.inside = false; drawStage(); });
  cv.addEventListener('wheel', e => {
    e.preventDefault();
    const r = cv.getBoundingClientRect();
    if (e.ctrlKey || e.altKey) setZoom(view.zoom * Math.exp(-e.deltaY * 0.0025), e.clientX - r.left, e.clientY - r.top);
    else { view.panX -= e.shiftKey ? e.deltaY : e.deltaX; view.panY -= e.shiftKey ? 0 : e.deltaY; view.fitted = false; drawStage(); }
  }, { passive: false });

  // ---------------------------------------------------------------- keyboard (workspace owns all keys while open)
  let resolveDone!: () => void;
  const done = new Promise<void>(r => (resolveDone = r));
  const onKey = (e: KeyboardEvent) => {
    const typing = (e.target as HTMLElement)?.matches?.('input[type=text], input.field, textarea');
    e.stopPropagation();
    if (typing) { if (e.key === 'Escape') (e.target as HTMLElement).blur(); return; }
    if (document.querySelector('.menu')) return; // dropdown open (select widgets)
    alt = e.altKey;
    if (e.code === 'Space') { e.preventDefault(); if (!space) { space = true; updateCursor(); } return; }
    if (e.key === 'Escape') { e.preventDefault(); void finish(false); return; }
    if (e.key === 'Enter') { e.preventDefault(); void finish(true); return; }
    if ((e.ctrlKey || e.metaKey) && e.code === 'KeyZ') { e.preventDefault(); const u = undo.pop(); if (u) { base = u.base; refineRegion.set(u.refine); changed(); } return; }
    if ((e.ctrlKey || e.metaKey) && (e.code === 'Digit0')) { e.preventDefault(); fit(); return; }
    if ((e.ctrlKey || e.metaKey) && (e.code === 'Equal' || e.code === 'Minus')) { e.preventDefault(); setZoom(view.zoom * (e.code === 'Equal' ? 1.5 : 1 / 1.5)); return; }
    if (e.ctrlKey || e.metaKey) return;
    const k = e.code.startsWith('Key') ? e.code.slice(3) : '';
    if (e.code === 'BracketLeft' || e.code === 'BracketRight') {
      e.preventDefault();
      const v = state.size, st = v < 10 ? 1 : v < 50 ? 5 : v < 100 ? 10 : 25;
      state.size = Math.max(1, Math.min(2000, v + (e.code === 'BracketRight' ? st : -st)));
      buildOptions(); drawStage(); return;
    }
    if (k === 'W') { e.preventDefault(); setTool(e.shiftKey ? (tool === 'quick' ? 'object' : 'quick') : tool === 'object' ? 'object' : 'quick'); return; }
    const t = TOOLS.find(x => x.key === k);
    if (t) { e.preventDefault(); setTool(t.id); return; }
    const vm = VIEW_MODES.find(v => v.key === k);
    if (vm) { e.preventDefault(); setView(vm.value); return; }
    if (k === 'F') { e.preventDefault(); const i = VIEW_MODES.findIndex(v => v.value === state.view); setView(VIEW_MODES[(i + (e.shiftKey ? VIEW_MODES.length - 1 : 1)) % VIEW_MODES.length].value); return; }
    if (k === 'J') { e.preventDefault(); showEdge = !showEdge; edgeBox.setValue(showEdge); renderDisplay(); return; }
    if (k === 'P') { e.preventDefault(); showOriginal = !showOriginal; origBox.setValue(showOriginal); renderDisplay(); return; }
    if (k === 'X') { e.preventDefault(); showOriginal = true; renderDisplay(); return; }
  };
  const onKeyUp = (e: KeyboardEvent) => {
    e.stopPropagation();
    alt = e.altKey;
    if (e.code === 'Space') { space = false; updateCursor(); }
    if (e.code === 'KeyX' && showOriginal && !origBox.getValue()) { showOriginal = false; renderDisplay(); }
  };
  window.addEventListener('keydown', onKey, true);
  window.addEventListener('keyup', onKeyUp, true);
  const ro = new ResizeObserver(() => { if (view.fitted) fit(false); drawStage(); });

  async function finish(ok: boolean) {
    window.removeEventListener('keydown', onKey, true);
    window.removeEventListener('keyup', onKeyUp, true);
    clearInterval(antsTimer); ro.disconnect();
    persist();
    if (ok) {
      const out = await busy('Select and Mask…', () => {
        const m = refine();
        const img = ctx2d(composite).getImageData(0, 0, W, H);
        let fullM: Float32Array = s < 0.999 ? resizeFloat(m, pw, ph, W, H) : m;
        if (s < 0.999) fullM = refineEdges(img.data, W, H, fullM, Math.max(2, Math.min(10, Math.round(1.5 / s))), state.contrast >= 60 ? 1e-4 : 1.5e-3);
        const a = new Uint8Array(W * H);
        const hard = state.contrast >= 100;
        for (let i = 0; i < a.length; i++) { const v = fullM[i]; a[i] = hard ? (v >= 0.5 ? 255 : 0) : v <= 0 ? 0 : v >= 1 ? 255 : Math.round(v * 255); }
        return a;
      });
      overlay.remove();
      outputMask(doc, out, state.output, 'Select and Mask', state.decon ? state.deconAmount / 100 : 0);
    } else overlay.remove();
    resolveDone();
  }

  document.body.append(overlay);
  ro.observe(stage);
  setTool('quick');
  setView(state.view);
  fit();
  renderDisplay();
  void alt;
  return done;
}
