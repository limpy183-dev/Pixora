// Camera Raw Filter develop pipeline (one pass over the image, radii scaled by p._scale for previews).
import { type Kernel, clamp, gaussPlane, rng, premul, tap, putAcc } from './core';
import { perspectiveMatrix } from './special';

export const RAW_BANDS = ['Red', 'Orange', 'Yellow', 'Green', 'Aqua', 'Blue', 'Purple', 'Magenta'];
const BAND_HUES = [0, 30, 60, 120, 180, 240, 280, 320];
export function rawDefaults() {
  return {
    temp: 0, tint: 0, exposure: 0, contrast: 0, highlights: 0, shadows: 0, whites: 0, blacks: 0,
    texture: 0, clarity: 0, dehaze: 0, vibrance: 0, saturation: 0,
    curve: { highlights: 0, lights: 0, darks: 0, shadows: 0 },
    hue: [0, 0, 0, 0, 0, 0, 0, 0], sat: [0, 0, 0, 0, 0, 0, 0, 0], lum: [0, 0, 0, 0, 0, 0, 0, 0],
    grade: { sh: 0, ss: 0, mh: 0, ms: 0, hh: 0, hs: 0, balance: 0, blending: 50 },
    sharpen: 0, sharpRadius: 1, sharpDetail: 25, sharpMask: 0, nrLum: 0, nrColor: 0,
    distortion: 0, lensVignette: 0,
    vert: 0, horiz: 0, rotate: 0, geoScale: 100, aspect: 0,
    grain: 0, grainSize: 25, grainRough: 50, vignette: 0, vMid: 50, vRound: 0, vFeather: 50,
    _scale: 1,
  };
}
const hueRGB = (hDeg: number): [number, number, number] => {
  const h = (((hDeg % 360) + 360) % 360) / 60, x = 1 - Math.abs((h % 2) - 1);
  return h < 1 ? [1, x, 0] : h < 2 ? [x, 1, 0] : h < 3 ? [0, 1, x] : h < 4 ? [0, x, 1] : h < 5 ? [x, 0, 1] : [1, 0, x];
};
function scurve(v: number, c: number) {
  if (c === 0) return v;
  const e = c > 0 ? 1 + c * 1.5 : 1 / (1 - c * 0.8);
  return v < 0.5 ? 0.5 * Math.pow(2 * v, e) : 1 - 0.5 * Math.pow(2 - 2 * v, e);
}
/** Parametric curve: smooth bumps over four tonal regions (±100 → ±0.18). */
function paramCurve(v: number, c: { highlights: number; lights: number; darks: number; shadows: number }) {
  const bump = (center: number, width: number) => Math.max(0, 1 - Math.abs(v - center) / width) ** 2;
  return v + (c.shadows * bump(0.125, 0.25) + c.darks * bump(0.375, 0.25) + c.lights * bump(0.625, 0.25) + c.highlights * bump(0.875, 0.25)) * 0.0018 * (1 - Math.abs(2 * v - 1) * 0.3);
}

export const cameraRaw: Kernel = (img, p) => {
  const W = img.width, H = img.height, n = W * H, sc = p._scale || 1;
  // ---------------------------------------------------------------- geometry + lens distortion
  if (p.vert || p.horiz || p.rotate || p.geoScale !== 100 || p.distortion || p.aspect) {
    const Pm = premul(img), out = new Uint8ClampedArray(img.data.length), acc = new Float64Array(4);
    const cx = W / 2, cy = H / 2, R = Math.hypot(cx, cy), Hm = perspectiveMatrix({ vert: p.vert, horiz: p.horiz, angle: p.rotate, scale: p.geoScale, aspect: p.aspect }) as number[], k = -p.distortion / 100 * 0.3;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      let u = (x + 0.5 - cx) / R, v = (y + 0.5 - cy) / R;
      const w = Hm[6] * u + Hm[7] * v + Hm[8];
      const u2 = (Hm[0] * u + Hm[1] * v + Hm[2]) / w, v2 = (Hm[3] * u + Hm[4] * v + Hm[5]) / w;
      const f = 1 + k * (u2 * u2 + v2 * v2);
      u = cx + u2 * f * R; v = cy + v2 * f * R;
      if (w <= 0.01 || u < 0 || v < 0 || u > W || v > H) continue;       // undefined: transparent (PS fills white/transparent)
      tap(Pm, W, H, u, v, acc); putAcc(out, (y * W + x) * 4, acc, 1);
    }
    img.data.set(out);
  }
  const d = img.data;
  const R = new Float32Array(n), G = new Float32Array(n), B = new Float32Array(n);
  for (let i = 0, j = 0; i < n; i++, j += 4) { R[i] = d[j] / 255; G[i] = d[j + 1] / 255; B[i] = d[j + 2] / 255; }
  // ---------------------------------------------------------------- white balance + exposure (linear light)
  const t = p.temp / 100, ti = p.tint / 100, ev = Math.pow(2, p.exposure);
  const wr = (1 + t * 0.35) * (1 + ti * 0.1), wg = 1 - ti * 0.3, wb = (1 - t * 0.35) * (1 + ti * 0.1);
  if (t || ti || p.exposure) for (let i = 0; i < n; i++) {
    R[i] = Math.pow(Math.pow(R[i], 2.2) * wr * ev, 1 / 2.2); G[i] = Math.pow(Math.pow(G[i], 2.2) * wg * ev, 1 / 2.2); B[i] = Math.pow(Math.pow(B[i], 2.2) * wb * ev, 1 / 2.2);
  }
  // luminance + blurred luminance for local tone work
  const Y = new Float32Array(n);
  for (let i = 0; i < n; i++) Y[i] = 0.2126 * R[i] + 0.7152 * G[i] + 0.0722 * B[i];
  const needLocal = p.highlights || p.shadows || p.clarity || p.texture;
  let Yb: Float32Array | null = null, Yt: Float32Array | null = null;
  if (needLocal) { Yb = new Float32Array(Y); gaussPlane(Yb, W, H, Math.max(1, 0.012 * Math.max(W, H))); }
  if (p.texture) { Yt = new Float32Array(Y); gaussPlane(Yt, W, H, Math.max(0.6, 3 * sc)); }
  let Yc: Float32Array | null = null;
  if (p.clarity) { Yc = new Float32Array(Y); gaussPlane(Yc, W, H, Math.max(1.5, 22 * sc)); }
  // dehaze: airlight from bright dark-channel pixels
  let dark: Float32Array | null = null, A = 1;
  if (p.dehaze) {
    dark = new Float32Array(n);
    for (let i = 0; i < n; i++) dark[i] = Math.min(R[i], G[i], B[i]);
    gaussPlane(dark, W, H, Math.max(2, 10 * sc));
    const sorted = Float32Array.from(dark).sort(); A = Math.max(0.5, sorted[Math.floor(n * 0.995)] || 1);
  }
  const con = p.contrast / 100, sh = p.shadows / 100, hi = p.highlights / 100, wh = p.whites / 100, bl = p.blacks / 100;
  const tex = p.texture / 100, cla = p.clarity / 100, dh = p.dehaze / 100, vib = p.vibrance / 100, sat = p.saturation / 100;
  const hasHSL = p.hue.some((v: number) => v) || p.sat.some((v: number) => v) || p.lum.some((v: number) => v);
  const g = p.grade, hasGrade = g.ss || g.ms || g.hs;
  const cs = hueRGB(g.sh), cm = hueRGB(g.mh), ch = hueRGB(g.hh);
  const hasCurve = p.curve.highlights || p.curve.lights || p.curve.darks || p.curve.shadows;
  const W2 = W / 2, H2 = H / 2, diag = Math.hypot(W2, H2);
  for (let i = 0; i < n; i++) {
    let r = R[i], gg = G[i], b = B[i];
    // dehaze
    if (dark) {
      const tt = Math.max(0.15, 1 - 0.95 * Math.max(0, dh) * (dark[i] / A));
      if (dh > 0) { r = (r - A) / tt + A; gg = (gg - A) / tt + A; b = (b - A) / tt + A; }
      else { const k = -dh * 0.6; r = r * (1 - k) + A * k; gg = gg * (1 - k) + A * k; b = b * (1 - k) + A * k; }
    }
    let y = 0.2126 * r + 0.7152 * gg + 0.0722 * b;
    let y2 = y;
    // tone: contrast, shadows / highlights (local), whites / blacks
    y2 = scurve(Math.max(0, Math.min(1, y2)), con);
    if (Yb) {
      const lb = Yb[i];
      if (sh) y2 += sh * (1 - lb) * (1 - lb) * (sh > 0 ? (1 - y2) : y2) * 0.85;
      if (hi) y2 += hi * lb * lb * (hi < 0 ? y2 : (1 - y2)) * 0.85;
    }
    if (wh) y2 += wh * 0.35 * Math.pow(Math.max(0, y2), 3) * (wh > 0 ? 1 : 1.2);
    if (bl) y2 += bl * 0.3 * Math.pow(Math.max(0, 1 - y2), 3);
    if (Yt) y2 += tex * (Y[i] - Yt[i]) * 1.6;
    if (Yc) y2 += cla * (Y[i] - Yc[i]) * 1.2 * (0.3 + 2.8 * y2 * (1 - y2));
    if (hasCurve) y2 = paramCurve(y2, p.curve);
    const k = y > 1e-4 ? Math.max(0, y2) / y : 1;
    r *= k; gg *= k; b *= k;
    if (y <= 1e-4) { r = gg = b = Math.max(0, y2); }
    y = y2;
    // colour: vibrance / saturation
    if (vib || sat || hasHSL || hasGrade) {
      const mx = Math.max(r, gg, b), mn = Math.min(r, gg, b), chroma = mx - mn;
      if (vib || sat) {
        let f = 1 + sat;
        if (vib) {
          // hue (for skin protection): orange ≈ 20-50°
          let hue = 0;
          if (chroma > 1e-5) hue = mx === r ? ((gg - b) / chroma) % 6 : mx === gg ? (b - r) / chroma + 2 : (r - gg) / chroma + 4;
          const hd = ((hue * 60) + 360) % 360, skin = hd > 15 && hd < 55 ? 0.5 : 1;
          f *= 1 + vib * (1 - Math.min(1, chroma * 1.6)) * skin;
        }
        r = y + (r - y) * f; gg = y + (gg - y) * f; b = y + (b - y) * f;
      }
      if (hasHSL && chroma > 1e-4) {
        let hue = mx === r ? ((gg - b) / chroma + 6) % 6 : mx === gg ? (b - r) / chroma + 2 : (r - gg) / chroma + 4;
        hue *= 60;
        let dH = 0, dS = 0, dL = 0;
        for (let k2 = 0; k2 < 8; k2++) {
          const c0 = BAND_HUES[k2], c1 = BAND_HUES[(k2 + 1) % 8] + (k2 === 7 ? 360 : 0);
          let hh = hue; if (k2 === 7 && hh < c0) hh += 360;
          if (hh >= c0 && hh < c1) {
            const tt = (hh - c0) / (c1 - c0), w0 = 1 - tt, w1 = tt, n2 = (k2 + 1) % 8;
            dH = p.hue[k2] * w0 + p.hue[n2] * w1; dS = p.sat[k2] * w0 + p.sat[n2] * w1; dL = p.lum[k2] * w0 + p.lum[n2] * w1;
            break;
          }
        }
        const s0 = Math.min(1, chroma * 2);
        if (dH) {
          const a = (dH * 0.3 * Math.PI) / 180, ca = Math.cos(a), sa = Math.sin(a);
          // rotate chroma in a YIQ-like plane
          const I = 0.596 * r - 0.274 * gg - 0.322 * b, Q = 0.211 * r - 0.523 * gg + 0.312 * b, yy = 0.299 * r + 0.587 * gg + 0.114 * b;
          const I2 = I * ca - Q * sa, Q2 = I * sa + Q * ca;
          r = yy + 0.956 * I2 + 0.621 * Q2; gg = yy - 0.272 * I2 - 0.647 * Q2; b = yy - 1.106 * I2 + 1.703 * Q2;
        }
        if (dS) { const yy = 0.2126 * r + 0.7152 * gg + 0.0722 * b, f = 1 + dS / 100; r = yy + (r - yy) * f; gg = yy + (gg - yy) * f; b = yy + (b - yy) * f; }
        if (dL) { const f = 1 + (dL / 100) * 0.5 * s0; r *= f; gg *= f; b *= f; }
      }
      if (hasGrade) {
        const bal = g.balance / 100, bw = 0.5 + (g.blending / 100) * 0.5;
        const ws = Math.max(0, 1 - y / (0.5 + bal * 0.3)) ** (1 / bw), wh2 = Math.max(0, (y - (0.5 + bal * 0.3)) / (0.5 - bal * 0.3)) ** (1 / bw), wm = Math.max(0, 1 - ws - wh2);
        for (const [c, s2, wgt] of [[cs, g.ss, ws], [cm, g.ms, wm], [ch, g.hs, wh2]] as [number[], number, number][]) {
          if (!s2 || !wgt) continue;
          const amt = (s2 / 100) * wgt * 0.25, cy = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
          r += (c[0] - cy) * amt; gg += (c[1] - cy) * amt; b += (c[2] - cy) * amt;
        }
      }
    }
    // lens vignetting correction + post-crop vignette
    if (p.lensVignette || p.vignette) {
      const x = (i % W) + 0.5 - W2, yy = ((i / W) | 0) + 0.5 - H2;
      if (p.lensVignette) { const rr = Math.hypot(x, yy) / diag, f = 1 + (p.lensVignette / 100) * rr * rr * 0.9; r *= f; gg *= f; b *= f; }
      if (p.vignette) {
        const round = p.vRound / 100, ex = (1 - round) * 1 + round * (W2 / diag), ey = (1 - round) * 1 + round * (H2 / diag);
        const rr = Math.hypot((x / W2) * ex, (yy / H2) * ey), mid = 0.3 + (p.vMid / 100) * 0.7, fe = Math.max(0.02, p.vFeather / 100);
        const tt = Math.max(0, Math.min(1, (rr - mid) / (fe * 0.9 + 0.05)));
        const s3 = tt * tt * (3 - 2 * tt), amt = p.vignette / 100;
        if (amt < 0) { const f = 1 + amt * s3; r *= f; gg *= f; b *= f; } else { r += (1 - r) * amt * s3; gg += (1 - gg) * amt * s3; b += (1 - b) * amt * s3; }
      }
    }
    R[i] = r; G[i] = gg; B[i] = b;
  }
  // ---------------------------------------------------------------- detail: noise reduction + sharpening
  if (p.nrColor) {
    const cb = new Float32Array(n), cr = new Float32Array(n), yy = new Float32Array(n);
    for (let i = 0; i < n; i++) { yy[i] = 0.299 * R[i] + 0.587 * G[i] + 0.114 * B[i]; cb[i] = B[i] - yy[i]; cr[i] = R[i] - yy[i]; }
    const s2 = (p.nrColor / 100) * 5 * Math.max(0.3, sc);
    gaussPlane(cb, W, H, s2); gaussPlane(cr, W, H, s2);
    for (let i = 0; i < n; i++) { R[i] = yy[i] + cr[i]; B[i] = yy[i] + cb[i]; G[i] = (yy[i] - 0.299 * R[i] - 0.114 * B[i]) / 0.587; }
  }
  if (p.nrLum || p.sharpen) {
    const yy = new Float32Array(n);
    for (let i = 0; i < n; i++) yy[i] = 0.2126 * R[i] + 0.7152 * G[i] + 0.0722 * B[i];
    const target = new Float32Array(yy);
    if (p.nrLum) { const sm = new Float32Array(yy); gaussPlane(sm, W, H, (p.nrLum / 100) * 1.8 * Math.max(0.4, sc)); for (let i = 0; i < n; i++) { const dd = Math.abs(yy[i] - sm[i]); const w = Math.max(0, 1 - dd / (0.02 + (p.nrLum / 100) * 0.08)); target[i] = yy[i] + (sm[i] - yy[i]) * w; } }
    if (p.sharpen) {
      const bl2 = new Float32Array(target); gaussPlane(bl2, W, H, Math.max(0.3, p.sharpRadius * sc));
      let mask: Float32Array | null = null;
      if (p.sharpMask) { mask = new Float32Array(n); for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) { const i = y * W + x; mask[i] = Math.min(1, Math.max(0, (Math.hypot(yy[i + 1] - yy[i - 1], yy[i + W] - yy[i - W]) * 8 - p.sharpMask / 100) * 4)); } }
      const amt = (p.sharpen / 150) * 2.5, thr = (1 - p.sharpDetail / 100) * 0.03;
      for (let i = 0; i < n; i++) { let dd = target[i] - bl2[i]; if (Math.abs(dd) < thr) dd *= Math.abs(dd) / (thr || 1); target[i] += dd * amt * (mask ? mask[i] : 1); }
    }
    for (let i = 0; i < n; i++) { const f = yy[i] > 1e-4 ? target[i] / yy[i] : 1; if (yy[i] > 1e-4) { R[i] *= f; G[i] *= f; B[i] *= f; } }
  }
  // ---------------------------------------------------------------- grain
  if (p.grain) {
    const rnd = rng(12345), gs = Math.max(1, (p.grainSize / 25) * 1.6 * Math.max(0.5, sc)), gw = Math.ceil(W / gs) + 2, gh = Math.ceil(H / gs) + 2, gr = new Float32Array(gw * gh);
    for (let i = 0; i < gr.length; i++) gr[i] = rnd() - 0.5;
    const amt = (p.grain / 100) * 0.22, rough = p.grainRough / 100;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const fx = x / gs, fy = y / gs, x0 = fx | 0, y0 = fy | 0, tx = (fx - x0) * (1 - rough) + (tx0(fx) * rough), ty = (fy - y0) * (1 - rough) + tx0(fy) * rough;
      const v = (gr[y0 * gw + x0] * (1 - tx) + gr[y0 * gw + x0 + 1] * tx) * (1 - ty) + (gr[(y0 + 1) * gw + x0] * (1 - tx) + gr[(y0 + 1) * gw + x0 + 1] * tx) * ty;
      const i = y * W + x, yy = 0.2126 * R[i] + 0.7152 * G[i] + 0.0722 * B[i], m = amt * (0.4 + 2.4 * yy * (1 - yy));
      R[i] += v * m; G[i] += v * m; B[i] += v * m;
    }
  }
  for (let i = 0, j = 0; i < n; i++, j += 4) { d[j] = clamp(R[i] * 255); d[j + 1] = clamp(G[i] * 255); d[j + 2] = clamp(B[i] * 255); }
  return img;
};
const tx0 = (f: number) => { const t = f - Math.floor(f); return t < 0.5 ? 0 : 1; };
