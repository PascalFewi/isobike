"""Orchestrator: region resolution + the resumable stage cache + wiring.

Driven with an injected synthetic loader and sampler, so the sequencing and
caching are tested with no pyrosm, no DEM download.
"""

from __future__ import annotations

import math

import pytest

from build import binformat as bf
from build.build_graph import REGIONS, resolve_region, run_pipeline
from build.osm_load import RawEdge, RawNetwork


def _tiny_raw() -> RawNetwork:
    """A 3x3 lattice with midpoints so collapse and export have real work."""
    net = RawNetwork()
    for j in range(3):
        for i in range(3):
            net.add_node(j * 3 + i, 46.6 + j * 2e-4, 7.6 + i * 2e-4)
    mid = 5000
    for j in range(3):
        for i in range(3):
            a = j * 3 + i
            for bi, bj in ((i + 1, j), (i, j + 1)):
                if bi < 3 and bj < 3:
                    b = bj * 3 + bi
                    ca = (net.node_lat[a], net.node_lon[a])
                    cb = (net.node_lat[b], net.node_lon[b])
                    m = ((ca[0] + cb[0]) / 2, (ca[1] + cb[1]) / 2)
                    net.add_node(mid, *m)
                    for (u, uc), (v, vc) in (((a, ca), (mid, m)), ((mid, m), (b, cb))):
                        net.edges.append(
                            RawEdge(u=u, v=v, way_id=1, highway="residential",
                                    surface=bf.Surface.PAVED, forward=True, backward=True,
                                    geometry=[uc, vc])
                        )
                    mid += 1
    return net


def _sampler(lat: float, lon: float) -> float:
    return 600.0 + 15000.0 * (lat - 46.6) + 20.0 * math.sin(lon * 500.0)


# --------------------------------------------------------------------------- #
# Region resolution
# --------------------------------------------------------------------------- #


def test_known_regions_resolve() -> None:
    assert resolve_region("switzerland").region_id == "CH"
    assert resolve_region("switzerland").bbox is None
    small = resolve_region("test-oberland")
    assert small.bbox is not None and len(small.bbox) == 4


def test_unknown_region_is_rejected() -> None:
    with pytest.raises(ValueError, match="unknown region"):
        resolve_region("atlantis")


def test_region_ids_fit_the_binary_field() -> None:
    for spec in REGIONS.values():
        assert len(spec.region_id.encode("ascii")) <= bf.REGION_ID_SIZE


# --------------------------------------------------------------------------- #
# Pipeline sequencing + resumable cache
# --------------------------------------------------------------------------- #


def test_run_pipeline_produces_a_valid_graph(tmp_path) -> None:
    region = resolve_region("test-oberland")
    graph = run_pipeline(
        region,
        build_date="2026-07-23",
        cache_dir=tmp_path / "cache",
        out_dir=tmp_path / "out",
        load_fn=_tiny_raw,
        sampler=_sampler,
    )
    bf.validate_graph(graph)
    assert graph.region_id == "test-oberland"
    assert (tmp_path / "out" / "test-oberland" / "graph.bin").exists()
    assert (tmp_path / "out" / "test-oberland" / "meta.json").exists()
    assert (tmp_path / "out" / "test-oberland" / "network.geojson").exists()
    # graph.bin re-reads.
    assert bf.read_graph(tmp_path / "out" / "test-oberland" / "graph.bin").region_id == "test-oberland"


def test_second_run_reuses_the_stage_cache(tmp_path) -> None:
    region = resolve_region("test-oberland")
    calls = {"load": 0, "sample": 0}

    def counting_load() -> RawNetwork:
        calls["load"] += 1
        return _tiny_raw()

    def counting_sampler(lat: float, lon: float) -> float:
        calls["sample"] += 1
        return _sampler(lat, lon)

    kwargs = dict(
        build_date="2026-07-23", cache_dir=tmp_path / "cache", out_dir=tmp_path / "out",
        load_fn=counting_load, sampler=counting_sampler,
    )
    run_pipeline(region, **kwargs)  # cold: both stages compute
    assert calls["load"] == 1
    assert calls["sample"] > 0

    before = dict(calls)
    run_pipeline(region, **kwargs)  # warm: both stages come from the pickle cache
    assert calls["load"] == before["load"]      # loader not called again
    assert calls["sample"] == before["sample"]  # sampler not called again


def test_force_rebuilds_ignoring_the_cache(tmp_path) -> None:
    region = resolve_region("test-oberland")
    calls = {"load": 0}

    def counting_load() -> RawNetwork:
        calls["load"] += 1
        return _tiny_raw()

    kwargs = dict(
        build_date="2026-07-23", cache_dir=tmp_path / "cache", out_dir=tmp_path / "out",
        load_fn=counting_load, sampler=_sampler,
    )
    run_pipeline(region, **kwargs)
    run_pipeline(region, force=True, **kwargs)
    assert calls["load"] == 2  # --force re-ran the loader
