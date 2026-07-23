"""Reference routing in Python -- the ground truth ``worker/src/router.ts`` must match.

Optimised for being *obviously correct*, not for speed: plain lists, ``heapq``,
no clever indexing. It exists so that the fast typed-array TypeScript router has
something independent to be wrong against.

Not one of the spec's ``build/`` modules. It lives under ``testdata/`` because it
is test scaffolding, not part of the pipeline that produces R2 artefacts.

Cross-language determinism
==========================

Costs are bit-identical between this module and ``router.ts``, and that is not a
happy accident:

* Every quantity that enters a cost -- ``dist``, ``ascent`` -- is read from the
  binary as f32 and widened to f64. Both languages therefore sum *the same*
  doubles in *the same order* along a path.
* NumPy arrays are converted to Python lists of ``float`` up front. Left as numpy
  scalars, ``np.float32(x) * 1.0`` could evaluate in float32 depending on the
  NumPy version's promotion rules, quietly halving precision on one side only.
* Ties are broken identically: the heap orders on ``(key, node_id)`` and
  relaxation is strictly ``<``, so the first predecessor to achieve a cost keeps
  it. ``heapq`` compares tuples lexicographically, which is exactly what the
  TypeScript heap implements by hand.

The one thing that is *not* bit-identical is :func:`math.sin` and friends, which
no standard requires to be correctly rounded. That is confined to the A*
heuristic, where a last-ulp difference can only reorder expansions, and to
snapping, where ties break on node id.
"""

from __future__ import annotations

import heapq
import math
from dataclasses import dataclass
from typing import Final

import numpy as np

from build import binformat as bf
from build.geo import haversine_m, local_xy

#: Shrinks the A* heuristic just enough that floating-point noise cannot make it
#: overestimate. The straight-line term is computed in f64 from f32 coordinates
#: while ``edge_dist`` is a *rounded* f32, so on a near-straight path the
#: heuristic can exceed the true remaining cost by a few ulp and cost A* its
#: optimality guarantee. 2^-16 of slack swamps that by orders of magnitude while
#: costing ~0.0015 % of search efficiency.
#:
#: Scaling a consistent heuristic by c <= 1 preserves consistency: if
#: h(u) <= w(u,v) + h(v) then c*h(u) <= c*w + c*h(v) <= w + c*h(v).
H_SAFETY: Final = 1.0 - 2.0**-16

INF: Final = float("inf")


@dataclass(frozen=True)
class RouteResult:
    """A concrete route. ``edge_ids`` is what the API returns; the rest are totals."""

    nodes: list[int]
    edge_ids: list[int]
    cost: float
    dist_m: float
    ascent_m: float
    descent_m: float
    max_slope_pct: float


@dataclass(frozen=True)
class _Flat:
    """The graph as plain Python floats/ints -- see the module docstring on promotion."""

    node_count: int
    csr_offset: list[int]
    edge_target: list[int]
    edge_id: list[int]
    edge_dist: list[float]
    edge_ascent: list[float]
    edge_descent: list[float]
    edge_max_slope: list[int]
    node_lat: list[float]
    node_lon: list[float]
    node_elev: list[float]


def flatten(graph: bf.Graph) -> _Flat:
    """Widen the stored f32 sections to Python f64 exactly once."""
    return _Flat(
        node_count=graph.node_count,
        csr_offset=graph.csr_offset.astype(np.int64).tolist(),
        edge_target=graph.edge_target.astype(np.int64).tolist(),
        edge_id=graph.edge_id.astype(np.int64).tolist(),
        edge_dist=graph.edge_dist.astype(np.float64).tolist(),
        edge_ascent=graph.edge_ascent.astype(np.float64).tolist(),
        edge_descent=graph.edge_descent.astype(np.float64).tolist(),
        edge_max_slope=graph.edge_max_slope.astype(np.int64).tolist(),
        node_lat=graph.node_lat.astype(np.float64).tolist(),
        node_lon=graph.node_lon.astype(np.float64).tolist(),
        node_elev=graph.node_elev.astype(np.float64).tolist(),
    )


def edge_weight(f: _Flat, e: int, climb_factor: float) -> float:
    """``w = dist + climb_factor * ascent``, the spec's cost model, in f64."""
    return f.edge_dist[e] + climb_factor * f.edge_ascent[e]


def _blocked(f: _Flat, e: int, max_slope_pct: float | None) -> bool:
    if max_slope_pct is None:
        return False
    return bf.slope_exceeds(f.edge_max_slope[e], max_slope_pct)


# --------------------------------------------------------------------------- #
# Dijkstra
# --------------------------------------------------------------------------- #


def dijkstra(
    f: _Flat,
    source: int,
    climb_factor: float,
    *,
    max_slope_pct: float | None = None,
    max_cost: float = INF,
) -> tuple[list[float], list[int]]:
    """Single-source shortest costs. Returns ``(cost_per_node, incoming_edge)``.

    ``incoming_edge[v]`` is the *directed half-edge index* used to reach ``v``, or
    -1 for the source and anything unreached. Storing the half-edge rather than
    the predecessor node keeps reconstruction unambiguous when two nodes are
    joined by more than one edge.
    """
    cost = [INF] * f.node_count
    incoming = [-1] * f.node_count
    settled = [False] * f.node_count

    cost[source] = 0.0
    heap: list[tuple[float, int]] = [(0.0, source)]

    while heap:
        c, u = heapq.heappop(heap)
        if settled[u]:
            continue
        if c > max_cost:
            break  # heap is ordered: nothing cheaper remains
        settled[u] = True

        for e in range(f.csr_offset[u], f.csr_offset[u + 1]):
            if _blocked(f, e, max_slope_pct):
                continue
            v = f.edge_target[e]
            if settled[v]:
                continue
            nc = c + edge_weight(f, e, climb_factor)
            if nc < cost[v]:  # strict: first predecessor to reach this cost keeps it
                cost[v] = nc
                incoming[v] = e
                heapq.heappush(heap, (nc, v))

    return cost, incoming


# --------------------------------------------------------------------------- #
# A*
# --------------------------------------------------------------------------- #


def heuristic(f: _Flat, node: int, goal: int, climb_factor: float) -> float:
    """Admissible lower bound: straight line plus the climb that cannot be avoided.

    ``sum(dist) >= great-circle`` because a polyline obeys the triangle inequality
    on a sphere, and ``sum(ascent) >= max(0, net gain)`` because descent is never
    negative. The sum of two independent lower bounds is a lower bound.

    Still admissible under a slope filter: removing edges can only *raise* the
    true remaining cost, and h does not change.
    """
    line = haversine_m(f.node_lat[node], f.node_lon[node], f.node_lat[goal], f.node_lon[goal])
    climb = max(0.0, f.node_elev[goal] - f.node_elev[node])
    return H_SAFETY * (line + climb_factor * climb)


def astar(
    f: _Flat,
    source: int,
    goal: int,
    climb_factor: float,
    *,
    max_slope_pct: float | None = None,
) -> RouteResult | None:
    """Optimal route via A*, or ``None`` if the goal is unreachable."""
    g_cost = [INF] * f.node_count
    incoming = [-1] * f.node_count
    settled = [False] * f.node_count

    g_cost[source] = 0.0
    heap: list[tuple[float, int]] = [(heuristic(f, source, goal, climb_factor), source)]

    while heap:
        _f_score, u = heapq.heappop(heap)
        if settled[u]:
            continue
        settled[u] = True
        if u == goal:
            break

        cu = g_cost[u]
        for e in range(f.csr_offset[u], f.csr_offset[u + 1]):
            if _blocked(f, e, max_slope_pct):
                continue
            v = f.edge_target[e]
            if settled[v]:
                continue
            nc = cu + edge_weight(f, e, climb_factor)
            if nc < g_cost[v]:
                g_cost[v] = nc
                incoming[v] = e
                heapq.heappush(heap, (nc + heuristic(f, v, goal, climb_factor), v))

    if not settled[goal]:
        return None
    return build_route(f, source, goal, g_cost, incoming)


# --------------------------------------------------------------------------- #
# Reconstruction
# --------------------------------------------------------------------------- #


def build_route(
    f: _Flat, source: int, goal: int, cost: list[float], incoming: list[int]
) -> RouteResult | None:
    """Walk the predecessor half-edges back from ``goal`` and total the attributes.

    Totals are summed from the stored per-edge values. ``ascent`` is emphatically
    not recomputed from node elevations: an out-and-back over a hump would then
    report zero.
    """
    if cost[goal] == INF:
        return None

    edges: list[int] = []
    node = goal
    while node != source:
        e = incoming[node]
        if e < 0:
            return None
        edges.append(e)
        # The half-edge's source is the node whose CSR block contains it.
        node = _source_of(f, e)
    edges.reverse()

    nodes = [source]
    dist = ascent = descent = 0.0
    max_slope_u8 = 0
    edge_ids: list[int] = []
    for e in edges:
        nodes.append(f.edge_target[e])
        edge_ids.append(f.edge_id[e])
        dist += f.edge_dist[e]
        ascent += f.edge_ascent[e]
        descent += f.edge_descent[e]
        max_slope_u8 = max(max_slope_u8, f.edge_max_slope[e])

    return RouteResult(
        nodes=nodes,
        edge_ids=edge_ids,
        cost=cost[goal],
        dist_m=dist,
        ascent_m=ascent,
        descent_m=descent,
        max_slope_pct=bf.decode_max_slope(max_slope_u8),
    )


def _source_of(f: _Flat, edge: int) -> int:
    """Which node's CSR block holds this half-edge. Binary search over csr_offset."""
    lo, hi = 0, f.node_count
    while lo < hi:
        mid = (lo + hi) // 2
        if f.csr_offset[mid + 1] <= edge:
            lo = mid + 1
        else:
            hi = mid
    return lo


def route(
    f: _Flat,
    source: int,
    goal: int,
    climb_factor: float,
    *,
    max_slope_pct: float | None = None,
) -> RouteResult | None:
    """Ground-truth route via full Dijkstra -- no heuristic in the trusted path."""
    cost, incoming = dijkstra(f, source, climb_factor, max_slope_pct=max_slope_pct)
    if cost[goal] == INF:
        return None
    return build_route(f, source, goal, cost, incoming)


# --------------------------------------------------------------------------- #
# Effort field
# --------------------------------------------------------------------------- #


def effort_field(
    f: _Flat,
    source: int,
    climb_factor: float,
    *,
    max_slope_pct: float | None = None,
    max_cost: float = INF,
) -> dict[int, float]:
    """``edge_id -> effort to reach that edge``, for the whole reachable field.

    Per decision D2 an edge's cost is ``min(cost[u], cost[v])`` -- the effort to
    *reach* it, which is the isochrone convention and what "wohin man mit welchem
    Aufwand kommt" asks for. ``max(...)`` would mean "effort to have fully
    traversed it" and would make the frontier look artificially expensive.

    A geometric edge is omitted when both of its halves are removed by the slope
    filter: colouring a road the rider is filtering out would misreport reach.
    """
    cost, _ = dijkstra(f, source, climb_factor, max_slope_pct=max_slope_pct, max_cost=max_cost)

    field: dict[int, float] = {}
    for u in range(f.node_count):
        for e in range(f.csr_offset[u], f.csr_offset[u + 1]):
            if _blocked(f, e, max_slope_pct):
                continue
            v = f.edge_target[e]
            reach = min(cost[u], cost[v])
            # `reach > max_cost` alone does not exclude unreachable edges: with a
            # default budget of infinity, `inf > inf` is False and the entire
            # disconnected component would be emitted at cost infinity.
            if reach == INF or reach > max_cost:
                continue
            eid = f.edge_id[e]
            if eid not in field or reach < field[eid]:
                field[eid] = reach
    return field


# --------------------------------------------------------------------------- #
# Snapping
# --------------------------------------------------------------------------- #


def snap_bruteforce(f: _Flat, lat: float, lon: float) -> int:
    """Nearest node by exhaustive scan. The oracle the grid index is checked against."""
    qx, qy = local_xy(lat, lon, lat)
    best = -1
    best_d2 = INF
    for n in range(f.node_count):
        nx, ny = local_xy(f.node_lat[n], f.node_lon[n], lat)
        d2 = (nx - qx) ** 2 + (ny - qy) ** 2
        if d2 < best_d2:  # strict: ties keep the lower node id
            best_d2 = d2
            best = n
    return best


def snap_grid(graph: bf.Graph, f: _Flat, lat: float, lon: float) -> int:
    """Nearest node via the stored grid index, by expanding rings.

    The ring search does **not** stop at the first non-empty ring. It keeps going
    until the nearest possible point of the next ring is farther than the best
    candidate found so far. Stopping early is the classic snapping bug: it is
    invisible in dense terrain and wrong exactly at region borders and across the
    empty cells that make up half of any real grid.
    """
    min_lon, min_lat, max_lon, max_lat = graph.bbox
    nx, ny = graph.grid_nx, graph.grid_ny
    cell_w = (max_lon - min_lon) / nx
    cell_h = (max_lat - min_lat) / ny

    # Query cell, clamped -- a point outside the bbox searches from the border.
    cx = min(nx - 1, max(0, int(math.floor((lon - min_lon) / cell_w)) if cell_w > 0 else 0))
    cy = min(ny - 1, max(0, int(math.floor((lat - min_lat) / cell_h)) if cell_h > 0 else 0))

    qx, qy = local_xy(lat, lon, lat)
    best = -1
    best_d2 = INF

    def consider(ix: int, iy: int) -> None:
        nonlocal best, best_d2
        cell = iy * nx + ix
        for slot in range(int(graph.grid_offset[cell]), int(graph.grid_offset[cell + 1])):
            n = int(graph.grid_nodeid[slot])
            px, py = local_xy(f.node_lat[n], f.node_lon[n], lat)
            d2 = (px - qx) ** 2 + (py - qy) ** 2
            if d2 < best_d2 or (d2 == best_d2 and n < best):
                best_d2 = d2
                best = n

    max_ring = max(nx, ny)
    for ring in range(max_ring + 1):
        x_lo, x_hi = cx - ring, cx + ring
        y_lo, y_hi = cy - ring, cy + ring
        for iy in range(max(0, y_lo), min(ny - 1, y_hi) + 1):
            for ix in range(max(0, x_lo), min(nx - 1, x_hi) + 1):
                if ring == 0 or ix in (x_lo, x_hi) or iy in (y_lo, y_hi):
                    consider(ix, iy)

        # Termination is decided *after* consuming the ring, never before. The
        # bound says "everything outside rings 0..ring is at least `gap` away";
        # testing it beforehand would use it to skip ring `ring` itself, which it
        # does not cover -- the search would then miss a nearer node whenever the
        # query cell's own neighbourhood is sparse.
        if best >= 0:
            gap = _ring_gap_m(lat, lon, graph, cx, cy, ring)
            if gap * gap > best_d2:
                break
        if x_lo <= 0 and y_lo <= 0 and x_hi >= nx - 1 and y_hi >= ny - 1:
            break  # rings have swallowed the whole grid

    return best


def _ring_gap_m(
    lat: float, lon: float, graph: bf.Graph, cx: int, cy: int, ring: int
) -> float:
    """Lower bound, in metres, on the distance to any cell outside ``ring``.

    Zero while the ring block still touches the query point's own cell, so the
    search can never terminate before examining at least one real candidate.
    """
    min_lon, min_lat, max_lon, max_lat = graph.bbox
    cell_w = (max_lon - min_lon) / graph.grid_nx
    cell_h = (max_lat - min_lat) / graph.grid_ny

    west = min_lon + (cx - ring) * cell_w
    east = min_lon + (cx + ring + 1) * cell_w
    south = min_lat + (cy - ring) * cell_h
    north = min_lat + (cy + ring + 1) * cell_h

    qx, qy = local_xy(lat, lon, lat)
    wx, _ = local_xy(lat, west, lat)
    ex, _ = local_xy(lat, east, lat)
    _, sy = local_xy(south, lon, lat)
    _, ny_ = local_xy(north, lon, lat)

    return max(0.0, min(qx - wx, ex - qx, qy - sy, ny_ - qy))
