"""Export: measured network -> graph.bin v2 + GeoJSON, and the geometry simplifier."""

from __future__ import annotations

import json

import dataclasses

import numpy as np
import pytest

from build import binformat as bf
from build.dem import MeasuredEdge, MeasuredNetwork
from build.export import (
    build_graph_binary,
    build_meta,
    douglas_peucker,
    export,
    network_to_geojson,
)
from build.geo import haversine_m


def _coord(n: int) -> tuple[float, float]:
    """Tight node cluster so chords stay small; distinct lat/lon per node."""
    return (46.5 + n * 1e-5, 8.0 + n * 7e-6)


def _edge(
    u: int, v: int, *, dist: float = 100.0, ascent: float = 5.0, descent: float = 2.0,
    slope_fwd: float = 6.0, slope_rev: float = 3.0, surface: bf.Surface = bf.Surface.PAVED,
    highway: str = "residential", forward: bool = True, backward: bool = True,
    geometry: list[tuple[float, float]] | None = None,
) -> MeasuredEdge:
    return MeasuredEdge(
        u=u, v=v, way_id=1, highway=highway, surface=surface, forward=forward, backward=backward,
        geometry=geometry or [_coord(u), _coord(v)],
        dist_m=dist, ascent_m=ascent, descent_m=descent,
        max_slope_pct_fwd=slope_fwd, max_slope_pct_rev=slope_rev,
    )


def _net(edges: list[MeasuredEdge]) -> MeasuredNetwork:
    """Assemble a network with geometry/dist made admissibility-consistent.

    The real pipeline measures dist from geometry, so dist >= chord always holds.
    Hand-built fixtures must respect that too or export's validation (correctly)
    rejects them -- so each edge's dist is bumped to at least its own chord.
    """
    nodes = {n for e in edges for n in (e.u, e.v)}
    consistent: list[MeasuredEdge] = []
    for e in edges:
        chord = haversine_m(*_coord(e.u), *_coord(e.v))
        consistent.append(dataclasses.replace(e, dist_m=max(e.dist_m, chord * 1.05)))
    return MeasuredNetwork(
        node_lat={n: _coord(n)[0] for n in nodes},
        node_lon={n: _coord(n)[1] for n in nodes},
        node_elev={n: 600.0 + n for n in nodes},
        edges=consistent,
    )


# --------------------------------------------------------------------------- #
# graph.bin
# --------------------------------------------------------------------------- #


def test_two_way_edge_emits_both_halves() -> None:
    graph = build_graph_binary(_net([_edge(10, 20)]), region_id="test")
    assert graph.node_count == 2
    assert graph.geom_edge_count == 1
    assert graph.dir_edge_count == 2  # both directions


def test_one_way_edge_emits_a_single_half() -> None:
    graph = build_graph_binary(_net([_edge(10, 20, forward=True, backward=False)]), region_id="test")
    assert graph.dir_edge_count == 1
    assert graph.geom_edge_count == 1
    # The one existing half goes 10->20 (contiguous ids 0->1).
    assert int(graph.edge_target[0]) == 1


def test_reverse_half_swaps_ascent_and_slope() -> None:
    graph = build_graph_binary(
        _net([_edge(10, 20, ascent=8.0, descent=3.0, slope_fwd=7.0, slope_rev=2.0)]),
        region_id="test",
    )
    # Find the forward (0->1) and reverse (1->0) halves.
    halves = {
        (int(graph.edge_target[i]),): (
            float(graph.edge_ascent[i]), float(graph.edge_descent[i]), int(graph.edge_max_slope[i])
        )
        for u in range(graph.node_count)
        for i in range(int(graph.csr_offset[u]), int(graph.csr_offset[u + 1]))
    }
    fwd = halves[(1,)]  # 0->1
    rev = halves[(0,)]  # 1->0
    assert fwd[0] == pytest.approx(8.0) and fwd[1] == pytest.approx(3.0)
    assert rev[0] == pytest.approx(3.0) and rev[1] == pytest.approx(8.0)  # swapped
    assert fwd[2] == bf.encode_max_slope(7.0)
    assert rev[2] == bf.encode_max_slope(2.0)


def test_surface_is_stored_per_geometric_edge() -> None:
    graph = build_graph_binary(
        _net([
            _edge(0, 1, surface=bf.Surface.PAVED),
            _edge(1, 2, surface=bf.Surface.GRAVEL),
            _edge(2, 3, surface=bf.Surface.UNPAVED),
        ]),
        region_id="test",
    )
    assert graph.edge_surface.shape == (3,)
    assert set(graph.edge_surface.tolist()) == {
        int(bf.Surface.PAVED), int(bf.Surface.GRAVEL), int(bf.Surface.UNPAVED)
    }


def test_exported_graph_passes_full_validation_and_round_trips() -> None:
    edges = [_edge(i, i + 1, surface=bf.Surface(1 + i % 3)) for i in range(6)]
    graph = build_graph_binary(_net(edges), region_id="mini-ch")
    bf.validate_graph(graph)
    restored = bf.graph_from_bytes(bf.graph_to_bytes(graph))
    assert restored.node_count == graph.node_count
    np.testing.assert_array_equal(restored.edge_surface, graph.edge_surface)


def test_oneways_flag_is_set() -> None:
    graph = build_graph_binary(_net([_edge(0, 1)]), region_id="test")
    assert graph.flags & bf.FLAG_ONEWAYS_RESPECTED


def test_node_ids_are_deterministic_by_osm_id() -> None:
    # OSM ids 50, 10, 30 -> sorted -> contiguous 0,1,2 for 10,30,50.
    graph = build_graph_binary(_net([_edge(50, 10), _edge(10, 30)]), region_id="test")
    a = bf.graph_to_bytes(graph)
    b = bf.graph_to_bytes(build_graph_binary(_net([_edge(50, 10), _edge(10, 30)]), region_id="test"))
    assert a == b  # reproducible


def test_export_rejects_empty_network() -> None:
    with pytest.raises(ValueError):
        build_graph_binary(_net([]) if False else MeasuredNetwork({}, {}, {}, []), region_id="x")


def test_export_drops_zero_length_edges() -> None:
    """Two distinct OSM ids on the same f32 coordinate -> a zero-length edge that
    must be dropped, not exported (it has no valid direction / trips validation)."""
    p = _coord(0)
    good = MeasuredEdge(
        u=0, v=1, way_id=1, highway="residential", surface=bf.Surface.PAVED,
        forward=True, backward=True, geometry=[_coord(0), _coord(1)],
        dist_m=100.0,  # comfortably above the chord, like a real edge
        ascent_m=1.0, descent_m=0.0, max_slope_pct_fwd=1.0, max_slope_pct_rev=1.0,
    )
    degenerate = MeasuredEdge(
        u=2, v=3, way_id=2, highway="residential", surface=bf.Surface.PAVED,
        forward=True, backward=True, geometry=[p, p], dist_m=0.0,
        ascent_m=0.0, descent_m=0.0, max_slope_pct_fwd=0.0, max_slope_pct_rev=0.0,
    )
    net = MeasuredNetwork(
        node_lat={0: _coord(0)[0], 1: _coord(1)[0], 2: p[0], 3: p[0]},
        node_lon={0: _coord(0)[1], 1: _coord(1)[1], 2: p[1], 3: p[1]},
        node_elev={n: 600.0 for n in (0, 1, 2, 3)},
        edges=[good, degenerate],
    )
    graph = build_graph_binary(net, region_id="test")
    bf.validate_graph(graph)
    assert graph.geom_edge_count == 1  # the degenerate edge is gone
    assert graph.node_count == 2  # nodes 2 and 3 vanish with it


# --------------------------------------------------------------------------- #
# Douglas-Peucker
# --------------------------------------------------------------------------- #


def test_dp_keeps_endpoints() -> None:
    pts = [(46.5, 8.0), (46.5001, 8.0), (46.5, 8.001)]
    out = douglas_peucker(pts, epsilon_m=50.0)
    assert out[0] == pts[0] and out[-1] == pts[-1]


def test_dp_drops_a_near_collinear_point() -> None:
    # Three points almost on a straight line; the middle is within tolerance.
    pts = [(46.5, 8.0), (46.5, 8.0005), (46.5, 8.001)]
    assert douglas_peucker(pts, epsilon_m=5.0) == [pts[0], pts[-1]]


def test_dp_keeps_a_real_corner() -> None:
    pts = [(46.5, 8.0), (46.51, 8.0), (46.5, 8.001)]  # sharp northward spike
    assert len(douglas_peucker(pts, epsilon_m=20.0)) == 3


def test_dp_is_iterative_on_a_long_line() -> None:
    pts = [(46.5, 8.0 + i * 1e-4) for i in range(5000)]  # would overflow a recursive DP
    out = douglas_peucker(pts, epsilon_m=1.0)
    assert out[0] == pts[0] and out[-1] == pts[-1]
    assert len(out) < len(pts)


# --------------------------------------------------------------------------- #
# GeoJSON + meta + files
# --------------------------------------------------------------------------- #


def test_geojson_has_edge_id_and_surface_per_feature() -> None:
    gj = network_to_geojson(_net([_edge(0, 1, surface=bf.Surface.GRAVEL)]))
    assert gj["type"] == "FeatureCollection"
    feat = gj["features"][0]
    assert feat["properties"]["edge_id"] == 0
    assert feat["properties"]["surface"] == "gravel"
    # GeoJSON is [lon, lat].
    lon, lat = feat["geometry"]["coordinates"][0]
    assert 8.0 <= lon < 8.01 and 46.5 <= lat < 46.51


def test_export_writes_all_three_artefacts(tmp_path) -> None:
    net = _net([_edge(i, i + 1, surface=bf.Surface(1 + i % 3)) for i in range(5)])
    graph = export(net, tmp_path, region_id="mini", build_date="2026-07-23")

    assert (tmp_path / "graph.bin").exists()
    assert (tmp_path / "network.geojson").exists()
    assert (tmp_path / "meta.json").exists()

    # graph.bin re-reads and validates.
    reread = bf.read_graph(tmp_path / "graph.bin")
    assert reread.region_id == "mini"

    meta = json.loads((tmp_path / "meta.json").read_text())
    assert meta["format_version"] == 2
    assert meta["geom_edge_count"] == graph.geom_edge_count
    assert meta["build_date"] == "2026-07-23"


def test_meta_reports_the_graph_shape() -> None:
    graph = build_graph_binary(_net([_edge(0, 1), _edge(1, 2)]), region_id="test")
    meta = build_meta(graph, build_date="2026-01-01")
    assert meta["node_count"] == 3
    assert meta["geom_edge_count"] == 2
    assert meta["bbox"] == list(graph.bbox)
