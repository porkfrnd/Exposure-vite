/**
 * Scientific Breakdown drawer.
 *
 * This is where ALL the technical language is allowed to appear: multipliers, road
 * classes, dose normalisations, confidence, simulation agreement, assumptions.
 * The first screen stays clean; everything scientific is exactly one tap deeper.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, ChevronDown, ChevronRight, FileSpreadsheet, Loader2, X } from 'lucide-react';
import { dataApi, engine } from '../wiring';
import { FOCUS_RING, GLASS_CARD, MOTION, NUMBERS, OVERLAY_Z_MODAL } from '../design';
import type {
  BacktestReport,
  BiasModel,
  Comparison,
  EngineParams,
  Route,
  Segment,
  SegmentEstimate,
  SweepPoint,
} from '@/contracts';

export interface BreakdownDrawerProps {
  open: boolean;
  onClose: () => void;
  comparison: Comparison | null;
  routes: Route[];
  segments: Segment[];
  sweep: SweepPoint[];
  selectedSegmentId: string | null;
  onSelectSegment: (id: string | null) => void;
  sensitivity: { scales: number[]; pairs: number; stablePairs: number; stability: number } | null;
  onRunSensitivity: () => void;
  fittedBias: BiasModel | null;
  params: EngineParams;
  openSection?: string;
  onApplyFittedBias?: (bias: BiasModel) => void;
}

type SectionId =
  | 'routes'
  | 'segments'
  | 'sweep'
  | 'how'
  | 'assumptions'
  | 'limitations'
  | 'validation'
  | 'sensitivity';

const SECTIONS: Array<{ id: SectionId; label: string }> = [
  { id: 'routes', label: 'Route comparison' },
  { id: 'segments', label: 'Segment details' },
  { id: 'sweep', label: 'Departure sweep' },
  { id: 'how', label: 'How the model works' },
  { id: 'assumptions', label: 'Assumptions (every guessed value)' },
  { id: 'limitations', label: 'Limitations' },
  { id: 'validation', label: 'Validation' },
  { id: 'sensitivity', label: 'Sensitivity check' },
];

function pct(f: number): string {
  return Number.isFinite(f) ? `${Math.round(f * 100)}%` : '—';
}

function num(v: number, digits = 1): string {
  return Number.isFinite(v) ? v.toFixed(digits) : '—';
}

function Accordion({
  id,
  label,
  open,
  onToggle,
  children,
}: {
  id: SectionId;
  label: string;
  open: boolean;
  onToggle: (id: SectionId) => void;
  children: React.ReactNode;
}) {
  return (
    <section className="border-b border-slate-200/80 last:border-b-0 dark:border-slate-700/70">
      <h3>
        <button
          type="button"
          onClick={() => onToggle(id)}
          aria-expanded={open}
          aria-controls={`breakdown-${id}`}
          className={`${FOCUS_RING} ${MOTION} flex w-full items-center justify-between gap-2 px-1 py-3 text-left text-sm font-semibold text-slate-900 hover:bg-slate-100/60 dark:text-slate-100 dark:hover:bg-slate-800/60`}
        >
          <span>{label}</span>
          {open ? (
            <ChevronDown size={16} className="shrink-0 opacity-60" aria-hidden />
          ) : (
            <ChevronRight size={16} className="shrink-0 opacity-60" aria-hidden />
          )}
        </button>
      </h3>
      {open && (
        <div id={`breakdown-${id}`} className="space-y-3 px-1 pb-4 text-xs leading-relaxed text-slate-700 dark:text-slate-300">
          {children}
        </div>
      )}
    </section>
  );
}

/** Hand-written SVG chart of modeled dose against departure offset. */
function SweepChart({ sweep, routes }: { sweep: SweepPoint[]; routes: Route[] }) {
  if (sweep.length === 0) {
    return <p className="text-slate-500 dark:text-slate-400">No sweep available yet.</p>;
  }

  const series = routes.map((route) => {
    const color = route.id === sweep[0].comparison.baselineRouteId ? '#0ea5e9' : '#10b981';
    return {
      id: route.id,
      name: route.name,
      color,
      points: sweep.map((p) => {
        const trip = p.comparison.trips.find((t) => t.routeId === route.id);
        return { offset: p.offsetMin, dose: trip?.doseUg ?? 0, verdict: p.comparison.versus.find((v) => v.routeId === route.id)?.verdict };
      }),
    };
  });

  const W = 300;
  const H = 150;
  const PAD = { l: 34, r: 8, t: 8, b: 22 };
  const doses = series.flatMap((s) => s.points.map((p) => p.dose));
  const maxDose = Math.max(...doses, 1e-6);
  const maxOffset = Math.max(...sweep.map((p) => p.offsetMin), 1);
  const x = (o: number) => PAD.l + (o / maxOffset) * (W - PAD.l - PAD.r);
  const y = (d: number) => H - PAD.b - (d / maxDose) * (H - PAD.t - PAD.b);

  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label="Modeled dose by departure time">
        <line x1={PAD.l} y1={H - PAD.b} x2={W - PAD.r} y2={H - PAD.b} className="stroke-slate-300 dark:stroke-slate-600" />
        <line x1={PAD.l} y1={PAD.t} x2={PAD.l} y2={H - PAD.b} className="stroke-slate-300 dark:stroke-slate-600" />
        <text x={4} y={PAD.t + 8} className="fill-slate-500 text-[9px] dark:fill-slate-400">
          {num(maxDose, 1)}
        </text>
        <text x={4} y={H - PAD.b} className="fill-slate-500 text-[9px] dark:fill-slate-400">
          0
        </text>
        <text x={PAD.l} y={H - 6} className="fill-slate-500 text-[9px] dark:fill-slate-400">
          now
        </text>
        <text x={W - PAD.r - 18} y={H - 6} className="fill-slate-500 text-[9px] dark:fill-slate-400">
          +{maxOffset}m
        </text>

        {series.map((s) => (
          <polyline
            key={s.id}
            fill="none"
            stroke={s.color}
            strokeWidth={2}
            strokeLinejoin="round"
            strokeLinecap="round"
            points={s.points.map((p) => `${x(p.offset)},${y(p.dose)}`).join(' ')}
          />
        ))}

        {/* Mark offsets where a candidate reaches a 'recommend' verdict. */}
        {sweep.map((p) =>
          p.comparison.versus.some((v) => v.verdict === 'recommend') ? (
            <g key={`mark-${p.offsetMin}`}>
              <circle cx={x(p.offsetMin)} cy={y(0) + 10} r={3} fill="#10b981" />
              <text
                x={x(p.offsetMin)}
                y={y(0) + 3}
                textAnchor="middle"
                className="fill-emerald-600 text-[8px] dark:fill-emerald-400"
              >
                ✓
              </text>
            </g>
          ) : null,
        )}
      </svg>

      <ul className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1">
        {series.map((s) => (
          <li key={s.id} className="flex items-center gap-1.5">
            <span className="inline-block h-2 w-2 rounded-full" style={{ background: s.color }} aria-hidden />
            {s.name}
          </li>
        ))}
      </ul>
      <p className="mt-1 text-[11px] text-slate-500 dark:text-slate-400">
        A ✓ marks a departure time where the model recommends a different route.
      </p>
    </div>
  );
}

export function BreakdownDrawer(props: BreakdownDrawerProps) {
  const [openSections, setOpenSections] = useState<Set<SectionId>>(
    () => new Set<SectionId>(['routes']),
  );
  const closeRef = useRef<HTMLButtonElement | null>(null);

  // Reset to the requested section whenever the drawer is opened.
  useEffect(() => {
    if (props.open && props.openSection) {
      setOpenSections(new Set<SectionId>([props.openSection as SectionId]));
    }
    if (props.open && props.selectedSegmentId) {
      setOpenSections((prev) => new Set<SectionId>([...prev, 'segments']));
    }
  }, [props.open, props.openSection, props.selectedSegmentId]);

  // Escape closes, and focus moves into the drawer.
  useEffect(() => {
    if (!props.open) return;
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') props.onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [props.open, props.onClose]);

  if (!props.open) return null;

  const toggle = (id: SectionId) =>
    setOpenSections((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const isOpen = (id: SectionId) => openSections.has(id);
  const params = props.params;
  const nameOf = (id: string) => props.routes.find((r) => r.id === id)?.name ?? id;

  // ── Validation / backtest state ────────────────────────────────────────────
  type ValidationState = 'idle' | 'running' | 'success' | 'error';
  const [validationState, setValidationState] = useState<ValidationState>('idle');
  const [validationError, setValidationError] = useState<string>('');
  const [backtestReport, setBacktestReport] = useState<BacktestReport | null>(null);

  const handleCsvUpload = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const text = await file.text();
    setValidationState('running');
    setValidationError('');
    try {
      const fc = await dataApi.getForecast({ pastDays: 7, forecastDays: 0 });
      const result = await dataApi.runBacktest(text, fc);
      if (!result.ok) {
        setValidationState('error');
        setValidationError(result.reason);
        return;
      }
      setBacktestReport(result.report);
      setValidationState('success');
    } catch (err) {
      setValidationState('error');
      setValidationError(err instanceof Error ? err.message : 'Unknown error');
    }
  }, []);

  const selectedTrip = props.comparison?.trips.find((t) =>
    t.segments.some((s) => s.segmentId === props.selectedSegmentId),
  );
  const selectedSeg = selectedTrip?.segments.find((s) => s.segmentId === props.selectedSegmentId);
  const selectedDef = props.segments.find((s) => s.id === props.selectedSegmentId);

  return (
    <div className={`${OVERLAY_Z_MODAL} fixed inset-0 flex justify-end`}>
      <button
        type="button"
        aria-label="Close breakdown"
        onClick={props.onClose}
        className="absolute inset-0 cursor-default bg-slate-900/25"
      />

      <aside
        role="dialog"
        aria-modal="true"
        aria-label="Scientific breakdown"
        className={`${GLASS_CARD} relative flex h-full w-full max-w-[26rem] flex-col rounded-none sm:rounded-l-2xl`}
      >
        <header className="flex items-center justify-between gap-2 border-b border-slate-200/80 px-4 py-3 dark:border-slate-700/70">
          <h2 className="text-sm font-semibold tracking-tight text-slate-900 dark:text-slate-100">
            Scientific breakdown
          </h2>
          <button
            ref={closeRef}
            type="button"
            onClick={props.onClose}
            aria-label="Close"
            className={`${FOCUS_RING} ${MOTION} rounded-lg p-1.5 text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800`}
          >
            <X size={16} aria-hidden />
          </button>
        </header>

        <div className="flex-1 overflow-y-auto px-3 pb-8">
          <Accordion id="routes" label="Route comparison" open={isOpen('routes')} onToggle={toggle}>
            {props.comparison ? (
              <>
                <p className="text-[11px] text-slate-500 dark:text-slate-400">
                  Compared against <strong>{nameOf(props.comparison.baselineRouteId)}</strong>, using{' '}
                  <span className={NUMBERS}>{props.comparison.draws}</span> simulated draws.
                </p>
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[22rem] text-left">
                    <thead className="text-[10px] uppercase tracking-wide text-slate-500 dark:text-slate-400">
                      <tr>
                        <th scope="col" className="py-1 pr-2 font-medium">Route</th>
                        <th scope="col" className="py-1 pr-2 font-medium">Dose µg</th>
                        <th scope="col" className="py-1 pr-2 font-medium">% ref.</th>
                        <th scope="col" className="py-1 pr-2 font-medium">Cig. eq.</th>
                        <th scope="col" className="py-1 pr-2 font-medium">Conf.</th>
                        <th scope="col" className="py-1 font-medium">Agree</th>
                      </tr>
                    </thead>
                    <tbody>
                      {props.comparison.trips.map((trip) => {
                        const versus = props.comparison!.versus.find((v) => v.routeId === trip.routeId);
                        const isBase = trip.routeId === props.comparison!.baselineRouteId;
                        return (
                          <tr key={trip.routeId} className="border-t border-slate-200/70 dark:border-slate-700/60">
                            <th scope="row" className="py-1.5 pr-2 font-medium">
                              {nameOf(trip.routeId)}
                              {isBase && <span className="ml-1 text-[10px] text-slate-400">(base)</span>}
                            </th>
                            <td className={`${NUMBERS} py-1.5 pr-2`}>{num(trip.doseUg, 2)}</td>
                            <td className={`${NUMBERS} py-1.5 pr-2`} title="Convention: a reference daily dose, not a medical limit">
                              {num(trip.refDosePct, 2)}
                            </td>
                            <td className={`${NUMBERS} py-1.5 pr-2`} title="Popular heuristic only, not a health statement">
                              {num(trip.cigaretteEq, 3)}
                            </td>
                            <td className={`${NUMBERS} py-1.5 pr-2`}>{pct(trip.confidence)}</td>
                            <td className={`${NUMBERS} py-1.5`}>
                              {isBase ? '—' : `${pct(versus?.pBetter ?? 0)} ${versus?.verdict ?? ''}`}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                <p className="text-[11px] text-slate-500 dark:text-slate-400">
                  "% ref." and "Cig. eq." are normalization conventions used for comparison, not medical
                  thresholds. "Agree" is how often the simulated draws favoured this route over the base.
                </p>
              </>
            ) : (
              <p>No comparison yet.</p>
            )}
          </Accordion>

          <Accordion id="segments" label="Segment details" open={isOpen('segments')} onToggle={toggle}>
            {props.selectedSegmentId && selectedSeg && selectedDef ? (
              <>
                <dl className="grid grid-cols-2 gap-x-3 gap-y-1.5">
                  <div>
                    <dt className="text-[10px] uppercase tracking-wide text-slate-500 dark:text-slate-400">Road class</dt>
                    <dd className="font-medium">{selectedDef.roadClass}</dd>
                  </div>
                  <div>
                    <dt className="text-[10px] uppercase tracking-wide text-slate-500 dark:text-slate-400">Length</dt>
                    <dd className={`${NUMBERS} font-medium`}>{num(selectedDef.lengthM, 0)} m</dd>
                  </div>
                  <div>
                    <dt className="text-[10px] uppercase tracking-wide text-slate-500 dark:text-slate-400">Multiplier</dt>
                    <dd className={`${NUMBERS} font-medium`}>×{num(selectedSeg.multiplier, 3)}</dd>
                  </div>
                  <div>
                    <dt className="text-[10px] uppercase tracking-wide text-slate-500 dark:text-slate-400">
                      Modeled concentration
                    </dt>
                    <dd className={`${NUMBERS} font-medium`}>{num(selectedSeg.concentration, 1)} µg/m³ modeled</dd>
                  </div>
                  <div>
                    <dt className="text-[10px] uppercase tracking-wide text-slate-500 dark:text-slate-400">
                      Evidence shift
                    </dt>
                    <dd className={`${NUMBERS} font-medium`}>×{num(Math.exp(selectedSeg.deltaLog), 3)}</dd>
                  </div>
                  <div>
                    <dt className="text-[10px] uppercase tracking-wide text-slate-500 dark:text-slate-400">Confidence</dt>
                    <dd className={`${NUMBERS} font-medium`}>{pct(selectedSeg.confidence)}</dd>
                  </div>
                  <div>
                    <dt className="text-[10px] uppercase tracking-wide text-slate-500 dark:text-slate-400">Log sigma</dt>
                    <dd className={`${NUMBERS} font-medium`}>{num(selectedSeg.sigmaLog, 3)}</dd>
                  </div>
                  <div>
                    <dt className="text-[10px] uppercase tracking-wide text-slate-500 dark:text-slate-400">
                      Dose on this segment
                    </dt>
                    <dd className={`${NUMBERS} font-medium`}>{num(selectedSeg.doseUg, 2)} µg</dd>
                  </div>
                </dl>
                <p className="text-[11px] text-slate-500 dark:text-slate-400">
                  On route {nameOf(selectedTrip!.routeId)}, arriving {selectedSeg.arriveISO}.
                </p>
              </>
            ) : (
              <p className="text-slate-500 dark:text-slate-400">
                Tap a route segment on the map to see its details here.
              </p>
            )}
          </Accordion>

          <Accordion id="sweep" label="Departure sweep" open={isOpen('sweep')} onToggle={toggle}>
            <SweepChart sweep={props.sweep} routes={props.routes} />
          </Accordion>

          <Accordion id="how" label="How the model works" open={isOpen('how')} onToggle={toggle}>
            <ol className="list-decimal space-y-2 pl-4">
              <li>
                <strong>Background.</strong> An hourly gridded forecast sets when pollution is worse across the
                whole valley. It sets the level; it cannot see streets.
              </li>
              <li>
                <strong>Street prior.</strong> Road class, distance to the nearest main road and local
                greenness produce a multiplicative prior around 1.
              </li>
              <li>
                <strong>Evidence.</strong> Haze photos and crowd reports nudge nearby segments up or down,
                relative to each other. They redistribute exposure between places — they never change the
                regional level.
              </li>
              <li>
                <strong>Uncertainty decides.</strong> Monte Carlo draws perturb the background once per
                comparison and each segment separately. A recommendation appears only when the same route
                wins clearly and repeatedly; otherwise the app says there is no meaningful difference.
              </li>
            </ol>
          </Accordion>

          <Accordion id="assumptions" label="Assumptions (every guessed value)" open={isOpen('assumptions')} onToggle={toggle}>
            <p className="text-[11px] text-amber-700 dark:text-amber-300">
              Every value below is a starting guess. None was calibrated on Kathmandu field data.
            </p>
            <table className="w-full text-left">
              <thead className="text-[10px] uppercase tracking-wide text-slate-500 dark:text-slate-400">
                <tr>
                  <th scope="col" className="py-1 pr-2 font-medium">Parameter</th>
                  <th scope="col" className="py-1 font-medium">Value</th>
                </tr>
              </thead>
              <tbody className={NUMBERS}>
                {Object.entries(params.roadExcess).map(([k, v]) => (
                  <tr key={`re-${k}`} className="border-t border-slate-200/70 dark:border-slate-700/60">
                    <th scope="row" className="py-1 pr-2 font-medium">near-road excess · {k}</th>
                    <td>{num(v, 2)}</td>
                  </tr>
                ))}
                <tr className="border-t border-slate-200/70 dark:border-slate-700/60">
                  <th scope="row" className="py-1 pr-2 font-medium">near-road decay length</th>
                  <td>{num(params.nearRoadDecayM, 0)} m</td>
                </tr>
                <tr className="border-t border-slate-200/70 dark:border-slate-700/60">
                  <th scope="row" className="py-1 pr-2 font-medium">green excess</th>
                  <td>{num(params.greenExcess, 2)}</td>
                </tr>
                <tr className="border-t border-slate-200/70 dark:border-slate-700/60">
                  <th scope="row" className="py-1 pr-2 font-medium">rush hours (local)</th>
                  <td>{params.rush.localHours.join(', ')}</td>
                </tr>
                <tr className="border-t border-slate-200/70 dark:border-slate-700/60">
                  <th scope="row" className="py-1 pr-2 font-medium">rush factor</th>
                  <td>{num(params.rush.factor, 2)}</td>
                </tr>
                <tr className="border-t border-slate-200/70 dark:border-slate-700/60">
                  <th scope="row" className="py-1 pr-2 font-medium">stagnation exponent / clamp</th>
                  <td>{num(params.stagnation.alpha, 2)} · {num(params.stagnation.clampMin, 1)}–{num(params.stagnation.clampMax, 1)}</td>
                </tr>
                {Object.entries(params.mode).map(([k, v]) => (
                  <tr key={`m-${k}`} className="border-t border-slate-200/70 dark:border-slate-700/60">
                    <th scope="row" className="py-1 pr-2 font-medium">{k} · km/h, m³/h, F_e</th>
                    <td>{num(v.speedKmh, 1)} · {num(v.ventilationM3h, 1)} · {num(v.infiltration, 2)}</td>
                  </tr>
                ))}
                <tr className="border-t border-slate-200/70 dark:border-slate-700/60">
                  <th scope="row" className="py-1 pr-2 font-medium">reference daily dose</th>
                  <td>{num(params.refDailyDoseUg, 0)} µg</td>
                </tr>
                <tr className="border-t border-slate-200/70 dark:border-slate-700/60">
                  <th scope="row" className="py-1 pr-2 font-medium">prior / floor log sigma</th>
                  <td>{num(params.priorSigmaLog, 2)} · {num(params.floorSigmaLog, 2)}</td>
                </tr>
                <tr className="border-t border-slate-200/70 dark:border-slate-700/60">
                  <th scope="row" className="py-1 pr-2 font-medium">decision thresholds</th>
                  <td>p≥{num(params.decision.pRecommend, 2)} & ΔE≥{pct(params.decision.minDeltaE)} · slight p≥{num(params.decision.pSlight, 2)}</td>
                </tr>
                <tr className="border-t border-slate-200/70 dark:border-slate-700/60">
                  <th scope="row" className="py-1 pr-2 font-medium">school indoor infiltration</th>
                  <td>{num(params.indoorInfiltration, 2)}</td>
                </tr>
                <tr className="border-t border-slate-200/70 dark:border-slate-700/60">
                  <th scope="row" className="py-1 pr-2 font-medium">bias calibration</th>
                  <td>{params.bias.fittedOn ?? 'none (identity)'}</td>
                </tr>
              </tbody>
            </table>
          </Accordion>

          <Accordion id="limitations" label="Limitations" open={isOpen('limitations')} onToggle={toggle}>
            <ul className="list-disc space-y-1.5 pl-4">
              <li>The forecast is a coarse gridded model. It cannot see individual streets.</li>
              <li>Road multipliers are assumptions taken from general air-pollution modelling practice, not Kathmandu measurements.</li>
              <li>Photo haze is affected by light, cloud, sun angle and unknown scene depth, so it is a rough relative nudge.</li>
              <li>Dust from roadworks and unpaved roads is not captured by road class.</li>
              <li>Road classes come from real OpenStreetMap tags. Green fraction, building density, signals and bus stops have no keyless source, so they are held at neutral assumptions and do not differentiate routes.</li>
              <li>Outputs are modeled exposure estimates. They are not medical or health-risk claims.</li>
            </ul>
          </Accordion>

          <Accordion id="validation" label="Validation" open={isOpen('validation')} onToggle={toggle}>
            <div className="space-y-3">
              <p className="text-[11px] text-slate-500 dark:text-slate-400">
                No accuracy figure appears anywhere in this app, because none has been measured here.
                Provide a station CSV (time + pm25 columns) to run a leave-one-day-out backtest against the
                forecast history.
              </p>

              <label className="flex flex-col gap-1.5">
                <span className="flex items-center gap-1.5 text-xs font-medium text-slate-700 dark:text-slate-200">
                  <FileSpreadsheet size={12} aria-hidden />
                  Station CSV (time, pm25)
                </span>
                <input
                  type="file"
                  accept=".csv,text/csv"
                  onChange={handleCsvUpload}
                  disabled={validationState === 'running'}
                  className="rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-xs text-slate-900 ring-1 ring-slate-300 dark:bg-slate-900 dark:text-slate-100 dark:ring-slate-600 file:mr-2 file:rounded file:border-0 file:bg-emerald-100 file:text-emerald-800 file:px-2 file:py-1"
                />
              </label>

              {validationState === 'running' && (
                <div className="flex items-center gap-2 text-[11px] text-slate-600 dark:text-slate-300">
                  <Loader2 size={12} className="animate-spin" aria-hidden />
                  Running leave-one-day-out backtest…
                </div>
              )}

              {validationState === 'error' && (
                <p className="text-[11px] text-red-700 dark:text-red-300" role="alert">
                  {validationError}
                </p>
              )}

              {validationState === 'success' && backtestReport && (
                <div className="space-y-2">
                  <div className="flex items-center gap-2">
                    <AlertTriangle size={12} className="text-emerald-600 dark:text-emerald-400" aria-hidden />
                    <span className="font-medium text-emerald-700 dark:text-emerald-300">Backtest completed</span>
                  </div>

                  {backtestReport.fittedBias.fittedOn && (
                    <button
                      type="button"
                      onClick={() => props.onApplyFittedBias?.(backtestReport.fittedBias)}
                      className={`${FOCUS_RING} ${MOTION} rounded-lg bg-emerald-100 px-2.5 py-1.5 font-semibold text-emerald-800 ring-1 ring-emerald-500/40 dark:bg-emerald-500/15 dark:text-emerald-300 dark:ring-emerald-400/40`}
                    >
                      Apply fitted bias correction (from {backtestReport.fittedBias.fittedOn})
                    </button>
                  )}

                  <div className="rounded-lg bg-slate-100/80 p-2.5 dark:bg-slate-800/60">
                    <table className="w-full text-left">
                      <thead className="text-[10px] uppercase tracking-wide text-slate-500 dark:text-slate-400">
                        <tr>
                          <th scope="col" className="py-1 pr-2 font-medium">Metric</th>
                          <th scope="col" className="py-1 font-medium">Raw API</th>
                          <th scope="col" className="py-1 font-medium">Bias-corrected</th>
                        </tr>
                      </thead>
                      <tbody className={NUMBERS}>
                        {[{ label: 'n (hours)', raw: backtestReport.raw.n, bc: backtestReport.biasCorrected.n },
                          { label: 'Pearson r', raw: backtestReport.raw.r, bc: backtestReport.biasCorrected.r },
                          { label: 'MAE (µg/m³)', raw: backtestReport.raw.mae, bc: backtestReport.biasCorrected.mae },
                          { label: 'RMSE (µg/m³)', raw: backtestReport.raw.rmse, bc: backtestReport.biasCorrected.rmse },
                          { label: 'Bias (µg/m³)', raw: backtestReport.raw.bias, bc: backtestReport.biasCorrected.bias },
                          { label: 'NMAE', raw: backtestReport.raw.nmae, bc: backtestReport.biasCorrected.nmae },
                        ].map((m) => (
                          <tr key={m.label} className="border-t border-slate-200/70 dark:border-slate-700/60">
                            <th scope="row" className="py-1 pr-2 font-medium">{m.label}</th>
                            <td>{num(m.raw, 3)}</td>
                            <td>{num(m.bc, 3)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>

                  <div className="rounded-lg bg-slate-100/80 p-2.5 dark:bg-slate-800/60">
                    <h4 className="text-[10px] uppercase tracking-wide text-slate-500 dark:text-slate-400 mb-1.5">
                      Additional diagnostics
                    </h4>
                    <dl className="grid grid-cols-2 gap-x-3 gap-y-1.5 text-[11px]">
                      <dt className="text-slate-500 dark:text-slate-400">nDays</dt>
                      <dd className={`${NUMBERS} font-medium`}>{backtestReport.nDays}</dd>
                      <dt className="text-slate-500 dark:text-slate-400">Effective sample size</dt>
                      <dd className={`${NUMBERS} font-medium`}>{backtestReport.effectiveSampleSize.toFixed(1)}</dd>
                      <dt className="text-slate-500 dark:text-slate-400">Scheme</dt>
                      <dd className={`${NUMBERS} font-medium`}>{backtestReport.scheme}</dd>
                      <dt className="text-slate-500 dark:text-slate-400">Skill vs persistence</dt>
                      <dd className={`${NUMBERS} font-medium`}>
                        {backtestReport.skillVsPersistence !== null ? pct(backtestReport.skillVsPersistence) : '—'}
                      </dd>
                      <dt className="text-slate-500 dark:text-slate-400">Fitted bias</dt>
                      <dd className={`${NUMBERS} font-medium`}>
                        a={num(backtestReport.fittedBias.a, 3)}, b={num(backtestReport.fittedBias.b, 3)}, σ={num(backtestReport.fittedBias.sigmaBgLog, 3)}
                      </dd>
                      {backtestReport.conformal && (
                        <>
                          <dt className="text-slate-500 dark:text-slate-400">Conformal α</dt>
                          <dd className={`${NUMBERS} font-medium`}>{backtestReport.conformal.alpha}</dd>
                          <dt className="text-slate-500 dark:text-slate-400">Empirical coverage</dt>
                          <dd className={`${NUMBERS} font-medium`}>{pct(backtestReport.conformal.empiricalCoverage)}</dd>
                          <dt className="text-slate-500 dark:text-slate-400">qLog</dt>
                          <dd className={`${NUMBERS} font-medium`}>{num(backtestReport.conformal.qLog, 3)}</dd>
                        </>
                      )}
                    </dl>
                  </div>

                  {backtestReport.warnings.length > 0 && (
                    <ul className="space-y-1">
                      {backtestReport.warnings.map((w, i) => (
                        <li key={i} className="text-[11px] text-amber-700 dark:text-amber-300">
                          {w}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </div>
          </Accordion>

          <Accordion id="sensitivity" label="Sensitivity check" open={isOpen('sensitivity')} onToggle={toggle}>
            <p className="text-[11px] text-slate-500 dark:text-slate-400">
              Re-runs the ranking with every assumed street multiplier shifted together. This measures how
              stable the ranking is — it is not an accuracy measure.
            </p>
            <button
              type="button"
              onClick={props.onRunSensitivity}
              className={`${FOCUS_RING} ${MOTION} rounded-lg bg-slate-100 px-3 py-1.5 font-semibold text-slate-800 ring-1 ring-slate-300 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-100 dark:ring-slate-600`}
            >
              Run sensitivity check
            </button>
            {props.sensitivity && (
              <p className={`${NUMBERS} font-medium`}>
                Rankings held in {props.sensitivity.stablePairs} of {props.sensitivity.pairs} route pairs under ±20%
                multiplier changes.
              </p>
            )}
          </Accordion>
        </div>
      </aside>
    </div>
  );
}

/** The engine's current default parameters, for the assumptions table. */
export function currentEngineParams(): EngineParams {
  return engine.defaultParams();
}

export type { SegmentEstimate };
