// Gradient evaluation & rendering (gradient tool, gradient fill layers, overlays, gradient map).
import type { Gradient, GradientShape, Point } from './types';
import { resolveGradient } from './presets';

/** 256-entry RGBA lookup table (Uint8ClampedArray length 1024). */
export function gradientLUT(gr: Gradient, reverse = false, n = 256): Uint8ClampedArray {
  const g = resolveGradient(gr);
  const out = new Uint8ClampedArray(n * 4);
  const cs = [...g.stops].sort((a, b) => a.pos - b.pos);
  const os = [...(g.opacityStops.length ? g.opacityStops : [{ pos: 0, opacity: 1 }])].sort((a, b) => a.pos - b.pos);
  const smooth = g.smoothness ?? 1;
  const ease = (t: number) => smooth > 0 ? t + (t * t * (3 - 2 * t) - t) * smooth * 0.5 : t;
  // midpoint of a segment (stored on its left stop): remap u so that u=mid → .5
  const midU = (u: number, m = 0.5) => m === 0.5 ? u : u < m ? 0.5 * u / m : 0.5 + 0.5 * (u - m) / (1 - m);
  for (let i = 0; i < n; i++) {
    let t = i / (n - 1);
    if (reverse) t = 1 - t;
    let r = 0, gg = 0, b = 0, a = 1;
    if (t <= cs[0].pos) ({ r, g: gg, b } = cs[0].color);
    else if (t >= cs[cs.length - 1].pos) ({ r, g: gg, b } = cs[cs.length - 1].color);
    else for (let k = 1; k < cs.length; k++) if (t <= cs[k].pos) {
      const s0 = cs[k - 1], s1 = cs[k];
      const u = ease(midU((t - s0.pos) / (s1.pos - s0.pos || 1), s0.mid));
      r = s0.color.r + (s1.color.r - s0.color.r) * u;
      gg = s0.color.g + (s1.color.g - s0.color.g) * u;
      b = s0.color.b + (s1.color.b - s0.color.b) * u;
      break;
    }
    if (t <= os[0].pos) a = os[0].opacity;
    else if (t >= os[os.length - 1].pos) a = os[os.length - 1].opacity;
    else for (let k = 1; k < os.length; k++) if (t <= os[k].pos) {
      const s0 = os[k - 1], s1 = os[k];
      a = s0.opacity + (s1.opacity - s0.opacity) * midU((t - s0.pos) / (s1.pos - s0.pos || 1), s0.mid);
      break;
    }
    out[i * 4] = r; out[i * 4 + 1] = gg; out[i * 4 + 2] = b; out[i * 4 + 3] = a * 255;
  }
  return out;
}

/**
 * Render a gradient into ImageData of size w×h whose (0,0) is at doc position (ox, oy).
 * p0/p1 are the drag start/end in doc coords.
 */
export function renderGradient(w: number, h: number, gr: Gradient, shape: GradientShape, p0: Point, p1: Point,
  opts: { reverse?: boolean; dither?: boolean; ox?: number; oy?: number; scale?: number } = {}): ImageData {
  const lut = gradientLUT(gr, !!opts.reverse, 1024);
  const img = new ImageData(w, h), d = img.data;
  const ox = opts.ox || 0, oy = opts.oy || 0;
  const dx = p1.x - p0.x, dy = p1.y - p0.y;
  const len2 = dx * dx + dy * dy || 1, len = Math.sqrt(len2);
  const ang0 = Math.atan2(dy, dx);
  const ux = dx / len, uy = dy / len;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const px = x + ox + 0.5 - p0.x, py = y + oy + 0.5 - p0.y;
      let t: number;
      switch (shape) {
        case 'radial': t = Math.sqrt(px * px + py * py) / len; break;
        case 'angle': { let a = Math.atan2(py, px) - ang0; a = ((a % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI); t = 1 - a / (2 * Math.PI); break; }
        case 'reflected': t = Math.abs((px * dx + py * dy) / len2); break;
        case 'diamond': t = (Math.abs(px * ux + py * uy) + Math.abs(-px * uy + py * ux)) / len; break;
        default: t = (px * dx + py * dy) / len2;
      }
      if (opts.dither) t += ((((x * 7 + y * 13) % 17) / 17) - 0.5) / 400;
      const k = (t <= 0 ? 0 : t >= 1 ? 1023 : (t * 1023) | 0) * 4, i = (y * w + x) * 4;
      d[i] = lut[k]; d[i + 1] = lut[k + 1]; d[i + 2] = lut[k + 2]; d[i + 3] = lut[k + 3];
    }
  }
  return img;
}
