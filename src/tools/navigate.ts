// Hand (H), Rotate View (R) and Zoom (Z) tools.
import { app, type Tool } from '../core/app';
import { checkbox, button, numberField, separator, iconButton } from '../ui/widgets';
import { CURSORS } from '../ui/cursors';

import { events } from '../core/events';

const vp = () => app.viewport!;
const viewButtons = () => [
  button('100%', () => vp().actualPixels(), { cls: 'small' }),
  button('Fit Screen', () => vp().fit(), { cls: 'small' }),
  button('Fill Screen', () => vp().fill(), { cls: 'small' }),
];

// ---------------------------------------------------------------- Hand
let panLast: { sx: number; sy: number } | null = null;
const hand: Tool = {
  id: 'hand', name: 'Hand Tool', group: 'hand', icon: 'hand', shortcut: 'H', order: 0,
  settings: { scrollAll: false },
  cursor: () => (panLast ? CURSORS.grab : CURSORS.hand),
  options(bar) {
    bar.append(checkbox('Scroll All Windows', hand.settings!.scrollAll, v => { hand.settings!.scrollAll = v; app.saveToolSettings(hand); }), separator(), ...viewButtons());
  },
  pointerDown(p) { panLast = { sx: p.sx, sy: p.sy }; vp().beginInteraction(); vp().updateCursor(); },
  pointerMove(p) {
    if (!panLast) return;
    const dx = p.sx - panLast.sx, dy = p.sy - panLast.sy;
    panLast = { sx: p.sx, sy: p.sy };
    vp().panBy(dx, dy);
    if (hand.settings!.scrollAll) for (const d of app.docs) if (d !== app.activeDoc) { d.view.panX += dx; d.view.panY += dy; d.view.fitted = false; }
  },
  pointerUp() { panLast = null; vp().endInteraction(); vp().updateCursor(); },
  dblclick() { vp().fit(); },
};

// ---------------------------------------------------------------- Rotate View
let rot: { a0: number; r0: number } | null = null;
const rotate: Tool = {
  id: 'rotate-view', name: 'Rotate View Tool', group: 'hand', icon: 'rotate-view', shortcut: 'R', order: 1,
  settings: { rotateAll: false },
  cursor: CURSORS.rotate,
  options(bar) {
    const angle = numberField(app.activeDoc?.view.rotation ?? 0, v => vp().setRotation(v), { label: 'Rotation Angle:', unit: '°', min: -360, max: 360, width: 48 });
    const off = events.on('view', () => angle.setValue(Math.round(app.activeDoc?.view.rotation ?? 0)));
    bar.append(angle, button('Reset View', () => vp().setRotation(0), { cls: 'small' }), separator(),
      checkbox('Rotate All Windows', rotate.settings!.rotateAll, v => { rotate.settings!.rotateAll = v; app.saveToolSettings(rotate); }));
    return off;
  },
  pointerDown(p, doc) {
    const v = vp();
    rot = { a0: Math.atan2(p.sy - v.height / 2, p.sx - v.width / 2), r0: doc.view.rotation };
    v.beginInteraction();
  },
  pointerMove(p) {
    if (!rot) return;
    const v = vp();
    let deg = rot.r0 + ((Math.atan2(p.sy - v.height / 2, p.sx - v.width / 2) - rot.a0) * 180) / Math.PI;
    if (p.shift) deg = Math.round(deg / 15) * 15;
    v.setRotation(deg);
    if (rotate.settings!.rotateAll) for (const d of app.docs) d.view.rotation = app.activeDoc!.view.rotation;
  },
  pointerUp() { rot = null; vp().endInteraction(); },
  dblclick() { vp().setRotation(0); },
  keyDown(e) { if (e.key === 'Escape' && app.activeDoc?.view.rotation) { vp().setRotation(0); return true; } return false; },
  drawOverlay(ctx, view, doc) {
    if (!rot) return;
    // compass
    const cx = view.width / 2, cy = view.height / 2;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate((doc.view.rotation * Math.PI) / 180);
    ctx.strokeStyle = 'rgba(255,255,255,.85)'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(0, 0, 60, 0, Math.PI * 2); ctx.stroke();
    ctx.fillStyle = '#e33'; ctx.beginPath(); ctx.moveTo(0, -60); ctx.lineTo(-8, -36); ctx.lineTo(8, -36); ctx.fill();
    ctx.fillStyle = '#ddd'; ctx.beginPath(); ctx.moveTo(0, 60); ctx.lineTo(-8, 36); ctx.lineTo(8, 36); ctx.fill();
    ctx.restore();
  },
};

// ---------------------------------------------------------------- Zoom
let zdrag: { sx: number; sy: number; x: number; y: number; z0: number; moved: boolean; out: boolean } | null = null;
const zoomSettings = { mode: 'in' as 'in' | 'out', resizeWindows: false, zoomAll: false, scrubby: true };
const zoom: Tool = {
  id: 'zoom', name: 'Zoom Tool', group: 'zoom', icon: 'zoom', shortcut: 'Z', order: 0,
  settings: zoomSettings,
  cursor: () => {
    const alt = app.viewport && (window as any).__altDown;
    const out = zoomSettings.mode === 'out' ? !alt : !!alt;
    return out ? CURSORS.zoomOut : CURSORS.zoomIn;
  },
  options(bar) {
    const zin = iconButton('zoom-in', 'Zoom In', () => { zoomSettings.mode = 'in'; sync(); app.saveToolSettings(zoom); }, { size: 20 });
    const zout = iconButton('zoom-out', 'Zoom Out', () => { zoomSettings.mode = 'out'; sync(); app.saveToolSettings(zoom); }, { size: 20 });
    const sync = () => { zin.classList.toggle('active', zoomSettings.mode === 'in'); zout.classList.toggle('active', zoomSettings.mode === 'out'); };
    sync();
    bar.append(zin, zout, separator(),
      checkbox('Resize Windows to Fit', zoomSettings.resizeWindows, v => { zoomSettings.resizeWindows = v; app.saveToolSettings(zoom); }),
      checkbox('Zoom All Windows', zoomSettings.zoomAll, v => { zoomSettings.zoomAll = v; app.saveToolSettings(zoom); }),
      checkbox('Scrubby Zoom', zoomSettings.scrubby, v => { zoomSettings.scrubby = v; app.saveToolSettings(zoom); }),
      separator(), ...viewButtons());
  },
  pointerDown(p, doc) {
    const out = (zoomSettings.mode === 'out') !== p.alt;
    zdrag = { sx: p.sx, sy: p.sy, x: p.x, y: p.y, z0: doc.view.zoom, moved: false, out };
    vp().beginInteraction();
  },
  pointerMove(p) {
    if (!zdrag) return;
    const dx = p.sx - zdrag.sx, dy = p.sy - zdrag.sy;
    if (!zdrag.moved && Math.hypot(dx, dy) < 4) return;
    zdrag.moved = true;
    if (zoomSettings.scrubby) vp().setZoom(zdrag.z0 * Math.exp(dx * 0.01), { sx: zdrag.sx, sy: zdrag.sy });
    else app.activeDoc?.redrawOverlay();
  },
  pointerUp(p, doc) {
    const d = zdrag;
    zdrag = null;
    vp().endInteraction();
    if (!d) return;
    if (!d.moved) {
      if (d.out) vp().zoomOut({ sx: p.sx, sy: p.sy }); else vp().zoomIn({ sx: p.sx, sy: p.sy });
    } else if (!zoomSettings.scrubby) {
      // marquee zoom
      const w = Math.abs(p.sx - d.sx), hh = Math.abs(p.sy - d.sy);
      if (w > 4 && hh > 4) {
        const v = vp();
        const z = Math.min(64, doc.view.zoom * Math.min(v.width / w, v.height / hh));
        const cx = (p.x + d.x) / 2, cy = (p.y + d.y) / 2;
        v.setZoom(z);
        const s = v.docToScreen(cx, cy);
        v.panBy(v.width / 2 - s.x, v.height / 2 - s.y);
      }
    }
    if (zoomSettings.zoomAll) for (const other of app.docs) if (other !== doc) { other.view.zoom = doc.view.zoom; other.view.fitted = false; }
  },
  dblclick() { vp().actualPixels(); },
  drawOverlay(ctx) {
    if (!zdrag || !zdrag.moved || zoomSettings.scrubby) return;
    const v = vp();
    const x = Math.min(zdrag.sx, v.pointer.sx), y = Math.min(zdrag.sy, v.pointer.sy);
    ctx.strokeStyle = '#000'; ctx.setLineDash([4, 4]); ctx.strokeRect(x + .5, y + .5, Math.abs(v.pointer.sx - zdrag.sx), Math.abs(v.pointer.sy - zdrag.sy));
    ctx.strokeStyle = '#fff'; ctx.lineDashOffset = 4; ctx.strokeRect(x + .5, y + .5, Math.abs(v.pointer.sx - zdrag.sx), Math.abs(v.pointer.sy - zdrag.sy));
  },
};
window.addEventListener('keydown', e => { if (e.key === 'Alt') { (window as any).__altDown = true; app.viewport?.updateCursor(); } });
window.addEventListener('keyup', e => { if (e.key === 'Alt') { (window as any).__altDown = false; app.viewport?.updateCursor(); } });

app.registerTool(hand);
app.registerTool(rotate);
app.registerTool(zoom);

