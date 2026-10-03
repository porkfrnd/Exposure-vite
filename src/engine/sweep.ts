/**
 * Departure-time sweep (methodology 1.7).
 */

import { compareRoutes } from './compare';
import { addMinutes } from './time';
import type {
  Comparison,
  CorrectionMap,
  EvalContext,
  Mode,
  Route,
  SweepPoint,
} from '@/contracts';

export interface SweepOptions {
  draws?: number;
}

export function departureSweep(
  routes: Route[],
  baselineRouteId: string,
  mode: Mode,
  startISO: string,
  offsetsMin: number[],
  ctx: EvalContext,
  correctionsAt?: (departISO: string) => CorrectionMap | undefined,
): SweepPoint[] {
  const offsets = Array.isArray(offsetsMin) ? offsetsMin : [0];
  const draws = Number.isFinite(ctx.draws) ? (ctx.draws as number) : undefined;
  return offsets.map((offsetMin) => {
    const departISO = addMinutes(startISO, offsetMin);
    // Per-offset corrections override the static map; a nullish value falls back to ctx.
    const perOffset = correctionsAt ? correctionsAt(departISO) : undefined;
    const pointCtx: EvalContext = {
      ...ctx,
      corrections: perOffset ?? ctx.corrections,
    };
    const comparison: Comparison = compareRoutes(
      routes,
      baselineRouteId,
      mode,
      departISO,
      pointCtx,
      draws === undefined ? undefined : { draws },
    );
    return { offsetMin, departISO, comparison };
  });
}
