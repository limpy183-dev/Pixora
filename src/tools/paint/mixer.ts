// Mixer Brush Tool (B): simulates real paint. The brush holds a reservoir (foreground colour or an image sample
// loaded with Alt-click) and a pickup well that is contaminated by the canvas it passes over.
//   Wet  — how much paint the brush picks up from the canvas.
//   Load — how much paint is loaded in the reservoir (low load = strokes dry out sooner).
//   Mix  — ratio of canvas paint to reservoir paint in each dab.
// Options: load / clean after each stroke, Load Solid Colors Only, Sample All Layers, useful preset combinations.
import { app } from '../../core/app';
import type { PixDocument, PaintTarget } from '../../core/document';
import { createCanvas, ctx2d } from '../../core/canvas';
import type { RGB } from '../../core/types';
import { events } from '../../core/events';
import { hooks } from '../../core/registry';
import { h } from '../../ui/dom';
import { icon, registerIcons } from '../../ui/icons';
import { iconButton, popupSlider, select, separator, type SelectOption } from '../../ui/widgets';
import { openMenu } from '../../ui/menu';
import { toast } from '../../ui/toast';
import {
  createPaintTool, finishOptions, optAngle, optBrush, optCtx, optPercent, optSmoothing, optSymmetry, optToggle, paintDefaults, readRegion, scratchCanvas,
  type OptCtx,
} from './common';

registerIcons({
  'mx-load': '<path d="M7 3h10l-1.5 5h-7z"/><path d="M9 8v4a3 3 0 0 0 6 0V8"/><path d="M12 15v6"/><path d="M9.5 18.5 12 21l2.5-2.5"/>',
  'mx-clean': '<path d="M7 3h10l-1.5 5h-7z"/><path d="M9 8v4a3 3 0 0 0 6 0V8"/><path d="M12 15v2"/><path d="M8 20c1.2-.8 2.5-1.2 4-1.2s2.8.4 4 1.2"/>',
  'mx-all': '<path d="m12 3 9 4.5-9 4.5-9-4.5z"/><path d="m3 12 9 4.5 9-4.5"/><path d="m3 16.5 9 4.5 9-4.5"/>',
});

// ------------------------------------------------------------------ settings & presets
const settings = paintDefaults({
  size: 45, hardness: 0.9, tipId: 'hard-round', smoothing: 0.1, spacing: 0.1,
  wet: 0.5, load: 0.5, mix: 0.5, autoLoad: true, autoClean: true, sampleAll: false, solidOnly: false, combo: 'custom',
});

const COMBOS: { id: string; label: string; wet: number; load: number; mix: number }[] = [
  { id: 'dry', label: 'Dry', wet: 0, load: 50, mix: 0 },
  { id: 'dry-light', label: 'Dry, Light Load', wet: 0, load: 25, mix: 0 },
  { id: 'dry-heavy', label: 'Dry, Heavy Load', wet: 0, load: 100, mix: 0 },
  { id: 'moist', label: 'Moist', wet: 10, load: 10, mix: 50 },
  { id: 'moist-light', label: 'Moist, Light Load', wet: 10, load: 5, mix: 50 },
  { id: 'moist-heavy', label: 'Moist, Heavy Load', wet: 10, load: 50, mix: 50 },
  { id: 'wet', label: 'Wet', wet: 50, load: 50, mix: 50 },
  { id: 'wet-light', label: 'Wet, Light Load', wet: 50, load: 10, mix: 50 },
  { id: 'wet-heavy', label: 'Wet, Heavy Load', wet: 50, load: 100, mix: 50 },
  { id: 'very-wet', label: 'Very Wet', wet: 100, load: 50, mix: 50 },
  { id: 'very-wet-light', label: 'Very Wet, Light Load', wet: 100, load: 10, mix: 50 },
  { id: 'very-wet-heavy', label: 'Very Wet, Heavy Load', wet: 100, load: 100, mix: 50 },
];

// ------------------------------------------------------------------ brush state (transient)
/**
 * The brush carries two N×N RGBA wells (straight colour + alpha, mapped onto the dab):
 *  - `loadWell`: paint loaded from the reservoir (FG colour or an Alt-click sample); its strength `amount` drains
 *    along the stroke according to Load;
 *  - `pickWell`: canvas paint picked up while painting (Wet); it travels with the brush, which smears colours.
 */
const N = 48;
interface Well { data: Float32Array }
const reservoir: { kind: 'fg' | 'color' | 'image'; color: RGB; img: Well | null } = { kind: 'fg', color: { r: 0, g: 0, b: 0 }, img: null };
let loadWell: Well | null = null;
let pickWell: Well = { data: new Float32Array(N * N * 4) };
let amount = 0;                         // remaining reservoir paint (0..1)
const listeners = new Set<() => void>();
const changed = () => listeners.forEach(f => f());

function solidWell(c: RGB): Well {
  const d = new Float32Array(N * N * 4);
  for (let i = 0; i < d.length; i += 4) { d[i] = c.r; d[i + 1] = c.g; d[i + 2] = c.b; d[i + 3] = 255; }
  return { data: d };
}
function reservoirWell(): Well {
  if (reservoir.kind === 'image' && reservoir.img) return { data: reservoir.img.data.slice() };
  return solidWell(reservoir.kind === 'fg' ? app.fg : reservoir.color);
}
export function loadBrush() { loadWell = reservoirWell(); amount = 1; changed(); }
export function cleanBrush() { loadWell = null; amount = 0; pickWell = { data: new Float32Array(N * N * 4) }; changed(); }
events.on('colors', () => { if (reservoir.kind === 'fg' && settings.autoLoad && loadWell) loadBrush(); });

/** Alt-click: load the brush from the image under the tip (or its average colour). */
function sampleLoad(doc: PixDocument, t: PaintTarget | null, x: number, y: number) {
  const size = Math.max(2, Math.round(settings.size));
  const src = settings.sampleAll || !t ? { canvas: doc.getComposite(), x: 0, y: 0 } : { canvas: t.holder.canvas, x: t.holder.x, y: t.holder.y };
  const rx = Math.round(x - size / 2 - src.x), ry = Math.round(y - size / 2 - src.y);
  const c = createCanvas(N, N), cx = ctx2d(c);
  cx.imageSmoothingQuality = 'high';
  cx.drawImage(src.canvas, rx, ry, size, size, 0, 0, N, N);
  const d = cx.getImageData(0, 0, N, N).data;
  if (settings.solidOnly) {
    let r = 0, g = 0, b = 0, a = 0;
    for (let i = 0; i < d.length; i += 4) { const w = d[i + 3]; r += d[i] * w; g += d[i + 1] * w; b += d[i + 2] * w; a += w; }
    if (!a) { toast('Could not load the brush because the sampled area is empty.', 'error'); return; }
    reservoir.kind = 'color'; reservoir.color = { r: Math.round(r / a), g: Math.round(g / a), b: Math.round(b / a) }; reservoir.img = null;
  } else {
    const f = new Float32Array(N * N * 4);
    for (let i = 0; i < d.length; i++) f[i] = d[i];
    reservoir.kind = 'image'; reservoir.img = { data: f };
  }
  loadBrush();
}

// ------------------------------------------------------------------ options bar pieces
function wellThumb(): HTMLCanvasElement {
  const c = createCanvas(N, N), x = ctx2d(c), img = x.createImageData(N, N);
  const w = loadWell;
  if (w) for (let i = 0; i < img.data.length; i++) img.data[i] = (i & 3) === 3 ? w.data[i] * Math.max(0.25, amount) : w.data[i];
  x.putImageData(img, 0, 0);
  return c;
}
function loadSwatch(c: OptCtx): HTMLElement {
  const sw = h('button.mx-swatch', { type: 'button', title: 'Current brush load (click to set the reservoir colour)' });
  const paint = () => {
    sw.innerHTML = '';
    if (loadWell && amount > 0) { const t = wellThumb(); t.className = 'mx-well'; sw.append(t); }
    else sw.append(h('span.mx-empty', null, ''));
  };
  sw.addEventListener('click', async () => {
    const col = await hooks.openColorPicker(reservoir.kind === 'color' ? reservoir.color : app.fg, 'Color Picker (Mixer Brush Color)');
    if (!col) return;
    reservoir.kind = 'color'; reservoir.color = col; reservoir.img = null; loadBrush();
  });
  const caret = iconButton('caret-down', 'Brush load options', () => {
    openMenu([
      { label: 'Load Brush', action: loadBrush },
      { label: 'Clean Brush', action: cleanBrush },
      '-',
      { label: 'Load Solid Colors Only', checked: () => !!c.s.solidOnly, action: () => { c.s.solidOnly = !c.s.solidOnly; c.save(); } },
      { label: 'Use Foreground Color', action: () => { reservoir.kind = 'fg'; reservoir.img = null; loadBrush(); } },
    ], caret, { minWidth: 190 });
  });
  listeners.add(paint);
  paint();
  return h('span.mx-load', null, sw, caret);
}

function comboSelect(c: OptCtx, fields: { wet: any; load: any; mix: any }): HTMLElement {
  const opts: (SelectOption<string> | '-')[] = [{ value: 'custom', label: 'Custom' }, '-', ...COMBOS.map(k => ({ value: k.id, label: k.label }))];
  const f = select<string>(opts, c.s.combo, v => {
    c.s.combo = v;
    const k = COMBOS.find(x => x.id === v);
    if (k) { c.s.wet = k.wet / 100; c.s.load = k.load / 100; c.s.mix = k.mix / 100; fields.wet.setValue(k.wet); fields.load.setValue(k.load); fields.mix.setValue(k.mix); }
    c.save();
  }, { width: 150, title: 'Useful mixer brush combinations' });
  c.syncs.push(() => f.setValue(c.s.combo));
  return f;
}

// ------------------------------------------------------------------ tool
let scratch: HTMLCanvasElement | null = null;

createPaintTool({
  id: 'mixer-brush', name: 'Mixer Brush Tool', group: 'color-replace', icon: 'mixer-brush', shortcut: 'B', order: 1,
  settings,
  historyName: 'Mixer Brush',
  options(bar, tool) {
    const c = optCtx(tool);
    if (!loadWell && c.s.autoLoad) loadBrush();
    const custom = () => { if (c.s.combo !== 'custom') { c.s.combo = 'custom'; combo.setValue?.('custom'); } };
    const pct = (key: 'wet' | 'load' | 'mix', label: string, title: string) => {
      const f = popupSlider(label, Math.round(c.s[key] * 100), v => { c.s[key] = v / 100; custom(); c.save(); }, { title });
      c.syncs.push(() => f.setValue(Math.round(c.s[key] * 100)));
      return f;
    };
    const wet = pct('wet', 'Wet', 'Amount of paint picked up from the canvas');
    const load = pct('load', 'Load', 'Amount of paint loaded in the reservoir');
    const mixF = pct('mix', 'Mix', 'Ratio of canvas paint to reservoir paint');
    const combo = comboSelect(c, { wet, load, mix: mixF }) as any;
    bar.append(...optBrush(c), separator(), loadSwatch(c),
      optToggle(c, 'autoLoad', 'mx-load', 'Load the brush after each stroke'),
      optToggle(c, 'autoClean', 'mx-clean', 'Clean the brush after each stroke'), separator(),
      combo, separator(), wet, load, mixF, optPercent(c, 'flow', 'Flow', 'Set the flow rate for strokes'),
      optToggle(c, 'airbrush', 'airbrush', 'Enable airbrush-style build-up effects'), separator(), ...optSmoothing(c), separator(),
      optAngle(c), separator(),
      optToggle(c, 'sampleAll', 'mx-all', 'Sample All Layers: pick up paint from all visible layers'), separator(),
      optToggle(c, 'pressureSize', 'pressure-size', 'Always use Pressure for Size. When off, Brush Settings override pressure.'), optSymmetry(),
      h('span.mx-hint', { title: 'Alt-click to load the brush from the image' }, icon('info', 14)));
    const off = finishOptions(c);
    return () => { off(); };
  },
  preDown(p, doc) {
    if (!p.alt) return false;
    sampleLoad(doc, doc.getPaintTarget(), p.x, p.y);
    return true;
  },
  setup(doc, target, _p, s) {
    if (s.autoLoad) loadBrush();
    const lw = loadWell, pw = pickWell.data;
    const hold = target.holder;
    const mixK = s.mix, pick = s.wet * 0.3, drain = (1 - s.load) * 0.035 + 0.002;
    const comp = s.sampleAll && !target.isMask ? doc.getComposite() : null;
    return {
      mode: 'paint', blendMode: 'normal', opacity: 1,
      content: (d, box) => {
        const src = comp ? readRegion(comp, box.x, box.y, box.w, box.h) : readRegion(hold.canvas, box.x - hold.x, box.y - hold.y, box.w, box.h);
        const sd = src.data;
        if (target.isMask) for (let k = 0; k < sd.length; k += 4) { const v = sd[k + 3]; sd[k] = sd[k + 1] = sd[k + 2] = v; sd[k + 3] = 255; }
        const out = new ImageData(box.w, box.h), od = out.data, ld = lw?.data;
        const cx = d.x - box.x, cy = d.y - box.y, sc = N / Math.max(1, d.size);
        const am = ld ? amount : 0;
        for (let y = 0; y < box.h; y++) {
          const v = Math.floor((y - cy) * sc + N / 2);
          if (v < 0 || v >= N) continue;
          for (let x = 0; x < box.w; x++) {
            const u = Math.floor((x - cx) * sc + N / 2);
            if (u < 0 || u >= N) continue;
            const k = (y * box.w + x) * 4, q = (v * N + u) * 4;
            // reservoir paint vs carried (picked-up) paint, weighted by their alpha
            const ra = ld ? ld[q + 3] * am : 0, pa = pw[q + 3];
            let wr = ra * (1 - mixK), wp = pa * mixK;
            if (wr + wp <= 0.5) { wr = ra; wp = pa; }                 // only one kind of paint on the brush
            const tw = wr + wp;
            if (tw > 0.5) {
              od[k] = ((ld ? ld[q] : 0) * wr + pw[q] * wp) / tw;
              od[k + 1] = ((ld ? ld[q + 1] : 0) * wr + pw[q + 1] * wp) / tw;
              od[k + 2] = ((ld ? ld[q + 2] : 0) * wr + pw[q + 2] * wp) / tw;
              od[k + 3] = Math.min(255, Math.max(ra, pa));
            }
            // pick up canvas paint (after depositing, so the carried colour lags behind = smear)
            const ca = sd[k + 3];
            if (pick > 0 && ca > 0) {
              const f = pick * (ca / 255);
              pw[q] += (sd[k] - pw[q]) * (pa > 0 ? f : 1);
              pw[q + 1] += (sd[k + 1] - pw[q + 1]) * (pa > 0 ? f : 1);
              pw[q + 2] += (sd[k + 2] - pw[q + 2]) * (pa > 0 ? f : 1);
              pw[q + 3] += (ca - pw[q + 3]) * f;
            }
          }
        }
        if (ld) amount = Math.max(0, amount - drain);
        scratch = scratchCanvas(scratch, box.w, box.h);
        ctx2d(scratch).putImageData(out, 0, 0);
        return scratch;
      },
      after: () => {
        if (s.autoClean) { pickWell = { data: new Float32Array(N * N * 4) }; if (!s.autoLoad) { loadWell = null; amount = 0; } }
        if (s.autoLoad) loadBrush(); else changed();
      },
    };
  },
});

