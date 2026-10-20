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
* ``geometry.bin`` -- per edge the full polyline with elevations, for the route
  line, GPX export and elevation chart. The Worker reads only the byte ranges of
  a route's edges from R2 (see :func:`write_geometry`).
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
from build.dem import MeasuredEdge, MeasuredNetwork
from build.geo import local_xy

#: Douglas-Peucker tolerance for the display geometry, in metres. The routing
#: graph keeps full geometry; only the PMTiles polyline is simplified.
GEOJSON_SIMPLIFY_M: Final = 20.0


# --------------------------------------------------------------------------- #
# graph.bin
# --------------------------------------------------------------------------- #


def exportable_edges(net: MeasuredNetwork) -> list[MeasuredEdge]:
    """The edges that get an ``edge_id``, in ``edge_id`` order.

    Drops degenerate zero-length edges. Two distinct OSM nodes can round onto the
    same f32 coordinate (dense junctions, duplicate-node mapping errors), giving
    an edge of zero length -- no valid direction, and it trips the admissibility
    check. Dropping it is lossless for routing: its endpoints are the same place.

    ``graph.bin``, ``network.geojson`` and ``geometry.bin`` must all number edges
    from this one list: the frontend joins the effort field to the tiles by
    ``edge_id``, so any divergence shifts every later id and paints colours onto
    unrelated roads.

    The order is a Hilbert curve over the edge midpoints, so edges that are close
    on the map get close ids. A route's edges then fall into a few contiguous id
    runs, and the Worker reads their geometry with a few R2 range requests
    instead of one per edge.
    """
    edges = [e for e in net.edges if e.dist_m > 0.0]
    if not edges:
        return edges
    mid_lat = np.array([(e.geometry[0][0] + e.geometry[-1][0]) / 2 for e in edges])
    mid_lon = np.array([(e.geometry[0][1] + e.geometry[-1][1]) / 2 for e in edges])
    order = np.argsort(hilbert_index(mid_lat, mid_lon), kind="stable")
    return [edges[i] for i in order]


#: Hilbert curve order: 2**16 cells per axis, ~5 m in Switzerland.
HILBERT_BITS: Final = 16


def hilbert_index(lat: np.ndarray, lon: np.ndarray) -> np.ndarray:
    """Position of each point along a Hilbert curve over the points' bounding box."""
    n = 1 << HILBERT_BITS
    def scale(a: np.ndarray) -> np.ndarray:
        lo, hi = float(a.min()), float(a.max())
        span = hi - lo if hi > lo else 1.0
        return np.minimum(((a - lo) / span * (n - 1)).astype(np.int64), n - 1)
    return hilbert_xy2d(scale(lon), scale(lat), n)


def hilbert_xy2d(x: np.ndarray, y: np.ndarray, n: int) -> np.ndarray:
    """Hilbert distance of integer cells ``(x, y)`` in an ``n x n`` grid (n = 2**k)."""
    x = np.asarray(x, dtype=np.int64).copy()
    y = np.asarray(y, dtype=np.int64).copy()
    d = np.zeros(len(x), dtype=np.int64)
    s = n >> 1
    while s > 0:
        rx = (x & s) > 0
        ry = (y & s) > 0
        d += s * s * ((3 * rx.astype(np.int64)) ^ ry.astype(np.int64))
        # Rotate the quadrant so the curve stays continuous (Wikipedia's xy2d).
        flip = ~ry
        swap_x = np.where(flip & rx, n - 1 - x, x)
        swap_y = np.where(flip & rx, n - 1 - y, y)
        x, y = np.where(flip, swap_y, swap_x), np.where(flip, swap_x, swap_y)
        s >>= 1
    return d


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

    edges = exportable_edges(net)
    if not edges:
        raise ValueError("no non-degenerate edges to export")

    # Contiguous node ids over exactly the endpoints that appear in edges.
    osm_ids = sorted({n for e in edges for n in (e.u, e.v)})
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
    surface = np.empty(len(edges), dtype=np.uint8)

    for eid, e in enumerate(edges):
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
    for eid, e in enumerate(exportable_edges(net)):
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


# --------------------------------------------------------------------------- #
# geometry.bin
# --------------------------------------------------------------------------- #

#: ``geometry.bin`` layout, little-endian; mirrored by ``worker/src/geometry.ts``.
#:
#:   off  size      type        field
#:     0     4      ascii       magic "VGEO"
#:     4     2      u16         format version (1)
#:     6     2      u16         header size (32)
#:     8     4      u32         edge count E (== graph.bin geom_edge_count)
#:    12     4      u32         vertex count V
#:    16    16      --          reserved (zero)
#:    32  4(E+1)    u32[E+1]    first vertex of edge e; edge e owns [off[e], off[e+1])
#:     .   12V      f32[V*3]    (lat, lon, elevation_m) per vertex, oriented u -> v
#:
#: The first and last vertex of every edge equal its endpoint nodes' f32
#: coordinates in graph.bin exactly, which is how a reader orients an edge.
GEOM_MAGIC: Final = b"VGEO"
GEOM_VERSION: Final = 1
GEOM_HEADER_SIZE: Final = 32


def edge_profile(e: MeasuredEdge, net: MeasuredNetwork) -> np.ndarray:
    """``(n, 3)`` float32 ``(lat, lon, elevation)`` for an edge, oriented u -> v.

    Measured edges carry their profile; a hand-built edge without one gets its
    geometry with elevation interpolated linearly between the two nodes.
    """
    if e.profile is not None:
        return np.asarray(e.profile, dtype=np.float32)
    g = np.asarray(e.geometry, dtype=np.float64)
    step = np.hypot(np.diff(g[:, 0]), np.diff(g[:, 1]) * math.cos(math.radians(g[0, 0])))
    frac = np.concatenate(([0.0], np.cumsum(step)))
    frac = frac / frac[-1] if frac[-1] > 0 else frac
    za, zb = net.node_elev[e.u], net.node_elev[e.v]
    return np.column_stack([g[:, 0], g[:, 1], za + (zb - za) * frac]).astype(np.float32)


def write_geometry(net: MeasuredNetwork, path: Path | str) -> int:
    """Write ``geometry.bin`` for the exportable edges, in ``edge_id`` order.

    Returns the number of vertices written.
    """
    edges = exportable_edges(net)
    profiles = [edge_profile(e, net) for e in edges]
    counts = np.fromiter((len(p) for p in profiles), np.int64, len(profiles))
    offsets = np.concatenate(([0], np.cumsum(counts))).astype(np.uint32)
    vertices = np.concatenate(profiles).astype("<f4") if profiles else np.zeros((0, 3), "<f4")
    header = bytearray(GEOM_HEADER_SIZE)
    header[0:4] = GEOM_MAGIC
    header[4:6] = GEOM_VERSION.to_bytes(2, "little")
    header[6:8] = GEOM_HEADER_SIZE.to_bytes(2, "little")
    header[8:12] = len(edges).to_bytes(4, "little")
    header[12:16] = int(offsets[-1]).to_bytes(4, "little")
    with Path(path).open("wb") as fh:
        fh.write(header)
        fh.write(offsets.astype("<u4").tobytes())
        fh.write(vertices.tobytes())
    return int(offsets[-1])


def read_geometry(path: Path | str) -> tuple[np.ndarray, np.ndarray]:
    """``(offsets u32[E+1], vertices f32[V, 3])`` -- for tests and tooling."""
    data = Path(path).read_bytes()
    if data[0:4] != GEOM_MAGIC:
        raise ValueError("not a geometry.bin")
    n_edges = int.from_bytes(data[8:12], "little")
    n_vert = int.from_bytes(data[12:16], "little")
    off = np.frombuffer(data, "<u4", n_edges + 1, GEOM_HEADER_SIZE)
    vert = np.frombuffer(data, "<f4", 3 * n_vert, GEOM_HEADER_SIZE + 4 * (n_edges + 1)).reshape(n_vert, 3)
    return off, vert


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
    """Write ``graph.bin``, ``network.geojson``, ``geometry.bin`` and ``meta.json``.

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

    write_geometry(net, out / "geometry.bin")

    meta = build_meta(graph, build_date=build_date)
    (out / "meta.json").write_text(json.dumps(meta, indent=2), encoding="utf-8")

    return graph
