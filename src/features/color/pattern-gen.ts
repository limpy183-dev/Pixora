// Procedural, seamless (tileable) preset patterns: Trees, Grass, Water, Stone, Rust, Marble, Paper, Fabric, Leaves, Stars.
import { createCanvas, ctx2d } from '../../core/canvas';
import type { PatternEx } from './store';

type C3 = [number, number, number];
const hex = (s: string): C3 => { const n = parseInt(s.slice(1), 16); return [n >> 16, (n >> 8) & 255, n & 255]; };

function mulberry(seed: number) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

/** Periodic value noise (period = size px, `cells` lattice cells per period), 0..1. */
function valueNoise(size: number, cells: number, rnd: () => number): Float32Array {
  const lat = new Float32Array(cells * cells);
  for (let i = 0; i < lat.length; i++) lat[i] = rnd();
  const out = new Float32Array(size * size), k = cells / size;
  for (let y = 0; y < size; y++) {
    const fy = y * k, y0 = Math.floor(fy), ty = fy - y0, sy = ty * ty * (3 - 2 * ty);
    const r0 = (y0 % cells) * cells, r1 = ((y0 + 1) % cells) * cells;
    for (let x = 0; x < size; x++) {
      const fx = x * k, x0 = Math.floor(fx), tx = fx - x0, sx = tx * tx * (3 - 2 * tx);
      const c0 = x0 % cells, c1 = (x0 + 1) % cells;
      const a = lat[r0 + c0] + (lat[r0 + c1] - lat[r0 + c0]) * sx;
      const b = lat[r1 + c0] + (lat[r1 + c1] - lat[r1 + c0]) * sx;
      out[y * size + x] = a + (b - a) * sy;
    }
  }
  return out;
}
/** Fractal (fbm) periodic noise normalised to 0..1. */
function fbm(size: number, baseCells: number, octaves: number, rnd: () => number, gain = 0.5): Float32Array {
  const out = new Float32Array(size * size);
  let amp = 1, cells = baseCells, total = 0;
  for (let o = 0; o < octaves && cells <= size; o++) {
    const n = valueNoise(size, cells, rnd);
    for (let i = 0; i < out.length; i++) out[i] += n[i] * amp;
    total += amp; amp *= gain; cells *= 2;
  }
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < out.length; i++) { out[i] /= total; if (out[i] < lo) lo = out[i]; if (out[i] > hi) hi = out[i]; }
  const d = hi - lo || 1;
  for (let i = 0; i < out.length; i++) out[i] = (out[i] - lo) / d;
  return out;
}
/** Periodic Worley (cellular) distances: F1 and F2 normalised by cell size. */
function worley(size: number, cells: number, rnd: () => number): { f1: Float32Array; f2: Float32Array; id: Uint16Array } {
  const pts: number[] = [];
  for (let i = 0; i < cells * cells; i++) pts.push(rnd(), rnd());
  const cs = size / cells, f1 = new Float32Array(size * size), f2 = new Float32Array(size * size), id = new Uint16Array(size * size);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const cx = Math.floor(x / cs), cy = Math.floor(y / cs);
    let d1 = 1e9, d2 = 1e9, best = 0;
    for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) {
      const gx = cx + ox, gy = cy + oy, wx = ((gx % cells) + cells) % cells, wy = ((gy % cells) + cells) % cells;
      const k = wy * cells + wx, px = (gx + pts[k * 2]) * cs, py = (gy + pts[k * 2 + 1]) * cs;
      const d = Math.hypot(px - x, py - y) / cs;
      if (d < d1) { d2 = d1; d1 = d; best = k; } else if (d < d2) d2 = d;
    }
    const i = y * size + x; f1[i] = d1; f2[i] = d2; id[i] = best;
  }
  return { f1, f2, id };
}
function ramp(stops: C3[], t: number): C3 {
  t = Math.max(0, Math.min(1, t)) * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(t)), f = t - i, a = stops[i], b = stops[i + 1];
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
}
/** Build a canvas from a per-pixel colour function. */
function pixels(size: number, fn: (i: number, x: number, y: number) => C3): HTMLCanvasElement {
  const c = createCanvas(size, size), img = new ImageData(size, size), d = img.data;
  for (let y = 0, i = 0; y < size; y++) for (let x = 0; x < size; x++, i++) {
    const [r, g, b] = fn(i, x, y);
    d[i * 4] = r; d[i * 4 + 1] = g; d[i * 4 + 2] = b; d[i * 4 + 3] = 255;
  }
  ctx2d(c).putImageData(img, 0, 0);
  return c;
}
/** Draw with wrap-around so shapes crossing an edge re-enter on the opposite side (seamless). */
function wrapDraw(size: number, x: number, y: number, r: number, draw: (x: number, y: number) => void) {
  for (const ox of [-size, 0, size]) for (const oy of [-size, 0, size]) {
    const px = x + ox, py = y + oy;
    if (px + r < 0 || py + r < 0 || px - r > size || py - r > size) continue;
    draw(px, py);
  }
}

// ------------------------------------------------------------------ generators
function trees(size: number, seed: number, dark: C3, mid: C3, light: C3): HTMLCanvasElement {
  const rnd = mulberry(seed), n = fbm(size, 4, 4, rnd);
  const c = pixels(size, i => ramp([dark, mid], n[i] * 0.6));
  const x = ctx2d(c);
  for (let k = 0; k < 34; k++) {
    const cx = rnd() * size, cy = rnd() * size, r = size * (0.07 + rnd() * 0.08);
    wrapDraw(size, cx, cy, r, (px, py) => {
      const g = x.createRadialGradient(px - r * 0.35, py - r * 0.35, r * 0.1, px, py, r);
      g.addColorStop(0, `rgb(${light})`); g.addColorStop(0.6, `rgb(${mid})`); g.addColorStop(1, `rgba(${dark},0.9)`);
      x.fillStyle = g; x.beginPath(); x.arc(px, py, r, 0, Math.PI * 2); x.fill();
    });
  }
  return c;
}
function grass(size: number, seed: number, base: C3, blade: C3, tip: C3): HTMLCanvasElement {
  const rnd = mulberry(seed), n = fbm(size, 4, 3, rnd);
  const c = pixels(size, i => ramp([base, blade], n[i] * 0.5));
  const x = ctx2d(c);
  x.lineCap = 'round';
  for (let k = 0; k < 420; k++) {
    const bx = rnd() * size, by = rnd() * size, len = size * (0.06 + rnd() * 0.1), lean = (rnd() - 0.5) * len * 0.9, t = rnd();
    wrapDraw(size, bx, by, len, (px, py) => {
      x.strokeStyle = `rgb(${ramp([blade, tip], t).map(Math.round)})`;
      x.lineWidth = 0.8 + rnd() * 0.9;
      x.beginPath(); x.moveTo(px, py); x.quadraticCurveTo(px + lean * 0.3, py - len * 0.6, px + lean, py - len); x.stroke();
    });
  }
  return c;
}
function water(size: number, seed: number, deep: C3, shallow: C3, highlight: C3, caustic = 0.6): HTMLCanvasElement {
  const rnd = mulberry(seed), n = fbm(size, 3, 4, rnd), r = fbm(size, 4, 3, rnd);
  return pixels(size, i => {
    const ridge = Math.pow(1 - Math.abs(r[i] - 0.5) * 2, 8) * caustic;
    const c = ramp([deep, shallow], n[i]);
    return [c[0] + (highlight[0] - c[0]) * ridge, c[1] + (highlight[1] - c[1]) * ridge, c[2] + (highlight[2] - c[2]) * ridge];
  });
}
function stone(size: number, seed: number, cells: number, mortar: C3, a: C3, b: C3): HTMLCanvasElement {
  const rnd = mulberry(seed), w = worley(size, cells, rnd), n = fbm(size, 8, 3, rnd);
  const tone = Array.from({ length: cells * cells }, () => rnd());
  return pixels(size, i => {
    const edge = w.f2[i] - w.f1[i];
    const base = ramp([a, b], tone[w.id[i]] * 0.8 + n[i] * 0.2);
    const shade = 0.75 + 0.35 * Math.min(1, edge * 3);
    if (edge < 0.07) return mortar;
    return [base[0] * shade, base[1] * shade, base[2] * shade];
  });
}
function speckle(size: number, seed: number, stops: C3[], grain = 0.35): HTMLCanvasElement {
  const rnd = mulberry(seed), n = fbm(size, 4, 5, rnd, 0.6);
  return pixels(size, i => ramp(stops, n[i] * (1 - grain) + rnd() * grain));
}
function rust(size: number, seed: number, metal: C3): HTMLCanvasElement {
  const rnd = mulberry(seed), n = fbm(size, 4, 5, rnd, 0.55), m = fbm(size, 2, 3, rnd);
  const rustStops: C3[] = [hex('#3b1a0c'), hex('#7a3413'), hex('#b5561e'), hex('#d98a3d')];
  return pixels(size, i => {
    const coverage = m[i];
    const r = ramp(rustStops, n[i] * 0.85 + rnd() * 0.15);
    if (coverage < 0.35) { const k = 0.85 + n[i] * 0.3; return [metal[0] * k, metal[1] * k, metal[2] * k]; }
    return r;
  });
}
function marble(size: number, seed: number, base: C3, vein: C3, veins = 2, turb = 5): HTMLCanvasElement {
  const rnd = mulberry(seed), n = fbm(size, 2, 5, rnd, 0.55);
  return pixels(size, (i, x, y) => {
    const v = Math.abs(Math.sin(((x + y) / size) * Math.PI * veins + n[i] * turb));
    const t = Math.pow(1 - v, 6);
    return ramp([base, vein], t * 0.95 + n[i] * 0.08);
  });
}
function paper(size: number, seed: number, tint: C3, fibers: number): HTMLCanvasElement {
  const rnd = mulberry(seed), n = fbm(size, 8, 4, rnd);
  const c = pixels(size, i => { const k = 0.93 + n[i] * 0.07 + (rnd() - 0.5) * 0.03; return [tint[0] * k, tint[1] * k, tint[2] * k]; });
  const x = ctx2d(c);
  for (let k = 0; k < fibers; k++) {
    const fx = rnd() * size, fy = rnd() * size, a = rnd() * Math.PI, l = size * (0.04 + rnd() * 0.1);
    wrapDraw(size, fx, fy, l, (px, py) => {
      x.strokeStyle = rnd() < 0.5 ? 'rgba(0,0,0,0.07)' : 'rgba(255,255,255,0.22)';
      x.lineWidth = 0.6;
      x.beginPath(); x.moveTo(px, py); x.lineTo(px + Math.cos(a) * l, py + Math.sin(a) * l); x.stroke();
    });
  }
  return c;
}
function fabric(size: number, seed: number, warp: C3, weft: C3, pitch: number): HTMLCanvasElement {
  const rnd = mulberry(seed), n = fbm(size, 8, 3, rnd);
  return pixels(size, (i, x, y) => {
    const cx = Math.floor(x / pitch), cy = Math.floor(y / pitch);
    const over = (cx + cy) % 2 === 0;
    const u = (x % pitch) / pitch, v = (y % pitch) / pitch;
    const col = over ? warp : weft;
    const prof = over ? Math.sin(u * Math.PI) : Math.sin(v * Math.PI);
    const k = 0.62 + 0.38 * prof + (n[i] - 0.5) * 0.18 + (rnd() - 0.5) * 0.06;
    return [col[0] * k, col[1] * k, col[2] * k];
  });
}
function leaves(size: number, seed: number, bg: C3, palette: C3[]): HTMLCanvasElement {
  const rnd = mulberry(seed), n = fbm(size, 4, 3, rnd);
  const c = pixels(size, i => { const k = 0.8 + n[i] * 0.3; return [bg[0] * k, bg[1] * k, bg[2] * k]; });
  const x = ctx2d(c);
  for (let k = 0; k < 26; k++) {
    const lx = rnd() * size, ly = rnd() * size, len = size * (0.12 + rnd() * 0.08), ang = rnd() * Math.PI * 2;
    const col = palette[Math.floor(rnd() * palette.length)], shade = 0.8 + rnd() * 0.35;
    wrapDraw(size, lx, ly, len, (px, py) => {
      x.save(); x.translate(px, py); x.rotate(ang);
      x.fillStyle = `rgb(${col.map(v => Math.min(255, Math.round(v * shade)))})`;
      x.beginPath(); x.moveTo(-len / 2, 0);
      x.quadraticCurveTo(0, -len * 0.38, len / 2, 0); x.quadraticCurveTo(0, len * 0.38, -len / 2, 0); x.fill();
      x.strokeStyle = 'rgba(0,0,0,0.3)'; x.lineWidth = 0.8;
      x.beginPath(); x.moveTo(-len / 2, 0); x.lineTo(len / 2, 0); x.stroke();
      x.restore();
    });
  }
  return c;
}
function stars(size: number, seed: number, top: C3, bottom: C3, count: number, shapes = false): HTMLCanvasElement {
  const rnd = mulberry(seed), n = fbm(size, 2, 4, rnd);
  const c = pixels(size, i => ramp([top, bottom], n[i]));
  const x = ctx2d(c);
  for (let k = 0; k < count; k++) {
    const sx = rnd() * size, sy = rnd() * size, big = rnd() < 0.12, r = big ? 1.4 + rnd() * 1.6 : 0.4 + rnd() * 0.6;
    const b = 170 + Math.floor(rnd() * 85);
    wrapDraw(size, sx, sy, r * 6, (px, py) => {
      if (shapes) {
        x.fillStyle = `rgb(${b},${Math.round(b * 0.82)},${Math.round(b * 0.3)})`;
        x.beginPath();
        const R = r * 3.2;
        for (let j = 0; j < 10; j++) { const a = -Math.PI / 2 + (j * Math.PI) / 5, rr = j % 2 ? R * 0.45 : R; x.lineTo(px + Math.cos(a) * rr, py + Math.sin(a) * rr); }
        x.closePath(); x.fill();
        return;
      }
      if (big) {
        const g = x.createRadialGradient(px, py, 0, px, py, r * 4);
        g.addColorStop(0, `rgba(${b},${b},255,0.9)`); g.addColorStop(1, 'rgba(160,180,255,0)');
        x.fillStyle = g; x.beginPath(); x.arc(px, py, r * 4, 0, Math.PI * 2); x.fill();
      }
      x.fillStyle = `rgb(${b},${b},${Math.min(255, b + 20)})`;
      x.beginPath(); x.arc(px, py, r, 0, Math.PI * 2); x.fill();
    });
  }
  return c;
}

export function generatePatterns(): PatternEx[] {
  const out: PatternEx[] = [];
  const add = (group: string, name: string, canvas: HTMLCanvasElement) =>
    out.push({ id: `gen-${group}-${name}`.toLowerCase().replace(/[^a-z0-9]+/g, '-'), name, group, canvas });
  add('Trees', 'Tree Canopy', trees(128, 11, hex('#12301a'), hex('#2f6b2a'), hex('#79b04a')));
  add('Trees', 'Pine Forest', trees(96, 12, hex('#0b1f17'), hex('#1d4a32'), hex('#4f8a5c')));
  add('Trees', 'Autumn Trees', trees(128, 13, hex('#3a1c0b'), hex('#b1561b'), hex('#f2b33d')));
  add('Grass', 'Lawn', grass(96, 21, hex('#23491a'), hex('#3f7f2a'), hex('#9ad05a')));
  add('Grass', 'Meadow', grass(128, 22, hex('#304a1b'), hex('#5b8b2e'), hex('#c9dc6a')));
  add('Grass', 'Dry Grass', grass(96, 23, hex('#6b5a2d'), hex('#a88d4a'), hex('#e8d596')));
  add('Water', 'Water', water(128, 31, hex('#0b4f86'), hex('#2a9fd6'), hex('#d9f4ff')));
  add('Water', 'Deep Water', water(128, 32, hex('#031c3a'), hex('#0e4f7e'), hex('#6fc3e8'), 0.45));
  add('Water', 'Pool', water(96, 33, hex('#1aa6c9'), hex('#6fe0f0'), hex('#ffffff'), 0.9));
  add('Stone', 'Cobblestone', stone(128, 41, 5, hex('#2f2b27'), hex('#6d655c'), hex('#a39a8e')));
  add('Stone', 'Slate', stone(96, 42, 3, hex('#1d2226'), hex('#3e474f'), hex('#66727c')));
  add('Stone', 'Granite', speckle(96, 43, [hex('#2a2a2a'), hex('#8a8580'), hex('#d6d0c8'), hex('#a0655a')], 0.55));
  add('Rust', 'Rust', rust(128, 51, hex('#6b6f73')));
  add('Rust', 'Corroded Steel', rust(96, 52, hex('#8a9096')));
  add('Rust', 'Patina', speckle(128, 53, [hex('#2f5d50'), hex('#4f9a86'), hex('#9fd3bf'), hex('#8a5a2b')], 0.3));
  add('Marble', 'White Marble', marble(128, 61, hex('#f1eee9'), hex('#8e8a86')));
  add('Marble', 'Black Marble', marble(128, 62, hex('#1b1b1d'), hex('#d8d4cc'), 3, 6));
  add('Marble', 'Green Marble', marble(128, 63, hex('#0f3b2e'), hex('#b5e0c8'), 2, 7));
  add('Paper', 'White Paper', paper(128, 71, hex('#f7f5f0'), 90));
  add('Paper', 'Recycled Paper', paper(128, 72, hex('#d9cfbd'), 160));
  add('Paper', 'Parchment', speckle(128, 73, [hex('#b98e52'), hex('#e0c48e'), hex('#f3e2b8')], 0.12));
  add('Fabric', 'Linen', fabric(64, 81, hex('#d8cdb8'), hex('#c4b79e'), 2));
  add('Fabric', 'Denim', fabric(64, 82, hex('#3a5f8f'), hex('#26405f'), 3));
  add('Fabric', 'Burlap', fabric(96, 83, hex('#a58458'), hex('#8a6b43'), 6));
  add('Leaves', 'Leaves', leaves(128, 91, hex('#1c3a16'), [hex('#3f7d2a'), hex('#5ca33a'), hex('#2e6224')]));
  add('Leaves', 'Autumn Leaves', leaves(128, 92, hex('#4a2c16'), [hex('#d9661f'), hex('#f0b132'), hex('#b8341c'), hex('#8a5a1c')]));
  add('Leaves', 'Ivy', leaves(96, 93, hex('#122616'), [hex('#2c6b3a'), hex('#3f8f4c'), hex('#6fbf6a')]));
  add('Stars', 'Night Sky', stars(128, 101, hex('#02030d'), hex('#0e1a3d'), 70));
  add('Stars', 'Nebula', stars(128, 102, hex('#12021f'), hex('#3b0f4f'), 60));
  add('Stars', 'Gold Stars', stars(96, 103, hex('#0b1633'), hex('#14244d'), 14, true));
  return out;
}
