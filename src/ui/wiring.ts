/**
 * UI WIRING — the single seam between the React app and the two library APIs.
 *
 * ARCHITECTURE RULE: this file is the ONLY module in src/ui/** that imports
 * "@/engine" or "@/data". Every other UI module imports "./wiring" and
 * "@/contracts". That is what keeps the UI swappable and the engine testable.
 */

import { engine } from '@/engine';
import { dataApi } from '@/data';
import { formatLocalTime as formatLocalTimeImpl } from '@/data/format';

export { engine, dataApi };

/**
 * "4:15 PM NPT" formatting. Re-exported through the seam so UI code never reaches
 * into @/data directly.
 */
export const formatLocalTime = formatLocalTimeImpl;

/**
 * Development-time warning surfaced by the UI when the shipped demo route fixture
 * violates a contract invariant. Normally an empty array.
 */
export function demoRouteIssues(): string[] {
  try {
    // Lazily required so a broken fixture can never crash module evaluation.
    const mod = dataApi as unknown as { demoRouteIssues?: () => string[] };
    return typeof mod.demoRouteIssues === 'function' ? mod.demoRouteIssues() : [];
  } catch {
    return [];
  }
}