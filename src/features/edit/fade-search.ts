// Edit › Fade (Shift+Ctrl+F): blend the result of the last pixel operation (filter, adjustment, paint stroke,
// fill…) back over the previous pixels with an opacity and a blend mode. Edit › Search (Ctrl+F): command palette
// over menu commands, tools, panels, layers and help.
import './edit.css';
import { app } from '../../core/app';
import type { PixDocument } from '../../core/document';
import { commands, registerCommands, runCommand, shortcutLabel, isCommandEnabled } from '../../core/commands';
import { blendOnto } from '../../core/compositor';
import { createCanvas, ctx2d } from '../../core/canvas';
import { BLEND_MODE_LABELS, BLEND_MODE_MENU, type BlendMode } from '../../core/types';
import { h } from '../../ui/dom';
import { icon } from '../../ui/icons';
import { select, sliderRow } from '../../ui/widgets';
import { filterDialog } from '../../ui/filter-dialog';
import { toast } from '../../ui/toast';
import { buildMenus } from '../../ui/menus-def';
import { panelDefs } from '../../ui/panels';
import type { MenuEntry } from '../../ui/menu';

// ================================================================== Fade
function holderOf(doc: PixDocument) { const t = doc.getPaintTarget(); return t ? { t, canvas: t.holder.canvas, x: t.holder.x, y: t.holder.y, id: t.layer?.id ?? -1, kind: t.kind } : null; }
const fadeable = () => { const d = app.activeDoc; return !!d && d.history.canUndo && !!d.getPaintTarget(); };
async function fade() {
  const doc = app.activeDoc;
  if (!doc || !doc.history.canUndo) return;
  const now = holderOf(doc);
  if (!now) { toast('Fade is only available for pixel layers and masks.', 'info'); return; }
  const lastName = doc.history.entries[doc.history.index - 1]?.name || 'last step';
  // read the pixels before the last step (undo → copy → redo)
  const after = createCanvas(now.canvas.width, now.canvas.height); ctx2d(after).drawImage(now.canvas, 0, 0);
  const ax = now.x, ay = now.y;
  doc.history.undo();
  const prev = holderOf(doc);
  const ok = !!prev && prev.id === now.id && prev.kind === now.kind;
  const before = createCanvas(now.canvas.width, now.canvas.height);
  if (ok) ctx2d(before).drawImage(prev!.canvas, prev!.x - ax, prev!.y - ay);
  doc.history.redo();
  if (!ok) { toast(`Fade is not available: "${lastName}" did not change the pixels of the current layer.`, 'info', 4000); return; }
  // same pixels? nothing to fade
  const a = ctx2d(after).getImageData(0, 0, after.width, after.height).data, b = ctx2d(before).getImageData(0, 0, before.width, before.height).data;
  let diff = false;
  for (let i = 0; i < a.length; i += 16) if (a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2] || a[i + 3] !== b[i + 3]) { diff = true; break; }
  if (!diff) { toast(`Fade is not available: "${lastName}" did not change the pixels of the current layer.`, 'info', 4000); return; }
  const blended = (p: { opacity: number; mode: BlendMode }) => (img: ImageData): ImageData => {
    const W = img.width, H = img.height, op = p.opacity / 100;
    const res = createCanvas(W, H), rx = res.getContext('2d', { willReadFrequently: true })!;
    const ac = createCanvas(W, H); ac.getContext('2d')!.putImageData(img, 0, 0);
    if (p.mode === 'normal') {
      // premultiplied lerp: also fades transparency changes (eraser, clear)
      rx.globalAlpha = 1 - op; rx.drawImage(before, 0, 0);
      rx.globalCompositeOperation = 'lighter'; rx.globalAlpha = op; rx.drawImage(ac, 0, 0);
    } else {
      rx.drawImage(before, 0, 0);
      blendOnto(rx, ac, p.mode, op, { x: ax, y: ay, w: W, h: H });
    }
    return rx.getImageData(0, 0, W, H);
  };
  const modes = BLEND_MODE_MENU.filter(m => m !== 'pass-through').map(m => (m === '-' ? '-' : { value: m, label: BLEND_MODE_LABELS[m] })) as any[];
  await filterDialog({
    title: 'Fade', doc, params: { opacity: 100, mode: 'normal' as BlendMode }, previewBox: false, width: 440, historyName: 'Fade',
    build(body, p, update) {
      body.append(h('div.ed-fade-src', null, `Last step: ${lastName}`),
        sliderRow('Opacity:', p.opacity, 0, 100, v => { p.opacity = v; update(); }, { unit: '%' }),
        h('div.form-row', null, h('label.form-label', null, 'Mode:'), select<BlendMode>(modes, p.mode, v => { p.mode = v; update(); }, { width: 170, title: 'Blend mode' })));
    },
    op: p => blended(p),
  });
}

// ================================================================== Search (command palette)
interface Hit { kind: 'Command' | 'Tool' | 'Panel' | 'Layer' | 'Help'; label: string; path: string; keys?: string; icon?: string; run: () => void; enabled: boolean }
function index(): Hit[] {
  const out: Hit[] = [];
  const walk = (path: string, items: MenuEntry[]) => {
    for (const it of items) {
      if (!it || it === '-' || typeof it !== 'object') continue;
      const e = it as any;
      if (e.header) continue;
      const sub = typeof e.submenu === 'function' ? e.submenu() : e.submenu;
      if (sub) { walk(path ? `${path} › ${e.label}` : e.label, sub); continue; }
      const cmd = e.cmd ? commands.get(e.cmd) : null;
      if (!e.cmd && !e.action) continue;
      const label = String(e.label ?? cmd?.label ?? e.cmd).replace(/\.\.\.$/, '');
      const sc = e.shortcut ?? (Array.isArray(cmd?.shortcut) ? cmd!.shortcut[0] : cmd?.shortcut);
      const enabled = e.enabled !== undefined ? (typeof e.enabled === 'function' ? !!e.enabled() : !!e.enabled) : e.cmd ? isCommandEnabled(e.cmd) : true;
      out.push({ kind: 'Command', label, path, keys: sc ? shortcutLabel(sc) : undefined, run: () => { if (e.action) e.action(); else void runCommand(e.cmd, e.arg); }, enabled });
    }
  };
  try { for (const m of buildMenus()) walk(m.label, m.items()); } catch (err) { console.error(err); }
  for (const t of app.tools.values()) if (t.group) out.push({ kind: 'Tool', label: t.name, path: 'Tools', keys: t.shortcut, icon: t.icon, run: () => app.setTool(t.id), enabled: true });
  for (const p of panelDefs.values()) out.push({ kind: 'Panel', label: `${p.title} Panel`, path: 'Window', icon: p.icon, run: () => void runCommand('window.showPanel', p.id), enabled: true });
  const d = app.activeDoc;
  if (d) for (const l of d.allLayers()) out.push({ kind: 'Layer', label: l.name, path: `Layers · ${d.name}`, run: () => { d.setActiveLayer(l); d.layersChanged(); }, enabled: true });
  for (const [t, cmd] of [['Pixora Help', 'help.help'], ['Hands-on Tutorials', 'help.tutorials'], ['Keyboard Shortcuts', 'help.shortcuts'], ["What's New", 'help.whatsNew']]) out.push({ kind: 'Help', label: t, path: 'Help', run: () => void runCommand(cmd), enabled: true });
  return out;
}
function score(h: Hit, q: string[]): number {
  const hay = `${h.label} ${h.path}`.toLowerCase(), lab = h.label.toLowerCase();
  let s = 0;
  for (const t of q) {
    const i = hay.indexOf(t);
    if (i < 0) return -1;
    s += lab.startsWith(t) ? 30 : lab.includes(' ' + t) ? 20 : lab.includes(t) ? 10 : 2;
  }
  return s + (h.enabled ? 5 : 0) + (h.kind === 'Command' ? 2 : h.kind === 'Tool' ? 3 : 0) - lab.length * 0.02;
}
let open: HTMLElement | null = null;
function search() {
  if (open) { (open.querySelector('input') as HTMLInputElement)?.focus(); return; }
  const all = index();
  const input = h('input.ed-search-in', { type: 'search', placeholder: 'Search commands, tools, panels, layers and help…', spellcheck: false }) as HTMLInputElement;
  const list = h('div.ed-search-list');
  const box = h('div.ed-search', null, h('div.ed-search-bar', null, icon('search', 16), input), list);
  const overlay = h('div.ed-search-overlay', null, box);
  document.body.append(overlay);
  open = overlay;
  let hits: Hit[] = [], sel = 0;
  const render = () => {
    const q = input.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
    hits = q.length ? all.map(x => ({ x, s: score(x, q) })).filter(o => o.s >= 0).sort((a, b) => b.s - a.s).slice(0, 40).map(o => o.x) : all.filter(x => x.kind === 'Help' || x.kind === 'Panel').slice(0, 10);
    sel = Math.min(sel, Math.max(0, hits.length - 1));
    list.replaceChildren();
    if (!hits.length) list.append(h('div.ed-search-empty', null, 'No results'));
    hits.forEach((x, i) => {
      const row = h('div.ed-search-row', { class: [i === sel ? 'sel' : '', x.enabled ? '' : 'disabled'].join(' ') },
        h('span.ed-search-ic', null, icon(x.icon || (x.kind === 'Layer' ? 'layers' : x.kind === 'Help' ? 'info' : 'search'), 14)),
        h('span.ed-search-label', null, x.label, h('span.ed-search-path', null, x.path)),
        h('span.ed-search-kind', null, x.kind), x.keys ? h('kbd', null, x.keys) : null);
      row.addEventListener('mouseenter', () => { sel = i; list.querySelectorAll('.ed-search-row').forEach((r, k) => r.classList.toggle('sel', k === i)); });
      row.addEventListener('mousedown', e => { e.preventDefault(); go(i); });
      list.append(row);
    });
    list.querySelector('.sel')?.scrollIntoView({ block: 'nearest' });
  };
  const close = () => { overlay.remove(); open = null; };
  const go = (i: number) => { const x = hits[i]; if (!x) return; if (!x.enabled) { toast(`"${x.label}" is not available right now.`, 'info'); return; } close(); setTimeout(() => x.run()); };
  input.addEventListener('input', () => { sel = 0; render(); });
  input.addEventListener('keydown', e => {
    e.stopPropagation();
    if (e.key === 'ArrowDown') { e.preventDefault(); sel = Math.min(hits.length - 1, sel + 1); render(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); sel = Math.max(0, sel - 1); render(); }
    else if (e.key === 'Enter') { e.preventDefault(); go(sel); }
    else if (e.key === 'Escape') { e.preventDefault(); close(); }
  });
  overlay.addEventListener('mousedown', e => { if (e.target === overlay) close(); });
  render();
  setTimeout(() => input.focus());
}

registerCommands([
  { id: 'edit.fade', label: 'Fade...', shortcut: 'Shift+Ctrl+F', enabled: fadeable, run: fade },
  { id: 'edit.search', label: 'Search', shortcut: 'Ctrl+F', run: search },
]);
(window as any).__pxSearch = { index, score };
