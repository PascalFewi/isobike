import { describe, expect, it } from 'vitest';

import { metersPerPixel, realWidthPx, widthStops } from '../src/lib/mapWidth.ts';

describe('metersPerPixel', () => {
  it('halves per zoom level', () => {
    const a = metersPerPixel(10, 46.8);
    const b = metersPerPixel(11, 46.8);
    expect(b).toBeCloseTo(a / 2, 6);
  });

  it('shrinks with latitude (cos factor)', () => {
    expect(metersPerPixel(10, 46.8)).toBeLessThan(metersPerPixel(10, 0));
  });
});

describe('realWidthPx', () => {
  it('renders a 200 m edge wider as you zoom in', () => {
    const z8 = realWidthPx(200, 8, 46.8);
    const z14 = realWidthPx(200, 14, 46.8);
    expect(z14).toBeGreaterThan(z8);
  });

  it('floors at the minimum so an edge never disappears', () => {
    // Very low zoom: 200 m is sub-pixel, so the floor kicks in.
    expect(realWidthPx(200, 4, 46.8, 2)).toBe(2);
  });

  it('is ~2 px around zoom 11-12 for a 200 m corridor (sanity)', () => {
    const w = realWidthPx(200, 12, 46.8);
    expect(w).toBeGreaterThan(2);
    expect(w).toBeLessThan(40);
  });
});

describe('widthStops', () => {
  it('produces increasing [zoom, px] pairs for the interpolate expression', () => {
    const stops = widthStops(200, 46.8);
    for (let i = 1; i < stops.length; i++) {
      expect(stops[i][0]).toBeGreaterThan(stops[i - 1][0]); // zoom ascending
      expect(stops[i][1]).toBeGreaterThanOrEqual(stops[i - 1][1]); // width non-decreasing
    }
  });
});
