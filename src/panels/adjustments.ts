// Adjustments panel (PS 2024 style): "Add an adjustment" icon grid + collapsible Adjustment Presets folders.
// Preset tiles show a live thumbnail of the current image with the preset applied.
import './adjustments.css';
import { registerPanel } from '../ui/panels';
import { h } from '../ui/dom';
import { icon } from '../ui/icons';
import { toast } from '../ui/toast';
import { app, saveJSON } from '../core/app';
import { events } from '../core/events';
import { runCommand } from '../core/commands';
import { GroupLayer } from '../core/layer';
import { createCanvas, ctx2d } from '../core/canvas';
import { defs, kernelFor } from '../adjustments/lib';
import { createAdjustmentLayer } from '../adjustments/commands';
import { nextNumberedName } from '../features/layers/shared';
import '../adjustments/icons';

const GRID: string[] = [
  'brightness-contrast', 'levels', 'curves', 'exposure', 'vibrance', 'hue-saturation', 'color-balance', 'black-white',
  'photo-filter', 'channel-mixer', 'color-lookup', 'invert', 'posterize', 'threshold', 'gradient-map', 'selective-color',
];

// ------------------------------------------------------------------ presets
type Step = [type: string, params?: (p: any) => void];
interface Preset { name: string; steps: Step[] }
const curve = (pts: number[][]) => (p: any) => { p.rgb = pts; };
const hs = (fn: (p: any) => void) => fn;
const PRESETS: [string, Preset[]][] = [
  ['Portrait', [
    { name: 'Warm Skin', steps: [['photo-filter', p => { p.filter = 'Warming Filter (LBA)'; p.density = 18; }], ['vibrance', p => { p.vibrance = 12; }]] },
    { name: 'Soft Glow', steps: [['curves', curve([[0, 8], [70, 86], [190, 210], [255, 250]])], ['hue-saturation', hs(p => { p.master.s = -8; })]] },
    { name: 'Matte Portrait', steps: [['curves', curve([[0, 32], [64, 72], [192, 200], [255, 238]])], ['vibrance', p => { p.saturation = -10; }]] },
    { name: 'Portrait Pop', steps: [['curves', curve([[0, 0], [64, 54], [192, 204], [255, 255]])], ['vibrance', p => { p.vibrance = 30; }]] },
    { name: 'Cool Porcelain', steps: [['color-balance', p => { p.highlights = [-6, 0, 10]; p.midtones = [-4, 0, 6]; }], ['hue-saturation', hs(p => { p.master.s = -15; p.master.l = 4; })]] },
  ]],
  ['Landscape', [
    { name: 'Vivid Landscape', steps: [['curves', curve([[0, 0], [64, 50], [192, 206], [255, 255]])], ['vibrance', p => { p.vibrance = 40; p.saturation = 5; }]] },
    { name: 'Golden Hour', steps: [['photo-filter', p => { p.filter = 'Orange'; p.density = 30; }], ['color-balance', p => { p.highlights = [8, 0, -14]; }]] },
    { name: 'Blue Sky Boost', steps: [['hue-saturation', hs(p => { p.ranges[4].s = 35; p.ranges[4].l = -12; p.ranges[3].s = 20; })]] },
    { name: 'Lush Greens', steps: [['hue-saturation', hs(p => { p.ranges[2].s = 30; p.ranges[2].h = -6; p.ranges[1].h = 8; p.ranges[1].s = 12; })]] },
    { name: 'Misty Morning', steps: [['curves', curve([[0, 40], [128, 140], [255, 240]])], ['hue-saturation', hs(p => { p.master.s = -22; })], ['photo-filter', p => { p.filter = 'Cooling Filter (82)'; p.density = 15; }]] },
  ]],
  ['Photo Repair', [
    { name: 'Brighten Midtones', steps: [['levels', p => { p.rgb.gamma = 1.25; }]] },
    { name: 'Recover Shadows', steps: [['curves', curve([[0, 0], [40, 64], [128, 142], [255, 255]])]] },
    { name: 'Tame Highlights', steps: [['curves', curve([[0, 0], [128, 124], [210, 196], [255, 236]])]] },
    { name: 'Warm Up Cold Photo', steps: [['photo-filter', p => { p.filter = 'Warming Filter (85)'; p.density = 22; }]] },
    { name: 'Revive Faded Photo', steps: [['levels', p => { p.rgb.inBlack = 22; p.rgb.inWhite = 232; }], ['vibrance', p => { p.vibrance = 28; }]] },
  ]],
  ['Creative', [
    { name: 'Cross Process', steps: [['curves', p => { p.r = [[0, 0], [64, 48], [192, 222], [255, 255]]; p.g = [[0, 0], [64, 58], [192, 212], [255, 255]]; p.b = [[0, 36], [255, 214]]; }]] },
    { name: 'Teal & Orange', steps: [['color-lookup', p => { p.look = 'Teal & Orange'; }]] },
    { name: 'Vintage Fade', steps: [['curves', curve([[0, 38], [128, 132], [255, 228]])], ['photo-filter', p => { p.filter = 'Sepia'; p.density = 30; }], ['hue-saturation', hs(p => { p.master.s = -25; })]] },
    { name: 'Duotone Violet', steps: [['gradient-map', p => { p.gradient = { name: 'Violet, Orange', stops: [{ pos: 0, color: { r: 41, g: 10, b: 89 } }, { pos: 1, color: { r: 255, g: 170, b: 60 } }], opacityStops: [{ pos: 0, opacity: 1 }, { pos: 1, opacity: 1 }], smoothness: 1 }; }]] },
    { name: 'Poster Pop', steps: [['posterize', p => { p.levels = 5; }], ['vibrance', p => { p.vibrance = 45; }]] },
  ]],
  ['Black & White', [
    { name: 'Classic B&W', steps: [['black-white']] },
    { name: 'High Contrast B&W', steps: [['black-white', p => Object.assign(p, { reds: 120, yellows: 110, greens: -10, cyans: -50, blues: -50, magentas: 120 })], ['curves', curve([[0, 0], [64, 40], [192, 216], [255, 255]])]] },
    { name: 'Infrared B&W', steps: [['black-white', p => Object.assign(p, { reds: -40, yellows: 235, greens: 144, cyans: -68, blues: -3, magentas: -107 })]] },
    { name: 'Sepia Tone', steps: [['black-white', p => { p.tint = true; p.tintHue = 36; p.tintSat = 28; }]] },
    { name: 'Selenium', steps: [['black-white', p => { p.tint = true; p.tintHue = 225; p.tintSat = 12; }], ['curves', curve([[0, 10], [64, 56], [192, 206], [255, 250]])]] },
  ]],
  ['Cinematic', [
    { name: 'Bleach Bypass', steps: [['color-lookup', p => { p.look = 'Bleach Bypass'; }]] },
    { name: 'Moonlight', steps: [['color-lookup', p => { p.look = 'Moonlight'; }]] },
    { name: 'Late Sunset', steps: [['color-lookup', p => { p.look = 'Late Sunset'; }]] },
    { name: 'Filmstock 50', steps: [['color-lookup', p => { p.look = 'Filmstock 50'; }], ['vibrance', p => { p.vibrance = 10; }]] },
    { name: 'Horror Blue', steps: [['color-lookup', p => { p.look = 'Horror Blue'; }]] },
  ]],
];

const stepParams = ([type, fn]: Step) => { const p = defs[type].defaults(); fn?.(p); return p; };

/** Apply a preset: its adjustment layers go into a new group above the active layer (one history state). */
export function applyPreset(pr: Preset) {
  const doc = app.activeDoc;
  if (!doc) { toast('Open or create a document first.'); return; }
  doc.history.transaction('Apply Adjustment Preset', () => {
    const g = new GroupLayer(nextNumberedName(doc, pr.name).replace(/ 1$/, '') || pr.name);
    doc.addLayer(g);
    pr.steps.forEach((s, i) => createAdjustmentLayer(doc, { type: s[0], params: stepParams(s), parent: g, index: i, history: false }));
    doc.setActiveLayer(g.children[g.children.length - 1] || g);
    doc.layersChanged();
  }, 'adjust-layer');
  runCommand('window.showPanel', 'properties');
}

// ------------------------------------------------------------------ panel prefs
const prefs = (() => {
  const d = { open: { Portrait: true } as Record<string, boolean>, addMask: true };
  try { return { ...d, ...JSON.parse(localStorage.getItem('pixora.adjPanel') || '{}') }; } catch { return d; }
})();
const savePrefs = () => saveJSON('pixora.adjPanel', prefs);

registerPanel({
  id: 'adjustments', title: 'Adjustments', icon: 'adjustments', defaultHeight: 330,
  menu: () => [
    { label: 'Add Mask by Default', checked: prefs.addMask, action: () => { prefs.addMask = !prefs.addMask; savePrefs(); } },
    '-',
    { label: 'Expand All Presets', action: () => { PRESETS.forEach(([n]) => (prefs.open[n] = true)); savePrefs(); rerender?.(); } },
    { label: 'Collapse All Presets', action: () => { prefs.open = {}; savePrefs(); rerender?.(); } },
  ],
  create(el) {
    const heading = h('div.ap-heading', null, 'Add an adjustment');
    const grid = h('div.ap-grid');
    for (const type of GRID) {
      const def = defs[type];
      const label = def?.label || type;
      const b = h('button.ap-btn', { type: 'button', title: `Add a new ${label} adjustment layer`, 'aria-label': label, disabled: !def }, icon(def?.icon || 'adjust-layer', 20)) as HTMLButtonElement;
      b.addEventListener('mouseenter', () => { heading.textContent = label; });
      b.addEventListener('mouseleave', () => { heading.textContent = 'Add an adjustment'; });
      b.addEventListener('click', () => {
        const doc = app.activeDoc;
        if (!doc) { toast('Open or create a document first.'); return; }
        createAdjustmentLayer(doc, { type, mask: prefs.addMask });
        runCommand('window.showPanel', 'properties');
      });
      grid.appendChild(b);
    }
    const presetsEl = h('div.ap-presets');
    const thumbs: { canvas: HTMLCanvasElement; pr: Preset }[] = [];
    const render = () => {
      presetsEl.replaceChildren();
      thumbs.length = 0;
      for (const [folder, list] of PRESETS) {
        const open = !!prefs.open[folder];
        const items = h('div.ap-items');
        const head = h('button.ap-folder', { type: 'button', title: open ? `Collapse ${folder}` : `Expand ${folder}`, 'aria-expanded': String(open) },
          h('span.ap-chev', null, icon(open ? 'chevron-down' : 'chevron-right', 12)), icon('folder', 16), h('span', null, folder), h('span.ap-count', null, String(list.length)));
        head.addEventListener('click', () => { prefs.open[folder] = !open; savePrefs(); render(); });
        presetsEl.append(head);
        if (!open) continue;
        for (const pr of list) {
          const c = h('canvas.ap-thumb', { width: 64, height: 44 }) as HTMLCanvasElement;
          const it = h('button.ap-item', { type: 'button', title: `Apply “${pr.name}” (${pr.steps.map(s => defs[s[0]]?.label).join(' + ')})` }, c, h('span.ap-name', null, pr.name));
          it.addEventListener('click', () => applyPreset(pr));
          items.append(it);
          thumbs.push({ canvas: c, pr });
        }
        presetsEl.append(items);
      }
      paintThumbs();
    };
    // ---- thumbnails of the current image with each preset applied
    let base: ImageData | null = null, dirty = true, timer = 0, visible = true;
    const paintThumbs = () => {
      if (!visible) return;
      const doc = app.activeDoc;
      if (dirty) {
        base = null;
        if (doc) {
          const src = doc.getComposite(), k = Math.min(128 / src.width, 88 / src.height);
          const t = createCanvas(Math.max(1, src.width * k), Math.max(1, src.height * k)), tx = ctx2d(t);
          tx.imageSmoothingQuality = 'high';
          tx.fillStyle = '#fff'; tx.fillRect(0, 0, t.width, t.height);
          tx.drawImage(src, 0, 0, t.width, t.height);
          base = tx.getImageData(0, 0, t.width, t.height);
        }
        dirty = false;
      }
      for (const { canvas, pr } of thumbs) {
        const x = ctx2d(canvas);
        x.clearRect(0, 0, canvas.width, canvas.height);
        if (!base) continue;
        const img = new ImageData(new Uint8ClampedArray(base.data), base.width, base.height);
        try {
          for (const s of pr.steps) kernelFor(defs[s[0]], stepParams(s))(img, { doc: doc!, rect: { x: 0, y: 0, w: img.width, h: img.height } });
        } catch { /* keep the unprocessed thumbnail */ }
        const t = createCanvas(img.width, img.height);
        ctx2d(t).putImageData(img, 0, 0);
        const k = Math.max(canvas.width / img.width, canvas.height / img.height);
        x.drawImage(t, (canvas.width - img.width * k) / 2, (canvas.height - img.height * k) / 2, img.width * k, img.height * k);
      }
    };
    const schedule = () => { dirty = true; clearTimeout(timer); timer = window.setTimeout(paintThumbs, 900); };
    rerender = render;
    el.append(h('div.panel-scroll.ap', null, heading, grid, h('div.ap-sep'), h('div.ap-sub', null, 'Adjustment Presets'), presetsEl));
    render();
    const offs = [events.on('pixels', schedule), events.on('layers', schedule), events.on('activeDoc', schedule), events.on('history', schedule)];
    return {
      onShow() { visible = true; if (dirty) paintThumbs(); },
      onHide() { visible = false; },
      destroy() { offs.forEach(o => o()); clearTimeout(timer); },
    };
  },
});
let rerender: (() => void) | null = null;
