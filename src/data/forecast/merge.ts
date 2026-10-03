/**
 * Forecast normalisation and merging.
 *
 * Open-Meteo is queried in two calls (air quality + weather), plus one small call
 * per optional variable, because the API rejects an ENTIRE request with HTTP 400 if
 * any single variable name is unknown. Isolating the optional variables means one
 * unknown name can never take down PM2.5.
 *
 * All variable names below were verified against the live endpoints. The optional
 * ones still fail soft: a failure nulls that field and nothing else.
 */

import { floorToHourISO, hourKeyMs, median, toIso } from '../time';
import type { Forecast, HourlyPoint, LatLon } from '@/contracts';

export interface RawSeries {
  /** Raw timestamp strings as returned by the API, e.g. "2026-10-02T06:00". */
  time: string[];
  [variable: string]: unknown;
}

/** "2026-10-02T06:00" → "2026-10-02T06:00:00Z". Already-Z stamps pass through. */
export function normalizeTimestamp(raw: string): string | null {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  const trimmed = raw.trim();

  // Require an unmistakable ISO date shape FIRST. Date.parse is lenient enough to
  // read strings like "not a time" as the year 2000, which would let junk into the
  // hourly series.
  const ISO_SHAPE = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2})?)?/;
  if (!ISO_SHAPE.test(trimmed)) return null;

  // A bare local-style stamp with no zone designator is UTC here because every
  // request is made with timezone=GMT.
  const hasZone = /(Z|[+-]\d{2}:?\d{2})$/.test(trimmed);
  const candidate = hasZone ? trimmed : `${trimmed}:00Z`;
  const ms = Date.parse(candidate);
  if (!Number.isFinite(ms)) return null;
  return toIso(ms);
}

function numberOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** Read `series[variable]` at index i as a finite number, else null. */
function readNumber(series: RawSeries | undefined, variable: string, i: number): number | null {
  if (!series) return null;
  const arr = series[variable];
  if (!Array.isArray(arr)) return null;
  return numberOrNull(arr[i]);
}

/** Keyed by UTC-hour epoch ms so series from different calls line up exactly. */
export type HourAccumulator = Map<number, HourlyPoint>;

function blankHour(timeISO: string, location: LatLon): HourlyPoint {
  return {
    timeISO,
    pm25: Number.NaN, // sentinel: "not yet provided"; gaps are filled or dropped later
    aod: null,
    dust: null,
    windMs: 0,
    windDirDeg: null,
    blhM: null,
    rh01: 0.5,
    tempC: 0,
    precipMm: 0,
    inversionK: null,
  };
}

function ensureHour(acc: HourAccumulator, key: number, location: LatLon): HourlyPoint {
  let point = acc.get(key);
  if (!point) {
    point = blankHour(toIso(key), location);
    acc.set(key, point);
  }
  return point;
}

export interface MergeInput {
  location: LatLon;
  /** Air-quality response, or undefined if that call failed entirely. */
  airQuality?: RawSeries;
  /** Weather response, or undefined if that call failed entirely. */
  weather?: RawSeries;
  /** Optional-variable responses, keyed by contract field name. */
  optional?: Partial<Record<'aod' | 'dust' | 'windDirDeg' | 'blhM' | 't700', RawSeries>>;
  /** Instant treated as "now" for fetchedAtISO. */
  fetchedAtISO: string;
}

/**
 * Merge every response into one ascending, deduplicated hourly series.
 * A variable is only written when a source actually provided a finite value, so a
 * null never overwrites real data and a failure never invents data.
 */
export function mergeForecast(input: MergeInput): Forecast {
  const acc: HourAccumulator = new Map();
  const { location } = input;

  const absorb = (series: RawSeries | undefined, apply: (point: HourlyPoint, i: number) => void) => {
    if (!series || !Array.isArray(series.time)) return;
    for (let i = 0; i < series.time.length; i++) {
      const iso = normalizeTimestamp(series.time[i]);
      if (!iso) continue;
      const key = hourKeyMs(iso);
      if (!Number.isFinite(key)) continue;
      apply(ensureHour(acc, key, location), i);
    }
  };

  // ── Air quality: PM2.5 is required ────────────────────────────────────────
  absorb(input.airQuality, (point, i) => {
    const pm = readNumber(input.airQuality, 'pm2_5', i);
    if (pm !== null) point.pm25 = pm;
  });

  // ── Weather: the required block ───────────────────────────────────────────
  absorb(input.weather, (point, i) => {
    const wind = readNumber(input.weather, 'wind_speed_10m', i);
    if (wind !== null) point.windMs = wind;

    // Open-Meteo reports relative humidity in PERCENT; the contract wants 0..1.
    const rhPct = readNumber(input.weather, 'relative_humidity_2m', i);
    if (rhPct !== null) point.rh01 = Math.min(1, Math.max(0, rhPct / 100));

    const temp = readNumber(input.weather, 'temperature_2m', i);
    if (temp !== null) point.tempC = temp;

    const precip = readNumber(input.weather, 'precipitation', i);
    if (precip !== null) point.precipMm = precip;
  });

  // ── Optional variables, each isolated so one failure nulls only itself ─────
  absorb(input.optional?.aod, (point, i) => {
    const v = readNumber(input.optional?.aod, 'aerosol_optical_depth', i);
    if (v !== null) point.aod = v;
  });

  absorb(input.optional?.dust, (point, i) => {
    const v = readNumber(input.optional?.dust, 'dust', i);
    if (v !== null) point.dust = v;
  });

  absorb(input.optional?.windDirDeg, (point, i) => {
    const v = readNumber(input.optional?.windDirDeg, 'wind_direction_10m', i);
    if (v !== null) point.windDirDeg = v;
  });

  absorb(input.optional?.blhM, (point, i) => {
    const v = readNumber(input.optional?.blhM, 'boundary_layer_height', i);
    if (v !== null) point.blhM = v;
  });

  // Inversion strength = T_2m − T_700hPa (K). Both must exist.
  absorb(input.optional?.t700, (point, i) => {
    const t700 = readNumber(input.optional?.t700, 'temperature_700hPa', i);
    if (t700 === null) return;
    const t2m = readNumber(input.weather, 'temperature_2m', i);
    if (t2m === null) return;
    point.inversionK = t2m - t700;
  });

  const sorted = [...acc.values()].sort((a, b) => a.timeISO.localeCompare(b.timeISO));
  const filled = fillPm25Gaps(sorted);

  return {
    source: 'live',
    fetchedAtISO: input.fetchedAtISO,
    location,
    hours: filled,
  };
}

/**
 * Fill short PM2.5 gaps by linear interpolation between the nearest known hours on
 * either side. Isolated runs with no known neighbour are DROPPED, because a
 * fabricated value would be indistinguishable from a real one downstream.
 */
export function fillPm25Gaps(points: HourlyPoint[]): HourlyPoint[] {
  const out: HourlyPoint[] = [];

  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    if (Number.isFinite(p.pm25)) {
      out.push(p);
      continue;
    }

    // Walk back and forward for the nearest finite values.
    let before: HourlyPoint | null = null;
    for (let j = i - 1; j >= 0; j--) {
      if (Number.isFinite(points[j].pm25)) {
        before = points[j];
        break;
      }
    }
    let after: HourlyPoint | null = null;
    for (let j = i + 1; j < points.length; j++) {
      if (Number.isFinite(points[j].pm25)) {
        after = points[j];
        break;
      }
    }

    if (!before || !after) continue; // no bridge ⇒ drop the hour

    const t0 = Date.parse(before.timeISO);
    const t1 = Date.parse(after.timeISO);
    const span = t1 - t0;
    const w = span > 0 ? (Date.parse(p.timeISO) - t0) / span : 0.5;
    out.push({ ...p, pm25: before.pm25 + w * (after.pm25 - before.pm25) });
  }

  return out;
}

/** Hourly series starting at the current hour, rounded down. Used by the sweep. */
export function nowHourISO(referenceISO: string): string {
  return floorToHourISO(referenceISO);
}

export { median };
