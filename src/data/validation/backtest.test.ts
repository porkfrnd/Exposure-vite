import { describe, expect, it } from 'vitest';
import { runBacktest, MIN_ALIGNED_HOURS, MIN_DAYS } from './backtest';
import {
  effectiveSampleSize,
  fitLinear,
  lag1Autocorrelation,
  metricSet,
  parseStationCsv,
  pearson,
  splitCsvLine,
} from './csv';
import { mulberry32 } from '../rng';
import type { Forecast } from '@/contracts';

// ── SYNTHETIC test fixtures, generated INSIDE this test file only ─────────────
// These are NOT station data, are never written to disk, and are never shipped.
// They exist only so the metric formulas can be checked against known answers.

const START = Date.parse('2026-10-01T00:00:00Z');
const DAYS = 7;
const HOURS_PER_DAY = 24;

/** Deterministic "API" series: a daily cycle between 40 and 90 µg/m³. */
function apiSeries(): number[] {
  const out: number[] = [];
  for (let i = 0; i < DAYS * HOURS_PER_DAY; i++) {
    const h = i % 24;
    out.push(55 + 30 * Math.sin(((h - 8) / 24) * 2 * Math.PI));
  }
  return out;
}

function isoAt(i: number): string {
  return new Date(START + i * 3_600_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function historyForecast(api: number[]): Forecast {
  return {
    source: 'fixture',
    fetchedAtISO: isoAt(api.length),
    location: { lat: 27.7172, lon: 85.324 },
    hours: api.map((pm25, i) => ({
      timeISO: isoAt(i),
      pm25,
      aod: null,
      dust: null,
      windMs: 2,
      windDirDeg: null,
      blhM: null,
      rh01: 0.6,
      tempC: 20,
      precipMm: 0,
      inversionK: null,
    })),
  };
}

/** CSV whose station values are a·api + b + small deterministic noise. */
function makeCsv(opts: { a?: number; b?: number; noise?: number; seed?: number } = {}): string {
  const a = opts.a ?? 1.3;
  const b = opts.b ?? 12;
  const noise = opts.noise ?? 3;
  const rnd = mulberry32(opts.seed ?? 12345);
  const api = apiSeries();

  const rows = ['time,pm25,station'];
  for (let i = 0; i < api.length; i++) {
    const value = a * api[i] + b + (rnd() - 0.5) * 2 * noise;
    rows.push(`${isoAt(i)},${value.toFixed(3)},Test Station`);
  }
  return rows.join('\n');
}

describe('splitCsvLine', () => {
  it('handles quoted fields and doubled quotes', () => {
    expect(splitCsvLine('a,b,c')).toEqual(['a', 'b', 'c']);
    expect(splitCsvLine('"a,b",c')).toEqual(['a,b', 'c']);
    expect(splitCsvLine('"say ""hi""",b')).toEqual(['say "hi"', 'b']);
    expect(splitCsvLine('a,,c')).toEqual(['a', '', 'c']);
  });
});

describe('parseStationCsv', () => {
  it('parses a standard file', () => {
    const { samples, stationLabel, warnings } = parseStationCsv(makeCsv());
    expect(samples.length).toBe(DAYS * HOURS_PER_DAY);
    expect(samples[0].timeISO).toBe(isoAt(0));
    expect(stationLabel).toBe('Test Station');
    expect(warnings.filter((w) => /Nepal Time/.test(w))).toHaveLength(0);
  });

  it('handles CRLF line endings', () => {
    const { samples } = parseStationCsv(makeCsv().replace(/\n/g, '\r\n'));
    expect(samples.length).toBe(DAYS * HOURS_PER_DAY);
  });

  it('accepts a case-insensitive pm2.5 header', () => {
    const csv = 'DATETIME,PM2.5\n2026-10-01T00:00:00Z,55\n2026-10-01T01:00:00Z,57\n';
    const { samples } = parseStationCsv(csv);
    expect(samples.length).toBe(2);
    expect(samples[0].value).toBe(55);
  });

  it('interprets offset-less timestamps as Nepal Time and warns', () => {
    // 06:45 NPT on 2026-10-01 is 2026-10-01T01:00:00Z.
    const csv = 'time,pm25\n2026-10-01 06:45,55\n2026-10-01 07:45,56\n';
    const { samples, warnings } = parseStationCsv(csv);
    expect(samples[0].timeISO).toBe('2026-10-01T01:00:00Z');
    expect(warnings.join(' ')).toMatch(/Nepal Time/);
  });

  it('respects an explicit offset', () => {
    const csv = 'time,pm25\n2026-10-01T06:45:00+05:45,55\n2026-10-01T07:45:00+05:45,56\n';
    const { samples, warnings } = parseStationCsv(csv);
    expect(samples[0].timeISO).toBe('2026-10-01T01:00:00Z');
    expect(warnings.join(' ')).not.toMatch(/Nepal Time/);
  });

  it('aggregates sub-hourly rows to hourly means', () => {
    const csv = [
      'time,pm25',
      '2026-10-01T00:10:00Z,50',
      '2026-10-01T00:25:00Z,60',
      '2026-10-01T00:40:00Z,70',
    ].join('\n');
    const { samples } = parseStationCsv(csv);
    expect(samples.length).toBe(1);
    expect(samples[0].value).toBe(60);
  });

  it('drops NaN and negative values', () => {
    const csv = [
      'time,pm25',
      '2026-10-01T00:00:00Z,50',
      '2026-10-01T01:00:00Z,-5',
      '2026-10-01T02:00:00Z,abc',
      '2026-10-01T03:00:00Z,70',
    ].join('\n');
    const { samples, warnings } = parseStationCsv(csv);
    expect(samples.map((s) => s.value)).toEqual([50, 70]);
    expect(warnings.join(' ')).toMatch(/dropped 2/);
  });

  it('returns a reason when the columns are missing', () => {
    const { samples, warnings } = parseStationCsv('foo,bar\n1,2\n');
    expect(samples).toEqual([]);
    expect(warnings.join(' ')).toMatch(/could not find the needed columns/);
  });

  it('returns a reason for an empty file', () => {
    expect(parseStationCsv('').warnings.join(' ')).toMatch(/empty/);
  });

  it('drops a station label when the file has more than one', () => {
    const csv = [
      'time,pm25,station',
      '2026-10-01T00:00:00Z,50,A',
      '2026-10-01T01:00:00Z,50,B',
    ].join('\n');
    const { stationLabel, warnings } = parseStationCsv(csv);
    expect(stationLabel).toBeNull();
    expect(warnings.join(' ')).toMatch(/more than one station/);
  });
});

describe('metric formulas, checked by hand', () => {
  it('pearson r is 1 for a perfect positive line and -1 for a perfect inverse one', () => {
    expect(pearson([1, 2, 3, 4], [2, 4, 6, 8])).toBeCloseTo(1, 12);
    expect(pearson([1, 2, 3, 4], [8, 6, 4, 2])).toBeCloseTo(-1, 12);
  });

  it('pearson r is 0 when a series is constant', () => {
    expect(pearson([1, 2, 3], [5, 5, 5])).toBe(0);
  });

  it('MAE, RMSE, bias and NMAE match hand-computed values', () => {
    // pred  [10, 20, 30]   obs [12, 18, 33]
    // |d| = 2, 2, 3         MAE = 7/3
    // d²  = 4, 4, 9         RMSE = sqrt(17/3)
    // bias = (1 −2 + 3)/3? d = pred−obs = −2, 2, −3 ⇒ bias = −3/3 = −1
    const m = metricSet([10, 20, 30], [12, 18, 33]);
    expect(m.n).toBe(3);
    expect(m.mae).toBeCloseTo(7 / 3, 12);
    expect(m.rmse).toBeCloseTo(Math.sqrt(17 / 3), 12);
    expect(m.bias).toBeCloseTo(-1, 12);
    expect(m.nmae).toBeCloseTo(7 / 3 / 21, 12);
  });

  it('returns zeros for empty inputs', () => {
    const m = metricSet([], []);
    expect(m).toEqual({ n: 0, r: 0, mae: 0, rmse: 0, bias: 0, nmae: 0 });
  });

  it('fitLinear recovers an exact line', () => {
    const { a, b } = fitLinear([1, 2, 3, 4], [3, 5, 7, 9]); // obs = 2·pred + 1
    expect(a).toBeCloseTo(2, 10);
    expect(b).toBeCloseTo(1, 10);
  });

  it('effective sample size formula', () => {
    // ESS = n(1−ρ₁)/(1+ρ₁). At ρ₁ = 0 ESS = n.
    expect(effectiveSampleSize(100, 0)).toBeCloseTo(100, 10);
    // At ρ₁ = 0.9, ESS ≈ n · 0.1/1.9.
    expect(effectiveSampleSize(168, 0.9)).toBeCloseTo((168 * 0.1) / 1.9, 8);
    // Clamped at the ends.
    expect(effectiveSampleSize(100, -1)).toBeCloseTo(100, 10);
    expect(effectiveSampleSize(100, 5)).toBeGreaterThan(0);
  });

  it('lag-1 autocorrelation is high for a smooth series and clamped to [0, 0.99]', () => {
    const smooth = Array.from({ length: 100 }, (_, i) => 50 + 20 * Math.sin(i / 6));
    expect(lag1Autocorrelation(smooth)).toBeGreaterThan(0.8);
    expect(lag1Autocorrelation([1, 2, 3])).toBeGreaterThanOrEqual(0);
    expect(lag1Autocorrelation([1, 2, 3])).toBeLessThanOrEqual(0.99);
  });
});

describe('runBacktest', () => {
  const api = apiSeries();
  const history = historyForecast(api);

  it('rejects a file that does not line up with the forecast', () => {
    const result = runBacktest('time,pm25\n1999-01-01T00:00:00Z,50\n', history);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/line up/);
  });

  it('rejects a file with too few aligned hours', () => {
    const rows = ['time,pm25'];
    for (let i = 0; i < 10; i++) rows.push(`${isoAt(i)},60`);
    const result = runBacktest(rows.join('\n'), history);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(new RegExp(String(MIN_ALIGNED_HOURS)));
  });

  it('rejects a file with too few distinct days', () => {
    // 48 aligned hours but all inside a single Nepal day.
    const rows = ['time,pm25'];
    // NPT day 2026-10-02 starts at 2026-10-01T18:15Z; 2026-10-02T18:15Z is 24 h later.
    for (let i = 0; i < 48; i++) {
      const t = new Date(Date.parse('2026-10-01T19:00:00Z') + i * 3_600_000)
        .toISOString()
        .replace(/\.\d{3}Z$/, 'Z');
      rows.push(`${t},60`);
    }
    const result = runBacktest(rows.join('\n'), history);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(new RegExp(String(MIN_DAYS)));
  });

  it('produces a complete report for a well-formed file', () => {
    const result = runBacktest(makeCsv(), history);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const r = result.report;
    expect(r.scheme).toBe('leave-one-day-out');
    expect(r.nHours).toBe(DAYS * HOURS_PER_DAY);
    expect(r.nDays).toBeGreaterThanOrEqual(3);
    expect(r.stationLabel).toBe('Test Station');
    expect(Number.isFinite(r.effectiveSampleSize)).toBe(true);
    expect(r.raw.n).toBe(r.nHours);
    expect(r.biasCorrected.n).toBe(r.nHours);
    for (const m of [r.raw, r.biasCorrected]) {
      for (const v of [m.r, m.mae, m.rmse, m.bias, m.nmae]) {
        expect(Number.isFinite(v)).toBe(true);
      }
      expect(m.mae).toBeGreaterThanOrEqual(0);
      expect(m.r).toBeGreaterThanOrEqual(-1);
      expect(m.r).toBeLessThanOrEqual(1);
    }
    expect(Array.isArray(r.warnings)).toBe(true);
  });

  it('recovers approximately the true a and b used to build the file', () => {
    const result = runBacktest(makeCsv({ a: 1.3, b: 12, noise: 1, seed: 999 }), history);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Loose bounds: the fit is on 7 days of autocorrelated hourly data.
    expect(result.report.fittedBias.a).toBeGreaterThan(1.1);
    expect(result.report.fittedBias.a).toBeLessThan(1.5);
    expect(result.report.fittedBias.b).toBeGreaterThan(0);
    expect(result.report.fittedBias.b).toBeLessThan(25);
  });

  it('reduces MAE after bias correction when the file really is offset', () => {
    const result = runBacktest(makeCsv({ a: 1.6, b: 25, noise: 2, seed: 4242 }), history);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.report.biasCorrected.mae).toBeLessThan(result.report.raw.mae);
  });

  it('reports conformal intervals when at least 6 days are present', () => {
    const result = runBacktest(makeCsv(), history);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.report.conformal).not.toBeNull();
    if (result.report.conformal) {
      expect(result.report.conformal.alpha).toBe(0.1);
      expect(result.report.conformal.empiricalCoverage).toBeGreaterThanOrEqual(0);
      expect(result.report.conformal.empiricalCoverage).toBeLessThanOrEqual(1);
      expect(result.report.conformal.qLog).toBeGreaterThanOrEqual(0);
    }
  });

  it('flags the exchangeability caveat for conformal coverage', () => {
    const result = runBacktest(makeCsv(), history);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.report.warnings.join(' ')).toMatch(/exchangeable/);
  });

  it('marks fittedOn so the UI can show what it was fitted on', () => {
    const result = runBacktest(makeCsv(), history);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.report.fittedBias.fittedOn).toMatch(/days, .* hours/);
  });

  it('never emits a non-finite metric, whatever the input', () => {
    const flat = Array.from({ length: 200 }, () => 50);
    const result = runBacktest(makeCsv({ a: 1, b: 0, noise: 0, seed: 7 }), historyForecast(flat));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const all = [
      ...Object.values(result.report.raw),
      ...Object.values(result.report.biasCorrected),
      result.report.effectiveSampleSize,
    ];
    for (const v of all) expect(Number.isFinite(v)).toBe(true);
  });

  it('returns ok:false with a clear reason for a malformed file, not a crash', () => {
    for (const bad of ['', 'nonsense', 'time\n2026-10-01T00:00:00Z\n', ',,\n,,\n']) {
      const result = runBacktest(bad, history);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(typeof result.reason).toBe('string');
      if (!result.ok) expect(result.reason.length).toBeGreaterThan(10);
    }
  });
});