// History Brush (Y) — paints pixels of the history source snapshot back into the image;
// Art History Brush (Y) — stylized strokes coloured from the history source.
import { app } from '../../core/app';
import type { PixDocument, PaintTarget } from '../../core/document';
import type { Dab } from '../../core/brush';
import { ctx2d } from '../../core/canvas';
import { h } from '../../ui/dom';
import { numberField, select } from '../../ui/widgets';
import { toast } from '../../ui/toast';
import { createPaintTool, optAngle, optBrush, optCtx, optMode, optPercent, optSmoothing, optSymmetry, optToggle, finishOptions, paintDefaults, scratchCanvas } from './common';
import { separator } from '../../ui/widgets';

export interface SourceImage { canvas: HTMLCanvasElement; x: number; y: number }

/** Pixels of the active layer in the history source (snapshot `brushSource`). Shows PS's messages on failure. */
export function historySource(doc: PixDocument, target: PaintTarget, toolName: string): SourceImage | null {
  const hist = doc.history as any;
  const snaps = doc.history.snapshots;
  const snap = snaps[hist.brushSource ?? 0] || snaps[0];
  if (!snap) { toast(`Could not use the ${toolName} because there is no history source.`, 'error'); return null; }
  if (snap.state.width !== doc.width || snap.state.height !== doc.height) {
    toast(`Could not use the ${toolName} because the history state does not contain a corresponding layer (the canvas size changed).`, 'error', 4000);
    return null;
  }
  if (target.kind !== 'pixels') { toast(`Could not use the ${toolName} because the target is a mask. Select the layer's pixels.`, 'error', 3600); return null; }
  const id = target.layer!.id;
  const find = (nodes: any[]): any => { for (const n of nodes) { if (n.layer.id === id) return n; if (n.children) { const r = find(n.children); if (r) return r; } } return null; };
  const node = find(snap.state.tree);
  if (!node || !(node.state.canvas instanceof HTMLCanvasElement)) {
    toast(`Could not use the ${toolName} because the history state does not contain a corresponding layer.`, 'error', 4000);
    return null;
  }
  return { canvas: node.state.canvas, x: node.state.x || 0, y: node.state.y || 0 };
}

// ------------------------------------------------------------------ History Brush
let scratch: HTMLCanvasElement | null = null;
createPaintTool({
  id: 'history-brush', name: 'History Brush Tool', group: 'history-brush', icon: 'history-brush', shortcut: 'Y', order: 0,
  settings: paintDefaults({ size: 45, hardness: 0, tipId: 'soft-round' }),
  historyName: 'History Brush',
  setup: (doc, target) => {
    const src = historySource(doc, target, 'History Brush');
    if (!src) return null;
    return {
      content: (_d, box) => {
        scratch = scratchCanvas(scratch, box.w, box.h);
        ctx2d(scratch).drawImage(src.canvas, src.x - box.x, src.y - box.y);
        return scratch;
      },
    };
  },
});

// ------------------------------------------------------------------ Art History Brush
type ArtStyle = 'tight-short' | 'tight-medium' | 'tight-long' | 'loose-medium' | 'loose-long' | 'dab' | 'tight-curl' | 'tight-curl-long' | 'loose-curl' | 'loose-curl-long';
const STYLES: { value: ArtStyle; label: string }[] = [
  { value: 'tight-short', label: 'Tight Short' }, { value: 'tight-medium', label: 'Tight Medium' }, { value: 'tight-long', label: 'Tight Long' },
  { value: 'loose-medium', label: 'Loose Medium' }, { value: 'loose-long', label: 'Loose Long' }, { value: 'dab', label: 'Dab' },
  { value: 'tight-curl', label: 'Tight Curl' }, { value: 'tight-curl-long', label: 'Tight Curl Long' }, { value: 'loose-curl', label: 'Loose Curl' }, { value: 'loose-curl-long', label: 'Loose Curl Long' },
];
const dataCache = new WeakMap<HTMLCanvasElement, ImageData>();
const readAll = (c: HTMLCanvasElement) => { let d = dataCache.get(c); if (!d) { d = ctx2d(c).getImageData(0, 0, c.width, c.height); dataCache.set(c, d); } return d; };

const artSettings = paintDefaults({ size: 10, hardness: 1, tipId: 'hard-round', style: 'tight-short' as ArtStyle, area: 50, tolerance: 0, spacing: 1 });
createPaintTool({
  id: 'art-history-brush', name: 'Art History Brush Tool', group: 'history-brush', icon: 'art-history-brush', shortcut: 'Y', order: 1,
  settings: artSettings,
  historyName: 'Art History Brush',
  options(bar, tool) {
    const c = optCtx(tool);
    const style = select<ArtStyle>(STYLES, c.s.style, v => { c.s.style = v; c.save(); }, { width: 120, title: 'Set the paint style' });
    const area = numberField(c.s.area, v => { c.s.area = v; c.save(); }, { min: 0, max: 500, unit: 'px', width: 56, label: 'Area:', title: 'Set the diameter of the area covered by strokes' });
    const tol = numberField(c.s.tolerance, v => { c.s.tolerance = v; c.save(); }, { min: 0, max: 100, unit: '%', width: 48, label: 'Tolerance:', title: 'Limit painting to areas that differ from the source' });
    c.syncs.push(() => { style.setValue(c.s.style); area.setValue(c.s.area); tol.setValue(c.s.tolerance); });
    bar.append(...optBrush(c), separator(), ...optMode(c), separator(), optPercent(c, 'opacity', 'Opacity', 'Set the opacity for strokes'),
      optToggle(c, 'pressureOpacity', 'pressure-opacity', 'Always use Pressure for Opacity'), separator(),
      h('span.opt-label', null, 'Style:'), style, separator(), area, separator(), tol, separator(), optAngle(c), separator(),
      optToggle(c, 'pressureSize', 'pressure-size', 'Always use Pressure for Size'), optSymmetry());
    void optSmoothing;
    return finishOptions(c);
  },
  setup: (doc, target, _p, s) => {
    const src = historySource(doc, target, 'Art History Brush');
    if (!src) return null;
    const sd = readAll(src.canvas);
    const cur = s.tolerance > 0 ? ctx2d(target.holder.canvas).getImageData(0, 0, target.holder.canvas.width, target.holder.canvas.height) : null;
    const hx = target.holder.x, hy = target.holder.y;
    const st = s.style as ArtStyle;
    const tight = st.startsWith('tight') || st === 'dab';
    const len = st === 'dab' ? 0.2 : st.includes('long') ? 5 : st.includes('medium') ? 3 : st.includes('curl') ? 3 : 1.6;
    const curl = st.includes('curl') ? (tight ? 0.5 : 0.8) : 0;
    const tol = (s.tolerance / 100) * 255 * 3;
    const srcAt = (x: number, y: number) => {
      const lx = Math.floor(x - src.x), ly = Math.floor(y - src.y);
      if (lx < 0 || ly < 0 || lx >= sd.width || ly >= sd.height) return null;
      const i = (ly * sd.width + lx) * 4;
      return sd.data[i + 3] < 8 ? null : [sd.data[i], sd.data[i + 1], sd.data[i + 2], sd.data[i + 3]];
    };
    const differs = (x: number, y: number, c: number[]) => {
      if (!cur) return true;
      const lx = Math.floor(x - hx), ly = Math.floor(y - hy);
      if (lx < 0 || ly < 0 || lx >= cur.width || ly >= cur.height) return true;
      const i = (ly * cur.width + lx) * 4;
      return Math.abs(cur.data[i] - c[0]) + Math.abs(cur.data[i + 1] - c[1]) + Math.abs(cur.data[i + 2] - c[2]) > tol;
    };
    return {
      spacing: Math.max(0.6, s.spacing),
      airbrush: true,
      // enlarge the dab's dirty box so strokes reaching outside the tip are composited (real width kept in `bw`)
      transformDab: (d: Dab) => { const bw0 = d.size; return { ...d, bw0, size: Math.ceil(Math.max(d.size, s.area) + 2 * (len + 1) * d.size) } as Dab; },
      renderDab: (bx: CanvasRenderingContext2D, d: Dab, _tip: HTMLCanvasElement, off: { x: number; y: number }) => {
        const size = (d as any).bw0 as number;
        const area = Math.max(size, s.area);
        const n = Math.max(2, Math.min(14, Math.round((area / Math.max(2, size)) * 1.5)));
        const bw = Math.max(1, size * (tight ? 0.5 : 0.8));
        bx.save();
        bx.lineCap = 'round'; bx.lineJoin = 'round';
        for (let i = 0; i < n; i++) {
          const a = Math.random() * Math.PI * 2, r = Math.sqrt(Math.random()) * area / 2;
          let x = d.x + Math.cos(a) * r, y = d.y + Math.sin(a) * r;
          const c = srcAt(x, y);
          if (!c || !differs(x, y, c)) continue;
          let dir = Math.random() * Math.PI * 2;
          const steps = Math.max(1, Math.round((len * size) / Math.max(1, bw)));
          const turn = (Math.random() < 0.5 ? -1 : 1) * curl;
          bx.globalAlpha = Math.max(0.05, Math.min(1, d.flow * (c[3] / 255)));
          bx.strokeStyle = `rgb(${c[0]},${c[1]},${c[2]})`;
          bx.lineWidth = bw * (0.7 + Math.random() * 0.6);
          bx.beginPath(); bx.moveTo(x - off.x, y - off.y);
          if (st === 'dab') bx.lineTo(x - off.x + 0.1, y - off.y);
          for (let k = 0; k < steps; k++) {
            dir += curl ? turn : (Math.random() - 0.5) * (tight ? 0.25 : 0.7);
            x += Math.cos(dir) * bw; y += Math.sin(dir) * bw;
            bx.lineTo(x - off.x, y - off.y);
          }
          bx.stroke();
        }
        bx.restore();
      },
      noDynamics: true,
    };
  },
});

void app;
