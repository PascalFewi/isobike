"""Reference routing in Python -- the ground truth ``worker/src/router.ts`` must match.

Optimised for being *obviously correct*, not for speed: plain lists, ``heapq``,
no clever indexing. It exists so that the fast typed-array TypeScript router has
something independent to be wrong against.

Not one of the spec's ``build/`` modules. It lives under ``testdata/`` because it
is test scaffolding, not part of the pipeline that produces R2 artefacts.

Cost model (spec v1.1)
======================

The weight of a directed edge is **time in seconds**::

    w = dist / v_flat + ascent / vam        (v_flat in m/s, vam in Hm/s = m/s)

expressed as a sum-family with parameters ``w = a*dist + b*ascent`` where
``a = 1/v_flat`` and ``b = 1/vam`` (see :class:`CostModel`). The route that
minimises time is *identical* to the one the old ``dist + cf*ascent`` model
found, because ``time = (1/v_flat) * (dist + cf*ascent)`` with ``cf = v_flat/vam``
and ``1/v_flat`` is a positive constant. So all the A*/Dijkstra correctness
carries over; only the reported cost is now seconds. Steepness is a *filter only*,
never a cost term.

Dijkstra additionally accumulates, per node and along the cost-optimal path, the
cumulative ascent and the max slope encountered -- at zero extra asymptotic cost,
and as the prerequisite for the effort field's second colour channel.

Cross-language determinism
==========================

Costs are bit-identical between this module and ``router.ts``:

* ``a`` and ``b`` are the same f64 on both sides -- both compute ``1/v_flat`` from
  the identical ``v_flat`` value (IEEE division is correctly rounded), and the
  golden files carry ``v_flat``/``vam`` at full precision.
* Every quantity that enters a cost -- ``dist``, ``ascent`` -- is read from the
  binary as f32 and widened to f64, so both languages sum ``a*dist + b*ascent``
  over the same doubles in the same order along a path.
* NumPy arrays are converted to Python lists of ``float`` up front, so a numpy
  scalar's float32 promotion rules cannot silently halve precision on one side.
* Ties break identically: the heap orders on ``(key, node_id)`` and relaxation is
  strictly ``<``, so the first predecessor to achieve a cost keeps it.

The one thing that is *not* bit-identical is :func:`math.sin` and friends, which
no standard requires to be correctly rounded. That is confined to the A*
heuristic (a last-ulp difference only reorders expansions) and to snapping (ties
break on node id).
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
#: heuristic can exceed the true remaining cost by a few ulp. 2^-16 of slack
#: swamps that by orders of magnitude while costing ~0.0015 % of search
#: efficiency. Scaling a consistent heuristic by c <= 1 preserves consistency.
H_SAFETY: Final = 1.0 - 2.0**-16

INF: Final = float("inf")


@dataclass(frozen=True)
class CostModel:
    """Linear sum-family edge weight ``w = a*dist + b*ascent``.

    For the time metric ``a = 1/v_flat`` (s/m) and ``b = 1/vam`` (s/m), so ``w``
    is seconds. The distance-equivalent fallback keeps ``a = 1`` and folds the
    old climb_factor into ``b``.

    Held as the reciprocals, not as speeds, because the reciprocals are what the
    weight and heuristic multiply -- computing them once keeps the hot path a
    multiply-add and keeps Python and TypeScript bit-identical.
    """

    a: float  # seconds per metre of distance   = 1 / v_flat
    b: float  # seconds per metre of ascent      = 1 / vam

    @classmethod
    def time(cls, v_flat_mps: float, vam_mps: float) -> CostModel:
        """From a profile's flat speed (m/s) and vertical speed (Hm/s = m/s)."""
        if v_flat_mps <= 0.0 or vam_mps <= 0.0:
            raise ValueError("v_flat and vam must be positive")
        return cls(1.0 / v_flat_mps, 1.0 / vam_mps)

    @classmethod
    def distance_equiv(cls, climb_factor: float) -> CostModel:
        """Internal fallback: ``w = dist + climb_factor*ascent`` (metres, not seconds)."""
        return cls(1.0, climb_factor)


#: km/h -> m/s and Hm/h -> m/s. Defined as constants so the exact double is fixed
#: and every profile derives from the same conversion.
KMH_TO_MPS: Final = 1000.0 / 3600.0
HMH_TO_MPS: Final = 1.0 / 3600.0


@dataclass(frozen=True)
class Profile:
    """A rider profile: flat speed and vertical (climbing) speed, both in m/s.

    ``cf = v_flat / vam`` is what actually drives route choice. A flat specialist
    (fast on the flat, slow uphill) has a *high* cf and avoids climbing; a climber
    has a lower cf. The spec's anchors: Flach 30 km/h / 500 Hm/h, Mixed 27 / 700,
    Gebirge 25 / 900.
    """

    name: str
    v_flat_mps: float
    vam_mps: float

    @classmethod
    def from_kmh(cls, name: str, v_flat_kmh: float, vam_hmh: float) -> Profile:
        return cls(name, v_flat_kmh * KMH_TO_MPS, vam_hmh * HMH_TO_MPS)

    @property
    def climb_factor(self) -> float:
        return self.v_flat_mps / self.vam_mps

    def model(self) -> CostModel:
        return CostModel.time(self.v_flat_mps, self.vam_mps)


#: The spec's three anchor profiles, shared by the golden generator and tests.
PROFILES: Final[tuple[Profile, ...]] = (
    Profile.from_kmh("flach", 30.0, 500.0),
    Profile.from_kmh("mixed", 27.0, 700.0),
    Profile.from_kmh("gebirge", 25.0, 900.0),
)

#: Default effort-field budget: 8 hours, in seconds. Profile-independent because
#: the cost is now time. Replaces the old distance-equivalent 216 000 m.
DEFAULT_BUDGET_S: Final = 8 * 3600.0


@dataclass(frozen=True)
class RouteResult:
    """A concrete route. ``edge_ids`` is what the API returns; the rest are totals."""

    nodes: list[int]
    edge_ids: list[int]
    #: Optimisation cost of the path -- seconds under the time model.
    cost: float
    dist_m: float
    ascent_m: float
    descent_m: float
    max_slope_pct: float


@dataclass(frozen=True)
class DijkstraResult:
    """Single-source search state. Arrays are indexed by node id.

    ``cum_ascent`` and ``max_slope_u8`` are taken *along the cost-optimal path* to
    each node -- updated exactly when ``cost`` improves, so they are final once the
    node is settled. They are the prerequisite for the effort field's second
    channel and the reason the spec has Dijkstra carry three values, not one.
    """

    cost: list[float]
    cum_ascent: list[float]
    max_slope_u8: list[int]
    #: Directed half-edge used to reach each node, or -1 for source/unreached.
    incoming: list[int]


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


def edge_weight(f: _Flat, e: int, model: CostModel) -> float:
    """``w = a*dist + b*ascent`` in f64 -- seconds under the time model."""
    return model.a * f.edge_dist[e] + model.b * f.edge_ascent[e]


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
    model: CostModel,
    *,
    max_slope_pct: float | None = None,
    max_cost: float = INF,
) -> DijkstraResult:
    """Single-source shortest costs, carrying three accumulators per node.

    ``incoming[v]`` is the *directed half-edge index* used to reach ``v``, or -1
    for the source and anything unreached. Storing the half-edge rather than the
    predecessor node keeps reconstruction unambiguous when two nodes are joined
    by more than one edge.
    """
    n = f.node_count
    cost = [INF] * n
    cum_ascent = [0.0] * n
    max_slope_u8 = [0] * n
    incoming = [-1] * n
    settled = [False] * n

    cost[source] = 0.0
    heap: list[tuple[float, int]] = [(0.0, source)]

    while heap:
        c, u = heapq.heappop(heap)
        if settled[u]:
            continue
        if c > max_cost:
            break  # heap is ordered: nothing cheaper remains
        settled[u] = True

        cu_ascent = cum_ascent[u]
        cu_slope = max_slope_u8[u]
        for e in range(f.csr_offset[u], f.csr_offset[u + 1]):
            if _blocked(f, e, max_slope_pct):
                continue
            v = f.edge_target[e]
            if settled[v]:
                continue
            nc = c + edge_weight(f, e, model)
            if nc < cost[v]:  # strict: first predecessor to reach this cost keeps it
                cost[v] = nc
                # Accumulate the secondary quantities along this same optimal edge.
                cum_ascent[v] = cu_ascent + f.edge_ascent[e]
                s = f.edge_max_slope[e]
                max_slope_u8[v] = cu_slope if cu_slope >= s else s
                incoming[v] = e
                heapq.heappush(heap, (nc, v))

    return DijkstraResult(cost, cum_ascent, max_slope_u8, incoming)


# --------------------------------------------------------------------------- #
# A*
# --------------------------------------------------------------------------- #


def heuristic(f: _Flat, node: int, goal: int, model: CostModel) -> float:
    """Admissible lower bound on time: straight line plus unavoidable climb.

    ``sum(dist) >= great-circle`` because a polyline obeys the triangle
    inequality on a sphere, and ``sum(ascent) >= max(0, net gain)`` because
    descent is never negative. Scaled into seconds by the model's ``a`` and ``b``;
    the sum of two independent lower bounds is a lower bound.

    Still admissible under a slope filter: removing edges can only *raise* the
    true remaining cost, and h does not change.
    """
    line = haversine_m(f.node_lat[node], f.node_lon[node], f.node_lat[goal], f.node_lon[goal])
    climb = max(0.0, f.node_elev[goal] - f.node_elev[node])
    return H_SAFETY * (model.a * line + model.b * climb)


def astar(
    f: _Flat,
    source: int,
    goal: int,
    model: CostModel,
    *,
    max_slope_pct: float | None = None,
) -> RouteResult | None:
    """Optimal route via A*, or ``None`` if the goal is unreachable."""
    n = f.node_count
    g_cost = [INF] * n
    incoming = [-1] * n
    settled = [False] * n

    g_cost[source] = 0.0
    heap: list[tuple[float, int]] = [(heuristic(f, source, goal, model), source)]

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
            nc = cu + edge_weight(f, e, model)
            if nc < g_cost[v]:
                g_cost[v] = nc
                incoming[v] = e
                heapq.heappush(heap, (nc + heuristic(f, v, goal, model), v))

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
    model: CostModel,
    *,
    max_slope_pct: float | None = None,
) -> RouteResult | None:
    """Ground-truth route via full Dijkstra -- no heuristic in the trusted path."""
    result = dijkstra(f, source, model, max_slope_pct=max_slope_pct)
    if result.cost[goal] == INF:
        return None
    return build_route(f, source, goal, result.cost, result.incoming)


# --------------------------------------------------------------------------- #
# Effort field
# --------------------------------------------------------------------------- #


def effort_field(
    f: _Flat,
    source: int,
    model: CostModel,
    *,
    max_slope_pct: float | None = None,
    max_cost: float = INF,
) -> dict[int, tuple[float, float]]:
    """``edge_id -> (time, cum_ascent)`` over the whole reachable field.

    Per decision D2 an edge's reach ``time`` is ``min(cost[u], cost[v])`` -- the
    effort to *reach* it, the isochrone convention. ``cum_ascent`` is taken at the
    *same* (cheaper) endpoint, so time and climb refer to one consistent journey.
    On a cost tie the endpoint with the smaller cum_ascent wins, which is
    deterministic and identical across languages because both halves of the
    geometric edge evaluate the same two endpoints and we keep the lexicographic
    minimum ``(time, cum_ascent)``.

    A geometric edge is omitted when both of its halves are removed by the slope
    filter, or when it is unreachable: colouring a road the rider is filtering
    out, or cannot reach, would misreport reach.
    """
    res = dijkstra(f, source, model, max_slope_pct=max_slope_pct, max_cost=max_cost)
    cost, cum_ascent = res.cost, res.cum_ascent

    field: dict[int, tuple[float, float]] = {}
    for u in range(f.node_count):
        for e in range(f.csr_offset[u], f.csr_offset[u + 1]):
            if _blocked(f, e, max_slope_pct):
                continue
            v = f.edge_target[e]
            if cost[u] <= cost[v]:
                t, asc = cost[u], cum_ascent[u]
            else:
                t, asc = cost[v], cum_ascent[v]
            # `t > max_cost` alone does not exclude unreachable edges: with the
            # default infinite budget, `inf > inf` is False and the whole
            # disconnected component would leak in at cost infinity.
            if t == INF or t > max_cost:
                continue
            eid = f.edge_id[e]
            cur = field.get(eid)
            if cur is None or (t, asc) < cur:
                field[eid] = (t, asc)
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
    candidate found so far. Stopping early is the classic snapping bug: invisible
    in dense terrain, wrong exactly at region borders and across the empty cells
    that make up half of any real grid.
    """
    min_lon, min_lat, max_lon, max_lat = graph.bbox
    nx, ny = graph.grid_nx, graph.grid_ny
    cell_w = (max_lon - min_lon) / nx
    cell_h = (max_lat - min_lat) / ny

    cx = min(nx - 1, max(0, int(math.floor((lon - min_lon) / cell_w)) if cell_w > 0 else 0))
    cy = min(ny - 1, max(0, int(math.floor((lat - min_lat) / cell_h)) if cell_h > 0 else 0))

    qx, qy = local_xy(lat, lon, lat)
    best = -1
    best_d2 = INF

    def consider(ix: int, iy: int) -> None:
        nonlocal best, best_d2
        cell = iy * nx + ix
        for slot in range(int(graph.grid_offset[cell]), int(graph.grid_offset[cell + 1])):
            node = int(graph.grid_nodeid[slot])
            px, py = local_xy(f.node_lat[node], f.node_lon[node], lat)
            d2 = (px - qx) ** 2 + (py - qy) ** 2
            if d2 < best_d2 or (d2 == best_d2 and node < best):
                best_d2 = d2
                best = node

    max_ring = max(nx, ny)
    for ring in range(max_ring + 1):
        x_lo, x_hi = cx - ring, cx + ring
        y_lo, y_hi = cy - ring, cy + ring
        for iy in range(max(0, y_lo), min(ny - 1, y_hi) + 1):
            for ix in range(max(0, x_lo), min(nx - 1, x_hi) + 1):
                if ring == 0 or ix in (x_lo, x_hi) or iy in (y_lo, y_hi):
                    consider(ix, iy)

        # Termination is decided *after* consuming the ring, never before -- the
        # bound covers only cells outside rings 0..ring, not ring itself.
        if best >= 0:
            gap = _ring_gap_m(lat, lon, graph, cx, cy, ring)
            if gap * gap > best_d2:
                break
        if x_lo <= 0 and y_lo <= 0 and x_hi >= nx - 1 and y_hi >= ny - 1:
            break

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
