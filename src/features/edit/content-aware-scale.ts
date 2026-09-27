// Edit › Content-Aware Scale (Alt+Shift+Ctrl+C): resize the layer (or selected pixels) while keeping important
// content — seams of low detail are removed or duplicated. Handles like Free Transform (Shift keeps the ratio,
// Alt scales from the centre), W / H %, Amount, Protect (alpha channel), Protect Skin Tones. Enter commits.
import { app, type Tool, type ToolPointer } from '../../core/app';
import { registerCommands } from '../../core/commands';
import { createCanvas, ctx2d } from '../../core/canvas';
import type { Rect } from '../../core/types';
import type { Viewport } from '../../core/viewport';
import { h } from '../../ui/dom';
import { iconButton, numberField, select, separator, toggleButton } from '../../ui/widgets';
import { registerIcons } from '../../ui/icons';
import { toast } from '../../ui/toast';
import { runApply, runPreview, rgb3 } from '../../filters/engine';
import { grabLayer, showPreview, clearPreview, commitLayer, enterTool, type LayerSource } from './layer-session';

registerIcons({ 'cas-skin': '<circle cx="12" cy="8" r="3.5"/><path d="M5 20c1-4 3.5-6 7-6s6 2 7 6"/>' });
const opts = { amount: 100, skin: false, protect: -1 };
interface S { src: LayerSource; box: Rect; drag: null | { h: number; start: { x: number; y: number }; b0: Rect }; timer: number; seq: number; back: () => void; busy: boolean; last: { canvas: HTMLCanvasElement; box: Rect } | null }
let st: S | null = null;
const HANDLES: [number, number][] = [[0, 0], [0.5, 0], [1, 0], [1, 0.5], [1, 1], [0.5, 1], [0, 1], [0, 0.5]];

function protectMask(s: LayerSource): Uint8Array | undefined {
  const ch = s.doc.channels.find((c: any) => c.id === opts.protect);
  if (!ch) return undefined;
  const r = s.rect, c = createCanvas(r.w, r.h), x = c.getContext('2d', { willReadFrequently: true })!;
  x.drawImage(ch.canvas, -r.x, -r.y);
  const d = x.getImageData(0, 0, r.w, r.h).data, out = new Uint8Array(r.w * r.h);
  for (let i = 0; i < out.length; i++) out[i] = d[i * 4 + 3];
  return out;
}
const imgOf = (c: HTMLCanvasElement) => c.getContext('2d', { willReadFrequently: true })!.getImageData(0, 0, c.width, c.height);
const toCanvas = (img: ImageData) => { const c = createCanvas(img.width, img.height); ctx2d(c).putImageData(img, 0, 0); return c; };
const meta = (preview: boolean, aux: any, w: number, h: number) => ({ x: 0, y: 0, docW: w, docH: h, sel: null, isMask: false, preview, fg: rgb3(app.fg), bg: rgb3(app.bg), seed: 1, aux });

/** Live preview: instant stretched image, then the carved result on a reduced copy. */
function schedule() {
  const s = st;
  if (!s) return;
  const b = s.box;
  // instant feedback
  const quick = createCanvas(Math.max(1, Math.round(b.w)), Math.max(1, Math.round(b.h)));
  ctx2d(quick).drawImage(s.last && s.last.box.w === b.w && s.last.box.h === b.h ? s.last.canvas : s.src.src, 0, 0, quick.width, quick.height);
  showPreview(s.src, quick, b.x, b.y);
  clearTimeout(s.timer);
  s.timer = window.setTimeout(async () => {
    const my = ++s.seq, r = s.src.rect;
    const k = Math.min(1, 520 / Math.max(r.w, r.h, b.w, b.h));
    const small = createCanvas(Math.max(2, Math.round(r.w * k)), Math.max(2, Math.round(r.h * k)));
    ctx2d(small).drawImage(s.src.src, 0, 0, small.width, small.height);
    let aux: any = {};
    const pm = protectMask(s.src);
    if (pm) { const pc = createCanvas(r.w, r.h), pi = pc.getContext('2d')!.createImageData(r.w, r.h); for (let i = 0; i < pm.length; i++) pi.data[i * 4 + 3] = pm[i]; pc.getContext('2d')!.putImageData(pi, 0, 0); const sm = createCanvas(small.width, small.height), sx = sm.getContext('2d', { willReadFrequently: true })!; sx.drawImage(pc, 0, 0, sm.width, sm.height); const sd = sx.getImageData(0, 0, sm.width, sm.height).data; aux = { protect: Uint8Array.from({ length: sm.width * sm.height }, (_, i) => sd[i * 4 + 3]) }; }
    try {
      const res = await runPreview('ca-scale', imgOf(small), { tw: Math.max(1, b.w * k), th: Math.max(1, b.h * k), amount: opts.amount, skin: opts.skin }, meta(true, aux, small.width, small.height));
      if (!st || my !== s.seq) return;
      const up = createCanvas(Math.max(1, Math.round(b.w)), Math.max(1, Math.round(b.h))), ux = ctx2d(up);
      ux.imageSmoothingQuality = 'high'; ux.drawImage(toCanvas(res), 0, 0, up.width, up.height);
      s.last = { canvas: up, box: { ...b } };
      showPreview(s.src, up, b.x, b.y);
    } catch (err) { console.error(err); }
  }, 110);
}
async function commit() {
  const s = st;
  if (!s || s.busy) return;
  const b = s.box;
  if (Math.round(b.w) === s.src.rect.w && Math.round(b.h) === s.src.rect.h && Math.round(b.x) === s.src.rect.x && Math.round(b.y) === s.src.rect.y) { cancel(); return; }
  s.busy = true;
  document.body.classList.add('busy');
  try {
    const pm = protectMask(s.src);
    const res = await runApply('ca-scale', imgOf(s.src.src), { tw: Math.round(b.w), th: Math.round(b.h), amount: opts.amount, skin: opts.skin }, meta(false, pm ? { protect: pm } : {}, s.src.rect.w, s.src.rect.h));
    finish();
    commitLayer(s.src, 'Content-Aware Scale', toCanvas(res), Math.round(b.x), Math.round(b.y));
  } catch (err: any) { toast('Content-Aware Scale failed: ' + (err?.message || err), 'error'); s.busy = false; }
  finally { document.body.classList.remove('busy'); }
}
function finish() { const s = st; if (!s) return; clearTimeout(s.timer); st = null; s.back(); }
function cancel() { const s = st; if (!s) return; clearPreview(s.src); finish(); }

function handleAt(v: Viewport, b: Rect, p: ToolPointer): number {
  for (let i = 0; i < 8; i++) { const q = v.docToScreen(b.x + HANDLES[i][0] * b.w, b.y + HANDLES[i][1] * b.h); if (Math.abs(q.x - p.sx) <= 6 && Math.abs(q.y - p.sy) <= 6) return i; }
  return p.x >= b.x && p.y >= b.y && p.x <= b.x + b.w && p.y <= b.y + b.h ? 8 : -1;
}
const tool: Tool = {
  id: 'ca-scale', name: 'Content-Aware Scale', group: 'ca-scale', icon: 'move', noCtrlMove: true,
  cursor: () => { const v = app.viewport, s = st; if (!v || !s) return 'default'; const i = handleAt(v, s.box, v.pointer as any); return i < 0 ? 'default' : i === 8 ? 'move' : i % 4 === 0 ? 'nwse-resize' : i % 4 === 2 ? 'nesw-resize' : i % 4 === 1 ? 'ns-resize' : 'ew-resize'; },
  isModal: () => !!st, commit: () => void commit(), cancel,
  deactivate() { if (st && !st.busy) void commit(); },
  pointerDown(p) { const s = st, v = app.viewport; if (!s || !v) return; const i = handleAt(v, s.box, p); if (i < 0) return; s.drag = { h: i, start: { x: p.x, y: p.y }, b0: { ...s.box } }; },
  pointerMove(p) {
    const s = st;
    if (!s?.drag) return;
    const { h: hi, start, b0 } = s.drag, dx = p.x - start.x, dy = p.y - start.y;
    let b = { ...b0 };
    if (hi === 8) { b.x += dx; b.y += dy; }
    else {
      const [u, v] = HANDLES[hi];
      let x0 = b0.x, y0 = b0.y, x1 = b0.x + b0.w, y1 = b0.y + b0.h;
      if (u === 0) x0 += dx; if (u === 1) x1 += dx; if (v === 0) y0 += dy; if (v === 1) y1 += dy;
      if (p.alt) { if (u === 0) x1 -= dx; if (u === 1) x0 -= dx; if (v === 0) y1 -= dy; if (v === 1) y0 -= dy; }
      b = { x: Math.min(x0, x1), y: Math.min(y0, y1), w: Math.max(2, Math.abs(x1 - x0)), h: Math.max(2, Math.abs(y1 - y0)) };
      if (p.shift && u !== 0.5 && v !== 0.5) { const r = b0.w / b0.h; if (b.w / b.h > r) b.h = b.w / r; else b.w = b.h * r; if (u === 0) b.x = x1 - b.w; if (v === 0) b.y = y1 - b.h; }
    }
    s.box = b; sync(); schedule();
  },
  pointerUp() { if (st) st.drag = null; },
  keyDown(e) { if (e.key === 'Enter') { void commit(); return true; } if (e.key === 'Escape') { cancel(); return true; } return false; },
  drawOverlay(ctx, view) {
    const s = st;
    if (!s) return;
    const b = s.box, pts = [view.docToScreen(b.x, b.y), view.docToScreen(b.x + b.w, b.y), view.docToScreen(b.x + b.w, b.y + b.h), view.docToScreen(b.x, b.y + b.h)];
    ctx.strokeStyle = '#1e8bff'; ctx.lineWidth = 1; ctx.beginPath(); pts.forEach((q, i) => (i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y))); ctx.closePath(); ctx.stroke();
    for (const [u, v] of HANDLES) { const q = view.docToScreen(b.x + u * b.w, b.y + v * b.h); ctx.fillStyle = '#fff'; ctx.fillRect(q.x - 3.5, q.y - 3.5, 7, 7); ctx.strokeRect(q.x - 3.5, q.y - 3.5, 7, 7); }
    ctx.fillStyle = 'rgba(0,0,0,.65)'; const q = view.docToScreen(b.x + b.w, b.y + b.h); ctx.fillRect(q.x + 8, q.y + 8, 110, 20); ctx.fillStyle = '#fff'; ctx.font = '11px system-ui'; ctx.fillText(`W: ${Math.round(b.w)} px  H: ${Math.round(b.h)} px`, q.x + 13, q.y + 22);
  },
  options(bar) {
    const s = st;
    if (!s) return;
    const r = s.src.rect;
    wF = numberField((s.box.w / r.w) * 100, v => { s.box = { ...s.box, w: (r.w * v) / 100 }; schedule(); }, { min: 1, max: 1000, unit: '%', decimals: 1, width: 64, label: 'W:', title: 'Width' });
    hF = numberField((s.box.h / r.h) * 100, v => { s.box = { ...s.box, h: (r.h * v) / 100 }; schedule(); }, { min: 1, max: 1000, unit: '%', decimals: 1, width: 64, label: 'H:', title: 'Height' });
    const chans = (s.src.doc.channels || []) as any[];
    bar.append(wF, hF, separator(),
      numberField(opts.amount, v => { opts.amount = v; schedule(); }, { min: 0, max: 100, unit: '%', width: 56, label: 'Amount:', title: 'Blend between content-aware and normal scaling' }),
      h('span.opt-label', null, 'Protect:'),
      select<number>([{ value: -1, label: 'None' }, ...chans.map((c: any) => ({ value: c.id, label: c.name }))], opts.protect, v => { opts.protect = v; schedule(); }, { width: 120, title: 'Alpha channel to protect' }),
      toggleButton('cas-skin', 'Protect skin tones', opts.skin, v => { opts.skin = v; schedule(); }),
      h('span.tp-flex'),
      iconButton('cancel', 'Cancel (Esc)', () => cancel()), iconButton('commit', 'Commit (Enter)', () => void commit()));
  },
};
let wF: any = null, hF: any = null;
function sync() { const s = st; if (!s) return; wF?.setValue((s.box.w / s.src.rect.w) * 100); hF?.setValue((s.box.h / s.src.rect.h) * 100); }
app.registerTool(tool);

registerCommands([{
  id: 'edit.contentAwareScale', label: 'Content-Aware Scale', shortcut: 'Alt+Shift+Ctrl+C', enabled: () => !!app.activeDoc?.activeLayer,
  run: () => {
    if (st) return;
    const src = grabLayer(app.activeDoc, 'Content-Aware Scale');
    if (!src) return;
    st = { src, box: { ...src.rect }, drag: null, timer: 0, seq: 0, back: () => {}, busy: false, last: null };
    st.back = enterTool(tool, src.prevTool);
    src.doc.redrawOverlay();
  },
}]);
(window as any).__pxCAS = { get state() { return st; }, commit, cancel };
