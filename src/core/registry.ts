// Shared registries & hooks that feature modules plug into.
import type { Gradient, Pattern, RGB } from './types';
import type { Layer, LayerContent } from './layer';
import type { PixDocument } from './document';

// ------------------------------------------------------------------ adjustments
export interface AdjustmentContext { doc: PixDocument; rect: { x: number; y: number; w: number; h: number } }
export interface AdjustmentDef {
  type: string;                 // e.g. 'levels'
  label: string;                // 'Levels'
  icon?: string;                // icon name
  defaults(): any;
  /** Modify RGBA pixels in place. Alpha must be preserved. */
  apply(img: ImageData, params: any, ctx: AdjustmentContext): void;
  /** Build the parameter UI (used by the Image > Adjustments dialog and the Properties panel for adjustment layers).
   *  Call onChange(params) after each edit. May return a cleanup fn. */
  ui?(container: HTMLElement, params: any, onChange: (params: any) => void, doc: PixDocument | null): void | (() => void);
}
export const adjustments: Record<string, AdjustmentDef> = {};
export function registerAdjustment(def: AdjustmentDef) { adjustments[def.type] = def; }

// ------------------------------------------------------------------ properties panel sections
export interface PropertiesSection {
  id: string;
  title: string;
  order?: number;
  /** Section applies to this context (layer may be null → document properties). */
  match(doc: PixDocument, layer: Layer | null): boolean;
  /** Build UI into container; return cleanup fn. Rebuilt when the active layer changes. */
  build(container: HTMLElement, doc: PixDocument, layer: Layer | null): void | (() => void);
}
export const propertiesSections: PropertiesSection[] = [];
export function registerPropertiesSection(s: PropertiesSection) {
  const i = propertiesSections.findIndex(x => x.id === s.id);
  if (i >= 0) propertiesSections.splice(i, 1);
  propertiesSections.push(s);
  propertiesSections.sort((a, b) => (a.order ?? 50) - (b.order ?? 50));
}

// ------------------------------------------------------------------ hooks (overridable implementations)
export type EffectsRenderer = (layer: Layer, content: LayerContent, doc: PixDocument) => LayerContent | null;

export const hooks = {
  /** Renders layer styles. Receives the layer content (with layer mask NOT applied), returns content+effects
   *  as one canvas in doc coords. Must honour layer.fillOpacity for the content itself. */
  effectsRenderer: null as EffectsRenderer | null,

  /** Photoshop Color Picker dialog. Resolves null on cancel. Replaced by the color module. */
  openColorPicker: (initial: RGB, _title = 'Color Picker'): Promise<RGB | null> =>
    new Promise(resolve => {
      const inp = document.createElement('input');
      inp.type = 'color';
      inp.value = '#' + [initial.r, initial.g, initial.b].map(v => v.toString(16).padStart(2, '0')).join('');
      inp.onchange = () => { const n = parseInt(inp.value.slice(1), 16); resolve({ r: n >> 16, g: (n >> 8) & 255, b: n & 255 }); };
      inp.oncancel = () => resolve(null);
      inp.click();
    }),

  /** Gradient Editor dialog. Resolves null on cancel. Replaced by the gradient module. */
  openGradientEditor: async (g: Gradient): Promise<Gradient | null> => g,

  /** Enter free-transform on the current layer(s)/selection. Replaced by the transform module. */
  startFreeTransform: (_mode?: string): void => {},

  /** Start editing a text layer (double click in Layers panel). Replaced by the type module. */
  editTextLayer: (_layer: Layer): void => {},

  /** Show the layer style dialog for a layer, optionally focusing an effect type. */
  openLayerStyle: (_layer: Layer, _effect?: string): void => {},

  /** Snap a moving rectangle (doc coords) to guides / grid / layers / bounds. Returns the correction to apply.
   *  Replaced by the view module (smart guides may be drawn from `guides`). */
  snapRect: (_r: { x: number; y: number; w: number; h: number }, _doc: PixDocument, _exclude?: Layer[]): { dx: number; dy: number } => ({ dx: 0, dy: 0 }),
  /** Snap a point (doc coords). */
  snapPoint: (p: { x: number; y: number }, _doc: PixDocument): { x: number; y: number } => p,

  /** Advanced blending (Blend If): adjust a layer's surface alpha against the backdrop before it is blended. */
  beforeBlend: null as null | {
    needs(layer: Layer): boolean;
    apply(layer: Layer, surface: HTMLCanvasElement, backdrop: CanvasRenderingContext2D, R: { x: number; y: number; w: number; h: number }): void;
  },

  /** Move tool "Show Transform Controls" integration (installed by the transform module). */
  moveTransform: null as null | {
    draw(ctx: CanvasRenderingContext2D, view: any, doc: PixDocument): void;
    /** Return true if the pointer hit a handle and the transform module takes over this drag. */
    pointerDown(p: any, doc: PixDocument): boolean;
    pointerMove(p: any, doc: PixDocument): void;
    pointerUp(p: any, doc: PixDocument): void;
    /** Cursor for hover position, or null. */
    cursor(p: any, doc: PixDocument): string | null;
  },
};

// ------------------------------------------------------------------ shared resources (presets)
export interface BrushPreset {
  id: string; name: string;
  size: number; hardness: number;          // hardness 0..1
  spacing?: number; roundness?: number; angle?: number;
  tip?: HTMLCanvasElement | null;          // sampled tip (grayscale alpha); null = computed round tip
  scatter?: number; sizeJitter?: number; angleJitter?: number; opacityJitter?: number;
}
export interface CustomShape { id: string; name: string; path: string /* SVG path data, 0..100 box */ }
export interface StylePreset { id: string; name: string; effects: any[] }

export const resources = {
  gradients: [] as Gradient[],
  patterns: [] as Pattern[],
  brushes: [] as BrushPreset[],
  shapes: [] as CustomShape[],
  styles: [] as StylePreset[],
  swatches: [] as { name: string; color: RGB; group?: string }[],
  recentColors: [] as RGB[],
};

// ------------------------------------------------------------------ filters (Filter menu)
export interface FilterDef {
  id: string;            // e.g. 'gaussian-blur' (menu items call runCommand('filter.run', id))
  label: string;         // 'Gaussian Blur'
  category?: string;     // 'Blur'
  /**
   * Run the filter on app.activeDoc. When opts.params is given (Filter › Last Filter) apply directly without a dialog.
   * Resolve with the params used (stored for Last Filter), or null/undefined if cancelled.
   */
  run(doc: PixDocument, opts: { params?: any }): Promise<any> | any;
}
export const filters: Record<string, FilterDef> = {};
export function registerFilter(def: FilterDef) { filters[def.id] = def; }
