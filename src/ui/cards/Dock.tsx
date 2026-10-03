/**
 * Secondary feature dock, map legend, and the always-visible honesty pill.
 * None of these replace the map or navigate away; they all open over it.
 */

import {
  AlertTriangle,
  BookOpen,
  Camera,
  FlaskConical,
  MessageSquarePlus,
  Play,
  School,
} from 'lucide-react';
import { FOCUS_RING, GLASS_CARD, HONESTY_PILL, MOTION, OVERLAY_Z, OVERLAY_Z_TOP, TOUCH_TARGET, sourceBadge } from '../design';
import { RAMP_GRADIENT } from '../map/ramp';

const DOCK_ITEMS = [
  { id: 'evidence', label: 'Add evidence', Icon: Camera },
  { id: 'diary', label: 'Diary', Icon: BookOpen },
  { id: 'school', label: 'School', Icon: School },
  { id: 'method', label: 'How it works & validation', Icon: FlaskConical },
  { id: 'demo', label: 'Demo tour', Icon: Play },
] as const;

export type DockId = (typeof DOCK_ITEMS)[number]['id'];

export interface FeatureDockProps {
  onOpen: (id: DockId) => void;
  onAddEvidence: () => void;
}

export function FeatureDock({ onOpen, onAddEvidence }: FeatureDockProps) {
  return (
    <div className={`${OVERLAY_Z} pointer-events-auto absolute right-3 top-3 flex flex-col items-end gap-2 sm:right-4 sm:top-4`}>
      <div className={`${GLASS_CARD} flex flex-col gap-0.5 p-1.5`}>
        {DOCK_ITEMS.map(({ id, label, Icon }) => (
          <button
            key={id}
            type="button"
            onClick={id === 'evidence' ? onAddEvidence : () => onOpen(id)}
            title={label}
            aria-label={label}
            className={`${FOCUS_RING} ${MOTION} flex ${TOUCH_TARGET} items-center justify-center rounded-xl text-slate-700 hover:bg-slate-100/80 dark:text-slate-200 dark:hover:bg-slate-700/70`}
          >
            {id === 'evidence' ? <MessageSquarePlus size={18} aria-hidden /> : <Icon size={18} aria-hidden />}
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * Map legend: colour ramp + the dashed "estimated only" entry.
 *
 * Rendered inside a stack owned by App rather than positioned absolutely itself, so
 * it can never collide with the toggle above it or Leaflet's own controls.
 */
export function MapLegend() {
  return (
    <div className={`${GLASS_CARD} w-52 p-2.5`}>
      <div className="h-2 w-full rounded-full" style={{ background: RAMP_GRADIENT }} aria-hidden />
      <div className="mt-1 flex justify-between text-[10px] font-medium text-slate-600 dark:text-slate-300">
        <span>Lower</span>
        <span>exposure</span>
        <span>Higher</span>
      </div>
      <div className="mt-1.5 flex items-start gap-1.5 text-[10px] leading-tight text-slate-600 dark:text-slate-300">
        <svg width="20" height="6" aria-hidden className="mt-0.5 shrink-0">
          <line x1="0" y1="3" x2="20" y2="3" stroke="currentColor" strokeWidth="2" strokeDasharray="2 4" />
        </svg>
        <span>estimated only (little local data)</span>
      </div>
    </div>
  );
}

/** Honesty pill + data-source badge. Always visible, both themes. */
export function HonestyPill({ source }: { source: 'live' | 'cached' | 'fixture' | null }) {
  const badge = sourceBadge(source ?? 'fixture');
  return (
    // Sits at the very top, centred in the space LEFT of the dock, so it can never
    // collide with the dock at narrow widths. The planner is positioned below it.
    <div
      className={`${OVERLAY_Z_TOP} pointer-events-none absolute left-2 right-14 top-2 flex flex-col items-center gap-1`}
    >
      <span
        className="max-w-full rounded-full bg-white px-2.5 py-1 border border-slate-200 dark:bg-slate-900 dark:border-slate-700 dark:text-slate-200 dark:ring-slate-600"
        title="Every number in this app is a modeled estimate, not a measurement."
      >
        {HONESTY_PILL}
      </span>
      {source && (
        <span
          className={`rounded-full bg-white px-2 py-0.5 border border-slate-200 dark:bg-slate-900 dark:border-slate-700 dark:ring-slate-600 ${badge.tone}`}
          title={badge.title}
        >
          {badge.label}
        </span>
      )}
    </div>
  );
}

export { AlertTriangle };