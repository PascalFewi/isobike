/**
 * The TypeScript reader against the Python-written graph.
 *
 * This is one half of the cross-language contract: `graph.bin` was produced by
 * `build/binformat.py` and never touched by TypeScript, so every value asserted
 * here is a value the two implementations had to agree on independently.
 */

import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import {
  BadMagicError,
  ChecksumError,
  GraphValidationError,
  HEADER_SIZE,
  SLOPE_STEP_PCT,
  TruncatedFileError,
  UnsupportedVersionError,
  cellOfPoint,
  crc32,
  decodeMaxSlope,
  encodeMaxSlope,
  readGraph,
  slopeExceeds,
  validateGraph,
} from '../src/binformat.js';
import { loadExpected, loadGraphBytes, loadRidgeWorld } from './fixtures.js';

const expected = loadExpected();

function corrupt(source: ArrayBuffer, offset: number, bytes: number[]): ArrayBuffer {
  const copy = source.slice(0);
  new Uint8Array(copy).set(bytes, offset);
  return copy;
}

function writeU32(source: ArrayBuffer, offset: number, value: number): ArrayBuffer {
  const copy = source.slice(0);
  new DataView(copy).setUint32(offset, value, true);
  return copy;
}

describe('reading the Python-generated graph', () => {
  it('is the exact file expected.json was generated from', () => {
    const raw = Buffer.from(loadGraphBytes());
    expect(createHash('sha256').update(raw).digest('hex')).toBe(expected.graph.sha256);
    expect(raw.byteLength).toBe(expected.graph.byte_length);
  });

  it('parses the header as Python wrote it', () => {
    const graph = loadRidgeWorld();
    expect(graph.regionId).toBe(expected.region_id);
    expect(graph.formatVersion).toBe(expected.graph.format_version);
    expect(graph.nodeCount).toBe(expected.graph.node_count);
    expect(graph.dirEdgeCount).toBe(expected.graph.dir_edge_count);
    expect(graph.geomEdgeCount).toBe(expected.graph.geom_edge_count);
    expect(graph.gridNx).toBe(expected.graph.grid_nx);
    expect(graph.gridNy).toBe(expected.graph.grid_ny);
    // bbox is f64 in the format, so this is exact equality, not a tolerance.
    expect([...graph.bbox]).toEqual(expected.graph.bbox);
  });

  it('exposes sections as zero-copy views onto the source buffer', () => {
    const data = loadGraphBytes();
    const graph = readGraph(data);
    expect(graph.nodeLat.buffer).toBe(data);
    expect(graph.edgeDist.buffer).toBe(data);
    expect(graph.gridNodeId.buffer).toBe(data);
  });

  it('lands every section on an alignment a typed array can view', () => {
    const graph = loadRidgeWorld();
    for (const arr of [
      graph.nodeLat, graph.nodeLon, graph.nodeElev, graph.csrOffset,
      graph.edgeTarget, graph.edgeId, graph.edgeDist, graph.edgeAscent,
      graph.edgeDescent, graph.gridOffset, graph.gridNodeId,
    ]) {
      expect(arr.byteOffset % 4).toBe(0);
    }
  });

  it('passes the same validation Python applies, including edge lengths', () => {
    expect(() => validateGraph(loadRidgeWorld(), { checkEdgeLengths: true })).not.toThrow();
  });
});

describe('CSR structure', () => {
  const graph = loadRidgeWorld();

  it('terminates at the directed edge count', () => {
    expect(graph.csrOffset[0]).toBe(0);
    expect(graph.csrOffset[graph.nodeCount]).toBe(graph.dirEdgeCount);
  });

  it('gives every geometric edge exactly two halves that mirror each other', () => {
    const halves = new Map<number, Array<{ u: number; v: number; asc: number; desc: number }>>();
    for (let u = 0; u < graph.nodeCount; u++) {
      for (let e = graph.csrOffset[u]; e < graph.csrOffset[u + 1]; e++) {
        const id = graph.edgeId[e];
        const list = halves.get(id) ?? [];
        list.push({
          u,
          v: graph.edgeTarget[e],
          asc: graph.edgeAscent[e],
          desc: graph.edgeDescent[e],
        });
        halves.set(id, list);
      }
    }
    expect(halves.size).toBe(graph.geomEdgeCount);
    for (const [id, list] of halves) {
      expect(list.length, `edge ${id}`).toBe(2);
      const [a, b] = list;
      expect(a.u).toBe(b.v);
      expect(a.v).toBe(b.u);
      // Directed cost over undirected topology.
      expect(a.asc).toBe(b.desc);
      expect(a.desc).toBe(b.asc);
    }
  });

  it('reproduces the bump edge: zero endpoint delta-h, real ascent', () => {
    const { bump_a: a, bump_b: b } = expected.fixtures;
    expect(graph.nodeElev[a]).toBe(graph.nodeElev[b]);

    let seen = false;
    for (let e = graph.csrOffset[a]; e < graph.csrOffset[a + 1]; e++) {
      if (graph.edgeTarget[e] === b) {
        seen = true;
        expect(graph.edgeAscent[e]).toBeGreaterThan(expected.constants.bump_height_m - 0.5);
        expect(graph.edgeDescent[e]).toBeGreaterThan(expected.constants.bump_height_m - 0.5);
      }
    }
    expect(seen).toBe(true);
  });

  it('keeps the grid index a permutation covering every node', () => {
    const seen = new Set<number>();
    for (let i = 0; i < graph.nodeCount; i++) seen.add(graph.gridNodeId[i]);
    expect(seen.size).toBe(graph.nodeCount);
    expect(graph.gridOffset[graph.cellCount]).toBe(graph.nodeCount);
  });

  it('files every node in the cell the index claims', () => {
    for (let cell = 0; cell < graph.cellCount; cell++) {
      for (let s = graph.gridOffset[cell]; s < graph.gridOffset[cell + 1]; s++) {
        const node = graph.gridNodeId[s];
        expect(cellOfPoint(graph, graph.nodeLat[node], graph.nodeLon[node])).toBe(cell);
      }
    }
  });
});

describe('slope quantisation matches binformat.py', () => {
  it.each([
    [0.0, 0], [0.1, 0], [0.2, 1], [0.25, 1], [0.3, 1],
    [5.0, 20], [12.5, 50], [63.75, 255], [100.0, 255], [-3.0, 0], [NaN, 0],
  ])('encodes %f as %i', (pct, want) => {
    expect(encodeMaxSlope(pct)).toBe(want);
  });

  it('decodes exactly in f64, so no rounding can differ from Python', () => {
    expect(SLOPE_STEP_PCT).toBe(0.25);
    for (let v = 0; v < 256; v++) expect(decodeMaxSlope(v) * 4).toBe(v);
  });

  it.each([
    [40, 10.0, false], [41, 10.0, true], [0, 0.0, false],
    [1, 0.0, true], [255, 63.75, false], [255, 63.74, true],
  ])('slopeExceeds(%i, %f) === %s', (u8, limit, want) => {
    expect(slopeExceeds(u8, limit)).toBe(want);
  });
});

describe('crc32 agrees with zlib', () => {
  it('matches known vectors', () => {
    expect(crc32(new TextEncoder().encode(''))).toBe(0);
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
    expect(crc32(new TextEncoder().encode('The quick brown fox jumps over the lazy dog')))
      .toBe(0x414fa339);
  });

  it('matches the checksum Python stored in the graph', () => {
    const data = loadGraphBytes();
    const stored = new DataView(data).getUint32(140, true);
    expect(crc32(new Uint8Array(data).subarray(HEADER_SIZE))).toBe(stored);
  });
});

describe('corrupt input fails with the same error kinds as Python', () => {
  const good = loadGraphBytes();

  it('rejects bad magic', () => {
    const bad = corrupt(good, 0, [...new TextEncoder().encode('NOTAGRPH')]);
    expect(() => readGraph(bad)).toThrow(BadMagicError);
  });

  it('rejects an unknown format version', () => {
    expect(() => readGraph(writeU32(good, 8, 2))).toThrow(UnsupportedVersionError);
  });

  it('rejects an unknown header size', () => {
    expect(() => readGraph(writeU32(good, 12, 192))).toThrow(UnsupportedVersionError);
  });

  it('rejects a buffer shorter than the header', () => {
    expect(() => readGraph(good.slice(0, 100))).toThrow(TruncatedFileError);
  });

  it('rejects a truncated body via file_size', () => {
    expect(() => readGraph(good.slice(0, good.byteLength - 8))).toThrow(TruncatedFileError);
  });

  it('rejects a misaligned section offset', () => {
    const first = new DataView(good).getUint32(88, true);
    const bad = writeU32(good, 88, first + 2);
    expect(() => readGraph(bad, { verifyChecksum: false })).toThrow(/aligned/);
  });

  it('rejects a section running past the buffer', () => {
    const bad = writeU32(good, 88 + 4 * 11, good.byteLength - 8);
    expect(() => readGraph(bad, { verifyChecksum: false })).toThrow(/past/);
  });

  it('catches a single flipped payload byte', () => {
    const bad = good.slice(0);
    new Uint8Array(bad)[HEADER_SIZE + 3] ^= 0x01;
    expect(() => readGraph(bad)).toThrow(ChecksumError);
  });

  it('can skip the checksum, as the Worker may choose to', () => {
    const bad = good.slice(0);
    new Uint8Array(bad)[HEADER_SIZE + 3] ^= 0x01;
    expect(() => readGraph(bad, { verifyChecksum: false, validate: false })).not.toThrow();
  });

  it('rejects a geom_edge_count that disagrees with the edge ids', () => {
    expect(() => readGraph(writeU32(good, 72, 9999))).toThrow(GraphValidationError);
  });
});
