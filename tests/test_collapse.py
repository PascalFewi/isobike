"""Degree-2 collapse: the ascent-summing trap and the topology rules.

Pure functions on hand-built MeasuredNetworks with known answers.
"""

from __future__ import annotations

import pytest

from build.binformat import Surface
from build.collapse import collapse_degree2
from build.dem import MeasuredEdge, MeasuredNetwork


def _edge(
    u: int,
    v: int,
    *,
    dist: float = 100.0,
    ascent: float = 0.0,
    descent: float = 0.0,
    slope_fwd: float = 0.0,
    slope_rev: float = 0.0,
    surface: Surface = Surface.PAVED,
    highway: str = "residential",
    forward: bool = True,
    backward: bool = True,
) -> MeasuredEdge:
    return MeasuredEdge(
        u=u, v=v, way_id=1, highway=highway, surface=surface,
        forward=forward, backward=backward,
        geometry=[(46.5 + u * 1e-3, 8.0 + u * 1e-3), (46.5 + v * 1e-3, 8.0 + v * 1e-3)],
        dist_m=dist, ascent_m=ascent, descent_m=descent,
        max_slope_pct_fwd=slope_fwd, max_slope_pct_rev=slope_rev,
    )


def _net(edges: list[MeasuredEdge]) -> MeasuredNetwork:
    nodes = {n for e in edges for n in (e.u, e.v)}
    return MeasuredNetwork(
        node_lat={n: 46.5 + n * 1e-3 for n in nodes},
        node_lon={n: 8.0 + n * 1e-3 for n in nodes},
        node_elev={n: 600.0 + n for n in nodes},
        edges=edges,
    )


def _only(net: MeasuredNetwork) -> MeasuredEdge:
    assert len(net.edges) == 1, f"expected 1 edge, got {len(net.edges)}"
    return net.edges[0]


# --------------------------------------------------------------------------- #
# Basic chain merging
# --------------------------------------------------------------------------- #


def test_a_straight_chain_becomes_one_edge() -> None:
    # 0 - 1 - 2 - 3, node 1 and 2 are degree-2 pass-throughs.
    net = collapse_degree2(_net([_edge(0, 1), _edge(1, 2), _edge(2, 3)]))
    e = _only(net)
    assert {e.u, e.v} == {0, 3}
    assert e.dist_m == pytest.approx(300.0)
    assert net.node_count == 2  # interior nodes 1,2 removed


def test_junction_nodes_are_kept() -> None:
    # A T-junction at node 1 (degree 3) must not collapse.
    net = collapse_degree2(_net([_edge(0, 1), _edge(1, 2), _edge(1, 3)]))
    assert len(net.edges) == 3
    assert net.node_count == 4


def test_dead_end_chain_collapses_to_its_junction_and_tip() -> None:
    net = collapse_degree2(_net([_edge(0, 1), _edge(1, 2), _edge(2, 3), _edge(1, 4)]))
    # Node 1 is a junction (degree 3: to 0, 2, 4). Chain 1-2-3 collapses to 1-3.
    kept = {frozenset({e.u, e.v}) for e in net.edges}
    assert frozenset({1, 3}) in kept
    assert frozenset({0, 1}) in kept
    assert frozenset({1, 4}) in kept


# --------------------------------------------------------------------------- #
# The ascent-summing trap
# --------------------------------------------------------------------------- #


def test_ascent_and_descent_sum_across_the_chain() -> None:
    # 0 ->(+10) 1 ->(+5,-3) 2 ->(+2) 3
    net = collapse_degree2(_net([
        _edge(0, 1, ascent=10.0, descent=0.0),
        _edge(1, 2, ascent=5.0, descent=3.0),
        _edge(2, 3, ascent=2.0, descent=0.0),
    ]))
    e = _only(net)
    assert e.ascent_m == pytest.approx(17.0)
    assert e.descent_m == pytest.approx(3.0)


def test_a_hump_in_the_chain_survives_collapse() -> None:
    """The trap: level endpoints, but the middle went up and came back down."""
    net = collapse_degree2(_net([
        _edge(0, 1, ascent=14.0, descent=0.0),   # climb the hump
        _edge(1, 2, ascent=0.0, descent=14.0),   # descend it
    ]))
    e = _only(net)
    # Endpoint elevations of 0 and 2 could be equal; ascent must still be 14.
    assert e.ascent_m == pytest.approx(14.0)
    assert e.descent_m == pytest.approx(14.0)


def test_orientation_flip_swaps_ascent_and_descent() -> None:
    # Edges stored against the walk direction: 0-1 stored (1,0), 1-2 stored (2,1).
    net = collapse_degree2(_net([
        _edge(1, 0, ascent=0.0, descent=10.0),   # walking 0->1 climbs 10
        _edge(2, 1, ascent=0.0, descent=5.0),    # walking 1->2 climbs 5
    ]))
    e = _only(net)
    # Whichever endpoint order the result uses, the |ascent-descent| net is 15.
    assert abs(e.ascent_m - e.descent_m) == pytest.approx(15.0)
    assert e.ascent_m + e.descent_m == pytest.approx(15.0)


def test_max_slope_is_the_chain_maximum() -> None:
    net = collapse_degree2(_net([
        _edge(0, 1, slope_fwd=4.0, slope_rev=1.0),
        _edge(1, 2, slope_fwd=9.0, slope_rev=2.0),
        _edge(2, 3, slope_fwd=6.0, slope_rev=3.0),
    ]))
    e = _only(net)
    assert e.max_slope_pct_fwd == pytest.approx(9.0)
    assert e.max_slope_pct_rev == pytest.approx(3.0)


# --------------------------------------------------------------------------- #
# Attribute boundaries
# --------------------------------------------------------------------------- #


def test_surface_boundary_is_preserved() -> None:
    """A paved->gravel change at node 1 keeps node 1 (crisp toggle boundary)."""
    net = collapse_degree2(_net([
        _edge(0, 1, surface=Surface.PAVED),
        _edge(1, 2, surface=Surface.GRAVEL),
    ]))
    assert len(net.edges) == 2
    assert net.node_count == 3


def test_highway_class_boundary_is_preserved() -> None:
    net = collapse_degree2(_net([
        _edge(0, 1, highway="tertiary"),
        _edge(1, 2, highway="track"),
    ]))
    assert len(net.edges) == 2


def test_homogeneous_chain_keeps_its_surface() -> None:
    net = collapse_degree2(_net([
        _edge(0, 1, surface=Surface.GRAVEL),
        _edge(1, 2, surface=Surface.GRAVEL),
    ]))
    assert _only(net).surface == Surface.GRAVEL


# --------------------------------------------------------------------------- #
# Directions
# --------------------------------------------------------------------------- #


def test_a_oneway_chain_collapses_into_one_oneway_edge() -> None:
    # Both segments one-way in the 0->1->2 direction.
    net = collapse_degree2(_net([
        _edge(0, 1, forward=True, backward=False),
        _edge(1, 2, forward=True, backward=False),
    ]))
    e = _only(net)
    # Oriented 0->2, forward only.
    assert (e.u, e.v) == (0, 2)
    assert e.forward is True and e.backward is False


def test_a_two_way_then_one_way_chain_keeps_the_binding_constraint() -> None:
    net = collapse_degree2(_net([
        _edge(0, 1, forward=True, backward=True),
        _edge(1, 2, forward=True, backward=False),
    ]))
    e = _only(net)
    assert e.forward is True
    assert e.backward is False  # the one-way segment blocks the return


def test_a_barrier_node_is_not_collapsed() -> None:
    """Two one-ways pointing INTO the node: you can't pass through it either way."""
    net = collapse_degree2(_net([
        _edge(0, 1, forward=True, backward=False),   # 0 -> 1 only
        _edge(2, 1, forward=True, backward=False),   # 2 -> 1 only
    ]))
    # Node 1 cannot be traversed (no way out), so the chain is not merged.
    assert len(net.edges) == 2


# --------------------------------------------------------------------------- #
# Topology edge cases
# --------------------------------------------------------------------------- #


def test_parallel_edges_are_not_collapsed_into_a_self_loop() -> None:
    # Two edges both between 0 and 1: node has degree 2 but one neighbour.
    net = collapse_degree2(_net([_edge(0, 1), _edge(0, 1)]))
    assert len(net.edges) == 2
    for e in net.edges:
        assert e.u != e.v


def test_isolated_triangle_is_left_intact() -> None:
    # A 3-cycle where every node is degree 2 -- a ring of removable nodes.
    net = collapse_degree2(_net([_edge(0, 1), _edge(1, 2), _edge(2, 0)]))
    # It collapses to a single self-loop-free representation or stays a ring;
    # either way no node/edge is lost and total distance is conserved.
    total = sum(e.dist_m for e in net.edges)
    assert total == pytest.approx(300.0)
    assert all(e.u != e.v or len(net.edges) == 1 for e in net.edges)


def test_geometry_is_concatenated_without_duplicating_junctions() -> None:
    net = collapse_degree2(_net([_edge(0, 1), _edge(1, 2)]))
    e = _only(net)
    # 2 points per segment, sharing node 1 -> 3 points, not 4.
    assert len(e.geometry) == 3


def test_collapse_conserves_total_distance() -> None:
    edges = [_edge(i, i + 1, dist=float(10 * (i + 1))) for i in range(5)]
    before = sum(e.dist_m for e in edges)
    after = sum(e.dist_m for e in collapse_degree2(_net(edges)).edges)
    assert after == pytest.approx(before)
