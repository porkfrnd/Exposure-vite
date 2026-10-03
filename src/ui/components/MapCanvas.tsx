/**
 * The map canvas — always mounted, full-bleed, Google-Maps-style.
 *
 * WHY THIS FILE IS ALWAYS RENDERED:
 *   An earlier version mounted the map only once routes existed. With no trip
 *   planned the user got a blank dark page (Leaflet never initialised, so
 *   invalidateSize had nothing to size). The map is now unconditional; the UI
 *   floats over it and the map is interactive from the very first paint.
 *
 * Container CSS is explicit and inline (width/height/position/inset/z-index)
 * rather than relying on Tailwind class resolution, because a missing utility
 * silently collapses the container to 0×0 and produces exactly that blank map.
 */

import { useCallback, useEffect, useRef } from 'react';
import L from 'leaflet';
import type { LatLon, Observation, Route } from '@/contracts';
import type { Theme } from '../theme/useTheme';

const OSM_TILES = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
const ATTRIBUTION = '&copy; OpenStreetMap contributors';

/** Fallback tile so a dead network shows a message, not a void. */
const ERROR_TILE =
  'data:image/svg+xml;base64,' +
  btoa(
    '<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256">' +
      '<rect width="256" height="256" fill="#e2e8f0"/>' +
      '<text x="128" y="128" font-family="sans-serif" font-size="13" ' +
      'text-anchor="middle" fill="#64748b">base map unavailable</text></svg>',
  );

const DEFAULT_VIEW: LatLon = { lat: 27.7172, lon: 85.324 };
const DEFAULT_ZOOM = 13;

export interface SegmentStyle {
  routeId: string;
  color: string;
  recommended: boolean;
  dimmed: boolean;
  confidence: number;
}

export interface RouteLabel {
  routeId: string;
  name: string;
  minutes: number;
  lat: number;
  lon: number;
  recommended: boolean;
  dimmed: boolean;
}

/** Imperative handle so the shell can drive the map without prop churn. */
export interface MapHandle {
  flyTo: (lat: number, lon: number, zoom?: number) => void;
  invalidate: () => void;
}

export interface MapCanvasProps {
  theme: Theme;
  routes: Route[];
  styles: Record<string, SegmentStyle>;
  routeLabels: RouteLabel[];
  selectedPlace: LatLon | null;
  liveLocation: LatLon | null;
  /** Origin/destination endpoints drawn as pins. */
  origin: LatLon | null;
  destination: LatLon | null;
  observations: Observation[];
  onMapClick: (lat: number, lon: number) => void;
  onTileFailure?: () => void;
  handleRef?: (handle: MapHandle | null) => void;
}

export function MapCanvas(props: MapCanvasProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<L.Map | null>(null);
  const routeLayerRef = useRef<L.LayerGroup | null>(null);
  const labelLayerRef = useRef<L.LayerGroup | null>(null);
  const pinLayerRef = useRef<L.LayerGroup | null>(null);
  const clickRef = useRef(props.onMapClick);
  clickRef.current = props.onMapClick;
  const tileFailRef = useRef(props.onTileFailure);
  tileFailRef.current = props.onTileFailure;

  // ── Create once, tear down fully (StrictMode double-invokes effects) ──────
  useEffect(() => {
    const el = containerRef.current;
    if (!el || mapRef.current) return;

    const map = L.map(el, {
      zoomControl: false, // we render our own controls
      attributionControl: true,
      preferCanvas: true,
    }).setView([DEFAULT_VIEW.lat, DEFAULT_VIEW.lon], DEFAULT_ZOOM);

    mapRef.current = map;
    routeLayerRef.current = L.layerGroup().addTo(map);
    labelLayerRef.current = L.layerGroup().addTo(map);
    pinLayerRef.current = L.layerGroup().addTo(map);

    map.on('click', (e: L.LeafletMouseEvent) => {
      clickRef.current(e.latlng.lat, e.latlng.lng);
    });

    // Leaflet measures its container on creation; a container that is still
    // settling (flex/grid, mobile URL bar) yields a 0×0 canvas. Re-measure on the
    // next frames and on every resize.
    const raf = requestAnimationFrame(() => {
      map.invalidateSize({ animate: false });
      requestAnimationFrame(() => map.invalidateSize({ animate: false }));
    });
    const onResize = () => map.invalidateSize({ animate: false });
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(onResize) : null;
    ro?.observe(el);
    window.addEventListener('resize', onResize);
    window.addEventListener('orientationchange', onResize);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', onResize);
      window.removeEventListener('orientationchange', onResize);
      ro?.disconnect();
      map.remove();
      mapRef.current = null;
      routeLayerRef.current = null;
      labelLayerRef.current = null;
      pinLayerRef.current = null;
    };
  }, []);

  // ── Imperative handle ────────────────────────────────────────────────────
  useEffect(() => {
    const handle: MapHandle = {
      flyTo: (lat, lon, zoom) => {
        const map = mapRef.current;
        if (!map) return;
        map.invalidateSize({ animate: false });
        map.flyTo([lat, lon], zoom ?? Math.max(map.getZoom(), 15), {
          duration: 0.8,
        });
      },
      invalidate: () => mapRef.current?.invalidateSize({ animate: false }),
    };
    props.handleRef?.(handle);
    return () => props.handleRef?.(null);
  }, [props]);

  // ── Basemap (single keyless source; dark mode via CSS filter) ────────────
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    let errs = 0;
    const layer = L.tileLayer(OSM_TILES, {
      attribution: ATTRIBUTION,
      maxZoom: 19,
      errorTileUrl: ERROR_TILE,
    });
    layer.on('tileerror', () => {
      if (++errs === 8) tileFailRef.current?.();
    });
    layer.addTo(map);
    map.getPane('tilePane')?.classList.toggle('dark-tiles', props.theme === 'dark');
    return () => {
      map.removeLayer(layer);
    };
  }, [props.theme]);

  // ── Route polylines ──────────────────────────────────────────────────────
  useEffect(() => {
    const layer = routeLayerRef.current;
    if (!layer) return;
    layer.clearLayers();

    const casing = props.theme === 'dark' ? '#0f172a' : '#ffffff';

    for (const route of props.routes) {
      for (const seg of route.segments) {
        const style = props.styles[seg.id];
        if (!style) continue;
        const latlngs = seg.coords.map((c) => [c.lat, c.lon] as [number, number]);
        const lowConfidence = style.confidence < 0.3;
        const weight = style.recommended ? 11 : style.dimmed ? 5 : 8;
        const opacity = style.dimmed ? 0.6 : 1;

        // Casing first so the colour reads on any basemap.
        L.polyline(latlngs, {
          color: casing,
          weight: weight + 4,
          opacity: Math.min(1, opacity + 0.2),
          lineCap: 'round',
          lineJoin: 'round',
          interactive: false,
        }).addTo(layer);

        L.polyline(latlngs, {
          color: style.color,
          weight,
          opacity,
          dashArray: lowConfidence ? '2 7' : undefined,
          lineCap: 'round',
          lineJoin: 'round',
          interactive: false,
        }).addTo(layer);
      }
    }
  }, [props.routes, props.styles, props.theme]);

  // ── Route name chips ─────────────────────────────────────────────────────
  useEffect(() => {
    const layer = labelLayerRef.current;
    if (!layer) return;
    layer.clearLayers();
    const dark = props.theme === 'dark';

    for (const label of props.routeLabels) {
      L.marker([label.lat, label.lon], {
        icon: L.divIcon({
          className: '',
          html: routeChipHtml(
            `${label.name} · ${Math.round(label.minutes)} min`,
            dark,
            label.recommended,
            label.dimmed,
          ),
          iconSize: [0, 0],
          iconAnchor: [0, 0],
        }),
        interactive: false,
        keyboard: false,
      }).addTo(layer);
    }
  }, [props.routeLabels, props.theme]);

  // ── Pins: live location, endpoints, selected place, user evidence ─────────
  useEffect(() => {
    const layer = pinLayerRef.current;
    if (!layer) return;
    layer.clearLayers();
    const dark = props.theme === 'dark';

    if (props.liveLocation) {
      // Accuracy halo.
      L.circle([props.liveLocation.lat, props.liveLocation.lon], {
        radius: 22,
        color: '#3b82f6',
        weight: 1,
        fillColor: '#3b82f6',
        fillOpacity: 0.15,
        interactive: false,
      }).addTo(layer);
      // Pulsing dot.
      L.marker([props.liveLocation.lat, props.liveLocation.lon], {
        icon: L.divIcon({
          className: '',
          html:
            '<span class="live-dot" style="display:block;width:16px;height:16px;' +
            'border-radius:9999px;background:#3b82f6;border:2px solid #fff;' +
            'box-shadow:0 1px 3px rgba(0,0,0,.4)"></span>',
          iconSize: [16, 16],
          iconAnchor: [8, 8],
        }),
        interactive: false,
        keyboard: false,
        zIndexOffset: 1000,
      }).addTo(layer);
    }

    if (props.origin) {
      L.circleMarker([props.origin.lat, props.origin.lon], {
        radius: 7,
        color: '#0f172a',
        weight: 2,
        fillColor: '#22c55e',
        fillOpacity: 1,
      })
        .bindTooltip('Start', { direction: 'top' })
        .addTo(layer);
    }

    if (props.destination) {
      L.circleMarker([props.destination.lat, props.destination.lon], {
        radius: 7,
        color: '#0f172a',
        weight: 2,
        fillColor: '#ef4444',
        fillOpacity: 1,
      })
        .bindTooltip('Destination', { direction: 'top' })
        .addTo(layer);
    }

    if (props.selectedPlace && !props.destination) {
      L.marker([props.selectedPlace.lat, props.selectedPlace.lon], {
        icon: L.divIcon({
          className: '',
          html: placePinHtml(dark),
          iconSize: [26, 34],
          iconAnchor: [13, 32],
        }),
        interactive: false,
        keyboard: false,
        zIndexOffset: 900,
      }).addTo(layer);
    }

    for (const obs of props.observations) {
      const isPhoto = obs.kind === 'photo';
      const fill = isPhoto ? '#6366f1' : obs.report === 'clear' ? '#22c55e' : '#a855f7';
      const glyph = isPhoto ? cameraSvg : obs.report === 'clear' ? checkSvg : smokeSvg;
      L.marker([obs.lat, obs.lon], {
        icon: L.divIcon({
          className: '',
          html: pinHtml(glyph, fill, dark),
          iconSize: [18, 18],
          iconAnchor: [9, 9],
        }),
        interactive: true,
        keyboard: false,
      })
        .bindTooltip(isPhoto ? 'Your haze photo' : `Your report: ${obs.report}`, {
          direction: 'top',
        })
        .addTo(layer);
    }
  }, [
    props.liveLocation,
    props.origin,
    props.destination,
    props.selectedPlace,
    props.observations,
    props.theme,
  ]);

  // ── Fit routes when they first arrive ───────────────────────────────────
  const fittedFor = useRef('');
  useEffect(() => {
    const map = mapRef.current;
    if (!map || props.routes.length === 0) return;
    const key = props.routes.map((r) => r.id).join(',');
    if (fittedFor.current === key) return;
    fittedFor.current = key;

    const bounds = L.latLngBounds([]);
    for (const r of props.routes) {
      for (const s of r.segments) for (const c of s.coords) bounds.extend([c.lat, c.lon]);
    }
    if (bounds.isValid()) {
      map.invalidateSize({ animate: false });
      map.fitBounds(bounds, { padding: [70, 70] });
    }
  }, [props.routes]);

  const zoomBy = useCallback((delta: number) => {
    const map = mapRef.current;
    if (!map) return;
    map.setZoom(map.getZoom() + delta);
  }, []);

  return (
    <>
      {/* The canvas. Inline styles guarantee non-zero dimensions. */}
      <div
        id="map"
        ref={containerRef}
        style={{
          position: 'absolute',
          inset: 0,
          width: '100vw',
          height: '100vh',
          zIndex: 0,
          background: '#e2e8f0',
        }}
      />

      {/* Custom zoom controls (bottom-right, above the map). */}
      <div
        style={{ position: 'absolute', right: 12, bottom: 148, zIndex: 10 }}
        className="flex flex-col overflow-hidden rounded-lg border border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-900"
      >
        <button
          type="button"
          onClick={() => zoomBy(1)}
          aria-label="Zoom in"
          title="Zoom in"
          className="px-3 py-2 text-lg leading-none text-slate-700 hover:bg-slate-100 dark:text-slate-200 dark:hover:bg-slate-800"
        >
          +
        </button>
        <div className="h-px bg-slate-200 dark:bg-slate-700" />
        <button
          type="button"
          onClick={() => zoomBy(-1)}
          aria-label="Zoom out"
          title="Zoom out"
          className="px-3 py-2 text-lg leading-none text-slate-700 hover:bg-slate-100 dark:text-slate-200 dark:hover:bg-slate-800"
        >
          −
        </button>
      </div>
    </>
  );
}

// ── Inline SVG / HTML for markers ────────────────────────────────────────────

const cameraSvg = `<svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="white" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M14.5 4h-5L8 6H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-4l-1.5-2Z"/><circle cx="12" cy="12.5" r="3.2"/></svg>`;
const checkSvg = `<svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="white" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>`;
const smokeSvg = `<svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="white" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M4 16h11a3 3 0 0 0 0-6h-1a4 4 0 0 0-7.5-1.5"/><path d="M4 20h13a3 3 0 0 0 3-3"/></svg>`;

function pinHtml(glyph: string, fill: string, dark: boolean): string {
  const ring = dark ? 'rgba(255,255,255,0.85)' : 'rgba(15,23,42,0.85)';
  return (
    `<span style="display:block;width:18px;height:18px;border-radius:9999px;background:${fill};` +
    `border:2px solid ${ring};box-shadow:0 1px 3px rgba(0,0,0,.35);` +
    `display:flex;align-items:center;justify-content:center">${glyph}</span>`
  );
}

/** Classic teardrop pin for the selected place. */
function placePinHtml(dark: boolean): string {
  const fill = dark ? '#0f172a' : '#ffffff';
  const stroke = dark ? '#38bdf8' : '#0369a1';
  return (
    `<svg viewBox="0 0 26 34" width="26" height="34" style="filter:drop-shadow(0 2px 3px rgba(0,0,0,.35))">` +
    `<path d="M13 33C13 33 25 21.5 25 13a12 12 0 1 0-24 0C1 21.5 13 33 13 33Z" fill="${fill}" stroke="${stroke}" stroke-width="2.5"/>` +
    `<circle cx="13" cy="13" r="4.5" fill="${stroke}"/></svg>`
  );
}

function routeChipHtml(
  text: string,
  dark: boolean,
  recommended: boolean,
  dimmed: boolean,
): string {
  const bg = recommended
    ? '#059669'
    : dimmed
      ? dark
        ? 'rgba(15,23,42,0.8)'
        : 'rgba(255,255,255,0.95)'
      : dark
        ? 'rgba(15,23,42,0.92)'
        : '#ffffff';
  const fg = recommended ? '#ffffff' : dark ? '#e2e8f0' : '#0f172a';
  const border = recommended
    ? '#059669'
    : dark
      ? 'rgba(148,163,184,0.5)'
      : 'rgba(15,23,42,0.15)';
  const opacity = dimmed ? 0.75 : 1;
  return (
    `<span style="position:relative;display:block;white-space:nowrap;` +
    `transform:translate(-50%,-50%);opacity:${opacity}">` +
    `<span style="display:inline-flex;align-items:center;border-radius:9999px;background:${bg};` +
    `color:${fg};border:1px solid ${border};padding:2px 8px;` +
    `font:600 10px/1.4 ui-sans-serif,system-ui,sans-serif">${text}</span></span>`
  );
}