// Photoshop-style Gradient Editor (replaces hooks.openGradientEditor).
// Presets (folders), Name + New, Gradient Type Solid / Noise, Smoothness, gradient bar with opacity stops (above) and
// colour stops (below): click to add, drag to move, drag off the bar to delete, midpoint diamonds, stop editor
// (Opacity/Color + Location + Delete). Noise: Roughness, Color Model, per-channel ranges, Restrict Colors,
// Add Transparency, Randomize. While open, clicking the image samples a colour into the selected colour stop.
import './color.css';
import { hooks, resources } from '../../core/registry';
import type { Gradient, GradientStop, OpacityStop, RGB } from '../../core/types';
import { app } from '../../core/app';
import { resolveGradient } from '../../core/presets';
import { gradientLUT } from '../../core/gradient';
import { hsvToRgb, labToRgb, rgbToHsv, toCss } from '../../core/color';
import { ctx2d } from '../../core/canvas';
import { h } from '../../ui/dom';
import { openDialog } from '../../ui/dialog';
import { button, checkbox, numberField, popupSlider, select, type Field } from '../../ui/widgets';
import { CURSORS } from '../../ui/cursors';
import { toast } from '../../ui/toast';
import { type GradientEx, type NoiseParams, addGradient, gradientFolders } from './store';
import { downloadJSON, gradientBg, pickJSON, renderFolders } from './preset-ui';

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));
const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);

function mulberry(seed: number) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

export const defaultNoise = (): NoiseParams => ({ roughness: 0.5, model: 'rgb', min: [0, 0, 0], max: [100, 100, 100], restrict: false, transparency: false, seed: (Math.random() * 1e9) | 0 });

/** Build colour/opacity stops for a noise gradient (so every consumer of Gradient renders it via the LUT). */
export function noiseStops(n: NoiseParams): { stops: GradientStop[]; opacityStops: OpacityStop[] } {
  const rnd = mulberry(n.seed);
  const count = Math.round(6 + n.roughness * 90);
  const walk = (lo: number, hi: number, len: number) => {
    const out: number[] = [];
    let v = lo + rnd() * (hi - lo);
    for (let i = 0; i < len; i++) {
      v += (rnd() - 0.5) * 2 * (hi - lo) * (0.15 + n.roughness * 0.85);
      if (v < lo) v = lo + (lo - v); if (v > hi) v = hi - (v - hi);
      v = clamp(v, lo, hi);
      out.push(v);
    }
    return out;
  };
  const ch = [0, 1, 2].map(i => walk(Math.min(n.min[i], n.max[i]) / 100, Math.max(n.min[i], n.max[i]) / 100, count));
  const stops: GradientStop[] = [];
  for (let i = 0; i < count; i++) {
    const [a, b, c] = [ch[0][i], ch[1][i], ch[2][i]];
    let col: RGB;
    if (n.model === 'hsb') col = hsvToRgb({ h: a * 360, s: b * 100, v: c * 100 });
    else if (n.model === 'lab') col = labToRgb({ l: a * 100, a: b * 255 - 128, b: c * 255 - 128 });
    else col = { r: Math.round(a * 255), g: Math.round(b * 255), b: Math.round(c * 255) };
    if (n.restrict) {   // keep colours inside a printable-ish gamut: limit saturation and extreme brightness
      const hsv = rgbToHsv(col);
      col = hsvToRgb({ h: hsv.h, s: Math.min(hsv.s, 82), v: clamp(hsv.v, 8, 94) });
    }
    stops.push({ pos: count > 1 ? i / (count - 1) : 0, color: col });
  }
  let opacityStops: OpacityStop[] = [{ pos: 0, opacity: 1 }, { pos: 1, opacity: 1 }];
  if (n.transparency) {
    const oc = Math.max(3, Math.round(count / 2)), ow = walk(0, 1, oc);
    opacityStops = ow.map((o, i) => ({ pos: i / (oc - 1), opacity: Math.round(o * 100) / 100 }));
  }
  return { stops, opacityStops };
}

type Sel = { kind: 'color' | 'opacity' | 'cmid' | 'omid'; stop: GradientStop | OpacityStop } | null;

export function openGradientEditor(initial: Gradient): Promise<Gradient | null> {
  // working copy with concrete stops (Foreground/Background presets keep their name → stay dynamic until edited)
  let g: GradientEx = { ...clone(resolveGradient(initial)), name: initial.name } as GradientEx;
  const ini = initial as GradientEx;
  if (ini.type === 'noise') { g.type = 'noise'; g.noise = clone(ini.noise!); } else g.type = 'solid';
  let sel: Sel = null;
  const W = 440;

  const modified = () => { if (g.name !== 'Custom') { g.name = 'Custom'; nameIn.value = 'Custom'; renderPresets(); } };

  // ---------------------------------------------------------------- presets
  const collapsed = new Set<string>(gradientFolders().filter(f => f !== ((initial as GradientEx).group || 'Basics')));
  const presets = h('div.ge-presets.pf-list');
  const renderPresets = () => renderFolders<GradientEx>(presets, {
    cls: 'gr', collapsed, filter: () => '', mode: () => 'small',
    groups: () => gradientFolders().map(name => ({ name, items: (resources.gradients as GradientEx[]).filter(x => (x.group || 'Custom') === name) })),
    name: x => x.name, thumb: x => h('div.gr-thumb', { style: { background: gradientBg(x) } }),
    isSelected: x => x.name === g.name,
    onPick: x => load(x),
  });

  // ---------------------------------------------------------------- name / type
  const nameIn = h('input.field', { type: 'text', value: g.name, style: { flex: '1' }, title: 'Gradient name' }) as HTMLInputElement;
  nameIn.addEventListener('keydown', e => { if (e.key !== 'Enter' && e.key !== 'Escape') e.stopPropagation(); });
  nameIn.addEventListener('change', () => { g.name = nameIn.value.trim() || 'Custom'; });
  const newBtn = button('New', () => {
    g.name = nameIn.value.trim() || 'Custom';
    const added = addGradient(clone(g), 'Custom');
    collapsed.delete('Custom');
    renderPresets();
    toast(`Gradient "${added.name}" added to presets`, 'success');
  }, { title: 'Add this gradient to the presets' });
  const typeSel = select([{ value: 'solid', label: 'Solid' }, { value: 'noise', label: 'Noise' }], g.type || 'solid', v => {
    g.type = v as 'solid' | 'noise';
    if (v === 'noise') { g.noise ??= defaultNoise(); applyNoise(); } else { g.smoothness = 1; }
    modified(); sync();
  }, { width: 110, title: 'Gradient Type' });

  // ---------------------------------------------------------------- solid: smoothness + bar
  const smooth = popupSlider('', Math.round((g.smoothness ?? 1) * 100), v => { g.smoothness = v / 100; modified(); drawBar(); }, { title: 'Smoothness' });
  const bar = h('canvas.ge-bar', { width: W, height: 1 }) as HTMLCanvasElement;
  const opTrack = h('div.ge-track.op', { title: 'Click to add an opacity stop' });
  const colTrack = h('div.ge-track.col', { title: 'Click to add a color stop' });
  const barBox = h('div.ge-barbox', { style: { width: W + 'px' } }, opTrack, h('div.ge-barwrap', null, bar), colTrack);

  const opIn = numberField(100, v => { if (sel?.kind === 'opacity') { (sel.stop as OpacityStop).opacity = v / 100; modified(); sync(); } }, { min: 0, max: 100, unit: '%', width: 54 });
  const colSw = h('button.ge-colsw', { type: 'button', title: 'Stop color (click to change)' }) as HTMLButtonElement;
  const locOp = numberField(0, v => setLoc('opacity', v), { min: 0, max: 100, unit: '%', width: 54 });
  const locCol = numberField(0, v => setLoc('color', v), { min: 0, max: 100, unit: '%', width: 54 });
  const delOp = button('Delete', () => delSel('opacity'), { title: 'Delete the selected opacity stop' });
  const delCol = button('Delete', () => delSel('color'), { title: 'Delete the selected color stop' });
  const rowOp = h('div.form-row', null, h('span.ge-lab', null, 'Opacity:'), opIn, h('span.ge-lab2', null, 'Location:'), locOp, delOp);
  const rowCol = h('div.form-row', null, h('span.ge-lab', null, 'Color:'), colSw, h('span.ge-colpad'), h('span.ge-lab2', null, 'Location:'), locCol, delCol);
  const stopsBox = h('fieldset.group.ge-stops', null, h('legend', null, 'Stops'), rowOp, rowCol);
  const smoothRow = h('div.form-row', null, h('span.ge-lab', null, 'Smoothness:'), smooth);
  const roughRow = h('div.form-row');

  colSw.addEventListener('click', async () => {
    if (sel?.kind !== 'color') return;
    const st = sel.stop as GradientStop;
    const c = await hooks.openColorPicker(st.color, 'Color Picker (Stop Color)');
    if (c) { st.color = c; modified(); sync(); }
  });

  function setLoc(kind: 'color' | 'opacity', v: number) {
    if (!sel) return;
    if (sel.kind === kind) sel.stop.pos = v / 100;
    else if ((kind === 'color' && sel.kind === 'cmid') || (kind === 'opacity' && sel.kind === 'omid')) sel.stop.mid = clamp(v / 100, 0.05, 0.95);
    else return;
    modified(); sync();
  }
  function delSel(kind: 'color' | 'opacity') {
    if (!sel || sel.kind !== kind) return;
    const arr: any[] = kind === 'color' ? g.stops : g.opacityStops;
    if (arr.length <= (kind === 'color' ? 2 : 1)) { toast(`A gradient needs at least ${kind === 'color' ? 'two color stops' : 'one opacity stop'}.`, 'info'); return; }
    arr.splice(arr.indexOf(sel.stop), 1);
    sel = null; modified(); sync();
  }

  const sorted = <T extends { pos: number }>(a: T[]) => [...a].sort((x, y) => x.pos - y.pos);
  const colorAt = (t: number): RGB => { const lut = gradientLUT({ ...g, name: 'Custom' }, false, 256), i = Math.round(clamp(t, 0, 1) * 255) * 4; return { r: lut[i], g: lut[i + 1], b: lut[i + 2] }; };
  const opacityAt = (t: number): number => { const lut = gradientLUT({ ...g, name: 'Custom' }, false, 256); return Math.round(lut[Math.round(clamp(t, 0, 1) * 255) * 4 + 3] / 2.55) / 100; };

  function drawBar() {
    const lut = gradientLUT({ ...g, name: g.name === initial.name ? g.name : 'Custom' }, false, W);
    bar.width = W; bar.height = 1;
    ctx2d(bar).putImageData(new ImageData(new Uint8ClampedArray(lut), W, 1), 0, 0);
  }
  function renderStops() {
    const mk = (kind: 'color' | 'opacity', s: GradientStop | OpacityStop) => {
      const el = h(`div.ge-stop.${kind}`, { title: kind === 'color' ? 'Color stop — drag to move, drag off to delete, double-click to edit' : 'Opacity stop — drag to move, drag off to delete' },
        h('span.ge-chip', { style: { background: kind === 'color' ? toCss((s as GradientStop).color) : `rgb(${Array(3).fill(Math.round(255 * (1 - (s as OpacityStop).opacity))).join(',')})` } }));
      el.style.left = s.pos * W + 'px';
      if (sel && sel.stop === s && sel.kind === kind) el.classList.add('sel');
      el.addEventListener('pointerdown', e => { e.stopPropagation(); startDrag(e, kind, s); });
      if (kind === 'color') el.addEventListener('dblclick', () => colSw.click());
      return el;
    };
    const mids = (kind: 'cmid' | 'omid', arr: (GradientStop | OpacityStop)[], base: 'color' | 'opacity') => {
      const out: HTMLElement[] = [];
      if (!sel || (sel.kind !== base && sel.kind !== kind)) return out;
      const s = sorted(arr);
      for (let i = 0; i < s.length - 1; i++) {
        const a = s[i], b = s[i + 1];
        const adjacent = sel.stop === a || sel.stop === b || (sel.kind === kind && sel.stop === a);
        if (!adjacent || b.pos - a.pos < 0.02) continue;
        const d = h('div.ge-mid', { title: 'Midpoint — drag to move' });
        d.style.left = (a.pos + (a.mid ?? 0.5) * (b.pos - a.pos)) * W + 'px';
        if (sel.kind === kind && sel.stop === a) d.classList.add('sel');
        d.addEventListener('pointerdown', e => { e.stopPropagation(); startMid(e, kind, a, b); });
        out.push(d);
      }
      return out;
    };
    colTrack.replaceChildren(...mids('cmid', g.stops, 'color'), ...g.stops.map(s => mk('color', s)));
    opTrack.replaceChildren(...mids('omid', g.opacityStops, 'opacity'), ...g.opacityStops.map(s => mk('opacity', s)));
  }
  function syncFields() {
    const isC = sel?.kind === 'color' || sel?.kind === 'cmid', isO = sel?.kind === 'opacity' || sel?.kind === 'omid';
    const dis = (f: HTMLElement, v: boolean) => { (f as HTMLInputElement).disabled = v; };
    dis(locOp, !isO); dis(locCol, !isC); dis(opIn, sel?.kind !== 'opacity');
    delOp.disabled = sel?.kind !== 'opacity'; delCol.disabled = sel?.kind !== 'color';
    colSw.disabled = sel?.kind !== 'color';
    if (sel?.kind === 'opacity') { opIn.setValue(Math.round((sel.stop as OpacityStop).opacity * 100)); locOp.setValue(Math.round(sel.stop.pos * 100)); }
    else if (sel?.kind === 'omid') locOp.setValue(Math.round((sel.stop.mid ?? 0.5) * 100));
    if (sel?.kind === 'color') { locCol.setValue(Math.round(sel.stop.pos * 100)); colSw.style.background = toCss((sel.stop as GradientStop).color); }
    else if (sel?.kind === 'cmid') locCol.setValue(Math.round((sel.stop.mid ?? 0.5) * 100));
    if (sel?.kind !== 'color') colSw.style.background = '';
  }

  const trackPos = (track: HTMLElement, clientX: number) => clamp((clientX - track.getBoundingClientRect().left) / W, 0, 1);
  function startDrag(e: PointerEvent, kind: 'color' | 'opacity', s: GradientStop | OpacityStop) {
    if (e.button !== 0) return;
    e.preventDefault();
    sel = { kind, stop: s };
    const track = kind === 'color' ? colTrack : opTrack;
    const arr: any[] = kind === 'color' ? g.stops : g.opacityStops;
    const minCount = kind === 'color' ? 2 : 1;
    const x0 = e.clientX, y0 = e.clientY;
    let removed = false, moved = false;
    const idx = () => arr.indexOf(s);
    sync();
    const mv = (ev: PointerEvent) => {
      if (!moved && Math.abs(ev.clientX - x0) < 2 && Math.abs(ev.clientY - y0) < 2) return;
      moved = true;
      const tr = track.getBoundingClientRect();
      const off = ev.clientY < tr.top - 22 || ev.clientY > tr.bottom + 22;
      if (off && !removed && arr.length > minCount) { arr.splice(idx(), 1); removed = true; }
      else if (!off && removed) { arr.push(s); removed = false; }
      s.pos = trackPos(track, ev.clientX);
      modified(); sync();
      if (removed) track.classList.add('deleting'); else track.classList.remove('deleting');
    };
    const up = () => {
      window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up);
      track.classList.remove('deleting');
      if (removed) { sel = null; sync(); }
    };
    window.addEventListener('pointermove', mv); window.addEventListener('pointerup', up);
  }
  function startMid(e: PointerEvent, kind: 'cmid' | 'omid', a: GradientStop | OpacityStop, b: GradientStop | OpacityStop) {
    if (e.button !== 0) return;
    e.preventDefault();
    sel = { kind, stop: a };
    sync();
    const track = kind === 'cmid' ? colTrack : opTrack;
    const mv = (ev: PointerEvent) => { a.mid = clamp((trackPos(track, ev.clientX) - a.pos) / (b.pos - a.pos || 1), 0.05, 0.95); modified(); sync(); };
    const up = () => { window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', mv); window.addEventListener('pointerup', up);
  }
  for (const [track, kind] of [[colTrack, 'color'], [opTrack, 'opacity']] as const) {
    track.addEventListener('pointerdown', e => {
      if (e.button !== 0 || e.target !== track) return;
      const pos = trackPos(track, e.clientX);
      const s: any = kind === 'color' ? { pos, color: colorAt(pos) } : { pos, opacity: opacityAt(pos) };
      (kind === 'color' ? g.stops : g.opacityStops as any[]).push(s);
      modified();
      startDrag(e, kind, s);
    });
  }

  // ---------------------------------------------------------------- noise
  const noiseBox = h('div.ge-noise');
  let noiseUI: { roughness: Field<number>; model: Field<string>; ranges: HTMLElement; restrict: Field<boolean>; transp: Field<boolean> } | null = null;
  function applyNoise() {
    const r = noiseStops(g.noise!);
    g.stops = r.stops; g.opacityStops = r.opacityStops; g.smoothness = 0;
  }
  const CH: Record<string, [string, string, string]> = { rgb: ['R', 'G', 'B'], hsb: ['H', 'S', 'B'], lab: ['L', 'a', 'b'] };
  function rampCss(model: string, i: number) {
    const stops: string[] = [];
    for (let k = 0; k <= 12; k++) {
      const t = k / 12;
      let c: RGB;
      if (model === 'rgb') c = { r: i === 0 ? t * 255 : 0, g: i === 1 ? t * 255 : 0, b: i === 2 ? t * 255 : 0 };
      else if (model === 'hsb') c = hsvToRgb(i === 0 ? { h: t * 360, s: 100, v: 100 } : i === 1 ? { h: 0, s: t * 100, v: 100 } : { h: 0, s: 0, v: t * 100 });
      else c = labToRgb(i === 0 ? { l: t * 100, a: 0, b: 0 } : i === 1 ? { l: 60, a: t * 255 - 128, b: 0 } : { l: 70, a: 0, b: t * 255 - 128 });
      stops.push(toCss(c));
    }
    return `linear-gradient(90deg, ${stops.join(',')})`;
  }
  function buildRanges() {
    const n = g.noise!, box = noiseUI!.ranges;
    box.replaceChildren(...[0, 1, 2].map(i => {
      const track = h('div.ge-rtrack', { style: { background: rampCss(n.model, i) } });
      const lo = h('div.ge-rthumb.lo', { title: 'Minimum' }), hi = h('div.ge-rthumb.hi', { title: 'Maximum' });
      const place = () => { lo.style.left = n.min[i] + '%'; hi.style.left = n.max[i] + '%'; };
      place();
      for (const [th, key] of [[lo, 'min'], [hi, 'max']] as const) th.addEventListener('pointerdown', e => {
        e.preventDefault();
        const mv = (ev: PointerEvent) => {
          const r = track.getBoundingClientRect();
          let v = Math.round(clamp((ev.clientX - r.left) / r.width, 0, 1) * 100);
          if (key === 'min') v = Math.min(v, n.max[i]); else v = Math.max(v, n.min[i]);
          n[key][i] = v; place(); applyNoise(); modified(); drawBar(); renderPresets();
        };
        const up = () => { window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up); };
        window.addEventListener('pointermove', mv); window.addEventListener('pointerup', up);
      });
      return h('div.ge-rrow', null, h('span.ge-rlab', null, CH[n.model][i]), h('div.ge-rbox', null, track, lo, hi));
    }));
  }
  function buildNoise() {
    g.noise ??= defaultNoise();
    const n = g.noise;
    const regen = () => { applyNoise(); modified(); drawBar(); };
    const roughness = popupSlider('', Math.round(n.roughness * 100), v => { n.roughness = v / 100; regen(); }, { title: 'Roughness' });
    const model = select([{ value: 'rgb', label: 'RGB' }, { value: 'hsb', label: 'HSB' }, { value: 'lab', label: 'LAB' }], n.model, v => {
      n.model = v as NoiseParams['model']; n.min = [0, 0, 0]; n.max = [100, 100, 100]; buildRanges(); regen();
    }, { width: 90, title: 'Color Model' });
    const restrict = checkbox('Restrict Colors', n.restrict, v => { n.restrict = v; regen(); }, { title: 'Prevent oversaturated colors' });
    const transp = checkbox('Add Transparency', n.transparency, v => { n.transparency = v; regen(); }, { title: 'Add random transparency' });
    const rand = button('Randomize', () => { n.seed = (Math.random() * 1e9) | 0; regen(); }, { title: 'Generate a new random gradient with the current settings' });
    const ranges = h('div.ge-ranges');
    noiseUI = { roughness, model, ranges, restrict, transp };
    roughRow.replaceChildren(h('span.ge-lab', null, 'Roughness:'), roughness);
    noiseBox.replaceChildren(
      h('div.form-row', null, h('span.ge-lab', null, 'Color Model:'), model),
      ranges,
      h('div.ge-noise-opts', null, h('div.ge-opts-col', null, h('div.ge-optlab', null, 'Options'), restrict, transp), rand),
    );
    buildRanges();
  }

  // ---------------------------------------------------------------- layout
  const body = h('div.ge-body', null,
    h('div.ge-sec', null, 'Presets'), presets,
    h('div.form-row.ge-name', null, h('span.ge-lab', null, 'Name:'), nameIn, newBtn),
    h('div.form-row', null, h('span.ge-lab', null, 'Gradient Type:'), typeSel),
    smoothRow, roughRow, barBox, stopsBox, noiseBox);

  function sync() {
    const noise = g.type === 'noise';
    for (const e of [smoothRow, stopsBox]) e.style.display = noise ? 'none' : '';
    for (const e of [roughRow, noiseBox]) e.style.display = noise ? '' : 'none';
    barBox.classList.toggle('noise', noise);
    if (noise && !noiseUI) buildNoise();
    typeSel.setValue(g.type || 'solid');
    smooth.setValue(Math.round((g.smoothness ?? 1) * 100));
    drawBar(); renderStops(); syncFields();
  }
  function load(x: GradientEx) {
    g = { ...clone(resolveGradient(x)), name: x.name } as GradientEx;
    g.type = x.type === 'noise' ? 'noise' : 'solid';
    if (g.type === 'noise') g.noise = clone(x.noise ?? defaultNoise()); else delete g.noise;
    nameIn.value = g.name;
    sel = null; noiseUI = null;
    sync(); renderPresets();
  }

  const d = openDialog({
    title: 'Gradient Editor', body, layout: 'side', className: 'ge-dialog',
    buttons: [
      { label: 'OK', primary: true, value: 'ok' },
      { label: 'Cancel', value: null },
      { label: 'Import...', onClick: async () => {
        const data = await pickJSON();
        if (data === null) return false;
        const list: any[] = Array.isArray(data) ? data : Array.isArray(data?.gradients) ? data.gradients : data?.stops ? [data] : [];
        const ok = list.filter(x => x && Array.isArray(x.stops) && x.stops.length);
        if (!ok.length) { toast('The file does not contain any gradients.', 'error'); return false; }
        for (const x of ok) addGradient({ opacityStops: [{ pos: 0, opacity: 1 }, { pos: 1, opacity: 1 }], smoothness: 1, ...x, name: String(x.name || 'Gradient') }, x.group || 'Imported');
        collapsed.delete('Imported'); renderPresets();
        toast(`Imported ${ok.length} gradient${ok.length === 1 ? '' : 's'}.`, 'success');
        return false;
      } },
      { label: 'Export...', onClick: () => { downloadJSON(`${(nameIn.value || 'Gradient').replace(/[\\/:*?"<>|]/g, '_')}.json`, { gradients: [{ ...clone(g), name: nameIn.value || g.name }] }); return false; } },
    ],
  });
  d.el.querySelectorAll<HTMLButtonElement>('.dialog-buttons .btn').forEach((b, i) => { b.title = ['Apply the gradient', 'Discard changes', 'Import gradients from a .json file into the presets', 'Save this gradient as a .json file'][i] || ''; });

  // sample colours from the image into the selected colour stop (Photoshop behaviour)
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
    if (!p || sel?.kind !== 'color') return;
    const px = ctx2d(p.doc.getComposite()).getImageData(p.x, p.y, 1, 1).data;
    (sel.stop as GradientStop).color = { r: px[0], g: px[1], b: px[2] };
    modified(); sync();
  };
  overlay.addEventListener('pointermove', e => { overlay.style.cursor = sel?.kind === 'color' && docPoint(e) ? CURSORS.eyedropper : ''; if (e.buttons & 1) sample(e); });
  overlay.addEventListener('pointerdown', e => { if (e.button === 0) sample(e); });

  // select the first colour stop like Photoshop
  sel = g.type === 'noise' ? null : { kind: 'color', stop: sorted(g.stops)[0] };
  renderPresets();
  sync();
  return d.result.then(v => {
    if (v !== 'ok') return null;
    g.name = nameIn.value.trim() || g.name;
    const out: GradientEx = clone(g);
    delete (out as any).group;
    if (out.type !== 'noise') { delete out.noise; delete out.type; }
    return out;
  });
}

hooks.openGradientEditor = openGradientEditor;
