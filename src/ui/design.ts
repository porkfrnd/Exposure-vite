/**
 * Glassmorphism card surface and shared design-system class strings.
 * Keeps the visual language in one place so Phase 7 polish is a single-file change.
 */

export const GLASS_CARD =
  'bg-white/80 dark:bg-slate-900/80 backdrop-blur-xl rounded-2xl ' +
  'shadow-xl shadow-black/10 ring-1 ring-black/5 dark:ring-white/10';

/** Overlay chrome sits above Leaflet's panes, which go up to ~z-1000. */
export const OVERLAY_Z = 'z-[1100]';
export const OVERLAY_Z_TOP = 'z-[1300]';
export const OVERLAY_Z_MODAL = 'z-[1400]';

/** Restrained single accent colour. */
export const ACCENT = {
  bg: 'bg-emerald-600 hover:bg-emerald-500 dark:bg-emerald-500 dark:hover:bg-emerald-400',
  text: 'text-white',
  ring: 'focus-visible:ring-emerald-500',
  soft: 'bg-emerald-50 text-emerald-800 dark:bg-emerald-500/15 dark:text-emerald-300',
  border: 'border-emerald-500/40',
} as const;

export const NUMBERS = 'tabular-nums';

/** Transitions never exceed 150 ms and respect reduced-motion. */
export const MOTION = 'transition-colors duration-150 motion-reduce:transition-none';

export const FOCUS_RING =
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 ' +
  'focus-visible:ring-offset-white dark:focus-visible:ring-offset-slate-950';

/** Minimum comfortable touch target on small screens. */
export const TOUCH_TARGET = 'min-h-[44px] min-w-[44px]';

/**
 * Always-visible honesty pill text. Centralised so it cannot drift between the
 * map edge and the responsive layouts (AC-12, integrity rule 6).
 */
export const HONESTY_PILL = 'Modeled estimate · not a measurement · not medical advice';

/** Data-source badge label per Forecast.source. */
export function sourceBadge(source: 'live' | 'cached' | 'fixture'): {
  label: string;
  tone: string;
  title: string;
} {
  switch (source) {
    case 'live':
      return {
        label: 'Live forecast',
        tone: 'text-slate-600 dark:text-slate-300',
        title: 'Hourly forecast retrieved from Open-Meteo just now.',
      };
    case 'cached':
      return {
        label: 'Cached forecast',
        tone: 'text-slate-600 dark:text-slate-300',
        title: 'Reused a forecast cached less than 30 minutes ago.',
      };
    case 'fixture':
    default:
      return {
        label: 'Synthetic offline data',
        tone: 'text-amber-700 dark:text-amber-300',
        title:
          'The forecast service could not be reached, so this app is showing a ' +
          'clearly-labelled SYNTHETIC demo forecast. It is not real data and not a measurement.',
      };
  }
}