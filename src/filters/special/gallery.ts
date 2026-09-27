// Filter › Filter Gallery: 47 effects in Artistic, Brush Strokes, Distort, Sketch, Stylize and Texture groups with
// thumbnails, per-effect settings and a stack of effect layers (new / delete / hide / reorder). The preview shows a
// 100% crop that can be dragged around; OK applies the whole stack (or stores it as a Smart Filter).
import { registerCommands } from '../../core/commands';
import { h } from '../../ui/dom';
import { icon } from '../../ui/icons';
import { checkbox, colorSwatch, select } from '../../ui/widgets';
import { app } from '../../core/app';
import { createCanvas } from '../../core/canvas';
import type { PixDocument } from '../../core/document';
import type { SmartObjectLayer } from '../../layers/smart-object';
import { applyKernel, putSmartFilter, registerSpec, runPreview, rgb3 } from '../engine';
import { GALLERY, GALLERY_BY_ID, galleryDefaults } from '../kernels/gallery';
import { grabSource, openWorkspace, readPixels, wsSection, wsSlider } from './workspace';

interface GLayer { id: string; params: Record<string, any>; visible: boolean }
const GROUPS = ['Artistic', 'Brush Strokes', 'Distort', 'Sketch', 'Stylize', 'Texture'];
let lastStack: GLayer[] | null = null;

export async function openGallery(existing?: { so: SmartObjectLayer; index: number; params: any }) {
  const src = grabSource(4096);
  if (!src) return;
  const full = src.full, FW = full.width, FH = full.height;
  const layers: GLayer[] = existing?.params?.layers ? JSON.parse(JSON.stringify(existing.params.layers)) : lastStack ? JSON.parse(JSON.stringify(lastStack)) : [{ id: 'colored-pencil', params: galleryDefaults('colored-pencil'), visible: true }];
  let cur = layers.length - 1;
  const fg = rgb3(app.fg), bg = rgb3(app.bg);
  // preview = 100% crop of the source, draggable
  const CW = Math.min(FW, 900), CH = Math.min(FH, 640);
  let cx = Math.max(0, Math.round((FW - CW) / 2)), cy = Math.max(0, Math.round((FH - CH) / 2));
  const fullCtx = createCanvas(FW, FH).getContext('2d', { willReadFrequently: true })!;
  fullCtx.drawImage(full, 0, 0);
  const cropC = createCanvas(CW, CH), cropX = cropC.getContext('2d', { willReadFrequently: true })!;
  const outC = createCanvas(CW, CH), outX = outC.getContext('2d', { willReadFrequently: true })!;
  let busy = false, pending = false;
  const render = async () => {
    if (busy) { pending = true; return; }
    busy = true;
    try {
      cropX.clearRect(0, 0, CW, CH);
      cropX.drawImage(fullCtx.canvas, -cx, -cy);
      const img = cropX.getImageData(0, 0, CW, CH);
      const res = await runPreview('gallery', img, { layers }, { x: cx, y: cy, docW: FW, docH: FH, sel: null, isMask: false, preview: true, fg, bg, seed: 1, aux: {} });
      outX.putImageData(res, 0, 0);
      ws.view.draw();
    } catch (err) { console.error(err); }
    busy = false;
    if (pending) { pending = false; void render(); }
  };

  // ---------------------------------------------------------------- thumbnails
  const sample = createCanvas(84, 60), sx = sample.getContext('2d', { willReadFrequently: true })!;
  const sc = Math.max(84 / FW, 60 / FH);
  sx.drawImage(full, (84 - FW * sc) / 2, (60 - FH * sc) / 2, FW * sc, FH * sc);
  const sampleImg = readPixels(sample);
  const thumbs = new Map<string, HTMLCanvasElement>();
  const thumbOf = (id: string) => {
    let c = thumbs.get(id);
    if (c) return c;
    c = createCanvas(84, 60);
    try { const out = GALLERY_BY_ID.get(id)!.run(new ImageData(new Uint8ClampedArray(sampleImg.data), 84, 60), galleryDefaults(id), fg, bg, 3); c.getContext('2d')!.putImageData(out, 0, 0); } catch { /* ignore */ }
    thumbs.set(id, c);
    return c;
  };
  const browser = h('div.gal-browser');
  const renderBrowser = () => {
    browser.replaceChildren(...GROUPS.map(g => {
      const grid = h('div.gal-grid');
      for (const e of GALLERY.filter(x => x.group === g)) {
        const cell = h('button.gal-cell', { type: 'button', title: e.name, class: layers[cur]?.id === e.id ? 'active' : '' }, thumbOf(e.id), h('span', null, e.name));
        cell.addEventListener('click', () => { layers[cur] = { id: e.id, params: galleryDefaults(e.id), visible: true }; renderAll(); void render(); });
        grid.append(cell);
      }
      const sec = wsSection(g, grid);
      if (!layers.some(l => GALLERY_BY_ID.get(l.id)?.group === g)) sec.classList.add('collapsed');
      return sec;
    }));
  };
  // ---------------------------------------------------------------- settings of the current layer
  const settings = h('div.gal-settings');
  const renderSettings = () => {
    settings.replaceChildren();
    const l = layers[cur];
    if (!l) return;
    const e = GALLERY_BY_ID.get(l.id)!;
    settings.append(h('div.gal-title', null, e.name));
    for (const q of e.params) {
      if (q.type === 'select') settings.append(h('div.ws-row', null, h('span.ws-label', null, q.label), select<string>(q.options!.map(([v, t]) => ({ value: v, label: t })), l.params[q.key], v => { l.params[q.key] = v; void render(); }, { width: 150, title: q.label })));
      else if (q.type === 'check') settings.append(checkbox(q.label, !!l.params[q.key], v => { l.params[q.key] = v; void render(); }));
      else if (q.type === 'color') settings.append(h('div.ws-row', null, h('span.ws-label', null, q.label), colorSwatch(l.params[q.key], c => { l.params[q.key] = c; void render(); }, { title: q.label, size: 20 })));
      else settings.append(wsSlider(q.label, l.params[q.key], q.min!, q.max!, v => { l.params[q.key] = v; void render(); }));
    }
    if (['Sketch'].includes(e.group) || ['stained-glass', 'diffuse-glow', 'neon-glow'].includes(e.id)) settings.append(h('div.flt-hint', null, 'Uses the foreground and background colors.'));
  };
  // ---------------------------------------------------------------- effect layers
  const layerList = h('div.gal-layers');
  const renderLayers = () => {
    layerList.replaceChildren(...[...layers].reverse().map((l, ri) => {
      const i = layers.length - 1 - ri;
      const eye = h('button.icon-btn', { type: 'button', title: l.visible ? 'Hide effect layer' : 'Show effect layer' }, icon(l.visible ? 'eye' : 'eye-off', 14));
      eye.addEventListener('click', ev => { ev.stopPropagation(); l.visible = !l.visible; renderLayers(); void render(); });
      const row = h('div.gal-layer', { class: i === cur ? 'active' : '', draggable: 'true', title: 'Click to edit, drag to reorder' }, eye, h('span', null, GALLERY_BY_ID.get(l.id)?.name || l.id));
      row.addEventListener('click', () => { cur = i; renderAll(); });
      row.addEventListener('dragstart', ev => ev.dataTransfer?.setData('text/plain', String(i)));
      row.addEventListener('dragover', ev => ev.preventDefault());
      row.addEventListener('drop', ev => { ev.preventDefault(); const from = parseInt(ev.dataTransfer?.getData('text/plain') || '-1', 10); if (from < 0 || from === i) return; const [m] = layers.splice(from, 1); layers.splice(i, 0, m); cur = i; renderAll(); void render(); });
      return row;
    }));
  };
  const renderAll = () => { renderBrowser(); renderSettings(); renderLayers(); };
  renderAll();
  const side = h('div.gal-side', null, settings,
    h('div.gal-layerhead', null, h('span', null, 'Effect Layers'),
      h('button.icon-btn', { type: 'button', title: 'New effect layer', onclick: () => { layers.splice(cur + 1, 0, JSON.parse(JSON.stringify(layers[cur] || { id: 'colored-pencil', params: galleryDefaults('colored-pencil'), visible: true }))); cur++; renderAll(); void render(); } }, icon('plus', 14)),
      h('button.icon-btn', { type: 'button', title: 'Delete effect layer', onclick: () => { if (layers.length <= 1) return; layers.splice(cur, 1); cur = Math.max(0, cur - 1); renderAll(); void render(); } }, icon('trash', 14))),
    layerList, browser);
  const ws = openWorkspace({ title: 'Filter Gallery', side, className: 'gal-dialog' });
  ws.view.setImage(outC, CW, CH, true);
  ws.status.textContent = FW > CW || FH > CH ? 'Drag the preview to see other parts of the image (100%)' : '';
  let drag: { x: number; y: number; cx: number; cy: number } | null = null;
  ws.view.cursor = 'grab'; ws.view.canvas.style.cursor = 'grab';
  ws.view.onDown = p => { drag = { x: p.sx, y: p.sy, cx, cy }; };
  ws.view.onMove = (p, down) => {
    if (!down || !drag) return;
    const k = 1 / ws.view.zoom;
    cx = Math.max(0, Math.min(FW - CW, Math.round(drag.cx - (p.sx - drag.x) * k)));
    cy = Math.max(0, Math.min(FH - CH, Math.round(drag.cy - (p.sy - drag.y) * k)));
    cropX.clearRect(0, 0, CW, CH); cropX.drawImage(fullCtx.canvas, -cx, -cy);
    outX.drawImage(cropC, 0, 0); ws.view.draw();       // show the original while dragging
  };
  ws.view.onUp = () => { if (drag) { drag = null; void render(); } };
  void render();
  const ok = await ws.result;
  if (!ok) return;
  lastStack = JSON.parse(JSON.stringify(layers));
  const p = { layers };
  if (src.kind === 'smart' && src.so) putSmartFilter(src.doc, src.so, 'gallery', 'Filter Gallery', p, existing?.index ?? -1);
  else await applyKernel(src.doc, 'Filter Gallery', 'gallery', p);
}

registerSpec({
  id: 'gallery', label: 'Filter Gallery', category: 'Special', dialog: false, kernel: 'gallery', defaults: () => ({ layers: [] }),
  edit: (doc: PixDocument, so: SmartObjectLayer, index: number) => { if (app.activeDoc !== doc) return; doc.setActiveLayer(so); void openGallery({ so, index, params: so.smartFilters[index].params }); },
});
registerCommands([{ id: 'filter.gallery', label: 'Filter Gallery...', enabled: () => !!app.activeDoc, run: () => openGallery() }]);
