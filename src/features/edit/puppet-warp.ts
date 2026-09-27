// Edit › Puppet Warp: a triangle mesh laid over the layer's content is deformed by pins (moving least squares —
// Rigid / Normal / Distort). Click the mesh to add pins, drag them to warp, Alt+click deletes a pin, Alt+drag near a
// selected pin rotates it, Shift+click multi-selects, Pin Depth sets which parts overlap. Enter commits.
import './warp.css';
import { app, type Tool, type ToolPointer } from '../../core/app';
import { registerCommands } from '../../core/commands';
import { createCanvas, ctx2d } from '../../core/canvas';
import type { Point } from '../../core/types';
import type { Viewport } from '../../core/viewport';
import { h } from '../../ui/dom';
import { registerIcons } from '../../ui/icons';
import { checkbox, iconButton, numberField, select, separator, type Field } from '../../ui/widgets';
import { grabLayer, showPreview, clearPreview, commitLayer, enterTool, type LayerSource } from './layer-session';

registerIcons({
  'pw-depth-up': '<rect x="8" y="3" width="11" height="11" rx="1.5" fill="currentColor" stroke="none"/><rect x="4" y="9" width="11" height="11" rx="1.5"/><path d="M11 9V6.5"/>',
  'pw-depth-down': '<rect x="4" y="9" width="11" height="11" rx="1.5" fill="currentColor" stroke="none"/><rect x="8" y="3" width="11" height="11" rx="1.5"/>',
  'pw-pins-off': '<circle cx="8" cy="9" r="2.5"/><circle cx="16" cy="15" r="2.5"/><path d="M4 20 20 4"/>',
});

type Mode = 'rigid' | 'normal' | 'distort';
type Density = 'fewer' | 'normal' | 'more';
interface Pin { p: Point; q: Point; rot: number | null; depth: number }
interface Mesh { step: number; nx: number; ny: number; vx: Float32Array; vy: Float32Array; used: Uint8Array; tris: Int32Array; dx: Float32Array; dy: Float32Array; /** 2×2-merged triangles for fast previews of dense meshes */ coarse: Int32Array | null }
type Drag = { kind: 'move'; start: Point; orig: Point[] } | { kind: 'rotate'; pin: Pin; a0: number; r0: number };
interface S { src: LayerSource; pins: Pin[]; sel: Set<Pin>; mesh: Mesh; drag: Drag | null; undo: string[]; back: () => void; raf: number; hover: ToolPointer | null }
let st: S | null = null;

const settings = { mode: 'normal' as Mode, density: 'normal' as Density, expansion: 2, showMesh: true };

// ------------------------------------------------------------------ mesh
function buildMesh(s: LayerSource): Mesh {
  const W = s.rect.w, H = s.rect.h;
  let step = settings.density === 'fewer' ? 40 : settings.density === 'more' ? 14 : 24;
  step = Math.max(step, Math.ceil(Math.sqrt((W * H) / 9000)));
  const nx = Math.max(1, Math.ceil(W / step)), ny = Math.max(1, Math.ceil(H / step));
  // quarter-resolution coverage, grown / shrunk by the expansion
  const k = 4, cw = Math.max(1, Math.ceil(W / k)), ch = Math.max(1, Math.ceil(H / k));
  const c = createCanvas(cw, ch), cx = c.getContext('2d', { willReadFrequently: true })!;
  cx.drawImage(s.src, 0, 0, cw, ch);
  const a = cx.getImageData(0, 0, cw, ch).data;
  const sat = new Int32Array((cw + 1) * (ch + 1));
  for (let y = 0; y < ch; y++) { let row = 0; for (let x = 0; x < cw; x++) { row += a[(y * cw + x) * 4 + 3] > 2 ? 1 : 0; sat[(y + 1) * (cw + 1) + x + 1] = sat[y * (cw + 1) + x + 1] + row; } }
  const box = (x0: number, y0: number, x1: number, y1: number) => { x0 = Math.max(0, x0); y0 = Math.max(0, y0); x1 = Math.min(cw, x1); y1 = Math.min(ch, y1); return x1 <= x0 || y1 <= y0 ? 0 : sat[y1 * (cw + 1) + x1] - sat[y0 * (cw + 1) + x1] - sat[y1 * (cw + 1) + x0] + sat[y0 * (cw + 1) + x0]; };
  const r = Math.round(Math.abs(settings.expansion) / k), grow = settings.expansion >= 0;
  const covered = (x: number, y: number) => {                        // coarse pixel after expansion
    if (grow) return box(x - r, y - r, x + r + 1, y + r + 1) > 0;
    const x0 = Math.max(0, x - r), y0 = Math.max(0, y - r), x1 = Math.min(cw, x + r + 1), y1 = Math.min(ch, y + r + 1);
    return box(x0, y0, x1, y1) === (x1 - x0) * (y1 - y0);
  };
  const cellOn = new Uint8Array(nx * ny);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const x0 = Math.floor((i * step) / k), y0 = Math.floor((j * step) / k), x1 = Math.min(cw, Math.ceil(((i + 1) * step) / k)), y1 = Math.min(ch, Math.ceil(((j + 1) * step) / k));
    if (grow && box(x0 - r, y0 - r, x1 + r, y1 + r) === 0) continue;
    let on = false;
    for (let y = y0; y < y1 && !on; y++) for (let x = x0; x < x1 && !on; x++) on = covered(x, y);
    if (on) cellOn[j * nx + i] = 1;
  }
  const V = (nx + 1) * (ny + 1), vx = new Float32Array(V), vy = new Float32Array(V), used = new Uint8Array(V);
  for (let j = 0; j <= ny; j++) for (let i = 0; i <= nx; i++) { vx[j * (nx + 1) + i] = s.rect.x + Math.min(W, i * step); vy[j * (nx + 1) + i] = s.rect.y + Math.min(H, j * step); }
  const tris: number[] = [];
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    if (!cellOn[j * nx + i]) continue;
    const a0 = j * (nx + 1) + i, a1 = a0 + 1, b0 = a0 + nx + 1, b1 = b0 + 1;
    used[a0] = used[a1] = used[b0] = used[b1] = 1;
    // alternate the diagonal so the mesh bends evenly
    if ((i + j) & 1) tris.push(a0, a1, b1, a0, b1, b0); else tris.push(a0, a1, b0, a1, b1, b0);
  }
  let coarse: Int32Array | null = null;
  if (tris.length / 3 > 2500) {
    const ct: number[] = [], vi = (i: number, j: number) => Math.min(j, ny) * (nx + 1) + Math.min(i, nx);
    for (let j = 0; j < ny; j += 2) for (let i = 0; i < nx; i += 2) {
      if (!(cellOn[j * nx + i] || (i + 1 < nx && cellOn[j * nx + i + 1]) || (j + 1 < ny && cellOn[(j + 1) * nx + i]) || (i + 1 < nx && j + 1 < ny && cellOn[(j + 1) * nx + i + 1]))) continue;
      const a0 = vi(i, j), a1 = vi(i + 2, j), b0 = vi(i, j + 2), b1 = vi(i + 2, j + 2);
      used[a0] = used[a1] = used[b0] = used[b1] = 1;
      ct.push(a0, a1, b1, a0, b1, b0);
    }
    coarse = Int32Array.from(ct);
  }
  return { step, nx, ny, vx, vy, used, tris: Int32Array.from(tris), dx: Float32Array.from(vx), dy: Float32Array.from(vy), coarse };
}

// ------------------------------------------------------------------ moving least squares
function constraints(s: S) {
  const P: Point[] = [], Q: Point[] = [];
  const R = s.mesh.step * 1.5;
  for (const pin of s.pins) {
    P.push(pin.p); Q.push(pin.q);
    if (pin.rot !== null) for (let k = 0; k < 4; k++) {
      const a = (k * Math.PI) / 2;
      P.push({ x: pin.p.x + R * Math.cos(a), y: pin.p.y + R * Math.sin(a) });
      Q.push({ x: pin.q.x + R * Math.cos(a + pin.rot), y: pin.q.y + R * Math.sin(a + pin.rot) });
    }
  }
  return { P, Q };
}
function mls(P: Point[], Q: Point[], mode: Mode, vx: number, vy: number, out: { x: number; y: number }) {
  const n = P.length;
  if (!n) { out.x = vx; out.y = vy; return; }
  let sw = 0, px = 0, py = 0, qx = 0, qy = 0;
  const w = new Float64Array(n);
  for (let i = 0; i < n; i++) { const dx = P[i].x - vx, dy = P[i].y - vy; w[i] = 1 / (dx * dx + dy * dy + 1e-4); sw += w[i]; px += w[i] * P[i].x; py += w[i] * P[i].y; qx += w[i] * Q[i].x; qy += w[i] * Q[i].y; }
  px /= sw; py /= sw; qx /= sw; qy /= sw;
  const hx = vx - px, hy = vy - py;
  if (mode === 'distort') {
    let a = 0, b = 0, d = 0, m00 = 0, m01 = 0, m10 = 0, m11 = 0;
    for (let i = 0; i < n; i++) {
      const ux = P[i].x - px, uy = P[i].y - py, tx = Q[i].x - qx, ty = Q[i].y - qy, wi = w[i];
      a += wi * ux * ux; b += wi * ux * uy; d += wi * uy * uy;
      m00 += wi * ux * tx; m01 += wi * ux * ty; m10 += wi * uy * tx; m11 += wi * uy * ty;
    }
    const det = a * d - b * b;
    if (Math.abs(det) > 1e-6 * (a * d + 1e-12)) {
      const i00 = d / det, i01 = -b / det, i11 = a / det;
      const r0 = hx * i00 + hy * i01, r1 = hx * i01 + hy * i11;
      out.x = r0 * m00 + r1 * m10 + qx; out.y = r0 * m01 + r1 * m11 + qy;
      return;
    }
    // collinear pins: fall back to the similarity solution
  }
  // Σ w q̂ conj(p̂) as a complex number, μ = Σ w |p̂|²
  let sr = 0, si = 0, mu = 0;
  for (let i = 0; i < n; i++) {
    const ux = P[i].x - px, uy = P[i].y - py, tx = Q[i].x - qx, ty = Q[i].y - qy, wi = w[i];
    sr += wi * (tx * ux + ty * uy); si += wi * (ty * ux - tx * uy); mu += wi * (ux * ux + uy * uy);
  }
  if (mu < 1e-9) { out.x = qx + hx; out.y = qy + hy; return; }
  if (mode === 'rigid') {
    const fx = sr * hx - si * hy, fy = sr * hy + si * hx, fl = Math.hypot(fx, fy), hl = Math.hypot(hx, hy);
    if (fl < 1e-12) { out.x = qx + hx; out.y = qy + hy; return; }
    out.x = qx + (hl * fx) / fl; out.y = qy + (hl * fy) / fl;
  } else {
    out.x = qx + (sr * hx - si * hy) / mu; out.y = qy + (sr * hy + si * hx) / mu;
  }
}
function deform(s: S) {
  const m = s.mesh, { P, Q } = constraints(s), o = { x: 0, y: 0 };
  for (let i = 0; i < m.vx.length; i++) { if (!m.used[i]) continue; mls(P, Q, settings.mode, m.vx[i], m.vy[i], o); m.dx[i] = o.x; m.dy[i] = o.y; }
}
/** Local rotation of the deformation at a pin (used as the start angle when a pin is rotated). */
function localAngle(s: S, pin: Pin) {
  const { P, Q } = constraints(s), o = { x: 0, y: 0 };
  mls(P, Q, settings.mode, pin.p.x + s.mesh.step, pin.p.y, o);
  return Math.atan2(o.y - pin.q.y, o.x - pin.q.x);
}

// ------------------------------------------------------------------ rendering
function render(s: S, scale = 1, fast = false): { canvas: HTMLCanvasElement; x: number; y: number } {
  const m = s.mesh, T = fast && m.coarse ? m.coarse : m.tris, r = s.src.rect;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < m.dx.length; i++) if (m.used[i]) { x0 = Math.min(x0, m.dx[i]); y0 = Math.min(y0, m.dy[i]); x1 = Math.max(x1, m.dx[i]); y1 = Math.max(y1, m.dy[i]); }
  if (!isFinite(x0)) return { canvas: createCanvas(1, 1), x: r.x, y: r.y };
  x0 = Math.floor(x0); y0 = Math.floor(y0); x1 = Math.ceil(x1); y1 = Math.ceil(y1);
  const out = createCanvas(Math.max(1, Math.min(16000, Math.ceil((x1 - x0) * scale))), Math.max(1, Math.min(16000, Math.ceil((y1 - y0) * scale))));
  const x = ctx2d(out);
  x.imageSmoothingEnabled = true; x.imageSmoothingQuality = scale < 1 ? 'low' : 'high';
  // triangle order: the depth of the nearest pin decides which parts end up on top
  const nt = T.length / 3;
  let order = Array.from({ length: nt }, (_, i) => i);
  if (s.pins.some(p => p.depth !== 0)) {
    const dep = new Float32Array(nt);
    for (let t = 0; t < nt; t++) {
      const cx = (m.vx[T[t * 3]] + m.vx[T[t * 3 + 1]] + m.vx[T[t * 3 + 2]]) / 3, cy = (m.vy[T[t * 3]] + m.vy[T[t * 3 + 1]] + m.vy[T[t * 3 + 2]]) / 3;
      let best = Infinity;
      for (const p of s.pins) { const d = (p.p.x - cx) ** 2 + (p.p.y - cy) ** 2; if (d < best) { best = d; dep[t] = p.depth; } }
    }
    order = order.sort((a, b) => dep[a] - dep[b] || a - b);
  }
  const src = s.src.src, grow = 0.75 / scale;
  for (const t of order) {
    const i0 = T[t * 3], i1 = T[t * 3 + 1], i2 = T[t * 3 + 2];
    const s0x = m.vx[i0] - r.x, s0y = m.vy[i0] - r.y, s1x = m.vx[i1] - r.x, s1y = m.vy[i1] - r.y, s2x = m.vx[i2] - r.x, s2y = m.vy[i2] - r.y;
    const d0x = m.dx[i0] - x0, d0y = m.dy[i0] - y0, d1x = m.dx[i1] - x0, d1y = m.dy[i1] - y0, d2x = m.dx[i2] - x0, d2y = m.dy[i2] - y0;
    const den = (s1x - s0x) * (s2y - s0y) - (s2x - s0x) * (s1y - s0y);
    if (Math.abs(den) < 1e-9) continue;
    const a = ((d1x - d0x) * (s2y - s0y) - (d2x - d0x) * (s1y - s0y)) / den;
    const c = ((d2x - d0x) * (s1x - s0x) - (d1x - d0x) * (s2x - s0x)) / den;
    const b = ((d1y - d0y) * (s2y - s0y) - (d2y - d0y) * (s1y - s0y)) / den;
    const d = ((d2y - d0y) * (s1x - s0x) - (d1y - d0y) * (s2x - s0x)) / den;
    const e = d0x - a * s0x - c * s0y, f = d0y - b * s0x - d * s0y;
    const gx = (d0x + d1x + d2x) / 3, gy = (d0y + d1y + d2y) / 3;
    const g = (px: number, py: number) => { const vx = px - gx, vy = py - gy, l = Math.hypot(vx, vy) || 1; return [(px + (vx / l) * grow) * scale, (py + (vy / l) * grow) * scale]; };
    const [g0x, g0y] = g(d0x, d0y), [g1x, g1y] = g(d1x, d1y), [g2x, g2y] = g(d2x, d2y);
    x.save();
    x.beginPath(); x.moveTo(g0x, g0y); x.lineTo(g1x, g1y); x.lineTo(g2x, g2y); x.closePath(); x.clip();
    x.setTransform(a * scale, b * scale, c * scale, d * scale, e * scale, f * scale);
    const sx0 = Math.max(0, Math.floor(Math.min(s0x, s1x, s2x)) - 1), sy0 = Math.max(0, Math.floor(Math.min(s0y, s1y, s2y)) - 1);
    const sx1 = Math.min(r.w, Math.ceil(Math.max(s0x, s1x, s2x)) + 1), sy1 = Math.min(r.h, Math.ceil(Math.max(s0y, s1y, s2y)) + 1);
    if (sx1 > sx0 && sy1 > sy0) x.drawImage(src, sx0, sy0, sx1 - sx0, sy1 - sy0, sx0, sy0, sx1 - sx0, sy1 - sy0);
    x.restore();
  }
  return { canvas: out, x: x0, y: y0 };
}
function preview() {
  const s = st;
  if (!s || s.raf) return;
  s.raf = requestAnimationFrame(() => {
    s.raf = 0;
    if (st !== s) return;
    deform(s);
    // large layers preview at reduced resolution while dragging
    const big = s.src.rect.w * s.src.rect.h > 1.5e6 && !!s.drag;
    const res = render(s, big ? 0.5 : 1, !!s.drag);
    if (big) { const c = createCanvas(Math.ceil(res.canvas.width * 2), Math.ceil(res.canvas.height * 2)); ctx2d(c).drawImage(res.canvas, 0, 0, c.width, c.height); res.canvas = c; }
    showPreview(s.src, res.canvas, res.x, res.y);
    s.src.doc.redrawOverlay();
  });
}

// ------------------------------------------------------------------ hit testing
const pinAt = (s: S, v: Viewport, p: { sx: number; sy: number }, r = 7) => {
  let best: Pin | null = null, bd = r * r;
  for (const pin of s.pins) { const q = v.docToScreen(pin.q.x, pin.q.y), d = (q.x - p.sx) ** 2 + (q.y - p.sy) ** 2; if (d <= bd) { bd = d; best = pin; } }
  return best;
};
/** Source point under a destination point (inverse through the deformed triangle containing it). */
function sourceAt(s: S, x: number, y: number): Point | null {
  const m = s.mesh, T = m.tris;
  for (let t = T.length / 3 - 1; t >= 0; t--) {
    const i0 = T[t * 3], i1 = T[t * 3 + 1], i2 = T[t * 3 + 2];
    const ax = m.dx[i0], ay = m.dy[i0], bx = m.dx[i1], by = m.dy[i1], cx = m.dx[i2], cy = m.dy[i2];
    const den = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
    if (Math.abs(den) < 1e-9) continue;
    const l0 = ((by - cy) * (x - cx) + (cx - bx) * (y - cy)) / den, l1 = ((cy - ay) * (x - cx) + (ax - cx) * (y - cy)) / den, l2 = 1 - l0 - l1;
    if (l0 >= -1e-6 && l1 >= -1e-6 && l2 >= -1e-6) return { x: l0 * m.vx[i0] + l1 * m.vx[i1] + l2 * m.vx[i2], y: l0 * m.vy[i0] + l1 * m.vy[i1] + l2 * m.vy[i2] };
  }
  return null;
}
const snapshot = (s: S) => JSON.stringify(s.pins.map(p => ({ ...p, sel: s.sel.has(p) })));
function pushUndo(s: S) { s.undo.push(snapshot(s)); if (s.undo.length > 100) s.undo.shift(); }
function restore(s: S, json: string) {
  const arr = JSON.parse(json) as (Pin & { sel: boolean })[];
  s.pins = arr.map(({ sel: _sel, ...p }) => p);
  s.sel = new Set(s.pins.filter((_, i) => arr[i].sel));
}

// ------------------------------------------------------------------ commit / cancel
function finish() { const s = st; if (!s) return; cancelAnimationFrame(s.raf); st = null; s.back(); }
function cancel() { const s = st; if (!s) return; clearPreview(s.src); finish(); }
function commit() {
  const s = st;
  if (!s) return;
  if (!s.pins.some(p => Math.abs(p.p.x - p.q.x) > 0.01 || Math.abs(p.p.y - p.q.y) > 0.01 || (p.rot !== null && Math.abs(p.rot) > 1e-4))) { cancel(); return; }
  cancelAnimationFrame(s.raf); s.raf = 0;
  deform(s);
  const res = render(s, 1);
  finish();
  commitLayer(s.src, 'Puppet Warp', res.canvas, res.x, res.y);
}
function removeSelected(s: S) { if (!s.sel.size) return; pushUndo(s); s.pins = s.pins.filter(p => !s.sel.has(p)); s.sel.clear(); refreshBar(); preview(); }

// ------------------------------------------------------------------ tool
const tool: Tool = {
  id: 'puppet-warp', name: 'Puppet Warp', group: 'puppet-warp', icon: 'warp', noCtrlMove: true,
  settings,
  cursor: () => {
    const s = st, v = app.viewport, p = s?.hover;
    if (!s || !v || !p) return 'default';
    const pin = pinAt(s, v, p);
    if (pin) return p.alt ? 'not-allowed' : 'move';
    if (p.alt && [...s.sel].some(q => pinAt({ ...s, pins: [q] }, v, p, 40))) return 'alias';
    return sourceAt(s, p.x, p.y) ? 'crosshair' : 'default';
  },
  isModal: () => !!st, commit, cancel,
  deactivate() { if (st) commit(); },
  hover(p) { if (st) st.hover = p; },
  pointerDown(p) {
    const s = st, v = app.viewport;
    if (!s || !v) return;
    s.hover = p;
    const pin = pinAt(s, v, p);
    if (pin) {
      if (p.alt) { pushUndo(s); s.pins = s.pins.filter(q => q !== pin); s.sel.delete(pin); refreshBar(); preview(); return; }
      if (p.shift) { if (s.sel.has(pin)) s.sel.delete(pin); else s.sel.add(pin); }
      else if (!s.sel.has(pin)) s.sel = new Set([pin]);
      if (!s.sel.has(pin)) { refreshBar(); s.src.doc.redrawOverlay(); return; }
      pushUndo(s);
      s.drag = { kind: 'move', start: { x: p.x, y: p.y }, orig: s.pins.map(q => ({ ...q.q })) };
      refreshBar(); s.src.doc.redrawOverlay();
      return;
    }
    if (p.alt) {
      const near = [...s.sel].find(q => pinAt({ ...s, pins: [q] }, v, p, 40));
      if (near) {
        pushUndo(s);
        const r0 = near.rot ?? localAngle(s, near);
        near.rot = r0;
        s.drag = { kind: 'rotate', pin: near, a0: Math.atan2(p.y - near.q.y, p.x - near.q.x), r0 };
        refreshBar();
        return;
      }
    }
    const sp = sourceAt(s, p.x, p.y);
    if (sp) {
      pushUndo(s);
      const np: Pin = { p: sp, q: { x: p.x, y: p.y }, rot: null, depth: 0 };
      s.pins.push(np);
      s.sel = new Set([np]);
      s.drag = { kind: 'move', start: { x: p.x, y: p.y }, orig: s.pins.map(q => ({ ...q.q })) };
      refreshBar(); preview();
      return;
    }
    if (!p.shift && s.sel.size) { s.sel.clear(); refreshBar(); s.src.doc.redrawOverlay(); }
  },
  pointerMove(p) {
    const s = st;
    if (!s?.drag) return;
    s.hover = p;
    const d = s.drag;
    if (d.kind === 'move') {
      const dx = p.x - d.start.x, dy = p.y - d.start.y;
      s.pins.forEach((pin, i) => { if (s.sel.has(pin) && d.orig[i]) pin.q = { x: d.orig[i].x + dx, y: d.orig[i].y + dy }; });
    } else {
      let a = d.r0 + Math.atan2(p.y - d.pin.q.y, p.x - d.pin.q.x) - d.a0;
      if (p.shift) a = Math.round(a / (Math.PI / 12)) * (Math.PI / 12);
      d.pin.rot = a;
      rotF?.setValue(Math.round((a * 180) / Math.PI));
    }
    preview();
  },
  pointerUp() { const s = st; if (!s) return; s.drag = null; preview(); },
  keyDown(e) {
    const s = st;
    if (!s) return false;
    if (e.key === 'Enter') { commit(); return true; }
    if (e.key === 'Escape') { cancel(); return true; }
    if (e.key === 'Delete' || e.key === 'Backspace') { removeSelected(s); return true; }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { const u = s.undo.pop(); if (u) { restore(s, u); refreshBar(); preview(); } return true; }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') { s.sel = new Set(s.pins); refreshBar(); s.src.doc.redrawOverlay(); return true; }
    if (e.key === 'h' || e.key === 'H') { settings.showMesh = !settings.showMesh; meshF?.setValue(settings.showMesh); s.src.doc.redrawOverlay(); return true; }
    return false;
  },
  drawOverlay(ctx, view) {
    const s = st;
    if (!s) return;
    const m = s.mesh, T = m.tris;
    if (settings.showMesh) {
      ctx.save();
      ctx.lineWidth = 1; ctx.strokeStyle = 'rgba(40,40,40,.55)';
      ctx.beginPath();
      const sp = new Float32Array(m.dx.length * 2);
      for (let i = 0; i < m.dx.length; i++) if (m.used[i]) { const q = view.docToScreen(m.dx[i], m.dy[i]); sp[i * 2] = q.x; sp[i * 2 + 1] = q.y; }
      for (let t = 0; t < T.length; t += 3) {
        const a = T[t], b = T[t + 1], c = T[t + 2];
        ctx.moveTo(sp[a * 2], sp[a * 2 + 1]); ctx.lineTo(sp[b * 2], sp[b * 2 + 1]); ctx.lineTo(sp[c * 2], sp[c * 2 + 1]); ctx.closePath();
      }
      ctx.stroke();
      ctx.restore();
    }
    for (const pin of s.pins) {
      const q = view.docToScreen(pin.q.x, pin.q.y), sel = s.sel.has(pin);
      ctx.beginPath(); ctx.arc(q.x, q.y, 5, 0, Math.PI * 2);
      ctx.fillStyle = '#ffd400'; ctx.fill(); ctx.lineWidth = 1.5; ctx.strokeStyle = '#000'; ctx.stroke();
      if (sel) { ctx.beginPath(); ctx.arc(q.x, q.y, 2, 0, Math.PI * 2); ctx.fillStyle = '#000'; ctx.fill(); }
      const hov = s.hover, rotating = s.drag?.kind === 'rotate' && s.drag.pin === pin;
      if (sel && (rotating || (hov?.alt && Math.hypot(view.docToScreen(pin.q.x, pin.q.y).x - hov.sx, view.docToScreen(pin.q.x, pin.q.y).y - hov.sy) < 40))) {
        const a = pin.rot ?? localAngle(s, pin);
        ctx.save(); ctx.setLineDash([3, 3]); ctx.strokeStyle = '#fff'; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.arc(q.x, q.y, 26, 0, Math.PI * 2); ctx.stroke(); ctx.setLineDash([]);
        ctx.beginPath(); ctx.moveTo(q.x, q.y); ctx.lineTo(q.x + Math.cos(a) * 26, q.y + Math.sin(a) * 26); ctx.stroke();
        ctx.fillStyle = 'rgba(0,0,0,.7)'; ctx.fillRect(q.x + 30, q.y - 10, 44, 18); ctx.fillStyle = '#fff'; ctx.font = '11px system-ui';
        ctx.fillText(`${Math.round((((a * 180) / Math.PI) % 360 + 540) % 360 - 180)}°`, q.x + 35, q.y + 3);
        ctx.restore();
      }
    }
  },
  options(bar) {
    const s = st;
    if (!s) return;
    const save = () => app.saveToolSettings(tool);
    const remesh = () => { const sx = st; if (!sx) return; sx.mesh = buildMesh(sx.src); preview(); };
    meshF = checkbox('Show Mesh', settings.showMesh, v => { settings.showMesh = v; save(); st?.src.doc.redrawOverlay(); }, { title: 'Show the mesh (H)' });
    rotSel = select<'auto' | 'fixed'>([{ value: 'auto', label: 'Auto' }, { value: 'fixed', label: 'Fixed' }], 'auto', v => {
      const sx = st; if (!sx || !sx.sel.size) return; pushUndo(sx);
      for (const p of sx.sel) p.rot = v === 'auto' ? null : p.rot ?? localAngle(sx, p);
      refreshBar(); preview();
    }, { width: 72, title: 'Pin rotation' });
    rotF = numberField(0, v => { const sx = st; if (!sx || !sx.sel.size) return; pushUndo(sx); for (const p of sx.sel) p.rot = (v * Math.PI) / 180; refreshBar(); preview(); }, { min: -180, max: 180, unit: '°', width: 56, title: 'Fixed pin rotation angle' });
    bar.append(
      h('span.opt-label', null, 'Mode:'),
      select<Mode>([{ value: 'rigid', label: 'Rigid' }, { value: 'normal', label: 'Normal' }, { value: 'distort', label: 'Distort' }], settings.mode, v => { settings.mode = v; save(); preview(); }, { width: 90, title: 'Elasticity of the mesh' }),
      h('span.opt-label', null, 'Density:'),
      select<Density>([{ value: 'fewer', label: 'Fewer Points' }, { value: 'normal', label: 'Normal' }, { value: 'more', label: 'More Points' }], settings.density, v => { settings.density = v; save(); remesh(); }, { width: 110, title: 'Spacing of the mesh points' }),
      numberField(settings.expansion, v => { settings.expansion = v; save(); remesh(); }, { min: -50, max: 100, unit: 'px', width: 60, label: 'Expansion:', title: 'Expand or contract the outer edge of the mesh' }),
      meshF, separator(),
      h('span.opt-label', null, 'Pin Depth:'),
      iconButton('pw-depth-up', 'Set pin forward', () => depth(1)), iconButton('pw-depth-down', 'Set pin backward', () => depth(-1)),
      h('span.opt-label', null, 'Rotate:'), rotSel, rotF,
      h('span.tp-flex'),
      iconButton('pw-pins-off', 'Remove all pins', () => { const sx = st; if (!sx || !sx.pins.length) return; pushUndo(sx); sx.pins = []; sx.sel.clear(); refreshBar(); preview(); }),
      iconButton('cancel', 'Cancel Puppet Warp (Esc)', () => cancel()), iconButton('commit', 'Commit Puppet Warp (Enter)', () => commit()));
    refreshBar();
  },
};
let meshF: Field<boolean> | null = null, rotSel: Field<'auto' | 'fixed'> | null = null, rotF: Field<number> | null = null;
function depth(dir: number) {
  const s = st;
  if (!s || !s.sel.size) return;
  pushUndo(s);
  const all = s.pins.map(p => p.depth);
  for (const p of s.sel) p.depth = dir > 0 ? Math.max(...all) + 1 : Math.min(...all) - 1;
  preview();
}
function refreshBar() {
  const s = st;
  if (!s) return;
  const one = s.sel.size ? [...s.sel][0] : null;
  rotSel?.setValue(one?.rot != null ? 'fixed' : 'auto');
  rotF?.setValue(one?.rot != null ? Math.round((one.rot * 180) / Math.PI) : 0);
  const dis = !one;
  for (const el of [rotSel, rotF]) if (el) el.classList.toggle('pw-disabled', dis);
}
app.registerTool(tool);

registerCommands([{
  id: 'edit.puppetWarp', label: 'Puppet Warp', enabled: () => !!app.activeDoc?.activeLayer,
  run: () => {
    if (st) return;
    const src = grabLayer(app.activeDoc, 'Puppet Warp');
    if (!src) return;
    st = { src, pins: [], sel: new Set(), mesh: buildMesh(src), drag: null, undo: [], back: () => {}, raf: 0, hover: null };
    st.back = enterTool(tool, src.prevTool);
    preview();
  },
}]);
(window as any).__pxPuppet = { get state() { return st; }, commit, cancel, render: (fast = false) => st && render(st, 1, fast), mls };
