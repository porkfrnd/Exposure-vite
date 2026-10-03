/**
 * REAL place search and location — no fabricated coordinates.
 *
 * Search uses Photon (Komoot): free, keyless, CORS `*`.
 * Nominatim is deliberately NOT used — its usage policy forbids client-side
 * type-ahead, which is exactly what this search box does.
 *
 * Every function returns real data or throws with a message the UI can show.
 * Nothing here invents a location.
 */

import { NPT_OFFSET_MIN } from '@/contracts';
import type { LatLon } from '@/contracts';

/** Kathmandu Valley. Biasing every query here is what makes local place names
 *  ("Thamel", "Boudhanath") resolve to the valley instead of the world. */
export const VALLEY: LatLon = { lat: 27.7172, lon: 85.324 };

export interface Place {
  id: string;
  name: string;
  detail: string;
  lat: number;
  lon: number;
}

interface PhotonFeature {
  geometry?: { coordinates?: [number, number] };
  properties?: {
    name?: string;
    housenumber?: string;
    street?: string;
    district?: string;
    city?: string;
    county?: string;
    state?: string;
    country?: string;
    osm_type?: string;
    osm_id?: number | string;
    type?: string;
  };
}

const PHOTON = 'https://photon.komoot.io';

export async function searchPlaces(
  query: string,
  limit = 6,
  signal?: AbortSignal,
): Promise<Place[]> {
  const q = query.trim();
  if (q.length < 2) return [];
  // lat/lon bias keeps results in the valley — without it "Thamel" returns
  // streets in Portugal and Edinburgh.
  const url =
    `${PHOTON}/api/?q=${encodeURIComponent(q)}` +
    `&limit=${limit}&lat=${VALLEY.lat}&lon=${VALLEY.lon}&lang=en`;
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`Place search failed (${res.status}).`);
  const json = (await res.json()) as { features?: PhotonFeature[] };
  const out: Place[] = [];
  for (const f of json.features ?? []) {
    const coords = f.geometry?.coordinates;
    if (!coords || coords.length < 2) continue;
    const p = f.properties ?? {};
    const name =
      [p.name, p.housenumber].filter(Boolean).join(' ') || p.street || 'Unnamed place';
    const detail = [p.street, p.district, p.city, p.state, p.country].filter(Boolean).join(', ');
    out.push({
      id: `${p.osm_type ?? 'node'}-${p.osm_id ?? out.length}`,
      name,
      detail: detail || 'Kathmandu Valley',
      lat: coords[1],
      lon: coords[0],
    });
  }
  return out;
}

/**
 * Turn coordinates into a readable place name (Photon reverse, keyless).
 * Returns null when nothing nearby is found — the caller then falls back to a
 * plain "Current location" label rather than inventing a street name.
 */
export async function reverseGeocode(
  lat: number,
  lon: number,
  signal?: AbortSignal,
): Promise<Place | null> {
  try {
    const res = await fetch(
      `${PHOTON}/reverse?lat=${lat}&lon=${lon}&limit=1&lang=en`,
      { signal },
    );
    if (!res.ok) return null;
    const json = (await res.json()) as { features?: PhotonFeature[] };
    const f = json.features?.[0];
    const coords = f?.geometry?.coordinates;
    if (!f || !coords || coords.length < 2) return null;
    const p = f.properties ?? {};
    const name = p.name || p.street || p.district || p.city;
    if (!name) return null;
    return {
      id: `reverse-${lat.toFixed(4)}-${lon.toFixed(4)}`,
      name,
      detail: [p.district, p.city, p.state].filter(Boolean).join(', ') || 'Kathmandu Valley',
      lat: coords[1],
      lon: coords[0],
    };
  } catch {
    return null;
  }
}

/** Ask the browser where the user is. Rejects with a readable message. */
export function getCurrentPosition(timeoutMs = 10_000): Promise<LatLon> {
  return new Promise((resolve, reject) => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      reject(new Error('Location is not available in this browser. Search for your place instead.'));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ lat: pos.coords.latitude, lon: pos.coords.longitude }),
      (err) => {
        if (err.code === err.PERMISSION_DENIED) {
          reject(new Error('Location access denied. Search for your place instead.'));
        } else if (err.code === err.TIMEOUT) {
          reject(new Error('Could not get a location fix. Search for your place instead.'));
        } else {
          reject(new Error('Could not get your location. Search for your place instead.'));
        }
      },
      { enableHighAccuracy: true, timeout: timeoutMs, maximumAge: 60_000 },
    );
  });
}

/** Compact label for a place, used in tooltips and pins. */
export function formatPlace(p: Place): string {
  return p.detail ? `${p.name} — ${p.detail}` : p.name;
}

/** True when two points are effectively the same location. */
export function samePoint(a: LatLon, b: LatLon): boolean {
  return Math.abs(a.lat - b.lat) < 1e-6 && Math.abs(a.lon - b.lon) < 1e-6;
}

/** Straight-line distance in metres between two points. */
export function distanceM(a: LatLon, b: LatLon): number {
  const R = 6_371_000;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLon = ((b.lon - a.lon) * Math.PI) / 180;
  const la1 = (a.lat * Math.PI) / 180;
  const la2 = (b.lat * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Nepal local hour-of-day for an instant (used by the planner's clock). */
export function localHour(iso: string): number {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return 0;
  const shifted = ms + NPT_OFFSET_MIN * 60_000;
  return (shifted / 3_600_000) % 24;
}