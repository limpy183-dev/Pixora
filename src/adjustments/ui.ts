// Shared adjustment UI pieces: preset bar (built-in + user presets), slider rows, histogram view,
// canvas eyedroppers (work both from dialogs and the Properties panel), radio groups.
import './adjustments.css';
import './icons';
import { h } from '../ui/dom';
import { icon, registerIcons } from '../ui/icons';
import { iconButton, select, sliderRow, type Field } from '../ui/widgets';
import { openMenu } from '../ui/menu';
import { promptDialog } from '../ui/dialog';
import { toast } from '../ui/toast';
import { CURSORS } from '../ui/cursors';
import { app } from '../core/app';
import type { RGB } from '../core/types';
import { type AdjDef, type Change, Env, clone, histogram, paramsKey, presetParams, type Hist } from './lib';

// ------------------------------------------------------------------ eyedropper icons
registerIcons({
  'adj-dropper-black': `<path d="m14.3 6.8 2.9 2.9-9.6 9.6-3.6.6.6-3.6z" fill="#111" stroke="currentColor"/><path d="M12.9 5.4 18.6 11M16.4 3.6a2.3 2.3 0 0 1 3.2 0l.8.8a2.3 2.3 0 0 1 0 3.2l-2 2-4-4z" fill="currentColor" stroke="none"/>`,
  'adj-dropper-gray': `<path d="m14.3 6.8 2.9 2.9-9.6 9.6-3.6.6.6-3.6z" fill="#8a8a8a" stroke="currentColor"/><path d="M12.9 5.4 18.6 11M16.4 3.6a2.3 2.3 0 0 1 3.2 0l.8.8a2.3 2.3 0 0 1 0 3.2l-2 2-4-4z" fill="currentColor" stroke="none"/>`,
  'adj-dropper-white': `<path d="m14.3 6.8 2.9 2.9-9.6 9.6-3.6.6.6-3.6z" fill="#fff" stroke="currentColor"/><path d="M12.9 5.4 18.6 11M16.4 3.6a2.3 2.3 0 0 1 3.2 0l.8.8a2.3 2.3 0 0 1 0 3.2l-2 2-4-4z" fill="currentColor" stroke="none"/>`,
  'adj-dropper': `<path d="m14.3 6.8 2.9 2.9-9.6 9.6-3.6.6.6-3.6z"/><path d="M12.9 5.4 18.6 11M16.4 3.6a2.3 2.3 0 0 1 3.2 0l.8.8a2.3 2.3 0 0 1 0 3.2l-2 2-4-4z" fill="currentColor" stroke="none"/>`,
  'adj-dropper-plus': `<path d="m12.3 8.8 2.9 2.9-7.6 7.6-3.6.6.6-3.6z"/><path d="M10.9 7.4l5.7 5.6M14.4 5.6a2.3 2.3 0 0 1 3.2 0l.8.8a2.3 2.3 0 0 1 0 3.2l-2 2-4-4z" fill="currentColor" stroke="none"/><path d="M18.5 15v6M15.5 18h6"/>`,
  'adj-dropper-minus': `<path d="m12.3 8.8 2.9 2.9-7.6 7.6-3.6.6.6-3.6z"/><path d="M10.9 7.4l5.7 5.6M14.4 5.6a2.3 2.3 0 0 1 3.2 0l.8.8a2.3 2.3 0 0 1 0 3.2l-2 2-4-4z" fill="currentColor" stroke="none"/><path d="M15.5 18h6"/>`,
  'adj-hand': `<path d="M8.2 20.5v-3.6c-1.4-1.3-3.6-3.9-3.8-5.6-.1-1 1-1.5 1.8-.8L8 12.2V5.3a1.2 1.2 0 0 1 2.4 0V11V3.9a1.2 1.2 0 0 1 2.4 0V11V4.8a1.2 1.2 0 0 1 2.4 0V11.4V7a1.2 1.2 0 0 1 2.4 0v7.5c0 3.4-2 6-5.3 6z"/><path d="M19 3.5v4M17 5.5l2-2 2 2M17 18.5l2 2 2-2M19 20.5v-4"/>`,
});

// cursor while an eyedropper is armed (canvas + modal dialog backdrop)
const style = document.createElement('style');
style.textContent = `body.adj-picking .view-overlay, body.adj-picking .dialog-overlay { cursor: ${CURSORS.eyedropper} !important; }`;
document.head.appendChild(style);

// ------------------------------------------------------------------ canvas eyedropper
interface Armed { btn: HTMLElement; env: Env; cb: (c: RGB, e: PointerEvent, p: { x: number; y: number }) => void }
let armed: Armed | null = null;
const BLOCK = '.dialog, .menu, .popover, #dock, .dock-flyout, .float-panel, .toolbar, .optionsbar, .menubar, .doc-tabs, .statusbar';
function onPick(e: PointerEvent) {
  if (!armed || e.button !== 0) return;
  const vp = app.viewport;
  const t = e.target as Element | null;
  if (!vp || !t || t.closest(BLOCK)) return;
  const r = vp.el.getBoundingClientRect();
  if (e.clientX < r.left || e.clientY < r.top || e.clientX >= r.right || e.clientY >= r.bottom) return;
  e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
  const p = vp.screenToDoc(e.clientX - r.left, e.clientY - r.top);
  const c = armed.env.sample(p.x, p.y);
  if (c) armed.cb(c, e, p);
  else toast('Click inside the image to sample a color.');
}
export function armEyedropper(btn: HTMLElement, env: Env, cb: Armed['cb']) {
  const same = armed?.btn === btn;
  disarmEyedropper();
  if (same) return; // clicking the active dropper again turns it off
  armed = { btn, env, cb };
  btn.classList.add('active');
  document.body.classList.add('adj-picking');
  window.addEventListener('pointerdown', onPick, true);
  app.status('Click in the image to sample a color');
}
export function disarmEyedropper(onlyWithin?: HTMLElement) {
  if (!armed || (onlyWithin && !onlyWithin.contains(armed.btn))) return;
  armed.btn.classList.remove('active');
  armed = null;
  document.body.classList.remove('adj-picking');
  window.removeEventListener('pointerdown', onPick, true);
}
export function dropperButton(name: string, title: string, env: Env, cb: Armed['cb']): HTMLButtonElement {
  const b = iconButton(name, title, () => armEyedropper(b, env, cb), { cls: 'adj-dropper' });
  return b;
}

// ------------------------------------------------------------------ small controls
export function sliderField(text: string, value: number, min: number, max: number, set: (v: number) => void, change: Change,
  opts: { unit?: string; decimals?: number; step?: number; track?: string; center?: number } = {}): Field<number> {
  const r = sliderRow(text, value, min, max, (v, final) => { set(v); change(final); }, opts);
  if (opts.track) r.classList.add('adj-grad');
  r.classList.add('adj-slider');
  return r;
}
export function radioGroup<T>(name: string, items: [T, string][], value: T, onChange: (v: T) => void, cls = ''): HTMLElement & { setValue(v: T): void } {
  const grp = `adjr${Math.random().toString(36).slice(2, 8)}`;
  const inputs: HTMLInputElement[] = [];
  const el = h('div.adj-radios' + (cls ? '.' + cls : ''), { role: 'radiogroup', 'aria-label': name },
    ...items.map(([v, label]) => {
      const inp = h('input', { type: 'radio', name: grp, checked: v === value }) as HTMLInputElement;
      inp.addEventListener('change', () => { if (inp.checked) onChange(v); });
      inputs.push(inp);
      return h('label.adj-radio', null, inp, h('span.adj-radio-dot'), h('span', null, label));
    })) as HTMLElement & { setValue(v: T): void };
  el.setValue = v => inputs.forEach((inp, i) => { inp.checked = items[i][0] === v; });
  return el;
}
export const CHANNELS: [string, string][] = [['rgb', 'RGB'], ['r', 'Red'], ['g', 'Green'], ['b', 'Blue']];
export function channelSelect(value: string, onChange: (v: string) => void) {
  return select(CHANNELS.map(([v, l]) => ({ value: v, label: l })), value, onChange, { width: 110, title: 'Channel' });
}
export const track = {
  rainbow: 'linear-gradient(90deg,#f00,#ff0 16.6%,#0f0 33.3%,#0ff 50%,#00f 66.6%,#f0f 83.3%,#f00)',
  rainbowCenter: 'linear-gradient(90deg,#0ff,#00f 16.6%,#f0f 33.3%,#f00 50%,#ff0 66.6%,#0f0 83.3%,#0ff)',
  gray: 'linear-gradient(90deg,#000,#fff)',
  two: (a: string, b: string) => `linear-gradient(90deg,${a},${b})`,
  three: (a: string, b: string, c: string) => `linear-gradient(90deg,${a},${b},${c})`,
};

// ------------------------------------------------------------------ histogram view
/** Vertical scale for a histogram: clips isolated spikes (flat colour areas) like Photoshop. */
export function histScale(arr: ArrayLike<number>): number {
  const sorted = Array.from(arr).sort((a, b) => b - a);
  let sum = 0, nz = 0;
  for (const v of sorted) if (v) { sum += v; nz++; }
  const mean = nz ? sum / nz : 1;
  return Math.max(1, Math.min(sorted[0], Math.max(sorted[Math.min(12, sorted.length - 1)] * 1.15, mean * 3)));
}
/** Canvas that draws the source histogram for the chosen channel ('rgb' = all channels, 'l' = luminosity). */
export function histogramView(env: Env, w: number, hgt: number, channel: () => string, cls = 'adj-hist') {
  const c = h('canvas.' + cls, { width: w * 2, height: hgt * 2, style: { width: w + 'px', height: hgt + 'px' } }) as HTMLCanvasElement;
  let hist: Hist | null = null;
  const draw = () => {
    const x = c.getContext('2d')!;
    x.clearRect(0, 0, c.width, c.height);
    if (!hist) { const img = env.stats(); hist = img ? histogram(img) : null; }
    if (!hist || !hist.n) return;
    const ch = channel();
    const arr = new Float64Array(256);
    for (let i = 0; i < 256; i++) arr[i] = ch === 'r' ? hist.r[i] : ch === 'g' ? hist.g[i] : ch === 'b' ? hist.b[i] : ch === 'l' ? hist.l[i] : hist.r[i] + hist.g[i] + hist.b[i];
    // scale like PS: ignore the extreme spikes when normalising
    const max = histScale(arr);
    const cs = getComputedStyle(c);
    x.fillStyle = cs.getPropertyValue('--adj-hist-color').trim() || cs.color;
    const bw = c.width / 256;
    x.beginPath();
    x.moveTo(0, c.height);
    for (let i = 0; i < 256; i++) {
      const y = c.height - Math.min(1, arr[i] / max) * c.height;
      x.lineTo(i * bw, y); x.lineTo((i + 1) * bw, y);
    }
    x.lineTo(c.width, c.height);
    x.closePath();
    x.fill();
  };
  const off = env.onInvalidate(() => { hist = null; draw(); });
  requestAnimationFrame(draw);
  return Object.assign(c, { redraw: draw, dispose: off });
}

// ------------------------------------------------------------------ user presets (localStorage)
const userKey = (type: string) => `pixora.adjPresets.${type}`;
function userPresets(type: string): { name: string; params: any }[] {
  try { return JSON.parse(localStorage.getItem(userKey(type)) || '[]'); } catch { return []; }
}
function saveUserPresets(type: string, list: { name: string; params: any }[]) {
  try { localStorage.setItem(userKey(type), JSON.stringify(list)); } catch { /* ignore */ }
}

/** Replace the contents of params object p with q (keeps identity so bindings stay valid). */
export function assignParams(p: any, q: any) {
  for (const k of Object.keys(p)) if (k[0] !== '_') delete p[k];
  Object.assign(p, clone(q));
}

// ------------------------------------------------------------------ mount (preset bar + def.build, rebuildable)
export interface MountOpts { presets?: boolean }
/**
 * Build the full adjustment UI into `el`. Returns a cleanup fn.
 * env.rebuild() re-renders (used after Auto / presets / eyedroppers that change many values).
 */
export function mountAdjustmentUI(def: AdjDef, el: HTMLElement, p: any, change: Change, env: Env, opts: MountOpts = {}): () => void {
  let cleanup: void | (() => void);
  let bar: (HTMLElement & { refresh(): void }) | null = null;
  let raf = 0;
  const root = h('div.adj-ui', { dataset: { adj: def.type } });
  el.appendChild(root);
  // every edit also refreshes the preset dropdown ("Custom" once the values differ from a preset)
  const ch: Change = final => { change(final); if (bar && !raf) raf = requestAnimationFrame(() => { raf = 0; bar?.refresh(); }); };
  const render = () => {
    if (typeof cleanup === 'function') cleanup();
    disarmEyedropper(root);
    root.replaceChildren();
    bar = opts.presets !== false ? presetBar(def, p, () => { change(true); render(); }) : null;
    if (bar) root.appendChild(bar);
    const body = h('div.adj-body');
    root.appendChild(body);
    if (def.build) cleanup = def.build(body, p, ch, env);
    else body.appendChild(h('div.adj-empty', null, 'This adjustment has no settings.'));
  };
  env.rebuild = () => { change(true); render(); };
  render();
  return () => { cancelAnimationFrame(raf); if (typeof cleanup === 'function') cleanup(); disarmEyedropper(root); root.remove(); };
}

function presetBar(def: AdjDef, p: any, applied: () => void): (HTMLElement & { refresh(): void }) | null {
  const builtIn = def.presets || [];
  const user = userPresets(def.type);
  if (!builtIn.length && !user.length) return null;
  const current = () => {
    const k = paramsKey(def.type, p);
    for (const [name] of builtIn) { const q = presetParams(def, name); if (q && paramsKey(def.type, q) === k) return name; }
    for (const u of userPresets(def.type)) if (paramsKey(def.type, u.params) === k) return 'user:' + u.name;
    return 'custom';
  };
  const options = () => {
    const o: any[] = builtIn.map(([n]) => ({ value: n, label: n }));
    const u = userPresets(def.type);
    if (u.length) { o.push('-'); for (const x of u) o.push({ value: 'user:' + x.name, label: x.name }); }
    o.push('-', { value: 'custom', label: 'Custom', disabled: true });
    return o;
  };
  const pick = (v: string) => {
    let q: any = null;
    if (v.startsWith('user:')) q = userPresets(def.type).find(x => 'user:' + x.name === v)?.params;
    else q = presetParams(def, v);
    if (!q) return;
    assignParams(p, q);
    applied();
  };
  const sel = select(options(), current(), pick, { width: 190, title: 'Preset' });
  const menuBtn = iconButton('menu', 'Preset options', e => {
    openMenu([
      { label: 'Save Preset...', action: async () => {
        const name = await promptDialog('Save', 'Preset name:', `${def.label} Preset ${userPresets(def.type).length + 1}`);
        if (!name) return;
        const list = userPresets(def.type).filter(x => x.name !== name);
        list.push({ name, params: JSON.parse(JSON.stringify(p, (k, v) => (k[0] === '_' ? undefined : v))) });
        saveUserPresets(def.type, list);
        applied();
      } },
      { label: 'Delete Current Preset', enabled: current().startsWith('user:'), action: () => {
        const cur = current();
        saveUserPresets(def.type, userPresets(def.type).filter(x => 'user:' + x.name !== cur));
        applied();
      } },
      '-',
      { label: 'Reset to Default', action: () => { assignParams(p, def.defaults()); applied(); } },
    ], e.currentTarget as HTMLElement);
  }, { size: 16, cls: 'adj-preset-menu' });
  const row = h('div.adj-preset-row', null, h('span.adj-lbl', null, 'Preset:'), sel, menuBtn) as HTMLElement & { refresh(): void };
  row.refresh = () => sel.setValue(current());
  return row;
}

export { icon, h };
