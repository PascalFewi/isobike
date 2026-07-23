/**
 * An in-memory graph at roughly nationwide scale, for performance measurement.
 *
 * Built directly as typed arrays rather than round-tripped through a `.bin`:
 * committing a 50 MB fixture to prove a timing property would be a poor trade,
 * and the format is already verified byte-for-byte by the Ridge World golden
 * files. What this fixture exists to exercise is the *router*, at a size where
 * cache behaviour and allocation actually show up.
 */

import { cellOfPoint, encodeMaxSlope, type Graph, type GridSpec } from '../src/binformat.js';
import { haversineM } from '../src/geo.js';

export interface SyntheticGraph {
  readonly graph: Graph;
  /** Total bytes held by the twelve sections -- the Worker's resident cost. */
  readonly byteLength: number;
}

/**
 * A `k` x `k` lattice with 4-neighbour connectivity over rolling terrain.
 *
 * k = 707 gives ~500 k nodes and ~2.0 M directed half-edges, which is within a
 * factor of ~1.3 of the post-collapse Swiss estimate.
 */
export function buildLattice(k: number): SyntheticGraph {
  const nodeCount = k * k;
  const horizontal = k * (k - 1);
  const geomEdgeCount = 2 * horizontal;
  const dirEdgeCount = 2 * geomEdgeCount;

  const minLon = 5.9;
  const minLat = 45.8;
  const maxLon = 10.5;
  const maxLat = 47.8;

  const nodeLat = new Float32Array(nodeCount);
  const nodeLon = new Float32Array(nodeCount);
  const nodeElev = new Float32Array(nodeCount);

  for (let j = 0; j < k; j++) {
    for (let i = 0; i < k; i++) {
      const id = j * k + i;
      nodeLon[id] = minLon + ((maxLon - minLon) * i) / (k - 1);
      nodeLat[id] = minLat + ((maxLat - minLat) * j) / (k - 1);
      // Rolling terrain: enough relief that the climb term matters and enough
      // variation that costs do not collapse into ties.
      nodeElev[id] =
        500 +
        400 * Math.sin((i / k) * 6.1) * Math.cos((j / k) * 4.7) +
        120 * Math.sin((i + j) / 37);
    }
  }

  const csrOffset = new Uint32Array(nodeCount + 1);
  const edgeTarget = new Uint32Array(dirEdgeCount);
  const edgeId = new Uint32Array(dirEdgeCount);
  const edgeDist = new Float32Array(dirEdgeCount);
  const edgeAscent = new Float32Array(dirEdgeCount);
  const edgeDescent = new Float32Array(dirEdgeCount);
  const edgeMaxSlope = new Uint8Array(dirEdgeCount);

  // Neighbours in ascending target order: id-k, id-1, id+1, id+k.
  let cursor = 0;
  for (let j = 0; j < k; j++) {
    for (let i = 0; i < k; i++) {
      const u = j * k + i;
      csrOffset[u] = cursor;

      const emit = (v: number, id: number): void => {
        const dist = haversineM(nodeLat[u], nodeLon[u], nodeLat[v], nodeLon[v]) * 1.05;
        const dh = nodeElev[v] - nodeElev[u];
        // A little more ascent than the net gain, as a real sampled profile has.
        const ascent = Math.max(0, dh) + 0.8;
        const descent = ascent - dh;
        edgeTarget[cursor] = v;
        edgeId[cursor] = id;
        edgeDist[cursor] = dist;
        edgeAscent[cursor] = ascent;
        edgeDescent[cursor] = descent;
        edgeMaxSlope[cursor] = encodeMaxSlope((ascent / dist) * 100);
        cursor++;
      };

      if (j > 0) emit(u - k, horizontal + (j - 1) * k + i);
      if (i > 0) emit(u - 1, j * (k - 1) + (i - 1));
      if (i < k - 1) emit(u + 1, j * (k - 1) + i);
      if (j < k - 1) emit(u + k, horizontal + j * k + i);
    }
  }
  csrOffset[nodeCount] = cursor;

  // Grid index, sized as the real builder would size it (~4 nodes per cell).
  const gridNx = Math.max(1, Math.round(Math.sqrt(nodeCount / 4)));
  const gridNy = gridNx;
  const cellCount = gridNx * gridNy;
  const counts = new Uint32Array(cellCount);
  const cellOf = new Uint32Array(nodeCount);

  // Uses the shared cellOfPoint rather than an inlined copy. A hand-rolled
  // version here clamped only the upper bound, and f32(5.9) rounds just below
  // minLon -- so the whole left column produced ix = -1. Typed arrays discard
  // out-of-range writes silently, so 707 nodes vanished with no error at all.
  const grid: GridSpec = { bbox: [minLon, minLat, maxLon, maxLat], gridNx, gridNy };
  for (let n = 0; n < nodeCount; n++) {
    const cell = cellOfPoint(grid, nodeLat[n], nodeLon[n]);
    cellOf[n] = cell;
    counts[cell]++;
  }

  const gridOffset = new Uint32Array(cellCount + 1);
  for (let c = 0; c < cellCount; c++) gridOffset[c + 1] = gridOffset[c] + counts[c];
  const fill = gridOffset.slice(0, cellCount);
  const gridNodeId = new Uint32Array(nodeCount);
  for (let n = 0; n < nodeCount; n++) gridNodeId[fill[cellOf[n]]++] = n;

  const graph: Graph = {
    regionId: 'synthetic',
    formatVersion: 1,
    bbox: [minLon, minLat, maxLon, maxLat],
    gridNx,
    gridNy,
    flags: 0,
    nodeCount,
    dirEdgeCount,
    geomEdgeCount,
    cellCount,
    nodeLat, nodeLon, nodeElev,
    csrOffset,
    edgeTarget, edgeId, edgeDist, edgeAscent, edgeDescent, edgeMaxSlope,
    gridOffset, gridNodeId,
  };

  const byteLength =
    nodeLat.byteLength + nodeLon.byteLength + nodeElev.byteLength +
    csrOffset.byteLength + edgeTarget.byteLength + edgeId.byteLength +
    edgeDist.byteLength + edgeAscent.byteLength + edgeDescent.byteLength +
    edgeMaxSlope.byteLength + gridOffset.byteLength + gridNodeId.byteLength;

  return { graph, byteLength };
}
