/**
 * Relative-exposure colour ramp for the map and the legend.
 *
 * Colour is NORMALISED MIN→MAX over the segments actually on screen, so the map
 * always shows contrast within the current view rather than a fixed absolute scale
 * (which would make every route look identical on a bad-pollution day).
 *
 * Colour is never the only signal: the recommended route is thicker, non-candidates
 * are dimmed, and low-confidence segments are dashed (see MapView).
 */

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

/** Green → yellow → red, chosen so the two ends stay distinguishable in both themes. */
const STOPS: Array<{ t: number; c: Rgb }> = [
  { t: 0.0, c: { r: 16, g: 185, b: 129 } }, // emerald-500  (lower exposure)
  { t: 0.35, c: { r: 132, g: 204, b: 22 } }, // lime-500
  { t: 0.55, c: { r: 250, g: 204, b: 21 } }, // yellow-400
  { t: 0.78, c: { r: 249, g: 115, b: 22 } }, // orange-500
  { t: 1.0, c: { r: 220, g: 38, b: 38 } }, // red-600     (higher exposure)
];

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Sample the ramp at t ∈ [0,1]. */
export function rampColor(t: number): string {
  const clamped = Number.isFinite(t) ? Math.min(1, Math.max(0, t)) : 0;
  for (let i = 1; i < STOPS.length; i++) {
    const prev = STOPS[i - 1];
    const next = STOPS[i];
    if (clamped <= next.t) {
      const span = next.t - prev.t;
      const local = span <= 0 ? 0 : (clamped - prev.t) / span;
      return `rgb(${Math.round(lerp(prev.c.r, next.c.r, local))}, ${Math.round(
        lerp(prev.c.g, next.c.g, local),
      )}, ${Math.round(lerp(prev.c.b, next.c.b, local))})`;
    }
  }
  const last = STOPS[STOPS.length - 1];
  return `rgb(${last.c.r}, ${last.c.g}, ${last.c.b})`;
}

/**
 * Map a value onto the ramp given the min/max of the values on screen.
 * A zero-width range collapses to the middle of the ramp rather than the green end,
 * so "all segments equal" is visually neutral instead of looking reassuring.
 */
export function exposureColor(value: number, min: number, max: number): string {
  if (!Number.isFinite(value)) return rampColor(0.5);
  if (!Number.isFinite(min) || !Number.isFinite(max) || max - min < 1e-9) {
    return rampColor(0.5);
  }
  return rampColor((value - min) / (max - min));
}

/** Min/max over a record of numeric values, ignoring non-finite entries. */
export function extentOf(values: number[]): { min: number; max: number } {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const v of values) {
    if (!Number.isFinite(v)) continue;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) return { min: 0, max: 1 };
  return { min, max };
}

/** Legend gradient CSS. */
export const RAMP_GRADIENT = `linear-gradient(to right, ${STOPS.map((s) => rampColor(s.t)).join(', ')})`;
