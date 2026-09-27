// Content-Aware Scale: seam carving on a reduced copy produces a smooth source-coordinate map, which is then
// blended with plain scaling ("Amount") and used to resample the full-resolution image.
import { type Kernel, premul, tap, putAcc } from './core';

/** Column map after retargeting a (w × h) energy field to width tw: map[y * tw + x] = source column (float). */
function retargetRows(energy: Float32Array, w: number, h: number, tw: number): Float32Array {
  const out = new Float32Array(tw * h);
  if (tw === w) { for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) out[y * tw + x] = x; return out; }
  // working copies: energy and original column index per cell, compacted as seams are removed
  let cw = w;
  const E = new Float32Array(energy), I = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) I[y * w + x] = x;
  const M = new Float32Array(w * h), back = new Int8Array(w * h);
  const removeCount = tw < w ? w - tw : Math.min(w - 1, tw - w);
  const seams: Float32Array[] = [];          // for enlarging: original column of each removed seam per row
  for (let s = 0; s < removeCount; s++) {
    // dynamic programming (row-major, stride w, current width cw)
    for (let x = 0; x < cw; x++) M[x] = E[x];
    for (let y = 1; y < h; y++) {
      const o = y * w, p = o - w;
      for (let x = 0; x < cw; x++) {
        let best = M[p + x], b = 0;
        if (x > 0 && M[p + x - 1] < best) { best = M[p + x - 1]; b = -1; }
        if (x < cw - 1 && M[p + x + 1] < best) { best = M[p + x + 1]; b = 1; }
        M[o + x] = E[o + x] + best; back[o + x] = b;
      }
    }
    let x = 0, bv = Infinity;
    const lo = (h - 1) * w;
    for (let i = 0; i < cw; i++) if (M[lo + i] < bv) { bv = M[lo + i]; x = i; }
    const seam = new Float32Array(h);
    for (let y = h - 1; y >= 0; y--) {
      const o = y * w;
      seam[y] = I[o + x];
      // neighbours of the removed cell get part of its energy so the next seam does not hug the same path
      const e = E[o + x];
      if (x > 0) E[o + x - 1] += e * 0.5; if (x < cw - 1) E[o + x + 1] += e * 0.5;
      E.copyWithin(o + x, o + x + 1, o + cw); I.copyWithin(o + x, o + x + 1, o + cw);
      if (y > 0) x = Math.max(0, Math.min(cw - 1, x + back[o + x]));
    }
    seams.push(seam);
    cw--;
  }
  if (tw < w) {
    for (let y = 0; y < h; y++) for (let x = 0; x < tw; x++) out[y * tw + x] = I[y * w + x];
    return out;
  }
  // enlarge: duplicate the lowest-energy seams (each inserted between its column and the next)
  for (let y = 0; y < h; y++) {
    const dup = new Float32Array(w);
    for (const s of seams) dup[Math.round(s[y])]++;
    let k = 0;
    for (let x = 0; x < w && k < tw; x++) {
      out[y * tw + k++] = x;
      for (let d = 0; d < dup[x] && k < tw; d++) out[y * tw + k++] = x + (d + 1) / (dup[x] + 1);
    }
    while (k < tw) { out[y * tw + k] = w - 1; k++; }
  }
  return out;
}
/** Energy: colour gradient (sum over R, G, B + alpha edges) boosted by protection masks. */
function energyOf(ch: Float32Array[], a: Float32Array, w: number, h: number, protect: Float32Array | null, skin: Uint8Array | null): Float32Array {
  const E = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const yu = Math.max(0, y - 1) * w, yd = Math.min(h - 1, y + 1) * w, o = y * w;
    for (let x = 0; x < w; x++) {
      const i = o + x, xl = o + Math.max(0, x - 1), xr = o + Math.min(w - 1, x + 1);
      let e = 0;
      for (const c of ch) e += Math.abs(c[xr] - c[xl]) + Math.abs(c[yd + x] - c[yu + x]);
      E[i] = e * 0.5 + Math.abs(a[xr] - a[xl]) * 2;
      if (protect && protect[i] > 0.5) E[i] += 1e5 * protect[i];
      if (skin && skin[i]) E[i] += 2e4;
    }
  }
  return E;
}
const transpose = (a: Float32Array, w: number, h: number) => { const o = new Float32Array(w * h); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) o[x * h + y] = a[y * w + x]; return o; };
function sampleF(a: Float32Array, w: number, h: number, x: number, y: number) {
  x = Math.max(0, Math.min(w - 1, x)); y = Math.max(0, Math.min(h - 1, y));
  const x0 = x | 0, y0 = y | 0, x1 = Math.min(w - 1, x0 + 1), y1 = Math.min(h - 1, y0 + 1), fx = x - x0, fy = y - y0;
  return (a[y0 * w + x0] * (1 - fx) + a[y0 * w + x1] * fx) * (1 - fy) + (a[y1 * w + x0] * (1 - fx) + a[y1 * w + x1] * fx) * fy;
}

export const contentAwareScale: Kernel = (img, p, m) => {
  const W = img.width, H = img.height, TW = Math.max(1, Math.round(p.tw)), TH = Math.max(1, Math.round(p.th));
  const f = Math.max(1, Math.max(W, H) / (m.preview ? 320 : 640));
  const sw = Math.max(2, Math.round(W / f)), sh = Math.max(2, Math.round(H / f));
  const stw = Math.max(1, Math.round((TW / W) * sw)), sth = Math.max(1, Math.round((TH / H) * sh));
  // reduced colour / alpha
  const R = new Float32Array(sw * sh), G = new Float32Array(sw * sh), B = new Float32Array(sw * sh), A = new Float32Array(sw * sh), cnt = new Float32Array(sw * sh), d = img.data;
  const skinOn = !!p.skin, S = skinOn ? new Float32Array(sw * sh) : null;
  for (let y = 0; y < H; y++) { const sy = Math.min(sh - 1, (y / f) | 0); for (let x = 0; x < W; x++) {
    const sx = Math.min(sw - 1, (x / f) | 0), k = sy * sw + sx, i = (y * W + x) * 4, r = d[i], g = d[i + 1], b = d[i + 2];
    R[k] += r; G[k] += g; B[k] += b; A[k] += d[i + 3]; cnt[k]++;
    if (S) { const cb = 128 - 0.1687 * r - 0.3313 * g + 0.5 * b, cr = 128 + 0.5 * r - 0.4187 * g - 0.0813 * b; if (cr > 135 && cr < 173 && cb > 77 && cb < 127 && r > g) S[k]++; }
  } }
  for (let k = 0; k < A.length; k++) { const n = cnt[k] || 1; R[k] /= n; G[k] /= n; B[k] /= n; A[k] /= n; }
  const skin = S ? Uint8Array.from(S, (v, k) => (v / (cnt[k] || 1) > 0.5 ? 1 : 0)) : null;
  let prot: Float32Array | null = null;
  const pm: Uint8Array | undefined = m.aux?.protect;
  if (pm && pm.length === W * H) { prot = new Float32Array(sw * sh); for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const k = Math.min(sh - 1, (y / f) | 0) * sw + Math.min(sw - 1, (x / f) | 0); prot[k] += pm[y * W + x] / 255; } for (let k = 0; k < prot.length; k++) prot[k] /= cnt[k] || 1; }
  // pass 1: widths (per row), pass 2: heights on the width-retargeted field (transposed)
  const X = retargetRows(energyOf([R, G, B], A, sw, sh, prot, skin), sw, sh, stw);            // sh rows × stw
  const C2 = [0, 1, 2].map(() => new Float32Array(stw * sh)), A2 = new Float32Array(stw * sh), P2 = prot ? new Float32Array(stw * sh) : null, S2 = skin ? new Uint8Array(stw * sh) : null;
  for (let y = 0; y < sh; y++) for (let x = 0; x < stw; x++) {
    const sx = X[y * stw + x], k = y * stw + x;
    C2[0][k] = sampleF(R, sw, sh, sx, y); C2[1][k] = sampleF(G, sw, sh, sx, y); C2[2][k] = sampleF(B, sw, sh, sx, y); A2[k] = sampleF(A, sw, sh, sx, y);
    if (P2) P2[k] = sampleF(prot!, sw, sh, sx, y);
    if (S2) S2[k] = skin![y * sw + Math.round(sx)];
  }
  const Ey = transpose(energyOf(C2, A2, stw, sh, P2, S2), stw, sh);                     // stw rows × sh
  const Yt = retargetRows(Ey, sh, stw, sth);                                          // stw rows × sth
  const amt = Math.max(0, Math.min(1, (p.amount ?? 100) / 100));
  // full-resolution resample
  const out = new ImageData(TW, TH), od = out.data, P = premul(img), acc = new Float64Array(4);
  const kx = stw / TW, ky = sth / TH;
  for (let Y = 0; Y < TH; Y++) {
    const sy2 = (Y + 0.5) * ky - 0.5;
    for (let Xo = 0; Xo < TW; Xo++) {
      const sx2 = (Xo + 0.5) * kx - 0.5;
      // intermediate row (in the width-retargeted field), then source column
      const yi = sampleF(Yt, sth, stw, sy2, sx2);
      const xs = sampleF(X, stw, sh, sx2, yi);
      const cx = (xs + 0.5) * (W / sw), cy = (yi + 0.5) * (H / sh);
      const ux = ((Xo + 0.5) * W) / TW, uy = ((Y + 0.5) * H) / TH;
      tap(P, W, H, ux + (cx - ux) * amt, uy + (cy - uy) * amt, acc);
      putAcc(od, (Y * TW + Xo) * 4, acc, 1);
    }
  }
  return out;
};
