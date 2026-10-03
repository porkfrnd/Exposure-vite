/**
 * Evidence corrections (methodology 2.4–2.5, Tier 5, Tier 6, 8.1).
 *
 * DESIGN CONTRACT — photos are RELATIVE evidence only:
 *   * they REDISTRIBUTE exposure between places,
 *   * they NEVER change the regional level (the forecast sets that),
 *   * the shrinkage is anchored on the median residual, so a batch of photos can
 *     only move a segment if it disagrees with the batch median.
 *
 * Pipeline:
 *   a. attach each observation to its nearest segment (skip > 150 m away)
 *   b. turn photos into a relative log-residual ρ (median-anchored, humidity corrected)
 *   c. Tier 5 conjugate Bayesian regression  ρ ≈ x_sᵀβ  with a zero prior mean
 *   d. Tier 6 space-time Gaussian process on the regression residual
 *   e. emit deltaLog / confidence / sigmaLog only where there is real support
 */

import { distanceToPolylineM, haversineM, nearestSegment, segmentMidpoint } from '../geo';
import { median } from '../time';
import { cholesky, choleskySolve, invert, matVec, solve, zeros } from '../linalg';
import type {
  CorrectionMap,
  Observation,
  PhotoObservation,
  PredictFn,
  Segment,
  SegmentCorrection,
} from '@/contracts';

// ── ASSUMED hyperparameters (documented in the in-app Assumptions table) ─────

/** ASSUMED — observations further than this from a segment are ignored entirely. */
export const MAX_ASSIGN_DISTANCE_M = 150;
/** ASSUMED — minimum usable photos before the photo layer is switched on. */
export const MIN_PHOTOS = 3;
/** ASSUMED — humidity growth exponent in f(RH) = (1 − RH)^(−γ). */
export const HUMIDITY_GAMMA = 0.5;
/** ASSUMED — additive log-space offset absorbing unknown scene depth, canyon vs open. */
export const SCENE_OFFSET = { open: 0, canyon: 0.7 } as const;
/** ASSUMED — slope of the log-concentration vs haze regression. */
export const GAMMA1 = 0.5;
/** ASSUMED — per-observation log noise: photos are noisy, crowd reports noisier. */
export const SIGMA_PHOTO = 0.4;
export const SIGMA_REPORT = 0.7;
/** ASSUMED — prior standard deviation of each β coefficient (no intercept ⇒ zero mean). */
export const BETA_PRIOR_TAU = 0.15;
/** ASSUMED — GP field standard deviation. */
export const GP_SIGMA_F = 0.2;
/** ASSUMED — GP spatial length scale, metres. */
export const GP_ELL_S_M = 300;
/** ASSUMED — GP temporal length scale, hours. */
export const GP_ELL_T_H = 2;
/** ASSUMED — normalisation so supportN lands on a readable 0..~1 scale. */
export const SUPPORT_NORMALISER = 6.25;
/** Only segments above this support are emitted; below it the prior stands alone. */
export const MIN_SUPPORT_N = 0.05;
/** ASSUMED — clamp on the emitted log-correction so no single photo can dominate. */
export const DELTA_LOG_CLAMP = 0.7;
/** ASSUMED — only observations in this window around atISO are used. */
export const PAST_HOURS = 12;
export const FUTURE_HOURS = 1;

/** Fixed log-residuals for crowd reports. ASSUMED. */
const REPORT_RESIDUAL = {
  smoky: Math.log(1.3),
  dusty: Math.log(1.2),
  clear: -Math.log(1.3),
} as const;

// ── Tier 5 feature vector (no intercept) ─────────────────────────────────────

/**
 * x_s = [ isMain, ln(1+distToMainRoadM)/ln(501), intersectionDensityPer100m,
 *         hasSignal, hasBusStop, greenFraction100m, buildingDensity ]
 *
 * `distToMainRoadM` is log-normalised and divided by ln(501) so the whole feature
 * lands in [0,1], matching the other columns.
 */
export function segmentFeatureVector(seg: Segment): number[] {
  const f = seg.features;
  const mainRoad = f.distToMainRoadM === 0 || seg.roadClass === 'trunk' || seg.roadClass === 'primary' || seg.roadClass === 'secondary';
  const distNorm = Math.log(1 + Math.max(0, f.distToMainRoadM)) / Math.log(501);
  return [
    mainRoad ? 1 : 0,
    distNorm,
    Math.max(0, f.intersectionDensityPer100m),
    f.trafficSignalsWithin50m > 0 ? 1 : 0,
    f.busStopsWithin30m > 0 ? 1 : 0,
    Math.min(1, Math.max(0, f.greenFraction100m)),
    Math.min(1, Math.max(0, f.buildingDensity)),
  ];
}

const FEATURE_COUNT = 7;

// ── Kernels ──────────────────────────────────────────────────────────────────

/** Matérn 3/2 correlation: (1 + √3 u)·exp(−√3 u). */
export function matern32(u: number): number {
  if (!Number.isFinite(u) || u < 0) return 0;
  const s = Math.sqrt(3) * u;
  return (1 + s) * Math.exp(-s);
}

interface AssignedObservation {
  obs: Observation;
  segment: Segment;
  distanceM: number;
  timeHours: number; // relative to atISO, hours
  x: number[];
  rho: number;
  sigma: number;
  lat: number;
  lon: number;
}

// ── Public entry point ───────────────────────────────────────────────────────

export interface ComputeCorrectionsArgs {
  observations: Observation[];
  segments: Segment[];
  atISO: string;
  predict: PredictFn;
  params?: { priorSigmaLog?: number; floorSigmaLog?: number };
}

export function computeCorrections(args: ComputeCorrectionsArgs): CorrectionMap {
  const priorSigmaLog = Number.isFinite(args.params?.priorSigmaLog)
    ? (args.params?.priorSigmaLog as number)
    : 0.25;
  const floorSigmaLog = Number.isFinite(args.params?.floorSigmaLog)
    ? (args.params?.floorSigmaLog as number)
    : 0.1;

  const atMs = Date.parse(args.atISO);
  if (!Number.isFinite(atMs)) return {};
  if (!Array.isArray(args.observations) || args.observations.length === 0) return {};
  if (!Array.isArray(args.segments) || args.segments.length === 0) return {};

  // ── a. Assign each observation to its nearest segment ──────────────────────
  const inWindow: Array<{ obs: Observation; segment: Segment; distanceM: number }> = [];
  for (const obs of args.observations) {
    if (!obs || !Number.isFinite(obs.lat) || !Number.isFinite(obs.lon)) continue;
    const tMs = Date.parse(obs.timeISO);
    if (!Number.isFinite(tMs)) continue;

    const dtH = (tMs - atMs) / 3_600_000;
    if (dtH < -PAST_HOURS || dtH > FUTURE_HOURS) continue;

    const near = nearestSegment(obs, args.segments);
    if (!near || near.distanceM > MAX_ASSIGN_DISTANCE_M) continue;

    inWindow.push({ obs, segment: near.segment, distanceM: near.distanceM });
  }
  if (inWindow.length === 0) return {};

  // ── b. Residuals ──────────────────────────────────────────────────────────
  const photos = inWindow.filter((o) => o.obs.kind === 'photo') as Array<{
    obs: PhotoObservation;
    segment: Segment;
    distanceM: number;
  }>;
  const reports = inWindow.filter((o) => o.obs.kind === 'report');

  // Photo residual is anchored on the MEDIAN, so the photo layer can only
  // redistribute exposure relative to the batch, never shift the regional level.
  let photoRhoByIndex: number[] = [];
  if (photos.length >= MIN_PHOTOS) {
    const z: number[] = [];
    const logPred: number[] = [];
    for (const p of photos) {
      const pred = safePredict(args.predict, p.segment, p.obs.timeISO);
      const rh = Math.min(0.95, Math.max(0, p.obs.rh01));
      const fRh = Math.pow(1 - rh, -HUMIDITY_GAMMA);
      const tau = Math.max(1e-4, p.obs.tauOpt);
      z.push(Math.log(tau) - Math.log(fRh) + SCENE_OFFSET[p.obs.scene] * 1);
      logPred.push(Math.log(Math.max(1e-6, pred)));
    }
    const zMed = median(z) ?? 0;
    const lnCMed = median(logPred) ?? 0;
    photoRhoByIndex = z.map((zi, i) => lnCMed + GAMMA1 * (zi - zMed) - logPred[i]);
  }

  const assigned: AssignedObservation[] = [];

  photos.forEach((p, i) => {
    if (photos.length < MIN_PHOTOS) return;
    const rho = photoRhoByIndex[i];
    if (!Number.isFinite(rho)) return;
    assigned.push({
      obs: p.obs,
      segment: p.segment,
      distanceM: p.distanceM,
      timeHours: (Date.parse(p.obs.timeISO) - atMs) / 3_600_000,
      x: segmentFeatureVector(p.segment),
      rho,
      sigma: SIGMA_PHOTO,
      lat: p.obs.lat,
      lon: p.obs.lon,
    });
  });

  for (const r of reports) {
    if (r.obs.kind !== 'report') continue;
    assigned.push({
      obs: r.obs,
      segment: r.segment,
      distanceM: r.distanceM,
      timeHours: (Date.parse(r.obs.timeISO) - atMs) / 3_600_000,
      x: segmentFeatureVector(r.segment),
      rho: REPORT_RESIDUAL[r.obs.report],
      sigma: SIGMA_REPORT,
      lat: r.obs.lat,
      lon: r.obs.lon,
    });
  }

  if (assigned.length === 0) return {};

  // ── c. Tier 5 conjugate Bayesian regression (no intercept ⇒ zero prior mean) ─
  const priorPrecision = 1 / (BETA_PRIOR_TAU * BETA_PRIOR_TAU);
  const posteriorPrecision = zeros(FEATURE_COUNT, FEATURE_COUNT);
  for (let i = 0; i < FEATURE_COUNT; i++) posteriorPrecision[i][i] += priorPrecision;

  const rhs = new Array<number>(FEATURE_COUNT).fill(0);
  for (const a of assigned) {
    const inv = 1 / (a.sigma * a.sigma);
    for (let i = 0; i < FEATURE_COUNT; i++) {
      rhs[i] += a.x[i] * a.rho * inv;
      for (let j = 0; j < FEATURE_COUNT; j++) {
        posteriorPrecision[i][j] += a.x[i] * a.x[j] * inv;
      }
    }
  }

  const sigmaBeta = invert(posteriorPrecision);
  const betaHat = matVec(sigmaBeta, rhs);

  // ── d. Tier 6 GP on the regression residual ────────────────────────────────
  const residuals = assigned.map((a) => a.rho - dotOf(betaHat, a.x));

  const n = assigned.length;
  const K = zeros(n, n);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      K[i][j] = obsKernel(assigned[i], assigned[j]);
    }
  }
  // Noise variance on the diagonal (Σ_n = diag(σ_i²)).
  for (let i = 0; i < n; i++) K[i][i] += assigned[i].sigma * assigned[i].sigma;

  const L = cholesky(K, 1e-8);
  const alpha = L ? choleskySolve(L, residuals) : solve(K, residuals, 1e-8);

  const sigmaF2 = GP_SIGMA_F * GP_SIGMA_F;

  // ── e. Emit corrections for segments with real support ─────────────────────
  const out: CorrectionMap = {};

  for (const seg of args.segments) {
    const mid = segmentMidpoint(seg);
    const x = segmentFeatureVector(seg);

    let supportN = 0;
    const kStar: number[] = new Array<number>(n).fill(0);

    for (let i = 0; i < n; i++) {
      const a = assigned[i];
      const spatial = matern32(haversineM(mid, { lat: a.lat, lon: a.lon }) / GP_ELL_S_M);
      const timeK = Math.exp(-Math.abs(a.timeHours) / GP_ELL_T_H);
      kStar[i] = sigmaF2 * spatial * timeK;
      supportN += ((1 / (a.sigma * a.sigma)) / SUPPORT_NORMALISER) * spatial * timeK;
    }

    if (supportN <= MIN_SUPPORT_N) continue;

    const mu = dotOf(alpha, kStar);
    const solved = L ? choleskySolve(L, kStar) : solve(K, kStar, 1e-8);
    const kss = sigmaF2;
    const quad = dotOf(kStar, solved);
    const variance = Math.max(0, kss - quad);

    let confidence = 1 - variance / sigmaF2;
    confidence = Math.min(1, Math.max(0, Number.isFinite(confidence) ? confidence : 0));

    let deltaLog = dotOf(betaHat, x) + mu;
    if (!Number.isFinite(deltaLog)) deltaLog = 0;
    deltaLog = Math.min(DELTA_LOG_CLAMP, Math.max(-DELTA_LOG_CLAMP, deltaLog));

    const sigmaLog = Math.sqrt(
      priorSigmaLog * priorSigmaLog * (1 - confidence) + floorSigmaLog * floorSigmaLog,
    );

    const correction: SegmentCorrection = {
      segmentId: seg.id,
      deltaLog,
      confidence,
      sigmaLog: Number.isFinite(sigmaLog) ? sigmaLog : floorSigmaLog,
      supportN,
    };
    out[seg.id] = correction;
  }

  return out;
}

function dotOf(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const av = Number.isFinite(a[i]) ? a[i] : 0;
    const bv = Number.isFinite(b[i]) ? b[i] : 0;
    sum += av * bv;
  }
  return Number.isFinite(sum) ? sum : 0;
}

/**
 * Space-time Matérn 3/2 kernel between two observations:
 *   k = σ_f² · M32(‖x − x'‖ / ℓ_s) · exp(−|t − t'| / ℓ_t)
 */
function obsKernel(a: AssignedObservation, b: AssignedObservation): number {
  const spatial = matern32(haversineM({ lat: a.lat, lon: a.lon }, { lat: b.lat, lon: b.lon }) / GP_ELL_S_M);
  const timeK = Math.exp(-Math.abs(a.timeHours - b.timeHours) / GP_ELL_T_H);
  return GP_SIGMA_F * GP_SIGMA_F * spatial * timeK;
}

function safePredict(predict: PredictFn, segment: Segment, iso: string): number {
  try {
    const out = predict(segment, iso);
    return Number.isFinite(out?.concentration) ? out.concentration : 1;
  } catch {
    return 1;
  }
}