// Filter menu definitions: Pixelate, Render, Sharpen, Stylize, Video, Other (+ Convert for Smart Filters).
import { h } from '../ui/dom';
import { registerCommands, runCommand } from '../core/commands';
import { app } from '../core/app';
import { defineFilter, ui } from './engine';
import { activePath, polylines } from './defs-a';

const hint = (t: string) => h('div.flt-hint', null, t);
const pathLines = (doc: any) => { const p = activePath(doc); return p ? polylines(p.subpaths, 3) : []; };

// ================================================================== Pixelate
defineFilter({
  id: 'color-halftone', label: 'Color Halftone', category: 'Pixelate', defaults: () => ({ radius: 8, a1: 108, a2: 162, a3: 90, a4: 45 }),
  ui: (b, p, u) => b.append(ui.number('Max. Radius:', p, 'radius', u, { min: 4, max: 127, unit: 'Pixels' }), h('div.flt-sub', null, 'Screen Angles (Degrees):'),
    ui.number('Channel 1:', p, 'a1', u, { min: -360, max: 360 }), ui.number('Channel 2:', p, 'a2', u, { min: -360, max: 360 }), ui.number('Channel 3:', p, 'a3', u, { min: -360, max: 360 }), ui.number('Channel 4:', p, 'a4', u, { min: -360, max: 360 }),
    ui.button('Default', 'Restore default angles', () => { Object.assign(p, { a1: 108, a2: 162, a3: 90, a4: 45 }); u(); })),
});
defineFilter({ id: 'crystallize', label: 'Crystallize', category: 'Pixelate', defaults: () => ({ size: 10 }), ui: (b, p, u) => b.append(ui.slider('Cell Size:', p, 'size', 3, 300, u)) });
defineFilter({ id: 'facet', label: 'Facet', category: 'Pixelate', dialog: false, defaults: () => ({}) });
defineFilter({ id: 'fragment', label: 'Fragment', category: 'Pixelate', dialog: false, defaults: () => ({}) });
const MEZZO = ['fine dots', 'medium dots', 'grainy dots', 'coarse dots', 'short lines', 'medium lines', 'long lines', 'short strokes', 'medium strokes', 'long strokes'];
defineFilter({
  id: 'mezzotint', label: 'Mezzotint', category: 'Pixelate', defaults: () => ({ type: 'fine dots' }),
  ui: (b, p, u) => b.append(ui.select('Type:', p, 'type', MEZZO.map(v => ({ value: v, label: v.replace(/^./, c => c.toUpperCase()) })), u)),
});
defineFilter({ id: 'mosaic', label: 'Mosaic', category: 'Pixelate', defaults: () => ({ size: 10 }), ui: (b, p, u) => b.append(ui.slider('Cell Size:', p, 'size', 2, 200, u, { unit: 'square' })) });
defineFilter({ id: 'pointillize', label: 'Pointillize', category: 'Pixelate', defaults: () => ({ size: 5 }), ui: (b, p, u) => b.append(ui.slider('Cell Size:', p, 'size', 3, 300, u), hint('Uses the background color between the dots.')) });

// ================================================================== Render
defineFilter({
  id: 'flame', label: 'Flame', category: 'Render', width: 660,
  defaults: () => ({ type: 'multiple', length: 120, width: 40, angle: 0, interval: 60, turbulence: 25, jag: 20, opacity: 100, useColor: false, color: { r: 60, g: 140, b: 255 }, seed: 7 }),
  prepare: doc => ({ polylines: pathLines(doc) }),
  ui: (b, p, u, ctx) => b.append(
    hint(pathLines(ctx.doc).length ? 'Flames follow the selected path (or Work Path).' : 'No path: flames run along the bottom of the canvas. Draw a path with the Pen tool to place them.'),
    ui.select('Flame Type:', p, 'type', [{ value: 'one', label: 'One Flame Along Path' }, { value: 'multiple', label: 'Multiple Flames Along Path' }, { value: 'various', label: 'Multiple Flames Various Angles' }, { value: 'candle', label: 'Candle Light' }], u, 220),
    ui.slider('Length:', p, 'length', 1, 1000, u), ui.slider('Width:', p, 'width', 1, 500, u), ui.slider('Angle:', p, 'angle', -180, 180, u, { unit: '°', center: 0 }), ui.slider('Interval:', p, 'interval', 4, 500, u),
    ui.slider('Turbulent:', p, 'turbulence', 0, 100, u), ui.slider('Jag:', p, 'jag', 0, 100, u), ui.slider('Opacity:', p, 'opacity', 1, 100, u, { unit: '%' }),
    ui.check('Use Custom Color for Flames', p, 'useColor', u), ui.color('Color:', p, 'color', u),
    ui.button('Randomize', 'New random flames', () => { p.seed = Math.floor(Math.random() * 1e6); u(); })),
});
defineFilter({
  id: 'picture-frame', label: 'Picture Frame', category: 'Render', width: 640,
  defaults: () => ({ style: 'vine', margin: 20, size: 18, color: { r: 46, g: 110, b: 50 }, color2: { r: 120, g: 180, b: 70 }, seed: 3 }),
  ui: (b, p, u) => b.append(
    ui.select('Frame:', p, 'style', [{ value: 'simple', label: 'Simple Border' }, { value: 'double', label: 'Double Line' }, { value: 'dots', label: 'Dotted' }, { value: 'vine', label: 'Vine' }, { value: 'leaves', label: 'Leaves' }, { value: 'ribbon', label: 'Ribbon' }], u),
    ui.slider('Margin:', p, 'margin', 0, 400, u), ui.slider('Size:', p, 'size', 2, 200, u), ui.color('Color:', p, 'color', u), ui.color('Accent Color:', p, 'color2', u)),
});
defineFilter({
  id: 'tree', label: 'Tree', category: 'Render', width: 640,
  defaults: () => ({ style: 'oak', height: 320, branches: 6, leaves: 60, leafSize: 9, leafColor: { r: 70, g: 140, b: 55 }, trunkColor: { r: 90, g: 62, b: 40 }, lean: 0, multiple: false, seed: 11 }),
  prepare: doc => ({ polylines: pathLines(doc) }),
  ui: (b, p, u, ctx) => b.append(
    hint(pathLines(ctx.doc).length ? 'Trees grow from the selected path.' : 'No path: the tree grows from the bottom centre. Draw a path to place trees.'),
    ui.select('Base Tree Type:', p, 'style', [{ value: 'oak', label: 'Oak' }, { value: 'pine', label: 'Pine' }, { value: 'willow', label: 'Willow' }], u),
    ui.slider('Height:', p, 'height', 20, 2000, u), ui.slider('Branches:', p, 'branches', 2, 9, u), ui.slider('Leaves Amount:', p, 'leaves', 0, 100, u), ui.slider('Leaves Size:', p, 'leafSize', 1, 60, u),
    ui.slider('Lean:', p, 'lean', -45, 45, u, { unit: '°', center: 0 }), ui.color('Leaves Color:', p, 'leafColor', u), ui.color('Branches Color:', p, 'trunkColor', u),
    ui.check('Multiple Trees Along Path', p, 'multiple', u), ui.button('Randomize', 'Grow a different tree', () => { p.seed = Math.floor(Math.random() * 1e6); u(); })),
});
defineFilter({ id: 'clouds', label: 'Clouds', category: 'Render', dialog: false, defaults: () => ({ strong: false }) });
defineFilter({ id: 'difference-clouds', label: 'Difference Clouds', category: 'Render', dialog: false, defaults: () => ({ strong: false }) });
defineFilter({
  id: 'fibers', label: 'Fibers', category: 'Render', defaults: () => ({ variance: 16, strength: 4, seed: 1 }),
  ui: (b, p, u) => b.append(ui.slider('Variance:', p, 'variance', 1, 64, u), ui.slider('Strength:', p, 'strength', 1, 64, u), ui.button('Randomize', 'New random fibers', () => { p.seed = Math.floor(Math.random() * 1e6); u(); }), hint('Uses the foreground and background colors.')),
});
defineFilter({
  id: 'lens-flare', label: 'Lens Flare', category: 'Render', previewBox: false, defaults: () => ({ brightness: 100, cx: 30, cy: 30, lens: 'zoom' }),
  ui: (b, p, u, ctx) => b.append(ui.slider('Brightness:', p, 'brightness', 10, 300, u, { unit: '%' }), ui.center('Flare Center:', p, 'cx', 'cy', u, ctx),
    ui.radios('Lens Type', p, 'lens', [['zoom', '50-300mm Zoom'], ['35', '35mm Prime'], ['105', '105mm Prime'], ['movie', 'Movie Prime']], u)),
});
defineFilter({
  id: 'lighting', label: 'Lighting Effects', category: 'Render', width: 700,
  defaults: () => ({ type: 'spot', color: { r: 255, g: 255, b: 255 }, intensity: 35, cx: 50, cy: 40, lz: 45, radius: 90, angle: -60, cone: 70, hotspot: 50, ambience: 8, gloss: 0, metallic: 0, exposure: 0, texture: 'none', height: 50, whiteHigh: true }),
  ui: (b, p, u, ctx) => b.append(
    ui.select('Light:', p, 'type', [{ value: 'spot', label: 'Spot' }, { value: 'point', label: 'Point' }, { value: 'infinite', label: 'Infinite' }], u),
    ui.center('Position:', p, 'cx', 'cy', u, ctx), ui.color('Color:', p, 'color', u),
    ui.slider('Intensity:', p, 'intensity', -100, 100, u, { center: 0 }), ui.slider('Height:', p, 'lz', 1, 100, u), ui.slider('Radius:', p, 'radius', 5, 200, u, { unit: '%' }),
    ui.angle('Direction:', p, 'angle', u), ui.slider('Cone:', p, 'cone', 5, 170, u, { unit: '°' }), ui.slider('Hotspot:', p, 'hotspot', 0, 100, u, { unit: '%' }),
    h('div.flt-sub', null, 'Properties'),
    ui.slider('Exposure:', p, 'exposure', -100, 100, u, { center: 0 }), ui.slider('Gloss:', p, 'gloss', -100, 100, u, { center: 0 }), ui.slider('Metallic:', p, 'metallic', -100, 100, u, { center: 0 }), ui.slider('Ambience:', p, 'ambience', -100, 100, u, { center: 0 }),
    ui.select('Texture:', p, 'texture', [{ value: 'none', label: 'None' }, { value: 'red', label: 'Red' }, { value: 'green', label: 'Green' }, { value: 'blue', label: 'Blue' }, { value: 'luma', label: 'Luminosity' }], u),
    ui.slider('Texture Height:', p, 'height', 0, 100, u), ui.check('White is High', p, 'whiteHigh', u)),
});

// ================================================================== Sharpen
defineFilter({
  id: 'shake-reduction', label: 'Shake Reduction', category: 'Sharpen', width: 660, defaults: () => ({ auto: true, angle: 0, length: 10, smoothing: 30, suppress: 20, iterations: 6 }),
  ui: (b, p, u) => b.append(
    ui.check('Estimate Blur Trace Automatically', p, 'auto', u), ui.angle('Blur Trace Angle:', p, 'angle', u), ui.slider('Blur Trace Length:', p, 'length', 2, 40, u, { unit: 'px' }),
    ui.slider('Smoothing:', p, 'smoothing', 0, 100, u, { unit: '%' }), ui.slider('Artifact Suppression:', p, 'suppress', 0, 100, u, { unit: '%' }), ui.slider('Iterations:', p, 'iterations', 1, 20, u)),
});
defineFilter({ id: 'sharpen', label: 'Sharpen', category: 'Sharpen', dialog: false, defaults: () => ({}) });
defineFilter({ id: 'sharpen-edges', label: 'Sharpen Edges', category: 'Sharpen', dialog: false, defaults: () => ({}) });
defineFilter({ id: 'sharpen-more', label: 'Sharpen More', category: 'Sharpen', dialog: false, defaults: () => ({}) });
defineFilter({
  id: 'smart-sharpen', label: 'Smart Sharpen', category: 'Sharpen', width: 680, defaults: () => ({ amount: 200, radius: 1, noise: 10, remove: 'gaussian', angle: 0, shadowFade: 0, highlightFade: 0 }),
  ui: (b, p, u) => b.append(
    ui.slider('Amount:', p, 'amount', 1, 500, u, { unit: '%' }), ui.slider('Radius:', p, 'radius', 0.1, 64, u, { unit: 'px', decimals: 1, step: 0.1 }), ui.slider('Reduce Noise:', p, 'noise', 0, 100, u, { unit: '%' }),
    ui.select('Remove:', p, 'remove', [{ value: 'gaussian', label: 'Gaussian Blur' }, { value: 'lens', label: 'Lens Blur' }, { value: 'motion', label: 'Motion Blur' }], u), ui.angle('Angle:', p, 'angle', u),
    h('div.flt-sub', null, 'Shadows / Highlights'), ui.slider('Shadows Fade:', p, 'shadowFade', 0, 100, u, { unit: '%' }), ui.slider('Highlights Fade:', p, 'highlightFade', 0, 100, u, { unit: '%' })),
});
defineFilter({
  id: 'unsharp-mask', label: 'Unsharp Mask', category: 'Sharpen', defaults: () => ({ amount: 100, radius: 1, threshold: 0 }),
  ui: (b, p, u) => b.append(ui.slider('Amount:', p, 'amount', 1, 500, u, { unit: '%' }), ui.slider('Radius:', p, 'radius', 0.1, 1000, u, { unit: 'Pixels', decimals: 1, step: 0.1 }), ui.slider('Threshold:', p, 'threshold', 0, 255, u, { unit: 'levels' })),
});

// ================================================================== Stylize
defineFilter({
  id: 'diffuse', label: 'Diffuse', category: 'Stylize', defaults: () => ({ mode: 'normal' }),
  ui: (b, p, u) => b.append(ui.radios('Mode', p, 'mode', [['normal', 'Normal'], ['darken', 'Darken Only'], ['lighten', 'Lighten Only'], ['anisotropic', 'Anisotropic']], u)),
});
defineFilter({
  id: 'emboss', label: 'Emboss', category: 'Stylize', defaults: () => ({ angle: 135, height: 3, amount: 100 }),
  ui: (b, p, u) => b.append(ui.angle('Angle:', p, 'angle', u), ui.slider('Height:', p, 'height', 1, 100, u, { unit: 'Pixels' }), ui.slider('Amount:', p, 'amount', 1, 500, u, { unit: '%' })),
});
defineFilter({
  id: 'extrude', label: 'Extrude', category: 'Stylize', previewBox: true, defaults: () => ({ type: 'blocks', size: 30, depth: 30, depthMode: 'random', solid: false, maskIncomplete: false }),
  ui: (b, p, u) => b.append(ui.radios('Type', p, 'type', [['blocks', 'Blocks'], ['pyramids', 'Pyramids']], u), ui.number('Size:', p, 'size', u, { min: 2, max: 255, unit: 'Pixels' }), ui.number('Depth:', p, 'depth', u, { min: 1, max: 255 }),
    ui.radios('', p, 'depthMode', [['random', 'Random'], ['level', 'Level-based']], u), ui.check('Solid Front Faces', p, 'solid', u), ui.check('Mask Incomplete Blocks', p, 'maskIncomplete', u)),
});
defineFilter({ id: 'find-edges', label: 'Find Edges', category: 'Stylize', dialog: false, defaults: () => ({}) });
defineFilter({
  id: 'oil-paint', label: 'Oil Paint', category: 'Stylize', width: 660, defaults: () => ({ stylization: 4, cleanliness: 5, scale: 5, bristle: 5, lighting: true, angle: 45, shine: 2 }),
  ui: (b, p, u) => b.append(h('div.flt-sub', null, 'Brush'), ui.slider('Stylization:', p, 'stylization', 0.1, 10, u, { decimals: 1, step: 0.1 }), ui.slider('Cleanliness:', p, 'cleanliness', 0, 10, u, { decimals: 1, step: 0.1 }), ui.slider('Scale:', p, 'scale', 0.1, 10, u, { decimals: 1, step: 0.1 }), ui.slider('Bristle Detail:', p, 'bristle', 0, 10, u, { decimals: 1, step: 0.1 }),
    ui.check('Lighting', p, 'lighting', u), ui.angle('Angle:', p, 'angle', u), ui.slider('Shine:', p, 'shine', 0, 10, u, { decimals: 1, step: 0.1 })),
});
defineFilter({ id: 'solarize', label: 'Solarize', category: 'Stylize', dialog: false, defaults: () => ({}) });
defineFilter({
  id: 'tiles', label: 'Tiles', category: 'Stylize', previewBox: false, defaults: () => ({ count: 10, offset: 10, fill: 'bg' }),
  ui: (b, p, u) => b.append(ui.number('Number Of Tiles:', p, 'count', u, { min: 1, max: 99 }), ui.number('Maximum Offset:', p, 'offset', u, { min: 1, max: 99, unit: '%' }),
    ui.radios('Fill Empty Area With', p, 'fill', [['bg', 'Background Color'], ['fg', 'Foreground Color'], ['inverse', 'Inverse Image'], ['unaltered', 'Unaltered Image']], u)),
});
defineFilter({
  id: 'trace-contour', label: 'Trace Contour', category: 'Stylize', defaults: () => ({ level: 128, edge: 'lower' }),
  ui: (b, p, u) => b.append(ui.slider('Level:', p, 'level', 0, 255, u), ui.radios('Edge', p, 'edge', [['lower', 'Lower'], ['upper', 'Upper']], u)),
});
defineFilter({
  id: 'wind', label: 'Wind', category: 'Stylize', defaults: () => ({ method: 'wind', direction: 'right' }),
  ui: (b, p, u) => b.append(ui.radios('Method', p, 'method', [['wind', 'Wind'], ['blast', 'Blast'], ['stagger', 'Stagger']], u), ui.radios('Direction', p, 'direction', [['right', 'From the Right'], ['left', 'From the Left']], u)),
});

// ================================================================== Video
defineFilter({
  id: 'deinterlace', label: 'De-Interlace', category: 'Video', previewBox: false, defaults: () => ({ eliminate: 'odd', create: 'interpolation' }),
  ui: (b, p, u) => b.append(ui.radios('Eliminate', p, 'eliminate', [['odd', 'Odd Fields'], ['even', 'Even Fields']], u), ui.radios('Create New Fields by', p, 'create', [['duplication', 'Duplication'], ['interpolation', 'Interpolation']], u)),
});
defineFilter({ id: 'ntsc', label: 'NTSC Colors', category: 'Video', dialog: false, defaults: () => ({}) });

// ================================================================== Other
defineFilter({
  id: 'custom', label: 'Custom', category: 'Other', width: 620,
  defaults: () => ({ kernel: [0, 0, 0, 0, 0, 0, 0, -1, 0, 0, 0, -1, 5, -1, 0, 0, 0, -1, 0, 0, 0, 0, 0, 0, 0], scale: 1, offset: 0 }),
  ui(b, p, u) {
    const grid = h('div.flt-grid5');
    p.kernel.forEach((v: number, i: number) => {
      const inp = h('input.field', { type: 'text', value: v ? String(v) : '', title: `Weight ${Math.floor(i / 5) + 1},${(i % 5) + 1}` }) as HTMLInputElement;
      inp.addEventListener('keydown', e => e.stopPropagation());
      inp.addEventListener('change', () => { const n = parseInt(inp.value, 10); p.kernel[i] = Number.isFinite(n) ? Math.max(-999, Math.min(999, n)) : 0; inp.value = p.kernel[i] ? String(p.kernel[i]) : ''; u(); });
      grid.append(inp);
    });
    b.append(grid, ui.number('Scale:', p, 'scale', u, { min: 1, max: 9999 }), ui.number('Offset:', p, 'offset', u, { min: -9999, max: 9999 }));
  },
});
defineFilter({ id: 'high-pass', label: 'High Pass', category: 'Other', defaults: () => ({ radius: 10 }), ui: (b, p, u) => b.append(ui.slider('Radius:', p, 'radius', 0.1, 1000, u, { unit: 'Pixels', decimals: 1, step: 0.1 })) });
defineFilter({
  id: 'hsb-hsl', label: 'HSB/HSL', category: 'Other', previewBox: false, defaults: () => ({ input: 'rgb', output: 'hsb' }),
  ui: (b, p, u) => b.append(ui.radios('Input Mode', p, 'input', [['rgb', 'RGB'], ['hsb', 'HSB'], ['hsl', 'HSL']], u), ui.radios('Row Order', p, 'output', [['rgb', 'RGB'], ['hsb', 'HSB'], ['hsl', 'HSL']], u)),
});
const morphUI = (b: HTMLElement, p: any, u: () => void) => b.append(ui.slider('Radius:', p, 'radius', 0.2, 500, u, { unit: 'Pixels', decimals: 1, step: 0.1 }), ui.select('Preserve:', p, 'preserve', [{ value: 'squareness', label: 'Squareness' }, { value: 'roundness', label: 'Roundness' }], u));
defineFilter({ id: 'maximum', label: 'Maximum', category: 'Other', defaults: () => ({ radius: 1, preserve: 'squareness' }), ui: morphUI });
defineFilter({ id: 'minimum', label: 'Minimum', category: 'Other', defaults: () => ({ radius: 1, preserve: 'squareness' }), ui: morphUI });
defineFilter({
  id: 'offset', label: 'Offset', category: 'Other', defaults: () => ({ h: 100, v: 0, undefined: 'wrap', transparent: false }),
  ui: (b, p, u) => b.append(ui.slider('Horizontal:', p, 'h', -30000, 30000, u, { unit: 'px right', center: 0 }), ui.slider('Vertical:', p, 'v', -30000, 30000, u, { unit: 'px down', center: 0 }),
    ui.radios('Undefined Areas', p, 'undefined', [['bg', 'Set to Background'], ['repeat', 'Repeat Edge Pixels'], ['wrap', 'Wrap Around']], u)),
});

registerCommands([
  { id: 'filter.convertSmart', label: 'Convert for Smart Filters', enabled: () => !!app.activeDoc?.activeLayer, run: () => runCommand('layer.toSmartObject') },
]);
