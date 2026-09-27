// Brush Settings panel (F5) and Brushes panel.
//  * Brush Settings edits the active painting tool's brush (or the Brush Tool's when another tool is active):
//    Brush Tip Shape, Shape Dynamics, Scattering, Texture, Dual Brush, Color Dynamics, Transfer, Brush Pose and the
//    Noise / Wet Edges / Build-up / Smoothing / Protect Texture toggles, with section locks and a live stroke preview.
//  * Brushes lists the preset folders with stroke / tip thumbnails, search, size slider, new / delete / rename /
//    group, import and Restore Default Brushes.
import './brushes.css';
import { app, type Tool } from '../../core/app';
import { events } from '../../core/events';
import { registerPanel } from '../../ui/panels';
import { clear, h } from '../../ui/dom';
import { icon } from '../../ui/icons';
import { checkbox, iconButton, patternPicker, select, sliderRow, type Field, type SelectOption } from '../../ui/widgets';
import { contextMenu, type MenuEntry } from '../../ui/menu';
import { confirmDialog, promptDialog } from '../../ui/dialog';
import { resources } from '../../core/registry';
import { runCommand } from '../../core/commands';
import { createCanvas } from '../../core/canvas';
import { DYN_SECTIONS, defaultDynamics, normDynamics, renderStrokePreview, type Control, type Dynamics, type TexMode } from './dynamics';
import {
  CUSTOM, addGroup, allPresets, applyPreset, brushEvents, brushGroups, deleteGroup, deletePreset, findPreset, importBrushImages, movePreset,
  presetFromSettings, renameGroup, renamePreset, restoreDefaultBrushes, strokeThumb, tipThumb, type BrushPresetEx,
} from './presets';

// ------------------------------------------------------------------ target tool
/** The painting tool whose brush the panels edit. */
export function brushTool(): Tool | null {
  const t = app.activeTool;
  if (t?.settings && 'size' in t.settings && 'dyn' in t.settings) return t;
  return app.getTool('brush');
}
const S = () => brushTool()?.settings as any;
const saveTool = () => { const t = brushTool(); if (t) app.saveToolSettings(t); app.activeDoc?.redrawOverlay(); };

const CONTROL: SelectOption<Control>[] = [{ value: 'off', label: 'Off' }, { value: 'fade', label: 'Fade' }, { value: 'pressure', label: 'Pen Pressure' }, { value: 'tilt', label: 'Pen Tilt' }];
const ANGLE_CONTROL: SelectOption<string>[] = [...CONTROL, { value: 'initial', label: 'Initial Direction' }, { value: 'direction', label: 'Direction' }];
const TEX_MODES: SelectOption<TexMode>[] = [
  { value: 'multiply', label: 'Multiply' }, { value: 'subtract', label: 'Subtract' }, { value: 'darken', label: 'Darken' }, { value: 'overlay', label: 'Overlay' },
  { value: 'color-dodge', label: 'Color Dodge' }, { value: 'color-burn', label: 'Color Burn' }, { value: 'linear-burn', label: 'Linear Burn' },
  { value: 'hard-mix', label: 'Hard Mix' }, { value: 'linear-height', label: 'Linear Height' }, { value: 'height', label: 'Height' },
];
const SECTION_LABEL: Record<string, string> = {
  tip: 'Brush Tip Shape', shape: 'Shape Dynamics', scatter: 'Scattering', texture: 'Texture', dual: 'Dual Brush', color: 'Color Dynamics',
  transfer: 'Transfer', pose: 'Brush Pose', noise: 'Noise', wetEdges: 'Wet Edges', buildup: 'Build-up', smoothing: 'Smoothing', protectTexture: 'Protect Texture',
};

// ================================================================== Brush Settings
registerPanel({
  id: 'brush-settings', title: 'Brush Settings', icon: 'brush-settings', preferredWidth: 420, defaultHeight: 470, minHeight: 300,
  create(el) {
    let current = 'tip';
    const root = h('div.bs-panel');
    const head = h('div.bs-head', null,
      h('button.btn.bs-brushes-btn', { type: 'button', title: 'Show the Brushes panel', onclick: () => runCommand('window.showPanel', 'brushes') }, 'Brushes'),
      h('span.bs-tool'));
    const list = h('div.bs-list');
    const editor = h('div.bs-editor');
    const preview = createCanvas(380, 64);
    preview.className = 'bs-preview';
    const foot = h('div.panel-footer.bs-foot', null,
      iconButton('new-layer', 'Create new brush', () => void newPreset()),
      iconButton('reset', 'Reset brush controls to the defaults', () => { const s = S(); if (!s) return; const locks = normDynamics(s.dyn).locks; s.dyn = { ...defaultDynamics(), locks }; saveTool(); }));
    root.append(head, h('div.bs-main', null, list, editor), h('div.bs-preview-wrap', null, preview), foot);
    el.append(root);

    const fields: Field<any>[] = [];
    const refreshers: (() => void)[] = [];
    let building = false;
    const dyn = (): Dynamics => { const s = S(); s.dyn = normDynamics(s.dyn); return s.dyn; };
    const changed = () => { if (building) return; saveTool(); drawPreview(); };

    // ---- small builders (values are read lazily from the current tool)
    const slide = (label: string, get: () => number, put: (v: number) => void, min = 0, max = 100, unit = '%', decimals = 0) => {
      const f = sliderRow(label, get(), min, max, (v, final) => { put(v); if (final) changed(); else drawPreview(); }, { unit, decimals });
      refreshers.push(() => f.setValue(get()));
      return f;
    };
    const check = (label: string, get: () => boolean, put: (v: boolean) => void, title = label) => {
      const f = checkbox(label, get(), v => { put(v); changed(); }, { title });
      refreshers.push(() => f.setValue(get()));
      return f;
    };
    const sel = <T,>(label: string, opts: SelectOption<T>[], get: () => T, put: (v: T) => void, extra?: HTMLElement) => {
      const f = select<T>(opts, get(), v => { put(v); changed(); }, { width: 130, title: label });
      refreshers.push(() => f.setValue(get()));
      return h('div.bs-row', null, h('span.bs-lab', null, label), f, extra || null);
    };
    const control = (label: string, get: () => string, put: (v: any) => void, fadeGet: () => number, fadePut: (v: number) => void, opts: SelectOption<any>[] = CONTROL) => {
      const fade = slide('', fadeGet, fadePut, 1, 9999, '', 0);
      fade.classList.add('bs-fade');
      const sync = () => { fade.style.display = get() === 'fade' ? '' : 'none'; };
      refreshers.push(sync);
      const r = sel(label, opts, get as () => any, v => { put(v); sync(); });
      r.append(fade);
      sync();
      return r;
    };
    const tipGrid = (get: () => string | undefined, put: (p: BrushPresetEx) => void) => {
      const g = h('div.bs-tips');
      const draw = () => {
        clear(g);
        for (const p of allPresets()) {
          const b = h('button.bs-tip', { type: 'button', title: `${p.name} (${p.size} px)`, class: get() === p.id ? 'active' : '' },
            h('img', { src: tipThumb(p, 36), alt: '' }), h('span', null, String(p.size)));
          b.addEventListener('click', () => { put(p); draw(); changed(); });
          g.append(b);
        }
      };
      draw();
      refreshers.push(draw);
      return g;
    };

    // ---- sections
    const build: Record<string, () => HTMLElement[]> = {
      tip: () => {
        const s = S();
        return [
          tipGrid(() => s.tipId, p => { const keep = { dyn: s.dyn }; applyPreset(s, p); s.dyn = keep.dyn; }),
          slide('Size', () => s.size, v => { s.size = v; }, 1, 5000, 'px'),
          h('div.bs-row', null,
            check('Flip X', () => !!s.flipX, v => { s.flipX = v; }, 'Flip the tip horizontally'),
            check('Flip Y', () => !!s.flipY, v => { s.flipY = v; }, 'Flip the tip vertically')),
          slide('Angle', () => s.angle || 0, v => { s.angle = v; }, -180, 180, '°'),
          slide('Roundness', () => Math.round((s.roundness ?? 1) * 100), v => { s.roundness = Math.max(0.01, v / 100); }, 1, 100),
          slide('Hardness', () => Math.round(s.hardness * 100), v => { s.hardness = v / 100; }, 0, 100),
          slide('Spacing', () => Math.round((s.spacing ?? 0.25) * 100), v => { s.spacing = Math.max(0.01, v / 100); }, 1, 1000),
        ];
      },
      shape: () => {
        const d = () => dyn().shape;
        return [
          slide('Size Jitter', () => d().sizeJitter, v => { d().sizeJitter = v; }),
          control('Control:', () => d().sizeControl, v => { d().sizeControl = v; }, () => d().sizeFade, v => { d().sizeFade = v; }),
          slide('Minimum Diameter', () => d().minDiameter, v => { d().minDiameter = v; }),
          slide('Angle Jitter', () => d().angleJitter, v => { d().angleJitter = v; }),
          control('Control:', () => d().angleControl, v => { d().angleControl = v; }, () => d().angleFade, v => { d().angleFade = v; }, ANGLE_CONTROL),
          slide('Roundness Jitter', () => d().roundJitter, v => { d().roundJitter = v; }),
          control('Control:', () => d().roundControl, v => { d().roundControl = v; }, () => d().roundFade, v => { d().roundFade = v; }),
          slide('Minimum Roundness', () => d().minRound, v => { d().minRound = v; }, 1, 100),
          h('div.bs-row', null, check('Flip X Jitter', () => d().flipX, v => { d().flipX = v; }), check('Flip Y Jitter', () => d().flipY, v => { d().flipY = v; })),
        ];
      },
      scatter: () => {
        const d = () => dyn().scatter;
        return [
          h('div.bs-row', null, check('Both Axes', () => d().both, v => { d().both = v; }, 'Scatter along the stroke direction as well')),
          slide('Scatter', () => d().amount, v => { d().amount = v; }, 0, 1000),
          control('Control:', () => d().control, v => { d().control = v; }, () => d().fade, v => { d().fade = v; }),
          slide('Count', () => d().count, v => { d().count = v; }, 1, 16, ''),
          slide('Count Jitter', () => d().countJitter, v => { d().countJitter = v; }),
          control('Control:', () => d().countControl, v => { d().countControl = v; }, () => d().countFade, v => { d().countFade = v; }),
        ];
      },
      texture: () => {
        const d = () => dyn().texture;
        const pat = patternPicker(resources.patterns.find(p => p.id === d().pattern) || resources.patterns[0] || null, p => { d().pattern = p.id; changed(); });
        refreshers.push(() => pat.setValue(resources.patterns.find(p => p.id === d().pattern) || null));
        return [
          h('div.bs-row', null, pat, check('Invert', () => d().invert, v => { d().invert = v; })),
          slide('Scale', () => d().scale, v => { d().scale = v; }, 1, 1000),
          slide('Brightness', () => d().brightness, v => { d().brightness = v; }, -150, 150, ''),
          slide('Contrast', () => d().contrast, v => { d().contrast = v; }, -50, 100, ''),
          h('div.bs-row', null, check('Texture Each Tip', () => d().eachTip, v => { d().eachTip = v; })),
          sel('Mode:', TEX_MODES, () => d().mode, v => { d().mode = v; }),
          slide('Depth', () => d().depth, v => { d().depth = v; }),
          slide('Minimum Depth', () => d().minDepth, v => { d().minDepth = v; }),
          slide('Depth Jitter', () => d().depthJitter, v => { d().depthJitter = v; }),
        ];
      },
      dual: () => {
        const d = () => dyn().dual;
        return [
          sel('Mode:', TEX_MODES.slice(0, 8), () => d().mode, v => { d().mode = v; }, check('Flip', () => d().flip, v => { d().flip = v; }, 'Randomly flip the dual tip')),
          tipGrid(() => d().tipId, p => { d().tipId = p.id; }),
          slide('Size', () => d().size, v => { d().size = v; }, 1, 2500, 'px'),
          slide('Spacing', () => d().spacing, v => { d().spacing = v; }, 1, 1000),
          h('div.bs-row', null, check('Both Axes', () => d().both, v => { d().both = v; })),
          slide('Scatter', () => d().scatter, v => { d().scatter = v; }, 0, 1000),
          slide('Count', () => d().count, v => { d().count = v; }, 1, 16, ''),
        ];
      },
      color: () => {
        const d = () => dyn().color;
        return [
          h('div.bs-row', null, check('Apply Per Tip', () => d().perTip, v => { d().perTip = v; }, 'Vary the colour for every dab instead of once per stroke')),
          slide('Foreground/Background Jitter', () => d().fgbg, v => { d().fgbg = v; }),
          control('Control:', () => d().fgbgControl, v => { d().fgbgControl = v; }, () => d().fgbgFade, v => { d().fgbgFade = v; }),
          slide('Hue Jitter', () => d().hue, v => { d().hue = v; }),
          slide('Saturation Jitter', () => d().sat, v => { d().sat = v; }),
          slide('Brightness Jitter', () => d().bri, v => { d().bri = v; }),
          slide('Purity', () => d().purity, v => { d().purity = v; }, -100, 100),
        ];
      },
      transfer: () => {
        const d = () => dyn().transfer;
        return [
          slide('Opacity Jitter', () => d().opacity, v => { d().opacity = v; }),
          control('Control:', () => d().opacityControl, v => { d().opacityControl = v; }, () => d().opacityFade, v => { d().opacityFade = v; }),
          slide('Minimum', () => d().minOpacity, v => { d().minOpacity = v; }),
          slide('Flow Jitter', () => d().flow, v => { d().flow = v; }),
          control('Control:', () => d().flowControl, v => { d().flowControl = v; }, () => d().flowFade, v => { d().flowFade = v; }),
          slide('Minimum', () => d().minFlow, v => { d().minFlow = v; }),
        ];
      },
      pose: () => {
        const d = () => dyn().pose;
        return [
          slide('Tilt X', () => d().tiltX, v => { d().tiltX = v; }, -100, 100, ''),
          slide('Tilt Y', () => d().tiltY, v => { d().tiltY = v; }, -100, 100, ''),
          h('div.bs-row', null, check('Override Tilt', () => d().overrideTilt, v => { d().overrideTilt = v; })),
          slide('Rotation', () => d().rotation, v => { d().rotation = v; }, -180, 180, '°'),
          h('div.bs-row', null, check('Override Rotation', () => d().overrideRotation, v => { d().overrideRotation = v; })),
          slide('Pressure', () => d().pressure, v => { d().pressure = v; }, 1, 100),
          h('div.bs-row', null, check('Override Pressure', () => d().overridePressure, v => { d().overridePressure = v; })),
        ];
      },
    };

    const showEditor = () => {
      building = true;
      clear(editor); fields.length = 0; refreshers.length = 0;
      const s = S();
      if (!s) { editor.append(h('div.panel-empty', null, 'Select a painting tool to edit its brush.')); building = false; return; }
      const b = build[current];
      if (b) {
        const sectionOn = current === 'tip' || (dyn() as any)[current]?.on;
        editor.append(h('div.bs-title', null, SECTION_LABEL[current]), ...b());
        editor.classList.toggle('bs-off', !sectionOn);
      } else {
        editor.classList.remove('bs-off');
        editor.append(h('div.bs-title', null, SECTION_LABEL[current]), h('div.bs-note', null, 'This option has no settings. Turn it on or off with its check box.'));
      }
      building = false;
    };

    const drawList = () => {
      clear(list);
      const s = S();
      const d = s ? dyn() : null;
      const item = (key: string, hasCheck: boolean, lockable: boolean) => {
        const on = key === 'tip' ? true : d ? (DYN_SECTIONS.includes(key as any) ? (d as any)[key].on : (d as any)[key]) : false;
        const row = h('div.bs-item', { class: current === key ? 'active' : '' });
        if (hasCheck) {
          const cb = h('input', { type: 'checkbox', checked: !!on, title: `Enable ${SECTION_LABEL[key]}` }) as HTMLInputElement;
          cb.addEventListener('click', e => e.stopPropagation());
          cb.addEventListener('change', () => {
            if (!d) return;
            if (DYN_SECTIONS.includes(key as any)) (d as any)[key].on = cb.checked; else (d as any)[key] = cb.checked;
            if (key !== current && cb.checked && DYN_SECTIONS.includes(key as any)) current = key;
            saveTool(); drawList(); showEditor(); drawPreview();
          });
          row.append(cb);
        } else row.append(h('span.bs-cb-space'));
        row.append(h('span.bs-name', null, SECTION_LABEL[key]));
        if (lockable && d) {
          const locked = !!d.locks[key];
          const lk = h('button.bs-lock', { type: 'button', class: locked ? 'on' : '', title: locked ? 'Unlock (settings change with presets)' : 'Lock (keep these settings when choosing another preset)' }, icon(locked ? 'lock' : 'lock-open', 12));
          lk.addEventListener('click', e => { e.stopPropagation(); d.locks[key] = !locked; saveTool(); drawList(); });
          row.append(lk);
        }
        row.addEventListener('click', () => { current = key; drawList(); showEditor(); });
        list.append(row);
      };
      item('tip', false, false);
      for (const k of DYN_SECTIONS) item(k, true, true);
      for (const k of ['noise', 'wetEdges', 'buildup', 'smoothing', 'protectTexture']) item(k, true, k !== 'protectTexture');
    };

    const drawPreview = () => {
      const s = S();
      if (!s) { preview.getContext('2d')!.clearRect(0, 0, preview.width, preview.height); return; }
      const w = Math.max(120, Math.floor(preview.parentElement?.clientWidth || 380) - 12);
      if (preview.width !== w) preview.width = w;
      renderStrokePreview(preview, { ...s, dyn: s.dyn }, { r: 230, g: 230, b: 230 }, { maxSize: 44 });
    };

    const newPreset = async () => {
      const s = S();
      if (!s) return;
      const name = await promptDialog('New Brush Preset', 'Name:', findPreset(s.tipId)?.name ? `${findPreset(s.tipId)!.name} 1` : 'Brush 1');
      if (!name) return;
      presetFromSettings(s, name);
    };

    const refreshAll = () => {
      const t = brushTool();
      (head.querySelector('.bs-tool') as HTMLElement).textContent = t ? t.name : '';
      drawList();
      if (!building) { refreshers.forEach(f => f()); }
      showEditor();
      drawPreview();
    };
    let raf = 0;
    const later = () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; refreshAll(); }); };
    refreshAll();
    let lastTool: Tool | null = brushTool();
    const offs = [
      events.on('tool', () => { lastTool = brushTool(); later(); }),
      events.on('toolOptions', () => { if (brushTool() !== lastTool) later(); else { refreshers.forEach(f => f()); drawPreview(); } }),
      events.on('colors', () => drawPreview()),
      brushEvents.on('change', later),
    ];
    return { onShow: refreshAll, onResize: drawPreview, destroy: () => offs.forEach(f => f()) };
  },
  menu: () => [
    { label: 'New Brush Preset...', action: async () => { const s = S(); if (!s) return; const n = await promptDialog('New Brush Preset', 'Name:', 'Brush 1'); if (n) presetFromSettings(s, n); } },
    { label: 'Clear Brush Controls', action: () => { const s = S(); if (!s) return; s.dyn = defaultDynamics(); saveTool(); } },
    { label: 'Reset All Locked Settings', action: () => { const s = S(); if (!s) return; const d = normDynamics(s.dyn); d.locks = {}; s.dyn = d; saveTool(); } },
  ],
});

// ================================================================== Brushes panel
type BrushView = 'stroke' | 'tip' | 'list';
const bpPref = (() => { try { return { view: 'stroke' as BrushView, collapsed: [] as string[], ...JSON.parse(localStorage.getItem('pixora.brushesPanel') || '{}') }; } catch { return { view: 'stroke' as BrushView, collapsed: [] as string[] }; } })();
const bpCollapsed = new Set<string>(bpPref.collapsed);
const bpSave = () => { try { localStorage.setItem('pixora.brushesPanel', JSON.stringify({ view: bpPref.view, collapsed: [...bpCollapsed] })); } catch { /* ignore */ } };
let bpRedraw = () => {};

function pickPreset(p: BrushPresetEx) {
  const t = brushTool();
  if (!t?.settings) return;
  if (app.activeTool !== t && !(app.activeTool?.settings && 'size' in app.activeTool.settings)) app.setTool('brush');
  const tool = brushTool()!;
  applyPreset(tool.settings, p);
  app.saveToolSettings(tool);
  app.activeDoc?.redrawOverlay();
  bpRedraw();
}

async function renameP(p: BrushPresetEx) { const n = await promptDialog('Brush Name', 'Name:', p.name); if (n) renamePreset(p, n); }
async function deleteP(p: BrushPresetEx) { if ((await confirmDialog('Delete Brush', `Delete the brush "${p.name}"?`)) === 'ok') deletePreset(p); }
async function newGroupP() {
  let n = 1;
  while (brushGroups().some(g => g.name === `Group ${n}`)) n++;
  const name = await promptDialog('Group Name', 'Name:', `Group ${n}`);
  if (name) addGroup(name);
}

registerPanel({
  id: 'brushes', title: 'Brushes', icon: 'brushes', preferredWidth: 300, defaultHeight: 360,
  create(el) {
    const search = h('input.field.bp-search', { type: 'search', placeholder: 'Search Brushes', title: 'Search brushes by name' }) as HTMLInputElement;
    search.addEventListener('keydown', e => e.stopPropagation());
    const sizeRow = sliderRow('Size', S()?.size ?? 45, 1, 5000, (v, final) => { const s = S(); if (!s) return; s.size = v; if (final) saveTool(); }, { unit: 'px' });
    const listEl = h('div.bp-list.panel-scroll');
    const foot = h('div.panel-footer', null,
      iconButton('brush-settings', 'Toggle the Brush Settings panel (F5)', () => runCommand('window.togglePanel', 'brush-settings')),
      h('span.bp-flex'),
      iconButton('folder', 'Create a new group', () => void newGroupP()),
      iconButton('new-layer', 'Create new brush from the current settings', async () => { const s = S(); if (!s) return; const n = await promptDialog('New Brush Preset', 'Name:', 'Brush 1'); if (n) presetFromSettings(s, n); }),
      iconButton('trash', 'Delete the selected brush', () => { const p = findPreset(S()?.tipId); if (p) void deleteP(p); }));
    el.append(h('div.bp-panel', null, h('div.bp-top', null, search, sizeRow), listEl, foot));

    const draw = () => {
      clear(listEl);
      const q = search.value.trim().toLowerCase();
      const cur = S()?.tipId;
      for (const g of brushGroups()) {
        const items = q ? g.items.filter(p => p.name.toLowerCase().includes(q)) : g.items;
        if (q && !items.length) continue;
        const closed = !q && bpCollapsed.has(g.name);
        const head = h('div.bp-group', { title: closed ? 'Expand group' : 'Collapse group' }, icon(closed ? 'chevron-right' : 'chevron-down', 12), icon('folder-outline', 15), h('span', null, g.name));
        head.addEventListener('click', () => { if (bpCollapsed.has(g.name)) bpCollapsed.delete(g.name); else bpCollapsed.add(g.name); bpSave(); draw(); });
        head.addEventListener('contextmenu', e => {
          e.preventDefault();
          contextMenu(e, [
            { label: 'Rename Group...', action: async () => { const n = await promptDialog('Group Name', 'Name:', g.name); if (n && n !== g.name) renameGroup(g.name, n); } },
            { label: 'Delete Group', action: async () => { if ((await confirmDialog('Delete Group', `Delete the group "${g.name}" and its brushes?`)) === 'ok') deleteGroup(g.name); } },
          ]);
        });
        listEl.append(head);
        if (closed) continue;
        const box = h('div.bp-items', { class: `bp-view-${bpPref.view}` });
        for (const p of items) {
          const it = h('div.bp-item', { class: p.id === cur ? 'active' : '', title: `${p.name} (${p.size} px)` },
            h('div.bp-tip', null, h('img', { src: tipThumb(p, 36), alt: '' }), h('span.bp-size', null, String(p.size))),
            bpPref.view !== 'tip' ? h('div.bp-meta', null, h('span.bp-name', null, p.name), bpPref.view === 'stroke' ? h('img.bp-stroke', { src: strokeThumb(p, 170, 28), alt: '' }) : null) : null);
          it.addEventListener('click', () => pickPreset(p));
          it.addEventListener('dblclick', () => void renameP(p));
          it.addEventListener('contextmenu', e => {
            e.preventDefault();
            const groups = brushGroups().map(x => x.name).filter(n => n !== (p.group || ''));
            contextMenu(e, [
              { label: 'Rename Brush...', action: () => void renameP(p) },
              { label: 'Delete Brush', action: () => void deleteP(p) },
              '-',
              { label: 'Move to Group', submenu: [...groups, CUSTOM].filter((v, i, a) => a.indexOf(v) === i).map(n => ({ label: n, action: () => movePreset(p, n) })) } as MenuEntry,
            ]);
          });
          box.append(it);
        }
        listEl.append(box);
      }
      sizeRow.setValue(S()?.size ?? 45);
    };
    bpRedraw = draw;
    search.addEventListener('input', draw);
    draw();
    let raf = 0;
    const later = () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; draw(); }); };
    const offs = [brushEvents.on('change', later), events.on('tool', later), events.on('toolOptions', later)];
    return { onShow: draw, destroy: () => offs.forEach(f => f()) };
  },
  menu: () => [
    { label: 'New Brush Preset...', action: async () => { const s = S(); if (!s) return; const n = await promptDialog('New Brush Preset', 'Name:', 'Brush 1'); if (n) presetFromSettings(s, n); } },
    { label: 'New Brush Group...', action: () => void newGroupP() },
    '-',
    { label: 'Brush Name', radio: true, checked: () => bpPref.view === 'list', action: () => { bpPref.view = 'list'; bpSave(); bpRedraw(); } },
    { label: 'Brush Stroke', radio: true, checked: () => bpPref.view === 'stroke', action: () => { bpPref.view = 'stroke'; bpSave(); bpRedraw(); } },
    { label: 'Brush Tip', radio: true, checked: () => bpPref.view === 'tip', action: () => { bpPref.view = 'tip'; bpSave(); bpRedraw(); } },
    '-',
    { label: 'Import Brushes...', action: () => importBrushImages() },
    { label: 'Restore Default Brushes...', action: async () => { if ((await confirmDialog('Restore Default Brushes', 'Restore the default brushes? Renamed, moved or deleted default brushes are restored; custom brushes are kept.')) === 'ok') restoreDefaultBrushes(); } },
  ],
});
