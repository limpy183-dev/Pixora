// Document area: tabs, canvas viewport, rulers, scrollbars, status bar and the Home screen.
import { h, clear, dragPointer } from './dom';
import { icon } from './icons';
import { events } from '../core/events';
import { app } from '../core/app';
import { Viewport, viewOptions } from '../core/viewport';
import { createTabs, formatZoom } from './tabs';
import { openMenu } from './menu';
import { runCommand } from '../core/commands';
import type { PixDocument } from '../core/document';

/** Extension points for the workspace. */
export const workspaceHooks = {
  /** Pointer down on a ruler (guides module uses it to drag out guides). */
  rulerPointerDown: null as null | ((orientation: 'h' | 'v', e: PointerEvent, view: Viewport) => void),
  /** Renders the Home screen into `el` (file module may replace it). */
  renderHome: null as null | ((el: HTMLElement) => void),
};

const RULER = 18;
type InfoKind = 'sizes' | 'profile' | 'dimensions' | 'scale' | 'scratch' | 'efficiency' | 'timing' | 'tool' | 'layers';
let infoKind: InfoKind = (localStorage.getItem('pixora.statusInfo') as InfoKind) || 'dimensions';

export function createWorkspace(): { el: HTMLElement; viewport: Viewport } {
  const tabs = createTabs();
  const area = h('div.canvas-area');
  const rulerTop = h('canvas.ruler.ruler-h') as HTMLCanvasElement;
  const rulerLeft = h('canvas.ruler.ruler-v') as HTMLCanvasElement;
  const corner = h('div.ruler-corner');
  const vthumb = h('div.sb-thumb');
  const vscroll = h('div.vscroll', null, h('button.sb-arrow', { type: 'button', onclick: () => app.viewport?.panBy(0, 60) }, icon('chevron-up', 10)), h('div.sb-track', null, vthumb), h('button.sb-arrow', { type: 'button', onclick: () => app.viewport?.panBy(0, -60) }, icon('chevron-down', 10)));
  const hthumb = h('div.sb-thumb');
  const hscroll = h('div.hscroll', null, h('button.sb-arrow', { type: 'button', onclick: () => app.viewport?.panBy(60, 0) }, icon('chevron-left', 10)), h('div.sb-track', null, hthumb), h('button.sb-arrow', { type: 'button', onclick: () => app.viewport?.panBy(-60, 0) }, icon('chevron-right', 10)));
  const zoomField = h('input.status-zoom', { type: 'text', value: '100%' }) as HTMLInputElement;
  const info = h('span.status-info');
  const infoBtn = h('button.status-more', { type: 'button', title: 'Show status information', 'data-menu-anchor': '' }, icon('chevron-right', 12));
  const status = h('div.statusbar', null, zoomField, info, infoBtn, hscroll);
  const home = h('div.home-screen');
  const grid = h('div.canvas-grid', null, corner, rulerTop, rulerLeft, area);
  const main = h('div.canvas-main', null, grid, vscroll);
  const el = h('div.work', null, tabs, main, status, home);

  const viewport = new Viewport(area);

  // ---------------------------------------------------------------- status bar
  zoomField.addEventListener('keydown', e => {
    e.stopPropagation();
    if (e.key === 'Enter') {
      const v = parseFloat(zoomField.value);
      if (Number.isFinite(v) && v > 0) viewport.setZoom(v / 100);
      zoomField.blur();
    } else if (e.key === 'Escape') zoomField.blur();
  });
  zoomField.addEventListener('focus', () => zoomField.select());
  zoomField.addEventListener('blur', () => syncStatus());
  infoBtn.addEventListener('click', () => {
    const opt = (k: InfoKind, label: string) => ({ label, radio: true, checked: infoKind === k, action: () => { infoKind = k; localStorage.setItem('pixora.statusInfo', k); syncStatus(); } });
    openMenu([
      opt('sizes', 'Document Sizes'), opt('profile', 'Document Profile'), opt('dimensions', 'Document Dimensions'), opt('scale', 'Measurement Scale'),
      opt('scratch', 'Scratch Sizes'), opt('efficiency', 'Efficiency'), opt('timing', 'Timing'), opt('tool', 'Current Tool'), opt('layers', 'Layer Count'),
    ], infoBtn, { side: 'below' });
  });

  const fmtBytes = (n: number) => n >= 1024 * 1024 ? (n / 1024 / 1024).toFixed(2).replace(/\.?0+$/, '') + 'M' : Math.round(n / 1024) + 'K';
  const syncStatus = () => {
    const d = app.activeDoc;
    if (document.activeElement !== zoomField) zoomField.value = d ? formatZoom(d.view.zoom) : '';
    zoomField.disabled = !d;
    if (!d) { info.textContent = ''; return; }
    const flat = d.width * d.height * 3;
    const res = d.resolutionUnit === 'ppcm' ? `${(d.resolution / 2.54).toFixed(2)} ppcm` : `${Math.round(d.resolution * 100) / 100} ppi`;
    switch (infoKind) {
      case 'sizes': info.textContent = `Doc: ${fmtBytes(flat)}/${fmtBytes(d.allLayers().length * d.width * d.height * 4)}`; break;
      case 'profile': info.textContent = `${d.mode === 'RGB' ? 'sRGB IEC61966-2.1' : d.mode} (${d.bitDepth}bpc)`; break;
      case 'dimensions': info.textContent = `${d.width} px x ${d.height} px (${res})`; break;
      case 'scale': info.textContent = '1 pixel = 1.0000 pixels'; break;
      case 'scratch': info.textContent = `Scratch: ${fmtBytes(flat * (d.history.entries.length + 1))}/${fmtBytes((performance as any).memory?.jsHeapSizeLimit || 4e9)}`; break;
      case 'efficiency': info.textContent = 'Efficiency: 100%'; break;
      case 'timing': info.textContent = `${(lastFrame / 1000).toFixed(3)} sec`; break;
      case 'tool': info.textContent = app.activeTool?.name || ''; break;
      case 'layers': info.textContent = `${d.allLayers().length} Layers`; break;
    }
  };
  let lastFrame = 0;

  // ---------------------------------------------------------------- scrollbars
  const syncScroll = () => {
    const s = viewport.scrollInfo();
    vscroll.classList.toggle('disabled', !s); hscroll.classList.toggle('disabled', !s);
    if (!s) return;
    const place = (thumb: HTMLElement, axis: { pos: number; size: number; total: number }, vertical: boolean) => {
      const track = thumb.parentElement!;
      const len = vertical ? track.clientHeight : track.clientWidth;
      const tl = Math.max(24, (axis.size / axis.total) * len);
      const t = Math.max(0, Math.min(len - tl, ((axis.pos - axis.size / 2) / (axis.total - axis.size || 1)) * (len - tl)));
      if (vertical) { thumb.style.height = tl + 'px'; thumb.style.top = t + 'px'; }
      else { thumb.style.width = tl + 'px'; thumb.style.left = t + 'px'; }
    };
    place(vthumb, s.y, true);
    place(hthumb, s.x, false);
  };
  const thumbDrag = (thumb: HTMLElement, vertical: boolean) => thumb.addEventListener('pointerdown', e => {
    e.preventDefault();
    const s = viewport.scrollInfo();
    if (!s) return;
    const axis = vertical ? s.y : s.x;
    const track = thumb.parentElement!;
    const len = vertical ? track.clientHeight : track.clientWidth;
    const tl = vertical ? thumb.offsetHeight : thumb.offsetWidth;
    const ratio = (axis.total - axis.size) / Math.max(1, len - tl);
    let last = 0;
    viewport.beginInteraction();
    dragPointer(e, (dx, dy) => {
      const dd = (vertical ? dy : dx) - last;
      last = vertical ? dy : dx;
      if (vertical) viewport.panBy(0, -dd * ratio); else viewport.panBy(-dd * ratio, 0);
    }, () => viewport.endInteraction());
  });
  thumbDrag(vthumb, true);
  thumbDrag(hthumb, false);

  // ---------------------------------------------------------------- rulers
  const drawRulers = () => {
    const show = viewOptions.rulers && !!app.activeDoc;
    grid.classList.toggle('with-rulers', show);
    if (!show) return;
    const d = app.activeDoc!;
    const dpr = window.devicePixelRatio || 1;
    const css = getComputedStyle(document.documentElement);
    const bgc = css.getPropertyValue('--ruler-bg').trim() || '#535353';
    const fgc = css.getPropertyValue('--ruler-fg').trim() || '#c8c8c8';
    for (const [cv, horiz] of [[rulerTop, true], [rulerLeft, false]] as [HTMLCanvasElement, boolean][]) {
      const w = horiz ? area.clientWidth : RULER, hh = horiz ? RULER : area.clientHeight;
      if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(hh * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(hh * dpr); cv.style.width = w + 'px'; cv.style.height = hh + 'px'; }
      const x = cv.getContext('2d')!;
      x.setTransform(dpr, 0, 0, dpr, 0, 0);
      x.fillStyle = bgc; x.fillRect(0, 0, w, hh);
      x.strokeStyle = fgc; x.fillStyle = fgc; x.lineWidth = 1;
      x.font = '9px system-ui, sans-serif';
      const unit = unitScale(d);
      const z = d.view.zoom / unit.pxPerUnit;               // screen px per unit
      const steps = [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 5000, 10000];
      const major = steps.find(s => s * z >= 60) ?? 10000;
      const minor = major / (major % 5 === 0 ? 5 : major % 4 === 0 ? 4 : 2);
      const origin = viewport.docToScreen(0, 0);
      const o = horiz ? origin.x : origin.y;
      const len = horiz ? w : hh;
      const startU = Math.floor((-o / z) / minor) * minor;
      x.beginPath();
      for (let u = startU; (u * z + o) < len; u += minor) {
        const p = Math.round(u * z + o) + 0.5;
        const isMajor = Math.abs(u / major - Math.round(u / major)) < 1e-6;
        const tick = isMajor ? RULER : RULER * 0.3;
        if (horiz) { x.moveTo(p, RULER); x.lineTo(p, RULER - tick); } else { x.moveTo(RULER, p); x.lineTo(RULER - tick, p); }
        if (isMajor) {
          const label = String(Math.round(u * 100) / 100);
          if (horiz) x.fillText(label, p + 2, 9);
          else { x.save(); x.translate(9, p + 2); x.rotate(-Math.PI / 2); x.fillText(label, -x.measureText(label).width, 0); x.restore(); }
        }
      }
      x.stroke();
      x.strokeStyle = 'rgba(0,0,0,0.5)';
      x.beginPath();
      if (horiz) { x.moveTo(0, RULER - 0.5); x.lineTo(w, RULER - 0.5); } else { x.moveTo(RULER - 0.5, 0); x.lineTo(RULER - 0.5, hh); }
      x.stroke();
      // pointer marker
      if (viewport.pointer.inside) {
        const p = horiz ? viewport.pointer.sx : viewport.pointer.sy;
        x.strokeStyle = fgc; x.setLineDash([2, 2]);
        x.beginPath();
        if (horiz) { x.moveTo(p + 0.5, 0); x.lineTo(p + 0.5, RULER); } else { x.moveTo(0, p + 0.5); x.lineTo(RULER, p + 0.5); }
        x.stroke(); x.setLineDash([]);
      }
    }
  };
  rulerTop.addEventListener('pointerdown', e => workspaceHooks.rulerPointerDown?.('h', e, viewport));
  rulerLeft.addEventListener('pointerdown', e => workspaceHooks.rulerPointerDown?.('v', e, viewport));
  corner.addEventListener('dblclick', () => runCommand('edit.preferences', 'units'));

  // ---------------------------------------------------------------- home screen
  const syncHome = () => {
    const empty = app.docs.length === 0 || document.body.classList.contains('show-home');
    el.classList.toggle('empty', empty);
    if (!empty) return;
    clear(home);
    if (workspaceHooks.renderHome) { workspaceHooks.renderHome(home); return; }
    home.append(
      h('div.home-inner', null,
        h('div.home-title', null, 'Welcome to Pixora'),
        h('div.home-sub', null, 'Create something new, or open a file to get started.'),
        h('div.home-actions', null,
          h('button.btn.primary', { type: 'button', onclick: () => runCommand('file.new') }, 'New file'),
          h('button.btn', { type: 'button', onclick: () => runCommand('file.open') }, 'Open'),
        )));
  };

  // ---------------------------------------------------------------- wiring
  const onDoc = (d: PixDocument | null) => { viewport.setDocument(d); syncStatus(); syncScroll(); drawRulers(); syncHome(); };
  events.on('activeDoc', onDoc);
  events.on('docs', () => syncHome());
  events.on('view', () => { syncStatus(); syncScroll(); drawRulers(); });
  events.on('docSize', d => { if (d === app.activeDoc) { if (d.view.fitted) viewport.fit(); syncStatus(); syncScroll(); drawRulers(); } });
  events.on('layers', syncStatus);
  events.on('tool', syncStatus);
  events.on('prefs', drawRulers);
  let rulerQueued = false;
  events.on('render', () => { if (viewOptions.rulers && !rulerQueued) { rulerQueued = true; requestAnimationFrame(() => { rulerQueued = false; drawRulers(); }); } });
  window.addEventListener('resize', () => requestAnimationFrame(() => { syncScroll(); drawRulers(); }));
  new ResizeObserver(() => { syncScroll(); drawRulers(); }).observe(area);
  events.on('render', () => { const t = performance.now(); lastFrame = t - (lastFrameStart || t); lastFrameStart = t; });
  let lastFrameStart = 0;
  onDoc(app.activeDoc);
  return { el, viewport };
}

/** Ruler unit conversion for the current prefs. */
export function unitScale(d: PixDocument): { pxPerUnit: number; label: string } {
  const res = d.resolution;
  switch (app.prefs.rulerUnits) {
    case 'in': return { pxPerUnit: res, label: 'in' };
    case 'cm': return { pxPerUnit: res / 2.54, label: 'cm' };
    case 'mm': return { pxPerUnit: res / 25.4, label: 'mm' };
    case 'pt': return { pxPerUnit: res / 72, label: 'pt' };
    case '%': return { pxPerUnit: d.width / 100, label: '%' };
    default: return { pxPerUnit: 1, label: 'px' };
  }
}
