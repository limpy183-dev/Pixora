// Vector icons + the extended custom shape library (Shapes panel / Custom Shape tool).
// Shapes are SVG path data in a 0..100 box; `group` is the Shapes panel folder.
import { registerIcons } from '../../ui/icons';
import { resources, type CustomShape } from '../../core/registry';

const F = 'fill="currentColor" stroke="none"';
registerIcons({
  'vop-new': `<rect x="4" y="4" width="11" height="11"/><rect x="9" y="9" width="11" height="11" ${F} opacity=".35"/>`,
  'vop-add': `<path d="M4 4h11v5h5v11H9v-5H4z" ${F}/>`,
  'vop-subtract': `<path d="M4 4h11v5H9v6H4z" ${F}/><rect x="9.5" y="9.5" width="10.5" height="10.5" stroke-dasharray="2 1.6"/>`,
  'vop-intersect': `<rect x="4" y="4" width="11" height="11" stroke-dasharray="2 1.6"/><rect x="9" y="9" width="11" height="11" stroke-dasharray="2 1.6"/><rect x="9" y="9" width="6" height="6" ${F}/>`,
  'vop-exclude': `<path d="M4 4h11v5H9v6H4zM15 9h5v11H9v-5h6z" ${F}/>`,
  'vop-merge': `<path d="M4 4h11v5h5v11H9v-5H4z"/><path d="m12 10 2 2-2 2" stroke-width="1.3"/>`,
  'vpath-align': `<path d="M4 3v18"/><rect x="6" y="6" width="12" height="4" ${F}/><rect x="6" y="14" width="7" height="4" ${F}/>`,
  'vpath-arrange': `<rect x="3.5" y="3.5" width="10" height="10"/><rect x="10.5" y="10.5" width="10" height="10" ${F}/>`,
  'vp-fill': `<circle cx="12" cy="12" r="8" ${F}/>`,
  'vp-stroke': `<circle cx="12" cy="12" r="7.5" stroke-width="1.8"/>`,
  'vp-load': `<circle cx="12" cy="12" r="7.5" stroke-dasharray="2.4 2"/>`,
  'vp-workpath': `<rect x="4.5" y="4.5" width="15" height="15" stroke-dasharray="2.4 2"/><path d="M8 16c2-7 6-7 8-8"/><rect x="6.5" y="14.5" width="3" height="3" ${F}/><rect x="14.5" y="6.5" width="3" height="3" ${F}/>`,
  'vp-mask': `<rect x="3" y="5" width="18" height="14" rx="1" ${F}/><circle cx="12" cy="12" r="4" fill="var(--bg, #535353)" stroke="none"/>`,
  'vp-path-row': `<path d="M4 18C7 6 17 18 20 6"/><rect x="2.5" y="16.5" width="3" height="3" ${F}/><rect x="18.5" y="4.5" width="3" height="3" ${F}/>`,
  'no-color': `<rect x="3.5" y="3.5" width="17" height="17" fill="#fff" stroke="#888"/><path d="M4 20 20 4" stroke="#e02020" stroke-width="2"/>`,
  'paint-solid': `<rect x="4" y="4" width="16" height="16" rx="1" ${F}/>`,
  'paint-gradient': `<defs><linearGradient id="vpg" x1="0" x2="1"><stop offset="0" stop-color="currentColor"/><stop offset="1" stop-color="currentColor" stop-opacity="0"/></linearGradient></defs><rect x="4" y="4" width="16" height="16" rx="1" fill="url(#vpg)"/><rect x="4" y="4" width="16" height="16" rx="1"/>`,
  'paint-pattern': `<rect x="4" y="4" width="16" height="16" rx="1"/><path d="M4 12h16M12 4v16M8 4v16M16 4v16M4 8h16M4 16h16" stroke-width=".8"/>`,
  'color-picker-btn': `<circle cx="12" cy="12" r="8.5"/><path d="M12 3.5a8.5 8.5 0 0 1 0 17z" ${F} opacity=".5"/><path d="M3.5 12h17" stroke-width=".8"/>`,
  'stroke-solid': `<path d="M3 12h18" stroke-width="2"/>`,
  'stroke-dashed': `<path d="M3 12h18" stroke-width="2" stroke-dasharray="4 2.5"/>`,
  'stroke-dotted': `<path d="M4 12h17" stroke-width="2.4" stroke-dasharray="0 4.2"/>`,
  'stroke-in': `<rect x="5" y="5" width="14" height="14" stroke-width=".8"/><rect x="6.5" y="6.5" width="11" height="11" stroke-width="2.5"/>`,
  'stroke-center': `<rect x="5" y="5" width="14" height="14" stroke-width=".8"/><rect x="5" y="5" width="14" height="14" stroke-width="2.6" opacity=".7"/>`,
  'stroke-out': `<rect x="6" y="6" width="12" height="12" stroke-width=".8"/><rect x="4.2" y="4.2" width="15.6" height="15.6" stroke-width="2.5"/>`,
  'shapes-folder': `<path d="M2.8 6.2A1.4 1.4 0 0 1 4.2 4.8h5l2 2.2h8.6a1.4 1.4 0 0 1 1.4 1.4v9.8a1.4 1.4 0 0 1-1.4 1.4H4.2a1.4 1.4 0 0 1-1.4-1.4z"/>`,
  'vlink': `<path d="M9 8H7a4 4 0 0 0 0 8h2M15 8h2a4 4 0 0 1 0 8h-2M8.5 12h7"/>`,
  'pathfinder-unite': `<path d="M3 3h11v5h7v13H8v-7H3z" ${F}/>`,
  'pathfinder-minus': `<path d="M3 3h11v5H8v6H3z" ${F}/><path d="M8 8h13v13H8z" stroke-dasharray="2 1.6"/>`,
  'pathfinder-intersect': `<path d="M3 3h11v11H3zM8 8h13v13H8z" stroke-dasharray="2 1.6"/><path d="M8 8h6v6H8z" ${F}/>`,
  'pathfinder-exclude': `<path d="M3 3h11v5H8v6H3zM14 8h7v13H8v-7h6z" ${F}/>`,
  'corner-radius': `<path d="M5 20v-8a7 7 0 0 1 7-7h7"/><path d="M3 20h4M19 3v4" stroke-width="1"/>`,
  'arrowheads': `<path d="M3 12h18M16 7l5 5-5 5"/>`,
});

// ------------------------------------------------------------------ path-data helpers (0..100 box)
const n = (v: number) => +v.toFixed(2);
/** Circle as 4 cubic arcs (clockwise). */
const circle = (cx: number, cy: number, r: number, ccw = false) => {
  const k = r * 0.5523;
  return ccw
    ? `M${n(cx + r)} ${n(cy)} C${n(cx + r)} ${n(cy - k)} ${n(cx + k)} ${n(cy - r)} ${n(cx)} ${n(cy - r)} C${n(cx - k)} ${n(cy - r)} ${n(cx - r)} ${n(cy - k)} ${n(cx - r)} ${n(cy)} C${n(cx - r)} ${n(cy + k)} ${n(cx - k)} ${n(cy + r)} ${n(cx)} ${n(cy + r)} C${n(cx + k)} ${n(cy + r)} ${n(cx + r)} ${n(cy + k)} ${n(cx + r)} ${n(cy)} Z`
    : `M${n(cx + r)} ${n(cy)} C${n(cx + r)} ${n(cy + k)} ${n(cx + k)} ${n(cy + r)} ${n(cx)} ${n(cy + r)} C${n(cx - k)} ${n(cy + r)} ${n(cx - r)} ${n(cy + k)} ${n(cx - r)} ${n(cy)} C${n(cx - r)} ${n(cy - k)} ${n(cx - k)} ${n(cy - r)} ${n(cx)} ${n(cy - r)} C${n(cx + k)} ${n(cy - r)} ${n(cx + r)} ${n(cy - k)} ${n(cx + r)} ${n(cy)} Z`;
};
const ellipse = (cx: number, cy: number, rx: number, ry: number) => {
  const kx = rx * 0.5523, ky = ry * 0.5523;
  return `M${n(cx + rx)} ${n(cy)} C${n(cx + rx)} ${n(cy + ky)} ${n(cx + kx)} ${n(cy + ry)} ${n(cx)} ${n(cy + ry)} C${n(cx - kx)} ${n(cy + ry)} ${n(cx - rx)} ${n(cy + ky)} ${n(cx - rx)} ${n(cy)} C${n(cx - rx)} ${n(cy - ky)} ${n(cx - kx)} ${n(cy - ry)} ${n(cx)} ${n(cy - ry)} C${n(cx + kx)} ${n(cy - ry)} ${n(cx + rx)} ${n(cy - ky)} ${n(cx + rx)} ${n(cy)} Z`;
};
/** Star / regular polygon. */
const star = (cx: number, cy: number, ro: number, ri: number, pts: number, rot = -90) => {
  let d = '';
  const cnt = ri > 0 ? pts * 2 : pts;
  for (let i = 0; i < cnt; i++) {
    const r = ri > 0 && i % 2 ? ri : ro, a = ((rot + (i * 360) / cnt) * Math.PI) / 180;
    d += `${i ? 'L' : 'M'}${n(cx + Math.cos(a) * r)} ${n(cy + Math.sin(a) * r)} `;
  }
  return d + 'Z';
};
const rrect = (x: number, y: number, w: number, h: number, r: number) => {
  const k = r * 0.4477;
  return `M${x + r} ${y} L${x + w - r} ${y} C${n(x + w - k)} ${y} ${x + w} ${n(y + k)} ${x + w} ${y + r} L${x + w} ${y + h - r} C${x + w} ${n(y + h - k)} ${n(x + w - k)} ${y + h} ${x + w - r} ${y + h} L${x + r} ${y + h} C${n(x + k)} ${y + h} ${x} ${n(y + h - k)} ${x} ${y + h - r} L${x} ${y + r} C${x} ${n(y + k)} ${n(x + k)} ${y} ${x + r} ${y} Z`;
};
const rays = (cx: number, cy: number, r0: number, r1: number, count: number, wdeg: number) => {
  let d = '';
  for (let i = 0; i < count; i++) {
    const a = (i * 360) / count, w = wdeg / 2;
    const P = (deg: number, r: number) => { const t = (deg * Math.PI) / 180; return `${n(cx + Math.cos(t) * r)} ${n(cy + Math.sin(t) * r)}`; };
    d += `M${P(a - w, r0)} L${P(a, r1)} L${P(a + w, r0)} Z `;
  }
  return d;
};

type S = CustomShape & { group?: string };
const add = (group: string, list: [string, string, string][]) => {
  for (const [id, name, path] of list) if (!resources.shapes.some(s => s.id === id)) resources.shapes.push({ id, name, path, group } as S);
};

// tag the built-in presets with folders
const BUILTIN_GROUPS: Record<string, string> = { heart: 'Symbols', star: 'Symbols', arrow: 'Arrows', speech: 'Banners & Bubbles', checkmark: 'Symbols', lightning: 'Nature', drop: 'Nature', cross: 'Symbols', burst: 'Banners & Bubbles', moon: 'Nature' };
for (const s of resources.shapes as S[]) if (!s.group) s.group = BUILTIN_GROUPS[s.id] || 'Shapes';

add('Arrows', [
  ['arrow-left-right', 'Double Arrow', 'M2 50 L24 22 L24 38 L76 38 L76 22 L98 50 L76 78 L76 62 L24 62 L24 78 Z'],
  ['arrow-up', 'Arrow Up', 'M50 2 L92 46 L66 46 L66 98 L34 98 L34 46 L8 46 Z'],
  ['arrow-chevron', 'Chevron', 'M5 5 L55 5 L95 50 L55 95 L5 95 L45 50 Z'],
  ['arrow-curved', 'Curved Arrow', 'M10 95 C10 50 35 25 70 25 L70 5 L98 38 L70 70 L70 48 C45 48 28 65 28 95 Z'],
  ['arrow-circular', 'Refresh Arrow', 'M82 38 C76 22 64 14 50 14 C30 14 14 30 14 50 C14 70 30 86 50 86 C63 86 74 79 80 69 L94 76 C85 91 68 100 50 100 C22 100 0 78 0 50 C0 22 22 0 50 0 C69 0 86 11 94 29 L100 18 L100 50 L70 50 Z'],
  ['arrow-pointer', 'Pointer', 'M10 2 L90 58 L56 62 L74 94 L60 100 L42 68 L18 92 Z'],
]);
add('Frames', [
  ['frame-square', 'Square Frame', 'M0 0 L100 0 L100 100 L0 100 Z M12 12 L12 88 L88 88 L88 12 Z'],
  ['frame-circle', 'Circle Frame', circle(50, 50, 50) + ' ' + circle(50, 50, 38, true)],
  ['frame-rounded', 'Rounded Frame', rrect(0, 0, 100, 100, 18) + ' ' + rrect(10, 10, 80, 80, 10)],
  ['frame-stamp', 'Stamp', (() => {
    let d = 'M0 0 ';
    for (let i = 0; i < 10; i++) d += `L${i * 10 + 3} 0 C${i * 10 + 3} 4 ${i * 10 + 7} 4 ${i * 10 + 7} 0 `;
    d += 'L100 0 ';
    for (let i = 0; i < 10; i++) d += `L100 ${i * 10 + 3} C96 ${i * 10 + 3} 96 ${i * 10 + 7} 100 ${i * 10 + 7} `;
    d += 'L100 100 ';
    for (let i = 9; i >= 0; i--) d += `L${i * 10 + 7} 100 C${i * 10 + 7} 96 ${i * 10 + 3} 96 ${i * 10 + 3} 100 `;
    d += 'L0 100 ';
    for (let i = 9; i >= 0; i--) d += `L0 ${i * 10 + 7} C4 ${i * 10 + 7} 4 ${i * 10 + 3} 0 ${i * 10 + 3} `;
    return d + 'Z M12 12 L12 88 L88 88 L88 12 Z';
  })()],
  ['frame-ornate', 'Ornate Frame', 'M20 0 L80 0 C80 11 89 20 100 20 L100 80 C89 80 80 89 80 100 L20 100 C20 89 11 80 0 80 L0 20 C11 20 20 11 20 0 Z M26 12 C24 20 20 24 12 26 L12 74 C20 76 24 80 26 88 L74 88 C76 80 80 76 88 74 L88 26 C80 24 76 20 74 12 Z'],
]);
add('Symbols', [
  ['x-mark', 'X Mark', 'M20 5 L50 35 L80 5 L95 20 L65 50 L95 80 L80 95 L50 65 L20 95 L5 80 L35 50 L5 20 Z'],
  ['star-6', 'Six-Point Star', star(50, 50, 50, 29, 6)],
  ['sparkle', 'Sparkle', 'M50 0 C54 32 68 46 100 50 C68 54 54 68 50 100 C46 68 32 54 0 50 C32 46 46 32 50 0 Z'],
  ['badge', 'Seal', star(50, 50, 50, 43, 20)],
  ['warning', 'Warning', 'M50 2 L98 92 L2 92 Z M45 30 L55 30 L53 64 L47 64 Z ' + circle(50, 76, 5, true)],
  ['location', 'Location Pin', 'M50 100 C50 100 12 58 12 36 C12 15 29 0 50 0 C71 0 88 15 88 36 C88 58 50 100 50 100 Z ' + circle(50, 36, 14, true)],
  ['home', 'Home', 'M50 4 L98 48 L84 48 L84 96 L60 96 L60 66 L40 66 L40 96 L16 96 L16 48 L2 48 Z'],
  ['bookmark', 'Bookmark', 'M15 0 L85 0 L85 100 L50 72 L15 100 Z'],
  ['flag', 'Flag', 'M8 0 L16 0 L16 8 C36 0 50 18 70 10 C78 7 86 6 94 8 L94 56 C86 54 78 55 70 58 C50 66 36 48 16 56 L16 100 L8 100 Z'],
  ['tag', 'Tag', 'M0 8 L0 46 L54 100 L100 54 L46 0 L8 0 Z ' + circle(22, 22, 8, true)],
  ['play', 'Play', circle(50, 50, 50) + ' M38 28 L74 50 L38 72 Z'],
  ['shield', 'Shield', 'M50 0 L92 14 L92 44 C92 72 74 90 50 100 C26 90 8 72 8 44 L8 14 Z'],
  ['crown', 'Crown', 'M4 30 L28 52 L50 12 L72 52 L96 30 L86 84 L14 84 Z M14 90 L86 90 L86 100 L14 100 Z'],
  ['diamond', 'Gem', 'M20 5 L80 5 L100 35 L50 98 L0 35 Z'],
  ['music', 'Music Note', 'M34 12 L90 0 L90 72 C90 82 80 90 69 90 C58 90 52 83 52 76 C52 67 61 60 72 60 C75 60 78 61 80 62 L80 22 L44 30 L44 82 C44 92 34 100 23 100 C12 100 6 93 6 86 C6 77 15 70 26 70 C29 70 32 71 34 72 Z'],
  ['paw', 'Paw Print', ellipse(50, 70, 24, 20) + ' ' + ellipse(20, 40, 10, 13) + ' ' + ellipse(40, 20, 10, 14) + ' ' + ellipse(60, 20, 10, 14) + ' ' + ellipse(80, 40, 10, 13)],
  ['puzzle', 'Puzzle Piece', 'M10 22 L38 22 C34 14 36 4 48 4 C60 4 62 14 58 22 L86 22 L86 48 C94 44 100 48 100 58 C100 68 94 72 86 68 L86 96 L10 96 L10 68 C18 72 24 66 24 58 C24 50 18 44 10 48 Z'],
]);
add('Nature', [
  ['sun', 'Sun', circle(50, 50, 22) + ' ' + rays(50, 50, 28, 48, 12, 14)],
  ['cloud', 'Cloud', 'M22 82 C9 82 0 73 0 62 C0 51 9 43 20 43 C22 28 34 18 48 18 C60 18 70 25 74 36 C88 36 100 47 100 60 C100 72 90 82 78 82 Z'],
  ['leaf', 'Leaf', 'M8 96 C8 50 32 10 96 4 C92 60 60 92 20 88 L12 100 Z'],
  ['flower', 'Flower', (() => {
    let d = '';
    for (let i = 0; i < 6; i++) {
      const a = (i * Math.PI) / 3, cx = 50 + Math.cos(a) * 26, cy = 50 + Math.sin(a) * 26;
      d += ellipse(cx, cy, 20, 20) + ' ';
    }
    return d + circle(50, 50, 16);
  })()],
  ['tree', 'Tree', 'M50 0 L80 36 L66 36 L90 64 L72 64 L96 88 L56 88 L56 100 L44 100 L44 88 L4 88 L28 64 L10 64 L34 36 L20 36 Z'],
  ['snowflake', 'Snowflake', (() => {
    let d = '';
    for (let i = 0; i < 6; i++) {
      const a = (i * 60 * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
      const T = (x: number, y: number) => `${n(50 + x * c - y * s)} ${n(50 + x * s + y * c)}`;
      d += `M${T(0, -4)} L${T(46, -4)} L${T(46, 4)} L${T(0, 4)} Z M${T(26, -2)} L${T(38, -14)} L${T(42, -10)} L${T(30, 2)} Z M${T(26, 2)} L${T(38, 14)} L${T(42, 10)} L${T(30, -2)} Z `;
    }
    return d;
  })()],
  ['wave', 'Wave', 'M0 50 C12 30 25 30 37 50 C50 70 62 70 75 50 C82 38 90 34 100 36 L100 100 L0 100 Z'],
]);
add('Banners & Bubbles', [
  ['bubble-round', 'Round Bubble', 'M50 4 C78 4 100 21 100 42 C100 63 78 80 50 80 C44 80 38 79 33 78 L12 96 L18 72 C7 65 0 54 0 42 C0 21 22 4 50 4 Z'],
  ['thought', 'Thought Bubble', 'M50 2 C77 2 98 17 98 36 C98 55 77 70 50 70 C23 70 2 55 2 36 C2 17 23 2 50 2 Z ' + circle(22, 80, 8) + ' ' + circle(10, 94, 5)],
  ['ribbon', 'Ribbon Banner', 'M14 20 L86 20 L86 62 L14 62 Z M0 32 L14 32 L14 70 L0 70 L8 51 Z M100 32 L86 32 L86 70 L100 70 L92 51 Z'],
  ['label', 'Label', 'M0 20 L80 20 L100 50 L80 80 L0 80 Z'],
  ['callout', 'Callout', rrect(0, 0, 100, 70, 10).replace(/ Z$/, '') + ' Z M30 68 L50 68 L22 98 Z'],
]);
add('Shapes', [
  ['hexagon', 'Hexagon', star(50, 50, 50, 0, 6, 0)],
  ['octagon', 'Octagon', star(50, 50, 50, 0, 8, -22.5)],
  ['pentagon', 'Pentagon', star(50, 50, 50, 0, 5)],
  ['parallelogram', 'Parallelogram', 'M25 10 L100 10 L75 90 L0 90 Z'],
  ['trapezoid', 'Trapezoid', 'M22 10 L78 10 L100 90 L0 90 Z'],
  ['ring', 'Ring', circle(50, 50, 50) + ' ' + circle(50, 50, 30, true)],
  ['pill', 'Pill', rrect(0, 30, 100, 40, 20)],
]);

// user-defined shapes (Edit › Define Custom Shape / Shapes panel "+")
const USER_KEY = 'pixora.vector.userShapes';
export function loadUserShapes() {
  try {
    const list = JSON.parse(localStorage.getItem(USER_KEY) || '[]') as S[];
    for (const s of list) if (!resources.shapes.some(x => x.id === s.id)) resources.shapes.push(s);
  } catch { /* ignore */ }
}
export function saveUserShapes() {
  try { localStorage.setItem(USER_KEY, JSON.stringify((resources.shapes as S[]).filter(s => s.id.startsWith('user-')))); } catch { /* ignore */ }
}
loadUserShapes();
export const shapeGroup = (s: CustomShape) => (s as S).group || 'Shapes';
