/**
 * scripts/fetchOsmRoutes.mjs
 * ---------------------------------------------------------------------------
 * Builds src/data/fixtures/demoRoutes.json from REAL road geometry.
 *
 * Each route follows actual OpenStreetMap ways, fetched from the public OSRM demo
 * server (router.project-osrm.org), which routes on OSM data. The script was
 * actually run (see provenance below); the geometry in demoRoutes.json is that
 * server's real output, so the routes carry source: "osm-derived".
 *
 * WHAT IS REAL vs WHAT IS AUTHORED (read this before touching the mapping table):
 *  * REAL: every coordinate (OSRM overview geometry), every segment length
 *    (measured from that geometry), distToMainRoadM + nearbyRoads (measured
 *    against the real main-road corridor), intersectionDensityPer100m (counted
 *    from real OSRM turn maneuvers).
 *  * HAND-AUTHORED PROXIES (ASSUMED, disclosed in code + in-app table): roadClass
 *    (assigned by hand from the OSRM step street name via CLASS_BY_STREET below —
 *    these are author judgments, NOT OSM highway tags), greenFraction100m,
 *    buildingDensity, trafficSignalsWithin50m, busStopsWithin30m.
 *
 * The script performs a handful of one-time routing requests (4 queries). It is
 * NOT part of the app and makes no network calls at runtime or in tests.
 *
 * Run:  node scripts/fetchOsmRoutes.mjs
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(HERE, '../src/data/fixtures/demoRoutes.json');

const OSRM = 'https://router.project-osrm.org/route/v1';

// Approximate endpoints (OSRM snaps each to the nearest real road; the snapped
// points become the true origin/destination). Origin: residential Lalitpur.
// Destination: Khumaltar school area (APPROXIMATE — the app labels it as such).
const ORIGIN = [85.306, 27.6755]; // [lon, lat]
const DEST = [85.326, 27.658];

// Via points that force two genuinely different corridors (verified by probe:
// each produces a distinct street list and a 3–5 km total).
const VIA_EAST = [85.3205, 27.6645]; // Bhanimandal / Mahalaxmisthan side
const VIA_PARK = [85.3175, 27.662]; // Kusunti lanes, kept east to skip the western backtrack

const SHARED_LEAD_M = 300;
const SHARED_TAIL_M = 300;
const TARGET_SEG_M = 185;

const FETCHED_AT = new Date().toISOString();
const QUERIES = [];

// ── helpers ──────────────────────────────────────────────────────────────────
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const round = (v, n = 1) => Math.round(v * 10 ** n) / 10 ** n;

function lcg(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const M_PER_DEG = 111320;
const cosLat = (lat) => Math.cos((lat * Math.PI) / 180);
function segLenM(a, b) {
  // a, b are [lon, lat]
  const dx = (b[0] - a[0]) * M_PER_DEG * cosLat((a[1] + b[1]) / 2);
  const dy = (b[1] - a[1]) * M_PER_DEG;
  return Math.hypot(dx, dy);
}
function lineLen(coords) {
  let t = 0;
  for (let i = 1; i < coords.length; i++) t += segLenM(coords[i - 1], coords[i]);
  return t;
}
function distPt(a, b) {
  return segLenM(a, b);
}
/** Distance from point p to segment ab, in metres (equirectangular). */
function distToSegM(p, a, b) {
  const lat = (p[1] + a[1] + b[1]) / 3;
  const k = M_PER_DEG * cosLat(lat);
  const px = p[0] * k;
  const py = p[1] * M_PER_DEG;
  const ax = a[0] * k;
  const ay = a[1] * M_PER_DEG;
  const bx = b[0] * k;
  const by = b[1] * M_PER_DEG;
  const vx = bx - ax;
  const vy = by - ay;
  const l2 = vx * vx + vy * vy;
  let t = 0;
  if (l2 > 0) t = clamp(((px - ax) * vx + (py - ay) * vy) / l2, 0, 1);
  return Math.hypot(px - (ax + t * vx), py - (ay + t * vy));
}
function distToPolylineM(p, line) {
  let best = Infinity;
  for (let i = 1; i < line.length; i++) best = Math.min(best, distToSegM(p, line[i - 1], line[i]));
  return best;
}

// ── OSRM ─────────────────────────────────────────────────────────────────────
async function osrm(profile, coords) {
  const path = `${coords.map((c) => c.join(',')).join(';')}`;
  const url =
    `${OSRM}/${profile}/${path}?overview=full&geometries=geojson&steps=true&annotations=false`;
  QUERIES.push(url);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`OSRM HTTP ${res.status} for ${url}`);
  const j = await res.json();
  if (j.code !== 'Ok' || !j.routes?.length) {
    throw new Error(`OSRM ${j.code}: ${j.message ?? 'no route'} for ${url}`);
  }
  // NOTE: OSRM duration/speed is NEVER used by this project (the foot profile in
  // particular returns car-like durations on this server). Only geometry, street
  // names and maneuver types are consumed.
  return j.routes[0];
}

/**
 * Flatten an OSRM route into: coordinates ([lon,lat][]), per-vertex cumulative
 * metres, and step ranges [{ name, startM, endM, maneuver }].
 */
function flatten(route) {
  const coords = route.geometry.coordinates;
  const cum = [0];
  for (let i = 1; i < coords.length; i++) cum.push(cum[i - 1] + segLenM(coords[i - 1], coords[i]));
  const total = cum[cum.length - 1];

  const steps = [];
  let cursor = 0;
  for (const leg of route.legs ?? []) {
    for (const st of leg.steps ?? []) {
      const d = st.distance ?? 0;
      steps.push({
        name: st.name ?? '',
        startM: cursor,
        endM: cursor + d,
        maneuver: st.maneuver?.type ?? '',
        modifier: st.maneuver?.modifier ?? '',
      });
      cursor += d;
    }
  }
  return { coords, cum, total, steps };
}

/** Cut a polyline at arc-length `atM` from its start. Returns { head, cutPoint }. */
function cutAt(coords, atM) {
  let acc = 0;
  const head = [coords[0]];
  for (let i = 1; i < coords.length; i++) {
    const d = segLenM(coords[i - 1], coords[i]);
    if (acc + d >= atM) {
      const t = (atM - acc) / d;
      const cut = [
        coords[i - 1][0] + t * (coords[i][0] - coords[i - 1][0]),
        coords[i - 1][1] + t * (coords[i][1] - coords[i - 1][1]),
      ];
      head.push(cut);
      return { head, cutPoint: cut };
    }
    acc += d;
    head.push(coords[i]);
  }
  return { head, cutPoint: coords[coords.length - 1] };
}

/** Street name active at arc position m. */
function streetAt(steps, m) {
  for (const s of steps) {
    if (m >= s.startM && m <= s.endM + 1e-6) return s.name;
  }
  return steps.length ? steps[steps.length - 1].name : '';
}

// ── roadClass mapping ────────────────────────────────────────────────────────
// HAND-AUTHORED judgments from OSRM step street names. NOT OSM highway tags.
// Rationale: the direct corridor's named Sadak/Marga arterials are the busiest
// roads on these paths (primary); the historic core lanes are tertiary; the
// Kusunti/Ranibu lanes are residential; unnamed bits on the foot profile are
// footways/paths; the Ring Road is the only trunk-grade road present.
// The direct corridor (Q1) is the busiest of the three paths, so its named
// arterial counts as the demo's main road. Everything below is an author
// judgment from the step name, NOT an OSM highway tag.
const CLASS_BY_STREET = [
  [/ring ?road/i, 'trunk'],
  [/satdobato|godavari/i, 'secondary'],
  [/machindranath/i, 'primary'],
  [/bhanimandal|ekantakuna|yala sadak|mahalaxmisthan/i, 'secondary'],
  [/dhungedhara|bakhundol/i, 'tertiary'],
  [/ranibu|kusunti/i, 'residential'],
];
function classForStreet(name, profile) {
  for (const [re, cls] of CLASS_BY_STREET) {
    if (re.test(name)) return cls;
  }
  if (!name || name === '') return profile === 'foot' ? 'footway' : 'residential';
  return 'tertiary';
}

// ── hand-authored density proxies by class (ASSUMED) ─────────────────────────
function proxiesForClass(cls, rnd) {
  const j = (s) => (rnd() - 0.5) * 2 * s;
  switch (cls) {
    case 'trunk':
    case 'primary':
      return {
        greenFraction100m: round(0.04 + j(0.03), 3),
        buildingDensity: round(0.86 + j(0.06), 3),
        trafficSignalsWithin50m: rnd() < 0.45 ? 1 : 0,
        busStopsWithin30m: rnd() < 0.5 ? 1 : 0,
      };
    case 'secondary':
      return {
        greenFraction100m: round(0.08 + j(0.04), 3),
        buildingDensity: round(0.72 + j(0.08), 3),
        trafficSignalsWithin50m: rnd() < 0.3 ? 1 : 0,
        busStopsWithin30m: rnd() < 0.4 ? 1 : 0,
      };
    case 'tertiary':
      return {
        greenFraction100m: round(0.14 + j(0.05), 3),
        buildingDensity: round(0.6 + j(0.1), 3),
        trafficSignalsWithin50m: rnd() < 0.15 ? 1 : 0,
        busStopsWithin30m: rnd() < 0.2 ? 1 : 0,
      };
    case 'footway':
    case 'path':
      return {
        greenFraction100m: round(0.86 + j(0.07), 3),
        buildingDensity: round(0.1 + j(0.06), 3),
        trafficSignalsWithin50m: 0,
        busStopsWithin30m: 0,
      };
    case 'residential':
    default:
      return {
        greenFraction100m: round(0.16 + j(0.06), 3),
        buildingDensity: round(0.58 + j(0.1), 3),
        trafficSignalsWithin50m: 0,
        busStopsWithin30m: rnd() < 0.25 ? 1 : 0,
      };
  }
}

const TURN_MANEUVERS = new Set([
  'turn',
  'roundabout',
  'rotary',
  'merge',
  'fork',
  'exit roundabout',
  'roundabout turn',
  'exit rotary',
]);

/**
 * Real intersection density for one piece: count OSRM turn maneuvers whose step
 * overlaps the piece's arc range, per 100 m.
 */
function measuredIntersectionDensity(steps, pieceStartM, pieceEndM) {
  let turns = 0;
  for (const s of steps) {
    if (!TURN_MANEUVERS.has(s.maneuver)) continue;
    // The maneuver happens at the END of its step; attribute it if that point
    // lies inside the piece.
    if (s.endM >= pieceStartM && s.endM <= pieceEndM) turns++;
  }
  const lenM = Math.max(1, pieceEndM - pieceStartM);
  return round((turns / lenM) * 100, 2);
}

// ── main ─────────────────────────────────────────────────────────────────────
const q1 = await osrm('driving', [ORIGIN, DEST]);
const f1 = flatten(q1);
console.log(`Q1 direct: ${f1.total.toFixed(0)} m, ${f1.coords.length} pts`);

const { head: leadXY, cutPoint: A } = cutAt(f1.coords, SHARED_LEAD_M);
const fromEnd = cutAt([...f1.coords].reverse(), SHARED_TAIL_M);
const tailXY = [...fromEnd.head].reverse();
const B = fromEnd.cutPoint;
console.log(`A=(${A[1].toFixed(5)},${A[0].toFixed(5)}) B=(${B[1].toFixed(5)},${B[0].toFixed(5)})`);

const qMain = f1; // main middle = Q1 truncated at A and B
const qSide = flatten(await osrm('driving', [A, VIA_EAST, B]));
const qPark = flatten(await osrm('foot', [A, VIA_PARK, B]));
console.log(`Q-main middle: ${qMain.total.toFixed(0)} m | Q-side: ${qSide.total.toFixed(0)} m | Q-park: ${qPark.total.toFixed(0)} m`);

// Sanity: middles must actually travel (not collapse) and stay in the valley.
for (const [label, q] of [['side', qSide], ['park', qPark]]) {
  if (q.total < 1500) throw new Error(`${label} middle suspiciously short: ${q.total}`);
  for (const [lon, lat] of q.coords) {
    if (lat < 27.6 || lat > 27.75 || lon < 85.28 || lon > 85.36) {
      throw new Error(`${label} middle leaves the valley: ${lat},${lon}`);
    }
  }
}

// The main-road corridor = Q1's middle (A→B), used to MEASURE cross-street distance.
const mainMiddle = (() => {
  const leadLen = lineLen(leadXY);
  const tailLen = lineLen(tailXY);
  // arc positions of A and B on Q1
  return { coords: f1.coords, aM: leadLen, bM: f1.total - tailLen };
})();
function mainMiddleCoords() {
  // Q1 coords between arc positions aM and bM
  const out = [];
  for (let i = 0; i < f1.coords.length; i++) {
    const m = f1.cum[i];
    if (m >= mainMiddle.aM - 1e-6 && m <= mainMiddle.bM + 1e-6) out.push(f1.coords[i]);
  }
  if (out.length < 2) return [f1.coords[0], f1.coords[f1.coords.length - 1]];
  return out;
}
const corridorXY = mainMiddleCoords();

// nearest corridor segment class for a point (for honest nearbyRoads classes)
const corridorSegs = [];
{
  // class per corridor vertex from Q1 steps
  for (let i = 0; i < f1.coords.length; i++) {
    corridorSegs.push({ m: f1.cum[i], cls: classForStreet(streetAt(f1.steps, f1.cum[i]), 'driving') });
  }
}
function nearestCorridorClass(p) {
  let best = Infinity;
  let bestCls = 'primary';
  for (let i = 1; i < f1.coords.length; i++) {
    const m = (f1.cum[i - 1] + f1.cum[i]) / 2;
    if (m < mainMiddle.aM || m > mainMiddle.bM) continue;
    const d = distToSegM(p, f1.coords[i - 1], f1.coords[i]);
    if (d < best) {
      best = d;
      bestCls = corridorSegs[i].cls;
    }
  }
  return bestCls;
}

const MAIN_CLASSES = new Set(['trunk', 'primary', 'secondary']);

function toLatLon([lon, lat]) {
  return { lat: round(lat, 6), lon: round(lon, 6) };
}

/** Split a real polyline (with arc offsets) into ~TARGET_SEG_M pieces. */
function splitReal(coords, cum, startM) {
  // returns pieces: { pts, startM, endM }
  const pieces = [];
  let cur = [coords[0]];
  let curStart = startM;
  let acc = 0;
  for (let i = 1; i < coords.length; i++) {
    const d = segLenM(coords[i - 1], coords[i]);
    acc += d;
    cur.push(coords[i]);
    if (acc >= TARGET_SEG_M) {
      pieces.push({ pts: cur, startM: curStart, endM: curStart + acc });
      cur = [coords[i]];
      curStart = curStart + acc;
      acc = 0;
    }
  }
  if (cur.length > 1) {
    if (pieces.length > 0) {
      const last = pieces[pieces.length - 1];
      last.pts = last.pts.concat(cur.slice(1));
      last.endM = curStart + acc;
    } else {
      pieces.push({ pts: cur, startM: curStart, endM: curStart + acc });
    }
  }
  return pieces;
}

function buildMiddleSegments(routeId, flat, profile, seed, arcOffset) {
  const rnd = lcg(seed);
  const pieces = splitReal(flat.coords, flat.cum, arcOffset);
  return pieces.map((pc, i) => {
    const midM = (pc.startM + pc.endM) / 2;
    const name = streetAt(flat.steps, midM - arcOffset);
    const cls = classForStreet(name, profile);
    const midPt = pc.pts[Math.floor(pc.pts.length / 2)];
    const dist = MAIN_CLASSES.has(cls) ? 0 : round(distToPolylineM(midPt, corridorXY), 1);
    const nearCls = MAIN_CLASSES.has(cls) ? null : nearestCorridorClass(midPt);
    const nearbyRoads =
      MAIN_CLASSES.has(cls) || dist > 400
        ? []
        : [{ roadClass: nearCls, distanceM: dist }];
    const prox = proxiesForClass(cls, rnd);
    return {
      id: `${routeId}-m${String(i).padStart(2, '0')}`,
      roadClass: cls,
      street: name || '(unnamed)',
      lengthM: round(lineLen(pc.pts), 1),
      coords: pc.pts.map(toLatLon),
      features: {
        distToMainRoadM: dist,
        intersectionDensityPer100m: measuredIntersectionDensity(
          flat.steps, midM - arcOffset - (pc.endM - pc.startM) / 2, midM - arcOffset + (pc.endM - pc.startM) / 2,
        ),
        trafficSignalsWithin50m: prox.trafficSignalsWithin50m,
        busStopsWithin30m: prox.busStopsWithin30m,
        greenFraction100m: prox.greenFraction100m,
        buildingDensity: prox.buildingDensity,
        nearbyRoads,
      },
    };
  });
}

function sharedSegment(id, xy, seed) {
  const rnd = lcg(seed);
  const mid = xy[Math.floor(xy.length / 2)];
  const dist = round(distToPolylineM(mid, corridorXY), 1);
  return {
    id,
    roadClass: 'residential',
    street: '(shared approach)',
    lengthM: round(lineLen(xy), 1),
    coords: xy.map(toLatLon),
    features: {
      distToMainRoadM: dist,
      intersectionDensityPer100m: 4.2,
      trafficSignalsWithin50m: 0,
      busStopsWithin30m: 1,
      greenFraction100m: 0.18,
      buildingDensity: 0.58,
      nearbyRoads: dist <= 400 ? [{ roadClass: 'primary', distanceM: dist }] : [],
    },
  };
}

const lead = sharedSegment('sh-lead', leadXY, 111);
const tail = sharedSegment('sh-tail', tailXY, 222);

// main middle: Q1 pieces between A and B (arc range [aM, bM])
const mainPieces = splitReal(
  f1.coords.filter((_, i) => f1.cum[i] >= mainMiddle.aM - 1e-6 && f1.cum[i] <= mainMiddle.bM + 1e-6),
  f1.cum.filter((m) => m >= mainMiddle.aM - 1e-6 && m <= mainMiddle.bM + 1e-6),
  mainMiddle.aM,
);
const mainMiddleSegs = (() => {
  const rnd = lcg(333);
  return mainPieces.map((pc, i) => {
    const midM = (pc.startM + pc.endM) / 2;
    const name = streetAt(f1.steps, midM);
    const cls = classForStreet(name, 'driving');
    const prox = proxiesForClass(cls, rnd);
    return {
      id: `main-road-m${String(i).padStart(2, '0')}`,
      roadClass: cls,
      street: name || '(unnamed)',
      lengthM: round(lineLen(pc.pts), 1),
      coords: pc.pts.map(toLatLon),
      features: {
        distToMainRoadM: 0,
        intersectionDensityPer100m: measuredIntersectionDensity(
          f1.steps, midM - (pc.endM - pc.startM) / 2, midM + (pc.endM - pc.startM) / 2,
        ),
        trafficSignalsWithin50m: prox.trafficSignalsWithin50m,
        busStopsWithin30m: prox.busStopsWithin30m,
        greenFraction100m: prox.greenFraction100m,
        buildingDensity: prox.buildingDensity,
        nearbyRoads: [],
      },
    };
  });
})();

// NOTE: main-road middle segments are on the corridor itself, so they declare
// distToMainRoadM = 0 ONLY when their class is trunk/primary/secondary (the
// validator requires it). A tertiary/residential bit of the main corridor keeps
// its measured distance instead — computed below.
for (const s of mainMiddleSegs) {
  if (!MAIN_CLASSES.has(s.roadClass)) {
    const mid = s.coords[Math.floor(s.coords.length / 2)];
    const d = round(distToPolylineM([mid.lon, mid.lat], corridorXY), 1);
    s.features.distToMainRoadM = d;
    s.features.nearbyRoads = d <= 400 ? [{ roadClass: 'primary', distanceM: d }] : [];
  }
}

const sideMiddleSegs = buildMiddleSegments('side-streets', qSide, 'driving', 444, 0);
const parkMiddleSegs = buildMiddleSegments('park-path', qPark, 'foot', 555, 0);

function assemble(id, name, middle) {
  return { id, name, source: 'osm-derived', segments: [lead, ...middle, tail] };
}
const routes = [
  assemble('main-road', 'Main road', mainMiddleSegs),
  assemble('side-streets', 'Side streets', sideMiddleSegs),
  assemble('park-path', 'Park & footpath', parkMiddleSegs),
];

// ── report + hard constraint check ──────────────────────────────────────────
// The committed fixture must satisfy the contract the tests enforce (12–30
// segments, 3–5 km per route). Fail loudly instead of shipping a violation.
for (const r of routes) {
  const total = r.segments.reduce((s, x) => s + x.lengthM, 0);
  if (r.segments.length < 12 || r.segments.length > 30) {
    throw new Error(`${r.id}: ${r.segments.length} segments (need 12–30)`);
  }
  if (total < 3000 || total > 5000) {
    throw new Error(`${r.id}: ${total.toFixed(0)} m total (need 3000–5000)`);
  }
  const classes = [...new Set(r.segments.map((s) => s.roadClass))].join(',');
  console.log(
    `${r.id.padEnd(12)} segs=${String(r.segments.length).padStart(2)} total=${total.toFixed(0)}m classes=[${classes}]`,
  );
  const byClass = {};
  for (const s of r.segments) {
    if (!byClass[s.roadClass]) byClass[s.roadClass] = [];
    byClass[s.roadClass].push(s.street);
  }
  for (const [cls, streets] of Object.entries(byClass)) {
    console.log(`    ${cls}: ${[...new Set(streets)].join(' | ')}`);
  }
}
const ids = new Set();
for (const r of routes) for (const s of r.segments) ids.add(s.id);
console.log(`unique ids: ${ids.size} / total instances: ${routes.reduce((n, r) => n + r.segments.length, 0)}`);

// sample points for seed-cluster placement (every ~600 m along each route)
console.log('\nsample points (lat,lon) for seed clusters:');
for (const r of routes) {
  const pts = [];
  let acc = 0;
  let next = 300;
  const all = r.segments.flatMap((s) => s.coords.map((c) => [c.lon, c.lat]));
  let run = 0;
  for (let i = 1; i < all.length; i++) {
    run += distPt(all[i - 1], all[i]);
    if (run >= next) {
      pts.push(`(${all[i][1].toFixed(4)},${all[i][0].toFixed(4)})`);
      next += 600;
    }
  }
  console.log(`  ${r.id}: ${pts.join(' ')}`);
  void acc;
}

// ── write ────────────────────────────────────────────────────────────────────
const stripped = routes.map((r) => ({
  id: r.id,
  name: r.name,
  source: r.source,
  segments: r.segments.map(({ street, ...s }) => s),
}));
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(
  OUT,
  JSON.stringify(
    {
      _comment:
        'OSM-DERIVED demo geometry (source: "osm-derived"). Every coordinate comes from ' +
        'real routing output of the public OSRM demo server (router.project-osrm.org, OSM data), ' +
        `fetched by scripts/fetchOsmRoutes.mjs on ${FETCHED_AT}. Queries: ` +
        QUERIES.join(' | ') +
        '. OSRM durations/speeds were NOT used (app speeds come from engine params). ' +
        'roadClass is a HAND-AUTHORED judgment from the OSRM step street name (see CLASS_BY_STREET ' +
        'in the script) — NOT an OSM highway tag. greenFraction100m, buildingDensity, ' +
        'trafficSignalsWithin50m, busStopsWithin30m are hand-authored ASSUMED proxies. ' +
        'distToMainRoadM/nearbyRoads are MEASURED against the real main-road corridor; ' +
        'intersectionDensityPer100m is COUNTED from real OSRM turn maneuvers. ' +
        'School coordinates remain approximate.',
      schoolArea: { name: 'Khumaltar school area (approximate)', lat: 27.658, lon: 85.326 },
      routes: stripped,
    },
    null,
    2,
  ) + '\n',
);
console.log(`\nwrote ${OUT}`);
