/**
 * Forecast interpolation to an arbitrary instant.
 *
 * Every numeric forecast field is linearly interpolated; outside the covered
 * range the value is clamped to the nearest hour. Nullable fields stay null:
 * if BOTH bracketing hours are null the result is null (we never invent a value
 * from a null neighbour). A non-null value paired with a null neighbour is
 * treated as equal to the known one (null means "not reported", not "changed").
 */

import { lerpAt, sortedHours, toMs } from './time';
import type { Forecast, HourlyPoint, LatLon } from '@/contracts';

/** Flatten the forecast into parallel x/value arrays. Returns nulls for absent data. */
function axes(forecast: Forecast): {
  xs: number[];
  pm25: number[];
  aod: Array<number | null>;
  dust: Array<number | null>;
  windMs: number[];
  windDirDeg: Array<number | null>;
  blhM: Array<number | null>;
  rh01: number[];
  tempC: number[];
  precipMm: number[];
  inversionK: Array<number | null>;
} {
  const hours = sortedHours(forecast);
  return {
    xs: hours.map((h) => toMs(h.timeISO)),
    pm25: hours.map((h) => h.pm25),
    aod: hours.map((h) => h.aod),
    dust: hours.map((h) => h.dust),
    windMs: hours.map((h) => h.windMs),
    windDirDeg: hours.map((h) => h.windDirDeg),
    blhM: hours.map((h) => h.blhM),
    rh01: hours.map((h) => h.rh01),
    tempC: hours.map((h) => h.tempC),
    precipMm: hours.map((h) => h.precipMm),
    inversionK: hours.map((h) => h.inversionK),
  };
}

function sampleNullable(
  xs: readonly number[],
  ys: ReadonlyArray<number | null>,
  x: number,
): number | null {
  const n = ys.length;
  if (n === 0) return null;
  if (x <= xs[0]) return ys[0];
  if (x >= xs[n - 1]) return ys[n - 1];
  for (let i = 1; i < n; i++) {
    if (x <= xs[i]) {
      const a = ys[i - 1];
      const b = ys[i];
      if (a === null && b === null) return null;
      if (a === null) return b;
      if (b === null) return a;
      const span = xs[i] - xs[i - 1];
      if (span <= 0) return b;
      return a + ((x - xs[i - 1]) / span) * (b - a);
    }
  }
  return ys[n - 1];
}

/**
 * All-zero fallback used only when the forecast carries no usable hour, so that
 * downstream arithmetic can never see NaN/Infinity.
 */
export function degeneratePoint(timeISO: string, location: LatLon): HourlyPoint {
  return {
    timeISO,
    pm25: 0,
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

/** Interpolated forecast values at an arbitrary instant. Always finite for required fields. */
export function sampleForecast(forecast: Forecast, iso: string): HourlyPoint {
  const x = toMs(iso);
  const hours = sortedHours(forecast);
  if (hours.length === 0) return degeneratePoint(iso, forecast.location);

  const ax = axes(forecast);
  const num = (ys: readonly number[], fallback: number): number => {
    const v = lerpAt(ax.xs, ys, x);
    return v === null || !Number.isFinite(v) ? fallback : v;
  };
  const nullable = (ys: ReadonlyArray<number | null>): number | null => {
    const v = sampleNullable(ax.xs, ys, x);
    return v === null || !Number.isFinite(v) ? null : v;
  };

  const nearest =
    hours.reduce((best, h) =>
      Math.abs(toMs(h.timeISO) - x) < Math.abs(toMs(best.timeISO) - x) ? h : best,
    ) ?? hours[0];

  return {
    timeISO: iso,
    pm25: num(ax.pm25, nearest.pm25),
    aod: nullable(ax.aod),
    dust: nullable(ax.dust),
    windMs: num(ax.windMs, nearest.windMs),
    windDirDeg: nullable(ax.windDirDeg),
    blhM: nullable(ax.blhM),
    rh01: num(ax.rh01, nearest.rh01),
    tempC: num(ax.tempC, nearest.tempC),
    precipMm: num(ax.precipMm, nearest.precipMm),
    inversionK: nullable(ax.inversionK),
  };
}

/** Convenience: only the modelled background PM2.5 at an instant. */
export function samplePm25(forecast: Forecast, iso: string): number {
  return sampleForecast(forecast, iso).pm25;
}
