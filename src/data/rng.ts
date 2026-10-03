/**
 * Seeded RNG for the data layer.
 *
 * The SYNTHETIC offline forecast and the simulated demo observations must be
 * reproducible, so nothing here uses Math.random(). Both generators take an
 * explicit anchor (current hour) and an explicit seed.
 */

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Uniform in [lo, hi). */
export function uniform(rnd: () => number, lo: number, hi: number): number {
  return lo + rnd() * (hi - lo);
}

/**
 * Approximate standard normal via the sum of 6 uniforms (Irwin–Hall). Bounded, so
 * it can never produce Infinity, which matters because this feeds the UI.
 */
export function approxNormal(rnd: () => number): number {
  let s = 0;
  for (let i = 0; i < 6; i++) s += rnd();
  return s - 3; // mean 0, std ≈ 0.707
}

export { median } from './time';
