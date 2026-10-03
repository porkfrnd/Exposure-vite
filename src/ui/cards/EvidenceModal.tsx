/**
 * Add-evidence modal: haze photo analysis + crowd reports.
 *
 * HONESTY: photos produce a RELATIVE haze index from the dark-channel prior. That
 * index is displayed as "relative haze", never as a concentration, and the result
 * Every observation here is the user's own; none are simulated.
 *
 * Everything created here is a real contribution from this session.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Camera, Check, CloudFog, Loader2, MapPin, Sun, X } from 'lucide-react';
import { dataApi } from '../wiring';
import { FOCUS_RING, MOTION, NUMBERS, OVERLAY_Z_MODAL, TOUCH_TARGET } from '../design';
import { formatLocalTime } from '../wiring';
import type {
  Forecast,
  HazeResult,
  LatLon,
  Observation,
  PhotoObservation,
  ReportObservation,
  RasterImage,
  Segment,
} from '@/contracts';

export interface EvidenceModalProps {
  open: boolean;
  onClose: () => void;
  observations: Observation[];
  showSimulated: boolean;
  defaultLocation: LatLon;
  currentISO: string;
  forecast: Forecast | null;
  segments: Segment[];
  onAdd: (obs: Observation) => void;
  onError: (message: string) => void;
}

/** Nearest forecast hour's humidity, used for the humidity correction. */
function rhAt(fc: Forecast | null, iso: string): number {
  if (!fc || fc.hours.length === 0) return 0.6;
  let best = fc.hours[0];
  let bestGap = Number.POSITIVE_INFINITY;
  const target = Date.parse(iso);
  for (const h of fc.hours) {
    const gap = Math.abs(Date.parse(h.timeISO) - target);
    if (gap < bestGap) {
      bestGap = gap;
      best = h;
    }
  }
  return Number.isFinite(best.rh01) ? Math.min(0.95, Math.max(0, best.rh01)) : 0.6;
}

async function fileToRaster(file: File, maxWidth = 640): Promise<RasterImage | null> {
  if (typeof document === 'undefined') return null;
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, maxWidth / bitmap.width);
    const w = Math.max(1, Math.round(bitmap.width * scale));
    const h = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(bitmap, 0, 0, w, h);
    const imageData = ctx.getImageData(0, 0, w, h);
    return { width: w, height: h, data: imageData.data };
  } catch {
    return null;
  }
}

export function EvidenceModal(props: EvidenceModalProps) {
  const { open, onClose } = props;
  const [location, setLocation] = useState<LatLon>(props.defaultLocation);
  const [locating, setLocating] = useState(false);
  const [haze, setHaze] = useState<HazeResult | null>(null);
  const [scene, setScene] = useState<'open' | 'canyon'>('open');
  const [analysing, setAnalysing] = useState(false);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);

  // Escape closes.
  useEffect(() => {
    if (!open) return;
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  useEffect(() => {
    if (open) {
      setLocation(props.defaultLocation);
      setHaze(null);
      setScene('open');
    }
  }, [open, props.defaultLocation]);

  const onPickPhoto = useCallback(
    async (file: File | undefined) => {
      if (!file) return;
      setAnalysing(true);
      try {
        const raster = await fileToRaster(file);
        if (!raster) {
          props.onError('That image could not be read on this device.');
          return;
        }
        setHaze(dataApi.analyzePhoto(raster));
      } catch {
        props.onError('The photo could not be analysed.');
      } finally {
        setAnalysing(false);
      }
    },
    [props],
  );

  const useMyLocation = useCallback(() => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      props.onError('This device does not offer location access.');
      return;
    }
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setLocation({ lat: pos.coords.latitude, lon: pos.coords.longitude });
        setLocating(false);
      },
      () => {
        setLocating(false);
        props.onError('Location access was declined, so the photo will be pinned at the start point.');
      },
      { enableHighAccuracy: false, timeout: 8000 },
    );
  }, [props]);

  const addPhoto = useCallback(() => {
    if (!haze) return;
    const obs: PhotoObservation = {
      id: `photo-${Date.now().toString(36)}`,
      kind: 'photo',
      lat: location.lat,
      lon: location.lon,
      timeISO: props.currentISO,
      isSimulated: false,
      tauOpt: haze.tauOpt,
      rh01: rhAt(props.forecast, props.currentISO),
      scene,
      note: 'Added by you in this session.',
    };
    props.onAdd(obs);
  }, [haze, location, props]);

  const addReport = useCallback(
    (report: ReportObservation['report']) => {
      const obs: ReportObservation = {
        id: `report-${Date.now().toString(36)}-${report}`,
        kind: 'report',
        report,
        lat: location.lat,
        lon: location.lon,
        timeISO: props.currentISO,
        isSimulated: false,
        note: 'Added by you in this session.',
      };
      props.onAdd(obs);
    },
    [location, props],
  );

  if (!open) return null;

  const yourCount = props.observations.filter((o) => !o.isSimulated).length;

  return (
    <div className={`${OVERLAY_Z_MODAL} fixed inset-0 flex items-end justify-center sm:items-center`}>
      <button type="button" aria-label="Close" onClick={onClose} className="absolute inset-0 bg-slate-900/30" />

      <div
        role="dialog"
        aria-modal="true"
        aria-label="Add evidence"
        className="relative max-h-[92dvh] w-full max-w-md overflow-y-auto rounded-t-2xl bg-white/95 p-4 shadow-2xl ring-1 ring-slate-300 dark:bg-slate-900/95 dark:ring-slate-600"
      >
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">Add evidence</h2>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            aria-label="Close"
            className={`${FOCUS_RING} ${MOTION} rounded-lg p-1.5 text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800`}
          >
            <X size={16} aria-hidden />
          </button>
        </div>

        <p className="mt-1.5 text-xs leading-relaxed text-slate-600 dark:text-slate-300">
          Your evidence adjusts exposure <em>between</em> places. It never changes the regional level, and it
          is kept on this device only.
        </p>

        {/* Where */}
        <div className="mt-3 rounded-xl bg-slate-100/80 p-2.5 dark:bg-slate-800/60">
          <div className="flex items-center gap-1.5 text-[11px] font-medium text-slate-700 dark:text-slate-200">
            <MapPin size={13} aria-hidden />
            <span className={NUMBERS}>
              {location.lat.toFixed(5)}, {location.lon.toFixed(5)}
            </span>
          </div>
          <button
            type="button"
            onClick={useMyLocation}
            disabled={locating}
            className={`${FOCUS_RING} ${MOTION} mt-1.5 rounded-lg bg-white px-2.5 py-1.5 text-[11px] font-semibold text-slate-800 ring-1 ring-slate-300 hover:bg-slate-50 disabled:opacity-60 dark:bg-slate-900 dark:text-slate-100 dark:ring-slate-600`}
          >
            {locating ? 'Locating…' : 'Use my location'}
          </button>
        </div>

        {/* Photo */}
        <div className="mt-3">
          <h3 className="text-xs font-semibold text-slate-800 dark:text-slate-100">Haze photo</h3>
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            capture="environment"
            className="hidden"
            onChange={(e) => {
              void onPickPhoto(e.target.files?.[0]);
            }}
          />
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            disabled={analysing}
            className={`${FOCUS_RING} ${MOTION} mt-1.5 flex w-full ${TOUCH_TARGET} items-center justify-center gap-2 rounded-xl bg-emerald-600 px-3 py-2 text-xs font-semibold text-white hover:bg-emerald-500 disabled:opacity-60`}
          >
            {analysing ? <Loader2 size={15} className="animate-spin" aria-hidden /> : <Camera size={15} aria-hidden />}
            {analysing ? 'Analysing…' : 'Take or choose a photo'}
          </button>

          {haze && (
            <div className="mt-2 rounded-xl bg-slate-100/80 p-2.5 dark:bg-slate-800/60">
              <p className="text-[11px] font-semibold text-slate-800 dark:text-slate-100">Relative haze index</p>
              <p className={`${NUMBERS} text-lg font-semibold text-slate-900 dark:text-slate-100`}>
                {haze.tauOpt.toFixed(3)}
              </p>
              <p className="text-[11px] text-slate-600 dark:text-slate-300">
                Higher means more haze along the line of sight. This is a relative index, not a
                concentration — scene depth is unknown.
              </p>

              <div className="mt-2">
                <p className="mb-1 text-[11px] font-medium text-slate-700 dark:text-slate-200">What were you looking at?</p>
                <div className="grid grid-cols-2 gap-1.5">
                  <button
                    type="button"
                    onClick={() => setScene('open')}
                    aria-pressed={scene === 'open'}
                    className={`${FOCUS_RING} ${MOTION} flex items-center justify-center gap-1.5 rounded-lg px-2 py-1.5 text-[11px] font-semibold ring-1 ${
                      scene === 'open'
                        ? 'bg-emerald-50 text-emerald-800 ring-emerald-500/40 dark:bg-emerald-500/15 dark:text-emerald-300'
                        : 'bg-white text-slate-700 ring-slate-300 dark:bg-slate-900 dark:text-slate-200 dark:ring-slate-600'
                    }`}
                  >
                    <Sun size={13} aria-hidden />
                    Open view
                  </button>
                  <button
                    type="button"
                    onClick={() => setScene('canyon')}
                    aria-pressed={scene === 'canyon'}
                    className={`${FOCUS_RING} ${MOTION} flex items-center justify-center gap-1.5 rounded-lg px-2 py-1.5 text-[11px] font-semibold ring-1 ${
                      scene === 'canyon'
                        ? 'bg-emerald-50 text-emerald-800 ring-emerald-500/40 dark:bg-emerald-500/15 dark:text-emerald-300'
                        : 'bg-white text-slate-700 ring-slate-300 dark:bg-slate-900 dark:text-slate-200 dark:ring-slate-600'
                    }`}
                  >
                    <CloudFog size={13} aria-hidden />
                    Street canyon
                  </button>
                </div>
              </div>

              {haze.warnings.length > 0 && (
                <ul className="mt-2 space-y-0.5">
                  {haze.warnings.map((w) => (
                    <li key={w} className="text-[11px] text-amber-700 dark:text-amber-300">
                      {w}
                    </li>
                  ))}
                </ul>
              )}

              <button
                type="button"
                onClick={addPhoto}
                className={`${FOCUS_RING} ${MOTION} mt-2 w-full rounded-xl bg-emerald-600 px-3 py-2 text-xs font-semibold text-white hover:bg-emerald-500`}
              >
                Add this photo
              </button>
            </div>
          )}
        </div>

        {/* Reports */}
        <div className="mt-3">
          <h3 className="text-xs font-semibold text-slate-800 dark:text-slate-100">Or report what you see</h3>
          <div className="mt-1.5 grid grid-cols-3 gap-1.5">
            <button
              type="button"
              onClick={() => addReport('smoky')}
              className={`${FOCUS_RING} ${MOTION} rounded-xl bg-white px-2 py-2 text-[11px] font-semibold text-slate-800 ring-1 ring-slate-300 hover:bg-slate-50 dark:bg-slate-900 dark:text-slate-100 dark:ring-slate-600`}
            >
              Smoky
            </button>
            <button
              type="button"
              onClick={() => addReport('dusty')}
              className={`${FOCUS_RING} ${MOTION} rounded-xl bg-white px-2 py-2 text-[11px] font-semibold text-slate-800 ring-1 ring-slate-300 hover:bg-slate-50 dark:bg-slate-900 dark:text-slate-100 dark:ring-slate-600`}
            >
              Dusty
            </button>
            <button
              type="button"
              onClick={() => addReport('clear')}
              className={`${FOCUS_RING} ${MOTION} rounded-xl bg-white px-2 py-2 text-[11px] font-semibold text-slate-800 ring-1 ring-slate-300 hover:bg-slate-50 dark:bg-slate-900 dark:text-slate-100 dark:ring-slate-600`}
            >
              Clear
            </button>
          </div>
        </div>

        <p className="mt-3 flex items-start gap-1.5 text-[11px] text-slate-500 dark:text-slate-400">
          <Check size={12} className="mt-0.5 shrink-0" aria-hidden />
          <span>
            <span className={NUMBERS}>{yourCount}</span> observation(s) you added this session ·{' '}
            {props.observations.length} observation(s) from this session · stored on this device only.
          </span>
        </p>
      </div>
    </div>
  );
}