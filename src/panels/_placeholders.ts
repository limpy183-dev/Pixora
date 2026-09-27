// Fallback registrations so every panel listed in the Window menu exists.
// Feature modules replace these by registering the same id (registration order does not matter:
// placeholders only register ids that are still missing after all modules loaded).
import { panelDefs, registerPanel } from '../ui/panels';
import { WINDOW_PANELS } from '../ui/menus-def';
import { h } from '../ui/dom';

const ICON: Record<string, string> = {
  actions: 'actions', adjustments: 'adjustments', 'brush-settings': 'brush-settings', brushes: 'brushes', channels: 'channels',
  character: 'character', 'character-styles': 'character', 'clone-source': 'clone-source', color: 'color', comments: 'comments',
  glyphs: 'glyphs', gradients: 'gradients', histogram: 'histogram', history: 'history', info: 'info', 'layer-comps': 'layer-comps',
  layers: 'layers', learn: 'learn', libraries: 'libraries', measurement: 'measurement', navigator: 'navigator', notes: 'notes',
  paragraph: 'paragraph', 'paragraph-styles': 'paragraph', paths: 'paths', patterns: 'patterns', properties: 'properties',
  shapes: 'shape-custom', styles: 'styles', swatches: 'swatches', timeline: 'timeline', 'tool-presets': 'tool-presets',
};

queueMicrotask(() => setTimeout(() => {
  for (const [title, id] of WINDOW_PANELS) {
    if (panelDefs.has(id)) continue;
    registerPanel({ id, title, icon: ICON[id] || 'properties', create(el) { el.append(h('div.panel-empty', null, `${title}`)); } });
  }
}));
