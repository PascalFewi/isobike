import { describe, expect, it } from 'vitest';

import {
  BAND_COLORS,
  N_BANDS,
  PALETTE_STOPS,
  bandIndex,
  bandStepS,
  formatHours,
  legendBands,
} from '../src/lib/colorScale.ts';

describe('budget-dependent band scale', () => {
  it('uses 30 min / 1 h / 2 h bands for budgets up to 4 / 8 / 16 h', () => {
    expect(bandStepS(0.5)).toBe(1800);
    expect(bandStepS(4)).toBe(1800);
    expect(bandStepS(4.5)).toBe(3600);
    expect(bandStepS(8)).toBe(3600);
    expect(bandStepS(8.5)).toBe(7200);
    expect(bandStepS(16)).toBe(7200);
  });

  it('spans the full budget with exactly eight equal bands at the scale maximum', () => {
    for (const h of [4, 8, 16]) {
      const bands = legendBands(h);
      expect(bands.length).toBe(N_BANDS);
      expect(bands[bands.length - 1].to).toBe(h + ' h');
    }
  });

  it('shows fewer bands for a shorter budget, with the same colours', () => {
    const two = legendBands(2);
    expect(two.map((b) => b.from + '-' + b.to)).toEqual(['0-0:30', '0:30-1 h', '1 h-1:30', '1:30-2 h']);
    expect(two.map((b) => b.color)).toEqual(BAND_COLORS.slice(0, 4));
  });

  it('assigns bands at the edges and clamps past the last', () => {
    expect(bandIndex(0, 8)).toBe(0);
    expect(bandIndex(3599, 8)).toBe(0);
    expect(bandIndex(3600, 8)).toBe(1);
    expect(bandIndex(99 * 3600, 8)).toBe(N_BANDS - 1);
  });
});

describe('Alpenglühen palette', () => {
  it('runs from the first to the last stop', () => {
    expect(BAND_COLORS[0]).toBe(PALETTE_STOPS[0]);
    expect(BAND_COLORS[N_BANDS - 1]).toBe(PALETTE_STOPS[PALETTE_STOPS.length - 1]);
    for (const c of BAND_COLORS) expect(c).toMatch(/^#[0-9a-f]{6}$/);
  });

  it('gets darker band by band, so the order reads without hue', () => {
    const lum = (hex: string): number => {
      const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    for (let k = 1; k < N_BANDS; k++) expect(lum(BAND_COLORS[k])).toBeLessThan(lum(BAND_COLORS[k - 1]));
  });
});

describe('formatHours', () => {
  it('writes whole hours and h:mm', () => {
    expect(formatHours(3600)).toBe('1 h');
    expect(formatHours(5400)).toBe('1:30');
    expect(formatHours(1800)).toBe('0:30');
  });
});
