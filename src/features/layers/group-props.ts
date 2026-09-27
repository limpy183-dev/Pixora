// Properties panel section 'group' for layer groups: bounds (W/H read-only, X/Y move the group), contents summary.
import { events } from '../../core/events';
import { GroupLayer } from '../../core/layer';
import { registerPropertiesSection } from '../../core/registry';
import { runCommand } from '../../core/commands';
import { h } from '../../ui/dom';
import { icon } from '../../ui/icons';
import { button, numberField } from '../../ui/widgets';

registerPropertiesSection({
  id: 'group', title: 'Group', order: 20,
  match: (_doc, layer) => layer instanceof GroupLayer,
  build(container, doc, layer) {
    const g = layer as GroupLayer;
    const b = () => doc.layerBounds(g);
    const move = (dx: number, dy: number) => {
      if (g.positionLocked || (!dx && !dy)) return;
      doc.history.transaction('Move', () => g.translate(Math.round(dx), Math.round(dy)));
      doc.pixelsChanged(null, null); doc.layersChanged();
    };
    const W = numberField(0, () => sync(), { label: 'W', unit: 'px', width: 72, disabled: true });
    const H = numberField(0, () => sync(), { label: 'H', unit: 'px', width: 72, disabled: true });
    const X = numberField(0, v => { const r = b(); if (r) move(v - r.x, 0); }, { label: 'X', unit: 'px', width: 72 });
    const Y = numberField(0, v => { const r = b(); if (r) move(0, v - r.y); }, { label: 'Y', unit: 'px', width: 72 });
    const info = h('span.grp-info');
    const sync = () => {
      const r = b();
      W.setValue(r ? r.w : 0); H.setValue(r ? r.h : 0); X.setValue(r ? r.x : 0); Y.setValue(r ? r.y : 0);
      let n = 0; const walk = (l: GroupLayer) => l.children.forEach(c => { n++; if (c instanceof GroupLayer) walk(c); });
      walk(g);
      info.textContent = `${n} layer${n === 1 ? '' : 's'} · ${g.blendMode === 'pass-through' ? 'Pass Through' : 'Isolated'}${g.opacity < 1 ? ` · ${Math.round(g.opacity * 100)}%` : ''}`;
    };
    sync();
    const off = [events.on('layers', d => { if (d === doc) sync(); }), events.on('pixels', p => { if (p.doc === doc) sync(); })];
    container.append(h('div.grp-props', null,
      h('div.grp-head', null, icon('folder', 18), h('span', null, g.name)),
      h('div.grp-grid', null, W, X, H, Y),
      info,
      h('div.grp-buttons', null,
        button('Ungroup', () => runCommand('layer.ungroup'), { title: 'Ungroup Layers (Shift+Ctrl+G)' }),
        button('Merge Group', () => runCommand('layer.mergeDown'), { title: 'Merge the group into one layer (Ctrl+E)' }),
        button('Convert to Smart Object', () => runCommand('layer.toSmartObject'), { title: 'Convert the group to a smart object' })),
    ));
    return () => off.forEach(f => f());
  },
});

const css = document.createElement('style');
css.textContent = `
.grp-props { padding: 6px 12px 12px; display: flex; flex-direction: column; gap: 10px; }
.grp-head { display: flex; align-items: center; gap: 8px; color: var(--text-strong); }
.grp-grid { display: grid; grid-template-columns: auto auto; gap: 6px 16px; justify-content: start; }
.grp-grid .num-wrap .scrub-label { width: 14px; }
.grp-info { color: var(--text-dim); }
.grp-buttons { display: flex; gap: 8px; flex-wrap: wrap; }
`;
document.head.appendChild(css);
