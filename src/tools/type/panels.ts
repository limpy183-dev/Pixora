// Character, Paragraph, Character Styles, Paragraph Styles and Glyphs panels + the Properties "text" section.
// Values follow the text being edited (selection / caret), else the selected type layers, else the defaults used
// for new text. Changes apply the same way (with history states named like Photoshop's).
import './type.css';
import { app } from '../../core/app';
import type { PixDocument } from '../../core/document';
import { events } from '../../core/events';
import { registerPropertiesSection } from '../../core/registry';
import { h, clear } from '../../ui/dom';
import { icon, registerIcons } from '../../ui/icons';
import { registerPanel } from '../../ui/panels';
import { openMenu, type MenuEntry } from '../../ui/menu';
import { checkbox, colorSwatch, iconButton, numberField, select, type SelectOption } from '../../ui/widgets';
import { openDialog, promptDialog } from '../../ui/dialog';
import { runCommand } from '../../core/commands';
import { toast } from '../../ui/toast';
import { TextLayer, defaultCharStyle, defaultParaStyle, CHAR_KEYS, PARA_KEYS, familyCss, type AntiAlias, type CharStyle, type ParaStyle, type TextAlign } from '../../layers/text-layer';
import { FONT_STYLES, GENERIC, fontFamilies, fontPicker } from './fonts';
import { applyParaPatch, applyToText, editStyle, editing, insertAtCaret, typeSettings } from './type-tool';

const T = (s: string, size = 12, extra = '') => `<text x="12" y="17" text-anchor="middle" font-family="Arial, sans-serif" font-size="${size}" fill="currentColor" stroke="none" ${extra}>${s}</text>`;
registerIcons({
  'ch-size': T('T', 15) + '<path d="M16 8h5M18.5 8v9" />',
  'ch-leading': '<path d="M4 6h9M4 18h9"/>' + '<path d="M18 5v14M16 7l2-2 2 2M16 17l2 2 2-2"/>',
  'ch-kerning': T('VA', 11) + '<path d="M9 21h6"/>',
  'ch-tracking': T('VA', 11) + '<path d="M4 21h16M4 19v4M20 19v4"/>',
  'ch-vscale': '<path d="M4 5h8M8 5v14"/><path d="M17 4v16M15 6l2-2 2 2M15 18l2 2 2-2"/>',
  'ch-hscale': '<path d="M5 4h14M12 4v10"/><path d="M4 19h16M6 17l-2 2 2 2M18 17l2 2-2 2"/>',
  'ch-baseline': T('A', 13, 'x="9"') + '<path d="M17 18V7M15 9l2-2 2 2M3 20h18"/>',
  'ch-fauxbold': T('T', 16, 'font-weight="bold"'),
  'ch-fauxitalic': T('T', 16, 'font-style="italic"'),
  'ch-allcaps': T('TT', 12),
  'ch-smallcaps': T('T<tspan font-size="9">T</tspan>', 13),
  'ch-super': T('T<tspan font-size="8" dy="-6">1</tspan>', 14),
  'ch-sub': T('T<tspan font-size="8" dy="3">1</tspan>', 14),
  'ch-underline': T('T', 14, 'y="15"') + '<path d="M6 20h12"/>',
  'ch-strike': T('T', 14) + '<path d="M6 12.5h12"/>',
  'pa-left': '<path d="M4 6h16M4 10h10M4 14h16M4 18h10"/>',
  'pa-center': '<path d="M4 6h16M7 10h10M4 14h16M7 18h10"/>',
  'pa-right': '<path d="M4 6h16M10 10h10M4 14h16M10 18h10"/>',
  'pa-jleft': '<path d="M4 6h16M4 10h16M4 14h16M4 18h9"/>',
  'pa-jcenter': '<path d="M4 6h16M4 10h16M4 14h16M8 18h8"/>',
  'pa-jright': '<path d="M4 6h16M4 10h16M4 14h16M11 18h9"/>',
  'pa-jall': '<path d="M4 6h16M4 10h16M4 14h16M4 18h16"/>',
  'pa-indl': '<path d="M10 6h10M10 10h10M10 14h10M10 18h10M3 9l3 3-3 3"/>',
  'pa-indr': '<path d="M4 6h10M4 10h10M4 14h10M4 18h10M21 9l-3 3 3 3"/>',
  'pa-indf': '<path d="M10 6h10M4 10h16M4 14h16M4 18h16M3 3l3 3-3 3"/>',
  'pa-spb': '<path d="M4 12h16M4 16h16M4 20h16M12 3v5M10 6l2 2 2-2"/>',
  'pa-spa': '<path d="M4 4h16M4 8h16M4 12h16M12 21v-5M10 18l2-2 2 2"/>',
  'type-style-new': '<rect x="4" y="4" width="16" height="16" rx="2"/><path d="M12 8v8M8 12h8"/>',
  'type-style-clear': '<path d="M5 19L19 5"/><path d="M7 6h10M12 6v5"/>',
  'type-style-redefine': '<path d="M4 12a8 8 0 0 1 14-5l2 2M20 12a8 8 0 0 1-14 5l-2-2"/><path d="M20 4v5h-5M4 20v-5h5"/>',
});

const LANGUAGES = ['English: USA', 'English: UK', 'English: Canadian', 'French', 'German', 'Spanish', 'Italian', 'Portuguese', 'Dutch', 'Swedish', 'Norwegian', 'Danish', 'Finnish', 'Polish', 'Russian', 'Turkish', 'Greek', 'Japanese', 'Chinese', 'Korean', 'Arabic', 'Hebrew'];
const AA: SelectOption<AntiAlias>[] = [{ value: 'none', label: 'None' }, { value: 'sharp', label: 'Sharp' }, { value: 'crisp', label: 'Crisp' }, { value: 'strong', label: 'Strong' }, { value: 'smooth', label: 'Smooth' }];
const SIZES = [6, 7, 8, 9, 10, 11, 12, 14, 18, 24, 30, 36, 48, 60, 72];
const LEADS: (number | 'auto')[] = ['auto', 6, 7, 8, 9, 10, 11, 12, 14, 18, 24, 30, 36, 48, 60, 72];
const TRACKS = [-100, -75, -50, -25, -10, -5, 0, 5, 10, 25, 50, 75, 100, 200];
const KERNS: (number | 'metrics' | 'optical')[] = ['metrics', 'optical', 0, -100, -75, -50, -25, -10, -5, 5, 10, 25, 50, 75, 100, 200];

// ------------------------------------------------------------------ state helpers
const targets = (): TextLayer[] => { const d = app.activeDoc; return d ? (d.selectedLayers.filter(l => l instanceof TextLayer) as TextLayer[]) : []; };
function curChar(): { style: CharStyle; mixed: Set<string> } {
  const es = editStyle();
  if (es) return es as any;
  const ls = targets();
  if (ls.length) {
    const r = ls[0].rangeStyle(0, ls[0].length) as { style: CharStyle; mixed: Set<string> };
    for (const l of ls.slice(1)) { const o = l.styleAt(0); for (const k of CHAR_KEYS) if (JSON.stringify(o[k]) !== JSON.stringify(r.style[k])) r.mixed.add(k); }
    return r;
  }
  return { style: { ...defaultCharStyle(), ...typeSettings.char, font: typeSettings.font, fontStyle: typeSettings.fontStyle, size: typeSettings.size, color: typeSettings.color || app.fg }, mixed: new Set() };
}
function curPara(): { para: ParaStyle; mixed: Set<string> } {
  const e = editing();
  if (e) {
    const a = Math.min(e.caret, e.anchor), b = Math.max(e.caret, e.anchor);
    const p0 = e.layer.paraIndexAt(a), p1 = e.layer.paraIndexAt(b), mixed = new Set<string>(), base = e.layer.paras[p0] || defaultParaStyle();
    for (let i = p0 + 1; i <= p1; i++) for (const k of PARA_KEYS) if (e.layer.paras[i] && e.layer.paras[i][k] !== base[k]) mixed.add(k);
    return { para: base, mixed };
  }
  const ls = targets();
  if (ls.length) {
    const base = ls[0].paras[0] || defaultParaStyle(), mixed = new Set<string>();
    for (const l of ls) for (const p of l.paras) for (const k of PARA_KEYS) if (p[k] !== base[k]) mixed.add(k);
    return { para: base, mixed };
  }
  return { para: { ...defaultParaStyle(), ...typeSettings.para, align: typeSettings.align }, mixed: new Set() };
}
const HIST: Partial<Record<keyof CharStyle, string>> = {
  font: 'Change Font', fontStyle: 'Change Font Style', size: 'Change Font Size', leading: 'Change Leading', tracking: 'Change Tracking',
  kerning: 'Change Kerning', vScale: 'Change Vertical Scale', hScale: 'Change Horizontal Scale', baseline: 'Change Baseline Shift', color: 'Change Text Color', language: 'Change Language',
};
/** Apply a character patch to the editing text / selected type layers / new-text defaults. */
export function setChar(patch: Partial<CharStyle>, name?: string) {
  const k = Object.keys(patch)[0] as keyof CharStyle;
  if (!editing() && !targets().length) {
    for (const [key, v] of Object.entries(patch)) {
      if (key === 'font' || key === 'fontStyle' || key === 'size' || key === 'color') (typeSettings as any)[key] = v;
      else (typeSettings.char as any)[key] = v;
    }
    saveType();
  } else applyToText(name || HIST[k] || 'Character Style', patch);
  events.emit('toolOptions');
}
export function setPara(patch: Partial<ParaStyle>, name = 'Paragraph Style') {
  if (editing()) applyParaPatch(patch);
  else {
    const ls = targets(), d = app.activeDoc;
    if (d && ls.length) {
      d.history.transaction(name, () => { for (const l of ls) { l.paras = l.paras.map(p => ({ ...p, ...patch })); l.invalidate(); } }, 'type');
      d.pixelsChanged(null, null); d.layersChanged();
    } else {
      for (const [key, v] of Object.entries(patch)) { if (key === 'align') typeSettings.align = v as TextAlign; else typeSettings.para[key] = v; }
      saveType();
    }
  }
  events.emit('toolOptions');
}
function saveType() { const t = app.getTool('type'); if (t) app.saveToolSettings(t); }

/** Editable combo: number input + preset menu. Accepts special words (Auto, Metrics, Optical). */
function combo<V extends number | string>(value: V, presets: V[], fmt: (v: V) => string, parse: (s: string) => V | null, onChange: (v: V) => void, opts: { width?: number; title: string; iconName?: string }) {
  let cur = value;
  const inp = h('input.field.tpp-combo-in', { type: 'text', title: opts.title, style: { width: (opts.width || 70) + 'px' } }) as HTMLInputElement;
  const arrow = h('button.popup-arrow.tpp-combo-arrow', { type: 'button', title: opts.title, 'data-menu-anchor': '' }, icon('chevron-down', 12));
  const el = h('span.tpp-combo', null, opts.iconName ? h('span.tpp-ico', { title: opts.title }, icon(opts.iconName, 18)) : null, inp, arrow) as HTMLElement & { setValue(v: V | null): void };
  const show = (v: V | null) => { if (document.activeElement !== inp) inp.value = v === null ? '' : fmt(v); };
  const commit = () => { const v = parse(inp.value.trim()); if (v === null) { show(cur); return; } cur = v; show(v); onChange(v); };
  inp.addEventListener('keydown', e => {
    e.stopPropagation();
    if (e.key === 'Enter') { commit(); inp.blur(); }
    else if (e.key === 'Escape') { show(cur); inp.blur(); }
    else if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && typeof cur === 'number') {
      e.preventDefault(); const st = (e.shiftKey ? 10 : 1) * (e.key === 'ArrowUp' ? 1 : -1);
      cur = (Math.round(((cur as number) + st) * 100) / 100) as V; inp.value = fmt(cur); onChange(cur);
    }
  });
  inp.addEventListener('change', commit);
  inp.addEventListener('focus', () => inp.select());
  arrow.addEventListener('click', () => openMenu(presets.map(p => ({ label: fmt(p), checked: p === cur, action: () => { cur = p; inp.value = fmt(p); onChange(p); } })), el, { minWidth: el.getBoundingClientRect().width, className: 'select-menu' }));
  el.setValue = v => { if (v !== null) cur = v; show(v); };
  show(value);
  return el;
}
const num = (s: string) => { const v = parseFloat(s.replace(',', '.')); return Number.isFinite(v) ? v : null; };
const fmtPt = (v: number) => `${Math.round(v * 100) / 100} pt`;

// ------------------------------------------------------------------ Character panel UI (also used by Properties)
function buildCharacter(el: HTMLElement, compact = false): () => void {
  const c0 = curChar().style;
  const font = fontPicker(c0.font, f => setChar({ font: f }), { width: compact ? 150 : 196 });
  const fstyle = select<string>(FONT_STYLES.map(s => ({ value: s, label: s })), c0.fontStyle, v => setChar({ fontStyle: v }), { width: compact ? 104 : 214, title: 'Set the font style' });
  const size = combo<number>(c0.size, SIZES, fmtPt, s => { const v = num(s); return v === null ? null : Math.max(0.1, Math.min(1296, v)); }, v => setChar({ size: v }), { title: 'Set the font size', iconName: 'ch-size' });
  const lead = combo<number | 'auto'>(c0.leading, LEADS, v => (v === 'auto' ? '(Auto)' : fmtPt(v)), s => (/auto/i.test(s) || s === '' ? 'auto' : num(s) === null ? null : Math.max(0.01, num(s)!)), v => setChar({ leading: v }), { title: 'Set the leading', iconName: 'ch-leading' });
  const kern = combo<number | 'metrics' | 'optical'>(c0.kerning, KERNS, v => (v === 'metrics' ? 'Metrics' : v === 'optical' ? 'Optical' : String(v)), s => (/^m/i.test(s) ? 'metrics' : /^o/i.test(s) ? 'optical' : num(s) === null ? null : Math.round(num(s)!)), v => setChar({ kerning: v }), { title: 'Set the kerning between two characters', iconName: 'ch-kerning' });
  const track = combo<number>(c0.tracking, TRACKS, v => String(v), s => (num(s) === null ? null : Math.max(-1000, Math.min(10000, Math.round(num(s)!)))), v => setChar({ tracking: v }), { title: 'Set the tracking for the selected characters', iconName: 'ch-tracking' });
  const vs = numberField(c0.vScale, v => setChar({ vScale: v }), { min: 1, max: 1000, unit: '%', decimals: 1, width: 70, title: 'Vertically scale', label: '' });
  const hs = numberField(c0.hScale, v => setChar({ hScale: v }), { min: 1, max: 1000, unit: '%', decimals: 1, width: 70, title: 'Horizontally scale', label: '' });
  const base = numberField(c0.baseline, v => setChar({ baseline: v }), { min: -1296, max: 1296, unit: 'pt', decimals: 2, width: 70, title: 'Set the baseline shift', label: '' });
  vs.querySelector('.scrub-label')?.replaceChildren(icon('ch-vscale', 18)); hs.querySelector('.scrub-label')?.replaceChildren(icon('ch-hscale', 18)); base.querySelector('.scrub-label')?.replaceChildren(icon('ch-baseline', 18));
  const color = colorSwatch(c0.color, c => setChar({ color: c }), { title: 'Set the text color', size: compact ? 20 : 34 });
  const TOG: [keyof CharStyle, string, string][] = [['fauxBold', 'ch-fauxbold', 'Faux Bold'], ['fauxItalic', 'ch-fauxitalic', 'Faux Italic'], ['allCaps', 'ch-allcaps', 'All Caps'], ['smallCaps', 'ch-smallcaps', 'Small Caps'],
    ['superscript', 'ch-super', 'Superscript'], ['subscript', 'ch-sub', 'Subscript'], ['underline', 'ch-underline', 'Underline'], ['strike', 'ch-strike', 'Strikethrough']];
  const togs = TOG.map(([k, ic, title]) => iconButton(ic, title, () => {
    const on = !curChar().style[k];
    const patch: Partial<CharStyle> = { [k]: on } as any;
    if (on && k === 'superscript') patch.subscript = false;
    if (on && k === 'subscript') patch.superscript = false;
    if (on && k === 'allCaps') patch.smallCaps = false;
    if (on && k === 'smallCaps') patch.allCaps = false;
    setChar(patch, title);
  }, { size: 18, cls: 'tpp-tog' }));
  const lang = select<string>(LANGUAGES.map(l => ({ value: l, label: l })), c0.language || 'English: USA', v => setChar({ language: v }), { width: 124, title: 'Set the language for hyphenation and spelling' });
  const aaOf = () => editing()?.layer.antiAlias || targets()[0]?.antiAlias || typeSettings.antiAlias;
  const aa = select<AntiAlias>(AA, aaOf(), v => runCommand('type.antialias', v), { width: 90, title: 'Set the anti-aliasing method' });

  if (compact) {
    el.append(h('div.tpp-char.compact', null,
      h('div.tpp-row', null, font, fstyle),
      h('div.tpp-row', null, size, lead),
      h('div.tpp-row', null, track, h('span.tpp-lab', null, 'Color'), color),
      h('div.tpp-togs', null, ...togs)));
  } else {
    el.append(h('div.tpp-char', null,
      h('div.tpp-row', null, font), h('div.tpp-row', null, fstyle),
      h('div.tpp-row.tpp-2', null, size, lead),
      h('div.tpp-row.tpp-2', null, kern, track),
      h('div.tpp-row.tpp-2', null, vs, hs),
      h('div.tpp-row.tpp-2', null, base, h('span.tpp-colorcell', null, h('span.tpp-lab', null, 'Color:'), color)),
      h('div.tpp-togs', null, ...togs),
      h('div.tpp-row.tpp-2', null, lang, h('span.tpp-aacell', null, h('span.tpp-lab', null, 'aa'), aa))));
  }
  const sync = () => {
    const { style: s, mixed } = curChar();
    const m = (k: string) => mixed.has(k);
    font.setValue(m('font') ? '' : s.font); fstyle.setValue(m('fontStyle') ? '' : s.fontStyle);
    size.setValue(m('size') ? null : s.size); lead.setValue(m('leading') ? null : s.leading);
    kern.setValue(m('kerning') ? null : s.kerning); track.setValue(m('tracking') ? null : s.tracking);
    vs.setValue(m('vScale') ? NaN : s.vScale); hs.setValue(m('hScale') ? NaN : s.hScale); base.setValue(m('baseline') ? NaN : s.baseline);
    color.setValue(s.color); color.classList.toggle('tpp-mixed', m('color'));
    togs.forEach((b, i) => b.classList.toggle('active', !!s[TOG[i][0]] && !m(TOG[i][0])));
    lang.setValue(s.language || 'English: USA'); aa.setValue(aaOf());
  };
  sync();
  let raf = 0;
  const later = () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; sync(); }); };
  const offs = ['toolOptions', 'activeLayer', 'layers', 'history', 'activeDoc', 'colors'].map(ev => events.on(ev as any, later));
  return () => { offs.forEach(o => o()); cancelAnimationFrame(raf); };
}

// ------------------------------------------------------------------ Paragraph panel UI
const ALIGNS: [TextAlign, string, string][] = [['left', 'pa-left', 'Left align text'], ['center', 'pa-center', 'Center text'], ['right', 'pa-right', 'Right align text'],
  ['justify-left', 'pa-jleft', 'Justify last left'], ['justify-center', 'pa-jcenter', 'Justify last centered'], ['justify-right', 'pa-jright', 'Justify last right'], ['justify-all', 'pa-jall', 'Justify all']];
function buildParagraph(el: HTMLElement, compact = false): () => void {
  const p0 = curPara().para;
  const aligns = ALIGNS.map(([a, ic, title]) => iconButton(ic, title, () => setPara({ align: a }, 'Paragraph Alignment'), { size: 18, cls: 'tpp-tog' }));
  const f = (k: keyof ParaStyle, ic: string, title: string, name: string) => {
    const nf = numberField(p0[k] as number, v => setPara({ [k]: v } as any, name), { min: -1296, max: 1296, unit: 'pt', decimals: 2, width: 70, title, label: '' });
    nf.querySelector('.scrub-label')?.replaceChildren(icon(ic, 18));
    return nf;
  };
  const il = f('indentLeft', 'pa-indl', 'Indent left margin', 'Indent Left'), ir = f('indentRight', 'pa-indr', 'Indent right margin', 'Indent Right'), fi = f('indentFirst', 'pa-indf', 'Indent first line', 'First Line Indent');
  const sb = f('spaceBefore', 'pa-spb', 'Add space before paragraph', 'Space Before'), sa = f('spaceAfter', 'pa-spa', 'Add space after paragraph', 'Space After');
  const hy = checkbox('Hyphenate', p0.hyphenate, v => setPara({ hyphenate: v }, 'Hyphenation'), { title: 'Hyphenate words at the end of lines in paragraph text' });
  if (compact) el.append(h('div.tpp-para.compact', null, h('div.tpp-togs', null, ...aligns)));
  else el.append(h('div.tpp-para', null,
    h('div.tpp-togs', null, ...aligns),
    h('div.tpp-row.tpp-2', null, il, ir), h('div.tpp-row.tpp-2', null, fi, h('span')),
    h('div.tpp-row.tpp-2', null, sb, sa), h('div.tpp-row', null, hy)));
  const sync = () => {
    const { para: p, mixed } = curPara();
    aligns.forEach((b, i) => b.classList.toggle('active', !mixed.has('align') && p.align === ALIGNS[i][0]));
    if (compact) return;
    const S = (nf: any, k: keyof ParaStyle) => nf.setValue(mixed.has(k) ? NaN : p[k]);
    S(il, 'indentLeft'); S(ir, 'indentRight'); S(fi, 'indentFirst'); S(sb, 'spaceBefore'); S(sa, 'spaceAfter'); hy.setValue(p.hyphenate);
    // justification needs a paragraph box
    const point = editing() ? editing()!.layer.textType === 'point' : targets().length > 0 && targets().every(l => l.textType === 'point');
    aligns.slice(3).forEach(b => b.toggleAttribute('disabled', point));
  };
  sync();
  let raf = 0;
  const later = () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; sync(); }); };
  const offs = ['toolOptions', 'activeLayer', 'layers', 'history', 'activeDoc'].map(ev => events.on(ev as any, later));
  return () => { offs.forEach(o => o()); cancelAnimationFrame(raf); };
}

registerPanel({
  id: 'character', title: 'Character', icon: 'kind-type', defaultHeight: 300,
  create(el) { const body = h('div.panel-scroll.tpp-panel'); el.append(body); return { destroy: buildCharacter(body) }; },
  menu: () => {
    const s = curChar().style;
    const t = (k: keyof CharStyle, label: string) => ({ label, checked: !!s[k], action: () => setChar({ [k]: !s[k] } as any, label) });
    return [t('fauxBold', 'Faux Bold'), t('fauxItalic', 'Faux Italic'), '-', t('allCaps', 'All Caps'), t('smallCaps', 'Small Caps'), t('superscript', 'Superscript'), t('subscript', 'Subscript'), '-', t('underline', 'Underline'), t('strike', 'Strikethrough'), '-',
      { label: 'Change Text Orientation', cmd: 'type.orientation', arg: (editing()?.layer || targets()[0])?.vertical ? 'horizontal' : 'vertical' },
      '-', { label: 'Reset Character', action: () => { const d = defaultCharStyle(); const c = curChar().style; setChar({ ...d, font: c.font, color: c.color }, 'Reset Character'); } }];
  },
});
registerPanel({
  id: 'paragraph', title: 'Paragraph', icon: 'pa-left', defaultHeight: 220,
  create(el) { const body = h('div.panel-scroll.tpp-panel'); el.append(body); return { destroy: buildParagraph(body) }; },
  menu: () => [
    { label: 'Hyphenation...', action: () => { const p = curPara().para; setPara({ hyphenate: !p.hyphenate }, 'Hyphenation'); toast(`Hyphenation ${p.hyphenate ? 'off' : 'on'}`, 'info'); } },
    '-', { label: 'Reset Paragraph', action: () => setPara(defaultParaStyle(), 'Reset Paragraph') },
  ],
});

// Properties panel: type layer section (compact Character + Paragraph)
registerPropertiesSection({
  id: 'text', title: 'Character', order: 30,
  match: (_d, l) => l instanceof TextLayer,
  build(el) {
    const off1 = buildCharacter(el, true);
    const sub = h('div.tpp-sub', null, h('div.tpp-subhead', null, 'Paragraph'));
    el.append(sub);
    const off2 = buildParagraph(sub, true);
    el.append(h('div.tpp-links', null,
      h('button.btn', { type: 'button', title: 'Open the Character panel', onclick: () => runCommand('window.showPanel', 'character') }, 'Character…'),
      h('button.btn', { type: 'button', title: 'Open the Paragraph panel', onclick: () => runCommand('window.showPanel', 'paragraph') }, 'Paragraph…'),
      h('button.btn', { type: 'button', title: 'Warp the text (Type > Warp Text)', onclick: () => runCommand('type.warp') }, 'Warp…')));
    return () => { off1(); off2(); };
  },
});

// ------------------------------------------------------------------ Character / Paragraph Styles
interface CStyle { id: number; name: string; style: Partial<CharStyle> }
interface PStyle { id: number; name: string; para: Partial<ParaStyle>; style: Partial<CharStyle> }
const listOf = <X>(doc: PixDocument, key: 'charStyles' | 'paraStyles'): X[] => (doc.extra[key] as X[]) || [];

function stylesPanel(kind: 'char' | 'para') {
  const key = kind === 'char' ? 'charStyles' : 'paraStyles';
  const noneName = kind === 'char' ? 'None' : 'Basic Paragraph';
  const title = kind === 'char' ? 'Character Style' : 'Paragraph Style';
  let selectedId = 0;
  const applyStyle = (id: number) => {
    const doc = app.activeDoc;
    if (!doc) return;
    selectedId = id;
    if (kind === 'char') {
      const st = listOf<CStyle>(doc, 'charStyles').find(s => s.id === id);
      setChar(st ? { ...st.style } : { fauxBold: false, fauxItalic: false, allCaps: false, smallCaps: false, superscript: false, subscript: false, underline: false, strike: false, tracking: 0, baseline: 0, vScale: 100, hScale: 100 }, 'Apply Character Style');
    } else {
      const st = listOf<PStyle>(doc, 'paraStyles').find(s => s.id === id);
      const para = st ? st.para : defaultParaStyle();
      setPara(para, 'Apply Paragraph Style');
      if (st && Object.keys(st.style).length) setChar({ ...st.style }, 'Apply Paragraph Style');
    }
  };
  const snapshot = () => {
    const c = curChar().style;
    const style: Partial<CharStyle> = { font: c.font, fontStyle: c.fontStyle, size: c.size, leading: c.leading, tracking: c.tracking, color: { ...c.color }, fauxBold: c.fauxBold, fauxItalic: c.fauxItalic, allCaps: c.allCaps, smallCaps: c.smallCaps, underline: c.underline, strike: c.strike, baseline: c.baseline, vScale: c.vScale, hScale: c.hScale };
    return kind === 'char' ? { style } : { style, para: { ...curPara().para } };
  };
  const newStyle = async () => {
    const doc = app.activeDoc;
    if (!doc) { toast('Open a document to create styles.', 'error'); return; }
    const list = listOf<any>(doc, key);
    const name = await promptDialog(`New ${title}`, 'Style Name:', `${title} ${list.length + 1}`);
    if (!name) return;
    const id = Math.max(0, ...list.map((s: any) => s.id)) + 1;
    doc.history.transaction(`New ${title}`, () => { doc.extra[key] = [...list, { id, name, ...snapshot() }]; });
    selectedId = id; events.emit('layers', doc);
  };
  const del = () => {
    const doc = app.activeDoc;
    if (!doc || !selectedId) return;
    doc.history.transaction(`Delete ${title}`, () => { doc.extra[key] = listOf<any>(doc, key).filter((s: any) => s.id !== selectedId); });
    selectedId = 0; events.emit('layers', doc);
  };
  const redefine = () => {
    const doc = app.activeDoc;
    if (!doc || !selectedId) return;
    doc.history.transaction(`Redefine ${title}`, () => { doc.extra[key] = listOf<any>(doc, key).map((s: any) => (s.id === selectedId ? { ...s, ...snapshot() } : s)); });
    events.emit('layers', doc);
  };
  const options = async (id: number) => {
    const doc = app.activeDoc;
    const st = doc && listOf<any>(doc, key).find((s: any) => s.id === id);
    if (!doc || !st) return;
    const d: any = JSON.parse(JSON.stringify(st));
    const name = h('input.field', { type: 'text', value: d.name, style: { width: '220px' } }) as HTMLInputElement;
    name.addEventListener('keydown', e => e.stopPropagation());
    const s = d.style as Partial<CharStyle>;
    const body = h('div.form.tpp-opts', null,
      h('div.form-row', null, h('label.form-label', null, 'Style Name:'), name),
      h('div.form-row', null, h('label.form-label', null, 'Font Family:'), fontPicker(s.font || 'Arial', f => { s.font = f; }, { width: 180 })),
      h('div.form-row', null, h('label.form-label', null, 'Font Style:'), select<string>(FONT_STYLES.map(x => ({ value: x, label: x })), s.fontStyle || 'Regular', v => { s.fontStyle = v; }, { width: 180 })),
      h('div.form-row', null, h('label.form-label', null, 'Size:'), numberField(s.size ?? 12, v => { s.size = v; }, { min: 0.1, max: 1296, unit: 'pt', decimals: 2, width: 80 }),
        h('label.form-label', null, 'Tracking:'), numberField(s.tracking ?? 0, v => { s.tracking = v; }, { min: -1000, max: 10000, width: 70 })),
      h('div.form-row', null, h('label.form-label', null, 'Color:'), colorSwatch(s.color || { r: 0, g: 0, b: 0 }, c => { s.color = c; }, { title: 'Style color' })),
      h('div.form-row', null, h('label.form-label', null, ''),
        checkbox('Faux Bold', !!s.fauxBold, v => { s.fauxBold = v; }), checkbox('Faux Italic', !!s.fauxItalic, v => { s.fauxItalic = v; }),
        checkbox('Underline', !!s.underline, v => { s.underline = v; }), checkbox('All Caps', !!s.allCaps, v => { s.allCaps = v; })),
      kind === 'para' ? h('div.form-row', null, h('label.form-label', null, 'Alignment:'), select<TextAlign>(ALIGNS.map(([a, , t]) => ({ value: a, label: t })), d.para.align || 'left', v => { d.para.align = v; }, { width: 180 })) : null,
      kind === 'para' ? h('div.form-row', null, h('label.form-label', null, 'Space After:'), numberField(d.para.spaceAfter ?? 0, v => { d.para.spaceAfter = v; }, { min: -1296, max: 1296, unit: 'pt', decimals: 2, width: 80 })) : null);
    const ok = await openDialog({ title: `${title} Options`, body, layout: 'side', width: 560 }).result;
    if (!ok) return;
    d.name = name.value || d.name;
    doc.history.transaction(`Edit ${title}`, () => { doc.extra[key] = listOf<any>(doc, key).map((x: any) => (x.id === id ? d : x)); });
    events.emit('layers', doc);
  };
  registerPanel({
    id: kind === 'char' ? 'character-styles' : 'paragraph-styles', title: kind === 'char' ? 'Character Styles' : 'Paragraph Styles', icon: 'kind-type', defaultHeight: 200,
    create(el) {
      const list = h('div.panel-scroll.list.tpp-styles');
      const footer = h('div.panel-footer', null,
        iconButton('type-style-clear', 'Clear Override', () => applyStyle(selectedId)),
        iconButton('type-style-redefine', 'Redefine the style from the current text', redefine),
        iconButton('type-style-new', `Create new ${title.toLowerCase()}`, newStyle),
        iconButton('trash', `Delete ${title.toLowerCase()}`, del));
      el.append(list, footer);
      const render = () => {
        clear(list);
        const doc = app.activeDoc;
        const items: any[] = [{ id: 0, name: noneName }, ...(doc ? listOf<any>(doc, key) : [])];
        for (const s of items) {
          const st: Partial<CharStyle> = s.style || {};
          const row = h('div.tpp-style', { class: s.id === selectedId ? 'selected' : '', title: s.id ? `${s.name} — click to apply, double-click for options` : `Apply ${noneName}` },
            h('span.tpp-style-name', { style: st.font ? { fontFamily: `${familyCss(st.font)}, sans-serif`, fontWeight: st.fauxBold || /bold|black/i.test(st.fontStyle || '') ? 'bold' : '', fontStyle: st.fauxItalic || /italic/i.test(st.fontStyle || '') ? 'italic' : '' } : undefined }, s.name),
            st.color ? h('span.tpp-style-chip', { style: { background: `rgb(${st.color.r},${st.color.g},${st.color.b})` } }) : null);
          row.addEventListener('click', () => { applyStyle(s.id); render(); });
          row.addEventListener('dblclick', () => options(s.id));
          list.append(row);
        }
        footer.querySelectorAll('button').forEach((b, i) => { if (i === 1 || i === 3) b.toggleAttribute('disabled', !selectedId); });
      };
      render();
      const offs = ['layers', 'activeDoc', 'history'].map(ev => events.on(ev as any, render));
      return { onShow: render, destroy: () => offs.forEach(o => o()) };
    },
    menu: () => [
      { label: `New ${title}...`, action: newStyle },
      { label: 'Duplicate Style', enabled: !!selectedId, action: () => {
        const doc = app.activeDoc; const s = doc && listOf<any>(doc, key).find((x: any) => x.id === selectedId);
        if (!doc || !s) return;
        const id = Math.max(0, ...listOf<any>(doc, key).map((x: any) => x.id)) + 1;
        doc.history.transaction(`Duplicate ${title}`, () => { doc.extra[key] = [...listOf<any>(doc, key), { ...JSON.parse(JSON.stringify(s)), id, name: s.name + ' copy' }]; });
        events.emit('layers', doc);
      } },
      { label: 'Delete Style', enabled: !!selectedId, action: del },
      '-', { label: 'Redefine Style', enabled: !!selectedId, action: redefine },
      { label: 'Style Options...', enabled: !!selectedId, action: () => options(selectedId) },
      { label: 'Clear Override', action: () => applyStyle(selectedId) },
    ] as MenuEntry[],
  });
}
stylesPanel('char');
stylesPanel('para');

// ------------------------------------------------------------------ Glyphs panel
const RANGES: [string, number, number][] = [
  ['Basic Latin', 0x21, 0x7e], ['Latin-1 Supplement', 0xa1, 0xff], ['Latin Extended-A', 0x100, 0x17f], ['Greek', 0x391, 0x3c9],
  ['Cyrillic', 0x410, 0x44f], ['Punctuation', 0x2010, 0x205e], ['Superscripts and Subscripts', 0x2070, 0x209c], ['Currency', 0x20a0, 0x20bf],
  ['Letterlike Symbols', 0x2100, 0x214f], ['Number Forms', 0x2150, 0x218b], ['Arrows', 0x2190, 0x21ff], ['Math Operators', 0x2200, 0x22ff],
  ['Box Drawing', 0x2500, 0x257f], ['Geometric Shapes', 0x25a0, 0x25ff], ['Misc Symbols', 0x2600, 0x26ff], ['Dingbats', 0x2700, 0x27bf],
];
const RECENT_G = 'pixora.type.recentGlyphs';
const recentGlyphs = (): string[] => { try { return JSON.parse(localStorage.getItem(RECENT_G) || '[]'); } catch { return []; } };
const supportCache = new Map<string, Set<number>>();
/** Code points the font draws itself (differs from both fallback fonts). */
function supported(font: string): Set<number> {
  let s = supportCache.get(font);
  if (s) return s;
  s = new Set();
  const c = document.createElement('canvas').getContext('2d')!;
  const fam = GENERIC.includes(font) ? font : familyCss(font);
  for (const [, a, b] of RANGES) for (let cp = a; cp <= b; cp++) {
    const ch = String.fromCodePoint(cp);
    c.font = '40px monospace'; const m1 = c.measureText(ch).width;
    c.font = `40px ${fam}, monospace`; const f1 = c.measureText(ch).width;
    c.font = '40px serif'; const m2 = c.measureText(ch).width;
    c.font = `40px ${fam}, serif`; const f2 = c.measureText(ch).width;
    if (f1 !== m1 || f2 !== m2 || f1 === f2) s.add(cp);
  }
  supportCache.set(font, s);
  return s;
}
registerPanel({
  id: 'glyphs', title: 'Glyphs', icon: 'kind-type', defaultHeight: 300,
  create(el) {
    let font = curChar().style.font, range = 'Entire Font', cell = 30;
    const fp = fontPicker(font, f => { font = f; render(); }, { width: 170 });
    const rsel = select<string>([{ value: 'Entire Font', label: 'Entire Font' }, ...RANGES.map(([n]) => ({ value: n, label: n }))], range, v => { range = v; render(); }, { width: 150, title: 'Show glyphs from' });
    const recentRow = h('div.tpp-grecent');
    const grid = h('div.panel-scroll.tpp-glyphs');
    const status = h('span.tpp-gstatus');
    const zoomOut = iconButton('zoom-out', 'Smaller glyphs', () => { cell = Math.max(20, cell - 6); render(); }, { size: 16 });
    const zoomIn = iconButton('zoom-in', 'Larger glyphs', () => { cell = Math.min(64, cell + 6); render(); }, { size: 16 });
    el.append(h('div.tpp-gbar', null, fp, rsel), recentRow, grid, h('div.panel-footer.tpp-gfoot', null, status, h('span.tpp-flex'), zoomOut, zoomIn));
    const insert = (ch: string) => {
      if (!insertAtCaret(ch)) { toast('Click in text with the Type tool to insert glyphs.', 'info'); return; }
      try { localStorage.setItem(RECENT_G, JSON.stringify([ch, ...recentGlyphs().filter(x => x !== ch)].slice(0, 16))); } catch { /* ignore */ }
      renderRecent();
    };
    const glyph = (ch: string) => {
      const b = h('button.tpp-glyph', { type: 'button', title: `U+${ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')} — double-click to insert`, style: { width: cell + 'px', height: cell + 'px', fontSize: Math.round(cell * 0.6) + 'px', fontFamily: `${GENERIC.includes(font) ? font : familyCss(font)}, sans-serif` } }, ch);
      b.addEventListener('dblclick', () => insert(ch));
      b.addEventListener('mouseenter', () => { status.textContent = b.title.split(' —')[0]; });
      return b;
    };
    const renderRecent = () => { clear(recentRow); recentRow.append(h('span.tpp-lab', null, 'Recently used:')); for (const g of recentGlyphs()) recentRow.append(glyph(g)); };
    const render = () => {
      clear(grid);
      const cps: number[] = [];
      if (range === 'Entire Font') { const s = supported(font); for (const [, a, b] of RANGES) for (let cp = a; cp <= b; cp++) if (s.has(cp)) cps.push(cp); }
      else { const r = RANGES.find(x => x[0] === range)!; for (let cp = r[1]; cp <= r[2]; cp++) cps.push(cp); }
      const frag = document.createDocumentFragment();
      for (const cp of cps) frag.append(glyph(String.fromCodePoint(cp)));
      grid.append(frag);
      status.textContent = `${cps.length} glyphs`;
      renderRecent();
    };
    render();
    const off = events.on('toolOptions', () => { const f = curChar().style.font; if (f && f !== font && fontFamilies().includes(f)) { font = f; fp.setValue(f); render(); } });
    return { destroy: off };
  },
});

export const _typePanels = { curChar, curPara };
