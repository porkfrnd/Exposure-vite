/**
 * Application state. ALL data is REAL: live Open-Meteo air quality, live OSM
 * routing, live OSM road classes, live place search.
 *
 * Nothing is invented. There are no demo routes and no simulated observation pins.
 * When a service fails the UI shows an honest error with a retry.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { engine, realApi, dataApi } from '../wiring';
import type { Place, Planned } from '../wiring';
import type {
  BiasModel,
  Comparison,
  CorrectionMap,
  Forecast,
  LatLon,
  Mode,
  Observation,
  Route,
  Segment,
  SweepPoint,
} from '@/contracts';

export const DEPARTURE_OFFSETS = [0, 30, 60, 90, 120, 150, 180];

export type Phase = 'idle' | 'locating' | 'routing' | 'ready' | 'error';

function isoAt(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** Coerce anything thrown into a message we can honestly show a user. */
function messageOf(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === 'string') return e;
  return 'Something went wrong.';
}

export function useExposureModel() {
  const [phase, setPhase] = useState<Phase>('idle');
  const [error, setError] = useState<string | null>(null);
  const [forecast, setForecast] = useState<Forecast | null>(null);
  const [origin, setOrigin] = useState<Place | null>(null);
  const [destination, setDestination] = useState<Place | null>(null);
  const [planned, setPlanned] = useState<Planned[]>([]);
  const [mode, setMode] = useState<Mode>('walk');
  const [baselineRouteId, setBaselineRouteId] = useState('');
  const [offsetMin, setOffsetMin] = useState(0);
  const [observations, setObservations] = useState<Observation[]>([]);
  const [fittedBias, setFittedBias] = useState<BiasModel | null>(null);
  const [sensitivity, setSensitivity] = useState<SweepPoint[]>([]);
  const [sensitivityReport, setSensitivityReport] = useState<{
    pairs: number;
    stablePairs: number;
    stability: number;
    scales: number[];
  } | null>(null);

  const [nowMs] = useState(() => Date.now());
  const nowHourISO = useMemo(() => {
    const d = new Date(nowMs);
    d.setUTCMinutes(0, 0, 0);
    return isoAt(d.getTime());
  }, [nowMs]);

  const abortRef = useRef<AbortController | null>(null);

  // ── Forecast on load ──────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const fc = await realApi.getForecast();
        if (!cancelled) setForecast(fc.forecast);
      } catch {
        // A missing forecast is not fatal: routing and place search still work, and
        // the UI says the exposure layer is unavailable rather than faking numbers.
        if (!cancelled) setForecast(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // ── Plan real routes whenever the trip or mode changes ─────────────────────
  const plan = useCallback(async () => {
    if (!origin || !destination) return;
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;

    setPhase('routing');
    setError(null);
    try {
      const routes = await realApi.plan({
        origin: { lat: origin.lat, lon: origin.lon },
        destination: { lat: destination.lat, lon: destination.lon },
        mode,
        signal: ctrl.signal,
      });
      setPlanned(routes);
      setBaselineRouteId((prev) =>
        routes.some((r) => r.route.id === prev) ? prev : (routes[0]?.route.id ?? ''),
      );
      setPhase('ready');
    } catch (e) {
      if (ctrl.signal.aborted) return;
      setPlanned([]);
      setError(messageOf(e));
      setPhase('error');
    }
  }, [origin, destination, mode]);

  useEffect(() => {
    if (origin && destination) void plan();
    return () => abortRef.current?.abort();
  }, [origin, destination, mode, plan]);

  const useMyLocation = useCallback(async () => {
    setPhase('locating');
    setError(null);
    try {
      const pos: LatLon = await realApi.locate();
      // Reverse-geocode for a readable label; fall back to a plain label rather
      // than inventing a street name.
      const place = await realApi.reverse(pos.lat, pos.lon);
      setOrigin(
        place ?? {
          id: 'here',
          name: 'Current location',
          detail: `${pos.lat.toFixed(4)}, ${pos.lon.toFixed(4)}`,
          lat: pos.lat,
          lon: pos.lon,
        },
      );
      setPhase(origin && destination ? 'ready' : 'idle');
    } catch (e) {
      setError(messageOf(e));
      setPhase('error');
    }
  }, [origin, destination]);

  const swap = useCallback(() => {
    setOrigin((o) => {
      if (destination) setDestination(o);
      return destination;
    });
  }, [destination]);

  const retry = useCallback(() => {
    void plan();
  }, [plan]);

  const routes: Route[] = useMemo(() => planned.map((p) => p.route), [planned]);

  const segments: Segment[] = useMemo(() => {
    const seen = new Map<string, Segment>();
    for (const r of routes) for (const s of r.segments) if (!seen.has(s.id)) seen.set(s.id, s);
    return [...seen.values()];
  }, [routes]);

  const paramsOverride = useMemo(
    () => (fittedBias ? { bias: fittedBias } : undefined),
    [fittedBias],
  );

  const ctx = useMemo(
    () => (forecast ? { forecast, params: paramsOverride } : null),
    [forecast, paramsOverride],
  );

  const predictFn = useMemo(
    () => (ctx ? (seg: Segment, t: string) => engine.predict(seg, t, ctx) : null),
    [ctx],
  );

  const correctionsCache = useRef(new Map<string, CorrectionMap>());

  const correctionsAt = useCallback(
    (atISO: string): CorrectionMap => {
      if (!predictFn) return {};
      const key = `${observations.length}|${atISO}`;
      const cache = correctionsCache.current;
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
      if (cache.size > 240) cache.clear();
      cache.set(key, map);
      return map;
    },
    [observations, predictFn, segments],
  );

  const departISO = useMemo(() => isoAt(nowMs + offsetMin * 60_000), [nowMs, offsetMin]);

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
  }, [ctx, routes, baselineRouteId, mode, nowHourISO, correctionsAt, observations.length]);

  const runSensitivity = useCallback(() => {
    if (!ctx || routes.length < 2 || !baselineRouteId) return;
    try {
      setSensitivityReport(engine.sensitivity(routes, mode, departISO, {
        ...ctx,
        corrections: correctionsAt(departISO),
      }));
    } catch {
      setSensitivityReport(null);
    }
  }, [ctx, routes, mode, departISO, baselineRouteId, correctionsAt]);

  useEffect(() => setSensitivityReport(null), [departISO, mode, baselineRouteId, observations.length]);

  const addObservation = useCallback((obs: Observation) => {
    setObservations((prev) => [...prev, obs]);
  }, []);

  return {
    phase,
    error,
    forecast,
    origin,
    setOrigin,
    destination,
    setDestination,
    mode,
    setMode,
    swap,
    planned,
    routes,
    segments,
    baselineRouteId,
    setBaselineRouteId,
    offsetMin,
    setOffsetMin,
    departISO,
    nowHourISO,
    nowMs,
    observations,
    addObservation,
    corrections: useMemo(() => correctionsAt(departISO), [correctionsAt, departISO]),
    comparison,
    sweep,
    sensitivity,
    sensitivityReport,
    runSensitivity,
    fittedBias,
    applyFittedBias: setFittedBias,
    useMyLocation,
    retry,
  };
}

export type ExposureModel = ReturnType<typeof useExposureModel>;