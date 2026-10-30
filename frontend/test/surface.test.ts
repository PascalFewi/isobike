import { describe, expect, it } from 'vitest';

import type { RouteResult } from '../src/lib/api.ts';
import { joinLegs, surfaceOfClass, surfaceTotals } from '../src/lib/surface.ts';

const SNAP = { node: 0, lat: 0, lon: 0 };

function leg(xs: number[], runs: Array<[number, number]>, surface_m?: RouteResult['surface_m']): RouteResult {
  return {
    found: true,
    from_snapped: SNAP,
    to_snapped: SNAP,
    geometry: xs.map((x) => [x, 0, 500] as [number, number, number]),
    geometry_surface: runs,
    ...(surface_m !== undefined ? { surface_m } : {}),
  };
}

describe('joinLegs', () => {
  it('glues legs at their shared junction and carries the surface per vertex', () => {
    // Leg 1: vertices 0..3, paved then gravel from vertex 2. Leg 2: 3..5, unpaved.
    const a = leg([0, 1, 2, 3], [[0, 1], [2, 2]]);
    const b = leg([3, 4, 5], [[0, 3]]);
    const j = joinLegs([a, b]);
    expect(j.coords.map((c) => c[0])).toEqual([0, 1, 2, 3, 4, 5]);
    expect(j.stops).toEqual([3, 5]);
    // The stretch starting at vertex i: 0-1 paved, 2 gravel, 3-4 unpaved; the last vertex starts nothing.
    expect(Array.from(j.surfaceAt.subarray(0, 5))).toEqual([1, 1, 2, 3, 3]);
  });

  it('keeps a missing leg as a stop and treats an unsent surface as unknown', () => {
    const noSurface: RouteResult = { found: true, from_snapped: SNAP, to_snapped: SNAP, geometry: [[0, 0, 1], [1, 0, 1]] };
    const j = joinLegs([noSurface, null]);
    expect(j.stops).toEqual([1, 1]);
    expect(Array.from(j.surfaceAt)).toEqual([0, 0]);
  });
});

describe('surfaceTotals', () => {
  it('sums the found legs per surface', () => {
    const m = (paved: number, gravel: number) => ({ paved, gravel, unpaved: 0, unknown: 10 });
    const lost: RouteResult = { found: false, from_snapped: SNAP, to_snapped: SNAP };
    expect(surfaceTotals([leg([0, 1], [], m(100, 50)), null, lost, leg([1, 2], [], m(1, 2))])).toEqual({
      paved: 101, gravel: 52, unpaved: 0, unknown: 20,
    });
  });

  it('names the Worker classes', () => {
    expect([0, 1, 2, 3, 9].map(surfaceOfClass)).toEqual(['unknown', 'paved', 'gravel', 'unpaved', 'unknown']);
  });
});
