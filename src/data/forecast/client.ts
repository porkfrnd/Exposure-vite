/**
 * Open-Meteo forecast client.
 *
 * VERIFIED against the live endpoints on 2026-10-03 — every variable name below
 * returned HTTP 200 with the expected hourly key:
 *   air-quality: pm2_5, aerosol_optical_depth, dust
 *   forecast:    temperature_2m, relative_humidity_2m, precipitation,
 *                wind_speed_10m, wind_direction_10m,
 *                boundary_layer_height, temperature_700hPa
 *
 * The optional variables are still fetched one-per-request on purpose: Open-Meteo
 * rejects a whole request with HTTP 400 if it does not recognise a single name, so
 * batching them would let one unknown name destroy PM2.5 as well.
 *
 * Every failure path degrades to the clearly-labelled SYNTHETIC fixture rather than
 * throwing, so the demo never shows an error screen instead of a map.
 */

import { KATHMANDU } from '@/contracts';
import { toIso } from '../time';
import { mergeForecast } from './merge';
import type { RawSeries } from './merge';
import { readCache, writeCache } from './cache';
import { syntheticForecast } from '../fixtures/syntheticForecast';
import type { Forecast, LatLon } from '@/contracts';

export const AIR_QUALITY_URL = 'https://air-quality-api.open-meteo.com/v1/air-quality';
export const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';

export const REQUEST_TIMEOUT_MS = 8_000;

/** REQUIRED_AIR — a failure here means we cannot produce a live forecast at all. */
const REQUIRED_AIR = ['pm2_5'];

/** REQUIRED_WEATHER — temperature/rh/precip also gate the PM2.5 product. */
const REQUIRED_WEATHER = [
  'temperature_2m',
  'relative_humidity_2m',
  'precipitation',
  'wind_speed_10m',
];

export interface GetForecastOptions {
  lat?: number;
  lon?: number;
  pastDays?: number;
  forecastDays?: number;
}

export type FetchLike = (
  input: string,
  init?: { signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

/** Default fetch, resolved lazily so tests can inject their own without globals. */
function defaultFetch(): FetchLike {
  const g = globalThis as unknown as { fetch?: FetchLike };
  if (!g.fetch) throw new Error('fetch is unavailable in this environment');
  return g.fetch.bind(globalThis) as FetchLike;
}

async function getJson(
  url: string,
  doFetch: FetchLike,
  timeoutMs: number,
): Promise<RawSeries | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await doFetch(url, { signal: controller.signal });
    if (!res.ok) return null;
    const body = (await res.json()) as { hourly?: RawSeries; error?: boolean; reason?: string };
    if (!body || typeof body !== 'object') return null;
    if (body.error === true) return null;
    if (!body.hourly || !Array.isArray(body.hourly.time)) return null;
    return body.hourly;
  } catch {
    // Network error, abort/timeout, or malformed JSON: all mean "no data".
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function airQualityUrl(loc: LatLon, pastDays: number, forecastDays: number): string {
  const params = new URLSearchParams({
    latitude: String(loc.lat),
    longitude: String(loc.lon),
    hourly: REQUIRED_AIR.join(','),
    timezone: 'GMT',
    wind_speed_unit: 'ms',
    past_days: String(pastDays),
    forecast_days: String(forecastDays),
  });
  return `${AIR_QUALITY_URL}?${params.toString()}`;
}

function weatherUrl(loc: LatLon, pastDays: number, forecastDays: number): string {
  const params = new URLSearchParams({
    latitude: String(loc.lat),
    longitude: String(loc.lon),
    hourly: REQUIRED_WEATHER.join(','),
    timezone: 'GMT',
    wind_speed_unit: 'ms',
    past_days: String(pastDays),
    forecast_days: String(forecastDays),
  });
  return `${FORECAST_URL}?${params.toString()}`;
}

/** One small request for a single optional variable. */
function optionalUrl(base: string, variable: string, loc: LatLon, pastDays: number, forecastDays: number): string {
  const params = new URLSearchParams({
    latitude: String(loc.lat),
    longitude: String(loc.lon),
    hourly: variable,
    timezone: 'GMT',
    wind_speed_unit: 'ms',
    past_days: String(pastDays),
    forecast_days: String(forecastDays),
  });
  return `${base}?${params.toString()}`;
}

export interface GetForecastDeps {
  fetchImpl?: FetchLike;
  nowMs: number;
  timeoutMs?: number;
  /** Set false in tests that must not touch localStorage. */
  useCache?: boolean;
}

export async function fetchForecast(
  opts: GetForecastOptions,
  deps: GetForecastDeps,
): Promise<Forecast> {
  const loc: LatLon = { lat: opts.lat ?? KATHMANDU.lat, lon: opts.lon ?? KATHMANDU.lon };
  const pastDays = Number.isFinite(opts.pastDays) ? Math.max(0, opts.pastDays as number) : 2;
  const forecastDays = Number.isFinite(opts.forecastDays)
    ? Math.max(0, opts.forecastDays as number)
    : 3;
  const useCache = deps.useCache !== false;
  const timeoutMs = deps.timeoutMs ?? REQUEST_TIMEOUT_MS;

  const anchorISO = toIso(deps.nowMs);

  if (useCache) {
    // Only serve a cache hit when the requested span is covered by it.
    const hit = readCache(deps.nowMs, loc);
    if (hit && coversSpan(hit, pastDays, forecastDays)) {
      return { ...hit, source: 'cached' };
    }
  }

  let doFetch: FetchLike;
  try {
    doFetch = deps.fetchImpl ?? defaultFetch();
  } catch {
    return syntheticForecast(anchorISO, loc, pastDays, forecastDays);
  }

  const [air, weather] = await Promise.all([
    getJson(airQualityUrl(loc, pastDays, forecastDays), doFetch, timeoutMs),
    getJson(weatherUrl(loc, pastDays, forecastDays), doFetch, timeoutMs),
  ]);

  if (!air || !weather) {
    // Required block unavailable ⇒ synthetic fallback, clearly labelled 'fixture'.
    return syntheticForecast(anchorISO, loc, pastDays, forecastDays);
  }

  // Optional variables, each in its own request and each independently optional.
  const optionalKeys = [
    ['aod', AIR_QUALITY_URL, 'aerosol_optical_depth'],
    ['dust', AIR_QUALITY_URL, 'dust'],
    ['windDirDeg', FORECAST_URL, 'wind_direction_10m'],
    ['blhM', FORECAST_URL, 'boundary_layer_height'],
    ['t700', FORECAST_URL, 'temperature_700hPa'],
  ] as const;

  const optionalResults = await Promise.all(
    optionalKeys.map(async ([key, base, variable]) => {
      const series = await getJson(
        optionalUrl(base, variable, loc, pastDays, forecastDays),
        doFetch,
        timeoutMs,
      );
      return [key, series] as const;
    }),
  );

  const optional: Partial<Record<(typeof optionalKeys)[number][0], RawSeries>> = {};
  for (const [key, series] of optionalResults) {
    if (series) optional[key] = series;
  }

  const merged = mergeForecast({
    location: loc,
    airQuality: air,
    weather,
    optional,
    fetchedAtISO: anchorISO,
  });

  if (merged.hours.length === 0) {
    // Every PM2.5 hour was dropped (no bridgeable values) ⇒ synthetic fallback.
    return syntheticForecast(anchorISO, loc, pastDays, forecastDays);
  }

  if (useCache) writeCache(merged);

  return merged;
}

/** Does a cached forecast reach far enough into the past and future? */
export function coversSpan(fc: Forecast, pastDays: number, forecastDays: number): boolean {
  const times = fc.hours.map((h) => Date.parse(h.timeISO)).filter((t) => Number.isFinite(t));
  if (times.length === 0) return false;
  const fetched = Date.parse(fc.fetchedAtISO);
  if (!Number.isFinite(fetched)) return false;
  const min = Math.min(...times);
  const max = Math.max(...times);
  const needPast = fetched - pastDays * 86_400_000;
  const needFuture = fetched + forecastDays * 86_400_000;
  return min <= needPast + 3_600_000 && max >= needFuture - 3_600_000;
}
