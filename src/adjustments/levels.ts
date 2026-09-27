// Levels: per-channel input black / gamma / white + output levels, histogram, triangles, eyedroppers, Auto.
import { h, dragPointer } from '../ui/dom';
import { button, numberField } from '../ui/widgets';
import {
  defineAdjustment, levelsKernel, levelsParamsDefault, autoContrast, clamp, levelsLUT,
  type LevelsParams, type LevelsCh,
} from './lib';
import { channelSelect, dropperButton, histogramView } from './ui';

const setAll = (p: LevelsParams, fn: (c: LevelsCh) => void) => fn(p.rgb);

defineAdjustment<LevelsParams>({
  type: 'levels', label: 'Levels', icon: 'adj-levels', dialogWidth: 520,
  defaults: levelsParamsDefault,
  presets: [
    ['Default', () => {}],
    ['Darker', p => setAll(p, c => { c.inBlack = 15; c.gamma = 0.8; })],
    ['Increase Contrast 1', p => setAll(p, c => { c.inBlack = 10; c.inWhite = 245; })],
    ['Increase Contrast 2', p => setAll(p, c => { c.inBlack = 20; c.inWhite = 235; })],
    ['Increase Contrast 3', p => setAll(p, c => { c.inBlack = 30; c.inWhite = 225; })],
    ['Lighten Shadows', p => setAll(p, c => { c.gamma = 1.6; c.outBlack = 10; })],
    ['Lighter', p => setAll(p, c => { c.inWhite = 230; c.gamma = 1.1; })],
    ['Midtones Brighter', p => setAll(p, c => { c.gamma = 1.25; })],
    ['Midtones Darker', p => setAll(p, c => { c.gamma = 0.8; })],
  ],
  compile: levelsKernel,
  build(el, p, change, env) {
    const ch = (): 'rgb' | 'r' | 'g' | 'b' => ((p as any)._channel as any) || 'rgb';
    const cur = () => p[ch()];
    const sel = channelSelect(ch(), v => { (p as any)._channel = v; hist.redraw(); sync(); });
    const auto = button('Auto', () => {
      const img = env.stats();
      if (!img) return;
      const q = autoContrast(img);
      for (const k of ['rgb', 'r', 'g', 'b'] as const) p[k] = q[k];
      env.rebuild();
    }, { title: 'Auto: Enhance Brightness and Contrast', cls: 'small' });

    // ---- input levels
    const hist = histogramView(env, 256, 120, ch);
    const inBar = h('div.adj-tri-bar.in');
    const tB = h('div.adj-tri.black', { title: 'Shadow input level' });
    const tG = h('div.adj-tri.gray', { title: 'Midtone input level (gamma)' });
    const tW = h('div.adj-tri.white', { title: 'Highlight input level' });
    inBar.append(tB, tG, tW);
    const fB = numberField(cur().inBlack, v => { cur().inBlack = Math.min(v, cur().inWhite - 2); sync(); change(true); }, { min: 0, max: 253, width: 52, title: 'Shadow input level' });
    const fG = numberField(cur().gamma, v => { cur().gamma = v; sync(); change(true); }, { min: 0.01, max: 9.99, decimals: 2, step: 0.01, width: 52, title: 'Midtone input level (gamma)' });
    const fW = numberField(cur().inWhite, v => { cur().inWhite = Math.max(v, cur().inBlack + 2); sync(); change(true); }, { min: 2, max: 255, width: 52, title: 'Highlight input level' });

    // ---- output levels
    const outBar = h('div.adj-tri-bar.out');
    const oB = h('div.adj-tri.black', { title: 'Shadow output level' });
    const oW = h('div.adj-tri.white', { title: 'Highlight output level' });
    outBar.append(oB, oW);
    const foB = numberField(cur().outBlack, v => { cur().outBlack = v; sync(); change(true); }, { min: 0, max: 255, width: 52, title: 'Shadow output level' });
    const foW = numberField(cur().outWhite, v => { cur().outWhite = v; sync(); change(true); }, { min: 0, max: 255, width: 52, title: 'Highlight output level' });

    const grayPos = (c: LevelsCh) => c.inBlack + (c.inWhite - c.inBlack) * Math.pow(0.5, c.gamma);
    function sync() {
      const c = cur();
      tB.style.left = `${(c.inBlack / 255) * 100}%`;
      tW.style.left = `${(c.inWhite / 255) * 100}%`;
      tG.style.left = `${(grayPos(c) / 255) * 100}%`;
      oB.style.left = `${(c.outBlack / 255) * 100}%`;
      oW.style.left = `${(c.outWhite / 255) * 100}%`;
      fB.setValue(c.inBlack); fG.setValue(c.gamma); fW.setValue(c.inWhite); foB.setValue(c.outBlack); foW.setValue(c.outWhite);
      const cs = { rgb: '#fff', r: '#f33', g: '#3f3', b: '#48f' }[ch()];
      outBar.style.background = `linear-gradient(90deg,#000,${cs})`;
    }
    const drag = (tri: HTMLElement, bar: HTMLElement, apply: (v: number) => void) => {
      tri.addEventListener('pointerdown', e => {
        e.preventDefault(); e.stopPropagation();
        const r = bar.getBoundingClientRect();
        dragPointer(e, (_dx, _dy, ev) => { apply(clamp(((ev.clientX - r.left) / r.width) * 255)); sync(); change(false); }, () => change(true));
      });
    };
    drag(tB, inBar, v => { const c = cur(); c.inBlack = Math.round(Math.min(v, c.inWhite - 2)); });
    drag(tW, inBar, v => { const c = cur(); c.inWhite = Math.round(Math.max(v, c.inBlack + 2)); });
    drag(tG, inBar, v => {
      const c = cur(), f = clamp((v - c.inBlack) / (c.inWhite - c.inBlack), 0.001, 0.999);
      c.gamma = +clamp(Math.log(f) / Math.log(0.5), 0.01, 9.99).toFixed(2);
    });
    drag(oB, outBar, v => { cur().outBlack = Math.round(v); });
    drag(oW, outBar, v => { cur().outWhite = Math.round(v); });

    // ---- eyedroppers: set per-channel points from a sampled colour (PS behaviour)
    const composite = (c: LevelsCh, v: number) => levelsLUT(c)[v];
    const droppers = h('div.adj-droppers', null,
      dropperButton('adj-dropper-black', 'Sample in image to set black point', env, c => {
        (['r', 'g', 'b'] as const).forEach(k => { p[k].inBlack = Math.min(250, Math.round(c[k])); if (p[k].inWhite <= p[k].inBlack + 2) p[k].inWhite = 255; });
        env.rebuild();
      }),
      dropperButton('adj-dropper-gray', 'Sample in image to set gray point', env, c => {
        // after the current per-channel settings, find gammas that make the sample neutral
        const vals = (['r', 'g', 'b'] as const).map(k => composite(p[k], c[k]) / 255);
        const target = (vals[0] + vals[1] + vals[2]) / 3;
        (['r', 'g', 'b'] as const).forEach(k => {
          const q = p[k], x = clamp((c[k] - q.inBlack) / (q.inWhite - q.inBlack), 0.004, 0.996);
          const t = clamp((target * 255 - q.outBlack) / (q.outWhite - q.outBlack || 1), 0.004, 0.996);
          q.gamma = +clamp(Math.log(x) / Math.log(t), 0.1, 9.99).toFixed(2);
        });
        env.rebuild();
      }),
      dropperButton('adj-dropper-white', 'Sample in image to set white point', env, c => {
        (['r', 'g', 'b'] as const).forEach(k => { p[k].inWhite = Math.max(5, Math.round(c[k])); if (p[k].inBlack >= p[k].inWhite - 2) p[k].inBlack = 0; });
        env.rebuild();
      }));

    el.append(
      h('div.adj-toprow', null, h('span.adj-lbl', null, 'Channel:'), sel, auto),
      h('div.adj-sub', null, 'Input Levels:'),
      h('div.adj-hist-wrap', null, hist),
      inBar,
      h('div.adj-tri-fields', null, fB, fG, fW),
      h('div.adj-sub', null, 'Output Levels:'),
      outBar,
      h('div.adj-tri-fields.two', null, foB, foW),
      droppers,
    );
    sync();
    return () => hist.dispose();
  },
});

