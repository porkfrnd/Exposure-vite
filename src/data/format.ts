/** Human-facing Nepal-time formatting for the data layer. Pure. */

import { NPT_OFFSET_MIN } from '@/contracts';

const MS_PER_MIN = 60_000;
const HOUR_MS = 3_600_000;
const NPT_OFFSET_MS = NPT_OFFSET_MIN * MS_PER_MIN;

/** "4:15 PM NPT" for a UTC ISO string. Falls back to "--:--" if unparseable. */
export function formatLocalTime(iso: string): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return '--:-- NPT';
  const shifted = ms + NPT_OFFSET_MS;
  const hour = Math.floor(shifted / HOUR_MS) % 24;
  const minute = Math.floor((shifted % HOUR_MS) / MS_PER_MIN);
  const suffix = hour >= 12 ? 'PM' : 'AM';
  const h12 = hour % 12 === 0 ? 12 : hour % 12;
  return `${h12}:${String(minute).padStart(2, '0')} ${suffix} NPT`;
}
