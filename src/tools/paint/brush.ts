// Brush Tool (B) and Pencil Tool (B, aliased hard edges, Auto Erase).
import { app } from '../../core/app';
import { checkbox } from '../../ui/widgets';
import { createPaintTool, paintDefaults, sameRGB, standardOptions, targetPixel } from './common';

createPaintTool({
  id: 'brush', name: 'Brush Tool', group: 'brush', icon: 'brush', shortcut: 'B', order: 0,
  settings: paintDefaults(),
  historyName: 'Brush Tool',
  altEyedropper: true,
  setup: () => ({}),
});

const pencilSettings = paintDefaults({ size: 1, hardness: 1, tipId: 'hard-round', smoothing: 0, autoErase: false });
createPaintTool({
  id: 'pencil', name: 'Pencil Tool', group: 'brush', icon: 'pencil', shortcut: 'B', order: 1,
  settings: pencilSettings,
  historyName: 'Pencil',
  altEyedropper: true,
  options: (bar, tool) => standardOptions(bar, tool, {
    flow: false,
    extra: c => {
      const f = checkbox('Auto Erase', c.s.autoErase, v => { c.s.autoErase = v; c.save(); }, { title: 'Paint the background color over areas that contain the foreground color' });
      c.syncs.push(() => f.setValue(c.s.autoErase));
      return [f];
    },
  }),
  setup: (_doc, target, p, s) => {
    let color = app.fg;
    if (s.autoErase && !target.isMask) {
      const px = targetPixel(target, p.x, p.y);
      if (px && px.a > 0 && sameRGB(px, app.fg, 1)) color = app.bg;
    }
    return { color, aliased: true, hardness: 1, flow: 1 };
  },
});
