// Healing math (pure, no DOM): membrane (Laplace) interpolation for seamless blending, the classic
// healing blend, Proximity Match search and Create Texture synthesis.
//
// Healing: inside the region Ω the result is  H = S + D  where S is the sampled texture and D is the smooth
// membrane that interpolates the boundary difference (Dest − Source) across Ω. This transfers the texture of S
// while matching the lighting/colour of the destination at the edges (Poisson/"seamless cloning" equivalent).

/**
 * Harmonic fill: pixels with unknown[i]=1 get values that smoothly interpolate the known neighbours.
 * `v` holds `ch` interleaved channels (in/out). Coarse-to-fine SOR (fast even for large regions).
 */
export function membrane(v: Float32Array, unknown: Uint8Array, w: number, h: number, ch = 3) {
  let count = 0;
  for (let i = 0; i < unknown.length; i++) count += unknown[i];
  if (!count) return;
  if (count === unknown.length) { v.fill(0); return; }
  if (w > 24 && h > 24 && count > 900) {
    const cw = Math.ceil(w / 2), chh = Math.ceil(h / 2);
    const cv = new Float32Array(cw * chh * ch), cu = new Uint8Array(cw * chh), n = new Uint8Array(cw * chh);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (unknown[i]) continue;
      const c = (y >> 1) * cw + (x >> 1);
      for (let k = 0; k < ch; k++) cv[c * ch + k] += v[i * ch + k];
      n[c]++;
    }
    for (let c = 0; c < cu.length; c++) {
      if (n[c]) for (let k = 0; k < ch; k++) cv[c * ch + k] /= n[c];
      else cu[c] = 1;
    }
    membrane(cv, cu, cw, chh, ch);
    // bilinear upsample as the initial guess
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!unknown[i]) continue;
      const fx = Math.min(cw - 1, Math.max(0, (x - 0.5) / 2)), fy = Math.min(chh - 1, Math.max(0, (y - 0.5) / 2));
      const x0 = Math.floor(fx), y0 = Math.floor(fy), x1 = Math.min(cw - 1, x0 + 1), y1 = Math.min(chh - 1, y0 + 1);
      const ax = fx - x0, ay = fy - y0;
      for (let k = 0; k < ch; k++) {
        const a = cv[(y0 * cw + x0) * ch + k], b = cv[(y0 * cw + x1) * ch + k], c = cv[(y1 * cw + x0) * ch + k], d = cv[(y1 * cw + x1) * ch + k];
        v[i * ch + k] = (a * (1 - ax) + b * ax) * (1 - ay) + (c * (1 - ax) + d * ax) * ay;
      }
    }
    relax(v, unknown, w, h, ch, 40);
  } else {
    // small: start from the mean of the known values and relax a lot
    const mean = new Float64Array(ch); let m = 0;
    for (let i = 0; i < unknown.length; i++) if (!unknown[i]) { for (let k = 0; k < ch; k++) mean[k] += v[i * ch + k]; m++; }
    for (let i = 0; i < unknown.length; i++) if (unknown[i]) for (let k = 0; k < ch; k++) v[i * ch + k] = mean[k] / m;
    relax(v, unknown, w, h, ch, Math.min(400, 4 * Math.max(w, h) + 40));
  }
}

function relax(v: Float32Array, unknown: Uint8Array, w: number, h: number, ch: number, iters: number) {
  const list: number[] = [];
  for (let i = 0; i < unknown.length; i++) if (unknown[i]) list.push(i);
  const idx = Int32Array.from(list);
  const omega = 1.85;
  for (let it = 0; it < iters; it++) {
    for (let t = 0; t < idx.length; t++) {
      const i = idx[t], x = i % w, y = (i - x) / w;
      for (let k = 0; k < ch; k++) {
        let s = 0, n = 0;
        if (x > 0) { s += v[(i - 1) * ch + k]; n++; }
        if (x < w - 1) { s += v[(i + 1) * ch + k]; n++; }
        if (y > 0) { s += v[(i - w) * ch + k]; n++; }
        if (y < h - 1) { s += v[(i + w) * ch + k]; n++; }
        const o = i * ch + k;
        v[o] += omega * (s / n - v[o]);
      }
    }
  }
}

/** Box blur of the RGB channels of an RGBA byte image into a float RGB array (radius r; 0 = copy). */
export function blurRGB(img: Uint8ClampedArray, w: number, h: number, r: number): Float32Array {
  const out = new Float32Array(w * h * 3);
  for (let i = 0, j = 0; i < w * h; i++, j += 4) { out[i * 3] = img[j]; out[i * 3 + 1] = img[j + 1]; out[i * 3 + 2] = img[j + 2]; }
  if (r <= 0) return out;
  const tmp = new Float32Array(out.length);
  for (let pass = 0; pass < 2; pass++) {
    for (let y = 0; y < h; y++) for (let k = 0; k < 3; k++) {
      let s = 0, n = 0;
      for (let x = 0; x <= Math.min(r, w - 1); x++) { s += out[(y * w + x) * 3 + k]; n++; }
      for (let x = 0; x < w; x++) {
        tmp[(y * w + x) * 3 + k] = s / n;
        if (x + r + 1 < w) { s += out[(y * w + x + r + 1) * 3 + k]; n++; }
        if (x - r >= 0) { s -= out[(y * w + x - r) * 3 + k]; n--; }
      }
    }
    for (let x = 0; x < w; x++) for (let k = 0; k < 3; k++) {
      let s = 0, n = 0;
      for (let y = 0; y <= Math.min(r, h - 1); y++) { s += tmp[(y * w + x) * 3 + k]; n++; }
      for (let y = 0; y < h; y++) {
        out[(y * w + x) * 3 + k] = s / n;
        if (y + r + 1 < h) { s += tmp[((y + r + 1) * w + x) * 3 + k]; n++; }
        if (y - r >= 0) { s -= tmp[((y - r) * w + x) * 3 + k]; n--; }
      }
    }
  }
  return out;
}

/**
 * Heal: returns RGBA where Ω (region[i]=1) = S + membrane(D), elsewhere = O.
 * diffusion 1..7: how quickly the pasted texture adapts (boundary difference is low-passed by radius diffusion−1).
 */
export function healBlend(O: Uint8ClampedArray, S: Uint8ClampedArray, region: Uint8Array, w: number, h: number, diffusion = 5): Uint8ClampedArray {
  const r = Math.max(0, Math.round(diffusion) - 1);
  const ob = blurRGB(O, w, h, r), sb = blurRGB(S, w, h, r);
  const D = new Float32Array(w * h * 3);
  for (let i = 0; i < w * h; i++) if (!region[i]) for (let k = 0; k < 3; k++) D[i * 3 + k] = ob[i * 3 + k] - sb[i * 3 + k];
  membrane(D, region, w, h, 3);
  const out = new Uint8ClampedArray(O);
  for (let i = 0; i < w * h; i++) {
    if (!region[i]) continue;
    const j = i * 4;
    out[j] = S[j] + D[i * 3]; out[j + 1] = S[j + 1] + D[i * 3 + 1]; out[j + 2] = S[j + 2] + D[i * 3 + 2];
    out[j + 3] = Math.max(O[j + 3], S[j + 3]);
  }
  return out;
}

/** Bounding box of region pixels. */
export function regionBounds(region: Uint8Array, w: number, h: number) {
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (region[y * w + x]) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; y1 = y; }
  return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

/** Morphological dilation of a binary mask by radius r (square). */
export function dilate(m: Uint8Array, w: number, h: number, r: number): Uint8Array {
  if (r <= 0) return m.slice();
  const tmp = new Uint8Array(m.length), out = new Uint8Array(m.length);
  for (let y = 0; y < h; y++) {
    let last = -1e9;
    for (let x = 0; x < w; x++) { if (m[y * w + x]) last = x; if (x - last <= r) tmp[y * w + x] = 1; }
    last = 1e9;
    for (let x = w - 1; x >= 0; x--) { if (m[y * w + x]) last = x; if (last - x <= r) tmp[y * w + x] = 1; }
  }
  for (let x = 0; x < w; x++) {
    let last = -1e9;
    for (let y = 0; y < h; y++) { if (tmp[y * w + x]) last = y; if (y - last <= r) out[y * w + x] = 1; }
    last = 1e9;
    for (let y = h - 1; y >= 0; y--) { if (tmp[y * w + x]) last = y; if (last - y <= r) out[y * w + x] = 1; }
  }
  return out;
}

/**
 * Proximity Match: the offset (dx,dy) whose shifted content best matches the ring of pixels around the region.
 * Candidates lie on rings 1–2.5× the region size in 24 directions, then refined locally.
 */
export function proximityOffset(img: Uint8ClampedArray, region: Uint8Array, w: number, h: number): { dx: number; dy: number } | null {
  const b = regionBounds(region, w, h);
  if (!b) return null;
  const band = dilate(region, w, h, 4);
  const ring: number[] = [];
  for (let i = 0; i < band.length; i++) if (band[i] && !region[i]) ring.push(i);
  const inner: number[] = [];
  for (let i = 0; i < region.length; i++) if (region[i]) inner.push(i);
  const stepR = Math.max(1, Math.floor(ring.length / 1500)), stepI = Math.max(1, Math.floor(inner.length / 1500));
  const score = (dx: number, dy: number): number => {
    if (b.x + dx - 4 < 0 || b.y + dy - 4 < 0 || b.x + b.w + dx + 4 > w || b.y + b.h + dy + 4 > h) return Infinity;
    // the source must not overlap the region itself
    for (let t = 0; t < inner.length; t += stepI) { const i = inner[t], x = i % w, y = (i - x) / w; if (region[(y + dy) * w + x + dx]) return Infinity; }
    let s = 0;
    for (let t = 0; t < ring.length; t += stepR) {
      const i = ring[t], x = i % w, y = (i - x) / w, j = i * 4, k = ((y + dy) * w + x + dx) * 4;
      const a = img[j] - img[k], bb = img[j + 1] - img[k + 1], c = img[j + 2] - img[k + 2];
      s += a * a + bb * bb + c * c;
    }
    // prefer nearby sources a little
    return s * (1 + Math.hypot(dx, dy) / (8 * Math.max(b.w, b.h) + 32));
  };
  let best = { dx: 0, dy: 0, s: Infinity };
  const size = Math.max(b.w, b.h);
  for (const f of [1.0, 1.35, 1.8, 2.5]) for (let a = 0; a < 24; a++) {
    const ang = (a / 24) * Math.PI * 2;
    const dx = Math.round(Math.cos(ang) * size * f + Math.sign(Math.cos(ang)) * 3), dy = Math.round(Math.sin(ang) * size * f + Math.sign(Math.sin(ang)) * 3);
    const s = score(dx, dy);
    if (s < best.s) best = { dx, dy, s };
  }
  if (!Number.isFinite(best.s)) return null;
  for (let step = Math.max(1, Math.round(size / 8)); step >= 1; step >>= 1) {
    let improved = true;
    while (improved) {
      improved = false;
      for (const [ox, oy] of [[step, 0], [-step, 0], [0, step], [0, -step]]) {
        const s = score(best.dx + ox, best.dy + oy);
        if (s < best.s) { best = { dx: best.dx + ox, dy: best.dy + oy, s }; improved = true; }
      }
    }
  }
  return { dx: best.dx, dy: best.dy };
}

/** Image shifted by (dx,dy): S[p] = img[p + d] (clamped to the image). */
export function shifted(img: Uint8ClampedArray, w: number, h: number, dx: number, dy: number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(img.length);
  for (let y = 0; y < h; y++) {
    const sy = Math.max(0, Math.min(h - 1, y + dy));
    for (let x = 0; x < w; x++) {
      const sx = Math.max(0, Math.min(w - 1, x + dx)), j = (y * w + x) * 4, k = (sy * w + sx) * 4;
      out[j] = img[k]; out[j + 1] = img[k + 1]; out[j + 2] = img[k + 2]; out[j + 3] = img[k + 3];
    }
  }
  return out;
}

/**
 * Create Texture: quilts small blocks taken from the surroundings of the region (random candidates, the best
 * match to the already-placed neighbours wins; overlaps are feathered). Result is used as S for healBlend.
 */
export function synthTexture(img: Uint8ClampedArray, region: Uint8Array, w: number, h: number, seed = 1): Uint8ClampedArray {
  const b = regionBounds(region, w, h);
  const out = new Uint8ClampedArray(img);
  if (!b) return out;
  let s = seed >>> 0 || 1;
  const rnd = () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return (s >>> 0) / 4294967296; };
  const B = Math.max(6, Math.min(28, Math.round(Math.max(b.w, b.h) / 3)));
  const ov = Math.max(2, Math.round(B / 4));
  const hole = dilate(region, w, h, 1);
  // candidate source blocks: fully outside the (dilated) region, near it
  const rad = Math.max(b.w, b.h) * 2 + B * 2;
  const okBlock = (x: number, y: number) => {
    if (x < 0 || y < 0 || x + B + ov > w || y + B + ov > h) return false;
    for (let yy = 0; yy < B + ov; yy += 2) for (let xx = 0; xx < B + ov; xx += 2) if (hole[(y + yy) * w + x + xx]) return false;
    return true;
  };
  const acc = new Float32Array(w * h * 4), wt = new Float32Array(w * h);
  for (let by = b.y - ov; by < b.y + b.h; by += B) for (let bx = b.x - ov; bx < b.x + b.w; bx += B) {
    let best: [number, number] | null = null, bestS = Infinity;
    for (let tries = 0; tries < 60 && (!best || tries < 14); tries++) {
      const cx = Math.round(b.x + b.w / 2 + (rnd() * 2 - 1) * rad - B / 2), cy = Math.round(b.y + b.h / 2 + (rnd() * 2 - 1) * rad - B / 2);
      if (!okBlock(cx, cy)) continue;
      // match against what is already there in the left/top overlap (placed blocks or known pixels)
      let sc = 0;
      for (let yy = 0; yy < B + ov; yy += 2) for (let xx = 0; xx < B + ov; xx += 2) {
        if (xx >= ov && yy >= ov) continue;
        const tx = bx + xx, ty = by + yy;
        if (tx < 0 || ty < 0 || tx >= w || ty >= h) continue;
        const ti = ty * w + tx;
        let r0: number, g0: number, b0: number;
        if (wt[ti] > 0) { r0 = acc[ti * 4] / wt[ti]; g0 = acc[ti * 4 + 1] / wt[ti]; b0 = acc[ti * 4 + 2] / wt[ti]; }
        else if (!region[ti]) { r0 = img[ti * 4]; g0 = img[ti * 4 + 1]; b0 = img[ti * 4 + 2]; }
        else continue;
        const si = ((cy + yy) * w + cx + xx) * 4;
        sc += (r0 - img[si]) ** 2 + (g0 - img[si + 1]) ** 2 + (b0 - img[si + 2]) ** 2;
      }
      if (sc < bestS) { bestS = sc; best = [cx, cy]; }
    }
    if (!best) continue;
    for (let yy = 0; yy < B + ov; yy++) for (let xx = 0; xx < B + ov; xx++) {
      const tx = bx + xx, ty = by + yy;
      if (tx < 0 || ty < 0 || tx >= w || ty >= h) continue;
      const fw = Math.min(1, (xx + 1) / (ov + 1), (B + ov - xx) / (ov + 1)) * Math.min(1, (yy + 1) / (ov + 1), (B + ov - yy) / (ov + 1));
      const ti = ty * w + tx, si = ((best[1] + yy) * w + best[0] + xx) * 4;
      acc[ti * 4] += img[si] * fw; acc[ti * 4 + 1] += img[si + 1] * fw; acc[ti * 4 + 2] += img[si + 2] * fw; acc[ti * 4 + 3] += img[si + 3] * fw;
      wt[ti] += fw;
    }
  }
  for (let i = 0; i < w * h; i++) if (wt[i] > 0 && hole[i]) for (let k = 0; k < 4; k++) out[i * 4 + k] = acc[i * 4 + k] / wt[i];
  return out;
}
