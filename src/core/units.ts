// Unit conversion (Image Size, Canvas Size, New Document, Properties, rulers).
export type Unit = 'px' | 'in' | 'cm' | 'mm' | 'pt' | 'pica' | '%';
export const UNIT_LABELS: Record<Unit, string> = { px: 'Pixels', in: 'Inches', cm: 'Centimeters', mm: 'Millimeters', pt: 'Points', pica: 'Picas', '%': 'Percent' };

/** Convert a value in `unit` to pixels. `res` = pixels per inch. `ref` = reference px for percent. */
export function toPx(v: number, unit: Unit, res: number, ref = 0): number {
  switch (unit) {
    case 'in': return v * res;
    case 'cm': return (v * res) / 2.54;
    case 'mm': return (v * res) / 25.4;
    case 'pt': return (v * res) / 72;
    case 'pica': return (v * res) / 6;
    case '%': return (v / 100) * ref;
    default: return v;
  }
}
export function fromPx(px: number, unit: Unit, res: number, ref = 0): number {
  switch (unit) {
    case 'in': return px / res;
    case 'cm': return (px / res) * 2.54;
    case 'mm': return (px / res) * 25.4;
    case 'pt': return (px / res) * 72;
    case 'pica': return (px / res) * 6;
    case '%': return ref ? (px / ref) * 100 : 100;
    default: return px;
  }
}
export const unitDecimals = (u: Unit) => (u === 'px' ? 0 : u === '%' ? 2 : u === 'mm' || u === 'pt' ? 1 : 3);
/** Format a pixel value in a unit, e.g. "16.002 cm". */
export function fmtUnit(px: number, unit: Unit, res: number, ref = 0): string {
  const v = fromPx(px, unit, res, ref), d = unitDecimals(unit);
  return `${d ? v.toFixed(d).replace(/\.?0+$/, '') : Math.round(v)} ${unit === 'pica' ? 'pica' : unit}`;
}
