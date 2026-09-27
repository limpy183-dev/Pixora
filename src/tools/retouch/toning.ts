// Dodge Tool, Burn Tool and Sponge Tool (O).
import { app, type Tool } from '../../core/app';
import { separator } from '../../ui/widgets';
import { DirectStroke, type DabCtx } from './strokes';
import { drawCursor, optionsFor, retouchTarget } from './common';

type Range = 'shadows' | 'midtones' | 'highlights';

/** How strongly a tone (0..1) is affected by a range. */
const rangeWeight = (r: Range, v: number) => r === 'shadows' ? (1 - v) * (1 - v) : r === 'highlights' ? v * v : 4 * v * (1 - v);

/** LUT: per-dab tone curve at full weight (dodge lifts toward white, burn pushes toward black). */
const lutCache = new Map<string, Float32Array>();
function toneLut(burn: boolean, range: Range, k: number): Float32Array {
  const key = `${burn}:${range}:${k.toFixed(4)}`;
  let lut = lutCache.get(key);
  if (lut) return lut;
  lut = new Float32Array(256);
  for (let i = 0; i < 256; i++) {
    const v = i / 255, w = rangeWeight(range, v) * k;
    const out = burn ? v - w * (range === 'shadows' ? v * 1.6 : v) : v + w * (range === 'highlights' ? (1 - v) * 1.6 : 1 - v);
    lut[i] = Math.max(0, Math.min(255, out * 255));
  }
  if (lutCache.size > 64) lutCache.clear();
  lutCache.set(key, lut);
  return lut;
}

function toneDab(c: DabCtx, burn: boolean, s: any) {
  const lut = toneLut(burn, s.range, 0.35);
  const d = c.data;
  for (let y = c.by0; y < c.by1; y++) for (let x = c.bx0; x < c.bx1; x++) {
    const k = c.w[(y - c.y0) * c.tw + (x - c.x0)];
    if (k <= 0) continue;
    const i = (y * c.rw + x) * 4;
    const r = d[i], g = d[i + 1], b = d[i + 2];
    if (s.protect && !c.isMask) {
      // tone the luminance and keep hue/saturation; compress instead of clipping
      const L = 0.299 * r + 0.587 * g + 0.114 * b;
      const Ln = L + (lut[Math.round(L)] - L) * k;
      let nr = r + (Ln - L), ng = g + (Ln - L), nb = b + (Ln - L);
      const mx = Math.max(nr, ng, nb), mn = Math.min(nr, ng, nb);
      if (mx > 255) { const f = (255 - Ln) / (mx - Ln || 1); nr = Ln + (nr - Ln) * f; ng = Ln + (ng - Ln) * f; nb = Ln + (nb - Ln) * f; }
      if (mn < 0) { const f = Ln / (Ln - mn || 1); nr = Ln + (nr - Ln) * f; ng = Ln + (ng - Ln) * f; nb = Ln + (nb - Ln) * f; }
      d[i] = nr; d[i + 1] = ng; d[i + 2] = nb;
    } else {
      d[i] = r + (lut[r] - r) * k; d[i + 1] = g + (lut[g] - g) * k; d[i + 2] = b + (lut[b] - b) * k;
    }
  }
}

function spongeDab(c: DabCtx, s: any) {
  const d = c.data, saturate = s.mode === 'saturate';
  for (let y = c.by0; y < c.by1; y++) for (let x = c.bx0; x < c.bx1; x++) {
    let k = c.w[(y - c.y0) * c.tw + (x - c.x0)] * 0.3;
    if (k <= 0) continue;
    const i = (y * c.rw + x) * 4, r = d[i], g = d[i + 1], b = d[i + 2];
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), sat = mx ? (mx - mn) / mx : 0;
    if (s.vibrance) k *= saturate ? (1 - sat) * (1 - sat) + 0.05 : 0.3 + sat * 0.7;
    const L = 0.299 * r + 0.587 * g + 0.114 * b;
    let f = saturate ? 1 + k : 1 - k;
    if (saturate) {
      // limit the gain so no channel clips (Vibrance / clean saturation)
      const up = mx > L ? (255 - L) / (mx - L) : Infinity, dn = mn < L ? L / (L - mn) : Infinity;
      f = Math.min(f, up, dn);
    }
    d[i] = L + (r - L) * f; d[i + 1] = L + (g - L) * f; d[i + 2] = L + (b - L) * f;
  }
}

const base = () => ({ size: 65, hardness: 0, tipId: 'soft-round', roundness: 1, angle: 0, spacing: 25, pressureSize: false, airbrush: false });

function makeTool(id: 'dodge' | 'burn' | 'sponge', name: string, order: number) {
  const s: any = id === 'sponge'
    ? { ...base(), mode: 'desaturate', flow: 50, vibrance: true }
    : { ...base(), range: 'midtones' as Range, exposure: 50, protect: true };
  let stroke: DirectStroke | null = null;
  const tool: Tool = {
    id, name, group: 'dodge', icon: id, shortcut: 'O', order,
    settings: s, paints: true, cursor: 'none',
    options(bar) {
      const o = optionsFor(tool);
      if (id === 'sponge') {
        return o.finish(bar, o.brush(), o.brushPanel(), separator(),
          o.select('Mode:', 'mode', [{ value: 'desaturate', label: 'Desaturate' }, { value: 'saturate', label: 'Saturate' }], 110), separator(),
          o.pct('Flow', 'flow', 'Set the flow rate'), o.toggle('airbrush', 'airbrush', 'Enable airbrush-style build-up effects'), separator(),
          o.angle(), separator(),
          o.check('Vibrance', 'vibrance', 'Minimize clipping for fully saturated or desaturated colors'), separator(),
          o.toggle('pressure-size', 'pressureSize', 'Always use pressure for size'));
      }
      return o.finish(bar, o.brush(), o.brushPanel(), separator(),
        o.select('Range:', 'range', [{ value: 'shadows', label: 'Shadows' }, { value: 'midtones', label: 'Midtones' }, { value: 'highlights', label: 'Highlights' }], 110), separator(),
        o.pct('Exposure', 'exposure', 'Set the exposure for the stroke'), o.toggle('airbrush', 'airbrush', 'Enable airbrush-style build-up effects'), separator(),
        o.angle(), separator(),
        o.check('Protect Tones', 'protect', 'Protect tones: minimize clipping in shadows and highlights and prevent colour shifts'), separator(),
        o.toggle('pressure-size', 'pressureSize', 'Always use pressure for size'));
    },
    pointerDown(p, doc) {
      const t = retouchTarget(doc, `${id} tool`);
      if (!t) return;
      stroke = new DirectStroke(doc, t, {
        ...s, historyName: name, strength: (id === 'sponge' ? s.flow : s.exposure) / 100,
        process: c => (id === 'sponge' ? spongeDab(c, s) : toneDab(c, id === 'burn', s)),
      }, p);
    },
    pointerMove(p) { stroke?.move(p); },
    pointerUp() { stroke?.end(); stroke = null; },
    deactivate() { stroke?.end(); stroke = null; },
    drawOverlay(ctx, view) { drawCursor(ctx, view, s); },
  };
  app.registerTool(tool);
}

makeTool('dodge', 'Dodge Tool', 0);
makeTool('burn', 'Burn Tool', 1);
makeTool('sponge', 'Sponge Tool', 2);
