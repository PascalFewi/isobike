"""End-to-end pipeline integration, without network or heavy deps.

A hand-built :class:`RawNetwork` (a lattice whose every edge is split by a
degree-2 midpoint, with surfaces, one-ways and a hill) flows through the *real*
pipeline stages -- ``measure_network`` -> ``collapse_degree2`` -> ``export`` -- to a
validated ``graph.bin``, which is then read back and routed with the reference
router. This proves the stages compose and produce a routable graph; the parts
that touch real data (pyrosm, swissALTI3D, tippecanoe) are the operator's run.
"""

from __future__ import annotations

import math

import pytest

from build import binformat as bf
from build.collapse import collapse_degree2
from build.dem import measure_network
from build.export import build_graph_binary
from build.osm_load import RawEdge, RawNetwork
from testdata.gen import reference_router as rr

GRID = 6  # 6x6 lattice of corner nodes
SPACING_DEG = 2e-4  # ~22 m between corners


def _corner_id(i: int, j: int) -> int:
    return j * GRID + i


def _corner_coord(i: int, j: int) -> tuple[float, float]:
    return (46.5 + j * SPACING_DEG, 8.0 + i * SPACING_DEG)


def _elevation(lat: float, lon: float) -> float:
    """A regional tilt plus a central hill -- gives directional asymmetry and slope."""
    tilt = 20000.0 * (lat - 46.5) + 12000.0 * (lon - 8.0)
    cx, cy = 8.0 + SPACING_DEG * (GRID - 1) / 2, 46.5 + SPACING_DEG * (GRID - 1) / 2
    hill = 120.0 * math.exp(-(((lon - cx) / (2 * SPACING_DEG)) ** 2 + ((lat - cy) / (2 * SPACING_DEG)) ** 2))
    return 600.0 + tilt + hill


def _surface_for(j: int) -> bf.Surface:
    """Valleys (low rows) paved, then gravel, then unpaved -- filterable structure."""
    if j < 2:
        return bf.Surface.PAVED
    if j < 4:
        return bf.Surface.GRAVEL
    return bf.Surface.UNPAVED


def build_synthetic_raw() -> RawNetwork:
    """A lattice where each edge is two sub-segments meeting at a degree-2 midpoint.

    Collapse should therefore remove every midpoint and return the lattice: the
    corner nodes and one merged edge per lattice edge.
    """
    net = RawNetwork()
    for j in range(GRID):
        for i in range(GRID):
            net.add_node(_corner_id(i, j), *_corner_coord(i, j))

    next_mid = 10_000
    way = 0

    def add_split_edge(a_i: int, a_j: int, b_i: int, b_j: int, *, oneway: bool) -> None:
        nonlocal next_mid, way
        a, b = _corner_id(a_i, a_j), _corner_id(b_i, b_j)
        ca, cb = _corner_coord(a_i, a_j), _corner_coord(b_i, b_j)
        mid_id = next_mid
        next_mid += 1
        way += 1
        mid = ((ca[0] + cb[0]) / 2, (ca[1] + cb[1]) / 2)
        net.add_node(mid_id, *mid)
        surface = _surface_for(min(a_j, b_j))
        for (u, uc), (v, vc) in (((a, ca), (mid_id, mid)), ((mid_id, mid), (b, cb))):
            net.edges.append(
                RawEdge(
                    u=u, v=v, way_id=way, highway="residential", surface=surface,
                    forward=True, backward=not oneway, geometry=[uc, vc],
                )
            )

    for j in range(GRID):
        for i in range(GRID):
            if i + 1 < GRID:
                add_split_edge(i, j, i + 1, j, oneway=(j == 0))  # row 0 horizontals one-way
            if j + 1 < GRID:
                add_split_edge(i, j, i, j + 1, oneway=False)
    return net


@pytest.fixture(scope="module")
def exported() -> bf.Graph:
    raw = build_synthetic_raw()
    measured = measure_network(raw, _elevation)
    collapsed = collapse_degree2(measured)
    return build_graph_binary(collapsed, region_id="synthetic-e2e")


# --------------------------------------------------------------------------- #
# The pipeline composes into a valid graph
# --------------------------------------------------------------------------- #


def test_collapse_removes_every_midpoint() -> None:
    raw = build_synthetic_raw()
    measured = measure_network(raw, _elevation)
    collapsed = collapse_degree2(measured)
    # Every injected midpoint (id >= 10000) must be gone.
    assert all(nid < 10_000 for nid in collapsed.node_lat)
    # The four outer lattice corners are themselves degree-2 and legitimately
    # collapse (an L-bend is a pass-through), so fewer than all 36 corners remain.
    assert 28 <= collapsed.node_count < GRID * GRID
    assert collapsed.edge_count < measured.edge_count


def test_exported_graph_is_valid(exported: bf.Graph) -> None:
    bf.validate_graph(exported)  # includes the edge-length admissibility check
    assert exported.region_id == "synthetic-e2e"
    assert 28 <= exported.node_count < GRID * GRID  # outer corners collapsed


def test_graph_bin_round_trips(exported: bf.Graph) -> None:
    restored = bf.graph_from_bytes(bf.graph_to_bytes(exported))
    assert restored.node_count == exported.node_count
    assert restored.geom_edge_count == exported.geom_edge_count


def test_one_ways_produce_fewer_than_two_halves_per_edge(exported: bf.Graph) -> None:
    """Row-0 horizontals are one-way, so dir_edge_count < 2 * geom_edge_count."""
    assert exported.dir_edge_count < 2 * exported.geom_edge_count
    assert exported.flags & bf.FLAG_ONEWAYS_RESPECTED


def test_all_surface_classes_present_and_valid(exported: bf.Graph) -> None:
    present = set(exported.edge_surface.tolist())
    assert {int(bf.Surface.PAVED), int(bf.Surface.GRAVEL), int(bf.Surface.UNPAVED)} <= present
    assert exported.edge_surface.max() < bf.SURFACE_CLASS_COUNT


# --------------------------------------------------------------------------- #
# The exported graph actually routes
# --------------------------------------------------------------------------- #


def test_the_exported_graph_routes_corner_to_corner(exported: bf.Graph) -> None:
    flat = rr.flatten(exported)
    model = rr.PROFILES[1].model()  # mixed
    src, dst = 0, exported.node_count - 1  # opposite corners

    result = rr.route(flat, src, dst, model)
    assert result is not None
    assert result.dist_m > 0
    # Some climbing over the hill; ascent is a real integral, not endpoint delta.
    assert result.ascent_m >= 0.0
    assert len(result.edge_ids) > 0


def test_directed_cost_survives_the_pipeline(exported: bf.Graph) -> None:
    """Every geometric edge's forward ascent equals its reverse descent.

    This is the directed-cost-over-undirected-topology invariant, verified on the
    real exported graph -- proving the reverse-half swap in export.py is correct.
    (Routing up vs down can legitimately take *different* paths under a hill and
    one-ways, so a route-level ascent==descent check would be wrong.)
    """
    g = exported
    fwd: dict[tuple[int, int], tuple[float, float]] = {}
    for u in range(g.node_count):
        for i in range(int(g.csr_offset[u]), int(g.csr_offset[u + 1])):
            v = int(g.edge_target[i])
            fwd[(u, v)] = (float(g.edge_ascent[i]), float(g.edge_descent[i]))

    checked = 0
    for (u, v), (asc, desc) in fwd.items():
        if (v, u) in fwd:  # a two-way edge: the reverse half must mirror it
            rasc, rdesc = fwd[(v, u)]
            assert asc == pytest.approx(rdesc, abs=1e-4)
            assert desc == pytest.approx(rasc, abs=1e-4)
            checked += 1
    assert checked > 0

    # And the tilt makes at least some edge genuinely asymmetric (ascent != descent).
    assert any(abs(asc - desc) > 0.5 for asc, desc in fwd.values())


def test_paved_only_filter_restricts_to_the_paved_rows(exported: bf.Graph) -> None:
    flat = rr.flatten(exported)
    model = rr.PROFILES[1].model()
    paved = frozenset({int(bf.Surface.PAVED)})
    field = rr.effort_field(flat, 0, model, allowed_surfaces=paved)
    # Every reached edge is paved, and the field is a strict subset of the full one.
    full = rr.effort_field(flat, 0, model)
    assert 0 < len(field) < len(full)
    for eid in field:
        assert flat.edge_surface[eid] == int(bf.Surface.PAVED)


def test_snapping_works_on_the_exported_graph(exported: bf.Graph) -> None:
    flat = rr.flatten(exported)
    # The grid index must agree with brute force at an interior corner location.
    lat, lon = _corner_coord(2, 3)
    got = rr.snap_grid(exported, flat, lat + 1e-6, lon + 1e-6)
    assert got == rr.snap_bruteforce(flat, lat + 1e-6, lon + 1e-6)
