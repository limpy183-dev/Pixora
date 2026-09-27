// Brush preset picker used in painting tools' options bars: preview + popup with Size, Hardness, Angle/Roundness and
// the brush preset folders. The brushes feature module (src/features/brushes) plugs in folders, stroke thumbnails and
// full-preset application through `brushPickerExt`; without it the picker falls back to a flat list.
import { h } from './dom';
import { icon } from './icons';
import { slider, numberField, showPop } from './widgets';
import { promptDialog } from './dialog';
import { resources, type BrushPreset } from '../core/registry';
import { getTip } from '../core/brush';
import { createCanvas, ctx2d } from '../core/canvas';

export interface BrushSettingsLike { size: number; hardness: number; tipId?: string; roundness?: number; angle?: number; spacing?: number }

/** Extension points installed by the brushes module. */
export const brushPickerExt = {
  groups: null as null | (() => { name: string; items: BrushPreset[] }[]),
  thumb: null as null | ((p: BrushPreset) => string),
  tipThumb: null as null | ((p: BrushPreset) => string),
  apply: null as null | ((s: any, p: BrushPreset) => void),
  newPreset: null as null | ((s: any, name: string) => BrushPreset),
};

function presetThumb(p: BrushPreset, size = 40): HTMLCanvasElement {
  const c = createCanvas(size, size), x = ctx2d(c);
  const tip = getTip({ size: Math.min(size - 6, Math.max(4, p.size)), hardness: p.hardness, tip: p.tip || null });
  const t = createCanvas(tip.width, tip.height), tx = ctx2d(t);
  tx.fillStyle = '#e8e8e8'; tx.fillRect(0, 0, t.width, t.height);
  tx.globalCompositeOperation = 'destination-in'; tx.drawImage(tip, 0, 0);
  const s = Math.min(1, (size - 4) / Math.max(t.width, t.height));
  x.drawImage(t, (size - t.width * s) / 2, (size - t.height * s) / 2, t.width * s, t.height * s);
  return c;
}

const collapsed = new Set<string>();
let lastQuery = '';

/** Open the brush preset popup under `anchor` (element or screen point). */
export function openBrushPopup(s: BrushSettingsLike, anchor: HTMLElement | { x: number; y: number }, onChange: () => void): () => void {
  const size = numberField(s.size, v => { s.size = v; sizeSl.setValue(toSl(v)); onChange(); }, { min: 1, max: 5000, unit: 'px', width: 64 });
  const toSl = (v: number) => (Math.log(v) / Math.log(5000)) * 100;
  const sizeSl = slider(toSl(s.size), 0, 100, v => { s.size = Math.max(1, Math.round(Math.pow(5000, v / 100))); size.setValue(s.size); onChange(); }, { width: 214, step: 0.1 });
  const hard = numberField(Math.round(s.hardness * 100), v => { s.hardness = v / 100; hardSl.setValue(v); onChange(); }, { min: 0, max: 100, unit: '%', width: 64 });
  const hardSl = slider(s.hardness * 100, 0, 100, v => { s.hardness = v / 100; hard.setValue(v); onChange(); }, { width: 214 });
  const extras: HTMLElement[] = [];
  if (s.angle !== undefined || s.roundness !== undefined) {
    const ang = numberField(s.angle ?? 0, v => { s.angle = v; onChange(); }, { min: -180, max: 180, unit: '°', width: 52, label: 'Angle:' });
    const rnd = numberField(Math.round((s.roundness ?? 1) * 100), v => { s.roundness = v / 100; onChange(); }, { min: 1, max: 100, unit: '%', width: 52, label: 'Roundness:' });
    extras.push(h('div.brush-pick-row.brush-pick-ar', null, ang, rnd));
  }
  const list = h('div.brush-pick-list');
  const search = h('input.field.brush-pick-search', { type: 'search', placeholder: 'Search Brushes', value: lastQuery, title: 'Search brushes by name' }) as HTMLInputElement;
  search.addEventListener('keydown', e => e.stopPropagation());
  search.addEventListener('input', () => { lastQuery = search.value; draw(); });
  let close = () => {};
  const pick = (p: BrushPreset) => {
    if (brushPickerExt.apply) brushPickerExt.apply(s, p);
    else {
      s.size = p.size; s.hardness = p.hardness; s.tipId = p.id;
      if (p.roundness !== undefined) s.roundness = p.roundness;
      if (p.angle !== undefined) s.angle = p.angle;
      if (p.spacing !== undefined) s.spacing = p.spacing;
    }
    size.setValue(s.size); sizeSl.setValue(toSl(s.size));
    hard.setValue(Math.round(s.hardness * 100)); hardSl.setValue(s.hardness * 100);
    onChange();
    draw();
  };
  const draw = () => {
    const q = lastQuery.trim().toLowerCase();
    const groups = brushPickerExt.groups ? brushPickerExt.groups() : [{ name: 'Brushes', items: resources.brushes }];
    const out: HTMLElement[] = [];
    for (const g of groups) {
      const items = q ? g.items.filter(p => p.name.toLowerCase().includes(q)) : g.items;
      if (q && !items.length) continue;
      const closed = !q && collapsed.has(g.name);
      const head = h('div.brush-pick-ghead', { title: closed ? 'Expand' : 'Collapse' }, icon(closed ? 'chevron-right' : 'chevron-down', 12), icon('folder-outline', 15), h('span', null, g.name));
      head.addEventListener('click', () => { if (collapsed.has(g.name)) collapsed.delete(g.name); else collapsed.add(g.name); draw(); });
      out.push(head);
      if (closed) continue;
      for (const p of items) {
        const thumb = brushPickerExt.tipThumb ? h('img.brush-pick-tip', { src: brushPickerExt.tipThumb(p), alt: '' }) : presetThumb(p, 36);
        const stroke = brushPickerExt.thumb ? h('img.brush-pick-stroke', { src: brushPickerExt.thumb(p), alt: '' }) : null;
        const cell = h('div.brush-pick-item', { title: `${p.name} (${p.size} px)`, class: s.tipId === p.id ? 'active' : '' },
          h('span.brush-pick-tipwrap', null, thumb, h('span.brush-pick-num', null, String(p.size))), h('span.brush-pick-name', null, p.name), stroke);
        cell.addEventListener('click', () => pick(p));
        cell.addEventListener('dblclick', () => close());
        out.push(cell);
      }
    }
    if (!out.length) out.push(h('div.brush-pick-empty', null, 'No matching brushes.'));
    list.replaceChildren(...out);
  };
  draw();
  const plus = brushPickerExt.newPreset ? h('button.icon-btn.brush-pick-new', { type: 'button', title: 'Create a new preset from this brush' }, icon('plus', 16)) : null;
  plus?.addEventListener('click', async () => {
    const n = resources.brushes.filter(p => (p as any).custom).length + 1;
    const name = await promptDialog('New Brush', 'Name:', `Brush ${n}`);
    if (!name) return;
    brushPickerExt.newPreset!(s, name);
    draw();
  });
  const pop = h('div.brush-pick-pop', null,
    h('div.brush-pick-row', null, h('span', null, 'Size:'), h('span.brush-pick-rowr', null, size, plus)), sizeSl,
    h('div.brush-pick-row', null, h('span', null, 'Hardness:'), hard), hardSl,
    ...extras,
    h('div.brush-pick-sep'), search, list);
  let a: HTMLElement;
  if (anchor instanceof HTMLElement) a = anchor;
  else { a = h('div', { style: { position: 'fixed', left: anchor.x + 'px', top: anchor.y + 'px', width: '1px', height: '1px' } }); document.body.appendChild(a); }
  close = showPop(pop, a, () => { if (!(anchor instanceof HTMLElement)) a.remove(); });
  return close;
}

/**
 * Options-bar brush picker. `s` is the tool's settings object (mutated in place); onChange is called after edits.
 * Other modules (Brushes panel) can extend presets through resources.brushes.
 */
export function brushPicker(s: BrushSettingsLike, onChange: () => void): HTMLElement {
  const preview = h('span.brush-pick-preview');
  const sizeLabel = h('span.brush-pick-size');
  const btn = h('button.brush-pick', { type: 'button', title: 'Brush Preset picker', 'data-menu-anchor': '' }, preview, sizeLabel, icon('chevron-down', 12));
  const paint = () => {
    sizeLabel.textContent = String(Math.round(s.size));
    const p = s.tipId ? resources.brushes.find(b => b.id === s.tipId) : null;
    if (p?.tip && brushPickerExt.tipThumb) {
      preview.style.width = preview.style.height = '22px';
      preview.style.background = `url(${brushPickerExt.tipThumb(p)}) center / contain no-repeat`;
      preview.style.borderRadius = '0';
    } else {
      const r = Math.max(3, Math.min(10, 3 + Math.log2(s.size + 1)));
      preview.style.width = preview.style.height = r * 2 + 'px';
      preview.style.borderRadius = '50%';
      preview.style.background = `radial-gradient(circle, #e8e8e8 ${Math.round(s.hardness * 70)}%, transparent 72%)`;
    }
  };
  paint();
  btn.addEventListener('click', () => openBrushPopup(s, btn, () => { paint(); onChange(); }));
  (btn as any).refresh = paint;
  return btn;
}

/** Resolve the sampled tip canvas for settings.tipId (null for round brushes). */
export function tipFor(s: BrushSettingsLike): HTMLCanvasElement | null {
  if (!s.tipId) return null;
  return resources.brushes.find(b => b.id === s.tipId)?.tip || null;
}
