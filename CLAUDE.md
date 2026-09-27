# Pixora — Photoshop-class image editor in the browser

Vanilla **TypeScript + Vite** (no UI framework), Canvas 2D engine. Goal: an almost identical, fully functional
Photoshop replica (layout, menus, tools, panels, dialogs, shortcuts, behaviour) with a modern, polished look and
excellent performance. The user explicitly wants COMPLETE features — build real, working functionality, not stubs.
Icons are our own SVGs (`src/ui/icons.ts`); never copy Adobe assets or use Adobe/Photoshop branding in the UI
(the app is "Pixora"; menu texts like "About Pixora", "Pixora Help").

Reference screenshot of the target UI (Photoshop, 1918×1138): `docs/reference.png` — Read it to match layouts.

## Cross-module contracts (agreed interfaces between feature areas)
- Shape layers: `layerClasses.shape` (kind 'shape'), props `subpaths: SubPath[]` (doc coords), `fill: {type:'solid'|'gradient'|'pattern'|'none', color?: RGB, gradient?: Gradient, pattern?: string /*pattern id*/, angle?: number, scale?: number}`, `stroke: {enabled: boolean, color: RGB, width: number, align: 'inside'|'center'|'outside', cap?, join?, dash?: number[], opacity?: number}`.
- Text layers: kind 'text'; Smart objects: kind 'smart'; Fill layers: kind 'fill'; Frames: kind 'frame'. Vector-ish layers implement `applyMatrix(m: DOMMatrix)` (affine transform) and `translate(dx,dy)`.
- `runCommand('file.placeEmbedded', { blob?: Blob, name?: string })` places an image as a layer (then free transform).
- `runCommand('select.subject')`, `runCommand('select.sky')`, `runCommand('layer.toSmartObject')`, `runCommand('window.showPanel', id)`.
- History brush source: `(doc.history as any).brushSource ?? 0` = index into `doc.history.snapshots`.
- `doc.extra` keys: `globalLight {angle, altitude}` (layer styles), `notes`, `counts`, `samplers` (measure tools), `slices` (crop/slice), `layerComps`, `comments`, `frames` (view/window), `historySource`.
- Properties panel section ids: 'doc-*' / 'pixel-*' / 'mask' (image-ops), 'adjustment' (adjustments), 'shape' (vector), 'text' (type), 'fill' / 'smart' / 'group' (layers).
- Actions: `runCommand('window.runActionOnDoc', { set, action })`.
- Icons you add: prefix names with your area if generic (`registerIcons({ 'adj-levels': '<path .../>' })`).
- CSS: prefix classes with your module (e.g. `.lp-row` for the layers panel) to avoid collisions.

## Running & checking
- Dev server is ALREADY running at http://localhost:5173 (Vite, HMR). Do not start another one.
- Type check: `npx tsc --noEmit -p .` — filter the output to your own files when others are mid-edit, e.g.
  `npx tsc --noEmit -p . 2>&1 | grep -E "src/(tools/paint|panels/brush)"`. Your files must have ZERO errors.
- Headless browser harness (Edge): `node scripts/shot.mjs --out <png> [--eval "<js>"|--eval-file f.js] [--wait ms] [--clip x,y,w,h]`
  Loads the app, waits for `window.__pixoraReady`, runs your async JS (may `return` a JSON value), saves a
  screenshot, prints console errors/warnings. Use `Read` on the PNG to look at it. Put scratch files (screenshots,
  test scripts) in your scratchpad/temp dir, NOT in the repo. Viewport default 1918×1138 (matches the reference).
- Test handles in the page: `window.__px` = { app, PixDocument, events, layer, brush, commands, compositor, canvas,
  pixelops, registry, dock, filterDialog, widgets }. `app.activeDoc` is a 1890×1417 white doc at start.
  Simulate input by dispatching PointerEvents on `.view-overlay` (the canvas input layer) — e.g.
  `el.dispatchEvent(new PointerEvent('pointerdown', {clientX, clientY, button:0, buttons:1, bubbles:true, pointerId:1}))`
  then `pointermove`/`pointerup`; use `app.viewport.docToScreen(x,y)` + the overlay's bounding rect for coordinates.
  Keyboard: `window.dispatchEvent(new KeyboardEvent('keydown', {key, code, ctrlKey, ...}))`.
- A feature is not done until you have exercised it in the harness, looked at the screenshot, and seen no console errors.

## Layout of the code
```
src/core/      engine (OWNED BY THE LEAD — see "Editing shared files")
  app.ts        app singleton: docs, activeDoc, fg/bg colors, tools (registerTool/setTool), prefs, springTool
  events.ts     typed event bus: events.on('layers'|'activeLayer'|'pixels'|'selection'|'history'|'view'|'colors'|'tool'|...)
  document.ts   PixDocument: layer tree, selection, history, guides, paths, channels, quickMask, view, composite
  layer.ts      Layer base, RasterLayer, GroupLayer, AdjustmentLayer, registerLayerClass, createMask, cloneState
  history.ts    transaction(), begin(), beginPixelEdit()
  selection.ts  Selection (alpha mask canvas, ops, outline)
  compositor.ts updateComposite, renderLayersToCanvas, renderLayerSurface, blendPixels (all PS blend modes)
  viewport.ts   Viewport (zoom/pan/rotate, overlays, pointer dispatch), viewOptions, viewportHooks, drawBrushCursor
  brush.ts      getTip, tintTip, DabSpacer, PaintStroke (stroke buffer; flow/opacity/modes/masks/lock alpha)
  pixelops.ts   editableTarget, applyPixelOp, pixelOpPreview, mergeThroughSelection
  registry.ts   adjustments, filters, propertiesSections, hooks (color picker, gradient editor, transform, text edit,
                layer style, snapping, moveTransform), resources (gradients, patterns, brushes, shapes, styles, swatches)
  path.ts       vector path model (PathPoint/SubPath/VectorPath), toPath2D, rect/ellipse/polygon paths, parseSvgPath, traceAlpha
  gradient.ts   gradientLUT, renderGradient (linear/radial/angle/reflected/diamond)
  presets.ts    default gradients/patterns/brushes/shapes/swatches, resolveGradient (FG→BG etc.)
  color.ts geom.ts canvas.ts units.ts types.ts commands.ts (registerCommand/runCommand/shortcuts)
src/ui/        shell (OWNED BY THE LEAD): dom.ts (h(), dragPointer, isTyping), icons.ts (icon(), registerIcons),
               widgets.ts (checkbox, select, numberField (scrubby), slider, sliderRow, popupSlider, toggleGroup,
               colorSwatch, gradientPicker, patternPicker, section, row, tabs, showPop), menu.ts (openMenu, contextMenu),
               menus-def.ts (THE MENU STRUCTURE + command ids), dialog.ts (openDialog, alert/confirm/promptDialog),
               filter-dialog.ts (filterDialog), brush-picker.ts (brushPicker), dock.ts, panels.ts (registerPanel),
               toolbar.ts (TOOLBAR_LAYOUT slots), optionsbar.ts, workspace.ts (workspaceHooks), cursors.ts (svgCursor, CURSORS),
               toast.ts, shortcuts.ts, tabs.ts
src/tools/ src/panels/ src/commands/ src/adjustments/ src/filters/ src/effects/ src/layers/ src/features/
               FEATURE MODULES — every .ts file here is auto-imported at boot (import.meta.glob in main.ts).
               They self-register (tools, panels, commands, filters…). Worker entry files must be named *.worker.ts.
```

## Editing shared files
Only edit files you own (your task lists them). If a core/ui file truly needs a change, make a MINIMAL additive edit
with the Edit tool (never rewrite/reformat the file, never remove/rename existing exports) and mention it in your
final report. Prefer the existing extension points (hooks, registries, viewportHooks, workspaceHooks, events).
Put your CSS in your own file next to your module (e.g. `src/panels/layers.css`) and `import './layers.css'` from your
module. Use the theme tokens (`var(--bg)`, `--bg-tabbar`, `--bg-input`, `--bg-list`, `--bg-row-selected`, `--border`,
`--text`, `--text-strong`, `--text-dim`, `--accent`, `--checker`, …) so all 4 themes work. Reuse the shared classes
(`.panel-scroll`, `.panel-footer`, `.icon-btn`, `.field`, `.btn`, `.section`, `.form-row`, `.list`, `.thumb`).

## Core rules (read before writing code)
- **Coordinates**: tools receive `ToolPointer` with doc coords `x,y` (float) and screen `sx,sy`. Raster layers have an
  offset (`layer.x, layer.y`) — layer pixel = doc − offset. `layer.ensureRect(rect)` grows the canvas.
- **History** (every user-visible change must be undoable, with the Photoshop history-state name):
  - `doc.history.transaction('Name', () => { ... })` — structural changes. Inside, REPLACE canvases
    (`layer.canvas = newCanvas`), never draw into an existing layer/mask/selection canvas.
  - `const t = doc.history.begin('Move')` … mutate live (drags) … `t.commit()` / `t.cancel()`.
  - In-place painting: `const e = doc.history.beginPixelEdit(holder, 'Name')` … draw into holder.canvas …
    `e.commit('Name', rectInCanvasCoords)`; `e.original` = untouched copy. PaintStroke does this for you.
- **Notify** after changes: `doc.layersChanged()` (tree/props), `doc.pixelsChanged(layer, docRect|null)` (pixels),
  `doc.selectionChanged()` is automatic via Selection methods, `doc.redrawOverlay()` for tool feedback only.
- **Selection**: `doc.selection.mask` (doc-sized canvas, alpha = amount) / `.bounds` / `.empty`; ops create new masks:
  `selectRect/selectEllipse/selectPolygon/selectPath/apply(canvas, op, feather)/selectAll/deselect/invert/setMask`.
  Painting & filters must respect it (PaintStroke and applyPixelOp already do).
- **Paint targets**: `doc.getPaintTarget()` → layer pixels, the layer mask (`doc.editMask`) or Quick Mask. Masks store
  their value in the ALPHA channel (255 = reveal/selected); paint colours map to grey levels.
- **Previews**: set `layer._preview = {canvas,x,y}` (or `mask._preview = canvas`) and `doc.invalidate()` for live
  previews; clear it when done. Never leave previews behind.
- **Layer state**: all persistent state in own enumerable props (serialized + snapshotted); `_prefixed` props are
  transient caches. New layer kinds: subclass `Layer`, implement `getContent(doc)` (cache the rasterization keyed on
  `_version`; call `invalidate()` when props change), override `translate(dx,dy)` if positions aren't `x/y`,
  optionally `applyMatrix(m: DOMMatrix)` for affine transforms, and `registerLayerClass(kind, Ctor)`. Constructors
  must work with no arguments (file loading).
- **Commands**: `registerCommand({ id, run(arg), enabled?(), checked?(), shortcut? })`. Menu items + their shortcuts
  are defined in `src/ui/menus-def.ts` — register the ids listed there for your area (items without a registered
  command show disabled). `runCommand(id, arg)`.
- **Tools**: `app.registerTool({ id, name, group, icon, shortcut, order, settings, cursor, options(bar), activate,
  deactivate, pointerDown/Move/Up, hover, dblclick, keyDown, keyUp, drawOverlay(ctx, view, doc), isModal/commit/cancel,
  paints, altEyedropper, contextMenu })`. `group` must be a slot of `TOOLBAR_LAYOUT` (ui/toolbar.ts). Settings are
  persisted — call `app.saveToolSettings(tool)` after changing them. Options bar = PS options bar for that tool.
  Overlay ctx is SCREEN space: use `view.docToScreen()` / `view.applyDocTransform(ctx)`; `drawBrushCursor()` for brushes.
- **Panels**: `registerPanel({ id, title, icon, create(el) → {onShow,onHide,onResize}, menu() })`. Panel ids are fixed
  (see WINDOW_PANELS in menus-def.ts). Update via events; throttle heavy work (thumbnails) with rAF/debounce.
- **Dialogs**: `openDialog({title, body, buttons, layout:'side'|'bottom', preview})`; `filterDialog()` for filters.
- **Colors**: `app.fg/app.bg` (RGB 0–255), `app.setForeground()`; `hooks.openColorPicker(rgb)`.
- **Performance**: no per-pixel work on the main thread per pointermove unless limited to a small dirty rect; use
  typed arrays / LUTs; batch redraws with requestAnimationFrame; avoid `getImageData` in hot loops; cache
  rasterizations; heavy filters may use a Worker (`new Worker(new URL('./x.worker.ts', import.meta.url), {type:'module'})`).
- **Quality**: no console errors; guard against no-document / locked-layer / empty-selection cases with the
  Photoshop-style message (toast or alertDialog); every button has a `title` tooltip; keyboard shortcuts as in PS.
