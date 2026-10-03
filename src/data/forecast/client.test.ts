import { describe, expect, it, beforeEach } from 'vitest';
import { fetchForecast, coversSpan } from './client';
import { fillPm25Gaps, mergeForecast, normalizeTimestamp } from './merge';
import { clearCache, isFresh, resetMemoryCache } from './cache';
import { syntheticForecast } from '../fixtures/syntheticForecast';
import type { ForecastLike } from './testTypes';
import type { FetchLike } from './client';
import type { Forecast } from '@/contracts';

const KTM = { lat: 27.7172, lon: 85.324 };
const NOW = Date.parse('2026-10-03T12:00:00Z');

function series(time: string[], values: Record<string, unknown>): Record<string, unknown> {
  return { time, ...values };
}

function jsonResponse(body: unknown): ReturnType<FetchLike> {
  return Promise.resolve({
    ok: true,
    status: 200,
    json: () => Promise.resolve(body),
  });
}

function errorResponse(): ReturnType<FetchLike> {
  return Promise.resolve({ ok: false, status: 400, json: () => Promise.resolve({}) });
}

const HOURS = Array.from({ length: 24 }, (_, i) => `2026-10-03T${String(i).padStart(2, '0')}:00`);

/** A fetch stub that answers by inspecting the requested variable list. */
function stubFetch(opts: {
  failVariables?: string[];
  failAll?: boolean;
  hang?: boolean;
}): FetchLike {
  return (url, init) => {
    if (opts.hang) {
      // Honour the AbortSignal exactly like the real fetch does, so the client's
      // timeout path is genuinely exercised rather than hanging the test forever.
      return new Promise((_resolve, reject) => {
        const signal = init?.signal;
        if (!signal) return;
        if (signal.aborted) {
          reject(new Error('aborted'));
          return;
        }
        signal.addEventListener('abort', () => reject(new Error('aborted')));
      });
    }
    if (opts.failAll) return errorResponse();
    const hourly = new URL(url).searchParams.get('hourly') ?? '';
    const vars = hourly.split(',');
    for (const bad of opts.failVariables ?? []) {
      if (vars.includes(bad)) return errorResponse();
    }
    const values: Record<string, unknown> = {};
    for (const v of vars) {
      if (v === 'pm2_5') values[v] = HOURS.map((_, i) => 40 + i);
      if (v === 'aerosol_optical_depth') values[v] = HOURS.map((_, i) => 0.4 + i * 0.01);
      if (v === 'dust') values[v] = HOURS.map(() => 3);
      if (v === 'wind_speed_10m') values[v] = HOURS.map(() => 2.5);
      if (v === 'wind_direction_10m') values[v] = HOURS.map(() => 180);
      if (v === 'relative_humidity_2m') values[v] = HOURS.map(() => 60);
      if (v === 'temperature_2m') values[v] = HOURS.map(() => 22);
      if (v === 'precipitation') values[v] = HOURS.map(() => 0);
      if (v === 'boundary_layer_height') values[v] = HOURS.map(() => 500);
      if (v === 'temperature_700hPa') values[v] = HOURS.map(() => 5);
    }
    return jsonResponse({ hourly: series(HOURS, values) });
  };
}

/**
 * A stub covering 2 days back and 3 days forward from the anchor, so the cached
 * forecast genuinely satisfies a pastDays=2 / forecastDays=3 request.
 */
function wideStubFetch(): FetchLike {
  return (url) => {
    const hourly = new URL(url).searchParams.get('hourly') ?? '';
    const vars = hourly.split(',');
    const startMs = NOW - 2 * 86_400_000;
    const times = Array.from({ length: 6 * 24 + 1 }, (_, i) =>
      new Date(startMs + i * 3_600_000).toISOString().replace(/\.\d{3}Z$/, 'Z').slice(0, 16),
    );
    const values: Record<string, unknown> = {};
    for (const v of vars) {
      if (v === 'pm2_5') values[v] = times.map(() => 42);
      if (v === 'wind_speed_10m') values[v] = times.map(() => 2.5);
      if (v === 'relative_humidity_2m') values[v] = times.map(() => 60);
      if (v === 'temperature_2m') values[v] = times.map(() => 22);
      if (v === 'precipitation') values[v] = times.map(() => 0);
      if (v === 'aerosol_optical_depth') values[v] = times.map(() => 0.4);
      if (v === 'dust') values[v] = times.map(() => 3);
      if (v === 'wind_direction_10m') values[v] = times.map(() => 180);
      if (v === 'boundary_layer_height') values[v] = times.map(() => 500);
      if (v === 'temperature_700hPa') values[v] = times.map(() => 5);
    }
    return jsonResponse({ hourly: series(times, values) });
  };
}

describe('normalizeTimestamp', () => {
  it('expands a bare GMT stamp to a full UTC ISO string', () => {
    expect(normalizeTimestamp('2026-10-02T06:00')).toBe('2026-10-02T06:00:00Z');
  });

  it('passes an already-zoned stamp through unchanged', () => {
    expect(normalizeTimestamp('2026-10-02T06:00:00Z')).toBe('2026-10-02T06:00:00Z');
    expect(normalizeTimestamp('2026-10-02T06:00:00+05:45')).toBe('2026-10-02T00:15:00Z');
  });

  it('returns null for junk', () => {
    expect(normalizeTimestamp('')).toBeNull();
    expect(normalizeTimestamp('not a time')).toBeNull();
  });
});

describe('mergeForecast', () => {
  it('merges air-quality and weather series into one ascending hourly run', () => {
    const merged = mergeForecast({
      location: KTM,
      airQuality: series(HOURS, { pm2_5: HOURS.map((_, i) => 40 + i) }) as never,
      weather: series(HOURS, {
        wind_speed_10m: HOURS.map(() => 2),
        relative_humidity_2m: HOURS.map(() => 65),
        temperature_2m: HOURS.map(() => 20),
        precipitation: HOURS.map(() => 0),
      }) as never,
      fetchedAtISO: '2026-10-03T12:00:00Z',
    });

    expect(merged.hours.length).toBe(24);
    expect(merged.hours[0].timeISO).toBe('2026-10-03T00:00:00Z');
    expect(merged.hours[0].pm25).toBe(40);
    expect(merged.hours[23].pm25).toBe(63);
    // Percent → 0..1 fraction.
    expect(merged.hours[0].rh01).toBeCloseTo(0.65, 12);
    expect(merged.source).toBe('live');
  });

  it('leaves optional fields null when they were not requested', () => {
    const merged = mergeForecast({
      location: KTM,
      airQuality: series(HOURS, { pm2_5: HOURS.map(() => 40) }) as never,
      weather: series(HOURS, {
        wind_speed_10m: HOURS.map(() => 2),
        relative_humidity_2m: HOURS.map(() => 50),
        temperature_2m: HOURS.map(() => 20),
        precipitation: HOURS.map(() => 0),
      }) as never,
      fetchedAtISO: '2026-10-03T12:00:00Z',
    });
    expect(merged.hours[0].aod).toBeNull();
    expect(merged.hours[0].dust).toBeNull();
    expect(merged.hours[0].blhM).toBeNull();
    expect(merged.hours[0].windDirDeg).toBeNull();
    expect(merged.hours[0].inversionK).toBeNull();
  });

  it('computes inversion strength as T_2m − T_700hPa', () => {
    const merged = mergeForecast({
      location: KTM,
      airQuality: series(HOURS, { pm2_5: HOURS.map(() => 40) }) as never,
      weather: series(HOURS, {
        wind_speed_10m: HOURS.map(() => 2),
        relative_humidity_2m: HOURS.map(() => 50),
        temperature_2m: HOURS.map(() => 20),
        precipitation: HOURS.map(() => 0),
      }) as never,
      optional: { t700: series(HOURS, { temperature_700hPa: HOURS.map(() => 6) }) as never },
      fetchedAtISO: '2026-10-03T12:00:00Z',
    });
    expect(merged.hours[0].inversionK).toBeCloseTo(14, 12);
  });

  it('fills a short pm25 gap by interpolation', () => {
    const withGap: Forecast['hours'] = [
      { ...blankPoint('2026-10-03T00:00:00Z'), pm25: 40 },
      { ...blankPoint('2026-10-03T01:00:00Z'), pm25: Number.NaN },
      { ...blankPoint('2026-10-03T02:00:00Z'), pm25: 60 },
    ];
    const filled = fillPm25Gaps(withGap);
    expect(filled.length).toBe(3);
    expect(filled[1].pm25).toBe(50);
  });

  it('drops a run with no bridgeable neighbour rather than inventing a value', () => {
    const isolated: Forecast['hours'] = [
      { ...blankPoint('2026-10-03T00:00:00Z'), pm25: 40 },
      { ...blankPoint('2026-10-03T01:00:00Z'), pm25: Number.NaN },
      { ...blankPoint('2026-10-03T02:00:00Z'), pm25: Number.NaN },
      { ...blankPoint('2026-10-03T03:00:00Z'), pm25: Number.NaN },
    ];
    const filled = fillPm25Gaps(isolated);
    expect(filled.length).toBe(1);
    expect(filled[0].pm25).toBe(40);
  });
});

function blankPoint(timeISO: string) {
  return {
    timeISO,
    pm25: Number.NaN,
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

describe('fetchForecast', () => {
  beforeEach(() => {
    clearCache();
    resetMemoryCache();
  });

  it('returns a live forecast when everything works', async () => {
    const fc = await fetchForecast({ lat: KTM.lat, lon: KTM.lon }, { nowMs: NOW, useCache: false, fetchImpl: stubFetch({}) });
    expect(fc.source).toBe('live');
    expect(fc.hours.length).toBe(24);
    expect(fc.hours[0].aod).toBeCloseTo(0.4, 12);
    expect(fc.hours[0].blhM).toBe(500);
    expect(fc.hours[0].windDirDeg).toBe(180);
    expect(fc.hours[0].inversionK).toBeCloseTo(17, 12);
  });

  it('nulls only the optional variable whose request failed', async () => {
    const fc = await fetchForecast(
      { lat: KTM.lat, lon: KTM.lon },
      { nowMs: NOW, useCache: false, fetchImpl: stubFetch({ failVariables: ['boundary_layer_height', 'dust'] }) },
    );
    expect(fc.source).toBe('live');
    expect(fc.hours.length).toBe(24);
    expect(fc.hours[0].pm25).toBe(40);
    expect(fc.hours[0].blhM).toBeNull();
    expect(fc.hours[0].dust).toBeNull();
    // The optional variables that DID work are still present.
    expect(fc.hours[0].aod).toBeCloseTo(0.4, 12);
    expect(fc.hours[0].windDirDeg).toBe(180);
  });

  it('falls back to the SYNTHETIC fixture when the required call fails', async () => {
    const fc = await fetchForecast(
      { lat: KTM.lat, lon: KTM.lon },
      { nowMs: NOW, useCache: false, fetchImpl: stubFetch({ failVariables: ['pm2_5'] }) },
    );
    expect(fc.source).toBe('fixture');
    expect(fc.hours.length).toBeGreaterThan(24);
    expect(fc.hours.every((h) => Number.isFinite(h.pm25) && h.pm25 > 0)).toBe(true);
  });

  it('falls back to the SYNTHETIC fixture when every request fails', async () => {
    const fc = await fetchForecast(
      { lat: KTM.lat, lon: KTM.lon },
      { nowMs: NOW, useCache: false, fetchImpl: stubFetch({ failAll: true }) },
    );
    expect(fc.source).toBe('fixture');
  });

  it('falls back to the SYNTHETIC fixture when the network hangs', async () => {
    const fc = await fetchForecast(
      { lat: KTM.lat, lon: KTM.lon },
      { nowMs: NOW, useCache: false, timeoutMs: 40, fetchImpl: stubFetch({ hang: true }) },
    );
    expect(fc.source).toBe('fixture');
  });

  it('reports the fixture honestly: unknown offline fields stay null', async () => {
    const fc = syntheticForecast('2026-10-03T12:00:00Z');
    expect(fc.source).toBe('fixture');
    expect(fc.hours.every((h) => h.aod === null)).toBe(true);
    expect(fc.hours.every((h) => h.dust === null)).toBe(true);
    expect(fc.hours.every((h) => h.windDirDeg === null)).toBe(true);
    expect(fc.hours.every((h) => h.inversionK === null)).toBe(true);
  });

  it('anchors the synthetic fixture to the given instant so dates are never stale', async () => {
    const fc = syntheticForecast('2026-10-03T12:00:00Z');
    expect(fc.fetchedAtISO).toBe('2026-10-03T12:00:00Z');
    // Spans 2 days back and 3 days forward by default ⇒ 121 hourly points.
    expect(fc.hours.length).toBe(121);
    expect(fc.hours[0].timeISO).toBe('2026-10-01T12:00:00Z');
    expect(fc.hours[fc.hours.length - 1].timeISO).toBe('2026-10-06T12:00:00Z');
  });

  it('is deterministic for a given anchor', () => {
    const a = syntheticForecast('2026-10-03T12:00:00Z');
    const b = syntheticForecast('2026-10-03T12:00:00Z');
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('has a realistic diurnal shape: morning and evening peaks, afternoon dip', () => {
    const fc = syntheticForecast('2026-10-03T12:00:00Z');
    const byLocalHour = new Map<number, number[]>();
    for (const h of fc.hours) {
      const ms = Date.parse(h.timeISO) + 345 * 60_000;
      const lh = Math.floor((ms / 3_600_000) % 24);
      const list = byLocalHour.get(lh);
      if (list) list.push(h.pm25);
      else byLocalHour.set(lh, [h.pm25]);
    }
    const meanAt = (lh: number): number => {
      const list = byLocalHour.get(lh);
      if (!list || list.length === 0) return 0;
      return list.reduce((a, b) => a + b, 0) / list.length;
    };

    const morning = meanAt(7);
    const afternoon = meanAt(15);
    const evening = meanAt(20);
    expect(morning).toBeGreaterThan(afternoon);
    expect(evening).toBeGreaterThan(afternoon);
  });
});

describe('cache', () => {
  beforeEach(() => {
    clearCache();
    resetMemoryCache();
  });

  it('treats a forecast inside the 30-minute TTL as fresh', () => {
    const fc = syntheticForecast('2026-10-03T12:00:00Z');
    expect(isFresh(fc, Date.parse('2026-10-03T12:29:00Z'))).toBe(true);
    expect(isFresh(fc, Date.parse('2026-10-03T12:31:00Z'))).toBe(false);
  });

  it('survives a second call inside the TTL without touching the network', async () => {
    // Prime the cache with a real (successful) fetch.
    const fc1 = await fetchForecast(
      { lat: KTM.lat, lon: KTM.lon, pastDays: 2, forecastDays: 3 },
      { nowMs: NOW, useCache: true, fetchImpl: wideStubFetch() },
    );
    expect(fc1.source).toBe('live');

    let called = 0;
    const fc2 = await fetchForecast(
      { lat: KTM.lat, lon: KTM.lon, pastDays: 2, forecastDays: 3 },
      {
        nowMs: NOW + 60_000,
        fetchImpl: () => {
          called++;
          return errorResponse();
        },
      },
    );
    expect(called).toBe(0);
    expect(fc2.source).toBe('cached');
  });

  it('does not serve a cache that does not cover the requested span', () => {
    const fc = syntheticForecast('2026-10-03T12:00:00Z', KTM, 1, 1);
    expect(coversSpan(fc, 2, 3)).toBe(false);
    expect(coversSpan(fc, 1, 1)).toBe(true);
  });

  it('works when localStorage throws', async () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get() {
        throw new Error('storage disabled');
      },
    });
    try {
      const fc = await fetchForecast(
        { lat: KTM.lat, lon: KTM.lon },
        { nowMs: NOW, useCache: true, fetchImpl: stubFetch({}) },
      );
      expect(fc.source).toBe('live');
    } finally {
      if (original) Object.defineProperty(globalThis, 'localStorage', original);
    }
  });
});

// Type-only guard so the helper import above is meaningful.
export type { ForecastLike };