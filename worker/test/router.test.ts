/**
 * Router correctness in TypeScript's own terms.
 *
 * The golden suite proves TypeScript agrees with Python. This one proves the
 * TypeScript implementation is internally coherent -- A* against its own
 * Dijkstra, the heuristic against true costs, the accumulators against the
 * reconstructed path -- so that a shared misconception baked into both languages
 * would still be caught here.
 */

import { describe, expect, it } from 'vitest';

import { decodeMaxSlope, slopeExceeds, type Graph } from '../src/binformat.js';
import { haversineM } from '../src/geo.js';
import {
  astar,
  buildRoute,
  dijkstra,
  distanceEquivModel,
  edgeWeight,
  effortField,
  heuristic,
  route,
  snap,
  sourceOf,
  timeModel,
  type CostModel,
} from '../src/router.js';
import { loadExpected, loadRidgeWorld } from './fixtures.js';

const graph = loadRidgeWorld();
const expected = loadExpected();

// The three anchor profiles, from the golden file so they are the exact m/s
// values Python used, plus the two fallback models.
const [FLACH, MIXED, GEBIRGE] = expected.profiles.map((p) => timeModel(p.v_flat_mps, p.vam_mps));
const DIST0 = distanceEquivModel(0);
const DIST60 = distanceEquivModel(60);

/** Same sweep the Python suite uses, so a failure translates directly. */
const SWEEP: Array<[string, CostModel, number | undefined]> = [
  ['flach', FLACH, undefined],
  ['mixed', MIXED, undefined],
  ['gebirge', GEBIRGE, undefined],
  ['dist0', DIST0, undefined],
  ['dist60', DIST60, undefined],
  ['mixed@12', MIXED, 12],
  ['gebirge@8', GEBIRGE, 8],
  ['flach@6', FLACH, 6],
];

/**
 * True cost from every node *to* `goal`, via Dijkstra on the reversed arcs.
 *
 * Cannot be obtained by searching forward from `goal`: cost is directed (ascent
 * one way is descent the other), so the stored twin half-edge carries a different
 * weight, not the same one.
 */
function reverseCosts(g: Graph, goal: number, model: CostModel, maxSlopePct?: number): Float64Array {
  const heads = new Int32Array(g.nodeCount).fill(-1);
  const next = new Int32Array(g.dirEdgeCount).fill(-1);
  const from = new Int32Array(g.dirEdgeCount);
  const weight = new Float64Array(g.dirEdgeCount);

  for (let u = 0; u < g.nodeCount; u++) {
    for (let e = g.csrOffset[u]; e < g.csrOffset[u + 1]; e++) {
      if (maxSlopePct !== undefined && slopeExceeds(g.edgeMaxSlope[e], maxSlopePct)) continue;
      const v = g.edgeTarget[e];
      from[e] = u;
      weight[e] = edgeWeight(g, e, model);
      next[e] = heads[v];
      heads[v] = e;
    }
  }

  const cost = new Float64Array(g.nodeCount).fill(Infinity);
  const settled = new Uint8Array(g.nodeCount);
  cost[goal] = 0;
  const queue: Array<[number, number]> = [[0, goal]];
  while (queue.length > 0) {
    queue.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const [c, u] = queue.shift()!;
    if (settled[u] === 1) continue;
    settled[u] = 1;
    for (let e = heads[u]; e !== -1; e = next[e]) {
      const v = from[e];
      const nc = c + weight[e];
      if (nc < cost[v]) {
        cost[v] = nc;
        queue.push([nc, v]);
      }
    }
  }
  return cost;
}

describe('the A* heuristic', () => {
  it.each(SWEEP)('never overestimates at %s', (_label, model, maxSlope) => {
    for (const goal of [0, 187, expected.fixtures.bump_b, expected.fixtures.island[0]]) {
      const truth = reverseCosts(graph, goal, model, maxSlope);
      for (let node = 0; node < graph.nodeCount; node++) {
        if (!Number.isFinite(truth[node])) continue;
        const h = heuristic(graph, node, goal, model);
        expect(h, `h(${node}->${goal})`).toBeLessThanOrEqual(truth[node]);
      }
    }
  });

  it.each(SWEEP)('is consistent on every edge at %s', (_label, model, maxSlope) => {
    for (const goal of [0, 260]) {
      for (let u = 0; u < graph.nodeCount; u++) {
        const hu = heuristic(graph, u, goal, model);
        for (let e = graph.csrOffset[u]; e < graph.csrOffset[u + 1]; e++) {
          if (maxSlope !== undefined && slopeExceeds(graph.edgeMaxSlope[e], maxSlope)) continue;
          const hv = heuristic(graph, graph.edgeTarget[e], goal, model);
          expect(hu).toBeLessThanOrEqual(edgeWeight(graph, e, model) + hv + 1e-9);
        }
      }
    }
  });

  it('is zero at the goal', () => {
    for (const goal of [0, 100, 356]) expect(heuristic(graph, goal, goal, MIXED)).toBe(0);
  });

  it('is exactly H_SAFETY * line under the pure-distance model', () => {
    const node = 0;
    const goal = 200;
    const line = haversineM(graph.nodeLat[node], graph.nodeLon[node], graph.nodeLat[goal], graph.nodeLon[goal]);
    expect(heuristic(graph, node, goal, DIST0)).toBeCloseTo((1 - 2 ** -16) * line, 6);
  });
});

describe('A* matches this implementation of Dijkstra', () => {
  it.each(SWEEP)('for every node pair at %s', (_label, model, maxSlope) => {
    const failures: string[] = [];

    for (let src = 0; src < graph.nodeCount; src++) {
      const { cost } = dijkstra(graph, src, model, { maxSlopePct: maxSlope });
      for (let dst = 0; dst < graph.nodeCount; dst++) {
        const found = astar(graph, src, dst, model, { maxSlopePct: maxSlope });
        if (!Number.isFinite(cost[dst])) {
          if (found !== null) failures.push(`${src}->${dst}: A* found an unreachable route`);
          continue;
        }
        if (found === null) {
          failures.push(`${src}->${dst}: A* missed a reachable route`);
        } else if (found.cost !== cost[dst]) {
          failures.push(`${src}->${dst}: A* cost ${found.cost} != Dijkstra ${cost[dst]}`);
        }
      }
    }
    expect(failures.slice(0, 10)).toEqual([]);
  });
});

describe('the three per-node accumulators', () => {
  it('match the totals along the reconstructed optimal path', () => {
    const { cost, cumAscent, maxSlope, incoming } = dijkstra(graph, 0, MIXED);
    let checked = 0;
    for (let dst = 0; dst < graph.nodeCount; dst++) {
      if (!Number.isFinite(cost[dst])) continue;
      const r = buildRoute(graph, 0, dst, cost, incoming);
      expect(r).not.toBeNull();
      expect(cumAscent[dst]).toBeCloseTo(r!.ascentM, 9);
      expect(decodeMaxSlope(maxSlope[dst])).toBe(r!.maxSlopePct);
      checked++;
    }
    expect(checked).toBeGreaterThan(300);
  });

  it('reports cost as dist/v_flat + ascent/vam', () => {
    const profile = expected.profiles[1]; // mixed
    const r = route(graph, 46, 261, timeModel(profile.v_flat_mps, profile.vam_mps));
    expect(r).not.toBeNull();
    const want = r!.distM / profile.v_flat_mps + r!.ascentM / profile.vam_mps;
    expect(r!.cost).toBeCloseTo(want, 6);
  });
});

describe('path reconstruction', () => {
  it('finds the owning node of every half-edge', () => {
    for (let u = 0; u < graph.nodeCount; u++) {
      for (let e = graph.csrOffset[u]; e < graph.csrOffset[u + 1]; e++) {
        expect(sourceOf(graph, e)).toBe(u);
      }
    }
  });

  it('totals match the edges actually traversed', () => {
    const result = route(graph, 46, 261, GEBIRGE);
    expect(result).not.toBeNull();
    const r = result!;

    let dist = 0;
    let ascent = 0;
    let descent = 0;
    let slope = 0;
    for (let i = 0; i + 1 < r.nodes.length; i++) {
      const u = r.nodes[i];
      const v = r.nodes[i + 1];
      for (let e = graph.csrOffset[u]; e < graph.csrOffset[u + 1]; e++) {
        if (graph.edgeTarget[e] === v) {
          dist += graph.edgeDist[e];
          ascent += graph.edgeAscent[e];
          descent += graph.edgeDescent[e];
          if (graph.edgeMaxSlope[e] > slope) slope = graph.edgeMaxSlope[e];
          break;
        }
      }
    }
    expect(r.distM).toBeCloseTo(dist, 9);
    expect(r.ascentM).toBeCloseTo(ascent, 9);
    expect(r.descentM).toBeCloseTo(descent, 9);
    expect(r.maxSlopePct).toBe(decodeMaxSlope(slope));
    expect(r.edgeIds.length).toBe(r.nodes.length - 1);
  });

  it('returns an empty route to self, not null', () => {
    const r = route(graph, 42, 42, MIXED);
    expect(r).not.toBeNull();
    expect(r!.edgeIds).toEqual([]);
    expect(r!.cost).toBe(0);
    expect(r!.distM).toBe(0);
  });

  it('reports a route over the bump that endpoint elevations would miss', () => {
    const { bump_anchor: anchor, bump_b: b } = expected.fixtures;
    const r = route(graph, anchor, b, MIXED);
    expect(r).not.toBeNull();
    const netGain = Math.max(0, graph.nodeElev[b] - graph.nodeElev[anchor]);
    expect(r!.ascentM).toBeGreaterThan(netGain + 10);
    expect(r!.descentM).toBeGreaterThan(expected.constants.bump_height_m - 0.5);
  });
});

describe('unreachability', () => {
  it('returns null into and out of the island', () => {
    for (const node of expected.fixtures.island) {
      expect(route(graph, 0, node, MIXED)).toBeNull();
      expect(astar(graph, 0, node, MIXED)).toBeNull();
      expect(route(graph, node, 0, MIXED)).toBeNull();
    }
  });

  it('still routes within the island', () => {
    const [a, , c] = expected.fixtures.island;
    const r = route(graph, a, c, MIXED);
    expect(r).not.toBeNull();
    expect(r!.distM).toBeGreaterThan(0);
  });

  it('reports the ridge as a wall under a 6 % filter', () => {
    expect(route(graph, 287, 306, MIXED, { maxSlopePct: 6 })).toBeNull();
  });
});

describe('the effort model', () => {
  it('trades distance for ascent as the profile flattens', () => {
    const direct = route(graph, 287, 306, DIST0)!; // pure shortest
    const flattest = route(graph, 287, 306, FLACH)!; // cf = 60
    expect(flattest.ascentM).toBeLessThan(direct.ascentM * 0.75);
    expect(flattest.distM).toBeGreaterThan(direct.distM * 1.1);
  });

  it('is pure shortest path under the distance model with cf=0', () => {
    const r = route(graph, 287, 306, DIST0)!;
    expect(r.cost).toBeCloseTo(r.distM, 9);
  });

  it('never lowers cost when the slope filter tightens', () => {
    let previous = 0;
    for (const limit of [undefined, 15, 12, 10, 8]) {
      const r = route(graph, 287, 306, MIXED, { maxSlopePct: limit });
      expect(r).not.toBeNull();
      expect(r!.cost).toBeGreaterThanOrEqual(previous - 1e-9);
      if (limit !== undefined) expect(r!.maxSlopePct).toBeLessThanOrEqual(limit);
      previous = r!.cost;
    }
  });

  it('times an edge at its cheaper endpoint with matching cum_ascent (D2)', () => {
    const { cost, cumAscent } = dijkstra(graph, 0, MIXED);
    const field = effortField(graph, 0, MIXED);
    for (let u = 0; u < graph.nodeCount; u++) {
      for (let e = graph.csrOffset[u]; e < graph.csrOffset[u + 1]; e++) {
        const id = graph.edgeId[e];
        if (!Number.isFinite(field.time[id])) continue;
        const v = graph.edgeTarget[e];
        expect(field.time[id]).toBeLessThanOrEqual(Math.min(cost[u], cost[v]) + 1e-9);
        // cum_ascent must be that of some incident endpoint's optimal path.
        const cheaper = cost[u] <= cost[v] ? u : v;
        if (field.time[id] === cost[cheaper]) {
          expect(field.cumAscent[id]).toBeLessThanOrEqual(cumAscent[cheaper] + 1e-9);
        }
      }
    }
  });

  it('truncates monotonically as the budget shrinks, without changing values', () => {
    const full = effortField(graph, 0, MIXED);
    let previous = 0;
    for (const budget of [300, 900, 1800, Infinity]) {
      const field = effortField(graph, 0, MIXED, { maxCost: budget });
      for (let id = 0; id < field.time.length; id++) {
        if (!Number.isFinite(field.time[id])) continue;
        expect(field.time[id]).toBeLessThanOrEqual(budget);
        expect(field.time[id]).toBe(full.time[id]);
        expect(field.cumAscent[id]).toBe(full.cumAscent[id]);
      }
      expect(field.count).toBeGreaterThanOrEqual(previous);
      previous = field.count;
    }
    expect(full.count).toBeGreaterThan(effortField(graph, 0, MIXED, { maxCost: 300 }).count);
  });
});

describe('snapping', () => {
  /** Exhaustive nearest-node scan -- the oracle the grid index must match. */
  function bruteForce(lat: number, lon: number): number {
    const cosLat = Math.cos((lat * Math.PI) / 180);
    let best = -1;
    let bestD2 = Infinity;
    for (let n = 0; n < graph.nodeCount; n++) {
      const dx = (graph.nodeLon[n] - lon) * cosLat;
      const dy = graph.nodeLat[n] - lat;
      const d2 = dx * dx + dy * dy;
      if (d2 < bestD2) {
        bestD2 = d2;
        best = n;
      }
    }
    return best;
  }

  it('matches brute force on a dense sweep beyond the golden probe set', () => {
    const [minLon, minLat, maxLon, maxLat] = graph.bbox;
    const mismatches: string[] = [];
    for (let i = 0; i < 40; i++) {
      for (let j = 0; j < 40; j++) {
        const lat = minLat + ((maxLat - minLat) * (i + 0.293)) / 40;
        const lon = minLon + ((maxLon - minLon) * (j + 0.717)) / 40;
        const got = snap(graph, lat, lon);
        const want = bruteForce(lat, lon);
        if (got !== want) mismatches.push(`(${lat}, ${lon}): ${got} != ${want}`);
      }
    }
    expect(mismatches.slice(0, 5)).toEqual([]);
  });

  it('returns the node itself when the query is a node', () => {
    for (const node of [0, 123, 351, expected.fixtures.bump_b, expected.fixtures.island[2]]) {
      expect(snap(graph, graph.nodeLat[node], graph.nodeLon[node])).toBe(node);
    }
  });

  it('still finds a node far outside the bbox', () => {
    const [minLon, minLat, maxLon, maxLat] = graph.bbox;
    for (const [lat, lon] of [
      [minLat - 5, minLon - 5],
      [maxLat + 5, maxLon + 5],
      [minLat - 0.4, (minLon + maxLon) / 2],
      [(minLat + maxLat) / 2, maxLon + 0.4],
    ]) {
      const node = snap(graph, lat, lon);
      expect(node).toBeGreaterThanOrEqual(0);
      expect(node).toBe(bruteForce(lat, lon));
    }
  });
});
