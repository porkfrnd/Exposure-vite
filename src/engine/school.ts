/**
 * School activity window (methodology 3.5).
 *
 * Local (Nepal) school hours 06:00–17:00 are scored at each clock hour on the day
 * that contains dayStartISO. "Indoor" simply multiplies by the ASSUMED school
 * infiltration factor. The recommended window is the LONGEST contiguous run of
 * hours within 10% of the day's minimum (ties broken towards the earlier run).
 *
 * INTEGRITY: the output is a modeled concentration ordering, never a health or
 * safety judgement, and the message says exactly that.
 */

import { evaluateSegment, resolveParams } from './predict';
import { makeStagnationCache } from './background';
import { addHours, formatLocalTime, localDayStartISO, toIso, toMs } from './time';
import type {
  EngineParams,
  EvalContext,
  SchoolHour,
  SchoolWindow,
  Segment,
} from '@/contracts';

/** ASSUMED — Nepal school day, local hours. */
export const SCHOOL_START_LOCAL_HOUR = 6;
export const SCHOOL_END_LOCAL_HOUR = 17;
/** ASSUMED — a run is "low" when it is within this fraction of the day's minimum. */
export const LOW_WINDOW_TOLERANCE = 0.1;

export function schoolWindow(
  schoolSegment: Segment,
  dayStartISO: string,
  activity: 'outdoor' | 'indoor',
  ctx: EvalContext,
): SchoolWindow {
  const params: EngineParams = resolveParams(ctx);
  const stagnationCache = makeStagnationCache(params, ctx.forecast);

  // The contract says dayStartISO is already 00:00 NPT. We re-derive the NPT day
  // start anyway so that a caller passing any instant on the intended day still gets
  // the same 06:00–17:00 NPT window — this is what keeps the window anchored to Nepal
  // local time rather than UTC or the browser timezone.
  const rawStartMs = toMs(dayStartISO);
  const baseISO = Number.isFinite(rawStartMs) ? localDayStartISO(dayStartISO) : toIso(0);

  const hours: SchoolHour[] = [];
  for (let h = SCHOOL_START_LOCAL_HOUR; h <= SCHOOL_END_LOCAL_HOUR; h++) {
    // The instant h hours after the start of the Nepal local day.
    const timeISO = addHours(baseISO, h);
    const ev = evaluateSegment(
      params,
      ctx.forecast,
      schoolSegment,
      timeISO,
      ctx.corrections,
      stagnationCache,
    );
    const infiltration = activity === 'indoor' ? params.indoorInfiltration : 1;
    const exposureIndex = ev.concentration * (Number.isFinite(infiltration) ? infiltration : 1);
    hours.push({
      timeISO,
      exposureIndex: Number.isFinite(exposureIndex) ? exposureIndex : 0,
      confidence: ev.confidence,
    });
  }

  const values = hours.map((x) => x.exposureIndex);
  const min = values.length > 0 ? Math.min(...values) : 0;
  const threshold = min * (1 + LOW_WINDOW_TOLERANCE);
  const lowFlags = values.map((v) => v <= threshold);

  // Longest contiguous run; earlier run wins a tie.
  let bestStart = -1;
  let bestLen = 0;
  let runStart = -1;
  for (let i = 0; i <= lowFlags.length; i++) {
    const low = i < lowFlags.length && lowFlags[i];
    if (low && runStart < 0) runStart = i;
    if (!low && runStart >= 0) {
      const len = i - runStart;
      if (len > bestLen) {
        bestLen = len;
        bestStart = runStart;
      }
      runStart = -1;
    }
  }

  const bestWindow =
    bestStart < 0 || hours.length === 0
      ? null
      : {
          startISO: hours[bestStart].timeISO,
          // End of the last hour in the run.
          endISO: addHours(hours[bestStart + bestLen - 1].timeISO, 1),
        };

  const message = bestWindow
    ? `Lowest modeled exposure: ${formatLocalTime(bestWindow.startISO).replace(' NPT', '')}–${formatLocalTime(bestWindow.endISO).replace(' NPT', '')} NPT. This is a modeled estimate, not a safety judgement.`
    : 'No low-exposure window could be determined from this forecast window.';

  return { activity, hours, bestWindow, message };
}
