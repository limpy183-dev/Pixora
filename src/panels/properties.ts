// Properties panel (Window › Properties): context header + collapsible sections from the propertiesSections
// registry. Also registers the document ('doc-*'), layer ('pixel-*') and mask ('mask') sections.
import './properties.css';
import { app } from '../core/app';
import { events } from '../core/events';
import type { PixDocument } from '../core/document';
import { GroupLayer, RasterLayer, type Layer } from '../core/layer';
import type { ColorMode, LayerMask, Rect, RGB } from '../core/types';
import { propertiesSections, registerPropertiesSection, adjustments } from '../core/registry';
import { runCommand, commands } from '../core/commands';
import { createCanvas, ctx2d, cloneCanvas } from '../core/canvas';
import { fromPx, toPx, unitDecimals, type Unit } from '../core/units';
import { unionRect } from '../core/geom';
import { fromHex, toHex } from '../core/color';
import { viewOptions, setViewOption } from '../core/viewport';
import { registerPanel } from '../ui/panels';
import { h } from '../ui/dom';
import { icon, registerIcons } from '../ui/icons';
import { button, checkbox, colorSwatch, iconButton, numberField, section, select, sliderRow } from '../ui/widgets';
import { toast } from '../ui/toast';
import { MODE_LABELS, canvasSize, docChanged, rotateCanvas, transformCanvas } from '../features/image/ops';

registerIcons({
  'pp-remove-bg': '<rect x="4" y="4" width="16" height="16" rx="1.5" stroke-dasharray="2.5 2"/><circle cx="12" cy="10" r="3" fill="currentColor" stroke="none"/><path d="M6.5 19c.8-3.2 3-5 5.5-5s4.7 1.8 5.5 5" fill="currentColor" stroke="none"/>',
  'pp-subject': '<path d="M4 8V4h4M16 4h4v4M20 16v4h-4M8 20H4v-4"/><circle cx="12" cy="9.5" r="2.6"/><path d="M7.5 18c.6-2.8 2.3-4.3 4.5-4.3s3.9 1.5 4.5 4.3"/>',
  'pp-mask-select': '<rect x="3.5" y="5.5" width="17" height="13" rx="1" stroke-dasharray="2.5 2"/><circle cx="12" cy="12" r="3.5"/>',
  'pp-mask-apply': '<rect x="3.5" y="5.5" width="17" height="13" rx="1"/><path d="m8.5 12 2.5 2.5 5-5"/>',
  'pp-mask-toggle': '<circle cx="12" cy="12" r="8"/><path d="M12 7v5"/>',
  'pp-invert': '<circle cx="12" cy="12" r="8"/><path d="M12 4a8 8 0 0 1 0 16z" fill="currentColor"/>',
});

// ================================================================== panel
const COLLAPSE_KEY = 'pixora.properties.collapsed';
const collapsed = new Set<string>((() => { try { return JSON.parse(localStorage.getItem(COLLAPSE_KEY) || '[]'); } catch { return []; } })());
const saveCollapsed = () => { try { localStorage.setItem(COLLAPSE_KEY, JSON.stringify([...collapsed])); } catch { /* ignore */ } };

const KIND_INFO: Record<string, [string, string]> = {
  raster: ['Pixel Layer', 'kind-pixel'], text: ['Type Layer', 'kind-type'], shape: ['Shape Layer', 'kind-shape'],
  group: ['Group', 'folder-outline'], smart: ['Smart Object', 'kind-smart'], frame: ['Frame', 'kind-shape'], artboard: ['Artboard', 'artboards'],
};
function contextOf(doc: PixDocument | null): { name: string; icon: string; layer: Layer | null; mask: boolean } {
  if (!doc) return { name: 'No Properties', icon: 'properties', layer: null, mask: false };
  const l = doc.activeLayer;
  if (l && doc.editMask && l.mask) return { name: 'Layer Mask', icon: 'mask', layer: l, mask: true };
  if (!l || (l.isBackground && doc.selectedIds.length <= 1)) return { name: 'Document', icon: 'document', layer: l && l.isBackground ? null : l, mask: false };
  if (doc.selectedIds.length > 1) return { name: 'Multiple Layers', icon: 'layers', layer: l, mask: false };
  if (l.kind === 'adjustment') { const t = (l as any).adjustment?.type; return { name: adjustments[t]?.label || l.name, icon: adjustments[t]?.icon || 'adjust-layer', layer: l, mask: false }; }
  if (l.kind === 'fill') { const f = (l as any).fill?.type; return { name: f === 'gradient' ? 'Gradient Fill' : f === 'pattern' ? 'Pattern Fill' : 'Solid Color', icon: 'kind-adjust', layer: l, mask: false }; }
  const k = KIND_INFO[l.kind] || [l.kind[0].toUpperCase() + l.kind.slice(1) + ' Layer', 'kind-pixel'];
  return { name: k[0], icon: k[1], layer: l, mask: false };
}

registerPanel({
  id: 'properties', title: 'Properties', icon: 'properties', defaultHeight: 305, minHeight: 120,
  create(el) {
    const headIcon = h('span.pp-head-icon');
    const headName = h('span.pp-head-name');
    const scroll = h('div.pp-scroll.panel-scroll');
    const root = h('div.pp', null, h('div.pp-head', null, headIcon, headName), scroll);
    el.append(root);
    let cleanups: (() => void)[] = [];
    let timer = 0, dirty = false, pointerIn = false, shown = true;
    const busy = () => pointerIn || (root.contains(document.activeElement) && (document.activeElement as HTMLElement).matches('input, textarea'));

    const rebuild = () => {
      clearTimeout(timer); timer = 0;
      if (!shown) { dirty = true; return; }
      if (busy()) { dirty = true; return; }
      dirty = false;
      const top = scroll.scrollTop;
      for (const c of cleanups) { try { c(); } catch (err) { console.error(err); } }
      cleanups = [];
      const doc = app.activeDoc, ctx = contextOf(doc);
      headIcon.replaceChildren(icon(ctx.icon, 18));
      headName.textContent = ctx.name;
      headName.title = ctx.name;
      scroll.replaceChildren();
      if (!doc) { scroll.append(h('div.pp-empty', null, 'No properties')); return; }
      const list = propertiesSections.filter(s => {
        if (ctx.mask !== (s.id === 'mask' || s.id.startsWith('mask-'))) return false;
        try { return s.match(doc, ctx.layer); } catch { return false; }
      });
      for (const s of list) {
        const body = h('div.pp-body');
        try {
          const c = s.build(body, doc, ctx.layer);
          if (typeof c === 'function') cleanups.push(c);
        } catch (err) { console.error(`[properties ${s.id}]`, err); body.append(h('div.pp-empty', null, 'This section failed to load.')); }
        if (!body.childNodes.length) continue;
        const sec = section(s.title, body, { collapsed: collapsed.has(s.id) });
        sec.classList.add('pp-section');
        sec.dataset.id = s.id;
        sec.querySelector('.section-head')!.addEventListener('click', () => { sec.classList.contains('collapsed') ? collapsed.add(s.id) : collapsed.delete(s.id); saveCollapsed(); });
        scroll.append(sec);
      }
      if (!scroll.childNodes.length) scroll.append(h('div.pp-empty', null, 'No properties'));
      scroll.scrollTop = top;
    };
    const later = (ms = 60) => { clearTimeout(timer); timer = window.setTimeout(rebuild, ms); };
    root.addEventListener('pointerdown', () => { pointerIn = true; const up = () => { pointerIn = false; window.removeEventListener('pointerup', up, true); if (dirty) later(120); }; window.addEventListener('pointerup', up, true); });
    root.addEventListener('focusout', () => setTimeout(() => { if (dirty && !busy()) later(); }));

    // context changes rebuild; value changes inside a context are handled by each section's own listeners
    let key = '';
    const ctxKey = () => { const d = app.activeDoc; const c = contextOf(d); return `${d?.id}|${c.name}|${c.layer?.id}|${d?.selectedIds.length}|${d?.editMask}|${!!c.layer?.mask}|${d?.mode}|${propertiesSections.length}`; };
    const onChange = (force: boolean) => { const k = ctxKey(); if (force || k !== key) { key = k; later(); } };
    const offs = [
      events.on('activeDoc', () => onChange(true)),
      events.on('activeLayer', () => onChange(false)),
      events.on('layers', () => onChange(true)),
      events.on('docSize', () => onChange(true)),
      events.on('history', () => onChange(false)),
    ];
    key = ctxKey();
    rebuild();
    return {
      onShow() { shown = true; if (dirty) rebuild(); },
      onHide() { shown = false; },
      destroy() { offs.forEach(f => f()); cleanups.forEach(c => c()); },
    };
  },
  menu: () => [
    { label: 'Expand All Sections', action: () => { collapsed.clear(); saveCollapsed(); document.querySelectorAll('.pp-section.collapsed').forEach(s => s.classList.remove('collapsed')); } },
    { label: 'Collapse All Sections', action: () => { document.querySelectorAll<HTMLElement>('.pp-section').forEach(s => { s.classList.add('collapsed'); collapsed.add(s.dataset.id!); }); saveCollapsed(); } },
  ],
});

// ================================================================== helpers
const RULER_UNITS: { value: Unit; label: string }[] = [
  { value: 'px', label: 'Pixels' }, { value: 'in', label: 'Inches' }, { value: 'cm', label: 'Centimeters' },
  { value: 'mm', label: 'Millimeters' }, { value: 'pt', label: 'Points' }, { value: '%', label: 'Percent' },
];
const rulerUnit = (): Unit => (app.prefs.rulerUnits || 'px') as Unit;
const unitSuffix = (u: Unit) => (u === '%' ? '%' : u === 'pica' ? 'pica' : u);
/** A number field showing a pixel length in the current ruler units. */
function lengthField(label: string, getPx: () => number, ref: () => number, set: (px: number) => void, o: { disabled?: boolean; min?: number; title?: string } = {}) {
  const doc = () => app.activeDoc!;
  const u = rulerUnit();
  const f = numberField(0, v => set(toPx(v, u, doc().resolution, ref())), { unit: unitSuffix(u), decimals: unitDecimals(u), width: 68, disabled: o.disabled, title: o.title || label, min: o.min });
  const sync = () => f.setValue(fromPx(getPx(), u, doc().resolution, ref()));
  sync();
  return { el: h('div.pp-field', null, h('span.pp-flabel', null, label), f), sync, field: f };
}
const hasCmd = (id: string) => commands.has(id);
const cmdButton = (label: string, id: string, arg?: any, title?: string) => {
  const b = button(label, () => runCommand(id, arg), { cls: 'pp-btn', title: title || label });
  if (!hasCmd(id)) { b.disabled = true; b.title = `${label} (not available)`; }
  return b;
};
function fmtRes(doc: PixDocument) {
  const v = doc.resolutionUnit === 'ppcm' ? doc.resolution / 2.54 : doc.resolution;
  return `${Math.round(v * 100) / 100} ${doc.resolutionUnit === 'ppcm' ? 'pixels/centimeter' : 'pixels/inch'}`;
}
const isDocContext = (doc: PixDocument, layer: Layer | null) => !layer && (!doc.activeLayer || doc.activeLayer.isBackground || !doc.activeLayer);

// ------------------------------------------------------------------ canvas fill (extension colour for panel edits)
type CanvasFill = 'white' | 'black' | 'bg' | 'custom';
function canvasFill(doc: PixDocument): { type: CanvasFill; color: RGB } {
  const f = doc.extra.canvasFill;
  return f && f.type ? f : { type: 'white', color: { r: 255, g: 255, b: 255 } };
}
const fillRGB = (f: { type: CanvasFill; color: RGB }): RGB => (f.type === 'black' ? { r: 0, g: 0, b: 0 } : f.type === 'bg' ? app.bg : f.type === 'custom' ? f.color : { r: 255, g: 255, b: 255 });

// ================================================================== DOCUMENT sections
registerPropertiesSection({
  id: 'doc-canvas', title: 'Canvas', order: 10,
  match: isDocContext,
  build(el, doc) {
    let linked = !!doc.extra.propsLinkWH;
    const setSize = (w: number, hh: number) => {
      w = Math.max(1, Math.min(300000, Math.round(w))); hh = Math.max(1, Math.min(300000, Math.round(hh)));
      if (w === doc.width && hh === doc.height) { W.sync(); H.sync(); return; }
      doc.history.transaction('Canvas Size', () => canvasSize(doc, w, hh, { ax: 0.5, ay: 0.5 }, fillRGB(canvasFill(doc))), 'image');
      docChanged(doc);
    };
    const W = lengthField('W', () => doc.width, () => doc.width, px => setSize(px, linked ? (px * doc.height) / doc.width : doc.height), { min: 0, title: 'Canvas width' });
    const H = lengthField('H', () => doc.height, () => doc.height, px => setSize(linked ? (px * doc.width) / doc.height : doc.width, px), { min: 0, title: 'Canvas height' });
    const X = lengthField('X', () => 0, () => doc.width, () => {}, { disabled: true });
    const Y = lengthField('Y', () => 0, () => doc.height, () => {}, { disabled: true });
    const link = iconButton('link-v', 'Link width and height', () => { linked = !linked; doc.extra.propsLinkWH = linked; link.classList.toggle('active', linked); }, { size: 16, cls: 'pp-link', active: linked });
    const orient = (portrait: boolean) => {
      const active = portrait ? doc.height > doc.width : doc.width >= doc.height;
      return iconButton(portrait ? 'portrait' : 'landscape', portrait ? 'Portrait' : 'Landscape', () => {
        if (active || doc.width === doc.height) return;
        doc.history.transaction('Rotate Canvas', () => rotateCanvas(doc, 90, fillRGB(canvasFill(doc))), 'image');
        docChanged(doc);
      }, { size: 20, cls: 'pp-orient', active });
    };
    const res = h('button.pp-res', { type: 'button', title: `Resolution: ${fmtRes(doc)} — click to change it (Image Size)` }, `Resolution: ${fmtRes(doc)}`);
    res.addEventListener('click', () => runCommand('image.imageSize'));

    const modes: ColorMode[] = ['Bitmap', 'Grayscale', 'Duotone', 'Indexed', 'RGB', 'CMYK', 'Lab', 'Multichannel'];
    const mode = select(modes.map(m => ({ value: m, label: MODE_LABELS[m] })), doc.mode, async m => { await runCommand('image.mode', m); mode.setValue(doc.mode); }, { width: 128, title: 'Color mode' });
    const bits = select([{ value: 8, label: '8 Bits/Channel' }, { value: 16, label: '16 Bits/Channel' }, { value: 32, label: '32 Bits/Channel' }], doc.bitDepth, b => runCommand('image.bitDepth', b), { width: 128, title: 'Bit depth' });

    const hasBg = doc.layers.some(l => l.isBackground);
    const cf = canvasFill(doc);
    const sw = colorSwatch(fillRGB(cf), c => { doc.extra.canvasFill = { type: 'custom', color: c }; fillSel.setValue('custom'); }, { title: 'Canvas extension color', size: 20 });
    const fillSel = select<CanvasFill | 'transparent'>(hasBg
      ? [{ value: 'white', label: 'White' }, { value: 'black', label: 'Black' }, { value: 'bg', label: 'Background Color' }, { value: 'custom', label: 'Custom Color...' }]
      : [{ value: 'transparent', label: 'Transparent' }],
      hasBg ? cf.type : 'transparent', async v => {
        if (v === 'transparent') return;
        let color = cf.color;
        if (v === 'custom') { const { hooks } = await import('../core/registry'); const c = await hooks.openColorPicker(color, 'Color Picker (Canvas Color)'); if (!c) { fillSel.setValue(canvasFill(doc).type); return; } color = c; }
        doc.extra.canvasFill = { type: v, color };
        sw.setValue(fillRGB(doc.extra.canvasFill));
      }, { width: 128, title: 'Color used when the canvas is enlarged or rotated from this panel' });
    if (!hasBg) { sw.setAttribute('disabled', ''); sw.style.background = 'var(--checker)'; }

    el.append(h('div.pp-canvas', null,
      h('div.pp-whxy', null, h('div.pp-linkcol', null, link), h('div.pp-grid2', null, W.el, X.el, H.el, Y.el)),
      h('div.pp-orients', null, orient(true), orient(false)),
      h('div.pp-resrow', null, res),
      h('div.pp-row', null, h('span.pp-label', null, 'Mode'), mode, bits),
      h('div.pp-row', null, h('span.pp-label', null, 'Fill'), sw, fillSel)));
    const off = events.on('prefs', () => { W.sync(); H.sync(); });
    return off;
  },
});

registerPropertiesSection({
  id: 'doc-rulers', title: 'Rulers & Grids', order: 12,
  match: isDocContext,
  build(el) {
    const units = select(RULER_UNITS, rulerUnit(), u => app.setPrefs({ rulerUnits: u as any }), { width: 128, title: 'Ruler units' });
    const rulers = checkbox('Rulers', viewOptions.rulers, v => setViewOption('rulers', v), { title: 'Show rulers (Ctrl+R)' });
    const grid = checkbox('Grid', viewOptions.grid, v => setViewOption('grid', v), { title: "Show grid (Ctrl+')" });
    const gc = colorSwatch(fromHex(app.prefs.gridColor) || { r: 158, g: 158, b: 158 }, c => app.setPrefs({ gridColor: toHex(c) }), { title: 'Grid color', size: 20 });
    const spacing = numberField(app.prefs.gridSpacing, v => app.setPrefs({ gridSpacing: v }), { min: 1, max: 10000, unit: 'px', width: 68, title: 'Gridline every' });
    const sub = numberField(app.prefs.gridSubdivisions, v => app.setPrefs({ gridSubdivisions: v }), { min: 1, max: 100, width: 48, title: 'Subdivisions' });
    el.append(h('div.pp-stack', null,
      h('div.pp-row', null, h('span.pp-label', null, 'Units'), units),
      h('div.pp-row', null, h('span.pp-label'), rulers, grid),
      h('div.pp-row', null, h('span.pp-label', null, 'Grid'), gc, spacing, h('span.pp-dim', null, 'Subdiv.'), sub)));
    const off = events.on('view', () => { rulers.setValue(viewOptions.rulers); grid.setValue(viewOptions.grid); });
    return off;
  },
});

registerPropertiesSection({
  id: 'doc-guides', title: 'Guides', order: 14,
  match: isDocContext,
  build(el, doc) {
    const count = h('span.pp-dim');
    const sync = () => { count.textContent = doc.guides.length === 1 ? '1 guide' : `${doc.guides.length} guides`; };
    sync();
    const gc = colorSwatch(fromHex(app.prefs.guideColor) || { r: 74, g: 255, b: 255 }, c => app.setPrefs({ guideColor: toHex(c) }), { title: 'Guide color', size: 20 });
    const show = checkbox('Show', viewOptions.guides, v => setViewOption('guides', v), { title: 'Show guides (Ctrl+;)' });
    const lock = checkbox('Lock', viewOptions.lockGuides, v => setViewOption('lockGuides', v), { title: 'Lock guides (Alt+Ctrl+;)' });
    const clear = button('Clear', () => {
      if (hasCmd('view.clearGuides')) { runCommand('view.clearGuides'); return; }
      if (!doc.guides.length) return;
      doc.history.transaction('Clear Guides', () => { doc.guides = []; });
      events.emit('guides', doc); doc.redrawOverlay();
    }, { cls: 'pp-btn', title: 'Remove all guides' });
    el.append(h('div.pp-stack', null,
      h('div.pp-row', null, h('span.pp-label', null, 'Color'), gc, show, lock, count),
      h('div.pp-row', null, h('span.pp-label'), cmdButton('New Guide Layout...', 'view.newGuideLayout'), clear)));
    const offs = [events.on('guides', d => { if (d === doc) sync(); }), events.on('view', () => { show.setValue(viewOptions.guides); lock.setValue(viewOptions.lockGuides); })];
    return () => offs.forEach(f => f());
  },
});

// ------------------------------------------------------------------ Remove Background (Select Subject → layer mask)
async function removeBackground(doc: PixDocument) {
  const l = doc.activeLayer;
  if (!l || !(l instanceof RasterLayer || l.kind === 'smart')) { toast('Remove Background works on a pixel layer or smart object.', 'error'); return; }
  if (l.locks.all) { toast('Could not complete your request because the layer is locked.', 'error'); return; }
  let sel: HTMLCanvasElement | null = null;
  if (hasCmd('select.subject')) {
    const prevSel = doc.selection.mask;
    await runCommand('select.subject');
    if (doc.selection.mask !== prevSel && !doc.selection.empty) sel = doc.selection.mask;
  } else {
    // fall back to the subject detector directly (Select Subject command not registered)
    try {
      document.body.classList.add('busy');
      await new Promise(requestAnimationFrame);
      const { detectSubject } = await import('../features/selection/ops');
      const a = detectSubject(doc, true);
      if (a) {
        const img = new ImageData(doc.width, doc.height);
        for (let i = 0; i < a.length; i++) img.data[i * 4 + 3] = a[i];
        sel = createCanvas(doc.width, doc.height); ctx2d(sel).putImageData(img, 0, 0);
      }
    } catch (err) { console.error(err); }
    finally { document.body.classList.remove('busy'); }
  }
  if (!sel) { toast('No subject was found.', 'info'); return; }
  const selCanvas = sel;
  doc.history.transaction('Remove Background', () => {
    if (l.isBackground) { l.isBackground = false; l.name = 'Layer 0'; l.locks = { ...l.locks, position: false }; }
    const c = createCanvas(doc.width, doc.height);
    ctx2d(c).drawImage(selCanvas, 0, 0);
    l.mask = { canvas: c, x: 0, y: 0, bg: 0, enabled: true, linked: true, density: 1, feather: 0 };
    doc.selection.setMask(null);
  }, 'mask');
  l.invalidate();
  doc.layersChanged();
  events.emit('activeLayer', doc);
}

registerPropertiesSection({
  id: 'doc-quick', title: 'Quick Actions', order: 16,
  match: isDocContext,
  build(el, doc) {
    const bg = doc.layers.find(l => l.isBackground) || doc.activeLayer;
    el.append(h('div.pp-quick', null,
      cmdButton('Trim', 'image.trim', undefined, 'Trim transparent or solid-color edges (Image › Trim)'),
      cmdButton('Image Size', 'image.imageSize', undefined, 'Image › Image Size (Alt+Ctrl+I)'),
      button('Crop', () => { if (app.tools.has('crop')) app.setTool('crop'); else toast('The Crop tool is not available.'); }, { cls: 'pp-btn', title: 'Crop tool (C)' }),
      cmdButton('Rotate', 'image.rotate', 90, 'Rotate the canvas 90° clockwise'),
      button('Remove Background', () => { if (bg && bg !== doc.activeLayer) doc.setActiveLayer(bg); removeBackground(doc); }, { cls: 'pp-btn', title: 'Mask the background of the image using Select Subject' }),
      cmdButton('Select Subject', 'select.subject', undefined, 'Select the most prominent subject'),
      cmdButton('Auto Tone', 'image.autoTone', undefined, 'Image › Auto Tone (Shift+Ctrl+L)')));
  },
});

// ================================================================== LAYER sections
const TRANSFORM_KINDS = new Set(['raster', 'text', 'shape', 'smart', 'group', 'frame']);
const layerContext = (doc: PixDocument, layer: Layer | null) => !!layer && !layer.isBackground && TRANSFORM_KINDS.has(layer.kind);

/** Transform one layer (content, linked mask) by an affine matrix in doc space. */
function transformLayer(doc: PixDocument, l: Layer, m: DOMMatrix, scale: boolean) {
  if (l instanceof GroupLayer) { for (const ch of l.children) transformLayer(doc, ch, m, scale); }
  else if (l instanceof RasterLayer) {
    const r = transformCanvas(l.canvas, l.x, l.y, m, { resample: scale ? 'bicubic' : null });
    l.canvas = r.canvas; l.x = r.x; l.y = r.y;
  } else if (typeof (l as any).applyMatrix === 'function') {
    const mk = l.mask; l.mask = null;
    try { (l as any).applyMatrix(m); } finally { l.mask = mk; }
  } else if (m.a === 1 && m.b === 0 && m.c === 0 && m.d === 1) {
    const mk = l.mask; l.mask = null;
    try { l.translate(m.e, m.f); } finally { l.mask = mk; }
  }
  if (l.mask && l.mask.linked) {
    const mk: LayerMask = l.mask;
    const r = transformCanvas(mk.canvas, mk.x, mk.y, m, { resample: scale ? 'bilinear' : null, maskBg: mk.bg });
    mk.canvas = r.canvas; mk.x = r.x; mk.y = r.y;
  }
  l.invalidate();
}
function selBounds(doc: PixDocument, layers: Layer[]): Rect | null {
  let r: Rect | null = null;
  for (const l of layers) r = unionRect(r, doc.layerBounds(l));
  return r;
}
const topLevel = (doc: PixDocument) => {
  const sel = doc.selectedLayers, set = new Set(sel);
  return sel.filter(l => { for (let p = l._parent; p; p = p._parent) if (set.has(p)) return false; return true; });
};

registerPropertiesSection({
  id: 'pixel-transform', title: 'Transform', order: 10,
  match: (doc, layer) => layerContext(doc, layer) && !(layer!.kind === 'smart' && propertiesSections.some(s => s.id === 'smart')),
  build(el, doc) {
    let linked = false;
    const layers = () => topLevel(doc).filter(l => !l.isBackground && TRANSFORM_KINDS.has(l.kind));
    const bounds = () => selBounds(doc, layers()) || { x: 0, y: 0, w: 0, h: 0 };
    const apply = (name: string, m: DOMMatrix, scale: boolean) => {
      const ls = layers();
      if (!ls.length) return;
      if (ls.some(l => l.positionLocked)) { toast('Could not complete your request because the layer is locked.', 'error'); sync(); return; }
      document.body.classList.add('busy');
      try { doc.history.transaction(name, () => { for (const l of ls) transformLayer(doc, l, m, scale); }, 'transform'); }
      finally { document.body.classList.remove('busy'); }
      doc.pixelsChanged(null, null); doc.layersChanged();
      sync();
    };
    const scaleTo = (w: number, hh: number) => {
      const b = bounds();
      if (!b.w || !b.h || w < 1 || hh < 1) { sync(); return; }
      apply('Transform', new DOMMatrix().translate(b.x, b.y).scale(w / b.w, hh / b.h).translate(-b.x, -b.y), true);
    };
    const W = lengthField('W', () => bounds().w, () => bounds().w, px => { const b = bounds(); scaleTo(px, linked && b.w ? (b.h * px) / b.w : b.h); }, { min: 1, title: 'Width' });
    const H = lengthField('H', () => bounds().h, () => bounds().h, px => { const b = bounds(); scaleTo(linked && b.h ? (b.w * px) / b.h : b.w, px); }, { min: 1, title: 'Height' });
    const X = lengthField('X', () => bounds().x, () => doc.width, px => { const b = bounds(); const d = Math.round(px - b.x); if (d) apply('Move', new DOMMatrix().translate(d, 0), false); }, { title: 'X position' });
    const Y = lengthField('Y', () => bounds().y, () => doc.height, px => { const b = bounds(); const d = Math.round(px - b.y); if (d) apply('Move', new DOMMatrix().translate(0, d), false); }, { title: 'Y position' });
    const link = iconButton('link-v', 'Link width and height', () => { linked = !linked; link.classList.toggle('active', linked); }, { size: 16, cls: 'pp-link' });
    const angle = numberField(0, v => {
      angle.setValue(0);
      if (!v) return;
      const b = bounds(), cx = b.x + b.w / 2, cy = b.y + b.h / 2;
      apply('Rotate', new DOMMatrix().translate(cx, cy).rotate(v).translate(-cx, -cy), true);
    }, { unit: '°', decimals: 2, min: -360, max: 360, width: 68, title: 'Rotate by angle (clockwise)' });
    const flip = (hz: boolean) => iconButton(hz ? 'flip-h' : 'flip-v', hz ? 'Flip horizontal' : 'Flip vertical', () => {
      const b = bounds(), cx = b.x + b.w / 2, cy = b.y + b.h / 2;
      apply(hz ? 'Flip Horizontal' : 'Flip Vertical', hz ? new DOMMatrix([-1, 0, 0, 1, 2 * Math.round(cx * 2) / 2, 0]) : new DOMMatrix([1, 0, 0, -1, 0, 2 * Math.round(cy * 2) / 2]), false);
    }, { size: 18, cls: 'pp-orient' });
    const sync = () => { W.sync(); H.sync(); X.sync(); Y.sync(); };
    el.append(h('div.pp-canvas', null,
      h('div.pp-whxy', null, h('div.pp-linkcol', null, link), h('div.pp-grid2', null, W.el, X.el, H.el, Y.el)),
      h('div.pp-row.pp-angle', null, h('span.pp-flabel', null, icon('angle', 14)), angle, h('span.pp-gap'), flip(true), flip(false))));
    let t = 0;
    const later = () => { clearTimeout(t); t = window.setTimeout(sync, 120); };
    const offs = [events.on('layers', d => { if (d === doc) later(); }), events.on('pixels', e => { if (e.doc === doc) later(); }), events.on('prefs', later)];
    return () => { clearTimeout(t); offs.forEach(f => f()); };
  },
});

registerPropertiesSection({
  id: 'pixel-align', title: 'Align and Distribute', order: 12,
  match: layerContext,
  build(el) {
    const b = (ic: string, title: string, id: string, arg: string, mirror = '') => {
      const btn = iconButton(ic, title, () => runCommand(id, arg), { size: 18, cls: 'pp-abtn' });
      if (mirror) (btn.firstElementChild as SVGElement).style.transform = mirror;
      if (!hasCmd(id)) btn.disabled = true;
      return btn;
    };
    el.append(h('div.pp-stack', null,
      h('div.pp-sub', null, 'Align:'),
      h('div.pp-align', null,
        b('align-left', 'Align left edges', 'layer.align', 'left'), b('align-hcenter', 'Align horizontal centers', 'layer.align', 'hcenter'), b('align-right', 'Align right edges', 'layer.align', 'right'),
        h('span.pp-gap'),
        b('align-top', 'Align top edges', 'layer.align', 'top'), b('align-vcenter', 'Align vertical centers', 'layer.align', 'vcenter'), b('align-bottom', 'Align bottom edges', 'layer.align', 'bottom')),
      h('div.pp-sub', null, 'Distribute:'),
      h('div.pp-align', null,
        b('distribute-left', 'Distribute left edges', 'layer.distribute', 'left'), b('distribute-horizontal', 'Distribute horizontal centers', 'layer.distribute', 'hcenter'), b('distribute-left', 'Distribute right edges', 'layer.distribute', 'right', 'scaleX(-1)'),
        h('span.pp-gap'),
        b('distribute-top', 'Distribute top edges', 'layer.distribute', 'top'), b('distribute-vertical', 'Distribute vertical centers', 'layer.distribute', 'vcenter'), b('distribute-top', 'Distribute bottom edges', 'layer.distribute', 'bottom', 'scaleY(-1)')),
      h('div.pp-note', null, 'With one layer selected, layers align to the selection or the canvas.')));
  },
});

registerPropertiesSection({
  id: 'pixel-quick', title: 'Quick Actions', order: 30,
  match: (doc, layer) => !!layer && !layer.isBackground && doc.selectedIds.length <= 1 && (layer.kind === 'raster' || layer.kind === 'smart'),
  build(el, doc, layer) {
    el.append(h('div.pp-quick', null,
      button('Remove Background', () => removeBackground(doc), { cls: 'pp-btn', title: 'Mask the background of this layer using Select Subject' }),
      cmdButton('Select Subject', 'select.subject', undefined, 'Select the most prominent subject'),
      layer!.kind === 'raster' ? cmdButton('Convert to Smart Object', 'layer.toSmartObject', undefined, 'Layer › Smart Objects › Convert to Smart Object') : null));
  },
});

// ================================================================== MASK section
function maskToDocSelection(doc: PixDocument, mk: LayerMask): HTMLCanvasElement {
  const c = createCanvas(doc.width, doc.height), x = ctx2d(c);
  if (mk.bg === 255) { x.fillStyle = '#000'; x.fillRect(0, 0, c.width, c.height); x.clearRect(mk.x, mk.y, mk.canvas.width, mk.canvas.height); }
  x.drawImage(mk.canvas, mk.x, mk.y);
  return c;
}
registerPropertiesSection({
  id: 'mask', title: 'Layer Mask', order: 10,
  match: (doc, layer) => !!layer?.mask && doc.editMask,
  build(el, doc, layer) {
    const l = layer!, mk = () => l.mask!;
    let live: { commit(n?: string): void; cancel(): void } | null = null;
    const edit = (name: string, fn: () => void, final: boolean) => {
      if (!l.mask) return;
      if (!live) live = doc.history.begin(name, 'mask');
      fn(); l.invalidate(); doc.invalidate();
      if (final) { live.commit(name); live = null; doc.layersChanged(); }
    };
    const density = sliderRow('Density:', Math.round(mk().density * 100), 0, 100, (v, final) => edit('Mask Density', () => { mk().density = v / 100; }, final), { unit: '%' });
    const feather = sliderRow('Feather:', mk().feather, 0, 1000, (v, final) => edit('Mask Feather', () => { mk().feather = v; }, final), { unit: 'px', decimals: 1, step: 0.1 });
    const invert = () => {
      doc.history.transaction('Invert', () => {
        const m = mk(), c = createCanvas(m.canvas.width, m.canvas.height), x = ctx2d(c);
        x.fillStyle = '#000'; x.fillRect(0, 0, c.width, c.height);
        x.globalCompositeOperation = 'destination-out'; x.drawImage(m.canvas, 0, 0);
        l.mask = { ...m, canvas: c, bg: m.bg === 255 ? 0 : 255 };
      }, 'mask');
      l.invalidate(); doc.layersChanged();
    };
    const foot = (ic: string, title: string, fn: () => void) => iconButton(ic, title, fn, { size: 18 });
    const status = h('span.pp-dim', null, mk().enabled ? '' : 'Mask disabled');
    el.append(h('div.pp-stack', null,
      h('div.pp-row', null, icon('mask', 18), h('span', null, 'Pixel Mask'), h('span.pp-spacer'), status),
      density, feather,
      h('div.pp-row', null, h('span.pp-label', null, 'Refine:')),
      h('div.pp-quick', null,
        cmdButton('Select and Mask...', 'select.selectAndMask', undefined, 'Refine the mask edge (Alt+Ctrl+R)'),
        cmdButton('Color Range...', 'select.colorRange', undefined, 'Build the mask from a color range'),
        button('Invert', invert, { cls: 'pp-btn', title: 'Invert the mask' })),
      h('div.pp-footer', null,
        foot('pp-mask-select', 'Load selection from mask', () => {
          doc.history.transaction('Load Selection', () => doc.selection.setMask(maskToDocSelection(doc, mk())), 'selection');
        }),
        foot('pp-mask-apply', 'Apply mask', () => {
          if (!(l instanceof RasterLayer)) { toast('The mask can only be applied to a pixel layer.', 'error'); return; }
          doc.history.transaction('Apply Layer Mask', () => {
            const m = mk(), c = cloneCanvas(l.canvas), x = ctx2d(c);
            const sel = createCanvas(c.width, c.height), sx = ctx2d(sel);
            if (m.bg === 255) { sx.fillStyle = '#000'; sx.fillRect(0, 0, c.width, c.height); sx.clearRect(m.x - l.x, m.y - l.y, m.canvas.width, m.canvas.height); }
            sx.drawImage(m.canvas, m.x - l.x, m.y - l.y);
            x.globalCompositeOperation = 'destination-in'; x.drawImage(sel, 0, 0);
            l.canvas = c; l.mask = null; doc.editMask = false;
          }, 'mask');
          l.invalidate(); doc.layersChanged(); events.emit('activeLayer', doc);
        }),
        foot('pp-mask-toggle', mk().enabled ? 'Disable mask' : 'Enable mask', () => {
          const on = !mk().enabled;
          doc.history.transaction(on ? 'Enable Layer Mask' : 'Disable Layer Mask', () => { l.mask = { ...mk(), enabled: on }; }, 'mask');
          l.invalidate(); doc.layersChanged();
        }),
        foot('trash', 'Delete mask', () => {
          doc.history.transaction('Delete Layer Mask', () => { l.mask = null; doc.editMask = false; }, 'mask');
          l.invalidate(); doc.layersChanged(); events.emit('activeLayer', doc);
        }))));
    return () => { if (live) { live.commit(); live = null; } };
  },
});
