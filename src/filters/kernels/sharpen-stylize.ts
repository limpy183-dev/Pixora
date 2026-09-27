// Sharpen, Stylize, Video and Other kernels.
import {
  type Kernel, clamp, cloneImage, convolve, gaussian, lumaPlane, morphPlane, morphRoundPlane, onRegion, rng, workRect, sample,
  rgbToHsb, hsbToRgb, rgbToHsl, hslToRgb, toPlanes, fromPlanes, boxBlurPlane,
} from './core';
import { kuwahara } from './noise-pixelate';

// ------------------------------------------------------------------ Sharpen
function unsharp(img: ImageData, amount: number, radius: number, threshold = 0, blurred?: ImageData): ImageData {
  const b = blurred || gaussian(cloneImage(img), radius), d = img.data, e = b.data, k = amount / 100;
  for (let i = 0; i < d.length; i += 4) {
    if (threshold > 0) {
      const dl = Math.abs((d[i] - e[i]) * 0.299 + (d[i + 1] - e[i + 1]) * 0.587 + (d[i + 2] - e[i + 2]) * 0.114);
      if (dl < threshold) continue;
    }
    d[i] = clamp(d[i] + (d[i] - e[i]) * k); d[i + 1] = clamp(d[i + 1] + (d[i + 1] - e[i + 1]) * k); d[i + 2] = clamp(d[i + 2] + (d[i + 2] - e[i + 2]) * k);
  }
  return img;
}
const usm: Kernel = (img, p, m) => onRegion(img, m, Math.ceil(p.radius * 3) + 2, sub => unsharp(sub, p.amount, p.radius, p.threshold));
function motionBlurImg(img: ImageData, angle: number, dist: number): ImageData {
  const src = cloneImage(img), d = img.data, a = (-angle * Math.PI) / 180, dx = Math.cos(a), dy = Math.sin(a), n = Math.max(2, Math.ceil(dist)), px = new Float32Array(4);
  for (let y = 0; y < img.height; y++) for (let x = 0; x < img.width; x++) {
    let R = 0, G = 0, B = 0;
    for (let k = 0; k <= n; k++) { const t = k / n - 0.5; sample(src, x + 0.5 + dx * dist * t, y + 0.5 + dy * dist * t, px); R += px[0]; G += px[1]; B += px[2]; }
    const i = (y * img.width + x) * 4; d[i] = R / (n + 1); d[i + 1] = G / (n + 1); d[i + 2] = B / (n + 1);
  }
  return img;
}
const smartSharpen: Kernel = (img, p, m) => onRegion(img, m, Math.ceil(p.radius * 4) + 4, sub => {
  const orig = cloneImage(sub);
  let blurred: ImageData;
  if (p.remove === 'lens') { const P = toPlanes(cloneImage(sub)); for (const c of P.c) { boxBlurPlane(c, P.w, P.h, p.radius); boxBlurPlane(c, P.w, P.h, p.radius * 0.6); } blurred = fromPlanes(P); }
  else if (p.remove === 'motion') blurred = motionBlurImg(cloneImage(sub), p.angle, p.radius * 2);
  else blurred = gaussian(cloneImage(sub), p.radius);
  const d = sub.data, o = orig.data, b = blurred.data, k = p.amount / 100, nt = (p.noise / 100) * 12;
  const sh = p.shadowFade / 100, hi = p.highlightFade / 100;
  for (let i = 0; i < d.length; i += 4) {
    const L = (o[i] * 0.299 + o[i + 1] * 0.587 + o[i + 2] * 0.114) / 255;
    const fade = 1 - sh * Math.max(0, 1 - L * 2) - hi * Math.max(0, L * 2 - 1);
    for (let c = 0; c < 3; c++) {
      let det = o[i + c] - b[i + c];
      if (nt > 0) { const a = Math.abs(det); det *= a <= nt ? 0 : a >= nt * 2 ? 1 : (a - nt) / nt; }
      d[i + c] = clamp(o[i + c] + det * k * fade);
    }
  }
  return sub;
});
/** Shake Reduction: estimate a linear motion blur (direction + length) and deconvolve luminance (Richardson–Lucy). */
export function estimateShake(L: Float32Array, W: number, H: number): { angle: number; length: number } {
  // blur along a direction suppresses gradients in that direction → find the weakest gradient orientation
  const bins = new Float64Array(18);
  for (let y = 1; y < H - 1; y += 2) for (let x = 1; x < W - 1; x += 2) {
    const gx = L[y * W + x + 1] - L[y * W + x - 1], gy = L[(y + 1) * W + x] - L[(y - 1) * W + x], mag = gx * gx + gy * gy;
    if (mag < 4) continue;
    let a = Math.atan2(gy, gx); if (a < 0) a += Math.PI;
    bins[Math.min(17, Math.floor((a / Math.PI) * 18))] += mag;
  }
  let mi = 0; for (let i = 1; i < 18; i++) if (bins[i] < bins[mi]) mi = i;
  const angle = ((mi + 0.5) / 18) * 180;
  // length: first minimum of the autocorrelation of the derivative along that direction
  const a = (angle * Math.PI) / 180, dx = Math.cos(a), dy = Math.sin(a);
  const corr = new Float64Array(40);
  for (let y = 20; y < H - 20; y += 3) for (let x = 20; x < W - 20; x += 3) {
    const d0 = L[Math.round(y + dy) * W + Math.round(x + dx)] - L[y * W + x];
    for (let k = 1; k < 40; k++) {
      const xx = Math.round(x + dx * k), yy = Math.round(y + dy * k);
      if (xx < 1 || yy < 1 || xx >= W - 1 || yy >= H - 1) break;
      const dk = L[Math.round(yy + dy) * W + Math.round(xx + dx)] - L[yy * W + xx];
      corr[k] += d0 * dk;
    }
  }
  let length = 3;
  for (let k = 2; k < 39; k++) if (corr[k] < corr[k - 1] && corr[k] <= corr[k + 1]) { length = k; break; }
  return { angle: -angle, length: Math.max(2, Math.min(40, length)) };
}
function lineConv(src: Float32Array, W: number, H: number, angle: number, len: number): Float32Array {
  const out = new Float32Array(src.length), a = (angle * Math.PI) / 180, dx = Math.cos(a), dy = -Math.sin(a), n = Math.max(1, Math.round(len));
  const offs: [number, number][] = [];
  for (let k = 0; k <= n; k++) { const t = k / n - 0.5; offs.push([Math.round(dx * len * t), Math.round(dy * len * t)]); }
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let s = 0;
    for (const [ox, oy] of offs) { const xx = Math.min(W - 1, Math.max(0, x + ox)), yy = Math.min(H - 1, Math.max(0, y + oy)); s += src[yy * W + xx]; }
    out[y * W + x] = s / offs.length;
  }
  return out;
}
const shakeReduction: Kernel = (img, p, m) => onRegion(img, m, 40, sub => {
  const W = sub.width, H = sub.height, L = lumaPlane(sub);
  const est = p.auto ? estimateShake(L, W, H) : { angle: p.angle, length: p.length };
  const iters = m.preview ? 6 : Math.round(8 + p.iterations);
  let u = new Float32Array(L).map(v => v + 1);
  const obs = new Float32Array(L).map(v => v + 1);
  for (let it = 0; it < iters; it++) {
    const blurred = lineConv(u, W, H, est.angle, est.length);
    const ratio = new Float32Array(u.length);
    for (let i = 0; i < u.length; i++) ratio[i] = obs[i] / Math.max(1e-3, blurred[i]);
    const corr = lineConv(ratio, W, H, est.angle, est.length);
    for (let i = 0; i < u.length; i++) u[i] = Math.max(0.5, Math.min(300, u[i] * (1 + (corr[i] - 1) * 0.9)));
  }
  // smoothing / artifact suppression: limit the correction and soften it
  const delta = new ImageData(W, H), dd = delta.data;
  for (let i = 0; i < u.length; i++) { const v = clamp(128 + (u[i] - 1 - L[i]) * (1 - p.smoothing / 100 * 0.7)); dd[i * 4] = v; dd[i * 4 + 3] = 255; }
  if (p.smoothing > 0) gaussian(delta, (p.smoothing / 100) * 1.2);
  const d = sub.data, lim = 60 * (1 - (p.suppress / 100) * 0.7);
  for (let i = 0; i < u.length; i++) { const dv = Math.max(-lim, Math.min(lim, dd[i * 4] - 128)); d[i * 4] = clamp(d[i * 4] + dv); d[i * 4 + 1] = clamp(d[i * 4 + 1] + dv); d[i * 4 + 2] = clamp(d[i * 4 + 2] + dv); }
  void u; u = new Float32Array(0);
  return sub;
});

// ------------------------------------------------------------------ Stylize
const diffuse: Kernel = (img, p, m) => {
  const r = workRect(img, m), src = new Uint8ClampedArray(img.data), d = img.data, W = img.width, H = img.height, R = rng(m.seed);
  const lum = (i: number) => src[i] * 0.299 + src[i + 1] * 0.587 + src[i + 2] * 0.114;
  for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) {
    const i = (y * W + x) * 4;
    let q: number;
    if (p.mode === 'anisotropic') {
      let best = Infinity; q = i;
      for (let k = 0; k < 4; k++) { const xx = Math.min(W - 1, Math.max(0, x + Math.round((R() - 0.5) * 3))), yy = Math.min(H - 1, Math.max(0, y + Math.round((R() - 0.5) * 3))), j = (yy * W + xx) * 4, dl = Math.abs(lum(j) - lum(i)); if (dl < best && j !== i) { best = dl; q = j; } }
    } else {
      const xx = Math.min(W - 1, Math.max(0, x + Math.round((R() - 0.5) * 3))), yy = Math.min(H - 1, Math.max(0, y + Math.round((R() - 0.5) * 3)));
      q = (yy * W + xx) * 4;
      if (p.mode === 'darken' && lum(q) >= lum(i)) continue;
      if (p.mode === 'lighten' && lum(q) <= lum(i)) continue;
    }
    d[i] = src[q]; d[i + 1] = src[q + 1]; d[i + 2] = src[q + 2]; d[i + 3] = src[q + 3];
  }
  return img;
};
const emboss: Kernel = (img, p, m) => onRegion(img, m, p.height + 2, sub => {
  const W = sub.width, H = sub.height, L = lumaPlane(sub), d = sub.data, a = (p.angle * Math.PI) / 180, dx = Math.cos(a) * p.height, dy = -Math.sin(a) * p.height, k = p.amount / 100;
  const at = (x: number, y: number) => L[Math.min(H - 1, Math.max(0, Math.round(y))) * W + Math.min(W - 1, Math.max(0, Math.round(x)))];
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const v = clamp(128 + (at(x + dx, y + dy) - at(x - dx, y - dy)) * k * 0.5), i = (y * W + x) * 4;
    d[i] = d[i + 1] = d[i + 2] = v;
  }
  return sub;
});
const findEdges: Kernel = (img, _p, m) => onRegion(img, m, 2, sub => {
  const W = sub.width, H = sub.height, s = new Uint8ClampedArray(sub.data), d = sub.data;
  const at = (x: number, y: number, c: number) => s[(Math.min(H - 1, Math.max(0, y)) * W + Math.min(W - 1, Math.max(0, x))) * 4 + c];
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) for (let c = 0; c < 3; c++) {
    const gx = at(x + 1, y - 1, c) + 2 * at(x + 1, y, c) + at(x + 1, y + 1, c) - at(x - 1, y - 1, c) - 2 * at(x - 1, y, c) - at(x - 1, y + 1, c);
    const gy = at(x - 1, y + 1, c) + 2 * at(x, y + 1, c) + at(x + 1, y + 1, c) - at(x - 1, y - 1, c) - 2 * at(x, y - 1, c) - at(x + 1, y - 1, c);
    d[(y * W + x) * 4 + c] = clamp(255 - Math.hypot(gx, gy) * 0.5);
  }
  return sub;
});
const oilPaint: Kernel = (img, p, m) => onRegion(img, m, 14, sub => {
  const rad = Math.max(1, Math.round(p.stylization * 1.2 * (p.scale / 5)));
  kuwahara(sub, rad);
  if (p.cleanliness > 0) gaussian(sub, (p.cleanliness / 10) * 0.8);
  if (p.lighting) {
    const W = sub.width, H = sub.height, L = lumaPlane(sub), R = rng(m.seed), d = sub.data;
    // bristle texture: directional noise along the local isophote
    const tex = new Float32Array(W * H);
    for (let y = 0; y < H; y++) { let v = 0; for (let x = 0; x < W; x++) { v = v * 0.8 + (R() - 0.5) * (p.bristle / 10); tex[y * W + x] = v; } }
    const a = (p.angle * Math.PI) / 180, lx = Math.cos(a), ly = -Math.sin(a), sh = p.shine / 10;
    for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
      const i = y * W + x;
      const gx = (L[i + 1] - L[i - 1]) / 255 + (tex[i + 1] - tex[i - 1]), gy = (L[i + W] - L[i - W]) / 255 + (tex[i + W] - tex[i - W]);
      const shade = (-gx * lx - gy * ly) * sh * 60;
      d[i * 4] = clamp(d[i * 4] + shade); d[i * 4 + 1] = clamp(d[i * 4 + 1] + shade); d[i * 4 + 2] = clamp(d[i * 4 + 2] + shade);
    }
  }
  return sub;
});
const solarize: Kernel = (img, _p, m) => {
  const r = workRect(img, m), d = img.data;
  for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) { const i = (y * img.width + x) * 4; for (let c = 0; c < 3; c++) if (d[i + c] > 127) d[i + c] = 255 - d[i + c]; }
  return img;
};
const tiles: Kernel = (img, p, m) => {
  const r = workRect(img, m), src = cloneImage(img), d = img.data, W = img.width, R = rng(m.seed);
  const ts = Math.max(2, Math.floor(Math.min(r.w, r.h) / Math.max(1, p.count))), maxOff = (p.offset / 100) * ts;
  for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) {
    const i = (y * W + x) * 4;
    if (p.fill === 'bg' || p.fill === 'fg') { const c = p.fill === 'bg' ? m.bg : m.fg; d[i] = c[0]; d[i + 1] = c[1]; d[i + 2] = c[2]; d[i + 3] = 255; }
    else if (p.fill === 'inverse') { d[i] = 255 - d[i]; d[i + 1] = 255 - d[i + 1]; d[i + 2] = 255 - d[i + 2]; }
  }
  const s = src.data;
  for (let ty = r.y; ty < r.y + r.h; ty += ts) for (let tx = r.x; tx < r.x + r.w; tx += ts) {
    const ox = Math.round((R() - 0.5) * 2 * maxOff), oy = Math.round((R() - 0.5) * 2 * maxOff);
    for (let y = ty; y < Math.min(r.y + r.h, ty + ts); y++) for (let x = tx; x < Math.min(r.x + r.w, tx + ts); x++) {
      const X = x + ox, Y = y + oy;
      if (X < r.x || Y < r.y || X >= r.x + r.w || Y >= r.y + r.h) continue;
      const si = (y * W + x) * 4, di = (Y * W + X) * 4;
      d[di] = s[si]; d[di + 1] = s[si + 1]; d[di + 2] = s[si + 2]; d[di + 3] = s[si + 3];
    }
  }
  return img;
};
const traceContour: Kernel = (img, p, m) => onRegion(img, m, 1, sub => {
  const W = sub.width, H = sub.height, s = new Uint8ClampedArray(sub.data), d = sub.data, lv = p.level;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) for (let c = 0; c < 3; c++) {
    const i = (y * W + x) * 4 + c, v = s[i], r = x < W - 1 ? s[i + 4] : v, b = y < H - 1 ? s[i + W * 4] : v;
    const above = v >= lv;
    const edge = (above !== (r >= lv) || above !== (b >= lv)) && (p.edge === 'upper' ? above : !above);
    d[i] = edge ? 0 : 255;
  }
  return sub;
});
const wind: Kernel = (img, p, m) => {
  const r = workRect(img, m), d = img.data, W = img.width, R = rng(m.seed);
  const len = p.method === 'blast' ? 40 : 14, left = p.direction === 'left';
  for (let y = r.y; y < r.y + r.h; y++) {
    const stagger = p.method === 'stagger' ? ((y >> 1) & 1 ? 1 : -1) : 1;
    const toLeft = stagger > 0 ? left : !left;
    const st = [0, 0, 0], fall = 255 / (len * (0.5 + R()));
    for (let k = 0; k < r.w; k++) {
      const x = toLeft ? r.x + r.w - 1 - k : r.x + k, i = (y * W + x) * 4;
      for (let c = 0; c < 3; c++) {
        st[c] = Math.max(d[i + c], st[c] - fall * (0.5 + R()));
        if (st[c] > d[i + c]) d[i + c] = d[i + c] + (st[c] - d[i + c]) * 0.85;
      }
    }
  }
  return img;
};
/** Extrude: 3-D blocks or pyramids pushed towards the viewer from the image centre. */
const extrude: Kernel = (img, p, m) => {
  const r = workRect(img, m), W = img.width, c = new OffscreenCanvas(W, img.height), x = c.getContext('2d', { willReadFrequently: true })!;
  const srcC = new OffscreenCanvas(W, img.height); srcC.getContext('2d')!.putImageData(img, 0, 0);
  const s = img.data, R = rng(m.seed), size = Math.max(2, p.size), cx = r.x + r.w / 2, cy = r.y + r.h / 2, focal = Math.max(r.w, r.h) * 0.9;
  x.fillStyle = `rgb(${m.bg[0]},${m.bg[1]},${m.bg[2]})`;
  x.putImageData(img, 0, 0);
  x.fillRect(r.x, r.y, r.w, r.h);
  const blocks: { bx: number; by: number; depth: number; col: number[] }[] = [];
  for (let by = r.y; by < r.y + r.h; by += size) for (let bx = r.x; bx < r.x + r.w; bx += size) {
    const ex = Math.min(r.x + r.w, bx + size), ey = Math.min(r.y + r.h, by + size);
    if (p.maskIncomplete && (ex - bx < size || ey - by < size)) continue;
    let R0 = 0, G0 = 0, B0 = 0, n = 0;
    for (let yy = by; yy < ey; yy++) for (let xx = bx; xx < ex; xx++) { const i = (yy * W + xx) * 4; R0 += s[i]; G0 += s[i + 1]; B0 += s[i + 2]; n++; }
    const col = [R0 / n, G0 / n, B0 / n], L = (col[0] * 0.299 + col[1] * 0.587 + col[2] * 0.114) / 255;
    blocks.push({ bx, by, depth: (p.depthMode === 'level' ? L : R()) * p.depth, col });
  }
  blocks.sort((a, b) => a.depth - b.depth || Math.hypot(b.bx - cx, b.by - cy) - Math.hypot(a.bx - cx, a.by - cy));
  const proj = (px: number, py: number, dz: number) => { const k = focal / Math.max(1, focal - dz); return [cx + (px - cx) * k, cy + (py - cy) * k]; };
  const shade = (col: number[], f: number) => `rgb(${clamp(col[0] * f) | 0},${clamp(col[1] * f) | 0},${clamp(col[2] * f) | 0})`;
  for (const b of blocks) {
    const base = [[b.bx, b.by], [b.bx + size, b.by], [b.bx + size, b.by + size], [b.bx, b.by + size]];
    if (p.type === 'pyramids') {
      const apex = proj(b.bx + size / 2, b.by + size / 2, b.depth);
      const fs = [0.95, 0.7, 0.5, 0.8];
      for (let k = 0; k < 4; k++) { const a = base[k], bb = base[(k + 1) % 4]; x.fillStyle = shade(b.col, fs[k]); x.beginPath(); x.moveTo(a[0], a[1]); x.lineTo(bb[0], bb[1]); x.lineTo(apex[0], apex[1]); x.closePath(); x.fill(); }
      continue;
    }
    const front = base.map(([px, py]) => proj(px, py, b.depth));
    for (let k = 0; k < 4; k++) { const a = base[k], bb = base[(k + 1) % 4], fa = front[k], fb = front[(k + 1) % 4]; x.fillStyle = shade(b.col, [0.9, 0.65, 0.5, 0.75][k]); x.beginPath(); x.moveTo(a[0], a[1]); x.lineTo(bb[0], bb[1]); x.lineTo(fb[0], fb[1]); x.lineTo(fa[0], fa[1]); x.closePath(); x.fill(); }
    const fw = front[1][0] - front[0][0], fh = front[3][1] - front[0][1];
    if (p.solid) { x.fillStyle = shade(b.col, 1); x.fillRect(front[0][0], front[0][1], fw, fh); }
    else x.drawImage(srcC, b.bx, b.by, size, size, front[0][0], front[0][1], fw, fh);
  }
  img.data.set(x.getImageData(0, 0, W, img.height).data);
  return img;
};

// ------------------------------------------------------------------ Video
const deinterlace: Kernel = (img, p, m) => {
  const r = workRect(img, m), d = img.data, W = img.width, H = img.height, odd = p.eliminate === 'odd';
  for (let y = r.y; y < r.y + r.h; y++) {
    if ((y % 2 === 1) !== odd) continue;
    for (let x = r.x; x < r.x + r.w; x++) {
      const i = (y * W + x) * 4, up = ((y > 0 ? y - 1 : y + 1) * W + x) * 4, dn = ((y < H - 1 ? y + 1 : y - 1) * W + x) * 4;
      for (let c = 0; c < 4; c++) d[i + c] = p.create === 'interpolation' ? (d[up + c] + d[dn + c]) / 2 : d[up + c];
    }
  }
  return img;
};
const ntsc: Kernel = (img, _p, m) => {
  const r = workRect(img, m), d = img.data;
  for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) {
    const i = (y * img.width + x) * 4, R = d[i] / 255, G = d[i + 1] / 255, B = d[i + 2] / 255;
    const Y = 0.299 * R + 0.587 * G + 0.114 * B;
    let I = 0.596 * R - 0.274 * G - 0.322 * B, Q = 0.211 * R - 0.523 * G + 0.312 * B;
    const C = Math.hypot(I, Q), maxC = Math.min(1.2 - Y, Y + 0.2) * 0.92;
    if (C > maxC && C > 0) { const k = maxC / C; I *= k; Q *= k; }
    d[i] = clamp((Y + 0.956 * I + 0.621 * Q) * 255); d[i + 1] = clamp((Y - 0.272 * I - 0.647 * Q) * 255); d[i + 2] = clamp((Y - 1.106 * I + 1.703 * Q) * 255);
  }
  return img;
};

// ------------------------------------------------------------------ Other
const custom: Kernel = (img, p, m) => onRegion(img, m, 3, sub => convolve(sub, p.kernel, 5, p.scale || 1, p.offset || 0));
const highPass: Kernel = (img, p, m) => onRegion(img, m, Math.ceil(p.radius * 3) + 2, sub => {
  const b = gaussian(cloneImage(sub), p.radius).data, d = sub.data;
  for (let i = 0; i < d.length; i += 4) { d[i] = clamp(128 + d[i] - b[i]); d[i + 1] = clamp(128 + d[i + 1] - b[i + 1]); d[i + 2] = clamp(128 + d[i + 2] - b[i + 2]); }
  return sub;
});
const hsbHsl: Kernel = (img, p, m) => {
  const r = workRect(img, m), d = img.data;
  const decode = (a: number, b: number, c: number): [number, number, number] => p.input === 'hsb' ? hsbToRgb(a / 255, b / 255, c / 255) : p.input === 'hsl' ? hslToRgb(a / 255, b / 255, c / 255) : [a, b, c];
  const encode = (R: number, G: number, B: number): [number, number, number] => { if (p.output === 'rgb') return [R, G, B]; const v = p.output === 'hsb' ? rgbToHsb(R, G, B) : rgbToHsl(R, G, B); return [v[0] * 255, v[1] * 255, v[2] * 255]; };
  for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) {
    const i = (y * img.width + x) * 4, [R, G, B] = decode(d[i], d[i + 1], d[i + 2]), o = encode(R, G, B);
    d[i] = o[0]; d[i + 1] = o[1]; d[i + 2] = o[2];
  }
  return img;
};
function morph(img: ImageData, p: any, m: any, max: boolean): ImageData {
  return onRegion(img, m, Math.ceil(p.radius) + 1, sub => {
    const W = sub.width, H = sub.height, n = W * H, d = sub.data, rad = Math.max(1, Math.round(p.radius));
    for (let c = 0; c < 4; c++) {
      const pl = new Float32Array(n);
      for (let i = 0; i < n; i++) pl[i] = d[i * 4 + c];
      // for alpha, Maximum grows opaque areas like the colour channels (Photoshop spreads the layer too)
      if (p.preserve === 'roundness') morphRoundPlane(pl, W, H, rad, max); else morphPlane(pl, W, H, rad, rad, max);
      for (let i = 0; i < n; i++) d[i * 4 + c] = pl[i];
    }
    return sub;
  });
}
const offset: Kernel = (img, p, m) => {
  const r = workRect(img, m), src = new Uint8ClampedArray(img.data), d = img.data, W = img.width;
  for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) {
    let sx = x - r.x - Math.round(p.h), sy = y - r.y - Math.round(p.v);
    const i = (y * W + x) * 4;
    if (sx < 0 || sy < 0 || sx >= r.w || sy >= r.h) {
      if (p.undefined === 'wrap') { sx = ((sx % r.w) + r.w) % r.w; sy = ((sy % r.h) + r.h) % r.h; }
      else if (p.undefined === 'repeat') { sx = Math.max(0, Math.min(r.w - 1, sx)); sy = Math.max(0, Math.min(r.h - 1, sy)); }
      else { if (m.isMask) { d[i] = d[i + 1] = d[i + 2] = 0; } else { d[i] = m.bg[0]; d[i + 1] = m.bg[1]; d[i + 2] = m.bg[2]; d[i + 3] = p.transparent ? 0 : 255; } continue; }
    }
    const j = ((sy + r.y) * W + sx + r.x) * 4;
    d[i] = src[j]; d[i + 1] = src[j + 1]; d[i + 2] = src[j + 2]; d[i + 3] = src[j + 3];
  }
  return img;
};

export const sharpenKernels: Record<string, Kernel> = {
  sharpen: (img, _p, m) => onRegion(img, m, 4, sub => unsharp(sub, 55, 0.7)),
  'sharpen-more': (img, _p, m) => onRegion(img, m, 4, sub => unsharp(sub, 150, 0.8)),
  'sharpen-edges': (img, _p, m) => onRegion(img, m, 4, sub => unsharp(sub, 120, 1, 6)),
  'smart-sharpen': smartSharpen, 'unsharp-mask': usm, 'shake-reduction': shakeReduction,
  diffuse, emboss, extrude, 'find-edges': findEdges, 'oil-paint': oilPaint, solarize, tiles, 'trace-contour': traceContour, wind,
  deinterlace, ntsc,
  custom, 'high-pass': highPass, 'hsb-hsl': hsbHsl, maximum: (i, p, m) => morph(i, p, m, true), minimum: (i, p, m) => morph(i, p, m, false), offset,
};
