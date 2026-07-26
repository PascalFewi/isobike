import { describe, expect, it } from 'vitest';

import {
  BAND_BOUNDS_S,
  BAND_LABELS,
  PALETTE,
  ascentIntensity,
  bandIndex,
  colorForTime,
  timeToFlatKm,
} from '../src/lib/colorScale.ts';

describe('time bands', () => {
  it('has one more colour and label than boundaries (open-ended top band)', () => {
    expect(PALETTE.length).toBe(BAND_BOUNDS_S.length + 1);
    expect(BAND_LABELS.length).toBe(PALETTE.length);
  });

  it('assigns bands at the boundaries', () => {
    expect(bandIndex(0)).toBe(0);
    expect(bandIndex(29 * 60)).toBe(0);
    expect(bandIndex(30 * 60)).toBe(1); // boundary is exclusive at the bottom
    expect(bandIndex(90 * 60)).toBe(2);
    expect(bandIndex(9 * 3600)).toBe(BAND_BOUNDS_S.length); // beyond 8 h
  });

  it('is monotonic in time', () => {
    let prev = -1;
    for (const t of [0, 1800, 3600, 7200, 14400, 28800, 40000]) {
      const b = bandIndex(t);
      expect(b).toBeGreaterThanOrEqual(prev);
      prev = b;
    }
  });

  it('maps a time straight to its band colour', () => {
    expect(colorForTime(10 * 60)).toBe(PALETTE[0]);
    expect(colorForTime(3 * 3600)).toBe(PALETTE[3]);
  });

  it('uses hex colours', () => {
    for (const c of PALETTE) expect(c).toMatch(/^#[0-9a-f]{6}$/);
  });
});

describe('second channel: cumulative ascent', () => {
  it('normalises to 0..1 against the field max', () => {
    expect(ascentIntensity(0, 1000)).toBe(0);
    expect(ascentIntensity(500, 1000)).toBe(0.5);
    expect(ascentIntensity(1000, 1000)).toBe(1);
  });

  it('clamps and handles a degenerate max', () => {
    expect(ascentIntensity(1500, 1000)).toBe(1);
    expect(ascentIntensity(100, 0)).toBe(0);
  });
});

describe('flat-km toggle', () => {
  it('converts reach time to flat-equivalent distance', () => {
    // 1 h at 7.5 m/s = 27 km.
    expect(timeToFlatKm(3600, 7.5)).toBeCloseTo(27, 6);
  });
});
