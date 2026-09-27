// Properties panel section for adjustment layers: header (icon + mask toggle), the adjustment's controls bound
// live to layer.adjustment.params (undoable, "Modify Levels Layer"), footer (clip, previous state, reset,
// visibility, delete).
import { registerPropertiesSection } from '../core/registry';
import { events } from '../core/events';
import { AdjustmentLayer } from '../core/layer';
import type { PixDocument } from '../core/document';
import { h } from '../ui/dom';
import { icon } from '../ui/icons';
import { iconButton } from '../ui/widgets';
import { defs, clone, Env } from './lib';
import { mountAdjustmentUI, assignParams } from './ui';

/** Bind an adjustment layer's params to live, undoable edits. */
function liveBinding(doc: PixDocument, l: AdjustmentLayer, label: string) {
  let tx: ReturnType<PixDocument['history']['begin']> | null = null;
  let baseline = clone(l.adjustment.params);
  let raf = 0, idle = 0;
  const commit = () => {
    clearTimeout(idle);
    if (!tx) return;
    const t = tx; tx = null;
    t.commit();
    baseline = clone(l.adjustment.params);
    doc.layersChanged();
  };
  const change = (final?: boolean) => {
    if (!tx) {
      // capture the state BEFORE this edit (the UI has already mutated params)
      const cur = l.adjustment.params;
      l.adjustment.params = clone(baseline);
      tx = doc.history.begin(`Modify ${label} Layer`, 'adjust-layer');
      l.adjustment.params = cur;
    }
    l.invalidate();
    if (!raf) raf = requestAnimationFrame(() => { raf = 0; doc.invalidate(); });
    clearTimeout(idle);
    if (final) commit(); else idle = window.setTimeout(commit, 600);
  };
  return {
    change, commit,
    dispose() { cancelAnimationFrame(raf); commit(); },
    /** Forget the pending edit (history jumped underneath us). */
    reset() { clearTimeout(idle); tx = null; baseline = clone(l.adjustment.params); },
  };
}

const session: { layer: AdjustmentLayer | null; params: any } = { layer: null, params: null };

registerPropertiesSection({
  id: 'adjustment', title: 'Adjustment', order: 10,
  match: (_doc, layer) => !!layer && layer.kind === 'adjustment',
  build(container, doc, layer) {
    const l = layer as AdjustmentLayer;
    const def = defs[l.adjustment.type];
    if (!def) { container.append(h('div.panel-empty', null, `Unknown adjustment “${l.adjustment.type}”.`)); return; }
    const root = h('div.adjp');
    const body = h('div.adjp-body');
    const env = new Env(doc, l);
    // "view previous state" = settings when the layer was selected (survives panel rebuilds for the same layer)
    if (session.layer !== l) { session.layer = l; session.params = clone(l.adjustment.params); }
    let bind = liveBinding(doc, l, def.label);
    let unmount: () => void = () => {};
    let bound: any = null;
    const mount = () => {
      unmount();
      bound = l.adjustment.params;
      unmount = mountAdjustmentUI(def, body, bound, f => bind.change(f), env);
    };

    // ---- header
    const maskBtn = iconButton('adj-mask-toggle', 'Mask: click to target the layer mask (paint on it to hide/reveal the adjustment)', () => {
      if (!l.mask) return;
      doc.editMask = !doc.editMask;
      syncHead();
      events.emit('activeLayer', doc);
    }, { size: 18 });
    const adjBtn = iconButton(def.icon || 'adjust-layer', `${def.label} settings`, () => { if (doc.editMask) { doc.editMask = false; syncHead(); events.emit('activeLayer', doc); } }, { size: 18 });
    const syncHead = () => {
      maskBtn.disabled = !l.mask;
      maskBtn.classList.toggle('on', !!doc.editMask && !!l.mask);
      adjBtn.classList.toggle('on', !doc.editMask || !l.mask);
    };
    const head = h('div.adjp-head', null, adjBtn, maskBtn, h('span.adjp-title', null, l.name));

    // ---- footer
    const clipBtn = iconButton('clip', 'This adjustment affects all layers below (click to clip to layer)', () => {
      bind.commit();
      doc.history.transaction(l.clipped ? 'Release Clipping Mask' : 'Create Clipping Mask', () => { l.clipped = !l.clipped; });
      doc.layersChanged(); syncFoot();
    });
    const prevBtn = iconButton('adj-prev', 'Press to view previous state', undefined);
    prevBtn.addEventListener('pointerdown', e => {
      e.preventDefault();
      const cur = l.adjustment.params;
      l.adjustment.params = session.params;
      doc.invalidate();
      prevBtn.classList.add('active');
      const up = () => { l.adjustment.params = cur; doc.invalidate(); prevBtn.classList.remove('active'); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', up); };
      window.addEventListener('pointerup', up); window.addEventListener('pointercancel', up);
    });
    const resetBtn = iconButton('reset', 'Reset to adjustment defaults', () => {
      bind.commit();
      doc.history.transaction(`Reset ${def.label} Layer`, () => { assignParams(l.adjustment.params, def.defaults()); l.invalidate(); });
      bind.reset();
      doc.layersChanged(); mount();
    });
    const eyeBtn = iconButton(l.visible ? 'eye' : 'eye-off', 'Toggle layer visibility', () => {
      bind.commit();
      doc.history.transaction(l.visible ? 'Hide Layer' : 'Show Layer', () => { l.visible = !l.visible; });
      doc.layersChanged(); syncFoot();
    });
    const delBtn = iconButton('trash', 'Delete this adjustment layer', () => {
      bind.commit();
      doc.history.transaction('Delete Layer', () => doc.removeLayer(l));
    });
    const syncFoot = () => {
      clipBtn.classList.toggle('active', l.clipped);
      clipBtn.title = l.clipped ? 'This adjustment clips to the layer below (click to affect all layers below)' : 'This adjustment affects all layers below (click to clip to layer)';
      eyeBtn.replaceChildren(icon(l.visible ? 'eye' : 'eye-off', 18));
    };
    const foot = h('div.adjp-foot', null, clipBtn, prevBtn, resetBtn, eyeBtn, delBtn);

    root.append(head, body, foot);
    container.append(root);
    mount(); syncHead(); syncFoot();

    // ---- keep in sync with history jumps / other panels, refresh histograms when the image below changes
    let pxTimer = 0;
    const offs = [
      events.on('history', d => {
        if (d !== doc) return;
        if (l.adjustment.params !== bound) { bind.reset(); mount(); }
        syncHead(); syncFoot();
      }),
      events.on('layers', d => { if (d === doc) { syncHead(); syncFoot(); } }),
      events.on('pixels', e => {
        if (e.doc !== doc) return;
        clearTimeout(pxTimer);
        pxTimer = window.setTimeout(() => env.invalidate(), 500);
      }),
    ];
    return () => {
      clearTimeout(pxTimer);
      for (const off of offs) off();
      bind.dispose();
      unmount();
    };
  },
});
