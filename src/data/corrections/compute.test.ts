import { describe, expect, it } from 'vitest';
import { computeCorrections, segmentFeatureVector, matern32, MIN_PHOTOS } from './compute';
import { cholesky, choleskySolve, invert, solve } from '../linalg';
import { distanceToPolylineM } from '../geo';
import type { Observation, PhotoObservation, PredictFn, ReportObservation, Segment } from '@/contracts';

const ANCHOR = '2026-10-03T12:00:00Z';

/** Two segments 400 m apart along the equator-ish corridor, for clean distances. */
function segmentsPair(): Segment[] {
  return [
    {
      id: 'near',
      roadClass: 'primary',
      lengthM: 200,
      coords: [
        { lat: 27.67, lon: 85.33 },
        { lat: 27.6718, lon: 85.33 },
      ],
      features: {
        distToMainRoadM: 0,
        intersectionDensityPer100m: 3,
        trafficSignalsWithin50m: 1,
        busStopsWithin30m: 1,
        greenFraction100m: 0.05,
        buildingDensity: 0.85,
        nearbyRoads: [],
      },
    },
    {
      id: 'far',
      roadClass: 'footway',
      lengthM: 200,
      coords: [
        { lat: 27.674, lon: 85.33 },
        { lat: 27.6758, lon: 85.33 },
      ],
      features: {
        distToMainRoadM: 380,
        intersectionDensityPer100m: 0.5,
        trafficSignalsWithin50m: 0,
        busStopsWithin30m: 0,
        greenFraction100m: 0.9,
        buildingDensity: 0.1,
        nearbyRoads: [{ roadClass: 'primary', distanceM: 380 }],
      },
    },
  ];
}

/** Midpoint of the 'near' segment, so an observation there is 0 m from it. */
const NEAR_MID = { lat: 27.6709, lon: 85.33 };
const FAR_MID = { lat: 27.6749, lon: 85.33 };

function photo(i: number, lat: number, lon: number, tauOpt: number, at = ANCHOR): PhotoObservation {
  return {
    id: `p${i}`,
    kind: 'photo',
    lat,
    lon,
    timeISO: at,
    isSimulated: true,
    tauOpt,
    rh01: 0.6,
    scene: 'open',
  };
}

function report(i: number, lat: number, lon: number, kind: ReportObservation['report']): ReportObservation {
  return {
    id: `r${i}`,
    kind: 'report',
    report: kind,
    lat,
    lon,
    timeISO: ANCHOR,
    isSimulated: false,
  };
}

/** PredictFn: a flat, boring model so corrections are the only signal. */
const flatPredict: PredictFn = () => ({ concentration: 50, sigmaLog: 0.27 });

describe('matern32', () => {
  it('is 1 at zero distance and decays to 0', () => {
    expect(matern32(0)).toBeCloseTo(1, 12);
    expect(matern32(1)).toBeCloseTo((1 + Math.sqrt(3)) * Math.exp(-Math.sqrt(3)), 12);
    expect(matern32(50)).toBeLessThan(1e-10);
  });

  it('is defined for negative and non-finite input', () => {
    expect(matern32(-1)).toBe(0);
    expect(Number.isFinite(matern32(NaN))).toBe(true);
  });
});

describe('linalg', () => {
  it('solves a known 2x2 SPD system', () => {
    // [4 1; 1 3] x = [1; 2]  ⇒  x = [1/11, 7/11]
    const A = [
      [4, 1],
      [1, 3],
    ];
    const b = [1, 2];
    const x = solve(A, b);
    expect(x[0]).toBeCloseTo(1 / 11, 10);
    expect(x[1]).toBeCloseTo(7 / 11, 10);
  });

  it('cholesky-solves the same system as the generic solver', () => {
    const A = [
      [4, 1],
      [1, 3],
    ];
    const b = [1, 2];
    const L = cholesky(A);
    expect(L).not.toBeNull();
    const x = choleskySolve(L!, b);
    expect(x[0]).toBeCloseTo(1 / 11, 10);
    expect(x[1]).toBeCloseTo(7 / 11, 10);
  });

  it('inverts a matrix so that A·A⁻¹ = I', () => {
    const A = [
      [2, 0.5, 0.1],
      [0.5, 3, 0.2],
      [0.1, 0.2, 1.5],
    ];
    const inv = invert(A);
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) {
        let sum = 0;
        for (let k = 0; k < 3; k++) sum += A[i][k] * inv[k][j];
        expect(sum).toBeCloseTo(i === j ? 1 : 0, 8);
      }
    }
  });

  it('returns zeros rather than throwing on a singular matrix', () => {
    const x = solve(
      [
        [1, 1],
        [1, 1],
      ],
      [1, 2],
    );
    expect(x.every(Number.isFinite)).toBe(true);
  });

  it('reports a non-PD matrix as a failed factorisation', () => {
    expect(
      cholesky([
        [1, 2],
        [2, 1],
      ]),
    ).toBeNull();
  });
});

describe('segmentFeatureVector', () => {
  it('has 7 finite components', () => {
    const x = segmentFeatureVector(segmentsPair()[0]);
    expect(x.length).toBe(7);
    expect(x.every(Number.isFinite)).toBe(true);
  });

  it('log-normalises the distance so it lands in 0..1', () => {
    const x = segmentFeatureVector(segmentsPair()[1]);
    expect(x[1]).toBeGreaterThan(0);
    expect(x[1]).toBeLessThanOrEqual(1);
  });
});

describe('computeCorrections', () => {
  const segs = segmentsPair();

  it('returns {} for zero observations', () => {
    expect(computeCorrections({ observations: [], segments: segs, atISO: ANCHOR, predict: flatPredict })).toEqual({});
  });

  it('returns {} when every observation is far outside the time window', () => {
    const old = photo(1, NEAR_MID.lat, NEAR_MID.lon, 0.5, '2026-10-01T12:00:00Z');
    expect(computeCorrections({ observations: [old], segments: segs, atISO: ANCHOR, predict: flatPredict })).toEqual({});
  });

  it('returns {} when every observation is beyond the assignment radius', () => {
    const distant = photo(1, 27.7, 85.4, 0.5);
    expect(computeCorrections({ observations: [distant], segments: segs, atISO: ANCHOR, predict: flatPredict })).toEqual({});
  });

  it('ignores photos below the minimum count but still uses reports', () => {
    const photos = [photo(1, NEAR_MID.lat, NEAR_MID.lon, 0.9), photo(2, NEAR_MID.lat, NEAR_MID.lon, 0.3)];
    const onlyPhotos = computeCorrections({
      observations: photos,
      segments: segs,
      atISO: ANCHOR,
      predict: flatPredict,
    });
    expect(Object.keys(onlyPhotos).length).toBe(0);

    const withReport = computeCorrections({
      observations: [...photos, report(3, NEAR_MID.lat, NEAR_MID.lon, 'smoky')],
      segments: segs,
      atISO: ANCHOR,
      predict: flatPredict,
    });
    expect(Object.keys(withReport).length).toBeGreaterThan(0);
  });

  it('needs at least MIN_PHOTOS photos for the photo layer', () => {
    expect(MIN_PHOTOS).toBe(3);
  });

  it('redistributes exposure: a hazier cluster rises while a clearer one falls', () => {
    // The photo layer is anchored on the MEDIAN, so it can only move a segment
    // RELATIVE to the batch. Hazier-than-batch photos push their own segment up.
    const hazier = [
      photo(1, NEAR_MID.lat, NEAR_MID.lon, 1.0),
      photo(2, NEAR_MID.lat + 0.00004, NEAR_MID.lon, 1.0),
      photo(3, NEAR_MID.lat - 0.00004, NEAR_MID.lon, 1.0),
    ];
    const clearer = [
      photo(4, FAR_MID.lat, FAR_MID.lon, 0.3),
      photo(5, FAR_MID.lat + 0.00004, FAR_MID.lon, 0.3),
      photo(6, FAR_MID.lat - 0.00004, FAR_MID.lon, 0.3),
    ];
    const map = computeCorrections({
      observations: [...hazier, ...clearer],
      segments: segs,
      atISO: ANCHOR,
      predict: flatPredict,
    });
    expect(map.near!.deltaLog).toBeGreaterThan(0);
    expect(map.far!.deltaLog).toBeLessThan(0);
    // Net movement is a REDISTRIBUTION, not a level shift: the mean log-change
    // across the two segments stays close to zero.
    const mean = (map.near!.deltaLog + map.far!.deltaLog) / 2;
    expect(Math.abs(mean)).toBeLessThan(0.1);
  });

  it('raises confidence where the cluster sits, and lowers it further away', () => {
    const cluster = [
      photo(1, NEAR_MID.lat, NEAR_MID.lon, 1.0),
      photo(2, NEAR_MID.lat + 0.00004, NEAR_MID.lon, 1.0),
      photo(3, NEAR_MID.lat - 0.00004, NEAR_MID.lon, 1.0),
    ];
    const map = computeCorrections({
      observations: cluster,
      segments: segs,
      atISO: ANCHOR,
      predict: flatPredict,
    });
    expect(map.near!.confidence).toBeGreaterThan(0);
    expect(map.far!.confidence).toBeLessThan(map.near!.confidence);
    expect(map.far!.supportN).toBeLessThan(map.near!.supportN);
  });

  it('confidence decays with the time gap', () => {
    const cluster = [
      photo(1, NEAR_MID.lat, NEAR_MID.lon, 1.0, '2026-10-03T12:00:00Z'),
      photo(2, NEAR_MID.lat, NEAR_MID.lon, 1.0, '2026-10-03T12:00:00Z'),
      photo(3, NEAR_MID.lat, NEAR_MID.lon, 1.0, '2026-10-03T12:00:00Z'),
    ];
    const fresh = computeCorrections({
      observations: cluster,
      segments: [segs[0]],
      atISO: '2026-10-03T12:00:00Z',
      predict: flatPredict,
    });
    // One hour earlier, still inside the ±window, so support must be weaker.
    const stale = computeCorrections({
      observations: cluster,
      segments: [segs[0]],
      atISO: '2026-10-03T11:00:00Z',
      predict: flatPredict,
    });
    expect(fresh.near!.confidence).toBeGreaterThan(stale.near!.confidence);
  });

  it('gives a near-zero deltaLog when every photo agrees', () => {
    const cluster = [
      photo(1, NEAR_MID.lat, NEAR_MID.lon, 0.5),
      photo(2, NEAR_MID.lat, NEAR_MID.lon, 0.5),
      photo(3, NEAR_MID.lat, NEAR_MID.lon, 0.5),
    ];
    const map = computeCorrections({
      observations: cluster,
      segments: segs,
      atISO: ANCHOR,
      predict: flatPredict,
    });
    // The photo layer is median-anchored, so identical photos must NOT shift the
    // estimate: it redistributes exposure, it never changes the regional level.
    expect(Math.abs(map.near!.deltaLog)).toBeLessThan(0.05);
  });

  it('shifts a smoky report up and a clear report down', () => {
    const smoky = computeCorrections({
      observations: [report(1, NEAR_MID.lat, NEAR_MID.lon, 'smoky')],
      segments: segs,
      atISO: ANCHOR,
      predict: flatPredict,
    });
    const clear = computeCorrections({
      observations: [report(2, NEAR_MID.lat, NEAR_MID.lon, 'clear')],
      segments: segs,
      atISO: ANCHOR,
      predict: flatPredict,
    });
    expect(smoky.near!.deltaLog).toBeGreaterThan(0);
    expect(clear.near!.deltaLog).toBeLessThan(0);
  });

  it('shrinks a single report to well under the full residual', () => {
    const map = computeCorrections({
      observations: [report(1, NEAR_MID.lat, NEAR_MID.lon, 'smoky')],
      segments: segs,
      atISO: ANCHOR,
      predict: flatPredict,
    });
    expect(map.near!.deltaLog).toBeGreaterThan(0);
    expect(map.near!.deltaLog).toBeLessThan(Math.log(1.3));
  });

  it('clamps the emitted deltaLog to the documented bound', () => {
    const extreme = [
      photo(1, NEAR_MID.lat, NEAR_MID.lon, 6),
      photo(2, NEAR_MID.lat, NEAR_MID.lon, 0.05),
      photo(3, NEAR_MID.lat, NEAR_MID.lon, 6),
      photo(4, NEAR_MID.lat, NEAR_MID.lon, 0.05),
    ];
    const map = computeCorrections({ observations: extreme, segments: segs, atISO: ANCHOR, predict: flatPredict });
    for (const c of Object.values(map)) {
      expect(c.deltaLog).toBeLessThanOrEqual(0.7 + 1e-9);
      expect(c.deltaLog).toBeGreaterThanOrEqual(-0.7 - 1e-9);
    }
  });

  it('omits a segment that no observation is anywhere near', () => {
    const cluster = [
      photo(1, NEAR_MID.lat, NEAR_MID.lon, 0.6),
      photo(2, NEAR_MID.lat, NEAR_MID.lon, 0.6),
      photo(3, NEAR_MID.lat, NEAR_MID.lon, 0.6),
    ];
    // A segment ~15 km away: the GP spatial kernel has effectively vanished there.
    const distant: Segment = {
      ...segs[1],
      id: 'distant',
      coords: [
        { lat: 27.8, lon: 85.33 },
        { lat: 27.8018, lon: 85.33 },
      ],
      features: { ...segs[1].features, distToMainRoadM: 200 },
    };
    const map = computeCorrections({
      observations: cluster,
      segments: [...segs, distant],
      atISO: ANCHOR,
      predict: flatPredict,
    });
    expect(map.near).toBeDefined();
    expect(map.distant).toBeUndefined();
  });

  it('applies the humidity correction', () => {
    // f(RH) = (1 − RH)^(−γ) rises with humidity and the calibration divides it out,
    // so the SAME optical depth in humid air implies LESS particle mass. A humid
    // photo therefore pulls the estimate DOWN relative to dry ones.
    const dry = photo(1, NEAR_MID.lat, NEAR_MID.lon, 0.6);
    const humid = { ...photo(2, NEAR_MID.lat, NEAR_MID.lon, 0.6), rh01: 0.9 };
    const third = photo(3, NEAR_MID.lat, NEAR_MID.lon, 0.6);
    const map = computeCorrections({
      observations: [dry, humid, third],
      segments: segs,
      atISO: ANCHOR,
      predict: flatPredict,
    });
    expect(Number.isFinite(map.near!.deltaLog)).toBe(true);
    expect(map.near!.deltaLog).toBeLessThan(0);
  });

  it('produces no NaN for observations at identical coordinates', () => {
    const dupes: Observation[] = [];
    for (let i = 0; i < 8; i++) {
      dupes.push(photo(i, NEAR_MID.lat, NEAR_MID.lon, 0.4 + i * 0.05));
    }
    const map = computeCorrections({ observations: dupes, segments: segs, atISO: ANCHOR, predict: flatPredict });
    for (const c of Object.values(map)) {
      expect(Number.isFinite(c.deltaLog)).toBe(true);
      expect(Number.isFinite(c.confidence)).toBe(true);
      expect(Number.isFinite(c.sigmaLog)).toBe(true);
      expect(Number.isFinite(c.supportN)).toBe(true);
      expect(c.confidence).toBeGreaterThanOrEqual(0);
      expect(c.confidence).toBeLessThanOrEqual(1);
    }
  });

  it('produces no NaN when the predict function throws', () => {
    const badPredict: PredictFn = () => {
      throw new Error('boom');
    };
    const cluster = [
      photo(1, NEAR_MID.lat, NEAR_MID.lon, 0.7),
      photo(2, NEAR_MID.lat, NEAR_MID.lon, 0.7),
      photo(3, NEAR_MID.lat, NEAR_MID.lon, 0.7),
    ];
    const map = computeCorrections({ observations: cluster, segments: segs, atISO: ANCHOR, predict: badPredict });
    for (const c of Object.values(map)) {
      expect(Number.isFinite(c.deltaLog)).toBe(true);
    }
  });

  it('respects custom prior/floor sigmas', () => {
    const cluster = [
      photo(1, NEAR_MID.lat, NEAR_MID.lon, 0.8),
      photo(2, NEAR_MID.lat, NEAR_MID.lon, 0.8),
      photo(3, NEAR_MID.lat, NEAR_MID.lon, 0.8),
    ];
    const map = computeCorrections({
      observations: cluster,
      segments: segs,
      atISO: ANCHOR,
      predict: flatPredict,
      params: { priorSigmaLog: 0.5, floorSigmaLog: 0.2 },
    });
    const expectedFloor = 0.2;
    expect(map.near!.sigmaLog).toBeGreaterThanOrEqual(expectedFloor - 1e-12);
  });

  it('stays fast enough for 30 observations and 60 segments', () => {
    const segs60: Segment[] = [];
    for (let i = 0; i < 60; i++) {
      const base = segs[i % 2];
      segs60.push({ ...base, id: `s${i}` });
    }
    const observations: Observation[] = [];
    for (let i = 0; i < 30; i++) {
      const target = segs[i % 2];
      const mid = target.coords[Math.floor(target.coords.length / 2)];
      observations.push(
        i % 4 === 0
          ? report(i, mid.lat, mid.lon, i % 8 === 0 ? 'clear' : 'smoky')
          : photo(i, mid.lat + i * 1e-5, mid.lon, 0.2 + (i % 7) * 0.1),
      );
    }

    const t0 = performance.now();
    const map = computeCorrections({ observations, segments: segs60, atISO: ANCHOR, predict: flatPredict });
    const ms = performance.now() - t0;
    expect(Object.keys(map).length).toBeGreaterThan(0);
    expect(ms).toBeLessThan(150);
  });
});