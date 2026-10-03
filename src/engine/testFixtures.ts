/**
 * Shared deterministic fixtures for engine tests.
 * SYNTHETIC test data, generated here in test code only — never shipped.
 */

import type {
  Forecast,
  HourlyPoint,
  LatLon,
  RoadClass,
  Route,
  Segment,
  SegmentFeatures,
} from '@/contracts';

export const KTM: LatLon = { lat: 27.7172, lon: 85.324 };

/** 2026-10-05 is a Monday; 00:00 UTC. */
export const T0 = '2026-10-05T00:00:00Z';

export function hourISO(offsetHours: number): string {
  return new Date(Date.parse(T0) + offsetHours * 3_600_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export function makePoint(over: Partial<HourlyPoint> = {}): HourlyPoint {
  return {
    timeISO: T0,
    pm25: 40,
    aod: null,
    dust: null,
    windMs: 2,
    windDirDeg: null,
    blhM: null,
    rh01: 0.5,
    tempC: 20,
    precipMm: 0,
    inversionK: null,
    ...over,
  };
}

export function makeForecast(hours: HourlyPoint[], over: Partial<Forecast> = {}): Forecast {
  return {
    source: 'fixture',
    fetchedAtISO: T0,
    location: KTM,
    hours: hours.slice().sort((a, b) => a.timeISO.localeCompare(b.timeISO)),
    ...over,
  };
}

export function features(over: Partial<SegmentFeatures> = {}): SegmentFeatures {
  return {
    distToMainRoadM: 500,
    intersectionDensityPer100m: 2,
    trafficSignalsWithin50m: 0,
    busStopsWithin30m: 0,
    greenFraction100m: 0,
    buildingDensity: 0.5,
    nearbyRoads: [],
    ...over,
  };
}

export function makeSegment(over: Partial<Segment> = {}): Segment {
  const roadClass: RoadClass = over.roadClass ?? 'residential';
  return {
    id: 's1',
    roadClass,
    lengthM: 1000,
    coords: [
      { lat: KTM.lat, lon: KTM.lon },
      { lat: KTM.lat + 0.01, lon: KTM.lon },
    ],
    features: features(),
    ...over,
  };
}

export function makeRoute(id: string, segments: Segment[], name = id): Route {
  return { id, name, source: 'hand-authored', segments };
}

/** Straight north-south polyline of the given total length, split into `n` segments. */
export function makeRouteOfLengths(
  id: string,
  lengthsM: number[],
  roadClass: RoadClass = 'residential',
  opts: { startLat?: number; idPrefix?: string; features?: () => SegmentFeatures } = {},
): Route {
  const startLat = opts.startLat ?? KTM.lat;
  const prefix = opts.idPrefix ?? `${id}`;
  const segments: Segment[] = [];
  let lat = startLat;
  for (let i = 0; i < lengthsM.length; i++) {
    // 1 degree latitude ≈ 111_320 m (spherical approximation, fine for a test polyline).
    const nextLat = lat + lengthsM[i] / 111_320;
    segments.push(
      makeSegment({
        id: `${prefix}-${i}`,
        roadClass,
        lengthM: lengthsM[i],
        coords: [
          { lat, lon: KTM.lon },
          { lat: nextLat, lon: KTM.lon },
        ],
        features: opts.features ? opts.features() : features(),
      }),
    );
    lat = nextLat;
  }
  return makeRoute(id, segments, id);
}
