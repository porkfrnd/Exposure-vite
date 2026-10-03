/**
 * UI WIRING — the single seam between the React app and the two library APIs.
 *
 * ARCHITECTURE RULE: this file is the ONLY module in src/ui/** that imports
 * "@/engine" or "@/data". Every other UI module imports "./wiring" and
 * "@/contracts". That is what keeps the UI swappable and the engine testable.
 *
 * `realApi` carries the live, keyless services (Photon place search, FOSSGIS OSRM
 * routing, Valhalla road classes, Open-Meteo). There are no demo routes and no
 * simulated evidence in this build.
 */

import { engine } from '@/engine';
import { dataApi, realApi, VALLEY } from '@/data';
import { formatLocalTime } from '@/data/format';
import type { Place, Planned, RealRouteResult } from '@/data';

export { engine, dataApi, realApi, formatLocalTime, VALLEY };
export type { Place, Planned, RealRouteResult };