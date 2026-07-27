"""Build orchestrator (build pipeline entry point).

Run as a module from the repo root (``build`` collides with the PyPI package if
you run the file directly):

    python -m build.build_graph --region test-oberland --pbf switzerland-latest.osm.pbf
    python -m build.build_graph --region switzerland  --pbf switzerland-latest.osm.pbf

Sequences the stages -- OSM load -> DEM sample -> collapse -> export -- with a
**resumable cache** under ``build/cache/<region>/``: the OSM and DEM stages are the
slow ones, so their outputs are pickled and reused on a re-run unless ``--force``.
The stage functions are the tested pure/near-pure ones from the other modules;
this file is the glue plus progress logging plus the two external-tool shells
(``tippecanoe`` for PMTiles, ``wrangler`` for the R2 upload), which only run when
explicitly asked for.

Develop against a small ``--region`` first; the Switzerland run is an overnight
job. Only the OSM/DEM/tippecanoe/upload steps need real data and heavy deps --
everything that shapes the bytes is covered by the unit suite.
"""

from __future__ import annotations

import argparse
import pickle
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Final

from build import export as export_mod
from build.collapse import (
    DEFAULT_MIN_COMPONENT_NODES,
    collapse_degree2,
    prune_small_components,
)
from build.dem import MeasuredNetwork, Sampler, make_sampler, measure_network
from build.osm_load import RawNetwork, load_bike_network

#: Where downloaded PBFs/DEM tiles and stage pickles live. Git-ignored.
DEFAULT_CACHE: Final = Path(__file__).resolve().parent / "cache"
DEFAULT_OUT: Final = Path(__file__).resolve().parent / "out"


@dataclass(frozen=True)
class RegionSpec:
    """A build target: a region id and the OSM extent it covers."""

    name: str
    #: (min_lon, min_lat, max_lon, max_lat), or None for the whole PBF.
    bbox: tuple[float, float, float, float] | None
    #: Region id stored in graph.bin (<= 16 ASCII bytes). Europe-shard ready.
    region_id: str


#: Named build targets. The small one is for developing/verifying the pipeline in
#: minutes; ``switzerland`` is the overnight national run.
REGIONS: Final[dict[str, RegionSpec]] = {
    "switzerland": RegionSpec("switzerland", bbox=None, region_id="CH"),
    # A small Bernese Oberland box (Thun-Interlaken): real terrain, minutes to build.
    "test-oberland": RegionSpec(
        "test-oberland", bbox=(7.55, 46.60, 7.95, 46.80), region_id="test-oberland"
    ),
}


def resolve_region(name: str) -> RegionSpec:
    if name not in REGIONS:
        raise ValueError(f"unknown region {name!r}; known: {', '.join(sorted(REGIONS))}")
    return REGIONS[name]


# --------------------------------------------------------------------------- #
# Resumable stage cache
# --------------------------------------------------------------------------- #


def _log(msg: str) -> None:
    print(f"[build] {msg}", file=sys.stderr, flush=True)


def _cached_stage(path: Path, force: bool, produce: Callable[[], object], label: str) -> object:
    """Return a pickled stage output, or produce+cache it. The resumable core."""
    if path.exists() and not force:
        _log(f"{label}: reusing cache {path.name}")
        with path.open("rb") as fh:
            return pickle.load(fh)
    _log(f"{label}: computing...")
    started = time.perf_counter()
    result = produce()
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("wb") as fh:
        pickle.dump(result, fh, protocol=pickle.HIGHEST_PROTOCOL)
    _log(f"{label}: done in {time.perf_counter() - started:.1f}s -> {path.name}")
    return result


# --------------------------------------------------------------------------- #
# Pipeline
# --------------------------------------------------------------------------- #


def run_pipeline(
    region: RegionSpec,
    *,
    build_date: str,
    cache_dir: Path,
    out_dir: Path,
    load_fn: Callable[[], RawNetwork],
    sampler: Sampler,
    force: bool = False,
    min_component_nodes: int = DEFAULT_MIN_COMPONENT_NODES,
):
    """Run OSM -> DEM -> collapse -> prune -> export, caching the two slow stages.

    ``load_fn`` and ``sampler`` are injected so the sequencing and caching are
    testable with synthetic data; ``main`` wires the real pyrosm loader and the
    DEM sampler.
    """
    region_cache = cache_dir / region.name
    region_out = out_dir / region.name

    raw = _cached_stage(region_cache / "raw.pkl", force, load_fn, "osm load")
    assert isinstance(raw, RawNetwork)
    _log(f"osm load: {raw.node_count} nodes, {raw.edge_count} edges")

    measured = _cached_stage(
        region_cache / "measured.pkl", force, lambda: measure_network(raw, sampler), "dem sample"
    )
    assert isinstance(measured, MeasuredNetwork)

    _log("collapse: merging degree-2 chains...")
    collapsed = collapse_degree2(measured)
    _log(f"collapse: {measured.edge_count} -> {collapsed.edge_count} edges")

    _log(f"prune: dropping components < {min_component_nodes} nodes...")
    pruned = prune_small_components(collapsed, min_component_nodes)
    _log(f"prune: {collapsed.node_count} -> {pruned.node_count} nodes, "
         f"{collapsed.edge_count} -> {pruned.edge_count} edges")

    _log("export: writing graph.bin, network.geojson, meta.json...")
    graph = export_mod.export(
        pruned, region_out, region_id=region.region_id, build_date=build_date
    )
    _log(
        f"export: {graph.node_count} nodes, {graph.geom_edge_count} edges, "
        f"{graph.dir_edge_count} directed -> {region_out}"
    )
    return graph


# --------------------------------------------------------------------------- #
# External-tool shells (run only when asked; need WSL/wrangler)
# --------------------------------------------------------------------------- #


def tippecanoe_command(geojson: Path, pmtiles: Path) -> str:
    """The tippecanoe invocation for the network GeoJSON -> PMTiles.

    `-zg` auto-picks max zoom; `--drop-densest-as-needed` keeps dense areas within
    tile size limits; the effort-colouring wants edges legible from mid zoom out.
    tippecanoe is Unix-only (native on a Linux server/Colab; WSL on Windows).
    """
    return (
        f"tippecanoe -o {pmtiles} -l network -zg --drop-densest-as-needed "
        f"--extend-zooms-if-still-dropping {geojson}"
    )


def upload_commands(out_dir: Path, bucket: str) -> list[str]:
    """S3-style upload commands for the three artefacts (portable across servers).

    Uses the R2 S3 endpoint via aws-cli, so it works headless anywhere with R2 API
    credentials in the environment -- no interactive `wrangler login`. Set
    ``AWS_ACCESS_KEY_ID`` / ``AWS_SECRET_ACCESS_KEY`` to an R2 token and
    ``R2_ENDPOINT`` to ``https://<accountid>.r2.cloudflarestorage.com``.
    """
    ep = "$R2_ENDPOINT"
    return [
        f"aws s3 cp {out_dir / name} s3://{bucket}/{name} --endpoint-url {ep}"
        for name in ("graph.bin", "meta.json", "network.pmtiles")
    ]


# --------------------------------------------------------------------------- #
# CLI
# --------------------------------------------------------------------------- #


def main(argv: list[str] | None = None) -> int:  # pragma: no cover - CLI wiring
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--region", required=True, help=f"one of: {', '.join(sorted(REGIONS))}")
    parser.add_argument("--pbf", help="path to the OSM .pbf (Geofabrik switzerland-latest.osm.pbf)")
    parser.add_argument("--cache", type=Path, default=DEFAULT_CACHE)
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT)
    parser.add_argument("--force", action="store_true", help="ignore the stage cache")
    parser.add_argument(
        "--dem", default="glo30", choices=["glo30", "swissalti3d"],
        help="DEM source: glo30 (default, ~30 m, global, small) or swissalti3d (2 m, CH, ~40 GB)",
    )
    parser.add_argument("--upload", metavar="BUCKET", help="print R2 upload commands for the outputs")
    parser.add_argument(
        "--min-component", type=int, default=DEFAULT_MIN_COMPONENT_NODES,
        help="drop weakly-connected components smaller than this (routing-graph cleanup)",
    )
    args = parser.parse_args(argv)

    region = resolve_region(args.region)
    if args.pbf is None:
        parser.error("--pbf is required for a real build (Geofabrik switzerland-latest.osm.pbf)")

    from datetime import date

    sampler = make_sampler(args.dem, str(args.cache / "dem"))
    graph = run_pipeline(
        region,
        build_date=date.today().isoformat(),
        cache_dir=args.cache,
        out_dir=args.out,
        load_fn=lambda: load_bike_network(args.pbf, bbox=region.bbox),
        sampler=sampler,
        force=args.force,
        min_component_nodes=args.min_component,
    )

    region_out = args.out / region.name
    _log("next -- build PMTiles then upload (or use build/run_build.sh / the Colab notebook):")
    _log("  " + tippecanoe_command(region_out / "network.geojson", region_out / "network.pmtiles"))
    if args.upload:
        for cmd in upload_commands(region_out, args.upload):
            _log("  " + cmd)
    return 0 if graph.node_count else 1


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
