// Clone Source panel: five clone source slots, offset, scale (W/H, linked), rotation, flip, reset, and the
// overlay options (Show Overlay, Opacity, Clipped, Auto Hide, Invert, blend mode). Shared by the Clone Stamp and
// Healing Brush tools.
import { registerPanel } from '../../ui/panels';
import { h, clear } from '../../ui/dom';
import { icon } from '../../ui/icons';
import { checkbox, iconButton, numberField, select, type Field } from '../../ui/widgets';
import { app } from '../../core/app';
import { events } from '../../core/events';
import { activeSource, clone, cloneChanged, onCloneChange, resetTransform, type OverlayMode } from './source';

registerPanel({
  id: 'clone-source', title: 'Clone Source', icon: 'clone-source', preferredWidth: 300,
  create(el) {
    const root = h('div.cs-panel.panel-scroll');
    el.append(root);

    // ------------------------------------------------ source slots
    const slots = h('div.cs-sources');
    const slotBtns = clone.sources.map((_s, i) => {
      const b = h('button.icon-btn.cs-src', { type: 'button', title: `Clone Source ${i + 1}` }, icon('clone-stamp', 18));
      b.addEventListener('click', () => { clone.active = i; cloneChanged(); });
      slots.append(b);
      return b;
    });
    const info = h('div.cs-info');

    // ------------------------------------------------ transform
    const S = () => activeSource();
    const set = (fn: () => void) => { fn(); cloneChanged(); };
    const offX = numberField(0, v => set(() => { const s = S(); s.offset = { x: v, y: s.offset?.y ?? 0 }; }), { label: 'X:', unit: 'px', width: 58, title: 'Horizontal offset between the source and the destination' });
    const offY = numberField(0, v => set(() => { const s = S(); s.offset = { x: s.offset?.x ?? 0, y: v }; }), { label: 'Y:', unit: 'px', width: 58, title: 'Vertical offset between the source and the destination' });
    const wf = numberField(100, v => set(() => { const s = S(); s.scaleX = v; if (s.linked) s.scaleY = v; }), { label: 'W:', unit: '%', width: 58, min: 1, max: 1000, decimals: 1, title: 'Scale the source horizontally' });
    const hf = numberField(100, v => set(() => { const s = S(); s.scaleY = v; if (s.linked) s.scaleX = v; }), { label: 'H:', unit: '%', width: 58, min: 1, max: 1000, decimals: 1, title: 'Scale the source vertically' });
    const link = iconButton('link', 'Maintain aspect ratio', () => set(() => { const s = S(); s.linked = !s.linked; if (s.linked) s.scaleY = s.scaleX; }), { cls: 'cs-link' });
    const ang = numberField(0, v => set(() => { S().angle = v; }), { unit: '°', width: 58, min: -360, max: 360, decimals: 1, title: 'Rotate the clone source' });
    const flipH = iconButton('flip-h', 'Flip Horizontal', () => set(() => { S().flipH = !S().flipH; }));
    const flipV = iconButton('flip-v', 'Flip Vertical', () => set(() => { S().flipV = !S().flipV; }));
    const reset = iconButton('reset', 'Reset Transform', () => resetTransform(S()));

    // ------------------------------------------------ overlay
    const ov = clone.overlay;
    const setOv = (fn: () => void) => { fn(); cloneChanged(); };
    const show = checkbox('Show Overlay', ov.showOverlay, v => setOv(() => { ov.showOverlay = v; }), { title: 'Show a preview of the clone source over the destination' });
    const opac = numberField(ov.opacity, v => setOv(() => { ov.opacity = v; }), { label: 'Opacity:', unit: '%', min: 0, max: 100, width: 48, title: 'Opacity of the overlay' });
    const clipped = checkbox('Clipped', ov.clipped, v => setOv(() => { ov.clipped = v; }), { title: 'Clip the overlay to the brush tip' });
    const autoHide = checkbox('Auto Hide', ov.autoHide, v => setOv(() => { ov.autoHide = v; }), { title: 'Hide the overlay while painting' });
    const invert = checkbox('Invert', ov.invert, v => setOv(() => { ov.invert = v; }), { title: 'Invert the colours of the overlay' });
    const mode = select<OverlayMode>([
      { value: 'normal', label: 'Normal' }, { value: 'darken', label: 'Darken' }, { value: 'lighten', label: 'Lighten' }, { value: 'difference', label: 'Difference' },
    ], ov.mode, v => setOv(() => { ov.mode = v; }), { width: 100, title: 'Overlay blending mode' });

    const grid = h('div.cs-grid', null,
      h('span.cs-dim', null, 'Offset:'), h('span'), h('span'), h('span'),
      offX, h('span'), offY, h('span'),
      wf, link, hf, h('span'),
    );
    root.append(
      slots, info, h('div.cs-sep'), grid,
      h('div.cs-row', null, h('span', { title: 'Rotation' }, icon('angle', 18)), ang, flipH, flipV, reset),
      h('div.cs-sep'),
      h('div.cs-row', null, show),
      h('div.cs-row', null, opac, mode),
      h('div.cs-row', null, clipped, autoHide, invert),
    );

    const setF = (f: Field<number>, v: number) => f.setValue(v);
    const refresh = () => {
      const s = S();
      slotBtns.forEach((b, i) => {
        b.classList.toggle('active', i === clone.active);
        b.classList.toggle('defined', clone.sources[i].defined);
      });
      clear(info);
      info.append(s.defined ? `Source: ${s.docName}${s.layerName ? ' : ' + s.layerName : ''} (${s.sx}, ${s.sy})` : 'Alt-click in an image to define the source.');
      setF(offX, s.offset?.x ?? 0); setF(offY, s.offset?.y ?? 0);
      setF(wf, s.scaleX); setF(hf, s.scaleY);
      setF(ang, s.angle);
      link.classList.toggle('active', s.linked);
      flipH.classList.toggle('active', s.flipH); flipV.classList.toggle('active', s.flipV);
      show.setValue(ov.showOverlay); opac.setValue(ov.opacity); clipped.setValue(ov.clipped); autoHide.setValue(ov.autoHide); invert.setValue(ov.invert); mode.setValue(ov.mode);
    };
    refresh();
    const offs = [onCloneChange(refresh), events.on('activeDoc', refresh)];
    return { onShow: refresh, destroy: () => offs.forEach(f => f()) };
  },
  menu: () => [
    { label: 'Reset Transform', action: () => resetTransform(activeSource()) },
    { label: 'Clear Source', action: () => { const s = activeSource(); s.defined = false; s.offset = null; cloneChanged(); } },
    '-',
    { label: 'Show Overlay', checked: () => clone.overlay.showOverlay, action: () => { clone.overlay.showOverlay = !clone.overlay.showOverlay; cloneChanged(); } },
    { label: 'Use Clone Stamp Tool', action: () => app.setTool('clone-stamp') },
    { label: 'Use Healing Brush Tool', action: () => app.setTool('healing-brush') },
  ],
});
