/**
 * Route summary card — the ONE key takeaway.
 *
 * Everything here is computed at runtime from engine.compareRoutes; nothing is
 * hardcoded. The copy is deliberately non-technical and makes no health, safety or
 * accuracy claim: "lower modeled exposure", never "safe" or "measured".
 */

import { Camera, ChevronUp, Info, MessageSquarePlus } from 'lucide-react';
import { ACCENT, FOCUS_RING, GLASS_CARD, MOTION, NUMBERS, OVERLAY_Z, TOUCH_TARGET } from '../design';
import { routeFactsText } from '../format';
import type { Comparison, Route } from '@/contracts';

export interface SummaryCardProps {
  comparison: Comparison | null;
  routes: Route[];
  /**
   * REAL router metrics per route id, straight from OSRM. Distance and time
   * must never be inferred from the exposure engine — they are facts about the
   * road network and belong to the router.
   */
  realMetrics?: Record<string, { durationS: number; distanceM: number }>;
  bestTimeHint: string | null;
  onOpenBreakdown: () => void;
  onAddEvidence: () => void;
  onOpenEvidence: () => void;
  collapsed: boolean;
  onToggleCollapsed: () => void;
}

function pct(fraction: number): number {
  return Number.isFinite(fraction) ? Math.round(fraction * 100) : 0;
}

export function RouteSummaryCard(props: SummaryCardProps) {
  const { comparison, routes } = props;
  const nameOf = (id: string) => routes.find((r) => r.id === id)?.name ?? id;

  if (!comparison) {
    return (
      <div className={`${GLASS_CARD} ${OVERLAY_Z} pointer-events-auto absolute bottom-4 left-4 w-[min(22rem,calc(100vw-2rem))] p-4`}>
        <p className="text-sm text-slate-600 dark:text-slate-300">Working out the best option…</p>
      </div>
    );
  }

  const best = comparison.versus.find((v) => v.routeId === comparison.bestRouteId);
  const verdict = best?.verdict ?? 'none';
  const bestName = comparison.bestRouteId ? nameOf(comparison.bestRouteId) : '';
  const bestTrip = comparison.trips.find((t) => t.routeId === comparison.bestRouteId);
  const baselineTrip = comparison.trips.find((t) => t.routeId === comparison.baselineRouteId);

  const headline =
    verdict === 'recommend'
      ? `${bestName} recommended`
      : verdict === 'slight'
        ? `Slight edge: ${bestName}`
        : 'No clear difference';

  const badge =
    verdict === 'recommend'
      ? {
          text: `↓ ${pct(best!.medianDeltaE)}% lower estimated exposure`,
          tone: 'bg-emerald-100 text-emerald-800 ring-emerald-500/40 dark:bg-emerald-500/15 dark:text-emerald-300 dark:ring-emerald-400/40',
        }
      : verdict === 'slight'
        ? {
            text: `↓ ${pct(best!.medianDeltaE)}% lower, low confidence`,
            tone: 'bg-amber-100 text-amber-900 ring-amber-500/40 dark:bg-amber-500/15 dark:text-amber-200 dark:ring-amber-400/40',
          }
        : {
            text: 'Choose by convenience',
            tone: 'bg-slate-100 text-slate-700 ring-slate-400/40 dark:bg-slate-700/60 dark:text-slate-200 dark:ring-slate-500/40',
          };

  const minutes = bestTrip?.durationMin ?? baselineTrip?.durationMin ?? 0;

  // Prefer the REAL router numbers; fall back to the engine estimate, clearly
  // marked with "~" so an estimate is never read as a measurement.
  const shownId = comparison.bestRouteId || comparison.baselineRouteId;
  const facts = routeFactsText({
    real: props.realMetrics?.[shownId] ?? null,
    estimatedMinutes: minutes,
  });

  return (
    <div
      className={`${GLASS_CARD} ${OVERLAY_Z} pointer-events-auto absolute bottom-4 left-4 w-[min(22rem,calc(100vw-2rem))] p-4 ${
        props.collapsed ? 'max-sm:w-[min(22rem,calc(100vw-2rem))]' : ''
      }`}
    >
      <button
        type="button"
        onClick={props.onToggleCollapsed}
        aria-expanded={!props.collapsed}
        className={`${FOCUS_RING} absolute -top-3 right-3 rounded-full bg-white/90 p-1 text-slate-600 shadow-sm ring-1 ring-slate-300 hover:bg-white dark:bg-slate-800/90 dark:text-slate-200 dark:ring-slate-600 sm:hidden`}
        aria-label={props.collapsed ? 'Expand result' : 'Collapse result'}
      >
        <ChevronUp
          size={14}
          aria-hidden
          className={`${MOTION} ${props.collapsed ? 'rotate-180' : ''}`}
        />
      </button>

      <h2 className="text-base font-semibold tracking-tight text-slate-900 dark:text-slate-100">
        {headline}
      </h2>

      <div className="mt-2 flex flex-wrap items-center gap-2">
        <span className={`${badge.tone} rounded-full px-2.5 py-1 text-xs font-semibold border`}>
          {badge.text}
        </span>
        {verdict !== 'none' && facts && (
          <span className="text-xs font-medium text-slate-600 dark:text-slate-300">{facts}</span>
        )}
      </div>

      {verdict === 'slight' && (
        <p className="mt-1.5 text-xs text-amber-700 dark:text-amber-300">Low confidence — the difference is small.</p>
      )}

      {verdict === 'none' && (
        <p className="mt-1.5 text-xs text-slate-600 dark:text-slate-300">
          The model does not see a meaningful difference between these options.
        </p>
      )}

      {props.bestTimeHint && verdict === 'recommend' && (
        <p className="mt-1.5 text-xs text-slate-600 dark:text-slate-300">{props.bestTimeHint}</p>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={props.onOpenBreakdown}
          className={`${FOCUS_RING} ${MOTION} ${ACCENT.bg} ${ACCENT.text} flex ${TOUCH_TARGET} items-center gap-1.5 rounded-xl px-3 py-2 text-xs font-semibold`}
        >
          <Info size={14} aria-hidden />
          View Scientific Breakdown
        </button>

        <button
          type="button"
          onClick={props.onAddEvidence}
          title="Add a haze photo"
          aria-label="Add a haze photo"
          className={`${FOCUS_RING} ${MOTION} ${TOUCH_TARGET} rounded-xl bg-white p-2 text-slate-700 ring-1 ring-slate-300 hover:bg-white dark:bg-slate-800 dark:text-slate-200 dark:ring-slate-600`}
        >
          <Camera size={16} aria-hidden />
        </button>
        <button
          type="button"
          onClick={props.onOpenEvidence}
          title="Report smoke or dust"
          aria-label="Report smoke or dust"
          className={`${FOCUS_RING} ${MOTION} ${TOUCH_TARGET} rounded-xl bg-white p-2 text-slate-700 ring-1 ring-slate-300 hover:bg-white dark:bg-slate-800 dark:text-slate-200 dark:ring-slate-600`}
        >
          <MessageSquarePlus size={16} aria-hidden />
        </button>
      </div>
    </div>
  );
}
