// Options-bar building blocks shared by the Shape, Pen and Path Selection tools (Photoshop layout):
// tool mode, Fill / Stroke paint popovers, stroke width + stroke type, W/H, path operations, alignment,
// arrangement, gear (path options) and Align Edges.
import { app, saveJSON, type Tool } from '../../core/app';
import { events } from '../../core/events';
import type { PixDocument } from '../../core/document';
import type { Gradient, GradientShape, RGB } from '../../core/types';
import { resources } from '../../core/registry';
import { hooks } from '../../core/registry';
import { toCss } from '../../core/color';
import { resolveGradient } from '../../core/presets';
import { h } from '../../ui/dom';
import { icon } from '../../ui/icons';
import { openMenu, type MenuEntry } from '../../ui/menu';
import { openDialog } from '../../ui/dialog';
import { checkbox, gradientCss, iconButton, label, numberField, select, separator, showPop, thumbURL, type Field } from '../../ui/widgets';
import { isShapeLayer, type Paint, type ShapeLayer, type ShapeStroke } from '../../layers/shape-layer';
import { OP_ICONS, OP_LABELS, PATH_COLORS, alignComponents, applyOpToTarget, arrangeComponents, pathOptions, savePathOptions, targetOf } from './common';
import { tightBounds } from './geom';
import './vector.css';

// ------------------------------------------------------------------ shared fill / stroke style
export interface VectorStyle { fill: Paint; stroke: ShapeStroke; recent: RGB[] }
const STYLE_KEY = 'pixora.vector.style';
const DEFAULT_STYLE = (): VectorStyle => ({
  fill: { type: 'solid', color: { r: 0, g: 0, b: 0 }, angle: 90, scale: 100, style: 'linear' },
  stroke: { enabled: false, color: { r: 0, g: 0, b: 0 }, width: 1, align: 'inside', cap: 'butt', join: 'miter', dash: [], opacity: 1 },
  recent: [],
});
export const vstyle: VectorStyle = (() => {
  try { const s = JSON.parse(localStorage.getItem(STYLE_KEY) || 'null'); return s ? { ...DEFAULT_STYLE(), ...s } : DEFAULT_STYLE(); } catch { return DEFAULT_STYLE(); }
})();
export function saveStyle() { saveJSON(STYLE_KEY, vstyle); events.emit('toolOptions'); }
export function pushRecent(c: RGB) {
  vstyle.recent = [c, ...vstyle.recent.filter(x => x.r !== c.r || x.g !== c.g || x.b !== c.b)].slice(0, 10);
}
/** Copy of the current style for a new shape layer. */
export function newLayerStyle(): { fill: Paint; stroke: ShapeStroke } {
  const fill = JSON.parse(JSON.stringify(vstyle.fill)) as Paint;
  if (fill.type === 'gradient' && fill.gradient) fill.gradient = resolveGradient(fill.gradient);
  const stroke = JSON.parse(JSON.stringify(vstyle.stroke)) as ShapeStroke;
  if (stroke.paint?.type === 'gradient' && stroke.paint.gradient) stroke.paint.gradient = resolveGradient(stroke.paint.gradient);
  if (stroke.paint && stroke.paint.type === 'none') stroke.enabled = false;
  return { fill, stroke };
}

export const selectedShapes = (doc: PixDocument | null): ShapeLayer[] => (doc ? doc.selectedLayers.filter(isShapeLayer) : []);

/** Apply a change to the selected shape layers (one history state). */
export function editShapes(doc: PixDocument, name: string, fn: (l: ShapeLayer) => void) {
  const list = selectedShapes(doc);
  if (!list.length) return;
  doc.history.transaction(name, () => { for (const l of list) { fn(l); l.invalidate(); } });
  doc.layersChanged();
}

// ------------------------------------------------------------------ paint preview + popover
export function paintPreview(el: HTMLElement, p: Paint | null) {
  el.replaceChildren();
  el.style.background = '';
  el.style.backgroundImage = '';
  if (!p || p.type === 'none') { el.append(icon('no-color', 22)); return; }
  if (p.type === 'solid') el.style.background = toCss(p.color || { r: 0, g: 0, b: 0 });
  else if (p.type === 'gradient' && p.gradient) el.style.backgroundImage = gradientCss(resolveGradient(p.gradient));
  else if (p.type === 'pattern') {
    const pat = resources.patterns.find(x => x.id === p.pattern);
    if (pat) el.style.backgroundImage = `url(${thumbURL(pat.canvas)})`;
  }
}

/** Photoshop's Fill/Stroke popover: No Color / Solid / Gradient / Pattern + Color Picker. */
export function openPaintPopover(anchor: HTMLElement, title: string, get: () => Paint, set: (p: Paint, final: boolean) => void) {
  const pop = h('div.vo-paint-pop');
  const head = h('div.vo-paint-head');
  const body = h('div.vo-paint-body');
  pop.append(h('div.vo-pop-title', null, title), head, body);
  const types: [Paint['type'], string, string][] = [['none', 'no-color', 'No Color'], ['solid', 'paint-solid', 'Solid Color'], ['gradient', 'paint-gradient', 'Gradient'], ['pattern', 'paint-pattern', 'Pattern']];
  let view: Paint['type'] = get().type;
  const btns = types.map(([t, ic, tip]) => {
    const b = iconButton(ic, tip, () => {
      view = t;
      const cur = get();
      if (t === 'none') set({ ...cur, type: 'none' }, true);
      else if (t === 'solid') set({ ...cur, type: 'solid', color: cur.color || app.fg }, true);
      else if (t === 'gradient') set({ ...cur, type: 'gradient', gradient: cur.gradient || resources.gradients[2] || resources.gradients[0], style: cur.style || 'linear', angle: cur.angle ?? 90, scale: cur.scale ?? 100 }, true);
      else set({ ...cur, type: 'pattern', pattern: cur.pattern || resources.patterns[0]?.id, angle: cur.angle ?? 0, scale: cur.scale ?? 100 }, true);
      render();
    }, { size: 22 });
    return b;
  });
  const picker = iconButton('color-picker-btn', 'Color Picker', async () => {
    const cur = get();
    const c = await hooks.openColorPicker(cur.color || app.fg, `Pick a solid color`);
    if (c) { pushRecent(c); view = 'solid'; set({ ...cur, type: 'solid', color: c }, true); render(); }
  }, { size: 22 });
  head.append(...btns, h('span.vo-grow'), picker);
  const swatch = (c: RGB, tip: string) => {
    const s = h('button.vo-sw', { type: 'button', title: tip, style: { background: toCss(c) } });
    s.onclick = () => { pushRecent(c); set({ ...get(), type: 'solid', color: c }, true); render(); };
    return s;
  };
  const render = () => {
    btns.forEach((b, i) => b.classList.toggle('active', types[i][0] === view));
    body.replaceChildren();
    const cur = get();
    if (view === 'none') { body.append(h('div.vo-dim', null, 'No color')); return; }
    if (view === 'solid') {
      body.append(h('div.vo-sub', null, 'Recently Used Colors'), h('div.vo-sw-row', null, ...(vstyle.recent.length ? vstyle.recent : [app.fg, app.bg]).map(c => swatch(c, `R:${c.r} G:${c.g} B:${c.b}`))));
      const groups = new Map<string, typeof resources.swatches>();
      for (const s of resources.swatches) { const g = s.group || 'Swatches'; if (!groups.has(g)) groups.set(g, []); groups.get(g)!.push(s); }
      const list = h('div.vo-sw-list');
      for (const [g, items] of groups) list.append(h('div.vo-sub', null, g), h('div.vo-sw-grid', null, ...items.map(s => swatch(s.color, s.name))));
      body.append(list);
      return;
    }
    if (view === 'gradient') {
      const grid = h('div.vo-grad-grid');
      for (const g of resources.gradients) {
        const sw = h('button.vo-grad', { type: 'button', title: g.name, class: cur.gradient?.name === g.name ? 'on' : '' });
        sw.style.backgroundImage = `${gradientCss(resolveGradient(g))}, repeating-conic-gradient(#ccc 0 25%, #fff 0 50%)`;
        sw.onclick = () => { set({ ...get(), type: 'gradient', gradient: g }, true); render(); };
        grid.append(sw);
      }
      const edit = h('button.btn.small', { type: 'button', title: 'Edit the gradient' }, 'Edit…');
      edit.onclick = async () => { const g = await hooks.openGradientEditor(get().gradient || resources.gradients[0]); if (g) { set({ ...get(), type: 'gradient', gradient: g as Gradient }, true); render(); } };
      const style = select<GradientShape>([{ value: 'linear', label: 'Linear' }, { value: 'radial', label: 'Radial' }, { value: 'angle', label: 'Angle' }, { value: 'reflected', label: 'Reflected' }, { value: 'diamond', label: 'Diamond' }], cur.style || 'linear', v => set({ ...get(), style: v }, true), { width: 90, title: 'Gradient style' });
      const ang = numberField(cur.angle ?? 90, v => set({ ...get(), angle: v }, true), { min: -180, max: 180, unit: '°', width: 48, label: 'Angle', onInput: v => set({ ...get(), angle: v }, false) });
      const sc = numberField(cur.scale ?? 100, v => set({ ...get(), scale: v }, true), { min: 10, max: 1000, unit: '%', width: 52, label: 'Scale', onInput: v => set({ ...get(), scale: v }, false) });
      const rev = checkbox('Reverse', !!cur.reverse, v => set({ ...get(), reverse: v }, true));
      body.append(grid, h('div.vo-row', null, style, edit), h('div.vo-row', null, ang, sc, rev));
      return;
    }
    const grid = h('div.vo-grad-grid');
    for (const pt of resources.patterns) {
      const sw = h('button.vo-grad.pat', { type: 'button', title: pt.name, class: cur.pattern === pt.id ? 'on' : '' });
      sw.style.backgroundImage = `url(${thumbURL(pt.canvas)})`;
      sw.onclick = () => { set({ ...get(), type: 'pattern', pattern: pt.id }, true); render(); };
      grid.append(sw);
    }
    const ang = numberField(cur.angle ?? 0, v => set({ ...get(), angle: v }, true), { min: -180, max: 180, unit: '°', width: 48, label: 'Angle' });
    const sc = numberField(cur.scale ?? 100, v => set({ ...get(), scale: v }, true), { min: 1, max: 1000, unit: '%', width: 52, label: 'Scale' });
    body.append(grid, h('div.vo-row', null, ang, sc));
  };
  render();
  showPop(pop, anchor);
}

/** Swatch button that opens the paint popover. */
export function paintButton(title: string, get: () => Paint, set: (p: Paint, final: boolean) => void): HTMLElement & { refresh(): void } {
  const prev = h('span.vo-paint-prev');
  const b = h('button.vo-paint-btn', { type: 'button', title: `Set shape ${title.toLowerCase()} type`, 'data-menu-anchor': '' }, prev, h('span.select-caret', null, icon('chevron-down', 12))) as HTMLElement & { refresh(): void };
  b.refresh = () => paintPreview(prev, get());
  b.refresh();
  b.onclick = () => openPaintPopover(b, `${title}`, get, (p, f) => { set(p, f); b.refresh(); });
  return b;
}

// ------------------------------------------------------------------ stroke type popover
const DASH_PRESETS: { name: string; dash: number[]; cap?: 'butt' | 'round' | 'square'; icon: string }[] = [
  { name: 'Solid', dash: [], icon: 'stroke-solid' },
  { name: 'Dashed', dash: [4, 2], icon: 'stroke-dashed' },
  { name: 'Dotted', dash: [0, 2], cap: 'round', icon: 'stroke-dotted' },
];
const ALIGNS = [{ value: 'inside' as const, label: 'Inside', icon: 'stroke-in' }, { value: 'center' as const, label: 'Center', icon: 'stroke-center' }, { value: 'outside' as const, label: 'Outside', icon: 'stroke-out' }];
const CAPS = [{ value: 'butt' as const, label: 'Butt' }, { value: 'round' as const, label: 'Round' }, { value: 'square' as const, label: 'Square' }];
const JOINS = [{ value: 'miter' as const, label: 'Miter' }, { value: 'round' as const, label: 'Round' }, { value: 'bevel' as const, label: 'Bevel' }];

export function strokeOptionsDialog(s: ShapeStroke, onApply: (s: ShapeStroke) => void) {
  const st: ShapeStroke = JSON.parse(JSON.stringify(s));
  const dash = [...(st.dash || []), 0, 0, 0, 0, 0, 0].slice(0, 6);
  const dashed = checkbox('Dashed Line', !!(st.dash && st.dash.length), () => { /* read on OK */ });
  const fields = dash.map((v, i) => numberField(v, x => { dash[i] = x; }, { min: 0, max: 1000, decimals: 2, width: 46, title: i % 2 ? 'Gap' : 'Dash' }));
  const grid = h('div.vo-dash-grid', null, ...fields.map((f, i) => h('label.vo-dash-cell', null, f, h('span', null, i % 2 ? 'gap' : 'dash'))));
  const body = h('div.form', null,
    h('div.form-row', null, h('label.form-label', null, 'Align:'), select(ALIGNS, st.align, v => { st.align = v; }, { width: 110 })),
    h('div.form-row', null, h('label.form-label', null, 'Caps:'), select(CAPS, st.cap || 'butt', v => { st.cap = v; }, { width: 110 })),
    h('div.form-row', null, h('label.form-label', null, 'Corners:'), select(JOINS, st.join || 'miter', v => { st.join = v; }, { width: 110 })),
    h('div.form-row', null, h('label.form-label', null, ''), dashed), grid);
  openDialog({ title: 'Stroke', body, width: 400 }).result.then(ok => {
    if (!ok) return;
    let d = dash.slice();
    while (d.length && !d[d.length - 1]) d.pop();
    if (d.length % 2) d.push(d[d.length - 1] || 1);
    st.dash = dashed.getValue() ? (d.length ? d : [4, 2]) : [];
    onApply(st);
  });
}

export function strokeTypeButton(get: () => ShapeStroke, set: (s: ShapeStroke) => void): HTMLElement & { refresh(): void } {
  const prev = h('span.vo-stroke-prev');
  const b = h('button.vo-stroke-btn', { type: 'button', title: 'Set shape stroke type', 'data-menu-anchor': '' }, prev, h('span.select-caret', null, icon('chevron-down', 12))) as HTMLElement & { refresh(): void };
  b.refresh = () => {
    const s = get(), d = s.dash || [];
    prev.replaceChildren(icon(!d.length ? 'stroke-solid' : d[0] === 0 ? 'stroke-dotted' : 'stroke-dashed', 40));
  };
  b.refresh();
  b.onclick = () => {
    const s = get();
    const pop = h('div.vo-stroke-pop', null, h('div.vo-pop-title', null, 'Stroke Options'));
    const list = h('div.vo-dash-list');
    for (const p of DASH_PRESETS) {
      const on = JSON.stringify(p.dash) === JSON.stringify(s.dash || []);
      const r = h('button.vo-dash-row', { type: 'button', class: on ? 'on' : '', title: p.name }, icon(p.icon, 60));
      r.onclick = () => { set({ ...get(), dash: p.dash.slice(), cap: p.cap || get().cap }); b.refresh(); close(); };
      list.append(r);
    }
    const st = get();
    pop.append(list,
      h('div.vo-row', null, label('Align:'), select(ALIGNS, st.align, v => { set({ ...get(), align: v }); }, { width: 90, title: 'Stroke alignment' })),
      h('div.vo-row', null, label('Caps:'), select(CAPS, st.cap || 'butt', v => set({ ...get(), cap: v }), { width: 90, title: 'Stroke caps' })),
      h('div.vo-row', null, label('Corners:'), select(JOINS, st.join || 'miter', v => set({ ...get(), join: v }), { width: 90, title: 'Stroke corners' })),
      h('div.vo-row', null, h('button.btn.small', { type: 'button', title: 'More stroke options', onclick: () => { close(); strokeOptionsDialog(get(), ns => { set(ns); b.refresh(); }); } }, 'More Options…')));
    const close = showPop(pop, b);
  };
  return b;
}

// ------------------------------------------------------------------ fill / stroke group for the options bar
/** Fill, Stroke, width and type controls. Edits the selected shape layers (when any) and the tool style. */
export function styleControls(): { els: HTMLElement[]; sync(): void } {
  const doc = () => app.activeDoc;
  const shapes = () => selectedShapes(doc());
  const curFill = (): Paint => shapes()[0]?.fill || vstyle.fill;
  const curStroke = (): ShapeStroke => shapes()[0]?.stroke || vstyle.stroke;
  const strokePaint = (): Paint => { const s = curStroke(); return !s.enabled ? { type: 'none' } : s.paint && s.paint.type !== 'solid' ? s.paint : { type: 'solid', color: s.color }; };
  let live: ReturnType<PixDocument['history']['begin']> | null = null;
  const applyLayers = (name: string, fn: (l: ShapeLayer) => void, final: boolean) => {
    const d = doc();
    if (!d || !shapes().length) return;
    if (!final) {
      if (!live) live = d.history.begin(name);
      for (const l of shapes()) { fn(l); l.invalidate(); }
      d.invalidate();
      return;
    }
    if (live) { for (const l of shapes()) { fn(l); l.invalidate(); } live.commit(name); live = null; d.layersChanged(); return; }
    editShapes(d, name, fn);
  };
  const fillBtn = paintButton('Fill', curFill, (p, final) => {
    vstyle.fill = JSON.parse(JSON.stringify(p));
    if (p.color) pushRecent(p.color);
    saveStyle();
    applyLayers('Set Shape Fill', l => { l.fill = JSON.parse(JSON.stringify(p)); }, final);
  });
  const setStroke = (fn: (s: ShapeStroke) => void, name = 'Set Shape Stroke', final = true) => {
    fn(vstyle.stroke);
    saveStyle();
    applyLayers(name, l => { fn(l.stroke); }, final);
    sync();
  };
  const strokeBtn = paintButton('Stroke', strokePaint, (p, final) => setStroke(s => {
    if (p.type === 'none') { s.enabled = false; return; }
    s.enabled = true;
    if (p.type === 'solid') { s.color = p.color || s.color; s.paint = undefined; pushRecent(s.color); }
    else s.paint = JSON.parse(JSON.stringify(p));
  }, 'Set Shape Stroke', final));
  const width = numberField(curStroke().width, v => setStroke(s => { s.width = v; if (!s.enabled && v > 0) s.enabled = true; }), {
    min: 0, max: 288, decimals: 2, unit: 'px', width: 58, title: 'Set shape stroke width',
    onInput: v => setStroke(s => { s.width = v; }, 'Set Shape Stroke', false),
  });
  const type = strokeTypeButton(curStroke, ns => setStroke(s => { Object.assign(s, { ...ns, enabled: s.enabled, color: s.color, width: s.width, paint: s.paint }); }));
  const sync = () => { fillBtn.refresh(); strokeBtn.refresh(); width.setValue(curStroke().width); type.refresh(); };
  return { els: [label('Fill:'), fillBtn, label('Stroke:'), strokeBtn, width, type], sync };
}

// ------------------------------------------------------------------ W / H of the active shape
export function sizeControls(): { els: HTMLElement[]; sync(): void } {
  let link = false;
  const getB = () => { const l = selectedShapes(app.activeDoc)[0]; return l ? tightBounds(l.subpaths) : null; };
  const resize = (w: number | null, hgt: number | null) => {
    const d = app.activeDoc;
    const l = selectedShapes(d)[0];
    const b = getB();
    if (!d || !l || !b) return;
    let sx = w !== null && b.w ? w / b.w : 1, sy = hgt !== null && b.h ? hgt / b.h : 1;
    if (link) { if (w !== null) sy = sx; else sx = sy; }
    if (sx <= 0 || sy <= 0 || (sx === 1 && sy === 1)) return;
    const m = new DOMMatrix().translate(b.x, b.y).scale(sx, sy).translate(-b.x, -b.y);
    d.history.transaction('Transform Shape', () => l.applyMatrix(m));
    d.layersChanged();
    sync();
  };
  const W = numberField(0, v => resize(v, null), { min: 0.01, max: 300000, decimals: 2, unit: 'px', width: 72, label: 'W:', title: 'Set shape width' });
  const H = numberField(0, v => resize(null, v), { min: 0.01, max: 300000, decimals: 2, unit: 'px', width: 72, label: 'H:', title: 'Set shape height' });
  const linkBtn = iconButton('vlink', 'Link shape width and height', () => { link = !link; linkBtn.classList.toggle('active', link); });
  const sync = () => {
    const b = getB();
    for (const f of [W, H]) f.querySelector('input')!.disabled = !b;
    W.setValue(b ? Math.round(b.w * 100) / 100 : 0); H.setValue(b ? Math.round(b.h * 100) / 100 : 0);
  };
  return { els: [W, linkBtn, H], sync };
}

// ------------------------------------------------------------------ path ops / align / arrange / gear
export type OpSetting = 'new' | 'add' | 'subtract' | 'intersect' | 'exclude';
/** Path operations dropdown. For drawing tools `settings.op` is the mode for the next shape; 'merge' always applies. */
export function opsButton(tool: Tool | null, settings: { op?: OpSetting } | null, allowNew = true): Field<string> {
  const b = iconButton(OP_ICONS[settings?.op || 'add'], 'Path operations', () => {
    const d = app.activeDoc;
    const t = d ? targetOf(d) : null;
    const items: MenuEntry[] = (['new', 'add', 'subtract', 'intersect', 'exclude'] as OpSetting[]).filter(o => allowNew || o !== 'new').map(o => ({
      label: OP_LABELS[o], icon: OP_ICONS[o], checked: settings ? settings.op === o : false,
      action: () => {
        if (settings && tool) { settings.op = o; app.saveToolSettings(tool); b.replaceChildren(icon(OP_ICONS[o], 18), h('span.btn-caret')); }
        if (d && t && o !== 'new') applyOpToTarget(d, t, o);
      },
    }));
    items.push('-', { label: OP_LABELS.merge, icon: OP_ICONS.merge, enabled: !!t && t.holder.subpaths.length > 1, action: () => { if (d && t) applyOpToTarget(d, t, 'merge'); } });
    openMenu(items, b, { minWidth: 230 });
  }, { caret: true }) as unknown as Field<string>;
  return b;
}

let alignTo: 'selection' | 'canvas' = 'selection';
export function alignButton(): HTMLElement {
  const b = iconButton('vpath-align', 'Path alignment', () => {
    const d = app.activeDoc, t = d ? targetOf(d) : null;
    const run = (how: string) => () => { if (d && t) alignComponents(d, t, how, alignTo === 'canvas'); };
    const on = !!t;
    openMenu([
      { label: 'Align Left Edges', icon: 'align-left', action: run('left'), enabled: on },
      { label: 'Align Horizontal Centers', icon: 'align-hcenter', action: run('hcenter'), enabled: on },
      { label: 'Align Right Edges', icon: 'align-right', action: run('right'), enabled: on },
      { label: 'Align Top Edges', icon: 'align-top', action: run('top'), enabled: on },
      { label: 'Align Vertical Centers', icon: 'align-vcenter', action: run('vcenter'), enabled: on },
      { label: 'Align Bottom Edges', icon: 'align-bottom', action: run('bottom'), enabled: on },
      '-',
      { label: 'Distribute Widths', icon: 'distribute-horizontal', action: run('distH'), enabled: on },
      { label: 'Distribute Heights', icon: 'distribute-vertical', action: run('distV'), enabled: on },
      '-',
      { header: true, label: 'Align To' },
      { label: 'Align To Selection', radio: true, checked: alignTo === 'selection', action: () => { alignTo = 'selection'; } },
      { label: 'Align To Canvas', radio: true, checked: alignTo === 'canvas', action: () => { alignTo = 'canvas'; } },
    ], b, { minWidth: 220 });
  }, { caret: true });
  return b;
}
export function arrangeButton(): HTMLElement {
  const b = iconButton('vpath-arrange', 'Path arrangement', () => {
    const d = app.activeDoc, t = d ? targetOf(d) : null;
    const run = (how: 'front' | 'forward' | 'backward' | 'back') => () => { if (d && t) arrangeComponents(d, t, how); };
    const on = !!t && t.holder.subpaths.length > 1;
    openMenu([
      { label: 'Bring Shape to Front', action: run('front'), enabled: on },
      { label: 'Bring Shape Forward', action: run('forward'), enabled: on },
      { label: 'Send Shape Backward', action: run('backward'), enabled: on },
      { label: 'Send Shape to Back', action: run('back'), enabled: on },
    ], b, { minWidth: 200 });
  }, { caret: true });
  return b;
}

/** Gear popover: Path Options (thickness, color) + tool-specific extras. */
export function gearButton(title: string, extras?: () => HTMLElement[]): HTMLElement {
  const b = iconButton('gear', title, () => {
    const pop = h('div.vo-gear-pop', null,
      h('div.vo-pop-title', null, 'Path Options'),
      h('div.vo-row', null, label('Thickness:'), select([0.5, 1, 1.5, 2, 3].map(v => ({ value: v, label: `${v} px` })), pathOptions.thickness, v => { pathOptions.thickness = v; savePathOptions(); }, { width: 80, title: 'Path line thickness' })),
      h('div.vo-row', null, label('Color:'), select(PATH_COLORS.map(([n, c]) => ({ value: c, label: n })), pathOptions.color, v => { pathOptions.color = v; savePathOptions(); }, { width: 110, title: 'Path line color' })),
      ...(extras ? extras() : []));
    showPop(pop, b);
  });
  return b;
}

export function alignEdgesBox(settings: { alignEdges?: boolean }, tool: Tool): HTMLElement {
  return checkbox('Align Edges', !!settings.alignEdges, v => { settings.alignEdges = v; app.saveToolSettings(tool); }, { title: 'Snap vector edges to the pixel grid' });
}

/** Tool mode dropdown (Shape / Path / Pixels). */
export function modeSelect(settings: { mode: string }, tool: Tool, modes: string[], onChange?: () => void): HTMLElement {
  const labels: Record<string, string> = { shape: 'Shape', path: 'Path', pixels: 'Pixels' };
  return select(modes.map(m => ({ value: m, label: labels[m] })), settings.mode, v => { settings.mode = v; app.saveToolSettings(tool); onChange?.(); }, { width: 70, title: 'Pick tool mode' });
}

/** Subscribe `sync` to relevant events; returns cleanup. */
export function onVectorChange(sync: () => void): () => void {
  const offs = [events.on('activeLayer', sync), events.on('layers', sync), events.on('activeDoc', sync), events.on('paths', sync), events.on('history', sync)];
  return () => offs.forEach(f => f());
}
export { separator };
