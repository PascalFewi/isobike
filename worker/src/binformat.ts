/**
 * VeloRouter graph binary format v1 -- reader.
 *
 * This file mirrors `build/binformat.py`, which is the single source of truth for
 * the layout. The byte table lives there; do not duplicate it here, duplicate
 * *behaviour* here and let `testdata/ridge_world/graph.bin` prove the two agree.
 *
 * The graph is parsed **zero-copy**: every section becomes a typed-array view
 * over the caller's ArrayBuffer, no bytes are moved. That is the entire reason
 * the format uses parallel arrays at 8-byte-aligned offsets rather than
 * interleaved records -- `new Float32Array(buf, off, n)` throws unless
 * `off % 4 === 0`. A ~60 MB nationwide graph therefore costs ~60 MB of Worker
 * memory, not 120 MB.
 */

import { haversineM } from './geo.js';

export const MAGIC = 'VELOGRPH';
export const FORMAT_VERSION = 1;
export const HEADER_SIZE = 160;
export const SECTION_ALIGN = 8;
export const SECTION_COUNT = 12;

/** `flags` bit 0: the builder emitted a genuinely directed graph. Provenance only. */
export const FLAG_ONEWAYS_RESPECTED = 1 << 0;

/**
 * Quantisation step of `edgeMaxSlope`, in percent. A power of two, so
 * `u8 * SLOPE_STEP_PCT` is exact in f64 and Python and V8 agree bit for bit.
 */
export const SLOPE_STEP_PCT = 0.25;
export const SLOPE_MAX_U8 = 255;

/** Byte offsets of the header fields. Kept as named constants so the reader reads
 * like the table in binformat.py rather than like a pile of magic numbers. */
const OFF_MAGIC = 0;
const OFF_FORMAT_VERSION = 8;
const OFF_HEADER_SIZE = 12;
const OFF_REGION_ID = 16;
const OFF_BBOX = 32;
const OFF_NODE_COUNT = 64;
const OFF_DIR_EDGE_COUNT = 68;
const OFF_GEOM_EDGE_COUNT = 72;
const OFF_GRID_NX = 76;
const OFF_GRID_NY = 80;
const OFF_FLAGS = 84;
const OFF_SECTIONS = 88;
const OFF_FILE_SIZE = 136;
const OFF_CRC32 = 140;

/** Index into the header's section-offset table. Order is part of the format. */
export const enum Section {
  NodeLat = 0,
  NodeLon = 1,
  NodeElev = 2,
  CsrOffset = 3,
  EdgeTarget = 4,
  EdgeId = 5,
  EdgeDist = 6,
  EdgeAscent = 7,
  EdgeDescent = 8,
  EdgeMaxSlope = 9,
  GridOffset = 10,
  GridNodeId = 11,
}

// --------------------------------------------------------------------------- //
// Errors -- one class per failure mode, matching binformat.py
// --------------------------------------------------------------------------- //

export class BinFormatError extends Error {}
export class BadMagicError extends BinFormatError {}
export class UnsupportedVersionError extends BinFormatError {}
export class TruncatedFileError extends BinFormatError {}
export class ChecksumError extends BinFormatError {}
export class GraphValidationError extends BinFormatError {}

// --------------------------------------------------------------------------- //
// Slope quantisation
// --------------------------------------------------------------------------- //

/** Quantise an uphill grade in percent to the stored u8. Descents encode as 0. */
export function encodeMaxSlope(pct: number): number {
  if (!Number.isFinite(pct) || pct <= 0) return 0;
  return Math.min(SLOPE_MAX_U8, Math.round(pct / SLOPE_STEP_PCT));
}

/** Stored u8 back to percent. Exact in f64. */
export function decodeMaxSlope(value: number): number {
  return value * SLOPE_STEP_PCT;
}

/**
 * Whether an edge must be skipped under a `maxSlope` filter.
 *
 * Compared in f64 against the decoded value rather than by quantising the limit:
 * quantising would put a `floor()` on a boundary where Python and V8 could
 * disagree about which side an edge falls on.
 */
export function slopeExceeds(value: number, limitPct: number): boolean {
  return value * SLOPE_STEP_PCT > limitPct;
}

// --------------------------------------------------------------------------- //
// Graph
// --------------------------------------------------------------------------- //

export interface Graph {
  readonly regionId: string;
  readonly formatVersion: number;
  /** [minLon, minLat, maxLon, maxLat] */
  readonly bbox: readonly [number, number, number, number];
  readonly gridNx: number;
  readonly gridNy: number;
  readonly flags: number;

  readonly nodeCount: number;
  /** Directed half-edges. */
  readonly dirEdgeCount: number;
  /** Geometric edges; `max(edgeId) + 1`. The id space the frontend joins on. */
  readonly geomEdgeCount: number;
  readonly cellCount: number;

  readonly nodeLat: Float32Array;
  readonly nodeLon: Float32Array;
  readonly nodeElev: Float32Array;
  readonly csrOffset: Uint32Array;
  readonly edgeTarget: Uint32Array;
  readonly edgeId: Uint32Array;
  readonly edgeDist: Float32Array;
  readonly edgeAscent: Float32Array;
  readonly edgeDescent: Float32Array;
  readonly edgeMaxSlope: Uint8Array;
  readonly gridOffset: Uint32Array;
  readonly gridNodeId: Uint32Array;
}

export interface ReadGraphOptions {
  /** CRC32 the payload. ~80 ms on a 60 MB graph, paid once per isolate. */
  readonly verifyChecksum?: boolean;
  /** Run the structural invariant checks. */
  readonly validate?: boolean;
  /**
   * Additionally verify every edge is at least as long as the great circle
   * between its endpoints -- the invariant A* admissibility rests on.
   *
   * Off by default here but on by default in Python: this is a property of how
   * the graph was *built*, so it belongs to the build pipeline's pre-export
   * validation, not to a per-isolate cold start that would pay O(E) trig for it.
   */
  readonly checkEdgeLengths?: boolean;
}

// --------------------------------------------------------------------------- //
// CRC32 (zlib / IEEE 802.3, reflected polynomial 0xEDB88320)
// --------------------------------------------------------------------------- //

let crcTable: Int32Array | null = null;

function getCrcTable(): Int32Array {
  if (crcTable !== null) return crcTable;
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  crcTable = table;
  return table;
}

export function crc32(bytes: Uint8Array): number {
  const table = getCrcTable();
  let c = -1; // 0xFFFFFFFF as a signed int
  for (let i = 0; i < bytes.length; i++) {
    c = table[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ -1) >>> 0;
}

// --------------------------------------------------------------------------- //
// Read
// --------------------------------------------------------------------------- //

function alignUp(value: number): number {
  return (value + SECTION_ALIGN - 1) & ~(SECTION_ALIGN - 1);
}

/**
 * Parse a graph binary. Sections are views onto `data`; keep it alive.
 *
 * `data` must begin at the start of the file. In Node, a `Buffer` from
 * `readFileSync` is often a view into a shared pool, so slice its own bytes out
 * before passing the underlying ArrayBuffer.
 */
export function readGraph(data: ArrayBuffer, options: ReadGraphOptions = {}): Graph {
  const { verifyChecksum = true, validate = true, checkEdgeLengths = false } = options;

  if (data.byteLength < HEADER_SIZE) {
    throw new TruncatedFileError(
      `buffer is ${data.byteLength} bytes, need at least ${HEADER_SIZE}`,
    );
  }

  const view = new DataView(data);
  const bytes = new Uint8Array(data);

  let magic = '';
  for (let i = 0; i < 8; i++) magic += String.fromCharCode(bytes[OFF_MAGIC + i]);
  if (magic !== MAGIC) {
    throw new BadMagicError(`expected magic ${MAGIC}, got ${JSON.stringify(magic)}`);
  }

  const formatVersion = view.getUint32(OFF_FORMAT_VERSION, true);
  if (formatVersion !== FORMAT_VERSION) {
    throw new UnsupportedVersionError(
      `format_version ${formatVersion}, this build reads ${FORMAT_VERSION}`,
    );
  }
  const headerSize = view.getUint32(OFF_HEADER_SIZE, true);
  if (headerSize !== HEADER_SIZE) {
    throw new UnsupportedVersionError(`header_size ${headerSize}, expected ${HEADER_SIZE}`);
  }

  const fileSize = view.getUint32(OFF_FILE_SIZE, true);
  if (fileSize !== data.byteLength) {
    throw new TruncatedFileError(
      `header claims ${fileSize} bytes, buffer has ${data.byteLength}`,
    );
  }

  if (verifyChecksum) {
    const stored = view.getUint32(OFF_CRC32, true);
    const actual = crc32(bytes.subarray(HEADER_SIZE));
    if (actual !== stored) {
      throw new ChecksumError(
        `crc32 mismatch: header 0x${stored.toString(16)}, payload 0x${actual.toString(16)}`,
      );
    }
  }

  let regionId = '';
  for (let i = 0; i < 16; i++) {
    const ch = bytes[OFF_REGION_ID + i];
    if (ch === 0) break;
    regionId += String.fromCharCode(ch);
  }

  const bbox: readonly [number, number, number, number] = [
    view.getFloat64(OFF_BBOX, true),
    view.getFloat64(OFF_BBOX + 8, true),
    view.getFloat64(OFF_BBOX + 16, true),
    view.getFloat64(OFF_BBOX + 24, true),
  ];

  const nodeCount = view.getUint32(OFF_NODE_COUNT, true);
  const dirEdgeCount = view.getUint32(OFF_DIR_EDGE_COUNT, true);
  const geomEdgeCount = view.getUint32(OFF_GEOM_EDGE_COUNT, true);
  const gridNx = view.getUint32(OFF_GRID_NX, true);
  const gridNy = view.getUint32(OFF_GRID_NY, true);
  const flags = view.getUint32(OFF_FLAGS, true);
  const cellCount = gridNx * gridNy;

  const offsets: number[] = [];
  for (let i = 0; i < SECTION_COUNT; i++) {
    offsets.push(view.getUint32(OFF_SECTIONS + i * 4, true));
  }

  const specs: ReadonlyArray<readonly [Section, string, number, number]> = [
    [Section.NodeLat, 'node_lat', 4, nodeCount],
    [Section.NodeLon, 'node_lon', 4, nodeCount],
    [Section.NodeElev, 'node_elev', 4, nodeCount],
    [Section.CsrOffset, 'csr_offset', 4, nodeCount + 1],
    [Section.EdgeTarget, 'edge_target', 4, dirEdgeCount],
    [Section.EdgeId, 'edge_id', 4, dirEdgeCount],
    [Section.EdgeDist, 'edge_dist', 4, dirEdgeCount],
    [Section.EdgeAscent, 'edge_ascent', 4, dirEdgeCount],
    [Section.EdgeDescent, 'edge_descent', 4, dirEdgeCount],
    [Section.EdgeMaxSlope, 'edge_max_slope', 1, dirEdgeCount],
    [Section.GridOffset, 'grid_offset', 4, cellCount + 1],
    [Section.GridNodeId, 'grid_nodeid', 4, nodeCount],
  ];

  let prevEnd = HEADER_SIZE;
  for (const [index, name, itemSize, count] of specs) {
    const offset = offsets[index];
    const end = offset + count * itemSize;
    if (offset % SECTION_ALIGN !== 0) {
      throw new TruncatedFileError(
        `section ${name} at ${offset} is not ${SECTION_ALIGN}-byte aligned`,
      );
    }
    if (offset < prevEnd) {
      throw new TruncatedFileError(`section ${name} at ${offset} overlaps the previous section`);
    }
    if (end > data.byteLength) {
      throw new TruncatedFileError(
        `section ${name} ends at ${end}, past the ${data.byteLength}-byte buffer`,
      );
    }
    prevEnd = alignUp(end);
  }

  const graph: Graph = {
    regionId,
    formatVersion,
    bbox,
    gridNx,
    gridNy,
    flags,
    nodeCount,
    dirEdgeCount,
    geomEdgeCount,
    cellCount,
    nodeLat: new Float32Array(data, offsets[Section.NodeLat], nodeCount),
    nodeLon: new Float32Array(data, offsets[Section.NodeLon], nodeCount),
    nodeElev: new Float32Array(data, offsets[Section.NodeElev], nodeCount),
    csrOffset: new Uint32Array(data, offsets[Section.CsrOffset], nodeCount + 1),
    edgeTarget: new Uint32Array(data, offsets[Section.EdgeTarget], dirEdgeCount),
    edgeId: new Uint32Array(data, offsets[Section.EdgeId], dirEdgeCount),
    edgeDist: new Float32Array(data, offsets[Section.EdgeDist], dirEdgeCount),
    edgeAscent: new Float32Array(data, offsets[Section.EdgeAscent], dirEdgeCount),
    edgeDescent: new Float32Array(data, offsets[Section.EdgeDescent], dirEdgeCount),
    edgeMaxSlope: new Uint8Array(data, offsets[Section.EdgeMaxSlope], dirEdgeCount),
    gridOffset: new Uint32Array(data, offsets[Section.GridOffset], cellCount + 1),
    gridNodeId: new Uint32Array(data, offsets[Section.GridNodeId], nodeCount),
  };

  let maxEdgeId = 0;
  for (let i = 0; i < dirEdgeCount; i++) {
    if (graph.edgeId[i] >= maxEdgeId) maxEdgeId = graph.edgeId[i] + 1;
  }
  if (maxEdgeId !== geomEdgeCount) {
    throw new GraphValidationError(
      `header geom_edge_count ${geomEdgeCount} but max(edge_id)+1 is ${maxEdgeId}`,
    );
  }

  if (validate) validateGraph(graph, { checkEdgeLengths });
  return graph;
}

// --------------------------------------------------------------------------- //
// Validation -- mirrors validate_graph() in binformat.py
// --------------------------------------------------------------------------- //

export interface ValidateOptions {
  readonly checkEdgeLengths?: boolean;
  readonly elevRange?: readonly [number, number];
}

export function validateGraph(graph: Graph, options: ValidateOptions = {}): void {
  const { checkEdgeLengths = false, elevRange = [-500, 9000] } = options;
  const fail = (msg: string): never => {
    throw new GraphValidationError(msg);
  };

  const n = graph.nodeCount;
  const e = graph.dirEdgeCount;
  if (n < 1) fail('node_count must be >= 1');

  for (const [name, arr] of [
    ['node_lat', graph.nodeLat],
    ['node_lon', graph.nodeLon],
    ['node_elev', graph.nodeElev],
  ] as const) {
    if (arr.length !== n) fail(`${name} has length ${arr.length}, expected ${n}`);
    for (let i = 0; i < n; i++) {
      if (!Number.isFinite(arr[i])) fail(`${name} contains NaN or infinity`);
    }
  }

  for (let i = 0; i < n; i++) {
    if (graph.nodeElev[i] < elevRange[0] || graph.nodeElev[i] > elevRange[1]) {
      fail(`node_elev out of plausible range [${elevRange[0]}, ${elevRange[1]}]`);
    }
  }

  const [minLon, minLat, maxLon, maxLat] = graph.bbox;
  if (!(minLon < maxLon && minLat < maxLat)) fail(`bbox is empty or inverted: ${graph.bbox}`);
  // f32 coordinates are rounded from f64, so a node may sit a fraction of an ulp
  // outside a bbox computed in f64.
  const tol = 1e-5;
  for (let i = 0; i < n; i++) {
    if (
      graph.nodeLon[i] < minLon - tol ||
      graph.nodeLon[i] > maxLon + tol ||
      graph.nodeLat[i] < minLat - tol ||
      graph.nodeLat[i] > maxLat + tol
    ) {
      fail('bbox does not contain all nodes');
    }
  }

  if (graph.csrOffset.length !== n + 1) {
    fail(`csr_offset has length ${graph.csrOffset.length}, expected ${n + 1}`);
  }
  if (graph.csrOffset[0] !== 0) fail('csr_offset[0] must be 0');
  if (graph.csrOffset[n] !== e) {
    fail(`csr_offset[N] is ${graph.csrOffset[n]}, expected dir_edge_count ${e}`);
  }
  for (let i = 0; i < n; i++) {
    if (graph.csrOffset[i + 1] < graph.csrOffset[i]) {
      fail('csr_offset is not monotonically non-decreasing');
    }
  }

  for (const [name, arr] of [
    ['edge_target', graph.edgeTarget],
    ['edge_id', graph.edgeId],
    ['edge_dist', graph.edgeDist],
    ['edge_ascent', graph.edgeAscent],
    ['edge_descent', graph.edgeDescent],
    ['edge_max_slope', graph.edgeMaxSlope],
  ] as const) {
    if (arr.length !== e) fail(`${name} has length ${arr.length}, expected ${e}`);
  }

  for (let i = 0; i < e; i++) {
    if (graph.edgeTarget[i] >= n) fail(`edge_target references node ${graph.edgeTarget[i]} of ${n}`);
    if (!Number.isFinite(graph.edgeDist[i])) fail('edge_dist contains NaN or infinity');
    if (!Number.isFinite(graph.edgeAscent[i])) fail('edge_ascent contains NaN or infinity');
    if (!Number.isFinite(graph.edgeDescent[i])) fail('edge_descent contains NaN or infinity');
    if (graph.edgeAscent[i] < 0) fail('edge_ascent contains a negative value');
    if (graph.edgeDescent[i] < 0) fail('edge_descent contains a negative value');
    if (graph.edgeDist[i] <= 0) fail('edge_dist contains a zero-length edge');
  }

  const cells = graph.cellCount;
  if (graph.gridNx < 1 || graph.gridNy < 1) {
    fail(`grid dimensions must be >= 1, got ${graph.gridNx}x${graph.gridNy}`);
  }
  if (graph.gridOffset.length !== cells + 1) {
    fail(`grid_offset has length ${graph.gridOffset.length}, expected ${cells + 1}`);
  }
  if (graph.gridOffset[0] !== 0) fail('grid_offset[0] must be 0');
  if (graph.gridOffset[cells] !== n) {
    fail(`grid_offset[CELLS] is ${graph.gridOffset[cells]}, expected node_count ${n}`);
  }
  for (let i = 0; i < cells; i++) {
    if (graph.gridOffset[i + 1] < graph.gridOffset[i]) {
      fail('grid_offset is not monotonically non-decreasing');
    }
  }
  if (graph.gridNodeId.length !== n) {
    fail(`grid_nodeid has length ${graph.gridNodeId.length}, expected ${n}`);
  }

  const seen = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const id = graph.gridNodeId[i];
    if (id >= n) fail('grid_nodeid references a node out of range');
    seen[id] = 1;
  }
  for (let i = 0; i < n; i++) {
    if (seen[i] === 0) {
      fail('grid_nodeid is not a permutation of 0..N-1 (a node is unreachable by snapping)');
    }
  }

  // Every node must sit in the cell the index claims -- the check that catches a
  // bbox/grid mismatch, which would otherwise break snapping only near borders.
  for (let cell = 0; cell < cells; cell++) {
    for (let slot = graph.gridOffset[cell]; slot < graph.gridOffset[cell + 1]; slot++) {
      const node = graph.gridNodeId[slot];
      if (cellOfPoint(graph, graph.nodeLat[node], graph.nodeLon[node]) !== cell) {
        fail('grid_nodeid places a node in the wrong cell');
      }
    }
  }

  if (checkEdgeLengths) {
    for (let u = 0; u < n; u++) {
      for (let i = graph.csrOffset[u]; i < graph.csrOffset[u + 1]; i++) {
        const v = graph.edgeTarget[i];
        const chord = haversineM(graph.nodeLat[u], graph.nodeLon[u], graph.nodeLat[v], graph.nodeLon[v]);
        if (graph.edgeDist[i] < chord * (1 - 1e-6)) {
          fail(
            `edge_dist[${i}] = ${graph.edgeDist[i]} is shorter than the great-circle ` +
              `distance ${chord} between its stored endpoints; A* would lose admissibility`,
          );
        }
      }
    }
  }
}

/** Just the fields {@link cellOfPoint} needs, so a graph can be binned while it is
 * still being built. `Graph` satisfies this structurally. */
export interface GridSpec {
  readonly bbox: readonly [number, number, number, number];
  readonly gridNx: number;
  readonly gridNy: number;
}

/**
 * Grid cell index of a point, clamped to the grid. Mirrors cell_of_point_array.
 *
 * Clamping **both** bounds is load-bearing. f32 rounding can put a node a
 * fraction of an ulp outside the bbox it was derived from, giving `ix = -1`; a
 * typed array discards a write at index -1 without error, so the node would
 * simply disappear from the index and become unsnappable.
 */
export function cellOfPoint(grid: GridSpec, lat: number, lon: number): number {
  const [minLon, minLat, maxLon, maxLat] = grid.bbox;
  const lonSpan = Math.max(maxLon - minLon, 1e-12);
  const latSpan = Math.max(maxLat - minLat, 1e-12);
  let ix = Math.floor(((lon - minLon) / lonSpan) * grid.gridNx);
  let iy = Math.floor(((lat - minLat) / latSpan) * grid.gridNy);
  ix = Math.min(grid.gridNx - 1, Math.max(0, ix));
  iy = Math.min(grid.gridNy - 1, Math.max(0, iy));
  return iy * grid.gridNx + ix;
}
