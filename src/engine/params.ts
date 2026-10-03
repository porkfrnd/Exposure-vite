/**
 * DEFAULT ENGINE PARAMETERS.
 *
 * INTEGRITY: EVERY numeric value in this file is a starting GUESS taken from
 * generic air-pollution modelling practice. None of them was calibrated on
 * Kathmandu field data. They are all marked ASSUMED and are reproduced verbatim
 * in the in-app "Assumptions" table so a user can see exactly what is invented.
 *
 * Replace a value only with a number you have actually derived from a source you
 * have actually read, and cite it.
 */

import { IDENTITY_BIAS } from '@/contracts';
import type { EngineParams } from '@/contracts';

/** ASSUMED near-road relative excess per road class, e_c in methodology 8.2. */
export const ROAD_EXCESS = {
  trunk: 0.45, // ASSUMED
  primary: 0.4, // ASSUMED
  secondary: 0.25, // ASSUMED
  tertiary: 0.1, // ASSUMED
  residential: 0.05, // ASSUMED
  footway: 0, // ASSUMED — a footway's own contribution is treated as zero; its
  //              exposure comes from nearby roads and green fraction instead
  path: 0, // ASSUMED — see footway
} as const;

/** Fresh, mutable copy of the default parameters (callers may override freely). */
export function defaultEngineParams(): EngineParams {
  return {
    // ASSUMED: identity bias (no station calibration available), with a log
    // background sigma that widens with lead time.
    bias: { ...IDENTITY_BIAS },

    roadExcess: { ...ROAD_EXCESS },

    rush: {
      localHours: [7, 8, 9, 16, 17, 18], // ASSUMED — Nepal commuting bands, local time
      factor: 1.5, // ASSUMED — multiplicative rush-hour boost on main-road excess
      classes: ['trunk', 'primary', 'secondary'], // ASSUMED
    },

    nearRoadDecayM: 120, // ASSUMED — λ, methodology 8.2 (literature suggests 100–150 m)
    greenExcess: 0.15, // ASSUMED — e_g, subtracted × green fraction

    stagnation: {
      alpha: 0.5, // ASSUMED — exponent on the stagnation index
      uMin: 0.5, // ASSUMED — wind floor (m/s) preventing division blow-up
      hRef: null, // null ⇒ median boundary-layer height over the forecast window
      uRef: null, // null ⇒ median wind speed over the forecast window
      clampMin: 0.5, // ASSUMED
      clampMax: 2, // ASSUMED
    },

    mode: {
      walk: { speedKmh: 4.5, ventilationM3h: 1.3, infiltration: 1.0 }, // ALL ASSUMED
      cycle: { speedKmh: 15, ventilationM3h: 2.8, infiltration: 1.0 }, // ALL ASSUMED
      // F_e = 0.9 is the methodology's "open-window bus" assumption.
      bus: { speedKmh: 12, ventilationM3h: 0.7, infiltration: 0.9 }, // ALL ASSUMED
    },

    refDailyDoseUg: 225, // ASSUMED — normalization CONVENTION (15 µg/m³ × 15 m³), not a medical limit
    cigaretteUgM3Day: 22, // ASSUMED — popular heuristic only, not a health statement
    dailyAirM3: 15, // ASSUMED

    priorSigmaLog: 0.25, // ASSUMED — log-scale uncertainty of the street prior
    floorSigmaLog: 0.1, // ASSUMED — irreducible log uncertainty

    decision: {
      pRecommend: 0.8, // ASSUMED design choice — methodology 3.3
      minDeltaE: 0.1, // ASSUMED design choice — 10% dose gap
      pSlight: 0.6, // ASSUMED design choice
    },

    indoorInfiltration: 0.6, // ASSUMED — methodology 8.3 "school indoors"
  };
}

/**
 * Deep-merge a partial override into a full parameter set. Plain objects are
 * merged key-by-key; scalars replace. Arrays replace wholesale.
 */
export function mergeParams(base: EngineParams, override?: Partial<EngineParams>): EngineParams {
  if (!override) return base;
  return deepMerge(base as unknown as Record<string, unknown>, override as unknown as Record<string, unknown>) as unknown as EngineParams;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function deepMerge(
  base: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    const b = out[k];
    if (isPlainObject(v) && isPlainObject(b)) {
      out[k] = deepMerge(b, v);
    } else if (Array.isArray(v)) {
      out[k] = v.slice();
    } else if (isPlainObject(v)) {
      out[k] = { ...v };
    } else {
      out[k] = v;
    }
  }
  return out;
}
