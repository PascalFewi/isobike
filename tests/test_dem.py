"""DEM profile-integration math -- the ascent-is-an-integral rule, verified.

Pure functions with an injected elevation sampler, so no raster is needed. The
synthetic surfaces have hand-computable ascent/descent/slope.
"""

from __future__ import annotations

import math
import random

import numpy as np
import pytest

from build.binformat import Surface
from build.collapse import collapse_degree2
from build.dem import (
    EdgeMetrics,
    as_array_sampler,
    bilinear_sample,
    integrate_profile,
    measure_edge,
    measure_network,
    polyline_length_m,
    resample_polyline,
)
from build.geo import haversine_m
from build.osm_load import RawEdge, RawNetwork, Structure

# A short east-west edge near 46.5 N. ~10 m north-south steps for elevation tests
# would need care with the projection, so elevation tests inject elevation as a
# function of position rather than relying on real geometry.
P0 = (46.5, 8.0)
P1 = (46.5, 8.01)


# --------------------------------------------------------------------------- #
# Resampling
# --------------------------------------------------------------------------- #


def test_resample_keeps_endpoints_and_bounds_gap() -> None:
    points, cum = resample_polyline([P0, P1], step_m=10.0)
    assert points[0] == P0
    assert points[-1] == P1
    # Every gap is <= the step.
    for a, b in zip(cum, cum[1:]):
        assert 0 < (b - a) <= 10.0 + 1e-6
    # Cumulative distance ends at the true edge length.
    assert cum[-1] == pytest.approx(haversine_m(*P0, *P1), rel=1e-9)


def test_resample_preserves_interior_vertices() -> None:
    """A bent edge must keep its bend, or dist could drop below the chord."""
    mid = (46.505, 8.005)
    points, _ = resample_polyline([P0, mid, P1], step_m=1000.0)
    assert mid in points


def test_resample_skips_duplicate_vertices() -> None:
    points, cum = resample_polyline([P0, P0, P1], step_m=20.0)
    assert points[0] == P0 and points[-1] == P1
    assert all(b > a for a, b in zip(cum, cum[1:]))


def test_polyline_length_matches_segment_sum() -> None:
    mid = (46.505, 8.005)
    expected = haversine_m(*P0, *mid) + haversine_m(*mid, *P1)
    assert polyline_length_m([P0, mid, P1]) == pytest.approx(expected, rel=1e-12)


def test_resample_rejects_degenerate_geometry() -> None:
    with pytest.raises(ValueError):
        resample_polyline([P0])


# --------------------------------------------------------------------------- #
# Profile integration -- the ascent-as-integral rule
# --------------------------------------------------------------------------- #


def test_flat_profile_has_zero_ascent() -> None:
    m = integrate_profile([0, 10, 20, 30], [600, 600, 600, 600])
    assert m.ascent_m == 0 and m.descent_m == 0
    assert m.max_slope_pct_fwd == 0 and m.max_slope_pct_rev == 0


def test_monotonic_climb() -> None:
    m = integrate_profile([0, 100, 200], [600, 610, 625])
    assert m.ascent_m == pytest.approx(25.0)
    assert m.descent_m == 0.0
    assert m.dist_m == 200.0


def test_bump_has_ascent_and_descent_but_zero_net() -> None:
    """The trap: endpoints are equal, but the profile went up 14 m and back."""
    m = integrate_profile([0, 50, 100], [600, 614, 600])
    assert m.ascent_m == pytest.approx(14.0)
    assert m.descent_m == pytest.approx(14.0)
    # Endpoint delta-h would say ascent == 0; the integral says 14.
    assert m.ascent_m > (max(0.0, 600 - 600))


def test_ascent_minus_descent_telescopes_to_delta_h() -> None:
    prof = [600, 612, 605, 630, 618]
    m = integrate_profile([0, 40, 80, 120, 160], prof)
    assert (m.ascent_m - m.descent_m) == pytest.approx(prof[-1] - prof[0])


def test_reverse_ascent_equals_forward_descent() -> None:
    m = integrate_profile([0, 50, 100], [600, 620, 610])
    # Forward: +20, -10 -> ascent 20, descent 10.
    assert m.ascent_m == pytest.approx(20.0)
    assert m.descent_m == pytest.approx(10.0)
    # (reverse metrics are represented via max_slope_rev; ascent/descent swap is
    #  applied by export.py when it emits the reverse half-edge.)


def test_max_slope_is_uphill_only() -> None:
    """A purely downhill profile has max uphill slope 0 -- not filtered as steep."""
    m = integrate_profile([0, 100, 200], [700, 690, 650])
    assert m.max_slope_pct_fwd == 0.0
    # Reverse direction climbs, so its max slope is positive.
    assert m.max_slope_pct_rev > 0.0


def test_max_slope_percent_on_a_short_edge() -> None:
    # 100 m long, climbs 8 m -> 8 % over the whole edge (shorter than the window).
    m = integrate_profile([0, 50, 100], [600, 604, 608])
    assert m.max_slope_pct_fwd == pytest.approx(8.0, abs=1e-9)


def test_rolling_window_smooths_a_short_spike() -> None:
    """A 1 m spike over 10 m (10 %) is smoothed by the 200 m window on a long edge."""
    cum = list(range(0, 401, 10))  # 0..400 m, 41 samples
    prof = [600.0] * len(cum)
    prof[20] = 601.0  # a 1 m spike at 200 m
    m = integrate_profile(cum, prof)
    # Over any 200 m window the net rise is at most 1 m -> <= 0.5 %.
    assert m.max_slope_pct_fwd <= 0.5 + 1e-9


def test_the_last_steps_of_a_long_edge_are_not_graded_on_their_own() -> None:
    """A 400 m flat edge whose final 10 m step rises 3 m. Clamping the windows
    that start near the end grades that one step alone (30 %); every full 200 m
    window sees at most 3 m -> 1.5 %."""
    cum = list(range(0, 401, 10))
    prof = [600.0] * len(cum)
    prof[-1] = 603.0
    m = integrate_profile(cum, prof)
    assert m.max_slope_pct_fwd == pytest.approx(1.5)


def test_a_short_edge_is_graded_end_to_end_not_by_its_steepest_tail() -> None:
    # 100 m, flat then a 2 m step in the last 10 m: whole-edge grade is 2 %.
    m = integrate_profile([0, 90, 100], [600.0, 600.0, 602.0])
    assert m.max_slope_pct_fwd == pytest.approx(2.0)


def test_a_metre_scale_step_on_a_tiny_edge_is_graded_over_the_minimum_span() -> None:
    """1.2 m over a 2 m junction stub: 60 % end to end, 2.4 % over the 50 m span."""
    m = integrate_profile([0.0, 1.0, 2.0], [600.0, 600.5, 601.2])
    assert m.max_slope_pct_fwd == pytest.approx(1.2 / 50.0 * 100.0)


def test_a_genuine_short_ramp_still_grades_steep() -> None:
    # 40 m street rising 6 m: 15 % end to end, 12 % over the 50 m minimum span.
    m = integrate_profile([0.0, 20.0, 40.0], [600.0, 603.0, 606.0])
    assert m.max_slope_pct_fwd == pytest.approx(12.0)


def test_the_minimum_span_changes_slope_only_never_ascent_or_descent() -> None:
    """The floor is a slope-grading rule. Ascent and descent are still the full
    sums of the profile's steps -- the same metres a rider climbs -- and the
    edge's length is untouched."""
    cum = [0.0, 3.0, 6.0, 9.0, 12.0]
    prof = [600.0, 601.5, 601.0, 602.5, 602.0]  # noisy, all inside 12 m
    m = integrate_profile(cum, prof)
    assert m.ascent_m == pytest.approx(1.5 + 1.5)
    assert m.descent_m == pytest.approx(0.5 + 0.5)
    assert m.dist_m == 12.0
    assert m.max_slope_pct_fwd == pytest.approx(2.0 / 50.0 * 100.0)   # net +2 m
    assert m.max_slope_pct_rev == 0.0  # net -2 m the other way: never uphill end to end


def test_measure_network_ascent_is_independent_of_the_slope_span() -> None:
    """Same edge through the vectorised path: ascent equals the summed positive
    steps of the sampled profile exactly as without any slope floor."""
    from build.dem import MIN_SLOPE_SPAN_M

    def stepped(lat: float, lon: float) -> float:
        return 600.0 + (lon - 8.0) * 3e4  # ~2.3 m rise per 1e-4 deg (~7.7 m)

    geom = [(46.5, 8.0), (46.5, 8.0003)]  # ~23 m: shorter than the minimum span
    e = measure_network(_raw([(0, 1, geom)]), stepped).edges[0]
    ref = measure_edge([_f32(geom[0]), _f32(geom[1])], stepped)
    rise = stepped(*_f32(geom[1])) - stepped(*_f32(geom[0]))
    assert e.dist_m < MIN_SLOPE_SPAN_M
    assert e.ascent_m == pytest.approx(rise, rel=1e-9) == pytest.approx(ref.ascent_m, rel=1e-9)
    assert e.max_slope_pct_fwd == pytest.approx(rise / MIN_SLOPE_SPAN_M * 100.0, rel=1e-6)
    assert e.max_slope_pct_fwd < rise / e.dist_m * 100.0  # graded gentler than end to end


def test_integrate_rejects_mismatched_lengths() -> None:
    with pytest.raises(ValueError):
        integrate_profile([0, 10], [600, 610, 620])


# --------------------------------------------------------------------------- #
# measure_edge with an injected sampler
# --------------------------------------------------------------------------- #


def test_measure_edge_with_a_synthetic_surface() -> None:
    """Elevation is a linear ramp in longitude: a constant grade the whole way."""

    def sampler(lat: float, lon: float) -> float:
        return 600.0 + (lon - 8.0) * 100000.0  # 1 m per 0.00001 deg lon

    m = measure_edge([P0, P1], sampler)
    length = haversine_m(*P0, *P1)
    rise = (P1[1] - P0[1]) * 100000.0
    assert m.dist_m == pytest.approx(length, rel=1e-9)
    assert m.ascent_m == pytest.approx(rise, rel=1e-6)
    assert m.descent_m == pytest.approx(0.0, abs=1e-6)


def test_measure_edge_bump_surface() -> None:
    """A surface that rises to a ridge and falls: ascent and descent both > 0."""

    def sampler(lat: float, lon: float) -> float:
        # Peak at the edge midpoint (lon 8.005).
        return 600.0 + 20.0 * math.exp(-(((lon - 8.005) / 0.002) ** 2))

    m = measure_edge([P0, P1], sampler)
    assert m.ascent_m > 15.0
    assert m.descent_m > 15.0
    assert m.ascent_m == pytest.approx(m.descent_m, abs=0.5)  # symmetric bump


# --------------------------------------------------------------------------- #
# measure_network: vectorised, on the collapsed network
# --------------------------------------------------------------------------- #

def _rolling_hills(lat: float, lon: float) -> float:
    return 600.0 + 40.0 * math.sin(lon * 900.0) + 25.0 * math.cos(lat * 1300.0)


def _raw(edges: list[tuple[int, int, list[tuple[float, float]]]], **kw) -> RawNetwork:
    net = RawNetwork()
    for u, v, geom in edges:
        net.add_node(u, *geom[0])
        net.add_node(v, *geom[-1])
        net.edges.append(RawEdge(
            u=u, v=v, way_id=1, highway="residential", surface=Surface.PAVED,
            forward=True, backward=True, geometry=geom, **kw,
        ))
    return net


def _f32(p: tuple[float, float]) -> tuple[float, float]:
    return (float(np.float32(p[0])), float(np.float32(p[1])))


def test_vectorised_measure_matches_the_per_edge_reference() -> None:
    """Random polylines (bends, duplicate vertices, 3 m to 3 km) over a hilly
    surface: every metric equals measure_edge on the same pinned geometry."""
    rng = random.Random(7)
    edges = []
    for i in range(60):
        lat, lon = 46.5 + rng.random() * 0.1, 8.0 + rng.random() * 0.1
        pts = [(lat, lon)]
        for _ in range(rng.randint(1, 8)):
            step = rng.choice([3e-5, 3e-4, 3e-3])
            lat += rng.uniform(-step, step)
            lon += rng.uniform(-step, step)
            pts.append((lat, lon))
            if rng.random() < 0.15:
                pts.append((lat, lon))  # duplicate vertex
        if pts[-1] == pts[0]:
            pts.append((lat + 1e-4, lon))
        edges.append((2 * i, 2 * i + 1, pts))
    net = _raw(edges)
    measured = measure_network(net, _rolling_hills)

    for raw_e, got in zip(net.edges, measured.edges):
        geom = [_f32(raw_e.geometry[0]), *raw_e.geometry[1:-1], _f32(raw_e.geometry[-1])]
        ref = measure_edge(geom, _rolling_hills)
        assert got.dist_m == pytest.approx(ref.dist_m, rel=1e-9)
        assert got.ascent_m == pytest.approx(ref.ascent_m, rel=1e-9, abs=1e-9)
        assert got.descent_m == pytest.approx(ref.descent_m, rel=1e-9, abs=1e-9)
        assert got.max_slope_pct_fwd == pytest.approx(ref.max_slope_pct_fwd, rel=1e-6, abs=1e-9)
        assert got.max_slope_pct_rev == pytest.approx(ref.max_slope_pct_rev, rel=1e-6, abs=1e-9)
    for nid in net.node_lat:
        assert measured.node_elev[nid] == pytest.approx(
            _rolling_hills(measured.node_lat[nid], measured.node_lon[nid]))


def test_slope_window_spans_osm_segment_joints() -> None:
    """The bug this ordering fixes: a 1 km road split into 10 m OSM segments with
    +-1 m DEM noise. Measured per segment, every 10 m step is its own window (20 %
    end to end; 4 % even over the 50 m minimum span); measured after collapse, the
    200 m window smooths it to <= 1 %."""
    n = 100
    pts = [(46.5, 8.0 + k * 1.3e-4) for k in range(n + 1)]  # ~10 m apart
    def noisy(lat: float, lon: float) -> float:
        k = round((lon - 8.0) / 1.3e-4)
        return 600.0 + (1.0 if k % 2 else -1.0)

    segments = _raw([(k, k + 1, [pts[k], pts[k + 1]]) for k in range(n)])
    per_segment = max(m.max_slope_pct_fwd for m in measure_network(segments, noisy).edges)
    collapsed = collapse_degree2(segments)
    assert collapsed.edge_count == 1
    whole = measure_network(collapsed, noisy).edges[0]

    assert per_segment == pytest.approx(2.0 / 50.0 * 100.0)
    assert whole.max_slope_pct_fwd <= 2.0 / 200.0 * 100.0 + 1e-6  # 2 m over >= 200 m


def test_a_hump_spanning_two_segments_keeps_its_ascent() -> None:
    """Level endpoints, a 14 m hump whose top is the old segment joint."""

    def hump(lat: float, lon: float) -> float:
        return 600.0 + 14.0 * max(0.0, 1.0 - abs(lon - 8.005) / 0.005)

    net = collapse_degree2(_raw([(0, 1, [(46.5, 8.0), (46.5, 8.005)]),
                                 (1, 2, [(46.5, 8.005), (46.5, 8.01)])]))
    e = measure_network(net, hump).edges[0]
    assert e.ascent_m == pytest.approx(14.0, abs=0.05)
    assert e.descent_m == pytest.approx(14.0, abs=0.05)


def _valley(lat: float, lon: float) -> float:
    """Ground at 600 m on both rims, a 100 m deep valley in between."""
    return 600.0 - 100.0 * math.exp(-(((lon - 8.005) / 0.0015) ** 2))


@pytest.mark.parametrize("structure", [Structure.BRIDGE, Structure.TUNNEL])
def test_a_structure_gets_a_straight_profile_between_its_endpoints(structure: Structure) -> None:
    """Sampling a bridge over a valley (or a tunnel under a ridge) invents a 100 m
    dive and climb; the deck is level, so ascent is the endpoint difference."""
    geom = [(46.5, 8.0), (46.5, 8.005), (46.5, 8.01)]
    ground = measure_network(_raw([(0, 1, geom)]), _valley).edges[0]
    deck = measure_network(_raw([(0, 1, geom)], structure=structure), _valley).edges[0]

    assert ground.ascent_m > 90.0 and ground.max_slope_pct_fwd > 10.0
    assert deck.ascent_m == pytest.approx(max(0.0, _valley(*geom[-1]) - _valley(*geom[0])), abs=1e-3)
    assert deck.max_slope_pct_fwd < 0.1 and deck.max_slope_pct_rev < 0.1
    assert deck.dist_m == pytest.approx(ground.dist_m)


def test_a_degenerate_edge_measures_zero_and_does_not_disturb_the_others() -> None:
    """All vertices identical (two OSM nodes on one f32 coordinate): zero metrics,
    as the reference gives -- also when it is the last edge in the batch."""
    p = (46.5, 8.0)
    net = _raw([(0, 1, [(46.51, 8.0), (46.51, 8.01)]), (2, 3, [p, p])])
    a, b = measure_network(net, _rolling_hills).edges
    assert (b.dist_m, b.ascent_m, b.descent_m, b.max_slope_pct_fwd, b.max_slope_pct_rev) == (0, 0, 0, 0, 0)
    ref = measure_edge([_f32((46.51, 8.0)), _f32((46.51, 8.01))], _rolling_hills)
    assert a.ascent_m == pytest.approx(ref.ascent_m, rel=1e-9)


def test_measure_network_handles_an_empty_network() -> None:
    assert measure_network(RawNetwork(), _rolling_hills).edge_count == 0


def test_bilinear_sample_uses_pixel_centres_and_clamps() -> None:
    a = np.array([[0.0, 10.0], [20.0, 30.0]])
    got = bilinear_sample(a, np.array([0.0, 0.5, 1.0, -3.0, 0.0]), np.array([0.0, 0.5, 1.0, 0.0, 9.0]))
    assert got.tolist() == [0.0, 15.0, 30.0, 0.0, 10.0]


def test_scalar_samplers_are_wrapped_for_arrays() -> None:
    f = as_array_sampler(lambda lat, lon: lat + lon)
    assert f(np.array([1.0, 2.0]), np.array([3.0, 4.0])).tolist() == [4.0, 6.0]
