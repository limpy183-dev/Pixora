// Select › Color Range: sampled colours (with +/− eyedroppers, Fuzziness, Localized Color Clusters + Range),
// colour families, tonal ranges and skin tones; B/W thumbnail preview and on-canvas Selection Preview.
import '../../tools/selection/selection.css';
import { app } from '../../core/app';
import type { PixDocument } from '../../core/document';
import { viewportHooks } from '../../core/viewport';
import { createCanvas, ctx2d } from '../../core/canvas';
import { Selection } from '../../core/selection';
import { h } from '../../ui/dom';
import { openDialog } from '../../ui/dialog';
import { checkbox, iconButton, select, sliderRow } from '../../ui/widgets';
import { toLab } from './algo';
import { busy, commitMask, makeProxy, setSelectionPreview, warnIfFaint, type PreviewMode } from './ops';

type Kind = 'sampled' | 'reds' | 'yellows' | 'greens' | 'cyans' | 'blues' | 'magentas' | 'highlights' | 'midtones' | 'shadows' | 'skin';
const KINDS: { value: Kind; label: string }[] = [
  { value: 'sampled', label: 'Sampled Colors' }, { value: 'reds', label: 'Reds' }, { value: 'yellows', label: 'Yellows' }, { value: 'greens', label: 'Greens' },
  { value: 'cyans', label: 'Cyans' }, { value: 'blues', label: 'Blues' }, { value: 'magentas', label: 'Magentas' },
  { value: 'highlights', label: 'Highlights' }, { value: 'midtones', label: 'Midtones' }, { value: 'shadows', label: 'Shadows' }, { value: 'skin', label: 'Skin Tones' },
];
const HUES: Partial<Record<Kind, number>> = { reds: 0, yellows: 60, greens: 120, cyans: 180, blues: 240, magentas: 300 };

interface Sample { L: number; a: number; b: number; x: number; y: number; neg: boolean }
const mem = { kind: 'sampled' as Kind, fuzz: 40, range: 100, localized: false, invert: false, preview: 'none' as PreviewMode, thumb: 'selection' as 'selection' | 'image', samples: [] as Sample[], hiThr: 190, shThr: 65 };

const smooth = (e0: number, e1: number, x: number) => { const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); };

/** Colour-range alpha (0..255) for RGBA pixels `d` (w×h). coords scale: sample x/y are in doc px; `scale` maps doc → these pixels. */
function computeRange(d: Uint8ClampedArray, w: number, h: number, scale: number, maxDim: number): Uint8Array {
  const n = w * h, out = new Uint8Array(n);
  const k = mem.kind;
  if (k === 'sampled' || k === 'skin') {
    const lab = toLab(d, n), L = lab.subarray(0, n), A = lab.subarray(n, 2 * n), B = lab.subarray(2 * n);
    const fz = Math.max(1, mem.fuzz) * 0.55;         // Fuzziness 0..200 → Lab distance
    if (k === 'skin') {
      for (let i = 0; i < n; i++) {
        const hue = Math.atan2(B[i], A[i]) * 180 / Math.PI, chroma = Math.hypot(A[i], B[i]);
        const hk = 1 - smooth(18, 18 + fz * 0.6, Math.abs(hue - 52));
        const ck = smooth(6, 12, chroma) * (1 - smooth(48, 48 + fz * 0.4, chroma));
        const lk = smooth(20, 32, L[i]) * (1 - smooth(92, 97, L[i]));
        out[i] = Math.round(hk * ck * lk * 255 * (d[i * 4 + 3] / 255));
      }
      return out;
    }
    const pos = mem.samples.filter(s => !s.neg), neg = mem.samples.filter(s => s.neg);
    if (!pos.length) return out;
    const rangePx = (mem.range / 100) * maxDim * scale * 0.5 + 1;
    const val = (list: Sample[], i: number, x: number, y: number) => {
      let best = 0;
      for (const s of list) {
        const dist = Math.hypot((L[i] - s.L) * 0.8, A[i] - s.a, B[i] - s.b);
        let v = dist <= fz * 0.35 ? 1 : dist >= fz ? 0 : 1 - (dist - fz * 0.35) / (fz * 0.65);
        if (v > 0 && mem.localized) v *= Math.max(0, 1 - Math.hypot(x - s.x * scale, y - s.y * scale) / rangePx);
        if (v > best) best = v;
      }
      return best;
    };
    for (let y = 0, i = 0; y < h; y++) for (let x = 0; x < w; x++, i++) {
      let v = val(pos, i, x, y);
      if (v > 0 && neg.length) v = Math.min(v, 1 - val(neg, i, x, y));
      out[i] = Math.round(v * 255 * (d[i * 4 + 3] / 255));
    }
    return out;
  }
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    const r = d[j], g = d[j + 1], b = d[j + 2];
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), c = mx - mn;
    let v = 0;
    if (k in HUES) {
      if (c > 0) {
        let hue = mx === r ? ((g - b) / c) % 6 : mx === g ? (b - r) / c + 2 : (r - g) / c + 4;
        hue *= 60; if (hue < 0) hue += 360;
        let dh = Math.abs(hue - HUES[k]!); if (dh > 180) dh = 360 - dh;
        v = (1 - smooth(22, 45, dh)) * smooth(12, 60, c);
      }
    } else {
      const lum = 0.299 * r + 0.587 * g + 0.114 * b;
      if (k === 'highlights') v = smooth(mem.hiThr - 30, mem.hiThr + 10, lum);
      else if (k === 'shadows') v = 1 - smooth(mem.shThr - 10, mem.shThr + 30, lum);
      else v = smooth(mem.shThr - 10, mem.shThr + 30, lum) * (1 - smooth(mem.hiThr - 30, mem.hiThr + 10, lum));
    }
    out[i] = Math.round(v * 255 * (d[j + 3] / 255));
  }
  return out;
}

export async function openColorRange(doc: PixDocument): Promise<void> {
  const W = doc.width, H = doc.height;
  const src = doc.getComposite();
  const pr = makeProxy(src, { x: 0, y: 0, w: W, h: H }, 300);
  const fullImg = () => ctx2d(src).getImageData(0, 0, W, H);
  const selMask = doc.selection.empty ? null : doc.selection.mask;
  let dropper: 'sample' | 'add' | 'sub' = 'sample';

  const thumb = h('canvas', { width: pr.w, height: pr.h, title: 'Click to sample colours (Shift: add, Alt: subtract)' }) as HTMLCanvasElement;
  const tx = ctx2d(thumb);
  const thumbImg = new ImageData(new Uint8ClampedArray(pr.data), pr.w, pr.h);
  let proxyMask: Uint8Array = new Uint8Array(pr.w * pr.h);
  let raf = 0;
  const update = () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; recompute(); }); };
  function recompute() {
    proxyMask = computeRange(pr.data, pr.w, pr.h, pr.scale, Math.max(W, H));
    if (mem.invert) for (let i = 0; i < proxyMask.length; i++) proxyMask[i] = 255 - proxyMask[i];
    if (mem.thumb === 'selection') {
      const img = tx.createImageData(pr.w, pr.h), o = img.data;
      for (let i = 0, j = 0; i < proxyMask.length; i++, j += 4) { o[j] = o[j + 1] = o[j + 2] = proxyMask[i]; o[j + 3] = 255; }
      tx.putImageData(img, 0, 0);
    } else tx.putImageData(thumbImg, 0, 0);
    // on-canvas preview (proxy upscaled; restricted to the existing selection)
    if (mem.preview !== 'none') {
      const c = createCanvas(W, H), x = ctx2d(c);
      x.imageSmoothingEnabled = true; x.drawImage(Selection.canvasFromAlpha(proxyMask, pr.w, pr.h), 0, 0, W, H);
      if (selMask) { x.globalCompositeOperation = 'destination-in'; x.drawImage(selMask, 0, 0); }
      setSelectionPreview(doc, c, mem.preview);
    } else setSelectionPreview(null, null);
    syncUI();
  }

  const sampleAt = (dx: number, dy: number, mode: 'sample' | 'add' | 'sub') => {
    const px = Math.max(0, Math.min(pr.w - 1, Math.floor(dx * pr.scale))), py = Math.max(0, Math.min(pr.h - 1, Math.floor(dy * pr.scale)));
    const j = (py * pr.w + px) * 4;
    const lab = toLab(pr.data.subarray(j, j + 4), 1);
    const s: Sample = { L: lab[0], a: lab[1], b: lab[2], x: dx, y: dy, neg: mode === 'sub' };
    if (mem.kind !== 'sampled') { mem.kind = 'sampled'; kindSel.setValue('sampled'); }
    if (mode === 'sample') mem.samples = [s]; else mem.samples.push(s);
    update();
  };
  thumb.addEventListener('pointerdown', e => {
    const r = thumb.getBoundingClientRect();
    const dx = (e.clientX - r.left) / r.width * W, dy = (e.clientY - r.top) / r.height * H;
    sampleAt(dx, dy, e.shiftKey ? 'add' : e.altKey ? 'sub' : dropper);
  });
  // sample from the document canvas while the dialog is open (modeless)
  const hook = (p: { x: number; y: number; shift: boolean; alt: boolean }) => {
    if (p.x < 0 || p.y < 0 || p.x >= W || p.y >= H) return true;
    sampleAt(p.x, p.y, p.shift ? 'add' : p.alt ? 'sub' : dropper);
    return true;
  };
  viewportHooks.pointerDown.unshift(hook);

  const kindSel = select(KINDS, mem.kind, v => { mem.kind = v; update(); }, { width: 170 });
  const fuzz = sliderRow('Fuzziness:', mem.fuzz, 0, 200, v => { mem.fuzz = v; update(); });
  const range = sliderRow('Range:', mem.range, 0, 100, v => { mem.range = v; update(); }, { unit: '%' });
  const local = checkbox('Localized Color Clusters', mem.localized, v => { mem.localized = v; update(); }, { title: 'Weight sampled colours by their distance from the sample points' });
  const invert = checkbox('Invert', mem.invert, v => { mem.invert = v; update(); });
  const radios = h('div.cr-radios');
  for (const [v, l] of [['selection', 'Selection'], ['image', 'Image']] as const) {
    const inp = h('input', { type: 'radio', name: 'cr-thumb', checked: mem.thumb === v }) as HTMLInputElement;
    inp.addEventListener('change', () => { if (inp.checked) { mem.thumb = v; update(); } });
    radios.append(h('label.sel-radio', null, inp, h('span', null, l)));
  }
  const previewSel = select<PreviewMode>([{ value: 'none', label: 'None' }, { value: 'grayscale', label: 'Grayscale' }, { value: 'black', label: 'Black Matte' }, { value: 'white', label: 'White Matte' }, { value: 'quickmask', label: 'Quick Mask' }], mem.preview, v => { mem.preview = v; update(); }, { width: 120 });
  const drops = h('div.cr-droppers');
  const dropBtns = ([['sample', 'eyedropper', 'Eyedropper: sample a colour'], ['add', 'eyedropper-plus', 'Add to Sample (Shift)'], ['sub', 'eyedropper-minus', 'Subtract from Sample (Alt)']] as const).map(([m, ic, title]) => {
    const b = iconButton(ic, title, () => { dropper = m; dropBtns.forEach((x, i) => x.classList.toggle('active', i === ['sample', 'add', 'sub'].indexOf(m))); }, { size: 16 });
    drops.append(b);
    return b;
  });
  dropBtns[0].classList.add('active');
  const syncUI = () => {
    const sampled = mem.kind === 'sampled';
    fuzz.classList.toggle('cr-dim', !(sampled || mem.kind === 'skin'));
    range.classList.toggle('cr-dim', !(sampled && mem.localized));
    local.classList.toggle('cr-dim', !sampled);
    drops.classList.toggle('cr-dim', !sampled);
  };
  const body = h('div.cr-body', null,
    h('div.cr-row', null, h('span', null, 'Select:'), kindSel),
    local, fuzz, range,
    h('div.cr-preview', null, thumb),
    radios,
    h('div.cr-row', null, h('span', null, 'Selection Preview:'), previewSel),
    h('div.cr-row', null, h('span', null, 'Sample tools:'), drops, invert));
  if (!mem.samples.length) {
    // PS starts with the foreground colour as the sample
    const lab = toLab(new Uint8ClampedArray([app.fg.r, app.fg.g, app.fg.b, 255]), 1);
    mem.samples = [{ L: lab[0], a: lab[1], b: lab[2], x: W / 2, y: H / 2, neg: false }];
  }
  const dlg = openDialog({ title: 'Color Range', body, layout: 'side', modal: false, className: 'cr-dialog' });
  const r = dlg.el.getBoundingClientRect();
  Object.assign(dlg.el.style, { position: 'fixed', margin: '0', left: Math.max(8, window.innerWidth - r.width - 330) + 'px', top: '90px' });
  recompute();
  const ok = await dlg.result;
  viewportHooks.pointerDown.splice(viewportHooks.pointerDown.indexOf(hook), 1);
  setSelectionPreview(null, null);
  if (!ok) return;
  await busy('Color Range…', () => {
    const m = computeRange(fullImg().data, W, H, 1, Math.max(W, H));
    if (mem.invert) for (let i = 0; i < m.length; i++) m[i] = 255 - m[i];
    commitMask(doc, 'Color Range', m, selMask ? 'intersect' : 'replace');
  });
  warnIfFaint(doc);
}
