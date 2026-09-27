// Blur Tool, Sharpen Tool and Smudge Tool (the "blur" toolbar slot).
import { app, type Tool } from '../../core/app';
import type { PixDocument } from '../../core/document';
import { separator } from '../../ui/widgets';
import { DirectStroke, type DabCtx } from './strokes';
import { drawCursor, mix, modeOptions, optionsFor, retouchTarget, type MixMode } from './common';

const MODES = modeOptions(['normal', 'darken', 'lighten', 'hue', 'saturation', 'color', 'luminosity']);

/** Premultiplied float RGBA of an area of `src` (region coords), clamped to the region. */
function extract(src: Uint8ClampedArray, rw: number, ax0: number, ay0: number, aw: number, ah: number): Float32Array {
  const out = new Float32Array(aw * ah * 4);
  for (let y = 0; y < ah; y++) {
    let si = ((ay0 + y) * rw + ax0) * 4, o = y * aw * 4;
    for (let x = 0; x < aw; x++, si += 4, o += 4) {
      const a = src[si + 3] / 255;
      out[o] = src[si] * a; out[o + 1] = src[si + 1] * a; out[o + 2] = src[si + 2] * a; out[o + 3] = src[si + 3];
    }
  }
  return out;
}
/** Separable box blur with edge normalisation (in place, via tmp). */
function boxBlur(a: Float32Array, w: number, h: number, r: number) {
  const tmp = new Float32Array(a.length);
  for (let y = 0; y < h; y++) {
    const row = y * w * 4;
    for (let c = 0; c < 4; c++) {
      let sum = 0, n = 0;
      for (let x = 0; x <= Math.min(r, w - 1); x++) { sum += a[row + x * 4 + c]; n++; }
      for (let x = 0; x < w; x++) {
        tmp[row + x * 4 + c] = sum / n;
        const add = x + r + 1, rem = x - r;
        if (add < w) { sum += a[row + add * 4 + c]; n++; }
        if (rem >= 0) { sum -= a[row + rem * 4 + c]; n--; }
      }
    }
  }
  for (let x = 0; x < w; x++) {
    for (let c = 0; c < 4; c++) {
      let sum = 0, n = 0;
      for (let y = 0; y <= Math.min(r, h - 1); y++) { sum += tmp[(y * w + x) * 4 + c]; n++; }
      for (let y = 0; y < h; y++) {
        a[(y * w + x) * 4 + c] = sum / n;
        const add = y + r + 1, rem = y - r;
        if (add < h) { sum += tmp[(add * w + x) * 4 + c]; n++; }
        if (rem >= 0) { sum -= tmp[(rem * w + x) * 4 + c]; n--; }
      }
    }
  }
}

const tmpMix = [0, 0, 0];
/** Blend `nv` (straight RGBA floats) into data[i] by weight k through a retouch mode. */
function put(c: DabCtx, i: number, r: number, g: number, b: number, a: number, k: number, mode: MixMode) {
  const d = c.data;
  if (mode !== 'normal') { mix(mode, d[i], d[i + 1], d[i + 2], r, g, b, tmpMix); r = tmpMix[0]; g = tmpMix[1]; b = tmpMix[2]; a = d[i + 3]; }
  const ao = d[i + 3], an = ao + (a - ao) * k;
  if (an <= 0.01) { d[i + 3] = 0; return; }
  // premultiplied lerp
  const po = ao / 255, pn = a / 255, pa = an / 255;
  d[i] = (d[i] * po * (1 - k) + r * pn * k) / pa;
  d[i + 1] = (d[i + 1] * po * (1 - k) + g * pn * k) / pa;
  d[i + 2] = (d[i + 2] * po * (1 - k) + b * pn * k) / pa;
  d[i + 3] = an;
}

/** Blur (sign −) or sharpen (+) one dab. */
function focusDab(c: DabCtx, sharpen: boolean, mode: MixMode, protect: boolean) {
  const r = sharpen ? 1 : Math.max(1, Math.min(6, Math.round(c.dab.size / 40)));
  const m = r * 2 + 1;
  const ax0 = Math.max(0, c.bx0 - m), ay0 = Math.max(0, c.by0 - m);
  const aw = Math.min(c.rw, c.bx1 + m) - ax0, ah = Math.min(c.rh, c.by1 + m) - ay0;
  const orig = extract(c.src, c.rw, ax0, ay0, aw, ah);
  const bl = orig.slice();
  boxBlur(bl, aw, ah, r);
  if (!sharpen) boxBlur(bl, aw, ah, r);
  const d = c.data;
  for (let y = c.by0; y < c.by1; y++) {
    for (let x = c.bx0; x < c.bx1; x++) {
      const k = c.w[(y - c.y0) * c.tw + (x - c.x0)];
      if (k <= 0) continue;
      const i = (y * c.rw + x) * 4, j = ((y - ay0) * aw + (x - ax0)) * 4;
      if (!sharpen) {
        const a = bl[j + 3];
        if (a <= 0.01) { put(c, i, 0, 0, 0, 0, k, mode); continue; }
        const ia = 255 / a;
        put(c, i, bl[j] * ia, bl[j + 1] * ia, bl[j + 2] * ia, a, k, mode);
      } else {
        const a = orig[j + 3];
        if (a <= 0.01) continue;
        const ia = 255 / a, amt = protect ? 0.7 : 1.6;
        const nv = [0, 0, 0];
        for (let ch = 0; ch < 3; ch++) {
          const v = orig[j + ch] * ia, b = bl[j + ch] * (bl[j + 3] > 0 ? 255 / bl[j + 3] : 0);
          let s = v + (v - b) * amt;
          if (protect) {
            // keep within the local range: no halos / noise blow-up
            let lo = 255, hi = 0;
            for (let yy = -1; yy <= 1; yy++) for (let xx = -1; xx <= 1; xx++) {
              const px = x - ax0 + xx, py = y - ay0 + yy;
              if (px < 0 || py < 0 || px >= aw || py >= ah) continue;
              const q = (py * aw + px) * 4, qa = orig[q + 3];
              if (qa <= 0) continue;
              const qv = (orig[q + ch] * 255) / qa;
              if (qv < lo) lo = qv; if (qv > hi) hi = qv;
            }
            s = Math.max(lo, Math.min(hi, s));
          }
          nv[ch] = s < 0 ? 0 : s > 255 ? 255 : s;
        }
        put(c, i, nv[0], nv[1], nv[2], d[i + 3], k, mode);
      }
    }
  }
}

function brushSettings(extra: Record<string, any>) {
  return { size: 60, hardness: 0, tipId: 'soft-round', roundness: 1, angle: 0, spacing: 25, pressureSize: false, pressureStrength: false, ...extra };
}

function makeTool(def: { id: string; name: string; order: number; history: string; what: string; settings: any; extra: (o: ReturnType<typeof optionsFor>) => (HTMLElement | null)[]; process: (c: DabCtx, s: any) => void; begin?: (s: any) => void; spacing?: number }) {
  let stroke: DirectStroke | null = null;
  const s = def.settings;
  const tool: Tool = {
    id: def.id, name: def.name, group: 'blur', icon: def.id, order: def.order,
    settings: s, paints: true, cursor: 'none',
    options(bar) {
      const o = optionsFor(tool);
      return o.finish(bar, o.brush(), o.brushPanel(), separator(), ...def.extra(o));
    },
    pointerDown(p, doc: PixDocument) {
      const t = retouchTarget(doc, def.what);
      if (!t) return;
      def.begin?.(s);
      stroke = new DirectStroke(doc, t, {
        ...s, spacing: def.spacing ?? s.spacing, historyName: def.history, strength: s.strength / 100, margin: 14,
        sampleAll: !!s.sampleAll, process: c => def.process(c, s),
      }, p);
    },
    pointerMove(p) { stroke?.move(p); },
    pointerUp() { stroke?.end(); stroke = null; },
    deactivate() { stroke?.end(); stroke = null; },
    drawOverlay(ctx, view) { drawCursor(ctx, view, s); },
  };
  app.registerTool(tool);
  return tool;
}

// ------------------------------------------------------------------ Blur
makeTool({
  id: 'blur', name: 'Blur Tool', order: 0, history: 'Blur Tool', what: 'blur tool',
  settings: brushSettings({ mode: 'normal' as MixMode, strength: 50, sampleAll: false }),
  extra: o => [o.select('Mode:', 'mode', MODES, 110), separator(), o.pct('Strength', 'strength', 'Set the strength of the stroke'), separator(),
    o.angle(), separator(), o.check('Sample All Layers', 'sampleAll', 'Use data from all visible layers'), separator(),
    o.toggle('pressure-opacity', 'pressureStrength', 'Always use pressure for strength')],
  process: (c, s) => focusDab(c, false, s.mode, false),
});

// ------------------------------------------------------------------ Sharpen
makeTool({
  id: 'sharpen', name: 'Sharpen Tool', order: 1, history: 'Sharpen Tool', what: 'sharpen tool',
  settings: brushSettings({ mode: 'normal' as MixMode, strength: 50, sampleAll: false, protect: true }),
  extra: o => [o.select('Mode:', 'mode', MODES, 110), separator(), o.pct('Strength', 'strength', 'Set the strength of the stroke'), separator(),
    o.angle(), separator(), o.check('Sample All Layers', 'sampleAll', 'Use data from all visible layers'), separator(),
    o.check('Protect Detail', 'protect', 'Enhance details and minimize pixelated artifacts'), separator(),
    o.toggle('pressure-opacity', 'pressureStrength', 'Always use pressure for strength')],
  process: (c, s) => focusDab(c, true, s.mode, s.protect),
});

// ------------------------------------------------------------------ Smudge
let finger: Float32Array | null = null, fw = 0, fh = 0;
makeTool({
  id: 'smudge', name: 'Smudge Tool', order: 2, history: 'Smudge Tool', what: 'smudge tool', spacing: 10,
  settings: brushSettings({ mode: 'normal' as MixMode, strength: 50, sampleAll: false, finger: false, spacing: 10 }),
  extra: o => [o.select('Mode:', 'mode', MODES, 110), separator(), o.pct('Strength', 'strength', 'Set the strength of the stroke'), separator(),
    o.angle(), separator(), o.check('Sample All Layers', 'sampleAll', 'Use data from all visible layers'), separator(),
    o.check('Finger Painting', 'finger', 'Start each stroke with the foreground colour'), separator(),
    o.toggle('pressure-opacity', 'pressureStrength', 'Always use pressure for strength')],
  begin: () => { finger = null; },
  process: (c, s) => {
    const tw = c.tw, th = c.th, d = c.data, src = c.src;
    // (re)initialise the carried paint: first dab or brush size changed (pressure)
    if (!finger || fw !== tw || fh !== th) {
      const init = !finger;
      finger = new Float32Array(tw * th * 4); fw = tw; fh = th;
      for (let y = 0; y < th; y++) for (let x = 0; x < tw; x++) {
        const o = (y * tw + x) * 4, rx = x + c.x0, ry = y + c.y0;
        if (init && s.finger) { finger[o] = app.fg.r; finger[o + 1] = app.fg.g; finger[o + 2] = app.fg.b; finger[o + 3] = 255; continue; }
        if (rx < 0 || ry < 0 || rx >= c.rw || ry >= c.rh) continue;
        const i = (ry * c.rw + rx) * 4, a = src[i + 3] / 255;
        finger[o] = src[i] * a; finger[o + 1] = src[i + 1] * a; finger[o + 2] = src[i + 2] * a; finger[o + 3] = src[i + 3];
      }
      if (init && !s.finger) return;
    }
    // Smudge strength = how long the finger keeps its paint. Deposit uses the tip coverage only.
    const keep = Math.min(0.98, 0.35 + (s.strength / 100) * 0.63);
    const k0 = s.pressureStrength ? c.dab.pressure : 1;
    for (let y = c.by0; y < c.by1; y++) for (let x = c.bx0; x < c.bx1; x++) {
      const ti = (y - c.y0) * tw + (x - c.x0);
      const k = (c.w[ti] / Math.max(1e-6, c.dab.flow)) * k0;   // strip strength from the weight
      if (k <= 0) continue;
      const i = (y * c.rw + x) * 4, f = ti * 4, fa = finger[f + 3];
      if (fa > 0.5) put(c, i, (finger[f] * 255) / fa, (finger[f + 1] * 255) / fa, (finger[f + 2] * 255) / fa, fa, k, s.mode);
      else put(c, i, 0, 0, 0, 0, k, s.mode);
      // pick up paint from the canvas
      const a = src[i + 3] / 255;
      finger[f] = finger[f] * keep + src[i] * a * (1 - keep);
      finger[f + 1] = finger[f + 1] * keep + src[i + 1] * a * (1 - keep);
      finger[f + 2] = finger[f + 2] * keep + src[i + 2] * a * (1 - keep);
      finger[f + 3] = fa * keep + src[i + 3] * (1 - keep);
    }
  },
});
