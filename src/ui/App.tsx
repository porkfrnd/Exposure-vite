/**
 * EXPOSURE VITE — App shell (Google-Maps paradigm).
 *
 * The map is a full-bleed canvas that is ALWAYS mounted and ALWAYS interactive.
 * All UI floats above it in three states:
 *
 *   EXPLORE        search bar + map controls, live-location dot, free pan/zoom
 *   PLACE_DETAILS  place detail card with modeled PM2.5 and a route CTA
 *   ROUTING        route planner (editable From/To, swap, mode, departure) + results
 *
 * There is no blocking modal anywhere. The map never goes blank.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { MapCanvas } from './components/MapCanvas';
import type { MapHandle, SegmentStyle, RouteLabel } from './components/MapCanvas';
import {
  ExploreHint,
  MapControls,
  PlaceDetailCard,
  RoutePlannerCard,
  TopSearch,
  usePlaceSearch,
} from './components/FloatingUI';
import { RouteSummaryCard } from './cards/RouteSummaryCard';
import { BreakdownDrawer, currentEngineParams } from './cards/BreakdownDrawer';
import { FeatureDock } from './cards/Dock';
import { EvidenceModal } from './cards/EvidenceModal';
import { useAppStore, pm25Near, pm25Band } from './state/appStore';
import { useTheme } from './theme/useTheme';
import { formatLocalTime, VALLEY } from './wiring';
import { exposureColor, extentOf } from './map/ramp';
import type { LatLon } from '@/contracts';

export function App() {
  const store = useAppStore();
  const { theme, toggle } = useTheme();

  const [breakdownOpen, setBreakdownOpen] = useState(false);
  const [breakdownSection, setBreakdownSection] = useState<string | undefined>(undefined);
  const [evidenceOpen, setEvidenceOpen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  const [query, setQuery] = useState('');
  const { results, searching } = usePlaceSearch(query);

  const mapHandleRef = useRef<MapHandle | null>(null);
  const setMapHandle = useCallback((h: MapHandle | null) => {
    mapHandleRef.current = h;
  }, []);

  const { comparison, routes, planned, appState } = store;

  // ── Segment styling by RELATIVE modeled exposure ──────────────────────────
  const styles = useMemo<Record<string, SegmentStyle>>(() => {
    const out: Record<string, SegmentStyle> = {};
    if (!comparison) return out;

    const exposureById = new Map<string, number>();
    for (const trip of comparison.trips) {
      for (const seg of trip.segments) {
        if (Number.isFinite(seg.concentration) && !exposureById.has(seg.segmentId)) {
          exposureById.set(seg.segmentId, seg.concentration);
        }
      }
    }
    const { min, max } = extentOf([...exposureById.values()]);

    for (const trip of comparison.trips) {
      for (const seg of trip.segments) {
        const recommended = comparison.bestRouteId === trip.routeId;
        out[seg.segmentId] = {
          routeId: trip.routeId,
          color: exposureColor(exposureById.get(seg.segmentId) ?? 0, min, max),
          recommended,
          dimmed: !recommended && trip.routeId !== comparison.baselineRouteId,
          confidence: seg.confidence,
        };
      }
    }
    return out;
  }, [comparison]);

  // ── Route chips: name + REAL router duration ──────────────────────────────
  const routeLabels = useMemo<RouteLabel[]>(() => {
    if (!comparison) return [];
    const out: RouteLabel[] = [];
    const total = Math.max(1, comparison.trips.length);

    comparison.trips.forEach((trip, index) => {
      const route = routes.find((r) => r.id === trip.routeId);
      const meta = planned.find((p) => p.route.id === trip.routeId);
      if (!route || route.segments.length === 0) return;

      const minutes = meta ? meta.durationS / 60 : trip.durationMin;
      const segIdx = Math.min(
        route.segments.length - 1,
        Math.round((0.38 + (index / total) * 0.24) * (route.segments.length - 1)),
      );
      const seg = route.segments[segIdx];
      const coordIdx = Math.min(seg.coords.length - 1, Math.floor(seg.coords.length / 2));
      const coord = seg.coords[coordIdx];
      if (!coord) return;

      const a = seg.coords[Math.max(0, coordIdx - 1)];
      const b = seg.coords[Math.min(seg.coords.length - 1, coordIdx + 1)];
      const bearing = Math.atan2(b.lon - a.lon, b.lat - a.lat);
      const nudgeM = (index - (total - 1) / 2) * 55;

      out.push({
        routeId: trip.routeId,
        name: route.name,
        minutes,
        lat: coord.lat + (nudgeM * Math.cos(bearing)) / 111_320,
        lon: coord.lon + (nudgeM * Math.sin(bearing)) / (111_320 * Math.cos((coord.lat * Math.PI) / 180)),
        recommended: comparison.bestRouteId === trip.routeId,
        dimmed: comparison.bestRouteId !== trip.routeId && trip.routeId !== comparison.baselineRouteId,
      });
    });
    return out;
  }, [comparison, routes, planned]);

  // ── Fly to a place when it gets selected ─────────────────────────────────
  const flyToSelected = useRef<LatLon | null>(null);
  useEffect(() => {
    const p = store.selectedPlace;
    if (!p) return;
    if (flyToSelected.current?.lat === p.lat && flyToSelected.current?.lon === p.lon) return;
    flyToSelected.current = { lat: p.lat, lon: p.lon };
    mapHandleRef.current?.flyTo(p.lat, p.lon, 16);
  }, [store.selectedPlace]);

  // ── Fit routes when they arrive, then clear the selected-place pin ────────
  useEffect(() => {
    if (routes.length > 0) flyToSelected.current = store.selectedPlace;
  }, [routes.length, store.selectedPlace]);

  useEffect(() => {
    if (!toast) return;
    const t = window.setTimeout(() => setToast(null), 4200);
    return () => window.clearTimeout(t);
  }, [toast]);

  const handleMapClick = useCallback(
    (lat: number, lon: number) => {
      if (appState === 'ROUTING') return;
      void store.selectCoordinates(lat, lon);
    },
    [appState, store],
  );

  const recenter = useCallback(async () => {
    const pos = await store.locate();
    if (pos) mapHandleRef.current?.flyTo(pos.lat, pos.lon, 15);
  }, [store]);

  const showSearch = appState === 'EXPLORE';
  const showPlaceCard = appState === 'PLACE_DETAILS' && store.selectedPlace !== null;
  const showRouter = appState === 'ROUTING';
  const hasRoutes = routes.length > 0;

  return (
    <div className="relative h-dvh w-screen overflow-hidden">
      {/* Map is unconditional: it must never unmount. */}
      <MapCanvas
        theme={theme}
        routes={routes}
        styles={styles}
        routeLabels={routeLabels}
        selectedPlace={showPlaceCard || showRouter ? store.selectedPlace : null}
        liveLocation={store.liveLocation}
        origin={showRouter ? (store.origin ?? null) : null}
        destination={showRouter ? (store.destination ?? null) : null}
        observations={store.observations}
        onMapClick={handleMapClick}
        onTileFailure={() => setToast('Base map tiles failed to load.')}
        handleRef={setMapHandle}
      />

      {/* Honesty banner — always visible, never blocking. */}
      <div className="pointer-events-none absolute left-1/2 top-[4.25rem] z-[1150] -translate-x-1/2 max-sm:top-[4.5rem]">
        <span className="rounded-full border border-slate-200 bg-white/95 px-2.5 py-1 text-[11px] font-medium text-slate-700 backdrop-blur dark:border-slate-700 dark:bg-slate-900/95 dark:text-slate-200">
          Modeled estimate · not a measurement · not medical advice
        </span>
      </div>

      {/* ── State A / C: search + planner (top-left) ─────────────────────── */}
      {showSearch && (
        <TopSearch
          value={query}
          onQueryChange={setQuery}
          results={results}
          searching={searching}
          onPick={(p) => {
            setQuery('');
            store.selectPlace(p);
          }}
        />
      )}

      {showRouter && (
        <RoutePlannerCard
          state={appState}
          origin={store.origin}
          destination={store.destination}
          mode={store.mode}
          onModeChange={store.setMode}
          onOriginPick={store.setOrigin}
          onDestinationPick={store.setDestination}
          onClearOrigin={() => store.setOrigin(null)}
          onClearDestination={() => store.setDestination(null)}
          onSwap={store.swapEnds}
          onClose={store.exitRouting}
          routing={store.routing}
          routeError={store.routeError}
          onRetry={store.retryRouting}
          forecast={store.forecast}
          nowMs={Date.now()}
          offsetMin={store.offsetMin}
          onOffsetChange={store.setOffsetMin}
        />
      )}

      {/* ── State B: place detail (bottom-left) ─────────────────────────── */}
      {showPlaceCard && store.selectedPlace && (
        <PlaceDetailCard
          place={store.selectedPlace}
          forecast={store.forecast}
          nowMs={Date.now()}
          onFindRoute={store.startRouting}
          onClose={() => store.setAppState('EXPLORE')}
        />
      )}

      {/* Route results summary (bottom-left, only when routes exist). */}
      {showRouter && hasRoutes && (
        <RouteSummaryCard
          comparison={comparison}
          routes={routes}
          bestTimeHint={null}
          onOpenBreakdown={() => {
            setBreakdownSection(undefined);
            setBreakdownOpen(true);
          }}
          onAddEvidence={() => setEvidenceOpen(true)}
          onOpenEvidence={() => setEvidenceOpen(true)}
          collapsed={false}
          onToggleCollapsed={() => {}}
        />
      )}

      <ExploreHint visible={appState === 'EXPLORE' && store.liveLocation === null && !store.locating} />

      {store.locError && appState === 'EXPLORE' && (
        <div className="pointer-events-auto absolute bottom-4 left-1/2 z-[1200] -translate-x-1/2 rounded-xl border border-amber-300 bg-amber-50 px-3 py-2 text-[11px] text-amber-900 dark:border-amber-400/40 dark:bg-amber-900/90 dark:text-amber-200">
          {store.locError}
        </div>
      )}

      {/* Bottom-right controls. */}
      <MapControls
        hasLive={store.liveLocation !== null}
        locating={store.locating}
        onLocate={() => void recenter()}
        theme={theme}
        onToggleTheme={toggle}
        onReset={showRouter ? store.clearAll : undefined}
      />

      <FeatureDock
        theme={theme}
        onToggleTheme={toggle}
        onOpen={(id) => {
          if (id === 'method') {
            setBreakdownSection('how');
            setBreakdownOpen(true);
          } else if (id === 'evidence') {
            setEvidenceOpen(true);
          } else {
            setToast('That panel is not available in this build.');
          }
        }}
        onAddEvidence={() => setEvidenceOpen(true)}
      />

      {toast && (
        <div
          role="status"
          className="pointer-events-auto absolute left-1/2 top-24 z-[1400] -translate-x-1/2 rounded-xl bg-slate-800 px-3 py-2 text-xs font-medium text-white dark:bg-slate-200 dark:text-slate-900"
        >
          {toast}
        </div>
      )}

      <EvidenceModal
        open={evidenceOpen}
        onClose={() => setEvidenceOpen(false)}
        observations={store.observations}
        showSimulated={false}
        defaultLocation={
          (store.destination ?? store.selectedPlace ?? store.origin) ?? VALLEY
        }
        currentISO={new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')}
        forecast={store.forecast}
        segments={store.segments}
        onAdd={(obs) => {
          store.addObservation(obs);
          setEvidenceOpen(false);
          setToast('Your evidence was added. Nearby segments were updated.');
        }}
        onError={(m) => setToast(m)}
      />

      <BreakdownDrawer
        open={breakdownOpen}
        onClose={() => setBreakdownOpen(false)}
        comparison={comparison}
        routes={routes}
        segments={store.segments}
        sweep={store.sweep}
        selectedSegmentId={null}
        onSelectSegment={() => {}}
        sensitivity={null}
        onRunSensitivity={() => {}}
        fittedBias={null}
        params={currentEngineParams()}
        openSection={breakdownSection}
      />
    </div>
  );
}

export { pm25Near, pm25Band, formatLocalTime };
export type { LatLon };