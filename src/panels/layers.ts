// Layers panel (Window › Layers, F7): filter bar, blend mode / opacity / locks / fill, the layer list
// (visibility, thumbnails, masks, clipping, groups, effects, rename, drag & drop) and the bottom button bar.
import { app } from '../core/app';
import { events } from '../core/events';
import type { PixDocument } from '../core/document';
import { AdjustmentLayer, GroupLayer, Layer, RasterLayer } from '../core/layer';
import type { BlendMode, EffectType, LayerLocks } from '../core/types';
import { BLEND_MODE_LABELS } from '../core/types';
import { adjustments, hooks } from '../core/registry';
import { commands, isCommandEnabled, runCommand } from '../core/commands';
import { createCanvas, ctx2d } from '../core/canvas';
import { registerPanel } from '../ui/panels';
import { h, dragPointer, placeFloating } from '../ui/dom';
import { icon } from '../ui/icons';
import { iconButton, numberField, select, slider, checkbox, type Field } from '../ui/widgets';
import { openMenu, contextMenu, type MenuEntry } from '../ui/menu';
import { openDialog } from '../ui/dialog';
import { isPanelVisible } from '../ui/dock';
import {
  EFFECT_LABELS, EFFECT_ORDER, LABEL_COLORS, blendOptions, labelCss, layersPrefs, layersUI, liveEditor, maskDocCanvas, opFromEvent,
  panelOrder, saveLayersPrefs, selectLayers, topSelected, copyName, unBackground,
} from '../features/layers/shared';
import { FillLayer } from '../layers/fill-layer';
import { SmartObjectLayer, editContents } from '../layers/smart-object';
import './layers.css';

// ------------------------------------------------------------------ constants
const THUMB: Record<string, number> = { none: 0, small: 20, medium: 38, large: 62 };
const ROW_H: Record<string, number> = { none: 26, small: 30, medium: 42, large: 68 };
type FilterMode = 'kind' | 'name' | 'effect' | 'mode' | 'attribute' | 'color' | 'smart' | 'selected';
const FILTER_MODES: { value: FilterMode; label: string }[] = [
  { value: 'kind', label: 'Kind' }, { value: 'name', label: 'Name' }, { value: 'effect', label: 'Effect' }, { value: 'mode', label: 'Mode' },
  { value: 'attribute', label: 'Attribute' }, { value: 'color', label: 'Color' }, { value: 'smart', label: 'Smart Object' }, { value: 'selected', label: 'Selected' },
];
const KIND_FILTERS: { id: string; icon: string; title: string; test: (l: Layer) => boolean }[] = [
  { id: 'pixel', icon: 'kind-pixel', title: 'Filter for pixel layers', test: l => l.kind === 'raster' },
  { id: 'adjust', icon: 'kind-adjust', title: 'Filter for adjustment layers', test: l => l.kind === 'adjustment' || l.kind === 'fill' },
  { id: 'type', icon: 'kind-type', title: 'Filter for type layers', test: l => l.kind === 'text' },
  { id: 'shape', icon: 'kind-shape', title: 'Filter for shape layers', test: l => l.kind === 'shape' },
  { id: 'smart', icon: 'kind-smart', title: 'Filter for smart objects', test: l => l.kind === 'smart' },
];
const ATTRS: { value: string; label: string; test: (l: Layer) => boolean }[] = [
  { value: 'visible', label: 'Visible', test: l => l.visible },
  { value: 'invisible', label: 'Invisible', test: l => !l.visible },
  { value: 'locked', label: 'Locked', test: l => l.locks.all || l.locks.pixels || l.locks.position || l.locks.transparency || l.isBackground },
  { value: 'unlocked', label: 'Unlocked', test: l => !(l.locks.all || l.locks.pixels || l.locks.position || l.locks.transparency || l.isBackground) },
  { value: 'empty', label: 'Empty', test: l => l instanceof RasterLayer && !app.activeDoc?.layerBounds(l) },
  { value: 'linked', label: 'Linked', test: l => !!l.linkId },
  { value: 'clipped', label: 'Clipped', test: l => l.clipped },
  { value: 'mask', label: 'Layer Mask', test: l => !!l.mask },
  { value: 'effects', label: 'Layer Effects', test: l => l.effects.length > 0 },
  { value: 'advanced', label: 'Advanced Blending', test: l => l.fillOpacity < 1 },
];
const ADJ_MENU: ([string, string] | '-')[] = [
  ['Brightness/Contrast...', 'brightness-contrast'], ['Levels...', 'levels'], ['Curves...', 'curves'], ['Exposure...', 'exposure'], '-',
  ['Vibrance...', 'vibrance'], ['Hue/Saturation...', 'hue-saturation'], ['Color Balance...', 'color-balance'], ['Black & White...', 'black-white'],
  ['Photo Filter...', 'photo-filter'], ['Channel Mixer...', 'channel-mixer'], ['Color Lookup...', 'color-lookup'], '-',
  ['Invert', 'invert'], ['Posterize...', 'posterize'], ['Threshold...', 'threshold'], ['Gradient Map...', 'gradient-map'], ['Selective Color...', 'selective-color'],
];

// ------------------------------------------------------------------ helpers
const canvasIds = new WeakMap<HTMLCanvasElement, number>();
let cid = 0;
const idOf = (c: HTMLCanvasElement | null | undefined) => { if (!c) return 0; let i = canvasIds.get(c); if (!i) canvasIds.set(c, (i = ++cid)); return i; };
const dpr = () => Math.min(2, window.devicePixelRatio || 1);
function openStyle(l: Layer, effect?: string) {
  if (commands.has('layer.style')) runCommand('layer.style', effect || 'blending');
  else hooks.openLayerStyle(l, effect);
}
function isBase(doc: PixDocument, l: Layer) { const s = doc.siblingsOf(l); const n = s[s.indexOf(l) + 1]; return !l.clipped && !!n && n.clipped; }

/** Percent field with scrubby label + popup slider, live preview (one history state per gesture). */
function pctField(label: string, title: string, onEdit: (v: number, final: boolean) => void): Field<number> & { setDisabled(b: boolean): void } {
  const num = numberField(100, v => onEdit(v, true), { min: 0, max: 100, unit: '%', label, title, onInput: v => onEdit(v, false) });
  const arrow = h('button.popup-arrow', { type: 'button', title, 'data-menu-anchor': '' }, icon('chevron-down', 12));
  const el = h('span.lp-pct', { title }, num, arrow) as unknown as Field<number> & { setDisabled(b: boolean): void };
  arrow.addEventListener('click', () => {
    const pop = h('div.popup-slider-pop.lp-pct-pop');
    const sl = slider(num.getValue(), 0, 100, v => { num.setValue(v); onEdit(v, false); }, { onChange: v => onEdit(v, true), width: 150 });
    pop.appendChild(sl);
    document.body.appendChild(pop);
    placeFloating(pop, arrow.getBoundingClientRect());
    const off = (e: PointerEvent) => { if (!pop.contains(e.target as Node) && e.target !== arrow) { pop.remove(); window.removeEventListener('pointerdown', off, true); } };
    setTimeout(() => window.addEventListener('pointerdown', off, true));
  });
  el.setValue = v => num.setValue(v);
  el.getValue = () => num.getValue();
  el.setDisabled = b => el.classList.toggle('lp-dim', b);
  return el;
}

interface Drop { parent: GroupLayer | null; anchor: Layer | null; place: 'above' | 'below' | 'into' | 'bottom' }

// ------------------------------------------------------------------ panel
class LayersPanel {
  root: HTMLElement;
  list: HTMLElement;
  fctl = h('div.lp-fctl');
  pill: HTMLButtonElement;
  blendHost = h('span');
  blendSel: Field<BlendMode> | null = null;
  blendIsGroup = false;
  opacity: ReturnType<typeof pctField>;
  fill: ReturnType<typeof pctField>;
  lockBtns: Record<keyof LayerLocks, HTMLButtonElement> = {} as any;
  blendRow: HTMLElement;
  lockRow: HTMLElement;
  footer: HTMLElement;
  filter = { on: false, mode: 'kind' as FilterMode, kinds: new Set<string>(), name: '', effect: 'dropShadow' as EffectType, blend: 'normal' as BlendMode, attr: 'visible', color: 'red', smart: 'embedded' };
  thumbKeys = new WeakMap<HTMLCanvasElement, string>();
  thumbs = new WeakMap<Layer, HTMLCanvasElement>();
  mthumbs = new WeakMap<Layer, HTMLCanvasElement>();
  fxOpen = new Set<number>();
  solo = new WeakMap<PixDocument, { id: number; vis: Map<Layer, boolean> }>();
  lastActive = 0;
  lastDoc: PixDocument | null = null;
  pending = false;
  thumbTimer = 0;
  renaming: number | null = null;
  anyGroups = false;
  shown = true;
  editOpacity: ((fn: () => void, final: boolean) => void) | null = null;
  editFill: ((fn: () => void, final: boolean) => void) | null = null;
  editDoc: PixDocument | null = null;

  constructor(el: HTMLElement) {
    this.root = h('div.lp');
    // ---- filter bar
    const kindSel = select(FILTER_MODES, this.filter.mode, m => { this.filter.mode = m; this.filter.on = true; this.buildFilterControls(); this.schedule(); }, { title: 'Pick a filter type' });
    this.pill = h('button.lp-pill', { type: 'button', title: 'Turn layer filtering on/off' }) as HTMLButtonElement;
    this.pill.addEventListener('click', () => { this.filter.on = !this.filter.on; this.buildFilterControls(); this.schedule(); });
    const filterBar = h('div.lp-bar.lp-fbar', null, h('span.lp-kind', null, icon('search', 13, 'lp-search'), kindSel), this.fctl, this.pill);
    // ---- blend + opacity
    this.opacity = pctField('Opacity:', 'Opacity', (v, final) => this.editPct('opacity', v, final));
    this.blendRow = h('div.lp-bar', null, this.blendHost, this.opacity);
    // ---- locks + fill
    const lockDefs: [keyof LayerLocks, string, string][] = [
      ['transparency', 'lock-transparency', 'Lock transparent pixels'], ['pixels', 'lock-pixels', 'Lock image pixels'],
      ['position', 'lock-position', 'Lock position'], ['artboard', 'lock-artboard', 'Prevent auto-nesting into and out of artboards and frames'], ['all', 'lock', 'Lock all'],
    ];
    const locks = h('span.lp-locks', null, ...lockDefs.map(([k, ic, title]) => (this.lockBtns[k] = iconButton(ic, title, () => this.toggleLock(k)))));
    this.fill = pctField('Fill:', 'Fill opacity', (v, final) => this.editPct('fillOpacity', v, final));
    this.lockRow = h('div.lp-bar', null, h('span.lp-lockwrap', null, h('span.lp-lbl', null, 'Lock:'), locks), this.fill);
    // ---- list
    this.list = h('div.lp-list', { tabindex: -1 });
    this.list.addEventListener('contextmenu', e => { if (!(e.target as Element).closest('.lp-row')) contextMenu(e as MouseEvent, this.panelMenu()); });
    this.list.addEventListener('pointerdown', e => {
      if (e.target === this.list && !e.shiftKey && !e.ctrlKey) { /* click on empty space keeps the selection like PS */ }
    });
    // ---- footer
    this.footer = h('div.panel-footer.lp-footer', null,
      iconButton('link', 'Link layers', () => runCommand('layer.link')),
      iconButton('fx', 'Add a layer style', e => this.fxMenu(e.currentTarget as HTMLElement)),
      iconButton('mask', 'Add a mask', e => this.addMask(e as MouseEvent)),
      iconButton('adjust-layer', 'Create new fill or adjustment layer', e => this.adjMenu(e.currentTarget as HTMLElement)),
      iconButton('folder', 'Create a new group', e => runCommand('layer.newGroup', (e as MouseEvent).altKey ? undefined : { noDialog: true })),
      iconButton('new-layer', 'Create a new layer', e => { const me = e as MouseEvent; runCommand('layer.new', me.altKey ? { below: me.ctrlKey } : { noDialog: true, below: me.ctrlKey }); }),
      iconButton('trash', 'Delete layer', e => runCommand('layer.delete', (e as MouseEvent).altKey ? { noConfirm: true } : undefined)),
    );
    this.footer.children[0].setAttribute('data-act', 'link');
    this.footer.children[4].setAttribute('data-act', 'group');
    this.footer.children[5].setAttribute('data-act', 'new');
    this.footer.children[6].setAttribute('data-act', 'trash');
    this.root.append(h('div.lp-top', null, filterBar, this.blendRow, this.lockRow), this.list, this.footer);
    el.append(this.root);
    this.buildFilterControls();

    const offs = [
      events.on('layers', d => { if (d === app.activeDoc) this.schedule(); }),
      events.on('activeLayer', d => { if (d === app.activeDoc) this.schedule(); }),
      events.on('activeDoc', () => this.schedule()),
      events.on('history', d => { if (d === app.activeDoc) this.schedule(); }),
      events.on('docSize', d => { if (d === app.activeDoc) this.schedule(); }),
      events.on('pixels', p => { if (p.doc === app.activeDoc) this.scheduleThumbs(); }),
    ];
    void offs;
    layersUI.rename = l => this.startRename(l);
    this.render();
  }

  get doc() { return app.activeDoc; }

  // ---------------------------------------------------------------- scheduling
  schedule() {
    if (this.pending) return;
    this.pending = true;
    requestAnimationFrame(() => { this.pending = false; this.render(); });
  }
  scheduleThumbs() {
    clearTimeout(this.thumbTimer);
    this.thumbTimer = window.setTimeout(() => this.refreshThumbs(), 90);
  }

  // ---------------------------------------------------------------- filter UI
  buildFilterControls() {
    const f = this.filter;
    this.pill.classList.toggle('on', f.on);
    this.fctl.replaceChildren();
    const refilter = () => { f.on = true; this.pill.classList.add('on'); this.schedule(); };
    switch (f.mode) {
      case 'kind':
        for (const k of KIND_FILTERS) {
          const b = iconButton(k.icon, k.title, () => { if (f.kinds.has(k.id)) f.kinds.delete(k.id); else f.kinds.add(k.id); b.classList.toggle('active', f.kinds.has(k.id)); if (!f.kinds.size) { f.on = false; this.pill.classList.remove('on'); this.schedule(); } else refilter(); });
          b.classList.toggle('active', f.kinds.has(k.id));
          this.fctl.append(b);
        }
        break;
      case 'name': {
        const inp = h('input.field', { type: 'text', value: f.name, placeholder: '' }) as HTMLInputElement;
        inp.addEventListener('input', () => { f.name = inp.value; refilter(); });
        inp.addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Escape' || e.key === 'Enter') inp.blur(); });
        this.fctl.append(inp);
        break;
      }
      case 'effect':
        this.fctl.append(select(EFFECT_ORDER.map(t => ({ value: t, label: EFFECT_LABELS[t] })), f.effect, v => { f.effect = v; refilter(); }));
        break;
      case 'mode':
        this.fctl.append(select(blendOptions(true), f.blend, v => { f.blend = v; refilter(); }));
        break;
      case 'attribute':
        this.fctl.append(select(ATTRS.map(a => ({ value: a.value, label: a.label })), f.attr, v => { f.attr = v; refilter(); }));
        break;
      case 'color':
        this.fctl.append(select(LABEL_COLORS.map(([v, label]) => ({ value: v, label })), f.color, v => { f.color = v; refilter(); }));
        break;
      case 'smart':
        this.fctl.append(select([{ value: 'embedded', label: 'Embedded' }, { value: 'uptodate', label: 'Up-to-date' }, { value: 'linked', label: 'Linked' }], f.smart, v => { f.smart = v; refilter(); }));
        break;
      case 'selected':
        break;
    }
  }
  matches(l: Layer, doc: PixDocument): boolean {
    const f = this.filter;
    switch (f.mode) {
      case 'kind': return !f.kinds.size || KIND_FILTERS.some(k => f.kinds.has(k.id) && k.test(l));
      case 'name': return !f.name || l.name.toLowerCase().includes(f.name.toLowerCase());
      case 'effect': return l.effects.some(e => e.type === f.effect);
      case 'mode': return l.blendMode === f.blend;
      case 'attribute': return ATTRS.find(a => a.value === f.attr)!.test(l);
      case 'color': return l.colorLabel === f.color;
      case 'smart': return l instanceof SmartObjectLayer && f.smart !== 'linked';
      case 'selected': return doc.selectedIds.includes(l.id);
    }
  }
  get filtering() { return this.filter.on && !(this.filter.mode === 'kind' && !this.filter.kinds.size) && !(this.filter.mode === 'name' && !this.filter.name); }

  // ---------------------------------------------------------------- top controls
  editPct(key: 'opacity' | 'fillOpacity', v: number, final: boolean) {
    const doc = this.doc;
    if (!doc) return;
    const sel = topSelected(doc).filter(l => !l.isBackground);
    if (!sel.length) return;
    if (this.editDoc !== doc) { this.editDoc = doc; this.editOpacity = null; this.editFill = null; }
    const name = key === 'opacity' ? 'Opacity Change' : 'Fill Opacity Change';
    let ed = key === 'opacity' ? this.editOpacity : this.editFill;
    if (!ed) { ed = liveEditor(doc, name); if (key === 'opacity') this.editOpacity = ed; else this.editFill = ed; }
    ed(() => { for (const l of sel) l[key] = v / 100; doc.invalidate(); }, final);
    if (final) { if (key === 'opacity') this.editOpacity = null; else this.editFill = null; doc.layersChanged(); }
  }
  toggleLock(k: keyof LayerLocks) {
    const doc = this.doc;
    if (!doc) return;
    const sel = topSelected(doc).filter(l => !l.isBackground);
    if (!sel.length) return;
    const on = !sel.every(l => l.locks[k]);
    doc.history.transaction(on ? 'Lock Layer' : 'Unlock Layer', () => {
      for (const l of sel) {
        l.locks = { ...l.locks, [k]: on };
        if (l instanceof GroupLayer) { const w = (ls: Layer[]) => ls.forEach(c => { c.locks = { ...c.locks, [k]: on }; if (c instanceof GroupLayer) w(c.children); }); if (k === 'all') w(l.children); }
      }
    });
    doc.layersChanged();
  }
  syncTop(doc: PixDocument | null) {
    const l = doc?.activeLayer ?? null;
    const group = l instanceof GroupLayer;
    if (!this.blendSel || this.blendIsGroup !== group) {
      this.blendIsGroup = group;
      this.blendSel = select(blendOptions(group), l?.blendMode ?? 'normal', m => this.setBlend(m), { width: 155, title: 'Set the blending mode for the layer', cls: 'lp-blend' });
      this.blendHost.replaceChildren(this.blendSel);
    }
    this.blendSel.setValue(l?.blendMode ?? 'normal');
    const noEdit = !l || l.isBackground;
    this.blendSel.classList.toggle('lp-dim', noEdit);
    this.opacity.setValue(Math.round((l?.opacity ?? 1) * 100)); this.opacity.setDisabled(noEdit);
    this.fill.setValue(Math.round((l?.fillOpacity ?? 1) * 100)); this.fill.setDisabled(noEdit || l instanceof GroupLayer);
    const sel = doc ? topSelected(doc).filter(x => !x.isBackground) : [];
    for (const k of Object.keys(this.lockBtns) as (keyof LayerLocks)[]) {
      const b = this.lockBtns[k];
      b.classList.toggle('active', !!l && !l.isBackground && sel.length > 0 && sel.every(x => x.locks[k]));
      b.classList.toggle('lp-dim', noEdit || (k !== 'all' && !!l?.locks.all) || (k === 'transparency' && !!l && (l.kind === 'adjustment' || l instanceof GroupLayer && false)));
    }
  }
  setBlend(m: BlendMode) {
    const doc = this.doc;
    if (!doc) return;
    const sel = topSelected(doc).filter(l => !l.isBackground && (m !== 'pass-through' || l instanceof GroupLayer));
    if (!sel.length) return;
    doc.history.transaction('Blending Change', () => { for (const l of sel) l.blendMode = m; });
    doc.layersChanged();
  }

  // ---------------------------------------------------------------- list rendering
  render() {
    const doc = this.doc;
    if (this.renaming !== null) return; // don't destroy the rename input
    this.syncTop(doc);
    const size = layersPrefs.thumbSize;
    this.root.style.setProperty('--lp-row', ROW_H[size] + 'px');
    if (!doc) { this.list.replaceChildren(); this.lastDoc = null; return; }
    const frag = document.createDocumentFragment();
    this.anyGroups = doc.layers.some(x => x instanceof GroupLayer);
    const sel = new Set(doc.selectedIds);
    const filtering = this.filtering;
    let keep: Set<Layer> | null = null;
    if (filtering) {
      keep = new Set();
      for (const l of doc.allLayers()) if (this.matches(l, doc)) { keep.add(l); for (let p = l._parent; p; p = p._parent) keep.add(p); }
    }
    const walk = (list: Layer[], depth: number) => {
      for (let i = list.length - 1; i >= 0; i--) {
        const l = list[i];
        if (keep && !keep.has(l)) continue;
        frag.append(this.row(doc, l, depth, sel.has(l.id)));
        if (l.effects.length && this.fxOpen.has(l.id)) this.fxRows(doc, l, depth, sel.has(l.id)).forEach(r => frag.append(r));
        if (l instanceof GroupLayer && (l.expanded || keep)) walk(l.children, depth + 1);
      }
    };
    walk(doc.layers, 0);
    if (!frag.childNodes.length && filtering) frag.append(h('div.lp-empty', null, 'No layers match the filter.'));
    this.list.replaceChildren(frag);
    this.refreshThumbs();
    const a = doc.activeLayerId || 0;
    if (a !== this.lastActive || doc !== this.lastDoc) {
      this.lastActive = a; this.lastDoc = doc;
      const r = this.list.querySelector<HTMLElement>(`.lp-row[data-id="${a}"]`);
      r?.scrollIntoView?.({ block: 'nearest' });
    }
  }

  row(doc: PixDocument, l: Layer, depth: number, selected: boolean): HTMLElement {
    const size = layersPrefs.thumbSize, T = THUMB[size];
    const hidden = !l.visible;
    const eye = h('div.lp-eye', { title: 'Toggle layer visibility' }, l.visible ? icon('eye', 16) : null);
    const main = h('div.lp-main', { style: { paddingLeft: `${4 + depth * 18}px` } });
    const lab = labelCss(l.colorLabel);
    if (lab) { eye.style.background = lab; }
    // clip indicator
    if (l.clipped) main.append(h('span.lp-clip', { title: 'Clipped to the layer below' }, icon('clip-arrow', 13)));
    // group disclosure
    if (l instanceof GroupLayer) {
      const disc = h('span.lp-disc', { title: l.expanded ? 'Collapse group' : 'Expand group' }, icon(l.expanded ? 'caret-down' : 'caret-right', 11));
      disc.addEventListener('pointerdown', e => e.stopPropagation());
      disc.addEventListener('click', e => { e.stopPropagation(); this.toggleExpand(doc, l, e.altKey); });
      main.append(disc);
    } else if (depth > 0 || this.anyGroups) main.append(h('span.lp-disc'));
    // thumbnail
    const targetMask = selected && doc.activeLayerId === l.id && doc.editMask && !!l.mask;
    if (T > 0 || l instanceof GroupLayer) {
      const tw = h('div.lp-tw.lp-tw-layer', { class: selected && doc.activeLayerId === l.id && !targetMask && !!l.mask && !(l instanceof GroupLayer) ? 'target' : '' });
      if (l instanceof GroupLayer) tw.append(h('span.lp-folder', null, icon('folder', Math.max(16, Math.min(22, T * 0.6 || 16)))));
      else if (l instanceof AdjustmentLayer) {
        const def = adjustments[l.adjustment.type];
        tw.append(h('div.lp-iconthumb', { style: { width: T + 'px', height: T + 'px' }, title: def?.label || l.adjustment.type }, icon(def?.icon || 'adjust-layer', Math.round(T * 0.6))));
      } else if (l.kind === 'text') {
        tw.append(h('div.lp-iconthumb.lp-textthumb', { style: { width: T + 'px', height: T + 'px', fontSize: Math.round(T * 0.6) + 'px' } }, 'T'));
      } else {
        tw.append(this.thumbCanvas(doc, l));
        if (l instanceof SmartObjectLayer) tw.append(h('span.lp-badge', { title: 'Smart Object' }, icon('kind-smart', 10)));
        else if (l.kind === 'shape') tw.append(h('span.lp-badge', { title: 'Shape layer' }, icon('kind-shape', 10)));
      }
      main.append(tw);
    }
    // mask thumbnail
    if (l.mask && T > 0) {
      const chain = h('span.lp-chain', { class: l.mask.linked ? '' : 'off', title: l.mask.linked ? 'Unlink the layer mask from the layer' : 'Link the layer mask to the layer' }, icon('link', 12));
      chain.addEventListener('pointerdown', e => e.stopPropagation());
      chain.addEventListener('click', e => { e.stopPropagation(); doc.setActiveLayer(l); runCommand('layer.mask', 'toggleLink'); });
      const mw = h('div.lp-tw.lp-tw-mask', { class: targetMask ? 'target' : '', title: 'Layer mask — Click: edit mask · Shift+click: disable · Alt+click: view mask · Ctrl+click: load as selection' }, this.maskCanvas(doc, l));
      if (!l.mask.enabled) mw.append(h('span.lp-maskoff'));
      main.append(chain, mw);
    }
    // name
    const name = h('span.lp-name', { class: [l.isBackground ? 'bg' : '', isBase(doc, l) ? 'base' : ''].join(' '), title: l.name }, l.name);
    main.append(name);
    // right side
    const right = h('span.lp-right');
    if (l.linkId) right.append(h('span', { title: 'Linked layer' }, icon('link', 14)));
    if (l.effects.length) {
      const open = this.fxOpen.has(l.id);
      const fx = h('span.lp-fx', { title: 'Show/hide layer effects in the panel' }, 'fx', icon(open ? 'caret-down' : 'caret-right', 10));
      fx.addEventListener('pointerdown', e => e.stopPropagation());
      fx.addEventListener('click', e => { e.stopPropagation(); if (open) this.fxOpen.delete(l.id); else this.fxOpen.add(l.id); this.schedule(); });
      fx.addEventListener('dblclick', e => { e.stopPropagation(); openStyle(l); });
      right.append(fx);
    }
    const lk = l.locks;
    if (l.isBackground || lk.all) right.append(h('span', { title: l.isBackground ? 'Background (locked)' : 'Layer is fully locked' }, icon('lock', 14)));
    else if (lk.pixels || lk.position || lk.transparency || lk.artboard) right.append(h('span', { title: 'Layer is partially locked' }, icon('lock-outline', 14)));
    main.append(right);

    const row = h('div.lp-row', { class: [selected ? 'selected' : '', hidden ? 'hidden-layer' : ''].join(' '), dataset: { id: String(l.id) } }, eye, main);
    this.wireRow(doc, l, row, eye, main, name);
    return row;
  }

  fxRows(doc: PixDocument, l: Layer, depth: number, selected: boolean): HTMLElement[] {
    const rows: HTMLElement[] = [];
    const pad = `${4 + depth * 18 + 30}px`;
    const mk = (label: string, on: boolean, toggle: () => void, dbl: () => void, iconName?: string) => {
      const eye = h('div.lp-eye', { title: 'Toggle effect visibility' }, on ? icon('eye', 13) : null);
      eye.addEventListener('click', e => { e.stopPropagation(); toggle(); });
      const main = h('div.lp-main', { style: { paddingLeft: pad } }, iconName ? h('span.lp-fxicon', null, icon(iconName, 12)) : h('span.lp-fxicon'), h('span.lp-fxlabel', null, label));
      const r = h('div.lp-row.lp-fxrow', { class: selected ? 'selected' : '' }, eye, main);
      main.addEventListener('click', () => doc.setActiveLayer(l));
      main.addEventListener('dblclick', e => { e.stopPropagation(); dbl(); });
      rows.push(r);
    };
    mk('Effects', l.effectsVisible, () => { doc.history.transaction(l.effectsVisible ? 'Hide Effects' : 'Show Effects', () => { l.effectsVisible = !l.effectsVisible; l.invalidate(); }); doc.pixelsChanged(l, null); doc.layersChanged(); }, () => openStyle(l), 'fx');
    const list = l.effects.slice().sort((a, b) => EFFECT_ORDER.indexOf(a.type) - EFFECT_ORDER.indexOf(b.type));
    for (const e of list) {
      mk(EFFECT_LABELS[e.type] || e.type, e.enabled, () => {
        const i = l.effects.indexOf(e);
        doc.history.transaction(e.enabled ? 'Hide Effect' : 'Show Effect', () => { l.effects = l.effects.map((x, j) => (j === i ? { ...x, enabled: !x.enabled } : x)); l.invalidate(); });
        doc.pixelsChanged(l, null); doc.layersChanged();
      }, () => openStyle(l, e.type));
    }
    rows[rows.length - 1]?.classList.add('last');
    return rows;
  }

  // ---------------------------------------------------------------- thumbnails
  thumbBox(doc: PixDocument, l: Layer, T: number) {
    let r = { x: 0, y: 0, w: doc.width, h: doc.height };
    if (layersPrefs.thumbContents === 'bounds' && !(l instanceof FillLayer)) { const b = doc.layerBounds(l); if (b) r = b; }
    const s = Math.min(T / r.w, T / r.h);
    return { r, s, w: Math.max(1, Math.round(r.w * s)), h: Math.max(1, Math.round(r.h * s)) };
  }
  thumbCanvas(doc: PixDocument, l: Layer): HTMLCanvasElement {
    let c = this.thumbs.get(l);
    if (!c) { c = h('canvas.lp-thumb') as HTMLCanvasElement; this.thumbs.set(l, c); this.thumbKeys.delete(c); }
    return c;
  }
  maskCanvas(_doc: PixDocument, l: Layer): HTMLCanvasElement {
    let c = this.mthumbs.get(l);
    if (!c) { c = h('canvas.lp-mthumb') as HTMLCanvasElement; this.mthumbs.set(l, c); }
    return c;
  }
  refreshThumbs() {
    const doc = this.doc;
    if (!doc) return;
    const T = THUMB[layersPrefs.thumbSize];
    if (!T) return;
    const k = dpr();
    for (const row of this.list.querySelectorAll<HTMLElement>('.lp-row[data-id]')) {
      const l = doc.findLayer(+row.dataset.id!);
      if (!l) continue;
      const tc = this.thumbs.get(l);
      if (tc && tc.isConnected) {
        const content = l.getContent(doc);
        const box = this.thumbBox(doc, l, T);
        const key = `${l._version}|${idOf(content?.canvas)}|${content?.x},${content?.y}|${box.r.x},${box.r.y},${box.r.w},${box.r.h}|${T}|${k}`;
        if (this.thumbKeys.get(tc) !== key) {
          this.thumbKeys.set(tc, key);
          tc.width = Math.round(box.w * k); tc.height = Math.round(box.h * k);
          tc.style.width = box.w + 'px'; tc.style.height = box.h + 'px';
          const x = ctx2d(tc);
          x.clearRect(0, 0, tc.width, tc.height);
          if (content) {
            x.imageSmoothingEnabled = true; x.imageSmoothingQuality = 'medium';
            const s = box.s * k;
            x.setTransform(s, 0, 0, s, -box.r.x * s, -box.r.y * s);
            x.drawImage(content.canvas, content.x, content.y);
            x.setTransform(1, 0, 0, 1, 0, 0);
          }
        }
      }
      const mc = this.mthumbs.get(l);
      if (l.mask && mc && mc.isConnected) {
        const m = l.mask;
        const box = this.thumbBox(doc, l, T);
        const key = `${l._version}|${idOf(m.canvas)}|${m.x},${m.y},${m.bg}|${box.r.x},${box.r.y},${box.r.w},${box.r.h}|${T}|${k}`;
        if (this.thumbKeys.get(mc) !== key) {
          this.thumbKeys.set(mc, key);
          mc.width = Math.round(box.w * k); mc.height = Math.round(box.h * k);
          mc.style.width = box.w + 'px'; mc.style.height = box.h + 'px';
          const x = ctx2d(mc), s = box.s * k;
          x.setTransform(1, 0, 0, 1, 0, 0);
          x.globalCompositeOperation = 'source-over';
          x.fillStyle = '#000'; x.fillRect(0, 0, mc.width, mc.height);
          const tmp = createCanvas(mc.width, mc.height), tx = ctx2d(tmp);
          tx.setTransform(s, 0, 0, s, -box.r.x * s, -box.r.y * s);
          if (m.bg === 255) { tx.fillStyle = '#fff'; tx.fillRect(box.r.x, box.r.y, box.r.w, box.r.h); tx.clearRect(m.x, m.y, m.canvas.width, m.canvas.height); }
          tx.drawImage(m.canvas, m.x, m.y);
          tx.setTransform(1, 0, 0, 1, 0, 0);
          tx.globalCompositeOperation = 'source-in'; tx.fillStyle = '#fff'; tx.fillRect(0, 0, tmp.width, tmp.height);
          x.drawImage(tmp, 0, 0);
        }
      }
    }
  }

  // ---------------------------------------------------------------- interactions
  toggleExpand(doc: PixDocument, g: GroupLayer, all: boolean) {
    const v = !g.expanded;
    g.expanded = v;
    if (all) { const w = (ls: Layer[]) => ls.forEach(c => { if (c instanceof GroupLayer) { c.expanded = v; w(c.children); } }); w(g.children); }
    events.emit('layers', doc);
  }

  selectClick(doc: PixDocument, l: Layer, e: MouseEvent) {
    if (e.shiftKey && doc.activeLayer) {
      const order = panelOrder(doc);
      const i = order.indexOf(doc.activeLayer), j = order.indexOf(l);
      if (i >= 0 && j >= 0) {
        const range = order.slice(Math.min(i, j), Math.max(i, j) + 1);
        const ids = new Set([...(e.ctrlKey ? doc.selectedIds : []), ...range.map(x => x.id)]);
        selectLayers(doc, doc.allLayers().filter(x => ids.has(x.id)), l);
        return;
      }
    }
    if (e.ctrlKey || e.metaKey) { doc.setActiveLayer(l, true); return; }
    if (doc.selectedIds.length > 1 && doc.selectedIds.includes(l.id) && e.type === 'pointerdown') return; // may start a multi-drag
    doc.setActiveLayer(l);
  }

  wireRow(doc: PixDocument, l: Layer, row: HTMLElement, eye: HTMLElement, main: HTMLElement, name: HTMLElement) {
    // ---- visibility (click, drag across eyes, Alt = solo)
    eye.addEventListener('pointerdown', e => {
      if (e.button !== 0) return;
      e.preventDefault(); e.stopPropagation();
      if (e.altKey) { this.soloToggle(doc, l); return; }
      const state = !l.visible;
      const t = doc.history.begin(state ? 'Show Layer' : 'Hide Layer');
      const touched = new Set<Layer>([l]);
      l.visible = state; doc.layersChanged();
      dragPointer(e, (_dx, _dy, ev) => {
        const el = document.elementFromPoint(ev.clientX, ev.clientY)?.closest('.lp-row[data-id]') as HTMLElement | null;
        const o = el ? doc.findLayer(+el.dataset.id!) : null;
        if (o && !touched.has(o)) { touched.add(o); o.visible = state; doc.layersChanged(); }
      }, () => t.commit(touched.size > 1 ? (state ? 'Show Layers' : 'Hide Layers') : undefined));
    });
    // ---- thumbnails
    const tw = main.querySelector<HTMLElement>('.lp-tw-layer');
    const mw = main.querySelector<HTMLElement>('.lp-tw-mask');
    tw?.addEventListener('pointerdown', e => {
      if (e.button !== 0) return;
      if (e.ctrlKey || e.metaKey) {
        e.stopPropagation(); e.preventDefault();
        const op = e.shiftKey && e.altKey ? 'intersect' : e.shiftKey ? 'add' : e.altKey ? 'subtract' : 'replace';
        runCommand('layer.loadTransparency', { layer: l, op });
      } else if (doc.editMask && doc.activeLayerId === l.id && !e.shiftKey) { doc.editMask = false; events.emit('activeLayer', doc); }
    }, true);
    tw?.addEventListener('dblclick', e => { e.stopPropagation(); this.thumbDblClick(doc, l); });
    tw?.addEventListener('contextmenu', e => { e.preventDefault(); e.stopPropagation(); contextMenu(e, this.thumbMenu()); });
    mw?.addEventListener('pointerdown', e => {
      if (e.button !== 0) return;
      e.stopPropagation(); e.preventDefault();
      if (e.ctrlKey || e.metaKey) {
        const c = maskDocCanvas(doc, l.mask!);
        const op = e.shiftKey && e.altKey ? 'intersect' : e.shiftKey ? 'add' : e.altKey ? 'subtract' : 'replace';
        doc.history.transaction('Load Selection', () => doc.selection.apply(c, op));
        return;
      }
      if (e.shiftKey) { doc.setActiveLayer(l); runCommand('layer.mask', 'toggle'); return; }
      if (e.altKey) {
        doc.setActiveLayer(l);
        doc.viewMaskLayerId = doc.viewMaskLayerId === l.id ? 0 : l.id;
        doc.editMask = true;
        doc.invalidate(); events.emit('activeLayer', doc);
        return;
      }
      if (doc.activeLayerId !== l.id || doc.selectedIds.length > 1) doc.setActiveLayer(l);
      if (doc.viewMaskLayerId && doc.viewMaskLayerId !== l.id) { doc.viewMaskLayerId = 0; doc.invalidate(); }
      doc.editMask = true;
      events.emit('activeLayer', doc);
    });
    mw?.addEventListener('dblclick', e => { e.stopPropagation(); runCommand('window.showPanel', 'properties'); });
    mw?.addEventListener('contextmenu', e => { e.preventDefault(); e.stopPropagation(); doc.setActiveLayer(l); contextMenu(e, this.maskMenu(doc, l)); });
    // ---- name: double-click renames
    name.addEventListener('dblclick', e => {
      e.stopPropagation();
      if (l.isBackground) { runCommand('layer.layerFromBackground'); return; }
      this.startRename(l);
    });
    main.addEventListener('dblclick', e => {
      if ((e.target as Element).closest('.lp-tw, .lp-name, .lp-fx, .lp-disc, .lp-chain')) return;
      if (l.isBackground) { runCommand('layer.layerFromBackground'); return; }
      if (!(l instanceof AdjustmentLayer)) openStyle(l);
    });
    main.addEventListener('contextmenu', e => {
      e.preventDefault();
      if (!doc.selectedIds.includes(l.id)) doc.setActiveLayer(l);
      contextMenu(e, this.layerMenu(doc, l));
    });
    // ---- click / drag
    main.addEventListener('pointerdown', e => {
      if (e.button !== 0 || this.renaming !== null) return;
      if ((e.target as Element).closest('.lp-rename')) return;
      if (e.altKey && !e.ctrlKey && !e.shiftKey) {
        // Alt+click the line between two layers → toggle clipping mask
        const r = row.getBoundingClientRect(), y = e.clientY - r.top;
        const order = panelOrder(doc);
        let upper: Layer | null = null;
        if (y <= 7) upper = order[order.indexOf(l) - 1] || null;
        else if (y >= r.height - 7) upper = l;
        if (upper && !upper.isBackground && doc.siblingsOf(upper).indexOf(upper) > 0 && order.indexOf(upper) >= 0) {
          e.preventDefault();
          doc.history.transaction(upper.clipped ? 'Release Clipping Mask' : 'Create Clipping Mask', () => { upper!.clipped = !upper!.clipped; });
          doc.layersChanged();
          return;
        }
      }
      if (mw && mw.contains(e.target as Node)) return;
      this.selectClick(doc, l, e);
      this.dragStart(doc, l, e);
    });
  }

  thumbDblClick(doc: PixDocument, l: Layer) {
    if (l.isBackground) { runCommand('layer.layerFromBackground'); return; }
    if (l instanceof AdjustmentLayer) { doc.setActiveLayer(l); runCommand('window.showPanel', 'properties'); return; }
    if (l instanceof FillLayer) { doc.setActiveLayer(l); runCommand('layer.contentOptions'); return; }
    if (l instanceof SmartObjectLayer) { editContents(doc, l); return; }
    if (l.kind === 'text') { hooks.editTextLayer(l); return; }
    if (l.kind === 'shape') {
      const any = l as any;
      if (any.fill?.type === 'solid' && any.fill.color) {
        hooks.openColorPicker(any.fill.color, 'Color Picker (Solid Color)').then(c => {
          if (!c) return;
          doc.history.transaction('Modify Shape Fill', () => { any.fill = { ...any.fill, color: c }; l.invalidate(); });
          doc.pixelsChanged(l, null); doc.layersChanged();
        });
        return;
      }
    }
    if (l instanceof GroupLayer) return;
    openStyle(l);
  }

  soloToggle(doc: PixDocument, l: Layer) {
    const s = this.solo.get(doc);
    if (s && s.id === l.id) {
      doc.history.transaction('Show/Hide Layers', () => { for (const [x, v] of s.vis) if (doc.findLayer(x.id) === x) x.visible = v; });
      this.solo.delete(doc);
    } else {
      const vis = new Map<Layer, boolean>();
      const anc = new Set<Layer>([l]);
      for (let p = l._parent; p; p = p._parent) anc.add(p);
      doc.history.transaction('Show/Hide Layers', () => {
        for (const x of doc.allLayers()) {
          vis.set(x, x.visible);
          if (anc.has(x)) x.visible = true;
          else if (!hasAnc(x, l)) x.visible = false;
        }
      });
      this.solo.set(doc, { id: l.id, vis });
    }
    doc.layersChanged();
  }

  // ---------------------------------------------------------------- inline rename
  startRename(l: Layer): boolean {
    const doc = this.doc;
    if (!doc || !this.shown || !isPanelVisible('layers')) return false;
    const row = this.list.querySelector<HTMLElement>(`.lp-row[data-id="${l.id}"]`);
    const name = row?.querySelector<HTMLElement>('.lp-name');
    if (!row || !name) return false;
    this.renaming = l.id;
    const inp = h('input.field.lp-rename', { type: 'text', value: l.name }) as HTMLInputElement;
    name.replaceWith(inp);
    inp.focus(); inp.select();
    let done = false;
    const finish = (ok: boolean) => {
      if (done) return; done = true;
      this.renaming = null;
      const v = inp.value.trim();
      if (ok && v && v !== l.name) { doc.history.transaction('Rename Layer', () => { l.name = v; if ((l as any).autoName !== undefined) (l as any).autoName = ''; }); doc.layersChanged(); }
      this.render();
    };
    inp.addEventListener('keydown', e => {
      e.stopPropagation();
      if (e.key === 'Enter') finish(true);
      else if (e.key === 'Escape') finish(false);
      else if (e.key === 'Tab') {
        e.preventDefault(); finish(true);
        const order = panelOrder(doc), i = order.indexOf(l), next = order[i + (e.shiftKey ? -1 : 1)];
        if (next && !next.isBackground) { doc.setActiveLayer(next); requestAnimationFrame(() => requestAnimationFrame(() => this.startRename(next))); }
      }
    });
    inp.addEventListener('blur', () => finish(true));
    inp.addEventListener('pointerdown', e => e.stopPropagation());
    return true;
  }

  // ---------------------------------------------------------------- drag & drop
  dragStart(doc: PixDocument, l: Layer, e: PointerEvent) {
    const sx = e.clientX, sy = e.clientY;
    let dragging = false, ghost: HTMLElement | null = null, line: HTMLElement | null = null, drop: Drop | null = null;
    let hotBtn: HTMLElement | null = null, intoRow: HTMLElement | null = null;
    const moving = () => (doc.selectedIds.includes(l.id) ? topSelected(doc) : [l]).filter(x => !x.isBackground);
    const clear = () => { ghost?.remove(); line?.remove(); intoRow?.classList.remove('drop-into'); hotBtn?.classList.remove('drop-hot'); };
    const move = (ev: PointerEvent) => {
      if (!dragging) {
        if (Math.hypot(ev.clientX - sx, ev.clientY - sy) < 5) return;
        if (!moving().length) return;
        dragging = true;
        const n = moving().length;
        ghost = h('div.lp-ghost', null, n > 1 ? `${n} layers` : l.name);
        document.body.append(ghost);
        line = h('div.lp-dropline');
      }
      ghost!.style.left = ev.clientX + 12 + 'px'; ghost!.style.top = ev.clientY + 8 + 'px';
      intoRow?.classList.remove('drop-into'); intoRow = null;
      hotBtn?.classList.remove('drop-hot'); hotBtn = null;
      line!.remove();
      drop = null;
      const over = document.elementFromPoint(ev.clientX, ev.clientY);
      const btn = over?.closest('.lp-footer [data-act]') as HTMLElement | null;
      if (btn && ['trash', 'new', 'group'].includes(btn.dataset.act!)) { hotBtn = btn; btn.classList.add('drop-hot'); return; }
      const lr = this.list.getBoundingClientRect();
      if (ev.clientX < lr.left - 40 || ev.clientX > lr.right + 40) return;
      drop = this.dropAt(doc, ev.clientY);
      if (!drop) return;
      if (drop.place === 'into') {
        intoRow = this.list.querySelector<HTMLElement>(`.lp-row[data-id="${drop.anchor!.id}"]`);
        intoRow?.classList.add('drop-into');
      } else {
        let y: number;
        if (drop.place === 'bottom') { const rows = this.list.querySelectorAll<HTMLElement>('.lp-row[data-id]'); const last = rows[rows.length - 1]; y = last ? last.offsetTop + last.offsetHeight : 0; }
        else {
          const r = this.list.querySelector<HTMLElement>(`.lp-row[data-id="${drop.anchor!.id}"]`)!;
          y = drop.place === 'above' ? r.offsetTop : this.bottomOfRowBlock(r);
        }
        line!.style.top = y - 1 + 'px';
        const depth = drop.parent ? this.depthOf(drop.parent) + 1 : 0;
        line!.style.left = 32 + 4 + depth * 18 + 'px';
        this.list.append(line!);
      }
      // autoscroll
      if (ev.clientY < lr.top + 16) this.list.scrollTop -= 12;
      else if (ev.clientY > lr.bottom - 16) this.list.scrollTop += 12;
    };
    const up = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      clear();
      if (!dragging) {
        // plain click inside a multi-selection → select only this one
        if (!e.shiftKey && !e.ctrlKey && !e.metaKey && !ev.shiftKey && !ev.ctrlKey && doc.selectedIds.length > 1) doc.setActiveLayer(l);
        return;
      }
      const ls = moving();
      if (hotBtn) {
        const act = hotBtn.dataset.act;
        selectLayers(doc, ls);
        if (act === 'trash') runCommand('layer.delete', { noConfirm: true, layers: ls });
        else if (act === 'new') runCommand('layer.duplicate', { noDialog: true });
        else if (act === 'group') runCommand('layer.group');
        return;
      }
      if (drop) this.performDrop(doc, ls, drop, ev.altKey);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  }
  depthOf(l: Layer) { let d = 0; for (let p = l._parent; p; p = p._parent) d++; return d; }
  bottomOfRowBlock(r: HTMLElement): number {
    let el: Element | null = r, y = r.offsetTop + r.offsetHeight;
    while ((el = el.nextElementSibling) && el.classList.contains('lp-fxrow')) y = (el as HTMLElement).offsetTop + (el as HTMLElement).offsetHeight;
    return y;
  }
  dropAt(doc: PixDocument, clientY: number): Drop | null {
    const rows = [...this.list.querySelectorAll<HTMLElement>('.lp-row[data-id]')];
    if (!rows.length) return null;
    for (const r of rows) {
      const b = r.getBoundingClientRect();
      const bottom = this.list.getBoundingClientRect().top + this.bottomOfRowBlock(r) - this.list.scrollTop;
      if (clientY < b.top || clientY >= bottom) continue;
      const L = doc.findLayer(+r.dataset.id!);
      if (!L) return null;
      const t = (clientY - b.top) / b.height;
      if (L instanceof GroupLayer) {
        if (t < 0.25) return { parent: L._parent, anchor: L, place: 'above' };
        if (t > 0.75 && !(L.expanded && L.children.length)) return { parent: L._parent, anchor: L, place: 'below' };
        return { parent: L, anchor: L, place: 'into' };
      }
      if (L.isBackground) return { parent: null, anchor: L, place: 'above' };
      return { parent: L._parent, anchor: L, place: t < 0.5 ? 'above' : 'below' };
    }
    const last = rows[rows.length - 1].getBoundingClientRect();
    if (clientY >= last.bottom) {
      const bottomLayer = doc.layers[0];
      if (bottomLayer?.isBackground) return { parent: null, anchor: bottomLayer, place: 'above' };
      return { parent: null, anchor: null, place: 'bottom' };
    }
    return null;
  }
  performDrop(doc: PixDocument, ls: Layer[], drop: Drop, duplicate: boolean) {
    if (!ls.length) return;
    // can't drop into itself / a descendant
    if (drop.parent && ls.some(x => x === drop.parent || hasAnc(drop.parent!, x))) return;
    if (!duplicate && drop.anchor && drop.place !== 'into' && ls.includes(drop.anchor)) return;
    doc.history.transaction(duplicate ? (ls.length > 1 ? 'Duplicate Layers' : 'Duplicate Layer') : 'Layer Order', () => {
      const items = duplicate ? ls.map(x => { const c = x.clone(); c.name = copyName(doc, x.name); return c; }) : ls;
      if (!duplicate) for (const x of ls) { const s = doc.siblingsOf(x); s.splice(s.indexOf(x), 1); }
      const list = drop.parent ? drop.parent.children : doc.layers;
      let idx: number;
      if (drop.place === 'into') idx = list.length;
      else if (drop.place === 'bottom') idx = 0;
      else idx = list.indexOf(drop.anchor!) + (drop.place === 'above' ? 1 : 0);
      if (!drop.parent && list[0]?.isBackground) idx = Math.max(1, idx);
      list.splice(Math.max(0, Math.min(idx, list.length)), 0, ...items);
      for (const it of items) if (it.isBackground) unBackground(it);
      doc.relink();
      if (list[0]?.clipped) list[0].clipped = false;
      if (drop.place === 'into' && drop.parent) drop.parent.expanded = true;
      selectLayers(doc, items);
    });
    doc.layersChanged();
  }

  // ---------------------------------------------------------------- footer menus
  fxMenu(anchor: HTMLElement) {
    const doc = this.doc, l = doc?.activeLayer;
    if (!doc || !l) return;
    const items: MenuEntry[] = [
      { label: 'Blending Options...', action: () => openStyle(l, 'blending') }, '-',
      ...EFFECT_ORDER.map(t => ({ label: EFFECT_LABELS[t] + '...', action: () => openStyle(l, t) })),
    ];
    openMenu(items, anchor, { side: 'below' });
  }
  adjMenu(anchor: HTMLElement) {
    const items: MenuEntry[] = [
      { label: 'Solid Color...', cmd: 'layer.newFill', arg: 'solid' }, { label: 'Gradient...', cmd: 'layer.newFill', arg: 'gradient' }, { label: 'Pattern...', cmd: 'layer.newFill', arg: 'pattern' }, '-',
      ...ADJ_MENU.map(a => a === '-' ? '-' as const : { label: a[0], cmd: 'layer.newAdjustment', arg: a[1] }),
    ];
    openMenu(items, anchor);
  }
  addMask(e: MouseEvent) {
    const doc = this.doc, l = doc?.activeLayer;
    if (!doc || !l) return;
    if (l.mask) { if (!(l.mask as any).vector) runCommand('layer.vectorMask', 'revealAll'); return; }
    const selExists = !doc.selection.empty;
    runCommand('layer.mask', selExists ? (e.altKey ? 'hideSelection' : 'revealSelection') : (e.altKey ? 'hideAll' : 'revealAll'));
  }

  // ---------------------------------------------------------------- context / panel menus
  layerMenu(doc: PixDocument, l: Layer): MenuEntry[] {
    const multi = doc.selectedIds.length > 1;
    const colorItems: MenuEntry[] = LABEL_COLORS.map(([id, label, css]) => ({
      label, checked: topSelected(doc).every(x => x.colorLabel === id), radio: true,
      extra: () => h('span', { style: { width: '12px', height: '12px', borderRadius: '2px', background: css || 'transparent', border: css ? '0' : '1px solid var(--text-dim)', marginRight: '6px', display: 'inline-block' } }),
      action: () => { doc.history.transaction('Layer Properties', () => { for (const x of topSelected(doc)) x.colorLabel = id; }); doc.layersChanged(); },
    }));
    return [
      { label: 'Blending Options...', action: () => openStyle(l, 'blending'), enabled: !(l instanceof AdjustmentLayer) },
      { label: 'Edit Adjustment...', action: () => runCommand('window.showPanel', 'properties'), visible: l instanceof AdjustmentLayer },
      { label: 'Layer Properties...', cmd: 'layer.properties' }, '-',
      { label: multi ? 'Duplicate Layers...' : 'Duplicate Layer...', cmd: 'layer.duplicate' },
      { label: multi ? 'Delete Layers' : 'Delete Layer', cmd: 'layer.delete' }, '-',
      { label: 'Quick Export as PNG', cmd: 'layer.quickExport' }, { label: 'Export As...', cmd: 'layer.exportAs' }, '-',
      { label: 'Group from Layers...', cmd: 'layer.groupFromLayers' },
      { label: 'Convert to Smart Object', cmd: 'layer.toSmartObject' },
      { label: 'Edit Contents', cmd: 'layer.smartEdit', visible: l instanceof SmartObjectLayer },
      { label: 'Export Contents...', cmd: 'layer.smartExport', visible: l instanceof SmartObjectLayer },
      { label: 'Replace Contents...', cmd: 'layer.smartReplace', visible: l instanceof SmartObjectLayer },
      { label: 'Convert to Layers', cmd: 'layer.smartToLayers', visible: l instanceof SmartObjectLayer }, '-',
      { label: 'Rasterize Layer', cmd: 'layer.rasterize', arg: 'layer', enabled: () => isCommandEnabled('layer.rasterize') && !(l instanceof RasterLayer) && !(l instanceof GroupLayer) && !(l instanceof AdjustmentLayer) },
      { label: 'Rasterize Layer Style', cmd: 'layer.rasterize', arg: 'style', enabled: l.effects.length > 0 },
      '-',
      { label: l.mask?.enabled === false ? 'Enable Layer Mask' : 'Disable Layer Mask', cmd: 'layer.mask', arg: 'toggle', visible: !!l.mask },
      { label: 'Apply Layer Mask', cmd: 'layer.mask', arg: 'apply', visible: !!l.mask },
      { label: 'Delete Layer Mask', cmd: 'layer.mask', arg: 'deleteNoAsk', visible: !!l.mask },
      { label: l.clipped ? 'Release Clipping Mask' : 'Create Clipping Mask', cmd: 'layer.clippingMask' }, '-',
      { label: l.linkId && doc.selectedLayers.every(x => x.linkId === l.linkId) ? 'Unlink Layers' : 'Link Layers', cmd: 'layer.link' },
      { label: 'Select Linked Layers', cmd: 'layer.selectLinked' }, '-',
      { label: 'Copy Layer Style', cmd: 'layer.copyStyle' }, { label: 'Paste Layer Style', cmd: 'layer.pasteStyle' }, { label: 'Clear Layer Style', cmd: 'layer.clearStyle' }, '-',
      { label: multi ? 'Merge Layers' : l instanceof GroupLayer ? 'Merge Group' : 'Merge Down', cmd: 'layer.mergeDown' },
      { label: 'Merge Visible', cmd: 'layer.mergeVisible' },
      { label: 'Flatten Image', cmd: 'layer.flatten' }, '-',
      ...colorItems,
    ];
  }
  thumbMenu(): MenuEntry[] {
    const set = (k: 'thumbSize' | 'thumbContents', v: any) => () => { (layersPrefs as any)[k] = v; saveLayersPrefs(); this.render(); };
    return [
      { label: 'No Thumbnails', checked: layersPrefs.thumbSize === 'none', radio: true, action: set('thumbSize', 'none') },
      { label: 'Small Thumbnails', checked: layersPrefs.thumbSize === 'small', radio: true, action: set('thumbSize', 'small') },
      { label: 'Medium Thumbnails', checked: layersPrefs.thumbSize === 'medium', radio: true, action: set('thumbSize', 'medium') },
      { label: 'Large Thumbnails', checked: layersPrefs.thumbSize === 'large', radio: true, action: set('thumbSize', 'large') }, '-',
      { label: 'Clip Thumbnails to Layer Bounds', checked: layersPrefs.thumbContents === 'bounds', radio: true, action: set('thumbContents', 'bounds') },
      { label: 'Clip Thumbnails to Document Bounds', checked: layersPrefs.thumbContents === 'document', radio: true, action: set('thumbContents', 'document') },
    ];
  }
  maskMenu(doc: PixDocument, l: Layer): MenuEntry[] {
    const sel = (op: 'add' | 'subtract' | 'intersect', name: string) => () => { const c = maskDocCanvas(doc, l.mask!); doc.history.transaction(name, () => doc.selection.apply(c, op)); };
    return [
      { label: l.mask?.enabled ? 'Disable Layer Mask' : 'Enable Layer Mask', cmd: 'layer.mask', arg: 'toggle' },
      { label: 'Delete Layer Mask', cmd: 'layer.mask', arg: 'deleteNoAsk' },
      { label: 'Apply Layer Mask', cmd: 'layer.mask', arg: 'apply' }, '-',
      { label: 'Add Mask To Selection', action: sel('add', 'Add To Selection') },
      { label: 'Subtract Mask From Selection', action: sel('subtract', 'Subtract From Selection') },
      { label: 'Intersect Mask With Selection', action: sel('intersect', 'Intersect With Selection') }, '-',
      { label: 'Select and Mask...', cmd: 'select.selectAndMask' },
      { label: 'Mask Options...', action: () => runCommand('window.showPanel', 'properties') },
    ];
  }
  panelMenu(): MenuEntry[] {
    const doc = this.doc;
    const l = doc?.activeLayer;
    return [
      { label: 'New Layer...', cmd: 'layer.new' },
      { label: 'Copy CSS', cmd: 'layer.copyCSS' }, { label: 'Copy SVG', cmd: 'layer.copySVG' },
      { label: 'Duplicate Layer...', cmd: 'layer.duplicate' },
      { label: 'Delete Layer', cmd: 'layer.delete' },
      { label: 'Delete Hidden Layers', cmd: 'layer.deleteHidden' }, '-',
      { label: 'Quick Export as PNG', cmd: 'layer.quickExport' }, { label: 'Export As...', cmd: 'layer.exportAs' }, '-',
      { label: 'New Group...', cmd: 'layer.newGroup' },
      { label: 'New Group from Layers...', cmd: 'layer.groupFromLayers' },
      { label: 'Collapse All Groups', enabled: () => !!doc?.allLayers().some(x => x instanceof GroupLayer), action: () => { if (!doc) return; for (const x of doc.allLayers()) if (x instanceof GroupLayer) x.expanded = false; events.emit('layers', doc); } }, '-',
      { label: 'Lock Layers...', cmd: 'layer.lockDialog' }, '-',
      { label: 'Convert to Smart Object', cmd: 'layer.toSmartObject' },
      { label: 'Edit Contents', cmd: 'layer.smartEdit' }, '-',
      { label: 'Blending Options...', enabled: !!l && !(l instanceof AdjustmentLayer), action: () => l && openStyle(l, 'blending') },
      { label: 'Edit Adjustment...', enabled: l instanceof AdjustmentLayer, action: () => runCommand('window.showPanel', 'properties') }, '-',
      { label: l?.clipped ? 'Release Clipping Mask' : 'Create Clipping Mask', cmd: 'layer.clippingMask' },
      { label: 'Link Layers', cmd: 'layer.link' }, { label: 'Select Linked Layers', cmd: 'layer.selectLinked' }, '-',
      { label: doc && doc.selectedIds.length > 1 ? 'Merge Layers' : 'Merge Down', cmd: 'layer.mergeDown' },
      { label: 'Merge Visible', cmd: 'layer.mergeVisible' }, { label: 'Flatten Image', cmd: 'layer.flatten' }, '-',
      { label: 'Panel Options...', action: () => this.panelOptions() },
    ];
  }

  async panelOptions() {
    const cur = { ...layersPrefs };
    const sizes: ['none' | 'small' | 'medium' | 'large', number][] = [['none', 0], ['small', 20], ['medium', 36], ['large', 62]];
    const radios: HTMLInputElement[] = [];
    const sizeRow = h('div.lp-opt-sizes', null, ...sizes.map(([k, px]) => {
      const r = h('input', { type: 'radio', name: 'lp-thumb', checked: cur.thumbSize === k }) as HTMLInputElement;
      r.addEventListener('change', () => { if (r.checked) cur.thumbSize = k; });
      radios.push(r);
      return h('div.lp-opt-size', null, px ? h('div.box', { style: { width: px + 'px', height: Math.round(px * 0.75) + 'px' } }) : h('div', { style: { fontSize: '11px', color: 'var(--text-dim)', height: '15px' } }, 'None'), h('label', null, r));
    }));
    const radio = (name: string, label: string, on: boolean, fn: () => void) => { const r = h('input', { type: 'radio', name, checked: on }) as HTMLInputElement; r.addEventListener('change', () => r.checked && fn()); return h('label.lp-radio', null, r, label); };
    const body = h('div.form', null,
      h('div.lp-dlg-legend', null, 'Thumbnail Size'), sizeRow,
      h('div.lp-dlg-legend', null, 'Thumbnail Contents'),
      h('div.lp-opt-group', null,
        radio('lp-cont', 'Layer Bounds', cur.thumbContents === 'bounds', () => { cur.thumbContents = 'bounds'; }),
        radio('lp-cont', 'Entire Document', cur.thumbContents === 'document', () => { cur.thumbContents = 'document'; })),
      h('div.lp-opt-group', null,
        checkbox('Use Default Masks on Fill Layers', cur.defaultMasksOnFill, v => { cur.defaultMasksOnFill = v; }),
        checkbox('Expand New Effects', cur.expandNewEffects, v => { cur.expandNewEffects = v; }),
        checkbox('Add "copy" to Copied Layers and Groups', cur.addCopy, v => { cur.addCopy = v; }),
        checkbox('Show "Delete Layer" confirmation', cur.confirmDelete, v => { cur.confirmDelete = v; })),
    );
    const ok = await openDialog({ title: 'Layers Panel Options', body, layout: 'side' }).result;
    if (!ok) return;
    Object.assign(layersPrefs, cur);
    saveLayersPrefs();
    this.render();
  }
}

function hasAnc(l: Layer, anc: Layer): boolean { for (let p = l._parent; p; p = p._parent) if (p === anc) return true; return false; }

// expand effects of newly styled layers ("Expand New Effects")
const fxCount = new WeakMap<Layer, number>();
let panel: LayersPanel | null = null;
events.on('layers', doc => {
  if (!panel || !layersPrefs.expandNewEffects) return;
  for (const l of doc.allLayers()) {
    const n = l.effects.length, prev = fxCount.get(l);
    if (prev !== undefined && n > prev) panel.fxOpen.add(l.id);
    fxCount.set(l, n);
  }
});

registerPanel({
  id: 'layers', title: 'Layers', icon: 'layers', shortcut: 'F7', minHeight: 160, defaultHeight: 420,
  create(el) {
    panel = new LayersPanel(el);
    const p = panel;
    return { onShow: () => { p.shown = true; p.render(); }, onHide: () => { p.shown = false; }, onResize: () => {} };
  },
  menu: () => panel ? panel.panelMenu() : [],
});

export { opFromEvent };
