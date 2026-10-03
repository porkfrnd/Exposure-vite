/**
 * EXPOSURE VITE: SHARED CONTRACT
 * ================================================================
 * Source of truth for every type shared between engine, data and ui.
 * You MAY extend it additively (new optional fields, new types). Never
 * break or remove an existing shape. Log every change in PROGRESS.md.
 *
 * Conventions
 * * All timestamps are UTC ISO-8601 strings ending in "Z", hourly where noted.
 * * Local (Nepal) time = UTC + NPT_OFFSET_MIN. Rush hours etc. use LOCAL hour.
 * * Concentrations are PM2.5 in µg/m³. Doses are in µg.
 * * "Log" quantities (deltaLog, sigmaLog) are natural-log, multiplicative scale.
 * * Relative humidity is a 0..1 fraction (rh01).
 * * Everything modeled is an ESTIMATE. Never present as a measurement.
 */

export const NPT_OFFSET_MIN = 345; // Nepal Time, UTC+05:45, no DST
export const KATHMANDU: LatLon = { lat: 27.7172, lon: 85.324 };

// ───────────────────────────── Geography ─────────────────────────────

export type Mode = 'walk' | 'cycle' | 'bus';
export type RoadClass =
  | 'trunk' | 'primary' | 'secondary' | 'tertiary' | 'residential' | 'footway' | 'path';

export interface LatLon { lat: number; lon: number }

export interface SegmentFeatures {
  distToMainRoadM: number;            // to nearest trunk/primary/secondary; 0 if on one
  intersectionDensityPer100m: number;
  trafficSignalsWithin50m: number;
  busStopsWithin30m: number;
  greenFraction100m: number;          // 0..1
  buildingDensity: number;            // 0..1 normalized
  /** Other roads within ~400 m (excluding the segment's own road). Used for near-road decay. */
  nearbyRoads: Array<{ roadClass: RoadClass; distanceM: number }>;
}

export interface Segment {
  id: string;                         // unique across ALL routes; shared stretches share an id
  roadClass: RoadClass;
  lengthM: number;
  coords: LatLon[];                   // polyline, >= 2 points
  features: SegmentFeatures;
}

export interface Route {
  id: string;
  name: string;
  source: 'osm-derived' | 'hand-authored';
  segments: Segment[];                // ordered start -> end
}

// ───────────────────────────── Weather / forecast ─────────────────────────────

export interface HourlyPoint {
  timeISO: string;                    // UTC, on the hour
  pm25: number;                       // modeled background, µg/m³
  aod: number | null;
  dust: number | null;
  windMs: number;
  windDirDeg: number | null;
  blhM: number | null;                // boundary-layer height
  rh01: number;                       // 0..1
  tempC: number;
  precipMm: number;
  inversionK: number | null;          // T_2m − T_upper (K); null if unavailable
}

export interface Forecast {
  source: 'live' | 'cached' | 'fixture';   // 'fixture' = SYNTHETIC offline fallback; UI must say so
  fetchedAtISO: string;               // treated as "now" for lead-time uncertainty
  location: LatLon;
  hours: HourlyPoint[];               // ascending, may include past hours
}

// ───────────────────────────── Observations ─────────────────────────────

export interface ObservationBase {
  id: string;
  lat: number;
  lon: number;
  timeISO: string;
  isSimulated: boolean;               // demo seeds are true; user-created are false
  note?: string;
}

export interface PhotoObservation extends ObservationBase {
  kind: 'photo';
  tauOpt: number;                     // optical depth −ln(mean transmission), from analyzePhoto
  rh01: number;
  scene: 'open' | 'canyon';
}

export interface ReportObservation extends ObservationBase {
  kind: 'report';
  report: 'smoky' | 'dusty' | 'clear';
}

export type Observation = PhotoObservation | ReportObservation;

export interface RasterImage {        // structural stand-in for ImageData (works in node tests)
  width: number;
  height: number;
  data: Uint8ClampedArray;            // RGBA
}

export interface HazeResult {
  tauOpt: number;
  meanTransmission: number;           // over non-sky pixels, in (0,1]
  atmosphericLight: [number, number, number];  // 0..255
  nonSkyFraction: number;             // 0..1
  patchSize: number;
  warnings: string[];
}

// ───────────────────────────── Corrections (data → engine) ─────────────────────────────

/** Uncorrected model prediction. Provided by engine, consumed by data layer. */
export type PredictFn = (segment: Segment, timeISO: string) => { concentration: number; sigmaLog: number };

export interface SegmentCorrection {
  segmentId: string;
  deltaLog: number;                   // multiply uncorrected concentration by exp(deltaLog)
  confidence: number;                 // 0..1 data support
  sigmaLog: number;                   // remaining log-uncertainty after correction
  supportN: number;                   // effective observation weight nearby
}
/** Missing key ⇒ deltaLog 0, confidence 0, default prior sigma. */
export type CorrectionMap = Record<string, SegmentCorrection>;

// ───────────────────────────── Engine parameters ─────────────────────────────

export interface BiasModel {
  a: number;                          // C_bg = max(floor, a*pm25 + b)
  b: number;
  sigmaBgLog: number;                 // held-out log-residual std (σ₀)
  leadQ: number;                      // random-walk variance per hour (q)
  leadKappa: number;                  // lead-time growth (κ), per hour
  fittedOn: string | null;            // null ⇒ identity / unvalidated
}

export const IDENTITY_BIAS: BiasModel = {
  a: 1, b: 0, sigmaBgLog: 0.35, leadQ: 0.0025, leadKappa: 0.03, fittedOn: null,
};

export interface ModeParams {
  speedKmh: number;
  ventilationM3h: number;
  infiltration: number;               // F_e: outdoor-to-breathed concentration factor
}

export interface EngineParams {
  bias: BiasModel;
  roadExcess: Record<RoadClass, number>;                 // e_c: relative excess on own road
  rush: { localHours: number[]; factor: number; classes: RoadClass[] };
  nearRoadDecayM: number;                                // λ
  greenExcess: number;                                   // e_g (subtracted × green fraction)
  stagnation: { alpha: number; uMin: number; hRef: number | null; uRef: number | null; clampMin: number; clampMax: number };
  mode: Record<Mode, ModeParams>;
  refDailyDoseUg: number;                                // normalization convention, not a medical limit
  cigaretteUgM3Day: number;                              // popular heuristic
  dailyAirM3: number;
  priorSigmaLog: number;
  floorSigmaLog: number;
  decision: { pRecommend: number; minDeltaE: number; pSlight: number };
  indoorInfiltration: number;                            // school indoors
}

// ───────────────────────────── Engine outputs ─────────────────────────────

export interface TripInput { route: Route; mode: Mode; departISO: string }

export interface EvalContext {
  forecast: Forecast;
  corrections?: CorrectionMap;
  params?: Partial<EngineParams>;
  seed?: number;                      // Monte Carlo seed, default fixed ⇒ deterministic
}

export interface SegmentEstimate {
  segmentId: string;
  arriveISO: string;
  concentration: number;              // µg/m³ (corrected)
  multiplier: number;                 // m'_s (before correction)
  deltaLog: number;
  confidence: number;
  sigmaLog: number;
  doseUg: number;
}

export interface TripEstimate {
  routeId: string;
  mode: Mode;
  departISO: string;
  durationMin: number;
  doseUg: number;
  meanConcentration: number;          // time-weighted
  confidence: number;                 // length-weighted mean segment confidence
  refDosePct: number;                 // doseUg / refDailyDoseUg × 100
  cigaretteEq: number;                // doseUg / (cigaretteUgM3Day × dailyAirM3)
  segments: SegmentEstimate[];
}

export type Verdict = 'recommend' | 'slight' | 'none';

export interface RouteVersus {
  routeId: string;
  medianDeltaE: number;               // >0 ⇒ lower dose than baseline, fraction (0.3 = 30% lower)
  pBetter: number;                    // P(dose < baseline dose) over Monte Carlo draws
  verdict: Verdict;
}

export interface Comparison {
  departISO: string;
  mode: Mode;
  baselineRouteId: string;
  trips: TripEstimate[];              // includes baseline
  versus: RouteVersus[];              // candidates only
  bestRouteId: string | null;         // best non-'none' candidate, else null
  message: string;                    // plain language, "modeled estimate" wording, no medical claims
  draws: number;
}

export interface SweepPoint { offsetMin: number; departISO: string; comparison: Comparison }

export interface SensitivityReport {
  scales: number[];                   // e.g. [0.8, 1, 1.2] applied to roadExcess
  pairs: number;
  stablePairs: number;
  stability: number;                  // stablePairs / pairs
}

export interface SchoolHour { timeISO: string; exposureIndex: number; confidence: number }
export interface SchoolWindow {
  activity: 'outdoor' | 'indoor';
  hours: SchoolHour[];                // local school day hours
  bestWindow: { startISO: string; endISO: string } | null;
  message: string;
}

// ───────────────────────────── Validation (data layer) ─────────────────────────────

export interface MetricSet { n: number; r: number; mae: number; rmse: number; bias: number; nmae: number }

export interface BacktestReport {
  stationLabel: string | null;
  nHours: number;
  nDays: number;
  effectiveSampleSize: number;        // n(1−ρ₁)/(1+ρ₁)
  scheme: 'leave-one-day-out';
  raw: MetricSet;
  biasCorrected: MetricSet;
  skillVsPersistence: number | null;
  conformal: { alpha: number; empiricalCoverage: number; qLog: number } | null;
  fittedBias: BiasModel;
  warnings: string[];
}
export type BacktestResult = { ok: true; report: BacktestReport } | { ok: false; reason: string };

// ───────────────────────────── The two public APIs ─────────────────────────────

/** Implemented in src/engine/index.ts as `export const engine: EngineApi`. */
export interface EngineApi {
  defaultParams(): EngineParams;
  /** Uncorrected model prediction (background × multiplier). Data layer injects this as PredictFn. */
  predict(segment: Segment, timeISO: string, ctx: EvalContext): { concentration: number; sigmaLog: number };
  evaluateTrip(input: TripInput, ctx: EvalContext): TripEstimate;
  compareRoutes(
    routes: Route[], baselineRouteId: string, mode: Mode, departISO: string,
    ctx: EvalContext, opts?: { draws?: number },
  ): Comparison;
  departureSweep(
    routes: Route[], baselineRouteId: string, mode: Mode, startISO: string, offsetsMin: number[],
    ctx: EvalContext, correctionsAt?: (departISO: string) => CorrectionMap | undefined,
  ): SweepPoint[];
  sensitivity(routes: Route[], mode: Mode, departISO: string, ctx: EvalContext, scales?: number[]): SensitivityReport;
  schoolWindow(
    schoolSegment: Segment, dayStartISO: string, activity: 'outdoor' | 'indoor', ctx: EvalContext,
  ): SchoolWindow;
}

/** Implemented in src/data/index.ts as `export const dataApi: DataApi`. */
export interface DataApi {
  getForecast(opts?: { lat?: number; lon?: number; pastDays?: number; forecastDays?: number }): Promise<Forecast>;
  getDemoRoutes(): Route[];
  getDemoSchool(): { name: string; segment: Segment; approximateLocation: boolean };
  getSeedObservations(): Observation[];                       // all isSimulated: true
  analyzePhoto(img: RasterImage): HazeResult;
  computeCorrections(args: {
    observations: Observation[];
    segments: Segment[];
    atISO: string;
    predict: PredictFn;
    params?: { priorSigmaLog?: number; floorSigmaLog?: number };
  }): CorrectionMap;
  runBacktest(stationCsv: string, apiHistory: Forecast): BacktestResult;
}
