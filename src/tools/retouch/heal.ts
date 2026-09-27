// Spot Healing Brush Tool (J) and Healing Brush Tool (J).
//  * Spot Healing: paint over a blemish; on release the painted area is rebuilt from its surroundings
//    (Content-Aware = PatchMatch inpainting in a worker, Create Texture = quilted texture, Proximity Match = best
//    nearby patch), healed into the lighting of the destination.
//  * Healing Brush: like the Clone Stamp (Alt-click a source, or a pattern) but on release the cloned texture is
//    blended seamlessly (membrane interpolation) into the colour/lighting around the stroke.
import { app, type Tool, type ToolPointer } from '../../core/app';
import type { PixDocument, PaintTarget } from '../../core/document';
import { DabSpacer, type InputPoint } from '../../core/brush';
import { createCanvas, ctx2d } from '../../core/canvas';
import { unionRect } from '../../core/geom';
import type { Point, Rect } from '../../core/types';
import { separator } from '../../ui/widgets';
import { BufferStroke } from './strokes';
import {
  CURSOR_TARGET, drawCursor, fail, modeOptions, mods, optionsFor, patternById, readImg, retouchTarget, sampleImage, tipCanvas,
  type Img, type MixMode, type SampleMode,
} from './common';
import { dilate, proximityOffset, shifted, synthTexture } from './heal-algo';
import { commitResult, cpuCanvas, healBlend, isBusy, prepareTarget, readWork, regionFromCanvas, runInpaint, withBusy, workRect } from './heal-core';
import { drawCloneOverlay, renderSourceDab } from './clone';
import { activeSource, clone, defineSource, sourceDoc, sourceToDest, strokeAnchor } from './source';

const HEAL_MODES = modeOptions(['normal', 'replace', 'multiply', 'screen', 'darken', 'lighten', 'color', 'luminosity']);

// ================================================================== Spot Healing Brush
type SpotType = 'content-aware' | 'texture' | 'proximity';
const sp = {
  size: 19, hardness: 1, tipId: 'hard-round', roundness: 1, angle: 0, spacing: 25, pressureSize: false,
  mode: 'normal' as MixMode, type: 'content-aware' as SpotType, sampleAll: false,
};

interface SpotStroke { doc: PixDocument; t: PaintTarget; mask: HTMLCanvasElement; rect: Rect | null; spacer: DabSpacer; last: InputPoint }
let spot: SpotStroke | null = null;

function spotDab(q: InputPoint) {
  const st = spot;
  if (!st) return;
  const size = sp.pressureSize ? Math.max(1, sp.size * q.pressure) : sp.size;
  const tip = tipCanvas(sp, size);
  const x = Math.round(q.x - tip.width / 2), y = Math.round(q.y - tip.height / 2);
  ctx2d(st.mask).drawImage(tip, x, y);
  st.rect = unionRect(st.rect, { x, y, w: tip.width, h: tip.height });
  st.doc.redrawOverlay();
}

/** Rebuild the painted area. */
async function spotHeal(st: SpotStroke) {
  const { doc, t } = st;
  if (!st.rect) return;
  prepareTarget(doc, t);
  const size = Math.max(st.rect.w, st.rect.h);
  const margin = sp.type === 'content-aware' ? Math.min(420, Math.max(40, size * 1.4 + 24)) : Math.min(600, Math.max(32, size * 2.8 + 16));
  const w = workRect(doc, t, st.rect, margin);
  if (!w) return;
  const { R } = w;
  const { region, weight, count } = regionFromCanvas(st.mask, R);
  if (!count) return;
  const holderCanvas = t.holder.canvas;
  const img = sampleImage(doc, sp.sampleAll ? 'all' : 'current', t);
  const I = readImg(img, R).data;
  let res: Uint8ClampedArray;
  if (sp.type === 'content-aware') {
    const hole = dilate(region, R.w, R.h, 2);
    res = await withBusy(() => runInpaint(I, R.w, R.h, hole));
    if (t.holder.canvas !== holderCanvas) return;       // target replaced meanwhile (undo, rasterize…)
  } else {
    let S: Uint8ClampedArray | null = null;
    if (sp.type === 'proximity') {
      const off = proximityOffset(I, region, R.w, R.h);
      if (off) S = shifted(I, R.w, R.h, off.dx, off.dy);
    }
    if (!S) S = synthTexture(I, region, R.w, R.h, (Math.random() * 1e9) | 0);
    res = sp.mode === 'replace' ? S : healBlend(I, S, region, R.w, R.h, 4);
  }
  const orig = readWork(t, w);
  if (sp.sampleAll && !t.isMask) {
    // colours come from the composite; keep them only inside the healed area
    for (let i = 0; i < region.length; i++) if (!region[i]) { const j = i * 4; res[j] = orig[j]; res[j + 1] = orig[j + 1]; res[j + 2] = orig[j + 2]; res[j + 3] = orig[j + 3]; }
  }
  commitResult(doc, t, w, orig, res, weight, 'Spot Healing Brush', sp.mode, 'spot-heal');
}

const spotTool: Tool = {
  id: 'spot-heal', name: 'Spot Healing Brush Tool', group: 'heal', icon: 'spot-heal', shortcut: 'J', order: 0,
  settings: sp, paints: true,
  cursor: 'none',
  options(bar) {
    const o = optionsFor(spotTool);
    return o.finish(bar, o.brush(), separator(),
      o.select('Mode:', 'mode', HEAL_MODES, 110), separator(),
      o.radio('Type:', 'type', [
        { value: 'content-aware', label: 'Content-Aware', title: 'Fill the area with detail synthesized from the surrounding content' },
        { value: 'texture', label: 'Create Texture', title: 'Create a texture from the pixels in the selection' },
        { value: 'proximity', label: 'Proximity Match', title: 'Use the pixels around the edge of the selection' },
      ]), separator(),
      o.check('Sample All Layers', 'sampleAll', 'Use data from all visible layers'), separator(),
      o.angle(), separator(),
      o.toggle('pressure-size', 'pressureSize', 'Always use pressure for size. When off, Brush Settings presets control pressure.'));
  },
  pointerDown(p: ToolPointer, doc: PixDocument) {
    if (isBusy() || spot) return;
    const t = retouchTarget(doc, 'spot healing brush');
    if (!t) return;
    const first: InputPoint = { x: p.x, y: p.y, pressure: p.pointerType === 'pen' ? Math.max(0.01, p.pressure) : 1 };
    spot = {
      doc, t, mask: cpuCanvas(doc.width, doc.height), rect: null, last: first,
      spacer: new DabSpacer(q => Math.max(0.5, (sp.spacing / 100) * (sp.pressureSize ? Math.max(1, sp.size * q.pressure) : sp.size)), q => spotDab(q), 0),
    };
    spot.spacer.add(first);
  },
  pointerMove(p) {
    if (!spot) return;
    spot.last = { x: p.x, y: p.y, pressure: p.pointerType === 'pen' ? Math.max(0.01, p.pressure) : 1 };
    spot.spacer.add(spot.last);
  },
  async pointerUp() {
    const st = spot;
    if (!st) return;
    st.spacer.finish(st.last);
    try { await spotHeal(st); } catch (err) { console.error(err); fail('Could not complete the Spot Healing Brush because of a program error.'); }
    finally { spot = null; st.doc.redrawOverlay(); }
  },
  deactivate() { spot = null; },
  drawOverlay(ctx, view) {
    if (spot?.rect) {
      ctx.save();
      view.applyDocTransform(ctx);
      ctx.globalAlpha = isBusy() ? 0.35 : 0.5;
      const r = spot.rect;
      ctx.drawImage(spot.mask, r.x, r.y, r.w, r.h, r.x, r.y, r.w, r.h);
      ctx.restore();
    }
    drawCursor(ctx, view, sp);
  },
};
app.registerTool(spotTool);

// ================================================================== Healing Brush
type HealSource = 'sampled' | 'pattern';
const hb = {
  size: 19, hardness: 1, tipId: 'hard-round', roundness: 1, angle: 0, spacing: 25, pressureSize: false,
  mode: 'normal' as MixMode, source: 'sampled' as HealSource, patternId: 'checker', aligned: true,
  sample: 'current' as SampleMode, diffusion: 5,
};

interface HealStroke { doc: PixDocument; t: PaintTarget; stroke: BufferStroke; S: (R: Rect) => Uint8ClampedArray }
let heal: HealStroke | null = null;
let healAnchor: Point | null = null;

/** Render the whole (unmasked) clone source through M over a doc rect. */
function sourceOver(img: Img, M: DOMMatrix, R: Rect): Uint8ClampedArray {
  const c = createCanvas(R.w, R.h), x = ctx2d(c);
  x.setTransform(1, 0, 0, 1, -R.x, -R.y);
  x.transform(M.a, M.b, M.c, M.d, M.e, M.f);
  x.imageSmoothingEnabled = !(M.a === 1 && M.d === 1 && M.b === 0 && M.c === 0);
  x.imageSmoothingQuality = 'high';
  x.drawImage(img.canvas, img.x, img.y);
  return x.getImageData(0, 0, R.w, R.h).data;
}
function patternOver(pat: HTMLCanvasElement, origin: Point, R: Rect): Uint8ClampedArray {
  const c = createCanvas(R.w, R.h), x = ctx2d(c);
  const cp = x.createPattern(pat, 'repeat')!;
  cp.setTransform(new DOMMatrix().translate(origin.x - R.x, origin.y - R.y));
  x.fillStyle = cp; x.fillRect(0, 0, R.w, R.h);
  return x.getImageData(0, 0, R.w, R.h).data;
}

function finishHeal(st: HealStroke) {
  const { doc, t, stroke } = st;
  const total = stroke.end(false);
  if (!total) { stroke.cancel(); return; }
  const h = t.holder;
  const docRect = { x: total.x + h.x, y: total.y + h.y, w: total.w, h: total.h };
  const w = workRect(doc, t, docRect, 6 + hb.diffusion * 2);
  if (!w) { stroke.cancel(); return; }
  const { R } = w;
  // stroke coverage from the buffer (holder coords)
  const bd = ctx2d(stroke.buffer).getImageData(w.hr.x, w.hr.y, R.w, R.h).data;
  const n = R.w * R.h, region = new Uint8Array(n), weight = new Float32Array(n);
  for (let i = 0, j = 3; i < n; i++, j += 4) { if (bd[j]) region[i] = 1; weight[i] = bd[j] / 255; }
  const O = readWork(t, w, stroke.edit.original);
  const S = st.S(R);
  const res = hb.mode === 'replace' ? S : healBlend(O, S, region, R.w, R.h, hb.diffusion);
  stroke.edit.cancel();                   // restore the original pixels, then write the healed result as one state
  commitResult(doc, t, w, O, res, weight, 'Healing Brush', hb.mode, 'healing-brush');
}

const healTool: Tool = {
  id: 'healing-brush', name: 'Healing Brush Tool', group: 'heal', icon: 'healing-brush', shortcut: 'J', order: 1,
  settings: hb, paints: true,
  cursor: () => (mods.alt && hb.source === 'sampled' ? CURSOR_TARGET : 'none'),
  options(bar) {
    const o = optionsFor(healTool);
    return o.finish(bar, o.brush(), o.clonePanel(), separator(),
      o.select('Mode:', 'mode', HEAL_MODES, 110), separator(),
      o.radio('Source:', 'source', [
        { value: 'sampled', label: 'Sampled', title: 'Use pixels from the current image (Alt-click to define the source)' },
        { value: 'pattern', label: 'Pattern', title: 'Use pixels from a pattern' },
      ]),
      o.pattern(), separator(),
      o.check('Aligned', 'aligned', 'Use the same offset for each stroke'), separator(),
      o.sample(), separator(),
      o.num('Diffusion:', 'diffusion', { min: 1, max: 7, width: 36, title: 'Controls how quickly the pasted region adapts to the surrounding image (low for grain / fine detail, high for smooth areas)' }), separator(),
      o.angle(), separator(),
      o.toggle('pressure-size', 'pressureSize', 'Always use pressure for size. When off, Brush Settings presets control pressure.'));
  },
  pointerDown(p, doc) {
    if (heal) return;
    if (hb.source === 'sampled' && p.alt) { defineSource(doc, p.x, p.y); return; }
    const t = retouchTarget(doc, 'healing brush');
    if (!t) return;
    let S: (R: Rect) => Uint8ClampedArray;
    let renderDab: ConstructorParameters<typeof BufferStroke>[2]['renderDab'];
    if (hb.source === 'pattern') {
      const pat = patternById(hb.patternId);
      if (!pat) { fail('Could not use the healing brush because no pattern is defined.'); return; }
      const origin = hb.aligned ? { x: 0, y: 0 } : { x: Math.round(p.x), y: Math.round(p.y) };
      S = R => patternOver(pat.canvas, origin, R);
      renderDab = (bx, dab, tip, tl, holder) => {
        const c = createCanvas(tip.width, tip.height), x = ctx2d(c);
        const cp = x.createPattern(pat.canvas, 'repeat')!;
        cp.setTransform(new DOMMatrix().translate(origin.x - tl.x, origin.y - tl.y));
        x.fillStyle = cp; x.fillRect(0, 0, c.width, c.height);
        x.globalCompositeOperation = 'destination-in'; x.drawImage(tip, 0, 0);
        bx.globalAlpha = Math.max(0, Math.min(1, dab.flow));
        bx.drawImage(c, tl.x - holder.x, tl.y - holder.y);
      };
    } else {
      const src = activeSource(), sd = sourceDoc(src);
      if (!src.defined || !sd) { fail('Could not use the healing brush because the area to clone has not been defined (Alt-click to define a source point).'); return; }
      const img = sampleImage(sd, hb.sample, sd === doc ? t : sd.getPaintTarget());
      healAnchor = strokeAnchor(src, p, hb.aligned);
      const M = sourceToDest(src, healAnchor);
      S = R => sourceOver(img, M, R);
      renderDab = (bx, dab, tip, tl, holder) => renderSourceDab(bx, img, M, dab, tip, tl, holder);
      clone.painting = true;
    }
    const stroke = new BufferStroke(doc, t, { ...hb, opacity: 1, flow: 1, blendMode: 'normal', historyName: 'Healing Brush', renderDab }, p);
    heal = { doc, t, stroke, S };
  },
  pointerMove(p) { heal?.stroke.move(p); },
  pointerUp() {
    const st = heal;
    heal = null; clone.painting = false; healAnchor = null;
    if (!st) return;
    try { finishHeal(st); } catch (err) { console.error(err); st.stroke.cancel(); fail('Could not complete the Healing Brush because of a program error.'); }
    st.doc.redrawOverlay();
  },
  deactivate() { if (heal) { heal.stroke.cancel(); heal = null; clone.painting = false; healAnchor = null; } },
  drawOverlay(ctx, view, doc) {
    if (hb.source === 'sampled') drawCloneOverlay(ctx, view, doc, hb.size, hb.aligned, healAnchor);
    if (!(mods.alt && hb.source === 'sampled')) drawCursor(ctx, view, hb);
  },
};
app.registerTool(healTool);
