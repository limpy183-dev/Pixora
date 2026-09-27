// Layer > Layer Style menu (Blending Options / effect pages, Copy / Paste / Clear Layer Style, Global Light,
// Create Layer(s), Hide All Effects, Scale Effects), Blend If (hooks.beforeBlend) and the Styles panel.
import { app } from '../core/app';
import type { PixDocument } from '../core/document';
import { RasterLayer, type Layer } from '../core/layer';
import { registerCommands } from '../core/commands';
import { hooks, resources } from '../core/registry';
import { ctx2d } from '../core/canvas';
import type { LayerEffect } from '../core/types';
import { registerPanel } from '../ui/panels';
import { clear, h } from '../ui/dom';
import { iconButton, numberField } from '../ui/widgets';
import { confirmDialog, openDialog, promptDialog } from '../ui/dialog';
import { contextMenu } from '../ui/menu';
import { toast } from '../ui/toast';
import { openLayerStyle, saveUserStyles, styleThumb } from './dialog';
import { globalLight, renderEffects } from './render';
import { normEffect } from './engine';

const D = () => app.activeDoc;
const L = () => app.activeDoc?.activeLayer || null;

// ------------------------------------------------------------------ Blend If
type Band = [number, number, number, number];
const isDefault = (b?: Band) => !b || (b[0] === 0 && b[1] === 0 && b[2] === 255 && b[3] === 255);
const bandWeight = (v: number, b: Band) => {
  if (v < b[0] || v > b[3]) return 0;
  if (v < b[1]) return (v - b[0]) / (b[1] - b[0] || 1);
  if (v > b[2]) return (b[3] - v) / (b[3] - b[2] || 1);
  return 1;
};
const chanVal = (d: Uint8ClampedArray, j: number, ch: string) => ch === 'red' ? d[j] : ch === 'green' ? d[j + 1] : ch === 'blue' ? d[j + 2] : 0.3 * d[j] + 0.59 * d[j + 1] + 0.11 * d[j + 2];
hooks.beforeBlend = {
  needs(layer: Layer) {
    const bi = (layer as any).blendIf;
    if (!bi) return false;
    for (const ch of Object.keys(bi)) if (!isDefault(bi[ch].this) || !isDefault(bi[ch].under)) return true;
    return false;
  },
  apply(layer, surface, backdrop) {
    const bi = (layer as any).blendIf, w = surface.width, hh = surface.height;
    const sx = ctx2d(surface), sd = sx.getImageData(0, 0, w, hh), s = sd.data;
    const bd = backdrop.getImageData(0, 0, Math.min(w, backdrop.canvas.width), Math.min(hh, backdrop.canvas.height)).data;
    const chans = Object.keys(bi).filter(ch => !isDefault(bi[ch].this) || !isDefault(bi[ch].under));
    for (let i = 3; i < s.length; i += 4) {
      if (!s[i]) continue;
      let k = 1;
      for (const ch of chans) {
        const c = bi[ch];
        if (!isDefault(c.this)) k *= bandWeight(chanVal(s, i - 3, ch), c.this);
        if (!isDefault(c.under) && i < bd.length) k *= bandWeight(chanVal(bd, i - 3, ch), c.under);
        if (!k) break;
      }
      if (k < 1) s[i] = s[i] * k;
    }
    sx.putImageData(sd, 0, 0);
  },
};

// ------------------------------------------------------------------ style clipboard & commands
let copied: { effects: LayerEffect[]; blend: any } | null = null;
function withStyleTargets(doc: PixDocument): Layer[] {
  return doc.selectedLayers.filter(l => !l.isBackground && l.kind !== 'adjustment');
}
async function globalLightDialog(doc: PixDocument) {
  const g = globalLight(doc);
  const v = { ...g };
  const body = h('div.form', null,
    h('div.form-row', null, h('label.form-label', null, 'Angle:'), numberField(v.angle, x => { v.angle = x; }, { min: -180, max: 180, unit: '°', width: 60 })),
    h('div.form-row', null, h('label.form-label', null, 'Altitude:'), numberField(v.altitude, x => { v.altitude = x; }, { min: 0, max: 90, unit: '°', width: 60 })));
  if ((await openDialog({ title: 'Global Light', body }).result) !== true) return;
  doc.history.transaction('Global Light', () => { doc.extra = { ...doc.extra, globalLight: { angle: v.angle, altitude: v.altitude } }; for (const l of doc.allLayers()) if (l.effects.length) l.invalidate(); });
  doc.pixelsChanged(null, null);
}
const SCALE_KEYS = ['distance', 'size', 'soften', 'spread', 'offsetX', 'offsetY'];
async function scaleEffectsDialog(doc: PixDocument) {
  const ls = withStyleTargets(doc).filter(l => l.effects.length);
  if (!ls.length) return;
  let k = 100;
  const body = h('div.form', null, h('div.form-row', null, h('label.form-label', null, 'Scale:'), numberField(100, x => { k = x; }, { min: 1, max: 1000, unit: '%', width: 64 })));
  if ((await openDialog({ title: 'Scale Layer Effects', body }).result) !== true) return;
  doc.history.transaction('Scale Effects', () => {
    for (const l of ls) { l.effects = l.effects.map(e => { const n: any = { ...e }; for (const key of SCALE_KEYS) if (typeof n[key] === 'number' && key !== 'spread') n[key] = Math.round(n[key] * k) / 100; return n; }); l.invalidate(); }
  });
  doc.pixelsChanged(null, null); doc.layersChanged();
}
/** Layer > Layer Style > Create Layer: each effect becomes its own raster layer. */
function styleToLayers(doc: PixDocument) {
  const l = L();
  if (!l || !l.effects.some(e => e.enabled)) return;
  const content = l.getContent(doc);
  if (!content) return;
  const below = ['dropShadow', 'outerGlow'];
  doc.history.transaction('Create Layers', () => {
    const made: { layer: RasterLayer; below: boolean }[] = [];
    for (const e of l.effects.filter(x => x.enabled)) {
      const fake = { effects: [normEffect(e)], effectsVisible: true, fillOpacity: 0, _version: Math.random() } as any;
      const res = renderEffects(fake, content, doc);
      if (!res) continue;
      const r = new RasterLayer(1, 1, `${l.name}'s ${e.type.replace(/([A-Z])/g, ' $1').replace(/^./, c => c.toUpperCase())}`);
      r.canvas = res.canvas; r.x = res.x; r.y = res.y;
      r.blendMode = e.mode || e.hiMode || 'normal';
      made.push({ layer: r, below: below.includes(e.type) });
    }
    for (const m of made.filter(x => x.below)) doc.addLayer(m.layer, { above: null, parent: l._parent, index: (l._parent ? l._parent.children : doc.layers).indexOf(l) });
    let above = l;
    for (const m of made.filter(x => !x.below)) { m.layer.clipped = true; doc.addLayer(m.layer, { above }); above = m.layer; }
    l.effects = [];
    l.invalidate();
  });
  doc.layersChanged(); doc.pixelsChanged(null, null);
}

registerCommands([
  { id: 'layer.style', label: 'Layer Style', enabled: () => !!L(), run: (page?: string) => { const d = D(), l = L(); if (d && l) void openLayerStyle(d, l, page || 'blending'); } },
  {
    id: 'layer.copyStyle', label: 'Copy Layer Style', enabled: () => !!L(),
    run: () => { const l = L() as any; if (!l) return; copied = { effects: l.effects.map((e: LayerEffect) => ({ ...e })), blend: { blendMode: l.blendMode, opacity: l.opacity, fillOpacity: l.fillOpacity, blendIf: l.blendIf, blendInterior: l.blendInterior } }; },
  },
  {
    id: 'layer.pasteStyle', label: 'Paste Layer Style', enabled: () => !!copied && !!L(),
    run: () => {
      const d = D(); if (!d || !copied) return;
      const ls = withStyleTargets(d);
      d.history.transaction('Paste Layer Style', () => { for (const l of ls) { l.effects = copied!.effects.map(e => ({ ...e })); Object.assign(l, JSON.parse(JSON.stringify(copied!.blend))); l.invalidate(); } });
      d.layersChanged(); d.pixelsChanged(null, null);
    },
  },
  {
    id: 'layer.clearStyle', label: 'Clear Layer Style', enabled: () => !!L(),
    run: () => {
      const d = D(); if (!d) return;
      d.history.transaction('Clear Layer Style', () => { for (const l of d.selectedLayers) { l.effects = []; (l as any).blendIf = undefined; l.fillOpacity = 1; l.invalidate(); } });
      d.layersChanged(); d.pixelsChanged(null, null);
    },
  },
  { id: 'layer.globalLight', label: 'Global Light...', enabled: () => !!D(), run: () => { const d = D(); if (d) void globalLightDialog(d); } },
  { id: 'layer.styleToLayers', label: 'Create Layer', enabled: () => !!L()?.effects.some(e => e.enabled), run: () => { const d = D(); if (d) styleToLayers(d); } },
  {
    id: 'layer.hideAllEffects', enabled: () => !!D(),
    get label() { const d = D(); return d && d.allLayers().some(l => l.effects.length && !l.effectsVisible) ? 'Show All Effects' : 'Hide All Effects'; },
    run: () => {
      const d = D(); if (!d) return;
      const hide = d.allLayers().some(l => l.effects.length && l.effectsVisible);
      d.history.transaction(hide ? 'Hide All Effects' : 'Show All Effects', () => { for (const l of d.allLayers()) if (l.effects.length) { l.effectsVisible = !hide; l.invalidate(); } });
      d.layersChanged(); d.pixelsChanged(null, null);
    },
  } as any,
  { id: 'layer.scaleEffects', label: 'Scale Effects...', enabled: () => !!L()?.effects.length, run: () => { const d = D(); if (d) void scaleEffectsDialog(d); } },
]);

// ------------------------------------------------------------------ Styles panel
function applyStyle(effects: LayerEffect[], add: boolean) {
  const d = D(); if (!d) return;
  const ls = withStyleTargets(d);
  if (!ls.length) { toast('Select a layer (not the Background) to apply a style.', 'error'); return; }
  d.history.transaction('Apply Style', () => { for (const l of ls) { l.effects = add ? [...l.effects, ...effects.map(e => ({ ...e }))] : effects.map(e => ({ ...e })); l.invalidate(); } });
  d.layersChanged(); d.pixelsChanged(null, null);
}
registerPanel({
  id: 'styles', title: 'Styles', icon: 'styles', defaultHeight: 240,
  create(el) {
    const grid = h('div.sty-grid.panel-scroll');
    const foot = h('div.panel-footer', null,
      h('span.sty-hint', { title: 'Shift-click a style to add its effects to the existing ones' }, 'Shift-click: add'),
      h('span.sty-flex'),
      iconButton('fx', 'Clear the layer style', () => { void import('../core/commands').then(m => m.runCommand('layer.clearStyle')); }),
      iconButton('new-layer', 'Create a new style from the selected layer', async () => {
        const l = L(); if (!l?.effects.length) { toast('The selected layer has no effects to save as a style.', 'error'); return; }
        const n = await promptDialog('New Style', 'Name:', `Style ${resources.styles.length + 1}`); if (!n) return;
        resources.styles.push({ id: `style-${Date.now().toString(36)}`, name: n, effects: l.effects.map(e => ({ ...e })) }); saveUserStyles(); draw();
      }),
      iconButton('trash', 'Delete the selected style', async () => { if (!selId) return; const s = resources.styles.find(x => x.id === selId); if (s && (await confirmDialog('Delete Style', `Delete the style “${s.name}”?`)) === 'ok') { resources.styles.splice(resources.styles.indexOf(s), 1); saveUserStyles(); draw(); } }));
    el.append(h('div.sty-panel', null, grid, foot));
    let selId = '';
    const draw = () => {
      clear(grid);
      const none = h('button.sty-cell', { type: 'button', title: 'Default Style (None)' }, h('span.sty-none'));
      none.addEventListener('click', () => applyStyle([], false));
      grid.append(none);
      for (const s of resources.styles) {
        const b = h('button.sty-cell', { type: 'button', title: s.name, class: s.id === selId ? 'active' : '' }, styleThumb(s.effects as LayerEffect[], 44));
        b.addEventListener('click', e => { selId = s.id; applyStyle(s.effects as LayerEffect[], e.shiftKey); draw(); });
        b.addEventListener('contextmenu', e => {
          e.preventDefault();
          contextMenu(e, [
            { label: 'Rename Style...', action: async () => { const n = await promptDialog('Rename Style', 'Name:', s.name); if (n) { s.name = n; saveUserStyles(); draw(); } } },
            { label: 'Delete Style', action: () => { resources.styles.splice(resources.styles.indexOf(s), 1); saveUserStyles(); draw(); } },
          ]);
        });
        grid.append(b);
      }
    };
    draw();
    return { onShow: draw };
  },
  menu: () => [
    { label: 'New Style...', action: async () => { const l = L(); if (!l?.effects.length) return; const n = await promptDialog('New Style', 'Name:', 'Style'); if (n) { resources.styles.push({ id: `style-${Date.now().toString(36)}`, name: n, effects: l.effects.map(e => ({ ...e })) }); saveUserStyles(); } } },
  ],
});
