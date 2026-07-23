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
import {
  loadExpected,
  loadRidgeWorld,
  toBudget,
  toCostModel,
  toSlopeLimit,
  type ModelSpec,
} from './fixtures.js';

const graph = loadRidgeWorld();
const expected = loadExpected();

function modelLabel(model: ModelSpec): string {
  return model.kind === 'time'
    ? `time(${model.v_flat_mps.toFixed(2)},${model.vam_mps.toFixed(4)})`
    : `dist(cf=${model.climb_factor})`;
}

describe('shared constants', () => {
  it('agree with the Python side that generated the golden files', () => {
    expect(R_EARTH_M).toBe(expected.constants.r_earth_m);
    expect(H_SAFETY).toBe(expected.constants.h_safety);
    expect(SLOPE_STEP_PCT).toBe(expected.constants.slope_step_pct);
  });
});

describe('routes reproduce the Python reference exactly', () => {
  it('covers both reachable and unreachable outcomes and both cost models', () => {
    expect(expected.routes.length).toBeGreaterThan(80);
    expect(expected.routes.some((r) => r.found)).toBe(true);
    expect(expected.routes.some((r) => !r.found)).toBe(true);
    expect(new Set(expected.routes.map((r) => r.model.kind))).toEqual(
      new Set(['time', 'dist_equiv']),
    );
  });

  for (const want of expected.routes) {
    const label =
      `${want.name} ${want.from}->${want.to} ` +
      `${modelLabel(want.model)} slope=${want.max_slope_pct ?? 'none'}`;

    it(label, () => {
      const got = route(graph, want.from, want.to, toCostModel(want.model), {
        maxSlopePct: toSlopeLimit(want.max_slope_pct),
      });

      if (!want.found) {
        expect(got).toBeNull();
        return;
      }

      expect(got).not.toBeNull();
      const result = got!;

      // Bit-exact, not approximate -- see the file header. cost is seconds under
      // the time model, distance-equivalent metres under the fallback.
      expect(result.cost).toBe(want.cost_s);
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
      `source=${want.source} ${modelLabel(want.model)} ` +
      `slope=${want.max_slope_pct ?? 'none'} budget=${want.max_cost_s ?? 'none'}`;

    it(label, () => {
      const got = effortField(graph, want.source, toCostModel(want.model), {
        maxSlopePct: toSlopeLimit(want.max_slope_pct),
        maxCost: toBudget(want.max_cost_s),
      });

      expect(got.count).toBe(want.edge_count);

      // Compare the whole field, entry by entry, in *both* channels -- time and
      // cum_ascent are what the frontend joins onto tiles, so a single wrong edge
      // in either is a visible bug.
      const mismatches: string[] = [];
      for (const [edgeId, time, cumAscent] of want.entries) {
        if (got.time[edgeId] !== time) {
          mismatches.push(`edge ${edgeId} time: ${got.time[edgeId]} != ${time}`);
        }
        if (got.cumAscent[edgeId] !== cumAscent) {
          mismatches.push(`edge ${edgeId} cum_ascent: ${got.cumAscent[edgeId]} != ${cumAscent}`);
        }
      }
      const expectedIds = new Set(want.entries.map(([id]) => id));
      for (let id = 0; id < got.time.length; id++) {
        if (Number.isFinite(got.time[id]) && !expectedIds.has(id)) {
          mismatches.push(`edge ${id} unexpectedly present`);
        }
      }
      expect(mismatches).toEqual([]);
    });
  }

  it('excludes the disconnected island from an unbudgeted field', () => {
    const field = effortField(graph, 0, toCostModel(expected.effort_fields[0].model));
    const islandEdges = new Set<number>();
    for (const node of expected.fixtures.island) {
      for (let e = graph.csrOffset[node]; e < graph.csrOffset[node + 1]; e++) {
        islandEdges.add(graph.edgeId[e]);
      }
    }
    expect(islandEdges.size).toBeGreaterThan(0);
    for (const id of islandEdges) expect(field.time[id]).toBe(Infinity);
  });
});
