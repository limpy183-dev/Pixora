// Red Eye Tool (J): click on a red pupil (or drag a box around the eye) to replace the red with a dark neutral.
// Pupil Size grows / shrinks the affected area, Darken Amount sets how dark the corrected pupil becomes.
import { app, type Tool } from '../../core/app';
import type { PixDocument } from '../../core/document';
import type { Rect } from '../../core/types';
import { separator } from '../../ui/widgets';
import { fail, optionsFor, retouchTarget } from './common';
import { dilate } from './heal-algo';
import { commitResult, prepareTarget, readWork, workRect } from './heal-core';
import { floodKeep } from '../paint/common';

const re = { pupil: 50, darken: 50 };

/** Redness 0..1 of a pixel (how much red dominates green/blue). */
const redness = (r: number, g: number, b: number) => {
  const m = Math.max(g, b);
  if (r < 60 || r <= m) return 0;
  // browns / skin have r only moderately above g,b: they score 0
  const dom = ((r - m) / r - 0.38) / 0.32;
  return Math.max(0, Math.min(1, dom)) * Math.min(1, (r - 60) / 60);
};

function fixRedEye(doc: PixDocument, area: Rect, click: { x: number; y: number } | null) {
  const t = retouchTarget(doc, 'red eye tool');
  if (!t) return;
  if (t.isMask) { fail('Could not use the red eye tool because the target is a mask.'); return; }
  prepareTarget(doc, t);
  const w = workRect(doc, t, area, 0);
  if (!w) return;
  const { R } = w, W = R.w, H = R.h, n = W * H;
  const O = readWork(t, w);
  const score = new Float32Array(n);
  const bin = new Uint8Array(n);
  let best = -1, bestV = 0;
  const cx = click ? click.x - R.x : W / 2, cy = click ? click.y - R.y : H / 2;
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    if (O[j + 3] < 16) continue;
    const s = redness(O[j], O[j + 1], O[j + 2]);
    score[i] = s;
    if (s > 0.25) {
      bin[i] = 255;
      // seed: strongest red close to the click / box centre
      const x = i % W, y = (i - x) / W, dist = Math.hypot(x - cx, y - cy);
      const v = s / (1 + dist / Math.max(4, Math.min(W, H) * 0.25));
      if (v > bestV) { bestV = v; best = i; }
    }
  }
  if (best < 0) { fail('Could not use the red eye tool because no red pupil was found in the clicked area.'); return; }
  let region = floodKeep(bin, W, H, best);
  for (let i = 0; i < n; i++) region[i] = region[i] ? 1 : 0;
  // Pupil Size: 50% = the detected area; larger grows it, smaller keeps only the reddest core
  const grow = Math.round((re.pupil - 50) / 12);
  if (grow > 0) region = dilate(region, W, H, grow);
  const core = re.pupil < 50 ? 0.25 + (50 - re.pupil) / 50 * 0.5 : 0;
  const weight = new Float32Array(n);
  const res = new Uint8ClampedArray(O);
  const dk = re.darken / 100;
  let any = false;
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    if (!region[i]) continue;
    const s = score[i];
    if (core && s < core) continue;
    // soft transition at the rim, full strength inside
    const k = grow > 0 && s < 0.25 ? 0.6 : Math.min(1, 0.35 + s * 1.3);
    const g = O[j + 1], b = O[j + 2];
    const v = Math.min(g, b) * 0.55 + Math.max(g, b) * 0.45;
    const dark = v * (1 - dk * 0.85);
    res[j] = dark; res[j + 1] = Math.min(g, dark + (g - v) * 0.3); res[j + 2] = Math.min(b, dark + (b - v) * 0.3);
    weight[i] = k;
    any = true;
  }
  if (!any) { fail('Could not use the red eye tool because no red pupil was found in the clicked area.'); return; }
  commitResult(doc, t, w, O, res, weight, 'Red Eye Tool', 'normal', 'red-eye');
}

let drag: { x0: number; y0: number; x1: number; y1: number } | null = null;
const tool: Tool = {
  id: 'red-eye', name: 'Red Eye Tool', group: 'heal', icon: 'red-eye', shortcut: 'J', order: 4,
  settings: re,
  cursor: 'crosshair',
  options(bar) {
    const o = optionsFor(tool);
    return o.finish(bar,
      o.num('Pupil Size:', 'pupil', { min: 1, max: 100, unit: '%', width: 48, title: 'Set the size of the pupil (the dark center of the eye)' }),
      separator(),
      o.num('Darken Amount:', 'darken', { min: 1, max: 100, unit: '%', width: 48, title: 'Set how dark the pupil becomes' }));
  },
  pointerDown(p) { drag = { x0: p.x, y0: p.y, x1: p.x, y1: p.y }; },
  pointerMove(p, doc) { if (drag) { drag.x1 = p.x; drag.y1 = p.y; doc.redrawOverlay(); } },
  pointerUp(_p, doc) {
    const d = drag; drag = null;
    if (!d) return;
    doc.redrawOverlay();
    const bw = Math.abs(d.x1 - d.x0), bh = Math.abs(d.y1 - d.y0);
    if (bw * (app.viewport?.zoom || 1) > 4 && bh * (app.viewport?.zoom || 1) > 4) {
      fixRedEye(doc, { x: Math.min(d.x0, d.x1), y: Math.min(d.y0, d.y1), w: bw, h: bh }, null);
    } else {
      // search box around the click: a typical eye is a few % of the image
      const r = Math.max(24, Math.round(Math.min(doc.width, doc.height) * 0.06));
      fixRedEye(doc, { x: d.x0 - r, y: d.y0 - r, w: 2 * r, h: 2 * r }, { x: d.x0, y: d.y0 });
    }
  },
  deactivate() { drag = null; },
  drawOverlay(ctx, view) {
    if (!drag) return;
    const a = view.docToScreen(drag.x0, drag.y0), b = view.docToScreen(drag.x1, drag.y1);
    ctx.save();
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 1; ctx.setLineDash([4, 3]);
    ctx.strokeRect(Math.round(Math.min(a.x, b.x)) + 0.5, Math.round(Math.min(a.y, b.y)) + 0.5, Math.abs(b.x - a.x), Math.abs(b.y - a.y));
    ctx.strokeStyle = '#000'; ctx.lineDashOffset = 3;
    ctx.strokeRect(Math.round(Math.min(a.x, b.x)) + 0.5, Math.round(Math.min(a.y, b.y)) + 0.5, Math.abs(b.x - a.x), Math.abs(b.y - a.y));
    ctx.restore();
  },
};
app.registerTool(tool);
