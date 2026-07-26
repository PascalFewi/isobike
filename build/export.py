"""Export a collapsed network to R2 artefacts (build pipeline step 5).

Three outputs, mirroring the spec:

* ``graph.bin`` (format v2) -- the routing graph. Built here from the measured,
  collapsed network: OSM node ids become contiguous ids, each geometric edge
  emits its directed half-edges per the one-way flags (reverse half swaps
  ascent<->descent and the two slope directions), CSR + grid + per-edge surface.
  This is the correctness-critical, fully-tested part; it reuses ``binformat``'s
  builders so the byte layout has one source of truth.
* ``network.geojson`` -- edges with ``edge_id`` and ``surface`` properties,
  Douglas-Peucker simplified, fed to ``tippecanoe`` for ``network.pmtiles``.
* ``meta.json`` -- bbox, build metadata, format version.

``tippecanoe`` is a separate C++ tool (WSL); its invocation is a thin shell run at
pipeline time. Everything that shapes the bytes is pure and tested.
"""

from __future__ import annotations

import json
import math
from pathlib import Path
from typing import Any, Final, Sequence

import numpy as np

from build import binformat as bf
from build.dem import MeasuredNetwork
from build.geo import local_xy

#: Douglas-Peucker tolerance for the display geometry, in metres. The routing
#: graph keeps full geometry; only the PMTiles polyline is simplified.
GEOJSON_SIMPLIFY_M: Final = 20.0


# --------------------------------------------------------------------------- #
# graph.bin
# --------------------------------------------------------------------------- #


def build_graph_binary(
    net: MeasuredNetwork,
    *,
    region_id: str,
    flags: int = bf.FLAG_ONEWAYS_RESPECTED,
    target_per_cell: float = 4.0,
) -> bf.Graph:
    """Assemble a validated :class:`binformat.Graph` from a collapsed network.

    Node ids are assigned by ascending OSM id -- deterministic, so a rebuild of the
    same input is byte-identical. (Grid-cell reordering for cache locality is a
    later optimisation; the grid index already groups nodes for snapping.)
    """
    if net.edge_count == 0:
        raise ValueError("cannot export an empty network")

    # Contiguous node ids over exactly the endpoints that appear in edges.
    osm_ids = sorted({n for e in net.edges for n in (e.u, e.v)})
    id_of = {osm_id: i for i, osm_id in enumerate(osm_ids)}
    n = len(osm_ids)

    node_lat = np.array([net.node_lat[o] for o in osm_ids], dtype=np.float32)
    node_lon = np.array([net.node_lon[o] for o in osm_ids], dtype=np.float32)
    node_elev = np.array([net.node_elev[o] for o in osm_ids], dtype=np.float32)

    # Directed half-edges. Each geometric edge (eid) emits its enabled directions;
    # every kept edge is traversable at least one way (guaranteed upstream), so no
    # eid is orphaned and edge ids stay contiguous 0..G-1.
    sources: list[int] = []
    targets: list[int] = []
    edge_ids: list[int] = []
    dist: list[float] = []
    ascent: list[float] = []
    descent: list[float] = []
    slope: list[int] = []
    surface = np.empty(len(net.edges), dtype=np.uint8)

    for eid, e in enumerate(net.edges):
        surface[eid] = int(e.surface)
        u, v = id_of[e.u], id_of[e.v]
        if e.forward:
            sources.append(u); targets.append(v); edge_ids.append(eid)
            dist.append(e.dist_m); ascent.append(e.ascent_m); descent.append(e.descent_m)
            slope.append(bf.encode_max_slope(e.max_slope_pct_fwd))
        if e.backward:
            # Reverse half: ascent<->descent swap, reverse slope.
            sources.append(v); targets.append(u); edge_ids.append(eid)
            dist.append(e.dist_m); ascent.append(e.descent_m); descent.append(e.ascent_m)
            slope.append(bf.encode_max_slope(e.max_slope_pct_rev))

    if not sources:
        raise ValueError("no traversable half-edges to export")

    csr = bf.build_csr(
        node_count=n,
        sources=np.array(sources, dtype=np.int64),
        targets=np.array(targets, dtype=np.int64),
        edge_ids=np.array(edge_ids, dtype=np.int64),
        dist=np.array(dist, dtype=np.float64),
        ascent=np.array(ascent, dtype=np.float64),
        descent=np.array(descent, dtype=np.float64),
        max_slope_u8=np.array(slope, dtype=np.int64),
    )
    csr_offset, edge_target, edge_id, edge_dist, edge_ascent, edge_descent, edge_slope = csr

    # bbox from the *stored f32* coordinates so it contains them exactly.
    bbox = (
        float(node_lon.min()), float(node_lat.min()),
        float(node_lon.max()), float(node_lat.max()),
    )
    grid_nx, grid_ny = bf.choose_grid_dims(n, bbox, target_per_cell=target_per_cell)
    grid_offset, grid_nodeid = bf.build_grid_index(node_lat, node_lon, bbox, grid_nx, grid_ny)

    graph = bf.Graph(
        region_id=region_id,
        bbox=bbox,
        grid_nx=grid_nx,
        grid_ny=grid_ny,
        flags=flags,
        node_lat=node_lat,
        node_lon=node_lon,
        node_elev=node_elev,
        csr_offset=csr_offset,
        edge_target=edge_target,
        edge_id=edge_id,
        edge_dist=edge_dist,
        edge_ascent=edge_ascent,
        edge_descent=edge_descent,
        edge_max_slope=edge_slope,
        grid_offset=grid_offset,
        grid_nodeid=grid_nodeid,
        edge_surface=surface,
    )
    bf.validate_graph(graph)  # hard validation before anything is written
    return graph


# --------------------------------------------------------------------------- #
# Douglas-Peucker (display geometry only)
# --------------------------------------------------------------------------- #


def _perp_distance_m(p: tuple[float, float], a: tuple[float, float], b: tuple[float, float]) -> float:
    """Perpendicular distance (m) from point ``p`` to segment ``a-b``, locally projected."""
    lat_ref = a[0]
    px, py = local_xy(p[0], p[1], lat_ref)
    ax, ay = local_xy(a[0], a[1], lat_ref)
    bx, by = local_xy(b[0], b[1], lat_ref)
    dx, dy = bx - ax, by - ay
    seg2 = dx * dx + dy * dy
    if seg2 == 0.0:
        return math.hypot(px - ax, py - ay)
    t = ((px - ax) * dx + (py - ay) * dy) / seg2
    t = max(0.0, min(1.0, t))
    cx, cy = ax + t * dx, ay + t * dy
    return math.hypot(px - cx, py - cy)


def douglas_peucker(
    points: Sequence[tuple[float, float]], epsilon_m: float = GEOJSON_SIMPLIFY_M
) -> list[tuple[float, float]]:
    """Simplify a ``(lat, lon)`` polyline, keeping deviations under ``epsilon_m``.

    Iterative (not recursive) so a pathological long straightaway cannot blow the
    stack. Endpoints are always kept.
    """
    if len(points) <= 2:
        return list(points)

    keep = [False] * len(points)
    keep[0] = keep[-1] = True
    stack = [(0, len(points) - 1)]
    while stack:
        start, end = stack.pop()
        if end <= start + 1:
            continue
        far_i, far_d = -1, -1.0
        for i in range(start + 1, end):
            d = _perp_distance_m(points[i], points[start], points[end])
            if d > far_d:
                far_i, far_d = i, d
        if far_d > epsilon_m:
            keep[far_i] = True
            stack.append((start, far_i))
            stack.append((far_i, end))

    return [p for p, k in zip(points, keep) if k]


# --------------------------------------------------------------------------- #
# GeoJSON + meta
# --------------------------------------------------------------------------- #


def network_to_geojson(net: MeasuredNetwork, *, simplify_m: float = GEOJSON_SIMPLIFY_M) -> dict[str, Any]:
    """One LineString feature per geometric edge, with ``edge_id`` and ``surface``.

    GeoJSON coordinates are ``[lon, lat]``. ``edge_id`` is the index the effort
    field joins on; ``surface`` (the enum name) drives the client road/gravel
    toggle.
    """
    features: list[dict[str, Any]] = []
    for eid, e in enumerate(net.edges):
        simplified = douglas_peucker(e.geometry, simplify_m)
        features.append(
            {
                "type": "Feature",
                "properties": {
                    "edge_id": eid,
                    "surface": bf.Surface(int(e.surface)).name.lower(),
                    "highway": e.highway,
                },
                "geometry": {
                    "type": "LineString",
                    "coordinates": [[lon, lat] for lat, lon in simplified],
                },
            }
        )
    return {"type": "FeatureCollection", "features": features}


def build_meta(graph: bf.Graph, *, build_date: str) -> dict[str, Any]:
    """Small manifest served alongside the tiles and graph."""
    return {
        "region_id": graph.region_id,
        "format_version": graph.format_version,
        "bbox": list(graph.bbox),
        "node_count": graph.node_count,
        "geom_edge_count": graph.geom_edge_count,
        "dir_edge_count": graph.dir_edge_count,
        "build_date": build_date,
    }


def export(
    net: MeasuredNetwork,
    out_dir: Path | str,
    *,
    region_id: str,
    build_date: str,
    simplify_m: float = GEOJSON_SIMPLIFY_M,
) -> bf.Graph:
    """Write ``graph.bin``, ``network.geojson`` and ``meta.json`` to ``out_dir``.

    Returns the built graph. ``tippecanoe`` (GeoJSON -> PMTiles) and the R2 upload
    are separate steps run by the orchestrator/operator -- see ``build_graph.py``.
    ``build_date`` is passed in (not read from the clock) so a rebuild is
    reproducible and the module stays free of ambient state.
    """
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)

    graph = build_graph_binary(net, region_id=region_id)
    bf.write_graph(graph, out / "graph.bin")

    geojson = network_to_geojson(net, simplify_m=simplify_m)
    (out / "network.geojson").write_text(json.dumps(geojson), encoding="utf-8")

    meta = build_meta(graph, build_date=build_date)
    (out / "meta.json").write_text(json.dumps(meta, indent=2), encoding="utf-8")

    return graph
