// Kernels for the special filter workspaces (full-resolution apply and smart filters).
import { type Kernel, cloneImage, premul, tap, putAcc } from './core';

// ------------------------------------------------------------------ base64 Float32 helpers
export function f32ToB64(a: Float32Array): string {
  const u = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
  let s = '';
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, Array.from(u.subarray(i, i + 0x8000)));
  return btoa(s);
}
export function b64ToF32(b: string): Float32Array {
  const s = atob(b), u = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i);
  return new Float32Array(u.buffer);
}

// ------------------------------------------------------------------ Liquify: backward displacement field on a grid
export interface LiquifyField { g: number; fw: number; fh: number; dx: Float32Array; dy: Float32Array }
export function fieldAt(f: LiquifyField, x: number, y: number, out: number[]) {
  const gx = Math.max(0, Math.min(f.fw - 1.0001, x / f.g)), gy = Math.max(0, Math.min(f.fh - 1.0001, y / f.g));
  const x0 = gx | 0, y0 = gy | 0, tx = gx - x0, ty = gy - y0, i = y0 * f.fw + x0;
  const a = (1 - tx) * (1 - ty), b = tx * (1 - ty), c = (1 - tx) * ty, d = tx * ty;
  out[0] = f.dx[i] * a + f.dx[i + 1] * b + f.dx[i + f.fw] * c + f.dx[i + f.fw + 1] * d;
  out[1] = f.dy[i] * a + f.dy[i + 1] * b + f.dy[i + f.fw] * c + f.dy[i + f.fw + 1] * d;
}
const liquify: Kernel = (img, p) => {
  const f: LiquifyField = { g: p.g, fw: p.fw, fh: p.fh, dx: b64ToF32(p.dx), dy: b64ToF32(p.dy) };
  const W = img.width, H = img.height, P = premul(img), d = img.data, acc = new Float64Array(4), o = [0, 0];
  // the field was built for the size in p.w/p.h: scale if the source changed size
  const sx = p.w ? p.w / W : 1, sy = p.h ? p.h / H : 1;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    fieldAt(f, (x + 0.5) * sx, (y + 0.5) * sy, o);
    if (o[0] === 0 && o[1] === 0) continue;
    tap(P, W, H, x + 0.5 + o[0] / sx, y + 0.5 + o[1] / sy, acc);
    putAcc(d, (y * W + x) * 4, acc, 1);
  }
  return img;
};

// ------------------------------------------------------------------ Lens Correction / Adaptive Wide Angle: generic inverse map per channel
/** Per-channel inverse mapping: map(xNorm, yNorm, channel) -> source position in pixels (or null = undefined area). */
export function channelRemap(img: ImageData, map: (x: number, y: number, ch: number, o: number[]) => boolean, edge: 'transparent' | 'black' | 'white' | 'extend'): ImageData {
  const W = img.width, H = img.height, P = premul(img), out = new Uint8ClampedArray(img.data.length), o = [0, 0], acc = new Float64Array(4), tmp = new Uint8ClampedArray(4);
  const perCh = (map as any).perChannel === true;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 4;
    const chans = perCh ? 3 : 1;
    let undefinedPx = false;
    for (let c = 0; c < chans; c++) {
      if (!map(x + 0.5, y + 0.5, c, o)) { undefinedPx = true; break; }
      if (edge !== 'extend' && (o[0] < 0 || o[1] < 0 || o[0] > W || o[1] > H)) { undefinedPx = true; break; }
      tap(P, W, H, o[0], o[1], acc);
      putAcc(tmp, 0, acc, 1);
      if (perCh) { out[i + c] = tmp[c]; if (c === 1) out[i + 3] = tmp[3]; }
      else { out[i] = tmp[0]; out[i + 1] = tmp[1]; out[i + 2] = tmp[2]; out[i + 3] = tmp[3]; }
    }
    if (undefinedPx) {
      if (edge === 'black') { out[i] = out[i + 1] = out[i + 2] = 0; out[i + 3] = 255; }
      else if (edge === 'white') { out[i] = out[i + 1] = out[i + 2] = 255; out[i + 3] = 255; }
      else out[i] = out[i + 1] = out[i + 2] = out[i + 3] = 0;
    }
  }
  img.data.set(out);
  return img;
}
/** Homography that maps output normalized coords to source normalized coords for perspective / rotation / scale. */
export function perspectiveMatrix(p: { vert: number; horiz: number; angle: number; scale: number; offX?: number; offY?: number; aspect?: number }): DOMMatrix | number[] {
  // build forward matrix in normalized space (-1..1), then invert (3x3 as number[9])
  const a = (p.angle * Math.PI) / 180, s = p.scale / 100, v = p.vert / 100 * 0.6, hz = p.horiz / 100 * 0.6, asp = (p.aspect || 0) / 100;
  const R = [Math.cos(a), -Math.sin(a), 0, Math.sin(a), Math.cos(a), 0, 0, 0, 1];
  const S = [s * (1 + Math.max(0, asp)), 0, (p.offX || 0) / 100, 0, s * (1 - Math.min(0, asp)), (p.offY || 0) / 100, 0, 0, 1];
  const Pm = [1, 0, 0, 0, 1, 0, hz, v, 1];
  const F = mul3(S, mul3(R, Pm));
  return inv3(F);
}
export function mul3(a: number[], b: number[]) {
  const o = new Array(9).fill(0);
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) for (let k = 0; k < 3; k++) o[r * 3 + c] += a[r * 3 + k] * b[k * 3 + c];
  return o;
}
export function inv3(m: number[]) {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g, det = a * A + b * B + c * C || 1e-9;
  return [A / det, -(b * i - c * h) / det, (b * f - c * e) / det, B / det, (a * i - c * g) / det, -(a * f - c * d) / det, C / det, -(a * h - b * g) / det, (a * e - b * d) / det];
}
const lensCorrection: Kernel = (img, p) => {
  const W = img.width, H = img.height, cx = W / 2, cy = H / 2, R = Math.hypot(cx, cy);
  const Hm = perspectiveMatrix({ vert: p.vert, horiz: p.horiz, angle: p.angle, scale: p.scale }) as number[];
  const k = -p.distortion / 100 * 0.35;
  const ca = [p.caRed / 100 * 0.004, p.caGreen / 100 * 0.004, p.caBlue / 100 * 0.004];
  const map = (x: number, y: number, ch: number, o: number[]) => {
    // perspective / rotate / scale in normalized coords
    let u = (x - cx) / R, v = (y - cy) / R;
    const w = Hm[6] * u + Hm[7] * v + Hm[8];
    if (w <= 0.01) return false;
    const u2 = (Hm[0] * u + Hm[1] * v + Hm[2]) / w, v2 = (Hm[3] * u + Hm[4] * v + Hm[5]) / w;
    u = u2; v = v2;
    // radial distortion + chromatic aberration (per-channel radial scale)
    const r2 = u * u + v * v, f = (1 + k * r2) * (1 + (ch === 0 ? ca[0] - ca[1] : ch === 2 ? ca[2] - ca[1] : 0) * Math.sqrt(r2) * 10);
    o[0] = cx + u * f * R; o[1] = cy + v * f * R;
    return true;
  };
  (map as any).perChannel = p.caRed !== 0 || p.caBlue !== 0 || p.caGreen !== 0;
  channelRemap(img, map, p.edge);
  // vignette: brighten / darken towards the corners
  if (p.vignette) {
    const d = img.data, amt = p.vignette / 100, mid = 0.2 + (p.midpoint / 100) * 0.8;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const r = Math.hypot(x + 0.5 - cx, y + 0.5 - cy) / R, t = Math.max(0, (r - mid * 0.6) / (1 - mid * 0.6));
      const f = 1 + amt * t * t, i = (y * W + x) * 4;
      d[i] = Math.min(255, d[i] * f); d[i + 1] = Math.min(255, d[i + 1] * f); d[i + 2] = Math.min(255, d[i + 2] * f);
    }
  }
  return img;
};
/** Adaptive Wide Angle: fisheye / perspective / spherical to rectilinear with constraint-derived rotation. */
const wideAngle: Kernel = (img, p) => {
  const W = img.width, H = img.height, src = cloneImage(img);
  const diag = Math.hypot(W, H), f = (p.focal / (43.27 / (p.crop || 1))) * diag;     // focal length in px (35mm equiv. diagonal 43.27mm)
  const cx = W / 2 + (p.offX || 0) * W / 200, cy = H / 2 + (p.offY || 0) * H / 200, sc = p.scale / 100, rot = ((p.rotate || 0) * Math.PI) / 180;
  const cr = Math.cos(rot), sr = Math.sin(rot);
  const map = (x: number, y: number, _c: number, o: number[]) => {
    // output (rectilinear) → ray → input (fisheye/perspective/equirect)
    let u = (x - W / 2) / sc, v = (y - H / 2) / sc;
    [u, v] = [u * cr - v * sr, u * sr + v * cr];
    if (p.mode === 'spherical') {
      const yaw = (p.yaw * Math.PI) / 180, pitch = (p.pitch * Math.PI) / 180, fov = (p.fov * Math.PI) / 180, fl = (W / 2) / Math.tan(fov / 2);
      let dx = u, dy = v, dz = fl;
      const cp = Math.cos(pitch), sp = Math.sin(pitch); [dy, dz] = [dy * cp - dz * sp, dy * sp + dz * cp];
      const cyw = Math.cos(yaw), syw = Math.sin(yaw); [dx, dz] = [dx * cyw + dz * syw, -dx * syw + dz * cyw];
      const lon = Math.atan2(dx, dz), lat = Math.atan2(dy, Math.hypot(dx, dz));
      o[0] = (lon / (2 * Math.PI) + 0.5) * src.width; o[1] = (lat / Math.PI + 0.5) * src.height;
      return true;
    }
    const r = Math.hypot(u, v);
    if (p.mode === 'fisheye' || (p.mode === 'auto' && p.focal < 16)) {
      const theta = Math.atan2(r, f);                     // angle of the ray
      const rd = f * theta;                                // equidistant fisheye
      const k = r > 0 ? rd / r : 1;
      o[0] = cx + u * k; o[1] = cy + v * k;
    } else {
      // perspective (rectilinear in) with mild barrel correction from focal length
      const k = 1 + (r / f) * (r / f) * (0.08 * (24 / Math.max(8, p.focal)));
      o[0] = cx + u / k; o[1] = cy + v / k;
    }
    return true;
  };
  channelRemap(img, map, p.edge || 'transparent');
  return img;
};

export const specialKernels: Record<string, Kernel> = { liquify, 'lens-correction': lensCorrection, 'wide-angle': wideAngle };
