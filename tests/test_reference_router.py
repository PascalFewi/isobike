"""Correctness of the Python reference router, in Python's own terms.

This suite must pass before the reference is allowed to generate golden files.
It proves three separate things:

1. The heuristic really is admissible and consistent -- checked *directly* against
   true costs from a reverse-graph Dijkstra, not merely inferred from A* agreeing
   with Dijkstra. If both were wrong in the same direction, agreement would prove
   nothing.
2. A* reproduces Dijkstra exactly, including under slope filters.
3. The routing answers change in the ways the effort model claims they should.
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

#: (climb_factor, max_slope_pct) combinations swept by the cross-checks.
#: 6 % is included because it disconnects the ridge entirely -- the unreachable
#: branch deserves the same scrutiny as the happy path.
SWEEP = [
    (0.0, None),
    (5.0, None),
    (60.0, None),
    (200.0, None),
    (0.0, 12.0),
    (20.0, 8.0),
    (60.0, 6.0),
]


@pytest.fixture(scope="module")
def world() -> rwmod.RidgeWorld:
    return build_ridge_world()


@pytest.fixture(scope="module")
def flat(world: rwmod.RidgeWorld) -> rr._Flat:
    return rr.flatten(world.graph)


def _reverse_costs(
    f: rr._Flat, goal: int, climb_factor: float, max_slope_pct: float | None
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
            rev[f.edge_target[e]].append((u, rr.edge_weight(f, e, climb_factor)))

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


def _recompute(f: rr._Flat, result: rr.RouteResult, climb_factor: float) -> float:
    """Re-add the route's edge weights left to right, exactly as Dijkstra accumulated."""
    total = 0.0
    for u, v in zip(result.nodes, result.nodes[1:]):
        best = INF
        for e in range(f.csr_offset[u], f.csr_offset[u + 1]):
            if f.edge_target[e] == v:
                best = min(best, rr.edge_weight(f, e, climb_factor))
        total += best
    return total


# --------------------------------------------------------------------------- #
# The heuristic
# --------------------------------------------------------------------------- #


@pytest.mark.parametrize(("climb_factor", "max_slope"), SWEEP)
def test_heuristic_never_overestimates_the_true_remaining_cost(
    flat: rr._Flat, world: rwmod.RidgeWorld, climb_factor: float, max_slope: float | None
) -> None:
    """Admissibility, verified directly against true costs -- including under a filter.

    Filtering edges can only raise the true remaining cost while h stays put, so
    if h is admissible unfiltered it stays admissible filtered. This asserts that
    rather than assuming it.
    """
    for goal in (0, world.lattice_node(11, 8), world.bump_b, world.island[0]):
        true_cost = _reverse_costs(flat, goal, climb_factor, max_slope)
        for node in range(flat.node_count):
            if true_cost[node] == INF:
                continue
            h = rr.heuristic(flat, node, goal, climb_factor)
            assert h <= true_cost[node], (
                f"h({node}->{goal})={h!r} exceeds true {true_cost[node]!r} "
                f"at climb_factor={climb_factor}, max_slope={max_slope}"
            )


@pytest.mark.parametrize(("climb_factor", "max_slope"), SWEEP)
def test_heuristic_is_consistent_on_every_edge(
    flat: rr._Flat, world: rwmod.RidgeWorld, climb_factor: float, max_slope: float | None
) -> None:
    """h(u) <= w(u,v) + h(v) everywhere, which is what lets A* close nodes for good."""
    f = flat
    for goal in (0, world.lattice_node(15, 4)):
        for u in range(f.node_count):
            hu = rr.heuristic(f, u, goal, climb_factor)
            for e in range(f.csr_offset[u], f.csr_offset[u + 1]):
                if max_slope is not None and bf.slope_exceeds(f.edge_max_slope[e], max_slope):
                    continue
                v = f.edge_target[e]
                hv = rr.heuristic(f, v, goal, climb_factor)
                assert hu <= rr.edge_weight(f, e, climb_factor) + hv + 1e-9, f"{u}->{v}"


def test_heuristic_is_zero_at_the_goal(flat: rr._Flat) -> None:
    for goal in (0, 100, 356):
        assert rr.heuristic(flat, goal, goal, 50.0) == 0.0


def test_heuristic_uses_both_terms(flat: rr._Flat, world: rwmod.RidgeWorld) -> None:
    """A distance-only heuristic would be admissible but far weaker on a climb."""
    low = world.lattice_node(0, 8)
    high = max(range(flat.node_count), key=lambda n: flat.node_elev[n])
    line = haversine_m(
        flat.node_lat[low], flat.node_lon[low], flat.node_lat[high], flat.node_lon[high]
    )
    assert rr.heuristic(flat, low, high, 50.0) > line * 1.5


# --------------------------------------------------------------------------- #
# A* == Dijkstra
# --------------------------------------------------------------------------- #


def _check_source_against_astar(
    f: rr._Flat, src: int, climb_factor: float, max_slope: float | None
) -> None:
    """One Dijkstra tree for the source, then A* to every target against it.

    Deliberately not one Dijkstra per *pair*: the tree already holds the optimum
    for every target, and rerunning it N times turns an O(N) check into O(N^2)
    for no extra coverage.
    """
    cost, incoming = rr.dijkstra(f, src, climb_factor, max_slope_pct=max_slope)

    for dst in range(f.node_count):
        found = rr.astar(f, src, dst, climb_factor, max_slope_pct=max_slope)

        if cost[dst] == INF:
            assert found is None, f"A* found a route {src}->{dst} that Dijkstra did not"
            continue
        assert found is not None, f"A* missed a route {src}->{dst} that Dijkstra found"

        truth = rr.build_route(f, src, dst, cost, incoming)
        assert truth is not None

        # Bit-exact: both sum the same f32-derived doubles in the same order.
        assert found.cost == truth.cost, f"{src}->{dst}: {found.cost!r} != {truth.cost!r}"
        # Differing paths are acceptable only when genuinely equal-cost.
        if found.edge_ids != truth.edge_ids:
            assert _recompute(f, found, climb_factor) == pytest.approx(truth.cost, rel=1e-12)
        # Reconstruction must agree with the accumulated cost, or the totals lie.
        assert _recompute(f, truth, climb_factor) == pytest.approx(truth.cost, rel=1e-12)


@pytest.mark.parametrize(("climb_factor", "max_slope"), SWEEP)
def test_astar_matches_dijkstra_from_sampled_sources(
    flat: rr._Flat, climb_factor: float, max_slope: float | None
) -> None:
    """Six spread sources against every target, for each cost/filter combination.

    Sources cover a valley floor, both ridge flanks, the crest, a corner, and the
    bump spur -- the shapes where a heuristic is most likely to misbehave.
    """
    for src in (0, 87, 175, 260, 351, 352):
        _check_source_against_astar(flat, src, climb_factor, max_slope)


@pytest.mark.slow
@pytest.mark.parametrize(("climb_factor", "max_slope"), SWEEP)
def test_astar_matches_dijkstra_for_every_pair(
    flat: rr._Flat, climb_factor: float, max_slope: float | None
) -> None:
    """All 127 449 ordered pairs, per configuration. Run with `pytest -m slow`."""
    for src in range(flat.node_count):
        _check_source_against_astar(flat, src, climb_factor, max_slope)


# --------------------------------------------------------------------------- #
# Unreachability
# --------------------------------------------------------------------------- #


def test_island_is_unreachable_in_both_directions(
    flat: rr._Flat, world: rwmod.RidgeWorld
) -> None:
    for node in world.island:
        assert rr.route(flat, 0, node, 10.0) is None
        assert rr.astar(flat, 0, node, 10.0) is None
        assert rr.route(flat, node, 0, 10.0) is None


def test_routing_within_the_island_still_works(flat: rr._Flat, world: rwmod.RidgeWorld) -> None:
    """Unreachable must mean "no path", not "component is broken"."""
    a, b, _c = world.island
    result = rr.route(flat, a, b, 10.0)
    assert result is not None and result.dist_m > 0.0


def test_route_to_self_is_empty_not_none(flat: rr._Flat) -> None:
    result = rr.route(flat, 42, 42, 10.0)
    assert result is not None
    assert result.edge_ids == [] and result.cost == 0.0 and result.dist_m == 0.0


def test_slope_filter_can_disconnect(flat: rr._Flat, world: rwmod.RidgeWorld) -> None:
    """At 6 % even the pass is too steep; the ridge becomes a wall."""
    src, dst = world.lattice_node(1, 13), world.lattice_node(20, 13)
    assert rr.route(flat, src, dst, 0.0, max_slope_pct=6.0) is None
    assert rr.astar(flat, src, dst, 0.0, max_slope_pct=6.0) is None


# --------------------------------------------------------------------------- #
# Ascent is summed from stored edges, not from endpoints
# --------------------------------------------------------------------------- #


def test_route_totals_include_a_hump_with_no_net_gain(
    flat: rr._Flat, world: rwmod.RidgeWorld
) -> None:
    """The route-level counterpart of the bump-edge fixture.

    An implementation that computed route ascent as ``max(0, elev[end]-elev[start])``
    would report roughly zero here. The stored profile says otherwise.
    """
    result = rr.route(flat, world.bump_anchor, world.bump_b, 0.0)
    assert result is not None
    net_gain = max(
        0.0, flat.node_elev[world.bump_b] - flat.node_elev[world.bump_anchor]
    )
    assert result.ascent_m >= rwmod.BUMP_HEIGHT_M - 0.5
    assert result.ascent_m > net_gain + 10.0
    assert result.descent_m >= rwmod.BUMP_HEIGHT_M - 0.5


def test_route_totals_match_the_sum_of_traversed_edges(
    flat: rr._Flat, world: rwmod.RidgeWorld
) -> None:
    f = flat
    result = rr.route(f, world.lattice_node(2, 2), world.lattice_node(19, 12), 25.0)
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
    """Directed cost over undirected topology: uphill and downhill are not the same trip."""
    low, high = world.lattice_node(0, 6), world.lattice_node(9, 6)
    up = rr.route(flat, low, high, 40.0)
    down = rr.route(flat, high, low, 40.0)
    assert up is not None and down is not None
    assert up.dist_m == pytest.approx(down.dist_m, rel=1e-6)
    assert up.cost != down.cost
    assert up.ascent_m == pytest.approx(down.descent_m, abs=0.5)


# --------------------------------------------------------------------------- #
# The effort model actually trades off
# --------------------------------------------------------------------------- #


def test_climb_factor_trades_distance_for_ascent(flat: rr._Flat, world: rwmod.RidgeWorld) -> None:
    src, dst = world.lattice_node(1, 13), world.lattice_node(20, 13)
    direct = rr.route(flat, src, dst, 0.0)
    flattest = rr.route(flat, src, dst, 200.0)
    assert direct is not None and flattest is not None

    assert flattest.ascent_m < direct.ascent_m * 0.75, "high climb_factor did not avoid climbing"
    assert flattest.dist_m > direct.dist_m * 1.1, "the flatter route should be a detour"
    assert flattest.max_slope_pct < direct.max_slope_pct


def test_climb_factor_zero_is_pure_shortest_path(flat: rr._Flat, world: rwmod.RidgeWorld) -> None:
    src, dst = world.lattice_node(1, 13), world.lattice_node(20, 13)
    result = rr.route(flat, src, dst, 0.0)
    assert result is not None
    assert result.cost == pytest.approx(result.dist_m, rel=1e-12)


def test_ascent_is_monotonically_non_increasing_in_climb_factor(
    flat: rr._Flat, world: rwmod.RidgeWorld
) -> None:
    """Not a tautology: it is the property that makes the alpha slider meaningful."""
    src, dst = world.lattice_node(1, 13), world.lattice_node(20, 13)
    ascents = []
    for cf in (0.0, 5.0, 20.0, 60.0, 200.0):
        result = rr.route(flat, src, dst, cf)
        assert result is not None
        ascents.append(result.ascent_m)
    for a, b in zip(ascents, ascents[1:]):
        assert b <= a + 1e-6, f"ascent rose from {a} to {b} as climb_factor increased"


def test_tighter_slope_filter_never_makes_a_route_cheaper(
    flat: rr._Flat, world: rwmod.RidgeWorld
) -> None:
    """Removing edges can only raise cost -- the fact the heuristic relies on."""
    src, dst = world.lattice_node(1, 13), world.lattice_node(20, 13)
    previous = 0.0
    for limit in (None, 15.0, 12.0, 10.0, 8.0):
        result = rr.route(flat, src, dst, 10.0, max_slope_pct=limit)
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
    field = rr.effort_field(flat, 0, 10.0)
    g = world.graph

    island_edges = {
        int(g.edge_id[e])
        for n in world.island
        for e in range(int(g.csr_offset[n]), int(g.csr_offset[n + 1]))
    }
    assert island_edges, "island should contribute edges"
    assert island_edges.isdisjoint(field.keys())
    assert len(field) == g.geom_edge_count - len(island_edges)


def test_effort_field_cost_is_the_cheaper_endpoint(flat: rr._Flat, world: rwmod.RidgeWorld) -> None:
    """Decision D2, asserted rather than assumed."""
    f = flat
    cost, _ = rr.dijkstra(f, 0, 10.0)
    field = rr.effort_field(f, 0, 10.0)
    for u in range(f.node_count):
        for e in range(f.csr_offset[u], f.csr_offset[u + 1]):
            eid = f.edge_id[e]
            if eid in field:
                assert field[eid] == min(cost[u], cost[f.edge_target[e]])


def test_effort_field_source_edges_start_at_zero(flat: rr._Flat) -> None:
    field = rr.effort_field(flat, 0, 10.0)
    incident = {flat.edge_id[e] for e in range(flat.csr_offset[0], flat.csr_offset[1])}
    for eid in incident:
        assert field[eid] == 0.0


def test_effort_field_budget_truncates_and_is_monotone(flat: rr._Flat) -> None:
    full = rr.effort_field(flat, 0, 10.0)
    sizes = []
    for budget in (500.0, 2000.0, 10_000.0, math.inf):
        field = rr.effort_field(flat, 0, 10.0, max_cost=budget)
        assert all(c <= budget for c in field.values())
        # Truncation must not change any surviving edge's cost.
        for eid, c in field.items():
            assert c == full[eid]
        sizes.append(len(field))
    assert sizes == sorted(sizes)
    assert sizes[0] < sizes[-1]


def test_effort_field_omits_edges_the_filter_removes(flat: rr._Flat) -> None:
    field = rr.effort_field(flat, 0, 10.0, max_slope_pct=8.0)
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
# Snapping
# --------------------------------------------------------------------------- #


def _probe_points(world: rwmod.RidgeWorld) -> list[tuple[float, float]]:
    """Interior, border, corner and far-outside probes."""
    min_lon, min_lat, max_lon, max_lat = world.graph.bbox
    pts: list[tuple[float, float]] = []

    # A deterministic interior sweep, offset off the lattice to avoid exact ties.
    for i in range(17):
        for j in range(13):
            pts.append(
                (
                    min_lat + (max_lat - min_lat) * (i + 0.37) / 17.0,
                    min_lon + (max_lon - min_lon) * (j + 0.61) / 13.0,
                )
            )
    # Exactly on the bbox: corners and edge midpoints.
    mid_lat = (min_lat + max_lat) / 2
    mid_lon = (min_lon + max_lon) / 2
    pts += [
        (min_lat, min_lon), (min_lat, max_lon), (max_lat, min_lon), (max_lat, max_lon),
        (min_lat, mid_lon), (max_lat, mid_lon), (mid_lat, min_lon), (mid_lat, max_lon),
    ]
    # Outside, near and far, in every direction.
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
    """The ring search must be exact, not merely close.

    Includes points outside the bbox and inside empty cells -- 47 % of this grid is
    empty, which is what a naive fixed-radius probe gets wrong.
    """
    for lat, lon in _probe_points(world):
        expected = rr.snap_bruteforce(flat, lat, lon)
        actual = rr.snap_grid(world.graph, flat, lat, lon)
        assert actual == expected, f"snap({lat}, {lon}) gave {actual}, expected {expected}"


def test_snapping_onto_a_node_returns_that_node(flat: rr._Flat, world: rwmod.RidgeWorld) -> None:
    for node in (0, 123, 351, world.bump_b, world.island[2]):
        assert rr.snap_grid(world.graph, flat, flat.node_lat[node], flat.node_lon[node]) == node


def test_snapping_can_return_an_island_node(flat: rr._Flat, world: rwmod.RidgeWorld) -> None:
    """Snapping is nearest-node, not nearest-*routable*-node.

    Worth pinning: it means /route can legitimately snap a click onto a dead
    component and return no route. Hiding that in the snapper would be worse --
    the API should report honestly that the two ends do not connect.
    """
    node = world.island[0]
    lat = flat.node_lat[node] + 1e-6
    lon = flat.node_lon[node] + 1e-6
    assert rr.snap_grid(world.graph, flat, lat, lon) in world.island
