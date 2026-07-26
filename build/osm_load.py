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


# Tags we read straight off pyrosm's edge columns when present. Everything else
# we need (colon tags like oneway:bicycle, and tags pyrosm leaves un-promoted)
# comes out of the row's `tags` JSON blob -- see _edge_tags.
_COLUMN_TAGS: Final = ("highway", "surface", "oneway", "bicycle", "access", "service")
_JSON_TAGS: Final = ("tracktype", "junction", "cycleway", "oneway:bicycle")


def load_bike_network(
    pbf_path: str,
    *,
    bbox: tuple[float, float, float, float] | None = None,
) -> RawNetwork:
    """Read a PBF and build a :class:`RawNetwork` of the cyclable ways.

    ``pyrosm`` is imported lazily so this module's pure tag logic stays importable
    (and unit-testable) without GDAL/pyrosm installed. The tag decisions it applies
    -- highway allowlist, one-way + bicycle exceptions, surface, access -- are the
    unit-tested pure functions above; this function only adapts pyrosm's shape to
    them.

    pyrosm already splits ways into node-to-node segments (each edge row carries
    ``u``/``v`` and a LineString), so one row maps to one :class:`RawEdge`. The
    degree-2 collapse merges the resulting chains later.

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
    # network_type="all" = every highway; the bike filtering is our job, done once
    # in the tested tag logic rather than delegated to pyrosm's presets. nodes=True
    # gives the u/v graph references.
    result = osm.get_network(network_type="all", nodes=True)

    network = RawNetwork()
    if result is None:  # pragma: no cover - empty region
        return network
    nodes, edges = result
    if edges is None or len(edges) == 0:  # pragma: no cover - empty region
        return network

    # Authoritative node coordinates, keyed by OSM id.
    node_ids = nodes["id"].to_numpy()
    node_lats = nodes["lat"].to_numpy()
    node_lons = nodes["lon"].to_numpy()
    for i in range(len(node_ids)):
        network.node_lat[int(node_ids[i])] = float(node_lats[i])
        network.node_lon[int(node_ids[i])] = float(node_lons[i])

    # Vectorised column access (colon columns cannot be read via itertuples).
    us = edges["u"].to_numpy()
    vs = edges["v"].to_numpy()
    way_ids = edges["id"].to_numpy() if "id" in edges.columns else [0] * len(edges)
    geoms = edges["geometry"].to_numpy()
    tags_json = edges["tags"].to_numpy() if "tags" in edges.columns else [None] * len(edges)
    columns = {k: edges[k].to_numpy() for k in _COLUMN_TAGS if k in edges.columns}

    for i in range(len(edges)):
        tags = _edge_tags(columns, tags_json[i], i)
        if not included_highway(tags) or not is_bike_allowed(tags):
            continue
        u, v = int(us[i]), int(vs[i])
        if u == v:
            continue  # degenerate self-segment
        geometry = _linestring_latlon(geoms[i])
        if geometry is None or len(geometry) < 2:
            continue
        # Endpoints must be known nodes; fall back to the geometry ends if a node
        # slipped out of the node table (rare boundary effect of a bbox cut).
        network.node_lat.setdefault(u, geometry[0][0])
        network.node_lon.setdefault(u, geometry[0][1])
        network.node_lat.setdefault(v, geometry[-1][0])
        network.node_lon.setdefault(v, geometry[-1][1])

        forward, backward = edge_directions(tags)
        network.edges.append(
            RawEdge(
                u=u, v=v, way_id=int(way_ids[i]), highway=tags["highway"],
                surface=classify_surface(tags), forward=forward, backward=backward,
                geometry=geometry,
            )
        )

    return network


def _edge_tags(
    columns: Mapping[str, object], tags_json: object, i: int
) -> dict[str, str]:
    """Assemble a tag dict for edge row ``i`` from columns + the leftover JSON blob.

    A column value wins; anything missing (notably colon tags like
    ``oneway:bicycle``) is looked up in pyrosm's un-promoted ``tags`` JSON string.
    """
    import json

    tags: dict[str, str] = {}
    for key, arr in columns.items():
        value = arr[i]  # type: ignore[index]
        if value is not None and value == value:  # not NaN
            tags[key] = str(value)

    if tags_json is not None and tags_json == tags_json and str(tags_json) not in ("", "None"):
        try:
            parsed = json.loads(str(tags_json))
        except (ValueError, TypeError):  # pragma: no cover - malformed blob
            parsed = {}
        for key in (*_COLUMN_TAGS, *_JSON_TAGS):
            if key not in tags and key in parsed and parsed[key] is not None:
                tags[key] = str(parsed[key])
    return tags


def _linestring_latlon(geom: object) -> list[tuple[float, float]] | None:
    """Shapely LineString (lon, lat) -> a list of (lat, lon), the RawEdge order."""
    coords = getattr(geom, "coords", None)
    if coords is None:  # pragma: no cover - unexpected geometry type
        return None
    return [(lat, lon) for lon, lat in coords]
