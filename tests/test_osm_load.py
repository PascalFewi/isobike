"""The OSM tag-classification decision matrix.

These are the correctness-critical choices of the build pipeline -- a wrong verdict
here silently produces illegal routes or a wrong network. They are pure functions
of a tag dict, so the whole matrix is tested here with no PBF and no pyrosm.
"""

from __future__ import annotations

import pytest

from build.binformat import Surface
from build.osm_load import (
    RawEdge,
    RawNetwork,
    classify_surface,
    edge_directions,
    included_highway,
    is_bike_allowed,
)


# --------------------------------------------------------------------------- #
# Highway inclusion
# --------------------------------------------------------------------------- #


@pytest.mark.parametrize(
    "highway",
    ["primary", "secondary", "tertiary", "unclassified", "residential",
     "living_street", "service", "cycleway", "track", "path", "road",
     "primary_link", "secondary_link", "tertiary_link"],
)
def test_included_highways(highway: str) -> None:
    assert included_highway({"highway": highway})


@pytest.mark.parametrize(
    "highway",
    ["motorway", "motorway_link", "trunk", "trunk_link", "steps",
     "construction", "proposed", "raceway", "platform", "elevator"],
)
def test_excluded_highways(highway: str) -> None:
    assert not included_highway({"highway": highway})


def test_link_ramps_follow_their_base_road() -> None:
    assert included_highway({"highway": "primary_link"})
    assert not included_highway({"highway": "motorway_link"})


def test_a_way_without_a_highway_tag_is_never_included() -> None:
    assert not included_highway({})
    assert not included_highway({"waterway": "river"})
    assert not included_highway({"building": "yes"})


# --------------------------------------------------------------------------- #
# Bicycle access
# --------------------------------------------------------------------------- #


def test_bare_road_is_rideable() -> None:
    assert is_bike_allowed({"highway": "residential"})
    assert is_bike_allowed({"highway": "track"})  # gravel backbone, no permission needed


@pytest.mark.parametrize("value", ["no", "private", "dismount", "use_sidepath"])
def test_bicycle_no_forbids_riding(value: str) -> None:
    assert not is_bike_allowed({"highway": "residential", "bicycle": value})


@pytest.mark.parametrize("value", ["yes", "designated", "permissive", "destination"])
def test_bicycle_yes_permits_riding_even_against_general_access(value: str) -> None:
    assert is_bike_allowed({"highway": "service", "access": "private", "bicycle": value})


def test_general_access_ban_closes_a_way() -> None:
    assert not is_bike_allowed({"highway": "service", "access": "private"})
    assert not is_bike_allowed({"highway": "service", "access": "no"})


@pytest.mark.parametrize("highway", ["footway", "pedestrian", "path", "bridleway"])
def test_foot_first_ways_need_explicit_bicycle_permission(highway: str) -> None:
    assert not is_bike_allowed({"highway": highway})
    assert is_bike_allowed({"highway": highway, "bicycle": "yes"})
    assert is_bike_allowed({"highway": highway, "bicycle": "designated"})


def test_track_is_ridden_without_a_bicycle_tag() -> None:
    """A gravel-inclusive network routes tracks by default -- that is the point."""
    assert is_bike_allowed({"highway": "track"})
    assert is_bike_allowed({"highway": "track", "surface": "gravel"})


# --------------------------------------------------------------------------- #
# Direction: one-ways respected, with bicycle exceptions
# --------------------------------------------------------------------------- #


def test_two_way_by_default() -> None:
    assert edge_directions({"highway": "residential"}) == (True, True)
    assert edge_directions({"highway": "residential", "oneway": "no"}) == (True, True)


@pytest.mark.parametrize("value", ["yes", "true", "1"])
def test_oneway_forward(value: str) -> None:
    assert edge_directions({"highway": "residential", "oneway": value}) == (True, False)


@pytest.mark.parametrize("value", ["-1", "reverse"])
def test_oneway_reverse(value: str) -> None:
    assert edge_directions({"highway": "residential", "oneway": value}) == (False, True)


def test_roundabout_is_implicitly_oneway() -> None:
    assert edge_directions({"highway": "residential", "junction": "roundabout"}) == (True, False)
    # ...unless explicitly overridden.
    assert edge_directions(
        {"highway": "residential", "junction": "roundabout", "oneway": "no"}
    ) == (True, True)


def test_oneway_bicycle_no_reopens_contraflow() -> None:
    """The key bike exception: legal contraflow on a one-way street."""
    assert edge_directions(
        {"highway": "residential", "oneway": "yes", "oneway:bicycle": "no"}
    ) == (True, True)
    assert edge_directions(
        {"highway": "residential", "oneway": "-1", "oneway:bicycle": "no"}
    ) == (True, True)


def test_oneway_bicycle_yes_closes_reverse_on_a_two_way_street() -> None:
    assert edge_directions(
        {"highway": "residential", "oneway:bicycle": "yes"}
    ) == (True, False)


def test_oneway_bicycle_overrides_the_general_oneway() -> None:
    # General says forward-only, bike says reverse-only -> bike wins.
    assert edge_directions(
        {"highway": "residential", "oneway": "yes", "oneway:bicycle": "-1"}
    ) == (False, True)


@pytest.mark.parametrize("key", ["cycleway", "cycleway:left", "cycleway:right"])
def test_contraflow_cycleway_reopens_reverse(key: str) -> None:
    assert edge_directions(
        {"highway": "residential", "oneway": "yes", key: "opposite_lane"}
    ) == (True, True)
    assert edge_directions(
        {"highway": "residential", "oneway": "yes", key: "opposite"}
    ) == (True, True)


def test_explicit_oneway_bicycle_beats_a_contraflow_cycleway_tag() -> None:
    # If the mapper explicitly says bikes are one-way, honour that over the lane hint.
    assert edge_directions(
        {"highway": "residential", "oneway": "yes",
         "oneway:bicycle": "yes", "cycleway": "opposite_lane"}
    ) == (True, False)


def test_an_included_way_is_never_fully_closed() -> None:
    """Every direction combination leaves at least one way open."""
    for oneway in ("yes", "-1", "no", ""):
        for ob in ("yes", "no", "-1", ""):
            tags = {"highway": "residential"}
            if oneway:
                tags["oneway"] = oneway
            if ob:
                tags["oneway:bicycle"] = ob
            fwd, bwd = edge_directions(tags)
            assert fwd or bwd, tags


# --------------------------------------------------------------------------- #
# Surface classification
# --------------------------------------------------------------------------- #


@pytest.mark.parametrize(
    "surface,expected",
    [
        ("asphalt", Surface.PAVED), ("concrete", Surface.PAVED),
        ("paving_stones", Surface.PAVED), ("sett", Surface.PAVED),
        ("compacted", Surface.GRAVEL), ("fine_gravel", Surface.GRAVEL),
        ("gravel", Surface.GRAVEL), ("pebblestone", Surface.GRAVEL),
        ("unpaved", Surface.UNPAVED), ("ground", Surface.UNPAVED),
        ("dirt", Surface.UNPAVED), ("grass", Surface.UNPAVED),
    ],
)
def test_surface_tag_mapping(surface: str, expected: Surface) -> None:
    assert classify_surface({"highway": "track", "surface": surface}) == expected


def test_unrecognised_surface_is_treated_as_unpaved_not_paved() -> None:
    """A surface tag we do not know still says 'not a plain road'."""
    assert classify_surface({"highway": "track", "surface": "moon_dust"}) == Surface.UNPAVED


@pytest.mark.parametrize(
    "grade,expected",
    [
        ("grade1", Surface.PAVED), ("grade2", Surface.GRAVEL),
        ("grade3", Surface.GRAVEL), ("grade4", Surface.UNPAVED),
        ("grade5", Surface.UNPAVED),
    ],
)
def test_tracktype_used_when_surface_absent(grade: str, expected: Surface) -> None:
    assert classify_surface({"highway": "track", "tracktype": grade}) == expected


def test_surface_tag_beats_tracktype() -> None:
    assert classify_surface(
        {"highway": "track", "surface": "asphalt", "tracktype": "grade5"}
    ) == Surface.PAVED


def test_highway_default_when_untagged() -> None:
    assert classify_surface({"highway": "residential"}) == Surface.PAVED
    assert classify_surface({"highway": "primary"}) == Surface.PAVED
    assert classify_surface({"highway": "cycleway"}) == Surface.PAVED
    assert classify_surface({"highway": "track"}) == Surface.UNPAVED
    assert classify_surface({"highway": "path"}) == Surface.UNPAVED


def test_unknown_surface_is_reachable_not_coerced_to_paved() -> None:
    """An unclassifiable way stays UNKNOWN so the toggle can treat it distinctly."""
    assert classify_surface({"highway": "raceway"}) == Surface.UNKNOWN
    assert classify_surface({}) == Surface.UNKNOWN


def test_every_surface_result_is_a_valid_enum_member() -> None:
    for tags in (
        {"highway": "residential"}, {"highway": "track"}, {"surface": "gravel"},
        {"tracktype": "grade3"}, {},
    ):
        assert classify_surface(tags) in set(Surface)


# --------------------------------------------------------------------------- #
# RawNetwork container
# --------------------------------------------------------------------------- #


def test_raw_network_accumulates_nodes_and_edges() -> None:
    net = RawNetwork()
    net.add_node(1, 46.5, 8.0)
    net.add_node(2, 46.6, 8.1)
    net.edges.append(
        RawEdge(
            u=1, v=2, way_id=100, highway="track", surface=Surface.GRAVEL,
            forward=True, backward=True, geometry=[(46.5, 8.0), (46.6, 8.1)],
        )
    )
    assert net.node_count == 2
    assert net.edge_count == 1
    assert net.node_lat[1] == 46.5 and net.node_lon[2] == 8.1
