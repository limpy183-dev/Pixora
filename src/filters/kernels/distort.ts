// Distort kernels (inverse mapping with bilinear sampling). Geometry is relative to the selection bounds.
import { type Kernel, type KRect, remap, rng, sample, workRect, cloneImage } from './core';

const ell = (r: KRect) => ({ cx: r.x + r.w / 2, cy: r.y + r.h / 2, rx: r.w / 2, ry: r.h / 2 });

const pinch: Kernel = (img, p, m) => {
  const r = workRect(img, m), { cx, cy, rx, ry } = ell(r), k = -p.amount / 100;
  return remap(img, r, (x, y, o) => {
    const u = (x - cx) / rx, v = (y - cy) / ry, d = Math.sqrt(u * u + v * v);
    if (d >= 1 || d === 0) return false;
    const f = Math.pow(Math.sin((Math.PI / 2) * d), k);
    o[0] = cx + u * f * rx; o[1] = cy + v * f * ry;
  });
};
const spherize: Kernel = (img, p, m) => {
  const r = workRect(img, m), { cx, cy, rx, ry } = ell(r), a = p.amount / 100, mode = p.mode;
  const map = (d: number) => (a >= 0 ? d * (1 - a) + a * (1 - Math.sqrt(Math.max(0, 1 - d * d))) : d * (1 + a) - a * (Math.asin(Math.min(1, d)) / (Math.PI / 2)));
  return remap(img, r, (x, y, o) => {
    let u = (x - cx) / rx, v = (y - cy) / ry;
    if (mode === 'horizontal') { if (Math.abs(u) >= 1) return false; u = Math.sign(u) * map(Math.abs(u)); }
    else if (mode === 'vertical') { if (Math.abs(v) >= 1) return false; v = Math.sign(v) * map(Math.abs(v)); }
    else {
      const d = Math.sqrt(u * u + v * v);
      if (d >= 1 || d === 0) return false;
      const f = map(d) / d; u *= f; v *= f;
    }
    o[0] = cx + u * rx; o[1] = cy + v * ry;
  });
};
const twirl: Kernel = (img, p, m) => {
  const r = workRect(img, m), { cx, cy, rx, ry } = ell(r), ang = (p.angle * Math.PI) / 180;
  return remap(img, r, (x, y, o) => {
    const u = (x - cx) / rx, v = (y - cy) / ry, d = Math.sqrt(u * u + v * v);
    if (d >= 1) return false;
    const t = ang * (1 - d) * (1 - d), c = Math.cos(t), s = Math.sin(t);
    o[0] = cx + (u * c - v * s) * rx; o[1] = cy + (u * s + v * c) * ry;
  });
};
const polar: Kernel = (img, p, m) => {
  const r = workRect(img, m), { cx, cy, rx, ry } = ell(r);
  return remap(img, r, (x, y, o) => {
    if (p.mode === 'toPolar') {
      const u = (x - cx) / rx, v = (y - cy) / ry, rho = Math.sqrt(u * u + v * v);
      let th = Math.atan2(u, -v); if (th < 0) th += 2 * Math.PI;
      o[0] = r.x + (th / (2 * Math.PI)) * r.w; o[1] = r.y + Math.min(1, rho) * r.h;
    } else {
      const th = ((x - r.x) / r.w) * 2 * Math.PI, rho = (y - r.y) / r.h;
      o[0] = cx + Math.sin(th) * rho * rx; o[1] = cy - Math.cos(th) * rho * ry;
    }
  }, 'clamp');
};
const ripple: Kernel = (img, p, m) => {
  const r = workRect(img, m), amp = p.amount / 22, wl = p.size === 'small' ? 7 : p.size === 'large' ? 30 : 15;
  return remap(img, r, (x, y, o) => {
    o[0] = x + amp * Math.sin((y / wl) * 2 * Math.PI + Math.sin(x / (wl * 5)));
    o[1] = y + amp * Math.sin((x / wl) * 2 * Math.PI + Math.sin(y / (wl * 5))) * 0.6;
  }, p.edge === 'wrap' ? 'wrap' : 'clamp');
};
/** points: [[t 0..1 (top→bottom), offset -1..1 (× half width)], ...] sorted by t. */
function curveAt(pts: number[][], t: number): number {
  if (!pts.length) return 0;
  if (t <= pts[0][0]) return pts[0][1];
  for (let i = 0; i < pts.length - 1; i++) {
    const [t0, v0] = pts[i], [t1, v1] = pts[i + 1];
    if (t <= t1) {
      const pm = pts[Math.max(0, i - 1)][1], pn = pts[Math.min(pts.length - 1, i + 2)][1], u = (t - t0) / (t1 - t0 || 1);
      const m0 = (v1 - pm) / 2, m1 = (pn - v0) / 2, u2 = u * u, u3 = u2 * u;
      return (2 * u3 - 3 * u2 + 1) * v0 + (u3 - 2 * u2 + u) * m0 + (-2 * u3 + 3 * u2) * v1 + (u3 - u2) * m1;
    }
  }
  return pts[pts.length - 1][1];
}
const shear: Kernel = (img, p, m) => {
  const r = workRect(img, m), pts = [...(p.points || [[0, 0], [1, 0]])].sort((a, b) => a[0] - b[0]);
  const wrapX = (x: number) => r.x + ((((x - r.x) % r.w) + r.w) % r.w);
  return remap(img, r, (x, y, o) => {
    const dx = curveAt(pts, (y - r.y) / r.h) * (r.w / 2);
    const sx = x - dx;
    o[0] = p.edge === 'wrap' ? wrapX(sx) : Math.max(r.x + 0.5, Math.min(r.x + r.w - 0.5, sx)); o[1] = y;
  });
};
const wave: Kernel = (img, p, m) => {
  const r = workRect(img, m), R = rng(p.seed ?? m.seed);
  const gens = Array.from({ length: Math.max(1, p.generators) }, () => ({
    wl: p.wlMin + R() * Math.max(0, p.wlMax - p.wlMin), amp: p.ampMin + R() * Math.max(0, p.ampMax - p.ampMin),
    ph: R() * Math.PI * 2, ph2: R() * Math.PI * 2, dir: R() * Math.PI,
  }));
  const shape = (t: number) => {
    const f = t / (2 * Math.PI) - Math.floor(t / (2 * Math.PI));
    return p.type === 'triangle' ? 1 - 4 * Math.abs(f - 0.5) : p.type === 'square' ? (f < 0.5 ? 1 : -1) : Math.sin(t);
  };
  const sh = p.scaleH / 100, sv = p.scaleV / 100, n = gens.length;
  return remap(img, r, (x, y, o) => {
    let dx = 0, dy = 0;
    for (const g of gens) {
      const along = (x - r.x) * Math.cos(g.dir) + (y - r.y) * Math.sin(g.dir);
      dx += g.amp * shape((along / g.wl) * 2 * Math.PI + g.ph);
      dy += g.amp * shape((along / g.wl) * 2 * Math.PI + g.ph2);
    }
    o[0] = x + (dx / n) * sh; o[1] = y + (dy / n) * sv;
  }, p.edge === 'wrap' ? 'wrap' : 'clamp');
};
const zigzag: Kernel = (img, p, m) => {
  const r = workRect(img, m), { cx, cy, rx, ry } = ell(r), a = p.amount / 100, ridges = p.ridges;
  return remap(img, r, (x, y, o) => {
    const u = (x - cx) / rx, v = (y - cy) / ry, d = Math.sqrt(u * u + v * v);
    if (d >= 1 || d === 0) return false;
    const w = Math.sin(d * ridges * Math.PI) * (1 - d);
    let nu = u, nv = v;
    if (p.style === 'around' || p.style === 'pond') { const t = w * a * 0.9, c = Math.cos(t), s = Math.sin(t); nu = u * c - v * s; nv = u * s + v * c; }
    if (p.style === 'out' || p.style === 'pond') { const f = 1 + (w * a * 0.25) / d * d; nu *= f; nv *= f; }
    o[0] = cx + nu * rx; o[1] = cy + nv * ry;
  });
};
const displace: Kernel = (img, p, m) => {
  const map: ImageData | undefined = m.aux?.map;
  if (!map) return img;
  const r = workRect(img, m), px = new Float32Array(4);
  const src = cloneImage(img), d = img.data;
  const out = new Float32Array(4);
  for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) {
    let mx: number, my: number;
    if (p.fit === 'stretch') { mx = ((x - r.x + 0.5) / r.w) * map.width; my = ((y - r.y + 0.5) / r.h) * map.height; }
    else { mx = ((x - r.x) % map.width) + 0.5; my = ((y - r.y) % map.height) + 0.5; }
    sample(map, mx, my, px);
    const hv = px[0], vv = px[1];
    const sx = x + 0.5 + ((hv - 128) * p.h) / 100, sy = y + 0.5 + ((vv - 128) * p.v) / 100;
    sample(src, sx, sy, out, p.edge === 'wrap' ? 'wrap' : 'clamp');
    const i = (y * img.width + x) * 4;
    d[i] = out[0]; d[i + 1] = out[1]; d[i + 2] = out[2]; d[i + 3] = out[3];
  }
  return img;
};

export const distortKernels: Record<string, Kernel> = { pinch, spherize, twirl, polar, ripple, shear, wave, zigzag, displace };
export { curveAt };
