// Filter › Camera Raw Filter (Shift+Ctrl+A): Basic, Curve, Detail, Color Mixer, Color Grading, Optics, Geometry and
// Effects panels with a live histogram; White Balance tool (I), Auto, before / after (Y), works as a Smart Filter.
import { registerCommands } from '../../core/commands';
import { registerIcons } from '../../ui/icons';
import { h } from '../../ui/dom';
import { app } from '../../core/app';
import { createCanvas } from '../../core/canvas';
import type { PixDocument } from '../../core/document';
import type { SmartObjectLayer } from '../../layers/smart-object';
import { applyKernel, putSmartFilter, registerSpec, runPreview, rgb3 } from '../engine';
import { RAW_BANDS, rawDefaults } from '../kernels/raw';
import { grabSource, openWorkspace, readPixels, wsSection, wsSlider } from './workspace';

registerIcons({
  'cr-wb': '<path d="M7 20l2-6 7-7 3 3-7 7z"/><path d="M14 5l5 5"/><path d="M4 20h4"/>',
  'cr-before': '<rect x="3" y="5" width="18" height="14" rx="1"/><path d="M12 5v14"/><path d="M6 15l2-3 2 3" /><path d="M14 15l2-3 3 3"/>',
});

const TOOLS = [
  { id: 'hand', icon: 'lq-hand', title: 'Hand Tool', key: 'H' },
  { id: 'zoom', icon: 'lq-zoom', title: 'Zoom Tool', key: 'Z' },
  { id: 'wb', icon: 'cr-wb', title: 'White Balance Tool — click something that should be neutral grey', key: 'I' },
];
const BAND_COLORS = ['#e33', '#f80', '#ee2', '#3c3', '#3cc', '#36f', '#93f', '#e3c'];
let lastSettings: any = null;

export async function openCameraRaw(existing?: { so: SmartObjectLayer; index: number; params: any }) {
  const src = grabSource(1400);
  if (!src) return;
  const p: any = existing ? { ...rawDefaults(), ...JSON.parse(JSON.stringify(existing.params)) } : rawDefaults();
  const orig = readPixels(src.preview), pw = orig.width, ph = orig.height;
  const outC = createCanvas(pw, ph), outX = outC.getContext('2d', { willReadFrequently: true })!;
  outX.putImageData(orig, 0, 0);
  let before = false, busy = false, pending = false, result: ImageData = orig;
  const hist = createCanvas(280, 90);
  hist.className = 'ws-hist';
  const drawHist = (img: ImageData) => {
    const bins = [new Uint32Array(256), new Uint32Array(256), new Uint32Array(256)], d = img.data;
    for (let i = 0; i < d.length; i += 16) { bins[0][d[i]]++; bins[1][d[i + 1]]++; bins[2][d[i + 2]]++; }
    const x = hist.getContext('2d')!, mx = Math.max(1, ...bins.map(b => Math.max(...Array.from(b).slice(2, 254))));
    x.clearRect(0, 0, 280, 90); x.globalCompositeOperation = 'lighter';
    ['#ff3030', '#30ff30', '#3070ff'].forEach((col, c) => { x.fillStyle = col + 'aa'; x.beginPath(); x.moveTo(0, 90); for (let k = 0; k < 256; k++) x.lineTo((k / 255) * 280, 90 - Math.min(1, bins[c][k] / mx) * 86); x.lineTo(280, 90); x.fill(); });
    x.globalCompositeOperation = 'source-over';
    const clipLo = bins.some(b => b[0] > d.length / 4 / 16 * 0.002), clipHi = bins.some(b => b[255] > d.length / 4 / 16 * 0.002);
    x.fillStyle = clipLo ? '#3af' : '#555'; x.fillRect(2, 2, 8, 8); x.fillStyle = clipHi ? '#f33' : '#555'; x.fillRect(270, 2, 8, 8);
  };
  const render = async () => {
    if (busy) { pending = true; return; }
    busy = true;
    try {
      const img = new ImageData(new Uint8ClampedArray(orig.data), pw, ph);
      result = await runPreview('camera-raw', img, { ...p, _scale: src.scale }, { x: 0, y: 0, docW: pw, docH: ph, sel: null, isMask: false, preview: true, fg: rgb3(app.fg), bg: rgb3(app.bg), seed: 1, aux: {} });
      if (!before) outX.putImageData(result, 0, 0);
      drawHist(result);
      ws.view.draw();
    } catch (err) { console.error(err); }
    busy = false;
    if (pending) { pending = false; void render(); }
  };
  const update = () => { void render(); };
  const sliders: { el: any; get: () => number }[] = [];
  const S = (label: string, obj: any, key: string, min: number, max: number, o: { step?: number; track?: string; center?: number } = {}) => {
    const el = wsSlider(label, obj[key], min, max, v => { obj[key] = v; update(); }, { center: o.center ?? (min < 0 ? 0 : undefined), step: o.step, track: o.track });
    sliders.push({ el, get: () => obj[key] });
    return el;
  };
  const Sa = (label: string, arr: number[], i: number, track?: string) => {
    const el = wsSlider(label, arr[i], -100, 100, v => { arr[i] = v; update(); }, { center: 0, track });
    sliders.push({ el, get: () => arr[i] });
    return el;
  };
  const syncAll = () => sliders.forEach(s => s.el.setValue(s.get()));

  // colour mixer tabs
  const mixBody = h('div');
  let mixTab: 'hue' | 'sat' | 'lum' = 'hue';
  const mixTabs = h('div.ws-tabs');
  const renderMix = () => {
    mixBody.replaceChildren();
    mixTabs.replaceChildren(...(['hue', 'sat', 'lum'] as const).map(t => { const b = h('button.ws-tab', { type: 'button', class: t === mixTab ? 'active' : '', title: `Adjust ${t === 'hue' ? 'Hue' : t === 'sat' ? 'Saturation' : 'Luminance'}` }, t === 'hue' ? 'Hue' : t === 'sat' ? 'Saturation' : 'Luminance'); b.addEventListener('click', () => { mixTab = t; renderMix(); }); return b; }));
    RAW_BANDS.forEach((name, i) => mixBody.append(Sa(name, p[mixTab], i, mixTab === 'hue' ? `linear-gradient(90deg, ${BAND_COLORS[(i + 7) % 8]}, ${BAND_COLORS[i]}, ${BAND_COLORS[(i + 1) % 8]})` : mixTab === 'sat' ? `linear-gradient(90deg, #888, ${BAND_COLORS[i]})` : `linear-gradient(90deg, #111, ${BAND_COLORS[i]}, #fff)`)));
  };
  renderMix();
  const hueTrack = 'linear-gradient(90deg, #f00, #ff0, #0f0, #0ff, #00f, #f0f, #f00)';

  const auto = () => {
    // auto tone from the original's luminance distribution
    const d = orig.data, lum: number[] = [];
    for (let i = 0; i < d.length; i += 16) lum.push((d[i] * 0.2126 + d[i + 1] * 0.7152 + d[i + 2] * 0.0722) / 255);
    lum.sort((a, b) => a - b);
    const q = (f: number) => lum[Math.min(lum.length - 1, Math.floor(f * lum.length))];
    const med = Math.max(0.02, q(0.5)), lo = q(0.005), hiQ = q(0.995);
    p.exposure = Math.round(Math.max(-2, Math.min(2, Math.log2(Math.pow(0.46, 2.2) / Math.pow(med, 2.2)) * 0.8)) * 100) / 100;
    p.contrast = Math.round(Math.max(-20, Math.min(30, (0.7 - (hiQ - lo)) * 40)));
    p.highlights = hiQ > 0.97 ? -35 : -10; p.shadows = lo < 0.04 ? 30 : 10;
    p.whites = Math.round(Math.max(-40, Math.min(40, (0.98 - hiQ) * 120))); p.blacks = Math.round(Math.max(-40, Math.min(40, (0.02 - lo) * -150)));
    p.vibrance = 10;
    syncAll(); update();
  };
  const side = h('div.cr-side', null,
    hist,
    h('div.ws-row', null,
      h('button.btn', { type: 'button', title: 'Automatic tone', onclick: auto }, 'Auto'),
      h('button.btn', { type: 'button', title: 'Reset all settings', onclick: () => { Object.assign(p, rawDefaults()); renderMix(); syncAll(); update(); } }, 'Reset'),
      h('button.btn', { type: 'button', title: 'Apply the previous Camera Raw settings', onclick: () => { if (lastSettings) { Object.assign(p, JSON.parse(JSON.stringify(lastSettings))); renderMix(); syncAll(); update(); } } }, 'Previous'),
      h('button.btn', { type: 'button', title: 'Toggle before / after (Y)', onclick: () => toggleBefore() }, 'Before/After')),
    wsSection('Basic',
      h('div.ws-label', null, 'White Balance'),
      S('Temperature', p, 'temp', -100, 100, { track: 'linear-gradient(90deg, #36c, #ccc, #ec3)' }),
      S('Tint', p, 'tint', -100, 100, { track: 'linear-gradient(90deg, #3a3, #ccc, #c3c)' }),
      S('Exposure', p, 'exposure', -5, 5, { step: 0.05, center: 0 }),
      S('Contrast', p, 'contrast', -100, 100), S('Highlights', p, 'highlights', -100, 100), S('Shadows', p, 'shadows', -100, 100),
      S('Whites', p, 'whites', -100, 100), S('Blacks', p, 'blacks', -100, 100),
      S('Texture', p, 'texture', -100, 100), S('Clarity', p, 'clarity', -100, 100), S('Dehaze', p, 'dehaze', -100, 100),
      S('Vibrance', p, 'vibrance', -100, 100), S('Saturation', p, 'saturation', -100, 100)),
    wsSection('Curve', S('Highlights', p.curve, 'highlights', -100, 100), S('Lights', p.curve, 'lights', -100, 100), S('Darks', p.curve, 'darks', -100, 100), S('Shadows', p.curve, 'shadows', -100, 100)),
    wsSection('Detail',
      S('Sharpening', p, 'sharpen', 0, 150), S('Radius', p, 'sharpRadius', 0.5, 3, { step: 0.1 }), S('Detail', p, 'sharpDetail', 0, 100), S('Masking', p, 'sharpMask', 0, 100),
      S('Noise Reduction', p, 'nrLum', 0, 100), S('Color Noise Reduction', p, 'nrColor', 0, 100)),
    wsSection('Color Mixer', mixTabs, mixBody),
    wsSection('Color Grading',
      h('div.ws-label', null, 'Shadows'), S('Hue', p.grade, 'sh', 0, 359, { track: hueTrack }), S('Saturation', p.grade, 'ss', 0, 100),
      h('div.ws-label', null, 'Midtones'), S('Hue', p.grade, 'mh', 0, 359, { track: hueTrack }), S('Saturation', p.grade, 'ms', 0, 100),
      h('div.ws-label', null, 'Highlights'), S('Hue', p.grade, 'hh', 0, 359, { track: hueTrack }), S('Saturation', p.grade, 'hs', 0, 100),
      S('Blending', p.grade, 'blending', 0, 100), S('Balance', p.grade, 'balance', -100, 100)),
    wsSection('Optics', S('Distortion', p, 'distortion', -100, 100), S('Vignetting', p, 'lensVignette', -100, 100)),
    wsSection('Geometry', S('Vertical', p, 'vert', -100, 100), S('Horizontal', p, 'horiz', -100, 100), S('Rotate', p, 'rotate', -10, 10, { step: 0.1 }), S('Aspect', p, 'aspect', -100, 100), S('Scale', p, 'geoScale', 50, 150, { center: 100 })),
    wsSection('Effects',
      S('Grain', p, 'grain', 0, 100), S('Size', p, 'grainSize', 0, 100), S('Roughness', p, 'grainRough', 0, 100),
      S('Vignetting', p, 'vignette', -100, 100), S('Midpoint', p, 'vMid', 0, 100), S('Roundness', p, 'vRound', -100, 100), S('Feather', p, 'vFeather', 0, 100)));
  side.querySelectorAll('.ws-sec').forEach((s, i) => { if (i > 0) s.classList.add('collapsed'); });

  const toggleBefore = () => { before = !before; outX.putImageData(before ? orig : result, 0, 0); ws.status.textContent = before ? 'Before' : ''; ws.view.draw(); };
  const ws = openWorkspace({
    title: 'Camera Raw Filter', tools: TOOLS, side, className: 'cr-dialog',
    onTool: (id, w) => { w.view.cursor = id === 'hand' ? 'grab' : id === 'zoom' ? 'zoom-in' : 'crosshair'; w.view.canvas.style.cursor = w.view.cursor; },
    onKey: e => { if (e.key === 'y' || e.key === 'Y' || e.key === '\\') { toggleBefore(); return true; } return false; },
  });
  ws.view.setImage(outC, pw, ph, true);
  ws.view.onDown = pt => {
    if (ws.tool === 'zoom') { ws.view.zoomAt(ws.view.zoom * (pt.e.altKey ? 1 / 1.5 : 1.5), pt.sx, pt.sy); return; }
    if (ws.tool !== 'wb') return;
    const x = Math.round(pt.x), y = Math.round(pt.y);
    let r = 0, g = 0, b = 0, n = 0;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) { const xx = x + dx, yy = y + dy; if (xx < 0 || yy < 0 || xx >= pw || yy >= ph) continue; const i = (yy * pw + xx) * 4; r += Math.pow(orig.data[i] / 255, 2.2); g += Math.pow(orig.data[i + 1] / 255, 2.2); b += Math.pow(orig.data[i + 2] / 255, 2.2); n++; }
    if (!n) return;
    r /= n; g /= n; b /= n;
    if (r + b < 1e-4) return;
    const t = Math.max(-1, Math.min(1, (b - r) / (0.35 * (r + b)))), A = r * (1 + 0.35 * t), ti = Math.max(-1, Math.min(1, (g - A) / (0.3 * g + 0.1 * A || 1)));
    p.temp = Math.round(t * 100); p.tint = Math.round(ti * 100);
    syncAll(); update();
  };
  ws.view.onMove = pt => {
    const x = Math.floor(pt.x), y = Math.floor(pt.y);
    if (x >= 0 && y >= 0 && x < pw && y < ph) { const i = (y * pw + x) * 4, d = (before ? orig : result).data; ws.status.textContent = `R ${d[i]}  G ${d[i + 1]}  B ${d[i + 2]}${before ? '  (Before)' : ''}`; }
  };
  drawHist(orig);
  update();
  const ok = await ws.result;
  if (!ok) return;
  lastSettings = JSON.parse(JSON.stringify(p));
  const final = { ...p, _scale: 1 };
  if (src.kind === 'smart' && src.so) putSmartFilter(src.doc, src.so, 'camera-raw', 'Camera Raw Filter', final, existing?.index ?? -1);
  else await applyKernel(src.doc, 'Camera Raw Filter', 'camera-raw', final);
}

registerSpec({
  id: 'camera-raw', label: 'Camera Raw Filter', category: 'Special', dialog: false, kernel: 'camera-raw', defaults: rawDefaults,
  edit: (doc: PixDocument, so: SmartObjectLayer, index: number) => { if (app.activeDoc !== doc) return; doc.setActiveLayer(so); void openCameraRaw({ so, index, params: so.smartFilters[index].params }); },
});
registerCommands([{ id: 'filter.cameraRaw', label: 'Camera Raw Filter...', enabled: () => !!app.activeDoc, run: () => openCameraRaw() }]);
