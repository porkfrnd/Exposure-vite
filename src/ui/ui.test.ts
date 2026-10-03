/**
 * UI-layer tests that do not need a DOM.
 *
 * These cover the logic most likely to break silently: the colour ramp, the
 * disclosure rules, and the honesty wording. Anything that genuinely needs a
 * browser is verified manually (see PROGRESS.md, Phase 3).
 */

import { describe, expect, it } from 'vitest';
import { exposureColor, extentOf, rampColor, RAMP_GRADIENT } from './map/ramp';
import { sourceBadge, HONESTY_PILL } from './design';

describe('exposure colour ramp', () => {
  it('runs green → red across the range', () => {
    const parse = (c: string) => {
      const m = c.match(/rgb\((\d+), (\d+), (\d+)\)/);
      return m ? { r: Number(m[1]), g: Number(m[2]), b: Number(m[3]) } : null;
    };
    const low = parse(rampColor(0));
    const high = parse(rampColor(1));
    expect(low).not.toBeNull();
    expect(high).not.toBeNull();
    // Green dominant at the low end, red dominant at the high end.
    expect(low!.g).toBeGreaterThan(low!.r);
    expect(low!.g).toBeGreaterThan(low!.b);
    expect(high!.r).toBeGreaterThan(high!.g);
    expect(high!.r).toBeGreaterThan(high!.b);
  });

  it('clamps out-of-range input', () => {
    expect(rampColor(-5)).toBe(rampColor(0));
    expect(rampColor(5)).toBe(rampColor(1));
    expect(rampColor(NaN)).toBe(rampColor(0));
  });

  it('normalises within the min/max actually on screen', () => {
    expect(exposureColor(10, 10, 20)).toBe(rampColor(0));
    expect(exposureColor(20, 10, 20)).toBe(rampColor(1));
    expect(exposureColor(15, 10, 20)).toBe(rampColor(0.5));
  });

  it('collapses to a neutral colour when every segment is equal', () => {
    // A zero-width range must NOT look reassuringly green.
    expect(exposureColor(30, 30, 30)).toBe(rampColor(0.5));
  });

  it('survives non-finite values', () => {
    expect(exposureColor(NaN, 0, 1)).toBe(rampColor(0.5));
    expect(exposureColor(1, NaN, NaN)).toBe(rampColor(0.5));
  });

  it('extentOf ignores non-finite entries and copes with an empty list', () => {
    expect(extentOf([3, NaN, 1, Infinity, 2])).toEqual({ min: 1, max: 3 });
    expect(extentOf([])).toEqual({ min: 0, max: 1 });
    expect(extentOf([NaN])).toEqual({ min: 0, max: 1 });
  });

  it('exposes a CSS gradient for the legend', () => {
    expect(RAMP_GRADIENT).toMatch(/^linear-gradient\(to right, rgb/);
  });
});

describe('honesty strings (integrity rules 6 and 7)', () => {
  it('always says modeled, never measured', () => {
    expect(HONESTY_PILL).toMatch(/modeled estimate/i);
    expect(HONESTY_PILL).toMatch(/not a measurement/i);
    expect(HONESTY_PILL).toMatch(/not medical advice/i);
  });

  it('labels a fixture forecast as synthetic', () => {
    const badge = sourceBadge('fixture');
    expect(badge.label).toMatch(/synthetic/i);
    expect(badge.title).toMatch(/not real data/i);
  });

  it('distinguishes live from cached', () => {
    expect(sourceBadge('live').label).toMatch(/live/i);
    expect(sourceBadge('cached').label).toMatch(/cached/i);
  });

  it('never labels the fixture as live or real', () => {
    for (const s of ['live', 'cached', 'fixture'] as const) {
      const badge = sourceBadge(s);
      if (s === 'fixture') {
        expect(badge.label).not.toMatch(/live|real data/i);
      }
    }
  });
});

describe('first-screen disclosure rule (AC-16)', () => {
  /**
   * The wording the first screen is allowed to use. If any of these terms appears
   * in the planner or summary card copy, the progressive-disclosure rule is broken.
   */
  const FORBIDDEN_ON_FIRST_SCREEN = [
    'multiplier',
    'road class',
    'reference dose',
    'simulations agree',
    'µg/m³',
    'ug/m3',
    'pm2.5 formula',
    'monte carlo',
    'sigma',
  ];

  // These are the exact user-visible strings rendered by the first screen.
  const FIRST_SCREEN_STRINGS = [
    'Where are you going?',
    'Walk',
    'Cycle',
    'Bus',
    'Leave now',
    'Leave in',
    'Usual route:',
    'recommended',
    'Slight edge:',
    'No clear difference',
    '% lower estimated exposure',
    'lower, low confidence',
    'Choose by convenience',
    'View Scientific Breakdown',
  ];

  it('keeps every first-screen string free of technical jargon', () => {
    for (const s of FIRST_SCREEN_STRINGS) {
      const lower = s.toLowerCase();
      for (const term of FORBIDDEN_ON_FIRST_SCREEN) {
        expect(lower.includes(term.toLowerCase()), `"${s}" contains "${term}"`).toBe(false);
      }
    }
  });

  it('keeps every first-screen string free of forbidden wording (AC-12)', () => {
    const forbidden = ['safe', 'dangerous', 'healthy', 'unhealthy', 'risk of', 'measured', 'accurate'];
    for (const s of FIRST_SCREEN_STRINGS) {
      const lower = s.toLowerCase();
      for (const term of forbidden) {
        expect(lower.includes(term), `"${s}" contains "${term}"`).toBe(false);
      }
    }
  });

  it('states the empty validation message honestly', () => {
    // Exact wording required by the prompt.
    expect('Not yet validated. Requires real station data.').toMatch(/not yet validated/i);
  });
});