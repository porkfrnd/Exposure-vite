/**
 * Segment prediction: background × street multiplier × evidence correction.
 */

import { defaultEngineParams, mergeParams } from './params';
import { backgroundAt, makeStagnationCache, stagnationIndex } from './background';
import type { StagnationCache } from './background';
import { amplifiedMultiplier, priorMultiplier } from './multiplier';
import { sampleForecast } from './interp';
import type {
  CorrectionMap,
  EngineParams,
  EvalContext,
  Forecast,
  Segment,
  SegmentCorrection,
} from '@/contracts';

// Pristine default parameter set, built once. Callers always receive a merged
// copy, so the singleton can never be mutated by user code.
const DEFAULT_PARAMS: EngineParams = defaultEngineParams();

/** Full parameter set for a context (defaults deep-merged with any override). */
export function resolveParams(ctx: EvalContext): EngineParams {
  return ctx.params ? mergeParams(DEFAULT_PARAMS, ctx.params) : DEFAULT_PARAMS;
}

/** The untouched default parameter set. Treat as read-only. */
export function baseParams(): EngineParams {
  return DEFAULT_PARAMS;
}

/** Default log-sigma for an uncorrected segment: sqrt(prior² + floor²). */
export function defaultSegmentSigma(params: EngineParams): number {
  const p = Number.isFinite(params.priorSigmaLog) ? params.priorSigmaLog : 0;
  const f = Number.isFinite(params.floorSigmaLog) ? params.floorSigmaLog : 0;
  return Math.sqrt(p * p + f * f);
}

export interface SegmentEvaluation {
  concentration: number; // corrected, µg/m³
  multiplier: number; // m'
  deltaLog: number;
  confidence: number;
  sigmaLog: number;
}

/**
 * Full (corrected) segment state at an instant.
 * A missing correction key means: no evidence shift, zero confidence, default prior sigma.
 */
export function evaluateSegment(
  params: EngineParams,
  forecast: Forecast,
  segment: Segment,
  iso: string,
  corrections: CorrectionMap | undefined,
  stagnationCache?: StagnationCache,
): SegmentEvaluation {
  const point = sampleForecast(forecast, iso);
  const s = stagnationIndex(
    params,
    forecast,
    point,
    stagnationCache ?? makeStagnationCache(params, forecast),
  );
  const m = amplifiedMultiplier(priorMultiplier(params, segment, iso), s, params.stagnation.alpha);
  const cBg = backgroundAt(params, point);

  const correction: SegmentCorrection | undefined = corrections?.[segment.id];

  const deltaLog = correction && Number.isFinite(correction.deltaLog) ? correction.deltaLog : 0;
  const confidence =
    correction && Number.isFinite(correction.confidence)
      ? Math.min(1, Math.max(0, correction.confidence))
      : 0;
  const sigmaLog =
    correction && Number.isFinite(correction.sigmaLog) && correction.sigmaLog >= 0
      ? correction.sigmaLog
      : defaultSegmentSigma(params);

  const concentration = cBg * m * Math.exp(deltaLog);

  return {
    concentration: Number.isFinite(concentration) ? Math.max(0, concentration) : 0,
    multiplier: m,
    deltaLog,
    confidence,
    sigmaLog,
  };
}

/**
 * The UNCORRECTED model prediction at an instant (methodology: C_bg · m').
 * The data layer consumes this as its PredictFn, so corrections computed there
 * are genuinely relative to this value.
 */
export function predictUncorrected(
  params: EngineParams,
  forecast: Forecast,
  segment: Segment,
  iso: string,
): { concentration: number; sigmaLog: number } {
  const point = sampleForecast(forecast, iso);
  const s = stagnationIndex(params, forecast, point);
  const m = amplifiedMultiplier(priorMultiplier(params, segment, iso), s, params.stagnation.alpha);
  const concentration = backgroundAt(params, point) * m;
  return {
    concentration: Number.isFinite(concentration) ? Math.max(0, concentration) : 0,
    sigmaLog: defaultSegmentSigma(params),
  };
}
