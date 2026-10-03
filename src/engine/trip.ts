/**
 * Trip evaluation (methodology 1.5 + 8.3).
 *
 * Segments are traversed in order; time advances by τ_s = length/speed for each.
 * Concentration is sampled at the MIDPOINT time of each segment so that the dose
 * integrates the forecast across the traversal instead of snapping to hour joins.
 */

import { evaluateSegment, resolveParams } from './predict';
import { makeStagnationCache } from './background';
import { addMinutes, toIso, toMs } from './time';
import type {
  CorrectionMap,
  EngineParams,
  EvalContext,
  Forecast,
  Mode,
  Route,
  Segment,
  SegmentEstimate,
  TripEstimate,
  TripInput,
} from '@/contracts';

/** Pre-resolved params/forecast/corrections, so a multi-route pass resolves once. */
export interface SharedEval {
  params: EngineParams;
  forecast: Forecast;
  corrections: CorrectionMap | undefined;
}

/** τ_s in hours. Guarded so a zero/absent speed can never divide by zero. */
export function segmentHours(lengthM: number, speedKmh: number): number {
  const len = Number.isFinite(lengthM) && lengthM > 0 ? lengthM : 0;
  const speed = Number.isFinite(speedKmh) && speedKmh > 0 ? speedKmh : 0;
  if (speed <= 0) return 0;
  return len / 1000 / speed;
}

export interface TripDetail {
  estimate: TripEstimate;
  /** dose per segment id, keyed by segment id (shared segments collapse). */
  doseBySegmentId: Map<string, number>;
}

/**
 * Evaluate a trip. Also returns the per-segment dose table that the Monte Carlo
 * layer needs, so nothing is computed twice.
 */
export function evaluateTripDetail(
  input: TripInput,
  ctx: EvalContext,
  baseCtx?: SharedEval,
): TripDetail {
  const params = baseCtx?.params ?? resolveParams(ctx);
  const forecast = baseCtx?.forecast ?? ctx.forecast;
  const corrections = baseCtx?.corrections ?? ctx.corrections;

  const mode: Mode = input.mode;
  const mp = params.mode[mode] ?? params.mode.walk;
  const stagnationCache = makeStagnationCache(params, forecast);

  const segments: Segment[] = Array.isArray(input.route.segments) ? input.route.segments : [];
  const startMs = toMs(input.departISO);

  const estimates: SegmentEstimate[] = [];
  const doseBySegmentId = new Map<string, number>();

  let elapsedHours = 0;
  let doseUg = 0;
  let concTimeSum = 0;
  let timeSum = 0;
  let confLenSum = 0;
  let lenSum = 0;

  for (const seg of segments) {
    const tauH = segmentHours(seg.lengthM, mp.speedKmh);
    const startISO = toIso(startMs + elapsedHours * 3_600_000);
    // Sample at the midpoint of the traversal: ∫C dt ≈ C(t_mid)·τ.
    const midISO = addMinutes(startISO, tauH * 30);
    const arriveISO = addMinutes(startISO, tauH * 60);

    const ev = evaluateSegment(params, forecast, seg, midISO, corrections, stagnationCache);

    const infiltration = Number.isFinite(mp.infiltration) ? mp.infiltration : 1;
    const ventilation = Number.isFinite(mp.ventilationM3h) ? mp.ventilationM3h : 0;
    const segDose = ev.concentration * infiltration * ventilation * tauH;

    estimates.push({
      segmentId: seg.id,
      arriveISO,
      concentration: ev.concentration,
      multiplier: ev.multiplier,
      deltaLog: ev.deltaLog,
      confidence: ev.confidence,
      sigmaLog: ev.sigmaLog,
      doseUg: segDose,
    });

    doseBySegmentId.set(seg.id, (doseBySegmentId.get(seg.id) ?? 0) + segDose);

    doseUg += segDose;
    concTimeSum += ev.concentration * tauH;
    timeSum += tauH;

    const len = Number.isFinite(seg.lengthM) && seg.lengthM > 0 ? seg.lengthM : 0;
    confLenSum += ev.confidence * len;
    lenSum += len;

    elapsedHours += tauH;
  }

  const durationMin = elapsedHours * 60;
  const meanConcentration = timeSum > 0 ? concTimeSum / timeSum : 0;
  const confidence = lenSum > 0 ? confLenSum / lenSum : 0;

  const refDose = Number.isFinite(params.refDailyDoseUg) && params.refDailyDoseUg > 0 ? params.refDailyDoseUg : 1;
  const cigUnit =
    Number.isFinite(params.cigaretteUgM3Day) && params.cigaretteUgM3Day > 0 &&
    Number.isFinite(params.dailyAirM3) && params.dailyAirM3 > 0
      ? params.cigaretteUgM3Day * params.dailyAirM3
      : 1;

  const estimate: TripEstimate = {
    routeId: input.route.id,
    mode,
    departISO: input.departISO,
    durationMin: Number.isFinite(durationMin) ? durationMin : 0,
    doseUg: Number.isFinite(doseUg) ? doseUg : 0,
    meanConcentration: Number.isFinite(meanConcentration) ? meanConcentration : 0,
    confidence: Number.isFinite(confidence) ? Math.min(1, Math.max(0, confidence)) : 0,
    refDosePct: Number.isFinite(doseUg) ? (doseUg / refDose) * 100 : 0,
    cigaretteEq: Number.isFinite(doseUg) ? doseUg / cigUnit : 0,
    segments: estimates,
  };

  return { estimate, doseBySegmentId };
}

/** Public contract entry point. */
export function evaluateTrip(input: TripInput, ctx: EvalContext): TripEstimate {
  return evaluateTripDetail(input, ctx).estimate;
}
