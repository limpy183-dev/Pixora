// Document tabs: "Untitled-1 @ 55.1% (RGB/8) *"
import { h, clear } from './dom';
import { icon } from './icons';
import { events } from '../core/events';
import { app } from '../core/app';
import { runCommand } from '../core/commands';
import { contextMenu } from './menu';
import type { PixDocument } from '../core/document';

export function formatZoom(z: number): string {
  const p = z * 100;
  return (p >= 100 ? Math.round(p * 10) / 10 : p >= 10 ? Math.round(p * 10) / 10 : Math.round(p * 100) / 100) + '%';
}
export function docTitle(d: PixDocument): string {
  const layer = d.activeLayer;
  const layerPart = layer && !(d.layers.length === 1 && layer.isBackground) ? `${layer.name}, ` : '';
  const mode = d.mode === 'RGB' ? 'RGB' : d.mode === 'Grayscale' ? 'Gray' : d.mode;
  return `${d.name} @ ${formatZoom(d.view.zoom)} (${layerPart}${mode}/${d.bitDepth})${d.modified ? ' *' : ''}`;
}

export function createTabs(): HTMLElement {
  const bar = h('div.doc-tabs');
  const render = () => {
    clear(bar);
    for (const d of app.docs) {
      const tab = h('div.doc-tab', { class: d === app.activeDoc ? 'active' : '', title: docTitle(d) },
        h('span.doc-tab-title', null, docTitle(d)),
        h('button.doc-tab-close', { type: 'button', title: 'Close' }, icon('close', 12)));
      tab.addEventListener('pointerdown', e => {
        if ((e.target as Element).closest('.doc-tab-close')) return;
        if (e.button === 1) { e.preventDefault(); app.setActiveDocument(d); runCommand('file.close', d); return; }
        app.setActiveDocument(d);
        // drag to reorder
        const startX = e.clientX;
        const move = (ev: PointerEvent) => {
          const dx = ev.clientX - startX;
          if (Math.abs(dx) < 20) return;
          const i = app.docs.indexOf(d), j = Math.max(0, Math.min(app.docs.length - 1, i + Math.sign(dx)));
          const other = bar.children[j] as HTMLElement | undefined;
          if (j !== i && other) {
            const r = other.getBoundingClientRect();
            if ((dx > 0 && ev.clientX > r.left + r.width / 2) || (dx < 0 && ev.clientX < r.left + r.width / 2)) {
              app.docs.splice(i, 1); app.docs.splice(j, 0, d); render();
              window.removeEventListener('pointermove', move);
            }
          }
        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', () => window.removeEventListener('pointermove', move), { once: true });
      });
      tab.querySelector('.doc-tab-close')!.addEventListener('click', e => { e.stopPropagation(); runCommand('file.close', d); });
      tab.addEventListener('contextmenu', e => contextMenu(e, [
        { label: 'Close', action: () => runCommand('file.close', d) },
        { label: 'Close All', cmd: 'file.closeAll' },
        { label: 'Close Others', action: () => { app.setActiveDocument(d); runCommand('file.closeOthers'); } },
        '-',
        { label: 'New Document', cmd: 'file.new' },
        { label: 'Duplicate...', cmd: 'image.duplicate' },
        '-',
        { label: 'Reveal in Explorer', enabled: false },
      ]));
      bar.appendChild(tab);
    }
  };
  let queued = false;
  const later = () => { if (queued) return; queued = true; requestAnimationFrame(() => { queued = false; render(); }); };
  for (const ev of ['docs', 'activeDoc', 'view', 'history', 'activeLayer', 'docSize', 'layers'] as const) events.on(ev, later as any);
  render();
  return bar;
}
