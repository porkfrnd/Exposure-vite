/**
 * Diary modal: save a real planned commute, weekly bar chart. Every entry is the
 * user's own real trip — there are no seeded or simulated entries.
 */

import { useEffect, useState } from 'react';
import { BookOpen, Calendar, Trash2, X } from 'lucide-react';
import { dataApi } from '../wiring';
import { FOCUS_RING, GLASS_CARD, MOTION, NUMBERS, OVERLAY_Z_MODAL } from '../design';
import { formatLocalTime } from '../wiring';
import type { Comparison, Forecast, Mode, Route } from '@/contracts';

const DIARY_KEY = 'exposure-vite:diary:v1';

interface DiaryEntry {
  id: string;
  timestamp: number; // when saved
  departISO: string;
  mode: Mode;
  routeId: string;
  baselineRouteId: string;
  doseUg: number;
  durationMin: number;
  comparison: Comparison;
}

function loadDiary(): DiaryEntry[] {
  try {
    const raw = localStorage.getItem(DIARY_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveDiary(entries: DiaryEntry[]): void {
  try {
    localStorage.setItem(DIARY_KEY, JSON.stringify(entries));
  } catch {
    // quota exceeded or storage disabled
  }
}

function getWeekBounds(ts: number): { start: number; end: number } {
  // Nepal week: Sunday = 0
  const d = new Date(ts + 345 * 60000);
  d.setUTCHours(0, 0, 0, 0);
  const start = d.getTime() - d.getUTCDay() * 86_400_000;
  return { start, end: start + 7 * 86_400_000 };
}

function formatWeekday(ts: number): string {
  const d = new Date(ts + 345 * 60000);
  return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getUTCDay()];
}

function formatWeekRange(start: number): string {
  const end = start + 6 * 86_400_000;
  const s = new Date(start).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  const e = new Date(end).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  return `${s} – ${e}`;
}

export function DiaryModal({
  open,
  onClose,
  routes,
  mode,
  baselineRouteId,
  comparison,
  forecast,
  departISO,
  onToast,
}: {
  open: boolean;
  onClose: () => void;
  routes: Route[];
  mode: Mode;
  baselineRouteId: string;
  comparison: Comparison | null;
  forecast: Forecast | null;
  departISO: string;
  onToast: (msg: string) => void;
}) {
  const [entries, setEntries] = useState<DiaryEntry[]>(() => loadDiary());

  useEffect(() => {
    if (open) setEntries(loadDiary());
  }, [open]);

  const saveCurrent = () => {
    if (!comparison) return;
    const trip = comparison.trips.find((t) => t.routeId === (comparison.bestRouteId ?? null));
    if (!trip) return;
    const entry: DiaryEntry = {
      id: `entry-${Date.now().toString(36)}`,
      timestamp: Date.now(),
      departISO,
      mode,
      routeId: trip.routeId,
      baselineRouteId,
      doseUg: trip.doseUg,
      durationMin: trip.durationMin,
      comparison,
    };
    setEntries((prev) => {
      const next = [entry, ...prev];
      saveDiary(next);
      return next;
    });
    onToast('Commute saved to diary.');
  };

  const deleteEntry = (id: string) => {
    setEntries((prev) => {
      const next = prev.filter((e) => e.id !== id);
      saveDiary(next);
      return next;
    });
  };

  // Weekly chart data
  const weekBounds = getWeekBounds(Date.now());
  const weeklyData = Array.from({ length: 7 }, (_, i) => {
    const dayStart = weekBounds.start + i * 86_400_000;
    const dayEntries = entries.filter((e) => e.timestamp >= dayStart && e.timestamp < dayStart + 86_400_000);
    const total = dayEntries.reduce((s, e) => s + e.doseUg, 0);
    return { label: formatWeekday(dayStart + 86_400_000), dose: Math.round(total) };
  });
  const maxDose = Math.max(...weeklyData.map((d) => d.dose), 1);

  // Entries list (extracted to avoid JSX parser confusion with complex conditionals)
  const entriesList = entries.length === 0 ? (
    <p className="text-center text-slate-500 dark:text-slate-400 py-4 text-sm">
      No entries yet. Plan a commute and save it to build your week.
    </p>
  ) : (
    <ul className="space-y-2">
      {entries.map((e) => (
        <li
          key={e.id}
          className={`rounded-xl p-2.5 ring-1 ${
            'bg-white dark:bg-slate-800 ring-slate-300'
          }`}
        >
          <div className="flex items-start justify-between gap-2">
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-1.5 text-xs">
                <span className="font-medium text-slate-800 dark:text-slate-100">
                  {formatLocalTime(e.departISO).replace(' NPT', '')}
                </span>
                <span className="text-slate-500 dark:text-slate-400">
                  {e.mode === 'walk' ? '🚶' : e.mode === 'cycle' ? '🚲' : '🚌'}
                </span>
              </div>
              <div className="flex flex-wrap gap-1 mt-0.5 text-[10px] text-slate-600 dark:text-slate-300">
                <span>Route: {e.routeId}</span>
                <span>Baseline: {e.baselineRouteId}</span>
              </div>
              <div className="mt-1 flex items-center gap-2 text-xs font-semibold text-slate-800 dark:text-slate-100">
                <span>{e.doseUg.toFixed(1)} µg</span>
                <span>~{Math.round(e.durationMin)} min</span>
              </div>
            </div>
            <button
              type="button"
              onClick={() => deleteEntry(e.id)}
              aria-label="Delete entry"
              className="shrink-0 rounded p-1 text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-700"
            >
              <Trash2 size={12} aria-hidden />
            </button>
          </div>
        </li>
      ))}
    </ul>
  );

  if (!open) return null;

  return (
    <div className={`${OVERLAY_Z_MODAL} fixed inset-0 flex items-end justify-center sm:items-center`}>
      <button type="button" aria-label="Close" onClick={onClose} className="absolute inset-0 bg-slate-900/30" />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Diary"
        className="relative w-full max-w-md overflow-y-auto max-h-[92dvh] rounded-t-xl bg-white p-4 border border-slate-200 dark:bg-slate-900 dark:border-slate-700"
      >
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100 flex items-center gap-1.5">
            <BookOpen size={16} aria-hidden />
            My diary
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
          Your saved commutes. Data lives on this device only.
        </p>

        {/* Weekly chart */}
        <div className="mt-3 rounded-xl bg-slate-100/80 p-3 dark:bg-slate-800/60">
          <h3 className="text-xs font-semibold text-slate-700 dark:text-slate-200 mb-2">
            This week ({formatWeekRange(weekBounds.start)})
          </h3>
          <div className="h-28 flex items-end justify-around gap-1">
            {weeklyData.map((d, i) => (
              <div key={i} className="flex flex-col items-center flex-1">
                <div
                  className="w-full bg-emerald-600 rounded-t transition-all duration-300"
                  style={{ height: `${(d.dose / maxDose) * 100}%` }}
                  title={`${d.label}: ${d.dose} µg`}
                />
                <span className="mt-1 text-[10px] text-slate-600 dark:text-slate-300">{d.label}</span>
              </div>
            ))}
          </div>
          <p className="mt-1.5 text-[11px] text-slate-500 dark:text-slate-400">
            Bars show total modeled dose per Nepal day, from your own saved commutes.
          </p>
        </div>

{/* Entries list */}
        <div className="mt-3 max-h-[40vh] overflow-y-auto">
          {entriesList}
        </div>

        {/* Actions */}
        <div className="mt-3 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={saveCurrent}
            disabled={!comparison}
            className={`flex-1 ${MOTION} ${NUMBERS} rounded-xl px-3 py-2 text-xs font-semibold ${
              comparison ? 'bg-emerald-600 text-white hover:bg-emerald-500' : 'bg-slate-200 text-slate-400 cursor-not-allowed'
            }`}
          >
            <Calendar size={12} aria-hidden />
            Save this commute
          </button>
        </div>
      </div>
    </div>
  );
}