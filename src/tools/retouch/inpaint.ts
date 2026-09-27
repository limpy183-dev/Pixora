// Content-aware fill (pure, no DOM; runs in a worker): multi-scale PatchMatch inpainting (Wexler/Barnes style).
// For each patch overlapping the hole find its nearest-neighbour patch in the known area (PatchMatch: propagation +
// random search), then re-estimate hole pixels by weighted voting of the overlapping matches (EM), coarse → fine.

export interface InpaintOptions {
  /** Patch radius (patch = 2r+1 square). */
  patch?: number;
  /** 1 = pixel may be used as source (in addition to "not in the hole"). */
  allowed?: Uint8Array | null;
  seed?: number;
}

interface Level { w: number; h: number; img: Float32Array; hole: Uint8Array; bad: Uint8Array }

function downsample(L: Level): Level {
  const w = Math.ceil(L.w / 2), h = Math.ceil(L.h / 2);
  const img = new Float32Array(w * h * 4), hole = new Uint8Array(w * h), bad = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let n = 0, tot = 0, anyBad = 0, r = 0, g = 0, b = 0, a = 0;
    for (let yy = y * 2; yy < Math.min(L.h, y * 2 + 2); yy++) for (let xx = x * 2; xx < Math.min(L.w, x * 2 + 2); xx++) {
      const i = yy * L.w + xx;
      tot++;
      if (L.bad[i]) anyBad = 1;
      if (L.hole[i]) continue;
      n++; r += L.img[i * 4]; g += L.img[i * 4 + 1]; b += L.img[i * 4 + 2]; a += L.img[i * 4 + 3];
    }
    const o = y * w + x;
    if (n) { img[o * 4] = r / n; img[o * 4 + 1] = g / n; img[o * 4 + 2] = b / n; img[o * 4 + 3] = a / n; }
    hole[o] = n < tot ? 1 : 0;
    bad[o] = anyBad || hole[o];
  }
  return { w, h, img, hole, bad };
}

function validCenters(L: Level, P: number): Uint8Array {
  const { w, h, bad } = L;
  const I = new Int32Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) { let row = 0; for (let x = 0; x < w; x++) { row += bad[y * w + x]; I[(y + 1) * (w + 1) + x + 1] = I[y * (w + 1) + x + 1] + row; } }
  const v = new Uint8Array(w * h);
  for (let y = P; y < h - P; y++) for (let x = P; x < w - P; x++) {
    const x0 = x - P, y0 = y - P, x1 = x + P + 1, y1 = y + P + 1;
    const s = I[y1 * (w + 1) + x1] - I[y0 * (w + 1) + x1] - I[y1 * (w + 1) + x0] + I[y0 * (w + 1) + x0];
    if (!s) v[y * w + x] = 1;
  }
  return v;
}

function countOnes(a: Uint8Array) { let n = 0; for (let i = 0; i < a.length; i++) n += a[i]; return n; }

/** Onion-peel initial fill of the hole (average of already-known 8-neighbours). */
function peelFill(L: Level) {
  const { w, h, img } = L;
  const known = new Uint8Array(w * h);
  for (let i = 0; i < known.length; i++) known[i] = L.hole[i] ? 0 : 1;
  let frontier: number[] = [];
  for (let i = 0; i < known.length; i++) if (!known[i]) frontier.push(i);
  let guard = 0;
  while (frontier.length && guard++ < w + h) {
    const next: number[] = [], set: [number, number, number, number, number][] = [];
    for (const i of frontier) {
      const x = i % w, y = (i - x) / w;
      let n = 0, r = 0, g = 0, b = 0, a = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx, yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
        const j = yy * w + xx;
        if (!known[j]) continue;
        n++; r += img[j * 4]; g += img[j * 4 + 1]; b += img[j * 4 + 2]; a += img[j * 4 + 3];
      }
      if (n) set.push([i, r / n, g / n, b / n, a / n]); else next.push(i);
    }
    if (!set.length) break;
    for (const [i, r, g, b, a] of set) { img[i * 4] = r; img[i * 4 + 1] = g; img[i * 4 + 2] = b; img[i * 4 + 3] = a; known[i] = 1; }
    frontier = next;
  }
}

export function inpaint(rgba: Uint8ClampedArray, w: number, h: number, hole: Uint8Array, o: InpaintOptions = {}): Uint8ClampedArray {
  const P = o.patch ?? 3, PS = 2 * P + 1;
  let seed = (o.seed ?? 12345) >>> 0 || 1;
  const rnd = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0) / 4294967296; };

  const bad0 = new Uint8Array(w * h);
  for (let i = 0; i < bad0.length; i++) bad0[i] = hole[i] || (o.allowed && !o.allowed[i]) ? 1 : 0;
  const levels: Level[] = [{ w, h, img: Float32Array.from(rgba), hole: hole.slice(), bad: bad0 }];
  if (!countOnes(hole)) return new Uint8ClampedArray(rgba);
  // pyramid: stop when the hole is small or sources would become too scarce
  for (;;) {
    const L = levels[levels.length - 1];
    let x0 = L.w, y0 = L.h, x1 = -1, y1 = -1;
    for (let y = 0; y < L.h; y++) for (let x = 0; x < L.w; x++) if (L.hole[y * L.w + x]) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; y1 = y; }
    if (Math.max(x1 - x0 + 1, y1 - y0 + 1) <= PS * 2 || Math.min(L.w, L.h) / 2 < PS * 4) break;
    const C = downsample(L);
    if (countOnes(validCenters(C, P)) < 40) break;
    levels.push(C);
  }

  let prevNnf: Int32Array | null = null, prevW = 0;
  for (let li = levels.length - 1; li >= 0; li--) {
    const L = levels[li], { w: W, h: H, img } = L;
    const valid = validCenters(L, P);
    const validList: number[] = [];
    for (let i = 0; i < valid.length; i++) if (valid[i]) validList.push(i);
    if (!validList.length) {
      // nothing to copy from: diffuse only
      if (li === levels.length - 1 || !prevNnf) peelFill(L);
      continue;
    }
    // targets: pixels whose patch overlaps the hole
    const isT = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      if (!L.hole[y * W + x]) continue;
      for (let yy = Math.max(0, y - P); yy <= Math.min(H - 1, y + P); yy++) for (let xx = Math.max(0, x - P); xx <= Math.min(W - 1, x + P); xx++) isT[yy * W + xx] = 1;
    }
    const targets: number[] = [];
    for (let i = 0; i < isT.length; i++) if (isT[i]) targets.push(i);
    const T = Int32Array.from(targets);
    const nnf = new Int32Array(W * H).fill(-1), dist = new Float32Array(W * H);

    const D = (t: number, s: number, cut: number): number => {
      const tx = t % W, ty = (t - tx) / W, sx = s % W, sy = (s - sx) / W;
      let d = 0, n = 0;
      for (let dy = -P; dy <= P; dy++) {
        const y = ty + dy;
        if (y < 0 || y >= H) continue;
        const trow = y * W, srow = (sy + dy) * W;
        for (let dx = -P; dx <= P; dx++) {
          const x = tx + dx;
          if (x < 0 || x >= W) continue;
          const a = (trow + x) * 4, b = (srow + sx + dx) * 4;
          const e0 = img[a] - img[b], e1 = img[a + 1] - img[b + 1], e2 = img[a + 2] - img[b + 2], e3 = img[a + 3] - img[b + 3];
          d += e0 * e0 + e1 * e1 + e2 * e2 + e3 * e3 * 0.5;
          n++;
        }
        if (d > cut * n) return Infinity;
      }
      return d / Math.max(1, n);
    };
    const randomValid = () => validList[(rnd() * validList.length) | 0];

    // initialisation
    if (!prevNnf) {
      peelFill(L);
      for (const t of T) { const s = randomValid(); nnf[t] = s; }
    } else {
      // upsample the hole estimate and the NNF from the coarser level
      const C = levels[li + 1];
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const i = y * W + x;
        if (!L.hole[i]) continue;
        const c = (Math.min(C.h - 1, y >> 1) * C.w + Math.min(C.w - 1, x >> 1)) * 4;
        img[i * 4] = C.img[c]; img[i * 4 + 1] = C.img[c + 1]; img[i * 4 + 2] = C.img[c + 2]; img[i * 4 + 3] = C.img[c + 3];
      }
      for (const t of T) {
        const tx = t % W, ty = (t - tx) / W;
        const cs = prevNnf[Math.min(C.h - 1, ty >> 1) * prevW + Math.min(C.w - 1, tx >> 1)];
        let s = -1;
        if (cs >= 0) {
          const sx = Math.min(W - 1 - P, Math.max(P, (cs % prevW) * 2 + (tx & 1))), sy = Math.min(H - 1 - P, Math.max(P, Math.floor(cs / prevW) * 2 + (ty & 1)));
          const c = sy * W + sx;
          if (valid[c]) s = c;
        }
        nnf[t] = s >= 0 ? s : randomValid();
      }
    }

    const iters = Math.min(12, 3 + 2 * li) + (li === levels.length - 1 ? 3 : 0);
    const acc = new Float32Array(W * H * 4), wsum = new Float32Array(W * H);
    for (let it = 0; it < iters; it++) {
      for (const t of T) dist[t] = D(t, nnf[t], Infinity);
      // PatchMatch: two scan directions
      for (let pass = 0; pass < 2; pass++) {
        const rev = (it + pass) & 1;
        for (let k = 0; k < T.length; k++) {
          const t = T[rev ? T.length - 1 - k : k];
          const tx = t % W;
          let best = nnf[t], bd = dist[t];
          const dir = rev ? -1 : 1;
          // propagation
          const nx = t - dir;
          if (tx - dir >= 0 && tx - dir < W && isT[nx]) {
            const c = nnf[nx] + dir, cx = nnf[nx] % W + dir;
            if (cx >= P && cx < W - P && valid[c] && c !== best) { const d = D(t, c, bd); if (d < bd) { bd = d; best = c; } }
          }
          const ny = t - dir * W;
          if (ny >= 0 && ny < W * H && isT[ny]) {
            const c = nnf[ny] + dir * W;
            if (c >= 0 && c < W * H && valid[c] && c !== best) { const d = D(t, c, bd); if (d < bd) { bd = d; best = c; } }
          }
          // random search around the current best
          const bx = best % W, by = (best - bx) / W;
          for (let r = Math.max(W, H); r >= 1; r = Math.floor(r / 2)) {
            const cx = Math.min(W - 1 - P, Math.max(P, bx + Math.round((rnd() * 2 - 1) * r)));
            const cy = Math.min(H - 1 - P, Math.max(P, by + Math.round((rnd() * 2 - 1) * r)));
            const c = cy * W + cx;
            if (!valid[c] || c === best) continue;
            const d = D(t, c, bd);
            if (d < bd) { bd = d; best = c; }
          }
          nnf[t] = best; dist[t] = bd;
        }
      }
      // voting (EM): hole pixels = weighted average of the matched patches covering them
      const ds = Array.from(T, t => dist[t]).sort((a, b) => a - b);
      const sigma2 = Math.max(1, ds[Math.floor(ds.length * 0.75)] || 1);
      acc.fill(0); wsum.fill(0);
      for (const t of T) {
        const tx = t % W, ty = (t - tx) / W, s = nnf[t], sx = s % W, sy = (s - sx) / W;
        const wgt = Math.exp(-dist[t] / (2 * sigma2)) + 1e-4;
        for (let dy = -P; dy <= P; dy++) {
          const y = ty + dy;
          if (y < 0 || y >= H) continue;
          for (let dx = -P; dx <= P; dx++) {
            const x = tx + dx;
            if (x < 0 || x >= W) continue;
            const p = y * W + x;
            if (!L.hole[p]) continue;
            const q = ((sy + dy) * W + sx + dx) * 4;
            acc[p * 4] += img[q] * wgt; acc[p * 4 + 1] += img[q + 1] * wgt; acc[p * 4 + 2] += img[q + 2] * wgt; acc[p * 4 + 3] += img[q + 3] * wgt;
            wsum[p] += wgt;
          }
        }
      }
      for (let p = 0; p < W * H; p++) {
        if (!L.hole[p] || !wsum[p]) continue;
        img[p * 4] = acc[p * 4] / wsum[p]; img[p * 4 + 1] = acc[p * 4 + 1] / wsum[p]; img[p * 4 + 2] = acc[p * 4 + 2] / wsum[p]; img[p * 4 + 3] = acc[p * 4 + 3] / wsum[p];
      }
    }
    prevNnf = nnf; prevW = W;
  }
  const out = new Uint8ClampedArray(rgba);
  const img = levels[0].img;
  for (let i = 0; i < w * h; i++) if (hole[i]) for (let k = 0; k < 4; k++) out[i * 4 + k] = img[i * 4 + k];
  return out;
}
