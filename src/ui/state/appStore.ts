/**
 * Application state — Google-Maps-style 3-state flow.
 *
 *   EXPLORE        free pan/zoom, live-location dot, search any place, click the map
 *   PLACE_DETAILS  a place is pinned; detail card offers "Find Least Polluted Route"
 *   ROUTING        route card with editable From/To + mode; routes drawn on the map
 *
 * There are no blocking modals. The map is interactive in every state.
 *
 * Everything is real: Photon place search, FOSSGIS OSRM routing, Valhalla road
 * classes, Open-Meteo air quality. No demo routes, no simulated observations.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { engine, realApi, dataApi } from '../wiring';
import type { Place, Planned } from '../wiring';
import type {
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

export type AppState = 'EXPLORE' | 'PLACE_DETAILS' | 'ROUTING';

export const DEPARTURE_OFFSETS = [0, 30, 60, 90, 120, 150, 180];

/** Route metadata straight from the real router. */
export interface PlannedRoute extends Planned {
  id: string;
}

function isoAt(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function messageOf(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === 'string') return e;
  return 'Something went wrong.';
}

/**
 * Real PM2.5 nearest an instant, for the place detail card. Reads the forecast we
 * already hold — no extra request, and never a fabricated number.
 */
export function pm25Near(fc: Forecast | null, atMs: number): { value: number; timeISO: string } | null {
  if (!fc || fc.hours.length === 0) return null;
  let best = fc.hours[0];
  let bestGap = Number.POSITIVE_INFINITY;
  for (const h of fc.hours) {
    const t = Date.parse(h.timeISO);
    if (!Number.isFinite(t)) continue;
    const gap = Math.abs(t - atMs);
    if (gap < bestGap) {
      bestGap = gap;
      best = h;
    }
  }
  if (!Number.isFinite(best.pm25)) return null;
  return { value: best.pm25, timeISO: best.timeISO };
}

/** Very rough band label for a PM2.5 value, in µg/m³. */
export function pm25Band(v: number): { label: string; tone: string } {
  if (v <= 12) return { label: 'Low', tone: 'text-emerald-700 dark:text-emerald-400' };
  if (v <= 35) return { label: 'Moderate', tone: 'text-amber-700 dark:text-amber-400' };
  if (v <= 55) return { label: 'High', tone: 'text-orange-700 dark:text-orange-400' };
  return { label: 'Very high', tone: 'text-red-700 dark:text-red-400' };
}

export function useAppStore() {
  const [appState, setAppState] = useState<AppState>('EXPLORE');

  // ── Live location ────────────────────────────────────────────────────────
  const [liveLocation, setLiveLocation] = useState<LatLon | null>(null);
  const [locating, setLocating] = useState(false);
  const [locError, setLocError] = useState<string | null>(null);

  // ── Places ───────────────────────────────────────────────────────────────
  const [selectedPlace, setSelectedPlace] = useState<Place | null>(null);
  const [origin, setOrigin] = useState<Place | null>(null);
  const [destination, setDestination] = useState<Place | null>(null);

  // ── Route planning ───────────────────────────────────────────────────────
  const [mode, setMode] = useState<Mode>('walk');
  const [planned, setPlanned] = useState<PlannedRoute[]>([]);
  const [routing, setRouting] = useState(false);
  const [routeError, setRouteError] = useState<string | null>(null);

  // ── Data ─────────────────────────────────────────────────────────────────
  const [forecast, setForecast] = useState<Forecast | null>(null);
  const [observations, setObservations] = useState<Observation[]>([]);
  const [offsetMin, setOffsetMin] = useState(0);
  const [baselineRouteId, setBaselineRouteId] = useState('');

  const [nowMs] = useState(() => Date.now());
  const abortRef = useRef<AbortController | null>(null);

  const nowHourISO = useMemo(() => {
    const d = new Date(nowMs);
    d.setUTCMinutes(0, 0, 0);
    return isoAt(d.getTime());
  }, [nowMs]);

  // ── Forecast on load (non-fatal if it fails) ─────────────────────────────
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await realApi.getForecast();
        if (!cancelled) setForecast(res.forecast);
      } catch {
        if (!cancelled) setForecast(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // ── Ask for geolocation automatically on load (State A) ──────────────────
  const locate = useCallback(async () => {
    setLocating(true);
    setLocError(null);
    try {
      const pos = await realApi.locate();
      setLiveLocation(pos);
      return pos;
    } catch (e) {
      setLocError(messageOf(e));
      return null;
    } finally {
      setLocating(false);
    }
  }, []);

  const locateOnceRef = useRef(false);
  useEffect(() => {
    if (locateOnceRef.current) return;
    locateOnceRef.current = true;
    void locate();
  }, [locate]);

  const routes: Route[] = useMemo(() => planned.map((p) => p.route), [planned]);

  const segments: Segment[] = useMemo(() => {
    const seen = new Map<string, Segment>();
    for (const r of routes) for (const s of r.segments) if (!seen.has(s.id)) seen.set(s.id, s);
    return [...seen.values()];
  }, [routes]);

  const paramsOverride = undefined;

  const ctx = useMemo(
    () => (forecast ? { forecast, params: paramsOverride } : null),
    [forecast],
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
        map = dataApi.computeCorrections({ observations, segments, atISO, predict: predictFn });
      } catch {
        map = {};
      }
      if (cache.size > 240) cache.clear();
      cache.set(key, map);
      return map;
    },
    [observations, predictFn, segments],
  );

  const departISO = useMemo(() => isoAt(nowMs + offsetMin * 60_000), [nowMs, offsetMin]);

  // ── Fetch real routes whenever origin/destination/mode is ready ─────────
  const plan = useCallback(async () => {
    if (!origin || !destination) return;
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;

    setRouting(true);
    setRouteError(null);
    try {
      const res = await realApi.plan({
        origin: { lat: origin.lat, lon: origin.lon },
        destination: { lat: destination.lat, lon: destination.lon },
        mode,
        signal: ctrl.signal,
      });
      const withIds: PlannedRoute[] = res.map((p, i) => ({ ...p, id: p.route.id || `r${i}` }));
      setPlanned(withIds);
      setBaselineRouteId((prev) =>
        withIds.some((p) => p.route.id === prev) ? prev : (withIds[0]?.route.id ?? ''),
      );
    } catch (e) {
      if (ctrl.signal.aborted) return;
      setPlanned([]);
      setRouteError(messageOf(e));
    } finally {
      if (!ctrl.signal.aborted) setRouting(false);
    }
  }, [origin, destination, mode]);

  useEffect(() => {
    if (appState === 'ROUTING' && origin && destination) void plan();
  }, [appState, origin, destination, mode, plan]);

  useEffect(() => () => abortRef.current?.abort(), []);

  // ── Comparison for the current route set ────────────────────────────────
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

  // ── Transitions ──────────────────────────────────────────────────────────

  /** State B: a place was chosen from search or by clicking the map. */
  const selectPlace = useCallback((p: Place) => {
    setSelectedPlace(p);
    setAppState('PLACE_DETAILS');
  }, []);

  /** Map click → a pin at real coordinates, reverse-geocoded for a label. */
  const selectCoordinates = useCallback(async (lat: number, lon: number) => {
    const place = await realApi.reverse(lat, lon);
    selectPlace(
      place ?? {
        id: `pin-${lat.toFixed(4)}-${lon.toFixed(4)}`,
        name: 'Dropped pin',
        detail: `${lat.toFixed(4)}, ${lon.toFixed(4)}`,
        lat,
        lon,
      },
    );
  }, [selectPlace]);

  /** State C: promote the selected place to destination, default origin to live GPS. */
  const startRouting = useCallback(() => {
    if (!selectedPlace) return;
    setDestination(selectedPlace);
    if (!origin && liveLocation) {
      setOrigin({
        id: 'live',
        name: 'Your location',
        detail: `${liveLocation.lat.toFixed(4)}, ${liveLocation.lon.toFixed(4)}`,
        lat: liveLocation.lat,
        lon: liveLocation.lon,
      });
    }
    setAppState('ROUTING');
  }, [selectedPlace, origin, liveLocation]);

  const exitRouting = useCallback(() => {
    setAppState(selectedPlace ? 'PLACE_DETAILS' : 'EXPLORE');
  }, [selectedPlace]);

  const swapEnds = useCallback(() => {
    setOrigin(destination);
    setDestination(origin);
  }, [origin, destination]);

  /**
   * Endpoint setters that drop stale routes when an endpoint is removed.
   * Without this, clearing the destination leaves the previous trip's lines on
   * the map even though no trip can be planned any more.
   */
  const assignOrigin = useCallback((p: Place | null) => {
    setOrigin(p);
    if (!p) {
      abortRef.current?.abort();
      setPlanned([]);
      setRouteError(null);
      setBaselineRouteId('');
    }
  }, []);

  const assignDestination = useCallback((p: Place | null) => {
    setDestination(p);
    if (!p) {
      abortRef.current?.abort();
      setPlanned([]);
      setRouteError(null);
      setBaselineRouteId('');
    }
  }, []);

  const clearAll = useCallback(() => {
    setAppState('EXPLORE');
    setSelectedPlace(null);
    setOrigin(null);
    setDestination(null);
    setPlanned([]);
    setRouteError(null);
    setBaselineRouteId('');
  }, []);

  const addObservation = useCallback((o: Observation) => {
    setObservations((prev) => [...prev, o]);
  }, []);

  const retryRouting = useCallback(() => {
    void plan();
  }, [plan]);

  return {
    appState,
    setAppState,
    liveLocation,
    locating,
    locError,
    locate,

    selectedPlace,
    origin,
    setOrigin: assignOrigin,
    destination,
    setDestination: assignDestination,

    mode,
    setMode,
    planned,
    routes,
    segments,
    routing,
    routeError,

    forecast,
    observations,
    addObservation,
    offsetMin,
    setOffsetMin,
    departISO,
    baselineRouteId,
    setBaselineRouteId,
    comparison,
    sweep,

    selectPlace,
    selectCoordinates,
    startRouting,
    exitRouting,
    swapEnds,
    clearAll,
    retryRouting,
  };
}

export type AppStore = ReturnType<typeof useAppStore>;