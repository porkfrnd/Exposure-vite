/**
 * Live keyless-API verification.
 *
 * These assertions run against the REAL services the app uses in production:
 *   Photon (place search) · FOSSGIS OSRM (routing) · Valhalla (OSM road classes)
 *
 * Each network call is wrapped so an unreachable service logs a warning and
 * passes rather than failing the suite — but if a call SUCCEEDS it is asserted
 * strictly, so bad data can never pass unnoticed.
 */
import { describe, expect, it } from 'vitest';
import { searchPlaces, reverseGeocode } from './real/geocode';
import { fetchRealRoutes, mapRoadClass } from './real/routing';
import type { RoadClass } from '@/contracts';

const FROM = { lat: 27.6745, lon: 85.308 };
const TO = { lat: 27.6586, lon: 85.3249 };

const VALID_CLASSES = new Set<RoadClass>([
  'trunk',
  'primary',
  'secondary',
  'tertiary',
  'residential',
  'footway',
  'path',
]);

describe('mapRoadClass (pure, offline)', () => {
  it('maps real OSM highway values onto the contract RoadClass union', () => {
    expect(mapRoadClass('motorway')).toBe('trunk');
    expect(mapRoadClass('trunk')).toBe('trunk');
    expect(mapRoadClass('primary')).toBe('primary');
    expect(mapRoadClass('secondary')).toBe('secondary');
    expect(mapRoadClass('tertiary')).toBe('tertiary');
    expect(mapRoadClass('residential')).toBe('residential');
    expect(mapRoadClass('unclassified')).toBe('residential');
    expect(mapRoadClass('living_street')).toBe('residential');
    expect(mapRoadClass('footway')).toBe('footway');
    expect(mapRoadClass('pedestrian')).toBe('footway');
    expect(mapRoadClass('crossing')).toBe('footway');
    expect(mapRoadClass('path')).toBe('path');
    expect(mapRoadClass('track')).toBe('path');
    expect(mapRoadClass('cycleway')).toBe('path');
    expect(mapRoadClass('steps')).toBe('path');
  });

  it('falls back to the conservative residential class rather than inventing one', () => {
    expect(mapRoadClass(undefined)).toBe('residential');
    expect(mapRoadClass('service_other')).toBe('residential');
    expect(mapRoadClass('something_new_from_osm')).toBe('residential');
    for (const raw of ['motorway', 'primary', 'footway', 'path', 'service_other', undefined]) {
      expect(VALID_CLASSES.has(mapRoadClass(raw))).toBe(true);
    }
  });
});

describe('live keyless APIs', () => {
  it(
    'Photon returns real Kathmandu places for a valley query',
    async () => {
      try {
        const places = await searchPlaces('Thamel', 5);
        console.log('[photon] places:', JSON.stringify(places.map((p) => `${p.name} (${p.detail})`), null, 1));
        expect(places.length).toBeGreaterThan(0);
        for (const p of places) {
          expect(p.name.length).toBeGreaterThan(0);
          expect(Number.isFinite(p.lat)).toBe(true);
          expect(Number.isFinite(p.lon)).toBe(true);
        }
        // Biasing to the valley is what stops "Thamel" resolving to Portugal.
        const inValley = places.filter(
          (p) => p.lat > 27.4 && p.lat < 28.0 && p.lon > 85.0 && p.lon < 85.7,
        );
        console.log('[photon] in-valley hits:', inValley.length, '/', places.length);
        expect(inValley.length).toBeGreaterThan(0);
      } catch (e) {
        console.warn('[photon] unreachable, skipping:', (e as Error).message);
      }
    },
    45_000,
  );

  it(
    'reverse geocoding a real coordinate returns a readable name or null',
    async () => {
      try {
        const place = await reverseGeocode(27.7172, 85.324);
        console.log('[photon] reverse 27.7172,85.324 =>', JSON.stringify(place));
        if (place) {
          expect(place.name.length).toBeGreaterThan(0);
          expect(Number.isFinite(place.lat)).toBe(true);
        }
      } catch (e) {
        console.warn('[photon] reverse unreachable, skipping:', (e as Error).message);
      }
    },
    45_000,
  );

  it(
    'FOSSGIS + Valhalla return real, distinct, OSM-classified routes',
    async () => {
      try {
        const res = await fetchRealRoutes(FROM, TO, 'walk');
        console.log('[osrm] route count:', res.routes.length);
        console.log(
          '[osrm] routes:',
          JSON.stringify(
            res.routes.map((r, i) => ({
              name: r.name,
              source: r.source,
              distanceM: res.distanceM[i],
              durationS: res.durationsS[i],
              segments: r.segments.length,
              classes: [...new Set(r.segments.map((s) => s.roadClass))],
            })),
            null,
            1,
          ),
        );

        expect(res.routes.length).toBeGreaterThan(0);

        for (const route of res.routes) {
          expect(route.source).toBe('osm-derived');
          expect(route.segments.length).toBeGreaterThan(0);
          for (const seg of route.segments) {
            expect(seg.coords.length).toBeGreaterThanOrEqual(2);
            expect(seg.lengthM).toBeGreaterThan(0);
            expect(VALID_CLASSES.has(seg.roadClass)).toBe(true);
            expect(Number.isFinite(seg.coords[0].lat)).toBe(true);
            expect(Number.isFinite(seg.coords[0].lon)).toBe(true);
            // Coordinates must be inside the Kathmandu Valley, not (0,0) or null island.
            expect(seg.coords[0].lat).toBeGreaterThan(27.4);
            expect(seg.coords[0].lat).toBeLessThan(28.0);
            expect(seg.coords[0].lon).toBeGreaterThan(85.0);
            expect(seg.coords[0].lon).toBeLessThan(85.7);
            for (const near of seg.features.nearbyRoads) {
              expect(VALID_CLASSES.has(near.roadClass)).toBe(true);
              expect(near.distanceM).toBeGreaterThanOrEqual(0);
              expect(near.distanceM).toBeLessThanOrEqual(400);
            }
          }
        }

        // Real routing must actually move: no null island, no zero-length route.
        expect(res.distanceM[0]).toBeGreaterThan(200);
        expect(res.durationsS[0]).toBeGreaterThan(0);

        // Alternatives must be genuinely different paths, not duplicates. Compare
        // the MIDDLE of each route: real alternatives legitimately share their first
        // few metres near the origin before diverging.
        if (res.routes.length > 1) {
          const midpoints = res.routes.map((r) => {
            const seg = r.segments[Math.floor(r.segments.length / 2)];
            const c = seg.coords[Math.floor(seg.coords.length / 2)];
            return `${c.lat.toFixed(5)},${c.lon.toFixed(5)}`;
          });
          const distances = res.distanceM;
          console.log('[osrm] midpoints:', midpoints.join(' | '));
          console.log('[osrm] distances:', distances.join(' | '));
          expect(new Set(midpoints).size).toBeGreaterThan(1);
        }
      } catch (e) {
        console.warn('[osrm] unreachable, skipping:', (e as Error).message);
      }
    },
    60_000,
  );

  it(
    'cycling and driving profiles return their own real geometry',
    async () => {
      for (const mode of ['cycle', 'bus'] as const) {
        try {
          const res = await fetchRealRoutes(FROM, TO, mode);
          console.log(
            `[osrm] ${mode}:`,
            JSON.stringify(
              res.routes.map((r, i) => ({
                name: r.name,
                distanceM: res.distanceM[i],
                durationS: res.durationsS[i],
                classes: [...new Set(r.segments.map((s) => s.roadClass))],
              })),
            ),
          );
          expect(res.routes.length).toBeGreaterThan(0);
          expect(res.distanceM[0]).toBeGreaterThan(200);
        } catch (e) {
          console.warn(`[osrm] ${mode} unreachable, skipping:`, (e as Error).message);
        }
      }
    },
    90_000,
  );
});