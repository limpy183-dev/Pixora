// Edit > Fill... (Shift+F5 / Shift+Backspace), Edit > Stroke..., and the quick fills Alt+Backspace (foreground),
// Ctrl+Backspace (background) — add Shift to preserve transparency.
// Fill contents: Foreground / Background / Color... / Content-Aware / Pattern / History / Black / 50% Gray / White,
// with blending mode, opacity and Preserve Transparency. Fills the selection, or the whole layer without one.
// Stroke: width, colour, location (inside / center / outside) around the selection (or the layer's pixels).
import { app } from '../../core/app';
import type { PixDocument, PaintTarget } from '../../core/document';
import { RasterLayer } from '../../core/layer';
import { registerCommands } from '../../core/commands';
import { createCanvas, ctx2d } from '../../core/canvas';
import { blendPixels } from '../../core/compositor';
import { intersectRect } from '../../core/geom';
import { hooks, resources } from '../../core/registry';
import { Selection } from '../../core/selection';
import { BLEND_MODE_LABELS, BLEND_MODE_MENU, type BlendMode, type Pattern, type Rect, type RGB } from '../../core/types';
import { h } from '../../ui/dom';
import { openDialog } from '../../ui/dialog';
import { checkbox, colorSwatch, numberField, patternPicker, select, type SelectOption } from '../../ui/widgets';
import { toast } from '../../ui/toast';
import { historySource } from './history-brush';
import { paintTarget, readRegion } from './common';
import { contentAwareFill } from '../retouch/content-aware-fill';

type Contents = 'fg' | 'bg' | 'color' | 'content-aware' | 'pattern' | 'history' | 'black' | 'gray' | 'white';
const CONTENTS: SelectOption<Contents>[] = [
  { value: 'fg', label: 'Foreground Color' }, { value: 'bg', label: 'Background Color' }, { value: 'color', label: 'Color...' },
  { value: 'content-aware', label: 'Content-Aware' }, { value: 'pattern', label: 'Pattern' }, { value: 'history', label: 'History' },
  { value: 'black', label: 'Black' }, { value: 'gray', label: '50% Gray' }, { value: 'white', label: 'White' },
];
const MODES: (SelectOption<BlendMode> | '-')[] = BLEND_MODE_MENU.map(m => (m === '-' ? '-' : { value: m, label: BLEND_MODE_LABELS[m] }));

interface FillOpts { contents: Contents; color: RGB; patternId: string; mode: BlendMode; opacity: number; preserve: boolean; colorAdapt: boolean }
const fillOpts: FillOpts = (() => {
  const d: FillOpts = { contents: 'fg', color: { r: 255, g: 255, b: 255 }, patternId: '', mode: 'normal', opacity: 100, preserve: false, colorAdapt: true };
  try { return { ...d, ...JSON.parse(localStorage.getItem('pixora.fill') || '{}') }; } catch { return d; }
})();
interface StrokeOpts { width: number; color: RGB; location: 'inside' | 'center' | 'outside'; mode: BlendMode; opacity: number; preserve: boolean }
const strokeOpts: StrokeOpts = (() => {
  const d: StrokeOpts = { width: 1, color: { r: 0, g: 0, b: 0 }, location: 'center', mode: 'normal', opacity: 100, preserve: false };
  try { return { ...d, ...JSON.parse(localStorage.getItem('pixora.strokeDlg') || '{}') }; } catch { return d; }
})();
const persist = (k: string, v: unknown) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* ignore */ } };
const css = (c: RGB) => `rgb(${c.r},${c.g},${c.b})`;

// ------------------------------------------------------------------ shared: composite a doc-sized paint canvas
/**
 * Composite `paint` (doc-sized RGBA, already shaped by selection / stroke mask) into the paint target through
 * a blend mode. Masks receive the grey value. Records one history state.
 */
function applyPaint(doc: PixDocument, t: PaintTarget, paint: HTMLCanvasElement, area: Rect, mode: BlendMode, opacity: number, preserve: boolean, name: string): boolean {
  if (t.kind === 'pixels' && t.layer instanceof RasterLayer) t.layer.ensureRect({ x: 0, y: 0, w: doc.width, h: doc.height });
  const hold = t.holder;
  const R = intersectRect(area, { x: hold.x, y: hold.y, w: hold.canvas.width, h: hold.canvas.height });
  if (!R) return false;
  const hr = { x: R.x - hold.x, y: R.y - hold.y, w: R.w, h: R.h };
  const dst = readRegion(hold.canvas, hr.x, hr.y, hr.w, hr.h), dd = dst.data;
  const src = readRegion(paint, R.x, R.y, R.w, R.h).data;
  const op = Math.max(0, Math.min(1, opacity / 100));
  if (t.isMask) {
    for (let i = 0; i < dd.length; i += 4) {
      const k = (src[i + 3] / 255) * op;
      if (k <= 0) continue;
      const v = 0.299 * src[i] + 0.587 * src[i + 1] + 0.114 * src[i + 2];
      dd[i + 3] = dd[i + 3] * (1 - k) + v * k;
    }
  } else {
    const keepAlpha = preserve || (t.kind === 'pixels' && !!t.layer?.transparencyLocked);
    const alpha = keepAlpha ? new Uint8ClampedArray(dd.length / 4) : null;
    if (alpha) for (let i = 0, j = 3; i < alpha.length; i++, j += 4) alpha[i] = dd[j];
    blendPixels(dd, src, mode, op, R.w, R.x, R.y);
    if (alpha) for (let i = 0, j = 3; i < alpha.length; i++, j += 4) dd[j] = alpha[i];
  }
  const edit = doc.history.beginPixelEdit(hold, name);
  ctx2d(hold.canvas).putImageData(dst, hr.x, hr.y);
  const ok = edit.commit(name, hr);
  if (ok) doc.pixelsChanged(t.layer, R);
  return ok;
}

/** Doc-sized canvas filled with `content` and masked by the selection. */
function fillCanvas(doc: PixDocument, content: (x: CanvasRenderingContext2D) => void): HTMLCanvasElement {
  const c = createCanvas(doc.width, doc.height), x = ctx2d(c);
  content(x);
  if (!doc.selection.empty && !doc.quickMask) { x.globalCompositeOperation = 'destination-in'; x.drawImage(doc.selection.mask!, 0, 0); }
  return c;
}

// ------------------------------------------------------------------ fill
async function doFill(doc: PixDocument, o: FillOpts, name = 'Fill'): Promise<boolean> {
  const t = paintTarget(doc, 'Fill command');
  if (!t) return false;
  const area = doc.selection.empty || doc.quickMask ? { x: 0, y: 0, w: doc.width, h: doc.height } : doc.selection.bounds!;
  if (o.contents === 'content-aware') {
    if (doc.selection.empty) { toast('Could not complete the Fill command because Content-Aware requires a selection.', 'error', 3600); return false; }
    return contentAwareFill(doc, { sampling: 'auto', sampleAll: false, colorAdapt: o.colorAdapt, output: 'current' }, name);
  }
  let paint: HTMLCanvasElement;
  if (o.contents === 'pattern') {
    const pat: Pattern | undefined = resources.patterns.find(p => p.id === o.patternId) || resources.patterns[0];
    if (!pat) { toast('Could not complete the Fill command because no pattern is defined.', 'error'); return false; }
    paint = fillCanvas(doc, x => { x.fillStyle = x.createPattern(pat.canvas, 'repeat')!; x.fillRect(0, 0, doc.width, doc.height); });
  } else if (o.contents === 'history') {
    const src = historySource(doc, t, 'Fill command');
    if (!src) return false;
    paint = fillCanvas(doc, x => x.drawImage(src.canvas, src.x, src.y));
  } else {
    const col = o.contents === 'fg' ? app.fg : o.contents === 'bg' ? app.bg : o.contents === 'color' ? o.color
      : o.contents === 'black' ? { r: 0, g: 0, b: 0 } : o.contents === 'gray' ? { r: 128, g: 128, b: 128 } : { r: 255, g: 255, b: 255 };
    paint = fillCanvas(doc, x => { x.fillStyle = css(col); x.fillRect(0, 0, doc.width, doc.height); });
  }
  return applyPaint(doc, t, paint, area, o.mode, o.opacity, o.preserve, name);
}

async function fillDialog() {
  const doc = app.activeDoc;
  if (!doc) return;
  if (!paintTarget(doc, 'Fill command')) return;
  const o: FillOpts = { ...fillOpts };
  if (!o.patternId) o.patternId = resources.patterns[0]?.id || '';
  const patRow = h('div.form-row.fs-pattern', null, h('label.form-label', null, 'Custom Pattern:'),
    patternPicker(resources.patterns.find(p => p.id === o.patternId) || null, p => { o.patternId = p.id; }));
  const caRow = h('div.form-row', null, h('label.form-label', null, ''), checkbox('Color Adaptation', o.colorAdapt, v => { o.colorAdapt = v; }, { title: 'Blend the fill into the surrounding colours' }));
  const blend = h('fieldset.fs-group', null, h('legend', null, 'Blending'),
    h('div.form-row', null, h('label.form-label', null, 'Mode:'), select<BlendMode>(MODES, o.mode, v => { o.mode = v; }, { width: 150, title: 'Blending mode' })),
    h('div.form-row', null, h('label.form-label', null, 'Opacity:'), numberField(o.opacity, v => { o.opacity = v; }, { min: 0, max: 100, unit: '%', width: 60, title: 'Opacity of the fill' })),
    h('div.form-row', null, h('label.form-label', null, ''), checkbox('Preserve Transparency', o.preserve, v => { o.preserve = v; }, { title: 'Only fill opaque pixels' })));
  const sync = () => {
    patRow.style.display = o.contents === 'pattern' ? '' : 'none';
    caRow.style.display = o.contents === 'content-aware' ? '' : 'none';
    blend.classList.toggle('fs-disabled', o.contents === 'content-aware');
  };
  const contents = select<Contents>(CONTENTS, o.contents, async v => {
    if (v === 'color') {
      const c = await hooks.openColorPicker(o.color, 'Color Picker (Fill Color)');
      if (c) o.color = c; else { contents.setValue(o.contents); return; }
    }
    o.contents = v; sync();
  }, { width: 170, title: 'What to fill with' });
  const body = h('div.fs-body', null, h('div.form-row', null, h('label.form-label', null, 'Contents:'), contents), patRow, caRow, blend);
  sync();
  const r = await openDialog({ title: 'Fill', body, buttons: [{ label: 'OK', primary: true, value: 'ok' }, { label: 'Cancel', value: null }] }).result;
  if (r !== 'ok') return;
  Object.assign(fillOpts, o); persist('pixora.fill', fillOpts);
  await doFill(doc, o);
}

function quickFill(which: 'fg' | 'bg', preserve: boolean) {
  const doc = app.activeDoc;
  if (!doc) return;
  void doFill(doc, { ...fillOpts, contents: which, mode: 'normal', opacity: 100, preserve }, 'Fill');
}

// ------------------------------------------------------------------ stroke
function strokeShape(doc: PixDocument, t: PaintTarget): { outline: Path2D; mask: HTMLCanvasElement } | null {
  if (!doc.selection.empty && !doc.quickMask) return { outline: doc.selection.outline()!, mask: doc.selection.mask! };
  // no selection: stroke around the layer's opaque pixels
  if (t.kind !== 'pixels' || !t.layer || t.layer.isBackground) return null;
  const m = createCanvas(doc.width, doc.height);
  ctx2d(m).drawImage(t.holder.canvas, t.holder.x, t.holder.y);
  const tmp = new Selection(doc);
  tmp.setMask(m);
  if (tmp.empty) return null;
  const outline = tmp.outline();
  return outline ? { outline, mask: tmp.mask! } : null;
}

function doStroke(doc: PixDocument, o: StrokeOpts): boolean {
  const t = paintTarget(doc, 'Stroke command');
  if (!t) return false;
  const sh = strokeShape(doc, t);
  if (!sh) { toast('Could not complete the Stroke command because there is no selection.', 'error'); return false; }
  const w = Math.max(1, o.width);
  const paint = createCanvas(doc.width, doc.height), x = ctx2d(paint);
  x.lineJoin = o.location === 'center' ? 'miter' : 'round';
  x.lineCap = 'round';
  x.strokeStyle = css(o.color);
  if (o.location === 'center') { x.lineWidth = w; x.stroke(sh.outline); }
  else {
    x.lineWidth = w * 2;
    x.stroke(sh.outline);
    x.globalCompositeOperation = o.location === 'inside' ? 'destination-in' : 'destination-out';
    x.drawImage(sh.mask, 0, 0);
  }
  const b = doc.selection.empty ? { x: 0, y: 0, w: doc.width, h: doc.height } : doc.selection.bounds!;
  const area = { x: b.x - w - 2, y: b.y - w - 2, w: b.w + 2 * w + 4, h: b.h + 2 * w + 4 };
  return applyPaint(doc, t, paint, area, o.mode, o.opacity, o.preserve, 'Stroke');
}

async function strokeDialog() {
  const doc = app.activeDoc;
  if (!doc) return;
  if (!paintTarget(doc, 'Stroke command')) return;
  const o: StrokeOpts = { ...strokeOpts };
  const locName = 'fs-loc-' + Date.now();
  const loc = (v: StrokeOpts['location'], label: string) => {
    const inp = h('input', { type: 'radio', name: locName, checked: o.location === v }) as HTMLInputElement;
    inp.addEventListener('change', () => { if (inp.checked) o.location = v; });
    return h('label.fs-radio', { title: `Stroke ${label.toLowerCase()} the selection edge` }, inp, h('span', null, label));
  };
  const body = h('div.fs-body', null,
    h('fieldset.fs-group', null, h('legend', null, 'Stroke'),
      h('div.form-row', null, h('label.form-label', null, 'Width:'), numberField(o.width, v => { o.width = v; }, { min: 1, max: 250, unit: 'px', width: 64, title: 'Stroke width (1–250 px)' })),
      h('div.form-row', null, h('label.form-label', null, 'Color:'), colorSwatch(o.color, c => { o.color = c; }, { title: 'Stroke color' }))),
    h('fieldset.fs-group', null, h('legend', null, 'Location'), h('div.form-row.fs-locs', null, loc('inside', 'Inside'), loc('center', 'Center'), loc('outside', 'Outside'))),
    h('fieldset.fs-group', null, h('legend', null, 'Blending'),
      h('div.form-row', null, h('label.form-label', null, 'Mode:'), select<BlendMode>(MODES, o.mode, v => { o.mode = v; }, { width: 150, title: 'Blending mode' })),
      h('div.form-row', null, h('label.form-label', null, 'Opacity:'), numberField(o.opacity, v => { o.opacity = v; }, { min: 0, max: 100, unit: '%', width: 60, title: 'Opacity of the stroke' })),
      h('div.form-row', null, h('label.form-label', null, ''), checkbox('Preserve Transparency', o.preserve, v => { o.preserve = v; }, { title: 'Only paint over opaque pixels' }))));
  const r = await openDialog({ title: 'Stroke', body, buttons: [{ label: 'OK', primary: true, value: 'ok' }, { label: 'Cancel', value: null }] }).result;
  if (r !== 'ok') return;
  Object.assign(strokeOpts, o); persist('pixora.strokeDlg', strokeOpts);
  doStroke(doc, o);
}

const hasDoc = () => !!app.activeDoc;
registerCommands([
  { id: 'edit.fill', label: 'Fill...', shortcut: ['Shift+F5', 'Shift+Backspace'], run: fillDialog, enabled: hasDoc },
  { id: 'edit.stroke', label: 'Stroke...', run: strokeDialog, enabled: hasDoc },
  { id: 'edit.fillForeground', label: 'Fill with Foreground Color', shortcut: 'Alt+Backspace', run: () => quickFill('fg', false), enabled: hasDoc },
  { id: 'edit.fillBackground', label: 'Fill with Background Color', shortcut: 'Ctrl+Backspace', run: () => quickFill('bg', false), enabled: hasDoc },
  { id: 'edit.fillForegroundPreserve', label: 'Fill with Foreground Color (Preserve Transparency)', shortcut: 'Alt+Shift+Backspace', run: () => quickFill('fg', true), enabled: hasDoc },
  { id: 'edit.fillBackgroundPreserve', label: 'Fill with Background Color (Preserve Transparency)', shortcut: 'Ctrl+Shift+Backspace', run: () => quickFill('bg', true), enabled: hasDoc },
]);

export { doFill, doStroke };
