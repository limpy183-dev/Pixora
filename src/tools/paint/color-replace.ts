// Color Replacement Tool (B): paints the foreground colour — through the Hue / Saturation / Color / Luminosity
// mode — only onto pixels similar to the sampled colour (Continuous / Once / Background Swatch sampling;
// Discontiguous / Contiguous / Find Edges limits; Tolerance; Anti-alias).
import { app } from '../../core/app';
import { cloneCanvas, ctx2d } from '../../core/canvas';
import type { RGB } from '../../core/types';
import { h } from '../../ui/dom';
import { checkbox, popupSlider, select, separator, toggleGroup } from '../../ui/widgets';
import { toast } from '../../ui/toast';
import { mix, type MixMode } from '../retouch/common';
import {
  createPaintTool, finishOptions, floodKeep, optAngle, optBrush, optCtx, optSmoothing, optToggle, paintDefaults, readRegion, scratchCanvas,
} from './common';

type Sampling = 'continuous' | 'once' | 'background';
type Limits = 'contiguous' | 'discontiguous' | 'edges';
type CRMode = 'hue' | 'saturation' | 'color' | 'luminosity';

const settings = paintDefaults({
  size: 13, hardness: 1, tipId: 'hard-round', smoothing: 0,
  crMode: 'color' as CRMode, sampling: 'continuous' as Sampling, limits: 'contiguous' as Limits, tolerance: 30, antiAlias: true,
});
let scratch: HTMLCanvasElement | null = null;
const out3 = [0, 0, 0];

createPaintTool({
  id: 'color-replace', name: 'Color Replacement Tool', group: 'color-replace', icon: 'color-replace', shortcut: 'B', order: 0,
  settings,
  historyName: 'Color Replacement',
  options(bar, tool) {
    const c = optCtx(tool);
    const mode = select<CRMode>([
      { value: 'hue', label: 'Hue' }, { value: 'saturation', label: 'Saturation' }, { value: 'color', label: 'Color' }, { value: 'luminosity', label: 'Luminosity' },
    ], c.s.crMode, v => { c.s.crMode = v; c.save(); }, { width: 100, title: 'Set the blending mode used to replace the colour' });
    const samp = toggleGroup<Sampling>([
      { value: 'continuous', icon: 'pt-sample-cont', title: 'Sampling: Continuous' },
      { value: 'once', icon: 'pt-sample-once', title: 'Sampling: Once' },
      { value: 'background', icon: 'pt-sample-bg', title: 'Sampling: Background Swatch' },
    ], c.s.sampling, v => { c.s.sampling = v; c.save(); });
    const lim = select<Limits>([{ value: 'discontiguous', label: 'Discontiguous' }, { value: 'contiguous', label: 'Contiguous' }, { value: 'edges', label: 'Find Edges' }],
      c.s.limits, v => { c.s.limits = v; c.save(); }, { width: 110, title: 'Set the replacement limits' });
    const tol = popupSlider('Tolerance', c.s.tolerance, v => { c.s.tolerance = v; c.save(); }, { title: 'Set the tolerance for the colours to replace' });
    const aa = checkbox('Anti-alias', c.s.antiAlias, v => { c.s.antiAlias = v; c.save(); }, { title: 'Smooth the edges of the replaced area' });
    c.syncs.push(() => { mode.setValue(c.s.crMode); samp.setValue(c.s.sampling); lim.setValue(c.s.limits); tol.setValue(c.s.tolerance); aa.setValue(c.s.antiAlias); });
    bar.append(...optBrush(c), separator(), h('span.opt-label', null, 'Mode:'), mode, separator(), samp, separator(),
      h('span.opt-label', null, 'Limits:'), lim, separator(), tol, separator(), aa, separator(), ...optSmoothing(c), separator(), optAngle(c), separator(),
      optToggle(c, 'pressureSize', 'pressure-size', 'Always use Pressure for Size. When off, Brush Settings override pressure.'));
    return finishOptions(c);
  },
  setup(_doc, target, p, s) {
    if (target.isMask) { toast('Could not use the Color Replacement Tool because the target is a mask.', 'error'); return null; }
    const hold = target.holder;
    const orig = cloneCanvas(hold.canvas);             // compare against the pixels as they were before the stroke
    const tol = (s.tolerance / 100) * 255;
    const soft = !s.antiAlias ? 0 : s.limits === 'edges' ? 1 : Math.max(2, tol * 0.3);
    const fg = app.fg;
    const mode = s.crMode as MixMode;
    let sample: RGB | null = s.sampling === 'background' ? app.bg : null;
    if (s.sampling === 'once') {
      const lx = Math.floor(p.x - hold.x), ly = Math.floor(p.y - hold.y);
      if (lx >= 0 && ly >= 0 && lx < orig.width && ly < orig.height) {
        const d = readRegion(orig, lx, ly, 1, 1).data;
        if (d[3]) sample = { r: d[0], g: d[1], b: d[2] };
      }
      if (!sample) return null;
    }
    return {
      mode: 'paint', blendMode: 'normal', color: fg,
      content: (d, box) => {
        const lx = box.x - hold.x, ly = box.y - hold.y;
        const src = readRegion(orig, lx, ly, box.w, box.h), sd = src.data;
        const cx = Math.max(0, Math.min(box.w - 1, Math.floor(d.x - box.x))), cy = Math.max(0, Math.min(box.h - 1, Math.floor(d.y - box.y)));
        let ref = sample;
        if (s.sampling === 'continuous') {
          const i = (cy * box.w + cx) * 4;
          if (sd[i + 3] === 0) return null;
          ref = { r: sd[i], g: sd[i + 1], b: sd[i + 2] };
        }
        if (!ref) return null;
        const n = box.w * box.h, wts = new Uint8Array(n);
        for (let i = 0, k = 0; i < n; i++, k += 4) {
          if (!sd[k + 3]) continue;
          const dist = Math.max(Math.abs(sd[k] - ref.r), Math.abs(sd[k + 1] - ref.g), Math.abs(sd[k + 2] - ref.b));
          wts[i] = dist <= tol ? 255 : soft && dist < tol + soft ? Math.round(255 * (1 - (dist - tol) / soft)) : 0;
        }
        const final = s.limits === 'discontiguous' ? wts : floodKeep(wts, box.w, box.h, cy * box.w + cx);
        const img = new ImageData(box.w, box.h), od = img.data;
        for (let i = 0, k = 0; i < n; i++, k += 4) {
          const w = final[i];
          if (!w) continue;
          mix(mode, sd[k], sd[k + 1], sd[k + 2], fg.r, fg.g, fg.b, out3);
          od[k] = out3[0]; od[k + 1] = out3[1]; od[k + 2] = out3[2];
          od[k + 3] = (w * sd[k + 3]) / 255;
        }
        scratch = scratchCanvas(scratch, box.w, box.h);
        ctx2d(scratch).putImageData(img, 0, 0);
        return scratch;
      },
    };
  },
});
