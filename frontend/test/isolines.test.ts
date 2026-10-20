import { describe, expect, it } from 'vitest';

import { GRID_NONE, type EffortGrid } from '../src/lib/effortResponse.ts';
import { contourSegments, gridCorners, isolines, smoothField } from '../src/lib/isolines.ts';

/** A cone of reach around the centre: minutes = 10 * distance in cells. */
function cone(n: number, holes: Array<[number, number]> = []): EffortGrid {
  const minutes = new Uint16Array(n * n);
  const c = (n - 1) / 2;
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) minutes[y * n + x] = Math.round(10 * Math.hypot(x - c, y - c));
  for (const [x, y] of holes) minutes[y * n + x] = GRID_NONE;
  return { nx: n, ny: n, westLon: 7, northLat: 47, cellLonDeg: 0.01, cellLatDeg: 0.01, minutes };
}

describe('smoothField', () => {
  it('adds the leg offset and divides by the speed factor', () => {
    const f = smoothField(cone(9), 30, 2);
    const centre = 4 * 9 + 4;
    expect(f[centre]).toBeGreaterThan(14);
    expect(f[centre]).toBeLessThan(25); // (0 + 30) / 2, plus a little smoothing
  });

  it('closes a one-cell gap between reached cells', () => {
    expect(Number.isFinite(smoothField(cone(9, [[4, 2]]), 0, 1)[2 * 9 + 4])).toBe(true);
  });

  it('leaves a large unreached area unreached', () => {
    const minutes = new Uint16Array(20 * 20).fill(GRID_NONE);
    minutes[0] = 5;
    const g: EffortGrid = { nx: 20, ny: 20, westLon: 7, northLat: 47, cellLonDeg: 0.01, cellLatDeg: 0.01, minutes };
    expect(Number.isFinite(smoothField(g, 0, 1)[19 * 20 + 19])).toBe(false);
  });
});

describe('contours', () => {
  it('traces a ring around the start at a level inside the cone', () => {
    const g = cone(15);
    const segs = contourSegments(smoothField(g, 0, 1), g.nx, g.ny, 40);
    expect(segs.length).toBeGreaterThan(0);
    // Every segment end lies ~4 cells from the centre (10 min per cell).
    for (let i = 0; i < segs.length; i += 2) {
      const r = Math.hypot(segs[i] - 7, segs[i + 1] - 7);
      expect(r).toBeGreaterThan(2.5);
      expect(r).toBeLessThan(5.5);
    }
  });

  it('emits one feature per band edge up to the budget, the last flagged', () => {
    const g = cone(41);
    const fc = isolines(g, smoothField(g, 0, 1), 2); // 30-min bands -> 4 edges
    expect(fc.features.map((f) => f.properties.minutes)).toEqual([30, 60, 90, 120]);
    expect(fc.features.map((f) => f.properties.last)).toEqual([false, false, false, true]);
    const [lon, lat] = fc.features[0].geometry.coordinates[0][0];
    expect(lon).toBeGreaterThan(7);
    expect(lat).toBeLessThan(47);
  });

  it('places the grid corners NW, NE, SE, SW', () => {
    const [nw, ne, se, sw] = gridCorners(cone(10));
    expect(nw).toEqual([7, 47]);
    expect(ne[0]).toBeCloseTo(7.1, 9);
    expect(se[1]).toBeCloseTo(46.9, 9);
    expect(sw[0]).toBe(7);
  });
});
