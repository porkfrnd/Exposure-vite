// STUB. Replace in Phase 2; keep the export name and type.
import type { DataApi } from '@/contracts';

const notImplemented = (name: string) => () => {
  throw new Error(`dataApi.${name} not implemented yet`);
};

export const dataApi = {
  getForecast: notImplemented('getForecast'),
  getDemoRoutes: notImplemented('getDemoRoutes'),
  getDemoSchool: notImplemented('getDemoSchool'),
  getSeedObservations: notImplemented('getSeedObservations'),
  analyzePhoto: notImplemented('analyzePhoto'),
  computeCorrections: notImplemented('computeCorrections'),
  runBacktest: notImplemented('runBacktest'),
} as unknown as DataApi;
