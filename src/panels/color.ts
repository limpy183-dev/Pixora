// Color panel (F6): FG/BG chips + Hue Cube (default), Brightness Cube, Color Wheel, and Grayscale / RGB / HSB /
// CMYK / Lab / Web Color slider views with a colour ramp. Dragging updates the colour live.
import '../features/color/color.css';
import { registerPanel } from '../ui/panels';
import { app } from '../core/app';
import { events } from '../core/events';
import { hooks } from '../core/registry';
import type { RGB } from '../core/types';
import { cmykToRgb, fromHex, rgbToCmyk, toCss, toHex } from '../core/color';
import { h } from '../ui/dom';
import { numberField, slider, textField, type Field } from '../ui/widgets';
import type { MenuEntry } from '../ui/menu';
import { toast } from '../ui/toast';
import { type Axis, type ColorState, AXES, axisTrackCss, axisValue, hsbToRgbFast, paintCanvas, setAxis, setModel, stateFromRgb, toRGB, webSafe, type Vec3 } from '../features/color/model';

type View = 'hue-cube' | 'bright-cube' | 'wheel' | 'gray' | 'rgb' | 'hsb' | 'cmyk' | 'lab' | 'web';
const VIEWS: [View, string][] = [
  ['hue-cube', 'Hue Cube'], ['bright-cube', 'Brightness Cube'], ['wheel', 'Color Wheel'], ['gray', 'Grayscale Slider'], ['rgb', 'RGB Sliders'],
  ['hsb', 'HSB Sliders'], ['cmyk', 'CMYK Sliders'], ['lab', 'Lab Sliders'], ['web', 'Web Color Sliders'],
];
let view: View = (() => { try { const v = localStorage.getItem('pixora.colorPanel.view') as View; return VIEWS.some(x => x[0] === v) ? v : 'hue-cube'; } catch { return 'hue-cube'; } })();
let target: 'fg' | 'bg' = 'fg';
let rebuild: (() => void) | null = null;

const current = (): RGB => (target === 'fg' ? app.fg : app.bg);

registerPanel({
  id: 'color', title: 'Color', icon: 'color', shortcut: 'F6', defaultHeight: 165, minHeight: 110,
  create(el) {
    let st: ColorState = stateFromRgb(current());
    const root = h('div.cpnl');
    el.append(root);

    // ------------------------------------------------------------ FG / BG chips
    const fgChip = h('button.cpnl-chip.fg', { type: 'button', title: 'Foreground color' });
    const bgChip = h('button.cpnl-chip.bg', { type: 'button', title: 'Background color' });
    const chipClick = (which: 'fg' | 'bg') => async () => {
      if (target !== which) { target = which; st = stateFromRgb(current()); syncChips(); refresh(true); return; }
      const c = await hooks.openColorPicker(current(), which === 'fg' ? 'Color Picker (Foreground Color)' : 'Color Picker (Background Color)');
      if (c) commit(c);
    };
    fgChip.addEventListener('click', chipClick('fg'));
    bgChip.addEventListener('click', chipClick('bg'));
    const chips = h('div.cpnl-chips', null, bgChip, fgChip);
    const syncChips = () => {
      fgChip.style.background = toCss(app.fg); bgChip.style.background = toCss(app.bg);
      fgChip.classList.toggle('active', target === 'fg'); bgChip.classList.toggle('active', target === 'bg');
    };

    // ------------------------------------------------------------ colour updates
    /** Live update while dragging (no recent-colour entry), final=true pushes the colour like Photoshop. */
    const apply = (ns: ColorState, final = false) => {
      st = view === 'web' ? stateFromRgb(webSafe(toRGB(ns)), ns) : ns;
      const c = toRGB(st);
      if (target === 'fg') { if (final) app.setForeground(c); else { app.fg = c; events.emit('colors'); } }
      else app.setBackground(c);
    };
    const commit = (c: RGB) => apply(stateFromRgb(c, st), true);
    const dragOn = (elm: HTMLElement, fn: (u: number, v: number) => ColorState) => {
      elm.addEventListener('pointerdown', e => {
        if (e.button !== 0) return;
        e.preventDefault();
        elm.setPointerCapture(e.pointerId);
        const at = (ev: PointerEvent) => {
          const r = elm.getBoundingClientRect();
          return fn(Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width)), Math.max(0, Math.min(1, (ev.clientY - r.top) / r.height)));
        };
        apply(at(e));
        const mv = (ev: PointerEvent) => apply(at(ev));
        const up = (ev: PointerEvent) => { elm.removeEventListener('pointermove', mv); elm.removeEventListener('pointerup', up); elm.removeEventListener('pointercancel', up); apply(at(ev), true); };
        elm.addEventListener('pointermove', mv); elm.addEventListener('pointerup', up); elm.addEventListener('pointercancel', up);
      });
    };

    // ------------------------------------------------------------ views
    const main = h('div.cpnl-main');
    root.append(chips, main);
    let refresh: (force?: boolean) => void = () => {};
    const ro = new ResizeObserver(() => refresh(true));
    const sizeCanvas = (c: HTMLCanvasElement) => {
      const r = c.getBoundingClientRect(), dpr = Math.min(2, window.devicePixelRatio || 1);
      const w = Math.max(1, Math.round(r.width * dpr)), hh = Math.max(1, Math.round(r.height * dpr));
      if (c.width !== w || c.height !== hh) { c.width = w; c.height = hh; return true; }
      return false;
    };

    const buildCube = () => {
      // Hue Cube: field = S (x) × B (y) for the hue; strip = hue. Bright Cube: field = H × S; strip = B. Wheel: disc H/S; strip = B.
      const field = h('canvas.cpnl-field') as HTMLCanvasElement, ring = h('div.cpnl-ring');
      const strip = h('canvas.cpnl-strip') as HTMLCanvasElement, tri = h('div.cpnl-tri');
      const fieldBox = h('div.cpnl-fieldbox' + (view === 'wheel' ? '.wheel' : ''), { title: view === 'wheel' ? 'Color wheel: hue around, saturation outwards' : 'Click or drag to choose a color' }, field, ring);
      const stripBox = h('div.cpnl-stripbox', { title: view === 'hue-cube' ? 'Hue' : 'Brightness' }, strip, tri);
      main.replaceChildren(h('div.cpnl-cube', null, fieldBox, stripBox));
      ro.observe(fieldBox);
      let fk = '', sk = '';
      const tmp: Vec3 = [0, 0, 0];
      refresh = (force = false) => {
        const [H, S, B] = st.hsb;
        if (force) { fk = sk = ''; sizeCanvas(field); sizeCanvas(strip); }
        if (view === 'hue-cube') {
          const k = `${H.toFixed(1)}`;
          if (k !== fk) { fk = k; paintCanvas(field, (u, v, o) => { hsbToRgbFast(H, u * 100, (1 - v) * 100, tmp); o[0] = tmp[0]; o[1] = tmp[1]; o[2] = tmp[2]; }); }
          if (!sk) { sk = 'h'; paintCanvas(strip, (_u, v, o) => { hsbToRgbFast((1 - v) * 360, 100, 100, tmp); o[0] = tmp[0]; o[1] = tmp[1]; o[2] = tmp[2]; }); }
          place(ring, fieldBox, S / 100, 1 - B / 100);
          tri.style.top = (1 - H / 360) * 100 + '%';
        } else if (view === 'bright-cube') {
          const k = `${B.toFixed(1)}`;
          if (k !== fk) { fk = k; paintCanvas(field, (u, v, o) => { hsbToRgbFast(u * 360, (1 - v) * 100, B, tmp); o[0] = tmp[0]; o[1] = tmp[1]; o[2] = tmp[2]; }); }
          const s2 = `${H.toFixed(1)}:${S.toFixed(1)}`;
          if (s2 !== sk) { sk = s2; paintCanvas(strip, (_u, v, o) => { hsbToRgbFast(H, S, (1 - v) * 100, tmp); o[0] = tmp[0]; o[1] = tmp[1]; o[2] = tmp[2]; }); }
          place(ring, fieldBox, H / 360, 1 - S / 100);
          tri.style.top = (1 - B / 100) * 100 + '%';
        } else {
          const k = `${B.toFixed(1)}`;
          if (k !== fk) {
            fk = k;
            const aspect = field.width / field.height;
            paintCanvas(field, (u, v, o) => {
              const dx = (u - 0.5) * 2 * aspect, dy = (v - 0.5) * 2, r = Math.hypot(dx, dy);
              if (r > 1.0) { o[3] = 0; return; }
              hsbToRgbFast((Math.atan2(-dy, dx) * 180 / Math.PI + 360) % 360, r * 100, B, tmp);
              o[0] = tmp[0]; o[1] = tmp[1]; o[2] = tmp[2]; o[3] = r > 0.985 ? Math.round((1 - r) / 0.015 * 255) : 255;
            });
          }
          const s2 = `${H.toFixed(1)}:${S.toFixed(1)}`;
          if (s2 !== sk) { sk = s2; paintCanvas(strip, (_u, v, o) => { hsbToRgbFast(H, S, (1 - v) * 100, tmp); o[0] = tmp[0]; o[1] = tmp[1]; o[2] = tmp[2]; }); }
          const aspect = field.width / field.height || 1, a = H * Math.PI / 180, r = S / 100;
          place(ring, fieldBox, 0.5 + Math.cos(a) * r / (2 * aspect), 0.5 - Math.sin(a) * r / 2);
          tri.style.top = (1 - B / 100) * 100 + '%';
        }
        ring.classList.toggle('dark', 0.299 * st.rgb[0] + 0.587 * st.rgb[1] + 0.114 * st.rgb[2] > 150);
      };
      dragOn(fieldBox, (u, v) => {
        const [H, S, B] = st.hsb;
        if (view === 'hue-cube') return setModel(st, 'hsb', [H, u * 100, (1 - v) * 100]);
        if (view === 'bright-cube') return setModel(st, 'hsb', [u * 360, (1 - v) * 100, B]);
        const aspect = field.width / field.height || 1, dx = (u - 0.5) * 2 * aspect, dy = (v - 0.5) * 2;
        return setModel(st, 'hsb', [(Math.atan2(-dy, dx) * 180 / Math.PI + 360) % 360, Math.min(1, Math.hypot(dx, dy)) * 100, B]);
      });
      dragOn(stripBox, (_u, v) => {
        const [H, S] = st.hsb;
        return view === 'hue-cube' ? setModel(st, 'hsb', [(1 - v) * 360, S, st.hsb[2]]) : setModel(st, 'hsb', [H, S, (1 - v) * 100]);
      });
    };
    const place = (m: HTMLElement, box: HTMLElement, u: number, v: number) => { m.style.left = u * 100 + '%'; m.style.top = v * 100 + '%'; void box; };

    const buildSliders = () => {
      type Row = { upd(): void };
      const rows: Row[] = [];
      const wrap = h('div.cpnl-sliders');
      const axisRow = (ax: Axis, label = AXES[ax].label, unit = AXES[ax].unit) => {
        const A = AXES[ax];
        const num = numberField(Math.round(axisValue(st, ax)), v => apply(setAxis(st, ax, v), true), { min: A.min, max: A.max, width: 42, unit: unit === '°' ? '°' : undefined });
        const sl = slider(axisValue(st, ax), A.min, A.max, v => apply(setAxis(st, ax, v)), { onChange: v => apply(setAxis(st, ax, v), true), track: axisTrackCss(st, ax) });
        wrap.append(h('div.cpnl-srow', null, h('span.cpnl-slab', null, label), sl, num, h('span.cpnl-sunit', null, unit === '°' ? '' : unit)));
        rows.push({ upd() { num.setValue(Math.round(axisValue(st, ax))); sl.setValue(axisValue(st, ax)); (sl.querySelector('.slider-track') as HTMLElement).style.background = axisTrackCss(st, ax); } });
      };
      const customRow = (label: string, min: number, max: number, get: () => number, put: (v: number) => ColorState, track: () => string, unit = '', step = 1, hexField = false) => {
        let fld: Field<number> | Field<string>;
        if (hexField) {
          const t = textField(get().toString(16).padStart(2, '0').toUpperCase(), s => { const v = parseInt(s, 16); if (Number.isFinite(v)) apply(put(Math.max(min, Math.min(max, v))), true); }, { width: 34 });
          fld = t;
        } else fld = numberField(Math.round(get()), v => apply(put(v), true), { min, max, width: 42 });
        const sl = slider(get(), min, max, v => apply(put(v)), { onChange: v => apply(put(v), true), track: track(), step });
        wrap.append(h('div.cpnl-srow', null, h('span.cpnl-slab', null, label), sl, fld, h('span.cpnl-sunit', null, unit)));
        rows.push({ upd() {
          if (hexField) (fld as Field<string>).setValue(Math.round(get()).toString(16).padStart(2, '0').toUpperCase());
          else (fld as Field<number>).setValue(Math.round(get()));
          sl.setValue(get()); (sl.querySelector('.slider-track') as HTMLElement).style.background = track();
        } });
      };
      const cmyk = () => rgbToCmyk(toRGB(st));
      const withCmyk = (k: 'c' | 'm' | 'y' | 'k', v: number) => { const c = cmyk(); c[k] = v; return stateFromRgb(cmykToRgb(c), st); };
      const cmykTrack = (k: 'c' | 'm' | 'y' | 'k') => { const a = cmyk(), b = cmyk(); a[k] = 0; b[k] = 100; return `linear-gradient(90deg, ${toCss(cmykToRgb(a))}, ${toCss(cmykToRgb(b))})`; };
      if (view === 'gray') {
        const k = () => Math.round((1 - (0.299 * st.rgb[0] + 0.587 * st.rgb[1] + 0.114 * st.rgb[2]) / 255) * 100);
        customRow('K', 0, 100, k, v => { const g = Math.round(255 * (1 - v / 100)); return stateFromRgb({ r: g, g, b: g }, st); }, () => 'linear-gradient(90deg, #fff, #000)', '%');
      } else if (view === 'rgb') { axisRow('r'); axisRow('g'); axisRow('b'); }
      else if (view === 'hsb') { axisRow('h', 'H', '°'); axisRow('s'); axisRow('v'); }
      else if (view === 'lab') { axisRow('L'); axisRow('A'); axisRow('B'); }
      else if (view === 'cmyk') {
        for (const [k, l] of [['c', 'C'], ['m', 'M'], ['y', 'Y'], ['k', 'K']] as const) customRow(l, 0, 100, () => cmyk()[k], v => withCmyk(k, v), () => cmykTrack(k), '%');
      } else {
        for (const [i, l] of [[0, 'R'], [1, 'G'], [2, 'B']] as const) {
          const trackFor = () => { const a = [...st.rgb], b = [...st.rgb]; a[i] = 0; b[i] = 255; return `linear-gradient(90deg, rgb(${a.join(',')}), rgb(${b.join(',')}))`; };
          customRow(l, 0, 255, () => st.rgb[i], v => { const vv = [...st.rgb] as Vec3; vv[i] = Math.round(v / 51) * 51; return setModel(st, 'rgb', vv); }, trackFor, '', 51, true);
        }
        const hx = textField(toHex(toRGB(st)).toUpperCase(), s => { const c = fromHex(s); if (c) apply(stateFromRgb(webSafe(c), st), true); }, { width: 64 });
        wrap.append(h('div.cpnl-srow.hex', null, h('span.cpnl-slab', null, '#'), hx));
        rows.push({ upd() { hx.setValue(toHex(toRGB(st)).toUpperCase()); } });
      }
      // colour ramp (spectrum / grayscale)
      const ramp = h('canvas.cpnl-ramp', { title: 'Click or drag to pick a color from the ramp' }) as HTMLCanvasElement;
      wrap.append(ramp);
      main.replaceChildren(wrap);
      ro.observe(ramp);
      const tmp: Vec3 = [0, 0, 0];
      const gray = view === 'gray';
      const rampColor = (u: number, v: number, o: number[]) => {
        if (gray) { const g = 255 * (1 - u); o[0] = o[1] = o[2] = g; return; }
        if (u > 0.94) { const g = v < 0.5 ? 255 : 0; o[0] = o[1] = o[2] = g; return; }   // white / black blocks
        const hue = (u / 0.94) * 360;
        if (v < 0.5) hsbToRgbFast(hue, v * 200, 100, tmp); else hsbToRgbFast(hue, 100, (1 - v) * 200, tmp);
        o[0] = tmp[0]; o[1] = tmp[1]; o[2] = tmp[2];
      };
      let rampDrawn = false;
      refresh = (force = false) => {
        if (force || !rampDrawn) { sizeCanvas(ramp); paintCanvas(ramp, rampColor, view === 'web'); rampDrawn = true; }
        for (const r of rows) r.upd();
      };
      dragOn(ramp, (u, v) => { const o = [0, 0, 0, 255]; rampColor(u, v, o); return stateFromRgb({ r: Math.round(o[0]), g: Math.round(o[1]), b: Math.round(o[2]) }, st); });
    };

    const build = () => {
      ro.disconnect();
      if (view === 'hue-cube' || view === 'bright-cube' || view === 'wheel') buildCube(); else buildSliders();
      root.dataset.view = view;
      requestAnimationFrame(() => refresh(true));
    };
    rebuild = build;
    build();
    syncChips();

    let raf = 0;
    events.on('colors', () => {
      syncChips();
      st = stateFromRgb(current(), st);
      if (!raf) raf = requestAnimationFrame(() => { raf = 0; refresh(); });
    });
    return { onShow: () => requestAnimationFrame(() => refresh(true)), onResize: () => refresh(true) };
  },
  menu(): MenuEntry[] {
    const hex = () => toHex(current());
    const copy = (text: string, what: string) => navigator.clipboard?.writeText(text).then(() => toast(`${what} copied: ${text}`, 'success'), () => toast('Could not access the clipboard.', 'error'));
    return [
      ...VIEWS.map(([v, label]) => ({ label, radio: true, checked: view === v, action: () => { view = v; try { localStorage.setItem('pixora.colorPanel.view', v); } catch { /* ignore */ } rebuild?.(); } }) as MenuEntry),
      '-',
      { label: "Copy Color's Hex Code", action: () => copy('#' + hex(), 'Hex code') },
      { label: 'Copy Color as HTML', action: () => copy(`color="#${hex()}"`, 'HTML color') },
    ];
  },
});
