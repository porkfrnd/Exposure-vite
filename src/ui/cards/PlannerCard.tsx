/**
 * Floating planner card.
 *
 * FIRST-SCREEN RULE: no technical jargon here. The user answers two questions —
 * where am I going, and how — and can leave the time for the slider.
 *
 * Every place shown here comes from live Photon search or the device's real GPS
 * fix. Nothing is a canned suggestion.
 */

import { useEffect, useRef, useState } from 'react';
import {
  Bike,
  Bus,
  ChevronDown,
  ChevronUp,
  Crosshair,
  Footprints,
  Loader2,
  LocateFixed,
  MapPin,
  Navigation,
  RefreshCw,
  Search,
  ArrowDownUp,
} from 'lucide-react';
import { FOCUS_RING, MOTION, NUMBERS, OVERLAY_Z, TOUCH_TARGET } from '../design';
import { realApi } from '../wiring';
import type { Place } from '../wiring';
import { DEPARTURE_OFFSETS } from '../state/useExposureModel';
import type { LatLon, Mode, Route } from '@/contracts';

export interface PlannerCardProps {
  routes: Route[];
  origin: Place | null;
  destination: Place | null;
  onOriginChange: (p: Place | null) => void;
  onDestinationChange: (p: Place | null) => void;
  onUseMyLocation: () => void;
  locating: boolean;
  onSwap: () => void;
  mode: Mode;
  onModeChange: (m: Mode) => void;
  offsetMin: number;
  onOffsetChange: (n: number) => void;
  baselineRouteId: string;
  onBaselineChange: (id: string) => void;
  departureLabel: string;
  departureShort: string;
  routing: boolean;
  error: string | null;
  onRetry: () => void;
}

const MODES: Array<{ id: Mode; label: string; Icon: typeof Footprints }> = [
  { id: 'walk', label: 'Walk', Icon: Footprints },
  { id: 'cycle', label: 'Cycle', Icon: Bike },
  { id: 'bus', label: 'Bus', Icon: Bus },
];

const INPUT =
  'w-full rounded-lg bg-white/80 px-2.5 py-2 text-sm text-slate-900 ring-1 ring-slate-300 ' +
  'placeholder:text-slate-400 dark:bg-slate-800/80 dark:text-slate-100 dark:ring-slate-600 dark:placeholder:text-slate-500';

/** One live place-search box. Results come from Photon; nothing is canned. */
function PlaceSearch({
  label,
  placeholder,
  value,
  onPick,
  onClear,
  onUseLocation,
  icon,
  busy,
}: {
  label: string;
  placeholder: string;
  value: Place | null;
  onPick: (p: Place) => void;
  onClear: () => void;
  onUseLocation?: () => void;
  icon: React.ReactNode;
  busy: boolean;
}) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Place[]>([]);
  const [searching, setSearching] = useState(false);
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  // Debounced live search. Nothing is fetched until the user types 2+ characters.
  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) {
      setResults([]);
      return;
    }
    const timer = window.setTimeout(async () => {
      abortRef.current?.abort();
      const ctrl = new AbortController();
      abortRef.current = ctrl;
      setSearching(true);
      try {
        const found = await realApi.search(q, ctrl.signal);
        if (!ctrl.signal.aborted) setResults(found);
      } catch {
        if (!ctrl.signal.aborted) setResults([]);
      } finally {
        if (!ctrl.signal.aborted) setSearching(false);
      }
    }, 280);
    return () => window.clearTimeout(timer);
  }, [query]);

  // Close the result list when clicking away.
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, []);

  const shown = value ? `${value.name} — ${value.detail}` : '';

  return (
    <div ref={boxRef} className="relative">
      <label className="mb-1 block text-[11px] font-medium text-slate-600 dark:text-slate-300">
        {label}
      </label>

      {value ? (
        <div
          className={`flex items-center gap-2 rounded-lg bg-white/80 px-2.5 py-2 text-sm ring-1 ring-slate-300 dark:bg-slate-800/80 dark:ring-slate-600 ${busy ? 'opacity-60' : ''}`}
        >
          <span className="shrink-0 text-emerald-600 dark:text-emerald-400">{icon}</span>
          <span className="min-w-0 flex-1 truncate text-slate-900 dark:text-slate-100" title={shown}>
            {value.name}
          </span>
          {onUseLocation && (
            <button
              type="button"
              onClick={onUseLocation}
              title="Use my current location"
              aria-label={`Use my current location for ${label}`}
              className={`${FOCUS_RING} shrink-0 rounded p-1 text-slate-500 hover:text-slate-900 dark:hover:text-white`}
            >
              <Crosshair size={14} aria-hidden />
            </button>
          )}
          <button
            type="button"
            onClick={onClear}
            title="Change"
            aria-label={`Change ${label}`}
            className={`${FOCUS_RING} shrink-0 rounded px-1 text-[11px] font-semibold text-emerald-700 hover:text-emerald-800 dark:text-emerald-400 dark:hover:text-emerald-300`}
          >
            Change
          </button>
        </div>
      ) : (
        <div className="relative">
          <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-emerald-600 dark:text-emerald-400">
            {icon}
          </span>
          <input
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setOpen(true);
            }}
            onFocus={() => setOpen(true)}
            placeholder={placeholder}
            className={`${FOCUS_RING} ${INPUT} pl-8`}
            autoComplete="off"
            role="combobox"
            aria-expanded={open && results.length > 0}
            aria-label={label}
          />
          {searching && (
            <Loader2
              size={14}
              className="absolute right-2.5 top-1/2 -translate-y-1/2 animate-spin text-slate-400"
              aria-hidden
            />
          )}

          {open && results.length > 0 && (
            <ul className="absolute z-20 mt-1 max-h-56 w-full overflow-y-auto rounded-lg bg-white/95 py-1 shadow-lg ring-1 ring-slate-300 dark:bg-slate-800/95 dark:ring-slate-600">
              {results.map((p) => (
                <li key={p.id}>
                  <button
                    type="button"
                    onClick={() => {
                      onPick(p);
                      setQuery('');
                      setResults([]);
                      setOpen(false);
                    }}
                    className={`${MOTION} block w-full px-2.5 py-1.5 text-left hover:bg-slate-100 dark:hover:bg-slate-700/60`}
                  >
                    <span className="block truncate text-sm text-slate-900 dark:text-slate-100">
                      {p.name}
                    </span>
                    <span className="block truncate text-[11px] text-slate-500 dark:text-slate-400">
                      {p.detail}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

export function PlannerCard(props: PlannerCardProps) {
  const [expanded, setExpanded] = useState(false);
  const hasTrip = props.origin !== null && props.destination !== null;

  return (
    <div
      className={`${OVERLAY_Z} pointer-events-auto absolute left-3 top-[4.5rem] w-[min(23rem,calc(100vw-1.5rem))] rounded-2xl bg-white/90 p-3 shadow-lg ring-1 ring-slate-300 backdrop-blur dark:bg-slate-900/90 dark:ring-slate-600 sm:left-4`}
    >
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        className={`${FOCUS_RING} ${MOTION} flex w-full items-center gap-2 text-left`}
      >
        <Navigation size={15} className="shrink-0 text-emerald-600 dark:text-emerald-400" aria-hidden />
        <span className="min-w-0 flex-1 text-sm font-semibold text-slate-900 dark:text-slate-100">
          {hasTrip ? `${props.origin!.name} → ${props.destination!.name}` : 'Where are you going?'}
        </span>
        {expanded ? (
          <ChevronUp size={15} className="shrink-0 text-slate-500" aria-hidden />
        ) : (
          <ChevronDown size={15} className="shrink-0 text-slate-500" aria-hidden />
        )}
      </button>

      {expanded && (
        <div className="mt-3 space-y-2.5">
          <PlaceSearch
            label="From"
            placeholder="Your place, or search"
            value={props.origin}
            onPick={props.onOriginChange}
            onClear={() => props.onOriginChange(null)}
            onUseLocation={props.onUseMyLocation}
            icon={<MapPin size={14} aria-hidden />}
            busy={props.locating}
          />

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={props.onSwap}
              disabled={!hasTrip}
              title="Swap origin and destination"
              aria-label="Swap origin and destination"
              className={`${FOCUS_RING} ${MOTION} shrink-0 rounded-lg p-1.5 text-slate-600 ring-1 ring-slate-300 hover:bg-slate-100 disabled:opacity-40 dark:text-slate-300 dark:ring-slate-600 dark:hover:bg-slate-700`}
            >
              <ArrowDownUp size={14} aria-hidden />
            </button>
            <div className="flex-1">
              <PlaceSearch
                label="To"
                placeholder="Search a destination"
                value={props.destination}
                onPick={props.onDestinationChange}
                onClear={() => props.onDestinationChange(null)}
                icon={<Search size={14} aria-hidden />}
                busy={props.routing}
              />
            </div>
          </div>

          <button
            type="button"
            onClick={props.onUseMyLocation}
            disabled={props.locating}
            className={`${FOCUS_RING} ${MOTION} flex w-full items-center justify-center gap-2 rounded-lg bg-slate-100 px-2.5 py-2 text-xs font-semibold text-slate-800 hover:bg-slate-200 disabled:opacity-60 dark:bg-slate-800 dark:text-slate-100 dark:hover:bg-slate-700`}
          >
            {props.locating ? (
              <Loader2 size={14} className="animate-spin" aria-hidden />
            ) : (
              <LocateFixed size={14} aria-hidden />
            )}
            {props.locating ? 'Finding your location…' : 'Use my live location'}
          </button>
        </div>
      )}

      {/* Mode */}
      <div
        className="mt-3 grid grid-cols-3 gap-1 rounded-lg bg-slate-100 p-1 dark:bg-slate-800"
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
              className={`${FOCUS_RING} ${MOTION} flex items-center justify-center gap-1.5 rounded-md px-2 py-2 text-xs font-semibold ${
                active
                  ? 'bg-white text-emerald-700 dark:bg-slate-900 dark:text-emerald-300'
                  : 'text-slate-600 dark:text-slate-300'
              }`}
            >
              <Icon size={15} aria-hidden />
              {label}
            </button>
          );
        })}
      </div>

      {/* Departure */}
      {hasTrip && (
        <div className="mt-3">
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-xs font-medium text-slate-600 dark:text-slate-300">
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
            value={Math.max(0, DEPARTURE_OFFSETS.indexOf(props.offsetMin))}
            onChange={(e) => {
              const next = DEPARTURE_OFFSETS[Number(e.target.value)];
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
      )}

      {/* Usual route — deliberately secondary */}
      {props.routes.length > 0 && (
        <div className="mt-3 border-t border-slate-200 pt-2 dark:border-slate-700">
          <label className="flex items-center justify-between gap-2 text-xs text-slate-600 dark:text-slate-300">
            <span>Usual route</span>
            <select
              value={props.baselineRouteId}
              onChange={(e) => props.onBaselineChange(e.target.value)}
              aria-label="Usual route"
              className={`${FOCUS_RING} rounded-lg bg-white/80 px-2 py-1 text-xs ring-1 ring-slate-300 dark:bg-slate-800/80 dark:ring-slate-600`}
            >
              {props.routes.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </select>
          </label>
        </div>
      )}

      {props.error && (
        <div className="mt-3 rounded-lg bg-amber-50 p-2 ring-1 ring-amber-300 dark:bg-amber-500/10 dark:ring-amber-400/40">
          <p className="text-[11px] text-amber-900 dark:text-amber-200">{props.error}</p>
          <button
            type="button"
            onClick={props.onRetry}
            className={`${FOCUS_RING} ${MOTION} mt-1.5 flex items-center gap-1 rounded-md bg-amber-100 px-2 py-1 text-[11px] font-semibold text-amber-900 hover:bg-amber-200 dark:bg-amber-500/20 dark:text-amber-200 dark:hover:bg-amber-500/30`}
          >
            <RefreshCw size={11} aria-hidden />
            Try again
          </button>
        </div>
      )}

      {props.routing && (
        <p className="mt-2 flex items-center gap-1.5 text-[11px] text-slate-500 dark:text-slate-400" role="status">
          <Loader2 size={11} className="animate-spin" aria-hidden />
          Finding real routes…
        </p>
      )}
    </div>
  );
}

/** Exported so App can offer a one-tap geolocation shortcut. */
export function currentPositionAvailable(): boolean {
  return typeof navigator !== 'undefined' && !!navigator.geolocation;
}

export type { LatLon };
export { TOUCH_TARGET };