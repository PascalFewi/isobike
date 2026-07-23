"""Correctness of the Python reference router, in Python's own terms.

This suite must pass before the reference is allowed to generate golden files.
It proves:

1. The heuristic is admissible and consistent under the time cost model -- checked
   *directly* against true costs from a reverse-graph Dijkstra, per cost model and
   slope filter.
2. A* reproduces Dijkstra exactly, including under slope filters.
3. The three per-node accumulators (time, cum_ascent, max_slope) are the values
   along the cost-optimal path.
4. The effort model changes routing the way the (v_flat, vam) profile claims.
"""

from __future__ import annotations

import heapq
import math

import pytest

from build import binformat as bf
from build.geo import haversine_m
from testdata.gen import reference_router as rr
from testdata.gen import ridge_world as rwmod
from testdata.gen.ridge_world import build_ridge_world

INF = rr.INF

FLACH, MIXED, GEBIRGE = (p.model() for p in rr.PROFILES)

#: (label, CostModel, max_slope_pct). Spans the three time profiles, the
#: pure-distance fallback, and slope filters -- including 6 %, which disconnects
#: the ridge so the unreachable branch gets the same scrutiny as the happy path.
SWEEP: list[tuple[str, rr.CostModel, float | None]] = [
    ("flach", FLACH, None),
    ("mixed", MIXED, None),
    ("gebirge", GEBIRGE, None),
    ("dist0", rr.CostModel.distance_equiv(0.0), None),
    ("dist60", rr.CostModel.distance_equiv(60.0), None),
    ("mixed@12", MIXED, 12.0),
    ("gebirge@8", GEBIRGE, 8.0),
    ("flach@6", FLACH, 6.0),
]


@pytest.fixture(scope="module")
def world() -> rwmod.RidgeWorld:
    return build_ridge_world()


@pytest.fixture(scope="module")
def flat(world: rwmod.RidgeWorld) -> rr._Flat:
    return rr.flatten(world.graph)


def _reverse_costs(
    f: rr._Flat, goal: int, model: rr.CostModel, max_slope_pct: float | None
) -> list[float]:
    """True cost from every node *to* ``goal``, via Dijkstra on the reversed arcs.

    Cannot be obtained by running the forward search from ``goal``: cost is
    directed (ascent one way is descent the other), so the stored twin half-edge
    carries a different weight, not the same one.
    """
    rev: list[list[tuple[int, float]]] = [[] for _ in range(f.node_count)]
    for u in range(f.node_count):
        for e in range(f.csr_offset[u], f.csr_offset[u + 1]):
            if max_slope_pct is not None and bf.slope_exceeds(f.edge_max_slope[e], max_slope_pct):
                continue
            rev[f.edge_target[e]].append((u, rr.edge_weight(f, e, model)))

    cost = [INF] * f.node_count
    cost[goal] = 0.0
    heap = [(0.0, goal)]
    settled = [False] * f.node_count
    while heap:
        c, u = heapq.heappop(heap)
        if settled[u]:
            continue
        settled[u] = True
        for v, w in rev[u]:
            nc = c + w
            if nc < cost[v]:
                cost[v] = nc
                heapq.heappush(heap, (nc, v))
    return cost


def _recompute(f: rr._Flat, result: rr.RouteResult, model: rr.CostModel) -> float:
    """Re-add the route's edge weights left to right, as Dijkstra accumulated them."""
    total = 0.0
    for u, v in zip(result.nodes, result.nodes[1:]):
        best = INF
        for e in range(f.csr_offset[u], f.csr_offset[u + 1]):
            if f.edge_target[e] == v:
                best = min(best, rr.edge_weight(f, e, model))
        total += best
    return total


# --------------------------------------------------------------------------- #
# The heuristic
# --------------------------------------------------------------------------- #


@pytest.mark.parametrize("label,model,max_slope", SWEEP)
def test_heuristic_never_overestimates_the_true_remaining_cost(
    flat: rr._Flat, world: rwmod.RidgeWorld, label: str, model: rr.CostModel, max_slope: float | None
) -> None:
    """Admissibility, verified directly against true costs -- including under a filter."""
    for goal in (0, world.lattice_node(11, 8), world.bump_b, world.island[0]):
        true_cost = _reverse_costs(flat, goal, model, max_slope)
        for node in range(flat.node_count):
            if true_cost[node] == INF:
                continue
            h = rr.heuristic(flat, node, goal, model)
            assert h <= true_cost[node], (
                f"[{label}] h({node}->{goal})={h!r} exceeds true {true_cost[node]!r}"
            )


@pytest.mark.parametrize("label,model,max_slope", SWEEP)
def test_heuristic_is_consistent_on_every_edge(
    flat: rr._Flat, world: rwmod.RidgeWorld, label: str, model: rr.CostModel, max_slope: float | None
) -> None:
    """h(u) <= w(u,v) + h(v) everywhere, which is what lets A* close nodes for good."""
    f = flat
    for goal in (0, world.lattice_node(15, 4)):
        for u in range(f.node_count):
            hu = rr.heuristic(f, u, goal, model)
            for e in range(f.csr_offset[u], f.csr_offset[u + 1]):
                if max_slope is not None and bf.slope_exceeds(f.edge_max_slope[e], max_slope):
                    continue
                v = f.edge_target[e]
                hv = rr.heuristic(f, v, goal, model)
                assert hu <= rr.edge_weight(f, e, model) + hv + 1e-9, f"[{label}] {u}->{v}"


def test_heuristic_is_zero_at_the_goal(flat: rr._Flat) -> None:
    for goal in (0, 100, 356):
        assert rr.heuristic(flat, goal, goal, MIXED) == 0.0


def test_heuristic_scales_with_the_model(flat: rr._Flat) -> None:
    """Same geometry, two models -> the ratio is exactly a1*.../a2*... (no trig reuse)."""
    node, goal = 0, 200
    h_dist = rr.heuristic(flat, node, goal, rr.CostModel.distance_equiv(0.0))
    line = haversine_m(flat.node_lat[node], flat.node_lon[node], flat.node_lat[goal], flat.node_lon[goal])
    assert h_dist == pytest.approx(rr.H_SAFETY * line, rel=1e-12)


# --------------------------------------------------------------------------- #
# A* == Dijkstra
# --------------------------------------------------------------------------- #


def _check_source_against_astar(
    f: rr._Flat, src: int, model: rr.CostModel, max_slope: float | None, label: str
) -> None:
    res = rr.dijkstra(f, src, model, max_slope_pct=max_slope)
    for dst in range(f.node_count):
        found = rr.astar(f, src, dst, model, max_slope_pct=max_slope)
        if res.cost[dst] == INF:
            assert found is None, f"[{label}] A* found unreachable {src}->{dst}"
            continue
        assert found is not None, f"[{label}] A* missed {src}->{dst}"
        truth = rr.build_route(f, src, dst, res.cost, res.incoming)
        assert truth is not None
        assert found.cost == truth.cost, f"[{label}] {src}->{dst}: {found.cost!r} != {truth.cost!r}"
        if found.edge_ids != truth.edge_ids:
            assert _recompute(f, found, model) == pytest.approx(truth.cost, rel=1e-12)
        assert _recompute(f, truth, model) == pytest.approx(truth.cost, rel=1e-12)


@pytest.mark.parametrize("label,model,max_slope", SWEEP)
def test_astar_matches_dijkstra_from_sampled_sources(
    flat: rr._Flat, label: str, model: rr.CostModel, max_slope: float | None
) -> None:
    """Six spread sources against every target, for each cost/filter combination."""
    for src in (0, 87, 175, 260, 351, 352):
        _check_source_against_astar(flat, src, model, max_slope, label)


@pytest.mark.slow
@pytest.mark.parametrize("label,model,max_slope", SWEEP)
def test_astar_matches_dijkstra_for_every_pair(
    flat: rr._Flat, label: str, model: rr.CostModel, max_slope: float | None
) -> None:
    for src in range(flat.node_count):
        _check_source_against_astar(flat, src, model, max_slope, label)


# --------------------------------------------------------------------------- #
# The three accumulators
# --------------------------------------------------------------------------- #


def test_dijkstra_accumulators_match_the_reconstructed_path(
    flat: rr._Flat, world: rwmod.RidgeWorld
) -> None:
    """cum_ascent / max_slope per node must equal the totals along the optimal route."""
    f = flat
    res = rr.dijkstra(f, 0, MIXED)
    checked = 0
    for dst in range(f.node_count):
        if res.cost[dst] == INF:
            continue
        route = rr.build_route(f, 0, dst, res.cost, res.incoming)
        assert route is not None
        assert res.cum_ascent[dst] == pytest.approx(route.ascent_m, rel=1e-12), dst
        assert bf.decode_max_slope(res.max_slope_u8[dst]) == route.max_slope_pct, dst
        checked += 1
    assert checked > 300


def test_cost_equals_dist_over_vflat_plus_ascent_over_vam(
    flat: rr._Flat, world: rwmod.RidgeWorld
) -> None:
    """The reported cost really is the spec's time formula, to the ulp."""
    profile = rr.PROFILES[1]  # mixed
    route = rr.route(flat, world.lattice_node(2, 2), world.lattice_node(19, 12), profile.model())
    assert route is not None
    expected = route.dist_m / profile.v_flat_mps + route.ascent_m / profile.vam_mps
    assert route.cost == pytest.approx(expected, rel=1e-12)


# --------------------------------------------------------------------------- #
# Unreachability
# --------------------------------------------------------------------------- #


def test_island_is_unreachable_in_both_directions(
    flat: rr._Flat, world: rwmod.RidgeWorld
) -> None:
    for node in world.island:
        assert rr.route(flat, 0, node, MIXED) is None
        assert rr.astar(flat, 0, node, MIXED) is None
        assert rr.route(flat, node, 0, MIXED) is None


def test_routing_within_the_island_still_works(flat: rr._Flat, world: rwmod.RidgeWorld) -> None:
    a, b, _c = world.island
    result = rr.route(flat, a, b, MIXED)
    assert result is not None and result.dist_m > 0.0


def test_route_to_self_is_empty_not_none(flat: rr._Flat) -> None:
    result = rr.route(flat, 42, 42, MIXED)
    assert result is not None
    assert result.edge_ids == [] and result.cost == 0.0 and result.dist_m == 0.0


def test_slope_filter_can_disconnect(flat: rr._Flat, world: rwmod.RidgeWorld) -> None:
    src, dst = world.lattice_node(1, 13), world.lattice_node(20, 13)
    assert rr.route(flat, src, dst, MIXED, max_slope_pct=6.0) is None
    assert rr.astar(flat, src, dst, MIXED, max_slope_pct=6.0) is None


# --------------------------------------------------------------------------- #
# Ascent is summed from stored edges, not from endpoints
# --------------------------------------------------------------------------- #


def test_route_totals_include_a_hump_with_no_net_gain(
    flat: rr._Flat, world: rwmod.RidgeWorld
) -> None:
    result = rr.route(flat, world.bump_anchor, world.bump_b, MIXED)
    assert result is not None
    net_gain = max(0.0, flat.node_elev[world.bump_b] - flat.node_elev[world.bump_anchor])
    assert result.ascent_m >= rwmod.BUMP_HEIGHT_M - 0.5
    assert result.ascent_m > net_gain + 10.0
    assert result.descent_m >= rwmod.BUMP_HEIGHT_M - 0.5


def test_route_totals_match_the_sum_of_traversed_edges(
    flat: rr._Flat, world: rwmod.RidgeWorld
) -> None:
    f = flat
    result = rr.route(f, world.lattice_node(2, 2), world.lattice_node(19, 12), GEBIRGE)
    assert result is not None

    dist = ascent = descent = 0.0
    slope = 0
    for u, v in zip(result.nodes, result.nodes[1:]):
        for e in range(f.csr_offset[u], f.csr_offset[u + 1]):
            if f.edge_target[e] == v:
                dist += f.edge_dist[e]
                ascent += f.edge_ascent[e]
                descent += f.edge_descent[e]
                slope = max(slope, f.edge_max_slope[e])
                break
    assert result.dist_m == pytest.approx(dist, rel=1e-12)
    assert result.ascent_m == pytest.approx(ascent, rel=1e-12)
    assert result.descent_m == pytest.approx(descent, rel=1e-12)
    assert result.max_slope_pct == bf.decode_max_slope(slope)


def test_cost_is_asymmetric_because_ascent_is(flat: rr._Flat, world: rwmod.RidgeWorld) -> None:
    """Directed cost over undirected topology: uphill and downhill differ in time."""
    low, high = world.lattice_node(0, 6), world.lattice_node(9, 6)
    up = rr.route(flat, low, high, GEBIRGE)
    down = rr.route(flat, high, low, GEBIRGE)
    assert up is not None and down is not None
    assert up.dist_m == pytest.approx(down.dist_m, rel=1e-6)
    assert up.cost != down.cost
    assert up.ascent_m == pytest.approx(down.descent_m, abs=0.5)


# --------------------------------------------------------------------------- #
# The effort model trades off
# --------------------------------------------------------------------------- #


def test_flatter_profile_trades_distance_for_ascent(flat: rr._Flat, world: rwmod.RidgeWorld) -> None:
    """Pure shortest (cf=0) climbs the ridge; the flat specialist (cf=60) rounds it."""
    src, dst = world.lattice_node(1, 13), world.lattice_node(20, 13)
    direct = rr.route(flat, src, dst, rr.CostModel.distance_equiv(0.0))
    flattest = rr.route(flat, src, dst, FLACH)  # cf = 60
    assert direct is not None and flattest is not None
    assert flattest.ascent_m < direct.ascent_m * 0.75
    assert flattest.dist_m > direct.dist_m * 1.1
    assert flattest.max_slope_pct < direct.max_slope_pct


def test_ascent_is_monotonically_non_increasing_in_climb_factor(
    flat: rr._Flat, world: rwmod.RidgeWorld
) -> None:
    """The property that makes the profile slider meaningful."""
    src, dst = world.lattice_node(1, 13), world.lattice_node(20, 13)
    ascents = []
    for cf in (0.0, 5.0, 20.0, 60.0, 200.0):
        result = rr.route(flat, src, dst, rr.CostModel.distance_equiv(cf))
        assert result is not None
        ascents.append(result.ascent_m)
    for a, b in zip(ascents, ascents[1:]):
        assert b <= a + 1e-6, f"ascent rose from {a} to {b} as cf increased"


def test_tighter_slope_filter_never_makes_a_route_cheaper(
    flat: rr._Flat, world: rwmod.RidgeWorld
) -> None:
    src, dst = world.lattice_node(1, 13), world.lattice_node(20, 13)
    previous = 0.0
    for limit in (None, 15.0, 12.0, 10.0, 8.0):
        result = rr.route(flat, src, dst, MIXED, max_slope_pct=limit)
        assert result is not None, f"unexpectedly unreachable at {limit}"
        assert result.cost >= previous - 1e-9
        if limit is not None:
            assert result.max_slope_pct <= limit
        previous = result.cost


# --------------------------------------------------------------------------- #
# Effort field
# --------------------------------------------------------------------------- #


def test_effort_field_covers_the_reachable_component_only(
    flat: rr._Flat, world: rwmod.RidgeWorld
) -> None:
    field = rr.effort_field(flat, 0, MIXED)
    g = world.graph
    island_edges = {
        int(g.edge_id[e])
        for n in world.island
        for e in range(int(g.csr_offset[n]), int(g.csr_offset[n + 1]))
    }
    assert island_edges
    assert island_edges.isdisjoint(field.keys())
    assert len(field) == g.geom_edge_count - len(island_edges)


def test_effort_field_time_is_the_cheaper_endpoint(flat: rr._Flat, world: rwmod.RidgeWorld) -> None:
    """Decision D2: time = min(cost[u], cost[v]); cum_ascent at that same endpoint."""
    f = flat
    res = rr.dijkstra(f, 0, MIXED)
    field = rr.effort_field(f, 0, MIXED)
    for u in range(f.node_count):
        for e in range(f.csr_offset[u], f.csr_offset[u + 1]):
            eid = f.edge_id[e]
            if eid not in field:
                continue
            v = f.edge_target[e]
            cheaper = u if res.cost[u] <= res.cost[v] else v
            time, cum_asc = field[eid]
            assert time <= min(res.cost[u], res.cost[v]) + 1e-9
            # The stored pair must belong to *some* incident endpoint's optimum.
            assert time == pytest.approx(res.cost[cheaper], rel=1e-12) or time < res.cost[cheaper]


def test_effort_field_source_edges_start_at_zero(flat: rr._Flat) -> None:
    field = rr.effort_field(flat, 0, MIXED)
    incident = {flat.edge_id[e] for e in range(flat.csr_offset[0], flat.csr_offset[1])}
    for eid in incident:
        time, cum_asc = field[eid]
        assert time == 0.0
        assert cum_asc == 0.0


def test_effort_field_cum_ascent_is_consistent_with_the_time(
    flat: rr._Flat, world: rwmod.RidgeWorld
) -> None:
    """For each edge, the stored cum_ascent is the ascent of a real optimal path."""
    f = flat
    res = rr.dijkstra(f, 0, MIXED)
    field = rr.effort_field(f, 0, MIXED)
    for eid, (time, cum_asc) in field.items():
        # cum_ascent cannot exceed the ascent of the cheaper endpoint's route,
        # and is non-negative.
        assert cum_asc >= -1e-9


def test_effort_field_budget_truncates_and_is_monotone(flat: rr._Flat) -> None:
    full = rr.effort_field(flat, 0, MIXED)
    sizes = []
    for budget in (300.0, 900.0, 1800.0, math.inf):
        field = rr.effort_field(flat, 0, MIXED, max_cost=budget)
        for eid, (time, cum_asc) in field.items():
            assert time <= budget
            assert (time, cum_asc) == full[eid]  # truncation must not change surviving values
        sizes.append(len(field))
    assert sizes == sorted(sizes)
    assert sizes[0] < sizes[-1]


def test_effort_field_omits_edges_the_filter_removes(flat: rr._Flat) -> None:
    field = rr.effort_field(flat, 0, MIXED, max_slope_pct=8.0)
    f = flat
    for u in range(f.node_count):
        for e in range(f.csr_offset[u], f.csr_offset[u + 1]):
            if bf.slope_exceeds(f.edge_max_slope[e], 8.0):
                twin_ok = any(
                    f.edge_id[e2] == f.edge_id[e]
                    and not bf.slope_exceeds(f.edge_max_slope[e2], 8.0)
                    for e2 in range(
                        f.csr_offset[f.edge_target[e]], f.csr_offset[f.edge_target[e] + 1]
                    )
                )
                if not twin_ok:
                    assert f.edge_id[e] not in field


# --------------------------------------------------------------------------- #
# Snapping (unchanged by the cost-model update)
# --------------------------------------------------------------------------- #


def _probe_points(world: rwmod.RidgeWorld) -> list[tuple[float, float]]:
    min_lon, min_lat, max_lon, max_lat = world.graph.bbox
    pts: list[tuple[float, float]] = []
    for i in range(17):
        for j in range(13):
            pts.append(
                (
                    min_lat + (max_lat - min_lat) * (i + 0.37) / 17.0,
                    min_lon + (max_lon - min_lon) * (j + 0.61) / 13.0,
                )
            )
    mid_lat = (min_lat + max_lat) / 2
    mid_lon = (min_lon + max_lon) / 2
    pts += [
        (min_lat, min_lon), (min_lat, max_lon), (max_lat, min_lon), (max_lat, max_lon),
        (min_lat, mid_lon), (max_lat, mid_lon), (mid_lat, min_lon), (mid_lat, max_lon),
    ]
    for d in (0.001, 0.05, 0.5):
        pts += [
            (min_lat - d, mid_lon), (max_lat + d, mid_lon),
            (mid_lat, min_lon - d), (mid_lat, max_lon + d),
            (min_lat - d, min_lon - d), (max_lat + d, max_lon + d),
        ]
    return pts


def test_grid_snapping_equals_brute_force_everywhere(
    flat: rr._Flat, world: rwmod.RidgeWorld
) -> None:
    for lat, lon in _probe_points(world):
        expected = rr.snap_bruteforce(flat, lat, lon)
        actual = rr.snap_grid(world.graph, flat, lat, lon)
        assert actual == expected, f"snap({lat}, {lon}) gave {actual}, expected {expected}"


def test_snapping_onto_a_node_returns_that_node(flat: rr._Flat, world: rwmod.RidgeWorld) -> None:
    for node in (0, 123, 351, world.bump_b, world.island[2]):
        assert rr.snap_grid(world.graph, flat, flat.node_lat[node], flat.node_lon[node]) == node


def test_snapping_can_return_an_island_node(flat: rr._Flat, world: rwmod.RidgeWorld) -> None:
    node = world.island[0]
    lat = flat.node_lat[node] + 1e-6
    lon = flat.node_lon[node] + 1e-6
    assert rr.snap_grid(world.graph, flat, lat, lon) in world.island
