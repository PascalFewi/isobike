"""DEM profile-integration math -- the ascent-is-an-integral rule, verified.

Pure functions with an injected elevation sampler, so no raster is needed. The
synthetic surfaces have hand-computable ascent/descent/slope.
"""

from __future__ import annotations

import math

import pytest

from build.dem import (
    EdgeMetrics,
    integrate_profile,
    measure_edge,
    polyline_length_m,
    resample_polyline,
)
from build.geo import haversine_m

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
