// Photoshop-style form controls. All return plain elements; most expose .setValue() on the returned element.
import { h, dragPointer, placeFloating } from './dom';
import { icon } from './icons';
import { openMenu, type MenuEntry } from './menu';
import type { Gradient, Pattern, RGB } from '../core/types';
import { toCss } from '../core/color';
import { hooks, resources } from '../core/registry';
import { createCanvas, ctx2d } from '../core/canvas';

export type Field<T> = HTMLElement & { setValue(v: T): void; getValue(): T };

// ------------------------------------------------------------------ basic
export function separator(): HTMLElement { return h('div.opt-sep'); }
export function label(text: string, cls = ''): HTMLElement { return h('span.opt-label' + (cls ? '.' + cls : ''), null, text); }

export function iconButton(name: string, title: string, onClick?: (e: MouseEvent) => void, opts: { size?: number; active?: boolean; disabled?: boolean; cls?: string; caret?: boolean } = {}): HTMLButtonElement {
  const b = h('button.icon-btn', { title, type: 'button', class: [opts.cls || '', opts.active ? 'active' : ''].join(' '), disabled: !!opts.disabled },
    icon(name, opts.size ?? 18), opts.caret ? h('span.btn-caret') : null) as HTMLButtonElement;
  if (onClick) b.addEventListener('click', onClick);
  return b;
}
export function button(text: string, onClick?: (e: MouseEvent) => void, opts: { primary?: boolean; cls?: string; title?: string } = {}): HTMLButtonElement {
  const b = h('button.btn', { type: 'button', class: [opts.primary ? 'primary' : '', opts.cls || ''].join(' '), title: opts.title }, text) as HTMLButtonElement;
  if (onClick) b.addEventListener('click', onClick);
  return b;
}

export function checkbox(text: string, checked: boolean, onChange: (v: boolean) => void, opts: { title?: string } = {}): Field<boolean> {
  const inp = h('input', { type: 'checkbox', checked }) as HTMLInputElement;
  inp.addEventListener('change', () => onChange(inp.checked));
  const el = h('label.checkbox', { title: opts.title }, inp, h('span.check-box', null, icon('check', 12)), text ? h('span', null, text) : null) as unknown as Field<boolean>;
  el.setValue = v => { inp.checked = v; };
  el.getValue = () => inp.checked;
  return el;
}

export function textField(value: string, onChange: (v: string) => void, opts: { width?: number; placeholder?: string; onInput?: (v: string) => void } = {}): Field<string> {
  const inp = h('input.field', { type: 'text', value, placeholder: opts.placeholder || '', style: opts.width ? { width: opts.width + 'px' } : undefined }) as HTMLInputElement;
  inp.addEventListener('change', () => onChange(inp.value));
  if (opts.onInput) inp.addEventListener('input', () => opts.onInput!(inp.value));
  inp.addEventListener('keydown', e => { if (e.key === 'Enter') inp.blur(); e.stopPropagation(); });
  const el = inp as unknown as Field<string>;
  el.setValue = v => { inp.value = v; };
  el.getValue = () => inp.value;
  return el;
}

// ------------------------------------------------------------------ dropdown select
export interface SelectOption<T> { value: T; label: string; icon?: string; disabled?: boolean }
export function select<T>(options: (SelectOption<T> | '-')[], value: T, onChange: (v: T) => void, opts: { width?: number; title?: string; cls?: string } = {}): Field<T> {
  let cur = value;
  const text = h('span.select-text');
  const el = h('button.select', { type: 'button', title: opts.title, 'data-menu-anchor': '', class: opts.cls || '', style: opts.width ? { width: opts.width + 'px' } : undefined },
    text, h('span.select-caret', null, icon('chevron-down', 12))) as unknown as Field<T>;
  const render = () => { const o = options.find(o => o !== '-' && o.value === cur) as SelectOption<T> | undefined; text.textContent = o ? o.label : String(cur ?? ''); };
  render();
  el.addEventListener('click', () => {
    if (el.classList.contains('open')) return;
    el.classList.add('open');
    const items: MenuEntry[] = options.map(o => o === '-' ? '-' : {
      label: o.label, icon: o.icon, checked: o.value === cur, radio: false, enabled: !o.disabled,
      action: () => { cur = o.value; render(); onChange(o.value); },
    });
    openMenu(items, el, { minWidth: el.getBoundingClientRect().width, className: 'select-menu', onClose: () => el.classList.remove('open') });
  });
  el.setValue = v => { cur = v; render(); };
  el.getValue = () => cur;
  return el;
}

// ------------------------------------------------------------------ numbers
export interface NumberOpts {
  min?: number; max?: number; step?: number; decimals?: number; unit?: string; width?: number;
  label?: string;        // scrubby label text (drag horizontally to change value)
  onInput?: (v: number) => void;   // live (while dragging)
  disabled?: boolean;
  title?: string;
}
export function numberField(value: number, onChange: (v: number) => void, o: NumberOpts = {}): Field<number> {
  let cur = value;
  const dec = o.decimals ?? 0, min = o.min ?? -Infinity, max = o.max ?? Infinity, step = o.step ?? 1;
  const fmt = (v: number) => (Number.isFinite(v) ? (dec ? v.toFixed(dec).replace(/\.?0+$/, '') : String(Math.round(v))) : '') + (o.unit ? (o.unit === '%' || o.unit === '°' ? o.unit : ' ' + o.unit) : '');
  const clampV = (v: number) => Math.max(min, Math.min(max, v));
  const inp = h('input.field.num', { type: 'text', value: fmt(cur), disabled: !!o.disabled, title: o.title, style: o.width ? { width: o.width + 'px' } : undefined }) as HTMLInputElement;
  const commit = (v: number, live = false) => {
    if (!Number.isFinite(v)) { inp.value = fmt(cur); return; }
    v = clampV(Math.round(v / (dec ? Math.pow(10, -dec) : 1)) * (dec ? Math.pow(10, -dec) : 1));
    cur = v; inp.value = fmt(v);
    if (live) o.onInput?.(v); else onChange(v);
  };
  inp.addEventListener('change', () => {
    // allow simple math: "100+20", "50*2"
    const raw = inp.value.replace(o.unit || '\u0000', '').replace(/[^\d.+\-*/() ]/g, '');
    let v = parseFloat(raw);
    try { if (/^[\d.+\-*/() ]+$/.test(raw)) v = Function(`return (${raw})`)(); } catch { /* keep parse */ }
    commit(v);
  });
  inp.addEventListener('focus', () => inp.select());
  inp.addEventListener('keydown', e => {
    e.stopPropagation();
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      commit(cur + (e.key === 'ArrowUp' ? 1 : -1) * step * (e.shiftKey ? 10 : 1));
    } else if (e.key === 'Enter') { inp.dispatchEvent(new Event('change')); inp.blur(); }
    else if (e.key === 'Escape') { inp.value = fmt(cur); inp.blur(); }
  });
  inp.addEventListener('wheel', e => {
    if (document.activeElement !== inp) return;
    e.preventDefault();
    commit(cur + (e.deltaY < 0 ? 1 : -1) * step * (e.shiftKey ? 10 : 1));
  }, { passive: false });
  let el: HTMLElement = inp;
  if (o.label !== undefined) {
    const lab = h('span.scrub-label', { title: o.title || 'Drag to adjust' }, o.label);
    lab.addEventListener('pointerdown', e => {
      if (o.disabled) return;
      e.preventDefault();
      const start = cur;
      document.body.classList.add('scrubbing');
      dragPointer(e, (dx, _dy, ev) => commit(start + Math.round(dx / (ev.altKey ? 4 : 1)) * step * (ev.shiftKey ? 10 : 1), true),
        () => { document.body.classList.remove('scrubbing'); onChange(cur); });
    });
    el = h('span.num-wrap', null, lab, inp);
  }
  const f = el as Field<number>;
  f.setValue = v => { cur = v; if (document.activeElement !== inp) inp.value = fmt(v); };
  f.getValue = () => cur;
  return f;
}

/** Thin Photoshop slider with a triangular thumb. `track` may be a CSS background (e.g. gradient). */
export function slider(value: number, min: number, max: number, onInput: (v: number) => void, opts: { onChange?: (v: number) => void; track?: string; step?: number; width?: number; center?: number } = {}): Field<number> {
  let cur = value;
  const thumb = h('div.slider-thumb');
  const fill = h('div.slider-fill');
  const tr = h('div.slider-track', { style: opts.track ? { background: opts.track } : undefined }, opts.track ? null : fill);
  const el = h('div.slider', { style: opts.width ? { width: opts.width + 'px' } : undefined }, tr, thumb) as unknown as Field<number>;
  const pos = () => {
    const t = (cur - min) / (max - min || 1);
    thumb.style.left = `${Math.max(0, Math.min(1, t)) * 100}%`;
    if (!opts.track) {
      const c = opts.center !== undefined ? (opts.center - min) / (max - min) : 0;
      fill.style.left = `${Math.min(c, t) * 100}%`; fill.style.width = `${Math.abs(t - c) * 100}%`;
    }
  };
  const fromX = (clientX: number) => {
    const r = el.getBoundingClientRect();
    let v = min + ((clientX - r.left) / r.width) * (max - min);
    const st = opts.step ?? 1;
    v = Math.round(v / st) * st;
    return Math.max(min, Math.min(max, v));
  };
  el.addEventListener('pointerdown', e => {
    e.preventDefault();
    cur = fromX(e.clientX); pos(); onInput(cur);
    el.classList.add('dragging');
    dragPointer(e, (_dx, _dy, ev) => { cur = fromX(ev.clientX); pos(); onInput(cur); }, () => { el.classList.remove('dragging'); opts.onChange?.(cur); });
  });
  el.setValue = v => { cur = v; pos(); };
  el.getValue = () => cur;
  pos();
  return el;
}

/** Label + slider + number field row (dialogs / panels). */
export function sliderRow(text: string, value: number, min: number, max: number, onChange: (v: number, final: boolean) => void, opts: { unit?: string; decimals?: number; step?: number; track?: string; center?: number; width?: number } = {}): Field<number> {
  const num = numberField(value, v => { sl.setValue(v); onChange(v, true); }, { min, max, unit: opts.unit, decimals: opts.decimals, step: opts.step, width: 56 });
  const sl = slider(value, min, max, v => { num.setValue(v); onChange(v, false); }, { onChange: v => onChange(v, true), track: opts.track, step: opts.step ?? (opts.decimals ? Math.pow(10, -opts.decimals) : 1), center: opts.center });
  const el = h('div.slider-row', null, h('div.slider-row-top', null, h('span.slider-row-label', null, text), num), sl) as unknown as Field<number>;
  el.setValue = v => { num.setValue(v); sl.setValue(v); };
  el.getValue = () => num.getValue();
  return el;
}

/** Options-bar style "Opacity: [100%][v]" field whose arrow pops up a slider. */
export function popupSlider(text: string, value: number, onChange: (v: number) => void, opts: { min?: number; max?: number; unit?: string; width?: number; title?: string } = {}): Field<number> {
  const min = opts.min ?? 0, max = opts.max ?? 100, unit = opts.unit ?? '%';
  const num = numberField(value, v => onChange(v), { min, max, unit, width: opts.width ?? 44, label: text ? text + ':' : undefined, title: opts.title });
  const arrow = h('button.popup-arrow', { type: 'button', 'data-menu-anchor': '' }, icon('chevron-down', 12));
  const el = h('span.popup-slider', { title: opts.title }, num, arrow) as unknown as Field<number>;
  arrow.addEventListener('click', () => {
    const pop = h('div.popup-slider-pop');
    const sl = slider(num.getValue(), min, max, v => num.setValue(v), { onChange: v => onChange(v), width: 140 });
    pop.appendChild(sl);
    document.body.appendChild(pop);
    placeFloating(pop, arrow.getBoundingClientRect());
    const off = (e: PointerEvent) => { if (!pop.contains(e.target as Node) && e.target !== arrow) { pop.remove(); window.removeEventListener('pointerdown', off, true); } };
    setTimeout(() => window.addEventListener('pointerdown', off, true));
  });
  el.setValue = v => num.setValue(v);
  el.getValue = () => num.getValue();
  return el;
}

// ------------------------------------------------------------------ toggles
export function toggleGroup<T>(items: { value: T; icon: string; title: string }[], value: T, onChange: (v: T) => void): Field<T> {
  let cur = value;
  const el = h('div.toggle-group') as unknown as Field<T>;
  const btns = items.map(it => {
    const b = iconButton(it.icon, it.title, () => { cur = it.value; sync(); onChange(it.value); }, { size: 18 });
    el.appendChild(b);
    return b;
  });
  const sync = () => btns.forEach((b, i) => b.classList.toggle('active', items[i].value === cur));
  sync();
  el.setValue = v => { cur = v; sync(); };
  el.getValue = () => cur;
  return el;
}
export function toggleButton(iconName: string, title: string, value: boolean, onChange: (v: boolean) => void): Field<boolean> {
  let cur = value;
  const b = iconButton(iconName, title, () => { cur = !cur; b.classList.toggle('active', cur); onChange(cur); }, { active: value }) as unknown as Field<boolean>;
  b.setValue = v => { cur = v; b.classList.toggle('active', v); };
  b.getValue = () => cur;
  return b;
}

// ------------------------------------------------------------------ color / gradient / pattern
export function colorSwatch(color: RGB, onChange: (c: RGB) => void, opts: { title?: string; size?: number } = {}): Field<RGB> {
  let cur = color;
  const el = h('button.color-swatch', { type: 'button', title: opts.title || 'Click to set color', style: { width: (opts.size ?? 22) + 'px', height: (opts.size ?? 22) + 'px' } }) as unknown as Field<RGB>;
  const paint = () => { el.style.background = toCss(cur); };
  paint();
  el.addEventListener('click', async () => {
    const c = await hooks.openColorPicker(cur, opts.title || 'Color Picker');
    if (c) { cur = c; paint(); onChange(c); }
  });
  el.setValue = c => { cur = c; paint(); };
  el.getValue = () => cur;
  return el;
}

/** Paint a gradient into a canvas (left → right). */
export function gradientCss(g: Gradient): string {
  const stops = g.stops.map(s => `${toCss(s.color, opacityAt(g, s.pos))} ${(s.pos * 100).toFixed(1)}%`);
  return `linear-gradient(90deg, ${stops.join(', ')})`;
}
export function opacityAt(g: Gradient, t: number): number {
  const o = g.opacityStops;
  if (!o.length) return 1;
  if (t <= o[0].pos) return o[0].opacity;
  for (let i = 1; i < o.length; i++) if (t <= o[i].pos) {
    const a = o[i - 1], b = o[i], k = (t - a.pos) / (b.pos - a.pos || 1);
    return a.opacity + (b.opacity - a.opacity) * k;
  }
  return o[o.length - 1].opacity;
}
export function gradientPicker(g: Gradient, onChange: (g: Gradient) => void, opts: { width?: number } = {}): Field<Gradient> {
  let cur = g;
  const preview = h('div.grad-preview');
  const el = h('span.grad-picker', null, preview, h('button.popup-arrow', { type: 'button', 'data-menu-anchor': '' }, icon('chevron-down', 12))) as unknown as Field<Gradient>;
  preview.style.width = (opts.width ?? 110) + 'px';
  const paint = () => { preview.style.backgroundImage = `${gradientCss(cur)}, repeating-conic-gradient(#ccc 0 25%, #fff 0 50%)`; preview.title = cur.name; };
  paint();
  preview.addEventListener('click', async () => { const r = await hooks.openGradientEditor(cur); if (r) { cur = r; paint(); onChange(r); } });
  el.querySelector('.popup-arrow')!.addEventListener('click', e => {
    const pop = h('div.preset-pop');
    for (const p of resources.gradients) {
      const sw = h('div.preset-swatch', { title: p.name });
      sw.style.backgroundImage = `${gradientCss(p)}, repeating-conic-gradient(#ccc 0 25%, #fff 0 50%)`;
      sw.onclick = () => { cur = p; paint(); onChange(p); pop.remove(); };
      pop.appendChild(sw);
    }
    showPop(pop, e.currentTarget as HTMLElement);
  });
  el.setValue = v => { cur = v; paint(); };
  el.getValue = () => cur;
  return el;
}
export function patternPicker(p: Pattern | null, onChange: (p: Pattern) => void): Field<Pattern | null> {
  let cur = p;
  const preview = h('div.pat-preview');
  const el = h('span.grad-picker', null, preview, h('button.popup-arrow', { type: 'button', 'data-menu-anchor': '' }, icon('chevron-down', 12))) as unknown as Field<Pattern | null>;
  const paint = () => { preview.style.backgroundImage = cur ? `url(${thumbURL(cur.canvas)})` : 'none'; preview.title = cur?.name || ''; };
  paint();
  const open = (anchor: HTMLElement) => {
    const pop = h('div.preset-pop');
    for (const pt of resources.patterns) {
      const sw = h('div.preset-swatch.pat', { title: pt.name });
      sw.style.backgroundImage = `url(${thumbURL(pt.canvas)})`;
      sw.onclick = () => { cur = pt; paint(); onChange(pt); pop.remove(); };
      pop.appendChild(sw);
    }
    showPop(pop, anchor);
  };
  preview.addEventListener('click', () => open(preview));
  el.querySelector('.popup-arrow')!.addEventListener('click', e => open(e.currentTarget as HTMLElement));
  el.setValue = v => { cur = v; paint(); };
  el.getValue = () => cur;
  return el;
}
const thumbCache = new WeakMap<HTMLCanvasElement, string>();
export function thumbURL(c: HTMLCanvasElement, size = 48): string {
  let u = thumbCache.get(c);
  if (u) return u;
  const t = createCanvas(Math.min(size, c.width), Math.min(size, c.height));
  ctx2d(t).drawImage(c, 0, 0);
  u = t.toDataURL();
  thumbCache.set(c, u);
  return u;
}

/** Show a floating popover under an anchor; closes on outside click / Escape. Returns close fn. */
export function showPop(pop: HTMLElement, anchor: HTMLElement, onClose?: () => void): () => void {
  pop.classList.add('popover');
  document.body.appendChild(pop);
  placeFloating(pop, anchor.getBoundingClientRect());
  const close = () => { pop.remove(); window.removeEventListener('pointerdown', off, true); window.removeEventListener('keydown', esc, true); onClose?.(); };
  const off = (e: PointerEvent) => { if (!pop.contains(e.target as Node) && !anchor.contains(e.target as Node)) close(); };
  const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
  setTimeout(() => { window.addEventListener('pointerdown', off, true); window.addEventListener('keydown', esc, true); });
  return close;
}

// ------------------------------------------------------------------ layout helpers
/** Collapsible section with a chevron header (Properties panel style). */
export function section(title: string, body: HTMLElement, opts: { collapsed?: boolean; icon?: string; actions?: HTMLElement[] } = {}): HTMLElement {
  const el = h('div.section', { class: opts.collapsed ? 'collapsed' : '' },
    h('div.section-head', null, h('span.section-chevron', null, icon('chevron-down', 12)), opts.icon ? icon(opts.icon, 14) : null, h('span.section-title', null, title), h('span.section-actions', null, ...(opts.actions || []))),
    h('div.section-body', null, body));
  el.querySelector('.section-head')!.addEventListener('click', e => { if ((e.target as Element).closest('.section-actions')) return; el.classList.toggle('collapsed'); });
  return el;
}
/** Form row: label + control(s). */
export function row(labelText: string | null, ...controls: (HTMLElement | null)[]): HTMLElement {
  return h('div.form-row', null, labelText !== null ? h('label.form-label', null, labelText) : null, ...controls);
}
/** Tabs (for dialogs): returns {el, show(i)}. */
export function tabs(names: string[], bodies: HTMLElement[], onSwitch?: (i: number) => void) {
  const head = h('div.tabs-head');
  const body = h('div.tabs-body');
  const show = (i: number) => {
    [...head.children].forEach((t, j) => t.classList.toggle('active', i === j));
    bodies.forEach((b, j) => { b.style.display = i === j ? '' : 'none'; });
    onSwitch?.(i);
  };
  names.forEach((n, i) => head.appendChild(h('button.tab', { type: 'button', onclick: () => show(i) }, n)));
  bodies.forEach(b => body.appendChild(b));
  show(0);
  return { el: h('div.tabs', null, head, body), show };
}
