/**
 * Route time/distance display rules.
 *
 * Integrity rule: distance and duration are facts about the road network and
 * must come from the real router. The exposure engine may only offer an
 * estimate, and that estimate must always be visibly marked as one.
 */

import { describe, expect, it } from 'vitest';
import { formatDistance, formatDuration, routeFactsText } from './format';

describe('formatDistance', () => {
  it('uses metres below one kilometre', () => {
    expect(formatDistance(0)).toBeNull();
    expect(formatDistance(840)).toBe('840 m');
    expect(formatDistance(999)).toBe('999 m');
  });

  it('uses one decimal up to 10 km and whole km beyond', () => {
    expect(formatDistance(1000)).toBe('1.0 km');
    expect(formatDistance(4250)).toBe('4.3 km');
    expect(formatDistance(9400)).toBe('9.4 km');
    expect(formatDistance(10_500)).toBe('11 km');
    expect(formatDistance(48_200)).toBe('48 km');
  });

  it('never renders a fabricated zero or a negative distance', () => {
    expect(formatDistance(-1)).toBeNull();
    expect(formatDistance(Number.NaN)).toBeNull();
    expect(formatDistance(Number.POSITIVE_INFINITY)).toBeNull();
  });
});

describe('formatDuration', () => {
  it('converts real seconds to whole minutes', () => {
    expect(formatDuration(60)).toBe('1 min');
    expect(formatDuration(1500)).toBe('25 min');
  });

  it('returns null for missing or nonsensical durations', () => {
    expect(formatDuration(0)).toBeNull();
    expect(formatDuration(-30)).toBeNull();
    expect(formatDuration(Number.NaN)).toBeNull();
  });
});

describe('routeFactsText', () => {
  it('shows real router duration AND distance when both exist', () => {
    expect(
      routeFactsText({ real: { durationS: 1500, distanceM: 4250 }, estimatedMinutes: 33 }),
    ).toBe('25 min · 4.3 km');
  });

  it('prefers the real router value over the engine estimate', () => {
    // The engine says 33 minutes, the router says 25. The router is a fact.
    expect(
      routeFactsText({ real: { durationS: 1500, distanceM: 0 }, estimatedMinutes: 33 }),
    ).toBe('25 min');
  });

  it('marks the engine estimate with a tilde so it is never read as measured', () => {
    const text = routeFactsText({ real: null, estimatedMinutes: 33 });
    expect(text).toBe('~33 min');
    expect(text).toMatch(/^~/);
  });

  it('shows nothing rather than a fabricated zero when there is no data', () => {
    expect(routeFactsText({ real: null, estimatedMinutes: 0 })).toBeNull();
    expect(routeFactsText({ real: { durationS: 0, distanceM: 0 }, estimatedMinutes: 0 })).toBeNull();
  });

  it('shows distance alone when the router returned no duration', () => {
    expect(
      routeFactsText({ real: { durationS: 0, distanceM: 2400 }, estimatedMinutes: 0 }),
    ).toBe('2.4 km');
  });
});
