/**
 * Leave-one-day-out backtest against a user-supplied station CSV
 * (methodology 5, 7.1, 9.1, 9.2, 9.4).
 *
 * INTEGRITY — the single most important rule in this file:
 *   NOT A SINGLE NUMBER PRODUCED HERE IS INVENTED, AND NONE IS HARDCODED.
 * Every figure is computed at runtime from the CSV the user supplied. With no CSV
 * the UI must show "Not yet validated. Requires real station data."
 *
 * Blocked cross-validation (leave-one-DAY-out) is used rather than a random hourly
 * split, because hours inside a day are strongly correlated and a random split
 * leaks information and inflates the scores.
 */

import { IDENTITY_BIAS, NPT_OFFSET_MIN } from '@/contracts';
import { localDayKey } from '../time';
import {
  effectiveSampleSize,
  fitLinear,
  lag1Autocorrelation,
  metricSet,
  parseStationCsv,
} from './csv';
import { hourKeyMs } from '../time';
import type {
  BacktestReport,
  BacktestResult,
  BiasModel,
  Forecast,
  MetricSet,
} from '@/contracts';

/** Minimum aligned hours before we will report anything at all. */
export const MIN_ALIGNED_HOURS = 48;
/** Minimum distinct Nepal days. */
export const MIN_DAYS = 3;
/** Below this effective sample size we warn that the metrics are weakly determined. */
export const LOW_ESS = 20;
/** Below this many aligned hours we warn about a small sample. */
export const LOW_SAMPLE_HOURS = 168;
export const CONFORMAL_ALPHA = 0.1;

interface Aligned {
  /** Station value. */
  obs: number[];
  /** Raw API PM2.5 at the same UTC hour. */
  api: number[];
  /** Nepal local day key. */
  days: string[];
  /** Station values indexed by day, for persistence. */
  byDay: Map<string, number[]>;
}

export function runBacktest(stationCsv: string, apiHistory: Forecast): BacktestResult {
  // ── Parse ─────────────────────────────────────────────────────────────────
  const parsed = parseStationCsv(stationCsv);
  if (parsed.samples.length === 0) {
    const why = parsed.warnings[0] ?? 'no usable station rows were found';
    return { ok: false, reason: `Could not read the station file: ${why}.` };
  }

  // ── Align to the API history by UTC hour ──────────────────────────────────
  const apiByHour = new Map<number, number>();
  for (const h of apiHistory?.hours ?? []) {
    const key = hourKeyMs(h.timeISO);
    if (!Number.isFinite(key)) continue;
    const v = h.pm25;
    if (Number.isFinite(v)) apiByHour.set(key, v);
  }

  const obs: number[] = [];
  const api: number[] = [];
  const days: string[] = [];
  const byDay = new Map<string, number[]>();

  for (const s of parsed.samples) {
    const key = hourKeyMs(s.timeISO);
    if (!Number.isFinite(key)) continue;
    const a = apiByHour.get(key);
    if (a === undefined) continue;
    obs.push(s.value);
    api.push(a);
    const day = localDayKey(s.timeISO);
    days.push(day);
    const list = byDay.get(day);
    if (list) list.push(s.value);
    else byDay.set(day, [s.value]);
  }

  const nHours = obs.length;
  const nDays = byDay.size;
  const warnings = [...parsed.warnings];

  if (nHours < MIN_ALIGNED_HOURS) {
    return {
      ok: false,
      reason:
        `Only ${nHours} hour(s) of the station file line up with the forecast history ` +
        `(${MIN_ALIGNED_HOURS} required). Re-request more past days, or check that the ` +
        `file covers the same period.`,
    };
  }
  if (nDays < MIN_DAYS) {
    return {
      ok: false,
      reason: `Only ${nDays} distinct day(s) of station data were found (${MIN_DAYS} required).`,
    };
  }

  // ── Raw metrics (no bias correction) ──────────────────────────────────────
  const raw: MetricSet = metricSet(api, obs);

  // ── Leave-one-day-out: fit a,b on all but one day, predict the held-out day ─
  const heldPred: number[] = [];
  const heldObs: number[] = [];

  for (const day of byDay.keys()) {
    const trainPred: number[] = [];
    const trainObs: number[] = [];
    for (let i = 0; i < nHours; i++) {
      if (days[i] === day) continue;
      trainPred.push(api[i]);
      trainObs.push(obs[i]);
    }
    if (trainPred.length < 3) continue;
    const { a, b } = fitLinear(trainPred, trainObs);
    for (let i = 0; i < nHours; i++) {
      if (days[i] !== day) continue;
      heldPred.push(Math.max(1, a * api[i] + b));
      heldObs.push(obs[i]);
    }
  }

  if (heldPred.length === 0) {
    return { ok: false, reason: 'Leave-one-day-out produced no held-out predictions.' };
  }

  const biasCorrected: MetricSet = metricSet(heldPred, heldObs);

  // ── fittedBias: OLS on ALL aligned data, for application to the live model ──
  const all = fitLinear(api, obs);
  const logResiduals = heldPred.map((p, i) => Math.log(Math.max(1, heldObs[i]) / p));
  const meanLog = logResiduals.reduce((a, b) => a + b, 0) / logResiduals.length;
  const sigmaBgLog = Math.sqrt(
    logResiduals.reduce((a, b) => a + (b - meanLog) ** 2, 0) / Math.max(1, logResiduals.length - 1),
  );

  const fittedBias: BiasModel = {
    a: Number.isFinite(all.a) ? all.a : 1,
    b: Number.isFinite(all.b) ? all.b : 0,
    sigmaBgLog: Number.isFinite(sigmaBgLog) ? sigmaBgLog : IDENTITY_BIAS.sigmaBgLog,
    // ASSUMED: lead-time growth is NOT fitted here; we keep the engine defaults.
    leadQ: IDENTITY_BIAS.leadQ,
    leadKappa: IDENTITY_BIAS.leadKappa,
    fittedOn: `${nDays} days, ${nHours} hours (leave-one-day-out held-out)`,
  };

  // ── Effective sample size ─────────────────────────────────────────────────
  const rho1 = lag1Autocorrelation(obs);
  const ess = effectiveSampleSize(nHours, rho1);
  if (ess < LOW_ESS) {
    warnings.push(
      `Effective sample size is only ${ess.toFixed(1)} independent hours (${nHours} hourly ` +
      `values are strongly autocorrelated, ρ₁ = ${rho1.toFixed(2)}). These metrics are weakly determined.`,
    );
  }
  if (nHours < LOW_SAMPLE_HOURS) {
    warnings.push(`Small sample: ${nHours} aligned hours is less than a week.`);
  }

  // ── Skill vs persistence at 1 h lead ──────────────────────────────────────
  let skillVsPersistence: number | null = null;
  {
    const persistencePred: number[] = [];
    const persistenceObs: number[] = [];
    for (const day of byDay.keys()) {
      const vals = byDay.get(day) ?? [];
      for (let i = 1; i < vals.length; i++) {
        persistencePred.push(vals[i - 1]);
        persistenceObs.push(vals[i]);
      }
    }
    if (persistencePred.length >= 12) {
      const pMetrics = metricSet(persistencePred, persistenceObs);
      if (pMetrics.mae > 0) {
        skillVsPersistence = 1 - biasCorrected.mae / pMetrics.mae;
      }
    }
  }
  if (skillVsPersistence === null) {
    warnings.push('Not enough within-day continuity to score against a persistence baseline.');
  }

  // ── Split conformal intervals on the log scale (methodology 9.4) ───────────
  let conformal: BacktestReport['conformal'] = null;
  if (nDays >= 6) {
    const dayList = [...byDay.keys()].sort();
    const calibCount = Math.ceil((2 / 3) * dayList.length);
    const calibDays = new Set(dayList.slice(0, calibCount));
    const testDays = new Set(dayList.slice(calibCount));

    const calibErrors: number[] = [];
    for (let i = 0; i < nHours; i++) {
      if (!calibDays.has(days[i])) continue;
      calibErrors.push(Math.abs(Math.log(Math.max(1, obs[i])) - Math.log(heldPred[i])));
    }

    if (calibErrors.length > 0) {
      // q = the ⌈(n+1)(1−α)⌉-th smallest calibration residual.
      const sorted = calibErrors.slice().sort((a, b) => a - b);
      const rank = Math.ceil((sorted.length + 1) * (1 - CONFORMAL_ALPHA));
      const idx = Math.min(sorted.length - 1, Math.max(0, rank - 1));
      const qLog = sorted[idx];

      let covered = 0;
      let tested = 0;
      for (let i = 0; i < nHours; i++) {
        if (!testDays.has(days[i])) continue;
        tested++;
        const ratio = Math.max(1, obs[i]) / heldPred[i];
        if (Math.abs(Math.log(ratio)) <= qLog) covered++;
      }

      if (tested > 0) {
        conformal = {
          alpha: CONFORMAL_ALPHA,
          empiricalCoverage: covered / tested,
          qLog,
        };
        warnings.push(
          'Conformal coverage is measured on held-out days, but time series are not exchangeable, ' +
            'so this is approximate.',
        );
      }
    }
  } else {
    warnings.push(`Split conformal needs at least 6 days; ${nDays} were available, so it was skipped.`);
  }

  const report: BacktestReport = {
    stationLabel: parsed.stationLabel,
    nHours,
    nDays,
    effectiveSampleSize: ess,
    scheme: 'leave-one-day-out',
    raw,
    biasCorrected,
    skillVsPersistence,
    conformal,
    fittedBias,
    warnings,
  };

  return { ok: true, report };
}

export { NPT_OFFSET_MIN };