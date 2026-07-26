"""OSM PBF -> bike-network topology (build pipeline step 1).

Two layers, split the way the router is:

* **Pure tag logic** (top of file) -- ``tags -> attribute`` functions with no I/O
  and no ``pyrosm`` dependency. This is where the two resolved open decisions
  live: one-ways respected with bicycle exceptions, and a gravel-inclusive
  highway set with per-edge surface classification (format v2). Every routing
  consequence of a mis-tagged way traces back to here, so it is exhaustively
  unit-tested against hand-built tag dicts -- no download, no PBF.
* **Loader shell** (bottom of file) -- ``load_bike_network`` reads the PBF with
  ``pyrosm`` (lazy-imported so the pure logic stays importable without it) and
  applies the pure functions to build a :class:`RawNetwork`. It needs real data
  and heavy deps, so it runs at pipeline-execution time, not in the unit suite.

The output :class:`RawNetwork` carries topology, geometry and tag-derived
attributes but **no elevation** -- that is ``dem.py``'s job (step 2).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Final, Mapping

from build.binformat import Surface

#: An OSM way's tags. Values are strings as they appear in OSM.
WayTags = Mapping[str, str]


# --------------------------------------------------------------------------- #
# Highway inclusion (gravel-inclusive; bike-forbidden classes excluded)
# --------------------------------------------------------------------------- #

#: ``highway`` values that form the bike network. Gravel-inclusive: paved roads
#: plus tracks/paths a gravel bike handles. `*_link` ramps are folded in below.
#: Chosen to match common bike-routing practice (BRouter/OSRM bike profile),
#: leaning permissive because surface -- not highway class -- is what the v2
#: format now uses to separate road from gravel.
INCLUDED_HIGHWAYS: Final[frozenset[str]] = frozenset(
    {
        "primary", "secondary", "tertiary", "unclassified", "residential",
        "living_street", "service", "road",
        "cycleway", "track", "path", "bridleway",
        # Foot-oriented ways are candidates but ridden only when a bicycle tag
        # permits it; see is_bike_allowed(). track is the gravel backbone and
        # needs no such permission.
        "footway", "pedestrian",
    }
)

#: ``highway`` values a bike may never route on. motorway/trunk are motor-only in
#: CH (Autobahn/Autostrasse); steps cannot be ridden.
EXCLUDED_HIGHWAYS: Final[frozenset[str]] = frozenset(
    {
        "motorway", "motorway_link", "trunk", "trunk_link",
        "steps", "construction", "proposed", "raceway", "bus_guideway",
        "escape", "corridor", "elevator", "platform", "services", "rest_area",
    }
)


def _base_highway(value: str) -> str:
    """Fold ``primary_link`` -> ``primary`` so ramps share their road's policy."""
    return value[:-5] if value.endswith("_link") else value


def included_highway(tags: WayTags) -> bool:
    """Whether a way's ``highway`` tag makes it a bike-network candidate.

    Candidacy is necessary but not sufficient -- :func:`is_bike_allowed` and
    :func:`edge_directions` still get a say. A way with no ``highway`` tag (a
    boundary, a landuse polygon) is never a candidate.
    """
    highway = tags.get("highway")
    if highway is None:
        return False
    if highway in EXCLUDED_HIGHWAYS:
        return False
    base = _base_highway(highway)
    if base in EXCLUDED_HIGHWAYS:
        return False
    return base in INCLUDED_HIGHWAYS


# --------------------------------------------------------------------------- #
# Bicycle access
# --------------------------------------------------------------------------- #

#: ``bicycle`` values that forbid riding (``dismount`` = must walk -> excluded for
#: a riding router).
_BICYCLE_NO: Final[frozenset[str]] = frozenset({"no", "private", "dismount", "use_sidepath"})
#: ``bicycle`` values that explicitly permit riding, overriding a general access ban.
_BICYCLE_YES: Final[frozenset[str]] = frozenset(
    {"yes", "designated", "permissive", "destination", "official"}
)
#: General ``access`` values that close a way unless a bicycle tag re-opens it.
_ACCESS_NO: Final[frozenset[str]] = frozenset({"no", "private"})
#: Foot-first highways that need an explicit bicycle permission to be ridden.
_FOOT_HIGHWAYS: Final[frozenset[str]] = frozenset({"footway", "pedestrian", "path", "bridleway"})


def is_bike_allowed(tags: WayTags) -> bool:
    """Whether a candidate way may actually be cycled, per access tags.

    Resolution order (bicycle-specific beats general):

    1. ``bicycle`` explicitly no/private/dismount -> excluded.
    2. ``bicycle`` explicitly yes/designated/... -> allowed (overrides step 4).
    3. Foot-first highways (footway/path/bridleway/pedestrian) need that explicit
       yes; without it they are walking infrastructure, not routed.
    4. A general ``access`` of no/private closes the way.
    """
    bicycle = tags.get("bicycle")
    if bicycle in _BICYCLE_NO:
        return False
    if bicycle in _BICYCLE_YES:
        return True

    highway = _base_highway(tags.get("highway", ""))
    if highway in _FOOT_HIGHWAYS:
        # Only rideable when a bicycle tag said yes (handled above). A bare
        # footway/path defaults to not-for-riding in v1.
        return False

    if tags.get("access") in _ACCESS_NO:
        return False
    return True


# --------------------------------------------------------------------------- #
# Direction (one-ways, respected with bicycle exceptions)
# --------------------------------------------------------------------------- #

_ONEWAY_FORWARD: Final[frozenset[str]] = frozenset({"yes", "true", "1"})
_ONEWAY_REVERSE: Final[frozenset[str]] = frozenset({"-1", "reverse"})
_ONEWAY_NO: Final[frozenset[str]] = frozenset({"no", "false", "0"})


def edge_directions(tags: WayTags) -> tuple[bool, bool]:
    """Return ``(forward, backward)`` traversability in the way's node order.

    Implements the resolved decision: **one-ways respected, with bicycle
    exceptions.**

    * ``oneway=yes`` -> forward only; ``oneway=-1`` -> backward only.
    * ``junction=roundabout``/``circular`` implies ``oneway=yes``.
    * ``oneway:bicycle=no`` re-opens the reverse direction (legal contraflow),
      overriding the general one-way -- the whole point of the exception.
    * ``oneway:bicycle=yes`` closes the reverse even on a two-way street.
    * ``cycleway=opposite*`` (or the ``:left``/``:right`` variants) is a common
      contraflow signal and also re-opens the reverse.

    At least one direction is always open for an otherwise-included way; a fully
    closed way should have been dropped by :func:`is_bike_allowed` already.
    """
    oneway = tags.get("oneway", "")
    junction = tags.get("junction", "")

    if oneway in _ONEWAY_REVERSE:
        forward, backward = False, True
    elif oneway in _ONEWAY_FORWARD or (
        oneway not in _ONEWAY_NO and junction in {"roundabout", "circular"}
    ):
        forward, backward = True, False
    else:
        forward, backward = True, True

    # Bicycle-specific overrides. oneway:bicycle wins over the general oneway.
    oneway_bike = tags.get("oneway:bicycle")
    if oneway_bike in _ONEWAY_NO:
        # Legal contraflow: whichever general direction was open, the bike may
        # also go the other way.
        forward, backward = True, True
    elif oneway_bike in _ONEWAY_FORWARD:
        forward, backward = True, False
    elif oneway_bike in _ONEWAY_REVERSE:
        forward, backward = False, True
    elif _has_contraflow_cycleway(tags) and not backward:
        # A contraflow cycleway lane re-opens the reverse for bikes.
        backward = True

    return forward, backward


def _has_contraflow_cycleway(tags: WayTags) -> bool:
    for key in ("cycleway", "cycleway:left", "cycleway:right", "cycleway:both"):
        value = tags.get(key, "")
        if value.startswith("opposite"):
            return True
    return False


# --------------------------------------------------------------------------- #
# Surface classification (OSM -> format v2 Surface enum)
# --------------------------------------------------------------------------- #

#: ``surface`` tag values -> Surface class. Anything unlisted falls through to the
#: tracktype and then highway-based defaults below.
_SURFACE_MAP: Final[dict[str, Surface]] = {
    # paved
    "paved": Surface.PAVED, "asphalt": Surface.PAVED, "chipseal": Surface.PAVED,
    "concrete": Surface.PAVED, "concrete:lanes": Surface.PAVED, "concrete:plates": Surface.PAVED,
    "paving_stones": Surface.PAVED, "sett": Surface.PAVED, "metal": Surface.PAVED,
    "wood": Surface.PAVED, "rubber": Surface.PAVED,
    # gravel-ish (rideable on a gravel bike, not smooth)
    "compacted": Surface.GRAVEL, "fine_gravel": Surface.GRAVEL, "gravel": Surface.GRAVEL,
    "pebblestone": Surface.GRAVEL, "cobblestone": Surface.GRAVEL,
    "unhewn_cobblestone": Surface.GRAVEL,
    # unpaved / rough
    "unpaved": Surface.UNPAVED, "ground": Surface.UNPAVED, "dirt": Surface.UNPAVED,
    "earth": Surface.UNPAVED, "grass": Surface.UNPAVED, "sand": Surface.UNPAVED,
    "mud": Surface.UNPAVED, "grass_paver": Surface.UNPAVED, "woodchips": Surface.UNPAVED,
}

#: ``tracktype`` grade -> Surface, used when ``surface`` is absent.
_TRACKTYPE_MAP: Final[dict[str, Surface]] = {
    "grade1": Surface.PAVED,   # usually a solid, often paved base
    "grade2": Surface.GRAVEL,
    "grade3": Surface.GRAVEL,
    "grade4": Surface.UNPAVED,
    "grade5": Surface.UNPAVED,
}

#: Highway-based default when neither surface nor tracktype is tagged. Roads are
#: paved by default in CH; tracks/paths are not.
_HIGHWAY_SURFACE_DEFAULT: Final[dict[str, Surface]] = {
    "primary": Surface.PAVED, "secondary": Surface.PAVED, "tertiary": Surface.PAVED,
    "unclassified": Surface.PAVED, "residential": Surface.PAVED, "living_street": Surface.PAVED,
    "service": Surface.PAVED, "cycleway": Surface.PAVED, "road": Surface.PAVED,
    "track": Surface.UNPAVED, "path": Surface.UNPAVED, "bridleway": Surface.UNPAVED,
    "footway": Surface.PAVED, "pedestrian": Surface.PAVED,
}


def classify_surface(tags: WayTags) -> Surface:
    """Map a way's tags onto the v2 :class:`Surface` enum.

    Priority: explicit ``surface`` tag, then ``tracktype``, then a highway-based
    default, then ``UNKNOWN``. ``UNKNOWN`` is deliberately reachable (not silently
    coerced to paved) so the frontend/worker can treat unclassified edges
    distinctly -- an unset surface is information, not "paved".
    """
    surface = tags.get("surface")
    if surface is not None:
        mapped = _SURFACE_MAP.get(surface)
        if mapped is not None:
            return mapped
        # A surface tag we do not recognise is still a signal it is not a plain
        # road; treat it as unpaved rather than guessing paved.
        return Surface.UNPAVED

    tracktype = tags.get("tracktype")
    if tracktype is not None:
        mapped = _TRACKTYPE_MAP.get(tracktype)
        if mapped is not None:
            return mapped

    return _HIGHWAY_SURFACE_DEFAULT.get(_base_highway(tags.get("highway", "")), Surface.UNKNOWN)


# --------------------------------------------------------------------------- #
# Raw network model (pre-elevation)
# --------------------------------------------------------------------------- #


@dataclass(frozen=True)
class RawEdge:
    """One geometric way segment between two OSM nodes, before DEM sampling.

    ``geometry`` is the full polyline in ``(lat, lon)`` including both endpoints,
    so ``dem.py`` can sample elevation along it. ``forward``/``backward`` come from
    :func:`edge_directions`; ``export.py`` emits the corresponding directed
    half-edges.
    """

    u: int  # OSM node id
    v: int  # OSM node id
    way_id: int
    highway: str
    surface: Surface
    forward: bool
    backward: bool
    geometry: list[tuple[float, float]]


@dataclass
class RawNetwork:
    """The bike network as it comes out of OSM: topology + geometry + tags.

    Node coordinates are keyed by OSM node id. No elevation yet.
    """

    node_lat: dict[int, float] = field(default_factory=dict)
    node_lon: dict[int, float] = field(default_factory=dict)
    edges: list[RawEdge] = field(default_factory=list)

    def add_node(self, osm_id: int, lat: float, lon: float) -> None:
        self.node_lat[osm_id] = lat
        self.node_lon[osm_id] = lon

    @property
    def node_count(self) -> int:
        return len(self.node_lat)

    @property
    def edge_count(self) -> int:
        return len(self.edges)


# --------------------------------------------------------------------------- #
# Loader shell (lazy pyrosm; run at pipeline-execution time)
# --------------------------------------------------------------------------- #


def load_bike_network(
    pbf_path: str,
    *,
    bbox: tuple[float, float, float, float] | None = None,
) -> RawNetwork:
    """Read a PBF and build a :class:`RawNetwork` of the cyclable ways.

    ``pyrosm`` is imported lazily so this module's pure tag logic stays importable
    (and unit-testable) without GDAL/pyrosm installed. This function needs real
    data and is exercised at pipeline-execution time, not in the unit suite --
    the correctness-critical decisions it applies are already covered there.

    ``bbox`` is ``(min_lon, min_lat, max_lon, max_lat)`` for the ``--region`` test
    area; ``None`` reads the whole PBF.
    """
    try:
        from pyrosm import OSM  # type: ignore[import-untyped]
    except ImportError as exc:  # pragma: no cover - environment-dependent
        raise RuntimeError(
            "pyrosm is required to load OSM data; install the step-3 build "
            "dependencies (see build/requirements.txt)"
        ) from exc

    osm = OSM(pbf_path, bounding_box=list(bbox) if bbox is not None else None)
    # Pull every candidate highway; filtering by tag is our job, not pyrosm's, so
    # the decision logic lives in one tested place.
    ways = osm.get_network(network_type="all", nodes=False)

    network = RawNetwork()
    if ways is None:  # pragma: no cover - empty region
        return network

    for row in ways.itertuples():
        tags = _row_tags(row)
        if not included_highway(tags) or not is_bike_allowed(tags):
            continue
        forward, backward = edge_directions(tags)
        surface = classify_surface(tags)
        _add_way_geometry(network, row, tags, forward, backward, surface)

    return network


def _row_tags(row: object) -> dict[str, str]:  # pragma: no cover - pyrosm shape
    """Extract a tag dict from a pyrosm way row.

    Kept tiny and isolated because the exact pyrosm column layout is a moving
    target across versions; the pure logic above never sees a pyrosm object.
    """
    tags: dict[str, str] = {}
    for key in (
        "highway", "surface", "tracktype", "oneway", "oneway:bicycle",
        "bicycle", "access", "junction", "cycleway",
    ):
        value = getattr(row, key.replace(":", "_"), None)
        if value is not None and value == value:  # not NaN
            tags[key] = str(value)
    return tags


def _add_way_geometry(  # pragma: no cover - pyrosm shape
    network: RawNetwork,
    row: object,
    tags: dict[str, str],
    forward: bool,
    backward: bool,
    surface: Surface,
) -> None:
    """Split a pyrosm way row into :class:`RawEdge`s. Filled in at step-3 run time
    once the concrete pyrosm geometry/node columns are pinned."""
    raise NotImplementedError(
        "geometry extraction is wired up during the step-3 run against real data"
    )
