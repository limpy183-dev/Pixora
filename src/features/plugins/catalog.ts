// Built-in plugin catalog (Plugins › Browse Plugins). Each entry is ordinary plugin source using the public API.
import { registerIcons } from '../../ui/icons';

registerIcons({
  plugin: '<path d="M9 3v4M15 3v4"/><rect x="6" y="7" width="12" height="7" rx="1.5"/><path d="M12 14v3a3 3 0 0 1-3 3H8"/>',
  'plg-duotone': '<circle cx="9" cy="12" r="6"/><circle cx="15" cy="12" r="6" fill="currentColor" opacity=".35"/>',
  'plg-sort': '<path d="M5 20V10M9 20V6M13 20v-7M17 20V4M21 20v-9"/>',
  'plg-glitch': '<path d="M3 7h10M7 11h14M3 15h8M11 19h8"/><path d="M15 5l2 4"/>',
  'plg-thermal': '<path d="M10 14V5a2 2 0 1 1 4 0v9a4 4 0 1 1-4 0z"/><path d="M12 16v-5"/>',
  'plg-scan': '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 8h18M3 12h18M3 16h18" opacity=".6"/>',
  'plg-vignette': '<rect x="3" y="4" width="18" height="16" rx="2"/><ellipse cx="12" cy="12" rx="6" ry="5"/>',
  'plg-ascii': '<path d="M4 17l3-10 3 10M5 14h4M14 7h5M14 12h4M14 17h5"/>',
});

export const CATALOG: { id: string; name: string; description: string; icon: string; code: string }[] = [
  {
    id: 'duotone', name: 'Duotone Mapper', icon: 'plg-duotone', description: 'Maps the image to a two-colour gradient (shadows → highlights).',
    code: `pixora.register({
  name: 'Duotone Mapper', author: 'Pixora', version: '1.0',
  description: 'Maps brightness to a gradient between two colours.',
  params: [
    { key: 'hueDark', label: 'Shadow Hue', min: 0, max: 360, default: 230 },
    { key: 'hueLight', label: 'Highlight Hue', min: 0, max: 360, default: 40 },
    { key: 'contrast', label: 'Contrast', min: 0, max: 200, default: 110 },
  ],
  run(img, p) {
    const hsl = (h, s, l) => { const k = n => (n + h / 30) % 12, a = s * Math.min(l, 1 - l); return [0, 8, 4].map(n => 255 * (l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1)))); };
    const A = hsl(p.hueDark, 0.7, 0.18), B = hsl(p.hueLight, 0.85, 0.82), c = p.contrast / 100, d = img.data;
    for (let i = 0; i < d.length; i += 4) {
      let t = (d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114) / 255;
      t = Math.max(0, Math.min(1, (t - 0.5) * c + 0.5));
      for (let k = 0; k < 3; k++) d[i + k] = A[k] + (B[k] - A[k]) * t;
    }
    return img;
  },
});`,
  },
  {
    id: 'pixelsort', name: 'Pixel Sort', icon: 'plg-sort', description: 'Sorts runs of bright pixels along rows or columns for a glitch-art streak look.',
    code: `pixora.register({
  name: 'Pixel Sort', author: 'Pixora', version: '1.0',
  description: 'Sorts pixels by brightness inside bright runs.',
  params: [
    { key: 'threshold', label: 'Threshold', min: 0, max: 255, default: 120 },
    { key: 'vertical', label: 'Vertical', default: false, type: 'check' },
  ],
  run(img, p) {
    const W = img.width, H = img.height, d = img.data, lum = i => d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114;
    const lines = p.vertical ? W : H, len = p.vertical ? H : W;
    const idx = (a, b) => (p.vertical ? b * W + a : a * W + b) * 4;
    for (let a = 0; a < lines; a++) {
      let b = 0;
      while (b < len) {
        while (b < len && lum(idx(a, b)) < p.threshold) b++;
        const s = b;
        while (b < len && lum(idx(a, b)) >= p.threshold) b++;
        if (b - s > 1) {
          const run = [];
          for (let k = s; k < b; k++) { const i = idx(a, k); run.push([d[i], d[i + 1], d[i + 2], d[i + 3]]); }
          run.sort((x, y) => (x[0] * 0.299 + x[1] * 0.587 + x[2] * 0.114) - (y[0] * 0.299 + y[1] * 0.587 + y[2] * 0.114));
          for (let k = s; k < b; k++) { const i = idx(a, k), v = run[k - s]; d[i] = v[0]; d[i + 1] = v[1]; d[i + 2] = v[2]; d[i + 3] = v[3]; }
        }
      }
    }
    return img;
  },
});`,
  },
  {
    id: 'rgbshift', name: 'RGB Glitch', icon: 'plg-glitch', description: 'Splits the colour channels and slices random rows sideways.',
    code: `pixora.register({
  name: 'RGB Glitch', author: 'Pixora', version: '1.0',
  description: 'Channel offset plus random horizontal slices.',
  params: [
    { key: 'shift', label: 'Channel Shift', min: 0, max: 60, default: 12 },
    { key: 'slices', label: 'Slices', min: 0, max: 60, default: 14 },
    { key: 'seed', label: 'Seed', min: 1, max: 999, default: 7 },
  ],
  run(img, p) {
    const W = img.width, H = img.height, s = new Uint8ClampedArray(img.data), d = img.data;
    let r = p.seed * 9301 + 49297; const rnd = () => ((r = (r * 9301 + 49297) % 233280) / 233280);
    const off = new Int32Array(H);
    for (let k = 0; k < p.slices; k++) { const y0 = Math.floor(rnd() * H), hh = Math.floor(rnd() * H / 20) + 2, dx = Math.round((rnd() - 0.5) * W * 0.15); for (let y = y0; y < Math.min(H, y0 + hh); y++) off[y] = dx; }
    const at = (x, y, c) => s[(y * W + Math.min(W - 1, Math.max(0, x))) * 4 + c];
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4, bx = x - off[y];
      d[i] = at(bx - p.shift, y, 0); d[i + 1] = at(bx, y, 1); d[i + 2] = at(bx + p.shift, y, 2);
    }
    return img;
  },
});`,
  },
  {
    id: 'thermal', name: 'Thermal Vision', icon: 'plg-thermal', description: 'False-colour heat map from brightness (blue → red → yellow → white).',
    code: `pixora.register({
  name: 'Thermal Vision', author: 'Pixora', version: '1.0',
  description: 'False-colour heat map.',
  params: [{ key: 'mix', label: 'Mix', min: 0, max: 100, default: 100 }],
  run(img, p) {
    const stops = [[0, 0, 40], [60, 0, 160], [220, 0, 120], [255, 90, 0], [255, 220, 0], [255, 255, 255]], d = img.data, m = p.mix / 100;
    for (let i = 0; i < d.length; i += 4) {
      const t = (d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114) / 255 * (stops.length - 1), k = Math.min(stops.length - 2, Math.floor(t)), f = t - k;
      for (let c = 0; c < 3; c++) { const v = stops[k][c] + (stops[k + 1][c] - stops[k][c]) * f; d[i + c] = d[i + c] + (v - d[i + c]) * m; }
    }
    return img;
  },
});`,
  },
  {
    id: 'scanlines', name: 'CRT Scanlines', icon: 'plg-scan', description: 'Old monitor look: scanlines, RGB phosphor mask and slight bloom.',
    code: `pixora.register({
  name: 'CRT Scanlines', author: 'Pixora', version: '1.0',
  description: 'Scanlines and phosphor mask.',
  params: [
    { key: 'spacing', label: 'Line Spacing', min: 2, max: 12, default: 3 },
    { key: 'darkness', label: 'Darkness', min: 0, max: 100, default: 45 },
    { key: 'mask', label: 'Phosphor Mask', default: true, type: 'check' },
  ],
  run(img, p) {
    const W = img.width, H = img.height, d = img.data, k = p.darkness / 100;
    for (let y = 0; y < H; y++) {
      const line = (y % p.spacing) === 0 ? 1 - k : 1;
      for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 4;
        for (let c = 0; c < 3; c++) { let v = d[i + c] * line; if (p.mask && x % 3 !== c) v *= 0.78; d[i + c] = Math.min(255, v * 1.08); }
      }
    }
    return img;
  },
});`,
  },
  {
    id: 'vignette', name: 'Soft Vignette', icon: 'plg-vignette', description: 'Darkens (or lightens) the edges with an adjustable oval.',
    code: `pixora.register({
  name: 'Soft Vignette', author: 'Pixora', version: '1.0',
  description: 'Oval edge darkening.',
  params: [
    { key: 'amount', label: 'Amount', min: -100, max: 100, default: -45 },
    { key: 'size', label: 'Size', min: 10, max: 100, default: 60 },
    { key: 'softness', label: 'Softness', min: 1, max: 100, default: 60 },
  ],
  run(img, p, info) {
    const W = img.width, H = img.height, d = img.data, cx = (info.docWidth || W) / 2 - (info.x || 0), cy = (info.docHeight || H) / 2 - (info.y || 0);
    const rx = (info.docWidth || W) / 2, ry = (info.docHeight || H) / 2, a = p.amount / 100, s0 = p.size / 100, soft = p.softness / 100;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const r = Math.hypot((x - cx) / rx, (y - cy) / ry), t = Math.max(0, Math.min(1, (r - s0) / (soft + 0.01)));
      const f = t * t * (3 - 2 * t), i = (y * W + x) * 4;
      for (let c = 0; c < 3; c++) d[i + c] = a < 0 ? d[i + c] * (1 + a * f) : d[i + c] + (255 - d[i + c]) * a * f;
    }
    return img;
  },
});`,
  },
  {
    id: 'ascii', name: 'Text Mosaic', icon: 'plg-ascii', description: 'Turns the image into a grid of characters (drawn with OffscreenCanvas).',
    code: `pixora.register({
  name: 'Text Mosaic', author: 'Pixora', version: '1.0',
  description: 'Character-cell rendering of the image.',
  params: [
    { key: 'cell', label: 'Cell Size', min: 4, max: 40, default: 10 },
    { key: 'color', label: 'Keep Colour', default: true, type: 'check' },
  ],
  run(img, p) {
    const W = img.width, H = img.height, s = img.data, cs = p.cell, chars = ' .:-=+*#%@';
    const c = new OffscreenCanvas(W, H), x = c.getContext('2d');
    x.fillStyle = '#000'; x.fillRect(0, 0, W, H);
    x.font = 'bold ' + Math.round(cs * 1.1) + 'px monospace'; x.textAlign = 'center'; x.textBaseline = 'middle';
    for (let y = 0; y < H; y += cs) for (let xx = 0; xx < W; xx += cs) {
      const i = (Math.min(H - 1, y + (cs >> 1)) * W + Math.min(W - 1, xx + (cs >> 1))) * 4, l = (s[i] * 0.299 + s[i + 1] * 0.587 + s[i + 2] * 0.114) / 255;
      x.fillStyle = p.color ? 'rgb(' + s[i] + ',' + s[i + 1] + ',' + s[i + 2] + ')' : '#fff';
      x.fillText(chars[Math.min(chars.length - 1, Math.floor(l * chars.length))], xx + cs / 2, y + cs / 2);
    }
    const out = x.getImageData(0, 0, W, H);
    for (let i = 3; i < out.data.length; i += 4) out.data[i] = s[i];
    return out;
  },
});`,
  },
];
