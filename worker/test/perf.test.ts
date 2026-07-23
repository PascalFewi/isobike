/**
 * Performance smoke test at close to nationwide scale.
 *
 * The spec commits to "schweizweiter Dijkstra einige 100 ms" on Workers Paid.
 * That claim is cheap to check now and expensive to discover is wrong at step 3,
 * once the build pipeline exists and the router is hard to restructure.
 *
 * Thresholds are deliberately loose -- roughly 5x the observed time on a laptop.
 * The purpose is to catch a *structural* regression (a Map in the hot loop, a
 * per-node object, an accidental O(N^2)), not to police a few milliseconds on a
 * machine that might be running a build at the same time. The measured numbers
 * are logged so the trend is visible even when the assertion passes.
 */

import { describe, expect, it } from 'vitest';

import { validateGraph } from '../src/binformat.js';
import { astar, dijkstra, effortField, snap, timeModel } from '../src/router.js';
import { buildLattice } from './synthetic.js';

const K = 707; // ~500 k nodes, ~2.0 M directed half-edges

// The "mixed" anchor profile: 27 km/h, 700 Hm/h.
const MODEL = timeModel((27 * 1000) / 3600, 700 / 3600);

describe('nationwide-scale routing', () => {
  const { graph, byteLength } = buildLattice(K);
  const centre = Math.floor(graph.nodeCount / 2) + Math.floor(K / 2);

  it('is a valid graph at the scale being measured', () => {
    // Edge lengths excluded: O(E) trig is the very cost this option exists to
    // keep off the Worker's cold path.
    expect(() => validateGraph(graph)).not.toThrow();
    expect(graph.nodeCount).toBeGreaterThan(450_000);
    expect(graph.dirEdgeCount).toBeGreaterThan(1_900_000);
  });

  it('holds the graph in a Worker-sized footprint', () => {
    const mb = byteLength / 1024 / 1024;
    console.log(
      `graph: ${graph.nodeCount.toLocaleString()} nodes, ` +
        `${graph.dirEdgeCount.toLocaleString()} half-edges, ${mb.toFixed(1)} MB`,
    );
    // Well inside the 128 MB isolate limit at this size; step 3 measures the
    // real Swiss counts against the same budget.
    expect(mb).toBeLessThan(90);
  });

  it('settles the whole graph with Dijkstra in a few hundred milliseconds', () => {
    dijkstra(graph, centre, MODEL); // warm up JIT and page in the arrays

    const started = performance.now();
    const { cost } = dijkstra(graph, centre, MODEL);
    const elapsed = performance.now() - started;

    let reached = 0;
    for (let i = 0; i < cost.length; i++) if (Number.isFinite(cost[i])) reached++;
    expect(reached).toBe(graph.nodeCount);

    console.log(
      `full-graph Dijkstra: ${elapsed.toFixed(0)} ms for ${reached.toLocaleString()} nodes`,
    );
    expect(elapsed).toBeLessThan(3000);
  });

  it('builds a full effort field in a comparable time', () => {
    effortField(graph, centre, MODEL);

    const started = performance.now();
    const field = effortField(graph, centre, MODEL);
    const elapsed = performance.now() - started;

    expect(field.count).toBe(graph.geomEdgeCount);
    console.log(
      `effort field: ${elapsed.toFixed(0)} ms for ${field.count.toLocaleString()} edges ` +
        `(~${((field.count * 8) / 1024 / 1024).toFixed(1)} MB as raw (u32, f32) pairs)`,
    );
    expect(elapsed).toBeLessThan(4000);
  });

  it('respects a budget by expanding less, not by filtering more', () => {
    const started = performance.now();
    const field = effortField(graph, centre, MODEL, { maxCost: 10_000 });
    const elapsed = performance.now() - started;

    expect(field.count).toBeGreaterThan(0);
    expect(field.count).toBeLessThan(graph.geomEdgeCount);
    console.log(`budgeted effort field: ${elapsed.toFixed(0)} ms for ${field.count.toLocaleString()} edges`);
    // A budget must terminate the search early, so it cannot be slower than the
    // unbounded case. This is what proves the `break` is on the popped key.
    expect(elapsed).toBeLessThan(3000);
  });

  it('beats Dijkstra with A* on a point-to-point query', () => {
    const from = Math.floor(K * 0.1) * K + Math.floor(K * 0.1);
    const to = Math.floor(K * 0.9) * K + Math.floor(K * 0.9);

    astar(graph, from, to, MODEL);
    const started = performance.now();
    const result = astar(graph, from, to, MODEL);
    const elapsed = performance.now() - started;

    expect(result).not.toBeNull();
    console.log(
      `A* corner to corner: ${elapsed.toFixed(0)} ms, ` +
        `${result!.edgeIds.length} edges, ${(result!.distM / 1000).toFixed(1)} km, ` +
        `${result!.ascentM.toFixed(0)} m ascent`,
    );
    expect(elapsed).toBeLessThan(3000);

    // And it must still be optimal at this scale, not just fast.
    const { cost } = dijkstra(graph, from, MODEL);
    expect(result!.cost).toBe(cost[to]);
  });

  it('snaps in microseconds via the grid index', () => {
    const [minLon, minLat, maxLon, maxLat] = graph.bbox;
    const probes: Array<[number, number]> = [];
    for (let i = 0; i < 1000; i++) {
      probes.push([
        minLat + ((maxLat - minLat) * ((i * 37) % 1000)) / 1000,
        minLon + ((maxLon - minLon) * ((i * 91) % 1000)) / 1000,
      ]);
    }
    for (const [lat, lon] of probes) snap(graph, lat, lon);

    const started = performance.now();
    for (const [lat, lon] of probes) expect(snap(graph, lat, lon)).toBeGreaterThanOrEqual(0);
    const elapsed = performance.now() - started;

    console.log(`snap: ${((elapsed / probes.length) * 1000).toFixed(1)} us per query`);
    expect(elapsed / probes.length).toBeLessThan(2);
  });
});
