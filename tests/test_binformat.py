"""Byte-exactness and invariant tests for the graph binary format.

The layout tests deliberately read fields at *hardcoded* byte offsets rather than
via ``binformat._HEADER_STRUCT``. Reusing the module's own struct would make the
test tautological: it would pass just as happily if the struct and the docstring
had drifted apart together.
"""

from __future__ import annotations

import struct
import zlib

import numpy as np
import pytest

from build import binformat as bf
from build.geo import haversine_m


# --------------------------------------------------------------------------- #
# Fixture: a four-node square with both diagonals absent
# --------------------------------------------------------------------------- #


def make_tiny_graph() -> bf.Graph:
    """A hand-built 4-node / 4-geometric-edge graph with known values.

    ::

        2 --e3-- 3        elevations: 0=600  1=610
        |        |                    2=605  3=640
       e1       e2
        |        |
        0 --e0-- 1
    """
    node_lat = np.array([46.5000, 46.5000, 46.5010, 46.5010], dtype=np.float32)
    node_lon = np.array([8.0000, 8.0010, 8.0000, 8.0010], dtype=np.float32)
    node_elev = np.array([600.0, 610.0, 605.0, 640.0], dtype=np.float32)

    # (edge_id, u, v, dist, ascent_uv, descent_uv, slope_pct_uv, slope_pct_vu)
    #
    # Distances are ~2 % above the straight-line chord (76.57 m east-west,
    # 111.13 m north-south), as a real road polyline would be. They must exceed
    # the chord or validate_graph rejects the graph -- see the admissibility
    # invariant there.
    undirected = [
        (0, 0, 1, 78.0, 10.0, 0.0, 13.0, 0.0),
        (1, 0, 2, 113.0, 5.0, 0.0, 4.5, 0.0),
        (2, 1, 3, 113.0, 30.0, 0.0, 27.0, 0.0),
        # e3 climbs 35 m net but the profile dips 4 m first: ascent 39, descent 4.
        (3, 2, 3, 78.0, 39.0, 4.0, 51.0, 5.5),
    ]

    sources, targets, ids = [], [], []
    dist, ascent, descent, slope = [], [], [], []
    for eid, u, v, d, asc, desc, s_uv, s_vu in undirected:
        sources += [u, v]
        targets += [v, u]
        ids += [eid, eid]
        dist += [d, d]
        # The reverse half swaps ascent and descent -- the whole point of storing
        # directed cost over undirected topology.
        ascent += [asc, desc]
        descent += [desc, asc]
        slope += [bf.encode_max_slope(s_uv), bf.encode_max_slope(s_vu)]

    csr = bf.build_csr(
        node_count=4,
        sources=np.array(sources, dtype=np.int64),
        targets=np.array(targets, dtype=np.int64),
        edge_ids=np.array(ids, dtype=np.int64),
        dist=np.array(dist, dtype=np.float64),
        ascent=np.array(ascent, dtype=np.float64),
        descent=np.array(descent, dtype=np.float64),
        max_slope_u8=np.array(slope, dtype=np.int64),
    )
    csr_offset, edge_target, edge_id, edge_dist, edge_ascent, edge_descent, edge_slope = csr

    bbox = (8.0, 46.5, 8.001, 46.501)
    grid_offset, grid_nodeid = bf.build_grid_index(node_lat, node_lon, bbox, 2, 2)

    return bf.Graph(
        region_id="tiny",
        bbox=bbox,
        grid_nx=2,
        grid_ny=2,
        flags=0,
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


ARRAY_FIELDS = tuple(s.name for s in bf._SECTION_SPECS)


# --------------------------------------------------------------------------- #
# Layout
# --------------------------------------------------------------------------- #


def test_header_size_and_alignment_constants() -> None:
    assert bf.HEADER_SIZE == 160
    assert bf.HEADER_SIZE % bf.SECTION_ALIGN == 0
    assert bf._HEADER_STRUCT.size == bf.HEADER_SIZE
    assert len(bf._SECTION_SPECS) == bf.SECTION_COUNT == len(bf.Section)


def test_header_fields_sit_at_the_documented_byte_offsets() -> None:
    data = bf.graph_to_bytes(make_tiny_graph())

    assert data[0:8] == b"VELOGRPH"
    assert struct.unpack_from("<I", data, 8)[0] == 1  # format_version
    assert struct.unpack_from("<I", data, 12)[0] == 160  # header_size
    assert data[16:32] == b"tiny" + b"\x00" * 12  # region_id, NUL-padded
    assert struct.unpack_from("<4d", data, 32) == (8.0, 46.5, 8.001, 46.501)  # bbox
    assert struct.unpack_from("<I", data, 64)[0] == 4  # node_count
    assert struct.unpack_from("<I", data, 68)[0] == 8  # dir_edge_count
    assert struct.unpack_from("<I", data, 72)[0] == 4  # geom_edge_count
    assert struct.unpack_from("<I", data, 76)[0] == 2  # grid_nx
    assert struct.unpack_from("<I", data, 80)[0] == 2  # grid_ny
    assert struct.unpack_from("<I", data, 84)[0] == 0  # flags
    assert struct.unpack_from("<I", data, 136)[0] == len(data)  # file_size
    assert struct.unpack_from("<I", data, 140)[0] == zlib.crc32(data[160:]) & 0xFFFFFFFF
    assert data[144:160] == b"\x00" * 16  # reserved


def test_section_offsets_are_ordered_aligned_and_contiguous() -> None:
    graph = make_tiny_graph()
    data = bf.graph_to_bytes(graph)
    offsets = struct.unpack_from("<12I", data, 88)

    assert offsets[0] == bf.HEADER_SIZE
    cursor = bf.HEADER_SIZE
    n, e, cells = graph.node_count, graph.dir_edge_count, graph.cell_count
    for spec, offset in zip(bf._SECTION_SPECS, offsets, strict=True):
        assert offset == cursor, f"{spec.name} starts at {offset}, expected {cursor}"
        assert offset % bf.SECTION_ALIGN == 0, f"{spec.name} is misaligned"
        nbytes = bf._resolve_count(spec, n, e, cells) * np.dtype(spec.dtype).itemsize
        cursor = bf._align_up(cursor + nbytes)
    assert cursor == len(data)


def test_header_golden_bytes() -> None:
    """Pin the full 160-byte header of the fixture.

    Purely a regression tripwire: any reordering, resizing or type change in the
    header alters this blob, so an accidental format break cannot pass silently
    even if every other test is still satisfied by the new layout.
    """
    data = bf.graph_to_bytes(make_tiny_graph())
    expected = (
        "56454c4f47525048"                  # magic "VELOGRPH"
        "01000000"                          # format_version 1
        "a0000000"                          # header_size 160
        "74696e79000000000000000000000000"  # region_id "tiny", NUL-padded to 16
        "0000000000002040"                  # bbox min_lon  8.000
        "0000000000404740"                  # bbox min_lat 46.500
        "8d976e1283002040"                  # bbox max_lon  8.001
        "e3a59bc420404740"                  # bbox max_lat 46.501
        "04000000"                          # node_count       4
        "08000000"                          # dir_edge_count   8
        "04000000"                          # geom_edge_count  4
        "02000000"                          # grid_nx 2
        "02000000"                          # grid_ny 2
        "00000000"                          # flags 0
        "a0000000b0000000c0000000"          # node_lat/lon/elev   @160,176,192
        "d0000000"                          # csr_offset          @208 (20 B -> pad)
        "e8000000"                          # edge_target         @232
        "08010000"                          # edge_id             @264
        "28010000"                          # edge_dist           @296
        "48010000"                          # edge_ascent         @328
        "68010000"                          # edge_descent        @360
        "88010000"                          # edge_max_slope      @392 (8 B)
        "90010000"                          # grid_offset         @400 (20 B -> pad)
        "a8010000"                          # grid_nodeid         @424
        "b8010000"                          # file_size 440
        "cc2472a9"                          # crc32 of bytes 160..440
        "00000000000000000000000000000000"  # reserved
    )
    assert data[:160].hex() == expected


# --------------------------------------------------------------------------- #
# Round trip
# --------------------------------------------------------------------------- #


def test_round_trip_preserves_every_field() -> None:
    original = make_tiny_graph()
    restored = bf.graph_from_bytes(bf.graph_to_bytes(original))

    assert restored.region_id == original.region_id
    assert restored.bbox == original.bbox
    assert restored.grid_nx == original.grid_nx
    assert restored.grid_ny == original.grid_ny
    assert restored.flags == original.flags
    assert restored.format_version == bf.FORMAT_VERSION
    assert restored.node_count == 4
    assert restored.dir_edge_count == 8
    assert restored.geom_edge_count == 4

    for field in ARRAY_FIELDS:
        np.testing.assert_array_equal(
            getattr(restored, field), getattr(original, field), err_msg=field
        )
        assert getattr(restored, field).dtype == getattr(original, field).dtype, field


def test_round_trip_is_byte_reproducible() -> None:
    """Same graph in, same bytes out -- what lets golden files be asserted exactly."""
    a = bf.graph_to_bytes(make_tiny_graph())
    b = bf.graph_to_bytes(make_tiny_graph())
    assert a == b
    assert bf.graph_to_bytes(bf.graph_from_bytes(a)) == a


def test_write_and_read_from_disk(tmp_path) -> None:
    path = tmp_path / "tiny.bin"
    written = bf.write_graph(make_tiny_graph(), path)
    assert written == path.stat().st_size
    assert bf.read_graph(path).node_count == 4


def test_parsed_arrays_are_views_not_copies() -> None:
    """Mirrors the Worker's zero-copy load; a copy here would hide a 60 MB surprise."""
    data = bf.graph_to_bytes(make_tiny_graph())
    graph = bf.graph_from_bytes(data)
    assert graph.node_lat.base is not None
    assert not graph.node_lat.flags.writeable


# --------------------------------------------------------------------------- #
# Directed cost over undirected topology
# --------------------------------------------------------------------------- #


def test_reverse_half_edge_swaps_ascent_and_descent() -> None:
    graph = bf.graph_from_bytes(bf.graph_to_bytes(make_tiny_graph()))

    halves: dict[int, list[tuple[int, int, float, float]]] = {}
    for u in range(graph.node_count):
        for i in range(int(graph.csr_offset[u]), int(graph.csr_offset[u + 1])):
            eid = int(graph.edge_id[i])
            halves.setdefault(eid, []).append(
                (u, int(graph.edge_target[i]), float(graph.edge_ascent[i]), float(graph.edge_descent[i]))
            )

    assert len(halves) == 4
    for eid, entries in halves.items():
        assert len(entries) == 2, f"edge {eid} should have exactly two halves"
        (u1, v1, asc1, desc1), (u2, v2, asc2, desc2) = entries
        assert (u1, v1) == (v2, u2)
        assert asc1 == desc2 and desc1 == asc2


def test_ascent_minus_descent_telescopes_to_delta_h() -> None:
    """The invariant that breaks first if anyone recomputes ascent from endpoints."""
    graph = bf.graph_from_bytes(bf.graph_to_bytes(make_tiny_graph()))
    for u in range(graph.node_count):
        for i in range(int(graph.csr_offset[u]), int(graph.csr_offset[u + 1])):
            v = int(graph.edge_target[i])
            delta = float(graph.node_elev[v]) - float(graph.node_elev[u])
            net = float(graph.edge_ascent[i]) - float(graph.edge_descent[i])
            assert net == pytest.approx(delta, abs=1e-3), f"edge {u}->{v}"


def test_edge_with_a_bump_keeps_ascent_above_delta_h() -> None:
    """e3 (node 2 -> 3) dips 4 m before climbing: ascent 39 for a 35 m net gain."""
    graph = bf.graph_from_bytes(bf.graph_to_bytes(make_tiny_graph()))
    for i in range(int(graph.csr_offset[2]), int(graph.csr_offset[3])):
        if int(graph.edge_target[i]) == 3:
            assert float(graph.edge_ascent[i]) == 39.0
            assert float(graph.edge_descent[i]) == 4.0
            assert float(graph.node_elev[3]) - float(graph.node_elev[2]) == 35.0
            return
    pytest.fail("edge 2->3 not found")


# --------------------------------------------------------------------------- #
# Slope quantisation
# --------------------------------------------------------------------------- #


@pytest.mark.parametrize(
    ("pct", "expected"),
    [
        (0.0, 0), (0.1, 0), (0.125, 0), (0.2, 1), (0.25, 1), (0.3, 1),
        (5.0, 20), (12.5, 50), (63.75, 255), (100.0, 255),
        (-3.0, 0),  # a descent stores as zero: uphill only
        (float("nan"), 0),
    ],
)
def test_encode_max_slope(pct: float, expected: int) -> None:
    assert bf.encode_max_slope(pct) == expected


def test_decode_max_slope_is_exact_in_f64() -> None:
    """0.25 is a power of two, so no rounding can differ between Python and V8."""
    for v in range(256):
        assert bf.decode_max_slope(v) * 4.0 == float(v)


@pytest.mark.parametrize(
    ("u8", "limit", "skip"),
    [
        (40, 10.0, False),  # 10.00 % vs limit 10 -> allowed, not strictly greater
        (41, 10.0, True),   # 10.25 % -> filtered
        (0, 0.0, False),    # flat survives a 0 % limit
        (1, 0.0, True),
        (255, 63.75, False),
        (255, 63.74, True),
    ],
)
def test_slope_exceeds_boundaries(u8: int, limit: float, skip: bool) -> None:
    assert bf.slope_exceeds(u8, limit) is skip


# --------------------------------------------------------------------------- #
# Corruption: every mode has its own error type
# --------------------------------------------------------------------------- #


def _corrupt(data: bytes, offset: int, replacement: bytes) -> bytes:
    return data[:offset] + replacement + data[offset + len(replacement):]


def test_bad_magic() -> None:
    data = _corrupt(bf.graph_to_bytes(make_tiny_graph()), 0, b"NOTAGRPH")
    with pytest.raises(bf.BadMagicError):
        bf.graph_from_bytes(data)


def test_unsupported_version() -> None:
    data = _corrupt(bf.graph_to_bytes(make_tiny_graph()), 8, struct.pack("<I", 2))
    with pytest.raises(bf.UnsupportedVersionError):
        bf.graph_from_bytes(data)


def test_unsupported_header_size() -> None:
    data = _corrupt(bf.graph_to_bytes(make_tiny_graph()), 12, struct.pack("<I", 192))
    with pytest.raises(bf.UnsupportedVersionError):
        bf.graph_from_bytes(data)


def test_buffer_shorter_than_header() -> None:
    with pytest.raises(bf.TruncatedFileError):
        bf.graph_from_bytes(bf.graph_to_bytes(make_tiny_graph())[:100])


def test_truncated_body_is_caught_by_file_size() -> None:
    with pytest.raises(bf.TruncatedFileError):
        bf.graph_from_bytes(bf.graph_to_bytes(make_tiny_graph())[:-8])


def test_misaligned_section_offset() -> None:
    data = bf.graph_to_bytes(make_tiny_graph())
    first = struct.unpack_from("<I", data, 88)[0]
    data = _corrupt(data, 88, struct.pack("<I", first + 2))
    with pytest.raises(bf.TruncatedFileError, match="aligned"):
        bf.graph_from_bytes(data, verify_checksum=False)


def test_section_running_past_the_buffer() -> None:
    data = bf.graph_to_bytes(make_tiny_graph())
    data = _corrupt(data, 88 + 4 * bf.Section.GRID_NODEID, struct.pack("<I", len(data) - 8))
    with pytest.raises(bf.TruncatedFileError, match="past"):
        bf.graph_from_bytes(data, verify_checksum=False)


def test_flipped_payload_byte_is_caught_by_crc() -> None:
    data = bytearray(bf.graph_to_bytes(make_tiny_graph()))
    data[bf.HEADER_SIZE + 3] ^= 0x01
    with pytest.raises(bf.ChecksumError):
        bf.graph_from_bytes(bytes(data))


def test_checksum_check_can_be_skipped() -> None:
    """The Worker may trade integrity for ~80 ms on a 60 MB graph; that is opt-in."""
    data = bytearray(bf.graph_to_bytes(make_tiny_graph()))
    data[bf.HEADER_SIZE + 3] ^= 0x01
    bf.graph_from_bytes(bytes(data), verify_checksum=False, validate=False)


def test_geom_edge_count_disagreeing_with_edge_ids() -> None:
    data = _corrupt(bf.graph_to_bytes(make_tiny_graph()), 72, struct.pack("<I", 9))
    with pytest.raises(bf.GraphValidationError, match="geom_edge_count"):
        bf.graph_from_bytes(data)


# --------------------------------------------------------------------------- #
# validate_graph
# --------------------------------------------------------------------------- #


def _with(graph: bf.Graph, **overrides) -> bf.Graph:
    fields = {f: getattr(graph, f) for f in ARRAY_FIELDS}
    fields |= {
        "region_id": graph.region_id,
        "bbox": graph.bbox,
        "grid_nx": graph.grid_nx,
        "grid_ny": graph.grid_ny,
        "flags": graph.flags,
    }
    return bf.Graph(**(fields | overrides))


def test_validate_accepts_the_fixture() -> None:
    bf.validate_graph(make_tiny_graph())


def test_validate_rejects_csr_terminator_mismatch() -> None:
    graph = make_tiny_graph()
    broken = graph.csr_offset.copy()
    broken[-1] = 7
    with pytest.raises(bf.GraphValidationError, match="csr_offset"):
        bf.validate_graph(_with(graph, csr_offset=broken))


def test_validate_rejects_out_of_range_edge_target() -> None:
    graph = make_tiny_graph()
    broken = graph.edge_target.copy()
    broken[0] = 99
    with pytest.raises(bf.GraphValidationError, match="edge_target"):
        bf.validate_graph(_with(graph, edge_target=broken))


def test_validate_rejects_nan_elevation() -> None:
    graph = make_tiny_graph()
    broken = graph.node_elev.copy()
    broken[2] = np.nan
    with pytest.raises(bf.GraphValidationError, match="NaN"):
        bf.validate_graph(_with(graph, node_elev=broken))


def test_validate_rejects_implausible_elevation() -> None:
    graph = make_tiny_graph()
    broken = graph.node_elev.copy()
    broken[1] = 12000.0
    with pytest.raises(bf.GraphValidationError, match="plausible range"):
        bf.validate_graph(_with(graph, node_elev=broken))


def test_validate_rejects_zero_length_edge() -> None:
    graph = make_tiny_graph()
    broken = graph.edge_dist.copy()
    broken[0] = 0.0
    with pytest.raises(bf.GraphValidationError, match="zero-length"):
        bf.validate_graph(_with(graph, edge_dist=broken))


def test_validate_rejects_an_edge_shorter_than_its_own_chord() -> None:
    """The A* admissibility invariant: dist must never undercut the great circle.

    A build pipeline that measures polylines in f64 and stores endpoints in f32
    can produce this by rounding alone, and the symptom would otherwise be silent:
    A* quietly returning routes that are a few metres worse than optimal.
    """
    graph = make_tiny_graph()
    broken = graph.edge_dist.copy()
    broken[0] = 40.0  # well under the 76.57 m chord
    with pytest.raises(bf.GraphValidationError, match="admissibility"):
        bf.validate_graph(_with(graph, edge_dist=broken))


def test_validate_accepts_dist_equal_to_the_chord() -> None:
    """A dead-straight edge is legal; only *undercutting* the chord is not."""
    graph = make_tiny_graph()
    exact = graph.edge_dist.copy()
    chord = haversine_m(
        float(graph.node_lat[0]), float(graph.node_lon[0]),
        float(graph.node_lat[1]), float(graph.node_lon[1]),
    )
    for i in range(graph.dir_edge_count):
        if {int(graph.edge_target[i])} <= {0, 1} and float(graph.edge_dist[i]) == 78.0:
            exact[i] = np.float32(chord)
    bf.validate_graph(_with(graph, edge_dist=exact))


def test_validate_rejects_negative_ascent() -> None:
    graph = make_tiny_graph()
    broken = graph.edge_ascent.copy()
    broken[0] = -1.0
    with pytest.raises(bf.GraphValidationError, match="negative"):
        bf.validate_graph(_with(graph, edge_ascent=broken))


def test_validate_rejects_grid_nodeid_that_drops_a_node() -> None:
    """A duplicated id means some node can never be snapped to -- silent, not loud."""
    graph = make_tiny_graph()
    broken = graph.grid_nodeid.copy()
    broken[0] = broken[1]
    with pytest.raises(bf.GraphValidationError, match="permutation"):
        bf.validate_graph(_with(graph, grid_nodeid=broken))


def test_validate_rejects_node_filed_under_the_wrong_cell() -> None:
    graph = make_tiny_graph()
    broken = graph.grid_nodeid.copy()
    broken[0], broken[3] = broken[3], broken[0]
    with pytest.raises(bf.GraphValidationError, match="wrong cell"):
        bf.validate_graph(_with(graph, grid_nodeid=broken))


def test_validate_rejects_bbox_that_excludes_a_node() -> None:
    graph = make_tiny_graph()
    with pytest.raises(bf.GraphValidationError, match="bbox"):
        bf.validate_graph(_with(graph, bbox=(8.0, 46.5, 8.0005, 46.501)))


def test_validate_rejects_inverted_bbox() -> None:
    graph = make_tiny_graph()
    with pytest.raises(bf.GraphValidationError, match="inverted"):
        bf.validate_graph(_with(graph, bbox=(8.001, 46.5, 8.0, 46.501)))


def test_region_id_longer_than_the_field() -> None:
    graph = _with(make_tiny_graph(), region_id="a-region-name-far-too-long")
    with pytest.raises(bf.BinFormatError, match="region_id"):
        bf.graph_to_bytes(graph)


# --------------------------------------------------------------------------- #
# Grid helpers
# --------------------------------------------------------------------------- #


def test_grid_index_files_every_node_exactly_once() -> None:
    graph = make_tiny_graph()
    counts = np.diff(graph.grid_offset.astype(np.int64))
    assert counts.sum() == graph.node_count
    assert sorted(graph.grid_nodeid.tolist()) == list(range(graph.node_count))


def test_point_on_the_bbox_maximum_clamps_into_the_last_cell() -> None:
    """Border snapping: the top-right corner must not index a cell that isn't there."""
    bbox = (8.0, 46.5, 8.001, 46.501)
    cell = bf.cell_of_point_array(
        np.array([46.501], dtype=np.float64), np.array([8.001], dtype=np.float64), bbox, 2, 2
    )
    assert int(cell[0]) == 3  # iy=1, ix=1


def test_points_outside_the_bbox_clamp_rather_than_wrap() -> None:
    bbox = (8.0, 46.5, 8.001, 46.501)
    lat = np.array([46.0, 47.0, 46.0, 47.0], dtype=np.float64)
    lon = np.array([7.0, 9.0, 9.0, 7.0], dtype=np.float64)
    cells = bf.cell_of_point_array(lat, lon, bbox, 2, 2)
    assert cells.tolist() == [0, 3, 1, 2]


def test_choose_grid_dims_targets_the_requested_occupancy() -> None:
    bbox = (5.9, 45.8, 10.5, 47.8)  # Switzerland
    nx, ny = bf.choose_grid_dims(1_000_000, bbox, target_per_cell=4.0)
    assert 0.8 <= (nx * ny) / 250_000 <= 1.25
    # Cells should be roughly square in metres, not in degrees.
    aspect_m = ((10.5 - 5.9) * np.cos(np.radians(46.8)) / nx) / ((47.8 - 45.8) / ny)
    assert 0.8 <= aspect_m <= 1.25
