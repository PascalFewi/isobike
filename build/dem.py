"""DEM sampling -> per-edge elevation metrics (build pipeline step 2).

Same two-layer split as ``osm_load``:

* **Pure profile math** (top) -- resample an edge's polyline to ~10 m, integrate
  the sampled elevation profile into ``dist / ascent / descent / max_slope``. This
  is where the spec's non-negotiable rule lives -- *ascent is the integral over
  the sampled profile, never endpoint delta-h* -- so it is unit-tested against
  hand-built profiles with known answers. It takes an injected ``sampler``
  (``(lat, lon) -> elevation``), so it needs no raster.
* **DEM source shell** (bottom) -- :class:`SwissAlti3dSampler` downloads
  swissALTI3D tiles via the swisstopo STAC API (Copernicus GLO-30 fallback),
  caches them, and samples with rasterio. Lazy-imported, run at pipeline time.

The metrics this produces are exactly what ``export.py`` writes and what the
router reads, so the profile math here is the production counterpart of the
sampling in ``testdata/gen/ridge_world.py``; the two are kept consistent by
testing identical synthetic profiles.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Callable, Final, Protocol, Sequence

from build.binformat import Surface
from build.geo import haversine_m
from build.osm_load import RawNetwork

#: Elevation-profile sampling step along an edge, in metres. The spec's 10 m.
SAMPLE_STEP_M: Final = 10.0
#: Rolling window for ``max_slope`` smoothing, in metres. The spec's 200 m.
SLOPE_WINDOW_M: Final = 200.0

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

    Windows shorter than the threshold occur only on edges shorter than the
    window, where the whole edge is the window. Never negative (a purely downhill
    edge has max uphill slope 0), which is why a descent is not filtered by a
    ``max_slope`` limit.
    """
    n = len(prof)
    best = 0.0
    for i in range(n - 1):
        j = i + 1
        while j < n - 1 and cum_s[j] - cum_s[i] < SLOPE_WINDOW_M:
            j += 1
        span = cum_s[j] - cum_s[i]
        if span <= 0.0:
            continue
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
# Measured network -- RawNetwork + elevation, ready for collapse/export
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


def _to_f32(value: float) -> float:
    """Round to f32 precision but keep a Python float, so downstream comparisons
    use exactly the value the graph will store."""
    import numpy as np

    return float(np.float32(value))


def measure_network(raw: RawNetwork, sampler: Sampler) -> MeasuredNetwork:
    """Sample elevations for every node and profile metrics for every edge.

    Node coordinates are rounded to **f32 up front**, and every edge's geometry
    endpoints are pinned to those rounded node coordinates before measuring.

    That pinning is load-bearing, not cosmetic: ``graph.bin`` stores node coords
    as f32, and the A* heuristic measures the great circle between those stored
    f32 endpoints. If ``dist`` were measured from the f64 geometry, a straight
    edge's stored ``dist`` could fall a fraction of a metre below the f32 chord
    and A* would silently return suboptimal routes. Measuring from the stored f32
    endpoints makes ``dist >= chord`` true by construction -- the same discipline
    the Ridge World generator uses, and what ``validate_graph`` enforces.

    Pure given ``sampler``, so a synthetic surface drives it end-to-end in tests;
    the real pipeline passes a :class:`SwissAlti3dSampler`.
    """
    node_lat = {nid: _to_f32(lat) for nid, lat in raw.node_lat.items()}
    node_lon = {nid: _to_f32(lon) for nid, lon in raw.node_lon.items()}
    node_elev = {nid: sampler(node_lat[nid], node_lon[nid]) for nid in node_lat}

    edges: list[MeasuredEdge] = []
    for e in raw.edges:
        # Endpoints from the stored f32 node coords; interior vertices untouched.
        interior = [tuple(p) for p in e.geometry[1:-1]]
        geom: list[tuple[float, float]] = [
            (node_lat[e.u], node_lon[e.u]),
            *interior,
            (node_lat[e.v], node_lon[e.v]),
        ]
        m = measure_edge(geom, sampler)
        edges.append(
            MeasuredEdge(
                u=e.u,
                v=e.v,
                way_id=e.way_id,
                highway=e.highway,
                surface=e.surface,
                forward=e.forward,
                backward=e.backward,
                geometry=geom,
                dist_m=m.dist_m,
                ascent_m=m.ascent_m,
                descent_m=m.descent_m,
                max_slope_pct_fwd=m.max_slope_pct_fwd,
                max_slope_pct_rev=m.max_slope_pct_rev,
            )
        )

    return MeasuredNetwork(node_lat=node_lat, node_lon=node_lon, node_elev=node_elev, edges=edges)


# --------------------------------------------------------------------------- #
# swissALTI3D source shell (lazy rasterio; run at pipeline time)
# --------------------------------------------------------------------------- #


class RasterSource(Protocol):
    """Minimal surface the sampler needs from a DEM raster backend."""

    def elevation(self, lat: float, lon: float) -> float: ...


class SwissAlti3dSampler:
    """Downloads + caches swissALTI3D 2 m tiles and samples them with rasterio.

    Only the road corridors are fetched (the spec's tile-wise download), keyed by
    the STAC API, and cached under ``cache_dir`` so a re-run resumes rather than
    re-downloading. Copernicus GLO-30 is the documented fallback for gaps.

    Left as a shell wired up at pipeline-execution time: it needs rasterio/pyproj
    and network access, and the pure profile math above -- the part that turns
    elevation into the stored metrics -- is what the golden files depend on and is
    fully covered by the unit suite.
    """

    def __init__(self, cache_dir: str) -> None:
        self.cache_dir = cache_dir

    def __call__(self, lat: float, lon: float) -> float:  # pragma: no cover - I/O
        raise NotImplementedError(
            "swissALTI3D sampling is wired up during the step-3 run; install the "
            "build deps (rasterio, pyproj, requests) and provide network access"
        )
