"""The cycling-POI tag decisions: which OSM elements become overlay points.

Pure functions of a tag dict, so tested with no PBF and no pyrosm.
"""

from __future__ import annotations

import pytest

from build.pois import KIND_MINZOOM, POI_KINDS, classify_poi, poi_feature, poi_properties, tippecanoe_command


@pytest.mark.parametrize(
    ("tags", "kind"),
    [
        ({"amenity": "drinking_water"}, "water"),
        ({"amenity": "fountain", "drinking_water": "yes"}, "water"),
        ({"man_made": "water_tap", "drinking_water": "yes"}, "water"),
        ({"amenity": "bicycle_repair_station"}, "repair"),
        ({"shop": "bicycle"}, "shop"),
        ({"amenity": "bicycle_rental"}, "rental"),
        ({"amenity": "bicycle_parking"}, "parking"),
        ({"amenity": "charging_station", "bicycle": "yes"}, "charging"),
        ({"amenity": "charging_station", "bicycle": "designated"}, "charging"),
        ({"amenity": "compressed_air"}, "pump"),
        ({"amenity": "fuel", "service:bicycle:pump": "yes"}, "pump"),
        ({"shop": "supermarket"}, "food"),
        ({"shop": "convenience"}, "food"),
        ({"shop": "bakery"}, "food"),
        ({"amenity": "cafe"}, "cafe"),
        ({"amenity": "restaurant"}, "restaurant"),
        ({"tourism": "hotel"}, "lodging"),
        ({"tourism": "camp_site"}, "lodging"),
        ({"tourism": "alpine_hut"}, "lodging"),
        ({"tourism": "hotel", "amenity": "restaurant"}, "lodging"),
        ({"amenity": "toilets"}, "toilets"),
        ({"amenity": "shelter"}, "shelter"),
        ({"amenity": "shelter", "shelter_type": "picnic_shelter"}, "shelter"),
        ({"amenity": "restaurant", "drinking_water": "no"}, "restaurant"),
    ],
)
def test_cycling_points_are_classified(tags: dict[str, str], kind: str) -> None:
    assert classify_poi(tags) == kind


@pytest.mark.parametrize(
    "tags",
    [
        {},
        {"amenity": "fountain"},  # decorative unless marked drinkable
        {"amenity": "fountain", "drinking_water": "no"},
        {"amenity": "drinking_water", "drinking_water": "no"},
        {"man_made": "water_tap"},
        {"amenity": "charging_station"},  # a car charger
        {"amenity": "charging_station", "bicycle": "no"},
        {"amenity": "bicycle_parking", "access": "private"},
        {"shop": "bicycle", "access": "no"},
        {"amenity": "bicycle_parking", "access": "customers"},
        {"shop": "sports"},
        {"amenity": "fuel"},
        {"amenity": "bar"},
        {"tourism": "museum"},
        {"amenity": "toilets", "access": "customers"},
        {"amenity": "shelter", "shelter_type": "public_transport"},
        {"amenity": "shelter", "shelter_type": "field_shelter"},
    ],
)
def test_other_or_closed_points_are_left_out(tags: dict[str, str]) -> None:
    assert classify_poi(tags) is None


def test_every_kind_is_in_the_legend_order() -> None:
    assert POI_KINDS[0] == "water"
    assert len(set(POI_KINDS)) == len(POI_KINDS) == 13


def test_properties_keep_only_what_the_popup_shows() -> None:
    tags = {"shop": "bicycle", "name": " Velo Müller ", "opening_hours": "Mo-Fr 08:00-18:00", "website": "x"}
    assert poi_properties("shop", tags) == {
        "kind": "shop", "name": "Velo Müller", "opening_hours": "Mo-Fr 08:00-18:00",
    }
    assert poi_properties("water", {"amenity": "drinking_water", "name": ""}) == {"kind": "water"}


def test_lodging_and_food_say_which_one_and_lodging_keeps_its_website() -> None:
    hut = {"tourism": "alpine_hut", "name": "Blüemlisalphütte", "website": "https://example.ch"}
    assert poi_properties("lodging", hut) == {
        "kind": "lodging", "sub": "alpine_hut", "name": "Blüemlisalphütte", "website": "https://example.ch",
    }
    assert poi_properties("food", {"shop": "bakery", "website": "https://x.ch"}) == {"kind": "food", "sub": "bakery"}


def test_feature_is_a_lon_lat_point_rounded_to_a_metre() -> None:
    f = poi_feature(46.9480123456, 7.4474456789, "water", {})
    assert f["geometry"] == {"type": "Point", "coordinates": [7.44745, 46.94801]}
    assert f["properties"] == {"kind": "water"}
    assert f["tippecanoe"] == {"minzoom": 13}
    # Past the tiles' last zoom the point sits in the last tiles, overzoomed.
    assert poi_feature(46.9, 7.4, "restaurant", {})["tippecanoe"] == {"minzoom": 14}


def test_every_kind_has_a_tile_zoom() -> None:
    assert set(KIND_MINZOOM) == set(POI_KINDS)
    assert all(z >= 10 for z in KIND_MINZOOM.values())


def test_tippecanoe_keeps_every_point_in_the_pois_layer() -> None:
    cmd = tippecanoe_command("in.geojson", "out.pmtiles")  # type: ignore[arg-type]
    assert "-l pois" in cmd and "-r1" in cmd
