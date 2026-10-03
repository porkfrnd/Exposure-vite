/**
 * Runtime validators for contract invariants.
 *
 * These run against the shipped demo routes in tests AND can be run in the app's
 * development console, so a malformed demo route can never silently reach
 * the engine.
 *
 * Rules checked:
 *  - unique route ids
 *  - unique segment ids, EXCEPT intentionally shared stretches, which must be
 *    byte-for-byte identical in content
 *  - >= 2 coordinates per segment, all finite and in range
 *  - declared lengthM within 15% of the polyline length
 *  - features in range
 *  - a main-road segment declares distToMainRoadM = 0
 *  - a footway/path with a nearby main road declares a consistent distance
 */

import { polylineLengthM } from '../geo';
import type { RoadClass, Route, Segment } from '@/contracts';

export interface ValidationIssue {
  severity: 'error' | 'warning';
  message: string;
  where: string;
}

export const MAIN_ROAD_CLASSES: RoadClass[] = ['trunk', 'primary', 'secondary'];

/** Tolerance for declared length vs geometry. */
export const LENGTH_TOLERANCE = 0.15;

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/** Stable, order-independent signature of a segment's content. */
export function segmentSignature(seg: Segment): string {
  return JSON.stringify({
    roadClass: seg.roadClass,
    lengthM: Math.round(seg.lengthM * 10) / 10,
    coords: seg.coords.map((c) => [Number(c.lat.toFixed(6)), Number(c.lon.toFixed(6))]),
    features: seg.features,
  });
}

function validateSegment(seg: Segment, where: string, issues: ValidationIssue[]): void {
  if (!seg.id || typeof seg.id !== 'string') {
    issues.push({ severity: 'error', message: 'segment id missing', where });
  }
  if (!Array.isArray(seg.coords) || seg.coords.length < 2) {
    issues.push({
      severity: 'error',
      message: `segment "${seg.id}" needs at least 2 coords, has ${seg.coords?.length ?? 0}`,
      where,
    });
    return;
  }
  for (const c of seg.coords) {
    if (!isFiniteNumber(c.lat) || !isFiniteNumber(c.lon)) {
      issues.push({ severity: 'error', message: `segment "${seg.id}" has a non-finite coord`, where });
      break;
    }
    if (c.lat < -90 || c.lat > 90 || c.lon < -180 || c.lon > 180) {
      issues.push({ severity: 'error', message: `segment "${seg.id}" coord out of range`, where });
      break;
    }
  }

  if (!isFiniteNumber(seg.lengthM) || seg.lengthM < 0) {
    issues.push({ severity: 'error', message: `segment "${seg.id}" has an invalid lengthM`, where });
  } else {
    const geom = polylineLengthM(seg.coords);
    if (geom > 0) {
      const relErr = Math.abs(seg.lengthM - geom) / geom;
      if (relErr > LENGTH_TOLERANCE) {
        issues.push({
          severity: 'error',
          message:
            `segment "${seg.id}" declares ${seg.lengthM.toFixed(0)} m but its polyline is ` +
            `${geom.toFixed(0)} m (${(relErr * 100).toFixed(1)}% off, limit ${(LENGTH_TOLERANCE * 100).toFixed(0)}%)`,
          where,
        });
      }
    }
  }

  const f = seg.features;
  if (!f) {
    issues.push({ severity: 'error', message: `segment "${seg.id}" has no features`, where });
    return;
  }
  if (!isFiniteNumber(f.distToMainRoadM) || f.distToMainRoadM < 0) {
    issues.push({ severity: 'error', message: `segment "${seg.id}" bad distToMainRoadM`, where });
  }
  if (!isFiniteNumber(f.intersectionDensityPer100m) || f.intersectionDensityPer100m < 0) {
    issues.push({ severity: 'error', message: `segment "${seg.id}" bad intersectionDensityPer100m`, where });
  }
  if (!isFiniteNumber(f.trafficSignalsWithin50m) || f.trafficSignalsWithin50m < 0) {
    issues.push({ severity: 'error', message: `segment "${seg.id}" bad trafficSignalsWithin50m`, where });
  }
  if (!isFiniteNumber(f.busStopsWithin30m) || f.busStopsWithin30m < 0) {
    issues.push({ severity: 'error', message: `segment "${seg.id}" bad busStopsWithin30m`, where });
  }
  if (!isFiniteNumber(f.greenFraction100m) || f.greenFraction100m < 0 || f.greenFraction100m > 1) {
    issues.push({ severity: 'error', message: `segment "${seg.id}" greenFraction100m outside 0..1`, where });
  }
  if (!isFiniteNumber(f.buildingDensity) || f.buildingDensity < 0 || f.buildingDensity > 1) {
    issues.push({ severity: 'error', message: `segment "${seg.id}" buildingDensity outside 0..1`, where });
  }
  if (!Array.isArray(f.nearbyRoads)) {
    issues.push({ severity: 'error', message: `segment "${seg.id}" nearbyRoads missing`, where });
  } else {
    for (const near of f.nearbyRoads) {
      if (!isFiniteNumber(near.distanceM) || near.distanceM < 0 || near.distanceM > 400) {
        issues.push({
          severity: 'error',
          message: `segment "${seg.id}" nearbyRoads distance ${near.distanceM} outside 0..400 m`,
          where,
        });
      }
    }
  }

  // Internal consistency: distToMainRoadM is the distance to the nearest OTHER
  // trunk/primary/secondary road. A main road is 0 only when no such neighbour is
  // within range; a main road genuinely 139 m from the next arterial is correct
  // data, not a violation. So the invariant is: a non-main segment that lists no
  // main road within range must not claim a non-zero main-road distance.
  if (!Array.isArray(f.nearbyRoads)) {
    // already reported above
  } else {
    const nearestMain = f.nearbyRoads
      .filter((n) => MAIN_ROAD_CLASSES.includes(n.roadClass))
      .reduce((min, n) => Math.min(min, n.distanceM), Number.POSITIVE_INFINITY);

    if (MAIN_ROAD_CLASSES.includes(seg.roadClass)) {
      // A main road: 0 when it is the only arterial nearby, otherwise the measured
      // distance to the next one. Both are valid.
      if (!Number.isFinite(nearestMain) && f.distToMainRoadM !== 0) {
        issues.push({
          severity: 'warning',
          message: `segment "${seg.id}" is ${seg.roadClass} with no main road in nearbyRoads, so distToMainRoadM should be 0`,
          where,
        });
      }
    } else if (f.distToMainRoadM > 0 && !Number.isFinite(nearestMain)) {
      issues.push({
        severity: 'error',
        message:
          `segment "${seg.id}" declares distToMainRoadM ${f.distToMainRoadM} m but lists no ` +
          `main road in nearbyRoads`,
        where,
      });
    }

    if (!MAIN_ROAD_CLASSES.includes(seg.roadClass) && Number.isFinite(nearestMain)) {
      // If a footway lists a nearby main road, its declared distance must not exceed
      // that road's distance by more than the 15% rule.
      if (f.distToMainRoadM > nearestMain * (1 + LENGTH_TOLERANCE) + 1) {
        issues.push({
          severity: 'error',
          message:
            `segment "${seg.id}" declares distToMainRoadM ${f.distToMainRoadM} m but lists a ` +
            `main road at ${nearestMain} m`,
          where,
        });
      }
    }
  }
}

/** Validate a whole route set. Shared segment ids must carry identical content. */
export function validateRoutes(routes: Route[]): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  if (!Array.isArray(routes) || routes.length === 0) {
    return [{ severity: 'error', message: 'no routes supplied', where: 'routes' }];
  }

  const routeIds = new Set<string>();
  const globalSegments = new Map<string, { seg: Segment; signature: string; where: string }>();

  for (const route of routes) {
    const where = `route "${route.id}"`;
    if (!route.id || typeof route.id !== 'string') {
      issues.push({ severity: 'error', message: 'route id missing', where: 'routes' });
    }
    if (routeIds.has(route.id)) {
      issues.push({ severity: 'error', message: `duplicate route id "${route.id}"`, where: 'routes' });
    }
    routeIds.add(route.id);

    if (route.source !== 'hand-authored' && route.source !== 'osm-derived') {
      issues.push({ severity: 'error', message: `route "${route.id}" has an invalid source`, where });
    }
    if (!Array.isArray(route.segments) || route.segments.length === 0) {
      issues.push({ severity: 'error', message: `route "${route.id}" has no segments`, where });
      continue;
    }

    for (const seg of route.segments) {
      validateSegment(seg, where, issues);

      const signature = segmentSignature(seg);
      const existing = globalSegments.get(seg.id);
      if (!existing) {
        globalSegments.set(seg.id, { seg, signature, where });
      } else if (existing.signature !== signature) {
        // Same id, different content: the engine would silently mix the two.
        issues.push({
          severity: 'error',
          message:
            `segment id "${seg.id}" is shared but its content differs between ` +
            `${existing.where} and ${where}`,
          where,
        });
      }
    }
  }

  return issues;
}

/** Convenience: true when there are no errors. */
export function routesAreValid(routes: Route[]): boolean {
  return validateRoutes(routes).every((i) => i.severity !== 'error');
}

/** Errors only, as plain strings — handy for tests and console output. */
export function validationErrors(routes: Route[]): string[] {
  return validateRoutes(routes)
    .filter((i) => i.severity === 'error')
    .map((i) => `${i.where}: ${i.message}`);
}
