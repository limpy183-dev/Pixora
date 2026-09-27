// Layer > Layer Style dialog: Styles, Blending Options (mode, opacity, fill opacity, Blend Interior Effects as Group,
// Blend If sliders for This Layer / Underlying Layer) and every effect page (multiple strokes / shadows / overlays via
// "+"), with live preview on the canvas, preview swatch, New Style..., Make Default / Reset to Default.
import './effects.css';
import { app } from '../core/app';
import type { PixDocument } from '../core/document';
import type { Layer } from '../core/layer';
import { hooks, resources } from '../core/registry';
import { createCanvas, ctx2d } from '../core/canvas';
import { BLEND_MODE_LABELS, BLEND_MODE_MENU, type BlendMode, type EffectType, type LayerEffect } from '../core/types';
import { h, clear, dragPointer } from '../ui/dom';
import { icon } from '../ui/icons';
import { openDialog, promptDialog } from '../ui/dialog';
import { checkbox, colorSwatch, gradientPicker, iconButton, numberField, patternPicker, select, slider, type SelectOption } from '../ui/widgets';
import { toast } from '../ui/toast';
import { CONTOURS, defaultEffect, normEffect } from './engine';
import { globalLight, renderEffects } from './render';
import { EFFECT_LABELS, EFFECT_ORDER } from '../features/layers/shared';

// ------------------------------------------------------------------ schema
type Kind = 'mode' | 'color' | 'pct' | 'px' | 'angle' | 'contour' | 'check' | 'gradient' | 'pattern' | 'sel' | 'num' | 'sep';
interface Field { k: string; label: string; kind: Kind; min?: number; max?: number; opts?: SelectOption<any>[]; show?: (e: LayerEffect) => boolean }
const MULTI: EffectType[] = ['stroke', 'innerShadow', 'colorOverlay', 'gradientOverlay', 'dropShadow'];
const MODES: (SelectOption<BlendMode> | '-')[] = BLEND_MODE_MENU.map(m => (m === '-' ? '-' : { value: m, label: BLEND_MODE_LABELS[m] }));
const GSTYLE = [{ value: 'linear', label: 'Linear' }, { value: 'radial', label: 'Radial' }, { value: 'angle', label: 'Angle' }, { value: 'reflected', label: 'Reflected' }, { value: 'diamond', label: 'Diamond' }];
const SCHEMA: Record<EffectType, { title: string; sections: [string, Field[]][] }> = {
  dropShadow: { title: 'Drop Shadow', sections: [['Structure', [
    { k: 'mode', label: 'Blend Mode', kind: 'mode' }, { k: 'color', label: '', kind: 'color' }, { k: 'opacity', label: 'Opacity', kind: 'pct' },
    { k: 'angle', label: 'Angle', kind: 'angle' }, { k: 'distance', label: 'Distance', kind: 'px', max: 30000 }, { k: 'spread', label: 'Spread', kind: 'pct' }, { k: 'size', label: 'Size', kind: 'px', max: 250 },
  ]], ['Quality', [{ k: 'contour', label: 'Contour', kind: 'contour' }, { k: 'antiAlias', label: 'Anti-aliased', kind: 'check' }, { k: 'noise', label: 'Noise', kind: 'pct' }, { k: 'knockout', label: 'Layer Knocks Out Drop Shadow', kind: 'check' }]]] },
  innerShadow: { title: 'Inner Shadow', sections: [['Structure', [
    { k: 'mode', label: 'Blend Mode', kind: 'mode' }, { k: 'color', label: '', kind: 'color' }, { k: 'opacity', label: 'Opacity', kind: 'pct' },
    { k: 'angle', label: 'Angle', kind: 'angle' }, { k: 'distance', label: 'Distance', kind: 'px', max: 30000 }, { k: 'choke', label: 'Choke', kind: 'pct' }, { k: 'size', label: 'Size', kind: 'px', max: 250 },
  ]], ['Quality', [{ k: 'contour', label: 'Contour', kind: 'contour' }, { k: 'antiAlias', label: 'Anti-aliased', kind: 'check' }, { k: 'noise', label: 'Noise', kind: 'pct' }]]] },
  outerGlow: { title: 'Outer Glow', sections: [['Structure', [
    { k: 'mode', label: 'Blend Mode', kind: 'mode' }, { k: 'opacity', label: 'Opacity', kind: 'pct' }, { k: 'noise', label: 'Noise', kind: 'pct' },
    { k: 'fill', label: 'Fill', kind: 'sel', opts: [{ value: 'color', label: 'Color' }, { value: 'gradient', label: 'Gradient' }] },
    { k: 'color', label: 'Color', kind: 'color', show: e => e.fill !== 'gradient' }, { k: 'gradient', label: 'Gradient', kind: 'gradient', show: e => e.fill === 'gradient' },
  ]], ['Elements', [{ k: 'technique', label: 'Technique', kind: 'sel', opts: [{ value: 'softer', label: 'Softer' }, { value: 'precise', label: 'Precise' }] }, { k: 'spread', label: 'Spread', kind: 'pct' }, { k: 'size', label: 'Size', kind: 'px', max: 250 }]],
  ['Quality', [{ k: 'contour', label: 'Contour', kind: 'contour' }, { k: 'antiAlias', label: 'Anti-aliased', kind: 'check' }, { k: 'range', label: 'Range', kind: 'pct', min: 1 }, { k: 'jitter', label: 'Jitter', kind: 'pct' }]]] },
  innerGlow: { title: 'Inner Glow', sections: [['Structure', [
    { k: 'mode', label: 'Blend Mode', kind: 'mode' }, { k: 'opacity', label: 'Opacity', kind: 'pct' }, { k: 'noise', label: 'Noise', kind: 'pct' },
    { k: 'fill', label: 'Fill', kind: 'sel', opts: [{ value: 'color', label: 'Color' }, { value: 'gradient', label: 'Gradient' }] },
    { k: 'color', label: 'Color', kind: 'color', show: e => e.fill !== 'gradient' }, { k: 'gradient', label: 'Gradient', kind: 'gradient', show: e => e.fill === 'gradient' },
  ]], ['Elements', [{ k: 'technique', label: 'Technique', kind: 'sel', opts: [{ value: 'softer', label: 'Softer' }, { value: 'precise', label: 'Precise' }] },
    { k: 'source', label: 'Source', kind: 'sel', opts: [{ value: 'center', label: 'Center' }, { value: 'edge', label: 'Edge' }] }, { k: 'choke', label: 'Choke', kind: 'pct' }, { k: 'size', label: 'Size', kind: 'px', max: 250 }]],
  ['Quality', [{ k: 'contour', label: 'Contour', kind: 'contour' }, { k: 'antiAlias', label: 'Anti-aliased', kind: 'check' }, { k: 'range', label: 'Range', kind: 'pct', min: 1 }, { k: 'jitter', label: 'Jitter', kind: 'pct' }]]] },
  bevelEmboss: { title: 'Bevel & Emboss', sections: [['Structure', [
    { k: 'style', label: 'Style', kind: 'sel', opts: [{ value: 'outer', label: 'Outer Bevel' }, { value: 'inner', label: 'Inner Bevel' }, { value: 'emboss', label: 'Emboss' }, { value: 'pillow', label: 'Pillow Emboss' }, { value: 'stroke', label: 'Stroke Emboss' }] },
    { k: 'technique', label: 'Technique', kind: 'sel', opts: [{ value: 'smooth', label: 'Smooth' }, { value: 'chisel-hard', label: 'Chisel Hard' }, { value: 'chisel-soft', label: 'Chisel Soft' }] },
    { k: 'depth', label: 'Depth', kind: 'pct', max: 1000 }, { k: 'direction', label: 'Direction', kind: 'sel', opts: [{ value: 'up', label: 'Up' }, { value: 'down', label: 'Down' }] },
    { k: 'size', label: 'Size', kind: 'px', max: 250 }, { k: 'soften', label: 'Soften', kind: 'px', max: 16 },
  ]], ['Shading', [{ k: 'angle', label: 'Angle', kind: 'angle' }, { k: 'altitude', label: 'Altitude', kind: 'num', min: 0, max: 90 }, { k: 'gloss', label: 'Gloss Contour', kind: 'contour' },
    { k: 'hiMode', label: 'Highlight Mode', kind: 'mode' }, { k: 'hiColor', label: '', kind: 'color' }, { k: 'hiOpacity', label: 'Opacity', kind: 'pct' },
    { k: 'shMode', label: 'Shadow Mode', kind: 'mode' }, { k: 'shColor', label: '', kind: 'color' }, { k: 'shOpacity', label: 'Opacity', kind: 'pct' }]],
  ['Contour', [{ k: 'contourOn', label: 'Contour', kind: 'check' }, { k: 'contour', label: 'Contour', kind: 'contour', show: e => e.contourOn }, { k: 'contourRange', label: 'Range', kind: 'pct', show: e => e.contourOn }]],
  ['Texture', [{ k: 'textureOn', label: 'Texture', kind: 'check' }, { k: 'pattern', label: 'Pattern', kind: 'pattern', show: e => e.textureOn }, { k: 'textureScale', label: 'Scale', kind: 'pct', max: 1000, show: e => e.textureOn }, { k: 'textureDepth', label: 'Depth', kind: 'pct', min: -1000, max: 1000, show: e => e.textureOn }, { k: 'textureInvert', label: 'Invert', kind: 'check', show: e => e.textureOn }]]] },
  satin: { title: 'Satin', sections: [['Structure', [
    { k: 'mode', label: 'Blend Mode', kind: 'mode' }, { k: 'color', label: '', kind: 'color' }, { k: 'opacity', label: 'Opacity', kind: 'pct' },
    { k: 'angle', label: 'Angle', kind: 'angle' }, { k: 'distance', label: 'Distance', kind: 'px', max: 250 }, { k: 'size', label: 'Size', kind: 'px', max: 250 },
    { k: 'contour', label: 'Contour', kind: 'contour' }, { k: 'antiAlias', label: 'Anti-aliased', kind: 'check' }, { k: 'invert', label: 'Invert', kind: 'check' },
  ]]] },
  colorOverlay: { title: 'Color Overlay', sections: [['Color', [{ k: 'mode', label: 'Blend Mode', kind: 'mode' }, { k: 'color', label: '', kind: 'color' }, { k: 'opacity', label: 'Opacity', kind: 'pct' }]]] },
  gradientOverlay: { title: 'Gradient Overlay', sections: [['Gradient', [
    { k: 'mode', label: 'Blend Mode', kind: 'mode' }, { k: 'opacity', label: 'Opacity', kind: 'pct' }, { k: 'gradient', label: 'Gradient', kind: 'gradient' }, { k: 'reverse', label: 'Reverse', kind: 'check' },
    { k: 'style', label: 'Style', kind: 'sel', opts: GSTYLE }, { k: 'align', label: 'Align with Layer', kind: 'check' }, { k: 'angle', label: 'Angle', kind: 'angle' }, { k: 'scale', label: 'Scale', kind: 'pct', min: 10, max: 150 },
    { k: 'dither', label: 'Dither', kind: 'check' }, { k: 'offsetX', label: 'Offset X', kind: 'pct', min: -150, max: 150 }, { k: 'offsetY', label: 'Offset Y', kind: 'pct', min: -150, max: 150 },
  ]]] },
  patternOverlay: { title: 'Pattern Overlay', sections: [['Pattern', [
    { k: 'mode', label: 'Blend Mode', kind: 'mode' }, { k: 'opacity', label: 'Opacity', kind: 'pct' }, { k: 'pattern', label: 'Pattern', kind: 'pattern' },
    { k: 'scale', label: 'Scale', kind: 'pct', min: 1, max: 1000 }, { k: 'link', label: 'Link with Layer', kind: 'check' }, { k: 'offsetX', label: 'Offset X', kind: 'px', min: -5000, max: 5000 }, { k: 'offsetY', label: 'Offset Y', kind: 'px', min: -5000, max: 5000 },
  ]]] },
  stroke: { title: 'Stroke', sections: [['Structure', [
    { k: 'size', label: 'Size', kind: 'px', min: 1, max: 250 }, { k: 'position', label: 'Position', kind: 'sel', opts: [{ value: 'outside', label: 'Outside' }, { value: 'inside', label: 'Inside' }, { value: 'center', label: 'Center' }] },
    { k: 'mode', label: 'Blend Mode', kind: 'mode' }, { k: 'opacity', label: 'Opacity', kind: 'pct' },
  ]], ['Fill Type', [{ k: 'fill', label: 'Fill Type', kind: 'sel', opts: [{ value: 'color', label: 'Color' }, { value: 'gradient', label: 'Gradient' }, { value: 'pattern', label: 'Pattern' }] },
    { k: 'color', label: 'Color', kind: 'color', show: e => e.fill === 'color' },
    { k: 'gradient', label: 'Gradient', kind: 'gradient', show: e => e.fill === 'gradient' }, { k: 'reverse', label: 'Reverse', kind: 'check', show: e => e.fill === 'gradient' },
    { k: 'gradientStyle', label: 'Style', kind: 'sel', opts: [...GSTYLE, { value: 'shape', label: 'Shape Burst' }], show: e => e.fill === 'gradient' },
    { k: 'gradientAngle', label: 'Angle', kind: 'angle', show: e => e.fill === 'gradient' }, { k: 'gradientScale', label: 'Scale', kind: 'pct', min: 10, max: 150, show: e => e.fill === 'gradient' },
    { k: 'pattern', label: 'Pattern', kind: 'pattern', show: e => e.fill === 'pattern' }, { k: 'patternScale', label: 'Scale', kind: 'pct', min: 1, max: 1000, show: e => e.fill === 'pattern' }]]] },
};

// user defaults (Make Default / Reset to Default)
const DEF_KEY = 'pixora.effectDefaults';
const userDefaults = (): Record<string, LayerEffect> => { try { return JSON.parse(localStorage.getItem(DEF_KEY) || '{}'); } catch { return {}; } };
export const newEffect = (t: EffectType): LayerEffect => ({ ...defaultEffect(t), ...(userDefaults()[t] || {}), type: t, enabled: true });

// ------------------------------------------------------------------ angle dial
function angleDial(value: number, onChange: (v: number) => void): HTMLElement & { set(v: number): void } {
  const c = createCanvas(28, 28);
  c.className = 'ls-dial';
  let v = value;
  const drawDial = () => {
    const x = ctx2d(c); x.clearRect(0, 0, 28, 28);
    x.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue('--text') || '#ccc'; x.lineWidth = 1.2;
    x.beginPath(); x.arc(14, 14, 12, 0, Math.PI * 2); x.stroke();
    const a = (v * Math.PI) / 180;
    x.beginPath(); x.moveTo(14, 14); x.lineTo(14 + Math.cos(a) * 11, 14 - Math.sin(a) * 11); x.stroke();
  };
  const fromEvent = (e: PointerEvent) => { const r = c.getBoundingClientRect(); let a = (Math.atan2(-(e.clientY - r.top - 14), e.clientX - r.left - 14) * 180) / Math.PI; if (e.shiftKey) a = Math.round(a / 15) * 15; return Math.round(a); };
  c.addEventListener('pointerdown', e => { v = fromEvent(e); drawDial(); onChange(v); dragPointer(e, (_dx, _dy, ev) => { v = fromEvent(ev as PointerEvent); drawDial(); onChange(v); }, () => {}); });
  drawDial();
  const el = c as any;
  el.set = (n: number) => { v = n; drawDial(); };
  return el;
}

// ------------------------------------------------------------------ dialog
export async function openLayerStyle(doc: PixDocument, layer: Layer, page = 'blending') {
  if (layer.isBackground) { toast('Could not apply a layer style because the Background layer is locked. Convert it to a normal layer first.', 'error', 4000); return; }
  if (layer.kind === 'adjustment') { toast('Layer styles cannot be applied to adjustment layers.', 'error'); return; }
  const tx = doc.history.begin('Layer Style', 'fx');
  const L = layer as any;
  let fx: LayerEffect[] = layer.effects.map(e => normEffect({ ...e }));
  let sel: { page: string; index: number } = { page, index: -1 };
  if (page !== 'blending' && page !== 'styles') {
    let i = fx.findIndex(e => e.type === page);
    if (i < 0) { fx.push(newEffect(page as EffectType)); i = fx.length - 1; }
    else fx[i].enabled = true;
    sel = { page, index: i };
  }
  let previewOn = true;
  const origEffects = layer.effects.map(e => ({ ...e }));
  const push = () => {
    layer.effects = (previewOn ? fx : origEffects).map(e => ({ ...e }));
    layer.invalidate();
    doc.pixelsChanged(layer, null);
    drawSwatch();
  };
  // ---- left list
  const list = h('div.ls-list');
  const pageBox = h('div.ls-page');
  const drawList = () => {
    clear(list);
    const item = (label: string, key: string, index = -1, opts: { check?: boolean; checked?: boolean; plus?: boolean; sub?: boolean } = {}) => {
      const row = h('div.ls-item', { class: `${sel.page === key && sel.index === index ? 'active' : ''} ${opts.sub ? 'sub' : ''}` });
      if (opts.check) {
        const cb = h('input', { type: 'checkbox', checked: !!opts.checked, title: `Enable ${label}` }) as HTMLInputElement;
        cb.addEventListener('click', e => e.stopPropagation());
        cb.addEventListener('change', () => {
          if (index >= 0) fx[index].enabled = cb.checked;
          else if (cb.checked) { fx.push(newEffect(key as EffectType)); sel = { page: key, index: fx.length - 1 }; buildPage(); }
          push(); drawList();
        });
        row.append(cb);
      } else row.append(h('span.ls-cbspace'));
      row.append(h('span.ls-lab', null, label));
      if (opts.plus) {
        const p = h('button.ls-plus', { type: 'button', title: `Add another ${label} effect` }, icon('plus', 11));
        p.addEventListener('click', e => { e.stopPropagation(); const src = index >= 0 ? { ...fx[index] } : newEffect(key as EffectType); fx.splice(index >= 0 ? index + 1 : fx.length, 0, { ...src, enabled: true }); sel = { page: key, index: index >= 0 ? index + 1 : fx.length - 1 }; push(); drawList(); buildPage(); });
        row.append(p);
      }
      row.addEventListener('click', () => {
        if (index < 0 && key !== 'blending' && key !== 'styles') { fx.push(newEffect(key as EffectType)); index = fx.length - 1; push(); }
        sel = { page: key, index }; drawList(); buildPage();
      });
      list.append(row);
    };
    item('Styles', 'styles');
    item('Blending Options', 'blending');
    for (const t of EFFECT_ORDER) {
      const inst = fx.map((e, i) => ({ e, i })).filter(o => o.e.type === t);
      if (!inst.length) item(EFFECT_LABELS[t], t, -1, { check: true, checked: false, plus: MULTI.includes(t) });
      else for (const { e, i } of inst) item(EFFECT_LABELS[t], t, i, { check: true, checked: e.enabled, plus: MULTI.includes(t) });
      if (t === 'bevelEmboss') { item('Contour', 'bevelEmboss', -2, { sub: true }); item('Texture', 'bevelEmboss', -3, { sub: true }); }
    }
    // Contour / Texture sub items select the bevel page
    list.querySelectorAll('.ls-item.sub').forEach(el => el.addEventListener('click', () => {
      const i = fx.findIndex(e => e.type === 'bevelEmboss');
      if (i < 0) { fx.push(newEffect('bevelEmboss')); push(); }
      sel = { page: 'bevelEmboss', index: fx.findIndex(e => e.type === 'bevelEmboss') }; drawList(); buildPage();
    }, { capture: true }));
  };
  // ---- pages
  const row = (label: string, ...els: (HTMLElement | null)[]) => h('div.ls-row', null, h('label.ls-flab', null, label), ...els);
  const buildEffectPage = (e: LayerEffect, i: number) => {
    const sch = SCHEMA[e.type];
    pageBox.append(h('div.ls-title', null, sch.title));
    const rebuildOnChange = new Set(['fill', 'contourOn', 'textureOn']);
    for (const [secTitle, fields] of sch.sections) {
      const sec = h('fieldset.ls-sec', null, h('legend', null, secTitle));
      for (const f of fields) {
        if (f.show && !f.show(e)) continue;
        const set = (v: any) => { fx[i] = { ...fx[i], [f.k]: v }; e = fx[i]; push(); if (rebuildOnChange.has(f.k)) buildPage(); };
        let ctl: HTMLElement;
        switch (f.kind) {
          case 'mode': ctl = select<BlendMode>(MODES, e[f.k], set, { width: 140, title: f.label }); break;
          case 'color': ctl = colorSwatch(e[f.k], set, { title: 'Set the color' }); break;
          case 'pct': case 'px': case 'num': {
            const min = f.min ?? 0, max = f.max ?? (f.kind === 'pct' ? 100 : 250);
            const n = numberField(e[f.k], v => { sl.setValue(v); set(v); }, { min, max, unit: f.kind === 'pct' ? '%' : f.kind === 'px' ? 'px' : '°', width: 58, title: f.label });
            const sl = slider(e[f.k], min, Math.min(max, f.kind === 'px' ? 250 : max), v => { n.setValue(v); fx[i] = { ...fx[i], [f.k]: v }; e = fx[i]; push(); }, { width: 150 });
            ctl = h('span.ls-slide', null, sl, n);
            break;
          }
          case 'angle': {
            const useG = 'useGlobal' in e;
            const cur = () => (useG && e.useGlobal ? globalLight(doc).angle : e[f.k]);
            const dial = angleDial(cur(), v => { n.setValue(v); apply(v); });
            const apply = (v: number) => {
              if (useG && e.useGlobal) { doc.extra = { ...doc.extra, globalLight: { ...globalLight(doc), angle: v } }; for (const l of doc.allLayers()) if (l.effects.length) l.invalidate(); doc.pixelsChanged(null, null); drawSwatch(); }
              else set(v);
            };
            const n = numberField(cur(), v => { dial.set(v); apply(v); }, { min: -180, max: 180, unit: '°', width: 52, title: 'Angle' });
            const g = useG ? checkbox('Use Global Light', !!e.useGlobal, v => { set(v); const a = cur(); dial.set(a); n.setValue(a); }, { title: 'Use the document-wide light angle' }) : null;
            ctl = h('span.ls-slide', null, dial, n, g);
            break;
          }
          case 'contour': ctl = select(CONTOURS.map(c => ({ value: c.id, label: c.label })), e[f.k] || 'linear', set, { width: 170, title: 'Contour' }); break;
          case 'check': ctl = checkbox(f.label, !!e[f.k], set); break;
          case 'gradient': ctl = gradientPicker(e[f.k], set, { width: 170 }); break;
          case 'pattern': ctl = patternPicker(resources.patterns.find(p => p.id === e[f.k]) || resources.patterns[0] || null, p => set(p.id)); break;
          case 'sel': ctl = select(f.opts || [], e[f.k], set, { width: 140, title: f.label }); break;
          default: ctl = h('span');
        }
        sec.append(f.kind === 'check' ? row('', ctl) : row(f.label, ctl));
      }
      pageBox.append(sec);
    }
    const mk = h('button.btn', { type: 'button', title: 'Save these settings as the default for new effects of this kind' }, 'Make Default');
    mk.addEventListener('click', () => { const d = userDefaults(); const { enabled: _e, ...rest } = fx[i]; d[e.type] = rest as LayerEffect; localStorage.setItem(DEF_KEY, JSON.stringify(d)); toast(`${sch.title} defaults saved`, 'success'); });
    const rs = h('button.btn', { type: 'button', title: 'Restore the default settings' }, 'Reset to Default');
    rs.addEventListener('click', () => { fx[i] = { ...newEffect(e.type), enabled: fx[i].enabled }; push(); buildPage(); });
    const del = h('button.btn', { type: 'button', title: 'Remove this effect' }, 'Delete Effect');
    del.addEventListener('click', () => { fx.splice(i, 1); sel = { page: 'blending', index: -1 }; push(); drawList(); buildPage(); });
    pageBox.append(h('div.ls-buttons', null, mk, rs, del));
  };
  const buildBlending = () => {
    pageBox.append(h('div.ls-title', null, 'Blending Options'));
    const gen = h('fieldset.ls-sec', null, h('legend', null, 'General Blending'),
      row('Blend Mode', select<BlendMode>(MODES, layer.blendMode, v => { layer.blendMode = v; layer.invalidate(); doc.pixelsChanged(layer, null); doc.layersChanged(); }, { width: 140 })),
      row('Opacity', pctSlide(layer.opacity * 100, v => { layer.opacity = v / 100; layer.invalidate(); doc.pixelsChanged(layer, null); doc.layersChanged(); })));
    const adv = h('fieldset.ls-sec', null, h('legend', null, 'Advanced Blending'),
      row('Fill Opacity', pctSlide(layer.fillOpacity * 100, v => { layer.fillOpacity = v / 100; layer.invalidate(); doc.pixelsChanged(layer, null); doc.layersChanged(); drawSwatch(); })),
      row('', checkbox('Blend Interior Effects as Group', !!L.blendInterior, v => { L.blendInterior = v; layer.invalidate(); doc.pixelsChanged(layer, null); }, { title: 'Fill opacity also applies to interior effects (inner glow, satin, overlays)' })));
    // Blend If
    const bi = L.blendIf ? JSON.parse(JSON.stringify(L.blendIf)) : {};
    let ch = 'gray';
    const bands = h('div.ls-bands');
    const drawBands = () => {
      clear(bands);
      const cfg = bi[ch] || (bi[ch] = { this: [0, 0, 255, 255], under: [0, 0, 255, 255] });
      for (const which of ['this', 'under'] as const) bands.append(h('div.ls-band-lab', null, which === 'this' ? 'This Layer:' : 'Underlying Layer:', h('span.ls-band-vals', null, `${cfg[which][0]}${cfg[which][0] !== cfg[which][1] ? '/' + cfg[which][1] : ''}  ${cfg[which][2]}${cfg[which][2] !== cfg[which][3] ? '/' + cfg[which][3] : ''}`)), bandSlider(cfg[which], ch, () => { L.blendIf = JSON.parse(JSON.stringify(bi)); layer.invalidate(); doc.pixelsChanged(layer, null); drawBands(); }));
    };
    const blendIf = h('fieldset.ls-sec', null, h('legend', null, 'Blend If'),
      row('Channel', select([{ value: 'gray', label: 'Gray' }, { value: 'red', label: 'Red' }, { value: 'green', label: 'Green' }, { value: 'blue', label: 'Blue' }], ch, v => { ch = v; drawBands(); }, { width: 100 })),
      bands, h('div.ls-hint', null, 'Alt-drag a slider to split it into two halves for a smooth transition.'));
    drawBands();
    pageBox.append(gen, adv, blendIf);
  };
  const buildStyles = () => {
    pageBox.append(h('div.ls-title', null, 'Styles'));
    const grid = h('div.ls-styles');
    for (const st of resources.styles) {
      const b = h('button.ls-style', { type: 'button', title: st.name }, styleThumb(st.effects, 46));
      b.addEventListener('click', () => { fx = st.effects.map(e => normEffect({ ...e } as LayerEffect)); push(); drawList(); });
      grid.append(b);
    }
    pageBox.append(grid);
  };
  const buildPage = () => {
    clear(pageBox);
    if (sel.page === 'styles') buildStyles();
    else if (sel.page === 'blending') buildBlending();
    else {
      let i = sel.index;
      if (i < 0 || !fx[i] || fx[i].type !== sel.page) i = fx.findIndex(e => e.type === sel.page);
      if (i < 0) { fx.push(newEffect(sel.page as EffectType)); i = fx.length - 1; push(); }
      sel.index = i;
      buildEffectPage(fx[i], i);
    }
  };
  // ---- preview swatch & side buttons
  const sw = createCanvas(64, 64); sw.className = 'ls-swatch';
  const drawSwatch = () => { const t = styleThumb(fx.filter(e => e.enabled), 64, layer.fillOpacity) as HTMLCanvasElement; const x = ctx2d(sw); x.clearRect(0, 0, 64, 64); x.drawImage(t, 0, 0); };
  const newStyleBtn = h('button.btn', { type: 'button', title: 'Save the current effects as a new style preset' }, 'New Style...');
  newStyleBtn.addEventListener('click', async () => {
    const n = await promptDialog('New Style', 'Name:', `Style ${resources.styles.length + 1}`);
    if (!n) return;
    resources.styles.push({ id: `style-${Date.now().toString(36)}`, name: n, effects: fx.map(e => ({ ...e })) });
    saveUserStyles();
    toast(`Style “${n}” saved`, 'success');
  });
  const prev = checkbox('Preview', true, v => { previewOn = v; push(); }, { title: 'Show the effects on the canvas while editing' });
  drawList(); buildPage(); push();
  const body = h('div.ls-body', null, list, h('div.ls-center', null, pageBox));
  const r = await openDialog({
    title: 'Layer Style', body, layout: 'side', className: 'ls-dialog', width: 900,
    buttons: [{ label: 'OK', primary: true, value: 'ok' }, { label: 'Cancel', value: null }],
    sideExtras: [newStyleBtn, prev, h('div.ls-swatch-wrap', null, sw)],
  }).result;
  if (r === 'ok') {
    layer.effects = fx.map(e => ({ ...e }));
    layer.invalidate();
    tx.commit('Layer Style');
  } else tx.cancel();
  doc.layersChanged();
  doc.pixelsChanged(layer, null);
}

function pctSlide(v: number, on: (v: number) => void) {
  const n = numberField(Math.round(v), x => { s.setValue(x); on(x); }, { min: 0, max: 100, unit: '%', width: 58 });
  const s = slider(v, 0, 100, x => { n.setValue(Math.round(x)); on(x); }, { width: 150 });
  return h('span.ls-slide', null, s, n);
}
/** Blend If dual slider (black / white points, Alt-drag splits). */
function bandSlider(vals: number[], ch: string, changed: () => void): HTMLElement {
  const track = h('div.ls-band', { style: { background: ch === 'gray' ? 'linear-gradient(90deg,#000,#fff)' : `linear-gradient(90deg,#000,${ch === 'red' ? '#f00' : ch === 'green' ? '#0f0' : '#00f'})` } });
  const knobs = [0, 1, 2, 3].map(i => {
    const k = h('div.ls-knob', { class: i < 2 ? 'dark' : 'light', title: 'Drag; Alt-drag to split' });
    k.addEventListener('pointerdown', e => {
      e.preventDefault();
      const r = track.getBoundingClientRect();
      const split = e.altKey;
      dragPointer(e, (_dx, _dy, ev) => {
        const v = Math.round(Math.max(0, Math.min(255, ((ev.clientX - r.left) / r.width) * 255)));
        const pair = i < 2 ? [0, 1] : [2, 3];
        if (split || vals[pair[0]] !== vals[pair[1]]) vals[i] = v; else { vals[pair[0]] = v; vals[pair[1]] = v; }
        vals[0] = Math.min(vals[0], vals[1]); vals[3] = Math.max(vals[3], vals[2]);
        if (vals[1] > vals[2]) { if (i < 2) vals[1] = vals[2]; else vals[2] = vals[1]; }
        pos(); changed();
      }, () => {});
    });
    return k;
  });
  const pos = () => knobs.forEach((k, i) => { k.style.left = `${(vals[i] / 255) * 100}%`; });
  pos();
  track.append(...knobs);
  return track;
}

// ------------------------------------------------------------------ style thumbnails & presets
const thumbCache = new Map<string, HTMLCanvasElement>();
/** Rounded square rendered with the effects (shared by the dialog, the Styles panel and presets). */
export function styleThumb(effects: LayerEffect[], size = 48, fill = 1): HTMLCanvasElement {
  const key = `${size}|${fill}|${JSON.stringify(effects)}`;
  const hit = thumbCache.get(key);
  if (hit) { const c = createCanvas(size, size); ctx2d(c).drawImage(hit, 0, 0); return c; }
  const S = 120, shape = createCanvas(S, S), x = ctx2d(shape);
  x.fillStyle = '#9aa4b2'; x.beginPath(); x.roundRect(28, 28, S - 56, S - 56, 12); x.fill();
  const fake = { effects: effects.filter(e => e.enabled !== false), effectsVisible: true, fillOpacity: fill, _version: Math.random() } as any;
  const doc = app.activeDoc || ({ width: S, height: S, extra: {}, allLayers: () => [] } as any);
  const res = renderEffects(fake, { canvas: shape, x: 0, y: 0 }, doc);
  const out = createCanvas(size, size), ox = ctx2d(out);
  ox.fillStyle = '#e8e8e8'; ox.fillRect(0, 0, size, size);
  const src = res || { canvas: shape, x: 0, y: 0 };
  const k = size / S;
  ox.drawImage(src.canvas, src.x * k, src.y * k, src.canvas.width * k, src.canvas.height * k);
  thumbCache.set(key, out);
  if (thumbCache.size > 200) thumbCache.delete(thumbCache.keys().next().value!);
  const c = createCanvas(size, size); ctx2d(c).drawImage(out, 0, 0);
  return c;
}
const STYLE_KEY = 'pixora.userStyles';
export function saveUserStyles() { try { localStorage.setItem(STYLE_KEY, JSON.stringify(resources.styles.filter(s => s.id.startsWith('style-')))); } catch { /* ignore */ } }
function seedStyles() {
  const E = (t: EffectType, o: any = {}) => ({ ...defaultEffect(t), ...o });
  const presets: [string, LayerEffect[]][] = [
    ['Soft Shadow', [E('dropShadow', { distance: 8, size: 18, opacity: 45 })]],
    ['Hard Shadow', [E('dropShadow', { distance: 10, size: 0, opacity: 70 })]],
    ['Glow', [E('outerGlow', { size: 22, opacity: 80, color: { r: 255, g: 230, b: 120 } })]],
    ['Neon', [E('stroke', { size: 3, color: { r: 0, g: 255, b: 230 } }), E('outerGlow', { size: 28, opacity: 90, color: { r: 0, g: 255, b: 230 } }), E('innerGlow', { size: 10, opacity: 70, color: { r: 200, g: 255, b: 255 } })]],
    ['Button', [E('bevelEmboss', { size: 10, depth: 120 }), E('gradientOverlay', { opacity: 35, mode: 'overlay' }), E('dropShadow', { distance: 4, size: 8, opacity: 40 })]],
    ['Emboss', [E('bevelEmboss', { style: 'emboss', size: 8, depth: 150 })]],
    ['Pillow', [E('bevelEmboss', { style: 'pillow', size: 12, depth: 120 })]],
    ['Chisel', [E('bevelEmboss', { technique: 'chisel-hard', size: 14, depth: 200 })]],
    ['Outline', [E('stroke', { size: 4, color: { r: 20, g: 20, b: 20 } })]],
    ['Red Stroke', [E('stroke', { size: 6, color: { r: 220, g: 30, b: 30 } })]],
    ['Inner Shadow', [E('innerShadow', { distance: 6, size: 10, opacity: 60 })]],
    ['Satin', [E('satin', { color: { r: 40, g: 60, b: 120 }, opacity: 60 })]],
    ['Gold', [E('gradientOverlay', { gradient: { name: 'Gold', stops: [{ pos: 0, color: { r: 120, g: 80, b: 10 } }, { pos: 0.5, color: { r: 255, g: 215, b: 90 } }, { pos: 1, color: { r: 140, g: 95, b: 20 } }], opacityStops: [{ pos: 0, opacity: 1 }, { pos: 1, opacity: 1 }] } }), E('bevelEmboss', { size: 8, depth: 180, hiOpacity: 80 }), E('dropShadow', { distance: 3, size: 6, opacity: 50 })]],
    ['Glass', [E('innerGlow', { size: 18, opacity: 60, color: { r: 255, g: 255, b: 255 } }), E('bevelEmboss', { size: 20, soften: 4, depth: 80, hiOpacity: 90 }), E('dropShadow', { distance: 6, size: 14, opacity: 30 })]],
  ];
  for (const [name, effects] of presets) resources.styles.push({ id: 'preset-' + name.toLowerCase().replace(/\s+/g, '-'), name, effects });
  try { for (const s of JSON.parse(localStorage.getItem(STYLE_KEY) || '[]')) if (!resources.styles.some(x => x.id === s.id)) resources.styles.push(s); } catch { /* ignore */ }
}
seedStyles();

hooks.openLayerStyle = (l: Layer, effect?: string) => { const d = app.activeDoc; if (d) void openLayerStyle(d, l, effect || 'blending'); };
