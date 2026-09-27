// File formats: native .pxd (JSON + PNG blobs in one binary container), Photoshop .psd (via ag-psd, layers,
// groups, masks, blend modes, opacity, visibility) and flat images (PNG / JPEG / WebP / GIF / BMP / AVIF / SVG).
import { PixDocument } from '../../core/document';
import { GroupLayer, RasterLayer, type Layer } from '../../core/layer';
import { canvasFromBlob, canvasToBlob, createCanvas, ctx2d } from '../../core/canvas';
import type { BlendMode, RGB } from '../../core/types';

export type SaveFormat = 'pxd' | 'psd' | 'png' | 'jpeg' | 'webp';
export const FORMAT_INFO: Record<SaveFormat, { label: string; ext: string; mime: string }> = {
  pxd: { label: 'Pixora Document (*.pxd)', ext: 'pxd', mime: 'application/x-pixora' },
  psd: { label: 'Photoshop (*.psd)', ext: 'psd', mime: 'image/vnd.adobe.photoshop' },
  png: { label: 'PNG (*.png)', ext: 'png', mime: 'image/png' },
  jpeg: { label: 'JPEG (*.jpg;*.jpeg)', ext: 'jpg', mime: 'image/jpeg' },
  webp: { label: 'WebP (*.webp)', ext: 'webp', mime: 'image/webp' },
};
export const OPEN_ACCEPT = '.pxd,.psd,.psb,.png,.jpg,.jpeg,.jpe,.webp,.gif,.bmp,.avif,.svg,.ico,image/*';

export const baseName = (n: string) => n.replace(/\.[^./\\]+$/, '');
export const extOf = (n: string) => (/\.([^./\\]+)$/.exec(n)?.[1] || '').toLowerCase();

// ------------------------------------------------------------------ .pxd container
const MAGIC = 'PIXORA-PXD\n';
export async function encodePXD(doc: PixDocument): Promise<Blob> {
  const { json, blobs } = await doc.serialize();
  const js = new TextEncoder().encode(JSON.stringify(json));
  const head = new ArrayBuffer(4 + 4), dv = new DataView(head);
  dv.setUint32(0, js.length); dv.setUint32(4, blobs.length);
  const parts: BlobPart[] = [MAGIC, head, js];
  for (const b of blobs) { const l = new ArrayBuffer(4); new DataView(l).setUint32(0, b.size); parts.push(l, b); }
  return new Blob(parts, { type: FORMAT_INFO.pxd.mime });
}
export async function decodePXD(buf: ArrayBuffer, name: string): Promise<PixDocument> {
  const bytes = new Uint8Array(buf);
  const magic = new TextDecoder().decode(bytes.subarray(0, MAGIC.length));
  if (magic !== MAGIC) throw new Error('This is not a valid Pixora document.');
  let o = MAGIC.length;
  const dv = new DataView(buf);
  const jl = dv.getUint32(o), n = dv.getUint32(o + 4); o += 8;
  const json = JSON.parse(new TextDecoder().decode(bytes.subarray(o, o + jl))); o += jl;
  const blobs: Blob[] = [];
  for (let i = 0; i < n; i++) { const l = dv.getUint32(o); o += 4; blobs.push(new Blob([bytes.subarray(o, o + l)], { type: 'image/png' })); o += l; }
  const doc = await PixDocument.deserialize(json, blobs);
  doc.name = baseName(name) || doc.name;
  return doc;
}

// ------------------------------------------------------------------ PSD
const PSD_BLEND: Record<string, BlendMode> = {
  'pass through': 'pass-through', normal: 'normal', dissolve: 'dissolve', darken: 'darken', multiply: 'multiply',
  'color burn': 'color-burn', 'linear burn': 'linear-burn', 'darker color': 'darker-color', lighten: 'lighten', screen: 'screen',
  'color dodge': 'color-dodge', 'linear dodge': 'linear-dodge', 'lighter color': 'lighter-color', overlay: 'overlay',
  'soft light': 'soft-light', 'hard light': 'hard-light', 'vivid light': 'vivid-light', 'linear light': 'linear-light',
  'pin light': 'pin-light', 'hard mix': 'hard-mix', difference: 'difference', exclusion: 'exclusion', subtract: 'subtract',
  divide: 'divide', hue: 'hue', saturation: 'saturation', color: 'color', luminosity: 'luminosity',
};
const BLEND_PSD: Record<string, string> = Object.fromEntries(Object.entries(PSD_BLEND).map(([k, v]) => [v, k]));

/** Grey (RGB) mask canvas → alpha mask canvas. */
function greyToAlpha(c: HTMLCanvasElement): HTMLCanvasElement {
  const o = createCanvas(c.width, c.height), x = ctx2d(o);
  const img = ctx2d(c).getImageData(0, 0, c.width, c.height), d = img.data;
  for (let i = 0; i < d.length; i += 4) { d[i + 3] = d[i]; d[i] = d[i + 1] = d[i + 2] = 0; }
  x.putImageData(img, 0, 0);
  return o;
}
function alphaToGrey(c: HTMLCanvasElement): HTMLCanvasElement {
  const o = createCanvas(c.width, c.height), x = ctx2d(o);
  const img = ctx2d(c).getImageData(0, 0, c.width, c.height), d = img.data;
  for (let i = 0; i < d.length; i += 4) { const a = d[i + 3]; d[i] = d[i + 1] = d[i + 2] = a; d[i + 3] = 255; }
  x.putImageData(img, 0, 0);
  return o;
}

export async function readPSD(buf: ArrayBuffer, name: string): Promise<PixDocument> {
  const { readPsd } = await import('ag-psd');
  const psd = readPsd(buf, { skipThumbnail: true });
  const doc = new PixDocument(psd.width, psd.height, baseName(name));
  const res = (psd.imageResources as any)?.resolutionInfo;
  if (res?.horizontalResolution) {
    doc.resolution = res.horizontalResolution;
    doc.resolutionUnit = res.horizontalResolutionUnit === 'PPCM' ? 'ppcm' : 'ppi';
  }
  const convert = (src: any): Layer | null => {
    let l: Layer;
    if (src.children) {
      const g = new GroupLayer(src.name || 'Group');
      g.expanded = !!src.opened;
      g.children = src.children.map(convert).filter(Boolean) as Layer[];
      l = g;
    } else {
      const w = Math.max(1, (src.right ?? 0) - (src.left ?? 0)), hh = Math.max(1, (src.bottom ?? 0) - (src.top ?? 0));
      const r = new RasterLayer(w, hh, src.name || 'Layer');
      if (src.canvas) { r.canvas = createCanvas(src.canvas.width, src.canvas.height); ctx2d(r.canvas).drawImage(src.canvas, 0, 0); }
      r.x = src.left || 0; r.y = src.top || 0;
      l = r;
    }
    l.visible = !src.hidden;
    l.opacity = src.opacity ?? 1;
    if (src.blendMode && PSD_BLEND[src.blendMode]) l.blendMode = PSD_BLEND[src.blendMode];
    if (src.clipping) l.clipped = true;
    if (typeof src.fillOpacity === 'number') l.fillOpacity = src.fillOpacity;
    if (src.mask?.canvas) {
      l.mask = {
        canvas: greyToAlpha(src.mask.canvas), x: src.mask.left || 0, y: src.mask.top || 0,
        bg: (src.mask.defaultColor ?? 255) >= 128 ? 255 : 0, enabled: !src.mask.disabled, linked: !src.mask.positionRelativeToLayer, density: 1, feather: 0,
      } as any;
    }
    return l;
  };
  if (psd.children?.length) {
    doc.layers = psd.children.map(convert).filter(Boolean) as Layer[];
    // a bottom layer covering the canvas with the name "Background" becomes the Background layer
    const b = doc.layers[0];
    if (b instanceof RasterLayer && /^background$/i.test(b.name) && b.x === 0 && b.y === 0 && b.canvas.width === doc.width && b.canvas.height === doc.height) b.isBackground = true;
  } else {
    const r = new RasterLayer(doc.width, doc.height, 'Background');
    if (psd.canvas) ctx2d(r.canvas).drawImage(psd.canvas, 0, 0);
    r.isBackground = true;
    doc.layers = [r];
  }
  doc.relink();
  const top = doc.layers[doc.layers.length - 1];
  doc.activeLayerId = top.id; doc.selectedIds = [top.id];
  doc.history.baseName = 'Open';
  doc.history.snapshots = [{ name: doc.name, state: doc.captureState(true) }];
  return doc;
}

export async function writePSD(doc: PixDocument): Promise<Blob> {
  const { writePsd } = await import('ag-psd');
  const layerOut = (l: Layer): any => {
    const o: any = { name: l.name, hidden: !l.visible, opacity: l.opacity, blendMode: BLEND_PSD[l.blendMode] || 'normal', clipping: l.clipped };
    if (l instanceof GroupLayer) {
      o.children = l.children.map(layerOut);
      o.opened = l.expanded;
      return o;
    }
    const c = l.getContent(doc);
    if (c && c.canvas.width > 0) {
      o.canvas = c.canvas; o.left = Math.round(c.x); o.top = Math.round(c.y);
    }
    if (l.fillOpacity !== 1) o.fillOpacity = l.fillOpacity;
    if (l.mask) o.mask = { canvas: alphaToGrey(l.mask.canvas), left: l.mask.x, top: l.mask.y, defaultColor: l.mask.bg, disabled: !l.mask.enabled };
    return o;
  };
  const psd: any = {
    width: doc.width, height: doc.height,
    children: doc.layers.map(layerOut),
    canvas: doc.flattenedCanvas(),
    imageResources: { resolutionInfo: { horizontalResolution: doc.resolution, horizontalResolutionUnit: doc.resolutionUnit === 'ppcm' ? 'PPCM' : 'PPI', widthUnit: 'Inches', verticalResolution: doc.resolution, verticalResolutionUnit: doc.resolutionUnit === 'ppcm' ? 'PPCM' : 'PPI', heightUnit: 'Inches' } },
  };
  const buf = writePsd(psd, { generateThumbnail: true, trimImageData: true });
  return new Blob([buf], { type: FORMAT_INFO.psd.mime });
}

// ------------------------------------------------------------------ flat images
export async function readImage(blob: Blob, name: string): Promise<PixDocument> {
  let c: HTMLCanvasElement;
  if (blob.type === 'image/svg+xml' || extOf(name) === 'svg') c = await svgToCanvas(blob);
  else c = await canvasFromBlob(blob);
  const doc = PixDocument.create(c.width, c.height, { name: baseName(name), resolution: 72, background: 'transparent' });
  const l = doc.layers[0] as RasterLayer;
  ctx2d(l.canvas).drawImage(c, 0, 0);
  // opaque images open as a Background layer like Photoshop
  if (!hasTransparency(c)) { l.isBackground = true; l.name = 'Background'; }
  doc.history.baseName = 'Open';
  doc.history.snapshots = [{ name: doc.name, state: doc.captureState(true) }];
  return doc;
}
export async function svgToCanvas(blob: Blob, maxSide = 4000): Promise<HTMLCanvasElement> {
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    let w = img.naturalWidth || 1000, hh = img.naturalHeight || 1000;
    const k = Math.min(1, maxSide / Math.max(w, hh)); w = Math.round(w * k); hh = Math.round(hh * k);
    const c = createCanvas(w, hh);
    ctx2d(c).drawImage(img, 0, 0, w, hh);
    return c;
  } finally { URL.revokeObjectURL(url); }
}
export function hasTransparency(c: HTMLCanvasElement): boolean {
  const d = ctx2d(c).getImageData(0, 0, c.width, c.height).data;
  for (let i = 3; i < d.length; i += 4) if (d[i] < 255) return true;
  return false;
}

/** Encode a canvas; JPEG (no alpha) is flattened over `matte`. */
export async function encodeImage(c: HTMLCanvasElement, fmt: 'png' | 'jpeg' | 'webp', quality = 0.92, matte: RGB = { r: 255, g: 255, b: 255 }): Promise<Blob> {
  let src = c;
  if (fmt === 'jpeg') {
    src = createCanvas(c.width, c.height);
    const x = ctx2d(src);
    x.fillStyle = `rgb(${matte.r},${matte.g},${matte.b})`; x.fillRect(0, 0, c.width, c.height);
    x.drawImage(c, 0, 0);
  }
  return canvasToBlob(src, FORMAT_INFO[fmt].mime, fmt === 'png' ? undefined : quality);
}

/** Open any supported file as a new document. */
export async function readAnyFile(file: Blob, name: string): Promise<PixDocument> {
  const ext = extOf(name);
  if (ext === 'pxd') return decodePXD(await file.arrayBuffer(), name);
  if (ext === 'psd' || ext === 'psb' || file.type === FORMAT_INFO.psd.mime) return readPSD(await file.arrayBuffer(), name);
  return readImage(file, name);
}

/** Encode a document in a save format. */
export async function writeDocument(doc: PixDocument, fmt: SaveFormat, quality = 0.92): Promise<Blob> {
  if (fmt === 'pxd') return encodePXD(doc);
  if (fmt === 'psd') return writePSD(doc);
  return encodeImage(doc.flattenedCanvas(), fmt, quality);
}
