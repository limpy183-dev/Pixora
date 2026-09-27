// Auto-Align worker: features for every image, then ratio-test matches for every pair.
import { features, grayOf, match } from './align-core';

self.onmessage = (e: MessageEvent) => {
  const { id, images } = e.data as { id: number; images: { data: Uint8ClampedArray; w: number; h: number }[] };
  try {
    const feats = images.map(im => { const { g, m } = grayOf(im.data, im.w, im.h); return features(g, m, im.w, im.h); });
    const pairs: { i: number; j: number; m: Int32Array }[] = [];
    for (let i = 0; i < feats.length; i++) for (let j = i + 1; j < feats.length; j++) pairs.push({ i, j, m: Int32Array.from(match(feats[i], feats[j]).flat()) });
    (self as any).postMessage({ id, feats: feats.map(f => ({ n: f.n, x: f.x, y: f.y, lum: f.lum })), pairs });
  } catch (err: any) { (self as any).postMessage({ id, error: String(err?.message || err) }); }
};
