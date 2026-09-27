// Small form helpers shared by the Image menu dialogs.
import './image.css';
import { h } from '../../ui/dom';
import { select } from '../../ui/widgets';
import { UNIT_LABELS, fromPx, toPx, unitDecimals, type Unit } from '../../core/units';
import { app } from '../../core/app';
import { layerClasses } from '../../core/layer';

export type Radio<T> = HTMLElement & { value: T; set(v: T): void; enable(v: T, on: boolean): void };
export function radioGroup<T>(items: { value: T; label: string; disabled?: boolean }[], value: T, onChange: (v: T) => void, opts: { inline?: boolean } = {}): Radio<T> {
  const name = 'r' + Math.random().toString(36).slice(2);
  const inputs: HTMLInputElement[] = [];
  const el = h('div.imgd-radios', { class: opts.inline ? 'inline' : '' }) as unknown as Radio<T>;
  items.forEach(it => {
    const inp = h('input', { type: 'radio', name, checked: it.value === value, disabled: !!it.disabled }) as HTMLInputElement;
    inp.addEventListener('change', () => { if (inp.checked) { el.value = it.value; onChange(it.value); } });
    inputs.push(inp);
    el.appendChild(h('label.imgd-radio', null, inp, h('span', null, it.label)));
  });
  el.value = value;
  el.set = v => { el.value = v; inputs.forEach((inp, i) => { inp.checked = items[i].value === v; }); };
  el.enable = (v, on) => { const i = items.findIndex(x => x.value === v); if (i >= 0) { inputs[i].disabled = !on; inputs[i].parentElement!.classList.toggle('disabled', !on); } };
  return el;
}

export type NumInput = HTMLInputElement & { num: number; show(v: number, decimals?: number): void };
/** Plain numeric text field: onInput while typing (valid numbers only), onCommit on change. */
export function numInput(width: number, onCommit: (v: number) => void, onInput?: (v: number) => void, opts: { disabled?: boolean; title?: string } = {}): NumInput {
  const inp = h('input.field.imgd-num', { type: 'text', style: { width: width + 'px' }, disabled: !!opts.disabled, title: opts.title }) as NumInput;
  let dec = 0;
  const parse = () => { const v = parseFloat(inp.value.replace(',', '.')); return Number.isFinite(v) ? v : NaN; };
  inp.addEventListener('input', () => { const v = parse(); if (!Number.isNaN(v)) onInput?.(v); });
  inp.addEventListener('change', () => { const v = parse(); if (Number.isNaN(v)) inp.show(inp.num, dec); else onCommit(v); });
  inp.addEventListener('focus', () => inp.select());
  inp.show = (v, d = dec) => {
    dec = d; inp.num = v;
    if (document.activeElement === inp) return;
    inp.value = Number.isFinite(v) ? (d ? String(Math.round(v * 10 ** d) / 10 ** d) : String(Math.round(v))) : '';
  };
  inp.num = 0;
  return inp;
}

export const unitOptions = (units: Unit[]) => units.map(u => ({ value: u, label: UNIT_LABELS[u] }));
export const ALL_UNITS: Unit[] = ['%', 'px', 'in', 'cm', 'mm', 'pt', 'pica'];
export function unitSelect(value: Unit, onChange: (u: Unit) => void, units: Unit[] = ALL_UNITS, width = 120) {
  return select(unitOptions(units), value, onChange, { width, title: 'Units' });
}
/** Show `px` in `unit` in a NumInput. */
export function showIn(inp: NumInput, px: number, unit: Unit, res: number, ref: number) {
  inp.show(fromPx(px, unit, res, ref), unitDecimals(unit));
}
export const pxFrom = (v: number, unit: Unit, res: number, ref: number) => toPx(v, unit, res, ref);
/** "16 cm" style label for a pixel length. */
export function lenLabel(px: number, unit: Unit, res: number, ref: number): string {
  const v = fromPx(px, unit, res, ref), d = unitDecimals(unit);
  const s = d ? String(Math.round(v * 10 ** d) / 10 ** d) : String(Math.round(v));
  return `${s} ${unit === 'px' ? 'px' : unit === '%' ? '%' : unit === 'pica' ? 'picas' : unit}`;
}

/** Remembered dialog settings (localStorage, per key). */
export function remember<T extends object>(key: string, defaults: T): T & { save(): void } {
  let v: any = {};
  try { v = JSON.parse(localStorage.getItem('pixora.image.' + key) || '{}'); } catch { /* ignore */ }
  const o = Object.assign({}, defaults, v);
  Object.defineProperty(o, 'save', { enumerable: false, value: () => { try { const c = { ...o }; localStorage.setItem('pixora.image.' + key, JSON.stringify(c)); } catch { /* ignore */ } } });
  return o;
}

export const dialogRow = (label: string, ...kids: (HTMLElement | string | null)[]) => h('div.form-row', null, h('label.form-label', null, label), ...kids);

/** Default display unit for physical sizes of a document. */
export const defaultUnit = (): Unit => (app.activeDoc?.resolutionUnit === 'ppcm' ? 'cm' : 'in');
export const hasLayerKind = (k: string) => !!layerClasses[k];
