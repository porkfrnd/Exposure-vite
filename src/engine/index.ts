/**
 * EXPOSURE VITE — ENGINE (public surface)
 * ================================================================
 * Pure, deterministic. Imports only "@/contracts". No Date.now(), no Math.random(),
 * no network, no filesystem. Every parameter that is a guess is ASSUMED and is
 * marked as such at its definition in ./params.ts.
 */

import { defaultEngineParams } from './params';
import { predictUncorrected, resolveParams } from './predict';
import { evaluateTrip as evaluateTripImpl } from './trip';
import { compareRoutes as compareRoutesImpl } from './compare';
import { departureSweep as departureSweepImpl } from './sweep';
import { sensitivity as sensitivityImpl } from './sensitivity';
import { schoolWindow as schoolWindowImpl } from './school';
import type { EngineApi, EngineParams, EvalContext, Segment } from '@/contracts';

/**
 * The default parameter set. Every value is an ASSUMED starting guess; this object
 * is reproduced verbatim in the in-app Assumptions table.
 */
export const DEFAULT_ENGINE_PARAMS: EngineParams = defaultEngineParams();

function assertSegment(segment: Segment): void {
  if (!segment || typeof segment !== 'object') {
    throw new Error('engine: segment is required');
  }
}

export const engine: EngineApi = {
  defaultParams() {
    return defaultEngineParams();
  },

  /** Uncorrected model prediction: C_bg · m'. The data layer uses this as PredictFn. */
  predict(segment: Segment, timeISO: string, ctx: EvalContext) {
    assertSegment(segment);
    if (!ctx || !ctx.forecast) throw new Error('engine.predict: ctx.forecast is required');
    return predictUncorrected(resolveParams(ctx), ctx.forecast, segment, timeISO);
  },

  evaluateTrip(input, ctx) {
    if (!ctx || !ctx.forecast) throw new Error('engine.evaluateTrip: ctx.forecast is required');
    return evaluateTripImpl(input, ctx);
  },

  compareRoutes(routes, baselineRouteId, mode, departISO, ctx, opts) {
    if (!ctx || !ctx.forecast) throw new Error('engine.compareRoutes: ctx.forecast is required');
    return compareRoutesImpl(routes, baselineRouteId, mode, departISO, ctx, opts);
  },

  departureSweep(routes, baselineRouteId, mode, startISO, offsetsMin, ctx, correctionsAt) {
    if (!ctx || !ctx.forecast) throw new Error('engine.departureSweep: ctx.forecast is required');
    return departureSweepImpl(
      routes,
      baselineRouteId,
      mode,
      startISO,
      offsetsMin,
      ctx,
      correctionsAt,
    );
  },

  sensitivity(routes, mode, departISO, ctx, scales) {
    if (!ctx || !ctx.forecast) throw new Error('engine.sensitivity: ctx.forecast is required');
    return sensitivityImpl(routes, mode, departISO, ctx, scales);
  },

  schoolWindow(schoolSegment, dayStartISO, activity, ctx) {
    if (!ctx || !ctx.forecast) throw new Error('engine.schoolWindow: ctx.forecast is required');
    return schoolWindowImpl(schoolSegment, dayStartISO, activity, ctx);
  },
};
