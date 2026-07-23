"""Invariants the Ridge World fixture must hold before it can serve as ground truth.

If any of these fail, every downstream cross-language assertion is meaningless --
so these run first and are deliberately blunt.
"""

from __future__ import annotations

from collections import deque

import numpy as np
import pytest

from build import binformat as bf
from testdata.gen import ridge_world as rwmod
from testdata.gen.ridge_world import build_ridge_world

EXPECTED_NODES = 357
EXPECTED_GEOM_EDGES = 671
EXPECTED_DIR_EDGES = 2 * EXPECTED_GEOM_EDGES


@pytest.fixture(scope="module")
def world() -> rwmod.RidgeWorld:
    return build_ridge_world()


def _half_edges(g: bf.Graph, u: int) -> list[tuple[int, int, float, float, float, int]]:
    """(target, edge_id, dist, ascent, descent, slope_u8) for node ``u``."""
    return [
        (
            int(g.edge_target[i]),
            int(g.edge_id[i]),
            float(g.edge_dist[i]),
            float(g.edge_ascent[i]),
            float(g.edge_descent[i]),
            int(g.edge_max_slope[i]),
        )
        for i in range(int(g.csr_offset[u]), int(g.csr_offset[u + 1]))
    ]


def _component(g: bf.Graph, start: int) -> set[int]:
    seen = {start}
    queue = deque([start])
    while queue:
        u = queue.popleft()
        for i in range(int(g.csr_offset[u]), int(g.csr_offset[u + 1])):
            v = int(g.edge_target[i])
            if v not in seen:
                seen.add(v)
                queue.append(v)
    return seen


# --------------------------------------------------------------------------- #
# Determinism and shape
# --------------------------------------------------------------------------- #


def test_generation_is_deterministic() -> None:
    """No RNG, no clock, no I/O -- two builds must serialise to identical bytes."""
    assert bf.graph_to_bytes(build_ridge_world().graph) == bf.graph_to_bytes(
        build_ridge_world().graph
    )


def test_counts(world: rwmod.RidgeWorld) -> None:
    g = world.graph
    assert g.node_count == EXPECTED_NODES
    assert g.geom_edge_count == EXPECTED_GEOM_EDGES
    assert g.dir_edge_count == EXPECTED_DIR_EDGES
    assert g.node_count == rwmod.LATTICE_NX * rwmod.LATTICE_NY + 2 + 3


def test_passes_full_validation(world: rwmod.RidgeWorld) -> None:
    bf.validate_graph(world.graph)


def test_survives_a_serialisation_round_trip(world: rwmod.RidgeWorld) -> None:
    restored = bf.graph_from_bytes(bf.graph_to_bytes(world.graph))
    for field in (s.name for s in bf._SECTION_SPECS):
        np.testing.assert_array_equal(
            getattr(restored, field), getattr(world.graph, field), err_msg=field
        )


def test_no_nan_anywhere(world: rwmod.RidgeWorld) -> None:
    g = world.graph
    for field in ("node_lat", "node_lon", "node_elev", "edge_dist", "edge_ascent", "edge_descent"):
        assert np.isfinite(getattr(g, field)).all(), field


def test_elevation_span_is_the_designed_relief(world: rwmod.RidgeWorld) -> None:
    elev = world.graph.node_elev
    assert 595.0 < float(elev.min()) < 610.0
    assert 870.0 < float(elev.max()) < 910.0
    assert float(elev.max()) - float(elev.min()) > 250.0


# --------------------------------------------------------------------------- #
# Directed cost over undirected topology
# --------------------------------------------------------------------------- #


def test_every_geometric_edge_has_exactly_two_halves(world: rwmod.RidgeWorld) -> None:
    g = world.graph
    by_id: dict[int, list[tuple[int, int]]] = {}
    for u in range(g.node_count):
        for t, eid, *_ in _half_edges(g, u):
            by_id.setdefault(eid, []).append((u, t))
    assert len(by_id) == EXPECTED_GEOM_EDGES
    for eid, halves in by_id.items():
        assert len(halves) == 2, f"edge_id {eid} has {len(halves)} halves"
        (u1, v1), (u2, v2) = halves
        assert (u1, v1) == (v2, u2)


def test_reverse_half_swaps_ascent_and_descent(world: rwmod.RidgeWorld) -> None:
    g = world.graph
    fwd: dict[tuple[int, int], tuple[float, float, float]] = {}
    for u in range(g.node_count):
        for t, _eid, d, a, de, _s in _half_edges(g, u):
            fwd[(u, t)] = (d, a, de)
    for (u, v), (d, a, de) in fwd.items():
        rd, ra, rde = fwd[(v, u)]
        assert rd == d, f"dist differs between halves of {u}<->{v}"
        assert ra == de and rde == a, f"ascent/descent not mirrored on {u}<->{v}"


def test_ascent_minus_descent_telescopes_to_delta_h(world: rwmod.RidgeWorld) -> None:
    g = world.graph
    for u in range(g.node_count):
        for v, _eid, _d, a, de, _s in _half_edges(g, u):
            delta = float(g.node_elev[v]) - float(g.node_elev[u])
            assert (a - de) == pytest.approx(delta, abs=0.05), f"{u}->{v}"


def test_forward_and_reverse_max_slope_differ_on_most_edges(world: rwmod.RidgeWorld) -> None:
    """max_slope is uphill in the direction of travel, so the halves are not mirrors."""
    g = world.graph
    slope: dict[tuple[int, int], int] = {}
    for u in range(g.node_count):
        for t, _eid, _d, _a, _de, s in _half_edges(g, u):
            slope[(u, t)] = s
    differing = sum(1 for (u, v), s in slope.items() if s != slope[(v, u)])
    assert differing > 0.5 * len(slope), f"only {differing}/{len(slope)} halves differ"


def test_a_pure_descent_is_not_filtered_as_steep(world: rwmod.RidgeWorld) -> None:
    """The reason max_slope stores uphill only: a 15 % descent must stay rideable."""
    g = world.graph
    found = False
    for u in range(g.node_count):
        for v, _eid, _d, a, de, s in _half_edges(g, u):
            if de > 20.0 and a < 0.5:  # steeply and monotonically downhill
                found = True
                assert not bf.slope_exceeds(s, 8.0), f"descent {u}->{v} filtered at 8 %"
    assert found, "fixture has no steeply-descending edge to check"


# --------------------------------------------------------------------------- #
# Ascent is an integral, not an endpoint difference
# --------------------------------------------------------------------------- #


def test_bump_edge_has_zero_delta_h_but_real_ascent(world: rwmod.RidgeWorld) -> None:
    """The fixture that fails loudly for anyone who collapses ascent to endpoints."""
    g = world.graph
    a, b = world.bump_a, world.bump_b

    assert float(g.node_elev[a]) == float(g.node_elev[b])

    for v, _eid, dist, ascent, descent, _s in _half_edges(g, a):
        if v == b:
            assert ascent == pytest.approx(rwmod.BUMP_HEIGHT_M, abs=0.1)
            assert descent == pytest.approx(rwmod.BUMP_HEIGHT_M, abs=0.1)
            assert dist == pytest.approx(170.0, abs=1.0)
            return
    pytest.fail("bump edge not found")


def test_terrain_produces_non_monotonic_profiles_on_its_own(world: rwmod.RidgeWorld) -> None:
    """Crest-straddling edges climb then descend; the bump edge is not the only case."""
    g = world.graph
    # ~16 geometric edges straddle the crest, so ~32 half-edges climb then fall by
    # more than half a metre. The bump spur contributes only 2 of them.
    both = int(((g.edge_ascent > 0.5) & (g.edge_descent > 0.5)).sum())
    assert both > 20, f"only {both} edges have a non-monotonic profile"


def test_ascent_exceeds_endpoint_gain_somewhere_substantial(world: rwmod.RidgeWorld) -> None:
    """Quantifies the error an endpoint-delta-h implementation would make."""
    g = world.graph
    worst = 0.0
    for u in range(g.node_count):
        for v, _eid, _d, a, _de, _s in _half_edges(g, u):
            gain = max(0.0, float(g.node_elev[v]) - float(g.node_elev[u]))
            worst = max(worst, a - gain)
    assert worst > 10.0, f"endpoint delta-h would understate ascent by only {worst:.1f} m"


# --------------------------------------------------------------------------- #
# Connectivity
# --------------------------------------------------------------------------- #


def test_island_is_isolated_and_internally_connected(world: rwmod.RidgeWorld) -> None:
    g = world.graph
    main = _component(g, 0)
    island = set(world.island)

    assert len(main) == g.node_count - len(island)
    assert main.isdisjoint(island)
    assert _component(g, world.island[0]) == island


def test_bump_spur_is_reachable_from_the_lattice(world: rwmod.RidgeWorld) -> None:
    main = _component(world.graph, 0)
    assert world.bump_a in main and world.bump_b in main


def test_bump_b_is_a_leaf_so_the_bump_cannot_be_bypassed(world: rwmod.RidgeWorld) -> None:
    """Route totals to bump_b must include the hump; there is no other way in."""
    neighbours = [v for v, *_ in _half_edges(world.graph, world.bump_b)]
    assert neighbours == [world.bump_a]


# --------------------------------------------------------------------------- #
# Terrain design
# --------------------------------------------------------------------------- #


def test_the_pass_is_materially_lower_than_the_ridge(world: rwmod.RidgeWorld) -> None:
    """Without this the climb_factor slider has nothing to trade off against."""
    at_pass = rwmod.ridge_amplitude(rwmod.PASS_Y_M)
    away = rwmod.ridge_amplitude(0.0)
    assert at_pass == pytest.approx(110.0, abs=1.0)
    assert away == pytest.approx(260.0, abs=1.0)
    assert away - at_pass > 100.0


def test_slope_distribution_spans_the_useful_filter_range(world: rwmod.RidgeWorld) -> None:
    """Filters at 6/10/15 % must each remove a distinct, non-trivial slice."""
    pct = world.graph.edge_max_slope.astype(np.float64) * bf.SLOPE_STEP_PCT
    for limit in (6.0, 10.0, 15.0):
        blocked = float((pct > limit).mean())
        assert 0.01 < blocked < 0.5, f"{limit} % blocks {blocked:.1%} of half-edges"
    assert float(pct.max()) > 20.0


def test_lattice_spacing_is_jittered_so_paths_do_not_tie() -> None:
    """A linear jitter yields only two distinct spacings; a quadratic yields many.

    Ties are survivable -- both routers break them on node id -- but a fixture full
    of them would make the path-equality assertion test the tie-break rather than
    the routing.
    """
    for name, fn, count in (
        ("column", rwmod.lattice_x, rwmod.LATTICE_NX),
        ("row", rwmod.lattice_y, rwmod.LATTICE_NY),
    ):
        pos = [fn(i) for i in range(count)]
        steps = {round(b - a, 6) for a, b in zip(pos, pos[1:])}
        assert len(steps) >= count - 3, f"{name} spacing has only {len(steps)} distinct steps"
        assert min(steps) > 0.0, f"{name} positions must stay strictly increasing"


# --------------------------------------------------------------------------- #
# Spatial index
# --------------------------------------------------------------------------- #


def test_grid_has_substantial_holes(world: rwmod.RidgeWorld) -> None:
    """Ring expansion must be forced to cross empty cells, as it is nationwide."""
    counts = np.diff(world.graph.grid_offset.astype(np.int64))
    empty = float((counts == 0).mean())
    assert 0.25 < empty < 0.85, f"{empty:.0%} of cells are empty"


def test_bbox_hugs_the_stored_coordinates(world: rwmod.RidgeWorld) -> None:
    g = world.graph
    min_lon, min_lat, max_lon, max_lat = g.bbox
    assert float(g.node_lon.min()) == min_lon
    assert float(g.node_lat.min()) == min_lat
    assert float(g.node_lon.max()) == max_lon
    assert float(g.node_lat.max()) == max_lat


def test_every_node_appears_in_exactly_one_cell(world: rwmod.RidgeWorld) -> None:
    g = world.graph
    assert sorted(g.grid_nodeid.tolist()) == list(range(g.node_count))
    assert int(g.grid_offset[g.cell_count]) == g.node_count
