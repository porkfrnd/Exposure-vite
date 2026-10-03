/**
 * Forecast time handling. Pure: no Date.now(), no ambient clock.
 *
 * Convention (see src/contracts): forecast timestamps are UTC ISO strings ending
 * in "Z". "Local" means Nepal Time = UTC + NPT_OFFSET_MIN (345 min, no DST).
 */

import { NPT_OFFSET_MIN } from '@/contracts';
import type { Forecast, HourlyPoint } from '@/contracts';

const MS_PER_MIN = 60_000;
const HOUR_MS = 3_600_000;
export const NPT_OFFSET_MS = NPT_OFFSET_MIN * MS_PER_MIN;

/** Parse a timestamp to epoch ms. Returns NaN if unparseable. */
export function toMs(iso: string): number {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : NaN;
}

/** Format epoch ms as a UTC ISO string with seconds, e.g. 2026-10-02T06:00:00Z. */
export function toIso(ms: number): string {
  if (!Number.isFinite(ms)) return '1970-01-01T00:00:00Z';
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export function addMinutes(iso: string, minutes: number): string {
  return toIso(toMs(iso) + minutes * MS_PER_MIN);
}

export function addHours(iso: string, hours: number): string {
  return toIso(toMs(iso) + hours * HOUR_MS);
}

/** Floor an instant to the containing UTC hour, as an ISO string. */
export function floorToHourISO(iso: string): string {
  const ms = toMs(iso);
  if (!Number.isFinite(ms)) return iso;
  return toIso(Math.floor(ms / HOUR_MS) * HOUR_MS);
}

/**
 * Nepal *local* hour-of-day as a float in [0,24). The engine needs this as a
 * continuous quantity so that 01:15Z (07:00 NPT) reads as 7.25 and minute-level
 * departures can be compared against whole-hour rush bands.
 */
export function localHourOf(iso: string): number {
  const ms = toMs(iso);
  if (!Number.isFinite(ms)) return 0;
  const shifted = ms + NPT_OFFSET_MS;
  const hour = Math.floor(shifted / HOUR_MS) % 24;
  const minute = Math.floor((shifted % HOUR_MS) / MS_PER_MIN);
  return hour + minute / 60;
}

/** True when the Nepal local date at `iso` equals the Nepal local date at `dayStartISO`. */
export function isSameLocalDay(iso: string, dayStartISO: string): boolean {
  const day = localDayKey(iso);
  const ref = localDayKey(dayStartISO);
  return day === ref;
}

/** "YYYY-MM-DD" of the Nepal local date containing `iso`. */
export function localDayKey(iso: string): string {
  const ms = toMs(iso);
  if (!Number.isFinite(ms)) return '1970-01-01';
  return new Date(ms + NPT_OFFSET_MS).toISOString().slice(0, 10);
}

/** Start (00:00 NPT) of the Nepal local day containing `iso`, as a UTC ISO string. */
export function localDayStartISO(iso: string): string {
  const ms = toMs(iso);
  if (!Number.isFinite(ms)) return '1970-01-01T00:00:00Z';
  // Floor the NPT-shifted instant to a NPT midnight, then shift back to UTC.
  const nptMidnight = ms + NPT_OFFSET_MS - ((ms + NPT_OFFSET_MS) % (24 * HOUR_MS));
  return toIso(nptMidnight - NPT_OFFSET_MS);
}

/** 0 = Sunday … 6 = Saturday, in Nepal local time. */
export function localWeekday(iso: string): number {
  const ms = toMs(iso);
  if (!Number.isFinite(ms)) return 0;
  return new Date(ms + NPT_OFFSET_MS).getUTCDay();
}

/** Human "4:15 PM NPT" label for a UTC ISO string. */
export function formatLocalTime(iso: string): string {
  const h = localHourOf(iso);
  if (!Number.isFinite(h)) return '--:-- NPT';
  const hh = Math.floor(h);
  const mm = Math.round((h - hh) * 60);
  const suffix = hh >= 12 ? 'PM' : 'AM';
  const h12 = hh % 12 === 0 ? 12 : hh % 12;
  return `${h12}:${String(mm).padStart(2, '0')} ${suffix} NPT`;
}

/** Forecast hours sorted ascending by time. Pure; returns a new array. */
export function sortedHours(forecast: Forecast): HourlyPoint[] {
  return [...forecast.hours].sort((a, b) => toMs(a.timeISO) - toMs(b.timeISO));
}

/** Every hourly key of the forecast present, ascending. */
export function hourKeys(forecast: Forecast): number[] {
  return sortedHours(forecast).map((h) => toMs(h.timeISO));
}

/** Median of a finite copy of `values`, or null when nothing is finite. */
export function median(values: readonly number[]): number | null {
  const vs = values.filter((v) => Number.isFinite(v)).slice().sort((a, b) => a - b);
  if (vs.length === 0) return null;
  const mid = vs.length >> 1;
  return vs.length % 2 === 1 ? vs[mid] : (vs[mid - 1] + vs[mid]) / 2;
}

/** Linear interpolation of `xs`/`ys` at `x`. `xs` must be ascending. */
export function lerpAt(xs: readonly number[], ys: readonly number[], x: number): number | null {
  const n = Math.min(xs.length, ys.length);
  if (n === 0) return null;
  if (!Number.isFinite(x)) return null;
  if (x <= xs[0]) return ys[0];
  if (x >= xs[n - 1]) return ys[n - 1];
  for (let i = 1; i < n; i++) {
    if (x <= xs[i]) {
      const span = xs[i] - xs[i - 1];
      if (span <= 0) return ys[i];
      const t = (x - xs[i - 1]) / span;
      return ys[i - 1] + t * (ys[i] - ys[i - 1]);
    }
  }
  return ys[n - 1];
}
