/**
 * Pure display formatters for facts that come from real network services.
 *
 * Kept separate from the card components so the honesty rules around them can be
 * unit tested in the `node` test environment (no DOM available).
 */

/** Format real router metres for display. Returns null when there is no value. */
export function formatDistance(metres: number): string | null {
  if (!Number.isFinite(metres) || metres <= 0) return null;
  const km = metres / 1000;
  if (km < 1) return `${Math.round(metres)} m`;
  return `${km < 10 ? km.toFixed(1) : Math.round(km)} km`;
}

/** Format real router seconds as whole minutes. Returns null when there is no value. */
export function formatDuration(seconds: number): string | null {
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return `${Math.round(seconds / 60)} min`;
}

export interface RouteFacts {
  /** Real router duration and distance, or null when the router gave none. */
  real: { durationS: number; distanceM: number } | null;
  /** Engine-side estimated minutes, used only as a labelled fallback. */
  estimatedMinutes: number;
}

/**
 * Decide what to show for a route's time and distance.
 *
 * Real router numbers win and are shown plain. The engine estimate is only ever
 * shown as a fallback and is prefixed with "~" so an estimate can never be
 * mistaken for a measured or routed value. Returns null when neither exists, so
 * the UI shows nothing rather than a fabricated "0 min".
 */
export function routeFactsText(facts: RouteFacts): string | null {
  const { real, estimatedMinutes } = facts;
  if (real) {
    const duration = formatDuration(real.durationS);
    const distance = formatDistance(real.distanceM);
    if (duration && distance) return `${duration} · ${distance}`;
    if (duration) return duration;
    if (distance) return distance;
  }
  if (Number.isFinite(estimatedMinutes) && estimatedMinutes > 0) {
    return `~${Math.round(estimatedMinutes)} min`;
  }
  return null;
}
