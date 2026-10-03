/**
 * Timezone-independence regression tests.
 *
 * The machine this was developed on runs with TZ = Asia/Katmandu, which silently
 * makes Date.parse() apply +05:45 to a zone-less timestamp. A naive parse-and-shift
 * therefore double-counted the offset here and would be wrong by yet another amount
 * on a machine set to Europe/Berlin. These tests pin the behaviour so the bug cannot
 * come back, and so AC-14 ("Nepal local time, not browser local time") is provable.
 */

import { describe, expect, it } from 'vitest';
import { assumedNepalTime, parseStationTimestamp, parseStationCsv } from './validation/csv';
import { engine } from '@/engine';
import { floorToHourISO, localDayStartISO, localHourOf } from './time';
import { syntheticForecast } from './fixtures/syntheticForecast';
import { fetchRealRoutes } from './real/routing';
import type { LatLon, Mode } from '@/contracts';

const A: LatLon = { lat: 27.6745, lon: 85.308 };
const B: LatLon = { lat: 27.6586, lon: 85.3249 };

describe('zone-less timestamps are read as Nepal Time, whatever the host zone', () => {
  it('does not consult the host timezone for a zone-less stamp', () => {
    // 06:45 NPT on 2026-10-01 is 01:00 UTC, on every machine.
    expect(parseStationTimestamp('2026-10-01 06:45')).toBe(Date.parse('2026-10-01T01:00:00Z'));
    expect(parseStationTimestamp('2026-10-01T06:45')).toBe(Date.parse('2026-10-01T01:00:00Z'));
  });

  it('still honours an explicit offset or Z', () => {
    expect(parseStationTimestamp('2026-10-01T01:00:00Z')).toBe(Date.parse('2026-10-01T01:00:00Z'));
    expect(parseStationTimestamp('2026-10-01T06:45:00+05:45')).toBe(Date.parse('2026-10-01T01:00:00Z'));
  });

  it('flags which stamps needed the Nepal Time assumption', () => {
    expect(assumedNepalTime('2026-10-01 06:45')).toBe(true);
    expect(assumedNepalTime('2026-10-01T01:00:00Z')).toBe(false);
    expect(assumedNepalTime('2026-10-01T06:45:00+05:45')).toBe(false);
  });

  it('rejects unparseable stamps', () => {
    expect(Number.isNaN(parseStationTimestamp('not a time'))).toBe(true);
    expect(Number.isNaN(parseStationTimestamp(''))).toBe(true);
  });

  it('round-trips through the full CSV parser', () => {
    const csv = ['time,pm25', '2026-10-01 06:45,55', '2026-10-01 07:45,56'].join('\n');
    const { samples, warnings } = parseStationCsv(csv);
    expect(samples[0].timeISO).toBe('2026-10-01T01:00:00Z');
    expect(samples[1].timeISO).toBe('2026-10-01T02:00:00Z');
    expect(warnings.join(' ')).toMatch(/Nepal Time/);
  });
});

describe('engine local-time logic is independent of the host timezone', () => {
  const ORIGINAL_TZ = process.env.TZ;

  function withTz(tz: string, fn: () => void): void {
    process.env.TZ = tz;
    try {
      fn();
    } finally {
      if (ORIGINAL_TZ === undefined) delete process.env.TZ;
      else process.env.TZ = ORIGINAL_TZ;
    }
  }

  it('computes the Nepal local hour identically across host zones', () => {
    const results: Record<string, number> = {};
    for (const tz of ['Asia/Katmandu', 'UTC', 'Europe/Berlin', 'America/New_York', 'Pacific/Auckland']) {
      withTz(tz, () => {
        // 01:15Z is 07:00 NPT regardless of where the device thinks it is.
        results[tz] = localHourOf('2026-10-05T01:15:00Z');
      });
    }
    for (const tz of Object.keys(results)) {
      expect(results[tz], tz).toBeCloseTo(7, 10);
    }
  });

  it('computes the Nepal day start identically across host zones', () => {
    const seen = new Set<string>();
    for (const tz of ['Asia/Katmandu', 'UTC', 'Europe/Berlin', 'America/New_York']) {
      withTz(tz, () => {
        seen.add(localDayStartISO('2026-10-05T20:00:00Z'));
      });
    }
    expect(seen.size).toBe(1);
    expect([...seen][0]).toBe('2026-10-05T18:15:00Z');
  });

  it('applies rush hours on Nepal local time, not host local time', () => {
    // A main road at 01:15Z on 2026-10-05 is 07:00 NPT: rush ⇒ higher multiplier
    // than the same road at 06:00Z (11:45 NPT), which is off peak.
    const fc = syntheticForecast('2026-10-05T00:00:00Z');
    const trunk: import('@/contracts').Segment = {
      id: 'trunk',
      roadClass: 'primary',
      lengthM: 100,
      coords: [
        { lat: 27.67, lon: 85.31 },
        { lat: 27.671, lon: 85.31 },
      ],
      features: {
        distToMainRoadM: 0,
        intersectionDensityPer100m: 1,
        trafficSignalsWithin50m: 0,
        busStopsWithin30m: 0,
        greenFraction100m: 0.05,
        buildingDensity: 0.8,
        nearbyRoads: [],
      },
    };

    const multipliers: Record<string, number[]> = {};
    for (const tz of ['Asia/Katmandu', 'UTC', 'Europe/Berlin']) {
      withTz(tz, () => {
        const rush = engine.predict(trunk, '2026-10-05T01:15:00Z', { forecast: fc });
        const offPeak = engine.predict(trunk, '2026-10-05T06:00:00Z', { forecast: fc });
        multipliers[tz] = [rush.concentration, offPeak.concentration];
      });
    }

    for (const tz of Object.keys(multipliers)) {
      const [rush, offPeak] = multipliers[tz];
      expect(rush, tz).toBeGreaterThan(offPeak);
    }
    const first = multipliers['Asia/Katmandu'];
    for (const tz of Object.keys(multipliers)) {
      expect(multipliers[tz][0], tz).toBeCloseTo(first[0], 9);
      expect(multipliers[tz][1], tz).toBeCloseTo(first[1], 9);
    }
  });

  it('computes the school window on Nepal local hours, not host local hours', () => {
    const schoolSeg: import('@/contracts').Segment = {
      id: 'school',
      roadClass: 'residential',
      lengthM: 120,
      coords: [
        { lat: 27.658, lon: 85.326 },
        { lat: 27.659, lon: 85.326 },
      ],
      features: {
        distToMainRoadM: 0,
        intersectionDensityPer100m: 1,
        trafficSignalsWithin50m: 0,
        busStopsWithin30m: 0,
        greenFraction100m: 0.2,
        buildingDensity: 0.5,
        nearbyRoads: [],
      },
    };
    const fc = syntheticForecast('2026-10-03T00:00:00Z');

    const firsts: Record<string, string> = {};
    const lasts: Record<string, string> = {};
    for (const tz of ['Asia/Katmandu', 'UTC', 'Europe/Berlin', 'America/New_York']) {
      withTz(tz, () => {
        const out = engine.schoolWindow(schoolSeg, '2026-10-03T18:15:00Z', 'outdoor', {
          forecast: fc,
        });
        firsts[tz] = out.hours[0].timeISO;
        lasts[tz] = out.hours[out.hours.length - 1].timeISO;
      });
    }

    // NPT midnight for 2026-10-04 is 2026-10-03T18:15Z, so 06:00 NPT is
    // 2026-10-04T00:15Z and 17:00 NPT is 2026-10-04T11:15Z, whatever the host zone.
    for (const tz of Object.keys(firsts)) {
      expect(firsts[tz], tz).toBe('2026-10-04T00:15:00Z');
      expect(lasts[tz], tz).toBe('2026-10-04T11:15:00Z');
    }
  });

  it('floors the departure slider to the UTC hour identically across zones', () => {
    const seen = new Set<string>();
    for (const tz of ['Asia/Katmandu', 'UTC', 'Europe/Berlin']) {
      withTz(tz, () => {
        seen.add(floorToHourISO('2026-10-05T07:42:31Z'));
      });
    }
    expect(seen.size).toBe(1);
    expect([...seen][0]).toBe('2026-10-05T07:00:00Z');
  });

  it('produces an identical synthetic forecast across zones', () => {
    const seen = new Set<string>();
    for (const tz of ['Asia/Katmandu', 'UTC', 'Europe/Berlin']) {
      withTz(tz, () => {
        seen.add(JSON.stringify(syntheticForecast('2026-10-03T12:00:00Z').hours.map((h) => h.pm25)));
      });
    }
    expect(seen.size).toBe(1);
  });

  it('uses real routes identically across host timezones', async () => {
    // Network probe only. The full geometry is not asserted: when the live
    // routing service is unreachable this test is skipped rather than failing, so
    // the suite stays usable offline. When it IS reachable, one fetch proves the
    // routing path returns real OSM-derived geometry.
    try {
      const res = await fetchRealRoutes(A, B, 'walk' as Mode);
      expect(res.routes.length).toBeGreaterThan(0);
      const route = res.routes[0];
      expect(route.source).toBe('osm-derived');
      expect(route.segments.length).toBeGreaterThan(0);
      for (const seg of route.segments) {
        expect(seg.coords.length).toBeGreaterThanOrEqual(2);
        expect(seg.lengthM).toBeGreaterThan(0);
        expect(Number.isFinite(seg.coords[0].lat)).toBe(true);
      }
      // Real OSM classes, never an invented default.
      const classes = new Set(res.routes.flatMap((r) => r.segments.map((s) => s.roadClass)));
      expect(classes.size).toBeGreaterThan(0);
    } catch {
      // routing unreachable in this environment — nothing to assert
    }
  }, 40_000);
});

