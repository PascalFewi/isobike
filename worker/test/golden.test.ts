/**
 * The cross-language verification step 1 exists for.
 *
 * Every expectation here was computed by the Python reference router and frozen
 * into `testdata/ridge_world/expected.json`. Nothing in this file recomputes an
 * answer; it only checks that the fast TypeScript router lands on the same one.
 *
 * Costs are compared with `toBe` -- **bit equality**, not a tolerance. That is a
 * deliberate and defensible bar: every quantity entering a cost is read from the
 * binary as f32 and widened to f64, so both languages sum the same doubles in the
 * same order along a path. A tolerance here would let a genuine divergence hide.
 */

import { describe, expect, it } from 'vitest';

import { SLOPE_STEP_PCT } from '../src/binformat.js';
import { R_EARTH_M } from '../src/geo.js';
import { H_SAFETY, effortField, route, snap } from '../src/router.js';
import { loadExpected, loadRidgeWorld, toBudget, toSlopeLimit } from './fixtures.js';

const graph = loadRidgeWorld();
const expected = loadExpected();

describe('shared constants', () => {
  it('agree with the Python side that generated the golden files', () => {
    expect(R_EARTH_M).toBe(expected.constants.r_earth_m);
    expect(H_SAFETY).toBe(expected.constants.h_safety);
    expect(SLOPE_STEP_PCT).toBe(expected.constants.slope_step_pct);
  });
});

describe('routes reproduce the Python reference exactly', () => {
  it('covers both reachable and unreachable outcomes', () => {
    expect(expected.routes.length).toBeGreaterThan(80);
    expect(expected.routes.some((r) => r.found)).toBe(true);
    expect(expected.routes.some((r) => !r.found)).toBe(true);
  });

  for (const want of expected.routes) {
    const label =
      `${want.name} ${want.from}->${want.to} ` +
      `cf=${want.climb_factor} slope=${want.max_slope_pct ?? 'none'}`;

    it(label, () => {
      const got = route(graph, want.from, want.to, want.climb_factor, {
        maxSlopePct: toSlopeLimit(want.max_slope_pct),
      });

      if (!want.found) {
        expect(got).toBeNull();
        return;
      }

      expect(got).not.toBeNull();
      const result = got!;

      // Bit-exact, not approximate -- see the file header.
      expect(result.cost).toBe(want.cost);
      expect(result.distM).toBe(want.dist_m);
      expect(result.ascentM).toBe(want.ascent_m);
      expect(result.descentM).toBe(want.descent_m);
      expect(result.maxSlopePct).toBe(want.result_max_slope_pct);

      // The path itself, not just its cost: an equal-cost different route would
      // still be a divergence worth knowing about.
      expect(result.edgeIds).toEqual(want.edge_ids);
      expect(result.nodes).toEqual(want.nodes);
    });
  }
});

describe('snapping reproduces the Python reference exactly', () => {
  it('agrees on all probes, including outside the bbox and in empty cells', () => {
    const mismatches: string[] = [];
    for (const probe of expected.snap) {
      const got = snap(graph, probe.lat, probe.lon);
      if (got !== probe.node) {
        mismatches.push(`snap(${probe.lat}, ${probe.lon}) = ${got}, expected ${probe.node}`);
      }
    }
    expect(mismatches).toEqual([]);
  });

  it('checked a meaningful number of out-of-bbox probes', () => {
    const [minLon, minLat, maxLon, maxLat] = expected.graph.bbox;
    const outside = expected.snap.filter(
      (p) => p.lat < minLat || p.lat > maxLat || p.lon < minLon || p.lon > maxLon,
    );
    expect(outside.length).toBeGreaterThanOrEqual(15);
  });
});

describe('effort fields reproduce the Python reference exactly', () => {
  for (const want of expected.effort_fields) {
    const label =
      `source=${want.source} cf=${want.climb_factor} ` +
      `slope=${want.max_slope_pct ?? 'none'} budget=${want.max_cost ?? 'none'}`;

    it(label, () => {
      const got = effortField(graph, want.source, want.climb_factor, {
        maxSlopePct: toSlopeLimit(want.max_slope_pct),
        maxCost: toBudget(want.max_cost),
      });

      expect(got.count).toBe(want.edge_count);

      // Compare the whole field, entry by entry -- this is the artefact the
      // frontend joins onto tiles, so a single wrong edge is a visible bug.
      const mismatches: string[] = [];
      for (const [edgeId, cost] of want.entries) {
        const actual = got.cost[edgeId];
        if (actual !== cost) mismatches.push(`edge ${edgeId}: ${actual} != ${cost}`);
      }
      const expectedIds = new Set(want.entries.map(([id]) => id));
      for (let id = 0; id < got.cost.length; id++) {
        if (Number.isFinite(got.cost[id]) && !expectedIds.has(id)) {
          mismatches.push(`edge ${id} unexpectedly present`);
        }
      }
      expect(mismatches).toEqual([]);
    });
  }

  it('excludes the disconnected island from an unbudgeted field', () => {
    const field = effortField(graph, 0, 10);
    const islandEdges = new Set<number>();
    for (const node of expected.fixtures.island) {
      for (let e = graph.csrOffset[node]; e < graph.csrOffset[node + 1]; e++) {
        islandEdges.add(graph.edgeId[e]);
      }
    }
    expect(islandEdges.size).toBeGreaterThan(0);
    for (const id of islandEdges) expect(field.cost[id]).toBe(Infinity);
  });
});
