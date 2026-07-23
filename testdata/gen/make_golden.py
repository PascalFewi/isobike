"""Generate ``testdata/ridge_world/{graph.bin,expected.json}``.

Run ``python -m testdata.gen.make_golden`` to regenerate, or with ``--check`` to
assert the committed files are current (what CI and the test suite use).

Both outputs are committed. ``graph.bin`` is written by Python and read by
TypeScript, so it is the actual interoperability artefact; ``expected.json`` is
the answer key.

Float encoding
==============

Costs are asserted for *bit* equality across languages, so the JSON must
round-trip f64 exactly. It does: Python's ``repr`` and JavaScript's
``Number.prototype.toString`` both emit the shortest decimal that round-trips to
the same double, and ``JSON.parse`` recovers it exactly.

Two things are deliberately kept out of the JSON. ``Infinity`` is not valid JSON
and ``JSON.parse`` rejects it, so "no budget" and "no slope limit" are encoded as
``null``. And unreachable routes are ``{"found": false}`` rather than a cost of
infinity, because the API returns an absence, not a number.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import sys
from pathlib import Path
from typing import Any

from build import binformat as bf
from build.geo import R_EARTH_M
from testdata.gen import reference_router as rr
from testdata.gen import ridge_world as rwmod
from testdata.gen.ridge_world import build_ridge_world

OUT_DIR = Path(__file__).resolve().parents[2] / "testdata" / "ridge_world"
GRAPH_PATH = OUT_DIR / "graph.bin"
EXPECTED_PATH = OUT_DIR / "expected.json"

#: (climb_factor, max_slope_pct or None). The same sweep the Python suite uses,
#: so a TypeScript failure can be reproduced in Python without translation.
ROUTE_CONFIGS: list[tuple[float, float | None]] = [
    (0.0, None),
    (5.0, None),
    (60.0, None),
    (200.0, None),
    (0.0, 12.0),
    (20.0, 8.0),
    (60.0, 6.0),
]


def _route_pairs(world: rwmod.RidgeWorld) -> list[tuple[str, int, int]]:
    """Named source/target pairs, each chosen to exercise a distinct behaviour."""
    return [
        ("across-the-ridge", world.lattice_node(1, 13), world.lattice_node(20, 13)),
        ("across-reversed", world.lattice_node(20, 13), world.lattice_node(1, 13)),
        ("through-the-pass", world.lattice_node(1, 10), world.lattice_node(20, 10)),
        ("long-diagonal", world.lattice_node(0, 0), world.lattice_node(21, 15)),
        ("diagonal-reversed", world.lattice_node(21, 15), world.lattice_node(0, 0)),
        ("valley-run", world.lattice_node(0, 4), world.lattice_node(0, 14)),
        ("uphill-flank", world.lattice_node(0, 6), world.lattice_node(9, 6)),
        ("downhill-flank", world.lattice_node(9, 6), world.lattice_node(0, 6)),
        ("onto-the-bump", world.bump_anchor, world.bump_b),
        ("off-the-bump", world.bump_b, world.bump_anchor),
        ("to-self", 100, 100),
        ("to-the-island", 0, world.island[0]),
        ("from-the-island", world.island[0], 0),
        ("within-the-island", world.island[0], world.island[2]),
    ]


def _snap_probes(graph: bf.Graph) -> list[tuple[float, float]]:
    """Interior sweep, exact bbox border, and points outside in every direction."""
    min_lon, min_lat, max_lon, max_lat = graph.bbox
    mid_lat = (min_lat + max_lat) / 2.0
    mid_lon = (min_lon + max_lon) / 2.0

    probes: list[tuple[float, float]] = []
    # Offsets are irrational-ish fractions so probes never land exactly between
    # two nodes, which would make the expected answer a tie-break artefact.
    for i in range(17):
        for j in range(13):
            probes.append(
                (
                    min_lat + (max_lat - min_lat) * (i + 0.37) / 17.0,
                    min_lon + (max_lon - min_lon) * (j + 0.61) / 13.0,
                )
            )
    probes += [
        (min_lat, min_lon), (min_lat, max_lon), (max_lat, min_lon), (max_lat, max_lon),
        (min_lat, mid_lon), (max_lat, mid_lon), (mid_lat, min_lon), (mid_lat, max_lon),
    ]
    for d in (0.001, 0.05, 0.5):
        probes += [
            (min_lat - d, mid_lon), (max_lat + d, mid_lon),
            (mid_lat, min_lon - d), (mid_lat, max_lon + d),
            (min_lat - d, min_lon - d), (max_lat + d, max_lon + d),
        ]
    return probes


def _field_configs(
    world: rwmod.RidgeWorld,
) -> list[tuple[int, float, float | None, float | None]]:
    """(source, climb_factor, max_slope_pct, max_cost)."""
    return [
        (0, 10.0, None, None),
        (0, 0.0, None, 5000.0),
        (world.lattice_node(11, 8), 60.0, 8.0, None),
        (world.lattice_node(11, 8), 0.0, None, 2000.0),
        (world.bump_b, 25.0, None, None),
        (world.island[0], 10.0, None, None),
    ]


def build_expected(world: rwmod.RidgeWorld, graph_bytes: bytes) -> dict[str, Any]:
    graph = world.graph
    flat = rr.flatten(graph)

    routes: list[dict[str, Any]] = []
    for name, src, dst in _route_pairs(world):
        for climb_factor, max_slope in ROUTE_CONFIGS:
            result = rr.route(flat, src, dst, climb_factor, max_slope_pct=max_slope)
            entry: dict[str, Any] = {
                "name": name,
                "from": src,
                "to": dst,
                "climb_factor": climb_factor,
                "max_slope_pct": max_slope,
            }
            if result is None:
                entry["found"] = False
            else:
                entry |= {
                    "found": True,
                    "cost": result.cost,
                    "dist_m": result.dist_m,
                    "ascent_m": result.ascent_m,
                    "descent_m": result.descent_m,
                    "result_max_slope_pct": result.max_slope_pct,
                    "nodes": result.nodes,
                    "edge_ids": result.edge_ids,
                }
            routes.append(entry)

    snaps = [
        {"lat": lat, "lon": lon, "node": rr.snap_bruteforce(flat, lat, lon)}
        for lat, lon in _snap_probes(graph)
    ]

    fields: list[dict[str, Any]] = []
    for src, climb_factor, max_slope, max_cost in _field_configs(world):
        field = rr.effort_field(
            flat,
            src,
            climb_factor,
            max_slope_pct=max_slope,
            max_cost=math.inf if max_cost is None else max_cost,
        )
        fields.append(
            {
                "source": src,
                "climb_factor": climb_factor,
                "max_slope_pct": max_slope,
                "max_cost": max_cost,
                "edge_count": len(field),
                # Full dump, not a sample: this is the artefact the frontend
                # joins onto tiles, so every entry is worth pinning.
                "entries": [[eid, field[eid]] for eid in sorted(field)],
            }
        )

    return {
        "schema": 1,
        "generator": "testdata/gen/make_golden.py",
        "region_id": graph.region_id,
        "constants": {
            "r_earth_m": R_EARTH_M,
            "h_safety": rr.H_SAFETY,
            "slope_step_pct": bf.SLOPE_STEP_PCT,
            "bump_height_m": rwmod.BUMP_HEIGHT_M,
        },
        "graph": {
            "sha256": hashlib.sha256(graph_bytes).hexdigest(),
            "byte_length": len(graph_bytes),
            "format_version": bf.FORMAT_VERSION,
            "node_count": graph.node_count,
            "dir_edge_count": graph.dir_edge_count,
            "geom_edge_count": graph.geom_edge_count,
            "grid_nx": graph.grid_nx,
            "grid_ny": graph.grid_ny,
            "bbox": list(graph.bbox),
        },
        "fixtures": {
            "bump_anchor": world.bump_anchor,
            "bump_a": world.bump_a,
            "bump_b": world.bump_b,
            "island": list(world.island),
        },
        "snap": snaps,
        "routes": routes,
        "effort_fields": fields,
    }


def render(world: rwmod.RidgeWorld) -> tuple[bytes, bytes]:
    """Return the exact bytes of ``(graph.bin, expected.json)``."""
    graph_bytes = bf.graph_to_bytes(world.graph)
    expected = build_expected(world, graph_bytes)
    # allow_nan=False makes a stray Infinity a hard error rather than output that
    # JSON.parse would reject only once TypeScript tried to read it.
    text = json.dumps(expected, indent=1, sort_keys=True, allow_nan=False) + "\n"
    return graph_bytes, text.encode("utf-8")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--check",
        action="store_true",
        help="fail if the committed files differ from freshly generated ones",
    )
    args = parser.parse_args(argv)

    world = build_ridge_world()
    bf.validate_graph(world.graph)
    graph_bytes, json_bytes = render(world)

    if args.check:
        stale = [
            path.name
            for path, expected in ((GRAPH_PATH, graph_bytes), (EXPECTED_PATH, json_bytes))
            if not path.exists() or path.read_bytes() != expected
        ]
        if stale:
            print(f"stale golden files: {', '.join(stale)}", file=sys.stderr)
            print("regenerate with: python -m testdata.gen.make_golden", file=sys.stderr)
            return 1
        print("golden files are current")
        return 0

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    GRAPH_PATH.write_bytes(graph_bytes)
    EXPECTED_PATH.write_bytes(json_bytes)
    print(f"wrote {GRAPH_PATH} ({len(graph_bytes)} bytes)")
    print(f"wrote {EXPECTED_PATH} ({len(json_bytes)} bytes)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
