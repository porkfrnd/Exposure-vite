/**
 * EXPOSURE VITE — App shell.
 *
 * The map is the page (fixed, full viewport, no scroll). Everything else is a
 * floating overlay card above it.
 *
 * ALL DATA IS REAL: live Open-Meteo air quality, live OSM routing, live OSM road
 * classes, live place search. There are no demo routes and no simulated pins.
 * FIRST-SCREEN RULE: planner + summary + map only; all model internals live
 * behind "View Scientific Breakdown".
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { MapView } from './map/MapView';
import type { RouteLabel, SegmentStyle } from './map/MapView';
import { exposureColor, extentOf } from './map/ramp';
import { PlannerCard } from './cards/PlannerCard';
import { RouteSummaryCard } from './cards/RouteSummaryCard';
import { BreakdownDrawer, currentEngineParams } from './cards/BreakdownDrawer';
import { FeatureDock, HonestyPill, MapLegend } from './cards/Dock';
import type { DockId } from './cards/Dock';
import { EvidenceModal } from './cards/EvidenceModal';
import { DiaryModal } from './cards/DiaryModal';
import { SchoolModal } from './cards/SchoolModal';
import { DemoTourModal } from './cards/DemoTourModal';
import { useExposureModel } from './state/useExposureModel';
import { useTheme } from './theme/useTheme';
import { engine, formatLocalTime, VALLEY } from './wiring';
import type { LatLon, SweepPoint } from '@/contracts';

export function App() {
  const model = useExposureModel();
  const { theme, toggle } = useTheme();

  const [selectedSegmentId, setSelectedSegmentId] = useState<string | null>(null);
  const [breakdownOpen, setBreakdownOpen] = useState(false);
  const [breakdownSection, setBreakdownSection] = useState<string | undefined>(undefined);
  const [summaryCollapsed, setSummaryCollapsed] = useState(false);
  const [evidenceOpen, setEvidenceOpen] = useState(false);
  const [diaryOpen, setDiaryOpen] = useState(false);
  const [schoolOpen, setSchoolOpen] = useState(false);
  const [demoOpen, setDemoOpen] = useState(false);
  const [dockPanel, setDockPanel] = useState<DockId | null>(null);
  const [tileFailed, setTileFailed] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  const { comparison, routes, observations, forecast, departISO, nowMs, planned } = model;

  // ── Segment styling: colour by RELATIVE modeled exposure, min→max on screen ──
  const styles = useMemo<Record<string, SegmentStyle>>(() => {
    const out: Record<string, SegmentStyle> = {};
    if (!comparison) return out;

    const exposureById = new Map<string, number>();
    for (const trip of comparison.trips) {
      for (const seg of trip.segments) {
        if (!Number.isFinite(seg.concentration)) continue;
        if (!exposureById.has(seg.segmentId)) exposureById.set(seg.segmentId, seg.concentration);
      }
    }

    const { min, max } = extentOf([...exposureById.values()]);

    for (const trip of comparison.trips) {
      for (const seg of trip.segments) {
        const route = routes.find((r) => r.id === trip.routeId);
        if (!route) continue;
        const recommended = comparison.bestRouteId === trip.routeId;
        const dimmed = !recommended && trip.routeId !== comparison.baselineRouteId;
        const exposure = exposureById.get(seg.segmentId) ?? 0;
        const share = 1 / Math.max(1, trip.segments.length);
        out[seg.segmentId] = {
          routeId: trip.routeId,
          routeName: route.name,
          color: exposureColor(exposure, min, max),
          minutesLabel: `${Math.round(trip.durationMin * share)} min`,
          confidence: seg.confidence,
          recommended,
          dimmed,
        };
      }
    }
    return out;
  }, [comparison, routes]);

  // ── Route labels: name + real router duration ─────────────────────────────
  const routeLabels = useMemo<RouteLabel[]>(() => {
    if (!comparison) return [];
    const out: RouteLabel[] = [];
    const total = Math.max(1, comparison.trips.length);

    comparison.trips.forEach((trip, index) => {
      const route = routes.find((r) => r.id === trip.routeId);
      const plannedRoute = planned.find((p) => p.route.id === trip.routeId);
      if (!route || route.segments.length === 0) return;

      // Real router duration when we have it; the engine estimate otherwise.
      const minutes = plannedRoute ? plannedRoute.durationS / 60 : trip.durationMin;

      const fraction = 0.38 + (index / total) * 0.24;
      const segIdx = Math.min(
        route.segments.length - 1,
        Math.max(0, Math.round(fraction * (route.segments.length - 1))),
      );
      const seg = route.segments[segIdx];
      const coordIdx = Math.min(seg.coords.length - 1, Math.max(0, Math.floor(seg.coords.length / 2)));
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
        lon:
          coord.lon +
          (nudgeM * Math.sin(bearing)) / (111_320 * Math.cos((coord.lat * Math.PI) / 180)),
        recommended: comparison.bestRouteId === trip.routeId,
        dimmed:
          comparison.bestRouteId !== trip.routeId && trip.routeId !== comparison.baselineRouteId,
      });
    });
    return out;
  }, [comparison, routes, planned]);

  const departureLabel = useMemo(() => formatLocalTime(departISO), [departISO]);

  const departureShort = useMemo(() => {
    if (model.offsetMin === 0) return 'Leave now';
    const h = Math.floor(model.offsetMin / 60);
    const m = model.offsetMin % 60;
    if (h > 0 && m > 0) return `Leave in ${h} h ${m} min`;
    if (h > 0) return `Leave in ${h} h`;
    return `Leave in ${m} min`;
  }, [model.offsetMin]);

  const headlineVerdict = useMemo((): 'recommend' | 'slight' | 'none' => {
    if (!comparison || !comparison.bestRouteId) return 'none';
    const best = comparison.versus.find((v) => v.routeId === comparison.bestRouteId);
    if (!best || best.verdict === 'none') {
      return comparison.versus.find((v) => v.verdict === 'slight') ? 'slight' : 'none';
    }
    return best.verdict;
  }, [comparison]);

  const bestTimeHint = useMemo((): string | null => {
    const sweep: SweepPoint[] = model.sweep;
    if (sweep.length < 2 || headlineVerdict !== 'recommend') return null;
    let best: { offsetMin: number; routeId: string; pct: number } | null = null;
    for (const p of sweep) {
      if (p.offsetMin <= model.offsetMin) continue;
      for (const v of p.comparison.versus) {
        if (v.verdict !== 'recommend') continue;
        if (!best || v.medianDeltaE > best.pct) {
          best = { offsetMin: p.offsetMin, routeId: v.routeId, pct: v.medianDeltaE };
        }
      }
    }
    if (!best) return null;
    const name = routes.find((r) => r.id === best!.routeId)?.name ?? 'that route';
    const mins = best.offsetMin - model.offsetMin;
    if (mins <= 0) return null;
    return `Leaving ${mins} min later looks better on ${name} in this model.`;
  }, [model.sweep, model.offsetMin, routes, headlineVerdict]);

  useEffect(() => {
    if (!toast) return;
    const t = window.setTimeout(() => setToast(null), 4200);
    return () => window.clearTimeout(t);
  }, [toast]);

  const openBreakdown = useCallback((section?: string) => {
    setBreakdownSection(section);
    setBreakdownOpen(true);
  }, []);

  const handleDockOpen = useCallback(
    (id: DockId) => {
      if (id === 'method') return openBreakdown('how');
      if (id === 'evidence') return setEvidenceOpen(true);
      if (id === 'diary') return setDiaryOpen(true);
      if (id === 'school') return setSchoolOpen(true);
      if (id === 'demo') return setDemoOpen(true);
      setDockPanel(id);
    },
    [openBreakdown],
  );

  // ── Empty state: no trip planned yet, or an honest error ──────────────────
  const hasTrip = model.origin !== null && model.destination !== null;
  const showEmpty = !hasTrip || routes.length === 0;

  return (
    <div className="relative h-dvh w-screen overflow-hidden">
      {routes.length > 0 && (
        <MapView
          routes={routes}
          styles={styles}
          routeLabels={routeLabels}
          selectedSegmentId={selectedSegmentId}
          onSelectSegment={setSelectedSegmentId}
          origin={model.origin ? { lat: model.origin.lat, lon: model.origin.lon } : null}
          destination={
            model.destination ? { lat: model.destination.lat, lon: model.destination.lon } : null
          }
          school={null}
          observations={observations}
          showSimulated={false}
          theme={theme}
          onTileFailure={() => setTileFailed(true)}
        />
      )}

      <HonestyPill source={forecast?.source ?? null} />

      <PlannerCard
        routes={routes}
        origin={model.origin}
        destination={model.destination}
        onOriginChange={model.setOrigin}
        onDestinationChange={model.setDestination}
        onUseMyLocation={model.useMyLocation}
        locating={model.phase === 'locating'}
        onSwap={model.swap}
        mode={model.mode}
        onModeChange={model.setMode}
        offsetMin={model.offsetMin}
        onOffsetChange={model.setOffsetMin}
        baselineRouteId={model.baselineRouteId}
        onBaselineChange={model.setBaselineRouteId}
        departureLabel={departureLabel}
        departureShort={departureShort}
        routing={model.phase === 'routing'}
        error={model.error}
        onRetry={model.retry}
      />

      <FeatureDock
        theme={theme}
        onToggleTheme={toggle}
        onOpen={handleDockOpen}
        onAddEvidence={() => setEvidenceOpen(true)}
      />

      {showEmpty ? (
        <EmptyState
          hasTrip={hasTrip}
          routing={model.phase === 'routing'}
          error={model.error}
          onRetry={model.retry}
          onUseMyLocation={model.useMyLocation}
        />
      ) : (
        <>
          <RouteSummaryCard
            comparison={comparison}
            routes={routes}
            bestTimeHint={bestTimeHint}
            onOpenBreakdown={() => openBreakdown()}
            onAddEvidence={() => setEvidenceOpen(true)}
            onOpenEvidence={() => setEvidenceOpen(true)}
            collapsed={summaryCollapsed}
            onToggleCollapsed={() => setSummaryCollapsed((v) => !v)}
          />
          <MapLegend />
        </>
      )}

      {tileFailed && (
        <p className="pointer-events-none absolute bottom-40 left-1/2 z-[1100] -translate-x-1/2 rounded-full bg-amber-100 px-3 py-1 text-[11px] font-medium text-amber-900 ring-1 ring-amber-400 dark:bg-amber-500/20 dark:text-amber-200 dark:ring-amber-400/40">
          Base map could not load — routes are still shown.
        </p>
      )}

      {toast && (
        <div
          role="status"
          className="pointer-events-auto absolute left-1/2 top-24 z-[1400] -translate-x-1/2 rounded-lg bg-slate-900/90 px-3 py-2 text-xs font-medium text-white dark:bg-slate-100/95 dark:text-slate-900"
        >
          {toast}
        </div>
      )}

      {selectedSegmentId && routes.length > 0 && (
        <SegmentPeek
          segmentId={selectedSegmentId}
          segments={model.segments}
          onDetails={() => openBreakdown('segments')}
          onClose={() => setSelectedSegmentId(null)}
        />
      )}

      <EvidenceModal
        open={evidenceOpen}
        onClose={() => setEvidenceOpen(false)}
        observations={observations}
        showSimulated={false}
        defaultLocation={(model.origin ?? model.destination) ?? VALLEY}
        currentISO={new Date(nowMs).toISOString().replace(/\.\d{3}Z$/, 'Z')}
        forecast={forecast}
        segments={model.segments}
        onAdd={(obs) => {
          model.addObservation(obs);
          setEvidenceOpen(false);
          setToast('Your evidence was added. Nearby segments were updated.');
        }}
        onError={(message) => setToast(message)}
      />

      <BreakdownDrawer
        open={breakdownOpen}
        onClose={() => setBreakdownOpen(false)}
        comparison={comparison}
        routes={routes}
        segments={model.segments}
        sweep={model.sweep}
        selectedSegmentId={selectedSegmentId}
        onSelectSegment={setSelectedSegmentId}
        sensitivity={model.sensitivityReport}
        onRunSensitivity={model.runSensitivity}
        fittedBias={model.fittedBias}
        params={currentEngineParams()}
        openSection={breakdownSection}
        onApplyFittedBias={(bias) => {
          model.applyFittedBias(bias);
          setToast('Fitted bias correction applied to all computations.');
        }}
      />

      <DiaryModal
        open={diaryOpen}
        onClose={() => setDiaryOpen(false)}
        routes={routes}
        mode={model.mode}
        baselineRouteId={model.baselineRouteId}
        comparison={comparison}
        forecast={forecast}
        departISO={departISO}
        onToast={setToast}
      />

      <SchoolModal
        open={schoolOpen}
        onClose={() => setSchoolOpen(false)}
        forecast={forecast}
        segments={model.segments}
        destination={model.destination}
      />

      <DemoTourModal open={demoOpen} onClose={() => setDemoOpen(false)} routes={routes} />

      {dockPanel && dockPanel !== 'method' && dockPanel !== 'evidence' && (
        <ComingSoonPanel panel={dockPanel} onClose={() => setDockPanel(null)} />
      )}
    </div>
  );
}

/** Honest first-run state. Never fabricates a route to fill the space. */
function EmptyState({
  hasTrip,
  routing,
  error,
  onRetry,
  onUseMyLocation,
}: {
  hasTrip: boolean;
  routing: boolean;
  error: string | null;
  onRetry: () => void;
  onUseMyLocation: () => void;
}) {
  return (
    <div className="pointer-events-none absolute inset-0 z-[1050] flex items-center justify-center px-6">
      <div className="pointer-events-auto max-w-sm rounded-2xl bg-white/90 p-5 text-center shadow-lg ring-1 ring-slate-300 backdrop-blur dark:bg-slate-900/90 dark:ring-slate-600">
        {routing ? (
          <>
            <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">
              Finding real routes…
            </h2>
            <p className="mt-1.5 text-xs text-slate-600 dark:text-slate-300">
              Live OpenStreetMap routing for your actual start and destination.
            </p>
          </>
        ) : error ? (
          <>
            <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">
              Could not plan that trip
            </h2>
            <p className="mt-1.5 text-xs text-slate-600 dark:text-slate-300">{error}</p>
            <button
              type="button"
              onClick={onRetry}
              className="mt-3 rounded-lg bg-emerald-600 px-4 py-2 text-xs font-semibold text-white hover:bg-emerald-500"
            >
              Try again
            </button>
          </>
        ) : (
          <>
            <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">
              Plan a real commute
            </h2>
            <p className="mt-1.5 text-xs leading-relaxed text-slate-600 dark:text-slate-300">
              Set your start point and destination. Routes come from live OpenStreetMap data, and
              the app compares modeled relative exposure between them.
            </p>
            <button
              type="button"
              onClick={onUseMyLocation}
              className="mt-3 rounded-lg bg-emerald-600 px-4 py-2 text-xs font-semibold text-white hover:bg-emerald-500"
            >
              Use my live location
            </button>
            {!hasTrip && (
              <p className="mt-2 text-[11px] text-slate-500 dark:text-slate-400">
                …or search for both places in the panel above.
              </p>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/** Friendly one-liner when a segment is tapped on the map. */
function SegmentPeek({
  segmentId,
  segments,
  onDetails,
  onClose,
}: {
  segmentId: string;
  segments: Array<{ id: string; roadClass: string }>;
  onDetails: () => void;
  onClose: () => void;
}) {
  const seg = segments.find((s) => s.id === segmentId);
  if (!seg) return null;
  const mainRoad =
    seg.roadClass === 'trunk' || seg.roadClass === 'primary' || seg.roadClass === 'secondary';
  const text = mainRoad
    ? 'Busy road · higher modeled exposure on this stretch'
    : 'Quieter street · lower modeled exposure here';

  return (
    <div className="pointer-events-auto absolute bottom-36 left-1/2 z-[1100] w-[min(20rem,calc(100vw-2rem))] -translate-x-1/2 rounded-2xl bg-white/90 px-3 py-2.5 shadow-lg ring-1 ring-slate-300 dark:bg-slate-900/90 dark:ring-slate-600">
      <div className="flex items-start gap-2">
        <p className="flex-1 text-xs font-medium text-slate-800 dark:text-slate-100">{text}</p>
        <button
          type="button"
          onClick={onClose}
          aria-label="Dismiss"
          className="rounded p-0.5 text-slate-500 hover:text-slate-800 dark:hover:text-slate-100"
        >
          ✕
        </button>
      </div>
      <button
        type="button"
        onClick={onDetails}
        className="mt-1 text-[11px] font-semibold text-emerald-700 underline underline-offset-2 dark:text-emerald-400"
      >
        Details
      </button>
    </div>
  );
}

function ComingSoonPanel({ panel, onClose }: { panel: DockId; onClose: () => void }) {
  const titles: Record<string, string> = { diary: 'Diary', school: 'School', demo: 'Demo tour' };
  return (
    <div className="fixed inset-0 z-[1400] flex items-end justify-center sm:items-center">
      <button type="button" aria-label="Close" onClick={onClose} className="absolute inset-0 bg-slate-900/20" />
      <div
        role="dialog"
        aria-modal="true"
        className="relative w-full max-w-md rounded-2xl bg-white/95 p-4 shadow-xl ring-1 ring-slate-300 dark:bg-slate-900/95 dark:ring-slate-600"
      >
        <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
          {titles[panel] ?? panel}
        </h2>
        <button
          type="button"
          onClick={onClose}
          className="mt-2 rounded-lg bg-slate-100 px-3 py-1.5 text-xs text-slate-800 dark:bg-slate-800 dark:text-slate-100"
        >
          Close
        </button>
      </div>
    </div>
  );
}

export { engine };
export type { LatLon };