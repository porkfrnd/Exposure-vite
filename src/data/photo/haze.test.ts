import { describe, expect, it } from 'vitest';
import { analyzePhoto, OMEGA } from './haze';
import type { RasterImage } from '@/contracts';

const W = 120;
const H = 90;

/** Build a synthetic hazy image from a fixed haze-free scene: I = J·t + A·(1 − t). */
function hazyScene(t: number, a: [number, number, number] = [235, 240, 245]): RasterImage {
  const data = new Uint8ClampedArray(W * H * 4);

  // Haze-free scene J: a textured, non-uniform lower half (ground/objects) and a
  // bright upper band that we will treat as sky.
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const o = (y * W + x) * 4;
      let jr: number;
      let jg: number;
      let jb: number;

      if (y < H * 0.4) {
        // "Sky" band: bright and low-saturation so the sky mask catches it.
        jr = 225;
        jg = 232;
        jb = 240;
      } else {
        // Textured objects: varied brightness so the dark channel is informative.
        const v = 60 + ((x * 7 + y * 13) % 70);
        jr = v;
        jg = Math.round(v * 0.9);
        jb = Math.round(v * 0.75);
      }

      data[o] = jr * t + a[0] * (1 - t);
      data[o + 1] = jg * t + a[1] * (1 - t);
      data[o + 2] = jb * t + a[2] * (1 - t);
      data[o + 3] = 255;
    }
  }

  return { width: W, height: H, data };
}

function uniformGray(v: number): RasterImage {
  const data = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < W * H; i++) {
    const o = i * 4;
    data[o] = v;
    data[o + 1] = v;
    data[o + 2] = v;
    data[o + 3] = 255;
  }
  return { width: W, height: H, data };
}

describe('analyzePhoto', () => {
  it('returns a strictly increasing tauOpt as transmission falls', () => {
    const taus = [0.95, 0.8, 0.6, 0.4].map((t) => analyzePhoto(hazyScene(t)).tauOpt);
    for (let i = 1; i < taus.length; i++) {
      expect(taus[i]).toBeGreaterThan(taus[i - 1]);
    }
    expect(taus[0]).toBeGreaterThanOrEqual(0);
    expect(taus[taus.length - 1]).toBeLessThan(Math.log(1 / 0.05) + 1e-9);
  });

  it('keeps mean transmission inside (0,1]', () => {
    for (const t of [0.95, 0.5, 0.1]) {
      const r = analyzePhoto(hazyScene(t));
      expect(r.meanTransmission).toBeGreaterThan(0);
      expect(r.meanTransmission).toBeLessThanOrEqual(1);
    }
  });

  it('uses the documented dark-channel prior weight', () => {
    expect(OMEGA).toBe(0.95);
  });

  it('warns about a nearly uniform image', () => {
    const r = analyzePhoto(uniformGray(128));
    expect(r.warnings.join(' ')).toMatch(/nearly uniform/);
  });

  it('warns about a very dark image', () => {
    const data = new Uint8ClampedArray(W * H * 4);
    for (let i = 0; i < W * H; i++) {
      const o = i * 4;
      const v = (i * 37) % 3; // 0..2, very dark
      data[o] = v;
      data[o + 1] = v;
      data[o + 2] = v;
      data[o + 3] = 255;
    }
    const r = analyzePhoto({ width: W, height: H, data });
    expect(r.warnings.join(' ')).toMatch(/very dark|nearly uniform/);
  });

  it('excludes a bright sky from the non-sky fraction', () => {
    const r = analyzePhoto(hazyScene(0.8));
    // The top 40% of the frame is our sky band, so the non-sky fraction is < 0.6.
    expect(r.nonSkyFraction).toBeGreaterThan(0);
    expect(r.nonSkyFraction).toBeLessThan(0.65);
  });

  it('still answers when the frame is dominated by sky, with a warning', () => {
    // The whole search region (top 60% of the frame) is bright and desaturated.
    const data = new Uint8ClampedArray(W * H * 4);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const o = (y * W + x) * 4;
        const v = 230 + ((x + y) % 5);
        data[o] = v;
        data[o + 1] = v + 3;
        data[o + 2] = v + 6;
        data[o + 3] = 255;
      }
    }
    const r = analyzePhoto({ width: W, height: H, data });
    expect(r.warnings.join(' ')).toMatch(/mostly sky/);
    expect(Number.isFinite(r.tauOpt)).toBe(true);
  });

  it('picks up a bright, low-saturation atmospheric light', () => {
    const r = analyzePhoto(hazyScene(0.5));
    for (const channel of r.atmosphericLight) {
      expect(channel).toBeGreaterThan(0);
      expect(channel).toBeLessThanOrEqual(255);
    }
  });

  it('handles a huge image by downscaling', () => {
    const bigW = 1600;
    const bigH = 1200;
    const data = new Uint8ClampedArray(bigW * bigH * 4);
    for (let y = 0; y < bigH; y++) {
      for (let x = 0; x < bigW; x++) {
        const o = (y * bigW + x) * 4;
        const bright = y < bigH * 0.4;
        const v = bright ? 225 : 70 + ((x * 3 + y * 5) % 60);
        data[o] = v;
        data[o + 1] = bright ? 232 : Math.round(v * 0.9);
        data[o + 2] = bright ? 240 : Math.round(v * 0.75);
        data[o + 3] = 255;
      }
    }
    const t0 = performance.now();
    const r = analyzePhoto({ width: bigW, height: bigH, data });
    const ms = performance.now() - t0;
    expect(Number.isFinite(r.tauOpt)).toBe(true);
    expect(r.patchSize).toBeGreaterThanOrEqual(3);
    expect(ms).toBeLessThan(3000);
  });

  it('handles a tiny image without crashing', () => {
    const data = new Uint8ClampedArray([10, 20, 30, 255, 200, 210, 220, 255]);
    const r = analyzePhoto({ width: 2, height: 1, data });
    expect(Number.isFinite(r.tauOpt)).toBe(true);
    expect(r.warnings.length).toBeGreaterThan(0);
  });

  it('handles a degenerate empty image', () => {
    const r = analyzePhoto({ width: 0, height: 0, data: new Uint8ClampedArray(0) });
    expect(r.tauOpt).toBe(0);
    expect(r.meanTransmission).toBe(1);
    expect(r.warnings.length).toBeGreaterThan(0);
  });

  it('never returns a negative tauOpt', () => {
    for (const t of [1, 0.98, 0.9]) {
      expect(analyzePhoto(hazyScene(t)).tauOpt).toBeGreaterThanOrEqual(0);
    }
  });
});
