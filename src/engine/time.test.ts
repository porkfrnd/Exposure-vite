import { describe, expect, it } from 'vitest';
import {
  addMinutes,
  floorToHourISO,
  formatLocalTime,
  lerpAt,
  localDayKey,
  localDayStartISO,
  localHourOf,
  localWeekday,
  median,
  sortedHours,
  toIso,
  toMs,
} from './time';
import { sampleForecast } from './interp';
import { hourISO, makeForecast, makePoint } from './testFixtures';

describe('toIso / toMs', () => {
  it('round-trips an on-the-hour UTC instant', () => {
    expect(toMs('2026-10-05T00:00:00Z')).toBe(Date.UTC(2026, 9, 5, 0, 0, 0));
    expect(toIso(Date.UTC(2026, 9, 5, 0, 0, 0))).toBe('2026-10-05T00:00:00Z');
  });

  it('adds minutes across an hour boundary', () => {
    expect(addMinutes('2026-10-05T00:50:00Z', 20)).toBe('2026-10-05T01:10:00Z');
  });

  it('floors to the containing hour', () => {
    expect(floorToHourISO('2026-10-05T07:42:31Z')).toBe('2026-10-05T07:00:00Z');
  });
});

describe('Nepal local time (UTC+05:45, no DST)', () => {
  it('maps 01:15Z to 07:00 NPT', () => {
    expect(localHourOf('2026-10-05T01:15:00Z')).toBeCloseTo(7, 10);
    expect(formatLocalTime('2026-10-05T01:15:00Z')).toBe('7:00 AM NPT');
  });

  it('maps 06:00Z to 11:45 NPT', () => {
    expect(localHourOf('2026-10-05T06:00:00Z')).toBeCloseTo(11.75, 10);
  });

  it('maps 18:15Z to midnight NPT of the next day', () => {
    expect(localHourOf('2026-10-05T18:15:00Z')).toBeCloseTo(0, 10);
    expect(localDayKey('2026-10-05T18:15:00Z')).toBe('2026-10-06');
  });

  it('computes the NPT day start and weekday', () => {
    // 2026-10-05T20:00:00Z is 2026-10-06 01:45 NPT, a Tuesday.
    expect(localDayStartISO('2026-10-05T20:00:00Z')).toBe('2026-10-05T18:15:00Z');
    expect(localWeekday('2026-10-05T20:00:00Z')).toBe(2);
  });

  it('never uses the browser local timezone (UTC-based run)', () => {
    // Same instant, expressed two ways, must give the same NPT hour.
    const a = localHourOf('2026-10-05T04:00:00Z');
    const b = localHourOf(toIso(Date.UTC(2026, 9, 5, 4, 0, 0)));
    expect(a).toBe(b);
    expect(a).toBeCloseTo(9.75, 10);
  });
});

describe('lerpAt', () => {
  const xs = [0, 10, 20];
  const ys = [0, 100, 0];

  it('interpolates inside the range', () => {
    expect(lerpAt(xs, ys, 5)).toBe(50);
    expect(lerpAt(xs, ys, 15)).toBe(50);
  });

  it('clamps outside the range to the nearest endpoint', () => {
    expect(lerpAt(xs, ys, -100)).toBe(0);
    expect(lerpAt(xs, ys, 100)).toBe(0);
  });

  it('returns null for an empty axis', () => {
    expect(lerpAt([], [], 1)).toBeNull();
  });
});

describe('median', () => {
  it('takes the middle of an odd count', () => {
    expect(median([3, 1, 2])).toBe(2);
  });

  it('averages the middle pair of an even count', () => {
    expect(median([4, 1, 3, 2])).toBe(2.5);
  });

  it('returns null when nothing is finite', () => {
    expect(median([])).toBeNull();
    expect(median([NaN, Infinity])).toBeNull();
  });
});

describe('sampleForecast', () => {
  const fc = makeForecast([
    makePoint({ timeISO: hourISO(0), pm25: 40, blhM: 400, windMs: 2 }),
    makePoint({ timeISO: hourISO(1), pm25: 50, blhM: 600, windMs: 4 }),
    makePoint({ timeISO: hourISO(2), pm25: 60, blhM: null, windMs: 6, aod: null, dust: null }),
  ]);

  it('sorts hours ascending regardless of input order', () => {
    const shuffled = makeForecast([
      makePoint({ timeISO: hourISO(2), pm25: 60 }),
      makePoint({ timeISO: hourISO(0), pm25: 40 }),
      makePoint({ timeISO: hourISO(1), pm25: 50 }),
    ]);
    expect(sortedHours(shuffled).map((h) => h.pm25)).toEqual([40, 50, 60]);
  });

  it('interpolates required fields linearly at the half hour', () => {
    // 00:30Z sits halfway between pm25 40 and 50.
    expect(sampleForecast(fc, hourISO(0) .replace('00:00:00Z', '00:30:00Z')).pm25).toBe(45);
  });

  it('clamps outside the covered range', () => {
    expect(sampleForecast(fc, hourISO(-5)).pm25).toBe(40);
    expect(sampleForecast(fc, hourISO(99)).pm25).toBe(60);
  });

  it('keeps nullable fields null when both neighbours are null', () => {
    expect(sampleForecast(fc, hourISO(2)).blhM).toBeNull();
  });

  it('interpolates a nullable field when both neighbours have values', () => {
    // blh 400 → 600 across the first hour: at 00:30 it is 500.
    const at = sampleForecast(fc, hourISO(0).replace('00:00:00Z', '00:30:00Z'));
    expect(at.blhM).toBe(500);
  });

  it('returns a safe degenerate point for an empty forecast', () => {
    const empty = makeForecast([]);
    const p = sampleForecast(empty, hourISO(3));
    expect(Number.isFinite(p.pm25)).toBe(true);
    expect(p.rh01).toBe(0.5);
  });
});
