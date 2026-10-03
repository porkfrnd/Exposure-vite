/**
 * Monte Carlo decision rule (methodology 3.3 + 7.2).
 *
 * Concentration enters the dose multiplicatively, so a draw is just a scaling of
 * each segment's deterministic dose:
 *
 *   D*_s = D_s · exp(ε_bg + ε_seg,s)
 *
 * One ε_bg per draw, shared by every route (regional error is common to both).
 * One ε_seg per UNIQUE segment id per draw, also shared by every route using that
 * segment — so a stretch both routes share cancels exactly in the comparison.
 */

import { mulberry32, NormalSampler, medianOf } from './rng';
import { toMs } from './time';
import type { EngineParams, SegmentEstimate } from '@/contracts';

export const DEFAULT_DRAWS = 300;
export const DEFAULT_SEED = 1337;

export interface DrawTable {
  /** Segment ids in first-seen order. */
  segmentIds: string[];
  /** doseById[i] is the total deterministic dose contributed by segmentIds[i]. */
  doseById: number[];
  /** sigmaLog[i] is the per-segment log sigma. */
  sigmaById: number[];
  /** Per-route index arrays into segmentIds. */
  routeIndices: number[][];
  routeDose: number[];
}

export interface DrawResult {
  /** draws[i] is the sampled relative dose of each route in draw i. */
  draws: number[][];
  count: number;
  sigmaBg: number;
}

/** Build the draw table from deterministic trip estimates. */
export function buildDrawTable(trips: SegmentEstimate[][], routeIds: string[]): DrawTable {
  const index = new Map<string, number>();
  const segmentIds: string[] = [];
  const doseById: number[] = [];
  const sigmaById: number[] = [];

  trips.forEach((segments) => {
    for (const seg of segments) {
      let i = index.get(seg.segmentId);
      if (i === undefined) {
        i = segmentIds.length;
        index.set(seg.segmentId, i);
        segmentIds.push(seg.segmentId);
        doseById.push(0);
        sigmaById.push(0);
      }
      doseById[i] += Number.isFinite(seg.doseUg) ? seg.doseUg : 0;
      sigmaById[i] = Number.isFinite(seg.sigmaLog) ? seg.sigmaLog : 0;
    }
  });

  const routeIndices = trips.map((segments) =>
    segments
      .map((s) => index.get(s.segmentId))
      .filter((v): v is number => v !== undefined),
  );

  const routeDose = routeIndices.map((idxs) =>
    idxs.reduce((sum, i) => sum + doseById[i], 0),
  );

  // routeIds kept in the signature so callers document the row order they expect.
  void routeIds;

  return { segmentIds, doseById, sigmaById, routeIndices, routeDose };
}

/** σ_bg(h)² = σ₀² + q·h + κ²·h², h = lead time in hours (≥ 0). */
export function sigmaBgAtLead(params: EngineParams, leadHours: number): number {
  const b = params.bias;
  const s0 = Number.isFinite(b.sigmaBgLog) ? b.sigmaBgLog : 0;
  const q = Number.isFinite(b.leadQ) ? b.leadQ : 0;
  const k = Number.isFinite(b.leadKappa) ? b.leadKappa : 0;
  const h = Number.isFinite(leadHours) ? Math.max(0, leadHours) : 0;
  const v = s0 * s0 + q * h + k * k * h * h;
  return v > 0 ? Math.sqrt(v) : 0;
}

/** Lead time in hours from the forecast's "now" to a departure instant. */
export function leadHoursFrom(fetchedAtISO: string, departISO: string): number {
  const a = toMs(fetchedAtISO);
  const b = toMs(departISO);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  return Math.max(0, (b - a) / 3_600_000);
}

/** Run the Monte Carlo. Deterministic for a given seed and draw count. */
export function runDraws(table: DrawTable, sigmaBg: number, draws: number, seed: number): DrawResult {
  const n = Math.max(1, Math.floor(draws));
  const r = table.routeIndices.length;
  const m = table.segmentIds.length;

  const sampler = new NormalSampler(mulberry32(seed));
  const eps = new Float64Array(m);
  const perSegment = new Float64Array(m);
  const out: number[][] = Array.from({ length: r }, () => new Array<number>(n));

  const sigmaBgSafe = Number.isFinite(sigmaBg) && sigmaBg > 0 ? sigmaBg : 0;

  for (let d = 0; d < n; d++) {
    const epsBg = sampler.scaled(sigmaBgSafe);
    for (let i = 0; i < m; i++) {
      eps[i] = epsBg + sampler.scaled(table.sigmaById[i]);
      perSegment[i] = table.doseById[i] * Math.exp(eps[i]);
    }
    for (let k = 0; k < r; k++) {
      const idxs = table.routeIndices[k];
      let sum = 0;
      for (let i = 0; i < idxs.length; i++) sum += perSegment[idxs[i]];
      out[k][d] = sum;
    }
  }

  return { draws: out, count: n, sigmaBg: sigmaBgSafe };
}

/** ΔE samples against a baseline row: (D_base − D_cand) / D_base. */
export function deltaESamples(base: readonly number[], cand: readonly number[]): number[] {
  const out: number[] = [];
  const n = Math.min(base.length, cand.length);
  for (let i = 0; i < n; i++) {
    const b = base[i];
    out.push(b > 0 ? (b - cand[i]) / b : 0);
  }
  return out;
}

/** Fraction of draws where cand < base (strict), with ties counted as "not better". */
export function pBetter(base: readonly number[], cand: readonly number[]): number {
  const n = Math.min(base.length, cand.length);
  if (n === 0) return 0;
  let wins = 0;
  for (let i = 0; i < n; i++) {
    if (cand[i] < base[i]) wins++;
  }
  return wins / n;
}

export { medianOf };
