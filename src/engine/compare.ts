/**
 * Route comparison and the recommendation verdict (methodology 3.3).
 *
 * INTEGRITY: this module decides whether the app is ALLOWED to speak. The default
 * behaviour when the difference is not robust is "no meaningful difference".
 */

import { resolveParams } from './predict';
import { evaluateTripDetail } from './trip';
import type { SharedEval } from './trip';
import { medianOf } from './rng';
import {
  DEFAULT_DRAWS,
  DEFAULT_SEED,
  buildDrawTable,
  deltaESamples,
  leadHoursFrom,
  pBetter,
  runDraws,
  sigmaBgAtLead,
} from './montecarlo';
import type {
  Comparison,
  EngineParams,
  EvalContext,
  Forecast,
  CorrectionMap,
  Mode,
  Route,
  RouteVersus,
  TripEstimate,
  Verdict,
} from '@/contracts';

/** Verdict thresholds come from ASSUMED design choices in EngineParams.decision. */
export function verdictFor(
  params: EngineParams,
  medianDeltaE: number,
  pBetterValue: number,
): Verdict {
  const { pRecommend, minDeltaE, pSlight } = params.decision;
  if (pBetterValue >= pRecommend && medianDeltaE >= minDeltaE) return 'recommend';
  if (pBetterValue >= pSlight && medianDeltaE > 0) return 'slight';
  return 'none';
}

/** Percentage string for a fraction, rounded to a whole percent. */
export function pctOf(fraction: number): number {
  if (!Number.isFinite(fraction)) return 0;
  return Math.round(fraction * 100);
}

/**
 * Plain-language summary. Uses "modeled estimate" wording and never makes a
 * health or safety claim.
 */
export function comparisonMessage(
  best: RouteVersus | undefined,
  bestRouteId: string | null,
  nameOf: (id: string) => string,
  baselineName: string,
  verdictOfBest: Verdict,
): string {
  if (!best || bestRouteId === null) {
    return 'No meaningful difference between these routes in this model. Choose by convenience.';
  }
  const pct = pctOf(best.medianDeltaE);
  const agree = pctOf(best.pBetter);
  const name = nameOf(best.routeId);

  if (verdictOfBest === 'recommend') {
    return `Modeled estimate: ${name} has about ${pct}% lower exposure than ${baselineName} (${agree}% of simulations agree).`;
  }
  if (verdictOfBest === 'slight') {
    return `Slight edge to ${name} (about ${pct}% lower), low confidence.`;
  }
  return 'No meaningful difference between these routes in this model. Choose by convenience.';
}

export interface CompareOptions {
  draws?: number;
  seed?: number;
}

export function compareRoutes(
  routes: Route[],
  baselineRouteId: string,
  mode: Mode,
  departISO: string,
  ctx: EvalContext,
  opts?: CompareOptions,
): Comparison {
  const safeRoutes = Array.isArray(routes) ? routes : [];
  const params = resolveParams(ctx);
  const forecast: Forecast = ctx.forecast;
  const corrections: CorrectionMap | undefined = ctx.corrections;

  const baseCtx: SharedEval = { params, forecast, corrections };

  const details = safeRoutes.map((route) =>
    evaluateTripDetail({ route, mode, departISO }, ctx, baseCtx),
  );
  const trips: TripEstimate[] = details.map((d) => d.estimate);

  const baseIdx = safeRoutes.findIndex((r) => r.id === baselineRouteId);
  const optDraws = opts?.draws;
  const optSeed = opts?.seed;
  const draws = Math.max(1, Math.floor(Number.isFinite(optDraws) ? (optDraws as number) : DEFAULT_DRAWS));
  const seed = Number.isFinite(optSeed) ? (optSeed as number) : (ctx.seed ?? DEFAULT_SEED);

  if (baseIdx < 0) {
    // No valid baseline: we cannot form a comparison, so we say nothing.
    return {
      departISO,
      mode,
      baselineRouteId,
      trips,
      versus: [],
      bestRouteId: null,
      message: 'No meaningful difference between these routes in this model. Choose by convenience.',
      draws,
    };
  }

  const table = buildDrawTable(
    details.map((d) => d.estimate.segments),
    safeRoutes.map((r) => r.id),
  );
  const lead = leadHoursFrom(forecast.fetchedAtISO, departISO);
  const sigmaBg = sigmaBgAtLead(params, lead);
  const result = runDraws(table, sigmaBg, draws, seed);

  const baseRow = result.draws[baseIdx];
  const nameOf = (id: string) => safeRoutes.find((r) => r.id === id)?.name ?? id;
  const baselineName = nameOf(baselineRouteId);

  const versus: RouteVersus[] = [];
  safeRoutes.forEach((route, i) => {
    if (i === baseIdx) return;
    const dE = deltaESamples(baseRow, result.draws[i]);
    const medianDeltaE = medianOf(dE);
    const pB = pBetter(baseRow, result.draws[i]);
    versus.push({
      routeId: route.id,
      medianDeltaE,
      pBetter: pB,
      verdict: verdictFor(params, medianDeltaE, pB),
    });
  });

  let bestRouteId: string | null = null;
  let bestEntry: RouteVersus | undefined;
  for (const v of versus) {
    if (v.verdict === 'none') continue;
    if (!bestEntry || v.medianDeltaE > bestEntry.medianDeltaE) {
      bestEntry = v;
      bestRouteId = v.routeId;
    }
  }

  // Fall back to showing a "slight" result when nothing reached 'recommend', so the
  // UI can still surface a low-confidence lean without overstating it.
  const headline = bestEntry ?? versus.find((v) => v.verdict === 'slight');

  return {
    departISO,
    mode,
    baselineRouteId,
    trips,
    versus,
    bestRouteId,
    message: comparisonMessage(
      headline,
      headline ? headline.routeId : null,
      nameOf,
      baselineName,
      headline?.verdict ?? 'none',
    ),
    draws,
  };
}
