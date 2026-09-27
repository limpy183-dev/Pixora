// Eyedropper (I) and Color Sampler tools. Samplers live in doc.extra.samplers and are read out by the Info panel.
import { app, type Tool, type ToolPointer } from '../../core/app';
import type { PixDocument } from '../../core/document';
import { events } from '../../core/events';
import { viewportHooks, viewOptions, type Viewport } from '../../core/viewport';
import { toCss, toHex } from '../../core/color';
import type { RGB } from '../../core/types';
import { checkbox, select, separator, button, label } from '../../ui/widgets';
import { openMenu, type MenuEntry } from '../../ui/menu';
import { CURSORS } from '../../ui/cursors';
import { toast } from '../../ui/toast';
import { SAMPLE_MODES, SAMPLE_SIZES, sampleColor, measureEvents, type SampleMode } from './common';

// ------------------------------------------------------------------ Eyedropper
const eyeSettings = { size: 1, sample: 'all' as SampleMode, showRing: true };
let pick: { before: RGB; now: RGB | null; target: 'fg' | 'bg' } | null = null;

/** Sample with the eyedropper settings (also used by the Info panel). */
export const eyedropperSample = (doc: PixDocument, x: number, y: number) => sampleColor(doc, x, y, eyeSettings.size, eyeSettings.sample);
export const eyedropperSettings = eyeSettings;

function applyPick(doc: PixDocument, p: ToolPointer, final: boolean) {
  if (!pick) return;
  const c = eyedropperSample(doc, p.x, p.y);
  if (!c) return;
  pick.now = { r: c.r, g: c.g, b: c.b };
  if (final) {
    if (pick.target === 'bg') app.setBackground(pick.now); else app.setForeground(pick.now);
  } else {
    // live update without spamming the recent-colours list
    if (pick.target === 'bg') app.bg = pick.now; else app.fg = pick.now;
    events.emit('colors');
  }
}

function drawRing(ctx: CanvasRenderingContext2D, view: Viewport) {
  if (!pick || !pick.now) return;
  const { sx, sy } = view.pointer;
  ctx.save();
  ctx.translate(sx, sy);
  // outer neutral grey ring
  ctx.lineWidth = 7;
  ctx.strokeStyle = '#8a8a8a';
  ctx.beginPath(); ctx.arc(0, 0, 62, 0, Math.PI * 2); ctx.stroke();
  // new colour on top, previous colour on the bottom
  ctx.lineWidth = 22;
  ctx.strokeStyle = toCss(pick.now);
  ctx.beginPath(); ctx.arc(0, 0, 48, Math.PI, Math.PI * 2); ctx.stroke();
  ctx.strokeStyle = toCss(pick.before);
  ctx.beginPath(); ctx.arc(0, 0, 48, 0, Math.PI); ctx.stroke();
  ctx.lineWidth = 1;
  ctx.strokeStyle = 'rgba(0,0,0,.55)';
  for (const r of [37, 59, 65.5]) { ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI * 2); ctx.stroke(); }
  ctx.restore();
}

function copyColorMenu(c: RGB, asHtml: boolean) {
  const hex = toHex(c);
  const text = asHtml ? `color="#${hex}"` : hex;
  navigator.clipboard?.writeText(text).then(() => toast(`Copied ${text}`, 'success'), () => toast('Could not access the clipboard.', 'error'));
}

async function sampleScreen() {
  const ED = (window as any).EyeDropper;
  if (!ED) { toast('Sampling from the screen is not supported by this browser.', 'error'); return; }
  try {
    const r = await new ED().open();
    const n = parseInt(String(r.sRGBHex).slice(1), 16);
    app.setForeground({ r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 });
  } catch { /* cancelled */ }
}

const eyedropper: Tool = {
  id: 'eyedropper', name: 'Eyedropper Tool', group: 'eyedropper', icon: 'eyedropper', shortcut: 'I', order: 0,
  settings: eyeSettings,
  cursor: CURSORS.eyedropper,
  noCtrlMove: false,
  options(bar) {
    const size = select(SAMPLE_SIZES, eyeSettings.size, v => { eyeSettings.size = v; app.saveToolSettings(eyedropper); }, { width: 150, title: 'Sample Size' });
    const sample = select(SAMPLE_MODES, eyeSettings.sample, v => { eyeSettings.sample = v; app.saveToolSettings(eyedropper); }, { width: 200, title: 'Sample' });
    bar.append(label('Sample Size:'), size, separator(), label('Sample:'), sample, separator(),
      checkbox('Show Sampling Ring', eyeSettings.showRing, v => { eyeSettings.showRing = v; app.saveToolSettings(eyedropper); }, { title: 'Show a ring with the new and current colour while sampling' }),
      separator(), button('Sample Screen...', () => sampleScreen(), { cls: 'small', title: 'Pick a colour anywhere on the screen (outside the document window)' }));
    const off = events.on('toolOptions', () => { size.setValue(eyeSettings.size); sample.setValue(eyeSettings.sample); });
    return off;
  },
  pointerDown(p, doc) {
    // Shift+click with the Eyedropper adds a colour sampler (Photoshop behaviour)
    if (p.shift && app.springTool !== eyedropper) { addSampler(doc, p.x, p.y); return; }
    const target = p.alt && app.springTool !== eyedropper ? 'bg' : 'fg';
    pick = { before: target === 'bg' ? { ...app.bg } : { ...app.fg }, now: null, target };
    applyPick(doc, p, false);
  },
  pointerMove(p, doc) { applyPick(doc, p, false); },
  pointerUp(p, doc) {
    applyPick(doc, p, true);
    if (pick && !pick.now) { /* sampled nothing (transparent / outside): keep the colour */ }
    pick = null;
    doc.redrawOverlay();
  },
  drawOverlay(ctx, view) { if (pick && eyeSettings.showRing) drawRing(ctx, view); },
  contextMenu(p, doc) {
    const c = eyedropperSample(doc, p.x, p.y) || app.fg;
    const items: MenuEntry[] = [
      ...SAMPLE_SIZES.map(s => ({ label: s.label, radio: true, checked: eyeSettings.size === s.value, action: () => { eyeSettings.size = s.value; app.saveToolSettings(eyedropper); } })),
      '-',
      { label: "Copy Color's Hex Code", action: () => copyColorMenu(c, false) },
      { label: 'Copy Color as HTML', action: () => copyColorMenu(c, true) },
      { label: 'Sample from Screen...', action: () => sampleScreen() },
    ];
    openMenu(items, { x: (p.event as MouseEvent).clientX, y: (p.event as MouseEvent).clientY });
  },
};
app.registerTool(eyedropper);

// ------------------------------------------------------------------ Color Sampler
export interface Sampler { x: number; y: number; mode?: string }
const MAX_SAMPLERS = 10;
const samplerSettings = { size: 1 };
export const samplerSampleSize = () => samplerSettings.size;
export const getSamplers = (doc: PixDocument | null): Sampler[] => (doc?.extra?.samplers as Sampler[]) || [];

function setSamplers(doc: PixDocument, name: string, list: Sampler[]) {
  doc.history.transaction(name, () => { doc.extra = { ...doc.extra, samplers: list }; });
  doc.redrawOverlay();
  measureEvents.emit('samplers', doc);
}
export function addSampler(doc: PixDocument, x: number, y: number) {
  const list = getSamplers(doc);
  if (list.length >= MAX_SAMPLERS) { toast(`You can only place ${MAX_SAMPLERS} color samplers.`, 'error'); return; }
  if (x < 0 || y < 0 || x >= doc.width || y >= doc.height) return;
  setSamplers(doc, 'Color Sampler', [...list, { x: Math.floor(x), y: Math.floor(y) }]);
}
export function deleteSampler(doc: PixDocument, i: number) {
  setSamplers(doc, 'Delete Color Sampler', getSamplers(doc).filter((_, j) => j !== i));
}
export function clearSamplers(doc: PixDocument) {
  if (getSamplers(doc).length) setSamplers(doc, 'Clear Color Samplers', []);
}
export function setSamplerMode(doc: PixDocument, i: number, mode: string) {
  const list = getSamplers(doc).map((s, j) => (j === i ? { ...s, mode } : s));
  doc.extra = { ...doc.extra, samplers: list };   // readout mode is a view setting, not an edit
  measureEvents.emit('samplers', doc);
}

/** Live position of a sampler being dragged (Info panel shows it). */
export const samplerDragPos = (i: number) => (sDrag && sDrag.index === i ? sDrag.pos : null);

/** Index of the sampler under a screen point, or -1. */
function samplerAt(view: Viewport, doc: PixDocument, sx: number, sy: number): number {
  const list = getSamplers(doc);
  for (let i = list.length - 1; i >= 0; i--) {
    const s = view.docToScreen(list[i].x + 0.5, list[i].y + 0.5);
    if (Math.hypot(s.x - sx, s.y - sy) <= 8) return i;
  }
  return -1;
}

function drawSamplers(ctx: CanvasRenderingContext2D, view: Viewport, doc: PixDocument) {
  const list = getSamplers(doc);
  if ((!list.length && !sDrag) || !viewOptions.extras) return;
  ctx.save();
  ctx.font = '600 10px Segoe UI, system-ui, sans-serif';
  const shown: Sampler[] = sDrag && sDrag.index < 0 ? [...list, sDrag.pos] : list;
  shown.forEach((s, i) => {
    const pos = sDrag && sDrag.index === i ? sDrag.pos : s;
    const p = view.docToScreen(pos.x + 0.5, pos.y + 0.5);
    const x = Math.round(p.x) + 0.5, y = Math.round(p.y) + 0.5;
    for (const [col, w] of [['rgba(255,255,255,.95)', 3], ['#000', 1]] as [string, number][]) {
      ctx.strokeStyle = col; ctx.lineWidth = w;
      ctx.beginPath(); ctx.arc(x, y, 5, 0, Math.PI * 2);
      ctx.moveTo(x - 10, y); ctx.lineTo(x - 5, y); ctx.moveTo(x + 5, y); ctx.lineTo(x + 10, y);
      ctx.moveTo(x, y - 10); ctx.lineTo(x, y - 5); ctx.moveTo(x, y + 5); ctx.lineTo(x, y + 10);
      ctx.stroke();
    }
    const t = String(i + 1);
    ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(255,255,255,.95)'; ctx.strokeText(t, x + 7, y + 16);
    ctx.fillStyle = '#000'; ctx.fillText(t, x + 7, y + 16);
  });
  ctx.restore();
}
viewportHooks.overlay.push(drawSamplers);

let sDrag: { index: number; pos: { x: number; y: number }; moved: boolean } | null = null;
const sampler: Tool = {
  id: 'color-sampler', name: 'Color Sampler Tool', group: 'eyedropper', icon: 'color-sampler', shortcut: 'I', order: 1,
  settings: samplerSettings,
  cursor: () => {
    const v = app.viewport, d = app.activeDoc;
    if (v && d && samplerAt(v, d, v.pointer.sx, v.pointer.sy) >= 0) return (window as any).__altDown ? CURSORS.crosshair : 'move';
    return CURSORS.eyedropper;
  },
  options(bar) {
    const size = select(SAMPLE_SIZES, samplerSettings.size, v => { samplerSettings.size = v; app.saveToolSettings(sampler); if (app.activeDoc) measureEvents.emit('samplers', app.activeDoc); }, { width: 150, title: 'Sample Size' });
    const clear = button('Clear All', () => app.activeDoc && clearSamplers(app.activeDoc), { cls: 'small', title: 'Delete all color samplers' });
    bar.append(label('Sample Size:'), size, separator(), clear);
  },
  pointerDown(p, doc) {
    const v = app.viewport!;
    const i = samplerAt(v, doc, p.sx, p.sy);
    if (i >= 0) {
      if (p.alt) { deleteSampler(doc, i); return; }
      sDrag = { index: i, pos: { ...getSamplers(doc)[i] }, moved: false };
      return;
    }
    if (p.x < 0 || p.y < 0 || p.x >= doc.width || p.y >= doc.height) return;
    if (getSamplers(doc).length >= MAX_SAMPLERS) { toast(`You can only place ${MAX_SAMPLERS} color samplers.`, 'error'); return; }
    sDrag = { index: -1, pos: { x: Math.floor(p.x), y: Math.floor(p.y) }, moved: true };   // new sampler, placed on release
    measureEvents.emit('samplers', doc);
  },
  pointerMove(p, doc) {
    if (!sDrag) return;
    sDrag.pos = { x: Math.max(0, Math.min(doc.width - 1, Math.floor(p.x))), y: Math.max(0, Math.min(doc.height - 1, Math.floor(p.y))) };
    sDrag.moved = true;
    measureEvents.emit('samplers', doc);
  },
  pointerUp(_p, doc) {
    const d = sDrag;
    sDrag = null;
    if (!d || !d.moved) return;
    if (d.index < 0) { addSampler(doc, d.pos.x, d.pos.y); return; }
    setSamplers(doc, 'Move Color Sampler', getSamplers(doc).map((s, j) => (j === d.index ? { ...s, x: d.pos.x, y: d.pos.y } : s)));
  },
  contextMenu(p, doc) {
    const i = samplerAt(app.viewport!, doc, p.sx, p.sy);
    const ev = p.event as MouseEvent;
    const items: MenuEntry[] = i >= 0 ? [
      { label: 'Delete', action: () => deleteSampler(doc, i) },
      '-',
      ...['Actual Color', 'Grayscale', 'RGB Color', 'Web Color', 'HSB Color', 'CMYK Color', 'Lab Color', 'Total Ink', 'Opacity'].map(m => ({
        label: m, radio: true, checked: (getSamplers(doc)[i].mode || 'Actual Color') === m, action: () => setSamplerMode(doc, i, m),
      })),
    ] : SAMPLE_SIZES.map(s => ({ label: s.label, radio: true, checked: samplerSettings.size === s.value, action: () => { samplerSettings.size = s.value; app.saveToolSettings(sampler); } }));
    openMenu(items, { x: ev.clientX, y: ev.clientY });
  },
};
app.registerTool(sampler);
