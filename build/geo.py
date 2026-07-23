"""Geodesy shared by the build pipeline and mirrored by ``worker/src/geo.ts``.

Not in the spec's module list. It exists because the earth radius and the exact
form of the distance function are a *cross-language contract*, exactly like the
binary format: the build pipeline bakes ``edge_dist`` from them, and the Worker's
A* heuristic must not disagree with those baked values or admissibility breaks.
Leaving the constant to be retyped in two places is how that goes wrong quietly.

Determinism note
================

``sin``/``cos``/``asin`` are not required to be correctly rounded, and CPython's
libm and V8's implementations may differ in the last ulp. That is tolerable here
only because of where these functions are *not* used:

* ``edge_dist`` / ``edge_ascent`` are computed once in Python, stored as f32, and
  merely read by TypeScript. All path costs are therefore sums of identical f32
  values in f64 arithmetic -- bit-identical across languages.
* :func:`haversine_m` is used by the A* heuristic, where a last-ulp difference can
  only change the *order* of expansion, never the optimal cost.
* Snapping uses :func:`local_xy`, which is one ``cos`` plus arithmetic, and ties
  are broken by node id.
"""

from __future__ import annotations

import math
from typing import Final

import numpy as np
from numpy.typing import NDArray

#: IUGG mean earth radius, in metres. Must equal R_EARTH_M in geo.ts.
R_EARTH_M: Final = 6371008.8

#: Metres per degree of latitude on that sphere.
M_PER_DEG_LAT: Final = R_EARTH_M * math.pi / 180.0


def haversine_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Great-circle distance in metres on a sphere of radius :data:`R_EARTH_M`.

    Used for edge lengths at build time and as the straight-line term of the A*
    heuristic at query time. Because a polyline's summed segment lengths obey the
    triangle inequality on a sphere, ``edge_dist >= haversine(endpoints)`` always
    holds -- which is what makes the heuristic admissible.
    """
    phi1 = math.radians(lat1)
    phi2 = math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlambda = math.radians(lon2 - lon1)
    a = (
        math.sin(dphi * 0.5) ** 2
        + math.cos(phi1) * math.cos(phi2) * math.sin(dlambda * 0.5) ** 2
    )
    return 2.0 * R_EARTH_M * math.asin(math.sqrt(min(1.0, a)))


def haversine_m_array(
    lat1: NDArray[np.float64],
    lon1: NDArray[np.float64],
    lat2: NDArray[np.float64],
    lon2: NDArray[np.float64],
) -> NDArray[np.float64]:
    """Vectorised :func:`haversine_m`, for validating millions of edges at export."""
    phi1 = np.radians(lat1)
    phi2 = np.radians(lat2)
    dphi = np.radians(lat2 - lat1)
    dlambda = np.radians(lon2 - lon1)
    a = np.sin(dphi * 0.5) ** 2 + np.cos(phi1) * np.cos(phi2) * np.sin(dlambda * 0.5) ** 2
    return 2.0 * R_EARTH_M * np.arcsin(np.sqrt(np.minimum(1.0, a)))


def local_xy(lat: float, lon: float, lat_ref: float) -> tuple[float, float]:
    """Equirectangular metres relative to (0, 0), with longitude scaled at ``lat_ref``.

    Snapping compares candidates within a handful of grid cells, where this
    approximation is accurate to well under a millimetre and costs one ``cos``
    instead of a ``haversine`` per candidate. The grid ring-expansion bound uses
    the same projection, so the search stays provably correct.
    """
    k = math.cos(math.radians(lat_ref))
    return lon * M_PER_DEG_LAT * k, lat * M_PER_DEG_LAT
