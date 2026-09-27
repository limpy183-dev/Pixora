// Image › Variables › Define… / Data Sets… and Image › Apply Data Set… (data-driven graphics).
// Variables: Visibility (any layer) and Text Replacement (type layers). Stored in doc.extra (undoable).
import type { PixDocument } from '../../core/document';
import type { Layer } from '../../core/layer';
import { openDialog, alertDialog } from '../../ui/dialog';
import { h } from '../../ui/dom';
import { button, checkbox, iconButton, select, textField } from '../../ui/widgets';
import { docChanged } from './ops';
import { dialogRow } from './ui';

interface Variable { layerId: number; type: 'visibility' | 'text'; name: string }
interface DataSet { name: string; values: Record<string, string | boolean> }
const okCancel = [{ label: 'OK', primary: true, value: 'ok' }, { label: 'Cancel', value: null }];
const isText = (l: Layer) => l.kind === 'text' && typeof (l as any).setText === 'function';
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v ?? null)) ?? ([] as any);

function currentValue(doc: PixDocument, v: Variable): string | boolean {
  const l = doc.findLayer(v.layerId);
  if (!l) return v.type === 'visibility' ? true : '';
  return v.type === 'visibility' ? l.visible : (l as any).text ?? '';
}

/** Apply one data set to the document (one history state). */
export function applyDataSet(doc: PixDocument, set: DataSet) {
  const vars: Variable[] = doc.extra.variables || [];
  doc.history.transaction('Apply Data Set', () => {
    for (const v of vars) {
      const l = doc.findLayer(v.layerId);
      if (!l || !(v.name in set.values)) continue;
      const val = set.values[v.name];
      if (v.type === 'visibility') l.visible = !!val;
      else if (isText(l)) (l as any).setText(String(val));
      l.invalidate();
    }
  }, 'layers');
  docChanged(doc);
}

// ------------------------------------------------------------------ Define
export async function variablesDialog(doc: PixDocument) {
  const vars: Variable[] = clone(doc.extra.variables || []);
  const layers = doc.allLayers().filter(l => !l.isBackground).reverse();
  if (!layers.length) { await alertDialog('Pixora', 'Variables can only be defined for layers other than the Background.', 'info'); return; }
  let cur = layers.find(l => l.id === doc.activeLayerId && !l.isBackground) || layers[0];
  const holder = h('div.imgd-form');
  const find = (type: Variable['type']) => vars.find(v => v.layerId === cur.id && v.type === type);
  const uniqueName = (base: string) => { let n = 1; while (vars.some(v => v.name === `${base}${n}`)) n++; return `${base}${n}`; };
  const render = () => {
    const row = (type: Variable['type'], label: string, enabled: boolean) => {
      const v = find(type);
      const name = textField(v?.name || '', val => { const x = find(type); if (x) x.name = val.trim() || x.name; }, { width: 180 });
      (name as unknown as HTMLInputElement).disabled = !v;
      const cb = checkbox(label, !!v, on => {
        if (on) vars.push({ layerId: cur.id, type, name: uniqueName(type === 'text' ? 'text' : 'visibility') });
        else vars.splice(vars.indexOf(find(type)!), 1);
        render();
      });
      if (!enabled) cb.querySelector('input')!.disabled = true;
      return h('fieldset.group', null, h('legend', null, label), h('div.imgd-form', null, cb, dialogRow('Name:', name)));
    };
    holder.replaceChildren(row('visibility', 'Visibility', true), row('text', 'Text Replacement', isText(cur)));
  };
  const layerSel = select(layers.map(l => ({ value: l.id, label: l.name + (vars.some(v => v.layerId === l.id) ? ' *' : '') })), cur.id, id => { cur = layers.find(l => l.id === id)!; render(); }, { width: 220, title: 'Layer' });
  render();
  const body = h('div.imgd-form', { style: { minWidth: '360px' } }, dialogRow('Layer:', layerSel), holder,
    h('div.imgd-note', null, 'Layers marked * have variables. Use Image › Variables › Data Sets to enter values.'));
  const r = await openDialog({ title: 'Variables', body, layout: 'side', buttons: [...okCancel, { label: 'Next', value: 'next' }] }).result;
  if (r !== 'ok' && r !== 'next') return;
  doc.history.transaction('Define Variables', () => {
    doc.extra.variables = vars;
    const names = new Set(vars.map(v => v.name));
    doc.extra.dataSets = (doc.extra.dataSets || []).map((s: DataSet) => ({ ...s, values: Object.fromEntries(Object.entries(s.values).filter(([k]) => names.has(k))) }));
  });
  if (r === 'next') await dataSetsDialog(doc);
}

// ------------------------------------------------------------------ Data Sets
export async function dataSetsDialog(doc: PixDocument) {
  const vars: Variable[] = doc.extra.variables || [];
  if (!vars.length) { await alertDialog('Pixora', 'No variables are defined. Choose Image › Variables › Define first.', 'info'); return; }
  const sets: DataSet[] = clone(doc.extra.dataSets || []);
  if (!sets.length) sets.push({ name: 'Data Set 1', values: Object.fromEntries(vars.map(v => [v.name, currentValue(doc, v)])) });
  let idx = 0;
  const top = h('div.imgd-inline');
  const list = h('div.imgd-list');
  const editor = h('div.imgd-form');
  const render = () => {
    const s = sets[idx];
    const nameIn = textField(s.name, v => { s.name = v.trim() || s.name; render(); }, { width: 160 });
    top.replaceChildren(h('span', null, 'Data Set:'), nameIn,
      iconButton('chevron-left', 'Previous data set', () => { idx = (idx + sets.length - 1) % sets.length; render(); }, { size: 14 }),
      iconButton('chevron-right', 'Next data set', () => { idx = (idx + 1) % sets.length; render(); }, { size: 14 }),
      iconButton('new-layer', 'New data set (from the current values)', () => {
        sets.push({ name: `Data Set ${sets.length + 1}`, values: { ...sets[idx].values } }); idx = sets.length - 1; render();
      }, { size: 16 }),
      iconButton('trash', 'Delete this data set', () => { if (sets.length > 1) { sets.splice(idx, 1); idx = Math.min(idx, sets.length - 1); render(); } }, { size: 16, disabled: sets.length < 2 }));
    list.replaceChildren(...vars.map(v => {
      const val = s.values[v.name] ?? currentValue(doc, v);
      return h('div.imgd-list-row', null, h('span', null, v.name), h('span', null, v.type === 'visibility' ? (val ? 'Visible' : 'Invisible') : String(val)));
    }));
    editor.replaceChildren(...vars.map(v => {
      const val = s.values[v.name] ?? currentValue(doc, v);
      const layerName = doc.findLayer(v.layerId)?.name || '(missing layer)';
      const ctl = v.type === 'visibility'
        ? select([{ value: 'true', label: 'Visible' }, { value: 'false', label: 'Invisible' }], val ? 'true' : 'false', x => { s.values[v.name] = x === 'true'; render(); }, { width: 140 })
        : textField(String(val), x => { s.values[v.name] = x; render(); }, { width: 200 });
      return dialogRow(`${v.name}:`, ctl, h('span.imgd-note', null, layerName));
    }));
  };
  render();
  const body = h('div.imgd-form', { style: { minWidth: '420px' } }, top, h('fieldset.group', null, h('legend', null, 'Variables'), editor), list,
    h('div.imgd-inline', null, button('Apply to Document', () => applyDataSet(doc, sets[idx]), { title: 'Preview this data set on the document (undoable)' })));
  const r = await openDialog({ title: 'Data Sets', body, layout: 'side', buttons: okCancel }).result;
  if (r !== 'ok') return;
  doc.history.transaction('Data Sets', () => { doc.extra.dataSets = sets; });
}

// ------------------------------------------------------------------ Apply Data Set
export async function applyDataSetDialog(doc: PixDocument) {
  const sets: DataSet[] = doc.extra.dataSets || [];
  if (!sets.length) { await alertDialog('Pixora', 'There are no data sets. Choose Image › Variables › Data Sets first.', 'info'); return; }
  let idx = 0;
  const vars: Variable[] = doc.extra.variables || [];
  const table = h('div.imgd-list');
  const listEl = h('div.imgd-list');
  const render = () => {
    listEl.replaceChildren(...sets.map((s, i) => {
      const row = h('div.imgd-list-row', { class: i === idx ? 'sel' : '' }, h('span', null, s.name));
      row.addEventListener('click', () => { idx = i; render(); });
      row.addEventListener('dblclick', () => { idx = i; dlg.close('ok'); });
      return row;
    }));
    table.replaceChildren(...vars.map(v => { const val = sets[idx].values[v.name]; return h('div.imgd-list-row', null, h('span', null, v.name), h('span', null, v.type === 'visibility' ? (val === false ? 'Invisible' : 'Visible') : String(val ?? ''))); }));
  };
  render();
  const body = h('div.imgd-form', { style: { minWidth: '380px' } }, h('span', null, 'Data Sets:'), listEl, h('span', null, 'Values:'), table);
  const dlg = openDialog({ title: 'Apply Data Set', body, layout: 'side', buttons: [{ label: 'Apply', primary: true, value: 'ok' }, { label: 'Cancel', value: null }] });
  if ((await dlg.result) === 'ok') applyDataSet(doc, sets[idx]);
}
