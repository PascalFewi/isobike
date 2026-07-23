"""Ridge World -- the synthetic fixture the Python and TypeScript routers agree on.

Everything here is analytic and deterministic: no RNG, no wall-clock, no I/O. Run
it twice and you get byte-identical output, which is what lets the golden files be
asserted with ``==`` rather than a tolerance.

What the terrain is for
=======================

A jittered lattice over a north-south ridge with a **pass** notched into it::

        elevation                     ridge crest ~902 m
             ^                       .-''-.
             |                     .'      `.
             |      pass ~750 m  .'          `.
             |         ....___.-'              `-.___
             +--------------------------------------------> x (west to east)

* The ridge flanks reach ~18.6 % while the pass tops out near 8 %, so a
  ``max_slope`` filter genuinely reroutes rather than merely trimming edges.
* Crossing at your own latitude is short and steep; detouring to the pass is long
  and flat. ``climb_factor`` therefore changes the *shape* of the answer, which is
  the property the effort model exists to express.
* A gentle 1.2 %/km regional tilt to the north means almost every edge has a
  different cost forwards and backwards -- directed cost over undirected topology
  is exercised by the whole graph, not by one contrived edge.

Injected fixtures
=================

Three things terrain alone will not reliably produce, appended after the lattice:

``bump spur`` (nodes :attr:`RidgeWorld.bump_a` / :attr:`~RidgeWorld.bump_b`)
    Two nodes at *exactly* equal elevation joined by an edge whose sampled profile
    rises and falls ~14 m. Endpoint delta-h is 0 while ascent is not. Any
    implementation that derives ascent from endpoints -- in sampling, in the
    degree-2 collapse, or in the router's route totals -- reports 0 here and fails.

``island`` (:attr:`RidgeWorld.island`)
    A triangle of three mutually connected nodes with no edge to the lattice.
    Covers unreachable routes and effort-field truncation. Deliberately placed
    *inside* the bbox and interleaved with lattice nodes, because an island parked
    outside the data would not test snapping honestly.

``lattice jitter``
    Node spacing varies by an integer-derived offset rather than being uniform.
    A perfectly regular lattice produces symmetric, exactly-tied paths; ties are
    resolvable (both routers break them on node id) but they make a path-equality
    assertion test the tie-break rather than the routing.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Final

import numpy as np

from build import binformat as bf
from build.geo import M_PER_DEG_LAT, haversine_m

# --------------------------------------------------------------------------- #
# Terrain and lattice parameters -- importable so tests assert against them
# --------------------------------------------------------------------------- #

REGION_ID: Final = "ridge-world"

LAT0: Final = 46.5
LON0: Final = 8.0

LATTICE_NX: Final = 22
LATTICE_NY: Final = 16
SPACING_M: Final = 240.0

BASE_ELEV_M: Final = 600.0
#: Regional tilt to the north, metres per metre. Makes north-south edges asymmetric.
TILT_PER_M: Final = 0.012

RIDGE_X_M: Final = 2400.0
RIDGE_WIDTH_M: Final = 1200.0
RIDGE_AMPLITUDE_M: Final = 260.0
#: The crest wanders so the ridge is not a straight wall.
RIDGE_MEANDER_M: Final = 200.0
RIDGE_MEANDER_WAVELENGTH_M: Final = 1000.0

PASS_Y_M: Final = 2400.0
PASS_DEPTH_M: Final = 150.0
PASS_WIDTH_M: Final = 800.0

#: Elevation profile sampling step. Matches the real pipeline's 10 m.
SAMPLE_STEP_M: Final = 10.0

#: Rolling window for ``max_slope``. The real pipeline uses 200 m; Ridge World's
#: edges are only ~240 m long, so a 200 m window would smooth every edge down to
#: its average grade and the slope filter would have nothing to bite on.
SLOPE_WINDOW_M: Final = 50.0

BUMP_HEIGHT_M: Final = 14.0

_COS_LAT0: Final = math.cos(math.radians(LAT0))


# --------------------------------------------------------------------------- #
# Terrain
# --------------------------------------------------------------------------- #


def ridge_crest_x(y: float) -> float:
    """East-west position of the crest at northing ``y``."""
    return RIDGE_X_M + RIDGE_MEANDER_M * math.sin(y / RIDGE_MEANDER_WAVELENGTH_M)


def ridge_amplitude(y: float) -> float:
    """Crest height above the local base, reduced inside the pass."""
    notch = PASS_DEPTH_M * math.exp(-(((y - PASS_Y_M) / PASS_WIDTH_M) ** 2))
    return RIDGE_AMPLITUDE_M - notch


def elevation(x: float, y: float) -> float:
    """Metres above sea level at local plane coordinates ``(x, y)``, in metres."""
    u = (x - ridge_crest_x(y)) / RIDGE_WIDTH_M
    return BASE_ELEV_M + TILT_PER_M * y + ridge_amplitude(y) * math.exp(-(u * u))


def lattice_x(i: int) -> float:
    """Column position, jittered by a deterministic quadratic residue.

    The offset is quadratic in ``i`` on purpose. A linear form like ``(i*37) % 11``
    looks jittered but its *consecutive differences* take only two values (+k, or
    +k-m on wraparound), so the lattice is really a two-spacing alternation and
    many distinct paths still tie exactly. A quadratic gives 19 distinct column
    spacings across the 22 columns.
    """
    return i * SPACING_M + 3.0 * ((7 * i * i + 5 * i) % 19)


def lattice_y(j: int) -> float:
    """Row position, jittered by a different quadratic so rows do not track columns."""
    return j * SPACING_M + 4.0 * ((5 * j * j + 3 * j) % 17)


def to_lonlat(x: float, y: float) -> tuple[float, float]:
    """Local metres to WGS84 degrees via a fixed-scale equirectangular map.

    The map is only a device for laying out plausible coordinates; every distance
    in the graph is then measured with the real :func:`haversine_m`, so the small
    inconsistency between this projection and the sphere never enters the data.
    """
    lat = LAT0 + y / M_PER_DEG_LAT
    lon = LON0 + x / (M_PER_DEG_LAT * _COS_LAT0)
    return lon, lat


def from_lonlat(lon: float, lat: float) -> tuple[float, float]:
    """Inverse of :func:`to_lonlat`, so terrain can be sampled at a lat/lon point."""
    return (lon - LON0) * M_PER_DEG_LAT * _COS_LAT0, (lat - LAT0) * M_PER_DEG_LAT


# --------------------------------------------------------------------------- #
# Edge measurement
# --------------------------------------------------------------------------- #


@dataclass(frozen=True)
class EdgeMetrics:
    dist_m: float
    ascent_m: float
    descent_m: float
    max_slope_pct_fwd: float
    max_slope_pct_rev: float


def _rolling_max_uphill_pct(cum_s: list[float], prof: list[float]) -> float:
    """Steepest uphill grade over any window spanning at least SLOPE_WINDOW_M.

    Windows shorter than the threshold only occur on edges shorter than the
    window, where the whole edge is used instead. Returns percent, never negative.
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


def sample_count(lon0: float, lat0: float, lon1: float, lat1: float) -> int:
    """Number of profile samples for an edge, at roughly :data:`SAMPLE_STEP_M` spacing."""
    x0, y0 = from_lonlat(lon0, lat0)
    x1, y1 = from_lonlat(lon1, lat1)
    return max(1, int(math.ceil(math.hypot(x1 - x0, y1 - y0) / SAMPLE_STEP_M))) + 1


def measure_edge(
    p0: tuple[float, float],
    p1: tuple[float, float],
    elev0: float,
    elev1: float,
    *,
    profile_override: list[float] | None = None,
) -> EdgeMetrics:
    """Sample a straight edge every ~10 m and integrate its profile.

    ``p0``/``p1`` are ``(lon, lat)`` **as they will be stored** -- already rounded
    to f32. Interpolating between the stored endpoints rather than between the f64
    positions that produced them is what makes ``dist >= haversine(stored u,
    stored v)`` structurally true, and that inequality is exactly what the A*
    heuristic assumes. Measuring from f64 geometry instead leaves the heuristic
    free to exceed the true cost by the coordinate rounding error (~0.1 m here,
    enough to break optimality on short edges) -- which is precisely the bug this
    signature exists to prevent.

    ``ascent`` is the integral of positive steps -- never ``max(0, dh_endpoint)``.
    The profile's endpoints are pinned to the stored node elevations so that
    ``ascent - descent`` telescopes along a path.
    """
    lon0, lat0 = p0
    lon1, lat1 = p1
    n = sample_count(lon0, lat0, lon1, lat1)
    steps = n - 1

    lons = [lon0 + (lon1 - lon0) * (i / steps) for i in range(n)]
    lats = [lat0 + (lat1 - lat0) * (i / steps) for i in range(n)]

    if profile_override is not None:
        if len(profile_override) != n:
            raise ValueError(f"profile_override has {len(profile_override)} samples, need {n}")
        prof = list(profile_override)
    else:
        prof = [elevation(*from_lonlat(lon, lat)) for lon, lat in zip(lons, lats, strict=True)]
    prof[0] = elev0
    prof[-1] = elev1

    dist = 0.0
    cum_s = [0.0]
    for k in range(steps):
        seg = haversine_m(lats[k], lons[k], lats[k + 1], lons[k + 1])
        dist += seg
        cum_s.append(dist)

    ascent = 0.0
    descent = 0.0
    for k in range(steps):
        dh = prof[k + 1] - prof[k]
        if dh > 0.0:
            ascent += dh
        else:
            descent -= dh

    return EdgeMetrics(
        dist_m=dist,
        ascent_m=ascent,
        descent_m=descent,
        max_slope_pct_fwd=_rolling_max_uphill_pct(cum_s, prof),
        max_slope_pct_rev=_rolling_max_uphill_pct(
            [dist - s for s in reversed(cum_s)], list(reversed(prof))
        ),
    )


def bump_profile(base_elev: float, n_samples: int) -> list[float]:
    """A raised sine hump: equal at both ends, ~14 m in the middle."""
    return [
        base_elev + BUMP_HEIGHT_M * math.sin(math.pi * i / (n_samples - 1))
        for i in range(n_samples)
    ]


# --------------------------------------------------------------------------- #
# Assembly
# --------------------------------------------------------------------------- #


@dataclass(frozen=True)
class RidgeWorld:
    """The generated graph plus the node ids of the injected fixtures."""

    graph: bf.Graph

    #: Node id of the lattice node the bump spur hangs off.
    bump_anchor: int
    #: Bump spur nodes; ``bump_a -> bump_b`` is the equal-elevation bump edge.
    bump_a: int
    bump_b: int
    #: The three mutually connected, otherwise isolated nodes.
    island: tuple[int, int, int]

    def lattice_node(self, i: int, j: int) -> int:
        if not (0 <= i < LATTICE_NX and 0 <= j < LATTICE_NY):
            raise IndexError(f"lattice index ({i}, {j}) out of range")
        return j * LATTICE_NX + i


def build_ridge_world() -> RidgeWorld:
    """Construct the fixture. Deterministic: same output on every run, any platform."""
    positions: list[tuple[float, float]] = []
    elevations: list[float] = []

    # --- lattice ---------------------------------------------------------- #
    for j in range(LATTICE_NY):
        for i in range(LATTICE_NX):
            x, y = lattice_x(i), lattice_y(j)
            positions.append((x, y))
            elevations.append(elevation(x, y))

    def lattice_id(i: int, j: int) -> int:
        return j * LATTICE_NX + i

    # (u, v, is_bump). Geometry is measured later, from the *stored* f32
    # coordinates, so the pair list carries only topology at this stage.
    pairs: list[tuple[int, int, bool]] = []
    for j in range(LATTICE_NY):
        for i in range(LATTICE_NX):
            if i + 1 < LATTICE_NX:
                pairs.append((lattice_id(i, j), lattice_id(i + 1, j), False))
            if j + 1 < LATTICE_NY:
                pairs.append((lattice_id(i, j), lattice_id(i, j + 1), False))

    # --- bump spur -------------------------------------------------------- #
    # Hung off a west-side node where the terrain is nearly flat, so the 14 m
    # hump is unmistakably the edge's own feature and not background relief.
    bump_anchor = lattice_id(1, 1)
    ax, ay = positions[bump_anchor]
    bump_a_pos = (ax - 180.0, ay - 160.0)
    bump_b_pos = (ax - 180.0, ay - 330.0)

    # Both spur nodes are pinned to the same elevation on purpose: the edge
    # between them must have zero endpoint delta-h and non-zero ascent.
    bump_elev = elevation(*bump_a_pos)

    bump_a = len(positions)
    positions.append(bump_a_pos)
    elevations.append(bump_elev)
    bump_b = len(positions)
    positions.append(bump_b_pos)
    elevations.append(bump_elev)

    # The approach edge samples the real terrain; measure_edge pins its endpoints
    # to the stored node elevations, which already agree with the field here.
    pairs.append((bump_anchor, bump_a, False))
    pairs.append((bump_a, bump_b, True))

    # --- island ----------------------------------------------------------- #
    island_centre = (4180.0, 1810.0)
    island_offsets = ((0.0, 0.0), (70.0, 0.0), (35.0, 62.0))
    island: list[int] = []
    for dx, dy in island_offsets:
        p = (island_centre[0] + dx, island_centre[1] + dy)
        island.append(len(positions))
        positions.append(p)
        elevations.append(elevation(*p))
    pairs.append((island[0], island[1], False))
    pairs.append((island[1], island[2], False))
    pairs.append((island[2], island[0], False))

    # --- freeze the node arrays before measuring anything ------------------ #
    #
    # Order matters. Coordinates are rounded to f32 *first*, then read back as
    # f64, and only then is edge geometry measured between them. The router sees
    # exactly these f32 values, so measuring from them is what makes
    # `edge_dist >= haversine(stored endpoints)` true by construction instead of
    # true by luck. validate_graph() enforces it either way.
    node_count = len(positions)
    lonlat = [to_lonlat(x, y) for x, y in positions]
    node_lon = np.array([p[0] for p in lonlat], dtype=np.float32)
    node_lat = np.array([p[1] for p in lonlat], dtype=np.float32)
    node_elev = np.array(elevations, dtype=np.float32)

    lon32: list[float] = node_lon.astype(np.float64).tolist()
    lat32: list[float] = node_lat.astype(np.float64).tolist()
    elev32: list[float] = node_elev.astype(np.float64).tolist()

    # --- measure and split into directed half-edges ------------------------ #
    sources: list[int] = []
    targets: list[int] = []
    edge_ids: list[int] = []
    dist: list[float] = []
    ascent: list[float] = []
    descent: list[float] = []
    slope: list[int] = []

    for eid, (u, v, is_bump) in enumerate(pairs):
        override = None
        if is_bump:
            override = bump_profile(
                elev32[u], sample_count(lon32[u], lat32[u], lon32[v], lat32[v])
            )
        m = measure_edge(
            (lon32[u], lat32[u]),
            (lon32[v], lat32[v]),
            elev32[u],
            elev32[v],
            profile_override=override,
        )
        sources += [u, v]
        targets += [v, u]
        edge_ids += [eid, eid]
        dist += [m.dist_m, m.dist_m]
        ascent += [m.ascent_m, m.descent_m]
        descent += [m.descent_m, m.ascent_m]
        slope += [
            bf.encode_max_slope(m.max_slope_pct_fwd),
            bf.encode_max_slope(m.max_slope_pct_rev),
        ]

    csr = bf.build_csr(
        node_count=node_count,
        sources=np.array(sources, dtype=np.int64),
        targets=np.array(targets, dtype=np.int64),
        edge_ids=np.array(edge_ids, dtype=np.int64),
        dist=np.array(dist, dtype=np.float64),
        ascent=np.array(ascent, dtype=np.float64),
        descent=np.array(descent, dtype=np.float64),
        max_slope_u8=np.array(slope, dtype=np.int64),
    )
    csr_offset, edge_target, edge_id, edge_dist, edge_ascent, edge_descent, edge_slope = csr

    # Derive the bbox from the *stored f32* coordinates so it contains them
    # exactly; deriving it from the f64 originals could exclude a node that
    # rounded outwards.
    bbox = (
        float(node_lon.min()),
        float(node_lat.min()),
        float(node_lon.max()),
        float(node_lat.max()),
    )
    # Deliberately far finer than the ~4 nodes/cell the real build will use.
    # A uniform lattice fills every cell it can reach, so at any sane occupancy
    # the snapping ring search never has to expand across a hole -- yet holes are
    # the normal case nationwide (lakes, forest, rock) and the case that breaks a
    # naive 3x3 probe. Over-resolving the grid is how a regular fixture reproduces
    # an irregular one.
    grid_nx, grid_ny = bf.choose_grid_dims(node_count, bbox, target_per_cell=0.55)
    grid_offset, grid_nodeid = bf.build_grid_index(node_lat, node_lon, bbox, grid_nx, grid_ny)

    graph = bf.Graph(
        region_id=REGION_ID,
        bbox=bbox,
        grid_nx=grid_nx,
        grid_ny=grid_ny,
        flags=0,  # both halves emitted; one-ways are a step-3 decision
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
    )
    bf.validate_graph(graph)

    return RidgeWorld(
        graph=graph,
        bump_anchor=bump_anchor,
        bump_a=bump_a,
        bump_b=bump_b,
        island=(island[0], island[1], island[2]),
    )
