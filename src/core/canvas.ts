// Canvas helpers. All layer pixels live in HTMLCanvasElements (GPU-backed 2D contexts).
import type { Rect } from './types';

export function createCanvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  return c;
}
export const ctx2d = (c: HTMLCanvasElement) => c.getContext('2d')! as CanvasRenderingContext2D;

export function cloneCanvas(src: HTMLCanvasElement): HTMLCanvasElement {
  const c = createCanvas(src.width, src.height);
  ctx2d(c).drawImage(src, 0, 0);
  return c;
}
/** Copy a sub-rectangle of `src` into a new canvas of size r.w×r.h. */
export function cropCanvas(src: CanvasImageSource, r: Rect): HTMLCanvasElement {
  const c = createCanvas(r.w, r.h);
  ctx2d(c).drawImage(src as any, -r.x, -r.y);
  return c;
}
export function fillCanvas(w: number, h: number, css: string): HTMLCanvasElement {
  const c = createCanvas(w, h), x = ctx2d(c);
  x.fillStyle = css; x.fillRect(0, 0, c.width, c.height);
  return c;
}
export function canvasFromImageData(img: ImageData): HTMLCanvasElement {
  const c = createCanvas(img.width, img.height);
  ctx2d(c).putImageData(img, 0, 0);
  return c;
}
export function getImageData(c: HTMLCanvasElement, r?: Rect): ImageData {
  const x = ctx2d(c);
  return r ? x.getImageData(r.x, r.y, r.w, r.h) : x.getImageData(0, 0, c.width, c.height);
}
export async function canvasFromBlob(blob: Blob): Promise<HTMLCanvasElement> {
  const bmp = await createImageBitmap(blob);
  const c = createCanvas(bmp.width, bmp.height);
  ctx2d(c).drawImage(bmp, 0, 0);
  bmp.close();
  return c;
}
export function canvasToBlob(c: HTMLCanvasElement, type = 'image/png', quality?: number): Promise<Blob> {
  return new Promise((res, rej) => c.toBlob(b => (b ? res(b) : rej(new Error('toBlob failed'))), type, quality));
}
export async function loadImage(src: string): Promise<HTMLImageElement> {
  const img = new Image();
  img.crossOrigin = 'anonymous';
  img.src = src;
  await img.decode();
  return img;
}

/** Bounding box of pixels with alpha > threshold, or null if fully transparent. */
export function alphaBounds(c: HTMLCanvasElement, threshold = 0): Rect | null {
  const { width: w, height: h } = c;
  const d = ctx2d(c).getImageData(0, 0, w, h).data;
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) {
    let row = y * w * 4 + 3;
    for (let x = 0; x < w; x++, row += 4) {
      if (d[row] > threshold) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        y1 = y;
      }
    }
  }
  return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

let checker: CanvasPattern | null = null;
/** Transparency grid appearance (Preferences › Transparency & Gamut); size 0 = use the caller's size. */
export const checkerStyle = { light: '#ffffff', dark: '#cccccc', size: 0 };
/** Drop the cached pattern after changing checkerStyle. */
export function resetCheckerPattern() { checker = null; }
/** 8px grey/white checkerboard pattern (transparency grid). */
export function checkerPattern(ctx: CanvasRenderingContext2D, size = 8): CanvasPattern {
  if (checker) return checker;
  size = checkerStyle.size || size;
  const c = createCanvas(size * 2, size * 2), x = ctx2d(c);
  x.fillStyle = checkerStyle.light; x.fillRect(0, 0, size * 2, size * 2);
  x.fillStyle = checkerStyle.dark; x.fillRect(size, 0, size, size); x.fillRect(0, size, size, size);
  return (checker = ctx.createPattern(c, 'repeat')!);
}

/** Small reusable scratch canvases (avoid per-frame allocations). */
const pool: HTMLCanvasElement[] = [];
export function borrowCanvas(w: number, h: number): HTMLCanvasElement {
  const c = pool.pop() || document.createElement('canvas');
  if (c.width !== w || c.height !== h) { c.width = w; c.height = h; } else ctx2d(c).clearRect(0, 0, w, h);
  const x = ctx2d(c);
  x.setTransform(1, 0, 0, 1, 0, 0); x.globalAlpha = 1; x.globalCompositeOperation = 'source-over'; x.filter = 'none';
  return c;
}
export function returnCanvas(c: HTMLCanvasElement) { if (pool.length < 8) pool.push(c); }
