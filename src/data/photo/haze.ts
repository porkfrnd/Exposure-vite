/**
 * Photo haze index via the dark channel prior (methodology 2.1 + 8.1).
 *
 * Haze image model:   I(x) = J(x)·t(x) + A·(1 − t(x))
 * Dark channel:       J_dark(x) = min_{y∈Ω(x)} min_c J^c(y)  ≈ 0 for haze-free scenes
 * Transmission:       t(x) = 1 − ω·min_{y∈Ω(x)} min_c (I^c(y) / A^c),  ω = 0.95
 * Haze index:         τ_opt = −ln(mean transmission over NON-SKY pixels)
 *
 * INTEGRITY: τ_opt is OPTICAL DEPTH along an unknown view path. It contains the
 * unknown scene depth, so it is a RELATIVE index only and can never be converted
 * to a concentration without calibration. It redistributes exposure between
 * places; it never changes the regional level.
 */

import type { HazeResult, RasterImage } from '@/contracts';

/** ASSUMED — standard dark-channel prior weight. */
export const OMEGA = 0.95;
/** ASSUMED — downscale cap so a 12 MP phone photo stays fast in the browser. */
export const MAX_WIDTH = 320;
/** ASSUMED — minification patch size on the downscaled image. */
export const PATCH_SIZE = 15;
/** ASSUMED — fraction of brightest dark-channel pixels used for atmospheric light. */
export const ATMOSPHERIC_TOP_FRACTION = 0.001;
/** ASSUMED — a pixel is "sky" if it is this bright relative to atmospheric light. */
export const SKY_BRIGHTNESS_RATIO = 0.78;
/** ASSUMED — maximum saturation for a pixel to count as sky. */
export const SKY_MAX_SATURATION = 0.22;
/** ASSUMED — sky is only looked for in the upper part of the frame. */
export const SKY_TOP_FRACTION = 0.6;
/**
 * ASSUMED — if more than this fraction of the SEARCH REGION is classified as sky,
 * the frame is dominated by sky and the remaining sample is unrepresentative.
 *
 * NOTE ON THE SPEC: the prompt asks for a warning when `nonSkyFraction < 0.3`.
 * Because sky is only searched in the top 60% of the frame, at least 40% of the
 * pixels can never be classified as sky, so a whole-frame non-sky fraction can
 * never fall below 0.3 and that branch would be unreachable. We therefore apply the
 * check to the SEARCH REGION instead, which is what the rule is actually trying to
 * protect against, and still emit exactly the specified warning string.
 */
export const SKY_DOMINANCE_RATIO = 0.9;
/** ASSUMED — below this non-sky fraction the estimate is unreliable. */
export const MIN_NON_SKY_FRACTION = 0.3;

function clampByte(v: number): number {
  return Math.min(255, Math.max(0, v));
}

/** Box-filter downscale to at most MAX_WIDTH px wide. Returns {w,h,data}. */
function downscale(img: RasterImage): { w: number; h: number; data: Uint8ClampedArray } {
  if (!img || img.width <= 0 || img.height <= 0) {
    return { w: 0, h: 0, data: new Uint8ClampedArray(0) };
  }
  if (img.width <= MAX_WIDTH) {
    return { w: img.width, h: img.height, data: img.data };
  }

  const scale = MAX_WIDTH / img.width;
  const w = Math.max(1, Math.floor(img.width * scale));
  const h = Math.max(1, Math.floor(img.height * scale));
  const out = new Uint8ClampedArray(w * h * 4);

  const xRatio = img.width / w;
  const yRatio = img.height / h;

  for (let y = 0; y < h; y++) {
    const y0 = Math.floor(y * yRatio);
    const y1 = Math.max(y0 + 1, Math.floor((y + 1) * yRatio));
    for (let x = 0; x < w; x++) {
      const x0 = Math.floor(x * xRatio);
      const x1 = Math.max(x0 + 1, Math.floor((x + 1) * xRatio));

      let r = 0;
      let g = 0;
      let b = 0;
      let n = 0;
      for (let sy = y0; sy < y1 && sy < img.height; sy++) {
        for (let sx = x0; sx < x1 && sx < img.width; sx++) {
          const idx = (sy * img.width + sx) * 4;
          r += img.data[idx];
          g += img.data[idx + 1];
          b += img.data[idx + 2];
          n++;
        }
      }
      const dst = (y * w + x) * 4;
      out[dst] = clampByte(n > 0 ? r / n : 0);
      out[dst + 1] = clampByte(n > 0 ? g / n : 0);
      out[dst + 2] = clampByte(n > 0 ? b / n : 0);
      out[dst + 3] = 255;
    }
  }

  return { w, h, data: out };
}

/** Dark channel value per pixel: min over the patch of the min over channels. */
function darkChannel(
  w: number,
  h: number,
  data: Uint8ClampedArray,
  patch: number,
): Float64Array {
  const dark = new Float64Array(w * h);
  const half = Math.max(1, Math.floor(patch / 2));

  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - half);
    const y1 = Math.min(h - 1, y + half);
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - half);
      const x1 = Math.min(w - 1, x + half);
      let min = 255;
      for (let py = y0; py <= y1; py++) {
        const row = py * w;
        for (let px = x0; px <= x1; px++) {
          const idx = (row + px) * 4;
          const c = Math.min(data[idx], data[idx + 1], data[idx + 2]);
          if (c < min) min = c;
        }
      }
      dark[y * w + x] = min;
    }
  }
  return dark;
}

function intensity(r: number, g: number, b: number): number {
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

/**
 * Analyse a photo and return its haze index.
 * Never throws and never returns a non-finite number.
 */
export function analyzePhoto(img: RasterImage): HazeResult {
  const warnings: string[] = [];

  if (!img || img.width <= 0 || img.height <= 0 || !img.data || img.data.length === 0) {
    return {
      tauOpt: 0,
      meanTransmission: 1,
      atmosphericLight: [255, 255, 255],
      nonSkyFraction: 0,
      patchSize: PATCH_SIZE,
      warnings: ['image could not be read, haze not estimated'],
    };
  }

  const { w, h, data } = downscale(img);

  if (w < 3 || h < 3) {
    return {
      tauOpt: 0,
      meanTransmission: 1,
      atmosphericLight: [255, 255, 255],
      nonSkyFraction: 0,
      patchSize: PATCH_SIZE,
      warnings: ['image is too small to estimate haze'],
    };
  }

  // Scale the patch with the image so downscaling does not change the answer much.
  const patch = Math.max(3, Math.min(PATCH_SIZE, Math.floor(Math.min(w, h) / 6)));

  const dark = darkChannel(w, h, data, patch);

  // ── Atmospheric light A: brightest 0.1% of dark-channel pixels, and among those
  //    the pixel with the highest intensity in the ORIGINAL image.
  const n = w * h;
  const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => dark[b] - dark[a]);
  const take = Math.max(1, Math.round(n * ATMOSPHERIC_TOP_FRACTION));
  let aIdx = order[0];
  let aBest = -1;
  for (let k = 0; k < take; k++) {
    const idx = order[k];
    const px = idx % w;
    const py = Math.floor(idx / w);
    const o = (py * w + px) * 4;
    const inten = intensity(data[o], data[o + 1], data[o + 2]);
    if (inten > aBest) {
      aBest = inten;
      aIdx = idx;
    }
  }
  const aOff = (Math.floor(aIdx / w) * w + (aIdx % w)) * 4;
  const A: [number, number, number] = [
    Math.max(1, data[aOff]),
    Math.max(1, data[aOff + 1]),
    Math.max(1, data[aOff + 2]),
  ];

  // ── Transmission, patch minimum of the normalised dark channel.
  const half = Math.max(1, Math.floor(patch / 2));
  const transmission = new Float64Array(n);
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - half);
    const y1 = Math.min(h - 1, y + half);
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - half);
      const x1 = Math.min(w - 1, x + half);
      let minRatio = 1;
      for (let py = y0; py <= y1; py++) {
        const row = py * w;
        for (let px = x0; px <= x1; px++) {
          const idx = (row + px) * 4;
          const ratio = Math.min(
            data[idx] / A[0],
            data[idx + 1] / A[1],
            data[idx + 2] / A[2],
          );
          if (ratio < minRatio) minRatio = ratio;
        }
      }
      transmission[y * w + x] = Math.min(1, Math.max(0, 1 - OMEGA * minRatio));
    }
  }

  // ── Sky mask: bright, low saturation, upper part of the frame.
  const aMax = Math.max(A[0], A[1], A[2]);
  const skyTopRow = Math.floor(h * SKY_TOP_FRACTION);
  const sky = new Uint8Array(n);
  for (let y = 0; y < h; y++) {
    const inTop = y < skyTopRow;
    for (let x = 0; x < w; x++) {
      const idx = y * w + x;
      const o = idx * 4;
      const r = data[o];
      const g = data[o + 1];
      const b = data[o + 2];
      const cmin = Math.min(r, g, b);
      const cmax = Math.max(r, g, b);
      const bright = cmin > SKY_BRIGHTNESS_RATIO * aMax;
      const saturation = cmax === 0 ? 0 : (cmax - cmin) / cmax;
      sky[idx] = inTop && bright && saturation <= SKY_MAX_SATURATION ? 1 : 0;
    }
  }

  let nonSkyCount = 0;
  let transmissionSum = 0;
  for (let i = 0; i < n; i++) {
    if (sky[i] === 1) continue;
    nonSkyCount++;
    transmissionSum += transmission[i];
  }

  const nonSkyFraction = nonSkyCount / n;

  // Sky dominance inside the region where sky is searched for.
  const topPixels = Math.max(1, skyTopRow * w);
  let topSky = 0;
  for (let i = 0; i < topPixels; i++) if (sky[i] === 1) topSky++;
  const skyDominance = topSky / topPixels;

  let meanTransmission: number;
  if (skyDominance > SKY_DOMINANCE_RATIO || nonSkyFraction < MIN_NON_SKY_FRACTION) {
    warnings.push('mostly sky, estimate unreliable');
    // Still compute something, over ALL pixels, rather than refusing to answer.
    let sum = 0;
    for (let i = 0; i < n; i++) sum += transmission[i];
    meanTransmission = sum / n;
  } else {
    meanTransmission = transmissionSum / nonSkyCount;
  }

  // ── Degenerate-image warnings (honest failure states, not silent guesses).
  let sumR = 0;
  let sumG = 0;
  let sumB = 0;
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    sumR += data[o];
    sumG += data[o + 1];
    sumB += data[o + 2];
  }
  const meanR = sumR / n;
  const meanG = sumG / n;
  const meanB = sumB / n;

  if (meanR + meanG + meanB < 12) {
    warnings.push('image is very dark, haze estimate unreliable');
  }

  let variance = 0;
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    const dR = data[o] - meanR;
    const dG = data[o + 1] - meanG;
    const dB = data[o + 2] - meanB;
    variance += dR * dR + dG * dG + dB * dB;
  }
  variance /= 3 * n;
  if (variance < 9) {
    warnings.push('image is nearly uniform, haze estimate unreliable');
  }

  const t = Math.min(1, Math.max(0.05, Number.isFinite(meanTransmission) ? meanTransmission : 1));
  const tauOpt = -Math.log(t);

  return {
    tauOpt: Number.isFinite(tauOpt) ? tauOpt : 0,
    meanTransmission: t,
    atmosphericLight: A,
    nonSkyFraction: Number.isFinite(nonSkyFraction) ? nonSkyFraction : 0,
    patchSize: patch,
    warnings,
  };
}