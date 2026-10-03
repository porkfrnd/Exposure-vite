// STUB. Replace in Phase 1; keep the export names and types.
import type { EngineApi } from '@/contracts';

const notImplemented = (name: string) => () => {
  throw new Error(`engine.${name} not implemented yet`);
};

export const engine = {
  defaultParams: notImplemented('defaultParams'),
  predict: notImplemented('predict'),
  evaluateTrip: notImplemented('evaluateTrip'),
  compareRoutes: notImplemented('compareRoutes'),
  departureSweep: notImplemented('departureSweep'),
  sensitivity: notImplemented('sensitivity'),
  schoolWindow: notImplemented('schoolWindow'),
} as unknown as EngineApi;
