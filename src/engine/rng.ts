/**
 * Seeded random numbers for the Monte Carlo decision rule.
 *
 * Pure: every draw comes from an explicit seed, so results are reproducible and
 * no Math.random() ever leaks into the engine. mulberry32 + Box-Muller.
 */

/** mulberry32 — 32-bit PRNG. Deterministic for a given seed. */
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

/**
 * Box-Muller standard normal sampler over a uniform source in [0,1).
 * A spare value is cached so no draw is wasted.
 */
export class NormalSampler {
  private readonly uniform: () => number;
  private spare: number | null = null;

  constructor(uniform: () => number) {
    this.uniform = uniform;
  }

  next(): number {
    if (this.spare !== null) {
      const v = this.spare;
      this.spare = null;
      return v;
    }
    // 1 - u keeps log() finite when the uniform source returns exactly 0.
    let u1 = this.uniform();
    while (u1 <= Number.EPSILON) u1 = this.uniform();
    const u2 = this.uniform();
    const r = Math.sqrt(-2 * Math.log(1 - u1));
    const theta = 2 * Math.PI * u2;
    this.spare = r * Math.sin(theta);
    return r * Math.cos(theta);
  }

  /** Normal with the given standard deviation (sigma <= 0 ⇒ 0). */
  scaled(sigma: number): number {
    if (!Number.isFinite(sigma) || sigma <= 0) return 0;
    return this.next() * sigma;
  }
}

/** Median of a finite subset of `values` (empty ⇒ 0). */
export function medianOf(values: readonly number[]): number {
  const vs = values.filter((v) => Number.isFinite(v)).slice().sort((a, b) => a - b);
  if (vs.length === 0) return 0;
  const mid = vs.length >> 1;
  return vs.length % 2 === 1 ? vs[mid] : (vs[mid - 1] + vs[mid]) / 2;
}
