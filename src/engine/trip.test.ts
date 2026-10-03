import { describe, expect, it } from 'vitest';
import { engine, DEFAULT_ENGINE_PARAMS } from './index';
import { segmentHours } from './trip';
import { evaluateSegment, resolveParams } from './predict';
import {
  features,
  hourISO,
  makeForecast,
  makePoint,
  makeRoute,
  makeRouteOfLengths,
  makeSegment,
} from './testFixtures';
import type { CorrectionMap, Forecast, Segment } from '@/contracts';

const P = DEFAULT_ENGINE_PARAMS;
const OFF_PEAK_UTC = '2026-10-05T06:00:00Z'; // 11:45 NPT

function flatForecast(pm25: number): Forecast {
  return makeForecast(Array.from({ length: 48 }, (_, i) => makePoint({ timeISO: hourISO(i), pm25 })));
}

describe('segmentHours', () => {
  it('is length / speed', () => {
    expect(segmentHours(1000, 5)).toBeCloseTo(0.2, 12);
  });

  it('returns 0 rather than dividing by zero', () => {
    expect(segmentHours(1000, 0)).toBe(0);
    expect(segmentHours(0, 5)).toBe(0);
  });
});

describe('dose (methodology 1.5)', () => {
  it('test 5: 1 km at constant C = 50, walking → 50 · 1.3 · (1/4.5) µg', () => {
    // A single 1 km residential segment. e_residential = 0.05 ⇒ C = 50 · 1.05 = 52.5.
    // We instead assert with greenFraction = 0 and roadExcess overridden to 0 so the
    // multiplier is exactly 1 and C is exactly 50.
    const params = { ...P, roadExcess: { ...P.roadExcess, residential: 0 } };
    const fc = flatForecast(50);
    const seg: Segment = makeSegment({ id: 'a', roadClass: 'residential', lengthM: 1000 });
    const trip = engine.evaluateTrip(
      { route: makeRoute('r', [seg]), mode: 'walk', departISO: OFF_PEAK_UTC },
      { forecast: fc, params },
    );
    // τ = 1/4.5 h, v = 1.3 m³/h, F_e = 1.0
    const expected = 50 * 1 * 1.3 * (1 / 4.5);
    expect(trip.doseUg).toBeCloseTo(expected, 9);
    expect(trip.durationMin).toBeCloseTo((1 / 4.5) * 60, 9);
    expect(trip.meanConcentration).toBeCloseTo(50, 9);
  });

  it('test 5b: with the default prior the same trip uses C = 50 · 1.05', () => {
    const fc = flatForecast(50);
    const seg = makeSegment({ id: 'a', roadClass: 'residential', lengthM: 1000 });
    const trip = engine.evaluateTrip(
      { route: makeRoute('r', [seg]), mode: 'walk', departISO: OFF_PEAK_UTC },
      { forecast: fc },
    );
    expect(trip.doseUg).toBeCloseTo(50 * 1.05 * 1.3 * (1 / 4.5), 9);
  });

  it('scales ventilation and infiltration by mode', () => {
    const fc = flatForecast(50);
    const seg = makeSegment({ id: 'a', roadClass: 'residential', lengthM: 1000 });
    const params = { ...P, roadExcess: { ...P.roadExcess, residential: 0 } };
    const doses = (['walk', 'cycle', 'bus'] as const).map(
      (mode) =>
        engine.evaluateTrip({ route: makeRoute('r', [seg]), mode, departISO: OFF_PEAK_UTC }, {
          forecast: fc,
          params,
        }).doseUg,
    );
    // cycle: 2.8 m³/h over 15 km/h ⇒ 50·2.8/15 = 9.333
    expect(doses[1]).toBeCloseTo(50 * 1 * 2.8 * (1 / 15), 9);
    // bus: 0.7 · 0.9 enclosure over 12 km/h
    expect(doses[2]).toBeCloseTo(50 * 0.9 * 0.7 * (1 / 12), 9);
    // walking breathes more air per km than cycling, and the bus is partly enclosed.
    expect(doses[0]).toBeGreaterThan(doses[1]);
    expect(doses[0]).toBeGreaterThan(doses[2]);
  });

  it('test 6: a rising ramp makes later segments use later-hour concentrations', () => {
    // pm25 rises 10 → 40 µg/m³ over 4 hours; multiplier forced to 1.
    const fc = makeForecast(
      [0, 1, 2, 3].map((h) => makePoint({ timeISO: hourISO(h), pm25: 10 + 10 * h })),
    );
    const params = { ...P, roadExcess: { ...P.roadExcess, residential: 0 } };
    // Four 1.5 km residential segments walked at 4.5 km/h ⇒ τ = 1/3 h each.
    const route = makeRouteOfLengths('r', [1500, 1500, 1500, 1500], 'residential', {
      idPrefix: 'seg',
      features: () => features(),
    });
    const trip = engine.evaluateTrip({ route, mode: 'walk', departISO: hourISO(0) }, { forecast: fc, params });
    // τ = 1/3 h = 20 min each, so midpoints are 00:10, 00:30, 00:50, 01:10 and the
    // ramp (10 → 40 µg/m³ per hour) gives pm25 = 11.667, 15, 18.333, 21.667.
    expect(trip.segments[0].concentration).toBeCloseTo(10 + 10 * (10 / 60), 6);
    expect(trip.segments[1].concentration).toBeCloseTo(10 + 10 * (30 / 60), 6);
    expect(trip.segments[2].concentration).toBeCloseTo(10 + 10 * (50 / 60), 6);
    expect(trip.segments[3].concentration).toBeCloseTo(10 + 10 * (70 / 60), 6);
    // Strictly increasing, which is the point of the test.
    expect(trip.segments[3].concentration).toBeGreaterThan(trip.segments[0].concentration);
    expect(trip.doseUg).toBeGreaterThan(0);
  });

  it('computes the reference-dose and cigarette-equivalent normalizations', () => {
    const fc = flatForecast(50);
    const seg = makeSegment({ id: 'a', roadClass: 'residential', lengthM: 1000 });
    const trip = engine.evaluateTrip(
      { route: makeRoute('r', [seg]), mode: 'walk', departISO: OFF_PEAK_UTC },
      { forecast: fc },
    );
    expect(trip.refDosePct).toBeCloseTo((trip.doseUg / 225) * 100, 9);
    expect(trip.cigaretteEq).toBeCloseTo(trip.doseUg / (22 * 15), 9);
  });

  it('weights trip confidence by segment length', () => {
    const fc = flatForecast(50);
    const a = makeSegment({ id: 'a', roadClass: 'residential', lengthM: 1000 });
    const b = makeSegment({
      id: 'b',
      roadClass: 'residential',
      lengthM: 3000,
      coords: [
        { lat: 27.72, lon: 85.33 },
        { lat: 27.75, lon: 85.33 },
      ],
    });
    const corrections: CorrectionMap = {
      a: { segmentId: 'a', deltaLog: 0, confidence: 1, sigmaLog: 0.1, supportN: 2 },
      b: { segmentId: 'b', deltaLog: 0, confidence: 0, sigmaLog: 0.27, supportN: 0 },
    };
    const trip = engine.evaluateTrip(
      { route: makeRoute('r', [a, b]), mode: 'walk', departISO: OFF_PEAK_UTC },
      { forecast: fc, corrections },
    );
    // (1·1000 + 0·3000) / 4000 = 0.25
    expect(trip.confidence).toBeCloseTo(0.25, 9);
  });
});

describe('evidence corrections (methodology 2.5 / Phase 1 contract)', () => {
  it('test 7a: deltaLog = ln 2 doubles the concentration', () => {
    const fc = flatForecast(40);
    const seg = makeSegment({ id: 'a', roadClass: 'residential' });
    const base = engine.evaluateTrip(
      { route: makeRoute('r', [seg]), mode: 'walk', departISO: OFF_PEAK_UTC },
      { forecast: fc },
    );
    const corrections: CorrectionMap = {
      a: { segmentId: 'a', deltaLog: Math.log(2), confidence: 0.9, sigmaLog: 0.11, supportN: 3 },
    };
    const corr = engine.evaluateTrip(
      { route: makeRoute('r', [seg]), mode: 'walk', departISO: OFF_PEAK_UTC },
      { forecast: fc, corrections },
    );
    expect(corr.segments[0].concentration).toBeCloseTo(base.segments[0].concentration * 2, 9);
    expect(corr.segments[0].deltaLog).toBeCloseTo(Math.log(2), 12);
    expect(corr.segments[0].confidence).toBeCloseTo(0.9, 12);
    expect(corr.segments[0].sigmaLog).toBeCloseTo(0.11, 12);
  });

  it('test 7b: a missing correction key changes nothing', () => {
    const fc = flatForecast(40);
    const seg = makeSegment({ id: 'a', roadClass: 'residential' });
    const base = engine.evaluateTrip(
      { route: makeRoute('r', [seg]), mode: 'walk', departISO: OFF_PEAK_UTC },
      { forecast: fc },
    );
    const withUnrelated: CorrectionMap = {
      other: { segmentId: 'other', deltaLog: 1, confidence: 1, sigmaLog: 0.01, supportN: 9 },
    };
    const corr = engine.evaluateTrip(
      { route: makeRoute('r', [seg]), mode: 'walk', departISO: OFF_PEAK_UTC },
      { forecast: fc, corrections: withUnrelated },
    );
    expect(corr.doseUg).toBeCloseTo(base.doseUg, 12);
    expect(corr.segments[0].deltaLog).toBe(0);
    expect(corr.segments[0].confidence).toBe(0);
  });

  it('engine.predict stays UNCORRECTED even when corrections are present', () => {
    const fc = flatForecast(40);
    const seg = makeSegment({ id: 'a', roadClass: 'residential' });
    const corrections: CorrectionMap = {
      a: { segmentId: 'a', deltaLog: Math.log(3), confidence: 1, sigmaLog: 0.1, supportN: 5 },
    };
    const p = engine.predict(seg, OFF_PEAK_UTC, { forecast: fc, corrections });
    // 40 · 1.05, with no exp(ln 3) applied.
    expect(p.concentration).toBeCloseTo(42, 9);
  });

  it('clamps a correction confidence above 1', () => {
    const params = resolveParams({ forecast: flatForecast(40) });
    const seg = makeSegment({ id: 'a', roadClass: 'residential' });
    const ev = evaluateSegment(params, flatForecast(40), seg, OFF_PEAK_UTC, {
      a: { segmentId: 'a', deltaLog: 0, confidence: 5, sigmaLog: 0.1, supportN: 1 },
    });
    expect(ev.confidence).toBe(1);
  });
});

describe('edge cases (AC-10 groundwork)', () => {
  it('test 12a: a zero-length segment contributes no dose and no NaN', () => {
    const fc = flatForecast(40);
    const seg = makeSegment({ id: 'a', roadClass: 'residential', lengthM: 0 });
    const trip = engine.evaluateTrip(
      { route: makeRoute('r', [seg]), mode: 'walk', departISO: OFF_PEAK_UTC },
      { forecast: fc },
    );
    expect(trip.doseUg).toBe(0);
    expect(Number.isFinite(trip.meanConcentration)).toBe(true);
    expect(Number.isFinite(trip.confidence)).toBe(true);
    expect(trip.durationMin).toBe(0);
  });

  it('test 12b: a single-hour forecast still produces finite output', () => {
    const fc = makeForecast([
      makePoint({
        timeISO: hourISO(0),
        pm25: 55,
        aod: null,
        dust: null,
        windDirDeg: null,
        blhM: null,
        inversionK: null,
      }),
    ]);
    const route = makeRouteOfLengths('r', [500, 500], 'primary', { idPrefix: 's' });
    const trip = engine.evaluateTrip({ route, mode: 'cycle', departISO: hourISO(2) }, { forecast: fc });
    expect(Number.isFinite(trip.doseUg)).toBe(true);
    expect(Number.isFinite(trip.meanConcentration)).toBe(true);
    expect(trip.doseUg).toBeGreaterThan(0);
  });

  it('test 12c: an all-null optional forecast never yields NaN', () => {
    const fc = makeForecast(
      Array.from({ length: 6 }, (_, i) =>
        makePoint({
          timeISO: hourISO(i),
          pm25: 30,
          aod: null,
          dust: null,
          windMs: 0,
          windDirDeg: null,
          blhM: null,
          rh01: 0,
          inversionK: null,
          precipMm: 0,
        }),
      ),
    );
    const route = makeRouteOfLengths('r', [800, 800, 800], 'secondary', { idPrefix: 's' });
    const trip = engine.evaluateTrip({ route, mode: 'bus', departISO: hourISO(3) }, { forecast: fc });
    for (const s of trip.segments) {
      expect(Number.isFinite(s.concentration)).toBe(true);
      expect(Number.isFinite(s.doseUg)).toBe(true);
      expect(Number.isFinite(s.sigmaLog)).toBe(true);
      expect(s.multiplier).toBeGreaterThanOrEqual(0.3);
    }
  });

  it('test 12d: an empty route produces a finite zero trip', () => {
    const trip = engine.evaluateTrip(
      { route: makeRoute('r', []), mode: 'walk', departISO: OFF_PEAK_UTC },
      { forecast: flatForecast(40) },
    );
    expect(trip.doseUg).toBe(0);
    expect(trip.meanConcentration).toBe(0);
    expect(trip.refDosePct).toBe(0);
  });

  it('test 12e: a departure far outside the forecast clamps instead of exploding', () => {
    const fc = flatForecast(40);
    const seg = makeSegment({ id: 'a', roadClass: 'residential', lengthM: 500 });
    const trip = engine.evaluateTrip(
      { route: makeRoute('r', [seg]), mode: 'walk', departISO: '2030-01-01T00:00:00Z' },
      { forecast: fc },
    );
    expect(Number.isFinite(trip.doseUg)).toBe(true);
  });
});
