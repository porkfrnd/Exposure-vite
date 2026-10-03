import { describe, expect, it } from 'vitest';
import { engine, DEFAULT_ENGINE_PARAMS } from './index';
import { priorMultiplier, rushFactor, amplifiedMultiplier } from './multiplier';
import { backgroundAt, stagnationIndex } from './background';
import { defaultSegmentSigma, predictUncorrected, resolveParams } from './predict';
import { features, hourISO, makeForecast, makePoint, makeSegment } from './testFixtures';
import type { Forecast } from '@/contracts';

const P = DEFAULT_ENGINE_PARAMS;

// 2026-10-05T03:15:00Z === 09:00 NPT → inside the morning band.
const RUSH_MORNING_UTC = '2026-10-05T02:00:00Z';
const RUSH_0900_UTC = '2026-10-05T03:15:00Z';
// 2026-10-05T06:00:00Z === 11:45 NPT → local hour 11, outside every configured band.
const OFF_PEAK_UTC = '2026-10-05T06:00:00Z';

function flatForecast(pm25: number, over: Partial<Forecast> = {}): Forecast {
  // 48 identical hours so nothing ever needs clamping during these assertions.
  const hours = Array.from({ length: 48 }, (_, i) =>
    makePoint({ timeISO: hourISO(i), pm25 }),
  );
  return makeForecast(hours, over);
}

describe('background (methodology 1.1)', () => {
  it('is a*pm25 + b with a hard floor of 1 µg/m³', () => {
    expect(backgroundAt(P, makePoint({ pm25: 40 }))).toBe(40);
    expect(backgroundAt(P, makePoint({ pm25: 0 }))).toBe(1);
    expect(backgroundAt(P, makePoint({ pm25: -5 }))).toBe(1);
  });

  it('applies an identity bias by default (fittedOn === null)', () => {
    expect(P.bias.a).toBe(1);
    expect(P.bias.b).toBe(0);
    expect(P.bias.fittedOn).toBeNull();
  });
});

describe('rush factor (methodology 1.2)', () => {
  it('boosts listed classes inside a listed Nepal-local hour', () => {
    expect(rushFactor(P, 'primary', RUSH_MORNING_UTC)).toBe(1.5);
    expect(rushFactor(P, 'secondary', RUSH_MORNING_UTC)).toBe(1.5);
    expect(rushFactor(P, 'trunk', RUSH_MORNING_UTC)).toBe(1.5);
  });

  it('never boosts an unlisted class, even during rush', () => {
    expect(rushFactor(P, 'residential', RUSH_MORNING_UTC)).toBe(1);
    expect(rushFactor(P, 'tertiary', RUSH_MORNING_UTC)).toBe(1);
    expect(rushFactor(P, 'footway', RUSH_MORNING_UTC)).toBe(1);
    expect(rushFactor(P, 'path', RUSH_MORNING_UTC)).toBe(1);
  });

  it('uses Nepal local time, not UTC (01:15Z is 07:00 NPT → rush)', () => {
    // 01:15Z on 2026-10-05 is 07:00 NPT.
    expect(rushFactor(P, 'primary', '2026-10-05T01:15:00Z')).toBe(1.5);
    // 20:00Z the same day is 01:45 NPT next morning → not rush.
    expect(rushFactor(P, 'primary', '2026-10-05T20:00:00Z')).toBe(1);
  });

  it('is 1 outside the configured local hours', () => {
    // 11:45 NPT (off peak) and 09:00 NPT (inside the band) on the same day.
    expect(rushFactor(P, 'primary', OFF_PEAK_UTC)).toBe(1);
    expect(rushFactor(P, 'primary', RUSH_0900_UTC)).toBe(1.5);
  });
});

describe('prior street multiplier (methodology 8.2)', () => {
  it('gives 1 + e_own for a residential road with no neighbours and no green', () => {
    // e_residential = 0.05 (ASSUMED).
    const seg = makeSegment({ roadClass: 'residential', features: features() });
    expect(priorMultiplier(P, seg, OFF_PEAK_UTC)).toBeCloseTo(1.05, 12);
  });

  it('adds the decaying excess of a nearby road', () => {
    // Footway 20 m from a primary road, off peak:
    //   m = 1 + 0·1 + 0.40·exp(−20/120) = 1 + 0.40·0.846482 ≈ 1.338593
    const seg = makeSegment({
      roadClass: 'footway',
      features: features({ nearbyRoads: [{ roadClass: 'primary', distanceM: 20 }] }),
    });
    const expected = 1 + 0.4 * Math.exp(-20 / 120);
    expect(priorMultiplier(P, seg, OFF_PEAK_UTC)).toBeCloseTo(expected, 12);
  });

  it('adds the rush factor for a nearby main road during rush', () => {
    // Same footway during the 07:45 NPT rush hour: 1 + 0.40·1.5·exp(−20/120).
    const seg = makeSegment({
      roadClass: 'footway',
      features: features({ nearbyRoads: [{ roadClass: 'primary', distanceM: 20 }] }),
    });
    const expected = 1 + 0.4 * 1.5 * Math.exp(-20 / 120);
    expect(priorMultiplier(P, seg, RUSH_MORNING_UTC)).toBeCloseTo(expected, 12);
  });

  it('subtracts the green excess', () => {
    // Footway, fully green, no roads: 1 + 0 − 0.15·1 = 0.85.
    const seg = makeSegment({
      roadClass: 'footway',
      features: features({ greenFraction100m: 1 }),
    });
    expect(priorMultiplier(P, seg, OFF_PEAK_UTC)).toBeCloseTo(0.85, 12);
  });

  it('clamps to [0.5, 3]', () => {
    const low = makeSegment({
      roadClass: 'footway',
      features: features({ greenFraction100m: 1 }),
    });
    const p = { ...P, greenExcess: 99 };
    expect(priorMultiplier(p, low, OFF_PEAK_UTC)).toBe(0.5);

    const high = makeSegment({
      roadClass: 'trunk',
      features: features({
        greenFraction100m: 0,
        nearbyRoads: Array.from({ length: 5 }, () => ({ roadClass: 'trunk' as const, distanceM: 0 })),
      }),
    });
    expect(priorMultiplier(p, high, OFF_PEAK_UTC)).toBe(3);
  });
});

describe('stagnation amplification (methodology 1.3)', () => {
  const primary = makeSegment({ roadClass: 'primary' });
  const greenFootway = makeSegment({
    roadClass: 'footway',
    features: features({ greenFraction100m: 1 }),
  });

  const calm = makeForecast([
    makePoint({ timeISO: hourISO(0), pm25: 40, blhM: 300, windMs: 1 }),
  ]);
  const windy = makeForecast([
    makePoint({ timeISO: hourISO(0), pm25: 40, blhM: 1200, windMs: 6 }),
  ]);

  it('is exactly 1 when the boundary layer is unknown', () => {
    const noBlh = makeForecast([makePoint({ timeISO: hourISO(0), pm25: 40, blhM: null })]);
    expect(stagnationIndex(P, noBlh, noBlh.hours[0])).toBe(1);
  });

  it('uses the forecast medians as references when params leave them null', () => {
    // calm: hRef = 300, uRef = 1 → (300/300)·(1/1) = 1 → S = 1.
    expect(stagnationIndex(P, calm, calm.hours[0])).toBeCloseTo(1, 12);
    // windy: hRef = 1200, uRef = 6 → (1200/1200)·(6/6) = 1 → S = 1.
    expect(stagnationIndex(P, windy, windy.hours[0])).toBeCloseTo(1, 12);
  });

  it('raises m′ on a main road when the air is more stagnant than its own window', () => {
    // Reference window is the windy forecast (hRef 1200, uRef 6); sample a stagnant hour.
    const ref = windy.hours[0];
    const stagnantPoint = makePoint({ timeISO: hourISO(0), pm25: 40, blhM: 300, windMs: 1 });
    const S = (1200 / 300) * (6 / Math.max(1, 0.5));
    // (1200/300)=4, (6/1)=6 → 24 → clamped to clampMax = 2.
    expect(S).toBe(24);
    const sClamped = stagnationIndex(P, windy, stagnantPoint);
    expect(sClamped).toBe(2);

    const mOffPeak = priorMultiplier(P, primary, OFF_PEAK_UTC);
    const mRushOff = amplifiedMultiplier(mOffPeak, sClamped, P.stagnation.alpha);
    const mRushOn = amplifiedMultiplier(mOffPeak, 1, P.stagnation.alpha);
    expect(mRushOff).toBeGreaterThan(mRushOn);
  });

  it('lowers m′ on a green footway under the same stagnation', () => {
    const ref = windy.hours[0];
    const stagnantPoint = makePoint({ timeISO: hourISO(0), pm25: 40, blhM: 300, windMs: 1 });
    const sClamped = stagnationIndex(P, windy, stagnantPoint);
    const m = priorMultiplier(P, greenFootway, OFF_PEAK_UTC);
    const still = amplifiedMultiplier(m, sClamped, P.stagnation.alpha);
    const mixed = amplifiedMultiplier(m, 1, P.stagnation.alpha);
    expect(still).toBeLessThan(mixed);
  });

  it('clamps S to [clampMin, clampMax]', () => {
    // Absurdly windy + high boundary layer pushes the raw ratio far below clampMin.
    const windyRef = makeForecast([makePoint({ timeISO: hourISO(0), pm25: 40, blhM: 2000, windMs: 20 })]);
    const veryStagnant = makePoint({ timeISO: hourISO(0), pm25: 40, blhM: 2000, windMs: 0.1 });
    const s = stagnationIndex(P, windyRef, veryStagnant);
    expect(s).toBe(P.stagnation.clampMax); // u floor keeps the raw value large → clampMax
    const calmRef = makeForecast([makePoint({ timeISO: hourISO(0), pm25: 40, blhM: 100, windMs: 0.5 })]);
    const veryMixed = makePoint({ timeISO: hourISO(0), pm25: 40, blhM: 3000, windMs: 30 });
    expect(stagnationIndex(P, calmRef, veryMixed)).toBe(P.stagnation.clampMin);
  });

  it('never produces an m′ below 0.3', () => {
    expect(amplifiedMultiplier(0.5, 0.5, 0.5)).toBeGreaterThanOrEqual(0.3);
    expect(amplifiedMultiplier(0.5, 0.5, 10)).toBeGreaterThanOrEqual(0.3);
  });
});

describe('predict (uncorrected C_bg · m′)', () => {
  it('test 1: flat pm25 = 40, no blh, residential, no neighbours, off peak → 42', () => {
    const fc = flatForecast(40);
    const seg = makeSegment({ roadClass: 'residential', features: features() });
    // blh is null in makePoint ⇒ S = 1 ⇒ m′ = m = 1.05. C = 40 · 1.05 = 42.
    const out = engine.predict(seg, OFF_PEAK_UTC, { forecast: fc });
    expect(out.concentration).toBeCloseTo(42, 9);
    expect(out.sigmaLog).toBeCloseTo(defaultSegmentSigma(P), 12);
  });

  it('test 1b: the default segment sigma is sqrt(0.25² + 0.10²)', () => {
    expect(defaultSegmentSigma(P)).toBeCloseTo(Math.sqrt(0.0625 + 0.01), 12);
  });

  it('never returns NaN for a segment with no nearby roads and no green', () => {
    const fc = flatForecast(40);
    const seg = makeSegment({ roadClass: 'tertiary' });
    expect(Number.isFinite(engine.predict(seg, OFF_PEAK_UTC, { forecast: fc }).concentration)).toBe(true);
  });

  it('honours a params override for roadExcess', () => {
    const fc = flatForecast(40);
    const seg = makeSegment({ roadClass: 'primary' });
    const ctx = { forecast: fc, params: { roadExcess: { ...P.roadExcess, primary: 0.5 } } };
    // 1 + 0.5 = 1.5 → 40 · 1.5 = 60.
    expect(engine.predict(seg, OFF_PEAK_UTC, ctx).concentration).toBeCloseTo(60, 9);
  });
});

describe('predictUncorrected / resolveParams', () => {
  it('resolveParams returns the untouched defaults when nothing is overridden', () => {
    const p = resolveParams({ forecast: flatForecast(40) });
    expect(p.roadExcess.trunk).toBe(P.roadExcess.trunk);
  });

  it('predictUncorrected equals engine.predict', () => {
    const fc = flatForecast(55);
    const seg = makeSegment({ roadClass: 'secondary' });
    const a = engine.predict(seg, RUSH_MORNING_UTC, { forecast: fc });
    const b = predictUncorrected(P, fc, seg, RUSH_MORNING_UTC);
    expect(a.concentration).toBeCloseTo(b.concentration, 12);
  });
});
