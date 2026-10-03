/**
 * Ranking-stability check (methodology 3.4).
 *
 * Every ASSUMED multiplier in roadExcess is scaled together, nothing else changes,
 * and we ask whether the same route still has the lowest dose. This measures how
 * robust the RANKING is — it is NOT an accuracy measure and is never labelled one.
 */

import { evaluateTrip } from './trip';
import { resolveParams } from './predict';
import type {
  EngineParams,
  EvalContext,
  Mode,
  RoadClass,
  Route,
  SensitivityReport,
} from '@/contracts';

export const DEFAULT_SCALES = [0.8, 1, 1.2];

const ROAD_CLASSES: RoadClass[] = [
  'trunk',
  'primary',
  'secondary',
  'tertiary',
  'residential',
  'footway',
  'path',
];

function scaleRoadExcess(base: EngineParams, scale: number): Partial<EngineParams> {
  const next = {} as Record<RoadClass, number>;
  for (const cls of ROAD_CLASSES) {
    const v = base.roadExcess[cls];
    next[cls] = Number.isFinite(v) ? v * scale : 0;
  }
  return { roadExcess: next };
}

export function sensitivity(
  routes: Route[],
  mode: Mode,
  departISO: string,
  ctx: EvalContext,
  scales: number[] = DEFAULT_SCALES,
): SensitivityReport {
  const safeRoutes = Array.isArray(routes) ? routes : [];
  const base = resolveParams(ctx);
  const safeScales = (Array.isArray(scales) && scales.length > 0 ? scales : DEFAULT_SCALES).filter(
    (s) => Number.isFinite(s) && s > 0,
  );

  // dose[scaleIndex][routeIndex]
  const dose: number[][] = safeScales.map((scale) => {
    const scaledCtx: EvalContext = {
      ...ctx,
      params: { ...(ctx.params ?? {}), ...scaleRoadExcess(base, scale) },
    };
    return safeRoutes.map(
      (route) => evaluateTrip({ route, mode, departISO }, scaledCtx).doseUg,
    );
  });

  let pairs = 0;
  let stablePairs = 0;

  for (let a = 0; a < safeRoutes.length; a++) {
    for (let b = a + 1; b < safeRoutes.length; b++) {
      pairs++;
      let consistent = true;
      let referenceLowerIsA: boolean | null = null;

      for (let s = 0; s < dose.length && consistent; s++) {
        const da = dose[s][a];
        const db = dose[s][b];
        if (da === db) {
          // A tie has no winner, so the ranking cannot be called stable.
          consistent = false;
          break;
        }
        const lowerIsA = da < db;
        if (referenceLowerIsA === null) referenceLowerIsA = lowerIsA;
        else if (lowerIsA !== referenceLowerIsA) consistent = false;
      }

      if (consistent) stablePairs++;
    }
  }

  return {
    scales: safeScales,
    pairs,
    stablePairs,
    stability: pairs > 0 ? stablePairs / pairs : 0,
  };
}
