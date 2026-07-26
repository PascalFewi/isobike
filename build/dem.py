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
from pathlib import Path
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
# DEM sources (lazy rasterio; run at pipeline time)
# --------------------------------------------------------------------------- #


class RasterSource(Protocol):
    """Minimal surface the sampler needs from a DEM raster backend."""

    def elevation(self, lat: float, lon: float) -> float: ...


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
    """Copernicus GLO-30 (~30 m) elevation sampler -- the default DEM.

    Small and global: for the 10 m along-edge sampling and 200 m slope window we
    use, 30 m is ample, and a country fits in a handful of ~30 MB tiles instead of
    swissALTI3D's ~40 GB. Tiles are downloaded once to ``cache_dir`` (resumable)
    and bilinearly interpolated, so ascent profiles stay smooth rather than
    stair-stepping on pixel edges.

    No unit test: it is real network + raster I/O. The pure math that turns its
    output into the stored metrics is covered above.
    """

    def __init__(self, cache_dir: str) -> None:
        self._cache = Path(cache_dir)
        self._cache.mkdir(parents=True, exist_ok=True)
        # (tile_lat, tile_lon) -> (array, inverse_transform, height, width) or None.
        self._tiles: dict[tuple[int, int], tuple[object, object, int, int] | None] = {}

    def __call__(self, lat: float, lon: float) -> float:
        tile = self._tile(math.floor(lat), math.floor(lon))
        if tile is None:
            # Ocean / missing tile: GLO-30 leaves sea as nodata. Treat as 0 m.
            return 0.0
        array, inv, height, width = tile
        col, row = inv * (lon, lat)  # type: ignore[operator]
        return _bilinear(array, row, col, height, width)

    def _tile(self, tile_lat: int, tile_lon: int):
        key = (tile_lat, tile_lon)
        if key in self._tiles:
            return self._tiles[key]

        import numpy as np
        import rasterio

        url, name = _glo30_tile_name(tile_lat, tile_lon)
        path = self._cache / name
        if not path.exists():
            self._download(url, path)
        if not path.exists():  # download failed (e.g. ocean tile 404)
            self._tiles[key] = None
            return None

        with rasterio.open(path) as ds:
            array = ds.read(1).astype(np.float32)
            nodata = ds.nodata
            if nodata is not None:
                array[array == nodata] = 0.0
            inv = ~ds.transform
            height, width = ds.height, ds.width
        self._tiles[key] = (array, inv, height, width)
        return self._tiles[key]

    def _download(self, url: str, path: Path) -> None:
        import requests

        try:
            with requests.get(url, stream=True, timeout=120) as resp:
                if resp.status_code == 404:  # ocean tiles simply do not exist
                    return
                resp.raise_for_status()
                tmp = path.with_suffix(path.suffix + ".part")
                with tmp.open("wb") as fh:
                    for chunk in resp.iter_content(chunk_size=1 << 20):
                        fh.write(chunk)
                tmp.replace(path)  # atomic: a killed download never leaves a half tile
        except requests.RequestException as exc:  # pragma: no cover - network
            raise RuntimeError(f"failed to download DEM tile {url}: {exc}") from exc


def _bilinear(array: object, row: float, col: float, height: int, width: int) -> float:
    """Bilinear sample of a 2D array at fractional (row, col), clamped to bounds."""
    r0 = min(max(int(math.floor(row)), 0), height - 1)
    c0 = min(max(int(math.floor(col)), 0), width - 1)
    r1 = min(r0 + 1, height - 1)
    c1 = min(c0 + 1, width - 1)
    fr = row - r0
    fc = col - c0
    a = array  # type: ignore[assignment]
    v00 = float(a[r0, c0]); v01 = float(a[r0, c1])  # type: ignore[index]
    v10 = float(a[r1, c0]); v11 = float(a[r1, c1])  # type: ignore[index]
    top = v00 + (v01 - v00) * fc
    bottom = v10 + (v11 - v10) * fc
    return top + (bottom - top) * fr


class SwissAlti3dSampler:
    """swissALTI3D 2 m sampler -- an opt-in upgrade over GLO-30 for finer slopes.

    Downloads swissALTI3D tiles for the road corridors via the swisstopo STAC API
    (CH only; LV95/EPSG:2056, so it needs a pyproj transform to WGS84) and samples
    with rasterio. Left as a shell: it is CH-specific, ~40 GB, and only worth it if
    the coarser GLO-30 slopes prove insufficient. GLO-30 is the default.
    """

    def __init__(self, cache_dir: str) -> None:
        self.cache_dir = cache_dir

    def __call__(self, lat: float, lon: float) -> float:  # pragma: no cover - opt-in I/O
        raise NotImplementedError(
            "swissALTI3D is an opt-in upgrade; GLO-30 is the default DEM. Wire up "
            "the swisstopo STAC download here if 30 m slopes prove insufficient."
        )


def make_sampler(source: str, cache_dir: str) -> Sampler:
    """Return a DEM sampler by name. ``glo30`` (default) or ``swissalti3d``."""
    if source == "glo30":
        return Glo30Sampler(cache_dir)
    if source == "swissalti3d":
        return SwissAlti3dSampler(cache_dir)
    raise ValueError(f"unknown DEM source {source!r}; use 'glo30' or 'swissalti3d'")
