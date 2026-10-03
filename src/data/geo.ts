/**
 * Geodesy for the data layer. Pure, no dependencies.
 *
 * Distances use an equirectangular projection about a reference latitude, which is
 * accurate to well under a metre over the few-kilometre scale this app works at,
 * and keeps the maths simple enough to check by hand.
 */

import type { LatLon, Segment } from '@/contracts';

const EARTH_R = 6_371_000; // m — mean Earth radius (ASSUMED standard constant)
const DEG = Math.PI / 180;

/** Metres per degree of latitude / longitude at a given latitude. */
export function metresPerDeg(lat: number): { dLat: number; dLon: number } {
  const dLat = 111_320;
  const dLon = 111_320 * Math.cos(lat * DEG);
  return { dLat, dLon };
}

export interface XY {
  x: number;
  y: number;
}

/** Project to local metres about `origin`. */
export function project(p: LatLon, origin: LatLon): XY {
  const { dLat, dLon } = metresPerDeg(origin.lat);
  return { x: (p.lon - origin.lon) * dLon, y: (p.lat - origin.lat) * dLat };
}

/** Inverse of project(). */
export function unproject(xy: XY, origin: LatLon): LatLon {
  const { dLat, dLon } = metresPerDeg(origin.lat);
  return { lat: origin.lat + xy.y / dLat, lon: origin.lon + xy.x / dLon };
}

/** Great-circle distance in metres. */
export function haversineM(a: LatLon, b: LatLon): number {
  const dLat = (b.lat - a.lat) * DEG;
  const dLon = (b.lon - a.lon) * DEG;
  const la1 = a.lat * DEG;
  const la2 = b.lat * DEG;
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_R * Math.asin(Math.min(1, Math.max(0, Math.sqrt(h))));
}

/** Squared planar distance, avoiding a sqrt when only ordering matters. */
function dist2XY(a: XY, b: XY): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy;
}

/**
 * Shortest distance in metres from a point to a polyline (0 when the polyline has
 * fewer than two points, in which case we fall back to point distance).
 */
export function distanceToPolylineM(p: LatLon, line: LatLon[]): number {
  if (!Array.isArray(line) || line.length === 0) return Number.POSITIVE_INFINITY;
  const origin = line[0];
  const pts = line.map((q) => project(q, origin));
  const target = project(p, origin);

  if (pts.length === 1) return Math.sqrt(dist2XY(pts[0], target));

  let best = Number.POSITIVE_INFINITY;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    const vx = b.x - a.x;
    const vy = b.y - a.y;
    const len2 = vx * vx + vy * vy;
    let t = 0;
    if (len2 > 0) {
      t = ((target.x - a.x) * vx + (target.y - a.y) * vy) / len2;
      t = Math.min(1, Math.max(0, t));
    }
    const cx = a.x + t * vx;
    const cy = a.y + t * vy;
    const d2 = (target.x - cx) ** 2 + (target.y - cy) ** 2;
    if (d2 < best) best = d2;
  }
  return Math.sqrt(best);
}

/** Planar length of a polyline in metres. */
export function polylineLengthM(line: LatLon[]): number {
  if (!Array.isArray(line) || line.length < 2) return 0;
  const origin = line[0];
  let total = 0;
  let prev = project(line[0], origin);
  for (let i = 1; i < line.length; i++) {
    const cur = project(line[i], origin);
    total += Math.sqrt(dist2XY(prev, cur));
    prev = cur;
  }
  return total;
}

/** Midpoint of a segment polyline, in lat/lon. Used as the segment's query point. */
export function segmentMidpoint(segment: Segment): LatLon {
  const c = segment.coords;
  if (!Array.isArray(c) || c.length === 0) return { lat: 0, lon: 0 };
  if (c.length === 1) return { ...c[0] };
  const mid = c[Math.floor(c.length / 2)];
  return { lat: mid.lat, lon: mid.lon };
}

export interface NearestSegment {
  segment: Segment;
  distanceM: number;
}

/** Nearest segment to a point, by point-to-polyline distance. */
export function nearestSegment(p: LatLon, segments: Segment[]): NearestSegment | null {
  if (!Array.isArray(segments) || segments.length === 0) return null;
  let best: NearestSegment | null = null;
  for (const segment of segments) {
    const d = distanceToPolylineM(p, segment.coords);
    if (!Number.isFinite(d)) continue;
    if (!best || d < best.distanceM) best = { segment, distanceM: d };
  }
  return best;
}

/** All unique segments across a set of routes, de-duplicated by id. */
export function uniqueSegments(routes: Array<{ segments: Segment[] }>): Segment[] {
  const seen = new Map<string, Segment>();
  for (const route of routes ?? []) {
    for (const seg of route?.segments ?? []) {
      if (!seen.has(seg.id)) seen.set(seg.id, seg);
    }
  }
  return [...seen.values()];
}
