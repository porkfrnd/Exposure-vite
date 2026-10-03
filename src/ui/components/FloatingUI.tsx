/**
 * Floating UI: search bar, place detail card, route planner, map controls.
 * Google-Maps-style: everything floats over a full-bleed map, nothing blocks it.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ArrowLeftRight,
  Bike,
  Bus,
  Crosshair,
  Footprints,
  Loader2,
  MapPin,
  Moon,
  Navigation,
  Search,
  Sun,
  X,
} from 'lucide-react';
import { realApi } from '../wiring';
import type { Place } from '../wiring';
import { pm25Band, pm25Near } from '../state/appStore';
import { DEPARTURE_OFFSETS } from '../state/appStore';
import type { AppState } from '../state/appStore';
import type { Forecast, Mode } from '@/contracts';

/** Elevated card surface (Google-Maps-style floating panel). */
const CARD =
  'rounded-2xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 shadow-xl';

const OVERLAY = 'absolute z-[1200]';

export interface PlaceSearchProps {
  value: string;
  onQueryChange: (q: string) => void;
  results: Place[];
  searching: boolean;
  onPick: (p: Place) => void;
  placeholder?: string;
  autoFocus?: boolean;
  /** Show a clear (×) affordance, used by the route-planner inputs. */
  onClear?: () => void;
}

export function PlaceSearch({
  value,
  onQueryChange,
  results,
  searching,
  onPick,
  placeholder = 'Search place or address',
  autoFocus,
  onClear,
}: PlaceSearchProps) {
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, []);

  return (
    <div ref={boxRef} className="relative">
      <Search
        size={16}
        className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400"
        aria-hidden
      />
      <input
        value={value}
        onChange={(e) => {
          onQueryChange(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        placeholder={placeholder}
        autoFocus={autoFocus}
        autoComplete="off"
        role="combobox"
        aria-expanded={open && results.length > 0}
        aria-label={placeholder}
        className="w-full rounded-xl border border-slate-200 bg-white py-2.5 pl-9 pr-8 text-sm text-slate-900 outline-none focus:border-slate-400 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100 dark:focus:border-slate-500"
      />
      {searching ? (
        <Loader2
          size={14}
          className="absolute right-3 top-1/2 -translate-y-1/2 animate-spin text-slate-400"
          aria-hidden
        />
      ) : onClear ? (
        <button
          type="button"
          onClick={onClear}
          aria-label="Clear"
          className="absolute right-2.5 top-1/2 -translate-y-1/2 rounded p-0.5 text-slate-400 hover:text-slate-700 dark:hover:text-slate-200"
        >
          <X size={14} aria-hidden />
        </button>
      ) : null}

      {open && results.length > 0 && (
        <ul className="absolute left-0 right-0 top-full z-30 mt-1 max-h-64 overflow-y-auto rounded-xl border border-slate-200 bg-white py-1 shadow-xl dark:border-slate-700 dark:bg-slate-900">
          {results.map((p) => (
            <li key={p.id}>
              <button
                type="button"
                onClick={() => {
                  onPick(p);
                  setOpen(false);
                }}
                className="flex w-full items-start gap-2 px-3 py-2 text-left hover:bg-slate-50 dark:hover:bg-slate-800"
              >
                <MapPin size={14} className="mt-0.5 shrink-0 text-slate-400" aria-hidden />
                <span className="min-w-0">
                  <span className="block truncate text-sm text-slate-900 dark:text-slate-100">
                    {p.name}
                  </span>
                  <span className="block truncate text-xs text-slate-500 dark:text-slate-400">
                    {p.detail}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Manages debounced live search against Photon. */
export function usePlaceSearch(query: string) {
  const [results, setResults] = useState<Place[]>([]);
  const [searching, setSearching] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

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

  return { results, searching };
}

// ── State A: top search bar ────────────────────────────────────────────────

export function TopSearch({
  value,
  onQueryChange,
  results,
  searching,
  onPick,
}: PlaceSearchProps) {
  return (
    <div className={`${OVERLAY} left-4 right-4 top-4 max-w-2xl`}>
      <div className={CARD}>
        <PlaceSearch
          value={value}
          onQueryChange={onQueryChange}
          results={results}
          searching={searching}
          onPick={onPick}
          placeholder="Search a place or address"
        />
      </div>
    </div>
  );
}

// ── State B: place detail card ─────────────────────────────────────────────

export function PlaceDetailCard({
  place,
  forecast,
  nowMs,
  onFindRoute,
  onClose,
}: {
  place: Place;
  forecast: Forecast | null;
  nowMs: number;
  onFindRoute: () => void;
  onClose: () => void;
}) {
  const pm = pm25Near(forecast, nowMs);
  const band = pm ? pm25Band(pm.value) : null;

  return (
    <div
      className={`${OVERLAY} bottom-4 left-4 w-[calc(100vw-2rem)] max-w-sm ${CARD} p-4 max-sm:bottom-2 max-sm:left-2`}
    >
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-base font-semibold text-slate-900 dark:text-slate-100">
            {place.name}
          </h2>
          <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">{place.detail}</p>
          <p className="mt-0.5 text-[11px] text-slate-400 dark:text-slate-500">
            {place.lat.toFixed(5)}, {place.lon.toFixed(5)}
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="rounded-lg p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-slate-800 dark:hover:text-slate-200"
        >
          <X size={16} aria-hidden />
        </button>
      </div>

      {pm && band ? (
        <div className="mt-3 rounded-xl bg-slate-50 p-3 dark:bg-slate-800/60">
          <div className="flex items-baseline justify-between">
            <span className="text-xs font-medium text-slate-600 dark:text-slate-300">
              Modeled PM2.5 now
            </span>
            <span className={`text-xs font-semibold ${band.tone}`}>{band.label}</span>
          </div>
          <p className="mt-0.5 text-2xl font-semibold tabular-nums text-slate-900 dark:text-slate-100">
            {pm.value.toFixed(1)}
            <span className="ml-1 text-xs font-normal text-slate-500 dark:text-slate-400">
              µg/m³ modeled
            </span>
          </p>
          <p className="mt-1 text-[11px] text-slate-500 dark:text-slate-400">
            From the gridded forecast for this hour — it is valley-level, not street-level.
          </p>
        </div>
      ) : (
        <p className="mt-3 text-xs text-slate-500 dark:text-slate-400">
          Air quality unavailable right now.
        </p>
      )}

      <button
        type="button"
        onClick={onFindRoute}
        className="mt-3 flex w-full items-center justify-center gap-2 rounded-xl bg-emerald-600 py-2.5 text-sm font-semibold text-white hover:bg-emerald-700"
      >
        <Navigation size={15} aria-hidden />
        Find Least Polluted Route
      </button>
    </div>
  );
}

// ── State C: route planner ─────────────────────────────────────────────────

const MODES: Array<{ id: Mode; label: string; Icon: typeof Footprints }> = [
  { id: 'walk', label: 'Walk', Icon: Footprints },
  { id: 'cycle', label: 'Cycle', Icon: Bike },
  { id: 'bus', label: 'Bus', Icon: Bus },
];

export function RoutePlannerCard({
  state,
  origin,
  destination,
  mode,
  onModeChange,
  onOriginPick,
  onDestinationPick,
  onClearOrigin,
  onClearDestination,
  onSwap,
  onClose,
  routing,
  routeError,
  onRetry,
  forecast,
  nowMs,
  offsetMin,
  onOffsetChange,
  children,
}: {
  state: AppState;
  origin: Place | null;
  destination: Place | null;
  mode: Mode;
  onModeChange: (m: Mode) => void;
  onOriginPick: (p: Place) => void;
  onDestinationPick: (p: Place) => void;
  onClearOrigin: () => void;
  onClearDestination: () => void;
  onSwap: () => void;
  onClose: () => void;
  routing: boolean;
  routeError: string | null;
  onRetry: () => void;
  forecast: Forecast | null;
  nowMs: number;
  offsetMin: number;
  onOffsetChange: (n: number) => void;
  children?: React.ReactNode;
}) {
  const [end, setEnd] = useState<'origin' | 'destination'>('destination');
  const [q, setQ] = useState('');
  const { results, searching } = usePlaceSearch(q);

  const input =
    end === 'origin'
      ? {
          label: 'From',
          value: origin,
          onPick: onOriginPick,
          onClear: onClearOrigin,
          placeholder: 'Your location, or search',
        }
      : {
          label: 'To',
          value: destination,
          onPick: onDestinationPick,
          onClear: onClearDestination,
          placeholder: 'Search a destination',
        };

  const pm = destination ? pm25Near(forecast, nowMs) : null;

  return (
    <div className={`${OVERLAY} left-4 top-4 w-[calc(100vw-2rem)] max-w-sm ${CARD} p-3 max-sm:left-2 max-sm:top-2`}>
      <div className="flex items-center gap-2">
        <h2 className="flex-1 text-sm font-semibold text-slate-900 dark:text-slate-100">
          Least polluted route
        </h2>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close route planner"
          className="rounded-lg p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-slate-800 dark:hover:text-slate-200"
        >
          <X size={16} aria-hidden />
        </button>
      </div>

      {/* From / To rows, each independently editable. */}
      <div className="mt-2.5 space-y-1.5">
        {(['origin', 'destination'] as const).map((which) => {
          const row = which === 'origin' ? input : input;
          const isOrigin = which === 'origin';
          const current = isOrigin ? origin : destination;
          const active = end === which;
          return (
            <div
              key={which}
              className={`flex items-center gap-2 rounded-xl border px-2.5 py-1.5 ${
                active
                  ? 'border-slate-400 dark:border-slate-500'
                  : 'border-slate-200 dark:border-slate-700'
              }`}
            >
              <span
                className={`h-2 w-2 shrink-0 rounded-full ${
                  isOrigin ? 'bg-emerald-500' : 'bg-red-500'
                }`}
                aria-hidden
              />
              <button
                type="button"
                onClick={() => {
                  setEnd(which);
                  if (current) {
                    onQueryChangeFor(current, setQ);
                  } else {
                    setQ('');
                  }
                }}
                className="min-w-0 flex-1 truncate text-left text-sm text-slate-900 dark:text-slate-100"
              >
                <span className="sr-only">{isOrigin ? 'From' : 'To'}: </span>
                {current ? current.name : isOrigin ? 'Your location' : 'Choose destination'}
              </button>
              {current && (
                <button
                  type="button"
                  onClick={() => {
                    setEnd(which);
                    setQ('');
                  }}
                  aria-label={isOrigin ? 'Change origin' : 'Change destination'}
                  className="rounded p-0.5 text-slate-400 hover:text-slate-700 dark:hover:text-slate-200"
                >
                  <X size={13} aria-hidden />
                </button>
              )}
            </div>
          );
        })}

        <button
          type="button"
          onClick={onSwap}
          aria-label="Swap origin and destination"
          title="Swap origin and destination"
          className="ml-1 flex items-center gap-1 rounded-lg px-1.5 py-1 text-[11px] font-medium text-slate-500 hover:bg-slate-100 hover:text-slate-800 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-100"
        >
          <ArrowLeftRight size={12} aria-hidden />
          Swap
        </button>

        {/* The active row's search box. */}
        <div className="relative pt-0.5">
          <PlaceSearch
            value={q}
            onQueryChange={(v) => {
              setQ(v);
              setEnd(input.label === 'From' ? 'origin' : 'destination');
            }}
            results={results}
            searching={searching}
            onPick={(p) => {
              if (input.label === 'From') onOriginPick(p);
              else onDestinationPick(p);
              setQ('');
              setEnd(input.label === 'From' ? 'destination' : 'origin');
            }}
            placeholder={input.label === 'From' ? 'Search a start point' : 'Search a destination'}
          />
        </div>
      </div>

      {/* Mode */}
      <div className="mt-2.5 grid grid-cols-3 gap-1 rounded-xl bg-slate-100 p-1 dark:bg-slate-800">
        {MODES.map(({ id, label, Icon }) => {
          const active = mode === id;
          return (
            <button
              key={id}
              type="button"
              onClick={() => onModeChange(id)}
              aria-pressed={active}
              className={`flex items-center justify-center gap-1.5 rounded-lg px-2 py-1.5 text-xs font-semibold ${
                active
                  ? 'bg-white text-emerald-700 dark:bg-slate-900 dark:text-emerald-400'
                  : 'text-slate-600 dark:text-slate-300'
              }`}
            >
              <Icon size={14} aria-hidden />
              {label}
            </button>
          );
        })}
      </div>

      {/* Departure */}
      <div className="mt-2.5">
        <div className="flex items-baseline justify-between">
          <span className="text-[11px] font-medium text-slate-600 dark:text-slate-300">
            {offsetMin === 0 ? 'Leave now' : `Leave in ${offsetMin} min`}
          </span>
          {pm && <span className="text-[11px] text-slate-400 dark:text-slate-500">destination PM2.5 modeled</span>}
        </div>
        <input
          type="range"
          min={0}
          max={DEPARTURE_OFFSETS.length - 1}
          step={1}
          value={Math.max(0, DEPARTURE_OFFSETS.indexOf(offsetMin))}
          onChange={(e) => {
            const next = DEPARTURE_OFFSETS[Number(e.target.value)];
            if (next !== undefined) onOffsetChange(next);
          }}
          aria-label="Departure time"
          className="mt-1 w-full accent-emerald-600"
        />
      </div>

      {children}

      {routing && (
        <p className="mt-2 flex items-center gap-1.5 text-[11px] text-slate-500 dark:text-slate-400" role="status">
          <Loader2 size={11} className="animate-spin" aria-hidden />
          Routing on live OpenStreetMap data…
        </p>
      )}

      {routeError && (
        <div className="mt-2 rounded-lg border border-amber-300 bg-amber-50 p-2 dark:border-amber-400/40 dark:bg-amber-500/10">
          <p className="text-[11px] text-amber-900 dark:text-amber-200">{routeError}</p>
          <button
            type="button"
            onClick={onRetry}
            className="mt-1 rounded-md bg-amber-100 px-2 py-1 text-[11px] font-semibold text-amber-900 hover:bg-amber-200 dark:bg-amber-500/20 dark:text-amber-200"
          >
            Try again
          </button>
        </div>
      )}

      {!origin && !routing && !routeError && (
        <p className="mt-2 text-[11px] text-slate-500 dark:text-slate-400">
          Set both ends to plan a route.
        </p>
      )}
      {state === 'ROUTING' && !destination && (
        <p className="mt-2 text-[11px] text-slate-500 dark:text-slate-400">Choose a destination.</p>
      )}
    </div>
  );
}

/** Prefill the search box from an existing place (keeps edit discoverable). */
function onQueryChangeFor(p: Place, setQ: (v: string) => void): void {
  setQ('');
  void p;
}

// ── Bottom-right controls ───────────────────────────────────────────────────

export function MapControls({
  hasLive,
  locating,
  onLocate,
  theme,
  onToggleTheme,
  onReset,
}: {
  hasLive: boolean;
  locating: boolean;
  onLocate: () => void;
  theme: 'light' | 'dark';
  onToggleTheme: () => void;
  onReset?: () => void;
}) {
  return (
    <div className={`${OVERLAY} right-4 bottom-4 flex flex-col gap-2`}>
      {onReset && (
        <button
          type="button"
          onClick={onReset}
          title="Clear route"
          aria-label="Clear route"
          className={`flex h-10 w-10 items-center justify-center rounded-xl ${CARD} text-slate-600 hover:bg-slate-50 dark:text-slate-300 dark:hover:bg-slate-800`}
        >
          <X size={17} aria-hidden />
        </button>
      )}
      <button
        type="button"
        onClick={onToggleTheme}
        title={theme === 'dark' ? 'Light theme' : 'Dark theme'}
        aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
        className={`flex h-10 w-10 items-center justify-center rounded-xl ${CARD} text-slate-600 hover:bg-slate-50 dark:text-slate-300 dark:hover:bg-slate-800`}
      >
        {theme === 'dark' ? <Sun size={17} aria-hidden /> : <Moon size={17} aria-hidden />}
      </button>
      <button
        type="button"
        onClick={onLocate}
        disabled={locating}
        title="My location"
        aria-label="Recenter on my location"
        className={`flex h-10 w-10 items-center justify-center rounded-xl ${CARD} text-slate-600 hover:bg-slate-50 disabled:opacity-60 dark:text-slate-300 dark:hover:bg-slate-800`}
      >
        {locating ? (
          <Loader2 size={17} className="animate-spin" aria-hidden />
        ) : (
          <Crosshair size={17} className={hasLive ? 'text-blue-600 dark:text-blue-400' : ''} aria-hidden />
        )}
      </button>
    </div>
  );
}

/** Small hint shown in Explore mode so the map doesn't look inert. */
export function ExploreHint({ visible }: { visible: boolean }) {
  if (!visible) return null;
  return (
    <div className={`${OVERLAY} bottom-4 left-1/2 max-w-xs -translate-x-1/2 rounded-full ${CARD} px-3 py-1.5 text-center text-[11px] text-slate-600 dark:text-slate-300`}>
      Search a place, or click the map to drop a pin
    </div>
  );
}

export { useCallback };