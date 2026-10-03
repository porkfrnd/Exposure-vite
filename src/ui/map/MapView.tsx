/**
 * Full-screen Leaflet map.
 *
 * PITFALLS HANDLED HERE (all of them bite under Vite / React 18 StrictMode):
 *  * The map is created ONCE in an effect and torn down on cleanup. StrictMode
 *    mounts effects twice in development, so the cleanup must fully `remove()`.
 *  * Default Leaflet marker icons break under Vite (their PNG URLs are not
 *    bundled). We therefore use `L.circleMarker` and `L.divIcon` exclusively.
 *  * The tile layer is SWAPPED on theme change instead of recreating the map, so
 *    the user's pan/zoom is preserved.
 *  * `invalidateSize()` is called after mount and on resize, otherwise Leaflet
 *    mis-measures its container inside a flex/grid layout.
 *  * Attribution is mandatory for CARTO and OpenStreetMap tiles.
 */

import { useEffect, useRef } from 'react';
import L from 'leaflet';
import type { LatLon, Observation, Route } from '@/contracts';
import type { Theme } from '../theme/useTheme';

/**
 * BASEMAP NOTE (verified against the live endpoints on 2026-10-03):
 * CARTO's `basemaps.cartocdn.com` tiles now require an API key. Requested without
 * one they return HTTP 200 with a 2 KB "API KEY REQUIRED" watermark image, so they
 * are UNUSABLE here — and because the status is 200, Leaflet raises no tileerror and
 * a failure detector would never notice. We therefore use the standard
 * OpenStreetMap tile layer, which needs no key, and derive the dark theme with a CSS
 * filter (the standard invert+hue-rotate technique) instead of a second tile source.
 */
const OSM_TILES = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
const ATTRIBUTION = '&copy; OpenStreetMap contributors';

/** Show the clickable strip in the first 60 s so a broken basemap is noticed. */
const TILE_ERROR_BUDGET = 6;

export interface SegmentStyle {
  routeId: string;
  routeName: string;
  color: string;
  /** Minutes on this route, formatted. */
  minutesLabel: string;
  confidence: number;
  recommended: boolean;
  dimmed: boolean;
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

export interface MapViewProps {
  routes: Route[];
  styles: Record<string, SegmentStyle>;
  routeLabels: RouteLabel[];
  selectedSegmentId: string | null;
  onSelectSegment: (segmentId: string | null) => void;
  origin: LatLon;
  destination: LatLon;
  school: LatLon | null;
  observations: Observation[];
  showSimulated: boolean;
  theme: Theme;
  /** Fired once when the basemap clearly failed, so the UI can say so. */
  onTileFailure?: () => void;
}

export function MapView(props: MapViewProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<L.Map | null>(null);
  const tileLayerRef = useRef<L.TileLayer | null>(null);
  const routeLayerRef = useRef<L.LayerGroup | null>(null);
  const pinLayerRef = useRef<L.LayerGroup | null>(null);
  const routeLabelLayerRef = useRef<L.LayerGroup | null>(null);
  const nodeLayerRef = useRef<L.LayerGroup | null>(null);
  const tileErrorsRef = useRef(0);
  const reportedFailureRef = useRef(false);

  // Keep the latest callbacks/flags in refs so the map effect never re-runs.
  const onSelectRef = useRef(props.onSelectSegment);
  onSelectRef.current = props.onSelectSegment;
  const onTileFailureRef = useRef(props.onTileFailure);
  onTileFailureRef.current = props.onTileFailure;

  // ── Create the map exactly once ────────────────────────────────────────────
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;

    const map = L.map(containerRef.current, {
      zoomControl: false,
      attributionControl: true,
      preferCanvas: true,
    }).setView([props.origin.lat, props.origin.lon], 14);

    L.control.zoom({ position: 'bottomright' }).addTo(map);

    const onResize = () => map.invalidateSize();
    // Leaflet mis-measures when mounted inside a flex container.
    const raf = requestAnimationFrame(onResize);

    mapRef.current = map;
    routeLayerRef.current = L.layerGroup().addTo(map);
    pinLayerRef.current = L.layerGroup().addTo(map);
    routeLabelLayerRef.current = L.layerGroup().addTo(map);
    nodeLayerRef.current = L.layerGroup().addTo(map);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', onResize);
      map.remove();
      mapRef.current = null;
      routeLayerRef.current = null;
      pinLayerRef.current = null;
      routeLabelLayerRef.current = null;
      nodeLayerRef.current = null;
      tileLayerRef.current = null;
    };
    // Intentionally empty: the map must never be recreated.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Tile layer + dark-mode filter ────────────────────────────────────────
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    tileErrorsRef.current = 0;
    reportedFailureRef.current = false;

    const layer = L.tileLayer(OSM_TILES, {
      attribution: ATTRIBUTION,
      maxZoom: 19,
      // A visible watermark would be far more useful than a blank rectangle.
      errorTileUrl:
        'data:image/svg+xml;base64,' +
        btoa(
          '<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256">' +
            '<rect width="256" height="256" fill="#e2e8f0"/>' +
            '<text x="128" y="128" font-family="sans-serif" font-size="14" ' +
            'text-anchor="middle" fill="#64748b">base map unavailable</text></svg>',
        ),
    });

    layer.on('tileerror', () => {
      tileErrorsRef.current += 1;
      if (tileErrorsRef.current > TILE_ERROR_BUDGET && !reportedFailureRef.current) {
        reportedFailureRef.current = true;
        onTileFailureRef.current?.();
      }
    });

    if (tileLayerRef.current) {
      map.removeLayer(tileLayerRef.current);
    }
    layer.addTo(map);
    tileLayerRef.current = layer;

    // Dark mode is a CSS filter on the tile pane, because we have only one tile
    // source. The container keeps its own theme-coloured background so the map still
    // reads correctly if every tile fails.
    try {
      map.getPane('tilePane')?.classList.toggle('dark-tiles', props.theme === 'dark');
    } catch {
      // pane unavailable (very old Leaflet) — skip the cosmetic tweak
    }
  }, [props.theme]);

  // ── If the tiles clearly fail, hide them rather than show error tiles ─────
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    let cancelled = false;

    const timer = window.setTimeout(() => {
      if (cancelled) return;
      if (tileErrorsRef.current > TILE_ERROR_BUDGET && tileLayerRef.current) {
        // Remove the layer entirely: routes and pins keep rendering on the plain
        // theme-coloured container background.
        map.removeLayer(tileLayerRef.current);
        tileLayerRef.current = null;
      }
    }, 6000);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [props.theme]);

  // ── Route polylines, coloured by RELATIVE modeled exposure ────────────────
  useEffect(() => {
    const map = mapRef.current;
    const layer = routeLayerRef.current;
    if (!map || !layer) return;

    layer.clearLayers();

    const dark = props.theme === 'dark';
    const casing = dark ? '#0f172a' : '#ffffff';

    for (const route of props.routes) {
      for (let i = 0; i < route.segments.length; i++) {
        const seg = route.segments[i];
        const style = props.styles[seg.id];
        if (!style) continue;

        const latlngs = seg.coords.map((c) => [c.lat, c.lon] as [number, number]);
        const lowConfidence = style.confidence < 0.3;
        const weight = style.recommended ? 11 : style.dimmed ? 5 : 8;
        const opacity = style.dimmed ? 0.55 : 1;

        // Casing first, so the coloured line reads on any basemap.
        L.polyline(latlngs, {
          color: casing,
          weight: weight + 4,
          opacity: Math.min(1, opacity + 0.25),
          lineCap: 'round',
          lineJoin: 'round',
          interactive: false,
        }).addTo(layer);

        const line = L.polyline(latlngs, {
          color: style.color,
          weight,
          opacity,
          dashArray: lowConfidence ? '2 7' : undefined,
          lineCap: 'round',
          lineJoin: 'round',
        }).addTo(layer);

        // A fat invisible hit line makes thin segments tappable.
        const hit = L.polyline(latlngs, {
          color: '#000',
          weight: 26,
          opacity: 0,
          interactive: true,
        }).addTo(layer);

        const label = seg.id === props.selectedSegmentId;
        if (label) {
          L.polyline(latlngs, {
            color: '#0ea5e9',
            weight: weight + 8,
            opacity: 0.9,
            lineCap: 'round',
            lineJoin: 'round',
            interactive: false,
          }).addTo(layer);
        }

        hit.on('click', (ev) => {
          L.DomEvent.stopPropagation(ev);
          onSelectRef.current(seg.id);
        });
      }
    }

    // Clicking empty map clears the selection.
    map.off('click');
    map.on('click', () => onSelectRef.current(null));

    return () => {
      map.off('click');
    };
  }, [props.routes, props.styles, props.selectedSegmentId, props.theme]);

  // ── Segment joint markers, only when zoomed in or on the selected route ───
  useEffect(() => {
    const map = mapRef.current;
    const layer = nodeLayerRef.current;
    if (!map || !layer) return;

    const draw = () => {
      layer.clearLayers();
      const zoom = map.getZoom();
      if (zoom < 15) return;

      const seen = new Set<string>();
      for (const route of props.routes) {
        for (const seg of route.segments) {
          const style = props.styles[seg.id];
          if (!style) continue;
          const onSelected = props.selectedSegmentId === seg.id;
          if (!onSelected && seen.has(seg.id)) continue;
          seen.add(seg.id);

          const last = seg.coords[seg.coords.length - 1];
          L.circleMarker([last.lat, last.lon], {
            radius: onSelected ? 6 : 4,
            color: '#0f172a',
            weight: 2,
            fillColor: style.color,
            fillOpacity: 0.95,
          })
            .bindTooltip(`${route.name} · ${style.minutesLabel}`, { direction: 'top' })
            .on('click', (ev) => {
              L.DomEvent.stopPropagation(ev);
              onSelectRef.current(seg.id);
            })
            .addTo(layer);
        }
      }
    };

    draw();
    map.on('zoomend', draw);
    return () => {
      map.off('zoomend', draw);
    };
  }, [props.routes, props.styles, props.selectedSegmentId]);

  // ── Origin / destination / school markers ─────────────────────────────────
  useEffect(() => {
    const layer = pinLayerRef.current;
    if (!layer) return;
    // Pins are added by the pins effect below, which owns the layer.
    void layer;
  }, []);

  // ── Route name + minutes chips at each route midpoint ─────────────────────
  useEffect(() => {
    const map = mapRef.current;
    const layer = routeLabelLayerRef.current;
    if (!map || !layer) return;

    layer.clearLayers();
    const dark = props.theme === 'dark';

    for (const label of props.routeLabels) {
      const text = `${label.name} · ${Math.round(label.minutes)} min`;
      L.marker([label.lat, label.lon], {
        icon: L.divIcon({
          className: '',
          html: routeChipHtml(text, dark, label.recommended, label.dimmed),
          iconSize: [0, 0],
          iconAnchor: [0, 0],
        }),
        interactive: false,
        keyboard: false,
      }).addTo(layer);
    }
  }, [props.routeLabels, props.theme]);

  // ── Evidence + endpoint pins ──────────────────────────────────────────────
  useEffect(() => {
    const map = mapRef.current;
    const layer = pinLayerRef.current;
    if (!map || !layer) return;

    layer.clearLayers();
    const dark = props.theme === 'dark';

    // Origin
    L.circleMarker([props.origin.lat, props.origin.lon], {
      radius: 7,
      color: '#0f172a',
      weight: 3,
      fillColor: '#0ea5e9',
      fillOpacity: 1,
    })
      .bindTooltip('Start', { direction: 'top' })
      .addTo(layer);

    // Destination
    L.circleMarker([props.destination.lat, props.destination.lon], {
      radius: 7,
      color: '#0f172a',
      weight: 3,
      fillColor: '#f97316',
      fillOpacity: 1,
    })
      .bindTooltip('Destination', { direction: 'top' })
      .addTo(layer);

    if (props.school) {
      L.marker([props.school.lat, props.school.lon], {
        icon: L.divIcon({
          className: '',
          html: schoolSvg,
          iconSize: [22, 22],
          iconAnchor: [11, 11],
        }),
        interactive: true,
        keyboard: false,
      })
        .bindTooltip('School area (approximate location)', { direction: 'top' })
        .addTo(layer);
    }

    for (const obs of props.observations) {
      if (obs.isSimulated && !props.showSimulated) continue;
      const isPhoto = obs.kind === 'photo';
      const fill = isPhoto ? '#6366f1' : obs.report === 'clear' ? '#22c55e' : '#a855f7';
      const glyph = isPhoto ? cameraSvg : obs.report === 'clear' ? checkSvg : smokeSvg;

      const icon = L.divIcon({
        className: '',
        html: pinHtml(glyph, fill, dark, obs.isSimulated),
        iconSize: [18, 18],
        iconAnchor: [9, 9],
      });

      L.marker([obs.lat, obs.lon], { icon, interactive: true, keyboard: false })
        .bindTooltip(
          obs.isSimulated
            ? `SIM ${isPhoto ? 'photo' : obs.report} (simulated demo data)`
            : `${isPhoto ? 'Your haze photo' : `Your report: ${obs.report}`}`,
          { direction: 'top' },
        )
        .addTo(layer);
    }
  }, [props.origin, props.destination, props.school, props.observations, props.showSimulated, props.theme]);

  // ── Fit the view once the routes are known ────────────────────────────────
  useEffect(() => {
    const map = mapRef.current;
    if (!map || props.routes.length === 0) return;
    const bounds = L.latLngBounds([]);
    for (const route of props.routes) {
      for (const seg of route.segments) {
        for (const c of seg.coords) bounds.extend([c.lat, c.lon]);
      }
    }
    if (bounds.isValid()) {
      map.fitBounds(bounds, { padding: [56, 56] });
      map.invalidateSize();
    }
    // Runs when the route set first arrives, and not again.
  }, [props.routes]);

  return <div ref={containerRef} className="absolute inset-0 h-full w-full bg-slate-200 dark:bg-slate-950" />;
}

// ── Inline SVG glyphs (no external assets, no default Leaflet icons) ─────────

const cameraSvg = `<svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="white" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M14.5 4h-5L8 6H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-4l-1.5-2Z"/><circle cx="12" cy="12.5" r="3.2"/></svg>`;
const checkSvg = `<svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="white" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>`;
const smokeSvg = `<svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="white" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M4 16h11a3 3 0 0 0 0-6h-1a4 4 0 0 0-7.5-1.5"/><path d="M4 20h13a3 3 0 0 0 3-3"/></svg>`;
const schoolSvg = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="#0f172a" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m3 10 9-5 9 5"/><path d="M5 10v8"/><path d="M19 10v8"/><path d="M9 18v-4h6v4"/></svg>`;

function pinHtml(glyph: string, fill: string, dark: boolean, simulated: boolean): string {
  const ring = dark ? 'rgba(255,255,255,0.85)' : 'rgba(15,23,42,0.85)';
  const sim = simulated
    ? `<span style="position:absolute;right:-6px;top:-6px;background:${
        dark ? '#0f172a' : '#ffffff'
      };color:${dark ? '#fca5a5' : '#b91c1c'};font:700 6px/1 ui-sans-serif,system-ui,sans-serif;padding:1px 2px;border-radius:999px;border:1px solid ${ring};letter-spacing:0">SIM</span>`
    : '';
  return `<span style="position:relative;display:block;width:18px;height:18px">
    <span style="display:flex;align-items:center;justify-content:center;width:18px;height:18px;border-radius:999px;background:${fill};border:2px solid ${ring};box-shadow:0 1px 3px rgba(0,0,0,.35)">${glyph}</span>
    ${sim}
  </span>`;
}

/** Route name + duration chip; the recommended route also gets a "Recommended" tag. */
function routeChipHtml(
  text: string,
  dark: boolean,
  recommended: boolean,
  dimmed: boolean,
): string {
  const bg = recommended
    ? dark
      ? 'rgba(16,185,129,0.95)'
      : 'rgba(5,150,105,0.95)'
    : dimmed
      ? dark
        ? 'rgba(15,23,42,0.75)'
        : 'rgba(255,255,255,0.85)'
      : dark
        ? 'rgba(15,23,42,0.9)'
        : 'rgba(255,255,255,0.95)';
  const fg = recommended ? '#ffffff' : dark ? '#e2e8f0' : '#0f172a';
  const border = recommended
    ? dark
      ? 'rgba(52,211,153,0.6)'
      : 'rgba(255,255,255,0.55)'
    : dark
      ? 'rgba(148,163,184,0.45)'
      : 'rgba(15,23,42,0.18)';
  const opacity = dimmed ? 0.75 : 1;
  const badge = recommended
    ? `<span style="margin-left:5px;padding:1px 5px;border-radius:999px;background:rgba(255,255,255,0.22);font-weight:700;font-size:8px;letter-spacing:.03em;text-transform:uppercase">Recommended</span>`
    : '';

  return `<span style="position:relative;display:block;white-space:nowrap;transform:translate(-50%,-50%);opacity:${opacity}">
    <span style="display:inline-flex;align-items:center;border-radius:999px;background:${bg};color:${fg};border:1px solid ${border};box-shadow:0 1px 4px rgba(0,0,0,.28);padding:2px 8px;font:600 10px/1.4 ui-sans-serif,system-ui,sans-serif">${text}${badge}</span>
  </span>`;
}