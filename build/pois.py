"""OSM PBF -> cycling points of interest (a map overlay, not routing data).

What a rider looks for on a tour: bike services (water, repair, pumps, shops,
rental, e-bike charging, parking), food (shops, cafés, restaurants), a bed, a
toilet, a roof against the rain. Written as a point GeoJSON that tippecanoe
turns into ``pois.pmtiles``; the frontend draws them over every background as
icons with a popup.

Split like ``osm_load.py``:

* **Pure tag logic** -- :func:`classify_poi` and :func:`poi_properties`, plain
  functions of a tag dict, unit-tested without a PBF.
* **Loader shell** -- :func:`load_pois` reads the PBF with ``pyrosm`` (lazy
  import) and applies them. A shop or water point mapped as an area becomes a
  point inside it.

Independent of the routing graph and the DEM, so it runs on its own in a few
minutes and can be refreshed without rebuilding ``graph.bin``::

    python -m build.pois --region switzerland --pbf build/cache/switzerland-latest.osm.pbf
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any, Final, Mapping

#: An OSM element's tags. Values are strings as they appear in OSM.
Tags = Mapping[str, str]

#: The overlay's kinds, in the frontend's legend order -- which is also the
#: priority where icons collide on the map (water beats a restaurant).
POI_KINDS: Final = (
    "water", "repair", "pump", "shop", "rental", "charging", "parking",
    "food", "cafe", "restaurant", "lodging", "toilets", "shelter",
)

#: First zoom each kind shows at -- the same numbers as ``POI_INFO`` in
#: frontend/src/lib/pois.ts. The tiles leave a kind out below it (tippecanoe
#: ``minzoom``), so the dense kinds (restaurants, toilets, parking) cost nothing
#: when zoomed out. The tiles span zoom 10 to TILE_MAXZOOM; a kind from a later
#: zoom sits in the TILE_MAXZOOM tiles, which MapLibre overzooms.
KIND_MINZOOM: Final[dict[str, int]] = {
    "water": 13, "repair": 12, "pump": 13, "shop": 12, "rental": 13, "charging": 13,
    "parking": 15, "food": 13, "cafe": 14, "restaurant": 15, "lodging": 13,
    "toilets": 15, "shelter": 14,
}

TILE_MINZOOM: Final = 10
TILE_MAXZOOM: Final = 14

#: ``amenity`` values that are a kind on their own.
_AMENITY_KINDS: Final[dict[str, str]] = {
    "drinking_water": "water",
    "bicycle_repair_station": "repair",
    "compressed_air": "pump",
    "bicycle_rental": "rental",
    "bicycle_parking": "parking",
    "cafe": "cafe",
    "restaurant": "restaurant",
    "toilets": "toilets",
}

#: ``shop`` values for buying food on the way, one kind together.
FOOD_SHOPS: Final = frozenset({"supermarket", "convenience", "bakery"})

#: ``tourism`` values with a bed (or a pitch) for the night.
LODGING: Final = frozenset(
    {"hotel", "motel", "hostel", "guest_house", "camp_site", "alpine_hut", "wilderness_hut"}
)

#: ``shelter_type`` values that are no rider's shelter: bus stops, cattle sheds.
_NOT_A_SHELTER: Final = frozenset({"public_transport", "field_shelter"})

#: Values of ``bicycle`` that make a charging station one for e-bikes.
_BIKE_YES: Final = frozenset({"yes", "designated"})

#: ``access`` values that close a point to the public.
_PRIVATE: Final = frozenset({"private", "no", "customers"})


def classify_poi(tags: Tags) -> str | None:
    """The overlay kind of an OSM element, or ``None`` when it is not one.

    Water counts when it is drinkable: ``amenity=drinking_water``, or a fountain
    or tap tagged ``drinking_water=yes`` -- most Swiss village fountains are
    mapped that way. A charging station counts only when it is for bikes. A
    hotel with a restaurant is lodging: the bed is the rarer find. Anything
    private is left out: a rider cannot use it.
    """
    if tags.get("access") in _PRIVATE:
        return None
    amenity = tags.get("amenity")
    shop = tags.get("shop")
    if amenity == "drinking_water":
        return "water" if tags.get("drinking_water") != "no" else None
    if tags.get("drinking_water") == "yes" and (amenity == "fountain" or tags.get("man_made") == "water_tap"):
        return "water"
    if shop == "bicycle":
        return "shop"
    if amenity == "charging_station":
        return "charging" if tags.get("bicycle") in _BIKE_YES else None
    if amenity == "fuel" and tags.get("service:bicycle:pump") == "yes":
        return "pump"
    if tags.get("tourism") in LODGING:
        return "lodging"
    if amenity == "shelter":
        return "shelter" if tags.get("shelter_type") not in _NOT_A_SHELTER else None
    if amenity in _AMENITY_KINDS:
        return _AMENITY_KINDS[amenity]
    if shop in FOOD_SHOPS:
        return "food"
    return None


def poi_properties(kind: str, tags: Tags) -> dict[str, str]:
    """Feature properties for the tiles: the kind plus what the popup shows.

    ``sub`` says which lodging or food shop it is (hotel, camp site, bakery);
    a lodging also keeps its website, for booking. Kept small otherwise -- every
    property is repeated in every tile the point lands in.
    """
    props = {"kind": kind}
    if kind == "lodging":
        props["sub"] = tags["tourism"]
    elif kind == "food":
        props["sub"] = tags["shop"]
    keys = ("name", "opening_hours", "website") if kind == "lodging" else ("name", "opening_hours")
    for key in keys:
        value = tags.get(key, "").strip()
        if value:
            props[key] = value
    return props


def poi_feature(lat: float, lon: float, kind: str, tags: Tags) -> dict[str, Any]:
    """One GeoJSON point feature, coordinates rounded to ~1 m, in tiles from its kind's zoom."""
    return {
        "type": "Feature",
        "tippecanoe": {"minzoom": min(KIND_MINZOOM[kind], TILE_MAXZOOM)},
        "properties": poi_properties(kind, tags),
        "geometry": {"type": "Point", "coordinates": [round(lon, 5), round(lat, 5)]},
    }


# --------------------------------------------------------------------------- #
# Loader shell (pyrosm)
# --------------------------------------------------------------------------- #

#: What pyrosm should read: a superset of what classify_poi accepts.
_FILTER: Final = {
    "amenity": [
        "drinking_water", "fountain", "bicycle_repair_station", "compressed_air", "fuel",
        "bicycle_rental", "bicycle_parking", "charging_station",
        "cafe", "restaurant", "toilets", "shelter",
    ],
    "shop": ["bicycle", *sorted(FOOD_SHOPS)],
    "man_made": ["water_tap"],
    "tourism": sorted(LODGING),
}
#: Tags classify_poi / poi_properties read; pyrosm promotes these to columns.
_TAG_KEYS: Final = (
    "amenity", "shop", "man_made", "tourism", "drinking_water", "bicycle", "access",
    "shelter_type", "service:bicycle:pump", "name", "opening_hours", "website",
)


def load_pois(
    pbf_path: str, *, bbox: tuple[float, float, float, float] | None = None
) -> list[dict[str, Any]]:
    """Read a PBF and return the overlay's GeoJSON point features.

    ``bbox`` is ``(min_lon, min_lat, max_lon, max_lat)``; ``None`` reads the whole
    PBF.
    """
    try:
        from pyrosm import OSM  # type: ignore[import-untyped]
    except ImportError as exc:  # pragma: no cover - environment-dependent
        raise RuntimeError(
            "pyrosm is required to load OSM data; install build/requirements-build.txt"
        ) from exc

    osm = OSM(pbf_path, bounding_box=list(bbox) if bbox is not None else None)
    gdf = osm.get_pois(custom_filter=_FILTER, extra_attributes=list(_TAG_KEYS))
    if gdf is None or len(gdf) == 0:  # pragma: no cover - empty region
        return []

    columns = {k: gdf[k].to_numpy() for k in _TAG_KEYS if k in gdf.columns}
    tags_json = gdf["tags"].to_numpy() if "tags" in gdf.columns else [None] * len(gdf)
    geoms = gdf["geometry"].to_numpy()

    features: list[dict[str, Any]] = []
    for i in range(len(gdf)):
        tags = _row_tags(columns, tags_json[i], i)
        kind = classify_poi(tags)
        geom = geoms[i]
        if kind is None or geom is None or geom.is_empty:
            continue
        # A point stays put; an area (a shop building) gets a point inside it.
        point = geom if geom.geom_type == "Point" else geom.representative_point()
        features.append(poi_feature(point.y, point.x, kind, tags))
    return features


def _row_tags(columns: Mapping[str, Any], tags_json: object, i: int) -> dict[str, str]:
    """Tag dict for row ``i``: the promoted columns, then pyrosm's leftover JSON blob."""
    tags: dict[str, str] = {}
    for key, arr in columns.items():
        value = arr[i]
        if value is not None and value == value:  # not NaN
            tags[key] = str(value)
    if tags_json is not None and tags_json == tags_json and str(tags_json) not in ("", "None"):
        try:
            parsed = json.loads(str(tags_json))
        except (ValueError, TypeError):  # pragma: no cover - malformed blob
            parsed = {}
        for key in _TAG_KEYS:
            if key not in tags and parsed.get(key) is not None:
                tags[key] = str(parsed[key])
    return tags


def write_geojson(features: list[dict[str, Any]], path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as fh:
        json.dump({"type": "FeatureCollection", "features": features}, fh, ensure_ascii=False)


def tippecanoe_command(geojson: Path, pmtiles: Path) -> str:
    """GeoJSON -> PMTiles for the overlay.

    Every point at every zoom (``-r1``, no dropping): the style decides from which
    zoom a kind shows, and a point that vanished from a tile could not come back.
    Zoom 10-14 is enough; MapLibre overzooms past 14.
    """
    return f"tippecanoe -o {pmtiles} -l pois -Z{TILE_MINZOOM} -z{TILE_MAXZOOM} -r1 --force {geojson}"


def main(argv: list[str] | None = None) -> int:  # pragma: no cover - CLI wiring
    from build.build_graph import DEFAULT_OUT, REGIONS, resolve_region

    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--region", required=True, help=f"one of: {', '.join(sorted(REGIONS))}")
    parser.add_argument("--pbf", required=True, help="path to the OSM .pbf")
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT)
    args = parser.parse_args(argv)

    region = resolve_region(args.region)
    features = load_pois(args.pbf, bbox=region.bbox)
    out = args.out / region.name / "pois.geojson"
    write_geojson(features, out)

    counts = {k: 0 for k in POI_KINDS}
    for f in features:
        counts[f["properties"]["kind"]] += 1
    print(f"[pois] {len(features)} points -> {out}: {counts}", file=sys.stderr)
    print(f"[pois] next: {tippecanoe_command(out, out.with_suffix('.pmtiles'))}", file=sys.stderr)
    return 0 if features else 1


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
