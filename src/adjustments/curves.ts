// Curves: per-channel monotone-cubic curves with an interactive 256×256 editor (histogram behind,
// click to add, drag, drag off to delete), input/output fields, presets, Auto, eyedroppers.
import { h, dragPointer } from '../ui/dom';
import { button, numberField, toggleButton } from '../ui/widgets';
import { defineAdjustment, curveLUT, composeLUT, lutKernel, clamp, histogram, clipPoints, type Hist } from './lib';
import { channelSelect, dropperButton, histScale } from './ui';

type Pts = number[][];
interface CurvesP { rgb: Pts; r: Pts; g: Pts; b: Pts; _channel?: string }
const line = (): Pts => [[0, 0], [255, 255]];
const setRGB = (pts: Pts) => (p: CurvesP) => { p.rgb = pts; };

defineAdjustment<CurvesP>({
  type: 'curves', label: 'Curves', icon: 'adj-curves', dialogWidth: 470,
  defaults: () => ({ rgb: line(), r: line(), g: line(), b: line() }),
  presets: [
    ['Default', () => {}],
    ['Color Negative (RGB)', p => { p.r = [[0, 255], [210, 0]]; p.g = [[0, 255], [165, 0]]; p.b = [[0, 255], [120, 0]]; }],
    ['Cross Process (RGB)', p => { p.r = [[0, 0], [64, 48], [192, 222], [255, 255]]; p.g = [[0, 0], [64, 58], [192, 212], [255, 255]]; p.b = [[0, 36], [255, 214]]; }],
    ['Darker (RGB)', setRGB([[0, 0], [128, 100], [255, 255]])],
    ['Increase Contrast (RGB)', setRGB([[0, 0], [64, 54], [192, 202], [255, 255]])],
    ['Lighter (RGB)', setRGB([[0, 0], [118, 146], [255, 255]])],
    ['Linear Contrast (RGB)', setRGB([[0, 0], [63, 51], [191, 203], [255, 255]])],
    ['Medium Contrast (RGB)', setRGB([[0, 0], [64, 47], [192, 208], [255, 255]])],
    ['Negative (RGB)', setRGB([[0, 255], [255, 0]])],
    ['Strong Contrast (RGB)', setRGB([[0, 0], [64, 37], [192, 218], [255, 255]])],
  ],
  compile(p) {
    const m = curveLUT(p.rgb);
    return lutKernel(composeLUT(curveLUT(p.r), m), composeLUT(curveLUT(p.g), m), composeLUT(curveLUT(p.b), m));
  },
  build(el, p, change, env) {
    const ch = (): 'rgb' | 'r' | 'g' | 'b' => (p._channel as any) || 'rgb';
    const pts = () => p[ch()];
    let selIdx = -1;
    let fine = false; // 10×10 grid (Alt+click)
    const S = 256, PAD = 6;
    const cv = h('canvas.adj-curve', { width: (S + PAD * 2) * 2, height: (S + PAD * 2) * 2, tabIndex: 0, title: 'Click to add a point, drag to adjust, drag off the graph to delete. Alt+click toggles grid size.' }) as HTMLCanvasElement;
    cv.style.width = cv.style.height = S + PAD * 2 + 'px';
    let hist: Hist | null = null;
    const off = env.onInvalidate(() => { hist = null; draw(); });
    const fIn = numberField(0, v => setSel(v, null), { min: 0, max: 255, width: 48, title: 'Input value of the selected point' });
    const fOut = numberField(0, v => setSel(null, v), { min: 0, max: 255, width: 48, title: 'Output value of the selected point' });
    function setSel(x: number | null, y: number | null) {
      const a = pts();
      if (selIdx < 0 || !a[selIdx]) return;
      const lo = selIdx > 0 ? a[selIdx - 1][0] + 1 : 0, hi = selIdx < a.length - 1 ? a[selIdx + 1][0] - 1 : 255;
      if (x !== null) a[selIdx][0] = clamp(Math.round(x), lo, hi);
      if (y !== null) a[selIdx][1] = clamp(Math.round(y));
      draw(); change(true);
    }
    const color = { rgb: '#e8e8e8', r: '#ff4d4d', g: '#3fd13f', b: '#4d8dff' };
    function draw() {
      const x = cv.getContext('2d')!;
      const k = 2, W = S * k, o = PAD * k;
      x.setTransform(1, 0, 0, 1, 0, 0);
      x.clearRect(0, 0, cv.width, cv.height);
      x.translate(o, o);
      const cs = getComputedStyle(cv);
      x.fillStyle = cs.getPropertyValue('--adj-graph-bg').trim() || '#3b3b3b';
      x.fillRect(0, 0, W, W);
      // histogram
      if (!hist) { const img = env.stats(); hist = img ? histogram(img) : null; }
      if (hist && hist.n) {
        const c = ch(), arr = new Float64Array(256);
        for (let i = 0; i < 256; i++) arr[i] = c === 'r' ? hist.r[i] : c === 'g' ? hist.g[i] : c === 'b' ? hist.b[i] : hist.l[i];
        const max = histScale(arr);
        x.fillStyle = cs.getPropertyValue('--adj-graph-hist').trim() || 'rgba(255,255,255,.16)';
        x.beginPath(); x.moveTo(0, W);
        for (let i = 0; i < 256; i++) { const y = W - Math.min(1, arr[i] / max) * W * 0.95; x.lineTo(i * k, y); x.lineTo((i + 1) * k, y); }
        x.lineTo(W, W); x.closePath(); x.fill();
      }
      // grid
      x.strokeStyle = cs.getPropertyValue('--adj-graph-grid').trim() || 'rgba(255,255,255,.14)';
      x.lineWidth = 1;
      const n = fine ? 10 : 4;
      x.beginPath();
      for (let i = 1; i < n; i++) { const t = Math.round((i / n) * W) + 0.5; x.moveTo(t, 0); x.lineTo(t, W); x.moveTo(0, t); x.lineTo(W, t); }
      x.stroke();
      x.strokeRect(0.5, 0.5, W - 1, W - 1);
      // baseline
      x.setLineDash([4, 4]);
      x.beginPath(); x.moveTo(0, W); x.lineTo(W, 0); x.stroke();
      x.setLineDash([]);
      // other channel curves (faint) when on RGB
      const drawCurve = (a: Pts, style: string, width: number) => {
        const l = curveLUT(a);
        x.strokeStyle = style; x.lineWidth = width;
        x.beginPath();
        for (let i = 0; i < 256; i++) { const y = W - (l[i] / 255) * W; if (i) x.lineTo(i * k, y); else x.moveTo(0, y); }
        x.stroke();
      };
      if (ch() === 'rgb') for (const c of ['r', 'g', 'b'] as const) if (p[c].length > 2 || p[c][0][0] || p[c][0][1] || p[c][1][0] !== 255 || p[c][1][1] !== 255) drawCurve(p[c], color[c] + '88', 1.5);
      drawCurve(pts(), color[ch()], 2.5);
      // points
      pts().forEach((pt, i) => {
        const px = pt[0] * k, py = W - pt[1] * k, r = 5;
        x.fillStyle = i === selIdx ? '#fff' : cs.getPropertyValue('--adj-graph-bg').trim() || '#3b3b3b';
        x.strokeStyle = '#fff'; x.lineWidth = 1.5;
        x.fillRect(px - r, py - r, r * 2, r * 2); x.strokeRect(px - r, py - r, r * 2, r * 2);
      });
      const s = pts()[selIdx];
      fIn.setValue(s ? s[0] : 0); fOut.setValue(s ? s[1] : 0);
    }
    const toVal = (e: PointerEvent) => {
      const r = cv.getBoundingClientRect();
      return { x: ((e.clientX - r.left - PAD) / S) * 255, y: 255 - ((e.clientY - r.top - PAD) / S) * 255, out: e.clientX < r.left - 20 || e.clientX > r.right + 20 || e.clientY < r.top - 20 || e.clientY > r.bottom + 20 };
    };
    cv.addEventListener('pointerdown', e => {
      if (e.button !== 0) return;
      e.preventDefault(); cv.focus();
      if (e.altKey) { fine = !fine; draw(); return; }
      const v = toVal(e), a = pts();
      let i = a.findIndex(pt => Math.abs(pt[0] - v.x) <= 6 && Math.abs(pt[1] - v.y) <= 6);
      if (i < 0) {
        // add a point (on the curve when clicking near it)
        const xv = clamp(Math.round(v.x)), yCurve = curveLUT(a)[xv];
        if (a.some(pt => Math.abs(pt[0] - xv) < 2)) return;
        if (a.length >= 16) return;
        const yv = Math.abs(yCurve - v.y) < 12 ? yCurve : clamp(Math.round(v.y));
        a.push([xv, yv]); a.sort((m, n) => m[0] - n[0]);
        i = a.findIndex(pt => pt[0] === xv);
        change(false);
      }
      selIdx = i; draw();
      const pt = a[i];
      let removed = false;
      dragPointer(e, (_dx, _dy, ev) => {
        const w = toVal(ev), arr = pts();
        const idx = arr.indexOf(pt);
        if (w.out && arr.length > 2) { if (idx >= 0) { arr.splice(idx, 1); removed = true; selIdx = -1; draw(); change(false); } return; }
        if (removed) { arr.push(pt); arr.sort((m, n) => m[0] - n[0]); removed = false; }
        const j = arr.indexOf(pt);
        const lo = j > 0 ? arr[j - 1][0] + 1 : 0, hi = j < arr.length - 1 ? arr[j + 1][0] - 1 : 255;
        pt[0] = clamp(Math.round(w.x), lo, hi); pt[1] = clamp(Math.round(w.y));
        selIdx = j; draw(); change(false);
      }, () => change(true));
    });
    cv.addEventListener('keydown', e => {
      const a = pts();
      if (selIdx < 0) return;
      if ((e.key === 'Delete' || e.key === 'Backspace') && a.length > 2) { a.splice(selIdx, 1); selIdx = -1; draw(); change(true); e.preventDefault(); e.stopPropagation(); }
      const d = e.shiftKey ? 10 : 1;
      const mv: Record<string, [number, number]> = { ArrowLeft: [-d, 0], ArrowRight: [d, 0], ArrowUp: [0, d], ArrowDown: [0, -d] };
      if (mv[e.key]) { e.preventDefault(); e.stopPropagation(); setSel(a[selIdx][0] + mv[e.key][0], a[selIdx][1] + mv[e.key][1]); }
    });

    const sel = channelSelect(ch(), v => { p._channel = v; selIdx = -1; draw(); });
    const auto = button('Auto', () => {
      const img = env.stats();
      if (!img) return;
      const hs = histogram(img);
      for (const c of ['r', 'g', 'b'] as const) { const [lo, hi] = clipPoints(hs[c], 0.001, 0.001); p[c] = [[lo, 0], [hi, 255]]; }
      p.rgb = line();
      env.rebuild();
    }, { title: 'Auto: enhance per channel contrast', cls: 'small' });
    const setPoint = (k: 'r' | 'g' | 'b', xv: number, yv: number, where: 'first' | 'last' | 'mid') => {
      const a = p[k];
      xv = clamp(Math.round(xv));
      if (where === 'first') { a[0] = [Math.min(xv, a[1][0] - 1), yv]; return; }
      if (where === 'last') { a[a.length - 1] = [Math.max(xv, a[a.length - 2][0] + 1), yv]; return; }
      const i = a.findIndex(pt => Math.abs(pt[0] - xv) < 8 && pt !== a[0] && pt !== a[a.length - 1]);
      if (i >= 0) a[i] = [xv, yv]; else { a.push([xv, yv]); a.sort((m, n) => m[0] - n[0]); }
    };
    const droppers = h('div.adj-droppers', null,
      dropperButton('adj-dropper-black', 'Sample in image to set black point', env, c => { (['r', 'g', 'b'] as const).forEach(k => setPoint(k, Math.min(c[k], 250), 0, 'first')); env.rebuild(); }),
      dropperButton('adj-dropper-gray', 'Sample in image to set gray point', env, c => {
        const t = Math.round((c.r + c.g + c.b) / 3);
        (['r', 'g', 'b'] as const).forEach(k => { if (c[k] > 2 && c[k] < 253) setPoint(k, c[k], t, 'mid'); });
        env.rebuild();
      }),
      dropperButton('adj-dropper-white', 'Sample in image to set white point', env, c => { (['r', 'g', 'b'] as const).forEach(k => setPoint(k, Math.max(c[k], 5), 255, 'last')); env.rebuild(); }));
    const gridBtn = toggleButton('adj-grid', 'Show 10×10 grid (Alt+click the graph)', fine, v => { fine = v; draw(); });

    el.append(
      h('div.adj-toprow', null, h('span.adj-lbl', null, 'Channel:'), sel, auto),
      h('div.adj-curve-wrap', null,
        h('div.adj-curve-out'), cv,
      ),
      h('div.adj-curve-in'),
      h('div.adj-curve-fields', null, h('label', null, 'Input:', fIn), h('label', null, 'Output:', fOut), gridBtn),
      droppers,
    );
    draw();
    return () => off();
  },
});
