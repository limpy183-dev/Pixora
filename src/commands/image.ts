// Image menu commands (everything except Adjustments / Auto* and the Analysis submenu).
import { app } from '../core/app';
import { registerCommands } from '../core/commands';
import type { PixDocument } from '../core/document';
import type { ColorMode } from '../core/types';
import { toast } from '../ui/toast';
import { imageSizeDialog } from '../features/image/image-size';
import { canvasSizeDialog } from '../features/image/canvas-size';
import { rotateArbitraryDialog, trimDialog, duplicateDialog, trapDialog } from '../features/image/dialogs';
import { convertMode, colorTableDialog, setBitDepth } from '../features/image/modes';
import { applyImageDialog, calculationsDialog } from '../features/image/apply-image';
import { variablesDialog, dataSetsDialog, applyDataSetDialog } from '../features/image/variables';
import { cropTo, docChanged, flipCanvas, revealRect, rotateCanvas } from '../features/image/ops';

const hasDoc = () => !!app.activeDoc;
/** Active document after committing any modal tool (crop / transform / type), like Photoshop does. */
function doc(): PixDocument {
  const t = app.activeTool;
  if (t?.isModal?.()) t.commit?.();
  return app.activeDoc!;
}

registerCommands([
  { id: 'image.mode', enabled: hasDoc, run: (m: ColorMode) => convertMode(doc(), m) },
  { id: 'image.bitDepth', enabled: hasDoc, run: (b: 8 | 16 | 32) => setBitDepth(doc(), b) },
  { id: 'image.colorTable', enabled: () => app.activeDoc?.mode === 'Indexed', run: () => colorTableDialog(doc()) },
  { id: 'image.imageSize', enabled: hasDoc, run: () => imageSizeDialog(doc()) },
  { id: 'image.canvasSize', enabled: hasDoc, run: () => canvasSizeDialog(doc()) },
  {
    id: 'image.rotate', enabled: hasDoc, run: (deg: number) => {
      const d = doc();
      d.history.transaction('Rotate Canvas', () => rotateCanvas(d, +deg || 180, app.bg), 'image');
      docChanged(d);
    },
  },
  { id: 'image.rotateArbitrary', enabled: hasDoc, run: () => rotateArbitraryDialog(doc()) },
  {
    id: 'image.flip', enabled: hasDoc, run: (axis: 'h' | 'v') => {
      const d = doc(), a = axis === 'v' ? 'v' : 'h';
      d.history.transaction(a === 'h' ? 'Flip Canvas Horizontal' : 'Flip Canvas Vertical', () => flipCanvas(d, a), 'image');
      docChanged(d);
    },
  },
  {
    id: 'image.crop', enabled: () => !!app.activeDoc && !app.activeDoc.selection.empty, run: () => {
      const d = doc(), b = d.selection.bounds;
      if (!b) { toast('Could not complete the Crop command because there is no selection.', 'error'); return; }
      const r = { x: Math.floor(b.x), y: Math.floor(b.y), w: Math.ceil(b.x + b.w) - Math.floor(b.x), h: Math.ceil(b.y + b.h) - Math.floor(b.y) };
      d.history.transaction('Crop', () => cropTo(d, r, true), 'crop');
      docChanged(d);
    },
  },
  { id: 'image.trim', enabled: hasDoc, run: () => trimDialog(doc()) },
  {
    id: 'image.revealAll', enabled: hasDoc, run: () => {
      const d = doc(), r = revealRect(d);
      if (!r) { toast('Nothing to reveal: all layer content already fits on the canvas.'); return; }
      d.history.transaction('Reveal All', () => cropTo(d, r, false), 'image');
      docChanged(d);
    },
  },
  { id: 'image.duplicate', enabled: hasDoc, run: () => duplicateDialog(doc()) },
  { id: 'image.applyImage', enabled: hasDoc, run: () => applyImageDialog(doc()) },
  { id: 'image.calculations', enabled: hasDoc, run: () => calculationsDialog(doc()) },
  { id: 'image.variables', enabled: hasDoc, run: () => variablesDialog(doc()) },
  { id: 'image.dataSets', enabled: hasDoc, run: () => dataSetsDialog(doc()) },
  { id: 'image.applyDataSet', enabled: () => !!app.activeDoc?.extra?.dataSets?.length, run: () => applyDataSetDialog(doc()) },
  { id: 'image.trap', enabled: hasDoc, run: () => trapDialog(doc()) },
]);
