"""DEM sampling -> per-edge elevation metrics (build pipeline step 2).

Same two-layer split as ``osm_load``:

* **Pure profile math** (top) -- resample an edge's polyline to ~10 m, integrate
  the sampled elevation profile into ``dist / ascent / descent / max_slope``. This
  is where the spec's non-negotiable rule lives -- *ascent is the integral over
  the sampled profile, never endpoint delta-h* -- so it is unit-tested against
  hand-built profiles with known answers. It takes an injected ``sampler``
  (``(lat, lon) -> elevation``), so it needs no raster.
* **Vectorised measurement** (middle) -- :func:`measure_network` applies the same
  math to every edge at once with numpy, on the *collapsed* network (one edge per
  road between junctions; see ``collapse.py`` for why that order matters).
  Bridges and tunnels get a straight profile between their endpoints.
* **DEM source shell** (bottom) -- :class:`SwissAlti3dSampler` downloads
  swissALTI3D 2 m tiles via the swisstopo STAC API (Copernicus GLO-30 fallback),
  caches them, and samples with rasterio. Lazy-imported, run at pipeline time.

The metrics this produces are exactly what ``export.py`` writes and what the
router reads, so the profile math here is the production counterpart of the
sampling in ``testdata/gen/ridge_world.py``; the two are kept consistent by
testing identical synthetic profiles.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Final, Protocol, Sequence

import numpy as np

from build.binformat import Surface
from build.geo import haversine_m, haversine_m_array
from build.osm_load import RawNetwork, Structure

#: Elevation-profile sampling step along an edge, in metres. The spec's 10 m.
SAMPLE_STEP_M: Final = 10.0
#: Rolling window for ``max_slope`` smoothing, in metres. The spec's 200 m.
SLOPE_WINDOW_M: Final = 200.0
#: Shortest run a grade is measured over, in metres. An edge shorter than the
#: window is graded end to end, but over a few metres between two junctions a
#: 1-2 m DEM/position error reads as 25-55 % and, as a hard filter, cuts the road.
#: Dividing by at least this span keeps genuine short ramps (a 6 m rise over a
#: 40 m street still grades 12 %) and turns metre-scale noise into a few percent.
#: Only ``max_slope`` uses it; ascent/descent are summed from the profile as-is.
MIN_SLOPE_SPAN_M: Final = 50.0

#: A function returning ground elevation (m) at a WGS84 coordinate.
Sampler = Callable[[float, float], float]


@dataclass(frozen=True)
class EdgeMetrics:
    """Elevation-derived metrics for one geometric edge, forward orientation.

    ``ascent`` / ``descent`` are metres integrated over the profile. The reverse
    orientation swaps them and uses ``max_slope_rev``; ``export.py`` emits both
    directed halves from this one measurement.
    """

    dist_m: float
    ascent_m: float
    descent_m: float
    max_slope_pct_fwd: float
    max_slope_pct_rev: float


# --------------------------------------------------------------------------- #
# Resampling
# --------------------------------------------------------------------------- #


def polyline_length_m(geometry: Sequence[tuple[float, float]]) -> float:
    """Summed great-circle length of a ``(lat, lon)`` polyline."""
    total = 0.0
    for (lat_a, lon_a), (lat_b, lon_b) in zip(geometry, geometry[1:]):
        total += haversine_m(lat_a, lon_a, lat_b, lon_b)
    return total


def resample_polyline(
    geometry: Sequence[tuple[float, float]], step_m: float = SAMPLE_STEP_M
) -> tuple[list[tuple[float, float]], list[float]]:
    """Densify a polyline to ~``step_m`` spacing along the ground.

    Returns ``(points, cumulative_distances)``. Both endpoints are always present;
    interior OSM vertices are preserved *and* extra points are inserted so no gap
    exceeds ``step_m``. Interpolation is linear in lat/lon, which at a 10 m step is
    accurate to well under a millimetre.

    Preserving the original vertices matters: an edge that bends around a spur
    must keep its shape so ``dist`` stays >= the endpoint chord (A* admissibility)
    and so elevation is sampled where the road actually goes.
    """
    if len(geometry) < 2:
        raise ValueError("edge geometry needs at least two points")

    points: list[tuple[float, float]] = [tuple(geometry[0])]  # type: ignore[list-item]
    cum: list[float] = [0.0]

    for (lat_a, lon_a), (lat_b, lon_b) in zip(geometry, geometry[1:]):
        seg_len = haversine_m(lat_a, lon_a, lat_b, lon_b)
        if seg_len <= 0.0:
            continue  # duplicate vertex; skip
        n_sub = max(1, int(math.ceil(seg_len / step_m)))
        for k in range(1, n_sub + 1):
            t = k / n_sub
            points.append((lat_a + (lat_b - lat_a) * t, lon_a + (lon_b - lon_a) * t))
            cum.append(cum[-1] + seg_len * (1.0 / n_sub))

    return points, cum


# --------------------------------------------------------------------------- #
# Profile integration
# --------------------------------------------------------------------------- #


def integrate_profile(cum_dist: Sequence[float], elevations: Sequence[float]) -> EdgeMetrics:
    """Integrate a sampled elevation profile into edge metrics.

    ``ascent = sum(max(0, dh))`` over consecutive samples; ``descent`` the negative
    steps. **Never** ``max(0, elev[-1] - elev[0])`` -- an edge that climbs 14 m and
    returns to its start elevation has ``ascent == 14``, and the degree-2 collapse
    later depends on these summing rather than being recomputed from endpoints.

    ``max_slope`` is the steepest *uphill* grade over any window spanning at least
    :data:`SLOPE_WINDOW_M` (or the whole edge if shorter). Computed forward and
    reverse because slope is direction-dependent.
    """
    n = len(elevations)
    if n != len(cum_dist):
        raise ValueError("cum_dist and elevations must have equal length")
    if n < 2:
        return EdgeMetrics(0.0, 0.0, 0.0, 0.0, 0.0)

    ascent = 0.0
    descent = 0.0
    for i in range(n - 1):
        dh = elevations[i + 1] - elevations[i]
        if dh > 0.0:
            ascent += dh
        else:
            descent -= dh

    dist = cum_dist[-1]
    max_fwd = _rolling_max_uphill_pct(cum_dist, elevations)
    rev_cum = [dist - s for s in reversed(cum_dist)]
    max_rev = _rolling_max_uphill_pct(rev_cum, list(reversed(elevations)))

    return EdgeMetrics(
        dist_m=dist,
        ascent_m=ascent,
        descent_m=descent,
        max_slope_pct_fwd=max_fwd,
        max_slope_pct_rev=max_rev,
    )


def _rolling_max_uphill_pct(cum_s: Sequence[float], prof: Sequence[float]) -> float:
    """Steepest uphill grade (%) over any window spanning >= SLOPE_WINDOW_M.

    On an edge shorter than the window, the whole edge is the window, graded over
    at least :data:`MIN_SLOPE_SPAN_M` (so a 1 m rise over 2 m is 2 %, not 50 %). On a longer
    edge, a start point closer than one window to the end has no full window and
    is skipped: clamping its window to the end would grade the last few 10 m steps
    on their own -- exactly the unsmoothed noise the window exists to remove. The
    end of the edge is still covered, by the full window that finishes there.

    Never negative (a purely downhill edge has max uphill slope 0), which is why a
    descent is not filtered by a ``max_slope`` limit.
    """
    n = len(prof)
    total = cum_s[-1] - cum_s[0]
    if total < SLOPE_WINDOW_M:
        return max(0.0, (prof[-1] - prof[0]) / max(total, MIN_SLOPE_SPAN_M) * 100.0)
    best = 0.0
    for i in range(n - 1):
        j = i + 1
        while j < n - 1 and cum_s[j] - cum_s[i] < SLOPE_WINDOW_M:
            j += 1
        span = cum_s[j] - cum_s[i]
        if span < SLOPE_WINDOW_M:
            break  # this and every later start only reach a partial window
        best = max(best, (prof[j] - prof[i]) / span * 100.0)
    return best


def measure_edge(
    geometry: Sequence[tuple[float, float]],
    sampler: Sampler,
    *,
    step_m: float = SAMPLE_STEP_M,
) -> EdgeMetrics:
    """Resample an edge, sample elevation along it, and integrate the profile.

    ``sampler`` maps ``(lat, lon) -> elevation``; injecting it keeps this function
    pure and testable against a synthetic surface, while the real pipeline passes
    a :class:`SwissAlti3dSampler`.
    """
    points, cum = resample_polyline(geometry, step_m)
    elevations = [sampler(lat, lon) for lat, lon in points]
    return integrate_profile(cum, elevations)


def sample_node_elevation(lat: float, lon: float, sampler: Sampler) -> float:
    """Node elevation is a single DEM lookup at the node's coordinate."""
    return sampler(lat, lon)


# --------------------------------------------------------------------------- #
# Measured network -- collapsed RawNetwork + elevation, ready for export
# --------------------------------------------------------------------------- #


@dataclass(frozen=True)
class MeasuredEdge:
    """A geometric edge with its elevation metrics attached (forward orientation)."""

    u: int
    v: int
    way_id: int
    highway: str
    surface: Surface
    forward: bool
    backward: bool
    geometry: list[tuple[float, float]]
    dist_m: float
    ascent_m: float
    descent_m: float
    max_slope_pct_fwd: float
    max_slope_pct_rev: float


@dataclass
class MeasuredNetwork:
    """The network after DEM sampling: nodes with elevation, edges with metrics."""

    node_lat: dict[int, float]
    node_lon: dict[int, float]
    node_elev: dict[int, float]
    edges: list[MeasuredEdge]

    @property
    def node_count(self) -> int:
        return len(self.node_lat)

    @property
    def edge_count(self) -> int:
        return len(self.edges)


#: Vectorised sampler: ``(lat[], lon[]) -> elevation[]`` in metres, WGS84 degrees.
ArraySampler = Callable[[np.ndarray, np.ndarray], np.ndarray]


def as_array_sampler(sampler: Sampler) -> ArraySampler:
    """The vectorised form of ``sampler``.

    Raster samplers expose a ``sample(lat[], lon[])`` method that groups points by
    tile; a plain ``(lat, lon) -> float`` function (the synthetic surfaces in the
    tests) is looped over point by point.
    """
    vectorised = getattr(sampler, "sample", None)
    if vectorised is not None:
        return vectorised

    def loop(lat: np.ndarray, lon: np.ndarray) -> np.ndarray:
        return np.fromiter(
            (sampler(float(a), float(b)) for a, b in zip(lat, lon)),
            dtype=np.float64, count=len(lat),
        )

    return loop


@dataclass(frozen=True)
class _Profiles:
    """Every edge's resampled profile, concatenated. Edge ``e`` owns points
    ``head[e] .. last[e]`` (inclusive); ``cum`` is the along-edge distance from
    the edge's first point."""

    lat: np.ndarray
    lon: np.ndarray
    cum: np.ndarray
    head: np.ndarray
    last: np.ndarray
    dist: np.ndarray  # per edge: summed segment length, the stored ``dist``


def _resample_all(
    lat: np.ndarray, lon: np.ndarray, start: np.ndarray, step_m: float = SAMPLE_STEP_M
) -> _Profiles:
    """Vectorised :func:`resample_polyline` over many edges at once.

    ``lat``/``lon`` hold every edge's vertices back to back; edge ``e`` owns
    vertices ``start[e] .. start[e+1]-1``. Produces the same points as the
    per-edge reference: the vertices are kept, each segment gets
    ``ceil(len / step_m)`` evenly spaced points, duplicate vertices are skipped.
    """
    n_edges = len(start) - 1
    n_vert = len(lat)
    is_last = np.zeros(n_vert, dtype=bool)
    is_last[start[1:] - 1] = True
    seg = np.flatnonzero(~is_last)  # vertex k -> segment k..k+1
    seg_len = haversine_m_array(lat[seg], lon[seg], lat[seg + 1], lon[seg + 1])
    n_sub = np.where(seg_len > 0.0, np.maximum(1, np.ceil(seg_len / step_m)), 0).astype(np.int64)

    # Points emitted per vertex: its segment's n_sub, plus the edge's first point.
    count = np.zeros(n_vert, dtype=np.int64)
    count[seg] = n_sub
    is_first = np.zeros(n_vert, dtype=bool)
    is_first[start[:-1]] = True
    count += is_first

    vert = np.repeat(np.arange(n_vert), count)
    offset = np.cumsum(count) - count
    rank = np.arange(len(vert)) - offset[vert]  # 0-based index within the vertex
    sub_k = rank + 1 - is_first[vert]          # 0 = the vertex itself, else 1..n_sub
    nxt = np.minimum(vert + 1, n_vert - 1)
    n_sub_v = np.zeros(n_vert, dtype=np.int64)
    n_sub_v[seg] = n_sub
    denom = np.maximum(n_sub_v[vert], 1)
    t = sub_k / denom
    out_lat = lat[vert] + (lat[nxt] - lat[vert]) * t
    out_lon = lon[vert] + (lon[nxt] - lon[vert]) * t

    seg_len_v = np.zeros(n_vert)
    seg_len_v[seg] = seg_len
    step = np.where(sub_k > 0, seg_len_v[vert] * (1.0 / denom), 0.0)
    total = np.cumsum(step)

    per_edge = np.add.reduceat(count, start[:-1]) if n_edges else np.zeros(0, np.int64)  # >= 1 each
    head = np.cumsum(per_edge) - per_edge
    last = head + per_edge - 1
    edge_of_point = np.repeat(np.arange(n_edges), per_edge)
    cum = total - total[head][edge_of_point]
    dist = _per_edge(np.add, seg_len, np.diff(start) - 1)
    return _Profiles(out_lat, out_lon, cum, head, last, dist)


def _per_edge(ufunc: np.ufunc, values: np.ndarray, counts: np.ndarray) -> np.ndarray:
    """``ufunc.reduceat`` over consecutive runs of ``counts`` elements, one result
    per run; a run of zero elements gives 0 (``reduceat`` alone would return the
    next run's first element, or index past the end)."""
    starts = np.cumsum(counts) - counts
    padded = np.append(values, 0.0)
    out = ufunc.reduceat(padded, starts) if len(starts) else np.zeros(0)
    out[counts == 0] = 0.0
    return out


def _rolling_max_uphill_all(
    cum: np.ndarray, z: np.ndarray, head: np.ndarray, last: np.ndarray
) -> np.ndarray:
    """Vectorised :func:`_rolling_max_uphill_pct`, one value per edge.

    For every start point the window ends at the first point >= SLOPE_WINDOW_M
    further along; start points without a full window are skipped, and an edge
    shorter than the window is graded end to end. Edges are laid out on one axis
    with a 2-window gap between them so no window ever reaches the next edge.
    """
    n_edges = len(head)
    per_edge = last - head + 1
    edge_of_point = np.repeat(np.arange(n_edges), per_edge)
    axis = cum + edge_of_point * (2.0 * SLOPE_WINDOW_M) + np.repeat(
        np.cumsum(np.concatenate(([0.0], cum[last][:-1]))), per_edge
    )
    is_last = np.zeros(len(cum), dtype=bool)
    is_last[last] = True
    i = np.flatnonzero(~is_last)
    j = np.searchsorted(axis, axis[i] + SLOPE_WINDOW_M, side="left")
    j = np.minimum(j, last[edge_of_point[i]])
    span = cum[j] - cum[i]
    full = span >= SLOPE_WINDOW_M
    grade = np.where(full, (z[j] - z[i]) / np.where(full, span, 1.0) * 100.0, 0.0)
    best = _per_edge(np.maximum, grade, per_edge - 1)

    # Shorter than one window: the whole edge is the window, over at least
    # MIN_SLOPE_SPAN_M. A degenerate (single-point) edge has zero rise -> 0.
    length = cum[last]
    short = length < SLOPE_WINDOW_M
    whole = (z[last] - z[head]) / np.maximum(length, MIN_SLOPE_SPAN_M) * 100.0
    best = np.where(short, whole, best)
    return np.maximum(best, 0.0)


def _straighten_structures(
    z: np.ndarray, cum: np.ndarray, head: np.ndarray, last: np.ndarray, mask: np.ndarray
) -> None:
    """Replace the profile of each masked edge by the line between its endpoints.

    In place. A bridge's ends sit on the abutments and a tunnel's on the portals,
    i.e. on the ground, so the DEM is right there and wrong everywhere between.
    """
    edges = np.flatnonzero(mask)
    if edges.size == 0:
        return
    per_edge = last[edges] - head[edges] + 1
    idx = np.repeat(head[edges], per_edge) + (
        np.arange(per_edge.sum()) - np.repeat(np.cumsum(per_edge) - per_edge, per_edge)
    )
    h = np.repeat(head[edges], per_edge)
    t_last = np.repeat(last[edges], per_edge)
    length = cum[t_last]
    frac = np.where(length > 0.0, cum[idx] / np.where(length > 0.0, length, 1.0), 0.0)
    z[idx] = z[h] + (z[t_last] - z[h]) * frac


def _to_f32(value: float) -> float:
    """Round to f32 precision but keep a Python float, so downstream comparisons
    use exactly the value the graph will store."""
    return float(np.float32(value))


def measure_network(net: RawNetwork, sampler: Sampler) -> MeasuredNetwork:
    """Sample elevations for every node and profile metrics for every edge.

    Runs on the **collapsed** network, so each edge is a whole road between
    junctions: ascent is integrated over the full profile and the 200 m slope
    window slides across what were OSM segment joints (see ``collapse.py``).
    Bridges and tunnels get a straight profile between their endpoints.

    Vectorised: all edges are resampled into one array, the DEM is sampled in one
    call (raster samplers group the points by tile, so each tile is read once),
    and the per-edge sums and rolling windows are numpy reductions. The per-edge
    :func:`measure_edge` is the readable reference this reproduces.

    Node coordinates are rounded to **f32 up front**, and every edge's geometry
    endpoints are pinned to those rounded node coordinates before measuring.
    That pinning is load-bearing, not cosmetic: ``graph.bin`` stores node coords
    as f32, and the A* heuristic measures the great circle between those stored
    f32 endpoints. If ``dist`` were measured from the f64 geometry, a straight
    edge's stored ``dist`` could fall a fraction of a metre below the f32 chord
    and A* would silently return suboptimal routes. Measuring from the stored f32
    endpoints makes ``dist >= chord`` true by construction -- the same discipline
    the Ridge World generator uses, and what ``validate_graph`` enforces.
    """
    sample = as_array_sampler(sampler)
    node_lat = {nid: _to_f32(lat) for nid, lat in net.node_lat.items()}
    node_lon = {nid: _to_f32(lon) for nid, lon in net.node_lon.items()}
    node_ids = list(node_lat)
    elev = sample(
        np.fromiter((node_lat[n] for n in node_ids), np.float64, len(node_ids)),
        np.fromiter((node_lon[n] for n in node_ids), np.float64, len(node_ids)),
    )
    node_elev = {n: float(h) for n, h in zip(node_ids, elev)}
    if not net.edges:
        return MeasuredNetwork(node_lat, node_lon, node_elev, [])

    # Endpoints from the stored f32 node coords; interior vertices untouched.
    geoms: list[list[tuple[float, float]]] = []
    for e in net.edges:
        geoms.append([
            (node_lat[e.u], node_lon[e.u]),
            *(tuple(p) for p in e.geometry[1:-1]),
            (node_lat[e.v], node_lon[e.v]),
        ])
    sizes = np.fromiter((len(g) for g in geoms), np.int64, len(geoms))
    start = np.concatenate(([0], np.cumsum(sizes)))
    flat_lat = np.fromiter((p[0] for g in geoms for p in g), np.float64, int(start[-1]))
    flat_lon = np.fromiter((p[1] for g in geoms for p in g), np.float64, int(start[-1]))

    prof = _resample_all(flat_lat, flat_lon, start)
    z = np.asarray(sample(prof.lat, prof.lon), dtype=np.float64)
    structure = np.fromiter(
        (e.structure != Structure.GROUND for e in net.edges), bool, len(net.edges)
    )
    _straighten_structures(z, prof.cum, prof.head, prof.last, structure)

    # Ascent/descent: sums of the positive/negative steps inside each edge. Drop
    # the steps from one edge's last point to the next edge's first.
    per_edge = prof.last - prof.head + 1
    keep = np.ones(len(z) - 1, dtype=bool)
    keep[prof.last[:-1]] = False
    dz = np.diff(z)[keep]
    ascent = _per_edge(np.add, np.maximum(dz, 0.0), per_edge - 1)
    descent = _per_edge(np.add, np.maximum(-dz, 0.0), per_edge - 1)

    slope_fwd = _rolling_max_uphill_all(prof.cum, z, prof.head, prof.last)
    # Reverse: the same windows on each edge's mirrored profile.
    pos = np.arange(len(z))
    owner_head = np.repeat(prof.head, per_edge)
    owner_last = np.repeat(prof.last, per_edge)
    mirror = owner_head + owner_last - pos
    rev_cum = prof.cum[owner_last] - prof.cum[mirror]
    slope_rev = _rolling_max_uphill_all(rev_cum, z[mirror], prof.head, prof.last)

    edges = [
        MeasuredEdge(
            u=e.u, v=e.v, way_id=e.way_id, highway=e.highway, surface=e.surface,
            forward=e.forward, backward=e.backward, geometry=g,
            dist_m=float(prof.dist[i]), ascent_m=float(ascent[i]), descent_m=float(descent[i]),
            max_slope_pct_fwd=float(slope_fwd[i]), max_slope_pct_rev=float(slope_rev[i]),
        )
        for i, (e, g) in enumerate(zip(net.edges, geoms))
    ]
    return MeasuredNetwork(node_lat=node_lat, node_lon=node_lon, node_elev=node_elev, edges=edges)


# --------------------------------------------------------------------------- #
# DEM sources (lazy rasterio; run at pipeline time)
# --------------------------------------------------------------------------- #


def bilinear_sample(array: np.ndarray, row: np.ndarray, col: np.ndarray) -> np.ndarray:
    """Bilinear sample of a 2D array at fractional pixel-*centre* coordinates.

    ``row = 0`` is the centre of the first row. Coordinates are clamped to the
    array, so a point in the outer half-pixel takes the edge value. NaN cells
    propagate, which is how callers detect nodata.
    """
    height, width = array.shape
    row = np.clip(row, 0.0, height - 1.0)
    col = np.clip(col, 0.0, width - 1.0)
    r0 = np.minimum(np.floor(row).astype(np.int64), height - 1)
    c0 = np.minimum(np.floor(col).astype(np.int64), width - 1)
    r1 = np.minimum(r0 + 1, height - 1)
    c1 = np.minimum(c0 + 1, width - 1)
    fr = row - r0
    fc = col - c0
    top = array[r0, c0] + (array[r0, c1] - array[r0, c0]) * fc
    bottom = array[r1, c0] + (array[r1, c1] - array[r1, c0]) * fc
    return top + (bottom - top) * fr


def _read_tile(path: Path) -> tuple[np.ndarray, object]:
    """A raster's first band as float64 with nodata -> NaN, plus its inverse
    affine transform (map coordinates -> continuous pixel coordinates)."""
    import rasterio

    with rasterio.open(path) as ds:
        array = ds.read(1).astype(np.float64)
        if ds.nodata is not None:
            array[array == ds.nodata] = np.nan
        return array, ~ds.transform


def _sample_tile(array: np.ndarray, inv: object, x: np.ndarray, y: np.ndarray) -> np.ndarray:
    """Sample a tile at map coordinates. The inverse transform gives pixel-*edge*
    coordinates (pixel 0 spans 0..1), so subtract half a pixel for the centres."""
    a, b, c, d, e, f = inv.a, inv.b, inv.c, inv.d, inv.e, inv.f  # type: ignore[attr-defined]
    col = a * x + b * y + c - 0.5
    row = d * x + e * y + f - 0.5
    return bilinear_sample(array, row, col)


def _download(url: str, path: Path) -> bool:
    """Download ``url`` to ``path`` atomically. False on 404 (no such tile)."""
    import requests

    try:
        with requests.get(url, stream=True, timeout=120) as resp:
            if resp.status_code == 404:  # ocean tiles simply do not exist
                return False
            resp.raise_for_status()
            tmp = path.with_suffix(path.suffix + ".part")
            with tmp.open("wb") as fh:
                for chunk in resp.iter_content(chunk_size=1 << 20):
                    fh.write(chunk)
            tmp.replace(path)  # atomic: a killed download never leaves a half tile
    except requests.RequestException as exc:  # pragma: no cover - network
        raise RuntimeError(f"failed to download DEM tile {url}: {exc}") from exc
    return True


#: Copernicus GLO-30 open data on AWS (public, no auth). 1 deg x 1 deg COG tiles,
#: already in WGS84 lat/lon -- so no CRS transform, unlike swissALTI3D (LV95).
GLO30_URL: Final = (
    "https://copernicus-dem-30m.s3.amazonaws.com/"
    "Copernicus_DSM_COG_10_{ns}{lat:02d}_00_{ew}{lon:03d}_00_DEM/"
    "Copernicus_DSM_COG_10_{ns}{lat:02d}_00_{ew}{lon:03d}_00_DEM.tif"
)


def _glo30_tile_name(tile_lat: int, tile_lon: int) -> tuple[str, str]:
    """(url, local filename) for the 1 deg tile whose SW corner is (tile_lat, tile_lon)."""
    ns, lat = ("N", tile_lat) if tile_lat >= 0 else ("S", -tile_lat)
    ew, lon = ("E", tile_lon) if tile_lon >= 0 else ("W", -tile_lon)
    url = GLO30_URL.format(ns=ns, lat=lat, ew=ew, lon=lon)
    return url, url.rsplit("/", 1)[1]


class Glo30Sampler:
    """Copernicus GLO-30 (~30 m) elevation sampler -- global, small, coarse.

    Note GLO-30 is a *surface* model (DSM): it includes forest canopy and
    buildings, so a road entering a forest appears to climb 20-30 m. Inside
    Switzerland :class:`SwissAlti3dSampler` (bare-earth, 2 m) is preferred; GLO-30
    remains its fallback for the border strips swissALTI3D does not cover.

    Tiles are downloaded once to ``cache_dir`` (resumable) and kept in memory
    (~50 MB each; a country needs a handful) and bilinearly interpolated.
    No unit test: it is real network + raster I/O.
    """

    def __init__(self, cache_dir: str) -> None:
        self._cache = Path(cache_dir)
        self._cache.mkdir(parents=True, exist_ok=True)
        self._tiles: dict[tuple[int, int], tuple[np.ndarray, object] | None] = {}

    def __call__(self, lat: float, lon: float) -> float:
        return float(self.sample(np.array([lat]), np.array([lon]))[0])

    def sample(self, lat: np.ndarray, lon: np.ndarray) -> np.ndarray:
        out = np.zeros(len(lat))  # ocean / missing tile: GLO-30 leaves sea as nodata -> 0 m
        tile_lat = np.floor(lat).astype(np.int64)
        tile_lon = np.floor(lon).astype(np.int64)
        for t_lat, t_lon in np.unique(np.stack([tile_lat, tile_lon], axis=1), axis=0):
            tile = self._tile(int(t_lat), int(t_lon))
            if tile is None:
                continue
            m = (tile_lat == t_lat) & (tile_lon == t_lon)
            out[m] = _sample_tile(tile[0], tile[1], lon[m], lat[m])
        return np.nan_to_num(out, nan=0.0)

    def _tile(self, tile_lat: int, tile_lon: int):
        key = (tile_lat, tile_lon)
        if key not in self._tiles:
            url, name = _glo30_tile_name(tile_lat, tile_lon)
            path = self._cache / name
            if not path.exists():
                _download(url, path)
            self._tiles[key] = _read_tile(path) if path.exists() else None
        return self._tiles[key]


#: swisstopo STAC search endpoint and the swissALTI3D collection id.
STAC_SEARCH_URL: Final = "https://data.geo.admin.ch/api/stac/v0.9/search"
SWISSALTI3D_COLLECTION: Final = "ch.swisstopo.swissalti3d"
#: Asset suffix of the 2 m cloud-optimised GeoTIFF (LV95 / EPSG:2056).
_ALTI_2M_SUFFIX: Final = "_2_2056_5728.tif"
#: Parallel tile downloads. swisstopo serves from a CDN; this is polite and fast.
_ALTI_WORKERS: Final = 16


def _alti_tile_key(item_id: str) -> tuple[int, str]:
    """``swissalti3d_2019_2600-1199`` -> (2019, ``2600-1199``)."""
    _, year, key = item_id.split("_")
    return int(year), key


class SwissAlti3dSampler:
    """swissALTI3D 2 m bare-earth (DTM) sampler -- the CH default.

    Unlike GLO-30 it models the ground, not trees and roofs, at 2 m instead of
    30 m: slopes and ascent come out close to what a rider actually climbs.

    Tiles are 1 km x 1 km in LV95 (EPSG:2056), ~1 MB each, ~30-40 GB for all of
    Switzerland. :meth:`sample` transforms all points to LV95 once, downloads the
    missing tiles in parallel, then reads each tile exactly once and samples all
    its points -- memory stays at one tile, not the whole country. The tile list
    comes from the swisstopo STAC API and is cached per bbox; where several survey
    years exist for a tile, the newest wins. Points outside swissALTI3D coverage
    (or on nodata) fall back to ``fallback``.
    """

    def __init__(self, cache_dir: str, fallback: Glo30Sampler) -> None:
        self._cache = Path(cache_dir)
        self._cache.mkdir(parents=True, exist_ok=True)
        self._fallback = fallback

    def __call__(self, lat: float, lon: float) -> float:
        return float(self.sample(np.array([lat]), np.array([lon]))[0])

    def sample(self, lat: np.ndarray, lon: np.ndarray) -> np.ndarray:
        from pyproj import Transformer

        out = np.full(len(lat), np.nan)
        if len(lat) == 0:
            return out
        to_lv95 = Transformer.from_crs("EPSG:4326", "EPSG:2056", always_xy=True)
        x, y = to_lv95.transform(lon, lat)
        x = np.asarray(x)
        y = np.asarray(y)
        # Pad to 0.1 deg so the node pass and the profile pass of one build ask for
        # the same box and share the cached index.
        bbox = (
            math.floor(float(lon.min()) * 10) / 10, math.floor(float(lat.min()) * 10) / 10,
            math.ceil(float(lon.max()) * 10) / 10, math.ceil(float(lat.max()) * 10) / 10,
        )
        index = self._index(bbox)

        km_x = np.floor(x / 1000.0).astype(np.int64)
        km_y = np.floor(y / 1000.0).astype(np.int64)
        keys = km_x * 10_000 + km_y
        order = np.argsort(keys, kind="stable")
        uniq, first = np.unique(keys[order], return_index=True)
        bounds = np.append(first, len(order))
        names = [f"{k // 10_000}-{k % 10_000}" for k in uniq.tolist()]
        self._download_missing([index[n] for n in names if n in index])

        for t, name in enumerate(names):
            url = index.get(name)
            if url is None:
                continue  # outside swissALTI3D coverage -> fallback below
            path = self._cache / url.rsplit("/", 1)[1]
            if not path.exists():
                continue  # listed but not served (404) -> fallback below
            sel = order[bounds[t]:bounds[t + 1]]
            array, inv = _read_tile(path)
            out[sel] = _sample_tile(array, inv, x[sel], y[sel])

        missing = np.isnan(out)
        if missing.any():
            out[missing] = self._fallback.sample(lat[missing], lon[missing])
        return out

    def _index(self, bbox: tuple[float, float, float, float]) -> dict[str, str]:
        """Tile key (``2600-1199``) -> newest 2 m GeoTIFF URL, for tiles in ``bbox``.

        Cached in ``index.json`` with the bbox it was built for, and reused by any
        later build whose bbox lies inside it.
        """
        import json

        cached = self._cache / "index.json"
        if cached.exists():
            data = json.loads(cached.read_text(encoding="utf-8"))
            cb = data["bbox"]
            if cb[0] <= bbox[0] and cb[1] <= bbox[1] and cb[2] >= bbox[2] and cb[3] >= bbox[3]:
                return data["tiles"]

        import requests

        newest: dict[str, tuple[int, str]] = {}
        url: str | None = STAC_SEARCH_URL
        params: dict[str, str] | None = {
            "collections": SWISSALTI3D_COLLECTION,
            "bbox": ",".join(f"{v:.6f}" for v in bbox),
            "limit": "100",
        }
        pages = 0
        while url is not None:
            resp = requests.get(url, params=params, timeout=60)
            resp.raise_for_status()
            page = resp.json()
            for item in page["features"]:
                year, key = _alti_tile_key(item["id"])
                for asset in item["assets"].values():
                    href = asset["href"]
                    if href.endswith(_ALTI_2M_SUFFIX) and (key not in newest or year > newest[key][0]):
                        newest[key] = (year, href)
            url = next((link["href"] for link in page["links"] if link["rel"] == "next"), None)
            params = None  # the next link carries the cursor and the query
            pages += 1
            if pages % 100 == 0:
                print(f"[dem] swissALTI3D index: {pages} pages, {len(newest)} tiles", flush=True)
        tiles = {k: href for k, (_, href) in newest.items()}
        cached.write_text(json.dumps({"bbox": list(bbox), "tiles": tiles}), encoding="utf-8")
        return tiles

    def _download_missing(self, urls: list[str]) -> None:
        from concurrent.futures import ThreadPoolExecutor

        todo = [u for u in urls if not (self._cache / u.rsplit("/", 1)[1]).exists()]
        if not todo:
            return
        print(f"[dem] swissALTI3D: downloading {len(todo)} of {len(urls)} tiles", flush=True)
        done = 0
        with ThreadPoolExecutor(_ALTI_WORKERS) as pool:
            for _ in pool.map(lambda u: _download(u, self._cache / u.rsplit("/", 1)[1]), todo):
                done += 1
                if done % 1000 == 0:
                    print(f"[dem] swissALTI3D: {done}/{len(todo)} tiles", flush=True)


def make_sampler(source: str, cache_dir: str) -> Sampler:
    """Return a DEM sampler by name: ``swissalti3d`` (default) or ``glo30``."""
    glo30 = Glo30Sampler(cache_dir)
    if source == "glo30":
        return glo30
    if source == "swissalti3d":
        return SwissAlti3dSampler(str(Path(cache_dir) / "swissalti3d"), fallback=glo30)
    raise ValueError(f"unknown DEM source {source!r}; use 'swissalti3d' or 'glo30'")
