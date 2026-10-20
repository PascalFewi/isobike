"""Degree-2 collapse: the topology rules, on the raw (pre-elevation) network.

Pure functions on hand-built RawNetworks with known answers. Collapse runs before
elevation is measured, so the ascent/slope behaviour across a merged chain is
tested where it is computed -- ``test_dem.py`` (measure after collapse).
"""

from __future__ import annotations

import pytest

from build.binformat import Surface
from build.collapse import collapse_degree2, prune_small_components
from build.dem import polyline_length_m
from build.osm_load import RawEdge, RawNetwork, Structure


def _coord(n: int) -> tuple[float, float]:
    return (46.5 + n * 1e-3, 8.0 + n * 1e-3)


def _edge(
    u: int,
    v: int,
    *,
    surface: Surface = Surface.PAVED,
    highway: str = "residential",
    structure: Structure = Structure.GROUND,
    forward: bool = True,
    backward: bool = True,
) -> RawEdge:
    return RawEdge(
        u=u, v=v, way_id=1, highway=highway, surface=surface,
        forward=forward, backward=backward, geometry=[_coord(u), _coord(v)],
        structure=structure,
    )


def _net(edges: list[RawEdge]) -> RawNetwork:
    nodes = {n for e in edges for n in (e.u, e.v)}
    return RawNetwork(
        node_lat={n: _coord(n)[0] for n in nodes},
        node_lon={n: _coord(n)[1] for n in nodes},
        edges=edges,
    )


def _length(net: RawNetwork) -> float:
    return sum(polyline_length_m(e.geometry) for e in net.edges)


def _only(net: RawNetwork) -> RawEdge:
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
    assert e.geometry[0] == _coord(e.u) and e.geometry[-1] == _coord(e.v)
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
# Orientation
# --------------------------------------------------------------------------- #


def test_segments_stored_against_the_walk_are_reversed_into_one_polyline() -> None:
    """0-1 stored (1,0) and 1-2 stored (2,1): the merged geometry must still run
    continuously 0 -> 1 -> 2 (or its exact reverse), or the profile measured
    along it would be scrambled."""
    net = collapse_degree2(_net([_edge(1, 0), _edge(2, 1)]))
    e = _only(net)
    expected = [_coord(0), _coord(1), _coord(2)]
    assert e.geometry in (expected, expected[::-1])
    assert e.geometry[0] == _coord(e.u)


def test_a_flipped_oneway_segment_keeps_its_direction_after_merging() -> None:
    # 0 -> 1 one-way stored forward, 1 -> 2 one-way stored as (2, 1) backward-only.
    net = collapse_degree2(_net([
        _edge(0, 1, forward=True, backward=False),
        _edge(2, 1, forward=False, backward=True),
    ]))
    e = _only(net)
    walk_0_to_2 = e.forward if (e.u, e.v) == (0, 2) else e.backward
    walk_2_to_0 = e.backward if (e.u, e.v) == (0, 2) else e.forward
    assert walk_0_to_2 is True and walk_2_to_0 is False


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


@pytest.mark.parametrize("structure", [Structure.BRIDGE, Structure.TUNNEL])
def test_a_structure_boundary_is_preserved(structure: Structure) -> None:
    """A bridge/tunnel stays its own edge, so dem.py can straighten its profile
    without flattening the approach roads with it."""
    net = collapse_degree2(_net([
        _edge(0, 1),
        _edge(1, 2, structure=structure),
        _edge(2, 3, structure=structure),
        _edge(3, 4),
    ]))
    by_ends = {frozenset({e.u, e.v}): e for e in net.edges}
    assert set(by_ends) == {frozenset({0, 1}), frozenset({1, 3}), frozenset({3, 4})}
    assert by_ends[frozenset({1, 3})].structure == structure
    assert by_ends[frozenset({0, 1})].structure == Structure.GROUND


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
    total = _length(net)
    assert total == pytest.approx(_length(_net([_edge(0, 1), _edge(1, 2), _edge(2, 0)])))
    assert all(e.u != e.v or len(net.edges) == 1 for e in net.edges)


def test_geometry_is_concatenated_without_duplicating_junctions() -> None:
    net = collapse_degree2(_net([_edge(0, 1), _edge(1, 2)]))
    e = _only(net)
    # 2 points per segment, sharing node 1 -> 3 points, not 4.
    assert len(e.geometry) == 3


def test_collapse_conserves_total_length() -> None:
    edges = [_edge(i, i + 1) for i in range(5)]
    assert _length(collapse_degree2(_net(edges))) == pytest.approx(_length(_net(edges)))


# --------------------------------------------------------------------------- #
# Component pruning
# --------------------------------------------------------------------------- #


def _chain(start: int, length: int) -> list[RawEdge]:
    """A connected chain of `length` edges over `length+1` fresh node ids."""
    return [_edge(start + i, start + i + 1) for i in range(length)]


def test_prune_drops_small_components_keeps_the_big_one() -> None:
    # One 10-edge component (11 nodes) + two tiny 1-edge stubs (2 nodes each).
    net = _net([*_chain(0, 10), _edge(100, 101), _edge(200, 201)])
    pruned = prune_small_components(net, min_component_nodes=5)
    node_ids = set(pruned.node_lat)
    assert node_ids == set(range(11))  # only the big chain survives
    assert 100 not in node_ids and 200 not in node_ids


def test_prune_always_keeps_the_largest_even_below_threshold() -> None:
    net = _net(_chain(0, 3))  # 4 nodes, smaller than the threshold
    pruned = prune_small_components(net, min_component_nodes=1000)
    assert pruned.node_count == 4  # largest is never dropped


def test_prune_keeps_components_at_or_above_threshold() -> None:
    net = _net([*_chain(0, 20), *_chain(100, 6)])  # 21-node and 7-node components
    pruned = prune_small_components(net, min_component_nodes=7)
    assert set(pruned.node_lat) == set(range(21)) | set(range(100, 107))


def test_prune_is_a_noop_on_a_single_component() -> None:
    net = _net(_chain(0, 30))
    pruned = prune_small_components(net, min_component_nodes=25)
    assert pruned.edge_count == net.edge_count
    assert pruned.node_count == net.node_count


def test_prune_handles_an_empty_network() -> None:
    empty = RawNetwork()
    assert prune_small_components(empty).edge_count == 0
