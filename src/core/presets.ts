// Default preset resources (gradients, patterns, brushes, shapes). Feature modules may add more.
// Always read resources lazily (at use time) — other modules append during startup.
import { resources } from './registry';
import type { Gradient, RGB } from './types';
import { createCanvas, ctx2d } from './canvas';
import { app } from './app';

const g = (name: string, stops: [number, RGB][], opacity: [number, number][] = [[0, 1], [1, 1]]): Gradient =>
  ({ name, stops: stops.map(([pos, color]) => ({ pos, color })), opacityStops: opacity.map(([pos, o]) => ({ pos, opacity: o })), smoothness: 1 });
const C = (hex: string): RGB => { const n = parseInt(hex.slice(1), 16); return { r: n >> 16, g: (n >> 8) & 255, b: n & 255 }; };

/** Special gradient names resolved at use time. */
export const FG_TO_BG = 'Foreground to Background';
export const FG_TO_TRANSPARENT = 'Foreground to Transparent';

/** Resolve dynamic gradients (foreground/background based) to concrete colours. */
export function resolveGradient(gr: Gradient): Gradient {
  if (gr.name === FG_TO_BG) return g(gr.name, [[0, app.fg], [1, app.bg]]);
  if (gr.name === FG_TO_TRANSPARENT) return g(gr.name, [[0, app.fg], [1, app.fg]], [[0, 1], [1, 0]]);
  return gr;
}

resources.gradients.push(
  g(FG_TO_BG, [[0, C('#000000')], [1, C('#ffffff')]]),
  g(FG_TO_TRANSPARENT, [[0, C('#000000')], [1, C('#000000')]], [[0, 1], [1, 0]]),
  g('Black, White', [[0, C('#000000')], [1, C('#ffffff')]]),
  g('Spectrum', [[0, C('#ff0000')], [0.17, C('#ffff00')], [0.33, C('#00ff00')], [0.5, C('#00ffff')], [0.67, C('#0000ff')], [0.83, C('#ff00ff')], [1, C('#ff0000')]]),
  g('Sunset', [[0, C('#2b1055')], [0.5, C('#d53369')], [1, C('#ffc371')]]),
  g('Ocean', [[0, C('#0f2027')], [0.5, C('#2c5364')], [1, C('#6dd5ed')]]),
  g('Chrome', [[0, C('#2b2b2b')], [0.35, C('#f5f5f5')], [0.5, C('#6a6a6a')], [0.65, C('#e8e8e8')], [1, C('#3a3a3a')]]),
  g('Copper', [[0, C('#3b1d0b')], [0.5, C('#e6a15a')], [1, C('#5a2e12')]]),
  g('Violet, Orange', [[0, C('#291c5c')], [1, C('#ff8a00')]]),
  g('Blue, Red, Yellow', [[0, C('#0a00b2')], [0.5, C('#ff0000')], [1, C('#fffc00')]]),
  g('Transparent Stripes', [[0, C('#000000')], [1, C('#000000')]], [[0, 1], [0.1, 1], [0.1001, 0], [0.2, 0], [0.2001, 1], [0.3, 1], [0.3001, 0], [0.4, 0], [0.4001, 1], [0.5, 1], [0.5001, 0], [0.6, 0], [0.6001, 1], [0.7, 1], [0.7001, 0], [0.8, 0], [0.8001, 1], [0.9, 1], [0.9001, 0], [1, 0]]),
  g('Pastel', [[0, C('#a1c4fd')], [1, C('#c2e9fb')]]),
);

function pattern(id: string, name: string, size: number, draw: (x: CanvasRenderingContext2D, s: number) => void) {
  const c = createCanvas(size, size);
  draw(ctx2d(c), size);
  resources.patterns.push({ id, name, canvas: c });
}
pattern('checker', 'Checkerboard', 16, (x, s) => { x.fillStyle = '#fff'; x.fillRect(0, 0, s, s); x.fillStyle = '#bdbdbd'; x.fillRect(0, 0, s / 2, s / 2); x.fillRect(s / 2, s / 2, s / 2, s / 2); });
pattern('stripes', 'Diagonal Stripes', 16, (x, s) => { x.fillStyle = '#f2f2f2'; x.fillRect(0, 0, s, s); x.strokeStyle = '#7a7a7a'; x.lineWidth = 3; for (let i = -s; i < s * 2; i += 8) { x.beginPath(); x.moveTo(i, 0); x.lineTo(i + s, s); x.stroke(); } });
pattern('dots', 'Polka Dots', 20, (x, s) => { x.fillStyle = '#ffffff'; x.fillRect(0, 0, s, s); x.fillStyle = '#3a3a3a'; x.beginPath(); x.arc(5, 5, 3, 0, 7); x.arc(15, 15, 3, 0, 7); x.fill(); });
pattern('grid', 'Grid', 24, (x, s) => { x.fillStyle = '#fafafa'; x.fillRect(0, 0, s, s); x.strokeStyle = '#9ec5ff'; x.lineWidth = 1; x.strokeRect(0.5, 0.5, s, s); });
pattern('bricks', 'Bricks', 32, (x, s) => { x.fillStyle = '#b5543b'; x.fillRect(0, 0, s, s); x.strokeStyle = '#e8d8c8'; x.lineWidth = 2; x.beginPath(); x.moveTo(0, 1); x.lineTo(s, 1); x.moveTo(0, s / 2 + 1); x.lineTo(s, s / 2 + 1); x.moveTo(1, 0); x.lineTo(1, s / 2); x.moveTo(s / 2 + 1, s / 2); x.lineTo(s / 2 + 1, s); x.stroke(); });
pattern('noise', 'Noise', 64, (x, s) => { const img = x.createImageData(s, s); for (let i = 0; i < img.data.length; i += 4) { const v = 110 + Math.random() * 110; img.data[i] = img.data[i + 1] = img.data[i + 2] = v; img.data[i + 3] = 255; } x.putImageData(img, 0, 0); });
pattern('wood', 'Wood Grain', 64, (x, s) => { for (let yy = 0; yy < s; yy++) { const v = 0.5 + 0.5 * Math.sin(yy * 0.6 + Math.sin(yy * 0.13) * 3); x.fillStyle = `rgb(${120 + v * 60},${70 + v * 40},${35 + v * 20})`; x.fillRect(0, yy, s, 1); } });
pattern('canvas-weave', 'Canvas', 16, (x, s) => { x.fillStyle = '#e9e0cf'; x.fillRect(0, 0, s, s); x.fillStyle = 'rgba(120,100,70,.25)'; for (let i = 0; i < s; i += 2) { x.fillRect(i, 0, 1, s); x.fillRect(0, i, s, 1); } });
pattern('hex', 'Honeycomb', 28, (x, s) => { x.fillStyle = '#ffd35c'; x.fillRect(0, 0, s, s); x.strokeStyle = '#a86f00'; x.lineWidth = 1.5; const r = 7; for (const [cx, cy] of [[7, 7], [21, 7], [0, 19], [14, 19], [28, 19]]) { x.beginPath(); for (let i = 0; i < 6; i++) { const a = Math.PI / 3 * i + Math.PI / 6; x.lineTo(cx + r * Math.cos(a), cy + r * Math.sin(a)); } x.closePath(); x.stroke(); } });
pattern('clouds', 'Clouds', 64, (x, s) => { const gr = x.createLinearGradient(0, 0, 0, s); gr.addColorStop(0, '#6aa9e8'); gr.addColorStop(1, '#cfe6ff'); x.fillStyle = gr; x.fillRect(0, 0, s, s); x.fillStyle = 'rgba(255,255,255,.7)'; for (let i = 0; i < 9; i++) { x.beginPath(); x.arc((i * 23) % s, (i * 37) % s, 6 + (i % 4) * 3, 0, 7); x.fill(); } });

resources.brushes.push(
  { id: 'soft-round', name: 'Soft Round', size: 45, hardness: 0 },
  { id: 'hard-round', name: 'Hard Round', size: 30, hardness: 1 },
  { id: 'soft-round-pressure', name: 'Soft Round Pressure Size', size: 45, hardness: 0 },
  { id: 'hard-round-pressure', name: 'Hard Round Pressure Opacity', size: 30, hardness: 1 },
  { id: 'soft-small', name: 'Soft Round 9', size: 9, hardness: 0 },
  { id: 'hard-small', name: 'Hard Round 5', size: 5, hardness: 1 },
  { id: 'soft-large', name: 'Soft Round 200', size: 200, hardness: 0 },
  { id: 'medium-round', name: 'Round 50% Hardness', size: 60, hardness: 0.5 },
);

resources.shapes.push(
  { id: 'heart', name: 'Heart', path: 'M50 88 C20 66 5 50 5 30 C5 15 17 5 30 5 C40 5 47 11 50 18 C53 11 60 5 70 5 C83 5 95 15 95 30 C95 50 80 66 50 88 Z' },
  { id: 'star', name: 'Star', path: 'M50 3 L62 38 L98 38 L69 60 L80 95 L50 74 L20 95 L31 60 L2 38 L38 38 Z' },
  { id: 'arrow', name: 'Arrow', path: 'M5 38 L60 38 L60 15 L96 50 L60 85 L60 62 L5 62 Z' },
  { id: 'speech', name: 'Speech Bubble', path: 'M10 10 L90 10 Q95 10 95 15 L95 60 Q95 65 90 65 L40 65 L20 90 L24 65 L10 65 Q5 65 5 60 L5 15 Q5 10 10 10 Z' },
  { id: 'checkmark', name: 'Check Mark', path: 'M5 55 L20 40 L40 60 L80 15 L95 30 L40 88 Z' },
  { id: 'lightning', name: 'Lightning', path: 'M58 2 L18 55 L45 55 L35 98 L82 40 L55 40 Z' },
  { id: 'drop', name: 'Drop', path: 'M50 3 C50 3 15 45 15 65 C15 85 31 97 50 97 C69 97 85 85 85 65 C85 45 50 3 50 3 Z' },
  { id: 'cross', name: 'Cross', path: 'M35 5 L65 5 L65 35 L95 35 L95 65 L65 65 L65 95 L35 95 L35 65 L5 65 L5 35 L35 35 Z' },
  { id: 'burst', name: 'Burst', path: 'M50 2 L57 30 L80 10 L68 36 L98 34 L72 50 L98 66 L68 64 L80 90 L57 70 L50 98 L43 70 L20 90 L32 64 L2 66 L28 50 L2 34 L32 36 L20 10 L43 30 Z' },
  { id: 'moon', name: 'Moon', path: 'M60 5 C35 10 20 30 20 52 C20 76 40 95 64 95 C76 95 87 90 95 82 C88 85 81 86 74 86 C51 86 33 68 33 45 C33 27 44 12 60 5 Z' },
);

resources.swatches.push(...[
  '#ff0000', '#ffff00', '#00ff00', '#00ffff', '#0000ff', '#ff00ff', '#ffffff', '#e6e6e6', '#cccccc', '#b3b3b3', '#999999', '#808080',
  '#666666', '#4d4d4d', '#333333', '#1a1a1a', '#000000', '#f7977a', '#fdc68a', '#fff79a', '#a2d39c', '#6dcff6', '#8781bd', '#f49ac2',
  '#ed1c24', '#f7941d', '#fff200', '#00a651', '#00aeef', '#2e3192', '#92278f', '#ec008c', '#9e0b0f', '#a0410d', '#aba000', '#007236',
  '#0076a3', '#1b1464', '#630460', '#9e005d', '#c69c6d', '#8c6239', '#603913', '#42210b',
].map((hex, i) => ({ name: `Swatch ${i + 1}`, color: C(hex), group: i < 17 ? 'Basics' : i < 24 ? 'Pastel' : i < 32 ? 'Bright' : i < 40 ? 'Dark' : 'Browns' })));
