/**
 * CSV parsing for a user-supplied station file.
 *
 * INTEGRITY: this app ships NO station data. The only CSVs that ever enter this
 * module are ones the user supplies themselves, and every number derived from them
 * is labelled as coming from that file. Nothing here is a fixture or an example.
 */

import { NPT_OFFSET_MIN } from '@/contracts';
import { localDayKey, toIso } from '../time';
import type { BiasModel } from '@/contracts';

export interface StationSample {
  /** UTC ISO string on the hour. */
  timeISO: string;
  value: number;
}

export interface ParsedCsv {
  samples: StationSample[];
  /** Single-valued station/name column, else null. */
  stationLabel: string | null;
  warnings: string[];
}

const TIME_HEADERS = ['time', 'datetime', 'date', 'timestamp', 'time_iso', 'utc'];
const VALUE_HEADERS = ['pm25', 'pm2.5', 'pm2_5', 'value', 'pm25_ugm3', 'pm25_ug/m3', 'concentration'];
const LABEL_HEADERS = ['station', 'station_name', 'name', 'site', 'location', 'sensor'];

/** Split one CSV line, honouring double-quoted fields and doubled quotes. */
export function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

function normalizeHeader(h: string): string {
  return h.trim().toLowerCase().replace(/\s+/g, '_');
}

/** Strip surrounding quotes and whitespace; '' for empty. */
function cell(raw: string | undefined): string {
  if (raw === undefined) return '';
  return raw.replace(/^"+|"+$/g, '').trim();
}

const HAS_OFFSET = /(Z|[+-]\d{2}:?\d{2})$/i;
const NAIVE_PARTS = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/;

/**
 * Parse a station timestamp WITHOUT ever consulting the machine's timezone.
 *
 * This matters: `Date.parse('2026-10-01 06:45')` interprets a zone-less stamp in
 * the HOST's local zone. On a machine set to Asia/Katmandu that silently applies
 * +05:45, so a naive parse-and-shift would double-count the offset — and on a
 * machine in Europe/Berlin it would be wrong by a different amount entirely. We
 * therefore read the fields ourselves and pin the zone explicitly, which makes the
 * result identical on every device.
 *
 * @returns epoch ms, or NaN when the stamp is unusable.
 */
export function parseStationTimestamp(raw: string): number {
  if (typeof raw !== 'string') return NaN;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return NaN;

  if (HAS_OFFSET.test(trimmed)) {
    const ms = Date.parse(trimmed);
    return Number.isFinite(ms) ? ms : NaN;
  }

  const m = NAIVE_PARTS.exec(trimmed);
  if (!m) return NaN;
  const [, y, mo, d, h, mi, sec] = m;
  const asUtc = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(sec ?? 0));
  if (!Number.isFinite(asUtc)) return NaN;

  // No zone designator: the only defensible assumption is Nepal Time, because that
  // is where this app operates. Shift back to UTC.
  return asUtc - NPT_OFFSET_MIN * 60_000;
}

/** True when the stamp carried no zone designator and was therefore assumed NPT. */
export function assumedNepalTime(raw: string): boolean {
  return typeof raw === 'string' && !HAS_OFFSET.test(raw.trim());
}

/**
 * Parse a station CSV into hourly UTC samples.
 * Sub-hourly rows are aggregated to hourly means.
 */
export function parseStationCsv(text: string): ParsedCsv {
  const warnings: string[] = [];
  const empty: ParsedCsv = { samples: [], stationLabel: null, warnings };

  if (typeof text !== 'string' || text.trim().length === 0) {
    return { ...empty, warnings: ['file is empty'] };
  }

  // Handle CRLF and lone CR.
  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  const nonEmpty = lines.filter((l) => l.trim().length > 0);
  if (nonEmpty.length < 2) {
    return { ...empty, warnings: ['need a header row and at least one data row'] };
  }

  const header = splitCsvLine(nonEmpty[0]).map(normalizeHeader);
  const timeIdx = header.findIndex((h) => TIME_HEADERS.includes(h));
  const valueIdx = header.findIndex((h) => VALUE_HEADERS.includes(h));

  if (timeIdx < 0 || valueIdx < 0) {
    return {
      ...empty,
      warnings: [
        `could not find the needed columns (looked for time in [${TIME_HEADERS.join(', ')}] ` +
          `and pm25 in [${VALUE_HEADERS.join(', ')}], saw [${header.join(', ')}])`,
      ],
    };
  }

  const labelIdx = header.findIndex((h) => LABEL_HEADERS.includes(h));

  const buckets = new Map<number, number[]>();
  const labelValues = new Set<string>();
  let assumedZone = false;
  let droppedInvalid = 0;

  for (let i = 1; i < nonEmpty.length; i++) {
    const cols = splitCsvLine(nonEmpty[i]);
    const rawTime = cell(cols[timeIdx]);
    const rawValue = cell(cols[valueIdx]);
    if (rawTime === '' && rawValue === '') continue;

    const value = Number(rawValue);
    if (!Number.isFinite(value) || value < 0) {
      droppedInvalid++;
      continue;
    }

    let ms = parseStationTimestamp(rawTime);
    if (!Number.isFinite(ms)) {
      droppedInvalid++;
      continue;
    }
    if (assumedNepalTime(rawTime)) assumedZone = true;

    const key = Math.floor(ms / 3_600_000) * 3_600_000;
    const list = buckets.get(key);
    if (list) list.push(value);
    else buckets.set(key, [value]);

    if (labelIdx >= 0) {
      const lbl = cell(cols[labelIdx]);
      if (lbl) labelValues.add(lbl);
    }
  }

  if (droppedInvalid > 0) {
    warnings.push(`dropped ${droppedInvalid} row(s) with a missing, non-numeric or negative value`);
  }
  if (assumedZone) {
    warnings.push('timestamps had no UTC offset; they were interpreted as Nepal Time (UTC+05:45)');
  }

  const samples: StationSample[] = [...buckets.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([key, values]) => ({
      timeISO: toIso(key),
      value: values.reduce((a, b) => a + b, 0) / values.length,
    }));

  // A "station label" only makes sense when every row agrees on one.
  const stationLabel = labelValues.size === 1 ? [...labelValues][0] : null;
  if (labelValues.size > 1) {
    warnings.push('file contains more than one station name; metrics are reported without a label');
  }

  return { samples, stationLabel, warnings };
}

// ── Metrics (methodology 9.2) ────────────────────────────────────────────────

export function pearson(xs: number[], ys: number[]): number {
  const n = Math.min(xs.length, ys.length);
  if (n < 2) return 0;
  let mx = 0;
  let my = 0;
  for (let i = 0; i < n; i++) {
    mx += xs[i];
    my += ys[i];
  }
  mx /= n;
  my /= n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx;
    const dy = ys[i] - my;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }
  const den = Math.sqrt(sxx * syy);
  if (den <= 0) return 0;
  const r = sxy / den;
  return Math.max(-1, Math.min(1, r));
}

export function metricSet(pred: number[], obs: number[]): {
  n: number;
  r: number;
  mae: number;
  rmse: number;
  bias: number;
  nmae: number;
} {
  const n = Math.min(pred.length, obs.length);
  if (n === 0) return { n: 0, r: 0, mae: 0, rmse: 0, bias: 0, nmae: 0 };
  let abs = 0;
  let sq = 0;
  let bias = 0;
  let obsMean = 0;
  for (let i = 0; i < n; i++) {
    const d = pred[i] - obs[i];
    abs += Math.abs(d);
    sq += d * d;
    bias += d;
    obsMean += obs[i];
  }
  obsMean /= n;
  const mae = abs / n;
  return {
    n,
    r: pearson(pred.slice(0, n), obs.slice(0, n)),
    mae,
    rmse: Math.sqrt(sq / n),
    bias: bias / n,
    nmae: obsMean > 0 ? mae / obsMean : 0,
  };
}

/** Least-squares fit of obs ≈ a·pred + b. */
export function fitLinear(pred: number[], obs: number[]): { a: number; b: number } {
  const n = Math.min(pred.length, obs.length);
  if (n === 0) return { a: 1, b: 0 };
  let mp = 0;
  let mo = 0;
  for (let i = 0; i < n; i++) {
    mp += pred[i];
    mo += obs[i];
  }
  mp /= n;
  mo /= n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (pred[i] - mp) * (obs[i] - mo);
    den += (pred[i] - mp) ** 2;
  }
  if (den <= 0) return { a: 1, b: mo - mp };
  const a = num / den;
  return { a, b: mo - a * mp };
}

/** Lag-1 autocorrelation of a series, clamped to [0, 0.99]. */
export function lag1Autocorrelation(series: number[]): number {
  const n = series.length;
  if (n < 3) return 0;
  const mean = series.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) den += (series[i] - mean) ** 2;
  for (let i = 1; i < n; i++) num += (series[i] - mean) * (series[i - 1] - mean);
  const r = den > 0 ? num / den : 0;
  return Math.max(0, Math.min(0.99, Number.isFinite(r) ? r : 0));
}

/** Effective sample size n(1−ρ₁)/(1+ρ₁) for autocorrelated data. */
export function effectiveSampleSize(n: number, rho1: number): number {
  const r = Math.max(0, Math.min(0.99, rho1));
  return (n * (1 - r)) / (1 + r);
}

export { localDayKey };
export type { BiasModel };