/**
 * EXPOSURE VITE — App shell.
 *
 * The map is the page (fixed, full viewport, no scroll). Everything else is a
 * floating overlay card above it, so the map stays draggable and zoomable
 * everywhere except on the cards themselves.
 *
 * FIRST-SCREEN RULE: the planner, the summary and the map are the only things a
 * first-time user sees, and they contain no technical jargon. All model internals
 * live behind "View Scientific Breakdown".
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { MapView } from './map/MapView';
import type { RouteLabel, SegmentStyle } from './map/MapView';
import { exposureColor, extentOf } from './map/ramp';
import { PlannerCard } from './cards/PlannerCard';
import { RouteSummaryCard } from './cards/RouteSummaryCard';
import { BreakdownDrawer, currentEngineParams } from './cards/BreakdownDrawer';
import { FeatureDock, HonestyPill, MapLegend, SimulatedToggle } from './cards/Dock';
import type { DockId } from './cards/Dock';
import { EvidenceModal } from './cards/EvidenceModal';
import { useExposureModel } from './state/useExposureModel';
import { useTheme } from './theme/useTheme';
import { engine, formatLocalTime } from './wiring';
import type { SweepPoint } from '@/contracts';

export function App() {
  const model = useExposureModel();
  const { theme, toggle } = useTheme();

  const [selectedSegmentId, setSelectedSegmentId] = useState<string | null>(null);
  const [breakdownOpen, setBreakdownOpen] = useState(false);
  const [breakdownSection, setBreakdownSection] = useState<string | undefined>(undefined);
  const [summaryCollapsed, setSummaryCollapsed] = useState(false);
  const [evidenceOpen, setEvidenceOpen] = useState(false);
  const [dockPanel, setDockPanel] = useState<DockId | null>(null);
  const [showSimulated, setShowSimulated] = useState(true);
  const [tileFailed, setTileFailed] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  const { comparison, routes, observations, forecast, departISO, nowMs } = model;

  /**
   * The verdict driving the headline. Mirrors the engine's own fallback: if nothing
   * reached 'recommend' but something reached 'slight', the slight lean is shown.
   */
  const headlineVerdict = useMemo((): 'recommend' | 'slight' | 'none' => {
    if (!comparison || !comparison.bestRouteId) return 'none';
    const best = comparison.versus.find((v) => v.routeId === comparison.bestRouteId);
    if (!best || best.verdict === 'none') {
      const slight = comparison.versus.find((v) => v.verdict === 'slight');
      return slight ? 'slight' : 'none';
    }
    return best.verdict;
  }, [comparison]);

  // ── Segment styling: colour by RELATIVE modeled exposure, min→max on screen ──
  const styles = useMemo<Record<string, SegmentStyle>>(() => {
    const out: Record<string, SegmentStyle> = {};
    if (!comparison) return out;

    /**
     * The exposure index is the modeled concentration on the segment (µg/m³). That
     * is exactly the quantity the map colour is meant to show, so it is stated
     * plainly rather than being a composite the UI would have to explain.
     */
    const exposureById = new Map<string, number>();
    for (const trip of comparison.trips) {
      for (const seg of trip.segments) {
        if (!Number.isFinite(seg.concentration)) continue;
        // A shared segment has one exposure; the first consistent reading wins.
        if (!exposureById.has(seg.segmentId)) {
          exposureById.set(seg.segmentId, seg.concentration);
        }
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
        const share =
          trip.segments.length > 0 ? 1 / trip.segments.length : 1 / Math.max(1, trip.segments.length);
        const minutesHere = trip.durationMin * share;

        out[seg.segmentId] = {
          routeId: trip.routeId,
          routeName: route.name,
          color: exposureColor(exposure, min, max),
          minutesLabel: `${Math.round(minutesHere)} min`,
          confidence: seg.confidence,
          recommended,
          dimmed,
        };
      }
    }

    return out;
  }, [comparison, routes]);

  // ── Midpoint label for each route: name + minutes ─────────────────────────
  const routeLabels = useMemo<RouteLabel[]>(() => {
    if (!comparison) return [];
    const out: RouteLabel[] = [];
    const total = Math.max(1, comparison.trips.length);

    comparison.trips.forEach((trip, index) => {
      const route = routes.find((r) => r.id === trip.routeId);
      if (!route || route.segments.length === 0) return;

      /**
       * The three demo routes share most of their corridor, so a chip at the same
       * fraction on each would land on the same pixels and hide one another. Spread
       * them along their own route AND nudge each perpendicular to the direction of
       * travel, so every chip is legible.
       */
      const fraction = 0.38 + (index / total) * 0.24;
      const segIdx = Math.min(
        route.segments.length - 1,
        Math.max(0, Math.round(fraction * (route.segments.length - 1))),
      );
      const seg = route.segments[segIdx];
      const coordIdx = Math.min(seg.coords.length - 1, Math.max(0, Math.floor(seg.coords.length / 2)));
      const coord = seg.coords[coordIdx];
      if (!coord) return;

      // Perpendicular direction of travel along this segment, in degrees.
      const a = seg.coords[Math.max(0, coordIdx - 1)];
      const b = seg.coords[Math.min(seg.coords.length - 1, coordIdx + 1)];
      const bearing = Math.atan2(b.lon - a.lon, b.lat - a.lat);
      const nudgeM = (index - (total - 1) / 2) * 55;

      out.push({
        routeId: trip.routeId,
        name: route.name,
        minutes: trip.durationMin,
        lat: coord.lat + (nudgeM * Math.cos(bearing)) / 111_320,
        lon: coord.lon + (nudgeM * Math.sin(bearing)) / (111_320 * Math.cos((coord.lat * Math.PI) / 180)),
        recommended: comparison.bestRouteId === trip.routeId,
        dimmed: comparison.bestRouteId !== trip.routeId && trip.routeId !== comparison.baselineRouteId,
      });
    });

    return out;
  }, [comparison, routes]);

  // ── Departure labels ─────────────────────────────────────────────────────
  const departureLabel = useMemo(() => formatLocalTime(departISO), [departISO]);

  const departureShort = useMemo(() => {
    if (model.offsetMin === 0) return 'Leave now';
    const h = Math.floor(model.offsetMin / 60);
    const m = model.offsetMin % 60;
    if (h > 0 && m > 0) return `Leave in ${h} h ${m} min`;
    if (h > 0) return `Leave in ${h} h`;
    return `Leave in ${m} min`;
  }, [model.offsetMin]);

  // ── Best-time hint, only when the sweep genuinely supports it ─────────────
  const bestTimeHint = useMemo((): string | null => {
    const sweep: SweepPoint[] = model.sweep;
    if (sweep.length < 2) return null;
    if (headlineVerdict !== 'recommend') return null;

    // Only look FORWARD from the current selection, and only accept a later
    // departure the engine itself rates as a 'recommend'.
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

  // ── Transient toast ──────────────────────────────────────────────────────
  useEffect(() => {
    if (!toast) return;
    const t = window.setTimeout(() => setToast(null), 4200);
    return () => window.clearTimeout(t);
  }, [toast]);

  const openBreakdown = useCallback((section?: string) => {
    setBreakdownSection(section);
    setBreakdownOpen(true);
  }, []);

  const handleDockOpen = useCallback((id: DockId) => {
    if (id === 'method') {
      openBreakdown('how');
      return;
    }
    if (id === 'evidence') {
      setEvidenceOpen(true);
      return;
    }
    setDockPanel(id);
  }, [openBreakdown]);

  const openSegmentDetails = useCallback(() => {
    openBreakdown('segments');
  }, [openBreakdown]);

  if (model.state === 'loading') {
    return (
      <div className="flex h-dvh items-center justify-center bg-slate-100 dark:bg-slate-950">
        <div className="flex flex-col items-center gap-3">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-slate-300 border-t-emerald-600 dark:border-slate-700 dark:border-t-emerald-400" />
          <p className="text-sm text-slate-600 dark:text-slate-300">Loading the modeled forecast…</p>
        </div>
      </div>
    );
  }

  if (model.state === 'error') {
    return (
      <div className="flex h-dvh items-center justify-center bg-slate-100 p-6 dark:bg-slate-950">
        <div className="max-w-sm text-center">
          <h1 className="text-lg font-semibold text-slate-900 dark:text-slate-100">
            Could not start
          </h1>
          <p className="mt-2 text-sm text-slate-600 dark:text-slate-300">
            {model.error ?? 'Something went wrong while loading.'}
          </p>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="mt-4 rounded-xl bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-500"
          >
            Reload
          </button>
        </div>
      </div>
    );
  }

  const visibleObservations = showSimulated
    ? observations
    : observations.filter((o) => !o.isSimulated);

  return (
    <div className="relative h-dvh w-screen overflow-hidden">
      <MapView
        routes={routes}
        styles={styles}
        routeLabels={routeLabels}
        selectedSegmentId={selectedSegmentId}
        onSelectSegment={setSelectedSegmentId}
        origin={model.origin}
        destination={model.destination}
        school={model.school}
        observations={visibleObservations}
        showSimulated={showSimulated}
        theme={theme}
        onTileFailure={() => setTileFailed(true)}
      />

      <HonestyPill source={forecast?.source ?? null} />

      <PlannerCard
        routes={routes}
        mode={model.mode}
        onModeChange={model.setMode}
        baselineRouteId={model.baselineRouteId}
        onBaselineChange={model.setBaselineRouteId}
        offsetMin={model.offsetMin}
        onOffsetChange={model.setOffsetMin}
        departureLabel={departureLabel}
        departureShort={departureShort}
        busy={comparison === null}
      />

      <FeatureDock
        theme={theme}
        onToggleTheme={toggle}
        onOpen={handleDockOpen}
        onAddEvidence={() => setEvidenceOpen(true)}
      />

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

      {/* Stacked above Leaflet's own bottom-right controls so nothing overlaps. */}
      <div className={`pointer-events-auto absolute bottom-[5.75rem] right-3 z-[1100] flex flex-col items-end gap-1.5 sm:bottom-[6rem] sm:right-6`}>
        <SimulatedToggle show={showSimulated} onToggle={setShowSimulated} />
        <MapLegend />
      </div>

      {tileFailed && (
        <p className="pointer-events-none absolute bottom-40 left-1/2 z-[1100] -translate-x-1/2 rounded-full bg-amber-100 px-3 py-1 text-[11px] font-medium text-amber-900 ring-1 ring-amber-400 dark:bg-amber-500/20 dark:text-amber-200 dark:ring-amber-400/40">
          Base map could not load — routes are still shown.
        </p>
      )}

      {toast && (
        <div
          role="status"
          className="pointer-events-auto absolute left-1/2 top-24 z-[1400] -translate-x-1/2 rounded-xl bg-slate-900/90 px-3 py-2 text-xs font-medium text-white shadow-lg dark:bg-slate-100/95 dark:text-slate-900"
        >
          {toast}
        </div>
      )}

      <SegmentPeek
        segmentId={selectedSegmentId}
        segments={model.segments}
        onDetails={openSegmentDetails}
        onClose={() => setSelectedSegmentId(null)}
      />

      <EvidenceModal
        open={evidenceOpen}
        onClose={() => setEvidenceOpen(false)}
        observations={observations}
        showSimulated={showSimulated}
        defaultLocation={model.origin}
        currentISO={new Date(nowMs).toISOString().replace(/\.\d{3}Z$/, 'Z')}
        forecast={forecast}
        segments={model.segments}
        onAdd={(obs) => {
          model.addObservation(obs);
          setEvidenceOpen(false);
          setToast(
            obs.isSimulated
              ? 'Simulated demo observation added.'
              : 'Your evidence was added. Nearby segments were updated.',
          );
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
        sensitivity={model.sensitivity}
        onRunSensitivity={model.runSensitivity}
        fittedBias={model.fittedBias}
        params={currentEngineParams()}
        openSection={breakdownSection}
      />

      {dockPanel && dockPanel !== 'method' && dockPanel !== 'evidence' && (
        <ComingSoonPanel panel={dockPanel} onClose={() => setDockPanel(null)} />
      )}
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
  segmentId: string | null;
  segments: Array<{ id: string; roadClass: string; lengthM: number; features: { greenFraction100m: number; distToMainRoadM: number } }>;
  onDetails: () => void;
  onClose: () => void;
}) {
  const seg = segments.find((s) => s.id === segmentId);
  if (!seg) return null;

  const mainRoad = seg.roadClass === 'trunk' || seg.roadClass === 'primary' || seg.roadClass === 'secondary';
  const green = seg.features.greenFraction100m;
  const nearMain = seg.features.distToMainRoadM <= 80;

  const text = mainRoad
    ? 'Busy road · higher modeled exposure on this stretch'
    : green > 0.5 && nearMain
      ? 'Green path, but close to a busy road'
      : green > 0.5
        ? 'Quiet green path · lower modeled exposure here'
        : 'Quiet street · lower modeled exposure here';

  return (
    <div className="pointer-events-auto absolute bottom-36 left-1/2 z-[1100] w-[min(20rem,calc(100vw-2rem))] -translate-x-1/2 rounded-2xl bg-white/90 px-3 py-2.5 shadow-xl ring-1 ring-slate-300 backdrop-blur dark:bg-slate-900/90 dark:ring-slate-600">
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
        className="mt-1 text-[11px] font-semibold text-emerald-700 underline underline-offset-2 hover:text-emerald-600 dark:text-emerald-400"
      >
        Details
      </button>
    </div>
  );
}

/** Placeholder shell for the Phase 6 dock panels. */
function ComingSoonPanel({ panel, onClose }: { panel: DockId; onClose: () => void }) {
  const titles: Record<string, string> = {
    diary: 'Diary',
    school: 'School',
    demo: 'Demo tour',
  };
  return (
    <div className="fixed inset-0 z-[1400] flex items-end justify-center sm:items-center">
      <button type="button" aria-label="Close" onClick={onClose} className="absolute inset-0 bg-slate-900/20" />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={titles[panel] ?? panel}
        className="relative w-full max-w-md rounded-t-2xl bg-white/95 p-4 shadow-2xl ring-1 ring-slate-300 dark:bg-slate-900/95 dark:ring-slate-600"
      >
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
            {titles[panel] ?? panel}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg px-2 py-1 text-xs text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800"
          >
            Close
          </button>
        </div>
        <p className="mt-2 text-xs text-slate-600 dark:text-slate-300">
          Arriving in a later phase.
        </p>
      </div>
    </div>
  );
}

// Re-export so the engine's verdict wording stays in one place if it changes.
export { engine };