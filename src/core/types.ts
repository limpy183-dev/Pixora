// Shared primitive types used across Pixora.

export interface Point { x: number; y: number }
export interface Rect { x: number; y: number; w: number; h: number }
export interface RGB { r: number; g: number; b: number }          // 0..255 ints
export interface RGBA extends RGB { a: number }                     // a: 0..1

export type BlendMode =
  | 'pass-through'
  | 'normal' | 'dissolve'
  | 'darken' | 'multiply' | 'color-burn' | 'linear-burn' | 'darker-color'
  | 'lighten' | 'screen' | 'color-dodge' | 'linear-dodge' | 'lighter-color'
  | 'overlay' | 'soft-light' | 'hard-light' | 'vivid-light' | 'linear-light' | 'pin-light' | 'hard-mix'
  | 'difference' | 'exclusion' | 'subtract' | 'divide'
  | 'hue' | 'saturation' | 'color' | 'luminosity';

/** Photoshop blend mode menu, '-' = separator. */
export const BLEND_MODE_MENU: (BlendMode | '-')[] = [
  'normal', 'dissolve', '-',
  'darken', 'multiply', 'color-burn', 'linear-burn', 'darker-color', '-',
  'lighten', 'screen', 'color-dodge', 'linear-dodge', 'lighter-color', '-',
  'overlay', 'soft-light', 'hard-light', 'vivid-light', 'linear-light', 'pin-light', 'hard-mix', '-',
  'difference', 'exclusion', 'subtract', 'divide', '-',
  'hue', 'saturation', 'color', 'luminosity',
];

export const BLEND_MODE_LABELS: Record<BlendMode, string> = {
  'pass-through': 'Pass Through', normal: 'Normal', dissolve: 'Dissolve',
  darken: 'Darken', multiply: 'Multiply', 'color-burn': 'Color Burn', 'linear-burn': 'Linear Burn', 'darker-color': 'Darker Color',
  lighten: 'Lighten', screen: 'Screen', 'color-dodge': 'Color Dodge', 'linear-dodge': 'Linear Dodge (Add)', 'lighter-color': 'Lighter Color',
  overlay: 'Overlay', 'soft-light': 'Soft Light', 'hard-light': 'Hard Light', 'vivid-light': 'Vivid Light', 'linear-light': 'Linear Light', 'pin-light': 'Pin Light', 'hard-mix': 'Hard Mix',
  difference: 'Difference', exclusion: 'Exclusion', subtract: 'Subtract', divide: 'Divide',
  hue: 'Hue', saturation: 'Saturation', color: 'Color', luminosity: 'Luminosity',
};

/** Selection combine operation (New / Add / Subtract / Intersect). */
export type SelectOp = 'replace' | 'add' | 'subtract' | 'intersect';

export interface GradientStop { pos: number; color: RGB; mid?: number }       // pos 0..1; mid = midpoint (0..1) of the segment to the next stop (default .5)
export interface OpacityStop { pos: number; opacity: number; mid?: number }   // opacity 0..1
export interface Gradient {
  name: string;
  stops: GradientStop[];
  opacityStops: OpacityStop[];
  smoothness?: number;                                             // 0..1 (default 1)
}
export type GradientShape = 'linear' | 'radial' | 'angle' | 'reflected' | 'diamond';

export interface Pattern { id: string; name: string; canvas: HTMLCanvasElement }

export type LayerKind = 'raster' | 'text' | 'shape' | 'adjustment' | 'fill' | 'group' | 'smart';

export interface LayerLocks { transparency: boolean; pixels: boolean; position: boolean; artboard: boolean; all: boolean }

/** Layer mask: alpha of `canvas` is the mask value (255 = reveal). Outside the canvas the value is `bg`. */
export interface LayerMask {
  canvas: HTMLCanvasElement;
  x: number; y: number;
  bg: 0 | 255;
  enabled: boolean;
  linked: boolean;
  density: number;   // 0..1
  feather: number;   // px
}

export type EffectType =
  | 'dropShadow' | 'innerShadow' | 'outerGlow' | 'innerGlow' | 'bevelEmboss'
  | 'satin' | 'colorOverlay' | 'gradientOverlay' | 'patternOverlay' | 'stroke';

/** A layer style effect. Extra parameters are effect specific (see src/effects). */
export interface LayerEffect { type: EffectType; enabled: boolean; [key: string]: any }

export type ColorMode = 'RGB' | 'Grayscale' | 'CMYK' | 'Lab' | 'Indexed' | 'Bitmap' | 'Duotone' | 'Multichannel';
