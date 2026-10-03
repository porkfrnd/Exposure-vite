/**
 * School activity window modal.
 */

import { useEffect, useState } from 'react';
import { GraduationCap, X } from 'lucide-react';
import { engine, dataApi } from '../wiring';
import { FOCUS_RING, GLASS_CARD, MOTION, NUMBERS, OVERLAY_Z_MODAL } from '../design';
import { formatLocalTime } from '../wiring';
import type { Forecast, Segment } from '@/contracts';

export function SchoolModal({
  open,
  onClose,
  forecast,
  segments,
}: {
  open: boolean;
  onClose: () => void;
  forecast: Forecast | null;
  segments: Segment[];
}) {
  const [activity, setActivity] = useState<'outdoor' | 'indoor'>('outdoor');
  const [result, setResult] = useState<{
    hours: { timeISO: string; exposureIndex: number; confidence: number }[];
    bestWindow: { startISO: string; endISO: string } | null;
    message: string;
  } | null>(null);

  const schoolSeg = dataApi.getDemoSchool().segment;

  useEffect(() => {
    if (open && forecast && schoolSeg) {
      const out = engine.schoolWindow(schoolSeg, getNPTDayStartISO(), activity, {
        forecast,
        corrections: undefined,
      });
      setResult(out);
    }
  }, [open, forecast, activity]);

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
      <button type="button" aria-label="Close" onClick={onClose} className="absolute inset-0 bg-slate-900/30" />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="School activity window"
        className="relative w-full max-w-md overflow-y-auto max-h-[92dvh] rounded-t-2xl bg-white/95 p-4 shadow-2xl ring-1 ring-slate-300 dark:bg-slate-900/95 dark:ring-slate-600"
      >
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100 flex items-center gap-1.5">
            <GraduationCap size={16} aria-hidden />
            School activity window
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded-lg p-1.5 text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800"
          >
            <X size={16} aria-hidden />
          </button>
        </div>

        <p className="mt-1.5 text-xs leading-relaxed text-slate-600 dark:text-slate-300">
          Shows modeled exposure at the school location through the Nepal school day (06:00–17:00 NPT).
          <em className="font-medium">Not a safety judgement.</em>
        </p>

        {/* Indoor/Outdoor toggle */}
        <div className="mt-3 grid grid-cols-2 gap-1.5">
          <button
            type="button"
            onClick={() => setActivity('outdoor')}
            aria-pressed={activity === 'outdoor'}
            className={`rounded-xl px-2 py-2 text-[11px] font-semibold ring-1 ${
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
            className={`rounded-xl px-2 py-2 text-[11px] font-semibold ring-1 ${
              activity === 'indoor'
                ? 'bg-emerald-50 text-emerald-800 ring-emerald-500/40 dark:bg-emerald-500/15 dark:text-emerald-300'
                : 'bg-white text-slate-700 ring-slate-300 dark:bg-slate-900 dark:text-slate-200 dark:ring-slate-600'
            }`}
          >
            Indoor (classroom)
          </button>
        </div>

        {/* Hour strip */}
        {result && (
          <div className="mt-3 rounded-xl bg-slate-100/80 p-3 dark:bg-slate-800/60">
            <h3 className="text-xs font-semibold text-slate-700 dark:text-slate-200 mb-2">
              School hours 06:00–17:00 NPT
            </h3>
            <div className="flex overflow-x-auto gap-1 pb-1">
              {result.hours.map((h, i) => {
                const isBest = result.bestWindow &&
                  h.timeISO >= result.bestWindow.startISO &&
                  h.timeISO < result.bestWindow.endISO;
                return (
                  <div
                    key={i}
                    className={`flex-shrink-0 flex flex-col items-center gap-0.5 px-1.5 py-2 rounded-lg ${
                      isBest
                        ? 'bg-emerald-100 ring-2 ring-emerald-500 dark:bg-emerald-500/20'
                        : 'bg-white/80 ring-1 ring-slate-300 dark:bg-slate-800 dark:ring-slate-600'
                    }`}
                    style={{ minWidth: 48 }}
                  >
                    <span className="text-[10px] font-semibold text-slate-600 dark:text-slate-300">
                      {formatLocalTime(h.timeISO).replace(' NPT', '')}
                    </span>
                    <span className={`${NUMBERS} text-xs font-semibold ${
                      isBest ? 'text-emerald-800' : 'text-slate-800 dark:text-slate-100'
                    }`}>
                      {h.exposureIndex.toFixed(1)}
                    </span>
                    <span className="text-[9px] text-slate-500 dark:text-slate-400">
                      {Math.round(h.confidence * 100)}%
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
          Indoor values are scaled by the assumed school infiltration factor (0.6). This is a modeled
          estimate, not a safety judgement.
        </p>
      </div>
    </div>
  );
}