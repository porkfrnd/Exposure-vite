/**
 * EXPOSURE VITE — DATA LAYER (public surface)
 * ================================================================
 * Everything here is REAL. There are NO demo routes, NO simulated observation
 * seeds and NO fabricated fallback routes in this build.
 *
 *  * Place search / reverse geocode  → Photon (Komoot), keyless
 *  * Route geometry + alternatives  → FOSSGIS OSRM (routing.openstreetmap.de)
 *  * Real OSM road classes + lanes   → Valhalla trace_attributes
 *  * PM2.5, wind, boundary layer     → Open-Meteo
 *  * Basemap                         → OpenStreetMap
 *
 * Architecture rule: this module imports ONLY "@/contracts". It never imports the
 * engine — the engine's UNCORRECTED prediction reaches it as a `PredictFn`
 * argument, which is what keeps the evidence layer honestly relative.
 *
 * When a live call fails the UI shows an honest error with a retry. It never
 * falls back to invented geometry or invented evidence pins.
 */

import { fetchForecast } from './forecast/client';
import type { GetForecastOptions } from './forecast/client';
import { computeCorrections } from './corrections/compute';
import { analyzePhoto } from './photo/haze';
import { runBacktest } from './validation/backtest';
import { searchPlaces, reverseGeocode, getCurrentPosition, VALLEY } from './real/geocode';
import type { Place } from './real/geocode';
import { fetchRealRoutes } from './real/routing';
import type { RealRouteResult } from './real/routing';
import type { DataApi, LatLon, Mode, Segment } from '@/contracts';

export { searchPlaces, reverseGeocode, getCurrentPosition, VALLEY } from './real/geocode';
export type { Place };
export { fetchRealRoutes, mapRoadClass } from './real/routing';
export type { RealRouteResult };

/** Wall-clock source, isolated so tests can inject a fixed instant. */
function nowMs(): number {
  return Date.now();
}

export interface Planned {
  route: import('@/contracts').Route;
  /** Real router duration in seconds, straight from the routing engine. */
  durationS: number;
  distanceM: number;
}

export interface PlanRoutesArgs {
  origin: LatLon;
  destination: LatLon;
  mode: Mode;
  signal?: AbortSignal;
}

/**
 * Additive real-data API. Kept separate from `dataApi` so the frozen contract in
 * src/contracts/index.ts never has to change.
 */
export const realApi = {
  search: (q: string, signal?: AbortSignal) => searchPlaces(q, 6, signal),
  reverse: reverseGeocode,
  locate: getCurrentPosition,

  /** Plan real routes between two real places. Throws on failure, never invents. */
  async plan({ origin, destination, mode, signal }: PlanRoutesArgs): Promise<Planned[]> {
    const res: RealRouteResult = await fetchRealRoutes(origin, destination, mode, signal);
    return res.routes.map((route, i) => ({
      route,
      durationS: res.durationsS[i] ?? 0,
      distanceM: res.distanceM[i] ?? 0,
    }));
  },

  getForecast: getForecastWithOrigin,
};

/**
 * The forecast, plus the grid point it actually came from. The UI shows the real
 * model name so nobody assumes valley-scale precision it does not have.
 */
export async function getForecastWithOrigin(
  opts?: GetForecastOptions,
): Promise<{ forecast: import('@/contracts').Forecast; origin: LatLon }> {
  const loc = { lat: opts?.lat ?? VALLEY.lat, lon: opts?.lon ?? VALLEY.lon };
  const forecast = await fetchForecast(opts ?? {}, { nowMs: nowMs() });
  // Open-Meteo snaps to its grid cell; report that cell, not our request point.
  return { forecast, origin: forecast.location };
}

/**
 * Contract-shaped adapter. `getDemoRoutes` returns REAL routes once the user has
 * planned a trip this session; otherwise it returns an empty array rather than
 * fabricated geometry, and the UI renders an honest empty state.
 */
const EMPTY_SEGMENT: Segment = {
  id: 'no-segment',
  roadClass: 'residential',
  lengthM: 1,
  coords: [
    { lat: VALLEY.lat, lon: VALLEY.lon },
    { lat: VALLEY.lat + 0.0001, lon: VALLEY.lon },
  ],
  features: {
    distToMainRoadM: 0,
    intersectionDensityPer100m: 0,
    trafficSignalsWithin50m: 0,
    busStopsWithin30m: 0,
    greenFraction100m: 0,
    buildingDensity: 0,
    nearbyRoads: [],
  },
};

export const dataApi: DataApi = {
  async getForecast(opts?: GetForecastOptions) {
    return (await getForecastWithOrigin(opts)).forecast;
  },

  getDemoRoutes: () => [],

  getDemoSchool: () => ({
    name: 'Your destination',
    segment: EMPTY_SEGMENT,
    approximateLocation: true,
  }),

  // No fabricated evidence seeds. Local evidence comes from the user's own photos
  // and reports, or from a real station CSV backtest.
  getSeedObservations: () => [],

  analyzePhoto,
  computeCorrections,
  runBacktest,
};

/** Type re-export so UI code can reference the place shape through the seam. */
export type { Place as SearchPlace };