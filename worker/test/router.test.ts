/**
 * Router correctness in TypeScript's own terms.
 *
 * The golden suite proves TypeScript agrees with Python. This one proves the
 * TypeScript implementation is internally coherent -- A* against its own
 * Dijkstra, the heuristic against true costs -- so that a shared misconception
 * baked into both languages would still be caught here.
 */

import { describe, expect, it } from 'vitest';

import { decodeMaxSlope, slopeExceeds, type Graph } from '../src/binformat.js';
import { haversineM } from '../src/geo.js';
import {
  astar,
  dijkstra,
  edgeWeight,
  effortField,
  heuristic,
  route,
  snap,
  sourceOf,
} from '../src/router.js';
import { loadExpected, loadRidgeWorld } from './fixtures.js';

const graph = loadRidgeWorld();
const expected = loadExpected();

/** Same sweep the Python suite uses, so a failure translates directly. */
const SWEEP: Array<[number, number | undefined]> = [
  [0, undefined],
  [5, undefined],
  [60, undefined],
  [200, undefined],
  [0, 12],
  [20, 8],
  [60, 6],
];

/**
 * True cost from every node *to* `goal`, via Dijkstra on the reversed arcs.
 *
 * Cannot be obtained by searching forward from `goal`: cost is directed (ascent
 * one way is descent the other), so the stored twin half-edge carries a different
 * weight, not the same one.
 */
function reverseCosts(g: Graph, goal: number, climbFactor: number, maxSlopePct?: number): Float64Array {
  const heads = new Int32Array(g.nodeCount).fill(-1);
  const next = new Int32Array(g.dirEdgeCount).fill(-1);
  const from = new Int32Array(g.dirEdgeCount);
  const weight = new Float64Array(g.dirEdgeCount);

  for (let u = 0; u < g.nodeCount; u++) {
    for (let e = g.csrOffset[u]; e < g.csrOffset[u + 1]; e++) {
      if (maxSlopePct !== undefined && slopeExceeds(g.edgeMaxSlope[e], maxSlopePct)) continue;
      const v = g.edgeTarget[e];
      from[e] = u;
      weight[e] = edgeWeight(g, e, climbFactor);
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
  it.each(SWEEP)('never overestimates at cf=%s slope=%s', (climbFactor, maxSlope) => {
    for (const goal of [0, 187, expected.fixtures.bump_b, expected.fixtures.island[0]]) {
      const truth = reverseCosts(graph, goal, climbFactor, maxSlope);
      for (let node = 0; node < graph.nodeCount; node++) {
        if (!Number.isFinite(truth[node])) continue;
        const h = heuristic(graph, node, goal, climbFactor);
        expect(h, `h(${node}->${goal}) at cf=${climbFactor}`).toBeLessThanOrEqual(truth[node]);
      }
    }
  });

  it.each(SWEEP)('is consistent on every edge at cf=%s slope=%s', (climbFactor, maxSlope) => {
    for (const goal of [0, 260]) {
      for (let u = 0; u < graph.nodeCount; u++) {
        const hu = heuristic(graph, u, goal, climbFactor);
        for (let e = graph.csrOffset[u]; e < graph.csrOffset[u + 1]; e++) {
          if (maxSlope !== undefined && slopeExceeds(graph.edgeMaxSlope[e], maxSlope)) continue;
          const hv = heuristic(graph, graph.edgeTarget[e], goal, climbFactor);
          expect(hu).toBeLessThanOrEqual(edgeWeight(graph, e, climbFactor) + hv + 1e-9);
        }
      }
    }
  });

  it('is zero at the goal', () => {
    for (const goal of [0, 100, 356]) expect(heuristic(graph, goal, goal, 50)).toBe(0);
  });

  it('uses the climb term, not just the straight line', () => {
    let highest = 0;
    for (let n = 1; n < graph.nodeCount; n++) {
      if (graph.nodeElev[n] > graph.nodeElev[highest]) highest = n;
    }
    const low = 176;
    const line = haversineM(
      graph.nodeLat[low], graph.nodeLon[low], graph.nodeLat[highest], graph.nodeLon[highest],
    );
    expect(heuristic(graph, low, highest, 50)).toBeGreaterThan(line * 1.5);
  });
});

describe('A* matches this implementation of Dijkstra', () => {
  it.each(SWEEP)('for every node pair at cf=%s slope=%s', (climbFactor, maxSlope) => {
    const failures: string[] = [];

    for (let src = 0; src < graph.nodeCount; src++) {
      const { cost } = dijkstra(graph, src, climbFactor, { maxSlopePct: maxSlope });
      for (let dst = 0; dst < graph.nodeCount; dst++) {
        const found = astar(graph, src, dst, climbFactor, { maxSlopePct: maxSlope });
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

describe('path reconstruction', () => {
  it('finds the owning node of every half-edge', () => {
    for (let u = 0; u < graph.nodeCount; u++) {
      for (let e = graph.csrOffset[u]; e < graph.csrOffset[u + 1]; e++) {
        expect(sourceOf(graph, e)).toBe(u);
      }
    }
  });

  it('totals match the edges actually traversed', () => {
    const result = route(graph, 46, 261, 25);
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
    const r = route(graph, 42, 42, 10);
    expect(r).not.toBeNull();
    expect(r!.edgeIds).toEqual([]);
    expect(r!.cost).toBe(0);
    expect(r!.distM).toBe(0);
  });

  it('reports a route over the bump that endpoint elevations would miss', () => {
    const { bump_anchor: anchor, bump_b: b } = expected.fixtures;
    const r = route(graph, anchor, b, 0);
    expect(r).not.toBeNull();
    const netGain = Math.max(0, graph.nodeElev[b] - graph.nodeElev[anchor]);
    expect(r!.ascentM).toBeGreaterThan(netGain + 10);
    expect(r!.descentM).toBeGreaterThan(expected.constants.bump_height_m - 0.5);
  });
});

describe('unreachability', () => {
  it('returns null into and out of the island', () => {
    for (const node of expected.fixtures.island) {
      expect(route(graph, 0, node, 10)).toBeNull();
      expect(astar(graph, 0, node, 10)).toBeNull();
      expect(route(graph, node, 0, 10)).toBeNull();
    }
  });

  it('still routes within the island', () => {
    const [a, , c] = expected.fixtures.island;
    const r = route(graph, a, c, 10);
    expect(r).not.toBeNull();
    expect(r!.distM).toBeGreaterThan(0);
  });

  it('reports the ridge as a wall under a 6 % filter', () => {
    expect(route(graph, 287, 306, 0, { maxSlopePct: 6 })).toBeNull();
  });
});

describe('the effort model', () => {
  it('trades distance for ascent as climbFactor rises', () => {
    const direct = route(graph, 287, 306, 0)!;
    const flattest = route(graph, 287, 306, 200)!;
    expect(flattest.ascentM).toBeLessThan(direct.ascentM * 0.75);
    expect(flattest.distM).toBeGreaterThan(direct.distM * 1.1);
  });

  it('is pure shortest path at climbFactor 0', () => {
    const r = route(graph, 287, 306, 0)!;
    expect(r.cost).toBeCloseTo(r.distM, 9);
  });

  it('never lowers cost when the slope filter tightens', () => {
    let previous = 0;
    for (const limit of [undefined, 15, 12, 10, 8]) {
      const r = route(graph, 287, 306, 10, { maxSlopePct: limit });
      expect(r).not.toBeNull();
      expect(r!.cost).toBeGreaterThanOrEqual(previous - 1e-9);
      if (limit !== undefined) expect(r!.maxSlopePct).toBeLessThanOrEqual(limit);
      previous = r!.cost;
    }
  });

  it('costs an edge at its cheaper endpoint (decision D2)', () => {
    const { cost } = dijkstra(graph, 0, 10);
    const field = effortField(graph, 0, 10);
    for (let u = 0; u < graph.nodeCount; u++) {
      for (let e = graph.csrOffset[u]; e < graph.csrOffset[u + 1]; e++) {
        const id = graph.edgeId[e];
        if (Number.isFinite(field.cost[id])) {
          expect(field.cost[id]).toBe(Math.min(cost[u], cost[graph.edgeTarget[e]]));
        }
      }
    }
  });

  it('truncates monotonically as the budget shrinks, without changing costs', () => {
    const full = effortField(graph, 0, 10);
    let previous = 0;
    for (const budget of [500, 2000, 10000, Infinity]) {
      const field = effortField(graph, 0, 10, { maxCost: budget });
      for (let id = 0; id < field.cost.length; id++) {
        if (!Number.isFinite(field.cost[id])) continue;
        expect(field.cost[id]).toBeLessThanOrEqual(budget);
        expect(field.cost[id]).toBe(full.cost[id]);
      }
      expect(field.count).toBeGreaterThanOrEqual(previous);
      previous = field.count;
    }
    expect(full.count).toBeGreaterThan(effortField(graph, 0, 10, { maxCost: 500 }).count);
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
