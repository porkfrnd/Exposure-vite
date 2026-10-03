/**
 * Destination activity window.
 *
 * Scores modeled exposure AT THE USER'S ACTUAL DESTINATION through the Nepal
 * school day (06:00–17:00 NPT). The scored segment is the real route segment whose
 * midpoint is nearest the destination — real geometry, no invented school pin.
 */

import { useEffect, useMemo, useState } from 'react';
import { GraduationCap, X } from 'lucide-react';
import { engine, formatLocalTime } from '../wiring';
import type { Place } from '../wiring';
import { distanceToPolylineM } from '@/data/geo';
import { FOCUS_RING, NUMBERS, OVERLAY_Z_MODAL } from '../design';
import type { Forecast, Segment } from '@/contracts';

export function SchoolModal({
  open,
  onClose,
  forecast,
  segments,
  destination,
}: {
  open: boolean;
  onClose: () => void;
  forecast: Forecast | null;
  segments: Segment[];
  destination: Place | null;
}) {
  const [activity, setActivity] = useState<'outdoor' | 'indoor'>('outdoor');
  const [result, setResult] = useState<{
    hours: { timeISO: string; exposureIndex: number; confidence: number }[];
    bestWindow: { startISO: string; endISO: string } | null;
    message: string;
  } | null>(null);

  // The real segment nearest the user's destination.
  const schoolSeg = useMemo<Segment | null>(() => {
    if (!destination || segments.length === 0) return null;
    let best: Segment | null = null;
    let bestD = Number.POSITIVE_INFINITY;
    for (const s of segments) {
      const d = distanceToPolylineM(destination, s.coords);
      if (d < bestD) {
        bestD = d;
        best = s;
      }
    }
    return best;
  }, [destination, segments]);

  useEffect(() => {
    if (open && forecast && schoolSeg) {
      const out = engine.schoolWindow(schoolSeg, getNPTDayStartISO(), activity, {
        forecast,
        corrections: undefined,
      });
      setResult(out);
    } else {
      setResult(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, forecast, activity, schoolSeg]);

  function getNPTDayStartISO(): string {
    const now = new Date();
    const nptOffset = 345 * 60000;
    const nptNow = new Date(now.getTime() + nptOffset);
    nptNow.setUTCHours(0, 0, 0, 0);
    return new Date(nptNow.getTime() - nptOffset).toISOString().replace(/\.\d{3}Z$/, 'Z');
  }

  if (!open) return null;

  return (
    <div className={`${OVERLAY_Z_MODAL} fixed inset-0 flex items-end justify-center sm:items-center`}>
      <button
        type="button"
        aria-label="Close"
        onClick={onClose}
        className="absolute inset-0 bg-slate-900/30"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Destination activity window"
        className="relative max-h-[92dvh] w-full max-w-md overflow-y-auto rounded-2xl bg-white/95 p-4 shadow-xl ring-1 ring-slate-300 dark:bg-slate-900/95 dark:ring-slate-600"
      >
        <div className="flex items-center justify-between gap-2">
          <h2 className="flex items-center gap-1.5 text-sm font-semibold text-slate-900 dark:text-slate-100">
            <GraduationCap size={16} aria-hidden />
            Activity window at your destination
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className={`${FOCUS_RING} rounded-lg p-1.5 text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800`}
          >
            <X size={16} aria-hidden />
          </button>
        </div>

        {destination && (
          <p className="mt-1.5 text-xs text-slate-600 dark:text-slate-300">
            {destination.name} · Nepal school day 06:00–17:00 NPT.{' '}
            <em className="font-medium">Not a safety judgement.</em>
          </p>
        )}

        <div className="mt-3 grid grid-cols-2 gap-1.5">
          <button
            type="button"
            onClick={() => setActivity('outdoor')}
            aria-pressed={activity === 'outdoor'}
            className={`${FOCUS_RING} rounded-lg px-2 py-2 text-[11px] font-semibold ring-1 ${
              activity === 'outdoor'
                ? 'bg-emerald-50 text-emerald-800 ring-emerald-500/40 dark:bg-emerald-500/15 dark:text-emerald-300'
                : 'bg-white text-slate-700 ring-slate-300 dark:bg-slate-900 dark:text-slate-200 dark:ring-slate-600'
            }`}
          >
            Outdoor (assembly/PE)
          </button>
          <button
            type="button"
            onClick={() => setActivity('indoor')}
            aria-pressed={activity === 'indoor'}
            className={`${FOCUS_RING} rounded-lg px-2 py-2 text-[11px] font-semibold ring-1 ${
              activity === 'indoor'
                ? 'bg-emerald-50 text-emerald-800 ring-emerald-500/40 dark:bg-emerald-500/15 dark:text-emerald-300'
                : 'bg-white text-slate-700 ring-slate-300 dark:bg-slate-900 dark:text-slate-200 dark:ring-slate-600'
            }`}
          >
            Indoor (classroom)
          </button>
        </div>

        {result && (
          <div className="mt-3 rounded-xl bg-slate-100/80 p-3 dark:bg-slate-800/60">
            <div className="flex gap-1 overflow-x-auto pb-1">
              {result.hours.map((h, i) => {
                const isBest =
                  result.bestWindow &&
                  h.timeISO >= result.bestWindow.startISO &&
                  h.timeISO < result.bestWindow.endISO;
                return (
                  <div
                    key={i}
                    className={`flex min-w-[48px] shrink-0 flex-col items-center gap-0.5 rounded-lg px-1.5 py-2 ${
                      isBest
                        ? 'bg-emerald-100 ring-2 ring-emerald-500 dark:bg-emerald-500/20'
                        : 'bg-white/80 ring-1 ring-slate-300 dark:bg-slate-800 dark:ring-slate-600'
                    }`}
                  >
                    <span className="text-[10px] font-semibold text-slate-600 dark:text-slate-300">
                      {formatLocalTime(h.timeISO).replace(' NPT', '')}
                    </span>
                    <span
                      className={`${NUMBERS} text-xs font-semibold ${
                        isBest ? 'text-emerald-800' : 'text-slate-800 dark:text-slate-100'
                      }`}
                    >
                      {h.exposureIndex.toFixed(1)}
                    </span>
                  </div>
                );
              })}
            </div>
            {result.bestWindow && (
              <p className="mt-2 text-[11px] font-medium text-emerald-700 dark:text-emerald-300">
                {result.message}
              </p>
            )}
          </div>
        )}

        <p className="mt-3 text-[11px] text-slate-500 dark:text-slate-400">
          Values are modeled concentrations in µg/m³ at the nearest real route segment to your
          destination. Indoor values are scaled by the assumed infiltration factor (0.6).
        </p>
      </div>
    </div>
  );
}