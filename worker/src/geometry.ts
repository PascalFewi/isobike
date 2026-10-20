/**
 * Route geometry from `geometry.bin` (written by `build/export.py`).
 *
 * `graph.bin` holds only junction nodes, so a route drawn or exported from it
 * would cut straight across every bend of a long mountain road. `geometry.bin`
 * holds each edge's full polyline with an elevation per vertex. It is far too
 * big to keep in the isolate (~200 MB nationwide), so the Worker reads only the
 * byte ranges a route needs: edge ids are numbered along a Hilbert curve at build
 * time, so a route's edges fall into a few contiguous id runs, and each run costs
 * two range reads (its offsets, then its vertices).
 *
 * Layout (little-endian), mirrored from `build/export.py`:
 *
 *   off  size      type        field
 *     0     4      ascii       magic "VGEO"
 *     4     2      u16         format version (1)
 *     6     2      u16         header size (32)
 *     8     4      u32         edge count E
 *    12     4      u32         vertex count V
 *    16    16      --          reserved
 *    32  4(E+1)    u32[E+1]    first vertex of edge e
 *     .   12V      f32[V*3]    (lat, lon, elevation_m), oriented u -> v
 */

import type { Graph } from './binformat.js';

export const GEOM_MAGIC = 'VGEO';
export const GEOM_VERSION = 1;
export const GEOM_HEADER_SIZE = 32;

/** Two runs of edge ids closer than this are read as one range (fewer requests,
 * a few KB of unused vertices in between). */
export const RUN_GAP = 256;

/** Byte-range access to `geometry.bin`; R2 in the Worker, a buffer in tests. */
export interface RangeReader {
  read(offset: number, length: number): Promise<ArrayBuffer>;
}

export interface GeometryHeader {
  readonly edgeCount: number;
  readonly vertexCount: number;
}

export function parseGeometryHeader(buffer: ArrayBuffer): GeometryHeader {
  const bytes = new Uint8Array(buffer);
  if (bytes.length < GEOM_HEADER_SIZE) throw new Error('geometry.bin header truncated');
  let magic = '';
  for (let i = 0; i < 4; i++) magic += String.fromCharCode(bytes[i]);
  if (magic !== GEOM_MAGIC) throw new Error(`bad geometry.bin magic ${JSON.stringify(magic)}`);
  const view = new DataView(buffer);
  if (view.getUint16(4, true) !== GEOM_VERSION) throw new Error('unsupported geometry.bin version');
  return { edgeCount: view.getUint32(8, true), vertexCount: view.getUint32(12, true) };
}

/** Group sorted unique ids into runs whose gaps are below {@link RUN_GAP}. */
export function idRuns(ids: readonly number[]): Array<[number, number]> {
  const sorted = [...new Set(ids)].sort((a, b) => a - b);
  const runs: Array<[number, number]> = [];
  for (const id of sorted) {
    const last = runs[runs.length - 1];
    if (last !== undefined && id - last[1] <= RUN_GAP) last[1] = id;
    else runs.push([id, id]);
  }
  return runs;
}

/** Per edge id: its vertices as `[lat, lon, ele]` triples, u -> v. */
export async function readEdgeVertices(
  reader: RangeReader,
  header: GeometryHeader,
  ids: readonly number[],
): Promise<Map<number, Float32Array>> {
  const out = new Map<number, Float32Array>();
  const vertBase = GEOM_HEADER_SIZE + 4 * (header.edgeCount + 1);
  await Promise.all(
    idRuns(ids).map(async ([a, b]) => {
      if (b >= header.edgeCount) throw new Error(`edge id ${b} outside geometry.bin`);
      const offs = new Uint32Array(await reader.read(GEOM_HEADER_SIZE + 4 * a, 4 * (b - a + 2)));
      const first = offs[0];
      const raw = await reader.read(vertBase + 12 * first, 12 * (offs[b - a + 1] - first));
      const verts = new Float32Array(raw);
      for (const id of ids) {
        if (id < a || id > b) continue;
        out.set(id, verts.subarray(3 * (offs[id - a] - first), 3 * (offs[id - a + 1] - first)));
      }
    }),
  );
  return out;
}

/**
 * The route as one continuous polyline `[lon, lat, ele]`, from the first node to
 * the last. `nodes[i] -> nodes[i+1]` runs along `edgeIds[i]`; an edge stored the
 * other way round is reversed. Shared junction vertices appear once.
 */
export async function routeGeometry(
  graph: Graph,
  reader: RangeReader,
  header: GeometryHeader,
  nodes: readonly number[],
  edgeIds: readonly number[],
): Promise<Array<[number, number, number]>> {
  const byId = await readEdgeVertices(reader, header, edgeIds);
  const coords: Array<[number, number, number]> = [];
  for (let i = 0; i < edgeIds.length; i++) {
    const v = byId.get(edgeIds[i]);
    if (v === undefined || v.length < 6) continue;
    const from = nodes[i];
    const n = v.length / 3;
    // Endpoints are stored as exactly the f32 node coordinates graph.bin holds.
    const forward = v[0] === graph.nodeLat[from] && v[1] === graph.nodeLon[from];
    for (let k = coords.length === 0 ? 0 : 1; k < n; k++) {
      const j = forward ? k : n - 1 - k;
      coords.push([round(v[3 * j + 1], 1e6), round(v[3 * j], 1e6), round(v[3 * j + 2], 10)]);
    }
  }
  return coords;
}

function round(x: number, scale: number): number {
  return Math.round(x * scale) / scale;
}

/**
 * Isolate-scoped loader: reads the 32-byte header once and caches it (as a
 * promise, like the graph store, so concurrent cold requests share one read).
 */
export function createGeometrySource(reader: RangeReader): {
  readonly reader: RangeReader;
  header(): Promise<GeometryHeader>;
} {
  let cached: Promise<GeometryHeader> | null = null;
  return {
    reader,
    header() {
      if (cached === null) {
        const pending = reader.read(0, GEOM_HEADER_SIZE).then(parseGeometryHeader);
        pending.catch(() => {
          if (cached === pending) cached = null;
        });
        cached = pending;
      }
      return cached;
    },
  };
}

export type GeometrySource = ReturnType<typeof createGeometrySource>;
