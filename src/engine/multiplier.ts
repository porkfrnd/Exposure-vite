/**
 * Street multiplier (methodology 1.2 + 8.2).
 *
 * The prior is pure geometry plus an assumed near-road gradient:
 *
 *   m  = 1 + e_own · rush(own)
 *          + Σ_r  e_{class(r)} · rush(class(r)) · exp(−d_r / λ)
 *          − e_g · greenFraction
 *   m  = clamp(m, 0.5, 3)
 *   m' = max(0.3, 1 + (m − 1) · S(t)^α)
 *
 * Departure recording (assumption, documented in PROGRESS.md): rush is evaluated
 * at the whole LOCAL hour that contains the sample instant. The engine's own spec
 * listed [7,8,9,16,17,18] as its ASSUMED morning band, which overrides the wider
 * [7,10] ∪ [16,19] band in methodology 1.2.
 */

import { localHourOf } from './time';
import type { EngineParams, RoadClass, Segment } from '@/contracts';

/** Rush factor for a road class at an instant. 1 outside the configured bands. */
export function rushFactor(params: EngineParams, roadClass: RoadClass, iso: string): number {
  const { localHours, factor, classes } = params.rush;
  if (!classes.includes(roadClass)) return 1;
  const localHour = Math.floor(localHourOf(iso));
  if (!localHours.includes(localHour)) return 1;
  const f = Number.isFinite(factor) ? factor : 1;
  return f > 0 ? f : 1;
}

/**
 * Prior street multiplier m (before the stagnation amplification).
 * Always finite and clamped to [0.5, 3].
 */
export function priorMultiplier(params: EngineParams, segment: Segment, iso: string): number {
  const lambda = params.nearRoadDecayM > 0 ? params.nearRoadDecayM : 1;
  const eGreen = Number.isFinite(params.greenExcess) ? params.greenExcess : 0;

  let m = 1;

  const eOwn = params.roadExcess[segment.roadClass] ?? 0;
  m += (Number.isFinite(eOwn) ? eOwn : 0) * rushFactor(params, segment.roadClass, iso);

  for (const near of segment.features.nearbyRoads) {
    const e = params.roadExcess[near.roadClass] ?? 0;
    if (!Number.isFinite(e) || e === 0) continue;
    const d = Number.isFinite(near.distanceM) ? Math.max(0, near.distanceM) : 0;
    m += e * rushFactor(params, near.roadClass, iso) * Math.exp(-d / lambda);
  }

  const green = segment.features.greenFraction100m;
  m -= eGreen * (Number.isFinite(green) ? Math.max(0, Math.min(1, green)) : 0);

  if (!Number.isFinite(m)) return 1;
  return Math.min(3, Math.max(0.5, m));
}

/** m' = max(0.3, 1 + (m − 1) · S^α). Always finite, ≥ 0.3. */
export function amplifiedMultiplier(m: number, stagnation: number, alpha: number): number {
  const a = Number.isFinite(alpha) && alpha > 0 ? alpha : 0;
  const s = Number.isFinite(stagnation) ? Math.max(0, stagnation) : 1;
  const boosted = 1 + (m - 1) * Math.pow(s, a);
  return Math.max(0.3, Number.isFinite(boosted) ? boosted : 1);
}
