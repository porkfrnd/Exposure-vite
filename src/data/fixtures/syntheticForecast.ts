/**
 * ============================================================================
 * SYNTHETIC OFFLINE FALLBACK FORECAST
 * ============================================================================
 *
 * ##### THIS IS NOT REAL DATA AND IS NOT A MEASUREMENT. #####
 *
 * It is a deterministic, hand-shaped diurnal curve used ONLY when the Open-Meteo
 * network calls fail or time out, so the app still has something coherent to
 * demo. Every forecast produced here carries `source: 'fixture'` and the UI is
 * required to label it "Synthetic offline data".
 *
 * The shape is a plausible Kathmandu-valley winter-ish diurnal pattern
 * (early-morning inversion peak, midday dip, evening secondary peak, low night-time
 * boundary layer, light afternoon wind) — it is a GUESS, marked ASSUMED, not a
 * fitted or published profile. It is anchored to the current hour so the dates are
 * never stale, and it is fully deterministic for a given anchor.
 */

import { KATHMANDU } from '@/contracts';
import { addHours, floorToHourISO, localHourOf } from '../time';
import { mulberry32, uniform } from '../rng';
import type { Forecast, HourlyPoint, LatLon } from '@/contracts';

/** ASSUMED — overall level of the synthetic curve, µg/m³. */
const BASE_LEVEL = 62;
/** ASSUMED — diurnal swing, µg/m³. */
const AMPLITUDE = 34;
/** ASSUMED — noise scale added on top, µg/m³. */
const NOISE = 3.2;

/**
 * ASSUMED diurnal shape in [0,1] as a function of Nepal local hour.
 * Peaks around 07:00 NPT (inversion / morning peak), dips around 15:00 NPT,
 * secondary peak around 20:00 NPT, low overnight.
 */
function diurnalShape(localHour: number): number {
  // Two Gaussian bumps minus a midday relaxation, all hand-placed.
  const bump = (centre: number, width: number, weight: number) =>
    weight * Math.exp(-(((localHour - centre) / width) ** 2));
  const morning = bump(7, 2.1, 1);
  const evening = bump(20, 2.6, 0.85);
  const middayDip = bump(15, 3.0, -0.55);
  const nightFloor = -0.35;
  return morning + evening + middayDip + nightFloor;
}

/** ASSUMED — synthetic boundary-layer height (m) by Nepal local hour. */
function syntheticBlh(localHour: number, rnd: () => number): number {
  // Shallow at night, deepest in the afternoon.
  const base = 380 + 900 * Math.max(0, Math.sin(((localHour - 6) / 24) * Math.PI));
  return Math.round(base * uniform(rnd, 0.94, 1.06));
}

/** ASSUMED — synthetic 10 m wind speed (m/s): light, with an afternoon maximum. */
function syntheticWind(localHour: number, rnd: () => number): number {
  const base = 1.1 + 1.9 * Math.max(0, Math.sin(((localHour - 8) / 24) * Math.PI));
  return Math.round(base * uniform(rnd, 0.85, 1.15) * 100) / 100;
}

/** ASSUMED — synthetic 2 m relative humidity (0..1). */
function syntheticRh(localHour: number, rnd: () => number): number {
  const base = 0.72 - 0.24 * Math.max(0, Math.sin(((localHour - 7) / 24) * Math.PI));
  const v = base * uniform(rnd, 0.96, 1.04);
  return Math.min(0.99, Math.max(0.2, Math.round(v * 1000) / 1000));
}

/**
 * Build the synthetic offline forecast.
 *
 * @param anchorISO Instant treated as "now". Defaults to nothing — the caller must
 *                  pass the current time, which keeps this function pure.
 * @param location  Defaults to Kathmandu.
 * @param pastDays / forecastDays  Hour span either side of the anchor.
 */
export function syntheticForecast(
  anchorISO: string,
  location: LatLon = KATHMANDU,
  pastDays = 2,
  forecastDays = 3,
): Forecast {
  const anchorHour = floorToHourISO(anchorISO);
  const startIso = addHours(anchorHour, -Math.max(0, Math.round(pastDays * 24)));
  const totalHours = Math.max(1, Math.round((pastDays + forecastDays) * 24));
  const startMs = Date.parse(startIso);

  // Seed from the anchor hour so the shape is stable within an hour but changes
  // slowly across hours, which keeps the demo from looking frozen.
  const seed = Math.floor(startMs / 3_600_000);
  const rnd = mulberry32(seed);

  const hours: HourlyPoint[] = [];
  for (let i = 0; i <= totalHours; i++) {
    const timeISO = addHours(startIso, i);
    const lh = localHourOf(timeISO);
    const pm25 = Math.max(
      3,
      Math.round((BASE_LEVEL + AMPLITUDE * diurnalShape(lh) + NOISE * (rnd() - 0.5) * 2) * 10) / 10,
    );
    hours.push({
      timeISO,
      pm25,
      // Aerosol optical depth and dust are left null in the fixture: we do NOT know
      // them offline, and inventing them would be fabrication.
      aod: null,
      dust: null,
      windMs: syntheticWind(lh, rnd),
      windDirDeg: null,
      blhM: syntheticBlh(lh, rnd),
      rh01: syntheticRh(lh, rnd),
      tempC: Math.round((18 + 5 * Math.sin(((lh - 9) / 24) * 2 * Math.PI)) * 10) / 10,
      precipMm: 0,
      // Inversion strength is unavailable offline.
      inversionK: null,
    });
  }

  return {
    source: 'fixture',
    fetchedAtISO: anchorISO,
    location,
    hours,
  };
}
