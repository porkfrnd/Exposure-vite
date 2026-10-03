/**
 * EXPOSURE VITE — DATA LAYER (public surface)
 * ================================================================
 * Owns the forecast client, the demo route/school fixtures, the simulated seed
 * observations, photo analysis, evidence corrections and the backtest.
 *
 * Architecture rule: this module imports ONLY "@/contracts". It never imports the
 * engine — the engine's UNCORRECTED prediction reaches it as a `PredictFn`
 * argument, which is what keeps the evidence layer honestly relative.
 *
 * SYNTHETIC DATA RULE: every fabricated artefact lives under src/data/fixtures/ and
 * is labelled (Forecast.source 'fixture', Observation.isSimulated, route
 * source 'osm-derived' with hand-authored feature proxies). Nothing here is a measurement.
 */

import { fetchForecast } from './forecast/client';
import type { GetForecastOptions } from './forecast/client';
import { DEMO_ROUTES, demoSchool, DEMO_ROUTE_ISSUES, demoUniqueSegments } from './routes/loader';
import { seedObservations } from './fixtures/seedObservations';
import { computeCorrections } from './corrections/compute';
import { analyzePhoto } from './photo/haze';
import { runBacktest } from './validation/backtest';
import type { DataApi } from '@/contracts';

/** Wall-clock source, isolated so tests can inject a fixed instant. */
function nowMs(): number {
  return Date.now();
}

export const dataApi: DataApi = {
  async getForecast(opts?: GetForecastOptions) {
    return fetchForecast(opts ?? {}, { nowMs: nowMs() });
  },

  getDemoRoutes() {
    return DEMO_ROUTES;
  },

  getDemoSchool() {
    return demoSchool();
  },

  getSeedObservations() {
    // Every seed is simulated; the UI must badge them and can hide them.
    return seedObservations(new Date(nowMs()).toISOString().replace(/\.\d{3}Z$/, 'Z'));
  },

  analyzePhoto,
  computeCorrections,
  runBacktest,
};

// ── Development / diagnostics helpers (not part of the DataApi contract) ──────

/**
 * Validation issues found in the shipped demo route fixture. Empty means the
 * OSM-derived geometry satisfies every contract invariant.
 */
export function demoRouteIssues(): string[] {
  return DEMO_ROUTE_ISSUES;
}

/** Unique segments across the demo routes — the input corrections expect. */
export function demoSegments() {
  return demoUniqueSegments();
}
