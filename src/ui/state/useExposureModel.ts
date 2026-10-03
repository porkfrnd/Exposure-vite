/**
 * The single source of truth for the app's numbers.
 *
 * DATA FLOW (exactly as specified for Phase 3):
 *   1. on load: forecast = await dataApi.getForecast(); routes; seeds; baseline
 *   2. ctx = { forecast }
 *   3. predictFn = (seg, t) => engine.predict(seg, t, ctx)     ← UNCORRECTED model
 *   4. corrections(atISO) = dataApi.computeCorrections({ observations, segments, atISO, predict })
 *      memoised per (observations version, atISO)
 *   5. comparison = engine.compareRoutes(routes, baseline, mode, departISO, { forecast, corrections })
 *   6. sweep = engine.departureSweep(routes, baseline, mode, nowHour, offsets, ctx, corrections)
 *   7. adding a photo/report bumps the observations version and everything recomputes
 *
 * Every heavy call is memoised so the departure slider stays responsive.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { engine, dataApi } from '../wiring';
import type {
  BiasModel,
  Comparison,
  CorrectionMap,
  Forecast,
  LatLon,
  Mode,
  Observation,
  PredictFn,
  Route,
  Segment,
  SensitivityReport,
  SweepPoint,
} from '@/contracts';

/** Slider steps: "now" then every 30 min to +3 h. */
export const DEPARTURE_OFFSETS = [0, 30, 60, 90, 120, 150, 180];

export type LoadState = 'loading' | 'ready' | 'error';

export interface ExposureModel {
  state: LoadState;
  error: string | null;
  forecast: Forecast | null;
  routes: Route[];
  segments: Segment[];
  origin: LatLon;
  destination: LatLon;
  school: { name: string; lat: number; lon: number } | null;

  mode: Mode;
  setMode: (m: Mode) => void;
  baselineRouteId: string;
  setBaselineRouteId: (id: string) => void;
  offsetMin: number;
  setOffsetMin: (n: number) => void;
  departISO: string;
  /** Instant treated as "now", rounded down to the hour (slider origin). */
  nowHourISO: string;
  /** Instant treated as "now" at full precision. */
  nowMs: number;

  observations: Observation[];
  addObservation: (obs: Observation) => void;
  observationsVersion: number;

  corrections: CorrectionMap;
  comparison: Comparison | null;
  sweep: SweepPoint[];
  sensitivity: SensitivityReport | null;

  fittedBias: BiasModel | null;
  applyFittedBias: (bias: BiasModel | null) => void;
  /** Recompute the ranking-stability report on demand (not on every render). */
  runSensitivity: () => void;
}

function isoAt(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** First coordinate of the first segment, or Kathmandu, as the map centre. */
function originOf(routes: Route[], fallback: LatLon): LatLon {
  const first = routes[0]?.segments[0]?.coords[0];
  return first ? { lat: first.lat, lon: first.lon } : fallback;
}

/** Last coordinate of the last route's last segment. */
function destinationOf(routes: Route[], fallback: LatLon): LatLon {
  const lastRoute = routes[routes.length - 1];
  const coords = lastRoute?.segments[lastRoute.segments.length - 1]?.coords;
  const last = coords?.[coords.length - 1];
  return last ? { lat: last.lat, lon: last.lon } : fallback;
}

export function useExposureModel(): ExposureModel {
  const [state, setState] = useState<LoadState>('loading');
  const [error, setError] = useState<string | null>(null);
  const [forecast, setForecast] = useState<Forecast | null>(null);
  const [routes, setRoutes] = useState<Route[]>([]);
  const [school, setSchool] = useState<{ name: string; lat: number; lon: number } | null>(null);

  const [mode, setMode] = useState<Mode>('walk');
  const [baselineRouteId, setBaselineRouteId] = useState('');
  const [offsetMin, setOffsetMin] = useState(0);

  const [observations, setObservations] = useState<Observation[]>([]);
  const [observationsVersion, setObservationsVersion] = useState(0);

  const [fittedBias, setFittedBias] = useState<BiasModel | null>(null);

  // "Now" is read once per session and then advanced in whole minutes, so the
  // departure instants the engine sees are stable across re-renders.
  const [nowMs] = useState(() => Date.now());
  const nowHourISO = useMemo(() => {
    const d = new Date(nowMs);
    d.setUTCMinutes(0, 0, 0);
    return isoAt(d.getTime());
  }, [nowMs]);

  // ── Initial load ──────────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    setState('loading');

    (async () => {
      try {
        const [fc, rs, schoolInfo] = await Promise.all([
          dataApi.getForecast(),
          Promise.resolve(dataApi.getDemoRoutes()),
          Promise.resolve(dataApi.getDemoSchool()),
        ]);
        const seeds = dataApi.getSeedObservations();

        const unique = new Map<string, Segment>();
        for (const r of rs) for (const s of r.segments) if (!unique.has(s.id)) unique.set(s.id, s);

        if (cancelled) return;
        setForecast(fc);
        setRoutes(rs);
        setBaselineRouteId(rs[0]?.id ?? '');
        setObservations(seeds);
        setObservationsVersion(1);
        setSchool({
          name: schoolInfo.name,
          lat: schoolInfo.segment.coords[0].lat,
          lon: schoolInfo.segment.coords[0].lon,
        });
        setState('ready');
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : 'could not load the forecast');
        setState('error');
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  // ── Evidence accumulation ─────────────────────────────────────────────────
  const addObservation = useCallback((obs: Observation) => {
    setObservations((prev) => [...prev, obs]);
    setObservationsVersion((v) => v + 1);
  }, []);

  const applyFittedBias = useCallback((bias: BiasModel | null) => {
    setFittedBias(bias);
  }, []);

  const segments = useMemo(() => {
    const unique = new Map<string, Segment>();
    for (const r of routes) for (const s of r.segments) if (!unique.has(s.id)) unique.set(s.id, s);
    return [...unique.values()];
  }, [routes]);

  const origin = useMemo(() => originOf(routes, { lat: 27.6755, lon: 85.306 }), [routes]);
  const destination = useMemo(() => destinationOf(routes, { lat: 27.658, lon: 85.326 }), [routes]);

  /** Effective parameter override (currently only the optional fitted bias). */
  const paramsOverride = useMemo(() => (fittedBias ? { bias: fittedBias } : undefined), [fittedBias]);

  const ctx = useMemo(
    () => (forecast ? { forecast, params: paramsOverride } : null),
    [forecast, paramsOverride],
  );

  /** The UNCORRECTED model prediction, handed to the data layer as PredictFn. */
  const predictFn = useMemo<PredictFn | null>(
    () => (ctx ? (seg: Segment, t: string) => engine.predict(seg, t, ctx) : null),
    [ctx],
  );

  // ── Memoised corrections, keyed by (observations version, atISO) ──────────
  const correctionCacheRef = useRef(new Map<string, CorrectionMap>());

  const correctionsAt = useCallback(
    (atISO: string): CorrectionMap => {
      if (!predictFn) return {};
      const key = `${observationsVersion}|${atISO}`;
      const cache = correctionCacheRef.current;

      const hit = cache.get(key);
      if (hit) return hit;

      let map: CorrectionMap = {};
      try {
        map = dataApi.computeCorrections({
          observations,
          segments,
          atISO,
          predict: predictFn,
        });
      } catch {
        // A failure in the evidence layer must never break the map.
        map = {};
      }

      // Bound the cache so a long session cannot grow without limit.
      if (cache.size > 240) cache.clear();
      cache.set(key, map);
      return map;
    },
    [observations, observationsVersion, predictFn, segments],
  );

  const corrections = useMemo(
    () => (forecast ? correctionsAt(isoAt(nowMs + offsetMin * 60_000)) : {}),
    [forecast, correctionsAt, nowMs, offsetMin],
  );

  const departISO = useMemo(() => isoAt(nowMs + offsetMin * 60_000), [nowMs, offsetMin]);

  // ── Comparison ────────────────────────────────────────────────────────────
  const comparison = useMemo<Comparison | null>(() => {
    if (!ctx || routes.length === 0 || !baselineRouteId) return null;
    try {
      return engine.compareRoutes(routes, baselineRouteId, mode, departISO, {
        ...ctx,
        corrections: correctionsAt(departISO),
      });
    } catch {
      return null;
    }
  }, [ctx, routes, baselineRouteId, mode, departISO, correctionsAt]);

  // ── Departure sweep ───────────────────────────────────────────────────────
  const sweep = useMemo<SweepPoint[]>(() => {
    if (!ctx || routes.length === 0 || !baselineRouteId) return [];
    try {
      return engine.departureSweep(
        routes,
        baselineRouteId,
        mode,
        nowHourISO,
        DEPARTURE_OFFSETS,
        ctx,
        correctionsAt,
      );
    } catch {
      return [];
    }
  }, [ctx, routes, baselineRouteId, mode, nowHourISO, correctionsAt, observationsVersion]);

  // ── Sensitivity: recomputed only when the user asks for it ────────────────
  const [sensitivity, setSensitivity] = useState<SensitivityReport | null>(null);
  useEffect(() => {
    setSensitivity(null);
  }, [departISO, mode, baselineRouteId, observationsVersion]);

  const runSensitivity = useCallback(() => {
    if (!ctx || routes.length < 2 || !baselineRouteId) return;
    try {
      setSensitivity(engine.sensitivity(routes, mode, departISO, { ...ctx, corrections }));
    } catch {
      setSensitivity(null);
    }
  }, [ctx, routes, mode, departISO, baselineRouteId, corrections]);

  return {
    state,
    error,
    forecast,
    routes,
    segments,
    origin,
    destination,
    school,
    mode,
    setMode,
    baselineRouteId,
    setBaselineRouteId,
    offsetMin,
    setOffsetMin,
    departISO,
    nowHourISO,
    observations,
    addObservation,
    observationsVersion,
    corrections,
    comparison,
    sweep,
    sensitivity,
    runSensitivity,
    fittedBias,
    applyFittedBias,
    nowMs,
  };
}