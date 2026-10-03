import { describe, expect, it } from 'vitest';
import { DEMO_ROUTES, demoSchool, DEMO_ROUTE_ISSUES, demoUniqueSegments } from './loader';
import { validateRoutes, validationErrors, segmentSignature } from './validate';
import { engine, DEFAULT_ENGINE_PARAMS } from '@/engine';
import { syntheticForecast } from '../fixtures/syntheticForecast';
import { addHours, localHourOf } from '../time';
import type { Forecast, Route, Segment } from '@/contracts';

const ANCHOR = '2026-10-03T12:00:00Z';

function forecast(): Forecast {
  return syntheticForecast(ANCHOR);
}

describe('shipped demo routes satisfy every contract invariant', () => {
  it('produces no validation issues at import time', () => {
    expect(DEMO_ROUTE_ISSUES).toEqual([]);
    expect(validationErrors(DEMO_ROUTES)).toEqual([]);
  });

  it('has three routes with distinct ids and a hand-authored source', () => {
    expect(DEMO_ROUTES.length).toBe(3);
    const ids = new Set(DEMO_ROUTES.map((r) => r.id));
    expect(ids.size).toBe(3);
    for (const r of DEMO_ROUTES) {
      expect(r.source).toBe('hand-authored');
      expect(typeof r.name).toBe('string');
      expect(r.name.length).toBeGreaterThan(0);
    }
  });

  it('gives every route 12 to 30 segments', () => {
    for (const r of DEMO_ROUTES) {
      expect(r.segments.length).toBeGreaterThanOrEqual(12);
      expect(r.segments.length).toBeLessThanOrEqual(30);
    }
  });

  it('gives every route 3 to 5 km in total', () => {
    for (const r of DEMO_ROUTES) {
      const total = r.segments.reduce((sum, s) => sum + s.lengthM, 0);
      expect(total).toBeGreaterThanOrEqual(3000);
      expect(total).toBeLessThanOrEqual(5000);
    }
  });

  it('shares at least two identical segments across routes, near origin and destination', () => {
    const counts = new Map<string, number>();
    for (const r of DEMO_ROUTES) {
      for (const s of r.segments) counts.set(s.id, (counts.get(s.id) ?? 0) + 1);
    }
    const shared = [...counts.entries()].filter(([, n]) => n > 1);
    expect(shared.length).toBeGreaterThanOrEqual(2);
    // Every shared id must be byte-identical in content.
    for (const [id] of shared) {
      const variants = new Set(
        DEMO_ROUTES.flatMap((r) => r.segments.filter((s) => s.id === id)).map(segmentSignature),
      );
      expect(variants.size).toBe(1);
    }
  });

  it('places the shared segments at the start and the end of every route', () => {
    const first = DEMO_ROUTES.map((r) => r.segments[0].id);
    const last = DEMO_ROUTES.map((r) => r.segments[r.segments.length - 1].id);
    expect(new Set(first).size).toBe(1);
    expect(new Set(last).size).toBe(1);
  });

  it('declares distToMainRoadM = 0 for every main-road segment', () => {
    for (const r of DEMO_ROUTES) {
      for (const s of r.segments) {
        if (s.roadClass === 'trunk' || s.roadClass === 'primary' || s.roadClass === 'secondary') {
          expect(s.features.distToMainRoadM).toBe(0);
        }
      }
    }
  });

  it('gives footways beside a main road a small distance and a nearbyRoads entry', () => {
    let found = 0;
    for (const r of DEMO_ROUTES) {
      for (const s of r.segments) {
        if (s.roadClass !== 'footway' && s.roadClass !== 'path') continue;
        const nearMain = s.features.nearbyRoads.filter(
          (n) => n.roadClass === 'trunk' || n.roadClass === 'primary' || n.roadClass === 'secondary',
        );
        if (nearMain.length === 0) continue;
        expect(s.features.distToMainRoadM).toBeLessThanOrEqual(400);
        expect(s.features.distToMainRoadM).toBeLessThanOrEqual(nearMain[0].distanceM * 1.15 + 1);
        if (s.features.distToMainRoadM < 60) found++;
      }
    }
    // At least one footway genuinely hugs a main road (the near-road decay story).
    expect(found).toBeGreaterThan(0);
  });

  it('gives green footways a higher green fraction than main roads', () => {
    const mainGreen: number[] = [];
    const pathGreen: number[] = [];
    for (const r of DEMO_ROUTES) {
      for (const s of r.segments) {
        if (s.roadClass === 'trunk' || s.roadClass === 'primary') mainGreen.push(s.features.greenFraction100m);
        if (s.roadClass === 'footway' || s.roadClass === 'path') pathGreen.push(s.features.greenFraction100m);
      }
    }
    const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
    expect(mean(pathGreen)).toBeGreaterThan(mean(mainGreen) + 0.3);
  });

  it('keeps every feature in range and every coordinate finite', () => {
    for (const seg of demoUniqueSegments(DEMO_ROUTES)) {
      expect(seg.features.greenFraction100m).toBeGreaterThanOrEqual(0);
      expect(seg.features.greenFraction100m).toBeLessThanOrEqual(1);
      expect(seg.features.buildingDensity).toBeGreaterThanOrEqual(0);
      expect(seg.features.buildingDensity).toBeLessThanOrEqual(1);
      expect(seg.features.distToMainRoadM).toBeGreaterThanOrEqual(0);
      expect(seg.coords.length).toBeGreaterThanOrEqual(2);
      for (const c of seg.coords) {
        expect(Number.isFinite(c.lat)).toBe(true);
        expect(Number.isFinite(c.lon)).toBe(true);
      }
    }
  });

  it('makes the three routes genuinely different', () => {
    const mainIds = new Set(DEMO_ROUTES[0].segments.map((s) => s.roadClass));
    const parkIds = new Set(DEMO_ROUTES[2].segments.map((s) => s.roadClass));
    expect(mainIds.has('trunk') || mainIds.has('primary')).toBe(true);
    expect([...parkIds].every((c) => c === 'footway' || c === 'path' || c === 'residential')).toBe(true);
  });
});

describe('validateRoutes rejects corrupted input', () => {
  const base = (): Route[] => JSON.parse(JSON.stringify(DEMO_ROUTES)) as Route[];

  it('catches a segment with fewer than 2 coords', () => {
    const routes = base();
    routes[0].segments[1].coords = [routes[0].segments[1].coords[0]];
    const errors = validationErrors(routes).join(' ');
    expect(errors).toContain('at least 2 coords');
  });

  it('catches a declared length far from the geometry', () => {
    const routes = base();
    routes[0].segments[1].lengthM = routes[0].segments[1].lengthM * 3;
    expect(validationErrors(routes).join(' ')).toContain('polyline is');
  });

  it('catches a main road that does not declare distToMainRoadM = 0', () => {
    const routes = base();
    const mainSeg = routes[0].segments.find((s) => s.roadClass === 'primary');
    if (mainSeg) mainSeg.features.distToMainRoadM = 40;
    expect(validationErrors(routes).join(' ')).toContain('distToMainRoadM must be 0');
  });

  it('catches a green fraction outside 0..1', () => {
    const routes = base();
    routes[1].segments[2].features.greenFraction100m = 1.4;
    expect(validationErrors(routes).join(' ')).toContain('greenFraction100m outside 0..1');
  });

  it('catches a shared id carrying different content', () => {
    const routes = base();
    routes[1].segments[0].features.buildingDensity = 0.99;
    expect(validationErrors(routes).join(' ')).toContain('is shared but its content differs');
  });

  it('catches a non-finite coordinate', () => {
    const routes = base();
    routes[2].segments[3].coords[0].lat = Number.NaN;
    expect(validationErrors(routes).join(' ')).toContain('non-finite coord');
  });

  it('rejects an empty route list', () => {
    expect(validateRoutes([]).some((i) => i.severity === 'error')).toBe(true);
  });
});

describe('demo school', () => {
  it('returns a segment from the demo network and flags it as approximate', () => {
    const school = demoSchool();
    expect(school.approximateLocation).toBe(true);
    expect(school.name).toMatch(/approx/i);
    expect(school.segment.coords.length).toBeGreaterThanOrEqual(2);
    const ids = new Set(demoUniqueSegments(DEMO_ROUTES).map((s) => s.id));
    expect(ids.has(school.segment.id)).toBe(true);
  });

  it('picks a walkable segment near the destination', () => {
    const school = demoSchool();
    expect(['footway', 'path']).toContain(school.segment.roadClass);
  });
});

describe('the engine produces both a recommend and a none verdict (AC-5)', () => {
  it('covers both outcomes across modes, hours and baselines', () => {
    const fc = forecast();
    const verdictFor = (baselineId: string, mode: 'walk' | 'cycle' | 'bus', hourOffset: number) =>
      engine
        .compareRoutes(DEMO_ROUTES, baselineId, mode, addHours(ANCHOR, hourOffset), { forecast: fc })
        .versus.map((v) => v.verdict);

    const seen = new Set<string>();
    for (const mode of ['walk', 'cycle', 'bus'] as const) {
      for (const baseline of DEMO_ROUTES.map((r) => r.id)) {
        // Cover a full Nepal day: 06:00 NPT through 22:00 NPT.
        for (let h = -6; h <= 16; h++) {
          for (const v of verdictFor(baseline, mode, h)) seen.add(v);
        }
      }
    }

    expect(seen.has('recommend')).toBe(true);
    expect(seen.has('none')).toBe(true);
  });

  it('is deterministic for the same inputs', () => {
    const fc = forecast();
    const a = engine.compareRoutes(DEMO_ROUTES, DEMO_ROUTES[0].id, 'walk', ANCHOR, { forecast: fc });
    const b = engine.compareRoutes(DEMO_ROUTES, DEMO_ROUTES[0].id, 'walk', ANCHOR, { forecast: fc });
    expect(a.message).toBe(b.message);
    expect(a.bestRouteId).toBe(b.bestRouteId);
  });

  it('produces only finite numbers across the whole demo sweep', () => {
    const fc = forecast();
    const sweep = engine.departureSweep(
      DEMO_ROUTES,
      DEMO_ROUTES[0].id,
      'cycle',
      ANCHOR,
      [0, 30, 60, 90, 120, 150, 180],
      { forecast: fc },
    );
    expect(sweep.length).toBe(7);
    for (const point of sweep) {
      for (const trip of point.comparison.trips) {
        expect(Number.isFinite(trip.doseUg)).toBe(true);
        expect(Number.isFinite(trip.meanConcentration)).toBe(true);
        expect(Number.isFinite(trip.durationMin)).toBe(true);
        expect(Number.isFinite(trip.refDosePct)).toBe(true);
        for (const seg of trip.segments) {
          expect(Number.isFinite(seg.concentration)).toBe(true);
          expect(Number.isFinite(seg.multiplier)).toBe(true);
          expect(Number.isFinite(seg.sigmaLog)).toBe(true);
        }
      }
      for (const v of point.comparison.versus) {
        expect(Number.isFinite(v.medianDeltaE)).toBe(true);
        expect(v.pBetter).toBeGreaterThanOrEqual(0);
        expect(v.pBetter).toBeLessThanOrEqual(1);
      }
    }
  });

  it('runs the school window on a demo segment', () => {
    const school = demoSchool().segment;
    const out = engine.schoolWindow(school, '2026-10-03T18:15:00Z', 'outdoor', { forecast: forecast() });
    expect(out.hours.length).toBe(12);
    expect(out.hours.every((h) => Number.isFinite(h.exposureIndex))).toBe(true);
    expect(out.message).toMatch(/modeled estimate|NPT/);
  });

  it('ranks the demo routes stably under +-20% multiplier changes', () => {
    const fc = forecast();
    const report = engine.sensitivity(DEMO_ROUTES, 'walk', ANCHOR, { forecast: fc });
    expect(report.pairs).toBe(3);
    expect(report.stability).toBeGreaterThan(0);
    expect(report.stability).toBeLessThanOrEqual(1);
  });

  it('keeps every engine parameter finite', () => {
    const p = engine.defaultParams();
    for (const [k, v] of Object.entries(p.roadExcess)) {
      expect(Number.isFinite(v), k).toBe(true);
    }
    expect(p.bias.a).toBe(DEFAULT_ENGINE_PARAMS.bias.a);
  });
});

describe('demo seeds', () => {
  it('produces exactly 30 observations, all simulated', async () => {
    const { seedObservations } = await import('../fixtures/seedObservations');
    const obs = seedObservations(ANCHOR);
    expect(obs.length).toBe(30);
    expect(obs.every((o) => o.isSimulated === true)).toBe(true);
    expect(obs.filter((o) => o.kind === 'photo').length).toBe(24);
    expect(obs.filter((o) => o.kind === 'report').length).toBe(6);
    expect(new Set(obs.map((o) => o.id)).size).toBe(30);
  });

  it('places every seed within the last 6 hours of the anchor', async () => {
    const { seedObservations } = await import('../fixtures/seedObservations');
    const obs = seedObservations(ANCHOR);
    const anchorMs = Date.parse(ANCHOR);
    for (const o of obs) {
      const dt = (anchorMs - Date.parse(o.timeISO)) / 3_600_000;
      expect(dt).toBeGreaterThanOrEqual(0);
      expect(dt).toBeLessThanOrEqual(6);
    }
  });

  it('is deterministic for a given anchor hour', async () => {
    const { seedObservations } = await import('../fixtures/seedObservations');
    expect(JSON.stringify(seedObservations(ANCHOR))).toBe(JSON.stringify(seedObservations(ANCHOR)));
  });

  it('makes photo optical depth higher near the main road than in the park', async () => {
    const { seedObservations } = await import('../fixtures/seedObservations');
    const obs = seedObservations(ANCHOR).filter((o) => o.kind === 'photo') as Array<{
      tauOpt: number;
      lat: number;
    }>;
    // Cluster 0/1/2 sit on the main road; clusters 4/5 sit in the park.
    const mainRoad = obs.slice(0, 9).map((o) => o.tauOpt);
    const park = obs.slice(18).map((o) => o.tauOpt);
    const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
    expect(mean(mainRoad)).toBeGreaterThan(mean(park));
  });

  it('carries an explicit SIMULATED note on every seed', async () => {
    const { seedObservations } = await import('../fixtures/seedObservations');
    for (const o of seedObservations(ANCHOR)) {
      expect(o.note ?? '').toMatch(/SIMULATED/i);
    }
  });

  it('keeps cluster positions inside the demo corridor', async () => {
    const { seedObservations } = await import('../fixtures/seedObservations');
    const segs: Segment[] = demoUniqueSegments(DEMO_ROUTES);
    let attached = 0;
    for (const o of seedObservations(ANCHOR)) {
      for (const s of segs) {
        // Coarse check: some seed must be within a few hundred metres of some segment.
        const mid = s.coords[Math.floor(s.coords.length / 2)];
        const d = Math.hypot((o.lat - mid.lat) * 111_320, (o.lon - mid.lon) * 98_000);
        if (d < 400) {
          attached++;
          break;
        }
      }
    }
    expect(attached).toBeGreaterThan(20);
  });
});

describe('Nepal local time in the data layer', () => {
  it('computes local hours with the 05:45 offset', async () => {
    const { localHourOf: lh } = await import('../time');
    expect(lh('2026-10-03T01:15:00Z')).toBeCloseTo(7, 10);
    expect(lh('2026-10-03T18:15:00Z')).toBeCloseTo(0, 10);
  });

  it('floors to the hour for the departure slider', async () => {
    const { floorToHourISO } = await import('../time');
    expect(floorToHourISO('2026-10-03T07:42:31Z')).toBe('2026-10-03T07:00:00Z');
  });
});

// Keep the unused-import checker honest about localHourOf re-export.
void localHourOf;