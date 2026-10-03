/**
 * Minimal time helpers for the data layer.
 *
 * The architecture rule is that src/data/** may import ONLY "@/contracts", so
 * these few pure helpers are duplicated here rather than imported from
 * src/engine/time.ts. They are intentionally a strict subset of the engine's
 * helpers and are covered by the data-layer tests.
 *
 * Pure: no Date.now(), no Math.random().
 */

import { NPT_OFFSET_MIN } from '@/contracts';

const MS_PER_MIN = 60_000;
const HOUR_MS = 3_600_000;
export const NPT_OFFSET_MS = NPT_OFFSET_MIN * MS_PER_MIN;

export function toMs(iso: string): number {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : NaN;
}

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

export function floorToHourISO(iso: string): string {
  const ms = toMs(iso);
  if (!Number.isFinite(ms)) return iso;
  return toIso(Math.floor(ms / HOUR_MS) * HOUR_MS);
}

/** Nepal local hour-of-day as a float in [0,24). 01:15Z is 7.25 (07:15 NPT). */
export function localHourOf(iso: string): number {
  const ms = toMs(iso);
  if (!Number.isFinite(ms)) return 0;
  const shifted = ms + NPT_OFFSET_MS;
  const hour = Math.floor(shifted / HOUR_MS) % 24;
  const minute = Math.floor((shifted % HOUR_MS) / MS_PER_MIN);
  return hour + minute / 60;
}

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

/** Floor an instant to the containing UTC hour and return its ms value. */
export function hourKeyMs(iso: string): number {
  const ms = toMs(iso);
  if (!Number.isFinite(ms)) return NaN;
  return Math.floor(ms / HOUR_MS) * HOUR_MS;
}

/** Median of the finite subset of `values`, or null. */
export function median(values: readonly number[]): number | null {
  const vs = values.filter((v) => Number.isFinite(v)).slice().sort((a, b) => a - b);
  if (vs.length === 0) return null;
  const mid = vs.length >> 1;
  return vs.length % 2 === 1 ? vs[mid] : (vs[mid - 1] + vs[mid]) / 2;
}

export { formatLocalTime } from './format';
