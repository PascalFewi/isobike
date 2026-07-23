/**
 * Routing over a CSR graph, in flat typed arrays.
 *
 * Mirrors `testdata/gen/reference_router.py` exactly enough that both produce
 * bit-identical costs; the golden files in `testdata/ridge_world/` are what prove
 * it. Where the two differ, this one is fast and that one is obvious -- so when
 * they disagree, that one is right until shown otherwise.
 *
 * Deliberately free of any Worker/Cloudflare dependency: everything here takes a
 * parsed `Graph` and returns plain data, so it is driven directly by vitest. The
 * HTTP layer, R2 loading, the `metric` dispatch and the profile -> CostModel
 * mapping belong in `index.ts`.
 *
 * Cost model (spec v1.1)
 * ======================
 * The weight of a directed edge is time in seconds, `w = a*dist + b*ascent` with
 * `a = 1/v_flat`, `b = 1/vam` (see {@link CostModel}). The route minimising time
 * is identical to the old `dist + cf*ascent` model's, because time is that
 * expression scaled by the positive constant `1/v_flat`. Steepness is a filter
 * only, never a cost term. Dijkstra additionally carries, per node and along the
 * cost-optimal path, cumulative ascent and max slope -- the second colour
 * channel's raw material, at no extra asymptotic cost.
 *
 * Hot-path rules
 * ==============
 * - No per-node objects. Node state lives in `Float64Array` / `Int32Array` /
 *   `Uint8Array`, indexed by node id.
 * - No `Map` in the search. The effort field builds dense arrays over geometric
 *   edges, which is a fraction of the node count.
 * - The scan reads `csrOffset`, `edgeTarget`, `edgeDist`, `edgeAscent` and
 *   `edgeMaxSlope` -- five contiguous arrays, which is why the format is
 *   struct-of-arrays.
 *
 * Allocation note: each call allocates its own state arrays. That is correct and
 * simple. If per-request GC pressure shows up in step 2's measurements, the fix
 * is a reusable scratch pool keyed by node count -- not a change to any logic here.
 */

import { decodeMaxSlope, slopeExceeds, type Graph } from './binformat.js';
import { M_PER_DEG_LAT, haversineM, latToM, lonScaleM } from './geo.js';
import { BinaryHeap } from './heap.js';

/**
 * Shrinks the A* heuristic just enough that floating-point noise cannot make it
 * overestimate. Must equal `H_SAFETY` in reference_router.py.
 *
 * Scaling a consistent heuristic by c <= 1 preserves consistency:
 * if h(u) <= w(u,v) + h(v) then c*h(u) <= c*w + c*h(v) <= w + c*h(v).
 */
export const H_SAFETY = 1.0 - 2 ** -16;

/** Sentinel in `incoming`: no predecessor edge. */
const NO_EDGE = -1;

/**
 * Linear sum-family edge weight `w = a*dist + b*ascent`.
 *
 * For the time metric `a = 1/v_flat` (s/m) and `b = 1/vam` (s/m), so `w` is
 * seconds. Held as reciprocals, not speeds, because those are what the weight and
 * heuristic multiply -- and computing them once keeps Python and V8 bit-identical.
 */
export interface CostModel {
  /** seconds per metre of distance = 1 / v_flat */
  readonly a: number;
  /** seconds per metre of ascent = 1 / vam */
  readonly b: number;
}

/** Time model from a profile's flat speed (m/s) and vertical speed (Hm/s = m/s). */
export function timeModel(vFlatMps: number, vamMps: number): CostModel {
  if (vFlatMps <= 0 || vamMps <= 0) throw new Error('v_flat and vam must be positive');
  return { a: 1 / vFlatMps, b: 1 / vamMps };
}

/** Internal fallback: `w = dist + climbFactor*ascent` (metres, not seconds). */
export function distanceEquivModel(climbFactor: number): CostModel {
  return { a: 1, b: climbFactor };
}

export interface SearchOptions {
  /** Skip edges whose uphill grade exceeds this, in percent. */
  readonly maxSlopePct?: number | undefined;
  /** Stop expanding beyond this cost. Seconds under the time model. */
  readonly maxCost?: number | undefined;
}

export interface DijkstraResult {
  /** Cost per node; `Infinity` where unreached. Seconds under the time model. */
  readonly cost: Float64Array;
  /** Cumulative ascent along the cost-optimal path to each node, in metres. */
  readonly cumAscent: Float64Array;
  /** Max slope (stored u8) along the cost-optimal path to each node. */
  readonly maxSlope: Uint8Array;
  /** Directed half-edge used to reach each node, or -1. */
  readonly incoming: Int32Array;
}

export interface RouteResult {
  readonly nodes: number[];
  /** Geometric edge ids, in travel order -- what `/route` returns. */
  readonly edgeIds: number[];
  /** Optimisation cost of the path -- seconds under the time model. */
  readonly cost: number;
  readonly distM: number;
  readonly ascentM: number;
  readonly descentM: number;
  readonly maxSlopePct: number;
}

/** `w = a*dist + b*ascent` in f64 -- seconds under the time model. */
export function edgeWeight(graph: Graph, edge: number, model: CostModel): number {
  return model.a * graph.edgeDist[edge] + model.b * graph.edgeAscent[edge];
}

function blocked(graph: Graph, edge: number, maxSlopePct: number | undefined): boolean {
  return maxSlopePct !== undefined && slopeExceeds(graph.edgeMaxSlope[edge], maxSlopePct);
}

// --------------------------------------------------------------------------- //
// Dijkstra
// --------------------------------------------------------------------------- //

export function dijkstra(
  graph: Graph,
  source: number,
  model: CostModel,
  options: SearchOptions = {},
): DijkstraResult {
  const { maxSlopePct, maxCost = Infinity } = options;
  const n = graph.nodeCount;

  const cost = new Float64Array(n).fill(Infinity);
  const cumAscent = new Float64Array(n);
  const maxSlope = new Uint8Array(n);
  const incoming = new Int32Array(n).fill(NO_EDGE);
  const settled = new Uint8Array(n);

  cost[source] = 0;
  const heap = new BinaryHeap(Math.min(n, 1 << 16));
  heap.push(0, source);

  while (heap.pop()) {
    const u = heap.topId;
    if (settled[u] === 1) continue;
    // The heap is ordered, so nothing cheaper remains anywhere.
    if (heap.topKey > maxCost) break;
    settled[u] = 1;

    const c = heap.topKey;
    const cuAscent = cumAscent[u];
    const cuSlope = maxSlope[u];
    const end = graph.csrOffset[u + 1];
    for (let e = graph.csrOffset[u]; e < end; e++) {
      if (blocked(graph, e, maxSlopePct)) continue;
      const v = graph.edgeTarget[e];
      if (settled[v] === 1) continue;
      const nc = c + edgeWeight(graph, e, model);
      // Strict `<`: the first predecessor to achieve a cost keeps it, matching
      // the reference router's tie resolution.
      if (nc < cost[v]) {
        cost[v] = nc;
        // Accumulate the secondary quantities along this same optimal edge.
        cumAscent[v] = cuAscent + graph.edgeAscent[e];
        const s = graph.edgeMaxSlope[e];
        maxSlope[v] = cuSlope >= s ? cuSlope : s;
        incoming[v] = e;
        heap.push(nc, v);
      }
    }
  }

  return { cost, cumAscent, maxSlope, incoming };
}

// --------------------------------------------------------------------------- //
// A*
// --------------------------------------------------------------------------- //

/**
 * Admissible lower bound on the time from `node` to `goal`.
 *
 * `sum(dist) >= great-circle` because a polyline obeys the triangle inequality on
 * a sphere (enforced on the stored data by `validateGraph`'s edge-length check),
 * and `sum(ascent) >= max(0, net gain)` because descent is never negative. Scaled
 * into seconds by the model; the sum of two independent lower bounds is a lower
 * bound. Still admissible under a slope filter: removing edges can only raise the
 * true remaining cost, and h does not change.
 */
export function heuristic(graph: Graph, node: number, goal: number, model: CostModel): number {
  const line = haversineM(
    graph.nodeLat[node],
    graph.nodeLon[node],
    graph.nodeLat[goal],
    graph.nodeLon[goal],
  );
  const climb = Math.max(0, graph.nodeElev[goal] - graph.nodeElev[node]);
  return H_SAFETY * (model.a * line + model.b * climb);
}

export function astar(
  graph: Graph,
  source: number,
  goal: number,
  model: CostModel,
  options: SearchOptions = {},
): RouteResult | null {
  const { maxSlopePct } = options;
  const n = graph.nodeCount;

  const gCost = new Float64Array(n).fill(Infinity);
  const incoming = new Int32Array(n).fill(NO_EDGE);
  const settled = new Uint8Array(n);

  // h is a pure function of the node, but relaxation reaches a node once per
  // incoming edge -- four times over on a lattice. Memoising turns the only
  // transcendental call in the search into at most one per node. NaN is the
  // "not yet computed" marker because every real value here is finite.
  const hCache = new Float64Array(n).fill(NaN);
  const h = (node: number): number => {
    const cached = hCache[node];
    if (cached === cached) return cached; // NaN is the only value !== itself
    const value = heuristic(graph, node, goal, model);
    hCache[node] = value;
    return value;
  };

  gCost[source] = 0;
  const heap = new BinaryHeap(Math.min(n, 1 << 16));
  heap.push(h(source), source);

  while (heap.pop()) {
    const u = heap.topId;
    if (settled[u] === 1) continue;
    settled[u] = 1;
    if (u === goal) break;

    const cu = gCost[u];
    const end = graph.csrOffset[u + 1];
    for (let e = graph.csrOffset[u]; e < end; e++) {
      if (blocked(graph, e, maxSlopePct)) continue;
      const v = graph.edgeTarget[e];
      if (settled[v] === 1) continue;
      const nc = cu + edgeWeight(graph, e, model);
      if (nc < gCost[v]) {
        gCost[v] = nc;
        incoming[v] = e;
        heap.push(nc + h(v), v);
      }
    }
  }

  if (settled[goal] === 0) return null;
  return buildRoute(graph, source, goal, gCost, incoming);
}

// --------------------------------------------------------------------------- //
// Reconstruction
// --------------------------------------------------------------------------- //

/**
 * Walk the predecessor half-edges back from `goal` and total the attributes.
 *
 * Totals are summed from the stored per-edge values. `ascent` is emphatically not
 * recomputed from node elevations: an out-and-back over a hump would then report
 * zero, which is exactly the failure the Ridge World bump edge exists to catch.
 */
export function buildRoute(
  graph: Graph,
  source: number,
  goal: number,
  cost: Float64Array,
  incoming: Int32Array,
): RouteResult | null {
  if (!Number.isFinite(cost[goal])) return null;

  const edges: number[] = [];
  let node = goal;
  while (node !== source) {
    const e = incoming[node];
    if (e === NO_EDGE) return null;
    edges.push(e);
    node = sourceOf(graph, e);
  }
  edges.reverse();

  const nodes: number[] = [source];
  const edgeIds: number[] = [];
  let distM = 0;
  let ascentM = 0;
  let descentM = 0;
  let maxSlopeU8 = 0;

  for (const e of edges) {
    nodes.push(graph.edgeTarget[e]);
    edgeIds.push(graph.edgeId[e]);
    distM += graph.edgeDist[e];
    ascentM += graph.edgeAscent[e];
    descentM += graph.edgeDescent[e];
    if (graph.edgeMaxSlope[e] > maxSlopeU8) maxSlopeU8 = graph.edgeMaxSlope[e];
  }

  return {
    nodes,
    edgeIds,
    cost: cost[goal],
    distM,
    ascentM,
    descentM,
    maxSlopePct: decodeMaxSlope(maxSlopeU8),
  };
}

/** Which node's CSR block holds this half-edge. Binary search over csrOffset. */
export function sourceOf(graph: Graph, edge: number): number {
  let lo = 0;
  let hi = graph.nodeCount;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (graph.csrOffset[mid + 1] <= edge) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Ground-truth route via full Dijkstra -- no heuristic in the trusted path. */
export function route(
  graph: Graph,
  source: number,
  goal: number,
  model: CostModel,
  options: SearchOptions = {},
): RouteResult | null {
  const { cost, incoming } = dijkstra(graph, source, model, options);
  if (!Number.isFinite(cost[goal])) return null;
  return buildRoute(graph, source, goal, cost, incoming);
}

// --------------------------------------------------------------------------- //
// Effort field
// --------------------------------------------------------------------------- //

export interface EffortField {
  /** Reach time per `edgeId`; `Infinity` where unreachable or filtered. Seconds. */
  readonly time: Float64Array;
  /** Cumulative ascent at the same (cheaper) endpoint, in metres; 0 where absent. */
  readonly cumAscent: Float64Array;
  /** How many edges are finite. */
  readonly count: number;
}

/**
 * `edgeId -> (time, cumAscent)`, over the whole reachable field.
 *
 * Per decision D2 an edge's reach `time` is `min(cost[u], cost[v])` -- the effort
 * to *reach* it, the isochrone convention. `cumAscent` is taken at the *same*
 * (cheaper) endpoint, so time and climb refer to one consistent journey. On a
 * cost tie the endpoint with the smaller cumAscent wins (lexicographic minimum on
 * `(time, cumAscent)`), which is deterministic and identical across languages
 * because both halves of a geometric edge evaluate the same two endpoints.
 *
 * A geometric edge is omitted when both halves are removed by the slope filter,
 * or when it is unreachable: colouring a road the rider is filtering out, or
 * cannot reach, would misreport reach.
 */
export function effortField(
  graph: Graph,
  source: number,
  model: CostModel,
  options: SearchOptions = {},
): EffortField {
  const { maxSlopePct, maxCost = Infinity } = options;
  const { cost, cumAscent } = dijkstra(graph, source, model, options);

  // Dense arrays rather than a Map. The field spans up to every geometric edge,
  // and a Map costs a hash per lookup and per insert across ~2 M half-edge
  // visits. Two Float64Arrays indexed by edgeId are one bounds check, and they
  // are already the shape the binary (edge_id, time, cum_ascent) response wants.
  const time = new Float64Array(graph.geomEdgeCount).fill(Infinity);
  const climb = new Float64Array(graph.geomEdgeCount);
  let count = 0;

  for (let u = 0; u < graph.nodeCount; u++) {
    const end = graph.csrOffset[u + 1];
    for (let e = graph.csrOffset[u]; e < end; e++) {
      if (blocked(graph, e, maxSlopePct)) continue;
      const v = graph.edgeTarget[e];
      let t: number;
      let asc: number;
      if (cost[u] <= cost[v]) {
        t = cost[u];
        asc = cumAscent[u];
      } else {
        t = cost[v];
        asc = cumAscent[v];
      }
      // `t > maxCost` alone does not exclude unreachable edges: with an infinite
      // budget, `Infinity > Infinity` is false and the whole disconnected
      // component would leak in at cost Infinity.
      if (!Number.isFinite(t) || t > maxCost) continue;
      const id = graph.edgeId[e];
      const existing = time[id];
      // Lexicographic minimum on (time, cumAscent).
      if (t < existing || (t === existing && asc < climb[id])) {
        if (existing === Infinity) count++;
        time[id] = t;
        climb[id] = asc;
      }
    }
  }
  return { time, cumAscent: climb, count };
}

// --------------------------------------------------------------------------- //
// Snapping
// --------------------------------------------------------------------------- //

/**
 * Nearest node to a coordinate, via the stored grid index.
 *
 * The ring search does **not** stop at the first non-empty ring. It keeps going
 * until the nearest possible point outside the searched block is farther than the
 * best candidate so far. Stopping early is the classic snapping bug: invisible in
 * dense terrain, wrong exactly at region borders and across the empty cells that
 * make up roughly half of any real grid.
 */
export function snap(graph: Graph, lat: number, lon: number): number {
  const [minLon, minLat, maxLon, maxLat] = graph.bbox;
  const nx = graph.gridNx;
  const ny = graph.gridNy;
  const cellW = (maxLon - minLon) / nx;
  const cellH = (maxLat - minLat) / ny;

  // A point outside the bbox searches outward from the nearest border cell.
  const cx = Math.min(nx - 1, Math.max(0, Math.floor((lon - minLon) / cellW)));
  const cy = Math.min(ny - 1, Math.max(0, Math.floor((lat - minLat) / cellH)));

  // One cos for the whole query, not one per candidate. The value is identical
  // either way -- this is purely about not paying for it thousands of times.
  const kx = lonScaleM(lat);
  const qx = lon * kx;
  const qy = latToM(lat);
  let best = -1;
  let bestD2 = Infinity;

  const maxRing = Math.max(nx, ny);
  for (let ring = 0; ring <= maxRing; ring++) {
    const xLo = cx - ring;
    const xHi = cx + ring;
    const yLo = cy - ring;
    const yHi = cy + ring;

    for (let iy = Math.max(0, yLo); iy <= Math.min(ny - 1, yHi); iy++) {
      const onYBorder = iy === yLo || iy === yHi;
      for (let ix = Math.max(0, xLo); ix <= Math.min(nx - 1, xHi); ix++) {
        if (ring !== 0 && !onYBorder && ix !== xLo && ix !== xHi) continue;
        const cell = iy * nx + ix;
        const slotEnd = graph.gridOffset[cell + 1];
        for (let slot = graph.gridOffset[cell]; slot < slotEnd; slot++) {
          const node = graph.gridNodeId[slot];
          const dx = graph.nodeLon[node] * kx - qx;
          const dy = graph.nodeLat[node] * M_PER_DEG_LAT - qy;
          const d2 = dx * dx + dy * dy;
          if (d2 < bestD2 || (d2 === bestD2 && node < best)) {
            bestD2 = d2;
            best = node;
          }
        }
      }
    }

    // Termination is decided *after* consuming the ring, never before. The bound
    // says "everything outside rings 0..ring is at least `gap` away"; testing it
    // beforehand would use it to skip ring `ring` itself, which it does not
    // cover, and the search would miss nearer nodes in sparse neighbourhoods.
    if (best >= 0) {
      const gap = ringGapM(graph, qx, qy, kx, cx, cy, ring);
      if (gap * gap > bestD2) break;
    }
    if (xLo <= 0 && yLo <= 0 && xHi >= nx - 1 && yHi >= ny - 1) break;
  }

  return best;
}

/**
 * Lower bound, in metres, on the distance to any cell outside `ring`.
 * Zero while the block still touches the query point, so the search can never
 * terminate before examining at least one real candidate.
 */
function ringGapM(
  graph: Graph,
  qx: number,
  qy: number,
  kx: number,
  cx: number,
  cy: number,
  ring: number,
): number {
  const [minLon, minLat, maxLon, maxLat] = graph.bbox;
  const cellW = (maxLon - minLon) / graph.gridNx;
  const cellH = (maxLat - minLat) / graph.gridNy;

  const west = minLon + (cx - ring) * cellW;
  const east = minLon + (cx + ring + 1) * cellW;
  const south = minLat + (cy - ring) * cellH;
  const north = minLat + (cy + ring + 1) * cellH;

  return Math.max(
    0,
    Math.min(
      qx - west * kx,
      east * kx - qx,
      qy - latToM(south),
      latToM(north) - qy,
    ),
  );
}
