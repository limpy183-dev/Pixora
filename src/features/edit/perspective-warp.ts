// Edit › Perspective Warp. Layout mode: drag to draw quads over the planes of the image (quads snap together at
// their corners, drag a corner or the whole quad to adjust, Delete removes the selected quad). Warp mode: drag the
// corners to change the perspective, Shift+click an edge to straighten it (and keep it straight), or use the
// automatic straighten / level buttons. Each quad maps its plane with a homography; the rest of the layer follows
// the nearest planes. Enter commits.
import './warp.css';
import { app, type Tool, type ToolPointer } from '../../core/app';
import { registerCommands } from '../../core/commands';
import { events } from '../../core/events';
import type { Point } from '../../core/types';
import type { Viewport } from '../../core/viewport';
import { h } from '../../ui/dom';
import { registerIcons } from '../../ui/icons';
import { iconButton, separator } from '../../ui/widgets';
import { toast } from '../../ui/toast';
import { rectToQuad, quadToRect, renderMapped, type Quad } from '../transform/geom';
import { grabLayer, showPreview, clearPreview, commitLayer, enterTool, type LayerSource } from './layer-session';

registerIcons({
  'ppw-vert': '<path d="M7 3v18M17 3v18"/><path d="M4 8l3-3 3 3M14 16l3 3 3-3"/>',
  'ppw-horz': '<path d="M3 7h18M3 17h18"/><path d="M8 4 5 7l3 3M16 14l3 3-3 3"/>',
  'ppw-both': '<rect x="4" y="4" width="16" height="16" rx="1"/><path d="M12 4v16M4 12h16"/>',
});

interface Vert { l: Point; w: Point }
type Drag =
  | { kind: 'create'; a: Point; q: number }
  | { kind: 'vert'; v: number; start: Point; l0: Point; w0: Point }
  | { kind: 'quad'; q: number; start: Point; l0: Point[] };
interface S { src: LayerSource; mode: 'layout' | 'warp'; verts: Vert[]; quads: number[][]; locked: Map<string, 'h' | 'v'>; selQuad: number; drag: Drag | null; back: () => void; raf: number; hover: ToolPointer | null }
let st: S | null = null;
const UNIT = { x: 0, y: 0, w: 1, h: 1 };
const edgeKey = (a: number, b: number) => (a < b ? `${a}-${b}` : `${b}-${a}`);

// ------------------------------------------------------------------ geometry
const layoutQuad = (s: S, q: number[]) => q.map(i => s.verts[i].l) as Quad;
const warpQuad = (s: S, q: number[]) => q.map(i => s.verts[i].w) as Quad;
function inside(p: Point, poly: Point[]) {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) c = !c;
  }
  return c;
}
function segDist(p: Point, a: Point, b: Point) {
  const dx = b.x - a.x, dy = b.y - a.y, l = dx * dx + dy * dy;
  const t = l ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l)) : 0;
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}
function polyDist(p: Point, poly: Point[]) { if (inside(p, poly)) return 0; let d = Infinity; for (let i = 0; i < 4; i++) d = Math.min(d, segDist(p, poly[i], poly[(i + 1) % 4])); return d; }
/** Layout → warp mapping built from the per-quad homographies. */
function buildMap(s: S) {
  const planes = s.quads.map(q => {
    const L = layoutQuad(s, q), W = warpQuad(s, q), toUnit = quadToRect(UNIT, L), toWarp = rectToQuad(UNIT, W);
    return { L, f: (p: Point) => toWarp(toUnit(p)) };
  });
  return (p: Point): Point => {
    let sx = 0, sy = 0, sw = 0;
    for (const pl of planes) {
      const d = polyDist(p, pl.L);
      const q = pl.f(p);
      if (!isFinite(q.x) || !isFinite(q.y)) continue;
      if (d === 0) return q;
      const w = 1 / (d * d + 1);
      sx += q.x * w; sy += q.y * w; sw += w;
    }
    return sw ? { x: sx / sw, y: sy / sw } : p;
  };
}
function warped(s: S) { return s.verts.some(v => Math.abs(v.l.x - v.w.x) > 0.01 || Math.abs(v.l.y - v.w.y) > 0.01); }
function render(s: S, quality: 'preview' | 'final') {
  const r = s.src.rect, f = buildMap(s);
  return renderMapped(s.src.src, r, { kind: 'mesh', f: (u, v) => f({ x: r.x + u * r.w, y: r.y + v * r.h }) }, 'bicubic', quality);
}
function preview() {
  const s = st;
  if (!s || s.raf) return;
  s.raf = requestAnimationFrame(() => {
    s.raf = 0;
    if (st !== s) return;
    if (s.mode === 'warp' && s.quads.length && warped(s)) { const res = render(s, s.drag ? 'preview' : 'final'); showPreview(s.src, res.canvas, res.x, res.y); }
    else clearPreview(s.src);
    s.src.doc.redrawOverlay();
  });
}

// ------------------------------------------------------------------ constraints
/** Keep straightened (locked) edges straight after vertex v moved. */
function enforce(s: S, moved: number) {
  // walk chains of straightened edges of each direction from the moved corner
  for (const dir of ['v', 'h'] as const) {
    const seen = new Set([moved]), todo = [moved];
    while (todo.length) {
      const cur = todo.pop()!;
      for (const [k, d] of s.locked) {
        if (d !== dir) continue;
        const [a, b] = k.split('-').map(Number);
        const o = a === cur ? b : b === cur ? a : -1;
        if (o < 0 || seen.has(o)) continue;
        seen.add(o); todo.push(o);
        s.verts[o].w = dir === 'v' ? { ...s.verts[o].w, x: s.verts[moved].w.x } : { ...s.verts[o].w, y: s.verts[moved].w.y };
      }
    }
  }
}
function straightenEdge(s: S, a: number, b: number, force?: 'h' | 'v') {
  const A = s.verts[a].w, B = s.verts[b].w;
  const dir = force ?? (Math.abs(B.x - A.x) >= Math.abs(B.y - A.y) ? 'h' : 'v');
  if (dir === 'v') { const x = (A.x + B.x) / 2; s.verts[a].w = { ...A, x }; s.verts[b].w = { ...B, x }; }
  else { const y = (A.y + B.y) / 2; s.verts[a].w = { ...A, y }; s.verts[b].w = { ...B, y }; }
  s.locked.set(edgeKey(a, b), dir);
}
function auto(kind: 'v' | 'h' | 'both') {
  const s = st;
  if (!s || s.mode !== 'warp') return;
  const lim = Math.tan((35 * Math.PI) / 180);
  // vertices joined by near-vertical (near-horizontal) edges form one line: they all get the mean x (y)
  const run = (dir: 'v' | 'h') => {
    const parent = s.verts.map((_, i) => i), find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
    const edges: [number, number][] = [];
    for (const q of s.quads) for (let i = 0; i < 4; i++) {
      const a = q[i], b = q[(i + 1) % 4], A = s.verts[a].w, B = s.verts[b].w, dx = Math.abs(B.x - A.x), dy = Math.abs(B.y - A.y);
      if (dir === 'v' ? dx <= dy * lim : dy <= dx * lim) { edges.push([a, b]); parent[find(a)] = find(b); }
    }
    const groups = new Map<number, Set<number>>();
    for (const [a, b] of edges) for (const i of [a, b]) { const r = find(i); if (!groups.has(r)) groups.set(r, new Set()); groups.get(r)!.add(i); }
    for (const g of groups.values()) {
      let m = 0;
      for (const i of g) m += dir === 'v' ? s.verts[i].w.x : s.verts[i].w.y;
      m /= g.size;
      for (const i of g) s.verts[i].w = dir === 'v' ? { ...s.verts[i].w, x: m } : { ...s.verts[i].w, y: m };
    }
    for (const [a, b] of edges) s.locked.set(edgeKey(a, b), dir);
  };
  if (kind !== 'h') run('v');
  if (kind !== 'v') run('h');
  preview();
}

// ------------------------------------------------------------------ hit testing
const pos = (s: S, i: number) => (s.mode === 'layout' ? s.verts[i].l : s.verts[i].w);
function vertAt(s: S, v: Viewport, p: { sx: number; sy: number }, r = 7, skip?: Set<number>) {
  let best = -1, bd = r * r;
  const used = new Set(s.quads.flat());
  for (const i of used) { if (skip?.has(i)) continue; const q = v.docToScreen(pos(s, i).x, pos(s, i).y), d = (q.x - p.sx) ** 2 + (q.y - p.sy) ** 2; if (d <= bd) { bd = d; best = i; } }
  return best;
}
function edgeAt(s: S, v: Viewport, p: { sx: number; sy: number }) {
  for (const q of s.quads) for (let i = 0; i < 4; i++) {
    const a = v.docToScreen(pos(s, q[i]).x, pos(s, q[i]).y), b = v.docToScreen(pos(s, q[(i + 1) % 4]).x, pos(s, q[(i + 1) % 4]).y);
    if (segDist({ x: p.sx, y: p.sy }, a, b) <= 5) return [q[i], q[(i + 1) % 4]] as [number, number];
  }
  return null;
}
const quadAt = (s: S, p: Point) => { for (let i = s.quads.length - 1; i >= 0; i--) if (inside(p, s.quads[i].map(k => pos(s, k)))) return i; return -1; };
/** Merge corners of quad q that were dropped near other quads' corners. */
function snapQuad(s: S, v: Viewport, q: number) {
  const mine = new Set(s.quads[q]);
  const merge = (from: number, to: number) => { for (const qq of s.quads) for (let m = 0; m < 4; m++) if (qq[m] === from) qq[m] = to; mine.add(to); };
  const sc = (i: number) => v.docToScreen(s.verts[i].l.x, s.verts[i].l.y);
  // edge snapping: an edge dropped along another quad's edge takes over that edge (quads share it)
  edges: for (let k = 0; k < 4; k++) {
    const a = s.quads[q][k], b = s.quads[q][(k + 1) % 4];
    for (let o = 0; o < s.quads.length; o++) {
      if (o === q) continue;
      for (let m = 0; m < 4; m++) {
        const c = s.quads[o][m], d = s.quads[o][(m + 1) % 4];
        if (mine.has(c) || mine.has(d)) continue;
        const A = sc(a), B = sc(b), C = sc(c), D = sc(d);
        if (segDist(A, C, D) > 14 || segDist(B, C, D) > 14) continue;
        const same = Math.hypot(A.x - C.x, A.y - C.y) + Math.hypot(B.x - D.x, B.y - D.y) <= Math.hypot(A.x - D.x, A.y - D.y) + Math.hypot(B.x - C.x, B.y - C.y);
        merge(a, same ? c : d); merge(b, same ? d : c);
        break edges;
      }
    }
  }
  for (let k = 0; k < 4; k++) {
    const i = s.quads[q][k], sp = v.docToScreen(s.verts[i].l.x, s.verts[i].l.y);
    const j = vertAt(s, v, { sx: sp.x, sy: sp.y }, 12, mine);
    if (j < 0) continue;
    for (const qq of s.quads) for (let m = 0; m < 4; m++) if (qq[m] === i) qq[m] = j;
    mine.add(j);
  }
  compact(s);
}
function compact(s: S) {
  const used = [...new Set(s.quads.flat())].sort((a, b) => a - b), map = new Map(used.map((o, n) => [o, n]));
  s.verts = used.map(i => s.verts[i]);
  s.quads = s.quads.map(q => q.map(i => map.get(i)!));
  s.locked = new Map([...s.locked].filter(([k]) => k.split('-').every(x => map.has(+x))).map(([k, d]) => { const [a, b] = k.split('-').map(x => map.get(+x)!); return [edgeKey(a, b), d] as [string, 'h' | 'v']; }));
}

// ------------------------------------------------------------------ commit / cancel
function finish() { const s = st; if (!s) return; cancelAnimationFrame(s.raf); st = null; s.back(); }
function cancel() { const s = st; if (!s) return; clearPreview(s.src); finish(); }
function commit() {
  const s = st;
  if (!s) return;
  if (!s.quads.length || !warped(s)) { cancel(); return; }
  cancelAnimationFrame(s.raf); s.raf = 0;
  const res = render(s, 'final');
  finish();
  commitLayer(s.src, 'Perspective Warp', res.canvas, res.x, res.y);
}
function setMode(m: 'layout' | 'warp') {
  const s = st;
  if (!s || s.mode === m) return;
  if (m === 'warp' && !s.quads.length) { toast('Draw at least one quad in Layout mode first.', 'info'); return; }
  s.mode = m;
  if (m === 'layout') { for (const v of s.verts) v.w = { ...v.l }; s.locked.clear(); }
  s.selQuad = -1;
  events.emit('tool');
  preview();
}

// ------------------------------------------------------------------ tool
const tool: Tool = {
  id: 'perspective-warp', name: 'Perspective Warp', group: 'perspective-warp', icon: 'crop-perspective', noCtrlMove: true,
  cursor: () => {
    const s = st, v = app.viewport, p = s?.hover;
    if (!s || !v || !p) return 'default';
    if (vertAt(s, v, p) >= 0) return 'move';
    if (s.mode === 'warp') return p.shift && edgeAt(s, v, p) ? 'pointer' : 'default';
    return quadAt(s, p) >= 0 ? 'move' : 'crosshair';
  },
  isModal: () => !!st, commit, cancel,
  deactivate() { if (st) commit(); },
  hover(p) { if (st) st.hover = p; },
  pointerDown(p) {
    const s = st, v = app.viewport;
    if (!s || !v) return;
    s.hover = p;
    const vi = vertAt(s, v, p);
    if (s.mode === 'warp') {
      if (p.shift) { const e = edgeAt(s, v, p); if (e && vi < 0) { const k = edgeKey(e[0], e[1]); if (s.locked.has(k)) s.locked.delete(k); else straightenEdge(s, e[0], e[1]); preview(); return; } }
      if (vi >= 0) s.drag = { kind: 'vert', v: vi, start: { x: p.x, y: p.y }, l0: { ...s.verts[vi].l }, w0: { ...s.verts[vi].w } };
      return;
    }
    if (vi >= 0) { s.drag = { kind: 'vert', v: vi, start: { x: p.x, y: p.y }, l0: { ...s.verts[vi].l }, w0: { ...s.verts[vi].w } }; s.selQuad = s.quads.findIndex(q => q.includes(vi)); return; }
    const qi = quadAt(s, p);
    if (qi >= 0) { s.selQuad = qi; s.drag = { kind: 'quad', q: qi, start: { x: p.x, y: p.y }, l0: s.quads[qi].map(i => ({ ...s.verts[i].l })) }; s.src.doc.redrawOverlay(); return; }
    const a = { x: p.x, y: p.y }, base = s.verts.length;
    for (let k = 0; k < 4; k++) s.verts.push({ l: { ...a }, w: { ...a } });
    s.quads.push([base, base + 1, base + 2, base + 3]);
    s.selQuad = s.quads.length - 1;
    s.drag = { kind: 'create', a, q: s.selQuad };
  },
  pointerMove(p) {
    const s = st;
    if (!s?.drag) return;
    s.hover = p;
    const d = s.drag;
    if (d.kind === 'create') {
      const q = s.quads[d.q], x0 = Math.min(d.a.x, p.x), y0 = Math.min(d.a.y, p.y), x1 = Math.max(d.a.x, p.x), y1 = Math.max(d.a.y, p.y);
      [[x0, y0], [x1, y0], [x1, y1], [x0, y1]].forEach(([x, y], k) => { s.verts[q[k]].l = { x, y }; s.verts[q[k]].w = { x, y }; });
    } else if (d.kind === 'vert') {
      const dx = p.x - d.start.x, dy = p.y - d.start.y, vt = s.verts[d.v];
      if (s.mode === 'layout') { vt.l = { x: d.l0.x + dx, y: d.l0.y + dy }; vt.w = { ...vt.l }; }
      else { vt.w = { x: d.w0.x + dx, y: d.w0.y + dy }; enforce(s, d.v); }
    } else {
      const dx = p.x - d.start.x, dy = p.y - d.start.y;
      s.quads[d.q].forEach((i, k) => { s.verts[i].l = { x: d.l0[k].x + dx, y: d.l0[k].y + dy }; s.verts[i].w = { ...s.verts[i].l }; });
    }
    preview();
  },
  pointerUp() {
    const s = st, v = app.viewport;
    if (!s?.drag || !v) return;
    const d = s.drag;
    s.drag = null;
    if (d.kind === 'create') {
      const q = s.quads[d.q], a = s.verts[q[0]].l, c = s.verts[q[2]].l;
      if (c.x - a.x < 8 || c.y - a.y < 8) { s.quads.splice(d.q, 1); s.selQuad = -1; compact(s); }
      else snapQuad(s, v, d.q);
    } else if (s.mode === 'layout') {
      const q = d.kind === 'quad' ? d.q : s.quads.findIndex(x => x.includes(d.v));
      if (q >= 0) snapQuad(s, v, q);
    }
    if (s.selQuad >= s.quads.length) s.selQuad = -1;
    events.emit('tool');
    preview();
  },
  keyDown(e) {
    const s = st;
    if (!s) return false;
    if (e.key === 'Enter') { commit(); return true; }
    if (e.key === 'Escape') { cancel(); return true; }
    if ((e.key === 'Delete' || e.key === 'Backspace') && s.mode === 'layout' && s.selQuad >= 0) { s.quads.splice(s.selQuad, 1); s.selQuad = -1; compact(s); events.emit('tool'); preview(); return true; }
    if (e.key === 'l' || e.key === 'L') { setMode('layout'); return true; }
    if (e.key === 'w' || e.key === 'W') { setMode('warp'); return true; }
    return false;
  },
  drawOverlay(ctx, view) {
    const s = st;
    if (!s) return;
    ctx.save();
    s.quads.forEach((q, qi) => {
      const quad = q.map(i => pos(s, i)) as Quad, f = rectToQuad(UNIT, quad);
      const sc = (p: Point) => view.docToScreen(p.x, p.y);
      // inner grid
      ctx.strokeStyle = 'rgba(30,139,255,.55)'; ctx.lineWidth = 1; ctx.beginPath();
      for (let t = 1; t < 3; t++) {
        const u = t / 3;
        let a = sc(f({ x: u, y: 0 })), b = sc(f({ x: u, y: 1 })); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y);
        a = sc(f({ x: 0, y: u })); b = sc(f({ x: 1, y: u })); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y);
      }
      ctx.stroke();
      // edges (straightened edges in yellow)
      for (let i = 0; i < 4; i++) {
        const a = sc(quad[i]), b = sc(quad[(i + 1) % 4]), lk = s.locked.has(edgeKey(q[i], q[(i + 1) % 4]));
        ctx.strokeStyle = lk ? '#ffd400' : qi === s.selQuad ? '#fff' : '#1e8bff'; ctx.lineWidth = lk ? 2.5 : 1.5;
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      }
    });
    for (const i of new Set(s.quads.flat())) {
      const q = view.docToScreen(pos(s, i).x, pos(s, i).y);
      ctx.fillStyle = '#fff'; ctx.strokeStyle = '#1e8bff'; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(q.x, q.y, 4.5, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    }
    ctx.restore();
  },
  options(bar) {
    const s = st;
    if (!s) return;
    const btn = (m: 'layout' | 'warp', label: string, title: string) => h('button', { type: 'button', class: s.mode === m ? 'on' : '', title, onclick: () => setMode(m) }, label);
    bar.append(h('div.pw-modes', null, btn('layout', 'Layout', 'Layout mode: draw and edit quads (L)'), btn('warp', 'Warp', 'Warp mode: move the corners to change the perspective (W)')), separator());
    if (s.mode === 'warp') bar.append(
      iconButton('ppw-vert', 'Automatically straighten near vertical lines', () => auto('v')),
      iconButton('ppw-horz', 'Automatically level near horizontal lines', () => auto('h')),
      iconButton('ppw-both', 'Automatically straighten and level', () => auto('both')),
      h('span.pw-hint', null, 'Drag the corners to warp. Shift+click an edge to straighten it.'));
    else bar.append(h('span.pw-hint', null, s.quads.length ? 'Drag corners or quads to match the planes; quads snap together at their corners. Then switch to Warp.' : 'Drag on the image to draw a quad along a plane of the image.'));
    bar.append(h('span.tp-flex'),
      iconButton('cancel', 'Cancel Perspective Warp (Esc)', () => cancel()), iconButton('commit', 'Commit Perspective Warp (Enter)', () => commit()));
  },
};
app.registerTool(tool);

registerCommands([{
  id: 'edit.perspectiveWarp', label: 'Perspective Warp', enabled: () => !!app.activeDoc?.activeLayer,
  run: () => {
    if (st) return;
    const src = grabLayer(app.activeDoc, 'Perspective Warp');
    if (!src) return;
    st = { src, mode: 'layout', verts: [], quads: [], locked: new Map(), selQuad: -1, drag: null, back: () => {}, raf: 0, hover: null };
    st.back = enterTool(tool, src.prevTool);
    src.doc.redrawOverlay();
  },
}]);
(window as any).__pxPerspWarp = { get state() { return st; }, commit, cancel, setMode, auto };
