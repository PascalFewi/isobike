"""The committed golden files must match what the generator produces right now.

Without this, editing the generator or the terrain silently desynchronises the
Python source of truth from the bytes TypeScript is asserting against -- and the
TypeScript suite would keep passing against a stale answer key.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from build import binformat as bf
from testdata.gen import make_golden
from testdata.gen.ridge_world import build_ridge_world


@pytest.fixture(scope="module")
def rendered() -> tuple[bytes, bytes]:
    return make_golden.render(build_ridge_world())


def test_golden_files_exist() -> None:
    assert make_golden.GRAPH_PATH.exists(), "run: python -m testdata.gen.make_golden"
    assert make_golden.EXPECTED_PATH.exists(), "run: python -m testdata.gen.make_golden"


def test_committed_graph_bin_is_current(rendered: tuple[bytes, bytes]) -> None:
    assert make_golden.GRAPH_PATH.read_bytes() == rendered[0]


def test_committed_expected_json_is_current(rendered: tuple[bytes, bytes]) -> None:
    assert make_golden.EXPECTED_PATH.read_bytes() == rendered[1]


def test_generation_is_reproducible() -> None:
    """Two renders of two independent builds must be byte-identical."""
    a = make_golden.render(build_ridge_world())
    b = make_golden.render(build_ridge_world())
    assert a == b


def test_committed_graph_parses_and_validates() -> None:
    graph = bf.read_graph(make_golden.GRAPH_PATH)
    bf.validate_graph(graph)
    assert graph.region_id == "ridge-world"


def test_expected_json_declares_the_graph_it_was_built_from() -> None:
    """A sha mismatch means the two artefacts drifted apart -- worse than either
    being stale, because the pairing is what makes them meaningful."""
    import hashlib

    expected = json.loads(make_golden.EXPECTED_PATH.read_text(encoding="utf-8"))
    raw = make_golden.GRAPH_PATH.read_bytes()
    assert expected["graph"]["sha256"] == hashlib.sha256(raw).hexdigest()
    assert expected["graph"]["byte_length"] == len(raw)


def test_expected_json_contains_no_non_finite_literals() -> None:
    """`Infinity` and `NaN` are not JSON; JSON.parse would reject the file."""
    text = Path(make_golden.EXPECTED_PATH).read_text(encoding="utf-8")
    for token in ("Infinity", "NaN", "-Infinity"):
        assert token not in text


def test_expected_json_covers_the_cases_that_matter() -> None:
    expected = json.loads(make_golden.EXPECTED_PATH.read_text(encoding="utf-8"))

    assert len(expected["snap"]) > 200
    assert len(expected["routes"]) > 80
    assert len(expected["effort_fields"]) >= 5

    # Both outcomes of /route must be pinned, not just the happy path.
    assert any(r["found"] for r in expected["routes"])
    assert any(not r["found"] for r in expected["routes"])

    # Slope-filtered and unfiltered configurations must both appear.
    assert any(r["max_slope_pct"] is None for r in expected["routes"])
    assert any(r["max_slope_pct"] is not None for r in expected["routes"])

    # A budgeted and an unbudgeted effort field.
    assert any(f["max_cost"] is None for f in expected["effort_fields"])
    assert any(f["max_cost"] is not None for f in expected["effort_fields"])

    # Probes outside the bbox, where naive snapping goes wrong.
    min_lon, min_lat, max_lon, max_lat = expected["graph"]["bbox"]
    outside = [
        p
        for p in expected["snap"]
        if not (min_lat <= p["lat"] <= max_lat and min_lon <= p["lon"] <= max_lon)
    ]
    assert len(outside) >= 15


def test_float_values_round_trip_through_json() -> None:
    """Costs are asserted bit-exactly in TypeScript, so the encoding must be lossless."""
    text = make_golden.EXPECTED_PATH.read_text(encoding="utf-8")
    assert json.dumps(json.loads(text), indent=1, sort_keys=True, allow_nan=False) + "\n" == text
