// Colour spaces for colour management: RGB matrix profiles (primaries + white point + tone curve) and gray profiles,
// XYZ conversion with Bradford chromatic adaptation, rendering intents (perceptual gamut compression, relative /
// absolute colorimetric, saturation), 3D LUTs for fast display conversion, and embedded ICC profile identification
// (PNG iCCP, JPEG APP2) by the profile description.
export type Trc = { t: 'srgb' } | { t: 'gamma'; g: number } | { t: 'rec709' } | { t: 'romm' } | { t: 'linear' };
export interface Profile { id: string; name: string; kind: 'rgb' | 'gray'; prim?: [number, number][]; white: [number, number]; trc: Trc }
const D65: [number, number] = [0.3127, 0.329], D50: [number, number] = [0.3457, 0.3585];
export const PROFILES: Profile[] = [
  { id: 'srgb', name: 'sRGB IEC61966-2.1', kind: 'rgb', prim: [[0.64, 0.33], [0.3, 0.6], [0.15, 0.06]], white: D65, trc: { t: 'srgb' } },
  { id: 'p3', name: 'Display P3', kind: 'rgb', prim: [[0.68, 0.32], [0.265, 0.69], [0.15, 0.06]], white: D65, trc: { t: 'srgb' } },
  { id: 'clay', name: 'ClayRGB (1998-compatible wide gamut)', kind: 'rgb', prim: [[0.64, 0.33], [0.21, 0.71], [0.15, 0.06]], white: D65, trc: { t: 'gamma', g: 563 / 256 } },
  { id: 'romm', name: 'ROMM RGB (ProPhoto-compatible)', kind: 'rgb', prim: [[0.7347, 0.2653], [0.1596, 0.8404], [0.0366, 0.0001]], white: D50, trc: { t: 'romm' } },
  { id: 'rec2020', name: 'ITU-R BT.2020', kind: 'rgb', prim: [[0.708, 0.292], [0.17, 0.797], [0.131, 0.046]], white: D65, trc: { t: 'rec709' } },
  { id: 'rec709', name: 'ITU-R BT.709', kind: 'rgb', prim: [[0.64, 0.33], [0.3, 0.6], [0.15, 0.06]], white: D65, trc: { t: 'rec709' } },
  { id: 'linear', name: 'Linear sRGB', kind: 'rgb', prim: [[0.64, 0.33], [0.3, 0.6], [0.15, 0.06]], white: D65, trc: { t: 'linear' } },
  { id: 'gray22', name: 'Gray Gamma 2.2', kind: 'gray', white: D65, trc: { t: 'gamma', g: 2.2 } },
  { id: 'gray18', name: 'Gray Gamma 1.8', kind: 'gray', white: D50, trc: { t: 'gamma', g: 1.8 } },
  { id: 'sgray', name: 'sGray (sRGB curve)', kind: 'gray', white: D65, trc: { t: 'srgb' } },
];
export const profileById = (id?: string | null) => PROFILES.find(p => p.id === id) || null;

// ------------------------------------------------------------------ tone curves
export function decode(trc: Trc, v: number): number {
  switch (trc.t) {
    case 'srgb': return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    case 'gamma': return v <= 0 ? 0 : v ** trc.g;
    case 'rec709': return v < 0.081 ? v / 4.5 : ((v + 0.099) / 1.099) ** (1 / 0.45);
    case 'romm': return v < 16 * 0.001953 ? v / 16 : v ** 1.8;
    default: return v;
  }
}
export function encode(trc: Trc, v: number): number {
  if (v <= 0) return 0;
  switch (trc.t) {
    case 'srgb': return v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055;
    case 'gamma': return v ** (1 / trc.g);
    case 'rec709': return v < 0.018 ? v * 4.5 : 1.099 * v ** 0.45 - 0.099;
    case 'romm': return v < 0.001953 ? v * 16 : v ** (1 / 1.8);
    default: return v;
  }
}

// ------------------------------------------------------------------ matrices
type M = number[];                                          // 3×3 row-major
const mul = (a: M, b: M): M => { const o = new Array(9).fill(0); for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) for (let k = 0; k < 3; k++) o[r * 3 + c] += a[r * 3 + k] * b[k * 3 + c]; return o; };
const inv = (m: M): M => {
  const [a, b, c, d, e, f, g, h, i] = m, A = e * i - f * h, B = f * g - d * i, C = d * h - e * g, det = a * A + b * B + c * C;
  return [A / det, (c * h - b * i) / det, (b * f - c * e) / det, B / det, (a * i - c * g) / det, (c * d - a * f) / det, C / det, (b * g - a * h) / det, (a * e - b * d) / det];
};
const apply = (m: M, v: number[]) => [m[0] * v[0] + m[1] * v[1] + m[2] * v[2], m[3] * v[0] + m[4] * v[1] + m[5] * v[2], m[6] * v[0] + m[7] * v[1] + m[8] * v[2]];
const xyz = ([x, y]: [number, number]) => [x / y, 1, (1 - x - y) / y];
/** Linear RGB → XYZ for a profile (columns scaled so white maps to the white point). */
export function rgbToXYZ(p: Profile): M {
  if (!p.prim) return [1, 0, 0, 0, 1, 0, 0, 0, 1];            // gray profiles are handled through luminance
  const [r, g, b] = p.prim.map(xyz), P = [r[0], g[0], b[0], r[1], g[1], b[1], r[2], g[2], b[2]];
  const S = apply(inv(P), xyz(p.white));
  return [P[0] * S[0], P[1] * S[1], P[2] * S[2], P[3] * S[0], P[4] * S[1], P[5] * S[2], P[6] * S[0], P[7] * S[1], P[8] * S[2]];
}
const BRADFORD: M = [0.8951, 0.2664, -0.1614, -0.7502, 1.7135, 0.0367, 0.0389, -0.0685, 1.0296];
/** Bradford chromatic adaptation from white w1 to white w2. */
export function adapt(w1: [number, number], w2: [number, number]): M {
  if (w1[0] === w2[0] && w1[1] === w2[1]) return [1, 0, 0, 0, 1, 0, 0, 0, 1];
  const a = apply(BRADFORD, xyz(w1)), b = apply(BRADFORD, xyz(w2));
  return mul(inv(BRADFORD), mul([b[0] / a[0], 0, 0, 0, b[1] / a[1], 0, 0, 0, b[2] / a[2]], BRADFORD));
}

// ------------------------------------------------------------------ converters
export type Intent = 'perceptual' | 'relative' | 'saturation' | 'absolute';
/** Converter for 0..1 floats: (r,g,b) in src encoding → (r,g,b) in dst encoding (gray profiles use r=g=b). */
export function converter(src: Profile, dst: Profile, intent: Intent): (r: number, g: number, b: number, out: number[]) => void {
  const toXYZ = src.kind === 'rgb' ? rgbToXYZ(src) : null;
  const A = intent === 'absolute' ? [1, 0, 0, 0, 1, 0, 0, 0, 1] : adapt(src.white, dst.white);
  const fromXYZ = dst.kind === 'rgb' ? inv(rgbToXYZ(dst)) : null;
  const M = toXYZ && fromXYZ ? mul(fromXYZ, mul(A, toXYZ)) : null;
  const wSrc = xyz(src.white);
  const lumDst = fromXYZ ? rgbToXYZ(dst).slice(3, 6) : [0, 1, 0];     // Y row of the destination → luminance weights
  const knee = 0.8;
  return (r, g, b, out) => {
    let lr: number, lg: number, lb: number;
    if (src.kind === 'gray') { const L = decode(src.trc, r); const X = apply(A, [wSrc[0] * L, L, wSrc[2] * L]); if (fromXYZ) [lr, lg, lb] = apply(fromXYZ, X); else lr = lg = lb = X[1]; }
    else if (dst.kind === 'gray') { const X = apply(A, apply(toXYZ!, [decode(src.trc, r), decode(src.trc, g), decode(src.trc, b)])); lr = lg = lb = X[1]; }
    else [lr, lg, lb] = apply(M!, [decode(src.trc, r), decode(src.trc, g), decode(src.trc, b)]);
    if (dst.kind === 'rgb' && (intent === 'perceptual' || intent === 'saturation' || lr < 0 || lg < 0 || lb < 0 || lr > 1 || lg > 1 || lb > 1)) {
      if (intent === 'saturation') {
        // vivid: slightly boost chroma, then clip each channel
        const Y = lumDst[0] * lr + lumDst[1] * lg + lumDst[2] * lb;
        lr = Y + (lr - Y) * 1.08; lg = Y + (lg - Y) * 1.08; lb = Y + (lb - Y) * 1.08;
      } else if (intent !== 'perceptual') { /* relative / absolute colorimetric: per-channel clipping below (standard for matrix profiles) */ }
      else {
        let Y = lumDst[0] * lr + lumDst[1] * lg + lumDst[2] * lb;
        Y = Math.min(1, Math.max(0, Y));
        const d = [lr - Y, lg - Y, lb - Y];
        let lam = Infinity;
        for (const c of d) { if (c > 1e-9) lam = Math.min(lam, (1 - Y) / c); else if (c < -1e-9) lam = Math.min(lam, -Y / c); }
        const rr = lam === Infinity ? 0 : 1 / lam;                  // chroma relative to the gamut boundary (≤1 = inside)
        let s = 1;
        if (rr > knee) s = (knee + (1 - knee) * Math.tanh((rr - knee) / (1 - knee))) / rr;
        lr = Y + d[0] * s; lg = Y + d[1] * s; lb = Y + d[2] * s;
      }
    }
    out[0] = encode(dst.trc, Math.min(1, Math.max(0, lr)));
    out[1] = encode(dst.trc, Math.min(1, Math.max(0, lg)));
    out[2] = encode(dst.trc, Math.min(1, Math.max(0, lb)));
  };
}
/** Convert RGBA bytes in place (exact per pixel with a 256-entry cache per unique colour run; optional dither). */
export function convertPixels(d: Uint8ClampedArray, src: Profile, dst: Profile, intent: Intent, dither: boolean) {
  const f = converter(src, dst, intent), o = [0, 0, 0];
  const cache = new Map<number, number>();
  let seed = 12345;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] === 0) continue;
    const key = (d[i] << 16) | (d[i + 1] << 8) | d[i + 2];
    let v = dither ? undefined : cache.get(key);
    if (v === undefined) {
      f(d[i] / 255, d[i + 1] / 255, d[i + 2] / 255, o);
      if (dither) { const n = rnd() - rnd(); d[i] = o[0] * 255 + n * 0.5; d[i + 1] = o[1] * 255 + n * 0.5; d[i + 2] = o[2] * 255 + n * 0.5; continue; }
      v = (Math.round(o[0] * 255) << 16) | (Math.round(o[1] * 255) << 8) | Math.round(o[2] * 255);
      if (cache.size < 200000) cache.set(key, v);
    }
    d[i] = v >> 16; d[i + 1] = (v >> 8) & 255; d[i + 2] = v & 255;
  }
}
/** 33³ LUT (bytes in, bytes out) for fast whole-image conversion (display). */
export function buildLUT(src: Profile, dst: Profile, intent: Intent): (d: Uint8ClampedArray) => void {
  const N = 33, S = 255 / (N - 1), t = new Float32Array(N * N * N * 3), f = converter(src, dst, intent), o = [0, 0, 0];
  for (let b = 0, k = 0; b < N; b++) for (let g = 0; g < N; g++) for (let r = 0; r < N; r++, k += 3) { f((r * S) / 255, (g * S) / 255, (b * S) / 255, o); t[k] = o[0] * 255; t[k + 1] = o[1] * 255; t[k + 2] = o[2] * 255; }
  return d => {
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] === 0) continue;
      const fr = d[i] / S, fg = d[i + 1] / S, fb = d[i + 2] / S;
      const r0 = Math.min(N - 2, fr | 0), g0 = Math.min(N - 2, fg | 0), b0 = Math.min(N - 2, fb | 0), xr = fr - r0, xg = fg - g0, xb = fb - b0;
      const i000 = ((b0 * N + g0) * N + r0) * 3, dr = 3, dg = N * 3, db = N * N * 3;
      for (let c = 0; c < 3; c++) {
        const p = i000 + c;
        const c00 = t[p] + (t[p + dr] - t[p]) * xr, c10 = t[p + dg] + (t[p + dg + dr] - t[p + dg]) * xr;
        const c01 = t[p + db] + (t[p + db + dr] - t[p + db]) * xr, c11 = t[p + db + dg] + (t[p + db + dg + dr] - t[p + db + dg]) * xr;
        const c0 = c00 + (c10 - c00) * xg, c1 = c01 + (c11 - c01) * xg;
        d[i + c] = c0 + (c1 - c0) * xb;
      }
    }
  };
}

// ------------------------------------------------------------------ embedded ICC profiles
/** Identify the embedded ICC profile of a PNG / JPEG / WebP by its description. null = none or unreadable. */
export async function embeddedProfile(blob: Blob): Promise<{ id: string | null; desc: string } | null> {
  try {
    const buf = new Uint8Array(await blob.slice(0, Math.min(blob.size, 4 * 1024 * 1024)).arrayBuffer());
    let icc: Uint8Array | null = null;
    if (buf[0] === 0x89 && buf[1] === 0x50) {                         // PNG
      let o = 8;
      while (o + 8 < buf.length) {
        const len = (buf[o] << 24) | (buf[o + 1] << 16) | (buf[o + 2] << 8) | buf[o + 3], type = String.fromCharCode(buf[o + 4], buf[o + 5], buf[o + 6], buf[o + 7]);
        if (type === 'sRGB') return { id: 'srgb', desc: 'sRGB' };
        if (type === 'iCCP') {
          const data = buf.subarray(o + 8, o + 8 + len), z = data.indexOf(0);
          const comp = data.subarray(z + 2);
          const ds = new (window as any).DecompressionStream('deflate');
          icc = new Uint8Array(await new Response(new Blob([comp]).stream().pipeThrough(ds)).arrayBuffer());
          break;
        }
        if (type === 'IDAT') break;
        o += 12 + len;
      }
    } else if (buf[0] === 0xff && buf[1] === 0xd8) {                  // JPEG: APP2 "ICC_PROFILE\0" segments
      const parts: Uint8Array[] = [];
      let o = 2;
      while (o + 4 < buf.length && buf[o] === 0xff) {
        const m = buf[o + 1], len = (buf[o + 2] << 8) | buf[o + 3];
        if (m === 0xda) break;
        if (m === 0xe2 && String.fromCharCode(...buf.subarray(o + 4, o + 15)) === 'ICC_PROFILE') parts[buf[o + 16] - 1] = buf.subarray(o + 18, o + 2 + len);
        o += 2 + len;
      }
      if (parts.length) { const n = parts.reduce((s, p) => s + (p?.length || 0), 0); icc = new Uint8Array(n); let k = 0; for (const p of parts) if (p) { icc.set(p, k); k += p.length; } }
    }
    if (!icc || icc.length < 132) return null;
    const dv = new DataView(icc.buffer, icc.byteOffset, icc.byteLength), count = dv.getUint32(128);
    let desc = '';
    for (let i = 0; i < count; i++) {
      const sig = String.fromCharCode(...icc.subarray(132 + i * 12, 136 + i * 12)), off = dv.getUint32(136 + i * 12), size = dv.getUint32(140 + i * 12);
      if (sig !== 'desc') continue;
      const type = String.fromCharCode(...icc.subarray(off, off + 4));
      if (type === 'desc') { const n = dv.getUint32(off + 8); desc = String.fromCharCode(...icc.subarray(off + 12, off + 12 + Math.max(0, n - 1))); }
      else if (type === 'mluc') { const recOff = off + 16, len = dv.getUint32(recOff + 4), so = dv.getUint32(recOff + 8); for (let k = 0; k < len; k += 2) desc += String.fromCharCode(dv.getUint16(off + so + k)); }
      void size;
    }
    const s = desc.toLowerCase();
    const id = /display p3|p3/.test(s) ? 'p3' : /adobe rgb|clayrgb|1998/.test(s) ? 'clay' : /prophoto|romm/.test(s) ? 'romm' : /2020/.test(s) ? 'rec2020' : /709/.test(s) ? 'rec709' : /srgb/.test(s) ? 'srgb' : /gray gamma 2\.2|gamma 2\.2/.test(s) ? 'gray22' : /gray gamma 1\.8/.test(s) ? 'gray18' : null;
    return { id, desc: desc || 'Unnamed profile' };
  } catch { return null; }
}
