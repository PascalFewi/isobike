"""VeloRouter graph binary format, version 1 -- the single source of truth.

``worker/src/binformat.ts`` mirrors this module byte for byte. A change here is a
change there, and both invalidate the golden files under ``testdata/ridge_world/``.
That triple-coupling is deliberate: the cross-language round-trip test is the only
thing standing between us and a silent layout drift that would corrupt every route.

Design notes (why it looks like this)
=====================================

**Struct-of-arrays, not interleaved records.** The spec lists edge fields as if
they were one record (``target u32, dist f32, ascent f32, descent f32, max_slope
u8``). Stored that way the record is 21 bytes and nothing after the first is
4-byte aligned, so the Worker could not build zero-copy ``Float32Array`` views
over the buffer -- ``new Float32Array(buf, off, n)`` throws unless ``off % 4 ==
0``. Splitting into parallel arrays keeps every section aligned *and* means the
Dijkstra inner loop streams only the four arrays it actually reads
(``csr_offset``, ``edge_target``, ``edge_dist``, ``edge_ascent``) instead of
dragging ``descent`` and ``edge_id`` through cache for nothing.

**Directed edges, shared ``edge_id``.** Topology is undirected but cost is not:
``ascent(u->v) == descent(v->u)``. Both halves of a geometric edge carry the same
``edge_id`` because ``/effort-field`` returns ``(edge_id, cost)`` and the frontend
joins that onto a single PMTiles line feature via ``setFeatureState``. The format
is therefore one-way-capable from day one (``FLAG_ONEWAYS_RESPECTED``); whether
the *builder* emits both halves is a step-3 decision that never touches the layout.

**Node ordering is not constrained.** ``grid_nodeid`` is stored explicitly (4*N
bytes) rather than requiring nodes to be pre-sorted by cell. The real builder will
still sort by cell for locality, but that is builder policy; the test fixture gets
to use natural row-major order without a resort.

Byte layout
===========

All integers and floats are **little-endian**. Every section begins at an
8-byte-aligned offset and is zero-padded up to the next 8-byte boundary.

Header -- exactly 160 bytes::

    off  size  type      field
    ---  ----  --------  -----------------------------------------------------
      0     8  char[8]   magic, always b"VELOGRPH"
      8     4  u32       format_version (== 1)
     12     4  u32       header_size (== 160); lets a future reader skip a
                         longer v2 header without knowing its contents
     16    16  char[16]  region_id, ASCII, NUL-padded ("CH", "ridge-world")
     32     8  f64       bbox_min_lon
     40     8  f64       bbox_min_lat
     48     8  f64       bbox_max_lon
     56     8  f64       bbox_max_lat
     64     4  u32       node_count       N
     68     4  u32       dir_edge_count   E   (directed half-edges)
     72     4  u32       geom_edge_count  G   (== max(edge_id) + 1)
     76     4  u32       grid_nx
     80     4  u32       grid_ny
     84     4  u32       flags (bit0 = one-ways respected; others reserved 0)
     88    48  u32[12]   byte offset of each section, in the order below
    136     4  u32       file_size, in bytes, including this header
    140     4  u32       crc32 of every byte after the header (zlib/IEEE)
    144    16  --        reserved, must be zero

Section *lengths* are not stored; they are implied by the counts above. Sections
appear in this order, which is also their index in the offset table::

    #   section          dtype  count
    --  ---------------  -----  ---------------
     0  node_lat         f32    N
     1  node_lon         f32    N
     2  node_elev        f32    N
     3  csr_offset       u32    N + 1
     4  edge_target      u32    E
     5  edge_id          u32    E
     6  edge_dist        f32    E
     7  edge_ascent      f32    E
     8  edge_descent     f32    E
     9  edge_max_slope   u8     E
    10  grid_offset      u32    grid_nx * grid_ny + 1
    11  grid_nodeid      u32    N

Semantics
=========

``node_lat`` / ``node_lon``
    WGS84 degrees as f32. f32 gives ~0.6 m of positional error at Swiss latitudes
    (ulp of 47.0 is 5.6e-6 deg); that is well inside the 10 m DEM sampling step,
    so it is a documented limit rather than a problem. The spec mandates f32.

``node_elev``
    Metres above sea level, f32.

``csr_offset``
    Outgoing half-edges of node ``u`` are the index range
    ``csr_offset[u] .. csr_offset[u+1]``. Monotonic non-decreasing,
    ``csr_offset[0] == 0``, ``csr_offset[N] == E``. Within a node's block the
    edges are sorted by ``(target, edge_id)`` so the file is byte-reproducible.

``edge_dist``
    Length of the edge polyline in metres -- the *summed* length, not the chord.
    This matters for A*: the great-circle heuristic is only admissible because
    ``dist >= chord``.

``edge_ascent`` / ``edge_descent``
    Metres, integrated over the 10 m-sampled elevation profile:
    ``ascent = sum(max(0, dh))`` over consecutive samples, ``descent`` likewise
    for negative steps. **Never endpoint delta-h.** An edge that goes up 14 m and
    back down has ``ascent == 14`` while its endpoints are level; collapsing a
    degree-2 chain must sum these, never recompute from the new endpoints. The
    invariant ``ascent - descent == elev(v) - elev(u)`` holds up to f32 rounding
    and is asserted by the test suite precisely because it is the thing that
    breaks first when someone "optimises" the sampling away.

``edge_max_slope``
    Maximum **uphill** grade in the direction of travel, over a rolling window
    along the edge, quantised as ``u8 = clamp(round(pct / 0.25), 0, 255)``.
    Range 0.00 .. 63.75 %; 255 saturates. Downhill is not represented -- a 12 %
    descent must not get an edge filtered out of a climb-averse route. The two
    halves of one geometric edge therefore normally differ.

    The filter compares in floating point, ``u8 * 0.25 > limit_pct``, **not** by
    quantising the limit. 0.25 is a power of two, so ``u8 * 0.25`` is exact in
    f64 and Python and TypeScript make bit-identical decisions; quantising the
    limit would put a ``floor()`` on a boundary where the two languages could
    disagree.

``grid_offset`` / ``grid_nodeid``
    Uniform lat/lon grid over the bbox, ``grid_nx`` by ``grid_ny``, CSR-encoded.
    Cell of a point is ``iy * grid_nx + ix``. Cell sizes are derived from the
    bbox, not stored. ``grid_nodeid`` is a permutation of ``0 .. N-1``.
"""

from __future__ import annotations

import struct
import zlib
from dataclasses import dataclass
from enum import IntEnum
from pathlib import Path
from typing import Final

import numpy as np
from numpy.typing import NDArray

from build.geo import haversine_m_array

# --------------------------------------------------------------------------- #
# Constants
# --------------------------------------------------------------------------- #

MAGIC: Final = b"VELOGRPH"
FORMAT_VERSION: Final = 1
HEADER_SIZE: Final = 160
REGION_ID_SIZE: Final = 16
SECTION_ALIGN: Final = 8
SECTION_COUNT: Final = 12

#: ``flags`` bit 0. Set when the builder emitted a genuinely directed graph
#: (one-ways suppressed in the reverse direction). Clear means every geometric
#: edge has both halves. Readers do not behave differently; it is provenance.
FLAG_ONEWAYS_RESPECTED: Final = 1 << 0

#: Quantisation step of ``edge_max_slope``, in percent. A power of two, so
#: ``u8 * SLOPE_STEP_PCT`` is exact in f64 -- see the module docstring.
SLOPE_STEP_PCT: Final = 0.25
SLOPE_MAX_U8: Final = 255
SLOPE_MAX_PCT: Final = SLOPE_MAX_U8 * SLOPE_STEP_PCT  # 63.75

_HEADER_STRUCT: Final = struct.Struct(
    "<"        # little-endian, no implicit padding
    "8s"       # magic
    "I"        # format_version
    "I"        # header_size
    "16s"      # region_id
    "dddd"     # bbox: min_lon, min_lat, max_lon, max_lat
    "I"        # node_count
    "I"        # dir_edge_count
    "I"        # geom_edge_count
    "I"        # grid_nx
    "I"        # grid_ny
    "I"        # flags
    "12I"      # section offsets
    "I"        # file_size
    "I"        # crc32
    "16x"      # reserved
)
assert _HEADER_STRUCT.size == HEADER_SIZE, _HEADER_STRUCT.size


class Section(IntEnum):
    """Index into the header's section-offset table. Order is part of the format."""

    NODE_LAT = 0
    NODE_LON = 1
    NODE_ELEV = 2
    CSR_OFFSET = 3
    EDGE_TARGET = 4
    EDGE_ID = 5
    EDGE_DIST = 6
    EDGE_ASCENT = 7
    EDGE_DESCENT = 8
    EDGE_MAX_SLOPE = 9
    GRID_OFFSET = 10
    GRID_NODEID = 11


@dataclass(frozen=True)
class _SectionSpec:
    name: str
    dtype: str
    #: One of "N", "N+1", "E", "CELLS+1" -- resolved against the header counts.
    count: str


_SECTION_SPECS: Final[tuple[_SectionSpec, ...]] = (
    _SectionSpec("node_lat", "<f4", "N"),
    _SectionSpec("node_lon", "<f4", "N"),
    _SectionSpec("node_elev", "<f4", "N"),
    _SectionSpec("csr_offset", "<u4", "N+1"),
    _SectionSpec("edge_target", "<u4", "E"),
    _SectionSpec("edge_id", "<u4", "E"),
    _SectionSpec("edge_dist", "<f4", "E"),
    _SectionSpec("edge_ascent", "<f4", "E"),
    _SectionSpec("edge_descent", "<f4", "E"),
    _SectionSpec("edge_max_slope", "<u1", "E"),
    _SectionSpec("grid_offset", "<u4", "CELLS+1"),
    _SectionSpec("grid_nodeid", "<u4", "N"),
)
assert len(_SECTION_SPECS) == SECTION_COUNT
assert tuple(s.name for s in _SECTION_SPECS) == tuple(s.name.lower() for s in Section)


# --------------------------------------------------------------------------- #
# Errors
# --------------------------------------------------------------------------- #


class BinFormatError(Exception):
    """Base class for every failure to read or validate a graph binary."""


class BadMagicError(BinFormatError):
    """The file does not start with ``VELOGRPH``."""


class UnsupportedVersionError(BinFormatError):
    """``format_version`` is not one this build understands."""


class TruncatedFileError(BinFormatError):
    """The buffer is shorter than the header claims, or a section runs past its end."""


class ChecksumError(BinFormatError):
    """``crc32`` does not match the payload."""


class GraphValidationError(BinFormatError):
    """Structurally readable, but the contents violate a documented invariant."""


# --------------------------------------------------------------------------- #
# Slope quantisation
# --------------------------------------------------------------------------- #


def encode_max_slope(pct: float) -> int:
    """Quantise an uphill grade in percent to the stored u8.

    Negative input (a descent) encodes to 0: the format stores uphill only.
    """
    if not np.isfinite(pct) or pct <= 0.0:
        return 0
    return min(SLOPE_MAX_U8, int(round(pct / SLOPE_STEP_PCT)))


def decode_max_slope(value: int) -> float:
    """Stored u8 back to percent. Exact in f64 -- see the module docstring."""
    return value * SLOPE_STEP_PCT


def slope_exceeds(value: int, limit_pct: float) -> bool:
    """True when an edge must be skipped under a ``max_slope`` filter of ``limit_pct``.

    Compared in f64 against the decoded value rather than by quantising the limit,
    so that TypeScript reaches the identical verdict on every edge.
    """
    return value * SLOPE_STEP_PCT > limit_pct


# --------------------------------------------------------------------------- #
# Graph container
# --------------------------------------------------------------------------- #


# eq=False on purpose: the generated __eq__ would compare numpy arrays with ==,
# yielding an array where a bool is required and raising a baffling ValueError.
# Tests compare field by field instead.
@dataclass(frozen=True, eq=False)
class Graph:
    """A parsed graph binary. Arrays are exactly the twelve stored sections.

    Arrays returned by :func:`read_graph` are read-only views onto the source
    buffer -- no copy, mirroring the Worker's zero-copy typed arrays.
    """

    region_id: str
    bbox: tuple[float, float, float, float]  # min_lon, min_lat, max_lon, max_lat
    grid_nx: int
    grid_ny: int
    flags: int

    node_lat: NDArray[np.float32]
    node_lon: NDArray[np.float32]
    node_elev: NDArray[np.float32]
    csr_offset: NDArray[np.uint32]
    edge_target: NDArray[np.uint32]
    edge_id: NDArray[np.uint32]
    edge_dist: NDArray[np.float32]
    edge_ascent: NDArray[np.float32]
    edge_descent: NDArray[np.float32]
    edge_max_slope: NDArray[np.uint8]
    grid_offset: NDArray[np.uint32]
    grid_nodeid: NDArray[np.uint32]

    format_version: int = FORMAT_VERSION

    @property
    def node_count(self) -> int:
        return int(self.node_lat.shape[0])

    @property
    def dir_edge_count(self) -> int:
        return int(self.edge_target.shape[0])

    @property
    def geom_edge_count(self) -> int:
        """``max(edge_id) + 1``; 0 for an edgeless graph."""
        if self.edge_id.size == 0:
            return 0
        return int(self.edge_id.max()) + 1

    @property
    def cell_count(self) -> int:
        return self.grid_nx * self.grid_ny


# --------------------------------------------------------------------------- #
# Construction helpers
# --------------------------------------------------------------------------- #


def choose_grid_dims(
    node_count: int, bbox: tuple[float, float, float, float], *, target_per_cell: float = 4.0
) -> tuple[int, int]:
    """Pick ``(nx, ny)`` so cells hold ~``target_per_cell`` nodes and stay square-ish.

    Square-ish in *metres*, not degrees: at 47 deg N a degree of longitude is about
    0.68 of a degree of latitude, so a naive equal-degree split would produce cells
    two-thirds as wide as they are tall and make the snapping ring search scan more
    cells than it needs to.
    """
    min_lon, min_lat, max_lon, max_lat = bbox
    lat_span = max(max_lat - min_lat, 1e-9)
    lon_span = max(max_lon - min_lon, 1e-9)
    mid_lat_rad = np.radians((min_lat + max_lat) * 0.5)

    width_m = lon_span * float(np.cos(mid_lat_rad))
    height_m = lat_span
    cells = max(1.0, node_count / max(target_per_cell, 0.5))

    # nx / ny = width / height and nx * ny = cells
    aspect = width_m / height_m
    nx = int(round(np.sqrt(cells * aspect)))
    ny = int(round(np.sqrt(cells / aspect)))
    return max(1, nx), max(1, ny)


def build_grid_index(
    node_lat: NDArray[np.float32],
    node_lon: NDArray[np.float32],
    bbox: tuple[float, float, float, float],
    grid_nx: int,
    grid_ny: int,
) -> tuple[NDArray[np.uint32], NDArray[np.uint32]]:
    """CSR-encode nodes by grid cell. Returns ``(grid_offset, grid_nodeid)``.

    A node exactly on the bbox maximum clamps into the last cell rather than
    spilling into a nonexistent one; the reader relies on every node appearing in
    exactly one cell.
    """
    cell = cell_of_point_array(node_lat, node_lon, bbox, grid_nx, grid_ny)
    cells = grid_nx * grid_ny

    counts = np.bincount(cell, minlength=cells).astype(np.uint32)
    grid_offset = np.zeros(cells + 1, dtype=np.uint32)
    np.cumsum(counts, out=grid_offset[1:])

    # Stable sort keeps nodes in ascending id within a cell -> reproducible file.
    grid_nodeid = np.argsort(cell, kind="stable").astype(np.uint32)
    return grid_offset, grid_nodeid


def cell_of_point_array(
    lat: NDArray[np.float32] | NDArray[np.float64],
    lon: NDArray[np.float32] | NDArray[np.float64],
    bbox: tuple[float, float, float, float],
    grid_nx: int,
    grid_ny: int,
) -> NDArray[np.int64]:
    """Vectorised cell index for points, clamped to the grid."""
    min_lon, min_lat, max_lon, max_lat = bbox
    lon_span = max(max_lon - min_lon, 1e-12)
    lat_span = max(max_lat - min_lat, 1e-12)

    ix = np.floor((lon.astype(np.float64) - min_lon) / lon_span * grid_nx).astype(np.int64)
    iy = np.floor((lat.astype(np.float64) - min_lat) / lat_span * grid_ny).astype(np.int64)
    np.clip(ix, 0, grid_nx - 1, out=ix)
    np.clip(iy, 0, grid_ny - 1, out=iy)
    return iy * grid_nx + ix


def build_csr(
    node_count: int,
    sources: NDArray[np.integer],
    targets: NDArray[np.integer],
    edge_ids: NDArray[np.integer],
    dist: NDArray[np.floating],
    ascent: NDArray[np.floating],
    descent: NDArray[np.floating],
    max_slope_u8: NDArray[np.integer],
) -> tuple[
    NDArray[np.uint32],
    NDArray[np.uint32],
    NDArray[np.uint32],
    NDArray[np.float32],
    NDArray[np.float32],
    NDArray[np.float32],
    NDArray[np.uint8],
]:
    """Sort a directed half-edge list into CSR order.

    Within a source node the edges are ordered by ``(target, edge_id)``. The
    router never depends on that order for correctness -- both languages read the
    same bytes -- but pinning it makes the output file byte-reproducible, which is
    what lets the golden-file test assert equality rather than equivalence.
    """
    order = np.lexsort((edge_ids, targets, sources))

    src_sorted = sources[order]
    counts = np.bincount(src_sorted, minlength=node_count).astype(np.uint32)
    csr_offset = np.zeros(node_count + 1, dtype=np.uint32)
    np.cumsum(counts, out=csr_offset[1:])

    return (
        csr_offset,
        targets[order].astype(np.uint32),
        edge_ids[order].astype(np.uint32),
        dist[order].astype(np.float32),
        ascent[order].astype(np.float32),
        descent[order].astype(np.float32),
        max_slope_u8[order].astype(np.uint8),
    )


# --------------------------------------------------------------------------- #
# Validation
# --------------------------------------------------------------------------- #


def validate_graph(
    graph: Graph,
    *,
    elev_range: tuple[float, float] = (-500.0, 9000.0),
) -> None:
    """Assert every documented invariant. Raises :class:`GraphValidationError`.

    Called by :func:`read_graph` and -- per the spec's "hard validation of outputs
    before export" -- by the build pipeline before anything is written to R2.
    """

    def fail(msg: str) -> None:
        raise GraphValidationError(msg)

    n = graph.node_count
    e = graph.dir_edge_count

    if n < 1:
        fail("node_count must be >= 1")

    for name in ("node_lat", "node_lon", "node_elev"):
        arr = getattr(graph, name)
        if arr.shape != (n,):
            fail(f"{name} has length {arr.shape[0]}, expected {n}")
        if not np.isfinite(arr).all():
            fail(f"{name} contains NaN or infinity")

    lo, hi = elev_range
    if n and (float(graph.node_elev.min()) < lo or float(graph.node_elev.max()) > hi):
        fail(
            f"node_elev out of plausible range [{lo}, {hi}]: "
            f"[{float(graph.node_elev.min())}, {float(graph.node_elev.max())}]"
        )

    min_lon, min_lat, max_lon, max_lat = graph.bbox
    if not (min_lon < max_lon and min_lat < max_lat):
        fail(f"bbox is empty or inverted: {graph.bbox}")
    # f32 node coordinates are rounded from f64, so a node can land a fraction of
    # an ulp outside a bbox that was computed in f64. One ulp at 47 deg is ~6e-6.
    tol = 1e-5
    if n and (
        float(graph.node_lon.min()) < min_lon - tol
        or float(graph.node_lon.max()) > max_lon + tol
        or float(graph.node_lat.min()) < min_lat - tol
        or float(graph.node_lat.max()) > max_lat + tol
    ):
        fail("bbox does not contain all nodes")

    # --- CSR -------------------------------------------------------------- #
    if graph.csr_offset.shape != (n + 1,):
        fail(f"csr_offset has length {graph.csr_offset.shape[0]}, expected {n + 1}")
    if int(graph.csr_offset[0]) != 0:
        fail("csr_offset[0] must be 0")
    if int(graph.csr_offset[n]) != e:
        fail(f"csr_offset[N] is {int(graph.csr_offset[n])}, expected dir_edge_count {e}")
    if np.any(np.diff(graph.csr_offset.astype(np.int64)) < 0):
        fail("csr_offset is not monotonically non-decreasing")

    for name in ("edge_target", "edge_id", "edge_dist", "edge_ascent", "edge_descent", "edge_max_slope"):
        arr = getattr(graph, name)
        if arr.shape != (e,):
            fail(f"{name} has length {arr.shape[0]}, expected {e}")

    if e:
        if int(graph.edge_target.max()) >= n:
            fail(f"edge_target references node {int(graph.edge_target.max())} of {n}")
        for name in ("edge_dist", "edge_ascent", "edge_descent"):
            arr = getattr(graph, name)
            if not np.isfinite(arr).all():
                fail(f"{name} contains NaN or infinity")
            if float(arr.min()) < 0.0:
                fail(f"{name} contains a negative value")
        if float(graph.edge_dist.min()) <= 0.0:
            fail("edge_dist contains a zero-length edge")

    # --- the invariant A* admissibility rests on ---------------------------- #
    #
    # Every edge must be at least as long as the great-circle distance between
    # its *stored* endpoints. The A* heuristic measures between f32 coordinates
    # while a build pipeline naturally computes lengths from f64 geometry, and
    # f32 rounding is worth up to ~0.2 m per coordinate at Swiss latitudes. On a
    # short edge that is enough to make the heuristic exceed the true cost, at
    # which point A* silently returns suboptimal routes -- no crash, no warning,
    # just slightly wrong answers.
    #
    # Checking it here turns that into a loud failure before anything reaches R2.
    if e:
        src = np.repeat(
            np.arange(n, dtype=np.int64), np.diff(graph.csr_offset.astype(np.int64))
        )
        dst = graph.edge_target.astype(np.int64)
        chord = haversine_m_array(
            graph.node_lat.astype(np.float64)[src],
            graph.node_lon.astype(np.float64)[src],
            graph.node_lat.astype(np.float64)[dst],
            graph.node_lon.astype(np.float64)[dst],
        )
        # Tolerance covers only edge_dist's own f32 rounding, not geometry error.
        short = graph.edge_dist.astype(np.float64) < chord * (1.0 - 1e-6)
        if bool(short.any()):
            i = int(np.argmax(short))
            fail(
                f"edge_dist[{i}] = {float(graph.edge_dist[i])} is shorter than the "
                f"great-circle distance {float(chord[i])} between its stored endpoints; "
                "A* would lose admissibility"
            )

    # --- grid -------------------------------------------------------------- #
    cells = graph.cell_count
    if graph.grid_nx < 1 or graph.grid_ny < 1:
        fail(f"grid dimensions must be >= 1, got {graph.grid_nx}x{graph.grid_ny}")
    if graph.grid_offset.shape != (cells + 1,):
        fail(f"grid_offset has length {graph.grid_offset.shape[0]}, expected {cells + 1}")
    if int(graph.grid_offset[0]) != 0:
        fail("grid_offset[0] must be 0")
    if int(graph.grid_offset[cells]) != n:
        fail(f"grid_offset[CELLS] is {int(graph.grid_offset[cells])}, expected node_count {n}")
    if np.any(np.diff(graph.grid_offset.astype(np.int64)) < 0):
        fail("grid_offset is not monotonically non-decreasing")
    if graph.grid_nodeid.shape != (n,):
        fail(f"grid_nodeid has length {graph.grid_nodeid.shape[0]}, expected {n}")
    if n:
        seen = np.zeros(n, dtype=bool)
        ids = graph.grid_nodeid.astype(np.int64)
        if int(ids.max()) >= n:
            fail("grid_nodeid references a node out of range")
        seen[ids] = True
        if not seen.all():
            fail("grid_nodeid is not a permutation of 0..N-1 (a node is unreachable by snapping)")

    # Every node must sit in the cell the index claims. This is the check that
    # catches a bbox/grid mismatch, which would silently break snapping near the
    # region border rather than loudly anywhere.
    if n:
        expected = cell_of_point_array(
            graph.node_lat, graph.node_lon, graph.bbox, graph.grid_nx, graph.grid_ny
        )
        cell_of_slot = np.repeat(
            np.arange(cells, dtype=np.int64), np.diff(graph.grid_offset.astype(np.int64))
        )
        if not np.array_equal(expected[ids], cell_of_slot):
            fail("grid_nodeid places a node in the wrong cell")


# --------------------------------------------------------------------------- #
# Write
# --------------------------------------------------------------------------- #


def _resolve_count(spec: _SectionSpec, n: int, e: int, cells: int) -> int:
    match spec.count:
        case "N":
            return n
        case "N+1":
            return n + 1
        case "E":
            return e
        case "CELLS+1":
            return cells + 1
    raise AssertionError(f"unknown count expression {spec.count!r}")


def _align_up(value: int) -> int:
    return (value + SECTION_ALIGN - 1) & ~(SECTION_ALIGN - 1)


def graph_to_bytes(graph: Graph, *, validate: bool = True) -> bytes:
    """Serialise to the v1 layout. Validates first unless explicitly told not to."""
    if validate:
        validate_graph(graph)

    region = graph.region_id.encode("ascii")
    if len(region) > REGION_ID_SIZE:
        raise BinFormatError(f"region_id {graph.region_id!r} exceeds {REGION_ID_SIZE} ASCII bytes")

    n, e, cells = graph.node_count, graph.dir_edge_count, graph.cell_count

    payloads: list[bytes] = []
    offsets: list[int] = []
    cursor = HEADER_SIZE
    for spec in _SECTION_SPECS:
        arr = np.ascontiguousarray(getattr(graph, spec.name), dtype=np.dtype(spec.dtype))
        expected = _resolve_count(spec, n, e, cells)
        if arr.shape != (expected,):
            raise BinFormatError(f"{spec.name} has length {arr.shape[0]}, expected {expected}")
        raw = arr.tobytes()
        pad = _align_up(len(raw)) - len(raw)
        offsets.append(cursor)
        payloads.append(raw + b"\x00" * pad)
        cursor += len(raw) + pad

    body = b"".join(payloads)
    file_size = HEADER_SIZE + len(body)
    checksum = zlib.crc32(body) & 0xFFFFFFFF

    header = _HEADER_STRUCT.pack(
        MAGIC,
        FORMAT_VERSION,
        HEADER_SIZE,
        region,  # struct pads to 16 with NULs
        graph.bbox[0],
        graph.bbox[1],
        graph.bbox[2],
        graph.bbox[3],
        n,
        e,
        graph.geom_edge_count,
        graph.grid_nx,
        graph.grid_ny,
        graph.flags,
        *offsets,
        file_size,
        checksum,
    )
    return header + body


def write_graph(graph: Graph, path: Path | str, *, validate: bool = True) -> int:
    """Write ``graph`` to ``path``. Returns the byte count written."""
    data = graph_to_bytes(graph, validate=validate)
    Path(path).write_bytes(data)
    return len(data)


# --------------------------------------------------------------------------- #
# Read
# --------------------------------------------------------------------------- #


def graph_from_bytes(
    data: bytes | bytearray | memoryview,
    *,
    verify_checksum: bool = True,
    validate: bool = True,
) -> Graph:
    """Parse the v1 layout. Arrays are read-only views onto ``data``, not copies."""
    buf = memoryview(data)
    if len(buf) < HEADER_SIZE:
        raise TruncatedFileError(f"buffer is {len(buf)} bytes, need at least {HEADER_SIZE}")

    (
        magic,
        version,
        header_size,
        region_raw,
        min_lon,
        min_lat,
        max_lon,
        max_lat,
        n,
        e,
        geom_edge_count,
        grid_nx,
        grid_ny,
        flags,
        *rest,
    ) = _HEADER_STRUCT.unpack_from(buf, 0)

    offsets = rest[:SECTION_COUNT]
    file_size, checksum = rest[SECTION_COUNT], rest[SECTION_COUNT + 1]

    if magic != MAGIC:
        raise BadMagicError(f"expected magic {MAGIC!r}, got {bytes(magic)!r}")
    if version != FORMAT_VERSION:
        raise UnsupportedVersionError(f"format_version {version}, this build reads {FORMAT_VERSION}")
    if header_size != HEADER_SIZE:
        raise UnsupportedVersionError(f"header_size {header_size}, expected {HEADER_SIZE}")
    if file_size != len(buf):
        raise TruncatedFileError(f"header claims {file_size} bytes, buffer has {len(buf)}")

    if verify_checksum:
        actual = zlib.crc32(buf[HEADER_SIZE:]) & 0xFFFFFFFF
        if actual != checksum:
            raise ChecksumError(f"crc32 mismatch: header {checksum:#010x}, payload {actual:#010x}")

    cells = grid_nx * grid_ny
    arrays: dict[str, NDArray[np.generic]] = {}
    prev_end = HEADER_SIZE
    for spec, offset in zip(_SECTION_SPECS, offsets, strict=True):
        dtype = np.dtype(spec.dtype)
        count = _resolve_count(spec, n, e, cells)
        end = offset + count * dtype.itemsize
        if offset % SECTION_ALIGN != 0:
            raise TruncatedFileError(f"section {spec.name} at {offset} is not {SECTION_ALIGN}-byte aligned")
        if offset < prev_end:
            raise TruncatedFileError(f"section {spec.name} at {offset} overlaps the previous section")
        if end > len(buf):
            raise TruncatedFileError(f"section {spec.name} ends at {end}, past the {len(buf)}-byte buffer")
        arrays[spec.name] = np.frombuffer(buf, dtype=dtype, count=count, offset=offset)
        prev_end = _align_up(end)

    graph = Graph(
        region_id=region_raw.split(b"\x00", 1)[0].decode("ascii"),
        bbox=(min_lon, min_lat, max_lon, max_lat),
        grid_nx=grid_nx,
        grid_ny=grid_ny,
        flags=flags,
        format_version=version,
        **arrays,  # type: ignore[arg-type]
    )

    if graph.geom_edge_count != geom_edge_count:
        raise GraphValidationError(
            f"header geom_edge_count {geom_edge_count} but max(edge_id)+1 is {graph.geom_edge_count}"
        )
    if validate:
        validate_graph(graph)
    return graph


def read_graph(
    path: Path | str, *, verify_checksum: bool = True, validate: bool = True
) -> Graph:
    """Read and validate a graph binary from disk."""
    return graph_from_bytes(
        Path(path).read_bytes(), verify_checksum=verify_checksum, validate=validate
    )
