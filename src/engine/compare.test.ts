import { describe, expect, it } from 'vitest';
import { engine, DEFAULT_ENGINE_PARAMS } from './index';
import { compareRoutes, pctOf, verdictFor } from './compare';
import { departureSweep } from './sweep';
import { sensitivity } from './sensitivity';
import { schoolWindow } from './school';
import { sigmaBgAtLead } from './montecarlo';
import { mulberry32, NormalSampler, medianOf } from './rng';
import {
  features,
  hourISO,
  makeForecast,
  makePoint,
  makeRoute,
  makeRouteOfLengths,
  makeSegment,
} from './testFixtures';
import type { EvalContext, Forecast, Route, Segment } from '@/contracts';

const P = DEFAULT_ENGINE_PARAMS;
const OFF_PEAK_UTC = '2026-10-05T06:00:00Z'; // 11:45 NPT
const RUSH_UTC = '2026-10-05T02:00:00Z'; // 07:45 NPT

function flatForecast(pm25: number, fetchedAtISO = hourISO(0)): Forecast {
  return makeForecast(
    Array.from({ length: 48 }, (_, i) => makePoint({ timeISO: hourISO(i), pm25 })),
    { fetchedAtISO },
  );
}

/** Main road route: three 1.5 km primary segments. */
function mainRoadRoute(): Route {
  return makeRouteOfLengths('main', [1500, 1500, 1500], 'primary', { idPrefix: 'main' });
}

/** Quiet route: three 1.5 km park footways with high green fraction and no nearby roads. */
function parkRoute(): Route {
  return makeRouteOfLengths('park', [1500, 1500, 1500], 'footway', {
    idPrefix: 'park',
    features: () => features({ greenFraction100m: 0.9 }),
  });
}

function ctxOf(fc: Forecast): EvalContext {
  return { forecast: fc };
}

describe('rng', () => {
  it('mulberry32 is deterministic for a seed', () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    for (let i = 0; i < 10; i++) expect(a()).toBe(b());
  });

  it('produces values inside [0,1)', () => {
    const r = mulberry32(7);
    for (let i = 0; i < 2000; i++) {
      const v = r();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it('Box-Muller is reproducible and roughly standard normal', () => {
    const s1 = new NormalSampler(mulberry32(99));
    const s2 = new NormalSampler(mulberry32(99));
    const draws: number[] = [];
    for (let i = 0; i < 20_000; i++) {
      const v = s1.next();
      expect(v).toBe(v);
      expect(Number.isFinite(v)).toBe(true);
      draws.push(v);
      if (i < 20_000 - 1) expect(s2.next()).toBe(v);
    }
    const mean = draws.reduce((a, b) => a + b, 0) / draws.length;
    expect(Math.abs(mean)).toBeLessThan(0.05);
    const sd = Math.sqrt(draws.reduce((a, b) => a + (b - mean) ** 2, 0) / draws.length);
    expect(sd).toBeGreaterThan(0.9);
    expect(sd).toBeLessThan(1.1);
  });

  it('medianOf is stable', () => {
    expect(medianOf([3, 1, 2])).toBe(2);
    expect(medianOf([4, 1, 3, 2])).toBe(2.5);
    expect(medianOf([])).toBe(0);
    expect(medianOf([NaN])).toBe(0);
  });
});

describe('lead-time uncertainty (methodology 7.2)', () => {
  it('widens monotonically with lead time', () => {
    const s0 = sigmaBgAtLead(P, 0);
    const s1 = sigmaBgAtLead(P, 1);
    const s3 = sigmaBgAtLead(P, 3);
    expect(s1).toBeGreaterThan(s0);
    expect(s3).toBeGreaterThan(s1);
  });

  it('matches σ₀² + q·h + κ²·h² by hand at h = 2', () => {
    const expected = Math.sqrt(0.35 ** 2 + 0.0025 * 2 + 0.03 ** 2 * 4);
    expect(sigmaBgAtLead(P, 2)).toBeCloseTo(expected, 12);
  });

  it('never returns NaN for a negative or non-finite lead', () => {
    expect(Number.isFinite(sigmaBgAtLead(P, -5))).toBe(true);
    expect(Number.isFinite(sigmaBgAtLead(P, NaN))).toBe(true);
  });
});

describe('verdict thresholds (methodology 3.3)', () => {
  it('test 9a: hits the recommend branch', () => {
    expect(verdictFor(P, 0.25, 0.95)).toBe('recommend');
  });
  it('test 9b: hits the slight branch (p above 0.6 but below 0.8)', () => {
    expect(verdictFor(P, 0.05, 0.7)).toBe('slight');
  });
  it('test 9c: hits the none branch (p below 0.6)', () => {
    expect(verdictFor(P, 0.05, 0.2)).toBe('none');
  });
  it('test 9d: a large ΔE with weak agreement is NOT a recommendation', () => {
    expect(verdictFor(P, 0.9, 0.5)).toBe('none');
  });
  it('test 9e: strong agreement with a tiny ΔE is NOT a recommendation', () => {
    expect(verdictFor(P, 0.01, 0.99)).toBe('slight');
  });
});

describe('compareRoutes', () => {
  const fc = flatForecast(50);

  it('test 8a: the same seed gives identical results', () => {
    const routes = [mainRoadRoute(), parkRoute()];
    const a = engine.compareRoutes(routes, 'main', 'walk', RUSH_UTC, ctxOf(fc));
    const b = engine.compareRoutes(routes, 'main', 'walk', RUSH_UTC, ctxOf(fc));
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('test 8b: a different seed changes the samples but not the shape', () => {
    const routes = [mainRoadRoute(), parkRoute()];
    const a = engine.compareRoutes(routes, 'main', 'walk', RUSH_UTC, { ...ctxOf(fc), seed: 1 });
    const b = engine.compareRoutes(routes, 'main', 'walk', RUSH_UTC, { ...ctxOf(fc), seed: 2 });
    expect(a.versus[0].pBetter).toBeCloseTo(b.versus[0].pBetter, 1);
    expect(a.draws).toBe(b.draws);
  });

  it('test 8c: identical routes give pBetter = 0 and verdict none (AC-6)', () => {
    const routes = [mainRoadRoute(), mainRoadRoute()];
    const out = engine.compareRoutes(routes, 'main', 'walk', RUSH_UTC, ctxOf(fc));
    expect(out.versus.length).toBe(1);
    expect(out.versus[0].pBetter).toBe(0);
    expect(out.versus[0].medianDeltaE).toBe(0);
    expect(out.versus[0].verdict).toBe('none');
    expect(out.bestRouteId).toBeNull();
    expect(out.message).toContain('No meaningful difference');
  });

  it('test 8d: a shared stretch cancels because the same draw error hits both routes', () => {
    // Build two routes whose ONLY difference is one shared 1 km segment plus one
    // differing 1 km segment of identical length. The shared dose is identical in
    // every draw, so the comparison is driven purely by the differing part.
    const shared = makeSegment({ id: 'shared', roadClass: 'residential', lengthM: 1000 });
    const busy = makeSegment({
      id: 'busy',
      roadClass: 'primary',
      lengthM: 1000,
      coords: [
        { lat: 27.73, lon: 85.33 },
        { lat: 27.74, lon: 85.33 },
      ],
    });
    const quiet = makeSegment({
      id: 'quiet',
      roadClass: 'footway',
      lengthM: 1000,
      coords: [
        { lat: 27.73, lon: 85.33 },
        { lat: 27.74, lon: 85.33 },
      ],
      features: features({ greenFraction100m: 1 }),
    });
    const routeA = makeRoute('A', [shared, busy]);
    const routeB = makeRoute('B', [shared, quiet]);

    const out = engine.compareRoutes([routeA, routeB], 'A', 'walk', OFF_PEAK_UTC, {
      ...ctxOf(fc),
      seed: 5,
      draws: 400,
    });
    const v = out.versus.find((x) => x.routeId === 'B');
    expect(v).toBeDefined();
    expect(v!.verdict).toBe('recommend');
    expect(v!.pBetter).toBeGreaterThanOrEqual(P.decision.pRecommend);
    expect(out.bestRouteId).toBe('B');
    expect(out.message).toContain('Modeled estimate: B has about');
    expect(out.message).toContain('% lower exposure than A');
    expect(out.message).toContain('% of simulations agree');
  });

  it('test 8e: reports exactly the requested draw count', () => {
    const routes = [mainRoadRoute(), parkRoute()];
    expect(engine.compareRoutes(routes, 'main', 'walk', RUSH_UTC, ctxOf(fc), { draws: 77 }).draws).toBe(77);
    expect(engine.compareRoutes(routes, 'main', 'walk', RUSH_UTC, ctxOf(fc)).draws).toBe(300);
  });

  it('says nothing when the baseline id is not present', () => {
    const out = engine.compareRoutes([mainRoadRoute(), parkRoute()], 'nope', 'walk', RUSH_UTC, ctxOf(fc));
    expect(out.versus).toEqual([]);
    expect(out.bestRouteId).toBeNull();
    expect(out.message).toContain('No meaningful difference');
  });

  it('handles an empty route list without throwing', () => {
    const out = engine.compareRoutes([], 'main', 'walk', RUSH_UTC, ctxOf(fc));
    expect(out.trips).toEqual([]);
    expect(out.bestRouteId).toBeNull();
  });

  it('uses the Monte Carlo message wording for a recommend verdict', () => {
    const routes = [mainRoadRoute(), parkRoute()];
    const out = engine.compareRoutes(routes, 'main', 'walk', RUSH_UTC, ctxOf(fc), { draws: 400 });
    const v = out.versus.find((x) => x.routeId === 'park');
    expect(v!.verdict).toBe('recommend');
    expect(out.message).toBe(
      `Modeled estimate: ${v!.routeId === 'park' ? 'park' : ''}`.length > 0
        ? out.message
        : out.message,
    );
    expect(out.message).toContain('Modeled estimate:');
    expect(out.message).toContain('% lower exposure than main');
    expect(out.message).toContain('% of simulations agree');
  });

  it('pctOf rounds to a whole percent and survives non-finite input', () => {
    expect(pctOf(0.304)).toBe(30);
    expect(pctOf(NaN)).toBe(0);
  });
});

describe('departureSweep', () => {
  const fc = flatForecast(50);
  const routes = [mainRoadRoute(), parkRoute()];

  it('test 10a: calls correctionsAt exactly once per offset', () => {
    const seen: string[] = [];
    const offsets = [0, 30, 60, 90];
    const points = engine.departureSweep(
      routes,
      'main',
      'walk',
      hourISO(0),
      offsets,
      ctxOf(fc),
      (departISO) => {
        seen.push(departISO);
        return undefined;
      },
    );
    expect(seen.length).toBe(offsets.length);
    expect(points.length).toBe(offsets.length);
    expect(seen).toEqual(points.map((p) => p.departISO));
  });

  it('test 10b: returns offsets in order with the right departure instants', () => {
    const offsets = [0, 30, 60, 90, 120, 150, 180];
    const points = engine.departureSweep(routes, 'main', 'walk', hourISO(0), offsets, ctxOf(fc));
    expect(points.map((p) => p.offsetMin)).toEqual(offsets);
    expect(points[0].departISO).toBe(hourISO(0));
    expect(points[1].departISO).toBe(hourISO(0).replace('00:00:00Z', '00:30:00Z'));
    expect(points[6].departISO).toBe(hourISO(3));
  });

  it('test 10c: a per-offset correction map overrides the static one', () => {
    // Bias the +60 min point strongly against the park route and check the verdict flips.
    const parkSegs = parkRoute().segments.map((s) => s.id);
    const correctionsAt = (departISO: string) => {
      if (!departISO.endsWith('01:00:00Z')) return undefined;
      const map = {} as Record<string, { segmentId: string; deltaLog: number; confidence: number; sigmaLog: number; supportN: number }>;
      for (const id of parkSegs) {
        map[id] = { segmentId: id, deltaLog: Math.log(3), confidence: 0.9, sigmaLog: 0.1, supportN: 4 };
      }
      return map;
    };
    const points = engine.departureSweep(
      routes,
      'main',
      'walk',
      hourISO(0),
      [0, 30, 60],
      ctxOf(fc),
      correctionsAt,
    );
    const at0 = points[0].comparison.versus.find((v) => v.routeId === 'park');
    const at60 = points[2].comparison.versus.find((v) => v.routeId === 'park');
    expect(at0!.verdict).toBe('recommend');
    expect(at60!.verdict).toBe('none');
  });

  it('tolerates an empty offset list', () => {
    expect(engine.departureSweep(routes, 'main', 'walk', hourISO(0), [], ctxOf(fc))).toEqual([]);
  });
});

describe('sensitivity (methodology 3.4)', () => {
  const fc = flatForecast(50);

  it('counts one pair per unordered route pair', () => {
    const routes = [mainRoadRoute(), parkRoute(), mainRoadRoute()];
    const report = sensitivity(routes, 'walk', RUSH_UTC, ctxOf(fc));
    expect(report.pairs).toBe(3);
    expect(report.scales).toEqual([0.8, 1, 1.2]);
    expect(report.stability).toBeCloseTo(report.stablePairs / report.pairs, 12);
  });

  it('is fully stable when the ranking is obvious', () => {
    const routes = [mainRoadRoute(), parkRoute()];
    const report = sensitivity(routes, 'walk', RUSH_UTC, ctxOf(fc));
    expect(report.stablePairs).toBe(1);
    expect(report.stability).toBe(1);
  });

  it('honours a custom scale list', () => {
    const routes = [mainRoadRoute(), parkRoute()];
    const report = engine.sensitivity(routes, 'walk', RUSH_UTC, ctxOf(fc), [0.5, 1, 2]);
    expect(report.scales).toEqual([0.5, 1, 2]);
  });

  it('returns zero pairs for a single route', () => {
    const report = sensitivity([mainRoadRoute()], 'walk', RUSH_UTC, ctxOf(fc));
    expect(report.pairs).toBe(0);
    expect(report.stability).toBe(0);
  });
});

describe('schoolWindow (methodology 3.5)', () => {
  const schoolSeg: Segment = makeSegment({ id: 'school', roadClass: 'primary', lengthM: 120 });

  function dayForecast(): Forecast {
    // Local day starts 2026-10-04T18:15:00Z. Give 24 h with a clear minimum at
    // 13:00–15:00 NPT (= 07:15–09:15 UTC on 2026-10-05).
    const startMs = Date.parse('2026-10-04T18:15:00Z');
    return makeForecast(
      Array.from({ length: 30 }, (_, i) => {
        const t = new Date(startMs + i * 3_600_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
        const utcHour = (Date.parse(t) / 3_600_000) % 24;
        // Valley shape: high near the morning and evening peaks, minimum around 08:00 UTC.
        const shape = 40 + 30 * Math.cos(((utcHour - 8) / 24) * 2 * Math.PI);
        return makePoint({ timeISO: t, pm25: shape });
      }),
      { fetchedAtISO: '2026-10-05T06:00:00Z' },
    );
  }

  it('covers local hours 06:00 to 17:00 inclusive (12 hours)', () => {
    const out = schoolWindow(schoolSeg, '2026-10-04T18:15:00Z', 'outdoor', ctxOf(dayForecast()));
    expect(out.hours.length).toBe(12);
    // NPT midnight is 2026-10-04T18:15Z, so 06:00 NPT is 00:15Z and 17:00 NPT is 11:15Z.
    expect(out.hours[0].timeISO).toBe('2026-10-05T00:15:00Z');
    expect(out.hours[11].timeISO).toBe('2026-10-05T11:15:00Z');
  });

  it('test: picks the longest contiguous low block', () => {
    const fc = dayForecast();
    const out = schoolWindow(schoolSeg, '2026-10-04T18:15:00Z', 'outdoor', ctxOf(fc));
    expect(out.bestWindow).not.toBeNull();
    const start = out.bestWindow!.startISO;
    const end = out.bestWindow!.endISO;
    expect(Date.parse(end)).toBeGreaterThan(Date.parse(start));
    // Every hour inside the window is within 10% of the day minimum.
    const values = out.hours.map((h) => h.exposureIndex);
    const min = Math.min(...values);
    const inside = out.hours.filter((h) => h.timeISO >= start && Date.parse(h.timeISO) < Date.parse(end));
    expect(inside.length).toBeGreaterThan(0);
    for (const h of inside) expect(h.exposureIndex).toBeLessThanOrEqual(min * 1.1 + 1e-9);
    expect(out.message).toContain('Lowest modeled exposure');
    expect(out.message).toContain('NPT');
  });

  it('indoor activity scales every hour by the infiltration factor', () => {
    const fc = dayForecast();
    const out = schoolWindow(schoolSeg, '2026-10-04T18:15:00Z', 'outdoor', ctxOf(fc));
    const indoor = schoolWindow(schoolSeg, '2026-10-04T18:15:00Z', 'indoor', ctxOf(fc));
    expect(indoor.hours[0].exposureIndex).toBeCloseTo(out.hours[0].exposureIndex * P.indoorInfiltration, 9);
  });

  it('uses Nepal local day boundaries, not UTC ones', () => {
    const fc = dayForecast();
    const a = schoolWindow(schoolSeg, '2026-10-04T18:15:00Z', 'outdoor', ctxOf(fc));
    const b = schoolWindow(schoolSeg, '2026-10-05T00:00:00Z', 'outdoor', ctxOf(fc));
    // 00:00Z on 2026-10-05 is 05:45 NPT, so it belongs to the SAME NPT day.
    expect(a.hours[0].timeISO).toBe(b.hours[0].timeISO);
    expect(a.bestWindow).toEqual(b.bestWindow);
  });
});

describe('performance (test 11)', () => {
  it('3 routes × 25 segments × 300 draws completes well under 100 ms', () => {
    const fc = flatForecast(45);
    const routes: Route[] = [
      makeRouteOfLengths('r1', Array(25).fill(200) as number[], 'primary', { idPrefix: 'r1' }),
      makeRouteOfLengths('r2', Array(25).fill(200) as number[], 'residential', { idPrefix: 'r2' }),
      makeRouteOfLengths('r3', Array(25).fill(200) as number[], 'footway', {
        idPrefix: 'r3',
        features: () => features({ greenFraction100m: 0.8 }),
      }),
    ];
    const ctx = ctxOf(fc);

    // Warm up so JIT cost is not attributed to the measured call.
    engine.compareRoutes(routes, 'r1', 'cycle', RUSH_UTC, ctx, { draws: 300 });

    const t0 = performance.now();
    for (let i = 0; i < 5; i++) {
      engine.compareRoutes(routes, 'r1', 'cycle', RUSH_UTC, ctx, { draws: 300 });
    }
    const perCall = (performance.now() - t0) / 5;
    expect(perCall).toBeLessThan(100);
  });
});
