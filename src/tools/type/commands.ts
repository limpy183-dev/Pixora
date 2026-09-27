// Type menu + Edit > Check Spelling / Find and Replace Text: anti-alias, orientation, Create Work Path, Convert to
// Shape, Convert to Point/Paragraph Text, Warp Text, Match Font, font preview size, Update All Text Layers,
// Paste Lorem Ipsum, More Fonts.
import { app } from '../../core/app';
import type { PixDocument } from '../../core/document';
import { events } from '../../core/events';
import { registerCommands } from '../../core/commands';
import { traceAlpha, type PathPoint, type SubPath, type VectorPath } from '../../core/path';
import { createCanvas, ctx2d } from '../../core/canvas';
import { h } from '../../ui/dom';
import { openDialog } from '../../ui/dialog';
import { checkbox, select, sliderRow } from '../../ui/widgets';
import { toast } from '../../ui/toast';
import { ShapeLayer } from '../../layers/shape-layer';
import { TextLayer, WARP_STYLES, clearMeasureCache, familyCss, type AntiAlias, type WarpSettings, type WarpStyle } from '../../layers/text-layer';
import { fontFamilies, loadLocalFonts, fontPrefs, setPreviewSize, GENERIC, type PreviewSize } from './fonts';
import { applyToText, editRange, editing, editingRange, end, insertAtCaret, replaceSelection, typeSettings } from './type-tool';
import { setChar } from './panels';

const D = () => app.activeDoc;
/** The type layers a command acts on: the one being edited, else the selected type layers. */
function typeLayers(): TextLayer[] {
  const e = editing();
  if (e) return [e.layer];
  const d = D();
  return d ? (d.selectedLayers.filter(l => l instanceof TextLayer) as TextLayer[]) : [];
}
const hasType = () => typeLayers().length > 0;
function needType(): TextLayer[] | null {
  const ls = typeLayers();
  if (!ls.length) { toast('Could not complete your request because the target layer is not a type layer.', 'error'); return null; }
  return ls;
}
/** Change layer-level text properties with one history state (or inside the editing session). */
function layerEdit(name: string, fn: (l: TextLayer) => void) {
  const ls = needType();
  if (!ls) return;
  if (editing()) { applyToText(name, {}, fn); return; }
  const d = D()!;
  d.history.transaction(name, () => { for (const l of ls) { fn(l); l.invalidate(); } }, 'type');
  d.pixelsChanged(null, null); d.layersChanged();
  events.emit('toolOptions');
}

// ------------------------------------------------------------------ outlines (Create Work Path / Convert to Shape)
/** Vector outlines of a text layer in doc coords, traced from a high-resolution rendering and smoothed into Béziers. */
export function textOutlines(doc: PixDocument, l: TextLayer): SubPath[] {
  const probe = l.renderTo(doc, 1, '#000', true);
  if (!probe) return [];
  const area = probe.canvas.width * probe.canvas.height;
  const s = Math.max(1, Math.min(6, Math.sqrt(24e6 / Math.max(1, area))));
  const c = l.renderTo(doc, s, '#000', false);
  if (!c) return [];
  const subs = traceAlpha(c.canvas, Math.max(1, 0.4 * s), 128, { x: 0, y: 0 });
  const out: SubPath[] = [];
  for (const sp of subs) {
    const pts = sp.points.map(p => ({ x: (p.x + c.x) / s, y: (p.y + c.y) / s }));
    if (pts.length < 3) continue;
    out.push({ closed: true, points: smoothPoints(pts) });
  }
  return orderByNesting(out);
}
/** Catmull-Rom handles on gently turning vertices; sharp corners stay corners. */
function smoothPoints(pts: { x: number; y: number }[]): PathPoint[] {
  const n = pts.length;
  return pts.map((p, i) => {
    const a = pts[(i - 1 + n) % n], b = pts[(i + 1) % n];
    const v1x = p.x - a.x, v1y = p.y - a.y, v2x = b.x - p.x, v2y = b.y - p.y;
    const l1 = Math.hypot(v1x, v1y), l2 = Math.hypot(v2x, v2y);
    const cos = l1 && l2 ? (v1x * v2x + v1y * v2y) / (l1 * l2) : 1;
    if (cos < 0.8) return { x: p.x, y: p.y, ix: p.x, iy: p.y, ox: p.x, oy: p.y, smooth: false };
    const tx = (b.x - a.x) / 2, ty = (b.y - a.y) / 2, tl = Math.hypot(tx, ty) || 1;
    const k1 = l1 / 3 / tl, k2 = l2 / 3 / tl;
    return { x: p.x, y: p.y, ix: p.x - tx * k1, iy: p.y - ty * k1, ox: p.x + tx * k2, oy: p.y + ty * k2, smooth: true };
  });
}
function inside(poly: PathPoint[], x: number, y: number): boolean {
  let r = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a.y > y) !== (b.y > y) && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) r = !r;
  }
  return r;
}
/** Outer contours add, holes subtract, islands in holes add again — ordered by nesting depth. */
function orderByNesting(subs: SubPath[]): SubPath[] {
  const depth = subs.map((s, i) => { const p = s.points[0]; let d = 0; subs.forEach((o, j) => { if (j !== i && inside(o.points, p.x + 1e-3, p.y + 1e-3)) d++; }); return d; });
  return subs.map((s, i) => ({ s, d: depth[i] })).sort((a, b) => a.d - b.d).map(({ s, d }, i) => ({ ...s, op: i === 0 ? 'add' : d % 2 ? 'subtract' : 'add' }));
}

function createWorkPath() {
  const ls = needType();
  const d = D();
  if (!ls || !d) return;
  if (editing()) end(true);
  const subpaths = ls.flatMap(l => textOutlines(d, l));
  if (!subpaths.length) { toast('The type layer has no visible text.', 'error'); return; }
  d.history.transaction('Create Work Path', () => {
    const id = Math.max(0, ...d.paths.map((p: VectorPath) => p.id)) + 1;
    d.paths = [{ id, name: 'Work Path', kind: 'work', subpaths } as VectorPath, ...d.paths.filter((p: VectorPath) => p.kind !== 'work')];
  }, 'path');
  events.emit('paths', d);
  d.redrawOverlay();
}
function convertToShape() {
  const ls = needType();
  const d = D();
  if (!ls || !d) return;
  if (editing()) end(true);
  const made: ShapeLayer[] = [];
  d.history.transaction('Convert to Shape', () => {
    for (const l of ls) {
      const subpaths = textOutlines(d, l);
      if (!subpaths.length) continue;
      const s = new ShapeLayer(l.name);
      s.subpaths = subpaths;
      s.fill = { type: 'solid', color: { ...l.styleAt(0).color } };
      s.opacity = l.opacity; s.fillOpacity = l.fillOpacity; s.blendMode = l.blendMode; s.visible = l.visible;
      s.clipped = l.clipped; s.effects = JSON.parse(JSON.stringify(l.effects)); s.effectsVisible = l.effectsVisible;
      s.colorLabel = l.colorLabel; s.mask = l.mask; s.linkId = l.linkId;
      d.addLayer(s, { above: l, select: false });
      d.removeLayer(l);
      made.push(s);
    }
    if (made.length) { d.selectedIds = made.map(m => m.id); d.setActiveLayer(made[made.length - 1]); }
  }, 'shape');
  d.pixelsChanged(null, null); d.layersChanged();
}

// ------------------------------------------------------------------ point <-> paragraph
function firstLineAnchor(doc: PixDocument, l: TextLayer): DOMPoint {
  const L = l.getLayout(doc), ln = L.lines[0];
  if (!ln) return l.matrix().transformPoint(new DOMPoint(0, 0));
  const pos = l.positions(L, ln);
  return l.matrix().transformPoint(L.vertical ? new DOMPoint(ln.x, pos[0]) : new DOMPoint(pos[0], ln.baseline));
}
function convertParagraph() {
  const ls = needType();
  const d = D();
  if (!ls || !d) return;
  if (editing()) end(true);
  const toPara = ls[0].textType === 'point';
  d.history.transaction(toPara ? 'Convert to Paragraph Text' : 'Convert to Point Text', () => {
    for (const l of ls) {
      const before = firstLineAnchor(d, l);
      if (l.textType === 'point' && toPara) {
        const L = l.getLayout(d), b = L.bounds, pad = 2;
        l.textType = 'paragraph';
        l.boxW = Math.max(8, b.w + pad * 2); l.boxH = Math.max(8, b.h + pad * 2);
      } else if (l.textType === 'paragraph' && !toPara) {
        // soft line breaks become hard returns, hidden (overflow) lines are dropped like Photoshop does
        const L = l.getLayout(d);
        const breaks: number[] = [];
        let last = 0;
        for (const ln of L.lines) { if (ln.hidden) break; last = ln.end; if (!ln.hard && ln.end < l.length) breaks.push(ln.end); }
        if (last < l.length && L.lines.some(x => x.hidden)) l.deleteRange(last, l.length);
        for (const p of breaks.reverse()) {
          let q = p;
          while (q > 0 && l.text[q - 1] === ' ') q--;
          if (q < p) l.deleteRange(q, p);
          const st = l.styleAt(Math.max(0, q - 1));
          l.insertText(q, '\n', st);
          const pi = l.paraIndexAt(q);
          if (l.paras[pi + 1]) l.paras[pi + 1] = { ...l.paras[pi], indentFirst: 0 };
        }
        l.textType = 'point';
      }
      l.invalidate();
      const after = firstLineAnchor(d, l);
      l.x += before.x - after.x; l.y += before.y - after.y;
      l.invalidate();
    }
  }, 'type');
  d.pixelsChanged(null, null); d.layersChanged();
}

// ------------------------------------------------------------------ Warp Text dialog
async function warpText() {
  const ls = needType();
  const d = D();
  if (!ls || !d) return;
  const e = editing();
  const orig = ls.map(l => ({ ...l.warp }));
  const w: WarpSettings = { ...ls[0].warp };
  if (w.style === 'none') Object.assign(w, { horizontal: true, bend: 50, hDistort: 0, vDistort: 0 });
  const tx = e ? null : d.history.begin('Warp Text', 'type');
  const push = () => { for (const l of ls) { l.warp = { ...w }; l.invalidate(); } d.pixelsChanged(null, null); d.redrawOverlay(); };
  const styleSel = select<WarpStyle>(WARP_STYLES.map(s => ({ value: s.value, label: s.label })), w.style, v => { w.style = v; syncEnabled(); push(); }, { width: 180, title: 'Warp style' });
  const hor = h('input', { type: 'radio', name: 'tp-warp-dir', checked: w.horizontal }) as HTMLInputElement;
  const ver = h('input', { type: 'radio', name: 'tp-warp-dir', checked: !w.horizontal }) as HTMLInputElement;
  hor.addEventListener('change', () => { w.horizontal = true; push(); });
  ver.addEventListener('change', () => { w.horizontal = false; push(); });
  const bend = sliderRow('Bend:', w.bend, -100, 100, v => { w.bend = v; push(); }, { unit: '%', center: 0 });
  const hd = sliderRow('Horizontal Distortion:', w.hDistort, -100, 100, v => { w.hDistort = v; push(); }, { unit: '%', center: 0 });
  const vd = sliderRow('Vertical Distortion:', w.vDistort, -100, 100, v => { w.vDistort = v; push(); }, { unit: '%', center: 0 });
  const dirRow = h('div.form-row.tpc-dir', null, h('label.checkbox-radio', null, hor, ' Horizontal'), h('label.checkbox-radio', null, ver, ' Vertical'));
  const syncEnabled = () => { for (const x of [dirRow, bend, hd, vd]) x.classList.toggle('disabled', w.style === 'none'); };
  syncEnabled();
  const body = h('div.tpc-warp', null, h('div.form-row', null, h('label.form-label', null, 'Style:'), styleSel), dirRow, bend, hd, vd);
  push();
  const ok = await openDialog({ title: 'Warp Text', body, layout: 'side', width: 470 }).result;
  if (ok) { if (tx) tx.commit('Warp Text'); else if (e) applyToText('Warp Text', {}); }
  else { ls.forEach((l, i) => { l.warp = orig[i]; l.invalidate(); }); if (tx) tx.cancel(); d.pixelsChanged(null, null); }
  d.redrawOverlay();
}

// ------------------------------------------------------------------ Find and Replace
interface FindOpts { all: boolean; forward: boolean; caseSens: boolean; whole: boolean }
function matchesIn(text: string, q: string, o: FindOpts): [number, number][] {
  if (!q) return [];
  const esc = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(o.whole ? `(?<![\\p{L}\\p{N}_])${esc}(?![\\p{L}\\p{N}_])` : esc, 'gu' + (o.caseSens ? '' : 'i'));
  const out: [number, number][] = [];
  for (const m of text.matchAll(re)) out.push([m.index!, m.index! + m[0].length]);
  return out;
}
function searchLayers(doc: PixDocument, o: FindOpts): TextLayer[] {
  const all = doc.allLayers().filter(l => l instanceof TextLayer && !l.locks.all) as TextLayer[];
  if (o.all) return all.reverse();                        // top of the stack first, like the Layers panel
  const a = doc.activeLayer;
  return a instanceof TextLayer ? [a] : [];
}
function findNext(doc: PixDocument, q: string, o: FindOpts): boolean {
  const layers = searchLayers(doc, o);
  if (!layers.length) return false;
  const e = editing(), cur = e ? layers.indexOf(e.layer) : -1, rng = editingRange();
  const n = layers.length;
  for (let step = 0; step <= n; step++) {
    const li = o.forward ? (Math.max(cur, 0) + step) % n : ((cur < 0 ? 0 : cur) - step + n * 2) % n;
    const l = layers[li], ms = matchesIn(l.text, q, o);
    let hit: [number, number] | undefined;
    if (li === cur && step === 0 && rng) hit = o.forward ? ms.find(m => m[0] >= rng[1]) : [...ms].reverse().find(m => m[1] <= rng[0]);
    else if (li === cur && step === n && rng) hit = o.forward ? ms.find(m => m[0] < rng[0]) : [...ms].reverse().find(m => m[1] > rng[1]);
    else if (step > 0 || cur < 0) hit = o.forward ? ms[0] : ms[ms.length - 1];
    if (hit) { editRange(doc, l, hit[0], hit[1]); return true; }
  }
  return false;
}
function findReplace() {
  const d = D();
  if (!d) return;
  const o: FindOpts = { all: true, forward: true, caseSens: false, whole: false };
  const fi = h('input.field', { type: 'text', style: { width: '240px' } }) as HTMLInputElement;
  const ci = h('input.field', { type: 'text', style: { width: '240px' } }) as HTMLInputElement;
  for (const x of [fi, ci]) x.addEventListener('keydown', ev => ev.stopPropagation());
  const sel = editingRange(), e = editing();
  if (e && sel && sel[1] > sel[0]) fi.value = e.layer.text.slice(sel[0], sel[1]);
  const body = h('div.form.tpc-find', null,
    h('div.form-row', null, h('label.form-label', null, 'Find What:'), fi),
    h('div.form-row', null, h('label.form-label', null, 'Change To:'), ci),
    h('div.tpc-checks', null,
      checkbox('Search All Layers', o.all, v => { o.all = v; }), checkbox('Forward', o.forward, v => { o.forward = v; }),
      checkbox('Case Sensitive', o.caseSens, v => { o.caseSens = v; }), checkbox('Whole Word Only', o.whole, v => { o.whole = v; })));
  const notFound = () => toast('Search complete. No matches were found.', 'info');
  const selMatches = () => { const r = editingRange(), ed = editing(); if (!r || !ed || r[1] <= r[0]) return false; return matchesIn(ed.layer.text.slice(r[0], r[1]), fi.value, { ...o, whole: false }).some(m => m[0] === 0 && m[1] === r[1] - r[0]); };
  openDialog({
    title: 'Find and Replace Text', body, layout: 'side', width: 520,
    buttons: [
      { label: 'Find Next', primary: true, onClick: () => { if (!findNext(d, fi.value, o)) notFound(); return false; } },
      { label: 'Change', onClick: () => { if (selMatches()) replaceSelection(ci.value); else if (!findNext(d, fi.value, o)) notFound(); return false; } },
      { label: 'Change All', onClick: () => {
        if (editing()) end(true);
        let count = 0;
        const layers = searchLayers(d, o);
        if (!layers.some(l => matchesIn(l.text, fi.value, o).length)) { notFound(); return false; }
        d.history.transaction('Replace All Text', () => {
          for (const l of layers) {
            const ms = matchesIn(l.text, fi.value, o);
            for (const [a, b] of ms.reverse()) { const st = l.styleAt(a); l.deleteRange(a, b); if (ci.value) l.insertText(a, ci.value, st); count++; }
            if (ms.length) { l.syncName(); l.invalidate(); }
          }
        }, 'type');
        toast(`Search complete. ${count} replacement${count === 1 ? '' : 's'} made.`, 'success');
        d.pixelsChanged(null, null); d.layersChanged();
        return false;
      } },
      { label: 'Change/Find', onClick: () => { if (selMatches()) replaceSelection(ci.value); if (!findNext(d, fi.value, o)) notFound(); return false; } },
      { label: 'Done', value: null },
    ],
  });
}

// ------------------------------------------------------------------ Check Spelling (browser spell checker)
/** Replace the layer text with `next`, keeping character styles around the changed span. */
function setTextKeepStyles(l: TextLayer, next: string) {
  const cur = l.text;
  if (cur === next) return false;
  let a = 0;
  while (a < cur.length && a < next.length && cur[a] === next[a]) a++;
  let b = 0;
  while (b < cur.length - a && b < next.length - a && cur[cur.length - 1 - b] === next[next.length - 1 - b]) b++;
  const st = l.styleAt(Math.max(0, Math.min(a, cur.length - 1)));
  if (cur.length - b > a) l.deleteRange(a, cur.length - b);
  const ins = next.slice(a, next.length - b);
  if (ins) l.insertText(a, ins, st);
  return true;
}
async function checkSpelling() {
  const d = D();
  if (!d) return;
  if (editing()) end(true);
  const layers = (d.allLayers().filter(l => l instanceof TextLayer && !l.locks.all) as TextLayer[]).reverse();
  if (!layers.length) { toast('There are no type layers to check.', 'info'); return; }
  const LANG: Record<string, string> = { 'English: USA': 'en-US', 'English: UK': 'en-GB', 'English: Canadian': 'en-CA', French: 'fr', German: 'de', Spanish: 'es', Italian: 'it', Portuguese: 'pt', Dutch: 'nl', Swedish: 'sv', Norwegian: 'no', Danish: 'da', Finnish: 'fi', Polish: 'pl', Russian: 'ru', Turkish: 'tr', Greek: 'el', Japanese: 'ja', Chinese: 'zh', Korean: 'ko', Arabic: 'ar', Hebrew: 'he' };
  const areas = layers.map(l => {
    const ta = h('textarea.field.tpc-spell', { spellcheck: true, lang: LANG[l.styleAt(0).language] || 'en', rows: Math.min(6, Math.max(2, l.text.split('\n').length)) }) as HTMLTextAreaElement;
    ta.value = l.text;
    ta.addEventListener('keydown', ev => ev.stopPropagation());
    return ta;
  });
  const body = h('div.tpc-spellbox', null,
    h('div.tpc-hint', null, 'Misspelled words are underlined. Right-click a word for suggestions, or edit the text directly.'),
    ...layers.map((l, i) => h('div.tpc-spellrow', null, h('div.tpc-spellname', null, l.name), areas[i])));
  setTimeout(() => areas[0]?.focus());
  const ok = await openDialog({ title: 'Check Spelling', body, layout: 'side', width: 600, buttons: [{ label: 'Done', primary: true, value: true }, { label: 'Cancel', value: null }] }).result;
  if (!ok) return;
  let changed = 0;
  if (layers.every((l, i) => l.text === areas[i].value)) { toast('The spelling check is complete.', 'success'); return; }
  d.history.transaction('Check Spelling', () => { layers.forEach((l, i) => { if (setTextKeepStyles(l, areas[i].value)) { changed++; l.syncName(); l.invalidate(); } }); }, 'type');
  d.pixelsChanged(null, null); d.layersChanged();
  toast(changed ? `Spelling check complete. ${changed} layer${changed === 1 ? '' : 's'} changed.` : 'The spelling check is complete.', 'success');
}

// ------------------------------------------------------------------ Match Font (shape features of the selected text)
interface Feat { stroke: number; density: number; slant: number; aspect: number; contrast: number }
function features(img: ImageData): Feat | null {
  const { width: W, height: H, data } = img;
  const lum = new Float32Array(W * H);
  const hist = new Array(256).fill(0);
  for (let i = 0; i < W * H; i++) { const v = (data[i * 4] * 0.299 + data[i * 4 + 1] * 0.587 + data[i * 4 + 2] * 0.114) * (data[i * 4 + 3] / 255) + 255 * (1 - data[i * 4 + 3] / 255); lum[i] = v; hist[v | 0]++; }
  // Otsu threshold, ink = the minority class
  let sum = 0; for (let i = 0; i < 256; i++) sum += i * hist[i];
  let wB = 0, sB = 0, best = 0, th = 128;
  for (let t = 0; t < 256; t++) { wB += hist[t]; if (!wB) continue; const wF = W * H - wB; if (!wF) break; sB += t * hist[t]; const mB = sB / wB, mF = (sum - sB) / wF, v = wB * wF * (mB - mF) ** 2; if (v > best) { best = v; th = t; } }
  const dark = lum.reduce((n, v) => n + (v < th ? 1 : 0), 0);
  const inkDark = dark <= W * H / 2;
  const ink = new Uint8Array(W * H);
  let area = 0, x0 = W, x1 = -1, y0 = H, y1 = -1;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const i = y * W + x; if ((lum[i] < th) === inkDark) { ink[i] = 1; area++; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; } }
  if (area < 20 || x1 < x0) return null;
  let perim = 0;
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) { const i = y * W + x; if (!ink[i]) continue; if (!ink[i - 1] || !ink[i + 1] || !ink[i - W] || !ink[i + W]) perim++; }
  // x-height ~ height of the dense band of the row profile
  const rows = new Array(y1 - y0 + 1).fill(0);
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) rows[y - y0] += ink[y * W + x];
  const maxRow = Math.max(...rows), band = rows.filter(r => r > maxRow * 0.35).length || (y1 - y0 + 1);
  const stroke = (2 * area) / Math.max(1, perim);
  // stroke contrast: spread of horizontal vs vertical run lengths
  let hr = 0, hn = 0, vr = 0, vn = 0;
  for (let y = y0; y <= y1; y++) { let run = 0; for (let x = x0; x <= x1 + 1; x++) { if (x <= x1 && ink[y * W + x]) run++; else if (run) { hr += run; hn++; run = 0; } } }
  for (let x = x0; x <= x1; x++) { let run = 0; for (let y = y0; y <= y1 + 1; y++) { if (y <= y1 && ink[y * W + x]) run++; else if (run) { vr += run; vn++; run = 0; } } }
  // slant: shear maximizing the column-profile energy
  let bestS = 0, bestE = -1;
  for (let s = -0.4; s <= 0.41; s += 0.05) {
    const cols = new Float32Array(W + H);
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) if (ink[y * W + x]) { const c = Math.round(x + (y - y1) * s) + H; if (c >= 0 && c < cols.length) cols[c]++; }
    let e = 0; for (const c of cols) e += c * c;
    if (e > bestE) { bestE = e; bestS = s; }
  }
  return { stroke: stroke / band, density: area / ((x1 - x0 + 1) * (y1 - y0 + 1)), slant: bestS, aspect: (hr / Math.max(1, hn)) / Math.max(1, vr / Math.max(1, vn)), contrast: band / (y1 - y0 + 1) };
}
function fontFeatures(font: string, italic: boolean): Feat | null {
  const c = createCanvas(900, 140), x = c.getContext('2d', { willReadFrequently: true })!;
  x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height);
  x.fillStyle = '#000'; x.font = `${italic ? 'italic ' : ''}72px ${GENERIC.includes(font) ? font : familyCss(font)}, sans-serif`;
  x.fillText('Hamburgefonstiv', 10, 100);
  return features(x.getImageData(0, 0, c.width, c.height));
}
const featCache = new Map<string, Feat | null>();
async function matchFont() {
  const d = D();
  if (!d) return;
  if (d.selection.empty) { toast('Make a rectangular selection around the text in the image, then choose Match Font.', 'info', 4500); return; }
  const b = d.selection.bounds!;
  const bx = Math.max(0, b.x | 0), by = Math.max(0, b.y | 0), bw = Math.max(1, Math.min(d.width - bx, b.w) | 0), bh = Math.max(1, Math.min(d.height - by, b.h) | 0);
  const reg = createCanvas(bw, bh), rx = reg.getContext('2d', { willReadFrequently: true })!;
  rx.drawImage(d.getComposite(), -bx, -by);
  const img = rx.getImageData(0, 0, bw, bh);
  toast('Analyzing fonts…', 'info', 1200);
  await new Promise(r => setTimeout(r, 30));
  const f = features(img);
  if (!f) { toast('No text could be detected in the selection.', 'error'); return; }
  const scored: { font: string; italic: boolean; score: number }[] = [];
  for (const font of fontFamilies()) for (const italic of [false, true]) {
    const k = font + (italic ? '/i' : '');
    if (!featCache.has(k)) featCache.set(k, fontFeatures(font, italic));
    const g = featCache.get(k);
    if (!g) continue;
    const score = Math.abs(Math.log(f.stroke / g.stroke)) * 2 + Math.abs(f.density - g.density) * 3 + Math.abs(f.slant - g.slant) * 4 + Math.abs(Math.log(f.aspect / g.aspect)) + Math.abs(f.contrast - g.contrast) * 2;
    scored.push({ font, italic, score });
  }
  scored.sort((a, b2) => a.score - b2.score);
  const top = scored.filter((s, i) => scored.findIndex(o => o.font === s.font) === i).slice(0, 12);
  let pick = top[0];
  const list = h('div.list.tpc-matches');
  const rows = top.map(t => {
    const r = h('div.tpc-match', { title: t.font }, h('span.tpc-mname', null, t.font + (t.italic ? ' Italic' : '')),
      h('span.tpc-mprev', { style: { fontFamily: `${GENERIC.includes(t.font) ? t.font : familyCss(t.font)}, sans-serif`, fontStyle: t.italic ? 'italic' : '' } }, 'Hamburgefonstiv'));
    r.addEventListener('click', () => { pick = t; rows.forEach(x => x.classList.toggle('selected', x === r)); });
    r.addEventListener('dblclick', () => { pick = t; dlg.close(true); });
    list.append(r);
    return r;
  });
  rows[0]?.classList.add('selected');
  const prev = createCanvas(img.width, img.height); ctx2d(prev).putImageData(img, 0, 0);
  prev.className = 'tpc-mimg';
  const dlg = openDialog({ title: 'Match Font', body: h('div.tpc-match-body', null, h('div.tpc-hint', null, 'Fonts similar to the selected text:'), prev, list), layout: 'side', width: 560 });
  if (!(await dlg.result) || !pick) return;
  setChar({ font: pick.font, fontStyle: pick.italic ? 'Italic' : 'Regular' }, 'Change Font');
  toast(`Font set to ${pick.font}`, 'success');
}

// ------------------------------------------------------------------ Lorem ipsum
const LOREM = 'Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat. Duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur. Excepteur sint occaecat cupidatat non proident, sunt in culpa qui officia deserunt mollit anim id est laborum. ';
function loremIpsum() {
  const e = editing();
  if (!e) { toast('Click in text with the Type tool to paste Lorem Ipsum.', 'info'); return; }
  if (e.layer.textType !== 'paragraph') { insertAtCaret(LOREM.trim()); return; }
  // fill the paragraph box: add words until it overflows, then drop the last one
  const words = LOREM.trim().split(' ');
  let i = 0, guard = 0;
  while (guard++ < 2000) {
    const w = words[i % words.length] + ' ';
    insertAtCaret(w);
    if (e.layer.getLayout(e.doc).overflow) {
      const len = e.layer.length, c = e.caret;
      e.layer.deleteRange(c - w.length, c);
      e.caret = e.anchor = Math.min(len, c - w.length);
      insertAtCaret('');
      break;
    }
    i++;
  }
}

registerCommands([
  { id: 'type.moreFonts', label: 'More Fonts...', run: async () => { const n = await loadLocalFonts(); if (n) toast(`${n} local font families are now available.`, 'success'); } },
  { id: 'type.antialias', label: 'Anti-Alias', run: (a: AntiAlias) => { typeSettings.antiAlias = a; if (hasType()) layerEdit('Anti Alias', l => { l.antiAlias = a; }); else events.emit('toolOptions'); },
    checked: (a?: AntiAlias) => (typeLayers()[0]?.antiAlias ?? typeSettings.antiAlias) === a },
  { id: 'type.orientation', label: 'Orientation', enabled: hasType, run: (o: 'horizontal' | 'vertical') => layerEdit('Change Text Orientation', l => { l.orientation = o; }),
    checked: (o?: string) => typeLayers()[0]?.orientation === o },
  { id: 'type.createWorkPath', label: 'Create Work Path', enabled: hasType, run: createWorkPath },
  { id: 'type.convertToShape', label: 'Convert to Shape', enabled: hasType, run: convertToShape },
  { id: 'type.convertParagraph', label: 'Convert to Paragraph Text', enabled: hasType, run: convertParagraph },
  { id: 'type.warp', label: 'Warp Text...', enabled: hasType, run: warpText },
  { id: 'type.matchFont', label: 'Match Font...', enabled: () => !!D(), run: matchFont },
  { id: 'type.previewSize', label: 'Font Preview Size', run: (p: PreviewSize) => setPreviewSize(p), checked: (p?: string) => fontPrefs.preview === p },
  { id: 'type.updateAll', label: 'Update All Text Layers', enabled: () => !!D(), run: () => {
    const d = D()!; clearMeasureCache();
    for (const l of d.allLayers()) if (l instanceof TextLayer) l.invalidate();
    d.pixelsChanged(null, null); d.layersChanged();
  } },
  { id: 'type.loremIpsum', label: 'Paste Lorem Ipsum', enabled: () => !!editing(), run: loremIpsum },
  { id: 'type.checkSpelling', label: 'Check Spelling...', enabled: () => !!D(), run: checkSpelling },
  { id: 'type.findReplace', label: 'Find and Replace Text...', enabled: () => !!D(), run: findReplace },
]);

// fonts loaded late (web fonts / local fonts) change metrics: refresh type layers once they are ready
if ((document as any).fonts?.addEventListener) (document as any).fonts.addEventListener('loadingdone', () => { clearMeasureCache(); const d = D(); if (d) { for (const l of d.allLayers()) if (l instanceof TextLayer) l.invalidate(); d.invalidate(); } });

(window as any).__pxType = { textOutlines, findNext, matchesIn, setTextKeepStyles, features };
