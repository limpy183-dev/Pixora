// Render kernels: Clouds, Difference Clouds, Fibers, Lens Flare, Lighting Effects, Flame, Tree, Picture Frame.
import { type Kernel, type KRect, type Meta, clamp, fbm, rng, workRect, lumaPlane, gaussian } from './core';

type RGB3 = [number, number, number];
const lerp3 = (a: RGB3, b: RGB3, t: number): RGB3 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

function cloudValue(x: number, y: number, seed: number, scale: number, strong: boolean) {
  let v = fbm(x / scale, y / scale, seed, 8, 0.5);
  v = (v - 0.5) * (strong ? 2.6 : 1.8) + 0.5;
  return Math.max(0, Math.min(1, v));
}
const clouds: Kernel = (img, p, m) => {
  const r = workRect(img, m), d = img.data, W = img.width, scale = Math.max(64, Math.max(m.docW, m.docH) / 4.5);
  for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) {
    const c = lerp3(m.fg, m.bg, cloudValue(m.x + x, m.y + y, p.seed ?? m.seed, scale, !!p.strong)), i = (y * W + x) * 4;
    d[i] = c[0]; d[i + 1] = c[1]; d[i + 2] = c[2]; d[i + 3] = 255;
  }
  return img;
};
const diffClouds: Kernel = (img, p, m) => {
  const r = workRect(img, m), d = img.data, W = img.width, scale = Math.max(64, Math.max(m.docW, m.docH) / 4.5);
  for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) {
    const c = lerp3(m.fg, m.bg, cloudValue(m.x + x, m.y + y, p.seed ?? m.seed, scale, !!p.strong)), i = (y * W + x) * 4;
    d[i] = Math.abs(d[i] - c[0]); d[i + 1] = Math.abs(d[i + 1] - c[1]); d[i + 2] = Math.abs(d[i + 2] - c[2]);
    if (d[i + 3] === 0) d[i + 3] = 255;
  }
  return img;
};
const fibers: Kernel = (img, p, m) => {
  const r = workRect(img, m), d = img.data, W = img.width, seed = p.seed ?? m.seed;
  const fx = 0.25 + p.strength / 12, fy = 0.002 + p.variance / 3000;
  for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) {
    const X = m.x + x, Y = m.y + y;
    let v = fbm(X * fx * 0.35, Y * fy, seed, 5, 0.6) * 0.7 + fbm(X * fx, Y * fy * 3, seed + 99, 3, 0.5) * 0.3;
    v = Math.max(0, Math.min(1, (v - 0.5) * 2.2 + 0.5));
    const c = lerp3(m.fg, m.bg, v), i = (y * W + x) * 4;
    d[i] = c[0]; d[i + 1] = c[1]; d[i + 2] = c[2]; d[i + 3] = 255;
  }
  return img;
};

// ------------------------------------------------------------------ Lens Flare
const screen = (a: number, b: number) => 255 - ((255 - a) * (255 - clamp(b))) / 255;
const lensFlare: Kernel = (img, p, m) => {
  const r = { x: 0, y: 0, w: img.width, h: img.height }, d = img.data, W = img.width;
  const cx = (p.cx / 100) * img.width, cy = (p.cy / 100) * img.height, br = p.brightness / 100;
  const diag = Math.hypot(img.width, img.height), mx = img.width / 2, my = img.height / 2;
  const L = p.lens as string;
  const glowR = diag * (L === 'movie' ? 0.03 : L === '35' ? 0.045 : L === '105' ? 0.06 : 0.05);
  const ringR = diag * (L === '105' ? 0.16 : L === '35' ? 0.09 : 0.12);
  const ghosts: [number, number, RGB3, number][] = L === 'movie'
    ? [[0.4, 0.012, [120, 160, 255], 0.35], [0.8, 0.02, [140, 190, 255], 0.25], [1.25, 0.035, [100, 140, 255], 0.2], [1.6, 0.05, [80, 120, 255], 0.15]]
    : [[0.25, 0.01, [255, 200, 120], 0.35], [0.45, 0.02, [140, 255, 160], 0.25], [0.7, 0.03, [120, 170, 255], 0.2], [1.05, 0.015, [255, 140, 200], 0.3], [1.3, 0.05, [140, 200, 255], 0.14], [1.7, 0.03, [255, 220, 150], 0.18]];
  const vx = mx - cx, vy = my - cy;
  const R = rng(9), rays = Array.from({ length: 48 }, () => 0.3 + R() * 0.7);
  for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) {
    const dx = x + 0.5 - cx, dy = y + 0.5 - cy, dist = Math.hypot(dx, dy);
    let lr = 0, lg = 0, lb = 0;
    // core glow
    const g = Math.exp(-(dist * dist) / (2 * glowR * glowR)) * 255 * br, g2 = Math.exp(-dist / (glowR * 4)) * 120 * br;
    lr += g + g2; lg += g + g2 * 0.85; lb += g * 0.95 + g2 * 0.6;
    // rays / anamorphic streak
    if (L === 'movie') { const s = Math.exp(-Math.abs(dy) / (glowR * 0.08)) * Math.exp(-Math.abs(dx) / (diag * 0.35)) * 200 * br; lr += s * 0.6; lg += s * 0.75; lb += s; }
    else { const a = (Math.atan2(dy, dx) / (2 * Math.PI) + 1) * rays.length, k = Math.floor(a) % rays.length, f = a - Math.floor(a); const ray = rays[k] * (1 - f) + rays[(k + 1) % rays.length] * f; const s = ray * Math.exp(-dist / (glowR * 5 * ray)) * 70 * br; lr += s; lg += s * 0.9; lb += s * 0.8; }
    // halo ring (rainbow)
    const rd = (dist - ringR) / (ringR * 0.07);
    if (Math.abs(rd) < 3) { const t = Math.exp(-rd * rd) * 40 * br, hue = (rd + 3) / 6; lr += t * (1 - hue); lg += t * (1 - Math.abs(hue - 0.5) * 2); lb += t * hue; }
    // ghosts along the axis through the image centre
    for (const [pos, size, col, a] of ghosts) {
      const gx = cx + vx * pos * 2, gy = cy + vy * pos * 2, gd = Math.hypot(x + 0.5 - gx, y + 0.5 - gy) / (diag * size);
      if (gd < 1.2) { const t = (gd < 0.85 ? 1 : Math.max(0, 1 - (gd - 0.85) / 0.35)) * a * 255 * br * 0.5; lr += (col[0] / 255) * t; lg += (col[1] / 255) * t; lb += (col[2] / 255) * t; }
    }
    const i = (y * W + x) * 4;
    d[i] = screen(d[i], lr); d[i + 1] = screen(d[i + 1], lg); d[i + 2] = screen(d[i + 2], lb);
    if (d[i + 3] < 255) d[i + 3] = Math.max(d[i + 3], clamp(Math.max(lr, lg, lb)));
  }
  return img;
};

// ------------------------------------------------------------------ Lighting Effects (Phong shading with bump texture)
const lighting: Kernel = (img, p, m) => {
  const W = img.width, H = img.height, d = img.data, n = W * H;
  let tex: Float32Array | null = null;
  if (p.texture !== 'none') {
    tex = new Float32Array(n);
    if (p.texture === 'luma') tex = lumaPlane(img); else { const c = p.texture === 'red' ? 0 : p.texture === 'green' ? 1 : 2; for (let i = 0; i < n; i++) tex[i] = d[i * 4 + c]; }
    if (!p.whiteHigh) for (let i = 0; i < n; i++) tex[i] = 255 - tex[i];
  }
  const size = Math.max(W, H), hScale = (p.height / 100) * 0.08;
  const lx = (p.cx / 100) * W, ly = (p.cy / 100) * H, lz = (p.lz / 100) * size;
  const ang = (p.angle * Math.PI) / 180, dirX = Math.cos(ang), dirY = -Math.sin(ang);
  const col: RGB3 = [p.color.r / 255, p.color.g / 255, p.color.b / 255];
  const inten = (p.intensity + 100) / 100 * 1.1, amb = (p.ambience + 100) / 200 * 0.7, exposure = Math.pow(2, p.exposure / 50);
  const shin = 4 + ((p.gloss + 100) / 200) * 96, metal = (p.metallic + 100) / 200, specK = ((p.gloss + 100) / 200) * 0.8;
  const cone = Math.cos(((p.cone / 2) * Math.PI) / 180), hot = Math.cos(((p.cone / 2) * (p.hotspot / 100) * Math.PI) / 180);
  const reach = (p.radius / 100) * size;
  const src = new Uint8ClampedArray(d);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x;
    let nx = 0, ny = 0, nz = 1;
    if (tex) {
      const tl = tex[y * W + Math.max(0, x - 1)], tr = tex[y * W + Math.min(W - 1, x + 1)], tu = tex[Math.max(0, y - 1) * W + x], td = tex[Math.min(H - 1, y + 1) * W + x];
      nx = -(tr - tl) * hScale; ny = -(td - tu) * hScale;
      const l = Math.hypot(nx, ny, 1); nx /= l; ny /= l; nz = 1 / l;
    }
    let Lx: number, Ly: number, Lz: number, att = 1;
    if (p.type === 'infinite') { const alt = Math.PI / 4; Lx = -dirX * Math.cos(alt); Ly = -dirY * Math.cos(alt); Lz = Math.sin(alt); }
    else {
      // point: light hangs above the position; spot: light sits back along -direction and aims at the position
      const sx = p.type === 'spot' ? lx - dirX * lz * 0.7 : lx, sy = p.type === 'spot' ? ly - dirY * lz * 0.7 : ly;
      Lx = sx - (x + 0.5); Ly = sy - (y + 0.5); Lz = lz;
      const dist = Math.hypot(Lx, Ly, Lz); Lx /= dist; Ly /= dist; Lz /= dist;
      const planar = Math.hypot(lx - x, ly - y);
      att = Math.max(0, 1 - (planar / Math.max(1, reach)) ** 2);
      if (p.type === 'spot') {
        const ax = lx - sx, ay = ly - sy, az = -lz, al = Math.hypot(ax, ay, az);
        const cosA = (-Lx * ax - Ly * ay - Lz * az) / al;
        att *= cosA <= cone ? 0 : cosA >= hot ? 1 : (cosA - cone) / (hot - cone);
      }
    }
    const diff = Math.max(0, nx * Lx + ny * Ly + nz * Lz) * att * inten;
    const hx = Lx, hy = Ly, hz = Lz + 1, hl = Math.hypot(hx, hy, hz);
    const spec = Math.pow(Math.max(0, (nx * hx + ny * hy + nz * hz) / hl), shin) * specK * att * inten;
    const o = i * 4;
    for (let c = 0; c < 3; c++) {
      const base = src[o + c] / 255, lc = col[c];
      const specCol = lc * (1 - metal) + base * metal;
      d[o + c] = clamp((base * (amb + diff * lc) + spec * specCol) * exposure * 255);
    }
  }
  return img;
};

// ------------------------------------------------------------------ OffscreenCanvas helpers
function ctxFor(img: ImageData): [OffscreenCanvasRenderingContext2D, OffscreenCanvas] {
  const c = new OffscreenCanvas(img.width, img.height), x = c.getContext('2d', { willReadFrequently: true })!;
  x.putImageData(img, 0, 0);
  return [x, c];
}
const done = (x: OffscreenCanvasRenderingContext2D, img: ImageData) => { img.data.set(x.getImageData(0, 0, img.width, img.height).data); return img; };
/** Base line for Flame / Tree / Picture Frame: path polylines (image coords) or the bottom of the work area. */
function baseLines(img: ImageData, m: Meta, r: KRect): number[][][] {
  const segs: number[][][] = (m.aux?.polylines || []).map((pl: number[][]) => pl.map(([x, y]) => [x - m.x, y - m.y]));
  if (segs.length) return segs;
  return [[[r.x + r.w * 0.15, r.y + r.h * 0.92], [r.x + r.w * 0.85, r.y + r.h * 0.92]]];
}
function pointsAlong(lines: number[][][], step: number): { x: number; y: number; nx: number; ny: number }[] {
  const out: { x: number; y: number; nx: number; ny: number }[] = [];
  for (const pl of lines) {
    let carry = 0;
    for (let i = 0; i < pl.length - 1; i++) {
      const [x0, y0] = pl[i], [x1, y1] = pl[i + 1], L = Math.hypot(x1 - x0, y1 - y0);
      if (!L) continue;
      const tx = (x1 - x0) / L, ty = (y1 - y0) / L;
      let t = carry;
      while (t <= L) { out.push({ x: x0 + tx * t, y: y0 + ty * t, nx: ty, ny: -tx }); t += step; }
      carry = t - L;
    }
  }
  return out;
}

const flame: Kernel = (img, p, m) => {
  const r = workRect(img, m), [x, c] = ctxFor(img), R = rng(p.seed ?? m.seed);
  const lines = baseLines(img, m, r);
  const bases = p.type === 'candle' ? [pointsAlong(lines, 1e9)[0]] : p.type === 'one' ? pointsAlong(lines, 1e9).slice(0, 1) : pointsAlong(lines, Math.max(4, p.interval));
  const glow = new OffscreenCanvas(img.width, img.height), gx = glow.getContext('2d')!;
  gx.globalCompositeOperation = 'lighter';
  const custom: RGB3 | null = p.useColor ? [p.color.r, p.color.g, p.color.b] : null;
  for (const b of bases) {
    if (!b) continue;
    let nx = b.nx, ny = b.ny;
    if (ny > 0) { nx = -nx; ny = -ny; }      // flames rise upwards
    if (p.type === 'various') { const a = (R() - 0.5) * 1.2; const c2 = Math.cos(a), s2 = Math.sin(a); [nx, ny] = [nx * c2 - ny * s2, nx * s2 + ny * c2]; }
    const rot = (p.angle * Math.PI) / 180, cr = Math.cos(rot), sr = Math.sin(rot);
    [nx, ny] = [nx * cr - ny * sr, nx * sr + ny * cr];
    const len = (p.type === 'candle' ? p.length * 0.35 : p.length) * (0.75 + R() * 0.5), wid = (p.type === 'candle' ? p.width * 0.4 : p.width) * (0.8 + R() * 0.4);
    const tx = -ny, ty = nx, steps = 24, seed = R() * 1000;
    const pts: number[][] = [];
    for (let side = -1; side <= 1; side += 2) for (let k = 0; k <= steps; k++) {
      const t = side < 0 ? k / steps : 1 - k / steps;
      const half = (wid / 2) * Math.pow(Math.sin(Math.PI * Math.min(1, t * 1.15 + 0.02)), 0.8) * (1 - t * 0.85);
      const turb = (fbm(t * 3, seed, 7, 3) - 0.5) * wid * (p.turbulence / 25) * t + Math.sin(t * p.jag * 0.3 + seed) * wid * 0.08 * t;
      pts.push([b.x + nx * len * t + tx * (side * half + turb), b.y + ny * len * t + ty * (side * half + turb)]);
    }
    const grad = gx.createLinearGradient(b.x, b.y, b.x + nx * len, b.y + ny * len);
    const stops: [number, RGB3, number][] = custom
      ? [[0, [255, 255, 255], 1], [0.15, custom, 0.95], [0.7, custom, 0.6], [1, custom, 0]]
      : [[0, [255, 255, 230], 1], [0.12, [255, 235, 120], 1], [0.35, [255, 150, 30], 0.95], [0.7, [210, 40, 10], 0.6], [1, [120, 10, 5], 0]];
    for (const [o, col, a] of stops) grad.addColorStop(o, `rgba(${col[0] | 0},${col[1] | 0},${col[2] | 0},${a * (p.opacity / 100)})`);
    gx.fillStyle = grad;
    gx.beginPath(); pts.forEach(([px, py], i) => (i ? gx.lineTo(px, py) : gx.moveTo(px, py))); gx.closePath(); gx.fill();
  }
  x.globalCompositeOperation = 'source-over';
  x.filter = `blur(${Math.max(1, p.width / 12)}px)`;
  x.globalAlpha = 0.6; x.drawImage(glow, 0, 0);
  x.filter = 'none'; x.globalAlpha = 1;
  x.globalCompositeOperation = 'lighter';
  x.drawImage(glow, 0, 0);
  void c;
  return done(x, img);
};

const tree: Kernel = (img, p, m) => {
  const r = workRect(img, m), [x] = ctxFor(img), R = rng(p.seed ?? m.seed);
  const lines = baseLines(img, m, r);
  const bases = p.multiple ? pointsAlong(lines, Math.max(20, p.height * 1.2)) : [pointsAlong(lines, 1e9)[0]].map(b => (m.aux?.polylines?.length ? b : { x: r.x + r.w / 2, y: r.y + r.h * 0.95, nx: 0, ny: -1 }));
  const leaf = `rgb(${p.leafColor.r},${p.leafColor.g},${p.leafColor.b})`, trunk = `rgb(${p.trunkColor.r},${p.trunkColor.g},${p.trunkColor.b})`;
  const leaves: [number, number, number, number][] = [];
  const branch = (bx: number, by: number, ang: number, len: number, w: number, depth: number) => {
    const ex = bx + Math.cos(ang) * len, ey = by + Math.sin(ang) * len;
    const mx = (bx + ex) / 2 + (R() - 0.5) * len * 0.15, my = (by + ey) / 2 + (R() - 0.5) * len * 0.15;
    x.strokeStyle = trunk; x.lineWidth = w; x.lineCap = 'round';
    x.beginPath(); x.moveTo(bx, by); x.quadraticCurveTo(mx, my, ex, ey); x.stroke();
    if (depth <= 0 || len < 3) { for (let k = 0; k < p.leaves / 20; k++) leaves.push([ex + (R() - 0.5) * p.leafSize * 3, ey + (R() - 0.5) * p.leafSize * 3, p.leafSize * (0.6 + R() * 0.6), R() * Math.PI]); return; }
    const kids = p.style === 'pine' ? 2 : 2 + (R() < 0.4 ? 1 : 0);
    for (let k = 0; k < kids; k++) {
      const spread = p.style === 'pine' ? 1.2 : p.style === 'willow' ? 0.9 : 0.6;
      const na = ang + (k - (kids - 1) / 2) * spread * (0.6 + R() * 0.6) + (p.style === 'willow' ? 0.25 : 0);
      branch(ex, ey, na, len * (p.style === 'pine' ? 0.55 : 0.72) * (0.8 + R() * 0.35), Math.max(0.6, w * 0.66), depth - 1);
    }
    if (p.style === 'pine') branch(ex, ey, ang + (R() - 0.5) * 0.1, len * 0.8, w * 0.75, depth - 1);
  };
  for (const b of bases) {
    if (!b) continue;
    const up = Math.atan2(b.ny < 0 ? b.ny : -Math.abs(b.ny || 1), b.nx);
    branch(b.x, b.y, up + ((p.lean || 0) * Math.PI) / 180, p.height * 0.32, Math.max(2, p.height / 18), Math.max(2, Math.min(9, p.branches)));
  }
  x.fillStyle = leaf;
  for (const [lx, ly, s, a] of leaves) { x.beginPath(); x.ellipse(lx, ly, s, s * 0.5, a, 0, Math.PI * 2); x.fill(); }
  return done(x, img);
};

const pictureFrame: Kernel = (img, p, m) => {
  const r = workRect(img, m), [x] = ctxFor(img), R = rng(p.seed ?? m.seed);
  const mg = p.margin, S = p.size, c1 = `rgb(${p.color.r},${p.color.g},${p.color.b})`, c2 = `rgb(${p.color2.r},${p.color2.g},${p.color2.b})`;
  const X0 = r.x + mg, Y0 = r.y + mg, X1 = r.x + r.w - mg, Y1 = r.y + r.h - mg;
  const perimeter = (step: number, fn: (px: number, py: number, ang: number) => void) => {
    const sides: [number, number, number, number][] = [[X0, Y0, X1, Y0], [X1, Y0, X1, Y1], [X1, Y1, X0, Y1], [X0, Y1, X0, Y0]];
    for (const [ax, ay, bx, by] of sides) { const L = Math.hypot(bx - ax, by - ay), n = Math.max(1, Math.round(L / step)), a = Math.atan2(by - ay, bx - ax); for (let k = 0; k < n; k++) fn(ax + ((bx - ax) * k) / n, ay + ((by - ay) * k) / n, a); }
  };
  x.lineJoin = 'round'; x.lineCap = 'round';
  switch (p.style) {
    case 'double':
      x.strokeStyle = c1; x.lineWidth = S * 0.35; x.strokeRect(X0, Y0, X1 - X0, Y1 - Y0);
      x.lineWidth = S * 0.15; x.strokeRect(X0 + S, Y0 + S, X1 - X0 - 2 * S, Y1 - Y0 - 2 * S);
      break;
    case 'dots':
      x.fillStyle = c1; perimeter(S * 1.4, (px, py) => { x.beginPath(); x.arc(px, py, S * 0.45, 0, Math.PI * 2); x.fill(); });
      x.fillStyle = c2; perimeter(S * 1.4, (px, py, a) => { x.beginPath(); x.arc(px + Math.cos(a) * S * 0.7, py + Math.sin(a) * S * 0.7, S * 0.2, 0, Math.PI * 2); x.fill(); });
      break;
    case 'vine':
    case 'leaves': {
      x.strokeStyle = c1; x.lineWidth = Math.max(1, S * 0.12);
      x.beginPath();
      let first = true;
      perimeter(S * 0.5, (px, py, a) => { const w = Math.sin((px + py) / (S * 1.2)) * S * 0.35; const qx = px - Math.sin(a) * w, qy = py + Math.cos(a) * w; if (first) { x.moveTo(qx, qy); first = false; } else x.lineTo(qx, qy); });
      x.closePath(); x.stroke();
      x.fillStyle = c2;
      perimeter(S * (p.style === 'leaves' ? 0.8 : 1.6), (px, py, a) => {
        const side = R() < 0.5 ? -1 : 1, la = a + side * (0.6 + R() * 0.5);
        x.beginPath(); x.ellipse(px + Math.cos(la) * S * 0.5, py + Math.sin(la) * S * 0.5, S * 0.45, S * 0.18, la, 0, Math.PI * 2); x.fill();
        if (p.style === 'vine' && R() < 0.25) { x.fillStyle = c1; x.beginPath(); x.arc(px, py, S * 0.18, 0, Math.PI * 2); x.fill(); x.fillStyle = c2; }
      });
      break;
    }
    case 'ribbon': {
      x.strokeStyle = c1; x.lineWidth = S * 0.6; x.strokeRect(X0, Y0, X1 - X0, Y1 - Y0);
      x.strokeStyle = c2; x.lineWidth = S * 0.12; x.setLineDash([S * 0.6, S * 0.6]); x.strokeRect(X0, Y0, X1 - X0, Y1 - Y0); x.setLineDash([]);
      break;
    }
    default:
      x.strokeStyle = c1; x.lineWidth = S; x.strokeRect(X0, Y0, X1 - X0, Y1 - Y0);
  }
  return done(x, img);
};

export const renderKernels: Record<string, Kernel> = {
  clouds, 'difference-clouds': diffClouds, fibers, 'lens-flare': lensFlare, lighting, flame, tree, 'picture-frame': pictureFrame,
};
export { gaussian };
