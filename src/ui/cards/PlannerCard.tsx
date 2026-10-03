/**
 * Floating planner card (top-left).
 *
 * FIRST-SCREEN RULE: no technical jargon here. A first-time user answers two
 * questions — where am I going, and how — and can leave the time for the slider.
 * All model internals live behind "View Scientific Breakdown".
 */

import { useMemo, useState } from 'react';
import { Bike, Bus, ChevronDown, ChevronUp, Footprints, MapPin, Clock3 } from 'lucide-react';
import { ACCENT, FOCUS_RING, GLASS_CARD, MOTION, NUMBERS, OVERLAY_Z, TOUCH_TARGET } from '../design';
import { DEPARTURE_OFFSETS } from '../state/useExposureModel';
import type { Mode, Route } from '@/contracts';

export interface PlannerCardProps {
  routes: Route[];
  mode: Mode;
  onModeChange: (m: Mode) => void;
  baselineRouteId: string;
  onBaselineChange: (id: string) => void;
  offsetMin: number;
  onOffsetChange: (n: number) => void;
  /** "4:15 PM NPT" for the current selection. */
  departureLabel: string;
  /** "Leave now" or "Leave in 30 min". */
  departureShort: string;
  busy: boolean;
}

const MODES: Array<{ id: Mode; label: string; Icon: typeof Footprints }> = [
  { id: 'walk', label: 'Walk', Icon: Footprints },
  { id: 'cycle', label: 'Cycle', Icon: Bike },
  { id: 'bus', label: 'Bus', Icon: Bus },
];

export function PlannerCard(props: PlannerCardProps) {
  const [expanded, setExpanded] = useState(false);
  const [destination, setDestination] = useState(props.routes[0]?.name ?? '');
  const [showRoutePicker, setShowRoutePicker] = useState(false);

  const destinationOptions = useMemo(() => props.routes.map((r) => r.name), [props.routes]);

  const unsupported = destination.trim() !== '' && !destinationOptions.includes(destination.trim());

  return (
    <div
      // Positioned BELOW the honesty pill + source badge strip so the two can never
      // overlap at any width.
      className={`${GLASS_CARD} ${OVERLAY_Z} pointer-events-auto absolute left-3 top-[4.5rem] w-[min(21rem,calc(100vw-1.5rem))] p-3 sm:left-4`}
    >
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <h1 className="text-sm font-semibold tracking-tight text-slate-900 dark:text-slate-100">
            Where are you going?
          </h1>

          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            aria-expanded={expanded}
            className={`${FOCUS_RING} ${MOTION} mt-2 flex w-full ${TOUCH_TARGET} items-center gap-2 rounded-xl bg-slate-100/80 px-2.5 py-2 text-left text-sm font-medium text-slate-800 hover:bg-slate-200/80 dark:bg-slate-800/70 dark:text-slate-100 dark:hover:bg-slate-700/70`}
          >
            <MapPin size={16} className="shrink-0 text-emerald-600 dark:text-emerald-400" aria-hidden />
            <span className="min-w-0 flex-1 truncate">{destination || 'Choose a destination'}</span>
            {expanded ? (
              <ChevronUp size={16} className="shrink-0 opacity-60" aria-hidden />
            ) : (
              <ChevronDown size={16} className="shrink-0 opacity-60" aria-hidden />
            )}
          </button>
        </div>
      </div>

      {expanded && (
        <div className="mt-2">
          <label className="sr-only" htmlFor="destination-input">
            Destination
          </label>
          <input
            id="destination-input"
            list="destination-options"
            value={destination}
            onChange={(e) => setDestination(e.target.value)}
            placeholder="Type a destination"
            className={`${FOCUS_RING} w-full rounded-lg bg-white/70 px-2.5 py-2 text-sm text-slate-900 ring-1 ring-slate-300 placeholder:text-slate-400 dark:bg-slate-800/70 dark:text-slate-100 dark:ring-slate-600`}
          />
          <datalist id="destination-options">
            {destinationOptions.map((name) => (
              <option key={name} value={name} />
            ))}
          </datalist>

          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {destinationOptions.map((name) => (
              <button
                key={name}
                type="button"
                onClick={() => setDestination(name)}
                className={`${FOCUS_RING} ${MOTION} rounded-full px-2.5 py-1 text-xs font-medium ring-1 ${
                  destination === name
                    ? `${ACCENT.soft} ${ACCENT.border}`
                    : 'bg-white/60 text-slate-700 ring-slate-300 hover:bg-white dark:bg-slate-800/70 dark:text-slate-200 dark:ring-slate-600'
                }`}
              >
                {name}
              </button>
            ))}
          </div>

          {unsupported && (
            <p className="mt-1.5 text-xs text-amber-700 dark:text-amber-300">
              Only demo routes are available in this prototype.
            </p>
          )}
        </div>
      )}

      {/* Mode segmented control */}
      <div
        className="mt-3 grid grid-cols-3 gap-1 rounded-xl bg-slate-100/80 p-1 dark:bg-slate-800/70"
        role="group"
        aria-label="Travel mode"
      >
        {MODES.map(({ id, label, Icon }) => {
          const active = props.mode === id;
          return (
            <button
              key={id}
              type="button"
              onClick={() => props.onModeChange(id)}
              aria-pressed={active}
              className={`${FOCUS_RING} ${MOTION} flex items-center justify-center gap-1.5 rounded-lg px-2 py-2 text-xs font-semibold ${
                active
                  ? 'bg-white text-emerald-700 shadow-sm dark:bg-slate-900 dark:text-emerald-300'
                  : 'text-slate-600 hover:text-slate-900 dark:text-slate-300 dark:hover:text-white'
              }`}
            >
              <Icon size={15} aria-hidden />
              {label}
            </button>
          );
        })}
      </div>

      {/* Departure */}
      <div className="mt-3">
        <div className="flex items-baseline justify-between gap-2">
          <span className="flex items-center gap-1.5 text-xs font-medium text-slate-600 dark:text-slate-300">
            <Clock3 size={13} aria-hidden />
            {props.departureShort}
          </span>
          <span className={`${NUMBERS} text-xs font-semibold text-slate-800 dark:text-slate-100`}>
            {props.departureLabel}
          </span>
        </div>
        <input
          type="range"
          min={0}
          max={DEPARTURE_OFFSETS.length - 1}
          step={1}
          value={DEPARTURE_OFFSETS.indexOf(props.offsetMin) === -1 ? 0 : DEPARTURE_OFFSETS.indexOf(props.offsetMin)}
          onChange={(e) => {
            const idx = Number(e.target.value);
            const next = DEPARTURE_OFFSETS[idx];
            if (next !== undefined) props.onOffsetChange(next);
          }}
          aria-label="Departure time"
          aria-valuetext={props.departureLabel}
          className="mt-1.5 w-full accent-emerald-600"
        />
        <div className="mt-0.5 flex justify-between text-[10px] text-slate-500 dark:text-slate-400">
          <span>Now</span>
          <span>+3 h</span>
        </div>
      </div>

      {/* Usual route — deliberately secondary */}
      <div className="mt-3 border-t border-slate-200/70 pt-2 dark:border-slate-700/70">
        <button
          type="button"
          onClick={() => setShowRoutePicker((v) => !v)}
          aria-expanded={showRoutePicker}
          className={`${FOCUS_RING} ${MOTION} flex w-full items-center justify-between gap-2 text-xs text-slate-600 hover:text-slate-900 dark:text-slate-300 dark:hover:text-white`}
        >
          <span>
            Usual route:{' '}
            <span className="font-medium text-slate-800 dark:text-slate-100">
              {props.routes.find((r) => r.id === props.baselineRouteId)?.name ?? '—'}
            </span>
          </span>
          {showRoutePicker ? (
            <ChevronUp size={14} aria-hidden />
          ) : (
            <ChevronDown size={14} aria-hidden />
          )}
        </button>

        {showRoutePicker && (
          <div className="mt-1.5 grid gap-1">
            {props.routes.map((route) => (
              <button
                key={route.id}
                type="button"
                onClick={() => props.onBaselineChange(route.id)}
                aria-pressed={route.id === props.baselineRouteId}
                className={`${FOCUS_RING} ${MOTION} rounded-lg px-2 py-1.5 text-left text-xs ring-1 ${
                  route.id === props.baselineRouteId
                    ? `${ACCENT.soft} ${ACCENT.border} font-semibold`
                    : 'bg-white/60 text-slate-700 ring-slate-300 hover:bg-white dark:bg-slate-800/70 dark:text-slate-200 dark:ring-slate-600'
                }`}
              >
                {route.name}
              </button>
            ))}
          </div>
        )}
      </div>

      {props.busy && (
        <p className="mt-2 text-[11px] text-slate-500 dark:text-slate-400" role="status">
          Updating…
        </p>
      )}
    </div>
  );
}