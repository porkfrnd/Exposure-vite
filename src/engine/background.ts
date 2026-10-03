/**
 * Background concentration and the stagnation index (methodology 1.1 and 1.3).
 */

import { median, sortedHours } from './time';
import { sampleForecast } from './interp';
import type { EngineParams, Forecast, HourlyPoint } from '@/contracts';

/** ASSUMED hard floor so a negative or zero forecast can never produce a non-positive µ value. */
export const BACKGROUND_FLOOR_UGM3 = 1;

/** C_bg(t) = max(floor, a·pm25(t) + b). Always finite and > 0. */
export function backgroundAt(params: EngineParams, point: HourlyPoint): number {
  const pm = Number.isFinite(point.pm25) ? point.pm25 : 0;
  const raw = params.bias.a * pm + params.bias.b;
  if (!Number.isFinite(raw)) return BACKGROUND_FLOOR_UGM3;
  return Math.max(BACKGROUND_FLOOR_UGM3, raw);
}

/** Background at an instant. */
export function backgroundAtISO(params: EngineParams, forecast: Forecast, iso: string): number {
  return backgroundAt(params, sampleForecast(forecast, iso));
}

/**
 * Reference boundary-layer height / wind speed. Explicit params win; otherwise the
 * median over the forecast window is used (methodology 1.3). Falls back to 1 when
 * the forecast reports no boundary-layer height at all, which makes S ≡ 1.
 */
export function stagnationReferences(
  params: EngineParams,
  forecast: Forecast,
): { hRef: number; uRef: number } {
  const hours = sortedHours(forecast);
  const blhValues = hours.map((h) => h.blhM).filter((v): v is number => v !== null && Number.isFinite(v) && v > 0);
  const windValues = hours.map((h) => h.windMs).filter((v) => Number.isFinite(v) && v > 0);

  const hRef = params.stagnation.hRef ?? (median(blhValues) ?? 1);
  const uRef = params.stagnation.uRef ?? (median(windValues) ?? 1);

  return {
    hRef: Number.isFinite(hRef) && hRef > 0 ? hRef : 1,
    uRef: Number.isFinite(uRef) && uRef > 0 ? uRef : 1,
  };
}

/**
 * Stagnation index
 *   S(t) = clamp( (hRef / H(t)) · (uRef / max(u(t), uMin)), clampMin, clampMax )
 * If the boundary-layer height is unknown at this instant, S = 1.
 */
export function stagnationIndex(
  params: EngineParams,
  forecast: Forecast,
  point: HourlyPoint,
  refs?: { hRef: number; uRef: number },
): number {
  const { hRef, uRef } = refs ?? stagnationReferences(params, forecast);
  const { clampMin, clampMax, uMin } = params.stagnation;

  const blh = point.blhM;
  if (blh === null || !Number.isFinite(blh) || blh <= 0) return 1;

  const wind = Number.isFinite(point.windMs) ? point.windMs : 0;
  const windSafe = Math.max(Math.abs(wind), uMin > 0 ? uMin : 0.5);

  const raw = (hRef / blh) * (uRef / windSafe);
  if (!Number.isFinite(raw)) return 1;

  return Math.min(clampMax, Math.max(clampMin, raw));
}

/** Cached stagnation reference pair for a forecast/params pair. */
export type StagnationCache = { hRef: number; uRef: number };

export function makeStagnationCache(params: EngineParams, forecast: Forecast): StagnationCache {
  return stagnationReferences(params, forecast);
}
