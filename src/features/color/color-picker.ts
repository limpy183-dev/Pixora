// Photoshop-style Color Picker dialog (replaces hooks.openColorPicker).
// Field 256×256 + 20px slider driven by the selected radio axis (H S B / R G B / L a b), new/current swatches,
// HSB / RGB / Lab / CMYK / hex fields, Only Web Colors, Add to Swatches, Color Libraries, and sampling from the
// document while the dialog is open (like Photoshop's eyedropper cursor over the image).
import './color.css';
import { hooks, resources } from '../../core/registry';
import type { RGB } from '../../core/types';
import { app } from '../../core/app';
import { cmykToRgb, fromHex, rgbToCmyk, toCss, toHex } from '../../core/color';
import { ctx2d } from '../../core/canvas';
import { h } from '../../ui/dom';
import { openDialog, promptDialog } from '../../ui/dialog';
import { checkbox, numberField, select, type Field } from '../../ui/widgets';
import { icon, registerIcons } from '../../ui/icons';
import { CURSORS } from '../../ui/cursors';
import { toast } from '../../ui/toast';
import { AXES, FIELD_AXES, type Axis, type ColorState, axisValue, isWebSafe, paintAxisField, paintAxisSlider, setAxis, setModel, stateFromRgb, toRGB, webSafe } from './model';
import { addSwatch, nextSwatchName } from './store';
import { NAMED_COLORS } from './named-colors';

registerIcons({
  'cp-websafe': '<path d="M12 3 20 7.5v9L12 21l-8-4.5v-9z"/><path d="M4 7.5 12 12l8-4.5M12 12v9"/>',
});

const PREF = 'pixora.colorPicker';
function loadPref(): { axis: Axis; web: boolean } {
  try { return { axis: 'h', web: false, ...JSON.parse(localStorage.getItem(PREF) || '{}') }; } catch { return { axis: 'h', web: false }; }
}
function savePref(p: { axis: Axis; web: boolean }) { try { localStorage.setItem(PREF, JSON.stringify(p)); } catch { /* ignore */ } }

export function openColorPicker(initial: RGB, title = 'Color Picker'): Promise<RGB | null> {
  const pref = loadPref();
  let axis: Axis = pref.axis in AXES ? pref.axis : 'h';
  let web = pref.web;
  const orig = { r: initial.r | 0, g: initial.g | 0, b: initial.b | 0 };
  let st: ColorState = stateFromRgb(orig);
  let libMode = false;

  // ---------------------------------------------------------------- field + slider
  const field = h('canvas.cp-field', { width: 256, height: 256 }) as HTMLCanvasElement;
  const ring = h('div.cp-ring');
  const fieldWrap = h('div.cp-field-wrap', { title: 'Click or drag to pick a color' }, field, ring);
  const strip = h('canvas.cp-strip', { width: 1, height: 256 }) as HTMLCanvasElement;
  const triL = h('div.cp-tri.l'), triR = h('div.cp-tri.r');
  const sliderWrap = h('div.cp-slider-wrap', { title: 'Drag to change the selected component' }, strip, triL, triR);

  // ---------------------------------------------------------------- swatches
  const newSw = h('div.cp-new', { title: 'New color' });
  const curSw = h('div.cp-cur', { title: 'Current color (click to restore)', style: { background: toCss(orig) } });
  curSw.addEventListener('click', () => set(stateFromRgb(orig, st)));
  const webBtn = h('button.cp-warn', { type: 'button', title: 'Not a web safe color — click to select the closest web safe color' }, icon('cp-websafe', 16), h('span.cp-warn-chip'));
  webBtn.addEventListener('click', () => set(stateFromRgb(webSafe(toRGB(st)), st)));
  const swatches = h('div.cp-swatches', null, h('div.cp-sw-label', null, 'new'), h('div.cp-sw-stack', null, newSw, curSw), h('div.cp-sw-label', null, 'current'));

  // ---------------------------------------------------------------- numeric fields
  const radios = new Map<Axis, HTMLInputElement>();
  const nums = new Map<string, Field<number>>();
  const radioRow = (ax: Axis) => {
    const a = AXES[ax];
    const r = h('input', { type: 'radio', name: 'cp-axis', checked: ax === axis }) as HTMLInputElement;
    r.addEventListener('change', () => { if (r.checked) { axis = ax; savePref({ axis, web }); fieldKey = stripKey = ''; render(); } });
    radios.set(ax, r);
    const f = numberField(Math.round(axisValue(st, ax)), v => set(setAxis(st, ax, v)), { min: a.min, max: a.max, width: 46 });
    nums.set(ax, f);
    return h('label.cp-row', { title: `${a.label} component` }, r, h('span.cp-radio'), h('span.cp-lab', null, a.label + ':'), f, h('span.cp-unit', null, a.unit));
  };
  const cmykRow = (k: 'c' | 'm' | 'y' | 'k', label: string) => {
    const f = numberField(0, v => {
      const cur = rgbToCmyk(toRGB(st));
      (cur as any)[k] = v;
      set(stateFromRgb(cmykToRgb(cur), st));
    }, { min: 0, max: 100, width: 46 });
    nums.set(k, f);
    return h('div.cp-row', null, h('span.cp-radio.none'), h('span.cp-lab', null, label + ':'), f, h('span.cp-unit', null, '%'));
  };
  const hexIn = h('input.field.cp-hex-in', { type: 'text', maxLength: 7, spellcheck: false, title: 'Hexadecimal color value' }) as HTMLInputElement;
  hexIn.addEventListener('change', () => { const c = fromHex(hexIn.value); if (c) set(stateFromRgb(c, st)); else hexIn.value = toHex(toRGB(st)); });
  hexIn.addEventListener('keydown', e => { if (e.key !== 'Enter' && e.key !== 'Escape') e.stopPropagation(); });
  const fieldsGrid = h('div.cp-fields', null,
    h('div.cp-col', null, radioRow('h'), radioRow('s'), radioRow('v'), h('div.cp-gap'), radioRow('r'), radioRow('g'), radioRow('b')),
    h('div.cp-col', null, radioRow('L'), radioRow('A'), radioRow('B'), h('div.cp-gap'), cmykRow('c', 'C'), cmykRow('m', 'M'), cmykRow('y', 'Y'), cmykRow('k', 'K')),
  );
  const hexRow = h('div.cp-hexrow', null, h('span.cp-lab', null, '#'), hexIn);

  const webCb = checkbox('Only Web Colors', web, v => { web = v; savePref({ axis, web }); if (v) set(stateFromRgb(webSafe(toRGB(st)), st)); fieldKey = stripKey = ''; render(); });

  // ---------------------------------------------------------------- color libraries view
  const libBooks: { name: string; colors: () => { name: string; color: RGB }[] }[] = [
    { name: 'Web Named Colors', colors: () => NAMED_COLORS },
    ...[...new Set(resources.swatches.map(s => s.group || 'Custom'))].map(g => ({ name: `Swatches: ${g}`, colors: () => resources.swatches.filter(s => (s.group || 'Custom') === g) })),
    { name: 'Web Safe Colors', colors: () => { const out: { name: string; color: RGB }[] = []; for (let r = 0; r < 6; r++) for (let g = 0; g < 6; g++) for (let b = 0; b < 6; b++) { const c = { r: r * 51, g: g * 51, b: b * 51 }; out.push({ name: '#' + toHex(c).toUpperCase(), color: c }); } return out; } },
  ];
  let book = 0;
  const libList = h('div.cp-lib-list');
  const renderLib = () => {
    libList.replaceChildren(...libBooks[book].colors().map(e => {
      const row = h('div.cp-lib-row', { title: e.name }, h('span.cp-lib-chip', { style: { background: toCss(e.color) } }), h('span', null, e.name));
      row.addEventListener('click', () => { libList.querySelector('.sel')?.classList.remove('sel'); row.classList.add('sel'); set(stateFromRgb(e.color, st)); });
      return row;
    }));
  };
  const bookSel = select(libBooks.map((b, i) => ({ value: i, label: b.name })), 0, v => { book = v; renderLib(); }, { width: 230, title: 'Color book' });
  const libView = h('div.cp-lib', null, h('div.form-row', null, h('span', null, 'Book:'), bookSel), libList);
  libView.style.display = 'none';

  const pickArea = h('div.cp-pick', null, fieldWrap, sliderWrap);
  const body = h('div.cp-body', null,
    h('div.cp-left', null, pickArea, libView, h('div.cp-web', null, webCb)),
    h('div.cp-right', null, h('div.cp-swrow', null, swatches, webBtn), fieldsGrid, hexRow),
  );

  // ---------------------------------------------------------------- rendering
  let fieldKey = '', stripKey = '', raf = 0;
  const render = () => {
    raf = 0;
    const rgb = toRGB(st);
    newSw.style.background = toCss(rgb);
    for (const [ax, r] of radios) r.checked = ax === axis;
    for (const ax of Object.keys(AXES) as Axis[]) nums.get(ax)!.setValue(Math.round(axisValue(st, ax)));
    const cm = rgbToCmyk(rgb);
    nums.get('c')!.setValue(Math.round(cm.c)); nums.get('m')!.setValue(Math.round(cm.m)); nums.get('y')!.setValue(Math.round(cm.y)); nums.get('k')!.setValue(Math.round(cm.k));
    if (document.activeElement !== hexIn) hexIn.value = toHex(rgb);
    const safe = isWebSafe(rgb);
    webBtn.style.visibility = safe ? 'hidden' : 'visible';
    (webBtn.querySelector('.cp-warn-chip') as HTMLElement).style.background = toCss(webSafe(rgb));
    // field depends on the slider axis value only; the strip on the two field axes
    const A = AXES[axis], [ax, ay] = FIELD_AXES[axis];
    const fk = `${axis}:${axisValue(st, axis).toFixed(2)}:${web}`;
    if (fk !== fieldKey) { fieldKey = fk; paintAxisField(field, st, axis, web); }
    const sk = axis === 'h' ? `h:${web}` : `${axis}:${axisValue(st, ax).toFixed(2)}:${axisValue(st, ay).toFixed(2)}:${web}`;
    if (sk !== stripKey) { stripKey = sk; paintAxisSlider(strip, st, axis, web); }
    const X = AXES[ax], Y = AXES[ay];
    ring.style.left = ((axisValue(st, ax) - X.min) / (X.max - X.min)) * 256 + 'px';
    ring.style.top = ((Y.max - axisValue(st, ay)) / (Y.max - Y.min)) * 256 + 'px';
    const lum = 0.299 * rgb.r + 0.587 * rgb.g + 0.114 * rgb.b;
    ring.classList.toggle('dark', lum > 150);
    const ty = ((A.max - axisValue(st, axis)) / (A.max - A.min)) * 256;
    triL.style.top = triR.style.top = ty + 'px';
  };
  const schedule = () => { if (!raf) raf = requestAnimationFrame(render); };
  function set(ns: ColorState) {
    st = web ? stateFromRgb(webSafe(toRGB(ns)), ns) : ns;
    schedule();
  }

  // ---------------------------------------------------------------- pointer input
  const drag = (el: HTMLElement, fn: (e: PointerEvent) => void) => {
    el.addEventListener('pointerdown', e => {
      if (e.button !== 0) return;
      e.preventDefault();
      (document.activeElement as HTMLElement | null)?.blur?.();   // numeric fields refresh only when not focused
      el.setPointerCapture(e.pointerId);
      fn(e);
      const mv = (ev: PointerEvent) => fn(ev);
      const up = () => { el.removeEventListener('pointermove', mv); el.removeEventListener('pointerup', up); el.removeEventListener('pointercancel', up); };
      el.addEventListener('pointermove', mv); el.addEventListener('pointerup', up); el.addEventListener('pointercancel', up);
    });
  };
  drag(fieldWrap, e => {
    const r = field.getBoundingClientRect();
    const u = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)), v = Math.max(0, Math.min(1, (e.clientY - r.top) / r.height));
    const [ax, ay] = FIELD_AXES[axis], X = AXES[ax], Y = AXES[ay], model = AXES[axis].model;
    const vec = [...st[model]] as [number, number, number];
    vec[X.i] = X.min + u * (X.max - X.min);
    vec[Y.i] = Y.max - v * (Y.max - Y.min);
    set(setModel(st, model, vec));
  });
  drag(sliderWrap, e => {
    const r = strip.getBoundingClientRect(), A = AXES[axis];
    const v = Math.max(0, Math.min(1, (e.clientY - r.top) / r.height));
    set(setAxis(st, axis, A.max - v * (A.max - A.min)));
  });

  // ---------------------------------------------------------------- dialog
  const d = openDialog({
    title, body, layout: 'side', className: 'cp-dialog',
    buttons: [
      { label: 'OK', primary: true, value: 'ok' },
      { label: 'Cancel', value: null },
      { label: 'Add to Swatches', onClick: async () => {
        const name = await promptDialog('Color Swatch Name', 'Name:', nextSwatchName());
        if (name !== null) { addSwatch(toRGB(st), name || nextSwatchName()); toast(`Added "${name || 'swatch'}" to Swatches`, 'success'); }
        return false;
      } },
      { label: 'Color Libraries', onClick: () => {
        libMode = !libMode;
        pickArea.style.display = libMode ? 'none' : '';
        libView.style.display = libMode ? '' : 'none';
        libBtn.textContent = libMode ? 'Picker' : 'Color Libraries';
        if (libMode && !libList.childElementCount) renderLib();
        return false;
      } },
    ],
  });
  const libBtn = d.el.querySelectorAll<HTMLButtonElement>('.dialog-buttons .btn')[3];
  libBtn.title = 'Switch between the Color Picker and Color Libraries';

  // Sample colours from the document while the picker is open (pointer over the canvas area).
  const overlay = d.el.parentElement as HTMLElement;
  const docPoint = (e: PointerEvent) => {
    const vp = app.viewport, doc = app.activeDoc;
    if (!vp || !doc || e.target !== overlay) return null;
    const r = vp.overlay.getBoundingClientRect();
    if (e.clientX < r.left || e.clientY < r.top || e.clientX >= r.right || e.clientY >= r.bottom) return null;
    const p = vp.screenToDoc(e.clientX - r.left, e.clientY - r.top);
    const x = Math.floor(p.x), y = Math.floor(p.y);
    return x >= 0 && y >= 0 && x < doc.width && y < doc.height ? { doc, x, y } : null;
  };
  const sample = (e: PointerEvent) => {
    const p = docPoint(e);
    if (!p) return;
    const px = ctx2d(p.doc.getComposite()).getImageData(p.x, p.y, 1, 1).data;
    set(stateFromRgb({ r: px[0], g: px[1], b: px[2] }, st));
  };
  overlay.addEventListener('pointermove', e => {
    overlay.style.cursor = docPoint(e) ? CURSORS.eyedropper : '';
    if (e.buttons & 1) sample(e);
  });
  overlay.addEventListener('pointerdown', e => { if (e.button === 0) sample(e); });

  render();
  return d.result.then(v => (v === 'ok' ? toRGB(st) : null));
}

hooks.openColorPicker = openColorPicker;
