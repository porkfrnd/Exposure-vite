/**
 * Forecast cache: in-memory plus localStorage, TTL 30 minutes.
 *
 * Every storage access is wrapped in try/catch so the app works in private-browsing
 * modes and wherever localStorage throws (AC-13, AC-17).
 */

import { toMs } from '../time';
import type { Forecast } from '@/contracts';

export const CACHE_TTL_MIN = 30;
const STORAGE_KEY = 'exposure-vite:forecast:v1';

let memory: Forecast | null = null;

function ttlMs(): number {
  return CACHE_TTL_MIN * 60_000;
}

/** True when a forecast is still inside the TTL. */
export function isFresh(fc: Forecast, nowMs: number): boolean {
  const fetched = toMs(fc.fetchedAtISO);
  if (!Number.isFinite(fetched)) return false;
  const age = nowMs - fetched;
  // A forecast from the future (clock skew) is treated as fresh rather than rejected.
  return age < ttlMs();
}

export function readCache(nowMs: number, match: { lat: number; lon: number }): Forecast | null {
  if (memory && isFresh(memory, nowMs) && samePlace(memory, match)) return memory;

  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Forecast;
    if (!parsed || !Array.isArray(parsed.hours) || parsed.hours.length === 0) return null;
    if (!isFresh(parsed, nowMs) || !samePlace(parsed, match)) return null;
    memory = parsed;
    return parsed;
  } catch {
    // Storage unavailable or corrupt — treat as a miss. Never throw.
    return null;
  }
}

export function writeCache(fc: Forecast): void {
  memory = fc;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(fc));
  } catch {
    // Quota exceeded or storage disabled — the in-memory copy still works.
  }
}

export function clearCache(): void {
  memory = null;
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
}

function samePlace(fc: Forecast, match: { lat: number; lon: number }): boolean {
  // A grid model snaps to a cell, so compare loosely (~1 km).
  return Math.abs(fc.location.lat - match.lat) < 0.01 && Math.abs(fc.location.lon - match.lon) < 0.01;
}

/** Test hook: drop the in-memory copy without touching storage. */
export function resetMemoryCache(): void {
  memory = null;
}
