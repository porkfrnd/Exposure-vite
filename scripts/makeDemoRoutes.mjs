/**
 * scripts/makeDemoRoutes.mjs
 * ---------------------------------------------------------------------------
 * Emits src/data/fixtures/demoRoutes.json.
 *
 * INTEGRITY: this script does NOT call OpenStreetMap, OSRM, Overpass or any other
 * routing/geocoding service. The corridor, the road classes and every segment
 * feature were chosen by hand for this prototype, so the emitted routes carry
 * source: "hand-authored" and must never be described as real OSM geometry.
 *
 * The geometry is generated (not typed out segment by segment) purely so that the
 * polyline length and the declared lengthM agree exactly, and so that
 * distToMainRoadM / nearbyRoads are derived from the actual main-road corridor
 * instead of being invented per segment.
 *
 * Run:  node scripts/makeDemoRoutes.mjs
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(HERE, '../src/data/fixtures/demoRoutes.json');

// ── Geography ────────────────────────────────────────────────────────────────
// Origin: a residential pocket in Lalitpur. Destination: the Khumaltar school
// area. BOTH ARE APPROXIMATE — the app labels the school location as approximate.
const ORIGIN = { lat: 27.6755, lon: 85.3060 };
const DEST = { lat: 27.658, lon: 85.326 };

const SHARED_LEAD_M = 350; // length of the shared first segment (all three routes)
const SHARED_TAIL_M = 350; // length of the shared last segment (all three routes)

const M_PER_DEG = 111320;
const degLat = M_PER_DEG;
const degLon = (lat) => M_PER_DEG * Math.cos((lat * Math.PI) / 180);

// ── Tiny deterministic helpers (no Math.random anywhere) ─────────────────────
function lcg(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const round = (v, n = 1) => Math.round(v * 10 ** n) / 10 ** n;

/** Local ENU metres relative to ORIGIN. */
function toXY(p) {
  return { x: (p.lon - ORIGIN.lon) * degLon(p.lat), y: (p.lat - ORIGIN.lat) * degLat };
}
function toLatLon(xy) {
  return {
    lat: round(ORIGIN.lat + xy.y / degLat, 6),
    lon: round(ORIGIN.lon + xy.x / degLon(ORIGIN.lat), 6),
  };
}

// ── Polyline maths ───────────────────────────────────────────────────────────

function polylineLength(pts) {
  let total = 0;
  for (let i = 1; i < pts.length; i++) {
    const dx = pts[i].x - pts[i - 1].x;
    const dy = pts[i].y - pts[i - 1].y;
    total += Math.hypot(dx, dy);
  }
  return total;
}

/** Shortest distance from a point to a polyline, in metres. */
function distanceToPolyline(pt, line) {
  let best = Infinity;
  for (let i = 1; i < line.length; i++) {
    const a = line[i - 1];
    const b = line[i];
    const vx = b.x - a.x;
    const vy = b.y - a.y;
    const len2 = vx * vx + vy * vy;
    let t = 0;
    if (len2 > 0) t = clamp(((pt.x - a.x) * vx + (pt.y - a.y) * vy) / len2, 0, 1);
    const cx = a.x + t * vx;
    const cy = a.y + t * vy;
    const d = Math.hypot(pt.x - cx, pt.y - cy);
    if (d < best) best = d;
  }
  return Number.isFinite(best) ? best : 0;
}

/**
 * Build a polyline from A to B that wanders sideways by `offset(s)` metres,
 * perpendicular to A→B, where s runs 0 → 1. Always starts exactly at A and ends
 * exactly at B, so every route reaches the same destination.
 */
function offsetPolyline(A, B, offset, samples = 240) {
  const vx = B.x - A.x;
  const vy = B.y - A.y;
  const len = Math.hypot(vx, vy) || 1;
  const ux = vx / len;
  const uy = vy / len;
  // Left-hand normal.
  const nx = -uy;
  const ny = ux;

  const pts = [];
  for (let i = 0; i <= samples; i++) {
    const s = i / samples;
    const o = offset(s);
    pts.push({
      x: A.x + ux * len * s + nx * o,
      y: A.y + uy * len * s + ny * o,
    });
  }
  // Pin the endpoints so the three routes genuinely share their first/last points.
  pts[0] = { x: A.x, y: A.y };
  pts[pts.length - 1] = { x: B.x, y: B.y };
  return pts;
}

/** Split a polyline into consecutive pieces of roughly `targetLen` metres. */
function splitByLength(pts, targetLen) {
  const out = [];
  let cur = [pts[0]];
  let acc = 0;

  for (let i = 1; i < pts.length; i++) {
    const a = cur[cur.length - 1];
    const b = pts[i];
    const d = Math.hypot(b.x - a.x, b.y - a.y);
    acc += d;
    cur.push(b);
    if (acc >= targetLen) {
      out.push(cur);
      cur = [b];
      acc = 0;
    }
  }
  if (cur.length > 1) {
    if (out.length > 0) {
      // Merge a short trailing remainder into the previous piece.
      out[out.length - 1] = out[out.length - 1].concat(cur.slice(1));
    } else {
      out.push(cur);
    }
  }
  return out;
}

// ── Route shapes ─────────────────────────────────────────────────────────────
// All three shapes are hand-chosen: the main road runs fairly directly, the side
// streets zigzag along a grid, the park route bulges towards the open ground.

const SHAPES = {
  main: (s) => 210 * Math.sin(Math.PI * s) * Math.sin(3 * Math.PI * s),
  side: (s) => 300 * Math.sin(2 * Math.PI * s) * Math.sin(5 * Math.PI * s) - 120 * Math.sin(Math.PI * s),
  park: (s) => -260 * Math.sin(Math.PI * s) + 110 * Math.sin(4 * Math.PI * s),
};

const TARGET_SEG_M = 185;

// ── Feature authoring ────────────────────────────────────────────────────────
// Values are ASSUMED hand-authored proxies. They are internally consistent with
// the geometry (distToMainRoadM and nearbyRoads are measured against the real
// main-road corridor) but they are NOT derived from any OSM extract.

function featuresFor(kind, index, s, distToCorridor, rnd) {
  const jitter = (spread) => (rnd() - 0.5) * 2 * spread;

  if (kind === 'main') {
    const isTrunk = index === 0 || index === 1;
    return {
      roadClass: isTrunk ? 'trunk' : 'primary',
      distToMainRoadM: 0,
      intersectionDensityPer100m: round(3 + jitter(0.6), 2),
      trafficSignalsWithin50m: rnd() < 0.45 ? 1 : 0,
      busStopsWithin30m: rnd() < 0.5 ? 1 : 0,
      greenFraction100m: round(0.04 + jitter(0.03), 3),
      buildingDensity: round(0.86 + jitter(0.06), 3),
    };
  }

  if (kind === 'side') {
    // A dense grid: many intersections, almost no green, moderate density.
    return {
      roadClass: index % 3 === 0 ? 'tertiary' : 'residential',
      distToMainRoadM: round(distToCorridor, 1),
      intersectionDensityPer100m: round(5 + jitter(1.2), 2),
      trafficSignalsWithin50m: rnd() < 0.2 ? 1 : 0,
      busStopsWithin30m: rnd() < 0.25 ? 1 : 0,
      greenFraction100m: round(0.12 + jitter(0.06), 3),
      buildingDensity: round(0.6 + jitter(0.1), 3),
    };
  }

  // park / footway
  const roadClass = index % 2 === 0 ? 'footway' : 'path';
  return {
    roadClass,
    distToMainRoadM: round(distToCorridor, 1),
    intersectionDensityPer100m: round(0.7 + jitter(0.4), 2),
    trafficSignalsWithin50m: 0,
    busStopsWithin30m: 0,
    greenFraction100m: round(0.86 + jitter(0.07), 3),
    buildingDensity: round(0.1 + jitter(0.06), 3),
  };
}

/** nearbyRoads: the main-road corridor is the only other road we author explicitly. */
function nearbyRoadsFor(roadClass, distToCorridor) {
  if (roadClass === 'trunk' || roadClass === 'primary' || roadClass === 'secondary') return [];
  if (distToCorridor <= 400) {
    // ASSUMED: the corridor is a primary road for decay purposes.
    return [{ roadClass: 'primary', distanceM: round(distToCorridor, 1) }];
  }
  return [];
}

// ── Build ────────────────────────────────────────────────────────────────────

const O = toXY(ORIGIN);
const D = toXY(DEST);

// Shared lead: leaves the origin on the main bearing.
const bearingLen = Math.hypot(D.x - O.x, D.y - O.y);
const dirX = (D.x - O.x) / bearingLen;
const dirY = (D.y - O.y) / bearingLen;
const A = { x: O.x + dirX * SHARED_LEAD_M, y: O.y + dirY * SHARED_LEAD_M };
const B = { x: D.x - dirX * SHARED_TAIL_M, y: D.y - dirY * SHARED_TAIL_M };

const leadPts = [
  { x: O.x, y: O.y },
  { x: (O.x + A.x) / 2 + dirY * 8, y: (O.y + A.y) / 2 - dirX * 8 },
  { x: A.x, y: A.y },
];
const tailPts = [
  { x: B.x, y: B.y },
  { x: (B.x + D.x) / 2 + dirY * 8, y: (B.y + D.y) / 2 - dirX * 8 },
  { x: D.x, y: D.y },
];

// The "main road corridor" used to measure cross-street distance. It deliberately
// EXCLUDES the shared lead/tail legs (those are residential), otherwise every
// shared segment would measure 0 m from the corridor it belongs to.
const mainMiddleXY = offsetPolyline(A, B, SHAPES.main);
const corridorXY = mainMiddleXY;

function buildRoute(id, name, kind, seed) {
  const rnd = lcg(seed);
  const middle = offsetPolyline(A, B, SHAPES[kind]);
  const pieces = splitByLength(middle, TARGET_SEG_M);
  const middleCount = pieces.length;

  const segments = [];

  // Shared lead segment — identical id and content on all three routes.
  const leadLen = polylineLength(leadPts);
  const leadMid = { x: (O.x + A.x) / 2, y: (O.y + A.y) / 2 };
  const leadDist = distanceToPolyline(leadMid, corridorXY);
  segments.push({
    id: 'sh-lead',
    roadClass: 'residential',
    lengthM: round(leadLen, 1),
    coords: leadPts.map(toLatLon),
    features: {
      distToMainRoadM: round(leadDist, 1),
      intersectionDensityPer100m: 4.2,
      trafficSignalsWithin50m: 0,
      busStopsWithin30m: 1,
      greenFraction100m: 0.18,
      buildingDensity: 0.58,
      nearbyRoads: nearbyRoadsFor('residential', leadDist),
    },
  });

  pieces.forEach((piece, i) => {
    const mid = piece[Math.floor(piece.length / 2)];
    const dist = distanceToPolyline(mid, corridorXY);
    const s = (i + 0.5) / middleCount;
    const f = featuresFor(kind, i, s, dist, rnd);
    segments.push({
      id: `${id}-m${String(i).padStart(2, '0')}`,
      roadClass: f.roadClass,
      lengthM: round(polylineLength(piece), 1),
      coords: piece.map(toLatLon),
      features: {
        distToMainRoadM: f.distToMainRoadM,
        intersectionDensityPer100m: f.intersectionDensityPer100m,
        trafficSignalsWithin50m: f.trafficSignalsWithin50m,
        busStopsWithin30m: f.busStopsWithin30m,
        greenFraction100m: f.greenFraction100m,
        buildingDensity: f.buildingDensity,
        nearbyRoads: nearbyRoadsFor(f.roadClass, dist),
      },
    });
  });

  // Shared tail segment — identical id and content on all three routes.
  const tailLen = polylineLength(tailPts);
  const tailMid = { x: (B.x + D.x) / 2, y: (B.y + D.y) / 2 };
  const tailDist = distanceToPolyline(tailMid, corridorXY);
  segments.push({
    id: 'sh-tail',
    roadClass: 'residential',
    lengthM: round(tailLen, 1),
    coords: tailPts.map(toLatLon),
    features: {
      distToMainRoadM: round(tailDist, 1),
      intersectionDensityPer100m: 4.2,
      trafficSignalsWithin50m: 0,
      busStopsWithin30m: 1,
      greenFraction100m: 0.2,
      buildingDensity: 0.55,
      nearbyRoads: nearbyRoadsFor('residential', tailDist),
    },
  });

  return { id, name, source: 'hand-authored', segments };
}

const routes = [
  buildRoute('main-road', 'Main road', 'main', 20260101),
  buildRoute('side-streets', 'Side streets', 'side', 20260202),
  buildRoute('park-path', 'Park & footpath', 'park', 20260303),
];

// ── Report + write ───────────────────────────────────────────────────────────

for (const r of routes) {
  const total = r.segments.reduce((s, x) => s + x.lengthM, 0);
  const xyLen = r.segments.reduce((s, seg) => s + polylineLength(seg.coords.map(toXY)), 0);
  const classes = [...new Set(r.segments.map((s) => s.roadClass))].join(', ');
  console.log(
    `${r.id.padEnd(13)} segments=${String(r.segments.length).padStart(2)}  declared=${total.toFixed(0)}m  geometry=${xyLen.toFixed(0)}m  classes=[${classes}]`,
  );
}

const ids = new Set();
for (const r of routes) for (const s of r.segments) ids.add(s.id);
console.log(`unique segment ids across all routes: ${ids.size}`);
console.log(`total segments emitted: ${routes.reduce((n, r) => n + r.segments.length, 0)}`);

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(
  OUT,
  JSON.stringify(
    {
      _comment:
        'SYNTHETIC hand-authored demo geometry. NOT OpenStreetMap or OSRM output. ' +
        'Generated by scripts/makeDemoRoutes.mjs with no routing service involved. ' +
        'Every segment feature is an ASSUMED proxy; distToMainRoadM and nearbyRoads are ' +
        'measured against the main-road corridor in this file.',
      schoolArea: { name: 'Khumaltar school area (approximate)', lat: DEST.lat, lon: DEST.lon },
      routes,
    },
    null,
    2,
  ) + '\n',
);
console.log(`\nwrote ${OUT}`);
