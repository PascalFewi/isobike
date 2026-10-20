/**
 * geometry.bin range reads, route polylines, and the effort-field grid trailer.
 *
 * The Ridge-World fixture has no geometry.bin, so one is built here the way
 * `build/export.py` writes it: per edge id, endpoint node coordinates (u -> v as
 * the first half-edge carrying that id runs) with one interior vertex between.
 */

import { describe, expect, it } from 'vitest';

import type { Graph } from '../src/binformat.js';
import {
  GEOM_HEADER_SIZE,
  RUN_GAP,
  createGeometrySource,
  idRuns,
  parseGeometryHeader,
  routeGeometry,
  type RangeReader,
} from '../src/geometry.js';
import { handleRequest } from '../src/handlers.js';
import { GRID_NONE, effortGrid, parseEffortFieldResponse, serializeEffortField } from '../src/protocol.js';
import { effortField, route, sourceOf, timeModel } from '../src/router.js';
import { loadRidgeWorld } from './fixtures.js';

const graph = loadRidgeWorld();
const MODEL = timeModel(7.5, 0.19444444444444445);

/** geometry.bin for a graph: 3 vertices per edge, the middle one 5 m higher. */
function buildGeometryBin(g: Graph): ArrayBuffer {
  const ends: Array<[number, number] | undefined> = new Array(g.geomEdgeCount);
  for (let e = 0; e < g.dirEdgeCount; e++) {
    const id = g.edgeId[e];
    if (ends[id] === undefined) ends[id] = [sourceOf(g, e), g.edgeTarget[e]];
  }
  const nVert = 3 * g.geomEdgeCount;
  const buf = new ArrayBuffer(GEOM_HEADER_SIZE + 4 * (g.geomEdgeCount + 1) + 12 * nVert);
  const bytes = new Uint8Array(buf);
  const view = new DataView(buf);
  'VGEO'.split('').forEach((c, i) => (bytes[i] = c.charCodeAt(0)));
  view.setUint16(4, 1, true);
  view.setUint16(6, GEOM_HEADER_SIZE, true);
  view.setUint32(8, g.geomEdgeCount, true);
  view.setUint32(12, nVert, true);
  const offs = new Uint32Array(buf, GEOM_HEADER_SIZE, g.geomEdgeCount + 1);
  const verts = new Float32Array(buf, GEOM_HEADER_SIZE + 4 * (g.geomEdgeCount + 1), 3 * nVert);
  for (let id = 0; id < g.geomEdgeCount; id++) {
    offs[id] = 3 * id;
    const [u, v] = ends[id]!;
    const pts = [
      [g.nodeLat[u], g.nodeLon[u], g.nodeElev[u]],
      [(g.nodeLat[u] + g.nodeLat[v]) / 2, (g.nodeLon[u] + g.nodeLon[v]) / 2, (g.nodeElev[u] + g.nodeElev[v]) / 2 + 5],
      [g.nodeLat[v], g.nodeLon[v], g.nodeElev[v]],
    ];
    pts.forEach((p, k) => verts.set(p, 3 * (3 * id + k)));
  }
  offs[g.geomEdgeCount] = nVert;
  return buf;
}

/** An in-memory RangeReader that counts its reads. */
function memoryReader(buf: ArrayBuffer): RangeReader & { reads: number } {
  const r = {
    reads: 0,
    async read(offset: number, length: number) {
      r.reads++;
      if (offset < 0 || offset + length > buf.byteLength) throw new Error('read out of range');
      return buf.slice(offset, offset + length);
    },
  };
  return r;
}

const GEOM = buildGeometryBin(graph);

describe('idRuns', () => {
  it('merges ids closer than the gap and keeps distant ones apart', () => {
    expect(idRuns([5, 3, 3, 4, 4 + RUN_GAP, 10_000])).toEqual([[3, 4 + RUN_GAP], [10_000, 10_000]]);
    expect(idRuns([])).toEqual([]);
  });
});

describe('routeGeometry', () => {
  it('is one continuous polyline from the first to the last node', async () => {
    const r = route(graph, 287, 306, MODEL)!;
    const reader = memoryReader(GEOM);
    const header = parseGeometryHeader(GEOM.slice(0, GEOM_HEADER_SIZE));
    const coords = await routeGeometry(graph, reader, header, r.nodes, r.edgeIds);

    // 3 vertices per edge, shared junctions once.
    expect(coords.length).toBe(1 + 2 * r.edgeIds.length);
    const first = r.nodes[0];
    const last = r.nodes[r.nodes.length - 1];
    expect(coords[0][0]).toBeCloseTo(graph.nodeLon[first], 5);
    expect(coords[0][1]).toBeCloseTo(graph.nodeLat[first], 5);
    expect(coords[coords.length - 1][0]).toBeCloseTo(graph.nodeLon[last], 5);
    expect(coords[coords.length - 1][1]).toBeCloseTo(graph.nodeLat[last], 5);
    // Every junction vertex is the route's node at that step, whichever way the
    // edge is stored: orientation was resolved per edge.
    r.nodes.forEach((n, i) => {
      expect(coords[2 * i][1]).toBeCloseTo(graph.nodeLat[n], 5);
      expect(coords[2 * i][2]).toBeCloseTo(graph.nodeElev[n], 1);
    });
    // Few reads: two per contiguous id run, not two per edge.
    expect(reader.reads).toBe(2 * idRuns(r.edgeIds).length);
  });

  it('is served by /route when a geometry source is given, and omitted without one', async () => {
    const body = JSON.stringify({ from: [graph.nodeLat[287], graph.nodeLon[287]], to: [graph.nodeLat[306], graph.nodeLon[306]], v_flat: 7.5, vam: 0.19444444444444445 });
    const req = () => new Request('https://worker.test/route', { method: 'POST', headers: { 'content-type': 'application/json' }, body });
    const withGeom = await (await handleRequest(graph, req(), { geometry: createGeometrySource(memoryReader(GEOM)) })).json() as { geometry: number[][]; edge_ids: number[] };
    expect(withGeom.geometry.length).toBe(1 + 2 * withGeom.edge_ids.length);
    const without = await (await handleRequest(graph, req())).json() as Record<string, unknown>;
    expect(without.geometry).toBeUndefined();
    expect(without.found).toBe(true);
  });

  it('degrades to a route without geometry when geometry.bin is missing', async () => {
    const missing = createGeometrySource({ read: () => Promise.reject(new Error('geometry object not found')) });
    const body = JSON.stringify({ from: [graph.nodeLat[287], graph.nodeLon[287]], to: [graph.nodeLat[306], graph.nodeLon[306]], v_flat: 7.5, vam: 0.19444444444444445 });
    const res = await handleRequest(graph, new Request('https://worker.test/route', { method: 'POST', headers: { 'content-type': 'application/json' }, body }), { geometry: missing });
    const json = await res.json() as Record<string, unknown>;
    expect(res.status).toBe(200);
    expect(json.found).toBe(true);
    expect(json.geometry).toBeUndefined();
    expect(String(json.geometry_error)).toContain('not found');
  });
});

describe('effort-field grid', () => {
  const field = effortField(graph, 100, MODEL, { maxCost: 100_000 });

  it('holds the minimum minutes per cell, 0 at the start', () => {
    const grid = effortGrid(graph, field, 0.5);
    const lon = graph.nodeLon[100];
    const lat = graph.nodeLat[100];
    const cx = Math.floor((lon - grid.westLon) / grid.cellLonDeg);
    const cy = Math.floor((grid.northLat - lat) / grid.cellLatDeg);
    expect(grid.minutes[cy * grid.nx + cx]).toBe(0);
    const reached = grid.minutes.filter((m) => m !== GRID_NONE);
    expect(reached.length).toBeGreaterThan(10);
    expect(Math.max(...reached)).toBeLessThanOrEqual(Math.round(Math.max(...field.time.filter(Number.isFinite)) / 60));
  });

  it('round-trips as a trailer and is absent by default', () => {
    const grid = effortGrid(graph, field, 0.5);
    const withGrid = parseEffortFieldResponse(serializeEffortField(graph, 100, field, grid));
    expect(withGrid.grid).not.toBeNull();
    expect(withGrid.grid!.nx).toBe(grid.nx);
    expect(Array.from(withGrid.grid!.minutes)).toEqual(Array.from(grid.minutes));
    expect(withGrid.count).toBe(field.count);
    expect(parseEffortFieldResponse(serializeEffortField(graph, 100, field)).grid).toBeNull();
  });

  it('is returned by /effort-field only when grid_km is set', async () => {
    const mk = (extra: object) => new Request('https://worker.test/effort-field', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ lat: graph.nodeLat[100], lon: graph.nodeLon[100], v_flat: 7.5, vam: 0.19444444444444445, ...extra }),
    });
    const plain = parseEffortFieldResponse(await (await handleRequest(graph, mk({}))).arrayBuffer());
    const gridded = parseEffortFieldResponse(await (await handleRequest(graph, mk({ grid_km: 1 }))).arrayBuffer());
    expect(plain.grid).toBeNull();
    expect(gridded.grid).not.toBeNull();
    expect(gridded.count).toBe(plain.count);
    const bad = await handleRequest(graph, mk({ grid_km: 0.01 }));
    expect(bad.status).toBe(400);
  });
});
